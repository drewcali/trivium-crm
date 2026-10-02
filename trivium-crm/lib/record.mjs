// Live record reads, authorization and the cross-broker cooldown rule (Test 4).
import { client } from './airtable.mjs';
import { normalize, currentOwnerId, inBrokerView, score } from './model.mjs';
import { RULES } from './config.mjs';
import { getBase, getMeta } from './snapshot.mjs';
import { getCached, generate, template, inputHash } from './rationale.mjs';

// Cached normalized base (authorization lookups). Reloaded when a new sync lands.
let BASE = null, BASE_AT = null, IDX = null;
export async function base() {
  const meta = await getMeta();
  if (!BASE || meta?.builtAt !== BASE_AT) {
    const b = await getBase(); if (!b) throw Object.assign(new Error('Data cache not built yet — run a sync'), { status: 503 });
    BASE = b.base; BASE_AT = meta?.builtAt;
    IDX = { prop: new Map(BASE.properties.map(x => [x.id, x])), own: new Map(BASE.ownership.map(x => [x.id, x])),
      ent: new Map(BASE.entities.map(x => [x.id, x])), con: new Map(BASE.contacts.map(x => [x.id, x])), user: new Map(BASE.users.map(x => [x.id, x])) };
  }
  return { base: BASE, idx: IDX };
}

const deny = () => Object.assign(new Error('Not in your territory'), { status: 403 });

export async function canSeeProperty(user, propertyId) {
  if (user.role === 'admin') return true;
  const { idx } = await base(); const p = idx.prop.get(propertyId);
  return !!p && inBrokerView(p, user.userRecId, idx.own);
}
// A broker may act on a contact if it belongs to an entity that currently owns a property in their view.
export async function canActOnContact(user, contactId) {
  if (user.role === 'admin') return true;
  const { idx } = await base(); const c = idx.con.get(contactId); if (!c) return false;
  if (c.userIds.includes(user.userRecId)) return true;
  for (const eid of c.entityIds) { const e = idx.ent.get(eid); if (!e) continue;
    for (const oid of e.ownershipIds) { const o = idx.own.get(oid); if (!o || o.end) continue; const p = idx.prop.get(o.propertyId);
      if (p && inBrokerView(p, user.userRecId, idx.own)) return true; } }
  return false;
}

// Live read straight from Airtable (≈5 small requests). Used when a record is opened so an edit made
// directly in Airtable shows up without waiting for the next sync.
export async function liveRecord(user, propertyId) {
  if (!(await canSeeProperty(user, propertyId))) throw deny();
  const at = client(); const t0 = Date.now();
  const p = normalize('properties', await at.get('properties', propertyId));
  const own = (await at.getMany('ownership', p.ownershipIds)).map(r => normalize('ownership', r));
  const ownById = new Map(own.map(o => [o.id, o]));
  const ownerId = currentOwnerId(p, ownById);
  const ents = (await at.getMany('entities', [...new Set(own.map(o => o.entityId).filter(Boolean))])).map(r => normalize('entities', r));
  const owner = ents.find(e => e.id === ownerId) || null;
  const contacts = owner ? (await at.getMany('contacts', owner.contactIds)).map(r => normalize('contacts', r)) : [];
  const logIds = [...new Set(contacts.flatMap(c => c.logIds))];
  const logs = (await at.getMany('logs', logIds)).map(r => normalize('logs', r)).sort((a, b) => b.date.localeCompare(a.date));
  const { idx } = await base();
  const userName = (id) => idx.user.get(id)?.name || 'Unknown';
  // Other brokers' note text is withheld from brokers (admin sees all).
  const visLogs = logs.map(l => ({ ...l, brokerName: userName(l.brokerId), note: user.role === 'admin' || l.brokerId === user.userRecId ? l.note : null }));
  const sc = score(p);
  let rationale = await getCached(p);
  if (!rationale) rationale = { text: template(p), engine: 'template', hash: inputHash(p), pending: true };
  // Other properties this owner holds (any territory) — helps brokers see the whole relationship
  const portfolio = owner ? owner.ownershipIds.map(id => idx.own.get(id)).filter(o => o && !o.end).map(o => idx.prop.get(o.propertyId)).filter(Boolean)
    .map(x => ({ id: x.id, address: x.address, city: x.city, units: x.units, brokers: x.userIds.map(userName), visible: user.role === 'admin' || inBrokerView(x, user.userRecId, idx.own) })) : [];
  return {
    property: { ...p, score: sc.score, factors: sc.factors, brokers: p.userIds.map(userName) },
    owner, history: own.map(o => ({ ...o, entityName: ents.find(e => e.id === o.entityId)?.name || '—' })).sort((a, b) => (b.start || '').localeCompare(a.start || '')),
    contacts, logs: visLogs, cooldown: cooldownFrom(visLogs, user), rationale, portfolio,
    fetchedMs: Date.now() - t0, fetchedAt: new Date().toISOString(),
  };
}

// Rule 5: any log by a DIFFERENT broker on any contact of the same owner entity within the window.
export function cooldownFrom(logs, user) {
  const since = Date.now() - RULES.cooldownDays * 864e5;
  const hits = logs.filter(l => new Date(l.date).getTime() >= since && (user.role === 'admin' || l.brokerId !== user.userRecId));
  const flagged = logs.find(l => l.cooldown && new Date(l.date).getTime() >= Date.now() - 180 * 864e5);
  return { windowDays: RULES.cooldownDays, active: hits.length > 0, entries: hits.slice(0, 5).map(l => ({ broker: l.brokerName, date: l.date, outcome: l.outcome, contactId: l.contactId })),
    doNotContact: flagged ? { broker: flagged.brokerName, date: flagged.date } : null };
}

export async function rationaleOnDemand(user, propertyId) {
  if (!(await canSeeProperty(user, propertyId))) throw deny();
  const p = normalize('properties', await client().get('properties', propertyId));
  return (await generate([p])).results[p.id];
}
