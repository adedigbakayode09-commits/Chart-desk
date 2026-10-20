// Drag-and-drop data import: drop Dukascopy / MetaTrader CSV files anywhere on ChartDesk.
// The symbol, price side (bid/ask) and timezone are read from the file name when possible
// (e.g. "XAU-USD_1Minute_BID_2025-07-11_00_00-23_59_Etc_UTC.csv"); otherwise the active chart's symbol is used.

import { h, api, toast, fmtDate } from './util.js';
import { SYMBOLS, spec, invalidateMinutes, refreshCoverage, setSource } from './data.js';

/** Work out { symbol, side, tz } from a file name. */
export function detectFromName(name, fallbackSymbol) {
  const flat = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const importable = SYMBOLS.filter(s => s.provider === 'dukascopy' || s.s3 || s.dk);
  const hit = importable.map(s => s.symbol).sort((a, b) => b.length - a.length).find(sym => flat.includes(sym));
  const side = /(^|[^a-z])ask([^a-z]|$)/i.test(name) ? 'ask' : 'bid';
  let tz = 'UTC';
  const tzm = /(Etc[_/]UTC|GMT[+-]?\d*|UTC|EET|Europe[_/][A-Za-z]+|America[_/][A-Za-z]+)/i.exec(name);
  if (tzm && /eet/i.test(tzm[1])) tz = 'EET';
  else if (tzm && /^(europe|america)/i.test(tzm[1])) tz = tzm[1].replace('_', '/');
  return { symbol: hit || fallbackSymbol, side, tz, guessed: !hit };
}

export function wireDropImport(app) {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', null,
    h('b', null, 'Drop CSV files to import'),
    h('span', null, 'Dukascopy or MetaTrader 1-minute data (symbol, bid/ask and timezone from the file name) — or a shared .chartdesk.json chart')));
  document.body.append(overlay);
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; overlay.hidden = false; });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; overlay.hidden = true;
    const charts = [...e.dataTransfer.files].filter(f => /\.json$/i.test(f.name));
    for (const f of charts) await app.share.importText(await f.text(), f.name); // shared .chartdesk.json charts
    const files = [...e.dataTransfer.files].filter(f => /\.(csv|txt)$/i.test(f.name));
    if (!files.length) { if (!charts.length) toast('Drop .csv data files (Dukascopy / MetaTrader) or a .chartdesk.json chart', 'error'); return; }
    await importFiles(app, files);
  });
}

async function importFiles(app, files) {
  const fallback = app.activeView?.symbol;
  // bid files first, so ask files can attach spreads to existing minutes
  const plan = files.map(f => ({ f, ...detectFromName(f.name, fallback) })).sort((a, b) => (a.side === 'ask') - (b.side === 'ask'));
  const touched = new Set();
  let ok = 0, failed = 0, rows = 0;
  for (const [k, p] of plan.entries()) {
    if (!spec(p.symbol)) { failed++; toast(`${p.f.name}: couldn't tell which symbol this is — open that symbol's chart and drop it again`, 'error'); continue; }
    toast(`Importing ${k + 1}/${plan.length}: ${p.f.name} → ${p.symbol} (${p.side})…`);
    try {
      const res = await api(`/api/import?symbol=${p.symbol}&side=${p.side}&tz=${encodeURIComponent(p.tz)}`, { method: 'POST', body: p.f, headers: { 'content-type': 'text/csv' } });
      ok++; rows += res.rows || 0; touched.add(p.symbol);
      p.res = res;
    } catch (err) { failed++; toast(`${p.f.name}: ${err.message}`, 'error'); await new Promise(r => setTimeout(r, 1500)); }
  }
  if (!touched.size) return;
  for (const s of touched) invalidateMinutes(s);
  await refreshCoverage();
  const ranges = plan.filter(p => p.res).map(p => p.res);
  const from = Math.min(...ranges.map(r => r.from)), to = Math.max(...ranges.map(r => r.to));
  const syms = [...touched];
  // Show the imported data: switch the symbol to Dukascopy when the live source is something else.
  const switchable = syms.filter(s => spec(s)?.provider !== 'dukascopy' && (spec(s)?.sources || []).includes('dukascopy'));
  toast(`Imported ${rows.toLocaleString()} one-minute candles from ${ok} file${ok === 1 ? '' : 's'} for ${syms.join(', ')} (${fmtDate(from)} → ${fmtDate(to)})${failed ? ` · ${failed} failed` : ''}.`, 'good',
    switchable.length ? [{ label: 'Show on chart', onClick: async () => {
      for (const s of switchable) await setSource(s, 'dukascopy');
      await refreshCoverage();
      const v = app.activeView;
      if (v && !syms.includes(v.symbol)) v.setSymbol(syms[0]); else v?.load();
      toast(`${syms.join(', ')} now uses your imported data. Switch back to Twelve Data in Data for live prices.`);
    } }] : []);
  for (const v of app.views) if (touched.has(v.symbol)) v.load();
  app.watchlist?.refreshHistorical();
}
