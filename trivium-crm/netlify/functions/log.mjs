// POST  /api/log   — save a broker note as a Contact Logs record in Airtable.
//   Free text is parsed (Claude → rules fallback) into outcome / follow-up / deal signal / cooldown.
//   Fields the broker set explicitly always win over parsed values.
//   Idempotent on clientId: a note retried from the offline outbox is never written twice.
// PATCH /api/log   — edit a log (own logs for brokers, any log for admin).
import { handler, json, bad } from '../../lib/http.mjs';
import { client } from '../../lib/airtable.mjs';
import { normalize, logToFields } from '../../lib/model.mjs';
import { canActOnContact, base } from '../../lib/record.mjs';
import { parseNotes } from '../../lib/parse.mjs';
import { PENDING, writableFields } from '../../lib/snapshot.mjs';
import { OUTCOMES, DEAL_SIGNALS, CHANNELS, TABLES } from '../../lib/config.mjs';

export default handler(async (req, ctx, user) => {
  const at = client();
  if (req.method === 'POST') {
    const b = await req.json();
    if (!b.contactId || !(b.note || '').trim()) return bad('contactId and note are required');
    if (!b.clientId) return bad('clientId required');
    if (!(await canActOnContact(user, b.contactId))) return bad('Not in your territory', 403);
    const dup = await PENDING.get('client:' + b.clientId);
    if (dup) return json({ log: dup, duplicate: true });

    const { idx } = await base();
    const contactName = idx.con.get(b.contactId)?.name;
    const date = b.date || new Date().toISOString();
    const t0 = Date.now();
    const parsed = (await parseNotes([{ text: b.note, date, contactName }]));
    const p = parsed.results[0];
    const brokerId = user.role === 'admin' ? (b.asBrokerId || null) : user.userRecId;
    if (!brokerId) return bad('Admin must choose which broker this log is for (asBrokerId)');
    const log = {
      date, brokerId, contactId: b.contactId,
      channel: CHANNELS.includes(b.channel) ? b.channel : p.outcome === 'email' ? 'email' : p.outcome === 'met in person' ? 'in person' : 'call',
      outcome: OUTCOMES.includes(b.outcome) ? b.outcome : (p.outcome || ''),
      followUp: b.followUp || p.follow_up_date || null,
      note: b.note.trim(),
      dealSignal: DEAL_SIGNALS.includes(b.dealSignal) ? b.dealSignal : p.deal_signal,
      cooldown: typeof b.cooldown === 'boolean' ? b.cooldown : p.cooldown,
      clientId: b.clientId,
    };
    const [rec] = await at.create('logs', [await writableFields('logs', logToFields(log))]);
    const saved = { ...normalize('logs', rec), ...log, id: rec.id };
    await PENDING.set(`log:${new Date().toISOString()}:${rec.id}`, saved);
    await PENDING.set('client:' + b.clientId, saved);
    return json({ log: saved, parsed: { ...p, engine: parsed.engine === 'claude' ? p.engine : 'rules' }, ms: Date.now() - t0 });
  }
  if (req.method === 'PATCH') {
    const b = await req.json(); if (!b.id) return bad('id required');
    const cur = normalize('logs', await at.get('logs', b.id));
    if (user.role !== 'admin' && cur.brokerId !== user.userRecId) return bad('You can only edit your own logs', 403);
    const next = { ...cur };
    for (const k of ['outcome', 'followUp', 'note', 'dealSignal', 'cooldown', 'channel']) if (k in (b.fields || {})) next[k] = b.fields[k];
    const m = TABLES.logs.fields;
    const fields = await writableFields('logs', { [m.outcome]: next.outcome, [m.followUp]: next.followUp || null, [m.note]: next.note, [m.dealSignal]: next.dealSignal, [m.cooldown]: !!next.cooldown, [m.channel]: next.channel });
    await at.update('logs', [{ id: b.id, fields }]);
    await PENDING.set(`log:${new Date().toISOString()}:${b.id}`, next);
    return json({ log: next });
  }
  return bad('Method not allowed', 405);
});

export const config = { path: '/api/log' };
