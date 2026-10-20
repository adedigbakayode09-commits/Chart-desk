// Market-data access for the UI: one interface over three real providers.
//   twelvedata → local server (/api/bars) → Twelve Data /time_series, cached per interval (key stays on the server)
//   dukascopy  → local server cache (/api/bars), filled from Dukascopy's tick archive or CSV exports
//   binance    → Binance public REST + WebSocket (live crypto)
// A symbol's `provider` is its *active* source (XAUUSD can use Twelve Data or Dukascopy).
// Bars: { time, start, open, high, low, close, volume, spread }   (time = chart label, start = first minute)

import { TF } from './core/sessions.js';
import { api, decimalsOf, kv } from './util.js';

const BINANCE = 'https://data-api.binance.vision/api/v3';
const BINANCE_WS = 'wss://data-stream.binance.vision/ws';

export const TIMEFRAMES = [
  ['1m', '1m'], ['3m', '3m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'],
  ['1h', '1h'], ['2h', '2h'], ['4h', '4h'], ['1d', '1D'], ['1w', '1W'], ['1M', '1M'],
];
export const tfLabel = tf => (TIMEFRAMES.find(t => t[0] === tf) || [tf, tf])[1];
export const tfSec = tf => TF[tf].sec;

export let SYMBOLS = [];
const bySym = new Map();
export const spec = s => bySym.get(s);

export async function loadSymbols() {
  SYMBOLS = await api('/api/symbols');
  bySym.clear();
  for (const s of SYMBOLS) bySym.set(s.symbol, s);
  for (const c of (await kv.get(CUSTOM_KEY, [])) || []) registerBinanceSymbol(c.symbol, c.name, false);
  return SYMBOLS;
}

// Any Binance spot pair can be charted (screener, symbol search): it's added here and remembered.
const CUSTOM_KEY = 'customSymbols';
export function registerBinanceSymbol(symbol, name = '', remember = true) {
  if (bySym.has(symbol)) return bySym.get(symbol);
  const quote = ['USDT', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY'].find(q => symbol.endsWith(q) && symbol.length > q.length) || 'USDT';
  const base = symbol.slice(0, -quote.length);
  const s = {
    symbol, name: name || `${base} / ${quote}`, market: 'Crypto', type: 'crypto', provider: 'binance', session: 'crypto', base, quote,
    precision: null, tickSize: null, pip: null, contractSize: 1, lotName: base, defaultSpread: 0, commissionPerLot: 0, commissionPct: 0.1, sources: ['binance'], custom: true,
  };
  SYMBOLS.push(s);
  bySym.set(symbol, s);
  if (remember) { const list = kv.peek(CUSTOM_KEY, []) || []; if (!list.some(x => x.symbol === symbol)) kv.set(CUSTOM_KEY, [...list, { symbol, name: s.name }]); }
  return s;
}
/** Every Binance spot pair (for symbol search), fetched once. */
let binanceAll = null;
export async function binancePairs() {
  if (!binanceAll) {
    const r = await fetch(`${BINANCE}/ticker/price`);
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    binanceAll = (await r.json()).map(t => t.symbol).filter(s => /(USDT|FDUSD|USDC|BTC|ETH)$/.test(s));
  }
  return binanceAll;
}
export async function refreshCoverage() { return loadSymbols(); }

export const PROVIDER_LABEL = { twelvedata: 'Twelve Data', tradingview: 'TradingView', dukascopy: 'Dukascopy', binance: 'Binance' };
export const providerLabel = p => PROVIDER_LABEL[p] || p;
const viaServer = s => s.provider !== 'binance';

/** Switch a symbol between Twelve Data and Dukascopy (persisted on the server). */
export async function setSource(symbol, source) {
  await api('/api/source', { method: 'POST', body: { symbol, source } });
  invalidateMinutes(symbol);
  await loadSymbols();
}

/** Twelve Data history available for one timeframe: { earliest, cachedFirst, cachedLast, complete }. */
export const tdRange = (symbol, tf) => api(`/api/td/range?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);

const rowToBar = r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], spread: r[6], start: r[7] ?? r[0] });

// ------------------------------------------------------------------ Binance
const binPrecision = new Map();
async function binanceKlines(symbol, interval, { startTime, endTime, limit = 1000 } = {}) {
  let url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.min(1000, limit)}`;
  if (startTime != null) url += `&startTime=${startTime}`;
  if (endTime != null) url += `&endTime=${endTime}`;
  const r = await fetch(url);
  if (r.status === 400) throw new Error(`Binance doesn't list ${symbol}`);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const rows = await r.json();
  let prec = binPrecision.get(symbol) || 0;
  for (const k of rows.slice(-200)) prec = Math.max(prec, decimalsOf(k[1]), decimalsOf(k[2]), decimalsOf(k[3]), decimalsOf(k[4]));
  binPrecision.set(symbol, Math.max(2, prec));
  return rows.map(k => ({ time: k[0] / 1000, start: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], spread: 0 }));
}

export function precisionOf(symbol) {
  const s = spec(symbol);
  return s?.precision ?? binPrecision.get(symbol) ?? 2;
}

// ------------------------------------------------------------------ bars
/** Bars ending before `before` (exclusive), or starting at/after `after`, or the latest bars. */
export async function fetchBars(symbol, tf, { before = null, after = null, limit = 1000, cachedOnly = false, live = false, streaming = false } = {}) {
  const s = spec(symbol);
  if (!s) throw new Error(`Unknown symbol ${symbol}`);
  if (viaServer(s)) {
    const q = new URLSearchParams({ symbol, tf, limit: String(limit) });
    if (before != null) q.set('before', String(before));
    if (after != null) q.set('after', String(after));
    if (cachedOnly) q.set('cached', '1');
    if (live) q.set('live', '1');
    if (streaming) q.set('stream', '1');
    const res = await api(`/api/bars?${q}`);
    return { bars: res.bars.map(rowToBar), hasMoreBefore: res.hasMoreBefore, hasMoreAfter: res.hasMoreAfter, fetchedAt: res.fetchedAt, throttled: res.throttled, credits: res.credits };
  }
  const lim = Math.min(1000, limit);
  if (after != null) {
    const bars = await binanceKlines(symbol, tf, { startTime: after * 1000, limit: lim });
    return { bars, hasMoreBefore: true, hasMoreAfter: bars.length === lim };
  }
  const bars = await binanceKlines(symbol, tf, { endTime: before != null ? before * 1000 - 1 : undefined, limit: lim });
  return { bars, hasMoreBefore: bars.length === lim, hasMoreAfter: before != null };
}

/** Every bar in [from, to) — used by the strategy tester. */
export async function fetchRange(symbol, tf, from, to, onProgress) {
  const out = [];
  let after = from;
  const s = spec(symbol);
  const chunk = viaServer(s) ? 20000 : 1000;
  for (let guard = 0; guard < 2000; guard++) {
    const { bars, hasMoreAfter } = await fetchBars(symbol, tf, { after, limit: chunk });
    let added = 0;
    for (const b of bars) {
      if (b.start >= to) break;
      if (!out.length || b.start > out[out.length - 1].start) { out.push(b); added++; }
    }
    onProgress?.(out.length, out.length ? out[out.length - 1].start : from);
    // the server drops market-closed candles from each page, so a short page doesn't mean the end — trust hasMoreAfter
    if (!bars.length || !hasMoreAfter || bars[bars.length - 1].start >= to || !added) break;
    after = bars[bars.length - 1].start + 1;
  }
  return out;
}

// ------------------------------------------------------------------ 1-minute cache (replay fills + forming bars)
const DAY = 86400;
const dayCache = new Map(); // `${symbol}|${day}` → Promise<bars>
function loadDay(symbol, day) {
  const key = `${symbol}|${day}`;
  if (!dayCache.has(key)) {
    const from = day * DAY, to = from + DAY;
    const p = (async () => {
      const s = spec(symbol);
      if (s.provider === 'dukascopy') {
        const { bars } = await fetchBars(symbol, '1m', { after: from, limit: 1440 });
        return bars.filter(b => b.time < to);
      }
      // Twelve Data: real candles at the finest resolution already cached (each carries its `seconds`).
      if (s.provider === 'twelvedata' || s.provider === 'tradingview') return api(`/api/fill-bars?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
      const a = await binanceKlines(symbol, '1m', { startTime: from * 1000, endTime: to * 1000 - 1, limit: 1000 });
      const last = a[a.length - 1];
      const b = last && last.time + 60 < to ? await binanceKlines(symbol, '1m', { startTime: (last.time + 60) * 1000, endTime: to * 1000 - 1, limit: 1000 }) : [];
      return a.concat(b);
    })();
    p.catch(() => dayCache.delete(key));
    dayCache.set(key, p);
    if (dayCache.size > 400) dayCache.delete(dayCache.keys().next().value);
  }
  return dayCache.get(key);
}
export function invalidateMinutes(symbol) {
  for (const k of [...dayCache.keys()]) if (k.startsWith(`${symbol}|`)) dayCache.delete(k);
}

/** 1-minute bars with time in [from, to) — for Twelve Data, the finest cached candles (see loadDay). */
export async function getMinutes(symbol, from, to) {
  // Twelve Data: ask for the exact window so the server checks cached coverage for precisely [from, to).
  if (['twelvedata', 'tradingview'].includes(spec(symbol)?.provider)) return api(`/api/fill-bars?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
  const days = [];
  for (let d = Math.floor(from / DAY); d * DAY < to; d++) days.push(d);
  const parts = await Promise.all(days.map(d => loadDay(symbol, d)));
  const out = [];
  for (const p of parts) for (const b of p) if (b.time >= from && b.time < to) out.push(b);
  return out;
}

/** First minute at/after t (searching up to `maxDays` ahead), or null. */
export async function nextMinute(symbol, t, maxDays = 10) {
  for (let d = Math.floor(t / DAY), n = 0; n < maxDays; d++, n++) {
    const bars = await loadDay(symbol, d);
    const b = bars.find(x => x.time >= t);
    if (b) return b;
  }
  return null;
}
/** Last minute strictly before t (searching up to `maxDays` back), or null. */
export async function prevMinute(symbol, t, maxDays = 10) {
  for (let d = Math.floor((t - 1) / DAY), n = 0; n < maxDays; d--, n++) {
    const bars = await loadDay(symbol, d);
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].time < t) return bars[i];
  }
  return null;
}

/** OHLC of everything in [from, to): builds the forming bar during replay. */
export async function rangeOhlc(symbol, from, to) {
  if (to <= from) return null;
  const s = spec(symbol);
  if (viaServer(s)) return api(`/api/range-ohlc?symbol=${symbol}&from=${from}&to=${to}`);
  // Binance: whole hours from 1h klines, the edges from 1-minute bars.
  const h0 = Math.ceil(from / 3600) * 3600, h1 = Math.floor(to / 3600) * 3600;
  let parts = [];
  if (h1 - h0 >= 3600 * 3) {
    const hours = [];
    for (let t = h0; t < h1;) {
      const chunk = await binanceKlines(symbol, '1h', { startTime: t * 1000, endTime: h1 * 1000 - 1, limit: 1000 });
      if (!chunk.length) break;
      hours.push(...chunk);
      t = chunk[chunk.length - 1].time + 3600;
    }
    parts = [...await getMinutes(symbol, from, h0), ...hours.filter(b => b.time >= h0 && b.time < h1), ...await getMinutes(symbol, h1, to)];
  } else {
    parts = await getMinutes(symbol, from, to);
  }
  parts.sort((a, b) => a.time - b.time);
  if (!parts.length) return null;
  return {
    open: parts[0].open, high: Math.max(...parts.map(b => b.high)), low: Math.min(...parts.map(b => b.low)),
    close: parts[parts.length - 1].close, volume: parts.reduce((a, b) => a + b.volume, 0), spread: 0,
    first: parts[0].time, last: parts[parts.length - 1].time, count: parts.length,
  };
}

// ------------------------------------------------------------------ live (Binance only)
export function subscribeLive(symbol, tf, onBar, onStatus) {
  const s = spec(symbol);
  if (s?.provider !== 'binance') return () => {};
  let ws = null, closed = false, retry = null;
  const open = () => {
    ws = new WebSocket(`${BINANCE_WS}/${symbol.toLowerCase()}@kline_${tf}`);
    ws.onopen = () => onStatus?.('live');
    ws.onmessage = e => {
      const k = JSON.parse(e.data).k;
      if (k) onBar({ time: k.t / 1000, start: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, spread: 0 });
    };
    ws.onclose = () => { if (!closed) { onStatus?.('reconnecting'); retry = setTimeout(open, 3000); } };
  };
  open();
  return () => { closed = true; clearTimeout(retry); if (ws) { ws.onclose = null; ws.close(); } };
}

export async function binanceTickers(symbols) {
  if (!symbols.length) return [];
  const r = await fetch(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return r.json();
}
