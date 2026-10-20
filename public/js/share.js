// Share a chart: a link (#chart=… — compressed chart state: symbol, timeframe, type, indicators, drawings) or a
// .chartdesk.json file (also carries the code of script indicators); open either to load the chart. Also opens a
// chart in a separate browser window (?w=2…) with its own saved layout, for a second monitor.

import { h, toast, uid, confirmBox } from './util.js';
import { spec } from './data.js';
import { getScript, upsertScript, newScriptId } from './scripts.js';

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

export class Share {
  constructor(app) { this.app = app; }

  /** Everything needed to rebuild the active chart elsewhere. */
  stateOf(view = this.app.activeView, withScripts = false) {
    const cfg = view.toJSON();
    const scripts = withScripts ? cfg.indicators.filter(i => i.type === 'SCRIPT').map(i => getScript(i.scriptId)).filter(Boolean).map(sc => ({ id: sc.id, name: sc.name, code: sc.code })) : [];
    return {
      app: 'ChartDesk', v: 1, symbol: cfg.symbol, tf: cfg.tf, chartType: cfg.chartType, typeOpts: cfg.typeOpts, compare: cfg.compare, scaleMode: cfg.scaleMode,
      indicators: cfg.indicators.map(({ id, ...rest }) => rest).filter(i => withScripts || i.type !== 'SCRIPT'),
      drawings: view.drawings.filter(d => !d.hidden).map(({ id, ...rest }) => rest), scripts,
    };
  }
  async copyLink() {
    const state = this.stateOf();
    const url = `${location.origin}${location.pathname}#chart=${b64url(await deflate(JSON.stringify(state)))}`;
    try { await navigator.clipboard.writeText(url); toast(`Chart link copied (${state.drawings.length} drawings, ${state.indicators.length} indicators) — opens in any ChartDesk${this.app.activeView.cfg.indicators.some(i => i.type === 'SCRIPT') ? '; script indicators travel in the file export' : ''}`); }
    catch { this.app.prompt('Copy this link', url, () => {}); }
    return url;
  }
  exportFile() {
    const state = this.stateOf(this.app.activeView, true);
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' })), download: `${state.symbol}_${state.tf}.chartdesk.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Chart saved as a file — send it to anyone with ChartDesk; open it with Ctrl+K → "Open a shared chart file" or drag it onto the app');
  }
  pickFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => { const f = input.files[0]; if (f) this.importText(await f.text(), f.name); });
    input.click();
  }
  async importText(text, name = 'file') {
    let state;
    try { state = JSON.parse(text); } catch { toast(`${name} isn't a ChartDesk chart file`, 'error'); return; }
    if (state?.app !== 'ChartDesk') { toast(`${name} isn't a ChartDesk chart file`, 'error'); return; }
    await this.apply(state);
  }
  /** Load a shared chart into the active view (asks first; drawings are added as a group, not replacing yours). */
  async apply(state, ask = true) {
    if (!spec(state.symbol)) { toast(`This chart is for ${state.symbol}, which isn't available here`, 'error'); return; }
    const ok = !ask || await confirmBox(`Open the shared chart?\n${state.symbol} · ${state.tf} · ${state.indicators.length} indicator(s) · ${state.drawings.length} drawing(s)\n\nIt replaces the active chart's symbol, timeframe and indicators; the drawings are added to ${state.symbol} as the group “Shared”.`, 'Open chart');
    if (!ok) return;
    const view = this.app.activeView;
    // script indicators: reuse a script with the same code, otherwise add it to My scripts
    const idMap = new Map();
    for (const sc of state.scripts || []) {
      const same = getScript(sc.id);
      if (same && same.code === sc.code) { idMap.set(sc.id, sc.id); continue; }
      const id = newScriptId();
      await upsertScript({ id, name: `${sc.name} (shared)`, code: sc.code });
      idMap.set(sc.id, id);
    }
    await view.setSymbol(state.symbol);
    view.cfg.indicators = state.indicators.filter(i => i.type !== 'SCRIPT' || idMap.has(i.scriptId)).map(i => ({ ...i, id: uid(), ...(i.scriptId ? { scriptId: idMap.get(i.scriptId) } : {}) }));
    view.cfg.typeOpts = state.typeOpts || {};
    view.cfg.compare = state.compare || [];
    view.cfg.chartType = state.chartType || 'candles';
    view.cfg.scaleMode = state.scaleMode || 0;
    const list = view.drawings;
    for (const d of state.drawings || []) list.push({ ...structuredClone(d), id: uid(), group: 'Shared' });
    this.app.saveDrawings(state.symbol);
    view.cfg.tf = state.tf;
    this.app.onViewChanged(view);
    await view.load();
    view.rebuildAll();
    toast(`Opened shared chart: ${state.symbol} ${state.tf}`);
  }
  /** #chart=… in the address: load it, then clean the address. */
  async fromLocation() {
    const m = /#chart=([\w-]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    const popout = new URLSearchParams(location.search).has('w'); // a window opened by "new window" loads its chart without asking
    try { await this.apply(JSON.parse(await inflate(unb64url(m[1]))), !popout); } catch (e) { toast(`Couldn't open the chart link: ${e.message}`, 'error'); }
  }
  /** Separate window with its own layout (drag it to another monitor). */
  async popout() {
    const n = (Number(localStorage.getItem('cd-popouts') || 1) % 8) + 1;
    try { localStorage.setItem('cd-popouts', String(n)); } catch { /* private mode */ }
    const state = this.stateOf(this.app.activeView, false);
    const url = `${location.origin}${location.pathname}?w=${n}#chart=${b64url(await deflate(JSON.stringify(state)))}`;
    const win = window.open(url, `chartdesk-${n}`, 'width=1280,height=800');
    if (!win) toast('The browser blocked the new window — allow pop-ups for ChartDesk', 'error');
  }
}
