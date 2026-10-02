// Trivium Field CRM — client. Holds no secrets: the Airtable token, Claude key and PIN hashes
// live on the server. The browser keeps only the signed-in broker's territory snapshot and an
// offline outbox (IndexedDB) of notes not yet sent.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : '$' + Math.round(n / 1e3) + 'K';
const fmtD = (iso) => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso)) / 864e5);
const initials = (n) => (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const COOLDOWN_DAYS = 60;
const scoreColor = (s) => s >= 70 ? 'var(--s-hi)' : s >= 50 ? 'var(--s-mid)' : 'var(--s-lo)';
const scoreHex = (s) => s >= 70 ? '#c0262d' : s >= 50 ? '#e07b28' : '#8a9bb3';
const OUTCOMES = [['spoke', 'Spoke'], ['left message', 'Left msg'], ['no answer', 'No answer'], ['met in person', 'Met'], ['email', 'Email']];
const SIGNALS = ['none', 'selling interest', 'refinancing', '1031 exchange'];
const T0 = performance.now();

const S = { user: null, source: null, D: null, filters: { q: '', county: '', zip: '', units: 0, sort: 'score', chips: new Set() },
  filtered: [], sel: null, record: null, mobileView: 'map', online: navigator.onLine };

// ── tiny IndexedDB key/value ─────────────────────────────────
const idb = (() => { let p; const db = () => p ||= new Promise((res, rej) => { const r = indexedDB.open('trivium-crm', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', s => s.get(k)).catch(() => null), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => null), del: (k) => tx('readwrite', s => s.delete(k)).catch(() => null) }; })();

// ── API ──────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && !path.startsWith('/api/login')) { showAuth(); throw new Error('Signed out'); }
  if (res.status === 304) return { notModified: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms); }

// ── auth ─────────────────────────────────────────────────────
let pinBuf = '', pinProfile = null;
async function showAuth() {
  $('#app').hidden = true; $('#auth').hidden = false; $('#authPin').hidden = true; $('#authProfiles').hidden = false; $('#authSub').textContent = 'Select your profile';
  try {
    const profiles = await api('/api/profiles');
    $('#authProfiles').innerHTML = profiles.map(p => `<button class="auth-p" data-id="${esc(p.id)}" data-name="${esc(p.name)}"><span class="av" style="background:${p.role === 'admin' ? '#0f1b2d' : '#1f5eff'}">${initials(p.name)}</span><span><b>${esc(p.name)}</b><small>${esc(p.territory || '')} · ${p.role === 'admin' ? 'Admin' : 'Broker'}</small></span></button>`).join('');
  } catch (e) { $('#authProfiles').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function pickProfile(id, name) {
  pinProfile = id; pinBuf = ''; $('#authProfiles').hidden = true; $('#authPin').hidden = false; $('#authSub').textContent = 'Enter your PIN';
  $('#pinLbl').textContent = name; $('#authErr').textContent = ''; drawPin();
}
function drawPin() { $('#pinDots').innerHTML = Array.from({ length: Math.max(4, pinBuf.length) }, (_, i) => `<i class="${i < pinBuf.length ? 'f' : ''}"></i>`).join(''); }
async function pinKey(k) {
  if (k === '⌫') pinBuf = pinBuf.slice(0, -1); else if (k === '→') return submitPin(); else if (pinBuf.length < 6) pinBuf += k;
  drawPin();
}
async function submitPin() {
  if (pinBuf.length < 4) return;
  try { const r = await api('/api/login', { method: 'POST', body: { id: pinProfile, pin: pinBuf } }); await enterApp(r.user, r.source); }
  catch (e) { $('#authErr').textContent = e.message; pinBuf = ''; drawPin(); }
}

// ── boot ─────────────────────────────────────────────────────
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  $('#pinPad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '→'].map(k => `<button data-k="${k}">${k}</button>`).join('');
  $('#pinPad').onclick = (e) => { const k = e.target.dataset.k; if (k) pinKey(k); };
  document.addEventListener('keydown', (e) => { if ($('#authPin').hidden || $('#auth').hidden) return; if (/^\d$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('⌫'); else if (e.key === 'Enter') pinKey('→'); });
  $('#authProfiles').onclick = (e) => { const b = e.target.closest('.auth-p'); if (b) pickProfile(b.dataset.id, b.dataset.name); };
  $('#pinBack').onclick = showAuth;
  wireUI();
  try { const s = await api('/api/session'); await enterApp(s.user, s.source); }
  catch (e) {
    if (e.status === 401 || e.message === 'Signed out') return; // showAuth already ran
    const last = await idb.get('lastUser'); // offline start: use the cached territory
    if (last) { S.online = false; await enterApp(last.user, last.source, true); toast('Offline — showing your last synced territory'); } else showAuth();
  }
}

async function enterApp(user, source, offline = false) {
  S.user = user; S.source = source;
  document.body.classList.toggle('is-admin', user.role === 'admin'); document.body.classList.toggle('is-mock', source === 'mock');
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#userAv').textContent = initials(user.name); $('#userName').textContent = user.name;
  $('#menuInfo').innerHTML = `${esc(user.name)}<br>${esc(user.territory || '')}<br>Data: ${source === 'mock' ? 'mock base (fictional)' : 'Airtable dev base'}`;
  await idb.set('lastUser', { user, source });
  await loadTerritory(offline);
  setNet(); flushOutbox();
}

// ── territory load + decode ──────────────────────────────────
async function loadTerritory(offline) {
  const key = 'territory:' + S.user.id; const cached = await idb.get(key);
  const t0 = performance.now(); let payload = cached?.payload, how = 'cache';
  if (!offline) {
    try {
      const res = await fetch('/api/territory', { credentials: 'same-origin', headers: cached?.etag ? { 'if-none-match': cached.etag } : {} });
      if (res.status === 401) return showAuth();
      if (res.status === 200) { payload = await res.json(); how = 'network'; idb.set(key, { etag: res.headers.get('etag'), payload }); }
      else if (res.status === 304) how = 'not modified';
      else if (!payload) throw new Error((await res.json().catch(() => ({}))).error || 'Load failed');
    } catch (e) { if (!payload) { $('#count').textContent = 'Could not load: ' + e.message; return; } S.online = false; }
  }
  const tNet = performance.now() - t0;
  decode(payload);
  const tDec = performance.now() - t0 - tNet;
  buildFilters(); applyFilters(); initMap();
  requestAnimationFrame(() => {
    const ready = (performance.now() - T0) / 1000;
    $('#perfBadge').textContent = `${S.D.props.length.toLocaleString()} properties · data ${(tNet / 1000).toFixed(2)}s (${how}) · ready ${ready.toFixed(1)}s`;
    S.perf = { properties: S.D.props.length, networkMs: Math.round(tNet), decodeMs: Math.round(tDec), readyS: +ready.toFixed(2), how };
    window.__perf = S.perf;
  });
}

function decode(p) {
  const meIdx = p.users.findIndex(u => u.id === S.user.userRecId);
  const ents = p.E.map((e, i) => ({ i, name: e[0], type: e[1], nameBasis: e[2], dataSource: e[3], contacts: e[4], props: [] }));
  const cons = p.C.map((c, i) => ({ i, name: c[0], role: c[1], phone: c[2], email: c[3], ents: c[4], logs: [] }));
  const logs = p.L.map(l => ({ id: l[0], date: l[1], u: l[2], c: l[3], channel: l[4], outcome: l[5], followUp: l[6], note: l[7], signal: l[8], cooldown: !!l[9] }));
  for (const l of logs) cons[l.c]?.logs.push(l);
  const now = Date.now();
  const props = p.P.map((r, i) => {
    const o = { i, id: r[0], address: r[1], city: r[2], zip: r[3], county: r[4], units: r[5], yb: r[6], lsd: r[7], lsp: r[8], loan: r[9], lat: r[10], lng: r[11], own: r[12], score: r[13] };
    o.hold = o.lsd ? (now - new Date(o.lsd)) / (365.25 * 864e5) : null;
    o.loanMo = o.loan ? (new Date(o.loan) - now) / (30.4 * 864e5) : null;
    if (ents[o.own]) ents[o.own].props.push(i);
    o.search = `${o.address} ${o.city} ${o.zip}`.toLowerCase();
    return o;
  });
  const hist = new Map(); for (const [pi, ei, st, en] of p.O) { if (!hist.has(pi)) hist.set(pi, []); hist.get(pi).push({ e: ents[ei], start: st, end: en }); }
  S.D = { raw: p, users: p.users, meIdx, props, ents, cons, logs, hist, excluded: p.excluded };
  for (const e of ents) e.search = (e.name + ' ' + e.contacts.map(ci => cons[ci].name).join(' ')).toLowerCase();
  recomputeFlags();
}

// Per-owner flags from logs: cross-broker cooldown, recent deal signal, contacted-by-me.
function recomputeFlags() {
  const { ents, cons, meIdx, props } = S.D; const since = Date.now() - COOLDOWN_DAYS * 864e5; const yr = Date.now() - 365 * 864e5;
  for (const e of ents) {
    e.cool = null; e.signal = null; e.mine = false; e.dnc = false;
    for (const ci of e.contacts) for (const l of cons[ci].logs) {
      const t = new Date(l.date).getTime();
      if (l.u === meIdx) e.mine = true;
      if (t >= since && (S.user.role === 'admin' ? true : l.u !== meIdx) && (!e.cool || l.date > e.cool.date)) e.cool = l;
      if (l.cooldown && t >= Date.now() - 180 * 864e5) e.dnc = true;
      if (t >= yr && l.signal && l.signal !== 'none') e.signal = l.signal;
    }
  }
  for (const p of props) { const e = ents[p.own]; p.cool = !!(e?.cool && S.user.role !== 'admin') || !!e?.dnc; p.signal = e?.signal; p.mine = e?.mine; }
}

// ── filters + list ───────────────────────────────────────────
function buildFilters() {
  const { props } = S.D;
  const zips = [...new Set(props.map(p => p.zip))].sort();
  $('#fZip').innerHTML = `<option value="">All zips (${zips.length})</option>` + zips.map(z => `<option>${z}</option>`).join('');
  const counties = [...new Set(props.map(p => p.county))].sort();
  $('#fCounty').innerHTML = '<option value="">All territories</option>' + counties.map(c => `<option>${esc(c)}</option>`).join('');
  const ex = S.D.excluded?.noOwner || 0;
  $('#gapNotice').hidden = !ex;
  $('#gapNotice').textContent = props.length === 0 && ex
    ? `${ex.toLocaleString()} properties in your territory have no linked owner yet (pending ownership data), so none can be shown. This is a known data gap, not an error.`
    : `${ex.toLocaleString()} properties hidden: no owner on record.`;
}

function applyFilters() {
  const f = S.filters, { props, ents } = S.D, q = f.q.trim().toLowerCase();
  let out = props.filter(p => (!f.county || p.county === f.county) && (!f.zip || p.zip === f.zip) && p.units >= f.units
    && (!f.chips.has('loan') || (p.loanMo != null && p.loanMo <= 24 && p.loanMo >= -3))
    && (!f.chips.has('hold') || (p.hold != null && p.hold >= 7))
    && (!f.chips.has('signal') || !!p.signal)
    && (!f.chips.has('nocool') || !p.cool)
    && (!f.chips.has('mine') || !p.mine)
    && (!q || p.search.includes(q) || (ents[p.own]?.search.includes(q))));
  const by = { score: (a, b) => b.score - a.score || b.units - a.units, units: (a, b) => b.units - a.units, hold: (a, b) => (b.hold ?? -1) - (a.hold ?? -1),
    loan: (a, b) => (a.loanMo ?? 1e9) - (b.loanMo ?? 1e9), addr: (a, b) => a.address.localeCompare(b.address) }[f.sort];
  out.sort(by); S.filtered = out;
  $('#count').textContent = `${out.length.toLocaleString()} of ${props.length.toLocaleString()} properties`;
  $('#listInner').style.height = out.length * 72 + 'px'; $('#list').scrollTop = 0; renderRows(true);
  updateMarkers();
}
let lastRange = '';
function renderRows(force) {
  const el = $('#list'), H = 72, top = el.scrollTop, h = el.clientHeight || 600;
  const a = Math.max(0, Math.floor(top / H) - 8), b = Math.min(S.filtered.length, Math.ceil((top + h) / H) + 8);
  if (!force && lastRange === a + ':' + b) return; lastRange = a + ':' + b;
  const { ents } = S.D; let html = '';
  for (let i = a; i < b; i++) {
    const p = S.filtered[i], e = ents[p.own];
    html += `<div class="row${S.sel === p.i ? ' sel' : ''}" style="top:${i * H}px" data-i="${p.i}"><div class="sc" style="background:${scoreColor(p.score)}">${p.score}</div>
      <div class="m"><b>${esc(p.address)}</b><div class="s">${esc(p.city)} ${p.zip} · ${p.units} units${p.yb ? ' · ' + p.yb : ''}</div><div class="s">${esc(e?.name || '—')}</div></div>
      <div class="flags">${p.cool ? '<span class="flag cool">Cooldown</span>' : ''}${p.signal ? `<span class="flag sig">${esc(p.signal)}</span>` : ''}${p.loanMo != null && p.loanMo <= 24 && p.loanMo >= -3 ? '<span class="flag loan">Loan due</span>' : ''}</div></div>`;
  }
  $('#listInner').innerHTML = html;
}

// ── map ──────────────────────────────────────────────────────
let map, cluster, markers = [];
function initMap() {
  if (!map) {
    map = L.map('map', { preferCanvas: true, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' }).addTo(map);
    cluster = L.markerClusterGroup({ chunkedLoading: true, iconCreateFunction: (c) => { const n = c.getChildCount(); const d = n < 20 ? 30 : n < 100 ? 36 : n < 500 ? 44 : 52;
      return L.divIcon({ html: `<div class="clu" style="width:${d}px;height:${d}px">${n}</div>`, className: '', iconSize: [d, d] }); }, maxClusterRadius: 48, disableClusteringAtZoom: 16, spiderfyOnMaxZoom: false, showCoverageOnHover: false });
    map.addLayer(cluster);
  }
  const renderer = L.canvas({ padding: 0.3 });
  markers = S.D.props.map(p => {
    if (p.lat == null) return null;
    const m = L.circleMarker([p.lat, p.lng], { renderer, radius: 6, weight: p.cool ? 3 : 1.5, color: p.cool ? '#c0262d' : '#fff', fillColor: scoreHex(p.score), fillOpacity: .95 });
    m.on('click', () => openDetail(p.i)); m.bindTooltip(`${p.address} · ${p.units}u · ${p.score}`, { direction: 'top', offset: [0, -6] });
    return m;
  });
  updateMarkers(true);
}
function updateMarkers(fit) {
  if (!cluster) return;
  cluster.clearLayers();
  const ms = S.filtered.map(p => markers[p.i]).filter(Boolean);
  cluster.addLayers(ms);
  if ((fit || ms.length) && ms.length) { const b = L.latLngBounds(ms.map(m => m.getLatLng())); if (fit || !map.getBounds().intersects(b)) map.fitBounds(b, { padding: [30, 30], maxZoom: 15 }); }
  else if (fit) map.setView([40.78, -74.15], 10);
}

// ── record detail ────────────────────────────────────────────
async function openDetail(pi) {
  const p = S.D.props[pi]; S.sel = pi; S.record = null; renderRows(true);
  $('#detail').hidden = false; $('#scrim').hidden = innerWidth > 760 ? false : true;
  $('#dAddr').textContent = p.address; $('#dSub').textContent = `${p.city}, ${p.zip} · ${p.county}`;
  $('#dScore').style.background = scoreColor(p.score); $('#dScore').innerHTML = `${p.score}<small>score</small>`;
  renderDetail(p, null);
  if (!S.online) return;
  try { const rec = await api('/api/record?id=' + encodeURIComponent(p.id)); if (S.sel !== pi) return; S.record = rec; await idb.set('rec:' + p.id, rec); renderDetail(p, rec); }
  catch (e) { const r = await idb.get('rec:' + p.id); if (r && S.sel === pi) { S.record = r; renderDetail(p, r, true); } else if (S.sel === pi) $('#liveNote').textContent = 'Live check failed: ' + e.message; }
}

function localTimeline(p) {
  const e = S.D.ents[p.own]; if (!e) return [];
  return e.contacts.flatMap(ci => S.D.cons[ci].logs.map(l => ({ ...l, contactName: S.D.cons[ci].name, brokerName: S.D.users[l.u]?.name || '?', mine: l.u === S.D.meIdx })))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderDetail(p, rec, stale) {
  const e = S.D.ents[p.own]; const me = S.user;
  const pr = rec?.property || {}; const factors = pr.factors;
  const hold = p.hold != null ? p.hold.toFixed(1) + ' yrs' : '—';
  const ppu = p.lsp && p.units ? fmt$(Math.round(p.lsp / p.units)) : '—';
  // Cooldown banner — local data renders instantly; the live Airtable read confirms it.
  let cd;
  if (rec) cd = rec.cooldown;
  else { const since = Date.now() - COOLDOWN_DAYS * 864e5;
    const hits = localTimeline(p).filter(l => new Date(l.date) >= since && (me.role === 'admin' || !l.mine));
    cd = { active: hits.length > 0, entries: hits.slice(0, 5).map(l => ({ broker: l.brokerName, date: l.date, outcome: l.outcome })), doNotContact: e?.dnc ? { broker: '', date: '' } : null }; }
  const banner = cd?.doNotContact ? `<div class="banner dnc"><b>⛔ Do-not-contact flag</b>A note in the last 6 months says this owner asked not to be contacted${cd.doNotContact.broker ? ` (${esc(cd.doNotContact.broker)}, ${fmtD(cd.doNotContact.date)})` : ''}. Check before reaching out.</div>` : '';
  const coolHtml = cd?.active ? `<div class="banner cool"><b>${me.role === 'admin' ? 'Recent contact on this owner' : 'Another Trivium broker contacted this owner recently'}</b>${cd.entries.map(x => `${esc(x.broker)} — ${esc(x.outcome || 'logged')} — ${fmtD(x.date)} (${daysAgo(x.date)}d ago)`).join('<br>')}</div>`
    : `<div class="banner ok">No contact by ${me.role === 'admin' ? 'anyone' : 'other brokers'} in the last ${COOLDOWN_DAYS} days.</div>`;
  const contacts = rec ? rec.contacts : (e?.contacts || []).map(ci => ({ ...S.D.cons[ci], id: null }));
  const tl = rec ? rec.logs.map(l => ({ ...l, contactName: rec.contacts.find(c => c.id === l.contactId)?.name || '', mine: l.brokerId === me.userRecId, outcome: l.outcome, signal: l.dealSignal }))
    : localTimeline(p);
  const queued = (S.outbox || []).filter(o => o.propertyId === p.id);
  const hist = rec ? rec.history.map(h => ({ name: h.entityName, start: h.start, end: h.end })) : (S.D.hist.get(p.i) || []).map(h => ({ name: h.e?.name, start: h.start, end: h.end })).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const sortedContacts = [...contacts].sort((a, b) => (a.role === 'Principal' ? -1 : 0) - (b.role === 'Principal' ? -1 : 0));

  $('#dBody').innerHTML = `
    <div class="live" id="liveNote">${rec ? `${stale ? 'Offline — last live copy' : 'Live from Airtable'} · ${fmtD(rec.fetchedAt)} ${new Date(rec.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${stale ? '' : ` · ${rec.fetchedMs} ms`}` : S.online ? 'Checking Airtable for the latest…' : 'Offline — showing last synced data'}</div>
    <div class="sec"><h4>Contact check</h4>${banner}${coolHtml}</div>
    <div class="sec"><h4>Why this owner, now</h4><div class="why">
      <p id="whyText">${rec ? esc(rec.rationale.text) : '<span class="muted">Loading…</span>'}</p>
      <div class="src">${rec ? (rec.rationale.engine === 'claude' ? 'Generated by Claude from units, year built, sale history and loan maturity' : 'Rule-based summary') + (rec.rationale.engine !== 'claude' && S.online ? ' · <button class="link small" id="genWhy">Generate with Claude</button>' : '') : ''}</div>
      ${factors?.length && rec?.rationale.engine === 'claude' ? `<ul class="factors">${factors.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div></div>
    <div class="sec"><h4>Property</h4><div class="facts">
      <div class="fact"><small>Units</small><b>${p.units}</b></div><div class="fact"><small>Year built</small><b>${p.yb || '—'}</b></div><div class="fact"><small>Hold</small><b>${hold}</b></div>
      <div class="fact"><small>Last sale</small><b>${fmtD(p.lsd)}</b></div><div class="fact"><small>Price</small><b>${fmt$(p.lsp)}</b></div><div class="fact"><small>$/unit</small><b>${ppu}</b></div>
      <div class="fact"><small>Loan maturity</small><b>${p.loan ? fmtD(p.loan) : '—'}</b></div><div class="fact"><small>APN</small><b>${esc(pr.apn || '—')}</b></div><div class="fact"><small>Brokers</small><b style="font-size:12.5px">${esc((pr.brokers || []).join(', ') || '—')}</b></div>
    </div></div>
    <div class="sec"><h4>Log a touch</h4><div class="compose">
      <select id="cContact">${sortedContacts.map((c, i) => `<option value="${i}">${esc(c.name)} — ${esc(c.role)}</option>`).join('') || '<option>No contacts on file</option>'}</select>
      <textarea id="cNote" placeholder="Type it the way you'd write it: “Spoke w/ Saul, might sell if number is right, f/u 3/15”"></textarea>
      <div class="opts" id="cOut">${OUTCOMES.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join('')}</div>
      <div class="foot"><input type="date" id="cFu" title="Follow-up date (optional — parsed from the note if left blank)"><button class="btn pri" id="cSave">Save note</button></div>
      <div class="muted small" style="margin-top:6px">Outcome, follow-up, deal signal and cooldown are pulled from the note automatically; anything you pick here wins.</div>
      <div id="cResult"></div></div></div>
    <div class="sec"><h4>Owner</h4><div class="owner">
      <div class="owner-h"><div><b>${esc(rec?.owner?.name || e?.name || '—')}</b><div class="muted small">${esc(rec?.owner?.nameBasis || e?.nameBasis || '')}${(rec?.owner?.dataSource || e?.dataSource) ? ' · source: ' + esc(rec?.owner?.dataSource || e?.dataSource) : ''}</div></div><span class="tag">${esc(rec?.owner?.type || e?.type || '')}</span></div>
      <div style="margin-top:8px">${sortedContacts.map((c, i) => `<div class="contact"><span class="av" style="width:30px;height:30px;font-size:11px">${initials(c.name)}</span><div class="m"><b>${esc(c.name)}</b> <span class="tag">${esc(c.role)}</span>
        <div>${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : 'no phone'}${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</div></div>
        ${c.id ? `<button class="btn sm" data-editphone="${i}">Edit</button>` : ''}</div>`).join('') || '<div class="muted small">No contacts linked to this owner.</div>'}</div>
    </div>
    ${rec?.portfolio?.length > 1 ? `<div class="muted small" style="margin-top:8px">Owns ${rec.portfolio.length} properties: ${rec.portfolio.slice(0, 6).map(x => `${esc(x.address)} (${x.units}u${x.visible ? '' : ', ' + esc(x.brokers.join('/'))})`).join(' · ')}${rec.portfolio.length > 6 ? ' …' : ''}</div>` : ''}</div>
    <div class="sec"><h4>Activity on this owner</h4><ul class="tl">
      ${queued.map(o => `<li class="queued"><div class="h"><b>You</b> · queued offline · ${fmtD(o.date)}</div><div class="n">${esc(o.note)}</div></li>`).join('')}
      ${tl.map(l => `<li class="${l.mine ? 'mine' : 'other'}"><div class="h"><b>${esc(l.mine ? 'You' : l.brokerName)}</b> · ${esc(l.outcome || 'logged')} · ${esc(l.contactName)} · ${fmtD(l.date)}${l.followUp ? ` · f/u ${fmtD(l.followUp)}` : ''}${l.signal && l.signal !== 'none' ? ` · <span class="flag sig">${esc(l.signal)}</span>` : ''}${l.cooldown ? ' · <span class="flag cool">cooldown</span>' : ''}</div>
        ${l.note != null ? `<div class="n">${esc(l.note)}</div>` : '<div class="hidden-note">Note text visible to that broker and admin</div>'}</li>`).join('') || (queued.length ? '' : '<li><div class="h muted">No logged contact yet.</div></li>')}
    </ul></div>
    <div class="sec"><h4>Ownership history</h4><table class="mini">${hist.map(h => `<tr><td>${esc(h.name || '—')}</td><td class="muted">${fmtD(h.start)} → ${h.end ? fmtD(h.end) : 'current'}</td></tr>`).join('')}</table></div>`;

  // wire composer
  let pickedOutcome = null;
  $('#cOut').onclick = (ev) => { const b = ev.target.closest('.chip'); if (!b) return; pickedOutcome = pickedOutcome === b.dataset.v ? null : b.dataset.v; $$('#cOut .chip').forEach(x => x.classList.toggle('on', x.dataset.v === pickedOutcome)); };
  $('#cSave').onclick = () => saveNote(p, sortedContacts[+$('#cContact').value], pickedOutcome);
  $('#genWhy')?.addEventListener('click', async () => { $('#whyText').innerHTML = '<span class="muted">Generating…</span>'; try { const r = await api('/api/rationale', { method: 'POST', body: { id: p.id } }); $('#whyText').textContent = r.text; } catch (err) { $('#whyText').textContent = err.message; } });
  $$('[data-editphone]').forEach(b => b.onclick = () => editPhone(p, sortedContacts[+b.dataset.editphone], b));
}

async function saveNote(p, contact, outcome) {
  const note = $('#cNote').value.trim(); if (!note || !contact) return toast('Write a note first');
  const item = { clientId: crypto.randomUUID(), propertyId: p.id, contactId: contact.id || null, contactName: contact.name, note, outcome: outcome || undefined, followUp: $('#cFu').value || undefined, date: new Date().toISOString() };
  $('#cSave').disabled = true;
  if (!S.online || !item.contactId) { await queue(item); $('#cNote').value = ''; $('#cSave').disabled = false; toast('Saved offline — will send when you have signal'); return renderDetail(p, S.record, true); }
  try {
    const r = await api('/api/log', { method: 'POST', body: item });
    $('#cNote').value = ''; $('#cFu').value = '';
    const x = r.parsed || {};
    $('#cResult').innerHTML = `<div class="parsed">✓ Saved to Airtable (${r.ms} ms) · <b>${esc(r.log.outcome || '?')}</b>${r.log.followUp ? ` · follow-up ${fmtD(r.log.followUp)}` : ''}${r.log.dealSignal !== 'none' ? ` · ${esc(r.log.dealSignal)}` : ''}${r.log.cooldown ? ' · <b>cooldown flagged</b>' : ''}${x.uncertain?.length ? `<br><span class="muted">Unsure about: ${esc(x.uncertain.join(', '))} — edit if needed</span>` : ''}</div>`;
    addLocalLog(p, contact, r.log);
    const rec = await api('/api/record?id=' + encodeURIComponent(p.id)); S.record = rec; const keep = $('#cResult').innerHTML; renderDetail(p, rec); $('#cResult').innerHTML = keep;
  } catch (e) {
    if (e.status) toast(e.message); else { await queue(item); toast('No connection — queued, will send automatically'); }
  } finally { const b = $('#cSave'); if (b) b.disabled = false; }
}
function addLocalLog(p, contact, log) {
  const e = S.D.ents[p.own]; const ci = e?.contacts.find(i => S.D.cons[i].name === contact.name); if (ci == null) return;
  const l = { id: log.id, date: log.date, u: S.D.meIdx, c: ci, outcome: log.outcome, followUp: log.followUp, note: log.note, signal: log.dealSignal, cooldown: log.cooldown };
  S.D.cons[ci].logs.push(l); S.D.logs.push(l); recomputeFlags(); renderRows(true);
}
async function editPhone(p, c, btn) {
  const wrap = btn.closest('.contact'); const div = wrap.querySelector('.m div');
  div.innerHTML = `<input value="${esc(c.phone)}" style="width:150px;padding:4px 6px;border:1px solid var(--line);border-radius:6px"> <button class="btn sm pri">Save</button>`;
  btn.hidden = true;
  div.querySelector('button').onclick = async () => {
    const v = div.querySelector('input').value.trim();
    try { await api('/api/contact', { method: 'PATCH', body: { id: c.id, phone: v, expected: { phone: c.phone } } }); toast('Phone updated in Airtable'); openDetail(p.i); }
    catch (e) { if (e.status === 409) { const t = e.data.conflicts[0]; div.innerHTML = `<span class="err" style="margin:0">Someone changed this to ${esc(t.theirs || '(blank)')} since you opened it.</span> <button class="btn sm">Reload</button>`; div.querySelector('button').onclick = () => openDetail(p.i); } else toast(e.message); }
  };
}
function closeDetail() { $('#detail').hidden = true; $('#scrim').hidden = true; S.sel = null; renderRows(true); }

// ── offline outbox ───────────────────────────────────────────
async function queue(item) { S.outbox = (await idb.get('outbox:' + S.user.id)) || []; S.outbox.push(item); await idb.set('outbox:' + S.user.id, S.outbox); setNet(); }
let flushing = false;
async function flushOutbox() {
  if (flushing || !S.user) return; S.outbox = (await idb.get('outbox:' + S.user.id)) || []; setNet();
  if (!S.outbox.length || !navigator.onLine) return; flushing = true;
  const left = [];
  for (const item of S.outbox) {
    try {
      if (!item.contactId) { // resolve contact by name from a live read (offline notes on never-opened records)
        const rec = await api('/api/record?id=' + encodeURIComponent(item.propertyId)); item.contactId = rec.contacts.find(c => c.name === item.contactName)?.id;
        if (!item.contactId) throw Object.assign(new Error('Contact not found'), { status: 404 }); }
      const r = await api('/api/log', { method: 'POST', body: item });
      const p = S.D.props.find(x => x.id === item.propertyId); if (p) addLocalLog(p, { name: item.contactName }, r.log);
    } catch (e) { if (e.status && e.status !== 503) { toast(`A queued note could not be saved: ${e.message}`); continue; } left.push(item); }
  }
  S.outbox = left; await idb.set('outbox:' + S.user.id, left); flushing = false; setNet();
  if (!left.length) toast('Queued notes sent to Airtable');
}
function setNet() {
  S.online = navigator.onLine; $('#netBadge').hidden = S.online;
  const n = (S.outbox || []).length; $('#outboxBadge').hidden = !n; $('#outboxBadge').textContent = `${n} note${n > 1 ? 's' : ''} queued`;
}

// ── follow-ups ───────────────────────────────────────────────
function renderFollowups() {
  const { logs, cons, ents, props, meIdx, users } = S.D; const admin = S.user.role === 'admin';
  const latest = new Map(); // newest log per contact decides whether a follow-up is still open
  for (const l of logs) { const cur = latest.get(l.c); if (!cur || l.date > cur.date) latest.set(l.c, l); }
  const items = [...latest.values()].filter(l => l.followUp && (admin || l.u === meIdx)).sort((a, b) => a.followUp.localeCompare(b.followUp));
  const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  $('#fuList').innerHTML = items.slice(0, 400).map(l => { const c = cons[l.c]; const e = ents[c.ents[0]]; const p = e && props[e.props[0]];
    return `<div class="card ${l.followUp < today ? 'over' : l.followUp <= soon ? 'soon' : ''}" data-i="${p ? p.i : ''}"><b>${fmtD(l.followUp)} · ${esc(c.name)}</b><div class="s">${esc(e?.name || '')}${p ? ' · ' + esc(p.address) + ', ' + esc(p.city) : ''}</div><div class="s">${admin ? esc(users[l.u]?.name) + ' · ' : ''}Last: ${esc(l.outcome)} ${fmtD(l.date)}</div></div>`; }).join('') || '<p class="muted">No follow-ups yet.</p>';
}

// ── admin: activity ──────────────────────────────────────────
async function renderActivity() {
  const sel = $('#actBroker'); if (sel.options.length <= 1) sel.innerHTML += S.D.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  const q = new URLSearchParams({ days: $('#actDays').value, broker: $('#actBroker').value, q: $('#actQ').value });
  const r = await api('/api/admin/logs?' + q);
  $('#actCount').textContent = `${r.total.toLocaleString()} entries${r.total > r.rows.length ? ` (showing ${r.rows.length})` : ''}`;
  $('#actTable tbody').innerHTML = r.rows.map(l => `<tr data-id="${l.id}" data-prop="${l.propertyId || ''}"><td>${fmtD(l.date)}</td><td>${esc(l.brokerName)}</td><td><a href="#" class="openp">${esc(l.entity || '—')}</a><div class="muted small">${esc(l.contactName)}</div></td>
    <td><select data-k="outcome">${['', ...OUTCOMES.map(o => o[0])].map(o => `<option ${o === l.outcome ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
    <td><select data-k="dealSignal">${SIGNALS.map(o => `<option ${o === l.dealSignal ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
    <td><input type="date" data-k="followUp" value="${l.followUp ? l.followUp.slice(0, 10) : ''}"></td><td><input type="checkbox" data-k="cooldown" ${l.cooldown ? 'checked' : ''}></td>
    <td class="note"><div contenteditable="true" data-k="note">${esc(l.note)}</div></td><td><button class="btn sm" data-save hidden>Save</button></td></tr>`).join('');
}

// ── admin: users, system, tests ──────────────────────────────
async function renderAdmin() {
  const [u, st] = await Promise.all([api('/api/admin/users'), api('/api/admin/status')]);
  $('#userList').innerHTML = u.accounts.map(a => `<div class="urow" data-id="${a.id}"><span class="av">${initials(a.name)}</span><div class="m"><b>${esc(a.name)}${a.active ? '' : ' (removed)'}</b><small>${a.role === 'admin' ? 'Admin · all territories' : esc(a.territory) + (a.userRecId ? '' : ' · ⚠ not linked to Airtable user')}</small></div>
    ${a.active ? `<button class="btn sm" data-reset>Reset PIN</button>${a.role !== 'admin' ? '<button class="btn sm" data-remove>Remove</button>' : ''}` : '<button class="btn sm" data-restore>Restore</button>'}</div>`).join('');
  const linked = new Set(u.accounts.filter(a => a.active).map(a => a.userRecId));
  $('#nuRec').innerHTML = u.airtableUsers.map(x => `<option value="${x.id}" data-terr="${esc(x.territory)}" data-name="${esc(x.name)}">${esc(x.name)}${linked.has(x.id) ? ' (has login)' : ''}</option>`).join('');
  const m = st.meta || {};
  $('#sysStatus').innerHTML = [['Data source', st.source === 'mock' ? 'Mock base (fictional, Trivium-scale)' : 'Airtable dev base'], ['Claude API', st.claude ? 'Configured' : 'Not configured — rules parser + template rationale'],
    ['Last full sync', m.builtAt ? `${fmtD(m.builtAt)} ${new Date(m.builtAt).toLocaleTimeString()}` : 'never'], ['Last incremental', m.lastIncrementalAt ? new Date(m.lastIncrementalAt).toLocaleString() : '—'],
    ['Records', m.counts ? Object.entries(m.counts).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ') : '—'],
    ['Full sync cost', m.airtableRequests ? `${m.airtableRequests} Airtable requests, ${(m.durationMs / 1000).toFixed(0)}s (last run)` : '—'], ['Notes since last sync', st.pending]]
    .map(([k, v]) => `<span>${k}</span><span>${esc(v)}</span>`).join('');
  const miss = Object.entries(st.schemaCheck?.missing || {}).filter(([, v]) => v.length);
  $('#schemaWarn').innerHTML = miss.length ? `<div class="notice">Fields in the app's config not found in the base: ${miss.map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v.join(', '))}`).join('; ')}. Update lib/config.mjs.</div>` : '';
}

function parseTable(r) {
  const S_ = r.score; const cell = (exp, got, field, unc) => { if (!exp) return `<td>${esc(got ?? '')}</td>`; const v = field === 'contact_name' ? (got || '').toLowerCase().includes((exp[field] || '').split(' ')[0].toLowerCase()) && (exp[field] ? !!got : !got) : (got ?? null) === (exp[field] ?? null);
    const flagged = !v && unc?.includes(field); return `<td class="${v ? 'ok-c' : flagged ? 'flag-c' : 'bad-c'}">${esc(got ?? '—')}${!v && !flagged ? `<div class="muted small">exp: ${esc(exp[field] ?? '—')}</div>` : ''}</td>`; };
  return (S_ ? `<div style="padding:10px"><span class="stat"><b>${S_.pct.contact_name}%</b>name</span><span class="stat"><b>${S_.pct.outcome}%</b>outcome</span><span class="stat"><b>${S_.pct.follow_up_date}%</b>follow-up</span><span class="stat"><b>${S_.pct.deal_signal}%</b>deal signal</span><span class="stat"><b>${S_.pct.cooldown}%</b>cooldown</span><span class="stat"><b>${S_.flagged}</b>flagged unsure</span></div>` : '')
    + `<table class="tbl"><thead><tr><th>#</th><th>Note</th><th>Name</th><th>Outcome</th><th>Follow-up</th><th>Signal</th><th>Cooldown</th><th>Unsure</th></tr></thead><tbody>${r.rows.map((x, i) => `<tr><td>${i + 1}</td><td class="note">${esc(x.text)}</td>
      ${cell(x.expected, x.got.contact_name, 'contact_name', x.got.uncertain)}${cell(x.expected, x.got.outcome, 'outcome', x.got.uncertain)}${cell(x.expected, x.got.follow_up_date, 'follow_up_date', x.got.uncertain)}${cell(x.expected, x.got.deal_signal, 'deal_signal')}${cell(x.expected, x.got.cooldown, 'cooldown')}
      <td class="small">${esc((x.got.uncertain || []).join(', '))}${x.got.why_uncertain ? `<div class="muted">${esc(x.got.why_uncertain)}</div>` : ''}</td></tr>`).join('')}</tbody></table>`;
}

// ── views + wiring ───────────────────────────────────────────
function setView(v) {
  for (const s of ['map', 'followups', 'activity', 'admin']) $('#view-' + s).hidden = s !== v;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'map') setTimeout(() => map?.invalidateSize(), 50);
  if (v === 'followups') renderFollowups();
  if (v === 'activity') renderActivity().catch(e => toast(e.message));
  if (v === 'admin') renderAdmin().catch(e => toast(e.message));
}
function setMobileView(v) {
  S.mobileView = v; $$('#mnav button').forEach(b => b.classList.toggle('on', b.dataset.mview === v));
  if (v === 'map' || v === 'list') { setView('map'); $('#view-map').classList.toggle('show-list', v === 'list'); if (v === 'list') renderRows(true); }
  else setView(v);
}
function wireUI() {
  $('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };
  $('#mnav').onclick = (e) => { const b = e.target.closest('button'); if (b) setMobileView(b.dataset.mview); };
  let qt; $('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { S.filters.q = e.target.value; applyFilters(); }, 120); };
  $('#fZip').onchange = (e) => { S.filters.zip = e.target.value; applyFilters(); };
  $('#fCounty').onchange = (e) => { S.filters.county = e.target.value; applyFilters(); };
  $('#fUnits').onchange = (e) => { S.filters.units = +e.target.value; applyFilters(); };
  $('#fSort').onchange = (e) => { S.filters.sort = e.target.value; applyFilters(); };
  $$('.chips .chip').forEach(c => c.onclick = () => { const f = c.dataset.f; S.filters.chips.has(f) ? S.filters.chips.delete(f) : S.filters.chips.add(f); c.classList.toggle('on'); applyFilters(); });
  $('#list').onscroll = () => renderRows(false);
  $('#listInner').onclick = (e) => { const r = e.target.closest('.row'); if (r) openDetail(+r.dataset.i); };
  $('#fuList').onclick = (e) => { const c = e.target.closest('.card'); if (c?.dataset.i) openDetail(+c.dataset.i); };
  $('#dClose').onclick = closeDetail; $('#scrim').onclick = closeDetail;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detail').hidden) closeDetail(); });
  $('#userChip').onclick = () => $('#userMenu').hidden = !$('#userMenu').hidden;
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); await idb.del('lastUser'); location.reload(); };
  addEventListener('online', () => { setNet(); flushOutbox(); }); addEventListener('offline', setNet);
  setInterval(flushOutbox, 30000);
  // activity table editing
  for (const id of ['actBroker', 'actDays']) $('#' + id).onchange = () => renderActivity();
  let aq; $('#actQ').oninput = () => { clearTimeout(aq); aq = setTimeout(renderActivity, 250); };
  $('#actTable').addEventListener('input', (e) => { const tr = e.target.closest('tr'); tr.classList.add('dirty'); tr.querySelector('[data-save]').hidden = false; });
  $('#actTable').addEventListener('change', (e) => { const tr = e.target.closest('tr'); if (!tr) return; tr.classList.add('dirty'); tr.querySelector('[data-save]').hidden = false; });
  $('#actTable').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    if (e.target.matches('.openp')) { e.preventDefault(); const p = S.D.props.find(x => x.id === tr.dataset.prop); if (p) openDetail(p.i); return; }
    if (!e.target.matches('[data-save]')) return;
    const g = (k) => tr.querySelector(`[data-k="${k}"]`);
    const fields = { outcome: g('outcome').value, dealSignal: g('dealSignal').value, followUp: g('followUp').value || null, cooldown: g('cooldown').checked, note: g('note').innerText.trim() };
    try { await api('/api/log', { method: 'PATCH', body: { id: tr.dataset.id, fields } }); tr.classList.remove('dirty'); e.target.hidden = true; toast('Saved to Airtable'); } catch (err) { toast(err.message); }
  });
  // admin users
  $('#nuRec').onchange = (e) => { const o = e.target.selectedOptions[0]; $('#nuName').value = o?.dataset.name || ''; $('#nuTerr').value = o?.dataset.terr || ''; };
  $('#nuSave').onclick = async () => { try { await api('/api/admin/users', { method: 'POST', body: { name: $('#nuName').value.trim(), userRecId: $('#nuRec').value, territory: $('#nuTerr').value.trim(), pin: $('#nuPin').value.trim() } }); $('#nuPin').value = ''; $('#nuErr').textContent = ''; toast('Broker saved'); renderAdmin(); } catch (e) { $('#nuErr').textContent = e.message; } };
  $('#userList').onclick = async (e) => {
    const row = e.target.closest('.urow'); if (!row) return; const id = row.dataset.id;
    if (e.target.matches('[data-reset]')) { const pin = prompt('New 4–6 digit PIN'); if (!pin) return; try { await api('/api/admin/users', { method: 'POST', body: { id, pin } }); toast('PIN reset — their old sessions are signed out'); } catch (er) { toast(er.message); } }
    if (e.target.matches('[data-remove]')) { if (!confirm('Remove this login? Their data in Airtable is untouched.')) return; await api('/api/admin/users?id=' + id, { method: 'DELETE' }); toast('Removed'); renderAdmin(); }
    if (e.target.matches('[data-restore]')) { await api('/api/admin/users', { method: 'POST', body: { id } }); renderAdmin(); }
  };
  $('#syncInc').onclick = async () => { toast('Syncing…'); try { const r = await api('/api/admin/sync', { method: 'POST', body: { mode: 'incremental' } }); toast(`${r.changed ?? 0} changed records pulled`); renderAdmin(); } catch (e) { toast(e.message); } };
  $('#syncFull').onclick = async () => { toast('Full sync started — takes ~2–3 min at this size'); try { const r = await api('/api/admin/sync', { method: 'POST', body: { mode: 'full' } }); toast(r.note || 'Full sync done'); renderAdmin(); } catch (e) { toast(e.message); } };
  $('#ptRun').onclick = async () => { // 10 notes per request (function time limits), aggregated here
    const lines = $('#ptNotes').value.split('\n').map(s => s.trim()).filter(Boolean); const rows = []; let ms = 0, cost = 0, engine = '', total = lines.length || 40;
    try { for (let from = 0; from < total; from += 10) { $('#ptMeta').textContent = `Parsing ${from + 1}–${Math.min(from + 10, total)} of ${total}…`;
        const r = await api('/api/admin/parse-test', { method: 'POST', body: lines.length ? { notes: lines.slice(from, from + 10) } : { from } });
        if (!lines.length) total = r.sampleTotal; rows.push(...r.rows); ms += r.ms; cost += r.usage?.cost_usd || 0; engine = r.engine; }
      const scored = rows.every(x => x.ok) ? (() => { const f = ['contact_name', 'outcome', 'follow_up_date', 'deal_signal', 'cooldown']; const pct = Object.fromEntries(f.map(k => [k, Math.round(100 * rows.filter(x => x.ok[k] === true).length / rows.length)]));
        return { pct, flagged: rows.filter(x => Object.values(x.ok).includes('flagged')).length }; })() : null;
      $('#ptMeta').textContent = `${rows.length} notes · ${engine === 'claude' ? 'Claude' : 'rules parser (no API key)'} · ${(ms / 1000).toFixed(1)}s${cost ? ` · $${cost.toFixed(4)}` : ''}`; $('#ptOut').innerHTML = parseTable({ rows, score: scored }); }
    catch (e) { $('#ptMeta').textContent = e.message; } };
  $('#rtRun').onclick = async () => { const N = Math.min(+$('#rtN').value || 50, 200); const samples = []; let ms = 0, cost = 0, gen = 0, engine = '';
    try { for (let from = 0; from < N; from += 10) { $('#rtMeta').textContent = `Generating ${from + 1}–${Math.min(from + 10, N)} of ${N}…`;
        const r = await api('/api/admin/rationale-test', { method: 'POST', body: { county: $('#rtCounty').value, n: Math.min(10, N - from), from, force: true } });
        samples.push(...r.samples); ms += r.ms; cost += r.costUsd; gen += r.generated; engine = r.engine; }
      const per = gen ? cost / gen : 0;
      $('#rtMeta').textContent = `${samples.length} records · ${engine} · ${gen ? Math.round(ms / gen) : 0} ms/record · $${cost.toFixed(4)} total · $${per.toFixed(5)}/record · projected 13k: $${(per * 13000).toFixed(2)}`;
      $('#rtOut').innerHTML = samples.map(s => `<div class="rt"><div class="h">${esc(s.address)} · ${s.units}u · built ${s.yearBuilt} · last sale ${esc(s.lastSale)}${s.loanMaturity ? ' · loan ' + s.loanMaturity : ''}</div><div>${esc(s.text)}</div></div>`).join(''); } catch (e) { $('#rtMeta').textContent = e.message; } };
  $('#meRun').onclick = async () => { try { await api('/api/admin/mock-edit', { method: 'POST', body: { contactId: $('#meContact').value.trim(), phone: $('#mePhone').value.trim() } }); $('#meOut').textContent = 'Edited in the base. Open the record again — it shows without a refresh.'; } catch (e) { $('#meOut').textContent = e.message; } };
}

boot();
