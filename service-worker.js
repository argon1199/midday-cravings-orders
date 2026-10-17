/* App-shell cache.
 *
 * BUMP CACHE_VERSION ON EVERY CHANGE to index.html, style.css, app.js, config.js or
 * manifest.json. Phones that already installed the app keep serving the cached copies
 * until this string changes, so a content change shipped without a bump is invisible
 * to every existing device.
 */
const CACHE_VERSION = 'midday-cravings-v5';

const SHELL = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Individually, so a missing config.js cannot fail the whole install. 'reload' skips
      // the browser's HTTP cache, so a fresh install never saves an old file.
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // The API must always go straight to the network (or fail fast, so the app can queue
  // the write locally). Caching it would serve stale menus and swallow sync failures.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).catch(() => {
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
