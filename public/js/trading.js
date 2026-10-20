// Manual backtesting: order ticket, account, positions, orders and trade history for the replay session.

import { h, fill, icon, toast, fmtUsd, fmtNum, fmtPrice, fmtDateTime, fmtDuration, confirmBox, kv } from './util.js';
import { lotsForRisk, quoteToUsd, roundLots, lotStep, EXECUTION_NOTES } from './core/broker.js';
import { precisionOf } from './data.js';
import { positionStats } from './drawings.js';

export class Trading {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.ticket = { side: 'buy', type: 'market', price: '', sizeMode: 'risk', lots: 0.1, risk: 1, useSl: true, sl: '', useTp: true, tp: '' };
    this.tab = 'positions';
    kv.get('ticket').then(t => { if (t) Object.assign(this.ticket, t, { price: '', sl: '', tp: '' }); this.render(); });
    this.render();
  }
  /** The session being traded: Bar Replay while it runs, otherwise live paper trading. */
  get sess() { return this.app.replay?.active ? this.app.replay : (this.app.paper || this.app.replay); }
  get replay() { return this.sess; }
  get paperMode() { return this.sess === this.app.paper; }
  get broker() { return this.sess.broker; }
  get prec() { return this.app.viewFor(this.replay.symbol)?.prec ?? this.app.activeView?.prec ?? 2; }
  saveTicket() { const { side, type, sizeMode, lots, risk, useSl, useTp } = this.ticket; kv.set('ticket', { side, type, sizeMode, lots, risk, useSl, useTp }); }

  // ---------------------------------------------------------------- sizing helpers
  lotsFor(entry, sl) {
    const b = this.broker, t = this.ticket;
    if (t.sizeMode === 'lots') return roundLots(b.spec, Number(t.lots) || 0);
    if (sl == null) return 0;
    return lotsForRisk(b.spec, b.cfg, b.equity, Number(t.risk) || 0, entry, sl);
  }
  sizeForPositionTool(view, d) {
    if (!this.replay.active || this.replay.symbol !== view.symbol) return null;
    const b = this.broker, t = this.ticket;
    if (t.sizeMode === 'lots') return roundLots(b.spec, Number(t.lots) || 0);
    return lotsForRisk(b.spec, b.cfg, b.equity, Number(t.risk) || 0, d.pts[0].price, d.stop);
  }

  // ---------------------------------------------------------------- order actions
  place(order) {
    const res = this.broker.placeOrder(order);
    if (!res.ok) { toast(res.error, 'error'); return false; }
    for (const ev of res.events) {
      if (ev.type === 'placed') toast(`${ev.order.side.toUpperCase()} ${ev.order.type.toUpperCase()} ${+ev.order.lots.toFixed(4)} @ ${fmtPrice(ev.order.price, this.prec)} placed`);
      else this.replay.handleEvent(ev);
    }
    this.afterChange();
    return true;
  }
  afterChange() {
    this.refresh();
    for (const v of this.app.views) v.applyMarkers();
    this.replay.persist();
    this.replay.updateBar();
  }
  quickOrder(side) {
    if (!this.replay.active) return;
    const q = this.broker.quote, t = this.ticket;
    const entry = side === 'buy' ? q.ask : q.bid;
    const sl = t.useSl && t.sl !== '' ? Number(t.sl) : null;
    const tp = t.useTp && t.tp !== '' ? Number(t.tp) : null;
    let lots = this.lotsFor(entry, sl);
    if (!(lots > 0)) {
      if (t.sizeMode === 'risk' && sl == null) { toast('Risk sizing needs a stop-loss in the ticket — or switch the ticket to lots', 'error'); return; }
      toast('Size is zero — increase the risk % or lots', 'error'); return;
    }
    // Quick buttons use the ticket's SL/TP only when they sit on the correct side for this direction.
    const dir = side === 'buy' ? 1 : -1;
    const useSl = sl != null && (entry - sl) * dir > 0, useTp = tp != null && (tp - entry) * dir > 0;
    if (t.sizeMode === 'risk' && !useSl) { toast(`The ticket's stop-loss is on the wrong side for a ${side}`, 'error'); return; }
    this.place({ side, type: 'market', lots, sl: useSl ? sl : null, tp: useTp ? tp : null });
  }
  submitTicket() {
    const t = this.ticket, q = this.broker.quote;
    const price = t.type === 'market' ? null : Number(t.price);
    const entry = t.type === 'market' ? (t.side === 'buy' ? q.ask : q.bid) : price;
    const sl = t.useSl && t.sl !== '' ? Number(t.sl) : null;
    const tp = t.useTp && t.tp !== '' ? Number(t.tp) : null;
    const lots = this.lotsFor(entry, sl);
    if (!(lots > 0)) { toast(t.sizeMode === 'risk' && sl == null ? 'Risk-based sizing needs a stop-loss' : 'Position size is zero', 'error'); return; }
    if (this.place({ side: t.side, type: t.type, price, lots, sl, tp })) { t.sl = ''; t.tp = ''; t.price = ''; this.renderTicket(); }
  }
  async orderFromPositionTool(view, d) {
    if (!this.replay.active) { toast('Turn on paper trading (Trading panel) or start Bar Replay to trade this setup'); this.app.showPanel('trading'); return; }
    if (this.replay.symbol !== view.symbol) { toast(this.paperMode ? 'Click this chart first to trade its symbol' : `The replay session trades ${this.replay.symbol}`, 'error'); return; }
    const st = positionStats(d, view.spec);
    if (!st.valid) { toast('Stop and target must be on opposite sides of the entry', 'error'); return; }
    const q = this.broker.quote, side = d.type === 'long' ? 'buy' : 'sell';
    const ref = side === 'buy' ? q.ask : q.bid;
    const tol = view.spec.tickSize || Math.pow(10, -view.prec);
    let type = 'market';
    if (Math.abs(st.entry - ref) > tol) type = (side === 'buy') === (st.entry < ref) ? 'limit' : 'stop';
    const lots = this.lotsFor(type === 'market' ? ref : st.entry, d.stop);
    if (!(lots > 0)) { toast('Size is zero — check the ticket risk % / lots', 'error'); return; }
    const p = view.prec;
    const msg = `${side.toUpperCase()} ${type.toUpperCase()} ${+lots.toFixed(4)} ${view.symbol}${type === 'market' ? ` at market (~${fmtPrice(ref, p)})` : ` @ ${fmtPrice(st.entry, p)}`}\nSL ${fmtPrice(d.stop, p)} · TP ${fmtPrice(d.target, p)} · R:R ${st.rr.toFixed(2)}`;
    if (!(await confirmBox(msg, 'Place order'))) return;
    this.place({ side, type, price: type === 'market' ? null : st.entry, lots, sl: d.stop, tp: d.target, note: 'From position tool' });
  }
  /**
   * Order at a chart price (right-click / price-axis "+"): a limit when the price is better than the market
   * (buy below the ask, sell above the bid), otherwise a stop. Uses the ticket's size and, when they sit on
   * the correct side of this entry, its stop-loss / take-profit.
   */
  chartOrderPlan(side, price) {
    const b = this.broker, q = b.quote, t = this.ticket;
    const p = Number(price.toFixed(this.prec));
    const type = side === 'buy' ? (p < q.ask ? 'limit' : 'stop') : (p > q.bid ? 'limit' : 'stop');
    const dir = side === 'buy' ? 1 : -1;
    let sl = t.useSl && t.sl !== '' ? Number(t.sl) : null, tp = t.useTp && t.tp !== '' ? Number(t.tp) : null;
    if (sl != null && !((p - sl) * dir > 0)) sl = null;
    if (tp != null && !((tp - p) * dir > 0)) tp = null;
    let lots = this.lotsFor(p, sl), note = '';
    if (!(lots > 0)) { lots = roundLots(b.spec, Number(t.lots) || lotStep(b.spec)); note = 'lots from ticket'; }
    return { side, type, price: p, lots, sl, tp, note };
  }
  placeAtPrice(side, price) {
    if (!this.replay.active) { toast('Turn on paper trading or start Bar Replay to place practice orders'); return; }
    const plan = this.chartOrderPlan(side, price);
    this.place({ side, type: plan.type, price: plan.price, lots: plan.lots, sl: plan.sl, tp: plan.tp, note: 'From chart' });
  }
  /** One-click trade from an indicator signal: market order with the signal's stop/target, sized by the ticket. */
  placeSignal(side, sl, tp) {
    if (!this.replay.active) { toast('Turn on paper trading or start Bar Replay to place practice trades'); return; }
    const b = this.broker, q = b.quote, t = this.ticket;
    const entry = side === 'buy' ? q.ask : q.bid, dir = side === 'buy' ? 1 : -1;
    if (!((entry - sl) * dir > 0)) { toast('Price has already moved past the signal\'s stop — trade skipped', 'error'); return; }
    if (tp != null && !((tp - entry) * dir > 0)) tp = null;
    let lots = this.lotsFor(entry, sl);
    if (!(lots > 0)) lots = roundLots(b.spec, Number(t.lots) || lotStep(b.spec));
    this.place({ side, type: 'market', lots, sl: Number(sl.toFixed(this.prec)), tp: tp != null ? Number(tp.toFixed(this.prec)) : null, note: 'From indicator signal' });
  }
  /** × on a chart line: close the position, cancel the order, or remove that stop-loss / take-profit. */
  removeLevel(line) {
    if (!this.replay.active) return;
    const b = this.broker;
    let res = { ok: true };
    if (line.kind === 'entry') { this.closePosition(line.id); return; }
    if (line.kind === 'order') { b.cancelOrder(line.id); toast('Order cancelled'); }
    else if (line.kind === 'sl') res = b.modifyPosition(line.id, { sl: null });
    else if (line.kind === 'tp') res = b.modifyPosition(line.id, { tp: null });
    else if (line.kind === 'osl') res = b.modifyOrder(line.id, { sl: null });
    else if (line.kind === 'otp') res = b.modifyOrder(line.id, { tp: null });
    if (!res.ok) toast(res.error, 'error');
    this.afterChange();
  }
  moveLevel(line, price) {
    if (!this.replay.active) return;
    const b = this.broker;
    const p = Number(price.toFixed(this.prec));
    let res;
    if (line.kind === 'sl') res = b.modifyPosition(line.id, { sl: p });
    else if (line.kind === 'tp') res = b.modifyPosition(line.id, { tp: p });
    else if (line.kind === 'order') {
      const o = b.s.orders.find(x => x.id === line.id), q = b.quote;
      const okSide = o.side === 'buy' ? (o.type === 'limit' ? p < q.ask : p > q.ask) : (o.type === 'limit' ? p > q.bid : p < q.bid);
      res = okSide ? b.modifyOrder(line.id, { price: p }) : { ok: false, error: `A ${o.side} ${o.type} can't be moved to the other side of the market` };
    } else if (line.kind === 'osl') res = b.modifyOrder(line.id, { sl: p });
    else if (line.kind === 'otp') res = b.modifyOrder(line.id, { tp: p });
    if (res && !res.ok) toast(res.error, 'error');
    this.afterChange();
  }
  closePosition(id, half = false, b = this.broker, symbol = this.sess.symbol) {
    const p = b.s.positions.find(x => x.id === id);
    if (!p) return;
    const lots = half ? roundLots(b.spec, p.lots / 2) : null;
    if (half && !(lots > 0)) { toast('Position too small to halve', 'error'); return; }
    const res = b.closePosition(id, { lots, reason: half ? 'Partial close' : 'Manual' });
    if (!res.ok) { toast(res.error, 'error'); return; }
    for (const ev of res.events) this.sess.handleEvent(ev, symbol);
    this.afterChange();
  }
  async closeAll() {
    const books = this.books().filter(([, b]) => b.s.positions.length);
    const n = books.reduce((a, [, b]) => a + b.s.positions.length, 0);
    if (!n) return;
    if (!(await confirmBox(`Close all ${n} position(s) at market?`, 'Close all'))) return;
    for (const [sym, b] of books) for (const ev of b.closeAll()) this.sess.handleEvent(ev, sym);
    this.afterChange();
  }
  /** [symbol, broker] pairs shown in the tables: the replay symbol, or every paper symbol with activity. */
  books() {
    if (!this.paperMode) return [[this.sess.symbol, this.broker]];
    const P = this.app.paper, list = P.openSymbols.map(s => [s, P.brokers.get(s)]);
    if (!list.some(([s]) => s === P.symbol) && P.broker) list.unshift([P.symbol, P.broker]);
    return list;
  }

  // ---------------------------------------------------------------- rendering
  render() {
    if (!this.replay?.active) {
      const P = this.app.paper, sym = this.app.activeView?.symbol;
      const why = P?.enabled ? (P.canTrade(sym) ? '' : `${sym} can't be paper-traded: it needs a live source (Binance, or Twelve Data with a key) and a USD price.`) : '';
      fill(this.host, h('div', { class: 'panel-empty' },
        h('h3', null, 'Practice trading'),
        h('p', null, 'Paper trade on live prices with a virtual $', String((P?.state.cfg.balance ?? 10000).toLocaleString()), ' account — or trade history in Bar Replay, where future prices stay hidden while you decide.'),
        why ? h('p', { class: 'down' }, why) : null,
        h('div', { class: 'empty-actions' },
          P && !P.enabled ? h('button', { class: 'btn primary', onclick: () => P.setEnabled(true) }, icon('send'), 'Paper trade live prices') : null,
          P?.enabled ? h('button', { class: 'btn', onclick: () => P.setEnabled(false) }, 'Turn paper trading off') : null,
          h('button', { class: 'btn' + (P?.enabled ? ' primary' : ''), onclick: () => this.app.replay.openDialog() }, icon('replay'), 'Bar Replay (history)'))));
      this.built = false;
      return;
    }
    this.ticketBox = h('div', { class: 'ticket' });
    this.accountBox = h('div', { class: 'account' });
    this.tableBox = h('div', { class: 'tp-table' });
    this.tabs = h('div', { class: 'subtabs' });
    this.host.replaceChildren(h('div', { class: 'trading' }, this.ticketBox, h('div', { class: 'tp-right' }, this.accountBox, this.tabs, this.tableBox)));
    this.built = true;
    this.renderTicket();
    this.refresh();
  }

  refresh() {
    if (!this.replay.active) { if (this.built !== false) this.render(); return; }
    if (!this.built) { this.render(); return; }
    this.renderAccount();
    this.renderTabs();
    this.renderTable();
    this.updatePreview();
  }

  async resetPaper() {
    const P = this.app.paper;
    const open = P.openSymbols.length;
    this.app.prompt(`Reset the paper account${open ? ` (closes ${open} symbol${open === 1 ? '' : 's'} with open trades)` : ''} — starting balance in USD`, String(P.state.cfg.balance), v => {
      const bal = Number(String(v).replace(/[^\d.]/g, ''));
      if (!(bal > 0)) return;
      P.reset(bal);
      toast(`Paper account reset to ${fmtUsd(bal)}`);
    });
  }
  renderAccount() {
    const b = this.broker, s = b.s;
    const hist = this.paperMode ? this.app.paper.allHistory() : s.history;
    const wins = hist.filter(t => t.pnl > 0).length;
    const net = hist.reduce((a, t) => a + t.pnl, 0);
    const unreal = this.books().reduce((a, [, bk]) => a + bk.s.positions.reduce((x, p) => x + bk.unrealized(p), 0), 0);
    const cell = (k, v, cls = '') => h('div', { class: 'acc-cell' }, h('span', null, k), h('b', { class: cls }, v));
    const spreadNote = s.fixedSpreadMinutes > 0 && b.cfg.spreadMode === 'data' ? `fixed fallback used on ${s.fixedSpreadMinutes.toLocaleString()} min` : null;
    fill(this.accountBox, 
      cell('Balance', fmtUsd(s.balance)),
      cell('Equity', fmtUsd(b.equity)),
      cell('Unrealized', fmtUsd(unreal, true), unreal >= 0 ? 'up' : 'down'),
      cell('Margin used', fmtUsd(b.usedMargin)),
      cell('Free margin', fmtUsd(b.freeMargin)),
      cell('Net closed P&L', fmtUsd(net, true), net >= 0 ? 'up' : 'down'),
      cell('Trades', `${hist.length}${hist.length ? ` · ${(wins / hist.length * 100).toFixed(0)}% win` : ''}`),
      this.paperMode ? h('div', { class: 'acc-cell paper-ctl' }, h('span', null, 'Paper trading · live'),
        h('span', { class: 'paper-btns' },
          h('button', { class: 'btn small', title: 'Start over with a fresh virtual balance', onclick: () => this.resetPaper() }, 'Reset'),
          h('button', { class: 'btn small', title: 'Stop paper trading (positions are kept)', onclick: () => this.app.paper.setEnabled(false) }, 'Off'))) : null,
      h('div', { class: 'acc-cell' }, h('span', null, 'Costs'), h('b', { title: EXECUTION_NOTES.join('\n') },
        `${b.cfg.commissionPerLot ? `$${b.cfg.commissionPerLot}/lot` : ''}${b.cfg.commissionPct ? ` ${b.cfg.commissionPct}%` : ''}${!b.cfg.commissionPerLot && !b.cfg.commissionPct ? 'No commission' : ''} · slip ${b.cfg.slippage} · ${b.cfg.spreadMode === 'data' ? 'real spread' : `spread ${b.cfg.fixedSpread}`}`),
        spreadNote ? h('small', { class: 'muted' }, spreadNote) : null),
    );
  }

  renderTabs() {
    const books = this.books();
    const nPos = books.reduce((a, [, b]) => a + b.s.positions.length, 0), nOrd = books.reduce((a, [, b]) => a + b.s.orders.length, 0);
    const nHist = this.paperMode ? this.app.paper.allHistory().length : this.broker.s.history.length;
    const tab = (k, label) => h('button', { class: this.tab === k ? 'active' : '', onclick: () => { this.tab = k; this.renderTabs(); this.renderTable(); } }, label);
    fill(this.tabs,
      tab('positions', `Positions (${nPos})`), tab('orders', `Orders (${nOrd})`), tab('history', `History (${nHist})`),
      h('div', { class: 'spacer' }),
      this.tab === 'positions' && nPos ? h('button', { class: 'btn small danger', onclick: () => this.closeAll() }, 'Close all') : null);
  }

  renderTable() {
    const paper = this.paperMode, books = this.books();
    const levelInput = (value, onSet, placeholder) => {
      const i = h('input', { type: 'number', step: 'any', value: value ?? '', placeholder });
      i.addEventListener('change', () => onSet(i.value === '' ? null : Number(i.value)));
      return i;
    };
    const symCell = sym => (paper ? h('td', null, h('button', { class: 'link', onclick: () => this.app.activeView.setSymbol(sym) }, sym)) : null);
    const symHead = paper ? ['Symbol'] : [];
    let table;
    if (this.tab === 'positions') {
      const rows = books.flatMap(([sym, b]) => b.s.positions.map(pos => ({ sym, b, pos })));
      table = h('table', null, h('thead', null, h('tr', null, [...symHead, 'Side', 'Lots', 'Entry', 'Price', 'Stop-loss', 'Take-profit', 'P&L', 'Opened', ''].map(x => h('th', null, x)))),
        h('tbody', null, rows.length ? rows.map(({ sym, b, pos }) => {
          const pnl = b.unrealized(pos), q = b.quote, p = precisionOf(sym);
          return h('tr', null, symCell(sym),
            h('td', { class: pos.side === 'buy' ? 'buy' : 'sell' }, pos.side.toUpperCase()),
            h('td', null, +pos.lots.toFixed(4)), h('td', null, fmtPrice(pos.entry, p)),
            h('td', null, fmtPrice(pos.side === 'buy' ? q.bid : q.ask, p)),
            h('td', null, levelInput(pos.sl, v => { const r = b.modifyPosition(pos.id, { sl: v }); if (!r.ok) toast(r.error, 'error'); this.afterChange(); }, 'none')),
            h('td', null, levelInput(pos.tp, v => { const r = b.modifyPosition(pos.id, { tp: v }); if (!r.ok) toast(r.error, 'error'); this.afterChange(); }, 'none')),
            h('td', { class: pnl >= 0 ? 'up' : 'down' }, fmtUsd(pnl, true)),
            h('td', { class: 'muted' }, fmtDateTime(pos.entryTime)),
            h('td', { class: 'actions' },
              h('button', { class: 'btn small', onclick: () => this.closePosition(pos.id, true, b, sym) }, '½'),
              h('button', { class: 'btn small', onclick: () => this.closePosition(pos.id, false, b, sym) }, 'Close')));
        }) : h('tr', null, h('td', { colspan: 10, class: 'muted center' }, paper ? 'No open paper positions — use the ticket, the chart\'s Buy / Sell buttons or right-click the chart' : 'No open positions'))));
    } else if (this.tab === 'orders') {
      const rows = books.flatMap(([sym, b]) => b.s.orders.map(o => ({ sym, b, o })));
      table = h('table', null, h('thead', null, h('tr', null, [...symHead, 'Side', 'Type', 'Lots', 'Price', 'Stop-loss', 'Take-profit', 'Placed', ''].map(x => h('th', null, x)))),
        h('tbody', null, rows.length ? rows.map(({ sym, b, o }) => h('tr', null, symCell(sym),
          h('td', { class: o.side === 'buy' ? 'buy' : 'sell' }, o.side.toUpperCase()), h('td', null, o.type), h('td', null, +o.lots.toFixed(4)),
          h('td', null, levelInput(o.price, v => { if (v != null) { if (sym === this.sess.symbol) this.moveLevel({ kind: 'order', id: o.id }, v); else { const r = b.modifyOrder(o.id, { price: v }); if (!r.ok) toast(r.error, 'error'); this.afterChange(); } } }, '')),
          h('td', null, levelInput(o.sl, v => { const r = b.modifyOrder(o.id, { sl: v }); if (!r.ok) toast(r.error, 'error'); this.afterChange(); }, 'none')),
          h('td', null, levelInput(o.tp, v => { const r = b.modifyOrder(o.id, { tp: v }); if (!r.ok) toast(r.error, 'error'); this.afterChange(); }, 'none')),
          h('td', { class: 'muted' }, fmtDateTime(o.placedAt)),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => { b.cancelOrder(o.id); this.afterChange(); } }, 'Cancel')))) :
          h('tr', null, h('td', { colspan: 9, class: 'muted center' }, 'No working orders'))));
    } else {
      const rows = (paper ? this.app.paper.allHistory() : this.broker.s.history.map(t => ({ ...t, symbol: this.sess.symbol }))).slice(-300).reverse();
      table = h('table', null, h('thead', null, h('tr', null, [...symHead, 'Closed', 'Side', 'Lots', 'Entry', 'Exit', 'Reason', 'Duration', 'Costs', 'R', 'P&L'].map(x => h('th', null, x)))),
        h('tbody', null, rows.length ? rows.map(t => { const p = precisionOf(t.symbol); return h('tr', null, symCell(t.symbol),
          h('td', { class: 'muted' }, fmtDateTime(t.exitTime)), h('td', { class: t.side === 'buy' ? 'buy' : 'sell' }, t.side.toUpperCase()),
          h('td', null, +t.lots.toFixed(4)), h('td', null, fmtPrice(t.entry, p)), h('td', null, fmtPrice(t.exit, p)),
          h('td', null, t.reason), h('td', null, fmtDuration(t.exitTime - t.entryTime)), h('td', null, fmtUsd(t.commission)),
          h('td', null, t.r != null ? t.r.toFixed(2) : '—'),
          h('td', { class: t.pnl >= 0 ? 'up' : 'down' }, fmtUsd(t.pnl, true))); }) : h('tr', null, h('td', { colspan: 11, class: 'muted center' }, 'No closed trades yet'))));
    }
    this.tableBox.replaceChildren(table);
  }

  renderTicket() {
    if (!this.ticketBox) return;
    const t = this.ticket, b = this.broker;
    const sideBtn = side => h('button', { class: `side ${side}${t.side === side ? ' active' : ''}`, onclick: () => { t.side = side; this.saveTicket(); this.renderTicket(); } }, side === 'buy' ? 'Buy' : 'Sell');
    const typeSel = h('div', { class: 'seg' }, [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop']].map(([v, l]) => h('button', {
      class: t.type === v ? 'active' : '', title: v === 'limit' ? 'Buy below / sell above the market' : v === 'stop' ? 'Buy above / sell below the market' : 'Fill now at the bid/ask',
      onclick: () => {
        t.type = v;
        // start a pending order a little away from the market, on the correct side
        if (v !== 'market' && !t.price && b.quote) {
          const q = b.quote, off = Math.max(q.spread * 5, q.ask * 0.001), buy = t.side === 'buy';
          t.price = (v === 'limit' ? (buy ? q.ask - off : q.bid + off) : (buy ? q.ask + off : q.bid - off)).toFixed(this.prec);
        }
        this.saveTicket(); this.renderTicket();
      } }, l)));
    const num = (key, attrs = {}) => {
      const i = h('input', { type: 'number', step: 'any', value: t[key], ...attrs });
      i.addEventListener('input', () => { t[key] = i.value; if (['lots', 'risk'].includes(key)) this.saveTicket(); this.updatePreview(); });
      return i;
    };
    const check = key => {
      const c = h('input', { type: 'checkbox', checked: t[key] });
      c.addEventListener('change', () => { t[key] = c.checked; this.saveTicket(); this.updatePreview(); });
      return c;
    };
    const sizeSel = h('select', { onchange: () => { t.sizeMode = sizeSel.value; this.saveTicket(); this.renderTicket(); } },
      [['risk', 'Risk % of equity'], ['lots', `Lots (${b.spec.lotName})`]].map(([v, l]) => h('option', { value: v, selected: t.sizeMode === v }, l)));
    this.quoteLine = h('div', { class: 'quote-line' });
    this.preview = h('div', { class: 'preview' });
    fill(this.ticketBox, 
      h('div', { class: 'ticket-head' }, h('b', null, `${this.replay.symbol}`), this.paperMode ? h('span', { class: 'badge paper' }, 'Paper · live') : null, this.quoteLine),
      h('div', { class: 'side-toggle' }, sideBtn('buy'), sideBtn('sell')),
      h('label', { class: 'field' }, h('span', null, 'Order type'), typeSel),
      t.type !== 'market' ? h('label', { class: 'field' }, h('span', null, `${t.type === 'limit' ? 'Limit' : 'Stop'} price`), num('price', { placeholder: 'price' })) : null,
      h('label', { class: 'field' }, h('span', null, 'Size'), sizeSel),
      t.sizeMode === 'risk' ? h('label', { class: 'field' }, h('span', null, 'Risk %'), num('risk', { min: 0, step: 0.1 })) : h('label', { class: 'field' }, h('span', null, 'Lots'), num('lots', { min: lotStep(b.spec), step: lotStep(b.spec) })),
      h('label', { class: 'field check' }, check('useSl'), h('span', null, 'Stop-loss'), num('sl', { placeholder: 'price' })),
      h('label', { class: 'field check' }, check('useTp'), h('span', null, 'Take-profit'), num('tp', { placeholder: 'price' })),
      this.preview,
      h('button', { class: `btn place ${t.side}`, onclick: () => this.submitTicket() }, `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.type === 'market' ? 'at market' : `${t.type === 'limit' ? 'Limit' : 'Stop'}${t.price ? ` @ ${t.price}` : ''}`}`),
      t.type !== 'market' ? h('p', { class: 'muted small ticket-tip' }, 'Tip: right-click the chart, or use the + on the price axis, to place a limit or stop at that price.') : null,
    );
    this.updatePreview();
  }

  updatePreview() {
    if (!this.preview || !this.replay.active) return;
    const t = this.ticket, b = this.broker, q = b.quote, p = this.prec;
    if (!q) return;
    this.quoteLine.replaceChildren(h('span', { class: 'down' }, `Bid ${fmtPrice(q.bid, p)}`), h('span', { class: 'muted' }, ` · spread ${fmtNum(q.spread, p)} · `), h('span', { class: 'up' }, `Ask ${fmtPrice(q.ask, p)}`));
    const entry = t.type === 'market' ? (t.side === 'buy' ? q.ask : q.bid) : Number(t.price);
    const sl = t.useSl && t.sl !== '' ? Number(t.sl) : null;
    const tp = t.useTp && t.tp !== '' ? Number(t.tp) : null;
    if (!(entry > 0)) { this.preview.replaceChildren(h('span', { class: 'muted' }, 'Enter an order price')); return; }
    const lots = this.lotsFor(entry, sl);
    const units = lots * b.spec.contractSize, dir = t.side === 'buy' ? 1 : -1;
    const lines = [h('div', null, h('span', null, 'Size'), h('b', null, lots > 0 ? `${+lots.toFixed(4)} lots (${units.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${b.spec.base})` : '—'))];
    if (lots > 0) {
      lines.push(h('div', null, h('span', null, 'Margin'), h('b', null, fmtUsd(b.notionalUsd(lots, entry) / b.cfg.leverage))));
      const err = b.validateLevels(t.side, entry, sl, tp);
      if (err) lines.push(h('div', { class: 'down' }, err));
      if (sl != null && !err) {
        const risk = quoteToUsd(b.spec, (entry - sl) * dir * units, entry);
        lines.push(h('div', null, h('span', null, 'Risk at SL'), h('b', { class: 'down' }, `${fmtUsd(-risk)} (${(risk / b.equity * 100).toFixed(2)}%)`)));
      }
      if (tp != null && !err) {
        const reward = quoteToUsd(b.spec, (tp - entry) * dir * units, tp);
        lines.push(h('div', null, h('span', null, 'Reward at TP'), h('b', { class: 'up' }, fmtUsd(reward, true))));
        if (sl != null) lines.push(h('div', null, h('span', null, 'Risk : reward'), h('b', null, `1 : ${(Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)}`)));
      }
      lines.push(h('div', { class: 'muted' }, `Commission ≈ ${fmtUsd(b.commissionSide(lots, entry) * 2)} round turn`));
    } else if (t.sizeMode === 'risk' && sl == null) lines.push(h('div', { class: 'muted' }, 'Set a stop-loss to size by risk'));
    this.preview.replaceChildren(...lines);
  }
}
