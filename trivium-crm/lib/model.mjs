// Airtable records → internal model, territory filtering, scoring.
import { TABLES, RULES } from './config.mjs';

const F = (t) => TABLES[t].fields;
const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

export function normalize(key, rec) {
  const f = rec.fields || {}, m = F(key), id = rec.id;
  switch (key) {
    case 'properties': return { id, address: f[m.address] || '', city: f[m.city] || '', zip: String(f[m.zip] ?? ''), county: f[m.county] || '',
      units: +f[m.units] || 0, yearBuilt: +f[m.yearBuilt] || null, lastSaleDate: f[m.lastSaleDate] || null, lastSalePrice: +f[m.lastSalePrice] || null,
      apn: f[m.apn] || '', loanMaturity: f[m.loanMaturity] || null, lat: +f[m.lat] || null, lng: +f[m.lng] || null,
      ownershipIds: f[m.ownership] || [], userIds: f[m.users] || [], ownerRaw: f[m.ownerRaw] || null };
    case 'entities': return { id, name: f[m.name] || '(unnamed)', type: f[m.type] || '', nameBasis: f[m.nameBasis] || '', dataSource: f[m.dataSource] || '',
      ownershipIds: f[m.ownership] || [], contactIds: f[m.contacts] || [] };
    case 'contacts': return { id, name: f[m.name] || '(unnamed)', phone: f[m.phone] || '', email: f[m.email] || '', role: f[m.role] || '',
      entityIds: f[m.entities] || [], userIds: f[m.users] || [], logIds: f[m.logs] || [] };
    case 'ownership': return { id, propertyId: first(f[m.property]), entityId: first(f[m.entity]), start: f[m.start] || null, end: f[m.end] || null, share: f[m.share] ?? null };
    case 'logs': return { id, date: f[m.date] || rec.createdTime, brokerId: first(f[m.broker]), contactId: first(f[m.contact]), channel: f[m.channel] || '',
      outcome: f[m.outcome] || '', followUp: f[m.followUp] || null, note: f[m.note] || '', dealSignal: f[m.dealSignal] || 'none', cooldown: !!f[m.cooldown], clientId: f[m.clientId] || null };
    case 'users': return { id, name: f[m.name] || '', territory: f[m.territory] || '', role: f[m.role] || '' };
  }
}

export function logToFields(l) {
  const m = F('logs'); const o = {
    [m.date]: l.date, [m.broker]: [l.brokerId], [m.contact]: [l.contactId], [m.channel]: l.channel, [m.outcome]: l.outcome,
    [m.note]: l.note, [m.dealSignal]: l.dealSignal || 'none', [m.cooldown]: !!l.cooldown, [m.clientId]: l.clientId };
  if (l.followUp) o[m.followUp] = l.followUp;
  return o;
}

// ── scoring: "why this owner, now" ───────────────────────────
const yrs = (iso, now) => (now - new Date(iso)) / (365.25 * 864e5);
export function score(p, now = Date.now()) {
  let s = 20; const why = [];
  if (p.lastSaleDate) {
    const h = yrs(p.lastSaleDate, now);
    if (h >= 7 && h <= 15) { s += 25; why.push(`${Math.round(h)}-yr hold — prime window for a sale or recap`); }
    else if (h > 15) { s += 18; why.push(`${Math.round(h)}-yr hold — long-term owner, likely large embedded gain`); }
    else if (h >= 4) { s += 8; why.push(`${Math.round(h)}-yr hold`); }
  }
  if (p.loanMaturity) {
    const m = -yrs(p.loanMaturity, now) * 12;
    if (m >= -3 && m <= 24) { s += 30; why.push(`loan matures ${m < 0 ? 'now / past due' : `in ~${Math.round(m)} mo`} — refinance-or-sell decision`); }
    else if (m > 24 && m <= 36) { s += 12; why.push(`loan matures in ~${Math.round(m)} mo`); }
  }
  if (p.units >= 50) { s += 15; why.push(`${p.units} units`); } else if (p.units >= 20) { s += 9; why.push(`${p.units} units`); } else if (p.units >= 10) s += 4;
  if (p.yearBuilt && p.yearBuilt < 1960) { s += 6; why.push(`built ${p.yearBuilt} — value-add / capex pressure`); }
  return { score: Math.min(99, s), factors: why };
}

// ── territory: what a broker is allowed to see ───────────────
// Spec = the "Eli Rosen" view on Properties: Users contains broker AND property has a current owner (Rule 4).
// ⚠ Verify against the real view with scripts/verify-view.mjs once the dev base is connected.
export function currentOwnerId(p, ownById) {
  let best = null;
  for (const oid of p.ownershipIds) { const o = ownById.get(oid); if (!o || o.end) continue; if (!best || (o.start || '') > (best.start || '')) best = o; }
  return best?.entityId || null;
}
export function inBrokerView(p, userRecId, ownById) {
  return p.userIds.includes(userRecId) && !!currentOwnerId(p, ownById);
}

export const COOLDOWN_MS = () => RULES.cooldownDays * 864e5;
