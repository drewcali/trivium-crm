import { handler, json, bad } from '../../lib/http.mjs';
import { accounts, login, clearCookie, sessionUser, publicProfile } from '../../lib/auth.mjs';
import { SOURCE } from '../../lib/config.mjs';

export default handler(async (req) => {
  const path = new URL(req.url).pathname;
  if (path.endsWith('/profiles')) // login picker: names only
    return json((await accounts()).filter(a => a.active !== false).map(a => ({ id: a.id, name: a.name, role: a.role, territory: a.territory })));
  if (path.endsWith('/session')) {
    const u = await sessionUser(req);
    return u ? json({ user: publicProfile(u), source: SOURCE() }) : bad('Not signed in', 401);
  }
  if (path.endsWith('/logout')) return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  if (path.endsWith('/login') && req.method === 'POST') {
    const { id, pin } = await req.json();
    const r = await login(id, pin);
    if (r.error) return bad(r.error, 401);
    return json({ user: publicProfile(r.account), source: SOURCE() }, 200, { 'set-cookie': r.cookie });
  }
  return bad('Not found', 404);
}, { auth: 'none' });

export const config = { path: ['/api/login', '/api/logout', '/api/session', '/api/profiles'] };
