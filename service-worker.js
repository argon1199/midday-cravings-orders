// Caches the app shell so the app opens with zero network requests.
// Data (menu + orders) lives in localStorage, handled in app.js — this
// worker only needs to guarantee the HTML/CSS/JS/icons are available offline.
//
// IMPORTANT: bump CACHE_NAME (e.g. v2 -> v3) every time you edit index.html,
// style.css, app.js, config.js, or manifest.json and redeploy. Otherwise
// phones that already installed the app keep serving the old cached files
// indefinitely — they never notice the update.

const CACHE_NAME = 'mc-orders-v2';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept calls to the Apps Script API — those must always hit
  // the network (or fail fast so app.js can queue the order locally).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});
