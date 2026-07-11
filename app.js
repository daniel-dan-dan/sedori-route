// ============================================================
// 店舗巡回ルート最適化 — メインアプリ
// ============================================================

const App = (() => {
  let stores = [];
  let config = {};
  let selectedStoreIds = []; // 選択順を保持する配列
  let optimizedRoute = null;
  let patrolState = null; // { routeId, stops, currentIdx }
  let plannedRoute = null; // 予定として保存されたルート（startTime 未打刻）
  let patrolTimerInterval = null;
  let patrolEnding = false;
  let mapInstance = null;
  let mapCluster = null;
  let mapMarkers = new Map(); // store_id → L.marker（差分更新用）
  let mapChainFilter = 'all';
  let mapBoundsFilter = false;
  let mapVisitInfoByStoreId = new Map();
  let mapVisitInfoLoaded = false;
  let mapVisitInfoLoading = null;
  let mapVisitInfoFetchedAt = 0;
  let currentLocationMarker = null; // 現在地マーカー
  let currentLocationCircle = null; // 現在地精度サークル
  const HIDDEN_STORE_IDS = new Set([
    's20260411082838460',
    // DCM 利府店は店舗マスタに同名・同座標で5件入っているため、先頭1件だけ表示する
    's20260427202126440',
    's20260427202154941',
    's20260427202226440',
    's20260427205454995',
  ]);
  const RECOMMENDATION_CACHE_ID = 'recommendations-v2';
  const MAP_VISIT_INFO_CACHE_ID = 'mapVisitInfo';
  const RECOMMENDATION_FROM_DATE = '2026-04-21';
  const RECOMMENDATION_TOP_STORE_LIMIT = 5;
  const RECOMMENDATION_AREA_COOLDOWN_DAYS = 14;
  const RECOMMENDATION_AREA_TARGET_DAYS = 45;
  const RECOMMENDATION_TIMEOUT_MS = 12000;
  const RECOMMENDATION_INVENTORY_LIMIT = 1000;
  const MAP_VISIT_INFO_TTL_MS = 60 * 60 * 1000;

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
    'オーディン': '#3A0A0C',
    'おたちゅう': '#F97316',
    'ドンキホーテ': '#FFCC00',
    'カインズ': '#2E7D32',
    'DCM': '#FF7F00',
    'ダイユーエイト': '#2A6EB5',
    'サンデー': '#1E67B3',
    'コメリ': '#E60012',
    'コーナン': '#1E67B3',
    'ビバホーム': '#DE611C',
    'ダイシン': '#E60012',
    'オートバックス': '#FFB300',
    'イエローハット': '#FFC107',
    'ジェームス': '#1E67B3',
    '2りんかん': '#D6001C',
    'イオン': '#B60081',
    'トイザらス': '#E60012',
    'オフィスベンダー': '#6B7280',
    'TSUTAYA': '#1D3480',
  };

  function getChainColor(store) {
    const chain = getChain(store);
    return CHAIN_COLORS[chain] || '#6B7280';
  }

  const ASSET_VER = 'v100';
  function withVer(url) { return url ? `${url}?${ASSET_VER}` : url; }

  function renderStoreIconHtml(store) {
    const chain = getChain(store);
    const logo = CHAIN_LOGOS[chain];
    if (logo) {
      const color = CHAIN_COLORS[chain] || '#6B7280';
      return `<span class="store-icon store-icon-logo" style="border-color:${color}"><img src="${withVer(logo)}" alt=""></span>`;
    }
    return `<span class="store-icon">${store.icon || '&#x1f3ea;'}</span>`;
  }

  // 営業状態判定 → { label, cls }
  function getBusinessStatus(store) {
    const open = formatTime(store.open_time);
    const close = formatTime(store.close_time);
    if (!open || !close) return null;
    const parseHM = (s) => {
      if (!s) return null;
      const mj = /^翌\s*(\d{1,2}):(\d{2})/.exec(s);
      if (mj) return Number(mj[1]) * 60 + Number(mj[2]) + 24 * 60;
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
      return `<span class="stop-icon-logo" style="border-color:${color}"><img src="${withVer(logo)}" alt=""></span>`;
    }
    return `<span class="stop-icon-emoji">${store.icon || '&#x1f3ea;'}</span>`;
  }

  // チェーン別ロゴ（公式サイト/Wikimedia Commons/ユーザー提供画像由来）
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
    'オーディン': 'icons/chains/odin.png',
    'ドンキホーテ': 'icons/chains/donki.png',
    'カインズ': 'icons/chains/cainz.png',
    'DCM': 'icons/chains/dcm.png',
    'ダイユーエイト': 'icons/chains/daiyu8.png',
    'サンデー': 'icons/chains/sunday.png',
    'コメリ': 'icons/chains/komeri.png',
    'コーナン': 'icons/chains/kohnan.png',
    'ビバホーム': 'icons/chains/vivahome.png',
    'ダイシン': 'icons/chains/daishin.png',
    'オートバックス': 'icons/chains/autobacs.png',
    'イエローハット': 'icons/chains/yhat.png',
    'ジェームス': 'icons/chains/james.png',
    'イオン': 'icons/chains/aeon.png',
    'トイザらス': 'icons/chains/toysrus.png',
    'オフィスベンダー': 'icons/chains/ofv.png',
    'TSUTAYA': 'icons/chains/tsutaya.png',
  };

  const CHAIN_ABBR = {};

  // ---------- エリア定義（座標ベース自動分類） ----------

  const AREAS = [
    // 分類判定用。広域エリアを先に判定してから、仙台市内を代表地名1つで細分化する。
    { id: 'yamagata',    name: '山形',   group: '山形方面', test: s => Number(s.lng) < 140.50 },
    { id: 'ishinomaki',  name: '石巻',   group: '沿岸北',   test: s => Number(s.lng) >= 141.10 },
    { id: 'furukawa',    name: '大崎',   group: '県北',     test: s => Number(s.lat) >= 38.50 },
    { id: 'shiroishi',   name: '白石',   group: '県南',     test: s => Number(s.lat) < 38.03 },
    { id: 'ogawara',     name: '大河原', group: '県南',     test: s => Number(s.lat) < 38.10 },
    { id: 'iwanuma',     name: '岩沼',   group: '県南',     test: s => Number(s.lat) < 38.16 },
    { id: 'natori',      name: '名取',   group: '仙台南',   test: s => Number(s.lat) < 38.20 },
    { id: 'tagajo',      name: '多賀城', group: '沿岸',     test: s => Number(s.lat) >= 38.285 && Number(s.lng) >= 140.99 },
    { id: 'rifu',        name: '利府',   group: '沿岸',     test: s => Number(s.lat) >= 38.30 && Number(s.lng) >= 140.94 },
    { id: 'tomiya',      name: '富谷',   group: '仙台北',   test: s => Number(s.lat) >= 38.35 },
    { id: 'izumichuo',   name: '泉中央', group: '仙台北',   test: s => Number(s.lat) >= 38.30 && Number(s.lng) >= 140.86 },
    { id: 'sendai_port', name: '仙台港', group: '仙台東',   test: s => Number(s.lng) >= 140.99 && Number(s.lat) >= 38.24 },
    { id: 'ayashi',      name: '愛子',   group: '仙台西',   test: s => Number(s.lng) < 140.75 },
    { id: 'nakayama',    name: '中山',   group: '仙台西',   test: s => Number(s.lat) >= 38.27 && Number(s.lng) < 140.86 },
    { id: 'arai',        name: '荒井',   group: '仙台東',   test: s => Number(s.lng) >= 140.92 && Number(s.lat) < 38.255 },
    { id: 'nigatake',    name: '苦竹',   group: '仙台東',   test: s => Number(s.lng) >= 140.90 && Number(s.lat) >= 38.24 },
    { id: 'sendai_sta',  name: '仙台駅', group: '仙台中心', test: s => Number(s.lat) >= 38.245 },
    { id: 'tomizawa',    name: '富沢',   group: '仙台南',   test: s => Number(s.lat) < 38.225 },
    { id: 'nagamachi',   name: '長町',   group: '仙台南',   test: s => Number(s.lat) < 38.245 },
    { id: 'other',       name: 'その他', group: 'その他',   test: () => true },
  ];

  // UI表示順（履歴やエリア別タブで見やすい巡回方面順）
  const AREA_DISPLAY_ORDER = [
    'sendai_sta', 'nakayama', 'ayashi',
    'izumichuo', 'tomiya',
    'nigatake', 'sendai_port', 'arai',
    'nagamachi', 'tomizawa', 'natori',
    'iwanuma', 'ogawara', 'shiroishi',
    'rifu', 'tagajo',
    'furukawa', 'ishinomaki', 'yamagata',
    'other',
  ];

  function getArea(store) {
    for (const a of AREAS) {
      if (a.test(store)) return a.id;
    }
    return 'other';
  }

  // ---------- ジャンル・チェーン定義 ----------

  const GENRE_DISPLAY = {
    '家電量販': '家電量販店',
    'HC': 'ホームセンター',
    'ドンキ': 'ドンキホーテ',
    'リサイクル': 'リサイクルショップ',
    '書店': '書店',
    'カー用品': 'カー用品店',
    'その他': 'その他'
  };

  const CHAIN_RULES = [
    // リサイクル系（長い名前を先に判定）
    { re: /BOOKOFF|ブックオフ/i, chain: 'ブックオフ' },
    { re: /スーパーセカンドストリート|セカンドストリート|セカスト/, chain: 'セカンドストリート' },
    { re: /トレファクスタイル|トレファクファッション|トレジャーファクトリー|トレファク/, chain: 'トレファク' },
    { re: /オフハウス/, chain: 'オフハウス' },
    { re: /ハードオフ/, chain: 'ハードオフ' },
    { re: /オーディン|Odin/i, chain: 'オーディン' },
    { re: /おたちゅう|お宝中古市場/, chain: 'おたちゅう' },
    // 家電量販
    { re: /ヤマダデンキ|ヤマダ電機|LABI|YAMADA/i, chain: 'ヤマダデンキ' },
    { re: /ケーズデンキ/, chain: 'ケーズデンキ' },
    { re: /コジマ|ビックカメラ/, chain: 'コジマ×ビックカメラ' },
    { re: /エディオン/, chain: 'エディオン' },
    { re: /ノジマ/, chain: 'ノジマ' },
    { re: /ジョーシン/, chain: 'ジョーシン' },
    // ドンキ系
    { re: /ドン・キホーテ|ドンキホーテ|ドンキ|MEGAドンキ|キラキラドンキ/, chain: 'ドンキホーテ' },
    // HC系
    { re: /カインズ/, chain: 'カインズ' },
    { re: /DCM/, chain: 'DCM' },
    { re: /ダイユーエイト/, chain: 'ダイユーエイト' },
    { re: /サンデー/, chain: 'サンデー' },
    { re: /コメリ/, chain: 'コメリ' },
    { re: /コーナン/, chain: 'コーナン' },
    { re: /スーパービバホーム|ビバホーム/, chain: 'ビバホーム' },
    { re: /ダイシン/, chain: 'ダイシン' },
    // カー用品
    { re: /オートバックス/, chain: 'オートバックス' },
    { re: /イエローハット/, chain: 'イエローハット' },
    { re: /ジェームス/, chain: 'ジェームス' },
    { re: /[２2]りんかん|にりんかん/i, chain: '2りんかん' },
    // その他
    { re: /イオン/, chain: 'イオン' },
    { re: /トイザらス/, chain: 'トイザらス' },
    { re: /オフィスベンダー/, chain: 'オフィスベンダー' },
    { re: /TSUTAYA|蔦屋書店|ツタヤ/i, chain: 'TSUTAYA' },
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

  function normalizeStores(list) {
    return (list || []).filter(s =>
      s &&
      s.name &&
      String(s.name).trim() &&
      !HIDDEN_STORE_IDS.has(String(s.store_id || ''))
    );
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

    if (!API.hasToken()) {
      stores = normalizeStores(await Storage.getCachedStores());
      config = await Storage.getCachedConfig();
      Router.navigate('settings');
      toast('端末接続コードを設定してください', 5000);
      return;
    }

    // GASウォームアップ & データ更新を最速で並行スタート（await しない）
    // IDB読み込みと並行してGASが起動するためコールドスタートを実質ゼロにする
    const loadDataPromise = loadData();

    // 巡回中データ・予定ルートをIDBから復元
    const saved = await Storage.getCurrentRoute();
    if (saved && saved.routeId) {
      patrolState = saved;
    }
    try {
      const planned = await Storage.getPlannedRoute();
      if (planned && planned.orderedStores && planned.orderedStores.length) {
        plannedRoute = planned;
      }
    } catch (e) { /* ignore */ }

    // IDBキャッシュから即ロード（ローカル読み込みなので高速）
    const cachedStores = await Storage.getCachedStores();
    stores = normalizeStores(cachedStores);
    config = await Storage.getCachedConfig();

    if (stores.length > 0) {
      // 2回目以降：キャッシュで即ナビゲート（体感0秒）
      Router.navigate(patrolState ? 'patrol' : 'home');
      // バックグラウンドでstores/configを最新に更新
      loadDataPromise.catch(e => console.warn('background refresh failed:', e));
    } else {
      // 初回起動のみAPIを待つ（キャッシュがない場合）
      await loadDataPromise;
      Router.navigate(patrolState ? 'patrol' : 'home');
    }

    // GASコールドスタート防止: 15分おきにpingを送ってウォームアップ維持
    setInterval(() => {
      API.ping().catch(() => {});
    }, 15 * 60 * 1000);
  }

  async function loadData() {
    try {
      [stores, config] = await Promise.all([API.getStores(), API.getConfig()]);
      stores = normalizeStores(stores);
      await Storage.cacheStores(stores);
      await Storage.cacheConfig(config);
    } catch (e) {
      console.warn('API fetch failed, using cache:', e);
      stores = await Storage.getCachedStores();
      stores = normalizeStores(stores);
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
    Router.register('haiban', renderHaiban);
    Router.register('quiz', (container) => {
      if (typeof Quiz !== 'undefined' && Quiz.renderQuiz) {
        Quiz.renderQuiz(container);
      } else {
        container.innerHTML = '<div class="card"><div class="card-title">クイズ機能を読み込めませんでした</div></div>';
      }
    });
    Router.register('patrol', renderPatrol);
    Router.register('summary', renderSummary);
  }

  // ---------- 廃盤タブ ----------
  // 廃盤チェッカーWebApp（独立GAS）から高ホット商品を取得し表示する。
  const HAIBAN_API_URL = 'https://script.google.com/macros/s/AKfycbwhJtRnWe_BBJmEfHv5sNzDyQq3HtxjgRhA6az_ieNplKyKRzsOh0x_32_F6kpIi0q4/exec';
  let haibanCache = null; // { items, updatedAt, fetchedAt }
  const HAIBAN_CACHE_TTL_MS = 30 * 60 * 1000;

  async function fetchHaibanAllHotItems() {
    const res = await fetch(HAIBAN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'getAllHotItems' }),
      redirect: 'follow',
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('廃盤APIレスポンス不正'); }
    if (parsed && parsed.ok === false) throw new Error(parsed.error || 'API error');
    // getAllHotItems は { updatedAt, count, items } を返す
    return parsed;
  }

  function haibanScoreRank(preScore, purScore) {
    const preMap = { 'A': 4, 'B': 3, 'C': 2, 'D': 1 };
    const purMap = { 'S': 5, 'A': 4, 'B': 3, 'C': 2 };
    return (purMap[purScore] || 0) * 5 + (preMap[preScore] || 0) * 4;
  }

  async function renderHaiban(container) {
    setTitle('廃盤リスト');

    const now = Date.now();

    // セッションキャッシュがTTL内 → 即表示して終わり
    if (haibanCache && (now - haibanCache.fetchedAt) < HAIBAN_CACHE_TTL_MS) {
      renderHaibanContent_(container, haibanCache);
      return;
    }

    // IDBキャッシュがあれば即表示（スピナーなし）
    let dbCache = null;
    try { dbCache = await Storage.getViewCache('haiban'); } catch (e) {}

    if (dbCache && dbCache.data) {
      haibanCache = { ...dbCache.data, fetchedAt: dbCache.savedAt || 0 };
      renderHaibanContent_(container, haibanCache);
    } else {
      container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    // バックグラウンドで最新データ取得・IDB更新
    try {
      const resp = await fetchHaibanAllHotItems();
      const data = {
        items: Array.isArray(resp.items) ? resp.items : [],
        updatedAt: resp.updatedAt || '',
        totalMatched: resp.totalMatched || 0,
        fetchedAt: Date.now(),
      };
      haibanCache = data;
      Storage.saveViewCache('haiban', { items: data.items, updatedAt: data.updatedAt, totalMatched: data.totalMatched }).catch(() => {});
      renderHaibanContent_(container, data);
    } catch (e) {
      if (Router.getCurrentView() !== 'haiban') return;
      if (!haibanCache) {
        container.innerHTML = `
          <div class="card">
            <div class="card-title">廃盤リスト取得失敗</div>
            <div class="text-dim text-sm mb-8">${esc(e.message)}</div>
            <button class="btn btn-outline btn-sm" id="btn-haiban-retry">再読み込み</button>
          </div>`;
        document.getElementById('btn-haiban-retry')?.addEventListener('click', () => {
          haibanCache = null;
          Storage.clearViewCache('haiban').catch(() => {});
          renderHaiban(container);
        });
      }
    }
  }

  function renderHaibanContent_(container, data) {
    if (Router.getCurrentView() !== 'haiban') return;

    updateHaibanNavBadge(data.items.length);

    // 廃盤タブUI
    const html = `
      <div class="haiban-toolbar">
        <input type="text" class="form-input" id="haiban-search" placeholder="ブランド・商品名で検索" autocomplete="off">
        <select class="form-input" id="haiban-sort">
          <option value="score">総合ランク順</option>
          <option value="pre">プレ値スコア順</option>
          <option value="purchase">仕入れスコア順</option>
          <option value="price-asc">最安値が安い順</option>
          <option value="price-desc">最安値が高い順</option>
        </select>
      </div>
      <div class="haiban-updated" id="haiban-updated"></div>
      <div id="haiban-list"></div>`;

    container.innerHTML = html;

    const updEl = document.getElementById('haiban-updated');
    updEl.textContent = `最終更新: ${data.updatedAt || '-'}（表示${data.items.length}件／該当${data.totalMatched}件）`;

    const searchEl = document.getElementById('haiban-search');
    const sortEl = document.getElementById('haiban-sort');
    const listEl = document.getElementById('haiban-list');

    function render() {
      const q = String(searchEl.value || '').trim().toLowerCase();
      const sortKey = sortEl.value;
      let items = data.items.slice();
      if (q) {
        items = items.filter(it =>
          String(it.ブランド名 || '').toLowerCase().includes(q) ||
          String(it.商品名 || '').toLowerCase().includes(q)
        );
      }
      items.sort((a, b) => {
        if (sortKey === 'pre') {
          return haibanScoreRank(b.プレ値スコア, 'C') - haibanScoreRank(a.プレ値スコア, 'C');
        }
        if (sortKey === 'purchase') {
          return haibanScoreRank('D', b.仕入れスコア) - haibanScoreRank('D', a.仕入れスコア);
        }
        if (sortKey === 'price-asc') return (a.最安値 || 0) - (b.最安値 || 0);
        if (sortKey === 'price-desc') return (b.最安値 || 0) - (a.最安値 || 0);
        return haibanScoreRank(b.プレ値スコア, b.仕入れスコア) - haibanScoreRank(a.プレ値スコア, a.仕入れスコア);
      });
      if (items.length === 0) {
        listEl.innerHTML = `<div class="haiban-empty">該当する商品がありません</div>`;
        return;
      }
      listEl.innerHTML = items.map(it => {
        const pre = String(it.プレ値スコア || '').trim();
        const pur = String(it.仕入れスコア || '').trim();
        const price = it.最安値 ? `¥${Number(it.最安値).toLocaleString()}` : '価格未取得';
        const profit = it.月間期待利益 ? `月間利益 ¥${Number(it.月間期待利益).toLocaleString()}` : '';
        const amazonUrl = it.AmazonURL || '';
        const keepaUrl = it.KeepaURL || '';
        const asin = String(it.ASIN || '').trim();
        const imageFile = String(it.画像ファイル || '').trim();
        // 画像: Keepa提供のimagesCSVファイル名があれば正確なURLを優先、無ければASINベースにフォールバック
        const imgSrc = imageFile
          ? `https://m.media-amazon.com/images/I/${esc(imageFile)}`
          : asin
          ? `https://images-na.ssl-images-amazon.com/images/P/${esc(asin)}.09._SL200_.jpg`
          : '';
        const imgHtml = imgSrc
          ? `<div class="haiban-thumb-wrap"><img class="haiban-thumb" src="${imgSrc}" alt="" loading="lazy" onerror="this.closest('.haiban-thumb-wrap').style.display='none'"></div>`
          : '';
        // Keepa 180日(6ヶ月)価格推移グラフ
        const graphHtml = asin
          ? `<img class="haiban-keepa-graph" src="https://graph.keepa.com/pricehistory.png?asin=${esc(asin)}&domain=co.jp&range=180&width=320&height=120&salesrank=1&used=1&new=1&amazon=1" alt="Keepa価格推移" loading="lazy" onerror="this.style.display='none'">`
          : '';
        return `
          <div class="haiban-item">
            <div class="haiban-badges">
              ${pre ? `<span class="score-badge pre-${pre}">プレ値 ${pre}</span>` : ''}
              ${pur ? `<span class="score-badge pur-${pur}">仕入 ${pur}</span>` : ''}
            </div>
            <div class="haiban-head">
              ${imgHtml}
              <div class="haiban-text">
                <div class="brand">${esc(it.ブランド名 || '')}</div>
                <div class="title">${esc(it.商品名 || '')}</div>
                <div class="meta">${price}${profit ? ' ・ ' + profit : ''}</div>
              </div>
            </div>
            ${graphHtml}
            <div class="links">
              ${amazonUrl ? `<a class="amazon" href="${esc(amazonUrl)}" target="_blank" rel="noopener">Amazonで見る</a>` : ''}
              ${keepaUrl ? `<a class="keepa" href="${esc(keepaUrl)}" target="_blank" rel="noopener">Keepaで見る</a>` : ''}
            </div>
          </div>`;
      }).join('');
    }

    searchEl.addEventListener('input', render);
    sortEl.addEventListener('change', render);
    render();
  }

  // 廃盤タブ横の新着件数バッジ更新
  function updateHaibanNavBadge(count) {
    const el = document.getElementById('haiban-nav-badge');
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
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

  // ---------- 予定ルートバナー（ホーム共通） ----------

  function buildPlannedRouteBanner() {
    if (!plannedRoute || !plannedRoute.orderedStores || !plannedRoute.orderedStores.length) return '';
    const pr = plannedRoute;
    const savedStr = pr.savedAt ? new Date(pr.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    let html = `
      <div class="route-result planned-route-card">
        <div class="card-title">予定ルート${savedStr ? `<span class="text-dim text-sm" style="font-weight:normal;margin-left:8px;">(${esc(savedStr)} 保存)</span>` : ''}</div>
        <div class="route-stats">
          <div class="route-stat"><div class="value">${pr.totalDistanceKm}</div><div class="label">km</div></div>
          <div class="route-stat"><div class="value">${pr.orderedStores.length}</div><div class="label">店舗</div></div>
        </div>`;
    pr.orderedStores.forEach((s, i) => {
      html += `
        <div class="route-stop">
          <div class="stop-num">${i + 1}</div>
          <span class="stop-name">${renderStopIconHtml(s)}${esc(s.name)}</span>
          <span class="stop-stay">${s.avg_stay_min || 30}分</span>
        </div>`;
    });
    html += `
        <div class="btn-group mt-8">
          <button class="btn btn-outline btn-compact" id="btn-planned-delete">削除</button>
          <button class="btn btn-success" id="btn-planned-start">この予定で巡回開始</button>
        </div>
      </div>`;
    return html;
  }

  function wirePlannedRouteHandlers() {
    document.getElementById('btn-planned-start')?.addEventListener('click', () => {
      if (!plannedRoute) return;
      optimizedRoute = plannedRoute;
      plannedRoute = null;
      Storage.clearPlannedRoute().catch(() => {});
      startPatrol();
    });
    document.getElementById('btn-planned-delete')?.addEventListener('click', async () => {
      if (!confirm('保存した予定ルートを削除しますか？')) return;
      plannedRoute = null;
      try { await Storage.clearPlannedRoute(); } catch (e) {}
      Router.navigate('home');
    });
  }

  // ---------- 巡回中バナー（ホーム共通） ----------

  function buildPatrolBanner() {
    if (!patrolState || !patrolState.stops || !patrolState.stops.length) return '';
    const { stops, currentIdx } = patrolState;
    const current = stops[currentIdx];
    const total = stops.length;
    const visited = stops.filter(s => s.status === 'visited').length;
    const currentName = current ? current.name : '';
    return `
      <div class="card patrol-banner" id="patrol-banner">
        <div class="flex-between mb-8">
          <span class="patrol-banner-title">巡回中 (${visited}/${total})</span>
          <span class="badge badge-success">${current ? (currentIdx + 1) + '店舗目' : '完了'}</span>
        </div>
        ${current ? `<div class="text-sm patrol-banner-current">現在: ${esc(currentName)}</div>` : ''}
        <button class="btn btn-success btn-block mt-8" id="btn-patrol-return">巡回画面に戻る</button>
      </div>`;
  }

  function wirePatrolBannerHandlers() {
    document.getElementById('btn-patrol-return')?.addEventListener('click', () => {
      Router.navigate('patrol');
    });
  }

  // ---------- ホーム画面（ルート計画） ----------

  function renderHome(container) {
    setTitle('巡回ルート');
    return renderMapView(container);
  }

  function doOptimize() {
    const selected = selectedStoreIds.map(id => stores.find(s => s.store_id === id)).filter(Boolean);
    const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
    const speed = Number(config.avg_speed_kmh) || 30;
    const selRoute = RouteOptimizer.calcSelectionOrder(home, selected, speed);
    Router.navigate('route-select', { selRoute });
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
      inner = `<img class="map-pin-logo" src="${withVer(logo)}" alt="">`;
    } else if (abbr) {
      inner = `<span class="map-pin-text">${esc(abbr)}</span>`;
    } else {
      inner = `<span class="map-pin-emoji">${store.icon || '&#x1f3ea;'}</span>`;
    }
    const style = `border-color:${color}`;
    return L.divIcon({
      className: '',
      html: `<div class="${cls}" style="${style}">${inner}${badge}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
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
      ${buildPatrolBanner()}
      ${buildPlannedRouteBanner()}
      ${chipHtml}
      <div id="map-view">
        <button class="btn-map-current" id="btn-map-current" title="現在地" aria-label="現在地">
          <svg class="map-current-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-4.4 7-11a7 7 0 1 0-14 0c0 6.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        </button>
      </div>
      <div class="map-bottom-bar">
        <div class="flex-between mb-8">
          <span class="text-sm text-dim"><span id="map-sel-count">${selectedStoreIds.length}</span>店舗 選択中</span>
          <div class="map-bottom-actions">
            <button class="btn btn-sm btn-outline ${mapBoundsFilter ? 'active' : ''}" id="btn-map-bounds" aria-pressed="${mapBoundsFilter}">${mapBoundsFilter ? '範囲指定中' : '表示範囲に絞る'}</button>
            <button class="btn btn-sm btn-outline" id="btn-map-clear" ${selectedStoreIds.length < 1 ? 'disabled' : ''}>クリア</button>
          </div>
        </div>
        <button class="btn btn-outline btn-block map-recommend-btn" id="btn-map-recommend">次に回る候補</button>
        <button class="btn btn-primary btn-block mt-8" id="btn-map-optimize" ${selectedStoreIds.length < 1 ? 'disabled' : ''}>
          ${selectedStoreIds.length < 1 ? '店舗を選択してください' : 'ルート作成'}
        </button>
      </div>
    `;

    // 予定ルートまたは巡回中バナーがある場合は最上部までスクロール
    if ((plannedRoute && plannedRoute.orderedStores && plannedRoute.orderedStores.length) || patrolState) {
      window.scrollTo(0, 0);
    }

    // 予定ルート・巡回中バナーのボタン
    wirePlannedRouteHandlers();
    wirePatrolBannerHandlers();

    // チェーンチップ: 押したチェーンだけ表示
    container.querySelectorAll('.chain-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        if (chip.dataset.chain === mapChainFilter) return;
        const chips = container.querySelector('.map-chain-filter');
        const savedScroll = chips ? chips.scrollLeft : 0;
        mapChainFilter = chip.dataset.chain;
        container.querySelectorAll('.chain-chip').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.chain === mapChainFilter);
        });
        if (chips) chips.scrollLeft = savedScroll;
        if (mapInstance) mapInstance.closePopup();
        refreshMapMarkers();
      });
    });

    // Leaflet初期化（DOMレイアウト完了後）
    requestAnimationFrame(() => requestAnimationFrame(() => initMap()));

    document.getElementById('btn-map-clear').addEventListener('click', () => {
      selectedStoreIds = [];
      optimizedRoute = null;
      refreshMapMarkers();
      updateMapBottomBar();
    });
    document.getElementById('btn-map-bounds').addEventListener('click', e => {
      mapBoundsFilter = !mapBoundsFilter;
      e.currentTarget.classList.toggle('active', mapBoundsFilter);
      e.currentTarget.setAttribute('aria-pressed', String(mapBoundsFilter));
      e.currentTarget.textContent = mapBoundsFilter ? '範囲指定中' : '表示範囲に絞る';
      refreshMapMarkers();
    });
    document.getElementById('btn-map-optimize').addEventListener('click', doOptimize);
    document.getElementById('btn-map-recommend').addEventListener('click', showNextStoreRecommendationModal);

    // 現在地ボタン（Leaflet初期化後に押せるようにrAF後ではなく直後に登録）
    const btnCurrent = document.getElementById('btn-map-current');
    if (btnCurrent) btnCurrent.addEventListener('click', moveToCurrent);

    preloadMapVisitInfo_();
  }

  // 初期中心は常に仙台駅固定
  const SENDAI_STATION = [38.2603, 140.8828];

  function initMap() {
    const mapEl = document.getElementById('map-view');
    if (!mapEl) return;
    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
      mapCluster = null;
      mapMarkers.clear();
    }
    patrolPolyline = null;

    mapInstance = L.map(mapEl, {
      center: SENDAI_STATION,
      zoom: 11,
      zoomControl: true,
      doubleClickZoom: false,
      preferCanvas: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
    });
    wireMapDoubleTapZoom(mapEl);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      updateWhenIdle: false,     // アニメ終了を待たずタイル取得を開始
      updateWhenZooming: false,  // アニメ中の描画更新は抑制（ガクつき防止）
      updateInterval: 120,
      keepBuffer: 5,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(mapInstance);

    mapCluster = L.layerGroup();
    mapInstance.addLayer(mapCluster);
    mapMarkers.clear();
    mapInstance.on('zoomend moveend', () => {
      if (!mapInstance) return;
      if (mapBoundsFilter) refreshMapMarkers();
    });
    refreshMapMarkers();
    fitMapToMarkers();
  }

  function wireMapDoubleTapZoom(mapEl) {
    if (!mapInstance || !mapEl) return;

    function zoomInAt(latlng) {
      if (!latlng || !mapInstance) return;
      const maxZoom = mapInstance.getMaxZoom() || 19;
      const nextZoom = Math.min(mapInstance.getZoom() + 1, maxZoom);
      mapInstance.setZoomAround(latlng, nextZoom, { animate: true });
    }

    let lastTapAt = 0;
    let lastTapPoint = null;
    let touchZoomAt = 0;

    mapInstance.on('dblclick', e => {
      if (Date.now() - touchZoomAt < 450) return;
      zoomInAt(e.latlng);
    });

    mapEl.addEventListener('touchend', e => {
      if (!mapInstance || e.changedTouches.length !== 1) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest('.leaflet-control, .leaflet-marker-icon, .leaflet-popup, button, a')) return;

      const touch = e.changedTouches[0];
      const now = Date.now();
      const point = { x: touch.clientX, y: touch.clientY };
      const distance = lastTapPoint
        ? Math.hypot(point.x - lastTapPoint.x, point.y - lastTapPoint.y)
        : Infinity;

      if (now - lastTapAt < 320 && distance < 28) {
        e.preventDefault();
        touchZoomAt = now;
        lastTapAt = 0;
        lastTapPoint = null;
        const rect = mapEl.getBoundingClientRect();
        const containerPoint = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
        zoomInAt(mapInstance.containerPointToLatLng(containerPoint));
        return;
      }

      lastTapAt = now;
      lastTapPoint = point;
    }, { passive: false });
  }

  function setCurrentLocationMarker(pos) {
    if (!mapInstance) return;
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    // 既存マーカーを削除してから再作成（差分更新）
    if (currentLocationMarker) {
      mapInstance.removeLayer(currentLocationMarker);
      currentLocationMarker = null;
    }
    if (currentLocationCircle) {
      mapInstance.removeLayer(currentLocationCircle);
      currentLocationCircle = null;
    }

    // 精度サークル（薄い青）
    currentLocationCircle = L.circle([lat, lng], {
      radius: accuracy,
      color: '#2563EB',
      fillColor: '#3B82F6',
      fillOpacity: 0.12,
      weight: 1,
    }).addTo(mapInstance);

    // 現在地マーカー（青い丸）
    const currentIcon = L.divIcon({
      className: '',
      html: '<div class="map-current-location"></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    currentLocationMarker = L.marker([lat, lng], {
      icon: currentIcon,
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(mapInstance);
  }

  // 現在地にマップ中心を移動する
  function moveToCurrent() {
    if (!mapInstance) return;
    if (!navigator.geolocation) {
      toast('位置情報が使えません');
      return;
    }
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      mapInstance.setView([lat, lng], 14, { animate: true });
      setCurrentLocationMarker(pos);
    }, () => {
      toast('現在地を取得できませんでした');
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  function buildMapPopupHtml(s, selIdx) {
    const categoryLabel = GENRE_DISPLAY[s.category] || s.category || '';
    const visitLabel = getMapPopupLastVisitLabel_(s);
    return `<div class="map-popup">
          <div class="map-popup-name">${esc(s.name)}</div>
          <div class="map-popup-meta">${esc(categoryLabel)}</div>
          <div class="map-popup-visit">${esc(visitLabel)}</div>
          <button class="btn btn-primary map-popup-btn" data-sid="${s.store_id}" onclick="App.toggleMapSelection('${s.store_id}')">
            ${selIdx >= 0 ? '選択解除' : '選択'}
          </button>
        </div>`;
  }

  function buildStoreVisitInfoFromRoutes_(routes) {
    const infoByStoreId = new Map();
    (routes || []).forEach(route => {
      const routeDate = normalizeRouteDate_(route.date || route.created_at || route.started_at || route.end_time || route.finished_at);
      (route.stops || []).forEach(stop => {
        if (!isRouteAreaVisitStop_(stop)) return;
        const storeId = String(stop.store_id || '').trim();
        if (!storeId) return;
        const stopDate = routeDate || normalizeRouteDate_(stop.departure_time || stop.arrival_time || stop.updated_at);
        if (!stopDate) return;
        const current = infoByStoreId.get(storeId) || { visitCount: 0, lastVisited: '' };
        current.visitCount += 1;
        current.lastVisited = newerDateText_(current.lastVisited, stopDate);
        infoByStoreId.set(storeId, current);
      });
    });
    return infoByStoreId;
  }

  function setMapVisitInfoFromRoutes_(routes) {
    mapVisitInfoByStoreId = buildStoreVisitInfoFromRoutes_(routes);
    mapVisitInfoLoaded = true;
    mapVisitInfoFetchedAt = Date.now();
    refreshMapMarkers();
  }

  function setMapVisitInfoFromCachedRows_(rows, savedAt) {
    mapVisitInfoByStoreId = new Map((rows || [])
      .filter(row => row && row.store_id)
      .map(row => [String(row.store_id), {
        visitCount: Number(row.visitCount) || 0,
        lastVisited: normalizeRouteDate_(row.lastVisited),
      }]));
    mapVisitInfoLoaded = true;
    mapVisitInfoFetchedAt = Number(savedAt) || Date.now();
    refreshMapMarkers();
  }

  function serializeMapVisitInfo_() {
    return Array.from(mapVisitInfoByStoreId.entries()).map(([store_id, info]) => ({
      store_id,
      visitCount: Number(info.visitCount) || 0,
      lastVisited: normalizeRouteDate_(info.lastVisited),
    }));
  }

  function getMapVisitInfo_(store) {
    const storeId = String(store?.store_id || '').trim();
    const routeInfo = storeId ? mapVisitInfoByStoreId.get(storeId) : null;
    const routeLastVisited = normalizeRouteDate_(routeInfo?.lastVisited);
    if (routeLastVisited) return { lastVisited: routeLastVisited, source: 'history' };

    const sheetLastVisited = normalizeRouteDate_(store?.last_visited);
    if (sheetLastVisited) return { lastVisited: sheetLastVisited, source: 'store' };

    return { lastVisited: '', source: mapVisitInfoLoaded ? 'none' : 'loading' };
  }

  function getMapPopupLastVisitLabel_(store) {
    const info = getMapVisitInfo_(store);
    if (!info.lastVisited) {
      return info.source === 'loading' ? '訪問履歴を確認中' : '前回訪問なし';
    }
    const days = daysSinceDateText_(info.lastVisited);
    return `前回訪問から${days}日経過`;
  }

  async function preloadMapVisitInfo_() {
    if (mapVisitInfoLoaded && (Date.now() - mapVisitInfoFetchedAt) < MAP_VISIT_INFO_TTL_MS) {
      return Promise.resolve();
    }
    if (mapVisitInfoLoading) return mapVisitInfoLoading;
    mapVisitInfoLoading = (async () => {
      try {
        const cachedMapInfo = await Storage.getViewCache(MAP_VISIT_INFO_CACHE_ID).catch(() => null);
        if (cachedMapInfo && Array.isArray(cachedMapInfo.data) && cachedMapInfo.data.length) {
          setMapVisitInfoFromCachedRows_(cachedMapInfo.data, cachedMapInfo.savedAt);
          if ((Date.now() - mapVisitInfoFetchedAt) < MAP_VISIT_INFO_TTL_MS) return;
        }

        const cached = await Storage.getViewCache('history').catch(() => null);
        if (cached && Array.isArray(cached.data) && cached.data.length) {
          setMapVisitInfoFromRoutes_(cached.data);
        }

        const routes = await API.getRouteHistory({ limit: 300, include_stops: 'true' });
        setMapVisitInfoFromRoutes_(routes);
        Storage.saveViewCache(MAP_VISIT_INFO_CACHE_ID, serializeMapVisitInfo_()).catch(() => {});
      } catch (error) {
        mapVisitInfoLoaded = true;
        refreshMapMarkers();
        console.warn('map visit info load failed:', error);
      } finally {
        mapVisitInfoLoading = null;
      }
    })();
    return mapVisitInfoLoading;
  }

  function getLatLngKey(store) {
    const lat = Number(store.lat);
    const lng = Number(store.lng);
    if (!lat || !lng) return '';
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  function buildMarkerPositions(visibleStores) {
    const groups = new Map();
    visibleStores.forEach(store => {
      const key = getLatLngKey(store);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(store);
    });

    const positions = new Map();
    groups.forEach(group => {
      group.sort((a, b) => {
        const rank = store => {
          const name = String(store.name || '');
          if (name.includes('トレファクスタイル イオンモール仙台上杉店')) return 0;
          if (name.includes('コジマ×ビックカメラ イオンモール仙台上杉店')) return 1;
          return 2;
        };
        return rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
      });
      if (group.length === 1) {
        const s = group[0];
        positions.set(s.store_id, [Number(s.lat), Number(s.lng)]);
        return;
      }

      const radius = 0.00012; // 約10m。建物内の重複ピンを見分けるための表示専用オフセット
      group.forEach((s, idx) => {
        const angle = (Math.PI * 2 * idx) / group.length - Math.PI / 2;
        positions.set(s.store_id, [
          Number(s.lat) + Math.sin(angle) * radius,
          Number(s.lng) + Math.cos(angle) * radius,
        ]);
      });
    });
    return positions;
  }

  function refreshMapMarkers() {
    if (!mapInstance || !mapCluster) return;

    // 巡回中は巡回ルートの店舗を必ず表示しフィルター無視
    const patrolIds = patrolState ? patrolState.stops.map(s => s.store_id) : [];
    const patrolIdSet = new Set(patrolIds);

    // 差分更新: 既存markerを使いまわし、不要分だけ削除・新規だけ追加
    const wanted = new Map();
    stores.forEach(s => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      if (!lat || !lng) return;
      if (mapChainFilter !== 'all' && getChain(s) !== mapChainFilter && !patrolIdSet.has(s.store_id)) return;
      if (mapBoundsFilter && !patrolIdSet.has(s.store_id) && !mapInstance.getBounds().contains([lat, lng])) return;
      wanted.set(s.store_id, s);
    });

    const markerPositions = buildMarkerPositions([...wanted.values()]);

    mapMarkers.forEach((marker, sid) => {
      if (!wanted.has(sid)) {
        mapCluster.removeLayer(marker);
        mapMarkers.delete(sid);
      }
    });

    wanted.forEach((s, sid) => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      // 巡回中は巡回順を優先、なければ通常の選択順
      const patrolIdx = patrolIds.indexOf(sid);
      const selIdx = patrolIdx >= 0 ? patrolIdx : selectedStoreIds.indexOf(sid);
      const existing = mapMarkers.get(sid);
      const markerLatLng = markerPositions.get(sid) || [lat, lng];
      if (existing) {
        existing.setLatLng(markerLatLng);
        existing.setIcon(buildPinIcon(s, selIdx));
        existing.setPopupContent(buildMapPopupHtml(s, selIdx));
      } else {
        const marker = L.marker(markerLatLng, { icon: buildPinIcon(s, selIdx) });
        marker.bindPopup(buildMapPopupHtml(s, selIdx));
        mapCluster.addLayer(marker);
        mapMarkers.set(sid, marker);
      }
    });

    // 巡回ルートのポリライン描画
    drawPatrolPolyline();
  }

  let patrolPolyline = null;
  function drawPatrolPolyline() {
    if (!mapInstance) return;
    if (patrolPolyline) { mapInstance.removeLayer(patrolPolyline); patrolPolyline = null; }
    if (!patrolState || !patrolState.stops || patrolState.stops.length < 2) return;
    const latlngs = patrolState.stops
      .map(s => {
        const store = stores.find(st => st.store_id === s.store_id) || s;
        const lat = Number(store.lat), lng = Number(store.lng);
        return (lat && lng) ? [lat, lng] : null;
      })
      .filter(Boolean);
    if (latlngs.length < 2) return;
    patrolPolyline = L.polyline(latlngs, {
      color: '#22c55e',
      weight: 4,
      opacity: 0.75,
      dashArray: '8 6',
    }).addTo(mapInstance);
  }

  function fitMapToMarkers() {
    if (!mapInstance || !mapCluster) return;
    // ズームは「全て」の店舗の境界で統一（チェーン絞込でも同じ縮尺）
    const allLatLngs = [];
    stores.forEach(s => {
      const lat = Number(s.lat), lng = Number(s.lng);
      if (!lat || !lng) return;
      allLatLngs.push([lat, lng]);
    });
    if (allLatLngs.length === 0) return;
    mapInstance.invalidateSize(false);
    const bounds = L.latLngBounds(allLatLngs);
    const fitZoom = mapInstance.getBoundsZoom(bounds, false, [40, 40]);
    const target = Math.min(fitZoom + 2, mapInstance.getMaxZoom() || 19);
    mapInstance.setView(SENDAI_STATION, target, { animate: false });
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
    const clearBtn = document.getElementById('btn-map-clear');
    const hasSelection = selectedStoreIds.length > 0;
    if (countEl) countEl.textContent = selectedStoreIds.length;
    if (btn) {
      btn.disabled = !hasSelection;
      btn.textContent = hasSelection ? 'ルート作成' : '店舗を選択してください';
    }
    if (clearBtn) clearBtn.disabled = !hasSelection;
  }

  async function showNextStoreRecommendationModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay recommendation-overlay';
    overlay.innerHTML = `
      <div class="modal recommendation-modal">
        <div class="recommendation-head">
          <div>
            <div class="recommendation-title">次に回る候補</div>
            <div class="recommendation-subtitle">14日未満は原則外し、地域の空き期間を強めに見ます</div>
          </div>
          <button class="recommendation-close" type="button" aria-label="閉じる">閉じる</button>
        </div>
        <div id="recommendation-body" class="recommendation-body">
          <div class="recommendation-loading"><span class="spinner"></span><span>候補を計算中...</span></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.recommendation-close')?.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const slowTimer = setTimeout(() => {
      const body = overlay.querySelector('#recommendation-body');
      if (body) {
        body.innerHTML = `
          <div class="recommendation-loading">
            <span class="spinner"></span>
            <span>通信が遅いため、軽量候補に切り替えています...</span>
          </div>`;
      }
    }, 5000);

    try {
      const { payload, fromCache, error } = await loadRecommendationPayload_();
      renderRecommendationModalContent_(overlay, payload, { fromCache, error });
    } catch (err) {
      const body = overlay.querySelector('#recommendation-body');
      if (body) {
        body.innerHTML = `
          <div class="recommendation-empty">
            <div class="card-title">候補を出せませんでした</div>
            <div class="text-sm text-dim mt-8">API URLと通信状態を確認してからもう一度試してください。</div>
          </div>`;
      }
    } finally {
      clearTimeout(slowTimer);
    }
  }

  function withTimeout_(promise, timeoutMs, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message || 'timeout')), timeoutMs);
      })
    ]);
  }

  function buildRecommendationPayload_(inventoryItems, routes, meta = {}) {
    const areaVisits = Array.isArray(meta.areaVisits) ? meta.areaVisits : [];
    const { areaVisits: _areaVisits, ...payloadMeta } = meta;
    const stats = buildRecommendationStats(inventoryItems || [], routes || [], stores, areaVisits);
    const areas = scoreRecommendedAreas(stats);
    const allAreas = scoreRecommendedAreas(stats, { includeCooldown: true });
    return { generatedAt: new Date().toISOString(), stats, areas, allAreas, ...payloadMeta };
  }

  async function loadRecommendationPayload_() {
    try {
      const [inventoryResult, areaResult] = await Promise.allSettled([
        withTimeout_(
        API.getInventoryPurchases({
          from_date: RECOMMENDATION_FROM_DATE,
          to_date: today_(),
          limit: RECOMMENDATION_INVENTORY_LIMIT
        }),
        RECOMMENDATION_TIMEOUT_MS,
        'recommendation inventory timeout'
        ),
        withTimeout_(
          API.getRouteAreaVisits({ from_date: RECOMMENDATION_FROM_DATE, to_date: today_() }),
          RECOMMENDATION_TIMEOUT_MS,
          'recommendation area visits timeout'
        )
      ]);
      if (inventoryResult.status === 'rejected' && areaResult.status === 'rejected') {
        throw inventoryResult.reason || areaResult.reason;
      }
      const inventoryItems = inventoryResult.status === 'fulfilled' ? inventoryResult.value : [];
      const areaVisits = areaResult.status === 'fulfilled' ? areaResult.value : [];
      const payload = buildRecommendationPayload_(inventoryItems, [], {
        fallback: inventoryResult.status === 'rejected',
        areaVisits,
      });
      Storage.saveViewCache(RECOMMENDATION_CACHE_ID, payload).catch(() => {});
      return { payload, fromCache: false };
    } catch (error) {
      const cached = await Storage.getViewCache(RECOMMENDATION_CACHE_ID).catch(() => null);
      if (cached && cached.data && Array.isArray(cached.data.areas)) {
        return { payload: cached.data, fromCache: true, error };
      }
      const payload = buildRecommendationPayload_([], [], { fallback: true });
      return { payload, fromCache: false, error };
    }
  }

  function buildRecommendationStats(inventoryItems, routes, allStores, areaVisits = []) {
    const baseStats = buildStoreStats(inventoryItems, routes, allStores);
    const storeById = new Map(allStores.map(s => [String(s.store_id || ''), s]));
    const visitsByStore = new Map();
    const areaMap = new Map();

    function ensureArea(areaId) {
      const areaDef = AREAS.find(a => a.id === areaId) || AREAS.find(a => a.id === 'other');
      const id = areaDef ? areaDef.id : 'other';
      if (!areaMap.has(id)) {
        areaMap.set(id, {
          id,
          name: areaDef ? areaDef.name : 'その他',
          group: areaDef ? areaDef.group : 'その他',
          storeCount: 0,
          mappableStoreCount: 0,
          visitCount: 0,
          totalExpectedProfit: 0,
          lastVisited: '',
        });
      }
      return areaMap.get(id);
    }

    allStores.forEach(store => {
      const area = ensureArea(getArea(store));
      area.storeCount += 1;
      if (Number(store.lat) && Number(store.lng)) area.mappableStoreCount += 1;
    });

    (routes || []).forEach(route => {
      if (!isRecommendationRouteEffective_(route)) return;
      const routeDate = normalizeRouteDate_(route.date || route.created_at || route.started_at);
      (route.stops || []).forEach(stop => {
        if (!isRouteAreaVisitStop_(stop)) return;
        const store = storeById.get(String(stop.store_id || ''));
        if (!store) return;
        const stopDate = routeDate || normalizeRouteDate_(stop.departure_time || stop.arrival_time);
        const info = visitsByStore.get(store.store_id) || { visitCount: 0, lastVisited: '' };
        info.visitCount += 1;
        if (stopDate) info.lastVisited = newerDateText_(info.lastVisited, stopDate);
        visitsByStore.set(store.store_id, info);

        const area = ensureArea(getArea(store));
        area.visitCount += 1;
        if (stopDate) area.lastVisited = newerDateText_(area.lastVisited, stopDate);
      });
    });

    const storeStats = allStores.map(store => {
      const base = baseStats[store.store_id] || {};
      const visitInfo = visitsByStore.get(store.store_id) || {};
      const areaId = getArea(store);
      const totalExpectedProfit = Number(base.totalExpectedProfit) || 0;
      const visits = Math.max(
        Number(store.visit_count) || 0,
        Number(base.visitCount) || 0,
        Number(visitInfo.visitCount) || 0
      );
      const routeLastVisited = normalizeRouteDate_(visitInfo.lastVisited);
      const sheetLastVisited = normalizeRouteDate_(store.last_visited);
      const lastVisited = routeLastVisited || sheetLastVisited;
      const area = ensureArea(areaId);
      area.totalExpectedProfit += totalExpectedProfit;
      if (lastVisited) area.lastVisited = newerDateText_(area.lastVisited, lastVisited);
      return {
        store,
        store_id: store.store_id,
        name: store.name || '',
        areaId,
        areaName: area.name,
        category: store.category || '',
        visits,
        lastVisited,
        daysSinceStoreVisit: daysSinceDateText_(lastVisited),
        totalExpectedProfit,
        hasCoords: !!(Number(store.lat) && Number(store.lng)),
      };
    });

    (areaVisits || []).forEach(row => {
      const areaId = String(row.area_id || row.id || '').trim();
      if (!areaId) return;
      const area = ensureArea(areaId);
      const lastVisited = normalizeRouteDate_(row.last_visited || row.lastVisited);
      if (lastVisited) area.lastVisited = newerDateText_(area.lastVisited, lastVisited);
      area.visitCount = Math.max(Number(area.visitCount) || 0, Number(row.visit_count) || 0);
      if (row.name) area.name = row.name;
      if (row.group) area.group = row.group;
    });

    const areaStats = Array.from(areaMap.values()).map(area => ({
      ...area,
      daysSinceAreaVisit: daysSinceDateText_(area.lastVisited),
    }));

    return { areas: areaStats, stores: storeStats };
  }

  function getRecommendationIntervalRatio_(daysSince) {
    const days = Number(daysSince);
    if (!Number.isFinite(days) || days >= 999) return 1;
    const scoringDays = RECOMMENDATION_AREA_TARGET_DAYS - RECOMMENDATION_AREA_COOLDOWN_DAYS;
    return clamp_((days - RECOMMENDATION_AREA_COOLDOWN_DAYS) / scoringDays, 0, 1);
  }

  function isRecommendationAreaReady_(area) {
    if (!area || !area.lastVisited) return true;
    return Number(area.daysSinceAreaVisit) >= RECOMMENDATION_AREA_COOLDOWN_DAYS;
  }

  function isRecommendationRouteEffective_(route) {
    const stops = route?.stops || [];
    if (stops.some(stop => String(stop.status || '').trim().toLowerCase() === 'visited')) return true;
    if (Number(route?.total_purchase) > 0 || Number(route?.total_items) > 0) return true;
    if (Number(route?.expected_profit) > 0) return true;
    return !!(route && normalizeRouteDate_(route.end_time || route.finished_at));
  }

  function scoreRecommendedAreas(stats, options = {}) {
    const scoredAreas = stats.areas
      .filter(area => area.storeCount > 0)
      .map(area => {
        const topStores = scoreRecommendedStores(area.id, stats).slice(0, 7);
        const intervalRatio = getRecommendationIntervalRatio_(area.daysSinceAreaVisit);
        const topScoreAvg = topStores.length
          ? topStores.slice(0, 3).reduce((sum, s) => sum + s.finalScore, 0) / Math.min(3, topStores.length)
          : intervalRatio * 50;
        const avgFrequencyScore = topStores.length
          ? topStores.slice(0, 3).reduce((sum, s) => sum + s.frequencyScore, 0) / Math.min(3, topStores.length)
          : 0;
        return {
          ...area,
          finalScore: Math.round(topScoreAvg * 10) / 10,
          intervalScore: intervalRatio * 50,
          profitRatio: clamp_(area.totalExpectedProfit / 50000, 0, 1),
          intervalRatio,
          frequencyRatio: clamp_(avgFrequencyScore / 20, 0, 1),
          topStores,
        };
      });

    const sortedAreas = scoredAreas.sort((a, b) => b.finalScore - a.finalScore);
    if (options.includeCooldown) return sortedAreas;
    const readyAreas = sortedAreas.filter(isRecommendationAreaReady_);
    if (readyAreas.length === 0) return [];
    return readyAreas;
  }

  function scoreRecommendedStores(areaId, stats) {
    const area = stats.areas.find(a => a.id === areaId);
    const areaIntervalScore = getRecommendationIntervalRatio_(area?.daysSinceAreaVisit || 0) * 50;
    return stats.stores
      .filter(st => st.areaId === areaId)
      .map(st => {
        const profitScore = clamp_(st.totalExpectedProfit / 50000, 0, 1) * 30;
        const frequencyScore = getRecommendationFrequencyScore_(st.visits);
        const finalScore = Math.round((areaIntervalScore + profitScore + frequencyScore) * 10) / 10;
        return {
          ...st,
          areaIntervalScore,
          profitScore,
          frequencyScore,
          finalScore,
          reasons: buildRecommendationReasons_(st, area),
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore || b.totalExpectedProfit - a.totalExpectedProfit);
  }

  function getRecommendationFrequencyScore_(visits) {
    if (visits === 0) return 8;
    if (visits <= 3) return 20;
    if (visits <= 8) return 16;
    return 10;
  }

  function buildRecommendationReasons_(storeScore, area) {
    const reasons = [];
    if (!area || !area.lastVisited) reasons.push('地域未訪問');
    else if (area.daysSinceAreaVisit >= 14) reasons.push(`前回から${area.daysSinceAreaVisit}日`);
    if (storeScore.totalExpectedProfit > 0) reasons.push(`見込み${formatYen_(storeScore.totalExpectedProfit)}`);
    if (storeScore.visits === 0) reasons.push('未開拓');
    else reasons.push(`訪問${storeScore.visits}回`);
    if (!storeScore.hasCoords) reasons.push('座標なし');
    return reasons;
  }

  function renderRecommendationModalContent_(overlay, payload, options = {}) {
    const body = overlay.querySelector('#recommendation-body');
    if (!body) return;
    const topAreas = (payload.areas || [])
      .filter(area => area && Array.isArray(area.topStores) && area.topStores.length > 0)
      .slice(0, 3);
    if (topAreas.length === 0) {
      const hasTrackedAreas = (payload.stats?.areas || []).some(area => area && area.storeCount > 0);
      const cooldownAreas = (payload.allAreas || payload.stats?.areas || [])
        .filter(area => area && area.storeCount > 0)
        .slice(0, 6);
      body.innerHTML = `
        <div class="recommendation-empty">
          <div class="card-title">${hasTrackedAreas ? '全地域がクールダウン中です' : '候補がありません'}</div>
          <div class="text-sm text-dim mt-8">${hasTrackedAreas ? 'いまは全地域が14日未満（クールダウン中）です。急いで回る地域はありません。' : '店舗データまたは履歴データを更新してからもう一度試してください。'}</div>
          ${renderRecommendationCooldownList_(cooldownAreas)}
        </div>`;
      return;
    }

    body.innerHTML = `
      ${options.fromCache ? '<div class="recommendation-cache-note">前回保存した候補を表示中です。最新データの取得には失敗しました。</div>' : ''}
      ${payload.fallback ? '<div class="recommendation-cache-note">通信が遅いため、地域の最終巡回日を優先して軽量候補を表示中です。</div>' : ''}
      <div class="recommend-area-list-head">
        <span>おすすめ地域 Top3</span>
        <b>${topAreas.length}地域</b>
      </div>
      <div class="recommend-area-list">
        ${topAreas.map(renderRecommendationAreaOption_).join('')}
      </div>`;

    overlay.querySelectorAll('.recommend-area-option').forEach(detail => {
      detail.addEventListener('toggle', () => {
        if (!detail.open) return;
        overlay.querySelectorAll('.recommend-area-option[open]').forEach(other => {
          if (other !== detail) other.open = false;
        });
      });
    });
    overlay.querySelectorAll('.recommend-select-area').forEach(btn => {
      btn.addEventListener('click', () => {
        const area = topAreas.find(a => String(a.id || '') === String(btn.dataset.areaId || ''));
        if (!area) return;
        const storesToAdd = area.topStores
          .filter(st => st.hasCoords)
          .slice(0, RECOMMENDATION_TOP_STORE_LIMIT);
        const added = addRecommendedStoresToSelection_(storesToAdd);
        if (added > 0) toast(`${added}店舗を選択しました`);
        updateRecommendationSelectionState_(overlay);
      });
    });
    overlay.querySelectorAll('.recommend-add-store').forEach(btn => {
      btn.addEventListener('click', () => {
        const added = addRecommendedStoresToSelection_([{ store_id: btn.dataset.storeId }]);
        if (added > 0) toast('店舗を追加しました');
        updateRecommendationSelectionState_(overlay);
      });
    });
    updateRecommendationSelectionState_(overlay);
  }

  function renderRecommendationCooldownList_(areas) {
    if (!areas.length) return '';
    return `
      <div class="recommend-cooldown-list">
        ${areas.map(area => {
          const visitLabel = area.lastVisited ? `前回から${area.daysSinceAreaVisit}日` : '未訪問';
          const stateLabel = isRecommendationAreaReady_(area) ? '候補対象' : '14日未満';
          return `
            <div class="recommend-cooldown-row">
              <span>${esc(area.name)}</span>
              <b>${esc(visitLabel)}</b>
              <em>${esc(stateLabel)}</em>
            </div>`;
        }).join('')}
      </div>`;
  }

  function renderRecommendationAreaOption_(area, index) {
    const selectableStores = area.topStores
      .filter(st => st.hasCoords)
      .slice(0, RECOMMENDATION_TOP_STORE_LIMIT);
    const selectableIds = selectableStores.map(st => String(st.store_id || '')).filter(Boolean);
    const areaVisitLabel = area.lastVisited ? `前回から${area.daysSinceAreaVisit}日` : '未訪問';
    return `
      <details class="recommend-area-option" data-area-id="${esc(area.id)}">
        <summary class="recommend-area-trigger" aria-label="${esc(area.name)}の店舗候補を開く">
          <span class="recommend-area-rank">${index + 1}</span>
          <span class="recommend-area-copy">
            <span class="recommend-label">おすすめ${index + 1}</span>
            <span class="recommend-area-name">${esc(area.name)}</span>
            <span class="recommend-area-meta">${esc(area.group)} / ${esc(areaVisitLabel)} / 候補${area.mappableStoreCount || area.storeCount}店舗</span>
          </span>
          <span class="recommend-area-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="recommend-area-detail">
          <div class="recommend-reasons">
            <span>${esc(areaVisitLabel)}</span>
            <span>見込み利益 ${formatYen_(area.totalExpectedProfit)}</span>
            <span>訪問実績 ${area.visitCount || 0}回</span>
          </div>
          <div class="recommend-store-list">
            ${area.topStores.map(renderRecommendationStoreRow_).join('')}
          </div>
          <div class="btn-group mt-12">
            <button
              class="btn btn-primary recommend-select-area"
              data-area-id="${esc(area.id)}"
              data-store-ids="${esc(selectableIds.join(','))}"
              ${selectableIds.length ? '' : 'disabled'}
            >この地域を選択</button>
          </div>
        </div>
      </details>`;
  }

  function renderRecommendationBar_(label, ratio, value) {
    const pct = Math.round(clamp_(ratio, 0, 1) * 100);
    return `
      <div class="recommend-score-row">
        <div class="recommend-score-label"><span>${label}</span><b>${esc(value)}</b></div>
        <div class="recommend-score-track"><div style="width:${pct}%"></div></div>
      </div>`;
  }

  function renderRecommendationStoreRow_(st) {
    const storeId = String(st.store_id || '');
    const selected = selectedStoreIds.some(id => String(id) === storeId);
    const disabled = selected || !st.hasCoords;
    const label = selected ? '選択済み' : (!st.hasCoords ? '座標なし' : '追加');
    return `
      <div class="recommend-store-row" data-store-id="${esc(storeId)}">
        <div class="recommend-store-main">
          <div class="recommend-store-name">${renderStopIconHtml(st.store)}${esc(st.name)}</div>
          <div class="recommend-store-meta">
            ${st.reasons.map(r => `<span>${esc(r)}</span>`).join('')}
          </div>
        </div>
        <div class="recommend-store-side">
          <div class="recommend-store-profit">${formatYen_(st.totalExpectedProfit)}</div>
          <button class="btn btn-sm btn-outline recommend-add-store" data-store-id="${esc(storeId)}" ${disabled ? 'disabled' : ''}>${label}</button>
        </div>
      </div>`;
  }

  function addRecommendedStoresToSelection_(storeScores) {
    let added = 0;
    storeScores.forEach(st => {
      const storeId = String(st.store_id || '');
      const store = stores.find(s => String(s.store_id) === storeId);
      if (!store || !Number(store.lat) || !Number(store.lng)) return;
      if (selectedStoreIds.some(id => String(id) === storeId)) return;
      selectedStoreIds.push(store.store_id);
      added += 1;
    });
    if (added > 0) {
      optimizedRoute = null;
      if (mapInstance) mapInstance.closePopup();
      refreshMapMarkers();
      updateMapBottomBar();
    }
    return added;
  }

  function updateRecommendationSelectionState_(overlay) {
    const selectedCount = overlay.querySelector('#recommend-selected-count');
    if (selectedCount) selectedCount.textContent = selectedStoreIds.length;
    overlay.querySelectorAll('.recommend-select-area').forEach(btn => {
      const ids = String(btn.dataset.storeIds || '').split(',').filter(Boolean);
      if (!ids.length) {
        btn.disabled = true;
        btn.textContent = '座標なし';
        return;
      }
      const hasRemaining = ids.some(storeId => !selectedStoreIds.some(id => String(id) === String(storeId)));
      btn.disabled = !hasRemaining;
      btn.textContent = hasRemaining ? 'この地域を選択' : '選択済み';
    });
    overlay.querySelectorAll('.recommend-add-store').forEach(btn => {
      const selected = selectedStoreIds.some(id => String(id) === String(btn.dataset.storeId || ''));
      if (selected) {
        btn.disabled = true;
        btn.textContent = '選択済み';
      }
    });
  }

  function renderOptimizedRoute(container) {
    const r = optimizedRoute;
    // Google Maps URLは後からGPS現在地で差し替え
    let mapsUrl = RouteOptimizer.generateMapsUrl({ lat: Number(config.home_lat), lng: Number(config.home_lng) }, r.orderedStores);

    let html = '<div class="route-result">';
    html += '<div class="card-title">巡回ルート</div>';
    html += '<div class="route-stats">';
    html += `<div class="route-stat"><div class="value">${r.totalDistanceKm}</div><div class="label">km</div></div>`;
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
        <a href="${mapsUrl}" target="_blank" class="btn btn-outline" id="btn-maps-link">Google Maps</a>
        <button class="btn btn-success" id="btn-start-patrol">巡回開始</button>
      </div>`;
    html += '</div>';

    container.insertAdjacentHTML('beforeend', html);

    document.getElementById('btn-start-patrol')?.addEventListener('click', startPatrol);
  }

  // ---------- ルート選択画面 ----------

  function renderRouteSelect(container, { selRoute } = {}) {
    if (!selRoute) { Router.navigate('home'); return; }
    setTitle('ルート確認');

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

    let html = '<div class="text-sm text-dim text-center mb-8">この順番で巡回します</div>';

    // 選択順ルートカード
    html += `
      <div class="route-select-card selected" data-route="selection">
        <div class="route-select-header">
          <div class="route-select-title">
            <span class="route-select-icon">順番</span>選択順ルート
          </div>
        </div>
        <div class="route-stats">
          <div class="route-stat"><div class="value">${selRoute.totalDistanceKm}</div><div class="label">km</div></div>
          <div class="route-stat"><div class="value">${selRoute.orderedStores.length}</div><div class="label">店舗</div></div>
        </div>
        ${buildStopList(selRoute.orderedStores)}
      </div>`;

    // アクションボタン
    html += `
      <div class="route-confirm-actions">
        <button class="btn btn-success btn-block" id="btn-confirm-route">今すぐ巡回開始</button>
        <button class="btn btn-primary btn-block mt-8" id="btn-save-planned">予定として保存（後で開始）</button>
        <button class="btn btn-outline btn-block mt-8" id="btn-back-select">戻る</button>
      </div>`;

    container.innerHTML = html;

    function pickRoute() {
      const chosen = selRoute;
      const home = { lat: Number(config.home_lat), lng: Number(config.home_lng) };
      chosen._mapsUrl = RouteOptimizer.generateMapsUrl(home, chosen.orderedStores);
      return chosen;
    }

    document.getElementById('btn-confirm-route')?.addEventListener('click', () => {
      optimizedRoute = pickRoute();
      // 今すぐ開始するので、既存の予定ルートは消しておく
      plannedRoute = null;
      Storage.clearPlannedRoute().catch(() => {});
      startPatrol();
    });

    document.getElementById('btn-save-planned')?.addEventListener('click', async () => {
      const chosen = pickRoute();
      plannedRoute = chosen;
      optimizedRoute = null;
      selectedStoreIds = [];
      try {
        await Storage.savePlannedRoute(chosen);
        toast('予定として保存しました');
      } catch (e) {
        toast('保存に失敗しました');
      }
      Router.navigate('home');
    });

    document.getElementById('btn-back-select')?.addEventListener('click', () => {
      Router.navigate('home');
    });
  }

  // ---------- 巡回モード ----------

  function getStoreMapsUrl(store) {
    if (!store) return '';
    if (store.address) {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(store.address)}`;
    }
    if (store.lat && store.lng) {
      return `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}`;
    }
    return '';
  }

  function renderPatrolInsightSkeleton(store) {
    const visits = Number(store.visit_count) || 0;
    const totalPurchase = Number(store.total_purchase) || 0;
    const totalItems = Number(store.total_items) || 0;
    const avgStay = Number(store.avg_stay_min) || 30;
    const purchaseLabel = totalPurchase >= 10000
      ? `${(totalPurchase / 10000).toFixed(totalPurchase >= 100000 ? 0 : 1)}万`
      : (totalPurchase ? totalPurchase.toLocaleString() : '-');
    return `
      <div class="patrol-insight-grid">
        <div class="patrol-insight"><div class="value">${visits}</div><div class="label">訪問</div></div>
        <div class="patrol-insight"><div class="value">${purchaseLabel}</div><div class="label">累計仕入</div></div>
        <div class="patrol-insight"><div class="value">${totalItems || '-'}</div><div class="label">点数</div></div>
        <div class="patrol-insight"><div class="value">${avgStay}</div><div class="label">目安分</div></div>
      </div>`;
  }

  function renderStoreContextPanel(store) {
    return `
      <div class="patrol-store-context card">
        <div class="flex-between mb-8">
          <div class="card-title">店舗メモ</div>
          <button class="btn btn-sm btn-outline" id="btn-add-memo">メモ追加</button>
        </div>
        ${renderPatrolInsightSkeleton(store)}
        <div id="store-context-body" class="store-context-body">
          <div class="text-sm text-dim">過去メモを読み込み中...</div>
        </div>
      </div>`;
  }

  function renderMemoList(memos, finds) {
    const memoHtml = (memos || []).slice(0, 3).map(m => `
      <div class="memo-row">
        <div class="memo-type">${esc(m.type || 'メモ')}</div>
        <div class="memo-content">${esc(m.content || '')}</div>
        <div class="memo-date">${esc(m.date || '')}</div>
      </div>
    `).join('');

    const findHtml = (finds || []).slice(0, 2).map(f => `
      <div class="memo-row">
        <div class="memo-type">${esc(f.action || '発見')}</div>
        <div class="memo-content">${esc(f.product_name || f.note || '')}</div>
        <div class="memo-date">${esc(f.date || '')}</div>
      </div>
    `).join('');

    if (!memoHtml && !findHtml) {
      return '<div class="store-context-empty">この店舗のメモはまだありません。</div>';
    }
    return `
      ${memoHtml ? `<div class="memo-section-title">過去メモ</div>${memoHtml}` : ''}
      ${findHtml ? `<div class="memo-section-title mt-8">過去の発見</div>${findHtml}` : ''}
    `;
  }

  async function loadPatrolStoreContext(store) {
    const el = document.getElementById('store-context-body');
    if (!el || !store?.store_id || !API.getUrl()) return;
    try {
      const [memos, finds] = await Promise.all([
        API.getMemos({ store_id: store.store_id, limit: 3 }),
        API.getFinds({ store_id: store.store_id, limit: 2 })
      ]);
      const currentEl = document.getElementById('store-context-body');
      if (currentEl) currentEl.innerHTML = renderMemoList(memos, finds);
    } catch (e) {
      const currentEl = document.getElementById('store-context-body');
      if (currentEl) currentEl.innerHTML = '<div class="store-context-empty">メモを取得できませんでした。</div>';
    }
  }

  function showStoreMemoModal(store) {
    const body = `
      <div class="form-group">
        <label class="form-label">種類</label>
        <select class="form-select" id="memo-type">
          <option>見る棚</option>
          <option>強いジャンル</option>
          <option>前回メモ</option>
          <option>注意点</option>
          <option>その他</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">内容</label>
        <textarea class="form-textarea" id="memo-content" placeholder="例: ワゴンと季節家電を先に見る"></textarea>
      </div>`;
    showModal('店舗メモを追加', body, (el) => {
      const type = el.querySelector('#memo-type').value;
      const content = el.querySelector('#memo-content').value.trim();
      if (!content) {
        toast('メモ内容を入力してください');
        return;
      }
      toast('メモを保存しました');
      syncWrite(API.addMemo({
        store_id: store.store_id,
        type,
        content,
        date: today_()
      }), 'メモ').then(result => { if (result) loadPatrolStoreContext(store); });
    });
  }

  async function startPatrol() {
    if (!optimizedRoute) return;
    const storeIds = optimizedRoute.orderedStores.map(s => s.store_id);
    const startButton = document.getElementById('btn-start-patrol');
    if (startButton?.disabled) return;
    if (startButton) {
      startButton.disabled = true;
      startButton.textContent = '巡回を開始しています...';
    }
    const operationId = API.createOperationId('startRoute');
    try {
      const result = await API.startRoute({
        store_ids: storeIds,
        total_distance_km: optimizedRoute.totalDistanceKm,
        operation_id: operationId
      });
      if (!result?.route_id) throw new Error('巡回IDを確認できませんでした');
      patrolState = {
        routeId: result.route_id,
        startOperationId: operationId,
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
    } catch (error) {
      toast(`巡回を開始できませんでした: ${error.message}`, 5000);
      if (startButton) {
        startButton.disabled = false;
        startButton.textContent = '巡回開始';
      }
    }
  }

  function renderPatrol(container) {
    if (!patrolState) { Router.navigate('home'); return; }
    setTitle('巡回中');

    const { stops, currentIdx } = patrolState;
    const current = stops[currentIdx];
    if (!current) { endPatrol(); return; }
    const mapsUrl = getStoreMapsUrl(current);
    const remainingCount = Math.max(0, stops.length - currentIdx - 1);
    const doneCount = stops.filter(s => s.status === 'visited').length;

    let html = '';

    // 次の店舗
    html += `
      <div class="patrol-current">
        <div class="patrol-topline">
          <div>
            <div class="current-label">次の店舗</div>
            <div class="current-progress">${currentIdx + 1} / ${stops.length} 店舗・残り${remainingCount}店舗</div>
          </div>
          <div class="patrol-timer" id="patrol-timer">00:00:00</div>
        </div>
        <div class="current-name">${renderStopIconHtml(current)}${esc(current.name)}</div>
        <div class="current-meta">${esc(current.category)} | ${formatTime(current.open_time)}-${formatTime(current.close_time)}</div>
        ${current.address ? `<a class="current-address" href="${mapsUrl}" target="_blank" rel="noopener">${esc(current.address)}</a>` : ''}
        ${mapsUrl ? `<a class="btn btn-primary btn-block patrol-nav-button" href="${mapsUrl}" target="_blank" rel="noopener">ナビ開始</a>` : ''}
      </div>`;

    html += `
      <div class="patrol-actions">
        <button class="btn btn-success btn-block" id="btn-depart">完了して次へ</button>
        <button class="btn btn-primary btn-block" id="btn-add-inventory-current">商品を在庫に登録</button>
      </div>`;

    html += renderStoreContextPanel(current);

    // スキップ
    html += `<div class="mt-12"><button class="btn btn-sm btn-outline btn-block" id="btn-skip">スキップ</button></div>`;

    // 残りの店舗
    if (currentIdx < stops.length - 1) {
      html += `<div class="route-next-title">このあと行く店舗 <span>${doneCount}件完了</span></div>`;
      for (let i = currentIdx + 1; i < stops.length; i++) {
        const s = stops[i];
        const mapsHref = getStoreMapsUrl(s);
        const addressHtml = s.address
          ? (mapsHref
              ? `<a class="stop-address" href="${mapsHref}" target="_blank" rel="noopener">${esc(s.address)}</a>`
              : `<div class="stop-address">${esc(s.address)}</div>`)
          : '';
        html += `
          <div class="route-stop route-stop-multi">
            <div class="stop-num" style="background:var(--border);color:var(--text-dim)">${i + 1}</div>
            <div class="stop-info">
              <div class="stop-name">${renderStopIconHtml(s)}${esc(s.name)}</div>
              ${addressHtml}
            </div>
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
    loadPatrolStoreContext(current);

    // イベント（UIを即更新、API同期はバックグラウンド）
    document.getElementById('btn-depart')?.addEventListener('click', () => {
      current.status = 'visited';
      // バックグラウンドでAPI同期
      syncWrite(API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'visited',
        purchase_amount: current.purchaseAmount,
        purchase_items: current.purchaseItems
      }), '訪問状態');
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
      syncWrite(API.updateStop({
        route_id: patrolState.routeId,
        store_id: current.store_id,
        status: 'skipped'
      }), 'スキップ状態');
      patrolState.currentIdx++;
      Storage.saveCurrentRoute(patrolState);
      if (patrolState.currentIdx >= stops.length) {
        endPatrol();
      } else {
        Router.navigate('patrol');
      }
    });

    document.getElementById('btn-end')?.addEventListener('click', () => endPatrol());

    document.getElementById('btn-add-inventory-current')?.addEventListener('click', () => {
      showInventoryPurchaseModal(current, {
        routeId: patrolState.routeId,
        date: today_(),
        onSaved: (result, payload) => {
          const amount = Number(payload.purchase_price) || 0;
          current.purchaseAmount = (Number(current.purchaseAmount) || 0) + amount;
          current.purchaseItems = (Number(current.purchaseItems) || 0) + 1;
          Storage.saveCurrentRoute(patrolState);
          syncWrite(API.updateStop({
            route_id: patrolState.routeId,
            store_id: current.store_id,
            status: current.status || 'planned',
            purchase_amount: current.purchaseAmount,
            purchase_items: current.purchaseItems
          }), '仕入れ集計');
        }
      });
    });

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
        syncWrite(API.addStopToRoute({
          route_id: patrolState.routeId,
          store_id: store.store_id
        }), '追加店舗');
      });
    });

    document.getElementById('btn-add-memo')?.addEventListener('click', () => showStoreMemoModal(current));
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
    if (patrolEnding || !patrolState) return;
    patrolEnding = true;
    if (patrolTimerInterval) { clearInterval(patrolTimerInterval); patrolTimerInterval = null; }
    try {
      const summary = { ...patrolState };
      const routeId = patrolState.routeId;
      if (!routeId || routeId === 'pending') throw new Error('巡回IDが確定していません');
      const operationId = patrolState.endOperationId || API.createOperationId('endRoute');
      patrolState.endOperationId = operationId;
      await Storage.saveCurrentRoute(patrolState);
      toast('巡回終了を保存しています...', 1500);
      await API.endRoute({ route_id: routeId, operation_id: operationId });
      patrolState = null;
      await Storage.clearCurrentRoute();
      Router.navigate('summary', { summary });
      invalidateHistoryApiCache();
      await loadData();
    } catch (error) {
      if (patrolState && patrolState.currentIdx >= patrolState.stops.length) {
        patrolState.currentIdx = Math.max(0, patrolState.stops.length - 1);
        await Storage.saveCurrentRoute(patrolState);
        Router.navigate('patrol');
      }
      toast(`巡回終了を保存できませんでした: ${error.message}`, 5000);
    } finally {
      patrolEnding = false;
    }
  }

  function resumePatrolFromHistory(route) {
    if (!route || !route.stops || route.stops.length === 0) {
      toast('この履歴には店舗データがないため再開できません');
      return;
    }
    if (patrolState) {
      if (!confirm('現在、別の巡回が進行中です。中断してこの履歴を再開しますか？')) return;
      if (patrolTimerInterval) { clearInterval(patrolTimerInterval); patrolTimerInterval = null; }
      patrolState = null;
    }

    // route.stopsを現在のstoresマスタと結合してpatrolStateを復元
    const reconstructed = route.stops
      .slice()
      .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0))
      .map(rs => {
        const base = stores.find(st => st.store_id === rs.store_id) || {};
        return {
          ...base,
          store_id: rs.store_id,
          name: base.name || rs.store_name || rs.store_id,
          status: rs.status || 'planned',
          arrivalTime: rs.arrival_time || null,
          departureTime: rs.departure_time || null,
          purchaseAmount: Number(rs.purchase_amount) || 0,
          purchaseItems: Number(rs.purchase_items) || 0,
        };
      });

    // 未訪問 or 訪問中の最初のstopを現在位置に。全て完了済みなら最後のstopを滞在中に戻す
    let currentIdx = reconstructed.findIndex(s => s.status === 'visiting' || s.status === 'planned');
    if (currentIdx < 0) {
      currentIdx = reconstructed.length - 1;
      reconstructed[currentIdx].status = 'visiting';
    }

    patrolState = {
      routeId: route.route_id,
      startTime: route.date ? new Date(route.date).getTime() : Date.now(),
      stops: reconstructed,
      currentIdx,
    };
    Storage.saveCurrentRoute(patrolState);
    toast('巡回を再開しました');
    Router.navigate('patrol');
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
      syncWrite(API.addPurchase({
        store_id: stop.store_id,
        route_id: patrolState.routeId,
        amount, items_count: items, genre, note
      }), '仕入れ記録');
    });
  }

  function showInventoryPurchaseModal(store, options = {}) {
    const purchaseDate = normalizeRouteDate_(options.date) || today_();
    const storeName = store?.name || store?.store_name || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">商品を在庫に登録</div>
        <div class="text-sm text-dim mb-8">${esc(storeName)} の仕入れ品として登録します</div>
        <div class="form-group">
          <label class="form-label">商品名</label>
          <input type="text" class="form-input" id="ip-name" placeholder="例: BURBERRY 長袖シャツ">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">仕入価格</label>
            <input type="number" class="form-input" id="ip-price" inputmode="numeric" placeholder="0">
          </div>
          <div class="form-group">
            <label class="form-label">販売予定価格</label>
            <input type="number" class="form-input" id="ip-sale-price" inputmode="numeric" placeholder="任意">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">ブランド</label>
            <input type="text" class="form-input" id="ip-brand" placeholder="任意">
          </div>
          <div class="form-group">
            <label class="form-label">サイズ</label>
            <input type="text" class="form-input" id="ip-size" placeholder="任意">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">色</label>
            <input type="text" class="form-input" id="ip-color" placeholder="任意">
          </div>
          <div class="form-group">
            <label class="form-label">状態</label>
            <select class="form-select" id="ip-condition">
              <option>中古品 - 良い</option>
              <option>中古品 - 非常に良い</option>
              <option>中古品 - 可</option>
              <option>中古品 - ほぼ新品</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">仕入日</label>
          <input type="date" class="form-input" id="ip-date" value="${purchaseDate}">
        </div>
        <div class="form-group">
          <label class="form-label">メモ</label>
          <textarea class="form-textarea" id="ip-note" placeholder="任意"></textarea>
        </div>
        <div class="btn-group">
          <button class="btn btn-outline" style="flex:1" id="inventory-modal-cancel">キャンセル</button>
          <button class="btn btn-primary" style="flex:1" id="inventory-modal-submit">登録する</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#inventory-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#inventory-modal-submit').addEventListener('click', async () => {
      const button = overlay.querySelector('#inventory-modal-submit');
      const payload = {
        store_id: store?.store_id || '',
        store_name: storeName,
        route_id: options.routeId || '',
        purchase_date: overlay.querySelector('#ip-date').value || purchaseDate,
        product_name: overlay.querySelector('#ip-name').value.trim(),
        purchase_price: overlay.querySelector('#ip-price').value,
        expected_sale_price: overlay.querySelector('#ip-sale-price').value,
        brand: overlay.querySelector('#ip-brand').value.trim(),
        size: overlay.querySelector('#ip-size').value.trim(),
        color: overlay.querySelector('#ip-color').value.trim(),
        condition: overlay.querySelector('#ip-condition').value,
        note: overlay.querySelector('#ip-note').value.trim(),
      };
      if (!payload.product_name) { toast('商品名を入力してください'); return; }
      if (!payload.purchase_price) { toast('仕入価格を入力してください'); return; }
      button.disabled = true;
      button.textContent = '登録中...';
      try {
        const result = await API.addInventoryPurchase(payload);
        const dateKey = normalizeRouteDate_(payload.purchase_date);
        if (dateKey) {
          delete inventoryByDateCache[dateKey];
          Storage.clearViewCache('inventory_' + dateKey).catch(() => {});
        }
        overlay.remove();
        if (result && result._queued) {
          toast('オフラインのため、オンライン復帰後に登録します');
        } else {
          toast(`在庫に登録しました${result && result.row ? `（${result.row}行）` : ''}`);
        }
        if (typeof options.onSaved === 'function') options.onSaved(result || {}, payload);
      } catch (err) {
        button.disabled = false;
        button.textContent = '登録する';
        toast('登録に失敗: ' + err.message, 4000);
      }
    });
  }

  function today_() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function clamp_(value, min, max) {
    const n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function newerDateText_(current, candidate) {
    const a = normalizeRouteDate_(current);
    const b = normalizeRouteDate_(candidate);
    if (!a) return b || '';
    if (!b) return a;
    return b > a ? b : a;
  }

  function daysSinceDateText_(dateText) {
    const normalized = normalizeRouteDate_(dateText);
    if (!normalized) return 999;
    const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return 999;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.floor((todayStart - date) / 86400000));
  }

  function formatYen_(value) {
    return `${Math.round(Number(value) || 0).toLocaleString()}円`;
  }

  // ---------- 店舗追加モーダル（巡回中 & 履歴詳細共用） ----------

  function showAddStopModal(existingStoreIds, onSelect) {
    // existingStoreIds: Set of store_id already in the route
    const available = stores.filter(s => !existingStoreIds.has(s.store_id) && Number(s.lat) && Number(s.lng));
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

    // フィルタオプション生成
    const areaSet = [...new Set(storesWithMeta.map(s => s._area))];
    const areaOptions = areaSet.map(id => {
      const a = AREAS.find(x => x.id === id);
      return `<option value="${id}">${a ? a.name : id}</option>`;
    }).join('');

    const genreSet = [...new Set(storesWithMeta.map(s => s._genre))];
    const genreOptions = genreSet.map(g => `<option value="${g}">${GENRE_DISPLAY[g] || g}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal add-stop-map-modal">
        <div class="modal-title">店舗を追加</div>
        <div class="text-sm text-dim mb-8">地図のピンをタップして追加する店舗を選んでください</div>
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
        <div id="stop-add-map" class="add-stop-map"></div>
        <div id="stop-add-info" class="add-stop-map-info">追加する店舗を地図から選択してください</div>
        <div class="btn-group mt-8">
          <button class="btn btn-outline" style="flex:1" id="stop-modal-cancel">閉じる</button>
          <button class="btn btn-primary" style="flex:1" id="stop-add-confirm" disabled>追加</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const searchInput = overlay.querySelector('#stop-search');
    const areaFilter = overlay.querySelector('#stop-filter-area');
    const genreFilter = overlay.querySelector('#stop-filter-genre');
    const infoEl = overlay.querySelector('#stop-add-info');
    const confirmBtn = overlay.querySelector('#stop-add-confirm');
    const mapEl = overlay.querySelector('#stop-add-map');
    let selectedStore = null;

    const addMap = L.map(mapEl, {
      center: SENDAI_STATION,
      zoom: 11,
      zoomControl: true,
      doubleClickZoom: false,
      preferCanvas: true,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(addMap);
    const addLayer = L.layerGroup().addTo(addMap);

    function closeModal() {
      addMap.remove();
      overlay.remove();
    }

    function getFilteredStores() {
      const query = (searchInput.value || '').trim().toLowerCase();
      const areaVal = areaFilter.value;
      const genreVal = genreFilter.value;
      let filtered = storesWithMeta;
      if (query) filtered = filtered.filter(s => s.name.toLowerCase().includes(query));
      if (areaVal) filtered = filtered.filter(s => s._area === areaVal);
      if (genreVal) filtered = filtered.filter(s => s._genre === genreVal);
      return filtered;
    }

    function selectStore(store) {
      selectedStore = store;
      confirmBtn.disabled = false;
      infoEl.innerHTML = `
        <div class="add-stop-selected-name">${renderStopIconHtml(store)}${esc(store.name)}</div>
        <div class="text-sm text-dim">${esc(store._areaName)} | ${esc(store.category)} | ${formatTime(store.open_time)}-${formatTime(store.close_time)}</div>
      `;
    }

    function fitAddMap(filtered) {
      if (!filtered.length) return;
      const bounds = L.latLngBounds(filtered.map(s => [Number(s.lat), Number(s.lng)]));
      addMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 13, animate: false });
    }

    function renderMarkers({ keepView = false } = {}) {
      const filtered = getFilteredStores();
      addLayer.clearLayers();
      if (filtered.length === 0) {
        infoEl.innerHTML = '<div class="add-stop-map-empty">該当する店舗がありません</div>';
        selectedStore = null;
        confirmBtn.disabled = true;
        return;
      }

      filtered.forEach(s => {
        const isSelected = selectedStore && selectedStore.store_id === s.store_id;
        const marker = L.marker([Number(s.lat), Number(s.lng)], {
          icon: buildPinIcon(s, isSelected ? 0 : -1),
        });
        marker.bindPopup(`
          <div class="add-stop-popup">
            <div class="map-popup-name">${esc(s.name)}</div>
            <div class="map-popup-meta">${esc(s._areaName)} | ${esc(s.category)}</div>
            <button class="btn btn-primary map-popup-btn" data-add-stop-sid="${esc(s.store_id)}">この店舗を追加</button>
          </div>
        `);
        marker.on('click', () => selectStore(s));
        marker.on('popupopen', e => {
          const btn = e.popup.getElement()?.querySelector('[data-add-stop-sid]');
          if (btn) btn.addEventListener('click', () => {
            closeModal();
            onSelect(s);
          });
        });
        addLayer.addLayer(marker);
      });

      if (!keepView) fitAddMap(filtered);
      if (selectedStore && !filtered.some(s => s.store_id === selectedStore.store_id)) {
        selectedStore = null;
        confirmBtn.disabled = true;
        infoEl.textContent = '追加する店舗を地図から選択してください';
      }
    }

    requestAnimationFrame(() => {
      addMap.invalidateSize(false);
      renderMarkers();
    });

    searchInput.addEventListener('input', () => renderMarkers());
    areaFilter.addEventListener('change', () => renderMarkers());
    genreFilter.addEventListener('change', () => renderMarkers());
    confirmBtn.addEventListener('click', () => {
      if (!selectedStore) return;
      closeModal();
      onSelect(selectedStore);
    });

    overlay.querySelector('#stop-modal-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
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
    });
  }

  // ---------- 分析画面 ----------

  // 分析タブのセッションキャッシュ（TTL 5分、タブ切替では瞬時表示）
  let analyticsCache = null;
  let analyticsRankingState = { filter: 'store', query: '', chain: 'all', area: 'all', limit: 10 };
  const ANALYTICS_CACHE_TTL_MS = 60 * 60 * 1000; // 60分

  // スケルトンUIを描画する（ロード中の骨格表示）
  function renderAnalyticsSkeleton(container) {
    container.innerHTML = `
      <div class="card skeleton-card">
        <div class="skeleton-line skeleton-title"></div>
        <div class="skeleton-grid">
          <div class="skeleton-box"></div>
          <div class="skeleton-box"></div>
          <div class="skeleton-box"></div>
          <div class="skeleton-box"></div>
        </div>
      </div>
      <div class="skeleton-tabs">
        <div class="skeleton-tab"></div>
        <div class="skeleton-tab"></div>
        <div class="skeleton-tab"></div>
      </div>
      <div class="card skeleton-card">
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-short"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line skeleton-short"></div>
        <div class="skeleton-line"></div>
      </div>`;
  }

  // 分析データからHTMLを構築して container に描画する（キャッシュ・API共通）
  function renderAnalyticsContent(container, inventoryItems, routes, updatedAt = 0) {
    if (!inventoryItems || inventoryItems.length === 0) {
      container.innerHTML = `
        <div class="text-center mt-12">
          <div class="text-dim">まだデータがありません</div>
          <div class="text-sm text-dim mt-8">在庫管理シートに仕入れ品が登録されるとここに分析結果が表示されます</div>
        </div>`;
      return;
    }

    // 店舗ごとの集計（在庫管理ベース）
    const storeStats = buildStoreStats(inventoryItems, routes, stores);
    const sortedStats = Object.values(storeStats).sort((a, b) => b.totalExpectedProfit - a.totalExpectedProfit);

    let html = '';

    // タブ切り替え
    const updatedLabel = updatedAt
      ? new Date(updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '未確認';
    html += `
      <div class="analytics-updated">最終更新 ${updatedLabel}</div>
      <div class="analytics-tabs">
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
  }

  async function renderAnalytics(container) {
    setTitle('店舗分析');

    const now = Date.now();

    // セッションキャッシュがTTL内 → 即表示して終わり
    if (analyticsCache && (now - analyticsCache.ts) < ANALYTICS_CACHE_TTL_MS) {
      renderAnalyticsContent(container, analyticsCache.inventoryItems, analyticsCache.routes, analyticsCache.ts);
      return;
    }

    // IndexedDB の前回データがあれば即表示（スピナーなし）、なければスケルトン表示
    let dbCache = null;
    try {
      dbCache = await Storage.getViewCache('analytics');
    } catch (e) { /* ignore */ }

    if (dbCache && dbCache.data) {
      // セッションキャッシュにも復元（同一セッション内の再訪でAPI不要にする）
      analyticsCache = { ts: dbCache.savedAt || 0, inventoryItems: dbCache.data.inventoryItems, routes: dbCache.data.routes };
      renderAnalyticsContent(container, dbCache.data.inventoryItems, dbCache.data.routes, analyticsCache.ts);
    } else {
      renderAnalyticsSkeleton(container);
    }

    // バックグラウンドでAPIを取得して差し替え
    try {
      const d = new Date();
      const toStr = d.toISOString().slice(0, 10);
      const from = '2026-04-21'; // アプリで店舗記録を開始した日

      const analyticsData = await API.getAnalyticsData({ from, to: toStr, limit: 100 });
      const inventoryItems = analyticsData.inventoryItems || [];
      const routes = analyticsData.routes || [];

      analyticsCache = { ts: Date.now(), inventoryItems, routes };
      // IndexedDB に永続化（次回起動時の即表示に使う）
      Storage.saveViewCache('analytics', { inventoryItems, routes }).catch(() => {});

      if (Router.getCurrentView() !== 'analytics') return;
      // APIで取得した最新データで画面を差し替え
      renderAnalyticsContent(container, inventoryItems, routes, analyticsCache.ts);

    } catch (e) {
      // 前回キャッシュが表示できていればエラー上書きしない（既存画面を維持）
      if (!analyticsCache) {
        container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
      }
    }
  }

  // 在庫管理の行を店舗にマッピングして集計
  // マッチ優先度: ①L列=shopが既存店舗名と一致 → ②チェーン判定で店舗マスタに1件だけ該当 → ③チェーン単位で集約 → ④仕入先名で集約
  function buildStoreStats(inventoryItems, routes, allStores) {
    const stats = {};

    function ensureStore(storeId) {
      if (!stats[storeId]) {
        const s = allStores.find(x => x.store_id === storeId);
        stats[storeId] = {
          store_id: storeId,
          name: s ? s.name : storeId,
          category: s ? s.category : '',
          chain: s ? getChain(s) : '',
          area: s ? getArea(s) : '',
          kind: 'store',
          totalExpectedProfit: 0,
          totalExpectedSale: 0,
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

    function ensureVirtual(key, displayName, kind) {
      if (!stats[key]) {
        stats[key] = {
          store_id: key,
          name: displayName,
          category: '',
          chain: kind === 'chain' ? displayName : '',
          area: '',
          kind,
          totalExpectedProfit: 0,
          totalExpectedSale: 0,
          totalPurchaseAmount: 0,
          itemCount: 0,
          visitCount: 0,
          totalStayMin: 0,
          items: [],
          genres: {},
        };
      }
      return stats[key];
    }

    // chainごとの店舗マスタ内件数を事前計算
    const chainToStores = {};
    allStores.forEach(s => {
      const c = getChain(s);
      if (!c) return;
      (chainToStores[c] = chainToStores[c] || []).push(s);
    });

    (inventoryItems || []).forEach(it => {
      const profit = Number(it.expected_profit) || 0;
      const sale = Number(it.expected_sale_price) || 0;
      const cost = Number(it.purchase_price) || 0;

      let target = null;

      // ① L列の店舗名で一致
      if (it.shop) {
        const hit = allStores.find(s => s.name === it.shop);
        if (hit) target = ensureStore(hit.store_id);
      }

      // ② チェーン判定で店舗マスタに1件だけ該当
      if (!target) {
        const supplier = it.supplier || it.alias || '';
        const chain = supplier ? getChain({ name: supplier }) : '';
        if (chain) {
          const candidates = chainToStores[chain] || [];
          if (candidates.length === 1) {
            target = ensureStore(candidates[0].store_id);
          } else if (candidates.length > 1) {
            // ③ チェーン単位で集約（どの店舗か特定不能）
            target = ensureVirtual('chain:' + chain, chain + '（店舗未確定）', 'chain');
          }
        }
      }

      // ④ 仕入先名で集約（チェーン判定できない＝ルート外・新店舗・表記ゆれ）
      if (!target) {
        const supplier = it.supplier || it.alias || '不明';
        target = ensureVirtual('supplier:' + supplier, supplier, 'supplier');
      }

      target.totalExpectedProfit += profit;
      target.totalExpectedSale += sale;
      target.totalPurchaseAmount += cost;
      target.itemCount += 1;
      target.items.push(it);

      const genre = guessGenre(it.product_name);
      target.genres[genre] = (target.genres[genre] || 0) + profit;
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

    const unresolvedCount = sortedStats.filter(stat => stat.kind !== 'store').length;
    const chainOptions = [...new Set(sortedStats.filter(stat => stat.kind === 'store' && stat.chain).map(stat => stat.chain))]
      .sort((a, b) => a.localeCompare(b, 'ja'));
    const areaOptions = AREA_DISPLAY_ORDER
      .filter(areaId => sortedStats.some(stat => stat.kind === 'store' && stat.area === areaId))
      .map(areaId => ({ id: areaId, name: AREAS.find(area => area.id === areaId)?.name || areaId }));
    const query = analyticsRankingState.query.toLowerCase();
    const filtered = sortedStats.filter(stat => {
      if (analyticsRankingState.filter === 'store' && stat.kind !== 'store') return false;
      if (analyticsRankingState.filter === 'unresolved' && stat.kind === 'store') return false;
      if (analyticsRankingState.chain !== 'all' && stat.chain !== analyticsRankingState.chain) return false;
      if (analyticsRankingState.area !== 'all' && stat.area !== analyticsRankingState.area) return false;
      if (query && !`${stat.name} ${stat.chain}`.toLowerCase().includes(query)) return false;
      return true;
    });
    const visible = filtered.slice(0, analyticsRankingState.limit);
    const topProfit = visible.length ? visible[0].totalExpectedProfit : 0;
    let html = `
      <div class="analytics-ranking-tools">
        <div class="segmented-control" role="group" aria-label="ランキング対象">
          <button type="button" data-ranking-filter="store" class="${analyticsRankingState.filter === 'store' ? 'active' : ''}">実店舗</button>
          <button type="button" data-ranking-filter="unresolved" class="${analyticsRankingState.filter === 'unresolved' ? 'active' : ''}">未確定 ${unresolvedCount}</button>
          <button type="button" data-ranking-filter="all" class="${analyticsRankingState.filter === 'all' ? 'active' : ''}">すべて</button>
        </div>
        <input class="form-input" id="analytics-ranking-search" type="search" value="${esc(analyticsRankingState.query)}" placeholder="店舗名・チェーンを検索" aria-label="店舗名・チェーンを検索">
        <div class="analytics-ranking-selects">
          <select class="form-select" id="analytics-chain-filter" aria-label="チェーンで絞り込み">
            <option value="all">全チェーン</option>
            ${chainOptions.map(chain => `<option value="${esc(chain)}" ${analyticsRankingState.chain === chain ? 'selected' : ''}>${esc(chain)}</option>`).join('')}
          </select>
          <select class="form-select" id="analytics-area-filter" aria-label="地域で絞り込み">
            <option value="all">全地域</option>
            ${areaOptions.map(area => `<option value="${esc(area.id)}" ${analyticsRankingState.area === area.id ? 'selected' : ''}>${esc(area.name)}</option>`).join('')}
          </select>
        </div>
      </div>`;

    if (!visible.length) html += '<div class="text-center text-dim mt-12">条件に合うデータがありません</div>';
    visible.forEach((st, i) => {
      const profitPerVisit = st.visitCount > 0 ? Math.round(st.totalExpectedProfit / st.visitCount) : 0;
      const barWidth = topProfit > 0
        ? Math.max(5, Math.round(st.totalExpectedProfit / topProfit * 100))
        : 0;
      const profitColor = st.totalExpectedProfit >= 0 ? 'var(--success)' : 'var(--accent)';
      const label = st.kind === 'chain' ? '<span class="badge" style="background:#fff7e6;color:#d35400">店舗未確定</span>'
                  : st.kind === 'supplier' ? '<span class="badge" style="background:#fef3c7;color:#92400e">ルート外</span>'
                  : '';
      const visitInfo = st.kind === 'store'
        ? `${st.visitCount}回訪問${profitPerVisit > 0 ? ` / 1回あたり ${formatYen_(profitPerVisit)}` : ''}`
        : '';

      html += `
        <div class="card mt-8">
          <div class="flex-between">
            <span><span class="rank-badge">${i + 1}</span> <b>${esc(st.name)}</b> ${label}</span>
            <span style="color:${profitColor};font-weight:bold">${formatYen_(st.totalExpectedProfit)}</span>
          </div>
          <div style="background:var(--border);border-radius:4px;height:6px;margin:6px 0">
            <div style="background:${profitColor};border-radius:4px;height:6px;width:${barWidth}%"></div>
          </div>
          <div class="text-sm text-dim">
            仕入 ${formatYen_(st.totalPurchaseAmount)} → 販売予定 ${formatYen_(st.totalExpectedSale)} / ${st.itemCount}点
            ${visitInfo ? ' / ' + visitInfo : ''}
          </div>
        </div>`;
    });
    if (filtered.length > visible.length) {
      html += `<button class="btn btn-outline btn-block mt-12" id="analytics-show-more">さらに${Math.min(10, filtered.length - visible.length)}件表示</button>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('[data-ranking-filter]').forEach(button => {
      button.addEventListener('click', () => {
        analyticsRankingState.filter = button.dataset.rankingFilter;
        analyticsRankingState.limit = 10;
        renderRankingTab(container, sortedStats);
      });
    });
    document.getElementById('analytics-ranking-search')?.addEventListener('input', event => {
      analyticsRankingState.query = event.target.value;
      analyticsRankingState.limit = 10;
      renderRankingTab(container, sortedStats);
      document.getElementById('analytics-ranking-search')?.focus();
    });
    document.getElementById('analytics-chain-filter')?.addEventListener('change', event => {
      analyticsRankingState.chain = event.target.value;
      analyticsRankingState.limit = 10;
      renderRankingTab(container, sortedStats);
    });
    document.getElementById('analytics-area-filter')?.addEventListener('change', event => {
      analyticsRankingState.area = event.target.value;
      analyticsRankingState.limit = 10;
      renderRankingTab(container, sortedStats);
    });
    document.getElementById('analytics-show-more')?.addEventListener('click', () => {
      analyticsRankingState.limit += 10;
      renderRankingTab(container, sortedStats);
    });
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
            <span style="font-weight:bold">${formatYen_(ppv)}/回</span>
          </div>
          <div class="text-sm text-dim">${st.visitCount}回訪問 / 合計 ${formatYen_(st.totalExpectedProfit)}</div>
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
              <span style="font-weight:bold">${formatYen_(pph)}/時</span>
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
      container.innerHTML = '<div class="text-center text-dim mt-12">在庫管理データがありません</div>';
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
            <span style="font-weight:bold">${formatYen_(profit)}</span>
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
              `<span class="badge" style="margin-right:4px">${esc(g)} ${formatYen_(p)}</span>`
            ).join('')}
          </div>
        </div>`;
    });

    container.innerHTML = html;
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
          <input type="text" class="form-input" id="sf-open" value="${formatTime(s.open_time) || '10:00'}"></div>
        <div class="form-group" style="flex:1"><label class="form-label">閉店</label>
          <input type="text" class="form-input" id="sf-close" value="${formatTime(s.close_time) || '20:00'}"></div>
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
  const stopsCacheByRouteId = {}; // route_id → stops[]、セッションキャッシュ
  let historyApiCache = null;       // { ts, routes } — 履歴一覧の APIレスポンスキャッシュ
  const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000; // 60分

  function invalidateHistoryApiCache() {
    historyApiCache = null;
    analyticsCache = null; // 履歴更新は分析の集計にも影響するため一緒に無効化
    // IndexedDB キャッシュも無効化
    Storage.clearViewCache('history').catch(() => {});
    Storage.clearViewCache('analytics').catch(() => {});
  }

  function isValidRouteDate_(dateText) {
    const s = normalizeRouteDate_(dateText);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  function getAreaName_(areaId) {
    return AREAS.find(a => a.id === areaId)?.name || 'その他';
  }

  function getStoreForStop_(stop) {
    if (!stop) return null;
    const stopId = String(stop.store_id || '');
    const stopName = String(stop.store_name || stop.name || '');
    return stores.find(s => String(s.store_id || '') === stopId)
      || stores.find(s => String(s.name || '') === stopName)
      || null;
  }

  function getStopAreaId_(stop) {
    const store = getStoreForStop_(stop);
    const source = store || stop;
    const lat = Number(source?.lat);
    const lng = Number(source?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    return getArea(source);
  }

  function isRouteAreaVisitStop_(stop) {
    return !!stop && String(stop.status || '').trim().toLowerCase() !== 'skipped';
  }

  function getRouteAreaNames_(route) {
    const stops = route?.stops || [];
    const targetStops = stops.filter(isRouteAreaVisitStop_);
    const areaStops = targetStops.length ? targetStops : stops;
    const seen = new Set();
    const names = [];

    areaStops.forEach(stop => {
      const areaId = getStopAreaId_(stop);
      if (!areaId || seen.has(areaId)) return;
      seen.add(areaId);
      names.push(getAreaName_(areaId));
    });

    return names;
  }

  function renderHistoryAreas_(route) {
    const areaNames = getRouteAreaNames_(route);
    if (!areaNames.length) return '<div class="history-areas history-areas-empty">エリア: 未取得</div>';
    const visible = areaNames.slice(0, 3);
    const hidden = areaNames.slice(3);
    return `
      <div class="history-areas" aria-label="巡回エリア">
        ${visible.map(name => `<span class="history-area-badge">${esc(name)}</span>`).join('')}
        ${hidden.map(name => `<span class="history-area-badge history-area-hidden" hidden>${esc(name)}</span>`).join('')}
        ${hidden.length > 0 ? `<button type="button" class="history-area-badge history-area-more" data-action="toggle-history-areas" data-hidden-count="${hidden.length}" aria-expanded="false" aria-label="すべての巡回エリアを表示">+${hidden.length}</button>` : ''}
      </div>`;
  }

  function formatHistoryProfitYen_(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return (Math.round(num / 100) * 100).toLocaleString();
  }

  // 履歴一覧をルートの配列から描画して container に書き込む
  function renderHistoryContent(container, routes) {
    // キャッシュ経由でも必ず日付降順（直近が上）
    routes = [...routes].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    historyCache = routes;
    let html = `
      <div class="card mb-12" style="background:var(--bg-card);padding:12px 16px;">
        <div class="flex-between" style="align-items:center">
          <span class="text-sm" style="color:var(--text-dim)">利益データ（毎朝6時に自動更新）</span>
          <button class="btn btn-sm btn-outline" id="btn-import-profit">今すぐ更新</button>
        </div>
      </div>`;
    if (routes.length === 0) {
      html += '<div class="text-center text-dim mt-12">巡回履歴がありません</div>';
    } else {
      routes.forEach((r, idx) => {
        const dateStr = formatRouteDate_(r.date);
        html += `
          <article class="history-item">
            <button class="history-open" type="button" data-idx="${idx}" aria-label="${esc(dateStr)}の巡回履歴を開く">
              <span class="flex-between">
                <span class="history-date">${dateStr}</span>
                <span class="history-card-side">
                  <span class="badge badge-primary">${r.store_count || 0}店舗</span>
                  <span class="history-detail-chevron" aria-hidden="true">›</span>
                </span>
              </span>
            </button>
            ${renderHistoryAreas_(r)}
            <button class="history-open history-open-meta" type="button" data-idx="${idx}" aria-label="${esc(dateStr)}の巡回履歴を開く">
              <span class="history-meta">
                距離: ${r.total_distance_km || 0}km |
                仕入れ: ${Number(r.total_purchase || 0).toLocaleString()}円 (${r.total_items || 0}点)
              </span>
              ${Number(r.expected_profit || 0) > 0
                ? `<span class="history-profit">見込み利益: ${formatHistoryProfitYen_(r.expected_profit)}円</span>`
                : ''
              }
              ${r.aggregation_warning ? `<span class="history-warning">${esc(r.aggregation_warning)}</span>` : ''}
              ${r.note ? `<span class="text-sm mt-8">${esc(r.note)}</span>` : ''}
            </button>
          </article>`;
      });
    }
    container.innerHTML = html;
    container.querySelectorAll('.history-open').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.idx);
        Router.navigate('history-detail', { route: historyCache[idx] });
      });
    });

    container.querySelectorAll('[data-action="toggle-history-areas"]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const areaWrap = btn.closest('.history-areas');
        if (!areaWrap) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        areaWrap.querySelectorAll('.history-area-hidden').forEach(badge => {
          badge.hidden = expanded;
        });
        btn.setAttribute('aria-expanded', String(!expanded));
        btn.textContent = expanded ? `+${btn.dataset.hiddenCount || ''}` : '閉じる';
        btn.setAttribute('aria-label', expanded ? 'すべての巡回エリアを表示' : '巡回エリアを折りたたむ');
      });
    });

    document.getElementById('btn-import-profit')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-import-profit');
      if (btn) { btn.textContent = '更新中...'; btn.disabled = true; }
      try {
        await API.get('importRouteProfit');
        invalidateHistoryCache();
        toast('利益データを更新しました');
      } catch (e) {
        toast('更新に失敗しました');
      } finally {
        if (btn) { btn.textContent = '今すぐ更新'; btn.disabled = false; }
      }
    });

    // 一覧表示後にバックグラウンドで詳細データを先読み（タップ時のロード消去）
    prefetchHistoryDetails_(routes);
  }

  // 履歴詳細用の stops・在庫を裏で先読みして IDB/セッションに蓄積する
  async function prefetchHistoryDetails_(routes) {
    const recent = routes.slice(0, 5);

    // stops は getRouteHistory の include_stops:true で既に埋め込み済み → セッションキャッシュへ転写
    recent.forEach(route => {
      if (route.stops && !stopsCacheByRouteId[route.route_id]) {
        stopsCacheByRouteId[route.route_id] = route.stops;
        Storage.saveViewCache('stops_' + route.route_id, { data: route.stops }).catch(() => {});
      }
    });

    // Phase1: 在庫データを IDB → セッションキャッシュへ一括ロード（GAS不要）
    await Promise.all(recent.map(async route => {
      const date = normalizeRouteDate_(route.date);
      if (date && !inventoryByDateCache[date]) {
        try {
          const rec = await Storage.getViewCache('inventory_' + date);
          if (rec && rec.data && rec.data.length > 0) inventoryByDateCache[date] = rec.data;
        } catch (e) {}
      }
    }));

    // Phase2: IDB ミス分の在庫を GAS から並列取得（stops は不要になったので在庫のみ）
    await Promise.all(recent.map(async route => {
      const date = normalizeRouteDate_(route.date);
      if (!date || inventoryByDateCache[date]) return;
      try {
        const items = await API.getInventoryPurchases({ from: date, to: date });
        if (items && items.length > 0) {
          inventoryByDateCache[date] = items;
          Storage.saveViewCache('inventory_' + date, { data: items }).catch(() => {});
        }
      } catch (e) {}
    }));
  }

  async function renderHistory(container) {
    setTitle('履歴・分析');

    const now = Date.now();

    // セッションキャッシュがTTL内 → 即描画
    if (historyApiCache && (now - historyApiCache.ts) < HISTORY_CACHE_TTL_MS) {
      historyCache = historyApiCache.routes;
      renderHistoryContent(container, historyApiCache.routes);
      return;
    }

    // IndexedDB の前回データがあれば即表示（スピナーなし）
    let dbCache = null;
    try {
      dbCache = await Storage.getViewCache('history');
    } catch (e) { /* ignore */ }

    if (dbCache && dbCache.data) {
      historyCache = dbCache.data;
      renderHistoryContent(container, dbCache.data);
    } else {
      container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    // バックグラウンドでAPIを取得して差し替え
    try {
      // 一覧表示には stops 不要（詳細画面に入った時に個別取得）
      const routes = await API.getRouteHistory({ limit: 20, include_stops: 'true' });
      if (Router.getCurrentView() !== 'history') return;
      historyApiCache = { ts: Date.now(), routes };
      historyCache = routes;
      // IndexedDB に永続化
      Storage.saveViewCache('history', routes).catch(() => {});
      renderHistoryContent(container, routes);
    } catch (e) {
      if (Router.getCurrentView() !== 'history') return;
      // 前回キャッシュ表示中であればエラー上書きしない
      if (!dbCache) {
        container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
      }
    }
  }

  // 日付単位の在庫仕入れ品キャッシュ（表示は速く、裏で最新化する）
  const inventoryByDateCache = {};
  const inventoryRefreshInFlightByDate = {};

  // 在庫管理シートの仕入れ品を取得し、巡回ルートの訪問店舗に紐付けて表示
  async function loadInventoryForRoute(route, options = {}) {
    const section = document.getElementById('inventory-section');
    if (!section) return;
    const date = normalizeRouteDate_(route.date);
    if (!date) return;
    const backgroundRefresh = options.backgroundRefresh !== false;

    let items = inventoryByDateCache[date];
    if (!items) {
      // IDB から試みる
      try {
        const idbRec = await Storage.getViewCache('inventory_' + date);
        if (idbRec && idbRec.data && idbRec.data.length > 0) {
          items = idbRec.data;
          inventoryByDateCache[date] = items;
        }
      } catch (e) {}
    }
    if (items) {
      renderInventoryForRoute(route, items);
      if (backgroundRefresh) {
        refreshInventoryForRoute(route, date, { showErrors: true });
      }
      return;
    }

    if (!items) {
      section.innerHTML = `
        <div class="card-title mt-12">在庫管理からの仕入れ品</div>
        <div class="card text-dim">読み込み中...</div>`;
      try {
        items = await fetchInventoryForDate_(date);
      } catch (e) {
        renderInventoryFetchError_(route, e.message, false);
        return;
      }
    }

    renderInventoryForRoute(route, items);
  }

  async function fetchInventoryForDate_(date) {
    const items = await API.getInventoryPurchases({ from: date, to: date });
    const list = Array.isArray(items) ? items : [];
    if (list.length > 0) {
      inventoryByDateCache[date] = list;
      Storage.saveViewCache('inventory_' + date, { data: list }).catch(() => {});
    } else {
      delete inventoryByDateCache[date];
      Storage.clearViewCache('inventory_' + date).catch(() => {});
    }
    return list;
  }

  async function refreshInventoryForRoute(route, date, { showErrors = false } = {}) {
    if (inventoryRefreshInFlightByDate[date]) return;
    inventoryRefreshInFlightByDate[date] = true;
    try {
      const latest = await fetchInventoryForDate_(date);
      if (Router.getCurrentView() === 'history-detail') {
        renderInventoryForRoute(route, latest);
      }
    } catch (e) {
      if (showErrors && Router.getCurrentView() === 'history-detail') {
        renderInventoryFetchError_(route, e.message, true);
      }
    } finally {
      delete inventoryRefreshInFlightByDate[date];
    }
  }

  function renderInventoryFetchError_(route, message, hasCachedContent) {
    const section = document.getElementById('inventory-section');
    if (!section) return;
    const alertHtml = `
      <div class="inventory-refresh-alert">
        <span>${hasCachedContent ? '最新確認に失敗しました' : '読み込みに失敗しました'}: ${esc(message)}</span>
        <button class="inventory-retry-btn" id="btn-inventory-retry">再試行</button>
      </div>`;
    if (hasCachedContent) {
      section.querySelector('.inventory-refresh-alert')?.remove();
      section.insertAdjacentHTML('beforeend', alertHtml);
    } else {
      section.innerHTML = `
        <div class="card-title mt-12">在庫管理からの仕入れ品</div>
        <div class="card text-dim">読み込み失敗</div>
        ${alertHtml}`;
    }
    document.getElementById('btn-inventory-retry')?.addEventListener('click', () => {
      const date = normalizeRouteDate_(route.date);
      if (hasCachedContent && date) {
        refreshInventoryForRoute(route, date, { showErrors: true });
      } else {
        loadInventoryForRoute(route, { backgroundRefresh: false });
      }
    });
  }

  function renderInventoryForRoute(route, items) {
    const section = document.getElementById('inventory-section');
    if (!section) return;

    // 訪問店舗（この巡回）
    // status=visited に限らずスキップ以外は候補に含める（到着/出発を押さずに終えた場合もカバー）
    const visitedStops = (route.stops || []).filter(s => s.status !== 'skipped');
    const visitedStores = visitedStops.map(s => {
      const st = stores.find(x => x.store_id === s.store_id);
      return {
        store_id: s.store_id,
        name: (st && st.name) || s.store_id,
        chain: st ? getChain(st) : '',
      };
    });

    // 在庫管理の各行をチェーンでマッチング
    const chainToStores = {};
    visitedStores.forEach(vs => {
      if (!vs.chain) return;
      (chainToStores[vs.chain] = chainToStores[vs.chain] || []).push(vs);
    });

    // 店舗別グルーピング + 曖昧/未マッチ
    const byStore = {};   // store_id → items[]
    const ambiguous = []; // 複数候補
    const unrelated = []; // チェーン一致するstoreがこのルートに無い

    (items || []).forEach(it => {
      const supplier = it.supplier || it.alias || '';
      const chain = supplier ? getChain({ name: supplier }) : '';
      const candidates = chain ? (chainToStores[chain] || []) : [];
      // 既に店名が書き込まれていてルート内の店と一致するならそこに紐付け
      if (it.shop) {
        const hit = visitedStores.find(vs => vs.name === it.shop);
        if (hit) {
          (byStore[hit.store_id] = byStore[hit.store_id] || []).push(it);
          return;
        }
      }
      if (candidates.length === 1) {
        (byStore[candidates[0].store_id] = byStore[candidates[0].store_id] || []).push(it);
        // L列が空の場合はGASに自動書き戻し（分析タブで店舗未確定になるのを防ぐ）
        if (!it.shop && it.row) {
          it.shop = candidates[0].name;
          syncWrite(API.updateInventoryShop({ row: it.row, shop: candidates[0].name }), '店舗の自動紐付け');
        }
      } else if (candidates.length > 1) {
        ambiguous.push({ item: it, candidates });
      } else {
        unrelated.push(it);
      }
    });

    // レンダリング
    let html = '<div class="card-title mt-12">在庫管理からの仕入れ品</div>';
    const totalRelated = Object.values(byStore).reduce((n, arr) => n + arr.length, 0) + ambiguous.length;
    if (totalRelated === 0 && unrelated.length === 0) {
      html += `<div class="card text-dim">この日の仕入れ品はありません</div>`;
      section.innerHTML = html;
      return;
    }

    // この巡回の合計（店舗資産化の中核指標を一目でわかる位置に）
    const relatedItems = Object.values(byStore).flat().concat(ambiguous.map(entry => entry.item));
    const totalProfit = relatedItems.reduce((n, x) => n + (Number(x.expected_profit) || 0), 0);
    const totalCost = relatedItems.reduce((n, x) => n + (Number(x.purchase_price) || 0), 0);
    const profitColor = totalProfit >= 0 ? 'var(--success)' : 'var(--accent)';
    html += `
      <div class="card" style="background:var(--primary-light)">
        <div class="summary-grid">
          <div class="summary-item"><div class="value" style="color:${profitColor}">${formatYen_(totalProfit)}</div><div class="label">見込み利益</div></div>
          <div class="summary-item"><div class="value">${formatYen_(totalCost)}</div><div class="label">仕入合計</div></div>
          <div class="summary-item"><div class="value">${relatedItems.length}</div><div class="label">点数</div></div>
        </div>
      </div>`;

    // 訪問店舗別（仕入額と見込み利益を集計表示。見込み利益は店舗資産化の中核指標）
    visitedStores.forEach(vs => {
      const arr = byStore[vs.store_id] || [];
      if (arr.length === 0) return;
      const sumCost = arr.reduce((n, x) => n + (Number(x.purchase_price) || 0), 0);
      const sumProfit = arr.reduce((n, x) => n + (Number(x.expected_profit) || 0), 0);
      const profitColor = sumProfit >= 0 ? 'var(--success)' : 'var(--accent)';
      html += `
        <div class="card mt-8">
          <div class="flex-between">
            <div><b>${esc(vs.name)}</b> <span class="badge badge-success">${arr.length}点</span></div>
            <div style="text-align:right">
              <div class="text-sm text-dim">仕入 ${formatYen_(sumCost)}</div>
              <div style="color:${profitColor};font-weight:bold">見込利益 ${formatYen_(sumProfit)}</div>
            </div>
          </div>`;
      arr.forEach(it => {
        html += inventoryItemLine_(it);
      });
      html += `</div>`;
    });

    // 曖昧（複数候補）
    if (ambiguous.length > 0) {
      const duplicateCounts = {};
      ambiguous.forEach(({ item }) => {
        const key = String(item.product_name || '').trim();
        if (key) duplicateCounts[key] = (duplicateCounts[key] || 0) + 1;
      });
      const ambiguousGroups = new Map();
      ambiguous.forEach(entry => {
        const supplier = String(entry.item.supplier || entry.item.alias || '仕入先未記入').trim();
        const candidateKey = entry.candidates.map(candidate => candidate.name).join('|');
        const key = `${supplier}::${candidateKey}`;
        if (!ambiguousGroups.has(key)) ambiguousGroups.set(key, { supplier, entries: [], candidates: entry.candidates });
        ambiguousGroups.get(key).entries.push(entry);
      });
      html += `<div class="card mt-8" style="background:#fff7e6;border:1px solid #ffb74d">
        <div class="card-title" style="color:var(--accent)">⚠️ 店舗未確定（${ambiguous.length}件）</div>
        <div class="text-sm text-dim mb-8">同じ日に同チェーンの複数店舗を訪問しました。仕入先ごとにまとめて設定できます。</div>`;
      ambiguousGroups.forEach(group => {
        const rows = group.entries.map(entry => Number(entry.item.row)).filter(Boolean);
        const options = ['<option value="">-- 一括設定する店舗 --</option>']
          .concat(group.candidates.map(candidate => `<option value="${esc(candidate.name)}">${esc(candidate.name)}</option>`))
          .join('');
        html += `<div class="ambiguous-bulk">
          <div><b>${esc(group.supplier)}</b> <span class="badge badge-primary">${rows.length}件</span></div>
          <select class="form-select js-ambig-bulk" data-rows="${rows.join(',')}">${options}</select>
        </div>`;
      });
      ambiguous.forEach((amb, idx) => {
        const it = amb.item;
        const cost = Number(it.purchase_price) || 0;
        const profit = Number(it.expected_profit) || 0;
        const pc = profit >= 0 ? 'var(--success)' : 'var(--accent)';
        const options = ['<option value="">-- 選択 --</option>']
          .concat(amb.candidates.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`))
          .join('');
        html += `
          <div class="card" data-ambig-idx="${idx}">
            <div class="text-sm text-dim">仕入先: ${esc(it.supplier || it.alias || '')}</div>
            <div style="font-weight:600;margin:4px 0">${esc(it.product_name || '(商品名なし)')}
              ${duplicateCounts[String(it.product_name || '').trim()] > 1 ? `<span class="badge badge-warning">同一商品 ${duplicateCounts[String(it.product_name || '').trim()]}件</span>` : ''}
            </div>
            <div class="text-sm">
              <span style="color:${pc};font-weight:bold">見込利益 ${formatYen_(profit)}</span>
              <span class="text-dim" style="margin-left:8px">仕入 ${formatYen_(cost)}</span>
            </div>
            <select class="form-select mt-8 js-ambig-sel" data-row="${it.row}">${options}</select>
          </div>`;
      });
      html += `</div>`;
    }

    // ルート外（チェーン判定で一致する訪問店舗が無かった仕入れ）
    // → 訪問店舗を手動で選べるようにし、在庫管理シートのL列に書き戻す
    if (unrelated.length > 0) {
      const allStoreOptions = ['<option value="">-- 店舗を選択 --</option>']
        .concat(visitedStores.map(vs => `<option value="${esc(vs.name)}">${esc(vs.name)}</option>`))
        .join('');
      html += `<details class="card mt-8" open><summary class="text-dim">ルート外の仕入れ（${unrelated.length}件） — 手動で紐付け可能</summary>
        <div class="text-sm text-dim mb-8 mt-8">仕入先の表記でチェーン判定できなかった商品です。正しい訪問店舗を選ぶと在庫管理シートに店舗名が書き戻されます。</div>`;
      unrelated.forEach((it, idx) => {
        const cost = Number(it.purchase_price) || 0;
        const sale = Number(it.expected_sale_price) || 0;
        const profit = Number(it.expected_profit) || 0;
        const pc = profit >= 0 ? 'var(--success)' : 'var(--accent)';
        html += `<div class="card" data-unrel-idx="${idx}">
          <div class="text-sm text-dim">仕入先: ${esc(it.supplier || it.alias || '(未記入)')}</div>
          <div style="font-weight:600;margin:4px 0">${esc(it.product_name || '(商品名なし)')}</div>
          <div class="text-sm">
            <span style="color:${pc};font-weight:bold">見込利益 ${profit.toLocaleString()}円</span>
            <span class="text-dim" style="margin-left:8px">仕入 ${cost.toLocaleString()}円 → 販売予定 ${sale.toLocaleString()}円</span>
          </div>
          <select class="form-select mt-8 js-unrel-sel" data-row="${it.row}">${allStoreOptions}</select>
        </div>`;
      });
      html += `</details>`;
    }

    section.innerHTML = html;

    // キャッシュ内のitemのshopを即時更新（サーバ書き込み後の再レンダリングで最新状態に反映するため）
    const updateCachedShop = (row, shop) => {
      const date = normalizeRouteDate_(route.date);
      const cached = inventoryByDateCache[date];
      if (!cached) return;
      const hit = cached.find(x => Number(x.row) === Number(row));
      if (hit) {
        hit.shop = shop;
        Storage.saveViewCache('inventory_' + date, { data: cached }).catch(() => {});
      }
    };

    section.querySelectorAll('.js-ambig-bulk').forEach(select => {
      select.addEventListener('change', async () => {
        const shop = select.value;
        const rows = String(select.dataset.rows || '').split(',').map(Number).filter(Boolean);
        if (!shop || !rows.length) return;
        select.disabled = true;
        try {
          await API.bulkUpdateInventoryShop({ items: rows.map(row => ({ row, shop })) });
          rows.forEach(row => updateCachedShop(row, shop));
          toast(`${shop} に${rows.length}件を一括設定しました`);
          loadInventoryForRoute(route, { backgroundRefresh: false });
        } catch (error) {
          select.disabled = false;
          toast(`一括設定に失敗しました: ${error.message}`, 5000);
        }
      });
    });

    // 曖昧選択のイベント
    section.querySelectorAll('.js-ambig-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const row = Number(sel.dataset.row);
        const shop = sel.value;
        if (!row || !shop) return;
        sel.disabled = true;
        try {
          await API.updateInventoryShop({ row, shop });
          toast(`${shop} に確定しました`);
          updateCachedShop(row, shop);
          loadInventoryForRoute(route, { backgroundRefresh: false });
        } catch (e) {
          sel.disabled = false;
          toast('保存失敗: ' + e.message);
        }
      });
    });

    // ルート外の手動紐付けイベント（チェーン判定を跨いで訪問店舗に割り当て可能）
    section.querySelectorAll('.js-unrel-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const row = Number(sel.dataset.row);
        const shop = sel.value;
        if (!row || !shop) return;
        sel.disabled = true;
        try {
          await API.updateInventoryShop({ row, shop });
          toast(`${shop} に紐付けました`);
          updateCachedShop(row, shop);
          loadInventoryForRoute(route, { backgroundRefresh: false });
        } catch (e) {
          sel.disabled = false;
          toast('保存失敗: ' + e.message);
        }
      });
    });
  }

  function inventoryItemLine_(it) {
    const name = it.product_name || '(商品名なし)';
    const shortName = name.length > 40 ? name.substring(0, 40) + '...' : name;
    const cost = Number(it.purchase_price) || 0;
    const sale = Number(it.expected_sale_price) || 0;
    const profit = Number(it.expected_profit) || 0;
    const profitColor = profit >= 0 ? 'var(--success)' : 'var(--accent)';
    const hasSale = sale > 0 || profit !== 0;
    return `<div class="text-sm" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div class="flex-between">
        <span>${esc(shortName)}</span>
        ${hasSale
          ? `<span style="white-space:nowrap;margin-left:8px;color:${profitColor};font-weight:bold">利 ${profit.toLocaleString()}円</span>`
          : `<span style="white-space:nowrap;margin-left:8px">¥${cost.toLocaleString()}</span>`}
      </div>
      ${hasSale
        ? `<div class="text-dim" style="font-size:12px">仕入 ${cost.toLocaleString()}円 → 販売予定 ${sale.toLocaleString()}円</div>`
        : ''}
    </div>`;
  }

  function normalizeRouteDate_(d) {
    if (!d) return '';
    if (d instanceof Date) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    const s = String(d).trim();
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return s;
  }

  // Date オブジェクト生成を避け、タイムゾーン依存なしで日本語表示
  function formatRouteDate_(d) {
    const s = normalizeRouteDate_(d); // "YYYY-MM-DD"
    if (!s) return '不明';
    const [y, mo, day] = s.split('-');
    return `${y}/${Number(mo)}/${Number(day)}`;
  }

  function formatCorrectionYen_(value) {
    return `${Number(value || 0).toLocaleString()}円`;
  }

  function routeCorrectionSeverityLabel_(severity) {
    if (severity === 'high') return '要修正';
    if (severity === 'medium') return '要確認';
    if (severity === 'low') return '確認';
    return 'メモ';
  }

  function renderRouteCorrectionSuggestions_(result) {
    const wrap = document.getElementById('route-correction-result');
    if (!wrap) return;
    const items = (result && result.suggestions) || [];
    if (!items.length) {
      wrap.innerHTML = `
        <div class="correction-empty">
          直近${result?.checked_routes || 0}件に、自動補正候補はありません。
        </div>`;
      return;
    }

    let html = `
      <div class="correction-summary">
        直近${result.checked_routes || 0}件中、${result.suggestion_routes || items.length}件に確認候補があります。
      </div>`;
    items.forEach(route => {
      html += `
        <div class="correction-card" data-route-id="${esc(route.route_id)}">
          <div class="flex-between">
            <div>
              <div class="correction-date">${formatRouteDate_(route.date)} の履歴</div>
              <div class="text-sm text-dim">${route.store_count || 0}店舗 / 仕入れ ${formatCorrectionYen_(route.total_purchase)} (${route.total_items || 0}点)</div>
            </div>
            <button class="btn btn-sm btn-outline js-open-correction-route" data-route-id="${esc(route.route_id)}">詳細</button>
          </div>`;
      route.suggestions.forEach((s, idx) => {
        const badge = routeCorrectionSeverityLabel_(s.severity);
        html += `
          <div class="correction-suggestion">
            <div class="correction-message"><span class="correction-badge">${badge}</span>${esc(s.message)}</div>`;
        if (s.type === 'date_shift') {
          html += `
            <div class="text-sm text-dim">候補日: ${formatRouteDate_(s.new_date)} / 仕入れ ${formatCorrectionYen_(s.inventory_amount)} (${s.inventory_count || 0}点)</div>
            <button class="btn btn-sm btn-primary js-apply-route-date" data-route-id="${esc(route.route_id)}" data-new-date="${esc(s.new_date)}">この日付に変更</button>`;
        } else if (s.type === 'recalc_purchase') {
          html += `
            <div class="text-sm text-dim">在庫管理: ${formatCorrectionYen_(s.inventory_amount)} (${s.inventory_count || 0}点)</div>
            <button class="btn btn-sm btn-outline js-recalc-route" data-route-id="${esc(route.route_id)}">仕入れ集計を再計算</button>`;
        } else if (s.type === 'missing_shop') {
          html += `
            <button class="btn btn-sm btn-outline js-open-correction-route" data-route-id="${esc(route.route_id)}">詳細で店舗を紐付ける</button>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    });
    wrap.innerHTML = html;

    wrap.querySelectorAll('.js-apply-route-date').forEach(btn => {
      btn.addEventListener('click', async () => {
        const routeId = btn.dataset.routeId;
        const newDate = btn.dataset.newDate;
        if (!routeId || !newDate) return;
        if (!confirm(`${formatRouteDate_(newDate)} に変更しますか？`)) return;
        btn.disabled = true;
        btn.textContent = '変更中...';
        try {
          await API.updateRouteDate({ route_id: routeId, date: newDate });
          await API.recalcRoutePurchases({ route_id: routeId });
          invalidateHistoryApiCache();
          toast('履歴の日付と仕入れ集計を修正しました');
          await loadRouteCorrectionSuggestions_();
        } catch (e) {
          toast('修正失敗: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'この日付に変更';
        }
      });
    });

    wrap.querySelectorAll('.js-recalc-route').forEach(btn => {
      btn.addEventListener('click', async () => {
        const routeId = btn.dataset.routeId;
        if (!routeId) return;
        btn.disabled = true;
        btn.textContent = '再計算中...';
        try {
          await API.recalcRoutePurchases({ route_id: routeId });
          invalidateHistoryApiCache();
          toast('仕入れ集計を再計算しました');
          await loadRouteCorrectionSuggestions_();
        } catch (e) {
          toast('再計算失敗: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = '仕入れ集計を再計算';
        }
      });
    });

    wrap.querySelectorAll('.js-open-correction-route').forEach(btn => {
      btn.addEventListener('click', async () => {
        await openHistoryDetailByRouteId_(btn.dataset.routeId);
      });
    });
  }

  async function loadRouteCorrectionSuggestions_() {
    const result = document.getElementById('route-correction-result');
    const btn = document.getElementById('btn-route-correction-scan');
    if (result) result.innerHTML = '<div class="text-sm text-dim">確認中...</div>';
    if (btn) btn.disabled = true;
    try {
      const data = await API.getRouteCorrectionSuggestions({ limit: 30 });
      renderRouteCorrectionSuggestions_(data);
    } catch (e) {
      if (result) result.innerHTML = `<div class="text-sm" style="color:var(--accent)">確認失敗: ${esc(e.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openHistoryDetailByRouteId_(routeId) {
    if (!routeId) return;
    toast('履歴詳細を開いています...');
    try {
      const routes = await API.getRouteHistory({ limit: 50, include_stops: 'true' });
      const route = (routes || []).find(r => String(r.route_id) === String(routeId));
      if (!route) {
        toast('対象の履歴が見つかりません');
        return;
      }
      historyApiCache = { ts: Date.now(), routes };
      historyCache = routes;
      Router.navigate('history-detail', { route });
    } catch (e) {
      toast('履歴取得失敗: ' + e.message);
    }
  }

  async function renderHistoryDetail(container, { route } = {}) {
    if (!route) { Router.navigate('history'); return; }
    setTitle('履歴詳細');

    // stops が無ければオンデマンドで取得（セッション → IDB → API の順）
    if (!route.stops) {
      const cached = stopsCacheByRouteId[route.route_id];
      if (cached) {
        route.stops = cached;
      } else {
        // IDB から試みる（即座に表示できるならスピナー不要）
        let idbHit = false;
        try {
          const idbRec = await Storage.getViewCache('stops_' + route.route_id);
          if (idbRec && idbRec.data && idbRec.data.length > 0) {
            stopsCacheByRouteId[route.route_id] = idbRec.data;
            route.stops = idbRec.data;
            idbHit = true;
          }
        } catch (e) {}
        if (!idbHit) {
          container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
          try {
            const stops = await API.getRouteStops({ route_id: route.route_id });
            if (Router.getCurrentView() !== 'history-detail') return;
            stopsCacheByRouteId[route.route_id] = stops;
            route.stops = stops;
            Storage.saveViewCache('stops_' + route.route_id, { data: stops }).catch(() => {});
          } catch (e) {
            container.innerHTML = `<div class="text-center text-dim">${esc(e.message)}</div>`;
            return;
          }
        } else {
          // IDB ヒット後もバックグラウンドで最新化
          API.getRouteStops({ route_id: route.route_id }).then(stops => {
            stopsCacheByRouteId[route.route_id] = stops;
            Storage.saveViewCache('stops_' + route.route_id, { data: stops }).catch(() => {});
          }).catch(() => {});
        }
      }
    }

    const dateStr = formatRouteDate_(route.date);
    let html = '';

    // 基本情報
    html += `
      <div class="settings-section-title">基本情報</div>
      <div class="card settings-card history-summary-sticky">
        <div class="card-title">${dateStr} の巡回</div>
        <div class="history-date-editor">
          <label for="history-date-input">履歴の日付</label>
          <div class="history-date-editor-row">
            <input type="date" class="form-input" id="history-date-input" value="${esc(normalizeRouteDate_(route.date))}">
            <button class="btn btn-sm btn-outline" id="btn-update-route-date">保存</button>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-item"><div class="value">${route.store_count || 0}</div><div class="label">店舗数</div></div>
          <div class="summary-item"><div class="value">${route.total_distance_km || 0}km</div><div class="label">距離</div></div>
          <div class="summary-item"><div class="value">${formatYen_(route.total_purchase)}</div><div class="label">仕入れ</div></div>
          <div class="summary-item"><div class="value">${route.total_items || 0}</div><div class="label">点数</div></div>
        </div>
      </div>`;

    // 各店舗の詳細
    if (route.stops && route.stops.length > 0) {
      html += `<details class="history-stops" open>
        <summary><span>訪問店舗</span><span class="history-stops-count">${route.stops.length}店舗</span></summary>
        <div class="history-stops-list">`;
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
            ${purchase > 0 ? `<div class="text-sm mt-8">仕入れ: ${formatYen_(purchase)}</div>` : ''}
            ${s.arrival_time ? `<div class="text-sm text-dim">到着: ${new Date(s.arrival_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
            ${s.departure_time ? `<div class="text-sm text-dim">出発: ${new Date(s.departure_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
            <button class="btn btn-sm btn-outline btn-block mt-8 inventory-add-from-history" data-stop-index="${i}">この店の商品を在庫に登録</button>
          </div>`;
      });
      html += '</div></details>';
    }

    if (route.note) {
      html += `<div class="card"><div class="card-title">メモ</div><div>${esc(route.note)}</div></div>`;
    }

    // 在庫管理からの仕入れ品（キャッシュ表示後、裏で最新化）
    html += `<div id="inventory-section"></div>`;

    html += '<div class="history-actions">';
    // 巡回再開ボタン（停止した巡回をやり直せる）
    if (route.stops && route.stops.length > 0) {
      html += `<button class="btn btn-block history-action-primary" id="btn-resume-route">この巡回を再開</button>`;
    }
    html += `
      <button class="btn btn-block history-action-secondary history-action-add" id="btn-add-stop-history">店舗を追加</button>
      <button class="btn btn-block history-action-secondary" id="btn-back-history">履歴一覧に戻る</button>
      <button class="btn btn-block history-action-danger" id="btn-delete-route">この履歴を消去</button>
    </div>`;

    container.innerHTML = html;

    loadInventoryForRoute(route);

    document.getElementById('btn-update-route-date')?.addEventListener('click', async () => {
      const input = document.getElementById('history-date-input');
      const btn = document.getElementById('btn-update-route-date');
      const oldDate = normalizeRouteDate_(route.date);
      const newDate = normalizeRouteDate_(input?.value);
      if (!newDate || !isValidRouteDate_(newDate)) {
        toast('日付を正しく入力してください');
        return;
      }
      if (newDate === oldDate) {
        toast('日付は変更されていません');
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        await API.updateRouteDate({ route_id: route.route_id, date: newDate });
        route.date = newDate;
        invalidateHistoryApiCache();
        delete inventoryByDateCache[oldDate];
        delete inventoryByDateCache[newDate];
        Storage.clearViewCache('inventory_' + oldDate).catch(() => {});
        Storage.clearViewCache('inventory_' + newDate).catch(() => {});
        toast('日付を変更しました');
        Router.navigate('history-detail', { route });
      } catch (e) {
        toast('保存失敗: ' + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      }
    });

    container.querySelectorAll('.inventory-add-from-history').forEach(btn => {
      btn.addEventListener('click', () => {
        const stop = (route.stops || [])[Number(btn.dataset.stopIndex)];
        if (!stop) return;
        const storeObj = stores.find(st => st.store_id === stop.store_id) || {};
        showInventoryPurchaseModal({
          ...storeObj,
          store_id: stop.store_id,
          name: storeObj.name || stop.store_name || stop.store_id,
        }, {
          routeId: route.route_id,
          date: normalizeRouteDate_(route.date),
          onSaved: async () => {
            const dateKey = normalizeRouteDate_(route.date);
            if (dateKey) {
              delete inventoryByDateCache[dateKey];
              Storage.clearViewCache('inventory_' + dateKey).catch(() => {});
            }
            try {
              await API.recalcRoutePurchases({ route_id: route.route_id });
              invalidateHistoryApiCache();
            } catch (e) {}
            loadInventoryForRoute(route, { backgroundRefresh: false });
          }
        });
      });
    });

    document.getElementById('btn-resume-route')?.addEventListener('click', () => {
      resumePatrolFromHistory(route);
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
        // 該当ルートの stops キャッシュを最新に差し替え
        stopsCacheByRouteId[route.route_id] = route.stops;
        // 履歴一覧の店舗数も変わるのでキャッシュ無効化
        invalidateHistoryApiCache();
        Router.navigate('history-detail', { route });
        // API同期
        syncWrite(API.addStopToRoute({
          route_id: route.route_id,
          store_id: store.store_id
        }), '履歴への店舗追加');
      });
    });

    document.getElementById('btn-back-history')?.addEventListener('click', () => {
      Router.navigate('history');
    });

    document.getElementById('btn-delete-route')?.addEventListener('click', async event => {
      if (!confirm('この履歴を消去しますか？')) return;
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '消去しています...';
      try {
        await API.deleteRoute({ route_id: route.route_id });
        invalidateHistoryApiCache();
        await loadData();
        toast('履歴を消去しました');
        Router.navigate('history');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'この履歴を消去';
        toast(`履歴を消去できませんでした: ${error.message}`, 5000);
      }
    });
  }

  // ---------- 設定 ----------

  function renderSettings(container) {
    setTitle('設定');
    const url = API.getUrl();
    let html = `
      <div class="settings-section-title">基本設定</div>
      <div class="card settings-card">
        <div class="card-title">端末接続コード</div>
        <div class="text-sm text-dim mb-8">この端末からだけ安全にデータを読み書きするためのコードです。</div>
        <div class="form-group">
          <input type="password" class="form-input" id="set-auth-token" value="${API.hasToken() ? 'configured' : ''}" placeholder="接続コードを入力" autocomplete="off">
        </div>
        <button class="btn btn-primary btn-sm" id="btn-save-auth-token">保存して接続確認</button>
        <div id="auth-token-result" class="text-sm mt-8">${API.hasToken() ? '設定済み' : '未設定'}</div>
      </div>
      <div class="card settings-card">
        <div class="card-title">API URL</div>
        <div class="form-group">
          <input type="text" class="form-input" id="set-url" value="${esc(url)}" placeholder="https://script.google.com/macros/s/.../exec">
        </div>
        <button class="btn btn-primary btn-sm" id="btn-save-url">保存</button>
      </div>
      <div class="card settings-card">
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
      <div class="card settings-card">
        <div class="card-title">パラメータ</div>
        <div class="flex gap-8">
          <div class="form-group" style="flex:1"><label class="form-label">平均速度 (km/h)</label>
            <input type="number" class="form-input" id="set-speed" value="${config.avg_speed_kmh || 30}"></div>
          <div class="form-group" style="flex:1"><label class="form-label">デフォルト滞在 (分)</label>
            <input type="number" class="form-input" id="set-stay" value="${config.default_stay_min || 30}"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-save-params">保存</button>
      </div>
      <div class="settings-section-title">データ更新</div>
      <div class="card settings-card">
        <div class="card-title">接続テスト</div>
        <button class="btn btn-outline btn-sm" id="btn-test">テスト実行</button>
        <div id="test-result" class="text-sm mt-8"></div>
      </div>
      <div class="settings-section-title">店舗管理</div>
      <div class="card settings-card">
        <div class="card-title">データ</div>
        <button class="btn btn-outline btn-sm" id="btn-refresh">データ再取得</button>
      </div>
      <div class="card settings-card">
        <div class="card-title">店舗管理</div>
        <button class="btn btn-primary btn-sm mb-8" id="btn-add-store">+ 店舗追加</button>
        <div id="store-list"></div>
      </div>
      <div class="settings-section-title">応急修正</div>
      <div class="card settings-card">
        <div class="card-title">履歴補正アシスタント</div>
        <div class="text-sm text-dim mb-8">日付入力忘れ、仕入れ集計ズレ、店舗未確定を直近履歴から探します。</div>
        <button class="btn btn-sm btn-primary" id="btn-route-correction-scan">補正候補を確認</button>
        <div id="route-correction-result" class="route-correction-result"></div>
      </div>
      <div class="card settings-card">
        <div class="card-title">仕入れ集計を修正</div>
        <div class="text-sm text-dim mb-8">履歴の仕入れ金額・点数が0になっている場合、在庫管理シートから再集計して修正します。</div>
        <button class="btn btn-sm btn-primary" id="btn-recalc-purchases">仕入れ集計を再計算</button>
      </div>
      <div class="settings-section-title settings-danger-title">危険操作</div>
      <div class="card settings-card settings-danger-card">
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

    document.getElementById('btn-save-auth-token')?.addEventListener('click', async () => {
      const input = document.getElementById('set-auth-token');
      const result = document.getElementById('auth-token-result');
      const value = input.value.trim();
      if (!value || value === 'configured') {
        result.textContent = '新しい接続コードを入力してください';
        return;
      }
      API.setToken(value);
      input.value = 'configured';
      result.textContent = '接続確認中...';
      try {
        await API.getConfig();
        await loadData();
        result.innerHTML = '<span style="color:var(--success)">接続OK</span>';
        toast('接続コードを保存しました');
      } catch (error) {
        API.setToken('');
        input.value = '';
        result.textContent = `接続できません: ${error.message}`;
      }
    });

    document.getElementById('btn-save-url')?.addEventListener('click', async () => {
      const v = document.getElementById('set-url').value.trim();
      API.setUrl(v);
      await loadData();
      registerViews();
      setupNav();
      toast('API URLを保存しました');
      Router.navigate('home');
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

    document.getElementById('btn-recalc-purchases')?.addEventListener('click', () => {
      (async () => {
        const btn = document.getElementById('btn-recalc-purchases');
        if (btn) btn.disabled = true;
        toast('在庫管理シートから再集計中...');
        try {
          const result = await API.recalcRoutePurchases();
          invalidateHistoryApiCache();
          toast(`${result.updated || 0}件の履歴を修正しました`);
        } catch (err) {
          toast('再計算に失敗: ' + err.message);
        } finally {
          if (btn) btn.disabled = false;
        }
      })();
    });

    document.getElementById('btn-route-correction-scan')?.addEventListener('click', () => {
      loadRouteCorrectionSuggestions_();
    });

    document.getElementById('btn-clear-history')?.addEventListener('click', () => {
      if (!confirm('全ての巡回履歴を消去しますか？')) return;
      if (!confirm('本当に消去しますか？この操作は取り消せません。')) return;
      (async () => {
        try {
          await API.clearHistory();
          invalidateHistoryApiCache();
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
    if (val == null || val === '') return '';
    if (typeof val === 'string') {
      // 翌日またぎ表記 "翌2:00"
      const mj = /^翌\s*(\d{1,2}):(\d{2})/.exec(val);
      if (mj) return `翌${mj[1]}:${mj[2]}`;
      // 標準 "HH:MM" or "H:MM"
      const mn = /^(\d{1,2}):(\d{2})/.exec(val);
      if (mn) return `${String(mn[1]).padStart(2,'0')}:${mn[2]}`;
      // 旧キャッシュの ISO 文字列
      if (val.includes('T')) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        }
      }
    }
    if (val instanceof Date && !isNaN(val.getTime())) {
      return `${String(val.getHours()).padStart(2,'0')}:${String(val.getMinutes()).padStart(2,'0')}`;
    }
    return String(val);
  }

  function setTitle(t) {
    const el = document.getElementById('header-title');
    if (el) el.textContent = t;
  }

  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  function syncWrite(promise, label) {
    return Promise.resolve(promise).then(result => {
      if (result?._queued) toast(`${label}は通信復旧後に自動保存します`, 4000);
      return result;
    }).catch(error => {
      toast(`${label}を保存できませんでした: ${error.message}`, 5000);
      return null;
    });
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
