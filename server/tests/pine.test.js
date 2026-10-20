import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPine, parsePine, looksLikePine, PineError } from '../../public/js/core/pine.js';
import * as I from '../../public/js/core/indicators.js';

// Deterministic pseudo-random walk (no market data involved — this only checks the maths).
function series(n = 400) {
  let x = 2000, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [], tf: 3600 };
  for (let i = 0; i < n; i++) {
    const o = x; x += (rnd() - 0.5) * 8;
    d.time.push(1700000000 + i * 3600); d.open.push(o); d.close.push(x);
    d.high.push(Math.max(o, x) + rnd() * 3); d.low.push(Math.min(o, x) - rnd() * 3); d.volume.push(100 + Math.round(rnd() * 50));
  }
  return d;
}
const D = series();
const same = (a, b, label) => {
  assert.equal(a.length, b.length, label);
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null || b[i] == null) { assert.equal(a[i] == null, b[i] == null, `${label} na at ${i}`); continue; }
    assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `${label} at ${i}: ${a[i]} vs ${b[i]}`);
  }
};
const plotOf = (src, title, inputs) => runPine(src, D, inputs).plots.find(p => p.title === title).values;
const pineEma = (a, n) => {
  let prev = null;
  return a.map(x => {
    if (x != null) prev = prev == null ? x : 2 / (n + 1) * x + (1 - 2 / (n + 1)) * prev;
    return prev;
  });
};

test('ta.sma / rsi match built-ins; EMA follows its first-value recurrence', () => {
  const src = `//@version=6
indicator("t")
plot(ta.sma(close, 20), "sma")
plot(ta.ema(close, 20), "ema")
plot(ta.rsi(close, 14), "rsi")`;
  same(plotOf(src, 'sma'), I.sma(D.close, 20), 'sma');
  same(plotOf(src, 'ema'), pineEma(D.close, 20), 'ema');
  same(plotOf(src, 'rsi'), I.rsi(D.close, 14), 'rsi');
});

test('tuples: MACD uses first-value EMAs and Bollinger bands match the built-in indicator', () => {
  const src = `//@version=6
indicator("t")
[m, s, h] = ta.macd(close, 12, 26, 9)
[mid, up, lo] = ta.bb(close, 20, 2)
plot(m, "macd")
plot(s, "signal")
plot(up, "upper")`;
  const r = runPine(src, D);
  const fast = pineEma(D.close, 12), slow = pineEma(D.close, 26);
  const line = fast.map((v, i) => v - slow[i]);
  const ref = {line, signal: pineEma(line, 9)}, bb = I.bollinger(D.close, 20, 2);
  same(r.plots[0].values, ref.line, 'macd');
  same(r.plots[1].values, ref.signal, 'signal');
  same(r.plots[2].values, bb.upper, 'bb upper');
});

test('EMA is available from the first valid source; RMA still waits for its SMA seed', () => {
  const r = runPine(`//@version=6
indicator("seeds")
plot(ta.ema(close, 3), "EMA")
plot(ta.rma(close, 3), "RMA")`, {...D, close:[10,14,18,22], time:D.time.slice(0,4)});
  assert.deepEqual(r.plots[0].values, [10,12,15,18.5]);
  assert.deepEqual(r.plots[1].values, [null,null,14,50/3]);
});

test('higher-timeframe lookbacks use prior provider candles without leaking its unfinished final candle', () => {
  const columns = rows => Object.fromEntries(['time','open','high','low','close','volume'].map((c,j)=>[c,rows.map(r=>r[j])]));
  const d = {...columns(Array.from({length:8},(_,k)=>[7200+k*900,120+k,120+k,120+k,120+k,1])),tf:900,session:'utc'};
  d.security = {'60':columns([[0,100,100,100,100,1],[3600,110,110,110,110,1],[7200,130,130,130,130,1],[10800,999,999,999,999,1],[14400,9999,9999,9999,9999,1]])};
  const r = runPine(`//@version=6
indicator("context")
previous() =>
    e = ta.ema(close,3)
    e[1]
plot(request.security(syminfo.tickerid,"60",previous(),lookahead=barmerge.lookahead_on))`,d);
  assert.deepEqual(r.plots[0].values,[105,105,105,105,117.5,117.5,117.5,117.5]);
  assert.deepEqual(r.securityRequests,['60']);
});

test('inputs, switch, var, if-expressions, arrays, user types and methods', () => {
  const src = `//@version=6
indicator("Mix", overlay=true)
len = input.int(10, "Length")
kind = input.string("SMA", "Kind", options=["SMA", "EMA"])
ma(src, l, t) =>
    switch t
        "SMA" => ta.sma(src, l)
        => ta.ema(src, l)
type Acc
    float total = 0
method add(Acc a, float v) =>
    a.total := a.total + v
var acc = Acc.new()
acc.add(1)
var arr = array.new_float(0)
arr.push(close)
if arr.size() > 3
    arr.shift()
avg = arr.avg()
dir = if close > open
    1
else
    -1
plot(ma(close, len, kind), "ma")
plot(acc.total, "count")
plot(avg, "avg")
plot(dir, "dir")`;
  const r = runPine(src, D, { Kind: 'EMA', Length: 5 });
  assert.equal(r.meta.name, 'Mix');
  assert.equal(r.meta.overlay, true);
  assert.deepEqual(r.meta.inputs.map(x => [x.name, x.kind]), [['Length', 'int'], ['Kind', 'string']]);
  assert.deepEqual(r.meta.inputs[1].options, ['SMA', 'EMA']);
  same(r.plots[0].values, pineEma(D.close, 5), 'switch ema');
  assert.equal(r.plots[1].values[D.close.length - 1], D.close.length);
  const n = D.close.length;
  assert.ok(Math.abs(r.plots[2].values[n - 1] - (D.close[n - 1] + D.close[n - 2] + D.close[n - 3]) / 3) < 1e-9);
  assert.equal(r.plots[3].values[n - 1], D.close[n - 1] > D.open[n - 1] ? 1 : -1);
});

test('plotshape produces markers; display.none plots are hidden; history works', () => {
  const src = `//@version=6
indicator("Sig", overlay=true)
up = ta.crossover(close, ta.sma(close, 10))
plotshape(up, "Long", style=shape.labelup, location=location.belowbar, color=color.green, text="long")
plot(close - close[1], "chg", display=display.none)
plot(close[1], "prev")`;
  const r = runPine(src, D);
  assert.ok(r.shapes.length > 0);
  assert.ok(r.shapes.every(s => s.position === 'belowBar' && s.shape === 'arrowUp' && s.text === 'long'));
  assert.equal(r.plots.length, 1);
  assert.equal(r.plots[0].values[5], D.close[4]);
});

test('errors report the line; strategy scripts run', () => {
  assert.throws(() => runPine('//@version=6\nindicator("x")\nplot(foo)', D), e => e instanceof PineError && e.line === 3);
  assert.throws(() => parsePine('indicator("x")\nplot(close'), PineError);
  const r = runPine('//@version=6\nstrategy("x")\nplot(close)', D);
  assert.equal(r.meta.strategy, true);
  assert.ok(r.strategy && Array.isArray(r.strategy.trades));
});

test('language detection', () => {
  assert.equal(looksLikePine('//@version=6\nindicator("x")'), true);
  assert.equal(looksLikePine("indicator('x', { overlay: true })\nconst a = 1\nplot(ta.sma(close, a))"), false);
});

// ---------------------------------------------------------------- libraries, drawings, MTF, SMC
import { readFileSync } from 'node:fs';
const LIB = p => readFileSync(new URL(`../../public/library/${p}`, import.meta.url), 'utf8');

test('imported libraries: types, methods and functions under their alias', () => {
  const lib = `//@version=6
library("Acc")
export type Box
    float total = 0
export method add(Box this, float v) =>
    this.total += v
    this.total
export make() => Box.new()`;
  const src = `//@version=6
indicator("uses lib")
import Me/Acc/1 as acc
var b = acc.make()
b.add(1)
plot(b.total, "n")`;
  const r = runPine(src, D, {}, { libs: { 'Me/Acc/1': lib } });
  assert.equal(r.plots[0].values.at(-1), D.close.length);
  assert.equal(r.warnings.length, 0);
});

test('drawings: final state, chart.point forms, garbage collection beyond max_*_count, tables', () => {
  const src = `//@version=6
indicator("draw", overlay=true, max_lines_count=3)
line.new(bar_index - 1, low, bar_index, high, color=color.red, style=line.style_dashed)
var lb = label.new(chart.point.now(high), "hi", style=label.style_label_down)
lb.set_point(chart.point.now(close))
var bx = box.new(chart.point.new(time, na, high), chart.point.new(time, na, low), xloc=xloc.bar_time, bgcolor=color.new(color.blue, 80))
bx.set_right(time)
var t = table.new(position.top_right, 2, 2)
if barstate.islast
    table.cell(t, 0, 0, "Signal", text_color=color.white, bgcolor=color.green)`;
  const r = runPine(src, D);
  const d = r.drawings, n = D.close.length;
  assert.equal(d.lines.length, 3, 'only the newest 3 lines survive');
  assert.equal(d.lines.at(-1).x2, D.time[n - 1]);
  assert.equal(d.lines.at(-1).style, 'dashed');
  assert.equal(d.labels.length, 1);
  assert.equal(d.labels[0].y, D.close[n - 1]);
  assert.equal(d.boxes[0].left, D.time[0]);
  assert.equal(d.boxes[0].right, D.time[n - 1]);
  assert.equal(d.boxes[0].bgcolor, 'rgba(41,98,255,0.2)');
  assert.equal(d.tables[0].cells[0].text, 'Signal');
});

test('request.security on a higher timeframe: lookahead rules, no future values', () => {
  // 1h candles → daily (UTC sessions in this synthetic set)
  const src = `//@version=6
indicator("mtf")
prevHigh = request.security(syminfo.tickerid, "D", high[1], lookahead = barmerge.lookahead_on)
dClose = request.security(syminfo.tickerid, "D", close)
plot(prevHigh, "ph")
plot(dClose, "dc")`;
  const r = runPine(src, D);
  const day = t => Math.floor(t / 86400);
  const days = new Map();
  D.time.forEach((t, k) => { const d = day(t); const o = days.get(d) || { hi: -Infinity, close: null, last: k }; o.hi = Math.max(o.hi, D.high[k]); o.close = D.close[k]; o.last = k; days.set(d, o); });
  const keys = [...days.keys()];
  for (let k = 30; k < D.close.length; k += 37) {
    const d = day(D.time[k]), idx = keys.indexOf(d);
    if (idx > 0) assert.equal(r.plots[0].values[k], days.get(keys[idx - 1]).hi, 'previous completed day high');
    const isLast = days.get(d).last === k;
    const expected = isLast ? days.get(d).close : idx > 0 ? days.get(keys[idx - 1]).close : null;
    assert.equal(r.plots[1].values[k], expected, 'lookahead_off: previous day until the day closes');
  }
});

test('fill(), bgcolor(), barcolor() and plotcandle() are returned for display', () => {
  const src = `//@version=6
indicator("cosmetics", overlay=true)
a = plot(high, "h")
b = plot(low, "l")
fill(a, b, color=color.new(color.green, 90))
bgcolor(close > open ? color.new(color.green, 95) : na)
barcolor(close > open ? color.lime : color.maroon)
plotcandle(open, high, low, close, "C", color=color.orange)`;
  const r = runPine(src, D);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].a.values[10], D.high[10]);
  assert.equal(r.bgcolors.length, 1);
  assert.equal(r.barcolors.length, D.close.length);
  const c = r.plots.find(p => p.style === 'candles');
  assert.deepEqual(c.ohlc.map(s => s[5]), [D.open[5], D.high[5], D.low[5], D.close[5]]);
});

test('Smart Money Concepts [LuxAlgo]: structure, order blocks, zones, alerts', () => {
  const src = LIB('luxalgo-smart-money-concepts.pine');
  const big = series(2500);
  const r = runPine(src, { ...big, tf: 900 }, { 'Fair Value Gaps': true, 'Premium/Discount Zones': true, 'Daily': true });
  const texts = r.drawings.labels.map(l => l.text.trim());
  assert.ok(texts.includes('BOS') && texts.includes('CHoCH'), 'BOS and CHoCH labels');
  assert.ok(texts.some(t => /Strong|Weak/.test(t)), 'strong/weak high/low');
  assert.ok(['Premium', 'Equilibrium', 'Discount'].every(z => texts.includes(z)), 'premium/discount/equilibrium');
  assert.ok(texts.includes('PDH') && texts.includes('PDL'), 'previous day high/low');
  assert.ok(r.drawings.boxes.length >= 3, 'order blocks / zones / FVG boxes');
  assert.ok(r.alerts.some(a => /CHoCH/.test(a.title)) && r.alerts.some(a => /BOS/.test(a.title)));
  assert.deepEqual(r.warnings, []);
});

test('SMC in Bar Replay: running on candles up to the cursor never shows anything the full run would change', () => {
  const src = LIB('luxalgo-smart-money-concepts.pine');
  const big = { ...series(2000), tf: 900 };
  const K = 1400;
  const cut = { ...big, time: big.time.slice(0, K), open: big.open.slice(0, K), high: big.high.slice(0, K), low: big.low.slice(0, K), close: big.close.slice(0, K), volume: big.volume.slice(0, K) };
  const full = runPine(src, big), part = runPine(src, cut);
  // every alert confirmed before the cursor is identical, and none appear early
  const key = a => `${a.i}|${a.title}`;
  assert.deepEqual(part.alerts.map(key), full.alerts.filter(a => a.i < K).map(key));
  // structure labels (BOS/CHoCH/EQH/EQL) drawn before the cursor match the full run
  const struct = l => /^(BOS|CHoCH|EQH|EQL)$/.test(l.text.trim());
  const sig = l => `${l.text.trim()}|${l.x}|${l.y}`;
  const fullLabels = new Set(full.drawings.labels.filter(struct).map(sig));
  for (const l of part.drawings.labels.filter(struct)) assert.ok(fullLabels.has(sig(l)), `replay label ${sig(l)} exists in the full run`);
  assert.ok(part.drawings.labels.filter(struct).every(l => l.x <= cut.time[K - 1]), 'nothing drawn beyond the cursor');
});

test('DIY Custom Strategy Builder [ZP] runs with its real libraries', () => {
  const lib = p => LIB(`lib/${p}.pine`);
  const src = LIB('zp-diy-custom-strategy-builder.pine');
  const r = runPine(src, { ...series(800), tf: 3600, session: 'fx' }, {}, { libs: { 'TradingView/ZigZag/7': lib('TradingView/ZigZag/7'), 'TradersReality/Traders_Reality_Lib/1': lib('TradersReality/Traders_Reality_Lib/1') } });
  assert.ok(!r.warnings.some(w => /Library/.test(w)), 'libraries loaded');
  assert.equal(r.drawings.tables.length, 1, 'dashboard table');
  assert.ok(r.shapes.some(s => s.text === 'long' || s.text === 'short'), 'signals');
});

test('incremental runs (Bar Replay steps) give exactly the same result as a full recalculation', () => {
  const slice = (d, k) => ({ ...d, time: d.time.slice(0, k), open: d.open.slice(0, k), high: d.high.slice(0, k), low: d.low.slice(0, k), close: d.close.slice(0, k), volume: d.volume.slice(0, k) });
  const lib = p => LIB(`lib/${p}.pine`);
  const libs = { 'TradingView/ZigZag/7': lib('TradingView/ZigZag/7'), 'TradersReality/Traders_Reality_Lib/1': lib('TradersReality/Traders_Reality_Lib/1') };
  for (const [file, tf] of [['luxalgo-smart-money-concepts.pine', 900], ['zp-diy-custom-strategy-builder.pine', 3600]]) {
    const src = LIB(file);
    const all = { ...series(900), tf, session: 'fx' };
    const session = {};
    runPine(src, slice(all, 700), {}, { libs, session });
    let inc;
    for (let k = 701; k <= 900; k += 33) inc = session.extend(slice(all, k)) || inc;
    inc = session.extend(all) || inc;
    const full = runPine(src, all, {}, { libs });
    const norm = r => JSON.stringify({ p: r.plots.map(p => p.values), s: r.shapes, a: r.alerts, d: r.drawings, b: r.barcolors });
    assert.equal(norm(inc), norm(full), `${file}: incremental == full`);
    assert.equal(session.extend({ ...all, close: all.close.map((c, i) => (i === 899 ? c + 1 : c)) }), null, 'a revised last bar forces a full run');
  }
});

test('Gold NY Open Breakout chart indicator signals exactly match the Strategy Tester strategy', async () => {
  const { STRATEGIES } = await import('../../public/js/core/backtest.js');
  // 10 days of synthetic 1-minute candles (EDT), with a trending hour after each 08:20 NY open
  let seed = 3, x = 3000;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [], tf: 60, session: 'fx' };
  const t0 = Date.UTC(2026, 5, 1, 0, 0) / 1000;
  for (let m = 0; m < 10 * 1440; m++) {
    const t = t0 + m * 60, nyMin = ((m % 1440) - 240 + 1440) % 1440;
    const drift = nyMin >= 560 && nyMin < 620 ? (Math.floor(m / 1440) % 2 ? -0.4 : 0.4) : 0;
    const o = x; x += drift + (rnd() - 0.5) * 1.5;
    d.time.push(t); d.open.push(o); d.close.push(x); d.high.push(Math.max(o, x) + rnd()); d.low.push(Math.min(o, x) - rnd()); d.volume.push(0);
  }
  const r = runPine(LIB('gold-ny-open-breakout.pine'), d);
  const bars = d.close.map((c, i) => ({ time: d.time[i], open: d.open[i], high: d.high[i], low: d.low[i], close: c }));
  const sig = STRATEGIES.gold_ny_orb.signal(bars, STRATEGIES.gold_ny_orb.params);
  const eng = sig.map((s, i) => (s && s.dir ? `${i}:${s.dir}` : null)).filter(Boolean);
  const pine = r.alerts.map(a => `${a.i}:${a.message.startsWith('LONG') ? 1 : -1}`);
  assert.ok(eng.length >= 5, `enough signals (${eng.length})`);
  assert.deepEqual(pine, eng);
});
