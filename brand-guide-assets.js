/* Content-addressed private photos. No network, permissions or credentials here. */
const BrandGuideAssets = (() => {
  'use strict';
  const DB_NAME = 'sedori-private-guide-images';
  const SHA = /^[a-f0-9]{64}$/;
  const JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
  const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
  const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
  const MAX_IMAGE_CHARACTERS = 2800000;
  function check(ok, message = '写真の資料を確認できません。以前の図鑑は残しています。') { if (!ok) throw new Error(message); }
  function storageError(code, message) { const error = new Error(message); error.code = code; return error; }
  function photos(data) { return [...data.brands.flatMap(b => b.groups.flatMap(g => g.photos)), ...(data.allGenre?.products || []).map(p => p.photo)]; }
  function photoValid(photo, references = false) {
    return Boolean(photo && (typeof photo.image === 'string' && photo.image.length <= MAX_IMAGE_CHARACTERS && JPEG.test(photo.image) && photo.assetSha256 === undefined || references && photo.image === undefined && SHA.test(photo.assetSha256)));
  }
  function validateManifest(value) {
    check(value?.version === 1 && Array.isArray(value.bundles) && value.bundles.length > 0 && value.bundles.length <= 512);
    const bundles = new Set(), images = new Set(); let bytes = 0;
    for (const b of value.bundles) {
      check(b && SHA.test(b.sha256) && !bundles.has(b.sha256) && Number.isSafeInteger(b.bytes) && b.bytes > 0 && b.bytes <= MAX_BUNDLE_BYTES);
      check(Array.isArray(b.imageShas) && b.imageShas.length > 0 && b.imageShas.length <= 100);
      for (const hash of b.imageShas) { check(typeof hash === 'string' && SHA.test(hash) && !images.has(hash)); images.add(hash); }
      bundles.add(b.sha256); bytes += b.bytes;
    }
    check(bytes <= MAX_ASSET_BYTES && images.size <= 8000);
    return { imageShas: images, totalBytes: bytes };
  }
  function validateIndex(data) {
    const manifest = validateManifest(data.assetManifest), used = new Set();
    for (const p of photos(data)) { check(photoValid(p, true) && p.image === undefined && manifest.imageShas.has(p.assetSha256)); used.add(p.assetSha256); }
    check(used.size === manifest.imageShas.size, '写真一覧と商品資料が一致しません。');
    return manifest;
  }
  async function digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  function imageBytes(image) {
    check(typeof image === 'string' && image.length <= MAX_IMAGE_CHARACTERS && JPEG.test(image));
    const binary = atob(image.slice('data:image/jpeg;base64,'.length));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    check(bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255);
    return bytes;
  }
  async function parseBundle(raw, expected) {
    check(typeof raw === 'string'); const bytes = new TextEncoder().encode(raw);
    check(bytes.length === expected.bytes && bytes.length <= MAX_BUNDLE_BYTES && await digest(bytes) === expected.sha256);
    const value = JSON.parse(raw);
    check(value.format === 'private-brand-guide-assets' && value.schemaVersion === 1 && Array.isArray(value.images) && value.images.length === expected.imageShas.length);
    const known = new Set(expected.imageShas), seen = new Set();
    for (const item of value.images) {
      check(item && SHA.test(item.sha256) && known.has(item.sha256) && !seen.has(item.sha256));
      check(await digest(imageBytes(item.image)) === item.sha256, '写真の内容が一致しません。'); seen.add(item.sha256);
    }
    return value.images;
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      let ended = false, req;
      const finish = (value, error) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(null, new Error('写真の保存場所を開けません。')), 10000);
      try { req = indexedDB.open(DB_NAME, 1); } catch (error) { finish(null, error); return; }
      req.onupgradeneeded = () => { for (const name of ['images', 'bundles', 'library']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name); };
      req.onerror = req.onblocked = () => finish(null, new Error('写真の保存場所を開けません。'));
      req.onsuccess = () => { const db = req.result; if (ended) { db.close(); return; } db.onversionchange = () => db.close(); finish(db); };
    });
  }
  async function read(storeName, key) {
    const db = await openDB();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly'), req = tx.objectStore(storeName).get(key);
      const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error('写真を読み込めません。')); }, 10000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(req.result); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error('写真を読み込めません。')); };
    }); } finally { db.close(); }
  }
  async function imageState(saved, hash) {
    if (!saved) return 'missing';
    if (saved.sha256 !== hash) return 'corrupt';
    let bytes;
    try { bytes = imageBytes(saved.image); } catch { return 'corrupt'; }
    return await digest(bytes) === hash ? 'valid' : 'corrupt';
  }
  async function inspectBundle(bundle) {
    const db = await openDB(); let snapshot;
    try { snapshot = await new Promise((resolve, reject) => {
      // Read one coherent, bounded bundle snapshot. Hashing runs after this
      // transaction ends, so awaiting crypto cannot make its transaction inactive.
      const tx = db.transaction(['images', 'bundles'], 'readonly');
      const marker = tx.objectStore('bundles').get(bundle.sha256);
      const store = tx.objectStore('images'), images = bundle.imageShas.map(hash => store.get(hash));
      const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(storageError('PHOTO_READ_TIMEOUT', '保存した写真の確認に時間がかかっています。')); }, 15000);
      tx.oncomplete = () => { clearTimeout(timer); resolve({ marker: marker.result, images: images.map(request => request.result) }); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error || storageError('PHOTO_READ_FAILED', '保存した写真を読み込めません。')); };
    }); } finally { db.close(); }
    const marker = snapshot.marker;
    const markerValid = Boolean(marker && marker.sha256 === bundle.sha256 && marker.bytes === bundle.bytes && JSON.stringify(marker.imageShas) === JSON.stringify(bundle.imageShas));
    let missing = 0, corrupt = 0;
    for (let index = 0; index < bundle.imageShas.length; index++) {
      const state = await imageState(snapshot.images[index], bundle.imageShas[index]);
      if (state === 'missing') missing++; else if (state === 'corrupt') corrupt++;
    }
    return { valid: markerValid && !missing && !corrupt, missingMarker: !markerValid, missing, corrupt };
  }
  async function saveBundle(raw, bundle) {
    const images = await parseBundle(raw, bundle), db = await openDB();
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction(['images', 'bundles'], 'readwrite'); let failure;
      const abort = error => { failure = error; try { tx.abort(); } catch {} };
      const timer = setTimeout(() => abort(new Error('写真の保存が完了しませんでした。')), 20000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(failure || tx.error || new Error('写真を保存できません。')); };
      try {
        const store = tx.objectStore('images');
        for (const image of images) store.put(image, image.sha256).onsuccess = () => {
          store.get(image.sha256).onsuccess = event => { if (event.target.result?.image !== image.image) abort(new Error('保存した写真が一致しません。')); };
        };
        tx.objectStore('bundles').put(bundle, bundle.sha256);
      } catch (error) { abort(error); }
    }); } finally { db.close(); }
    // A read inside the write transaction only proves its pending view. Check
    // a fresh transaction before downloading the next bundle or claiming success.
    const saved = await inspectBundle(bundle);
    if (!saved.valid) throw storageError(saved.corrupt ? 'PHOTO_STORAGE_CORRUPT' : 'PHOTO_STORAGE_LOST',
      saved.corrupt ? '保存直後の写真が一致しません。端末の保存状態を確認してください。' : '保存直後の写真が見つかりません。端末の空き容量とブラウザの保存設定を確認してください。');
  }
  async function prepare(data, receive, onStatus = () => {}) {
    validateIndex(data); const pending = [], bundles = data.assetManifest.bundles;
    const audit = { checkedBundles: 0, missingMarkers: 0, missingImages: 0, corruptImages: 0 };
    try {
      onStatus('保存済みの写真を確認しています…');
      for (const b of bundles) {
        const state = await inspectBundle(b); audit.checkedBundles++;
        audit.missingMarkers += Number(state.missingMarker); audit.missingImages += state.missing; audit.corruptImages += state.corrupt;
        if (!state.valid) pending.push(b);
        if (audit.checkedBundles % 8 === 0 || audit.checkedBundles === bundles.length) onStatus(`保存済みの写真を確認しています… ${audit.checkedBundles}/${bundles.length}`);
      }
      // Counts only: never log image content, product data, URLs or credentials.
      if (typeof console !== 'undefined') console.info?.('[brand-guide] photo audit', audit);
      let done = 0;
      const next = async b => { const raw = await receive(b); await saveBundle(raw, b); done++; onStatus(`写真を保存しています… ${done}/${pending.length}`); };
      // Begin with one invalid/missing bundle; continue at most two verified
      // read-only downloads; stop on any failure after draining the current batch.
      if (pending.length) await next(pending[0]);
      for (let i = 1; i < pending.length; i += 2) {
        const settled = await Promise.allSettled(pending.slice(i, i + 2).map(next));
        const failed = settled.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
      }
      return { fetchedBundles: pending.length, ...audit };
    } catch (error) {
      if (error?.name === 'QuotaExceededError') throw storageError('PHOTO_STORAGE_FULL', '端末の空き容量が足りないため、写真を保存できません。');
      throw error;
    }
  }
  async function imageURI(photo) {
    if (photoValid(photo)) return photo.image;
    check(photoValid(photo, true)); const saved = await read('images', photo.assetSha256);
    const state = await imageState(saved, photo.assetSha256);
    if (state !== 'valid') throw storageError(state === 'missing' ? 'PHOTO_MISSING' : 'PHOTO_CORRUPT',
      state === 'missing' ? '保存した写真の一部が見つかりません。「今すぐ更新を確認」で取り直せます。' : '保存した写真の一部が壊れています。「今すぐ更新を確認」で取り直せます。');
    return saved.image;
  }
  function loadRecord() { return read('library', 'active'); }
  async function saveRecord(record) {
    const db = await openDB();
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction('library', 'readwrite'), store = tx.objectStore('library'); let failure;
      const abort = error => { failure = error; try { tx.abort(); } catch {} };
      const timer = setTimeout(() => abort(new Error('商品資料の保存が完了しませんでした。')), 20000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(failure || tx.error || new Error('商品資料を保存できません。')); };
      store.get('active').onsuccess = event => {
        const old = event.target.result;
        if (old && (old.data?.updatedAt > record.data.updatedAt || old.remoteRevision && record.remoteRevision && old.remoteRevision > record.remoteRevision)) { abort(new Error('以前の版への更新は行いません。')); return; }
        if (old?.sha === record.sha && old.remoteRevision) record.remoteRevision = Math.max(old.remoteRevision, record.remoteRevision || 0);
        try { store.put(record, 'active').onsuccess = () => {
          store.get('active').onsuccess = readback => { if (readback.target.result?.sha !== record.sha) abort(new Error('保存内容が一致しません。')); };
        }; } catch (error) { abort(error); }
      };
    }); } finally { db.close(); }
  }
  return { DB_NAME, MAX_BUNDLE_BYTES, MAX_ASSET_BYTES, photoValid, photos, validateManifest, validateIndex, parseBundle, saveBundle, prepare, imageURI, digest, loadRecord, saveRecord };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BrandGuideAssets;
