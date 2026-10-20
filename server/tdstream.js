// Live Twelve Data prices over their WebSocket (ticks every second or two). The Basic plan includes a small
// WebSocket allowance (a few symbols at once) that is separate from the 800 daily API credits, so streaming
// replaces most of the chart's polling. The server keeps one connection, subscribes to the symbols that open
// charts and armed alerts need, and forwards ticks to the app as Server-Sent Events (/api/stream).

import { tdSymbolOf, keyConfigured, tdApiKey, sourceOf } from './twelvedata.js';
import { tvSymbolOf, tvWant, tvRelease, setTickSink } from './tvsource.js';

const WS_URL = 'wss://ws.twelvedata.com/v1/quotes/price';
const MAX_SYMBOLS = 8;          // Basic plan: 8 WebSocket credits, one per subscribed symbol
const RELEASE_MS = 60e3;        // keep a symbol subscribed a minute after its last chart closes (timeframe switches)

let ws = null, retry = null, heartbeat = null, backoff = 2000;
const wants = new Map();        // symbol → number of chart streams + alert holds
const releaseTimers = new Map();
const subscribed = new Set();   // symbols the server confirmed
const failed = new Map();       // symbol → reason Twelve Data refused it
const last = new Map();         // symbol → { price, at }
const minute = new Map();       // symbol → forming 1-minute candle built from ticks (alerts)
const clients = new Set();      // { res, symbols: Set }
export const streamStatus = { connected: false, lastError: null, since: null };

const tdOf = s => tdSymbolOf(s);
const viaTv = s => sourceOf(s) === 'tradingview' && !!tvSymbolOf(s);
const tvWants = new Map();      // symbols streamed from TradingView quotes instead → hold count
const symbolOfTd = td => [...wants.keys()].find(s => tdOf(s) === td);

function send(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } }
function broadcast(symbol, event, data) { for (const c of clients) if (c.symbols.has(symbol)) send(c.res, event, data); }

function connect() {
  if (ws || !keyConfigured() || !wants.size) return;
  clearTimeout(retry);
  ws = new WebSocket(`${WS_URL}?apikey=${tdApiKey()}`);
  ws.onopen = () => {
    streamStatus.connected = true; streamStatus.since = Date.now(); streamStatus.lastError = null; backoff = 2000;
    subscribed.clear();
    syncSubscriptions();
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { try { ws?.send(JSON.stringify({ action: 'heartbeat' })); } catch { /* reconnects below */ } }, 10e3);
  };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'price') {
      const sym = symbolOfTd(m.symbol);
      if (sym && Number.isFinite(m.price) && !viaTv(sym)) onPrice(sym, m.price, Date.now());
    } else if (m.event === 'subscribe-status') {
      for (const s of m.success || []) { const sym = symbolOfTd(s.symbol); if (sym) { subscribed.add(sym); failed.delete(sym); broadcast(sym, 'status', { symbol: sym, streaming: true }); } }
      for (const f of m.fails || []) {
        const sym = symbolOfTd(f.symbol);
        if (sym) { failed.set(sym, f.message || 'not available on this plan'); broadcast(sym, 'status', { symbol: sym, streaming: false, reason: failed.get(sym) }); }
      }
    } else if (m.status === 'error' || m.event === 'error') streamStatus.lastError = m.message || 'stream error';
  };
  ws.onerror = e => { streamStatus.lastError = e.message || 'connection error'; };
  ws.onclose = () => {
    ws = null; streamStatus.connected = false; subscribed.clear();
    clearInterval(heartbeat);
    for (const c of clients) for (const s of c.symbols) send(c.res, 'status', { symbol: s, streaming: false, reason: 'reconnecting' });
    if (wants.size) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60e3); }
  };
}

/** A live price from either stream: remember it, build the minute candle (alerts), forward it to the charts. */
function onPrice(sym, price, at) {
  last.set(sym, { price, at });
  const t = Math.floor(at / 60000) * 60;
  const cur = minute.get(sym);
  if (cur && cur.time === t) { cur.high = Math.max(cur.high, price); cur.low = Math.min(cur.low, price); cur.close = price; }
  else minute.set(sym, { time: t, start: t, open: price, high: price, low: price, close: price, volume: 0 });
  broadcast(sym, 'tick', { symbol: sym, price, at });
}
setTickSink((sym, price, at) => { if (tvWants.has(sym)) onPrice(sym, price, at); });

/** Subscribe to wanted symbols (up to the plan's limit), unsubscribe released ones. */
function syncSubscriptions() {
  if (!ws || ws.readyState !== 1) return;
  const want = [...wants.keys()].filter(s => tdOf(s) && !failed.has(s)).slice(0, MAX_SYMBOLS);
  const add = want.filter(s => !subscribed.has(s)), drop = [...subscribed].filter(s => !want.includes(s));
  if (add.length) ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: add.map(tdOf).join(',') } }));
  if (drop.length) { ws.send(JSON.stringify({ action: 'unsubscribe', params: { symbols: drop.map(tdOf).join(',') } })); drop.forEach(s => subscribed.delete(s)); }
}

export function want(symbol) {
  if (viaTv(symbol)) { // TradingView quote stream
    tvWants.set(symbol, (tvWants.get(symbol) || 0) + 1);
    tvWant(symbol);
    return 'tv';
  }
  if (!tdOf(symbol)) return;
  clearTimeout(releaseTimers.get(symbol)); releaseTimers.delete(symbol);
  wants.set(symbol, (wants.get(symbol) || 0) + 1);
  if (!ws) connect(); else syncSubscriptions();
}
export function release(symbol, route = null) {
  if (route === 'tv' || (route == null && tvWants.has(symbol))) {
    const k = (tvWants.get(symbol) || 0) - 1;
    if (k > 0) { tvWants.set(symbol, k); return; }
    tvWants.delete(symbol);
    setTimeout(() => { if (!tvWants.has(symbol)) { tvRelease(symbol); last.delete(symbol); minute.delete(symbol); } }, RELEASE_MS);
    return;
  }
  const n = (wants.get(symbol) || 0) - 1;
  if (n > 0) { wants.set(symbol, n); return; }
  wants.set(symbol, 0);
  releaseTimers.set(symbol, setTimeout(() => {
    if ((wants.get(symbol) || 0) > 0) return;
    wants.delete(symbol); last.delete(symbol); minute.delete(symbol);
    syncSubscriptions();
    if (!wants.size && ws) { try { ws.close(); } catch { /* already closed */ } }
  }, RELEASE_MS));
}

/** Latest streamed price, if fresh. */
export function lastTick(symbol, maxAge = 15e3) { const t = last.get(symbol); return t && Date.now() - t.at < maxAge ? t : null; }
/** The forming 1-minute candle built from ticks (for alerts), if the stream is live. */
export function streamedMinute(symbol) { return lastTick(symbol) ? minute.get(symbol) : null; }
export const isStreaming = symbol => (subscribed.has(symbol) || tvWants.has(symbol)) && !!lastTick(symbol, 60e3);

/** GET /api/stream?symbols=XAUUSD — Server-Sent Events: `tick` { symbol, price, at } and `status`. */
export function streamHandler(req, res, q) {
  const symbols = new Set(String(q.symbols || '').split(',').filter(s => tdOf(s) || viaTv(s)));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const client = { res, symbols };
  clients.add(client);
  const routes = new Map();
  for (const s of symbols) {
    routes.set(s, want(s));
    if (routes.get(s) === 'tv') send(res, 'status', { symbol: s, streaming: true, via: 'tradingview' });
    else if (!keyConfigured()) send(res, 'status', { symbol: s, streaming: false, reason: 'no Twelve Data key' });
    else if (failed.has(s)) send(res, 'status', { symbol: s, streaming: false, reason: failed.get(s) });
    else if (subscribed.has(s)) send(res, 'status', { symbol: s, streaming: true });
    const t = last.get(s);
    if (t) send(res, 'tick', { symbol: s, price: t.price, at: t.at });
  }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20e3);
  req.on('close', () => { clearInterval(ping); clients.delete(client); for (const s of symbols) release(s, routes.get(s) || 'td'); });
}
