// DOM, formatting and persistence helpers shared by the UI modules.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

/** replaceChildren that skips null/false placeholders (the DOM API would render them as text). */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
export const UP = '#089981', DOWN = '#f23645', ACCENT = '#2962ff';
export const PALETTE = ['#2962ff', '#ff9800', '#e91e63', '#00bcd4', '#ab47bc', '#4caf50', '#fdd835'];

export const ICONS = {
  search: '<circle cx="12.5" cy="12.5" r="6"/><path d="M17 17l5.5 5.5"/>',
  cross: '<path d="M14 4v8M14 16v8M4 14h8M16 14h8"/>',
  trend: '<path d="M7.5 20.5L20.5 7.5"/><circle cx="6" cy="22" r="2"/><circle cx="22" cy="6" r="2"/>',
  ray: '<path d="M7.7 19L25 8"/><circle cx="6" cy="20" r="2"/>',
  hline: '<path d="M3 14h9M16 14h9"/><circle cx="14" cy="14" r="2"/>',
  vline: '<path d="M14 3v9M14 16v9"/><circle cx="14" cy="14" r="2"/>',
  rect: '<rect x="6" y="8" width="16" height="12" rx="1"/><circle cx="6" cy="8" r="1.6"/><circle cx="22" cy="20" r="1.6"/>',
  fib: '<path d="M4 6h20M4 11h20M4 16h20M4 22h20"/><path d="M6 22L22 6" stroke-dasharray="2 2"/>',
  long: '<rect x="5" y="5" width="18" height="9" fill="currentColor" fill-opacity=".25"/><rect x="5" y="14" width="18" height="6" fill="#f23645" fill-opacity=".35" stroke="none"/><path d="M5 14h18"/><path d="M14 11V7M12 9l2-2 2 2"/>',
  short: '<rect x="5" y="14" width="18" height="9" fill="currentColor" fill-opacity=".25"/><rect x="5" y="8" width="18" height="6" fill="#f23645" fill-opacity=".35" stroke="none"/><path d="M5 14h18"/><path d="M14 17v4M12 19l2 2 2-2"/>',
  text: '<path d="M7 7h14M14 7v15M11 22h6"/>',
  ruler: '<path d="M4.5 18.5l14-14 5 5-14 14z"/><path d="M9 14l2 2M12 11l2 2M15 8l2 2"/>',
  brush: '<path d="M21.5 4.5c1 1-6 9.5-8 11.5l-2-2c2-2 9-10.5 10-9.5z"/><path d="M11.5 14c-2 0-3.5 1.5-3.5 3.5 0 1.3-.7 2.3-2.5 2.5 3.8 1.6 8 .5 8-3.5z"/>',
  eraser: '<path d="M16.5 5.5l6 6-9.5 9.5H8L5 18z"/><path d="M11 10.5l6 6M13 21h10"/>',
  eye: '<path d="M3 14s4-7 11-7 11 7 11 7-4 7-11 7S3 14 3 14z"/><circle cx="14" cy="14" r="3"/>',
  eyeOff: '<path d="M3 14s4-7 11-7 11 7 11 7-4 7-11 7S3 14 3 14z"/><path d="M5 23L23 5"/>',
  trash: '<path d="M6 9h16M11 9V6h6v3M8.5 9l1 14h9l1-14M12.5 13v6M15.5 13v6"/>',
  candles: '<path d="M9 4v20M19 4v20"/><rect x="6.5" y="9" width="5" height="9" fill="currentColor"/><rect x="16.5" y="7" width="5" height="11"/>',
  hollow: '<path d="M9 4v5M9 18v6M19 4v3M19 18v6"/><rect x="6.5" y="9" width="5" height="9"/><rect x="16.5" y="7" width="5" height="11"/>',
  bars: '<path d="M9 5v18M6 9h3M9 19h3M19 5v18M16 16h3M19 8h3"/>',
  line: '<path d="M4 20l6-7 4 4 10-11"/>',
  area: '<path d="M4 20l6-7 4 4 10-11v18H4z" fill="currentColor" fill-opacity=".2"/><path d="M4 20l6-7 4 4 10-11"/>',
  baseline: '<path d="M4 14h20" stroke-dasharray="2 2"/><path d="M4 18l5-8 5 6 4-9 6 10"/>',
  fx: '<path d="M8 21c2 0 2-2 3-7s1-8 4-8M8 12h7M16 14l6 6M22 14l-6 6"/>',
  moon: '<path d="M20.5 17.5A8 8 0 0 1 10.5 7.5a8 8 0 1 0 10 10z"/>',
  sun: '<circle cx="14" cy="14" r="4"/><path d="M14 4v2M14 22v2M4 14h2M22 14h2M6.9 6.9l1.4 1.4M19.7 19.7l1.4 1.4M6.9 21.1l1.4-1.4M19.7 8.3l1.4-1.4"/>',
  fullscreen: '<path d="M5 10V5h5M18 5h5v5M23 18v5h-5M10 23H5v-5"/>',
  camera: '<path d="M5 9h4l2-3h6l2 3h4v13H5z"/><circle cx="14" cy="15" r="4"/>',
  list: '<path d="M6 8h16M6 14h16M6 20h16"/>',
  plus: '<path d="M14 7v14M7 14h14"/>',
  close: '<path d="M8 8l12 12M20 8L8 20"/>',
  gear: '<circle cx="14" cy="14" r="3"/><path d="M14 5v3M14 20v3M5 14h3M20 14h3M7.6 7.6l2.1 2.1M18.3 18.3l2.1 2.1M7.6 20.4l2.1-2.1M18.3 9.7l2.1-2.1"/>',
  replay: '<path d="M6 14a8 8 0 1 0 2.4-5.7"/><path d="M6 5v4h4"/><path d="M12 10.5v7l5.5-3.5z" fill="currentColor"/>',
  play: '<path d="M10 7v14l11-7z" fill="currentColor"/>',
  pause: '<path d="M9 7h3v14H9zM16 7h3v14h-3z" fill="currentColor"/>',
  stepFwd: '<path d="M8 7v14l9-7z" fill="currentColor"/><path d="M20 7v14"/>',
  stepBack: '<path d="M20 7v14l-9-7z" fill="currentColor"/><path d="M8 7v14"/>',
  scissors: '<circle cx="8" cy="20" r="2.5"/><circle cx="20" cy="20" r="2.5"/><path d="M9.5 18L19 6M18.5 18L9 6"/>',
  calendar: '<rect x="5" y="7" width="18" height="16" rx="2"/><path d="M5 12h18M10 4v5M18 4v5"/>',
  layout1: '<rect x="5" y="6" width="18" height="16" rx="1"/>',
  layout2v: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M14 6v16"/>',
  layout2h: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M5 14h18"/>',
  layout3: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M14 6v16M14 14h9"/>',
  layout4: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M14 6v16M5 14h18"/>',
  database: '<ellipse cx="14" cy="8" rx="8" ry="3"/><path d="M6 8v12c0 1.7 3.6 3 8 3s8-1.3 8-3V8M6 14c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chevronDown: '<path d="M9 12l5 5 5-5"/>',
  chevronUp: '<path d="M9 16l5-5 5 5"/>',
  edit: '<path d="M6 22l1-5L18 6l4 4-11 11z"/><path d="M15.5 8.5l4 4"/>',
  send: '<path d="M5 14l17-8-6 17-3-7z"/>',
  save: '<path d="M6 5h13l3 3v15H6z"/><path d="M10 5v6h8V5M10 23v-7h8v7"/>',
  folder: '<path d="M4 8h7l2 2h11v12H4z"/>',
  download: '<path d="M14 5v12M9 12l5 5 5-5M6 22h16"/>',
  upload: '<path d="M14 18V6M9 11l5-5 5 5M6 22h16"/>',
  sparkle: '<path d="M14 4l2.2 6.3L22.5 12.5l-6.3 2.2L14 21l-2.2-6.3L5.5 12.5l6.3-2.2z"/><path d="M21.5 4.5v3M20 6h3"/>',
  bell: '<path d="M8 19V13a6 6 0 0 1 12 0v6l2 2H6z"/><path d="M12 23a2 2 0 0 0 4 0"/>',
  columns: '<path d="M6.5 22v-8M11 22V9M15.5 22v-6M20 22V6"/>',
  highlow: '<path d="M8 6v15M14 9v10M20 5v12"/><path d="M6.5 6h3M6.5 21h3M12.5 9h3M12.5 19h3M18.5 5h3M18.5 17h3"/>',
  linemarkers: '<path d="M4 20l6-7 4 4 10-11"/><circle cx="4" cy="20" r="1.8"/><circle cx="10" cy="13" r="1.8"/><circle cx="14" cy="17" r="1.8"/><circle cx="24" cy="6" r="1.8"/>',
  step: '<path d="M4 20h5v-6h5v4h5V8h5"/>',
  renko: '<rect x="4" y="16" width="5" height="5"/><rect x="9" y="11" width="5" height="5"/><rect x="14" y="6" width="5" height="5"/><rect x="19" y="11" width="5" height="5" fill="currentColor"/>',
  linebreak: '<rect x="4" y="15" width="5" height="7"/><rect x="9" y="9" width="5" height="6"/><rect x="14" y="4" width="5" height="5"/><rect x="19" y="9" width="5" height="11" fill="currentColor"/>',
  kagi: '<path d="M5 22V12h6v6h5V5h6v13"/>',
  pnf: '<path d="M4.5 6.5l4 4M8.5 6.5l-4 4M4.5 13l4 4M8.5 13l-4 4"/><circle cx="14.5" cy="11" r="2.2"/><circle cx="14.5" cy="17.5" r="2.2"/><path d="M19.5 15l4 4M23.5 15l-4 4"/>',
  rangebars: '<path d="M7 5v9M5 8h2M7 12h2M14 9v9M12 12h2M14 16h2M21 13v9M19 16h2M21 20h2"/>',
  compare: '<circle cx="14" cy="14" r="8"/><path d="M14 10v8M10 14h8"/>',
  check: '<path d="M7 14.5l4.5 4.5L21 9.5"/>',
  link: '<path d="M12 16l4-4M10.5 13.5l-2 2a3 3 0 0 0 4.2 4.2l2-2M17.5 14.5l2-2a3 3 0 0 0-4.2-4.2l-2 2"/>',
  extline: '<path d="M3 23L25 5"/><circle cx="9.5" cy="17.7" r="2"/><circle cx="18.5" cy="10.3" r="2"/>',
  infoline: '<path d="M5 21L17 10"/><circle cx="5" cy="21" r="1.8"/><circle cx="17" cy="10" r="1.8"/><rect x="15" y="15" width="9" height="7" rx="1.2"/>',
  arrow: '<path d="M6 22L21 7M13.5 7H21v7.5"/>',
  hray: '<circle cx="6" cy="14" r="2"/><path d="M8 14h17"/>',
  crossline: '<path d="M14 4v20M4 14h20"/><circle cx="14" cy="14" r="2.2"/>',
  channel: '<path d="M4 17L20 6M8 23L24 12"/><circle cx="4" cy="17" r="1.6"/><circle cx="20" cy="6" r="1.6"/><circle cx="16" cy="17.5" r="1.6"/>',
  regression: '<path d="M4 19L24 9"/><path d="M4 14L24 4M4 24L24 14" stroke-dasharray="2 2"/>',
  pitchfork: '<circle cx="4.5" cy="15" r="1.8"/><path d="M6.3 15H24M13 8v14M13 8h11M13 22h11"/>',
  schiff: '<circle cx="5" cy="10" r="1.8"/><path d="M6.6 10.8L13 15h11M13 8v14M13 8h11M13 22h11"/>',
  fibext: '<path d="M4 6h20M4 12h20M4 18h20M4 24h20"/><path d="M6 22l5-12 5 7" stroke-dasharray="2 2"/>',
  fibtime: '<path d="M5 4v20M8 4v20M11 4v20M16 4v20M23 4v20"/>',
  fibfan: '<path d="M4 24L24 4M4 24L24 10M4 24L24 16M4 24L24 21"/>',
  fibcircle: '<circle cx="14" cy="14" r="3"/><circle cx="14" cy="14" r="6.5"/><circle cx="14" cy="14" r="10"/>',
  gannbox: '<rect x="4" y="5" width="20" height="18"/><path d="M4 23L24 5M9 5v18M14 5v18M19 5v18" stroke-dasharray="2 2"/>',
  gannfan: '<path d="M4 24L24 4M4 24L24 12M4 24L16 4M4 24L24 19M4 24L9 4"/>',
  xabcd: '<path d="M3 20l5-12 5 8 5-11 6 14"/><path d="M3 20l10-4M13 16l11 3" stroke-dasharray="2 2"/>',
  abcd: '<path d="M4 21l7-14 6 8 7-10"/><path d="M4 21l13-6" stroke-dasharray="2 2"/>',
  tripattern: '<path d="M3 7l5 14 6-10 5 7 6-5"/><path d="M3 7l22 9M8 21l17-6" stroke-dasharray="2 2"/>',
  hs: '<path d="M2 22l4-8 3 4 5-12 5 12 3-4 4 8"/><path d="M5 18h18" stroke-dasharray="2 2"/>',
  elliott5: '<path d="M3 23l5-9 3 4 6-12 3 5 5-7"/>',
  elliott3: '<path d="M4 6l7 12 5-6 8 11"/>',
  pricerange: '<path d="M6 6h16M6 22h16M14 7v14M11 18l3 3 3-3"/>',
  daterange: '<path d="M6 6v16M22 6v16M7 14h14M18 11l3 3-3 3"/>',
  dprange: '<rect x="5" y="6" width="18" height="16"/><path d="M14 8v12M8 14h12"/>',
  avwap: '<path d="M4 20c5 0 6-9 11-9s5 5 9 5"/><circle cx="5" cy="20" r="2"/>',
  highlighter: '<path d="M9 18l8-12 5 4-8 12z"/><path d="M9 18l-3 5h7"/>',
  ellipse: '<ellipse cx="14" cy="14" rx="10" ry="7"/>',
  circle: '<circle cx="14" cy="14" r="9"/><circle cx="14" cy="14" r="1.2"/>',
  triangle: '<path d="M14 5l10 17H4z"/>',
  path: '<path d="M4 20l6-8 6 6 6-10"/><path d="M18.5 8.5L22 8l.5 3.5"/>',
  note: '<path d="M6 5h16v13l-5 5H6z"/><path d="M17 23v-5h5M10 10h8M10 14h6"/>',
  callout: '<path d="M5 6h18v11H13l-5 5v-5H5z"/>',
  pricelabel: '<path d="M4 14l5-6h15v12H9z"/><circle cx="9.5" cy="14" r="1.2"/>',
  flag: '<path d="M8 4v20M8 5h12l-3 4 3 4H8"/>',
  arrowup: '<path d="M14 5l7 9h-4v9h-6v-9H7z"/>',
  arrowdown: '<path d="M14 23l7-9h-4V5h-6v9H7z"/>',
  smile: '<circle cx="14" cy="14" r="9"/><path d="M10 16c1.5 2 6.5 2 8 0"/><circle cx="11" cy="11.5" r=".9"/><circle cx="17" cy="11.5" r=".9"/>',
  magnet: '<path d="M7 5v9a7 7 0 0 0 14 0V5h-4v9a3 3 0 0 1-6 0V5z"/><path d="M7 9h4M17 9h4"/>',
  lock: '<rect x="7" y="12" width="14" height="11" rx="2"/><path d="M10 12V9a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="7" y="12" width="14" height="11" rx="2"/><path d="M10 12V9a4 4 0 0 1 7.6-1.8"/>',
  tree: '<path d="M6 5v14M6 7h6M6 13h6M6 19h6"/><rect x="13" y="5" width="10" height="4" rx="1"/><rect x="13" y="11" width="10" height="4" rx="1"/><rect x="13" y="17" width="10" height="4" rx="1"/>',
  copy: '<rect x="10" y="10" width="12" height="12" rx="2"/><path d="M7 18V7h11"/>',
  undo: '<path d="M9 9H5V5"/><path d="M5.5 9A9 9 0 1 1 7.5 20"/>',
  layout3v: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M11 6v16M17 6v16"/>',
  layout3h: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M5 11.3h18M5 16.7h18"/>',
  layout6: '<rect x="5" y="6" width="18" height="16" rx="1"/><path d="M11 6v16M17 6v16M5 14h18"/>',
  layout8: '<rect x="4" y="6" width="20" height="16" rx="1"/><path d="M9 6v16M14 6v16M19 6v16M4 14h20"/>',
};
export const svg = name => `<svg viewBox="0 0 28 28">${ICONS[name] || ''}</svg>`;
export const icon = name => h('span', { class: 'ico', html: svg(name) });

// ------------------------------------------------------------------ formatting
export function decimalsOf(str) {
  const s = String(str);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.slice(i + 1).replace(/0+$/, '').length;
}
export function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const fmtPrice = (v, prec = 2) => fmtNum(v, prec);
export function fmtUsd(v, signed = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−$' : signed && v > 0 ? '+$' : '$') + s;
}
export function fmtVol(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(a < 10 ? 3 : 2);
}
export const fmtSigned = (v, prec = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v), prec);
export const fmtPct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%');
const p2 = n => String(n).padStart(2, '0');
export function fmtDate(t) {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
export function fmtDateTime(t, withSeconds = false) {
  if (t == null) return '—';
  const d = new Date(t * 1000);
  return `${fmtDate(t)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${withSeconds ? ':' + p2(d.getUTCSeconds()) : ''}`;
}
export function fmtDuration(s) {
  s = Math.abs(s);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${hh ? ' ' + hh + 'h' : ''}`;
  if (hh) return `${hh}h${m ? ' ' + m + 'm' : ''}`;
  return `${m}m`;
}
/** "2025-01-02T10:00" (datetime-local, interpreted as UTC) → unix seconds. */
export function parseUtcInput(v) {
  if (!v) return null;
  const t = Date.parse(v.length <= 10 ? `${v}T00:00:00Z` : `${v.slice(0, 16)}:00Z`);
  return Number.isFinite(t) ? t / 1000 : null;
}
export const toUtcInput = t => new Date(t * 1000).toISOString().slice(0, 16);

export function symColor(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${x}, 62%, 48%)`;
}
export const coin = s => h('span', { class: 'coin', style: { background: symColor(s) } }, s[0]);
export function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/** Short notification tone for alerts (no audio file needed). */
export function beep() {
  try {
    const ac = beep.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ac.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.35); o.stop(ac.currentTime + 0.36);
  } catch { /* audio unavailable */ }
}

let toastTimer;
/** Brief message at the bottom of the screen; optional action buttons keep it up longer. */
export function toast(msg, kind = '', actions = []) {
  const t = $('#toast');
  t.replaceChildren(document.createTextNode(msg));
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = a.label;
    b.addEventListener('click', () => { t.hidden = true; a.onClick(); });
    t.append(b);
  }
  t.className = 'toast ' + kind + (actions.length ? ' has-actions' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actions.length ? 12000 : kind === 'error' ? 5000 : 2800);
}

// ------------------------------------------------------------------ server API + persistence
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) && typeof opts.body !== 'string' ? { 'content-type': 'application/json' } : opts.headers,
    body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer) ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Server-backed key/value store with an in-memory mirror and debounced writes. */
export const kv = {
  mem: new Map(),
  timers: new Map(),
  async get(key, fallback = null) {
    if (this.mem.has(key)) return this.mem.get(key);
    let v = null;
    try { v = await api(`/api/kv/${encodeURIComponent(key)}`); } catch (e) { console.warn('kv get failed', key, e); }
    v = v ?? fallback;
    this.mem.set(key, v);
    return v;
  },
  peek(key, fallback = null) { return this.mem.has(key) ? this.mem.get(key) : fallback; },
  set(key, value, delay = 400) {
    this.mem.set(key, value);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.flush(key), delay));
  },
  async flush(key) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    try { await api(`/api/kv/${encodeURIComponent(key)}`, { method: 'PUT', body: this.mem.get(key) ?? null }); }
    catch (e) { console.error('kv save failed', key, e); toast(`Could not save ${key}: ${e.message}`, 'error'); }
  },
  async flushAll() { await Promise.all([...this.timers.keys()].map(k => this.flush(k))); },
  async remove(key) { this.mem.delete(key); clearTimeout(this.timers.get(key)); await api(`/api/kv/${encodeURIComponent(key)}`, { method: 'DELETE' }); },
};
window.addEventListener('beforeunload', () => {
  for (const key of kv.timers.keys()) {
    navigator.sendBeacon?.(`/api/kv-beacon/${encodeURIComponent(key)}`, JSON.stringify(kv.mem.get(key)));
  }
});

/** Modal helper: shows the element (a .modal) and wires close buttons/backdrop/Escape. */
export function openModal(el) {
  el.hidden = false;
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('mousedown', e => { if (e.target === el || e.target.closest('[data-close]')) el.hidden = true; });
  }
}
export const closeModals = () => $$('.modal').forEach(m => { m.hidden = true; });

export function confirmBox(message, okLabel = 'OK') {
  return new Promise(resolve => {
    const m = $('#confirmModal');
    $('#confirmText').textContent = message;
    const ok = $('#confirmOk'), cancel = $('#confirmCancel');
    ok.textContent = okLabel;
    const done = v => { m.hidden = true; ok.onclick = cancel.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    openModal(m);
    ok.focus();
  });
}

/** Simple form helper: returns { el, values() } for a list of field specs. */
export function formFields(fields) {
  const inputs = {};
  const el = h('div', { class: 'form-grid' }, fields.map(f => {
    let input;
    if (f.type === 'select') input = h('select', { name: f.key }, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value) }, l)));
    else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', name: f.key, checked: !!f.value });
    else input = h('input', { type: f.type || 'number', name: f.key, value: f.value ?? '', step: f.step || 'any', min: f.min, placeholder: f.placeholder || '' });
    if (f.onchange) input.addEventListener('change', f.onchange);
    inputs[f.key] = input;
    return h('label', { class: 'field' + (f.wide ? ' wide' : ''), title: f.hint || '' }, h('span', null, f.label), input);
  }));
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value]));
  return { el, inputs, values };
}
