// Economic calendar panel (this week's events, filtered by impact and currency) and the chart's event markers.

import { h, icon, api, kv, toast, fill, fmtDuration } from './util.js';
import { spec } from './data.js';
import { fmtChartTime } from './chartstyle.js';

const IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
export const IMPACT_COLOR = { High: '#f23645', Medium: '#ff9800', Low: '#f5c518', Holiday: '#787b86' };
const INDEX_CCY = { US500: 'USD', NAS100: 'USD', US30: 'USD', US2000: 'USD', GER40: 'EUR', EU50: 'EUR', FRA40: 'EUR', UK100: 'GBP', JPN225: 'JPY', AUS200: 'AUD', HK50: 'CNY' };

/** Currencies whose news moves a symbol: both sides of a pair, USD for gold / crypto / US indices. */
export function currenciesOf(symbol) {
  const s = spec(symbol);
  if (!s) return ['USD'];
  if (INDEX_CCY[symbol]) return [INDEX_CCY[symbol]];
  if (s.type === 'crypto') return ['USD'];
  const c = [s.base, s.quote].filter(x => /^[A-Z]{3}$/.test(x || '') && !['XAU', 'XAG', 'XPT', 'XPD'].includes(x));
  return c.length ? [...new Set(c)] : ['USD'];
}

export class EconCalendar {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.st = { impacts: ['High', 'Medium'], ccy: 'chart', ...(kv.peek('calendarView') || {}) };
    this.data = null;
  }
  async init() {
    Object.assign(this.st, (await kv.get('calendarView')) || {});
    await this.load();
    setInterval(() => this.load(), 60 * 60e3);
    setInterval(() => { if (!this.host.hidden) this.renderTable(); }, 30e3); // countdowns
  }
  save() { kv.set('calendarView', this.st); }
  async load(force = false) {
    try { this.data = await api(`/api/calendar${force ? '?force=1' : ''}`); this.error = null; }
    catch (e) { this.error = e.message; }
    for (const v of this.app.views || []) v.lastOverlaySig = null;
    this.render();
  }
  /** Events shown on a chart of `symbol` (its currencies; high impact, plus medium when chosen). */
  chartEvents(symbol, withMedium) {
    const cur = new Set([...currenciesOf(symbol), 'All']);
    return (this.data?.events || []).filter(e => cur.has(e.country) && (e.impact === 'High' || (withMedium && e.impact === 'Medium')));
  }
  filtered() {
    const cur = this.st.ccy === 'chart' ? new Set([...currenciesOf(this.app.activeView?.symbol), 'All']) : this.st.ccy === 'all' ? null : new Set([this.st.ccy, 'All']);
    return (this.data?.events || []).filter(e => this.st.impacts.includes(e.impact) && (!cur || cur.has(e.country)));
  }

  render() {
    if (!this.host || this.host.hidden) return;
    const ccys = [...new Set((this.data?.events || []).map(e => e.country))].filter(c => c !== 'All').sort();
    const ccySel = h('select', { onchange: e => { this.st.ccy = e.target.value; this.save(); this.render(); } },
      h('option', { value: 'chart' }, `Chart currencies (${currenciesOf(this.app.activeView?.symbol).join(', ')})`), h('option', { value: 'all' }, 'All currencies'), ccys.map(c => h('option', { value: c }, c)));
    ccySel.value = this.st.ccy;
    const impactChips = IMPACTS.map(imp => h('button', { class: 'chip' + (this.st.impacts.includes(imp) ? ' active' : ''), onclick: () => {
      this.st.impacts = this.st.impacts.includes(imp) ? this.st.impacts.filter(x => x !== imp) : [...this.st.impacts, imp];
      this.save(); this.render();
    } }, h('i', { class: 'cal-dot', style: { background: IMPACT_COLOR[imp] } }), imp));
    this.tbody = h('tbody');
    fill(this.host, h('div', { class: 'calendar' },
      h('div', { class: 'sc-bar' }, ccySel, ...impactChips,
        h('button', { class: 'btn small', onclick: () => this.load(true) }, icon('replay'), 'Refresh'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, this.error ? `⚠ ${this.error}` : this.data ? `${this.data.source}${this.data.stale ? ' (offline copy)' : ''} · times in the chart's timezone` : 'Loading…')),
      h('div', { class: 'tp-table' }, h('table', { class: 'cal-table' },
        h('thead', null, h('tr', null, ['Time', '', 'Cur.', 'Impact', 'Event', 'Actual', 'Forecast', 'Previous'].map(x => h('th', null, x)))), this.tbody))));
    this.renderTable();
  }
  renderTable() {
    if (!this.tbody) return;
    const now = Date.now() / 1000, rows = [];
    let day = null;
    const list = this.filtered();
    const next = list.find(e => e.time > now);
    for (const e of list) {
      const d = fmtChartTime(e.time, 'day') + ' ' + fmtChartTime(e.time, 'month');
      if (d !== day) { day = d; rows.push(h('tr', { class: 'cal-day' }, h('td', { colspan: 8 }, fmtChartTime(e.time, 'weekday')))); }
      const past = e.time <= now;
      rows.push(h('tr', { class: (past ? 'past' : '') + (e === next ? ' next' : '') },
        h('td', null, fmtChartTime(e.time, 'time')),
        h('td', { class: 'muted small' }, e === next ? `in ${fmtDuration(e.time - now)}` : ''),
        h('td', null, h('b', null, e.country)),
        h('td', null, h('i', { class: 'cal-dot', style: { background: IMPACT_COLOR[e.impact] || '#787b86' } }), ` ${e.impact}`),
        h('td', null, e.title), h('td', null, e.actual || ''), h('td', null, e.forecast || ''), h('td', { class: 'muted' }, e.previous || '')));
    }
    fill(this.tbody, rows.length ? rows : h('tr', null, h('td', { colspan: 8, class: 'muted' }, this.data ? 'No events match the filters this week.' : 'Loading the calendar…')));
  }
}
