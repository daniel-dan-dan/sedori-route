// ============================================================
// ルート最適化ロジック（Haversine + 最近傍法 + 2-opt）
// ============================================================

const RouteOptimizer = (() => {

  // Haversine距離（km）
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    if (stores.length === 0) return { orderedStores: [], totalDistanceKm: 0, estimatedMinutes: 0 };
    if (stores.length === 1) {
      const d = haversine(home.lat, home.lng, stores[0].lat, stores[0].lng) * 2;
      return {
        orderedStores: stores,
        totalDistanceKm: Math.round(d * 10) / 10,
        estimatedMinutes: Math.round(d / avgSpeedKmh * 60)
      };
    }

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
    const stayMin = orderedStores.reduce((s, st) => s + (Number(st.avg_stay_min) || 30), 0);

    return {
      orderedStores,
      totalDistanceKm: Math.round(totalKm * 10) / 10,
      estimatedMinutes: Math.round(driveMin + stayMin)
    };
  }

  // Google Maps ナビURL生成
  function generateMapsUrl(home, orderedStores) {
    if (orderedStores.length === 0) return '';
    // originを省略→Google Mapsが現在地を自動使用
    const lastStore = orderedStores[orderedStores.length - 1];
    const dest = `${lastStore.lat},${lastStore.lng}`;
    const waypoints = orderedStores.slice(0, -1).map(s => `${s.lat},${s.lng}`).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
    if (waypoints) url += `&waypoints=${waypoints}`;
    return url;
  }

  // 選択順ルートの距離・時間を計算（最適化なし、選択順そのまま）
  function calcSelectionOrder(home, stores, avgSpeedKmh = 30) {
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
    const stayMin = storesWithCoords.reduce((sum, s) => sum + (Number(s.avg_stay_min) || 30), 0);

    return {
      orderedStores: storesWithCoords,
      totalDistanceKm: Math.round(totalKm * 10) / 10,
      estimatedMinutes: Math.round(driveMin + stayMin)
    };
  }

  return { optimize, calcSelectionOrder, generateMapsUrl, haversine };
})();
