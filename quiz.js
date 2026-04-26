// ============================================================
// 廃盤クイズ — 朝5分の学習教材（独立モジュール）
// ============================================================
// IndexedDB(sedori-quiz-db) に設定・履歴・統計・復習リストを保存。
// 廃盤チェッカーWebApp(getAllHotItems / getMakerList / getGenreList) を
// データソースとし、4択メーカー当て / プレ値推測スライダーで出題する。

const Quiz = (() => {
  // ---------- 定数 ----------
  const HAIBAN_API_URL = 'https://script.google.com/macros/s/AKfycbwhJtRnWe_BBJmEfHv5sNzDyQq3HtxjgRhA6az_ieNplKyKRzsOh0x_32_F6kpIi0q4/exec';
  const ITEMS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const META_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24h
  const DB_NAME = 'sedori-quiz-db';
  const DB_VERSION = 1;

  const DEFAULT_SETTINGS = {
    range: 'mixed',
    rangeValue: null,
    type: 'mixed',
    difficulty: 'normal',
    questionCount: 5,
  };

  // ---------- IndexedDB ----------
  let _db = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('settings'))     d.createObjectStore('settings',     { keyPath: 'key' });
        if (!d.objectStoreNames.contains('history'))      d.createObjectStore('history',      { keyPath: 'asin' });
        if (!d.objectStoreNames.contains('stats'))        d.createObjectStore('stats',        { keyPath: 'key' });
        if (!d.objectStoreNames.contains('reviewQueue'))  d.createObjectStore('reviewQueue',  { keyPath: 'asin' });
        if (!d.objectStoreNames.contains('cache'))        d.createObjectStore('cache',        { keyPath: 'key' });
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function dbGet(storeName, key) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readonly');
      const r = tx.objectStore(storeName).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror   = (e) => reject(e.target.error);
    });
  }

  async function dbPut(storeName, value) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function dbGetAll(storeName) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readonly');
      const r = tx.objectStore(storeName).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = (e) => reject(e.target.error);
    });
  }

  async function dbDelete(storeName, key) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function dbClear(storeName) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ---------- 設定の取得・保存 ----------
  async function loadSettings() {
    const rec = await dbGet('settings', 'lastSettings');
    if (!rec) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(rec.value || {}) };
  }
  async function saveSettings(settings) {
    return dbPut('settings', { key: 'lastSettings', value: settings });
  }

  // ---------- 統計（連続日数・累計） ----------
  async function loadStats() {
    const rec = await dbGet('stats', 'stats');
    return rec?.value || {
      streak: 0,
      lastPlayedDate: null,
      totalQuestions: 0,
      totalCorrect: 0,
      learnedAsins: [],
    };
  }
  async function saveStats(stats) {
    return dbPut('stats', { key: 'stats', value: stats });
  }

  function todayString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function diffDays(d1, d2) {
    if (!d1 || !d2) return 999;
    const a = new Date(d1 + 'T00:00:00');
    const b = new Date(d2 + 'T00:00:00');
    return Math.round((b - a) / (24 * 60 * 60 * 1000));
  }

  async function bumpStreakIfFirstSessionToday() {
    const stats = await loadStats();
    const today = todayString();
    if (stats.lastPlayedDate === today) return stats; // 同日プレイは加算しない
    const d = diffDays(stats.lastPlayedDate, today);
    if (d === 1) {
      stats.streak = (stats.streak || 0) + 1;
    } else if (d >= 2 || !stats.lastPlayedDate) {
      stats.streak = 1;
    }
    stats.lastPlayedDate = today;
    await saveStats(stats);
    return stats;
  }

  // ---------- 履歴（asin単位） ----------
  async function recordAttempt(asin, isCorrect) {
    if (!asin) return;
    const rec = (await dbGet('history', asin)) || { asin, attempts: 0, correct: 0, lastAttempted: null, lastResult: null };
    rec.attempts += 1;
    if (isCorrect) rec.correct += 1;
    rec.lastAttempted = todayString();
    rec.lastResult = isCorrect ? 'correct' : 'incorrect';
    await dbPut('history', rec);

    // 統計更新
    const stats = await loadStats();
    stats.totalQuestions = (stats.totalQuestions || 0) + 1;
    if (isCorrect) stats.totalCorrect = (stats.totalCorrect || 0) + 1;
    if (!stats.learnedAsins) stats.learnedAsins = [];
    if (!stats.learnedAsins.includes(asin)) stats.learnedAsins.push(asin);
    await saveStats(stats);

    // 不正解は復習キューへ
    if (!isCorrect) {
      await dbPut('reviewQueue', { asin, addedDate: todayString(), reason: 'incorrect' });
    } else {
      // 正解したら復習キューから外す
      try { await dbDelete('reviewQueue', asin); } catch (e) { /* ignore */ }
    }
  }

  // ---------- 廃盤APIアクセス ----------
  async function postHaiban(action, body = {}) {
    const res = await fetch(HAIBAN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action, ...body }),
      redirect: 'follow',
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('クイズAPIレスポンス不正'); }
    if (parsed && parsed.ok === false) throw new Error(parsed.error || 'API error');
    return parsed;
  }

  async function getCachedOrFetch(cacheKey, ttl, fetcher) {
    const rec = await dbGet('cache', cacheKey);
    const now = Date.now();
    if (rec && rec.value && (now - (rec.fetchedAt || 0)) < ttl) {
      return rec.value;
    }
    const value = await fetcher();
    await dbPut('cache', { key: cacheKey, value, fetchedAt: now });
    return value;
  }

  async function fetchAllItems(force = false) {
    if (force) {
      try { await dbDelete('cache', 'allItems'); } catch (e) {}
    }
    return getCachedOrFetch('allItems', ITEMS_CACHE_TTL_MS, async () => {
      const resp = await postHaiban('getAllHotItems');
      return Array.isArray(resp.items) ? resp.items : [];
    });
  }

  async function fetchMakerList() {
    return getCachedOrFetch('makerList', META_CACHE_TTL_MS, async () => {
      try {
        const resp = await postHaiban('getMakerList');
        if (Array.isArray(resp?.makers)) return resp.makers;
      } catch (e) {
        // フォールバック: getAllHotItems からブランド名を集計
      }
      const items = await fetchAllItems();
      const counts = {};
      for (const it of items) {
        const m = String(it['ブランド名'] || '').trim();
        if (!m) continue;
        counts[m] = (counts[m] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    });
  }

  async function fetchGenreList() {
    return getCachedOrFetch('genreList', META_CACHE_TTL_MS, async () => {
      try {
        const resp = await postHaiban('getGenreList');
        if (Array.isArray(resp?.genres)) return resp.genres;
      } catch (e) {
        // フォールバック: 簡易3分類
      }
      const items = await fetchAllItems();
      const counts = { '家電': 0, '日用品': 0, 'その他': 0 };
      for (const it of items) {
        const g = inferSimpleGenre(it);
        counts[g] = (counts[g] || 0) + 1;
      }
      return Object.entries(counts)
        .filter(([, c]) => c > 0)
        .map(([name, count]) => ({ name, count }));
    });
  }

  function inferSimpleGenre(item) {
    const brand = String(item['ブランド名'] || '');
    const ELECTRIC_RE = /(パナソニック|ソニー|シャープ|東芝|日立|三菱|カシオ|キヤノン|ニコン|オリンパス|JVC|アイリスオーヤマ|象印|タイガー|ツインバード|山善|アイワ|エレコム|バッファロー|TP-Link|アンカー|Anker|ロジクール|Logicool|Apple|Bose|JBL|オーディオテクニカ|ヤマハ|SONY|SHARP|TOSHIBA|HITACHI)/i;
    const KIDS_RE = /(タカラトミー|バンダイ|エポック|セガ|レゴ|LEGO|トミカ|プラレール|サンリオ|ぬいぐるみ)/;
    if (ELECTRIC_RE.test(brand)) return '家電';
    if (KIDS_RE.test(brand))     return 'おもちゃ';
    return '日用品';
  }

  // ---------- スコアランク ----------
  function scoreRank(preScore, purScore) {
    const preMap = { 'A': 4, 'B': 3, 'C': 2, 'D': 1 };
    const purMap = { 'S': 5, 'A': 4, 'B': 3, 'C': 2 };
    return (purMap[purScore] || 0) * 5 + (preMap[preScore] || 0) * 4;
  }
  function isEasyItem(item) {
    const p = String(item['仕入れスコア'] || '').trim();
    return p === 'S' || p === 'A';
  }
  function isHardCandidate(item) {
    const p = String(item['仕入れスコア'] || '').trim();
    return p === 'B' || p === 'C' || p === '';
  }

  // ---------- 出題ロジック ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pickRandom(arr, n) {
    return shuffle(arr).slice(0, n);
  }
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function dedupByAsin(arr) {
    const seen = new Set();
    const out = [];
    for (const it of arr) {
      const a = String(it.ASIN || '').trim();
      // ASINがある場合は重複排除、無い場合は商品名でも重複排除
      const key = a || `name:${String(it['商品名'] || '').trim()}`;
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  async function buildSessionItems(items, settings, opts = {}) {
    let pool = dedupByAsin(items.slice());

    // 範囲フィルタ
    if (settings.range === 'maker' && settings.rangeValue) {
      pool = pool.filter(it => String(it['ブランド名'] || '').trim() === settings.rangeValue);
    } else if (settings.range === 'genre' && settings.rangeValue) {
      pool = pool.filter(it => inferSimpleGenre(it) === settings.rangeValue);
    }

    // 復習モード
    if (opts.shortcut === 'review') {
      const queue = await dbGetAll('reviewQueue');
      const asinSet = new Set(queue.map(q => q.asin));
      const reviewItems = pool.filter(it => asinSet.has(String(it.ASIN || '').trim()));
      if (reviewItems.length === 0) {
        // 復習キュー空 → 「今日のおすすめ」相当にフォールバック
      } else {
        pool = reviewItems;
      }
    }

    // 苦手モード（メーカー別正解率の低い下位3社）
    if (opts.shortcut === 'weak') {
      const weakMakers = await pickWeakMakers(3);
      if (weakMakers.length > 0) {
        pool = pool.filter(it => weakMakers.includes(String(it['ブランド名'] || '').trim()));
      }
    }

    // 難易度フィルタ
    if (settings.difficulty === 'easy') {
      const easy = pool.filter(isEasyItem);
      if (easy.length >= 3) pool = easy;
    } else if (settings.difficulty === 'hard') {
      // 未習＋スコアB/C中心
      const stats = await loadStats();
      const learned = new Set(stats.learnedAsins || []);
      const unlearned = pool.filter(it => !learned.has(String(it.ASIN || '').trim()));
      const hardCands = pool.filter(isHardCandidate);
      // 未習 80% + 既習(間違い中心) 20%
      const want = settings.questionCount === 'endless' ? 30 : settings.questionCount;
      const unlearnedTarget = Math.ceil(want * 0.8);
      const learnedHard = pool.filter(it => learned.has(String(it.ASIN || '').trim()) && isHardCandidate(it));
      const part1 = pickRandom(unlearned.length ? unlearned : hardCands, unlearnedTarget);
      const part2 = pickRandom(learnedHard.length ? learnedHard : pool, Math.max(0, want - part1.length));
      const merged = shuffle([...part1, ...part2]);
      if (merged.length >= 3) {
        pool = merged;
      }
    } else {
      // ふつう: 既習60% / 未習40%
      const stats = await loadStats();
      const learned = new Set(stats.learnedAsins || []);
      const learnedItems = pool.filter(it => learned.has(String(it.ASIN || '').trim()));
      const unlearned    = pool.filter(it => !learned.has(String(it.ASIN || '').trim()));
      const want = settings.questionCount === 'endless' ? 30 : settings.questionCount;
      if (learnedItems.length > 0 && unlearned.length > 0) {
        const part1 = pickRandom(learnedItems, Math.ceil(want * 0.6));
        const part2 = pickRandom(unlearned,    Math.max(0, want - part1.length));
        const merged = shuffle([...part1, ...part2]);
        if (merged.length >= 3) pool = merged;
      }
    }

    // 必要件数
    const want = settings.questionCount === 'endless' ? Math.min(30, pool.length) : settings.questionCount;
    return pickRandom(pool, want);
  }

  async function pickWeakMakers(n) {
    const allHist = await dbGetAll('history');
    if (allHist.length === 0) return [];
    // ASINからブランドを引くため、items キャッシュを参照
    const items = await fetchAllItems();
    const asinToBrand = new Map();
    for (const it of items) {
      const a = String(it.ASIN || '').trim();
      if (a) asinToBrand.set(a, String(it['ブランド名'] || '').trim());
    }
    const byMaker = new Map();
    for (const h of allHist) {
      const brand = asinToBrand.get(h.asin);
      if (!brand) continue;
      const cur = byMaker.get(brand) || { attempts: 0, correct: 0 };
      cur.attempts += h.attempts;
      cur.correct  += h.correct;
      byMaker.set(brand, cur);
    }
    return Array.from(byMaker.entries())
      .filter(([, v]) => v.attempts >= 2)
      .map(([k, v]) => ({ name: k, rate: v.correct / Math.max(1, v.attempts) }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, n)
      .map(x => x.name);
  }

  function buildMakerChoices(item, allItems) {
    const correct = String(item['ブランド名'] || '').trim();
    const allMakers = Array.from(new Set(allItems.map(it => String(it['ブランド名'] || '').trim()).filter(Boolean)));
    const others = allMakers.filter(m => m !== correct);
    const decoys = pickRandom(others, 3);
    return shuffle([correct, ...decoys]);
  }

  function decideQuestionType(settings) {
    if (settings.type === 'maker_quiz') return 'maker';
    if (settings.type === 'price_quiz') return 'price';
    return Math.random() < 0.5 ? 'maker' : 'price';
  }

  // ---------- ビュー描画 ----------
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  function escHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // セッション状態（メモリ）
  let session = null;

  async function renderQuiz(container) {
    if (typeof setTitle === 'function') {} // 未使用
    document.getElementById('header-title') && (document.getElementById('header-title').textContent = 'クイズ');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'quiz'));
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    let items, makers, genres, settings, stats;
    try {
      [items, makers, genres, settings, stats] = await Promise.all([
        fetchAllItems(),
        fetchMakerList(),
        fetchGenreList(),
        loadSettings(),
        loadStats(),
      ]);
    } catch (e) {
      container.innerHTML = `
        <div class="card">
          <div class="card-title">クイズデータ取得失敗</div>
          <div class="text-dim text-sm mb-8">${escHtml(e.message)}</div>
          <button class="btn btn-outline btn-sm" id="btn-quiz-retry">再読み込み</button>
        </div>`;
      document.getElementById('btn-quiz-retry')?.addEventListener('click', () => renderQuiz(container));
      return;
    }
    updateQuizNavBadge(stats.streak || 0);

    renderStartScreen(container, { items, makers, genres, settings, stats });
  }

  function renderStartScreen(container, ctx) {
    const { items, makers, genres, settings, stats } = ctx;
    const learnedCount = (stats.learnedAsins || []).length;
    const totalCount = items.length;
    const accRate = stats.totalQuestions > 0
      ? Math.round((stats.totalCorrect / stats.totalQuestions) * 100)
      : 0;

    const rangeLabel = (() => {
      if (settings.range === 'maker') return settings.rangeValue || 'メーカー未選択';
      if (settings.range === 'genre') return settings.rangeValue || 'ジャンル未選択';
      return 'すべて';
    })();
    const typeLabel = settings.type === 'maker_quiz' ? 'メーカー当て'
                    : settings.type === 'price_quiz' ? 'プレ値推測' : 'ミックス';
    const diffLabel = settings.difficulty === 'easy' ? 'かんたん'
                    : settings.difficulty === 'hard' ? 'むずかしい' : 'ふつう';
    const qcLabel = settings.questionCount === 'endless' ? 'エンドレス' : `${settings.questionCount}問`;

    container.innerHTML = `
      <div class="quiz-stats">
        <div class="quiz-stat-row">
          <div class="quiz-stat-pill"><span class="quiz-stat-icon">&#x1f525;</span><span class="quiz-stat-num">${stats.streak || 0}</span><span class="quiz-stat-label">日連続</span></div>
          <div class="quiz-stat-pill"><span class="quiz-stat-num">${accRate}%</span><span class="quiz-stat-label">正解率</span></div>
          <div class="quiz-stat-pill"><span class="quiz-stat-num">${learnedCount}</span><span class="quiz-stat-label">/${totalCount} 既習</span></div>
        </div>
      </div>

      <div class="quiz-section">
        <div class="quiz-label">出題範囲</div>
        <div class="quiz-btn-row" data-axis="range">
          <button class="quiz-opt ${settings.range==='mixed'?'on':''}" data-val="mixed">ミックス</button>
          <button class="quiz-opt ${settings.range==='maker'?'on':''}" data-val="maker">メーカー別</button>
          <button class="quiz-opt ${settings.range==='genre'?'on':''}" data-val="genre">ジャンル別</button>
        </div>
        <div class="quiz-range-detail" id="quiz-range-detail">${
          (settings.range==='maker' || settings.range==='genre')
            ? `<button class="quiz-pick-btn" id="btn-pick-range">${escHtml(rangeLabel)} ▼</button>`
            : ''
        }</div>
      </div>

      <div class="quiz-section">
        <div class="quiz-label">問題タイプ</div>
        <div class="quiz-btn-row" data-axis="type">
          <button class="quiz-opt ${settings.type==='mixed'?'on':''}" data-val="mixed">ミックス</button>
          <button class="quiz-opt ${settings.type==='maker_quiz'?'on':''}" data-val="maker_quiz">メーカー当て</button>
          <button class="quiz-opt ${settings.type==='price_quiz'?'on':''}" data-val="price_quiz">プレ値推測</button>
        </div>
      </div>

      <div class="quiz-section">
        <div class="quiz-label">難易度</div>
        <div class="quiz-btn-row" data-axis="difficulty">
          <button class="quiz-opt ${settings.difficulty==='easy'?'on':''}"   data-val="easy">かんたん</button>
          <button class="quiz-opt ${settings.difficulty==='normal'?'on':''}" data-val="normal">ふつう</button>
          <button class="quiz-opt ${settings.difficulty==='hard'?'on':''}"   data-val="hard">むずかしい</button>
        </div>
      </div>

      <div class="quiz-section">
        <div class="quiz-label">問題数</div>
        <div class="quiz-btn-row" data-axis="questionCount">
          <button class="quiz-opt ${settings.questionCount===3?'on':''}" data-val="3">3問</button>
          <button class="quiz-opt ${settings.questionCount===5?'on':''}" data-val="5">5問</button>
          <button class="quiz-opt ${settings.questionCount===10?'on':''}" data-val="10">10問</button>
          <button class="quiz-opt ${settings.questionCount==='endless'?'on':''}" data-val="endless">エンドレス</button>
        </div>
      </div>

      <button class="btn btn-primary quiz-start-btn" id="btn-quiz-start">スタート ▶</button>

      <div class="quiz-shortcut-section">
        <div class="quiz-label">ワンタップで始める</div>
        <button class="quiz-shortcut" id="sc-today">&#x1f4c5; 今日のおすすめ</button>
        <button class="quiz-shortcut" id="sc-review">&#x1f504; 復習モード（前日間違えた問題）</button>
        <button class="quiz-shortcut" id="sc-weak">&#x1f31f; 苦手モード（正解率の低い3社）</button>
      </div>

      <div class="quiz-current">
        現在の設定: ${escHtml(rangeLabel)} / ${escHtml(typeLabel)} / ${escHtml(diffLabel)} / ${escHtml(qcLabel)}
      </div>
    `;

    // 軸ボタン
    container.querySelectorAll('.quiz-btn-row').forEach(row => {
      const axis = row.dataset.axis;
      row.querySelectorAll('.quiz-opt').forEach(btn => {
        btn.addEventListener('click', async () => {
          let val = btn.dataset.val;
          if (axis === 'questionCount' && val !== 'endless') val = Number(val);
          settings[axis] = val;
          if (axis === 'range' && val === 'mixed') settings.rangeValue = null;
          if (axis === 'range' && val !== 'mixed') {
            // モーダルで選ばせる
            await pickRangeValue(settings, val, ctx);
          }
          await saveSettings(settings);
          renderStartScreen(container, ctx);
        });
      });
    });

    container.querySelector('#btn-pick-range')?.addEventListener('click', async () => {
      await pickRangeValue(settings, settings.range, ctx);
      await saveSettings(settings);
      renderStartScreen(container, ctx);
    });

    container.querySelector('#btn-quiz-start')?.addEventListener('click', async () => {
      await startSession(container, ctx, {});
    });
    container.querySelector('#sc-today')?.addEventListener('click', async () => {
      // 今日のおすすめ: ふつう・ミックス・5問・全範囲
      const s = { range: 'mixed', rangeValue: null, type: 'mixed', difficulty: 'normal', questionCount: 5 };
      await saveSettings(s);
      ctx.settings = s;
      await startSession(container, ctx, {});
    });
    container.querySelector('#sc-review')?.addEventListener('click', async () => {
      await startSession(container, ctx, { shortcut: 'review' });
    });
    container.querySelector('#sc-weak')?.addEventListener('click', async () => {
      await startSession(container, ctx, { shortcut: 'weak' });
    });
  }

  function pickRangeValue(settings, kind, ctx) {
    return new Promise((resolve) => {
      const list = kind === 'maker' ? ctx.makers : ctx.genres;
      const overlay = el('div', { class: 'quiz-modal-overlay' });
      const box = el('div', { class: 'quiz-modal' });
      box.innerHTML = `
        <div class="quiz-modal-title">${kind === 'maker' ? 'メーカーを選ぶ' : 'ジャンルを選ぶ'}</div>
        <input type="text" class="form-input quiz-modal-search" id="quiz-modal-search" placeholder="絞り込み" autocomplete="off">
        <div class="quiz-modal-list" id="quiz-modal-list"></div>
        <button class="btn btn-outline btn-sm quiz-modal-close" id="quiz-modal-close">閉じる</button>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const listEl = box.querySelector('#quiz-modal-list');
      const searchEl = box.querySelector('#quiz-modal-search');

      function render() {
        const q = String(searchEl.value || '').trim().toLowerCase();
        const filtered = q ? list.filter(x => x.name.toLowerCase().includes(q)) : list;
        listEl.innerHTML = filtered.map(x =>
          `<button class="quiz-modal-item" data-name="${escHtml(x.name)}">
            <span class="quiz-modal-item-name">${escHtml(x.name)}</span>
            <span class="quiz-modal-item-count">${x.count}件</span>
          </button>`
        ).join('');
        listEl.querySelectorAll('.quiz-modal-item').forEach(b => {
          b.addEventListener('click', () => {
            settings.rangeValue = b.dataset.name;
            close();
            resolve();
          });
        });
      }
      function close() { document.body.removeChild(overlay); }
      box.querySelector('#quiz-modal-close').addEventListener('click', () => { close(); resolve(); });
      overlay.addEventListener('click', e => { if (e.target === overlay) { close(); resolve(); } });
      searchEl.addEventListener('input', render);
      render();
    });
  }

  // ---------- セッション開始・問題画面 ----------
  async function startSession(container, ctx, opts) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div><p class="mt-8">問題を準備中...</p></div>';
    const built = await buildSessionItems(ctx.items, ctx.settings, opts);
    if (!built || built.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="card-title">出題できる問題がありません</div>
          <div class="text-dim text-sm mb-8">条件を変えて再度お試しください。</div>
          <button class="btn btn-outline btn-sm" id="btn-back-to-start">スタート画面に戻る</button>
        </div>`;
      container.querySelector('#btn-back-to-start')?.addEventListener('click', () => renderStartScreen(container, ctx));
      return;
    }

    session = {
      questions: built,
      currentIdx: 0,
      results: [],
      consecutiveCorrect: 0,
      shortcut: opts.shortcut || null,
      ctx,
      total: ctx.settings.questionCount === 'endless' ? null : built.length,
    };
    // 1日1回ストリーク加算 → ナビバッジ更新
    const stats = await bumpStreakIfFirstSessionToday();
    updateQuizNavBadge(stats.streak || 0);
    renderQuestion(container);
  }

  function renderQuestion(container) {
    if (!session) return;
    const q = session.questions[session.currentIdx];
    if (!q) {
      renderSummary(container);
      return;
    }
    const qType = decideQuestionType(session.ctx.settings);
    const total = session.total ? `${session.currentIdx + 1}/${session.total}` : `Q${session.currentIdx + 1}`;

    if (qType === 'maker') {
      renderMakerQuestion(container, q, total);
    } else {
      renderPriceQuestion(container, q, total);
    }
  }

  function buildItemCardHtml(item) {
    const asin = String(item.ASIN || '').trim();
    const imageFile = String(item['画像ファイル'] || '').trim();
    const imgSrc = imageFile
      ? `https://m.media-amazon.com/images/I/${escHtml(imageFile)}`
      : asin
      ? `https://images-na.ssl-images-amazon.com/images/P/${escHtml(asin)}.09._SL200_.jpg`
      : '';
    const imgHtml = imgSrc
      ? `<img class="quiz-item-img" src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '';
    return `
      <div class="quiz-item-card">
        ${imgHtml}
        <div class="quiz-item-name">${escHtml(item['商品名'] || '')}</div>
      </div>
    `;
  }

  function renderMakerQuestion(container, item, headLabel) {
    const choices = buildMakerChoices(item, session.ctx.items);
    const correct = String(item['ブランド名'] || '').trim();
    container.innerHTML = `
      <div class="quiz-progress">${escHtml(headLabel)} メーカー当て</div>
      ${buildItemCardHtml(item)}
      <div class="quiz-question-text">このメーカーは？</div>
      <div class="quiz-choice-grid">
        ${choices.map((c, i) => `
          <button class="quiz-choice" data-name="${escHtml(c)}">
            <span class="quiz-choice-letter">${'ABCD'[i]}</span>
            <span class="quiz-choice-name">${escHtml(c)}</span>
          </button>
        `).join('')}
      </div>
    `;
    container.querySelectorAll('.quiz-choice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ans = btn.dataset.name;
        const isCorrect = ans === correct;
        // ボタン非活性 + 正解/不正解スタイル
        container.querySelectorAll('.quiz-choice').forEach(b => {
          b.disabled = true;
          if (b.dataset.name === correct) b.classList.add('correct');
          else if (b === btn) b.classList.add('wrong');
        });
        await onAnswered(container, item, isCorrect, { type: 'maker', user: ans, correct });
      });
    });
  }

  function renderPriceQuestion(container, item, headLabel) {
    const real = Number(item['最安値'] || 0);
    if (!real || real <= 0) {
      // 最安値が無い問題はメーカー当てにフォールバック
      renderMakerQuestion(container, item, headLabel);
      return;
    }
    const min = 500, max = 100000;
    const initial = Math.min(max, Math.max(min, Math.round((min + max) / 4)));
    container.innerHTML = `
      <div class="quiz-progress">${escHtml(headLabel)} プレ値推測</div>
      ${buildItemCardHtml(item)}
      <div class="quiz-question-meta">メーカー: ${escHtml(item['ブランド名'] || '')}</div>
      <div class="quiz-question-text">Amazon最安値はいくら？</div>
      <input type="range" class="quiz-slider" id="quiz-slider" min="${min}" max="${max}" step="100" value="${initial}">
      <div class="quiz-slider-labels"><span>¥${min.toLocaleString()}</span><span>¥${max.toLocaleString()}</span></div>
      <div class="quiz-slider-value" id="quiz-slider-value">¥${initial.toLocaleString()}</div>
      <button class="btn btn-primary quiz-confirm-btn" id="quiz-confirm-btn">この金額で確定 ▶</button>
    `;
    const slider = container.querySelector('#quiz-slider');
    const valEl  = container.querySelector('#quiz-slider-value');
    slider.addEventListener('input', () => {
      valEl.textContent = `¥${Number(slider.value).toLocaleString()}`;
    });
    container.querySelector('#quiz-confirm-btn').addEventListener('click', async () => {
      const guess = Number(slider.value);
      const diffRate = Math.abs(guess - real) / real;
      const isCorrect = diffRate <= 0.20;
      const isPerfect = diffRate <= 0.10;
      await onAnswered(container, item, isCorrect, { type: 'price', user: guess, correct: real, diffRate, isPerfect });
    });
  }

  async function onAnswered(container, item, isCorrect, detail) {
    const asin = String(item.ASIN || '').trim();
    await recordAttempt(asin, isCorrect);
    if (isCorrect) session.consecutiveCorrect = (session.consecutiveCorrect || 0) + 1;
    else session.consecutiveCorrect = 0;
    session.results.push({
      idx: session.currentIdx,
      item,
      isCorrect,
      detail,
    });
    // 即時フィードバック画面（ボタンを非活性にしたあと、200ms後にフィードバック）
    setTimeout(() => renderFeedback(container, item, isCorrect, detail), 600);
  }

  function renderFeedback(container, item, isCorrect, detail) {
    const asin = String(item.ASIN || '').trim();
    const amazonUrl = String(item.AmazonURL || '').trim() || (asin ? `https://www.amazon.co.jp/dp/${asin}` : '');
    const keepaUrl  = asin ? `https://keepa.com/#!product/5-${asin}` : '';
    const pre = String(item['プレ値スコア'] || '').trim();
    const pur = String(item['仕入れスコア'] || '').trim();
    const price = item['最安値'] ? `¥${Number(item['最安値']).toLocaleString()}` : '価格未取得';
    const profit = item['月間期待利益'] ? `¥${Number(item['月間期待利益']).toLocaleString()}` : '';

    let resultLine = '';
    let pointStr = '';
    if (isCorrect) {
      const base = 10;
      const bonus = (session.consecutiveCorrect >= 2) ? 5 : 0;
      pointStr = bonus > 0
        ? `+${base}pt（連続${session.consecutiveCorrect}問正解 +${bonus}pt）`
        : `+${base}pt`;
      resultLine = `<div class="quiz-result correct">&#x2b55; 正解！ <span class="quiz-points">${pointStr}</span></div>`;
    } else {
      let detailMsg = '';
      if (detail.type === 'maker') {
        detailMsg = `あなたの回答: ${escHtml(detail.user)} ／ 正解: <b>${escHtml(detail.correct)}</b>`;
      } else if (detail.type === 'price') {
        detailMsg = `あなたの回答: ¥${Number(detail.user).toLocaleString()} ／ 正解: <b>¥${Number(detail.correct).toLocaleString()}</b>（誤差${Math.round((detail.diffRate||0)*100)}%）`;
      }
      resultLine = `<div class="quiz-result wrong">&#x274c; 不正解 <span class="quiz-points">${detailMsg}</span></div>`;
    }
    if (detail.type === 'price' && isCorrect && detail.isPerfect) {
      resultLine = `<div class="quiz-result correct">&#x1f3af; パーフェクト！ <span class="quiz-points">誤差${Math.round((detail.diffRate||0)*100)}% +15pt</span></div>`;
    }

    const graphHtml = asin
      ? `<img class="quiz-keepa-graph" src="https://graph.keepa.com/pricehistory.png?asin=${escHtml(asin)}&domain=5&range=365" alt="Keepa 1年価格推移グラフ" loading="lazy" onerror="this.onerror=null; this.style.display='none'; const fb=document.getElementById('quiz-keepa-fallback'); if(fb) fb.style.display='block';">
         <a id="quiz-keepa-fallback" class="quiz-keepa-fallback" href="${escHtml(keepaUrl)}" target="_blank" rel="noopener" style="display:none">&#x1f4ca; Keepaで確認</a>`
      : '';

    const amazonBtn = amazonUrl
      ? `<a class="quiz-link amazon" href="${escHtml(amazonUrl)}" target="_blank" rel="noopener">&#x1f517; Amazon</a>`
      : `<button class="quiz-link amazon disabled" disabled>&#x1f517; Amazon</button>`;
    const keepaBtn = keepaUrl
      ? `<a class="quiz-link keepa" href="${escHtml(keepaUrl)}" target="_blank" rel="noopener">&#x1f4ca; Keepa詳細</a>`
      : `<button class="quiz-link keepa disabled" disabled>&#x1f4ca; Keepa詳細</button>`;

    container.innerHTML = `
      ${resultLine}
      <div class="quiz-feedback-card">
        <div class="quiz-feedback-section-title">解説</div>
        <div class="quiz-feedback-brand">${escHtml(item['ブランド名'] || '')}</div>
        <div class="quiz-feedback-name">${escHtml(item['商品名'] || '')}</div>
        <div class="quiz-feedback-badges">
          ${pre ? `<span class="score-badge pre-${pre}">プレ値 ${pre}</span>` : ''}
          ${pur ? `<span class="score-badge pur-${pur}">仕入 ${pur}</span>` : ''}
        </div>
        <div class="quiz-feedback-meta">最安値: ${price}${profit ? ' ／ 月間期待利益: ' + profit : ''}</div>
        ${graphHtml}
        <div class="quiz-feedback-links">
          ${amazonBtn}
          ${keepaBtn}
        </div>
      </div>
      <button class="btn btn-primary quiz-next-btn" id="quiz-next-btn">${isLastQuestion() ? '結果を見る ▶' : '次の問題 ▶'}</button>
    `;
    container.querySelector('#quiz-next-btn').addEventListener('click', () => {
      session.currentIdx += 1;
      if (isLastQuestion(true) || (session.total && session.currentIdx >= session.total)) {
        renderSummary(container);
      } else {
        renderQuestion(container);
      }
    });
  }

  function isLastQuestion(afterAdvance = false) {
    if (!session) return true;
    if (session.total == null) return false; // エンドレスは最後がない
    const idx = afterAdvance ? session.currentIdx : session.currentIdx + 1;
    return idx >= session.total;
  }

  function renderSummary(container) {
    if (!session) {
      Router.navigate('quiz');
      return;
    }
    const total = session.results.length;
    const correct = session.results.filter(r => r.isCorrect).length;
    const rate = total > 0 ? Math.round((correct / total) * 100) : 0;

    const lines = session.results.map((r, i) => {
      const mark = r.isCorrect ? '&#x2b55;' : '&#x274c;';
      const name = r['item'] ? r.item['商品名'] : '';
      const brand = r['item'] ? r.item['ブランド名'] : '';
      let extra = '';
      if (r.detail?.type === 'price') {
        extra = ` 価格 ±${Math.round((r.detail.diffRate || 0) * 100)}%`;
      } else if (r.detail?.type === 'maker') {
        extra = ` (${escHtml(brand)})`;
      }
      return `<div class="quiz-summary-row">${mark} Q${i+1} ${escHtml(name).slice(0, 28)}${extra}</div>`;
    }).join('');

    // ストリーク表示
    (async () => {
      const stats = await loadStats();
      const streakLine = container.querySelector('#quiz-summary-streak');
      if (streakLine) streakLine.innerHTML = `&#x1f525; ${stats.streak || 0}日連続記録更新！`;
    })();

    container.innerHTML = `
      <div class="quiz-summary-hero">
        <div class="quiz-summary-emoji">&#x1f389;</div>
        <div class="quiz-summary-title">お疲れさま！</div>
        <div class="quiz-summary-sub">${total}問チャレンジ達成</div>
        <div class="quiz-summary-score">スコア: ${correct}/${total}（${rate}%）</div>
      </div>
      <div class="quiz-summary-list">${lines}</div>
      <div class="quiz-summary-streak" id="quiz-summary-streak"></div>
      <div class="quiz-summary-actions">
        <button class="btn btn-outline" id="btn-quiz-review-add">復習リストに追加</button>
        <button class="btn btn-primary" id="btn-quiz-again">もう1セッション</button>
        <button class="btn btn-outline" id="btn-quiz-home">ホームへ</button>
      </div>
    `;

    container.querySelector('#btn-quiz-review-add').addEventListener('click', async () => {
      // 不正解だったものを復習キューに保存（recordAttemptで既に追加済みだが、間違いを明示的に追加）
      const today = todayString();
      for (const r of session.results) {
        if (!r.isCorrect) {
          const asin = String(r.item?.ASIN || '').trim();
          if (asin) await dbPut('reviewQueue', { asin, addedDate: today, reason: 'incorrect' });
        }
      }
      const t = document.getElementById('toast');
      if (t) { t.textContent = '復習リストに追加しました'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
    });
    container.querySelector('#btn-quiz-again').addEventListener('click', () => {
      Router.navigate('quiz');
    });
    container.querySelector('#btn-quiz-home').addEventListener('click', () => {
      Router.navigate('home');
    });
  }

  // ---------- ナビバッジ ----------
  function updateQuizNavBadge(streak) {
    const el = document.getElementById('quiz-nav-badge');
    if (!el) return;
    if (streak > 0) {
      el.textContent = `\u{1f525}${streak}`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // 初期表示時にバッジを反映するため、ロード時に読みに行く
  (async () => {
    try {
      const stats = await loadStats();
      // DOMがまだ無い場合はちょっと待って再試行
      const tryUpdate = () => {
        if (document.getElementById('quiz-nav-badge')) {
          updateQuizNavBadge(stats.streak || 0);
        } else {
          setTimeout(tryUpdate, 200);
        }
      };
      tryUpdate();
    } catch (e) { /* ignore */ }
  })();

  return {
    renderQuiz,
    updateQuizNavBadge,
    loadStats,
  };
})();
