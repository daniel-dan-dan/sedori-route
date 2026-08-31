// PWA更新確認と、CSPでinline handlerを使わない画像エラー処理。
(() => {
  function showVersionCheckWarning(message) {
    console.error(message);
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = 'アプリ更新の版数不一致があります';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function checkPwaVersion(cacheName) {
    const badge = document.getElementById('app-version-badge');
    const appVersion = badge ? (badge.dataset.version || badge.textContent.trim()) : '';
    const swVersion = (String(cacheName || '').match(/v\d+/) || [])[0] || '';
    if (appVersion && swVersion && appVersion !== swVersion) {
      showVersionCheckWarning(`PWA version mismatch: screen=${appVersion}, serviceWorker=${swVersion}`);
    }
  }

  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const behavior = String(image.dataset.imageError || '');
    if (!behavior) return;
    image.dataset.imageError = '';
    image.style.display = 'none';
    if (behavior === 'hide-parent') {
      const parent = image.closest('.haiban-thumb-wrap');
      if (parent) parent.style.display = 'none';
      return;
    }
    if (behavior === 'quiz-keepa-fallback') {
      const fallback = document.getElementById('quiz-keepa-fallback');
      if (fallback) fallback.style.display = 'block';
    }
  }, true);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'SW_VERSION') checkPwaVersion(event.data.cacheName);
    });

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(registration => {
      if (!registration) return;
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.ready.then(readyRegistration => {
        if (readyRegistration.active) readyRegistration.active.postMessage({ type: 'GET_VERSION' });
      });
    }).catch(error => showVersionCheckWarning(`Service Worker registration failed: ${error.message}`));
  }
})();
