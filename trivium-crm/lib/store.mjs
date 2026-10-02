// Key/value persistence for server-side state (snapshot cache, credentials,
// rationale cache, pending writes, mock-base writes). Netlify Blobs in production,
// local ./.data folder in local dev. Nothing here is visible to the browser.
import fs from 'node:fs/promises';
import path from 'node:path';

const onNetlify = () => typeof Netlify !== 'undefined' || !!process.env.NETLIFY_BLOBS_CONTEXT;
const LOCAL_DIR = path.resolve(process.env.LOCAL_DATA_DIR || '.data');

async function blobStore(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name, consistency: 'strong' });
}
const enc = (k) => encodeURIComponent(k);
const dec = (f) => decodeURIComponent(f);

export function store(name) {
  const dir = path.join(LOCAL_DIR, name);
  const api = {
    async getText(key) {
      if (onNetlify()) return (await blobStore(name)).get(key, { type: 'text' });
      try { return await fs.readFile(path.join(dir, enc(key)), 'utf8'); } catch { return null; }
    },
    async setText(key, text) {
      if (onNetlify()) return (await blobStore(name)).set(key, text);
      await fs.mkdir(dir, { recursive: true });
      const f = path.join(dir, enc(key)); const tmp = f + '.' + process.pid + Math.random().toString(36).slice(2) + '.tmp';
      await fs.writeFile(tmp, text); await fs.rename(tmp, f);
    },
    async get(key) { const t = await api.getText(key); return t == null ? null : JSON.parse(t); },
    set: (key, value) => api.setText(key, JSON.stringify(value)),
    async del(key) {
      if (onNetlify()) return (await blobStore(name)).delete(key);
      await fs.rm(path.join(dir, enc(key)), { force: true });
    },
    async list(prefix = '') {
      if (onNetlify()) { const { blobs } = await (await blobStore(name)).list({ prefix }); return blobs.map(b => b.key); }
      try { return (await fs.readdir(dir)).filter(f => !f.endsWith('.tmp')).map(dec).filter(k => k.startsWith(prefix)); } catch { return []; }
    },
  };
  return api;
}
