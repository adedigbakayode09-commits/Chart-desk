// Instrument catalog shared by the server and (via /api/symbols) the browser.
//
// Dukascopy prices in the tick archive are stored as integers; `point` is the divisor that turns them
// into prices (Dukascopy's export guide: 100 000 for most FX, 1 000 for JPY pairs; metals/indices/crypto
// use the factors below and are sanity-checked against `range` on import so a wrong factor fails loudly
// instead of producing a silently mis-scaled chart).
//
// `td` is the Twelve Data symbol (server/twelvedata.js); symbols with both `td` and `s3` can use either source.
//
// Trading specs drive P&L: pnl(quote ccy) = (exit - entry) * qtyUnits, where qtyUnits = lots * contractSize.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let dukaMeta = {};
try { ({ instrumentMetaData: dukaMeta } = require('dukascopy-node')); } catch { /* optional metadata only */ }

const fx = (symbol, name, extra = {}) => ({
  symbol, name, market: 'Forex', type: 'forex', provider: 'dukascopy', session: 'fx',
  point: 100000, precision: 5, tickSize: 0.00001, pip: 0.0001, contractSize: 100000, lotName: 'lot (100,000 units)',
  defaultSpread: 0.00012, commissionPerLot: 7, range: [0.3, 3], ...extra,
});

export const CATALOG = [
  {
    symbol: 'XAUUSD', name: 'Gold / US Dollar', market: 'Precious Metals', type: 'metal', provider: 'dukascopy', session: 'fx',
    base: 'XAU', quote: 'USD', dk: 'xauusd', s3: 'XAUUSD', td: 'XAU/USD', point: 1000, precision: 3, tickSize: 0.001, pip: 0.1,
    contractSize: 100, lotName: 'lot (100 oz)', defaultSpread: 0.3, commissionPerLot: 7, range: [200, 20000],
  },
  {
    symbol: 'XAGUSD', name: 'Silver / US Dollar', market: 'Precious Metals', type: 'metal', provider: 'dukascopy', session: 'fx',
    base: 'XAG', quote: 'USD', dk: 'xagusd', s3: 'XAGUSD', td: 'XAG/USD', point: 1000, precision: 3, tickSize: 0.001, pip: 0.01,
    contractSize: 5000, lotName: 'lot (5,000 oz)', defaultSpread: 0.03, commissionPerLot: 7, range: [2, 500],
  },
  fx('EURUSD', 'Euro / US Dollar', { base: 'EUR', quote: 'USD', dk: 'eurusd', s3: 'EURUSD', td: 'EUR/USD' }),
  fx('GBPUSD', 'British Pound / US Dollar', { base: 'GBP', quote: 'USD', dk: 'gbpusd', s3: 'GBPUSD', td: 'GBP/USD', range: [0.5, 3] }),
  fx('AUDUSD', 'Australian Dollar / US Dollar', { base: 'AUD', quote: 'USD', dk: 'audusd', s3: 'AUDUSD', td: 'AUD/USD', range: [0.2, 2] }),
  fx('NZDUSD', 'New Zealand Dollar / US Dollar', { base: 'NZD', quote: 'USD', dk: 'nzdusd', s3: 'NZDUSD', td: 'NZD/USD', range: [0.2, 2] }),
  fx('USDJPY', 'US Dollar / Japanese Yen', { base: 'USD', quote: 'JPY', dk: 'usdjpy', s3: 'USDJPY', td: 'USD/JPY', point: 1000, precision: 3, tickSize: 0.001, pip: 0.01, defaultSpread: 0.012, range: [50, 400] }),
  fx('USDCHF', 'US Dollar / Swiss Franc', { base: 'USD', quote: 'CHF', dk: 'usdchf', s3: 'USDCHF', td: 'USD/CHF', range: [0.4, 3] }),
  fx('USDCAD', 'US Dollar / Canadian Dollar', { base: 'USD', quote: 'CAD', dk: 'usdcad', s3: 'USDCAD', td: 'USD/CAD', range: [0.7, 3] }),
  {
    symbol: 'US500', name: 'US 500 Index', market: 'Indices', type: 'index', provider: 'dukascopy', session: 'fx',
    base: 'US500', quote: 'USD', dk: 'usa500idxusd', s3: 'USA500IDXUSD', point: 1000, precision: 2, tickSize: 0.01, pip: 1,
    contractSize: 1, lotName: 'contract ($1 / point)', defaultSpread: 0.5, commissionPerLot: 0, range: [500, 20000],
  },
  {
    symbol: 'US30', name: 'US Wall Street 30 Index', market: 'Indices', type: 'index', provider: 'dukascopy', session: 'fx',
    base: 'US30', quote: 'USD', dk: 'usa30idxusd', s3: 'USA30IDXUSD', point: 1000, precision: 2, tickSize: 0.01, pip: 1,
    contractSize: 1, lotName: 'contract ($1 / point)', defaultSpread: 2, commissionPerLot: 0, range: [5000, 100000],
  },
  {
    symbol: 'NAS100', name: 'US Tech 100 Index', market: 'Indices', type: 'index', provider: 'dukascopy', session: 'fx',
    base: 'NAS100', quote: 'USD', dk: 'usatechidxusd', s3: 'USATECHIDXUSD', point: 1000, precision: 2, tickSize: 0.01, pip: 1,
    contractSize: 1, lotName: 'contract ($1 / point)', defaultSpread: 1.5, commissionPerLot: 0, range: [500, 60000],
  },
  {
    symbol: 'BTCUSD', name: 'Bitcoin / US Dollar (Dukascopy)', market: 'Crypto', type: 'crypto', provider: 'dukascopy', session: 'crypto',
    base: 'BTC', quote: 'USD', dk: 'btcusd', s3: 'BTCUSD', point: 10, precision: 1, tickSize: 0.1, pip: 1,
    contractSize: 1, lotName: 'BTC', defaultSpread: 30, commissionPerLot: 0, commissionPct: 0.1, range: [100, 1000000],
  },
  {
    symbol: 'ETHUSD', name: 'Ether / US Dollar (Dukascopy)', market: 'Crypto', type: 'crypto', provider: 'dukascopy', session: 'crypto',
    base: 'ETH', quote: 'USD', dk: 'ethusd', s3: 'ETHUSD', point: 10, precision: 1, tickSize: 0.1, pip: 1,
    contractSize: 1, lotName: 'ETH', defaultSpread: 2, commissionPerLot: 0, commissionPct: 0.1, range: [10, 100000],
  },
];

// Binance spot pairs: live data straight from Binance's public REST/WebSocket API in the browser.
const BINANCE = [
  ['BTCUSDT', 'Bitcoin / TetherUS'], ['ETHUSDT', 'Ethereum / TetherUS'], ['SOLUSDT', 'Solana / TetherUS'],
  ['BNBUSDT', 'BNB / TetherUS'], ['XRPUSDT', 'XRP / TetherUS'], ['DOGEUSDT', 'Dogecoin / TetherUS'],
  ['ADAUSDT', 'Cardano / TetherUS'], ['AVAXUSDT', 'Avalanche / TetherUS'], ['LINKUSDT', 'Chainlink / TetherUS'],
  ['DOTUSDT', 'Polkadot / TetherUS'], ['TRXUSDT', 'TRON / TetherUS'], ['LTCUSDT', 'Litecoin / TetherUS'],
  ['BCHUSDT', 'Bitcoin Cash / TetherUS'], ['NEARUSDT', 'NEAR Protocol / TetherUS'], ['UNIUSDT', 'Uniswap / TetherUS'],
  ['ATOMUSDT', 'Cosmos / TetherUS'], ['XLMUSDT', 'Stellar / TetherUS'], ['APTUSDT', 'Aptos / TetherUS'],
  ['ARBUSDT', 'Arbitrum / TetherUS'], ['OPUSDT', 'Optimism / TetherUS'], ['SUIUSDT', 'Sui / TetherUS'],
  ['AAVEUSDT', 'Aave / TetherUS'], ['PEPEUSDT', 'Pepe / TetherUS'], ['SHIBUSDT', 'Shiba Inu / TetherUS'],
  ['PAXGUSDT', 'PAX Gold / TetherUS'], ['ETHBTC', 'Ethereum / Bitcoin'],
];
for (const [symbol, name] of BINANCE) {
  const quote = symbol.endsWith('USDT') ? 'USDT' : 'BTC';
  CATALOG.push({
    symbol, name, market: 'Crypto', type: 'crypto', provider: 'binance', session: 'crypto',
    base: symbol.slice(0, -quote.length), quote, precision: null, tickSize: null, pip: null,
    contractSize: 1, lotName: symbol.slice(0, -quote.length), defaultSpread: 0, commissionPerLot: 0, commissionPct: 0.1,
  });
}

for (const s of CATALOG) {
  const m = s.dk && dukaMeta[s.dk];
  if (m) s.firstMinute = m.startDayForMinuteCandles;
}

// TradingView feeds (unofficial, anonymous — see server/tvsource.js): Pepperstone's prices for the CFDs and forex.
const TV_FEED = { XAUUSD: 'PEPPERSTONE:XAUUSD', XAGUSD: 'PEPPERSTONE:XAGUSD', US500: 'PEPPERSTONE:US500', US30: 'PEPPERSTONE:US30', NAS100: 'PEPPERSTONE:NAS100', BTCUSD: 'BITSTAMP:BTCUSD', ETHUSD: 'BITSTAMP:ETHUSD' };
for (const s of CATALOG) {
  if (TV_FEED[s.symbol]) s.tv = TV_FEED[s.symbol];
  else if (s.type === 'forex') s.tv = `PEPPERSTONE:${s.symbol}`;
}

export const bySymbol = Object.fromEntries(CATALOG.map(s => [s.symbol, s]));

/** Add a symbol at runtime (Twelve Data stocks / ETFs looked up from symbol search). */
export function addSymbol(entry) {
  if (bySymbol[entry.symbol]) return bySymbol[entry.symbol];
  CATALOG.push(entry);
  bySymbol[entry.symbol] = entry;
  return entry;
}
