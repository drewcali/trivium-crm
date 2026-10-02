// Airtable REST client: throttled (stays under 5 req/s per base),
// retries on 429 / 5xx, paginates, batches writes (10 records max per call).
// The same client runs against real Airtable or the mock base.
import { AIRTABLE, TABLES, SOURCE, env } from './config.mjs';
import { mockFetch } from './mock-base.mjs';

let lastSlots = [];
async function throttle() {
  const gap = 1000 / AIRTABLE.requestsPerSecond;
  for (;;) {
    const now = Date.now();
    lastSlots = lastSlots.filter(t => now - t < 1000);
    if (lastSlots.length < AIRTABLE.requestsPerSecond) {
      const last = lastSlots[lastSlots.length - 1] || 0;
      if (now - last >= gap * 0.9) { lastSlots.push(now); return; }
      await sleep(gap - (now - last));
    } else await sleep(1000 - (now - lastSlots[0]) + 5);
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

export const stats = { requests: 0, retries: 0, rateLimited: 0 };

export function client() {
  const mock = SOURCE() === 'mock';
  const base = mock ? 'appMOCKTRIVIUM00' : env('AIRTABLE_BASE_ID');
  const token = mock ? 'mock' : env('AIRTABLE_TOKEN');
  const doFetch = mock ? mockFetch() : fetch;

  async function call(path, init = {}, attempt = 0) {
    await throttle(); stats.requests++;
    const res = await doFetch(`${AIRTABLE.apiRoot}/${base}/${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) stats.rateLimited++;
      if (attempt >= 4) throw new Error(`Airtable ${res.status} after retries: ${path}`);
      stats.retries++;
      // Airtable asks for a 30s back-off on 429; mock base recovers in ~1s.
      await sleep(res.status === 429 ? (mock ? 1100 : 30000) : 500 * 2 ** attempt);
      return call(path, init, attempt + 1);
    }
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
    return res.json();
  }
  const t = (key) => encodeURIComponent(TABLES[key].name);

  return {
    mock,
    async listAll(key, { fields, formula, view, onPage } = {}) {
      const out = []; let offset;
      do {
        const q = new URLSearchParams({ pageSize: String(AIRTABLE.pageSize) });
        if (offset) q.set('offset', offset);
        if (formula) q.set('filterByFormula', formula);
        if (view) q.set('view', view);
        for (const f of fields || []) q.append('fields[]', f);
        const page = await call(`${t(key)}?${q}`);
        out.push(...page.records); onPage?.(out.length); offset = page.offset;
      } while (offset);
      return out;
    },
    get: (key, id) => call(`${t(key)}/${id}`),
    async getMany(key, ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const formula = chunk.length === 1 ? `RECORD_ID()='${chunk[0]}'` : `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
        out.push(...await this.listAll(key, { formula }));
      }
      return out;
    },
    async create(key, fieldsList) {
      const out = [];
      for (let i = 0; i < fieldsList.length; i += 10)
        out.push(...(await call(t(key), { method: 'POST', body: JSON.stringify({ records: fieldsList.slice(i, i + 10).map(fields => ({ fields })), typecast: true }) })).records);
      return out;
    },
    async update(key, recs) {
      const out = [];
      for (let i = 0; i < recs.length; i += 10)
        out.push(...(await call(t(key), { method: 'PATCH', body: JSON.stringify({ records: recs.slice(i, i + 10), typecast: true }) })).records);
      return out;
    },
    schema: () => (mock ? mockFetch()(`${AIRTABLE.apiRoot}/meta/bases/${base}/tables`).then(r => r.json())
      : fetch(`${AIRTABLE.apiRoot}/meta/bases/${base}/tables`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())),
  };
}
