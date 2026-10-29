/* Private product records are loaded only from the existing verified library. */
const AllGenre = (() => {
  'use strict';
  const norm = value => value.normalize('NFKC').toLowerCase().replace(/[\s・._-]/g, '');
  function subgenre(p) {return AllGenreData.subgenre(p);}
  function subgenres(products,genre) {
    if(!genre)return [];
    return [...new Set(products.filter(p=>p.genre===genre).map(subgenre))];
  }
  function select(products, genre, brand, query, small='', middle='') {
    const terms = query.normalize('NFKC').split(/[\s,、]+/).filter(Boolean).map(norm);
    return products.filter(p => (!genre || p.genre === genre) && (!middle || p.middle === middle) && (!brand || p.brand === brand) && (!small || subgenre(p)===small) && terms.every(t => norm([p.name,p.brand,p.model,p.genre,subgenre(p),...p.features.map(f=>f.label)].join(' ')).includes(t)));
  }
  function listedBrands(records) {
    return [...new Set(records.map(p=>p.brand).filter(name=>name && !name.includes('未確認')))].sort((a,b)=>a.localeCompare(b,'ja'));
  }
  function el(tag, text, cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; }
  function readGuides(value) {return AllGenreData.readGuides(value);}
  function button(text, action, cls='ag-button') { const n=el('button',text,cls);n.type='button';n.addEventListener('click',action);return n; }
  function link(text,url) { const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener noreferrer';n.referrerPolicy='no-referrer';return n; }
  function photo(p) { const n=el('img');if(typeof BrandGuide.setImage==='function')BrandGuide.setImage(n,p.photo);else n.src=p.photo.image;n.alt=p.name+(p.photo.fullProduct===false?'の参考画像':'の商品全体');n.loading='lazy';n.decoding='async';return n; }
  function showBrand(p) {return p.brand && !p.brand.includes('未確認') && !norm(p.name).includes(norm(p.brand));}
  function featureGroups(products) {
    const groups=new Map();
    for(const p of products)for(const f of p.features){
      const key=JSON.stringify([p.genre,subgenre(p),f.label,f.confirmed]);
      if(!groups.has(key))groups.set(key,{label:f.label,confirmed:f.confirmed,genre:p.genre,subgenre:subgenre(p),products:[]});
      const group=groups.get(key);if(!group.products.some(x=>x.id===p.id))group.products.push(p);
    }
    return [...groups.values()];
  }
  // Group shared advice once per subgenre. Short copy is curated with its
  // evidence in the private library; never infer or truncate a price claim.
  function quickGroups(records) {
    const groups=new Map(),unique=(xs,key)=>xs.filter((x,i)=>xs.findIndex(y=>key(y)===key(x))===i);
    for(const p of records){
      if(!p.guide && !p.features.length)continue;
      const key=JSON.stringify([p.genre,subgenre(p)]);
      if(!groups.has(key))groups.set(key,{genre:p.genre,subgenre:subgenre(p),records:[]});
      groups.get(key).records.push(p);
    }
    return [...groups.values()].map(g=>{
      const quick=p=>p.guide?p.quick:undefined;
      const cautions=unique(g.records.flatMap(p=>quick(p)?.cautions || []),x=>x).filter(x=>g.records.every(p=>quick(p)?.cautions.includes(x)));
      const targets=new Map();
      for(const p of g.records){
        const q=quick(p),name=q?.name || p.name,clue=q?.clue || '',key=JSON.stringify([p.brand,name,clue]);
        if(!targets.has(key))targets.set(key,{record:p,name,clue,cautions:[]});
        const t=targets.get(key);t.cautions=unique([...t.cautions,...(q?.cautions || []).filter(x=>!cautions.includes(x))],x=>x);
      }
      return {...g,
        points:unique(g.records.flatMap(p=>quick(p)?.points || p.features.map(f=>({text:f.label,confirmed:f.confirmed}))),p=>JSON.stringify([p.text,p.confirmed])),
        targets:[...targets.values()],
        checks:unique(g.records.map(p=>quick(p)?.check).filter(Boolean),x=>x),cautions
      };
    });
  }
  function readValueFactors(value,records) {return AllGenreData.readValueFactors(value,records);}
  function factorEntries(records,reviewed=[]) {
    const byId=new Map(records.map(p=>[p.id,p]));
    return reviewed.map(f=>({...f,records:f.sourceIds.filter(id=>byId.has(id)).map(id=>byId.get(id))})).filter(f=>f.records.length);
  }
  function icon(name) {const n=el('span',undefined,'ag-icon ag-'+name);n.setAttribute('aria-hidden','true');return n;}
  function rowButton(text,action,cls='ag-category') {
    const n=button('',action,cls);n.append(el('span',text,'ag-row-label'),icon('chevron-right'));return n;
  }
  function disclosure(label,cls='ag-disclosure') {
    const d=el('details',undefined,cls),s=el('summary');s.append(el('span',label),icon('chevron-right'));d.append(s);return d;
  }
  function mount(root, options={}) {
    const browser=typeof window!=='undefined'?window:null;
    let record=null,guides=[],valueFactors=[],pending=null,request=0,serial=0,active=!root.hidden;
    const session='guide-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const frames=new Map();
    function frame(type,patch={}) {
      const f={id:++serial,parentId:null,type,genre:'',middle:'',small:'',brand:'',query:'',brandOpen:false,scrollY:0,focusKey:'',...patch};
      frames.set(f.id,f);return f;
    }
    let current=frame('genres'),page=null,status=null,photoDialog=null;
    let touch=null,preview=null,moving=false,settling=false,swipeTimer=null,offset=0,swipeWidth=0,suppressClickUntil=0;
    const allRows=()=>record?[...record.products,...guides]:[];
    const categories=()=>[...new Set(allRows().map(p=>p.genre))];
    const baseProducts=f=>record?select(record.products,f.genre,'','',f.small,f.middle):[];
    function factors(f) {
      const scope=select(allRows(),f.genre,'','',f.small,f.middle);
      return GuideOrganize.factors(factorEntries(scope,valueFactors));
    }
    const raf=callback=>browser?.requestAnimationFrame?browser.requestAnimationFrame(callback):callback();
    function marker(pane='all-genre') {return {session,id:current.id,pane};}
    function writeHistory(push=false,pane='all-genre') {
      const history=browser?.history;if(!history?.replaceState)return;
      const state={...(history.state||{}),guideAllGenre:marker(pane)};
      try {history[push?'pushState':'replaceState'](state,'');}catch{/* The in-page back control still works if browser history is unavailable. */}
    }
    function remember() {
      if(active)current.scrollY=Math.max(0,Number(browser?.scrollY)||0);
      const focused=document.activeElement;
      if(focused?.dataset?.agKey)current.focusKey=focused.dataset.agKey;
    }
    function restorePosition(f,focus=false) {
      if(!active)return;
      const restore=()=>{if(current!==f||!active)return;browser?.scrollTo?.(0,f.scrollY);};
      restore();raf(restore);
      if(focus){
        const target=[...(page?.querySelectorAll?.('[data-ag-key]')||[])].find(n=>n.dataset.agKey===f.focusKey);
        // Never restore focus to a search input: that would reopen a mobile keyboard.
        (target&&!['INPUT','TEXTAREA','SELECT'].includes(target.tagName)?target:page?.querySelector?.('h1'))?.focus?.({preventScroll:true});
      }
    }
    function key(node,value) {node.dataset.agKey=value;return node;}
    function closePhoto() {if(photoDialog){const d=photoDialog;photoDialog=null;d.close();d.remove();}}
    function openPhoto(p,trigger) {
      closePhoto();const d=el('dialog',undefined,'ag-photo-dialog');d.setAttribute('aria-label',p.name+'の写真');
      const close=button('閉じる',()=>d.close(),'ag-photo-close');
      const image=photo(p);image.loading='eager';d.append(close,image);
      d.addEventListener('close',()=>{if(photoDialog===d)photoDialog=null;d.remove();if(active&&trigger.isConnected!==false)trigger.focus({preventScroll:true});});
      document.body.append(d);photoDialog=d;d.showModal();
    }
    function clearSwipe() {
      if(swipeTimer!==null)clearTimeout(swipeTimer);swipeTimer=null;
      preview?.remove();preview=null;
      page?.style?.removeProperty('transform');page?.style?.removeProperty('transition');
      root.classList?.remove('ag-swipe-moving');touch=null;moving=settling=false;offset=0;
    }
    function install(next) {record=next.record;guides=next.guides;valueFactors=next.valueFactors;pending=null;}
    function valid(f) {
      if(f.type==='genres')return true;
      if(!categories().includes(f.genre))return false;
      if(f.middle&&!GuideTaxonomy.middles(allRows(),f.genre).includes(f.middle))return false;
      if(f.small&&!GuideTaxonomy.leaves(allRows(),f.genre,f.middle).includes(f.small))return false;
      return f.type!=='product'||record.products.some(p=>p.id===f.productId);
    }
    function validAncestor(f) {
      let candidate=f;
      while(candidate&&!valid(candidate))candidate=frames.get(candidate.parentId);
      return candidate||frame('genres');
    }
    function move(type,patch={},trigger=null) {
      if(!record)return;
      remember();if(trigger?.dataset?.agKey)current.focusKey=trigger.dataset.agKey;
      closePhoto();clearSwipe();
      const next=frame(type,{genre:current.genre,middle:current.middle,small:current.small,parentId:current.id,...patch});
      current=next;writeHistory(true);render();restorePosition(current,true);
    }
    function restoreFrame(f) {
      closePhoto();clearSwipe();if(pending)install(pending);
      current=validAncestor(f);render();writeHistory(false);restorePosition(current,true);
    }
    function back() {
      if(!current.parentId||settling)return;
      remember();const previous=frames.get(current.parentId);if(!previous)return;
      const state=browser?.history?.state?.guideAllGenre;
      if(active&&state?.session===session&&state.id===current.id&&typeof browser?.history?.back==='function')browser.history.back();
      else restoreFrame(previous);
    }
    function restoreHistory(state) {
      if(!state||state.session!==session)return false;
      const f=frames.get(state.id);if(!f)return false;
      if(state.pane==='app') {
        if(active)remember();active=false;closePhoto();clearSwipe();
        // Forward navigation can return to an apparel-tab history entry whose
        // saved all-genre detail differs from the currently rendered list.
        current=validAncestor(f);render();options.onApp?.();return true;
      }
      if(!active){active=true;options.onActivate?.();}
      restoreFrame(f);return true;
    }
    function chooseGenre(g,trigger) {
      const mids=GuideTaxonomy.middles(allRows(),g);
      if(mids.length===1)return chooseMiddle(mids[0],trigger,g);
      move('middles',{genre:g,middle:'',small:''},trigger);
    }
    function chooseMiddle(m,trigger,g=current.genre) {
      const leaves=GuideTaxonomy.leaves(allRows(),g,m);
      if(leaves.length===1)move('products',{genre:g,middle:m,small:leaves[0]},trigger);
      else move('leaves',{genre:g,middle:m,small:''},trigger);
    }
    function header(f,title,container,cls='') {
      const h=el('header',undefined,'ag-header'+(cls?' '+cls:''));
      if(f.parentId){const b=key(button('',back,'ag-back'),'back');b.append(icon('chevron-left'),el('span','戻る'));h.append(b);}
      const heading=el('h1',title,'ag-title bg-title');heading.tabIndex=-1;h.append(heading);container.append(h);return h;
    }
    function renderCategories(f,container) {
      const title=f.type==='genres'?'オールジャンル図鑑':f.type==='middles'?f.genre:f.middle;
      header(f,title,container);
      const names=f.type==='genres'?categories():f.type==='middles'?GuideTaxonomy.middles(allRows(),f.genre):GuideTaxonomy.leaves(allRows(),f.genre,f.middle);
      const list=el('div',undefined,'ag-category-list');list.setAttribute('aria-label',title);
      for(const name of names){
        const b=key(rowButton(name,()=>{
          if(current!==f)return;
          if(f.type==='genres')chooseGenre(name,b);
          else if(f.type==='middles')chooseMiddle(name,b);
          else move('products',{small:name},b);
        }),'category:'+name);list.append(b);
      }
      container.append(list);
      if(!names.length)container.append(el('p','この分類の情報はまだありません。','ag-muted'));
      if(f.type==='genres'&&record.held.length){
        const held=disclosure('資料確認待ち '+record.held.length+'商品','ag-held ag-disclosure');
        for(const p of record.held)held.append(el('p',p.name+' — '+p.reason,'ag-muted'));container.append(held);
      }
    }
    function renderProducts(f,container) {
      header(f,f.small||f.middle||f.genre,container);
      const path=el('div',undefined,'ag-current-path');
      path.append(el('span',[f.genre,f.middle].filter((x,i,a)=>x&&a.indexOf(x)===i).join(' › '),'ag-path-label'));
      path.append(key(button('変更',()=>move('genres',{},path.querySelector('button')),'ag-change'),'change-category'));container.append(path);
      const base=baseProducts(f),brands=GuideOrganize.brands(base);
      if(!brands.some(b=>b.name===f.brand))f.brand='';
      const search=key(el('input',undefined,'ag-search'),'search');search.type='search';search.placeholder='商品名・型番で検索';search.value=f.query;search.setAttribute('aria-label','この分類の商品を検索');
      container.append(search);
      const brandsBox=disclosure('ブランドで絞る','ag-brand-picker ag-disclosure');brandsBox.open=f.brandOpen;brandsBox.hidden=!brands.length;
      const brandList=el('div',undefined,'ag-brand-list');
      const brandTitle=brandsBox.querySelector('summary span');
      function setBrand(name){f.brand=name;f.brandOpen=false;brandsBox.open=false;updateBrandButtons();renderRows();brandsBox.querySelector('summary')?.focus({preventScroll:true});}
      const clear=key(button('絞り込みを解除',()=>setBrand(''),'ag-clear-brand'),'clear-brand');
      for(const brand of brands){const b=key(button(brand.name,()=>setBrand(f.brand===brand.name?'':brand.name),'ag-brand'),'brand:'+brand.name);b.dataset.brand=brand.name;brandList.append(b);}
      brandList.append(clear);brandsBox.append(brandList);brandsBox.addEventListener('toggle',()=>{f.brandOpen=brandsBox.open;});container.append(brandsBox);
      function updateBrandButtons(){
        if(brandTitle)brandTitle.textContent=f.brand?'ブランド：'+f.brand:'ブランドで絞る';
        for(const b of brandList.children){if(b.dataset.brand)b.setAttribute('aria-pressed',String(b.dataset.brand===f.brand));}clear.hidden=!f.brand;
      }
      updateBrandButtons();
      const traits=factors(f);
      if(traits.length){const b=key(rowButton('高値要素を見る',()=>move('factors',{},b),'ag-factor-link ag-disclosure-link'),'factors');container.append(b);}
      const section=el('section',undefined,'ag-product-section');
      const listTitle=el('div',undefined,'ag-list-title'),count=el('span','','ag-result-count');count.setAttribute('role','status');listTitle.append(el('h2','商品例','ag-section-title'),count);
      const list=el('div',undefined,'ag-product-list'),empty=el('p','該当する商品はありません。','ag-muted');section.append(listTitle,list,empty);container.append(section);
      function renderRows(){
        const selected=brands.find(b=>b.name===f.brand);
        const result=select(base,f.genre,'',f.query,f.small,f.middle).filter(p=>!selected||selected.names.includes(p.brand));
        list.replaceChildren();count.textContent=result.length+'件';empty.hidden=!!result.length;
        section.hidden=!base.length;
        for(const p of result){
          const b=key(button('',()=>move('product',{productId:p.id},b),'ag-product-row'),'product:'+p.id);
          const image=photo(p);image.className='ag-product-image';b.append(image);
          const body=el('div',undefined,'ag-product-body');if(showBrand(p))body.append(el('p',p.brand,'ag-eyebrow'));body.append(el('h3',p.name));
          if(p.kind==='紹介・比較例')body.append(el('span','紹介例','ag-example-badge'));
          b.append(body,icon('chevron-right'));list.append(b);
        }
      }
      search.addEventListener('input',()=>{f.query=search.value;renderRows();});renderRows();
      if(!base.length&&!traits.length)container.append(el('p','この分類の情報はまだありません。','ag-muted'));
    }
    function renderProduct(f,container) {
      container.classList.add('ag-detail-page');const p=record.products.find(p=>p.id===f.productId);if(!p)return;
      const h=header(f,p.name,container,'ag-product-header');
      if(showBrand(p)){const brand=el('p',p.brand,'ag-eyebrow');h.insertBefore(brand,h.querySelector('h1'));}
      const imageButton=key(button('',()=>openPhoto(p,imageButton),'ag-hero-image'),'photo');imageButton.setAttribute('aria-label',p.name+'の写真を拡大');
      const image=photo(p);image.className='ag-detail-image';image.loading='eager';imageButton.append(image);container.append(imageButton);
      if(p.photo.fullProduct===false)container.append(el('p',p.photo.label,'ag-muted'));
      if(p.checks.length){const section=el('section',undefined,'ag-checks');section.append(el('h2','店頭で確認','ag-section-title'));const ul=el('ul');for(const check of p.checks)ul.append(el('li',check));section.append(ul);container.append(section);}
      const info=disclosure('型番・価格・詳しい説明');info.append(el('p',p.model||'型番：未確認'));
      if(p.identity)info.append(el('p',p.identity,'ag-muted'));
      if(p.kind==='紹介・比較例')info.append(el('p','動画の紹介例','ag-muted'));
      const prices=el('dl',undefined,'ag-prices');for(const pair of p.prices)prices.append(el('dt',pair[0]),el('dd',pair[1]));if(p.prices.length)info.append(prices);
      info.append(el('p',p.kind==='紹介・比較例'?'動画で紹介された比較例です。今回の仕入れ品の実売・利益ではありません。':'動画当時の価格です。その他費用が未確認のため、確定利益ではありません。','ag-muted'));
      for(const feature of p.features)info.append(el('h3',feature.label+(feature.confirmed?'（動画の説明）':'（要確認）')),el('p',feature.note));
      for(const note of p.notes)info.append(el('p',note,'ag-muted'));
      const sources=disclosure('出典');sources.append(el('p',p.photo.label,'ag-muted'));for(const e of p.evidence)sources.append(link(e.label,e.url));sources.append(link('画像の出典を開く',p.photo.source));
      container.append(info,sources);
    }
    function renderFactors(f,container) {
      container.classList.add('ag-factor-page');const h=header(f,'高値要素',container);
      h.insertBefore(el('p',f.small||f.middle||f.genre,'ag-eyebrow'),h.querySelector('h1'));
      const entries=factors(f);
      function checks(source,parent){if(!source.checks.length)return;parent.append(el('h3','店頭で確認'));const ul=el('ul');for(const text of source.checks)ul.append(el('li',text));parent.append(ul);}
      for(const group of entries){
        const item=el('section',undefined,'ag-factor-item');item.append(el('h2',group.label,'ag-section-title'));
        if(!group.confirmed)item.append(el('span','要確認','ag-factor-pending'));
        if(group.sharedSummary||group.variants.length===1)item.append(el('p',group.explanation,'ag-factor-description'));
        else for(const variant of group.variants){const condition=el('section',undefined,'ag-factor-condition');condition.append(el('h3',variant.label),el('p',variant.explanation,'ag-factor-description'));if(!variant.confirmed)condition.append(el('span','要確認','ag-factor-pending'));item.append(condition);}
        const evidence=disclosure('根拠・商品例','ag-factor-evidence ag-disclosure');
        if(group.sharedSummary)checks(group,evidence);
        for(const variant of group.variants){
          const source=el('section');if(group.variants.length>1)source.append(el('h3',variant.label));
          if(group.sharedSummary)source.append(el('p',variant.explanation));checks(variant,source);
          for(const e of variant.evidence)source.append(link(e.label,e.url));
          for(const p of variant.records)source.append(el('p',(showBrand(p)?p.brand+' / ':'')+p.name,'ag-muted'));evidence.append(source);
        }
        item.append(evidence);container.append(item);
      }
      if(!entries.length)container.append(el('p','この分類の高値要素はまだありません。','ag-muted'));
    }
    function build(f) {
      const container=el('div',undefined,'ag-page');container.dataset.view=f.type;
      if(['genres','middles','leaves'].includes(f.type))renderCategories(f,container);
      else if(f.type==='products')renderProducts(f,container);
      else if(f.type==='product')renderProduct(f,container);
      else if(f.type==='factors')renderFactors(f,container);
      return container;
    }
    function render() {
      clearSwipe();page=record?build(current):el('div',undefined,'ag-page');
      if(!record)header(current,'オールジャンル図鑑',page);
      status=el('p','','ag-status ag-muted');status.hidden=true;status.setAttribute('role','status');root.replaceChildren(page,status);
    }
    function message(text) {if(!status)render();status.textContent=text;status.hidden=!text;}
    async function refresh() {
      const ticket=++request;
      try {
        const saved=await BrandGuide.load();if(ticket!==request)return;
        const next=saved?.data?.allGenre;
        if(!next){if(!record)message('商品資料はまだ保存されていません。');return;}
        if(next.revision===record?.revision||next.revision===pending?.record.revision){message('');return;}
        // Validate source scope before non-destructive display projection.
        const nextGuides=readGuides(next.guides),nextFactors=readValueFactors(next.valueFactors,[...next.products,...nextGuides]);
        const project=p=>GuideTaxonomy.project(p,subgenre(p));
        const products=next.products.map(project),learning=nextGuides.map(project);
        const snapshot={record:{...next,products},guides:learning,valueFactors:GuideTaxonomy.factors(nextFactors,[...products,...learning])};
        // Do not replace the image, source or scroll position of an opened detail.
        if(record&&['product','factors'].includes(current.type)){pending=snapshot;message('');return;}
        remember();install(snapshot);current=validAncestor(current);render();writeHistory(false,active?'all-genre':'app');restorePosition(current);
      }catch {if(ticket!==request)return;message('保存済み資料を読み込めませんでした。もう一度この画面を開いてください。');}
    }
    function activate() {active=true;writeHistory();restorePosition(current);return refresh();}
    function deactivate() {remember();active=false;closePhoto();clearSwipe();writeHistory(false,'app');}
    function beginSwipe() {
      const prior=frames.get(current.parentId);if(!prior||!page)return false;
      const bounds=root.getBoundingClientRect();swipeWidth=bounds.width;
      if(!swipeWidth)return false;
      preview=el('div',undefined,'ag-swipe-preview');preview.inert=true;preview.setAttribute('aria-hidden','true');
      preview.style.left=bounds.left+'px';preview.style.width=bounds.width+'px';
      const under=build(prior);under.style.transform='translateY(-'+prior.scrollY+'px)';preview.append(under);root.insertBefore(preview,page);
      root.classList.add('ag-swipe-moving');moving=true;return true;
    }
    function slide(dx) {offset=Math.min(swipeWidth,Math.max(0,dx));page.style.transform='translate3d('+offset+'px,0,0)';preview.style.transform='translate3d('+((offset-swipeWidth)*.18)+'px,0,0)';}
    function settle(commit=false) {
      touch=null;if(!moving){clearSwipe();return;}
      settling=true;suppressClickUntil=Date.now()+400;
      const duration=browser?.matchMedia?.('(prefers-reduced-motion: reduce)').matches?0:200;
      page.style.transition=preview.style.transition='transform '+duration+'ms cubic-bezier(.2,.7,.2,1)';slide(commit?swipeWidth:0);
      swipeTimer=setTimeout(()=>{clearSwipe();if(commit&&active)back();},duration);
    }
    root.addEventListener('touchstart',event=>{
      if(!active||!current.parentId||settling||photoDialog||event.touches.length!==1)return;
      if(event.target.closest?.('input,textarea,select,dialog'))return;
      const t=event.touches[0];
      // Leave the browser's edge-back gesture to its own history handling.
      if(t.clientX<24)return;
      touch={x:t.clientX,y:t.clientY,id:t.identifier,time:event.timeStamp};
    },{passive:true});
    root.addEventListener('touchmove',event=>{
      if(!touch||settling)return;if(event.touches.length!==1){settle();return;}
      const t=event.touches[0];if(t.identifier!==touch.id){settle();return;}
      const dx=t.clientX-touch.x,dy=Math.abs(t.clientY-touch.y);
      if(!moving){if(dy>12&&dy>Math.abs(dx)){touch=null;return;}if(dx<12)return;if(dx<dy*1.35){touch=null;return;}if(!beginSwipe()){touch=null;return;}}
      if(event.cancelable)event.preventDefault();slide(dx);
    },{passive:false});
    root.addEventListener('touchend',event=>{
      if(!touch||settling)return;const start=touch,t=event.changedTouches?.[0];if(!t||t.identifier!==start.id){settle();return;}
      const dx=t.clientX-start.x,dy=Math.abs(t.clientY-start.y),speed=dx/Math.max(1,event.timeStamp-start.time);
      const commit=moving&&dx>Math.min(110,swipeWidth*.3)&&dx>dy*1.35 || moving&&dx>56&&speed>.6&&dx>dy*1.35;
      settle(commit);
    },{passive:true});
    root.addEventListener('touchcancel',()=>settle(),{passive:true});
    root.addEventListener('click',event=>{if(Date.now()<suppressClickUntil){event.preventDefault();event.stopPropagation();}},true);
    browser?.addEventListener?.('resize',()=>{if(moving||touch)clearSwipe();});
    browser?.addEventListener?.('popstate',event=>restoreHistory(event.state?.guideAllGenre));
    document.addEventListener('brand-guide-saved',()=>{if(active&&!root.hidden)refresh();});
    render();message('資料を読み込み中…');
    return {refresh,activate,deactivate,back,restoreHistory};
  }
  function init() {
    const apparel=document.getElementById('app'),root=document.getElementById('all-genre'),nav=document.getElementById('guide-tabs');if(!root||!nav)return;
    let active='app',apparelScroll=0;
    function showPane(next,fromHistory=false) {
      if(next===active){if(next==='all-genre'&&!fromHistory)view.refresh();return;}
      if(active==='app')apparelScroll=window.scrollY;else if(!fromHistory)view.deactivate();
      active=next;apparel.hidden=next!=='app';root.hidden=next!=='all-genre';document.title=next==='app'?'アパレル図鑑':'オールジャンル図鑑';
      for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.pane===next));
      if(next==='all-genre'){if(!fromHistory)view.activate();}else window.scrollTo(0,apparelScroll);
    }
    const view=mount(root,{onActivate:()=>showPane('all-genre',true),onApp:()=>showPane('app',true)});
    for(const b of nav.querySelectorAll('button'))b.addEventListener('click',()=>showPane(b.dataset.pane));
  }
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
  return {listedBrands,select,norm,subgenre,subgenres,featureGroups,quickGroups,factorEntries,readGuides,readValueFactors,mount};
})();
