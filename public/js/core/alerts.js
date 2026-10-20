// Price-alert trigger logic (pure, no DOM).
//
// Live feeds deliver candles that keep changing while they form. `observe` turns successive versions of a feed's
// latest candle into "what traded since the previous update" ({ lo, hi, last, since }); `evaluate` checks an alert
// against that range. A range is only trusted if it began after the alert's previous check (or its creation) —
// otherwise only the latest price counts, so a high made before the alert existed can never fire it.

export const CONDITIONS = {
  cross: 'Crossing', up: 'Crossing up', down: 'Crossing down', above: 'Greater than', below: 'Less than',
};
export const REPEAT_COOLDOWN_MS = 60e3; // "every time" alerts fire at most once a minute

/**
 * seen: this feed's previous view of its latest candle ({ time, high, low, close, at }) or null; bar: the new version.
 * Returns { upd, seen } — upd is null for a candle older than the one already seen.
 */
export function observe(seen, bar, now) {
  const next = { time: bar.time, high: bar.high, low: bar.low, close: bar.close, at: now };
  if (seen && bar.time < seen.time) return { upd: null, seen };
  if (seen && bar.time === seen.time) {
    // the same forming candle: a new high/low happened since we last looked; otherwise price moved between the closes
    const hi = bar.high > seen.high ? bar.high : Math.max(seen.close, bar.close);
    const lo = bar.low < seen.low ? bar.low : Math.min(seen.close, bar.close);
    return { upd: { lo, hi, last: bar.close, since: seen.at }, seen: next };
  }
  if (seen) {
    // a new candle: all of it traded after our last look (which was inside the previous candle), plus the gap from its last close
    return { upd: { lo: Math.min(bar.low, seen.close), hi: Math.max(bar.high, seen.close), last: bar.close, since: seen.at }, seen: next };
  }
  // first look at this feed: the candle's range covers everything since it opened
  return { upd: { lo: bar.low, hi: bar.high, last: bar.close, since: (bar.start ?? bar.time) * 1000 }, seen: next };
}

/** Would `alert` fire on this update? (`ref` = price at the alert's previous check.) */
export function fires(alert, { lo, hi, last }) {
  const p = alert.price, ref = alert.ref;
  switch (alert.cond) {
    case 'up': return ref != null && ref < p && hi >= p;
    case 'down': return ref != null && ref > p && lo <= p;
    case 'cross': return ref != null && ((ref < p && hi >= p) || (ref > p && lo <= p));
    case 'above': return last > p;
    case 'below': return last < p;
    default: return false;
  }
}

/**
 * Check an alert against one update and move its state on (mutates `alert`). Returns true when it fired.
 * Once-alerts deactivate after firing; every-time alerts stay armed (crossing alerts need a new crossing,
 * greater/less-than alerts wait out the cooldown).
 */
export function evaluate(alert, upd, now) {
  if (!alert.active || !upd) return false;
  const trusted = upd.since >= (alert.checkedAt ?? alert.created);
  const u = trusted ? upd : { lo: upd.last, hi: upd.last, last: upd.last };
  const cooling = alert.repeat && alert.firedAt && now - alert.firedAt < REPEAT_COOLDOWN_MS;
  const hit = !cooling && fires(alert, u);
  alert.ref = upd.last;
  alert.checkedAt = now;
  if (!hit) return false;
  alert.firedAt = now;
  alert.firedPrice = upd.last;
  alert.fireCount = (alert.fireCount || 0) + 1;
  if (!alert.repeat) alert.active = false;
  return true;
}

// ------------------------------------------------------------------ percent-move alerts
export const CHANGE_CONDITIONS = { 'up%': 'Moving up', 'down%': 'Moving down', 'move%': 'Moving up or down' };

/**
 * `ticks`: recent { at (ms), lo, hi, last } observations of a symbol. Fires when price has moved `pct`% from the
 * lowest (up) / highest (down) price seen within the last `windowMin` minutes — counting only prices seen after the
 * alert was armed, so an old move can't fire a new alert.
 */
export function changeFires(alert, ticks, now) {
  const from = Math.max(now - alert.windowMin * 60e3, alert.armedAt ?? alert.created ?? 0);
  let lo = Infinity, hi = -Infinity, last = null;
  for (const t of ticks) { if (t.at < from) continue; lo = Math.min(lo, t.lo); hi = Math.max(hi, t.hi); last = t.last; }
  if (last == null || !Number.isFinite(lo)) return null;
  const up = (last - lo) / lo * 100, down = (hi - last) / hi * 100;
  const hit = alert.cond === 'up%' ? up >= alert.pct : alert.cond === 'down%' ? down >= alert.pct : Math.max(up, down) >= alert.pct;
  return hit ? { last, move: alert.cond === 'down%' || (alert.cond === 'move%' && down > up) ? -down : up } : null;
}

// ------------------------------------------------------------------ indicator alerts (evaluated on closed bars)
/** a / b: the two sides on the previous and the current closed bar. */
export function compareFires(cond, aPrev, aCur, bPrev, bCur) {
  if ([aCur, bCur].some(v => v == null || !Number.isFinite(v))) return false;
  const havePrev = [aPrev, bPrev].every(v => v != null && Number.isFinite(v));
  switch (cond) {
    case 'up': return havePrev && aPrev <= bPrev && aCur > bCur;
    case 'down': return havePrev && aPrev >= bPrev && aCur < bCur;
    case 'cross': return havePrev && ((aPrev <= bPrev && aCur > bCur) || (aPrev >= bPrev && aCur < bCur));
    case 'above': return aCur > bCur;
    case 'below': return aCur < bCur;
    default: return false;
  }
}

// ------------------------------------------------------------------ drawing alerts
/**
 * Price of a drawn line at time t. `toL` maps time → bar position (the chart's own spacing when a chart is open;
 * plain time otherwise). Returns the levels to watch (a channel has two) or [] when t is outside a finite segment.
 */
export function drawingLevels(d, t, toL = x => x) {
  const p = d.pts || [];
  const at = (a, b, x) => { const la = toL(a.time), lb = toL(b.time); return lb === la ? b.price : a.price + (b.price - a.price) * (toL(x) - la) / (lb - la); };
  switch (d.type) {
    case 'hline': return [p[0].price];
    case 'hray': return t >= p[0].time ? [p[0].price] : [];
    case 'ray': return t >= Math.min(p[0].time, p[1].time) ? [at(p[0], p[1], t)] : [];
    case 'extline': return [at(p[0], p[1], t)];
    case 'trend': case 'arrow': case 'infoline': {
      const ext = d.type === 'trend' ? d.extend || 'none' : 'none', lo = Math.min(p[0].time, p[1].time), hi = Math.max(p[0].time, p[1].time);
      if ((t < lo && ext !== 'left' && ext !== 'both') || (t > hi && ext !== 'right' && ext !== 'both')) return [];
      return [at(p[0], p[1], t)];
    }
    case 'channel': {
      if (p.length < 3) return [at(p[0], p[1], t)];
      const off = p[2].price - at(p[0], p[1], p[2].time);
      return [at(p[0], p[1], t), at(p[0], p[1], t) + off];
    }
    default: return [];
  }
}
export const DRAWING_ALERT_TYPES = new Set(['hline', 'hray', 'ray', 'extline', 'trend', 'arrow', 'infoline', 'channel']);

// ------------------------------------------------------------------ shared alert wording (panel, pop-ups, webhooks)
export const fmtWindow = m => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);
/** "Close" / "30" / "RSI 14" (· line name when the indicator has several). */
export function sideText(side, a, names = []) {
  if (!side || side.k === 'close') return 'Close';
  if (side.k === 'value') return String(side.v);
  return `${a.indLabel || a.ind?.type || 'Indicator'}${names.length > 1 ? ` ${names[side.i] || ''}` : ''}`;
}
export function alertText(a, prec = 2, names = []) {
  const f = v => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: prec, maximumFractionDigits: prec }));
  const cond = (CONDITIONS[a.cond] || a.cond || '').toLowerCase();
  switch (a.kind || 'price') {
    case 'change': return `${a.symbol} ${(CHANGE_CONDITIONS[a.cond] || '').toLowerCase()} ${a.pct}% within ${fmtWindow(a.windowMin)}`;
    case 'indicator': return `${a.symbol} ${a.tfLabel || a.tf} · ${sideText(a.left, a, names)} ${cond} ${sideText(a.right, a, names)} (bar close)`;
    case 'drawing': return `${a.symbol} ${cond} ${a.drawingLabel || 'drawn line'}`;
    default: return `${a.symbol} ${cond} ${f(a.price)}`;
  }
}
/** An alert is armed unless paused, or a once-alert that already fired since it was (re)armed. */
export const armedAt = a => a.armedAt ?? a.created ?? 0;
export const isArmed = (a, st) => a.active !== false && !(st && !a.repeat && st.firedFor === armedAt(a));
