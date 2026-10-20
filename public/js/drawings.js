// Drawing tools: rendering, hit-testing and dragging on a chart's overlay canvas.
// Points are stored in chart space { time, price } so drawings survive zooming, timeframe changes and
// layouts. A drawing context `cx` supplies the coordinate conversions for the current chart. While a drawing is
// painted its clickable geometry (segments, shapes, handles) is recorded in `cx.geom`, which hit-testing reads.

import { ACCENT, DOWN, FONT, UP, clamp, fmtDuration, fmtPct, fmtSigned, fmtVol, hexA } from './util.js';

// n: points to click (1 = one click, 2 = drag or two clicks, 'free' = freehand, 'path' = click points, double-click to end)
export const TOOL_INFO = {
  cursor: { title: 'Cross', icon: 'cross' },
  trend: { title: 'Trend line', icon: 'trend', n: 2, key: 'Alt+T' },
  ray: { title: 'Ray', icon: 'ray', n: 2 },
  extline: { title: 'Extended line', icon: 'extline', n: 2 },
  infoline: { title: 'Info line', icon: 'infoline', n: 2 },
  arrow: { title: 'Arrow', icon: 'arrow', n: 2 },
  hline: { title: 'Horizontal line', icon: 'hline', n: 1, key: 'Alt+H' },
  hray: { title: 'Horizontal ray', icon: 'hray', n: 1 },
  vline: { title: 'Vertical line', icon: 'vline', n: 1, key: 'Alt+V' },
  crossline: { title: 'Cross line', icon: 'crossline', n: 1 },
  channel: { title: 'Parallel channel', icon: 'channel', n: 3, key: 'Alt+C' },
  regression: { title: 'Regression trend', icon: 'regression', n: 2 },
  pitchfork: { title: 'Pitchfork', icon: 'pitchfork', n: 3 },
  schiff: { title: 'Schiff pitchfork', icon: 'schiff', n: 3 },
  fib: { title: 'Fib retracement', icon: 'fib', n: 2, key: 'Alt+F' },
  fibext: { title: 'Trend-based fib extension', icon: 'fibext', n: 3 },
  fibtime: { title: 'Fib time zone', icon: 'fibtime', n: 2 },
  fibfan: { title: 'Fib speed resistance fan', icon: 'fibfan', n: 2 },
  fibcircle: { title: 'Fib circles', icon: 'fibcircle', n: 2 },
  gannbox: { title: 'Gann box', icon: 'gannbox', n: 2 },
  gannfan: { title: 'Gann fan', icon: 'gannfan', n: 2 },
  xabcd: { title: 'XABCD pattern', icon: 'xabcd', n: 5 },
  abcd: { title: 'ABCD pattern', icon: 'abcd', n: 4 },
  tripattern: { title: 'Triangle pattern', icon: 'tripattern', n: 4 },
  hs: { title: 'Head and shoulders', icon: 'hs', n: 7 },
  elliott5: { title: 'Elliott impulse wave (12345)', icon: 'elliott5', n: 6 },
  elliott3: { title: 'Elliott correction wave (ABC)', icon: 'elliott3', n: 4 },
  long: { title: 'Long position', icon: 'long', n: 1 },
  short: { title: 'Short position', icon: 'short', n: 1 },
  pricerange: { title: 'Price range', icon: 'pricerange', n: 2 },
  daterange: { title: 'Date range', icon: 'daterange', n: 2 },
  dprange: { title: 'Date and price range', icon: 'dprange', n: 2 },
  avwap: { title: 'Anchored VWAP', icon: 'avwap', n: 1 },
  measure: { title: 'Measure (Shift+click)', icon: 'ruler', n: 2 },
  brush: { title: 'Brush — drag to paint', icon: 'brush', n: 'free', key: 'Alt+B' },
  highlighter: { title: 'Highlighter — drag to paint', icon: 'highlighter', n: 'free' },
  rect: { title: 'Rectangle', icon: 'rect', n: 2 },
  ellipse: { title: 'Ellipse', icon: 'ellipse', n: 2 },
  circle: { title: 'Circle', icon: 'circle', n: 2 },
  triangle: { title: 'Triangle', icon: 'triangle', n: 3 },
  path: { title: 'Path — click points, double-click to finish', icon: 'path', n: 'path' },
  text: { title: 'Text', icon: 'text', n: 1 },
  note: { title: 'Note', icon: 'note', n: 1 },
  callout: { title: 'Callout', icon: 'callout', n: 2 },
  pricelabel: { title: 'Price label', icon: 'pricelabel', n: 1 },
  flag: { title: 'Flag mark', icon: 'flag', n: 1 },
  arrowup: { title: 'Arrow mark up', icon: 'arrowup', n: 1 },
  arrowdown: { title: 'Arrow mark down', icon: 'arrowdown', n: 1 },
  icon: { title: 'Icon / emoji', icon: 'smile', n: 1 },
};
export const TOOL_GROUPS = [
  { k: 'lines', title: 'Lines', items: ['trend', 'ray', 'extline', 'infoline', 'arrow', 'hline', 'hray', 'vline', 'crossline'] },
  { k: 'channels', title: 'Channels & pitchforks', items: ['channel', 'regression', 'pitchfork', 'schiff'] },
  { k: 'fib', title: 'Fibonacci & Gann', items: ['fib', 'fibext', 'fibtime', 'fibfan', 'fibcircle', 'gannbox', 'gannfan'] },
  { k: 'patterns', title: 'Patterns & Elliott waves', items: ['xabcd', 'abcd', 'tripattern', 'hs', 'elliott5', 'elliott3'] },
  { k: 'forecast', title: 'Forecasting & measuring', items: ['long', 'short', 'pricerange', 'daterange', 'dprange', 'avwap'] },
  { k: 'shapes', title: 'Brushes & shapes', items: ['brush', 'highlighter', 'rect', 'ellipse', 'circle', 'triangle', 'path'] },
  { k: 'annot', title: 'Text & marks', items: ['text', 'note', 'callout', 'pricelabel', 'flag', 'arrowup', 'arrowdown', 'icon'] },
];
export const ONE_CLICK = new Set(Object.keys(TOOL_INFO).filter(k => TOOL_INFO[k].n === 1));
export const pointsOf = k => TOOL_INFO[k]?.n ?? 2;
export const toolTitle = k => (TOOL_INFO[k]?.title || k).replace(/ —.*$/, '').replace(/ \(Shift\+click\)/, '');
export const ICON_CHOICES = ['⭐', '🔥', '✅', '❌', '⚠️', '📈', '📉', '💰', '🚀', '🎯', '👍', '👎', '❓', '❗', '🔔', '💡', '🛑', '🏁', '💎', '⏰', '🐂', '🐻', '🧱', '📌'];
/** Drawings whose look can be changed (colour/width/style) and those with a fill or text. */
export const FILLABLE = new Set(['rect', 'ellipse', 'circle', 'triangle', 'channel', 'brush', 'pitchfork', 'schiff', 'regression', 'gannbox', 'xabcd', 'abcd', 'hs', 'tripattern']);
export const HAS_TEXT = new Set(['text', 'note', 'callout', 'arrowup', 'arrowdown', 'flag', 'trend', 'hline', 'rect']);
export const LINE_LIKE = new Set(['trend', 'ray', 'extline', 'infoline', 'arrow', 'hline', 'hray', 'vline', 'crossline', 'channel', 'regression', 'pitchfork', 'schiff',
  'rect', 'ellipse', 'circle', 'triangle', 'path', 'brush', 'highlighter', 'avwap', 'xabcd', 'abcd', 'tripattern', 'hs', 'elliott5', 'elliott3', 'callout']);

export const FIB_LEVELS = [
  [0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'],
  [0.618, '#089981'], [0.786, '#00bcd4'], [1, '#787b86'],
];
const FIB_EXT = [[0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'], [0.786, '#00bcd4'], [1, '#787b86'],
  [1.618, '#2962ff'], [2.618, '#f23645'], [3.618, '#9c27b0'], [4.236, '#e91e63']];
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const GANN = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
const GANN_FAN = [[8, 1], [4, 1], [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [1, 4], [1, 8]];
const RAINBOW = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#787b86', '#ff9800'];

export function label(cx, lines, x, y, bg, fg, align = 'center', valign = 'middle') {
  const { ctx } = cx;
  ctx.font = `12px ${FONT}`;
  const padX = 8, lh = 16;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2;
  const hgt = lines.length * lh + 8;
  let bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  let by = valign === 'middle' ? y - hgt / 2 : valign === 'bottom' ? y - hgt : y;
  bx = clamp(bx, 2, cx.W - w - 2);
  by = clamp(by, 2, cx.H - hgt - 2);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx, by, w, hgt, 4) : ctx.rect(bx, by, w, hgt);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, bx + w / 2, by + 4 + lh * i + lh / 2));
  return { x: bx, y: by, w, h: hgt };
}

function rayEnd(a, b, W, H) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return b;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (W - a.x) / dx); else if (dx < 0) t = Math.min(t, -a.x / dx);
  if (dy > 0) t = Math.min(t, (H - a.y) / dy); else if (dy < 0) t = Math.min(t, -a.y / dy);
  if (!Number.isFinite(t) || t < 1) t = 1;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** Geometry of a long/short position tool. */
function positionGeom(cx, d) {
  const x1 = cx.timeToX(d.pts[0].time), x2 = cx.timeToX(d.endTime);
  const ye = cx.priceToY(d.pts[0].price), ys = cx.priceToY(d.stop), yt = cx.priceToY(d.target);
  if ([x1, x2, ye, ys, yt].some(v => v == null)) return null;
  return { x1: Math.min(x1, x2), x2: Math.max(x1, x2), ye, ys, yt };
}

export function positionStats(d, spec) {
  const entry = d.pts[0].price, dir = d.type === 'long' ? 1 : -1;
  const risk = Math.abs(entry - d.stop), reward = Math.abs(d.target - entry);
  return {
    entry, dir, risk, reward, rr: risk > 0 ? reward / risk : 0,
    targetPct: (d.target - entry) / entry * 100, stopPct: (d.stop - entry) / entry * 100,
    valid: (d.target - entry) * dir > 0 && (entry - d.stop) * dir > 0,
    spec,
  };
}

function textMetrics(cx, d) {
  const { ctx } = cx;
  const size = d.size || 14;
  ctx.font = `${size}px ${FONT}`;
  const lines = String(d.text || 'Text').split('\n');
  const w = Math.max(...lines.map(l => ctx.measureText(l).width));
  return { lines, w, h: lines.length * size * 1.3, size };
}

/** Bars between two drawing times (inclusive, by chart index). */
function barsBetween(cx, t1, t2) {
  const l1 = cx.timeToLogical(t1), l2 = cx.timeToLogical(t2);
  const i1 = Math.max(0, Math.ceil(Math.min(l1, l2) - 1e-9)), i2 = Math.min(cx.bars.length - 1, Math.floor(Math.max(l1, l2) + 1e-9));
  return { i1, i2 };
}

export function renderDrawing(cx, d, selected) {
  if (d.hidden) return;
  const { ctx, W, H } = cx;
  const G = { segs: [], polys: [], rects: [], rings: [], discs: [], handles: [] };
  cx.geom?.set(d, G);
  const P = d.pts.map(p => cx.toXY(p));
  const col = d.color || ACCENT;
  const lw = d.width || (d.type === 'highlighter' ? 14 : 2);
  const dash = d.style === 'dashed' ? [7, 5] : d.style === 'dotted' ? [2, 4] : [];
  const ok = (...pts) => pts.every(p => p && p.x != null && p.y != null);
  const stroke = (color = col, width = lw, dsh = dash) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dsh); };
  const seg = (a, b, record = true) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); if (record) G.segs.push([a, b]); };
  const poly = (pts, fillColor, close = true) => {
    if (pts.length < 2) return;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    if (close) ctx.closePath();
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); G.polys.push(pts); }
  };
  const polyline = pts => { for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]); };
  const text = (s, x, y, color = col, align = 'center', base = 'middle', font = `12px ${FONT}`) => {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, x, y);
  };
  const box = (x, y, w, h) => G.rects.push({ x, y, w, h });
  const arrowHead = (a, b, size = 10) => {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - size * Math.cos(ang - 0.45), b.y - size * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - size * Math.cos(ang + 0.45), b.y - size * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  };
  const fillA = (a = 0.12) => (d.fill === false ? null : hexA(col, a));
  const handle = (p, idx) => { if (p && p.x != null && p.y != null) G.handles.push({ x: p.x, y: p.y, idx }); };
  const handlesAll = () => P.forEach((p, i) => handle(p, i));
  const pointLabels = (names) => P.forEach((p, i) => {
    if (!ok(p) || !names[i]) return;
    const prev = P[i - 1], next = P[i + 1];
    const high = (prev ? p.y <= prev.y : true) && (next ? p.y <= next.y : true) || (!prev && next && p.y < next.y) || (!next && prev && p.y < prev.y);
    text(names[i], p.x, p.y + (high ? -9 : 9), col, 'center', high ? 'bottom' : 'top', `600 12px ${FONT}`);
  });
  stroke();

  switch (d.type) {
    case 'brush':
    case 'highlighter': {
      const pts = P.filter(p => p.x != null && p.y != null);
      if (pts.length < 2) return;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = d.type === 'highlighter' ? hexA(col, 0.35) : col;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      // smooth the stroke through the midpoints of successive samples
      for (let k = 1; k < pts.length - 1; k++) ctx.quadraticCurveTo(pts[k].x, pts[k].y, (pts[k].x + pts[k + 1].x) / 2, (pts[k].y + pts[k + 1].y) / 2);
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      if (d.fill && d.type === 'brush') { ctx.save(); ctx.fillStyle = hexA(col, 0.2); ctx.fill(); ctx.restore(); G.polys.push(pts); }
      ctx.stroke();
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      for (let i = 1; i < pts.length; i++) G.segs.push([pts[i - 1], pts[i]]);
      G.tol = lw / 2;
      if (selected) { handle(pts[0], -1); handle(pts[pts.length - 1], -1); }
      break;
    }
    case 'trend':
    case 'ray':
    case 'extline':
    case 'arrow':
    case 'infoline': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const ext = d.type === 'ray' ? 'right' : d.type === 'extline' ? 'both' : d.extend || 'none';
      const s = ext === 'left' || ext === 'both' ? rayEnd(b, a, W, H) : a;
      const e = ext === 'right' || ext === 'both' ? rayEnd(a, b, W, H) : b;
      seg(s, e);
      if (d.type === 'arrow') arrowHead(a, b, 8 + lw * 2);
      if (d.type === 'infoline') {
        const dp = d.pts[1].price - d.pts[0].price, bars = Math.round(cx.timeToLogical(d.pts[1].time) - cx.timeToLogical(d.pts[0].time));
        const ang = Math.atan2(-(b.y - a.y), b.x - a.x) * 180 / Math.PI;
        label(cx, [`${fmtSigned(dp, cx.prec)} (${fmtPct(dp / d.pts[0].price * 100)})`, `${bars} bars, ${fmtDuration(Math.abs(bars) * cx.tfSec)}`, `${ang.toFixed(1)}°`],
          b.x + 10, b.y, hexA(col, 0.92), '#fff', 'left', 'middle');
      }
      if (d.text) text(d.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6, col, 'center', 'bottom', `13px ${FONT}`);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'hline': {
      const y = P[0].y;
      if (y == null) return;
      seg({ x: 0, y }, { x: W, y });
      label(cx, [cx.fmtPrice(d.pts[0].price)], W - 4, y, col, '#fff', 'right');
      if (d.text) text(d.text, 8, y - 4, col, 'left', 'bottom', `13px ${FONT}`);
      if (P[0].x != null) handle({ x: clamp(P[0].x, 8, W - 8), y }, 0);
      break;
    }
    case 'hray': {
      const p = P[0];
      if (!ok(p)) return;
      seg(p, { x: W, y: p.y });
      label(cx, [cx.fmtPrice(d.pts[0].price)], W - 4, p.y, col, '#fff', 'right');
      handle(p, 0);
      break;
    }
    case 'vline': {
      const x = P[0].x;
      if (x == null) return;
      seg({ x, y: 0 }, { x, y: H });
      label(cx, [cx.fmtTime(d.pts[0].time)], x, H - 4, col, '#fff', 'center', 'bottom');
      handle({ x, y: P[0].y ?? H / 2 }, 0);
      break;
    }
    case 'crossline': {
      const p = P[0];
      if (!ok(p)) return;
      seg({ x: 0, y: p.y }, { x: W, y: p.y });
      seg({ x: p.x, y: 0 }, { x: p.x, y: H });
      label(cx, [cx.fmtPrice(d.pts[0].price)], W - 4, p.y, col, '#fff', 'right');
      label(cx, [cx.fmtTime(d.pts[0].time)], p.x, H - 4, col, '#fff', 'center', 'bottom');
      handle(p, 0);
      break;
    }
    case 'rect': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
      if (d.fill !== false) { ctx.fillStyle = hexA(col, 0.14); ctx.fillRect(x, y, w, hh); }
      ctx.strokeRect(x, y, w, hh);
      box(x, y, w, hh);
      if (d.text) text(d.text, x + w / 2, y + hh / 2, col, 'center', 'middle', `13px ${FONT}`);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'ellipse': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
      if (d.fill !== false) { ctx.fillStyle = hexA(col, 0.12); ctx.fill(); }
      ctx.stroke();
      G.discs.push({ x: c.x, y: c.y, rx, ry });
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'circle': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(r, 0.5), 0, Math.PI * 2);
      if (d.fill !== false) { ctx.fillStyle = hexA(col, 0.12); ctx.fill(); }
      ctx.stroke();
      G.discs.push({ x: a.x, y: a.y, rx: r, ry: r });
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'triangle': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      poly(pts, pts.length > 2 ? fillA(0.14) : null);
      ctx.stroke();
      polyline([...pts, pts[0]]);
      handlesAll();
      break;
    }
    case 'path': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      polyline(pts);
      arrowHead(pts[pts.length - 2], pts[pts.length - 1], 8 + lw * 2);
      handlesAll();
      break;
    }
    case 'channel': {
      const [a, b, c] = P;
      if (!ok(a, b)) return;
      const yAt = x => a.y + (b.y - a.y) * (x - a.x) / ((b.x - a.x) || 1e-9);
      const off = ok(c) ? c.y - yAt(c.x) : 0;
      const a2 = { x: a.x, y: a.y + off }, b2 = { x: b.x, y: b.y + off };
      if (off) poly([a, b, b2, a2], fillA(0.12));
      seg(a, b);
      if (off) {
        seg(a2, b2);
        stroke(col, 1, [4, 4]); seg({ x: a.x, y: a.y + off / 2 }, { x: b.x, y: b.y + off / 2 }, false); stroke();
      }
      handle(a, 0); handle(b, 1);
      if (ok(c)) handle({ x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }, 2);
      break;
    }
    case 'regression': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const { i1, i2 } = barsBetween(cx, d.pts[0].time, d.pts[1].time);
      if (i2 - i1 < 2) { seg(a, b); handle(a, 0); handle(b, 1); break; }
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const n = i2 - i1 + 1;
      for (let i = i1; i <= i2; i++) { const y = cx.bars[i].close; sx += i; sy += y; sxx += i * i; sxy += i * y; }
      const m = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), k0 = (sy - m * sx) / n;
      let ss = 0;
      for (let i = i1; i <= i2; i++) ss += (cx.bars[i].close - (k0 + m * i)) ** 2;
      const sd = Math.sqrt(ss / n), dev = d.deviation || 2;
      const pt = (i, k) => ({ x: cx.logicalToX(i), y: cx.priceToY(k0 + m * i + k * sd) });
      const [u1, u2, l1, l2, c1, c2] = [pt(i1, dev), pt(i2, dev), pt(i1, -dev), pt(i2, -dev), pt(i1, 0), pt(i2, 0)];
      if (![u1, u2, l1, l2, c1, c2].every(p => ok(p))) return;
      poly([u1, u2, l2, l1], fillA(0.08));
      seg(c1, c2);
      stroke(col, 1, [5, 4]); seg(u1, u2); seg(l1, l2); stroke();
      if (selected) text(`slope ${fmtSigned(m, cx.prec)}/bar · ±${dev}σ`, c2.x, c2.y - 8, col, 'right', 'bottom');
      handle(c1, 0); handle(c2, 1);
      break;
    }
    case 'pitchfork':
    case 'schiff': {
      const [a0, b, c] = P;
      if (!ok(a0, b)) return;
      if (!ok(c)) { seg(a0, b); handle(a0, 0); handle(b, 1); break; }
      const m = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      const a = d.type === 'schiff' ? { x: (a0.x + b.x) / 2, y: (a0.y + b.y) / 2 } : a0;
      const dir = { x: m.x - a.x, y: m.y - a.y };
      const far = p => rayEnd(p, { x: p.x + dir.x, y: p.y + dir.y }, W, H);
      const fb = far(b), fc = far(c);
      poly([b, fb, fc, c], fillA(0.08));
      seg(a, far(a));
      seg(b, fb); seg(c, fc);
      stroke(col, 1, [4, 4]); seg(b, c, false); if (d.type === 'schiff') seg(a0, a, false); stroke();
      handle(a0, 0); handle(b, 1); handle(c, 2);
      break;
    }
    case 'fib': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const x1 = Math.min(a.x, b.x), x2 = d.extend === 'right' ? W : Math.max(a.x, b.x);
      const p1 = d.pts[0].price, p2 = d.pts[1].price;
      let prevY = null;
      for (const [lvl, c] of FIB_LEVELS) {
        const price = p2 + (p1 - p2) * lvl;
        const y = cx.priceToY(price);
        if (y == null) continue;
        if (prevY != null && d.fill !== false) { ctx.fillStyle = hexA(c, 0.1); ctx.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY)); }
        stroke(c, 1, []);
        seg({ x: x1, y }, { x: x2, y });
        text(`${lvl} (${cx.fmtPrice(price)})`, x1 - 4, y, c, 'right', 'middle', `11px ${FONT}`);
        prevY = y;
      }
      stroke('#787b86', 1, [4, 4]);
      seg(a, b, false);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'fibext': {
      const [a, b, c] = P;
      if (!ok(a, b)) return;
      stroke('#787b86', 1, [4, 4]); seg(a, b, false); if (ok(c)) seg(b, c, false);
      if (ok(c)) {
        const move = d.pts[1].price - d.pts[0].price, base = d.pts[2].price;
        const x1 = c.x, x2 = d.extend === 'right' ? W : c.x + Math.max(60, Math.abs(b.x - a.x));
        let prevY = null;
        for (const [lvl, colr] of FIB_EXT) {
          const price = base + move * lvl, y = cx.priceToY(price);
          if (y == null) continue;
          if (prevY != null && d.fill !== false) { ctx.fillStyle = hexA(colr, 0.08); ctx.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY)); }
          stroke(colr, 1, []); seg({ x: x1, y }, { x: x2, y });
          text(`${lvl} (${cx.fmtPrice(price)})`, x1 - 4, y, colr, 'right', 'middle', `11px ${FONT}`);
          prevY = y;
        }
      }
      handlesAll();
      break;
    }
    case 'fibtime': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const l0 = cx.timeToLogical(d.pts[0].time), step = cx.timeToLogical(d.pts[1].time) - l0;
      FIB_TIME.forEach((n, k) => {
        const x = cx.logicalToX(l0 + step * n);
        if (x == null || x < -2 || x > W + 2) return;
        stroke(RAINBOW[k % RAINBOW.length], 1, []); seg({ x, y: 0 }, { x, y: H });
        text(String(n), x + 3, 4, RAINBOW[k % RAINBOW.length], 'left', 'top', `11px ${FONT}`);
      });
      stroke('#787b86', 1, [4, 4]); seg(a, b, false);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'fibfan': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      [[1, '#787b86'], [0.75, '#ff9800'], [0.618, '#089981'], [0.5, '#4caf50'], [0.382, '#00bcd4'], [0.25, '#2962ff']].forEach(([lvl, c]) => {
        const t = { x: b.x, y: a.y + (b.y - a.y) * lvl };
        stroke(c, 1, []); seg(a, rayEnd(a, t, W, H));
        text(String(lvl), t.x + 4, t.y, c, 'left', 'middle', `11px ${FONT}`);
      });
      stroke('#787b86', 1, [3, 3]); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'fibcircle': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const r0 = Math.hypot(b.x - a.x, b.y - a.y);
      [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618].forEach((lvl, k) => {
        const r = r0 * lvl;
        stroke(RAINBOW[(k + 1) % RAINBOW.length], 1, []);
        ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(0.5, r), 0, Math.PI * 2); ctx.stroke();
        G.rings.push({ x: a.x, y: a.y, r });
        text(String(lvl), a.x + r + 3, a.y, RAINBOW[(k + 1) % RAINBOW.length], 'left', 'middle', `10px ${FONT}`);
      });
      stroke('#787b86', 1, [4, 4]); seg(a, b, false);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'gannbox': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
      if (d.fill !== false) { ctx.fillStyle = hexA(col, 0.06); ctx.fillRect(x1, y1, x2 - x1, y2 - y1); }
      GANN.forEach((lvl, k) => {
        const x = x1 + (x2 - x1) * lvl, y = y1 + (y2 - y1) * lvl, c = RAINBOW[k + 1];
        stroke(c, 1, []); seg({ x, y: y1 }, { x, y: y2 }); seg({ x: x1, y }, { x: x2, y });
        text(String(lvl), x, y1 - 3, c, 'center', 'bottom', `10px ${FONT}`);
        text(String(lvl), x1 - 3, y, c, 'right', 'middle', `10px ${FONT}`);
      });
      stroke('#787b86', 1, [4, 4]); seg({ x: x1, y: y2 }, { x: x2, y: y1 }, false); seg({ x: x1, y: y1 }, { x: x2, y: y2 }, false);
      box(x1, y1, x2 - x1, y2 - y1);
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'gannfan': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      GANN_FAN.forEach(([pr, tm], k) => { // pr/tm price units per time unit: 1/1 runs through B
        const tt = pr >= tm ? { x: a.x + dx, y: a.y + dy * pr / tm } : { x: a.x + dx * tm / pr, y: a.y + dy };
        const c = k === 4 ? col : RAINBOW[(k + 1) % RAINBOW.length];
        stroke(c, k === 4 ? 2 : 1, []); seg(a, rayEnd(a, tt, W, H));
        const lp = { x: a.x + (tt.x - a.x) * 0.9, y: a.y + (tt.y - a.y) * 0.9 };
        text(`${pr}/${tm}`, lp.x + 4, lp.y, c, 'left', 'middle', `10px ${FONT}`);
      });
      handle(a, 0); handle(b, 1);
      break;
    }
    case 'xabcd':
    case 'abcd': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      const names = d.type === 'xabcd' ? ['X', 'A', 'B', 'C', 'D'] : ['A', 'B', 'C', 'D'];
      const pr = d.pts.map(p => p.price);
      if (d.type === 'xabcd') { if (pts.length >= 3) poly(pts.slice(0, 3), fillA(0.14)); if (pts.length >= 5) poly(pts.slice(2, 5), fillA(0.14)); }
      polyline(pts);
      const ratio = (i, j, k, l) => (Math.abs(pr[j] - pr[i]) > 0 ? Math.abs(pr[l] - pr[k]) / Math.abs(pr[j] - pr[i]) : 0);
      const dashLine = (i, j, r) => {
        if (!ok(P[i], P[j])) return;
        stroke(col, 1, [4, 4]); seg(P[i], P[j], false); stroke();
        label(cx, [r.toFixed(3)], (P[i].x + P[j].x) / 2, (P[i].y + P[j].y) / 2, hexA(col, 0.85), '#fff');
      };
      if (d.type === 'xabcd') {
        if (pts.length >= 3) dashLine(0, 2, ratio(0, 1, 1, 2));
        if (pts.length >= 4) dashLine(1, 3, ratio(1, 2, 2, 3));
        if (pts.length >= 5) { dashLine(2, 4, ratio(2, 3, 3, 4)); dashLine(0, 4, ratio(0, 1, 1, 4)); }
      } else {
        if (pts.length >= 3) dashLine(0, 2, ratio(0, 1, 1, 2));
        if (pts.length >= 4) dashLine(1, 3, ratio(1, 2, 2, 3));
      }
      pointLabels(names);
      handlesAll();
      break;
    }
    case 'tripattern': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      if (pts.length >= 4) poly(pts, fillA(0.1));
      polyline(pts);
      stroke(col, 1, [4, 4]);
      if (pts.length >= 3) seg(pts[0], rayEnd(pts[0], pts[2], W, H), false);
      if (pts.length >= 4) seg(pts[1], rayEnd(pts[1], pts[3], W, H), false);
      stroke();
      pointLabels(['A', 'B', 'C', 'D']);
      handlesAll();
      break;
    }
    case 'hs': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      if (pts.length >= 5) poly(pts.slice(2, 5), fillA(0.14));
      polyline(pts);
      if (pts.length >= 5) {
        const n1 = pts[2], n2 = pts[4];
        stroke(col, 1.5, [5, 4]);
        const left = { x: pts[0].x, y: n1.y + (n2.y - n1.y) * (pts[0].x - n1.x) / ((n2.x - n1.x) || 1e-9) };
        seg(left, rayEnd(n1, n2, W, H), false);
        stroke();
      }
      pointLabels(['', 'Left shoulder', '', 'Head', '', 'Right shoulder', '']);
      handlesAll();
      break;
    }
    case 'elliott5':
    case 'elliott3': {
      const pts = P.filter(p => ok(p));
      if (pts.length < 2) return;
      polyline(pts);
      pointLabels(d.type === 'elliott5' ? ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)'] : ['(0)', '(A)', '(B)', '(C)']);
      handlesAll();
      break;
    }
    case 'pricerange':
    case 'daterange':
    case 'dprange':
    case 'measure': {
      const [a, b] = P;
      if (!ok(a, b)) return;
      const p1 = d.pts[0].price, p2 = d.pts[1].price, dp = p2 - p1;
      const up = d.type === 'daterange' ? b.x >= a.x : dp >= 0;
      const c = up ? ACCENT : DOWN;
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
      ctx.fillStyle = hexA(c, 0.16);
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      box(x1, y1, x2 - x1, y2 - y1);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const bars = Math.round(cx.timeToLogical(d.pts[1].time) - cx.timeToLogical(d.pts[0].time));
      const { i1, i2 } = barsBetween(cx, d.pts[0].time, d.pts[1].time);
      let vol = 0;
      for (let i = i1; i <= i2; i++) vol += cx.bars[i]?.volume || 0;
      const priceLine = `${fmtSigned(dp, cx.prec)} (${fmtPct((dp / p1) * 100)})${d.type === 'pricerange' ? ` · ${Math.round(Math.abs(dp) * 10 ** cx.prec).toLocaleString()} ticks` : ''}`;
      const timeLine = `${bars} bars, ${fmtDuration(Math.abs(bars) * cx.tfSec)}`;
      stroke(c, 1, []);
      let lines;
      if (d.type === 'pricerange') {
        seg({ x: x1, y: a.y }, { x: x2, y: a.y }, false); seg({ x: x1, y: b.y }, { x: x2, y: b.y }, false);
        seg({ x: mx, y: a.y }, { x: mx, y: b.y }, false); arrowHead({ x: mx, y: a.y }, { x: mx, y: b.y }, 8);
        lines = [priceLine];
      } else if (d.type === 'daterange') {
        seg({ x: a.x, y: y1 }, { x: a.x, y: y2 }, false); seg({ x: b.x, y: y1 }, { x: b.x, y: y2 }, false);
        seg({ x: a.x, y: my }, { x: b.x, y: my }, false); arrowHead({ x: a.x, y: my }, { x: b.x, y: my }, 8);
        lines = [timeLine, ...(vol ? [`Vol ${fmtVol(vol)}`] : [])];
      } else {
        seg({ x: mx, y: a.y }, { x: mx, y: b.y }, false); seg({ x: a.x, y: my }, { x: b.x, y: my }, false);
        lines = [priceLine, timeLine, ...(d.type === 'dprange' && vol ? [`Vol ${fmtVol(vol)}`] : [])];
      }
      const below = d.type === 'daterange' ? false : !up;
      label(cx, lines, mx, below ? y2 + 6 : y1 - 6, c, '#fff', 'center', below ? 'top' : 'bottom');
      if (d.type !== 'measure') { handle(a, 0); handle(b, 1); }
      break;
    }
    case 'avwap': {
      const p = P[0];
      if (!ok(p) || !cx.bars.length) return;
      const B = cx.bars, l0 = cx.timeToLogical(d.pts[0].time);
      const i0 = clamp(Math.ceil(l0 - 1e-9), 0, B.length - 1);
      const useVol = B.slice(i0).some(x => x.volume > 0);
      let pv = 0, v = 0;
      const pts = [];
      for (let i = i0; i < B.length; i++) {
        const w = useVol ? B[i].volume || 0 : 1, tp = (B[i].high + B[i].low + B[i].close) / 3;
        pv += tp * w; v += w;
        if (v > 0) { const x = cx.logicalToX(i), y = cx.priceToY(pv / v); if (x != null && y != null) pts.push({ x, y }); }
      }
      if (pts.length > 1) polyline(pts);
      const first = pts[0] || p;
      ctx.beginPath(); ctx.arc(first.x, first.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      if (pts.length) { const last = pts[pts.length - 1]; text(`AVWAP${useVol ? '' : ' (no volume: equal weights)'}`, last.x + 6, last.y, col, 'left', 'middle', `11px ${FONT}`); }
      handle(first, 0);
      break;
    }
    case 'long':
    case 'short': {
      const g = positionGeom(cx, d);
      if (!g) return;
      const st = positionStats(d, cx.spec);
      ctx.fillStyle = hexA(UP, 0.2);
      ctx.fillRect(g.x1, Math.min(g.ye, g.yt), g.x2 - g.x1, Math.abs(g.yt - g.ye));
      ctx.fillStyle = hexA(DOWN, 0.2);
      ctx.fillRect(g.x1, Math.min(g.ye, g.ys), g.x2 - g.x1, Math.abs(g.ys - g.ye));
      stroke(cx.theme === 'dark' ? '#d1d4dc' : '#131722', 1, []);
      seg({ x: g.x1, y: g.ye }, { x: g.x2, y: g.ye }, false);
      if (selected || cx.hoverId === d.id) {
        const mid = (g.x1 + g.x2) / 2;
        const amt = v => (cx.fmtMoney ? cx.fmtMoney(d, v) : '');
        label(cx, [`Target: ${cx.fmtPrice(d.target)} (${fmtPct(st.targetPct)})${amt(d.target)}`], mid, g.yt + (st.dir > 0 ? -4 : 4), UP, '#fff', 'center', st.dir > 0 ? 'bottom' : 'top');
        label(cx, [`Stop: ${cx.fmtPrice(d.stop)} (${fmtPct(st.stopPct)})${amt(d.stop)}`], mid, g.ys + (st.dir > 0 ? 4 : -4), DOWN, '#fff', 'center', st.dir > 0 ? 'top' : 'bottom');
        label(cx, [`${d.type === 'long' ? 'Long' : 'Short'} · Risk/Reward ${st.rr.toFixed(2)}`], mid, g.ye, cx.theme === 'dark' ? '#363a45' : '#131722', '#fff');
      }
      G.handles.push({ x: g.x1, y: g.ye, idx: 0 }, { x: g.x1, y: g.yt, idx: 'target' }, { x: g.x1, y: g.ys, idx: 'stop' }, { x: g.x2, y: g.ye, idx: 'end' });
      break;
    }
    case 'text': {
      const p = P[0];
      if (!ok(p)) return;
      const m = textMetrics(cx, d);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      m.lines.forEach((l, i) => ctx.fillText(l, p.x, p.y + i * m.size * 1.3));
      box(p.x - 4, p.y - 4, m.w + 8, m.h + 6);
      if (selected) { stroke(col, 1, [3, 3]); ctx.strokeRect(p.x - 4, p.y - 4, m.w + 8, m.h + 6); }
      break;
    }
    case 'note':
    case 'callout': {
      const anchor = P[0], at = d.type === 'callout' ? P[1] : P[0];
      if (!ok(anchor) || !ok(at)) return;
      const m = textMetrics(cx, { ...d, size: d.size || 13, text: d.text || (d.type === 'note' ? 'Note' : 'Callout') });
      const w = m.w + 16, hh = m.h + 10;
      const bx = d.type === 'note' ? at.x + 10 : at.x - w / 2, by = d.type === 'note' ? at.y - hh - 10 : at.y - hh / 2;
      if (d.type === 'callout') { stroke(col, 1.5, []); seg(anchor, { x: clamp(anchor.x, bx, bx + w), y: clamp(anchor.y, by, by + hh) }); ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); stroke(col, 1, []); seg(anchor, { x: bx, y: by + hh }, false); }
      ctx.fillStyle = cx.theme === 'dark' ? '#1e222d' : '#ffffff';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, hh, 5) : ctx.rect(bx, by, w, hh); ctx.fill();
      stroke(col, 1.5, []); ctx.stroke();
      ctx.font = `${m.size}px ${FONT}`; ctx.fillStyle = cx.theme === 'dark' ? '#d1d4dc' : '#131722'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      m.lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 5 + i * m.size * 1.3));
      box(bx, by, w, hh);
      G.discs.push({ x: anchor.x, y: anchor.y, rx: 6, ry: 6 });
      handle(anchor, 0); if (d.type === 'callout') handle(at, 1);
      break;
    }
    case 'pricelabel': {
      const p = P[0];
      if (!ok(p)) return;
      const t = cx.fmtPrice(d.pts[0].price);
      ctx.font = `12px ${FONT}`;
      const w = ctx.measureText(t).width + 14, hh = 20, bx = p.x + 8, by = p.y - hh - 6;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(bx + 4, by + hh); ctx.lineTo(bx + 14, by + hh); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, hh, 4) : ctx.rect(bx, by, w, hh); ctx.fill();
      text(t, bx + w / 2, by + hh / 2, '#fff');
      box(bx, by, w, hh); G.discs.push({ x: p.x, y: p.y, rx: 5, ry: 5 });
      handle(p, 0);
      break;
    }
    case 'flag': {
      const p = P[0];
      if (!ok(p)) return;
      stroke(col, 2, []); seg({ x: p.x, y: p.y }, { x: p.x, y: p.y - 26 }, false);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 26); ctx.lineTo(p.x + 18, p.y - 26); ctx.lineTo(p.x + 13, p.y - 20); ctx.lineTo(p.x + 18, p.y - 14); ctx.lineTo(p.x, p.y - 14); ctx.closePath(); ctx.fill();
      if (d.text) text(d.text, p.x + 22, p.y - 20, col, 'left', 'middle', `12px ${FONT}`);
      box(p.x - 3, p.y - 28, 24, 30);
      break;
    }
    case 'arrowup':
    case 'arrowdown': {
      const p = P[0];
      if (!ok(p)) return;
      const upward = d.type === 'arrowup', c = d.color || (upward ? UP : DOWN), s = (d.size || 14) / 14;
      const tip = { x: p.x, y: p.y + (upward ? 4 : -4) }, dir = upward ? 1 : -1;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + 9 * s, tip.y + 11 * s * dir); ctx.lineTo(tip.x + 4 * s, tip.y + 11 * s * dir); ctx.lineTo(tip.x + 4 * s, tip.y + 24 * s * dir);
      ctx.lineTo(tip.x - 4 * s, tip.y + 24 * s * dir); ctx.lineTo(tip.x - 4 * s, tip.y + 11 * s * dir); ctx.lineTo(tip.x - 9 * s, tip.y + 11 * s * dir);
      ctx.closePath(); ctx.fill();
      if (d.text) text(d.text, tip.x, tip.y + (24 * s + 4) * dir, c, 'center', upward ? 'top' : 'bottom', `12px ${FONT}`);
      box(tip.x - 10 * s, Math.min(tip.y, tip.y + 24 * s * dir), 20 * s, 24 * s);
      break;
    }
    case 'icon': {
      const p = P[0];
      if (!ok(p)) return;
      const size = d.size || 26;
      ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.icon || '⭐', p.x, p.y);
      box(p.x - size * 0.6, p.y - size * 0.6, size * 1.2, size * 1.2);
      if (selected) { stroke(col, 1, [3, 3]); ctx.strokeRect(p.x - size * 0.6, p.y - size * 0.6, size * 1.2, size * 1.2); }
      break;
    }
  }
  ctx.setLineDash([]);
  if (selected) {
    ctx.lineWidth = 1.5;
    for (const p of G.handles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = cx.theme === 'dark' ? '#131722' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.stroke();
    }
    if (d.locked) text('🔒', (G.handles[0]?.x ?? P[0]?.x ?? 0) + 10, (G.handles[0]?.y ?? P[0]?.y ?? 0) - 10, col, 'left', 'bottom', `11px ${FONT}`);
  }
}

function distSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

/** Returns { handle } (point index, 'stop' | 'target' | 'end', or -1 for the whole shape) or null. Uses the geometry recorded by the last paint. */
export function hitDrawing(cx, d, x, y) {
  if (d.hidden) return null;
  const G = cx.geom?.get(d);
  if (!G) return null;
  const T = 6;
  for (const p of G.handles) if (Math.hypot(x - p.x, y - p.y) <= 7) return { handle: p.idx };
  if (d.type === 'long' || d.type === 'short') {
    const g = positionGeom(cx, d);
    if (!g) return null;
    const top = Math.min(g.ys, g.yt), bot = Math.max(g.ys, g.yt);
    if (x >= g.x1 && x <= g.x2 && y >= top && y <= bot) return { handle: -1 };
    if (x >= g.x1 && x <= g.x2 && (Math.abs(y - g.ys) <= T || Math.abs(y - g.yt) <= T)) return { handle: Math.abs(y - g.ys) <= T ? 'stop' : 'target' };
    return null;
  }
  const tol = T + (G.tol || (d.width || 2) / 2);
  for (const [a, b] of G.segs) if (distSeg(x, y, a, b) <= tol) return { handle: -1 };
  for (const r of G.rects) if (x >= r.x - T && x <= r.x + r.w + T && y >= r.y - T && y <= r.y + r.h + T) return { handle: -1 };
  for (const p of G.polys) if (inPoly(x, y, p)) return { handle: -1 };
  for (const c of G.rings) if (Math.abs(Math.hypot(x - c.x, y - c.y) - c.r) <= T) return { handle: -1 };
  for (const e of G.discs) if (((x - e.x) / Math.max(e.rx, 1)) ** 2 + ((y - e.y) / Math.max(e.ry, 1)) ** 2 <= 1.05) return { handle: -1 };
  return null;
}

/** Apply a drag to drawing `d` (mutates). `orig` is a deep copy taken at drag start. */
export function dragDrawing(cx, d, drag, cur) {
  const { handle, start, orig } = drag;
  if (handle === 'stop') { d.stop = cur.price; return; }
  if (handle === 'target') { d.target = cur.price; return; }
  if (handle === 'end') { if (cur.time > d.pts[0].time) d.endTime = cur.time; return; }
  if (typeof handle === 'number' && handle >= 0) {
    if (d.type === 'long' || d.type === 'short') {
      const dp = cur.price - orig.pts[0].price;
      d.pts[0] = { time: cur.time, price: cur.price };
      d.stop = orig.stop + dp; d.target = orig.target + dp;
      d.endTime = orig.endTime + (cur.time - orig.pts[0].time);
      return;
    }
    d.pts[handle] = cur;
    return;
  }
  if (d.type === 'brush' || d.type === 'highlighter') { // keep the stroke's shape: shift every sample by the same time/price offset
    const dt = cur.time - start.time, dp = cur.price - start.price;
    d.pts = orig.pts.map(p => ({ time: p.time + dt, price: p.price + dp }));
    return;
  }
  const dl = cx.timeToLogical(cur.time) - cx.timeToLogical(start.time);
  const dp = cur.price - start.price;
  const shift = t => cx.logicalToTime(cx.timeToLogical(t) + dl);
  d.pts = orig.pts.map(p => ({ time: shift(p.time), price: p.price + dp }));
  if (orig.stop != null) { d.stop = orig.stop + dp; d.target = orig.target + dp; d.endTime = shift(orig.endTime); }
}

/** Copy of a drawing moved `bars` to the right (Clone). */
export function cloneDrawing(cx, d, newId, bars = 3) {
  const c = structuredClone(d);
  c.id = newId;
  delete c.locked;
  const shift = t => cx.logicalToTime(cx.timeToLogical(t) + bars);
  c.pts = c.pts.map(p => ({ time: shift(p.time), price: p.price }));
  if (c.endTime != null) c.endTime = shift(c.endTime);
  return c;
}
