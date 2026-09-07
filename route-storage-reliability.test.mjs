import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(process.env.ROUTE_STORAGE_TEST_SOURCE || new URL('storage.js', import.meta.url), 'utf8');
const apiSource = readFileSync(process.env.ROUTE_API_TEST_SOURCE || new URL('api.js', import.meta.url), 'utf8');
const pairSource = readFileSync(process.env.ROUTE_PAIR_TEST_SOURCE || new URL('pair.js', import.meta.url), 'utf8');
const errorNamed = name => Object.assign(new Error(name), { name });

// No real data/network. Snapshot transactions commit only on completion and
// roll back on abort. Clone/key errors occur synchronously at request creation,
// as they do in IndexedDB (not later inside request.onsuccess).
function fixture() {
  const stores = new Map(), transactions = [], connections = [], opens = [];
  let active = false;
  const control = { nextFailure: '', blockNext: false, openError: false, opens, connections, stores };
  function start() {
    if (active || !transactions.length) return;
    active = true;
    const run = transactions.shift();
    setImmediate(() => run(() => { active = false; start(); }));
  }
  control.open = () => {
    const fresh = stores.size === 0;
    const blocked = control.blockNext; control.blockNext = false;
    const openError = control.openError; control.openError = false;
    const db = {
      closed: false,
      close() { this.closed = true; },
      objectStoreNames: { contains: name => stores.has(name) },
      createObjectStore(name, options = {}) { stores.set(name, { values: new Map(), next: 1, options }); },
      transaction(name) {
        if (this.closed) throw errorNamed('InvalidStateError');
        const state = stores.get(name);
        if (!state) throw errorNamed('NotFoundError');
        const failure = control.nextFailure; control.nextFailure = '';
        const operations = [];
        let draft, next, aborted = false, finished = false;
        const tx = { error: null, abort() { if (finished) throw errorNamed('InvalidStateError'); aborted = true; } };
        const request = operation => {
          const req = {};
          operations.push(() => { req.result = operation(); req.onsuccess?.({ target: req }); });
          return req;
        };
        const write = (value, key, addOnly) => {
          const copy = structuredClone(value);
          const id = key ?? (state.options.keyPath ? copy[state.options.keyPath] : undefined);
          if (id === undefined && !state.options.autoIncrement) throw errorNamed('DataError');
          return request(() => {
            const actual = id ?? next++;
            if (addOnly && draft.has(actual)) throw errorNamed('ConstraintError');
            draft.set(actual, copy); return actual;
          });
        };
        tx.objectStore = () => ({
          put: (value, key) => write(value, key, false),
          add: value => write(value, undefined, true),
          get: key => request(() => structuredClone(draft.get(key))),
          getAll: () => request(() => [...draft.values()].map(value => structuredClone(value))),
          clear: () => request(() => draft.clear()),
          delete: key => request(() => draft.delete(key)),
          openCursor() {
            const req = {}; let entries, index = 0;
            const advance = () => {
              entries ??= [...draft.entries()];
              const entry = entries[index++];
              req.result = entry ? { value: structuredClone(entry[1]), primaryKey: entry[0], continue: () => operations.push(advance) } : null;
              req.onsuccess?.({ target: req });
            };
            operations.push(advance); return req;
          },
        });
        transactions.push(done => {
          draft = structuredClone(state.values); next = state.next;
          try {
            if (failure === 'abort') aborted = true;
            if (failure === 'quota') throw errorNamed('QuotaExceededError');
            while (operations.length && !aborted) operations.shift()();
            if (failure === 'abortAfterRequests') aborted = true;
          } catch (error) {
            tx.error = error; aborted = true; tx.onerror?.({ target: { error } });
          }
          // Request success is not durable success; allow microtasks between.
          setImmediate(() => {
            finished = true;
            if (aborted) tx.onabort?.({ target: tx });
            else { state.values = draft; state.next = next; tx.oncomplete?.({ target: tx }); }
            done();
          });
        });
        start(); return tx;
      },
    };
    const req = { result: db, error: errorNamed('UnknownError') };
    opens.push(req); connections.push(db);
    setImmediate(() => {
      if (openError) return req.onerror?.({ target: req });
      if (blocked) return req.onblocked?.({ target: req });
      if (fresh) req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    });
    return req;
  };
  return control;
}

function load(indexedDB = fixture()) {
  const events = {}, warnings = [];
  const context = vm.createContext({
    indexedDB, console: { warn: (...args) => warnings.push(args), log() {} },
    window: { addEventListener: (name, callback) => { events[name] = callback; }, dispatchEvent() {} },
    API: { hasToken: () => true }, navigator: { onLine: true }, CustomEvent: class {},
  });
  vm.runInContext(source + '\nglobalThis.subject = Storage;', context);
  return { storage: context.subject, indexedDB, events, warnings };
}
const oldStores = [{ store_id: 'old', name: 'old fixture store' }];
const action = { action: 'addPurchase', body: { value: 1 }, operation_id: 'fixture-operation', timestamp: Date.now() };
const tick = () => new Promise(resolve => setImmediate(resolve));
const bounded = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('transaction remained pending')), 300); })]).finally(() => clearTimeout(timer));
};

test('replacement clone error rolls back clear and earlier valid puts', async () => {
  const { storage } = load();
  await storage.cacheStores(oldStores);
  await assert.rejects(storage.cacheStores([{ store_id: 'new' }, { store_id: 'bad', bad: () => {} }]), { name: 'DataCloneError' });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getCachedStores())), oldStores);
});

test('missing key rolls back the entire cache replacement', async () => {
  const { storage } = load(); await storage.cacheStores(oldStores);
  await assert.rejects(storage.cacheStores([{ store_id: 'new' }, { name: 'missing key' }]), { name: 'DataError' });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getCachedStores())), oldStores);
});

test('bulk config clone failure cannot partially change existing configuration', async () => {
  const { storage } = load(); await storage.cacheConfig({ first: 'old', other: 'keep' });
  await assert.rejects(storage.cacheConfig({ first: 'new', bad: () => {} }), { name: 'DataCloneError' });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getCachedConfig())), { first: 'old', other: 'keep' });
});

for (const failure of ['abort', 'quota']) test(`${failure} rejects saves/deletes and retains the previous route`, async () => {
  const { storage, indexedDB } = load(); await storage.saveCurrentRoute({ name: 'original' });
  indexedDB.nextFailure = failure;
  await assert.rejects(bounded(storage.saveCurrentRoute({ name: 'new' })), error => !/remained pending/.test(error.message));
  assert.equal((await storage.getCurrentRoute()).name, 'original');
  indexedDB.nextFailure = failure;
  await assert.rejects(bounded(storage.clearCurrentRoute()), error => !/remained pending/.test(error.message));
  assert.equal((await storage.getCurrentRoute()).name, 'original');
});

for (const method of ['getCurrentRoute', 'getCachedStores', 'getPendingActions']) test(`${method} waits for transaction completion, not request success`, async () => {
  const { storage, indexedDB } = load(); await storage.cacheStores(oldStores);
  indexedDB.nextFailure = 'abortAfterRequests';
  await assert.rejects(bounded(storage[method]()), error => !/remained pending/.test(error.message));
});

test('simultaneous initial reads share one database open', async () => {
  const { storage, indexedDB } = load();
  await Promise.all([storage.getCurrentRoute(), storage.getCachedStores(), storage.getCachedConfig()]);
  assert.equal(indexedDB.opens.length, 1);
});

test('version change closes old connection and next operation opens afresh', async () => {
  const { storage, indexedDB } = load(); await storage.cacheStores(oldStores);
  indexedDB.connections[0].onversionchange?.();
  assert.equal(indexedDB.connections[0].closed, true);
  assert.equal((await storage.getCachedStores())[0].store_id, 'old');
  assert.equal(indexedDB.opens.length, 2);
});

test('unexpected database close is recovered on the next operation', async () => {
  const { storage, indexedDB } = load(); await storage.cacheStores(oldStores);
  const db = indexedDB.connections[0]; db.close(); db.onclose?.();
  assert.equal((await storage.getCachedStores())[0].store_id, 'old');
  assert.equal(indexedDB.opens.length, 2);
});

test('blocked open rejects promptly, late success closes abandoned connection, retry works', async () => {
  const { storage, indexedDB } = load(); indexedDB.blockNext = true;
  await assert.rejects(bounded(storage.getCurrentRoute()), /古い店舗アプリ/);
  const abandoned = indexedDB.opens[0]; abandoned.onsuccess({ target: abandoned });
  assert.equal(abandoned.result.closed, true);
  await storage.saveCurrentRoute({ name: 'retry' });
  assert.equal((await storage.getCurrentRoute()).name, 'retry');
});

test('open failure does not permanently poison later attempts', async () => {
  const { storage, indexedDB } = load(); indexedDB.openError = true;
  await assert.rejects(storage.getCurrentRoute(), { name: 'UnknownError' });
  await storage.saveCurrentRoute({ name: 'retry' });
  assert.equal((await storage.getCurrentRoute()).name, 'retry');
});

test('legacy queue insertion is atomic across tabs and returns the same queue key', async () => {
  const db = fixture(), a = load(db).storage, b = load(db).storage;
  // Initialize schema before opening the second fixture connection.
  await a.getPendingActions();
  const keys = await Promise.all([a.addPendingAction(action), b.addPendingAction(action)]);
  assert.equal(keys[0], keys[1]); assert.equal(typeof keys[0], 'number');
  assert.equal((await a.getPendingActions()).length, 1);
});

test('reservation clone failure is rejected, not committed as a successful reservation', async () => {
  const { storage } = load();
  await assert.rejects(bounded(storage.reservePendingAction({ ...action, invalid: () => {} })), { name: 'DataCloneError' });
  assert.equal((await storage.getPendingActions()).length, 0);
  await storage.reservePendingAction(action);
  assert.equal((await storage.getPendingActions()).length, 1);
});

test('online event handles unavailable storage without clearing or resending anything', async () => {
  const { indexedDB, events, warnings } = load(); indexedDB.openError = true;
  await events.online(); await tick();
  assert.equal(warnings.length, 1);
  assert.equal(indexedDB.stores.size, 0);
});

function loadApi(indexedDB = fixture(), values = new Map()) {
  const context = vm.createContext({
    indexedDB, URL, console, setTimeout, clearTimeout, AbortController,
    localStorage: { getItem: key => values.get(key) || '', setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    fetch: () => { throw Error('No network permitted in storage tests'); },
  });
  // Inspect only fixture credentials; do not expose this helper in production.
  const instrumented = apiSource.replace('    setUrl, getUrl,', '    getToken, setUrl, getUrl,');
  vm.runInContext(instrumented + '\nglobalThis.subject = API;', context);
  return { api: context.subject, indexedDB, values };
}

function loadPair(indexedDB = fixture()) {
  const context = vm.createContext({
    indexedDB, URLSearchParams,
    document: { getElementById: () => ({ classList: { add() {} } }) },
    location: { hash: '', pathname: '/pair.html' }, history: { replaceState() {} },
  });
  // Expose only local storage functions; invalid token exits before any API call.
  const instrumented = pairSource.replace('  if (token.length', '  globalThis.subject = { readCredential, writeCredential };\n  if (token.length');
  vm.runInContext(instrumented, context);
  return context.subject;
}

test('credential initialization can recover after one failed open without losing its key', async () => {
  const indexedDB = fixture(); indexedDB.openError = true;
  const values = new Map([['daniel_route_device_auth_v1', 'fixture-key-not-real']]);
  const { api } = loadApi(indexedDB, values);
  await assert.rejects(bounded(api.ready()), { code: 'CREDENTIAL_STORAGE_FAILED' });
  assert.equal(values.get('daniel_route_device_auth_v1'), 'fixture-key-not-real');
  await api.ready();
  assert.equal(api.getToken(), 'fixture-key-not-real');
  assert.equal(values.has('daniel_route_device_auth_v1'), false);
});

test('credential read abort cannot be accepted as verified migration', async () => {
  const indexedDB = fixture();
  const { api: first } = loadApi(indexedDB); await first.ready();
  await first.setToken('fixture-key-not-real');
  indexedDB.nextFailure = 'abortAfterRequests';
  const { api: second } = loadApi(indexedDB);
  await assert.rejects(bounded(second.ready()), { code: 'CREDENTIAL_STORAGE_FAILED' });
  assert.equal(second.hasToken(), false);
  await second.ready(); assert.equal(second.getToken(), 'fixture-key-not-real');
});

for (const event of ['onversionchange', 'onclose']) test(`credentials reopen after ${event} without reconnecting the account`, async () => {
  const { api, indexedDB } = loadApi(); await api.ready(); await api.setToken('old-fixture-key');
  const connection = indexedDB.connections[0];
  if (event === 'onclose') connection.close();
  connection[event]?.();
  assert.equal(connection.closed, true);
  await api.setToken('new-fixture-key');
  assert.equal(api.getToken(), 'new-fixture-key');
  assert.equal(indexedDB.opens.length, 2);
});

test('credential write abort retains previous cached and durable value', async () => {
  const { api, indexedDB } = loadApi(); await api.ready(); await api.setToken('old-fixture-key');
  indexedDB.nextFailure = 'abort';
  await assert.rejects(bounded(api.setToken('new-fixture-key')), /aborted/);
  assert.equal(api.getToken(), 'old-fixture-key');
  const reloaded = loadApi(indexedDB).api; await reloaded.ready();
  assert.equal(reloaded.getToken(), 'old-fixture-key');
});

test('QR credential reads and writes close every finished connection', async () => {
  const indexedDB = fixture(), pair = loadPair(indexedDB);
  await pair.writeCredential('fixture-key', 'fixture-value');
  assert.equal(await pair.readCredential('fixture-key'), 'fixture-value');
  assert.equal(indexedDB.connections.every(connection => connection.closed), true);
});

test('QR read abort rejects before accepting credentials and closes connection', async () => {
  const indexedDB = fixture(), pair = loadPair(indexedDB);
  await pair.writeCredential('fixture-key', 'fixture-value');
  indexedDB.nextFailure = 'abortAfterRequests';
  await assert.rejects(bounded(pair.readCredential('fixture-key')), /aborted/);
  assert.equal(indexedDB.connections.every(connection => connection.closed), true);
});

test('blocked QR open closes its late connection and permits a clean retry', async () => {
  const indexedDB = fixture(), pair = loadPair(indexedDB); indexedDB.blockNext = true;
  await assert.rejects(bounded(pair.readCredential('fixture-key')), /blocked/);
  const request = indexedDB.opens[0]; request.onsuccess({ target: request });
  assert.equal(request.result.closed, true);
  await pair.writeCredential('fixture-key', 'fixture-value');
  assert.equal(await pair.readCredential('fixture-key'), 'fixture-value');
});
