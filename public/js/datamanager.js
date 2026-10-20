// Data manager: data source per symbol, Twelve Data status/cache, Dukascopy tick-archive downloads and CSV import.

import { $, h, icon, api, toast, openModal, confirmBox, fmtDate, fmtNum } from './util.js';
import { SYMBOLS, spec, refreshCoverage, invalidateMinutes, setSource, providerLabel, tfLabel } from './data.js';

const fmtBytes = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);
const ymNow = () => new Date().toISOString().slice(0, 7);
const ymShift = (ym, d) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7); };

export class DataManager {
  constructor(app) {
    this.app = app;
    this.modal = $('#dataModal');
    this.body = $('#dataBody');
    this.symbol = 'XAUUSD';
  }

  async open(symbol) {
    if (symbol && spec(symbol) && spec(symbol).provider !== 'binance') this.symbol = symbol;
    openModal(this.modal);
    if (!this.body.children.length) this.body.replaceChildren(h('div', { class: 'loader-inline' }, 'Loading data inventory…'));
    await refreshCoverage(); // downloads/imports may have finished since the page loaded
    await this.render();
    this.poll();
  }

  async render() {
    const listed = SYMBOLS.filter(x => x.provider !== 'binance');
    const s = spec(this.symbol);
    const [cov, aws, jobs, tds] = await Promise.all([
      api(`/api/coverage?symbol=${this.symbol}`),
      s.hasDukascopy ? api('/api/s3/status').catch(e => ({ ok: false, error: e.message })) : { ok: false },
      api('/api/jobs'),
      s.td ? api(`/api/td/status?symbol=${this.symbol}`).catch(e => ({ error: e.message })) : null,
    ]);
    this.jobsBox = h('div', { class: 'jobs' });
    const symSub = x => (x.provider === 'twelvedata'
      ? (x.tdCoverage?.rows ? `Twelve Data · to ${fmtDate(x.tdCoverage.last)}` : 'Twelve Data')
      : x.provider === 'tradingview' ? x.tv : (x.coverage?.months ? `Dukascopy · ${x.coverage.months} mo` : 'Dukascopy · no data'));
    const symList = h('div', { class: 'dm-symbols' }, listed.map(x => h('button', {
      class: 'dm-sym' + (x.symbol === this.symbol ? ' active' : ''), onclick: () => { this.symbol = x.symbol; this.render(); },
    }, h('b', null, x.symbol), h('small', null, symSub(x)))));
    const sourceBox = s.sources?.length > 1 ? h('div', { class: 'source-switch' },
      h('span', { class: 'muted' }, 'Data source for this symbol:'),
      ...s.sources.map(src => h('button', { class: 'chip' + (s.provider === src ? ' active' : ''), onclick: async () => {
        if (src === s.provider) return;
        await setSource(this.symbol, src);
        toast(`${this.symbol} now uses ${providerLabel(src)} data`);
        await this.render();
        for (const v of this.app.views) if (v.symbol === this.symbol) v.load();
        this.app.watchlist?.refreshHistorical();
      } }, providerLabel(src))),
      s.sources.includes('tradingview') ? h('p', { class: 'muted small tv-note' }, h('b', null, 'TradingView'), ` (${s.tv}): live prices about once a second and recent candles, no API credits, no account. `,
        'It uses an unofficial community library, not an official TradingView API — TradingView does not allow this use, so it can stop working at any time. ',
        'Bar Replay and long backtests need Twelve Data or Dukascopy history.') : null) : null;
    const tdSection = s.td ? this.renderTwelveData(s, tds) : null;

    // ---- S3 download
    const from = h('input', { type: 'month', value: ymShift(ymNow(), -3), min: (s.firstMinute || '2003-05').slice(0, 7), max: ymNow() });
    const to = h('input', { type: 'month', value: ymNow(), max: ymNow() });
    const skip = h('input', { type: 'checkbox', checked: true });
    this.estimateBox = h('div', { class: 'estimate muted' });
    const awsBox = aws.ok
      ? h('div', { class: 'aws ok' }, icon('database'), h('span', null, `AWS credentials found (${aws.keyHint}). Bucket ${aws.bucket} · ${aws.region} · Requester Pays — downloads are billed to your AWS account (cents per symbol-year).`))
      : h('div', { class: 'aws missing' },
        h('b', null, 'AWS credentials not configured'),
        h('p', null, 'Dukascopy publishes its historical tick archive in a Requester-Pays S3 bucket, so downloads need your own AWS account. ChartDesk never asks for your keys — it uses the standard AWS credential chain. Set one up, then restart ChartDesk:'),
        h('ol', null,
          h('li', null, 'Create an IAM user (or SSO profile) with s3:GetObject and s3:ListBucket.'),
          h('li', null, 'Run ', h('code', null, 'aws configure'), ' (or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE in the shell that starts ChartDesk).'),
          h('li', null, 'Restart with ', h('code', null, 'npm start'), ' and reopen this dialog.')),
        h('p', { class: 'muted' }, `Details: ${aws.error || 'no credentials'} · Free alternative: import Dukascopy CSV exports below.`));
    const download = h('section', { class: 'dm-section' },
      h('h4', null, icon('download'), 'Download from Dukascopy tick archive'),
      awsBox,
      h('div', { class: 'dm-row' },
        h('label', { class: 'field' }, h('span', null, 'From month'), from),
        h('label', { class: 'field' }, h('span', null, 'To month'), to),
        h('label', { class: 'field check' }, skip, h('span', null, 'Skip months already downloaded')),
        h('button', { class: 'btn', disabled: !aws.ok, onclick: () => this.estimate(from.value, to.value) }, 'Estimate cost'),
        h('button', { class: 'btn primary', disabled: !aws.ok, onclick: () => this.startDownload(from.value, to.value, skip.checked) }, icon('download'), 'Download')),
      this.estimateBox,
      h('p', { class: 'muted small' }, `Ticks are decoded into genuine 1-minute bid candles with the real average bid/ask spread of each minute. ${s.firstMinute ? `${s.symbol} history starts ${fmtDate(Date.parse(s.firstMinute) / 1000)}.` : ''}`));

    // ---- CSV import
    const file = h('input', { type: 'file', accept: '.csv,.txt', multiple: true });
    const side = h('select', null, h('option', { value: 'bid' }, 'BID prices (main chart data)'), h('option', { value: 'ask' }, 'ASK prices (adds real spread to existing bid data)'));
    const tz = h('select', null, h('option', { value: 'UTC' }, 'UTC / GMT'), h('option', { value: 'EET' }, 'EET (Eastern European, with DST)'),
      h('option', { value: '-300' }, 'UTC−5 fixed'), h('option', { value: '120' }, 'UTC+2 fixed'), h('option', { value: '180' }, 'UTC+3 fixed'));
    this.importLog = h('div', { class: 'import-log' });
    const csv = h('section', { class: 'dm-section' },
      h('h4', null, icon('upload'), 'Import Dukascopy CSV (free)'),
      h('p', { class: 'muted small' }, 'On dukascopy.com → Historical Data Feed choose the instrument, ', h('b', null, '1 Minute'), ' timeframe, BID (and optionally ASK) and ', h('b', null, 'GMT'), ' time, then download CSV. Files that use local time with a “GMT+0200” suffix are converted automatically. Weekend flat candles are discarded; non-1-minute files are rejected.'),
      h('div', { class: 'dm-row' },
        h('label', { class: 'field grow' }, h('span', null, 'CSV file(s)'), file),
        h('label', { class: 'field' }, h('span', null, 'Price side'), side),
        h('label', { class: 'field' }, h('span', null, 'Timezone of rows without offset'), tz),
        h('button', { class: 'btn primary', onclick: () => this.importFiles([...file.files], side.value, tz.value) }, icon('upload'), 'Import')),
      this.importLog);

    // ---- coverage
    const months = cov.months.slice().reverse();
    const checks = new Map();
    const covTable = months.length ? h('div', { class: 'tp-table cov' }, h('table', null,
      h('thead', null, h('tr', null, ['', 'Month', 'Minutes', 'First', 'Last', 'With spread', 'Source', 'Updated'].map(x => h('th', null, x)))),
      h('tbody', null, months.map(m => {
        const c = h('input', { type: 'checkbox' });
        checks.set(m.ym, c);
        return h('tr', null, h('td', null, c), h('td', null, m.ym), h('td', null, m.rows.toLocaleString()), h('td', null, new Date(m.first * 1000).toISOString().slice(0, 16).replace('T', ' ')),
          h('td', null, new Date(m.last * 1000).toISOString().slice(0, 16).replace('T', ' ')),
          h('td', null, `${fmtNum(m.withSpread / m.rows * 100, 0)}%`), h('td', null, (m.sources || []).join(', ')), h('td', { class: 'muted' }, (m.updated || '').slice(0, 10)));
      })))) : h('p', { class: 'muted' }, 'Nothing cached for this symbol yet.');
    const coverage = h('section', { class: 'dm-section' },
      h('h4', null, icon('database'), `Cached ${this.symbol} data`, cov.first ? h('span', { class: 'muted small' }, ` ${fmtDate(cov.first)} → ${fmtDate(cov.last)}`) : null),
      covTable,
      months.length ? h('button', { class: 'btn small danger', onclick: async () => {
        const sel = [...checks].filter(([, c]) => c.checked).map(([ym]) => ym);
        if (!sel.length) { toast('Tick the months to delete'); return; }
        if (!(await confirmBox(`Delete ${sel.length} cached month(s) of ${this.symbol}?`, 'Delete'))) return;
        await api(`/api/data?symbol=${this.symbol}&months=${sel.join(',')}`, { method: 'DELETE' });
        await this.afterDataChange();
      } }, icon('trash'), 'Delete selected months') : null);

    const jobsSection = h('section', { class: 'dm-section' }, h('h4', null, 'Jobs'), this.jobsBox);
    const dukaSections = s.hasDukascopy ? [h('div', { class: 'dm-divider' }, 'Dukascopy'), download, csv, coverage] : [];
    this.body.replaceChildren(h('div', { class: 'dm' }, symList, h('div', { class: 'dm-main' },
      h('div', { class: 'dm-title' }, h('h3', null, `${s.symbol} — ${s.name}`), h('span', { class: 'muted' }, `${s.market} · quote ${s.quote} · ${s.lotName}`)),
      ...[this.renderFeedPicker(s), sourceBox, tdSection, jobsSection, ...dukaSections].filter(Boolean))));
    this.renderJobs(jobs);
  }

  renderFeedPicker(s) {
    const exchange = h('select', {'aria-label':'Feed provider'},
      ['', 'OANDA','PEPPERSTONE','FXCM','FOREXCOM','ICMARKETS','TVC','BITSTAMP','BINANCE'].map(x=>h('option',{value:x},x || 'All providers')));
    const query = h('input',{value:s.tv?.split(':').slice(1).join(':') || s.symbol,placeholder:'Search a pair or EXCHANGE:SYMBOL','aria-label':'Feed search'});
    const results = h('div', {class:'feed-results'});
    const status = h('p',{class:'muted small','aria-live':'polite'});
    const section = h('section',{class:'dm-section'},h('h4',null,'Live chart feed'),
      h('p',null,`Selected: ${s.tv || 'No live feed selected'}`),
      h('div',{class:'dm-row'},query,exchange),status,results);
    let token=0;
    const search = async (offset=0) => {
      const id=++token;
      if (!offset) results.replaceChildren();
      status.textContent='Searching available feeds…';
      try {
        const list=await api(`/api/tv/search?q=${encodeURIComponent(query.value)}&exchange=${encodeURIComponent(exchange.value)}&symbol=${encodeURIComponent(s.symbol)}&offset=${offset}`);
        if (id!==token || !section.isConnected) return;
        results.querySelector('.feed-more')?.remove();
        status.textContent=list.length ? 'Choose the feed to use for this symbol. The selection is saved.' : 'No more matching feeds. Try a different provider or symbol.';
        for (const m of list) {
          const button=h('button',{class:'btn small',disabled:m.id===s.tv || m.compatible===false,onclick:async()=>{
            button.disabled=true; status.textContent=`Checking ${m.id} candles…`;
            try {
              await api('/api/tv/feed',{method:'POST',body:{symbol:s.symbol,feed:m.id}});
              invalidateMinutes(s.symbol); await refreshCoverage();
              await Promise.all(this.app.views.filter(v=>v.symbol===s.symbol).map(v=>v.load()));
              if (this.app.tester) {this.app.tester.result=null;this.app.tester.syncTarget();}
              this.app.watchlist?.refreshHistorical();
              toast(`${s.symbol} now uses ${m.id}`); await this.render();
            } catch(e) {status.textContent=e.message;button.disabled=false;}
          }},m.id===s.tv?'Selected':m.compatible===false?'Different instrument':'Use feed');
          results.append(h('div',{class:'feed-row'},h('div',null,h('b',null,m.id),h('small',null,m.description || m.symbol)),button));
        }
        if(list.length) results.append(h('button',{class:'btn small feed-more',onclick:()=>search(offset+list.length)},'Load more feeds'));
      } catch(e) {if(id===token)status.textContent=e.message;}
    };
    section.querySelector('.dm-row').append(h('button',{class:'btn',onclick:()=>search()},'Find feeds'),h('button',{class:'btn',onclick:()=>{this.modal.hidden=true;this.app.openSymbolSearch('open',exchange.value ? `${exchange.value}:` : '');}},'Browse all pairs'));
    query.addEventListener('keydown',e=>{if(e.key==='Enter')search();});
    return section;
  }

  async estimate(from, to) {
    this.estimateBox.textContent = 'Listing files in the archive…';
    try {
      const e = await api(`/api/s3/estimate?symbol=${this.symbol}&from=${from}&to=${to}`);
      this.estimateBox.textContent = `${e.files.toLocaleString()} day files, ${fmtBytes(e.bytes)} → estimated $${e.costUsd.toFixed(4)} (listing cost $${e.listingCostUsd.toFixed(5)}), using the prices quoted in Dukascopy's guide.`;
    } catch (e) { this.estimateBox.textContent = `Estimate failed: ${e.message}`; }
  }

  async startDownload(from, to, skipExisting) {
    if (!from || !to || from > to) { toast('Choose a valid month range', 'error'); return; }
    try {
      await api('/api/jobs/download', { method: 'POST', body: { symbol: this.symbol, from, to, skipExisting } });
      toast(`Download of ${this.symbol} ${from} → ${to} queued`);
      this.poll(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  async importFiles(files, side, tz) {
    if (!files.length) { toast('Choose one or more CSV files', 'error'); return; }
    for (const f of files) {
      const line = h('div', null, `${f.name}: importing…`);
      this.importLog.prepend(line);
      try {
        const res = await api(`/api/import?symbol=${this.symbol}&side=${side}&tz=${encodeURIComponent(tz)}`, { method: 'POST', body: f, headers: { 'content-type': 'text/csv' } });
        line.textContent = side === 'ask'
          ? `${f.name}: spread set on ${res.matched.toLocaleString()} of ${res.rows.toLocaleString()} minutes (${fmtDate(res.from)} → ${fmtDate(res.to)}).`
          : `${f.name}: ${res.rows.toLocaleString()} one-minute bars imported (${fmtDate(res.from)} → ${fmtDate(res.to)}), ${res.flats} flat filler rows dropped${res.skipped ? `, ${res.skipped} invalid rows skipped` : ''}.`;
        line.className = 'good';
      } catch (e) {
        line.textContent = `${f.name}: ${e.message}`;
        line.className = 'bad';
      }
    }
    await this.afterDataChange();
  }

  async afterDataChange() {
    invalidateMinutes(this.symbol);
    await refreshCoverage();
    await this.render();
    for (const v of this.app.views) if (v.symbol === this.symbol) v.load();
    this.app.watchlist?.refreshHistorical();
  }

  renderTwelveData(s, st) {
    const sec = h('section', { class: 'dm-section' }, h('h4', null, icon('database'), 'Twelve Data', s.provider === 'twelvedata' ? h('span', { class: 'badge' }, 'active source') : null));
    if (!st || st.error) { sec.append(h('p', { class: 'bad' }, st?.error || 'Status unavailable')); return sec; }
    if (!st.configured) {
      sec.append(h('div', { class: 'aws missing' },
        h('b', null, 'Twelve Data API key not configured'),
        h('p', null, "Twelve Data's free Basic plan includes XAU/USD. Your key stays on this computer — the ChartDesk server sends it, never the web page."),
        h('ol', null,
          h('li', null, 'Get a key at ', h('a', { href: 'https://twelvedata.com/pricing', target: '_blank', rel: 'noopener' }, 'twelvedata.com/pricing'), '.'),
          h('li', null, 'Copy ', h('code', null, '.env.example'), ' to ', h('code', null, '.env'), ' in the ChartDesk folder and set ', h('code', null, 'TWELVE_DATA_API_KEY=your_key'), ' (or set that environment variable).'),
          h('li', null, 'Restart with ', h('code', null, 'npm start'), ' and reopen this dialog.'))));
      return sec;
    }
    const a = st.access, p = st.plan, lim = st.limiter;
    sec.append(h('div', { class: 'td-status' },
      h('div', null, h('span', null, 'API key'), h('b', { class: 'up' }, 'configured')),
      h('div', null, h('span', null, 'Your plan'), h('b', null, p ? `${p.plan_category || '—'} · ${p.plan_limit ?? '?'} credits/min` : (st.planError || '—'))),
      h('div', null, h('span', null, `${s.td} access`), a
        ? h('b', { class: a.supported ? 'up' : 'down' }, a.supported ? `included (${a.name}; needs ${a.requiredPlan || 'Basic'})` : `not in your plan — needs ${a.requiredPlan}`)
        : h('b', { class: 'down' }, st.accessError || '—')),
      h('div', null, h('span', null, 'Rate limit'), h('b', null, `${lim.usedThisMinute}/${lim.perMinute} requests this minute${lim.waitingUntil ? ` · waiting ${Math.max(0, Math.ceil((lim.waitingUntil - Date.now()) / 1000))}s` : ''}`)),
      h('button', { class: 'btn small', onclick: async () => { await api(`/api/td/status?symbol=${s.symbol}&probe=1`).catch(e => toast(e.message, 'error')); this.render(); } }, 'Re-check plan')));
    const rows = st.intervals.map(iv => {
      const reqs = h('input', { type: 'number', min: 1, max: 200, value: 10, class: 'narrow', title: 'Requests of 5000 candles' });
      return h('tr', null,
        h('td', null, h('b', null, tfLabel(iv.tf))), h('td', { class: 'muted' }, iv.interval),
        h('td', null, iv.rows ? `${fmtDate(iv.first)} → ${new Date(iv.last * 1000).toISOString().slice(0, 16).replace('T', ' ')}` : '—'),
        h('td', null, iv.rows ? iv.rows.toLocaleString() : '—'),
        h('td', null, iv.earliest ? fmtDate(iv.earliest) : h('button', { class: 'btn small', title: 'Ask Twelve Data where this history starts (1 credit)', onclick: async () => {
          try { await api(`/api/td/range?symbol=${s.symbol}&tf=${iv.tf}`); } catch (e) { toast(e.message, 'error'); }
          this.render();
        } }, 'Check')),
        h('td', null, iv.complete ? h('span', { class: 'up' }, 'full history') : iv.rows ? 'older available' : 'not loaded'),
        h('td', { class: 'actions' },
          iv.complete ? null : [reqs, h('button', { class: 'btn small', title: 'Download older candles in the background', onclick: async () => {
            try { await api('/api/td/history', { method: 'POST', body: { symbol: s.symbol, tf: iv.tf, requests: Number(reqs.value) } }); toast(`Downloading older ${tfLabel(iv.tf)} candles…`); this.poll(true); }
            catch (e) { toast(e.message, 'error'); }
          } }, icon('download'), 'Older')],
          iv.rows ? h('button', { class: 'btn small', title: 'Delete the cached candles for this timeframe', onclick: async () => {
            if (!(await confirmBox(`Delete cached Twelve Data ${tfLabel(iv.tf)} candles for ${s.symbol}?`, 'Delete'))) return;
            await api(`/api/td/cache?symbol=${s.symbol}&tf=${iv.tf}`, { method: 'DELETE' });
            await this.afterDataChange();
          } }, icon('trash')) : null));
    });
    rows.push(h('tr', null, h('td', null, h('b', null, '3m')), h('td', { class: 'muted' }, '—'),
      h('td', { colspan: 5, class: 'muted' }, 'Twelve Data has no 3-minute interval; the 3m chart shows a message instead of invented candles.')));
    sec.append(h('div', { class: 'tp-table cov' }, h('table', null,
      h('thead', null, h('tr', null, ['Chart', 'API interval', 'Cached range (UTC)', 'Candles', 'History starts', 'Status', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows))),
      h('p', { class: 'muted small' }, 'Each timeframe requests its own Twelve Data interval (1 credit per 5000 candles) and is cached on disk; charts only call the API for newer candles or older history you scroll to. Replay and backtests use these cached real candles — gaps are never filled.'));
    return sec;
  }

  renderJobs(jobs) {
    if (!this.jobsBox) return;
    const mine = jobs.slice(0, 6);
    this.jobsBox.replaceChildren(...(mine.length ? mine.map(j => h('div', { class: `job ${j.status}` },
      h('div', { class: 'job-head' }, h('b', null, j.type === 'td-history' ? `Twelve Data ${j.symbol} ${tfLabel(j.tf)} history` : `${j.symbol} ${j.from} → ${j.to}`), h('span', { class: 'muted' }, j.status), h('div', { class: 'spacer' }),
        h('span', { class: 'muted small' }, j.type === 'td-history' ? `${j.done}/${j.total} requests · ${j.rows.toLocaleString()} candles` : `${j.gets.toLocaleString()} files · ${fmtBytes(j.bytes)} · ≈$${(j.costUsd || 0).toFixed(4)}`),
        ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn small', onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(() => this.poll(true)) }, 'Cancel') : null),
      h('div', { class: 'progress' }, h('div', { style: { width: `${j.total ? Math.round(j.done / j.total * 100) : (j.status === 'done' ? 100 : 0)}%` } })),
      h('div', { class: 'muted small' }, j.error || j.message))) : [h('p', { class: 'muted small' }, 'No downloads yet.')]));
  }

  poll(force) {
    if (this.polling && !force) return;
    this.polling = true;
    clearTimeout(this.pollTimer);
    const tick = async () => {
      if (this.modal.hidden) { this.polling = false; return; }
      try {
        const jobs = await api('/api/jobs');
        this.renderJobs(jobs);
        const running = jobs.some(j => ['queued', 'running'].includes(j.status));
        const justFinished = this.wasRunning && !running;
        this.wasRunning = running;
        if (justFinished) await this.afterDataChange();
        this.pollTimer = setTimeout(tick, running ? 1000 : 4000);
      } catch { this.pollTimer = setTimeout(tick, 4000); }
    };
    tick();
  }
}
