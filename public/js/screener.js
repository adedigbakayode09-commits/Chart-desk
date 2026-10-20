// Screener: filter and sort markets by price, change, volume, performance and technicals.
//   Crypto  — every Binance USDT pair (24h tickers in one request; technicals from daily candles of the most traded)
//   ChartDesk symbols — forex, metals, indices and crypto in the catalog (saved daily candles only, so no API credits)
// Technical rating follows TradingView's idea: moving averages and oscillators each vote buy / sell / neutral.

import { h, icon, kv, toast, fill, fmtPrice, fmtPct, fmtVol, clamp } from './util.js';
import { SYMBOLS, spec, fetchBars, precisionOf, registerBinanceSymbol, TIMEFRAMES, tfSec, tfLabel } from './data.js';
import { listScripts, getScript, runScript } from './scripts.js';
import * as I from './core/indicators.js';

const BINANCE = 'https://data-api.binance.vision/api/v3';
const SKIP = /(UP|DOWN|BULL|BEAR)USDT$|^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|EUR|EURI|AEUR|USDE|USD1|PYUSD|USDS|RLUSD|BFUSD|XUSD)USDT$/; // leveraged tokens and stablecoins

export const PRESETS = {
  all: { label: 'All', sort: ['volume', -1] },
  gainers: { label: 'Top gainers', sort: ['chg', -1] },
  losers: { label: 'Top losers', sort: ['chg', 1] },
  active: { label: 'Most active', sort: ['volume', -1] },
  oversold: { label: 'Oversold (RSI < 30)', f: { rsiMax: 30 }, sort: ['rsi', 1] },
  overbought: { label: 'Overbought (RSI > 70)', f: { rsiMin: 70 }, sort: ['rsi', -1] },
  uptrend: { label: 'Above 50 & 200 SMA', f: { above50: true, above200: true }, sort: ['perfM', -1] },
  strongbuy: { label: 'Rating: strong buy', f: { ratingMin: 0.5 }, sort: ['rating', -1] },
  strongsell: { label: 'Rating: strong sell', f: { ratingMax: -0.5 }, sort: ['rating', 1] },
  volatile: { label: 'Most volatile (ATR %)', sort: ['atrPct', -1] },
};
const COLS = [
  ['symbol', 'Symbol'], ['price', 'Price'], ['chg', 'Chg %'], ['volume', 'Volume'], ['range', 'Day range'], ['perfW', 'Perf 1W'], ['perfM', 'Perf 1M'],
  ['perfY', 'Perf YTD'], ['rsi', 'RSI 14'], ['sma50', 'vs SMA 50'], ['sma200', 'vs SMA 200'], ['atrPct', 'ATR %'], ['rating', 'Technical rating'],
];
const FILTERS = [['price', 'Price'], ['chg', 'Change %'], ['volume', 'Volume'], ['perfW', 'Perf 1W %'], ['perfM', 'Perf 1M %'], ['rsi', 'RSI 14'], ['atrPct', 'ATR %']];

/** TradingView-style summary in [-1, 1]: moving averages and oscillators each vote. */
export function technicalRating(bars) {
  if (bars.length < 60) return null;
  const C = bars.map(b => b.close), n = C.length - 1, c = C[n];
  let ma = 0, maN = 0, osc = 0, oscN = 0;
  for (const len of [10, 20, 30, 50, 100, 200]) for (const f of [I.sma, I.ema]) { const v = f(C, len)[n]; if (v != null) { ma += c > v ? 1 : c < v ? -1 : 0; maN++; } }
  const vote = (cond, buy, sell) => { if (cond == null) return; osc += buy ? 1 : sell ? -1 : 0; oscN++; };
  const r = I.rsi(C, 14)[n]; vote(r, r < 30, r > 70);
  const st = I.stoch(bars, 14, 3, 3).k[n]; vote(st, st < 20, st > 80);
  const cc = I.cci(bars, 20)[n]; vote(cc, cc < -100, cc > 100);
  const m = I.macd(C, 12, 26, 9); vote(m.line[n], m.line[n] > m.signal[n], m.line[n] < m.signal[n]);
  const mo = I.momentum(C, 10)[n]; vote(mo, mo > 0, mo < 0);
  const wr = I.williamsR(bars, 14)[n]; vote(wr, wr < -80, wr > -20);
  const a = I.adx(bars, 14, 14); vote(a.adx[n], a.adx[n] > 20 && a.plus[n] > a.minus[n], a.adx[n] > 20 && a.plus[n] < a.minus[n]);
  return ((maN ? ma / maN : 0) + (oscN ? osc / oscN : 0)) / 2;
}
export const ratingLabel = v => (v == null ? '—' : v > 0.5 ? 'Strong buy' : v > 0.1 ? 'Buy' : v < -0.5 ? 'Strong sell' : v < -0.1 ? 'Sell' : 'Neutral');

/** Daily-candle statistics for one symbol. */
export function dailyStats(bars) {
  if (!bars.length) return {};
  const C = bars.map(b => b.close), n = C.length - 1, c = C[n];
  const back = days => { const t = bars[n].time - days * 86400; let i = n; while (i > 0 && bars[i].time > t) i--; return i < n ? (c - C[i]) / C[i] * 100 : null; };
  const y0 = Date.UTC(new Date(bars[n].time * 1000).getUTCFullYear(), 0, 1) / 1000, yi = bars.findIndex(b => b.time >= y0);
  const s50 = I.sma(C, 50)[n], s200 = I.sma(C, 200)[n], at = I.atr(bars, 14)[n];
  return {
    perfW: back(7), perfM: back(30), perfY: yi > 0 ? (c - C[yi - 1]) / C[yi - 1] * 100 : null,
    rsi: I.rsi(C, 14)[n], sma50: s50 != null ? (c - s50) / s50 * 100 : null, sma200: s200 != null ? (c - s200) / s200 * 100 : null,
    atrPct: at != null ? at / c * 100 : null, rating: technicalRating(bars),
  };
}

export class Screener {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.st = { market: 'crypto', preset: 'all', q: '', f: {}, sort: ['volume', -1], ...(kv.peek('screener') || {}) };
    this.rows = { crypto: [], catalog: [] };
    this.daily = new Map(); // symbol → { at, stats }
  }
  save() { const { market, preset, f, sort, saved } = this.st; kv.set('screener', { market, preset, f, sort, saved }); }
  async init() { Object.assign(this.st, (await kv.get('screener')) || {}); }

  async refresh(force = false) {
    if (this.loading) return;
    this.loading = true;
    this.render();
    try {
      if (this.st.market === 'crypto') await this.loadCrypto(force);
      else await this.loadCatalog(force);
      this.loadedAt = Date.now();
    } catch (e) { toast(`Screener: ${e.message}`, 'error'); }
    finally { this.loading = false; this.render(); }
  }
  async loadCrypto(force) {
    if (!force && this.rows.crypto.length && Date.now() - (this.cryptoAt || 0) < 60e3) return;
    const r = await fetch(`${BINANCE}/ticker/24hr`);
    if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
    const all = (await r.json()).filter(t => t.symbol.endsWith('USDT') && !SKIP.test(t.symbol) && +t.quoteVolume > 0 && t.count > 0);
    this.rows.crypto = all.map(t => ({
      symbol: t.symbol, name: `${t.symbol.slice(0, -4)} / TetherUS`, price: +t.lastPrice, chg: +t.priceChangePercent, volume: +t.quoteVolume,
      range: +t.highPrice > +t.lowPrice ? (+t.lastPrice - +t.lowPrice) / (+t.highPrice - +t.lowPrice) * 100 : null, src: 'binance',
    }));
    this.cryptoAt = Date.now();
    // technicals from daily candles for the 80 most traded pairs (cached 15 minutes)
    const top = [...this.rows.crypto].sort((a, b) => b.volume - a.volume).slice(0, 80);
    let done = 0;
    await Promise.all(top.map(async row => {
      const c = this.daily.get(row.symbol);
      if (c && Date.now() - c.at < 15 * 60e3) return;
      try {
        const k = await (await fetch(`${BINANCE}/klines?symbol=${row.symbol}&interval=1d&limit=400`)).json();
        const bars = k.map(x => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }));
        this.daily.set(row.symbol, { at: Date.now(), stats: dailyStats(bars) });
      } catch { /* skip this pair */ }
      if (++done % 20 === 0) this.render();
    }));
  }
  async loadCatalog(force) {
    const syms = SYMBOLS;
    const out = [];
    await Promise.all(syms.map(async s => {
      const c = this.daily.get(s.symbol);
      let bars = c?.bars;
      if (!bars || force || Date.now() - c.at > 10 * 60e3) {
        try {
          // ChartDesk symbols: saved daily candles only (no Twelve Data credits); Binance pairs are free to fetch
          bars = (await fetchBars(s.symbol, '1d', { limit: 400, cachedOnly: s.provider !== 'binance' })).bars;
          this.daily.set(s.symbol, { at: Date.now(), bars, stats: dailyStats(bars) });
        } catch { bars = []; }
      }
      const q = this.app.watchlist?.quotes?.[s.symbol], last = bars[bars.length - 1], prev = bars[bars.length - 2];
      const price = q && !q.none && q.last != null ? q.last : last?.close;
      out.push({
        symbol: s.symbol, name: s.name, market: s.market, src: s.provider, price: price ?? null,
        chg: q && !q.none && q.open ? (q.last - q.open) / q.open * 100 : last && prev ? (last.close - prev.close) / prev.close * 100 : null,
        volume: q?.volume ?? last?.volume ?? null, range: last && last.high > last.low ? ((price ?? last.close) - last.low) / (last.high - last.low) * 100 : null,
        noData: !bars.length,
      });
    }));
    this.rows.catalog = out;
  }

  /** Rows with technicals merged, filtered and sorted. */
  view() {
    const f = { ...(PRESETS[this.st.preset]?.f || {}), ...this.st.f };
    const q = this.st.q.trim().toUpperCase();
    let rows = (this.st.market === 'crypto' ? this.rows.crypto : this.rows.catalog).map(r => ({ ...r, ...(this.daily.get(r.symbol)?.stats || {}) }));
    rows = rows.filter(r => {
      if (q && !r.symbol.includes(q) && !String(r.name || '').toUpperCase().includes(q)) return false;
      for (const [k] of FILTERS) {
        const lo = f[`${k}Min`], hi = f[`${k}Max`];
        if (lo != null && lo !== '' && !(r[k] >= lo)) return false;
        if (hi != null && hi !== '' && !(r[k] <= hi)) return false;
      }
      if (f.above50 && !(r.sma50 > 0)) return false;
      if (f.above200 && !(r.sma200 > 0)) return false;
      if (f.ratingMin != null && !(r.rating >= f.ratingMin)) return false;
      if (f.ratingMax != null && !(r.rating <= f.ratingMax)) return false;
      return true;
    });
    const [key, dir] = this.st.sort;
    rows.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * dir;
      return ((x ?? -Infinity * dir) - (y ?? -Infinity * dir)) * dir || 0;
    });
    return rows;
  }

  open(symbol, name) {
    if (!spec(symbol)) registerBinanceSymbol(symbol, name);
    this.app.activeView.setSymbol(symbol);
  }

  exportCsv(rows) {
    const lines = [COLS.map(c => c[1]).join(',')];
    for (const r of rows) lines.push(COLS.map(([k]) => (k === 'rating' ? ratingLabel(r.rating) : r[k] == null ? '' : String(r[k]))).join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `screener_${this.st.market}_${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  render() {
    if (!this.host || this.host.hidden) { this.dirty = true; return; }
    this.dirty = false;
    if (this.st.market === 'pine') { this.renderPine(); return; }
    const st = this.st, rows = this.view();
    const head = COLS.map(([k, l]) => h('th', { class: 'sortable' + (st.sort[0] === k ? ' sorted' : ''), onclick: () => { st.sort = [k, st.sort[0] === k ? -st.sort[1] : k === 'symbol' ? 1 : -1]; this.save(); this.render(); } },
      l, st.sort[0] === k ? (st.sort[1] > 0 ? ' ▲' : ' ▼') : ''));
    const market = this.marketSelect();
    market.value = st.market;
    const preset = h('select', { onchange: e => { st.preset = e.target.value; st.sort = [...PRESETS[st.preset].sort]; this.save(); this.render(); } },
      Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, p.label)),
      ...Object.keys(st.saved || {}).map(n => h('option', { value: `saved:${n}` }, `★ ${n}`)));
    preset.value = st.preset;
    preset.addEventListener('change', () => { if (preset.value.startsWith('saved:')) { const sv = st.saved[preset.value.slice(6)]; Object.assign(st, structuredClone(sv), { preset: 'all' }); this.save(); this.render(); } });
    const search = h('input', { type: 'search', placeholder: 'Search symbol', value: st.q, oninput: e => { st.q = e.target.value; clearTimeout(this.qt); this.qt = setTimeout(() => this.renderTable(), 120); } });
    const activeFilters = Object.values(st.f).filter(v => v !== '' && v != null && v !== false).length;
    this.tbody = h('tbody');
    fill(this.host, h('div', { class: 'screener' },
      h('div', { class: 'sc-bar' }, market, preset, search,
        h('button', { class: 'btn small' + (activeFilters ? ' primary' : ''), onclick: e => this.openFilters(e.currentTarget) }, icon('list'), `Filters${activeFilters ? ` (${activeFilters})` : ''}`),
        h('button', { class: 'btn small', onclick: () => this.refresh(true), disabled: this.loading }, icon('replay'), this.loading ? 'Loading…' : 'Refresh'),
        h('button', { class: 'btn small', title: 'Save these filters and sorting as a screen', onclick: () => this.app.prompt('Save screen as', '', n => { if (!n) return; st.saved = { ...(st.saved || {}), [n]: { market: st.market, f: structuredClone(st.f), sort: [...st.sort], q: st.q } }; this.save(); this.render(); toast(`Screen “${n}” saved`); }) }, icon('save')),
        h('button', { class: 'btn small', title: 'Export the results as CSV', onclick: () => this.exportCsv(this.view()) }, icon('download')),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small', id: 'scCount' }, `${rows.length} of ${(st.market === 'crypto' ? this.rows.crypto : this.rows.catalog).length}${this.loadedAt ? ` · updated ${new Date(this.loadedAt).toLocaleTimeString()}` : ''}`)),
      h('div', { class: 'tp-table' }, h('table', { class: 'sc-table' }, h('thead', null, h('tr', null, head)), this.tbody)),
      h('p', { class: 'muted small sc-note' }, st.market === 'crypto'
        ? 'Prices and 24h change from Binance; performance, RSI, moving averages, ATR and rating from daily candles of the 80 most traded pairs (others show —). Click a row to chart it.'
        : 'Uses saved daily candles only, so it never spends Twelve Data credits — open a symbol\'s 1D chart once to include it. Click a row to chart it.')));
    this.renderTable(rows);
    if (!this.loadedAt && !this.loading) this.refresh();
  }
  marketSelect() {
    const st = this.st;
    const sel = h('select', { onchange: e => { st.market = e.target.value; this.save(); if (st.market === 'pine') this.render(); else this.refresh(); } },
      h('option', { value: 'crypto' }, 'Crypto — all Binance USDT pairs'), h('option', { value: 'catalog' }, 'ChartDesk symbols — forex, metals, indices'),
      h('option', { value: 'pine' }, 'Pine Screener — run a script on many symbols'));
    sel.value = st.market;
    return sel;
  }

  // ---------------------------------------------------------------- Pine Screener
  /** Symbols to screen: a watchlist, or the most traded Binance pairs. */
  pineSymbols() {
    const src = this.st.pineList || `wl:${this.app.watchlist?.data?.active || 'Main'}`;
    if (src.startsWith('wl:')) return (this.app.watchlist?.data?.lists?.[src.slice(3)] || []).filter(x => spec(x));
    const top = [...this.rows.crypto].sort((a, b) => b.volume - a.volume).slice(0, Number(src.slice(4)) || 30).map(r => r.symbol);
    return top;
  }
  async runPine() {
    const st = this.st, sc = getScript(st.pineScript);
    if (!sc?.meta) { toast('Pick a saved script first', 'error'); return; }
    if (this.pineRunning) return;
    if ((st.pineList || '').startsWith('top:') && !this.rows.crypto.length) await this.loadCrypto(false);
    const syms = this.pineSymbols(), tf = st.pineTf || '1h';
    if (!syms.length) { toast('That list has no symbols', 'error'); return; }
    this.pineRunning = true;
    this.pineRows = [];
    this.pineCols = sc.meta.plots.map(p => p.title).slice(0, 6);
    const params = Object.fromEntries(sc.meta.inputs.map(i => [i.name, i.def]));
    let k = 0;
    try {
      for (const sym of syms) {
        k++;
        this.pineStatus = `Running ${sc.name} on ${sym} (${k}/${syms.length})…`;
        this.renderPine();
        if (!spec(sym)) registerBinanceSymbol(sym);
        const sp = spec(sym), row = { symbol: sym, values: [], alerts: [], signals: [] };
        try {
          // saved candles only for Twelve Data symbols (no API credits); Binance and Dukascopy are free
          const { bars } = await fetchBars(sym, tf, { limit: 500, cachedOnly: sp.provider === 'twelvedata' });
          if (bars.length < 30) { row.note = sp.provider === 'twelvedata' ? `no saved ${tfLabel(tf)} candles — open its ${tfLabel(tf)} chart once` : 'not enough data'; this.pineRows.push(row); continue; }
          const res = await runScript(sc.code, bars, params, { tf: tfSec(tf), symbol: sym, mintick: 10 ** -precisionOf(sym), session: sp.session || 'fx' });
          if (res.error) { row.note = res.error.slice(0, 80); this.pineRows.push(row); continue; }
          const n = bars.length - 1;
          row.close = bars[n].close;
          row.values = res.plots.slice(0, 6).map(p => { for (let j = n; j >= Math.max(0, n - 3); j--) if (p.values[j] != null) return p.values[j]; return null; });
          row.alerts = [...new Set((res.alerts || []).filter(a => a.i >= n - 1).map(a => a.title))];
          row.signals = [...new Set((res.shapes || []).filter(m => m.i >= n - 1).map(m => m.text || m.shape))];
          if (res.strategy) row.pos = res.strategy.open.reduce((a, t) => a + (t.side === 'buy' ? 1 : -1) * t.lots, 0);
        } catch (e) { row.note = e.message.slice(0, 80); }
        this.pineRows.push(row);
      }
      this.pineStatus = `${sc.name} on ${syms.length} symbols · ${tfLabel(tf)} · ${new Date().toLocaleTimeString()} · alerts and signals on the last two bars`;
    } finally { this.pineRunning = false; this.renderPine(); }
  }
  renderPine() {
    const st = this.st;
    const scripts = listScripts().filter(x => x.meta);
    if (!st.pineScript || !getScript(st.pineScript)?.meta) st.pineScript = scripts[0]?.id || null;
    const scriptSel = h('select', { onchange: e => { st.pineScript = e.target.value; this.save(); } }, scripts.map(x => h('option', { value: x.id }, x.name)));
    scriptSel.value = st.pineScript || '';
    const tfSel = h('select', { onchange: e => { st.pineTf = e.target.value; this.save(); } }, TIMEFRAMES.map(([k, l]) => h('option', { value: k }, l)));
    tfSel.value = st.pineTf || '1h';
    const lists = Object.keys(this.app.watchlist?.data?.lists || {});
    const listSel = h('select', { onchange: e => { st.pineList = e.target.value; this.save(); } },
      lists.map(n => h('option', { value: `wl:${n}` }, `Watchlist “${n}”`)), h('option', { value: 'top:30' }, 'Top 30 Binance pairs'), h('option', { value: 'top:60' }, 'Top 60 Binance pairs'));
    listSel.value = st.pineList || `wl:${this.app.watchlist?.data?.active || lists[0]}`;
    const cols = this.pineCols || [];
    const rows = this.pineRows || [];
    fill(this.host, h('div', { class: 'screener' },
      h('div', { class: 'sc-bar' }, this.marketSelect(), scriptSel, tfSel, listSel,
        h('button', { class: 'btn small primary', disabled: this.pineRunning || !scripts.length, onclick: () => this.runPine() }, icon('play'), this.pineRunning ? 'Running…' : 'Run'),
        h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, this.pineStatus || (scripts.length ? 'Runs the script on every symbol and lists its latest values, alerts and signals' : 'Save a script in the Scripts tab first'))),
      h('div', { class: 'tp-table' }, h('table', { class: 'sc-table' },
        h('thead', null, h('tr', null, h('th', null, 'Symbol'), h('th', null, 'Close'), cols.map(c => h('th', null, c)), h('th', null, 'Alerts (last bars)'), h('th', null, 'Signals'), rows.some(r => r.pos != null) ? h('th', null, 'Position') : null)),
        h('tbody', null, rows.length ? rows.map(r => this.pineRow(r, cols, rows.some(x => x.pos != null)))
          : h('tr', null, h('td', { colspan: 8, class: 'muted' }, 'Pick a script, a timeframe and a list, then Run.'))))),
      h('p', { class: 'muted small sc-note' }, 'Twelve Data symbols use saved candles only (no API credits). Scripts run isolated, one symbol at a time.')));
  }
  pineRow(r, cols, showPos) {
    const val = v => (v == null ? '—' : Math.abs(v) >= 1000 ? v.toFixed(2) : +v.toPrecision(5));
    const pos = r.pos == null ? '' : r.pos > 0 ? `Long ${+r.pos.toFixed(4)}` : r.pos < 0 ? `Short ${+(-r.pos).toFixed(4)}` : 'Flat';
    const cells = r.note ? [h('td', { colspan: cols.length + 2, class: 'muted' }, r.note)]
      : [...cols.map((c, k) => h('td', null, val(r.values[k]))), h('td', { class: r.alerts.length ? 'up' : 'muted' }, r.alerts.join(', ') || '—'), h('td', null, r.signals.join(', ') || '—')];
    return h('tr', { class: 'clickable' + (r.alerts.length || r.signals.length ? ' sc-hit' : ''), onclick: () => this.open(r.symbol) },
      h('td', null, h('b', null, r.symbol)), h('td', null, r.close != null ? fmtPrice(r.close, precisionOf(r.symbol)) : '—'), cells,
      showPos ? h('td', { class: r.pos > 0 ? 'up' : r.pos < 0 ? 'down' : 'muted' }, pos) : null);
  }

  renderTable(rows = this.view()) {
    if (!this.tbody) return;
    const COLS_K = COLS.map(c => c[0]);
    fill(this.tbody, rows.slice(0, 400).map(r => h('tr', { class: 'clickable' + (r.symbol === this.app.activeView?.symbol ? ' sel' : ''), onclick: () => this.open(r.symbol, r.name), title: r.name || '' },
      COLS_K.map(k => this.cellFor(r, k)))));
    const c = document.getElementById('scCount');
    if (c) c.textContent = `${rows.length} of ${(this.st.market === 'crypto' ? this.rows.crypto : this.rows.catalog).length}${this.loadedAt ? ` · updated ${new Date(this.loadedAt).toLocaleTimeString()}` : ''}`;
  }
  cellFor(r, k) {
    const v = r[k], p = r.src === 'binance' ? (v < 1 ? 6 : v < 100 ? 4 : 2) : precisionOf(r.symbol);
    switch (k) {
      case 'symbol': return h('td', null, h('b', null, r.symbol), r.noData ? h('small', { class: 'muted', title: 'No saved daily candles — open its 1D chart once' }, ' no data') : null);
      case 'price': return h('td', null, v == null ? '—' : fmtPrice(v, p));
      case 'volume': return h('td', null, v == null ? '—' : fmtVol(v));
      case 'range': return h('td', null, v == null ? '—' : h('span', { class: 'sc-range', title: `${v.toFixed(0)}% of the day's range` }, h('i', { style: { left: `${clamp(v, 0, 100)}%` } })));
      case 'rsi': return h('td', { class: v < 30 ? 'up' : v > 70 ? 'down' : '' }, v == null ? '—' : v.toFixed(1));
      case 'atrPct': return h('td', null, v == null ? '—' : `${v.toFixed(2)}%`);
      case 'rating': return h('td', { class: v > 0.1 ? 'up' : v < -0.1 ? 'down' : 'muted' }, ratingLabel(v));
      default: return h('td', { class: v > 0 ? 'up' : v < 0 ? 'down' : '' }, fmtPct(v));
    }
  }
  openFilters(anchor) {
    const pop = document.getElementById('popover');
    pop.className = 'popover sc-filters';
    const f = this.st.f;
    const num = key => {
      const i = h('input', { type: 'number', step: 'any', value: f[key] ?? '', placeholder: key.endsWith('Min') ? 'min' : 'max' });
      i.addEventListener('change', () => { f[key] = i.value === '' ? '' : Number(i.value); this.save(); this.render(); });
      return i;
    };
    const chk = (key, label) => { const c = h('input', { type: 'checkbox' }); c.checked = !!f[key]; c.addEventListener('change', () => { f[key] = c.checked; this.save(); this.render(); }); return h('label', { class: 'cs-check' }, c, h('span', null, label)); };
    fill(pop, h('h4', null, 'Filters'),
      h('div', { class: 'sc-fgrid' }, FILTERS.map(([k, l]) => [h('span', null, l), num(`${k}Min`), num(`${k}Max`)])),
      chk('above50', 'Price above SMA 50'), chk('above200', 'Price above SMA 200'),
      h('button', { class: 'btn small', onclick: () => { this.st.f = {}; this.save(); this.render(); pop.hidden = true; } }, 'Clear filters'));
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, window.innerWidth - 300)}px`;
    pop.style.top = `${clamp(r.top - 330, 8, window.innerHeight - 340)}px`;
    pop.hidden = false;
  }
}
