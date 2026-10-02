// PATCH /api/contact {id, phone?, email?, expected:{phone?, email?}}
// Conflict-safe edit: the server re-reads the contact from Airtable first. If someone changed the
// field since this broker loaded it, the write is refused (409) and both values are shown —
// no silent last-write-wins on contact details.
import { handler, json, bad } from '../../lib/http.mjs';
import { client } from '../../lib/airtable.mjs';
import { normalize } from '../../lib/model.mjs';
import { canActOnContact } from '../../lib/record.mjs';
import { PENDING, writableFields } from '../../lib/snapshot.mjs';
import { TABLES } from '../../lib/config.mjs';

export default handler(async (req, ctx, user) => {
  if (req.method !== 'PATCH') return bad('Method not allowed', 405);
  const b = await req.json(); if (!b.id) return bad('id required');
  if (!(await canActOnContact(user, b.id))) return bad('Not in your territory', 403);
  const at = client();
  const cur = normalize('contacts', await at.get('contacts', b.id));
  const conflicts = [];
  for (const k of ['phone', 'email']) if (k in b && b.expected && k in b.expected && (b.expected[k] || '') !== (cur[k] || '')) conflicts.push({ field: k, theirs: cur[k], yours: b[k] });
  if (conflicts.length && !b.force) return json({ error: 'Changed by someone else since you opened it', conflicts, current: cur }, 409);
  const m = TABLES.contacts.fields; const f = {};
  if ('phone' in b) f[m.phone] = b.phone; if ('email' in b) f[m.email] = b.email;
  await at.update('contacts', [{ id: b.id, fields: await writableFields('contacts', f) }]);
  await PENDING.set('contact:' + b.id, { phone: b.phone ?? null, email: b.email ?? null, at: new Date().toISOString() });
  return json({ ok: true, contact: { ...cur, ...('phone' in b ? { phone: b.phone } : {}), ...('email' in b ? { email: b.email } : {}) } });
});

export const config = { path: '/api/contact' };
