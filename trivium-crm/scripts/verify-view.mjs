// Test 6 parity check: does the app's broker filter return EXACTLY the records in Trivium's
// "Eli Rosen" view on Properties? Run after a full sync, with AIRTABLE_TOKEN + AIRTABLE_BASE_ID set.
// Usage: node scripts/verify-view.mjs ["Eli Rosen"] [view name, defaults to broker name]
import { client } from '../lib/airtable.mjs';
import { getBase } from '../lib/snapshot.mjs';
import { inBrokerView } from '../lib/model.mjs';

const broker = process.argv[2] || 'Eli Rosen';
const view = process.argv[3] || broker;
const { base } = await getBase();
const user = base.users.find(u => u.name === broker);
if (!user) { console.error(`No Users record named ${broker}`); process.exit(1); }
const own = new Map(base.ownership.map(o => [o.id, o]));
const ours = new Set(base.properties.filter(p => inBrokerView(p, user.id, own)).map(p => p.id));
const theirs = new Set((await client().listAll('properties', { view, fields: [] })).map(r => r.id));
const onlyOurs = [...ours].filter(id => !theirs.has(id)), onlyTheirs = [...theirs].filter(id => !ours.has(id));
console.log(`App filter: ${ours.size} · Airtable view "${view}": ${theirs.size}`);
console.log(`In app but not in view: ${onlyOurs.length}${onlyOurs.length ? ' e.g. ' + onlyOurs.slice(0, 5).join(', ') : ''}`);
console.log(`In view but not in app: ${onlyTheirs.length}${onlyTheirs.length ? ' e.g. ' + onlyTheirs.slice(0, 5).join(', ') : ''}`);
console.log(onlyOurs.length + onlyTheirs.length === 0 ? '✓ EXACT MATCH' : '✗ Mismatch — inspect the view filter in Airtable and adjust inBrokerView() in lib/model.mjs');
process.exit(onlyOurs.length + onlyTheirs.length ? 1 : 0);
