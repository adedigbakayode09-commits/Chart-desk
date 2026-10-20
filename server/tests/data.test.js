import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { lzma } from '@napi-rs/lzma';

process.env.CHARTDESK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chartdesk-test-'));
const { bucketOf, aggregate, nyOffset } = await import('../../public/js/core/sessions.js');
const { decodeTicks, ticksToMinutes, assertPlausible } = await import('../s3source.js');
const { importCsv } = await import('../csvimport.js');
const { getBars, rangeOhlc, coverage } = await import('../storage.js');
const { bySymbol } = await import('../catalog.js');

const T = iso => Date.parse(iso) / 1000;

test('New York offset follows DST', () => {
  assert.equal(nyOffset(T('2025-01-15T12:00:00Z')), -5 * 3600);
  assert.equal(nyOffset(T('2025-07-15T12:00:00Z')), -4 * 3600);
});

test('FX daily bars roll at 17:00 New York in winter and summer', () => {
  // Winter: 17:00 NY = 22:00 UTC. Sunday 2025-01-05 22:00 UTC opens Monday 2025-01-06.
  assert.equal(bucketOf(T('2025-01-05T22:00:00Z'), '1d', 'fx'), T('2025-01-06T00:00:00Z'));
  assert.equal(bucketOf(T('2025-01-06T21:59:00Z'), '1d', 'fx'), T('2025-01-06T00:00:00Z'));
  assert.equal(bucketOf(T('2025-01-06T22:00:00Z'), '1d', 'fx'), T('2025-01-07T00:00:00Z'));
  // Summer: 17:00 NY = 21:00 UTC.
  assert.equal(bucketOf(T('2025-07-07T20:59:00Z'), '1d', 'fx'), T('2025-07-07T00:00:00Z'));
  assert.equal(bucketOf(T('2025-07-07T21:00:00Z'), '1d', 'fx'), T('2025-07-08T00:00:00Z'));
  // Crypto uses UTC days.
  assert.equal(bucketOf(T('2025-07-07T21:00:00Z'), '1d', 'crypto'), T('2025-07-07T00:00:00Z'));
});

test('4h bars are anchored to the session open; weekly bars start Monday; monthly by trading date', () => {
  assert.equal(bucketOf(T('2025-01-06T23:30:00Z'), '4h', 'fx'), T('2025-01-06T22:00:00Z'));
  assert.equal(bucketOf(T('2025-01-07T02:10:00Z'), '4h', 'fx'), T('2025-01-07T02:00:00Z'));
  assert.equal(bucketOf(T('2025-07-08T00:10:00Z'), '4h', 'fx'), T('2025-07-07T21:00:00Z'));
  assert.equal(bucketOf(T('2025-01-05T22:30:00Z'), '1w', 'fx'), T('2025-01-06T00:00:00Z')); // Sunday open → week of Mon 6th
  assert.equal(bucketOf(T('2025-01-10T21:00:00Z'), '1w', 'fx'), T('2025-01-06T00:00:00Z'));
  assert.equal(bucketOf(T('2025-01-31T23:00:00Z'), '1M', 'fx'), T('2025-02-01T00:00:00Z')); // after NY close → Feb trading day
  assert.equal(bucketOf(T('2025-01-31T20:00:00Z'), '1M', 'fx'), T('2025-01-01T00:00:00Z'));
});

test('aggregate keeps true OHLC, volume sum, mean spread and the first underlying time', () => {
  const rows = [
    [T('2025-01-06T10:00:00Z'), 10, 12, 9, 11, 1, 0.2],
    [T('2025-01-06T10:01:00Z'), 11, 15, 10, 14, 2, 0.4],
    [T('2025-01-06T10:05:00Z'), 14, 14, 8, 9, 3, 0.3],
  ];
  const out = aggregate(rows, '5m', 'fx');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].slice(0, 6), [T('2025-01-06T10:00:00Z'), 10, 15, 9, 14, 3]);
  assert.ok(Math.abs(out[0][6] - 0.3) < 1e-12);
  assert.equal(out[0][7], rows[0][0]);
});

test('bi5 tick decoding and minute building', () => {
  const recs = Buffer.alloc(20 * 3);
  const put = (i, ms, ask, bid, av, bv) => { recs.writeUInt32BE(ms, i * 20); recs.writeUInt32BE(ask, i * 20 + 4); recs.writeUInt32BE(bid, i * 20 + 8); recs.writeFloatBE(av, i * 20 + 12); recs.writeFloatBE(bv, i * 20 + 16); };
  put(0, 1000, 2625800, 2625500, 1, 1);   // 00:00:01 bid 2625.500 ask 2625.800
  put(1, 30000, 2626300, 2626000, 0.5, 0.5);
  put(2, 61000, 2624900, 2624600, 2, 1);  // next minute
  const file = Buffer.from(lzma.compressSync(recs));
  const day = Date.UTC(2025, 0, 2);
  const ticks = decodeTicks(file, day, 1000);
  assert.equal(ticks[0].bid, 2625.5);
  assert.equal(ticks[0].ask, 2625.8);
  const m = ticksToMinutes(ticks);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].slice(0, 6), [day / 1000, 2625.5, 2626, 2625.5, 2626, 3]);
  assert.ok(Math.abs(m[0][6] - 0.3) < 1e-9);
  assert.throws(() => assertPlausible(m.map(r => r.map((v, i) => (i >= 1 && i <= 4 ? v / 100 : v))), bySymbol.XAUUSD), /outside the expected/);
});

test('CSV import (Dukascopy GMT format), flats dropped, paging and replay range', async () => {
  const lines = ['Gmt time,Open,High,Low,Close,Volume'];
  const start = T('2025-01-06T09:58:00Z');
  for (let i = 0; i < 125; i++) {
    const t = new Date((start + i * 60) * 1000);
    const p = n => String(n).padStart(2, '0');
    const stamp = `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00.000`;
    const o = 2600 + i * 0.1;
    lines.push(`${stamp},${o.toFixed(3)},${(o + 0.5).toFixed(3)},${(o - 0.4).toFixed(3)},${(o + 0.1).toFixed(3)},${(10 + i).toFixed(4)}`);
  }
  lines.push('06.01.2025 12:03:00.000,2650,2650,2650,2650,0'); // flat filler
  const res = await importCsv({ symbol: 'XAUUSD', text: lines.join('\n'), tz: 'UTC', side: 'bid' });
  assert.equal(res.rows, 125);
  assert.equal(res.flats, 1);
  assert.equal(coverage('XAUUSD').months.length, 1);

  const m1 = getBars('XAUUSD', '1m', { limit: 10 });
  assert.equal(m1.bars.length, 10);
  assert.equal(m1.bars.at(-1)[0], start + 124 * 60);
  const h = getBars('XAUUSD', '1h', {});
  assert.deepEqual(h.bars.map(b => b[0]), [T('2025-01-06T09:00:00Z'), T('2025-01-06T10:00:00Z'), T('2025-01-06T11:00:00Z'), T('2025-01-06T12:00:00Z')]);
  const fwd = getBars('XAUUSD', '15m', { after: T('2025-01-06T10:30:00Z'), limit: 2 });
  assert.deepEqual(fwd.bars.map(b => b[0]), [T('2025-01-06T10:30:00Z'), T('2025-01-06T10:45:00Z')]);
  const back = getBars('XAUUSD', '15m', { before: T('2025-01-06T10:30:00Z'), limit: 2 });
  assert.deepEqual(back.bars.map(b => b[0]), [T('2025-01-06T10:00:00Z'), T('2025-01-06T10:15:00Z')]);

  const r = rangeOhlc('XAUUSD', T('2025-01-06T10:00:00Z'), T('2025-01-06T10:03:00Z'));
  assert.equal(r.count, 3);
  assert.equal(r.open, 2600.2);

  // Ask file → spread column.
  const ask = lines.slice(0, 4).map((l, i) => (i ? l.replace(/,([\d.]+),([\d.]+),([\d.]+),([\d.]+),/, (_, o, hh, ll, c) => `,${(+o + 0.3).toFixed(3)},${(+hh + 0.3).toFixed(3)},${(+ll + 0.3).toFixed(3)},${(+c + 0.3).toFixed(3)},`) : l));
  const ar = await importCsv({ symbol: 'XAUUSD', text: ask.join('\n'), side: 'ask' });
  assert.equal(ar.matched, 3);
  const withSpread = getBars('XAUUSD', '1m', { after: start, limit: 1 }).bars[0];
  assert.ok(Math.abs(withSpread[6] - 0.3) < 1e-9);
});

test('CSV import rejects non-1-minute data and implausible prices', async () => {
  const hourly = ['timestamp,open,high,low,close,volume', `${T('2025-03-03T10:00:00Z') * 1000},2900,2901,2899,2900.5,5`, `${T('2025-03-03T11:00:00Z') * 1000},2900,2901,2899,2900.5,5`, `${T('2025-03-03T12:00:00Z') * 1000},2900,2901,2899,2900.5,5`];
  await assert.rejects(importCsv({ symbol: 'XAUUSD', text: hourly.join('\n') }), /60-minute bars/);
  const wrong = ['timestamp,open,high,low,close,volume', `${T('2025-03-03T10:00:00Z') * 1000},29.00,29.01,28.99,29.005,5`, `${T('2025-03-03T10:01:00Z') * 1000},29.00,29.01,28.99,29.005,5`];
  await assert.rejects(importCsv({ symbol: 'XAUUSD', text: wrong.join('\n') }), /outside the expected/);
});

test('EET local-time CSV converts to UTC across DST', async () => {
  const text = ['Local time,Open,High,Low,Close,Volume',
    '01.07.2025 03:00:00.000,36.000,36.100,35.900,36.050,1',
    '01.07.2025 03:01:00.000,36.000,36.100,35.900,36.050,1',
    '01.07.2025 03:02:00.000,36.000,36.100,35.900,36.050,1'].join('\n');
  const res = await importCsv({ symbol: 'XAGUSD', text, tz: 'EET' });
  assert.equal(res.from, T('2025-07-01T00:00:00Z')); // EEST = UTC+3 in July
});

test('CSV import: newer Dukascopy export (timezone-named time column, ISO times)', async () => {
  const csv = 'Etc/UTC,Open,High,Low,Close,Volume\n2025-07-11T00:00:00+00:00,3323.505,3325.645,3323.345,3324.765,22440\n2025-07-11T00:01:00+00:00,3324.795,3325.415,3324.405,3324.415,12090\n';
  const r = await importCsv({ symbol: 'XAGUSD', text: csv.replace(/33(\d\d)\./g, '33.$1'), tz: 'UTC' });
  assert.equal(r.written, 2);
  assert.equal(r.from, Date.UTC(2025, 6, 11) / 1000);
});
