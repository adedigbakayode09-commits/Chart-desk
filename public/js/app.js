// ChartDesk application shell: layout of chart views, toolbars, panels, dialogs and keyboard shortcuts.

import { $, $$, h, icon, svg, kv, api, toast, clamp, coin, uid, ACCENT, openModal, closeModals, confirmBox, fmtDate, fmtPrice, fill, beep } from './util.js';
import { loadSymbols, SYMBOLS, spec, TIMEFRAMES, tfLabel, providerLabel, binancePairs, registerBinanceSymbol } from './data.js';
import { ChartView, CHART_TYPES } from './chartview.js';
import { IND_DEFS, IND_CATEGORIES, defOf } from './indicators-ui.js';
import { loadScripts, listScripts, LIBRARY, installLibraryScript, upgradeLibraryScripts } from './scripts.js';
import { ScriptEditor } from './scripts-ui.js';
import { TOOL_INFO, TOOL_GROUPS, ICON_CHOICES, toolTitle } from './drawings.js';
import { Replay } from './replay.js';
import { Trading } from './trading.js';
import { Tester } from './tester.js';
import { Journal } from './journal.js';
import { Watchlist } from './watchlist.js';
import { wireDropImport } from './dropimport.js';
import { DataManager } from './datamanager.js';
import { Assistant } from './assistant.js';
import { Alerts } from './alerts.js';
import { Screener } from './screener.js';
import { EconCalendar } from './calendar.js';
import { Seasonals } from './seasonals.js';
import { Portfolio } from './portfolio.js';
import { Paper } from './paper.js';
import { Commands, comboOf, parseInterval } from './commands.js';
import { Share } from './share.js';
import { Ideas } from './ideas.js';
import { DepthOfMarket } from './dom.js';
import { PRESETS, DEFAULT_STYLE, chartStyle, setChartStyle, candleColors } from './chartstyle.js';
import { PRICE_TYPES } from './core/charttypes.js';

const LAYOUTS = [['1', 'layout1', 'Single chart'], ['2v', 'layout2v', '2 charts side by side'], ['2h', 'layout2h', '2 charts stacked'], ['3', 'layout3', '3 charts'],
  ['3v', 'layout3v', '3 charts in columns'], ['3h', 'layout3h', '3 charts stacked'], ['4', 'layout4', '4 charts'], ['6', 'layout6', '6 charts'], ['8', 'layout8', '8 charts']];
const LAYOUT_COUNT = { 1: 1, '2v': 2, '2h': 2, 3: 3, '3v': 3, '3h': 3, 4: 4, 6: 6, 8: 8 };
const SYNC_OPTIONS = [['symbol', 'Symbol'], ['tf', 'Interval'], ['crosshair', 'Crosshair'], ['time', 'Date range']];
const FAVORITE_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const RANGES = [
  { l: '1D', span: 86400, tf: '5m' }, { l: '5D', span: 5 * 86400, tf: '15m' }, { l: '1M', span: 30 * 86400, tf: '1h' },
  { l: '3M', span: 91 * 86400, tf: '4h' }, { l: '6M', span: 182 * 86400, tf: '1d' }, { l: 'YTD', span: 'ytd', tf: '1d' },
  { l: '1Y', span: 365 * 86400, tf: '1d' }, { l: '5Y', span: 5 * 365 * 86400, tf: '1w' }, { l: 'All', span: 'all', tf: '1M' },
];

class App {
  constructor() {
    this.views = [];
    this.activeView = null;
    this.tool = 'cursor';
    this.hideDrawings = false;
    this.drawingsMap = new Map();
  }

  async boot() {
    try {
      await loadSymbols();
    } catch (e) {
      document.body.innerHTML = `<div class="fatal"><h2>ChartDesk server not reachable</h2><p>${e.message}</p><p>Start it with <code>npm start</code> in the ChartDesk folder and open the URL it prints.</p></div>`;
      return;
    }
    this.settings = { theme: 'dark', wlOpen: window.innerWidth > 1100, panelOpen: true, panelHeight: 300, panelTab: 'trading', ...(await kv.get('settings', {})) };
    this.theme = this.settings.theme;
    document.documentElement.dataset.theme = this.theme;
    setChartStyle(this.settings.chartStyle);

    this.replay = new Replay(this);
    this.dataManager = new DataManager(this);
    this.paper = new Paper(this);
    await this.paper.init();
    this.trading = new Trading(this, $('#panel-trading'));
    this.tester = new Tester(this, $('#panel-tester'));
    this.journal = new Journal(this, $('#panel-journal'));
    this.watchlist = new Watchlist(this, $('#watchlistBody'), $('#details'));
    this.assistant = new Assistant(this);
    this.alerts = new Alerts(this, $('#panel-alerts'));
    this.scriptEditor = new ScriptEditor(this, $('#panel-scripts'));
    this.screener = new Screener(this, $('#panel-screener'));
    this.calendar = new EconCalendar(this, $('#panel-calendar'));
    this.seasonals = new Seasonals(this, $('#panel-seasonals'));
    this.portfolio = new Portfolio(this, $('#panel-portfolio'));
    this.share = new Share(this);
    this.ideas = new Ideas(this, $('#panel-ideas'));
    this.dom = new DepthOfMarket(this, $('#panel-dom'));
    await loadScripts(); // before charts are built, so script indicators know their plots
    await upgradeLibraryScripts();

    this.buildTopbar();
    this.buildTools();
    this.buildBottomBar();
    this.buildPanel();
    this.wireKeyboard();
    this.applyWlOpen();

    const win = new URLSearchParams(location.search).get('w');
    this.layoutKey = win ? `layout:w${win.replace(/\W/g, '')}` : 'layout';
    if (win) document.title = `ChartDesk · window ${win}`;
    const layout = (await kv.get(this.layoutKey)) || (win ? null : null) || { mode: '1', views: [{ symbol: 'XAUUSD', tf: '1h', chartType: 'candles' }], active: 0 };
    await this.setLayout(layout.mode, layout.views, layout.active ?? 0);
    await this.journal.init();
    await this.watchlist.init();
    await this.alerts.init();
    await this.screener.init();
    await this.portfolio.init();
    await this.ideas.init();
    this.calendar.init(); // economic events for the panel and the chart markers
    this.onAlertsChanged();
    await this.assistant.init();
    this.toggleAssistant(!!this.settings.assistantOpen);
    this.tester.render();
    this.scriptEditor.init();
    if (this.settings.activeSession) await this.replay.resume(this.settings.activeSession);
    setInterval(() => this.tickClock(), 1000);
    this.tickClock();
    if (location.hash === '#data') this.openDataManager();
    this.commands = new Commands(this);
    await this.share.fromLocation(); // #chart=… links and pop-out windows
  }

  // ---------------------------------------------------------------- persistence helpers
  saveSettings() { kv.set('settings', this.settings); }
  saveLayout() {
    kv.set(this.layoutKey || 'layout', { mode: this.layoutMode, views: this.views.map(v => v.toJSON()), active: this.views.indexOf(this.activeView) });
  }
  async ensureDrawings(symbol) {
    if (!this.drawingsMap.has(symbol)) {
      this.drawingsMap.set(symbol, (await kv.get(`drawings:${symbol}`, [])) || []);
      (this.drawJson ||= new Map()).set(symbol, JSON.stringify(this.drawingsMap.get(symbol)));
    }
    return this.drawingsMap.get(symbol);
  }
  drawingsFor(symbol) {
    if (!this.drawingsMap.has(symbol)) this.drawingsMap.set(symbol, []);
    return this.drawingsMap.get(symbol);
  }
  saveDrawings(symbol) {
    this.drawingsVersion = (this.drawingsVersion || 0) + 1;
    // undo history: the previous state of this symbol's drawings (quick successive edits, like dragging a colour, count once)
    const json = JSON.stringify(this.drawingsFor(symbol)), last = (this.drawJson ||= new Map()).get(symbol);
    if (last != null && last !== json && !this.undoing) {
      const now = Date.now(), top = (this.undoStack ||= [])[this.undoStack.length - 1];
      if (!(top && top.symbol === symbol && now - top.at < 700)) { this.undoStack.push({ symbol, json: last, at: now }); if (this.undoStack.length > 100) this.undoStack.shift(); }
      else top.at = now;
      this.redoStack = [];
    }
    this.drawJson.set(symbol, json);
    kv.set(`drawings:${symbol}`, this.drawingsFor(symbol));
  }
  /** Ctrl+Z / Ctrl+Y for drawings. */
  undoDrawings(redo = false) {
    const from = redo ? (this.redoStack ||= []) : (this.undoStack ||= []), to = redo ? (this.undoStack ||= []) : (this.redoStack ||= []);
    const step = from.pop();
    if (!step) { toast(redo ? 'Nothing to redo' : 'Nothing to undo'); return; }
    const list = this.drawingsFor(step.symbol);
    to.push({ symbol: step.symbol, json: JSON.stringify(list), at: 0 });
    list.splice(0, list.length, ...JSON.parse(step.json));
    for (const v of this.views) if (v.symbol === step.symbol) { v.selected = null; v.floatBar.hidden = true; }
    this.undoing = true;
    try { this.saveDrawings(step.symbol); } finally { this.undoing = false; }
    toast(redo ? 'Redone' : 'Undone');
  }

  // ---------------------------------------------------------------- layout
  async setLayout(mode, cfgs = null, activeIdx = 0) {
    const n = LAYOUT_COUNT[mode] || 1;
    const prev = cfgs || this.views.map(v => v.toJSON());
    const host = $('#views');
    for (const v of this.views) v.destroy();
    this.views = [];
    host.className = `views layout-${mode}`;
    this.layoutMode = mode;
    for (let i = 0; i < n; i++) {
      const cfg = prev[i] || { ...prev[prev.length - 1] || { symbol: 'XAUUSD', tf: '1h' }, indicators: undefined };
      const sp = spec(cfg.symbol) ? cfg : { ...cfg, symbol: 'XAUUSD' };
      await this.ensureDrawings(sp.symbol);
      const v = new ChartView(this, host, structuredClone(sp));
      this.views.push(v);
    }
    this.setActive(this.views[clamp(activeIdx, 0, n - 1)]);
    this.renderLayoutMenu();
    this.saveLayout();
    await Promise.all(this.views.map(v => v.load()));
  }
  viewFor(symbol) { return this.activeView?.symbol === symbol ? this.activeView : this.views.find(v => v.symbol === symbol) || null; }

  setActive(view) {
    if (!view || view === this.activeView) return;
    this.activeView = view;
    for (const v of this.views) v.el.classList.toggle('active', v === view && this.views.length > 1);
    this.refreshToolbar();
    this.watchlist?.paint();
    this.tester?.syncTarget();
    this.saveLayout();
    if (this.paper?.enabled && !this.replay.active) { this.paper.seedQuote(view.symbol); this.trading?.render(); }
  }
  onViewChanged(view) {
    this.saveLayout();
    if (view === this.activeView) this.refreshToolbar();
  }
  /** Paper trading switched on/off, reset, or the traded symbol changed. */
  onTradingSessionChanged() {
    this.trading.render();
    for (const v of this.views) { v.lastOverlaySig = null; v.applyMarkers(); }
    this.refreshToolbar();
  }
  onViewLoaded(view) {
    if (view === this.activeView) {
      this.refreshToolbar(); this.watchlist?.renderDetails(); this.updateTitle(); this.tester?.syncTarget();
      if (this.paper?.enabled && !this.replay.active) { this.paper.brokerFor(view.symbol); this.paper.seedQuote(view.symbol); this.trading.render(); }
      // panels that follow the active chart
      if (this.settings.panelTab === 'seasonals') this.seasonals.render();
      if (this.settings.panelTab === 'calendar') this.calendar.render();
      if (this.settings.panelTab === 'dom' && this.settings.panelOpen) this.dom.start();
    }
    this.watchlist?.refreshHistorical();
  }
  layoutChanged() { /* charts auto-size via ResizeObserver */ }

  // ---------------------------------------------------------------- multi-chart sync (symbol, interval, crosshair, date range)
  get sync() { return (this.settings.sync ||= { symbol: false, tf: false, crosshair: true, time: false }); }
  syncViews(src, kind, value) {
    if (this.views.length < 2 || !this.sync[kind]) return;
    for (const v of this.views) if (v !== src) (kind === 'symbol' ? v.setSymbol(value, true) : v.setTf(value, true));
  }
  syncCrosshair(src, bar) {
    if (this.views.length < 2 || !this.sync.crosshair || this.xlock) return;
    this.xlock = true;
    try {
      for (const v of this.views) {
        if (v === src || !v.mainSeries) continue;
        const t = bar ? v.barTimeFor(bar.start ?? bar.time) : null;
        const i = t == null ? -1 : v.indexOfTime(t);
        if (i < 0) v.clearCrosshairs(); else v.chart.setCrosshairPosition(v.bars[i].close, t, v.mainSeries);
      }
    } finally { this.xlock = false; }
  }
  /** Scrolling / zooming the active chart shows the same dates on the others. */
  syncTime(src) {
    if (this.views.length < 2 || !this.sync.time || this.tlock || src !== this.activeView) return;
    cancelAnimationFrame(this.tframe);
    this.tframe = requestAnimationFrame(() => {
      const r = src.chart.timeScale().getVisibleLogicalRange();
      if (!r || !src.bars.length) return;
      const from = src.logicalToTime(r.from), to = src.logicalToTime(r.to);
      this.tlock = true;
      try { for (const v of this.views) if (v !== src && v.bars.length) v.setAllRanges({ from: v.timeToLogical(from), to: v.timeToLogical(to) }); }
      finally { this.tlock = false; }
    });
  }

  /** Alerts tab shows how many alerts are armed; charts repaint their alert lines (overlay watches alerts.version). */
  onAlertsChanged() {
    const n = this.alerts?.activeCount || 0;
    const tab = $('.ptab[data-tab="alerts"]');
    if (tab) tab.textContent = n ? `Alerts (${n})` : 'Alerts';
  }

  onReplayChanged() {
    this.trading.render();
    this.tester.render();
    this.alerts.render(); // statuses show "paused during Bar Replay"
    this.watchlist.paint();
    this.refreshToolbar();
    this.updateTitle();
  }
  onLivePrice(symbol, price) {
    this.watchlist.onLivePrice(symbol, price);
    if (symbol === this.activeView?.symbol) this.updateTitle(price);
  }
  updateTitle(price) {
    const v = this.activeView;
    if (!v) return;
    if (this.replay.active) { document.title = `Replay · ${this.replay.symbol} — ChartDesk`; return; }
    const last = price ?? v.bars[v.bars.length - 1]?.close;
    document.title = `${v.symbol}${last != null ? ' ' + fmtPrice(last, v.prec) : ''} — ChartDesk`;
  }

  setStatus(st, view) {
    if (view && view !== this.activeView) return;
    const v = this.activeView, el = $('#status');
    let cls = '', text = 'Connecting…';
    if (this.replay.active) { cls = 'replay'; text = this.replay.status(); }
    else if (v?.spec.provider === 'binance') { cls = st === 'live' ? 'live' : ''; text = st === 'live' ? 'Live · Binance' : 'Connecting to Binance…'; }
    else if (v?.spec.provider === 'tradingview') {
      cls = v.streaming && v.tickAt ? 'live' : 'hist';
      text = v.streaming && v.tickAt ? `Live · TradingView (${v.spec.tv}) · ${new Date(v.tickAt).toISOString().slice(11, 19)} UTC` : `TradingView · ${v.spec.tv} · connecting…`;
    } else if (v?.spec.provider === 'twelvedata') {
      const last = v.bars[v.bars.length - 1];
      cls = v.spec.tdConfigured ? (last ? 'hist' : 'warn') : 'warn';
      const li = v.liveInfo;
      if (!v.spec.tdConfigured) text = 'Twelve Data key missing — see Data';
      else if (v.streaming && v.tickAt) { cls = 'live'; text = `Live · Twelve Data stream · ${new Date(v.tickAt).toISOString().slice(11, 19)} UTC`; }
      else if (li?.throttled) { cls = 'warn'; text = `Twelve Data · ${v.spec.td} · auto-refresh paused: ${li.credits ? `${li.credits.used}/${li.credits.limit}` : '90%'} daily credits used`; }
      else if (li?.fetchedAt) { cls = 'live'; text = `Twelve Data · ${v.spec.td} · updated ${new Date(li.fetchedAt).toISOString().slice(11, 16)} UTC`; }
      else text = last ? `Twelve Data · ${v.spec.td} · to ${fmtDate(last.time)} ${new Date(last.time * 1000).toISOString().slice(11, 16)} UTC` : `Twelve Data · ${v.spec.td}`;
    } else if (v) {
      const c = v.spec.coverage;
      cls = c?.months ? 'hist' : 'warn';
      text = c?.months ? `Historical · Dukascopy · to ${fmtDate(c.last)}` : 'No data cached — open Data';
    }
    el.className = `status ${cls}`;
    el.querySelector('span').textContent = text;
  }

  // ---------------------------------------------------------------- top bar
  buildTopbar() {
    $('#symbolBtn').addEventListener('click', () => this.openSymbolSearch('open'));
    $('#compareBtn').addEventListener('click', () => this.openSymbolSearch('compare'));
    $('#indBtn').addEventListener('click', () => this.openIndicators());
    $('#replayBtn').addEventListener('click', () => this.replay.openDialog());
    $('#dataBtn').addEventListener('click', () => this.openDataManager());
    $('#themeBtn').addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    $('#askBtn').addEventListener('click', () => this.toggleAssistant());
    $('#styleBtn').addEventListener('click', () => this.openChartSettings());
    $('#fsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
    });
    $('#shotBtn').addEventListener('click', e => {
      e.stopPropagation();
      this.closePopovers();
      let menu = $('#shotMenu');
      if (!menu) { menu = h('div', { id: 'shotMenu', class: 'menu', hidden: true }); document.body.append(menu); }
      const go = fn => () => { menu.hidden = true; fn(); };
      fill(menu, h('div', { class: 'menu-title' }, 'Snapshot & share'),
        h('button', { onclick: go(() => this.snapshot('download')) }, icon('download'), 'Download image', h('small', null, 'Alt+S')),
        h('button', { onclick: go(() => this.snapshot('copy')) }, icon('copy'), 'Copy image', h('small', null, 'Ctrl+Shift+S')),
        h('button', { onclick: go(() => this.snapshot('tab')) }, icon('camera'), 'Open image in new tab'),
        h('div', { class: 'menu-sep' }),
        h('button', { onclick: go(() => this.share.copyLink()) }, icon('link'), 'Copy chart link'),
        h('button', { onclick: go(() => this.share.exportFile()) }, icon('save'), 'Save chart file (with scripts)'),
        h('button', { onclick: go(() => this.share.pickFile()) }, icon('upload'), 'Open a chart file…'),
        h('button', { onclick: go(() => this.ideas.openNew()) }, icon('sparkle'), 'Save as idea…'),
        h('button', { onclick: go(() => this.share.popout()) }, icon('layout1'), 'Open in new window'));
      const r = e.currentTarget.getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)}px`;
      menu.style.top = `${r.bottom + 4}px`;
      setTimeout(() => document.addEventListener('mousedown', ev => { if (!menu.contains(ev.target)) menu.hidden = true; }, { once: true }), 0);
    });
    $('#wlToggle').addEventListener('click', () => this.toggleWatchlist());
    wireDropImport(this); // drag CSV files onto the app to import them
    this.wireWlResizer();

    // Menus (chart type, more timeframes, layout)
    const menus = [['#typeBtn', '#typeMenu'], ['#tfMore', '#tfMenu'], ['#layoutBtn', '#layoutMenu']];
    for (const [btn, menu] of menus) {
      $(btn).addEventListener('click', e => {
        e.stopPropagation();
        const m = $(menu), open = m.hidden;
        this.closePopovers();
        if (!open) return;
        if (menu === '#layoutMenu') this.renderLayoutMenu(); // sync switches may have changed elsewhere
        const r = e.currentTarget.getBoundingClientRect();
        m.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
        m.style.top = `${r.bottom + 4}px`;
        m.hidden = false;
      });
    }
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('.menu, #popover, .lg-actions, #typeBtn, #tfMore, #layoutBtn')) this.closePopovers();
    });
  }
  closePopovers() { for (const m of $$('.menu, #popover')) m.hidden = true; }
  /** Chart snapshot: download, copy to the clipboard, or open in a new tab. */
  snapshot(mode = 'download') {
    const v = this.activeView, canvas = v.screenshot();
    canvas.toBlob(async blob => {
      if (mode === 'copy') {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Snapshot copied — paste it anywhere'); }
        catch { toast('The browser blocked copying images — use Download instead', 'error'); }
        return;
      }
      const url = URL.createObjectURL(blob);
      if (mode === 'tab') { window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60e3); return; }
      const a = h('a', { href: url, download: `${v.symbol}_${v.cfg.tf}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Snapshot saved');
    });
  }
  openPalette(q = '') { this.commands.openPalette(q); }
  openShortcuts() { this.commands.openShortcuts(); }
  /** Typing digits on the chart opens the interval box: 15 → 15m, 4h, 1D… */
  openIntervalBox(first) {
    let box = $('#intervalBox');
    if (!box) { box = h('div', { id: 'intervalBox', class: 'interval-box', hidden: true }); document.body.append(box); }
    const input = h('input', { value: first, spellcheck: 'false' });
    const hint = h('div', { class: 'muted small' });
    const upd = () => { const tf = parseInterval(input.value); hint.textContent = tf ? `Enter → ${tfLabel(tf)}` : 'e.g. 1, 5, 15, 30 (minutes), 1h, 4h, 1D, 1W, 1M'; };
    input.addEventListener('input', upd);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const tf = parseInterval(input.value); box.hidden = true; if (tf) this.activeView.setTf(tf); else toast(`No ${input.value} interval`, 'error'); }
      if (e.key === 'Escape') { e.stopPropagation(); box.hidden = true; }
    });
    input.addEventListener('blur', () => { setTimeout(() => { box.hidden = true; }, 100); });
    fill(box, h('div', { class: 'muted small' }, 'Change interval'), input, hint);
    box.hidden = false;
    upd();
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  }

  refreshToolbar() {
    const v = this.activeView;
    if (!v) return;
    $('#symbolLabel').textContent = v.symbol;
    $('#tfFavs').replaceChildren(...FAVORITE_TFS.map(tf => h('button', { class: 'tb-btn' + (tf === v.cfg.tf ? ' active' : ''), onclick: () => v.setTf(tf) }, tfLabel(tf))));
    const fav = FAVORITE_TFS.includes(v.cfg.tf);
    $('#tfMore').replaceChildren(fav ? '' : h('span', { class: 'active-tf' }, tfLabel(v.cfg.tf)), h('span', { class: 'caret' }));
    $('#tfMenu').replaceChildren(h('div', { class: 'menu-title' }, 'Timeframes'), ...TIMEFRAMES.map(([tf, l]) => h('button', { class: tf === v.cfg.tf ? 'active' : '', onclick: () => { v.setTf(tf); this.closePopovers(); } },
      l, h('small', null, { '1m': '1 minute', '3m': '3 minutes', '5m': '5 minutes', '15m': '15 minutes', '30m': '30 minutes', '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '1d': '1 day', '1w': '1 week', '1M': '1 month' }[tf]))));
    const t = CHART_TYPES.find(x => x.k === v.cfg.chartType) || CHART_TYPES[1];
    $('#typeIcon').innerHTML = svg(t.icon);
    $('#typeMenu').replaceChildren(...CHART_TYPES.flatMap((ct, i) => {
      const pick = h('button', { class: (ct.k === v.cfg.chartType ? 'active' : '') + (ct.price ? ' grow' : ''), onclick: () => { v.setChartType(ct.k); this.closePopovers(); } }, icon(ct.icon), ct.label);
      return [
        ct.price && !CHART_TYPES[i - 1]?.price ? h('div', { class: 'menu-title' }, 'Price-based (box size in ⚙)') : null,
        ct.price ? h('div', { class: 'menu-row' }, pick, h('button', { title: `${ct.label} settings`, onclick: e => { e.stopPropagation(); this.openTypeSettings(v, ct.k, e.currentTarget); } }, icon('gear'))) : pick,
      ].filter(Boolean);
    }));
    const nCmp = v.cfg.compare?.length || 0;
    $('#compareBtn').classList.toggle('active', nCmp > 0);
    $('#compareBtn').title = nCmp ? `Comparing with ${v.cfg.compare.map(c => c.symbol).join(', ')} — click to add another` : 'Compare with another symbol';
    $('#themeBtn').replaceChildren(icon(this.theme === 'dark' ? 'sun' : 'moon'));
    $('#replayBtn').classList.toggle('active', this.replay.active);
    $$('.bb-btn[data-scale]').forEach(b => {
      const m = b.dataset.scale;
      b.classList.toggle('active', (m === 'pct' && v.cfg.scaleMode === 2) || (m === 'log' && v.cfg.scaleMode === 1));
    });
    this.setStatus(v.spec?.provider === 'binance' && v.unsubLive ? 'live' : null, v);
  }

  renderLayoutMenu() {
    $('#layoutIcon').innerHTML = svg((LAYOUTS.find(l => l[0] === this.layoutMode) || LAYOUTS[0])[1]);
    const saved = kv.peek('layouts', {}) || {};
    $('#layoutMenu').replaceChildren(
      h('div', { class: 'menu-title' }, 'Chart layout'),
      h('div', { class: 'layout-grid' }, LAYOUTS.map(([k, ic, title]) => h('button', { class: k === this.layoutMode ? 'active' : '', title, onclick: () => { this.closePopovers(); this.setLayout(k); } }, icon(ic)))),
      h('div', { class: 'menu-title' }, 'Sync between charts'),
      ...SYNC_OPTIONS.map(([k, l]) => h('button', { class: this.sync[k] ? 'active' : '', onclick: e => {
        e.stopPropagation();
        this.sync[k] = !this.sync[k];
        this.saveSettings();
        this.renderLayoutMenu();
        if (k === 'time' && this.sync.time) this.syncTime(this.activeView);
      } }, icon(this.sync[k] ? 'check' : 'link'), l, h('small', null, this.sync[k] ? 'on' : 'off'))),
      h('div', { class: 'menu-title' }, 'Saved layouts'),
      ...Object.keys(saved).map(name => h('div', { class: 'menu-row' },
        h('button', { class: 'grow', onclick: () => { this.closePopovers(); const l = saved[name]; this.setLayout(l.mode, l.views, l.active); toast(`Loaded layout “${name}”`); } }, icon('folder'), name),
        h('button', { title: 'Delete', onclick: async e => { e.stopPropagation(); delete saved[name]; kv.set('layouts', saved); this.renderLayoutMenu(); } }, icon('trash')))),
      h('button', { onclick: () => {
        this.closePopovers();
        this.prompt('Save layout as', '', name => {
          if (!name) return;
          const all = kv.peek('layouts', {}) || {};
          all[name] = { mode: this.layoutMode, views: this.views.map(v => v.toJSON()), active: this.views.indexOf(this.activeView) };
          kv.set('layouts', all);
          this.renderLayoutMenu();
          toast(`Layout “${name}” saved (charts, timeframes, indicators)`);
        });
      } }, icon('save'), 'Save current layout…'));
  }

  // ---------------------------------------------------------------- drawing tools
  /** Left toolbar: cursor, tool groups with flyout menus (like TradingView), measure, magnet, lock, hide, object tree, undo, eraser, clear. */
  buildTools() {
    const nav = $('#tools');
    this.magnet = !!this.settings.magnet;
    this.drawingsLocked = !!this.settings.drawingsLocked;
    const cur = (this.settings.toolCur ||= {});
    const plain = (k, title, ic) => h('button', { class: 'tool', title, 'data-tool': k, onclick: () => this.setTool(this.tool === k && k !== 'cursor' ? 'cursor' : k) }, icon(ic));
    const toggle = (key, title, icOn, icOff, onChange) => {
      const b = h('button', { class: 'tool', title, 'data-toggle': key });
      const paint = () => { b.classList.toggle('active', !!this[key]); b.replaceChildren(icon(this[key] ? icOn : icOff)); };
      b.addEventListener('click', () => { this[key] = !this[key]; paint(); onChange?.(); });
      paint();
      return b;
    };
    const groups = TOOL_GROUPS.map(g => {
      const k = cur[g.k] && g.items.includes(cur[g.k]) ? cur[g.k] : g.items[0];
      const main = h('button', { class: 'tool', 'data-group': g.k, title: `${toolTitle(k)}${TOOL_INFO[k].key ? ` (${TOOL_INFO[k].key})` : ''}`, onclick: () => {
        const t = (this.settings.toolCur?.[g.k] && g.items.includes(this.settings.toolCur[g.k])) ? this.settings.toolCur[g.k] : g.items[0];
        this.setTool(this.tool === t ? 'cursor' : t);
      } }, icon(TOOL_INFO[k].icon));
      const more = h('button', { class: 'tool-more', title: `More ${g.title.toLowerCase()}`, onclick: e => { e.stopPropagation(); this.openToolMenu(g, main); } });
      main.addEventListener('contextmenu', e => { e.preventDefault(); this.openToolMenu(g, main); });
      return h('div', { class: 'tool-wrap' }, main, more);
    });
    nav.replaceChildren(
      plain('cursor', 'Cross', 'cross'),
      h('div', { class: 'tool-sep' }),
      ...groups,
      plain('measure', 'Measure (Shift+click)', 'ruler'),
      h('div', { class: 'tool-sep' }),
      toggle('magnet', 'Magnet: snap drawing points to the candle\'s open / high / low / close', 'magnet', 'magnet', () => { this.settings.magnet = this.magnet; this.saveSettings(); toast(this.magnet ? 'Magnet on: points snap to OHLC' : 'Magnet off'); }),
      toggle('drawingsLocked', 'Lock all drawings (they can still be selected and edited)', 'lock', 'unlock', () => { this.settings.drawingsLocked = this.drawingsLocked; this.saveSettings(); toast(this.drawingsLocked ? 'All drawings locked' : 'Drawings unlocked'); }),
      toggle('hideDrawings', 'Hide all drawings', 'eyeOff', 'eye'),
      h('button', { class: 'tool', title: 'Object tree: every drawing on this symbol — show, hide, lock, group, delete', onclick: e => this.openObjectTree(e.currentTarget) }, icon('tree')),
      h('button', { class: 'tool', title: 'Undo (Ctrl+Z) — redo with Ctrl+Y', onclick: () => this.undoDrawings() }, icon('undo')),
      h('div', { class: 'tool-sep' }),
      plain('eraser', 'Eraser', 'eraser'),
      h('button', { class: 'tool', title: 'Remove all drawings on this symbol', onclick: async () => {
        const v = this.activeView, list = v.drawings;
        if (!list.length) { toast('No drawings on this symbol'); return; }
        if (await confirmBox(`Remove all ${list.length} drawing(s) on ${v.symbol}?\nYou can undo this with Ctrl+Z.`, 'Remove')) { list.length = 0; v.selected = null; this.saveDrawings(v.symbol); }
      } }, icon('trash')));
    this.setTool('cursor');
  }
  /** Flyout listing a group's tools; the pick becomes the group's button. */
  openToolMenu(g, anchor) {
    this.closePopovers();
    let menu = $('#toolMenu');
    if (!menu) { menu = h('div', { id: 'toolMenu', class: 'menu tool-menu', hidden: true }); document.body.append(menu); }
    const pick = k => {
      this.settings.toolCur = { ...this.settings.toolCur, [g.k]: k };
      this.saveSettings();
      const btn = $(`#tools .tool[data-group="${g.k}"]`);
      btn.replaceChildren(icon(TOOL_INFO[k].icon));
      btn.title = `${toolTitle(k)}${TOOL_INFO[k].key ? ` (${TOOL_INFO[k].key})` : ''}`;
      menu.hidden = true;
      this.setTool(k);
    };
    menu.replaceChildren(h('div', { class: 'menu-title' }, g.title), ...g.items.map(k => h('button', { class: this.tool === k ? 'active' : '', onclick: () => pick(k) },
      icon(TOOL_INFO[k].icon), toolTitle(k), h('small', null, TOOL_INFO[k].key || (TOOL_INFO[k].n === 'path' ? 'double-click ends' : '')))),
    ...(g.k === 'annot' ? [h('div', { class: 'menu-title' }, 'Icons'), h('div', { class: 'icon-grid' }, ICON_CHOICES.map(ic => h('button', { title: `Place ${ic}`, onclick: () => { this.lastIcon = ic; pick('icon'); } }, ic)))] : []));
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.right + 6}px`;
    menu.hidden = false;
    menu.style.top = `${clamp(r.top - 6, 6, window.innerHeight - menu.offsetHeight - 6)}px`;
  }
  setTool(k) {
    this.tool = k;
    for (const v of this.views) { if (k !== 'measure') { v.pending = null; v.pendingDown = null; } v.mainPane.classList.toggle('drawing-mode', k !== 'cursor' && k !== 'eraser'); v.mainPane.classList.toggle('eraser-mode', k === 'eraser'); }
    $$('#tools .tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === k));
    for (const g of TOOL_GROUPS) {
      const btn = $(`#tools .tool[data-group="${g.k}"]`);
      if (!btn) continue;
      const on = g.items.includes(k);
      btn.classList.toggle('active', on);
      if (on && this.settings.toolCur?.[g.k] !== k) { this.settings.toolCur = { ...this.settings.toolCur, [g.k]: k }; btn.replaceChildren(icon(TOOL_INFO[k].icon)); btn.title = toolTitle(k); }
    }
  }

  editText(view, d, isNew = false) {
    const title = { note: 'Note', callout: 'Callout text', text: 'Text', trend: 'Line label', hline: 'Line label', rect: 'Label inside the rectangle', flag: 'Flag label', arrowup: 'Label under the arrow', arrowdown: 'Label above the arrow' }[d.type] || 'Text';
    this.prompt(title, d.text || '', text => {
      if (text == null || (!text.trim() && isNew)) { if (isNew && ['text', 'note', 'callout'].includes(d.type) && d.type !== 'callout') view.removeDrawing(d); return; }
      d.text = text;
      this.saveDrawings(view.symbol);
    }, true, () => { if (isNew && !d.text && ['text', 'note'].includes(d.type)) view.removeDrawing(d); });
  }
  /** Emoji picker for icon drawings. */
  pickIcon(anchor, onPick) {
    const pop = $('#popover');
    pop.className = 'popover';
    pop.replaceChildren(h('h4', null, 'Icon'), h('div', { class: 'icon-grid' }, ICON_CHOICES.map(ic => h('button', { onclick: () => { this.lastIcon = ic; onPick(ic); pop.hidden = true; } }, ic))));
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, window.innerWidth - 240)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.hidden = false;
  }
  /** Default style for new drawings of a tool. */
  drawDefault(type) { return this.settings.drawDefaults?.[type] || null; }
  /** Drawing templates: save the selected drawing's style as the tool's default or under a name, and apply saved ones. */
  openDrawingTemplates(view, d, anchor) {
    const pop = $('#popover');
    pop.className = 'popover';
    const KEYS = ['color', 'width', 'style', 'fill', 'extend', 'size', 'deviation'];
    const styleOf = x => Object.fromEntries(KEYS.filter(k => x[k] !== undefined).map(k => [k, x[k]]));
    const name = toolTitle(d.type);
    const named = () => (this.settings.drawTemplates ||= {})[d.type] ||= {};
    const apply = st => { Object.assign(d, st); this.saveDrawings(view.symbol); view.buildFloatBar(d); pop.hidden = true; };
    const render = () => fill(pop, h('h4', null, `${name} templates`),
      h('button', { class: 'btn small', onclick: () => { this.settings.drawDefaults = { ...this.settings.drawDefaults, [d.type]: styleOf(d) }; this.saveSettings(); toast(`New ${name.toLowerCase()} drawings will use this style`); pop.hidden = true; } }, 'Save as default'),
      this.settings.drawDefaults?.[d.type] ? h('button', { class: 'btn small', onclick: () => { delete this.settings.drawDefaults[d.type]; this.saveSettings(); toast(`${name}: default style reset`); render(); } }, 'Reset default') : null,
      h('button', { class: 'btn small', onclick: () => this.prompt('Template name', '', n => { if (!n) return; named()[n] = styleOf(d); this.saveSettings(); toast(`Template “${n}” saved`); render(); }) }, 'Save as template…'),
      ...Object.entries(named()).map(([n, st]) => h('div', { class: 'tpl-row' },
        h('button', { class: 'grow', onclick: () => apply(st) }, h('i', { class: 'cs-dot', style: { background: st.color || ACCENT } }), n),
        h('button', { title: 'Delete', onclick: () => { delete named()[n]; this.saveSettings(); render(); } }, icon('trash')))));
    render();
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, window.innerWidth - 260)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.hidden = false;
  }
  /** Object tree: the drawings on the active chart's symbol, with show / hide, lock, delete and named groups. */
  openObjectTree(anchor) {
    const pop = $('#popover');
    pop.className = 'popover obj-tree';
    const v = this.activeView, list = v.drawings, sel = new Set();
    const save = () => { this.saveDrawings(v.symbol); render(); };
    const row = d => h('div', { class: 'ot-row' + (v.selected === d ? ' sel' : '') + (d.hidden ? ' off' : '') },
      h('input', { type: 'checkbox', checked: sel.has(d.id), onchange: e => { if (e.target.checked) sel.add(d.id); else sel.delete(d.id); render(); } }),
      h('button', { class: 'ot-name', title: 'Show on the chart', onclick: () => { v.revealDrawing(d); render(); } }, icon(TOOL_INFO[d.type]?.icon || 'trend'), h('span', null, toolTitle(d.type), d.text ? h('small', null, ` “${String(d.text).slice(0, 22)}”`) : null)),
      h('button', { title: d.hidden ? 'Show' : 'Hide', onclick: () => { d.hidden = !d.hidden; if (d.hidden && v.selected === d) v.selected = null; save(); } }, icon(d.hidden ? 'eyeOff' : 'eye')),
      h('button', { title: d.locked ? 'Unlock' : 'Lock', onclick: () => { d.locked = !d.locked; save(); } }, icon(d.locked ? 'lock' : 'unlock')),
      h('button', { title: 'Delete', onclick: () => { v.removeDrawing(d); render(); } }, icon('trash')));
    const render = () => {
      const groups = [...new Set(list.map(d => d.group).filter(Boolean))];
      const loose = list.filter(d => !d.group);
      const groupBlock = gname => {
        const members = list.filter(d => d.group === gname), allHidden = members.every(d => d.hidden), allLocked = members.every(d => d.locked);
        return h('div', { class: 'ot-group' },
          h('div', { class: 'ot-ghead' }, icon('folder'), h('b', { class: 'grow' }, gname), h('small', { class: 'muted' }, `${members.length}`),
            h('button', { title: allHidden ? 'Show group' : 'Hide group', onclick: () => { members.forEach(d => { d.hidden = !allHidden; }); save(); } }, icon(allHidden ? 'eyeOff' : 'eye')),
            h('button', { title: allLocked ? 'Unlock group' : 'Lock group', onclick: () => { members.forEach(d => { d.locked = !allLocked; }); save(); } }, icon(allLocked ? 'lock' : 'unlock')),
            h('button', { title: 'Ungroup', onclick: () => { members.forEach(d => { delete d.group; }); save(); } }, icon('close')),
            h('button', { title: 'Delete group and its drawings', onclick: async () => { if (await confirmBox(`Delete the ${members.length} drawings in “${gname}”?`, 'Delete')) { for (const d of members) list.splice(list.indexOf(d), 1); v.selected = null; save(); } } }, icon('trash'))),
          members.map(row));
      };
      fill(pop, h('h4', null, `Drawings on ${v.symbol}`),
        list.length ? null : h('p', { class: 'muted small' }, 'No drawings yet — pick a tool on the left.'),
        ...groups.map(groupBlock), ...loose.map(row),
        list.length ? h('div', { class: 'ot-actions' },
          h('button', { class: 'btn small', disabled: !sel.size, onclick: () => this.prompt('Group name', `Group ${groups.length + 1}`, n => { if (!n) return; for (const d of list) if (sel.has(d.id)) d.group = n; sel.clear(); save(); }) }, `Group selected${sel.size ? ` (${sel.size})` : ''}`),
          h('button', { class: 'btn small', onclick: () => { list.forEach(d => { d.hidden = false; }); save(); } }, 'Show all'),
          h('button', { class: 'btn small', onclick: () => { const lock = !list.every(d => d.locked); list.forEach(d => { d.locked = lock; }); save(); } }, list.every(d => d.locked) ? 'Unlock all' : 'Lock all')) : null,
        h('p', { class: 'muted small' }, 'Grouped drawings move together. Ctrl+Z undoes drawing changes.'));
    };
    render();
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.right + 6}px`;
    pop.style.top = `${clamp(r.top - 40, 8, window.innerHeight - 420)}px`;
    pop.hidden = false;
  }

  // ---------------------------------------------------------------- bottom bar (ranges / scale / clock)
  buildBottomBar() {
    $('#ranges').replaceChildren(...RANGES.map(r => h('button', { class: 'tb-btn', title: `${r.l} at ${tfLabel(r.tf)}`, onclick: () => this.applyRange(r) }, r.l)));
    $$('.bb-btn[data-scale]').forEach(b => b.addEventListener('click', () => {
      const v = this.activeView, m = b.dataset.scale;
      if (m === 'auto') { v.chart.priceScale('right').applyOptions({ autoScale: true }); return; }
      const mode = m === 'pct' ? 2 : 1;
      v.setScaleMode(v.cfg.scaleMode === mode ? 0 : mode);
      this.refreshToolbar();
    }));
  }
  async applyRange(r) {
    const v = this.activeView;
    if (v.cfg.tf !== r.tf) await v.setTf(r.tf);
    const B = v.bars;
    if (!B.length) return;
    if (r.span === 'all') { v.chart.timeScale().fitContent(); return; }
    const last = B[B.length - 1].time;
    const from = r.span === 'ytd' ? Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000 : last - r.span;
    v.setAllRanges({ from: Math.max(0, Math.floor(v.timeToLogical(from))), to: B.length - 1 + 4 });
  }
  focusTime(t) {
    const v = this.activeView;
    if (!v.bars.length) return;
    const l = v.timeToLogical(t);
    const r = v.chart.timeScale().getVisibleLogicalRange();
    const w = r ? r.to - r.from : 120;
    v.setAllRanges({ from: l - w / 2, to: l + w / 2 });
  }
  tickClock() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    $('#clock').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
  }

  // ---------------------------------------------------------------- bottom panel
  buildPanel() {
    const panel = $('#panel');
    const tabs = [['trading', 'Trading panel'], ['tester', 'Strategy Tester'], ['journal', 'Journal'], ['alerts', 'Alerts'], ['portfolio', 'Portfolio'], ['screener', 'Screener'], ['calendar', 'Calendar'], ['seasonals', 'Seasonals'], ['dom', 'DOM'], ['ideas', 'Ideas'], ['scripts', 'Scripts']];
    $('#panelTabs').replaceChildren(...tabs.map(([k, l]) => h('button', { class: 'ptab', 'data-tab': k, onclick: () => this.showPanel(k) }, l)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'tb-btn icon-only', id: 'panelToggle', title: 'Collapse / expand panel', onclick: () => { this.settings.panelOpen = !this.settings.panelOpen; this.saveSettings(); this.applyPanel(); } }, icon('chevronDown')));
    const resizer = $('#panelResizer');
    resizer.addEventListener('pointerdown', e => {
      e.preventDefault();
      const startY = e.clientY, startH = this.settings.panelHeight;
      const move = ev => { this.settings.panelHeight = clamp(startH - (ev.clientY - startY), 140, window.innerHeight - 220); this.applyPanel(); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.saveSettings(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    void panel;
    this.applyPanel();
  }
  showPanel(tab) {
    this.settings.panelTab = tab;
    this.settings.panelOpen = true;
    this.saveSettings();
    this.applyPanel();
    if (tab === 'tester') this.tester.render();
    if (tab === 'scripts' && !this.scriptEditor.textarea) this.scriptEditor.render();
    if (tab === 'screener') this.screener.render();
    if (tab === 'calendar') this.calendar.render();
    if (tab === 'seasonals') this.seasonals.render();
    if (tab === 'portfolio') { this.portfolio.render(); this.portfolio.refreshPrices(); }
    if (tab === 'dom') this.dom.start(); else this.dom?.stop();
    if (tab === 'ideas') this.ideas.render();
  }
  applyPanel() {
    const { panelOpen, panelTab, panelHeight } = this.settings;
    $('#panelBody').style.height = panelOpen ? `${panelHeight}px` : '0px';
    $('#panel').classList.toggle('collapsed', !panelOpen);
    $$('.ptab').forEach(b => b.classList.toggle('active', b.dataset.tab === panelTab && panelOpen));
    $$('.panel-page').forEach(p => { p.hidden = p.id !== `panel-${panelTab}`; });
    $('#panelToggle')?.replaceChildren(icon(panelOpen ? 'chevronDown' : 'chevronUp'));
  }
  setTheme(theme) {
    if (theme === this.theme) return;
    this.theme = this.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    this.saveSettings();
    for (const v of this.views) v.applyTheme();
    this.tester.applyTheme();
    this.refreshToolbar();
  }
  /** Apply a (partial) chart style to every chart and persist it. */
  updateChartStyle(patch) {
    const next = setChartStyle({ ...chartStyle(), ...patch });
    this.settings.chartStyle = next;
    this.saveSettings();
    for (const v of this.views) v.applyStyle();
  }

  /** Chart settings: section navigation on the left, live preview, Cancel restores, Ok keeps. */
  openChartSettings(section = this.settingsSection || 'symbol') {
    const PALETTE = ['#089981', '#26a69a', '#22c55e', '#2962ff', '#00bcd4', '#7e57c2', '#f23645', '#ef5350', '#ff9800', '#ffeb3b',
      '#ffffff', '#d1d4dc', '#b2b5be', '#787b86', '#5d606b', '#000000'];
    const modal = $('#styleModal'), body = $('#styleBody');
    const snapshot = { ...chartStyle() };
    let current = section;
    // Indicators currently recolouring candles (Pine barcolor) — they would hide the user's own candle colours.
    const recolouring = () => [...new Set(this.views.flatMap(v => v.runtimes.filter(r => r.ind.visible !== false && (r.barColors?.size || r.candleOverlay)).map(r => defOf(r.ind).name)))];
    const CANDLE_KEYS = ['up', 'down', 'borderUp', 'borderDown', 'wickUp', 'wickDown', 'bodyVisible', 'borderVisible', 'wickVisible', 'colorByPrevClose'];
    let autoOff = false;
    const set = patch => {
      if (Object.keys(patch).some(k => CANDLE_KEYS.includes(k)) && chartStyle().allowBarColor !== false && recolouring().length) { patch = { ...patch, allowBarColor: false }; autoOff = true; }
      this.updateChartStyle(patch); render();
    };
    const st = () => chartStyle();

    // ---- small controls
    const check = (key, label, hint) => {
      const c = h('input', { type: 'checkbox' });
      c.checked = st()[key] !== false;
      c.addEventListener('change', () => set({ [key]: c.checked }));
      return h('label', { class: 'cs-row cs-check', title: hint || '' }, c, h('span', null, label));
    };
    const select = (key, label, options) => {
      const s = h('select', null, options.map(([v, l]) => h('option', { value: String(v) }, l)));
      s.value = String(st()[key] ?? options[0][0]);
      s.addEventListener('change', () => set({ [key]: isNaN(Number(s.value)) || s.value === '' ? s.value : Number(s.value) }));
      return h('div', { class: 'cs-row' }, h('span', { class: 'cs-label' }, label), s);
    };
    /** Colour swatch that opens a palette popover (fixed colours + custom picker). */
    const swatch = (key, fallback, title) => {
      const value = st()[key] || fallback;
      const b = h('button', { class: 'cs-swatch', title, style: { background: value } });
      b.addEventListener('click', e => {
        e.stopPropagation();
        const pop = $('#popover');
        const custom = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#2962ff' });
        custom.addEventListener('input', () => set({ [key]: custom.value }));
        pop.replaceChildren(h('div', { class: 'cs-palette' }, PALETTE.map(col => h('button', {
          class: 'cs-pal' + (col === value ? ' active' : ''), style: { background: col }, title: col,
          onclick: () => { pop.hidden = true; set({ [key]: col }); },
        }))), h('label', { class: 'cs-custom' }, custom, h('span', null, 'Custom colour')));
        pop.className = 'popover cs-pop';
        const r = b.getBoundingClientRect();
        pop.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
        pop.style.top = `${r.bottom + 6}px`;
        pop.hidden = false;
      });
      return b;
    };
    const candleRow = (label, visKey, upKey, downKey, upFallback, downFallback) => {
      const c = h('input', { type: 'checkbox' });
      c.checked = st()[visKey] !== false;
      c.addEventListener('change', () => set({ [visKey]: c.checked }));
      return h('div', { class: 'cs-row' }, h('label', { class: 'cs-check cs-label' }, c, h('span', null, label)),
        h('span', { class: 'cs-pair' }, swatch(upKey, upFallback, `${label} — up`), swatch(downKey, downFallback, `${label} — down`)));
    };
    const heading = t => h('div', { class: 'cs-heading' }, t);

    const SECTIONS = {
      symbol: ['Symbol', 'candles', () => {
        const c = candleColors();
        return [
          heading('Candles'),
          (() => {
            const names = recolouring(), off = chartStyle().allowBarColor === false;
            if (!names.length && !off) return null;
            const c = h('input', { type: 'checkbox' });
            c.checked = !off;
            c.addEventListener('change', () => { this.updateChartStyle({ allowBarColor: c.checked }); render(); });
            return h('div', { class: 'cs-note' },
              h('label', { class: 'cs-check' }, c, h('span', null, 'Let indicators recolour candles')),
              h('div', { class: 'muted small' }, off
                ? `${autoOff ? 'Turned off so your colours show. ' : ''}${names.length ? `${names.join(', ')} would otherwise colour the candles.` : ''}`
                : `${names.join(', ')} is colouring the candles, so your colours below are hidden.`));
          })(),
          check('colorByPrevClose', 'Color bars based on previous close'),
          candleRow('Body', 'bodyVisible', 'up', 'down', c.up, c.down),
          candleRow('Borders', 'borderVisible', 'borderUp', 'borderDown', c.borderUp, c.borderDown),
          candleRow('Wick', 'wickVisible', 'wickUp', 'wickDown', c.wickUp, c.wickDown),
          h('div', { class: 'cs-row' }, h('span', { class: 'cs-label muted small' }, 'Quick: same colour for all candles'),
            h('span', { class: 'cs-quick' }, PALETTE.slice(0, 16).map(col => h('button', { class: 'cs-mini', style: { background: col }, title: col,
              onclick: () => set({ up: col, down: col, borderUp: null, borderDown: null, wickUp: null, wickDown: null }) })))),
          h('div', { class: 'cs-row' }, h('span', { class: 'cs-label muted small' }, 'Presets'),
            h('span', { class: 'cs-quick' }, Object.values(PRESETS).map(p => h('button', { class: 'chip', onclick: () => set({ up: p.up, down: p.down, borderUp: null, borderDown: null, wickUp: null, wickDown: null }) },
              h('i', { class: 'cs-dot', style: { background: p.up } }), h('i', { class: 'cs-dot', style: { background: p.down } }), p.name)))),
          heading('Data modification'),
          select('precision', 'Precision', [['default', 'Default'], [0, '1'], [1, '0.1'], [2, '0.01'], [3, '0.001'], [4, '0.0001'], [5, '0.00001']]),
          select('timezone', 'Timezone', [['UTC', 'UTC'], ['local', 'Local (this computer)'], ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'],
            ['Europe/London', 'London'], ['Europe/Berlin', 'Frankfurt'], ['Asia/Dubai', 'Dubai'], ['Asia/Singapore', 'Singapore'], ['Asia/Tokyo', 'Tokyo'], ['Australia/Sydney', 'Sydney']]),
        ];
      }],
      status: ['Status line', 'list', () => [
        heading('Symbol'),
        check('showTitle', 'Title (symbol, timeframe, source)'),
        check('showOhlc', 'Open / high / low / close values'),
        check('showChange', 'Bar change values'),
        heading('Indicators'),
        check('showIndTitles', 'Indicator titles'),
        check('showIndValues', 'Indicator values'),
      ]],
      scales: ['Scales and lines', 'trend', () => [
        heading('Price scale'),
        check('lastPriceLine', 'Last price line and label'),
        heading('Lines'),
        check('gridV', 'Vertical grid lines'),
        check('gridH', 'Horizontal grid lines'),
        select('crosshair', 'Crosshair', [['normal', 'Free'], ['magnet', 'Magnet (snaps to OHLC)'], ['hidden', 'Hidden']]),
      ]],
      canvas: ['Canvas', 'edit', () => {
        const bgOn = h('input', { type: 'checkbox' });
        bgOn.checked = !!st().bg;
        bgOn.addEventListener('change', () => set({ bg: bgOn.checked ? (this.theme === 'dark' ? '#11141c' : '#ffffff') : null }));
        const gridOn = h('input', { type: 'checkbox' });
        gridOn.checked = !!st().gridColor;
        gridOn.addEventListener('change', () => set({ gridColor: gridOn.checked ? '#2a2e39' : null }));
        return [
          heading('Chart basic styles'),
          h('div', { class: 'cs-row' }, h('label', { class: 'cs-check cs-label' }, bgOn, h('span', null, 'Custom background')), st().bg ? swatch('bg', st().bg, 'Background') : h('span', { class: 'muted small' }, 'Theme default')),
          h('div', { class: 'cs-row' }, h('label', { class: 'cs-check cs-label' }, gridOn, h('span', null, 'Custom grid colour')), st().gridColor ? swatch('gridColor', st().gridColor, 'Grid') : h('span', { class: 'muted small' }, 'Theme default')),
          select('fontSize', 'Text size', [[10, '10'], [11, '11'], [12, '12'], [13, '13'], [14, '14'], [16, '16']]),
        ];
      }],
      trading: ['Trading', 'long', () => [
        heading('Bar Replay trading'),
        check('showTradeLines', 'Positions and orders on the chart'),
        check('showQuickTrade', 'Buy / sell buttons'),
        check('showOrderPlus', '"+" order button on the price scale'),
      ]],
      alerts: ['Alerts', 'sparkle', () => [
        heading('Indicator alerts'),
        check('alertPopups', 'Show pop-up alerts on new signals'),
        check('alertSound', 'Play a sound'),
      ]],
      events: ['Events', 'calendar', () => [
        heading('On the chart'),
        check('showTradeMarkers', 'Trade markers (Strategy Tester and replay trades)'),
        check('showSignals', 'Indicator signal markers (long / short labels)'),
        heading('Economic events'),
        check('showEconEvents', 'High-impact news for the symbol\'s currencies (dots under the bars)'),
        check('econMedium', 'Include medium-impact events'),
      ]],
    };

    const templates = () => this.settings.chartTemplates || {};
    const templateSel = () => {
      const s = h('select', { class: 'cs-template' },
        h('option', { value: '' }, 'Template'),
        h('option', { value: '__save' }, 'Save as template…'),
        ...Object.keys(templates()).map(n => h('option', { value: n }, `Apply “${n}”`)),
        h('option', { value: '__default' }, 'Apply defaults'));
      s.addEventListener('change', async () => {
        const v = s.value;
        s.value = '';
        if (v === '__save') {
          this.prompt('Template name', 'My chart style', name => {
            if (!name) return;
            this.settings.chartTemplates = { ...templates(), [name]: { ...chartStyle() } };
            this.saveSettings(); toast(`Template “${name}” saved`); render();
          });
        } else if (v === '__default') set({ ...DEFAULT_STYLE });
        else if (v) set({ ...DEFAULT_STYLE, ...templates()[v] });
      });
      return s;
    };

    const close = keep => {
      if (!keep) this.updateChartStyle(snapshot);
      $('#popover').hidden = true;
      modal.hidden = true;
      this.settingsSection = current;
    };

    const render = () => {
      body.replaceChildren(h('div', { class: 'cs' },
        h('nav', { class: 'cs-nav' }, Object.entries(SECTIONS).map(([k, [label, ic]]) => h('button', {
          class: 'cs-tab' + (k === current ? ' active' : ''), onclick: () => { current = k; render(); },
        }, icon(ic), label))),
        h('div', { class: 'cs-body' }, SECTIONS[current][2]())),
        h('div', { class: 'cs-foot' }, templateSel(), h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => close(true) }, 'Ok')),
        h('div', { class: 'about cs-about' }, h('b', null, 'ChartDesk'), ' · ',
          // Attribution required by the Lightweight Charts licence (shown here instead of a logo on every chart).
          h('span', { class: 'muted' }, 'Charts: TradingView Lightweight Charts™ Copyright © TradingView, Inc. ',
            h('a', { href: 'https://www.tradingview.com/', target: '_blank', rel: 'noopener' }, 'tradingview.com'), ' (Apache-2.0).')));
    };
    render();
    modal.querySelector('.dlg-head .x')?.setAttribute('data-cancel', '');
    // the × and clicks outside behave like Cancel
    if (!modal.dataset.csWired) {
      modal.dataset.csWired = '1';
      modal.addEventListener('mousedown', e => { if (e.target === modal || e.target.closest('.dlg-head .x')) { e.stopImmediatePropagation(); this.closeChartSettings?.(); } }, true);
    }
    this.closeChartSettings = () => close(false);
    modal.hidden = false;
  }

  /** Box size / reversal / lines for Renko, Kagi, Point & figure, Line break and Range charts. */
  openTypeSettings(view, t, anchor) {
    const pop = $('#popover');
    pop.className = 'popover';
    const def = PRICE_TYPES[t];
    const render = () => {
      const cur = { ...def, ...(view.cfg.typeOpts?.[t] || {}) };
      const set = patch => { view.setTypeOptions(t, patch); render(); };
      const num = (key, label, min, step = 'any') => {
        const i = h('input', { type: 'number', value: cur[key] || '', step, min });
        i.addEventListener('change', () => { const x = parseFloat(i.value); if (Number.isFinite(x) && x >= min && x > 0) set({ [key]: x }); else i.value = cur[key] || ''; });
        return h('label', null, label, i);
      };
      const sel = (key, label, options, onPick) => {
        const s = h('select', null, options.map(([v, l]) => h('option', { value: v }, l)));
        s.value = cur[key];
        s.addEventListener('change', () => set(onPick ? onPick(s.value) : { [key]: s.value }));
        return h('label', null, label, s);
      };
      const rows = [h('h4', null, `${def.label} settings`)];
      const live = view.cfg.chartType === t ? view.typeInfo?.box : null;
      if (t === 'linebreak') rows.push(num('lines', 'Number of lines', 1, 1));
      else {
        const what = t === 'kagi' ? 'Reversal amount' : t === 'range' ? 'Range' : 'Box size';
        rows.push(sel('method', `${what} from`, [['atr', 'ATR (automatic)'], ['fixed', 'Fixed price'], ...(t === 'range' ? [] : [['pct', 'Percent of price']])],
          m => ({ method: m, value: m === 'fixed' ? cur.value || live || 0 : m === 'pct' ? (cur.method === 'pct' ? cur.value : 1) : cur.value })));
        if (cur.method === 'atr' || !cur.method) rows.push(num('atrLength', 'ATR length', 2, 1));
        else rows.push(num('value', cur.method === 'pct' ? `${what} (%)` : what, 0));
        if (t === 'pnf') rows.push(num('reversal', 'Reversal (boxes)', 1, 1));
        if (t === 'renko') rows.push(sel('source', 'Source', [['close', 'Close'], ['hl', 'High / low']]));
        if (live) rows.push(h('p', { class: 'muted small' }, `In use: ${fmtPrice(live, view.prec)}`));
      }
      rows.push(h('p', { class: 'muted small' }, t === 'pnf' ? 'X columns rise, O columns fall; a new column needs the reversal number of boxes.'
        : t === 'kagi' ? 'Thick (green) lines: price broke above the previous shoulder; thin (red): below the previous waist.'
          : t === 'linebreak' ? 'A new line on each new closing high/low; a reversal must break the last lines.'
            : t === 'range' ? 'Each bar covers exactly the range from high to low, however long that takes.'
              : 'A box forms when price closes a full box beyond the last one; reversals need two boxes.'));
      pop.replaceChildren(...rows);
    };
    render();
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.right + 6, 8, window.innerWidth - 260)}px`;
    pop.style.top = `${clamp(r.top - 8, 8, window.innerHeight - 320)}px`;
    pop.hidden = false;
  }

  toggleAssistant(open = !this.settings.assistantOpen) {
    this.settings.assistantOpen = open;
    this.saveSettings();
    $('#assistant').hidden = !open;
    $('#askBtn').classList.toggle('active', open);
    if (open) this.assistant.focus();
  }
  applyWlOpen() {
    const wl = $('#watchlist');
    wl.classList.toggle('closed', !this.settings.wlOpen);
    if (this.settings.wlWidth) wl.style.width = `${this.settings.wlWidth}px`;
    $('#wlToggle').classList.toggle('active', !!this.settings.wlOpen);
  }
  /** Show/hide the watchlist panel (the chart takes the freed space). */
  toggleWatchlist(open = !this.settings.wlOpen) {
    this.settings.wlOpen = open;
    this.saveSettings();
    this.applyWlOpen();
  }
  wireWlResizer() {
    const handle = $('#wlResizer'), wl = $('#watchlist');
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const startX = e.clientX, startW = wl.offsetWidth;
      document.body.classList.add('resizing-x');
      const move = ev => { wl.style.width = `${clamp(startW - (ev.clientX - startX), 240, Math.min(620, window.innerWidth * 0.5))}px`; };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing-x');
        this.settings.wlWidth = wl.offsetWidth; this.saveSettings();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => { wl.style.width = ''; this.settings.wlWidth = null; this.saveSettings(); });
  }

  // ---------------------------------------------------------------- dialogs
  openDataManager(symbol) { this.dataManager.open(symbol); }

  openSymbolSearch(mode = 'open', initial = '') {
    this.symMode = mode;
    $('#symTitle').textContent = mode === 'add' ? 'Add symbol to watchlist' : mode === 'compare' ? `Compare ${this.activeView?.symbol || ''} with…` : 'Symbol Search';
    openModal($('#symModal'));
    const inp = $('#symInput');
    inp.value = initial;
    this.symSel = 0;
    this.symFilter = this.symFilter || 'all';
    this.renderSymList();
    inp.focus();
  }
  renderSymList() {
    const q = $('#symInput').value.trim().toUpperCase();
    const markets = ['all', ...new Set(SYMBOLS.map(s => s.market))];
    $('#symFilters').replaceChildren(...markets.map(m => h('button', { class: 'chip' + (this.symFilter === m ? ' active' : ''), onclick: () => { this.symFilter = m; this.renderSymList(); $('#symInput').focus(); } }, m === 'all' ? 'All' : m)));
    const items = SYMBOLS.filter(s => (this.symFilter === 'all' || s.market === this.symFilter) && (!q || s.symbol.includes(q) || s.name.toUpperCase().includes(q)));
    this.symItems = items;
    this.symSel = clamp(this.symSel, 0, Math.max(0, items.length - 1));
    this.renderBinanceMatches(q, items);
    setTimeout(() => this.renderTdLookup(q), 0);
    clearTimeout(this.tvSearchTimer);
    if (q.length >= 2) this.tvSearchTimer = setTimeout(() => this.renderTvMatches(q), 250);
    $('#symList').replaceChildren(...(items.length ? items.map((s, i) => h('div', {
      class: 'dlg-item' + (i === this.symSel ? ' sel' : ''), onclick: () => this.chooseSymbol(s.symbol),
      onmouseenter: () => { this.symSel = i; $$('#symList .dlg-item').forEach((r, j) => r.classList.toggle('sel', j === i)); },
    }, coin(s.symbol), h('span', { class: 'nm' }, s.symbol), h('span', { class: 'ds' }, s.name),
      h('span', { class: 'tag' }, `${s.market} · ${providerLabel(s.provider)}`),
      s.provider === 'dukascopy' ? h('span', { class: 'cov' + (s.coverage?.months ? '' : ' none') }, s.coverage?.months ? `data to ${fmtDate(s.coverage.last)}` : 'no data yet')
        : s.provider === 'twelvedata' ? h('span', { class: 'cov' + (s.tdConfigured ? '' : ' none') }, s.tdConfigured ? (s.tdCoverage?.rows ? `cached to ${fmtDate(s.tdCoverage.last)}` : 'API') : 'no API key')
        : h('span', { class: 'cov live' }, 'live')))
      : [h('div', { class: 'dlg-empty' }, 'No symbols match your search')]));
  }
  /** Symbol search: every market on TradingView (stocks, crypto, futures, indices, forex, bonds…); a pick is added and charted. */
  async renderTvMatches(q) {
    let list;
    try { list = await api(`/api/tv/search?q=${encodeURIComponent(q)}`); } catch { return; }
    if ($('#symInput').value.trim().toUpperCase() !== q || $('#symList .tv-sec')) return;
    const have = new Set(SYMBOLS.map(s => s.symbol));
    const rows = list.filter(m => !have.has(m.id)).slice(0, 30);
    if (!rows.length) return;
    $$('#symList .dlg-empty').forEach(x => x.remove());
    $('#symList').append(h('div', { class: 'dlg-section tv-sec' }, 'All markets on TradingView'), ...rows.map(m => {
      const row = h('div', { class: 'dlg-item', onclick: async () => {
        row.querySelector('.ds').textContent = 'Adding…';
        try {
          const r = await api('/api/symbols/tv', { method: 'POST', body: m });
          await loadSymbols();
          this.chooseSymbol(r.symbol);
        } catch (e) { row.querySelector('.ds').textContent = e.message; }
      } }, coin(m.symbol || m.id), h('span', { class: 'nm' }, m.symbol), h('span', { class: 'ds' }, `${m.description || ''}`),
        h('span', { class: 'tag' }, `${m.type || 'market'} · ${m.exchange}`), h('span', { class: 'cov live' }, 'TradingView'));
      return row;
    }));
  }
  /** Symbol search: look a ticker up on Twelve Data (US stocks, ETFs…) and add it to the symbol list. */
  renderTdLookup(q) {
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(q) || spec(q) || (this.symFilter !== 'all' && !['Stocks', 'ETFs'].includes(this.symFilter))) return;
    if ($('#symInput').value.trim().toUpperCase() !== q || $('#symList .td-lookup')) return;
    const row = h('div', { class: 'dlg-item td-lookup', onclick: async () => {
      row.querySelector('.ds').textContent = 'Looking up on Twelve Data…';
      try {
        const r = await api('/api/symbols/td', { method: 'POST', body: { ticker: q } });
        await loadSymbols();
        toast(`${r.symbol} added: ${r.name}`);
        this.chooseSymbol(r.symbol);
      } catch (e) { row.querySelector('.ds').textContent = e.message; }
    } }, coin(q), h('span', { class: 'nm' }, q), h('span', { class: 'ds' }, 'Find this stock / ETF on Twelve Data (uses an API credit) and add it'), h('span', { class: 'tag' }, 'Stocks · Twelve Data'));
    $('#symList').append(h('div', { class: 'dlg-section' }, 'Stocks & ETFs'), row);
  }
  /** Symbol search: Binance pairs that aren't in the list yet (any spot pair can be charted). */
  async renderBinanceMatches(q, items) {
    if (q.length < 2 || (this.symFilter !== 'all' && this.symFilter !== 'Crypto')) return;
    let pairs;
    try { pairs = await binancePairs(); } catch { return; }
    if ($('#symInput').value.trim().toUpperCase() !== q) return;
    const have = new Set(SYMBOLS.map(s => s.symbol));
    const extra = pairs.filter(p => !have.has(p) && p.includes(q)).sort((a, b) => (a.startsWith(q) ? 0 : 1) - (b.startsWith(q) ? 0 : 1) || a.length - b.length).slice(0, 25);
    if (!extra.length) return;
    $$('#symList .dlg-empty').forEach(x => x.remove()); // keep other sections (Stocks & ETFs lookup)
    $('#symList').append(h('div', { class: 'dlg-section' }, 'More Binance pairs'), ...extra.map(p => h('div', { class: 'dlg-item', onclick: () => { registerBinanceSymbol(p); this.chooseSymbol(p); } },
      coin(p), h('span', { class: 'nm' }, p), h('span', { class: 'ds' }, 'Binance spot'), h('span', { class: 'tag' }, 'Crypto · Binance'), h('span', { class: 'cov live' }, 'live'))));
  }
  chooseSymbol(s) {
    closeModals();
    if (this.symMode === 'add') this.watchlist.add(s);
    else if (this.symMode === 'compare') { this.activeView.addCompare(s); this.refreshToolbar(); }
    else this.activeView.setSymbol(s);
  }

  openIndicators() {
    openModal($('#indModal'));
    $('#indInput').value = '';
    this.renderIndList();
    $('#indInput').focus();
  }
  renderIndList() {
    const q = $('#indInput').value.trim().toLowerCase();
    const item = ([k, d]) => h('div', { class: 'dlg-item', onclick: () => this.activeView.addIndicator(k) }, h('span', { class: 'nm wide' }, d.name), h('span', { class: 'ds' }, d.desc), h('span', { class: 'tag' }, d.pane ? 'new pane' : 'on chart'));
    const rows = IND_CATEGORIES.flatMap(cat => {
      const list = Object.entries(IND_DEFS).filter(([k, d]) => d.cat === cat && (!q || `${k} ${d.name} ${d.short} ${d.cat}`.toLowerCase().includes(q)));
      return list.length ? [h('div', { class: 'dlg-sub' }, cat), ...list.map(item)] : [];
    });
    const tpl = this.settings.indTemplates || {}, view = this.activeView;
    const tplName = i => (i.type === 'SCRIPT' ? listScripts().find(s => s.id === i.scriptId)?.name || 'script' : IND_DEFS[i.type]?.short || i.type);
    const templates = [
      ...Object.keys(tpl).filter(n => !q || n.toLowerCase().includes(q)).map(name => h('div', { class: 'dlg-item', onclick: () => this.applyIndTemplate(name) },
        h('span', { class: 'nm wide' }, name), h('span', { class: 'ds' }, tpl[name].map(tplName).join(', ')),
        h('button', { class: 'tag', title: `Delete template “${name}”`, onclick: e => { e.stopPropagation(); delete tpl[name]; this.saveSettings(); this.renderIndList(); } }, '✕'))),
      q ? null : h('div', { class: 'dlg-item', onclick: () => this.saveIndTemplate() }, h('span', { class: 'nm wide' }, '＋ Save current indicators as a template…'),
        h('span', { class: 'ds' }, `${view.cfg.indicators.length} on ${view.symbol} · ${tfLabel(view.cfg.tf)}`)),
    ].filter(Boolean);
    const mine = listScripts().filter(sc => sc.meta && (!q || sc.name.toLowerCase().includes(q)))
      .map(sc => h('div', { class: 'dlg-item', onclick: () => this.activeView.addScriptIndicator(sc.id) }, h('span', { class: 'nm wide' }, sc.name), h('span', { class: 'ds' }, 'Custom script'), h('span', { class: 'tag' }, sc.meta.overlay ? 'on chart' : 'new pane')));
    const lib = LIBRARY.filter(it => !listScripts().some(sc => sc.id === it.id && sc.meta) && (!q || `${it.name} ${it.author}`.toLowerCase().includes(q)))
      .map(it => h('div', { class: 'dlg-item', onclick: () => this.addLibraryScript(it) }, h('span', { class: 'nm wide' }, it.name), h('span', { class: 'ds' }, `${it.desc} · by ${it.author}`), h('span', { class: 'tag' }, 'Pine')));
    $('#indList').replaceChildren(
      ...(templates.length ? [h('div', { class: 'dlg-section' }, 'Indicator templates'), ...templates] : []),
      h('div', { class: 'dlg-section' }, `Built-in indicators · add to ${this.activeView.symbol} · ${tfLabel(this.activeView.cfg.tf)}`), ...(rows.length ? rows : [h('div', { class: 'dlg-empty' }, 'Nothing found')]),
      h('div', { class: 'dlg-section' }, 'My scripts'), ...mine,
      ...(lib.length ? [h('div', { class: 'dlg-section' }, 'Community scripts'), ...lib] : []),
      h('div', { class: 'dlg-item', onclick: () => { closeModals(); this.showPanel('scripts'); } }, h('span', { class: 'nm wide' }, '＋ Write a script indicator…'), h('span', { class: 'ds' }, 'Opens the Script editor')));
  }

  /** Indicator templates: a named set of indicators (with their settings) to put on any chart in one click. */
  saveIndTemplate() {
    const view = this.activeView;
    if (!view.cfg.indicators.length) { toast('Add some indicators first'); return; }
    this.prompt('Template name', '', name => {
      if (!name) return;
      this.settings.indTemplates = { ...(this.settings.indTemplates || {}), [name]: view.cfg.indicators.map(({ id, ...rest }) => structuredClone(rest)) };
      this.saveSettings();
      toast(`Template “${name}” saved (${view.cfg.indicators.length} indicators)`);
      if (!$('#indModal').hidden) this.renderIndList();
    });
  }
  applyIndTemplate(name) {
    const view = this.activeView, tpl = this.settings.indTemplates?.[name];
    if (!tpl) return;
    view.cfg.indicators = tpl.map(i => ({ ...structuredClone(i), id: uid() }));
    this.onViewChanged(view);
    view.rebuildAll();
    closeModals();
    toast(`Applied template “${name}”`);
  }

  /** Script alert conditions: pop up events confirmed on a new candle (live or Bar Replay), never history. */
  scriptAlerts(view, rt) {
    const last = view.bars[view.bars.length - 1]?.time;
    const seen = (this.alertSeen ||= new Map());
    const key = `${view.cfg.symbol}|${view.cfg.tf}|${rt.ind.id}`;
    const prev = seen.get(key);
    seen.set(key, last);
    if (prev == null || last == null || last <= prev || rt.ind.alerts === false || chartStyle().alertPopups === false) return;
    const fresh = rt.alerts.filter(a => a.time > prev);
    if (fresh.length && chartStyle().alertSound) beep();
    for (const a of fresh.slice(-3)) {
      // alert() messages carry their own text; alertcondition events show their title and the price
      const text = a.event === 'Alert' && a.message ? `${a.symbol} ${tfLabel(a.tf)} · ${a.message}` : `${a.symbol} ${tfLabel(a.tf)} · ${a.event} @ ${fmtPrice(a.price, view.prec)}`;
      // Signals that state their levels ("LONG … stop X · target Y") can be traded in one click during Bar Replay.
      const m = /^(LONG|SHORT)\b.*?stop\s+([\d.,]+).*?target\s+([\d.,]+)/i.exec(a.message || '');
      const tradable = m && this.replay.active && this.replay.symbol === view.symbol;
      toast(text, '', tradable ? [{ label: 'Place trade', onClick: () => this.trading.placeSignal(m[1].toLowerCase() === 'long' ? 'buy' : 'sell', Number(m[2].replace(/,/g, '')), Number(m[3].replace(/,/g, ''))) }] : []);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`ChartDesk · ${defOf(rt.ind).name}`, { body: `${text}${a.message && a.message !== a.event ? ` — ${a.message}` : ''}` });
    }
  }

  async addLibraryScript(item) {
    const view = this.activeView;
    if (!view?.bars?.length) { toast('Open a chart with candles first', 'error'); return; }
    closeModals();
    toast(`Loading ${item.name}…`);
    try {
      const sc = await installLibraryScript(item, view.bars, view.scriptCtx());
      view.addScriptIndicator(sc.id);
      this.scriptEditor.render();
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Settings for Pine script indicators: grouped, searchable, with every input kind (numbers, toggles, lists, colours, sources). */
  openPineSettings(view, ind, def, anchor) {
    const pop = $('#popover');
    pop.classList.add('script-settings');
    const specs = def.script.meta.inputs;
    let timer = null;
    const changed = () => { view.app.onViewChanged(view); clearTimeout(timer); timer = setTimeout(() => view.refreshIndicators(), 250); };
    const valueOf = sp => (ind.params[sp.name] ?? sp.def);
    const control = sp => {
      const v = valueOf(sp);
      const set = x => { ind.params[sp.name] = x; changed(); };
      if (sp.bool) { const c = h('input', { type: 'checkbox' }); c.checked = !!Number(v) || v === true; c.addEventListener('change', () => set(c.checked ? 1 : 0)); return c; }
      if (sp.options) {
        const sel = h('select', null, sp.options.map(o => h('option', { value: String(o) }, String(o) === '' ? (sp.kind === 'timeframe' ? 'Chart' : '—') : String(o))));
        sel.value = String(v);
        sel.addEventListener('change', () => set(sp.kind === 'int' || sp.kind === 'float' ? Number(sel.value) : sel.value));
        return sel;
      }
      if (sp.kind === 'color') {
        const c = h('input', { type: 'color', value: String(v).slice(0, 7) });
        c.addEventListener('change', () => set(c.value + String(v).slice(7, 9)));
        return c;
      }
      if (sp.kind === 'int' || sp.kind === 'float' || sp.kind === 'price') {
        const inp = h('input', { type: 'number', value: v, min: sp.min ?? undefined, max: sp.max ?? undefined, step: sp.step ?? 'any' });
        inp.addEventListener('change', () => {
          const x = parseFloat(inp.value);
          if (!Number.isFinite(x) || (sp.min != null && x < sp.min) || (sp.max != null && x > sp.max)) { inp.value = valueOf(sp); return; }
          set(sp.kind === 'int' ? Math.round(x) : x);
        });
        return inp;
      }
      const t = h('input', { type: 'text', value: String(v) });
      t.addEventListener('change', () => set(t.value));
      return t;
    };
    // Group → rows (inputs sharing an `inline` id sit on one row, like in Pine's settings dialog).
    const groups = [];
    for (const sp of specs) {
      let g = groups[groups.length - 1];
      if (!g || g.name !== (sp.group || '')) { g = groups.find(x => x.name === (sp.group || '')) || null; if (!g) { g = { name: sp.group || '', rows: [] }; groups.push(g); } }
      const last = g.rows[g.rows.length - 1];
      if (sp.inline && last && last.inline === sp.inline) last.items.push(sp);
      else g.rows.push({ inline: sp.inline, items: [sp] });
    }
    const rowEl = r => {
      const label = r.items.find(x => x.label)?.label || r.items[0].name.replace(/ · L\d+.*$/, '');
      return h('div', { class: 'ss-row', title: r.items.map(x => x.tooltip).filter(Boolean).join(' — ').slice(0, 600), 'data-q': `${label} ${r.items.map(x => x.label).join(' ')}`.toLowerCase() },
        h('span', { class: 'ss-label' }, label), h('span', { class: 'ss-ctrls' }, r.items.map(control)));
    };
    const body = h('div', { class: 'ss-body' }, groups.map((g, k) => h('details', { class: 'ss-group', open: k < 3 || /main indicator|setup/i.test(g.name) },
      h('summary', null, g.name || 'Inputs', h('small', { class: 'muted' }, ` ${g.rows.length}`)), g.rows.map(rowEl))));
    const search = h('input', { type: 'search', class: 'ss-search', placeholder: `Search ${specs.length} settings…` });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const d of body.querySelectorAll('.ss-group')) {
        let any = false;
        for (const r of d.querySelectorAll('.ss-row')) { const ok = !q || r.dataset.q.includes(q) || d.querySelector('summary').textContent.toLowerCase().includes(q); r.hidden = !ok; any ||= ok; }
        d.hidden = !any;
        if (q) d.open = any;
      }
    });
    const rtNow = view.runtimes.find(r => r.ind.id === ind.id);
    const warn = rtNow?.warnings || [];
    const alertsList = (rtNow?.alerts || []).slice(-30).reverse();
    const notify = h('input', { type: 'checkbox' });
    notify.checked = ind.alerts !== false;
    notify.addEventListener('change', () => {
      ind.alerts = notify.checked;
      view.app.onViewChanged(view);
      if (notify.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    });
    fill(pop, h('h4', null, def.name), search, body,
      h('details', { class: 'ss-warn' }, h('summary', null, `🔔 Alerts (${rtNow?.alerts?.length || 0} on this chart)`),
        h('label', { class: 'ss-row' }, h('span', { class: 'ss-label' }, 'Pop up new alerts (live & Bar Replay)'), notify),
        alertsList.length ? h('ul', { class: 'ss-alerts' }, alertsList.map(a => h('li', null, h('b', null, a.event), ` @ ${fmtPrice(a.price, view.prec)} · ${fmtDate(a.time)} ${new Date(a.time * 1000).toISOString().slice(11, 16)} UTC`)))
          : h('p', { class: 'muted small' }, 'No alert conditions fired on the loaded candles.')),
      warn.length ? h('details', { class: 'ss-warn' }, h('summary', null, `⚠ ${warn.length} note(s) about this script`), h('ul', null, warn.map(w => h('li', null, w)))) : null,
      h('div', { class: 'ss-actions' },
        h('button', { class: 'btn small', onclick: () => { for (const sp of specs) ind.params[sp.name] = sp.def; view.app.onViewChanged(view); view.refreshIndicators(); this.openPineSettings(view, ind, def, anchor); } }, 'Reset to defaults'),
        h('button', { class: 'btn small', onclick: () => { this.closePopovers(); this.showPanel('scripts'); this.scriptEditor.select(ind.scriptId); } }, 'Edit script')));
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, window.innerWidth - 376)}px`;
    pop.style.top = `${clamp(r.bottom + 6, 8, window.innerHeight - 200)}px`;
    pop.hidden = false;
  }

  openIndicatorSettings(view, ind, anchor) {
    const pop = $('#popover');
    pop.classList.remove('script-settings');
    const def = defOf(ind);
    if (ind.type === 'SCRIPT' && def.script?.meta?.lang === 'pine') return this.openPineSettings(view, ind, def, anchor);
    const apply = () => { view.app.onViewChanged(view); view.rebuildAll(); };
    const inputDefs = ind.type === 'SCRIPT' ? (def.script?.meta?.inputs || []) : [];
    const LABELS = { mult: 'Multiplier', atr: 'ATR length', spanB: 'Leading span B', di: 'DI length', adx: 'ADX smoothing', inc: 'Increment', max: 'Maximum', rows: 'Rows',
      va: 'Value area %', rsi: 'RSI length', stoch: 'Stochastic length', conversion: 'Conversion line', base: 'Base line', displacement: 'Displacement', k: '%K length', d: '%D smoothing', smooth: '%K smoothing' };
    const fields = Object.entries(ind.params).map(([k, v]) => {
      const sd = inputDefs.find(x => x.name === k);
      const label = LABELS[k] || k[0].toUpperCase() + k.slice(1);
      if (def.choices?.[k]) {
        const s = h('select', null, def.choices[k].map(([val, l]) => h('option', { value: val }, l)));
        s.value = v;
        s.addEventListener('change', () => { ind.params[k] = s.value; apply(); });
        return h('label', null, label, s);
      }
      const step = def.steps?.[k];
      const inp = sd
        ? h('input', { type: 'number', value: v, min: sd.min ?? undefined, max: sd.max ?? undefined, step: sd.step ?? 'any' })
        : h('input', { type: 'number', value: v, min: step || 1, step: step || 1 });
      inp.addEventListener('change', () => {
        const n = parseFloat(inp.value);
        if (sd) {
          if (!Number.isFinite(n) || (sd.min != null && n < sd.min) || (sd.max != null && n > sd.max)) { inp.value = ind.params[k]; return; }
          ind.params[k] = n;
          view.app.onViewChanged(view);
          view.refreshIndicators();
          return;
        }
        if (!Number.isFinite(n) || n <= 0) { inp.value = ind.params[k]; return; }
        ind.params[k] = step ? n : Math.round(n);
        apply();
      });
      return h('label', null, label, inp);
    });
    if (ind.type === 'SCRIPT') {
      fields.push(h('button', { class: 'btn small', onclick: () => { this.closePopovers(); this.showPanel('scripts'); this.scriptEditor.select(ind.scriptId); } }, 'Edit script'));
    } else {
      const c = h('input', { type: 'color', value: ind.color || '#2962ff' });
      c.addEventListener('change', () => { ind.color = c.value; apply(); });
      fields.push(h('label', null, 'Colour', c));
    }
    pop.replaceChildren(h('h4', null, def.name), ...fields);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, window.innerWidth - 256)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.hidden = false;
  }

  /** Small text prompt modal. `multiline` uses a textarea. */
  prompt(title, value, onOk, multiline = false, onCancel = null) {
    const m = $('#promptModal');
    $('#promptTitle').textContent = title;
    const input = multiline ? h('textarea', { rows: 4 }) : h('input', { type: 'text' });
    input.value = value || '';
    const done = ok => {
      m.hidden = true;
      if (ok) onOk(input.value.trim() === '' && !multiline ? '' : input.value);
      else onCancel?.();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    $('#promptBody').replaceChildren(input, h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => done(true) }, 'OK')));
    openModal(m);
    setTimeout(() => { input.focus(); input.select?.(); }, 0);
  }

  // ---------------------------------------------------------------- keyboard
  wireKeyboard() {
    $('#symInput').addEventListener('input', () => { this.symSel = 0; this.renderSymList(); });
    $('#symInput').addEventListener('keydown', e => {
      const n = this.symItems?.length || 0;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.symSel = Math.min(n - 1, this.symSel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.symSel = Math.max(0, this.symSel - 1); }
      else if (e.key === 'Enter') {
        const q = e.target.value.trim().toUpperCase();
        const pick = this.symItems?.[this.symSel]?.symbol || (spec(q) ? q : null);
        if (pick) this.chooseSymbol(pick); else toast(`Unknown symbol ${q}`, 'error');
        return;
      } else return;
      $$('#symList .dlg-item').forEach((r, j) => r.classList.toggle('sel', j === this.symSel));
      $$('#symList .dlg-item')[this.symSel]?.scrollIntoView({ block: 'nearest' });
    });
    $('#indInput').addEventListener('input', () => this.renderIndList());

    document.addEventListener('keydown', e => {
      const typing = e.target.matches('input, textarea, select');
      const modalOpen = $$('.modal').some(m => !m.hidden);
      if (e.key === 'Escape') {
        if (modalOpen) { closeModals(); return; }
        this.closePopovers();
        if (this.replay.selecting) { this.replay.cancelSelect(); return; }
        for (const v of this.views) v.cancelInteraction();
        this.setTool('cursor');
        return;
      }
      if (typing || modalOpen) return;
      const v = this.activeView;
      if (this.replay.active && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); this.replay.stepForward(); return; }
      if (this.replay.active && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); this.replay.stepBack(); return; }
      if (this.replay.active && e.key === ' ') { e.preventDefault(); this.replay.togglePlay(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && v?.selected) { e.preventDefault(); v.removeDrawing(v.selected); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undoDrawings(); return; }
      if (e.key === 'Enter' && v?.pending?.type === 'path') { e.preventDefault(); v.finalizePending(); return; }
      // every other shortcut comes from the command list (Ctrl+/ to see and change them)
      const combo = comboOf(e), cmd = this.commands?.forCombo(combo);
      if (cmd && (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || /^F\d+$/.test(combo))) { e.preventDefault(); cmd.run(); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key)) { e.preventDefault(); this.openIntervalBox(e.key); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z]$/i.test(e.key)) {
        e.preventDefault();
        this.openSymbolSearch('open', e.key.toUpperCase());
      }
    });
  }
}

const app = new App();
window.ChartDesk = app; // handy from devtools
app.boot();
