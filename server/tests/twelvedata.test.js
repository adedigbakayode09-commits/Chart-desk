import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.CHARTDESK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'chartdesk-td-'));
delete process.env.TWELVE_DATA_API_KEY;
const td = await import('../twelvedata.js');
td._setSleepForTests(async () => {});

// ---------------------------------------------------------------- fake Twelve Data
const calls = [];
let plan = 'Basic';
let xauRequired = 'Basic';
let rateLimitOnce = false;
let dailyUsage = 10;
const T0 = Date.UTC(2026, 8, 1) / 1000; // series of 1h candles start
const N = 12000;                         // 12k hourly candles available in "history"
const SEC = { '1min': 60, '1h': 3600, '1day': 86400 };
function candle(t, i) {
  const p = 2500 + Math.sin(i / 30) * 20 + i * 0.01;
  return { datetime: new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' '), open: p.toFixed(2), high: (p + 1.5).toFixed(2), low: (p - 1.25).toFixed(2), close: (p + 0.4).toFixed(2) };
}
// Candle open times on a real trading calendar (no weekend / daily-break candles).
const calCache = {};
function calendar(sec) {
  if (!calCache[sec]) { const all = []; for (let t = T0; all.length < N; t += sec) if (!td.marketClosedBar('XAUUSD', t, sec)) all.push(t); calCache[sec] = all; }
  return calCache[sec];
}
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: opts.headers?.Authorization });
  if (u.pathname === '/api_usage') return reply({ timestamp: '2026-10-12 20:00:00', current_usage: 1, plan_limit: 1000, daily_usage: dailyUsage, plan_daily_limit: 800, plan_category: plan.toLowerCase() });
  if (u.pathname === '/symbol_search') {
    const sym = u.searchParams.get('symbol');
    const req = sym === 'XAU/USD' ? xauRequired : 'Basic';
    return reply({ data: [
      { symbol: sym, instrument_name: `${sym} spot`, exchange: sym === 'XAU/USD' ? 'COMMODITY' : 'PHYSICAL CURRENCY', instrument_type: sym === 'XAU/USD' ? 'Precious Metal' : 'Physical Currency', access: { global: req, plan: req } },
      { symbol: sym, instrument_name: 'Some warrant', exchange: 'MTA', instrument_type: 'Warrant', access: { global: 'Pro', plan: 'Pro' } },
    ] });
  }
  if (u.pathname === '/earliest_timestamp') {
    // 1-minute history reaches back much further than the cached batch; hourly history starts at T0.
    const t = u.searchParams.get('interval') === '1min' ? T0 - 400 * 86400 : T0;
    return reply({ datetime: new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' '), unix_time: t });
  }
  if (u.pathname === '/time_series') {
    if (rateLimitOnce) { rateLimitOnce = false; return reply({ code: 429, message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.', status: 'error' }, 429); }
    const iv = u.searchParams.get('interval');
    if (!SEC[iv]) return reply({ code: 400, message: `**interval** ${iv} not supported in test`, status: 'error' });
    const sec = SEC[iv];
    const all = calendar(sec);
    const end = u.searchParams.get('end_date'), start = u.searchParams.get('start_date');
    let sel = all;
    if (end) sel = sel.filter(t => t <= Date.parse(end + 'Z') / 1000);
    if (start) sel = sel.filter(t => t >= Date.parse(start + 'Z') / 1000);
    sel = sel.slice(-5000);
    if (!sel.length) return reply({ code: 400, message: 'No data is available on the specified dates. Try setting different start/end dates.', status: 'error' });
    const values = sel.map(t => candle(t, (t - T0) / sec));
    if (iv === '1h' && !end && !start) {
      values.push({ ...values[values.length - 1] });                                        // duplicate
      values.push({ datetime: 'garbage', open: '1', high: '1', low: '1', close: '1' });       // bad date
      values.push({ datetime: '2030-01-01 00:00:00', open: '10', high: '5', low: '9', close: '9' }); // high < low
    }
    return reply({ meta: { symbol: u.searchParams.get('symbol'), interval: iv, type: 'Physical Currency' }, values, status: 'ok' });
  }
  return reply({ code: 404, message: 'not found', status: 'error' }, 404);
};

test('cleanValues parses UTC, sorts, removes duplicates and invalid candles', () => {
  const r = td.cleanValues([
    { datetime: '2025-01-02 10:00:00', open: '2', high: '3', low: '1', close: '2.5' },
    { datetime: '2025-01-02 09:00:00', open: '2', high: '3', low: '1', close: '2.5' },
    { datetime: '2025-01-02 10:00:00', open: '2', high: '3', low: '1', close: '2.6' },
    { datetime: '2025-01-02', open: '2', high: '3', low: '1', close: '2.5' },
    { datetime: '2025-01-02 11:00:00', open: '2', high: '1', low: '3', close: '2' },
    { datetime: '2025-01-02 12:00:00', open: 'NaN', high: '3', low: '1', close: '2' },
  ]);
  assert.deepEqual(r.rows.map(x => x[0]), [Date.UTC(2025, 0, 2) / 1000, Date.UTC(2025, 0, 2, 9) / 1000, Date.UTC(2025, 0, 2, 10) / 1000]);
  assert.equal(r.rows[2][4], 2.6); // later duplicate wins
  assert.equal(r.invalid, 2);
  assert.equal(r.duplicates, 1);
});

test('no API key → clear configuration error, no request made', async () => {
  await assert.rejects(td.tdGetBars('XAUUSD', '1h', {}), e => e.code === 'NO_KEY' && /TWELVE_DATA_API_KEY/.test(e.message));
  assert.equal(calls.length, 0);
});

test('plan check blocks symbols the plan does not include', async () => {
  process.env.TWELVE_DATA_API_KEY = 'test-key-123';
  xauRequired = 'Grow';
  await assert.rejects(td.tdGetBars('XAUUSD', '1h', {}), e => e.code === 'PLAN' && /needs the Grow plan/.test(e.message));
  assert.ok(!calls.some(c => c.path === '/time_series'), 'no candles requested before the plan check passes');
  xauRequired = 'Basic';
  await td.symbolAccess('XAUUSD', true);
});

test('latest candles: header auth, UTC, cleaned, cached (no second request while fresh)', async () => {
  calls.length = 0;
  const res = await td.tdGetBars('XAUUSD', '1h', { limit: 300 });
  const ts = calls.find(c => c.path === '/time_series');
  assert.equal(ts.params.symbol, 'XAU/USD');
  assert.equal(ts.params.interval, '1h');
  assert.equal(ts.params.timezone, 'UTC');
  assert.equal(ts.auth, 'apikey test-key-123');
  assert.ok(!('apikey' in ts.params), 'key never sent in the URL');
  assert.equal(res.bars.length, 300);
  const times = res.bars.map(b => b[0]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(times).size, times.length);
  assert.ok(times.at(-1) < Date.UTC(2030, 0, 1) / 1000, 'invalid future candle dropped');
  assert.equal(res.bars.at(-1)[0], calendar(3600).at(-1));
  calls.length = 0;
  await td.tdGetBars('XAUUSD', '1h', { limit: 300 });
  assert.equal(calls.filter(c => c.path === '/time_series').length, 0, 'served from cache');
  assert.ok(fs.existsSync(path.join(process.env.CHARTDESK_DATA, 'twelvedata', 'XAUUSD', '1h.bin')));
});

test('unsupported timeframe is reported, not faked', async () => {
  await assert.rejects(td.tdGetBars('XAUUSD', '3m', {}), e => e.code === 'TIMEFRAME' && /doesn't provide 3m/.test(e.message));
});

test('scrolling back pages older history with end_date until the start of history', async () => {
  calls.length = 0;
  const first = (await td.tdGetBars('XAUUSD', '1h', { limit: 5000 })).bars[0][0];
  const older = await td.tdGetBars('XAUUSD', '1h', { before: first, limit: 1000 });
  assert.equal(older.bars.length, 1000);
  assert.equal(older.bars.at(-1)[0], first - 3600);
  assert.ok(calls.some(c => c.path === '/time_series' && c.params.end_date), 'older batch requested with end_date');
  const oldest = await td.tdGetBars('XAUUSD', '1h', { before: T0 + 10 * 3600, limit: 1000 });
  assert.equal(oldest.bars[0][0], T0);
  assert.equal(oldest.hasMoreBefore, false);
});

test('per-minute 429 waits and retries; replay fills come from cached candles only', async () => {
  rateLimitOnce = true;
  const res = await td.tdGetBars('XAUUSD', '1day', {}).catch(e => e);
  assert.ok(res instanceof Error && res.code === 'TIMEFRAME'); // 1day is a TD interval but '1day' isn't a chart timeframe key
  rateLimitOnce = true;
  calls.length = 0;
  const d = await td.tdGetBars('XAUUSD', '1d', { limit: 50 });
  assert.equal(d.bars.length, 50);
  assert.equal(calls.filter(c => c.path === '/time_series').length, 2, 'retried after the rate-limit response');
  assert.ok(td.stats.rateLimitWaits >= 1);

  // 1h cache covers T0 … : a 4h window (Wednesday 00:00–04:00 UTC) is filled with the four real hourly candles inside it.
  const from = T0 + 24 * 3600;
  const fills = td.tdFillBars('XAUUSD', from, from + 4 * 3600);
  assert.equal(fills.length, 4);
  assert.equal(fills[0].seconds, 3600);
  const r = td.tdRangeOhlc('XAUUSD', from, from + 2 * 3600);
  assert.equal(r.count, 2);
  assert.equal(r.open, fills[0].open);
  assert.equal(td.tdRangeOhlc('XAUUSD', from, from + 1800), null, 'no finer data → forming bar is hidden, not invented');
});

test('history far beyond the cache asks for a download instead of silently spending credits', async () => {
  td._setSleepForTests(async () => {});
  calls.length = 0;
  await assert.rejects(td.tdGetBars('EURUSD', '1m', { after: T0 - 300 * 86400 }), e => e.code === 'INSUFFICIENT' && /about \d+ more requests/.test(e.message));
  assert.equal(calls.filter(c => c.path === '/time_series').length, 1, 'only the latest batch was fetched');
  // A date inside Twelve Data's range but within a few batches is fetched automatically.
  const near = await td.tdGetBars('EURUSD', '1m', { after: T0 + 1000 * 60, limit: 10 });
  assert.equal(near.bars[0][0], T0 + 1000 * 60);
});

test('data source defaults to TradingView for XAUUSD and can be switched', async () => {
  assert.equal(td.sourceOf('XAUUSD'), 'tradingview');
  assert.deepEqual(td.sourcesOf('XAUUSD'), ['twelvedata', 'tradingview', 'dukascopy']);
  assert.equal(await td.setSource('XAUUSD', 'dukascopy'), 'dukascopy');
  assert.equal(await td.setSource('XAUUSD', 'twelvedata'), 'twelvedata');
  assert.equal(td.sourceOf('BTCUSDT'), 'binance');
  await assert.rejects(td.setSource('US500', 'twelvedata'));
});

test('market-closed candles (weekend, daily metals break) are recognised, DST-aware', async () => {
  const { marketClosedBar } = await import('../twelvedata.js');
  const t = s => Date.parse(s) / 1000;
  // Summer (EDT, UTC-4): Friday close 21:00 UTC, Sunday open 22:00 UTC, daily break 21:00-22:00 UTC
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-21T20:45Z'), 900), false);
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-21T21:00Z'), 900), true);
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-22T10:00Z'), 3600), true);
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-23T21:45Z'), 900), true);
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-23T22:00Z'), 900), false);
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-24T21:00Z'), 3600), true);   // Monday metals break
  assert.equal(marketClosedBar('EURUSD', t('2026-08-24T21:00Z'), 3600), false);  // FX trades through
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-23T21:00Z'), 14400), false); // 4h bar containing the open
  assert.equal(marketClosedBar('XAUUSD', t('2026-08-22T00:00Z'), 86400), true);  // Saturday daily bar
  // Winter (EST, UTC-5): Friday close 22:00 UTC
  assert.equal(marketClosedBar('XAUUSD', t('2026-01-16T21:30Z'), 900), false);
  assert.equal(marketClosedBar('XAUUSD', t('2026-01-16T22:00Z'), 900), true);
});

test('live chart refresh: fresh candles within the cadence, paused near the daily credit limit', async () => {
  calls.length = 0;
  const first = await td.tdGetBars('XAUUSD', '1h', { limit: 5, live: true });
  assert.equal(first.throttled, false);
  assert.ok(first.fetchedAt > 0);
  assert.ok(first.credits && first.credits.limit > 0, 'daily usage reported');
  const again = await td.tdGetBars('XAUUSD', '1h', { limit: 5, live: true });
  assert.equal(calls.filter(c => c.path === '/time_series').length, 0, 'cached within the live cadence — no credits spent');
  assert.equal(again.bars.at(-1)[0], first.bars.at(-1)[0]);
  // near the daily limit: no API call, cached candles returned and flagged
  dailyUsage = 780;
  td._resetUsageForTests();
  calls.length = 0;
  const paused = await td.tdGetBars('XAUUSD', '1h', { limit: 5, live: true });
  assert.equal(paused.throttled, true);
  assert.equal(calls.filter(c => c.path === '/time_series').length, 0);
  dailyUsage = 10;
  td._resetUsageForTests();
});
