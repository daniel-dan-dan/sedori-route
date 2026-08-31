// QR接続専用。接続コードと端末鍵はlocalStorageへ保存しない。
(async () => {
  const pairingKey = 'daniel_api_auth_token';
  const deviceTokenKey = 'daniel_route_device_auth_v1';
  const deviceIdKey = 'daniel_route_device_id_v1';
  const pendingTokenKey = 'daniel_route_pending_device_auth_v1';
  const credentialDbName = 'sedori-route-credentials';
  const credentialStoreName = 'credentials';
  const apiUrl = 'https://script.google.com/macros/s/AKfycbwYfwDG7Kqplk2oVeX7kF_gsAKTlK087ToE4LGp5R7PglTFMARP2lrA6ZV9m3MD0LEs/exec';
  const status = document.getElementById('pair-status');
  const retry = document.getElementById('pair-retry');
  const actions = document.getElementById('pair-actions');
  const help = document.getElementById('pair-help');
  const copy = document.getElementById('pair-copy');
  const params = new URLSearchParams(location.hash.slice(1));
  const token = String(params.get('token') || '').trim();
  history.replaceState(null, '', location.pathname);

  function openCredentialDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(credentialDbName, 1);
      request.onupgradeneeded = event => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(credentialStoreName)) {
          database.createObjectStore(credentialStoreName, { keyPath: 'key' });
        }
      };
      request.onsuccess = event => resolve(event.target.result);
      request.onerror = event => reject(event.target.error || new Error('credential_db_open_failed'));
      request.onblocked = () => reject(new Error('credential_db_blocked'));
    });
  }

  async function readCredential(key) {
    const database = await openCredentialDb();
    return new Promise((resolve, reject) => {
      const request = database.transaction(credentialStoreName, 'readonly')
        .objectStore(credentialStoreName).get(key);
      request.onsuccess = () => resolve(String(request.result?.value || ''));
      request.onerror = event => reject(event.target.error || new Error('credential_db_read_failed'));
    });
  }

  async function writeCredential(key, value) {
    const database = await openCredentialDb();
    const normalized = String(value || '').trim();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(credentialStoreName, 'readwrite');
      const store = transaction.objectStore(credentialStoreName);
      if (normalized) store.put({ key, value: normalized, updatedAt: Date.now() });
      else store.delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = event => reject(event.target.error || new Error('credential_db_write_failed'));
      transaction.onabort = event => reject(event.target.error || new Error('credential_db_aborted'));
    });
  }

  async function migrateLegacyCredentials() {
    for (const key of [pairingKey, deviceTokenKey, pendingTokenKey]) {
      const legacy = String(localStorage.getItem(key) || '').trim();
      const stored = await readCredential(key);
      if (!stored && legacy) {
        await writeCredential(key, legacy);
        if (await readCredential(key) !== legacy) throw new Error('credential_migration_readback_failed');
      }
    }
    [pairingKey, deviceTokenKey, pendingTokenKey].forEach(key => localStorage.removeItem(key));
  }

  if (token.length < 24 || token.length > 512 || /\s/.test(token)) {
    status.textContent = '接続コードが見つかりません。店舗アプリ専用のQRコードを読み取ってください。';
    status.classList.add('error');
    return;
  }

  function randomBase64Url(byteLength) {
    if (!globalThis.crypto?.getRandomValues) throw new Error('secure_random_unavailable');
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function getOrCreateDeviceId() {
    const existing = String(localStorage.getItem(deviceIdKey) || '').trim();
    if (/^[A-Za-z0-9._~-]{16,128}$/.test(existing)) return existing;
    const created = `route_${randomBase64Url(24)}`;
    localStorage.setItem(deviceIdKey, created);
    return created;
  }

  async function getOrCreatePendingToken() {
    const existing = String(await readCredential(pendingTokenKey) || '').trim();
    if (/^[A-Za-z0-9._~-]{32,256}$/.test(existing)) return existing;
    const created = `route_dev_${randomBase64Url(32)}`;
    await writeCredential(pendingTokenKey, created);
    return created;
  }

  async function fetchWithTimeout(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function attemptPair() {
    retry.hidden = true;
    status.textContent = 'この端末を安全に接続しています...';
    status.classList.remove('success', 'error');
    try {
      await migrateLegacyCredentials();
      const deviceId = getOrCreateDeviceId();
      const deviceToken = await getOrCreatePendingToken();
      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'registerRouteDevice',
          auth_token: token,
          device_id: deviceId,
          device_token: deviceToken,
        }),
        redirect: 'follow',
      });
      const payload = await response.json();
      if (!payload?.success || !payload?.data?.registered || payload.data.device_id !== deviceId) {
        throw new Error(payload?.error || '接続できませんでした');
      }
      const previousToken = await readCredential(deviceTokenKey);
      try {
        await writeCredential(deviceTokenKey, deviceToken);
        if (await readCredential(deviceTokenKey) !== deviceToken) throw new Error('device_storage_failed');
      } catch (error) {
        await writeCredential(deviceTokenKey, previousToken).catch(() => {});
        throw error;
      }
      await writeCredential(pendingTokenKey, '');
      await writeCredential(pairingKey, '');
      localStorage.removeItem(pairingKey);
      status.textContent = '接続コードを確認し、この端末専用の接続情報を保存しました。今後の更新では再入力不要です。';
      status.classList.add('success');
      actions.hidden = false;
      help.hidden = false;
    } catch (error) {
      console.warn('端末接続に失敗しました:', error);
      status.textContent = '接続を確認できませんでした。接続情報は消さず、もう一度試せます。';
      status.classList.add('error');
      retry.hidden = false;
    }
  }

  function legacyCopy(value) {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, value.length);
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  }

  async function copyToken(value) {
    if (navigator.clipboard && window.isSecureContext) {
      const copied = await Promise.race([
        navigator.clipboard.writeText(value).then(() => true).catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), 1200)),
      ]);
      if (copied) return true;
    }
    return legacyCopy(value);
  }

  retry.addEventListener('click', attemptPair);
  copy.addEventListener('click', async () => {
    status.textContent = '接続コードをコピーしています...';
    try {
      if (!await copyToken(token)) throw new Error('copy_failed');
      status.textContent = '接続コードをコピーしました。店舗アプリの設定欄へ貼り付けてください。';
    } catch (_error) {
      status.textContent = 'コピーできませんでした。このページを同じブラウザで開き直してください。';
      status.classList.remove('success');
      status.classList.add('error');
    }
  });

  await attemptPair();
})();
