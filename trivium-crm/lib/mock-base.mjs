// ─────────────────────────────────────────────────────────────
// MOCK AIRTABLE BASE — stands in for Trivium's dev base until the
// token arrives. It generates a deterministic, fully FICTIONAL dataset
// at Trivium's real scale and shape (13k+ properties, 10k entities,
// linked contacts, ownership history, five broker territories), and
// serves it through a fake `fetch` that speaks Airtable's REST API:
// 100-record pages, offsets, RECORD_ID() formulas, create/patch,
// simulated latency and a 5 req/s limit that returns 429.
// The real Airtable client runs unmodified against it.
// No real names, phones or addresses — all generated.
// ─────────────────────────────────────────────────────────────
import { TABLES } from './config.mjs';
import { store } from './store.mjs';

// ── deterministic RNG ───────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.chance = (p) => r() < p;
  return r;
}
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function recId(r) { let s = 'rec'; for (let i = 0; i < 14; i++) s += B62[Math.floor(r() * 62)]; return s; }

// ── geography (town centers, zips) ──────────────────────────
export const BROKERS = [
  { key: 'goldstein', name: 'Israel Goldstein', territory: 'Newark / Essex County', county: 'Essex' },
  { key: 'parnes',    name: 'Joseph Parnes',    territory: 'Union County',          county: 'Union' },
  { key: 'rosen',     name: 'Eli Rosen',        territory: 'Bergen County',         county: 'Bergen' },
  { key: 'kohn',      name: 'Joseph Kohn',      territory: 'Hudson Valley',         county: 'Hudson Valley' },
  { key: 'brecher',   name: 'Joseph Brecher',   territory: 'Unassigned',            county: null },
];
const TOWNS = {
  Essex: [['Newark',40.7357,-74.1724,['07102','07103','07104','07105','07106','07107','07108','07112','07114'],5],
    ['East Orange',40.7673,-74.2049,['07017','07018'],2],['Orange',40.7707,-74.2326,['07050'],1.2],
    ['Irvington',40.7323,-74.2349,['07111'],1.5],['Montclair',40.8259,-74.2090,['07042','07043'],1],
    ['Bloomfield',40.8068,-74.1854,['07003'],1],['West Orange',40.7987,-74.2390,['07052'],.8],
    ['Belleville',40.7937,-74.1501,['07109'],.8],['Nutley',40.8223,-74.1599,['07110'],.6],['Maplewood',40.7312,-74.2735,['07040'],.4]],
  Union: [['Elizabeth',40.6640,-74.2107,['07201','07202','07206','07208'],4],['Plainfield',40.6337,-74.4074,['07060','07062','07063'],2],
    ['Union',40.6976,-74.2632,['07083'],1],['Linden',40.6220,-74.2446,['07036'],1.2],['Rahway',40.6082,-74.2776,['07065'],1],
    ['Hillside',40.7012,-74.2301,['07205'],.7],['Roselle',40.6645,-74.2632,['07203'],.8],['Summit',40.7157,-74.3646,['07901'],.5],
    ['Westfield',40.6590,-74.3474,['07090'],.4],['Cranford',40.6584,-74.2999,['07016'],.4]],
  Bergen: [['Hackensack',40.8859,-74.0435,['07601'],2.5],['Fort Lee',40.8509,-73.9781,['07024'],2],['Englewood',40.8929,-73.9726,['07631'],1],
    ['Cliffside Park',40.8215,-73.9877,['07010'],1.2],['Teaneck',40.8976,-74.0160,['07666'],1],['Garfield',40.8815,-74.1132,['07026'],1.5],
    ['Lodi',40.8823,-74.0832,['07644'],1],['Fairview',40.8126,-73.9993,['07022'],.8],['Ridgefield Park',40.8571,-74.0215,['07660'],.6],
    ['Paramus',40.9445,-74.0754,['07652'],.3],['Bergenfield',40.9276,-73.9974,['07621'],.6]],
  'Hudson Valley': [['Newburgh',41.5034,-74.0104,['12550'],2],['Poughkeepsie',41.7004,-73.9210,['12601','12603'],2],
    ['Middletown',41.4459,-74.4229,['10940'],1.2],['Kingston',41.9270,-73.9974,['12401'],1],['Spring Valley',41.1132,-74.0438,['10977'],1.5],
    ['Monsey',41.1112,-74.0685,['10952'],1],['Beacon',41.5048,-73.9696,['12508'],.6],['Peekskill',41.2901,-73.9204,['10566'],.8],
    ['Nyack',41.0907,-73.9179,['10960'],.4],['Haverstraw',41.1976,-73.9646,['10927'],.5]],
};
const COUNTS = { Essex: 4200, Union: 3000, Bergen: 3300, 'Hudson Valley': 2000 };
const NO_OWNER = 650; // properties with no owner (Rule 4: excluded from broker views)

const FIRST = ['Aaron','Abraham','Adele','Alan','Alice','Amir','Ana','Benjamin','Bernard','Carla','Carlos','Chaim','Clara','Daniel','David','Deborah','Dina','Dov','Eduardo','Elaine','Elena','Esther','Ezra','Felix','Frank','Gabriel','Gloria','Hannah','Harold','Ines','Irving','Isaac','Jacob','Janet','Jorge','Judith','Kenneth','Laura','Leah','Leon','Lucia','Marcus','Maria','Martin','Meyer','Miriam','Moshe','Nathan','Nina','Oscar','Pablo','Patricia','Paul','Rachel','Raymond','Rebecca','Reuven','Rosa','Ruth','Samuel','Sandra','Saul','Shira','Simon','Sofia','Stanley','Tamar','Theodore','Victor','Walter','Yael','Yosef','Zev'];
const LAST = ['Abrams','Alvarez','Baker','Berger','Blum','Brennan','Castro','Cohen','Coleman','Diaz','Dorfman','Eisen','Feld','Ferreira','Fischer','Gold','Gomez','Green','Halpern','Hart','Herrera','Hoffman','Jacobs','Kaplan','Katz','Klein','Lerner','Levin','Lopez','Marx','Mendez','Miller','Morales','Nadler','Novak','Ortiz','Pereira','Perlman','Price','Ramos','Reyes','Rivera','Rubin','Russo','Sands','Schwartz','Segal','Shapiro','Silva','Stein','Stern','Tanaka','Torres','Vargas','Weiss','Wexler','Wolf','Zimmer'];
const STREETS = ['Broad St','Market St','Central Ave','Park Ave','Main St','Elm St','Grove St','Springfield Ave','Clinton Ave','Bergen St','Orange St','Washington St','Lincoln Ave','Madison Ave','Chestnut St','Union Ave','Morris Ave','Prospect St','Summit Ave','Hudson St','Liberty St','Mill St','River Rd','Highland Ave','Maple Ave','Franklin St','Jefferson St','Palisade Ave','Anderson Ave','Front St'];
const LLC_WORDS = ['Garden','Park','Crest','Summit','Harbor','Oak','Maple','Liberty','Pioneer','Keystone','Gateway','Metro','Riverside','Hillside','Union','Bergen','Essex','Clinton','Broad','Orchard','Willow','Cedar','Granite','Beacon','Sterling'];
const LLC_TAIL = ['Realty LLC','Holdings LLC','Properties LLC','Apartments LLC','Associates LLC','Management Corp','Equities LLC','Housing LLC','Owners Corp','Realty Associates'];
const ROLES = ['Principal', 'Manager', 'Attorney', 'Accountant', 'Super'];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const TODAY = () => new Date();

// ── generation ───────────────────────────────────────────────
let CACHE = null;
export function generateBase() {
  if (CACHE) return CACHE;
  const r = rng(20261002);
  const T = TABLES;
  const F = (t) => T[t].fields;
  const tables = {}; for (const k of Object.keys(T)) tables[T[k].name] = [];
  const created = '2024-01-15T12:00:00.000Z';
  const mk = (t, fields) => { const rec = { id: recId(r), createdTime: created, fields }; tables[T[t].name].push(rec); return rec; };
  const link = (rec, field, id) => { (rec.fields[field] ||= []).push(id); };
  const person = () => `${r.pick(FIRST)} ${r.pick(LAST)}`;
  const phone = () => `(${r.pick(['201','973','908','845','914'])}) 555-${String(r.int(0, 9999)).padStart(4, '0')}`;

  // Users (brokers)
  const users = {};
  for (const b of BROKERS) users[b.key] = mk('users', { [F('users').name]: b.name, [F('users').territory]: b.territory, [F('users').role]: 'Broker' });
  const brokerByCounty = Object.fromEntries(BROKERS.filter(b => b.county).map(b => [b.county, users[b.key]]));

  // Properties
  const props = [];
  const townWeights = (county) => { const ts = TOWNS[county]; const tot = ts.reduce((s, t) => s + t[4], 0); return () => { let x = r() * tot; for (const t of ts) { x -= t[4]; if (x <= 0) return t; } return ts[0]; }; };
  const makeProp = (county, withUser) => {
    const town = townWeights(county)();
    const units = Math.max(5, Math.round(Math.exp(r.gauss() * 0.75 + 2.9)));
    const yearBuilt = Math.min(2022, Math.max(1890, Math.round(1955 + r.gauss() * 25)));
    const saleYear = r.int(Math.max(1985, yearBuilt), 2025);
    const saleDate = new Date(Date.UTC(saleYear, r.int(0, 11), r.int(1, 28)));
    const ppu = { Essex: 140000, Union: 155000, Bergen: 230000, 'Hudson Valley': 120000 }[county] * Math.pow(1.045, saleYear - 2024) * (0.75 + r() * 0.5);
    const f = F('properties');
    const fields = {
      [f.address]: `${r.int(1, 1450)} ${r.pick(STREETS)}`, [f.city]: town[0], [f.zip]: r.pick(town[3]), [f.county]: county,
      [f.units]: units, [f.yearBuilt]: yearBuilt, [f.lastSaleDate]: iso(saleDate),
      [f.lastSalePrice]: Math.round(units * ppu / 1000) * 1000,
      [f.apn]: `${r.int(100, 9999)}-${r.int(1, 99)}`,
      [f.lat]: +(town[1] + r.gauss() * 0.011).toFixed(6), [f.lng]: +(town[2] + r.gauss() * 0.013).toFixed(6),
    };
    if (r.chance(0.42)) fields[f.loanMaturity] = iso(new Date(Date.UTC(r.int(2025, 2033), r.int(0, 11), 1)));
    const rec = mk('properties', fields);
    if (withUser && brokerByCounty[county]) link(rec, f.users, brokerByCounty[county].id);
    rec._county = county; rec._saleDate = saleDate;
    return rec;
  };
  for (const [county, n] of Object.entries(COUNTS)) for (let i = 0; i < n; i++) props.push(makeProp(county, true));
  const noOwner = [];
  for (let i = 0; i < NO_OWNER; i++) noOwner.push(makeProp(r.pick(['Essex', 'Union', 'Bergen']), r.chance(0.5)));

  // Entities + Contacts. Hudson Valley is the known gap: owners/managers combined in a raw text field, unlinked.
  const ents = [];
  const ef = F('entities'), cf = F('contacts'), of = F('ownership'), pf = F('properties');
  const newEntity = () => {
    const isInd = r.chance(0.27);
    const type = isInd ? 'Individual' : r.pick(['LLC', 'LLC', 'LLC', 'LLC', 'Corporation', 'Trust']);
    const principal = person();
    const name = isInd ? principal : type === 'Trust' ? `${principal.split(' ')[1]} Family Trust` : (() => { const a = r.pick(LLC_WORDS); let b = r.pick(LLC_WORDS); while (b === a) b = r.pick(LLC_WORDS); return `${a} ${b} ${r.pick(LLC_TAIL)}`; })();
    const e = mk('entities', { [ef.name]: name, [ef.type]: type, [ef.nameBasis]: isInd ? 'Deed' : r.pick(['Deed', 'NJ Business Registry', 'Broker Research']), [ef.dataSource]: r.pick(['ATTOM', 'County Records', 'Broker Entry', 'PropertyShark']) });
    // Rule 1: an individual owner appears BOTH as an Individual entity and as a Contact with Role = Principal.
    const contacts = [{ name: principal, role: 'Principal' }];
    if (!isInd || r.chance(0.3)) { const n = r.int(0, 2); for (let i = 0; i < n; i++) contacts.push({ name: person(), role: r.pick(ROLES.slice(1)) }); }
    for (const c of contacts) {
      const cr = mk('contacts', { [cf.name]: c.name, [cf.role]: c.role, [cf.phone]: phone(),
        [cf.email]: r.chance(0.6) ? `${c.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` : undefined });
      link(cr, cf.entities, e.id); link(e, ef.contacts, cr.id);
    }
    ents.push(e); return e;
  };
  const own = (prop, ent, start, end) => {
    const o = mk('ownership', { [of.property]: [prop.id], [of.entity]: [ent.id], [of.start]: iso(start), [of.end]: end ? iso(end) : undefined, [of.share]: 1 });
    link(prop, pf.ownership, o.id); link(ent, ef.ownership, o.id);
  };

  const ownedProps = props.filter(p => p._county !== 'Hudson Valley');
  // Shuffle then assign portfolios (power-law sizes); ~9% of multi-property owners span two NJ counties → shared across brokers.
  for (let i = ownedProps.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ownedProps[i], ownedProps[j]] = [ownedProps[j], ownedProps[i]]; }
  const byCounty = { Essex: [], Union: [], Bergen: [] }; for (const p of ownedProps) byCounty[p._county].push(p);
  const take = (c) => byCounty[c].pop();
  const NJ = ['Essex', 'Union', 'Bergen'];
  const adjacent = { Essex: ['Union', 'Bergen'], Union: ['Essex'], Bergen: ['Essex'] };
  while (NJ.some(c => byCounty[c].length)) {
    const home = r.pick(NJ.filter(c => byCounty[c].length));
    const size = r.chance(0.86) ? 1 : Math.min(18, 2 + Math.floor(Math.exp(r() * 2.4)));
    const e = newEntity();
    for (let k = 0; k < size; k++) {
      let c = home;
      if (k > 0 && r.chance(0.28)) { const alt = r.pick(adjacent[home]); if (byCounty[alt].length) c = alt; }
      const p = take(c) || take(home); if (!p) break;
      own(p, e, p._saleDate, null);
      if (r.chance(0.48)) { // historical owner
        const prior = r.chance(0.25) && ents.length > 10 ? ents[r.int(0, ents.length - 2)] : newEntity();
        own(p, prior, new Date(p._saleDate.getTime() - r.int(4, 25) * 365 * 864e5), p._saleDate);
      }
    }
  }
  // Rule 3: entity/contacts carry the Users of every broker whose properties they own → shared, never duplicated.
  const propById = new Map(tables[T.properties.name].map(p => [p.id, p]));
  const ownById = new Map(tables[T.ownership.name].map(o => [o.id, o]));
  const contactById = new Map(tables[T.contacts.name].map(c => [c.id, c]));
  for (const e of ents) {
    const bros = new Set();
    for (const oid of e.fields[ef.ownership] || []) { const o = ownById.get(oid); if (o.fields[of.end]) continue;
      for (const u of propById.get(o.fields[of.property][0]).fields[pf.users] || []) bros.add(u); }
    for (const cid of e.fields[ef.contacts] || []) { const c = contactById.get(cid); for (const u of bros) if (!(c.fields[cf.users] || []).includes(u)) link(c, cf.users, u); }
  }
  // Hudson Valley gap: combined raw text, no links.
  for (const p of props.filter(p => p._county === 'Hudson Valley'))
    p.fields[pf.ownerRaw] = `${r.pick(LLC_WORDS)} ${r.pick(LLC_TAIL)} / ${person()} (Mgr) ${phone()}`;

  // Historical contact logs (last ~14 months), mostly in-territory, with deliberate cross-broker overlap.
  const lf = F('logs');
  const outcomes = ['spoke', 'left message', 'no answer', 'met in person', 'email'];
  const allContacts = tables[T.contacts.name].filter(c => (c.fields[cf.users] || []).length);
  const brokerName = Object.fromEntries(Object.values(users).map(u => [u.id, u.fields[F('users').name]]));
  const now = TODAY();
  for (let i = 0; i < 3200; i++) {
    const c = r.pick(allContacts); const us = c.fields[cf.users];
    const u = us.length > 1 && r.chance(0.5) ? us[1] : us[0];
    const d = addDays(now, -Math.floor(Math.pow(r(), 1.3) * 420));
    const outcome = r.pick(outcomes);
    const signal = r.chance(0.82) ? 'none' : r.pick(['selling interest', 'refinancing', '1031 exchange']);
    const fu = r.chance(0.35) ? addDays(d, r.int(7, 120)) : null;
    const note = noteText(r, c.fields[cf.name], outcome, signal, fu);
    mk('logs', { [lf.date]: d.toISOString(), [lf.broker]: [u], [lf.contact]: [c.id], [lf.channel]: outcome === 'email' ? 'email' : outcome === 'met in person' ? 'in person' : 'call',
      [lf.outcome]: outcome, [lf.note]: note, [lf.dealSignal]: signal, [lf.cooldown]: r.chance(0.04),
      [lf.followUp]: fu ? iso(fu) : undefined, _brokerName: brokerName[u] });
    link(c, cf.logs, tables[T.logs.name][tables[T.logs.name].length - 1].id);
  }
  for (const rec of tables[T.logs.name]) delete rec.fields._brokerName;
  for (const p of tables[T.properties.name]) { delete p._county; delete p._saleDate; }
  // strip undefined
  for (const t of Object.values(tables)) for (const rec of t) for (const k of Object.keys(rec.fields)) if (rec.fields[k] === undefined) delete rec.fields[k];
  CACHE = { tables, users };
  return CACHE;
}

function noteText(r, name, outcome, signal, fu) {
  const first = name.split(' ')[0];
  const base = {
    'spoke': [`Spoke w/ ${first}, `, `Got ${first} on the phone — `, `Talked to ${name}. `],
    'left message': [`LM for ${first}. `, `Left vm w/ ${name}, `, `left msg ${first} `],
    'no answer': [`No answer ${first}. `, `NA — tried ${name} `, `called ${first} no pickup `],
    'met in person': [`Met ${first} at the property. `, `Sat down with ${name} at his office. `, `Walked the building with ${first}. `],
    'email': [`Emailed ${first} the comps. `, `Sent ${name} an email re: valuation. `, `emailed ${first} BOV `],
  }[outcome];
  const sig = { 'none': ['not looking to sell right now', 'happy holding', 'just wanted to touch base', ''],
    'selling interest': ['might sell if number is right', 'open to offers, wants a BOV', 'thinking about selling next yr'],
    'refinancing': ['loan coming due, looking at refi', 'talking to lenders about a refi'],
    '1031 exchange': ['wants to 1031 into something bigger', 'looking for 1031 replacement'] }[signal];
  const s = r.pick(sig);
  return (r.pick(base) + s + (fu ? `${s ? '. ' : ''}f/u ${fu.getMonth() + 1}/${fu.getDate()}` : '')).replace(/[,\s—-]+$/, '').trim();
}

// ── persistence of writes made during testing (overlay on the generated base) ──
const overlayStore = store('mockbase');
let overlay = null;
// Re-read on every call so separate serverless instances see each other's writes (like a real shared base).
async function loadOverlay() { overlay = (await overlayStore.get('overlay')) || { created: {}, patched: {} }; return overlay; }
async function saveOverlay() { await overlayStore.set('overlay', overlay); }
export async function resetMockOverlay() { overlay = { created: {}, patched: {} }; await saveOverlay(); }

async function tableRecords(tableName) {
  const { tables } = generateBase(); const ov = await loadOverlay();
  const base = tables[tableName] || [];
  const all = base.concat(ov.created[tableName] || []);
  const mt = ov.mt || {};
  return all.map(rec => ({ ...rec, _mt: mt[rec.id] || rec.createdTime, fields: ov.patched[rec.id] ? { ...rec.fields, ...ov.patched[rec.id] } : rec.fields }));
}

// Directly mutate the mock base (used by the "edit in Airtable" step of Test 2 in mock mode).
export async function mockAirtableEdit(tableName, id, fields) { await loadOverlay(); overlay.patched[id] = { ...(overlay.patched[id] || {}), ...fields }; (overlay.mt ||= {})[id] = new Date().toISOString(); await saveOverlay(); }

// ── fake fetch speaking Airtable REST ────────────────────────
const hits = [];
export function mockFetch({ latencyMs = [90, 220], enforceRateLimit = true } = {}) {
  const r = rng(Date.now() & 0xffff);
  return async (url, init = {}) => {
    const now = Date.now(); while (hits.length && now - hits[0] > 1000) hits.shift(); hits.push(now);
    await new Promise(res => setTimeout(res, r.int(latencyMs[0], latencyMs[1])));
    if (enforceRateLimit && hits.length > 5) return json({ errors: [{ type: 'RATE_LIMIT_REACHED' }] }, 429);
    const u = new URL(url); const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); // v0, base, table, id?
    if (parts[1] === 'meta') return json({ tables: Object.values(TABLES).map(t => ({ name: t.name, fields: Object.values(t.fields).map(n => ({ name: n })) })) });
    const table = parts[2]; const id = parts[3]; const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' && id) { const rec = (await tableRecords(table)).find(x => x.id === id); if (!rec) return json({ error: 'NOT_FOUND' }, 404); const { _mt, ...o } = rec; return json(o); }
    if (method === 'GET') {
      let recs = await tableRecords(table);
      const formula = u.searchParams.get('filterByFormula');
      const since = formula && formula.match(/LAST_MODIFIED_TIME\(\)\s*,\s*'([^']+)'/);
      if (since) recs = recs.filter(x => x._mt > since[1]);
      const view = u.searchParams.get('view');
      if (view) { const { tables } = generateBase(); const usr = tables[TABLES.users.name].find(x => x.fields[TABLES.users.fields.name] === view);
        const pf = TABLES.properties.fields; recs = usr ? recs.filter(x => (x.fields[pf.users] || []).includes(usr.id) && (x.fields[pf.ownership] || []).length && hasCurrent(x, tables)) : []; }
      if (formula && !since) { const ids = [...formula.matchAll(/RECORD_ID\(\)\s*=\s*'(rec[A-Za-z0-9]+)'/g)].map(m => m[1]); const set = new Set(ids); recs = recs.filter(x => set.has(x.id)); }
      const fields = u.searchParams.getAll('fields[]');
      const size = Math.min(100, +(u.searchParams.get('pageSize') || 100)); const off = +(u.searchParams.get('offset') || 0);
      const page = recs.slice(off, off + size).map(({ _mt, ...x }) => x).map(x => fields.length ? { ...x, fields: Object.fromEntries(Object.entries(x.fields).filter(([k]) => fields.includes(k))) } : x);
      return json({ records: page, ...(off + size < recs.length ? { offset: String(off + size) } : {}) });
    }
    const body = JSON.parse(init.body || '{}'); await loadOverlay();
    if (method === 'POST') {
      const out = (body.records || []).map(x => ({ id: recId(r), createdTime: new Date().toISOString(), fields: x.fields }));
      const contacts = table === TABLES.logs.name ? await tableRecords(TABLES.contacts.name) : null; // (reloads overlay — do before mutating)
      (overlay.created[table] ||= []).push(...out);
      if (contacts) { // Airtable maintains reverse links automatically; emulate it
        for (const l of out) for (const cid of l.fields[TABLES.logs.fields.contact] || []) { const c = contacts.find(x => x.id === cid); if (!c) continue;
          overlay.patched[cid] = { ...(overlay.patched[cid] || {}), [TABLES.contacts.fields.logs]: [...(c.fields[TABLES.contacts.fields.logs] || []), l.id] }; (overlay.mt ||= {})[cid] = new Date().toISOString(); }
      }
      await saveOverlay(); return json({ records: out });
    }
    if (method === 'PATCH') {
      const out = []; for (const x of body.records || []) { overlay.patched[x.id] = { ...(overlay.patched[x.id] || {}), ...x.fields }; (overlay.mt ||= {})[x.id] = new Date().toISOString(); out.push({ id: x.id, fields: x.fields }); }
      await saveOverlay(); return json({ records: out });
    }
    return json({ error: 'UNSUPPORTED' }, 400);
  };
}
let CURRENT_OWN = null;
function hasCurrent(p, tables) {
  CURRENT_OWN ||= new Set(tables[TABLES.ownership.name].filter(o => !o.fields[TABLES.ownership.fields.end]).map(o => o.id));
  return (p.fields[TABLES.properties.fields.ownership] || []).some(id => CURRENT_OWN.has(id));
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
