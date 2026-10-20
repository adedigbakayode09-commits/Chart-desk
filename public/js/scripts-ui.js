// Script editor panel: write, compile, save and add custom script indicators.

import { h, icon, toast, confirmBox, fill, fmtDateTime } from './util.js';
import { listScripts, getScript, upsertScript, deleteScript, newScriptId, compileScript, runScript, TEMPLATES, REFERENCE } from './scripts.js';

// Names offered by autocomplete (Pine built-ins; the script's own variables and functions are added on the fly).
const PINE_NAMES = `indicator strategy library plot plotshape plotchar plotcandle plotbar hline fill bgcolor barcolor alert alertcondition
input input.int input.float input.bool input.string input.source input.timeframe input.color input.price input.session input.symbol input.text_area
open high low close volume hl2 hlc3 ohlc4 hlcc4 time time_close bar_index last_bar_index na nz fixnan
ta.sma ta.ema ta.rma ta.wma ta.hma ta.vwma ta.alma ta.swma ta.linreg ta.rsi ta.macd ta.stoch ta.cci ta.mfi ta.cmo ta.wpr ta.atr ta.tr ta.bb ta.bbw ta.kc ta.dmi
ta.supertrend ta.sar ta.vwap ta.stdev ta.variance ta.dev ta.highest ta.lowest ta.highestbars ta.lowestbars ta.rising ta.falling ta.change ta.mom ta.roc
ta.crossover ta.crossunder ta.cross ta.cum ta.sum ta.median ta.max ta.min ta.valuewhen ta.barssince ta.pivothigh ta.pivotlow ta.obv ta.accdist
math.abs math.max math.min math.round math.round_to_mintick math.floor math.ceil math.sqrt math.pow math.log math.log10 math.exp math.sign math.avg math.sum math.pi
str.tostring str.tonumber str.format str.contains str.length str.replace str.replace_all str.split str.substring str.upper str.lower str.pos
array.new_float array.new_int array.new_bool array.new_string array.new<float> array.from array.push array.pop array.get array.set array.size array.shift array.unshift
array.remove array.clear array.sum array.avg array.max array.min array.sort array.includes array.indexof array.first array.last array.slice array.reverse
color.new color.rgb color.from_gradient color.red color.green color.blue color.orange color.yellow color.purple color.teal color.aqua color.lime color.white color.black color.gray color.silver color.maroon color.navy color.fuchsia color.olive
line.new line.set_xy1 line.set_xy2 line.set_color line.delete label.new label.set_text label.set_xy label.set_color label.delete box.new box.set_lefttop box.set_rightbottom box.delete
table.new table.cell table.clear request.security timeframe.period timeframe.change timeframe.in_seconds syminfo.ticker syminfo.mintick
barstate.isfirst barstate.islast barstate.isconfirmed barstate.isrealtime strategy.entry strategy.exit strategy.close strategy.close_all strategy.cancel strategy.order
strategy.long strategy.short strategy.position_size strategy.position_avg_price strategy.equity strategy.netprofit strategy.openprofit strategy.opentrades strategy.closedtrades
strategy.percent_of_equity strategy.fixed strategy.cash log.info log.warning log.error
shape.triangleup shape.triangledown shape.labelup shape.labeldown shape.circle shape.cross shape.xcross shape.arrowup shape.arrowdown shape.flag shape.diamond shape.square
location.abovebar location.belowbar location.top location.bottom location.absolute size.tiny size.small size.normal size.large size.huge
plot.style_line plot.style_linebr plot.style_histogram plot.style_columns plot.style_circles plot.style_area plot.style_stepline extend.right extend.left extend.both extend.none
xloc.bar_index xloc.bar_time yloc.price yloc.abovebar yloc.belowbar position.top_right position.bottom_right position.top_left
var varip if else for to by while switch true false and or not`.split(/\s+/).filter(Boolean);

export class ScriptEditor {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.currentId = null;
    this.messages = [];
  }

  init() {
    this.currentId = listScripts()[0]?.id || null;
    this.render();
  }

  get current() { return getScript(this.currentId); }
  get dirty() { return !!this.textarea && this.current && this.textarea.value !== this.current.code; }

  render() {
    const scripts = listScripts();
    const list = h('div', { class: 'se-list' },
      h('div', { class: 'se-list-head' }, h('b', null, 'My scripts'),
        h('select', { class: 'se-new', title: 'New script from a template', onchange: e => { if (e.target.value) this.create(e.target.value); e.target.value = ''; } },
          h('option', { value: '' }, '+ New…'), Object.entries(TEMPLATES).map(([k, t]) => h('option', { value: k }, t.name)))),
      scripts.length ? scripts.map(s => h('button', { class: 'se-item' + (s.id === this.currentId ? ' active' : ''), onclick: () => this.select(s.id) },
        h('span', null, s.name), h('small', { class: s.error ? 'down' : 'muted' }, s.error ? 'error' : s.meta ? (s.meta.overlay ? 'on chart' : 'own pane') : 'draft')))
        : h('p', { class: 'muted small' }, 'No scripts yet — pick a template above.'));

    const sc = this.current;
    if (!sc) {
      this.textarea = null;
      this.host.replaceChildren(h('div', { class: 'script-editor' }, list, h('div', { class: 'se-main se-empty' },
        h('h3', null, 'Write your own indicators'),
        h('p', { class: 'muted' }, 'Paste a Pine Script® indicator (v5/v6) or write JavaScript with the Pine-style API. Scripts run isolated from the app (no access to your keys, the page or the network).'),
        h('div', { class: 'se-templates' }, Object.entries(TEMPLATES).map(([k, t]) => h('button', { class: 'chip', onclick: () => this.create(k) }, t.name))))));
      return;
    }

    this.gutter = h('div', { class: 'se-gutter' });
    this.textarea = h('textarea', { class: 'se-code', spellcheck: 'false', autocomplete: 'off', wrap: 'off' });
    this.textarea.value = sc.code;
    this.textarea.addEventListener('input', () => { this.updateGutter(); this.updateStatus(); this.suggest(); });
    this.textarea.addEventListener('blur', () => setTimeout(() => this.hideSuggest(), 150));
    this.textarea.addEventListener('click', () => this.hideSuggest());
    this.textarea.addEventListener('scroll', () => { this.gutter.scrollTop = this.textarea.scrollTop; });
    this.textarea.addEventListener('keydown', e => {
      if (this.sugg && !this.sugg.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.suggSel = (this.suggSel + (e.key === 'ArrowDown' ? 1 : -1) + this.suggItems.length) % this.suggItems.length; this.paintSuggest(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); this.acceptSuggest(); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.hideSuggest(); return; }
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.textarea;
        this.textarea.value = value.slice(0, a) + '  ' + value.slice(b);
        this.textarea.selectionStart = this.textarea.selectionEnd = a + 2;
        this.updateGutter(); this.updateStatus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.save();
      }
    });
    this.statusEl = h('span', { class: 'se-status' });
    this.console = h('div', { class: 'se-console' });
    const reference = h('details', { class: 'se-ref' }, h('summary', null, 'Script reference'),
      h('table', null, h('tbody', null, REFERENCE.map(([a, b]) => h('tr', null, h('td', null, h('code', null, a)), h('td', { class: 'muted' }, b))))));

    this.host.replaceChildren(h('div', { class: 'script-editor' }, list, h('div', { class: 'se-main' },
      h('div', { class: 'se-toolbar' },
        h('b', { class: 'se-name' }, sc.name), this.statusEl,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', title: 'Compile and save (Ctrl+S)', onclick: () => this.save() }, icon('save'), 'Save'),
        h('button', { class: 'btn small primary', onclick: () => this.addToChart() }, icon('plus'), 'Add to chart'),
        sc.meta?.strategy ? h('button', { class: 'btn small primary', title: 'Run this Pine strategy in the Strategy Tester', onclick: () => { this.app.tester.state.strategy = `pine:${sc.id}`; this.app.showPanel('tester'); } }, icon('play'), 'Backtest') : null,
        h('button', { class: 'btn small', title: 'Pine Profiler: run once and show which lines take the time', onclick: () => this.profile() }, 'Profile'),
        h('button', { class: 'btn small', title: `Version history${sc.versions?.length ? ` (${sc.versions.length})` : ''} — restore an earlier save`, onclick: e => this.openHistory(e.currentTarget) }, icon('undo'), sc.versions?.length ? `${sc.versions.length}` : ''),
        h('button', { class: 'btn small', title: 'Duplicate', onclick: () => this.duplicate() }, 'Duplicate'),
        h('button', { class: 'btn small danger', title: 'Delete script', onclick: () => this.remove() }, icon('trash'))),
      h('div', { class: 'se-editor' }, this.gutter, this.textarea, this.sugg = h('div', { class: 'se-sugg', hidden: true })),
      this.console, reference)));
    this.updateGutter();
    this.updateStatus();
    this.renderConsole();
  }

  updateGutter(errorLine = this.errorLine) {
    if (!this.textarea) return;
    const lines = this.textarea.value.split('\n').length;
    this.gutter.replaceChildren(...Array.from({ length: lines }, (_, i) => h('div', { class: i + 1 === errorLine ? 'err' : '' }, String(i + 1))));
    this.gutter.scrollTop = this.textarea.scrollTop;
  }
  updateStatus() {
    if (!this.statusEl) return;
    const sc = this.current;
    this.statusEl.textContent = this.dirty ? '● unsaved' : sc?.error ? 'error' : sc?.meta ? `saved · ${sc.meta.lang === 'pine' ? 'Pine · ' : ''}${sc.meta.overlay ? 'on chart' : 'own pane'} · ${sc.meta.plots.length} plot(s)` : 'draft';
    this.statusEl.className = 'se-status ' + (this.dirty ? 'warn' : sc?.error ? 'down' : 'muted');
  }
  log(text, kind = '') { this.messages = [...this.messages.slice(-30), { text, kind, at: new Date().toLocaleTimeString() }]; this.renderConsole(); }
  renderConsole() {
    if (!this.console) return;
    this.console.replaceChildren(...(this.messages.length ? this.messages.map(m => h('div', { class: m.kind }, h('span', { class: 'muted' }, `${m.at}  `), m.text))
      : [h('div', { class: 'muted' }, 'Press Save (Ctrl+S) to compile against the active chart. Errors show here with their line number.')]));
    this.console.scrollTop = this.console.scrollHeight;
  }

  async confirmDiscard() {
    return !this.dirty || confirmBox('Discard unsaved changes to this script?', 'Discard');
  }
  async select(id) {
    if (id === this.currentId || !(await this.confirmDiscard())) return;
    this.currentId = id;
    this.errorLine = null;
    this.messages = [];
    this.render();
  }
  async create(key) {
    if (!(await this.confirmDiscard())) return;
    const t = TEMPLATES[key];
    const sc = upsertScript({ id: newScriptId(), name: t.name, code: t.code, meta: null, error: null, created: Date.now() });
    this.currentId = sc.id;
    this.messages = [];
    this.render();
    await this.save();
  }
  async duplicate() {
    const sc = this.current;
    if (!sc) return;
    const copy = upsertScript({ ...structuredClone(sc), id: newScriptId(), name: `${sc.name} copy`, code: this.textarea.value, created: Date.now() });
    this.currentId = copy.id;
    this.render();
    await this.save();
  }

  /** Compile against the active chart's candles; save the code (and metadata when it compiles). */
  async save() {
    const sc = this.current;
    if (!sc) return false;
    const code = this.textarea.value;
    const view = this.app.activeView;
    const bars = view?.bars || [];
    if (bars.length < 2) { this.log('Open a chart with candles to compile against.', 'down'); return false; }
    this.log('Compiling…', 'muted');
    const t0 = performance.now();
    const res = await compileScript(code, bars, view.scriptCtx());
    // version history: the previous saved code is kept whenever the code changes (last 30)
    if (sc.code && sc.code !== code) sc.versions = [{ at: sc.updated || sc.created || Date.now(), code: sc.code, name: sc.name }, ...(sc.versions || [])].slice(0, 30);
    sc.code = code;
    sc.updated = Date.now();
    if (res.error) {
      sc.error = res.error;
      this.errorLine = res.line;
      upsertScript(sc);
      this.log(`${res.line ? `Line ${res.line}: ` : ''}${res.error}`, 'down');
      this.updateGutter();
      this.render();
      return false;
    }
    const prevPlots = JSON.stringify(sc.meta?.plots), prevOverlay = sc.meta?.overlay;
    sc.meta = res.meta;
    sc.name = res.meta.name;
    sc.error = null;
    this.errorLine = null;
    upsertScript(sc);
    const ins = res.meta.inputs.length > 8 ? `${res.meta.inputs.length} settings` : res.meta.inputs.map(i => `${i.name}=${i.def}`).join(', ');
    const sigs = res.result.shapes?.length ? `, ${res.result.shapes.length} signal marker(s)` : '';
    this.log(`Compiled ${res.meta.lang === 'pine' ? 'Pine' : 'JS'} “${sc.name}” on ${bars.length} candles in ${Math.round(performance.now() - t0)} ms: ${res.meta.plots.length} plot(s)${sigs}${res.meta.hlines.length ? `, ${res.meta.hlines.length} level(s)` : ''}${ins ? ` · inputs: ${ins}` : ''}.`, 'up');
    for (const w of res.result.warnings || []) this.log(`Note: ${w}`, 'warn');
    this.showLogs(res.result.logs);
    // Refresh every chart that shows this script (rebuild if its plots or pane changed).
    const structural = prevPlots !== JSON.stringify(res.meta.plots) || prevOverlay !== res.meta.overlay;
    for (const v of this.app.views) {
      const inds = v.cfg.indicators.filter(i => i.type === 'SCRIPT' && i.scriptId === sc.id);
      if (!inds.length) continue;
      for (const ind of inds) for (const inp of res.meta.inputs) if (ind.params[inp.name] == null) ind.params[inp.name] = inp.def;
      if (structural) v.rebuildAll(); else v.refreshIndicators();
      this.app.onViewChanged(v);
    }
    this.render();
    return true;
  }

  /** Pine Logs: log.info / log.warning / log.error from the last run, newest last, with the bar's time. */
  showLogs(logs) {
    if (!logs?.length) return;
    this.log(`Pine logs: ${logs.length} message${logs.length === 1 ? '' : 's'}${logs.length > 40 ? ' (last 40 shown)' : ''}`, 'muted');
    for (const l of logs.slice(-40)) this.log(`[${fmtDateTime(l.time)}] ${l.level === 'info' ? '' : `${l.level}: `}${l.msg}`, l.level === 'error' ? 'down' : l.level === 'warning' ? 'warn' : '');
  }
  /** Pine Profiler: time spent per top-level line over the whole run. */
  async profile() {
    const sc = this.current, view = this.app.activeView;
    if (!sc || !view?.bars.length) return;
    this.log('Profiling…', 'muted');
    const t0 = performance.now();
    const res = await runScript(this.textarea.value, view.bars, {}, { ...view.scriptCtx(), profile: true });
    if (res.error) { this.log(`${res.line ? `Line ${res.line}: ` : ''}${res.error}`, 'down'); return; }
    if (!res.profile) { this.log('The profiler measures Pine scripts — this one is JavaScript.', 'muted'); return; }
    const total = (res.profile || []).reduce((a, x) => a + x.ms, 0) || 1, lines = this.textarea.value.split('\n');
    this.log(`Profile of ${view.bars.length.toLocaleString()} bars: ${Math.round(performance.now() - t0)} ms in total (script ${Math.round(total)} ms). Slowest lines:`, 'up');
    for (const x of (res.profile || []).slice(0, 12)) this.log(`line ${x.line} · ${(x.ms / total * 100).toFixed(1)}% · ${x.ms.toFixed(1)} ms · ${String(lines[x.line - 1] || '').trim().slice(0, 80)}`, x.ms / total > 0.25 ? 'warn' : '');
    this.showLogs(res.logs);
  }
  /** Earlier saves of this script; restoring puts the code in the editor (save to keep it). */
  openHistory(anchor) {
    const sc = this.current, pop = document.getElementById('popover');
    pop.className = 'popover se-history';
    const vs = sc.versions || [];
    fill(pop, h('h4', null, `Versions of ${sc.name}`),
      vs.length ? vs.map((v, k) => {
        const added = v.code.split('\n').length - this.textarea.value.split('\n').length;
        return h('div', { class: 'tpl-row' },
          h('button', { class: 'grow', title: 'Load this version into the editor', onclick: () => { this.textarea.value = v.code; this.updateGutter(); this.updateStatus(); pop.hidden = true; toast(`Version from ${fmtDateTime(v.at / 1000)} loaded — Save to keep it`); } },
            h('b', null, `v${vs.length - k}`), ` ${fmtDateTime(v.at / 1000)} UTC`, h('small', { class: 'muted' }, ` · ${v.code.split('\n').length} lines${added ? ` (${added > 0 ? '+' : ''}${added})` : ''}`)));
      }) : h('p', { class: 'muted small' }, 'No earlier versions yet — each save that changes the code keeps the previous one (up to 30).'));
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
    pop.style.top = `${Math.max(8, r.top - 260)}px`;
    pop.hidden = false;
  }

  // ---------------------------------------------------------------- autocomplete
  /** The word being typed before the caret (letters, digits, _ and dots). */
  wordAtCaret() {
    const ta = this.textarea, pos = ta.selectionStart, before = ta.value.slice(0, pos);
    const m = /[A-Za-z_][\w.]*$/.exec(before);
    return m ? { word: m[0], start: pos - m[0].length, end: pos } : null;
  }
  suggest() {
    const w = this.wordAtCaret();
    if (!w || w.word.length < 2) { this.hideSuggest(); return; }
    const own = [...new Set((this.textarea.value.match(/^\s*(?:var\s+|varip\s+)?(?:\w+\s+)?([A-Za-z_]\w*)\s*(?:=|\()/gm) || []).map(x => x.replace(/^\s*(var|varip)\s+/, '').match(/([A-Za-z_]\w*)\s*(?:=|\()/)?.[1]).filter(Boolean))];
    const pool = [...new Set([...own, ...PINE_NAMES])];
    const q = w.word.toLowerCase();
    const items = pool.filter(n => n.toLowerCase().startsWith(q) && n !== w.word).slice(0, 10);
    if (!items.length) { this.hideSuggest(); return; }
    this.suggItems = items;
    this.suggSel = 0;
    this.suggWord = w;
    // place the list at the caret (mirror div with the same text metrics)
    const ta = this.textarea, cs = getComputedStyle(ta);
    const mirror = h('div', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: cs.font, padding: cs.padding, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing } });
    mirror.textContent = ta.value.slice(0, w.end);
    const mark = h('span', null, '|');
    mirror.append(mark);
    document.body.append(mirror);
    const lines = ta.value.slice(0, w.end).split('\n');
    const lh = parseFloat(cs.lineHeight) || 18;
    const x = mark.offsetLeft - ta.scrollLeft, y = (lines.length) * lh + parseFloat(cs.paddingTop || 0) - ta.scrollTop;
    mirror.remove();
    this.sugg.style.left = `${ta.offsetLeft + Math.min(x, ta.clientWidth - 200)}px`;
    this.sugg.style.top = `${ta.offsetTop + y + 2}px`;
    this.sugg.hidden = false;
    this.paintSuggest();
  }
  paintSuggest() {
    fill(this.sugg, this.suggItems.map((n, k) => h('div', { class: 'se-sugg-item' + (k === this.suggSel ? ' sel' : ''), onmousedown: e => { e.preventDefault(); this.suggSel = k; this.acceptSuggest(); } }, n)));
  }
  acceptSuggest() {
    const n = this.suggItems?.[this.suggSel], w = this.suggWord;
    if (!n || !w) return;
    const ta = this.textarea, isFn = /^(ta|math|str|array|color|line|label|box|table|request|input|strategy|log|timeframe)\.\w+$|^(plot\w*|hline|fill|bgcolor|barcolor|alert\w*|indicator|strategy|na|nz|fixnan|input)$/.test(n) && !/^(strategy\.(long|short|position_size|position_avg_price|equity|netprofit|openprofit|opentrades|closedtrades|percent_of_equity|fixed|cash)|color\.(red|green|blue|orange|yellow|purple|teal|aqua|lime|white|black|gray|silver|maroon|navy|fuchsia|olive)|math\.pi)$/.test(n);
    const insert = isFn ? `${n}()` : n;
    ta.value = ta.value.slice(0, w.start) + insert + ta.value.slice(w.end);
    const caret = w.start + insert.length - (isFn ? 1 : 0);
    ta.selectionStart = ta.selectionEnd = caret;
    this.hideSuggest();
    this.updateGutter(); this.updateStatus();
    ta.focus();
  }
  hideSuggest() { if (this.sugg) this.sugg.hidden = true; }

  async addToChart() {
    if ((this.dirty || !this.current?.meta) && !(await this.save())) { toast('Fix the script errors before adding it', 'error'); return; }
    this.app.activeView.addScriptIndicator(this.currentId);
  }

  async remove() {
    const sc = this.current;
    if (!sc || !(await confirmBox(`Delete script “${sc.name}”? It will also be removed from your charts.`, 'Delete'))) return;
    for (const v of this.app.views) {
      const ids = v.cfg.indicators.filter(i => i.type === 'SCRIPT' && i.scriptId === sc.id).map(i => i.id);
      for (const id of ids) v.removeIndicator(id);
    }
    deleteScript(sc.id);
    this.currentId = listScripts()[0]?.id || null;
    this.messages = [];
    this.render();
  }
}
