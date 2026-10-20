// Script indicators: user-written JavaScript indicators (Pine-style API) stored on the server and executed in an
// isolated module Web Worker — no DOM, no app state, network APIs removed, 3-second time limit per run.
//
// A script reads like this:
//   indicator('RSI bands', { overlay: false })
//   const len = input('length', 14, { min: 2 })
//   plot(ta.rsi(close, len), { title: 'RSI', color: '#7e57c2' })
//   hline(70); hline(30)

import { kv, uid } from './util.js';

// ------------------------------------------------------------------ registry
let scripts = [];
export async function loadScripts() { scripts = (await kv.get('scripts', [])) || []; return scripts; }
export const listScripts = () => scripts;
export const getScript = id => scripts.find(s => s.id === id) || null;
export function saveScripts() { kv.set('scripts', scripts); }
export function upsertScript(s) {
  const i = scripts.findIndex(x => x.id === s.id);
  if (i >= 0) scripts[i] = s; else scripts.push(s);
  saveScripts();
  return s;
}
export function deleteScript(id) { scripts = scripts.filter(s => s.id !== id); saveScripts(); }
export const newScriptId = () => `scr_${uid()}`;

// ------------------------------------------------------------------ templates
export const TEMPLATES = {
  pineStrategy: {
    name: 'Pine strategy: EMA cross with ATR stop & target',
    code: `//@version=6
strategy("EMA cross strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.02)

fastLen = input.int(20, "Fast EMA", minval=1)
slowLen = input.int(50, "Slow EMA", minval=1)
atrLen = input.int(14, "ATR length", minval=1)
stopAtr = input.float(2.0, "Stop (x ATR)", minval=0.1, step=0.1)
targetAtr = input.float(3.0, "Target (x ATR)", minval=0.1, step=0.1)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
atr = ta.atr(atrLen)
plot(fast, "Fast", color.blue)
plot(slow, "Slow", color.orange)

// entries fill at the next bar's open; the bracket is set from this bar's close and ATR
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
    strategy.exit("Exit long", "Long", stop=close - stopAtr * atr, limit=close + targetAtr * atr)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)
    strategy.exit("Exit short", "Short", stop=close + stopAtr * atr, limit=close - targetAtr * atr)
`,
  },

  blank: { name: 'Blank indicator', code: `indicator('My indicator', { overlay: true })

const length = input('length', 20, { min: 1 })
plot(ta.sma(close, length), { title: 'SMA', color: '#2962ff', width: 2 })
` },
  rsiBands: { name: 'RSI with bands', code: `indicator('RSI bands', { overlay: false })

const length = input('length', 14, { min: 2 })
const upper = input('overbought', 70)
const lower = input('oversold', 30)

plot(ta.rsi(close, length), { title: 'RSI', color: '#7e57c2', width: 2 })
hline(upper, { color: '#f23645' })
hline(50, { color: '#787b86' })
hline(lower, { color: '#089981' })
` },
  emaRibbon: { name: 'EMA ribbon', code: `indicator('EMA ribbon', { overlay: true })

const colors = ['#00bcd4', '#2962ff', '#7e57c2', '#e91e63', '#ff9800']
;[8, 13, 21, 34, 55].forEach((len, i) => {
  plot(ta.ema(close, len), { title: 'EMA ' + len, color: colors[i], width: 1 })
})
` },
  donchian: { name: 'Donchian channel', code: `indicator('Donchian channel', { overlay: true })

const length = input('length', 20, { min: 2 })
const upper = ta.highest(high, length)
const lower = ta.lowest(low, length)
const mid = upper.map((u, i) => (u + lower[i]) / 2)

plot(upper, { title: 'Upper', color: '#089981' })
plot(mid, { title: 'Basis', color: '#787b86' })
plot(lower, { title: 'Lower', color: '#f23645' })
` },
  volumeSpikes: { name: 'Volume spikes', code: `indicator('Volume spikes', { overlay: false })

const length = input('length', 20, { min: 2 })
const threshold = input('threshold', 2, { min: 0.5, step: 0.1 })
const ratio = volume.map((v, i) => v / nz(ta.sma(volume, length)[i], 1))
const colors = ratio.map(r => (r >= threshold ? '#f23645' : '#5d606b'))

plot(ratio, { title: 'Volume / average', style: 'histogram', color: colors })
hline(threshold, { color: '#ff9800' })
` },
  momentumCross: { name: 'Momentum + signal', code: `indicator('Momentum', { overlay: false })

const length = input('length', 10, { min: 1 })
const signalLen = input('signal', 9, { min: 1 })
const mom = ta.change(close, length)
const signal = ta.ema(mom, signalLen)
const hist = mom.map((m, i) => m - nz(signal[i]))

plot(hist, { title: 'Histogram', style: 'histogram', color: hist.map(h => (h >= 0 ? '#26a69a' : '#ef5350')) })
plot(mom, { title: 'Momentum', color: '#2962ff', width: 2 })
plot(signal, { title: 'Signal', color: '#ff9800' })
hline(0)
` },
};

// Bundled community Pine scripts (shown in the Indicators dialog; installed into "My scripts" on first use).
export const LIBRARY = [
  { id: 'lib_gold_ny_orb', version: 2, name: 'Gold NY Open Breakout', author: 'ChartDesk', file: '/library/gold-ny-open-breakout.pine',
    desc: 'XAUUSD 1m: COMEX-open range breakout + second chance, midpoint stop, 1R trailing, 2R — same rules as the Strategy Tester strategy' },
  { id: 'lib_luxalgo_smc', version: 1, name: 'Smart Money Concepts (SMC)', author: 'LuxAlgo · CC BY-NC-SA 4.0', file: '/library/luxalgo-smart-money-concepts.pine',
    desc: 'BOS/CHoCH, internal & swing structure, order blocks, FVGs, EQH/EQL, premium/discount, MTF levels' },
  { id: 'lib_zp_diy_builder', version: 2, name: 'DIY Custom Strategy Builder [ZP] - v1', author: 'ZPayab', file: '/library/zp-diy-custom-strategy-builder.pine',
    desc: 'Leading indicator + up to 40 confirmation filters → long/short signals' },
];

/** Bring installed library scripts up to the bundled version (code only; metadata refreshes on the next run). */
export async function upgradeLibraryScripts() {
  for (const item of LIBRARY) {
    const sc = getScript(item.id);
    if (!sc || sc.libVersion === item.version) continue;
    try {
      const res = await fetch(item.file, { cache: 'no-cache' });
      if (!res.ok) continue;
      upsertScript({ ...sc, code: await res.text(), libVersion: item.version, name: item.name, updated: Date.now() });
    } catch { /* offline: keep the installed copy */ }
  }
}

/** Plot/level metadata as stored with a script (what the chart needs to create its series). */
export const metaFromResult = res => ({
  name: res.meta.name, overlay: res.meta.overlay, inputs: res.meta.inputs, lang: res.lang || 'js', strategy: !!res.meta.strategy,
  plots: res.plots.map(p => ({ title: p.title, style: p.style, color: p.color || (p.colors && p.colors.find(Boolean)) || '#2962ff', width: p.width })),
  hlines: res.hlines,
});

/** Install a library script (fetch its source, compile on the given candles) and return the saved script. */
export async function installLibraryScript(item, bars, ctx) {
  const existing = getScript(item.id);
  if (existing?.meta && existing.libVersion === item.version) return existing;
  const res = await fetch(item.file, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't load ${item.name} (${res.status})`);
  const code = await res.text();
  const c = await compileScript(code, bars, ctx);
  const sc = { id: item.id, name: item.name, code, meta: c.error ? null : c.meta, error: c.error || null, created: Date.now(), library: true, libVersion: item.version };
  upsertScript(sc);
  if (c.error) throw new Error(`${c.line ? `Line ${c.line}: ` : ''}${c.error}`);
  return sc;
}

export const REFERENCE = [
  ['indicator(name, { overlay })', 'Name the indicator; overlay: true draws on the price chart, false gives it its own pane.'],
  ['input(name, default, { min, max, step })', 'A number setting you can change from the indicator\'s ⚙ button. Returns the current value.'],
  ['open high low close volume time', 'Arrays of the chart\'s candles, oldest first (time = Unix seconds UTC). n = number of candles.'],
  ['plot(values, { title, color, width, style })', 'Draw an array (or a constant). style: "line" (default), "histogram" or "area". color may be an array (one per candle).'],
  ['hline(price, { color })', 'Horizontal reference level.'],
  ['ta.sma / ema / rma / wma(src, len)', 'Moving averages.'],
  ['ta.rsi(src, len) · ta.stdev(src, len) · ta.change(src, len)', 'Oscillators and differences.'],
  ['ta.atr(len) · ta.tr()', 'Average / true range of the chart\'s candles.'],
  ['ta.macd(src, fast, slow, signal) → { line, signal, hist }', 'MACD.'],
  ['ta.bb(src, len, mult) → { mid, upper, lower }', 'Bollinger Bands.'],
  ['ta.stoch(k, smooth, d) → { k, d }', 'Stochastic of the chart\'s candles.'],
  ['ta.highest / lowest / sum(src, len)', 'Rolling highest, lowest and sum.'],
  ['ta.crossover(a, b) · ta.crossunder(a, b)', 'Boolean arrays: true where a crosses above / below b.'],
  ['nz(value, fallback = 0)', 'Replace null/NaN (e.g. during warm-up).'],
];

// ------------------------------------------------------------------ isolated runner
const workerSource = origin => `
import * as I from '${origin}/js/core/indicators.js';
import { runPine, looksLikePine } from '${origin}/js/core/pine.js';

// Isolation: scripts get no network or storage APIs (the worker never sees the page, app state or keys).
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker']) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch {}
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const nz = (v, d = 0) => (isNum(v) ? v : d);
const rolling = (a, n, fn) => a.map((_, i) => { if (i < n - 1) return null; const w = a.slice(i - n + 1, i + 1); return w.every(isNum) ? fn(w) : null; });
const wma = (a, n) => { const den = n * (n + 1) / 2; return rolling(a, n, w => w.reduce((s, v, j) => s + v * (j + 1), 0) / den); };
const highest = (a, n) => rolling(a, n, w => Math.max(...w));
const lowest = (a, n) => rolling(a, n, w => Math.min(...w));
const sum = (a, n) => rolling(a, n, w => w.reduce((s, v) => s + v, 0));
const change = (a, n = 1) => a.map((v, i) => (i >= n && isNum(v) && isNum(a[i - n]) ? v - a[i - n] : null));
const cross = (a, b, up) => a.map((v, i) => {
  if (!i) return false;
  const p = a[i - 1], q = Array.isArray(b) ? b[i - 1] : b, c = Array.isArray(b) ? b[i] : b;
  if (![v, p, q, c].every(isNum)) return false;
  return up ? p <= q && v > c : p >= q && v < c;
});

// Live Pine sessions per chart indicator: when candles are only appended (Bar Replay steps) the interpreter
// continues from where it stopped instead of recalculating the whole history.
const sessions = new Map();
self.onmessage = e => {
  const { id, code, data, inputs, libs, key, strat, profile } = e.data;
  const n = data.close.length;
  if (looksLikePine(code)) {
    try {
      const sig = code.length + '|' + code.slice(0, 64) + '|' + JSON.stringify(inputs || {}) + '|' + JSON.stringify(strat || {}) + '|' + data.tf + '|' + data.symbol + '|' + data.mintick + '|' + data.qtyStep + '|' + data.session;
      let r = null;
      const live = key && sessions.get(key);
      if (live && !profile && live.sig === sig && live.session.extend) r = live.session.extend(data);
      if (!r) {
        const session = {};
        r = runPine(code, data, inputs || {}, { libs: libs || {}, session, strategy: strat || null, profile: !!profile });
        if (key) {
          sessions.delete(key);
          sessions.set(key, { sig, session });
          while (sessions.size > 6) sessions.delete(sessions.keys().next().value);
        }
      }
      self.postMessage({ id, lang: 'pine', meta: r.meta, securityRequests: r.securityRequests, plots: r.plots, hlines: r.hlines, shapes: r.shapes, drawings: r.drawings, fills: r.fills, bgcolors: r.bgcolors, barcolors: r.barcolors, alerts: r.alerts, warnings: r.warnings, strategy: r.strategy || null, logs: r.logs || [], profile: r.profile || null });
    } catch (err) {
      self.postMessage({ id, lang: 'pine', error: (err && err.message) || String(err), line: err && err.line ? err.line : null });
    }
    return;
  }
  const bars = data.close.map((c, i) => ({ time: data.time[i], open: data.open[i], high: data.high[i], low: data.low[i], close: c, volume: data.volume[i] }));
  const meta = { name: 'Script', overlay: true, inputs: [] };
  const plots = [], hlines = [];
  const asSeries = (v, what) => {
    if (typeof v === 'number') return new Array(n).fill(v);
    if (!Array.isArray(v)) throw new Error(what + ' must be an array of numbers or a number');
    if (v.length !== n) throw new Error(what + ' has ' + v.length + ' values but the chart has ' + n + ' candles');
    return v.map(x => (isNum(x) ? x : null));
  };
  const ta = {
    sma: I.sma, ema: I.ema, rma: I.rma, wma, rsi: I.rsi, stdev: (a, len) => I.stdev(a, len),
    atr: len => I.atr(bars, len), tr: () => I.trueRange(bars),
    macd: (src, f, s, g) => I.macd(src, f, s, g), bb: (src, len, mult) => I.bollinger(src, len, mult),
    stoch: (k, sm, d) => I.stoch(bars, k, sm, d),
    highest, lowest, sum, change,
    crossover: (a, b) => cross(a, b, true), crossunder: (a, b) => cross(a, b, false),
  };
  const api = {
    open: data.open, high: data.high, low: data.low, close: data.close, volume: data.volume, time: data.time, n, bars, ta, nz, Math,
    indicator(name, opts = {}) { meta.name = String(name || 'Script').slice(0, 60); meta.overlay = opts.overlay !== false; },
    input(name, def, opts = {}) {
      name = String(name);
      if (!meta.inputs.some(x => x.name === name)) meta.inputs.push({ name, def: Number(def), min: opts.min ?? null, max: opts.max ?? null, step: opts.step ?? null });
      const v = inputs && inputs[name] != null ? Number(inputs[name]) : Number(def);
      return Number.isFinite(v) ? v : Number(def);
    },
    plot(values, opts = {}) {
      if (plots.length >= 20) throw new Error('At most 20 plots per script');
      const style = ['line', 'histogram', 'area'].includes(opts.style) ? opts.style : 'line';
      if (Array.isArray(opts.color) && opts.color.length !== n) throw new Error('color array has ' + opts.color.length + ' values but the chart has ' + n + ' candles');
      const colors = Array.isArray(opts.color) ? opts.color.map(c => (c == null ? null : String(c))) : null;
      plots.push({ title: String(opts.title || 'Plot ' + (plots.length + 1)), style, color: colors ? null : String(opts.color || '#2962ff'), colors, width: Math.max(1, Math.min(4, Math.round(opts.width || (style === 'line' ? 2 : 1)))), values: asSeries(values, 'plot "' + (opts.title || plots.length + 1) + '"') });
    },
    hline(price, opts = {}) { if (isNum(price)) hlines.push({ price, color: String(opts.color || '#787b86') }); },
  };
  try {
    const fn = new Function('__api', 'with (__api) {\\n' + code + '\\n}');
    fn(api);
    if (!plots.length) throw new Error('The script did not plot anything — call plot(values) at least once.');
    self.postMessage({ id, meta, plots, hlines });
  } catch (err) {
    const m = /<anonymous>:(\\d+):(\\d+)/.exec(String(err && err.stack));
    const line = m ? Number(m[1]) - 2 : null;
    self.postMessage({ id, error: (err && err.message) || String(err), line: line > 0 ? line : null });
  }
};
`;

let worker = null;
let seq = 0;
const pending = new Map();
const TIME_LIMIT = 12000;

function getWorker() {
  if (!worker) {
    const url = URL.createObjectURL(new Blob([workerSource(location.origin)], { type: 'text/javascript' }));
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      p.resolve(e.data);
    };
    worker.onerror = e => { e.preventDefault?.(); resetWorker(`Script engine error: ${e.message || 'failed to start'}`); };
  }
  return worker;
}
function resetWorker(reason) {
  worker?.terminate();
  worker = null;
  for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ id, error: reason }); }
  pending.clear();
}

// Pine libraries imported by scripts (`import Owner/Name/Version as alias`) are bundled in /library/lib/ —
// the isolated worker has no network access, so their sources are fetched here and passed along.
const libCache = new Map();
async function librariesFor(code) {
  const libs = {};
  for (const m of code.matchAll(/^\s*import\s+([A-Za-z0-9_]+\/[A-Za-z0-9_]+\/\d+)/gm)) {
    const path = m[1];
    if (!libCache.has(path)) libCache.set(path, fetch(`/library/lib/${path}.pine`, { cache: 'no-cache' }).then(r => (r.ok ? r.text() : null)).catch(() => null));
    const src = await libCache.get(path);
    if (src) libs[path] = src;
  }
  return libs;
}

/** Run a script on candles. Resolves { meta, plots, hlines, … } or { error, line }. */
export async function runScript(code, bars, inputs = {}, ctx = {}) {
  const libs = /^\s*import\s/m.test(code) ? await librariesFor(code) : {};
  return new Promise(resolve => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve({ id, error: `The script ran longer than ${TIME_LIMIT / 1000} s and was stopped.` }); resetWorker('Script engine restarted after a timeout.'); }, TIME_LIMIT);
    pending.set(id, { resolve, timer });
    const data = { time: [], open: [], high: [], low: [], close: [], volume: [], tf: ctx.tf, symbol: ctx.symbol, mintick: ctx.mintick, qtyStep: ctx.qtyStep, session: ctx.session, security: ctx.security };
    for (const b of bars) { data.time.push(b.time); data.open.push(b.open); data.high.push(b.high); data.low.push(b.low); data.close.push(b.close); data.volume.push(b.volume || 0); }
    getWorker().postMessage({ id, code, data, inputs, libs, key: ctx.profile ? null : ctx.key, strat: ctx.strategy || null, profile: !!ctx.profile });
  });
}

/** Compile: run on candles and capture the script's metadata (name, overlay, inputs, plot styles, levels). */
export async function compileScript(code, bars, ctx = {}) {
  const res = await runScript(code, bars, {}, ctx);
  if (res.error) return res;
  return { meta: metaFromResult(res), result: res };
}
