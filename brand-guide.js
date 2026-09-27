/* Private, offline encyclopedia. Transport is isolated in brand-guide-sync.js. */
const BrandGuide = (() => {
  'use strict';
  const DB_NAME = 'sedori-private-brand-guide';
  const MAX_BYTES = 40 * 1024 * 1024;
  let importing = false;
  let query = '';
  const text = (value, max = 3000) => typeof value === 'string' && value.length <= max;
  function check(ok, message = '資料の形式が違います。専用ファイルを選んでください。') {
    if (!ok) throw new Error(message);
  }
  function sourceOK(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
  }
  function normalize(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/[\s・&＆._-]/g, '');
  }
  function matches(brand, value) {
    return normalize([brand.name, ...brand.aliases].join(' ')).includes(normalize(value));
  }
  // Keep source descriptions intact; the timeline only shows their year span.
  function tagPeriod(period) {
    const value = period.normalize('NFKC');
    const years = [...value.matchAll(/(?:18|19|20)\d{2}(?:年代)?/g)]
      .map(match => ({ year: Number(match[0].slice(0, 4)), decade: match[0].endsWith('年代') }));
    // Older packages sometimes start with a seller's abbreviated season.
    for (const match of value.matchAll(/(?<!\d)(\d{2})(?:SS|AW|FW)(?![A-Z])/gi)) {
      years.push({ year: 2000 + Number(match[1]), decade: false });
    }
    if (!years.length) return { label: '年代不明', year: Infinity };
    years.sort((a, b) => a.year - b.year);
    const first = years[0], last = years[years.length - 1];
    const decade = years.some(item => item.decade);
    return { label: first.year === last.year
      ? `${first.year}${decade ? '年代' : '年'}`
      : `${first.year}〜${last.year}${decade ? '年代' : '年'}`, year: first.year };
  }
  function tagTimeline(groups) {
    return groups.map(group => ({ ...group, displayPeriod: tagPeriod(group.period) }))
      .sort((a, b) => a.displayPeriod.year - b.displayPeriod.year);
  }
  function isBackSwipe(start, end) {
    if (!start || !end || end.time < start.time || end.time - start.time > 1000) return false;
    const dx = end.x - start.x, dy = Math.abs(end.y - start.y);
    return dx >= 80 && dy <= 60 && dx > dy * 1.5;
  }
  function validate(data) {
    check(data && data.version === 1 && text(data.updatedAt, 10) && /^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt) && Number.isFinite(Date.parse(data.updatedAt)));
    check(new Date(data.updatedAt).toISOString().slice(0, 10) === data.updatedAt);
    check(Array.isArray(data.brands) && data.brands.length >= 1 && data.brands.length <= 200, '1〜200ブランド入りの図鑑ファイルを選んでください。');
    const ids = new Set(); const names = new Set(); let photos = 0; let size = 0;
    for (const b of data.brands) {
      check(b && /^[a-z0-9-]{1,60}$/.test(b.id) && !ids.has(b.id)); ids.add(b.id);
      check(text(b.name, 100) && b.name && !names.has(b.name)); names.add(b.name);
      check(Array.isArray(b.aliases) && b.aliases.length < 20 && b.aliases.every(a => text(a, 100)));
      check(Array.isArray(b.groups) && b.groups.length <= 20);
      check(b.groups.length > 0 || (b.photoStatus === 'uncollected' && Array.isArray(b.sources) && b.sources.length > 0));
      for (const g of b.groups) {
        check(text(g.period, 150) && Array.isArray(g.photos) && g.photos.length > 0 && g.photos.length <= 20);
        for (const p of g.photos) {
          check(p && text(p.image, 2800000) && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image));
          check(sourceOK(p.source) && text(p.basis, 3000) && typeof p.currentOfficial === 'boolean');
          size += p.image.length; photos++;
        }
      }
      check(b.method && ['code', 'highlight', 'result', 'how', 'caution', 'mode'].every(k => text(b.method[k])));
      if (b.method.quickGuide !== undefined) {
        const q = b.method.quickGuide;
        check(q && ['target', 'reading', 'result', 'note', 'highlight'].every(k => text(q[k], 180)));
        check(Number.isSafeInteger(q.start) && q.start >= -1 && q.start <= b.method.code.length);
        check(!q.highlight || (q.start >= 0 && b.method.code.slice(q.start, q.start + q.highlight.length) === q.highlight));
        check(Array.isArray(q.rows) && q.rows.length <= 40 && q.rows.every(r => Array.isArray(r) && r.length === 2 && r.every(v => text(v, 100))));
      }
      check(Array.isArray(b.sources) && b.sources.length <= 30 && b.sources.every(s => text(s.title, 400) && sourceOK(s.url)));
    }
    check(photos <= 600 && size <= MAX_BYTES);
    const a = data.baycrews;
    check(a && text(a.title) && text(a.how) && text(a.caution));
    check(Array.isArray(a.confirmed) && a.confirmed.length <= 200 && a.confirmed.every(s => text(s, 100)));
    check(Array.isArray(a.unconfirmed) && a.unconfirmed.length <= 200 && a.unconfirmed.every(s => text(s, 100)));
    check(Array.isArray(a.examples) && a.examples.length <= 200 && a.examples.every(e => text(e.brand) && text(e.code) && text(e.year) && sourceOK(e.url)));
    check(sourceOK(a.source));
    return { brands: data.brands.length, photos };
  }
  async function parsePackage(raw) {
    check(typeof raw === 'string' && new TextEncoder().encode(raw).length <= MAX_BYTES, 'ファイルが大きすぎます（上限40MB）。');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('ファイルを読めませんでした。専用ファイルを選び直してください。'); }
    check(envelope && envelope.format === 'private-brand-guide' && envelope.schemaVersion === 1 && text(envelope.payload, MAX_BYTES) && /^[a-f0-9]{64}$/.test(envelope.sha256));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope.payload));
    const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    check(sha === envelope.sha256, 'ファイルの一部が壊れています。元のファイルをもう一度取り込んでください。');
    const data = JSON.parse(envelope.payload); validate(data);
    return { data, sha };
  }
  function openDB() {
    return new Promise((resolve, reject) => {
      let done = false; let req;
      const fail = error => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => fail(new Error('保存場所を開けません。他の店舗アプリのタブを閉じてお試しください。')), 10000);
      try { req = indexedDB.open(DB_NAME, 1); } catch (error) { fail(error); return; }
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('library')) req.result.createObjectStore('library'); };
      req.onerror = () => fail(req.error || new Error('端末の保存機能を使えません。'));
      req.onblocked = () => fail(new Error('他のタブが保存場所を使っています。他の店舗アプリのタブを閉じてください。'));
      req.onsuccess = () => {
        if (done) { req.result.close(); return; }
        done = true; clearTimeout(timer); req.result.onversionchange = () => req.result.close(); resolve(req.result);
      };
    });
  }
  async function load() {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('library', 'readonly'); const req = tx.objectStore('library').get('active');
        const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error('資料の読み出しに時間がかかっています。開き直してください。')); }, 15000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(req.result || null); };
        tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error('保存済み資料を読めません。')); };
      });
    } finally { db.close(); }
  }
  async function save(record) {
    const db = await openDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('library', 'readwrite'); const store = tx.objectStore('library');
        let failure;
        const abort = error => { failure = error; try { tx.abort(); } catch {} };
        const timer = setTimeout(() => abort(new Error('保存が完了しませんでした。以前の資料は変更していません。')), 20000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(); };
        tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(failure || tx.error || new Error('保存に失敗しました。')); };
        store.get('active').onsuccess = event => {
          try {
          const old = event.target.result;
          if (old && old.data.updatedAt > record.data.updatedAt) { abort(new Error('保存済みの資料より古いファイルです。新しい資料を選んでください。')); return; }
          if (old?.remoteRevision && record.remoteRevision && old.remoteRevision > record.remoteRevision) { abort(new Error('以前の版への更新は行いません。')); return; }
          if (old?.sha === record.sha && old.remoteRevision) record.remoteRevision = Math.max(old.remoteRevision, record.remoteRevision || 0);
          const write = store.put(record, 'active');
          write.onsuccess = () => {
            store.get('active').onsuccess = read => {
              if (read.target.result?.sha !== record.sha) abort(new Error('保存内容を確認できません。'));
            };
          };
          } catch (error) { abort(error); }
        };
      });
    } finally { db.close(); }
  }
  async function verifyImages(data) {
    // Start after package validation; inspect each image; finish only when all decode.
    for (const b of data.brands) for (const g of b.groups) for (const p of g.photos) {
      await new Promise((resolve, reject) => {
        const img = new Image();
        const timer = setTimeout(() => finish(new Error('写真を読み込めませんでした。')), 10000);
        const finish = error => { clearTimeout(timer); img.onload = img.onerror = null; img.src = ''; error ? reject(error) : resolve(); };
        img.onload = () => finish(img.naturalWidth > 0 && img.naturalWidth <= 4096 && img.naturalHeight <= 4096 && img.naturalWidth * img.naturalHeight <= 12000000 ? null : new Error('写真のサイズが不正です。'));
        img.onerror = () => finish(new Error('壊れた写真があります。以前の資料は変更していません。'));
        img.src = p.image;
      });
    }
  }
  async function importFile(file, expected = null) {
    if (importing) throw new Error('取り込み中です。完了までお待ちください。');
    importing = true;
    try {
      check(file && file.size <= MAX_BYTES, '40MB以下の専用ファイルを選んでください。');
      const record = await parsePackage(await file.text());
      if (expected) {
        check(record.sha === expected.sha256 && record.data.updatedAt === expected.updatedAt, '更新情報と資料が一致しません。次回もう一度確認します。');
        check(Number.isSafeInteger(expected.revision) && expected.revision > 0);
        record.remoteRevision = expected.revision;
      }
      await verifyImages(record.data);
      await save({ ...record, savedAt: new Date().toISOString() });
      return record;
    } catch (error) {
      if (error.name === 'QuotaExceededError') throw new Error('端末の空き容量が足りません。以前の図鑑は残しています。');
      throw error;
    } finally { importing = false; }
  }
  function el(tag, cls, value) {
    const node = document.createElement(tag); if (cls) node.className = cls; if (value !== undefined) node.textContent = value; return node;
  }
  function button(label, action, cls = 'bg-button') {
    const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  function link(label, url) {
    const a = el('a', 'bg-source', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer'; return a;
  }
  function showPhoto(photo, name, root, trigger) {
    const dialog = el('dialog', 'bg-lightbox');
    dialog.setAttribute('aria-label', name + 'のタグ拡大');
    const img = el('img', 'bg-large-photo'); img.src = photo.image; img.alt = name + 'のブランドタグ';
    const close = () => dialog.close();
    dialog.append(button('閉じる ×', close), el('p', 'bg-muted', '指で広げると拡大できます'), img);
    dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    root.append(dialog); dialog.showModal();
  }
  async function render(container, options = {}) {
    const root = el('section', 'brand-guide'); container.replaceChildren(root);
    const isLive = () => root.isConnected && container.contains(root);
    if (options.standalone) root.classList.add('bg-compact');
    else {
      const top = el('div', 'bg-top');
      top.append(button('‹ 店舗アプリ', () => Router.navigate('home'), 'bg-text-button'), el('span', 'bg-eyebrow', 'PRIVATE LIBRARY'));
      root.append(top);
    }
    root.append(el('h1', 'bg-title', options.standalone ? 'ブランド図鑑' : '古着図鑑'));
    if (!options.standalone) root.append(el('p', 'bg-subtitle', 'タグと型番で、何年ごろの服かを調べる'));
    const status = el('p', 'bg-status', '保存済みの資料を確認中…'); status.setAttribute('role', 'status'); if (!options.standalone) root.append(status);
    const offlineStatus = el('p', 'bg-muted bg-offline-status', '通信なしで開くための画面を準備しています。'); if (!options.standalone) root.append(offlineStatus);
    if (navigator.serviceWorker) {
      (options.serviceWorkerReady || navigator.serviceWorker.ready).then(registration => {
        if (!registration) { if (isLive()) offlineStatus.textContent = '画面の保存を確認できません。通信できる場所で開き直してください。'; return; }
        const expected = document.getElementById('app-version-badge')?.dataset.version;
        const timer = setTimeout(() => {
          navigator.serviceWorker.removeEventListener('message', versionReceived);
          if (isLive()) offlineStatus.textContent = '画面の保存を確認できません。通信できる場所で開き直してください。';
        }, 5000);
        function versionReceived(event) {
          if (event.data?.type !== 'SW_VERSION') return;
          clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', versionReceived);
          if (!isLive()) return;
          offlineStatus.textContent = event.data.cacheName === (options.cachePrefix || 'sedori-route-') + expected
            ? '画面の保存も完了 · 取り込み済みの資料は通信なしで開けます'
            : (options.standalone ? '画面の更新準備中です。ブランド図鑑の全タブを閉じ、開き直してください。' : '画面の更新準備中です。店舗アプリの全タブを閉じ、開き直してください。');
        }
        navigator.serviceWorker.addEventListener('message', versionReceived);
        registration.active?.postMessage({ type: 'GET_VERSION' });
      }).catch(() => {});
    } else offlineStatus.textContent = 'このブラウザでは通信なしでの起動に対応していません。';
    const syncStatus = el('p', 'bg-status', '図鑑を開くと、自動で最新版を確認します。'); syncStatus.setAttribute('role', 'status'); if (!options.standalone) root.append(syncStatus);
    const controls = el('details', 'bg-import'); controls.append(el('summary', '', '更新・接続設定'));
    controls.append(el('p', '', options.standalone ? '非公開の資料をこの図鑑に保存します。開いている間は15分ごとに更新を確認します。' : '店舗アプリに接続済みなら、非公開の配信先から自動で保存します。開いている間は15分ごとに更新を確認します。'));
    const retry = button('今すぐ更新を確認', () => sync(true));
    controls.append(retry, button(options.standalone ? '図鑑の接続設定' : '店舗アプリの接続設定', options.standalone ? options.onConnection : () => window.location.assign('index.html#settings'), 'bg-text-button'));
    const manual = el('details'); manual.append(el('summary', '', '予備のファイルから取り込む'));
    const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.setAttribute('aria-label', '図鑑の専用ファイル');
    input.disabled = true;
    manual.append(input, el('p', 'bg-muted', '通常はファイル選択不要です。圏外での復旧用に使えます。')); controls.append(manual);
    if (options.standalone) { status.hidden = true; offlineStatus.hidden = true; syncStatus.hidden = true; controls.append(status, offlineStatus, syncStatus); }
    const body = el('div', 'bg-body'); root.append(body, controls);
    let currentRecord = null;
    async function sync(force = false) {
      if (!isLive() || typeof BrandGuideSync === 'undefined') return;
      retry.disabled = true; input.disabled = true;
      try {
        const result = await BrandGuideSync.run({ guide: { load, importFile, MAX_BYTES }, force,
          onStatus: message => { if (isLive()) { syncStatus.textContent = message; syncStatus.hidden = false; } },
          onSaved: record => {
            if (!isLive()) return;
            // Keep an open photo/article intact; switch contents after returning to list.
            if (currentRecord && root.classList.contains('bg-viewing')) {
              const notice = button('新しい資料を表示', () => { showLibrary(record); notice.remove(); });
              root.insertBefore(notice, body);
            } else showLibrary(record);
          },
        });
        if (options.standalone && ['saved', 'current'].includes(result?.status)) syncStatus.hidden = true;
        if (result?.status === 'auth-required' && isLive()) {
          controls.open = true;
          if (force && options.standalone && options.onConnection) options.onConnection();
        }
      } finally { if (isLive()) { retry.disabled = false; if (!importing) input.disabled = false; } }
    }
    function showLibrary(record) {
      currentRecord = record;
      root.classList.remove('bg-viewing');
      const data = record.data; const counts = validate(data);
      status.hidden = Boolean(options.standalone);
      status.textContent = `保存済み · ${counts.brands}ブランド / 写真${counts.photos}枚 · 資料更新 ${data.updatedAt}`;
      body.replaceChildren();
      const label = el('label', 'bg-search-label', options.standalone ? '' : 'ブランドを探す');
      const search = el('input', 'bg-search'); search.type = 'search'; search.setAttribute('aria-label', 'ブランド検索'); search.placeholder = '例：バトナー / BATONER'; search.value = query; label.append(search);
      const list = el('div', 'bg-brand-list'); const detail = el('div', 'bg-brand-detail');
      const count = el('p', 'bg-muted'); count.setAttribute('role', 'status');
      body.append(label, count, list, detail);
      function returnToList() {
        root.classList.remove('bg-viewing'); detail.replaceChildren();
        label.hidden = count.hidden = list.hidden = false;
        window.scrollTo(0, 0);
      }
      let swipeStart = null;
      detail.addEventListener('touchstart', event => {
        swipeStart = null;
        if (!root.classList.contains('bg-viewing') || event.touches.length !== 1 || event.target.closest('dialog,input,textarea,select')) return;
        const touch = event.touches[0];
        swipeStart = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, id: touch.identifier };
      }, { passive: true });
      detail.addEventListener('touchmove', event => { if (event.touches.length !== 1) swipeStart = null; }, { passive: true });
      detail.addEventListener('touchcancel', () => { swipeStart = null; }, { passive: true });
      detail.addEventListener('touchend', event => {
        const start = swipeStart; swipeStart = null;
        if (!start || event.touches.length || !root.classList.contains('bg-viewing') || root.querySelector('dialog[open]')) return;
        const touch = Array.from(event.changedTouches).find(t => t.identifier === start.id);
        if (touch && isBackSwipe(start, { x: touch.clientX, y: touch.clientY, time: event.timeStamp })) returnToList();
      }, { passive: true });
      function drawList() {
        list.replaceChildren(); const found = data.brands.filter(b => matches(b, query)); count.textContent = `${found.length}ブランド`;
        for (const b of found) {
          const btn = button('', () => showBrand(b), 'bg-brand-card');
          btn.append(el('span', 'bg-brand-name', b.name), el('span', 'bg-brand-kana', b.aliases[0] || ''), el('span', 'bg-card-arrow', '›')); list.append(btn);
        }
        if (!found.length) list.append(el('p', '', '見つかりません。日本語または英語のブランド名を短く入力してください。'));
        list.append(button('ベイクルーズ系列の共通する読み方', showBaycrews, 'bg-appendix-entry'));
      }
      function startDetail(title) {
        root.classList.add('bg-viewing');
        label.hidden = count.hidden = list.hidden = true; detail.replaceChildren();
        detail.append(button('‹ 戻る', returnToList, 'bg-text-button'));
        const heading = el('h2', 'bg-brand-heading', title); heading.tabIndex = -1; detail.append(heading); heading.focus(); window.scrollTo(0, 0);
      }
      function showBrand(b) {
        startDetail(b.name);
        detail.append(el('h3', 'bg-section-title', '01  タグの年表'));
        if (!b.groups.length) detail.append(el('p', 'bg-muted', 'タグ写真は未収集です。型番・年代の参考情報を先に掲載しています。'));
        for (const g of tagTimeline(b.groups)) {
          const card = el('section', 'bg-tag-card'); card.append(el('h4', 'bg-period', g.displayPeriod.label));
          for (const p of g.photos) {
            const photoButton = button('', () => showPhoto(p, b.name, root, photoButton), 'bg-photo-button');
            photoButton.setAttribute('aria-label', `${b.name} ${g.displayPeriod.label}のタグ写真を拡大`);
            const img = el('img', 'bg-tag-photo'); img.src = p.image; img.alt = b.name + ' ブランドタグ'; img.loading = 'lazy';
            photoButton.append(img); card.append(photoButton);
            const refs = el('details', 'bg-refs'); refs.append(el('summary', '', '出典を見る'), el('p', '', p.basis), link('写真を確認したページ', p.source)); card.append(refs);
          }
          detail.append(card);
        }
        const m = b.method; const method = el('section', 'bg-method'); method.append(el('h3', 'bg-section-title', '02  型番の読み方'));
        if (!b.groups.length) method.append(el('p', 'bg-muted', '参考記事の品番例です。実物のタグ写真は未確認です。'));
        const q = m.quickGuide;
        const steps = el('dl', 'bg-reading-steps');
        steps.append(el('dt', '', '見る場所'), el('dd', '', q?.target || '品質表示タグの品番・NO.欄'));
        steps.append(el('dt', '', '読み方'), el('dd', '', q?.reading || m.how.split('\n')[0]));
        method.append(steps, el('p', 'bg-example-label', '型番の例'));
        const code = el('div', 'bg-code');
        const highlight = q ? q.highlight : m.highlight;
        let start = q ? q.start : (highlight ? m.code.indexOf(highlight) : -1);
        if (!q && b.name === 'TOMORROWLAND' && highlight) start = 6;
        if (highlight && start >= 0) { code.append(document.createTextNode(m.code.slice(0, start)), el('mark', '', highlight), document.createTextNode(m.code.slice(start + highlight.length))); } else code.textContent = m.code;
        method.append(code, el('p', 'bg-result', '→ ' + (q?.result || m.result)));
        if (q?.note) method.append(el('p', 'bg-reading-note', q.note));
        if (q?.rows.length) {
          const table = el('table', 'bg-reading-table'); const caption = el('caption', '', '対応表');
          const head = el('tr'); head.append(el('th', '', 'タグの表示'), el('th', '', '年代・季節'));
          const thead = el('thead'); thead.append(head); const tbody = el('tbody');
          for (const row of q.rows) { const tr = el('tr'); tr.append(el('td', '', row[0]), el('td', '', row[1])); tbody.append(tr); }
          table.append(caption, thead, tbody); method.append(table);
        }
        const explanation = el('details', 'bg-refs bg-method-details');
        explanation.append(el('summary', '', '詳しい説明・商品例'), el('p', 'bg-how', m.how), el('p', 'bg-caution', m.caution));
        method.append(explanation);
        const refs = el('details', 'bg-refs'); refs.append(el('summary', '', '型番の参考ページ'));
        for (const s of b.sources) refs.append(link(s.title, s.url));
        if (!b.sources.length) refs.append(el('p', '', '以前集めた商品ページをもとにした説明です。'));
        method.append(refs); detail.append(method);
        if (data.baycrews.confirmed.includes(b.name)) detail.append(button('ベイクルーズ系列の説明へ', showBaycrews));
      }
      function showBaycrews() {
        const a = data.baycrews; startDetail('ベイクルーズ系列');
        detail.append(el('h3', 'bg-section-title', a.title), el('p', 'bg-how', a.how));
        for (const e of a.examples) {
          const card = el('section', 'bg-tag-card'); card.append(el('h4', '', e.brand), el('div', 'bg-code', e.code), el('p', 'bg-result', e.year), link('公式の商品ページ', e.url)); detail.append(card);
        }
        detail.append(el('h3', 'bg-section-title', `当てはまる商品が見つかった${a.confirmed.length}ブランド`), el('p', '', a.confirmed.join(' / ')), el('p', 'bg-caution', '掲載ブランドも、全商品・すべての年に使えるとは確認できていません。'), el('h3', 'bg-section-title', `読み方をまだ確認していない${a.unconfirmed.length}ブランド`), el('p', '', a.unconfirmed.join(' / ')), el('p', 'bg-caution', a.caution), link('系列一覧の出典', a.source));
      }
      search.addEventListener('input', () => { query = search.value; drawList(); }); drawList();
    }
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file) return;
      input.disabled = true; status.hidden = false; status.textContent = '内容と写真を確認して保存中… この画面を開いたままお待ちください。';
      try {
        const record = await importFile(file);
        if (isLive()) { controls.open = false; showLibrary(record); }
      } catch (error) { if (isLive()) status.textContent = `取り込めませんでした：${error.message} 保存済みの図鑑はそのまま使えます。`; }
      finally { input.disabled = false; input.value = ''; }
    });
    try {
      const record = await load(); if (!isLive()) return;
      if (record) showLibrary(record);
      else { status.textContent = 'この端末に図鑑を自動で保存します。'; }
    } catch { if (isLive()) { status.hidden = false; status.textContent = '保存済みの図鑑を読めませんでした。画面を開き直してください。'; controls.open = true; } }
    finally { if (!importing) input.disabled = false; }
    const foreground = () => { if (document.visibilityState !== 'hidden') sync(); };
    const online = () => sync(true);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', foreground);
    const tick = setInterval(() => {
      if (!isLive()) { clearInterval(tick); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', foreground); return; }
      foreground();
    }, 15 * 60 * 1000);
    await sync(Boolean(options.forceSync));
  }
  return { isBackSwipe, tagPeriod, tagTimeline, render, validate, parsePackage, normalize, matches, importFile, load, save, DB_NAME, MAX_BYTES };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BrandGuide;
