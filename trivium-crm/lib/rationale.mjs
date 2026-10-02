// "Why this owner, now" (Test 5). Generated from ONLY: units, year built, last sale date/price,
// hold period, loan maturity. Cached per property, keyed by a hash of those inputs — so text is
// regenerated only when an input field changes. Strategy at 13k records:
//   • overnight batch after the full sync regenerates only records whose hash changed
//   • on-demand generation when a broker opens a record with no cached text (≈1–2s, then cached)
//   • template fallback when Claude is unavailable — the detail view never blocks on the API
import crypto from 'node:crypto';
import { CLAUDE, env } from './config.mjs';
import { claude } from './parse.mjs';
import { store } from './store.mjs';
import { score } from './model.mjs';

const R = store('rationale');
const PRICE = () => ({ in: +env('PRICE_IN_PER_MTOK', 1), out: +env('PRICE_OUT_PER_MTOK', 5) });

export const inputs = (p) => {
  const hold = p.lastSaleDate ? +((Date.now() - new Date(p.lastSaleDate)) / (365.25 * 864e5)).toFixed(1) : null;
  return { units: p.units, year_built: p.yearBuilt, last_sale_date: p.lastSaleDate, last_sale_price: p.lastSalePrice, hold_years: hold, loan_maturity: p.loanMaturity || null };
};
export const inputHash = (p) => crypto.createHash('sha1').update(JSON.stringify({ ...inputs(p), hold_years: Math.floor(inputs(p).hold_years ?? -1) })).digest('hex').slice(0, 12);

const SYSTEM = `You write call-prep rationale for a multifamily investment sales broker.
For each property, write EXACTLY two sentences on why the owner is worth a call now.
Use only the facts given (units, year built, last sale date and price, hold period, loan maturity). Cite specific numbers.
Reason like a broker: long holds imply large embedded gains or estate/succession questions; loans maturing within ~24 months force a refinance-or-sell decision, and today's rates vs. the rate at purchase matter; older buildings imply capex pressure; price per unit at purchase vs. today's market suggests equity.
Do not invent facts (no rents, no owner details, no market stats you weren't given). If data is thin, say what is known and keep it short.
Respond with ONLY a JSON array: [{"id": "...", "text": "..."}].`;

export async function getCached(p) { const c = await R.get(p.id); return c && c.hash === inputHash(p) ? c : null; }

export function template(p) {
  const { factors } = score(p); const i = inputs(p);
  const a = factors.length ? `${cap(factors[0])}${factors[1] ? `, and ${factors[1]}` : ''}.` : `${p.units}-unit building${p.yearBuilt ? ` built ${p.yearBuilt}` : ''}.`;
  const b = i.last_sale_price && p.units ? `Bought for $${fmt(i.last_sale_price)} ($${fmt(Math.round(i.last_sale_price / p.units))}/unit) in ${String(i.last_sale_date).slice(0, 4)} — a current valuation conversation is the opener.` : 'Open with a current valuation.';
  return `${a} ${b}`;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

// Nightly batch: regenerate only properties whose inputs changed, capped per run so the
// 15-min background limit is never hit; the remainder is picked up the next night.
// (First-time fill of 13k: ~520 calls — better done once via the Message Batches API at lower cost.)
export async function batchChanged(props, maxPerRun = 1200) {
  const index = (await R.get('__index')) || {};
  const todo = props.filter(p => index[p.id] !== inputHash(p)).slice(0, maxPerRun);
  const r = await generate(todo, { force: true });
  for (const [id, v] of Object.entries(r.results)) if (v.engine === 'claude') index[id] = v.hash;
  await R.set('__index', index);
  return { ...r.report, remaining: props.filter(p => index[p.id] !== inputHash(p)).length };
}

export async function generate(props, { force = false } = {}) {
  const t0 = Date.now(); const usage = { input_tokens: 0, output_tokens: 0, calls: 0 }; const out = {};
  const todo = [];
  for (const p of props) { const c = !force && await getCached(p); if (c) out[p.id] = { ...c, cached: true }; else todo.push(p); }
  if (!CLAUDE.apiKey()) {
    for (const p of todo) out[p.id] = { text: template(p), engine: 'template', hash: inputHash(p) };
  } else {
    for (let i = 0; i < todo.length; i += 25) {
      const chunk = todo.slice(i, i + 25);
      try {
        const r = await claude({ model: CLAUDE.rationaleModel(), system: SYSTEM, max_tokens: 4000,
          messages: [{ role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)}.\n` + JSON.stringify(chunk.map(p => ({ id: p.id, ...inputs(p) }))) }] }, CLAUDE.batchTimeoutMs);
        usage.calls++; usage.input_tokens += r.usage.input_tokens; usage.output_tokens += r.usage.output_tokens;
        const arr = JSON.parse(r.content[0].text.replace(/^```(json)?|```$/g, '').trim());
        for (const o of arr) { const p = chunk.find(x => x.id === o.id); if (p) { const rec = { text: o.text, engine: 'claude', hash: inputHash(p), at: new Date().toISOString() }; out[p.id] = rec; await R.set(p.id, rec); } }
      } catch (e) { console.warn('rationale batch failed:', e.message); }
      for (const p of chunk) out[p.id] ||= { text: template(p), engine: 'template', hash: inputHash(p) };
    }
  }
  const pr = PRICE(); const cost = (usage.input_tokens * pr.in + usage.output_tokens * pr.out) / 1e6;
  const generated = todo.length;
  return { results: out, report: { records: props.length, generated, fromCache: props.length - generated, ms: Date.now() - t0,
    msPerRecord: generated ? Math.round((Date.now() - t0) / generated) : 0, usage, costUsd: +cost.toFixed(4),
    costPerRecordUsd: generated ? +(cost / generated).toFixed(6) : 0, projected13kUsd: generated ? +(cost / generated * 13000).toFixed(2) : null } };
}
