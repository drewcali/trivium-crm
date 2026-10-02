// Admin-only API (Emily). Every route re-checks role on the server.
import { handler, json, bad } from '../../lib/http.mjs';
import { accounts, saveAccounts, hashPin, publicProfile } from '../../lib/auth.mjs';
import { getMeta, incrementalSync, fullSync, PENDING } from '../../lib/snapshot.mjs';
import { store } from '../../lib/store.mjs';
import { stats } from '../../lib/airtable.mjs';
import { SOURCE, CLAUDE, TABLES, env, onNetlify } from '../../lib/config.mjs';
import { base } from '../../lib/record.mjs';
import { parseNotes } from '../../lib/parse.mjs';
import { SAMPLE_NOTES, scoreParse } from '../../lib/sample-notes.mjs';
import { generate } from '../../lib/rationale.mjs';
import { mockAirtableEdit } from '../../lib/mock-base.mjs';

export default handler(async (req, ctx, user) => {
  const url = new URL(req.url); const route = url.pathname.replace(/^\/api\/admin\/?/, '');
  const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));

  if (route === 'status') return json({ source: SOURCE(), claude: !!CLAUDE.apiKey(), meta: await getMeta(),
    schemaCheck: await store('cache').get('schema-check'), airtableThisInstance: stats, pending: (await PENDING.list('log:')).length });

  if (route === 'users' && req.method === 'GET') {
    const bb = await base().catch(() => null); // works before the first sync too
    return json({ accounts: (await accounts()).map(a => ({ ...publicProfile(a), active: a.active !== false })), airtableUsers: bb?.base.users || [] });
  }
  if (route === 'users' && req.method === 'POST') {
    const list = await accounts(); const { id, name, role = 'broker', userRecId, pin, territory } = body;
    if (pin && !/^\d{4,6}$/.test(pin)) return bad('PIN must be 4–6 digits');
    let a = id && list.find(x => x.id === id);
    if (a) { Object.assign(a, { name: name ?? a.name, role, userRecId: userRecId ?? a.userRecId, territory: territory ?? a.territory, active: true });
      if (pin) { a.pin = hashPin(pin); a.pinVersion = (a.pinVersion || 0) + 1; } }
    else { if (!name || !pin) return bad('name and pin required'); if (role === 'broker' && !userRecId) return bad('Link the broker to an Airtable Users record');
      a = { id: 'u' + Date.now().toString(36), name, role, userRecId: userRecId || null, territory: territory || '', pin: hashPin(pin), active: true }; list.push(a); }
    await saveAccounts(list); return json(publicProfile(a));
  }
  if (route === 'users' && req.method === 'DELETE') {
    const id = url.searchParams.get('id'); if (id === user.id) return bad("You can't remove yourself");
    const list = await accounts(); const a = list.find(x => x.id === id); if (!a) return bad('Not found', 404);
    a.active = false; a.pinVersion = (a.pinVersion || 0) + 1; await saveAccounts(list); return json({ ok: true });
  }

  if (route === 'sync') {
    if (body.mode === 'full') {
      if (onNetlify()) { // hand off to the 15-minute background function
        await fetch(`${url.origin}/.netlify/functions/sync-background`, { method: 'POST', headers: { 'x-sync-secret': env('SYNC_SECRET', '') } });
        return json({ started: true, note: 'Full sync running in background (~2–3 min at 13k records). Check status.' });
      }
      return json(await fullSync());
    }
    return json(await incrementalSync());
  }

  if (route === 'logs') { // global activity feed
    const { base: b, idx } = await base();
    const days = +(url.searchParams.get('days') || 30), broker = url.searchParams.get('broker'), q = (url.searchParams.get('q') || '').toLowerCase();
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const byId = new Map(b.logs.map(l => [l.id, l]));
    for (const k of await PENDING.list('log:')) { const l = await PENDING.get(k); if (l) byId.set(l.id, l); }
    const conToProp = (cid) => { const c = idx.con.get(cid); for (const eid of c?.entityIds || []) { const e = idx.ent.get(eid);
      for (const oid of e?.ownershipIds || []) { const o = idx.own.get(oid); if (o && !o.end) return { propertyId: o.propertyId, entity: e.name }; } } return {}; };
    const rows = [...byId.values()].filter(l => l.date >= since && (!broker || l.brokerId === broker))
      .map(l => ({ ...l, brokerName: idx.user.get(l.brokerId)?.name || '?', contactName: idx.con.get(l.contactId)?.name || '?', ...conToProp(l.contactId) }))
      .filter(l => !q || `${l.note} ${l.contactName} ${l.entity}`.toLowerCase().includes(q))
      .sort((a, c) => c.date.localeCompare(a.date));
    return json({ total: rows.length, rows: rows.slice(0, +(url.searchParams.get('limit') || 300)) });
  }

  if (route === 'parse-test') { // Test 3
    // Client sends ≤10 notes per request so each call stays under Netlify's function timeout.
    const notes = Array.isArray(body.notes) && body.notes.length ? body.notes.slice(0, 10).map((n, i) => typeof n === 'string' ? { i, text: n, date: new Date().toISOString() } : { i, ...n })
      : SAMPLE_NOTES.slice(body.from || 0, (body.from || 0) + 10).map((n, i) => ({ ...n, i }));
    const t0 = Date.now(); const r = await parseNotes(notes, { timeoutMs: CLAUDE.batchTimeoutMs });
    const scored = notes.every(n => n.expected) ? scoreParse(notes, r.results) : null;
    return json({ engine: r.engine, ms: Date.now() - t0, usage: r.usage, sampleTotal: SAMPLE_NOTES.length, rows: notes.map((n, i) => ({ text: n.text, expected: n.expected || null, got: r.results[i], ok: scored?.rows[i]?.ok || null })) });
  }

  if (route === 'rationale-test') { // Test 5
    const { base: b, idx } = await base(); const county = body.county || 'Bergen'; const n = Math.min(+body.n || 10, 10); const from = +body.from || 0;
    const props = b.properties.filter(p => p.county === county && p.ownershipIds.some(id => !idx.own.get(id)?.end)).slice(from, from + n);
    const r = await generate(props, { force: !!body.force });
    return json({ ...r.report, engine: CLAUDE.apiKey() ? 'claude' : 'template (no ANTHROPIC_API_KEY set)',
      samples: props.map(p => ({ id: p.id, address: `${p.address}, ${p.city}`, units: p.units, yearBuilt: p.yearBuilt, lastSale: `${p.lastSaleDate} @ $${(p.lastSalePrice || 0).toLocaleString()}`, loanMaturity: p.loanMaturity, ...r.results[p.id] })) });
  }

  if (route === 'mock-edit') { // Test 2 in mock mode: simulate someone editing directly in Airtable
    if (SOURCE() !== 'mock') return bad('Only in mock mode — edit the real dev base in Airtable instead');
    await mockAirtableEdit(TABLES.contacts.name, body.contactId, { [TABLES.contacts.fields.phone]: body.phone });
    return json({ ok: true });
  }
  return bad('Not found', 404);
}, { auth: 'admin' });

export const config = { path: '/api/admin/*' };
