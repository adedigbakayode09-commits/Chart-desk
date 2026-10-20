// Bar Replay: step through history one bar (or one intrabar slice) at a time, trade it with the broker
// emulator, rewind, and resume later. Every chart in the layout is clamped to the replay cursor, so no
// future price data is ever displayed.

import { $, h, icon, kv, uid, toast, openModal, confirmBox, formFields, fmtDateTime, fmtUsd, fmtDate, parseUtcInput, toUtcInput, clamp } from './util.js';
import { getMinutes, nextMinute, prevMinute, spec, SYMBOLS, tfLabel, tdRange, fetchBars, providerLabel } from './data.js';
import { Broker, canTrade, EXECUTION_NOTES } from './core/broker.js';
import { TF, bucketOf } from './core/sessions.js';

const SPEEDS = [0.5, 1, 2, 3, 5, 10, 20];
const STEPS = [['bar', 'Chart bar'], ['1m', '1 minute'], ['5m', '5 minutes'], ['15m', '15 minutes'], ['30m', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours']];
const MAX_SNAPSHOTS = 3000;

export class Replay {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.selecting = false;
    this.cursor = null;
    this.symbol = null;
    this.broker = null;
    this.session = null;
    this.snapshots = [];
    this.mode = 'bar';
    this.speed = 1;
    this.playing = false;
    this.busy = false;
    this.bar = $('#replayBar');
    this.buildBar();
  }

  // ---------------------------------------------------------------- UI
  buildBar() {
    this.cursorLabel = h('span', { class: 'rp-cursor' });
    this.playBtn = h('button', { class: 'rp-btn', title: 'Play / pause (Shift+→ steps)', onclick: () => this.togglePlay() }, icon('play'));
    this.speedSel = h('select', { title: 'Steps per second', onchange: () => { this.speed = Number(this.speedSel.value); this.persist(); } },
      SPEEDS.map(s => h('option', { value: s }, `${s}x`)));
    this.stepSel = h('select', { title: 'What one step reveals', onchange: () => { this.mode = this.stepSel.value; this.persist(); } },
      STEPS.map(([k, l]) => h('option', { value: k }, `Step: ${l}`)));
    this.jumpInput = h('input', { type: 'datetime-local', title: 'Jump to date/time (UTC)' });
    this.sessionLabel = h('span', { class: 'rp-session' });
    this.selectHint = h('span', { class: 'rp-hint', hidden: true }, 'Click a bar on the chart — replay starts after it.');
    this.bar.replaceChildren(
      h('span', { class: 'rp-title' }, icon('replay'), 'Replay'),
      this.selectHint,
      h('div', { class: 'rp-controls' },
        h('button', { class: 'rp-btn', title: 'Select a new start bar on the chart (keeps no trades after it)', onclick: () => this.beginSelect(null) }, icon('scissors')),
        h('button', { class: 'rp-btn', title: 'Step back (Shift+←)', onclick: () => this.stepBack() }, icon('stepBack')),
        this.playBtn,
        h('button', { class: 'rp-btn', title: 'Step forward (Shift+→)', onclick: () => this.stepForward() }, icon('stepFwd')),
        this.speedSel, this.stepSel,
        h('span', { class: 'rp-sep' }),
        this.jumpInput,
        h('button', { class: 'btn small', onclick: () => { const t = parseUtcInput(this.jumpInput.value); if (t) this.jumpTo(t); } }, 'Go'),
        h('span', { class: 'rp-sep' }),
        this.cursorLabel),
      h('div', { class: 'spacer' }),
      this.sessionLabel,
      h('button', { class: 'btn small', title: 'Sessions', onclick: () => this.openDialog() }, icon('folder'), 'Sessions'),
      h('button', { class: 'btn small danger', title: 'Leave replay (progress is saved)', onclick: () => this.exit() }, 'Exit replay'),
    );
  }

  updateBar() {
    this.bar.hidden = !(this.active || this.selecting);
    this.app.layoutChanged?.();
    if (!this.active) { this.selectHint.hidden = !this.selecting; return; }
    this.selectHint.hidden = !this.selecting;
    this.cursorLabel.textContent = `${fmtDateTime(this.cursor)} UTC`;
    this.jumpInput.value = toUtcInput(this.cursor);
    this.speedSel.value = String(this.speed);
    // Twelve Data replays candle by candle (no guaranteed 1-minute history underneath).
    const candleOnly = spec(this.symbol)?.provider === 'twelvedata';
    if (this.stepSel.dataset.candleOnly !== String(candleOnly)) {
      this.stepSel.dataset.candleOnly = String(candleOnly);
      this.stepSel.replaceChildren(...(candleOnly ? [['bar', 'Next candle']] : STEPS).map(([k, l]) => h('option', { value: k }, candleOnly ? l : `Step: ${l}`)));
    }
    if (candleOnly) this.mode = 'bar';
    this.stepSel.value = this.mode;
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    const eq = this.broker ? this.broker.equity : 0;
    this.sessionLabel.textContent = `${this.session.name} · ${this.symbol} · Equity ${fmtUsd(eq)}`;
    this.app.setStatus?.(null);
  }

  // ---------------------------------------------------------------- sessions dialog
  async openDialog(prefSymbol) {
    const modal = $('#sessionModal');
    const sessions = (await kv.get('sessions', [])) || [];
    const active = this.app.activeView;
    const symbol = prefSymbol || (canTrade(active?.spec) ? active.symbol : 'XAUUSD');
    const s = spec(symbol) || spec('XAUUSD');
    const tradable = SYMBOLS.filter(x => canTrade(x));
    const lastBar = active?.bars?.[active.bars.length - 1];
    const defaultStart = lastBar ? lastBar.time - 86400 * 30 : Date.now() / 1000 - 86400 * 30;
    // "Only replay dates with real data": show the available history for the chosen symbol.
    const rangeInfo = h('div', { class: 'range-info' });
    const showRange = async sym => {
      const sp = spec(sym), tf = (this.app.viewFor(sym) || active).cfg.tf;
      rangeInfo.textContent = 'Checking available history…';
      if (sp.provider === 'twelvedata') {
        try {
          const r = await tdRange(sym, tf);
          rangeInfo.textContent = `Real ${tfLabel(tf)} history (Twelve Data): ${fmtDate(r.earliest ?? r.cachedFirst)} → ${fmtDateTime(r.cachedLast)} UTC · cached locally from ${fmtDate(r.cachedFirst)}. Replays step candle by candle.`;
        } catch (e) { rangeInfo.textContent = `Twelve Data: ${e.message}`; }
      } else if (sp.provider === 'dukascopy') {
        rangeInfo.textContent = sp.coverage?.months ? `Cached 1-minute history (Dukascopy): ${fmtDate(sp.coverage.first)} → ${fmtDateTime(sp.coverage.last)} UTC.` : `No ${sym} data cached yet — open Data to download or import it.`;
      } else rangeInfo.textContent = `${providerLabel(sp.provider)} history is fetched on demand.`;
    };
    const form = formFields([
      { key: 'name', label: 'Session name', type: 'text', value: `${symbol} ${fmtDate(Date.now() / 1000)}`, wide: true },
      { key: 'symbol', label: 'Symbol', type: 'select', value: s.symbol, options: tradable.map(x => [x.symbol, `${x.symbol} — ${x.name}`]), wide: true,
        onchange: () => { const sp = spec(form.inputs.symbol.value); form.inputs.commissionPerLot.value = sp.commissionPerLot ?? 0; form.inputs.commissionPct.value = sp.commissionPct ?? 0; form.inputs.fixedSpread.value = sp.defaultSpread ?? 0; showRange(sp.symbol); } },
      { key: 'start', label: 'Start (UTC)', type: 'datetime-local', value: toUtcInput(defaultStart), hint: 'Or choose “Pick bar on chart”' },
      { key: 'balance', label: 'Starting balance ($)', value: 10000, min: 1 },
      { key: 'leverage', label: 'Leverage (x)', value: 100, min: 1 },
      { key: 'commissionPerLot', label: 'Commission / lot round turn ($)', value: s.commissionPerLot ?? 0, min: 0 },
      { key: 'commissionPct', label: 'Commission % per side', value: s.commissionPct ?? 0, min: 0, step: 0.01 },
      { key: 'slippage', label: 'Slippage (price units)', value: 0, min: 0, hint: 'Adverse slippage on market & stop fills' },
      { key: 'spreadMode', label: 'Spread', type: 'select', value: 'data', options: [['data', 'Real spread from tick data (fallback: fixed)'], ['fixed', 'Fixed spread']] },
      { key: 'fixedSpread', label: 'Fixed / fallback spread', value: s.defaultSpread ?? 0, min: 0 },
      { key: 'stopOutPct', label: 'Stop-out level (% margin)', value: 50, min: 0 },
    ]);
    const start = async pick => {
      const v = form.values();
      if (!spec(v.symbol)) return;
      const config = { name: v.name || v.symbol, symbol: v.symbol, exec: {
        balance: v.balance, leverage: v.leverage, commissionPerLot: v.commissionPerLot, commissionPct: v.commissionPct,
        slippage: v.slippage, spreadMode: v.spreadMode, fixedSpread: v.fixedSpread, stopOutPct: v.stopOutPct,
      } };
      modal.hidden = true;
      if (pick) this.beginSelect(config);
      else {
        const t = parseUtcInput(v.start);
        if (!t) { toast('Choose a start date', 'error'); return; }
        await this.start(config, t, false);
      }
    };
    const list = sessions.length ? h('div', { class: 'session-list' }, sessions.slice().sort((a, b) => b.updated - a.updated).map(x => h('div', { class: 'session-row' + (this.session?.id === x.id ? ' current' : '') },
      h('div', { class: 'grow' }, h('b', null, x.name), h('div', { class: 'muted' }, `${x.symbol} · at ${fmtDateTime(x.cursor)} UTC · ${x.trades} trades · equity ${fmtUsd(x.equity)}`)),
      h('button', { class: 'btn small primary', onclick: () => { modal.hidden = true; this.resume(x.id); } }, this.session?.id === x.id ? 'Current' : 'Resume'),
      h('button', { class: 'btn small', title: 'Delete session', onclick: async () => {
        if (!(await confirmBox(`Delete session “${x.name}” and its journal entries?`, 'Delete'))) return;
        await this.deleteSession(x.id);
        this.openDialog(prefSymbol);
      } }, icon('trash'))))) : h('p', { class: 'muted' }, 'No saved sessions yet.');
    $('#sessionBody').replaceChildren(
      h('h4', null, 'Resume a session'), list,
      h('h4', null, 'New replay session'), form.el, rangeInfo,
      h('details', { class: 'notes' }, h('summary', null, 'How fills are simulated'), h('ul', null, EXECUTION_NOTES.map(n => h('li', null, n)))),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', onclick: () => start(true) }, icon('scissors'), 'Pick bar on chart'),
        h('button', { class: 'btn primary', onclick: () => start(false) }, icon('play'), 'Start at date')),
    );
    openModal(modal);
    showRange(s.symbol);
  }

  beginSelect(config) {
    if (this.active && !config) {
      config = { name: this.session.name, symbol: this.symbol, exec: this.broker.cfg, restartSessionId: this.session.id };
    }
    this.pendingConfig = config;
    this.pause();
    this.selecting = true;
    this.updateBar();
    const v = this.app.viewFor(config.symbol);
    if (v && v !== this.app.activeView) this.app.setActive(v);
    else if (!v) this.app.activeView.setSymbol(config.symbol);
    toast('Click a bar to start replay from there (Esc to cancel)');
  }
  cancelSelect() { this.selecting = false; this.pendingConfig = null; this.updateBar(); }

  async onBarSelected(view, time) {
    const cfg = this.pendingConfig;
    this.selecting = false;
    // The clicked bar becomes the last fully visible bar.
    const i = view.bars.findIndex(b => b.time >= time);
    const bar = view.bars[i >= 0 ? i : view.bars.length - 1];
    const next = view.all[view.all.indexOf(bar) + 1] || view.bars[i + 1];
    const cursor = next ? next.start : bar.start + 60;
    if (cfg.restartSessionId) {
      if (!(await this.rewindTo(cursor))) { this.updateBar(); return; }
      this.updateBar();
      return;
    }
    await this.start(cfg, cursor, true);
  }

  // ---------------------------------------------------------------- lifecycle
  async start(config, cursor, exact) {
    const s = spec(config.symbol);
    if (!canTrade(s)) { toast(`${config.symbol} can't be traded in USD`, 'error'); return; }
    if (s.provider === 'tradingview') { toast('Bar Replay needs full history: switch this symbol to Twelve Data or Dukascopy in Data (TradingView gives only recent candles without an account)', 'error'); return; }
    let first;
    if (s.provider === 'twelvedata') {
      // Candle-by-candle on Twelve Data candles: only dates with real history, snapped to a real candle.
      const tf = (this.app.viewFor(config.symbol) || this.app.activeView).cfg.tf;
      try {
        const range = await tdRange(config.symbol, tf);
        const earliest = range.earliest ?? range.cachedFirst;
        if (cursor <= earliest || cursor > range.cachedLast) {
          toast(`Twelve Data ${tfLabel(tf)} history for ${config.symbol} runs ${fmtDate(earliest)} → ${fmtDateTime(range.cachedLast)} UTC — pick a date inside it.`, 'error');
          return;
        }
        if (!exact) {
          const next = (await fetchBars(config.symbol, tf, { after: cursor, limit: 1 })).bars[0];
          if (!next) { toast(`No ${config.symbol} candles after ${fmtDateTime(cursor)} UTC`, 'error'); return; }
          cursor = next.start;
        }
        first = (await fetchBars(config.symbol, tf, { before: cursor, limit: 1 })).bars[0];
      } catch (e) { toast(e.message, 'error'); return; }
      if (!first) { toast(`No ${config.symbol} candles before ${fmtDateTime(cursor)} UTC on Twelve Data`, 'error'); return; }
    } else {
      if (!exact) cursor = Math.floor(cursor / 60) * 60;
      // Opening quote = the last minute strictly before the cursor (the cursor minute itself is still hidden).
      first = await prevMinute(config.symbol, cursor, 15).catch(() => null);
      if (!first) { toast(`No ${config.symbol} 1-minute data before ${fmtDateTime(cursor)} — download or import history first.`, 'error'); return; }
    }
    this.pause();
    this.broker = new Broker(s, config.exec);
    this.broker.setQuote(first.close, first.spread, cursor);
    this.symbol = config.symbol;
    this.cursor = cursor;
    this.snapshots = [];
    this.mode = 'bar';
    this.session = { id: uid(), name: config.name, symbol: config.symbol, created: Date.now(), startCursor: cursor, exec: config.exec };
    this.active = true;
    this.selecting = false;
    await this.enterViews();
    await this.saveNow();
    toast(`Replay started at ${fmtDateTime(cursor)} UTC`);
  }

  async resume(id) {
    const doc = await kv.get(`session:${id}`);
    if (!doc) {
      toast('Session not found', 'error');
      if (this.app.settings.activeSession === id) { this.app.settings.activeSession = null; this.app.saveSettings(); }
      return;
    }
    this.pause();
    const s = spec(doc.symbol);
    this.broker = new Broker(s, doc.exec).load(doc.broker);
    this.symbol = doc.symbol;
    this.cursor = doc.cursor;
    this.snapshots = doc.snapshots || [];
    this.mode = doc.mode || 'bar';
    this.speed = doc.speed || 1;
    this.session = { id: doc.id, name: doc.name, symbol: doc.symbol, created: doc.created, startCursor: doc.startCursor, exec: doc.exec };
    this.active = true;
    await this.enterViews();
    toast(`Resumed “${doc.name}” at ${fmtDateTime(this.cursor)} UTC`);
  }

  async enterViews() {
    const app = this.app;
    app.settings.activeSession = this.session.id; // resumed automatically after a page reload
    app.saveSettings();
    if (!app.viewFor(this.symbol)) await app.activeView.setSymbol(this.symbol);
    app.setActive(app.viewFor(this.symbol));
    this.updateBar();
    await Promise.all(app.views.map(v => v.load()));
    app.onReplayChanged();
  }

  async exit() {
    if (!this.active) { this.cancelSelect(); return; }
    this.pause();
    await this.saveNow();
    this.active = false;
    this.session = null;
    this.broker = null;
    this.symbol = null;
    this.app.settings.activeSession = null;
    this.app.saveSettings();
    this.updateBar();
    await Promise.all(this.app.views.map(v => v.load()));
    this.app.onReplayChanged();
    toast('Replay closed — progress saved');
  }

  async deleteSession(id) {
    const sessions = (await kv.get('sessions', [])) || [];
    kv.set('sessions', sessions.filter(s => s.id !== id), 0);
    await kv.remove(`session:${id}`).catch(() => {});
    await this.app.journal.removeSession(id);
    if (this.session?.id === id) {
      this.active = false; this.session = null; this.broker = null;
      this.app.settings.activeSession = null; this.app.saveSettings();
      this.updateBar(); await Promise.all(this.app.views.map(v => v.load())); this.app.onReplayChanged();
    }
  }

  persist() {
    if (!this.active) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }
  async saveNow() {
    if (!this.active) return;
    clearTimeout(this.saveTimer);
    const b = this.broker;
    const doc = {
      ...this.session, cursor: this.cursor, mode: this.mode, speed: this.speed,
      broker: b.toJSON(), snapshots: this.snapshots.slice(-MAX_SNAPSHOTS), updated: Date.now(),
    };
    kv.set(`session:${doc.id}`, doc, 0);
    const sessions = ((await kv.get('sessions', [])) || []).filter(s => s.id !== doc.id);
    sessions.push({ id: doc.id, name: doc.name, symbol: doc.symbol, cursor: doc.cursor, equity: b.equity, balance: b.s.balance, trades: b.s.history.length, updated: doc.updated });
    kv.set('sessions', sessions, 0);
  }

  // ---------------------------------------------------------------- stepping
  driverView() {
    const a = this.app.activeView;
    return a?.symbol === this.symbol ? a : (this.app.viewFor(this.symbol) || a);
  }

  async nextCursor() {
    if (this.mode === 'bar') return this.driverView().nextBarCursor(this.cursor);
    const m = await nextMinute(this.symbol, this.cursor, 15);
    if (!m) return null;
    const b = bucketOf(m.time, this.mode, spec(this.symbol).session);
    return Math.max(b + TF[this.mode].sec, m.time + 60);
  }

  async stepForward() {
    if (!this.active || this.busy) return false;
    this.busy = true;
    try {
      const next = await this.nextCursor();
      if (next == null || next <= this.cursor) { toast('End of available data'); this.pause(); return false; }
      await this.advance(next, true);
      return true;
    } catch (e) {
      toast(`Replay step failed: ${e.message}`, 'error');
      this.pause();
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Feed every minute in [cursor, target) to the broker, move the cursor, refresh charts. */
  async advance(target, snapshot) {
    if (snapshot) {
      this.snapshots.push({ cursor: this.cursor, b: this.broker.snapshot() });
      if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
    }
    const events = [];
    const DAY = 86400;
    for (let from = this.cursor; from < target; from = Math.min(target, Math.floor(from / DAY) * DAY + DAY)) {
      const to = Math.min(target, Math.floor(from / DAY) * DAY + DAY);
      for (const m of await getMinutes(this.symbol, from, to)) events.push(...this.broker.processBar({ ...m, seconds: m.seconds || 60 }));
    }
    this.cursor = target;
    await Promise.all(this.app.views.map(v => v.onCursor()));
    this.afterMove();
    for (const ev of events) await this.handleEvent(ev);
  }

  afterMove() {
    this.updateBar();
    this.app.trading.refresh();
    for (const v of this.app.views) v.applyMarkers();
    this.persist();
  }

  async handleEvent(ev) {
    const p = this.app.viewFor(this.symbol)?.prec ?? 2;
    if (ev.type === 'fill') {
      toast(`Filled ${ev.position.side.toUpperCase()} ${+ev.position.lots.toFixed(4)} ${this.symbol} @ ${ev.position.entry.toFixed(p)}`);
      await this.app.journal.onFill(this, ev.position);
    } else if (ev.type === 'close') {
      const t = ev.trade;
      toast(`${t.reason}: ${t.side.toUpperCase()} ${+t.lots.toFixed(4)} closed @ ${t.exit.toFixed(p)} · ${fmtUsd(t.pnl, true)}`, t.pnl >= 0 ? 'good' : 'error');
      await this.app.journal.onClose(this, t);
    } else if (ev.type === 'rejected') toast(`Order rejected: ${ev.reason}`, 'error');
    else if (ev.type === 'stopout') toast('Margin stop-out: all positions closed', 'error');
  }

  async stepBack() {
    if (!this.active || this.busy) return;
    const snap = this.snapshots.pop();
    if (!snap) { toast('Nothing to rewind (start of session or rewind history exhausted)'); return; }
    this.busy = true;
    try {
      const removed = this.broker.restore(snap.b);
      if (removed.length) await this.app.journal.removeTrades(this.session.id, removed.map(t => t.id));
      this.cursor = snap.cursor;
      await Promise.all(this.app.views.map(v => v.onCursor()));
      this.afterMove();
    } finally { this.busy = false; }
  }

  /** Rewind to an earlier time using stored snapshots, then replay forward to exactly `t`. */
  async rewindTo(t) {
    let i = this.snapshots.length - 1;
    while (i >= 0 && this.snapshots[i].cursor > t) i--;
    if (i < 0) {
      if (t >= this.session.startCursor && !this.broker.s.history.length && !this.broker.s.positions.length && !this.snapshots.length) {
        this.cursor = t; await Promise.all(this.app.views.map(v => v.onCursor())); this.afterMove(); return true;
      }
      toast(`Can't rewind before ${fmtDateTime(this.snapshots[0]?.cursor ?? this.session.startCursor)} UTC in this session`, 'error');
      return false;
    }
    const snap = this.snapshots[i];
    const lost = this.broker.s.history.length - snap.b.historyLen;
    if (lost > 0 && !(await confirmBox(`Rewinding removes ${lost} closed trade(s) made after ${fmtDateTime(t)} UTC (and their journal entries). Continue?`, 'Rewind'))) return false;
    this.snapshots.length = i;
    const removed = this.broker.restore(snap.b);
    if (removed.length) await this.app.journal.removeTrades(this.session.id, removed.map(x => x.id));
    this.cursor = snap.cursor;
    if (t > this.cursor) await this.advance(t, true);
    else { await Promise.all(this.app.views.map(v => v.onCursor())); this.afterMove(); }
    return true;
  }

  async jumpTo(t) {
    if (!this.active) return;
    t = Math.floor(t / 60) * 60;
    this.pause();
    if (t === this.cursor) return;
    if (t < this.cursor) { await this.rewindTo(t); return; }
    this.busy = true;
    try {
      toast(`Replaying to ${fmtDateTime(t)} UTC…`);
      await this.advance(t, true);
    } catch (e) { toast(`Jump failed: ${e.message}`, 'error'); }
    finally { this.busy = false; }
  }

  togglePlay() { if (this.playing) this.pause(); else this.play(); }
  play() {
    if (!this.active || this.playing) return;
    this.playing = true;
    this.updateBar();
    const loop = async () => {
      if (!this.playing) return;
      const t0 = performance.now();
      const ok = await this.stepForward();
      if (!ok) { this.pause(); return; }
      const wait = clamp(1000 / this.speed - (performance.now() - t0), 0, 4000);
      this.playTimer = setTimeout(loop, wait);
    };
    loop();
  }
  pause() {
    this.playing = false;
    clearTimeout(this.playTimer);
    if (this.active) this.updateBar();
  }

  status() {
    return this.active ? `Replay · ${this.symbol} · ${tfLabel(this.app.activeView?.cfg.tf)} · ${fmtDateTime(this.cursor)} UTC` : null;
  }
}
