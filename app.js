// ============================================================
// 店舗巡回ルート最適化 — メインアプリ
// ============================================================

const App = (() => {
  let stores = [];
  let config = {};
  let selectedStoreIds = []; // 選択順を保持する配列
  let optimizedRoute = null;
  let patrolState = null; // { routeId, stops, currentIdx }
  let filterMode = 'area'; // 'area' | 'genre' | 'chain'
  let activeFilter = 'all';
  let patrolTimerInterval = null;

  // ---------- エリア定義（座標ベース自動分類） ----------

  const AREAS = [
    // 分類判定用（広域エリアを先に判定してから仙台市内を細分化）
    { id: 'yamagata',   name: '山形',          test: s => Number(s.lng) < 140.50 },
    { id: 'osaki',      name: '大崎・古川',     test: s => Number(s.lat) >= 38.50 },
    { id: 'ishinomaki', name: '石巻',           test: s => Number(s.lng) >= 141.10 },
    { id: 'okawara',    name: '大河原・白石',    test: s => Number(s.lat) < 38.10 },
    { id: 'rifu',       name: '利府・多賀城',    test: s => Number(s.lat) >= 38.28 && Number(s.lng) >= 140.94 },
    { id: 'izumi',      name: '泉・富谷',       test: s => Number(s.lat) >= 38.30 },
    { id: 'aoba',       name: '青葉・中心部',    test: s => Number(s.lat) >= 38.25 && Number(s.lng) < 140.90 },
    { id: 'miyagino',   name: '宮城野・若林',    test: s => Number(s.lat) >= 38.24 && Number(s.lng) >= 140.90 },
    { id: 'taihaku',    name: '太白・南',        test: s => Number(s.lat) < 38.24 && Number(s.lat) >= 38.19 },
    { id: 'natori',     name: '名取・岩沼',      test: s => Number(s.lat) < 38.19 },
  ];

  // UI表示順（仙台駅から近い順）
  const AREA_DISPLAY_ORDER = [
    'aoba', 'miyagino', 'taihaku', 'izumi', 'rifu', 'natori',
    'okawara', 'ishinomaki', 'osaki', 'yamagata',
  ];

  function getArea(store) {
    for (const a of AREAS) {
      if (a.test(store)) return a.id;
    }
    return 'other';
  }

  // ---------- ジャンル・チェーン定義 ----------

  // カテゴリ表示順
  const GENRE_ORDER = ['家電量販', 'HC', 'ドンキ', 'リサイクル', 'カー用品', 'その他'];
  const GENRE_DISPLAY = {
    '家電量販': '家電量販店',
    'HC': 'ホームセンター',
    'ドンキ': 'ドンキホーテ',
    'リサイクル': 'リサイクルショップ',
    'カー用品': 'カー用品店',
    'その他': 'その他'
  };

  const CHAIN_RULES = [
    // リサイクル系（長い名前を先に判定）
    { re: /BOOKOFF SUPER BAZAAR|ブックオフスーパーバザー/i, chain: 'ブックオフSB' },
    { re: /BOOKOFF PLUS|ブックオフ PLUS|ブックオフプラス/i, chain: 'ブックオフPLUS' },
    { re: /BOOKOFF|ブックオフ/i, chain: 'ブックオフ' },
    { re: /スーパーセカンドストリート|セカンドストリート/, chain: 'セカンドストリート' },
    { re: /トレファクスタイル|トレジャーファクトリー/, chain: 'トレファク' },
    { re: /ハードオフ/, chain: 'ハードオフ' },
    { re: /オフハウス/, chain: 'オフハウス' },
    // 家電量販
    { re: /ヤマダデンキ/, chain: 'ヤマダデンキ' },
    { re: /ケーズデンキ/, chain: 'ケーズデンキ' },
    { re: /コジマ|ビックカメラ/, chain: 'コジマ×ビックカメラ' },
    { re: /エディオン/, chain: 'エディオン' },
    { re: /ノジマ/, chain: 'ノジマ' },
    { re: /ジョーシン/, chain: 'ジョーシン' },
    // ドンキ系
    { re: /ドン・キホーテ|ドンキ/, chain: 'ドンキホーテ' },
    // HC系
    { re: /カインズ/, chain: 'カインズ' },
    { re: /DCM/, chain: 'DCM' },
    { re: /ダイユーエイト/, chain: 'ダイユーエイト' },
    { re: /サンデー/, chain: 'サンデー' },
    { re: /コメリ/, chain: 'コメリ' },
    { re: /コーナン/, chain: 'コーナン' },
    // カー用品
    { re: /オートバックス/, chain: 'オートバックス' },
    { re: /イエローハット/, chain: 'イエローハット' },
    { re: /ジェームス/, chain: 'ジェームス' },
    // その他
    { re: /イオン/, chain: 'イオン' },
    { re: /コストコ/, chain: 'コストコ' },
    { re: /トイザらス/, chain: 'トイザらス' },
    { re: /オフィスベンダー/, chain: 'オフィスベンダー' },
  ];

  function getChain(store) {
    const name = store.name || '';
    for (const r of CHAIN_RULES) {
      if (r.re.test(name)) return r.chain;
    }
    return name.split(/[\s　]/)[0] || 'その他';
  }

  function getGenre(store) {
    return store.category || 'その他';
  }

  // ---------- 選択順番号ヘルパー ----------
  const CIRCLED_NUMBERS = [
    '\u2460','\u2461','\u2462','\u2463','\u2464',
    '\u2465','\u2466','\u2467','\u2468','\u2469',
    '\u246A','\u246B','\u246C','\u246D','\u246E',
    '\u246F','\u2470','\u2471','\u2472','\u2473'
  ]; // ①〜⑳

  function getSelectionLabel(index) {
    // index は 0-based
    if (index < 20) return CIRCLED_NUMBERS[index];
    return `(${index + 1})`;
  }

  function getDefaultFilter(mode) {
    if (mode === 'chain') {
      const chainCounts = {};
      stores.forEach(s => { const c = getChain(s); chainCounts[c] = (chainCounts[c] || 0) + 1; });
      const sorted = Object.keys(chainCounts).sort((a, b) => chainCounts[b] - chainCounts[a]);
      return sorted[0] || 'その他';
    }
    if (mode === 'genre') return GENRE_ORDER[0];
    return AREA_DISPLAY_ORDER[0];
  }

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
    Router.register('route-select', renderRouteSelect);
    Router.register('history', renderHistory);
    Router.register('history-detail', renderHistoryDetail);
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
    if (activeFilter === 'all') activeFilter = getDefaultFilter(filterMode);
    let html = '';

    // モード切替（エリア / ジャンル / チェーン）
    html += `<div class="mode-toggle">
      <button class="mode-btn ${filterMode === 'area' ? 'active' : ''}" data-mode="area">エリア別</button>
      <button class="mode-btn ${filterMode === 'genre' ? 'active' : ''}" data-mode="genre">ジャンル別</button>
      <button class="mode-btn ${filterMode === 'chain' ? 'active' : ''}" data-mode="chain">チェーン別</button>
    </div>`;

    // フィルタータブ
    html += '<div class="filter-tabs">';
    if (filterMode === 'chain') {
      // チェーン名を集計して店舗数順にソート
      const chainCounts = {};
      stores.forEach(s => {
        const c = getChain(s);
        chainCounts[c] = (chainCounts[c] || 0) + 1;
      });
      const chainNames = Object.keys(chainCounts).sort((a, b) => chainCounts[b] - chainCounts[a]);
      chainNames.forEach(c => {
        html += `<div class="filter-tab ${activeFilter === c ? 'active' : ''}" data-cat="${c}">${c}(${chainCounts[c]})</div>`;
      });
    } else if (filterMode === 'genre') {
      // ジャンル別タブ（GENRE_ORDER順）
      GENRE_ORDER.forEach(g => {
        const count = stores.filter(s => getGenre(s) === g).length;
        if (count > 0) {
          html += `<div class="filter-tab ${activeFilter === g ? 'active' : ''}" data-cat="${g}">${GENRE_DISPLAY[g] || g}(${count})</div>`;
        }
      });
    } else {
      // エリア別タブ
      AREA_DISPLAY_ORDER.forEach(id => {
        const a = AREAS.find(x => x.id === id);
        if (!a) return;
        const count = stores.filter(s => getArea(s) === a.id).length;
        if (count > 0) {
          html += `<div class="filter-tab ${activeFilter === a.id ? 'active' : ''}" data-cat="${a.id}">${a.name}(${count})</div>`;
        }
      });
    }
    html += '</div>';

    // 店舗フィルタリング
    let filtered;
    if (filterMode === 'chain') {
      filtered = stores.filter(s => getChain(s) === activeFilter);
    } else if (filterMode === 'genre') {
      filtered = stores.filter(s => getGenre(s) === activeFilter);
    } else {
      filtered = stores.filter(s => getArea(s) === activeFilter);
    }

    // ソート: エリア別はジャンル順→スコア順、それ以外はスコア順
    let sorted;
    if (filterMode === 'area') {
      sorted = [...filtered].sort((a, b) => {
        const gi = GENRE_ORDER.indexOf(getGenre(a)) - GENRE_ORDER.indexOf(getGenre(b));
        return gi !== 0 ? gi : calcPriorityScore(b) - calcPriorityScore(a);
      });
    } else {
      sorted = [...filtered].sort((a, b) => calcPriorityScore(b) - calcPriorityScore(a));
    }

    // エリア一括選択ボタン
    const allFilteredSelected = sorted.length > 0 && sorted.every(s => selectedStoreIds.includes(s.store_id));
    if (activeFilter !== 'all' && sorted.length > 0) {
      html += `<div class="flex-between mt-8 mb-8">
        <span class="text-sm" style="font-weight:600">${filterMode === 'area' ? (AREAS.find(a => a.id === activeFilter)?.name || activeFilter) : filterMode === 'genre' ? (GENRE_DISPLAY[activeFilter] || activeFilter) : activeFilter} ${sorted.length}店舗</span>
        <button class="btn btn-sm ${allFilteredSelected ? 'btn-outline' : 'btn-primary'}" id="btn-select-area">${allFilteredSelected ? '全解除' : '全選択'}</button>
      </div>`;
    }

    // 店舗一覧
    sorted.forEach(s => {
      const selIdx = selectedStoreIds.indexOf(s.store_id);
      const sel = selIdx >= 0 ? 'selected' : '';
      const score = calcPriorityScore(s);
      html += `
        <div class="store-item ${sel}" data-sid="${s.store_id}">
          <span class="store-icon">${s.icon || '&#x1f3ea;'}</span>
          <div class="store-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="store-meta">${esc(s.category)} | ${formatTime(s.open_time)}-${formatTime(s.close_time)} | ${s.avg_stay_min}分</div>
            ${score > 0 ? `<div class="store-score">Score: ${score}</div>` : ''}
          </div>
          <div class="store-check">${selIdx >= 0 ? getSelectionLabel(selIdx) : ''}</div>
        </div>`;
    });

    // アクションボタン
    html += `
      <div style="position:sticky;bottom:60px;padding:8px 0;background:var(--bg);">
        <div class="flex-between mb-8">
          <span class="text-sm text-dim">${selectedStoreIds.length}店舗 選択中</span>
          <button class="btn btn-sm btn-outline" id="btn-clear">クリア</button>
        </div>
        <button class="btn btn-primary btn-block" id="btn-optimize" ${selectedStoreIds.length < 1 ? 'disabled' : ''}>
          ルート最適化
        </button>
      </div>`;

    container.innerHTML = html;

    // 最適化済みルートがあれば表示
    if (optimizedRoute) {
      renderOptimizedRoute(container);
    }

    // イベント: モード切替
    container.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterMode = btn.dataset.mode;
        activeFilter = getDefaultFilter(btn.dataset.mode);
        Router.navigate('home');
      });
    });

    // イベント: フィルタータブ
    container.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeFilter = tab.dataset.cat;
        Router.navigate('home');
      });
    });

    // イベント: エリア一括選択
    document.getElementById('btn-select-area')?.addEventListener('click', () => {
      if (allFilteredSelected) {
        const removeSet = new Set(sorted.map(s => s.store_id));
        selectedStoreIds = selectedStoreIds.filter(id => !removeSet.has(id));
      } else {
        sorted.forEach(s => {
          if (!selectedStoreIds.includes(s.store_id)) selectedStoreIds.push(s.store_id);
        });
      }
      optimizedRoute = null;
      Router.navigate('home');
    });

    // イベント: 個別店舗選択
    container.querySelectorAll('.store-item').forEach(el => {
      el.addEventListener('click', () => {
        const sid = el.dataset.sid;
        const idx = selectedStoreIds.indexOf(sid);
        if (idx >= 0) selectedStoreIds.splice(idx, 1);
        else selectedStoreIds.push(sid);
        optimizedRoute = null;
        Router.navigate('home');
      });
    });

    document.getElementById('btn-clear')?.addEventListener('click', () => {
      selectedStoreIds = [];
      optimizedRoute = null;
      Router.navigate('home');
    });

    document.getElementById('btn-optimize')?.addEventListener('click', doOptimize);
  }

  function doOptimize() {
    const selected = selectedStoreIds.map(id => stores.find(s => s.store_id === id)).filter(Boolean);
    const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
    const speed = Number(config.avg_speed_kmh) || 30;
    const optRoute = RouteOptimizer.optimize(home, selected, speed);
    const selRoute = RouteOptimizer.calcSelectionOrder(home, selected, speed);
    Router.navigate('route-select', { optRoute, selRoute });
  }

  function renderOptimizedRoute(container) {
    const r = optimizedRoute;
    // Google Maps URLは後からGPS現在地で差し替え
    let mapsUrl = RouteOptimizer.generateMapsUrl({ lat: Number(config.home_lat), lng: Number(config.home_lng) }, r.orderedStores);
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
        <a href="${mapsUrl}" target="_blank" class="btn btn-outline" style="flex:1;text-decoration:none;" id="btn-maps-link">Google Maps</a>
        <button class="btn btn-success" style="flex:1;" id="btn-start-patrol">巡回開始</button>
      </div>`;
    html += '</div>';

    container.insertAdjacentHTML('beforeend', html);

    document.getElementById('btn-start-patrol')?.addEventListener('click', startPatrol);
  }

  // ---------- ルート選択画面 ----------

  function renderRouteSelect(container, { optRoute, selRoute } = {}) {
    if (!optRoute || !selRoute) { Router.navigate('home'); return; }
    setTitle('ルート選択');

    // 距離の差分を計算
    const diffKm = Math.round((selRoute.totalDistanceKm - optRoute.totalDistanceKm) * 10) / 10;
    const diffMin = selRoute.estimatedMinutes - optRoute.estimatedMinutes;

    function formatEstimate(r) {
      const h = Math.floor(r.estimatedMinutes / 60);
      const m = r.estimatedMinutes % 60;
      return h > 0 ? `${h}h${m}m` : `${m}m`;
    }

    function buildStopList(orderedStores) {
      let html = '';
      orderedStores.forEach((s, i) => {
        html += `
          <div class="route-stop">
            <div class="stop-num">${i + 1}</div>
            <span class="stop-name">${s.icon || ''} ${esc(s.name)}</span>
            <span class="stop-stay">${s.avg_stay_min || 30}分</span>
          </div>`;
      });
      return html;
    }

    let html = '<div class="text-sm text-dim text-center mb-8">巡回ルートを選択してください</div>';

    // 最適化ルートカード
    html += `
      <div class="route-select-card selected" data-route="optimized">
        <div class="route-select-header">
          <div class="route-select-title">
            <span class="route-select-icon">&#x26A1;</span>最適化ルート
          </div>
          <div class="route-select-badge badge badge-primary">おすすめ</div>
        </div>
        <div class="route-stats">
          <div class="route-stat"><div class="value">${optRoute.totalDistanceKm}</div><div class="label">km</div></div>
          <div class="route-stat"><div class="value">${formatEstimate(optRoute)}</div><div class="label">推定時間</div></div>
          <div class="route-stat"><div class="value">${optRoute.orderedStores.length}</div><div class="label">店舗</div></div>
        </div>
        ${buildStopList(optRoute.orderedStores)}
      </div>`;

    // 選択順ルートカード
    html += `
      <div class="route-select-card" data-route="selection">
        <div class="route-select-header">
          <div class="route-select-title">
            <span class="route-select-icon">&#x1F4CB;</span>選択順ルート
          </div>
          ${diffKm > 0 ? `<div class="text-sm text-dim">+${diffKm}km / +${diffMin}分</div>` : ''}
        </div>
        <div class="route-stats">
          <div class="route-stat"><div class="value">${selRoute.totalDistanceKm}</div><div class="label">km</div></div>
          <div class="route-stat"><div class="value">${formatEstimate(selRoute)}</div><div class="label">推定時間</div></div>
          <div class="route-stat"><div class="value">${selRoute.orderedStores.length}</div><div class="label">店舗</div></div>
        </div>
        ${buildStopList(selRoute.orderedStores)}
      </div>`;

    // アクションボタン
    html += `
      <div style="position:sticky;bottom:60px;padding:8px 0;background:var(--bg);">
        <button class="btn btn-success btn-block" id="btn-confirm-route">このルートで開始</button>
        <button class="btn btn-outline btn-block mt-8" id="btn-back-select">戻る</button>
      </div>`;

    container.innerHTML = html;

    // 選択状態管理
    let selectedRoute = 'optimized';

    container.querySelectorAll('.route-select-card').forEach(card => {
      card.addEventListener('click', () => {
        container.querySelectorAll('.route-select-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedRoute = card.dataset.route;
      });
    });

    document.getElementById('btn-confirm-route')?.addEventListener('click', () => {
      optimizedRoute = selectedRoute === 'optimized' ? optRoute : selRoute;
      // Google Maps URL生成してナビ画面へ
      const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
      const mapsUrl = RouteOptimizer.generateMapsUrl(home, optimizedRoute.orderedStores);
      optimizedRoute._mapsUrl = mapsUrl;
      Router.navigate('home');
      // 最適化ルート表示部分へスクロール
      setTimeout(() => {
        const el = document.querySelector('.route-result');
        if (el) {
          const y = el.getBoundingClientRect().top + window.pageYOffset - 60;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      }, 100);
    });

    document.getElementById('btn-back-select')?.addEventListener('click', () => {
      Router.navigate('home');
    });
  }

  // ---------- 巡回モード ----------

  function startPatrol() {
    if (!optimizedRoute) return;
    const storeIds = optimizedRoute.orderedStores.map(s => s.store_id);

    // 即座にUI遷移（API応答を待たない）
    patrolState = {
      routeId: 'pending',
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
    Storage.saveCurrentRoute(patrolState);
    Router.navigate('patrol');

    // バックグラウンドでAPI同期 & route_id取得
    API.startRoute({
      store_ids: storeIds,
      total_distance_km: optimizedRoute.totalDistanceKm
    }).then(() =>
      API.getRouteHistory({ limit: 1 })
    ).then(history => {
      if (history && history.length > 0) {
        patrolState.routeId = history[0].route_id;
        Storage.saveCurrentRoute(patrolState);
      }
    }).catch(() => {});
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
        <div class="current-meta">${esc(current.category)} | ${formatTime(current.open_time)}-${formatTime(current.close_time)}</div>
      </div>`;

    if (current.status === 'planned') {
      html += `<button class="btn btn-primary btn-block" id="btn-arrive">到着</button>`;
    } else {
      // 滞在中アクション
      html += `
        <div class="patrol-actions">
          <button class="btn btn-warning" id="btn-purchase">仕入れ記録</button>
          <button class="btn btn-success" id="btn-depart">出発</button>
        </div>`;
    }

    // スキップ
    html += `<div class="mt-12"><button class="btn btn-sm btn-outline btn-block" id="btn-skip">スキップ</button></div>`;

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

    // 店舗を追加ボタン
    html += `<div class="mt-12"><button class="btn btn-sm btn-outline btn-block" id="btn-add-stop" style="border-style:dashed;color:var(--primary)">+ 店舗を追加</button></div>`;

    // 巡回終了（残り店舗の下に離して配置）
    html += `<div style="margin-top:40px;"><button class="btn btn-sm btn-accent btn-block" id="btn-end">巡回終了</button></div>`;

    container.innerHTML = html;

    // タイマー開始
    startPatrolTimer();

    // イベント（UIを即更新、API同期はバックグラウンド）
    document.getElementById('btn-arrive')?.addEventListener('click', () => {
      current.status = 'visiting';
      current.arrivalTime = new Date().toISOString();
      Router.navigate('patrol');
      // バックグラウンドでAPI同期
      API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'visiting',
        arrival_time: current.arrivalTime
      }).catch(() => {});
      Storage.saveCurrentRoute(patrolState);
    });

    document.getElementById('btn-depart')?.addEventListener('click', () => {
      current.status = 'visited';
      current.departureTime = new Date().toISOString();
      // バックグラウンドでAPI同期
      API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        departure_time: current.departureTime,
        purchase_amount: current.purchaseAmount,
        purchase_items: current.purchaseItems
      }).catch(() => {});
      patrolState.currentIdx++;
      Storage.saveCurrentRoute(patrolState);
      if (patrolState.currentIdx >= stops.length) {
        endPatrol();
      } else {
        Router.navigate('patrol');
      }
    });

    document.getElementById('btn-skip')?.addEventListener('click', () => {
      current.status = 'skipped';
      // バックグラウンドでAPI同期
      API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'skipped'
      }).catch(() => {});
      patrolState.currentIdx++;
      Storage.saveCurrentRoute(patrolState);
      if (patrolState.currentIdx >= stops.length) {
        endPatrol();
      } else {
        Router.navigate('patrol');
      }
    });

    document.getElementById('btn-end')?.addEventListener('click', () => endPatrol());

    document.getElementById('btn-add-stop')?.addEventListener('click', () => {
      const existingIds = new Set(patrolState.stops.map(s => s.store_id));
      showAddStopModal(existingIds, (store) => {
        // ローカルのpatrolStateに追加
        const newStop = {
          ...store,
          status: 'planned',
          arrivalTime: null,
          departureTime: null,
          purchaseAmount: 0,
          purchaseItems: 0
        };
        patrolState.stops.push(newStop);
        Storage.saveCurrentRoute(patrolState);
        toast(`${store.name} を追加しました`);
        Router.navigate('patrol');
        // バックグラウンドでAPI同期
        API.addStopToRoute({
          route_id: patrolState.routeId,
          store_id: store.store_id
        }).catch(() => {});
      });
    });

    document.getElementById('btn-purchase')?.addEventListener('click', () => showPurchaseModal(current));
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

  function endPatrol() {
    if (patrolTimerInterval) { clearInterval(patrolTimerInterval); patrolTimerInterval = null; }
    if (patrolState) {
      const summary = { ...patrolState };
      const routeId = patrolState.routeId;
      patrolState = null;
      Storage.clearCurrentRoute();
      Router.navigate('summary', { summary });
      // バックグラウンドでAPI同期 & データ再取得
      API.endRoute({ route_id: routeId }).catch(() => {});
      loadData();
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
    showModal('仕入れ記録', body, (el) => {
      const amount = Number(el.querySelector('#m-amount').value) || 0;
      const items = Number(el.querySelector('#m-items').value) || 1;
      const genre = el.querySelector('#m-genre').value;
      const note = el.querySelector('#m-note').value;

      stop.purchaseAmount += amount;
      stop.purchaseItems += items;
      Storage.saveCurrentRoute(patrolState);
      toast(`${amount.toLocaleString()}円 記録しました`);
      Router.navigate('patrol');
      // バックグラウンドでAPI同期
      API.addPurchase({
        store_id: stop.store_id,
        route_id: patrolState.routeId,
        amount, items_count: items, genre, note
      }).catch(() => {});
    });
  }

  // ---------- 店舗追加モーダル（巡回中 & 履歴詳細共用） ----------

  function showAddStopModal(existingStoreIds, onSelect) {
    // existingStoreIds: Set of store_id already in the route
    const available = stores.filter(s => !existingStoreIds.has(s.store_id));
    if (available.length === 0) {
      toast('追加できる店舗がありません');
      return;
    }

    // エリア・チェーン情報付与
    const storesWithMeta = available.map(s => ({
      ...s,
      _area: getArea(s),
      _areaName: AREAS.find(a => a.id === getArea(s))?.name || 'その他',
      _chain: getChain(s),
      _genre: getGenre(s)
    }));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // フィルタオプション生成
    const areaSet = [...new Set(storesWithMeta.map(s => s._area))];
    const areaOptions = areaSet.map(id => {
      const a = AREAS.find(x => x.id === id);
      return `<option value="${id}">${a ? a.name : id}</option>`;
    }).join('');

    const genreSet = [...new Set(storesWithMeta.map(s => s._genre))];
    const genreOptions = genreSet.map(g => `<option value="${g}">${GENRE_DISPLAY[g] || g}</option>`).join('');

    overlay.innerHTML = `
      <div class="modal" style="max-height:85vh;">
        <div class="modal-title">店舗を追加</div>
        <div class="form-group">
          <input type="text" class="form-input" id="stop-search" placeholder="店舗名で検索...">
        </div>
        <div class="flex gap-8 mb-8">
          <select class="form-select" id="stop-filter-area" style="flex:1;font-size:12px;padding:6px 8px;">
            <option value="">エリア: すべて</option>
            ${areaOptions}
          </select>
          <select class="form-select" id="stop-filter-genre" style="flex:1;font-size:12px;padding:6px 8px;">
            <option value="">ジャンル: すべて</option>
            ${genreOptions}
          </select>
        </div>
        <div id="stop-store-list" style="max-height:50vh;overflow-y:auto;"></div>
        <div class="mt-8">
          <button class="btn btn-outline btn-block" id="stop-modal-cancel">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#stop-store-list');
    const searchInput = overlay.querySelector('#stop-search');
    const areaFilter = overlay.querySelector('#stop-filter-area');
    const genreFilter = overlay.querySelector('#stop-filter-genre');

    function renderList() {
      const query = (searchInput.value || '').trim().toLowerCase();
      const areaVal = areaFilter.value;
      const genreVal = genreFilter.value;

      let filtered = storesWithMeta;
      if (query) filtered = filtered.filter(s => s.name.toLowerCase().includes(query));
      if (areaVal) filtered = filtered.filter(s => s._area === areaVal);
      if (genreVal) filtered = filtered.filter(s => s._genre === genreVal);

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="text-center text-dim text-sm" style="padding:20px;">該当する店舗がありません</div>';
        return;
      }

      let html = '';
      filtered.forEach(s => {
        html += `
          <div class="store-item add-stop-item" data-sid="${s.store_id}" style="cursor:pointer;">
            <span class="store-icon">${s.icon || '&#x1f3ea;'}</span>
            <div class="store-info">
              <div class="store-name">${esc(s.name)}</div>
              <div class="store-meta">${esc(s._areaName)} | ${esc(s.category)} | ${formatTime(s.open_time)}-${formatTime(s.close_time)}</div>
            </div>
          </div>`;
      });
      listEl.innerHTML = html;

      // 各店舗クリックで選択
      listEl.querySelectorAll('.add-stop-item').forEach(el => {
        el.addEventListener('click', () => {
          const sid = el.dataset.sid;
          const store = stores.find(s => s.store_id === sid);
          if (store) {
            overlay.remove();
            onSelect(store);
          }
        });
      });
    }

    renderList();

    searchInput.addEventListener('input', renderList);
    areaFilter.addEventListener('change', renderList);
    genreFilter.addEventListener('change', renderList);

    overlay.querySelector('#stop-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
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
      selectedStoreIds = [];
      Router.navigate('home');
      setNavActive('home');
    });
  }

  function showAddStoreModal() {
    const body = storeFormHtml({});
    showModal('店舗追加', body, async (el) => {
      const data = readStoreForm(el);
      await API.addStore(data);
      await loadData();
      toast('店舗を追加しました');
      Router.navigate('settings');
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
      Router.navigate('settings');
    });
  }

  function storeFormHtml(s) {
    return `
      <div class="form-group"><label class="form-label">店舗名</label>
        <input type="text" class="form-input" id="sf-name" value="${esc(s.name || '')}"></div>
      <div class="form-group"><label class="form-label">カテゴリ</label>
        <select class="form-select" id="sf-category">
          ${['家電量販','HC','ドンキ','リサイクル','カー用品','その他'].map(c =>
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

  let historyCache = []; // renderHistoryDetail用に保持

  async function renderHistory(container) {
    setTitle('履歴・分析');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const routes = await API.getRouteHistory({ limit: 20, include_stops: 'true' });
      historyCache = routes;
      if (routes.length === 0) {
        container.innerHTML = '<div class="text-center text-dim mt-12">巡回履歴がありません</div>';
        return;
      }

      let html = '';
      routes.forEach((r, idx) => {
        const dateStr = r.date ? new Date(r.date).toLocaleDateString('ja-JP') : '不明';
        html += `
          <div class="history-item" data-idx="${idx}" style="cursor:pointer">
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

      // 各履歴タップ→詳細
      container.querySelectorAll('.history-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = Number(el.dataset.idx);
          Router.navigate('history-detail', { route: historyCache[idx] });
        });
      });
    } catch (e) {
      container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
    }
  }

  function renderHistoryDetail(container, { route } = {}) {
    if (!route) { Router.navigate('history'); return; }
    setTitle('履歴詳細');

    const dateStr = route.date ? new Date(route.date).toLocaleDateString('ja-JP') : '不明';
    let html = '';

    // 基本情報
    html += `
      <div class="card">
        <div class="card-title">${dateStr} の巡回</div>
        <div class="summary-grid">
          <div class="summary-item"><div class="value">${route.store_count || 0}</div><div class="label">店舗数</div></div>
          <div class="summary-item"><div class="value">${route.total_distance_km || 0}km</div><div class="label">距離</div></div>
          <div class="summary-item"><div class="value">${Number(route.total_purchase || 0).toLocaleString()}円</div><div class="label">仕入れ</div></div>
          <div class="summary-item"><div class="value">${route.total_items || 0}</div><div class="label">点数</div></div>
        </div>
      </div>`;

    // 各店舗の詳細
    if (route.stops && route.stops.length > 0) {
      html += '<div class="card-title">訪問店舗</div>';
      route.stops.forEach((s, i) => {
        const storeObj = stores.find(st => st.store_id === s.store_id);
        const storeName = (storeObj && storeObj.name) || s.store_name || s.store_id;
        const statusBadge = s.status === 'visited' ? '<span class="badge badge-success">訪問済</span>'
          : s.status === 'skipped' ? '<span class="badge">スキップ</span>' : '';
        const purchase = Number(s.purchase_amount || 0);
        html += `
          <div class="card">
            <div class="flex-between">
              <span>${i + 1}. ${esc(storeName)}</span>
              ${statusBadge}
            </div>
            ${purchase > 0 ? `<div class="text-sm mt-8">仕入れ: ${purchase.toLocaleString()}円</div>` : ''}
            ${s.arrival_time ? `<div class="text-sm text-dim">到着: ${new Date(s.arrival_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
            ${s.departure_time ? `<div class="text-sm text-dim">出発: ${new Date(s.departure_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
          </div>`;
      });
    }

    if (route.note) {
      html += `<div class="card"><div class="card-title">メモ</div><div>${esc(route.note)}</div></div>`;
    }

    // 店舗を追加ボタン
    html += `<button class="btn btn-outline btn-block mt-12" id="btn-add-stop-history" style="border-style:dashed;color:var(--primary)">+ 店舗を追加</button>`;

    // 戻るボタン
    html += `<button class="btn btn-outline btn-block mt-12" id="btn-back-history">履歴一覧に戻る</button>`;

    // 個別消去ボタン
    html += `<button class="btn btn-accent btn-block mt-12" id="btn-delete-route">この履歴を消去</button>`;

    container.innerHTML = html;

    document.getElementById('btn-add-stop-history')?.addEventListener('click', () => {
      const existingIds = new Set((route.stops || []).map(s => s.store_id));
      showAddStopModal(existingIds, async (store) => {
        // route.stopsに追加（ローカル）
        if (!route.stops) route.stops = [];
        route.stops.push({
          route_id: route.route_id,
          store_id: store.store_id,
          stop_order: route.stops.length + 1,
          status: 'planned',
          arrival_time: '',
          departure_time: '',
          purchase_amount: 0,
          purchase_items: 0
        });
        route.store_count = route.stops.length;
        toast(`${store.name} を追加しました`);
        Router.navigate('history-detail', { route });
        // API同期
        API.addStopToRoute({
          route_id: route.route_id,
          store_id: store.store_id
        }).catch(() => {});
      });
    });

    document.getElementById('btn-back-history')?.addEventListener('click', () => {
      Router.navigate('history');
    });

    document.getElementById('btn-delete-route')?.addEventListener('click', () => {
      if (!confirm('この履歴を消去しますか？')) return;
      toast('履歴を消去しました');
      Router.navigate('history');
      // バックグラウンドでAPI同期
      API.deleteRoute({ route_id: route.route_id }).catch(() => {});
      loadData();
    });
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
      </div>
      <div class="card">
        <div class="card-title">店舗管理</div>
        <button class="btn btn-primary btn-sm mb-8" id="btn-add-store">+ 店舗追加</button>
        <div id="store-list"></div>
      </div>
      <div class="card">
        <div class="card-title">履歴消去</div>
        <div class="text-sm text-dim mb-8">全ての巡回履歴・仕入れ記録を削除します。この操作は取り消せません。</div>
        <button class="btn btn-sm btn-accent" id="btn-clear-history">全履歴を消去</button>
      </div>`;

    container.innerHTML = html;

    // 店舗一覧を描画
    const storeListEl = document.getElementById('store-list');
    if (storeListEl) {
      let storeHtml = '';
      stores.forEach(s => {
        storeHtml += `
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
      storeListEl.innerHTML = storeHtml;
    }

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

    document.getElementById('btn-clear-history')?.addEventListener('click', () => {
      if (!confirm('全ての巡回履歴を消去しますか？')) return;
      if (!confirm('本当に消去しますか？この操作は取り消せません。')) return;
      (async () => {
        try {
          await API.clearHistory();
          await loadData();
          toast('全履歴を消去しました');
        } catch (err) {
          toast('消去に失敗: ' + err.message);
        }
      })();
    });

    document.getElementById('btn-add-store')?.addEventListener('click', () => showAddStoreModal());
    container.querySelectorAll('.edit-store').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const store = stores.find(s => s.store_id === btn.dataset.sid);
        if (store) showEditStoreModal(store);
      });
    });
  }

  // ---------- ユーティリティ ----------

  function formatTime(val) {
    if (!val) return '';
    // "10:00" のような文字列はそのまま返す
    if (typeof val === 'string' && /^\d{1,2}:\d{2}/.test(val) && !val.includes('T')) return val;
    // Google Sheets の時刻値: "1899-12-30T02:00:00.000Z" → ローカル時間に変換
    if (typeof val === 'string' && (val.includes('1899-') || val.includes('T'))) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        const h = d.getHours();
        const m = d.getMinutes();
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
    }
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
