import zlib from 'node:zlib';
import { sessionUser, accounts, saveAccounts, hashPin, pinOk } from './auth.mjs';
import { SOURCE, env } from './config.mjs';
import { client } from './airtable.mjs';
import { normalize } from './model.mjs';
import { store } from './store.mjs';

export const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const bad = (msg, status = 400) => json({ error: msg }, status);

export function compressed(req, text, headers = {}) {
  const ae = req.headers.get('accept-encoding') || '';
  const h = { 'content-type': 'application/json', 'cache-control': 'private, no-cache', vary: 'accept-encoding', ...headers };
  if (/\bbr\b/.test(ae)) return new Response(zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }), { headers: { ...h, 'content-encoding': 'br' } });
  if (/gzip/.test(ae)) return new Response(zlib.gzipSync(text, { level: 6 }), { headers: { ...h, 'content-encoding': 'gzip' } });
  return new Response(text, { headers: h });
}

// Wraps a handler: bootstraps accounts, enforces session + role. Errors never leak stack traces.
export function handler(fn, { auth = 'user' } = {}) {
  return async (req, ctx) => {
    try {
      await bootstrap();
      if (auth === 'none') return await fn(req, ctx, null);
      const user = await sessionUser(req);
      if (!user) return bad('Not signed in', 401);
      if (auth === 'admin' && user.role !== 'admin') return bad('Admin only', 403);
      return await fn(req, ctx, user);
    } catch (e) {
      console.error(e);
      return bad(e.status ? e.message : 'Server error: ' + e.message, e.status || 500);
    }
  };
}

// First run: create the admin from ADMIN_PIN (production) or demo PINs (mock mode only).
// After that, ADMIN_PIN stays authoritative: if the Netlify setting changes, the admin's
// stored hash is updated on the next cold start (and old admin sessions end).
let booted = false;
const cleanPin = (v) => (v == null ? null : String(v).replace(/\D/g, '')) || null;
async function bootstrap() {
  if (booted) return;
  const mockMode = SOURCE() === 'mock';
  const envPin = cleanPin(env('ADMIN_PIN'));
  const list = await accounts();
  if (list.length) {
    const admin = list.find(a => a.id === 'admin');
    if (admin && envPin && !pinOk(envPin, admin.pin)) {
      admin.pin = hashPin(envPin); admin.pinVersion = (admin.pinVersion || 0) + 1; admin.active = true;
      await A_save(list); await store('auth').del('lock:admin');
    }
    booted = true; return;
  }
  const adminPin = envPin || (mockMode ? '2468' : null);
  if (!adminPin) throw Object.assign(new Error('Set ADMIN_PIN in Netlify environment variables for first login'), { status: 503 });
  const out = [{ id: 'admin', name: env('ADMIN_NAME', 'Emily Wood'), role: 'admin', territory: 'All territories', pin: hashPin(adminPin), active: true }];
  if (mockMode) { // demo brokers, PINs 1001–1005 — mock mode only
    const users = (await client().listAll('users')).map(r => normalize('users', r));
    users.forEach((u, i) => out.push({ id: 'b' + (i + 1), name: u.name, role: 'broker', userRecId: u.id, territory: u.territory, pin: hashPin(String(1001 + i)), active: true }));
  }
  await saveAccounts(out); booted = true;
}
const A_save = (list) => saveAccounts(list);
