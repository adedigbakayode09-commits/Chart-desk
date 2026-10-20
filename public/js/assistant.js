// "Ask Claude" chart assistant — browser half.
// Holds the conversation, sends each turn to /api/assistant (the server holds the API key), and executes
// Claude's tool calls against the active chart. History is append-only (required for Claude's thinking
// blocks) and saved, so the conversation survives reloads. "Undo" reverts everything the last request changed.

import { $, h, icon, kv, api, toast, uid, fmtDateTime } from './util.js';
import { spec, SYMBOLS, tfLabel } from './data.js';
import { IND_DEFS, indTitle } from './indicators-ui.js';

const MAX_STEPS = 8;
// Every turn re-sends the conversation; past this size start fresh (the chart itself is re-read when needed).
const MAX_HISTORY_CHARS = 40000;
const SUGGESTIONS = [
  'Add EMA 50 and EMA 200',
  'Mark the high and low of the last 100 candles',
  'Switch to 4h and add RSI 14',
  'Draw a Fibonacci retracement over the most recent swing',
];

const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
function parseTime(s, field = 'time') {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`${field} "${s}" is not a valid ISO 8601 time`);
  return Math.floor(t / 1000);
}
const r = (v, p) => (v == null ? null : Number(v.toFixed(p)));

export class Assistant {
  constructor(app) {
    this.app = app;
    this.el = $('#assistant');
    this.history = [];
    this.busy = false;
    this.build();
  }

  async init() {
    const saved = await kv.get('assistant', null);
    this.history = saved?.history || [];
    this.status = await api('/api/assistant/status').catch(() => null);
    this.renderLog();
  }

  build() {
    this.log = h('div', { class: 'as-log' });
    this.input = h('textarea', { rows: 2, placeholder: 'Ask Claude to edit your chart… (Enter to send, Shift+Enter for a new line)' });
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } });
    this.sendBtn = h('button', { class: 'btn primary', onclick: () => this.send() }, icon('send'), 'Send');
    this.undoBtn = h('button', { class: 'tb-btn icon-only', title: 'Undo Claude\'s last changes', disabled: true, onclick: () => this.undo() }, icon('stepBack'));
    this.el.replaceChildren(
      h('div', { class: 'as-head' },
        h('span', { class: 'as-title' }, icon('sparkle'), 'Ask Claude'),
        h('div', { class: 'spacer' }),
        this.undoBtn,
        h('button', { class: 'tb-btn icon-only', title: 'New conversation', onclick: () => this.clear() }, icon('trash')),
        h('button', { class: 'tb-btn icon-only', title: 'Close', onclick: () => this.app.toggleAssistant(false) }, icon('close'))),
      this.log,
      h('div', { class: 'as-input' }, this.input, this.sendBtn));
  }

  focus() { setTimeout(() => this.input.focus(), 0); }
  save() { kv.set('assistant', { history: this.history.slice(-200) }); }

  async clear() {
    if (this.busy) return;
    this.history = [];
    this.notes = [];
    this.save();
    this.renderLog();
  }

  // ---------------------------------------------------------------- conversation loop
  async send(text = this.input.value.trim()) {
    if (!text || this.busy) return;
    this.input.value = '';
    if (JSON.stringify(this.history).length > MAX_HISTORY_CHARS) {
      this.history = [];
      this.notes = [{ text: 'Started a fresh conversation to keep API usage low.', at: 0 }];
    }
    this.busy = true;
    let cost = 0, tokens = 0;
    this.sendBtn.disabled = true;
    this.snapshot = await this.takeSnapshot();
    this.history.push({ role: 'user', content: [{ type: 'text', text }] });
    this.renderLog(true);
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await api('/api/assistant', { method: 'POST', body: { messages: this.history } });
        this.history.push({ role: 'assistant', content: res.content });
        cost += res.costUsd || 0;
        const u = res.usage || {};
        tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const uses = res.content.filter(b => b.type === 'tool_use');
        if (res.stop_reason === 'refusal') {
          this.history.push(...this.unrunResults(uses, 'Request declined'));
          this.note(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : '.'}`);
          break;
        }
        if (res.stop_reason !== 'tool_use' || !uses.length) {
          if (uses.length) this.history.push(...this.unrunResults(uses, `Not run (stopped: ${res.stop_reason})`));
          if (res.stop_reason === 'max_tokens') this.note('Claude ran out of output space — try a smaller request.');
          break;
        }
        this.renderLog(true);
        const results = [];
        for (const u of uses) {
          try {
            const out = await this.exec(u.name, u.input || {});
            results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ error: e.message }), is_error: true });
          }
        }
        this.history.push({ role: 'user', content: results });
        this.renderLog(true);
        if (step === MAX_STEPS - 1) this.note('Stopped after many steps — ask again to continue.');
      }
      if (tokens) this.note(`≈ $${cost.toFixed(cost < 0.01 ? 4 : 3)} · ${(tokens / 1000).toFixed(1)}k tokens`);
    } catch (e) {
      this.note(e.message, true);
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.undoBtn.disabled = !this.snapshot;
      this.save();
      this.renderLog();
    }
  }

  /** Keep the history valid if Claude's tool calls can't run (every tool_use needs a tool_result). */
  unrunResults(uses, why) {
    if (!uses.length) return [];
    return [{ role: 'user', content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: why, is_error: true })) }];
  }

  note(text, error = false) { this.notes = [...(this.notes || []), { text, error, at: this.history.length }]; this.renderLog(); }

  // ---------------------------------------------------------------- rendering
  renderLog(thinking = false) {
    const kids = [];
    if (this.status && !this.status.configured) {
      kids.push(h('div', { class: 'as-setup' }, h('b', null, 'Connect Claude'),
        h('p', null, 'ChartDesk calls Claude through its local server so your key stays off the web page. Set ', h('code', null, 'ANTHROPIC_API_KEY'),
          ' (or run ', h('code', null, 'ant auth login'), ') in the terminal that starts ChartDesk, then restart it with ', h('code', null, 'npm start'), '.')));
    }
    if (!this.history.length) {
      kids.push(h('div', { class: 'as-empty' },
        h('p', null, `Tell Claude what to change on your ${this.app.activeView?.symbol || ''} chart — indicators, drawings, timeframe, layout — or ask about what's on it.`),
        h('div', { class: 'as-suggest' }, SUGGESTIONS.map(s => h('button', { class: 'chip', onclick: () => this.send(s) }, s)))));
    }
    const toolNames = new Map();
    this.history.forEach((m, i) => {
      for (const n of (this.notes || []).filter(x => x.at === i)) kids.push(h('div', { class: 'as-note' + (n.error ? ' error' : '') }, n.text));
      if (!Array.isArray(m.content)) return;
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) kids.push(h('div', { class: `as-msg ${m.role}` }, b.text));
        else if (b.type === 'tool_use') toolNames.set(b.id, b.name);
        else if (b.type === 'tool_result') {
          let out = null;
          try { out = JSON.parse(b.content); } catch { out = { error: b.content }; }
          const name = toolNames.get(b.tool_use_id);
          if (name === 'get_chart_state' && !b.is_error) kids.push(h('div', { class: 'as-tool muted' }, '• Read the chart'));
          else kids.push(h('div', { class: 'as-tool' + (b.is_error ? ' error' : '') }, b.is_error ? `✕ ${out?.error || 'failed'}` : `✓ ${out?.summary || name}`));
        }
      }
    });
    for (const n of (this.notes || []).filter(x => x.at >= this.history.length)) kids.push(h('div', { class: 'as-note' + (n.error ? ' error' : '') }, n.text));
    if (thinking && this.busy) kids.push(h('div', { class: 'as-thinking' }, h('i'), h('i'), h('i')));
    this.log.replaceChildren(...kids);
    this.log.scrollTop = this.log.scrollHeight;
  }

  // ---------------------------------------------------------------- undo
  async takeSnapshot() {
    const app = this.app;
    return {
      layout: { mode: app.layoutMode, views: app.views.map(v => structuredClone(v.toJSON())), active: app.views.indexOf(app.activeView) },
      theme: app.theme,
      drawings: new Map(),
    };
  }
  /** Remember a symbol's drawings the first time this request touches them. */
  touchDrawings(symbol) {
    const snap = this.snapshot;
    if (snap && !snap.drawings.has(symbol)) snap.drawings.set(symbol, structuredClone(this.app.drawingsFor(symbol)));
  }
  async undo() {
    const snap = this.snapshot;
    if (!snap || this.busy) return;
    const app = this.app;
    for (const [symbol, saved] of snap.drawings) {
      const list = app.drawingsFor(symbol);
      list.splice(0, list.length, ...saved);
      app.saveDrawings(symbol);
    }
    if (snap.theme !== app.theme) app.setTheme(snap.theme);
    await app.setLayout(snap.layout.mode, snap.layout.views, snap.layout.active);
    this.snapshot = null;
    this.undoBtn.disabled = true;
    this.history.push({ role: 'user', content: [{ type: 'text', text: '(I used Undo: every change from your last reply has been reverted.)' }] });
    this.save();
    this.renderLog();
    toast('Reverted Claude\'s last changes');
  }

  // ---------------------------------------------------------------- tools
  get view() { return this.app.activeView; }

  async exec(name, input) {
    const fn = this[`tool_${name}`];
    if (!fn) throw new Error(`Unknown tool ${name}`);
    return fn.call(this, input);
  }

  tool_get_chart_state({ candles = 0 }) {
    const v = this.view, s = v.spec, p = v.prec;
    const n = Math.max(0, Math.min(200, candles | 0));
    const bars = v.bars.slice(-n);
    const range = v.chart.timeScale().getVisibleRange();
    const lastIdx = v.bars.length - 1;
    const indicators = v.cfg.indicators.map(ind => {
      const rt = v.runtimes.find(x => x.ind === ind);
      const values = rt?.outputs.map(o => o[lastIdx]?.value ?? null) || [];
      return { id: ind.id, type: ind.type, title: indTitle(ind), params: ind.params, color: ind.color || null, visible: ind.visible !== false, latest_values: values.map(x => (x == null ? null : r(x, 4))) };
    });
    const drawings = v.drawings.map(d => ({
      id: d.id, type: d.type, color: d.color || null,
      points: d.pts.map(pt => ({ time: iso(pt.time), price: r(pt.price, p) })),
      ...(d.stop != null ? { stop: r(d.stop, p), target: r(d.target, p), end_time: iso(d.endTime) } : {}),
      ...(d.text != null ? { text: d.text } : {}),
    }));
    return {
      symbol: v.symbol, name: s.name, market: s.market, provider: s.provider, quote_currency: s.quote,
      timeframe: v.cfg.tf, timeframe_label: tfLabel(v.cfg.tf), chart_type: v.cfg.chartType, price_scale: ['normal', 'log', 'percent'][v.cfg.scaleMode || 0],
      price_precision: p, theme: this.app.theme, layout: this.app.layoutMode, charts_in_layout: this.app.views.map(x => `${x.symbol} ${tfLabel(x.cfg.tf)}`),
      replay: this.app.replay.active ? { active: true, cursor: iso(this.app.replay.cursor), note: 'Only candles before the cursor exist on the chart.' } : { active: false },
      loaded_candles: v.bars.length,
      loaded_range: v.bars.length ? { from: iso(v.bars[0].time), to: iso(v.bars[lastIdx].time) } : null,
      visible_range: range ? { from: iso(range.from), to: iso(range.to) } : null,
      indicators, drawings,
      candles: bars.map(b => [iso(b.time), r(b.open, p), r(b.high, p), r(b.low, p), r(b.close, p)]),
      candle_format: '[time, open, high, low, close]',
    };
  }

  async tool_set_symbol({ symbol }) {
    const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!spec(s)) throw new Error(`Unknown symbol ${symbol}. Available: ${SYMBOLS.map(x => x.symbol).join(', ')}`);
    if (this.app.replay.active && s !== this.app.replay.symbol) throw new Error(`Bar Replay is trading ${this.app.replay.symbol}; leave replay to switch symbols`);
    await this.view.setSymbol(s);
    const empty = !this.view.bars.length;
    return { summary: `Switched to ${s}`, candles_loaded: this.view.bars.length, ...(empty ? { warning: `No ${s} data is cached; the user can download it from the Data manager.` } : {}) };
  }
  async tool_set_timeframe({ timeframe }) {
    await this.view.setTf(timeframe);
    return { summary: `Timeframe set to ${tfLabel(timeframe)}`, candles_loaded: this.view.bars.length };
  }
  tool_set_chart_type({ chart_type }) {
    this.view.setChartType(chart_type);
    return { summary: `Chart type: ${chart_type}` };
  }

  cleanParams(type, input) {
    const def = IND_DEFS[type];
    const params = {};
    for (const k of Object.keys(def.params)) {
      const v = input[k];
      if (v == null) continue;
      if (def.choices?.[k]) {
        if (!def.choices[k].some(([c]) => c === v)) throw new Error(`${k} must be one of ${def.choices[k].map(([c]) => c).join(', ')}`);
        params[k] = v;
        continue;
      }
      if (!(v > 0)) throw new Error(`${k} must be greater than zero`);
      params[k] = def.steps?.[k] || k === 'mult' ? Number(v) : Math.round(v);
    }
    return params;
  }
  tool_add_indicator(input) {
    const ind = this.view.addIndicator(input.type, this.cleanParams(input.type, input), input.color);
    return { summary: `Added ${indTitle(ind)}`, id: ind.id };
  }
  tool_update_indicator(input) {
    const v = this.view;
    const ind = v.cfg.indicators.find(i => i.id === input.id);
    if (!ind) throw new Error(`No indicator with id ${input.id}`);
    Object.assign(ind.params, this.cleanParams(ind.type, input));
    if (input.color) ind.color = input.color;
    if (input.visible != null) ind.visible = input.visible;
    this.app.onViewChanged(v);
    v.rebuildAll();
    return { summary: `Updated ${indTitle(ind)}` };
  }
  tool_remove_indicator({ id }) {
    const v = this.view;
    const ind = v.cfg.indicators.find(i => i.id === id);
    if (!ind) throw new Error(`No indicator with id ${id}`);
    v.removeIndicator(id);
    return { summary: `Removed ${indTitle(ind)}` };
  }

  addDrawing(d, summary) {
    const v = this.view;
    if (!v.bars.length) throw new Error('The chart has no candles to draw on');
    this.touchDrawings(v.symbol);
    v.addDrawing({ id: uid(), color: '#2962ff', ...d });
    v.selected = null;
    return { summary, id: v.drawings[v.drawings.length - 1].id };
  }
  lastTime() { const b = this.view.bars; return b[b.length - 1].time; }
  lastClose() { const b = this.view.bars; return b[b.length - 1].close; }
  fp(x) { return Number(x).toFixed(this.view.prec); }

  tool_draw_horizontal_line({ price, color }) {
    return this.addDrawing({ type: 'hline', pts: [{ time: this.lastTime(), price }], ...(color ? { color } : {}) }, `Horizontal line at ${this.fp(price)}`);
  }
  tool_draw_vertical_line({ time, color }) {
    const t = parseTime(time);
    return this.addDrawing({ type: 'vline', pts: [{ time: t, price: this.lastClose() }], ...(color ? { color } : {}) }, `Vertical line at ${fmtDateTime(t)}`);
  }
  tool_draw_trend_line({ start_time, start_price, end_time, end_price, extend_right, color }) {
    const pts = [{ time: parseTime(start_time, 'start_time'), price: start_price }, { time: parseTime(end_time, 'end_time'), price: end_price }];
    return this.addDrawing({ type: extend_right ? 'ray' : 'trend', pts, ...(color ? { color } : {}) }, `${extend_right ? 'Ray' : 'Trend line'} ${this.fp(start_price)} → ${this.fp(end_price)}`);
  }
  tool_draw_rectangle({ start_time, start_price, end_time, end_price, color }) {
    const pts = [{ time: parseTime(start_time, 'start_time'), price: start_price }, { time: parseTime(end_time, 'end_time'), price: end_price }];
    return this.addDrawing({ type: 'rect', pts, ...(color ? { color } : {}) }, `Zone ${this.fp(Math.min(start_price, end_price))}–${this.fp(Math.max(start_price, end_price))}`);
  }
  tool_draw_fibonacci({ start_time, start_price, end_time, end_price }) {
    const pts = [{ time: parseTime(start_time, 'start_time'), price: start_price }, { time: parseTime(end_time, 'end_time'), price: end_price }];
    return this.addDrawing({ type: 'fib', pts }, `Fibonacci ${this.fp(start_price)} → ${this.fp(end_price)}`);
  }
  tool_draw_position({ side, entry_time, entry_price, stop_price, target_price, end_time }) {
    const dir = side === 'long' ? 1 : -1;
    if (!((entry_price - stop_price) * dir > 0)) throw new Error(`For a ${side}, the stop must be ${dir > 0 ? 'below' : 'above'} the entry`);
    if (!((target_price - entry_price) * dir > 0)) throw new Error(`For a ${side}, the target must be ${dir > 0 ? 'above' : 'below'} the entry`);
    const t0 = parseTime(entry_time, 'entry_time'), t1 = parseTime(end_time, 'end_time');
    if (t1 <= t0) throw new Error('end_time must be after entry_time');
    const rr = Math.abs(target_price - entry_price) / Math.abs(entry_price - stop_price);
    return this.addDrawing({ type: side, pts: [{ time: t0, price: entry_price }], stop: stop_price, target: target_price, endTime: t1 },
      `${side === 'long' ? 'Long' : 'Short'} position @ ${this.fp(entry_price)} (R:R ${rr.toFixed(2)})`);
  }
  tool_add_text({ time, price, text, color }) {
    if (!String(text).trim()) throw new Error('text is empty');
    return this.addDrawing({ type: 'text', pts: [{ time: parseTime(time), price }], text: String(text), size: 14, ...(color ? { color } : {}) }, `Note “${String(text).slice(0, 40)}”`);
  }
  tool_remove_drawings({ ids }) {
    const v = this.view, list = v.drawings;
    this.touchDrawings(v.symbol);
    const before = list.length;
    if (ids == null) list.length = 0;
    else {
      const missing = ids.filter(id => !list.some(d => d.id === id));
      if (missing.length === ids.length) throw new Error(`No drawings with ids ${ids.join(', ')}`);
      for (let i = list.length - 1; i >= 0; i--) if (ids.includes(list[i].id)) list.splice(i, 1);
    }
    v.selected = null;
    this.app.saveDrawings(v.symbol);
    return { summary: `Removed ${before - list.length} drawing(s)` };
  }
  tool_set_visible_range({ from, to }) {
    const v = this.view, a = parseTime(from, 'from'), b = parseTime(to, 'to');
    if (b <= a) throw new Error('to must be after from');
    v.setAllRanges({ from: v.timeToLogical(a), to: v.timeToLogical(b) });
    return { summary: `Showing ${fmtDateTime(a)} → ${fmtDateTime(b)}` };
  }
  tool_set_price_scale({ mode }) {
    this.view.setScaleMode({ normal: 0, log: 1, percent: 2 }[mode]);
    this.app.refreshToolbar();
    return { summary: `Price scale: ${mode}` };
  }
  async tool_set_layout({ layout }) {
    await this.app.setLayout(layout);
    return { summary: `Layout: ${layout === '1' ? 'single chart' : `${layout} charts`}` };
  }
  tool_set_theme({ theme }) {
    this.app.setTheme(theme);
    return { summary: `${theme === 'dark' ? 'Dark' : 'Light'} theme` };
  }
}
