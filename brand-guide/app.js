(() => {
  'use strict';
  const container = document.getElementById('app');
  BrandGuideSync.configurePublicRead();
  function element(tag, text, className) {
    const node = document.createElement(tag); if (text) node.textContent = text; if(className) node.className = className; return node;
  }
  function button(text, action) {
    const node = element('button',text,'bg-button'); node.type='button';node.addEventListener('click',action);return node;
  }
  function help() {
    const dialog = element('dialog',null,'bg-lightbox'); dialog.setAttribute('aria-label','アパレル図鑑の使い方');
    dialog.append(element('h2','アパレル図鑑をいつでも開く'),element('p','iPhone：Safariでこのページを開き、共有ボタンから「ホーム画面に追加」を選びます。'),element('p','Android：ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。'),element('p','初回は通信できる場所で開いてください。取り込み済みの写真・型番・参考記事の説明は、通信なしでも見られます。外部の記事を開くときは通信が必要です。'),button('閉じる',()=>dialog.close()));
    dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  }
  async function library({ force = false } = {}) {
    await BrandGuide.render(container,{standalone:true,publicRead:true,forceSync:force,onHelp:help,cachePrefix:'brand-guide-',serviceWorkerReady:GuideWorker.ready});
  }
  document.addEventListener('DOMContentLoaded',()=>library().catch(()=>{container.textContent='図鑑を開けませんでした。もう一度開き直してください。';}));
})();
