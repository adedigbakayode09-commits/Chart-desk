# Gold NY Open Breakout (XAUUSD, 1-minute)

Strategy Tester: **Gold NY Open Breakout (1m)** · Chart indicator: **Indicators → Community scripts → Gold NY Open Breakout** (identical signals).

## Rules
1. **Range** — high and low of the first **60 minutes after the COMEX gold open, 08:20 New York time** (daylight-saving handled; 12:20/13:20 UTC).
2. **Entry** — during the next **60 minutes**, the first 1-minute candle that **closes above the range high + 0.5 × ATR(60)** goes long, or **below the range low − 0.5 × ATR(60)** goes short. One trade per day. The order fills at the next candle's open.
3. **Stop** — the **midpoint of the range**.
4. **Target** — **2R** (twice the entry-to-stop distance).
5. **Time exit** — anything still open **two hours after the entry window** (12:20 New York) is closed.
6. **Size** — 0.5% of equity at risk per trade.

Optional: *Also trade London* adds a breakout of the Asian range (19:00–03:00 New York) between 03:00 and 06:00, flat by 08:00. It adds trades but has a much weaker edge (see below), so it is off by default.

## How it was chosen
- Data: Twelve Data 1-minute XAUUSD, 5 Jan – 13 Oct 2026 (277,800 candles after removing market-closed minutes).
- Costs in every test: $0.30 spread, $0.05 slippage on market and stop orders, $7 commission per lot round trip.
- Three ideas were tested (session opening-range breakouts at several opens, trend pullback, Asian-session mean reversion). Settings were chosen on Jan–early Jul (in-sample) and judged on early Jul–Oct (out-of-sample). Trend pullback and mean reversion failed out-of-sample and were dropped.

## Results (0.5% risk per trade, $10,000 start)
| Period | Trades | Win rate | Profit factor | Net | Max drawdown |
|---|---|---|---|---|---|
| In-sample (Jan–Jul) | 108 | 47% | 1.58 | +14.5% | 3.8% |
| Out-of-sample (Jul–Oct) | 54 | 48% | 1.83 | +9.3% | 3.1% |
| Whole period | 162 | 48% | 1.65 | +25.1% | 3.8% |

- Every calendar month Jan–Oct 2026 was profitable (+1.3% to +3.6% per month).
- Longs and shorts were both profitable. Average win $83, average loss $45, longest losing streak 6. Average time in trade ~1 hour.
- Neighbouring settings also work (open 08:00–09:30, range 45–75 min, window 30–120 min, buffer 0–1 ATR, target 1–3R), so the result is not one lucky combination. The one setting that matters: the stop at the range **midpoint** (a stop at the far side of the range lost money).
- With doubled costs ($0.60 spread, $0.15 slippage, $10 commission) the profit factor drops from 1.65 to 1.48.
- London add-on: 91 extra trades, profit factor ~1.2, about +2% over the 9 months.

## Limits — read before trading it
- **Nine months of data from one market regime.** That is a small sample; results will vary and can be worse in other conditions.
- The range hour contains the **08:30 New York US data releases** (CPI, payrolls…). Real fills around news can be worse than the simulated slippage.
- Twelve Data candles are a composite feed, not your broker's prices.
- Only valid on the **1-minute chart** (the tester warns on other timeframes).
- Past results do not guarantee future results. This is not financial advice — practise it in Bar Replay or on a demo account first.
