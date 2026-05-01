// ============================================================
// 廃盤クイズ — 朝5分の学習教材（独立モジュール）
// ============================================================
// IndexedDB(sedori-quiz-db) に設定・履歴・統計・復習リストを保存。
// 廃盤チェッカーWebApp(getQuizPool / getMakerList / getGenreList) を
// データソースとし、4択メーカー当て / プレ値推測スライダーで出題する。
// ※ クイズ専用の広いプール(getQuizPool)を使用。仕入れ判断用の廃盤タブは
//   従来通り getAllHotItems を使用するため、キャッシュキーは別管理(quizPool)。

const Quiz = (() => {
  // ---------- 定数 ----------
  const HAIBAN_API_URL = 'https://script.google.com/macros/s/AKfycbwhJtRnWe_BBJmEfHv5sNzDyQq3HtxjgRhA6az_ieNplKyKRzsOh0x_32_F6kpIi0q4/exec';
  const ITEMS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  const META_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24h
  const DB_NAME = 'sedori-quiz-db';
  const DB_VERSION = 2;
  // 直近セッションのメーカー/ASINを記録して、出題を分散させるために参照する
  const RECENT_SESSIONS_KEEP = 3; // 直近3セッション分を残す
  const RECENT_MAKER_WEIGHT = 0.2; // 直近に出たメーカーの抽選ウェイトを下げる係数（0で完全除外、1で均等）
  const LEARNED_RATIO_NORMAL = 0.3; // 「ふつう」既習比率（旧60%→30%に引き下げ）
  const RECENT_HOURS_EXCLUDE = 24; // 直近この時間内に出題した商品は既習扱いから除外する

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
        // v2追加: 直近セッションでの出題ASIN/メーカーを保持して分散抽選に使う
        if (!d.objectStoreNames.contains('recentSessions')) {
          d.createObjectStore('recentSessions', { keyPath: 'id', autoIncrement: true });
        }
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
    const rec = (await dbGet('history', asin)) || { asin, attempts: 0, correct: 0, lastAttempted: null, lastResult: null, lastAttemptedAt: 0 };
    rec.attempts += 1;
    if (isCorrect) rec.correct += 1;
    rec.lastAttempted = todayString();
    rec.lastAttemptedAt = Date.now(); // 24h除外判定用に記録
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
    if (rec && rec.value) {
      const expired = (now - (rec.fetchedAt || 0)) >= ttl;
      if (expired) {
        // stale-while-revalidate: 古くても即返し、裏で更新
        fetcher().then(value => {
          dbPut('cache', { key: cacheKey, value, fetchedAt: Date.now() });
        }).catch(() => {});
      }
      return rec.value;
    }
    const value = await fetcher();
    await dbPut('cache', { key: cacheKey, value, fetchedAt: now });
    return value;
  }

  // クイズ専用の広いプール(getQuizPool)を取得。
  // - getAllHotItems と互換のshape: { ok, count, totalAll, makerCount, items[] }
  // - 必須フィルタは「商品名+メーカー+redFlag無し」のみで、スコア無し商品も含む
  // - キャッシュキーは 'quizPool' で、廃盤タブ(getAllHotItems)と分離
  async function fetchQuizPool(force = false) {
    if (force) {
      try { await dbDelete('cache', 'quizPool'); } catch (e) {}
    }
    return getCachedOrFetch('quizPool', ITEMS_CACHE_TTL_MS, async () => {
      const resp = await postHaiban('getQuizPool');
      const items = Array.isArray(resp?.items) ? resp.items : [];
      // メタ情報(totalAll/makerCount)を items に乗せて持ち回す
      // (キャッシュ層は単一値を保存するため、配列にプロパティを生やす)
      try {
        Object.defineProperty(items, '__quizMeta', {
          value: {
            count: Number(resp?.count || items.length),
            totalAll: Number(resp?.totalAll || 0),
            makerCount: Number(resp?.makerCount || 0),
          },
          enumerable: false,
        });
      } catch (e) { /* ignore */ }
      return items;
    });
  }

  // 後方互換用: 内部の他関数(pickWeakMakers等)から fetchAllItems を呼んでいた箇所は
  // クイズ用プールに統一する(クイズの文脈では getQuizPool が正解)。
  async function fetchAllItems(force = false) {
    return fetchQuizPool(force);
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

    // 問題タイプが「プレ値推測」専用のときは、最安値が取れている商品のみを対象にする。
    // (getQuizPool はスコアnull商品も含むため、最安値が0/未取得の商品が混ざる可能性がある)
    if (settings.type === 'price_quiz') {
      const priced = pool.filter(it => Number(it['最安値'] || 0) > 0);
      // 件数が極端に減った場合のセーフティ: 3件以上残ったときだけ絞り込みを採用
      if (priced.length >= 3) pool = priced;
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

    // ── ここから出題分散ロジック ──
    // 直近Nセッションで出題された商品(ASIN)とメーカー別出現回数を取得
    const recentAsinSet = await getRecentAsinSet();
    const recentMakerCounts = await getRecentMakerCounts();

    // 復習モード/メーカー範囲限定モードでは「直近ASIN除外」を行わない（元々プールが狭いため）
    const enableRecentAsinExclude = !(opts.shortcut === 'review') &&
                                    !(settings.range === 'maker' && settings.rangeValue);

    // 直近24時間以内に出題したASINも「既習扱いから除外」できるように、historyからAt時刻も取得
    const allHistory = await dbGetAll('history');
    const recentAttemptedAsins = new Set();
    const cutoff = Date.now() - RECENT_HOURS_EXCLUDE * 60 * 60 * 1000;
    for (const h of allHistory) {
      if ((h.lastAttemptedAt || 0) >= cutoff) recentAttemptedAsins.add(h.asin);
    }

    // 直近セッションで出たASINはプールから可能な限り除外（ただし除外しすぎてプールが小さくなりすぎたら戻す）
    let workPool = pool;
    if (enableRecentAsinExclude && recentAsinSet.size > 0) {
      const filtered = pool.filter(it => !recentAsinSet.has(String(it.ASIN || '').trim()));
      const minPool = Math.max(10, (settings.questionCount === 'endless' ? 30 : settings.questionCount) * 2);
      if (filtered.length >= minPool) workPool = filtered;
    }

    // 難易度フィルタ
    const want = settings.questionCount === 'endless' ? 30 : settings.questionCount;

    if (settings.difficulty === 'easy') {
      const easy = workPool.filter(isEasyItem);
      if (easy.length >= 3) workPool = easy;
    } else if (settings.difficulty === 'hard') {
      // むずかしい: 未習中心 + スコアB/C中心
      const stats = await loadStats();
      // 24h以内に出題したASINは「未習側」に戻す（連続セッションでも新鮮味を保つ）
      const learned = new Set((stats.learnedAsins || []).filter(a => !recentAttemptedAsins.has(a)));
      const unlearned = workPool.filter(it => !learned.has(String(it.ASIN || '').trim()));
      const hardCands = workPool.filter(isHardCandidate);
      const unlearnedTarget = Math.ceil(want * 0.8);
      const learnedHard = workPool.filter(it => learned.has(String(it.ASIN || '').trim()) && isHardCandidate(it));
      const part1 = pickByMakerBalanced(unlearned.length ? unlearned : hardCands, unlearnedTarget, recentMakerCounts);
      const part2 = pickByMakerBalanced(learnedHard.length ? learnedHard : workPool, Math.max(0, want - part1.length), recentMakerCounts);
      const merged = shuffle([...part1, ...part2]);
      if (merged.length >= 3) {
        return merged.slice(0, want);
      }
      // フォールバック
      return pickByMakerBalanced(workPool, want, recentMakerCounts);
    } else {
      // ふつう: 既習30% / 未習70% （旧60/40から変更、24h以内出題は未習扱いに戻す）
      const stats = await loadStats();
      const learned = new Set((stats.learnedAsins || []).filter(a => !recentAttemptedAsins.has(a)));
      const learnedItems = workPool.filter(it => learned.has(String(it.ASIN || '').trim()));
      const unlearned    = workPool.filter(it => !learned.has(String(it.ASIN || '').trim()));
      if (learnedItems.length > 0 && unlearned.length > 0) {
        const part1Need = Math.round(want * LEARNED_RATIO_NORMAL);
        const part1 = pickByMakerBalanced(learnedItems, part1Need, recentMakerCounts);
        const part2 = pickByMakerBalanced(unlearned, Math.max(0, want - part1.length), recentMakerCounts);
        const merged = shuffle([...part1, ...part2]);
        if (merged.length >= 3) return merged.slice(0, want);
      }
      // フォールバック: メーカー均等抽選
      return pickByMakerBalanced(workPool, want, recentMakerCounts);
    }

    // easyや上記分岐でフォールバックされた場合
    return pickByMakerBalanced(workPool, want, recentMakerCounts);
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
    // 同ジャンルから優先的に選びつつ、ジャンル混在を許容して候補を広く取る
    const correctGenre = inferSimpleGenre(item);
    const sameGenreMakers = Array.from(new Set(
      allItems
        .filter(it => inferSimpleGenre(it) === correctGenre)
        .map(it => String(it['ブランド名'] || '').trim())
        .filter(Boolean)
    )).filter(m => m !== correct);
    const otherGenreMakers = allMakers.filter(m => m !== correct && !sameGenreMakers.includes(m));

    let decoys = pickRandom(sameGenreMakers, 3);
    if (decoys.length < 3) {
      // 不足分はジャンル外から補充
      const need = 3 - decoys.length;
      const extra = pickRandom(otherGenreMakers, need);
      decoys = [...decoys, ...extra];
    }
    return shuffle([correct, ...decoys]);
  }

  // ---------- 直近セッションの記録・参照 ----------
  async function getRecentSessions() {
    try {
      const all = await dbGetAll('recentSessions');
      // id降順（新しい順）
      return all.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, RECENT_SESSIONS_KEEP);
    } catch (e) { return []; }
  }

  // 直近Nセッションで出題されたASIN集合
  async function getRecentAsinSet() {
    const sessions = await getRecentSessions();
    const set = new Set();
    for (const s of sessions) {
      (s.asins || []).forEach(a => set.add(a));
    }
    return set;
  }

  // 直近Nセッションで出題されたメーカーごとの出現回数
  async function getRecentMakerCounts() {
    const sessions = await getRecentSessions();
    const counts = new Map();
    for (const s of sessions) {
      (s.makers || []).forEach(m => counts.set(m, (counts.get(m) || 0) + 1));
    }
    return counts;
  }

  // セッション完了時に出題内容を保存（直近Nセッションだけ残す）
  async function saveSessionRecord(items) {
    try {
      const asins = items.map(it => String(it.ASIN || '').trim()).filter(Boolean);
      const makers = Array.from(new Set(items.map(it => String(it['ブランド名'] || '').trim()).filter(Boolean)));
      await dbPut('recentSessions', {
        playedAt: Date.now(),
        asins,
        makers,
      });
      // 古いものを削除（id昇順で取得し、上限を超えた分を削除）
      const all = await dbGetAll('recentSessions');
      const sorted = all.sort((a, b) => (b.id || 0) - (a.id || 0));
      const keepIds = new Set(sorted.slice(0, RECENT_SESSIONS_KEEP).map(s => s.id));
      for (const s of sorted) {
        if (!keepIds.has(s.id)) {
          try { await dbDelete('recentSessions', s.id); } catch (e) {}
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- メーカー均等化抽選 ----------
  // メーカー単位でグルーピングし、直近頻出メーカーの重みを下げて抽選する
  // pool: 抽選対象の商品配列
  // n: 必要件数
  // recentMakerCounts: Map<maker, 出現セッション数>
  function pickByMakerBalanced(pool, n, recentMakerCounts) {
    if (pool.length === 0 || n <= 0) return [];
    if (pool.length <= n) return shuffle(pool);

    // メーカー別グルーピング
    const byMaker = new Map();
    for (const it of pool) {
      const m = String(it['ブランド名'] || '').trim() || '__unknown__';
      if (!byMaker.has(m)) byMaker.set(m, []);
      byMaker.get(m).push(it);
    }
    // 各メーカー内をシャッフル
    for (const arr of byMaker.values()) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }

    // メーカーリスト（直近多く出たメーカーは重みを下げる）
    const makerEntries = Array.from(byMaker.keys()).map(m => {
      const recent = recentMakerCounts.get(m) || 0;
      // 直近Nセッション中、k回出ていれば weight = RECENT_MAKER_WEIGHT^k
      // 例: 1回出 = 0.2、2回出 = 0.04、3回出 = 0.008 → ほぼ出ない
      const weight = recent > 0 ? Math.pow(RECENT_MAKER_WEIGHT, recent) : 1;
      return { maker: m, weight };
    });

    const out = [];
    const usedAsin = new Set();
    while (out.length < n) {
      // 残っている商品のあるメーカーだけ対象
      const candidates = makerEntries.filter(e => byMaker.get(e.maker).length > 0);
      if (candidates.length === 0) break;
      // 重み付き抽選
      const totalW = candidates.reduce((s, e) => s + e.weight, 0);
      let r = Math.random() * totalW;
      let chosen = candidates[candidates.length - 1];
      for (const e of candidates) {
        r -= e.weight;
        if (r <= 0) { chosen = e; break; }
      }
      const item = byMaker.get(chosen.maker).shift();
      const asinKey = String(item.ASIN || '').trim() || `name:${String(item['商品名'] || '').trim()}`;
      if (usedAsin.has(asinKey)) continue;
      usedAsin.add(asinKey);
      out.push(item);
    }
    return out;
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
        fetchQuizPool(),  // クイズ専用の広いプール(最大1,000件・49社)
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
      <div class="quiz-debug" id="quiz-debug-info" style="margin-top:8px;font-size:11px;color:#888;text-align:center;line-height:1.6;"></div>
    `;

    // デバッグ情報（プール件数・直近セッション情報）を非同期で表示
    (async () => {
      try {
        const recentSessions = await getRecentSessions();
        const recentMakerCounts = await getRecentMakerCounts();
        const totalPool = items.length;
        const withAsin = items.filter(it => String(it.ASIN || '').trim()).length;
        const uniqueMakers = new Set(items.map(it => String(it['ブランド名'] || '').trim()).filter(Boolean)).size;
        // getQuizPool 由来のメタ情報があればそれを優先（totalAll = 全監視商品数）
        const meta = items.__quizMeta || {};
        const totalAll = Number(meta.totalAll || 0);
        const makerCountApi = Number(meta.makerCount || 0);
        const debugEl = container.querySelector('#quiz-debug-info');
        if (debugEl) {
          const recentMakerStr = recentMakerCounts.size > 0
            ? ` ／ 直近よく出たメーカー: ${Array.from(recentMakerCounts.keys()).slice(0,3).join(', ')}`
            : '';
          // 例: 「データ: 全950件 / ASIN付930件 / メーカー42社 / 全監視5,028件中」
          const totalAllStr = totalAll > 0
            ? ` / 全監視${totalAll.toLocaleString()}件中`
            : '';
          const makerCountDisplay = makerCountApi > 0 ? makerCountApi : uniqueMakers;
          debugEl.textContent = `データ: 全${totalPool}件 / ASIN付${withAsin}件 / メーカー${makerCountDisplay}社${totalAllStr} ／ 直近${recentSessions.length}セッション記録${recentMakerStr}`;
        }
      } catch (e) { /* ignore */ }
    })();

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

    // 出題分散用：このセッションで出題した商品/メーカーを記録
    // 1問でも出題されていれば記録する（途中離脱でも次セッションに反映）
    if (session.questions && session.questions.length > 0) {
      saveSessionRecord(session.questions).catch(() => {});
    }

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
      // 旧クイズ用キャッシュキー(allItems)が残っていればお掃除
      // (v117 から quizPool に切り替えたため、古いプールを使い続けないように)
      try { await dbDelete('cache', 'allItems'); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  })();

  return {
    renderQuiz,
    updateQuizNavBadge,
    loadStats,
  };
})();
