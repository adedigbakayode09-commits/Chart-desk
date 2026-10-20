// Alerts panel and dialogs. The alerts themselves run in the ChartDesk server (server/alertrunner.js), so they keep
// working with the browser closed: this module edits their definitions (kv "priceAlerts"), shows their status, and
// pops up the alerts the server fires (polled every few seconds). Kinds:
//   price      — crossing / crossing up / down / greater / less than a level (chart line, drag to move)
//   change     — moving up / down X% within a time window
//   indicator  — a built-in indicator line vs a value, the close or another line, checked on each closed bar
//   drawing    — price crossing a trend line, ray, horizontal line or channel drawn on the chart
// During Bar Replay pop-ups are held back (live prices would give away the replay's future) and shown afterwards.

import { h, icon, kv, toast, uid, fill, api, fmtPrice, fmtDateTime, openModal, beep } from './util.js';
import { SYMBOLS, spec, precisionOf, providerLabel, TIMEFRAMES, tfLabel } from './data.js';
import { CONDITIONS, CHANGE_CONDITIONS, alertText, armedAt, isArmed, fmtWindow, DRAWING_ALERT_TYPES } from './core/alerts.js';
import { outputNames } from './core/indicators.js';
import { IND_DEFS, IND_CATEGORIES, indTitle } from './indicators-ui.js';
import { toolTitle } from './drawings.js';

const WINDOWS = [5, 15, 30, 60, 240, 1440, 4320];

export class Alerts {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.list = [];
    this.states = {};
    this.log = [];
    this.held = [];
    this.seq = 0;
    this.version = 0; // bumps on every change (the chart overlay repaints alert lines)
  }

  async init() {
    const d = await kv.get('priceAlerts', null);
    this.list = (d?.alerts || []).map(a => ({ kind: 'price', ...a, armedAt: armedAt(a) }));
    this.settings = (await kv.get('alertSettings', null)) || {};
    this.render();
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
  }
  persist() { kv.set('priceAlerts', { alerts: this.list }, 150); }
  changed() { this.version++; this.persist(); this.render(); this.app.onAlertsChanged?.(); }

  condLabel(c) { return CONDITIONS[c] || CHANGE_CONDITIONS[c] || c; }
  armed(a) { return isArmed(a, this.states[a.id]); }
  textOf(a) { return alertText(a, precisionOf(a.symbol), a.ind ? outputNames(a.ind.type) : []); }
  /** Price-level alerts drawn as lines on the chart. */
  forSymbol(symbol) { return this.list.filter(a => a.symbol === symbol && (a.kind || 'price') === 'price' && this.armed(a)); }
  get activeCount() { return this.list.filter(a => this.armed(a)).length; }

  /** Latest real price we know for a symbol (never a Bar Replay price). */
  lastPrice(symbol) {
    if (!this.app.replay?.active) {
      const v = this.app.views.find(x => x.symbol === symbol && x.bars.length && !x.cfg.chartType?.match(/renko|kagi|pnf|linebreak|range/));
      if (v) return v.bars[v.bars.length - 1].close;
    }
    const q = this.app.watchlist?.quotes?.[symbol];
    return q && !q.none && q.last != null ? q.last : null;
  }
  coverage(a) {
    const sp = spec(a.symbol), st = this.states[a.id];
    if (!sp) return { text: 'Unknown symbol', warn: true };
    if (sp.provider === 'dukascopy') return { text: 'No live data — Dukascopy is historical (switch the source in Data)', warn: true };
    if (sp.provider === 'twelvedata' && !sp.tdConfigured) return { text: 'Twelve Data key missing — see Data', warn: true };
    if (a.kind === 'drawing' && st?.missing) return { text: 'The drawing was deleted', warn: true };
    if (this.offline) return { text: 'ChartDesk server not reachable', warn: true };
    const when = st?.checkedAt ? ` · checked ${new Date(st.checkedAt).toLocaleTimeString()}` : ' · waiting for the first check';
    const extra = a.kind === 'drawing' && st?.level != null ? ` · line at ${fmtPrice(st.level, precisionOf(a.symbol))}` : '';
    return { text: `Watching on the server${when}${extra}` };
  }

  // ---------------------------------------------------------------- create / edit / remove
  add(fields) {
    const now = Date.now();
    const a = { id: uid(), kind: 'price', cond: 'cross', repeat: false, message: '', sound: true, ...fields, active: true, created: now, armedAt: now };
    this.list.push(a);
    this.changed();
    this.askNotifications();
    return a;
  }
  /** Changing what an alert watches (or re-arming it) starts it afresh from now. */
  update(id, patch) {
    const a = this.list.find(x => x.id === id);
    if (!a) return;
    const rearm = ['price', 'cond', 'symbol', 'active', 'pct', 'windowMin', 'tf', 'left', 'right', 'ind'].some(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(a[k]));
    Object.assign(a, patch);
    if ((rearm || patch.rearm) && a.active) a.armedAt = Date.now();
    delete a.rearm;
    this.changed();
  }
  remove(id, undoable = false) {
    const i = this.list.findIndex(x => x.id === id);
    if (i < 0) return;
    const [a] = this.list.splice(i, 1);
    this.changed();
    if (undoable) toast(`Alert removed: ${this.textOf(a)}`, '', [{ label: 'Undo', onClick: () => { this.list.splice(i, 0, a); this.changed(); } }]);
  }
  /** Right-click on the chart → "Add alert": crossing, once. */
  quickAdd(view, price) {
    const p = precisionOf(view.symbol);
    const a = this.add({ symbol: view.symbol, price: Number(price.toFixed(p)) });
    toast(`🔔 Alert set: ${a.symbol} crossing ${fmtPrice(a.price, p)}${spec(a.symbol)?.provider === 'dukascopy' ? ' — no live data for this source, it can\'t fire' : ''}`, '', [{ label: 'Edit', onClick: () => this.openDialog({ id: a.id }) }]);
  }
  /** Bell on a drawing's style bar: alert when price crosses that line. */
  addDrawingAlert(view, d) {
    if (!DRAWING_ALERT_TYPES.has(d.type)) { toast('Alerts work on trend lines, rays, horizontal lines and channels', 'error'); return; }
    const existing = this.list.find(a => a.kind === 'drawing' && a.drawingId === d.id);
    if (existing) { this.openDialog({ id: existing.id }); return; }
    const a = this.add({ kind: 'drawing', symbol: view.symbol, drawingId: d.id, drawingLabel: `${toolTitle(d.type).toLowerCase()}${d.text ? ` “${d.text}”` : ''}`, cond: 'cross' });
    toast(`🔔 Alert set: ${this.textOf(a)}`, '', [{ label: 'Edit', onClick: () => this.openDialog({ id: a.id }) }]);
  }
  askNotifications() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(() => this.render());
  }
  /** Charts call this with every live candle; the server does the checking now. */
  feed() {}

  // ---------------------------------------------------------------- server events
  async poll() {
    let r;
    try { r = await api(`/api/alerts/events?since=${this.seq}`); this.offline = false; } catch { if (!this.offline) { this.offline = true; this.render(); } return; }
    // first poll (or the server restarted): earlier events are already in the log, don't pop them up again
    const fresh = this.boot === r.boot ? r.events : [];
    if (this.boot !== r.boot) this.boot = r.boot;
    this.seq = r.seq;
    const before = JSON.stringify([this.states, this.log.length]);
    this.states = r.states || {};
    this.log = r.log || [];
    this.runner = r.runner;
    for (const ev of fresh) { if (this.app.replay?.active) this.held.push(ev); else this.notify(ev); }
    if (!this.app.replay?.active && this.held.length) {
      const held = this.held.splice(0);
      toast(`🔔 ${held.length} alert${held.length === 1 ? '' : 's'} fired during Bar Replay: ${held.map(e => e.text).join(' · ').slice(0, 220)}`, '', [{ label: 'Show', onClick: () => this.app.showPanel('alerts') }]);
    }
    if (fresh.length || before !== JSON.stringify([this.states, this.log.length])) { this.version++; this.render(); this.app.onAlertsChanged?.(); }
  }
  notify(ev) {
    const p = precisionOf(ev.symbol);
    if (ev.sound !== false) beep();
    const actions = this.app.activeView?.symbol === ev.symbol ? [] : [{ label: 'Open chart', onClick: () => this.app.activeView.setSymbol(ev.symbol) }];
    const text = `${ev.text}${ev.message ? ` — ${ev.message}` : ''}${ev.price != null ? ` · now ${fmtPrice(ev.price, p)}` : ''}`;
    toast(`🔔 ${text}`, '', actions);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`ChartDesk alert · ${ev.symbol}`, { body: text });
  }

  // ---------------------------------------------------------------- panel
  render() {
    if (!this.host) return;
    const notif = !('Notification' in window) ? null
      : Notification.permission === 'granted' ? h('span', { class: 'muted small' }, 'Desktop notifications on')
        : Notification.permission === 'denied' ? h('span', { class: 'muted small' }, 'Desktop notifications blocked in the browser')
          : h('button', { class: 'btn small', onclick: () => this.askNotifications() }, 'Enable desktop notifications');
    const rows = this.list.map(a => {
      const st = this.states[a.id], armed = this.armed(a), cov = this.coverage(a), p = precisionOf(a.symbol);
      const fired = st?.firedAt && (st.firedFor === armedAt(a) || a.repeat);
      const status = !a.active ? h('span', { class: 'muted' }, 'Paused')
        : !armed ? h('span', null, `Triggered ${fmtDateTime(st.firedAt / 1000)} UTC${st.firedPrice != null ? ` @ ${fmtPrice(st.firedPrice, p)}` : ''}`)
          : h('span', { class: cov.warn ? 'down' : '' }, cov.text, fired && a.repeat ? h('span', { class: 'muted' }, ` · last fired ${fmtDateTime(st.firedAt / 1000)}`) : null);
      const kindTag = { price: 'Price', change: '% move', indicator: 'Indicator', drawing: 'Drawing' }[a.kind || 'price'];
      return h('tr', { class: armed ? '' : 'off' },
        h('td', null, h('button', { class: 'link', title: 'Open chart', onclick: () => this.app.activeView.setSymbol(a.symbol) }, a.symbol)),
        h('td', null, h('span', { class: 'tag' }, kindTag)),
        h('td', { class: 'ellipsis', title: this.textOf(a) }, this.textOf(a).replace(`${a.symbol} `, '')),
        h('td', null, a.repeat ? (a.kind === 'indicator' ? 'Every bar close' : 'Every time') : 'Once'), h('td', { class: 'small' }, status),
        h('td', { class: 'ellipsis', title: a.message || '' }, a.message || h('span', { class: 'muted' }, '—'), a.webhook && this.settings.webhookUrl ? h('span', { class: 'tag', title: 'Also sent to your webhook' }, 'webhook') : null),
        h('td', { class: 'actions' },
          armed ? h('button', { class: 'btn small', title: 'Pause', onclick: () => this.update(a.id, { active: false }) }, 'Pause')
            : h('button', { class: 'btn small', title: 'Re-arm from now', onclick: () => this.update(a.id, { active: true, rearm: true }) }, a.active ? 'Re-arm' : 'Resume'),
          h('button', { class: 'btn small', title: 'Edit', onclick: () => this.openDialog({ id: a.id }) }, icon('edit')),
          h('button', { class: 'btn small', title: 'Delete', onclick: () => this.remove(a.id, true) }, icon('trash'))));
    });
    const runnerNote = this.offline ? h('span', { class: 'down small' }, 'Server not reachable — alerts are not running')
      : h('span', { class: 'muted small', title: this.runner?.lastError ? `Last problem: ${this.runner.lastError}` : '' }, 'Alerts run in the ChartDesk server — they keep working with this page closed while ChartDesk is running');
    fill(this.host, h('div', { class: 'alerts' },
      h('div', { class: 'alerts-bar' },
        h('button', { class: 'btn primary small', onclick: () => this.openDialog() }, icon('plus'), 'Create alert'), notif,
        h('button', { class: 'btn small', onclick: () => this.openSettings() }, icon('send'), this.settings.webhookUrl ? 'Webhook on' : 'Webhook / phone'),
        h('div', { class: 'spacer' }), runnerNote),
      this.list.length
        ? h('div', { class: 'tp-table' }, h('table', null,
          h('thead', null, h('tr', null, ['Symbol', 'Type', 'Condition', 'Trigger', 'Status', 'Message', ''].map(x => h('th', null, x)))), h('tbody', null, rows)))
        : h('div', { class: 'panel-empty small' }, h('p', null, 'No alerts yet. Right-click the chart at a price → “Add alert”, click 🔔 on a selected trend line, or press Create alert for % moves and indicator alerts.')),
      this.log.length ? h('details', { class: 'alerts-log' }, h('summary', null, `Alert log (${this.log.length})`),
        h('ul', null, this.log.slice(0, 60).map(l => h('li', null, h('span', { class: 'muted' }, `${fmtDateTime(l.at / 1000)} UTC  `), l.text, l.price != null ? h('span', { class: 'muted' }, ` · ${fmtPrice(l.price, precisionOf(l.symbol))}`) : null))),
        h('button', { class: 'btn small', onclick: async () => { await api('/api/alerts/log', { method: 'DELETE' }); this.log = []; this.render(); } }, 'Clear log')) : null));
  }

  /** Webhook settings: Discord / Slack / Telegram (JSON with `text` + `content`) or ntfy (plain text) for phone pushes. */
  openSettings() {
    const modal = document.getElementById('alertModal'), body = document.getElementById('alertBody');
    const url = h('input', { type: 'text', placeholder: 'https://… (Discord, Slack, Telegram sendMessage, ntfy.sh/your-topic, Zapier…)', value: this.settings.webhookUrl || '' });
    const fmt = h('select', null, h('option', { value: 'json' }, 'JSON (Discord, Slack, Telegram, Zapier, Make, IFTTT)'), h('option', { value: 'text' }, 'Plain text (ntfy — phone push notifications)'));
    fmt.value = this.settings.webhookFormat || 'json';
    const result = h('div', { class: 'muted small' });
    const save = () => { this.settings = { ...this.settings, webhookUrl: url.value.trim(), webhookFormat: fmt.value }; kv.set('alertSettings', this.settings, 50); this.render(); };
    fill(body, h('div', { class: 'form-grid alert-form' },
      h('label', { class: 'field wide' }, h('span', null, 'Webhook URL'), url),
      h('label', { class: 'field wide' }, h('span', null, 'Format'), fmt),
      h('div', { class: 'note small' },
        h('b', null, 'Alerts on your phone: '), 'install the free ntfy app, subscribe to a topic name only you know, and use ', h('code', null, 'https://ntfy.sh/your-topic'), ' with Plain text. ',
        'Telegram: ', h('code', null, 'https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>'), ' with JSON. Discord / Slack: paste the channel\'s incoming-webhook URL (JSON). ',
        'Every fired alert with “Send to webhook” ticked is posted by the ChartDesk server, even when this page is closed.'),
      result),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: async () => {
        save();
        result.textContent = 'Sending a test…';
        try { const r = await api('/api/alerts/test-webhook', { method: 'POST', body: { url: url.value.trim(), format: fmt.value } }); result.textContent = r.ok ? `Test sent (HTTP ${r.status}) — check your app.` : `The webhook answered HTTP ${r.status}.`; } catch (e) { result.textContent = e.message; }
      } }, 'Send test'),
      h('button', { class: 'btn', onclick: () => { modal.hidden = true; } }, 'Close'),
      h('button', { class: 'btn primary', onclick: () => { save(); modal.hidden = true; toast(this.settings.webhookUrl ? 'Webhook saved — tick “Send to webhook” on an alert' : 'Webhook removed'); } }, 'Save')));
    document.getElementById('alertTitle').textContent = 'Alert notifications';
    openModal(modal);
  }

  // ---------------------------------------------------------------- create / edit dialog
  openDialog({ id = null, symbol = null, price = null, kind = null } = {}) {
    const a = id ? this.list.find(x => x.id === id) : null;
    let mode = a?.kind || kind || 'price';
    const sym0 = a?.symbol || symbol || this.app.activeView?.symbol || SYMBOLS[0]?.symbol;
    const modal = document.getElementById('alertModal'), body = document.getElementById('alertBody');
    const lists = this.app.watchlist?.data?.lists || {};
    const symSel = h('select');
    const fillSymbols = () => {
      const keep = symSel.value || sym0;
      fill(symSel, SYMBOLS.map(s => h('option', { value: s.symbol }, `${s.symbol} — ${s.name}`)),
        !a && (mode === 'change' || mode === 'indicator') ? Object.entries(lists).filter(([, l]) => l.length).map(([n, l]) => h('option', { value: `wl:${n}` }, `★ Every symbol in watchlist “${n}” (${l.length})`)) : null);
      symSel.value = keep && [...symSel.options].some(o => o.value === keep) ? keep : sym0;
    };
    // price
    const cond = h('select', null, Object.entries(CONDITIONS).map(([k, l]) => h('option', { value: k }, l)));
    cond.value = a?.cond && CONDITIONS[a.cond] ? a.cond : 'cross';
    const priceIn = h('input', { type: 'number', step: 'any' });
    // percent move
    const chCond = h('select', null, Object.entries(CHANGE_CONDITIONS).map(([k, l]) => h('option', { value: k }, l)));
    chCond.value = a?.kind === 'change' ? a.cond : 'move%';
    const pctIn = h('input', { type: 'number', step: '0.1', min: '0.01', value: a?.pct ?? 1 });
    const winSel = h('select', null, WINDOWS.map(m => h('option', { value: m }, `within ${fmtWindow(m)}`)));
    winSel.value = String(a?.windowMin ?? 60);
    // indicator
    const ind0 = a?.ind || { type: 'RSI', params: { ...IND_DEFS.RSI.params } };
    let ind = structuredClone(ind0);
    const tfSel = h('select', null, TIMEFRAMES.map(([k, l]) => h('option', { value: k }, l)));
    tfSel.value = a?.tf || this.app.activeView?.cfg.tf || '1h';
    const indSel = h('select', null, IND_CATEGORIES.map(cat => h('optgroup', { label: cat }, Object.entries(IND_DEFS).filter(([k, d]) => d.cat === cat && k !== 'VPVR').map(([k, d]) => h('option', { value: k }, d.name)))));
    indSel.value = ind.type;
    const paramsBox = h('div', { class: 'alert-params' });
    const leftSel = h('select'), rightSel = h('select'), valueIn = h('input', { type: 'number', step: 'any' });
    const indCond = h('select', null, Object.entries(CONDITIONS).map(([k, l]) => h('option', { value: k }, l)));
    indCond.value = a?.kind === 'indicator' ? a.cond : 'up';
    const sideKey = s => (!s ? '' : s.k === 'line' ? `line:${s.i}` : s.k);
    const renderSides = () => {
      const names = outputNames(ind.type), label = indTitle({ type: ind.type, params: ind.params });
      const lineOpts = () => names.map((n, i) => h('option', { value: `line:${i}` }, names.length > 1 ? `${label} · ${n}` : label)); // fresh nodes per select
      const lk = leftSel.value || sideKey(a?.left) || 'line:0', rk = rightSel.value || sideKey(a?.right) || 'value';
      fill(leftSel, lineOpts(), h('option', { value: 'close' }, 'Close price'));
      fill(rightSel, h('option', { value: 'value' }, 'Value'), h('option', { value: 'close' }, 'Close price'), lineOpts());
      leftSel.value = [...leftSel.options].some(o => o.value === lk) ? lk : 'line:0';
      rightSel.value = [...rightSel.options].some(o => o.value === rk) ? rk : 'value';
      valueIn.hidden = rightSel.value !== 'value';
    };
    const renderParams = () => {
      const def = IND_DEFS[ind.type];
      fill(paramsBox, Object.entries(def.params).map(([k, v]) => {
        const cur = ind.params[k] ?? v;
        let el;
        if (def.choices?.[k]) { el = h('select', null, def.choices[k].map(([val, l]) => h('option', { value: val }, l))); el.value = cur; el.addEventListener('change', () => { ind.params[k] = el.value; renderSides(); }); }
        else { el = h('input', { type: 'number', value: cur, step: def.steps?.[k] || 1, min: def.steps?.[k] || 1 }); el.addEventListener('change', () => { const x = parseFloat(el.value); if (x > 0) ind.params[k] = def.steps?.[k] ? x : Math.round(x); else el.value = ind.params[k] ?? v; renderSides(); }); }
        return h('label', { class: 'field' }, h('span', null, k), el);
      }));
      renderSides();
    };
    indSel.addEventListener('change', () => {
      ind = { type: indSel.value, params: { ...IND_DEFS[indSel.value].params } };
      leftSel.value = ''; rightSel.value = '';
      renderParams();
      const guides = { RSI: 70, STOCH: 80, STOCHRSI: 80, MFI: 80, CCI: 100, WILLR: -20, ADX: 25, ROC: 0, MOM: 0, AO: 0, CMF: 0 };
      if (guides[ind.type] != null) valueIn.value = guides[ind.type];
    });
    rightSel.addEventListener('change', () => { valueIn.hidden = rightSel.value !== 'value'; });
    valueIn.value = a?.right?.k === 'value' ? a.right.v : { RSI: 70 }[ind.type] ?? '';
    // common
    const repeat = h('select');
    const msg = h('input', { type: 'text', placeholder: 'Optional note shown with the alert', value: a?.message || '' });
    const sound = h('input', { type: 'checkbox' });
    sound.checked = a ? a.sound !== false : true;
    const hook = h('input', { type: 'checkbox' });
    hook.checked = a ? !!a.webhook : !!this.settings.webhookUrl;
    const now = h('div', { class: 'muted small' });
    let touched = !!a || price != null;
    const refresh = () => {
      const s = symSel.value.startsWith('wl:') ? null : symSel.value;
      const last = s ? this.lastPrice(s) : null, p = s ? precisionOf(s) : 2;
      if (s && !touched) priceIn.value = last != null ? last.toFixed(p) : '';
      priceIn.step = String(Math.pow(10, -p));
      const src = s ? spec(s)?.provider : null;
      fill(now, s ? (last != null ? `Current price ${fmtPrice(last, p)} · ${providerLabel(src)}` : `No current price for ${s} yet · ${providerLabel(src)}`) : 'One alert per symbol in the list',
        src === 'dukascopy' ? h('div', { class: 'down' }, 'Dukascopy data is historical — this alert can\'t fire unless the symbol has a live source (Data → source).') : null,
        mode === 'indicator' && src === 'twelvedata' && ['1m', '3m', '5m'].includes(tfSel.value) ? h('div', { class: 'down' }, 'Twelve Data: checking each candle close costs 1 API credit (5m ≈ 288/day of your 800) — 15m or slower is kinder to the plan.') : null);
    };
    priceIn.value = a?.price != null ? String(a.price) : price != null ? Number(price).toFixed(precisionOf(sym0)) : '';
    priceIn.addEventListener('input', () => { touched = true; });
    symSel.addEventListener('change', () => { touched = false; refresh(); });
    tfSel.addEventListener('change', refresh);

    const close = () => { modal.hidden = true; };
    const submit = () => {
      const base = { repeat: repeat.value === 'every', message: msg.value.trim(), sound: sound.checked, webhook: hook.checked };
      let fields;
      if (mode === 'price') {
        const pv = parseFloat(priceIn.value);
        if (!Number.isFinite(pv)) { toast('Enter a price for the alert', 'error'); priceIn.focus(); return; }
        fields = { kind: 'price', cond: cond.value, price: pv };
      } else if (mode === 'change') {
        const pct = parseFloat(pctIn.value);
        if (!(pct > 0)) { toast('Enter the % move', 'error'); pctIn.focus(); return; }
        fields = { kind: 'change', cond: chCond.value, pct, windowMin: Number(winSel.value) };
      } else if (mode === 'indicator') {
        const side = v => (v === 'close' ? { k: 'close' } : v === 'value' ? { k: 'value', v: parseFloat(valueIn.value) } : { k: 'line', i: Number(v.split(':')[1]) });
        const left = side(leftSel.value), right = side(rightSel.value);
        if (right.k === 'value' && !Number.isFinite(right.v)) { toast('Enter the value to compare with', 'error'); valueIn.focus(); return; }
        fields = { kind: 'indicator', cond: indCond.value, tf: tfSel.value, tfLabel: tfLabel(tfSel.value), ind: structuredClone(ind), indLabel: indTitle({ type: ind.type, params: ind.params }), left, right };
      } else fields = { kind: 'drawing', cond: cond.value };
      const targets = symSel.value.startsWith('wl:') ? (lists[symSel.value.slice(3)] || []).filter(s => spec(s)) : [symSel.value];
      if (a) this.update(a.id, { ...base, ...fields, symbol: targets[0], active: true, rearm: true });
      else for (const s of targets) this.add({ ...base, ...fields, symbol: s, ...(targets.length > 1 ? { batch: symSel.value.slice(3) } : {}) });
      close();
      toast(targets.length > 1 ? `🔔 ${targets.length} alerts set (one per symbol in “${symSel.value.slice(3)}”)` : `🔔 Alert ${a ? 'saved' : 'set'}: ${this.textOf({ ...base, ...fields, symbol: targets[0], drawingLabel: a?.drawingLabel })}`);
    };
    const row = (label, el) => h('label', { class: 'field wide' }, h('span', null, label), el);
    const tabs = h('div', { class: 'subtabs alert-kinds' });
    const fields = h('div');
    const renderMode = () => {
      fillSymbols();
      fill(tabs, ...[['price', 'Price'], ['change', '% move'], ['indicator', 'Indicator'], ...(mode === 'drawing' ? [['drawing', 'Drawing']] : [])].map(([k, l]) =>
        h('button', { class: mode === k ? 'active' : '', disabled: !!a && a.kind !== k, onclick: () => { mode = k; renderMode(); } }, l)));
      fill(repeat, h('option', { value: 'once' }, 'Only once'), h('option', { value: 'every' }, mode === 'indicator' ? 'Every bar close the condition is met' : 'Every time (at most once a minute)'));
      repeat.value = a?.repeat ? 'every' : 'once';
      const specific = mode === 'price' ? [row('Condition', cond), row('Price', priceIn), now]
        : mode === 'change' ? [row('Direction', chCond), row('Move (%)', pctIn), row('Time window', winSel), now,
          h('p', { class: 'muted small' }, 'Fires when price has moved this much from the lowest (up) or highest (down) price seen within the window since the alert was set.')]
          : mode === 'indicator' ? [row('Timeframe', tfSel), row('Indicator', indSel), paramsBox, row('When', leftSel), row('Condition', indCond), row('Compared with', h('span', { class: 'cmp' }, rightSel, valueIn)), now,
            h('p', { class: 'muted small' }, 'Checked on each closed candle of the timeframe, like TradingView\'s “once per bar close”.')]
            : [h('p', null, `Price ${cond.value === 'up' ? 'crossing up' : cond.value === 'down' ? 'crossing down' : 'crossing'} ${a?.drawingLabel || 'the line'} — the line moves with the drawing.`), row('Condition', cond)];
      if (mode === 'drawing') fill(cond, ['cross', 'up', 'down'].map(k => h('option', { value: k }, CONDITIONS[k])));
      else if (cond.options.length < 5) fill(cond, Object.entries(CONDITIONS).map(([k, l]) => h('option', { value: k }, l)));
      cond.value = a?.cond && CONDITIONS[a.cond] ? a.cond : 'cross';
      fill(fields, h('div', { class: 'form-grid alert-form' },
        mode === 'drawing' ? null : row('Symbol', symSel), ...specific, row('Trigger', repeat), row('Message', msg),
        h('label', { class: 'cs-check alert-sound' }, sound, h('span', null, 'Play a sound')),
        h('label', { class: 'cs-check alert-sound', title: this.settings.webhookUrl ? this.settings.webhookUrl : 'Set a webhook in the Alerts panel first' }, hook,
          h('span', null, this.settings.webhookUrl ? 'Send to webhook (phone / Discord / Telegram)' : 'Send to webhook — set one up under Alerts → Webhook'))));
      refresh();
    };
    renderParams();
    renderMode();
    fill(body, tabs, fields, h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: submit }, a ? 'Save' : 'Create')));
    body.onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); submit(); } };
    document.getElementById('alertTitle').textContent = a ? 'Edit alert' : 'Create alert';
    openModal(modal);
    if (mode === 'price') setTimeout(() => { priceIn.focus(); priceIn.select(); }, 0);
  }
}
