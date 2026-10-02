// Background function (up to 15 min): full Airtable → cache sync.
// Protected by a shared secret; only the scheduler and the admin API call it.
import { fullSync } from '../../lib/snapshot.mjs';
import { batchChanged } from '../../lib/rationale.mjs';
import { env, CLAUDE } from '../../lib/config.mjs';
import { base } from '../../lib/record.mjs';

export default async (req) => {
  if (!env('SYNC_SECRET') || req.headers.get('x-sync-secret') !== env('SYNC_SECRET')) return new Response('forbidden', { status: 403 });
  const meta = await fullSync(console.log);
  console.log('full sync done', JSON.stringify(meta));
  if (CLAUDE.apiKey() && env('RATIONALE_BATCH') === 'on') { // regenerate only rationales whose inputs changed
    const { base: b, idx } = await base();
    const owned = b.properties.filter(p => p.ownershipIds.some(id => !idx.own.get(id)?.end));
    console.log('rationale batch', JSON.stringify(await batchChanged(owned)));
  }
};
