const CACHE = 'mitzo-shell-v1';

// On install: cache the app shell entry point
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add('/')),
  );
  self.skipWaiting();
});

// On activate: clear old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// On fetch: skip API/WS, serve cached assets, cache new ones
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // Never intercept API calls or WebSocket upgrades
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      // Return cached immediately if available; fetch in background to refresh
      return cached || networkFetch;
    }),
  );
});
