// ============================================================
// 店舗巡回ルート最適化 — メインアプリ
// ============================================================

const App = (() => {
  let stores = [];
  let config = {};
  let selectedStoreIds = new Set();
  let optimizedRoute = null;
  let patrolState = null; // { routeId, stops, currentIdx }
  let activeFilter = 'all';
  let patrolTimerInterval = null;

  // ---------- 初期化 ----------

  async function init() {
    // API URL 確認
    if (!API.getUrl()) {
      Router.register('home', renderSettings);
      Router.navigate('home');
      toast('API URLを設定してください');
      return;
    }

    setupNav();
    registerViews();

    // 巡回中データがあれば復元
    const saved = await Storage.getCurrentRoute();
    if (saved && saved.routeId) {
      patrolState = saved;
      Router.navigate('patrol');
      return;
    }

    await loadData();
    Router.navigate('home');
  }

  async function loadData() {
    try {
      [stores, config] = await Promise.all([API.getStores(), API.getConfig()]);
      await Storage.cacheStores(stores);
      await Storage.cacheConfig(config);
    } catch (e) {
      console.warn('API fetch failed, using cache:', e);
      stores = await Storage.getCachedStores();
      config = await Storage.getCachedConfig();
      if (stores.length === 0) {
        toast('データ取得に失敗しました');
      }
    }
  }

  function setupNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Router.navigate(view);
      });
    });
  }

  function registerViews() {
    Router.register('home', renderHome);
    Router.register('stores', renderStoreManagement);
    Router.register('history', renderHistory);
    Router.register('settings', renderSettings);
    Router.register('patrol', renderPatrol);
    Router.register('summary', renderSummary);
  }

  // ---------- 優先度スコア計算 ----------

  function calcPriorityScore(store) {
    const visits = Number(store.visit_count) || 0;
    const totalPurchase = Number(store.total_purchase) || 0;
    const avgPerVisit = visits > 0 ? totalPurchase / visits : 0;
    const lastVisit = store.last_visit ? new Date(store.last_visit) : null;
    const daysSince = lastVisit ? (Date.now() - lastVisit.getTime()) / 86400000 : 999;

    let score = 0;
    score += Math.min(avgPerVisit / 100, 50); // 訪問あたり仕入れ額 (max 50)
    if (daysSince > 14) score += Math.min((daysSince - 14) * 2, 30); // 未訪問ボーナス (max 30)
    if (visits >= 3) score += 10; // 実績ある店舗
    return Math.round(score);
  }

  // ---------- ホーム画面（ルート計画） ----------

  function renderHome(container) {
    setTitle('巡回ルート');
    let html = '';

    // フィルター
    const categories = ['all', '家電量販', 'HC', 'ドンキ', 'リサイクル', 'その他'];
    html += '<div class="filter-tabs">';
    categories.forEach(c => {
      const label = c === 'all' ? '全て' : c;
      html += `<div class="filter-tab ${activeFilter === c ? 'active' : ''}" data-cat="${c}">${label}</div>`;
    });
    html += '</div>';

    // 店舗一覧（優先度スコア順）
    const filtered = activeFilter === 'all' ? stores : stores.filter(s => s.category === activeFilter);
    const sorted = [...filtered].sort((a, b) => calcPriorityScore(b) - calcPriorityScore(a));

    sorted.forEach(s => {
      const sel = selectedStoreIds.has(s.store_id) ? 'selected' : '';
      const score = calcPriorityScore(s);
      html += `
        <div class="store-item ${sel}" data-sid="${s.store_id}">
          <span class="store-icon">${s.icon || '&#x1f3ea;'}</span>
          <div class="store-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="store-meta">${esc(s.category)} | ${formatTime(s.open_time)}-${formatTime(s.close_time)} | ${s.avg_stay_min}分</div>
            ${score > 0 ? `<div class="store-score">Score: ${score}</div>` : ''}
          </div>
          <div class="store-check">${sel ? '&#x2713;' : ''}</div>
        </div>`;
    });

    // アクションボタン
    html += `
      <div style="position:sticky;bottom:60px;padding:8px 0;background:var(--bg);">
        <div class="flex-between mb-8">
          <span class="text-sm text-dim">${selectedStoreIds.size}店舗 選択中</span>
          <button class="btn btn-sm btn-outline" id="btn-clear">クリア</button>
        </div>
        <button class="btn btn-primary btn-block" id="btn-optimize" ${selectedStoreIds.size < 1 ? 'disabled' : ''}>
          ルート最適化
        </button>
      </div>`;

    container.innerHTML = html;

    // 最適化済みルートがあれば表示
    if (optimizedRoute) {
      renderOptimizedRoute(container);
    }

    // イベント
    container.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeFilter = tab.dataset.cat;
        Router.navigate('home');
      });
    });

    container.querySelectorAll('.store-item').forEach(el => {
      el.addEventListener('click', () => {
        const sid = el.dataset.sid;
        if (selectedStoreIds.has(sid)) selectedStoreIds.delete(sid);
        else selectedStoreIds.add(sid);
        optimizedRoute = null;
        Router.navigate('home');
      });
    });

    document.getElementById('btn-clear')?.addEventListener('click', () => {
      selectedStoreIds.clear();
      optimizedRoute = null;
      Router.navigate('home');
    });

    document.getElementById('btn-optimize')?.addEventListener('click', doOptimize);
  }

  function doOptimize() {
    const selected = stores.filter(s => selectedStoreIds.has(s.store_id));
    const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
    const speed = Number(config.avg_speed_kmh) || 30;
    optimizedRoute = RouteOptimizer.optimize(home, selected, speed);
    Router.navigate('home');
  }

  function renderOptimizedRoute(container) {
    const r = optimizedRoute;
    const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
    const mapsUrl = RouteOptimizer.generateMapsUrl(home, r.orderedStores);
    const hours = Math.floor(r.estimatedMinutes / 60);
    const mins = r.estimatedMinutes % 60;

    let html = '<div class="route-result">';
    html += '<div class="card-title">最適化ルート</div>';
    html += '<div class="route-stats">';
    html += `<div class="route-stat"><div class="value">${r.totalDistanceKm}</div><div class="label">km</div></div>`;
    html += `<div class="route-stat"><div class="value">${hours}h${mins}m</div><div class="label">推定時間</div></div>`;
    html += `<div class="route-stat"><div class="value">${r.orderedStores.length}</div><div class="label">店舗</div></div>`;
    html += '</div>';

    r.orderedStores.forEach((s, i) => {
      html += `
        <div class="route-stop">
          <div class="stop-num">${i + 1}</div>
          <span class="stop-name">${s.icon || ''} ${esc(s.name)}</span>
          <span class="stop-stay">${s.avg_stay_min}分</span>
        </div>`;
    });

    html += `
      <div class="btn-group">
        <a href="${mapsUrl}" target="_blank" class="btn btn-outline" style="flex:1;text-decoration:none;">Google Maps</a>
        <button class="btn btn-success" style="flex:1;" id="btn-start-patrol">巡回開始</button>
      </div>`;
    html += '</div>';

    container.insertAdjacentHTML('beforeend', html);

    document.getElementById('btn-start-patrol')?.addEventListener('click', startPatrol);
  }

  // ---------- 巡回モード ----------

  async function startPatrol() {
    if (!optimizedRoute) return;
    const storeIds = optimizedRoute.orderedStores.map(s => s.store_id);

    // GASにルート開始を通知
    await API.startRoute({
      store_ids: storeIds,
      total_distance_km: optimizedRoute.totalDistanceKm
    });

    // route_id を推定（最新のルートを取得）
    let routeId = 'unknown';
    try {
      const history = await API.getRouteHistory({ limit: 1 });
      if (history.length > 0) routeId = history[0].route_id;
    } catch {}

    patrolState = {
      routeId,
      startTime: Date.now(),
      stops: optimizedRoute.orderedStores.map(s => ({
        ...s,
        status: 'planned',
        arrivalTime: null,
        departureTime: null,
        purchaseAmount: 0,
        purchaseItems: 0
      })),
      currentIdx: 0
    };

    await Storage.saveCurrentRoute(patrolState);
    Router.navigate('patrol');
  }

  function renderPatrol(container) {
    if (!patrolState) { Router.navigate('home'); return; }
    setTitle('巡回中');

    const { stops, currentIdx } = patrolState;
    const current = stops[currentIdx];
    if (!current) { endPatrol(); return; }

    let html = '';

    // 経過時間タイマー
    html += `<div class="patrol-timer" id="patrol-timer">00:00:00</div>`;

    // 進捗
    html += `<div class="text-sm text-dim text-center mb-8">${currentIdx + 1} / ${stops.length} 店舗</div>`;

    // 現在の店舗
    html += `
      <div class="patrol-current">
        <div class="current-label">${current.status === 'planned' ? '次の店舗' : '滞在中'}</div>
        <div class="current-name">${current.icon || ''} ${esc(current.name)}</div>
        <div class="current-meta">${esc(current.category)} | ${current.open_time}-${current.close_time}</div>
      </div>`;

    if (current.status === 'planned') {
      html += `<button class="btn btn-primary btn-block" id="btn-arrive">到着</button>`;
    } else {
      // 滞在中アクション
      html += `
        <div class="patrol-actions">
          <button class="btn btn-warning" id="btn-purchase">仕入れ記録</button>
          <button class="btn btn-outline" id="btn-memo">メモ追加</button>
          <button class="btn btn-outline" id="btn-find">商品発見</button>
          <button class="btn btn-success" id="btn-depart">出発</button>
        </div>`;
    }

    // スキップ/終了
    html += `
      <div class="btn-group mt-12">
        <button class="btn btn-sm btn-outline" style="flex:1;" id="btn-skip">スキップ</button>
        <button class="btn btn-sm btn-accent" style="flex:1;" id="btn-end">巡回終了</button>
      </div>`;

    // 残りの店舗
    if (currentIdx < stops.length - 1) {
      html += '<div class="mt-12 text-sm text-dim">残りの店舗</div>';
      for (let i = currentIdx + 1; i < stops.length; i++) {
        const s = stops[i];
        html += `
          <div class="route-stop">
            <div class="stop-num" style="background:var(--border);color:var(--text-dim)">${i + 1}</div>
            <span class="stop-name">${s.icon || ''} ${esc(s.name)}</span>
            <span class="badge ${s.status === 'visited' ? 'badge-success' : ''}">${s.status === 'visited' ? '訪問済' : ''}</span>
          </div>`;
      }
    }

    container.innerHTML = html;

    // タイマー開始
    startPatrolTimer();

    // イベント
    document.getElementById('btn-arrive')?.addEventListener('click', async () => {
      current.status = 'visiting';
      current.arrivalTime = new Date().toISOString();
      await API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'visited',
        arrival_time: current.arrivalTime
      });
      await Storage.saveCurrentRoute(patrolState);
      Router.navigate('patrol');
    });

    document.getElementById('btn-depart')?.addEventListener('click', async () => {
      current.status = 'visited';
      current.departureTime = new Date().toISOString();
      await API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        departure_time: current.departureTime,
        purchase_amount: current.purchaseAmount,
        purchase_items: current.purchaseItems
      });
      patrolState.currentIdx++;
      await Storage.saveCurrentRoute(patrolState);
      if (patrolState.currentIdx >= stops.length) {
        endPatrol();
      } else {
        Router.navigate('patrol');
      }
    });

    document.getElementById('btn-skip')?.addEventListener('click', async () => {
      current.status = 'skipped';
      await API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'skipped'
      });
      patrolState.currentIdx++;
      await Storage.saveCurrentRoute(patrolState);
      if (patrolState.currentIdx >= stops.length) {
        endPatrol();
      } else {
        Router.navigate('patrol');
      }
    });

    document.getElementById('btn-end')?.addEventListener('click', () => endPatrol());

    document.getElementById('btn-purchase')?.addEventListener('click', () => showPurchaseModal(current));
    document.getElementById('btn-memo')?.addEventListener('click', () => showMemoModal(current));
    document.getElementById('btn-find')?.addEventListener('click', () => showFindModal(current));
  }

  function startPatrolTimer() {
    if (patrolTimerInterval) clearInterval(patrolTimerInterval);
    const startTime = patrolState?.startTime || Date.now();
    function updateTimer() {
      const el = document.getElementById('patrol-timer');
      if (!el) { clearInterval(patrolTimerInterval); return; }
      const elapsed = Date.now() - startTime;
      const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
      el.textContent = `${h}:${m}:${s}`;
    }
    updateTimer();
    patrolTimerInterval = setInterval(updateTimer, 1000);
  }

  async function endPatrol() {
    if (patrolTimerInterval) { clearInterval(patrolTimerInterval); patrolTimerInterval = null; }
    if (patrolState) {
      await API.endRoute({ route_id: patrolState.routeId });
      const summary = { ...patrolState };
      patrolState = null;
      await Storage.clearCurrentRoute();
      await loadData();
      Router.navigate('summary', { summary });
    }
  }

  // ---------- モーダル ----------

  function showModal(title, bodyHtml, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}</div>
        ${bodyHtml}
        <div class="btn-group">
          <button class="btn btn-outline" style="flex:1" id="modal-cancel">キャンセル</button>
          <button class="btn btn-primary" style="flex:1" id="modal-submit">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#modal-submit').addEventListener('click', () => {
      onSubmit(overlay);
      overlay.remove();
    });
  }

  function showPurchaseModal(stop) {
    const body = `
      <div class="form-group">
        <label class="form-label">仕入れ金額</label>
        <input type="number" class="form-input" id="m-amount" placeholder="0">
      </div>
      <div class="form-group">
        <label class="form-label">点数</label>
        <input type="number" class="form-input" id="m-items" value="1">
      </div>
      <div class="form-group">
        <label class="form-label">ジャンル</label>
        <select class="form-select" id="m-genre">
          <option>家電</option><option>日用品</option><option>ペット</option>
          <option>アウトドア</option><option>スポーツ</option><option>その他</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">メモ</label>
        <input type="text" class="form-input" id="m-note" placeholder="商品名など">
      </div>`;
    showModal('仕入れ記録', body, async (el) => {
      const amount = Number(el.querySelector('#m-amount').value) || 0;
      const items = Number(el.querySelector('#m-items').value) || 1;
      const genre = el.querySelector('#m-genre').value;
      const note = el.querySelector('#m-note').value;

      stop.purchaseAmount += amount;
      stop.purchaseItems += items;

      await API.addPurchase({
        store_id: stop.store_id,
        route_id: patrolState.routeId,
        amount, items_count: items, genre, note
      });
      await Storage.saveCurrentRoute(patrolState);
      toast(`${amount.toLocaleString()}円 記録しました`);
      Router.navigate('patrol');
    });
  }

  function showMemoModal(stop) {
    const body = `
      <div class="form-group">
        <label class="form-label">タイプ</label>
        <select class="form-select" id="m-type">
          <option>値下げ</option><option>ワゴン</option><option>得意ジャンル</option>
          <option>セール</option><option>注意</option><option>その他</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">内容</label>
        <textarea class="form-textarea" id="m-content" rows="3"></textarea>
      </div>`;
    showModal('メモ追加', body, async (el) => {
      const type = el.querySelector('#m-type').value;
      const content = el.querySelector('#m-content').value;
      await API.addMemo({ store_id: stop.store_id, type, content });
      toast('メモを保存しました');
    });
  }

  function showFindModal(stop) {
    const body = `
      <div class="form-group">
        <label class="form-label">ASIN</label>
        <input type="text" class="form-input" id="m-asin" placeholder="B0XXXXXXXXX">
      </div>
      <div class="form-group">
        <label class="form-label">商品名</label>
        <input type="text" class="form-input" id="m-product">
      </div>
      <div class="form-group">
        <label class="form-label">店頭価格</label>
        <input type="number" class="form-input" id="m-sprice" placeholder="0">
      </div>
      <div class="form-group">
        <label class="form-label">Amazon価格</label>
        <input type="number" class="form-input" id="m-aprice" placeholder="0">
      </div>
      <div class="form-group">
        <label class="form-label">アクション</label>
        <select class="form-select" id="m-action">
          <option value="purchased">購入した</option>
          <option value="skipped" selected>見送り</option>
          <option value="out_of_stock">在庫なし</option>
        </select>
      </div>`;
    showModal('商品発見', body, async (el) => {
      await API.addFind({
        store_id: stop.store_id,
        route_id: patrolState.routeId,
        asin: el.querySelector('#m-asin').value,
        product_name: el.querySelector('#m-product').value,
        store_price: Number(el.querySelector('#m-sprice').value) || 0,
        amazon_price: Number(el.querySelector('#m-aprice').value) || 0,
        action: el.querySelector('#m-action').value
      });
      toast('商品発見を記録しました');
    });
  }

  // ---------- サマリー画面 ----------

  function renderSummary(container, { summary } = {}) {
    setTitle('巡回サマリー');
    if (!summary) { Router.navigate('home'); return; }

    const visited = summary.stops.filter(s => s.status === 'visited');
    const skipped = summary.stops.filter(s => s.status === 'skipped');
    const totalAmount = visited.reduce((s, st) => s + st.purchaseAmount, 0);
    const totalItems = visited.reduce((s, st) => s + st.purchaseItems, 0);

    // 経過時間
    const elapsed = summary.startTime ? Date.now() - summary.startTime : 0;
    const elH = Math.floor(elapsed / 3600000);
    const elM = Math.floor((elapsed % 3600000) / 60000);
    const elapsedStr = elH > 0 ? `${elH}時間${elM}分` : `${elM}分`;

    let html = `
      <div class="summary-grid">
        <div class="summary-item"><div class="value">${visited.length}</div><div class="label">訪問店舗</div></div>
        <div class="summary-item"><div class="value">${skipped.length}</div><div class="label">スキップ</div></div>
        <div class="summary-item"><div class="value">${totalAmount.toLocaleString()}円</div><div class="label">仕入れ合計</div></div>
        <div class="summary-item"><div class="value">${totalItems}</div><div class="label">仕入れ点数</div></div>
      </div>
      <div class="text-center text-dim text-sm mb-8">所要時間: ${elapsedStr}</div>`;

    if (visited.length > 0) {
      html += '<div class="card-title mt-12">店舗別</div>';
      visited.forEach((s, i) => {
        html += `
          <div class="card">
            <div class="flex-between">
              <span>${i + 1}. ${s.icon || ''} ${esc(s.name)}</span>
              <span class="badge badge-success">${s.purchaseAmount.toLocaleString()}円</span>
            </div>
          </div>`;
      });
    }

    html += `<button class="btn btn-primary btn-block mt-12" id="btn-back-home">ホームに戻る</button>`;

    container.innerHTML = html;
    document.getElementById('btn-back-home')?.addEventListener('click', () => {
      optimizedRoute = null;
      selectedStoreIds.clear();
      Router.navigate('home');
      setNavActive('home');
    });
  }

  // ---------- 店舗管理 ----------

  function renderStoreManagement(container) {
    setTitle('店舗管理');
    let html = `<button class="btn btn-primary btn-sm mb-8" id="btn-add-store">+ 店舗追加</button>`;

    stores.forEach(s => {
      html += `
        <div class="store-item" data-sid="${s.store_id}" style="cursor:default">
          <span class="store-icon">${s.icon || '&#x1f3ea;'}</span>
          <div class="store-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="store-meta">
              ${esc(s.category)} | 訪問${s.visit_count}回 | 累計${Number(s.total_purchase).toLocaleString()}円
            </div>
          </div>
          <button class="btn btn-sm btn-outline edit-store" data-sid="${s.store_id}">編集</button>
        </div>`;
    });

    container.innerHTML = html;

    document.getElementById('btn-add-store')?.addEventListener('click', () => showAddStoreModal());
    container.querySelectorAll('.edit-store').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const store = stores.find(s => s.store_id === btn.dataset.sid);
        if (store) showEditStoreModal(store);
      });
    });
  }

  function showAddStoreModal() {
    const body = storeFormHtml({});
    showModal('店舗追加', body, async (el) => {
      const data = readStoreForm(el);
      await API.addStore(data);
      await loadData();
      toast('店舗を追加しました');
      Router.navigate('stores');
    });
  }

  function showEditStoreModal(store) {
    const body = storeFormHtml(store);
    showModal('店舗編集', body, async (el) => {
      const data = readStoreForm(el);
      data.store_id = store.store_id;
      await API.updateStore(data);
      await loadData();
      toast('店舗を更新しました');
      Router.navigate('stores');
    });
  }

  function storeFormHtml(s) {
    return `
      <div class="form-group"><label class="form-label">店舗名</label>
        <input type="text" class="form-input" id="sf-name" value="${esc(s.name || '')}"></div>
      <div class="form-group"><label class="form-label">カテゴリ</label>
        <select class="form-select" id="sf-category">
          ${['家電量販','HC','ドンキ','リサイクル','その他'].map(c =>
            `<option ${s.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">住所</label>
        <input type="text" class="form-input" id="sf-address" value="${esc(s.address || '')}"></div>
      <div class="flex gap-8">
        <div class="form-group" style="flex:1"><label class="form-label">緯度</label>
          <input type="number" step="any" class="form-input" id="sf-lat" value="${s.lat || ''}"></div>
        <div class="form-group" style="flex:1"><label class="form-label">経度</label>
          <input type="number" step="any" class="form-input" id="sf-lng" value="${s.lng || ''}"></div>
      </div>
      <div class="flex gap-8">
        <div class="form-group" style="flex:1"><label class="form-label">開店</label>
          <input type="text" class="form-input" id="sf-open" value="${s.open_time || '10:00'}"></div>
        <div class="form-group" style="flex:1"><label class="form-label">閉店</label>
          <input type="text" class="form-input" id="sf-close" value="${s.close_time || '20:00'}"></div>
      </div>
      <div class="flex gap-8">
        <div class="form-group" style="flex:1"><label class="form-label">平均滞在(分)</label>
          <input type="number" class="form-input" id="sf-stay" value="${s.avg_stay_min || 30}"></div>
        <div class="form-group" style="flex:1"><label class="form-label">アイコン</label>
          <input type="text" class="form-input" id="sf-icon" value="${s.icon || ''}"></div>
      </div>`;
  }

  function readStoreForm(el) {
    return {
      name: el.querySelector('#sf-name').value,
      category: el.querySelector('#sf-category').value,
      address: el.querySelector('#sf-address').value,
      lat: Number(el.querySelector('#sf-lat').value) || 0,
      lng: Number(el.querySelector('#sf-lng').value) || 0,
      open_time: el.querySelector('#sf-open').value,
      close_time: el.querySelector('#sf-close').value,
      avg_stay_min: Number(el.querySelector('#sf-stay').value) || 30,
      icon: el.querySelector('#sf-icon').value
    };
  }

  // ---------- 履歴・分析 ----------

  async function renderHistory(container) {
    setTitle('履歴・分析');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const routes = await API.getRouteHistory({ limit: 20, include_stops: 'true' });
      if (routes.length === 0) {
        container.innerHTML = '<div class="text-center text-dim mt-12">巡回履歴がありません</div>';
        return;
      }

      let html = '';
      routes.forEach(r => {
        const dateStr = r.date ? new Date(r.date).toLocaleDateString('ja-JP') : '不明';
        html += `
          <div class="history-item">
            <div class="flex-between">
              <span class="history-date">${dateStr}</span>
              <span class="badge badge-primary">${r.store_count || 0}店舗</span>
            </div>
            <div class="history-meta">
              距離: ${r.total_distance_km || 0}km |
              仕入れ: ${Number(r.total_purchase || 0).toLocaleString()}円 (${r.total_items || 0}点)
            </div>
            ${r.note ? `<div class="text-sm mt-8">${esc(r.note)}</div>` : ''}
          </div>`;
      });
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
    }
  }

  // ---------- 設定 ----------

  function renderSettings(container) {
    setTitle('設定');
    const url = API.getUrl();
    let html = `
      <div class="card">
        <div class="card-title">API URL</div>
        <div class="form-group">
          <input type="text" class="form-input" id="set-url" value="${esc(url)}" placeholder="https://script.google.com/macros/s/.../exec">
        </div>
        <button class="btn btn-primary btn-sm" id="btn-save-url">保存</button>
      </div>
      <div class="card">
        <div class="card-title">自宅座標</div>
        <div class="flex gap-8">
          <div class="form-group" style="flex:1"><label class="form-label">緯度</label>
            <input type="number" step="any" class="form-input" id="set-lat" value="${config.home_lat || ''}"></div>
          <div class="form-group" style="flex:1"><label class="form-label">経度</label>
            <input type="number" step="any" class="form-input" id="set-lng" value="${config.home_lng || ''}"></div>
        </div>
        <div class="btn-group" style="margin-top:0">
          <button class="btn btn-primary btn-sm" id="btn-save-home">保存</button>
          <button class="btn btn-outline btn-sm" id="btn-gps">現在地を取得</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">パラメータ</div>
        <div class="flex gap-8">
          <div class="form-group" style="flex:1"><label class="form-label">平均速度 (km/h)</label>
            <input type="number" class="form-input" id="set-speed" value="${config.avg_speed_kmh || 30}"></div>
          <div class="form-group" style="flex:1"><label class="form-label">デフォルト滞在 (分)</label>
            <input type="number" class="form-input" id="set-stay" value="${config.default_stay_min || 30}"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-save-params">保存</button>
      </div>
      <div class="card">
        <div class="card-title">接続テスト</div>
        <button class="btn btn-outline btn-sm" id="btn-test">テスト実行</button>
        <div id="test-result" class="text-sm mt-8"></div>
      </div>
      <div class="card">
        <div class="card-title">データ</div>
        <button class="btn btn-outline btn-sm" id="btn-refresh">データ再取得</button>
      </div>`;

    container.innerHTML = html;

    document.getElementById('btn-save-url')?.addEventListener('click', async () => {
      const v = document.getElementById('set-url').value.trim();
      API.setUrl(v);
      await loadData();
      registerViews();
      setupNav();
      toast('API URLを保存しました');
      Router.navigate('home');
      setNavActive('home');
    });

    document.getElementById('btn-save-home')?.addEventListener('click', async () => {
      await API.updateConfig({
        home_lat: document.getElementById('set-lat').value,
        home_lng: document.getElementById('set-lng').value
      });
      config.home_lat = document.getElementById('set-lat').value;
      config.home_lng = document.getElementById('set-lng').value;
      toast('自宅座標を保存しました');
    });

    document.getElementById('btn-gps')?.addEventListener('click', () => {
      if (!navigator.geolocation) { toast('位置情報に非対応です'); return; }
      toast('位置情報を取得中...');
      navigator.geolocation.getCurrentPosition(
        pos => {
          document.getElementById('set-lat').value = pos.coords.latitude.toFixed(6);
          document.getElementById('set-lng').value = pos.coords.longitude.toFixed(6);
          toast('現在地を取得しました');
        },
        err => { toast('位置情報の取得に失敗: ' + err.message); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    document.getElementById('btn-save-params')?.addEventListener('click', async () => {
      await API.updateConfig({
        avg_speed_kmh: document.getElementById('set-speed').value,
        default_stay_min: document.getElementById('set-stay').value
      });
      config.avg_speed_kmh = document.getElementById('set-speed').value;
      config.default_stay_min = document.getElementById('set-stay').value;
      toast('パラメータを保存しました');
    });

    document.getElementById('btn-test')?.addEventListener('click', async () => {
      const result = document.getElementById('test-result');
      result.textContent = 'テスト中...';
      try {
        const cfg = await API.getConfig();
        const st = await API.getStores();
        result.innerHTML = `<span style="color:var(--success)">接続OK</span> — config: ${Object.keys(cfg).length}項目, stores: ${st.length}店舗`;
      } catch (e) {
        result.innerHTML = `<span style="color:var(--accent)">エラー:</span> ${esc(e.message)}`;
      }
    });

    document.getElementById('btn-refresh')?.addEventListener('click', async () => {
      toast('データ再取得中...');
      await loadData();
      toast(`${stores.length}店舗のデータを更新しました`);
    });
  }

  // ---------- ユーティリティ ----------

  function formatTime(val) {
    if (!val) return '';
    // Google Sheets の時刻値: "1899-12-30T02:00:00.000Z" → "11:00" (JST)
    // または "10:00" のような文字列
    if (typeof val === 'string' && val.includes('1899-')) {
      const d = new Date(val);
      // UTCの時:分を取得（Sheetsの時刻はUTC表記だがJST値がそのまま入っている場合がある）
      const h = d.getUTCHours();
      const m = d.getUTCMinutes();
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }
    if (typeof val === 'string' && /^\d{1,2}:\d{2}/.test(val)) return val;
    return String(val);
  }

  function setTitle(t) {
    document.getElementById('header-title').textContent = t;
  }

  function setNavActive(view) {
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
  }

  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ---------- 起動 ----------
  document.addEventListener('DOMContentLoaded', init);

  return { init, loadData };
})();
