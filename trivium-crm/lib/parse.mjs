// Note parsing (Test 3). Claude extracts structured fields from how brokers actually write.
// If the Claude API is slow, down, or not configured, a rules parser runs instead — the
// note is ALWAYS saved; parsing only fills fields, and uncertain fields are flagged, not guessed.
import { CLAUDE, OUTCOMES, DEAL_SIGNALS, env } from './config.mjs';

const PRICE = () => ({ in: +env('PRICE_IN_PER_MTOK', 1), out: +env('PRICE_OUT_PER_MTOK', 5) }); // USD per million tokens — verify current pricing

const SYSTEM = `You extract structured data from commercial real estate broker contact notes (multifamily owners).
Brokers write tersely: "LM" / "VM" = left message, "NA" = no answer, "f/u" = follow up, "BOV" = broker opinion of value, "1031" = 1031 exchange, "DNC" = do not call.
For each note return an object with:
- "i": the note's index
- "contact_name": person the broker contacted, as written (null if not stated)
- "outcome": one of ${JSON.stringify(OUTCOMES)} or null if unclear
- "follow_up_date": ISO date YYYY-MM-DD resolved against the note date, or null. Relative phrases ("in 2 weeks", "after Passover", "next spring") must be resolved to a date only if unambiguous; otherwise null and list it as uncertain.
- "deal_signal": one of ${JSON.stringify(DEAL_SIGNALS)}
- "cooldown": true if the owner asked not to be contacted, was hostile, or the broker judged it too soon to call again; else false
- "cooldown_reason": short phrase or null
- "uncertain": array of field names you are not confident about
- "why_uncertain": one short sentence, or null
Never guess. If a field is ambiguous, set it null (or the safest value) and list it in "uncertain".
Respond with ONLY a JSON array.`;

export async function parseNotes(notes /* [{text, date?, contactName?}] */, { timeoutMs = CLAUDE.timeoutMs } = {}) {
  const key = CLAUDE.apiKey();
  if (!key) return { engine: 'rules', results: notes.map(rulesParse), usage: null };
  const results = []; const usage = { input_tokens: 0, output_tokens: 0, calls: 0, ms: 0 };
  for (let i = 0; i < notes.length; i += 20) {
    const chunk = notes.slice(i, i + 20);
    const user = chunk.map((n, j) => `[${i + j}] (note date ${(n.date || new Date().toISOString()).slice(0, 10)}${n.contactName ? `, logged on contact ${n.contactName}` : ''})\n${n.text}`).join('\n\n');
    try {
      const t0 = Date.now();
      const r = await claude({ model: CLAUDE.parseModel(), system: SYSTEM, max_tokens: 4000, messages: [{ role: 'user', content: user }] }, timeoutMs);
      usage.ms += Date.now() - t0; usage.calls++; usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
      const arr = JSON.parse(r.content[0].text.replace(/^```(json)?|```$/g, '').trim());
      for (const o of arr) results[o.i] = { ...sanitize(o), engine: 'claude' };
    } catch (e) {
      console.warn('Claude parse failed, using rules:', e.message);
      chunk.forEach((n, j) => { results[i + j] = { ...rulesParse(n), engine: 'rules', fallbackReason: e.message }; });
    }
  }
  for (let i = 0; i < notes.length; i++) results[i] ||= { ...rulesParse(notes[i]), engine: 'rules' };
  const p = PRICE(); usage.cost_usd = +((usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6).toFixed(5);
  return { engine: 'claude', results, usage };
}

const sanitize = (o) => ({
  contact_name: o.contact_name ?? null,
  outcome: OUTCOMES.includes(o.outcome) ? o.outcome : null,
  follow_up_date: /^\d{4}-\d{2}-\d{2}$/.test(o.follow_up_date || '') ? o.follow_up_date : null,
  deal_signal: DEAL_SIGNALS.includes(o.deal_signal) ? o.deal_signal : 'none',
  cooldown: !!o.cooldown, cooldown_reason: o.cooldown_reason || null,
  uncertain: Array.isArray(o.uncertain) ? o.uncertain : [], why_uncertain: o.why_uncertain || null,
});

export async function claude(body, timeoutMs = CLAUDE.timeoutMs) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': CLAUDE.apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ── rules fallback (no API) ─────────────────────────────────
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export function rulesParse(n) {
  const text = n.text || ''; const t = text.toLowerCase(); const base = new Date(n.date || Date.now());
  const uncertain = [];
  let outcome = null;
  if (/\b(met|sat down|walked|in person|toured|coffee with|lunch with)\b/.test(t)) outcome = 'met in person';
  else if (/\b(spoke|spk|talked|got (him|her|\w+) on|on the phone|picked up|conversation|hung up|(he|she) said)\b/.test(t)) outcome = 'spoke';
  else if (/\b(lm|vm|left (a )?(msg|message|vm|voicemail)|voicemail)\b/.test(t)) outcome = 'left message';
  else if (/\b(na|no answer|no pick ?up|didn'?t pick up|not picking up|rang out)\b/.test(t)) outcome = 'no answer';
  else if (/\b(emailed|e-mailed|sent (an )?email|email(ed)? (him|her|them)|replied|sent \w+( \w+)? an? email)\b/.test(t)) outcome = 'email';
  if (!outcome) uncertain.push('outcome');

  let deal_signal = 'none';
  if (/\b1031\b/.test(t)) deal_signal = '1031 exchange';
  else if (/\b(refi|refinanc\w*|lender|loan (is )?(coming )?due|rate (is )?resetting)\b/.test(t)) deal_signal = 'refinancing';
  else if (/\b(sell|selling|offers?|bov|list(ing)? it|number is right|price is right|cash out|exit|listed with|force a sale)\b/.test(t) && !/\b(not (looking to |interested in )?sell|no interest in sell|not selling)/.test(t)) deal_signal = 'selling interest';

  const cooldownHit = t.match(/\b(dnc|do not call|don'?t call|stop calling|take (me|him|her) off|remove (me|him|her)|not interested.{0,20}(again|ever)|hung up|hostile|too soon|give (it|him|her) (a few|some) (months|time)|back off)\b/);

  let follow_up_date = null;
  const md = t.match(/\b(?:f\/u|fu|follow[ -]?up|call back|cb|reach out|circle back)\b[^.\n]{0,25}?\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const rel = t.match(/\b(?:f\/u|fu|follow[ -]?up|call back|cb|reach out|circle back|try again)\b[^.\n]{0,20}?\bin (\d+|a|one|two|three|six) (day|week|month)s?\b/);
  const mon = t.match(/\b(?:f\/u|fu|follow[ -]?up|call back|cb|reach out|circle back|try again)\b[^.\n]{0,20}?\b(?:in |early |mid |late )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (md) { const y = md[3] ? (md[3].length === 2 ? 2000 + +md[3] : +md[3]) : base.getFullYear(); let d = new Date(Date.UTC(y, +md[1] - 1, +md[2])); if (!md[3] && d < base) d.setUTCFullYear(y + 1); follow_up_date = d.toISOString().slice(0, 10); }
  else if (rel) { const nmap = { a: 1, one: 1, two: 2, three: 3, six: 6 }; const k = nmap[rel[1]] ?? +rel[1]; const d = new Date(base);
    if (rel[2] === 'day') d.setUTCDate(d.getUTCDate() + k); else if (rel[2] === 'week') d.setUTCDate(d.getUTCDate() + 7 * k); else d.setUTCMonth(d.getUTCMonth() + k); follow_up_date = d.toISOString().slice(0, 10); }
  else if (mon) { const m = MONTHS.indexOf(mon[1]); let y = base.getFullYear(); if (m < base.getMonth()) y++; follow_up_date = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); uncertain.push('follow_up_date'); }
  else if (/\b(f\/u|follow up|call back|after (the )?holidays?|next (year|spring|summer|fall|quarter))\b/.test(t)) uncertain.push('follow_up_date');

  let contact_name = n.contactName || null;
  if (!contact_name) {
    const STOP = /^(The|His|Her|Owner|Super|Assistant|Re|Valuation|Elizabeth|Newark|Bergen|Plainfield|Union|Essex|Q\d)$/;
    const pats = [/\b(?:owner(?: is)?|Owner(?: is)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/, /\(([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\)/,
      /\b(?:w\/|[Ww]ith|[Ff]or|[Tt]o|[Cc]alled|[Ee]mailed|[Mm]et|[Gg]ot|[Tt]ried|[Ss]ent|[Pp]ickup|LM|NA|VM)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g];
    for (const re of pats) { for (const m of text.matchAll(re.global ? re : new RegExp(re.source, 'g'))) { const nm = m[1].split(' ').filter(w => !STOP.test(w)).join(' '); if (nm && !STOP.test(nm)) { contact_name = nm; break; } } if (contact_name) break; }
    if (!contact_name) uncertain.push('contact_name');
  }

  return { contact_name, outcome, follow_up_date, deal_signal, cooldown: !!cooldownHit, cooldown_reason: cooldownHit ? cooldownHit[0] : null,
    uncertain, why_uncertain: uncertain.length ? `Rules parser could not determine: ${uncertain.join(', ')}` : null };
}
