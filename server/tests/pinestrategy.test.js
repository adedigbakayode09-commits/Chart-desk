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
