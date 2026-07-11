// 地図の地域集約に使う副作用のない計算。
const MapUtils = (() => {
  function groupStoresByArea(stores, getArea) {
    const grouped = new Map();
    (stores || []).forEach(store => {
      const areaId = getArea(store);
      if (!grouped.has(areaId)) grouped.set(areaId, []);
      grouped.get(areaId).push(store);
    });
    return grouped;
  }

  function meanCenter(stores) {
    const points = (stores || [])
      .map(store => [Number(store.lat), Number(store.lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (!points.length) return null;
    return [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ];
  }

  return { groupStoresByArea, meanCenter };
})();
