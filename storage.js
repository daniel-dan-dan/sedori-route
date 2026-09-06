// ============================================================
// オフラインストレージ（IndexedDB + 同期キュー）
// ============================================================

const Storage = (() => {
  const DB_NAME = 'sedori-route';
  const DB_VERSION = 2;
  const MAX_AUTO_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_AUTO_RETRY_ATTEMPTS = 12;
  let db = null;
  let syncInFlight = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('stores'))
          d.createObjectStore('stores', { keyPath: 'store_id' });
        if (!d.objectStoreNames.contains('config'))
          d.createObjectStore('config', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('pendingActions'))
          d.createObjectStore('pendingActions', { autoIncrement: true });
        if (!d.objectStoreNames.contains('currentRoute'))
          d.createObjectStore('currentRoute', { keyPath: 'id' });
        // v2: タブ表示データの永続キャッシュ（起動直後から即表示するため）
        if (!d.objectStoreNames.contains('viewCache'))
          d.createObjectStore('viewCache', { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function putAll(storeName, items) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    items.forEach(item => store.put(item));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function replaceAll(storeName, items) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    items.forEach(item => store.put(item));
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const d = await open();
    const tx = d.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function put(storeName, item) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function putWithKey(storeName, key, item) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item, key);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const d = await open();
    const tx = d.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function clear(storeName) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function del(storeName, key) {
    const d = await open();
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  // 同期キュー
  async function addPendingAction(actionObj) {
    const operationId = String(actionObj?.operation_id || actionObj?.body?.operation_id || '');
    if (!operationId) throw new Error('operation_id is required for offline queue');
    if (operationId) {
      const existing = await getPendingActions();
      if (existing.some(item => String(item.operation_id || item.body?.operation_id || '') === operationId)) {
        return existing.find(item => String(item.operation_id || item.body?.operation_id || '') === operationId)._queueKey;
      }
    }
    const d = await open();
    const tx = d.transaction('pendingActions', 'readwrite');
    tx.objectStore('pendingActions').add({
      ...actionObj,
      operation_id: operationId,
      timestamp: Number(actionObj?.timestamp) || Date.now(),
      attempts: Math.max(0, Number(actionObj?.attempts) || 0),
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getPendingActions() {
    const d = await open();
    const tx = d.transaction('pendingActions', 'readonly');
    const store = tx.objectStore('pendingActions');
    return new Promise((resolve, reject) => {
      const rows = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(rows);
        rows.push({ ...cursor.value, _queueKey: cursor.primaryKey });
        cursor.continue();
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function clearPendingActions() {
    return clear('pendingActions');
  }

  function pendingActionsConflict_(left, right) {
    const shops = new Set(['updateInventoryShop', 'bulkUpdateInventoryShop']);
    const uuids = item => (item.action === 'bulkUpdateInventoryShop' ? item.body?.items || [] : [item.body || {}]).map(value => value.inventory_uuid).filter(Boolean);
    if (shops.has(left.action) && shops.has(right.action)) {
      const existing = new Set(uuids(left));
      return uuids(right).some(uuid => existing.has(uuid));
    }
    if (left.action !== right.action) return false;
    if (left.action === 'updateAmazonPricingPreference') return String(left.body?.sku || '') === String(right.body?.sku || '');
    if (left.action === 'addInventoryPurchase') {
      return ['product_name', 'purchase_date', 'store_id', 'store_name'].every(key => String(left.body?.[key] || '').trim() === String(right.body?.[key] || '').trim());
    }
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') return Object.keys(value).filter(key => !['operation_id', 'auth_token'].includes(key)).sort().map(key => [key, canonical(value[key])]);
      return value;
    }
    return JSON.stringify(canonical(left.body || {})) === JSON.stringify(canonical(right.body || {}));
  }

  // 読取と追加を同一readwrite transaction内に置き、別タブ・同時押しにも対応する。
  async function reservePendingAction(actionObj) {
    const d = await open();
    const tx = d.transaction('pendingActions', 'readwrite');
    const store = tx.objectStore('pendingActions');
    let conflictId = '';
    const request = store.getAll();
    request.onsuccess = () => {
      const rows = request.result || [];
      const conflict = rows.find(item => String(item.operation_id || item.body?.operation_id || '') !== actionObj.operation_id && pendingActionsConflict_(item, actionObj));
      if (conflict) { conflictId = String(conflict.operation_id || conflict.body?.operation_id || '旧受付'); return; }
      if (!rows.some(item => String(item.operation_id || item.body?.operation_id || '') === actionObj.operation_id)) store.add(actionObj);
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ conflictId });
      tx.onerror = event => reject(event.target.error);
      tx.onabort = event => reject(event.target.error || new Error('受付IDを端末に保存できません'));
    });
  }

  async function settlePendingAction(operationId, update) {
    const action = (await getPendingActions()).find(item => String(item.operation_id || item.body?.operation_id || '') === operationId);
    if (!action) return;
    // 成功応答を先に永続化。キュー消去に失敗しても同じ受付IDの記録は1件だけ残る。
    if (update.remove && Object.hasOwn(update, 'result') && action.action === 'addInventoryPurchase') {
      const result = update.result && typeof update.result === 'object' ? update.result : {};
      const registered = Number.isInteger(Number(result.row)) && Number(result.row) > 0;
      await put('currentRoute', {
        id: 'inventory-receipt-' + operationId,
        operation_id: operationId,
        body: action.body,
        status: registered ? 'registered' : 'review',
        reason: registered ? '' : '応答は受信しましたが、在庫の登録先を確認できません。再登録せず受付情報をご確認ください',
        row: Number(result.row) || null,
        inventory_uuid: String(result.inventory_uuid || ''),
        timestamp: action.timestamp,
        confirmedAt: Date.now(),
      });
    }
    if (update.remove) await del('pendingActions', action._queueKey);
    else await putWithKey('pendingActions', action._queueKey, { ...action, ...update, _queueKey: undefined });
    window.dispatchEvent(new CustomEvent('inventory-status-changed'));
  }

  async function getInventoryReceiptStatus(routeId = '') {
    const records = (await getAll('currentRoute')).filter(item => String(item.id || '').startsWith('inventory-receipt-'));
    const receipts = new Map(records.map(item => [item.operation_id, item]));
    const actions = await getPendingActions();
    for (const action of actions) {
      if (action.action !== 'addInventoryPurchase' || receipts.has(action.operation_id)) continue;
      const reason = pendingActionBlockReason_(action);
      receipts.set(action.operation_id, { ...action, status: reason ? 'review' : 'pending', reason });
    }
    return [...receipts.values()]
      .filter(item => !routeId || String(item.body?.route_id || '') === String(routeId))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  }

  function savePurchaseDraft(key, data) { return put('currentRoute', { id: 'purchase-draft-' + key, data }); }
  function getPurchaseDraft(key) { return get('currentRoute', 'purchase-draft-' + key); }
  function clearPurchaseDraft(key) { return del('currentRoute', 'purchase-draft-' + key); }

  function pendingActionBlockReason_(action, now = Date.now()) {
    if (action?.last_error_code === 'OPERATION_OUTCOME_UNKNOWN') return '保存結果が不明です。受付IDを確認してから個別に処理してください';
    if (['API_ERROR', 'PENDING_OPERATION_EXISTS'].includes(action?.last_error_code)) return '入力内容または先行する受付の確認が必要なため自動再送を停止しました';
    const createdAt = Number(action?.timestamp);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return '作成時刻を確認できません';
    if (now - createdAt > MAX_AUTO_RETRY_AGE_MS) return '7日以上前のため自動再送を停止しました';
    if (Number(action?.attempts || 0) >= MAX_AUTO_RETRY_ATTEMPTS) return '再送回数が上限に達しました';
    return '';
  }

  async function getPendingQueueStatus() {
    const actions = await getPendingActions();
    const now = Date.now();
    const blocked = actions.filter(action => pendingActionBlockReason_(action, now));
    const oldestAt = actions.reduce((oldest, action) => {
      const value = Number(action?.timestamp);
      if (!Number.isFinite(value) || value <= 0) return oldest;
      return oldest === 0 ? value : Math.min(oldest, value);
    }, 0);
    return {
      total: actions.length,
      blocked: blocked.length,
      oldestAt,
      blockedReasons: [...new Set(blocked.map(action => pendingActionBlockReason_(action, now)))],
    };
  }

  function notifyPendingBlocked_(action, reason) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('pending-action-blocked', {
      detail: {
        operationId: String(action?.operation_id || action?.body?.operation_id || ''),
        reason,
      },
    }));
  }

  // オンライン復帰時に同期
  async function syncPending() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      if (!API.hasToken() || (typeof navigator !== 'undefined' && !navigator.onLine)) return 0;
      const actions = await getPendingActions();
      if (actions.length === 0) return 0;
      let synced = 0;
      for (const act of actions) {
        const blockedReason = pendingActionBlockReason_(act);
        if (blockedReason) {
          if (act.blocked_reason !== blockedReason) {
            await putWithKey('pendingActions', act._queueKey, {
              ...act,
              _queueKey: undefined,
              blocked_reason: blockedReason,
              blocked_at: Date.now(),
            });
          }
          notifyPendingBlocked_(act, blockedReason);
          // Price-review preferences do not depend on purchase/route writes.
          // Keep their uncertain receipt, but do not freeze unrelated work.
          if (act.action === 'updateAmazonPricingPreference') continue;
          // 書込順序を守るため、この項目より後も自動送信しない。
          break;
        }
        try {
          await API.post(act.action, {
            ...(act.body || {}),
            operation_id: act.operation_id || act.body?.operation_id
          }, { queueOnFailure: false });
          await del('pendingActions', act._queueKey);
          synced++;
        } catch (e) {
          console.warn('Sync failed:', e);
          const attempts = Number(act.attempts || 0) + 1;
          await putWithKey('pendingActions', act._queueKey, {
            ...act,
            _queueKey: undefined,
            attempts,
            last_error: String(e.message || e),
            last_error_code: String(e.code || ''),
            last_attempt_at: Date.now()
          });
          // 順序依存の書き込みを追い越さない。残りは次回の起動・オンライン復帰時に再試行する。
          break;
        }
      }
      return synced;
    })();
    try {
      return await syncInFlight;
    } finally {
      syncInFlight = null;
    }
  }

  async function clearRemoteCaches() {
    await Promise.all([
      clear('stores'),
      clear('config'),
      clear('viewCache'),
    ]);
  }

  // 店舗キャッシュ
  async function cacheStores(stores) { return replaceAll('stores', stores); }
  async function getCachedStores() { return getAll('stores'); }

  // 設定キャッシュ
  async function cacheConfig(config) {
    const entries = Object.entries(config).map(([key, value]) => ({ key, value }));
    return putAll('config', entries);
  }
  async function getCachedConfig() {
    const entries = await getAll('config');
    const config = {};
    entries.forEach(e => { config[e.key] = e.value; });
    return config;
  }

  // 巡回中データ保存
  async function saveCurrentRoute(routeData) {
    return put('currentRoute', { id: 'current', ...routeData });
  }
  async function getCurrentRoute() {
    return get('currentRoute', 'current');
  }
  async function clearCurrentRoute() {
    return del('currentRoute', 'current');
  }

  // 予定ルート（タイマー未開始で保存するプラン）
  async function savePlannedRoute(routeData) {
    const savedAt = Number(routeData?.savedAt) || Date.now();
    const record = { id: 'planned', ...routeData, savedAt };
    await put('currentRoute', record);
    return record;
  }
  async function getPlannedRoute() {
    return get('currentRoute', 'planned');
  }
  async function clearPlannedRoute() {
    return del('currentRoute', 'planned');
  }

  // タブ表示データの永続キャッシュ（起動直後から即表示するため）
  async function saveViewCache(id, data) {
    return put('viewCache', { id, data, savedAt: Date.now() });
  }
  async function getViewCache(id) {
    const rec = await get('viewCache', id);
    return rec ? rec : null;
  }
  async function clearViewCache(id) {
    return del('viewCache', id);
  }

  // online復帰時の自動同期
  window.addEventListener('online', async () => {
    const n = await syncPending();
    if (n > 0) console.log(`Synced ${n} pending actions`);
  });

  return {
    addPendingAction, reservePendingAction, settlePendingAction, getPendingActions, clearPendingActions, getPendingQueueStatus, syncPending,
    cacheStores, getCachedStores,
    cacheConfig, getCachedConfig,
    saveCurrentRoute, getCurrentRoute, clearCurrentRoute,
    savePlannedRoute, getPlannedRoute, clearPlannedRoute,
    saveViewCache, getViewCache, clearViewCache, clearRemoteCaches,
    getInventoryReceiptStatus, savePurchaseDraft, getPurchaseDraft, clearPurchaseDraft,
  };
})();
