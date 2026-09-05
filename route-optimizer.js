// ============================================================
// ルート最適化ロジック（Haversine + 最近傍法 + 2-opt）
// ============================================================

const RouteOptimizer = (() => {

  function finiteNumber_(value, label, min, max) {
    if (value === null || value === undefined || !['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !value.trim())) throw new Error(`${label}を入力してください`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${label}が不正です`);
    }
    return number;
  }

  function coordinates_(value, label) {
    return {
      lat: finiteNumber_(value?.lat, `${label}の緯度`, -90, 90),
      lng: finiteNumber_(value?.lng, `${label}の経度`, -180, 180),
    };
  }

  function routeInputs_(home, stores, avgSpeedKmh) {
    if (!Array.isArray(stores)) throw new Error('店舗一覧が不正です');
    const speed = finiteNumber_(avgSpeedKmh, '平均速度', Number.MIN_VALUE, Infinity);
    const normalized = stores.map((store, index) => {
      const missingStay = store?.avg_stay_min === null || store?.avg_stay_min === undefined ||
        (typeof store?.avg_stay_min === 'string' && !store.avg_stay_min.trim());
      return {
        ...store,
        ...coordinates_(store, `${index + 1}店舗目`),
        avg_stay_min: missingStay ? 30 : finiteNumber_(store.avg_stay_min, `${index + 1}店舗目の滞在時間`, 0, Infinity),
      };
    });
    return { home: coordinates_(home, '出発地点'), stores: normalized, speed };
  }

  function estimatedMinutes_(driveMin, stayMin) {
    const total = driveMin + stayMin;
    if (!Number.isFinite(total)) throw new Error('移動時間と滞在時間を計算できません。速度・滞在時間を確認してください');
    return Math.round(total);
  }

  // Haversine距離（km）
  function haversine(lat1, lng1, lat2, lng2) {
    const from = coordinates_({ lat: lat1, lng: lng1 }, '出発地点');
    const to = coordinates_({ lat: lat2, lng: lng2 }, '目的地点');
    ({ lat: lat1, lng: lng1 } = from);
    ({ lat: lat2, lng: lng2 } = to);
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    const bounded = Math.max(0, Math.min(1, a));
    return R * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
  }

  // 距離行列を生成（自宅 + 店舗群）
  function buildDistMatrix(home, stores) {
    const points = [home, ...stores];
    const n = points.length;
    const dist = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = haversine(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
        dist[i][j] = d;
        dist[j][i] = d;
      }
    }
    return dist;
  }

  // 最近傍法（自宅 = index 0 からスタート、自宅に戻る）
  function nearestNeighbor(dist, n) {
    const visited = new Set([0]);
    const route = [0];
    let current = 0;
    for (let step = 1; step < n; step++) {
      let nearest = -1, minDist = Infinity;
      for (let j = 1; j < n; j++) {
        if (!visited.has(j) && dist[current][j] < minDist) {
          minDist = dist[current][j];
          nearest = j;
        }
      }
      if (nearest < 0) break;
      visited.add(nearest);
      route.push(nearest);
      current = nearest;
    }
    route.push(0); // 自宅に戻る
    return route;
  }

  // 総距離計算
  function totalDistance(route, dist) {
    let sum = 0;
    for (let i = 0; i < route.length - 1; i++) {
      sum += dist[route[i]][route[i + 1]];
    }
    return sum;
  }

  // 2-opt改善（店舗部分のみ入れ替え、始点と終点は自宅固定）
  function twoOpt(route, dist) {
    const n = route.length;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < n - 2; i++) {
        for (let j = i + 1; j < n - 1; j++) {
          const d1 = dist[route[i - 1]][route[i]] + dist[route[j]][route[j + 1]];
          const d2 = dist[route[i - 1]][route[j]] + dist[route[i]][route[j + 1]];
          if (d2 < d1 - 0.001) {
            // i〜j間を反転
            const reversed = route.slice(i, j + 1).reverse();
            route.splice(i, j - i + 1, ...reversed);
            improved = true;
          }
        }
      }
    }
    return route;
  }

  // メイン最適化関数
  // home: { lat, lng }
  // stores: [{ store_id, lat, lng, priority_score, ... }]
  // 戻り値: { orderedStores, totalDistanceKm, estimatedMinutes }
  function optimize(home, stores, avgSpeedKmh = 30) {
    const input = routeInputs_(home, stores, avgSpeedKmh);
    home = input.home;
    stores = input.stores;
    avgSpeedKmh = input.speed;
    if (stores.length === 0) return { orderedStores: [], totalDistanceKm: 0, estimatedMinutes: 0 };
    if (stores.length === 1) return calcSelectionOrder(home, stores, avgSpeedKmh);

    const storesWithCoords = stores.map(s => ({
      ...s,
      lat: Number(s.lat),
      lng: Number(s.lng)
    }));

    const dist = buildDistMatrix(
      { lat: Number(home.lat), lng: Number(home.lng) },
      storesWithCoords
    );

    const n = storesWithCoords.length + 1; // 自宅 + 店舗数
    let route = nearestNeighbor(dist, n);
    route = twoOpt(route, dist);

    const totalKm = totalDistance(route, dist);
    // 巡回順の店舗配列（自宅を除く）
    const orderedStores = route.slice(1, -1).map(idx => storesWithCoords[idx - 1]);

    // 推定時間 = 移動時間 + 滞在時間
    const driveMin = totalKm / avgSpeedKmh * 60;
    const stayMin = orderedStores.reduce((s, st) => s + st.avg_stay_min, 0);

    return {
      orderedStores,
      totalDistanceKm: Math.round(totalKm * 10) / 10,
      estimatedMinutes: estimatedMinutes_(driveMin, stayMin)
    };
  }

  // Google Maps URLはモバイルブラウザの上限（経由地3件）に合わせ、4店舗ずつ分割する。
  const MAPS_MAX_STOPS_PER_SEGMENT = 4;

  function buildMapsUrl_(orderedStores) {
    if (orderedStores.length === 0) return '';
    // originを省略し、各区間を開いた時点の現在地を出発地にする。
    const lastStore = orderedStores[orderedStores.length - 1];
    const dest = encodeURIComponent(`${lastStore.lat},${lastStore.lng}`);
    const waypoints = orderedStores
      .slice(0, -1)
      .map(s => `${s.lat},${s.lng}`)
      .join('|');
    let url = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
    if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
    return url;
  }

  function generateMapsSegments(home, orderedStores) {
    if (!Array.isArray(orderedStores)) throw new Error('店舗一覧が不正です');
    orderedStores = orderedStores.map((store, index) => ({ ...store, ...coordinates_(store, `${index + 1}店舗目`) }));
    const segments = [];
    for (let start = 0; start < orderedStores.length; start += MAPS_MAX_STOPS_PER_SEGMENT) {
      const segmentStores = orderedStores.slice(start, start + MAPS_MAX_STOPS_PER_SEGMENT);
      segments.push({
        url: buildMapsUrl_(segmentStores),
        startIndex: start,
        endIndex: start + segmentStores.length - 1,
        stores: segmentStores,
      });
    }
    return segments;
  }

  function generateMapsUrl(home, orderedStores) {
    return generateMapsSegments(home, orderedStores)[0]?.url || '';
  }

  // 選択順ルートの距離・時間を計算（最適化なし、選択順そのまま）
  function calcSelectionOrder(home, stores, avgSpeedKmh = 30) {
    const input = routeInputs_(home, stores, avgSpeedKmh);
    home = input.home;
    stores = input.stores;
    avgSpeedKmh = input.speed;
    if (stores.length === 0) return { orderedStores: [], totalDistanceKm: 0, estimatedMinutes: 0 };

    const storesWithCoords = stores.map(s => ({
      ...s,
      lat: Number(s.lat),
      lng: Number(s.lng)
    }));
    const homeCoords = { lat: Number(home.lat), lng: Number(home.lng) };

    // 自宅→店舗1→店舗2→...→店舗N→自宅 の総距離
    let totalKm = 0;
    let prev = homeCoords;
    for (const s of storesWithCoords) {
      totalKm += haversine(prev.lat, prev.lng, s.lat, s.lng);
      prev = s;
    }
    totalKm += haversine(prev.lat, prev.lng, homeCoords.lat, homeCoords.lng);

    const driveMin = totalKm / avgSpeedKmh * 60;
    const stayMin = storesWithCoords.reduce((sum, s) => sum + s.avg_stay_min, 0);

    return {
      orderedStores: storesWithCoords,
      totalDistanceKm: Math.round(totalKm * 10) / 10,
      estimatedMinutes: estimatedMinutes_(driveMin, stayMin)
    };
  }

  return { optimize, calcSelectionOrder, generateMapsUrl, generateMapsSegments, haversine };
})();
