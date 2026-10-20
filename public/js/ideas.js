// Ideas: save a chart snapshot with a title, a bias and your notes — a private trading-ideas notebook. Each idea
// keeps the chart's state, so "Open chart" brings back the symbol, timeframe, indicators and drawings, and an
// idea can be shared as a chart file or link.

import { h, icon, kv, toast, uid, fill, fmtDateTime, openModal, confirmBox } from './util.js';

export class Ideas {
  constructor(app, host) { this.app = app; this.host = host; this.list = []; }
  async init() { this.list = (await kv.get('ideas', [])) || []; }
  save() { kv.set('ideas', this.list); }

  openNew() {
    const view = this.app.activeView;
    if (!view?.bars.length) { toast('Open a chart first', 'error'); return; }
    const modal = document.getElementById('alertModal'), body = document.getElementById('alertBody');
    const title = h('input', { type: 'text', placeholder: `e.g. ${view.symbol} breakout above the range`, value: '' });
    const bias = h('select', null, h('option', { value: 'long' }, 'Long (bullish)'), h('option', { value: 'short' }, 'Short (bearish)'), h('option', { value: 'neutral' }, 'Neutral / education'));
    const text = h('textarea', { rows: 6, placeholder: 'Your reasoning, levels, invalidation, plan…' });
    const tags = h('input', { type: 'text', placeholder: 'Tags, comma separated (e.g. gold, SMC, breakout)' });
    const row = (l, el) => h('label', { class: 'field wide' }, h('span', null, l), el);
    const submit = async () => {
      if (!title.value.trim()) { toast('Give the idea a title', 'error'); title.focus(); return; }
      modal.hidden = true;
      const shot = await this.app.journal.capture(view.symbol);
      const idea = { id: uid(), title: title.value.trim(), bias: bias.value, text: text.value.trim(), tags: tags.value.split(',').map(t => t.trim()).filter(Boolean),
        symbol: view.symbol, tf: view.cfg.tf, price: view.bars[view.bars.length - 1].close, created: Date.now(), shot, state: this.app.share.stateOf(view, false) };
      this.list.unshift(idea);
      this.save();
      this.app.showPanel('ideas');
      toast('Idea saved');
    };
    fill(body, h('div', { class: 'form-grid alert-form' }, row('Title', title), row('Bias', bias), row('Idea', text), row('Tags', tags),
      h('p', { class: 'muted small' }, `A snapshot of ${view.symbol} ${view.cfg.tf} and the chart's indicators and drawings are saved with it.`)),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', onclick: () => { modal.hidden = true; } }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, 'Save idea')));
    document.getElementById('alertTitle').textContent = 'New idea';
    openModal(modal);
    setTimeout(() => title.focus(), 0);
  }

  render() {
    if (!this.host || this.host.hidden) return;
    const q = (this.q || '').toLowerCase();
    const list = this.list.filter(i => !q || `${i.title} ${i.text} ${i.symbol} ${(i.tags || []).join(' ')}`.toLowerCase().includes(q));
    const search = h('input', { type: 'search', placeholder: 'Search ideas', value: this.q || '', oninput: e => { this.q = e.target.value; clearTimeout(this.t); this.t = setTimeout(() => { this.render(); this.host.querySelector('input[type=search]')?.focus(); }, 150); } });
    fill(this.host, h('div', { class: 'ideas' },
      h('div', { class: 'sc-bar' }, h('button', { class: 'btn small primary', onclick: () => this.openNew() }, icon('plus'), 'New idea from this chart'), search,
        h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${this.list.length} idea${this.list.length === 1 ? '' : 's'} · private to this computer — share one as a chart file or link`)),
      list.length ? h('div', { class: 'idea-grid' }, list.map(i => h('div', { class: 'idea-card' },
        i.shot ? h('img', { src: i.shot, alt: i.title, loading: 'lazy', onclick: () => window.open(i.shot, '_blank') }) : h('div', { class: 'noshot' }, 'No snapshot'),
        h('div', { class: 'idea-meta' }, h('span', { class: `tag bias-${i.bias}` }, i.bias), h('b', null, `${i.symbol} · ${i.tf}`), h('span', { class: 'muted small' }, fmtDateTime(i.created / 1000))),
        h('div', { class: 'idea-title' }, i.title),
        i.text ? h('p', { class: 'idea-text' }, i.text) : null,
        i.tags?.length ? h('div', { class: 'idea-tags' }, i.tags.map(t => h('span', { class: 'chip' }, `#${t}`))) : null,
        h('div', { class: 'idea-actions' },
          h('button', { class: 'btn small', title: 'Open this chart again', onclick: () => this.app.share.apply(i.state) }, icon('candles'), 'Open chart'),
          h('button', { class: 'btn small', title: 'Download as a chart file to share', onclick: () => this.exportIdea(i) }, icon('download')),
          h('button', { class: 'btn small', title: 'Delete', onclick: async () => { if (await confirmBox(`Delete the idea “${i.title}”?`, 'Delete')) { this.list = this.list.filter(x => x !== i); this.save(); this.render(); } } }, icon('trash'))))))
        : h('div', { class: 'panel-empty small' }, h('h3', null, 'Trading ideas'), h('p', null, 'Save a snapshot of your analysis with a title, bias and notes. Ideas keep the chart, so you can reopen it later and review how it played out.'))));
  }
  exportIdea(i) {
    const state = { ...i.state, idea: { title: i.title, bias: i.bias, text: i.text, tags: i.tags, created: i.created } };
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' })), download: `${i.symbol}_idea_${new Date(i.created).toISOString().slice(0, 10)}.chartdesk.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
