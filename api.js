// ============================================================
// GAS API 通信層
// ============================================================

const API = (() => {
  const CANONICAL_GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  let baseUrl = normalizeUrl_(localStorage.getItem('gas_api_url') || CANONICAL_GAS_API_URL);

  if (!localStorage.getItem('gas_api_url')) {
    localStorage.setItem('gas_api_url', baseUrl);
  }

  function normalizeUrl_(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function setUrl(url) {
    baseUrl = normalizeUrl_(url);
    localStorage.setItem('gas_api_url', baseUrl);
  }
  function getUrl() { return baseUrl; }

  function shouldRetryCanonical_(errorMessage) {
    return baseUrl !== CANONICAL_GAS_API_URL && /Unknown (GET|POST) action/i.test(String(errorMessage || ''));
  }

  function switchToCanonical_() {
    setUrl(CANONICAL_GAS_API_URL);
  }

  async function get(action, params = {}) {
    if (!baseUrl) throw new Error('API URL未設定');
    const qs = new URLSearchParams({ action, ...params }).toString();
    const res = await fetch(`${baseUrl}?${qs}`, { redirect: 'follow' });
    const data = await res.json();
    if (!data.success) {
      if (shouldRetryCanonical_(data.error)) {
        switchToCanonical_();
        return get(action, params);
      }
      throw new Error(data.error || 'API error');
    }
    return data.data;
  }

  async function post(action, body = {}) {
    if (!baseUrl) throw new Error('API URL未設定');
    const payload = { ...body, action };
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
      // GAS POST は302リダイレクト後にHTMLを返すことがある
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // レスポンスがJSONでない（HTML等）→ 書き込み自体は成功していることが多い
        return { _rawResponse: true };
      }
      if (!data.success) {
        if (shouldRetryCanonical_(data.error)) {
          switchToCanonical_();
          return post(action, body);
        }
        throw new Error(data.error || 'API error');
      }
      return data.data;
    } catch (err) {
      // オフライン時はキューに追加
      if (!navigator.onLine) {
        Storage.addPendingAction({ action, body, timestamp: Date.now() });
        return { _queued: true };
      }
      throw err;
    }
  }

  return {
    setUrl, getUrl, get, post,
    getStores:       ()          => get('getStores'),
    getConfig:       ()          => get('getConfig'),
    getRouteHistory: (p = {})    => get('getRouteHistory', p),
    getRouteStops:   (p = {})    => get('getRouteStops', p),
    getRouteAreaVisits:(p = {})  => get('getRouteAreaVisits', p),
    getRouteCorrectionSuggestions:(p = {}) => get('getRouteCorrectionSuggestions', p),
    getPurchases:    (p = {})    => get('getPurchases', p),
    getMemos:        (p = {})    => get('getMemos', p),
    getFinds:        (p = {})    => get('getFinds', p),
    addStore:        (b)         => post('addStore', b),
    updateStore:     (b)         => post('updateStore', b),
    deleteStore:     (b)         => post('deleteStore', b),
    startRoute:      (b)         => post('startRoute', b),
    updateStop:      (b)         => post('updateStop', b),
    endRoute:        (b)         => post('endRoute', b),
    addStopToRoute:  (b)         => post('addStopToRoute', b),
    addPurchase:     (b)         => post('addPurchase', b),
    addInventoryPurchase:(b)      => post('addInventoryPurchase', b),
    addMemo:         (b)         => post('addMemo', b),
    getInventoryPurchases:(p={}) => get('getInventoryPurchases', p),
    recalcRoutePurchases:(p={})  => get('recalcRoutePurchases', p),
    updateInventoryShop:(b)      => post('updateInventoryShop', b),
    updateConfig:    (entries)   => post('updateConfig', { entries }),
    updateRouteDate: (b)         => get('updateRouteDate', b),
    deleteRoute:     (b)         => post('deleteRoute', b),
    clearHistory:    ()          => post('clearHistory'),
  };
})();
