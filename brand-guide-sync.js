/* Read-only library transport. Never loads inventory queues or pairs a device. */
const BrandGuideSync = (() => {
  'use strict';
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const INTERVAL = 15 * 60 * 1000;
  let pending = null;
  let lastAttempt = 0;
  function fail(message) { throw new Error(message); }
  async function credential() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('sedori-route-credentials', 1);
      let ended = false;
      const finish = (value, error) => {
        if (ended) return; ended = true; clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(null, new Error('店舗アプリの接続を確認できませんでした。')), 10000);
      req.onupgradeneeded = () => {
        // An unpaired browser must not create/modify the app's credential store.
        req.transaction.abort();
      };
      req.onblocked = req.onerror = () => finish(null, new Error('店舗アプリの接続設定を確認してください。'));
      req.onsuccess = () => {
        const db = req.result;
        if (ended) { db.close(); return; }
        db.onversionchange = () => db.close();
        try {
          const tx = db.transaction('credentials', 'readonly');
          const read = tx.objectStore('credentials').get('daniel_route_device_auth_v1');
          tx.oncomplete = () => { db.close(); finish(String(read.result?.value || '')); };
          tx.onerror = tx.onabort = () => { db.close(); finish(null, new Error('店舗アプリの接続を確認できませんでした。')); };
        } catch { db.close(); finish(null, new Error('店舗アプリの接続設定を確認してください。')); }
      };
    });
  }
  async function request(action, token, body = {}, maxBytes = 65536) {
    if (!['getBrandGuideManifest', 'getBrandGuidePackage'].includes(action)) fail('図鑑以外の操作はできません。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === 'getBrandGuidePackage' ? 90000 : 60000);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, action, auth_token: token }),
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        redirect: 'follow', signal: controller.signal,
      });
      if (!response.ok) fail('図鑑の配信先に接続できませんでした。');
      const mime = response.headers.get('content-type') || '';
      if (!mime.includes('application/json')) fail('図鑑の配信を確認できませんでした。');
      if (Number(response.headers.get('content-length')) > maxBytes) fail('資料が容量上限を超えています。');
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      // Begin after authentication request; continue within byte limit; end only at EOF.
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); fail('資料が容量上限を超えています。'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = JSON.parse(raw);
      if (parsed.success === false) {
        if (String(parsed.error).startsWith('UNAUTHORIZED')) fail('店舗アプリの接続設定を確認してください。');
        fail('最新版を取得できませんでした。次回もう一度確認します。');
      }
      if (action === 'getBrandGuideManifest' && parsed.success !== true) fail('図鑑の更新情報を確認できませんでした。');
      return action === 'getBrandGuidePackage' ? raw : parsed.data;
    } finally { clearTimeout(timer); }
  }
  function validateManifest(m) {
    if (!m || m.schemaVersion !== 1 || !Number.isSafeInteger(m.revision) || m.revision < 1
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !/^\d{4}-\d{2}-\d{2}$/.test(m.updatedAt) || !Number.isFinite(Date.parse(m.updatedAt)) || new Date(m.updatedAt).toISOString().slice(0, 10) !== m.updatedAt
      || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > 40 * 1024 * 1024) fail('図鑑の更新情報が正しくありません。');
    return m;
  }
  function run({ guide, onStatus = () => {}, onSaved = () => {}, force = false }) {
    if (pending) return pending;
    if (navigator.onLine === false) { onStatus('圏外です。保存済みの図鑑を使えます。'); return Promise.resolve(); }
    if (!force && lastAttempt && Date.now() - lastAttempt < INTERVAL) return Promise.resolve();
    lastAttempt = Date.now();
    pending = (async () => {
      try {
        onStatus('最新版を確認しています…');
        const token = await credential();
        if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) fail('店舗アプリの接続設定を一度行うと、自動で図鑑を保存できます。');
        const manifest = validateManifest(await request('getBrandGuideManifest', token));
        const old = await guide.load();
        if (old?.sha === manifest.sha256) { onStatus('最新版を保存済みです。ファイル選択は不要です。'); return; }
        if (old && (old.data.updatedAt > manifest.updatedAt || (old.remoteRevision || 0) > manifest.revision)) fail('配信中の資料が古いため、保存済みの図鑑を使います。');
        onStatus('図鑑を保存しています…');
        const raw = await request('getBrandGuidePackage', token, { sha256: manifest.sha256 }, guide.MAX_BYTES);
        if (new TextEncoder().encode(raw).length !== manifest.bytes) fail('資料を最後まで受け取れませんでした。');
        const record = await guide.importFile({ size: manifest.bytes, text: async () => raw }, manifest);
        onSaved(record); onStatus('自動保存が完了しました。通信なしでも見られます。');
      } catch (error) {
        const message = error?.name === 'AbortError' ? '通信が遅いため更新を中断しました。' : (error?.message || '更新を確認できませんでした。');
        onStatus(message + ' 保存済みの資料は変更していません。');
      } finally { pending = null; }
    })();
    return pending;
  }
  return { run, validateManifest, INTERVAL };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BrandGuideSync;
