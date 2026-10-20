import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Broker, lotsForRisk, pricePath } from '../../public/js/core/broker.js';
import { runBacktest, computeMetrics } from '../../public/js/core/backtest.js';
import { bySymbol } from '../catalog.js';

const XAU = bySymbol.XAUUSD;
const JPY = bySymbol.USDJPY;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const bar = (time, open, high, low, close, spread = 0.3) => ({ time, open, high, low, close, spread, seconds: 60 });

test('intrabar path follows the nearer extreme first', () => {
  assert.deepEqual(pricePath({ open: 10, high: 11, low: 5, close: 8 }), [10, 11, 5, 8]);
  assert.deepEqual(pricePath({ open: 10, high: 15, low: 9, close: 12 }), [10, 9, 15, 12]);
});

test('market buy pays the ask + slippage, commission per side, TP fills at limit price', () => {
  const b = new Broker(XAU, { balance: 10000, leverage: 100, commissionPerLot: 7, slippage: 0.05, spreadMode: 'data' });
  b.setQuote(2600, 0.3, 0);
  const r = b.placeOrder({ side: 'buy', lots: 0.1, sl: 2595, tp: 2610 });
  assert.ok(r.ok, r.error);
  const p = b.s.positions[0];
  close(p.entry, 2600.35);              // ask 2600.30 + 0.05 slippage
  close(b.s.balance, 10000 - 0.35);     // half of $7 * 0.1 lot
  const ev = b.processBar(bar(60, 2601, 2611, 2600.5, 2609));
  const t = ev.find(e => e.type === 'close').trade;
  assert.equal(t.reason, 'Take-profit');
  close(t.exit, 2610);
  close(t.gross, (2610 - 2600.35) * 10);  // 0.1 lot = 10 oz
  close(t.commission, 0.7);
  close(t.pnl, 96.5 - 0.7);
  close(b.s.balance, 10000 + 96.5 - 0.7);
  close(t.r, t.pnl / ((2600.35 - 2595) * 10));
});

test('stop-loss on a gap fills at the open with slippage; short SL triggers on the ask', () => {
  const b = new Broker(XAU, { balance: 10000, commissionPerLot: 0, slippage: 0.1 });
  b.setQuote(2600, 0.5, 0);
  b.placeOrder({ side: 'buy', lots: 1, sl: 2590 });
  const ev = b.processBar(bar(60, 2580, 2585, 2575, 2582, 0.5)); // gap below SL
  const t = ev.find(e => e.type === 'close').trade;
  close(t.exit, 2580 - 0.1);

  const s = new Broker(XAU, { balance: 10000, commissionPerLot: 0, slippage: 0 });
  s.setQuote(2600, 0.5, 0);
  s.placeOrder({ side: 'sell', lots: 1, sl: 2605 });
  // Bid only reaches 2604.6, but ask = 2605.1 ≥ SL → stopped.
  const ev2 = s.processBar(bar(60, 2600, 2604.6, 2599, 2601, 0.5));
  const t2 = ev2.find(e => e.type === 'close').trade;
  assert.equal(t2.reason, 'Stop-loss');
  close(t2.exit, 2605);
});

test('pending buy stop fills, then its own SL can trigger within the same bar', () => {
  const b = new Broker(XAU, { balance: 10000, commissionPerLot: 0 });
  b.setQuote(2600, 0.2, 0);
  const r = b.placeOrder({ side: 'buy', type: 'stop', price: 2603, lots: 1, sl: 2601 });
  assert.ok(r.ok, r.error);
  // Path: open 2600 → low 2599.5 → high 2604 → close 2600.5 (open nearer the low)
  const ev = b.processBar(bar(60, 2600, 2604, 2599.5, 2600.5, 0.2));
  assert.equal(ev[0].type, 'fill');
  close(ev[0].position.entry, 2603);
  assert.equal(ev[1].type, 'close');
  assert.equal(ev[1].trade.reason, 'Stop-loss');
});

test('USD-base pair converts P&L to USD and position sizing hits the risk target', () => {
  const b = new Broker(JPY, { balance: 10000, commissionPerLot: 0 });
  b.setQuote(150, 0.01, 0);
  b.placeOrder({ side: 'sell', lots: 1, tp: 149 });
  const ev = b.processBar({ time: 60, open: 150, high: 150, low: 148.9, close: 149, spread: 0.01, seconds: 60 });
  const t = ev.find(e => e.type === 'close').trade;
  close(t.gross, (150 - 149) * 100000 / 149, 1e-3); // ¥ P&L / exit price → $
  const lots = lotsForRisk(XAU, { commissionPerLot: 0 }, 10000, 1, 2600, 2590);
  assert.equal(lots, 0.1); // $100 risk / ($10 × 100 oz)
});

test('margin check rejects oversized orders; rewind restores state', () => {
  const b = new Broker(XAU, { balance: 1000, leverage: 10, commissionPerLot: 0 });
  b.setQuote(2600, 0.3, 0);
  const r = b.placeOrder({ side: 'buy', lots: 1 }); // $260k notional / 10 = $26k margin
  assert.equal(r.ok, false);
  assert.match(r.error, /margin/);
  const snap = b.snapshot();
  b.placeOrder({ side: 'buy', lots: 0.01 });
  b.closePosition(b.s.positions[0].id);
  assert.equal(b.s.history.length, 1);
  const removed = b.restore(snap);
  assert.equal(removed.length, 1);
  assert.equal(b.s.history.length, 0);
  assert.equal(b.s.balance, 1000);
});

test('backtest executes on the next bar open and metrics add up', () => {
  // Trend up then down: EMA cross produces a long then a reversal.
  const bars = [];
  let p = 2000;
  for (let i = 0; i < 120; i++) {
    p += i < 60 ? 2 : -2;
    bars.push({ time: i * 3600, start: i * 3600, open: p - 1, high: p + 1.5, low: p - 1.5, close: p, volume: 1, spread: 0.3 });
  }
  const res = runBacktest({
    bars, spec: XAU, strategy: 'ema_cross', params: { fast: 3, slow: 8 }, tfSeconds: 3600,
    settings: { direction: 'both', reverse: true, stopType: 'none', stopValue: 0, targetType: 'none', targetValue: 0, sizing: 'fixed', sizeValue: 0.1, atrLength: 14, exec: { balance: 10000, leverage: 100, commissionPerLot: 0, slippage: 0, spreadMode: 'data', stopOutPct: 50 } },
  });
  assert.ok(res.trades.length >= 1);
  const first = res.trades[0];
  const signalBar = bars.findIndex(b => b.start === first.entryTime) - 1;
  assert.ok(signalBar >= 0, 'entry happens on a bar after the signal');
  close(first.entry, bars[signalBar + 1].open + (first.side === 'buy' ? 0.3 : 0));
  const m = res.metrics;
  close(m.net, res.trades.reduce((a, t) => a + t.pnl, 0));
  close(m.finalEquity, res.equity.at(-1).equity, 1e-6);
  assert.equal(m.wins + m.losses, m.total);
});

test('metrics: profit factor, drawdown and win rate', () => {
  const trades = [{ pnl: 100, commission: 0, side: 'buy', entryTime: 0, exitTime: 10, r: 2 }, { pnl: -50, commission: 0, side: 'sell', entryTime: 10, exitTime: 20, r: -1 }];
  const equity = [{ equity: 1000 }, { equity: 1100 }, { equity: 1050 }];
  const m = computeMetrics(trades, equity, 1000);
  close(m.profitFactor, 2);
  close(m.winRate, 0.5);
  close(m.maxDrawdown, 50);
  close(m.maxDrawdownPct, 50 / 1100);
  close(m.avgR, 0.5);
});

test('buy limit fills at its price when the ask comes down to it; wrong-side limits are rejected', () => {
  const b = new Broker(XAU, { balance: 10000, commissionPerLot: 0, slippage: 0.05 });
  b.setQuote(2600, 0.3, 0);
  assert.equal(b.placeOrder({ side: 'buy', type: 'limit', price: 2601, lots: 1 }).ok, false, 'buy limit above the ask is rejected');
  assert.ok(b.placeOrder({ side: 'buy', type: 'limit', price: 2595, lots: 1, sl: 2590, tp: 2610 }).ok);
  b.processBar(bar(60, 2600, 2601, 2596, 2598, 0.3)); // ask low 2596.3 — not reached
  assert.equal(b.s.positions.length, 0);
  const ev = b.processBar(bar(120, 2598, 2599, 2593, 2597, 0.3)); // ask trades through 2595
  assert.ok(ev.some(e => e.type === 'fill'));
  close(b.s.positions[0].entry, 2595); // limit orders fill at their price, no slippage
  assert.equal(b.s.positions[0].sl, 2590);
});

test('sell limit fills when the bid rises to it; a gap through the level fills at the better open', () => {
  const b = new Broker(XAU, { balance: 10000, commissionPerLot: 0, slippage: 0 });
  b.setQuote(2600, 0.3, 0);
  assert.ok(b.placeOrder({ side: 'sell', type: 'limit', price: 2605, lots: 1 }).ok);
  b.processBar(bar(60, 2608, 2610, 2606, 2609, 0.3)); // opens above the limit
  const pos = b.s.positions[0];
  assert.ok(pos, 'filled');
  assert.ok(pos.entry >= 2605, `sell limit never fills worse than its price (${pos.entry})`);
});

test('Gold NY Open Breakout: one trade per session, stop at range midpoint, no look-ahead, session exit', async () => {
  const { STRATEGIES } = await import('../../public/js/core/backtest.js');
  const strat = STRATEGIES.gold_ny_orb;
  // Two New York sessions of synthetic 1-minute candles around the 08:20 open (EDT: 12:20 UTC)
  const bars = [];
  const day0 = Date.UTC(2026, 5, 2, 10, 0) / 1000; // Tue 06:00 NY
  for (let d = 0; d < 2; d++) for (let m = 0; m < 600; m++) {
    const t = day0 + d * 86400 + m * 60, rel = m - 140; // minutes since 08:20 NY
    let p = 2600 + Math.sin(m / 7) * 2;                // range-bound until the window
    if (rel >= 60 && rel < 120) p = 2600 + (rel - 60) * 0.5 * (d === 0 ? 1 : -1); // breakout up (day 1) / down (day 2)
    if (rel >= 120) p = bars[bars.length - 1].close;
    bars.push({ time: t, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 0 });
  }
  const sig = strat.signal(bars, strat.params);
  const entries = sig.map((s, i) => [s, i]).filter(([s]) => s && s.dir);
  assert.equal(entries.length, 2, 'one entry per session');
  const [[up, iu], [dn, id]] = entries;
  assert.equal(up.dir, 1); assert.equal(dn.dir, -1);
  // the entry bar is inside the entry window and the stop is the midpoint of that day's 60-minute range
  const rangeOf = d => bars.slice(d * 600 + 140, d * 600 + 200);
  const mid = r => (Math.max(...r.map(b => b.high)) + Math.min(...r.map(b => b.low))) / 2;
  assert.ok(Math.abs(up.sl - mid(rangeOf(0))) < 1e-9);
  assert.ok(Math.abs(dn.sl - mid(rangeOf(1))) < 1e-9);
  assert.ok(bars[iu].close > Math.max(...rangeOf(0).map(b => b.high)), 'entry needs a close beyond the range');
  // no look-ahead: signals computed on a prefix are identical
  const prefix = strat.signal(bars.slice(0, iu + 1), strat.params);
  assert.deepEqual(prefix[iu], up);
  // flat signal 120 minutes after the entry window
  assert.ok(sig.some((s, i) => s && s.exit && i - 600 * 0 === 140 + 60 + 60 + 120));
});
