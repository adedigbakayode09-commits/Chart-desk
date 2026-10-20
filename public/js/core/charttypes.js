// Price-based chart types (pure, no DOM): Renko, Kagi, Point & Figure, Line Break and Range bars.
// Each turns time-based candles into its own series of "bars" { time, start, open, high, low, close, volume }
// so the chart, indicators and legend can treat them like candles. A new box/line/column takes the time of the
// candle that completed it; several formed by one candle get consecutive seconds (chart times must increase).

import { atr } from './indicators.js';
import { pricePath } from './broker.js';

export const PRICE_TYPES = {
  renko: { label: 'Renko', method: 'atr', atrLength: 14, value: 0, source: 'close' },
  kagi: { label: 'Kagi', method: 'atr', atrLength: 14, value: 0 },
  pnf: { label: 'Point & Figure', method: 'atr', atrLength: 14, value: 0, reversal: 3 },
  linebreak: { label: 'Line break', lines: 3 },
  range: { label: 'Range', method: 'atr', atrLength: 14, value: 0 },
};
export const isPriceType = t => t in PRICE_TYPES;

/** Box size / reversal amount: the last ATR of the candles, a fixed price amount, or a % of the last close. */
export function boxSize(bars, opts) {
  if (!bars.length) return 0;
  const last = bars[bars.length - 1].close;
  if (opts.method === 'fixed' && opts.value > 0) return opts.value;
  if (opts.method === 'pct' && opts.value > 0) return last * opts.value / 100;
  const a = atr(bars, Math.max(2, opts.atrLength || 14));
  let v = null;
  for (let i = a.length - 1; i >= 0 && v == null; i--) v = a[i];
  return niceStep(v || last * 0.005);
}
/** Round a box size to 1, 2 or 5 × a power of ten (like TradingView's ATR boxes, keeps levels readable). */
function niceStep(v) {
  if (!(v > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

const round = v => Math.round(v * 1e10) / 1e10;

/** Collects output bars with strictly increasing times and the volume traded since the previous bar. */
function emitter() {
  const out = [];
  let lastT = -Infinity, vol = 0;
  return {
    out,
    addVolume(v) { vol += v || 0; },
    takeVolume() { const v = vol; vol = 0; return v; },
    push(src, o, c, extra = {}) {
      const t = Math.max(src.time, lastT + 1);
      lastT = t;
      out.push({ time: t, start: src.start ?? src.time, open: round(o), high: round(Math.max(o, c)), low: round(Math.min(o, c)), close: round(c), volume: vol, ...extra });
      vol = 0;
      return out[out.length - 1];
    },
  };
}

/** Traditional Renko: a box forms when price closes a full box beyond the last one (reversals need two boxes). */
export function renko(bars, box, source = 'close') {
  const em = emitter();
  if (!bars.length || !(box > 0)) return em.out;
  let hi = bars[0].close, lo = hi;
  for (const b of bars) {
    em.addVolume(b.volume);
    const prices = source === 'hl' ? (b.close >= b.open ? [b.low, b.high] : [b.high, b.low]) : [b.close];
    for (const p of prices) {
      while (p >= hi + box) { em.push(b, hi, hi + box); lo = hi; hi = round(hi + box); }
      while (p <= lo - box) { em.push(b, lo, lo - box); hi = lo; lo = round(lo - box); }
    }
  }
  return em.out;
}

/**
 * Kagi: the line keeps going while price extends it and turns when price reverses by `rev`. It is drawn as a step
 * line through each turn; `yang` marks thick (bullish) lines — above the previous shoulder — and thin ones below the previous waist.
 */
export function kagi(bars, rev) {
  const em = emitter();
  if (!bars.length || !(rev > 0)) return em.out;
  let dir = 0, ref = bars[0].close, cur = null, yang = true, shoulder = null, waist = null;
  em.push(bars[0], ref, ref, { yang });
  for (const b of bars.slice(1)) {
    em.addVolume(b.volume);
    const p = b.close;
    if (dir === 0) {
      if (Math.abs(p - ref) >= rev) { dir = p > ref ? 1 : -1; cur = em.push(b, ref, p, { yang }); }
      continue;
    }
    const ext = cur.close;
    if ((dir > 0 && p > ext) || (dir < 0 && p < ext)) { // the line extends
      cur.close = round(p); cur.high = Math.max(cur.open, cur.close); cur.low = Math.min(cur.open, cur.close); cur.volume += em.takeVolume();
    } else if ((dir > 0 && p <= ext - rev) || (dir < 0 && p >= ext + rev)) { // reversal: a new line
      if (dir > 0) shoulder = ext; else waist = ext;
      dir = -dir;
      cur = em.push(b, ext, p, { yang });
    } else continue;
    if (shoulder != null && cur.close > shoulder) yang = true;
    if (waist != null && cur.close < waist) yang = false;
    cur.yang = yang;
  }
  return em.out;
}

/**
 * Point & Figure (closing prices): X columns rise box by box, O columns fall; a new column needs a `reversal`-box move.
 * Each column is a bar from its lowest to its highest box edge (open < close for X, open > close for O).
 */
export function pointFigure(bars, box, reversal = 3) {
  const em = emitter();
  if (!bars.length || !(box > 0)) return em.out;
  const fl = p => round(Math.floor(p / box + 1e-9) * box), ce = p => round(Math.ceil(p / box - 1e-9) * box);
  const ref = bars[0].close;
  let col = null;
  for (const b of bars) {
    em.addVolume(b.volume);
    const p = b.close;
    if (!col) {
      if (fl(p) >= fl(ref) + box) col = em.push(b, fl(ref), fl(p), { x: true });
      else if (ce(p) <= ce(ref) - box) col = em.push(b, ce(ref), ce(p), { x: false });
      continue;
    }
    if (col.x) {
      if (fl(p) > col.high) { col.high = col.close = fl(p); col.volume += em.takeVolume(); }
      else if (ce(p) <= col.high - box - reversal * box) col = em.push(b, round(col.high - box), ce(p), { x: false });
    } else {
      if (ce(p) < col.low) { col.low = col.close = ce(p); col.volume += em.takeVolume(); }
      else if (fl(p) >= col.low + box + reversal * box) col = em.push(b, round(col.low + box), fl(p), { x: true });
    }
  }
  return em.out;
}

/** N-line break: a new line in the same direction on a new extreme close; a reversal must break the last N lines. */
export function lineBreak(bars, n = 3) {
  const em = emitter(), L = em.out;
  if (!bars.length) return L;
  const ref = bars[0].close;
  for (const b of bars) {
    em.addVolume(b.volume);
    const p = b.close;
    if (!L.length) { if (p !== ref) em.push(b, ref, p); continue; }
    const last = L[L.length - 1], up = last.close > last.open;
    const recent = L.slice(-n);
    if (up) {
      if (p > last.close) em.push(b, last.close, p);
      else if (p < Math.min(...recent.map(l => l.low))) em.push(b, last.open, p);
    } else {
      if (p < last.close) em.push(b, last.close, p);
      else if (p > Math.max(...recent.map(l => l.high))) em.push(b, last.open, p);
    }
  }
  return L;
}

/** Range bars: every bar spans exactly `range` from high to low; built along each candle's open→high/low→close path. */
export function rangeBars(bars, range) {
  const out = [];
  if (!bars.length || !(range > 0)) return out;
  let lastT = -Infinity, cur = null;
  const open = (src, p) => {
    const t = Math.max(src.time, lastT + 1);
    lastT = t;
    cur = { time: t, start: src.start ?? src.time, open: p, high: p, low: p, close: p, volume: 0, partial: true };
    out.push(cur);
  };
  open(bars[0], bars[0].open);
  for (const b of bars) {
    const path = pricePath(b);
    cur.volume += b.volume || 0;
    for (const p of path) {
      for (let guard = 0; guard < 10000; guard++) {
        if (p > cur.low + range) {
          cur.high = cur.close = round(cur.low + range); cur.partial = false;
          open(b, cur.high);
        } else if (p < cur.high - range) {
          cur.low = cur.close = round(cur.high - range); cur.partial = false;
          open(b, cur.low);
        } else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; break; }
      }
    }
  }
  return out;
}

/** Transform candles for a price-based chart type. Returns { bars, box } (box = size used, for the legend). */
/** `opts.box` (when > 0) pins the box size, so live updates don't resize the boxes. */
export function transform(type, bars, opts = {}) {
  const o = { ...PRICE_TYPES[type], ...opts };
  const box = type === 'linebreak' ? null : o.box > 0 ? o.box : boxSize(bars, o);
  switch (type) {
    case 'renko': return { bars: renko(bars, box, o.source), box };
    case 'kagi': return { bars: kagi(bars, box), box };
    case 'pnf': return { bars: pointFigure(bars, box, Math.max(1, Math.round(o.reversal || 3))), box };
    case 'linebreak': return { bars: lineBreak(bars, Math.max(1, Math.round(o.lines || 3))), box: null };
    case 'range': return { bars: rangeBars(bars, box), box };
  }
  return { bars, box: null };
}
