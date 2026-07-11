// ============================================================
// GAS API communication layer
// ============================================================

const API = (() => {
  const CANONICAL_GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const AUTH_TOKEN_KEY = 'daniel_api_auth_token';
  const DEFAULT_TIMEOUT_MS = 25000;
  const READ_ACTIONS = new Set([
    'getStores', 'getConfig', 'getRouteHistory', 'getRouteStops',
    'getRouteAreaVisits', 'getRouteCorrectionSuggestions', 'getPurchases',
    'getMemos', 'getFinds', 'getInventoryPurchases', 'getTunnelUrl',
    'getAnalyticsData',
    '_debugInventory'
  ]);
  let baseUrl = normalizeUrl_(localStorage.getItem('gas_api_url') || CANONICAL_GAS_API_URL);

  if (!localStorage.getItem('gas_api_url')) localStorage.setItem('gas_api_url', baseUrl);

  function normalizeUrl_(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function setUrl(url) {
    baseUrl = normalizeUrl_(url);
    localStorage.setItem('gas_api_url', baseUrl);
  }

  function getUrl() { return baseUrl; }
  function getToken() { return String(localStorage.getItem(AUTH_TOKEN_KEY) || '').trim(); }
  function hasToken() { return Boolean(getToken()); }
  function setToken(value) {
    const token = String(value || '').trim();
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
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
    setUrl, getUrl, setToken, getToken, hasToken, createOperationId, get, post,
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
    updateStop:       (b)         => post('updateStop', b),
    endRoute:         (b)         => post('endRoute', b, { queueOnFailure: false }),
    addStopToRoute:   (b)         => post('addStopToRoute', b),
    addPurchase:      (b)         => post('addPurchase', b),
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
  };
})();
