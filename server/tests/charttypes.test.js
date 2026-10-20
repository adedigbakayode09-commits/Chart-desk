import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renko, kagi, pointFigure, lineBreak, rangeBars, boxSize, transform } from '../../public/js/core/charttypes.js';

const T0 = 1_760_000_000;
const closes = cs => cs.map((c, i) => ({ time: T0 + i * 60, start: T0 + i * 60, open: i ? cs[i - 1] : c, high: Math.max(c, i ? cs[i - 1] : c), low: Math.min(c, i ? cs[i - 1] : c), close: c, volume: 1 }));
const increasing = bars => bars.every((b, i) => !i || b.time > bars[i - 1].time);

test('renko: a box per full move, reversals need two boxes, times strictly increase', () => {
  const r = renko(closes([100, 101, 103.2, 102.5, 101.9, 100.9, 99.9]), 1);
  assert.deepEqual(r.map(b => [b.open, b.close]), [[100, 101], [101, 102], [102, 103], [102, 101], [101, 100]]);
  assert.ok(increasing(r), 'two boxes from one candle get consecutive seconds');
  assert.equal(r.reduce((a, b) => a + b.volume, 0) <= 7, true);
});

test('kagi: extends with the trend, turns on a reversal amount, yang above the last shoulder', () => {
  const k = kagi(closes([100, 102, 104, 103, 101, 102, 105.5]), 2);
  assert.deepEqual(k.map(b => [b.open, b.close]), [[100, 100], [100, 104], [104, 101], [101, 105.5]]);
  assert.equal(k[3].yang, true, 'broke above the 104 shoulder');
});

test('point & figure: X/O columns on box multiples with a 3-box reversal', () => {
  const p = pointFigure(closes([100, 101, 102.5, 104, 103, 100.4, 99.9]), 1, 3);
  assert.equal(p.length, 2);
  assert.deepEqual([p[0].x, p[0].open, p[0].close], [true, 100, 104]);
  assert.deepEqual([p[1].x, p[1].open, p[1].close], [false, 103, 100], 'O column starts one box below the top');
});

test('line break: new extremes extend, a reversal must break the last 3 lines', () => {
  const l = lineBreak(closes([100, 101, 102, 103, 101.5, 99.5]), 3);
  assert.deepEqual(l.map(b => [b.open, b.close]), [[100, 101], [101, 102], [102, 103], [102, 99.5]]);
});

test('range bars: each completed bar spans exactly the range', () => {
  const bars = [{ time: T0, open: 100, high: 105.2, low: 99.5, close: 104, volume: 10 }];
  const r = rangeBars(bars, 2);
  for (const b of r.slice(0, -1)) assert.equal(+(b.high - b.low).toFixed(9), 2);
  assert.ok(r[r.length - 1].partial, 'the last bar is still forming');
  assert.ok(increasing(r));
});

test('box size: fixed, percent and rounded ATR', () => {
  const bars = closes([100, 101, 102, 101, 103, 104, 103, 105, 106, 104, 107, 108, 106, 109, 110, 111]);
  assert.equal(boxSize(bars, { method: 'fixed', value: 2.5 }), 2.5);
  assert.equal(boxSize(bars, { method: 'pct', value: 1 }), 1.11);
  assert.ok([1, 2, 5].includes(boxSize(bars, { method: 'atr', atrLength: 14 })));
  assert.ok(transform('renko', bars).bars.length > 0);
});
