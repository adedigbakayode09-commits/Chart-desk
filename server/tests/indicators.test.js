import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../public/js/core/indicators.js';

const T0 = 1_760_000_000;
const mk = (rows) => rows.map(([o, h, l, c, v = 100], i) => ({ time: T0 + i * 3600, start: T0 + i * 3600, open: o, high: h, low: l, close: c, volume: v }));
const wave = n => mk(Array.from({ length: n }, (_, i) => { const c = 100 + 10 * Math.sin(i / 6) + i * 0.1; return [c - 0.5, c + 1, c - 1, c, 100 + (i % 7) * 10]; }));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('weighted and hull moving averages', () => {
  near(I.wma([1, 2, 3, 4], 3)[3], (2 * 1 + 3 * 2 + 4 * 3) / 6);
  const h = I.hma(wave(80).map(b => b.close), 16);
  assert.equal(h.slice(0, 15).every(v => v == null), true);
  assert.ok(h.slice(30).every(Number.isFinite));
});

test('pivot points from the previous day', () => {
  const day = 86400, bars = [
    { time: 0, start: 0, open: 10, high: 12, low: 8, close: 11 },
    { time: 3600, start: 3600, open: 11, high: 13, low: 9, close: 10 },
    { time: day, start: day, open: 10, high: 10.5, low: 9.5, close: 10 },
  ];
  const p = I.pivots(bars, 'traditional');
  assert.equal(p.P[1], null, 'no levels during the first day');
  near(p.P[2], (13 + 8 + 10) / 3);
  near(p.R1[2], 2 * p.P[2] - 8);
  near(p.S3[2], 8 - 2 * (13 - p.P[2]));
  near(I.pivots(bars, 'camarilla').R3[2], 10 + 5 * 1.1 / 4);
});

test('supertrend follows the trend and flips on a close through the band', () => {
  const up = mk(Array.from({ length: 40 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i]));
  const down = mk(Array.from({ length: 30 }, (_, i) => [140 - 3 * i, 141 - 3 * i, 138 - 3 * i, 139 - 3 * i]));
  const st = I.supertrend([...up, ...down].map((b, i) => ({ ...b, time: T0 + i * 3600 })), 10, 3);
  assert.equal(st.dir[35], 1);
  assert.equal(st.dir[st.dir.length - 1], -1);
  assert.ok(st.line[35] < up[35].low, 'support below price in an up trend');
});

test('ichimoku shifts the leading spans forward and the lagging span back', () => {
  const bars = wave(120), ich = I.ichimoku(bars, 9, 26, 52, 26);
  assert.equal(ich.leadA.length, bars.length + 25);
  assert.equal(ich.lag[bars.length - 26], bars[bars.length - 1].close);
  near(ich.leadA[60 + 25], (ich.tenkan[60] + ich.kijun[60]) / 2);
});

test('oscillators stay in range', () => {
  const bars = wave(150);
  for (const v of I.williamsR(bars, 14).filter(x => x != null)) assert.ok(v <= 0 && v >= -100);
  for (const v of I.mfi(bars, 14).filter(x => x != null)) assert.ok(v >= 0 && v <= 100);
  const a = I.adx(bars, 14, 14);
  assert.ok(a.adx.filter(x => x != null).every(v => v >= 0 && v <= 100));
  const ar = I.aroon(bars, 14);
  assert.ok(ar.up.filter(x => x != null).every(v => v >= 0 && v <= 100));
  const s = I.stochRsi(bars.map(b => b.close));
  assert.ok(s.k.filter(x => x != null).every(v => v >= -1e-9 && v <= 100 + 1e-9), 'rolling sums may drift by ~1e-15');
  assert.ok(I.cci(bars, 20).filter(x => x != null).length > 100);
  assert.ok(I.psar(bars).slice(1).every(Number.isFinite));
});

test('volume profile: total volume kept, POC and a 70% value area around it', () => {
  const bars = wave(100), vp = I.volumeProfile(bars, 0, 99, 20, 70);
  near(vp.total, bars.reduce((a, b) => a + b.volume, 0), 1e-6);
  assert.ok(vp.vaLow <= vp.poc && vp.poc <= vp.vaHigh);
  const inVa = vp.bins.slice(vp.vaLow, vp.vaHigh + 1).reduce((a, b) => a + b.total, 0);
  assert.ok(inVa >= vp.total * 0.7 - 1e-6);
});
