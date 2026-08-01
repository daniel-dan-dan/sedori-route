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
  const DEFAULT_TIMEOUT_MS = 25000;
  const READ_ACTIONS = new Set([
    'getStores', 'getConfig', 'getRouteHistory', 'getRouteStops',
    'getRouteAreaVisits', 'getRouteCorrectionSuggestions', 'getPurchases',
    'getMemos', 'getFinds', 'getInventoryPurchases', 'getTunnelUrl',
    'getAnalyticsData',
    '_debugInventory'
  ]);
  if (localStorage.getItem(API_URL_MIGRATION_KEY) !== '1') {
    localStorage.setItem('gas_api_url', CANONICAL_GAS_API_URL);
    localStorage.setItem(API_URL_MIGRATION_KEY, '1');
  }
  const storedBaseUrl = normalizeUrl_(localStorage.getItem('gas_api_url') || CANONICAL_GAS_API_URL);
  let baseUrl = isValidUrl(storedBaseUrl) ? storedBaseUrl : CANONICAL_GAS_API_URL;
  if (baseUrl !== storedBaseUrl) localStorage.setItem('gas_api_url', baseUrl);

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
  function getPairingCode_() { return String(localStorage.getItem(PAIRING_CODE_KEY) || '').trim(); }
  function getDeviceToken_() { return String(localStorage.getItem(DEVICE_TOKEN_KEY) || '').trim(); }
  function getToken() { return getDeviceToken_() || getPairingCode_(); }
  function hasToken() { return Boolean(getToken()); }
  function hasDeviceCredential() { return Boolean(getDeviceToken_()); }
  function setToken(value) {
    const token = String(value || '').trim();
    if (token) localStorage.setItem(PAIRING_CODE_KEY, token);
    else localStorage.removeItem(PAIRING_CODE_KEY);
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

  function getOrCreatePendingDeviceToken_() {
    const existing = String(localStorage.getItem(PENDING_DEVICE_TOKEN_KEY) || '').trim();
    if (/^[A-Za-z0-9._~-]{32,256}$/.test(existing)) return existing;
    const created = `route_dev_${randomBase64Url_(32)}`;
    localStorage.setItem(PENDING_DEVICE_TOKEN_KEY, created);
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
    const normalized = String(pairingCode || '').trim();
    if (normalized.length < 24 || normalized.length > 512 || /\s/.test(normalized)) {
      throw apiError_('接続コードの形式が正しくありません', 'INVALID_PAIRING_CODE');
    }
    const deviceId = getOrCreateDeviceId_();
    const deviceToken = getOrCreatePendingDeviceToken_();
    await registerDevice_(normalized, deviceId, deviceToken);
    const previousToken = String(localStorage.getItem(DEVICE_TOKEN_KEY) || '');
    try {
      localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken);
      if (localStorage.getItem(DEVICE_TOKEN_KEY) !== deviceToken) {
        throw apiError_('端末専用の接続情報を保存できませんでした', 'DEVICE_STORAGE_FAILED');
      }
    } catch (error) {
      if (previousToken) localStorage.setItem(DEVICE_TOKEN_KEY, previousToken);
      else localStorage.removeItem(DEVICE_TOKEN_KEY);
      throw error;
    }
    localStorage.removeItem(PENDING_DEVICE_TOKEN_KEY);
    // 両PWAの移行が揃った時だけ旧共有コードを消す。メルカリ未移行なら移行元を残す。
    if (String(localStorage.getItem('mercari_device_auth_v1') || '').trim()) {
      localStorage.removeItem(PAIRING_CODE_KEY);
    }
    return true;
  }

  async function ensureDeviceCredential() {
    if (hasDeviceCredential()) return true;
    const pairingCode = getPairingCode_();
    if (!pairingCode) return false;
    await pairDevice(pairingCode);
    return true;
  }

  function clearDeviceCredential() {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    localStorage.removeItem(PENDING_DEVICE_TOKEN_KEY);
    localStorage.removeItem(PAIRING_CODE_KEY);
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
    if (!data.success) {
      const message = String(data.error || 'API error');
      const code = message.startsWith('UNAUTHORIZED') ? 'UNAUTHORIZED'
        : message.startsWith('BUSY') ? 'BUSY'
          : 'API_ERROR';
      if (code === 'UNAUTHORIZED') {
        window.dispatchEvent(new CustomEvent('api-auth-error', { detail: { action } }));
      }
      throw apiError_(message.replace(/^[A-Z_]+:\s*/, ''), code);
    }
    return data.data;
  }

  async function request_(action, body = {}, options = {}) {
    if (!baseUrl) throw apiError_('API URL未設定', 'URL_REQUIRED');
    if (action !== 'ping' && !hasToken()) {
      throw apiError_('設定で接続コードを入力してください', 'AUTH_TOKEN_REQUIRED');
    }

    if (action === 'ping') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
      try {
        const res = await fetch(`${baseUrl}?action=ping`, { redirect: 'follow', signal: controller.signal });
        return readJson_(res, action);
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
      return await readJson_(res, action);
    } catch (error) {
      const queueOnFailure = options.queueOnFailure !== false && !isRead;
      const retryable = error.name === 'AbortError'
        || /load failed|failed to fetch|networkerror/i.test(String(error.message || error));
      if (queueOnFailure && retryable) {
        await Storage.addPendingAction({
          action,
          body: { ...body, operation_id: operationId },
          operation_id: operationId,
          attempts: 0,
          last_error: String(error.message || error),
          timestamp: Date.now()
        });
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
    setToken, getToken, hasToken, hasDeviceCredential, pairDevice, ensureDeviceCredential, clearDeviceCredential,
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
