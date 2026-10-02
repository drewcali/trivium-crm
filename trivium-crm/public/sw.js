// Offline shell: the app opens with no signal. API data is never cached here —
// the territory snapshot and the note outbox live in IndexedDB (see app.js).
const CACHE = 'trivium-shell-v1';
const SHELL = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icon.svg',
  '/vendor/leaflet.css', '/vendor/leaflet.js', '/vendor/MarkerCluster.css', '/vendor/MarkerCluster.Default.css', '/vendor/leaflet.markercluster.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;
  const isShell = url.origin === location.origin && SHELL.includes(url.pathname);
  if (!isShell) return;
  // network first (so deploys show up immediately), cache fallback when offline
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
