// Strategy Tester panel: configure a built-in strategy, run it on real history, inspect the results.

import { h, icon, kv, toast, fmtUsd, fmtPrice, fmtDateTime, fmtDuration, fmtDate, parseUtcInput, formFields, ACCENT } from './util.js';
import { fetchRange, spec, tfLabel, tfSec, precisionOf } from './data.js';
import { STRATEGIES, DEFAULT_SETTINGS, runBacktest, validateSettings, computeMetrics } from './core/backtest.js';
import { listScripts, getScript, runScript } from './scripts.js';
import { canTrade, EXECUTION_NOTES } from './core/broker.js';
import { themeColors } from './chartview.js';

const LC = window.LightweightCharts;
const MAX_BINANCE_MINUTE_DAYS = 31;

/** Typical costs for a symbol (catalog defaults). */
const costDefaults = sp => ({ commissionPerLot: sp?.commissionPerLot ?? 0, commissionPct: sp?.commissionPct ?? 0, slippage: 0, spreadMode: 'data', fixedSpread: sp?.defaultSpread ?? 0 });

export class Tester {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.result = null;
    this.tab = 'overview';
    this.state = { strategy: 'ema_cross', params: {}, settings: structuredClone(DEFAULT_SETTINGS), from: '', to: '' };
    kv.get('tester').then(s => { if (s) this.state = { ...this.state, ...s, settings: { ...this.state.settings, ...s.settings, exec: { ...this.state.settings.exec, ...s.settings?.exec } } }; this.render(); });
  }

  /** Re-render when the active chart's symbol/timeframe changed (keeps the form's current values). */
  syncTarget() {
    const v = this.app.activeView;
    if (!v || this.running || this.targetKey === `${v.symbol}|${v.cfg.tf}`) return;
    if (this.form) this.collect();
    this.render();
  }

  /** Pine strategy scripts saved in My scripts (strategy(…) instead of indicator(…)). */
  pineStrategies() { return listScripts().filter(sc => sc.meta?.strategy); }
  get pineId() { return this.state.strategy?.startsWith('pine:') ? this.state.strategy.slice(5) : null; }

  render() {
    const view = this.app.activeView;
    if (!view) return;
    this.targetKey = `${view.symbol}|${view.cfg.tf}`;
    const st = this.state;
    if (this.pineId && !getScript(this.pineId)?.meta?.strategy) st.strategy = 'ema_cross';
    if (this.pineId) return this.renderPine(view);
    const strat = STRATEGIES[st.strategy];
    st.params = { ...strat.params, ...(st.paramsFor?.[st.strategy] || {}) };
    const sp = view.spec;
    const lastBar = view.all?.[view.all.length - 1];
    const maxTo = this.app.replay.active ? this.app.replay.cursor : (lastBar ? lastBar.start + tfSec(view.cfg.tf) : Date.now() / 1000);
    if (!st.from) st.from = fmtDate(maxTo - 365 * 86400);
    if (!st.to) st.to = fmtDate(maxTo);

    const stratSel = this.strategySelect();
    this.paramsForm = formFields(Object.entries(st.params).map(([k, v]) => ({
      key: k, label: strat.labels?.[k] || k[0].toUpperCase() + k.slice(1), value: v, min: 0, type: typeof v === 'boolean' ? 'checkbox' : undefined,
    })));
    // Trading costs are kept per symbol (a crypto exchange fee must never leak into a gold test).
    const s = st.settings;
    const ex = { ...s.exec, ...costDefaults(sp), ...(st.costs?.[view.symbol] || {}) };
    this.form = formFields([
      { key: 'direction', label: 'Direction', type: 'select', value: s.direction, options: [['both', 'Long & short'], ['long', 'Long only'], ['short', 'Short only']] },
      { key: 'reverse', label: 'Reverse on opposite signal', type: 'checkbox', value: s.reverse },
      { key: 'stopType', label: 'Stop-loss', type: 'select', value: s.stopType, options: [['strategy', 'Strategy stop (structure)'], ['atr', 'ATR multiple'], ['points', 'Price distance'], ['none', 'None']] },
      { key: 'stopValue', label: 'Stop value', value: s.stopValue, min: 0 },
      { key: 'targetType', label: 'Take-profit', type: 'select', value: s.targetType, options: [['rr', 'R multiple'], ['strategy', 'Strategy target'], ['atr', 'ATR multiple'], ['points', 'Price distance'], ['none', 'None']] },
      { key: 'targetValue', label: 'Target value', value: s.targetValue, min: 0 },
      { key: 'atrLength', label: 'ATR length', value: s.atrLength, min: 1 },
      { key: 'maxBars', label: 'Max candles in trade (0 = off)', value: s.maxBars ?? 0, min: 0 },
      { key: 'breakevenR', label: 'Breakeven at (R, 0 = off)', value: s.breakevenR ?? 0, min: 0, step: 0.25 },
      { key: 'trailR', label: 'Trailing stop (R, 0 = off)', value: s.trailR ?? 0, min: 0, step: 0.25 },
      { key: 'sizing', label: 'Position size', type: 'select', value: s.sizing, options: [['risk', 'Risk % of equity'], ['fixed', `Fixed lots (${sp?.lotName || 'lots'})`], ['equity', '% of equity (notional)']] },
      { key: 'sizeValue', label: 'Size value', value: s.sizeValue, min: 0 },
      { key: 'intrabar', label: 'Intrabar fills', type: 'select', value: s.intrabar, options: [['m1', 'Real 1-minute data'], ['ohlc', 'Bar OHLC (faster)']] },
      { key: 'balance', label: 'Initial capital ($)', value: ex.balance, min: 1 },
      { key: 'leverage', label: 'Leverage (x)', value: ex.leverage, min: 1 },
      { key: 'commissionPerLot', label: 'Commission / lot RT ($)', value: ex.commissionPerLot, min: 0 },
      { key: 'commissionPct', label: 'Commission % / side', value: ex.commissionPct, min: 0, step: 0.01 },
      { key: 'slippage', label: 'Slippage (price)', value: ex.slippage, min: 0 },
      { key: 'spreadMode', label: 'Spread', type: 'select', value: ex.spreadMode, options: [['data', 'Real (tick data)'], ['fixed', 'Fixed']] },
      { key: 'fixedSpread', label: 'Fixed / fallback spread', value: ex.fixedSpread, min: 0 },
      { key: 'from', label: 'From (UTC)', type: 'date', value: st.from },
      { key: 'to', label: 'To (UTC)', type: 'date', value: st.to },
    ]);
    this.progress = h('div', { class: 'progress', hidden: true }, h('div'));
    this.status = h('div', { class: 'muted small' });
    this.results = h('div', { class: 'tester-results' });
    const tfNote = strat.timeframe && view.cfg.tf !== strat.timeframe
      ? h('div', { class: 'note warn-note' }, `This strategy was designed and tested on the ${tfLabel(strat.timeframe)} chart. On ${tfLabel(view.cfg.tf)} the range, ATR and entries are measured in ${tfLabel(view.cfg.tf)} candles and the results are not meaningful — switch the chart to ${tfLabel(strat.timeframe)}.`)
      : null;
    const noCosts = !(Number(ex.fixedSpread) > 0) && !(Number(ex.commissionPerLot) > 0) && !(Number(ex.commissionPct) > 0) && !(Number(ex.slippage) > 0);
    const costNote = noCosts && sp?.provider !== 'binance'
      ? h('div', { class: 'note warn-note' }, `Spread, commission and slippage are all zero, so results will look better than real trading. Typical ${view.symbol} costs: spread ${sp?.defaultSpread ?? '—'}, commission $${sp?.commissionPerLot ?? 0}/lot.`, ' ',
        h('button', { class: 'btn small', onclick: () => { st.costs = { ...(st.costs || {}), [view.symbol]: { ...costDefaults(sp), slippage: +((sp?.defaultSpread ?? 0) / 6).toFixed(4) } }; this.render(); } }, 'Use typical costs'))
      : null;
    const replayNote = this.app.replay.active ? h('div', { class: 'note' }, `Replay is active: tests stop at the replay cursor (${fmtDateTime(this.app.replay.cursor)} UTC) so no future data is used.`) : null;
    this.host.replaceChildren(h('div', { class: 'tester' },
      h('div', { class: 'tester-form' },
        h('div', { class: 'tester-target' }, h('b', null, `${view.symbol} · ${tfLabel(view.cfg.tf)}`), h('span', { class: 'muted' }, 'active chart')),
        h('label', { class: 'field wide' }, h('span', null, 'Strategy'), stratSel),
        h('p', { class: 'muted small' }, strat.desc),
        tfNote,
        this.paramsForm.el,
        this.form.el,
        costNote,
        replayNote,
        h('details', { class: 'notes' }, h('summary', null, 'Execution model & limitations'), h('ul', null, EXECUTION_NOTES.map(n => h('li', null, n)),
          h('li', null, 'Signals use closed bars only and fill at the next bar\'s open (no look-ahead).'))),
        h('div', { class: 'tester-run' }, h('button', { class: 'btn primary', onclick: () => this.run() }, icon('play'), 'Run backtest'), this.progress),
        this.status),
      this.results));
    this.renderResults();
  }

  /** Built-in strategies plus your Pine strategies, and a shortcut to write one. */
  strategySelect() {
    const st = this.state;
    const sel = h('select', { onchange: () => {
      if (sel.value === '__newpine') { sel.value = st.strategy; this.app.showPanel('scripts'); this.app.scriptEditor.create('pineStrategy'); toast('Edit the template or paste your Pine strategy, save it, then pick it here'); return; }
      if (this.form && !this.pineId) this.collect();
      st.strategy = sel.value;
      // strategies that ship tested settings apply them (stop/target type, size) when selected
      const rec = STRATEGIES[st.strategy]?.recommended;
      if (rec) { Object.assign(st.settings, rec); toast('Applied this strategy\'s tested settings'); }
      kv.set('tester', st);
      this.render();
    } },
    h('optgroup', { label: 'Built-in strategies' }, Object.entries(STRATEGIES).map(([k, s]) => h('option', { value: k }, s.name))),
    h('optgroup', { label: 'Pine strategies (My scripts)' }, this.pineStrategies().map(sc => h('option', { value: `pine:${sc.id}` }, sc.name)),
      h('option', { value: '__newpine' }, '＋ Write or paste a Pine strategy…')));
    sel.value = st.strategy;
    return sel;
  }

  /** Form for a Pine strategy: its inputs, the date range and TradingView-style Properties overrides. */
  renderPine(view) {
    const st = this.state, sc = getScript(this.pineId), meta = sc.meta;
    const saved = st.pineInputs?.[sc.id] || {};
    const inputs = meta.inputs.filter(x => !['color', 'session', 'symbol', 'text_area'].includes(x.kind));
    this.paramsForm = formFields(inputs.slice(0, 40).map(x => {
      const val = saved[x.name] ?? x.def;
      if (x.options) return { key: x.name, label: x.label || x.name, type: 'select', value: String(val), options: x.options.map(o => [String(o), String(o)]) };
      if (x.bool || typeof x.def === 'boolean') return { key: x.name, label: x.label || x.name, type: 'checkbox', value: !!Number(val) || val === true };
      if (typeof x.def === 'string') return { key: x.name, label: x.label || x.name, type: 'text', value: val };
      return { key: x.name, label: x.label || x.name, value: val, step: x.step ?? 'any', min: x.min ?? undefined };
    }));
    const pr = st.pineProps?.[sc.id] || {};
    const lastBar = view.all?.[view.all.length - 1];
    const maxTo = this.app.replay.active ? this.app.replay.cursor : (lastBar ? lastBar.start + tfSec(view.cfg.tf) : Date.now() / 1000);
    if (!st.from) st.from = fmtDate(maxTo - 365 * 86400);
    if (!st.to) st.to = fmtDate(maxTo);
    this.form = formFields([
      { key: 'initial', label: 'Initial capital (blank = script)', value: pr.initial ?? '', min: 1, placeholder: 'script' },
      { key: 'qtyType', label: 'Order size type', type: 'select', value: pr.qtyType ?? '', options: [['', 'As in the script'], ['fixed', 'Contracts / units'], ['cash', 'Cash amount'], ['percent_of_equity', '% of equity']] },
      { key: 'qtyValue', label: 'Order size (blank = script)', value: pr.qtyValue ?? '', min: 0, placeholder: 'script' },
      { key: 'pyramiding', label: 'Pyramiding (blank = script)', value: pr.pyramiding ?? '', min: 0, placeholder: 'script' },
      { key: 'commissionType', label: 'Commission type', type: 'select', value: pr.commissionType ?? '', options: [['', 'As in the script'], ['percent', '% of value'], ['cash_per_contract', '$ per contract'], ['cash_per_order', '$ per order']] },
      { key: 'commission', label: 'Commission (blank = script)', value: pr.commission ?? '', min: 0, step: 0.01, placeholder: 'script' },
      { key: 'slippage', label: 'Slippage in ticks (blank = script)', value: pr.slippage ?? '', min: 0, placeholder: 'script' },
      { key: 'from', label: 'From (UTC)', type: 'date', value: st.from },
      { key: 'to', label: 'To (UTC)', type: 'date', value: st.to },
    ]);
    this.progress = h('div', { class: 'progress', hidden: true }, h('div'));
    this.status = h('div', { class: 'muted small' });
    this.results = h('div', { class: 'tester-results' });
    this.host.replaceChildren(h('div', { class: 'tester' },
      h('div', { class: 'tester-form' },
        h('div', { class: 'tester-target' }, h('b', null, `${view.symbol} · ${tfLabel(view.cfg.tf)}`), h('span', { class: 'muted' }, 'active chart')),
        h('label', { class: 'field wide' }, h('span', null, 'Strategy'), this.strategySelect()),
        h('p', { class: 'muted small' }, 'Pine simulation: market orders fill at the next open, or after execution at the signal close when the script requests it. Compare using the same symbol feed, timeframe, dates, inputs and properties. Higher-timeframe indicators use the history loaded for this test; starting later changes their warm-up.',
          ' ', h('button', { class: 'link', onclick: () => { this.app.showPanel('scripts'); this.app.scriptEditor.select(sc.id); } }, 'Edit script')),
        inputs.length ? h('div', { class: 'cs-heading' }, 'Inputs') : null, this.paramsForm.el,
        h('div', { class: 'cs-heading' }, 'Properties'), this.form.el,
        this.app.replay.active ? h('div', { class: 'note' }, `Replay is active: the test stops at the replay cursor (${fmtDateTime(this.app.replay.cursor)} UTC).`) : null,
        h('div', { class: 'tester-run' }, h('button', { class: 'btn primary', onclick: () => this.runPine() }, icon('play'), 'Run backtest'), this.progress),
        this.status),
      this.results));
    this.renderResults();
  }
  async runPine() {
    if (this.running) return;
    const view = this.app.activeView, st = this.state, sc = getScript(this.pineId);
    const v = this.form.values(), params = this.paramsForm.values();
    st.from = v.from; st.to = v.to;
    const props = { initial: v.initial, qtyType: v.qtyType || null, qtyValue: v.qtyValue, pyramiding: v.pyramiding, commissionType: v.commissionType || null, commission: v.commission, slippage: v.slippage };
    st.pineProps = { ...(st.pineProps || {}), [sc.id]: props };
    // checkboxes → 1/0 like the chart's settings; numbers stay numbers
    const inputs = Object.fromEntries(Object.entries(params).map(([k, x]) => [k, typeof x === 'boolean' ? (x ? 1 : 0) : x]));
    st.pineInputs = { ...(st.pineInputs || {}), [sc.id]: inputs };
    kv.set('tester', st);
    let from = parseUtcInput(st.from), to = parseUtcInput(st.to);
    if (!from || !to || from >= to) { toast('Choose a valid date range', 'error'); return; }
    to += 86400;
    if (this.app.replay.active) to = Math.min(to, this.app.replay.cursor);
    this.running = true;
    const tf = view.cfg.tf;
    this.result = null;
    this.renderResults();
    try {
      this.setProgress(0.05, `Loading ${view.symbol} ${tfLabel(tf)} bars…`);
      const bars = await fetchRange(view.symbol, tf, from, to, n => this.setProgress(0.2, `Loading bars… ${n.toLocaleString()}`));
      if (bars.length < 20) throw new Error(`Only ${bars.length} bars in that range — widen the dates or load more history.`);
      this.setProgress(0.6, `Running ${sc.name} on ${bars.length.toLocaleString()} bars…`);
      const t0 = performance.now();
      const res = await runScript(sc.code, bars, inputs, { ...view.scriptCtx(), strategy: Object.fromEntries(Object.entries(props).filter(([, x]) => x != null && x !== '')) });
      if (res.error) throw new Error(`${res.line ? `Line ${res.line}: ` : ''}${res.error}`);
      const rep = res.strategy;
      if (!rep) throw new Error('The script ran but has no strategy(…) declaration');
      const last = bars[bars.length - 1];
      // Closed-trade statistics must not count unrealized positions as completed trades.
      const trades = rep.trades;
      let bal = rep.cfg.initial;
      for (const t of trades) { bal += t.pnl; t.balanceAfter = bal; }
      const r = {
        trades, open: rep.open, openProfit: rep.openProfit, equity: rep.equity, rejected: [], spreadInfo: null, intrabar: 'ohlc', pine: true,
        metrics: computeMetrics(trades, rep.equity, rep.cfg.initial, bars, tfSec(tf)),
        symbol: view.symbol, tf, from: bars[0].time, to: last.time, bars: bars.length, strategy: sc.name, params: inputs,
        note: (res.warnings || []).slice(0, 3).join(' '),
      };
      this.result = r;
      this.tab = 'overview';
      this.setProgress(null, `Done in ${((performance.now() - t0) / 1000).toFixed(2)}s · ${trades.length} trades${r.note ? ` · ${r.note}` : ''}`);
      this.renderResults();
      view.setMarkers(trades, 'tester');
    } catch (e) {
      this.setProgress(null, '');
      this.status.textContent = `Backtest stopped: ${e.message}`;
      toast(e.message, 'error');
    } finally { this.running = false; }
  }

  collect() {
    const st = this.state;
    if (this.pineId) return st;
    const v = this.form.values();
    st.paramsFor = { ...(st.paramsFor || {}), [st.strategy]: this.paramsForm.values() };
    st.params = st.paramsFor[st.strategy];
    st.from = v.from; st.to = v.to;
    st.settings = {
      direction: v.direction, reverse: v.reverse, stopType: v.stopType, stopValue: v.stopValue, targetType: v.targetType, targetValue: v.targetValue,
      atrLength: v.atrLength, maxBars: v.maxBars || 0, breakevenR: v.breakevenR || 0, trailR: v.trailR || 0, sizing: v.sizing, sizeValue: v.sizeValue, intrabar: v.intrabar,
      exec: { balance: v.balance, leverage: v.leverage, commissionPerLot: v.commissionPerLot, commissionPct: v.commissionPct, slippage: v.slippage, spreadMode: v.spreadMode, fixedSpread: v.fixedSpread, stopOutPct: 50 },
    };
    const sym = this.app.activeView?.symbol;
    if (sym) st.costs = { ...(st.costs || {}), [sym]: { commissionPerLot: v.commissionPerLot, commissionPct: v.commissionPct, slippage: v.slippage, spreadMode: v.spreadMode, fixedSpread: v.fixedSpread } };
    kv.set('tester', st);
    return st;
  }

  setProgress(frac, text) {
    this.progress.hidden = frac == null;
    if (frac != null) this.progress.firstChild.style.width = `${Math.round(frac * 100)}%`;
    if (text != null) this.status.textContent = text;
  }

  async run() {
    if (this.running) return;
    const view = this.app.activeView;
    const st = this.collect();
    const sp = spec(view.symbol);
    if (!canTrade(sp)) { toast(`${view.symbol} can't be tested in a USD account`, 'error'); return; }
    const err = validateSettings(st.settings);
    if (err) { toast(err, 'error'); return; }
    let from = parseUtcInput(st.from), to = parseUtcInput(st.to);
    if (!from || !to || from >= to) { toast('Choose a valid date range', 'error'); return; }
    to += 86400; // inclusive end date
    if (this.app.replay.active) to = Math.min(to, this.app.replay.cursor);
    this.running = true;
    const tf = view.cfg.tf;
    try {
      this.setProgress(0.02, `Loading ${view.symbol} ${tfLabel(tf)} bars…`);
      const bars = await fetchRange(view.symbol, tf, from, to, n => this.setProgress(0.1, `Loading bars… ${n.toLocaleString()}`));
      if (bars.length < 50) throw new Error(`Only ${bars.length} bars in that range — download more history or widen the dates.`);
      let minutes = null, intrabarNote = '';
      if (st.settings.intrabar === 'm1' && tf !== '1m') {
        if (sp.provider === 'binance' && (to - from) / 86400 > MAX_BINANCE_MINUTE_DAYS) {
          intrabarNote = `Intrabar fills used bar OHLC: Binance 1-minute history is limited to ${MAX_BINANCE_MINUTE_DAYS} days per test here.`;
        } else if (sp.provider === 'tradingview') {
          intrabarNote = 'Intrabar fills used bar OHLC: TradingView 1-minute history is limited without an account.';
        } else if (sp.provider === 'twelvedata') {
          intrabarNote = 'Intrabar fills used bar OHLC: downloading Twelve Data 1-minute history for a whole test would use many API credits.';
        } else {
          minutes = await fetchRange(view.symbol, '1m', from, to, n => this.setProgress(0.3, `Loading 1-minute data for intrabar fills… ${n.toLocaleString()}`));
        }
      }
      this.setProgress(0.7, `Simulating ${bars.length.toLocaleString()} bars${minutes ? ` with ${minutes.length.toLocaleString()} minutes` : ''}…`);
      await new Promise(r => setTimeout(r, 20));
      const t0 = performance.now();
      const res = runBacktest({ bars, spec: sp, strategy: st.strategy, params: st.params, settings: st.settings, tfSeconds: tfSec(tf), minutes });
      res.symbol = view.symbol; res.tf = tf; res.from = bars[0].time; res.to = bars[bars.length - 1].time; res.bars = bars.length;
      const wantTf = STRATEGIES[st.strategy].timeframe;
      res.note = [wantTf && wantTf !== tf ? `Designed for ${tfLabel(wantTf)} — this ${tfLabel(tf)} result is not representative.` : '', intrabarNote].filter(Boolean).join(' ');
      res.strategy = STRATEGIES[st.strategy].name; res.params = st.params;
      this.result = res;
      this.tab = 'overview';
      this.setProgress(null, `Done in ${((performance.now() - t0) / 1000).toFixed(2)}s · ${res.trades.length} trades${intrabarNote ? ' · ' + intrabarNote : ''}`);
      this.renderResults();
      view.setMarkers(res.trades, 'tester');
    } catch (e) {
      this.setProgress(null, '');
      toast(e.message, 'error');
    } finally {
      this.running = false;
    }
  }

  renderResults() {
    const r = this.result;
    if (!r) { this.results.replaceChildren(h('div', { class: 'panel-empty small' }, h('p', null, 'Configure a strategy and press Run. Results include win rate, profit factor, drawdown, equity curve and every trade.'))); return; }
    const m = r.metrics, p = precisionOf(r.symbol);
    const tab = (k, l) => h('button', { class: this.tab === k ? 'active' : '', onclick: () => { this.tab = k; this.renderResults(); } }, l);
    const card = (k, v, cls = '', sub = '') => h('div', { class: 'metric' }, h('span', null, k), h('b', { class: cls }, v), sub ? h('small', null, sub) : null);
    const head = h('div', { class: 'metrics' },
      card('Net profit', fmtUsd(m.net, true), m.net >= 0 ? 'up' : 'down', `${(m.netPct * 100).toFixed(2)}%`),
      card('Total trades', m.total, '', `${m.wins} W / ${m.losses} L`),
      ...(r.pine ? [card('Open P&L', fmtUsd(r.openProfit || 0, true), (r.openProfit || 0) >= 0 ? 'up' : 'down', `${r.open?.length || 0} open entries · excluded from closed-trade statistics`)] : []),
      card('Win rate', `${(m.winRate * 100).toFixed(2)}%`),
      card('Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', m.profitFactor >= 1 ? 'up' : 'down'),
      card('Max drawdown', fmtUsd(-m.maxDrawdown), 'down', `${(m.maxDrawdownPct * 100).toFixed(2)}%`),
      card('Avg trade', fmtUsd(m.avgTrade, true), m.avgTrade >= 0 ? 'up' : 'down', m.avgR != null ? `${m.avgR.toFixed(2)} R` : ''),
    );
    const tabs = h('div', { class: 'subtabs' }, tab('overview', 'Overview'), tab('perf', 'Performance summary'), tab('trades', `List of trades (${r.trades.length})`),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `${r.strategy} · ${r.symbol} ${tfLabel(r.tf)} · ${fmtDate(r.from)} → ${fmtDate(r.to)} · ${r.bars.toLocaleString()} bars · fills: ${r.pine ? 'Pine broker emulator (bar OHLC)' : r.intrabar === 'm1' ? '1-minute data' : 'bar OHLC'}`),
      h('button', { class: 'btn small', onclick: () => { this.app.activeView.setMarkers(r.trades, 'tester'); toast('Trades shown on the active chart'); } }, 'Show on chart'),
      h('button', { class: 'btn small', onclick: () => { this.app.activeView.setMarkers([], null); } }, 'Clear markers'));
    let body;
    if (this.tab === 'overview') {
      body = h('div', { class: 'equity-chart' });
      queueMicrotask(() => this.drawEquity(body, r));
    } else if (this.tab === 'perf') {
      const row = (k, all, l, s) => h('tr', null, h('td', null, k), h('td', null, all), h('td', null, l ?? ''), h('td', null, s ?? ''));
      body = h('div', { class: 'tp-table' }, h('table', { class: 'perf' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'All'), h('th', null, 'Long'), h('th', null, 'Short'))),
        h('tbody', null,
          row('Net profit', fmtUsd(m.net, true), fmtUsd(m.long.net, true), fmtUsd(m.short.net, true)),
          row('Gross profit', fmtUsd(m.grossProfit)), row('Gross loss', fmtUsd(-m.grossLoss)),
          row('Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(3) : '∞'),
          row('Total trades', m.total, m.long.count, m.short.count),
          row('Win rate', `${(m.winRate * 100).toFixed(2)}%`, `${(m.long.winRate * 100).toFixed(2)}%`, `${(m.short.winRate * 100).toFixed(2)}%`),
          row('Avg trade', fmtUsd(m.avgTrade, true)), row('Avg winning trade', fmtUsd(m.avgWin, true)), row('Avg losing trade', fmtUsd(m.avgLoss, true)),
          row('Ratio avg win / avg loss', m.avgLoss ? (m.avgWin / -m.avgLoss).toFixed(3) : '—'),
          row('Largest winning trade', fmtUsd(m.largestWin, true)), row('Largest losing trade', fmtUsd(m.largestLoss, true)),
          row('Average R multiple', m.avgR != null ? m.avgR.toFixed(3) : '—'),
          row('Max drawdown', `${fmtUsd(-m.maxDrawdown)} (${(m.maxDrawdownPct * 100).toFixed(2)}%)`),
          row('Max consecutive losses', m.maxConsecLosses),
          row('Sharpe ratio (per bar, annualised)', m.sharpe != null ? m.sharpe.toFixed(3) : '—'),
          row('Buy & hold return', m.buyHoldPct != null ? `${(m.buyHoldPct * 100).toFixed(2)}%` : '—'),
          row('Commission & costs paid', fmtUsd(m.commission)),
          row('Avg time in trade', fmtDuration(m.avgDuration)),
          r.spreadInfo ? row('Spread source', `${r.spreadInfo.dataMinutes.toLocaleString()} measured / ${r.spreadInfo.fixedMinutes.toLocaleString()} fixed`) : null,
          r.rejected.length ? row('Rejected entries', `${r.rejected.length} (${r.rejected[0].reason})`) : null)));
    } else {
      const rows = r.trades.map((t, i) => h('tr', { class: 'clickable', onclick: () => this.app.focusTime(t.entryTime) },
        h('td', null, i + 1), h('td', { class: t.side === 'buy' ? 'buy' : 'sell' }, t.side === 'buy' ? 'Long' : 'Short'),
        h('td', { class: 'muted' }, fmtDateTime(t.entryTime)), h('td', null, fmtPrice(t.entry, p)),
        h('td', { class: 'muted' }, fmtDateTime(t.exitTime)), h('td', null, fmtPrice(t.exit, p)), h('td', null, t.reason),
        h('td', null, +t.lots.toFixed(4)), h('td', null, t.r != null ? t.r.toFixed(2) : '—'),
        h('td', { class: t.pnl >= 0 ? 'up' : 'down' }, fmtUsd(t.pnl, true)), h('td', null, fmtUsd(t.balanceAfter))));
      body = h('div', { class: 'tp-table' }, h('table', null, h('thead', null, h('tr', null, ['#', 'Type', 'Entry time', 'Entry', 'Exit time', 'Exit', 'Signal', 'Lots', 'R', 'P&L', 'Balance'].map(x => h('th', null, x)))), h('tbody', null, rows)));
    }
    this.results.replaceChildren(head, tabs, body);
  }

  drawEquity(el, r) {
    this.equityChart?.remove();
    const c = themeColors(this.app.theme);
    const chart = LC.createChart(el, {
      autoSize: true, layout: { background: { type: LC.ColorType.Solid, color: c.bg }, textColor: c.text, attributionLogo: false },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } }, rightPriceScale: { borderColor: c.border }, timeScale: { borderColor: c.border, timeVisible: true },
    });
    const eq = chart.addAreaSeries({ lineColor: ACCENT, topColor: 'rgba(41,98,255,0.25)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, title: 'Equity' });
    const dd = chart.addHistogramSeries({ priceScaleId: 'dd', color: 'rgba(242,54,69,0.45)', priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, title: 'Drawdown' });
    dd.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
    let peak = r.metrics.initial;
    const eqData = [], ddData = [];
    for (const e of r.equity) {
      if (eqData.length && e.time <= eqData[eqData.length - 1].time) continue;
      peak = Math.max(peak, e.equity);
      eqData.push({ time: e.time, value: e.equity });
      ddData.push({ time: e.time, value: -(peak - e.equity) });
    }
    eq.setData(eqData);
    dd.setData(ddData);
    eq.createPriceLine({ price: r.metrics.initial, color: '#787b86', lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'Start' });
    chart.timeScale().fitContent();
    this.equityChart = chart;
  }

  applyTheme() { if (this.result && this.tab === 'overview') this.renderResults(); }
}


