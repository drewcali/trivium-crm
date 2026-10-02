// Login: profile + PIN (same pattern as AMP), but verified on the server.
//  • PINs are never stored — only a salted scrypt hash, in server-side storage (Netlify Blobs).
//  • 5 wrong PINs locks that profile for 15 minutes (a 4–6 digit PIN is otherwise guessable).
//  • A session is an HMAC-signed, HttpOnly, Secure, SameSite=Strict cookie, 12h lifetime.
//  • Every API call re-checks the session and the user's current status (removing a broker is instant).
import crypto from 'node:crypto';
import { env, RULES, SOURCE, onNetlify } from './config.mjs';
import { store } from './store.mjs';

const A = store('auth');
const COOKIE = 'tcrm_session';

function secret() {
  const s = env('SESSION_SECRET');
  if (s) return s;
  if (SOURCE() === 'mock' && !onNetlify()) return 'local-dev-only-secret';
  throw new Error('SESSION_SECRET is not set');
}

export const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') });
export const pinOk = (pin, rec) => rec?.hash && crypto.timingSafeEqual(Buffer.from(hashPin(pin, rec.salt).hash, 'hex'), Buffer.from(rec.hash, 'hex'));

// accounts: [{ id, name, role: 'broker'|'admin', userRecId, territory, pin: {salt,hash}, active }]
export async function accounts() { return (await A.get('accounts')) || []; }
export async function saveAccounts(list) { await A.set('accounts', list); }
export const publicProfile = (a) => ({ id: a.id, name: a.name, role: a.role, territory: a.territory, userRecId: a.userRecId || null });

export async function login(id, pin) {
  const list = await accounts(); const a = list.find(x => x.id === id && x.active !== false);
  if (!a) return { error: 'Unknown profile' };
  const lockKey = `lock:${id}`; const lock = (await A.get(lockKey)) || { fails: 0, until: 0 };
  if (lock.until > Date.now()) return { error: `Locked — try again in ${Math.ceil((lock.until - Date.now()) / 60000)} min` };
  if (!/^\d{4,6}$/.test(String(pin)) || !pinOk(pin, a.pin)) {
    lock.fails++; if (lock.fails >= 5) { lock.until = Date.now() + 15 * 60e3; lock.fails = 0; }
    await A.set(lockKey, lock); return { error: 'Incorrect PIN' };
  }
  await A.del(lockKey);
  const exp = Date.now() + RULES.sessionHours * 3600e3;
  return { account: a, cookie: cookie(sign({ id: a.id, exp, v: a.pinVersion || 0 }), RULES.sessionHours * 3600) };
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload) => { const p = b64(JSON.stringify(payload)); return p + '.' + crypto.createHmac('sha256', secret()).update(p).digest('base64url'); };
function verify(token) {
  if (!token) return null; const [p, sig] = token.split('.'); if (!p || !sig) return null;
  const good = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null;
}
const cookie = (val, maxAge) => `${COOKIE}=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${onNetlify() ? '; Secure' : ''}`;
export const clearCookie = () => cookie('', 0);

export async function sessionUser(req) {
  const raw = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  const s = verify(raw?.slice(COOKIE.length + 1)); if (!s) return null;
  const a = (await accounts()).find(x => x.id === s.id && x.active !== false);
  if (!a || (a.pinVersion || 0) !== s.v) return null; // PIN reset / removal kills existing sessions
  return a;
}
