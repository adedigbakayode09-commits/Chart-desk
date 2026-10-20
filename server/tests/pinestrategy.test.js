import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPine } from '../../public/js/core/pine.js';

// Hand-made candles: [open, high, low, close]
const mk = rows => {
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [], tf: 3600, mintick: 0.01 };
  rows.forEach(([o, h, l, c], i) => { d.time.push(1700000000 + i * 3600); d.open.push(o); d.high.push(h); d.low.push(l); d.close.push(c); d.volume.push(100); });
  return d;
};
const run = (body, rows, header = 'strategy("t", overlay=true)') => runPine(`//@version=6\n${header}\n${body}`, mk(rows)).strategy;

test('market entry fills at the next bar open; strategy.close at the following open', () => {
  const s = run(`if bar_index == 1\n    strategy.entry("L", strategy.long)\nif bar_index == 3\n    strategy.close("L")`,
    [[100, 101, 99, 100], [100, 102, 99, 101], [102, 103, 101, 102], [103, 104, 102, 103], [105, 106, 104, 105], [105, 105, 104, 104]]);
  assert.equal(s.trades.length, 1);
  const t = s.trades[0];
  assert.deepEqual([t.side, t.entry, t.exit, t.lots], ['buy', 102, 105, 1]);
  assert.equal(t.pnl, 3);
});

test('strategy.exit profit / loss in ticks fill at the exact levels; reversal closes the opposite position', () => {
  const s = run(`if bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("x", "L", profit=200, loss=100)`,
    [[100, 100, 100, 100], [100, 101, 99.5, 100.5], [100.5, 102.5, 100, 102]]);
  assert.equal(s.trades.length, 1);
  assert.deepEqual([s.trades[0].exit, s.trades[0].reason], [102, 'Take-profit'], 'TP = entry + 200 ticks');
  const r = run(`if bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 1\n    strategy.entry("S", strategy.short)`,
    [[100, 100, 100, 100], [101, 101, 101, 101], [99, 99, 99, 99], [98, 98, 98, 98]]);
  assert.equal(r.trades.length, 1);
  assert.deepEqual([r.trades[0].entry, r.trades[0].exit, r.trades[0].reason], [101, 99, 'Reverse']);
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].side, 'sell');
});

test('limit and stop entries: touched intrabar, gaps fill at the open', () => {
  const s = run(`if bar_index == 0\n    strategy.entry("B", strategy.long, limit=98)`,
    [[100, 100, 100, 100], [100, 100.5, 97.5, 99], [99, 99, 99, 99]]);
  assert.equal(s.open[0].entry, 98, 'buy limit fills at its price when the low reaches it');
  const g = run(`if bar_index == 0\n    strategy.entry("B", strategy.long, stop=101)`,
    [[100, 100, 100, 100], [103, 104, 102.5, 103.5], [103, 103, 103, 103]]);
  assert.equal(g.open[0].entry, 103, 'buy stop gapped over: fills at the open');
});

test('pyramiding limits extra entries; % of equity sizing and commission', () => {
  const rows = Array.from({ length: 6 }, () => [100, 100, 100, 100]);
  const one = run(`strategy.entry("L", strategy.long)`, rows);
  assert.equal(one.open.length, 1, 'pyramiding 0: one entry');
  const three = run(`strategy.entry("L" + str.tostring(bar_index), strategy.long)`, rows, 'strategy("t", pyramiding=3)');
  assert.equal(three.open.length, 3);
  const pct = run(`if bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 2\n    strategy.close("L")`, rows,
    'strategy("t", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1)');
  const t = pct.trades[0];
  assert.equal(t.lots, 50, '50% of 10,000 at 100');
  assert.ok(Math.abs(t.commission - 10) < 1e-9, '0.1% of 5,000 on entry and on exit');
  assert.ok(Math.abs(t.pnl + 10) < 1e-9);
});

test('process_orders_on_close fills at the signal bar close; trailing stop follows the high', () => {
  const s = run(`if bar_index == 1\n    strategy.entry("L", strategy.long)`, [[100, 100, 100, 100], [100, 101, 99, 100.7], [101, 101, 101, 101]], 'strategy("t", process_orders_on_close=true)');
  assert.equal(s.open[0].entry, 100.7);
  const tr = run(`if bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("T", "L", trail_points=100, trail_offset=50)`,
    [[100, 100, 100, 100], [100, 103, 100, 102.8], [102.8, 102.9, 101, 101.5]]);
  assert.equal(tr.trades.length, 1);
  assert.equal(tr.trades[0].reason, 'Trailing stop');
  assert.ok(Math.abs(tr.trades[0].exit - 102.5) < 1e-9, 'best 103 − 50 ticks');
});

test('strategy variables: position size, average price, closed trades', () => {
  const r = runPine(`//@version=6
strategy("v")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
plot(strategy.position_size, "size")
plot(strategy.position_avg_price, "avg")
plot(strategy.closedtrades, "closed")`, mk([[10, 10, 10, 10], [11, 11, 11, 11], [12, 12, 12, 12]]));
  const p = t => r.plots.find(x => x.title === t).values;
  assert.deepEqual(p('size'), [0, 2, 2]);
  assert.equal(p('avg')[2], 11);
});

test('on-close orders fill after execution, including the first bar', () => {
  const r = runPine(`//@version=6
strategy("close", process_orders_on_close=true, pyramiding=10)
if bar_index == 0
    strategy.entry("A", strategy.long)
plot(strategy.opentrades, "seen")`, mk([[100, 100, 100, 100], [101, 101, 101, 101]]));
  assert.deepEqual(r.plots[0].values, [0, 1]);
  assert.equal(r.strategy.open[0].entryBar, 0);
  assert.equal(r.strategy.open[0].entry, 100);
});

test('FIFO exits use oldest entries; ANY exits use the requested entry', () => {
  const body = `if bar_index == 0
    strategy.entry("A", strategy.long, qty=2)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=1)
if bar_index == 2
    strategy.close("B")`;
  const rows = [[100,100,100,100],[110,110,110,110],[120,120,120,120],[120,120,120,120]];
  for (const rule of ['FIFO', 'ANY']) {
    const s = run(body, rows, `strategy("fifo", pyramiding=10, process_orders_on_close=true, close_entries_rule="${rule}")`);
    assert.equal(s.trades.length, 1);
    assert.equal(s.trades[0].note, rule === 'FIFO' ? 'A' : 'B');
    assert.equal(s.trades[0].lots, 1);
    assert.equal(s.trades[0].pnl, rule === 'FIFO' ? 20 : 10);
  }
});

test('FIFO bracket quantity does not repeatedly consume an older position', () => {
  const s = run(`if bar_index == 0
    strategy.entry("A", strategy.long, qty=3)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=1)
    strategy.exit("xB", "B", limit=115)`,
  [[100,100,100,100],[110,110,110,110],[110,120,109,116]],
  'strategy("fifo", pyramiding=10, process_orders_on_close=true)');
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].lots, 1);
  assert.equal(s.trades[0].note, 'A');
  assert.equal(s.open.reduce((s,t)=>s+t.lots,0), 3);
});

test('FIFO retains the older bracket and its original quantity after a newer exit fills', () => {
  const s = run(`if bar_index == 0
    strategy.entry("A", strategy.short, qty=5)
    strategy.exit("xA", "A", limit=90)
if bar_index == 1
    strategy.entry("B", strategy.short, qty=6)
    strategy.exit("xB", "B", limit=95)`,
  [[100,100,100,100],[100,100,100,100],[100,101,89,90]],
  'strategy("brackets", pyramiding=10, process_orders_on_close=true)');
  assert.deepEqual(s.trades.map(t=>[t.note,t.lots,t.exit,t.exitBar]), [['A',5,95,2],['B',1,95,2],['B',5,90,2]]);
  assert.equal(s.open.length,0);
});

test('updating a bracket does not shrink it to its FIFO-reduced reference entry', () => {
  const s = run(`if bar_index == 0
    strategy.entry("A", strategy.short, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.short, qty=3)
strategy.exit("xA", "A", limit=90)
strategy.exit("xB", "B", limit=95)`,
  [[100,100,100,100],[100,100,100,100],[100,101,94,96],[96,97,89,90]],
  'strategy("modify", pyramiding=10, process_orders_on_close=true)');
  assert.deepEqual(s.trades.map(t=>[t.note,t.lots,t.exit]),[['A',3,95],['A',2,90],['B',3,90]]);
  assert.equal(s.open.length,0);
});

test('a filled exit is not rearmed against its remaining FIFO reference entry', () => {
  const s = run(`if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=2)
strategy.exit("xB", "B", limit=110)`,
  [[100,100,100,100],[100,100,100,100],[100,111,99,105],[105,111,104,110]],
  'strategy("once", pyramiding=10, process_orders_on_close=true)');
  assert.deepEqual(s.trades.map(t=>[t.note,t.lots]),[['A',2]]);
  assert.equal(s.open.reduce((sum,t)=>sum+t.lots,0),5);
});

test('runtime.error stops a strategy on the wrong chart timeframe', () => {
  assert.throws(() => runPine(`//@version=6
strategy("guard")
if timeframe.in_seconds() < 900
    runtime.error("Use 15m")`, {...mk([[100,100,100,100]]),tf:300}), /Use 15m/);
});

test('saved input.time values remain numeric timestamps', () => {
  const r=runPine(`//@version=6
indicator("date")
t=input.time(timestamp("2000-01-01T00:00:00Z"), "Start")
plot(t+1)`, mk([[100,100,100,100]]), {Start:'946684800000'});
  assert.equal(r.plots[0].values[0], 946684800001);
});

test('Pepperstone Gold fills use 0.1-unit quantities and valid outward trigger ticks', () => {
  const check = (dir, qty, entry, stop, limit, row, expected) => {
    const body = `strategy("gold", process_orders_on_close=true, initial_capital=10000, commission_type=strategy.commission.cash_per_contract, commission_value=0.2)
if bar_index == 0
    strategy.entry("G", strategy.${dir}, qty=${qty})
    strategy.exit("x", "G", ${stop == null ? `limit=${limit}` : `stop=${stop}`})`;
    const r=runPine(body,{...mk([[entry,entry,entry,entry],row]),mintick:0.01,qtyStep:0.1}).strategy;
    const t=r.trades[0];
    assert.deepEqual([t.lots,t.exit,Number(t.pnl.toFixed(2))],expected);
  };
  check('long',47.6600557,4056.27,4045.7790345,null,[4056.27,4057,4040,4048],[47.6,4045.77,-518.84]);
  check('long',48.3296,4052.78,null,4059.563,[4052.78,4060,4051,4059],[48.3,4059.57,308.64]);
  check('short',53.60985,4052.76,4060.70358,null,[4052.76,4062,4050,4061],[53.6,4060.71,-447.56]);
  check('short',2.19,100,null,95.237,[100,101,94,95],[2.1,95.23,9.18]);
});

test('a quantity below the provider minimum does not become a default-sized order', () => {
  const r=runPine(`strategy("min",process_orders_on_close=true)
strategy.entry("tiny",strategy.long,qty=0.09)`,{...mk([[100,100,100,100]]),qtyStep:0.1});
  assert.equal(r.strategy.open.length,0);
});
