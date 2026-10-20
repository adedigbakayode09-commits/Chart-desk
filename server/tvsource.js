// TradingView as a data source, through the community library @mathieuc/tradingview (anonymous — no account, no
// cookies). It is NOT an official TradingView API: it talks to TradingView's own website servers, which their terms
// don't permit, so it can stop working or be blocked at any time. Chosen per symbol in Data (Twelve Data and
// Dukascopy stay available). Candles load in well under a second with no API credits; live prices come from
// TradingView's quote stream (about one update a second for gold) and are pushed to the app by server/tdstream.js.
// Anonymous history is limited (about 5,000 bars per timeframe), so older dates belong to Twelve Data / Dukascopy.

import { getCandles, getSymbolInfo, watchQuotes } from '@mathieuc/tradingview/data';
import { bySymbol } from './catalog.js';

export const tvSymbolOf = symbol => bySymbol[symbol]?.tv || null;
const TV_TF = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D', '1w': 'W', '1M': 'M' };
const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2678400 };
const TIMEOUT = 20000;

export const tvStatus = { lastError: null, lastOk: null, requests: 0 };
const cache = new Map(); // `${symbol}|${tf}|latest` → { at, rows }

const row = c => [c.time, c.open, c.high, c.low, c.close, c.volume || 0, 0, c.time];

async function candles(symbol, tf, opts) {
  const tv = tvSymbolOf(symbol);
  if (!tv) throw Object.assign(new Error(`${symbol} has no TradingView feed in ChartDesk`), { status: 400 });
  if (!TV_TF[tf]) throw Object.assign(new Error(`TradingView: no ${tf} candles`), { status: 400 });
  tvStatus.requests++;
  try {
    const list = await getCandles({ symbol: tv, timeframe: TV_TF[tf], timeoutMs: TIMEOUT, ...opts });
    tvStatus.lastOk = Date.now(); tvStatus.lastError = null;
    return list.map(row);
  } catch (e) {
    if (e.code === 'NO_DATA') return [];
    tvStatus.lastError = e.message;
    throw Object.assign(new Error(`TradingView: ${e.message}`), { status: 502 });
  }
}

/** Same contract as storage.getBars / tdGetBars: the latest bars, bars before `before`, or from `after`. */
export async function tvGetBars(symbol, tf, { before = null, after = null, limit = 1000 } = {}) {
  limit = Math.max(1, Math.min(limit || 1000, 5000));
  const sec = TF_SEC[tf] || 60, now = Math.floor(Date.now() / 1000);
  if (before == null && after == null) {
    const key = `${symbol}|${tf}|${limit}`, hit = cache.get(key);
    // charts poll for corrections every ~30 s; ticks move the price in between, so 5 s of caching is plenty
    const rows = hit && Date.now() - hit.at < 5000 ? hit.rows : await candles(symbol, tf, { count: limit });
    cache.set(key, { at: Date.now(), rows });
    return { bars: rows, hasMoreBefore: rows.length >= limit * 0.9, hasMoreAfter: false, source: 'tradingview', fetchedAt: hit?.at ?? Date.now() };
  }
  if (before != null) {
    const rows = (await candles(symbol, tf, { count: limit, to: before - 1 })).filter(r => r[0] < before);
    return { bars: rows.slice(-limit), hasMoreBefore: rows.length >= limit * 0.9, hasMoreAfter: true, source: 'tradingview' };
  }
  const to = Math.min(now, after + sec * limit);
  const rows = (await candles(symbol, tf, { from: after, to, maxCount: limit })).filter(r => r[0] >= after);
  return { bars: rows.slice(0, limit), hasMoreBefore: true, hasMoreAfter: to < now - sec, source: 'tradingview' };
}

/** 1-minute candles in [from, to) — Bar Replay fills and forming bars (recent dates only when anonymous). */
export async function tvFillBars(symbol, from, to) {
  const rows = (await candles(symbol, '1m', { from, to: to - 1, maxCount: 20000 })).filter(r => r[0] >= from && r[0] < to);
  return rows.map(r => ({ time: r[0], start: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], spread: 0, seconds: 60 }));
}
export async function tvRangeOhlc(symbol, from, to) {
  const m = await tvFillBars(symbol, from, to);
  if (!m.length) return null;
  return { open: m[0].open, high: Math.max(...m.map(b => b.high)), low: Math.min(...m.map(b => b.low)), close: m[m.length - 1].close,
    volume: m.reduce((a, b) => a + b.volume, 0), spread: 0, first: m[0].time, last: m[m.length - 1].time, count: m.length };
}

// ------------------------------------------------------------------ live quotes
// One quote watcher for every wanted symbol; restarted when the set changes or the connection drops.
let sink = () => {};
/** Where ticks go (server/tdstream.js forwards them to the app and the alert runner). */
export function setTickSink(fn) { sink = fn; }
const wanted = new Set();
let watcher = null, restarting = null, generation = 0;

async function restart() {
  const gen = ++generation;
  const old = watcher; watcher = null;
  if (old) { try { await old.stop(); } catch { /* already closed */ } }
  if (!wanted.size || gen !== generation) return;
  const byTv = new Map([...wanted].map(s => [tvSymbolOf(s), s]));
  try {
    const w = await watchQuotes({ symbols: [...byTv.keys()], fields: ['lp', 'bid', 'ask'] }, {
      onData(tv, q, ch) {
        if (gen !== generation) return;
        const sym = byTv.get(tv);
        const price = ch?.lp ?? ch?.bid ?? null;
        if (sym && price != null && Number.isFinite(q.lp ?? price)) sink(sym, q.lp ?? price, Date.now());
      },
      onError(e) { tvStatus.lastError = e.message; },
    });
    if (gen !== generation) { await w.stop(); return; }
    watcher = w;
    tvStatus.lastOk = Date.now();
    w.closed.then(() => { if (watcher === w && wanted.size) { watcher = null; setTimeout(schedule, 3000); } });
  } catch (e) {
    tvStatus.lastError = e.message;
    if (gen === generation && wanted.size) setTimeout(schedule, 5000);
  }
}
function schedule() { clearTimeout(restarting); restarting = setTimeout(restart, 200); }

export function tvWant(symbol) { if (tvSymbolOf(symbol) && !wanted.has(symbol)) { wanted.add(symbol); schedule(); } }
export function tvRelease(symbol) { if (wanted.delete(symbol)) schedule(); }

// ------------------------------------------------------------------ any TradingView market (search → add)
import { searchMarkets } from '@mathieuc/tradingview/data';
const MARKET = { stock: 'Stocks', fund: 'ETFs', dr: 'Stocks', crypto: 'Crypto', forex: 'Forex', futures: 'Futures', index: 'Indices', bond: 'Bonds', economic: 'Economy', cfd: 'CFDs', spot: 'Commodities', commodity: 'Commodities' };

/** Markets matching a text (all of TradingView: stocks, crypto, futures, indices, forex, bonds…). */
export async function tvSearch(q, type, exchange, offset = 0) {
  const list = await searchMarkets(String(q || '').slice(0, 80), { ...(type ? {type} : {}), ...(exchange ? {exchange:String(exchange).slice(0,40)} : {}), offset:Math.max(0,Math.min(100000,Number(offset)||0)) });
  return list.map(m => ({ id: m.id, symbol: m.symbol, exchange: m.exchange, description: m.description, type: m.type, currency: m.currency, country: m.country }));
}
export function tvInvalidate(symbol) {
  for (const key of cache.keys()) if (key.startsWith(`${symbol}|`)) cache.delete(key);
  if (wanted.has(symbol)) {generation++;schedule();}
}
export async function tvDescribe(feed) {
  const id = String(feed || '').toUpperCase().trim();
  if (!/^[A-Z0-9_.!-]+:[A-Z0-9_.!\-/]+$/.test(id)) throw Object.assign(new Error('Use a qualified feed, e.g. OANDA:XAUUSD'), {status:400});
  const info = await getSymbolInfo({symbol:id,timeoutMs:TIMEOUT});
  const bars = await getCandles({symbol:id,timeframe:info.has_intraday ? '1' : 'D',count:2,timeoutMs:TIMEOUT});
  if (!bars.length) throw Object.assign(new Error(`No candles available for ${id}`), {status:404});
  const mintick = info.minmov / info.pricescale;
  if (!(mintick > 0)) throw new Error(`Missing price tick for ${id}`);
  return {tv:id, tvDescription:info.description || id, tvPine:{mintick, ...(id === 'PEPPERSTONE:XAUUSD' ? {qtyStep:0.1} : {})}};
}
/** Catalog entry for a TradingView market; price precision taken from its latest candles. */
export async function tvEntry(m) {
  const id = String(m.id || '').toUpperCase();
  if (!/^[A-Z0-9_.!-]+:[A-Z0-9_.!\-/]+$/.test(id)) throw Object.assign(new Error('Unknown TradingView symbol'), { status: 400 });
  const feed = await tvDescribe(id);
  const dec = Math.min(8, Math.max(0, Math.ceil(-Math.log10(feed.tvPine.mintick))));
  const type = String(m.type || '').toLowerCase(), crypto = type === 'crypto';
  return {
    symbol: id, name: m.description || id, market: MARKET[type] || 'Other', type: crypto ? 'crypto' : type === 'forex' ? 'forex' : type === 'index' ? 'index' : 'stock',
    provider: 'tradingview', ...feed, session: crypto ? 'crypto' : 'fx', base: id.split(':')[1], quote: m.currency || 'USD',
    precision: Math.max(dec, 2), tickSize: 10 ** -Math.max(dec, 2), pip: 10 ** -Math.max(dec, 2), point: 10 ** Math.max(dec, 2),
    contractSize: 1, lotName: 'unit', defaultSpread: 0, commissionPerLot: 0, commissionPct: 0, range: [0, 1e9], custom: true, exchange: m.exchange,
  };
}
