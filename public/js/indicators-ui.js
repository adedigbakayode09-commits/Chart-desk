// Indicator catalogue for the chart UI: maths from core/indicators.js, styles for Lightweight Charts.

import * as I from './core/indicators.js';
import { chartStyle, alpha } from './chartstyle.js';
import { getScript } from './scripts.js';

// `cat` groups the Indicators dialog; `steps` marks decimal inputs; `choices` turns an input into a list;
// `fills` shades between two outputs on the overlay ({ a, b, color, down? } — `down` when a < b).
export const IND_DEFS = {
  VOL: { name: 'Volume', short: 'Vol', pane: false, params: {}, cat: 'Volume', desc: 'Volume per bar (tick volume for Dukascopy FX/CFD data)' },
  SMA: { name: 'Moving Average', short: 'MA', pane: false, params: { length: 20 }, cat: 'Moving averages', desc: 'Simple moving average of close' },
  EMA: { name: 'Moving Average Exponential', short: 'EMA', pane: false, params: { length: 50 }, cat: 'Moving averages', desc: 'Exponentially weighted moving average' },
  WMA: { name: 'Moving Average Weighted', short: 'WMA', pane: false, params: { length: 20 }, cat: 'Moving averages', desc: 'Linearly weighted moving average' },
  HMA: { name: 'Hull Moving Average', short: 'HMA', pane: false, params: { length: 21 }, cat: 'Moving averages', desc: 'Fast, smooth moving average with little lag' },
  VWMA: { name: 'Volume Weighted Moving Average', short: 'VWMA', pane: false, params: { length: 20 }, cat: 'Moving averages', desc: 'Moving average weighted by volume' },
  VWAP: { name: 'VWAP (session)', short: 'VWAP', pane: false, params: {}, cat: 'Volume', desc: 'Volume-weighted average price, resets each trading day' },
  SUPERTREND: { name: 'Supertrend', short: 'Supertrend', pane: false, params: { length: 10, mult: 3 }, steps: { mult: 0.1 }, cat: 'Trend', desc: 'ATR trailing line that flips with the trend' },
  PSAR: { name: 'Parabolic SAR', short: 'SAR', pane: false, params: { start: 0.02, inc: 0.02, max: 0.2 }, steps: { start: 0.01, inc: 0.01, max: 0.05 }, cat: 'Trend', desc: 'Stop-and-reverse dots that trail the trend' },
  ICHIMOKU: { name: 'Ichimoku Cloud', short: 'Ichimoku', pane: false, params: { conversion: 9, base: 26, spanB: 52, displacement: 26 }, cat: 'Trend', desc: 'Conversion / base lines, lagging span and the cloud',
    fills: [{ a: 3, b: 4, color: 'rgba(67,160,71,0.14)', down: 'rgba(244,67,54,0.14)' }] },
  BB: { name: 'Bollinger Bands', short: 'BB', pane: false, params: { length: 20, mult: 2 }, steps: { mult: 0.1 }, cat: 'Volatility', desc: 'Volatility bands around an SMA', fills: [{ a: 1, b: 2, color: 'rgba(33,150,243,0.06)' }] },
  KC: { name: 'Keltner Channels', short: 'KC', pane: false, params: { length: 20, mult: 2, atr: 10 }, steps: { mult: 0.1 }, cat: 'Volatility', desc: 'EMA with ATR bands', fills: [{ a: 1, b: 2, color: 'rgba(33,150,243,0.06)' }] },
  DC: { name: 'Donchian Channels', short: 'DC', pane: false, params: { length: 20 }, cat: 'Volatility', desc: 'Highest high and lowest low of the last bars', fills: [{ a: 1, b: 2, color: 'rgba(33,150,243,0.06)' }] },
  PIVOTS: { name: 'Pivot Points Standard', short: 'Pivots', pane: false, params: { type: 'traditional' }, cat: 'Support / resistance', desc: 'Pivot, support and resistance levels from the previous day (week on daily charts)',
    choices: { type: [['traditional', 'Traditional'], ['fibonacci', 'Fibonacci'], ['camarilla', 'Camarilla'], ['woodie', 'Woodie']] } },
  VPVR: { name: 'Volume Profile Visible Range', short: 'VPVR', pane: false, params: { rows: 24, va: 70 }, cat: 'Volume', desc: 'Volume traded at each price over the visible bars, POC and value area' },
  RSI: { name: 'Relative Strength Index', short: 'RSI', pane: true, params: { length: 14 }, cat: 'Momentum', desc: 'Momentum oscillator, 0–100' },
  MACD: { name: 'MACD', short: 'MACD', pane: true, params: { fast: 12, slow: 26, signal: 9 }, cat: 'Momentum', desc: 'Moving average convergence/divergence' },
  STOCH: { name: 'Stochastic', short: 'Stoch', pane: true, params: { k: 14, smooth: 3, d: 3 }, cat: 'Momentum', desc: 'Close relative to recent high/low range' },
  STOCHRSI: { name: 'Stochastic RSI', short: 'Stoch RSI', pane: true, params: { rsi: 14, stoch: 14, k: 3, d: 3 }, cat: 'Momentum', desc: 'Stochastic of the RSI' },
  CCI: { name: 'Commodity Channel Index', short: 'CCI', pane: true, params: { length: 20 }, cat: 'Momentum', desc: 'Distance from the average price in mean deviations' },
  WILLR: { name: 'Williams %R', short: '%R', pane: true, params: { length: 14 }, cat: 'Momentum', desc: 'Close relative to the high/low range, 0 to −100' },
  MOM: { name: 'Momentum', short: 'Mom', pane: true, params: { length: 10 }, cat: 'Momentum', desc: 'Close minus the close n bars ago' },
  ROC: { name: 'Rate Of Change', short: 'ROC', pane: true, params: { length: 9 }, cat: 'Momentum', desc: 'Percent change over n bars' },
  AO: { name: 'Awesome Oscillator', short: 'AO', pane: true, params: {}, cat: 'Momentum', desc: '5 vs 34 period average of the bar midpoints' },
  ADX: { name: 'Directional Movement Index', short: 'DMI', pane: true, params: { di: 14, adx: 14 }, cat: 'Trend strength', desc: 'ADX trend strength with +DI / −DI' },
  AROON: { name: 'Aroon', short: 'Aroon', pane: true, params: { length: 14 }, cat: 'Trend strength', desc: 'Bars since the highest high / lowest low' },
  ATR: { name: 'Average True Range', short: 'ATR', pane: true, params: { length: 14 }, cat: 'Volatility', desc: 'Average bar range (volatility)' },
  STDEV: { name: 'Standard Deviation', short: 'StdDev', pane: true, params: { length: 20 }, cat: 'Volatility', desc: 'Standard deviation of the close' },
  OBV: { name: 'On Balance Volume', short: 'OBV', pane: true, params: {}, cat: 'Volume', desc: 'Running total of up-bar minus down-bar volume' },
  MFI: { name: 'Money Flow Index', short: 'MFI', pane: true, params: { length: 14 }, cat: 'Volume', desc: 'Volume-weighted RSI, 0–100' },
  CMF: { name: 'Chaikin Money Flow', short: 'CMF', pane: true, params: { length: 20 }, cat: 'Volume', desc: 'Buying vs selling pressure from close location and volume' },
};
export const IND_CATEGORIES = ['Moving averages', 'Trend', 'Trend strength', 'Momentum', 'Volatility', 'Volume', 'Support / resistance'];
/** Outputs shown with the chart's price precision (others: 2 decimals, or K/M for volume totals). */
export const PRICE_OUTPUTS = new Set(['ATR', 'STDEV', 'MOM']);

/** Definition for built-in or script indicators ({ name, short, pane, params, desc }). */
export function defOf(ind) {
  if (ind.type !== 'SCRIPT') return IND_DEFS[ind.type];
  const sc = getScript(ind.scriptId);
  const meta = sc?.meta;
  return {
    name: sc?.name || 'Missing script', short: sc?.name || 'Missing script', pane: meta ? !meta.overlay : false,
    params: Object.fromEntries((meta?.inputs || []).map(i => [i.name, i.def])), desc: 'Custom script', script: sc,
  };
}

export function indTitle(ind) {
  const def = defOf(ind);
  const p = Object.values(ind.params);
  if (ind.type === 'SCRIPT' && (p.length > 6 || p.some(v => typeof v === 'string'))) return def.short; // big scripts: name only
  if (ind.type === 'PIVOTS') return `${def.short} ${ind.params.type}`;
  return p.length ? `${def.short} ${p.join(' ')}` : def.short;
}


/**
 * Lightweight Charts joins a line across whitespace points and colours each segment with its *starting* point's
 * colour: making the last point before a gap transparent hides the bridge, so the line really breaks there.
 */
export function breakGaps(points) {
  for (let i = 0; i < points.length - 1; i++) if (points[i].value != null && points[i + 1].value == null) points[i] = { ...points[i], color: 'rgba(0,0,0,0)' };
  return points;
}

/** One data array per series (aligned to bars, whitespace during warm-up). */
export function calc(ind, B, session) {
  const T = B.map(b => b.time), C = B.map(b => b.close), P = ind.params;
  const L = vals => vals.map((v, i) => (v == null || !Number.isFinite(v) ? { time: T[i] } : { time: T[i], value: v }));
  const G = vals => breakGaps(L(vals));
  switch (ind.type) {
    case 'VOL': { const st = chartStyle(), up = alpha(st.up, 0.5), dn = alpha(st.down, 0.5); return [B.map(b => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? up : dn }))]; }
    case 'SMA': return [L(I.sma(C, P.length))];
    case 'EMA': return [L(I.ema(C, P.length))];
    case 'WMA': return [L(I.wma(C, P.length))];
    case 'HMA': return [L(I.hma(C, P.length))];
    case 'VWMA': return [L(I.vwma(B, P.length))];
    case 'BB': { const b = I.bollinger(C, P.length, P.mult); return [L(b.mid), L(b.upper), L(b.lower)]; }
    case 'KC': { const k = I.keltner(B, P.length, P.mult, P.atr); return [L(k.mid), L(k.upper), L(k.lower)]; }
    case 'DC': { const d = I.donchianChannel(B, P.length); return [L(d.basis), L(d.upper), L(d.lower)]; }
    case 'VWAP': return [L(I.vwap(B, session))];
    case 'SUPERTREND': { const s = I.supertrend(B, P.length, P.mult); return [G(s.line.map((v, i) => (s.dir[i] === 1 ? v : null))), G(s.line.map((v, i) => (s.dir[i] === -1 ? v : null)))]; }
    case 'PSAR': return [L(I.psar(B, P.start, P.inc, P.max))];
    case 'ICHIMOKU': {
      const ich = I.ichimoku(B, P.conversion, P.base, P.spanB, P.displacement);
      const iv = B.length > 1 ? T[T.length - 1] - T[T.length - 2] : 3600;
      // the cloud runs `shift` bars past the last candle: give those points future times one interval apart
      const TT = T.concat(Array.from({ length: ich.shift }, (_, k) => T[T.length - 1] + (k + 1) * iv));
      const LL = vals => vals.map((v, i) => (v == null || !Number.isFinite(v) ? { time: TT[i] } : { time: TT[i], value: v }));
      return [L(ich.tenkan), L(ich.kijun), L(ich.lag), LL(ich.leadA), LL(ich.leadB)];
    }
    case 'PIVOTS': {
      const per = I.pivotPeriodOf(B, session), pv = I.pivots(B, P.type, per);
      // break the line where a new period starts, so each period's levels are separate segments
      const cut = B.map((b, i) => i > 0 && per(b) !== per(B[i - 1]));
      return ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3'].map(k => G(pv[k].map((v, i) => (cut[i] ? null : v))));
    }
    case 'VPVR': return []; // drawn on the overlay from the visible bars (ChartView.renderIndicatorOverlays)
    case 'RSI': return [L(I.rsi(C, P.length))];
    case 'MACD': {
      const m = I.macd(C, P.fast, P.slow, P.signal);
      const hist = m.hist.map((v, i) => {
        if (v == null) return { time: T[i] };
        const p = m.hist[i - 1] ?? 0;
        return { time: T[i], value: v, color: v >= 0 ? (v >= p ? '#26a69a' : '#b2dfdb') : (v < p ? '#ff5252' : '#ffcdd2') };
      });
      return [hist, L(m.line), L(m.signal)];
    }
    case 'STOCH': { const s = I.stoch(B, P.k, P.smooth, P.d); return [L(s.k), L(s.d)]; }
    case 'STOCHRSI': { const s = I.stochRsi(C, P.rsi, P.stoch, P.k, P.d); return [L(s.k), L(s.d)]; }
    case 'CCI': return [L(I.cci(B, P.length))];
    case 'WILLR': return [L(I.williamsR(B, P.length))];
    case 'MOM': return [L(I.momentum(C, P.length))];
    case 'ROC': return [L(I.roc(C, P.length))];
    case 'AO': {
      const ao = I.awesome(B);
      return [ao.map((v, i) => (v == null ? { time: T[i] } : { time: T[i], value: v, color: v >= (ao[i - 1] ?? v) ? '#089981' : '#f23645' }))];
    }
    case 'ADX': { const a = I.adx(B, P.di, P.adx); return [L(a.adx), L(a.plus), L(a.minus)]; }
    case 'AROON': { const a = I.aroon(B, P.length); return [L(a.up), L(a.down)]; }
    case 'ATR': return [L(I.atr(B, P.length))];
    case 'STDEV': return [L(I.stdev(C, P.length))];
    case 'OBV': return [L(I.obv(B))];
    case 'MFI': return [L(I.mfi(B, P.length))];
    case 'CMF': { const c = I.cmf(B, P.length); return [c.map((v, i) => (v == null ? { time: T[i] } : { time: T[i], value: v, color: v >= 0 ? 'rgba(8,153,129,0.6)' : 'rgba(242,54,69,0.6)' }))]; }
    case 'SCRIPT': return []; // computed asynchronously in the script worker (ChartView.runScriptRuntime)
  }
  return [];
}

export function seriesSpecs(LC, ind, priceFormat) {
  const col = ind.color || '#2962ff';
  const guide = price => ({ price, color: '#787b86', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
  const osc = { priceFormat: { type: 'price', precision: 2, minMove: 0.01 } };
  const fade = (c, a) => /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c;
  const line = (color, extra = {}) => ({ kind: 'Line', opts: { color, lineWidth: 2, priceFormat, ...extra } });
  const oscLine = (color, extra = {}) => ({ kind: 'Line', opts: { ...osc, color, lineWidth: 2, ...extra } });
  switch (ind.type) {
    case 'VOL': return [{ kind: 'Histogram', opts: { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false } }];
    case 'SMA': case 'EMA': case 'WMA': case 'HMA': case 'VWMA': case 'VWAP': return [line(col)];
    case 'BB': case 'KC': case 'DC': return [
      { kind: 'Line', opts: { color: col, lineWidth: 1, priceFormat } },
      { kind: 'Line', opts: { color: fade(col, 0.75), lineWidth: 1, priceFormat } },
      { kind: 'Line', opts: { color: fade(col, 0.75), lineWidth: 1, priceFormat } },
    ];
    case 'SUPERTREND': return [line('#089981', { crosshairMarkerVisible: false }), line('#f23645', { crosshairMarkerVisible: false })];
    case 'PSAR': return [{ kind: 'Line', opts: { color: ind.color || '#2962ff', lineWidth: 2, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.6, crosshairMarkerVisible: false, lastValueVisible: false, priceFormat } }];
    case 'ICHIMOKU': return [
      line('#2962ff', { lineWidth: 1 }), line('#b71c1c', { lineWidth: 1 }), line('#43a047', { lineWidth: 1, lastValueVisible: false }),
      line('#a5d6a7', { lineWidth: 1 }), line('#ef9a9a', { lineWidth: 1 }),
    ];
    case 'PIVOTS': return ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3'].map(k => line(k === 'P' ? '#ff9800' : k[0] === 'R' ? '#f23645' : '#089981', { lineWidth: 1, title: k, crosshairMarkerVisible: false }));
    case 'VPVR': return [];
    case 'RSI': return [{ ...oscLine(ind.color || '#7e57c2'), lines: [guide(70), guide(50), guide(30)] }];
    case 'MACD': return [
      { kind: 'Histogram', opts: { ...osc } },
      oscLine(ind.color || '#2962ff'),
      oscLine('#ff6d00'),
    ];
    case 'STOCH': case 'STOCHRSI': return [{ ...oscLine(ind.color || '#2962ff'), lines: [guide(80), guide(50), guide(20)] }, oscLine('#ff6d00')];
    case 'CCI': return [{ ...oscLine(ind.color || '#2196f3'), lines: [guide(100), guide(0), guide(-100)] }];
    case 'WILLR': return [{ ...oscLine(ind.color || '#7e57c2'), lines: [guide(-20), guide(-50), guide(-80)] }];
    case 'MOM': return [{ ...line(ind.color || '#2962ff'), lines: [guide(0)] }];
    case 'ROC': return [{ ...oscLine(ind.color || '#2962ff'), lines: [guide(0)] }];
    case 'AO': return [{ kind: 'Histogram', opts: { ...osc, priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } } }];
    case 'ADX': return [oscLine(ind.color || '#ff9800'), oscLine('#089981', { lineWidth: 1 }), oscLine('#f23645', { lineWidth: 1 })];
    case 'AROON': return [oscLine('#ff9800'), oscLine(ind.color || '#2962ff')];
    case 'ATR': return [line(ind.color || '#b71c1c')];
    case 'STDEV': return [line(ind.color || '#2962ff')];
    case 'OBV': return [{ kind: 'Line', opts: { color: ind.color || '#2962ff', lineWidth: 2, priceFormat: { type: 'volume' } } }];
    case 'MFI': return [{ ...oscLine(ind.color || '#7e57c2'), lines: [guide(80), guide(50), guide(20)] }];
    case 'CMF': return [{ kind: 'Histogram', opts: { priceFormat: { type: 'price', precision: 3, minMove: 0.001 } }, lines: [guide(0)] }];
    case 'SCRIPT': {
      const meta = getScript(ind.scriptId)?.meta;
      if (!meta) return [];
      const pf = meta.overlay ? priceFormat : { type: 'price', precision: 4, minMove: 0.0001 };
      const lines = meta.hlines.map(hl => ({ price: hl.price, color: hl.color, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false }));
      return meta.plots.map((p, i) => {
        const base = { priceFormat: pf, title: '' };
        const spec = p.style === 'histogram' ? { kind: 'Histogram', opts: { ...base, color: p.color } }
          : p.style === 'area' ? { kind: 'Area', opts: { ...base, lineColor: p.color, topColor: alpha(p.color, 0.3), bottomColor: alpha(p.color, 0.02), lineWidth: p.width } }
          : p.style === 'candles' ? { kind: 'Candlestick', opts: { ...base, upColor: p.color, downColor: p.color, wickUpColor: p.color, wickDownColor: p.color, borderVisible: true, lastValueVisible: false } }
          : p.style === 'bars' ? { kind: 'Bar', opts: { ...base, upColor: p.color, downColor: p.color, lastValueVisible: false } }
          : p.style === 'points' ? { kind: 'Line', opts: { ...base, color: p.color, lineWidth: p.width, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1 + p.width, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false } }
          : p.style === 'step' ? { kind: 'Line', opts: { ...base, color: p.color, lineWidth: p.width, lineType: 1 } }
          : { kind: 'Line', opts: { ...base, color: p.color, lineWidth: p.width } };
        if (i === 0) spec.lines = lines;
        return spec;
      });
    }
  }
  return [];
}
