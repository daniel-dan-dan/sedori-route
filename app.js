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
  let viewMode = 'list'; // 'list' | 'map'
  let mapInstance = null;
  let mapCluster = null;
  let mapChainFilter = 'all';

  // チェーン別ブランドカラー（ピン・チップの色分け）
  const CHAIN_COLORS = {
    'ヤマダデンキ': '#0080C8',
    'ケーズデンキ': '#E60012',
    'コジマ×ビックカメラ': '#E60012',
    'エディオン': '#E94709',
    'ノジマ': '#FF6A00',
    'ジョーシン': '#1E67B3',
    'ブックオフ': '#F5D200',
    'セカンドストリート': '#4CAF50',
    'トレファク': '#F08300',
    'オフハウス': '#4FC3F7',
    'ドンキホーテ': '#FFCC00',
    'カインズ': '#2E7D32',
    'DCM': '#FF7F00',
    'ダイユーエイト': '#2A6EB5',
    'サンデー': '#1E67B3',
    'コメリ': '#E60012',
    'コーナン': '#1E67B3',
    'ビバホーム': '#DE611C',
    'オートバックス': '#FFB300',
    'イエローハット': '#FFC107',
    'ジェームス': '#1E67B3',
    'イオン': '#B60081',
    'コストコ': '#E60012',
    'トイザらス': '#E60012',
    'オフィスベンダー': '#6B7280',
  };

  function getChainColor(store) {
    const chain = getChain(store);
    return CHAIN_COLORS[chain] || '#6B7280';
  }

  function renderStoreIconHtml(store) {
    const chain = getChain(store);
    const logo = CHAIN_LOGOS[chain];
    if (logo) {
      const color = CHAIN_COLORS[chain] || '#6B7280';
      return `<span class="store-icon store-icon-logo" style="border-color:${color}"><img src="${logo}" alt=""></span>`;
    }
    return `<span class="store-icon">${store.icon || '&#x1f3ea;'}</span>`;
  }

  // 営業状態判定 → { label, cls }
  function getBusinessStatus(store) {
    const open = formatTime(store.open_time);
    const close = formatTime(store.close_time);
    if (!open || !close) return null;
    const parseHM = (s) => {
      const m = /^(\d{1,2}):(\d{2})/.exec(s);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const openM = parseHM(open);
    let closeM = parseHM(close);
    if (openM == null || closeM == null) return null;
    if (closeM <= openM) closeM += 24 * 60; // 翌日またぎ
    const now = new Date();
    let nowM = now.getHours() * 60 + now.getMinutes();
    // 深夜営業の場合の補正
    if (closeM > 24 * 60 && nowM < openM) nowM += 24 * 60;
    if (nowM < openM || nowM >= closeM) {
      return { label: '閉店中', cls: 'closed' };
    }
    if (closeM - nowM <= 60) {
      return { label: `あと${closeM - nowM}分`, cls: 'closing-soon' };
    }
    return { label: '営業中', cls: 'open' };
  }

  function renderStoreStatusPill(store) {
    const st = getBusinessStatus(store);
    if (!st) return '';
    return `<span class="store-status ${st.cls}">${st.label}</span>`;
  }

  // コンパクトなインライン用ロゴ（巡回リスト等）
  function renderStopIconHtml(store) {
    const chain = getChain(store);
    const logo = CHAIN_LOGOS[chain];
    if (logo) {
      const color = CHAIN_COLORS[chain] || '#6B7280';
      return `<span class="stop-icon-logo" style="border-color:${color}"><img src="${logo}" alt=""></span>`;
    }
    return `<span class="stop-icon-emoji">${store.icon || '&#x1f3ea;'}</span>`;
  }

  // チェーン別ロゴ（公式サイト/Wikimedia Commons由来）
  const CHAIN_LOGOS = {
    'ヤマダデンキ': 'icons/chains/yamada.png',
    'ケーズデンキ': 'icons/chains/kdenki.png',
    'コジマ×ビックカメラ': 'icons/chains/kojima.png',
    'エディオン': 'icons/chains/edion.png',
    'ノジマ': 'icons/chains/nojima.png',
    'ジョーシン': 'icons/chains/joshin.png',
    'ブックオフ': 'icons/chains/bookoff.png',
    'セカンドストリート': 'icons/chains/2ndstreet.png',
    'トレファク': 'icons/chains/trefac.png',
    'オフハウス': 'icons/chains/offhouse.png',
    'ドンキホーテ': 'icons/chains/donki.png',
    'カインズ': 'icons/chains/cainz.png',
    'DCM': 'icons/chains/dcm.png',
    'ダイユーエイト': 'icons/chains/daiyu8.png',
    'サンデー': 'icons/chains/sunday.png',
    'コメリ': 'icons/chains/komeri.png',
    'コーナン': 'icons/chains/kohnan.png',
    'ビバホーム': 'icons/chains/vivahome.png',
    'オートバックス': 'icons/chains/autobacs.png',
    'イエローハット': 'icons/chains/yhat.png',
    'ジェームス': 'icons/chains/james.png',
    'イオン': 'icons/chains/aeon.png',
    'コストコ': 'icons/chains/costco.png',
    'トイザらス': 'icons/chains/toysrus.png',
    'オフィスベンダー': 'icons/chains/ofv.png',
  };

  const CHAIN_ABBR = {};

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
    { re: /BOOKOFF|ブックオフ/i, chain: 'ブックオフ' },
    { re: /スーパーセカンドストリート|セカンドストリート/, chain: 'セカンドストリート' },
    { re: /トレファクスタイル|トレジャーファクトリー/, chain: 'トレファク' },
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
    { re: /スーパービバホーム|ビバホーム/, chain: 'ビバホーム' },
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
    Router.register('analytics', renderAnalytics);
    Router.register('patrol', renderPatrol);
    Router.register('summary', renderSummary);
  }

  // ---------- 優先度スコア計算 ----------

  function calcPriorityScore(store) {
    const visits = Number(store.visit_count) || 0;
    const totalPurchase = Number(store.total_purchase) || 0;
    const avgPerVisit = visits > 0 ? totalPurchase / visits : 0;
    const lastVisit = store.last_visited ? new Date(store.last_visited) : null;
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

    if (viewMode === 'map') {
      return renderMapView(container);
    }

    let html = '';

    // 表示切替（リスト / マップ）
    html += `<div class="view-toggle">
      <button class="view-btn active" data-view="list">&#x1f4cb; リスト</button>
      <button class="view-btn" data-view="map">&#x1f5fa;&#xfe0f; マップ</button>
    </div>`;

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

    // ソート: チェーン名でまとめ、同チェーン内はスコア順
    let sorted;
    if (filterMode === 'area') {
      sorted = [...filtered].sort((a, b) => {
        const gi = GENRE_ORDER.indexOf(getGenre(a)) - GENRE_ORDER.indexOf(getGenre(b));
        if (gi !== 0) return gi;
        const ci = getChain(a).localeCompare(getChain(b));
        return ci !== 0 ? ci : calcPriorityScore(b) - calcPriorityScore(a);
      });
    } else if (filterMode === 'genre') {
      sorted = [...filtered].sort((a, b) => {
        const ci = getChain(a).localeCompare(getChain(b));
        return ci !== 0 ? ci : calcPriorityScore(b) - calcPriorityScore(a);
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
          ${renderStoreIconHtml(s)}
          <div class="store-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="store-meta">${renderStoreStatusPill(s)}${esc(s.category)} | ${formatTime(s.open_time)}-${formatTime(s.close_time)} | ${s.avg_stay_min}分</div>
            ${score > 0 ? `<div class="store-score">Score: ${score}</div>` : ''}
          </div>
          <div class="store-check">${selIdx >= 0 ? getSelectionLabel(selIdx) : ''}</div>
        </div>`;
    });

    // フローティング操作バー（選択中の店舗がある場合のみ）
    if (selectedStoreIds.length > 0) {
      const selected = selectedStoreIds.map(id => stores.find(s => s.store_id === id)).filter(Boolean);
      const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
      const speed = Number(config.avg_speed_kmh) || 30;
      let etaHtml = '';
      if (home.lat && home.lng && selected.length >= 1) {
        const est = RouteOptimizer.calcSelectionOrder(home, selected, speed);
        etaHtml = `<span class="fab-eta">約 ${est.totalDistanceKm}km / ${est.estimatedMinutes}分</span>`;
      }
      html += `
        <div class="floating-action-bar">
          <div class="floating-action-bar-inner">
            <div class="fab-summary">
              <span class="fab-count">${selectedStoreIds.length}店舗 選択中</span>
              ${etaHtml}
              <button class="fab-clear" id="btn-clear">クリア</button>
            </div>
            <button class="btn btn-primary btn-block" id="btn-optimize">
              ルート最適化
            </button>
          </div>
        </div>`;
    }

    container.innerHTML = html;
    container.classList.toggle('has-floating-bar', selectedStoreIds.length > 0);

    // 最適化済みルートがあれば表示
    if (optimizedRoute) {
      renderOptimizedRoute(container);
    }

    // イベント: 表示切替（リスト ↔ マップ）
    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view;
        Router.navigate('home');
      });
    });

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
        const tabs = container.querySelector('.filter-tabs');
        const savedScroll = tabs ? tabs.scrollLeft : 0;
        activeFilter = tab.dataset.cat;
        Router.navigate('home');
        const newTabs = document.querySelector('.filter-tabs');
        if (newTabs) newTabs.scrollLeft = savedScroll;
      });
    });

    // アクティブなフィルタータブを自動で可視領域に
    const activeTab = container.querySelector('.filter-tab.active');
    if (activeTab) {
      const tabsEl = container.querySelector('.filter-tabs');
      if (tabsEl) {
        const tabRect = activeTab.getBoundingClientRect();
        const containerRect = tabsEl.getBoundingClientRect();
        if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
          activeTab.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
        }
      }
    }

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

  // ---------- マップビュー ----------

  function buildPinIcon(store, selectionIdx) {
    const chain = getChain(store);
    const logo = CHAIN_LOGOS[chain];
    const abbr = CHAIN_ABBR[chain];
    const selected = selectionIdx >= 0;
    const label = selected ? getSelectionLabel(selectionIdx) : '';
    const color = getChainColor(store);
    const cls = selected ? 'map-pin selected' : 'map-pin';
    const badge = selected ? `<span class="map-pin-badge">${label}</span>` : '';

    let inner;
    if (logo) {
      inner = `<img class="map-pin-logo" src="${logo}" alt="">`;
    } else if (abbr) {
      inner = `<span class="map-pin-text">${esc(abbr)}</span>`;
    } else {
      inner = `<span class="map-pin-emoji">${store.icon || '&#x1f3ea;'}</span>`;
    }
    const style = `border-color:${color}`;
    return L.divIcon({
      className: '',
      html: `<div class="${cls}" style="${style}">${inner}${badge}</div>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function renderMapView(container) {
    // チェーン別集計（座標ありのみ）
    const chainCounts = {};
    stores.forEach(s => {
      if (!Number(s.lat) || !Number(s.lng)) return;
      const c = getChain(s);
      chainCounts[c] = (chainCounts[c] || 0) + 1;
    });
    const chainNames = Object.keys(chainCounts).sort((a, b) => chainCounts[b] - chainCounts[a]);
    const totalMapped = Object.values(chainCounts).reduce((a, b) => a + b, 0);

    // フィルター対象が存在しない場合は「全て」に戻す
    if (mapChainFilter !== 'all' && !chainCounts[mapChainFilter]) mapChainFilter = 'all';

    let chipHtml = `<div class="map-chain-filter">`;
    chipHtml += `<button class="chain-chip ${mapChainFilter === 'all' ? 'active' : ''}" data-chain="all">全て(${totalMapped})</button>`;
    chainNames.forEach(c => {
      const color = CHAIN_COLORS[c] || '#6B7280';
      const active = mapChainFilter === c ? 'active' : '';
      chipHtml += `<button class="chain-chip ${active}" data-chain="${esc(c)}" style="--chip-color:${color}">${esc(c)}(${chainCounts[c]})</button>`;
    });
    chipHtml += `</div>`;

    container.innerHTML = `
      <div class="view-toggle">
        <button class="view-btn" data-view="list">&#x1f4cb; リスト</button>
        <button class="view-btn active" data-view="map">&#x1f5fa;&#xfe0f; マップ</button>
      </div>
      ${chipHtml}
      <div id="map-view"></div>
      <div class="map-bottom-bar">
        <div class="flex-between mb-8">
          <span class="text-sm text-dim"><span id="map-sel-count">${selectedStoreIds.length}</span>店舗 選択中</span>
          <button class="btn btn-sm btn-outline" id="btn-map-clear">クリア</button>
        </div>
        <button class="btn btn-primary btn-block" id="btn-map-optimize" ${selectedStoreIds.length < 1 ? 'disabled' : ''}>
          ルート最適化
        </button>
      </div>
    `;

    // 表示切替イベント
    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view;
        if (mapInstance) { mapInstance.remove(); mapInstance = null; mapCluster = null; }
        Router.navigate('home');
      });
    });

    // チェーンチップ: 押したチェーンだけ表示
    container.querySelectorAll('.chain-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const chips = container.querySelector('.map-chain-filter');
        const savedScroll = chips ? chips.scrollLeft : 0;
        mapChainFilter = chip.dataset.chain;
        if (mapInstance) { mapInstance.remove(); mapInstance = null; mapCluster = null; }
        Router.navigate('home');
        const newChips = document.querySelector('.map-chain-filter');
        if (newChips) newChips.scrollLeft = savedScroll;
      });
    });

    // Leaflet初期化
    setTimeout(() => initMap(), 10);

    document.getElementById('btn-map-clear').addEventListener('click', () => {
      selectedStoreIds = [];
      optimizedRoute = null;
      refreshMapMarkers();
      updateMapBottomBar();
    });
    document.getElementById('btn-map-optimize').addEventListener('click', doOptimize);
  }

  function initMap() {
    const mapEl = document.getElementById('map-view');
    if (!mapEl) return;
    if (mapInstance) { mapInstance.remove(); mapInstance = null; mapCluster = null; }

    // 中心は自宅 or 仙台駅（fitBounds前の仮中心）
    const centerLat = Number(config.home_lat) || 38.2603;
    const centerLng = Number(config.home_lng) || 140.8828;

    mapInstance = L.map(mapEl, {
      center: [centerLat, centerLng],
      zoom: 11,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(mapInstance);

    // 自宅マーカー
    if (config.home_lat && config.home_lng) {
      L.marker([centerLat, centerLng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="map-pin map-pin-home"><span class="map-pin-emoji">&#x1f3e0;</span></div>`,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        }),
        interactive: false,
      }).addTo(mapInstance);
    }

    // クラスタリングせず、全ピンを個別に表示するためLayerGroupを使用
    mapCluster = L.layerGroup();
    mapInstance.addLayer(mapCluster);
    refreshMapMarkers();
    fitMapToMarkers();
  }

  function refreshMapMarkers() {
    if (!mapInstance || !mapCluster) return;
    mapCluster.clearLayers();
    stores.forEach(s => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      if (!lat || !lng) return;
      if (mapChainFilter !== 'all' && getChain(s) !== mapChainFilter) return;
      const selIdx = selectedStoreIds.indexOf(s.store_id);
      const marker = L.marker([lat, lng], { icon: buildPinIcon(s, selIdx) });
      marker.bindPopup(
        `<div class="map-popup">
          <div class="map-popup-name">${esc(s.name)}</div>
          <div class="map-popup-meta">${esc(s.category || '')}</div>
          <button class="btn btn-sm btn-primary" data-sid="${s.store_id}" onclick="App.toggleMapSelection('${s.store_id}')">
            ${selIdx >= 0 ? '選択解除' : '選択'}
          </button>
        </div>`
      );
      mapCluster.addLayer(marker);
    });
  }

  function fitMapToMarkers() {
    if (!mapInstance || !mapCluster) return;
    const latlngs = [];
    stores.forEach(s => {
      const lat = Number(s.lat), lng = Number(s.lng);
      if (!lat || !lng) return;
      if (mapChainFilter !== 'all' && getChain(s) !== mapChainFilter) return;
      latlngs.push([lat, lng]);
    });
    if (config.home_lat && config.home_lng) {
      latlngs.push([Number(config.home_lat), Number(config.home_lng)]);
    }
    if (latlngs.length === 0) return;
    const bounds = L.latLngBounds(latlngs);
    mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }

  function toggleMapSelection(sid) {
    const idx = selectedStoreIds.indexOf(sid);
    if (idx >= 0) selectedStoreIds.splice(idx, 1);
    else selectedStoreIds.push(sid);
    optimizedRoute = null;
    if (mapInstance) mapInstance.closePopup();
    refreshMapMarkers();
    updateMapBottomBar();
  }

  function updateMapBottomBar() {
    const countEl = document.getElementById('map-sel-count');
    const btn = document.getElementById('btn-map-optimize');
    if (countEl) countEl.textContent = selectedStoreIds.length;
    if (btn) btn.disabled = selectedStoreIds.length < 1;
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
          <span class="stop-name">${renderStopIconHtml(s)}${esc(s.name)}</span>
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
            <span class="stop-name">${renderStopIconHtml(s)}${esc(s.name)}</span>
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
        <div class="current-name">${renderStopIconHtml(current)}${esc(current.name)}</div>
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
            <span class="stop-name">${renderStopIconHtml(s)}${esc(s.name)}</span>
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

  // ---------- CSVインポートモーダル ----------

  function showCsvImportModal(route) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-height:85vh;overflow-y:auto">
        <div class="modal-title">アマサーチCSV取り込み</div>
        <div class="form-group">
          <label class="form-label">CSVファイルを選択</label>
          <input type="file" accept=".csv" id="csv-file-input" class="form-input">
        </div>
        <div id="csv-preview" style="display:none">
          <div id="csv-match-summary" class="text-sm mb-8"></div>
          <div id="csv-items-list"></div>
          <div class="btn-group mt-12">
            <button class="btn btn-outline" style="flex:1" id="csv-cancel">キャンセル</button>
            <button class="btn btn-primary" style="flex:1" id="csv-save">保存</button>
          </div>
        </div>
        <button class="btn btn-outline btn-block mt-12" id="csv-close" style="display:block">閉じる</button>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#csv-close').addEventListener('click', () => overlay.remove());

    const fileInput = overlay.querySelector('#csv-file-input');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;

      try {
        const text = await readFileWithEncoding(file);
        const items = parseCsvItems(text);
        if (items.length === 0) {
          toast('商品が見つかりません');
          return;
        }

        // 店舗名のマッチング
        const matched = matchItemsToStores(items, route, stores);

        // プレビュー表示
        renderCsvPreview(overlay, matched, route);
      } catch (e) {
        toast('CSV読み込みエラー: ' + e.message);
      }
    });
  }

  // CSVファイルをShift-JIS/UTF-8で読み込み
  function readFileWithEncoding(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // まずShift-JISで読んでみる
        const decoder = new TextDecoder('shift_jis');
        const bytes = new Uint8Array(reader.result);
        const text = decoder.decode(bytes);
        // 文字化けチェック（アマサーチはShift-JISが多い）
        if (text.includes('ASIN') || text.includes('商品名')) {
          resolve(text);
        } else {
          // UTF-8で再読み込み
          const utf8 = new TextDecoder('utf-8').decode(bytes);
          resolve(utf8);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  // CSVパース（アマサーチ形式）
  function parseCsvItems(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 13) continue;

      const asin = cols[0].trim();
      const jan = cols[1].trim();
      const productName = cols[2].trim();
      const expectedSalePrice = parseNum(cols[3]);
      const purchasePrice = parseNum(cols[4]);
      const expectedProfit = parseNum(cols[5]);
      const quantity = parseNum(cols[8]) || 1;
      const condition = cols[9].trim();
      const supplierName = cols[12].trim();

      if (!asin && !jan) continue;

      items.push({
        asin, jan, productName, expectedSalePrice,
        purchasePrice, expectedProfit, quantity,
        condition, supplierName
      });
    }
    return items;
  }

  // CSV行パース（ダブルクォート対応）
  function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { result.push(current); current = ''; }
        else { current += ch; }
      }
    }
    result.push(current);
    return result;
  }

  function parseNum(s) {
    if (!s) return 0;
    return Number(String(s).replace(/[¥￥,、\s]/g, '')) || 0;
  }

  // CSV店舗名と巡回アプリ店舗のマッチング
  function matchItemsToStores(items, route, allStores) {
    // 巡回で訪問した店舗
    const visitedStores = (route.stops || [])
      .filter(s => s.status === 'visited')
      .map(s => {
        const storeObj = allStores.find(st => st.store_id === s.store_id);
        return { store_id: s.store_id, name: storeObj ? storeObj.name : '', category: storeObj ? storeObj.category : '' };
      });

    return items.map(item => {
      const matched = findMatchingStore(item.supplierName, visitedStores, allStores);
      return { ...item, matchedStore: matched };
    });
  }

  // あいまいマッチング
  function findMatchingStore(supplierName, visitedStores, allStores) {
    if (!supplierName) return null;
    const name = supplierName.trim();

    // チェーン名マッピング（CSV短縮名 → アプリの店名パターン）
    const chainMap = {
      'オートバックス': ['オートバックス', 'スーパーオートバックス'],
      'イエローハット': ['イエローハット'],
      'ケーズデンキ': ['ケーズデンキ'],
      'ヤマダ電機': ['ヤマダデンキ', 'LABI', 'Tecc LIFE'],
      'ヤマダデンキ': ['ヤマダデンキ', 'LABI', 'Tecc LIFE'],
      'ビックカメラ': ['コジマ×ビックカメラ', 'ビックカメラ'],
      'コジマ': ['コジマ×ビックカメラ', 'コジマ'],
      'エディオン': ['エディオン'],
      'ジョーシン': ['ジョーシン'],
      'ドンキホーテ': ['ドン・キホーテ', 'MEGAドン・キホーテ', 'キラキラドンキ'],
      'ドン・キホーテ': ['ドン・キホーテ', 'MEGAドン・キホーテ', 'キラキラドンキ'],
      'セカンドストリート': ['セカンドストリート', 'スーパーセカンドストリート'],
      'ブックオフ': ['BOOKOFF', 'ブックオフ'],
      'トレファク': ['トレファク'],
      'ビバホーム': ['ビバホーム', 'スーパービバホーム'],
      'DCM': ['DCM'],
      'カインズ': ['カインズ'],
      'コーナン': ['コーナン'],
      'ダイユーエイト': ['ダイユーエイト'],
      'サンデー': ['サンデー'],
      'コストコ': ['コストコ'],
      'イオン': ['イオン'],
      'ジェームス': ['ジェームス'],
    };

    // 1. 訪問店舗から探す（優先）
    for (const vs of visitedStores) {
      if (isStoreMatch(name, vs.name, chainMap)) return vs;
    }

    // 2. 全店舗から探す（訪問していない店でもCSVに入る場合）
    for (const s of allStores) {
      if (isStoreMatch(name, s.name, chainMap)) {
        return { store_id: s.store_id, name: s.name, category: s.category };
      }
    }

    return null;
  }

  function isStoreMatch(csvName, appStoreName, chainMap) {
    if (!csvName || !appStoreName) return false;

    // 完全一致
    if (appStoreName.includes(csvName)) return true;

    // チェーンマップで照合
    for (const [key, patterns] of Object.entries(chainMap)) {
      if (csvName.includes(key) || key.includes(csvName)) {
        if (patterns.some(p => appStoreName.includes(p))) return true;
      }
    }
    return false;
  }

  // CSVプレビューを描画
  function renderCsvPreview(overlay, matchedItems, route) {
    const preview = overlay.querySelector('#csv-preview');
    const closeBtn = overlay.querySelector('#csv-close');
    preview.style.display = 'block';
    closeBtn.style.display = 'none';

    const matched = matchedItems.filter(i => i.matchedStore);
    const unmatched = matchedItems.filter(i => !i.matchedStore);

    // サマリー
    const summaryEl = overlay.querySelector('#csv-match-summary');
    const totalProfit = matchedItems.reduce((s, i) => s + i.expectedProfit * i.quantity, 0);
    summaryEl.innerHTML = `
      <div class="card" style="background:var(--primary-light)">
        <b>${matchedItems.length}商品</b> / 見込み利益合計: <b>${totalProfit.toLocaleString()}円</b><br>
        <span style="color:var(--success)">自動マッチ: ${matched.length}件</span>
        ${unmatched.length > 0 ? `<span style="color:var(--accent);margin-left:8px">未マッチ: ${unmatched.length}件</span>` : ''}
      </div>`;

    // 商品リスト
    const listEl = overlay.querySelector('#csv-items-list');
    // 店舗ごとにグループ化
    const groups = {};
    matchedItems.forEach((item, idx) => {
      const key = item.matchedStore ? item.matchedStore.name : '未マッチ';
      if (!groups[key]) groups[key] = [];
      groups[key].push({ ...item, _idx: idx });
    });

    let html = '';
    // 訪問した店舗の一覧（プルダウン用）
    const visitedStores = (route.stops || [])
      .filter(s => s.status === 'visited')
      .map(s => {
        const st = stores.find(x => x.store_id === s.store_id);
        return { store_id: s.store_id, name: st ? st.name : s.store_id };
      });

    for (const [storeName, items] of Object.entries(groups)) {
      const groupProfit = items.reduce((s, i) => s + i.expectedProfit * i.quantity, 0);
      const isUnmatched = storeName === '未マッチ';
      html += `<div class="card mt-8">
        <div class="card-title" style="${isUnmatched ? 'color:var(--accent)' : ''}">${esc(storeName)}
          <span class="badge ${isUnmatched ? 'badge-accent' : 'badge-success'}">${items.length}点</span>
          <span class="text-sm" style="margin-left:8px">利益: ${groupProfit.toLocaleString()}円</span>
        </div>`;

      items.forEach(item => {
        html += `<div class="text-sm" style="padding:4px 0;border-bottom:1px solid var(--border)">
          <div class="flex-between">
            <span>${esc(item.productName.substring(0, 30))}${item.productName.length > 30 ? '...' : ''}</span>
            <span style="white-space:nowrap;margin-left:8px">${item.expectedProfit.toLocaleString()}円</span>
          </div>
          <div class="text-dim">仕入: ${item.purchasePrice.toLocaleString()}円 → 売予: ${item.expectedSalePrice.toLocaleString()}円 × ${item.quantity}個</div>
          ${isUnmatched ? `<div style="margin-top:4px">
            <select class="form-select" data-idx="${item._idx}" style="font-size:12px;padding:4px">
              <option value="">店舗を選択</option>
              ${visitedStores.map(s => `<option value="${s.store_id}">${esc(s.name)}</option>`).join('')}
            </select>
          </div>` : ''}
        </div>`;
      });
      html += '</div>';
    }
    listEl.innerHTML = html;

    // 未マッチ商品の手動選択イベント
    listEl.querySelectorAll('select[data-idx]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.dataset.idx);
        const storeId = sel.value;
        if (storeId) {
          const st = stores.find(s => s.store_id === storeId);
          matchedItems[idx].matchedStore = { store_id: storeId, name: st ? st.name : storeId };
        } else {
          matchedItems[idx].matchedStore = null;
        }
      });
    });

    // 保存ボタン
    overlay.querySelector('#csv-save').addEventListener('click', async () => {
      const toSave = matchedItems.filter(i => i.matchedStore);
      if (toSave.length === 0) {
        toast('保存する商品がありません');
        return;
      }

      const apiItems = toSave.map(item => ({
        date: route.date || today_(),
        store_id: item.matchedStore.store_id,
        route_id: route.route_id || '',
        asin: item.asin,
        jan: item.jan,
        product_name: item.productName,
        purchase_price: item.purchasePrice,
        expected_sale_price: item.expectedSalePrice,
        expected_profit: item.expectedProfit,
        quantity: item.quantity,
        condition: item.condition,
        supplier_name: item.supplierName,
      }));

      overlay.querySelector('#csv-save').textContent = '保存中...';
      overlay.querySelector('#csv-save').disabled = true;

      try {
        await API.addPurchaseItems({ items: apiItems });
        toast(`${toSave.length}商品を保存しました`);
        overlay.remove();
        Router.navigate('history-detail', { route });
      } catch (e) {
        toast('保存エラー: ' + e.message);
        overlay.querySelector('#csv-save').textContent = '保存';
        overlay.querySelector('#csv-save').disabled = false;
      }
    });

    overlay.querySelector('#csv-cancel').addEventListener('click', () => overlay.remove());
  }

  function today_() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
            ${renderStoreIconHtml(s)}
            <div class="store-info">
              <div class="store-name">${esc(s.name)}</div>
              <div class="store-meta">${renderStoreStatusPill(s)}${esc(s._areaName)} | ${esc(s.category)} | ${formatTime(s.open_time)}-${formatTime(s.close_time)}</div>
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
              <span>${i + 1}. ${renderStopIconHtml(s)}${esc(s.name)}</span>
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

  // ---------- 分析画面 ----------

  async function renderAnalytics(container) {
    setTitle('店舗分析');
    setNavActive('analytics');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const [purchaseItems, routes, purchases] = await Promise.all([
        API.getPurchaseItems({ limit: 10000 }),
        API.getRouteHistory({ limit: 100, include_stops: 'true' }),
        API.getPurchases({ limit: 10000 }),
      ]);

      if ((!purchaseItems || purchaseItems.length === 0) && (!purchases || purchases.length === 0)) {
        container.innerHTML = `
          <div class="text-center mt-12">
            <div class="text-dim">まだデータがありません</div>
            <div class="text-sm text-dim mt-8">巡回してCSVを取り込むとここに分析結果が表示されます</div>
          </div>`;
        return;
      }

      // 店舗ごとの集計
      const storeStats = buildStoreStats(purchaseItems, routes, purchases, stores);
      const sortedStats = Object.values(storeStats).sort((a, b) => b.totalExpectedProfit - a.totalExpectedProfit);

      let html = '';

      // 全体サマリー
      const totalProfit = sortedStats.reduce((s, st) => s + st.totalExpectedProfit, 0);
      const totalPurchase = sortedStats.reduce((s, st) => s + st.totalPurchaseAmount, 0);
      const totalVisits = sortedStats.reduce((s, st) => s + st.visitCount, 0);
      const totalItems = sortedStats.reduce((s, st) => s + st.itemCount, 0);

      html += `
        <div class="card">
          <div class="card-title">全体サマリー</div>
          <div class="summary-grid">
            <div class="summary-item"><div class="value">${totalProfit.toLocaleString()}円</div><div class="label">見込み利益合計</div></div>
            <div class="summary-item"><div class="value">${totalPurchase.toLocaleString()}円</div><div class="label">仕入れ合計</div></div>
            <div class="summary-item"><div class="value">${totalVisits}</div><div class="label">総訪問回数</div></div>
            <div class="summary-item"><div class="value">${totalItems}</div><div class="label">総仕入れ点数</div></div>
          </div>
        </div>`;

      // タブ切り替え
      html += `
        <div class="flex gap-8 mt-12 mb-8">
          <button class="btn btn-sm analytics-tab active" data-tab="ranking">利益ランキング</button>
          <button class="btn btn-sm btn-outline analytics-tab" data-tab="efficiency">効率分析</button>
          <button class="btn btn-sm btn-outline analytics-tab" data-tab="genre">ジャンル傾向</button>
        </div>
        <div id="analytics-content"></div>`;

      container.innerHTML = html;

      // タブイベント
      const tabs = container.querySelectorAll('.analytics-tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          tabs.forEach(t => { t.classList.remove('active'); t.classList.add('btn-outline'); });
          tab.classList.add('active');
          tab.classList.remove('btn-outline');
          renderAnalyticsTab(container.querySelector('#analytics-content'), tab.dataset.tab, sortedStats);
        });
      });

      // 初期表示
      renderAnalyticsTab(container.querySelector('#analytics-content'), 'ranking', sortedStats);

    } catch (e) {
      container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
    }
  }

  function buildStoreStats(purchaseItems, routes, purchases, allStores) {
    const stats = {};

    function ensureStore(storeId) {
      if (!stats[storeId]) {
        const s = allStores.find(x => x.store_id === storeId);
        stats[storeId] = {
          store_id: storeId,
          name: s ? s.name : storeId,
          category: s ? s.category : '',
          totalExpectedProfit: 0,
          totalPurchaseAmount: 0,
          itemCount: 0,
          visitCount: 0,
          totalStayMin: 0,
          items: [],
          genres: {},
        };
      }
      return stats[storeId];
    }

    // CSV取り込みデータから集計
    (purchaseItems || []).forEach(pi => {
      // store_idがあればそれを使い、なければsupplier_nameで集計
      let key = pi.store_id;
      if (!key && pi.supplier_name) {
        key = 'supplier:' + pi.supplier_name;
        if (!stats[key]) {
          stats[key] = {
            store_id: key,
            name: pi.supplier_name,
            category: '',
            totalExpectedProfit: 0,
            totalPurchaseAmount: 0,
            itemCount: 0,
            visitCount: 0,
            totalStayMin: 0,
            items: [],
            genres: {},
          };
        }
      }
      if (!key) return;
      const st = key.startsWith('supplier:') ? stats[key] : ensureStore(key);
      const profit = Number(pi.expected_profit) || 0;
      const price = Number(pi.purchase_price) || 0;
      const qty = Number(pi.quantity) || 1;
      st.totalExpectedProfit += profit * qty;
      st.totalPurchaseAmount += price * qty;
      st.itemCount += qty;
      st.items.push(pi);

      // ジャンル集計（カテゴリから推定）
      const genre = guessGenre(pi.product_name);
      st.genres[genre] = (st.genres[genre] || 0) + profit * qty;
    });

    // 巡回データから訪問回数・滞在時間を集計
    (routes || []).forEach(r => {
      (r.stops || []).forEach(stop => {
        if (stop.status !== 'visited') return;
        const st = ensureStore(stop.store_id);
        st.visitCount++;
        if (stop.arrival_time && stop.departure_time) {
          const stay = (new Date(stop.departure_time) - new Date(stop.arrival_time)) / 60000;
          if (stay > 0 && stay < 480) st.totalStayMin += stay;
        }
      });
    });

    // purchasesデータからも仕入れ額を補完（CSV未取り込み分）
    (purchases || []).forEach(p => {
      if (!p.store_id) return;
      const st = ensureStore(p.store_id);
      // CSV取り込みデータがなければpurchasesの金額を使う
      if (st.items.length === 0) {
        st.totalPurchaseAmount += Number(p.amount) || 0;
      }
    });

    return stats;
  }

  function guessGenre(productName) {
    if (!productName) return 'その他';
    const name = productName.toLowerCase();
    if (/カーメイト|エンジンスターター|タイヤ|オイル|ワイパー|カー/.test(name)) return 'カー用品';
    if (/テレビ|pc|パソコン|プリンタ|buffalo|エレコム|wifi|lan/.test(name)) return '家電・PC';
    if (/洗剤|シャンプー|歯ブラシ|トイレ|キッチン/.test(name)) return '日用品';
    if (/コールマン|テント|キャンプ|アウトドア|エバニュー|チタン/.test(name)) return 'アウトドア';
    if (/ボッシュ|マキタ|京セラ|リョービ|ドリル|ノコ|インパクト/.test(name)) return '工具・DIY';
    if (/おもちゃ|レゴ|プラレール|ゲーム/.test(name)) return 'おもちゃ・ゲーム';
    return 'その他';
  }

  function renderAnalyticsTab(container, tab, sortedStats) {
    if (tab === 'ranking') renderRankingTab(container, sortedStats);
    else if (tab === 'efficiency') renderEfficiencyTab(container, sortedStats);
    else if (tab === 'genre') renderGenreTab(container, sortedStats);
  }

  // 利益ランキングタブ
  function renderRankingTab(container, sortedStats) {
    if (sortedStats.length === 0) {
      container.innerHTML = '<div class="text-center text-dim mt-12">データがありません</div>';
      return;
    }

    let html = '';
    sortedStats.forEach((st, i) => {
      const profitPerVisit = st.visitCount > 0 ? Math.round(st.totalExpectedProfit / st.visitCount) : 0;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const barWidth = sortedStats[0].totalExpectedProfit > 0
        ? Math.max(5, Math.round(st.totalExpectedProfit / sortedStats[0].totalExpectedProfit * 100))
        : 0;
      const profitColor = st.totalExpectedProfit >= 0 ? 'var(--success)' : 'var(--accent)';

      html += `
        <div class="card mt-8">
          <div class="flex-between">
            <span><b>${medal} ${esc(st.name)}</b></span>
            <span style="color:${profitColor};font-weight:bold">${st.totalExpectedProfit.toLocaleString()}円</span>
          </div>
          <div style="background:var(--border);border-radius:4px;height:6px;margin:6px 0">
            <div style="background:${profitColor};border-radius:4px;height:6px;width:${barWidth}%"></div>
          </div>
          <div class="text-sm text-dim">
            仕入れ ${st.totalPurchaseAmount.toLocaleString()}円 / ${st.itemCount}点 / ${st.visitCount}回訪問
            ${profitPerVisit > 0 ? `/ 1回あたり ${profitPerVisit.toLocaleString()}円` : ''}
          </div>
        </div>`;
    });
    container.innerHTML = html;
  }

  // 効率分析タブ
  function renderEfficiencyTab(container, sortedStats) {
    const withVisits = sortedStats.filter(st => st.visitCount > 0);

    if (withVisits.length === 0) {
      container.innerHTML = '<div class="text-center text-dim mt-12">訪問データがありません</div>';
      return;
    }

    // 訪問あたり利益でソート
    const byProfitPerVisit = [...withVisits].sort((a, b) => {
      const aVal = a.totalExpectedProfit / a.visitCount;
      const bVal = b.totalExpectedProfit / b.visitCount;
      return bVal - aVal;
    });

    // 時間あたり利益でソート
    const withTime = withVisits.filter(st => st.totalStayMin > 0);
    const byProfitPerHour = [...withTime].sort((a, b) => {
      const aVal = a.totalExpectedProfit / (a.totalStayMin / 60);
      const bVal = b.totalExpectedProfit / (b.totalStayMin / 60);
      return bVal - aVal;
    });

    let html = '<div class="card-title">訪問あたり利益（高い順）</div>';
    byProfitPerVisit.slice(0, 10).forEach((st, i) => {
      const ppv = Math.round(st.totalExpectedProfit / st.visitCount);
      html += `
        <div class="card mt-8">
          <div class="flex-between">
            <span>${i + 1}. <b>${esc(st.name)}</b></span>
            <span style="font-weight:bold">${ppv.toLocaleString()}円/回</span>
          </div>
          <div class="text-sm text-dim">${st.visitCount}回訪問 / 合計 ${st.totalExpectedProfit.toLocaleString()}円</div>
        </div>`;
    });

    if (byProfitPerHour.length > 0) {
      html += '<div class="card-title mt-12">時間あたり利益（高い順）</div>';
      byProfitPerHour.slice(0, 10).forEach((st, i) => {
        const pph = Math.round(st.totalExpectedProfit / (st.totalStayMin / 60));
        const avgStay = Math.round(st.totalStayMin / st.visitCount);
        html += `
          <div class="card mt-8">
            <div class="flex-between">
              <span>${i + 1}. <b>${esc(st.name)}</b></span>
              <span style="font-weight:bold">${pph.toLocaleString()}円/時</span>
            </div>
            <div class="text-sm text-dim">平均滞在 ${avgStay}分 / ${st.visitCount}回訪問</div>
          </div>`;
      });
    }

    container.innerHTML = html;
  }

  // ジャンル傾向タブ
  function renderGenreTab(container, sortedStats) {
    // 店舗ごとの得意ジャンルを表示
    const storesWithGenres = sortedStats.filter(st => Object.keys(st.genres).length > 0);

    if (storesWithGenres.length === 0) {
      container.innerHTML = '<div class="text-center text-dim mt-12">CSV取り込みデータがありません</div>';
      return;
    }

    // 全体のジャンル集計
    const totalGenres = {};
    storesWithGenres.forEach(st => {
      for (const [genre, profit] of Object.entries(st.genres)) {
        totalGenres[genre] = (totalGenres[genre] || 0) + profit;
      }
    });
    const sortedGenres = Object.entries(totalGenres).sort((a, b) => b[1] - a[1]);

    let html = '<div class="card-title">ジャンル別 見込み利益</div>';
    const maxGenreProfit = sortedGenres.length > 0 ? sortedGenres[0][1] : 1;
    sortedGenres.forEach(([genre, profit]) => {
      const barWidth = Math.max(5, Math.round(profit / maxGenreProfit * 100));
      html += `
        <div class="card mt-8">
          <div class="flex-between">
            <span><b>${esc(genre)}</b></span>
            <span style="font-weight:bold">${profit.toLocaleString()}円</span>
          </div>
          <div style="background:var(--border);border-radius:4px;height:6px;margin:4px 0">
            <div style="background:var(--primary);border-radius:4px;height:6px;width:${barWidth}%"></div>
          </div>
        </div>`;
    });

    html += '<div class="card-title mt-12">店舗別の得意ジャンル</div>';
    storesWithGenres.forEach(st => {
      const topGenre = Object.entries(st.genres).sort((a, b) => b[1] - a[1]);
      if (topGenre.length === 0) return;
      html += `
        <div class="card mt-8">
          <div><b>${esc(st.name)}</b></div>
          <div class="text-sm mt-4">
            ${topGenre.slice(0, 3).map(([g, p]) =>
              `<span class="badge" style="margin-right:4px">${esc(g)} ${p.toLocaleString()}円</span>`
            ).join('')}
          </div>
        </div>`;
    });

    container.innerHTML = html;
  }

  function setNavActive(view) {
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
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

    // CSV取り込みボタン
    html += `<button class="btn btn-primary btn-block mt-12" id="btn-import-csv">アマサーチCSV取り込み</button>`;

    // 店舗を追加ボタン
    html += `<button class="btn btn-outline btn-block mt-12" id="btn-add-stop-history" style="border-style:dashed;color:var(--primary)">+ 店舗を追加</button>`;

    // 戻るボタン
    html += `<button class="btn btn-outline btn-block mt-12" id="btn-back-history">履歴一覧に戻る</button>`;

    // 個別消去ボタン
    html += `<button class="btn btn-accent btn-block mt-12" id="btn-delete-route">この履歴を消去</button>`;

    container.innerHTML = html;

    document.getElementById('btn-import-csv')?.addEventListener('click', () => {
      showCsvImportModal(route);
    });

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
            ${renderStoreIconHtml(s)}
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

  return { init, loadData, toggleMapSelection };
})();
