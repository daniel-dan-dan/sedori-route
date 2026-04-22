const CACHE_NAME = 'sedori-route-v107';
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
  e.waitUntil(
    caches.open(CACHE_NAME).then(c =>
      Promise.all(ASSETS.map(url => fetch(url, { cache: 'reload' }).then(r => c.put(url, r))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  // ネットワーク優先、HTTPキャッシュをバイパスして常に最新を取得（失敗時にSWキャッシュ）
  const req = new Request(e.request.url, {
    method: 'GET',
    headers: e.request.headers,
    mode: e.request.mode === 'navigate' ? 'cors' : e.request.mode,
    credentials: e.request.credentials,
    redirect: e.request.redirect,
    cache: 'no-cache',
  });
  e.respondWith(
    fetch(req)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
