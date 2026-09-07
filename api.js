// ============================================================
// GAS API communication layer
// ============================================================

const API = (() => {
  const CANONICAL_GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const API_URL_MIGRATION_KEY = 'gas_api_url_migrated_v185';
  const PAIRING_CODE_KEY = 'daniel_api_auth_token';
  const DEVICE_TOKEN_KEY = 'daniel_route_device_auth_v1';
  const DEVICE_ID_KEY = 'daniel_route_device_id_v1';
  const PENDING_DEVICE_TOKEN_KEY = 'daniel_route_pending_device_auth_v1';
  const CREDENTIAL_DB_NAME = 'sedori-route-credentials';
  const CREDENTIAL_STORE_NAME = 'credentials';
  const CREDENTIAL_DB_VERSION = 1;
  const DEFAULT_TIMEOUT_MS = 25000;
  const READ_ACTIONS = new Set([
    'getStores', 'getConfig', 'getRouteHistory', 'getRouteStops',
    'getRouteAreaVisits', 'getRouteCorrectionSuggestions', 'getPurchases',
    'getMemos', 'getFinds', 'getInventoryPurchases', 'getTunnelUrl',
    'getAnalyticsData', 'getAmazonPricing',
    '_debugInventory'
  ]);
  if (localStorage.getItem(API_URL_MIGRATION_KEY) !== '1') {
    localStorage.setItem('gas_api_url', CANONICAL_GAS_API_URL);
    localStorage.setItem(API_URL_MIGRATION_KEY, '1');
  }
  const storedBaseUrl = normalizeUrl_(localStorage.getItem('gas_api_url') || CANONICAL_GAS_API_URL);
  let baseUrl = isValidUrl(storedBaseUrl) ? storedBaseUrl : CANONICAL_GAS_API_URL;
  if (baseUrl !== storedBaseUrl) localStorage.setItem('gas_api_url', baseUrl);
  const credentialCache = new Map();
  let credentialDbPromise = null;
  let credentialReadyPromise = initializeCredentials_();
  // Startup may fail before the view awaits ready(). Keep that rejection
  // handled, and allow a later explicit attempt to reopen storage safely.
  credentialReadyPromise.catch(() => {});

  function openCredentialDb_() {
    if (credentialDbPromise) return credentialDbPromise;
    credentialDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CREDENTIAL_DB_NAME, CREDENTIAL_DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = event => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(CREDENTIAL_STORE_NAME)) {
          database.createObjectStore(CREDENTIAL_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = event => {
        const database = event.target.result;
        if (blocked) { database.close(); return; }
        database.onversionchange = () => {
          if (credentialDbPromise === pending) credentialDbPromise = null;
          database.close();
        };
        database.onclose = () => { if (credentialDbPromise === pending) credentialDbPromise = null; };
        resolve(database);
      };
      request.onerror = event => reject(event.target.error || new Error('credential_db_open_failed'));
      request.onblocked = () => { blocked = true; reject(new Error('credential_db_blocked')); };
    });
    const pending = credentialDbPromise;
    pending.catch(() => { if (credentialDbPromise === pending) credentialDbPromise = null; });
    return pending;
  }

  async function credentialTransaction_(mode, callback) {
    const database = await openCredentialDb_();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(CREDENTIAL_STORE_NAME, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = event => reject(event.target.error || new Error('credential_db_write_failed'));
      transaction.onabort = event => reject(event.target.error || new Error('credential_db_aborted'));
      try {
        callback(transaction.objectStore(CREDENTIAL_STORE_NAME), value => { result = value; });
      } catch (error) {
        try { transaction.abort(); } catch (_) { /* Already inactive. */ }
        reject(error);
      }
    });
  }

  async function readCredential_(key) {
    return credentialTransaction_('readonly', (store, setResult) => {
      const request = store.get(key);
      request.onsuccess = () => setResult(String(request.result?.value || ''));
    });
  }

  async function writeCredential_(key, value) {
    const normalized = String(value || '').trim();
    await credentialTransaction_('readwrite', store => {
      if (normalized) store.put({ key, value: normalized, updatedAt: Date.now() });
      else store.delete(key);
    });
    if (normalized) credentialCache.set(key, normalized);
    else credentialCache.delete(key);
  }

  async function initializeCredentials_() {
    const legacy = new Map([
      [PAIRING_CODE_KEY, String(localStorage.getItem(PAIRING_CODE_KEY) || '').trim()],
      [DEVICE_TOKEN_KEY, String(localStorage.getItem(DEVICE_TOKEN_KEY) || '').trim()],
      [PENDING_DEVICE_TOKEN_KEY, String(localStorage.getItem(PENDING_DEVICE_TOKEN_KEY) || '').trim()],
    ]);
    await openCredentialDb_();
    for (const key of [PAIRING_CODE_KEY, DEVICE_TOKEN_KEY, PENDING_DEVICE_TOKEN_KEY]) {
      let stored = await readCredential_(key);
      if (!stored && legacy.get(key)) {
        await writeCredential_(key, legacy.get(key));
        stored = await readCredential_(key);
        if (stored !== legacy.get(key)) throw new Error('credential_migration_readback_failed');
      }
      if (stored) credentialCache.set(key, stored);
    }
    // IndexedDBへの読戻しが成功した後だけ旧localStorageの秘密値を消す。
    [PAIRING_CODE_KEY, DEVICE_TOKEN_KEY, PENDING_DEVICE_TOKEN_KEY].forEach(key => {
      localStorage.removeItem(key);
    });
    return true;
  }

  async function ready() {
    const pending = credentialReadyPromise || (credentialReadyPromise = initializeCredentials_());
    try {
      return await pending;
    } catch (error) {
      if (credentialReadyPromise === pending) credentialReadyPromise = null;
      throw apiError_('端末の接続情報を安全に読み込めませんでした。再読み込みしてください', 'CREDENTIAL_STORAGE_FAILED', error);
    }
  }

  function normalizeUrl_(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function isValidUrl(url) {
    try {
      const parsed = new URL(normalizeUrl_(url));
      return parsed.protocol === 'https:'
        && parsed.hostname === 'script.google.com'
        && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(parsed.pathname);
    } catch (_error) {
      return false;
    }
  }

  function setUrl(url) {
    const normalized = normalizeUrl_(url);
    if (!isValidUrl(normalized)) {
      throw apiError_('Google Apps Scriptの正しいURLを入力してください', 'INVALID_URL');
    }
    baseUrl = normalized;
    localStorage.setItem('gas_api_url', baseUrl);
  }

  function getUrl() { return baseUrl; }
  function getCanonicalUrl() { return CANONICAL_GAS_API_URL; }
  function getPairingCode_() { return String(credentialCache.get(PAIRING_CODE_KEY) || '').trim(); }
  function getDeviceToken_() { return String(credentialCache.get(DEVICE_TOKEN_KEY) || '').trim(); }
  function getToken() { return getDeviceToken_() || getPairingCode_(); }
  function hasToken() { return Boolean(getToken()); }
  function hasDeviceCredential() { return Boolean(getDeviceToken_()); }
  async function setToken(value) {
    await ready();
    const token = String(value || '').trim();
    await writeCredential_(PAIRING_CODE_KEY, token);
  }

  function randomBase64Url_(byteLength) {
    if (!globalThis.crypto?.getRandomValues) {
      throw apiError_('この端末では安全な接続情報を作成できません', 'SECURE_RANDOM_UNAVAILABLE');
    }
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function getOrCreateDeviceId_() {
    const existing = String(localStorage.getItem(DEVICE_ID_KEY) || '').trim();
    if (/^[A-Za-z0-9._~-]{16,128}$/.test(existing)) return existing;
    const created = `route_${randomBase64Url_(24)}`;
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  }

  async function getOrCreatePendingDeviceToken_() {
    const existing = String(credentialCache.get(PENDING_DEVICE_TOKEN_KEY) || '').trim();
    if (/^[A-Za-z0-9._~-]{32,256}$/.test(existing)) return existing;
    const created = `route_dev_${randomBase64Url_(32)}`;
    await writeCredential_(PENDING_DEVICE_TOKEN_KEY, created);
    return created;
  }

  async function registerDevice_(pairingCode, deviceId, deviceToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'registerRouteDevice',
          auth_token: pairingCode,
          device_id: deviceId,
          device_token: deviceToken,
        }),
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw apiError_('端末の接続結果を確認できませんでした', 'UNKNOWN_RESPONSE', error);
      }
      if (!payload?.success || !payload?.data?.registered || payload.data.device_id !== deviceId) {
        const message = String(payload?.error || '端末を接続できませんでした');
        const code = message.startsWith('UNAUTHORIZED') ? 'UNAUTHORIZED' : 'DEVICE_REGISTRATION_FAILED';
        throw apiError_(message.replace(/^[A-Z_]+:\s*/, ''), code);
      }
      return payload.data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw apiError_('端末の接続確認がタイムアウトしました', 'TIMEOUT', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pairDevice(pairingCode) {
    await ready();
    const normalized = String(pairingCode || '').trim();
    if (normalized.length < 24 || normalized.length > 512 || /\s/.test(normalized)) {
      throw apiError_('接続コードの形式が正しくありません', 'INVALID_PAIRING_CODE');
    }
    const deviceId = getOrCreateDeviceId_();
    const deviceToken = await getOrCreatePendingDeviceToken_();
    await registerDevice_(normalized, deviceId, deviceToken);
    const previousToken = getDeviceToken_();
    try {
      await writeCredential_(DEVICE_TOKEN_KEY, deviceToken);
      if (getDeviceToken_() !== deviceToken) {
        throw apiError_('端末専用の接続情報を保存できませんでした', 'DEVICE_STORAGE_FAILED');
      }
    } catch (error) {
      await writeCredential_(DEVICE_TOKEN_KEY, previousToken).catch(() => {});
      throw error;
    }
    await writeCredential_(PENDING_DEVICE_TOKEN_KEY, '');
    // 登録済みの端末専用鍵だけを通常通信に使い、共有の接続コードは端末に残さない。
    await writeCredential_(PAIRING_CODE_KEY, '');
    return true;
  }

  async function ensureDeviceCredential() {
    await ready();
    if (hasDeviceCredential()) return true;
    const pairingCode = getPairingCode_();
    if (!pairingCode) return false;
    await pairDevice(pairingCode);
    return true;
  }

  async function clearDeviceCredential() {
    await ready();
    await Promise.all([
      writeCredential_(DEVICE_TOKEN_KEY, ''),
      writeCredential_(PENDING_DEVICE_TOKEN_KEY, ''),
      writeCredential_(PAIRING_CODE_KEY, ''),
    ]);
  }

  function createOperationId(action = 'op') {
    const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${action}-${uuid}`;
  }

  function apiError_(message, code = 'API_ERROR', cause = null) {
    const error = new Error(message);
    error.code = code;
    error.cause = cause;
    return error;
  }

  async function readJson_(res, action) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw apiError_(
        `${action}の結果を確認できませんでした。再読み込みで保存結果を確認してください`,
        'UNKNOWN_RESPONSE',
        error
      );
    }
    // A JSON body alone is not proof of a completed write. Preserve its receipt
    // when HTTP failed or the GAS success envelope cannot be verified.
    if (res.ok === false || !data || typeof data !== 'object' || Array.isArray(data)
      || typeof data.success !== 'boolean'
      || (data.success === true && !Object.prototype.hasOwnProperty.call(data, 'data'))) {
      throw apiError_(`${action}の結果を確認できませんでした。再送せず保存結果を確認してください`, 'UNKNOWN_RESPONSE');
    }
    if (data.success === false) {
      const message = String(data.error || 'API error');
      const pricingRejection = action === 'updateAmazonPricingPreference'
        ? message.match(/^(INVALID_INPUT|PRICING_REFRESH_REQUIRED|PRICING_REVISION_CONFLICT):/)?.[1] : '';
      const code = message.startsWith('UNAUTHORIZED') ? 'UNAUTHORIZED'
        : message.startsWith('BUSY') ? 'BUSY'
          : message.startsWith('OPERATION_OUTCOME_UNKNOWN') ? 'OPERATION_OUTCOME_UNKNOWN'
          : pricingRejection ? pricingRejection
          : 'API_ERROR';
      if (code === 'UNAUTHORIZED') {
        window.dispatchEvent(new CustomEvent('api-auth-error', { detail: { action } }));
      }
      throw apiError_(message.replace(/^[A-Z_]+:\s*/, ''), code);
    }
    return data.data;
  }

  async function request_(action, body = {}, options = {}) {
    await ready();
    if (!baseUrl) throw apiError_('API URL未設定', 'URL_REQUIRED');
    if (action !== 'ping' && !hasToken()) {
      throw apiError_('設定で接続コードを入力してください', 'AUTH_TOKEN_REQUIRED');
    }

    if (action === 'ping') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
      try {
        const res = await fetch(`${baseUrl}?action=ping`, { redirect: 'follow', signal: controller.signal });
        return await readJson_(res, action);
      } finally {
        clearTimeout(timer);
      }
    }

    const isRead = READ_ACTIONS.has(action);
    const operationId = String(
      body.operation_id || options.operationId || (isRead ? '' : createOperationId(action))
    );
    const payload = {
      ...body,
      action,
      auth_token: getToken(),
      ...(operationId ? { operation_id: operationId } : {})
    };
    if (!isRead) {
      const reservation = await Storage.reservePendingAction({ action, body: { ...body, operation_id: operationId }, operation_id: operationId, timestamp: Date.now(), attempts: 0,
        ...(action === 'updateAmazonPricingPreference' ? { last_error_code: 'OPERATION_OUTCOME_UNKNOWN' } : {}) });
      if (reservation.conflictId) throw apiError_(`同じ内容を確認中です。再入力せず受付ID ${reservation.conflictId} の送信待ちを確認してください`, 'PENDING_OPERATION_EXISTS');
    }
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal
      });
      const result = await readJson_(res, action);
      if (typeof options.validateResult === 'function' && !options.validateResult(result)) {
        throw apiError_('保存結果の形式を確認できませんでした。再送せず一覧を再確認してください', 'OPERATION_OUTCOME_UNKNOWN');
      }
      if (!isRead) {
        try { await Storage.settlePendingAction(operationId, { remove: true, result }); }
        catch (error) { throw apiError_('保存後の端末側の記録確認に失敗しました', 'UNKNOWN_RESPONSE', error); }
      }
      return result;
    } catch (error) {
      const queueOnFailure = options.queueOnFailure !== false && !isRead;
      const retryable = error.name === 'AbortError'
        || error.name === 'TypeError'
        || ['UNKNOWN_RESPONSE', 'OPERATION_OUTCOME_UNKNOWN'].includes(error.code)
        || /load failed|failed to fetch|networkerror/i.test(String(error.message || error));
      if (!isRead) {
        const pricingDefinitelyRejected = action === 'updateAmazonPricingPreference' &&
          ['INVALID_INPUT','PRICING_REFRESH_REQUIRED','PRICING_REVISION_CONFLICT','BUSY','UNAUTHORIZED'].includes(error.code);
        await Storage.settlePendingAction(operationId, pricingDefinitelyRejected ? { remove: true } : action === 'updateAmazonPricingPreference' ? {
          last_error: '価格管理設定の保存結果を再確認してください', last_error_code: 'OPERATION_OUTCOME_UNKNOWN', last_attempt_at: Date.now()
        } : retryable ? {
          last_error: String(error.message || error), last_error_code: String(error.code || ''), last_attempt_at: Date.now()
        } : (options.queueOnFailure === false ? {
          last_error: String(error.message || error), last_error_code: String(error.code || ''), last_attempt_at: Date.now()
        } : { remove: true }));
      }
      if (queueOnFailure && retryable) {
        if (error.code === 'OPERATION_OUTCOME_UNKNOWN') {
          throw apiError_(`保存結果の個別確認が必要です。入力は残しています。受付ID ${operationId}（自動再実行なし）`, 'OPERATION_OUTCOME_UNKNOWN', error);
        }
        return { _queued: true, operation_id: operationId };
      }
      if (error.name === 'AbortError') {
        throw apiError_(`${action}がタイムアウトしました`, 'TIMEOUT', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function get(action, params = {}) {
    return request_(action, params, { queueOnFailure: false });
  }

  function post(action, body = {}, options = {}) {
    return request_(action, body, options);
  }

  return {
    setUrl, getUrl, getCanonicalUrl, isValidUrl,
    ready, setToken, hasToken, hasDeviceCredential, pairDevice, ensureDeviceCredential, clearDeviceCredential,
    createOperationId, get, post,
    ping:             ()          => request_('ping', {}, { queueOnFailure: false }),
    getStores:        ()          => get('getStores'),
    getConfig:        ()          => get('getConfig'),
    getRouteHistory:  (p = {})    => get('getRouteHistory', p),
    getRouteStops:    (p = {})    => get('getRouteStops', p),
    getRouteAreaVisits:(p = {})   => get('getRouteAreaVisits', p),
    getRouteCorrectionSuggestions:(p = {}) => get('getRouteCorrectionSuggestions', p),
    getPurchases:     (p = {})    => get('getPurchases', p),
    getMemos:         (p = {})    => get('getMemos', p),
    getFinds:         (p = {})    => get('getFinds', p),
    addStore:         (b)         => post('addStore', b),
    updateStore:      (b)         => post('updateStore', b),
    deleteStore:      (b)         => post('deleteStore', b),
    startRoute:       (b)         => post('startRoute', b, { queueOnFailure: false }),
    updateStop:       (b, o = {}) => post('updateStop', b, o),
    endRoute:         (b)         => post('endRoute', b, { queueOnFailure: false }),
    addStopToRoute:   (b)         => post('addStopToRoute', b),
    addPurchase:      (b)         => post('addPurchase', b),
    addMemo:          (b)         => post('addMemo', b),
    addInventoryPurchase:(b)      => post('addInventoryPurchase', b),
    getInventoryPurchases:(p={})  => get('getInventoryPurchases', p),
    getAnalyticsData:  (p={})     => get('getAnalyticsData', p),
    getAmazonPricing: () => get('getAmazonPricing'),
    updateAmazonPricingPreference: (b) => {
      if (!b || !['snooze', 'exclude', 'restore', 'set_size'].includes(b.action) || !b.sku ||
          !Number.isInteger(b.expectedRevision) || b.expectedRevision < 0 ||
          !b.operation_id || (b.action === 'snooze' && ![3, 7].includes(b.days)) ||
          (b.action === 'set_size' && (!['normal','large'].includes(b.sizeClass) || !/^[A-Z0-9]{10}$/.test(b.asin || '')))) {
        return Promise.reject(apiError_('価格管理設定を再読込してから操作してください', 'INVALID_INPUT'));
      }
      // API dispatch uses action; the preference action must have a distinct wire field.
      return post('updateAmazonPricingPreference', {
        sku: b.sku, preference_action: b.action, ...(b.action === 'snooze' ? { days: b.days } : {}),
        ...(b.action === 'set_size' ? {asin:b.asin,sizeClass:b.sizeClass} : {}),
        expectedRevision: b.expectedRevision, operation_id: b.operation_id,
      }, { queueOnFailure: false, validateResult: result => result?.ok === true && result?.verified === true &&
        result?.item?.sku === b.sku && result?.item?.preference?.revision === b.expectedRevision + 1 &&
        result?.item?.canChangePrice === false });
    },
    recalcRoutePurchases:(p={})   => post('recalcRoutePurchases', p),
    updateInventoryShop:(b)       => post('updateInventoryShop', b),
    bulkUpdateInventoryShop:(b)   => post('bulkUpdateInventoryShop', b),
    updateConfig:     (entries)   => post('updateConfig', { entries }),
    updateRouteDate:  (b)         => post('updateRouteDate', b, { queueOnFailure: false }),
    deleteRoute:      (b)         => post('deleteRoute', b, { queueOnFailure: false }),
    clearHistory:     ()          => post('clearHistory', {}, { queueOnFailure: false }),
    importRouteProfit:()          => post('importRouteProfit', {}, { queueOnFailure: false }),
  };
})();
