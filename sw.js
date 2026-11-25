// Win Bot's service worker. When online it always fetches this site's newest
// files (so the app is never stuck on an old version); when offline it uses
// the last good copy. It never touches requests to any other site.
const CACHE = 'winbot-files';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req.url, { cache: 'no-store', credentials: 'same-origin' });
      if (res.redirected) return fetch(req); // let the browser follow redirects itself
      if (res.ok && !url.search) {
        try { const c = await caches.open(CACHE); await c.put(req.url, res.clone()); } catch { /* storage full: fine */ }
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req.url, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
