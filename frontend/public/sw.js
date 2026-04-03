// Self-destruct service worker — replaces the old caching SW.
// Browsers that have the previous SW installed will fetch this update,
// which immediately unregisters itself and clears all caches.
// This file must remain at /sw.js so the browser finds the update.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister()),
  );
});
