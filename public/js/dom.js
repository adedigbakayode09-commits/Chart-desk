// Depth of Market: live order book ladder and recent trades for Binance pairs (public REST depth, aggTrade stream).
// Prices are grouped to a chosen step; click a bid / ask row to place a paper (or Bar Replay) limit order there.
// Forex, metals and indices have no public order book (they trade over the counter), so the panel says so.

import { h, fill, fmtPrice, fmtVol as fmtBig, toast } from './util.js';

const fmtVol = v => (Math.abs(v) < 1 ? v.toFixed(v === 0 ? 0 : Math.abs(v) < 0.01 ? 5 : 3) : fmtBig(v)); // BTC trades are often 0.0001
import { spec, precisionOf } from './data.js';

const BINANCE = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/ws';

export class DepthOfMarket {
  constructor(app, host) { this.app = app; this.host = host; this.trades = []; this.step = null; }

  get symbol() { return this.app.activeView?.symbol; }
  start() {
    const s = this.symbol;
    if (this.running === s) return;
    this.stop();
    this.running = s;
    this.trades = [];
    this.book = null;
    this.render();
    if (spec(s)?.provider !== 'binance') return;
    this.timer = setInterval(() => this.poll(), 1000);
    this.poll();
    this.ws = new WebSocket(`${WS}/${s.toLowerCase()}@aggTrade`);
    this.ws.onmessage = e => {
      const t = JSON.parse(e.data);
      this.trades.unshift({ price: +t.p, qty: +t.q, sell: t.m, time: t.T });
      if (this.trades.length > 60) this.trades.length = 60;
      this.dirty = true;
    };
    this.paintTimer = setInterval(() => { if (this.dirty) { this.dirty = false; this.paint(); } }, 250);
  }
  stop() {
    clearInterval(this.timer); clearInterval(this.paintTimer);
    if (this.ws) { this.ws.onmessage = null; this.ws.close(); this.ws = null; }
    this.running = null;
  }
  async poll() {
    if (this.host.hidden) { this.stop(); return; }
    try {
      const r = await fetch(`${BINANCE}/depth?symbol=${this.running}&limit=500`);
      if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
      const d = await r.json();
      this.book = { bids: d.bids.map(([p, q]) => [+p, +q]), asks: d.asks.map(([p, q]) => [+p, +q]) };
      this.paint();
    } catch (e) { this.error = e.message; }
  }
  /** Group levels to the price step (bids floor, asks ceiling), keep `n` rows a side. */
  grouped(n = 18) {
    const { bids, asks } = this.book, mid = (bids[0][0] + asks[0][0]) / 2;
    const step = this.step || this.autoStep(mid);
    const g = (rows, f) => { const m = new Map(); for (const [p, q] of rows) { const k = f(p / step) * step; m.set(k, (m.get(k) || 0) + q); } return [...m.entries()]; };
    const B = g(bids, Math.floor).sort((a, b) => b[0] - a[0]).slice(0, n), A = g(asks, Math.ceil).sort((a, b) => a[0] - b[0]).slice(0, n);
    return { B, A, step, mid, spread: asks[0][0] - bids[0][0] };
  }
  autoStep(mid) { const raw = mid * 0.00005, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || p; }

  render() {
    if (!this.host || this.host.hidden) return;
    const s = this.symbol, sp = spec(s);
    if (sp?.provider !== 'binance') {
      fill(this.host, h('div', { class: 'panel-empty small' }, h('h3', null, 'Order book (DOM)'),
        h('p', null, `${s} trades over the counter — there's no public order book for forex, metals or index CFDs (TradingView shows a DOM only through a connected broker). Open a Binance pair such as BTCUSDT to see live depth and trades.`)));
      return;
    }
    const steps = [0.01, 0.1, 0.5, 1, 5, 10, 50, 100].filter(x => x >= 10 ** -precisionOf(s));
    const stepSel = h('select', { onchange: e => { this.step = e.target.value === 'auto' ? null : Number(e.target.value); this.paint(); } },
      h('option', { value: 'auto' }, 'Group: auto'), steps.map(x => h('option', { value: x }, `Group: ${x}`)));
    stepSel.value = this.step == null ? 'auto' : String(this.step);
    this.ladder = h('div', { class: 'dom-ladder' });
    this.tape = h('div', { class: 'dom-tape' });
    fill(this.host, h('div', { class: 'dom' },
      h('div', { class: 'sc-bar' }, h('b', null, `${s} order book`), stepSel, h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, 'Binance spot · click a level to place a limit order (paper trading / Bar Replay)')),
      h('div', { class: 'dom-body' }, this.ladder, h('div', { class: 'dom-side' }, h('div', { class: 'dom-head' }, 'Recent trades'), this.tape))));
    this.paint();
  }
  paint() {
    if (!this.ladder || !this.book?.bids.length || !this.book?.asks.length) return;
    const s = this.running, prec = precisionOf(s);
    const { B, A, step, mid, spread } = this.grouped();
    const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const cumB = []; let c = 0; for (const [, q] of B) cumB.push(c += q);
    const cumA = []; c = 0; for (const [, q] of A) cumA.push(c += q);
    const max = Math.max(cumB[cumB.length - 1] || 0, cumA[cumA.length - 1] || 0) || 1;
    const row = (side, p, q, cum) => h('div', { class: `dom-row ${side}`, title: `Place a ${side === 'bid' ? 'buy' : 'sell'} limit at ${p.toFixed(dec)}`, onclick: () => this.order(side === 'bid' ? 'buy' : 'sell', p) },
      h('i', { class: 'dom-bar', style: { width: `${cum / max * 100}%` } }),
      h('span', { class: 'dom-p' }, p.toFixed(dec)), h('span', null, fmtVol(q)), h('span', { class: 'muted' }, fmtVol(cum)));
    fill(this.ladder,
      h('div', { class: 'dom-row dom-cols' }, h('span', null, 'Price'), h('span', null, 'Size'), h('span', null, 'Total')),
      [...A.map(([p, q], i) => row('ask', p, q, cumA[i]))].reverse(),
      h('div', { class: 'dom-mid' }, h('b', null, fmtPrice(mid, prec)), h('span', { class: 'muted small' }, ` spread ${fmtPrice(spread, prec)}`)),
      B.map(([p, q], i) => row('bid', p, q, cumB[i])));
    fill(this.tape, this.trades.slice(0, 40).map(t => h('div', { class: `dom-trade ${t.sell ? 'down' : 'up'}` },
      h('span', null, fmtPrice(t.price, prec)), h('span', null, fmtVol(t.qty)), h('span', { class: 'muted' }, new Date(t.time).toLocaleTimeString()))));
  }
  order(side, price) {
    const T = this.app.trading;
    if (!T.sess?.active || T.sess.symbol !== this.running) { toast('Turn on paper trading (Trading panel) to place orders from the order book', 'error'); return; }
    T.placeAtPrice(side, price);
  }
}
