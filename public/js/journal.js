// Trading journal: every closed replay trade is recorded automatically with entry/exit chart screenshots,
// P&L, R-multiple, planned R:R, MFE/MAE, and your notes and tags.

import { h, icon, kv, api, toast, fmtUsd, fmtPrice, fmtDateTime, fmtDuration, confirmBox, openModal, $ } from './util.js';
import { tfLabel, precisionOf } from './data.js';

export class Journal {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.entries = [];
    this.pendingShots = {};
    this.filter = { session: '', symbol: '', q: '' };
  }

  async init() {
    this.entries = (await kv.get('journal', [])) || [];
    this.pendingShots = (await kv.get('journal-shots', {})) || {};
    this.render();
  }
  save() { kv.set('journal', this.entries); kv.set('journal-shots', this.pendingShots); }

  async capture(symbol) {
    const view = this.app.viewFor(symbol);
    if (!view) return null;
    try {
      const canvas = view.screenshot();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const res = await fetch('/api/shots', { method: 'POST', body: blob });
      if (!res.ok) throw new Error((await res.json()).error);
      return (await res.json()).url;
    } catch (e) {
      console.warn('screenshot failed', e);
      return null;
    }
  }

  async onFill(replay, position) {
    const key = `${replay.session.id}:${position.id}`;
    if (this.pendingShots[key]) return;
    this.pendingShots[key] = await this.capture(replay.symbol);
    this.save();
  }

  async onClose(replay, trade) {
    const key = `${replay.session.id}:${trade.positionId}`;
    const exitShot = await this.capture(replay.symbol);
    const stillOpen = replay.broker.s.positions.some(p => p.id === trade.positionId);
    const entry = {
      ...trade, tradeId: trade.id,
      id: `${replay.session.id}:${trade.id}`, sessionId: replay.session.id, sessionName: replay.session.name,
      symbol: replay.symbol, tf: this.app.viewFor(replay.symbol)?.cfg.tf,
      shots: { entry: this.pendingShots[key] || null, exit: exitShot },
      notes: '', tags: [], created: Date.now(),
    };
    if (!stillOpen) delete this.pendingShots[key];
    this.entries.push(entry);
    this.save();
    this.render();
  }

  async removeTrades(sessionId, tradeIds) {
    const ids = new Set(tradeIds.map(id => `${sessionId}:${id}`));
    const gone = this.entries.filter(e => ids.has(e.id));
    this.entries = this.entries.filter(e => !ids.has(e.id));
    await this.deleteShots(gone);
    this.save();
    this.render();
  }
  async removeSession(sessionId) {
    const gone = this.entries.filter(e => e.sessionId === sessionId);
    this.entries = this.entries.filter(e => e.sessionId !== sessionId);
    for (const k of Object.keys(this.pendingShots)) if (k.startsWith(`${sessionId}:`)) delete this.pendingShots[k];
    await this.deleteShots(gone);
    this.save();
    this.render();
  }
  async deleteShots(entries) {
    const stillUsed = new Set(this.entries.flatMap(e => [e.shots?.entry, e.shots?.exit]));
    for (const e of entries) for (const url of [e.shots?.entry, e.shots?.exit]) {
      if (url && !stillUsed.has(url)) await api(`/api/shots?url=${encodeURIComponent(url)}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  filtered() {
    const { session, symbol, q } = this.filter;
    const needle = q.trim().toLowerCase();
    return this.entries.filter(e => (!session || e.sessionId === session) && (!symbol || e.symbol === symbol) &&
      (!needle || `${e.notes} ${(e.tags || []).join(' ')} ${e.reason} ${e.sessionName}`.toLowerCase().includes(needle)));
  }

  stats(list) {
    const wins = list.filter(e => e.pnl > 0), losses = list.filter(e => e.pnl <= 0);
    const gp = wins.reduce((a, e) => a + e.pnl, 0), gl = -losses.reduce((a, e) => a + e.pnl, 0);
    const rs = list.filter(e => e.r != null).map(e => e.r);
    return {
      n: list.length, net: gp - gl, winRate: list.length ? wins.length / list.length : 0,
      pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      best: list.length ? Math.max(...list.map(e => e.pnl)) : 0, worst: list.length ? Math.min(...list.map(e => e.pnl)) : 0,
    };
  }

  render() {
    if (!this.host) return;
    const sessions = [...new Map(this.entries.map(e => [e.sessionId, e.sessionName])).entries()];
    const symbols = [...new Set(this.entries.map(e => e.symbol))];
    const sel = (key, opts, all) => {
      const s = h('select', { onchange: () => { this.filter[key] = s.value; this.render(); } }, h('option', { value: '' }, all), opts.map(([v, l]) => h('option', { value: v, selected: this.filter[key] === v }, l)));
      return s;
    };
    const search = h('input', { type: 'search', placeholder: 'Search notes, tags…', value: this.filter.q });
    search.addEventListener('input', () => { this.filter.q = search.value; clearTimeout(this.qt); this.qt = setTimeout(() => this.renderBody(), 200); });
    this.body = h('div', { class: 'journal-body' });
    this.host.replaceChildren(h('div', { class: 'journal' },
      h('div', { class: 'jr-toolbar' }, sel('session', sessions, 'All sessions'), sel('symbol', symbols.map(s => [s, s]), 'All symbols'), search,
        h('div', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => this.exportCsv() }, icon('download'), 'Export CSV')),
      this.body));
    this.renderBody();
  }

  renderBody() {
    const list = this.filtered().slice().sort((a, b) => b.exitTime - a.exitTime);
    const st = this.stats(list);
    const stat = (k, v, cls = '') => h('div', { class: 'jr-stat' }, h('span', null, k), h('b', { class: cls }, v));
    const strip = h('div', { class: 'jr-stats' },
      stat('Trades', st.n), stat('Win rate', `${(st.winRate * 100).toFixed(1)}%`), stat('Net P&L', fmtUsd(st.net, true), st.net >= 0 ? 'up' : 'down'),
      stat('Profit factor', Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞'), stat('Avg R', st.avgR != null ? st.avgR.toFixed(2) : '—'),
      stat('Best', fmtUsd(st.best, true), 'up'), stat('Worst', fmtUsd(st.worst, true), 'down'));
    if (!list.length) {
      this.body.replaceChildren(strip, h('div', { class: 'panel-empty small' }, h('p', null, this.entries.length ? 'No trades match the filter.' : 'Closed replay trades appear here automatically, with screenshots at entry and exit.')));
      return;
    }
    const rows = list.map(e => {
      const p = precisionOf(e.symbol);
      return h('tr', { class: 'clickable', onclick: () => this.openEntry(e.id) },
        h('td', { class: 'muted' }, fmtDateTime(e.exitTime)), h('td', null, e.symbol), h('td', { class: e.side === 'buy' ? 'buy' : 'sell' }, e.side.toUpperCase()),
        h('td', null, +e.lots.toFixed(4)), h('td', null, fmtPrice(e.entry, p)), h('td', null, fmtPrice(e.exit, p)),
        h('td', null, e.sl != null ? fmtPrice(e.sl, p) : '—'), h('td', null, e.tp != null ? fmtPrice(e.tp, p) : '—'),
        h('td', null, e.reason), h('td', null, e.plannedRR != null ? `1:${e.plannedRR.toFixed(2)}` : '—'), h('td', null, e.r != null ? e.r.toFixed(2) + 'R' : '—'),
        h('td', { class: e.pnl >= 0 ? 'up' : 'down' }, fmtUsd(e.pnl, true)),
        h('td', { class: 'muted ellipsis' }, [(e.tags || []).map(t => h('span', { class: 'tag' }, t)), e.notes]),
        h('td', null, e.shots?.entry || e.shots?.exit ? icon('camera') : ''));
    });
    this.body.replaceChildren(strip, h('div', { class: 'tp-table' }, h('table', null,
      h('thead', null, h('tr', null, ['Closed (UTC)', 'Symbol', 'Side', 'Lots', 'Entry', 'Exit', 'SL', 'TP', 'Exit reason', 'Planned R:R', 'Result', 'P&L', 'Notes', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows))));
  }

  openEntry(id) {
    const e = this.entries.find(x => x.id === id);
    if (!e) return;
    const p = precisionOf(e.symbol);
    const notes = h('textarea', { rows: 6, placeholder: 'What was the setup? Why did you enter/exit? What would you do differently?' });
    notes.value = e.notes || '';
    notes.addEventListener('input', () => { e.notes = notes.value; this.save(); });
    const tags = h('input', { type: 'text', value: (e.tags || []).join(', '), placeholder: 'tags, comma separated (e.g. breakout, london, A+)' });
    tags.addEventListener('change', () => { e.tags = tags.value.split(',').map(s => s.trim()).filter(Boolean); this.save(); this.renderBody(); });
    const shot = (label, url) => h('figure', null, h('figcaption', null, label),
      url ? h('a', { href: url, target: '_blank', title: 'Open full size' }, h('img', { src: url, alt: `${label} screenshot` })) : h('div', { class: 'noshot' }, 'No screenshot'));
    const kvRow = (k, v, cls = '') => h('div', null, h('span', null, k), h('b', { class: cls }, v));
    $('#journalTitle').textContent = `${e.side === 'buy' ? 'Long' : 'Short'} ${e.symbol} · ${fmtDateTime(e.entryTime)} UTC`;
    $('#journalBody').replaceChildren(
      h('div', { class: 'jr-detail' },
        h('div', { class: 'jr-facts' },
          kvRow('Session', e.sessionName), kvRow('Timeframe', tfLabel(e.tf || '1h')), kvRow('Size', `${+e.lots.toFixed(4)} lots`),
          kvRow('Entry', `${fmtPrice(e.entry, p)} · ${fmtDateTime(e.entryTime)}`), kvRow('Exit', `${fmtPrice(e.exit, p)} · ${fmtDateTime(e.exitTime)}`),
          kvRow('Duration', fmtDuration(e.exitTime - e.entryTime)), kvRow('Stop-loss', e.sl != null ? fmtPrice(e.sl, p) : 'none'), kvRow('Take-profit', e.tp != null ? fmtPrice(e.tp, p) : 'none'),
          kvRow('Planned R:R', e.plannedRR != null ? `1 : ${e.plannedRR.toFixed(2)}` : '—'), kvRow('Result', e.r != null ? `${e.r.toFixed(2)} R` : '—', e.pnl >= 0 ? 'up' : 'down'),
          kvRow('Gross', fmtUsd(e.gross, true)), kvRow('Costs', fmtUsd(-e.commission)), kvRow('Net P&L', fmtUsd(e.pnl, true), e.pnl >= 0 ? 'up' : 'down'),
          kvRow('Exit reason', e.reason), kvRow('Max favourable', fmtPrice(e.mfe, p)), kvRow('Max adverse', fmtPrice(e.mae, p))),
        h('div', { class: 'jr-shots' }, shot('Entry', e.shots?.entry), shot('Exit', e.shots?.exit)),
        h('label', { class: 'field wide' }, h('span', null, 'Tags'), tags),
        h('label', { class: 'field wide' }, h('span', null, 'Notes'), notes),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmBox('Delete this journal entry? (The trade stays in the session history.)', 'Delete'))) return;
            this.entries = this.entries.filter(x => x.id !== e.id);
            await this.deleteShots([e]);
            this.save(); this.render(); $('#journalModal').hidden = true;
          } }, icon('trash'), 'Delete entry'),
          h('button', { class: 'btn primary', 'data-close': '' }, 'Done'))));
    openModal($('#journalModal'));
  }

  exportCsv() {
    const list = this.filtered();
    if (!list.length) { toast('Nothing to export'); return; }
    const cols = ['sessionName', 'symbol', 'tf', 'side', 'lots', 'entryTime', 'entry', 'exitTime', 'exit', 'sl', 'tp', 'reason', 'plannedRR', 'r', 'gross', 'commission', 'pnl', 'mfe', 'mae', 'tags', 'notes'];
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const val = (e, c) => (c.endsWith('Time') ? new Date(e[c] * 1000).toISOString() : c === 'tags' ? (e.tags || []).join('; ') : e[c]);
    const csv = [cols.join(','), ...list.map(e => cols.map(c => esc(val(e, c))).join(','))].join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `chartdesk-journal-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
