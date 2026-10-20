// Dukascopy's official historical tick archive (Requester Pays S3 bucket).
// Source: https://www.dukascopy.com/wiki/en/development/data-export/
//
//  bucket  cfg-public-proper-wallaby (eu-west-1), Requester Pays → your own AWS credentials are billed
//  key     SYMBOL/YEAR/MONTH/DAY_ticks.bi5   (MONTH zero-indexed, e.g. EURUSD/2024/00/15_ticks.bi5)
//  file    raw LZMA stream of 20-byte big-endian records '>IIIff':
//          ms since 00:00 UTC of that day, ask (uint32), bid (uint32), ask volume (float32), bid volume (float32)
//          prices = integer / point (instrument specific, see catalog.js)
//
// Credentials come from the standard AWS chain (env vars, ~/.aws/credentials profile, SSO…). ChartDesk
// never asks for or stores keys itself. Months are listed first (one LIST request) so only files that
// really exist are downloaded — a missing day simply means no ticks (weekends, holidays).

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { lzma } from '@napi-rs/lzma';

// ChartDesk runs on a desktop, so skip the EC2 instance-metadata probe (it only adds multi-second timeouts
// to the credential chain when no keys are configured). Set it to 'false' yourself if you run on EC2.
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';

export const BUCKET = 'cfg-public-proper-wallaby';
export const REGION = 'eu-west-1';
// Price list quoted in Dukascopy's guide (USD).
export const COST = { perThousandGet: 0.0004, perThousandList: 0.005, perGB: 0.02 };

let client = null;
const s3 = () => (client ||= new S3Client({ region: REGION }));

export async function credentialStatus() {
  try {
    const creds = await s3().config.credentials();
    const id = creds.accessKeyId || '';
    return { ok: true, keyHint: id ? `${id.slice(0, 4)}…${id.slice(-4)}` : 'present', profile: process.env.AWS_PROFILE || 'default chain' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function listMonth(s3Symbol, year, month0) {
  const prefix = `${s3Symbol}/${year}/${String(month0).padStart(2, '0')}/`;
  const files = [];
  let token, requests = 0;
  do {
    const res = await s3().send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, RequestPayer: 'requester',
    }));
    requests++;
    for (const o of res.Contents || []) {
      const m = /\/(\d{1,2})_ticks\.bi5$/.exec(o.Key);
      if (m) files.push({ key: o.Key, day: +m[1], size: o.Size || 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  files.sort((a, b) => a.day - b.day);
  return { files, requests };
}

export async function fetchObject(key, signal) {
  const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key, RequestPayer: 'requester' }), { abortSignal: signal });
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Decode a *_ticks.bi5 file into tick objects (prices scaled, time in ms UTC). */
export function decodeTicks(buf, dayStartMs, point) {
  if (!buf.length) return [];
  const raw = Buffer.from(lzma.decompressSync(buf));
  if (raw.length % 20 !== 0) throw new Error(`Corrupt tick file: ${raw.length} bytes is not a multiple of 20`);
  const ticks = new Array(raw.length / 20);
  for (let i = 0, o = 0; i < ticks.length; i++, o += 20) {
    ticks[i] = {
      t: dayStartMs + raw.readUInt32BE(o),
      ask: raw.readUInt32BE(o + 4) / point,
      bid: raw.readUInt32BE(o + 8) / point,
      vol: raw.readFloatBE(o + 12) + raw.readFloatBE(o + 16),
    };
  }
  return ticks;
}

/** Build genuine 1-minute bid candles from ticks; spread column = mean(ask - bid) inside the minute. */
export function ticksToMinutes(ticks) {
  const rows = [];
  let cur = null, key = -1, spreadSum = 0, n = 0;
  for (const tk of ticks) {
    if (!(tk.bid > 0) || !(tk.ask >= tk.bid)) continue;
    const k = Math.floor(tk.t / 60000) * 60;
    if (k !== key) {
      if (cur) { cur[6] = spreadSum / n; rows.push(cur); }
      key = k;
      cur = [k, tk.bid, tk.bid, tk.bid, tk.bid, tk.vol, 0];
      spreadSum = tk.ask - tk.bid; n = 1;
    } else {
      if (tk.bid > cur[2]) cur[2] = tk.bid;
      if (tk.bid < cur[3]) cur[3] = tk.bid;
      cur[4] = tk.bid;
      cur[5] += tk.vol;
      spreadSum += tk.ask - tk.bid; n++;
    }
  }
  if (cur) { cur[6] = spreadSum / n; rows.push(cur); }
  return rows;
}

/** Throws if decoded prices don't fit the instrument (wrong point factor / wrong file). */
export function assertPlausible(rows, spec) {
  if (!rows.length || !spec.range) return;
  const closes = rows.map(r => r[4]).sort((a, b) => a - b);
  const median = closes[closes.length >> 1];
  if (median < spec.range[0] || median > spec.range[1]) {
    throw new Error(`${spec.symbol}: decoded median price ${median} is outside the expected ${spec.range[0]}–${spec.range[1]} range. ` +
      `The point factor (${spec.point}) in server/catalog.js is likely wrong for this instrument.`);
  }
}

export function estimateCost({ gets = 0, lists = 0, bytes = 0 }) {
  return gets / 1000 * COST.perThousandGet + lists / 1000 * COST.perThousandList + bytes / 1e9 * COST.perGB;
}
