// Local market-data cache.
//
// data/market/<SYMBOL>/m1/<YYYY-MM>.bin  genuine 1-minute bars (bid OHLC), Float64 rows of
//                                        [time, open, high, low, close, volume, spread]
// data/market/<SYMBOL>/h1/<YYYY-MM>.bin  hourly bars derived from the m1 file (identical maths, 60x smaller),
//                                        used for >=1h timeframes so years of daily/weekly bars load instantly
// data/market/<SYMBOL>/meta.json         which months exist and where they came from
//
// Binary Float64 keeps reads fast (one Buffer → typed array) — a full year of minutes is ~20 MB.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TF, aggregate } from '../public/js/core/sessions.js';
import { bySymbol } from './catalog.js';

const COLS = 7;
export const DATA_DIR = path.resolve(process.env.CHARTDESK_DATA || path.join(import.meta.dirname, '..', 'data'));
const MARKET = path.join(DATA_DIR, 'market');

const symDir = s => path.join(MARKET, s);
const fileOf = (s, base, ym) => path.join(symDir(s), base, `${ym}.bin`);

export const ymOf = t => new Date(t * 1000).toISOString().slice(0, 7);
export function nextYm(ym, delta = 1) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// ------------------------------------------------------------------ small LRU
class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) { this.map.delete(k); this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  deleteWhere(fn) { for (const k of [...this.map.keys()]) if (fn(k)) this.map.delete(k); }
}
const monthCache = new LRU(60);     // `${sym}|${base}|${ym}` → rows
const aggMonthCache = new LRU(400); // `${sym}|${tf}|${ym}` → aggregated rows
const seriesCache = new LRU(40);    // `${sym}|${tf}` → aggregated full series (h1-based tfs)

// ------------------------------------------------------------------ meta
const metaCache = new Map();
export function readMeta(symbol) {
  if (metaCache.has(symbol)) return metaCache.get(symbol);
  let meta = { months: {} };
  try { meta = JSON.parse(fs.readFileSync(path.join(symDir(symbol), 'meta.json'), 'utf8')); } catch { /* none yet */ }
  metaCache.set(symbol, meta);
  return meta;
}
async function writeMeta(symbol, meta) {
  metaCache.set(symbol, meta);
  await fsp.mkdir(symDir(symbol), { recursive: true });
  await atomicWrite(path.join(symDir(symbol), 'meta.json'), JSON.stringify(meta, null, 1));
}
async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export function months(symbol) { return Object.keys(readMeta(symbol).months).sort(); }

export function coverage(symbol) {
  const meta = readMeta(symbol);
  const list = Object.keys(meta.months).sort();
  return {
    symbol,
    months: list.map(ym => ({ ym, ...meta.months[ym] })),
    first: list.length ? meta.months[list[0]].first : null,
    last: list.length ? meta.months[list[list.length - 1]].last : null,
  };
}

// ------------------------------------------------------------------ read/write month files
function decode(buf) {
  const f = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const rows = new Array(f.length / COLS);
  for (let i = 0, j = 0; i < rows.length; i++, j += COLS) rows[i] = [f[j], f[j + 1], f[j + 2], f[j + 3], f[j + 4], f[j + 5], f[j + 6]];
  return rows;
}
function encode(rows) {
  const f = new Float64Array(rows.length * COLS);
  rows.forEach((r, i) => { for (let c = 0; c < COLS; c++) f[i * COLS + c] = r[c] ?? 0; });
  return Buffer.from(f.buffer);
}

export function readMonth(symbol, base, ym) {
  const key = `${symbol}|${base}|${ym}`;
  let rows = monthCache.get(key);
  if (rows) return rows;
  try { rows = decode(fs.readFileSync(fileOf(symbol, base, ym))); } catch { rows = []; }
  monthCache.set(key, rows);
  return rows;
}

/**
 * Merge 1-minute rows into the cache (rows may span several months). Newer rows replace older ones with
 * the same timestamp. `spreadOnly` updates only the spread column of existing minutes (ask-side CSV).
 */
export async function writeMinutes(symbol, rows, { source, spreadOnly = false } = {}) {
  const spec = bySymbol[symbol];
  const byMonth = new Map();
  for (const r of rows) {
    const ym = ymOf(r[0]);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(r);
  }
  const meta = readMeta(symbol);
  let written = 0;
  for (const [ym, incoming] of byMonth) {
    const existing = readMonth(symbol, 'm1', ym);
    const map = new Map(existing.map(r => [r[0], r]));
    for (const r of incoming) {
      if (spreadOnly) {
        const cur = map.get(r[0]);
        if (cur) { cur[6] = r[6]; written++; }
      } else {
        const prev = map.get(r[0]);
        // Keep a measured spread if the new row has none (e.g. bid-only CSV over S3 data).
        if (prev && !(r[6] > 0) && prev[6] > 0) r[6] = prev[6];
        map.set(r[0], r);
        written++;
      }
    }
    const merged = [...map.values()].sort((a, b) => a[0] - b[0]);
    if (!merged.length) continue;
    await fsp.mkdir(path.dirname(fileOf(symbol, 'm1', ym)), { recursive: true });
    await fsp.mkdir(path.dirname(fileOf(symbol, 'h1', ym)), { recursive: true });
    await atomicWrite(fileOf(symbol, 'm1', ym), encode(merged));
    const hourly = aggregate(merged, '1h', spec?.session || 'fx').map(r => r.slice(0, 7));
    await atomicWrite(fileOf(symbol, 'h1', ym), encode(hourly));
    const sources = new Set([...(meta.months[ym]?.sources || []), source].filter(Boolean));
    meta.months[ym] = {
      rows: merged.length, first: merged[0][0], last: merged[merged.length - 1][0],
      withSpread: merged.filter(r => r[6] > 0).length, sources: [...sources], updated: new Date().toISOString(),
    };
    monthCache.set(`${symbol}|m1|${ym}`, merged);
    monthCache.set(`${symbol}|h1|${ym}`, hourly);
  }
  await writeMeta(symbol, meta);
  invalidate(symbol);
  return written;
}

export async function deleteMonths(symbol, list) {
  const meta = readMeta(symbol);
  for (const ym of list) {
    for (const base of ['m1', 'h1']) await fsp.rm(fileOf(symbol, base, ym), { force: true });
    delete meta.months[ym];
    monthCache.deleteWhere(k => k.startsWith(`${symbol}|`) && k.endsWith(`|${ym}`));
  }
  await writeMeta(symbol, meta);
  invalidate(symbol);
}

function invalidate(symbol) {
  aggMonthCache.deleteWhere(k => k.startsWith(`${symbol}|`));
  seriesCache.deleteWhere(k => k.startsWith(`${symbol}|`));
}

// ------------------------------------------------------------------ queries
function monthAggregate(symbol, tf, ym, session) {
  const key = `${symbol}|${tf}|${ym}`;
  let rows = aggMonthCache.get(key);
  if (!rows) {
    const m1 = readMonth(symbol, 'm1', ym);
    rows = tf === '1m' ? m1.map(r => [...r, r[0]]) : aggregate(m1, tf, session);
    aggMonthCache.set(key, rows);
  }
  return rows;
}

function hourlySeries(symbol, tf, session) {
  const key = `${symbol}|${tf}`;
  let rows = seriesCache.get(key);
  if (!rows) {
    const h1 = [];
    for (const ym of months(symbol)) for (const r of readMonth(symbol, 'h1', ym)) h1.push(r);
    rows = tf === '1h' ? h1.map(r => [...r, r[0]]) : aggregate(h1, tf, session);
    seriesCache.set(key, rows);
  }
  return rows;
}

/**
 * Bars for a timeframe. `before` (exclusive) returns the last `limit` bars with time < before;
 * `after` (inclusive, by bar start) returns the first `limit` bars starting at/after it.
 */
export function getBars(symbol, tf, { before, after, limit = 1000 } = {}) {
  const spec = TF[tf];
  if (!spec) throw new Error(`Unsupported timeframe ${tf}`);
  const session = bySymbol[symbol]?.session || 'fx';
  limit = Math.max(1, Math.min(limit, 20000));
  const list = months(symbol);
  if (!list.length) return { bars: [], hasMoreBefore: false, hasMoreAfter: false };

  if (spec.base === 'h1') {
    const all = hourlySeries(symbol, tf, session);
    if (after != null) {
      let i = lowerBound(all, after, 7);
      const bars = all.slice(i, i + limit);
      return { bars, hasMoreBefore: i > 0, hasMoreAfter: i + limit < all.length };
    }
    const end = before != null ? lowerBound(all, before, 0) : all.length;
    const start = Math.max(0, end - limit);
    return { bars: all.slice(start, end), hasMoreBefore: start > 0, hasMoreAfter: end < all.length };
  }

  const bars = [];
  if (after != null) {
    let idx = list.findIndex(ym => ym >= ymOf(after));
    if (idx < 0) return { bars: [], hasMoreBefore: true, hasMoreAfter: false };
    for (; idx < list.length && bars.length < limit; idx++) {
      for (const r of monthAggregate(symbol, tf, list[idx], session)) {
        if (r[7] >= after) { bars.push(r); if (bars.length >= limit) break; }
      }
    }
    const lastT = bars.length ? bars[bars.length - 1][0] : after;
    return { bars, hasMoreBefore: true, hasMoreAfter: list[list.length - 1] > ymOf(lastT) || bars.length >= limit };
  }
  let idx = before != null ? findLastIndex(list, ym => ym <= ymOf(before - 1)) : list.length - 1;
  const chunks = [];
  let count = 0;
  for (; idx >= 0 && count < limit; idx--) {
    let rows = monthAggregate(symbol, tf, list[idx], session);
    if (before != null) rows = rows.slice(0, lowerBound(rows, before, 0));
    chunks.unshift(rows);
    count += rows.length;
  }
  for (const c of chunks) for (const r of c) bars.push(r);
  const out = bars.slice(Math.max(0, bars.length - limit));
  return { bars: out, hasMoreBefore: idx >= 0 || bars.length > limit, hasMoreAfter: before != null && list[list.length - 1] >= ymOf(before) };
}

/** OHLC of all minutes in [from, to) — used to build the forming bar during replay. */
export function rangeOhlc(symbol, from, to) {
  let o = null, hi = -Infinity, lo = Infinity, c = null, v = 0, s = 0, n = 0, first = null, last = null;
  for (let ym = ymOf(from); ym <= ymOf(to - 1); ym = nextYm(ym)) {
    for (const r of readMonth(symbol, 'm1', ym)) {
      if (r[0] < from || r[0] >= to) continue;
      if (o === null) { o = r[1]; first = r[0]; }
      if (r[2] > hi) hi = r[2];
      if (r[3] < lo) lo = r[3];
      c = r[4]; v += r[5]; s += r[6]; n++; last = r[0];
    }
  }
  return n ? { open: o, high: hi, low: lo, close: c, volume: v, spread: s / n, first, last, count: n } : null;
}

function lowerBound(rows, value, col) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][col] < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function findLastIndex(arr, fn) { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; }
