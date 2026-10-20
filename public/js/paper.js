// Paper trading on live prices: one virtual account across symbols (positions, limit / stop orders, SL / TP),
// filled by the same broker emulator as Bar Replay. Prices come from the charts' live feeds (Binance stream,
// Twelve Data polling) and, for symbols with open trades but no open chart, a background poll.
// The Trading panel, chart lines, quick buy/sell buttons and right-click orders use this session whenever
// paper trading is on and Bar Replay isn't running.

import { kv, toast, fmtUsd, fmtPrice } from './util.js';
import { spec, fetchBars, precisionOf } from './data.js';
import { Broker, canTrade } from './core/broker.js';
import { observe } from './core/alerts.js';

const BINANCE = 'https://data-api.binance.vision/api/v3';

/** A per-symbol broker whose balance, equity and margin belong to the shared paper account. */
class SharedBroker extends Broker {
  constructor(spec, cfg, acct) { super(spec, cfg); this.acct = acct; this.bind(); }
  bind() {
    const acct = this.acct;
    Object.defineProperty(this.s, 'balance', { get: () => acct.state.balance, set: v => { acct.state.balance = v; }, enumerable: true, configurable: true });
  }
  load(state) { super.load(state); this.bind(); return this; }
  get equity() { return this.acct.equity; }
  get usedMargin() { return this.acct.usedMargin; }
}

export class Paper {
  constructor(app) {
    this.app = app;
    this.brokers = new Map();
    this.seen = new Map();
    this.state = { balance: 10000, cfg: { balance: 10000, leverage: 100 }, brokers: {}, created: Date.now() };
  }
  async init() {
    const d = await kv.get('paperAccount', null);
    if (d) this.state = { ...this.state, ...d };
    for (const [sym, st] of Object.entries(this.state.brokers || {})) {
      const s = spec(sym);
      if (s && canTrade(s)) this.brokers.set(sym, new SharedBroker(s, this.brokerCfg(s), this).load(st));
    }
    this.timer = setInterval(() => this.pollBackground(), 2000);
  }
  get enabled() { return !!this.app.settings.paperOn; }
  setEnabled(on) {
    this.app.settings.paperOn = on;
    this.app.saveSettings();
    if (on) this.seedQuote(this.symbol);
    this.app.onTradingSessionChanged?.();
  }
  brokerCfg(s) { return { balance: this.state.cfg.balance, leverage: this.state.cfg.leverage, slippage: 0, spreadMode: 'data', fixedSpread: s.defaultSpread ?? 0 }; }

  // ---------------------------------------------------------------- session interface (what Trading and the charts use)
  /** Can `symbol` be paper-traded right now (live source, USD account)? */
  canTrade(symbol) {
    const s = spec(symbol);
    if (!this.enabled || this.app.replay?.active || !s || !canTrade(s)) return false;
    return s.provider === 'binance' || s.provider === 'tradingview' || (s.provider === 'twelvedata' && s.tdConfigured);
  }
  get active() { return this.canTrade(this.symbol); }
  get symbol() { return this.app.activeView?.symbol; }
  get broker() { return this.brokerFor(this.symbol); }
  brokerFor(symbol) {
    if (!symbol || !canTrade(spec(symbol))) return null;
    if (!this.brokers.has(symbol)) { this.brokers.set(symbol, new SharedBroker(spec(symbol), this.brokerCfg(spec(symbol)), this)); this.seedQuote(symbol); }
    return this.brokers.get(symbol);
  }
  /** First quote for a symbol from its chart's latest candle (live updates take over from there). */
  seedQuote(symbol) {
    const b = symbol && this.brokers.get(symbol);
    if (!b || b.quote) return;
    const v = this.app.views.find(x => x.symbol === symbol && x.src?.length && !x.inReplay);
    const last = v?.src[v.src.length - 1];
    if (last) b.setQuote(last.close, last.spread || 0, Math.floor(Date.now() / 1000));
  }
  get equity() {
    let e = this.state.balance;
    for (const b of this.brokers.values()) for (const p of b.s.positions) e += b.unrealized(p);
    return e;
  }
  get usedMargin() {
    let m = 0;
    for (const b of this.brokers.values()) for (const p of b.s.positions) m += b.notionalUsd(p.lots, p.entry) / b.cfg.leverage;
    return m;
  }
  /** Every symbol with open positions or working orders. */
  get openSymbols() { return [...this.brokers.entries()].filter(([, b]) => b.s.positions.length || b.s.orders.length).map(([s]) => s); }
  allHistory() { return [...this.brokers.entries()].flatMap(([sym, b]) => b.s.history.map(t => ({ ...t, symbol: sym }))).sort((a, b) => a.exitTime - b.exitTime); }

  /** Journal / toasts, like Bar Replay. */
  async handleEvent(ev, symbol = this.symbol) {
    const p = precisionOf(symbol), b = this.brokers.get(symbol);
    const facade = { session: { id: `paper-${symbol}`, name: 'Paper trading (live)' }, symbol, broker: b };
    if (ev.type === 'fill') {
      toast(`Paper: filled ${ev.position.side.toUpperCase()} ${+ev.position.lots.toFixed(4)} ${symbol} @ ${fmtPrice(ev.position.entry, p)}`);
      await this.app.journal.onFill(facade, ev.position);
    } else if (ev.type === 'close') {
      const t = ev.trade;
      toast(`Paper · ${t.reason}: ${t.side.toUpperCase()} ${+t.lots.toFixed(4)} ${symbol} closed @ ${fmtPrice(t.exit, p)} · ${fmtUsd(t.pnl, true)}`, t.pnl >= 0 ? 'good' : 'error');
      await this.app.journal.onClose(facade, t);
    } else if (ev.type === 'rejected') toast(`Paper order rejected: ${ev.reason}`, 'error');
    else if (ev.type === 'stopout') toast('Paper account margin stop-out: positions closed', 'error');
  }
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.state.brokers = Object.fromEntries([...this.brokers.entries()].filter(([, b]) => b.s.positions.length || b.s.orders.length || b.s.history.length).map(([sym, b]) => [sym, b.toJSON()]));
      kv.set('paperAccount', this.state, 50);
    }, 500);
  }
  updateBar() {}
  openDialog(symbol) { this.app.replay.openDialog(symbol); }

  // ---------------------------------------------------------------- live prices
  /** A live candle update from a chart (or the background poll): fill whatever the move since the last update touched. */
  onBar(symbol, bar, key = 'chart') {
    const b = this.brokers.get(symbol);
    if (!b || this.app.replay?.active) return;
    const now = Date.now();
    const { upd, seen } = observe(this.seen.get(symbol) || null, bar, now);
    this.seen.set(symbol, seen);
    void key;
    if (!upd) return;
    const prev = b.quote?.bid ?? upd.last;
    const events = b.processBar({ time: Math.floor(now / 1000), open: prev, high: Math.max(prev, upd.hi), low: Math.min(prev, upd.lo), close: upd.last, spread: bar.spread || 0, seconds: 1 });
    b.s.time = Math.floor(now / 1000);
    for (const ev of events) this.handleEvent(ev, symbol);
    if (events.length) { this.persist(); for (const v of this.app.views) v.applyMarkers(); }
    if (this.app.trading?.sess === this) this.app.trading.refresh();
  }
  /** Symbols with open trades but no live chart: Binance every 2 s; Twelve Data's 1h series (at most a credit per 5 min). */
  async pollBackground() {
    if (!this.enabled || this.app.replay?.active || this.polling || document.hidden) return;
    const live = new Set(this.app.views.filter(v => !v.inReplay && (v.unsubLive || v.pollTimer)).map(v => v.symbol));
    const need = this.openSymbols.filter(s => !live.has(s));
    if (!need.length) return;
    this.polling = true;
    try {
      for (const s of need) {
        const sp = spec(s);
        try {
          if (sp.provider === 'binance') {
            const k = await (await fetch(`${BINANCE}/klines?symbol=${s}&interval=1m&limit=2`)).json();
            for (const x of k) this.onBar(s, { time: x[0] / 1000, start: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }, 'bg');
          } else if (sp.provider === 'tradingview') {
            const { bars } = await fetchBars(s, '1m', { limit: 2 });
            for (const x of bars) this.onBar(s, x, 'bg');
          } else if (sp.provider === 'twelvedata' && Date.now() - (this.tdAt?.[s] || 0) > 30e3) {
            (this.tdAt ||= {})[s] = Date.now();
            const { bars } = await fetchBars(s, '1h', { limit: 1, live: true });
            for (const x of bars) this.onBar(s, x, 'bg');
          }
        } catch { /* try again next round */ }
      }
    } finally { this.polling = false; }
  }

  /** Start over with a fresh balance (closed trades stay in the journal). */
  reset(balance = this.state.cfg.balance, leverage = this.state.cfg.leverage) {
    this.state = { balance, cfg: { balance, leverage }, brokers: {}, created: Date.now() };
    this.brokers.clear();
    this.seen.clear();
    this.persist();
    this.seedQuote(this.symbol);
    this.app.onTradingSessionChanged?.();
  }
}
