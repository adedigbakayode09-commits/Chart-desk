// "Ask Claude" chart assistant — backend half.
//
// The browser owns the conversation and executes the tools against the live chart; this module only
// forwards each turn to the Claude API so the API key never reaches the browser. Credentials come from
// the SDK's standard resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).

import Anthropic from '@anthropic-ai/sdk';

// Default: Claude Haiku 5.5 keeps each chart request under ~1¢. Set ANTHROPIC_MODEL=claude-opus-5-5 in .env for
// the most capable model (~2–4¢ per request).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
// USD per million tokens (input, output, cache read, cache write) for the cost readout.
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-sonnet-5-5': [2, 10, 0.2, 2.5], 'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
};
function estimateCost(usage, model) {
  const [i, o, cr, cw] = PRICES[model] || PRICES[MODEL] || PRICES['claude-opus-5-5'];
  return ((usage.input_tokens || 0) * i + (usage.output_tokens || 0) * o + (usage.cache_read_input_tokens || 0) * cr + (usage.cache_creation_input_tokens || 0) * cw) / 1e6;
}

const SYSTEM = `You are the chart assistant inside ChartDesk, a professional charting and backtesting app.
The user asks you to change or analyse their chart; you do it by calling the tools, which act on the user's active chart.

How to work:
- Keep usage low: for simple edits (indicators, timeframe, theme, layout) act directly without reading the chart. Call get_chart_state only when you need prices, ids or candles, and request only as many candles as the task needs (often 0–60).
- Call get_chart_state whenever you need facts about the chart (symbol, timeframe, indicators, drawings, recent candles, price range). Never guess prices or times; base levels on the candles it returns.
- Times are ISO 8601 in UTC (e.g. "2026-10-01T13:00:00Z"). Prices are in the instrument's quote currency.
- Make the requested change with the fewest tool calls, then reply with one or two short sentences saying what you changed. If something can't be done with the tools, say so plainly instead of guessing.
- During Bar Replay the chart only contains candles up to the replay cursor. Do not speculate about prices after it.
- You edit charts and explain what is on them. You don't give personalised investment advice or recommend trades as financial advice; you may describe technical levels and patterns when asked.
- If you use a tool, you may say a brief sentence first. Do not include internal or system XML tags in your response.`;

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const color = nullable({ type: 'string', description: 'Hex colour like "#2962ff", or null for the default' });
const time = (d) => ({ type: 'string', description: d || 'ISO 8601 UTC timestamp' });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
const INDICATORS = ['VOL', 'SMA', 'EMA', 'WMA', 'HMA', 'VWMA', 'VWAP', 'SUPERTREND', 'PSAR', 'ICHIMOKU', 'BB', 'KC', 'DC', 'PIVOTS', 'VPVR',
  'RSI', 'MACD', 'STOCH', 'STOCHRSI', 'CCI', 'WILLR', 'MOM', 'ROC', 'AO', 'ADX', 'AROON', 'ATR', 'STDEV', 'OBV', 'MFI', 'CMF'];
// Indicator parameters are plain optional fields (omit = default / unchanged). These two tools aren't `strict`:
// strict schemas allow at most 16 nullable/union parameters per request, and the browser validates them anyway.
const paramProps = {
  length: { type: 'integer', description: 'SMA/EMA/BB/RSI/ATR length' },
  mult: { type: 'number', description: 'Bollinger Band standard-deviation multiplier' },
  fast: { type: 'integer', description: 'MACD fast length' },
  slow: { type: 'integer', description: 'MACD slow length' },
  signal: { type: 'integer', description: 'MACD signal length' },
  k: { type: 'integer', description: 'Stochastic %K length' },
  smooth: { type: 'integer', description: 'Stochastic %K smoothing' },
  d: { type: 'integer', description: 'Stochastic %D length' },
  atr: { type: 'integer', description: 'Keltner Channels ATR length' },
  start: { type: 'number', description: 'Parabolic SAR start' },
  inc: { type: 'number', description: 'Parabolic SAR increment' },
  max: { type: 'number', description: 'Parabolic SAR maximum' },
  conversion: { type: 'integer', description: 'Ichimoku conversion line length' },
  base: { type: 'integer', description: 'Ichimoku base line length' },
  spanB: { type: 'integer', description: 'Ichimoku leading span B length' },
  displacement: { type: 'integer', description: 'Ichimoku displacement' },
  type: { type: 'string', description: 'Pivot points type: traditional, fibonacci, camarilla or woodie' },
  rows: { type: 'integer', description: 'Volume profile rows' },
  va: { type: 'number', description: 'Volume profile value area %' },
  rsi: { type: 'integer', description: 'Stochastic RSI: RSI length' },
  stoch: { type: 'integer', description: 'Stochastic RSI: stochastic length' },
  di: { type: 'integer', description: 'DMI: DI length' },
  adx: { type: 'integer', description: 'DMI: ADX smoothing' },
};
const optionalObj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

// Kept in a fixed order so the tools prefix stays byte-identical across requests (prompt caching).
export const TOOLS = [
  { name: 'get_chart_state', description: 'Read the active chart: symbol, timeframe, chart type, indicators (with ids and current values), drawings (with ids), visible range, replay status, and the most recent candles (up to `candles`).',
    input_schema: obj({ candles: { type: 'integer', description: 'Recent candles to include (0-200). Use 0 unless you need prices; most tasks need 60 or fewer.' } }) },
  { name: 'set_symbol', description: 'Switch the active chart to another symbol (e.g. XAUUSD, EURUSD, US500, BTCUSDT).',
    input_schema: obj({ symbol: { type: 'string' } }) },
  { name: 'set_timeframe', description: 'Change the active chart timeframe.',
    input_schema: obj({ timeframe: { type: 'string', enum: TIMEFRAMES } }) },
  { name: 'set_chart_type', description: 'Change how prices are drawn.',
    input_schema: obj({ chart_type: { type: 'string', enum: ['candles', 'hollow', 'bars', 'ha', 'columns', 'highlow', 'line', 'linemarkers', 'step', 'area', 'baseline', 'renko', 'linebreak', 'kagi', 'pnf', 'range'] } }) },
  { name: 'add_indicator', description: 'Add an indicator. Omit params to use defaults. VOL, moving averages (SMA, EMA, WMA, HMA, VWMA), VWAP, SUPERTREND, PSAR, ICHIMOKU, BB, KC (Keltner), DC (Donchian), PIVOTS and VPVR (volume profile) draw on the price chart; the oscillators (RSI, MACD, STOCH, STOCHRSI, CCI, WILLR, MOM, ROC, AO, ADX/DMI, AROON, ATR, STDEV, OBV, MFI, CMF) get their own pane.',
    strict: false,
    input_schema: optionalObj({ type: { type: 'string', enum: INDICATORS }, ...paramProps, color: { type: 'string', description: 'Hex colour like "#2962ff"' } }, ['type']) },
  { name: 'update_indicator', description: 'Change an existing indicator by id (from get_chart_state). Omitted fields are left unchanged.',
    strict: false,
    input_schema: optionalObj({ id: { type: 'string' }, ...paramProps, color: { type: 'string', description: 'Hex colour like "#2962ff"' }, visible: { type: 'boolean' } }, ['id']) },
  { name: 'remove_indicator', description: 'Remove an indicator by id.',
    input_schema: obj({ id: { type: 'string' } }) },
  { name: 'draw_horizontal_line', description: 'Draw a horizontal price level across the chart.',
    input_schema: obj({ price: { type: 'number' }, color }) },
  { name: 'draw_vertical_line', description: 'Draw a vertical line at a time.',
    input_schema: obj({ time: time(), color }) },
  { name: 'draw_trend_line', description: 'Draw a line between two points. extend_right=true makes it a ray.',
    input_schema: obj({ start_time: time(), start_price: { type: 'number' }, end_time: time(), end_price: { type: 'number' }, extend_right: { type: 'boolean' }, color }) },
  { name: 'draw_rectangle', description: 'Draw a rectangle (zone) between two corners.',
    input_schema: obj({ start_time: time(), start_price: { type: 'number' }, end_time: time(), end_price: { type: 'number' }, color }) },
  { name: 'draw_fibonacci', description: 'Draw a Fibonacci retracement from the swing start to the swing end (levels 0–1).',
    input_schema: obj({ start_time: time(), start_price: { type: 'number' }, end_time: time(), end_price: { type: 'number' } }) },
  { name: 'draw_position', description: 'Draw a long or short position tool (entry, stop-loss, take-profit zones with risk/reward).',
    input_schema: obj({ side: { type: 'string', enum: ['long', 'short'] }, entry_time: time(), entry_price: { type: 'number' }, stop_price: { type: 'number' }, target_price: { type: 'number' }, end_time: time('ISO 8601 UTC time where the box ends') }) },
  { name: 'add_text', description: 'Place a text note on the chart.',
    input_schema: obj({ time: time(), price: { type: 'number' }, text: { type: 'string' }, color }) },
  { name: 'remove_drawings', description: 'Remove drawings by id, or all drawings on this symbol when ids is null.',
    input_schema: obj({ ids: nullable({ type: 'array', items: { type: 'string' } }) }) },
  { name: 'set_visible_range', description: 'Scroll/zoom the chart to show a time range.',
    input_schema: obj({ from: time(), to: time() }) },
  { name: 'set_price_scale', description: 'Set the price scale mode.',
    input_schema: obj({ mode: { type: 'string', enum: ['normal', 'log', 'percent'] } }) },
  { name: 'set_layout', description: 'Set how many charts are shown: 1, 2v (side by side), 2h (stacked), 3, or 4.',
    input_schema: obj({ layout: { type: 'string', enum: ['1', '2v', '2h', '3', '4'] } }) },
  { name: 'set_theme', description: 'Switch between dark and light theme.',
    input_schema: obj({ theme: { type: 'string', enum: ['dark', 'light'] } }) },
].map(t => ({ ...t, strict: t.strict !== false }));

let client = null;
const anthropic = () => (client ||= new Anthropic({ maxRetries: 2 }));

export function assistantStatus() {
  const configured = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  return { model: MODEL, configured, note: configured ? null : 'Set ANTHROPIC_API_KEY (or sign in with `ant auth login`) in the shell that starts ChartDesk, then restart it.' };
}

/** One turn: the browser sends the whole (append-only) history and gets Claude's next message back. */
export async function assistantTurn(messages) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages required'), { status: 400 });
  try {
    const res = await anthropic().beta.messages.create({
      model: MODEL,
      // Low usage: chart edits are short tool-calling turns, so low effort and a modest output cap suffice.
      max_tokens: 4096,
      output_config: { effort: 'low' },
      // Cache the whole prefix (tools + system + earlier turns) so each loop step / follow-up re-reads it cheaply.
      cache_control: { type: 'ephemeral' },
      // Server-side refusal fallback exists for Opus/Sonnet only (Haiku 5.5 has none and rejects the parameter).
      ...(/haiku/.test(MODEL) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    });
    return { content: res.content, stop_reason: res.stop_reason, stop_details: res.stop_details ?? null, model: res.model, usage: res.usage, costUsd: estimateCost(res.usage || {}, res.model) };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('Claude rejected the API key. Check ANTHROPIC_API_KEY and restart ChartDesk.'), { status: 401 });
    if (e instanceof Anthropic.PermissionDeniedError) throw Object.assign(new Error(`Your Anthropic account can't use ${MODEL}: ${e.message}`), { status: 403 });
    if (e instanceof Anthropic.RateLimitError) throw Object.assign(new Error('Claude rate limit reached — wait a moment and try again.'), { status: 429 });
    if (e instanceof Anthropic.BadRequestError) throw Object.assign(new Error(`Claude couldn't process the request: ${e.message}`), { status: 400 });
    if (e instanceof Anthropic.APIConnectionError) throw Object.assign(new Error('Could not reach the Claude API — check your internet connection.'), { status: 502 });
    if (e instanceof Anthropic.APIError) throw Object.assign(new Error(`Claude API error ${e.status}: ${e.message}`), { status: 502 });
    // No credentials at all surfaces as a plain error from the client before any request is sent.
    throw Object.assign(new Error(`${e.message}. ${assistantStatus().note || ''}`.trim()), { status: 500 });
  }
}
