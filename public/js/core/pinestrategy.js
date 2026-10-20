// Pine strategy broker emulator (pure, no DOM) — runs inside the Pine interpreter for strategy() scripts.
//
// Follows TradingView's model: orders a script places while a bar closes fill on the NEXT bar — market orders
// at its open (plus slippage), limit / stop orders and strategy.exit() brackets when the bar's price path
// (open → high → low → close, or open → low → high → close when the open is nearer the low) reaches them; a
// bar that opens beyond a level fills at the open. process_orders_on_close fills market orders at the close
// instead. strategy.entry() reverses an opposite position and respects pyramiding; strategy.order() just
// adds to / reduces the position. Quantities follow default_qty_type (contracts, cash, % of equity);
// commission (percent / per contract / per order) and slippage (ticks) are charged on every fill.

export const QTY = { fixed: 'fixed', cash: 'cash', percent_of_equity: 'percent_of_equity' };

export function createStrategy(cfg = {}) {
  const C = {
    initial: 1000000, qtyType: 'fixed', qtyValue: 1, pyramiding: 0, commissionType: 'percent', commission: 0, slippage: 0,
    processOnClose: false, mintick: 0.01, qtyStep: 0, closeEntriesRule: 'FIFO', ...cfg,
  };
  const S = {
    open: [], closed: [], orders: [], seq: 0, net: 0, gross: { profit: 0, loss: 0 }, equity: [], maxDD: 0, peak: C.initial,
    events: [], // fills for chart markers: { i, kind: 'entry' | 'exit', dir, qty, price, id, comment }
  };
  let bar = null, barIndex = -1, barTime = 0;
  const completedExits = new WeakMap();

  const round = v => Math.round(v * 1e10) / 1e10;
  const posSize = () => S.open.reduce((a, t) => a + t.dir * t.qty, 0);
  const openProfit = price => S.open.reduce((a, t) => a + (price - t.price) * t.dir * t.qty, 0);
  const equityAt = price => C.initial + S.net + openProfit(price);
  const commissionOf = (qty, price) => (C.commissionType === 'cash_per_contract' ? qty * C.commission
    : C.commissionType === 'cash_per_order' ? C.commission : qty * price * C.commission / 100);
  const slip = dir => dir * C.slippage * C.mintick;
  // Fill at the first tradable price reaching the trigger, not between ticks.
  const triggerPrice = (level, dir) => round((dir > 0 ? Math.ceil(level / C.mintick - 1e-8) : Math.floor(level / C.mintick + 1e-8)) * C.mintick);

  function qtyFor(q, price) {
    let qty = q != null && Number.isFinite(q) ? Math.max(0,q)
      : C.qtyType === 'cash' ? C.qtyValue / price
      : C.qtyType === 'percent_of_equity' ? Math.max(0, equityAt(price) * C.qtyValue / 100 / price) : C.qtyValue;
    return C.qtyStep > 0 ? round(Math.floor(qty / C.qtyStep + 1e-9) * C.qtyStep) : qty;
  }

  function openTrade(id, dir, qty, price, comment) {
    if (!(qty > 0)) return;
    const commission = commissionOf(qty, price);
    S.net -= commission;
    S.open.push({ id, dir, qty: round(qty), price: round(price), bar: barIndex, time: barTime, comment, commission, best: price, worst: price });
    for (const o of S.orders) if (o.kind === 'exit') bindExit(o);
    S.events.push({ i: barIndex, kind: 'entry', dir, qty: round(qty), price: round(price), id, comment });
  }
  /** Close `qty` of trade t at `price` (the rest stays open). */
  function closeTrade(t, qty, price, exitId, comment) {
    qty = Math.min(qty, t.qty);
    if (!(qty > 0)) return 0;
    const frac = qty / t.qty, entryComm = t.commission * frac, exitComm = commissionOf(qty, price);
    const gross = (price - t.price) * t.dir * qty;
    S.net += gross - exitComm;
    const pnl = gross - entryComm - exitComm;
    if (pnl >= 0) S.gross.profit += pnl; else S.gross.loss -= pnl;
    S.closed.push({
      entryId: t.id, exitId, dir: t.dir, qty: round(qty), entryPrice: t.price, exitPrice: round(price), entryBar: t.bar, exitBar: barIndex,
      entryTime: t.time, exitTime: barTime, gross, commission: entryComm + exitComm, profit: pnl, comment: comment || exitId || '', entryComment: t.comment,
      mfe: (t.best - t.price) * t.dir, mae: (t.worst - t.price) * t.dir,
    });
    S.events.push({ i: barIndex, kind: 'exit', dir: t.dir, qty: round(qty), price: round(price), id: exitId, comment });
    t.qty = round(t.qty - qty);
    t.commission -= entryComm;
    if (t.qty <= 1e-12) S.open.splice(S.open.indexOf(t), 1);
    if (!S.open.some(x => x.dir === t.dir)) {
      for (const o of S.orders) for (const ticket of o.tickets || []) if (ticket.dir === t.dir) ticket.done = true;
    }
    return qty;
  }
  function closeAllAt(price, exitId, comment) { for (const t of [...S.open]) closeTrade(t, t.qty, price, exitId, comment); }

  // Entry IDs select the amount to exit; FIFO determines which entries supply it.
  function closePosition(target, qty, price, exitId, comment) {
    const candidates = C.closeEntriesRule === 'ANY' ? [target.ref || target].filter(t => S.open.includes(t)) : S.open.filter(t => t.dir === target.dir);
    for (const t of [...candidates]) {
      if (qty <= 1e-12) break;
      qty -= closeTrade(t, Math.min(qty, t.qty), price, exitId, comment);
    }
  }

  function fillMarkets(price) {
    for (const o of S.orders.filter(x => x.market)) {
      S.orders.splice(S.orders.indexOf(o), 1);
      if (o.kind === 'close') {
        const targets = S.open.filter(t => o.all || t.id === o.id);
        let qty = targets.reduce((s, t) => s + t.qty, 0) * (o.qtyPct ?? 100) / 100;
        if (targets.length) closePosition(targets[0], qty, price - slip(targets[0].dir), o.id || 'Close', o.comment || (o.all ? 'Close all' : 'Close'));
      } else fillEntry(o, price + slip(o.dir));
    }
  }

  /** Fill an entry / order at `price`. */
  function fillEntry(o, price) {
    const pos = posSize();
    if (o.kind === 'entry') {
      if (pos !== 0 && Math.sign(pos) !== o.dir) closeAllAt(price, o.id, 'Reverse');
      else if (pos !== 0 && S.open.filter(t => t.dir === o.dir).length >= Math.max(1, C.pyramiding)) return false; // pyramiding limit
      openTrade(o.id, o.dir, qtyFor(o.qty, price), price, o.comment);
      return true;
    }
    // strategy.order: net the quantity against the position (FIFO), any remainder opens a new trade
    let qty = qtyFor(o.qty, price);
    for (const t of [...S.open]) { if (t.dir === o.dir || qty <= 0) continue; qty -= closeTrade(t, qty, price, o.id, o.comment); }
    if (qty > 1e-12) openTrade(o.id, o.dir, qty, price, o.comment);
    return true;
  }

  /** Price levels an exit order sets for one open trade. */
  function exitLevels(o, t) {
    const tp = o.limit != null ? o.limit : o.profit != null ? t.price + t.dir * o.profit * C.mintick : null;
    let sl = o.stop != null ? o.stop : o.loss != null ? t.price - t.dir * o.loss * C.mintick : null;
    // trailing stop: active once price has gone trail_points (or reached trail_price) in favour
    if (o.trailOffset != null && (o.trailPoints != null || o.trailPrice != null)) {
      const act = o.trailPrice != null ? o.trailPrice : t.price + t.dir * o.trailPoints * C.mintick;
      if ((t.best - act) * t.dir >= 0) {
        const tr = t.best - t.dir * o.trailOffset * C.mintick;
        sl = sl == null ? tr : t.dir > 0 ? Math.max(sl, tr) : Math.min(sl, tr);
        t.trailing = true;
      }
    }
    return { tp, sl };
  }
  function bindExit(o) {
    o.tickets ||= [];
    for (const t of S.open) {
      if ((o.from && o.from !== t.id) || o.tickets.some(x => x.ref === t) || completedExits.get(t)?.has(o.id)) continue;
      const reserved = S.orders.filter(x => x !== o && x.kind === 'exit').reduce((sum, x) => sum + (x.tickets || []).filter(k => k.ref === t && !k.done).reduce((s,k) => s+k.qty,0),0);
      const qty = Math.min(Math.max(0,t.qty-reserved), o.qty ?? t.qty * (o.qtyPct ?? 100) / 100);
      if (qty > 0) o.tickets.push({ref:t, qty, dir:t.dir, price:t.price, best:t.best, worst:t.worst, done:false});
    }
  }

  /** Triggers on the bar path: entries (limit / stop) and exits for each open trade. dir: +1 when hit rising. */
  function triggers() {
    const out = [];
    for (const o of S.orders) {
      if (o.kind === 'entry' || o.kind === 'order') {
        if (o.stop != null) out.push({ o, level: triggerPrice(o.stop, o.dir), dir: o.dir, stop: true });
        else if (o.limit != null) out.push({ o, level: triggerPrice(o.limit, -o.dir), dir: -o.dir, stop: false });
      }
    }
    for (const o of S.orders.filter(x => x.kind === 'exit')) {
      for (const t of o.tickets || []) {
        if (t.done || !S.open.some(x => x.dir === t.dir) || (C.closeEntriesRule === 'ANY' && !S.open.includes(t.ref))) continue;
        const { tp, sl } = exitLevels(o, t);
        if (tp != null) out.push({ o, t, level: triggerPrice(tp, t.dir), dir: t.dir, stop: false, kind: 'tp' });
        if (sl != null) out.push({ o, t, level: triggerPrice(sl, -t.dir), dir: -t.dir, stop: true, kind: t.trailing ? 'trail' : 'sl' });
      }
    }
    return out;
  }
  function execute(tr, price) {
    if (tr.t) { // exit
      if (tr.t.done) return;
      const qty = tr.t.qty;
      const comment = tr.kind === 'tp' ? (tr.o.commentProfit || tr.o.comment) : tr.kind === 'trail' ? (tr.o.commentTrailing || tr.o.comment) : (tr.o.commentLoss || tr.o.comment);
      tr.t.done = true;
      let done = completedExits.get(tr.t.ref);
      if (!done) { done = new Set(); completedExits.set(tr.t.ref, done); }
      done.add(tr.o.id);
      closePosition(tr.t, qty, price, tr.o.id, comment || { tp: 'Take-profit', sl: 'Stop-loss', trail: 'Trailing stop' }[tr.kind]);
      return;
    }
    S.orders.splice(S.orders.indexOf(tr.o), 1);
    fillEntry(tr.o, price);
    if (tr.o.oca) S.orders = S.orders.filter(x => x.oca !== tr.o.oca || x.kind === 'exit'); // one-cancels-all group
  }
  function updateExcursion(price) {
    const tickets = S.orders.flatMap(o => (o.tickets || []).filter(t => !t.done));
    for (const t of [...S.open, ...tickets]) { if ((price - t.best) * t.dir > 0) t.best = price; if ((price - t.worst) * t.dir < 0) t.worst = price; }
  }

  return {
    cfg: C,
    get positionSize() { return round(posSize()); },
    get avgPrice() { const q = S.open.reduce((a, t) => a + t.qty, 0); return q ? S.open.reduce((a, t) => a + t.price * t.qty, 0) / q : NaN; },
    get entryName() { return S.open[0]?.id ?? ''; },
    get netProfit() { return S.net; },
    get grossProfit() { return S.gross.profit; },
    get grossLoss() { return S.gross.loss; },
    get openTrades() { return S.open; },
    get closedTrades() { return S.closed; },
    get maxDrawdown() { return S.maxDD; },
    openProfit: price => openProfit(price),
    equity: price => equityAt(price),

    /** A new bar opens: fill orders placed on the previous bar. */
    beforeBar(i, b) {
      barIndex = i; bar = b; barTime = b.time;
      const o0 = b.open;
      // market orders first, in the order they were placed
      fillMarkets(o0);
      updateExcursion(o0);
      // gaps: anything already beyond its level at the open fills at the open
      for (let pass = 0, fired = true; fired && pass < 10; pass++) {
        fired = false;
        for (const tr of triggers()) {
          if ((tr.dir > 0 && o0 >= tr.level) || (tr.dir < 0 && o0 <= tr.level)) { execute(tr, tr.stop ? o0 + slip(tr.t ? -tr.t.dir : tr.dir) : o0); fired = true; break; }
        }
      }
      const path = (b.high - o0) <= (o0 - b.low) ? [o0, b.high, b.low, b.close] : [o0, b.low, b.high, b.close];
      for (let k = 1; k < path.length; k++) {
        let from = path[k - 1];
        const to = path[k], up = to > from;
        for (let guard = 0; guard < 500 && to !== from; guard++) {
          let best = null;
          for (const tr of triggers()) {
            const hit = up ? (tr.dir > 0 && tr.level > from - 1e-12 && tr.level <= to) : (tr.dir < 0 && tr.level < from + 1e-12 && tr.level >= to);
            if (hit && (!best || Math.abs(tr.level - from) < Math.abs(best.level - from))) best = tr;
          }
          if (!best) break;
          updateExcursion(best.level);
          execute(best, best.stop ? best.level + slip(best.t ? -best.t.dir : best.dir) : best.level);
          from = best.level;
        }
        updateExcursion(to);
      }
    },
    /** The script ran on this bar's close: mark equity. */
    afterBar(i, b) {
      // Orders created during this execution cannot change strategy.* mid-script.
      // process_orders_on_close adds a fill attempt after the entire execution.
      if (C.processOnClose) fillMarkets(b.close);
      S.orders = S.orders.filter(o => o.kind !== 'exit' || !o.tickets?.length || o.tickets.some(t => !t.done));
      const eq = equityAt(b.close);
      if (eq > S.peak) S.peak = eq;
      S.maxDD = Math.max(S.maxDD, S.peak - eq);
      S.equity.push({ time: b.time, equity: eq, balance: C.initial + S.net });
    },

    // ---- script calls
    entry(id, dir, { qty = null, limit = null, stop = null, comment = '', oca = null } = {}) {
      S.orders = S.orders.filter(o => !((o.kind === 'entry' || o.kind === 'order') && o.id === id)); // same id replaces
      const o = { kind: 'entry', id, dir, qty, limit, stop, comment, oca, market: limit == null && stop == null };
      S.orders.push(o);
    },
    order(id, dir, { qty = null, limit = null, stop = null, comment = '', oca = null } = {}) {
      S.orders = S.orders.filter(o => !((o.kind === 'entry' || o.kind === 'order') && o.id === id));
      const o = { kind: 'order', id, dir, qty, limit, stop, comment, oca, market: limit == null && stop == null };
      S.orders.push(o);
    },
    exit(id, from, p = {}) {
      const previous = S.orders.find(o => o.kind === 'exit' && o.id === id && (o.from || '') === (from || ''));
      S.orders = S.orders.filter(o => !(o.kind === 'exit' && o.id === id && (o.from || '') === (from || '')));
      const o = { kind: 'exit', id, from: from || '', qty: p.qty ?? null, qtyPct: p.qtyPct ?? 100, profit: p.profit ?? null, loss: p.loss ?? null, limit: p.limit ?? null, stop: p.stop ?? null,
        trailPoints: p.trailPoints ?? null, trailOffset: p.trailOffset ?? null, trailPrice: p.trailPrice ?? null, comment: p.comment || '', commentProfit: p.commentProfit || '', commentLoss: p.commentLoss || '', commentTrailing: p.commentTrailing || '', tickets: previous?.tickets || [] };
      if ([o.profit, o.loss, o.limit, o.stop, o.trailOffset].every(v => v == null)) return; // nothing to exit with (Pine ignores it too)
      bindExit(o);
      if (o.tickets.some(t => !t.done) || S.orders.some(x => (x.kind === 'entry' || x.kind === 'order') && (!o.from || x.id === o.from))) S.orders.push(o);
    },
    close(id, { comment = '', qtyPct = 100, immediately = false } = {}) {
      if (!S.open.some(t => t.id === id)) return;
      if (immediately && bar) { const targets = S.open.filter(t => t.id === id); closePosition(targets[0], targets.reduce((s, t) => s + t.qty, 0) * qtyPct / 100, bar.close - slip(targets[0].dir), id, comment || 'Close'); return; }
      S.orders.push({ kind: 'close', id, all: false, qtyPct, comment, market: true });
    },
    closeAll({ comment = '', immediately = false } = {}) {
      if (!S.open.length) return;
      if (immediately && bar) { closeAllAt(bar.close, 'Close all', comment || 'Close all'); return; }
      S.orders.push({ kind: 'close', id: '', all: true, comment, market: true });
    },
    cancel(id) { S.orders = S.orders.filter(o => o.id !== id || o.kind === 'close'); },
    cancelAll() { S.orders = S.orders.filter(o => o.kind === 'close'); },

    /** Results in the Strategy Tester's trade format, with open positions reported separately. */
    report(lastClose, lastTime) {
      const trades = S.closed.map((t, k) => ({
        id: String(k + 1), side: t.dir > 0 ? 'buy' : 'sell', lots: t.qty, entry: t.entryPrice, exit: t.exitPrice, entryTime: t.entryTime, exitTime: t.exitTime,
        gross: t.gross, commission: t.commission, pnl: t.profit, reason: t.comment || t.exitId || 'Exit', note: `${t.entryId}${t.entryComment ? ` · ${t.entryComment}` : ''}`,
        r: null, plannedRR: null, mfe: t.mfe, mae: t.mae, entryBar: t.entryBar, exitBar: t.exitBar,
      }));
      const open = S.open.map(t => ({ side: t.dir > 0 ? 'buy' : 'sell', lots: t.qty, entry: t.price, entryTime: t.time, entryBar: t.bar, id: t.id, unrealized: (lastClose - t.price) * t.dir * t.qty }));
      return { trades, open, equity: S.equity, events: S.events, cfg: C, netProfit: S.net, openProfit: openProfit(lastClose), lastTime };
    },
  };
}
