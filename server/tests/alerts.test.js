import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe, fires, evaluate, REPEAT_COOLDOWN_MS } from '../../public/js/core/alerts.js';

const T0 = 1_760_000_000; // candle times in seconds; `now` in milliseconds
const alertAt = (cond, price, ref, created = T0 * 1000, extra = {}) => ({ id: 'a', cond, price, ref, created, active: true, ...extra });
const bar = (time, open, high, low, close) => ({ time, start: time, open, high, low, close });

test('conditions: crossing in either direction, crossing up/down need the right side first, greater / less than', () => {
  const u = (lo, hi, last) => ({ lo, hi, last });
  assert.ok(fires(alertAt('cross', 100, 99), u(98.5, 100.2, 99.8)), 'wick through the level from below');
  assert.ok(fires(alertAt('cross', 100, 101), u(99.9, 101, 100.5)), 'from above');
  assert.ok(!fires(alertAt('cross', 100, 99), u(98, 99.9, 99.5)), 'never reached');
  assert.ok(fires(alertAt('up', 100, 99), u(99, 100, 100)));
  assert.ok(!fires(alertAt('up', 100, 101), u(99, 101, 99.5)), 'already above: crossing up needs a dip below first');
  assert.ok(fires(alertAt('down', 100, 101), u(99.5, 101, 99.7)));
  assert.ok(!fires(alertAt('down', 100, 99), u(98, 99.5, 98.5)));
  assert.ok(fires(alertAt('above', 100, null), u(99, 100.5, 100.1)));
  assert.ok(!fires(alertAt('above', 100, null), u(99, 100.5, 99.9)), 'greater-than looks at the latest price');
  assert.ok(fires(alertAt('below', 100, null), u(99, 101, 99.9)));
  assert.ok(!fires(alertAt('cross', 100, null), u(90, 110, 100)), 'no reference price yet → no crossing');
});

test('observe: same forming candle reports only new extremes; a new candle reports its whole range', () => {
  let { upd, seen } = observe(null, bar(T0, 100, 101, 99, 100.5), 5_000);
  assert.deepEqual(upd, { lo: 99, hi: 101, last: 100.5, since: T0 * 1000 });
  ({ upd, seen } = observe(seen, bar(T0, 100, 101, 99, 100.2), 6_000));
  assert.deepEqual(upd, { lo: 100.2, hi: 100.5, last: 100.2, since: 5_000 }, 'old high/low are not repeated');
  ({ upd, seen } = observe(seen, bar(T0, 100, 101.4, 99, 101.1), 7_000));
  assert.deepEqual(upd, { lo: 100.2, hi: 101.4, last: 101.1, since: 6_000 }, 'a new high since the last look');
  ({ upd, seen } = observe(seen, bar(T0 + 60, 101, 101.3, 100.8, 101), 8_000));
  assert.deepEqual(upd, { lo: 100.8, hi: 101.3, last: 101, since: 7_000 });
  assert.equal(observe(seen, bar(T0, 1, 1, 1, 1), 9_000).upd, null, 'an older candle is ignored');
});

test('a high made before the alert existed never fires it; once-alerts disarm, every-time alerts re-arm', () => {
  const created = (T0 + 30) * 1000; // created 30 s into a candle whose high (102) was made earlier
  const a = alertAt('cross', 101.5, 100, created);
  const first = observe(null, bar(T0, 100, 102, 99.5, 100.2), created + 1000);
  assert.equal(evaluate(a, first.upd, created + 1000), false, 'range started before the alert: only the last price counts');
  assert.equal(a.ref, 100.2);
  const second = observe(first.seen, bar(T0, 100, 102, 99.5, 101.6), created + 2000);
  assert.equal(evaluate(a, second.upd, created + 2000), true, 'price moved up through 101.5 after creation');
  assert.equal(a.active, false);
  assert.equal(evaluate(a, second.upd, created + 3000), false, 'a fired once-alert stays quiet');

  const r = alertAt('above', 100, 99, created, { repeat: true });
  const up = { lo: 100, hi: 101, last: 100.5, since: created };
  assert.equal(evaluate(r, up, created + 1000), true);
  assert.equal(evaluate(r, { ...up, since: created + 1000 }, created + 2000), false, 'cooldown');
  assert.equal(evaluate(r, { ...up, since: created + 2000 }, created + 1000 + REPEAT_COOLDOWN_MS), true, 'fires again after the cooldown');
  assert.equal(r.active, true);
  assert.equal(r.fireCount, 2);

  const c = alertAt('cross', 100, 99, created, { repeat: true });
  assert.equal(evaluate(c, { lo: 99, hi: 100.5, last: 100.4, since: created }, created + 1000), true);
  assert.equal(evaluate(c, { lo: 100.2, hi: 100.6, last: 100.5, since: created + 1000 }, created + 1000 + 2 * REPEAT_COOLDOWN_MS), false, 'staying above is not a new crossing');
  assert.equal(evaluate(c, { lo: 99.6, hi: 100.5, last: 99.7, since: created + 2000 }, created + 1000 + 3 * REPEAT_COOLDOWN_MS), true, 'crossing back down is');
});

test('updates from a second feed that overlap the last check only use the latest price', () => {
  const created = T0 * 1000;
  const a = alertAt('up', 100, 105, created);
  // feed A sees price fall below the level…
  assert.equal(evaluate(a, { lo: 95, hi: 105, last: 95, since: created }, created + 10_000), false);
  // …feed B (a slower poll) reports a range that started before A's check and still contains the old 105 high
  assert.equal(evaluate(a, { lo: 95, hi: 105, last: 96, since: created + 1000 }, created + 20_000), false, 'no false crossing up');
  assert.equal(evaluate(a, { lo: 96, hi: 100.1, last: 100.1, since: created + 20_000 }, created + 30_000), true);
});

import { changeFires, compareFires, drawingLevels } from '../../public/js/core/alerts.js';

test('percent move: from the low/high seen since the alert was armed, within the window', () => {
  const now = 10_000_000;
  const ticks = [{ at: now - 50 * 60e3, lo: 90, hi: 91, last: 90.5 }, { at: now - 20 * 60e3, lo: 99, hi: 100, last: 100 }, { at: now - 60e3, lo: 100, hi: 101.2, last: 101 }];
  assert.ok(changeFires({ cond: 'up%', pct: 2, windowMin: 30, armedAt: 0 }, ticks, now), '99 → 101 is +2.02% within 30 min');
  assert.equal(changeFires({ cond: 'up%', pct: 2, windowMin: 30, armedAt: now - 5 * 60e3 }, ticks, now), null, 'armed after the low: only 100 → 101');
  assert.ok(changeFires({ cond: 'up%', pct: 10, windowMin: 60, armedAt: 0 }, ticks, now), '90 → 101 within the hour');
  assert.equal(changeFires({ cond: 'down%', pct: 1, windowMin: 60, armedAt: 0 }, ticks, now), null);
});

test('indicator comparisons on closed bars', () => {
  assert.ok(compareFires('up', 29, 31, 30, 30), 'RSI crossing up 30');
  assert.ok(!compareFires('up', 31, 32, 30, 30), 'already above');
  assert.ok(compareFires('cross', 101, 99, 100, 100.5));
  assert.ok(compareFires('above', null, 5, null, 4), 'greater-than needs no previous bar');
  assert.ok(!compareFires('cross', null, 5, null, 4), 'a crossing does');
});

test('drawing levels: trend segment, extended line, horizontal ray, channel', () => {
  const tr = { type: 'trend', pts: [{ time: 100, price: 10 }, { time: 200, price: 20 }] };
  assert.deepEqual(drawingLevels(tr, 150), [15]);
  assert.deepEqual(drawingLevels(tr, 250), [], 'outside the segment');
  assert.deepEqual(drawingLevels({ ...tr, extend: 'right' }, 250), [25]);
  assert.deepEqual(drawingLevels({ type: 'hray', pts: [{ time: 100, price: 7 }] }, 50), []);
  const ch = { type: 'channel', pts: [{ time: 100, price: 10 }, { time: 200, price: 20 }, { time: 150, price: 12 }] };
  assert.deepEqual(drawingLevels(ch, 200), [20, 17]);
});
