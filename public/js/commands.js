// Command palette (Ctrl+K) and customisable keyboard shortcuts. Every action in the app is a command with an id,
// a title and optionally a default key combo; Help → Keyboard shortcuts lets you rebind any of them.

import { h, icon, toast, fill, clamp } from './util.js';
import { SYMBOLS, TIMEFRAMES, tfLabel } from './data.js';
import { CHART_TYPES } from './chartview.js';
import { IND_DEFS } from './indicators-ui.js';
import { TOOL_INFO, toolTitle } from './drawings.js';

/** "Ctrl+Shift+K" style combo of a keyboard event (null for bare modifier presses). */
export function comboOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

export function buildCommands(app) {
  const v = () => app.activeView;
  const cmds = [];
  const add = (id, group, title, run, keys = null, extra = {}) => cmds.push({ id, group, title, run, keys, ...extra });
  // general
  add('palette', 'General', 'Command palette — search every action', () => app.openPalette(), 'Ctrl+K');
  add('shortcuts', 'General', 'Keyboard shortcuts…', () => app.openShortcuts(), 'Ctrl+/');
  add('symbol', 'General', 'Symbol search…', () => app.openSymbolSearch('open'));
  add('compare', 'Chart', 'Compare with another symbol…', () => app.openSymbolSearch('compare'));
  add('indicators', 'Chart', 'Indicators…', () => app.openIndicators(), 'Ctrl+I');
  add('chartSettings', 'Chart', 'Chart settings…', () => app.openChartSettings(), 'Ctrl+,');
  add('resetChart', 'Chart', 'Reset chart view', () => { v().chart.timeScale().resetTimeScale(); v().chart.priceScale('right').applyOptions({ autoScale: true }); }, 'Alt+R');
  add('logScale', 'Chart', 'Toggle log scale', () => { v().setScaleMode(v().cfg.scaleMode === 1 ? 0 : 1); app.refreshToolbar(); }, 'Alt+L');
  add('pctScale', 'Chart', 'Toggle percent scale', () => { v().setScaleMode(v().cfg.scaleMode === 2 ? 0 : 2); app.refreshToolbar(); }, 'Alt+P');
  add('snapshot', 'Chart', 'Snapshot: download image', () => app.snapshot('download'), 'Alt+S');
  add('snapshotCopy', 'Chart', 'Snapshot: copy image to clipboard', () => app.snapshot('copy'), 'Ctrl+Shift+S');
  add('exportCsv', 'Chart', 'Export chart data (CSV)', () => v().exportCsv());
  add('shareLink', 'Chart', 'Copy a link to this chart', () => app.share.copyLink());
  add('shareFile', 'Chart', 'Save this chart as a file (shareable)', () => app.share.exportFile());
  add('importChart', 'Chart', 'Open a shared chart file…', () => app.share.pickFile());
  add('popout', 'Chart', 'Open this chart in a new window (second monitor)', () => app.share.popout());
  add('newIdea', 'Chart', 'Save an idea (snapshot + notes)…', () => app.ideas.openNew());
  for (const [tf, l] of TIMEFRAMES) add(`tf:${tf}`, 'Timeframe', `Timeframe ${l}`, () => v().setTf(tf));
  for (const ct of CHART_TYPES) add(`type:${ct.k}`, 'Chart type', `Chart type: ${ct.label}`, () => v().setChartType(ct.k));
  for (const [k, d] of Object.entries(IND_DEFS)) add(`ind:${k}`, 'Indicators', `Add indicator: ${d.name} (${d.short})`, () => v().addIndicator(k), null, { hint: `${k} ${d.cat}` });
  // drawing
  for (const [k, t] of Object.entries(TOOL_INFO)) if (k !== 'cursor') add(`tool:${k}`, 'Drawing', `Draw: ${toolTitle(k)}`, () => app.setTool(k), t.key || null);
  add('tool:cursor', 'Drawing', 'Cursor (stop drawing)', () => app.setTool('cursor'));
  add('undo', 'Drawing', 'Undo drawing change', () => app.undoDrawings(), 'Ctrl+Z');
  add('redo', 'Drawing', 'Redo drawing change', () => app.undoDrawings(true), 'Ctrl+Y');
  add('hideDrawings', 'Drawing', 'Hide / show all drawings', () => $toggle('hideDrawings'), 'Ctrl+Alt+H');
  add('magnet', 'Drawing', 'Magnet on / off', () => $toggle('magnet'), 'Ctrl+Alt+M');
  add('lockDrawings', 'Drawing', 'Lock / unlock all drawings', () => $toggle('drawingsLocked'));
  add('objectTree', 'Drawing', 'Object tree (manage drawings)', () => document.querySelector('#tools .tool[title^="Object tree"]')?.click());
  add('clearDrawings', 'Drawing', 'Remove all drawings on this symbol', () => document.querySelector('#tools .tool[title^="Remove all drawings"]')?.click());
  // panels & view
  for (const [k, l] of [['trading', 'Trading panel'], ['tester', 'Strategy Tester'], ['journal', 'Journal'], ['alerts', 'Alerts'], ['portfolio', 'Portfolio'], ['screener', 'Screener'], ['calendar', 'Economic calendar'], ['seasonals', 'Seasonals'], ['dom', 'Order book (DOM)'], ['ideas', 'Ideas'], ['scripts', 'Pine / script editor']]) {
    add(`panel:${k}`, 'Panels', `Open ${l}`, () => app.showPanel(k));
  }
  add('togglePanel', 'View', 'Show / hide the bottom panel', () => { app.settings.panelOpen = !app.settings.panelOpen; app.saveSettings(); app.applyPanel(); }, 'Ctrl+J');
  add('watchlist', 'View', 'Show / hide watchlist', () => app.toggleWatchlist(), 'Alt+W');
  add('theme', 'View', 'Switch light / dark theme', () => app.setTheme(app.theme === 'dark' ? 'light' : 'dark'), 'Alt+D');
  add('fullscreen', 'View', 'Fullscreen', () => document.querySelector('#fsBtn')?.click(), 'F11');
  add('assistant', 'View', 'Ask Claude (chart assistant)', () => app.toggleAssistant());
  for (const [k, , title] of [['1', '', 'Single chart'], ['2v', '', '2 charts side by side'], ['2h', '', '2 charts stacked'], ['3', '', '3 charts'], ['4', '', '4 charts'], ['6', '', '6 charts'], ['8', '', '8 charts']]) add(`layout:${k}`, 'Layout', `Layout: ${title}`, () => app.setLayout(k));
  for (const [k, l] of [['symbol', 'symbol'], ['tf', 'interval'], ['crosshair', 'crosshair'], ['time', 'date range']]) add(`sync:${k}`, 'Layout', `Sync ${l} between charts on / off`, () => { app.sync[k] = !app.sync[k]; app.saveSettings(); toast(`Sync ${l}: ${app.sync[k] ? 'on' : 'off'}`); });
  // trading & alerts
  add('alert', 'Alerts', 'Create alert…', () => app.alerts.openDialog({ symbol: v()?.symbol }), 'Alt+A');
  add('alertWebhook', 'Alerts', 'Alert webhook / phone notifications…', () => app.alerts.openSettings());
  add('replay', 'Trading', 'Bar Replay…', () => app.replay.openDialog(), 'Shift+R');
  add('paper', 'Trading', 'Paper trading on / off', () => { app.paper.setEnabled(!app.paper.enabled); app.showPanel('trading'); toast(`Paper trading ${app.paper.enabled ? 'on' : 'off'}`); });
  add('buy', 'Trading', 'Buy at market (ticket size)', () => app.trading.quickOrder('buy'), 'Shift+B');
  add('sell', 'Trading', 'Sell at market (ticket size)', () => app.trading.quickOrder('sell'), 'Shift+S');
  add('data', 'Data', 'Market data: download & import…', () => app.openDataManager());
  return cmds;

  function $toggle(key) { document.querySelector(`#tools .tool[data-toggle="${key}"]`)?.click(); }
}

export class Commands {
  constructor(app) {
    this.app = app;
    this.list = buildCommands(app);
    this.byId = new Map(this.list.map(c => [c.id, c]));
  }
  keyOf(c) { const m = this.app.settings.keymap || {}; return c.id in m ? m[c.id] : c.keys; }
  /** Command bound to a key combo (custom bindings win over defaults). */
  forCombo(combo) { return combo ? this.list.find(c => this.keyOf(c) === combo) || null : null; }

  // ---------------------------------------------------------------- palette
  openPalette(initial = '') {
    let modal = document.getElementById('paletteModal');
    if (!modal) {
      modal = h('div', { id: 'paletteModal', class: 'modal palette-modal', hidden: true, onmousedown: e => { if (e.target === modal) modal.hidden = true; } });
      document.body.append(modal);
    }
    const input = h('input', { class: 'palette-input', placeholder: 'Search actions, indicators, tools, symbols…  (Enter runs, Esc closes)', value: initial });
    const list = h('div', { class: 'palette-list' });
    let sel = 0, items = [];
    const recent = this.app.settings.recentCmds || [];
    const run = c => {
      modal.hidden = true;
      this.app.settings.recentCmds = [c.id, ...recent.filter(x => x !== c.id)].slice(0, 8);
      this.app.saveSettings();
      try { c.run(); } catch (e) { toast(e.message, 'error'); }
    };
    const render = () => {
      const q = input.value.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
      const match = c => words.every(w => `${c.title} ${c.group} ${c.hint || ''}`.toLowerCase().includes(w));
      let cmds = q ? this.list.filter(match) : [...recent.map(id => this.byId.get(id)).filter(Boolean), ...this.list.filter(c => !recent.includes(c.id))];
      if (q) cmds.sort((a, b) => (a.title.toLowerCase().indexOf(words[0]) - b.title.toLowerCase().indexOf(words[0])) || a.title.length - b.title.length);
      // symbols matching the query
      const Q = input.value.trim().toUpperCase();
      const syms = Q.length >= 2 ? SYMBOLS.filter(s => s.symbol.includes(Q) || s.name.toUpperCase().includes(Q)).slice(0, 6)
        .map(s => ({ id: `sym:${s.symbol}`, group: 'Symbol', title: `Open ${s.symbol} — ${s.name}`, run: () => this.app.activeView.setSymbol(s.symbol) })) : [];
      items = [...syms, ...cmds].slice(0, 80);
      sel = clamp(sel, 0, Math.max(0, items.length - 1));
      fill(list, items.length ? items.map((c, i) => h('div', { class: 'palette-item' + (i === sel ? ' sel' : ''), onmouseenter: () => { sel = i; paintSel(); }, onclick: () => run(c) },
        h('span', { class: 'pi-group' }, c.group), h('span', { class: 'pi-title' }, c.title, recent.includes(c.id) && !q ? h('small', { class: 'muted' }, '  recent') : null),
        this.keyOf(c) ? h('kbd', null, this.keyOf(c)) : null)) : h('div', { class: 'dlg-empty' }, 'Nothing matches'));
    };
    const paintSel = () => [...list.children].forEach((el, i) => el.classList.toggle('sel', i === sel));
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paintSel(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) run(items[sel]); }
      else if (e.key === 'Escape') { e.stopPropagation(); modal.hidden = true; }
    });
    fill(modal, h('div', { class: 'dialog palette' }, h('div', { class: 'search' }, icon('search'), input), list));
    modal.hidden = false;
    render();
    setTimeout(() => input.focus(), 0);
  }

  // ---------------------------------------------------------------- shortcuts dialog
  openShortcuts() {
    let modal = document.getElementById('shortcutModal');
    if (!modal) {
      modal = h('div', { id: 'shortcutModal', class: 'modal', hidden: true, onmousedown: e => { if (e.target === modal) modal.hidden = true; } });
      document.body.append(modal);
    }
    const km = (this.app.settings.keymap ||= {});
    let filter = '', capturing = null;
    const body = h('div', { class: 'dlg-body sc-keys' });
    const save = () => { this.app.saveSettings(); render(); };
    const render = () => {
      const groups = new Map();
      for (const c of this.list) {
        if (c.group === 'Indicators' || c.group === 'Chart type' || (filter && !`${c.title} ${c.group}`.toLowerCase().includes(filter))) continue;
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
      }
      const dup = new Map();
      for (const c of this.list) { const k = this.keyOf(c); if (k) dup.set(k, (dup.get(k) || 0) + 1); }
      fill(body, h('input', { type: 'search', placeholder: 'Filter', value: filter, oninput: e => { filter = e.target.value.toLowerCase(); render(); e.target.focus(); } }),
        h('p', { class: 'muted small' }, 'Click a shortcut, then press the new keys (Esc cancels, Backspace clears). Letters alone open symbol search and digits change the interval, so use Alt, Ctrl or Shift. Indicators and chart types can be bound from here after searching for them.'),
        [...groups.entries()].map(([g, list]) => h('div', { class: 'sc-group' }, h('h4', null, g), list.map(c => {
          const k = this.keyOf(c);
          return h('div', { class: 'sc-row' }, h('span', null, c.title),
            h('button', { class: 'kbd-btn' + (capturing === c.id ? ' capturing' : '') + (k && dup.get(k) > 1 ? ' conflict' : ''), title: k && dup.get(k) > 1 ? 'Used by more than one action' : 'Change',
              onclick: () => { capturing = c.id; render(); } }, capturing === c.id ? 'Press keys…' : k || '—'),
            c.id in km ? h('button', { class: 'btn small', title: `Back to ${c.keys || 'none'}`, onclick: () => { delete km[c.id]; save(); } }, 'Reset') : null);
        }))));
    };
    modal.onkeydown = e => {
      if (!capturing) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { capturing = null; render(); return; }
      if (e.key === 'Backspace') { km[capturing] = null; capturing = null; save(); return; }
      const combo = comboOf(e);
      if (!combo) return;
      if (/^[A-Z0-9]$/.test(combo)) { toast('Add Alt, Ctrl or Shift — single letters open symbol search', 'error'); return; }
      km[capturing] = combo; capturing = null; save();
    };
    fill(modal, h('div', { class: 'dialog wide' }, h('div', { class: 'dlg-head' }, h('span', null, 'Keyboard shortcuts'), h('button', { class: 'x', onclick: () => { modal.hidden = true; } }, icon('close'))), body));
    modal.hidden = false;
    render();
  }
}

/** Typing digits on the chart: "15" → 15m, "4h", "1D", "1W" — the interval box, like TradingView. */
export function parseInterval(text) {
  const m = /^(\d+)\s*([mhdwMHDW]?)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]), u = m[2];
  const tf = !u ? `${n}m` : /[hH]/.test(u) ? `${n}h` : /[dD]/.test(u) ? `${n}d` : /[wW]/.test(u) ? `${n}w` : u === 'M' ? `${n}M` : `${n}m`;
  return TIMEFRAMES.some(([k]) => k === tf) ? tf : null;
}
export const intervalLabel = tf => tfLabel(tf);
