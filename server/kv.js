// Persistent JSON documents (layouts, drawings, sessions, journal…) and journal screenshots.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './storage.js';

const USER = path.join(DATA_DIR, 'user');
export const SHOTS = path.join(USER, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const safe = key => {
  if (!/^[\w.:@-]{1,160}$/.test(key)) throw new Error('Invalid key');
  return path.join(USER, encodeURIComponent(key) + '.json');
};

export async function kvGet(key) {
  try { return JSON.parse(await fsp.readFile(safe(key), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function kvPut(key, value) {
  const file = safe(key);
  const tmp = `${file}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}
export async function kvDelete(key) { await fsp.rm(safe(key), { force: true }); }
export async function kvList(prefix = '') {
  const names = await fsp.readdir(USER);
  return names.filter(n => n.endsWith('.json')).map(n => decodeURIComponent(n.slice(0, -5))).filter(k => k.startsWith(prefix));
}

export async function saveShot(pngBuffer) {
  if (pngBuffer.subarray(1, 4).toString() !== 'PNG') throw new Error('Not a PNG image');
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await fsp.writeFile(path.join(SHOTS, name), pngBuffer);
  return `/shots/${name}`;
}
export async function deleteShot(url) {
  const name = path.basename(url || '');
  if (/^[\w-]+\.png$/.test(name)) await fsp.rm(path.join(SHOTS, name), { force: true });
}
