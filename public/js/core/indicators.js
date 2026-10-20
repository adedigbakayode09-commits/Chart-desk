// Pure indicator maths (no DOM). Inputs are arrays; outputs are arrays aligned to the input with null
// during warm-up. Bars are { time, open, high, low, close, volume }.

import { sessionDay } from './sessions.js';

export function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let s = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null) { s = 0; cnt = 0; continue; }
    s += a[i]; cnt++;
    if (cnt > n) { s -= a[i - n]; cnt = n; }
    if (cnt === n) out[i] = s / n;
  }
  return out;
}

export function ema(a, n) {
  const out = new Array(a.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, s = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) continue;
    if (prev == null) {
      s += v; cnt++;
      if (cnt === n) { prev = s / n; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's smoothing (RSI / ATR). */
export function rma(a, n) {
  const out = new Array(a.length).fill(null);
  let prev = null, s = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) continue;
    if (prev == null) { s += v; cnt++; if (cnt === n) { prev = s / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + v) / n; out[i] = prev; }
  }
  return out;
}

export function stdev(a, n, mean = sma(a, n)) {
  return a.map((_, i) => {
    if (mean[i] == null) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (a[j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

export function rsi(closes, n) {
  const up = closes.map((c, i) => (i ? Math.max(c - closes[i - 1], 0) : null));
  const dn = closes.map((c, i) => (i ? Math.max(closes[i - 1] - c, 0) : null));
  const g = rma(up, n), l = rma(dn, n);
  return g.map((v, i) => (v == null ? null : l[i] === 0 ? 100 : 100 - 100 / (1 + v / l[i])));
}

export function macd(closes, fast, slow, signal) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  return { line, signal: sig, hist };
}

export function trueRange(bars) {
  return bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low));
}
export const atr = (bars, n) => rma(trueRange(bars), n);

export function bollinger(closes, n, mult) {
  const mid = sma(closes, n), sd = stdev(closes, n, mid);
  return {
    mid,
    upper: mid.map((v, i) => (v == null ? null : v + mult * sd[i])),
    lower: mid.map((v, i) => (v == null ? null : v - mult * sd[i])),
  };
}

export function stoch(bars, k, smooth, d) {
  const raw = bars.map((b, i) => {
    if (i < k - 1) return null;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    return hh === ll ? 50 : ((b.close - ll) / (hh - ll)) * 100;
  });
  const K = sma(raw, smooth);
  return { k: K, d: sma(K, d) };
}

/** Highest high / lowest low of the previous n bars (excluding the current bar). */
export function donchian(bars, n) {
  const upper = new Array(bars.length).fill(null), lower = new Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n; j < i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    upper[i] = hh; lower[i] = ll;
  }
  return { upper, lower };
}

/** Session VWAP: resets at each trading-day rollover (17:00 New York for FX/CFD, UTC midnight for crypto). */
export function vwap(bars, session = 'fx') {
  const out = new Array(bars.length).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = sessionDay(b.start ?? b.time, session);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0); vol += b.volume || 0;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

// ------------------------------------------------------------------ more moving averages
export function wma(a, n) {
  const out = new Array(a.length).fill(null), den = n * (n + 1) / 2;
  for (let i = n - 1; i < a.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) { const v = a[i - j]; if (v == null) { ok = false; break; } s += v * (n - j); }
    if (ok) out[i] = s / den;
  }
  return out;
}
/** Hull moving average: WMA(2·WMA(n/2) − WMA(n), √n). */
export function hma(a, n) {
  const half = wma(a, Math.max(1, Math.round(n / 2))), full = wma(a, n);
  const diff = half.map((v, i) => (v == null || full[i] == null ? null : 2 * v - full[i]));
  return wma(diff, Math.max(1, Math.round(Math.sqrt(n))));
}
export function vwma(bars, n) {
  const out = new Array(bars.length).fill(null);
  let pv = 0, v = 0;
  for (let i = 0; i < bars.length; i++) {
    pv += bars[i].close * (bars[i].volume || 0); v += bars[i].volume || 0;
    if (i >= n) { pv -= bars[i - n].close * (bars[i - n].volume || 0); v -= bars[i - n].volume || 0; }
    if (i >= n - 1) out[i] = v > 0 ? pv / v : sma(bars.slice(i - n + 1, i + 1).map(b => b.close), n)[n - 1];
  }
  return out;
}

const highest = (a, i, n) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, a[j]); return m; };
const lowest = (a, i, n) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, a[j]); return m; };

// ------------------------------------------------------------------ trend
/** Supertrend: ATR bands around hl2 that flip with the close. Returns { line, dir } (dir 1 = up trend). */
export function supertrend(bars, n = 10, mult = 3) {
  const a = atr(bars, n), line = new Array(bars.length).fill(null), dir = new Array(bars.length).fill(null);
  let up = null, dn = null, d = 1;
  for (let i = 0; i < bars.length; i++) {
    if (a[i] == null) continue;
    const b = bars[i], hl2 = (b.high + b.low) / 2, prevClose = i ? bars[i - 1].close : b.close;
    let u = hl2 - mult * a[i], l = hl2 + mult * a[i];
    if (up != null && prevClose > up) u = Math.max(u, up);
    if (dn != null && prevClose < dn) l = Math.min(l, dn);
    if (up != null && dn != null) d = d === -1 && b.close > dn ? 1 : d === 1 && b.close < up ? -1 : d;
    up = u; dn = l;
    dir[i] = d; line[i] = d === 1 ? up : dn;
  }
  return { line, dir };
}

/** Parabolic SAR. */
export function psar(bars, start = 0.02, inc = 0.02, max = 0.2) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < 2) return out;
  let long = bars[1].close >= bars[0].close, af = start;
  let ep = long ? Math.max(bars[0].high, bars[1].high) : Math.min(bars[0].low, bars[1].low);
  let sar = long ? Math.min(bars[0].low, bars[1].low) : Math.max(bars[0].high, bars[1].high);
  out[1] = sar;
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i];
    sar = sar + af * (ep - sar);
    if (long) {
      sar = Math.min(sar, bars[i - 1].low, bars[i - 2].low);
      if (b.low < sar) { long = false; sar = ep; ep = b.low; af = start; }
      else if (b.high > ep) { ep = b.high; af = Math.min(max, af + inc); }
    } else {
      sar = Math.max(sar, bars[i - 1].high, bars[i - 2].high);
      if (b.high > sar) { long = true; sar = ep; ep = b.high; af = start; }
      else if (b.low < ep) { ep = b.low; af = Math.min(max, af + inc); }
    }
    out[i] = sar;
  }
  return out;
}

/** Ichimoku: conversion, base, lagging span (shifted back) and the two leading spans (shifted forward by `disp`). */
export function ichimoku(bars, conv = 9, base = 26, spanB = 52, disp = 26) {
  const H = bars.map(b => b.high), L = bars.map(b => b.low), n = bars.length;
  const mid = (i, p) => (i >= p - 1 ? (highest(H, i, p) + lowest(L, i, p)) / 2 : null);
  const tenkan = bars.map((_, i) => mid(i, conv)), kijun = bars.map((_, i) => mid(i, base));
  const a = tenkan.map((v, i) => (v == null || kijun[i] == null ? null : (v + kijun[i]) / 2)), b = bars.map((_, i) => mid(i, spanB));
  // leading spans are plotted disp−1 bars ahead (TradingView offset), the lagging span disp−1 bars back
  const shift = disp - 1;
  const leadA = new Array(n + shift).fill(null), leadB = new Array(n + shift).fill(null), lag = new Array(n).fill(null);
  for (let i = 0; i < n; i++) { leadA[i + shift] = a[i]; leadB[i + shift] = b[i]; if (i - shift >= 0) lag[i - shift] = bars[i].close; }
  return { tenkan, kijun, lag, leadA, leadB, shift };
}

/** Keltner channel: EMA ± mult × ATR. */
export function keltner(bars, n = 20, mult = 2, atrLen = 10) {
  const mid = ema(bars.map(b => b.close), n), a = atr(bars, atrLen);
  return { mid, upper: mid.map((v, i) => (v == null || a[i] == null ? null : v + mult * a[i])), lower: mid.map((v, i) => (v == null || a[i] == null ? null : v - mult * a[i])) };
}
/** Donchian channel including the current bar (TradingView's DC). */
export function donchianChannel(bars, n = 20) {
  const H = bars.map(b => b.high), L = bars.map(b => b.low);
  const upper = bars.map((_, i) => (i >= n - 1 ? highest(H, i, n) : null)), lower = bars.map((_, i) => (i >= n - 1 ? lowest(L, i, n) : null));
  return { upper, lower, basis: upper.map((v, i) => (v == null ? null : (v + lower[i]) / 2)) };
}

/**
 * Pivot points from the previous period (day for intraday charts, week for daily, month above).
 * kind: traditional | fibonacci | camarilla | woodie. Returns { P, R1, R2, R3, S1, S2, S3 } arrays.
 */
export function pivots(bars, kind = 'traditional', periodOf = b => Math.floor((b.start ?? b.time) / 86400)) {
  const keys = ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3'], out = Object.fromEntries(keys.map(k => [k, new Array(bars.length).fill(null)]));
  let cur = null, prev = null, levels = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = periodOf(b);
    if (!cur || cur.id !== p) {
      if (cur) { prev = cur; levels = pivotLevels(kind, prev.h, prev.l, prev.c, b.open); }
      cur = { id: p, h: b.high, l: b.low, c: b.close };
    } else { cur.h = Math.max(cur.h, b.high); cur.l = Math.min(cur.l, b.low); cur.c = b.close; }
    if (levels) for (const k of keys) out[k][i] = levels[k];
  }
  return out;
}
export function pivotLevels(kind, h, l, c, open) {
  const r = h - l;
  switch (kind) {
    case 'fibonacci': { const P = (h + l + c) / 3; return { P, R1: P + 0.382 * r, S1: P - 0.382 * r, R2: P + 0.618 * r, S2: P - 0.618 * r, R3: P + r, S3: P - r }; }
    case 'camarilla': return { P: (h + l + c) / 3, R1: c + r * 1.1 / 12, S1: c - r * 1.1 / 12, R2: c + r * 1.1 / 6, S2: c - r * 1.1 / 6, R3: c + r * 1.1 / 4, S3: c - r * 1.1 / 4 };
    case 'woodie': { const P = (h + l + 2 * open) / 4; return { P, R1: 2 * P - l, S1: 2 * P - h, R2: P + r, S2: P - r, R3: h + 2 * (P - l), S3: l - 2 * (h - P) }; }
    default: { const P = (h + l + c) / 3; return { P, R1: 2 * P - l, S1: 2 * P - h, R2: P + r, S2: P - r, R3: h + 2 * (P - l), S3: l - 2 * (h - P) }; }
  }
}

// ------------------------------------------------------------------ oscillators
export function cci(bars, n = 20) {
  const tp = bars.map(b => (b.high + b.low + b.close) / 3), m = sma(tp, n);
  return tp.map((v, i) => {
    if (m[i] == null) return null;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
  });
}
export function williamsR(bars, n = 14) {
  const H = bars.map(b => b.high), L = bars.map(b => b.low);
  return bars.map((b, i) => { if (i < n - 1) return null; const hh = highest(H, i, n), ll = lowest(L, i, n); return hh === ll ? -50 : (hh - b.close) / (hh - ll) * -100; });
}
export const momentum = (a, n = 10) => a.map((v, i) => (i >= n && v != null && a[i - n] != null ? v - a[i - n] : null));
export const roc = (a, n = 9) => a.map((v, i) => (i >= n && a[i - n] ? (v - a[i - n]) / a[i - n] * 100 : null));
export function stochRsi(closes, rsiLen = 14, stochLen = 14, k = 3, d = 3) {
  const r = rsi(closes, rsiLen);
  const raw = r.map((v, i) => {
    if (v == null || i < stochLen - 1) return null;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - stochLen + 1; j <= i; j++) { if (r[j] == null) return null; hh = Math.max(hh, r[j]); ll = Math.min(ll, r[j]); }
    return hh === ll ? 50 : (v - ll) / (hh - ll) * 100;
  });
  const K = sma(raw, k);
  return { k: K, d: sma(K, d) };
}
/** Average Directional Index with +DI / −DI. */
export function adx(bars, diLen = 14, adxLen = 14) {
  const plus = [null], minus = [null];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high, dn = bars[i - 1].low - bars[i].low;
    plus.push(up > dn && up > 0 ? up : 0); minus.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = rma(trueRange(bars).map((v, i) => (i ? v : null)), diLen), p = rma(plus, diLen), m = rma(minus, diLen);
  const pdi = p.map((v, i) => (v == null || !tr[i] ? null : 100 * v / tr[i])), mdi = m.map((v, i) => (v == null || !tr[i] ? null : 100 * v / tr[i]));
  const dx = pdi.map((v, i) => (v == null || mdi[i] == null ? null : v + mdi[i] === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / (v + mdi[i])));
  return { plus: pdi, minus: mdi, adx: rma(dx, adxLen) };
}
export function aroon(bars, n = 14) {
  const up = new Array(bars.length).fill(null), down = new Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    let hi = i, lo = i;
    for (let j = i - n; j <= i; j++) { if (bars[j].high >= bars[hi].high) hi = j; if (bars[j].low <= bars[lo].low) lo = j; }
    up[i] = 100 * (n - (i - hi)) / n; down[i] = 100 * (n - (i - lo)) / n;
  }
  return { up, down };
}
export function awesome(bars) {
  const hl2 = bars.map(b => (b.high + b.low) / 2), f = sma(hl2, 5), s = sma(hl2, 34);
  return f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]));
}

// ------------------------------------------------------------------ volume
export function obv(bars) {
  let v = 0;
  return bars.map((b, i) => { if (i) v += b.close > bars[i - 1].close ? b.volume || 0 : b.close < bars[i - 1].close ? -(b.volume || 0) : 0; return v; });
}
export function mfi(bars, n = 14) {
  const tp = bars.map(b => (b.high + b.low + b.close) / 3);
  return bars.map((b, i) => {
    if (i < n) return null;
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * (bars[j].volume || 0); if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; }
    if (pos + neg === 0) return null; // no volume in the window (e.g. FX feeds without volume)
    return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  });
}
/** Chaikin money flow. */
export function cmf(bars, n = 20) {
  const mfv = bars.map(b => (b.high === b.low ? 0 : ((b.close - b.low) - (b.high - b.close)) / (b.high - b.low) * (b.volume || 0)));
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    let a = 0, v = 0;
    for (let j = i - n + 1; j <= i; j++) { a += mfv[j]; v += bars[j].volume || 0; }
    return v ? a / v : 0;
  });
}

/**
 * Volume profile of bars[from..to]: `rows` price bins with total / up / down volume, the point of control and the
 * value area (the bins around the POC holding `va`% of the volume).
 */
export function volumeProfile(bars, from, to, rows = 24, va = 70) {
  const seg = bars.slice(Math.max(0, from), Math.min(bars.length, to + 1));
  if (!seg.length) return null;
  const lo = Math.min(...seg.map(b => b.low)), hi = Math.max(...seg.map(b => b.high));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / rows, bins = Array.from({ length: rows }, (_, k) => ({ lo: lo + k * step, hi: lo + (k + 1) * step, up: 0, down: 0, total: 0 }));
  for (const b of seg) {
    const v = b.volume || 0;
    if (!v) continue;
    // spread the bar's volume evenly over the bins its range touches
    const k1 = Math.min(rows - 1, Math.floor((b.low - lo) / step)), k2 = Math.min(rows - 1, Math.floor((b.high - lo) / step));
    const share = v / (k2 - k1 + 1), up = b.close >= b.open;
    for (let k = k1; k <= k2; k++) { bins[k].total += share; if (up) bins[k].up += share; else bins[k].down += share; }
  }
  const total = bins.reduce((a, x) => a + x.total, 0);
  let poc = 0;
  bins.forEach((x, k) => { if (x.total > bins[poc].total) poc = k; });
  let a = poc, z = poc, acc = bins[poc].total;
  while (acc < total * va / 100 && (a > 0 || z < rows - 1)) {
    const below = a > 0 ? bins[a - 1].total : -1, above = z < rows - 1 ? bins[z + 1].total : -1;
    if (above >= below) acc += bins[++z].total; else acc += bins[--a].total;
  }
  return { bins, poc, vaLow: a, vaHigh: z, total, max: bins[poc].total };
}

// ------------------------------------------------------------------ outputs for alerts (numbers only, no styling)
export const OUTPUT_NAMES = {
  VOL: ['Volume'], BB: ['Basis', 'Upper', 'Lower'], KC: ['Basis', 'Upper', 'Lower'], DC: ['Basis', 'Upper', 'Lower'],
  SUPERTREND: ['Up trend line', 'Down trend line'], ICHIMOKU: ['Conversion', 'Base', 'Lagging span', 'Leading span A', 'Leading span B'],
  PIVOTS: ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3'], MACD: ['Histogram', 'MACD', 'Signal'], STOCH: ['%K', '%D'], STOCHRSI: ['%K', '%D'],
  ADX: ['ADX', '+DI', '−DI'], AROON: ['Aroon up', 'Aroon down'],
};
export const outputNames = type => OUTPUT_NAMES[type] || ['Value'];

/** Pivot period id: the trading day on intraday charts, the week on daily, the month above that. */
export function pivotPeriodOf(bars, session) {
  const iv = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 3600;
  if (iv < 86400 * 0.9) return b => sessionDay(b.start ?? b.time, session);
  if (iv < 86400 * 6) return b => Math.floor(((b.start ?? b.time) / 86400 + 3) / 7); // weeks start Monday
  return b => { const d = new Date((b.start ?? b.time) * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
}

/** Every output of a built-in indicator as plain arrays aligned to `bars` (null during warm-up). */
export function indicatorOutputs(type, bars, P, session = 'fx') {
  const C = bars.map(b => b.close);
  switch (type) {
    case 'VOL': return [bars.map(b => b.volume || 0)];
    case 'SMA': return [sma(C, P.length)];
    case 'EMA': return [ema(C, P.length)];
    case 'WMA': return [wma(C, P.length)];
    case 'HMA': return [hma(C, P.length)];
    case 'VWMA': return [vwma(bars, P.length)];
    case 'VWAP': return [vwap(bars, session)];
    case 'BB': { const b = bollinger(C, P.length, P.mult); return [b.mid, b.upper, b.lower]; }
    case 'KC': { const k = keltner(bars, P.length, P.mult, P.atr); return [k.mid, k.upper, k.lower]; }
    case 'DC': { const d = donchianChannel(bars, P.length); return [d.basis, d.upper, d.lower]; }
    case 'SUPERTREND': { const s = supertrend(bars, P.length, P.mult); return [s.line.map((v, i) => (s.dir[i] === 1 ? v : null)), s.line.map((v, i) => (s.dir[i] === -1 ? v : null))]; }
    case 'PSAR': return [psar(bars, P.start, P.inc, P.max)];
    case 'ICHIMOKU': { const k = ichimoku(bars, P.conversion, P.base, P.spanB, P.displacement); return [k.tenkan, k.kijun, k.lag, k.leadA.slice(0, bars.length), k.leadB.slice(0, bars.length)]; }
    case 'PIVOTS': { const pv = pivots(bars, P.type, pivotPeriodOf(bars, session)); return ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3'].map(k => pv[k]); }
    case 'RSI': return [rsi(C, P.length)];
    case 'MACD': { const m = macd(C, P.fast, P.slow, P.signal); return [m.hist, m.line, m.signal]; }
    case 'STOCH': { const s = stoch(bars, P.k, P.smooth, P.d); return [s.k, s.d]; }
    case 'STOCHRSI': { const s = stochRsi(C, P.rsi, P.stoch, P.k, P.d); return [s.k, s.d]; }
    case 'CCI': return [cci(bars, P.length)];
    case 'WILLR': return [williamsR(bars, P.length)];
    case 'MOM': return [momentum(C, P.length)];
    case 'ROC': return [roc(C, P.length)];
    case 'AO': return [awesome(bars)];
    case 'ADX': { const a = adx(bars, P.di, P.adx); return [a.adx, a.plus, a.minus]; }
    case 'AROON': { const a = aroon(bars, P.length); return [a.up, a.down]; }
    case 'ATR': return [atr(bars, P.length)];
    case 'STDEV': return [stdev(C, P.length)];
    case 'OBV': return [obv(bars)];
    case 'MFI': return [mfi(bars, P.length)];
    case 'CMF': return [cmf(bars, P.length)];
  }
  return [];
}
