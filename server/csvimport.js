// Import 1-minute candles exported from Dukascopy (or any compatible CSV) into the local cache.
//
// Recognised layouts (auto-detected):
//   Dukascopy web export  "Gmt time,Open,High,Low,Close,Volume"  01.01.2025 00:00:00.000,…
//                         "Local time,…"  01.01.2025 02:00:00.000 GMT+0200,…  (offset honoured per row)
//   dukascopy-node CSV    "timestamp,open,high,low,close,volume"  1735689600000,…
//   ISO / generic         "time,open,high,low,close[,volume]"     2025-01-01T00:00:00Z,…
//   MetaTrader            2025.01.01,00:00,o,h,l,c,v              (no header)
// Rows without an explicit offset are interpreted in the chosen timezone (UTC by default; 'EET' =
// Eastern European Time with DST, which some Dukascopy exports use). Everything is stored in UTC.

import { bySymbol } from './catalog.js';
import { readMonth, writeMinutes, ymOf } from './storage.js';
import { assertPlausible } from './s3source.js';

const zoneFmt = {};
function zoneOffsetSec(t, zone) {
  const fmt = (zoneFmt[zone] ||= new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }));
  const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - t;
}
/** Convert a wall-clock time (seconds, as if UTC) in `tz` to real UTC seconds. */
function wallToUtc(wall, tz) {
  if (tz === 'UTC') return wall;
  if (/^[+-]?\d+$/.test(String(tz))) return wall - Number(tz) * 60;
  const zone = tz === 'EET' ? 'Europe/Athens' : tz;
  let t = wall - zoneOffsetSec(wall, zone);
  t = wall - zoneOffsetSec(t, zone); // second pass settles DST edges
  return t;
}

const reDuka = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*GMT([+-])(\d{2}):?(\d{2}))?$/;
const reIso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const reMtDate = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/;
const reMtTime = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseTime(text, tz) {
  const s = text.trim().replace(/^"|"$/g, '');
  if (/^\d{9,13}$/.test(s)) { const n = Number(s); return n > 1e11 ? Math.floor(n / 1000) : n; }
  let m = reDuka.exec(s);
  if (m) {
    const wall = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) / 1000;
    if (m[7]) return wall - (m[7] === '-' ? -1 : 1) * (+m[8] * 3600 + +m[9] * 60);
    return wallToUtc(wall, tz);
  }
  m = reIso.exec(s);
  if (m) {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
    if (m[7] === 'Z') return wall;
    if (m[7]) { const sign = m[7][0] === '-' ? -1 : 1; const d = m[7].replace(/[+:-]/g, ''); return wall - sign * (+d.slice(0, 2) * 3600 + +d.slice(2) * 60); }
    return wallToUtc(wall, tz);
  }
  return null;
}

export async function importCsv({ symbol, text, tz = 'UTC', side = 'bid' }) {
  const spec = bySymbol[symbol];
  if (!spec || spec.provider !== 'dukascopy') throw new Error(`Unknown or non-Dukascopy symbol: ${symbol}`);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('The file is empty');
  const delim = [',', ';', '\t'].map(d => [d, lines[0].split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const head = lines[0].split(delim).map(x => x.trim().replace(/^"|"$/g, '').toLowerCase());
  const hasHeader = head.some(h => /open|close|time|date/.test(h));

  let col;
  if (hasHeader) {
    const find = re => head.findIndex(h => re.test(h));
    col = { time: find(/time|date|timestamp/), open: find(/^open/), high: find(/^high/), low: find(/^low/), close: find(/^close/), volume: find(/vol/) };
    // Newer Dukascopy exports name the time column after the timezone ("Etc/UTC", "Europe/London", "GMT")
    if (col.time < 0 && /^[a-z_]+(\/[a-z_+\-0-9]+)*$/i.test(head[0]) && ![col.open, col.high, col.low, col.close].includes(0)) col.time = 0;
    if ([col.time, col.open, col.high, col.low, col.close].some(i => i < 0)) {
      throw new Error(`Unrecognised header: "${lines[0]}". Expected time/open/high/low/close columns.`);
    }
  }
  const body = hasHeader ? lines.slice(1) : lines;
  const rows = [];
  let skipped = 0, flats = 0, firstBad = null;
  for (const line of body) {
    const f = line.split(delim);
    let t, o, h, l, c, v;
    if (col) {
      t = parseTime(f[col.time] || '', tz);
      [o, h, l, c] = [col.open, col.high, col.low, col.close].map(i => parseFloat(f[i]));
      v = col.volume >= 0 ? parseFloat(f[col.volume]) : NaN;
    } else if (reMtDate.test(f[0]?.trim()) && reMtTime.test(f[1]?.trim())) {
      const d = reMtDate.exec(f[0].trim()), tm = reMtTime.exec(f[1].trim());
      t = wallToUtc(Date.UTC(+d[1], +d[2] - 1, +d[3], +tm[1], +tm[2], +(tm[3] || 0)) / 1000, tz);
      [o, h, l, c, v] = f.slice(2, 7).map(Number);
    } else {
      t = parseTime(f[0] || '', tz);
      [o, h, l, c, v] = f.slice(1, 6).map(Number);
    }
    const ok = t != null && [o, h, l, c].every(Number.isFinite) && h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9 && h >= l;
    if (!ok) { skipped++; firstBad ??= line; continue; }
    // Dukascopy exports pad closed-market periods with flat zero-volume candles; they aren't real trading.
    if (Number.isFinite(v) && v === 0 && o === h && h === l && l === c) { flats++; continue; }
    rows.push([t, o, h, l, c, Number.isFinite(v) ? v : 0, 0]);
  }
  if (!rows.length) throw new Error(`No valid candles found${firstBad ? ` (first rejected line: "${firstBad.slice(0, 120)}")` : ''}.`);
  rows.sort((a, b) => a[0] - b[0]);

  // Timeframe check: we need genuine 1-minute bars.
  const gaps = [];
  for (let i = 1; i < rows.length && gaps.length < 5000; i++) { const d = rows[i][0] - rows[i - 1][0]; if (d > 0) gaps.push(d); }
  gaps.sort((a, b) => a - b);
  const step = gaps[gaps.length >> 1] || 60;
  if (step !== 60) throw new Error(`These candles are ${step / 60}-minute bars. Please export 1-minute (M1) data — higher timeframes are built from it.`);
  if (rows.some(r => r[0] % 60 !== 0)) throw new Error('Timestamps are not aligned to whole minutes — check the timezone setting.');

  assertPlausible(rows, spec);

  let written;
  if (side === 'ask') {
    // Ask-side file: compute the real spread against bid minutes already in the cache.
    const spreadRows = [];
    let matched = 0;
    const cache = new Map();
    for (const r of rows) {
      const ym = ymOf(r[0]);
      if (!cache.has(ym)) cache.set(ym, new Map(readMonth(symbol, 'm1', ym).map(b => [b[0], b])));
      const bid = cache.get(ym).get(r[0]);
      if (bid) { matched++; spreadRows.push([r[0], 0, 0, 0, 0, 0, Math.max(0, r[4] - bid[4])]); }
    }
    if (!matched) throw new Error('No matching bid minutes found. Import the BID file first, then the ASK file for the same period.');
    written = await writeMinutes(symbol, spreadRows, { source: 'csv-ask', spreadOnly: true });
    return { side, rows: rows.length, matched, written, skipped, flats, from: rows[0][0], to: rows[rows.length - 1][0] };
  }
  written = await writeMinutes(symbol, rows, { source: 'csv' });
  return { side, rows: rows.length, written, skipped, flats, from: rows[0][0], to: rows[rows.length - 1][0] };
}
