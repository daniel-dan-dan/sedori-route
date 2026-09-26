/* Independent guide credentials; no route queue or inventory API is loaded. */
const GuideCredentials = (() => {
  'use strict';
  const DB = 'brand-guide-credentials';
  const KEY = 'guide-device-token-v1';
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const validToken = value => /^[A-Za-z0-9._~-]{32,256}$/.test(value);
  let connecting = null;
  function open(name = DB, create = true) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      let finished = false;
      const finish = (db, error) => {
        if (finished) { db?.close(); return; }
        finished = true; clearTimeout(timer); error ? reject(error) : resolve(db);
      };
      const timer = setTimeout(() => finish(null, new Error('接続情報の保存先を開けませんでした。')), 10000);
      request.onupgradeneeded = () => {
        if (!create) { request.transaction.abort(); return; }
        request.result.createObjectStore('credentials', { keyPath:'key' });
      };
      request.onerror = request.onblocked = () => finish(null, new Error('接続情報の保存先を開けませんでした。'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
    });
  }
  async function transact(mode, key, value, name = DB, create = true) {
    const db = await open(name, create);
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('credentials', mode);
        const store = tx.objectStore('credentials');
        const request = mode === 'readonly' ? store.get(key) : store.put({key, value, updatedAt:new Date().toISOString()});
        tx.oncomplete = () => { db.close(); resolve(mode === 'readonly' ? String(request.result?.value || '') : value); };
        tx.onerror = tx.onabort = () => { db.close(); reject(new Error('接続情報を保存できませんでした。')); };
      } catch { db.close(); reject(new Error('接続情報を確認できませんでした。')); }
    });
  }
  const read = key => transact('readonly', key);
  async function save(key, value) {
    await transact('readwrite', key, value);
    if (await read(key) !== value) throw new Error('接続情報の保存を確認できませんでした。');
  }
  async function get() {
    const own = await read(KEY);
    if (validToken(own)) return own;
    // One-time read-only inheritance on the same origin. Never modifies the old app.
    const previous = await transact('readonly', 'daniel_route_device_auth_v1', undefined, 'sedori-route-credentials', false).catch(() => '');
    if (!validToken(previous)) return '';
    await save(KEY, previous);
    return previous;
  }
  function random(prefix, size) {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function connect(code) {
    if (connecting) return connecting;
    if (typeof code !== 'string' || code.length < 24 || code.length > 512 || /\s/.test(code)) return Promise.reject(new Error('接続コードの形式を確認してください。'));
    connecting = (async () => {
      let id = await read('guide-device-id');
      if (!/^[A-Za-z0-9._~-]{16,128}$/.test(id)) { id = random('guide_',24); await save('guide-device-id',id); }
      let token = await read('guide-pending-token');
      if (!validToken(token)) { token = random('guide_dev_',32); await save('guide-pending-token',token); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        // Reuses the deployed registration contract; retries preserve this exact id/token.
        const response = await fetch(ENDPOINT, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({action:'registerRouteDevice',auth_token:code,device_id:id,device_token:token}), credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'follow',signal:controller.signal});
        if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error('接続先の応答を確認できませんでした。');
        const reader = response.body.getReader(); let length = 0; const chunks = [];
        // Start after registration response; continue below 64 KiB; finish at EOF.
        while (true) { const {value,done} = await reader.read(); if(done) break; length += value.byteLength; if(length > 65536) { await reader.cancel(); throw new Error('接続先の応答が大きすぎます。'); } chunks.push(value); }
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
        const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        if (!result?.success || !result.data?.registered || result.data.device_id !== id) throw new Error('接続できませんでした。接続コードを確認してください。');
        const old = await read(KEY);
        try { await save(KEY,token); } catch(error) { await save(KEY,old).catch(() => {}); throw error; }
        await save('guide-pending-token','');
      } finally { clearTimeout(timer); }
    })().finally(() => { connecting = null; });
    return connecting;
  }
  return {get,connect};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GuideCredentials;
