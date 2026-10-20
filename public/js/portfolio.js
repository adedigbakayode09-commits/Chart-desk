// Portfolios: record buys, sells, deposits and withdrawals; see holdings at average cost with live prices,
// unrealised and realised profit, allocation, and the portfolio's value over time against a benchmark.

import { h, icon, kv, toast, uid, fill, fmtUsd, fmtPct, fmtPrice, fmtNum, fmtDate, confirmBox, toUtcInput, parseUtcInput, openModal } from './util.js';
import { SYMBOLS, spec, fetchBars, precisionOf } from './data.js';
import { quoteToUsd } from './core/broker.js';
import { themeColors } from './chartview.js';

const LC = window.LightweightCharts;

/** Replay the transactions: holdings at average cost, realised P&L and cash (amounts in each symbol's quote currency — USD for gold, US indices and USDT pairs). */
export function holdingsOf(tx) {
  const pos = new Map();
  let cash = 0, realized = 0, deposits = 0, fees = 0;
  for (const t of [...tx].sort((a, b) => a.date - b.date)) {
    const fee = Number(t.fee) || 0;
    fees += fee;
    if (t.side === 'deposit') { cash += t.amount; deposits += t.amount; continue; }
    if (t.side === 'withdraw') { cash -= t.amount; deposits -= t.amount; continue; }
    const p = pos.get(t.symbol) || { symbol: t.symbol, qty: 0, cost: 0, realized: 0 };
    const value = t.qty * t.price;
    if (t.side === 'buy') { p.cost += value + fee; p.qty += t.qty; cash -= value + fee; }
    else {
      const avg = p.qty > 0 ? p.cost / p.qty : t.price, q = Math.min(t.qty, p.qty);
      const gain = (t.price - avg) * q - fee;
      p.realized += gain; realized += gain;
      p.cost -= avg * q; p.qty -= q; cash += value - fee;
    }
    pos.set(t.symbol, p);
  }
  return { positions: [...pos.values()], cash, realized, deposits, fees };
}

export class Portfolio {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.prices = {};
    this.history = new Map();
  }
  async init() {
    this.data = (await kv.get('portfolios')) || { active: 'Main', list: { Main: { tx: [], benchmark: 'XAUUSD' } } };
    if (!this.data.list[this.data.active]) this.data.active = Object.keys(this.data.list)[0];
    setInterval(() => { if (!this.host.hidden) this.refreshPrices(); }, 15e3);
  }
  get pf() { return this.data.list[this.data.active]; }
  save() { kv.set('portfolios', this.data); }
  /** Symbols held in any portfolio (the watchlist fetches live Binance prices for them too). */
  symbols() { return [...new Set(Object.values(this.data?.list || {}).flatMap(p => p.tx.map(t => t.symbol).filter(Boolean)))]; }

  price(symbol) {
    const q = this.app.watchlist?.quotes?.[symbol];
    if (q && !q.none && q.last != null && !this.app.replay?.active) return q.last;
    return this.prices[symbol] ?? null;
  }
  /** Latest prices for held symbols not on the watchlist (Binance live; others from saved candles, no API credits). */
  async refreshPrices() {
    const need = this.symbols().filter(s => spec(s) && this.app.watchlist?.quotes?.[s]?.last == null);
    await Promise.all(need.map(async s => {
      try { const { bars } = await fetchBars(s, '1d', { limit: 1, cachedOnly: spec(s).provider !== 'binance' }); if (bars.length) this.prices[s] = bars[bars.length - 1].close; } catch { /* keep the last one */ }
    }));
    this.render(false);
  }
  usd(symbol, amount, price) { const s = spec(symbol); return s ? quoteToUsd(s, amount, price) : amount; }

  // ---------------------------------------------------------------- transactions
  addTx(t) { this.pf.tx.push({ id: uid(), ...t }); this.save(); this.history.clear(); this.render(); }
  removeTx(id) { this.pf.tx = this.pf.tx.filter(t => t.id !== id); this.save(); this.history.clear(); this.render(); }
  openTxDialog(prefill = {}) {
    const modal = document.getElementById('alertModal'), body = document.getElementById('alertBody');
    const side = h('select', null, ['buy', 'sell', 'deposit', 'withdraw'].map(s => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
    side.value = prefill.side || 'buy';
    const sym = h('select', null, SYMBOLS.map(s => h('option', { value: s.symbol }, `${s.symbol} — ${s.name}`)));
    sym.value = prefill.symbol || this.app.activeView?.symbol || 'XAUUSD';
    const qty = h('input', { type: 'number', step: 'any', min: 0, placeholder: 'Units, e.g. 2 (oz of gold, BTC, shares)' });
    const price = h('input', { type: 'number', step: 'any', min: 0 });
    const amount = h('input', { type: 'number', step: 'any', min: 0, placeholder: 'USD' });
    const fee = h('input', { type: 'number', step: 'any', min: 0, value: 0 });
    const date = h('input', { type: 'datetime-local', value: toUtcInput(Math.floor(Date.now() / 1000)) });
    const note = h('input', { type: 'text', placeholder: 'Optional' });
    const setPrice = () => { const p = this.price(sym.value); if (p != null) price.value = p.toFixed(precisionOf(sym.value)); };
    sym.addEventListener('change', setPrice);
    setPrice();
    const row = (l, el) => h('label', { class: 'field wide' }, h('span', null, l), el);
    const form = h('div', { class: 'form-grid alert-form' });
    const paint = () => {
      const cashOnly = side.value === 'deposit' || side.value === 'withdraw';
      fill(form, row('Type', side), cashOnly ? row('Amount (USD)', amount) : [row('Symbol', sym), row('Quantity', qty), row('Price', price), row('Fee (USD)', fee)], row('Date (UTC)', date), row('Note', note));
    };
    side.addEventListener('change', paint);
    paint();
    const submit = () => {
      const t = { side: side.value, date: parseUtcInput(date.value) ?? Math.floor(Date.now() / 1000), note: note.value.trim() };
      if (t.side === 'deposit' || t.side === 'withdraw') {
        t.amount = parseFloat(amount.value);
        if (!(t.amount > 0)) { toast('Enter an amount', 'error'); return; }
      } else {
        Object.assign(t, { symbol: sym.value, qty: parseFloat(qty.value), price: parseFloat(price.value), fee: parseFloat(fee.value) || 0 });
        if (!(t.qty > 0) || !(t.price > 0)) { toast('Enter a quantity and price', 'error'); return; }
        if (t.side === 'sell') { const held = holdingsOf(this.pf.tx).positions.find(p => p.symbol === t.symbol)?.qty || 0; if (t.qty > held + 1e-9) { toast(`You hold ${fmtNum(held, 6)} ${t.symbol}`, 'error'); return; } }
      }
      this.addTx(t);
      modal.hidden = true;
      toast(`Recorded: ${t.side} ${t.symbol ? `${t.qty} ${t.symbol} @ ${t.price}` : fmtUsd(t.amount)}`);
    };
    fill(body, form, h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => { modal.hidden = true; } }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, 'Add')));
    document.getElementById('alertTitle').textContent = `Add transaction · ${this.data.active}`;
    openModal(modal);
  }

  // ---------------------------------------------------------------- value over time
  /** Daily portfolio value (USD) and the benchmark rebased to the same start. */
  async performance() {
    const tx = this.pf.tx.filter(t => t.date);
    if (!tx.length) return null;
    const start = Math.min(...tx.map(t => t.date)) - 86400;
    const syms = [...new Set(tx.map(t => t.symbol).filter(Boolean))], bench = this.pf.benchmark || 'XAUUSD';
    const closes = new Map();
    await Promise.all([...syms, bench].filter(s => spec(s)).map(async s => {
      if (this.history.has(s)) { closes.set(s, this.history.get(s)); return; }
      try {
        const days = Math.ceil((Date.now() / 1000 - start) / 86400) + 5;
        const { bars } = await fetchBars(s, '1d', { limit: Math.min(5000, days + 5) });
        const m = new Map(bars.map(b => [Math.floor(b.time / 86400), b.close]));
        this.history.set(s, m); closes.set(s, m);
      } catch { closes.set(s, new Map()); }
    }));
    const sorted = [...tx].sort((a, b) => a.date - b.date), out = [], bout = [];
    const last = new Map();
    let k = 0, b0 = null, v0 = null;
    const today = Math.floor(Date.now() / 1000 / 86400);
    for (let d = Math.floor(start / 86400); d <= today; d++) {
      while (k < sorted.length && sorted[k].date < (d + 1) * 86400) k++;
      const h0 = holdingsOf(sorted.slice(0, k));
      for (const s of [...syms, bench]) { const c = closes.get(s)?.get(d); if (c != null) last.set(s, c); }
      let value = h0.cash;
      for (const p of h0.positions) { const c = last.get(p.symbol); if (c != null) value += this.usd(p.symbol, p.qty * c, c); }
      if (!k) continue;
      const t = d * 86400;
      out.push({ time: t, value });
      const bc = last.get(bench);
      if (bc != null) { b0 ??= bc; v0 ??= value; bout.push({ time: t, value: v0 * bc / b0 }); }
    }
    return { value: out, bench: bout, benchmark: bench };
  }

  // ---------------------------------------------------------------- panel
  render(full = true) {
    if (!this.host || this.host.hidden || !this.data) return;
    const pf = this.pf, H = holdingsOf(pf.tx);
    let invested = 0, value = H.cash, unreal = 0;
    const rows = H.positions.filter(p => p.qty > 1e-12).map(p => {
      const last = this.price(p.symbol), prec = precisionOf(p.symbol);
      const mv = last != null ? this.usd(p.symbol, p.qty * last, last) : null, cost = this.usd(p.symbol, p.cost, last ?? p.cost / p.qty);
      invested += cost; if (mv != null) { value += mv; unreal += mv - cost; }
      return { p, last, prec, mv, cost };
    });
    const total = value, ret = H.deposits > 0 ? (total - H.deposits) / H.deposits * 100 : invested > 0 ? (unreal + H.realized) / invested * 100 : null;
    const card = (l, v, cls = '') => h('div', { class: 'acc-cell' }, h('span', null, l), h('b', { class: cls }, v));
    const sel = h('select', { onchange: e => { this.data.active = e.target.value; this.save(); this.history.clear(); this.render(); } }, Object.keys(this.data.list).map(n => h('option', { value: n }, n)));
    sel.value = this.data.active;
    const benchSel = h('select', { title: 'Benchmark for the performance chart', onchange: e => { pf.benchmark = e.target.value; this.save(); this.renderChart(); } }, SYMBOLS.map(s => h('option', { value: s.symbol }, `vs ${s.symbol}`)));
    benchSel.value = pf.benchmark || 'XAUUSD';
    this.chartBox = h('div', { class: 'pf-chart' });
    fill(this.host, h('div', { class: 'portfolio' },
      h('div', { class: 'sc-bar' }, sel,
        h('button', { class: 'btn small primary', onclick: () => this.openTxDialog() }, icon('plus'), 'Add transaction'),
        h('button', { class: 'btn small', onclick: () => this.app.prompt('New portfolio name', '', n => { if (!n || this.data.list[n]) return; this.data.list[n] = { tx: [], benchmark: 'XAUUSD' }; this.data.active = n; this.save(); this.render(); }) }, icon('folder'), 'New'),
        h('button', { class: 'btn small', onclick: () => this.app.prompt('Rename portfolio', this.data.active, n => { if (!n || this.data.list[n]) return; this.data.list[n] = this.pf; delete this.data.list[this.data.active]; this.data.active = n; this.save(); this.render(); }) }, icon('edit')),
        h('button', { class: 'btn small', onclick: async () => { if (Object.keys(this.data.list).length < 2) { toast('Keep at least one portfolio'); return; } if (await confirmBox(`Delete portfolio “${this.data.active}” and its ${pf.tx.length} transactions?`, 'Delete')) { delete this.data.list[this.data.active]; this.data.active = Object.keys(this.data.list)[0]; this.save(); this.render(); } } }, icon('trash')),
        h('span', { class: 'spacer' }), benchSel),
      h('div', { class: 'account pf-cards' },
        card('Total value', fmtUsd(total)), card('Cash', fmtUsd(H.cash), H.cash < 0 ? 'down' : ''), card('Invested (cost)', fmtUsd(invested)),
        card('Unrealised P&L', fmtUsd(unreal, true), unreal >= 0 ? 'up' : 'down'), card('Realised P&L', fmtUsd(H.realized, true), H.realized >= 0 ? 'up' : 'down'),
        card('Total return', ret == null ? '—' : fmtPct(ret), ret >= 0 ? 'up' : 'down')),
      h('div', { class: 'pf-body' },
        h('div', { class: 'tp-table pf-holdings' }, h('table', null,
          h('thead', null, h('tr', null, ['Symbol', 'Quantity', 'Avg cost', 'Last', 'Value', 'P&L', 'P&L %', 'Weight', ''].map(x => h('th', null, x)))),
          h('tbody', null, rows.length ? rows.map(({ p, last, prec, mv, cost }) => {
            const pnl = mv != null ? mv - cost : null;
            return h('tr', { class: 'clickable', onclick: () => this.app.activeView.setSymbol(p.symbol) },
              h('td', null, h('b', null, p.symbol)), h('td', null, fmtNum(p.qty, p.qty < 10 ? 6 : 2)), h('td', null, fmtPrice(p.cost / p.qty, prec)),
              h('td', null, last != null ? fmtPrice(last, prec) : '—'), h('td', null, mv != null ? fmtUsd(mv) : '—'),
              h('td', { class: pnl >= 0 ? 'up' : 'down' }, pnl != null ? fmtUsd(pnl, true) : '—'), h('td', { class: pnl >= 0 ? 'up' : 'down' }, pnl != null && cost ? fmtPct(pnl / cost * 100) : '—'),
              h('td', null, mv != null && total > 0 ? `${(mv / total * 100).toFixed(1)}%` : '—'),
              h('td', { class: 'actions' }, h('button', { class: 'btn small', title: 'Sell', onclick: e => { e.stopPropagation(); this.openTxDialog({ side: 'sell', symbol: p.symbol }); } }, 'Sell')));
          }) : h('tr', null, h('td', { colspan: 9, class: 'muted' }, 'No holdings yet — add a buy (and a deposit if you want cash tracked).'))))),
        this.chartBox),
      pf.tx.length ? h('details', { class: 'alerts-log' }, h('summary', null, `Transactions (${pf.tx.length})`),
        h('div', { class: 'tp-table' }, h('table', null, h('thead', null, h('tr', null, ['Date', 'Type', 'Symbol', 'Quantity', 'Price', 'Fee', 'Note', ''].map(x => h('th', null, x)))),
          h('tbody', null, [...pf.tx].sort((a, b) => b.date - a.date).map(t => h('tr', null,
            h('td', null, fmtDate(t.date)), h('td', { class: t.side === 'buy' ? 'buy' : t.side === 'sell' ? 'sell' : '' }, t.side), h('td', null, t.symbol || '—'),
            h('td', null, t.qty != null ? fmtNum(t.qty, 6) : fmtUsd(t.amount)), h('td', null, t.price != null ? fmtPrice(t.price, precisionOf(t.symbol)) : ''),
            h('td', null, t.fee ? fmtUsd(t.fee) : ''), h('td', { class: 'ellipsis' }, t.note || ''),
            h('td', { class: 'actions' }, h('button', { class: 'btn small', title: 'Delete', onclick: () => this.removeTx(t.id) }, icon('trash'))))))))) : null));
    if (full) this.renderChart();
    else if (this.chartData) this.drawChart(this.chartData);
  }
  async renderChart() {
    if (!this.chartBox) return;
    if (!this.pf.tx.length) { fill(this.chartBox, h('div', { class: 'muted small pf-empty' }, 'The value-over-time chart appears after the first transaction.')); return; }
    fill(this.chartBox, h('div', { class: 'muted small pf-empty' }, 'Calculating value over time…'));
    try { this.chartData = await this.performance(); } catch (e) { fill(this.chartBox, h('div', { class: 'muted small pf-empty' }, e.message)); return; }
    this.drawChart(this.chartData);
  }
  drawChart(d) {
    if (!d || !this.chartBox) return;
    this.chart?.remove();
    this.chartBox.replaceChildren();
    const c = themeColors(this.app.theme);
    this.chart = LC.createChart(this.chartBox, { autoSize: true, layout: { background: { type: LC.ColorType.Solid, color: c.bg }, textColor: c.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false } });
    this.chart.addAreaSeries({ lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.25)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2, title: 'Portfolio', priceFormat: { type: 'price', precision: 0, minMove: 1 } }).setData(d.value);
    if (d.bench.length) this.chart.addLineSeries({ color: '#ff9800', lineWidth: 1, title: d.benchmark, priceFormat: { type: 'price', precision: 0, minMove: 1 } }).setData(d.bench);
    this.chart.timeScale().fitContent();
  }
}
