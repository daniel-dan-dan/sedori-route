const CACHE_PREFIX = 'sedori-route-';
const CACHE_NAME = 'sedori-route-v193';
const ASSETS = [
  './',
  './index.html',
  './pair.html',
  './style.css?v=193',
  './app.js?v=193',
  './router.js?v=193',
  './api.js?v=193',
  './route-optimizer.js?v=193',
  './storage.js?v=193',
  './quiz.js?v=193',
  './vendor/leaflet/leaflet.css?v=193',
  './vendor/leaflet/leaflet.js?v=193',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-shadow.png',
  './icons/icon-96.png',
  './icons/chains/2ndstreet.png',
  './icons/chains/aeon.png',
  './icons/chains/autobacs.png',
  './icons/chains/bookoff.png',
  './icons/chains/cainz.png',
  './icons/chains/daiyu8.png',
  './icons/chains/daishin.png',
  './icons/chains/dcm.png',
  './icons/chains/donki.png',
  './icons/chains/edion.png',
  './icons/chains/james.png',
  './icons/chains/joshin.png',
  './icons/chains/kdenki.png',
  './icons/chains/kohnan.png',
  './icons/chains/kojima.png',
  './icons/chains/komeri.png',
  './icons/chains/nojima.png',
  './icons/chains/odin.png',
  './icons/chains/offhouse.png',
  './icons/chains/ofv.png',
  './icons/chains/sunday.png',
  './icons/chains/toysrus.png',
  './icons/chains/trefac.png',
  './icons/chains/tsutaya.png',
  './icons/chains/vivahome.png',
  './icons/chains/yamada.png',
  './icons/chains/yhat.png',
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
      Promise.all(
        keys
          .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
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
