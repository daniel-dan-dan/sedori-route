/* Read-only library transport. Never loads inventory queues or pairs a device. */
const BrandGuideSync = (() => {
  'use strict';
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const INTERVAL = 15 * 60 * 1000;
  const READ_RETRY_DELAY = 1000;
  const RECOVERY_DELAYS = [3000, 10000, 30000];
  const RETRYABLE_READ_CODES = new Set(['CONTENT_REDIRECT_FAILED', 'NETWORK_READ_FAILED', 'READ_TIMEOUT', 'HTTP_404', 'HTTP_429']);
  let pending = null;
  let credentialProvider = null;
  let publicRead = false;
  function configureCredential(provider) { credentialProvider = provider; publicRead = false; }
  function configurePublicRead() { publicRead = true; credentialProvider = null; }
  let lastAttempt = 0, retryAt = 0, recoveryStep = 0;
  function fail(message, code = '', retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; throw error; }
  function readFailure(error, signal) {
    if (signal.aborted || error?.name === 'AbortError') {
      const failure = new Error('通信が遅いため更新を中断しました。');
      failure.name = 'AbortError'; failure.code = 'READ_TIMEOUT'; failure.retryable = true; return failure;
    }
    if (error?.name === 'TypeError') {
      const failure = new Error('図鑑の配信先に接続できませんでした。');
      failure.code = 'NETWORK_READ_FAILED'; failure.retryable = true; return failure;
    }
    return error;
  }
  function transportMetadata(response) {
    let destination = 'other';
    try {
      const url = new URL(response.url);
      if (url.hostname === 'script.google.com') destination = 'gas-entry';
      else if (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')) destination = 'google-content';
    } catch {}
    return { redirected: response.redirected === true, destination };
  }
  function waitToRetry(signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
      const aborted = () => finish(readFailure(null, signal));
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish(), READ_RETRY_DELAY);
    });
  }
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
      for (let attempt = 0; attempt < 2; attempt++) {
        let response, metadata = { redirected: false, destination: 'other' };
        try {
          // Public cache discriminator only. Authentication stays in the POST body.
          const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
          try {
            response = await fetch(ENDPOINT + '?read_request=' + nonce, {
              method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify(publicRead ? { ...body, action } : { ...body, action, auth_token: token }),
              credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
              redirect: 'follow', signal: controller.signal,
            });
          } catch (error) { throw readFailure(error, controller.signal); }
          metadata = transportMetadata(response);
          if (!response.ok) {
            let title = '';
            if ((response.headers.get('content-type') || '').includes('text/html')) {
              try {
                const diagnosticReader = response.body.getReader();
                const first = await diagnosticReader.read(); await diagnosticReader.cancel();
                const start = new TextDecoder().decode((first.value || new Uint8Array()).slice(0, 4096));
                title = (start.match(/<title[^>]*>([^<]{0,160})<\/title>/i)?.[1] || '')
                  .split(token || '\u0000').join('[redacted]').replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_.~-]{28,}/g, '[redacted]');
              } catch {}
            } else if (response.body) { try { await response.body.cancel(); } catch {} }
            const retryable = response.status === 404 || response.status === 429 || response.status >= 500 && response.status <= 599;
            if (!retryable || attempt === 1) console.warn('[brand-guide] HTTP failure', action, response.status, title, metadata);
            fail('図鑑の配信先に接続できませんでした。', 'HTTP_' + response.status, retryable);
          }
          const mime = response.headers.get('content-type') || '';
          if (!mime.includes('application/json')) fail('図鑑の配信を確認できませんでした。');
          if (Number(response.headers.get('content-length')) > maxBytes) fail('資料が容量上限を超えています。');
          if (!response.body) fail('資料を最後まで受け取れませんでした。');
          const reader = response.body.getReader(); const chunks = []; let size = 0;
          // Begin after authentication request; continue within byte limit; end only at EOF.
          while (true) {
            let part;
            try { part = await reader.read(); } catch (error) { throw readFailure(error, controller.signal); }
            const { value, done } = part; if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { await reader.cancel(); fail('資料が容量上限を超えています。'); }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('図鑑の配信を確認できませんでした。');
          if (parsed.success === false) {
            if (/^GET_DISABLED(?:[:]|$)/.test(String(parsed.error))) {
              if (attempt === 1) console.warn('[brand-guide] response rejected', action, 'CONTENT_REDIRECT_FAILED', metadata);
              fail('最新版を取得できませんでした。次回もう一度確認します。', 'CONTENT_REDIRECT_FAILED', true);
            }
            const detail = String(parsed.error || 'UNKNOWN')
              .split(token || '\u0000').join('[redacted]')
              .replace(/https?:\/\/\S+/g, '[url]')
              .replace(/[A-Za-z0-9_.~-]{28,}/g, '[redacted]')
              .slice(0, 240);
            console.warn('[brand-guide] response rejected', action, detail, metadata);
            if (String(parsed.error).startsWith('UNAUTHORIZED')) {
              if (publicRead) fail('図鑑の配信設定を確認できませんでした。', 'PUBLIC_READ_UNAVAILABLE');
              fail(credentialProvider ? '図鑑の接続が切れています。接続設定を行ってください。' : '店舗アプリの接続設定を確認してください。', 'AUTH_REQUIRED');
            }
            // A pinned release has changed. Never repeat this obsolete request;
            // the outer recovery cycle must start with a fresh manifest instead.
            if (parsed.error === 'BRAND_GUIDE_REFRESH_REQUIRED') fail('資料の配信版が変更されました。', 'RELEASE_CHANGED');
            if (parsed.error === 'BRAND_GUIDE_UNAVAILABLE') fail(publicRead ? '図鑑の配信元で資料を取得できませんでした。' : '図鑑の配信元で資料を取得できませんでした。接続情報は保存されています。', 'RELEASE_UNAVAILABLE');
            fail('最新版を取得できませんでした。次回もう一度確認します。');
          }
          if (action === 'getBrandGuideManifest' && parsed.success !== true) fail('図鑑の更新情報を確認できませんでした。');
          return action === 'getBrandGuidePackage' && body.transport !== 'chunks-v1' ? raw : parsed.data;
        } catch (error) {
          if (controller.signal.aborted) throw readFailure(error, controller.signal);
          if (!error?.retryable || attempt === 1) throw error;
          console.warn('[brand-guide] retry read', action, error.code, metadata);
          // Repeat only this allowlisted read, once, after a bounded pause. The
          // original deadline includes both responses and this waiting period.
          await waitToRetry(controller.signal);
        }
      }
    } finally { clearTimeout(timer); }
  }
  function validateManifest(m) {
    if (!m || ![1, 2].includes(m.schemaVersion) || !Number.isSafeInteger(m.revision) || m.revision < 1
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !/^\d{4}-\d{2}-\d{2}$/.test(m.updatedAt) || !Number.isFinite(Date.parse(m.updatedAt)) || new Date(m.updatedAt).toISOString().slice(0, 10) !== m.updatedAt
      || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > 48 * 1024 * 1024) fail('図鑑の更新情報が正しくありません。');
    if (m.schemaVersion === 2) {
      if (m.transport !== 'assets-v2' || m.bytes > 16 * 1024 * 1024) fail('写真の配信情報が正しくありません。');
      return m;
    }
    if (m.transport !== undefined && (m.transport !== 'chunks-v1' || !Number.isSafeInteger(m.characters)
      || m.characters < 1 || m.characters > m.bytes || m.chunkCharacters !== 4 * 1024 * 1024)) fail('図鑑の分割情報が正しくありません。');
    return m;
  }
  async function receivePackage(manifest, token, guide, onStatus) {
    if (manifest.transport !== 'chunks-v1') return request('getBrandGuidePackage', token, { sha256: manifest.sha256 }, guide.MAX_BYTES);
    const count = Math.ceil(manifest.characters / manifest.chunkCharacters), parts = new Array(count);
    let received = 0;
    const receive = async index => {
      const offset = index * manifest.chunkCharacters, length = Math.min(manifest.chunkCharacters, manifest.characters - offset);
      const part = await request('getBrandGuidePackage', token, { sha256: manifest.sha256, revision: manifest.revision, transport: 'chunks-v1', offset }, manifest.chunkCharacters * 6 + 65536);
      if (!part || part.format !== 'private-brand-guide-chunk' || part.schemaVersion !== 1 || part.sha256 !== manifest.sha256
        || part.revision !== manifest.revision || part.bytes !== manifest.bytes || part.characters !== manifest.characters
        || part.offset !== offset || part.nextOffset !== offset + length || typeof part.content !== 'string' || part.content.length !== length) {
        fail('資料の一部を確認できませんでした。');
      }
      parts[index] = part.content; received++;
      onStatus(`図鑑を受け取っています… ${received}/${count}`);
    };
    // Start after the first part validates; continue at most three read-only requests;
    // end after every part matches one revision, or stop and retain the saved library.
    await receive(0);
    for (let index = 1; index < count; index += 3) {
      const settled = await Promise.allSettled(Array.from({ length: Math.min(3, count - index) }, (_, n) => receive(index + n)));
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    return parts.join('');
  }
  function run({ guide, onStatus = () => {}, onSaved = () => {}, force = false }) {
    if (pending) return pending;
    if (navigator.onLine === false) { onStatus('圏外です。保存済みの図鑑を使えます。'); return Promise.resolve(); }
    const now = Date.now();
    if (!force && retryAt && now < retryAt) return Promise.resolve({ status: 'retry-pending', retryAt });
    const recovering = !force && retryAt > 0;
    if (!force && !recovering && lastAttempt && now - lastAttempt < INTERVAL) return Promise.resolve();
    if (!recovering) recoveryStep = 0;
    retryAt = 0; lastAttempt = now;
    pending = (async () => {
      let reading = true;
      try {
        onStatus('最新版を確認しています…');
        const token = publicRead ? '' : await (credentialProvider ? credentialProvider() : credential());
        if (!publicRead && !/^[A-Za-z0-9._~-]{32,256}$/.test(token)) fail(credentialProvider ? 'この図鑑はまだ接続されていません。「今すぐ更新を確認」から初回接続を行ってください。' : '店舗アプリの接続設定を一度行うと、自動で図鑑を保存できます。', 'AUTH_REQUIRED');
        const manifest = validateManifest(await request('getBrandGuideManifest', token, { transport: 'assets-v2' }));
        if (publicRead && manifest.transport !== 'assets-v2') fail('図鑑の配信形式を確認できませんでした。');
        const old = await guide.load();
        if (old?.sha === manifest.sha256) {
          let repaired = false;
          // The index can be current while browser storage has lost or damaged
          // a photo. Audit its content before reporting a complete local copy.
          if (manifest.transport === 'assets-v2' && old.schemaVersion === 2) {
            const photos = await guide.prepareAssets(old.data, bundle => request('getBrandGuidePackage', token,
              { transport: 'assets-v2', sha256: manifest.sha256, revision: manifest.revision, assetBundleSha: bundle.sha256 }, bundle.bytes + 65536), onStatus);
            repaired = photos.fetchedBundles > 0;
          }
          retryAt = recoveryStep = 0; onStatus(repaired ? '写真の確認と修復が完了しました。' : '最新版を保存済みです。ファイル選択は不要です。');
          return { status: 'current', record: old, repaired };
        }
        if (old && (old.data.updatedAt > manifest.updatedAt || (old.remoteRevision || 0) > manifest.revision)) fail('配信中の資料が古いため、保存済みの図鑑を使います。');
        onStatus('図鑑を受け取っています…');
        const raw = manifest.transport === 'assets-v2'
          ? await request('getBrandGuidePackage', token, { transport: 'assets-v2', sha256: manifest.sha256, revision: manifest.revision }, manifest.bytes + 65536)
          : await receivePackage(manifest, token, guide, onStatus);
        if (manifest.transport === 'assets-v2') {
          const index = await guide.parsePackage(raw);
          if (index.schemaVersion !== 2 || index.sha !== manifest.sha256 || index.data.updatedAt !== manifest.updatedAt) fail('写真の資料と更新情報が一致しません。');
          await guide.prepareAssets(index.data, bundle => request('getBrandGuidePackage', token,
            { transport: 'assets-v2', sha256: manifest.sha256, revision: manifest.revision, assetBundleSha: bundle.sha256 }, bundle.bytes + 65536), onStatus);
        }
        if (new TextEncoder().encode(raw).length !== manifest.bytes) fail('資料を最後まで受け取れませんでした。');
        onStatus('図鑑を保存しています…');
        reading = false;
        const record = await guide.importFile({ size: manifest.bytes, text: async () => raw }, manifest, onStatus);
        retryAt = recoveryStep = 0;
        onSaved(record); onStatus('自動保存が完了しました。通信なしでも見られます。');
        return { status: 'saved', record };
      } catch (error) {
        const diagnosticCode = /^[A-Z][A-Z0-9_]{0,59}$/.test(error?.code || '') ? error.code : 'UPDATE_FAILED';
        if (diagnosticCode.startsWith('PHOTO_')) console.warn('[brand-guide] update stopped', diagnosticCode, reading ? 'prepare' : 'save');
        const message = error?.name === 'AbortError' ? '通信が遅いため更新を中断しました。' : (error?.message || '更新を確認できませんでした。');
        onStatus(message + ' 保存済みの資料は変更していません。');
        if (error?.code === 'AUTH_REQUIRED') lastAttempt = 0;
        const retryableRead = error?.retryable === true && (RETRYABLE_READ_CODES.has(error.code) || /^HTTP_5\d\d$/.test(error.code || ''));
        // Start a new manifest read after an explicit release change; continue
        // only within the shared recovery budget; never retry a local save.
        if (reading && (retryableRead || error?.code === 'RELEASE_CHANGED') && recoveryStep < RECOVERY_DELAYS.length) {
          retryAt = Date.now() + RECOVERY_DELAYS[recoveryStep++];
          return { status: 'failed', code: error.code || '', retryable: true, retryAt };
        }
        retryAt = 0;
        return { status: error?.code === 'AUTH_REQUIRED' ? 'auth-required' : 'failed', code: error?.code || '', retryable: false };
      } finally { pending = null; }
    })();
    return pending;
  }
  return { run, validateManifest, INTERVAL, configureCredential, configurePublicRead };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BrandGuideSync;
