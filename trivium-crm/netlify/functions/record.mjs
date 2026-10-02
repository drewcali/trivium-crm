// GET  /api/record?id=<propertyId>  — live read from Airtable + cooldown + rationale
// POST /api/rationale {id}           — generate (or regenerate) the "why this owner" text now
import { handler, json, bad } from '../../lib/http.mjs';
import { liveRecord, rationaleOnDemand } from '../../lib/record.mjs';

export default handler(async (req, ctx, user) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/rationale') && req.method === 'POST') {
    const { id } = await req.json(); if (!id) return bad('id required');
    return json(await rationaleOnDemand(user, id));
  }
  const id = url.searchParams.get('id'); if (!id) return bad('id required');
  return json(await liveRecord(user, id));
});

export const config = { path: ['/api/record', '/api/rationale'] };
