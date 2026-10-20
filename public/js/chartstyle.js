// Candle / chart appearance shared by every chart view, the volume indicator and the settings dialog.

export const PRESETS = {
  classic: { name: 'Classic', up: '#089981', down: '#f23645' },
  vivid: { name: 'Vivid', up: '#26a69a', down: '#ef5350' },
  ocean: { name: 'Ocean', up: '#2962ff', down: '#ff9800' },
  emerald: { name: 'Emerald', up: '#22c55e', down: '#e11d48' },
  mono: { name: 'Monochrome', up: '#b2b5be', down: '#5d606b' },
  allWhite: { name: 'All white', up: '#d1d4dc', down: '#d1d4dc' },
  allGrey: { name: 'All grey', up: '#787b86', down: '#787b86' },
};

export const DEFAULT_STYLE = {
  up: PRESETS.classic.up, down: PRESETS.classic.down,
  borderUp: null, borderDown: null, wickUp: null, wickDown: null, // null = same as the body colour
  grid: true, bg: null,                                           // bg null = theme default
  // Symbol
  colorByPrevClose: false, allowBarColor: true, bodyVisible: true, borderVisible: true, wickVisible: true, precision: 'default', timezone: 'UTC',
  // Status line
  showTitle: true, showOhlc: true, showChange: true, showIndTitles: true, showIndValues: true,
  // Scales and lines
  lastPriceLine: true, gridV: true, gridH: true, crosshair: 'normal',
  // Canvas
  gridColor: null, fontSize: 12,
  // Trading, alerts, events
  showTradeLines: true, showQuickTrade: true, showOrderPlus: true, alertPopups: true, alertSound: false, showTradeMarkers: true, showSignals: true,
  showEconEvents: true, econMedium: false,
};

const tzFmt = new Map();
/** Format a UNIX time (seconds) in the chart's display timezone. */
export function fmtChartTime(t, parts) {
  const tz = style.timezone === 'local' ? undefined : style.timezone || 'UTC';
  const key = `${tz}|${parts}`;
  let f = tzFmt.get(key);
  if (!f) {
    const o = { timeZone: tz, hourCycle: 'h23' };
    if (parts === 'full') Object.assign(o, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    else if (parts === 'time') Object.assign(o, { hour: '2-digit', minute: '2-digit' });
    else if (parts === 'seconds') Object.assign(o, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    else if (parts === 'day') Object.assign(o, { day: 'numeric' });
    else if (parts === 'month') Object.assign(o, { month: 'short' });
    else if (parts === 'year') Object.assign(o, { year: 'numeric' });
    else if (parts === 'weekday') Object.assign(o, { weekday: 'long', day: 'numeric', month: 'long' });
    f = new Intl.DateTimeFormat('en-GB', o);
    tzFmt.set(key, f);
  }
  return f.format(new Date(t * 1000));
}

let style = { ...DEFAULT_STYLE };
export const chartStyle = () => style;
export function setChartStyle(s) { style = { ...DEFAULT_STYLE, ...(s || {}) }; return style; }

/** Effective colours with border/wick falling back to the body colour. */
export function candleColors() {
  return {
    up: style.up, down: style.down,
    borderUp: style.borderUp || style.up, borderDown: style.borderDown || style.down,
    wickUp: style.wickUp || style.up, wickDown: style.wickDown || style.down,
  };
}

export function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
