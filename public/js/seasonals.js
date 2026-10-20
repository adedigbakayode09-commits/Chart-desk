// Seasonals: how the active symbol performed in each calendar month, year by year, with the average, median and
// share of positive years per month — from daily candles (close to close).

import { h, icon, fill, fmtPct } from './util.js';
import { spec, fetchBars } from './data.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monthly and yearly close-to-close returns: { years: [{ year, months: [12], total }], avg, median, positive, count }. */
export function monthlyReturns(bars) {
  const last = new Map(); // "YYYY-M" → last close of that month
  for (const b of bars) { const d = new Date(b.time * 1000); last.set(`${d.getUTCFullYear()}-${d.getUTCMonth()}`, b.close); }
  const keys = [...last.keys()].map(k => k.split('-').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const byYear = new Map();
  for (let i = 1; i < keys.length; i++) {
    const [y, m] = keys[i], [py, pm] = keys[i - 1];
    if ((y * 12 + m) - (py * 12 + pm) !== 1) continue; // a gap in the data: no return for this month
    const r = (last.get(`${y}-${m}`) / last.get(`${py}-${pm}`) - 1) * 100;
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(null));
    byYear.get(y)[m] = r;
  }
  const years = [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, months]) => ({
    year, months, total: months.some(v => v != null) ? (months.reduce((acc, v) => acc * (1 + (v ?? 0) / 100), 1) - 1) * 100 : null,
  }));
  const col = m => years.map(y => y.months[m]).filter(v => v != null);
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  return {
    years,
    avg: MONTHS.map((_, m) => { const a = col(m); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }),
    median: MONTHS.map((_, m) => median(col(m))),
    positive: MONTHS.map((_, m) => { const a = col(m); return a.length ? a.filter(v => v > 0).length / a.length * 100 : null; }),
    count: MONTHS.map((_, m) => col(m).length),
  };
}

export class Seasonals {
  constructor(app, host) { this.app = app; this.host = host; this.cache = new Map(); }

  async load(symbol) {
    if (this.cache.has(symbol)) return this.cache.get(symbol);
    const s = spec(symbol);
    let { bars, hasMoreBefore } = await fetchBars(symbol, '1d', { limit: 5000 });
    // Binance pages hold 1,000 days: go back up to ~10 years
    for (let n = 0; s?.provider === 'binance' && hasMoreBefore && n < 3 && bars.length; n++) {
      const more = await fetchBars(symbol, '1d', { before: bars[0].time, limit: 1000 });
      bars = more.bars.filter(b => b.time < bars[0].time).concat(bars);
      hasMoreBefore = more.hasMoreBefore;
    }
    const res = { bars, stats: monthlyReturns(bars), at: Date.now() };
    this.cache.set(symbol, res);
    return res;
  }

  async render(force = false) {
    if (!this.host || this.host.hidden) return;
    const symbol = this.app.activeView?.symbol;
    if (!symbol) return;
    if (force) this.cache.delete(symbol);
    if (!this.cache.has(symbol)) fill(this.host, h('div', { class: 'panel-empty small' }, h('p', null, `Loading daily history for ${symbol}…`)));
    let res;
    try { res = await this.load(symbol); } catch (e) { fill(this.host, h('div', { class: 'panel-empty small' }, h('h3', null, 'Seasonals'), h('p', null, `Couldn't load daily candles for ${symbol}: ${e.message}`))); return; }
    if (symbol !== this.app.activeView?.symbol) return;
    const { stats, bars } = res;
    const cell = v => {
      if (v == null) return h('td', { class: 'muted' }, '');
      const a = Math.min(0.55, Math.abs(v) / 12 + 0.08);
      return h('td', { class: 'ss-cell', style: { background: v >= 0 ? `rgba(8,153,129,${a})` : `rgba(242,54,69,${a})` } }, fmtPct(v, 1));
    };
    const nowM = new Date().getUTCMonth();
    fill(this.host, h('div', { class: 'seasonals' },
      h('div', { class: 'sc-bar' }, h('b', null, `${symbol} seasonality`),
        h('span', { class: 'muted small' }, bars.length ? `${stats.years.length} years of daily candles (${new Date(bars[0].time * 1000).getUTCFullYear()}–${new Date(bars[bars.length - 1].time * 1000).getUTCFullYear()}) · monthly close-to-close returns` : 'No daily candles'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => this.render(true) }, icon('replay'), 'Reload')),
      h('div', { class: 'tp-table' }, h('table', { class: 'ss-table' },
        h('thead', null, h('tr', null, h('th', null, 'Year'), MONTHS.map((m, i) => h('th', { class: i === nowM ? 'now' : '' }, m)), h('th', null, 'Year'))),
        h('tbody', null,
          h('tr', { class: 'ss-sum' }, h('td', null, 'Average'), stats.avg.map(cell), h('td')),
          h('tr', { class: 'ss-sum' }, h('td', null, 'Median'), stats.median.map(cell), h('td')),
          h('tr', { class: 'ss-sum' }, h('td', null, '% up years'), stats.positive.map((v, m) => h('td', { class: v == null ? 'muted' : v >= 60 ? 'up' : v <= 40 ? 'down' : '', title: `${stats.count[m]} years` }, v == null ? '' : `${v.toFixed(0)}%`)), h('td')),
          stats.years.map(y => h('tr', null, h('td', null, h('b', null, y.year)), y.months.map(cell), cell(y.total)))))),
      h('p', { class: 'muted small sc-note' }, 'Past seasonality is a tendency, not a forecast. Uses the active chart\'s symbol and data source.')));
  }
}
