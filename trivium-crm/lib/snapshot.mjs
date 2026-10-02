// ─────────────────────────────────────────────────────────────
// CACHE LAYER. Why it exists: Airtable returns 100 records per request
// at ≤5 requests/sec per base. A live pull of 13k properties + links is
// ~600 requests ≈ 2.5 min — impossible on page load. So a server job
// syncs Airtable → a normalized copy (Netlify Blobs), and precomputes one
// compact payload per broker. Phones download only their own territory.
//
//   full sync     — every record, all tables (nightly + on demand; background fn, ≤15 min)
//   incremental   — only records changed since last sync via LAST_MODIFIED_TIME() (every 10 min)
//   write-through — notes/edits made in the app land in Airtable first, then in a
//                   "pending" area that is merged into payloads until the next sync.
// Airtable is always the source of truth; the cache is disposable.
// ─────────────────────────────────────────────────────────────
import { client, stats } from './airtable.mjs';
import { normalize, score, currentOwnerId, inBrokerView } from './model.mjs';
import { TABLES, SOURCE } from './config.mjs';
import { store } from './store.mjs';

const S = store('cache');
const PENDING = store('pending');
const KEYS = ['properties', 'entities', 'contacts', 'ownership', 'logs', 'users'];

// Real Airtable rejects requests naming fields that don't exist (422). Read the schema once,
// request only fields that exist, and report the ones in config.mjs that don't match.
let SCHEMA = null;
export async function schemaFields(refresh = false) {
  if (SCHEMA && !refresh) return SCHEMA;
  const meta = await client().schema();
  const byTable = Object.fromEntries((meta.tables || []).map(t => [t.name, new Set(t.fields.map(f => f.name))]));
  const missing = {};
  for (const k of KEYS) { const have = byTable[TABLES[k].name];
    missing[k] = have ? Object.values(TABLES[k].fields).filter(f => !have.has(f)) : ['(table not found: ' + TABLES[k].name + ')']; }
  SCHEMA = { byTable, missing };
  await S.set('schema-check', { at: new Date().toISOString(), missing });
  return SCHEMA;
}
const fieldsFor = (k, sch) => Object.values(TABLES[k].fields).filter(f => sch.byTable[TABLES[k].name]?.has(f));
export async function writableFields(k, fields) {
  const sch = await schemaFields(); const have = sch.byTable[TABLES[k].name];
  return have ? Object.fromEntries(Object.entries(fields).filter(([f]) => have.has(f))) : fields;
}

export async function fullSync(log = () => {}) {
  const at = client(); const t0 = Date.now(); const r0 = stats.requests;
  const sch = await schemaFields(true);
  for (const [k, m] of Object.entries(sch.missing)) if (m.length) log(`⚠ ${TABLES[k].name}: fields not in base → ${m.join(', ')}`);
  const base = {};
  for (const k of KEYS) {
    const tk = Date.now();
    const recs = await at.listAll(k, { fields: fieldsFor(k, sch) });
    base[k] = recs.map(r => normalize(k, r));
    log(`${TABLES[k].name}: ${recs.length} records in ${((Date.now() - tk) / 1000).toFixed(1)}s`);
  }
  const syncedAt = new Date(t0).toISOString();
  await S.set('base', { syncedAt, base });
  const meta = await buildPayloads(base, syncedAt);
  Object.assign(meta, { mode: 'full', source: SOURCE(), durationMs: Date.now() - t0, airtableRequests: stats.requests - r0, rateLimited: stats.rateLimited });
  await S.set('meta', meta);
  await prunePending(syncedAt);
  return meta;
}

export async function incrementalSync(log = () => {}) {
  const cur = await S.get('base');
  if (!cur) return fullSync(log);
  const at = client(); const t0 = Date.now(); const r0 = stats.requests;
  const sch = await schemaFields();
  const since = new Date(new Date(cur.syncedAt).getTime() - 120e3).toISOString(); // 2-min overlap for clock skew
  const formula = `IS_AFTER(LAST_MODIFIED_TIME(), '${since}')`;
  let changed = 0;
  for (const k of KEYS) {
    const recs = await at.listAll(k, { formula, fields: fieldsFor(k, sch) });
    if (!recs.length) continue;
    const idx = new Map(cur.base[k].map((x, i) => [x.id, i]));
    for (const r of recs) { const n = normalize(k, r); idx.has(n.id) ? (cur.base[k][idx.get(n.id)] = n) : cur.base[k].push(n); }
    changed += recs.length; log(`${TABLES[k].name}: ${recs.length} changed`);
  }
  const syncedAt = new Date(t0).toISOString();
  cur.syncedAt = syncedAt;
  let meta = await S.get('meta');
  if (changed) { await S.set('base', cur); meta = await buildPayloads(cur.base, syncedAt); }
  Object.assign(meta, { mode: 'incremental', lastIncrementalAt: syncedAt, changed, durationMs: Date.now() - t0, airtableRequests: stats.requests - r0 });
  await S.set('meta', meta);
  await prunePending(syncedAt);
  return meta;
  // NOTE: deletions in Airtable aren't visible to an incremental pass; the nightly full sync removes them.
}

async function prunePending(syncedAt) {
  const cutoff = new Date(new Date(syncedAt).getTime() - 300e3).toISOString();
  for (const k of await PENDING.list('log:')) if (k.slice(4, 28) < cutoff) await PENDING.del(k);
  for (const k of await PENDING.list('contact:')) { const v = await PENDING.get(k); if (v && v.at < cutoff) await PENDING.del(k); }
}

// ── compact per-broker payloads ──────────────────────────────
export async function buildPayloads(base, syncedAt) {
  const now = Date.now();
  const ownById = new Map(base.ownership.map(o => [o.id, o]));
  const entById = new Map(base.entities.map(e => [e.id, e]));
  const conById = new Map(base.contacts.map(c => [c.id, c]));
  const users = base.users.map(u => ({ id: u.id, name: u.name, territory: u.territory }));
  const logsByContact = new Map();
  for (const l of base.logs) { if (!logsByContact.has(l.contactId)) logsByContact.set(l.contactId, []); logsByContact.get(l.contactId).push(l); }

  // Compact format: only property rows carry Airtable record ids (incompressible). Every link inside
  // the payload is an array index, which gzips ~4x better. Entity/contact ids come from /api/record.
  const userIdx = new Map(users.map((u, i) => [u.id, i]));
  const r5 = (x) => (x == null ? null : Math.round(x * 1e5) / 1e5);
  const build = (props, viewerId /* null = admin */) => {
    const eIdx = new Map(), E = [], cIdx = new Map(), C = [], O = [], L = [];
    const ent = (id) => { if (eIdx.has(id)) return eIdx.get(id); const e = entById.get(id); if (!e) return -1;
      eIdx.set(id, E.length); E.push([e.name, e.type, e.nameBasis, e.dataSource, []]); return E.length - 1; };
    const P = props.map((p, pi) => {
      const own = currentOwnerId(p, ownById); const oi = own ? ent(own) : -1;
      for (const oid of p.ownershipIds) { const o = ownById.get(oid); if (o) O.push([pi, ent(o.entityId), o.start, o.end]); }
      return [p.id, p.address, p.city, p.zip, p.county, p.units, p.yearBuilt, p.lastSaleDate, p.lastSalePrice, p.loanMaturity, r5(p.lat), r5(p.lng), oi, score(p, now).score];
    });
    const owners = new Set(P.map(r => r[12]));
    for (const [eid, ei] of eIdx) { if (!owners.has(ei)) continue;
      for (const cid of entById.get(eid).contactIds) { const c = conById.get(cid); if (!c) continue;
        let ci = cIdx.get(cid);
        if (ci === undefined) { ci = C.length; cIdx.set(cid, ci); C.push([c.name, c.role, c.phone, c.email, []]);
          for (const l of logsByContact.get(cid) || []) L.push(logRow(l, viewerId, ci, userIdx)); }
        E[ei][4].push(ci); C[ci][4].push(ei); } }
    return { payload: { v: 2, builtAt: syncedAt, users, P, E, C, O, L }, cmap: Object.fromEntries(cIdx) };
  };

  const meta = { builtAt: syncedAt, counts: Object.fromEntries(KEYS.map(k => [k, base[k].length])), territories: {} };
  const owned = base.properties.filter(p => currentOwnerId(p, ownById));
  const save = async (key, { payload, cmap }, extra) => { await S.setText(`territory:${key}`, JSON.stringify({ ...payload, ...extra })); await S.set(`cmap:${key}`, cmap); };
  await save('admin', build(owned, null), { excluded: { noOwner: base.properties.length - owned.length } });
  meta.territories.admin = owned.length;
  for (const u of base.users) {
    const mine = base.properties.filter(p => p.userIds.includes(u.id));
    const visible = mine.filter(p => inBrokerView(p, u.id, ownById));
    await save(u.id, build(visible, u.id), { excluded: { noOwner: mine.length - visible.length } });
    meta.territories[u.name] = { visible: visible.length, excludedNoOwner: mine.length - visible.length };
  }
  return meta;
}

// Other brokers' note TEXT is withheld from a broker's payload; date/broker/outcome stay visible for cooldown.
export const logRow = (l, viewerId, ci, userIdx) => [l.id, l.date, userIdx.get(l.brokerId) ?? -1, ci, l.channel, l.outcome, l.followUp,
  viewerId === null || l.brokerId === viewerId ? l.note : null, l.dealSignal, l.cooldown ? 1 : 0];

export async function getPayloadText(viewer) { return S.getText(`territory:${viewer}`); }
export const getCmap = (viewer) => S.get(`cmap:${viewer}`);
export const getMeta = () => S.get('meta');
export const getBase = () => S.get('base');
export { PENDING };
