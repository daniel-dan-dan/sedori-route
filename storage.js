// ============================================================
// オフラインストレージ（IndexedDB + 同期キュー）
// ============================================================

const Storage = (() => {
  const DB_NAME = 'sedori-route';
  const DB_VERSION = 1;
  let db = null;

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
    const d = await open();
    const tx = d.transaction('pendingActions', 'readwrite');
    tx.objectStore('pendingActions').add(actionObj);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getPendingActions() {
    return getAll('pendingActions');
  }

  async function clearPendingActions() {
    return clear('pendingActions');
  }

  // オンライン復帰時に同期
  async function syncPending() {
    const actions = await getPendingActions();
    if (actions.length === 0) return 0;
    let synced = 0;
    const failed = [];
    for (const act of actions) {
      try {
        await API.post(act.action, act.body);
        synced++;
      } catch (e) {
        console.warn('Sync failed:', e);
        failed.push(act);
      }
    }
    // 全てクリアし、失敗分だけ再登録
    await clearPendingActions();
    for (const act of failed) {
      await addPendingAction(act);
    }
    return synced;
  }

  // 店舗キャッシュ
  async function cacheStores(stores) { return putAll('stores', stores); }
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
    return put('currentRoute', { id: 'planned', ...routeData, savedAt: Date.now() });
  }
  async function getPlannedRoute() {
    return get('currentRoute', 'planned');
  }
  async function clearPlannedRoute() {
    return del('currentRoute', 'planned');
  }

  // online復帰時の自動同期
  window.addEventListener('online', async () => {
    const n = await syncPending();
    if (n > 0) console.log(`Synced ${n} pending actions`);
  });

  return {
    addPendingAction, getPendingActions, clearPendingActions, syncPending,
    cacheStores, getCachedStores,
    cacheConfig, getCachedConfig,
    saveCurrentRoute, getCurrentRoute, clearCurrentRoute,
    savePlannedRoute, getPlannedRoute, clearPlannedRoute
  };
})();
