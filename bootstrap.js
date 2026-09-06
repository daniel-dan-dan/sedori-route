// PWA更新確認と、CSPでinline handlerを使わない画像エラー処理。
(() => {
  function showUpdateWaiting() {
    if (document.getElementById('pwa-update-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'pwa-update-notice';
    notice.className = 'pwa-update-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = '更新版を準備しました。作業後にこのアプリの全タブを閉じ、開き直すと適用されます。';
    document.body.prepend(notice);
  }
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
      if (event.data && event.data.type === 'UPDATE_WAITING') showUpdateWaiting();
    });

    navigator.serviceWorker.register('sw.js?v=198', { updateViaCache: 'none' }).then(registration => {
      if (!registration) return;
      if (registration.waiting) showUpdateWaiting();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateWaiting();
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // 表示中のフォームを自動再読込しない。新規起動時に最新版を読む。
        navigator.serviceWorker.controller?.postMessage({ type: 'GET_VERSION' });
      });
      navigator.serviceWorker.ready.then(readyRegistration => {
        if (readyRegistration.active) readyRegistration.active.postMessage({ type: 'GET_VERSION' });
      });
    }).catch(error => showVersionCheckWarning(`Service Worker registration failed: ${error.message}`));
  }
})();
