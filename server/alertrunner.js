// Alerts run here, in the ChartDesk server — like TradingView's server-side alerts they keep working while the
// browser is closed (as long as `npm start` is running). The app edits alert definitions (kv "priceAlerts"); this
// module owns their runtime state (kv "alertState": last reference price, last check, when it fired), checks live
// prices every few seconds, records events for the app to pop up, and posts webhooks (Discord, Slack, Telegram, ntfy…).

import { kvGet, kvPut } from './kv.js';
import { bySymbol } from './catalog.js';
import { sourceOf, keyConfigured, tdGetBars, tdFetchedAt, tdClosedBars } from './twelvedata.js';
import { TF, marketTime } from '../public/js/core/sessions.js';
import { observe, evaluate, changeFires, compareFires, drawingLevels, alertText, armedAt, isArmed } from '../public/js/core/alerts.js';
import { indicatorOutputs, outputNames } from '../public/js/core/indicators.js';
import { want as streamWant, release as streamRelease, streamedMinute } from './tdstream.js';
import { tvGetBars } from './tvsource.js';

const TICK_MS = 5000;
const BINANCE = 'https://data-api.binance.vision/api/v3';
const LOG_MAX = 200;
const TICK_KEEP_MS = 3 * 86400e3; // % move windows up to 3 days

const seen = new Map();     // symbol → observe() state of the latest candle
const held = new Set();     // Twelve Data symbols the runner keeps on the WebSocket stream
const ticks = new Map();    // symbol → [{ at, lo, hi, last }]
const polledAt = new Map(); // feed key → last fetch (ms)
const events = [];          // recent fired alerts for the app: { seq, at, id, symbol, text, price }
let seq = 0, running = false, lastSave = 0;
export const runnerStatus = { startedAt: Date.now(), lastTick: null, lastError: null, symbols: [] };

let custom = new Set(); // Binance pairs the app added beyond the catalog (kv customSymbols)
const isBinance = s => bySymbol[s]?.provider === 'binance' || custom.has(s);
const sessionOf = s => bySymbol[s]?.session || (custom.has(s) ? 'crypto' : 'fx');
const precOf = s => bySymbol[s]?.precision ?? (custom.has(s) ? 6 : 2);
const rowBar = r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], start: r[7] ?? r[0] });
const due = (key, every) => { const t = polledAt.get(key) || 0; if (Date.now() - t < every - 250) return false; polledAt.set(key, Date.now()); return true; };

async function binanceKlines(symbol, interval, limit) {
  const r = await fetch(`${BINANCE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return (await r.json()).map(k => ({ time: k[0] / 1000, start: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

/** Latest live candles for price-type alerts, or null when it isn't time to look again / there's no live source. */
async function latestBars(symbol) {
  const src = sourceOf(symbol);
  if (isBinance(symbol) || src === 'binance') return due(`p:${symbol}`, 5000) ? binanceKlines(symbol, '1m', 2) : null;
  if (src === 'tradingview') { const m = streamedMinute(symbol); return m && due(`p:${symbol}`, 2000) ? [{ ...m }] : null; }
  if (src !== 'twelvedata' || !keyConfigured()) return null; // Dukascopy is historical: nothing live to check
  // streamed ticks (WebSocket): checked every 2 s, no API credits
  const m = streamedMinute(symbol);
  if (m) return due(`p:${symbol}`, 2000) ? [{ ...m }] : null;
  // An open 1-minute chart keeps the 1m cache fresh — read it for free; otherwise the 1h series refreshes at most
  // every 5 minutes (1 credit) under the daily credit guard, like the chart's own live polling.
  const fresh1m = (tdFetchedAt(symbol, '1m') || 0) > Date.now() - 70e3;
  if (fresh1m) return due(`p:${symbol}`, 5000) ? (await tdGetBars(symbol, '1m', { limit: 2, cacheOnly: true })).bars.map(rowBar) : null;
  return due(`p:${symbol}`, 60e3) ? (await tdGetBars(symbol, '1h', { limit: 2, live: true })).bars.map(rowBar) : null;
}

/** Candles of `tf` for indicator alerts (closed bars are used). */
async function closedBars(symbol, tf) {
  const src = sourceOf(symbol);
  if (isBinance(symbol) || src === 'binance') return due(`i:${symbol}|${tf}`, 15e3) ? binanceKlines(symbol, tf, 500) : null;
  if (src === 'tradingview') return due(`i:${symbol}|${tf}`, 15e3) ? (await tvGetBars(symbol, tf, { limit: 500 })).bars.map(rowBar) : null;
  if (src !== 'twelvedata' || !keyConfigured()) return null;
  return due(`i:${symbol}|${tf}`, 30e3) ? (await tdClosedBars(symbol, tf, 500)).map(rowBar) : null;
}

function pushTick(symbol, upd, now) {
  const list = ticks.get(symbol) || [];
  list.push({ at: now, lo: upd.lo, hi: upd.hi, last: upd.last });
  while (list.length && list[0].at < now - TICK_KEEP_MS) list.shift();
  if (list.length > 20000) list.splice(0, list.length - 20000);
  ticks.set(symbol, list);
}

async function sendWebhook(settings, a, ev) {
  const url = settings?.webhookUrl;
  if (!url || a.webhook === false || !/^https?:\/\//i.test(url)) return;
  const text = `🔔 ChartDesk: ${ev.text}${ev.price != null ? ` · now ${ev.price}` : ''}${a.message ? ` — ${a.message}` : ''}`;
  try {
    const plain = settings.webhookFormat === 'text';
    await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': plain ? 'text/plain; charset=utf-8' : 'application/json' },
      // `text` / `content` make Slack, Telegram (sendMessage) and Discord show the message without any mapping
      body: plain ? text : JSON.stringify({ text, content: text, symbol: a.symbol, kind: a.kind || 'price', condition: a.cond, price: ev.price, message: a.message || '', time: new Date(ev.at).toISOString(), alertId: a.id }),
    });
  } catch (e) { runnerStatus.lastError = `Webhook: ${e.message}`; }
}

function fire(a, st, state, price, now, settings, extra = '') {
  const prec = precOf(a.symbol);
  const ev = { seq: ++seq, at: now, id: a.id, symbol: a.symbol, text: alertText(a, prec, a.ind ? outputNames(a.ind.type) : []) + extra, price: price != null ? Number(Number(price).toFixed(prec)) : null, message: a.message || '', sound: a.sound !== false };
  events.push(ev);
  if (events.length > 200) events.shift();
  state.firedAt = now; state.firedPrice = ev.price; state.fireCount = (state.fireCount || 0) + 1;
  if (!a.repeat) state.firedFor = armedAt(a);
  st.log.unshift({ id: a.id, symbol: a.symbol, text: ev.text + (a.message ? ` — ${a.message}` : ''), price: ev.price, at: now });
  if (st.log.length > LOG_MAX) st.log.length = LOG_MAX;
  sendWebhook(settings, a, ev);
}

/** Price, % move and drawing alerts against one live update of their symbol. */
function checkLive(a, st, upd, now, settings, drawingsOf) {
  const state = st.states[a.id] ||= {};
  const kind = a.kind || 'price';
  if (kind === 'change') {
    const hit = changeFires({ ...a, armedAt: Math.max(armedAt(a), (a.repeat && state.firedAt) || 0) }, ticks.get(a.symbol) || [], now);
    state.checkedAt = now;
    if (hit) { fire(a, st, state, hit.last, now, settings, ` (${hit.move >= 0 ? '+' : '−'}${Math.abs(hit.move).toFixed(2)}%)`); return true; }
    return false;
  }
  let levels = [a.price];
  if (kind === 'drawing') {
    const d = drawingsOf(a.symbol)?.find(x => x.id === a.drawingId);
    if (!d) { state.missing = true; return false; }
    state.missing = false;
    const session = sessionOf(a.symbol);
    levels = drawingLevels(d, now / 1000, t => marketTime(t, session));
    state.level = levels[0] ?? null;
    if (!levels.length) { state.ref = upd.last; state.checkedAt = now; return false; }
  }
  // the shared price-alert logic (trusted ranges, cooldowns) on a copy carrying this alert's runtime state
  for (const level of levels) {
    const probe = { ...a, price: level, active: true, created: armedAt(a), ref: state.ref, checkedAt: state.checkedAt, firedAt: state.firedAt };
    if (evaluate(probe, upd, now)) {
      state.ref = probe.ref; state.checkedAt = now;
      fire(a, st, state, upd.last, now, settings, kind === 'drawing' ? ` @ ${level.toFixed(precOf(a.symbol))}` : '');
      return true;
    }
  }
  state.ref = upd.last; state.checkedAt = now;
  return false;
}

/** Indicator alerts: compare two sides (close / indicator line / value) on the latest closed bar. */
function checkIndicator(a, st, bars, now, settings) {
  const state = st.states[a.id] ||= {};
  const sec = TF[a.tf]?.sec || 3600, nowS = now / 1000;
  const closed = bars.filter(b => (b.start ?? b.time) + sec <= nowS + 1);
  if (closed.length < 3) return false;
  const last = closed[closed.length - 1], n = closed.length;
  if (state.lastBar === last.time) return false;
  state.lastBar = last.time; state.checkedAt = now;
  if (((last.start ?? last.time) + sec) * 1000 < armedAt(a)) return false; // closed before the alert was set
  const outs = indicatorOutputs(a.ind.type, closed, a.ind.params || {}, sessionOf(a.symbol));
  const val = (side, i) => (side.k === 'close' ? closed[i].close : side.k === 'value' ? Number(side.v) : outs[side.i]?.[i] ?? null);
  const hit = compareFires(a.cond, val(a.left, n - 2), val(a.left, n - 1), val(a.right, n - 2), val(a.right, n - 1));
  state.values = [val(a.left, n - 1), val(a.right, n - 1)];
  if (hit) { fire(a, st, state, last.close, now, settings); return true; }
  return false;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const doc = await kvGet('priceAlerts');
    const defs = doc?.alerts || [];
    const st = (await kvGet('alertState')) || {};
    st.states ||= {}; st.log ||= Array.isArray(doc?.log) ? doc.log : [];
    const settings = (await kvGet('alertSettings')) || {};
    custom = new Set(((await kvGet('customSymbols')) || []).map(c => c.symbol));
    const now = Date.now();
    const armed = defs.filter(a => isArmed(a, st.states[a.id]) && (bySymbol[a.symbol] || custom.has(a.symbol)));
    let fired = false;
    const drawings = new Map();
    const drawingsOf = s => drawings.get(s);
    // price, % move and drawing alerts: one live feed per symbol
    const liveSyms = [...new Set(armed.filter(a => (a.kind || 'price') !== 'indicator').map(a => a.symbol))];
    // keep Twelve Data symbols with armed alerts on the price stream, even with no chart open
    const tdSyms = new Set(liveSyms.filter(s => sourceOf(s) === 'twelvedata' || sourceOf(s) === 'tradingview'));
    for (const s of tdSyms) if (!held.has(s)) { held.add(s); streamWant(s); }
    for (const s of [...held]) if (!tdSyms.has(s)) { held.delete(s); streamRelease(s); }
    for (const s of liveSyms) {
      let bars;
      try { bars = await latestBars(s); } catch (e) { runnerStatus.lastError = `${s}: ${e.message}`; continue; }
      if (!bars?.length) continue;
      if (armed.some(a => a.symbol === s && a.kind === 'drawing')) drawings.set(s, (await kvGet(`drawings:${s}`)) || []);
      for (const b of bars) {
        const { upd, seen: next } = observe(seen.get(s) || null, b, now);
        seen.set(s, next);
        if (!upd) continue;
        pushTick(s, upd, now);
        for (const a of armed) if (a.symbol === s && (a.kind || 'price') !== 'indicator' && isArmed(a, st.states[a.id])) fired = checkLive(a, st, upd, now, settings, drawingsOf) || fired;
      }
    }
    // indicator alerts: one candle series per symbol + timeframe
    const groups = new Map();
    for (const a of armed) if (a.kind === 'indicator' && a.ind && TF[a.tf]) { const k = `${a.symbol}|${a.tf}`; groups.set(k, [...(groups.get(k) || []), a]); }
    for (const [k, list] of groups) {
      const [s, tf] = k.split('|');
      let bars;
      try { bars = await closedBars(s, tf); } catch (e) { runnerStatus.lastError = `${s} ${tf}: ${e.message}`; continue; }
      if (!bars?.length) continue;
      for (const a of list) { try { fired = checkIndicator(a, st, bars, now, settings) || fired; } catch (e) { runnerStatus.lastError = `${a.symbol} indicator: ${e.message}`; } }
    }
    // forget state of deleted alerts
    for (const id of Object.keys(st.states)) if (!defs.some(a => a.id === id)) delete st.states[id];
    if (fired || now - lastSave > 30e3) { lastSave = now; await kvPut('alertState', st); }
    runnerStatus.lastTick = now;
    runnerStatus.symbols = [...new Set([...liveSyms, ...[...groups.keys()].map(k => k.split('|')[0])])];
  } catch (e) {
    runnerStatus.lastError = e.message;
  } finally { running = false; }
}

export function startAlertRunner() {
  setInterval(tick, TICK_MS);
  setTimeout(tick, 1500);
}

/** For the app: fired alerts after `since`, plus the runtime state of every alert. */
export async function alertEvents(since = 0) {
  const st = (await kvGet('alertState')) || { states: {}, log: [] };
  return { seq, events: events.filter(e => e.seq > since), states: st.states || {}, log: (st.log || []).slice(0, 100), runner: runnerStatus, boot: runnerStatus.startedAt };
}
export async function clearAlertLog() {
  const st = (await kvGet('alertState')) || { states: {} };
  st.log = [];
  await kvPut('alertState', st);
  return { ok: true };
}
export async function testWebhook(settings) {
  const url = settings?.url;
  if (!url || !/^https?:\/\//i.test(url)) throw Object.assign(new Error('Enter an http(s) webhook URL'), { status: 400 });
  const text = '🔔 ChartDesk test alert — webhooks are working.';
  const plain = settings.format === 'text';
  const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': plain ? 'text/plain; charset=utf-8' : 'application/json' },
    body: plain ? text : JSON.stringify({ text, content: text, test: true, time: new Date().toISOString() }) });
  return { ok: r.ok, status: r.status };
}
