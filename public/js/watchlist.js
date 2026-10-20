// Watchlists (several named lists) with live Binance prices and the latest cached session for other sources.
// Rows can carry a colour flag, lists can have section headers ("### Metals"), columns are configurable and
// any column sorts the list. During replay every price is masked, because real-time quotes would reveal the future.

import { h, icon, kv, toast, coin, fill, fmtPrice, fmtSigned, fmtPct, fmtVol, fmtDate, confirmBox, clamp } from './util.js';
import { spec, fetchBars, binanceTickers, precisionOf, providerLabel, registerBinanceSymbol, binancePairs } from './data.js';

const DEFAULT = { active: 'Main', lists: { Main: ['XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'US500', 'NAS100', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'] } };
export const FLAGS = { red: '#f23645', orange: '#ff9800', yellow: '#fdd835', green: '#089981', blue: '#2962ff', purple: '#9c27b0' };
const COLUMNS = {
  last: { label: 'Last', w: '78px' }, chg: { label: 'Chg', w: '58px' }, pct: { label: 'Chg%', w: '56px' },
  vol: { label: 'Vol', w: '58px' }, high: { label: 'High', w: '74px' }, low: { label: 'Low', w: '74px' }, range: { label: 'Range', w: '50px' },
};
const isSection = s => typeof s === 'string' && s.startsWith('###');

export class Watchlist {
  constructor(app, host, detailsHost) {
    this.app = app;
    this.host = host;
    this.detailsHost = detailsHost;
    this.quotes = {};
  }

  async init() {
    this.data = (await kv.get('watchlists')) || structuredClone(DEFAULT);
    if (!this.data.lists[this.data.active]) this.data.active = Object.keys(this.data.lists)[0];
    this.data.flags ||= {};
    this.data.cols ||= ['last', 'chg', 'pct'];
    this.render();
    await this.refreshHistorical();
    this.pollBinance();
    this.timer = setInterval(() => this.pollBinance(), 5000);
  }
  /** Symbols of the active list (section headers left out). */
  get list() { return (this.data?.lists[this.data.active] || []).filter(s => !isSection(s)); }
  get raw() { return this.data?.lists[this.data.active] || []; }
  save() { kv.set('watchlists', this.data); }

  /** Rows in display order: manual order with sections, or sorted by a column (sections hidden). */
  ordered() {
    const sort = this.data.sort?.[this.data.active];
    const flag = this.data.flagFilter;
    let items = flag ? this.list.filter(s => this.data.flags[s] === flag) : this.raw;
    if (!sort || flag) items = items.slice();
    if (sort) {
      const val = s => {
        const q = this.quotes[s];
        if (sort.key === 'symbol') return s;
        if (sort.key === 'flag') return Object.keys(FLAGS).indexOf(this.data.flags[s] ?? 'zz');
        if (!q || q.none) return null;
        const chg = q.last - q.open;
        return { last: q.last, chg, pct: q.open ? chg / q.open * 100 : null, vol: q.volume, high: q.high, low: q.low, range: q.high > q.low ? (q.last - q.low) / (q.high - q.low) * 100 : null }[sort.key];
      };
      items = items.filter(s => !isSection(s)).sort((a, b) => {
        const x = val(a), y = val(b);
        if (typeof x === 'string') return x.localeCompare(y) * sort.dir;
        return ((x ?? -Infinity) - (y ?? -Infinity)) * sort.dir;
      });
    }
    return items;
  }

  gridCols() { return `minmax(96px, 1fr) ${this.data.cols.map(c => COLUMNS[c]?.w || '60px').join(' ')}`; }

  render() {
    const listSel = h('select', { class: 'wl-select', onchange: () => { this.data.active = listSel.value; this.save(); this.render(); this.refreshHistorical(); } },
      Object.keys(this.data.lists).map(n => h('option', { value: n, selected: n === this.data.active }, n)));
    const menu = h('div', { class: 'wl-menu' },
      h('button', { class: 'tb-btn icon-only', title: 'Add symbol', onclick: () => this.app.openSymbolSearch('add') }, icon('plus')),
      h('button', { class: 'tb-btn icon-only', title: 'List menu: new, rename, sections, columns, import / export', onclick: e => this.openMenu(e.currentTarget) }, icon('list')),
      h('button', { class: 'tb-btn icon-only wl-close', title: 'Close watchlist (Alt+W)', onclick: () => this.app.toggleWatchlist(false) }, icon('close')));
    const sort = this.data.sort?.[this.data.active];
    const colHead = (key, label) => h('span', { class: 'wl-colh' + (sort?.key === key ? ' sorted' : ''), title: 'Sort (click again to reverse, a third time for your own order)', onclick: () => this.cycleSort(key) },
      label, sort?.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    const flagBar = h('div', { class: 'wl-flags' },
      h('button', { class: 'wl-flagbtn' + (!this.data.flagFilter ? ' active' : ''), title: 'Show every symbol', onclick: () => { this.data.flagFilter = null; this.save(); this.render(); } }, 'All'),
      ...Object.entries(FLAGS).map(([k, c]) => h('button', { class: 'wl-flagbtn' + (this.data.flagFilter === k ? ' active' : ''), title: `Only ${k}-flagged symbols`, onclick: () => { this.data.flagFilter = this.data.flagFilter === k ? null : k; this.save(); this.render(); } },
        h('i', { class: 'wl-flag', style: { background: c } }))));
    this.rows = h('div', { class: 'wl-list' }, this.ordered().map(s => (isSection(s) ? this.sectionRow(s) : this.row(s))));
    const cols = h('div', { class: 'wl-cols', style: { gridTemplateColumns: this.gridCols() } }, colHead('symbol', 'Symbol'), this.data.cols.map(c => colHead(c, COLUMNS[c].label)));
    this.host.replaceChildren(h('div', { class: 'wl-head' }, listSel, menu), flagBar, cols, this.rows);
    this.paint();
  }
  cycleSort(key) {
    const cur = this.data.sort?.[this.data.active];
    const next = !cur || cur.key !== key ? { key, dir: key === 'symbol' ? 1 : -1 } : cur.dir === (key === 'symbol' ? 1 : -1) ? { key, dir: -cur.dir } : null;
    this.data.sort = { ...this.data.sort, [this.data.active]: next };
    this.save(); this.render();
  }

  sectionRow(s) {
    const name = s.slice(3).trim();
    return h('div', { class: 'wl-section', draggable: 'true', 'data-s': s,
      ondragstart: e => e.dataTransfer.setData('text/plain', s), ondragover: e => e.preventDefault(),
      ondrop: e => { e.preventDefault(); this.move(e.dataTransfer.getData('text/plain'), s); },
      oncontextmenu: e => { e.preventDefault(); this.openRowMenu(s, e.clientX, e.clientY); } },
    h('span', null, name || 'Section'),
    h('button', { class: 'wl-del', title: 'Remove section', onclick: e => { e.stopPropagation(); this.removeItem(s); } }, icon('close')));
  }
  row(s) {
    const sp = spec(s), flag = this.data.flags[s];
    return h('div', { class: 'wl-row' + (s === this.app.activeView?.symbol ? ' active' : ''), 'data-s': s, draggable: 'true', style: { gridTemplateColumns: this.gridCols() },
      onclick: () => this.app.activeView.setSymbol(s),
      oncontextmenu: e => { e.preventDefault(); this.openRowMenu(s, e.clientX, e.clientY); },
      ondragstart: e => e.dataTransfer.setData('text/plain', s),
      ondragover: e => e.preventDefault(),
      ondrop: e => { e.preventDefault(); this.move(e.dataTransfer.getData('text/plain'), s); } },
    h('span', { class: 'wl-sym', title: sp ? `${sp.name} · ${sp.provider === 'binance' ? 'Binance (live)' : `${providerLabel(sp.provider)} (historical)`}` : s },
      h('i', { class: 'wl-flag' + (flag ? '' : ' none'), style: flag ? { background: FLAGS[flag] } : {}, title: flag ? `${flag} flag — click to change` : 'Flag', onclick: e => { e.stopPropagation(); this.cycleFlag(s); } }),
      coin(s), s, sp && sp.provider !== 'binance' ? h('i', { class: 'src', title: providerLabel(sp.provider) }, sp.provider === 'twelvedata' ? 'TD' : sp.provider === 'tradingview' ? 'TV' : 'H') : null),
    this.data.cols.map(c => h('span', { class: `wl-c wl-${c}` }, '—')),
    h('button', { class: 'wl-del', title: 'Remove', onclick: e => { e.stopPropagation(); this.remove(s); } }, icon('close')));
  }
  cycleFlag(s) {
    const keys = Object.keys(FLAGS), cur = this.data.flags[s];
    const next = cur ? keys[keys.indexOf(cur) + 1] : keys[0];
    if (next) this.data.flags[s] = next; else delete this.data.flags[s];
    this.save(); this.render();
  }
  openRowMenu(s, x, y) {
    let menu = document.getElementById('wlMenu');
    if (!menu) { menu = h('div', { id: 'wlMenu', class: 'menu', hidden: true }); document.body.append(menu); }
    const close = () => { menu.hidden = true; };
    const section = isSection(s);
    fill(menu, h('div', { class: 'menu-title' }, section ? 'Section' : s),
      section ? null : h('div', { class: 'wl-flagrow' }, Object.entries(FLAGS).map(([k, c]) => h('button', { title: `${k} flag`, onclick: () => { this.data.flags[s] = k; this.save(); this.render(); close(); } }, h('i', { class: 'wl-flag', style: { background: c } }))),
        h('button', { title: 'No flag', onclick: () => { delete this.data.flags[s]; this.save(); this.render(); close(); } }, '✕')),
      section ? h('button', { onclick: () => { close(); this.app.prompt('Section name', s.slice(3).trim(), n => { if (n == null) return; const l = this.raw, i = l.indexOf(s); if (i >= 0) l[i] = `###${n}`; this.save(); this.render(); }); } }, icon('edit'), 'Rename section')
        : h('button', { onclick: () => { close(); this.app.activeView.setSymbol(s); } }, icon('candles'), 'Open chart'),
      section ? null : h('button', { onclick: () => { close(); this.app.alerts.openDialog({ symbol: s }); } }, icon('bell'), 'Add alert…'),
      h('button', { onclick: () => { close(); this.addSection(s); } }, icon('list'), 'Add section above'),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { close(); section ? this.removeItem(s) : this.remove(s); } }, icon('trash'), section ? 'Remove section' : `Remove ${s}`));
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${clamp(x, 4, window.innerWidth - r.width - 4)}px`;
    menu.style.top = `${clamp(y, 4, window.innerHeight - r.height - 4)}px`;
    setTimeout(() => document.addEventListener('mousedown', ev => { if (!menu.contains(ev.target)) close(); }, { once: true }), 0);
  }
  addSection(before = null) {
    this.app.prompt('Section name', '', n => {
      if (!n) return;
      const l = this.raw, i = before ? l.indexOf(before) : l.length;
      l.splice(i < 0 ? l.length : i, 0, `###${n}`);
      this.save(); this.render();
    });
  }
  openMenu(anchor) {
    let menu = document.getElementById('wlMenu');
    if (!menu) { menu = h('div', { id: 'wlMenu', class: 'menu', hidden: true }); document.body.append(menu); }
    const close = () => { menu.hidden = true; };
    const colToggle = c => h('button', { class: this.data.cols.includes(c) ? 'active' : '', onclick: e => {
      e.stopPropagation();
      this.data.cols = this.data.cols.includes(c) ? this.data.cols.filter(x => x !== c) : Object.keys(COLUMNS).filter(k => k === c || this.data.cols.includes(k));
      this.save(); this.render(); this.openMenu(anchor);
    } }, icon(this.data.cols.includes(c) ? 'check' : 'plus'), COLUMNS[c].label);
    fill(menu,
      h('div', { class: 'menu-title' }, `List “${this.data.active}”`),
      h('button', { onclick: () => { close(); this.newList(); } }, icon('folder'), 'New list…'),
      h('button', { onclick: () => { close(); this.renameList(); } }, icon('edit'), 'Rename list…'),
      h('button', { onclick: () => { close(); this.addSection(); } }, icon('list'), 'Add section…'),
      h('button', { onclick: () => { close(); this.importList(); } }, icon('upload'), 'Import symbols…'),
      h('button', { onclick: () => { close(); this.exportList(); } }, icon('download'), 'Export list'),
      h('button', { onclick: () => { close(); this.deleteList(); } }, icon('trash'), 'Delete list'),
      h('div', { class: 'menu-title' }, 'Columns'), ...Object.keys(COLUMNS).map(colToggle));
    menu.hidden = false;
    const r = anchor.getBoundingClientRect(), mr = menu.getBoundingClientRect();
    menu.style.left = `${clamp(r.right - mr.width, 4, window.innerWidth - mr.width - 4)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    setTimeout(() => document.addEventListener('mousedown', ev => { if (!menu.contains(ev.target)) close(); }, { once: true }), 0);
  }
  exportList() {
    const text = this.raw.map(s => (isSection(s) ? s : s)).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `watchlist_${this.data.active}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${this.list.length} symbols`);
  }
  importList() {
    this.app.prompt('Paste symbols (comma, space or one per line; "###Name" starts a section)', '', async text => {
      if (!text) return;
      const tokens = text.split(/[\n,;]+|\s{2,}|\t/).map(t => t.trim()).filter(Boolean).flatMap(t => (t.startsWith('###') ? [t] : t.split(/\s+/)));
      let pairs = [];
      try { pairs = await binancePairs(); } catch { /* offline */ }
      let added = 0;
      const unknown = [];
      for (const t of tokens) {
        if (isSection(t)) { this.raw.push(t); continue; }
        const s = t.toUpperCase().replace(/^.*:/, '').replace(/[^A-Z0-9]/g, ''); // "BINANCE:BTCUSDT" → BTCUSDT, "XAU/USD" → XAUUSD
        if (!spec(s) && pairs.includes(s)) registerBinanceSymbol(s);
        if (!spec(s)) { unknown.push(t); continue; }
        if (!this.raw.includes(s)) { this.raw.push(s); added++; }
      }
      this.save(); this.render(); this.refreshHistorical(); this.pollBinance();
      toast(`Added ${added} symbol${added === 1 ? '' : 's'}${unknown.length ? ` · not found: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? '…' : ''}` : ''}`, unknown.length ? 'error' : '');
    }, true);
  }

  move(from, to) {
    const l = this.raw, i = l.indexOf(from), j = l.indexOf(to);
    if (i < 0 || j < 0 || i === j) return;
    if (this.data.sort?.[this.data.active]) { this.data.sort[this.data.active] = null; toast('Sorting off — your own order'); }
    l.splice(j, 0, l.splice(i, 1)[0]);
    this.save(); this.render();
  }
  add(s) {
    if (!spec(s)) { toast(`Unknown symbol ${s}`, 'error'); return; }
    if (this.list.includes(s)) { toast(`${s} is already in “${this.data.active}”`); return; }
    this.raw.push(s);
    this.save(); this.render(); this.refreshHistorical(); this.pollBinance();
    toast(`${s} added to “${this.data.active}”`);
  }
  remove(s) { this.removeItem(s); }
  removeItem(s) {
    this.data.lists[this.data.active] = this.raw.filter(x => x !== s);
    this.save(); this.render();
  }
  newList() {
    this.app.prompt('New watchlist name', '', name => {
      if (!name) return;
      if (this.data.lists[name]) { toast('A list with that name exists', 'error'); return; }
      this.data.lists[name] = [];
      this.data.active = name;
      this.save(); this.render();
    });
  }
  renameList() {
    const old = this.data.active;
    this.app.prompt('Rename watchlist', old, name => {
      if (!name || name === old) return;
      if (this.data.lists[name]) { toast('A list with that name exists', 'error'); return; }
      this.data.lists[name] = this.data.lists[old];
      delete this.data.lists[old];
      this.data.active = name;
      this.save(); this.render();
    });
  }
  async deleteList() {
    if (Object.keys(this.data.lists).length <= 1) { toast('Keep at least one watchlist'); return; }
    if (!(await confirmBox(`Delete watchlist “${this.data.active}”?`, 'Delete'))) return;
    delete this.data.lists[this.data.active];
    this.data.active = Object.keys(this.data.lists)[0];
    this.save(); this.render();
  }

  // ---------------------------------------------------------------- prices
  async refreshHistorical() {
    const syms = [...new Set([...this.list, this.app.activeView?.symbol].filter(s => spec(s) && spec(s).provider !== 'binance'))];
    await Promise.all(syms.map(async s => {
      try {
        // Cache only: watchlist refreshes never spend Twelve Data credits or queue ahead of the chart.
        const { bars } = await fetchBars(s, '1d', { limit: 2, cachedOnly: true });
        if (!bars.length) {
          // No daily candles saved yet: use the latest saved hourly candles (change over the last 24 of them).
          const hr = (await fetchBars(s, '1h', { limit: 25, cachedOnly: true })).bars;
          if (!hr.length) { this.quotes[s] = { none: true }; return; }
          const last = hr[hr.length - 1], first = hr[0];
          this.quotes[s] = { last: last.close, open: first.open, high: Math.max(...hr.map(b => b.high)), low: Math.min(...hr.map(b => b.low)), volume: hr.reduce((a, b) => a + b.volume, 0), asOf: last.time, hist: true };
          return;
        }
        const last = bars[bars.length - 1], prev = bars[bars.length - 2];
        this.quotes[s] = { last: last.close, open: prev ? prev.close : last.open, high: last.high, low: last.low, volume: last.volume, asOf: last.time, hist: true };
      } catch { this.quotes[s] = { none: true }; }
    }));
    this.paint();
  }
  async pollBinance() {
    if (document.hidden) return;
    const extra = this.app.portfolio?.symbols?.() || [];
    const syms = [...new Set([...this.list, this.app.activeView?.symbol, ...extra].filter(s => spec(s)?.provider === 'binance'))];
    if (!syms.length) return;
    try {
      for (const t of await binanceTickers(syms)) {
        this.quotes[t.symbol] = { last: +t.lastPrice, open: +t.openPrice, high: +t.highPrice, low: +t.lowPrice, volume: +t.quoteVolume, count: t.count };
      }
      this.paint();
    } catch { /* offline — keep last values */ }
  }
  onLivePrice(symbol, price) {
    const q = this.quotes[symbol];
    if (!q || q.none) return;
    q.last = price;
    if (q.hist) { q.high = Math.max(q.high, price); q.low = Math.min(q.low, price); } // saved session + live ticks (Twelve Data stream)
    if (Date.now() - (this.paintedAt || 0) > 250) { this.paintedAt = Date.now(); this.paint(); }
  }

  paint() {
    const masked = this.app.replay?.active;
    for (const row of this.rows?.children || []) {
      if (!row.classList.contains('wl-row')) continue;
      const s = row.dataset.s, q = this.quotes[s];
      row.classList.toggle('active', s === this.app.activeView?.symbol);
      const cells = Object.fromEntries(this.data.cols.map(c => [c, row.querySelector(`.wl-${c}`)]));
      const set = (c, text, cls = '') => { const el = cells[c]; if (el) { el.textContent = text; el.className = `wl-c wl-${c} ${cls}`; } };
      if (masked) { for (const c of this.data.cols) set(c, c === 'last' ? '—' : '', 'muted'); row.title = 'Prices are hidden during Bar Replay'; continue; }
      row.title = q?.hist ? `Last cached session ${fmtDate(q.asOf)}` : '';
      if (!q || q.none) { for (const c of this.data.cols) set(c, c === 'last' ? (q?.none ? 'no data' : '—') : ''); continue; }
      const p = precisionOf(s), chg = q.last - q.open, pct = q.open ? chg / q.open * 100 : 0, cls = chg >= 0 ? 'up' : 'down';
      const lastEl = cells.last, txt = fmtPrice(q.last, p);
      if (lastEl && lastEl.textContent !== txt) {
        lastEl.textContent = txt;
        lastEl.className = 'wl-c wl-last';
        if (row.dataset.prev && !q.hist) { void lastEl.offsetWidth; lastEl.classList.add(q.last >= +row.dataset.prev ? 'flash-up' : 'flash-down'); }
        row.dataset.prev = q.last;
      }
      set('chg', fmtSigned(chg, p), cls); set('pct', fmtPct(pct), cls);
      set('vol', q.volume ? fmtVol(q.volume) : '—'); set('high', fmtPrice(q.high, p)); set('low', fmtPrice(q.low, p));
      set('range', q.high > q.low ? `${Math.round((q.last - q.low) / (q.high - q.low) * 100)}%` : '—');
    }
    this.renderDetails();
  }

  renderDetails() {
    const v = this.app.activeView;
    if (!v || !this.detailsHost) return;
    const s = v.symbol, sp = spec(s), q = this.quotes[s], p = precisionOf(s);
    if (!sp) return;
    const kids = [
      h('div', { class: 'd-sym' }, coin(s), s, h('span', { class: 'badge' }, providerLabel(sp.provider))),
      h('div', { class: 'd-name' }, `${sp.name} · ${sp.market}`),
    ];
    if (this.app.replay?.active) {
      kids.push(h('div', { class: 'd-note' }, 'Live and latest prices are hidden while Bar Replay is running.'));
    } else if (q && !q.none) {
      const chg = q.last - q.open, pct = q.open ? chg / q.open * 100 : 0, cls = chg >= 0 ? 'up' : 'down';
      const pos = q.high > q.low ? clamp((q.last - q.low) / (q.high - q.low) * 100, 0, 100) : 50;
      kids.push(
        h('div', { class: 'd-price' }, fmtPrice(q.last, p), h('small', null, sp.quote)),
        h('div', { class: 'd-chg ' + cls }, `${fmtSigned(chg, p)}  ${fmtPct(pct)}`),
        q.hist ? h('div', { class: 'd-name' }, `Last saved candle: ${fmtDate(q.asOf)} (vs previous close / 24h)`) : h('div', { class: 'd-name' }, '24h change · live'),
        h('div', { class: 'd-range' },
          h('div', { class: 'd-range-lbl' }, h('span', null, q.hist ? 'Session range' : 'Day’s range')),
          h('div', { class: 'd-range-bar' }, h('i', { style: { left: `calc(${pos}% - 1px)` } })),
          h('div', { class: 'd-range-lbl' }, h('span', null, fmtPrice(q.low, p)), h('span', null, fmtPrice(q.high, p)))),
        h('div', { class: 'd-stats' },
          h('div', null, h('span', null, q.hist ? 'Tick volume' : `Volume (${sp.quote})`), h('b', null, fmtVol(q.volume))),
          h('div', null, h('span', null, 'Contract'), h('b', null, sp.lotName))));
    } else if (sp.provider === 'dukascopy') {
      kids.push(h('div', { class: 'd-note' }, 'No data cached yet.'), h('button', { class: 'btn small primary', onclick: () => this.app.openDataManager(s) }, icon('database'), 'Get data'));
    } else if (sp.provider === 'twelvedata') {
      kids.push(h('div', { class: 'd-note' }, sp.tdConfigured ? 'Open the 1D chart once to cache daily candles for this summary.' : 'Twelve Data API key not configured.'),
        h('button', { class: 'btn small', onclick: () => this.app.openDataManager(s) }, icon('database'), 'Twelve Data settings'));
    }
    if (sp.provider === 'twelvedata' && sp.tdCoverage?.rows) kids.push(h('div', { class: 'd-name' }, `Twelve Data cached: ${fmtDate(sp.tdCoverage.first)} → ${fmtDate(sp.tdCoverage.last)} (${sp.tdCoverage.rows.toLocaleString()} candles)`));
    if (sp.provider === 'dukascopy' && sp.coverage?.months) kids.push(h('div', { class: 'd-name' }, `Cached: ${fmtDate(sp.coverage.first)} → ${fmtDate(sp.coverage.last)} (${sp.coverage.months} months of 1-minute data)`));
    this.detailsHost.replaceChildren(...kids);
  }
}
