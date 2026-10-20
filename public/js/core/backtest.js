// Automated strategy backtesting (pure, no DOM).
// Signals are evaluated on CLOSED bars and executed at the NEXT bar's open — no look-ahead.
// All fills go through the same Broker as manual trading, optionally driven by real 1-minute bars
// inside each candle ("intrabar precision"), which removes most candle-ordering ambiguity.

import { Broker, lotsForRisk, quoteToUsd, roundLots } from './broker.js';
import { ema, sma, rsi, macd, bollinger, donchian, atr } from './indicators.js';
import { nyOffset } from './sessions.js';

const crossUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];

/** Minute of the New York day (DST-aware) and a trading-day key that rolls over at 18:00 New York. */
const nyClock = t => { const l = t + nyOffset(t); return { min: Math.floor((((l % 86400) + 86400) % 86400) / 60), day: Math.floor((l + 6 * 3600) / 86400) }; };

/**
 * Opening-range breakout on a New York session clock. The range is the high/low of the first `rangeMin`
 * minutes after `open`; a close beyond it (plus a buffer) inside the entry window enters once per session,
 * with the stop at the range midpoint (or far side). Positions are closed `holdMin` after the window ends.
 */
function sessionBreakout(bars, { open, rangeMin, windowMin, holdMin, buf, mid, maxTrades = 1 }, out, atrv) {
  const since = m => (m - open + 1440) % 1440;
  const exitAt = rangeMin + windowMin + holdMin;
  let day = null, rh = -Infinity, rl = Infinity, trades = 0, lastDir = 0, prev = null;
  for (let i = 1; i < bars.length; i++) {
    const c = nyClock(bars[i].time), b = bars[i];
    if (c.day !== day) { day = c.day; rh = -Infinity; rl = Infinity; trades = 0; lastDir = 0; prev = null; }
    const rel = since(c.min);
    if (rel < rangeMin) { rh = Math.max(rh, b.high); rl = Math.min(rl, b.low); prev = rel; continue; }
    if (prev != null && prev < exitAt && rel >= exitAt && !out[i]) out[i] = { exit: true, reason: 'Session exit' };
    prev = rel;
    const a = atrv[i];
    if (trades >= maxTrades || a == null || !(rh > rl) || rel >= rangeMin + windowMin) continue;
    // Second chance: after a failed breakout, a close beyond the OTHER side of the range (which is past the first
    // trade's midpoint stop, so that trade is already closed) can trade once in the opposite direction.
    const pad = buf * a;
    if (b.close > rh + pad && lastDir !== 1) { out[i] = { dir: 1, sl: mid ? (rh + rl) / 2 : rl }; trades++; lastDir = 1; }
    else if (b.close < rl - pad && lastDir !== -1) { out[i] = { dir: -1, sl: mid ? (rh + rl) / 2 : rh }; trades++; lastDir = -1; }
  }
}

export const STRATEGIES = {
  gold_ny_orb: {
    name: 'Gold NY Open Breakout (1m)',
    desc: 'Built for XAUUSD on the 1-minute chart. Marks the high/low of the first 60 minutes after the COMEX gold open (08:20 New York, DST-aware) and trades the breakout in the next hour — plus one second chance in the other direction if the first breakout fails. Stop at the range midpoint, trailing 1R behind the best price, 2R target, flat two hours later. Researched on Jan–Oct 2026 Twelve Data 1-minute candles with spread, slippage and commission (docs/gold-ny-open-breakout.md).',
    params: { openHour: 8, openMinute: 20, rangeMinutes: 60, entryWindowMinutes: 60, flatAfterMinutes: 120, bufferAtr: 0.5, stopAtMidpoint: true, secondChance: true, londonSession: false },
    labels: {
      openHour: 'Open hour (New York)', openMinute: 'Open minute', rangeMinutes: 'Range length (min)', entryWindowMinutes: 'Entry window (min)',
      flatAfterMinutes: 'Close after window (min)', bufferAtr: 'Breakout buffer (× ATR 60)', stopAtMidpoint: 'Stop at range midpoint',
      secondChance: 'Second chance (opposite breakout)', londonSession: 'Also trade London (Asian range)',
    },
    recommended: { stopType: 'strategy', targetType: 'rr', targetValue: 2, sizing: 'risk', sizeValue: 0.5, reverse: false, direction: 'both', maxBars: 0, breakevenR: 0, trailR: 1 },
    timeframe: '1m', // designed and tested on 1-minute candles only
    signal(bars, p) {
      const out = new Array(bars.length).fill(0);
      const atrv = atr(bars, 60);
      const mid = p.stopAtMidpoint !== false && p.stopAtMidpoint !== 0;
      const maxTrades = p.secondChance === false || p.secondChance === 0 ? 1 : 2;
      sessionBreakout(bars, { open: p.openHour * 60 + p.openMinute, rangeMin: p.rangeMinutes, windowMin: p.entryWindowMinutes, holdMin: p.flatAfterMinutes, buf: p.bufferAtr, mid, maxTrades }, out, atrv);
      if (p.londonSession === true || p.londonSession === 1) {
        // Asian range 19:00–03:00 New York, London breakout 03:00–06:00, flat by 08:00 (before the NY range ends)
        const ldn = new Array(bars.length).fill(0);
        sessionBreakout(bars, { open: 19 * 60, rangeMin: 480, windowMin: 180, holdMin: 120, buf: p.bufferAtr, mid }, ldn, atrv);
        ldn.forEach((sig, i) => { if (sig && (!out[i] || out[i].exit)) out[i] = sig; });
      }
      return out;
    },
  },
  ema_cross: {
    name: 'EMA crossover', desc: 'Long when the fast EMA crosses above the slow EMA, short on the cross below.',
    params: { fast: 9, slow: 21 },
    signal(bars, p) { const c = bars.map(b => b.close), f = ema(c, p.fast), s = ema(c, p.slow); return bars.map((_, i) => (i && crossUp(f, s, i) ? 1 : i && crossDn(f, s, i) ? -1 : 0)); },
  },
  sma_cross: {
    name: 'SMA crossover', desc: 'Long when the fast SMA crosses above the slow SMA, short on the cross below.',
    params: { fast: 20, slow: 50 },
    signal(bars, p) { const c = bars.map(b => b.close), f = sma(c, p.fast), s = sma(c, p.slow); return bars.map((_, i) => (i && crossUp(f, s, i) ? 1 : i && crossDn(f, s, i) ? -1 : 0)); },
  },
  rsi_revert: {
    name: 'RSI mean reversion', desc: 'Long when RSI crosses back above oversold, short when it crosses back below overbought.',
    params: { length: 14, oversold: 30, overbought: 70 },
    signal(bars, p) {
      const r = rsi(bars.map(b => b.close), p.length);
      return bars.map((_, i) => (i && r[i - 1] != null && r[i - 1] <= p.oversold && r[i] > p.oversold ? 1 : i && r[i - 1] != null && r[i - 1] >= p.overbought && r[i] < p.overbought ? -1 : 0));
    },
  },
  bb_revert: {
    name: 'Bollinger reversion', desc: 'Long when price closes back inside the lower band, short when it closes back inside the upper band.',
    params: { length: 20, mult: 2 },
    signal(bars, p) {
      const c = bars.map(b => b.close), bb = bollinger(c, p.length, p.mult);
      return bars.map((_, i) => (i && bb.lower[i - 1] != null && c[i - 1] < bb.lower[i - 1] && c[i] > bb.lower[i] ? 1 : i && bb.upper[i - 1] != null && c[i - 1] > bb.upper[i - 1] && c[i] < bb.upper[i] ? -1 : 0));
    },
  },
  donchian: {
    name: 'Donchian breakout', desc: 'Long on a close above the prior N-bar high, short on a close below the prior N-bar low.',
    params: { length: 20 },
    signal(bars, p) { const d = donchian(bars, p.length); return bars.map((b, i) => (d.upper[i] != null && b.close > d.upper[i] ? 1 : d.lower[i] != null && b.close < d.lower[i] ? -1 : 0)); },
  },
  macd_cross: {
    name: 'MACD signal cross', desc: 'Long when MACD crosses above its signal line, short when it crosses below.',
    params: { fast: 12, slow: 26, signal: 9 },
    signal(bars, p) { const m = macd(bars.map(b => b.close), p.fast, p.slow, p.signal); return bars.map((_, i) => (i && crossUp(m.line, m.signal, i) ? 1 : i && crossDn(m.line, m.signal, i) ? -1 : 0)); },
  },
};

export const DEFAULT_SETTINGS = {
  direction: 'both', reverse: true,
  stopType: 'atr', stopValue: 1.5, targetType: 'rr', targetValue: 2, atrLength: 14, maxBars: 0,
  breakevenR: 0, trailR: 0, // trade management in R (risk) units; 0 = off
  sizing: 'risk', sizeValue: 1,
  intrabar: 'm1',
  exec: { balance: 10000, leverage: 100, slippage: 0, spreadMode: 'data', stopOutPct: 50 },
};

export function validateSettings(s) {
  if (s.sizing === 'risk' && s.stopType === 'none') return 'Risk-based sizing needs a stop-loss (choose ATR or points).';
  if (!(s.sizeValue > 0)) return 'Position size must be greater than zero.';
  if (s.stopType !== 'none' && s.stopType !== 'strategy' && !(s.stopValue > 0)) return 'Stop distance must be greater than zero.';
  if (s.targetType !== 'none' && !(s.targetValue > 0)) return 'Target must be greater than zero.';
  if (s.targetType === 'rr' && s.stopType === 'none') return 'An R:R target needs a stop-loss.';
  return null;
}

/**
 * bars: [{ time, start, open, high, low, close, volume, spread }] on the test timeframe.
 * minutes (optional): sorted 1-minute bars covering the same span, for intrabar fills.
 */
export function runBacktest({ bars, spec, strategy, params, settings, tfSeconds, minutes = null, onProgress, strategyDef = null }) {
  const err = validateSettings(settings);
  if (err) throw new Error(err);
  const strat = strategyDef || STRATEGIES[strategy];
  if (!strat) throw new Error(`Unknown strategy ${strategy}`);
  if (bars.length < 3) throw new Error('Not enough bars in the selected range.');
  const exec = { ...settings.exec };
  const broker = new Broker(spec, exec);
  const signals = strat.signal(bars, params);
  const atrv = atr(bars, settings.atrLength || 14);
  const equity = [];
  const rejected = [];
  let pending = null, mi = 0, entryBar = -1;
  const useMinutes = !!(minutes && minutes.length);

  // Signals: +1 / -1, or { dir, sl, tp } with strategy-defined levels, or { exit: true } to go flat.
  const sigOf = v => (!v ? null : typeof v === 'number' ? { dir: Math.sign(v) } : v);
  const enter = (side, k, sig) => {
    const q = broker.quote;
    const ref = side === 'buy' ? q.ask : q.bid;
    const dir = side === 'buy' ? 1 : -1;
    let stopDist = null, sl = null;
    if (settings.stopType === 'strategy' && sig.sl != null) {
      // structure stop from the strategy; skip the trade if the open already gapped through it
      if (!((ref - sig.sl) * dir > 0)) { rejected.push({ time: q.time, side, reason: 'Opened beyond the strategy stop' }); return; }
      sl = sig.sl; stopDist = Math.abs(ref - sl);
    } else {
      if (settings.stopType === 'atr' || settings.stopType === 'strategy') stopDist = atrv[k] != null ? atrv[k] * (settings.stopType === 'atr' ? settings.stopValue : 1.5) : null;
      else if (settings.stopType === 'points') stopDist = settings.stopValue;
      if (settings.stopType !== 'none' && stopDist == null) return; // ATR still warming up
      sl = stopDist != null ? ref - dir * stopDist : null;
    }
    let tp = null;
    if (settings.targetType === 'strategy' && sig.tp != null && (sig.tp - ref) * dir > 0) tp = sig.tp;
    else if (settings.targetType === 'rr' || settings.targetType === 'strategy') tp = stopDist != null ? ref + dir * stopDist * (settings.targetType === 'rr' ? settings.targetValue : 2) : null;
    else if (settings.targetType === 'atr' && atrv[k] != null) tp = ref + dir * atrv[k] * settings.targetValue;
    else if (settings.targetType === 'points') tp = ref + dir * settings.targetValue;
    let lots;
    if (settings.sizing === 'risk') lots = lotsForRisk(spec, broker.cfg, broker.equity, settings.sizeValue, ref, sl);
    else if (settings.sizing === 'fixed') lots = settings.sizeValue;
    else lots = roundLots(spec, broker.equity * settings.sizeValue / 100 / quoteToUsd(spec, ref * spec.contractSize, ref));
    const res = broker.placeOrder({ side, type: 'market', lots, sl, tp, note: strat.name });
    if (!res.ok) rejected.push({ time: q.time, side, reason: res.error });
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const start = bar.start ?? bar.time;
    const end = bars[i + 1]?.start ?? bars[i + 1]?.time ?? start + tfSeconds;

    if (pending) {
      broker.setQuote(bar.open, bar.spread, start);
      const open = broker.s.positions[0];
      if (pending.exit) {
        if (open) broker.closePosition(open.id, { reason: pending.reason || 'Strategy exit' });
      } else {
        const side = pending.dir > 0 ? 'buy' : 'sell';
        const allowed = settings.direction === 'both' || (settings.direction === 'long' && pending.dir > 0) || (settings.direction === 'short' && pending.dir < 0);
        if (open && open.side !== side && settings.reverse) broker.closePosition(open.id, { reason: 'Reverse signal' });
        if (!broker.s.positions.length && allowed) { enter(side, i - 1, pending); if (broker.s.positions.length) entryBar = i; }
      }
      pending = null;
    }

    if (useMinutes) {
      while (mi < minutes.length && minutes[mi].time < start) mi++;
      let fed = false;
      while (mi < minutes.length && minutes[mi].time < end) { broker.processBar({ ...minutes[mi], seconds: 60 }); mi++; fed = true; }
      if (!fed) broker.processBar({ ...bar, time: start, seconds: end - start });
    } else {
      broker.processBar({ ...bar, time: start, seconds: end - start });
    }
    // Trade management at the bar close (takes effect from the next bar — conservative, no intrabar guessing):
    // breakeven once the trade has run breakevenR in profit; trailing stop trailR behind the best price.
    if (settings.breakevenR > 0 || settings.trailR > 0) {
      for (const p of broker.s.positions) {
        const risk = p.initialSl != null ? Math.abs(p.entry - p.initialSl) : 0;
        if (!(risk > 0)) continue;
        const dir = p.side === 'buy' ? 1 : -1;
        const best = dir > 0 ? Math.max(p.bestPrice ?? p.entry, bar.high) : Math.min(p.bestPrice ?? p.entry, bar.low);
        p.bestPrice = best;
        const run = (best - p.entry) * dir;
        let sl = p.sl;
        if (settings.breakevenR > 0 && run >= settings.breakevenR * risk) { const be = p.entry; if (sl == null || (be - sl) * dir > 0) sl = be; }
        if (settings.trailR > 0) { const tr = best - dir * settings.trailR * risk; if (sl == null || (tr - sl) * dir > 0) sl = tr; }
        if (sl !== p.sl) p.sl = sl;
      }
    }
    // Mark-to-market at the bar's close.
    broker.s.bid = bar.close;
    equity.push({ time: bar.time, equity: broker.equity, balance: broker.s.balance });
    const sig = sigOf(signals[i]);
    if (sig) pending = sig;
    // time exit: close at the next open once a trade has been open for maxBars candles
    else if (settings.maxBars > 0 && broker.s.positions.length && i - entryBar + 1 >= settings.maxBars) pending = { exit: true, reason: 'Time exit' };
    if (onProgress && i % 2000 === 0) onProgress(i / bars.length);
  }
  for (const p of [...broker.s.positions]) broker.closePosition(p.id, { reason: 'End of test' });
  if (equity.length) equity[equity.length - 1] = { ...equity[equity.length - 1], equity: broker.s.balance, balance: broker.s.balance };

  const trades = broker.s.history;
  return {
    trades, equity, rejected,
    metrics: computeMetrics(trades, equity, exec.balance, bars, tfSeconds),
    spreadInfo: { dataMinutes: broker.s.dataSpreadMinutes, fixedMinutes: broker.s.fixedSpreadMinutes },
    intrabar: useMinutes ? 'm1' : 'ohlc',
  };
}

export function computeMetrics(trades, equity, initial, bars = [], tfSeconds = 3600) {
  const pnl = trades.map(t => t.pnl);
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const net = pnl.reduce((a, b) => a + b, 0);
  let peak = initial, maxDD = 0, maxDDPct = 0;
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity;
    const dd = peak - e.equity;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd / peak > maxDDPct) maxDDPct = dd / peak;
  }
  let streak = 0, maxConsecLosses = 0;
  for (const t of trades) { if (t.pnl <= 0) { streak++; maxConsecLosses = Math.max(maxConsecLosses, streak); } else streak = 0; }
  const rs = trades.filter(t => t.r != null).map(t => t.r);
  const rets = [];
  for (let i = 1; i < equity.length; i++) if (equity[i - 1].equity > 0) rets.push(equity[i].equity / equity[i - 1].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const barsPerYear = (365 * 86400) / tfSeconds;
  const side = s => { const ts = trades.filter(t => t.side === s); return { count: ts.length, net: ts.reduce((a, t) => a + t.pnl, 0), winRate: ts.length ? ts.filter(t => t.pnl > 0).length / ts.length : 0 }; };
  const durations = trades.map(t => t.exitTime - t.entryTime).filter(d => d >= 0);
  return {
    initial, net, netPct: initial ? net / initial : 0, finalEquity: initial + net,
    grossProfit, grossLoss, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    total: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length : 0,
    avgTrade: trades.length ? net / trades.length : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0, avgLoss: losses.length ? -grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map(t => t.pnl)) : 0, largestLoss: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
    maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, maxConsecLosses,
    commission: trades.reduce((a, t) => a + t.commission, 0),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : null,
    buyHoldPct: bars.length > 1 ? bars[bars.length - 1].close / bars[0].close - 1 : null,
    avgDuration: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    long: side('buy'), short: side('sell'),
  };
}
