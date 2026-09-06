const CACHE_PREFIX = 'sedori-route-';
const CACHE_NAME = 'sedori-route-v199';
const ASSETS = [
  './',
  './index.html',
  './pair.html',
  './style.css?v=199',
  './app.js?v=199',
  './router.js?v=199',
  './api.js?v=199',
  './route-optimizer.js?v=199',
  './storage.js?v=199',
  './quiz.js?v=199',
  './amazon-pricing.js?v=199',
  './bootstrap.js?v=199',
  './pair.js?v=199',
  './vendor/leaflet/leaflet.css?v=199',
  './vendor/leaflet/leaflet.js?v=199',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-shadow.png',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
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

function validAssetResponse_(asset, response) {
  if (!response || !response.ok || response.type === 'opaque') return false;
  if (response.url && new URL(response.url).origin !== self.location.origin) return false;
  const path = new URL(asset, self.location.href).pathname;
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/\.js$/.test(path)) return ['application/javascript', 'text/javascript'].includes(mime);
  if (/\.css$/.test(path)) return mime === 'text/css';
  if (/\.png$/.test(path)) return mime === 'image/png';
  if (/\.json$/.test(path)) return ['application/json', 'application/manifest+json'].includes(mime);
  return mime === 'text/html';
}

async function releaseCacheComplete_() {
  const cache = await caches.open(CACHE_NAME);
  const responses = await Promise.all(ASSETS.map(asset => cache.match(asset)));
  return responses.every((response, index) => validAssetResponse_(ASSETS[index], response));
}

async function installRelease_() {
  // Start: all required HTTP/MIME responses pass; continue: cache writes finish;
  // end: read-back is complete before takeover, or discard only this new cache.
  const responses = await Promise.all(ASSETS.map(async asset => {
    const response = await fetch(asset, { cache: 'reload' });
    if (!validAssetResponse_(asset, response)) throw new Error(`PWA更新ファイルを確認できません: ${asset}`);
    return response;
  }));
  const cache = await caches.open(CACHE_NAME);
  try {
    for (let index = 0; index < ASSETS.length; index++) await cache.put(ASSETS[index], responses[index]);
    if (!(await releaseCacheComplete_())) throw new Error('PWA更新ファイルの保存確認に失敗しました');
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
  // 入力中の旧タブを守るため、全クライアントが閉じるまで通常のwaitingを維持する。
}

self.addEventListener('install', e => {
  e.waitUntil(installRelease_());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    // 旧bootstrapは更新のたびにこのメッセージを送る。即時切替は行わない。
    if (e.source) e.source.postMessage({ type: 'UPDATE_WAITING', cacheName: CACHE_NAME });
  }
  if (e.data && e.data.type === 'GET_VERSION' && e.source) {
    e.source.postMessage({ type: 'SW_VERSION', cacheName: CACHE_NAME });
  }
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    if (!(await releaseCacheComplete_())) throw new Error('未完成のPWA更新は有効化しません');
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
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
  const knownAsset = ASSETS.find(asset => new URL(asset, self.location.href).href === e.request.url);
  e.respondWith(
    fetch(req)
      .then(res => {
        if (knownAsset && !validAssetResponse_(knownAsset, res)) throw new Error('更新ファイルが不正なため保存済み版を使います');
        if (knownAsset) {
          const clone = res.clone();
          e.waitUntil(caches.open(CACHE_NAME).then(c => c.put(e.request, clone)));
        }
        return res;
      })
      .catch(() => caches.open(CACHE_NAME).then(c => c.match(e.request)))
  );
});
