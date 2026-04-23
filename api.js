// ============================================================
// GAS API 通信層
// ============================================================

const API = (() => {
  let baseUrl = localStorage.getItem('gas_api_url') || '';

  function setUrl(url) {
    baseUrl = url.replace(/\/+$/, '');
    localStorage.setItem('gas_api_url', baseUrl);
  }
  function getUrl() { return baseUrl; }

  async function get(action, params = {}) {
    if (!baseUrl) throw new Error('API URL未設定');
    const qs = new URLSearchParams({ action, ...params }).toString();
    const res = await fetch(`${baseUrl}?${qs}`, { redirect: 'follow' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'API error');
    return data.data;
  }

  async function post(action, body = {}) {
    if (!baseUrl) throw new Error('API URL未設定');
    body.action = action;
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
        redirect: 'follow'
      });
      // GAS POST は302リダイレクト後にHTMLを返すことがある
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        if (!data.success) throw new Error(data.error || 'API error');
        return data.data;
      } catch {
        // レスポンスがJSONでなくても、書き込みは成功している場合がある
        return { _rawResponse: true };
      }
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
    getInventoryPurchases:(p={}) => get('getInventoryPurchases', p),
    updateInventoryShop:(b)      => post('updateInventoryShop', b),
    updateConfig:    (entries)   => post('updateConfig', { entries }),
    deleteRoute:     (b)         => post('deleteRoute', b),
    clearHistory:    ()          => post('clearHistory'),
  };
})();
