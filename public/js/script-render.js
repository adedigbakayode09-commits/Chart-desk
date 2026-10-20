// Draws what Pine-style script indicators produce beyond plain series: background colours, fills between plots,
// lines, boxes, labels, line fills, polylines and tables. Called from the chart's per-frame overlay pass, so
// everything stays anchored to candle time and price while zooming, scrolling and replaying.
//
// env: { ctx, W, H, timeToX(t), indexToX(i), priceToY(p), barSpacing, from, to }  (from/to = visible bar indexes)

const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
const FONT_PX = { tiny: 10.5, small: 12, normal: 14, large: 18, huge: 26, auto: 12 };
const DASH = { dashed: [6, 4], dotted: [2, 3] };

const fontPx = size => FONT_PX[size] ?? 11;
function setDash(ctx, style, width = 1) {
  const d = DASH[style];
  ctx.setLineDash(d ? d.map(v => v * Math.max(1, width * 0.75)) : []);
}

export function renderScriptOutput(env, res) {
  if (!res) return;
  const { ctx } = env;
  ctx.save();
  if (res.bgcolors?.length) drawBackgrounds(env, res.bgcolors);
  if (res.fills?.length) drawFills(env, res.fills);
  const d = res.drawings;
  if (d) {
    for (const f of d.linefills) drawLinefill(env, f);
    for (const b of d.boxes) drawBox(env, b);
    for (const p of d.polylines) drawPolyline(env, p);
    for (const l of d.lines) drawLine(env, l);
    for (const l of d.labels) drawLabel(env, l);
    for (const t of d.tables) drawTable(env, t);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ bgcolor / fill
function drawBackgrounds(env, layers) {
  const { ctx, H, barSpacing } = env;
  const w = Math.max(1, barSpacing);
  for (const colors of layers) {
    for (let i = Math.max(0, env.from); i <= Math.min(colors.length - 1, env.to); i++) {
      const c = colors[i];
      if (!c) continue;
      const x = env.indexToX(i);
      if (x == null) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x - w / 2, 0, w, H);
    }
  }
}
function drawFills(env, fills) {
  const { ctx } = env;
  for (const f of fills) {
    const val = (s, i) => (s.values ? s.values[i] : s.price);
    for (let i = Math.max(0, env.from - 1); i < Math.min(f.colors.length - 1, env.to + 1); i++) {
      const c = f.colors[i + 1] || f.colors[i];
      if (!c) continue;
      const a0 = val(f.a, i), a1 = val(f.a, i + 1), b0 = val(f.b, i), b1 = val(f.b, i + 1);
      if ([a0, a1, b0, b1].some(v => v == null)) continue;
      const x0 = env.indexToX(i), x1 = env.indexToX(i + 1);
      if (x0 == null || x1 == null) continue;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(x0, env.priceToY(a0)); ctx.lineTo(x1, env.priceToY(a1));
      ctx.lineTo(x1, env.priceToY(b1)); ctx.lineTo(x0, env.priceToY(b0));
      ctx.closePath(); ctx.fill();
    }
  }
}

// ------------------------------------------------------------------ lines / boxes
function lineXY(env, l) {
  let x1 = env.timeToX(l.x1), x2 = env.timeToX(l.x2);
  const y1 = env.priceToY(l.y1), y2 = env.priceToY(l.y2);
  if ([x1, x2, y1, y2].some(v => v == null)) return null;
  let p1 = [x1, y1], p2 = [x2, y2];
  const ext = l.extend;
  if (ext && ext !== 'none') {
    const dx = x2 - x1, dy = y2 - y1;
    const far = 1e5;
    if (Math.abs(dx) < 1e-9) {
      if (ext === 'right' || ext === 'both') p2 = [x2, dy >= 0 ? far : -far];
      if (ext === 'left' || ext === 'both') p1 = [x1, dy >= 0 ? -far : far];
    } else {
      const k = dy / dx, sgn = dx >= 0 ? 1 : -1;
      if (ext === 'right' || ext === 'both') { const xe = sgn > 0 ? env.W + 10 : -10; p2 = [xe, y1 + k * (xe - x1)]; }
      if (ext === 'left' || ext === 'both') { const xs = sgn > 0 ? -10 : env.W + 10; p1 = [xs, y1 + k * (xs - x1)]; }
    }
  }
  return [p1, p2];
}
function drawLine(env, l) {
  if (!l.color) return;
  const pts = lineXY(env, l);
  if (!pts) return;
  const { ctx } = env;
  const [[x1, y1], [x2, y2]] = pts;
  ctx.strokeStyle = l.color;
  ctx.lineWidth = l.width;
  setDash(ctx, l.style, l.width);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  const head = (xa, ya, xb, yb) => {
    const a = Math.atan2(yb - ya, xb - xa), s = 6 + l.width * 2;
    ctx.fillStyle = l.color;
    ctx.beginPath(); ctx.moveTo(xb, yb);
    ctx.lineTo(xb - s * Math.cos(a - 0.45), yb - s * Math.sin(a - 0.45));
    ctx.lineTo(xb - s * Math.cos(a + 0.45), yb - s * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill();
  };
  if (l.style === 'arrow_right' || l.style === 'arrow_both') head(x1, y1, x2, y2);
  if (l.style === 'arrow_left' || l.style === 'arrow_both') head(x2, y2, x1, y1);
}
function drawLinefill(env, f) {
  if (!f.color) return;
  const a = lineXY(env, f.a), b = lineXY(env, f.b);
  if (!a || !b) return;
  const { ctx } = env;
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.moveTo(...a[0]); ctx.lineTo(...a[1]); ctx.lineTo(...b[1]); ctx.lineTo(...b[0]);
  ctx.closePath(); ctx.fill();
}
function drawPolyline(env, p) {
  const { ctx } = env;
  const pts = p.points.map(([t, v]) => [env.timeToX(t), env.priceToY(v)]).filter(([x, y]) => x != null && y != null);
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  if (p.curved && pts.length > 2) {
    for (let k = 1; k < pts.length - 1; k++) { const mx = (pts[k][0] + pts[k + 1][0]) / 2, my = (pts[k][1] + pts[k + 1][1]) / 2; ctx.quadraticCurveTo(pts[k][0], pts[k][1], mx, my); }
    ctx.lineTo(...pts[pts.length - 1]);
  } else for (let k = 1; k < pts.length; k++) ctx.lineTo(...pts[k]);
  if (p.closed) ctx.closePath();
  if (p.fill_color) { ctx.fillStyle = p.fill_color; ctx.fill(); }
  if (p.line_color) { ctx.strokeStyle = p.line_color; ctx.lineWidth = p.line_width; setDash(ctx, p.line_style, p.line_width); ctx.stroke(); ctx.setLineDash([]); }
}
function drawBox(env, b) {
  const { ctx, W } = env;
  let xl = env.timeToX(b.left), xr = env.timeToX(b.right);
  const yt = env.priceToY(b.top), yb = env.priceToY(b.bottom);
  if ([xl, xr, yt, yb].some(v => v == null)) return;
  if (b.extend === 'right' || b.extend === 'both') xr = W + 10;
  if (b.extend === 'left' || b.extend === 'both') xl = -10;
  const x = Math.min(xl, xr), y = Math.min(yt, yb), w = Math.abs(xr - xl), h = Math.abs(yb - yt);
  if (x > W || x + w < 0) return;
  if (b.bgcolor) { ctx.fillStyle = b.bgcolor; ctx.fillRect(x, y, w, h); }
  if (b.border_color && b.border_width > 0) {
    ctx.strokeStyle = b.border_color; ctx.lineWidth = b.border_width;
    setDash(ctx, b.border_style, b.border_width);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }
  if (b.text) {
    const px = fontPx(b.text_size);
    ctx.font = `${px}px ${FONT}`;
    ctx.fillStyle = b.text_color || '#000';
    const lines = b.text.split('\n');
    ctx.textAlign = b.text_halign === 'left' ? 'left' : b.text_halign === 'right' ? 'right' : 'center';
    const tx = b.text_halign === 'left' ? x + 4 : b.text_halign === 'right' ? x + w - 4 : x + w / 2;
    const th = lines.length * px * 1.2;
    let ty = b.text_valign === 'top' ? y + 3 : b.text_valign === 'bottom' ? y + h - th - 3 : y + (h - th) / 2;
    ctx.textBaseline = 'top';
    for (const line of lines) { ctx.fillText(line, tx, ty); ty += px * 1.2; }
  }
}

// ------------------------------------------------------------------ labels
const SHAPES = new Set(['arrowup', 'arrowdown', 'triangleup', 'triangledown', 'circle', 'cross', 'xcross', 'diamond', 'square', 'flag']);
function drawLabel(env, l) {
  const { ctx } = env;
  const x = env.timeToX(l.x), y = env.priceToY(l.y);
  if (x == null || y == null || x < -400 || x > env.W + 400) return;
  const px = fontPx(l.size);
  ctx.font = `600 ${px}px ${FONT}`;
  const lines = l.text ? l.text.split('\n') : [];
  const tw = lines.length ? Math.max(...lines.map(s => ctx.measureText(s).width)) : 0;
  const lh = px * 1.25, th = lines.length * lh;
  const padX = 6, padY = 3, ptr = 5;
  let style = l.style;
  // label positioned relative to bar high/low (yloc.abovebar/belowbar) keeps a small gap from the candle
  const gap = l.yloc === 'abovebar' ? -4 : l.yloc === 'belowbar' ? 4 : 0;
  const cy = y + gap;
  if (SHAPES.has(style)) {
    const s = { tiny: 6, small: 8, normal: 11, large: 15, huge: 20, auto: 8 }[l.size] || 8;
    drawShape(ctx, style, x, cy, s, l.color || '#2962ff');
    if (lines.length) {
      ctx.fillStyle = l.textcolor || l.color || '#2962ff';
      ctx.textAlign = 'center';
      const down = style.endsWith('down');
      ctx.textBaseline = down ? 'bottom' : 'top';
      let ty = down ? cy - s - 2 - th + lh : cy + s + 2;
      for (const line of lines) { ctx.fillText(line, x, ty); ty += lh; }
    }
    return;
  }
  const bw = tw + padX * 2, bh = th + padY * 2;
  let bx, by;
  switch (style) {
    case 'label_up': bx = x - bw / 2; by = cy + ptr; break;
    case 'label_left': bx = x + ptr; by = cy - bh / 2; break;
    case 'label_right': bx = x - ptr - bw; by = cy - bh / 2; break;
    case 'label_lower_left': bx = x; by = cy; break;
    case 'label_lower_right': bx = x - bw; by = cy; break;
    case 'label_upper_left': bx = x; by = cy - bh; break;
    case 'label_upper_right': bx = x - bw; by = cy - bh; break;
    case 'label_center': case 'none': case 'text_outline': bx = x - bw / 2; by = cy - bh / 2; break;
    default: bx = x - bw / 2; by = cy - ptr - bh; // label_down
  }
  if (l.color && style !== 'none' && style !== 'text_outline') {
    ctx.fillStyle = l.color;
    ctx.beginPath();
    roundRect(ctx, bx, by, bw, bh, 3);
    // pointer
    if (style === 'label_down') { ctx.moveTo(x - ptr, by + bh); ctx.lineTo(x, cy); ctx.lineTo(x + ptr, by + bh); }
    else if (style === 'label_up') { ctx.moveTo(x - ptr, by); ctx.lineTo(x, cy); ctx.lineTo(x + ptr, by); }
    else if (style === 'label_left') { ctx.moveTo(bx, cy - ptr); ctx.lineTo(x, cy); ctx.lineTo(bx, cy + ptr); }
    else if (style === 'label_right') { ctx.moveTo(bx + bw, cy - ptr); ctx.lineTo(x, cy); ctx.lineTo(bx + bw, cy + ptr); }
    ctx.fill();
  }
  if (!lines.length) return;
  ctx.fillStyle = l.textcolor || '#fff';
  ctx.textBaseline = 'top';
  const align = l.textalign === 'left' ? 'left' : l.textalign === 'right' ? 'right' : 'center';
  ctx.textAlign = align;
  const tx = align === 'left' ? bx + padX : align === 'right' ? bx + bw - padX : bx + bw / 2;
  let ty = by + padY + (lh - px) / 2;
  if (style === 'text_outline') { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; }
  for (const line of lines) {
    if (style === 'text_outline') ctx.strokeText(line, tx, ty);
    ctx.fillText(line, tx, ty);
    ty += lh;
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
}
function drawShape(ctx, style, x, y, s, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  switch (style) {
    case 'arrowup': case 'triangleup': ctx.moveTo(x, y); ctx.lineTo(x - s / 1.4, y + s); ctx.lineTo(x + s / 1.4, y + s); ctx.closePath(); ctx.fill(); break;
    case 'arrowdown': case 'triangledown': ctx.moveTo(x, y); ctx.lineTo(x - s / 1.4, y - s); ctx.lineTo(x + s / 1.4, y - s); ctx.closePath(); ctx.fill(); break;
    case 'circle': ctx.arc(x, y, s / 2, 0, Math.PI * 2); ctx.fill(); break;
    case 'square': ctx.rect(x - s / 2, y - s / 2, s, s); ctx.fill(); break;
    case 'diamond': ctx.moveTo(x, y - s / 2); ctx.lineTo(x + s / 2, y); ctx.lineTo(x, y + s / 2); ctx.lineTo(x - s / 2, y); ctx.closePath(); ctx.fill(); break;
    case 'cross': ctx.moveTo(x - s / 2, y); ctx.lineTo(x + s / 2, y); ctx.moveTo(x, y - s / 2); ctx.lineTo(x, y + s / 2); ctx.stroke(); break;
    case 'xcross': ctx.moveTo(x - s / 2, y - s / 2); ctx.lineTo(x + s / 2, y + s / 2); ctx.moveTo(x + s / 2, y - s / 2); ctx.lineTo(x - s / 2, y + s / 2); ctx.stroke(); break;
    case 'flag': ctx.moveTo(x, y); ctx.lineTo(x, y - s); ctx.lineTo(x + s * 0.8, y - s * 0.75); ctx.lineTo(x, y - s * 0.5); ctx.fill(); ctx.stroke(); break;
  }
}

// ------------------------------------------------------------------ tables
function drawTable(env, t) {
  const { ctx, W, H } = env;
  if (!t.cells.length) return;
  const cols = Math.max(t.columns, ...t.cells.map(c => c.c + 1)), rows = Math.max(t.rows, ...t.cells.map(c => c.r + 1));
  const grid = new Map(t.cells.map(c => [`${c.c},${c.r}`, c]));
  const merged = new Map(); // "c,r" → [c1, r1] span, plus hidden cells
  const hidden = new Set();
  for (const [c0, r0, c1, r1] of t.merges || []) {
    merged.set(`${c0},${r0}`, [c1, r1]);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) if (c !== c0 || r !== r0) hidden.add(`${c},${r}`);
  }
  const padX = 6, padY = 3;
  const colW = new Array(cols).fill(0), rowH = new Array(rows).fill(0);
  const meas = new Map();
  for (const c of t.cells) {
    if (hidden.has(`${c.c},${c.r}`)) continue;
    const px = fontPx(c.text_size);
    ctx.font = `${px}px ${FONT}`;
    const lines = c.text.split('\n');
    const w = c.width > 0 ? W * c.width / 100 : Math.max(0, ...lines.map(s => ctx.measureText(s).width)) + padX * 2;
    const h = c.height > 0 ? H * c.height / 100 : lines.length * px * 1.25 + padY * 2;
    meas.set(c, { px, lines });
    if (!merged.has(`${c.c},${c.r}`)) { colW[c.c] = Math.max(colW[c.c], w); rowH[c.r] = Math.max(rowH[c.r], h); }
  }
  const tw = colW.reduce((a, b) => a + b, 0), th = rowH.reduce((a, b) => a + b, 0);
  if (!tw || !th) return;
  const [v, hpos] = t.position.split('_');
  const m = 10;
  const x0 = hpos === 'left' ? m : hpos === 'center' ? (W - tw) / 2 : W - tw - m;
  const y0 = v === 'top' ? m : v === 'middle' ? (H - th) / 2 : H - th - m - 4;
  const colX = [x0]; for (let k = 0; k < cols; k++) colX.push(colX[k] + colW[k]);
  const rowY = [y0]; for (let k = 0; k < rows; k++) rowY.push(rowY[k] + rowH[k]);
  if (t.bgcolor) { ctx.fillStyle = t.bgcolor; ctx.fillRect(x0, y0, tw, th); }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const key = `${c},${r}`;
    if (hidden.has(key)) continue;
    const cell = grid.get(key);
    const span = merged.get(key);
    const cx = colX[c], cy = rowY[r], cw = colX[span ? span[0] + 1 : c + 1] - cx, ch = rowY[span ? span[1] + 1 : r + 1] - cy;
    if (cell?.bgcolor) { ctx.fillStyle = cell.bgcolor; ctx.fillRect(cx, cy, cw, ch); }
    if (t.border_color && t.border_width > 0) { ctx.strokeStyle = t.border_color; ctx.lineWidth = t.border_width; ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch); }
    if (!cell || !cell.text) continue;
    const { px, lines } = meas.get(cell) || { px: 11, lines: cell.text.split('\n') };
    ctx.font = `${px}px ${FONT}`;
    ctx.fillStyle = cell.text_color || '#000';
    ctx.textBaseline = 'top';
    ctx.textAlign = cell.text_halign === 'left' ? 'left' : cell.text_halign === 'right' ? 'right' : 'center';
    const tx = cell.text_halign === 'left' ? cx + padX : cell.text_halign === 'right' ? cx + cw - padX : cx + cw / 2;
    let ty = cy + (ch - lines.length * px * 1.25) / 2 + px * 0.12;
    for (const line of lines) { ctx.fillText(line, tx, ty); ty += px * 1.25; }
  }
  if (t.frame_color && t.frame_width > 0) { ctx.strokeStyle = t.frame_color; ctx.lineWidth = t.frame_width; ctx.strokeRect(x0 + 0.5, y0 + 0.5, tw, th); }
}
