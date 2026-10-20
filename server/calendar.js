// Economic calendar: this week's events (time, currency, impact, forecast, previous) from the public Forex Factory
// weekly feed, fetched at most once an hour and kept on disk so the calendar still shows when offline.

import { kvGet, kvPut } from './kv.js';

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const MAX_AGE = 60 * 60e3;
let cache = null;

export async function economicCalendar(force = false) {
  if (!force && cache && Date.now() - cache.at < MAX_AGE) return cache;
  if (force && cache && Date.now() - cache.at < 5 * 60e3) return cache; // be polite to the feed
  try {
    const r = await fetch(FEED, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'ChartDesk/2 (local charting app)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const events = (await r.json()).map(e => ({
      title: String(e.title || ''), country: String(e.country || ''), time: Math.floor(Date.parse(e.date) / 1000),
      impact: String(e.impact || ''), forecast: e.forecast || '', previous: e.previous || '', actual: e.actual || '',
    })).filter(e => Number.isFinite(e.time));
    cache = { at: Date.now(), events, source: 'Forex Factory weekly calendar' };
    await kvPut('econCalendar', cache);
  } catch (e) {
    cache ||= await kvGet('econCalendar');
    if (!cache) throw Object.assign(new Error(`Economic calendar unavailable (${e.message})`), { status: 502 });
    cache = { ...cache, stale: true, error: e.message };
  }
  return cache;
}
