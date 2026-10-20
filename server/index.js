// ChartDesk local server: serves the web app and the market-data / persistence API on localhost.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, bySymbol, addSymbol } from './catalog.js';
import { TF } from '../public/js/core/sessions.js';
import { getBars, rangeOhlc, coverage, deleteMonths, nextYm } from './storage.js';
import { credentialStatus, listMonth, estimateCost, BUCKET, REGION } from './s3source.js';
import { enqueueDownload, enqueueTdHistory, listJobs, cancelJob } from './jobs.js';
import { importCsv } from './csvimport.js';
import { kvGet, kvPut, kvDelete, kvList, saveShot, deleteShot, SHOTS } from './kv.js';
import { assistantStatus, assistantTurn } from './assistant.js';
import { startAlertRunner, alertEvents, clearAlertLog, testWebhook } from './alertrunner.js';
import { economicCalendar } from './calendar.js';
import { streamHandler } from './tdstream.js';
import { tvGetBars, tvFillBars, tvRangeOhlc, tvStatus, tvSearch, tvEntry, tvDescribe, tvInvalidate } from './tvsource.js';
import { createFeedManager, compatibleFeed } from './tvfeeds.js';
import {
  sourceOf, sourcesOf, setSource, keyConfigured as tdKeyConfigured, tdGetBars, tdRangeOhlc, tdFillBars,
  tdStatus, tdRange, tdClearCache, tdCoverage, tdLookup,
} from './twelvedata.js';

// Optional ChartDesk/.env (gitignored) for TWELVE_DATA_API_KEY, ANTHROPIC_API_KEY, AWS_PROFILE…
// Values already set in the environment win. Keys are read lazily, so loading here is early enough.
const ENV_FILE = path.resolve(import.meta.dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// stocks / ETFs added from symbol search
for (const e of (await kvGet('tdSymbols')) || []) addSymbol(e);
for (const e of (await kvGet('tvSymbols')) || []) addSymbol(e); // TradingView markets added from search
const feeds = createFeedManager({catalog:bySymbol, describe:tvDescribe, load:()=>kvGet('tvFeeds'), save:v=>kvPut('tvFeeds',v), invalidate:tvInvalidate});
await feeds.init();

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.pine': 'text/plain; charset=utf-8' };

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readBody(req, max = 512 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('Upload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
const num = v => (v == null || v === '' ? undefined : Number(v));

const routes = [
  ['GET', /^\/api\/symbols$/, async () => CATALOG.map(s => {
    if (s.provider === 'binance') return { ...s, sources: ['binance'] };
    const c = coverage(s.symbol);
    return {
      ...s,
      provider: sourceOf(s.symbol),          // effective data source for this symbol
      sources: sourcesOf(s.symbol),
      hasDukascopy: !!s.s3,
      coverage: { first: c.first, last: c.last, months: c.months.length },
      ...(s.td ? { tdCoverage: tdCoverage(s.symbol), tdConfigured: tdKeyConfigured() } : {}),
    };
  })],
  ['POST', /^\/api\/symbols\/td$/, async (q, body) => {
    const entry = addSymbol(await tdLookup(JSON.parse(body.toString('utf8')).ticker));
    const list = (await kvGet('tdSymbols')) || [];
    if (entry.custom && !list.some(e => e.symbol === entry.symbol)) await kvPut('tdSymbols', [...list, entry]);
    return { symbol: entry.symbol, name: entry.name, market: entry.market };
  }],
  ['GET', /^\/api\/bars$/, async (q) => {
    if (!bySymbol[q.symbol]) throw Object.assign(new Error('Unknown symbol'), { status: 404 });
    if (!TF[q.tf]) throw Object.assign(new Error('Unknown timeframe'), { status: 400 });
    const opts = { before: num(q.before), after: num(q.after), limit: num(q.limit), cacheOnly: q.cached === '1', live: q.live === '1', streaming: q.stream === '1' };
    const src = sourceOf(q.symbol);
    return src === 'tradingview' ? tvGetBars(q.symbol, q.tf, opts) : src === 'twelvedata' ? tdGetBars(q.symbol, q.tf, opts) : getBars(q.symbol, q.tf, opts);
  }],
  ['GET', /^\/api\/range-ohlc$/, async (q) => (sourceOf(q.symbol) === 'tradingview' ? tvRangeOhlc(q.symbol, Number(q.from), Number(q.to))
    : sourceOf(q.symbol) === 'twelvedata' ? tdRangeOhlc(q.symbol, Number(q.from), Number(q.to))
    : rangeOhlc(q.symbol, Number(q.from), Number(q.to)))],
  // Real candles at the finest cached resolution inside [from, to) — Twelve Data replay fills.
  ['GET', /^\/api\/fill-bars$/, async (q) => (sourceOf(q.symbol) === 'tradingview' ? tvFillBars : tdFillBars)(q.symbol, Number(q.from), Number(q.to))],
  ['GET', /^\/api\/tv\/status$/, async () => tvStatus],
  ['GET', /^\/api\/tv\/search$/, async (q) => {
    const list = await tvSearch(q.q, q.type, q.exchange, q.offset);
    return q.symbol && bySymbol[q.symbol] ? list.map(m=>({...m,compatible:compatibleFeed(bySymbol[q.symbol],m.id)})) : list;
  }],
  ['POST', /^\/api\/tv\/feed$/, async (q, body) => {
    const {symbol, feed} = JSON.parse(body.toString('utf8'));
    const result = await feeds.set(symbol,feed);
    await setSource(symbol,'tradingview');
    return result;
  }],
  ['POST', /^\/api\/symbols\/tv$/, async (q, body) => {
    const m = JSON.parse(body.toString('utf8'));
    if (bySymbol[String(m.id || '').toUpperCase()]) return { symbol: String(m.id).toUpperCase() };
    const entry = addSymbol(await tvEntry(m));
    const list = (await kvGet('tvSymbols')) || [];
    if (!list.some(e => e.symbol === entry.symbol)) await kvPut('tvSymbols', [...list, entry]);
    return { symbol: entry.symbol, name: entry.name, market: entry.market };
  }],
  ['POST', /^\/api\/source$/, async (q, body) => { const { symbol, source } = JSON.parse(body.toString('utf8')); return { symbol, source: await setSource(symbol, source) }; }],
  ['GET', /^\/api\/td\/status$/, async (q) => tdStatus(q.symbol, { probe: q.probe === '1' })],
  ['GET', /^\/api\/td\/range$/, async (q) => tdRange(q.symbol, q.tf)],
  ['POST', /^\/api\/td\/history$/, async (q, body) => ({ id: enqueueTdHistory(JSON.parse(body.toString('utf8'))) })],
  ['DELETE', /^\/api\/td\/cache$/, async (q) => { await tdClearCache(q.symbol, q.tf || null); return tdStatus(q.symbol); }],
  ['GET', /^\/api\/coverage$/, async (q) => coverage(q.symbol)],
  ['DELETE', /^\/api\/data$/, async (q) => { await deleteMonths(q.symbol, String(q.months || '').split(',').filter(Boolean)); return coverage(q.symbol); }],
  ['GET', /^\/api\/s3\/status$/, async () => ({ bucket: BUCKET, region: REGION, ...(await credentialStatus()) })],
  ['GET', /^\/api\/s3\/estimate$/, async (q) => {
    const spec = bySymbol[q.symbol];
    if (!spec?.s3) throw new Error('Not an archive symbol');
    let files = 0, bytes = 0, lists = 0;
    const perMonth = [];
    for (let ym = q.from; ym <= q.to; ym = nextYm(ym)) {
      const [y, m] = ym.split('-').map(Number);
      const r = await listMonth(spec.s3, y, m - 1);
      lists += r.requests;
      const b = r.files.reduce((a, f) => a + f.size, 0);
      files += r.files.length; bytes += b;
      perMonth.push({ ym, files: r.files.length, bytes: b });
    }
    return { files, bytes, lists, perMonth, costUsd: estimateCost({ gets: files, lists, bytes }), listingCostUsd: estimateCost({ lists }) };
  }],
  ['POST', /^\/api\/jobs\/download$/, async (q, body) => ({ id: enqueueDownload(JSON.parse(body.toString('utf8'))) })],
  ['GET', /^\/api\/jobs$/, async () => listJobs()],
  ['POST', /^\/api\/jobs\/([\w]+)\/cancel$/, async (q, b, m) => ({ ok: cancelJob(m[1]) })],
  ['POST', /^\/api\/import$/, async (q, body) => importCsv({ symbol: q.symbol, tz: q.tz || 'UTC', side: q.side || 'bid', text: body.toString('utf8') })],
  ['GET', /^\/api\/kv$/, async (q) => kvList(q.prefix || '')],
  ['GET', /^\/api\/kv\/(.+)$/, async (q, b, m) => kvGet(decodeURIComponent(m[1]))],
  ['PUT', /^\/api\/kv\/(.+)$/, async (q, body, m) => { await kvPut(decodeURIComponent(m[1]), JSON.parse(body.toString('utf8'))); return { ok: true }; }],
  ['DELETE', /^\/api\/kv\/(.+)$/, async (q, b, m) => { await kvDelete(decodeURIComponent(m[1])); return { ok: true }; }],
  // navigator.sendBeacon (page unload) can only POST.
  ['POST', /^\/api\/kv-beacon\/(.+)$/, async (q, body, m) => { await kvPut(decodeURIComponent(m[1]), JSON.parse(body.toString('utf8'))); return { ok: true }; }],
  ['GET', /^\/api\/assistant\/status$/, async () => assistantStatus()],
  ['POST', /^\/api\/assistant$/, async (q, body) => assistantTurn(JSON.parse(body.toString('utf8')).messages)],
  ['GET', /^\/api\/alerts\/events$/, async (q) => alertEvents(Number(q.since) || 0)],
  ['DELETE', /^\/api\/alerts\/log$/, async () => clearAlertLog()],
  ['GET', /^\/api\/calendar$/, async (q) => economicCalendar(q.force === '1')],
  ['POST', /^\/api\/alerts\/test-webhook$/, async (q, body) => testWebhook(JSON.parse(body.toString('utf8')))],
  ['POST', /^\/api\/shots$/, async (q, body) => ({ url: await saveShot(body) })],
  ['DELETE', /^\/api\/shots$/, async (q) => { await deleteShot(q.url); return { ok: true }; }],
];

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/api/stream') { streamHandler(req, res, q); return; } // live Twelve Data ticks (Server-Sent Events)
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) {
        const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : null;
        json(res, 200, await fn(q, body, m));
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Not found' }); return; }
    if (url.pathname.startsWith('/shots/')) { serveFile(res, path.join(SHOTS, path.basename(url.pathname))); return; }
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = path.join(PUBLIC, rel || 'index.html');
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    serveFile(res, fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`ChartDesk running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
startAlertRunner(); // price / indicator / drawing alerts keep running while the browser is closed
