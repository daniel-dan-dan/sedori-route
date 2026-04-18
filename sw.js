const CACHE_NAME = 'sedori-route-v43';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './router.js',
  './api.js',
  './route-optimizer.js',
  './storage.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // GAS API はキャッシュしない
  if (e.request.url.includes('script.google.com')) return;
  // ネットワーク優先、失敗時にキャッシュ（オフライン対応）
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
