// Per-symbol feed choices. Validate a feed before replacing a working selection.
const aliases = {NAS100:['NAS100USD','USTEC','US100','NDXUSD'],US30:['US30USD','DJ30','DJIUSD','WS30'],US500:['SPX500USD','SP500','SPX500','SPXUSD']};
export function compatibleFeed(s, feed) {
  const normalize = v => String(v || '').toUpperCase().split(':').pop().replace(/[^A-Z0-9!]/g,'');
  const base = normalize(s?.symbol), target = normalize(feed);
  return new Set([base,normalize(s?.tv),...(aliases[base] || [])]).has(target);
}
export function createFeedManager({ catalog, describe, load, save, invalidate }) {
  let choices = {};
  let queue = Promise.resolve();
  return {
    async init() {
      choices = await load() || {};
      for (const [symbol, value] of Object.entries(choices)) if (catalog[symbol] && value?.tv) Object.assign(catalog[symbol], value);
    },
    set(symbol, feed) {
      const task = queue.then(async () => {
        const s = catalog[symbol];
        if (!s || s.provider === 'binance') throw Object.assign(new Error('Choose a server-backed symbol'), {status:400});
        if (!compatibleFeed(s,feed)) throw Object.assign(new Error('That is a different instrument. Open it through Symbol Search instead.'),{status:400});
        const value = await describe(feed);
        const next = {...choices, [symbol]:value};
        await save(next);
        choices = next;
        Object.assign(s, value);
        invalidate(symbol);
        return {symbol, ...value};
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
