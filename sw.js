const CACHE_NAME = 'sedori-route-v168';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './router.js',
  './api.js',
  './route-optimizer.js',
  './storage.js',
  './quiz.js',
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
  if (e.data && e.data.type === 'GET_VERSION' && e.source) {
    e.source.postMessage({ type: 'SW_VERSION', cacheName: CACHE_NAME });
  }
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

  const url = new URL(e.request.url);
  // 地図タイルやLeaflet CDNなどの外部リソースは、ブラウザ標準キャッシュに任せる
  if (url.origin !== self.location.origin) return;

  // 自前ファイルだけネットワーク優先で更新確認（失敗時にSWキャッシュ）
  const req = new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then(res => {
        const clone = res.clone();
        if (res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
