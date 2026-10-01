import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(here, name), 'utf8');
const app = read('app.js');
const api = read('api.js');
const storage = read('storage.js');
const sw = read('sw.js');
const pair = read('pair.html');
const pairScript = read('pair.js');
const bootstrap = read('bootstrap.js');
const index = read('index.html');
const style = read('style.css');
const gasPath = join(here, '..', 'gas', 'Code.gs');
const gas = existsSync(gasPath) ? readFileSync(gasPath, 'utf8') : '';

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} が見つかりません`);
  assert.notEqual(end, -1, `${nextName} が見つかりません`);
  return source.slice(start, end);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeIndexedDb(initial = {}) {
  const values = new Map(Object.entries(initial));
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const transaction = { oncomplete: null, onerror: null, onabort: null };
      const complete = () => queueMicrotask(() => transaction.oncomplete?.());
      transaction.objectStore = () => ({
        get(key) {
          const request = { result: undefined, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            request.result = values.has(key) ? { key, value: values.get(key) } : undefined;
            request.onsuccess?.();
            complete();
          });
          return request;
        },
        put(record) { values.set(record.key, String(record.value)); complete(); },
        delete(key) { values.delete(key); complete(); },
      });
      return transaction;
    },
  };
  return {
    values,
    indexedDB: {
      open() {
        const request = { result: database, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => request.onsuccess?.({ target: { result: database } }));
        return request;
      },
    },
  };
}

function createApiHarness({ initial = {}, initialCredentials = {}, fetchImpl } = {}) {
  const values = new Map(Object.entries(initial));
  const credentialDb = createFakeIndexedDb(initialCredentials);
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const context = {
    localStorage,
    indexedDB: credentialDb.indexedDB,
    crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    Storage: { async addPendingAction() {}, async reservePendingAction() { return { conflictId: '' }; }, async settlePendingAction() {} },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    window: { dispatchEvent() {} },
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(`${api}\nglobalThis.__api = API;`, context);
  return { API: context.__api, values, credentials: credentialDb.values };
}

function createAppConcurrencyHarness({ startRoute, updateStop, endRoute, pending = [], saveCurrentRoute, clearCurrentRoute } = {}) {
  const calls = { startRoute: [], updateStop: [], endRoute: [] };
  const buttons = new Map();
  ['btn-start-patrol', 'btn-confirm-route', 'btn-planned-start', 'btn-depart', 'btn-skip', 'btn-end']
    .forEach(id => buttons.set(id, {
      id,
      disabled: false,
      textContent: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener() {},
    }));
  const toastElement = {
    textContent: '',
    classList: { add() {}, remove() {} },
  };
  let savedCurrentRoute = null;
  let savedPlannedRoute = null;
  let operationSequence = 0;
  const storageMock = {
    async getCurrentRoute() { return savedCurrentRoute; },
    async saveCurrentRoute(value) { if (saveCurrentRoute) await saveCurrentRoute(value); savedCurrentRoute = structuredClone(value); return value; },
    async reserveRouteStart(value) {
      if (!savedCurrentRoute) savedCurrentRoute = value;
      return savedCurrentRoute;
    },
    async confirmRouteStart(operationId, value) {
      assert.equal(savedCurrentRoute.startOperationId, operationId);
      if (savedCurrentRoute.routeId === 'pending') savedCurrentRoute = value;
      return savedCurrentRoute;
    },
    async clearRejectedRouteStart(operationId) {
      if (savedCurrentRoute?.routeId === 'pending' && savedCurrentRoute.startOperationId === operationId) savedCurrentRoute = null;
    },
    async clearCurrentRoute() { if (clearCurrentRoute) await clearCurrentRoute(); savedCurrentRoute = null; },
    async getPendingActions() { return pending; },
    async getPlannedRoute() { return savedPlannedRoute; },
    async savePlannedRoute(value) { savedPlannedRoute = value; return value; },
    async cacheConfig() {},
    async cacheStores() {},
    async getCachedStores() { return []; },
    async getCachedConfig() { return {}; },
    async clearViewCache() {},
  };
  const apiMock = {
    createOperationId(prefix) { operationSequence += 1; return `${prefix}-test-${operationSequence}`; },
    async startRoute(payload) {
      calls.startRoute.push(payload);
      return startRoute ? startRoute(payload) : { route_id: 'route-1', start_time: '2026-08-01 06:00:00' };
    },
    async createStopUpdateRequest(payload) {
      return { ...payload, operation_id: `stop-test-${++operationSequence}`, expected_stop_revision: "a".repeat(64) };
    },
    async updateStop(payload) {
      calls.updateStop.push(payload);
      return updateStop ? updateStop(payload) : { updated: true };
    },
    async endRoute(payload) {
      calls.endRoute.push(payload);
      return endRoute ? endRoute(payload) : { route_id: payload.route_id, total_purchase:0, total_items:0 };
    },
    async updateConfig() { return { updated: true }; },
    async getStores() { return []; },
    async getConfig() { return {}; },
  };
  const navigations = [];
  const routerMock = {
    navigate(view, options) { navigations.push({ view, options }); },
    getCurrentView() { return navigations.at(-1)?.view || 'home'; },
  };
  const documentMock = {
    addEventListener() {},
    getElementById(id) { return id === 'toast' ? toastElement : buttons.get(id) || null; },
    createElement() { return { textContent: '', innerHTML: '' }; },
  };
  const exposedReturn = `return { init, loadData, toggleMapSelection, __test: {
    setOptimizedRoute(value) { optimizedRoute = value; },
    setPlannedRoute(value) { plannedRoute = value; optimizedRoute = value; },
    setPatrolState(value) { patrolState = value; },
    getPatrolState() { return patrolState; },
    getPendingStartState() { return pendingStartState; },
    getPlannedRoute() { return plannedRoute; },
    startPatrol,
    completeCurrentStop_,
    endPatrol,
  } };`;
  const instrumented = app.replace('return { init, loadData, toggleMapSelection };', exposedReturn);
  assert.notEqual(instrumented, app, 'テスト用公開口の差し込みに失敗しました');
  const context = {
    API: apiMock,
    Storage: storageMock,
    Router: routerMock,
    RouteOptimizer: { generateMapsUrl() { return ''; }, generateMapsSegments() { return []; } },
    document: documentMock,
    window: { addEventListener() {} },
    navigator: { onLine: true },
    console,
    URL,
    Intl,
    Date,
    Promise,
    Map,
    Set,
    structuredClone,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
  };
  vm.runInNewContext(`${instrumented}\nglobalThis.__routeApp = App;`, context);
  return {
    app: context.__routeApp.__test,
    calls,
    buttons,
    navigations,
    getSavedCurrentRoute: () => savedCurrentRoute,
    setSavedCurrentRoute: value => { savedCurrentRoute = value; },
    getToastText: () => toastElement.textContent,
  };
}

test('Google Mapsルートを4店舗以下の区間へ分割する', () => {
  const source = read('route-optimizer.js');
  const context = { globalThis: {} };
  vm.runInNewContext(`${source}\nglobalThis.RouteOptimizer = RouteOptimizer;`, context);
  const optimizer = context.globalThis.RouteOptimizer;
  const stores = Array.from({ length: 10 }, (_, index) => ({
    store_id: `s${index + 1}`,
    lat: 38 + index / 100,
    lng: 140 + index / 100,
  }));
  const segments = optimizer.generateMapsSegments({ lat: 38, lng: 140 }, stores);
  assert.equal(segments.length, 3);
  assert.deepEqual(Array.from(segments, segment => segment.stores.length), [4, 4, 2]);
  assert.deepEqual(Array.from(segments.flatMap(segment => segment.stores), store => store.store_id),
    stores.map(store => store.store_id));
  segments.forEach(segment => {
    const params = new URL(segment.url).searchParams;
    const waypoints = params.get('waypoints');
    assert.ok(!waypoints || waypoints.split('|').length <= 3);
    assert.ok(segment.url.length < 2048);
  });
});

test('店舗完了は固定した受付と時刻を保存してからGASへ送り、確認後だけ次へ進む', () => {
  const source = functionSource(app, 'completeCurrentStop_', 'startPatrolTimer');
  assert.match(source, /API\.createStopUpdateRequest\([\s\S]*arrival_time:[\s\S]*departure_time:/);
  assert.match(source, /queueOnFailure:\s*false/);
  assert.ok(source.indexOf('await Storage.saveCurrentRoute(patrolState)') < source.indexOf('await API.updateStop'));
  assert.ok(source.indexOf('await API.updateStop') < source.indexOf('patrolState.currentIdx = previousIdx + 1'));
  assert.match(source, /current.completionConfirmed = true/);
});

test('巡回開始operationIdを送信前に永続化し、同じIDで再確認する', () => {
  const source = functionSource(app, 'startPatrol', 'renderPatrol');
  assert.match(source, /startOperationId:\s*operationId/);
  assert.ok(source.indexOf('await Storage.reserveRouteStart(') < source.indexOf('confirmPendingRouteStart_(pending)'));
  const recovery = functionSource(app, 'confirmPendingRouteStart_', 'startPatrol');
  assert.match(recovery, /operation_id:\s*pending\.startOperationId/);
  assert.match(recovery, /startTime:\s*parseServerTimestamp_\(result\.start_time\) \|\| pending\.startTime \|\| Date\.now\(\)/);
  assert.match(app, /await Storage\.syncPending\(\)/);
});

test('予定ルート開始を並行実行してもstartRouteは1回だけ呼ぶ', async () => {
  const response = createDeferred();
  const harness = createAppConcurrencyHarness({ startRoute: () => response.promise });
  const planned = {
    orderedStores: [{ store_id: 's1', name: '確認店舗' }],
    totalDistanceKm: 12.3,
  };
  harness.app.setPlannedRoute(planned);

  const first = harness.app.startPatrol({ clearPlannedOnSuccess: true });
  const second = harness.app.startPatrol({ clearPlannedOnSuccess: true });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.calls.startRoute.length, 1);
  assert.equal(harness.buttons.get('btn-planned-start').disabled, true);
  assert.equal(harness.buttons.get('btn-planned-start').textContent, '巡回を開始しています...');
  response.resolve({ route_id: 'route-1', start_time: '2026-08-01 06:00:00' });
  await Promise.all([first, second]);

  assert.equal(harness.calls.startRoute.length, 1);
  assert.equal(harness.calls.startRoute[0].operation_id, 'startRoute-test-1');
  assert.equal(harness.buttons.get('btn-planned-start').disabled, false);
});

test('巡回開始の確定エラーは保留を消し、予定ルートを残す', async () => {
  const rejected = new Error('Unknown or inactive store_id: s1');
  rejected.code = 'API_ERROR';
  const harness = createAppConcurrencyHarness({ startRoute: async () => { throw rejected; } });
  const planned = {
    orderedStores: [{ store_id: 's1', name: '休止中の店舗' }],
    totalDistanceKm: 8.5,
  };
  harness.app.setPlannedRoute(planned);

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });

  assert.equal(harness.calls.startRoute.length, 1);
  assert.equal(harness.app.getPendingStartState(), null);
  assert.equal(harness.getSavedCurrentRoute(), null);
  assert.equal(harness.app.getPlannedRoute(), planned);
  assert.match(harness.getToastText(), /巡回を開始できませんでした/);
  assert.match(harness.getToastText(), /予定ルートは残しています/);

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });
  assert.equal(harness.calls.startRoute.length, 2);
  assert.notEqual(
    harness.calls.startRoute[0].operation_id,
    harness.calls.startRoute[1].operation_id,
    '利用者が改めて開始した場合は新しいIDを使います'
  );
});

test('巡回開始の一時エラーは同じoperationIdで結果を再確認する', async () => {
  let attempt = 0;
  const harness = createAppConcurrencyHarness({
    startRoute: async () => {
      attempt += 1;
      if (attempt === 1) {
        const busy = new Error('別の更新処理が実行中です');
        busy.code = 'BUSY';
        throw busy;
      }
      return { route_id: 'route-1', start_time: '2026-08-01 06:00:00' };
    },
  });
  harness.app.setPlannedRoute({
    orderedStores: [{ store_id: 's1', name: '確認店舗' }],
    totalDistanceKm: 9.2,
  });

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });
  const pending = harness.getSavedCurrentRoute();
  assert.equal(pending.routeId, 'pending');
  assert.equal(harness.app.getPendingStartState().startOperationId, pending.startOperationId);
  assert.match(harness.getToastText(), /同じ内容で再確認できます/);

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });
  assert.equal(harness.calls.startRoute.length, 2);
  assert.equal(harness.calls.startRoute[0].operation_id, harness.calls.startRoute[1].operation_id);
  assert.equal(harness.app.getPatrolState().routeId, 'route-1');
});

test('Safari系の通信エラーも同じoperationIdで結果を再確認する', async () => {
  let attempt = 0;
  const harness = createAppConcurrencyHarness({
    startRoute: async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('The Internet connection appears to be offline.');
      return { route_id: 'route-1', start_time: '2026-08-01 06:00:00' };
    },
  });
  harness.app.setPlannedRoute({
    orderedStores: [{ store_id: 's1', name: '確認店舗' }],
    totalDistanceKm: 9.2,
  });

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });
  const pending = harness.getSavedCurrentRoute();
  assert.equal(pending.routeId, 'pending');

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });
  assert.equal(harness.calls.startRoute.length, 2);
  assert.equal(harness.calls.startRoute[0].operation_id, harness.calls.startRoute[1].operation_id);
  assert.equal(harness.app.getPatrolState().routeId, 'route-1');
});

test('他タブで開始済みの巡回は新しい保留データで上書きしない', async () => {
  const harness = createAppConcurrencyHarness();
  const existingPatrol = {
    routeId: 'route-existing',
    startTime: Date.now(),
    currentIdx: 0,
    stops: [{ store_id: 's-existing', name: '開始済み店舗', status: 'visiting' }],
  };
  harness.setSavedCurrentRoute(existingPatrol);
  harness.app.setPlannedRoute({
    orderedStores: [{ store_id: 's-new', name: '新しい予定店舗' }],
    totalDistanceKm: 5.4,
  });

  await harness.app.startPatrol({ clearPlannedOnSuccess: true });

  assert.equal(harness.calls.startRoute.length, 0);
  assert.equal(harness.getSavedCurrentRoute(), existingPatrol);
  assert.equal(harness.app.getPatrolState(), existingPatrol);
  assert.equal(harness.navigations.at(-1).view, 'patrol');
  assert.match(harness.getToastText(), /開始済みの巡回を開きました/);
});

test('店舗保存中のスキップと手動終了はAPIを追加で呼ばない', async () => {
  const response = createDeferred();
  const harness = createAppConcurrencyHarness({ updateStop: () => response.promise });
  harness.app.setPatrolState({
    routeId: 'route-1',
    startTime: Date.now(),
    currentIdx: 0,
    stops: [{
      store_id: 's1',
      name: '確認店舗',
      status: 'visiting',
      arrivalTime: new Date().toISOString(),
      departureTime: null,
      purchaseAmount: 0,
      purchaseItems: 0,
    }],
  });

  const completing = harness.app.completeCurrentStop_('visited');
  const skipped = harness.app.completeCurrentStop_('skipped');
  const ended = harness.app.endPatrol();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.calls.updateStop.length, 1);
  assert.equal(harness.calls.endRoute.length, 0);
  ['btn-depart', 'btn-skip', 'btn-end'].forEach(id => {
    assert.equal(harness.buttons.get(id).disabled, true, `${id} が無効になっていません`);
  });

  response.resolve({ updated: true });
  await Promise.all([completing, skipped, ended]);
  assert.equal(harness.calls.updateStop.length, 1);
  assert.equal(harness.calls.endRoute.length, 1, '最終店舗保存後の内部終了だけを許可します');
  assert.equal(harness.app.getPatrolState(), null);
});

test('メモAPIと認証失敗時の保存内容維持が接続されている', () => {
  assert.match(api, /addMemo:\s*\(b\)\s*=>\s*post\('addMemo'/);
  assert.match(app, /const result = await API\.addMemo/);
  assert.ok(app.indexOf('const result = await API.addMemo') < app.indexOf("toast('メモを保存しました')"));
  assert.match(api, /api-auth-error/);
  const authFailure = functionSource(app, 'handleApiAuthError_', 'setupNav');
  assert.doesNotMatch(authFailure, /clearRemoteCaches|clearDeviceCredential|setToken\(['"]{2}\)/);
  assert.match(authFailure, /保存内容は消さずに残しています/);
  assert.match(storage, /async function clearRemoteCaches/);
  assert.match(api, /getCanonicalUrl/);
  assert.match(api, /isValidUrl\(storedBaseUrl\) \? storedBaseUrl : CANONICAL_GAS_API_URL/);
  assert.match(app, /API\.isValidUrl\(oldUrl\) \? oldUrl : API\.getCanonicalUrl\(\)/);
});

test('旧localStorageの接続コードは端末鍵へ一度だけ移行して安全領域からも削除する', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    return {
      async text() {
        return JSON.stringify({
          success: true,
          data: { registered: true, device_id: body.device_id },
        });
      },
    };
  };
  const first = createApiHarness({
    initial: { daniel_api_auth_token: 'p'.repeat(40) },
    fetchImpl,
  });
  assert.equal(await first.API.ensureDeviceCredential(), true);
  assert.equal(calls, 1);
  assert.ok(first.credentials.get('daniel_route_device_auth_v1'));
  assert.equal(first.credentials.has('daniel_api_auth_token'), false);
  assert.equal(first.values.has('daniel_api_auth_token'), false);
  assert.equal(first.values.has('daniel_route_device_auth_v1'), false);
  assert.equal(await first.API.ensureDeviceCredential(), true);
  assert.equal(calls, 1, '端末鍵がある起動では再登録しません');
});

test('新しい接続コードの失敗は既存端末鍵と移行情報を消さない', async () => {
  const previous = 'route_dev_' + 'a'.repeat(50);
  const harness = createApiHarness({
    initial: { daniel_route_device_id_v1: 'route_existing_device_01' },
    initialCredentials: {
      daniel_route_device_auth_v1: previous,
      daniel_api_auth_token: 'l'.repeat(40),
    },
    fetchImpl: async () => ({
      async text() { return JSON.stringify({ success: false, error: 'UNAUTHORIZED: bad' }); },
    }),
  });
  await assert.rejects(harness.API.pairDevice('x'.repeat(40)), /bad/);
  assert.equal(harness.credentials.get('daniel_route_device_auth_v1'), previous);
  assert.equal(harness.credentials.get('daniel_api_auth_token'), 'l'.repeat(40));
  assert.ok(harness.credentials.get('daniel_route_pending_device_auth_v1'));
});

test('GASはpairing・service・deviceの用途を分離し、登録と回転を同じロックで守る', { skip: !gas }, () => {
  const register = functionSource(gas, 'registerDeviceCredential_', 'isRouteDeviceRegistrationAuthorized_');
  assert.match(register, /LockService\.getScriptLock\(\)/);
  assert.match(register, /isMercariDeviceRegistrationAuthorized_|isRouteDeviceRegistrationAuthorized_/);
  assert.ok(register.indexOf('tryLock') < register.indexOf('isMercariDeviceRegistrationAuthorized_'));
  assert.ok(register.indexOf('isRouteDeviceRegistrationAuthorized_') < register.indexOf('writeDeviceAuthRecords_'));
  const normal = functionSource(gas, 'isAuthorized_', 'isMercariActionAuthorized_');
  assert.match(normal, /API_DEVICE_AUTH_PROPERTY/);
  assert.doesNotMatch(normal, /DEVICE_PAIRING|API_AUTH_HASH_PROPERTY/);
  const mercari = functionSource(gas, 'isMercariActionAuthorized_', 'isAuthorizedForAction_');
  assert.match(mercari, /MERCARI_SERVICE_ACTIONS[\s\S]*MERCARI_API_AUTH_HASH_PROPERTY/);
  assert.match(mercari, /MERCARI_DEVICE_ACTIONS[\s\S]*MERCARI_DEVICE_AUTH_PROPERTY/);
  assert.match(gas, /getMercariPairingConfig/);
  assert.match(gas, /trycloudflare\\\.com/);
  assert.match(gas, /previousExpiresAt/);
});

test('QR接続はコードを即時非表示にし、通信停止を15秒で打ち切って再試行できる', () => {
  assert.match(pairScript, /history\.replaceState/);
  assert.match(pairScript, /new AbortController\(\)/);
  assert.match(pairScript, /timeoutMs = 15000/);
  assert.match(pair, /id="pair-retry"/);
});

test('CSPは同一配信元の外部scriptだけを許可し、inline handlerを残さない', () => {
  for (const [name, html] of [['index.html', index], ['pair.html', pair]]) {
    const policy = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
    assert.match(policy, /script-src 'self'/, `${name} のscript-srcが厳格ではありません`);
    const scriptDirective = (policy.match(/script-src ([^;]+)/) || [])[1] || '';
    assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name} にinline scriptがあります`);
  }
  [app, read('quiz.js'), pairScript].forEach(source => {
    assert.doesNotMatch(source, /\son(?:click|error)\s*=/i);
  });
  assert.match(bootstrap, /addEventListener\('error'/);
  assert.match(style, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('端末鍵はIndexedDBへ移しlocalStorageへ新規保存せず、外部APIにも公開しない', () => {
  assert.match(api, /CREDENTIAL_DB_NAME = 'sedori-route-credentials'/);
  assert.match(api, /initializeCredentials_/);
  assert.doesNotMatch(api, /localStorage\.setItem\((?:PAIRING_CODE_KEY|DEVICE_TOKEN_KEY|PENDING_DEVICE_TOKEN_KEY)/);
  assert.doesNotMatch(pairScript, /localStorage\.setItem\((?:pairingKey|deviceTokenKey|pendingTokenKey)/);
  const apiSurface = api.slice(api.lastIndexOf('return {'));
  assert.doesNotMatch(apiSurface, /\bgetToken\b/);
});

test('地図ポップアップはstore_idをHTML文字列やinline onclickへ埋め込まない', () => {
  const popup = functionSource(app, 'buildMapPopupElement', 'buildStoreVisitInfoFromRoutes_');
  assert.match(popup, /textContent = String\(s\.name/);
  assert.match(popup, /button\.addEventListener\('click'/);
  assert.doesNotMatch(popup, /innerHTML|onclick|`<|\$\{s\.store_id\}/);
  assert.doesNotMatch(app, /buildMapPopupHtml/);
});

test('古い未送信操作は自動再送せず、後続も追い越さない', () => {
  assert.match(storage, /MAX_AUTO_RETRY_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(storage, /MAX_AUTO_RETRY_ATTEMPTS = 12/);
  const blocking = functionSource(storage, 'pendingActionBlockReason_', 'getPendingQueueStatus').replace(/\s*async\s*$/, '');
  const context = {};
  vm.runInNewContext(`const MAX_AUTO_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; const MAX_AUTO_RETRY_ATTEMPTS = 12;\n${blocking}\nglobalThis.reason = pendingActionBlockReason_;`, context);
  assert.match(context.reason({ timestamp: Date.now() - 8 * 86400000, attempts: 0 }), /7日以上前/);
  assert.match(context.reason({ timestamp: Date.now(), attempts: 12 }), /上限/);
  assert.equal(context.reason({ timestamp: Date.now(), attempts: 0 }), '');
  const sync = functionSource(storage, 'syncPending', 'clearRemoteCaches');
  assert.match(sync, /if \(blockedReason\)[\s\S]*break;/);
});

test('GASはstartRouteの全検証後に追加し、履歴変更後に統計とキャッシュを更新する', { skip: !gas }, () => {
  const start = functionSource(gas, 'startRoute_', 'updateStop_');
  assert.ok(start.indexOf('operation_id is required') < start.indexOf('routeSheet.getRange(routeStartRow'));
  assert.ok(start.indexOf('Unknown or inactive store_id') < start.indexOf('routeSheet.getRange(routeStartRow'));
  assert.match(start, /catch \(error\)[\s\S]*deleteRows[\s\S]*deleteRow/);

  const deletion = functionSource(gas, 'deleteRoute_', 'previewStoreVisitStatsRepair');
  assert.match(deletion, /recomputeAllStoreVisitStats_\(\)/);
  assert.match(deletion, /clearStoresCache_\(\)/);
  const clearing = functionSource(gas, 'clearHistory_', 'updatePriorityScores_');
  assert.match(clearing, /recomputeAllStoreVisitStats_\(\)/);
  assert.match(clearing, /clearStoresCache_\(\)/);
  const daily = functionSource(gas, 'dailyProfitImport', 'setupDailyProfitImport');
  assert.match(daily, /recomputeAllStoreVisitStats_\(\)/);
  assert.match(daily, /clearStoresCache_\(\)/);
});

test('GASの店舗訪問集計はvisitedだけを数える', { skip: !gas }, () => {
  const predicate = functionSource(gas, 'isStopCountedAsStoreVisit_', 'normalizeStopStatus_');
  const normalize = functionSource(gas, 'normalizeStopStatus_', 'backupStoresSheetForVisitRepair_');
  const context = {};
  vm.runInNewContext(`${predicate}\n${normalize}\nglobalThis.isCounted = isStopCountedAsStoreVisit_;`, context);

  assert.equal(context.isCounted({ status: 'visited' }), true);
  ['planned', 'visiting', 'skipped', '', null, undefined].forEach(status => {
    assert.equal(context.isCounted({ status }), false, `${String(status)} が訪問として数えられました`);
  });
});

test('全チェーン画像をService Workerへ登録する', () => {
  const icons = readdirSync(join(here, 'icons', 'chains')).filter(name => name.endsWith('.png'));
  assert.ok(icons.length > 0);
  icons.forEach(name => assert.ok(sw.includes(`./icons/chains/${name}`), `${name} が未登録です`));
});

function recoveryRoute(overrides = {}) {
  return { routeId:'route-1',startTime:Date.now(),currentIdx:0,
    stops:[{store_id:'s1',name:'復旧テスト店舗',status:'visiting',arrivalTime:'2026-10-01T11:00:00Z',purchaseAmount:0,purchaseItems:0}],...overrides };
}

test('最終店舗保存後に終了が失敗しても店舗と位置を戻さず、再操作は同じ終了受付だけ確認', async () => {
  let attempt=0;
  const harness=createAppConcurrencyHarness({endRoute:async payload=>{
    if(++attempt===1)throw new TypeError('response lost');
    return {route_id:payload.route_id,total_purchase:0,total_items:0};
  }});
  harness.app.setPatrolState(recoveryRoute());
  await harness.app.completeCurrentStop_('visited');
  const saved=harness.getSavedCurrentRoute();
  assert.equal(saved.currentIdx,1);assert.equal(saved.stops[0].status,'visited');
  assert.equal(saved.stops[0].completionConfirmed,true);
  assert.equal(harness.buttons.get('btn-depart').textContent,'終了結果を確認');
  assert.equal(harness.buttons.get('btn-skip').disabled,true);
  await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.updateStop.length,1);
  assert.equal(harness.calls.endRoute.length,2);
  assert.equal(harness.calls.endRoute[0].operation_id,harness.calls.endRoute[1].operation_id);
  assert.equal(harness.app.getPatrolState(),null);
});

test('画像の旧版状態は店舗を保存し直さず、保存済みendOperationIdで終了を確認', async () => {
  const harness=createAppConcurrencyHarness();
  const state=recoveryRoute({endOperationId:'endRoute-existing'});state.stops[0].status='visited';
  harness.app.setPatrolState(state);
  await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.updateStop.length,0);
  assert.equal(harness.calls.endRoute[0].operation_id,'endRoute-existing');
  assert.equal(harness.app.getPatrolState(),null);
});

test('旧版の終了受付だけ残った端末も新しい受付を作らず復旧する', async () => {
  const harness=createAppConcurrencyHarness({pending:[{action:'endRoute',operation_id:'old-end',body:{route_id:'route-1',operation_id:'old-end'}}]});
  harness.app.setPatrolState(recoveryRoute());await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.updateStop.length,0);assert.equal(harness.calls.endRoute[0].operation_id,'old-end');
});

test('途中店舗の応答が消えても再操作でID・時刻・変更前状態を変えない', async () => {
  let attempt=0;
  const harness=createAppConcurrencyHarness({updateStop:async()=>{if(++attempt===1)throw new TypeError('lost');return {updated:true}}});
  harness.app.setPatrolState(recoveryRoute({stops:[...recoveryRoute().stops,{store_id:'s2',status:'planned'}]}));
  await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.app.getPatrolState().currentIdx,0);
  const saved=harness.getSavedCurrentRoute();
  harness.app.setPatrolState(saved); // Reload before deliberate retry.
  await harness.app.completeCurrentStop_('visited');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.updateStop[0])),JSON.parse(JSON.stringify(harness.calls.updateStop[1])));
  assert.equal(harness.app.getPatrolState().currentIdx,1);
});

test('旧版の店舗受付を保存結果の確認に使い、新しい操作IDを作らない', async () => {
  const body={route_id:'route-1',store_id:'s1',operation_id:'existing-stop',status:'visited',arrival_time:'old-arrival',departure_time:'old-departure',expected_stop_revision:'a'.repeat(64)};
  const harness=createAppConcurrencyHarness({pending:[{action:'updateStop',operation_id:'existing-stop',body}]});
  harness.app.setPatrolState(recoveryRoute());await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.updateStop[0],body);
});

test('端末保存失敗はネット送信を止め、確認済み店舗は端末復旧後も再送しない', async () => {
  let failBefore=true;
  const before=createAppConcurrencyHarness({saveCurrentRoute:async()=>{if(failBefore)throw Error('disk full')}});
  before.app.setPatrolState(recoveryRoute());await before.app.completeCurrentStop_('visited');
  assert.equal(before.calls.updateStop.length,0);failBefore=false;
  await before.app.completeCurrentStop_('visited');assert.equal(before.calls.updateStop.length,1);
  let failAfter=true;
  const after=createAppConcurrencyHarness({saveCurrentRoute:async state=>{if(state.currentIdx===1 && failAfter)throw Error('disk full')}});
  after.app.setPatrolState(recoveryRoute());await after.app.completeCurrentStop_('visited');
  assert.equal(after.app.getPatrolState().stops[0].completionConfirmed,true);
  failAfter=false;await after.app.completeCurrentStop_('visited');
  assert.equal(after.calls.updateStop.length,1);assert.equal(after.app.getPatrolState(),null);
});

test('終了の端末整理だけ失敗した場合は成功応答を保持してネット再送せず整理を再試行', async () => {
  let blocked=true;
  const harness=createAppConcurrencyHarness({clearCurrentRoute:async()=>{if(blocked)throw Error('cleanup failed')}});
  harness.app.setPatrolState(recoveryRoute());await harness.app.completeCurrentStop_('visited');
  assert.ok(harness.app.getPatrolState().endResult);blocked=false;
  await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.endRoute.length,1);assert.equal(harness.calls.updateStop.length,1);
  assert.equal(harness.app.getPatrolState(),null);
});

test('仕入れ集計の確認待ちを店舗完了と取り違えず、確認してから別受付で完了を送る', async () => {
  const pending=[{action:'updateStop',operation_id:'aggregate',body:{route_id:'route-1',store_id:'s1',status:'visiting',operation_id:'aggregate',expected_stop_revision:'a'.repeat(64)}}];
  const harness=createAppConcurrencyHarness({pending,updateStop:async body=>{
    if(body.operation_id==='aggregate')pending.splice(0);
    return {updated:true};
  }});
  harness.app.setPatrolState(recoveryRoute());await harness.app.completeCurrentStop_('visited');
  assert.equal(harness.calls.updateStop.length,2);
  assert.equal(harness.calls.updateStop[0].operation_id,'aggregate');
  assert.notEqual(harness.calls.updateStop[1].operation_id,'aggregate');
  assert.equal(harness.calls.updateStop[1].status,'visited');
});
