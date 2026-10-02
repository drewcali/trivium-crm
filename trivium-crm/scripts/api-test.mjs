// End-to-end API checks for Tests 2, 4 and 6 against a running server (npm run dev).
// Usage: node scripts/api-test.mjs [baseUrl]   — mock mode PINs: admin 2468, brokers 1001–1005
const BASE = process.argv[2] || 'http://localhost:8888';
const PINS = { admin: process.env.ADMIN_PIN || '2468', b1: '1001', b2: '1002', b3: '1003', b4: '1004', b5: '1005' };
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };

async function session(id) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', body: JSON.stringify({ id, pin: PINS[id] }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (path, opts = {}) => { const t0 = Date.now(); const res = await fetch(BASE + path, { ...opts, headers: { cookie, ...(opts.headers || {}) }, body: opts.body && JSON.stringify(opts.body) });
    const body = res.status === 304 ? null : await res.json().catch(() => null); return { status: res.status, body, ms: Date.now() - t0 }; };
  return { ...(await r.json()), call };
}
const decode = (t) => ({ ...t, props: t.P.map(r => ({ id: r[0], address: r[1], city: r[2], zip: r[3], county: r[4], owner: r[12] })) });

const admin = await session('admin');
const gold = await session('b1'), parnes = await session('b2'), rosen = await session('b3'), kohn = await session('b4');
const tg = decode((await gold.call('/api/territory')).body), tp = decode((await parnes.call('/api/territory')).body);
const ta = decode((await admin.call('/api/territory')).body), tr = decode((await rosen.call('/api/territory')).body);

console.log('\n── Test 6: current-user filtering');
check(tg.props.every(p => p.county === 'Essex'), `Goldstein sees only Essex (${tg.props.length} properties)`);
check(tp.props.every(p => p.county === 'Union'), `Parnes sees only Union (${tp.props.length})`);
check(tr.props.every(p => p.county === 'Bergen'), `Rosen sees only Bergen (${tr.props.length})`);
check(ta.props.length === tg.props.length + tp.props.length + tr.props.length, `Admin sees all owned properties (${ta.props.length})`);
const k = (await kohn.call('/api/territory')).body; check(k.P.length === 0 && k.excluded.noOwner === 2000, `Kohn: 0 visible, ${k.excluded.noOwner} excluded pending ownership data (known gap)`);
const parnesProp = tp.props[0].id;
check((await gold.call('/api/record?id=' + parnesProp)).status === 403, 'Goldstein is refused a Union property by the server (403)');
check((await (await fetch(BASE + '/api/territory')).status) === 401, 'No session → 401');

console.log('\n── Find an owner with properties in BOTH Essex and Union (shared owner, Rule 3)');
let shared = null;
{ // locate one from the local cache (dev only) — an entity owning in Essex and Union with 2+ contacts
  const { getBase } = await import('../lib/snapshot.mjs'); const { base: b } = await getBase();
  const own = new Map(b.ownership.map(o => [o.id, o])), prop = new Map(b.properties.map(p => [p.id, p]));
  for (const e of b.entities) {
    if (e.contactIds.length < 2) continue;
    const ps = e.ownershipIds.map(id => own.get(id)).filter(o => o && !o.end).map(o => prop.get(o.propertyId));
    const g = ps.find(p => p.county === 'Essex'), u = ps.find(p => p.county === 'Union');
    if (g && u) { shared = { gProp: g.id, pProp: u.id, rec: (await admin.call('/api/record?id=' + g.id)).body }; break; }
  }
}
check(!!shared, shared ? `Shared owner: ${shared.rec.owner.name} (${shared.rec.contacts.length} contacts)` : 'no shared owner found in first 400');

if (shared) {
  console.log('\n── Test 4: cross-broker cooldown');
  const c2 = shared.rec.contacts[1]; // log on a DIFFERENT contact of the same entity than the one Goldstein will open
  const clientId = 'test-' + Date.now();
  const w = await parnes.call('/api/log', { method: 'POST', body: { contactId: c2.id, clientId, note: `Spoke w/ ${c2.name.split(' ')[0]}, might sell if number is right. f/u in 2 weeks` } });
  check(w.status === 200 && w.body.log.id, `Parnes logs a note → Airtable record ${w.body?.log?.id} (${w.ms} ms, parser: ${w.body?.parsed?.engine})`);
  check(w.body.log.outcome === 'spoke' && w.body.log.dealSignal === 'selling interest' && !!w.body.log.followUp, `Parsed: outcome=${w.body.log.outcome}, signal=${w.body.log.dealSignal}, follow-up=${w.body.log.followUp}`);
  const dup = await parnes.call('/api/log', { method: 'POST', body: { contactId: c2.id, clientId, note: 'retry' } });
  check(dup.body.duplicate === true, 'Offline retry with same clientId is de-duplicated (not written twice)');
  const g = await gold.call('/api/record?id=' + shared.gProp);
  const cd = g.body.cooldown;
  check(cd.active && cd.entries[0].broker === 'Joseph Parnes' && cd.entries[0].outcome === 'spoke', `Goldstein opens owner → banner: ${cd.entries[0]?.broker}, ${cd.entries[0]?.date?.slice(0, 10)}, ${cd.entries[0]?.outcome} (live read ${g.ms} ms)`);
  check(g.body.logs.find(l => l.brokerId !== gold.user.userRecId && l.note !== null) === undefined, "Goldstein can't read Parnes's note text (only broker/date/outcome)");
  const a = await admin.call('/api/record?id=' + shared.gProp);
  check(a.body.logs.some(l => l.note && l.note.includes('might sell')), 'Admin sees full note text');
  const edit = await admin.call('/api/log', { method: 'PATCH', body: { id: w.body.log.id, fields: { outcome: 'met in person' } } });
  check(edit.status === 200, 'Admin can edit any broker\'s log');
  check((await gold.call('/api/log', { method: 'PATCH', body: { id: w.body.log.id, fields: { outcome: 'email' } } })).status === 403, "Goldstein can't edit Parnes's log");

  console.log('\n── Test 2: live read/write');
  const c1 = shared.rec.contacts[0];
  const newPhone = '(973) 555-' + String(Date.now()).slice(-4);
  await admin.call('/api/admin/mock-edit', { method: 'POST', body: { contactId: c1.id, phone: newPhone } }); // = someone editing in Airtable
  const after = await gold.call('/api/record?id=' + shared.gProp);
  check(after.body.contacts.find(c => c.id === c1.id).phone === newPhone, `Phone edited "in Airtable" shows on next open with no sync/redeploy (${newPhone})`);
  const stale = await gold.call('/api/contact', { method: 'PATCH', body: { id: c1.id, phone: '(973) 555-0000', expected: { phone: c1.phone } } });
  check(stale.status === 409, 'Two brokers editing the same phone: second write is refused with a conflict (409), not silently overwritten');
  const tg2 = (await gold.call('/api/territory')).body;
  check(tg2.L.some(r => r[0] === w.body.log.id), 'New log appears in territory payload before the next sync (write-through)');
}
console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
process.exit(failures ? 1 : 0);
