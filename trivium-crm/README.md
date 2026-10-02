# Trivium Field CRM

A map-and-list field CRM for Trivium's multifamily brokers, built on Airtable. It is a rebuild of the AMP Field Ops interface on top of a real data layer: server-side login, a cache that makes 13,000+ properties load fast on a phone, live reads and writes to Airtable, the cross-broker cooldown rule, note parsing and generated pitch rationale.

**Current state:** fully working on a built-in **mock base**. The mock base is fictional data generated at Trivium's scale and in Trivium's shape: 13,150 properties, 10,100+ entities, 18,000+ contacts, ownership history and five broker territories. It sits behind a fake Airtable API that enforces Airtable's real limits (100 records per page, 5 requests/sec). To switch to Emily's dev base, set two environment variables and adjust field names in one file (see below).

---

## Architecture: where everything lives

```
Phone / browser                         Netlify (serverless)                         Airtable (source of truth)
───────────────                         ────────────────────                         ──────────────────────────
App shell (HTML/JS, works offline)  →   /api/* functions                         →   Properties, Entities, Contacts,
Territory snapshot (IndexedDB)          · login, PIN check (hashed)                   Ownership, Contact Logs, Users
Offline note outbox (IndexedDB)         · territory filter, cooldown, parsing
No tokens, no keys, no PINs             · Airtable token + Claude key (env vars)
                                        Netlify Blobs: cache + PIN hashes
                                        Scheduled sync every 10 min
```

| Data | Lives in | Notes |
|---|---|---|
| Properties, owners, contacts, logs | **Airtable** | Source of truth. Every write goes there first. |
| Per-broker territory snapshot | Netlify Blobs (server) → phone's IndexedDB | Disposable cache. Rebuilt from Airtable. |
| Notes written since last sync | Netlify Blobs "pending" | Merged into snapshots until the next sync picks them up. |
| PINs | Netlify Blobs, **scrypt-hashed** | Never sent to the browser. 5 wrong tries → 15-min lock. |
| Airtable token, Claude key, secrets | Netlify environment variables | Server-side only. |
| Notes typed offline | Phone's IndexedDB outbox | Sent automatically on reconnect; de-duplicated by client id. |

**Business logic is on the server, not in the browser or in Airtable automations.** The server handles territory filtering, permissions, cooldown and parsing. The browser only displays what the server allowed it to receive.

### Why a cache (the Airtable limit)

Airtable returns 100 records per request at 5 requests/sec per base. A full pull here is **600 requests and about 150 s** (measured against the mock, which enforces the same limits). That can't happen on page load. Instead:

- **Full sync** (nightly, or on demand from Admin) runs in a 15-minute background function.
- **Incremental sync** runs every 10 minutes and pulls only records changed since the last run (`LAST_MODIFIED_TIME()`). That's usually about 6 requests.
- **Opening a record** is a live read of about 5 small requests, so edits made directly in Airtable show up immediately.
- **Five brokers at once:** phones never call Airtable directly. Each broker action costs 1–5 requests, the server throttles itself to 4 req/s, and it retries on 429 responses.
- **Known limit:** throttling is per serverless instance. Heavy simultaneous use could still hit a 429, which is retried after Airtable's 30-second penalty. At five brokers this is unlikely. Past that, put a queue in front of writes.

---

## The six tests: status on the mock base

| # | Test | Result on mock | What's left with the real base |
|---|---|---|---|
| 1 | Scale | **Pass.** 4,200-property territory on a phone (4× CPU throttle): **1.3 s on LTE, 2.9 s on Slow 4G** to usable. Zip filter about 80 ms; detail opens in about 0.3 s (live Airtable confirmation follows in 1–3 s). No caps, no pagination. | Re-measure on the real base and on Netlify (function cold starts add time). **Coordinates:** confirm Properties has lat/lng, otherwise geocoding is a separate step. |
| 2 | Live read/write | **Pass.** A note becomes a Contact Logs record with contact link, broker, timestamp and text. An edit made "in Airtable" shows on next open with no refresh or redeploy. Concurrent edits to the same phone number get a **409 conflict** instead of a silent overwrite. Logs are append-only, so two brokers logging on one contact never collide. | Confirm the Contact Logs table and its field names exist. That table is "design in progress." |
| 3 | Note parsing | Claude parser written and wired in. A rules fallback runs when Claude is down or unconfigured. **The rules parser scores ~98–100% on the 40 sample notes, but it was tuned on those notes, so that number means nothing.** | Run the 40 real notes with `ANTHROPIC_API_KEY` set. Only that number counts. |
| 4 | Cross-broker cooldown | **Pass.** Parnes logs on contact B of an entity; Goldstein opens a property owned by the same entity (via contact A) → banner with Parnes, date and outcome. The banner renders instantly from the snapshot, then a live read confirms it. | Re-run with real broker overlap. |
| 5 | Rationale | Generation, caching and the cost report are all built. Without a key, a rule-based template is used. | Needs `ANTHROPIC_API_KEY` to produce cost-per-record numbers. |
| 6 | Filtering | **Pass.** Each broker gets only their territory; the server refuses others' records (403). Admin sees all 10,500 owned properties and every log, and can edit them. Kohn: 0 visible / 2,000 pending ownership data (known gap). Brecher: empty. | Run `npm run verify:view` to compare against the real **"Eli Rosen"** view record by record. |

Reproduce: `npm run dev`, then `npm run test:api`, `npm run test:perf`, `npm run test:offline`.

---

## Answers to Emily's questions

1. **Architecture.** A static front end plus serverless functions on Netlify. Business logic runs in the functions. No Airtable automations are required.
2. **Airtable limits.** Covered above: a cached snapshot, incremental sync, a server-side throttle (4 req/s), retry/backoff, and small live reads only when a record is opened.
3. **Offline.** The app shell is cached. The last territory snapshot is in IndexedDB. A note typed offline is queued on the phone, survives an app restart, and is sent automatically on reconnect without duplicates (tested). Limit: map tiles aren't cached, so the offline map has pins but no street background.
4. **Claude dependency.** Runtime: note parsing (on save) and on-demand rationale. Batch: overnight rationale for records whose inputs changed. If Claude is slow or down, the note is **still saved** with rules-parsed fields after a 5 s timeout, and rationale falls back to a template. Nothing blocks.
5. **Ownership.** Trivium should own the GitHub repo, the Netlify account, the Airtable token and the Anthropic API key. A handoff to another developer is a standard Node project: one config file for field mapping, environment variables documented in `.env.example`, no proprietary services beyond Netlify Blobs (swappable).
6. **Effort.** See the estimate in the report. The biggest risks are the real schema (field names, Contact Logs design, coordinates), parse accuracy on real notes, and data-quality gaps such as Kohn's records.

## Switching to Emily's dev base

1. Set `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` (the **dev** base) in Netlify environment variables.
2. Read the schema export. Edit the table and field names in `lib/config.mjs` (the only place they appear).
3. Admin → **Full re-sync**. Admin → Data & sync lists any configured field that isn't in the base.
4. Run `npm run verify:view` locally against the "Eli Rosen" view.
5. Create broker logins in Admin → Brokers & logins (link each to their Airtable Users record).

## Deploying (Netlify)

Drag-and-drop deploys **don't run functions**. This needs Git-connected deploys or the CLI:

```bash
npm install
npx netlify-cli login
npx netlify-cli init             # or: link to an existing site
npx netlify-cli env:set SESSION_SECRET "$(openssl rand -hex 32)"
npx netlify-cli env:set SYNC_SECRET "$(openssl rand -hex 32)"
npx netlify-cli env:set ADMIN_PIN 2468     # change after first login
npx netlify-cli deploy --prod
```

Then sign in as admin → Admin → **Full re-sync** (builds the cache; about 2.5 min).

**Mock-mode demo PINs** (mock mode only, created on first run): admin `2468` · Goldstein `1001` · Parnes `1002` · Rosen `1003` · Kohn `1004` · Brecher `1005`. With a real base, only the admin is created, from `ADMIN_PIN`.

**Plan limits to know:** Netlify synchronous functions time out at 10 s on Free and 26 s on paid plans. The note-save path is built to fit in 10 s (Claude timeout 5 s). Admin test runs are sent 10 items per request. A paid plan is recommended for real use.

## Data rules implemented

1. **Rule 1:** an individual owner appears as an Individual entity *and* a Principal contact. Both are shown as-is, never merged.
2. **Rule 2:** properties link to entities. Contacts hang off the entity.
3. **Rule 3:** owners are shared across brokers through the Users link. The detail view lists the owner's whole portfolio and which brokers hold each property.
4. **Rule 4:** properties with no current owner are excluded from broker views. The count of hidden properties is shown.
5. **Rule 5:** cooldown checks any log by a **different** broker in the last 60 days on **any contact of the same entity**. A separate "do-not-contact" banner appears if any note in 6 months flagged cooldown.
6. **Privacy between brokers:** other brokers' log **text** is withheld from the payload. Broker, date and outcome are still shown, which is what the cooldown needs. Admin sees everything. *Confirm this choice with Trivium.*

## Files

```
lib/config.mjs        table/field mapping, rules, Claude settings   ← edit this for the real base
lib/airtable.mjs      throttled, retrying Airtable client
lib/snapshot.mjs      sync (full + incremental) and per-broker payloads
lib/model.mjs         normalization, scoring, territory rule
lib/record.mjs        live record read, permissions, cooldown
lib/auth.mjs          PIN hashing, lockout, signed sessions
lib/parse.mjs         Claude note parser + rules fallback
lib/rationale.mjs     "why this owner" generation, caching, cost report
lib/mock-base.mjs     fictional Trivium-scale base + fake Airtable API
netlify/functions/    API endpoints, scheduled sync, background full sync
public/               app (index.html, app.js, app.css, sw.js, vendor/leaflet)
scripts/              dev server, API / perf / offline tests, view parity check
```
