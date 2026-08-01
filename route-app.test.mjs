import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
const gas = readFileSync(join(here, '..', 'gas', 'Code.gs'), 'utf8');

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

function createApiHarness({ initial = {}, fetchImpl } = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const context = {
    localStorage,
    crypto: webcrypto,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    Storage: { async addPendingAction() {} },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    window: { dispatchEvent() {} },
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(`${api}\nglobalThis.__api = API;`, context);
  return { API: context.__api, values };
}

function createAppConcurrencyHarness({ startRoute, updateStop, endRoute } = {}) {
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
    async saveCurrentRoute(value) { savedCurrentRoute = value; return value; },
    async clearCurrentRoute() { savedCurrentRoute = null; },
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
    async updateStop(payload) {
      calls.updateStop.push(payload);
      return updateStop ? updateStop(payload) : { updated: true };
    },
    async endRoute(payload) {
      calls.endRoute.push(payload);
      return endRoute ? endRoute(payload) : { route_id: payload.route_id };
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

test('店舗完了はGAS保存を待ち、時刻を送り、失敗時に位置を戻す', () => {
  const source = functionSource(app, 'completeCurrentStop_', 'startPatrolTimer');
  assert.match(source, /await API\.updateStop\([\s\S]*arrival_time:[\s\S]*departure_time:/);
  assert.match(source, /queueOnFailure:\s*false/);
  assert.ok(source.indexOf('await API.updateStop') < source.indexOf('patrolState.currentIdx += 1'));
  assert.match(source, /patrolState\.currentIdx = previous\.currentIdx/);
  assert.ok(source.indexOf('await API.updateStop') < source.indexOf('await endPatrol'));
});

test('巡回開始operationIdを送信前に永続化し、同じIDで再確認する', () => {
  const source = functionSource(app, 'startPatrol', 'renderPatrol');
  assert.match(source, /startOperationId:\s*operationId/);
  assert.ok(source.indexOf('await Storage.saveCurrentRoute(pending)') < source.indexOf('confirmPendingRouteStart_(pending)'));
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
  await Promise.resolve();

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

test('旧共有コードは一度だけ端末鍵へ移行し、両PWA完了後だけ削除する', async () => {
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
  assert.ok(first.values.get('daniel_route_device_auth_v1'));
  assert.equal(first.values.get('daniel_api_auth_token'), 'p'.repeat(40));
  assert.equal(await first.API.ensureDeviceCredential(), true);
  assert.equal(calls, 1, '端末鍵がある起動では再登録しません');

  const both = createApiHarness({
    initial: {
      daniel_api_auth_token: 'q'.repeat(40),
      mercari_device_auth_v1: 'm'.repeat(40),
    },
    fetchImpl,
  });
  await both.API.ensureDeviceCredential();
  assert.equal(both.values.has('daniel_api_auth_token'), false);
});

test('新しい接続コードの失敗は既存端末鍵と移行情報を消さない', async () => {
  const previous = 'route_dev_' + 'a'.repeat(50);
  const harness = createApiHarness({
    initial: {
      daniel_route_device_id_v1: 'route_existing_device_01',
      daniel_route_device_auth_v1: previous,
      daniel_api_auth_token: 'l'.repeat(40),
    },
    fetchImpl: async () => ({
      async text() { return JSON.stringify({ success: false, error: 'UNAUTHORIZED: bad' }); },
    }),
  });
  await assert.rejects(harness.API.pairDevice('x'.repeat(40)), /bad/);
  assert.equal(harness.values.get('daniel_route_device_auth_v1'), previous);
  assert.equal(harness.values.get('daniel_api_auth_token'), 'l'.repeat(40));
  assert.ok(harness.values.get('daniel_route_pending_device_auth_v1'));
});

test('GASはpairing・service・deviceの用途を分離し、登録と回転を同じロックで守る', () => {
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
  assert.match(pair, /history\.replaceState/);
  assert.match(pair, /new AbortController\(\)/);
  assert.match(pair, /timeoutMs = 15000/);
  assert.match(pair, /id="pair-retry"/);
});

test('GASはstartRouteの全検証後に追加し、履歴変更後に統計とキャッシュを更新する', () => {
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

test('GASの店舗訪問集計はvisitedだけを数える', () => {
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
