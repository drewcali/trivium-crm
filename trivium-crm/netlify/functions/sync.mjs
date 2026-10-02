// Scheduled every 10 min (netlify.toml): pull only records changed since the last sync.
// Typically 6 small Airtable requests. Once a night it hands off a full re-sync to the
// background function (catches deletions; ~600 requests, ~2.5 min at 4 req/s).
import { incrementalSync } from '../../lib/snapshot.mjs';
import { env } from '../../lib/config.mjs';

export default async () => {
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  if (h === 7 && m < 10) { // ~3am ET
    await fetch(`${env('URL')}/.netlify/functions/sync-background`, { method: 'POST', headers: { 'x-sync-secret': env('SYNC_SECRET', '') } });
    return new Response('full sync dispatched');
  }
  const meta = await incrementalSync(console.log);
  return new Response(JSON.stringify({ changed: meta.changed, ms: meta.durationMs }));
};
