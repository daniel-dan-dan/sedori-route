const GuideWorker = (() => {
  'use strict';
  function notice() {
    if(document.getElementById('pwa-update-notice')) return;
    const node=document.createElement('p');node.id='pwa-update-notice';node.className='pwa-update-notice';node.setAttribute('role','status');node.textContent='更新版を準備しました。ブランド図鑑のタブを閉じ、開き直すと適用されます。';document.body.prepend(node);
  }
  if(!('serviceWorker' in navigator)) return {ready:Promise.resolve(null)};
  navigator.serviceWorker.addEventListener('message',event=>{
    if(event.data?.type==='UPDATE_WAITING') notice();
    if(event.data?.type==='SW_VERSION' && event.data.cacheName !== 'brand-guide-v2' && String(event.data.cacheName).startsWith('brand-guide-')) notice();
  });
  navigator.serviceWorker.addEventListener('controllerchange',()=>navigator.serviceWorker.controller?.postMessage({type:'GET_VERSION'}));
  const ready=navigator.serviceWorker.register('sw.js?v=2',{scope:'./',updateViaCache:'none'}).then(registration=>{
    if(registration.waiting) notice();
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed' && registration.active) notice();});
    });
    if(registration.active) return registration;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('画面の保存を確認できませんでした。')),30000);
      const track=()=>{
        const worker=registration.installing || registration.waiting || registration.active;
        if(!worker) return;
        const check=()=>{
          if(worker.state==='activated'){clearTimeout(timeout);resolve(registration);}
          if(worker.state==='redundant'){clearTimeout(timeout);reject(new Error('画面を保存できませんでした。'));}
        };
        worker.addEventListener('statechange',check);check();
      };
      registration.addEventListener('updatefound',track);track();
    });
  }).catch(()=>null);
  return {ready};
})();
