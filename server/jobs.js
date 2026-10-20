// Background download jobs (one at a time, so S3 usage stays predictable). Progress is polled by the UI.

import { bySymbol } from './catalog.js';
import { readMeta, writeMinutes, nextYm } from './storage.js';
import { listMonth, fetchObject, decodeTicks, ticksToMinutes, assertPlausible, estimateCost } from './s3source.js';
import { tdDownloadHistory } from './twelvedata.js';

const jobs = [];
let running = null;
const CONCURRENCY = 6;

const newId = () => Math.random().toString(36).slice(2, 10);

export function listJobs() {
  return jobs.slice(-30).reverse().map(({ controller, ...j }) => j);
}

export function cancelJob(id) {
  const j = jobs.find(x => x.id === id);
  if (!j) return false;
  if (j.status === 'queued') j.status = 'cancelled';
  if (j.status === 'running') { j.cancelRequested = true; j.controller?.abort(); }
  return true;
}

export function enqueueDownload({ symbol, from, to, skipExisting = true }) {
  const spec = bySymbol[symbol];
  if (!spec?.s3) throw new Error(`${symbol} is not available from the Dukascopy archive`);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error('from/to must be YYYY-MM with from <= to');
  const job = {
    id: newId(), type: 'download', symbol, from, to, skipExisting, status: 'queued',
    done: 0, total: 0, rows: 0, gets: 0, lists: 0, bytes: 0, costUsd: 0, message: 'Queued', log: [],
    createdAt: Date.now(),
  };
  jobs.push(job);
  pump();
  return job.id;
}

/** Twelve Data: download `requests` older batches (5000 candles each) for one timeframe. */
export function enqueueTdHistory({ symbol, tf, requests = 10 }) {
  if (!bySymbol[symbol]?.td) throw new Error(`${symbol} isn't available from Twelve Data`);
  requests = Math.max(1, Math.min(200, Math.round(Number(requests) || 10)));
  const job = {
    id: newId(), type: 'td-history', symbol, tf, requests, status: 'queued', from: tf, to: `${requests} requests`,
    done: 0, total: requests, rows: 0, gets: 0, lists: 0, bytes: 0, costUsd: 0, message: 'Queued', log: [], createdAt: Date.now(),
  };
  jobs.push(job);
  pump();
  return job.id;
}

async function pump() {
  if (running) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  running = job;
  job.status = 'running';
  job.startedAt = Date.now();
  job.controller = new AbortController();
  try {
    if (job.type === 'td-history') {
      await tdDownloadHistory(job);
      job.status = job.cancelRequested ? 'cancelled' : 'done';
      if (job.cancelRequested) job.message = 'Cancelled';
    } else {
      await runDownload(job);
      job.status = job.cancelRequested ? 'cancelled' : 'done';
      job.message = job.cancelRequested ? 'Cancelled' : `Done — ${job.rows.toLocaleString('en-US')} one-minute bars cached`;
    }
  } catch (e) {
    job.status = job.cancelRequested ? 'cancelled' : 'error';
    job.error = e.name === 'CredentialsProviderError' || /credential/i.test(e.message)
      ? 'No AWS credentials found. Configure them (see Data manager → Setup) and retry.'
      : e.message;
    job.message = job.status === 'cancelled' ? 'Cancelled' : job.error;
  } finally {
    job.finishedAt = Date.now();
    job.costUsd = estimateCost(job);
    running = null;
    setTimeout(pump, 0);
  }
}

async function runDownload(job) {
  const spec = bySymbol[job.symbol];
  const meta = readMeta(job.symbol);
  const nowYm = new Date().toISOString().slice(0, 7);
  const monthsList = [];
  for (let ym = job.from; ym <= job.to; ym = nextYm(ym)) monthsList.push(ym);
  if (spec.firstMinute) {
    const first = spec.firstMinute.slice(0, 7);
    while (monthsList.length && monthsList[0] < first) monthsList.shift();
  }

  // Phase 1: list the months (cheap) so progress and cost are known up front.
  const plan = [];
  for (const ym of monthsList) {
    if (job.cancelRequested) return;
    const m = meta.months[ym];
    if (job.skipExisting && m?.sources?.includes('s3') && ym < nowYm) { job.log.push(`${ym}: already cached, skipped`); continue; }
    job.message = `Listing ${ym}…`;
    const [y, mo] = ym.split('-').map(Number);
    const { files, requests } = await listMonth(spec.s3, y, mo - 1);
    job.lists += requests;
    if (!files.length) job.log.push(`${ym}: no files in archive`);
    plan.push({ ym, files });
    job.total += files.length;
  }

  // Phase 2: download, decode and cache month by month.
  for (const { ym, files } of plan) {
    if (job.cancelRequested || !files.length) continue;
    const [y, mo] = ym.split('-').map(Number);
    const minutes = [];
    let i = 0;
    const worker = async () => {
      while (i < files.length && !job.cancelRequested) {
        const f = files[i++];
        const dayStart = Date.UTC(y, mo - 1, f.day);
        const buf = await fetchObject(f.key, job.controller.signal);
        job.gets++;
        job.bytes += buf.length;
        const rows = ticksToMinutes(decodeTicks(buf, dayStart, spec.point));
        for (const r of rows) minutes.push(r);
        job.done++;
        job.costUsd = estimateCost(job);
        job.message = `${ym}: ${job.done}/${job.total} days`;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (job.cancelRequested) return;
    minutes.sort((a, b) => a[0] - b[0]);
    assertPlausible(minutes, spec);
    await writeMinutes(job.symbol, minutes, { source: 's3' });
    job.rows += minutes.length;
    job.log.push(`${ym}: ${minutes.length.toLocaleString('en-US')} bars`);
  }
}
