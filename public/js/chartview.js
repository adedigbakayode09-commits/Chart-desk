// One chart in the layout: data loading, panes, indicators, drawings, replay clamping and trade overlays.

import { h, icon, uid, clamp, toast, FONT, UP, DOWN, ACCENT, PALETTE, fmtPrice, fmtNum, fmtVol, fmtSigned, fmtPct, fmtUsd, fmtDateTime, fmtDate, fill } from './util.js';
import { fetchBars, subscribeLive, rangeOhlc, spec, tfSec, tfLabel, precisionOf, providerLabel } from './data.js';
import { transform as priceTransform, isPriceType, PRICE_TYPES } from './core/charttypes.js';
import { IND_DEFS, indTitle, calc, seriesSpecs, defOf, PRICE_OUTPUTS, breakGaps } from './indicators-ui.js';
import { getScript, runScript, upsertScript, metaFromResult } from './scripts.js';
import { renderScriptOutput } from './script-render.js';
import { renderDrawing, hitDrawing, dragDrawing, cloneDrawing, ONE_CLICK, pointsOf, toolTitle, HAS_TEXT, FILLABLE, LINE_LIKE, ICON_CHOICES } from './drawings.js';
import { atr, volumeProfile } from './core/indicators.js';
import { chartStyle, candleColors, alpha, fmtChartTime } from './chartstyle.js';
import { quoteToUsd } from './core/broker.js';
import { DRAWING_ALERT_TYPES } from './core/alerts.js';

const LC = window.LightweightCharts;

export const CHART_TYPES = [
  { k: 'bars', label: 'Bars', icon: 'bars' },
  { k: 'candles', label: 'Candles', icon: 'candles' },
  { k: 'hollow', label: 'Hollow candles', icon: 'hollow' },
  { k: 'ha', label: 'Heikin Ashi', icon: 'candles' },
  { k: 'columns', label: 'Columns', icon: 'columns' },
  { k: 'highlow', label: 'High-low', icon: 'highlow' },
  { k: 'line', label: 'Line', icon: 'line' },
  { k: 'linemarkers', label: 'Line with markers', icon: 'linemarkers' },
  { k: 'step', label: 'Step line', icon: 'step' },
  { k: 'area', label: 'Area', icon: 'area' },
  { k: 'baseline', label: 'Baseline', icon: 'baseline' },
  // price-based: built from the candles, time is no longer evenly spaced
  { k: 'renko', label: 'Renko', icon: 'renko', price: true },
  { k: 'linebreak', label: 'Line break', icon: 'linebreak', price: true },
  { k: 'kagi', label: 'Kagi', icon: 'kagi', price: true },
  { k: 'pnf', label: 'Point & figure', icon: 'pnf', price: true },
  { k: 'range', label: 'Range', icon: 'rangebars', price: true },
];
const COMPARE_COLORS = ['#ff9800', '#e91e63', '#00bcd4', '#ab47bc', '#4caf50', '#fdd835', '#8d6e63'];

export function themeColors(theme) {
  const st = chartStyle();
  const base = theme === 'dark'
    ? { bg: '#131722', text: '#d1d4dc', grid: 'rgba(240,243,250,0.06)', border: '#2a2e39', cross: '#9598a1', label: '#363a45' }
    : { bg: '#ffffff', text: '#131722', grid: 'rgba(42,46,57,0.06)', border: '#e0e3eb', cross: '#9598a1', label: '#131722' };
  if (st.bg) base.bg = st.bg;
  if (st.gridColor) base.grid = st.gridColor;
  if (!st.grid) base.grid = 'rgba(0,0,0,0)';
  return base;
}
function chartOptions(theme) {
  const c = themeColors(theme), st = chartStyle();
  const hidden = st.crosshair === 'hidden';
  const line = { color: c.cross, width: 1, style: LC.LineStyle.LargeDashed, labelBackgroundColor: c.label, visible: !hidden, labelVisible: !hidden };
  // time axis and crosshair label in the chosen display timezone
  const tick = (t, type) => fmtChartTime(t, ['year', 'month', 'day', 'time', 'seconds'][type] || 'time');
  return {
    layout: { background: { type: LC.ColorType.Solid, color: c.bg }, textColor: c.text, fontSize: Number(st.fontSize) || 12, fontFamily: FONT, attributionLogo: false },
    grid: { vertLines: { color: c.grid, visible: st.gridV !== false }, horzLines: { color: c.grid, visible: st.gridH !== false } },
    crosshair: { mode: st.crosshair === 'magnet' ? LC.CrosshairMode.Magnet : LC.CrosshairMode.Normal, vertLine: { ...line }, horzLine: { ...line } },
    rightPriceScale: { borderColor: c.border, borderVisible: false, minimumWidth: 78 },
    timeScale: { borderColor: c.border, borderVisible: false, tickMarkFormatter: (t, type) => tick(t, type) },
    localization: { timeFormatter: t => fmtChartTime(t, 'full') },
  };
}

function heikinAshi(prev, b) {
  const close = (b.open + b.high + b.low + b.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
  return { time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close };
}

export class ChartView {
  constructor(app, host, cfg) {
    this.app = app;
    this.id = uid();
    this.cfg = {
      symbol: cfg.symbol || 'XAUUSD', tf: cfg.tf || '1h', chartType: cfg.chartType || 'candles',
      indicators: cfg.indicators || [{ id: uid(), type: 'VOL', params: {}, visible: true }],
      scaleMode: cfg.scaleMode || 0,
      typeOpts: cfg.typeOpts || {}, compare: cfg.compare || [],
    };
    this.all = [];
    this.bars = [];
    this.ha = [];
    this.runtimes = [];
    this.hoverIdx = null;
    this.selected = null;
    this.pending = null;
    this.measure = null;
    this.drag = null;
    this.mouse = null;
    this.markers = [];
    this.loadToken = 0;
    this.unsubLive = null;
    this.rendered = { len: 0, first: null };

    this.mainPane = h('div', { class: 'pane main-pane' });
    this.legend = h('div', { class: 'legend' }, this.legendMain = h('div', { class: 'lg-main' }), this.legendInd = h('div'));
    this.overlay = h('canvas', { class: 'overlay' });
    this.octx = this.overlay.getContext('2d');
    this.loader = h('div', { class: 'loader', hidden: true }, h('div'));
    this.empty = h('div', { class: 'empty-state', hidden: true });
    this.floatBar = h('div', { class: 'float-bar', hidden: true });
    this.quick = h('div', { class: 'quick-trade', hidden: true });
    this.mainPane.append(this.legend, this.quick, this.overlay, this.loader, this.empty, this.floatBar);
    this.panes = h('div', { class: 'view-panes' }, this.mainPane);
    this.el = h('div', { class: 'view' }, this.panes);
    host.append(this.el);

    this.chart = LC.createChart(this.mainPane, {
      ...chartOptions(app.theme), autoSize: true,
      rightPriceScale: { ...chartOptions(app.theme).rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { ...chartOptions(app.theme).timeScale, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8, minBarSpacing: 0.3 },
      kineticScroll: { mouse: false, touch: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    });
    this.mainSeries = null;
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      this.syncRange(this.chart, r);
      this.app.syncTime?.(this);
      if (r && r.from < 30 && this.hasMoreBefore && !this.loadingMore) this.loadMoreBefore();
    });
    this.chart.subscribeCrosshairMove(p => this.onCrosshair(this.chart, p));
    this.mainPane.addEventListener('mouseenter', () => this.focusCrosshair(this.chart));
    this.mainPane.addEventListener('mouseleave', () => { this.mouse = null; this.clearCrosshairs(); });
    this.el.addEventListener('pointerdown', () => app.setActive(this), true);
    new ResizeObserver(() => this.sizeOverlay()).observe(this.mainPane);
    this.sizeOverlay();
    this.wirePointer();
    this.frame = requestAnimationFrame(() => this.renderOverlay());
  }

  get symbol() { return this.cfg.symbol; }
  get spec() { return spec(this.cfg.symbol); }
  get prec() { const p = chartStyle().precision; return p === 'default' || p == null || p === '' ? precisionOf(this.cfg.symbol) : Number(p); }
  get drawings() { return this.app.drawingsFor(this.cfg.symbol); }
  get replay() { return this.app.replay; }
  get inReplay() { return this.replay.active; }
  /** Broker that can trade this chart's symbol: Bar Replay's, or the live paper account's. */
  get tradeBroker() {
    const r = this.replay;
    if (r.active) return r.symbol === this.cfg.symbol ? r.broker : null;
    const P = this.app.paper;
    return P?.canTrade(this.cfg.symbol) ? P.brokerFor(this.cfg.symbol) : null;
  }
  allCharts() { return [this.chart, ...this.runtimes.filter(r => r.chart).map(r => r.chart)]; }

  toJSON() { return { ...this.cfg }; }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.loadToken++;
    window.removeEventListener('pointermove', this.onWinMove);
    window.removeEventListener('pointerup', this.onWinUp);
    this.unsubLive?.();
    this.stopPolling();
    this.stopStream();
    clearInterval(this.compareTimer);
    for (const r of this.runtimes) if (r.chart) r.chart.remove();
    this.chart.remove();
    this.el.remove();
  }

  // ---------------------------------------------------------------- config changes
  async setSymbol(s, fromSync = false) {
    if (s === this.cfg.symbol) return;
    if (!fromSync) this.app.syncViews?.(this, 'symbol', s);
    this.cfg.symbol = s;
    this.selected = null; this.pending = null; this.measure = null; this.markers = [];
    await this.app.ensureDrawings(s);
    this.app.onViewChanged(this);
    await this.load();
  }
  async setTf(tf, fromSync = false) {
    if (tf === this.cfg.tf) return;
    if (!fromSync) this.app.syncViews?.(this, 'tf', tf);
    this.cfg.tf = tf;
    this.markers = [];
    this.app.onViewChanged(this);
    await this.load();
  }
  setChartType(t) {
    const reframe = isPriceType(t) || isPriceType(this.cfg.chartType);
    this.cfg.chartType = t;
    this.typeInfo = null;
    this.setSourceBars(this.src || this.all);
    this.app.onViewChanged(this);
    this.rebuildAll();
    // boxes and candles don't line up one to one: show the latest ones again
    if (reframe) { const n = this.bars.length; this.setAllRanges({ from: Math.max(0, n - 150), to: n + 8 }); }
  }
  /** Box size / reversal / lines of a price-based chart type (Renko, Kagi, Point & figure, Line break, Range). */
  setTypeOptions(t, opts) {
    this.cfg.typeOpts = { ...this.cfg.typeOpts, [t]: { ...(this.cfg.typeOpts?.[t] || {}), ...opts } };
    this.setChartType(t); // changing a type's settings shows that type
    this.app.refreshToolbar();
  }
  setScaleMode(mode) {
    this.cfg.scaleMode = mode;
    this.chart.priceScale('right').applyOptions({ mode: this.compares?.length ? 2 : mode });
    this.app.onViewChanged(this);
  }
  applyTheme() {
    for (const c of this.allCharts()) c.applyOptions(chartOptions(this.app.theme));
    this.focusCrosshair(this.chart);
  }

  // ---------------------------------------------------------------- data loading
  setLoading(on) { this.loader.hidden = !on; }

  async load() {
    const token = ++this.loadToken;
    this.unsubLive?.(); this.unsubLive = null;
    this.stopPolling();
    this.stopStream();
    this.typeInfo = null; // price-based charts size their boxes again for the new data
    this.setLoading(true);
    this.empty.hidden = true;
    const { symbol, tf } = this.cfg;
    try {
      let all = [], hasMoreBefore = false, hasMoreAfter = false;
      if (this.inReplay) {
        const C = this.replay.cursor;
        // Bars are labelled by trading date, so a forming daily bar can carry a label ≥ cursor:
        // over-fetch by one bar and clamp on `start`.
        const back = await fetchBars(symbol, tf, { before: C + tfSec(tf), limit: 1500 });
        const fwd = await fetchBars(symbol, tf, { after: C, limit: 500 });
        all = mergeBars(back.bars, fwd.bars);
        hasMoreBefore = back.hasMoreBefore;
        hasMoreAfter = fwd.hasMoreAfter;
      } else {
        const res = await fetchBars(symbol, tf, { limit: 1500 });
        all = res.bars;
        hasMoreBefore = res.hasMoreBefore;
      }
      if (token !== this.loadToken) return;
      this.all = all;
      this.hasMoreBefore = hasMoreBefore;
      this.hasMoreAfter = hasMoreAfter;
      this.rendered = { len: 0, first: null };
      await this.computeVisible();
      if (token !== this.loadToken) return;
      this.rebuildAll();
      const n = this.bars.length;
      this.setAllRanges({ from: Math.max(0, n - 150), to: n + 8 });
      this.showEmptyState();
      if (!this.inReplay && this.spec.provider === 'binance') {
        this.unsubLive = subscribeLive(symbol, tf, b => this.onLiveBar(b), st => this.app.setStatus(st === 'live' ? 'live' : 'connecting', this));
      }
      if (!this.inReplay && (this.spec.provider === 'twelvedata' || this.spec.provider === 'tradingview')) { this.startStream(token); this.startPolling(token); }
      this.loadCompares(true);
      clearInterval(this.compareTimer);
      if (this.compares?.length && !this.inReplay) this.compareTimer = setInterval(() => { if (!document.hidden && !this.inReplay) this.loadCompares(true); }, 60e3);
      this.app.setStatus(this.spec.provider === 'binance' && !this.inReplay ? 'connecting' : 'hist', this);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.all = []; this.setSourceBars([]);
      this.rebuildAll();
      this.showEmptyState(e.message);
    } finally {
      if (token === this.loadToken) this.setLoading(false);
    }
    this.updateLegends();
    this.app.onViewLoaded?.(this);
  }

  showEmptyState(error) {
    const s = this.spec;
    if (this.bars.length && !error) { this.empty.hidden = true; return; }
    const kids = [];
    if (error) {
      kids.push(h('h3', null, s.provider === 'twelvedata' ? `Twelve Data: ${s.symbol} ${tfLabel(this.cfg.tf)}` : 'Could not load data'), h('p', null, error));
      if (s.provider === 'twelvedata') {
        kids.push(h('div', { class: 'empty-actions' },
          h('button', { class: 'btn primary', onclick: () => this.app.openDataManager(s.symbol) }, icon('database'), 'Twelve Data settings'),
          h('button', { class: 'btn', onclick: () => this.load() }, 'Retry')));
      }
    } else if (s.provider === 'twelvedata') {
      kids.push(h('h3', null, `No Twelve Data candles for ${s.symbol} ${tfLabel(this.cfg.tf)}`), h('p', null, this.inReplay ? 'There is no real history before this replay date.' : 'Twelve Data returned no candles for this timeframe.'));
    } else if (s.provider === 'dukascopy') {
      const cov = s.coverage;
      if (this.inReplay && cov?.months) kids.push(h('h3', null, `No ${s.symbol} data before this replay date`), h('p', null, `Cached data covers ${fmtDate(cov.first)} – ${fmtDate(cov.last)}.`));
      else kids.push(h('h3', null, `No ${s.symbol} data cached yet`), h('p', null, 'Download real 1-minute history from Dukascopy\'s tick archive or import a Dukascopy CSV export.'));
      kids.push(h('button', { class: 'btn primary', onclick: () => this.app.openDataManager(s.symbol) }, icon('database'), 'Open data manager'));
    } else kids.push(h('h3', null, 'No data'));
    this.empty.replaceChildren(h('div', { class: 'empty-card' }, kids));
    this.empty.hidden = false;
  }

  async loadMoreBefore() {
    if (!this.all.length) return;
    this.loadingMore = true;
    const token = this.loadToken;
    try {
      const res = await fetchBars(this.cfg.symbol, this.cfg.tf, { before: this.all[0].time, limit: 1500 });
      if (token !== this.loadToken || !res.bars.length) { this.hasMoreBefore = false; return; }
      const range = this.chart.timeScale().getVisibleLogicalRange();
      const added = res.bars.filter(b => b.time < this.all[0].time);
      this.all = added.concat(this.all);
      this.hasMoreBefore = res.hasMoreBefore && added.length > 0;
      this.rendered = { len: 0, first: null };
      const before = this.bars.length;
      await this.computeVisible();
      this.renderData();
      const shift = this.bars.length - before; // candles added, or boxes for price-based charts
      if (range) this.setAllRanges({ from: range.from + shift, to: range.to + shift });
      this.loadCompares();
    } catch (e) {
      this.hasMoreBefore = false;
      toast(`Could not load older data: ${e.message}`, 'error');
    } finally {
      this.loadingMore = false;
    }
  }

  async loadMoreAfter() {
    if (!this.hasMoreAfter || !this.all.length) return false;
    const last = this.all[this.all.length - 1];
    const res = await fetchBars(this.cfg.symbol, this.cfg.tf, { after: last.start + 1, limit: 1000 });
    const added = res.bars.filter(b => b.start > last.start);
    this.all = this.all.concat(added);
    this.hasMoreAfter = res.hasMoreAfter && added.length > 0;
    return added.length > 0;
  }

  // ---------------------------------------------------------------- Twelve Data live refresh (no streaming on the plan: poll)
  startPolling(token) {
    this.stopPolling();
    const every = this.cfg.tf === '1m' ? 15e3 : 30e3; // the server itself only spends a credit when its cache is stale
    const background = this.cfg.tf === '1m' ? 180e3 : 300e3; // slower while the app is off screen (saves API credits)
    this.pollTimer = setInterval(() => {
      if (token !== this.loadToken) return;
      // with live ticks streaming, a poll every minute is enough to true up the candles (the server refreshes them every 5)
      const gap = this.streaming ? 60e3 : document.hidden ? background : 0;
      if (Date.now() - (this.liveInfo?.polledAt || 0) >= gap) this.pollLatest(token);
    }, every);
    // catch up as soon as the app is visible again
    this.onVisible = () => { if (!document.hidden && token === this.loadToken) this.pollLatest(token); };
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('focus', this.onVisible);
  }
  stopPolling() {
    clearInterval(this.pollTimer); this.pollTimer = null;
    if (this.onVisible) { document.removeEventListener('visibilitychange', this.onVisible); window.removeEventListener('focus', this.onVisible); this.onVisible = null; }
  }
  async pollLatest(token) {
    if (this.polling || this.inReplay) return;
    this.polling = true;
    try {
      const { symbol, tf } = this.cfg;
      const res = await fetchBars(symbol, tf, { limit: 20, live: true, streaming: !!this.streaming });
      if (token !== this.loadToken || this.inReplay || symbol !== this.cfg.symbol || tf !== this.cfg.tf) return;
      this.liveInfo = { fetchedAt: res.fetchedAt, throttled: res.throttled, credits: res.credits, polledAt: Date.now() };
      const A = this.all, last = A[A.length - 1];
      const fresh = res.bars.filter(b => !last || b.time >= last.time);
      if (last && res.bars.length && res.bars[0].time > last.time) { this.load(); return; } // missed more than 20 candles (e.g. after sleep): reload
      let changed = false;
      for (const b0 of fresh) {
        const cur = A[A.length - 1];
        // the forming candle: streamed ticks newer than the server's copy keep their close and extend high / low
        const b = cur && b0.time === cur.time && this.tickAt && this.tickAt > (res.fetchedAt || 0)
          ? { ...b0, high: Math.max(b0.high, cur.high), low: Math.min(b0.low, cur.low), close: cur.close } : b0;
        if (cur && b.time === cur.time) {
          if (b.open !== cur.open || b.high !== cur.high || b.low !== cur.low || b.close !== cur.close) { A[A.length - 1] = b; changed = true; }
        } else if (!cur || b.time > cur.time) { A.push(b); changed = true; }
      }
      for (const b of fresh) { this.app.alerts?.feed(symbol, b, this.id); this.app.paper?.onBar(symbol, b); }
      if (changed) {
        this.setSourceBars(A);
        this.renderData();
        this.app.onLivePrice?.(symbol, A[A.length - 1].close);
      }
      this.app.setStatus('hist', this);
    } catch { /* network hiccup: try again on the next tick */ }
    finally { this.polling = false; }
  }

  // ---------------------------------------------------------------- Twelve Data live ticks (WebSocket via the server)
  startStream(token) {
    this.stopStream();
    const symbol = this.cfg.symbol;
    const es = new EventSource(`/api/stream?symbols=${encodeURIComponent(symbol)}`);
    this.stream = es;
    es.addEventListener('tick', e => { if (token === this.loadToken) { const d = JSON.parse(e.data); if (d.symbol === symbol) this.onTick(d.price, d.at); } });
    es.addEventListener('status', e => {
      const d = JSON.parse(e.data);
      if (token !== this.loadToken || d.symbol !== symbol) return;
      this.streaming = !!d.streaming;
      this.streamNote = d.streaming ? null : d.reason;
      this.app.setStatus(null, this);
    });
    es.onerror = () => { this.streaming = false; };
  }
  stopStream() { this.stream?.close(); this.stream = null; this.streaming = false; }
  /** A streamed price: it moves the forming candle (or opens the next one on intraday charts). */
  onTick(price, at) {
    const A = this.all;
    if (this.inReplay || !A.length || !(price > 0)) return;
    this.streaming = true;
    this.tickAt = at;
    const iv = tfSec(this.cfg.tf), t = Math.floor(at / 1000), last = A[A.length - 1], start = last.start ?? last.time;
    if (iv <= 3600 && t >= start + iv) {
      const s = Math.floor(t / iv) * iv; // intraday candles sit on the UTC clock grid, like Twelve Data's
      A.push({ time: s, start: s, open: price, high: price, low: price, close: price, volume: 0, spread: 0, live: true });
    } else if (price !== last.close) {
      A[A.length - 1] = { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) };
    } else return;
    const b = A[A.length - 1];
    this.app.paper?.onBar(this.cfg.symbol, b);
    this.setSourceBars(A);
    this.renderData();
    this.app.onLivePrice?.(this.cfg.symbol, price);
    if (this.app.activeView === this && Date.now() - (this.statusAt || 0) > 1000) { this.statusAt = Date.now(); this.app.setStatus(null, this); }
  }

  onLiveBar(b) {
    const A = this.all;
    const last = A[A.length - 1];
    if (!last || b.time < last.time) return;
    if (b.time === last.time) A[A.length - 1] = b; else A.push(b);
    this.app.alerts?.feed(this.cfg.symbol, b, this.id);
    this.app.paper?.onBar(this.cfg.symbol, b);
    this.setSourceBars(A);
    this.renderData();
    this.app.onLivePrice?.(this.cfg.symbol, b.close);
  }

  /** Visible bars: everything when live; in replay only bars that started before the cursor, with the
   *  forming bar rebuilt from 1-minute data up to the cursor (so no future high/low/close leaks). */
  async computeVisible() {
    if (!this.inReplay) { this.setSourceBars(this.all); return; }
    const C = this.replay.cursor;
    let lo = 0, hi = this.all.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.all[m].start < C) lo = m + 1; else hi = m; }
    const visible = this.all.slice(0, lo);
    if (visible.length) {
      const last = visible[visible.length - 1];
      const next = this.all[lo];
      const complete = this.cfg.tf === '1m' || (next && next.start === C);
      if (!complete) {
        const r = await rangeOhlc(this.cfg.symbol, last.start, C);
        if (r) visible[visible.length - 1] = { ...last, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, spread: r.spread, partial: true };
        else visible.pop(); // no finer real data for the forming bar: hide it rather than show its future high/low/close
      }
    }
    this.setSourceBars(visible);
  }

  /** Display bars: the candles themselves, or the boxes / lines / columns a price-based chart type builds from them. */
  setSourceBars(src) {
    this.src = src;
    const t = this.cfg.chartType;
    if (!isPriceType(t)) { this.bars = src; this.typeInfo = null; return; }
    const opts = this.cfg.typeOpts?.[t] || {};
    const key = `${this.cfg.symbol}|${this.cfg.tf}|${t}|${JSON.stringify(opts)}`;
    // like TradingView, the box size is fixed when the chart loads, so new candles don't resize every box
    if (this.typeInfo?.key !== key || (t !== 'linebreak' && !(this.typeInfo.box > 0))) this.typeInfo = { key, box: null };
    const res = priceTransform(t, src, { ...opts, box: this.typeInfo.box });
    this.typeInfo.box = res.box;
    this.bars = res.bars;
  }

  /** Called by the replay controller whenever the cursor moves. */
  async onCursor() {
    const C = this.replay.cursor;
    const last = this.all[this.all.length - 1];
    if (this.hasMoreAfter && (!last || last.start <= C + tfSec(this.cfg.tf) * 5)) await this.loadMoreAfter();
    await this.computeVisible();
    this.renderData();
    this.showEmptyState();
    if (this.compares?.length) this.loadCompares();
  }

  /** Start time of the next bar boundary after the cursor (bar-by-bar replay stepping). */
  async nextBarCursor(C) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let lo = 0, hi = this.all.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.all[m].start < C) lo = m + 1; else hi = m; }
      const cand = this.all[lo] && this.all[lo].start > C ? this.all[lo] : this.all[lo + 1];
      if (cand) return cand.start;
      if (!(await this.loadMoreAfter())) return null;
    }
    return null;
  }
  async prevBarCursor(C) {
    let lo = 0, hi = this.all.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.all[m].start < C) lo = m + 1; else hi = m; }
    return lo >= 2 ? this.all[lo - 1].start : null;
  }

  // ---------------------------------------------------------------- series
  priceFormat() { const p = this.prec; return { type: 'price', precision: p, minMove: Math.pow(10, -p) }; }

  /** Colour options for the current chart type, from the user's chart style. */
  seriesColors() {
    const c = candleColors();
    switch (this.cfg.chartType) {
      case 'bars': return { upColor: c.up, downColor: c.down };
      case 'hollow': return { upColor: 'rgba(0,0,0,0)', downColor: c.down, borderVisible: true, borderUpColor: c.borderUp, borderDownColor: c.borderDown, wickUpColor: c.wickUp, wickDownColor: c.wickDown };
      case 'line': case 'linemarkers': case 'step': return { color: ACCENT };
      case 'kagi': return { color: c.up };
      case 'columns': return { color: alpha(c.up, 0.75) };
      case 'highlow': return { upColor: ACCENT, downColor: ACCENT, borderVisible: false, wickVisible: false };
      case 'pnf': { const none = 'rgba(0,0,0,0)'; return { upColor: none, downColor: none, borderVisible: false, wickVisible: false }; } // X/O glyphs are painted on the overlay
      case 'area': return { lineColor: ACCENT, topColor: 'rgba(41,98,255,0.28)', bottomColor: 'rgba(41,98,255,0.02)' };
      case 'baseline': return { topLineColor: c.up, topFillColor1: alpha(c.up, 0.28), topFillColor2: alpha(c.up, 0.05), bottomLineColor: c.down, bottomFillColor1: alpha(c.down, 0.05), bottomFillColor2: alpha(c.down, 0.28) };
      default: {
        const st = chartStyle(), none = 'rgba(0,0,0,0)';
        const body = st.bodyVisible !== false;
        const bordered = st.borderVisible !== false && (c.borderUp !== c.up || c.borderDown !== c.down || !body);
        return { upColor: body ? c.up : none, downColor: body ? c.down : none, borderVisible: bordered, borderUpColor: c.borderUp, borderDownColor: c.borderDown,
          wickVisible: st.wickVisible !== false, wickUpColor: c.wickUp, wickDownColor: c.wickDown };
      }
    }
  }
  lastPriceOptions() { const on = chartStyle().lastPriceLine !== false; return { priceLineVisible: on, lastValueVisible: on }; }

  /** Re-apply theme + candle colours without rebuilding panes. */
  applyStyle() {
    this.applyTheme();
    const keep = this.runtimes.find(r => r.barColors);
    if (keep) this.setScriptBarColors(keep, keep.barColors); // re-evaluate indicator candle colouring
    if (this.runtimes.some(r => r.candleOverlay || r.result)) this.refreshIndicators(); // plotcandle follows the same switch
    this.mainSeries?.applyOptions({ ...this.seriesColors(), ...this.lastPriceOptions(), priceFormat: this.priceFormat() });
    if (this.mainSeries) { this.mainSeries.setData(this.displayData()); this.rendered = { len: this.bars.length, first: this.bars[0]?.time ?? null }; }
    this.applyMarkers();
    this.lastOverlaySig = null;
    this.updateLegends();
    this.refreshIndicators();
  }

  createMainSeries() {
    const t = this.cfg.chartType, pf = this.priceFormat();
    const common = { priceFormat: pf, ...this.lastPriceOptions(), ...this.seriesColors() };
    switch (t) {
      case 'bars': return this.chart.addBarSeries({ ...common, thinBars: false });
      case 'hollow': return this.chart.addCandlestickSeries(common);
      case 'line': return this.chart.addLineSeries({ ...common, lineWidth: 2 });
      case 'linemarkers': return this.chart.addLineSeries({ ...common, lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2.5 });
      case 'step': return this.chart.addLineSeries({ ...common, lineWidth: 2, lineType: LC.LineType.WithSteps });
      case 'kagi': return this.chart.addLineSeries({ ...common, lineWidth: 2, lineType: LC.LineType.WithSteps, crosshairMarkerVisible: false });
      case 'columns': // columns rise from the bottom of the pane: scale on the closes only, not on the histogram's zero base
        return this.chart.addHistogramSeries({ ...common, base: 0, autoscaleInfoProvider: () => this.visibleCloseRange() });
      case 'highlow': return this.chart.addCandlestickSeries(common);
      case 'area': return this.chart.addAreaSeries({ ...common, lineWidth: 2 });
      case 'baseline': {
        const recent = this.bars.slice(-200).map(b => b.close);
        const base = recent.length ? (Math.min(...recent) + Math.max(...recent)) / 2 : 0;
        return this.chart.addBaselineSeries({ ...common, baseValue: { type: 'price', price: base }, lineWidth: 2 });
      }
      default: return this.chart.addCandlestickSeries(common);
    }
  }

  displayData() {
    const t = this.cfg.chartType, B = this.bars;
    if (t === 'ha') { this.ha = []; B.forEach((b, i) => this.ha.push(heikinAshi(this.ha[i - 1], b))); return this.ha; }
    return B.map((b, i) => this.displayPoint(b, B[i - 1], B[i + 1]));
  }
  /** One data point for the main series in the current chart type. */
  displayPoint(b, prev, next) {
    switch (this.cfg.chartType) {
      case 'line': case 'area': case 'baseline': case 'linemarkers': case 'step': return { time: b.time, value: b.close };
      // a step segment takes its starting point's colour but draws the *next* line's vertical move
      case 'kagi': { const k = candleColors(); return { time: b.time, value: b.close, color: (next || b).yang === false ? k.down : k.up }; }
      case 'columns': { const k = candleColors(), up = prev ? b.close >= prev.close : b.close >= b.open; return { time: b.time, value: b.close, color: alpha(up ? k.up : k.down, 0.75) }; }
      case 'highlow': return { time: b.time, open: b.low, high: b.high, low: b.low, close: b.high };
      default: return this.colored({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }, prev?.close);
    }
  }
  /** Price range of the visible closes (Columns chart autoscale). */
  visibleCloseRange() {
    const r = this.chart.timeScale().getVisibleLogicalRange(), B = this.bars;
    if (!r || !B.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, Math.floor(r.from)); i <= Math.min(B.length - 1, Math.ceil(r.to)); i++) { lo = Math.min(lo, B[i].close); hi = Math.max(hi, B[i].close); }
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * 0.1 || hi * 0.001;
    return { priceRange: { minValue: lo - pad * 2, maxValue: hi + pad } };
  }
  /** Script barcolor() overrides, then "colour bars by previous close". */
  colored(pt, prevClose) {
    const c = this.barColors?.get(pt.time);
    if (c) return { ...pt, color: c, wickColor: c, borderColor: c };
    const st = chartStyle();
    if (st.colorByPrevClose && prevClose != null) {
      const k = candleColors(), up = pt.close >= prevClose, none = 'rgba(0,0,0,0)';
      return { ...pt, color: st.bodyVisible === false ? none : up ? k.up : k.down, wickColor: up ? k.wickUp : k.wickDown, borderColor: up ? k.borderUp : k.borderDown };
    }
    return pt;
  }
  displayAt(i) {
    const b = this.bars[i];
    if (this.cfg.chartType === 'ha') return (this.ha[i] = heikinAshi(this.ha[i - 1], b));
    return this.displayPoint(b, this.bars[i - 1], this.bars[i + 1]);
  }

  /** Push bars to the chart, using cheap incremental updates when only the tail changed. */
  renderData() {
    if (!this.mainSeries) return;
    const n = this.bars.length, first = this.bars[0]?.time ?? null;
    const { len, first: rf } = this.rendered;
    if (first === rf && (n === len || n === len + 1) && n > 0 && this.cfg.chartType !== 'kagi') { // kagi recolours the previous line
      if (n === len + 1 && len > 0) this.mainSeries.update(this.displayAt(n - 2));
      this.mainSeries.update(this.displayAt(n - 1));
    } else {
      this.mainSeries.setData(this.displayData());
    }
    this.rendered = { len: n, first };
    this.scheduleIndicatorRefresh();
    this.applyMarkers();
    if (this.hoverIdx == null) this.updateLegends();
  }

  rebuildAll() {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    for (const rt of this.runtimes) this.destroyRuntime(rt);
    this.runtimes = [];
    for (const c of this.compares || []) { this.chart.removeSeries(c.series); c.row.remove(); }
    this.compares = [];
    if (this.mainSeries) { this.chart.removeSeries(this.mainSeries); this.mainSeries = null; }
    for (const ind of this.cfg.indicators.filter(i => i.type === 'VOL')) this.runtimes.push(this.createRuntime(ind));
    this.mainSeries = this.createMainSeries();
    this.mainSeries.setData(this.displayData());
    this.rendered = { len: this.bars.length, first: this.bars[0]?.time ?? null };
    if (!isPriceType(this.cfg.chartType)) this.compares = (this.cfg.compare || []).map(c => this.createCompare(c));
    for (const ind of this.cfg.indicators.filter(i => i.type !== 'VOL')) this.runtimes.push(this.createRuntime(ind));
    const subs = this.runtimes.filter(r => r.chart);
    this.chart.applyOptions({ timeScale: { visible: subs.length === 0 } });
    subs.forEach((r, i) => r.chart.applyOptions({ timeScale: { visible: i === subs.length - 1 } }));
    // comparing symbols only makes sense in percent: every line starts from the same point
    this.chart.priceScale('right').applyOptions({ mode: this.compares.length ? 2 : this.cfg.scaleMode || 0 });
    for (const c of this.compares) this.applyCompare(c);
    this.refreshIndicators();
    this.applyMarkers();
    if (range) this.setAllRanges(range);
    this.updateLegends();
  }

  // ---------------------------------------------------------------- indicators
  createRuntime(ind) {
    const def = defOf(ind);
    const rt = { ind, def, series: [], outputs: [], chart: null, el: null, specs: seriesSpecs(LC, ind, this.priceFormat()) };
    let target = this.chart;
    if (def.pane) {
      const el = h('div', { class: 'pane sub-pane', style: { height: (ind.height || 130) + 'px' } });
      const legend = h('div', { class: 'legend' });
      el.append(legend, this.makeResizer(el, ind));
      this.panes.append(el);
      const c = LC.createChart(el, {
        ...chartOptions(this.app.theme), autoSize: true,
        layout: { ...chartOptions(this.app.theme).layout, attributionLogo: false },
        rightPriceScale: { ...chartOptions(this.app.theme).rightPriceScale, scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { ...chartOptions(this.app.theme).timeScale, visible: false, rightOffset: 8, barSpacing: 8, minBarSpacing: 0.3, timeVisible: true },
        kineticScroll: { mouse: false, touch: true },
      });
      c.timeScale().subscribeVisibleLogicalRangeChange(r => this.syncRange(c, r));
      c.subscribeCrosshairMove(p => this.onCrosshair(c, p));
      el.addEventListener('mouseenter', () => this.focusCrosshair(c));
      el.addEventListener('mouseleave', () => this.clearCrosshairs());
      rt.el = el; rt.chart = c; rt.legendBox = legend;
      target = c;
    } else rt.legendBox = this.legendInd;
    rt.row = this.makeLegendRow(rt);
    rt.legendBox.append(rt.row);
    for (const s of rt.specs) {
      const se = target['add' + s.kind + 'Series']({ priceLineVisible: false, crosshairMarkerVisible: s.kind === 'Line', lastValueVisible: true, ...s.opts, visible: ind.visible !== false });
      for (const pl of s.lines || []) se.createPriceLine(pl);
      rt.series.push(se);
    }
    if (ind.type === 'VOL') rt.series[0].priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    return rt;
  }
  destroyRuntime(rt) {
    if (rt.chart) { rt.chart.remove(); rt.el.remove(); }
    else { for (const s of rt.series) this.chart.removeSeries(s); rt.row.remove(); }
  }
  makeResizer(el, ind) {
    const r = h('div', { class: 'resizer' });
    r.addEventListener('pointerdown', e => {
      e.preventDefault();
      const startY = e.clientY, startH = el.offsetHeight;
      const move = ev => { el.style.height = clamp(startH - (ev.clientY - startY), 60, 600) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ind.height = el.offsetHeight; this.app.onViewChanged(this); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return r;
  }
  makeLegendRow(rt) {
    const { ind } = rt;
    const btn = (name, title, fn) => h('button', { title, onclick: e => { e.stopPropagation(); fn(e); } }, icon(name));
    const eyeBtn = btn(ind.visible === false ? 'eyeOff' : 'eye', 'Show/hide', () => {
      ind.visible = ind.visible === false;
      rt.series.forEach(s => s.applyOptions({ visible: ind.visible }));
      row.classList.toggle('off', !ind.visible);
      eyeBtn.replaceChildren(icon(ind.visible ? 'eye' : 'eyeOff'));
      this.app.onViewChanged(this);
    });
    rt.vals = h('span', { class: 'lg-vals' });
    const row = h('div', { class: 'lg-row' + (ind.visible === false ? ' off' : '') },
      h('span', { class: 'lg-title' }, indTitle(ind)), rt.vals,
      h('span', { class: 'lg-actions' }, eyeBtn,
        ind.type !== 'VOL' ? btn('gear', 'Settings', e => this.app.openIndicatorSettings(this, ind, e.currentTarget)) : null,
        btn('close', 'Remove', () => this.removeIndicator(ind.id))));
    return row;
  }
  addIndicator(type, params = {}, color = null) {
    const existingVol = this.cfg.indicators.find(i => i.type === 'VOL');
    if (type === 'VOL' && existingVol) { toast('Volume is already on the chart'); return existingVol; }
    const used = this.cfg.indicators.map(i => i.color);
    color ||= PALETTE.find(c => !used.includes(c)) || PALETTE[this.cfg.indicators.length % PALETTE.length];
    const ind = { id: uid(), type, params: { ...IND_DEFS[type].params, ...params }, color, visible: true };
    this.cfg.indicators.push(ind);
    this.app.onViewChanged(this);
    this.rebuildAll();
    toast(`Added ${IND_DEFS[type].name}`);
    return ind;
  }
  /** Add a saved script indicator (inputs start at the script's defaults). */
  addScriptIndicator(scriptId) {
    const sc = getScript(scriptId);
    if (!sc?.meta) { toast('Save the script without errors before adding it', 'error'); return null; }
    const ind = { id: uid(), type: 'SCRIPT', scriptId, params: Object.fromEntries(sc.meta.inputs.map(i => [i.name, i.def])), visible: true };
    this.cfg.indicators.push(ind);
    this.app.onViewChanged(this);
    this.rebuildAll();
    toast(`Added ${sc.name}`);
    return ind;
  }

  /** Run a script indicator in the worker and push its plots into the series. */
  async runScriptRuntime(rt) {
    const sc = getScript(rt.ind.scriptId);
    if (!sc) { rt.vals.replaceChildren(h('span', { class: 'down' }, '⚠ script deleted')); return; }
    // Coalesce: while a run is in flight, remember that another is wanted and run once more afterwards
    // (fast Bar Replay would otherwise queue a calculation per candle).
    if (rt.inflight) { rt.rerun = true; return; }
    rt.inflight = true;
    const token = (rt.token || 0) + 1;
    rt.token = token;
    const bars = this.bars;
    let res;
    try { res = await runScript(sc.code, bars, rt.ind.params, { ...this.scriptCtx(), key: `${this.uid ||= uid()}:${rt.ind.id}` }); }
    finally { rt.inflight = false; }
    try { this.applyScriptResult(rt, sc, res, bars, token); }
    finally { if (rt.rerun && this.runtimes.includes(rt)) { rt.rerun = false; this.runScriptRuntime(rt); } }
  }
  applyScriptResult(rt, sc, res, bars, token) {
    if (rt.token !== token || !this.runtimes.includes(rt)) return;
    this.scriptVersion = (this.scriptVersion || 0) + 1;
    if (res.error) {
      rt.error = res.error;
      rt.outputs = [];
      rt.shapes = [];
      this.applyMarkers();
      rt.vals.replaceChildren(h('span', { class: 'down', title: res.error }, `⚠ ${res.line ? `line ${res.line}: ` : ''}${res.error}`.slice(0, 90)));
      return;
    }
    rt.error = null;
    // The script's plots/inputs changed since it was saved (edited elsewhere or a library update): refresh and rebuild.
    if (res.meta) {
      const fresh = metaFromResult(res);
      const shape = m => JSON.stringify([m.overlay, m.plots.map(p => [p.title, p.style]), m.inputs.map(x => [x.name, x.kind, x.options])]);
      if (!sc.meta || shape(fresh) !== shape(sc.meta)) {
        upsertScript({ ...sc, meta: fresh, error: null });
        const healed = (this.app.healedScripts ||= new Set());
        if (!healed.has(sc.id)) { // at most once per session, so a script whose plots vary can't loop
          healed.add(sc.id);
          for (const v of this.app.views) if (v.cfg.indicators.some(i => i.scriptId === sc.id)) v.rebuildAll();
          return;
        }
      }
    }
    const T = bars.map(b => b.time);
    rt.outputs = res.plots.slice(0, rt.series.length).map(p => {
      if (p.ohlc) { // plotcandle / plotbar — a second set of candles drawn over the chart's own
        const [o, hi, lo, c] = p.ohlc;
        const hide = chartStyle().allowBarColor === false;
        return c.map((v, i) => {
          if (hide || v == null || o[i] == null) return { time: T[i] };
          const pt = { time: T[i], open: o[i], high: hi[i], low: lo[i], close: v };
          if (p.colors?.[i]) pt.color = p.colors[i];
          if (p.wickColors?.[i]) pt.wickColor = p.wickColors[i];
          if (p.borderColors?.[i]) pt.borderColor = p.borderColors[i];
          return pt;
        });
      }
      const pts = p.values.map((v, i) => {
        if (v == null) return { time: T[i] };
        const pt = { time: T[i], value: v };
        if (p.colors && p.colors[i]) pt.color = p.colors[i];
        return pt;
      });
      return p.br ? breakGaps(pts) : pts;
    });
    rt.outputs.forEach((d, i) => rt.series[i].setData(d));
    rt.candleOverlay = res.plots.some(p => p.ohlc && p.colors?.some(col => col && col !== 'rgba(0,0,0,0)'));
    rt.shapes = (res.shapes || []).filter(m => T[m.i] != null).map(m => ({ time: T[m.i], position: m.position, shape: m.shape, color: m.color, text: m.text || undefined, size: m.size }));
    rt.warnings = res.warnings || [];
    rt.alerts = (res.alerts || []).filter(a => T[a.i] != null).map(a => ({ symbol: this.cfg.symbol, tf: this.cfg.tf, event: a.title, message: a.message, price: bars[a.i].close, time: T[a.i] }));
    // Drawings, fills, backgrounds and tables are painted by the overlay pass (anchored to candle time/price).
    rt.result = { drawings: res.drawings, fills: res.fills, bgcolors: res.bgcolors, times: T };
    this.setScriptBarColors(rt, res.barcolors ? new Map(res.barcolors.map((c, i) => [T[i], c]).filter(([, c]) => c)) : null);
    this.applyMarkers();
    this.updateLegends();
    this.app.scriptAlerts?.(this, rt);
  }
  /** barcolor(): recolour the chart's own candles (the latest script with bar colours wins). */
  setScriptBarColors(rt, map) {
    rt.barColors = map;
    const merged = new Map();
    // indicators may recolour candles (Pine barcolor) unless the user turned that off in Chart settings
    if (chartStyle().allowBarColor !== false) for (const r of this.runtimes) if (r.ind.type === 'SCRIPT' && r.ind.visible !== false && r.barColors) for (const [t, c] of r.barColors) merged.set(t, c);
    if (!merged.size && !this.barColors?.size) return;
    this.barColors = merged;
    if (this.mainSeries) { this.mainSeries.setData(this.displayData()); this.rendered = { len: this.bars.length, first: this.bars[0]?.time ?? null }; }
  }
  /** Paint script drawings for every visible script indicator (main pane and indicator panes). */
  renderScriptLayers(cx) {
    for (const rt of this.runtimes) {
      if (rt.ind.type !== 'SCRIPT' || rt.ind.visible === false || !rt.result || rt.error) continue;
      const pane = !!rt.chart;
      const chart = pane ? rt.chart : this.chart;
      const series = pane ? rt.series.find(Boolean) : this.mainSeries;
      if (!series) continue;
      let ctx = cx.ctx, W = cx.W, H = cx.H;
      if (pane) {
        if (!rt.overlay) { rt.overlay = h('canvas', { class: 'overlay' }); rt.el.append(rt.overlay); }
        const dpr = window.devicePixelRatio || 1;
        const w = rt.el.clientWidth, hh = rt.el.clientHeight;
        if (rt.overlay.width !== Math.round(w * dpr) || rt.overlay.height !== Math.round(hh * dpr)) {
          rt.overlay.width = Math.round(w * dpr); rt.overlay.height = Math.round(hh * dpr);
          rt.overlay.style.width = w + 'px'; rt.overlay.style.height = hh + 'px';
        }
        ctx = rt.overlay.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, hh);
        W = chart.timeScale().width(); H = rt.el.clientHeight - 2;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      }
      const ts = chart.timeScale();
      const T = rt.result.times;
      const range = ts.getVisibleLogicalRange();
      const timeToX = t => ts.logicalToCoordinate(this.timeToLogical(t));
      // map the visible logical range (current bars) onto the script's own bar indexes
      const firstIdx = range && T.length ? Math.max(0, lowerIdx(T, this.logicalToTime(Math.floor(range.from)) ?? T[0]) - 1) : 0;
      const lastIdx = range && T.length ? Math.min(T.length - 1, lowerIdx(T, this.logicalToTime(Math.ceil(range.to)) ?? T[T.length - 1]) + 1) : T.length - 1;
      renderScriptOutput({
        ctx, W, H, timeToX, indexToX: i => (T[i] == null ? null : timeToX(T[i])), priceToY: p => series.priceToCoordinate(p),
        barSpacing: ts.options().barSpacing, from: firstIdx, to: lastIdx,
      }, rt.result);
      if (pane) ctx.restore();
    }
  }
  /** Chart context handed to script indicators (timeframe in seconds, symbol, price tick, session model). */
  scriptCtx() { return { tf: tfSec(this.cfg.tf), symbol: this.cfg.symbol, mintick: Math.pow(10, -this.prec), session: this.spec?.session || 'fx' }; }

  removeIndicator(id) {
    this.cfg.indicators = this.cfg.indicators.filter(i => i.id !== id);
    this.app.onViewChanged(this);
    this.rebuildAll();
    this.applyMarkers();
  }
  // ---------------------------------------------------------------- compare symbols (percent scale)
  addCompare(symbol) {
    if (symbol === this.cfg.symbol) { toast('That is already the chart\'s symbol'); return; }
    if (isPriceType(this.cfg.chartType)) { toast(`Comparing isn't available on ${PRICE_TYPES[this.cfg.chartType].label} charts — switch to candles or a line`, 'error'); return; }
    this.cfg.compare ||= [];
    if (this.cfg.compare.some(c => c.symbol === symbol)) { toast(`${symbol} is already on this chart`); return; }
    const used = this.cfg.compare.map(c => c.color);
    this.cfg.compare.push({ id: uid(), symbol, color: COMPARE_COLORS.find(c => !used.includes(c)) || COMPARE_COLORS[0] });
    this.app.onViewChanged(this);
    this.rebuildAll();
    this.loadCompares(true);
    clearInterval(this.compareTimer);
    if (!this.inReplay) this.compareTimer = setInterval(() => { if (!document.hidden && !this.inReplay) this.loadCompares(true); }, 60e3);
    toast(`Comparing ${this.cfg.symbol} with ${symbol} — percent change from the first visible bar`);
  }
  removeCompare(id) {
    this.cfg.compare = (this.cfg.compare || []).filter(c => c.id !== id);
    this.app.onViewChanged(this);
    this.rebuildAll();
    this.app.refreshToolbar();
  }
  createCompare(c) {
    const rt = { c, data: [], byTime: new Map(), series: this.chart.addLineSeries({ color: c.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: { type: 'price', precision: precisionOf(c.symbol), minMove: 10 ** -precisionOf(c.symbol) } }) };
    rt.vals = h('span', { class: 'lg-vals' });
    rt.row = h('div', { class: 'lg-row' }, h('span', { class: 'lg-title', style: { color: c.color } }, c.symbol), rt.vals,
      h('span', { class: 'lg-actions' }, h('button', { title: 'Remove comparison', onclick: e => { e.stopPropagation(); this.removeCompare(c.id); } }, icon('close'))));
    this.legendInd.prepend(rt.row);
    const prev = (this.compareCache ||= new Map()).get(c.symbol);
    if (prev) Object.assign(rt, { all: prev.all, tf: prev.tf, replay: prev.replay, until: prev.until });
    return rt;
  }
  /** Load (or reuse) the compared symbols' candles; in Bar Replay nothing after the replay cursor is shown. */
  async loadCompares(force = false) {
    if (!this.compares?.length) return;
    const tf = this.cfg.tf, iv = tfSec(tf), token = this.loadToken;
    await Promise.all(this.compares.map(async rt => {
      const stale = !rt.all || rt.tf !== tf || rt.replay !== this.inReplay || (this.inReplay && this.replay.cursor > rt.until);
      if (stale || (force && !this.inReplay)) {
        try {
          if (this.inReplay) {
            const C = this.replay.cursor;
            const [back, fwd] = await Promise.all([fetchBars(rt.c.symbol, tf, { before: C + iv, limit: 1500 }), fetchBars(rt.c.symbol, tf, { after: C, limit: 500 })]);
            rt.all = mergeBars(back.bars, fwd.bars);
            rt.until = fwd.hasMoreAfter && rt.all.length ? rt.all[rt.all.length - 1].start : Infinity;
          } else {
            let res = await fetchBars(rt.c.symbol, tf, { limit: 1500 }), all = res.bars;
            // page back until the comparison covers the chart's first candle (Binance pages hold 1,000 candles)
            for (let n = 0; n < 4 && res.hasMoreBefore && all.length && this.bars.length && all[0].time > this.bars[0].time; n++) {
              res = await fetchBars(rt.c.symbol, tf, { before: all[0].time, limit: 1500 });
              all = res.bars.filter(b => b.time < all[0].time).concat(all);
            }
            rt.all = all; rt.until = Infinity;
          }
          rt.tf = tf; rt.replay = this.inReplay; rt.error = null;
          this.compareCache.set(rt.c.symbol, { all: rt.all, tf, replay: rt.replay, until: rt.until });
        } catch (e) { rt.error = e.message; }
      }
      if (token === this.loadToken && this.compares.includes(rt)) this.applyCompare(rt);
    }));
    this.updateLegends();
  }
  applyCompare(rt) {
    if (!rt.all || rt.tf !== this.cfg.tf) return;
    const iv = tfSec(this.cfg.tf), C = this.inReplay ? this.replay.cursor : Infinity;
    const times = new Set(this.bars.map(b => b.time)); // only where the chart has a candle, so its own spacing stays intact
    rt.data = rt.all.filter(b => times.has(b.time) && (C === Infinity || b.start + iv <= C)).map(b => ({ time: b.time, value: b.close }));
    rt.byTime = new Map(rt.data.map(d => [d.time, d.value]));
    rt.series.setData(rt.data);
  }

  /** Chart data as CSV: candles plus every built-in indicator's values. */
  exportCsv() {
    const B = this.bars, cols = ['time', 'open', 'high', 'low', 'close', 'volume'];
    const extra = [];
    for (const rt of this.runtimes) rt.outputs.forEach((out, k) => { extra.push({ name: `${indTitle(rt.ind)}${rt.outputs.length > 1 ? ` #${k + 1}` : ''}`, out }); });
    for (const c of this.compares || []) extra.push({ name: c.c.symbol, map: c.byTime });
    const esc = v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [[...cols, ...extra.map(e => e.name)].map(esc).join(',')];
    B.forEach((b, i) => {
      const vals = extra.map(e => { const v = e.map ? e.map.get(b.time) : e.out[i]?.value; return v == null ? '' : String(v); });
      lines.push([new Date(b.time * 1000).toISOString().replace('.000Z', 'Z'), b.open, b.high, b.low, b.close, b.volume ?? '', ...vals].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${this.cfg.symbol}_${this.cfg.tf}${isPriceType(this.cfg.chartType) ? '_' + this.cfg.chartType : ''}_${fmtDate(B[0]?.time ?? 0)}_${fmtDate(B[B.length - 1]?.time ?? 0)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${B.length.toLocaleString()} rows${extra.length ? ` with ${extra.length} indicator column${extra.length === 1 ? '' : 's'}` : ''}`);
  }

  refreshIndicators() {
    const session = this.spec?.session || 'fx';
    for (const rt of this.runtimes) {
      if (rt.ind.type === 'SCRIPT') { this.runScriptRuntime(rt); continue; }
      rt.outputs = calc(rt.ind, this.bars, session);
      rt.outputs.forEach((d, i) => rt.series[i]?.setData(d));
    }
    this.updateLegends();
  }
  scheduleIndicatorRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refreshIndicators(); }, 120);
  }

  // ---------------------------------------------------------------- sync, crosshair, legend
  syncRange(src, r) {
    if (!r) return;
    for (const c of this.allCharts()) {
      if (c === src) continue;
      const cur = c.timeScale().getVisibleLogicalRange();
      if (cur && Math.abs(cur.from - r.from) < 1e-6 && Math.abs(cur.to - r.to) < 1e-6) continue;
      c.timeScale().setVisibleLogicalRange(r);
    }
  }
  setAllRanges(r) { for (const c of this.allCharts()) c.timeScale().setVisibleLogicalRange(r); }
  indexOfTime(t) {
    const B = this.bars;
    let lo = 0, hi = B.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m].time === t) return m; if (B[m].time < t) lo = m + 1; else hi = m - 1; }
    return -1;
  }
  onCrosshair(src, p) {
    if (this.xsync) return;
    const idx = p && p.time !== undefined ? this.indexOfTime(p.time) : -1;
    this.hoverIdx = idx >= 0 ? idx : null;
    this.updateLegends();
    this.xsync = true;
    try {
      for (const c of this.allCharts()) {
        if (c === src) continue;
        if (this.hoverIdx == null) { c.clearCrosshairPosition(); continue; }
        const t = this.bars[idx].time;
        if (c === this.chart) { if (this.mainSeries) c.setCrosshairPosition(this.bars[idx].close, t, this.mainSeries); }
        else {
          const rt = this.runtimes.find(r => r.chart === c);
          const k = rt.ind.type === 'MACD' ? 1 : 0;
          c.setCrosshairPosition(rt.outputs[k]?.[idx]?.value ?? 0, t, rt.series[k]);
        }
      }
    } finally { this.xsync = false; }
    if (src === this.chart) this.app.syncCrosshair?.(this, idx >= 0 ? this.bars[idx] : null);
  }
  focusCrosshair(active) {
    for (const c of this.allCharts()) c.applyOptions({ crosshair: { horzLine: { visible: c === active, labelVisible: c === active } } });
  }
  clearCrosshairs() {
    this.xsync = true;
    try { for (const c of this.allCharts()) c.clearCrosshairPosition(); } finally { this.xsync = false; }
    this.hoverIdx = null;
    this.updateLegends();
    this.app.syncCrosshair?.(this, null);
  }

  updateLegends() {
    const B = this.bars, s = this.spec;
    const ls = chartStyle();
    this.legend.classList.toggle('no-ind-titles', ls.showIndTitles === false);
    this.legend.classList.toggle('no-ind-values', ls.showIndValues === false);
    const pt = isPriceType(this.cfg.chartType) ? PRICE_TYPES[this.cfg.chartType] : null;
    const typeTag = pt ? ` · ${pt.label}${this.typeInfo?.box ? ` ${fmtPrice(this.typeInfo.box, this.prec)}` : ''}` : '';
    const head = ls.showTitle === false ? null : h('span', { class: 'lg-sym' }, `${this.cfg.symbol} · ${tfLabel(this.cfg.tf)} · ${providerLabel(s?.provider)}${typeTag}`,
      this.inReplay ? h('span', { class: 'badge replay' }, 'Replay') : null);
    if (!B.length) { fill(this.legendMain, head); for (const rt of this.runtimes) rt.vals.replaceChildren(); return; }
    for (const c of this.compares || []) {
      const t = B[this.hoverIdx ?? B.length - 1].time, v = c.byTime?.get(t);
      c.vals.textContent = c.error ? `⚠ ${c.error}` : v == null ? '∅' : fmtPrice(v, precisionOf(c.c.symbol));
    }
    const i = this.hoverIdx ?? B.length - 1;
    const b = B[i], prev = B[i - 1];
    const chg = prev ? b.close - prev.close : b.close - b.open;
    const pct = (chg / (prev ? prev.close : b.open)) * 100;
    const cls = b.close >= b.open ? 'up' : 'down';
    const v = (k, val) => h('span', null, h('b', null, k), h('span', { class: cls }, fmtPrice(val, this.prec)));
    fill(this.legendMain, head, h('span', { class: 'lg-ohlc' },
      ls.showOhlc === false ? null : [v('O', b.open), v('H', b.high), v('L', b.low), v('C', b.close)],
      ls.showChange === false ? null : h('span', { class: chg >= 0 ? 'up' : 'down' }, `${fmtSigned(chg, this.prec)} (${fmtPct(pct)})`),
      b.partial ? h('span', { class: 'muted' }, 'forming') : null));
    for (const rt of this.runtimes) {
      if (rt.error) continue; // keep the script's error message visible
      if (rt.ind.type === 'VPVR') { rt.vals.textContent = rt.vp ? `POC ${fmtPrice((rt.vp.bins[rt.vp.poc].lo + rt.vp.bins[rt.vp.poc].hi) / 2, this.prec)}${rt.vp.byCount ? ' · no volume data: bar count' : ''}` : ''; continue; }
      rt.vals.replaceChildren(...rt.outputs.map((out, k) => {
        const val = out[i]?.value;
        if (rt.ind.type === 'SCRIPT' && val == null) return null;
        let color = rt.specs[k]?.opts.color || out[i]?.color || 'inherit';
        let text;
        if (rt.ind.type === 'VOL') { text = fmtVol(val); color = b.close >= b.open ? chartStyle().up : chartStyle().down; }
        else if (rt.ind.type === 'OBV') text = fmtVol(val);
        else if (rt.def.pane && !PRICE_OUTPUTS.has(rt.ind.type)) text = fmtNum(val, rt.ind.type === 'CMF' || rt.ind.type === 'AO' ? 3 : 2);
        else text = fmtPrice(val, this.prec);
        return h('span', { style: { color } }, val == null ? '∅' : text);
      }).filter(Boolean));
    }
  }

  // ---------------------------------------------------------------- markers (tester trades / replay history)
  setMarkers(trades, source) {
    this.markerSource = source;
    this.markerTrades = trades || [];
    this.applyMarkers();
  }
  barTimeFor(t) {
    const B = this.bars;
    let lo = 0, hi = B.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if ((B[m].start ?? B[m].time) <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 ? B[ans].time : null;
  }
  applyMarkers() {
    if (!this.mainSeries) return;
    const out = [];
    const showTrades = chartStyle().showTradeMarkers !== false;
    const trades = showTrades ? [...(this.markerTrades || [])] : [];
    if (showTrades && this.inReplay && this.replay.symbol === this.cfg.symbol) trades.push(...this.replay.broker.s.history);
    else if (showTrades && !this.inReplay && this.app.paper?.brokers.get(this.cfg.symbol)) { const pb = this.app.paper.brokers.get(this.cfg.symbol); trades.push(...pb.s.history, ...pb.s.positions.map(p => ({ ...p, exitTime: null }))); }
    const C = this.inReplay ? this.replay.cursor : Infinity;
    for (const t of trades) {
      if (t.entryTime < C) {
        const et = this.barTimeFor(t.entryTime);
        if (et != null) out.push({ time: et, position: t.side === 'buy' ? 'belowBar' : 'aboveBar', color: t.side === 'buy' ? ACCENT : '#e91e63', shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', text: `${t.side === 'buy' ? 'Buy' : 'Sell'} ${+t.lots.toFixed(4)}` });
      }
      if (t.exitTime != null && t.exitTime <= C) {
        const xt = this.barTimeFor(t.exitTime - 1e-6);
        if (xt != null) out.push({ time: xt, position: t.side === 'buy' ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? UP : DOWN, shape: 'circle', text: `${t.reason === 'Take-profit' ? 'TP' : t.reason === 'Stop-loss' ? 'SL' : 'Exit'} ${fmtUsd(t.pnl, true)}` });
      }
    }
    // Signals from script indicators (Pine plotshape / plotchar).
    for (const rt of this.runtimes || []) {
      if (rt.ind.type !== 'SCRIPT' || rt.ind.visible === false || !rt.shapes || chartStyle().showSignals === false) continue;
      for (const m of rt.shapes) if (!this.inReplay || m.time < C) out.push(m);
    }
    out.sort((a, b) => a.time - b.time);
    this.mainSeries.setMarkers(out);
  }

  // ---------------------------------------------------------------- coordinates
  timeToLogical(t) {
    const B = this.bars, n = B.length, iv = tfSec(this.cfg.tf);
    if (!n) return 0;
    if (t >= B[n - 1].time) return n - 1 + (t - B[n - 1].time) / iv;
    if (t <= B[0].time) return (t - B[0].time) / iv;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B[m].time <= t) lo = m; else hi = m; }
    return lo + (t - B[lo].time) / (B[hi].time - B[lo].time);
  }
  logicalToTime(l) {
    const B = this.bars, n = B.length, iv = tfSec(this.cfg.tf);
    const r = Math.round(l);
    if (!n) return 0;
    if (r < 0) return B[0].time + r * iv;
    if (r > n - 1) return B[n - 1].time + (r - (n - 1)) * iv;
    return B[r].time;
  }
  toXY(p) {
    return {
      x: p.time == null ? null : this.chart.timeScale().logicalToCoordinate(this.timeToLogical(p.time)),
      y: p.price == null || !this.mainSeries ? null : this.mainSeries.priceToCoordinate(p.price),
    };
  }
  /** Like fromXY but keeps the fractional position between candles (freehand drawings). */
  fromXYExact(x, y) {
    const l = this.chart.timeScale().coordinateToLogical(x);
    const B = this.bars, n = B.length;
    let time = null;
    if (l != null && n) {
      if (l <= 0 || l >= n - 1 || n < 2) time = this.logicalToTime(Math.round(l)) + (l - Math.round(l)) * tfSec(this.cfg.tf);
      else { const a = Math.floor(l); time = B[a].time + (l - a) * (B[a + 1].time - B[a].time); }
    }
    return { time, price: this.mainSeries?.coordinateToPrice(y) ?? null };
  }
  fromXY(x, y) {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return { time: l == null || !this.bars.length ? null : this.logicalToTime(l), price: this.mainSeries?.coordinateToPrice(y) ?? null };
  }
  plotW() { return this.chart.paneSize().width; }
  plotH() { return this.chart.paneSize().height; }
  localXY(e) { const r = this.mainPane.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  inPlot(x, y) { return x >= 0 && x <= this.plotW() && y >= 0 && y <= this.plotH(); }

  drawCtx() {
    const view = this;
    return {
      ctx: this.octx, W: this.plotW(), H: this.plotH(), theme: this.app.theme, prec: this.prec, spec: this.spec,
      tfSec: tfSec(this.cfg.tf), hoverId: this.hoverDrawing?.id, bars: this.bars, geom: (this.geom ||= new WeakMap()),
      logicalToX: l => view.chart.timeScale().logicalToCoordinate(l),
      toXY: p => view.toXY(p),
      priceToY: p => (view.mainSeries ? view.mainSeries.priceToCoordinate(p) : null),
      timeToX: t => view.chart.timeScale().logicalToCoordinate(view.timeToLogical(t)),
      timeToLogical: t => view.timeToLogical(t), logicalToTime: l => view.logicalToTime(l),
      fmtPrice: v => fmtPrice(v, view.prec), fmtTime: t => fmtDateTime(t),
      fmtMoney: (d, price) => view.positionMoney(d, price),
    };
  }

  /** "$ amount" for a position-tool level, sized with the trading panel's risk settings. */
  positionMoney(d, price) {
    const s = this.spec;
    try {
      const lots = this.app.trading?.sizeForPositionTool?.(this, d);
      if (!lots) return '';
      const dir = d.type === 'long' ? 1 : -1;
      const v = quoteToUsd(s, (price - d.pts[0].price) * dir * lots * s.contractSize, price);
      return ` · ${fmtUsd(v, true)} @ ${+lots.toFixed(4)} lots`;
    } catch { return ''; }
  }

  // ---------------------------------------------------------------- overlay rendering
  sizeOverlay() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.mainPane.clientWidth, hgt = this.mainPane.clientHeight;
    this.overlay.width = Math.round(w * this.dpr); this.overlay.height = Math.round(hgt * this.dpr);
    this.overlay.style.width = w + 'px'; this.overlay.style.height = hgt + 'px';
  }

  /** Cheap fingerprint of everything the overlay depends on — the canvas is only repainted when it changes. */
  overlaySignature() {
    const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(), s = this.mainSeries;
    const H = this.overlay.height, W = this.overlay.width, last = this.bars[this.bars.length - 1];
    const tb = this.tradeBroker;
    const lines = tb ? this.tradeLines().map(l => `${l.kind}${l.price}${l.text}`).join() : '';
    return [r?.from, r?.to, s?.coordinateToPrice(0), s?.coordinateToPrice(100), W, H, this.mouse?.x, this.mouse?.y,
      this.bars.length, last?.time, last?.close, this.drawings?.length, this.app.drawingsVersion, this.selected?.id, this.hoverDrawing?.id,
      this.app.hideDrawings, this.app.theme, this.scriptVersion, this.replay.selecting, lines, this.dragLine?.price,
      this.app.alerts?.version, this.dragAlert?.price,
      this.runtimes.map(rt => (rt.ind.visible === false ? 0 : rt.overlay ? `${rt.series[0]?.coordinateToPrice(0)}:${rt.el.clientHeight}` : 1)).join(','),
      tb ? `${tb.quote?.bid}:${tb.quote?.ask}` : ''].join('|');
  }
  renderOverlay() {
    this.frame = requestAnimationFrame(() => this.renderOverlay());
    // Interactions in progress always repaint; otherwise skip frames where nothing visible changed
    // (repainting hundreds of script labels 60×/s kept the CPU busy for nothing).
    const busy = this.drag || this.pending || this.measure || this.dragLine || this.dragAlert;
    if (!busy && this.mainSeries) {
      const sig = this.overlaySignature();
      const now = performance.now();
      if (sig === this.lastOverlaySig && now - (this.lastOverlayAt || 0) < 1000) return;
      this.lastOverlaySig = sig;
      this.lastOverlayAt = now;
    }
    const ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width / this.dpr, this.overlay.height / this.dpr);
    if (!this.mainSeries || !this.bars.length) { this.floatBar.hidden = true; return; }
    const cx = this.drawCtx();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cx.W, cx.H);
    ctx.clip();
    if (this.cfg.chartType === 'pnf') this.renderPointFigure(cx);
    this.renderIndicatorOverlays(cx);
    this.renderScriptLayers(cx);
    if (!this.app.hideDrawings) for (const d of this.drawings) renderDrawing(cx, d, d === this.selected);
    if (this.pending) renderDrawing(cx, this.pending, true);
    if (this.measure) renderDrawing(cx, this.measure, false);
    if (!this.app.hideDrawings) this.renderDrawingAlertBells(cx);
    this.renderEconEvents(cx);
    this.renderAlertLines(cx);
    this.renderTradeLines(cx);
    if (this.replay.selecting && this.mouse) this.renderReplaySelect(cx);
    ctx.restore();
    this.positionFloatBar(cx);
    this.renderQuickTrade();
    this.positionPlusButton();
  }

  /** Shading between indicator lines (Ichimoku cloud, channel bands) and the visible-range volume profile. */
  renderIndicatorOverlays(cx) {
    const { ctx } = cx, ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange();
    if (!r) return;
    for (const rt of this.runtimes) {
      if (rt.ind.visible === false || rt.chart || rt.ind.type === 'SCRIPT') continue;
      for (const f of rt.def?.fills || []) {
        const A = rt.outputs[f.a], Bo = rt.outputs[f.b], sa = rt.series[f.a], sb = rt.series[f.b];
        if (!A || !Bo || !sa || !sb) continue;
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            ctx.fillStyle = f.down && !run[0].up ? f.down : f.color;
            ctx.beginPath();
            ctx.moveTo(run[0].x, run[0].ya);
            for (const p of run) ctx.lineTo(p.x, p.ya);
            for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k].x, run[k].yb);
            ctx.closePath();
            ctx.fill();
          }
          run = [];
        };
        for (let i = Math.max(0, Math.floor(r.from) - 1); i <= Math.min(A.length - 1, Math.ceil(r.to) + 1); i++) {
          const pa = A[i], pb = Bo[i];
          const x = pa?.value != null && pb?.value != null ? ts.timeToCoordinate(pa.time) : null;
          const ya = x == null ? null : sa.priceToCoordinate(pa.value), yb = x == null ? null : sb.priceToCoordinate(pb.value);
          if (x == null || ya == null || yb == null) { flush(); continue; }
          const up = pa.value >= pb.value;
          if (f.down && run.length && run[run.length - 1].up !== up) { // lines cross: end this colour at the crossing point
            const p = run[run.length - 1], d1 = p.ya - p.yb, d2 = ya - yb, t = d1 / (d1 - d2);
            const xi = p.x + (x - p.x) * t, yi = p.ya + (ya - p.ya) * t;
            run.push({ x: xi, ya: yi, yb: yi, up: p.up });
            flush();
            run.push({ x: xi, ya: yi, yb: yi, up });
          }
          run.push({ x, ya, yb, up });
        }
        flush();
      }
      if (rt.ind.type === 'VPVR') this.renderVolumeProfile(cx, rt, r);
    }
  }
  /** Volume at price for the visible bars, drawn from the right edge: up / down volume, value area, point of control. */
  renderVolumeProfile(cx, rt, r) {
    const { ctx } = cx;
    const from = Math.max(0, Math.floor(r.from)), to = Math.min(this.bars.length - 1, Math.ceil(r.to));
    let seg = this.bars.slice(from, to + 1);
    const byCount = !seg.some(b => b.volume > 0); // feeds without volume (Twelve Data FX/metals): count bars instead
    if (byCount) seg = seg.map(b => ({ ...b, volume: 1 }));
    const vp = volumeProfile(seg, 0, seg.length - 1, clamp(Math.round(rt.ind.params.rows || 24), 4, 200), clamp(rt.ind.params.va || 70, 10, 100));
    const changed = !!rt.vp !== !!vp || rt.vp?.poc !== vp?.poc || rt.vp?.bins[0]?.lo !== vp?.bins[0]?.lo;
    rt.vp = vp ? { ...vp, byCount } : null;
    if (changed) this.updateLegends();
    if (!vp) return;
    const width = cx.W * 0.28, right = cx.W - 1;
    vp.bins.forEach((bin, k) => {
      const y1 = cx.priceToY(bin.hi), y2 = cx.priceToY(bin.lo);
      if (y1 == null || y2 == null) return;
      const top = Math.min(y1, y2) + 0.5, hgt = Math.max(1, Math.abs(y2 - y1) - 1);
      const inVa = k >= vp.vaLow && k <= vp.vaHigh, wu = width * bin.up / vp.max, wd = width * bin.down / vp.max;
      ctx.fillStyle = inVa ? 'rgba(41,98,255,0.42)' : 'rgba(41,98,255,0.18)';
      ctx.fillRect(right - wu - wd, top, wu, hgt);
      ctx.fillStyle = inVa ? 'rgba(251,192,45,0.48)' : 'rgba(251,192,45,0.2)';
      ctx.fillRect(right - wd, top, wd, hgt);
    });
    const pocY = cx.priceToY((vp.bins[vp.poc].lo + vp.bins[vp.poc].hi) / 2);
    if (pocY != null) { ctx.strokeStyle = '#f23645'; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(0, pocY); ctx.lineTo(cx.W, pocY); ctx.stroke(); }
  }

  /** Point & figure: X boxes for rising columns, O boxes for falling ones (the candles underneath are transparent). */
  renderPointFigure(cx) {
    const box = this.typeInfo?.box, B = this.bars;
    if (!(box > 0) || !B.length) return;
    const { ctx } = cx, ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange();
    if (!r) return;
    const k = candleColors(), from = Math.max(0, Math.floor(r.from)), to = Math.min(B.length - 1, Math.ceil(r.to));
    const ref = B[to].close, boxPx = Math.abs(cx.priceToY(ref) - cx.priceToY(ref + box));
    const s = Math.max(2, Math.min(ts.options().barSpacing * 0.8, boxPx * 0.9));
    let budget = 30000; // glyphs per frame; zoomed far out the columns are drawn as solid bars instead
    for (let i = from; i <= to; i++) budget -= Math.round((B[i].high - B[i].low) / box);
    const glyphs = budget > 0 && boxPx >= 4;
    ctx.lineWidth = Math.max(1, Math.min(2, s / 7));
    for (let i = from; i <= to; i++) {
      const b = B[i], x = ts.logicalToCoordinate(i);
      if (x == null) continue;
      ctx.strokeStyle = ctx.fillStyle = b.x ? k.up : k.down;
      if (!glyphs) {
        const y1 = cx.priceToY(b.high), y2 = cx.priceToY(b.low);
        if (y1 != null && y2 != null) ctx.fillRect(x - s / 2, Math.min(y1, y2), s, Math.max(1, Math.abs(y2 - y1)));
        continue;
      }
      for (let p = b.low; p < b.high - box * 1e-6; p += box) {
        const y = (cx.priceToY(p) + cx.priceToY(p + box)) / 2;
        if (!(y > -s && y < cx.H + s)) continue;
        const hs = s / 2 - 0.5;
        ctx.beginPath();
        if (b.x) { ctx.moveTo(x - hs, y - hs); ctx.lineTo(x + hs, y + hs); ctx.moveTo(x + hs, y - hs); ctx.lineTo(x - hs, y + hs); }
        else ctx.arc(x, y, hs, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  renderReplaySelect(cx) {
    const { ctx } = cx;
    const x = this.mouse.x;
    ctx.fillStyle = 'rgba(41,98,255,0.12)';
    ctx.fillRect(x, 0, cx.W - x, cx.H);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cx.H); ctx.stroke();
    const p = this.fromXY(x, 10);
    if (p.time != null) {
      ctx.font = `12px ${FONT}`;
      const text = `Start replay from ${fmtDateTime(p.time)} UTC`;
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = ACCENT;
      ctx.fillRect(clamp(x - w / 2, 2, cx.W - w - 2), 8, w, 22);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, clamp(x, w / 2 + 2, cx.W - w / 2 - 2), 19);
    }
  }

  /** Positions / orders of the replay session drawn as chart lines with draggable SL/TP. */
  tradeLines() {
    const b = this.tradeBroker;
    if (!b) return [];
    const q = b.quote, lines = [];
    for (const p of b.s.positions) {
      const pnl = b.unrealized(p);
      lines.push({ kind: 'entry', id: p.id, price: p.entry, color: p.side === 'buy' ? ACCENT : '#e91e63', text: `${p.side === 'buy' ? 'BUY' : 'SELL'} ${+p.lots.toFixed(4)}  ${fmtUsd(pnl, true)}`, ref: p });
      if (p.sl != null) lines.push({ kind: 'sl', id: p.id, price: p.sl, color: DOWN, text: `SL  ${fmtUsd(this.levelPnl(p, p.sl), true)}`, drag: true, ref: p });
      if (p.tp != null) lines.push({ kind: 'tp', id: p.id, price: p.tp, color: UP, text: `TP  ${fmtUsd(this.levelPnl(p, p.tp), true)}`, drag: true, ref: p });
    }
    for (const o of b.s.orders) {
      lines.push({ kind: 'order', id: o.id, price: o.price, color: '#ff9800', text: `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${+o.lots.toFixed(4)}`, drag: true, ref: o, order: true });
      if (o.sl != null) lines.push({ kind: 'osl', id: o.id, price: o.sl, color: DOWN, text: 'SL', drag: true, ref: o, order: true });
      if (o.tp != null) lines.push({ kind: 'otp', id: o.id, price: o.tp, color: UP, text: 'TP', drag: true, ref: o, order: true });
    }
    void q;
    return lines;
  }
  levelPnl(p, price) {
    const s = this.spec, dir = p.side === 'buy' ? 1 : -1;
    return quoteToUsd(s, (price - p.entry) * dir * p.lots * s.contractSize, price);
  }
  renderTradeLines(cx) {
    const { ctx } = cx;
    const hits = [];
    if (chartStyle().showTradeLines === false) { this.tradeLineHits = []; return; }
    for (const l of this.tradeLines()) {
      const y = cx.priceToY(this.dragLine?.id === l.id && this.dragLine.kind === l.kind ? this.dragLine.price : l.price);
      if (y == null) continue;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(l.kind === 'entry' ? [] : [6, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cx.W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `12px ${FONT}`;
      const w = ctx.measureText(l.text).width + 14, xb = 20, x0 = cx.W - w - xb - 90;
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x0, y - 10, w + xb, 20, 3) : ctx.rect(x0, y - 10, w + xb, 20);
      ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(l.text, x0 + 7, y);
      // x : close position / cancel order / remove SL-TP
      const bx = x0 + w;
      ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(bx, y - 10, xb, 20);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(bx + 6, y - 4); ctx.lineTo(bx + 14, y + 4); ctx.moveTo(bx + 14, y - 4); ctx.lineTo(bx + 6, y + 4); ctx.stroke();
      hits.push({ x1: bx, x2: bx + xb, y1: y - 10, y2: y + 10, line: l });
    }
    this.tradeLineHits = hits;
  }
  hitTradeLine(y) {
    for (const l of this.tradeLines()) {
      if (!l.drag) continue;
      const ly = this.mainSeries.priceToCoordinate(l.price);
      if (ly != null && Math.abs(ly - y) <= 5) return l;
    }
    return null;
  }

  // ---------------------------------------------------------------- price alerts on the chart
  /** Armed alerts of this symbol (hidden in Bar Replay: they watch the live market, not the replay date). */
  alertLines() { return this.inReplay ? [] : (this.app.alerts?.forSymbol(this.cfg.symbol) || []); }
  /** Dotted orange line with a 🔔 label; the label opens the alert, × deletes it, the line drags to a new price. */
  renderAlertLines(cx) {
    const { ctx } = cx, hits = [];
    for (const a of this.alertLines()) {
      const price = this.dragAlert?.id === a.id ? this.dragAlert.price : a.price;
      const y = cx.priceToY(price);
      if (y == null || y < -10 || y > cx.H + 10) continue;
      const color = '#ff9800';
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cx.W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `12px ${FONT}`;
      const text = `🔔 ${this.app.alerts.condLabel(a.cond)} ${fmtPrice(price, this.prec)}${a.repeat ? ' ↻' : ''}`;
      const w = ctx.measureText(text).width + 14, xb = 18, x0 = cx.W - w - xb - 8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x0, y - 10, w + xb, 20, 3) : ctx.rect(x0, y - 10, w + xb, 20);
      ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x0 + 7, y);
      const bx = x0 + w;
      ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(bx, y - 10, xb, 20);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(bx + 5, y - 4); ctx.lineTo(bx + 13, y + 4); ctx.moveTo(bx + 13, y - 4); ctx.lineTo(bx + 5, y + 4); ctx.stroke();
      hits.push({ x0, xClose: bx, x2: bx + xb, y1: y - 10, y2: y + 10, alert: a });
    }
    this.alertHits = hits;
  }
  /** High-impact economic events for the symbol's currencies: dots along the bottom, details on hover. */
  renderEconEvents(cx) {
    const st = chartStyle();
    if (st.showEconEvents === false || !this.app.calendar?.data) return;
    const ev = this.app.calendar.chartEvents(this.cfg.symbol, st.econMedium);
    if (!ev.length) return;
    const { ctx } = cx, y = cx.H - 9, m = this.mouse;
    let hover = null;
    for (const e of ev) {
      const x = cx.timeToX(e.time);
      if (x == null || x < -6 || x > cx.W + 6) continue;
      const c = e.impact === 'High' ? '#f23645' : '#ff9800';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
      ctx.strokeStyle = this.app.theme === 'dark' ? '#131722' : '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      if (m && Math.abs(m.x - x) <= 6 && m.y >= y - 12 && m.y <= cx.H) hover = { e, x, c };
    }
    if (!hover) return;
    const { e, x, c } = hover;
    ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y - 6); ctx.stroke(); ctx.setLineDash([]);
    const lines = [`${e.country} · ${e.title}`, `${fmtChartTime(e.time, 'full')} · ${e.impact} impact`, [e.actual && `Actual ${e.actual}`, e.forecast && `Forecast ${e.forecast}`, e.previous && `Previous ${e.previous}`].filter(Boolean).join('  ') || ' '];
    ctx.font = `12px ${FONT}`;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, hh = lines.length * 16 + 10;
    const bx = clamp(x - w / 2, 4, cx.W - w - 4), by = y - 14 - hh;
    ctx.fillStyle = this.app.theme === 'dark' ? '#1e222d' : '#ffffff';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, hh, 6) : ctx.rect(bx, by, w, hh); ctx.fill();
    ctx.strokeStyle = c; ctx.stroke();
    ctx.fillStyle = this.app.theme === 'dark' ? '#d1d4dc' : '#131722'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 6 + i * 16));
  }

  /** 🔔 next to drawings that have an armed line alert. */
  renderDrawingAlertBells(cx) {
    const al = this.app.alerts;
    if (!al || this.inReplay) return;
    for (const a of al.list) {
      if (a.kind !== 'drawing' || a.symbol !== this.cfg.symbol || !al.armed(a)) continue;
      const d = this.drawings.find(x => x.id === a.drawingId), G = d && !d.hidden ? cx.geom?.get(d) : null;
      const p = G?.handles[G.handles.length - 1];
      if (!p) continue;
      cx.ctx.font = `13px ${FONT}`; cx.ctx.textAlign = 'left'; cx.ctx.textBaseline = 'bottom';
      cx.ctx.fillText('🔔', p.x + 7, p.y - 5);
    }
  }
  hitAlertLine(y) {
    for (const a of this.alertLines()) {
      const ly = this.mainSeries?.priceToCoordinate(a.price);
      if (ly != null && Math.abs(ly - y) <= 5) return a;
    }
    return null;
  }

  /** "+" on the price axis follows the cursor while Bar Replay trades this symbol. */
  positionPlusButton() {
    const canTrade = chartStyle().showOrderPlus !== false && this.tradeBroker?.quote;
    const m = this.mouse;
    const hovering = this.plusBtn.matches(':hover');
    if (!canTrade || !m || this.pending || this.drag || m.y < 0 || m.y > this.plotH() || m.x < 0 || m.x > this.mainPane.clientWidth) {
      if (!this.plusBtn.hidden && !hovering) this.plusBtn.hidden = true;
      return;
    }
    if (hovering) return;
    const price = this.mainSeries.coordinateToPrice(m.y);
    if (price == null) return;
    this.plusPrice = price;
    this.plusBtn.hidden = false;
    this.plusBtn.style.left = `${this.plotW() + 3}px`;
    this.plusBtn.style.top = `${m.y - 10}px`;
  }
  /** Menu of buy/sell orders at `price`: a limit on the favourable side of the market, a stop otherwise. */
  openOrderMenu(price, clientX, clientY, localX) {
    const app = this.app;
    app.closePopovers();
    let menu = document.getElementById('orderMenu');
    if (!menu) { menu = h('div', { id: 'orderMenu', class: 'menu order-menu', hidden: true }); document.body.append(menu); }
    const close = () => { menu.hidden = true; };
    const p = this.prec;
    const items = [h('div', { class: 'menu-title' }, `${this.cfg.symbol} @ ${fmtPrice(price, p)}`)];
    const canTrade = this.tradeBroker?.quote && (this.inReplay || this.app.activeView === this);
    if (canTrade) {
      for (const side of ['buy', 'sell']) {
        const plan = app.trading.chartOrderPlan(side, price);
        const extra = [plan.sl != null ? 'SL' : '', plan.tp != null ? 'TP' : ''].filter(Boolean).join(' + ');
        items.push(h('button', { onclick: () => { close(); app.trading.placeAtPrice(side, price); } },
          h('span', { class: `om-dot ${side}` }), `${side === 'buy' ? 'Buy' : 'Sell'} ${plan.type === 'limit' ? 'Limit' : 'Stop'} ${+plan.lots.toFixed(4)} @ ${fmtPrice(plan.price, p)}`,
          h('small', null, extra || plan.note || '')));
      }
      const q = this.tradeBroker.quote;
      items.push(h('div', { class: 'menu-sep' }),
        h('button', { onclick: () => { close(); app.trading.quickOrder('buy'); } }, h('span', { class: 'om-dot buy' }), 'Buy at market', h('small', null, fmtPrice(q.ask, p))),
        h('button', { onclick: () => { close(); app.trading.quickOrder('sell'); } }, h('span', { class: 'om-dot sell' }), 'Sell at market', h('small', null, fmtPrice(q.bid, p))));
    } else {
      const P = this.app.paper;
      if (!this.inReplay && P && !P.enabled) items.push(h('button', { onclick: () => { close(); P.setEnabled(true); this.app.showPanel('trading'); } }, icon('send'), 'Paper trade this chart (live prices)'));
      items.push(h('button', { onclick: () => { close(); this.replay.openDialog(this.cfg.symbol); } }, icon('replay'), this.inReplay ? `Bar Replay is trading ${this.replay.symbol}` : 'Bar Replay to practise on history'));
    }
    const lt = this.chart.timeScale().coordinateToLogical(localX ?? this.plotW() / 2);
    items.push(h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { close(); app.alerts.quickAdd(this, price); } }, icon('bell'), `Add alert @ ${fmtPrice(price, p)}`, h('small', null, 'crossing')),
      h('button', { onclick: () => { close(); app.alerts.openDialog({ symbol: this.cfg.symbol, price }); } }, icon('bell'), 'Alert options…'),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { close(); this.addDrawing({ id: uid(), type: 'hline', pts: [{ time: lt == null ? this.bars[this.bars.length - 1].time : this.logicalToTime(lt), price }], color: ACCENT }); } },
        icon('hline'), `Horizontal line @ ${fmtPrice(price, p)}`),
      h('button', { onclick: () => { close(); app.openSymbolSearch('compare'); } }, icon('compare'), 'Compare symbol…'),
      h('button', { onclick: () => { close(); this.exportCsv(); } }, icon('download'), 'Export chart data…', h('small', null, 'CSV')),
      h('div', { class: 'menu-sep' }),
      h('button', { onclick: () => { close(); app.openChartSettings(); } }, icon('gear'), 'Chart display settings…', h('small', null, 'colours, grid, background')));
    menu.replaceChildren(...items);
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${clamp(clientX, 4, window.innerWidth - r.width - 4)}px`;
    menu.style.top = `${clamp(clientY, 4, window.innerHeight - r.height - 4)}px`;
  }

  renderQuickTrade() {
    const show = chartStyle().showQuickTrade !== false && this.tradeBroker?.quote &&
      (this.app.views.length === 1 || this.app.activeView === this);
    if (!show) { if (!this.quick.hidden) this.quick.hidden = true; return; }
    const q = this.tradeBroker.quote;
    const key = `${q.bid}|${q.spread}`;
    if (this.quick.dataset.key === key && !this.quick.hidden) return;
    this.quick.dataset.key = key;
    this.quick.hidden = false;
    const p = this.prec;
    this.quick.replaceChildren(
      h('button', { class: 'qt sell', title: 'Sell at market (bid)', onclick: () => this.app.trading.quickOrder('sell') }, h('small', null, 'SELL'), fmtPrice(q.bid, p)),
      h('span', { class: 'qt-spread', title: 'Spread' }, fmtNum(q.spread, p)),
      h('button', { class: 'qt buy', title: 'Buy at market (ask)', onclick: () => this.app.trading.quickOrder('buy') }, h('small', null, 'BUY'), fmtPrice(q.ask, p)),
    );
  }

  positionFloatBar(cx) {
    const d = this.selected;
    if (!d || this.app.hideDrawings || !this.drawings.includes(d)) { this.floatBar.hidden = true; return; }
    const pts = d.pts.map(p => this.toXY(p)).filter(p => p.x != null && p.y != null);
    if (!pts.length) { this.floatBar.hidden = true; return; }
    const x = clamp(Math.min(...pts.map(p => p.x)), 4, cx.W - 220);
    let y = Math.min(...pts.map(p => p.y)) - 48;
    if (d.type === 'long' || d.type === 'short') y = Math.min(this.mainSeries.priceToCoordinate(Math.max(d.stop, d.target)) ?? y, y) - 48;
    if (this.floatBar.dataset.id !== d.id) this.buildFloatBar(d);
    this.floatBar.style.left = `${x}px`;
    this.floatBar.style.top = `${clamp(y, 34, cx.H - 40)}px`;
    this.floatBar.hidden = false;
  }
  /** Style bar above the selected drawing: colour, width, line style, extend, fill, text, lock, clone, templates, delete. */
  buildFloatBar(d) {
    this.floatBar.dataset.id = d.id;
    const save = () => { this.app.saveDrawings(this.cfg.symbol); this.lastOverlaySig = null; };
    const color = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : ACCENT, title: 'Colour' });
    color.addEventListener('input', () => { d.color = color.value; if (d.type === 'brush') this.app.brushColor = color.value; save(); });
    const kids = [h('span', { class: 'fb-name' }, toolTitle(d.type)), color];
    const select = (title, value, options, onPick) => {
      const s = h('select', { title }, options.map(([v, l]) => h('option', { value: String(v) }, l)));
      s.value = String(value);
      s.addEventListener('change', () => { onPick(s.value); save(); });
      return s;
    };
    if (LINE_LIKE.has(d.type)) {
      kids.push(select('Line width', d.width || (d.type === 'highlighter' ? 14 : 2), (d.type === 'highlighter' ? [8, 14, 20, 28] : [1, 2, 3, 4, 6, 8]).map(w => [w, `${w}px`]),
        v => { d.width = Number(v); if (d.type === 'brush') this.app.brushWidth = d.width; }));
      if (d.type !== 'brush' && d.type !== 'highlighter') kids.push(select('Line style', d.style || 'solid', [['solid', '———'], ['dashed', '– – –'], ['dotted', '·····']], v => { d.style = v; }));
    }
    if (d.type === 'trend') kids.push(select('Extend', d.extend || 'none', [['none', 'No extend'], ['left', 'Extend left'], ['right', 'Extend right'], ['both', 'Extend both']], v => { d.extend = v; }));
    if (d.type === 'fib' || d.type === 'fibext') kids.push(select('Extend levels', d.extend || 'none', [['none', 'Levels: to end'], ['right', 'Levels: extend right']], v => { d.extend = v; }));
    if (d.type === 'regression') kids.push(select('Deviation', d.deviation || 2, [[1, '±1σ'], [1.5, '±1.5σ'], [2, '±2σ'], [2.5, '±2.5σ'], [3, '±3σ']], v => { d.deviation = Number(v); }));
    if (FILLABLE.has(d.type) || d.type === 'fib' || d.type === 'fibext') {
      const on = d.type === 'brush' ? !!d.fill : d.fill !== false;
      const fillBtn = h('button', { class: on ? 'active' : '', title: 'Background fill', onclick: () => { d.fill = !(d.type === 'brush' ? !!d.fill : d.fill !== false); fillBtn.classList.toggle('active'); save(); } }, 'Fill');
      kids.push(fillBtn);
    }
    if (d.type === 'text' || d.type === 'note' || d.type === 'callout' || d.type === 'icon' || d.type === 'arrowup' || d.type === 'arrowdown') {
      const sizes = d.type === 'icon' ? [16, 20, 26, 34, 44] : [10, 12, 14, 16, 20, 24, 32];
      kids.push(select('Size', d.size || (d.type === 'icon' ? 26 : d.type === 'note' || d.type === 'callout' ? 13 : 14), sizes.map(z => [z, `${z}`]), v => { d.size = Number(v); }));
    }
    if (HAS_TEXT.has(d.type)) kids.push(h('button', { title: d.type === 'text' ? 'Edit text' : 'Text / label', onclick: () => this.app.editText(this, d) }, icon('edit')));
    if (d.type === 'icon') kids.push(h('button', { title: 'Change icon', onclick: e => this.app.pickIcon(e.currentTarget, ic => { d.icon = ic; save(); }) }, d.icon || '⭐'));
    if (d.type === 'long' || d.type === 'short') {
      kids.push(h('button', { class: 'fb-order', title: 'Place this trade (replay)', onclick: () => this.app.trading.orderFromPositionTool(this, d) }, icon('send'), 'Trade'));
    }
    if (DRAWING_ALERT_TYPES.has(d.type)) {
      const has = this.app.alerts?.list.some(a => a.kind === 'drawing' && a.drawingId === d.id);
      kids.push(h('button', { class: has ? 'active' : '', title: has ? 'Edit the alert on this line' : 'Alert me when price crosses this line', onclick: () => { this.app.alerts.addDrawingAlert(this, d); this.buildFloatBar(d); } }, icon('bell')));
    }
    const lockBtn = h('button', { class: d.locked ? 'active' : '', title: d.locked ? 'Unlock (allow moving)' : 'Lock in place', onclick: () => { d.locked = !d.locked; save(); this.buildFloatBar(d); } }, icon(d.locked ? 'lock' : 'unlock'));
    kids.push(lockBtn,
      h('button', { title: 'Clone', onclick: () => { const c = cloneDrawing(this.drawCtx(), d, uid()); this.addDrawing(c); toast(`${toolTitle(d.type)} cloned — drag it into place`); } }, icon('copy')),
      h('button', { title: 'Template: save this style as the default, or apply a saved one', onclick: e => this.app.openDrawingTemplates(this, d, e.currentTarget) }, icon('gear')),
      h('button', { title: 'Delete (Del)', onclick: () => this.removeDrawing(d) }, icon('trash')));
    this.floatBar.replaceChildren(...kids);
  }

  // ---------------------------------------------------------------- drawing interaction
  addDrawing(d) {
    this.drawings.push(d);
    this.selected = d;
    this.app.saveDrawings(this.cfg.symbol);
  }
  /** Scroll the chart so a drawing is in view and select it (object tree). */
  revealDrawing(d) {
    const t = d.pts[0]?.time;
    if (t != null) {
      const l = this.timeToLogical(t), r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && (l < r.from || l > r.to)) { const w = r.to - r.from; this.setAllRanges({ from: l - w / 2, to: l + w / 2 }); }
    }
    this.selected = d;
  }
  removeDrawing(d) {
    const list = this.drawings;
    const i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1);
    if (this.selected === d) this.selected = null;
    this.floatBar.hidden = true;
    this.app.saveDrawings(this.cfg.symbol);
  }
  hitTest(x, y) {
    if (this.app.hideDrawings) return null;
    const cx = this.drawCtx();
    const list = this.drawings;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = hitDrawing(cx, list[i], x, y);
      if (r) return { d: list[i], handle: r.handle };
    }
    return null;
  }

  /** A new drawing in the user's default style for that tool (Template → save as default). */
  newDrawing(type, pts, extra = {}) {
    return { id: uid(), type, pts, color: type === 'highlighter' ? '#ffeb3b' : ACCENT, ...(this.app.drawDefault?.(type) || {}), ...extra };
  }
  /** Chart point under the cursor; with the magnet on, the price snaps to the nearest open / high / low / close. */
  drawPoint(x, y) {
    const p = this.fromXY(x, y);
    if (!this.app.magnet || p.time == null || p.price == null) return p;
    const b = this.bars[this.indexOfTime(p.time)];
    if (!b) return p;
    let best = b.open;
    for (const v of [b.high, b.low, b.close]) if (Math.abs(v - p.price) < Math.abs(best - p.price)) best = v;
    return { time: p.time, price: best };
  }

  newPositionTool(type, p) {
    const n = this.bars.length;
    const a = atr(this.bars.slice(-200), 14);
    let dist = a[a.length - 1];
    if (!(dist > 0)) dist = p.price * 0.005;
    dist *= 1.5;
    const dir = type === 'long' ? 1 : -1;
    const iv = tfSec(this.cfg.tf);
    void n;
    return { id: uid(), type, pts: [p], stop: p.price - dir * dist, target: p.price + dir * dist * 2, endTime: p.time + iv * 25, color: ACCENT };
  }

  wirePointer() {
    const pane = this.mainPane;
    const block = e => { e.preventDefault(); e.stopPropagation(); this.suppressMouse = true; };

    pane.addEventListener('pointerdown', e => {
      this.suppressMouse = false;
      if (e.button !== 0 || !this.mainSeries || !this.bars.length) return;
      if (e.target.closest('.float-bar, .quick-trade, .legend .lg-row, .empty-state')) return;
      const { x, y } = this.localXY(e);
      if (!this.inPlot(x, y)) return;
      const app = this.app;

      if (this.replay.selecting) {
        block(e);
        const p = this.fromXY(x, y);
        if (p.time != null) this.replay.onBarSelected(this, p.time);
        return;
      }
      if (this.measure && !this.pending) this.measure = null;
      app.closePopovers();
      let tool = app.tool;
      if (tool === 'cursor' && e.shiftKey) tool = 'measure';

      if (tool === 'cursor') {
        const xHit = this.inReplay && this.tradeLineHits?.find(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
        if (xHit) { block(e); this.app.trading.removeLevel(xHit.line); return; }
        // alert label: × deletes, the rest opens the alert; the line itself drags to a new price
        const aHit = this.alertHits?.find(r => x >= r.x0 && x <= r.x2 && y >= r.y1 && y <= r.y2);
        if (aHit) { block(e); if (x >= aHit.xClose) this.app.alerts.remove(aHit.alert.id, true); else this.app.alerts.openDialog({ id: aHit.alert.id }); return; }
        const al = this.hitAlertLine(y);
        if (al) { block(e); this.dragAlert = { id: al.id, price: al.price }; pane.classList.add('dragging'); return; }
        const line = this.hitTradeLine(y);
        if (line) {
          block(e);
          this.dragLine = { ...line };
          pane.classList.add('dragging');
          return;
        }
        const hit = this.hitTest(x, y);
        if (hit) {
          block(e);
          this.selected = hit.d;
          // locked drawings (or "lock all") can be selected and edited, not moved
          if (hit.d.locked || app.drawingsLocked) return;
          this.drag = { d: hit.d, handle: hit.handle, start: this.fromXY(x, y), orig: structuredClone(hit.d), moved: false };
          // grouped drawings (object tree) move together
          if (hit.handle === -1 && hit.d.group) this.drag.members = this.drawings.filter(o => o !== hit.d && o.group === hit.d.group && !o.locked).map(o => ({ d: o, orig: structuredClone(o) }));
          pane.classList.add('dragging');
        } else this.selected = null;
        return;
      }
      block(e);
      if (tool === 'eraser') { const hit = this.hitTest(x, y); if (hit) this.removeDrawing(hit.d); return; }
      const p = this.drawPoint(x, y);
      if (p.time == null || p.price == null) return;
      if (this.pending) {
        // multi-point tools: each click fixes the point under the mouse and starts the next one
        const pd = this.pending;
        pd.pts[pd.pts.length - 1] = p;
        if (pd.type === 'path' || pd.pts.length < pointsOf(pd.type)) { pd.pts.push({ ...p }); this.pendingDown = null; return; }
        this.finalizePending();
        return;
      }
      if (ONE_CLICK.has(tool)) {
        if (tool === 'long' || tool === 'short') this.addDrawing(this.newPositionTool(tool, p));
        else if (tool === 'text' || tool === 'note') { const d = this.newDrawing(tool, [p], { text: '', size: tool === 'text' ? 14 : 13 }); this.addDrawing(d); app.editText(this, d, true); }
        else if (tool === 'icon') this.addDrawing(this.newDrawing('icon', [p], { icon: app.lastIcon || '⭐' }));
        else this.addDrawing(this.newDrawing(tool, [p]));
        app.setTool('cursor');
        return;
      }
      if (pointsOf(tool) === 'free') {
        // freehand stroke: points in chart space (fractional time) so it stays anchored when zooming/scrolling
        this.pending = this.newDrawing(tool, [this.fromXYExact(x, y)], tool === 'brush' ? { color: app.brushColor || this.app.drawDefault?.('brush')?.color || ACCENT, width: app.brushWidth || 2 } : {});
        this.brushLast = { x, y };
        return;
      }
      this.pending = this.newDrawing(tool, [p, { ...p }]);
      this.pendingDown = pointsOf(tool) === 2 ? { x, y } : null; // two-point tools can also be dragged out
    }, true);
    pane.addEventListener('mousedown', e => { if (this.suppressMouse) { e.stopPropagation(); e.preventDefault(); } }, true);
    // Right-click: buy/sell limit or stop at the cursor price (Bar Replay practice trading)
    pane.addEventListener('contextmenu', e => {
      if (!this.mainSeries || !this.bars.length) return;
      const { x, y } = this.localXY(e);
      if (!this.inPlot(x, y)) return;
      e.preventDefault();
      const price = this.mainSeries.coordinateToPrice(y);
      if (price != null) this.openOrderMenu(price, e.clientX, e.clientY, x);
    });
    this.plusBtn = h('button', { class: 'axis-plus', title: 'Place an order at this price', hidden: true, onclick: e => {
      e.stopPropagation();
      const r = this.plusBtn.getBoundingClientRect();
      this.openOrderMenu(this.plusPrice, r.left, r.bottom + 4, this.plotW() - 1);
    } }, '+');
    this.mainPane.append(this.plusBtn);
    pane.addEventListener('dblclick', e => {
      if (this.pending?.type === 'path') { e.stopPropagation(); this.finalizePending(); return; }
      const { x, y } = this.localXY(e);
      const hit = this.hitTest(x, y);
      if (hit && HAS_TEXT.has(hit.d.type) && ['text', 'note', 'callout'].includes(hit.d.type)) { e.stopPropagation(); this.app.editText(this, hit.d); }
    }, true);

    this.onWinMove = e => {
      if (!this.mainSeries || !this.bars.length) return;
      const { x, y } = this.localXY(e);
      const over = e.target instanceof Node && pane.contains(e.target);
      this.mouse = over ? { x, y } : (this.drag || this.dragLine || this.dragAlert || this.pending ? { x, y } : null);
      const cx = clamp(x, 0, this.plotW()), cy = clamp(y, 0, this.plotH());
      if (this.dragLine) { const pr = this.mainSeries.coordinateToPrice(cy); if (pr != null) this.dragLine.price = pr; return; }
      if (this.dragAlert) { const pr = this.mainSeries.coordinateToPrice(cy); if (pr != null) this.dragAlert.price = pr; return; }
      if (this.drag) {
        const cur = typeof this.drag.handle === 'number' && this.drag.handle >= 0 ? this.drawPoint(cx, cy) : this.fromXY(cx, cy);
        if (cur.time == null || cur.price == null) return;
        this.drag.moved = true;
        const dcx = this.drawCtx();
        dragDrawing(dcx, this.drag.d, this.drag, cur);
        for (const m of this.drag.members || []) dragDrawing(dcx, m.d, { handle: -1, start: this.drag.start, orig: m.orig }, cur);
        return;
      }
      if (pointsOf(this.pending?.type) === 'free') {
        if (this.brushLast && Math.hypot(cx - this.brushLast.x, cy - this.brushLast.y) >= 2.5) {
          const cur = this.fromXYExact(cx, cy);
          if (cur.time != null && cur.price != null) { this.pending.pts.push(cur); this.brushLast = { x: cx, y: cy }; }
        }
        return;
      }
      if (this.pending) {
        const cur = this.drawPoint(cx, cy);
        if (cur.time != null && cur.price != null) this.pending.pts[this.pending.pts.length - 1] = cur;
        return;
      }
      if (this.app.tool === 'cursor' && over && !this.replay.selecting) {
        const tl = this.inPlot(x, y) && (this.hitTradeLine(y) || this.hitAlertLine(y));
        const hit = !tl && this.inPlot(x, y) ? this.hitTest(x, y) : null;
        this.hoverDrawing = hit?.d || null;
        pane.classList.toggle('hover-drawing', !!hit);
        pane.classList.toggle('hover-line', !!tl);
      }
    };
    this.onWinUp = e => {
      if (this.dragAlert) {
        const { id, price } = this.dragAlert;
        this.dragAlert = null;
        pane.classList.remove('dragging');
        const a = this.app.alerts.list.find(x => x.id === id);
        if (a && price !== a.price) {
          const p = Number(price.toFixed(this.prec));
          this.app.alerts.update(id, { price: p });
          toast(`🔔 Alert moved to ${fmtPrice(p, this.prec)}`);
        }
        return;
      }
      if (this.dragLine) {
        const l = this.dragLine;
        this.dragLine = null;
        pane.classList.remove('dragging');
        this.app.trading.moveLevel(l, l.price);
        return;
      }
      if (this.drag) {
        if (this.drag.moved) this.app.saveDrawings(this.cfg.symbol);
        this.drag = null;
        pane.classList.remove('dragging');
        return;
      }
      if (pointsOf(this.pending?.type) === 'free') {
        const d = this.pending;
        this.pending = null; this.brushLast = null;
        if (d.pts.length > 1) this.addDrawing(d);
        this.app.setTool('cursor');
        return;
      }
      if (this.pending && this.pendingDown) {
        const { x, y } = this.localXY(e);
        if (Math.hypot(x - this.pendingDown.x, y - this.pendingDown.y) > 6) this.finalizePending();
        else this.pendingDown = null;
      }
    };
    window.addEventListener('pointermove', this.onWinMove);
    window.addEventListener('pointerup', this.onWinUp);
  }

  finalizePending() {
    const d = this.pending;
    this.pending = null; this.pendingDown = null;
    if (!d) return;
    if (d.type === 'path') { // a double-click adds the same point a few times
      const P = d.pts.map(p => this.toXY(p));
      d.pts = d.pts.filter((p, i) => i === 0 || Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y) > 3);
      if (d.pts.length < 2) { this.app.setTool('cursor'); return; }
    }
    if (d.type === 'measure') this.measure = d;
    else this.addDrawing(d);
    if (d.type === 'callout') this.app.editText(this, d, true);
    this.app.setTool('cursor');
  }

  cancelInteraction() {
    this.pending = null; this.measure = null; this.selected = null; this.dragLine = null; this.dragAlert = null;
  }

  // ---------------------------------------------------------------- snapshot
  screenshot() {
    const shots = this.allCharts().map(c => c.takeScreenshot());
    const W = Math.max(...shots.map(s => s.width));
    const H = shots.reduce((a, s) => a + s.height, 0);
    const out = h('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    let y = 0;
    shots.forEach((s, i) => {
      ctx.drawImage(s, 0, y);
      if (i === 0) ctx.drawImage(this.overlay, 0, 0, s.width, s.height);
      y += s.height;
    });
    const scale = shots[0].width / this.mainPane.clientWidth;
    ctx.font = `${Math.round(14 * scale)}px ${FONT}`;
    ctx.fillStyle = themeColors(this.app.theme).text;
    ctx.textBaseline = 'top';
    const last = this.bars[this.bars.length - 1];
    ctx.fillText(`${this.cfg.symbol} · ${tfLabel(this.cfg.tf)} · ${last ? fmtDateTime(last.time) + ' UTC' : ''}${this.inReplay ? ' · Replay' : ''} — ChartDesk`, 10 * scale, 8 * scale);
    return out;
  }
}

function mergeBars(a, b) {
  const map = new Map();
  for (const x of a) map.set(x.start, x);
  for (const x of b) map.set(x.start, x);
  return [...map.values()].sort((p, q) => p.start - q.start);
}

/** Index of the first element >= t in a sorted array. */
function lowerIdx(a, t) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
