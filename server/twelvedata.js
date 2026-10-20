// Twelve Data market-data provider (https://twelvedata.com/docs) — XAU/USD and other FX/metals.
//
// * The API key is read from TWELVE_DATA_API_KEY (environment or ChartDesk/.env) and sent only from this
//   server, in the `Authorization: apikey …` header — it never reaches the browser or appears in URLs/logs.
// * Before any candles are requested the symbol is checked against your plan: /symbol_search?show_plan=true
//   says which plan an instrument needs, /api_usage says which plan you have (and your per-minute credits).
// * Every chart timeframe maps to its own Twelve Data interval (/time_series), cached on disk per interval in
//   data/twelvedata/<SYMBOL>/<interval>.bin so each candle is downloaded once. Candles are UTC (timezone=UTC),
//   validated, de-duplicated and sorted. Gaps are left as gaps — nothing is ever synthesised.
// * Requests are paced to the plan's per-minute credit limit; a per-minute 429 waits for the next minute and
//   retries, a daily-limit 429 is reported to the user.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './storage.js';
import { bySymbol } from './catalog.js';
import { nyOffset } from '../public/js/core/sessions.js';

const BASE = 'https://api.twelvedata.com';
const ROOT = path.join(DATA_DIR, 'twelvedata');
const SOURCES_FILE = path.join(DATA_DIR, 'user', 'data-sources.json');

/** Chart timeframe → Twelve Data interval. 3m has no Twelve Data equivalent. */
export const TD_INTERVAL = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1day', '1w': '1week', '1M': '1month' };
export const IV_SEC = { '1min': 60, '5min': 300, '15min': 900, '30min': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1day': 86400, '1week': 604800, '1month': 2678400 };
const TF_LABEL = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1D', '1w': '1W', '1M': '1M' };
const MAX_OUTPUT = 5000;            // Twelve Data's maximum outputsize per request
const AUTO_BACKFILL_REQUESTS = 6;   // older history fetched on demand; beyond this, use a history download job
const COLS = 6;                     // time, open, high, low, close, volume

export class TdError extends Error {
  constructor(message, status = 502, code = null) { super(message); this.status = status; this.code = code; }
}

let sleep = ms => new Promise(r => setTimeout(r, ms));
/** Tests replace the wait so rate-limit retries run instantly. */
export function _setSleepForTests(fn) { sleep = fn; }
const apiKey = () => (process.env.TWELVE_DATA_API_KEY || '').trim();
/** For the WebSocket price stream (server/tdstream.js); never sent to the browser. */
export const tdApiKey = () => apiKey();
export const keyConfigured = () => !!apiKey();
const fmtParam = t => new Date(t * 1000).toISOString().slice(0, 19);       // 2024-08-22T15:04:05 (UTC)
const fmtDay = t => new Date(t * 1000).toISOString().slice(0, 10);

export const tdSymbolOf = symbol => bySymbol[symbol]?.td || null;

// ------------------------------------------------------------------ data source per symbol
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')); } catch { /* defaults */ }

/** Effective data source: 'twelvedata' | 'dukascopy' | 'binance'. Twelve Data is the default where it exists. */
export function sourceOf(symbol) {
  const s = bySymbol[symbol];
  if (!s) return null;
  if (s.provider === 'binance') return 'binance';
  const o = overrides[symbol];
  if (o === 'dukascopy' && s.s3) return 'dukascopy';
  if (o === 'twelvedata' && s.td) return 'twelvedata';
  if (o === 'tradingview' && s.tv) return 'tradingview';
  if (s.tv && !o) return 'tradingview'; // fastest, live; switch per symbol in Data for older history
  return s.td ? 'twelvedata' : 'dukascopy';
}
export function sourcesOf(symbol) {
  const s = bySymbol[symbol];
  if (!s || s.provider === 'binance') return ['binance'];
  return [s.td && 'twelvedata', s.tv && 'tradingview', s.s3 && 'dukascopy'].filter(Boolean);
}
export async function setSource(symbol, source) {
  if (!sourcesOf(symbol).includes(source)) throw new TdError(`${symbol} can't use ${source}`, 400);
  overrides[symbol] = source;
  await fsp.mkdir(path.dirname(SOURCES_FILE), { recursive: true });
  await fsp.writeFile(SOURCES_FILE, JSON.stringify(overrides, null, 1));
  return sourceOf(symbol);
}

// ------------------------------------------------------------------ rate limiting + HTTP
export const stats = { requests: 0, rateLimitWaits: 0, lastError: null };
const limiter = {
  perMinute: 8,          // Basic plan default; replaced by /api_usage plan_limit
  stamps: [],
  waitingUntil: 0,
  chain: Promise.resolve(),
  acquire() {
    const run = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter(t => now - t < 60000);
        if (this.stamps.length < this.perMinute) { this.stamps.push(now); this.waitingUntil = 0; return; }
        const wait = 60000 - (now - this.stamps[0]) + 300;
        this.waitingUntil = now + wait;
        await sleep(wait);
      }
    });
    this.chain = run.catch(() => {});
    return run;
  },
};
export const limiterState = () => ({ perMinute: limiter.perMinute, usedThisMinute: limiter.stamps.filter(t => Date.now() - t < 60000).length, waitingUntil: limiter.waitingUntil || null });

function friendly(code, msg) {
  if (code === 401) return `Twelve Data rejected the API key — ${msg}`;
  if (code === 403) return `Your Twelve Data plan doesn't include this data — ${msg}`;
  if (code === 404) return `Twelve Data has no data for this request — ${msg}`;
  if (code === 414) return `Twelve Data request too long — ${msg}`;
  return `Twelve Data error ${code}: ${msg}`;
}

export async function call(endpoint, params = {}) {
  if (!keyConfigured()) {
    throw new TdError('Twelve Data API key not configured. Add TWELVE_DATA_API_KEY=your_key to ChartDesk/.env (or set it in the environment) and restart ChartDesk.', 503, 'NO_KEY');
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await limiter.acquire();
    stats.requests++;
    let res, body;
    try {
      res = await fetch(`${BASE}/${endpoint}?${new URLSearchParams(params)}`, { headers: { Authorization: `apikey ${apiKey()}` }, signal: AbortSignal.timeout(30000) });
      body = await res.json().catch(() => null);
    } catch (e) {
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw (stats.lastError = new TdError(`Could not reach Twelve Data (${e.name === 'TimeoutError' ? 'request timed out' : e.message}). Check your internet connection.`, 502, 'NETWORK'));
    }
    const code = body?.status === 'error' ? Number(body.code) || res.status : (res.ok ? 0 : res.status);
    if (!code) return body;
    const msg = String(body?.message || res.statusText || 'unknown error').replace(apiKey(), '***');
    if (code === 429 && /minute/i.test(msg) && attempt < 3) {
      // Per-minute credits used up (possibly by another app sharing the key): wait for the next minute.
      stats.rateLimitWaits++;
      const wait = Math.ceil((Date.now() + 1) / 60000) * 60000 + 1500 - Date.now();
      limiter.waitingUntil = Date.now() + wait;
      await sleep(wait);
      continue;
    }
    if (code === 429) throw (stats.lastError = new TdError(`Twelve Data credit limit reached — ${msg}`, 429, 'RATE_LIMIT'));
    if (code >= 500 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
    throw (stats.lastError = new TdError(friendly(code, msg), [401, 403, 404, 429].includes(code) ? code : code >= 500 ? 502 : 400, code === 400 && /no data is available/i.test(msg) ? 'NO_DATA' : null));
  }
  throw new TdError('Twelve Data kept rate-limiting the request — try again in a minute.', 429, 'RATE_LIMIT');
}

// ------------------------------------------------------------------ plan / symbol access
const PLAN_RANK = { basic: 0, free: 0, individual: 0, grow: 1, pro: 2, venture: 3, ultra: 3, enterprise: 4 };
const rank = p => PLAN_RANK[String(p || '').toLowerCase()];
let planCache = null;
const accessCache = new Map();

export async function planInfo(force = false) {
  if (!force && planCache && Date.now() - planCache.at < 10 * 60e3) return planCache.data;
  const u = await call('api_usage');
  if (Number(u.plan_limit) > 0) limiter.perMinute = Number(u.plan_limit);
  planCache = { at: Date.now(), data: u };
  return u;
}

/** Is `symbol` available on this key's plan? Cached for a day (1–2 credits). */
export async function symbolAccess(symbol, force = false) {
  const td = tdSymbolOf(symbol);
  if (!td) throw new TdError(`${symbol} isn't available from Twelve Data in ChartDesk`, 400);
  const hit = accessCache.get(td);
  if (!force && hit && Date.now() - hit.at < 86400e3) return hit.info;
  const res = await call('symbol_search', { symbol: td, show_plan: 'true', outputsize: '30' });
  const matches = (res.data || []).filter(x => x.symbol === td);
  const m = matches.find(x => /precious metal|physical currency|forex/i.test(`${x.instrument_type} ${x.exchange}`) || x.exchange === 'COMMODITY') || matches[0];
  if (!m) throw new TdError(`Twelve Data doesn't list ${td}`, 404, 'NO_SYMBOL');
  const plan = await planInfo();
  const required = m.access?.plan || m.access?.global || null;
  const mine = plan.plan_category || null;
  const supported = required == null || rank(required) == null || rank(mine) == null || rank(mine) >= rank(required);
  const info = { symbol: td, name: m.instrument_name, type: m.instrument_type, exchange: m.exchange, requiredPlan: required, yourPlan: mine, supported };
  accessCache.set(td, { at: Date.now(), info });
  return info;
}

/**
 * Look up a ticker on Twelve Data (stocks, ETFs, indices…) for the symbol list: prefers a US listing in USD.
 * Returns a catalog entry; throws when Twelve Data doesn't list it or the plan doesn't include it.
 */
export async function tdLookup(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-/]{0,14}$/.test(t)) throw new TdError('Enter a ticker such as AAPL, SPY or MSFT', 400);
  const res = await call('symbol_search', { symbol: t, show_plan: 'true', outputsize: '30' });
  const matches = (res.data || []).filter(x => x.symbol === t);
  if (!matches.length) throw new TdError(`Twelve Data doesn't list ${t}`, 404, 'NO_SYMBOL');
  const us = x => /NASDAQ|NYSE|ARCA|BATS|CBOE|AMEX/i.test(x.exchange) || x.country === 'United States';
  const m = matches.find(x => us(x) && x.currency === 'USD') || matches.find(x => x.currency === 'USD') || matches[0];
  const plan = await planInfo();
  const required = m.access?.plan || m.access?.global || null, mine = plan.plan_category || null;
  if (required != null && rank(required) != null && rank(mine) != null && rank(mine) < rank(required)) throw new TdError(`Your Twelve Data plan (${mine}) doesn't include ${t} — it needs the ${required} plan.`, 403, 'PLAN');
  const type = String(m.instrument_type || '');
  accessCache.set(t, { at: Date.now(), info: { symbol: t, name: m.instrument_name, type, exchange: m.exchange, requiredPlan: required, yourPlan: mine, supported: true } });
  return {
    symbol: t.replace(/[^A-Z0-9]/g, ''), name: `${m.instrument_name} · ${m.exchange}`,
    market: /etf|fund/i.test(type) ? 'ETFs' : /index/i.test(type) ? 'Indices' : /stock|equity|share|depositary/i.test(type) ? 'Stocks' : (type || 'Other'),
    type: 'stock', provider: 'twelvedata', session: 'us', td: t, base: t, quote: m.currency || 'USD', point: 100, precision: 2, tickSize: 0.01, pip: 0.01,
    contractSize: 1, lotName: 'share', defaultSpread: 0.02, commissionPerLot: 0, commissionPct: 0, range: [0.0001, 1e7], custom: true, exchange: m.exchange,
  };
}

async function ensureAccess(symbol) {
  const info = await symbolAccess(symbol);
  if (!info.supported) throw new TdError(`Your Twelve Data plan (${info.yourPlan}) doesn't include ${info.symbol} — it needs the ${info.requiredPlan} plan.`, 403, 'PLAN');
  return info;
}

// ------------------------------------------------------------------ parsing
/** "2024-01-02 10:00:00" or "2024-01-02" (UTC) → unix seconds. */
export function parseUtc(dt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(dt || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
}

/** Validate, de-duplicate and sort raw /time_series values. Never fills gaps. */
export function cleanValues(values = []) {
  const byTime = new Map();
  let invalid = 0;
  for (const v of values) {
    const t = parseUtc(v?.datetime);
    const o = Number(v?.open), h = Number(v?.high), l = Number(v?.low), c = Number(v?.close);
    const vol = v?.volume == null || v.volume === '' ? 0 : Number(v.volume);
    const ok = t != null && [o, h, l, c].every(x => Number.isFinite(x) && x > 0) && Number.isFinite(vol) && vol >= 0 &&
      h >= l && h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9;
    if (!ok) { invalid++; continue; }
    byTime.set(t, [t, o, h, l, c, vol]);
  }
  const rows = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  return { rows, invalid, duplicates: values.length - invalid - rows.length };
}

// ------------------------------------------------------------------ cache
const series = new Map();
const metaCache = new Map();
const symDir = s => path.join(ROOT, s);

function readMeta(symbol) {
  if (!metaCache.has(symbol)) {
    let m = { intervals: {} };
    try { m = JSON.parse(fs.readFileSync(path.join(symDir(symbol), 'meta.json'), 'utf8')); } catch { /* new */ }
    metaCache.set(symbol, m);
  }
  return metaCache.get(symbol);
}
function loadSeries(symbol, iv) {
  const key = `${symbol}|${iv}`;
  if (!series.has(key)) {
    let rows = [];
    try {
      const buf = fs.readFileSync(path.join(symDir(symbol), `${iv}.bin`));
      const f = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
      rows = new Array(f.length / COLS);
      for (let i = 0; i < rows.length; i++) rows[i] = Array.from(f.subarray(i * COLS, i * COLS + COLS));
    } catch { /* not cached yet */ }
    const meta = readMeta(symbol);
    meta.intervals[iv] ||= {};
    series.set(key, { symbol, iv, rows, info: meta.intervals[iv] });
  }
  return series.get(key);
}
async function persist(s) {
  const dir = symDir(s.symbol);
  await fsp.mkdir(dir, { recursive: true });
  const f = new Float64Array(s.rows.length * COLS);
  s.rows.forEach((r, i) => f.set(r, i * COLS));
  const file = path.join(dir, `${s.iv}.bin`);
  await fsp.writeFile(`${file}.tmp`, Buffer.from(f.buffer));
  await fsp.rename(`${file}.tmp`, file);
  Object.assign(s.info, { rows: s.rows.length, first: s.rows[0]?.[0] ?? null, last: s.rows.at(-1)?.[0] ?? null, updated: new Date().toISOString() });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(readMeta(s.symbol), null, 1));
}
function merge(s, rows) {
  if (!rows.length) return 0;
  const map = new Map(s.rows.map(r => [r[0], r]));
  const before = map.size;
  for (const r of rows) map.set(r[0], r);
  s.rows = [...map.values()].sort((a, b) => a[0] - b[0]);
  return map.size - before;
}
function lowerBound(rows, t) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; }
  return lo;
}

async function fetchSeries(symbol, iv, extra) {
  const body = await call('time_series', { symbol: tdSymbolOf(symbol), interval: iv, timezone: 'UTC', order: 'asc', outputsize: String(MAX_OUTPUT), ...extra });
  const res = cleanValues(body.values);
  if (res.invalid || res.duplicates) console.warn(`[twelvedata] ${symbol} ${iv}: dropped ${res.invalid} invalid and ${res.duplicates} duplicate candles`);
  return res.rows;
}

/** Fetch candles newer than the cache (or the latest 5000). Skipped while the cache is fresh. */
// Live chart refresh cadence per interval (each refresh costs one credit when the cache is older than this).
const LIVE_MAX_AGE = { '1min': 55e3, '5min': 60e3, '15min': 120e3, '30min': 180e3, '1h': 300e3, '2h': 600e3, '4h': 900e3 };
/**
 * Daily credit guard for automatic refreshes: Twelve Data reports the key's daily usage (free endpoint);
 * between checks our own request count is added. Live updates pause at 90% of the daily limit so manual
 * loads and history downloads still have credits.
 */
let usageSnap = null;
export function _resetUsageForTests() { usageSnap = null; }
export async function liveBudget() {
  try {
    if (!usageSnap || Date.now() - usageSnap.at > 5 * 60e3) {
      const u = await planInfo(true);
      usageSnap = { at: Date.now(), daily: Number(u.daily_usage) || 0, limit: Number(u.plan_daily_limit) || 800, base: stats.requests };
    }
  } catch { return { ok: true, used: null, limit: null }; }
  const used = usageSnap.daily + (stats.requests - usageSnap.base);
  return { ok: used < usageSnap.limit * 0.9, used, limit: usageSnap.limit };
}

async function refreshLatest(s, force = false, maxAgeOverride = null) {
  const sec = IV_SEC[s.iv];
  const maxAge = maxAgeOverride ?? Math.min(Math.max(sec * 500, 60e3), 15 * 60e3); // 1m→60s … 1h+→15 min
  if (!force && s.rows.length && s.info.fetchedAt && Date.now() - s.info.fetchedAt < maxAge) return;
  const extra = s.rows.length ? { start_date: fmtParam(s.rows.at(-1)[0]) } : {};
  const rows = await fetchSeries(s.symbol, s.iv, extra);
  merge(s, rows);
  s.info.fetchedAt = Date.now();
  if (!s.rows.length) throw new TdError(`Twelve Data returned no ${s.iv} candles for ${tdSymbolOf(s.symbol)}.`, 404, 'NO_DATA');
  await persist(s);
}

/** Earliest available candle for an interval (1 credit, cached). */
async function earliestOf(s) {
  if (s.info.earliest === undefined) {
    try {
      const r = await call('earliest_timestamp', { symbol: tdSymbolOf(s.symbol), interval: s.iv, timezone: 'UTC' });
      s.info.earliest = Number.isFinite(r.unix_time) ? r.unix_time : parseUtc(r.datetime);
    } catch (e) {
      if (e.status === 400 || e.status === 404) s.info.earliest = null; else throw e;
    }
    if (s.rows.length) await persist(s);
  }
  return s.info.earliest;
}

/** Download the next 5000 older candles. Returns how many were added (0 = start of history reached). */
async function extendBack(s) {
  if (s.info.complete) return 0;
  if (!s.rows.length) { await refreshLatest(s, true); return s.rows.length; }
  const first = s.rows[0][0];
  let added = 0;
  try {
    const older = (await fetchSeries(s.symbol, s.iv, { end_date: fmtParam(first) })).filter(r => r[0] < first);
    added = merge(s, older);
  } catch (e) {
    if (e.code !== 'NO_DATA') throw e;
  }
  if (!added || (s.info.earliest && s.rows[0][0] <= s.info.earliest)) s.info.complete = true;
  await persist(s);
  return added;
}

function intervalFor(tf) {
  const iv = TD_INTERVAL[tf];
  if (!iv) throw new TdError(`Twelve Data doesn't provide ${TF_LABEL[tf] || tf} candles. Use 1m, 5m, 15m, 30m, 1h, 2h, 4h, 1D, 1W or 1M.`, 400, 'TIMEFRAME');
  return iv;
}

/** Make sure the cache reaches back to `t`, downloading a bounded number of older batches. */
async function ensureBack(s, t, tf) {
  if (!s.rows.length) await refreshLatest(s);
  if (s.rows[0][0] <= t || s.info.complete) return;
  const earliest = await earliestOf(s);
  if (earliest != null && t < earliest) t = earliest;
  const needed = Math.ceil((s.rows[0][0] - t) / IV_SEC[s.iv] / MAX_OUTPUT);
  if (needed > AUTO_BACKFILL_REQUESTS) {
    throw new TdError(`Twelve Data ${TF_LABEL[tf]} candles are cached back to ${fmtDay(s.rows[0][0])}. Reaching ${fmtDay(t)} needs about ${needed} more requests — start a history download in Data → Twelve Data, or pick a later date.`, 409, 'INSUFFICIENT');
  }
  while (s.rows[0][0] > t && !s.info.complete) if (!(await extendBack(s))) break;
}

const toBar = r => [r[0], r[1], r[2], r[3], r[4], r[5], 0, r[0]];

// ------------------------------------------------------------------ market hours
// Twelve Data keeps publishing (near-flat) quotes while FX/metal/index markets are shut. Those candles aren't
// trading, so they're hidden when serving bars (the raw cache is kept as downloaded).
// Weekend: Friday 17:00 → Sunday 18:00 New York (DST-aware). Metals and index CFDs also pause daily 17:00–18:00.
function closedAt(t, dailyBreak) {
  const local = t + nyOffset(t);
  const dow = new Date(local * 1000).getUTCDay();
  const m = Math.floor((((local % 86400) + 86400) % 86400) / 60);
  if (dow === 6 || (dow === 5 && m >= 1020) || (dow === 0 && m < 1080)) return true;
  return dailyBreak && m >= 1020 && m < 1080;
}
/** True when the whole candle [t, t + sec) lies inside closed market hours. */
export function marketClosedBar(symbol, t, sec) {
  const spec = bySymbol[symbol];
  if (!spec || spec.session === 'crypto' || sec > 3 * 86400) return false;
  const dailyBreak = spec.type === 'metal' || spec.type === 'index';
  const step = Math.min(sec, 900);
  for (let x = t; x < t + sec; x += step) if (!closedAt(x, dailyBreak)) return false;
  return true;
}
const openRows = (symbol, iv, rows) => rows.filter(r => !marketClosedBar(symbol, r[0], IV_SEC[iv]));

/** Same contract as storage.getBars: latest, before (exclusive) or after (inclusive) a time. */
/** When an interval's cached candles were last refreshed (ms since epoch), or null. */
export function tdFetchedAt(symbol, tf) { return loadSeries(symbol, intervalFor(tf)).info.fetchedAt || null; }

/**
 * Candles for alerts that check closed bars: refreshes (1 credit) only once the cached forming candle should have
 * closed, at most every 15 minutes while no new candle arrives (market closed), and never past the daily credit guard.
 */
const closedTry = new Map();
export async function tdClosedBars(symbol, tf, limit = 400) {
  const iv = intervalFor(tf), s = loadSeries(symbol, iv), sec = IV_SEC[iv], now = Date.now();
  const last = s.rows.at(-1)?.[0] ?? null, k = `${symbol}|${iv}`, tried = closedTry.get(k);
  const due = last == null || (last + sec) * 1000 + 5000 <= now;
  if (due && !(tried && tried.last === last && now - tried.at < 15 * 60e3)) {
    const budget = await liveBudget();
    if (budget.ok) {
      closedTry.set(k, { last, at: now });
      await ensureAccess(symbol);
      await refreshLatest(s, true);
    }
  }
  return openRows(symbol, iv, s.rows.slice(-limit)).map(toBar);
}

export async function tdGetBars(symbol, tf, { before = null, after = null, limit = 1000, cacheOnly = false, live = false, streaming = false } = {}) {
  const iv = intervalFor(tf);
  limit = Math.max(1, Math.min(limit || 1000, 20000));
  if (cacheOnly) { // watchlist/quotes: whatever is already on disk, never an API call
    const rows = openRows(symbol, iv, loadSeries(symbol, iv).rows.slice(-limit));
    return { bars: rows.map(toBar), hasMoreBefore: false, hasMoreAfter: false, source: 'twelvedata', cacheOnly: true };
  }
  await ensureAccess(symbol);
  const s = loadSeries(symbol, iv);
  if (before == null && after == null) {
    let throttled = false, budget = null;
    if (live) {
      // automatic chart refresh: interval-specific cadence, paused near the daily credit limit
      budget = await liveBudget();
      // while the WebSocket stream moves the price, these polls only true up the candles: every 5 minutes at most
      if (budget.ok) await refreshLatest(s, false, Math.max(LIVE_MAX_AGE[iv] ?? 15 * 60e3, streaming ? 300e3 : 0));
      else throttled = true;
    } else await refreshLatest(s);
    const rows = openRows(symbol, iv, s.rows.slice(-limit));
    return {
      bars: rows.map(toBar), hasMoreBefore: s.rows.length > limit || !s.info.complete, hasMoreAfter: false, source: 'twelvedata',
      fetchedAt: s.info.fetchedAt || null, throttled, credits: budget && budget.used != null ? { used: budget.used, limit: budget.limit } : null,
    };
  }
  if (before != null) {
    if (!s.rows.length) await refreshLatest(s);
    if (before <= s.rows[0][0]) await ensureBack(s, before - IV_SEC[iv] * limit, tf);
    let idx = lowerBound(s.rows, before);
    for (let i = 0; idx < limit && !s.info.complete && i < 2; i++) { if (!(await extendBack(s))) break; idx = lowerBound(s.rows, before); }
    const start = Math.max(0, idx - limit);
    return { bars: openRows(symbol, iv, s.rows.slice(start, idx)).map(toBar), hasMoreBefore: start > 0 || !s.info.complete, hasMoreAfter: idx < s.rows.length, source: 'twelvedata' };
  }
  await ensureBack(s, after, tf);
  if (after > s.rows.at(-1)[0]) await refreshLatest(s);
  const i = lowerBound(s.rows, after);
  const rows = openRows(symbol, iv, s.rows.slice(i, i + limit));
  return { bars: rows.map(toBar), hasMoreBefore: i > 0 || !s.info.complete, hasMoreAfter: i + limit < s.rows.length, source: 'twelvedata' };
}

// ------------------------------------------------------------------ replay support (cache only, no API calls)
const FILL_INTERVALS = ['1min', '5min', '15min', '30min', '1h', '2h', '4h', '1day'];

/** Finest cached interval whose candles cover [from, to). */
function coveringSeries(symbol, from, to) {
  const now = Date.now() / 1000;
  for (const iv of FILL_INTERVALS) {
    if (IV_SEC[iv] > to - from) break;
    const s = loadSeries(symbol, iv);
    if (s.rows.length && s.rows[0][0] <= from && s.rows.at(-1)[0] + IV_SEC[iv] >= Math.min(to, now)) return s;
  }
  return null;
}

/** Real candles lying entirely inside [from, to), at the finest cached resolution — used for replay fills. */
export function tdFillBars(symbol, from, to) {
  const s = coveringSeries(symbol, from, to);
  if (!s) return [];
  const sec = IV_SEC[s.iv];
  const out = [];
  for (let i = lowerBound(s.rows, from); i < s.rows.length && s.rows[i][0] + sec <= to; i++) {
    const r = s.rows[i];
    if (marketClosedBar(symbol, r[0], sec)) continue;
    out.push({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], spread: 0, seconds: sec });
  }
  return out;
}

/** OHLC of [from, to) built from finer cached candles; null if none fit (the forming bar is then hidden). */
export function tdRangeOhlc(symbol, from, to) {
  const bars = tdFillBars(symbol, from, to);
  if (!bars.length) return null;
  return {
    open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), close: bars.at(-1).close,
    volume: bars.reduce((a, b) => a + b.volume, 0), spread: 0, first: bars[0].time, last: bars.at(-1).time, count: bars.length,
  };
}

// ------------------------------------------------------------------ status, ranges, maintenance
export function tdCoverage(symbol) {
  let first = null, last = null, rows = 0;
  for (const iv of Object.keys(IV_SEC)) {
    const s = loadSeries(symbol, iv);
    if (!s.rows.length) continue;
    first = first == null ? s.rows[0][0] : Math.min(first, s.rows[0][0]);
    last = last == null ? s.rows.at(-1)[0] : Math.max(last, s.rows.at(-1)[0]);
    rows += s.rows.length;
  }
  return { first, last, rows };
}

/** Available history for one timeframe: what's cached plus Twelve Data's earliest candle (1 credit, cached). */
export async function tdRange(symbol, tf) {
  const iv = intervalFor(tf);
  await ensureAccess(symbol);
  const s = loadSeries(symbol, iv);
  if (!s.rows.length) await refreshLatest(s);
  const earliest = await earliestOf(s);
  return { tf, interval: iv, earliest, cachedFirst: s.rows[0]?.[0] ?? null, cachedLast: s.rows.at(-1)?.[0] ?? null, complete: !!s.info.complete };
}

export async function tdStatus(symbol, { probe = false } = {}) {
  const out = { configured: keyConfigured(), symbol, td: tdSymbolOf(symbol), source: sourceOf(symbol), limiter: limiterState(), requests: stats.requests, rateLimitWaits: stats.rateLimitWaits };
  out.intervals = Object.entries(TD_INTERVAL).map(([tf, iv]) => {
    const s = loadSeries(symbol, iv);
    return { tf, interval: iv, rows: s.rows.length, first: s.rows[0]?.[0] ?? null, last: s.rows.at(-1)?.[0] ?? null, earliest: s.info.earliest ?? null, complete: !!s.info.complete, fetchedAt: s.info.fetchedAt ?? null };
  });
  if (out.configured && out.td) {
    try { out.plan = await planInfo(probe); } catch (e) { out.planError = e.message; }
    try { out.access = await symbolAccess(symbol, probe); } catch (e) { out.accessError = e.message; }
  }
  return out;
}

export async function tdClearCache(symbol, tf = null) {
  const ivs = tf ? [intervalFor(tf)] : Object.keys(IV_SEC);
  for (const iv of ivs) {
    series.delete(`${symbol}|${iv}`);
    delete readMeta(symbol).intervals[iv];
    await fsp.rm(path.join(symDir(symbol), `${iv}.bin`), { force: true });
  }
  await fsp.mkdir(symDir(symbol), { recursive: true });
  await fsp.writeFile(path.join(symDir(symbol), 'meta.json'), JSON.stringify(readMeta(symbol), null, 1));
}

/** Background history download: up to `requests` older batches of 5000 candles. */
export async function tdDownloadHistory(job) {
  const iv = intervalFor(job.tf);
  await ensureAccess(job.symbol);
  const s = loadSeries(job.symbol, iv);
  if (!s.rows.length) await refreshLatest(s, true);
  await earliestOf(s);
  job.total = job.requests;
  for (let i = 0; i < job.requests && !job.cancelRequested; i++) {
    const w = limiter.waitingUntil;
    job.message = w ? `Waiting for Twelve Data rate limit (${Math.ceil((w - Date.now()) / 1000)}s)…` : `Downloading batch ${i + 1}/${job.requests}…`;
    const added = await extendBack(s);
    job.done = i + 1;
    job.rows += added;
    job.message = `Cached back to ${fmtDay(s.rows[0][0])} (${s.rows.length.toLocaleString('en-US')} candles)`;
    if (!added) { job.message = `Reached the start of Twelve Data history: ${fmtDay(s.rows[0][0])}`; job.total = job.done; break; }
  }
}
