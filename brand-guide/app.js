(() => {
  'use strict';
  const container = document.getElementById('app');
  BrandGuideSync.configureCredential(GuideCredentials.get);
  function element(tag, text, className) {
    const node = document.createElement(tag); if (text) node.textContent = text; if(className) node.className = className; return node;
  }
  function button(text, action) {
    const node = element('button',text,'bg-button'); node.type='button';node.addEventListener('click',action);return node;
  }
  function help() {
    const dialog = element('dialog',null,'bg-lightbox'); dialog.setAttribute('aria-label','ブランド図鑑の使い方');
    dialog.append(element('h2','ブランド図鑑をいつでも開く'),element('p','iPhone：Safariでこのページを開き、共有ボタンから「ホーム画面に追加」を選びます。'),element('p','Android：ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。'),element('p','初回は通信できる場所で開いてください。取り込み済みの写真・型番・参考記事の説明は、通信なしでも見られます。外部の記事を開くときは通信が必要です。'),button('閉じる',()=>dialog.close()));
    dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  }
  async function library({ force = false } = {}) {
    await BrandGuide.render(container,{standalone:true,forceSync:force,onHelp:help,onConnection:settings,cachePrefix:'brand-guide-',serviceWorkerReady:GuideWorker.ready});
  }
  function settings() {
    const root = element('section',null,'bg-setup');
    const back = button('‹ 図鑑に戻る',()=>library());
    const label = element('label','図鑑の接続コード'); const input = element('input');input.type='password';input.autocomplete='off';input.spellcheck=false;input.maxLength=512;label.append(input);
    const status = element('p','初回だけ接続コードを入力してください。iPhoneの単独アプリには、Safariや店舗アプリの接続情報は引き継がれません。接続すると、そのまま最新の資料を保存します。');status.setAttribute('role','status');
    const connect = button('この図鑑を接続する',async()=>{
      connect.disabled=true;back.disabled=true;input.disabled=true;status.textContent='この図鑑の接続を確認しています…';
      try { await GuideCredentials.connect(input.value.trim());input.value='';status.textContent='接続しました。最新の資料を保存しています…';await library({force:true}); }
      catch(error) { status.textContent=(error.name==='AbortError' ? '応答を確認できませんでした。再確認では同じ端末情報を使います。' : error.message)+' 保存済みの図鑑はそのまま使えます。'; }
      finally { connect.disabled=false;back.disabled=false;input.disabled=false; }
    });
    root.append(back,element('h1','図鑑の接続設定'),label,connect,status);container.replaceChildren(root);
  }
  document.addEventListener('DOMContentLoaded',()=>library().catch(()=>{container.textContent='図鑑を開けませんでした。もう一度開き直してください。';}));
})();
