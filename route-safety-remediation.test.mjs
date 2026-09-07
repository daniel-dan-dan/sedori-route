import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const optimizerSource = readFileSync(new URL('./route-optimizer.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const currentWorkerCache = workerSource.match(/const CACHE_NAME = '([^']+)'/)[1];
const context = {};
vm.runInNewContext(optimizerSource + '\nglobalThis.optimizer = RouteOptimizer;', context);
const optimizer = context.optimizer;
const home = { lat: 38, lng: 140 };

test('offline installation includes every manifest icon and HTML dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  for (const icon of manifest.icons) assert.ok(workerSource.includes(`'./${icon.src}'`), icon.src);
  for (const filename of ['index.html', 'pair.html']) {
    const html = readFileSync(new URL(`./${filename}`, import.meta.url), 'utf8');
    for (const [, path] of html.matchAll(/(?:src|href)="((?:[\w/-]+\.(?:js|css|png|json))(?:\?v=\d+)?)"/g)) {
      assert.ok(workerSource.includes(`'./${path}'`), path);
    }
  }
});

test('one-store optimization includes the same stay duration as selection order', () => {
  const stores = [{ lat: 38.01, lng: 140.02, avg_stay_min: 45 }];
  const optimized = optimizer.optimize(home, stores);
  const ordered = optimizer.calcSelectionOrder(home, stores);
  assert.equal(optimized.estimatedMinutes, ordered.estimatedMinutes);
  assert.ok(optimized.estimatedMinutes >= 45);
});

test('zero-minute stays remain zero; only missing values default to thirty', () => {
  for (const method of ['optimize', 'calcSelectionOrder']) {
    assert.equal(optimizer[method](home, [{ ...home, avg_stay_min: 0 }]).estimatedMinutes, 0);
    assert.equal(optimizer[method](home, [{ ...home, avg_stay_min: '0' }, { ...home, avg_stay_min: 0 }]).estimatedMinutes, 0);
    assert.equal(optimizer[method](home, [{ ...home }]).estimatedMinutes, 30);
  }
});

test('invalid or missing coordinates never become valid zero coordinates', () => {
  for (const method of ['optimize', 'calcSelectionOrder']) {
    for (const invalid of [NaN, Infinity, null, undefined, '', 'bad', 91]) {
      assert.throws(() => optimizer[method]({ lat: invalid, lng: 140 }, [{ ...home }]), /緯度/);
      assert.throws(() => optimizer[method](home, [{ lat: invalid, lng: 140 }]), /緯度/);
    }
    assert.throws(() => optimizer[method](home, [{ lat: 38, lng: 181 }]), /経度/);
  }
  assert.equal(optimizer.haversine(0, 0, 0, 0), 0);
  assert.ok(Number.isFinite(optimizer.haversine(0, 0, 0, 180)));
});

test('invalid speed and stay durations fail closed rather than producing NaN', () => {
  for (const method of ['optimize', 'calcSelectionOrder']) {
    for (const speed of [0, -1, NaN, Infinity, '', null, 'bad']) {
      assert.throws(() => optimizer[method](home, [{ ...home }], speed), /平均速度/);
    }
    for (const stay of [-1, NaN, Infinity, 'bad']) {
      assert.throws(() => optimizer[method](home, [{ ...home, avg_stay_min: stay }]), /滞在時間/);
    }
    assert.throws(() => optimizer[method](home, [{ lat: 38.1, lng: 140 }], Number.MIN_VALUE), /計算できません/);
  }
});

test('normalization does not change caller-owned store data', () => {
  const stores = [{ lat: '38', lng: '140', avg_stay_min: '0' }];
  const before = JSON.stringify(stores);
  optimizer.optimize(home, stores);
  assert.equal(JSON.stringify(stores), before);
  assert.throws(() => optimizer.generateMapsSegments(home, [{ lat: 'bad', lng: 140 }]), /緯度/);
});

function mimeFor(asset) {
  const path = new URL(asset, 'https://example.test/route/').pathname;
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.json')) return 'application/json';
  return 'text/html';
}

function workerHarness({ badStatus, badMime, badNetwork, failPut } = {}) {
  const listeners = {};
  const cacheMaps = new Map([['sedori-route-v195', new Map([['old', 'preserved']])], ['other-app-v1', new Map()]]);
  const calls = { skip: 0, claim: 0, puts: 0, fetches: 0, deleted: [] };
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://example.test/route/').href;
  const caches = {
    async open(name) {
      if (!cacheMaps.has(name)) cacheMaps.set(name, new Map());
      const data = cacheMaps.get(name);
      return {
        async put(asset, response) {
          calls.puts++;
          if (failPut && calls.puts === 3) throw new Error('QuotaExceededError');
          data.set(key(asset), response.clone());
        },
        async match(asset) { return data.get(key(asset))?.clone(); },
      };
    },
    async keys() { return [...cacheMaps.keys()]; },
    async delete(name) { calls.deleted.push(name); return cacheMaps.delete(name); },
  };
  const worker = {
    location: { href: 'https://example.test/route/sw.js?v=196', origin: 'https://example.test' },
    addEventListener(name, callback) { listeners[name] = callback; },
    async skipWaiting() { calls.skip++; },
    clients: { async claim() { calls.claim++; } },
  };
  const fetch = async asset => {
    calls.fetches++;
    const target = typeof asset === 'string' ? asset : asset.url;
    if (badNetwork && target.includes('app.js')) throw new Error('offline');
    return new Response('fixture', {
      status: badStatus && target.includes('app.js') ? 404 : 200,
      headers: { 'content-type': badMime && target.includes('app.js') ? 'text/html' : mimeFor(target) },
    });
  };
  const env = { self: worker, caches, fetch, URL, Request, Response };
  vm.runInNewContext(workerSource + '\nglobalThis.assetCount = ASSETS.length;', env);
  async function event(type, extra = {}) {
    const waits = [];
    listeners[type]({ ...extra, waitUntil(promise) { waits.push(promise); } });
    await Promise.all(waits);
  }
  return { event, calls, cacheMaps, assetCount: env.assetCount, listeners };
}

test('worker takes over only after every required response is validated and cached', async () => {
  const h = workerHarness();
  await h.event('install');
  assert.equal(h.calls.puts, h.assetCount);
  assert.equal(h.calls.skip, 0, 'completed updates must wait until existing tabs close');
  assert.ok(h.cacheMaps.has('sedori-route-v195'));
  await h.event('activate');
  assert.equal(h.calls.claim, 1);
  assert.ok(!h.cacheMaps.has('sedori-route-v195'));
  assert.ok(h.cacheMaps.has('other-app-v1'));
});

for (const failure of ['badStatus', 'badMime', 'badNetwork']) {
  test(`worker preserves the old release when a required asset fails: ${failure}`, async () => {
    const h = workerHarness({ [failure]: true });
    await assert.rejects(h.event('install'));
    assert.equal(h.calls.puts, 0);
    assert.equal(h.calls.skip, 0);
    assert.ok(h.cacheMaps.has('sedori-route-v195'));
  });
}

test('cache write failure deletes only the incomplete new release', async () => {
  const h = workerHarness({ failPut: true });
  await assert.rejects(h.event('install'), /QuotaExceededError/);
  assert.equal(h.calls.skip, 0);
  assert.ok(h.cacheMaps.has('sedori-route-v195'));
  assert.ok(h.cacheMaps.has('other-app-v1'));
  assert.ok(!h.cacheMaps.has(currentWorkerCache));
});

test('early skip-waiting message cannot bypass the complete cache gate', async () => {
  const h = workerHarness();
  await h.event('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(h.calls.skip, 0);
  await assert.rejects(h.event('activate'), /未完成/);
  assert.equal(h.calls.claim, 0);
  assert.ok(h.cacheMaps.has('sedori-route-v195'));
});

test('active worker serves one verified release without mixing fresh deployment files', async () => {
  const h = workerHarness(); await h.event('install'); await h.event('activate');
  const before = h.calls.fetches;
  const assets = [...h.cacheMaps.get(currentWorkerCache).keys()].filter(url => /app\.js|index\.html/.test(url));
  for (const url of assets) {
    let response;
    await h.event('fetch', { request: new Request(url), respondWith(value) { response = value; } });
    assert.equal(await (await response).text(), 'fixture');
  }
  assert.equal(h.calls.fetches, before, 'known files remain in the active release until waiting worker activation');
});
