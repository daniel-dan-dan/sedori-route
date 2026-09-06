import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const apiSource = readFileSync(new URL('api.js', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('storage.js', import.meta.url), 'utf8');

// A shared transactional fixture: requests are asynchronous and transactions
// serialize across connections. It exercises the real Storage/API code without
// real browser credentials, product data, network requests, or dependencies.
function memoryIndexedDb() {
  const databases = new Map();
  function database(name) {
    if (!databases.has(name)) databases.set(name, { stores: new Map(), transactions: [], active: false });
    return databases.get(name);
  }
  function startNext(state) {
    if (state.active || !state.transactions.length) return;
    state.active = true;
    const transaction = state.transactions.shift();
    queueMicrotask(() => transaction.run());
  }
  return {
    open(name) {
      const fresh = !databases.has(name);
      const state = database(name);
      const result = {
        objectStoreNames: { contains: key => state.stores.has(key) },
        createObjectStore(key, options = {}) { state.stores.set(key, { values: new Map(), next: 1, options }); },
        transaction(storeName) {
          const operations = [];
          const tx = { oncomplete: null, onerror: null, onabort: null };
          const store = state.stores.get(storeName);
          assert.ok(store, `fixture store missing: ${storeName}`);
          const request = operation => {
            const req = { result: undefined, onsuccess: null, onerror: null };
            operations.push(() => { req.result = operation(); req.onsuccess?.({ target: req }); });
            return req;
          };
          tx.objectStore = () => ({
            getAll: () => request(() => [...store.values.values()].map(value => structuredClone(value))),
            get: key => request(() => structuredClone(store.values.get(key))),
            add: value => request(() => {
              const key = store.options.keyPath ? value[store.options.keyPath] : store.next++;
              if (store.values.has(key)) throw Error('fixture duplicate key');
              store.values.set(key, structuredClone(value)); return key;
            }),
            put: (value, explicitKey) => request(() => {
              const key = explicitKey ?? (store.options.keyPath ? value[store.options.keyPath] : store.next++);
              store.values.set(key, structuredClone(value)); return key;
            }),
            delete: key => request(() => store.values.delete(key)),
            clear: () => request(() => store.values.clear()),
            openCursor() {
              let entries;
              const req = { result: undefined, onsuccess: null, onerror: null };
              let index = 0;
              const next = () => {
                entries ??= [...store.values.entries()];
                const entry = entries[index++];
                req.result = entry ? { primaryKey: entry[0], value: structuredClone(entry[1]), continue: () => operations.push(next) } : null;
                req.onsuccess?.({ target: req });
              };
              operations.push(next); return req;
            },
          });
          tx.run = () => {
            try {
              while (operations.length) operations.shift()();
              tx.oncomplete?.({ target: tx });
            } catch (error) {
              tx.onerror?.({ target: { error } });
              tx.onabort?.({ target: { error } });
            } finally {
              state.active = false; startNext(state);
            }
          };
          state.transactions.push(tx); startNext(state); return tx;
        },
      };
      const req = { result, onsuccess: null, onupgradeneeded: null, onerror: null };
      queueMicrotask(() => {
        if (fresh) req.onupgradeneeded?.({ target: { result } });
        req.onsuccess?.({ target: { result } });
      });
      return req;
    },
  };
}

function harness(indexedDB, fetchImpl) {
  const values = new Map([['daniel_route_device_auth_v1', 'fixture-not-a-real-secret']]);
  const context = vm.createContext({
    indexedDB, crypto: webcrypto, URL, AbortController, setTimeout, clearTimeout,
    queueMicrotask, structuredClone,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    navigator: { onLine: true },
    window: { dispatchEvent() {}, addEventListener() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console: { warn() {} },
    fetch: fetchImpl,
  });
  vm.runInContext(`${storageSource}\n${apiSource}\nglobalThis.subject = { API, Storage };`, context);
  return context.subject;
}
const response = (data, error = '') => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: !error, data, error }) });
const unknown = () => response(null, 'OPERATION_OUTCOME_UNKNOWN: fixture only');
const purchase = { product_name: 'fixture product', purchase_date: '2026-09-05', store_id: 's-fixture', store_name: 'fixture shop', purchase_price: 1000 };
const item = { inventory_uuid: 'inv_00000000-0000-4000-8000-000000000001', expected_date: '2026-09-05', expected_shop: '', shop: 'fixture shop' };

const pricingPreference = { sku: 'fixture-amazon-sku', action: 'snooze', days: 3, expectedRevision: 0, operation_id: 'fixture-pricing-op-1' };
test('size allowance action sends only its exact identity and class, with durable operation protection',async()=>{
  const requests=[];
  const {API}=harness(memoryIndexedDb(),async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return response({ok:true,verified:true,item:{sku:pricingPreference.sku,preference:{revision:1},canChangePrice:false}});
  });
  await API.updateAmazonPricingPreference({...pricingPreference,action:'set_size',asin:'B000TEST01',sizeClass:'large'});
  assert.equal(requests[0].preference_action,'set_size');assert.equal(requests[0].sizeClass,'large');
  assert.equal(requests[0].asin,'B000TEST01');assert.equal(requests[0].days,undefined);
  for(const change of [{sizeClass:'unknown'},{asin:''},{asin:'bad'}]) {
    await assert.rejects(API.updateAmazonPricingPreference({...pricingPreference,action:'set_size',asin:'B000TEST01',sizeClass:'normal',...change}),{code:'INVALID_INPUT'});
  }
  assert.equal(requests.length,1);
});
test('pricing read does not create an operation and setting action is sent in a distinct wire field', async () => {
  const requests = [];
  const { API, Storage } = harness(memoryIndexedDb(), async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return response(request.action === 'getAmazonPricing' ? { ok:true, items:[] } : { ok:true,verified:true,item:{sku:pricingPreference.sku,preference:{revision:1},canChangePrice:false} });
  });
  await API.getAmazonPricing();
  assert.equal((await Storage.getPendingActions()).length, 0);
  await API.updateAmazonPricingPreference(pricingPreference);
  assert.equal(requests[1].action, 'updateAmazonPricingPreference');
  assert.equal(requests[1].preference_action, 'snooze');
  assert.equal(requests[1].operation_id, pricingPreference.operation_id);
  assert.equal((await Storage.getPendingActions()).length, 0);
});

test('pricing transport failure and changed preference never automatically replay', async () => {
  let calls = 0;
  const { API, Storage } = harness(memoryIndexedDb(), async () => { calls++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(API.updateAmazonPricingPreference(pricingPreference));
  assert.equal((await Storage.getPendingActions())[0].last_error_code, 'OPERATION_OUTCOME_UNKNOWN');
  await assert.rejects(API.updateAmazonPricingPreference({...pricingPreference,action:'exclude',operation_id:'fixture-pricing-op-2'}), {code:'PENDING_OPERATION_EXISTS'});
  assert.equal(await Storage.syncPending(),0);
  assert.equal(calls,1);
});

test('pricing response with wrong SKU, revision or price write capability is not accepted', async () => {
  for (const delta of [{sku:'other'}, {preference:{revision:2}}, {canChangePrice:true}]) {
    const { API, Storage } = harness(memoryIndexedDb(), async () => response({ok:true,verified:true,item:{sku:pricingPreference.sku,preference:{revision:1},canChangePrice:false,...delta}}));
    await assert.rejects(API.updateAmazonPricingPreference(pricingPreference), {code:'OPERATION_OUTCOME_UNKNOWN'});
    assert.equal(await Storage.syncPending(),0);
  }
});

test('pricing reservation is blocked even if browser reloads during the first request', async () => {
  const db=memoryIndexedDb(); let started, finish, calls=0;
  const began=new Promise(resolve=>{started=resolve;});
  const original=harness(db,async()=>{calls++;started();return new Promise(resolve=>{finish=resolve;});});
  const pending=original.API.updateAmazonPricingPreference(pricingPreference); await began;
  const reloaded=harness(db,async()=>{calls++;return unknown();}); await reloaded.API.ready();
  assert.equal(await reloaded.Storage.syncPending(),0); assert.equal(calls,1);
  finish(response({ok:true,verified:true,item:{sku:pricingPreference.sku,preference:{revision:1},canChangePrice:false}})); await pending;
});

test('pricing invalid revision/day/action is rejected before network or durable reservation', async () => {
  let calls=0; const {API,Storage}=harness(memoryIndexedDb(),async()=>{calls++;return unknown();});
  for(const delta of [{days:4},{expectedRevision:'0'},{action:'change_price'},{operation_id:''}]) {
    await assert.rejects(API.updateAmazonPricingPreference({...pricingPreference,...delta}),{code:'INVALID_INPUT'});
  }
  assert.equal(calls,0); assert.equal((await Storage.getPendingActions()).length,0);
});

test('pricing known pre-write refusal preserves its code and safely releases the reservation',async()=>{
  for(const code of ['INVALID_INPUT','PRICING_REFRESH_REQUIRED','PRICING_REVISION_CONFLICT','BUSY','UNAUTHORIZED']) {
    const {API,Storage}=harness(memoryIndexedDb(),async()=>response(null,code+': fixture rejection'));
    await assert.rejects(API.updateAmazonPricingPreference(pricingPreference),{code});
    assert.equal((await Storage.getPendingActions()).length,0);
  }
});

test('pricing uncertain request does not freeze unrelated queued inventory work',async()=>{
  const calls=[];const {API,Storage}=harness(memoryIndexedDb(),async(_url,options)=>{
    const req=JSON.parse(options.body);calls.push(req.action);
    if(req.action==='updateAmazonPricingPreference')throw new TypeError('Failed to fetch');
    return response({row:4});
  });
  await assert.rejects(API.updateAmazonPricingPreference(pricingPreference));
  await Storage.reservePendingAction({action:'addInventoryPurchase',body:{...purchase,operation_id:'unrelated-inventory-op'},operation_id:'unrelated-inventory-op',timestamp:Date.now(),attempts:0});
  assert.equal(await Storage.syncPending(),1);
  assert.deepEqual(calls,['updateAmazonPricingPreference','addInventoryPurchase']);
  assert.equal((await Storage.getPendingActions()).length,1);
});

test('unknown rejects instead of reporting saved, and edited re-entry keeps one receipt', async () => {
  const requests = [];
  const { API, Storage } = harness(memoryIndexedDb(), async (_url, options) => { requests.push(JSON.parse(options.body)); return unknown(); });
  await assert.rejects(API.addInventoryPurchase(purchase), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  await assert.rejects(API.addInventoryPurchase({ ...purchase, purchase_price: 1100 }), { code: 'PENDING_OPERATION_EXISTS' });
  assert.equal(requests.length, 1);
  const pending = await Storage.getPendingActions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation_id, requests[0].operation_id);
  assert.equal(pending[0].last_error_code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(await Storage.syncPending(), 0);
  assert.equal(requests.length, 1, 'unknown outcomes must not be automatically replayed');
});

test('shop reservations overlap across individual and bulk actions in either direction', async () => {
  for (const firstBulk of [true, false]) {
    const requests = [];
    const { API } = harness(memoryIndexedDb(), async (_url, options) => { requests.push(JSON.parse(options.body)); return unknown(); });
    await assert.rejects(firstBulk ? API.bulkUpdateInventoryShop({ items: [item] }) : API.updateInventoryShop(item), { code: 'OPERATION_OUTCOME_UNKNOWN' });
    const changed = { ...item, shop: 'other fixture shop' };
    await assert.rejects(firstBulk ? API.updateInventoryShop(changed) : API.bulkUpdateInventoryShop({ items: [changed] }), { code: 'PENDING_OPERATION_EXISTS' });
    assert.equal(requests.length, 1);
  }
});

test('two tabs concurrently reserving the same purchase send only one request', async () => {
  const db = memoryIndexedDb(); const requests = [];
  const fetchImpl = async (_url, options) => { requests.push(JSON.parse(options.body)); return unknown(); };
  const left = harness(db, fetchImpl); await left.API.ready();
  const right = harness(db, fetchImpl); await right.API.ready();
  const results = await Promise.allSettled([left.API.addInventoryPurchase(purchase), right.API.addInventoryPurchase(purchase)]);
  assert.deepEqual(results.map(result => result.reason?.code).sort(), ['OPERATION_OUTCOME_UNKNOWN', 'PENDING_OPERATION_EXISTS']);
  assert.equal(requests.length, 1);
  assert.equal((await left.Storage.getPendingActions()).length, 1);
});

test('reloading during fetch restores the durable receipt and replays only the same ID', async () => {
  const db = memoryIndexedDb(); const requests = [];
  let releaseFirst, started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const original = harness(db, async (_url, options) => {
    requests.push(JSON.parse(options.body)); started();
    return new Promise(resolve => { releaseFirst = resolve; });
  });
  const sending = original.API.addInventoryPurchase(purchase);
  await firstStarted;
  const saved = await original.Storage.getPendingActions();
  assert.equal(saved.length, 1, 'receipt must exist while the first network response is still pending');
  const reloaded = harness(db, async (_url, options) => { requests.push(JSON.parse(options.body)); return response({ row: 4 }); });
  await reloaded.API.ready();
  assert.equal((await reloaded.Storage.getPendingActions())[0].operation_id, saved[0].operation_id);
  await assert.rejects(reloaded.API.addInventoryPurchase(purchase), { code: 'PENDING_OPERATION_EXISTS' });
  assert.equal(await reloaded.Storage.syncPending(), 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].operation_id, requests[1].operation_id);
  releaseFirst(response({ row: 4 })); await sending;
  assert.equal((await reloaded.Storage.getPendingActions()).length, 0);
});

test('known validation failure removes its reservation instead of blocking later input', async () => {
  const { API, Storage } = harness(memoryIndexedDb(), async () => response(null, 'INVENTORY_REFRESH_REQUIRED: fixture validation'));
  await assert.rejects(API.updateInventoryShop(item), { code: 'API_ERROR' });
  assert.equal((await Storage.getPendingActions()).length, 0);
});

test('sync retains invalid old requests for review without automatically replaying them', async () => {
  let requests = 0;
  const { API, Storage } = harness(memoryIndexedDb(), async () => { requests++; return response(null, 'INVENTORY_REFRESH_REQUIRED: fixture validation'); });
  await API.ready();
  await Storage.reservePendingAction({ action: 'updateInventoryShop', body: { row: 4, shop: 'fixture shop', operation_id: 'fixture-old-queue' }, operation_id: 'fixture-old-queue', timestamp: Date.now(), attempts: 0 });
  assert.equal(await Storage.syncPending(), 0);
  const pending = await Storage.getPendingActions();
  assert.equal(pending.length, 1, 'retain the failed operation as evidence for review');
  assert.equal(pending[0].operation_id, 'fixture-old-queue');
  assert.equal(pending[0].last_error_code, 'API_ERROR');
  assert.equal((await Storage.getPendingQueueStatus()).blocked, 1);
  assert.equal(requests, 1);
  assert.equal(await Storage.syncPending(), 0);
  assert.equal(requests, 1, 'a blocked validation failure must not be sent again');
});

test('registration status persists after a successful response and is isolated by route', async () => {
  const db = memoryIndexedDb();
  const { API, Storage } = harness(db, async () => response({row:123,inventory_uuid:'fixture-inventory'}));
  await API.addInventoryPurchase({...purchase,route_id:'route-a'});
  assert.equal((await Storage.getPendingActions()).length,0);
  let receipts=await Storage.getInventoryReceiptStatus('route-a');
  assert.equal(receipts.length,1);assert.equal(receipts[0].status,'registered');assert.equal(receipts[0].row,123);
  assert.equal((await Storage.getInventoryReceiptStatus('route-b')).length,0);
  await Storage.savePurchaseDraft('fixture-key',{payload:{product_name:'next item'}});
  await Storage.clearRemoteCaches();
  const reloaded=harness(db,async()=>{throw Error('unexpected network');});await reloaded.API.ready();
  receipts=await reloaded.Storage.getInventoryReceiptStatus('route-a');assert.equal(receipts[0].status,'registered');
  assert.equal((await reloaded.Storage.getPurchaseDraft('fixture-key')).data.payload.product_name,'next item');
});
test('pending and unknown receipts never appear registered, including after a replay succeeds',async()=>{
  const db=memoryIndexedDb();const first=harness(db,async()=>{throw TypeError('Failed to fetch');});
  await first.API.addInventoryPurchase({...purchase,route_id:'route-a'});
  assert.equal((await first.Storage.getInventoryReceiptStatus())[0].status,'pending');
  const retry=harness(db,async()=>response({row:124}));await retry.API.ready();await retry.Storage.syncPending();
  const receipts=await retry.Storage.getInventoryReceiptStatus();assert.equal(receipts.length,1);assert.equal(receipts[0].status,'registered');
  const review=harness(memoryIndexedDb(),async()=>unknown());await assert.rejects(review.API.addInventoryPurchase(purchase));
  assert.equal((await review.Storage.getInventoryReceiptStatus())[0].status,'review');
});

for (const emptyResult of [null, undefined, false, '', 0, {}]) test('empty success data persists as review before clearing its pending receipt: '+String(emptyResult),async()=>{
  const {API,Storage}=harness(memoryIndexedDb(),async()=>response(emptyResult));
  await API.addInventoryPurchase({...purchase,route_id:'route-empty'});
  assert.equal((await Storage.getPendingActions()).length,0);
  const receipts=await Storage.getInventoryReceiptStatus('route-empty');
  assert.equal(receipts.length,1);assert.equal(receipts[0].status,'review');assert.equal(receipts[0].row,null);
  assert.match(receipts[0].reason,/登録先を確認できません/);
});
