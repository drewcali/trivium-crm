// GET /api/territory — the signed-in broker's territory (admin: everything), as one compact
// compressed payload from the cache, plus notes/edits written since the last sync.
import crypto from 'node:crypto';
import { handler, compressed, bad } from '../../lib/http.mjs';
import { getPayloadText, getCmap, PENDING } from '../../lib/snapshot.mjs';
import { logRow } from '../../lib/snapshot.mjs';

export default handler(async (req, ctx, user) => {
  const viewer = user.role === 'admin' ? 'admin' : user.userRecId;
  if (!viewer) return bad('This profile is not linked to an Airtable user yet', 409);
  const text = await getPayloadText(viewer);
  if (!text) return bad('Data cache not built yet — admin must run a sync', 503);
  const logKeys = await PENDING.list('log:'); const conKeys = await PENDING.list('contact:');
  const etag = '"' + crypto.createHash('sha1').update(text.slice(0, 80) + text.length + logKeys.join() + conKeys.join()).digest('base64url').slice(0, 16) + '"';
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  if (!logKeys.length && !conKeys.length) return compressed(req, text, { etag });

  const payload = JSON.parse(text); const cmap = (await getCmap(viewer)) || {};
  const userIdx = new Map(payload.users.map((u, i) => [u.id, i]));
  const at = new Map(payload.L.map((r, i) => [r[0], i]));
  for (const k of logKeys.sort()) { const l = await PENDING.get(k); if (!l) continue; const ci = cmap[l.contactId];
    if (ci === undefined) continue; const row = logRow(l, user.role === 'admin' ? null : user.userRecId, ci, userIdx);
    if (at.has(l.id)) payload.L[at.get(l.id)] = row; else { at.set(l.id, payload.L.length); payload.L.push(row); } }
  for (const k of conKeys) { const c = await PENDING.get(k); const ci = cmap[k.slice(8)]; if (c && ci !== undefined) { if (c.phone != null) payload.C[ci][2] = c.phone; if (c.email != null) payload.C[ci][3] = c.email; } }
  return compressed(req, JSON.stringify(payload), { etag });
});

export const config = { path: '/api/territory' };
