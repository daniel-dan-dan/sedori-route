// ============================================================
// 簡易SPAルーター
// ============================================================

const Router = (() => {
  const routes = {};
  let currentView = null;
  const navViewByRoute = {
    home: 'home',
    'route-select': 'home',
    patrol: 'home',
    summary: 'home',
    history: 'history',
    'history-detail': 'history',
    analytics: 'analytics',
    haiban: 'haiban',
    quiz: 'quiz',
    settings: 'settings'
  };

  function syncNavigation(name) {
    const navView = navViewByRoute[name] || name;
    document.querySelectorAll('.nav-item').forEach(button => {
      const active = button.dataset.view === navView;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

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
      syncNavigation(name);
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
