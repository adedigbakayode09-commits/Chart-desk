// Candle-based broker emulator used by manual replay trading and the strategy tester.
//
// Execution model (documented in the UI so results are read with the right caveats):
//  * Charts show BID prices. ask = bid + spread. Longs open at ask / close at bid; shorts the opposite.
//    Spread = the measured average spread of that minute (Dukascopy ticks / ask CSV) or a fixed value.
//  * Within a bar the price path is assumed O→H→L→C if the open is nearer the high, otherwise O→L→H→C
//    (the standard broker-emulator convention). With 1-minute bars this ambiguity is tiny; on higher
//    timeframes a bar that touches both SL and TP is resolved by this rule, not by real tick order.
//  * Stop orders and stop-losses fill at the trigger price plus adverse slippage; if the bar OPENS beyond
//    the level (a gap), they fill at the open (plus slippage). Limit orders and take-profits fill at their
//    price, or at the better open price on a gap. No partial fills, no liquidity limits.
//  * Commission: per lot round turn (half charged on entry, half on exit) and/or % of notional per side.
//  * Margin = notional / leverage. Orders that exceed free margin are rejected; if equity falls to the
//    stop-out level (% of used margin) all positions are closed.
//  * P&L is converted to the USD account: quote-USD instruments directly, USD-base pairs via the price.

export const EXECUTION_NOTES = [
  'Prices are bid; buys pay the ask (bid + spread). Spread comes from Dukascopy tick data where available, otherwise the fixed spread setting.',
  'Intrabar order of high/low is assumed (O→H→L→C if open is nearer the high, else O→L→H→C). Replay fills use 1-minute bars, so this only matters inside a single minute.',
  'Stops and stop-losses get adverse slippage and fill at the open on gaps; limits and take-profits fill at their price (or a better gap open).',
  'Commission is charged per side; margin and stop-out are checked on every bar. No partial fills or market-impact modelling.',
];

const USDLIKE = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD']);

export function canTrade(spec) {
  return !!spec && (USDLIKE.has(spec.quote) || spec.base === 'USD');
}

/** Convert an amount in the instrument's quote currency to USD at `price`. */
export function quoteToUsd(spec, amount, price) {
  if (USDLIKE.has(spec.quote)) return amount;
  if (spec.base === 'USD') return amount / price;
  throw new Error(`${spec.symbol}: P&L conversion to USD not supported`);
}

export const lotStep = spec => spec.lotStep ?? (spec.type === 'crypto' ? 0.0001 : 0.01);
export const roundLots = (spec, lots) => {
  const step = lotStep(spec);
  return Math.floor(lots / step + 1e-9) * step;
};

/** Position size (lots) that risks `riskPct` of `balance` between entry and stop, including commission. */
export function lotsForRisk(spec, cfg, balance, riskPct, entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || !(riskPct > 0)) return 0;
  const units = spec.contractSize;
  const perLot = quoteToUsd(spec, dist * units, entry) + (cfg.commissionPerLot || 0) + 2 * (cfg.commissionPct || 0) / 100 * quoteToUsd(spec, entry * units, entry);
  return roundLots(spec, (balance * riskPct / 100) / perLot);
}

/** Intrabar path of bid prices. */
export function pricePath(bar) {
  const { open: o, high: h, low: l, close: c } = bar;
  return (h - o) <= (o - l) ? [o, h, l, c] : [o, l, h, c];
}

const round = (v, d = 10) => Math.round(v * 10 ** d) / 10 ** d;

export class Broker {
  constructor(spec, cfg = {}) {
    if (!canTrade(spec)) throw new Error(`${spec?.symbol}: trading needs a USD-quoted or USD-base instrument`);
    this.spec = spec;
    this.cfg = {
      balance: 10000, leverage: 100, commissionPerLot: spec.commissionPerLot ?? 0, commissionPct: spec.commissionPct ?? 0,
      slippage: 0, spreadMode: 'data', fixedSpread: spec.defaultSpread ?? 0, stopOutPct: 50, ...cfg,
    };
    this.s = {
      balance: this.cfg.balance, positions: [], orders: [], history: [], seq: 1,
      time: null, bid: null, spread: 0, fixedSpreadMinutes: 0, dataSpreadMinutes: 0,
    };
  }

  // ---------------------------------------------------------------- state
  toJSON() { return structuredClone(this.s); }
  load(state) { this.s = structuredClone(state); return this; }
  /** Compact snapshot for rewinding: history is append-only, so only its length is stored. */
  snapshot() {
    const { history, ...rest } = this.s;
    return { ...structuredClone(rest), historyLen: history.length };
  }
  restore(snap) {
    const { historyLen, ...rest } = structuredClone(snap);
    const removed = this.s.history.slice(historyLen);
    this.s = { ...rest, history: this.s.history.slice(0, historyLen) };
    return removed;
  }

  get quote() {
    const { bid, spread, time } = this.s;
    return bid == null ? null : { bid, ask: bid + spread, spread, time };
  }
  setQuote(bid, spread, time) {
    this.s.bid = bid;
    this.s.spread = this.spreadOf(spread);
    this.s.time = time;
  }
  spreadOf(dataSpread) {
    if (this.cfg.spreadMode === 'data' && dataSpread > 0) { this.s.dataSpreadMinutes++; return dataSpread; }
    this.s.fixedSpreadMinutes++;
    return this.cfg.fixedSpread || 0;
  }

  units(lots) { return lots * this.spec.contractSize; }
  notionalUsd(lots, price) { return quoteToUsd(this.spec, this.units(lots) * price, price); }
  commissionSide(lots, price) {
    return lots * (this.cfg.commissionPerLot || 0) / 2 + this.notionalUsd(lots, price) * (this.cfg.commissionPct || 0) / 100;
  }
  unrealized(p) {
    const q = this.quote;
    if (!q) return 0;
    const exit = p.side === 'buy' ? q.bid : q.ask;
    return quoteToUsd(this.spec, (exit - p.entry) * (p.side === 'buy' ? 1 : -1) * this.units(p.lots), exit);
  }
  get equity() { return this.s.balance + this.s.positions.reduce((a, p) => a + this.unrealized(p), 0); }
  get usedMargin() { return this.s.positions.reduce((a, p) => a + this.notionalUsd(p.lots, p.entry) / this.cfg.leverage, 0); }
  get freeMargin() { return this.equity - this.usedMargin; }

  // ---------------------------------------------------------------- orders
  validateLevels(side, ref, sl, tp) {
    const dir = side === 'buy' ? 1 : -1;
    if (sl != null && !((ref - sl) * dir > 0)) return `Stop-loss must be ${side === 'buy' ? 'below' : 'above'} the entry price`;
    if (tp != null && !((tp - ref) * dir > 0)) return `Take-profit must be ${side === 'buy' ? 'above' : 'below'} the entry price`;
    return null;
  }

  /** Place a market, limit or stop order. Returns { ok, error?, events }. */
  placeOrder({ side, type = 'market', lots, price = null, sl = null, tp = null, note = '' }) {
    const q = this.quote;
    if (!q) return { ok: false, error: 'No price yet — step the replay forward first', events: [] };
    lots = roundLots(this.spec, Number(lots));
    if (!(lots > 0)) return { ok: false, error: `Minimum size is ${lotStep(this.spec)} ${this.spec.lotName || 'lots'}`, events: [] };
    if (!['buy', 'sell'].includes(side)) return { ok: false, error: 'Invalid side', events: [] };
    if (type !== 'market') {
      price = Number(price);
      if (!(price > 0)) return { ok: false, error: 'Enter an order price', events: [] };
      const okSide = side === 'buy'
        ? (type === 'limit' ? price < q.ask : price > q.ask)
        : (type === 'limit' ? price > q.bid : price < q.bid);
      if (!okSide) return { ok: false, error: `A ${side} ${type} must be ${(side === 'buy') === (type === 'limit') ? 'below' : 'above'} the current ${side === 'buy' ? 'ask' : 'bid'}`, events: [] };
    }
    const ref = type === 'market' ? (side === 'buy' ? q.ask : q.bid) : price;
    const err = this.validateLevels(side, ref, sl, tp);
    if (err) return { ok: false, error: err, events: [] };
    const order = { id: this.s.seq++, side, type, lots, price, sl, tp, note, placedAt: q.time };
    if (type === 'market') {
      const fillPrice = side === 'buy' ? q.ask + this.cfg.slippage : q.bid - this.cfg.slippage;
      const events = [];
      const res = this.fill(order, fillPrice, q.time, events);
      return { ok: res, error: res ? null : events[0]?.reason, events };
    }
    this.s.orders.push(order);
    return { ok: true, events: [{ type: 'placed', order }] };
  }

  cancelOrder(id) {
    const i = this.s.orders.findIndex(o => o.id === id);
    if (i < 0) return false;
    this.s.orders.splice(i, 1);
    return true;
  }

  modifyOrder(id, changes) {
    const o = this.s.orders.find(x => x.id === id);
    if (!o) return { ok: false, error: 'Order not found' };
    const next = { ...o, ...changes };
    const err = this.validateLevels(next.side, next.price, next.sl, next.tp);
    if (err) return { ok: false, error: err };
    Object.assign(o, changes);
    return { ok: true };
  }

  modifyPosition(id, { sl = undefined, tp = undefined }) {
    const p = this.s.positions.find(x => x.id === id);
    if (!p) return { ok: false, error: 'Position not found' };
    const q = this.quote;
    const ref = p.side === 'buy' ? q.bid : q.ask;
    const nsl = sl === undefined ? p.sl : sl, ntp = tp === undefined ? p.tp : tp;
    const err = this.validateLevels(p.side, ref, nsl, ntp);
    if (err) return { ok: false, error: err.replace('entry price', 'current price') };
    p.sl = nsl; p.tp = ntp;
    return { ok: true };
  }

  fill(order, price, time, events) {
    const need = this.notionalUsd(order.lots, price) / this.cfg.leverage;
    if (need > this.freeMargin) {
      events.push({ type: 'rejected', order, reason: `Not enough free margin (needs $${need.toFixed(2)}, free $${this.freeMargin.toFixed(2)})` });
      return false;
    }
    const commission = this.commissionSide(order.lots, price);
    this.s.balance -= commission;
    const pos = {
      id: order.id, side: order.side, lots: order.lots, entry: round(price), entryTime: time, sl: order.sl, tp: order.tp,
      initialSl: order.sl, initialTp: order.tp, commission, orderType: order.type, note: order.note,
      spreadAtEntry: this.s.spread, mfe: 0, mae: 0,
    };
    this.s.positions.push(pos);
    events.push({ type: 'fill', position: { ...pos } });
    return true;
  }

  closePosition(id, { lots = null, price = null, reason = 'Manual', time = this.s.time } = {}, events = []) {
    const i = this.s.positions.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, error: 'Position not found', events };
    const p = this.s.positions[i];
    const q = this.quote;
    const exit = price ?? (p.side === 'buy' ? q.bid - this.cfg.slippage : q.ask + this.cfg.slippage);
    const closeLots = lots == null ? p.lots : Math.min(p.lots, roundLots(this.spec, lots));
    if (!(closeLots > 0)) return { ok: false, error: 'Invalid size', events };
    const frac = closeLots / p.lots;
    const dir = p.side === 'buy' ? 1 : -1;
    // Include the exit move in the excursion stats (the closing bar's extremes are recorded after fills).
    p.mfe = Math.max(p.mfe, (exit - p.entry) * dir);
    p.mae = Math.min(p.mae, (exit - p.entry) * dir);
    const gross = quoteToUsd(this.spec, (exit - p.entry) * dir * this.units(closeLots), exit);
    const entryComm = p.commission * frac;
    const exitComm = this.commissionSide(closeLots, exit);
    this.s.balance += gross - exitComm;
    const commission = entryComm + exitComm;
    const net = gross - commission;
    const riskUsd = p.initialSl != null ? quoteToUsd(this.spec, Math.abs(p.entry - p.initialSl) * this.units(closeLots), p.entry) : null;
    const trade = {
      id: `${p.id}${frac < 1 ? '.' + this.s.seq++ : ''}`, positionId: p.id, side: p.side, lots: closeLots,
      entry: p.entry, exit: round(exit), entryTime: p.entryTime, exitTime: time, sl: p.initialSl, tp: p.initialTp,
      gross, commission, pnl: net, reason, note: p.note,
      r: riskUsd ? net / riskUsd : null,
      plannedRR: p.initialSl != null && p.initialTp != null ? Math.abs(p.initialTp - p.entry) / Math.abs(p.entry - p.initialSl) : null,
      mfe: p.mfe, mae: p.mae, balanceAfter: this.s.balance,
    };
    this.s.history.push(trade);
    if (frac >= 1 - 1e-9) this.s.positions.splice(i, 1);
    else { p.lots = round(p.lots - closeLots, 8); p.commission -= entryComm; }
    events.push({ type: 'close', trade });
    return { ok: true, trade, events };
  }

  closeAll(reason = 'Manual') {
    const events = [];
    for (const p of [...this.s.positions]) this.closePosition(p.id, { reason }, events);
    return events;
  }

  // ---------------------------------------------------------------- bar processing
  /** Triggers for every working order / protective level: condition on the BID path. */
  triggers(spread) {
    const out = [];
    for (const p of this.s.positions) {
      if (p.side === 'buy') {
        if (p.sl != null) out.push({ kind: 'sl', ref: p, level: p.sl, dir: -1, stop: true });
        if (p.tp != null) out.push({ kind: 'tp', ref: p, level: p.tp, dir: 1, stop: false });
      } else {
        if (p.sl != null) out.push({ kind: 'sl', ref: p, level: p.sl - spread, dir: 1, stop: true });
        if (p.tp != null) out.push({ kind: 'tp', ref: p, level: p.tp - spread, dir: -1, stop: false });
      }
    }
    for (const o of this.s.orders) {
      const askBased = o.side === 'buy';
      const level = askBased ? o.price - spread : o.price;
      const up = (o.side === 'buy') !== (o.type === 'limit'); // buy stop / sell limit trigger on the way up
      out.push({ kind: 'order', ref: o, level, dir: up ? 1 : -1, stop: o.type === 'stop' });
    }
    return out;
  }

  execute(tr, gap, openBid, spread, time, events) {
    const slip = this.cfg.slippage;
    if (tr.kind === 'order') {
      const o = tr.ref;
      this.s.orders.splice(this.s.orders.indexOf(o), 1);
      let px;
      if (o.side === 'buy') px = gap ? (tr.stop ? openBid + spread + slip : Math.min(o.price, openBid + spread)) : (tr.stop ? o.price + slip : o.price);
      else px = gap ? (tr.stop ? openBid - slip : Math.max(o.price, openBid)) : (tr.stop ? o.price - slip : o.price);
      this.fill(o, px, time, events);
      return;
    }
    const p = tr.ref;
    const lvl = tr.kind === 'sl' ? p.sl : p.tp;
    let px;
    if (p.side === 'buy') px = gap ? openBid - (tr.stop ? slip : 0) : lvl - (tr.stop ? slip : 0);
    else px = gap ? openBid + spread + (tr.stop ? slip : 0) : lvl + (tr.stop ? slip : 0);
    this.closePosition(p.id, { price: px, reason: tr.kind === 'sl' ? 'Stop-loss' : 'Take-profit', time }, events);
  }

  /**
   * Advance through one bar ({ time, open, high, low, close, spread, seconds }) and fill anything it
   * touches. Returns the list of events.
   */
  processBar(bar) {
    const events = [];
    const spread = this.spreadOf(bar.spread);
    this.s.spread = spread;
    const end = bar.time + (bar.seconds || 60);
    const path = pricePath(bar);
    const open = path[0];
    this.s.bid = open;
    this.s.time = bar.time;

    // Gaps: anything already beyond its level at the open fills at the open. Repeat, because an order
    // filled on the gap can open a position whose stop is itself already beyond the open.
    for (let pass = 0, fired = true; fired && pass < 10; pass++) {
      fired = false;
      for (const tr of this.triggers(spread)) {
        if (!this.alive(tr)) continue;
        if ((tr.dir > 0 && open >= tr.level) || (tr.dir < 0 && open <= tr.level)) { this.execute(tr, true, open, spread, bar.time, events); fired = true; }
      }
    }
    for (let k = 1; k < path.length; k++) {
      let from = path[k - 1];
      const to = path[k];
      if (to === from) continue;
      const up = to > from;
      // Repeatedly take the nearest trigger along this leg (new positions may add SL/TP mid-leg).
      for (let guard = 0; guard < 1000; guard++) {
        let best = null;
        for (const tr of this.triggers(spread)) {
          if (!this.alive(tr)) continue;
          const hit = up ? (tr.dir > 0 && tr.level > from - 1e-12 && tr.level <= to) : (tr.dir < 0 && tr.level < from + 1e-12 && tr.level >= to);
          if (hit && (!best || Math.abs(tr.level - from) < Math.abs(best.level - from))) best = tr;
        }
        if (!best) break;
        this.s.bid = best.level;
        this.execute(best, false, open, spread, bar.time, events);
        from = best.level;
      }
      this.s.bid = to;
      this.checkStopOut(events, bar.time);
    }
    for (const p of this.s.positions) {
      const dir = p.side === 'buy' ? 1 : -1;
      const fav = ((dir > 0 ? bar.high : bar.low) - p.entry) * dir;
      const adv = ((dir > 0 ? bar.low : bar.high) - p.entry) * dir;
      if (fav > p.mfe) p.mfe = fav;
      if (adv < p.mae) p.mae = adv;
    }
    this.s.bid = bar.close;
    this.s.time = end;
    return events;
  }

  alive(tr) {
    return tr.kind === 'order' ? this.s.orders.includes(tr.ref) : this.s.positions.includes(tr.ref) && (tr.kind === 'sl' ? tr.ref.sl != null : tr.ref.tp != null);
  }

  checkStopOut(events, time) {
    if (!this.s.positions.length) return;
    const used = this.usedMargin;
    if (used > 0 && this.equity <= used * this.cfg.stopOutPct / 100) {
      for (const p of [...this.s.positions]) this.closePosition(p.id, { reason: 'Stop-out', time }, events);
      events.push({ type: 'stopout' });
    }
  }
}
