// Session-aware OHLC aggregation.
//
// Rows are arrays: [time, open, high, low, close, volume, spread] with time = bar open in UTC seconds.
// Aggregated rows append `start` (the first underlying timestamp) so replay can rebuild a partial bar:
// [time(label), open, high, low, close, volume, avgSpread, start].
//
// Session model
//  - 'fx' (forex, metals, index CFDs): the trading day rolls over at 17:00 America/New_York (DST-aware),
//    the industry convention used by FX/CFD data feeds. Daily bars are labelled with the trading
//    date (00:00 UTC of that date); a Sunday-evening open belongs to Monday's session. 2h/4h bars are
//    anchored to the session open; <=1h bars sit on the UTC clock grid (the session opens on the hour).
//  - 'crypto': 24/7, UTC day boundaries.
// Weekends/holidays need no calendar table: Dukascopy has no ticks then, so those minutes never exist.

export const TF = {
  '1m': { sec: 60, base: 'm1' },
  '3m': { sec: 180, base: 'm1' },
  '5m': { sec: 300, base: 'm1' },
  '15m': { sec: 900, base: 'm1' },
  '30m': { sec: 1800, base: 'm1' },
  '1h': { sec: 3600, base: 'h1' },
  '2h': { sec: 7200, base: 'h1', anchored: true },
  '4h': { sec: 14400, base: 'h1', anchored: true },
  '1d': { sec: 86400, base: 'h1', unit: 'day' },
  '1w': { sec: 604800, base: 'h1', unit: 'week' },
  '1M': { sec: 2592000, base: 'h1', unit: 'month' },
};

/** Builds a cached `t => seconds to add to a UTC timestamp to get the wall-clock time in an IANA zone` (DST-aware). */
function zoneOffset(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const cache = new Map();
  return t => {
    const hourKey = Math.floor(t / 3600);
    let off = cache.get(hourKey);
    if (off === undefined) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(hourKey * 3600000)).map(x => [x.type, x.value]));
      const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
      off = wall - hourKey * 3600;
      if (cache.size > 200000) cache.clear();
      cache.set(hourKey, off);
    }
    return off;
  };
}
/** Seconds to add to a UTC timestamp to get New York wall-clock time (negative: -4h or -5h). */
export const nyOffset = zoneOffset('America/New_York');
/** Seconds to add to a UTC timestamp to get London wall-clock time (0 or +1h). */
export const londonOffset = zoneOffset('Europe/London');

const DAY = 86400;
const SESSION_SHIFT = 7 * 3600; // 17:00 NY + 7h = next calendar day 00:00 → trading date

/** Trading date (days since epoch) of timestamp t. */
export function sessionDay(t, session) {
  if (session === 'crypto') return Math.floor(t / DAY);
  return Math.floor((t + nyOffset(t) + SESSION_SHIFT) / DAY);
}

/** Bucket label (UTC seconds) for timestamp t on timeframe tf. */
export function bucketOf(t, tf, session) {
  const spec = TF[tf];
  if (spec.unit === 'day') return sessionDay(t, session) * DAY;
  if (spec.unit === 'week') {
    const d = sessionDay(t, session);
    const weekday = (d + 3) % 7; // 1970-01-01 was a Thursday → Monday = 0
    return (d - weekday) * DAY;
  }
  if (spec.unit === 'month') {
    const dt = new Date(sessionDay(t, session) * DAY * 1000);
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / 1000;
  }
  if (spec.anchored && session !== 'crypto') {
    const local = t + nyOffset(t) + SESSION_SHIFT;
    const intoSession = ((local % DAY) + DAY) % DAY;
    const sessionOpen = t - intoSession;
    return sessionOpen + Math.floor(intoSession / spec.sec) * spec.sec;
  }
  return Math.floor(t / spec.sec) * spec.sec;
}

/** Aggregate base rows (sorted by time) into tf rows. */
export function aggregate(rows, tf, session) {
  const out = [];
  let cur = null, key = null, spreadSum = 0, n = 0;
  for (const r of rows) {
    const k = bucketOf(r[0], tf, session);
    if (k !== key) {
      if (cur) { cur[6] = spreadSum / n; out.push(cur); }
      key = k;
      cur = [k, r[1], r[2], r[3], r[4], r[5], 0, r[0]];
      spreadSum = r[6]; n = 1;
    } else {
      if (r[2] > cur[2]) cur[2] = r[2];
      if (r[3] < cur[3]) cur[3] = r[3];
      cur[4] = r[4];
      cur[5] += r[5];
      spreadSum += r[6]; n++;
    }
  }
  if (cur) { cur[6] = spreadSum / n; out.push(cur); }
  return out;
}

/**
 * Market time: seconds the market has been open before t. FX / metals / index CFDs drop each weekend (Friday 17:00 →
 * Sunday 17:00 New York), crypto never closes. Used to project drawn lines the way a chart spaces its bars.
 */
export function marketTime(t, session) {
  if (session === 'crypto') return t;
  const WEEK = 7 * DAY, OPEN = 5 * DAY, SUN17 = 3 * DAY + 17 * 3600; // 1970-01-04 was a Sunday
  const x = t + nyOffset(t) - SUN17, w = Math.floor(x / WEEK);
  return w * OPEN + Math.min(x - w * WEEK, OPEN);
}
