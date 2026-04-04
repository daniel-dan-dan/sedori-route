// ============================================================
// 簡易SPAルーター
// ============================================================

const Router = (() => {
  const routes = {};
  let currentView = null;

  function register(name, renderFn) {
    routes[name] = renderFn;
  }

  function navigate(name, params = {}) {
    const container = document.getElementById('app');
    if (!container) return;
    if (routes[name]) {
      const changed = currentView !== name;
      currentView = name;
      if (window.location.hash !== '#' + name) {
        window.location.hash = name;
      }
      container.innerHTML = '';
      routes[name](container, params);
    }
  }

  function getCurrentView() { return currentView; }

  // hashchange で戻る/進むに対応
  window.addEventListener('hashchange', () => {
    const name = window.location.hash.slice(1) || 'home';
    if (name !== currentView && routes[name]) {
      navigate(name);
    }
  });

  return { register, navigate, getCurrentView };
})();
