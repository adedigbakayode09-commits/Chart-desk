# ChartDesk

Professional charting, Bar Replay and backtesting on real market data. Runs locally:
a small Node server (data cache, persistence, Claude proxy) plus a no-build web app.

Charts are rendered with the open-source Lightweight Charts™ library (Apache-2.0); its licence requires the
attribution shown in ChartDesk's About dialog.

## Run

    npm install
    npm start            # → http://127.0.0.1:5178
    npm test             # server + broker/backtest tests

Keys go in `ChartDesk/.env` (copy `.env.example`; gitignored) or the shell that runs `npm start`. They are read only
by the local server and never sent to the browser.

| Variable | Used for |
|---|---|
| `TWELVE_DATA_API_KEY` | **XAUUSD** (Gold/USD), silver and FX majors from [Twelve Data](https://twelvedata.com/pricing) (free Basic plan includes XAU/USD) |
| `ANTHROPIC_API_KEY` | **Ask Claude** chart assistant (or sign in with `ant auth login`) |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Downloading Dukascopy's tick archive (Requester Pays S3) |
| `PORT`, `CHARTDESK_DATA` | Server port, data folder (default `./data`) |

## Market data

- **Twelve Data (XAUUSD by default; also XAGUSD and the FX majors)** — `/time_series` with `timezone=UTC`, one Twelve Data
  interval per chart timeframe (1m 5m 15m 30m 1h 2h 4h 1D 1W 1M; 3m isn't offered and says so), cached per interval in
  `data/twelvedata/<SYMBOL>/`. Before requesting candles the server checks your plan covers the symbol
  (`/api_usage` + `/symbol_search?show_plan=true`); requests are paced to your plan's per-minute credits and per-minute
  429s are retried. Older history loads as you scroll back; dates far beyond the cache ask for a background download
  (**Data → Twelve Data**), which also shows each timeframe's available range (`/earliest_timestamp`).
  Replay on Twelve Data steps candle by candle and fills orders on the finest cached real candles.
- **Dukascopy (XAUUSD, XAGUSD, FX majors, US500/US30/NAS100, BTC/ETH)** — real 1-minute bid candles built from
  Dukascopy tick data, cached in `data/market/<SYMBOL>/` and aggregated to 1m…1M with FX sessions
  (trading day rolls at 17:00 New York, DST-aware). Two ways in, both in **Data**:
  1. *Official tick archive* (`cfg-public-proper-wallaby`, Requester Pays — cents per symbol-year on your AWS bill;
     ChartDesk never asks for keys, it uses the standard AWS credential chain). Includes the real bid/ask spread.
  2. *CSV import* (free) — Dukascopy "Historical Data Feed" exports at 1-minute resolution (BID, optionally ASK for spreads).

  Dukascopy's free `datafeed`/`jetta` HTTP endpoints now sit behind a bot challenge, so the `dukascopy-node`
  downloader can't fetch from them; the package is still used for instrument metadata (history start dates).
- **Binance** — live spot crypto (REST + WebSocket), also replayable.

Symbols with both Twelve Data and Dukascopy (XAUUSD, XAGUSD, FX majors) can be switched in **Data**.

No synthetic candles are ever generated; gaps stay gaps.

## Features

- Multi-chart layouts (1/2/3/4), saved layouts, watchlists, symbol search, dark/light theme
- Timeframes 1m 3m 5m 15m 30m 1h 2h 4h 1D 1W 1M; 7 chart types; indicators: Volume, MA, EMA, Bollinger,
  session VWAP, RSI, MACD, Stochastic, ATR
- Drawings: trend, ray, horizontal/vertical, rectangle, Fibonacci, long/short position, text, measure
- **Bar Replay**: pick a bar or date, step by bar or intrabar (1m–4h), play/pause/speed, rewind, jump; all charts
  and the watchlist hide future data; sessions are saved and auto-resume
- **Manual backtesting**: market/limit/stop, SL/TP (drag on chart), risk-% sizing, partial close; fills from 1-minute
  data with spread, slippage, commission, gaps, margin and stop-out
- **Strategy Tester**: 6 built-in strategies, ATR/R-multiple exits, costs, real 1-minute intrabar fills; win rate, profit factor,
  drawdown, equity curve, trade list, chart markers
- **Journal**: every replay trade with entry/exit screenshots, P&L, R, planned R:R, MFE/MAE, notes, tags, CSV export
- **Price alerts**: crossing / crossing up / crossing down / greater than / less than a level, once or every time; pop-up,
  sound and desktop notification. Add from the chart's right-click menu, Alt+A or the **Alerts** tab; drag the line to move it.
  Checked on live data while ChartDesk is open (an open live chart, or a background poll: Binance every 15 s, Twelve Data
  every 1–5 min to save credits). Dukascopy data is historical, so alerts there can't fire. Paused during Bar Replay.
- **Ask Claude**: a chat panel that edits the active chart — indicators, drawings, timeframe, layout, theme — via tool calls
  (`claude-opus-5-5`, key kept on the server; Undo reverts the last request)

## Shortcuts

Alt+T trend · Alt+H horizontal · Alt+V vertical · Alt+F fib · Shift+click measure · Alt+R reset view · Alt+A price alert · Esc cancel ·
Delete remove drawing · type to search symbols · Replay: Shift+→ step, Shift+← back, Space play/pause
