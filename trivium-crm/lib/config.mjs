// ─────────────────────────────────────────────────────────────
// Central config. When Emily's dev base + schema export arrive,
// THIS is the file to edit: table names and field names below map
// the app's internal model onto Trivium's Airtable fields.
// Everything else reads through this map — no field name is hardcoded
// anywhere else in the codebase.
// ─────────────────────────────────────────────────────────────

export const env = (k, d = undefined) => {
  const v = (typeof Netlify !== 'undefined' ? Netlify.env?.get?.(k) : undefined) ?? process.env[k];
  return v === undefined || v === '' ? d : v;
};

// Data source: "airtable" when AIRTABLE_TOKEN + AIRTABLE_BASE_ID are set, else built-in mock base.
export const SOURCE = () => (env('AIRTABLE_TOKEN') && env('AIRTABLE_BASE_ID') ? 'airtable' : 'mock');

export const AIRTABLE = {
  apiRoot: 'https://api.airtable.com/v0',
  requestsPerSecond: 4,          // Airtable hard limit is 5/s per base; keep headroom
  pageSize: 100,                 // Airtable max per list request
};

// internal key → Airtable field name. Adjust after reading the schema export.
export const TABLES = {
  properties: {
    name: 'Properties',
    fields: {
      address: 'Address', city: 'City', zip: 'Zip', county: 'County',
      units: 'Units', yearBuilt: 'Year Built',
      lastSaleDate: 'Last Sale Date', lastSalePrice: 'Last Sale Price',
      apn: 'APN', loanMaturity: 'Loan Maturity',
      lat: 'Latitude', lng: 'Longitude',          // ⚠ confirm these exist; if not, geocoding step required
      ownership: 'Ownership', users: 'Users',
      ownerRaw: 'Owner (Raw)',                      // Hudson Valley combined owner/manager text
      rationale: 'Rationale', rationaleHash: 'Rationale Hash',
    },
  },
  entities: {
    name: 'Entities',
    fields: {
      name: 'Name', type: 'Entity Type', nameBasis: 'Name Basis', dataSource: 'Data Source',
      ownership: 'Ownership', contacts: 'Contacts',
    },
  },
  contacts: {
    name: 'Contacts',
    fields: {
      name: 'Name', phone: 'Phone', email: 'Email', role: 'Role',
      entities: 'Entities', users: 'Users',
      logs: 'Contact Logs',                         // reverse link Airtable creates automatically
    },
  },
  ownership: {
    name: 'Ownership',
    fields: {
      property: 'Property', entity: 'Entity',
      start: 'Start Date', end: 'End Date', share: 'Ownership Share',
    },
  },
  logs: {
    name: 'Contact Logs',
    fields: {
      date: 'Date', broker: 'Broker', contact: 'Contact', channel: 'Channel',
      outcome: 'Outcome', followUp: 'Follow-up Date', note: 'Note',
      dealSignal: 'Deal Signal', cooldown: 'Cooldown', clientId: 'Client ID',
    },
  },
  users: {
    name: 'Users',
    fields: { name: 'Name', territory: 'Territory', role: 'Role', email: 'Email' },
  },
};

// Business rules
export const RULES = {
  cooldownDays: 60,              // Test 4: cross-broker look-back window
  snapshotMaxAgeSec: 600,        // cache refresh cadence (matches netlify.toml schedule)
  sessionHours: 12,
};

// Claude API (runtime note parsing + rationale). Needs an API key, NOT a Claude.ai subscription.
export const CLAUDE = {
  apiKey: () => env('ANTHROPIC_API_KEY'),
  parseModel: () => env('CLAUDE_PARSE_MODEL', 'claude-haiku-4-5'),
  rationaleModel: () => env('CLAUDE_RATIONALE_MODEL', 'claude-haiku-4-5'),
  timeoutMs: 5000,        // note save path: Netlify sync functions time out at 10s (free) / 26s (paid)
  batchTimeoutMs: 20000,  // admin test batches (10 items per request)
};

// Outcome / signal vocabularies (Test 3)
export const OUTCOMES = ['spoke', 'left message', 'no answer', 'met in person', 'email'];
export const DEAL_SIGNALS = ['selling interest', 'refinancing', '1031 exchange', 'none'];
export const CHANNELS = ['call', 'text', 'email', 'in person'];
