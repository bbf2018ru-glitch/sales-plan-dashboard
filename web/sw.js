// Service worker — лёгкий cache-first для статики, network-first для API/dynamic.
//
// Кэшируем: index.html, app.js, styles.css, icon.svg, manifest.
// НЕ кэшируем: /api/*, SSE (/api/events), HTML с динамическим контентом.
// При network failure для shell — отдаём из кэша (offline-режим).

const CACHE_NAME = 'maria-dashboard-v17';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/icon.svg',
  '/manifest.webmanifest',
  '/logo-girl.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll — атомарно: или все, или ничего. Игнорируем 404 если у нас
      // в массиве вдруг что-то отсутствует — через индивидуальные fetch.
      Promise.all(STATIC_ASSETS.map((url) =>
        fetch(url, { cache: 'no-cache' })
          .then((r) => r.ok ? cache.put(url, r) : null)
          .catch(() => null)
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Только same-origin
  if (url.origin !== self.location.origin) return;
  // Только GET
  if (req.method !== 'GET') return;
  // API / SSE — не трогаем (всегда network)
  if (url.pathname.startsWith('/api/')) return;

  // Cache-first для shell-ассетов, fallback на network, и обновляем кэш свежей версией
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => cached || new Response('offline', { status: 503 }));
      return cached || network;
    })
  );
});
