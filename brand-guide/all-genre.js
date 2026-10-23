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
    const terms = norm(query).split(/[,、]+/).filter(Boolean);
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
  function detail(p,trigger) {
    const d=el('dialog',undefined,'ag-detail');d.setAttribute('aria-label',p.name);
    const header=el('div',undefined,'ag-detail-header');header.append(button('閉じる ×',()=>d.close(),'ag-button ag-close'));
    const body=el('div',undefined,'ag-detail-body');body.append(photo(p),el('h2',p.name));
    if(showBrand(p))body.append(el('p',p.brand,'ag-eyebrow'));
    if(p.photo.fullProduct===false)body.append(el('p',p.photo.label,'ag-muted'));
    if(p.kind==='紹介・比較例')body.append(el('p','動画の紹介例','ag-example-badge'));
    if(p.checks.length){const checks=el('section');checks.append(el('h3','店頭で確認'));const ul=el('ul');for(const x of p.checks)ul.append(el('li',x));checks.append(ul);body.append(checks);}
    const disclosure=el('details');disclosure.append(el('summary','型番・価格・詳しい説明'),el('p',p.model||'型番：未確認'),el('p',p.identity,'ag-muted'));
    const dl=el('dl',undefined,'ag-prices');for(const row of p.prices){dl.append(el('dt',row[0]),el('dd',row[1]));}disclosure.append(dl,el('p',p.kind==='紹介・比較例'?'動画で紹介された比較例です。今回の仕入れ品の実売・利益ではありません。':'動画当時の価格です。その他費用が未確認のため、確定利益ではありません。','ag-muted'));
    for(const f of p.features)disclosure.append(el('h4',f.label+(f.confirmed?'（動画の説明）':'（要確認）')),el('p',f.note));
    for(const note of p.notes)disclosure.append(el('p',note,'ag-muted'));
    const sources=el('details');sources.append(el('summary','出典'),el('p',p.photo.label,'ag-muted'));for(const e of p.evidence)sources.append(link(e.label,e.url));sources.append(link('画像の出典を開く',p.photo.source));
    body.append(disclosure,sources);d.append(header,body);d.addEventListener('close',()=>{d.remove();trigger.focus();});document.body.append(d);d.showModal();
  }
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
  function factorView(group) {
    const row=el('details',undefined,'ag-factor-row'),summary=el('summary');
    summary.append(el('span',group.label,'ag-factor-label'));
    if(!group.confirmed)summary.append(el('span','要確認','ag-factor-pending'));
    const content=el('div',undefined,'ag-factor-content');content.append(el('p',group.explanation));
    if(group.checks.length){content.append(el('h4','店頭チェック'));const ul=el('ul');for(const x of group.checks)ul.append(el('li',x));content.append(ul);}
    const evidence=el('details',undefined,'ag-factor-evidence');evidence.append(el('summary','動画の根拠・紹介例を見る'));
    for(const e of group.evidence)evidence.append(link(e.label,e.url));
    for(const p of group.records){evidence.append(el('p',p.brand+' / '+p.name,'ag-muted'));}
    content.append(evidence);row.append(summary,content);return row;
  }
  function mount(root) {
    let record=null, guides=[], valueFactors=[], genre='', middle='', small='', request=0;
    const header=el('header',undefined,'ag-header');header.append(el('h1','オールジャンル図鑑','bg-title'));
    const picker=el('details',undefined,'ag-picker');picker.hidden=true;
    const path=el('summary',undefined,'ag-current-path');
    const genres=el('div',undefined,'ag-genres');genres.setAttribute('role','group');genres.setAttribute('aria-label','大ジャンル');
    const middleBox=el('section',undefined,'ag-middle-box');middleBox.hidden=true;
    const middleGenres=el('div',undefined,'ag-middles');middleGenres.setAttribute('role','group');middleGenres.setAttribute('aria-label','中ジャンル');middleBox.append(middleGenres);
    const smallBox=el('section',undefined,'ag-subgenre-box');smallBox.hidden=true;
    const smallGenres=el('div',undefined,'ag-subgenres');smallGenres.setAttribute('role','group');smallGenres.setAttribute('aria-label','小ジャンル');smallBox.append(smallGenres);
    const status=el('p','資料を読み込み中…','ag-muted');status.setAttribute('role','status');
    const productBrands=el('details',undefined,'ag-brand-section');productBrands.hidden=true;
    const brandTitle=el('summary','ブランド');const brandList=el('ul',undefined,'ag-brand-list');productBrands.append(brandTitle,brandList);
    const factors=el('section',undefined,'ag-factor-section');factors.setAttribute('aria-labelledby','ag-factors-title');
    const factorTitle=el('h2','高値要素','ag-section-title');factorTitle.id='ag-factors-title';const factorList=el('div',undefined,'ag-factor-list');factors.append(factorTitle,factorList);factors.hidden=true;
    const products=el('section',undefined,'ag-product-section');products.setAttribute('aria-labelledby','ag-products-title');
    const productTitle=el('h2','利益商品','ag-section-title');productTitle.id='ag-products-title';const grid=el('div',undefined,'ag-grid');products.append(productTitle,grid);
    products.hidden=true;
    const held=el('details',undefined,'ag-held');held.hidden=true;picker.append(path,genres,middleBox,smallBox);root.append(header,picker,status,productBrands,factors,products,held);
    function focusSelection(box,label){const selected=[...box.children].find(b=>b.textContent===label);selected?.focus({preventScroll:true});return !!selected;}
    function completeSelection(){picker.open=false;path.focus({preventScroll:true});}
    function selectionChanged(level){
      renderGenres();renderMiddle();renderSmall();render();
      // A replaced button must have an explicit focus destination. Selecting a
      // final leaf (or a parent with just one leaf) completes this interaction.
      const rows=[...record.products,...guides],leaves=GuideTaxonomy.leaves(rows,genre,middle);
      const finished=level==='small'||(leaves.length===1&&(level==='middle'||GuideTaxonomy.middles(rows,genre).length<2));
      if(finished)completeSelection();
      else {picker.open=true;focusSelection(level==='genre'?genres:middleGenres,level==='genre'?genre:middle);}
    }
    function renderGenres(){
      const available=[...new Set([...record.products,...guides].map(p=>p.genre))];
      if(!available.includes(genre))genre=available[0]||'';
      picker.hidden=!available.length;genres.hidden=available.length<2;
      genres.replaceChildren();
      for(const g of available){const b=button(g,()=>{genre=g;middle='';small='';selectionChanged('genre');},'ag-genre');b.setAttribute('aria-pressed',String(g===genre));genres.append(b);}
    }
    function renderMiddle(){
      const available=GuideTaxonomy.middles([...record.products,...guides],genre);
      if(!available.includes(middle))middle=available[0]||'';
      middleBox.hidden=available.length<2;middleGenres.replaceChildren();
      for(const m of available){const b=button(m,()=>{middle=m;small='';selectionChanged('middle');},'ag-genre ag-middle');b.setAttribute('aria-pressed',String(m===middle));middleGenres.append(b);}
    }
    function renderSmall(){
      const available=GuideTaxonomy.leaves([...record.products,...guides],genre,middle);
      if(!available.includes(small))small=available[0]||'';
      smallBox.hidden=available.length<2;smallGenres.replaceChildren();
      for(const g of available){const b=button(g,()=>{small=g;selectionChanged('small');},'ag-genre ag-subgenre');b.setAttribute('aria-pressed',String(g===small));smallGenres.append(b);}
    }
    function render(){
      const result=select(record.products,genre,'','',small,middle);
      const labels=[genre,middle,small].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
      path.textContent=labels.join(' › ');status.textContent='';status.hidden=true;
      brandList.replaceChildren();
      // Use only the displayed profit products, not learning-only examples or held items.
      for(const name of listedBrands(result))brandList.append(el('li',name));
      productBrands.hidden=!brandList.children.length;
      factorList.replaceChildren();
      const sections=new Map();
      for(const entry of factorEntries([...select(guides,genre,'','',small,middle),...result],valueFactors)){
        const key=JSON.stringify([entry.genre,entry.subgenre]);
        if(!sections.has(key)){const box=el('section',undefined,'ag-factor-group');if(!genre||!small)box.append(el('h3',(!genre?entry.genre+' / ':'')+entry.subgenre,'ag-quick-title'));sections.set(key,box);factorList.append(box);}
        sections.get(key).append(factorView(entry));
      }
      factors.hidden=!factorList.children.length;
      grid.replaceChildren();
      for(const p of result){const card=button('',()=>detail(p,card),'ag-card');card.append(photo(p));const content=el('div',undefined,'ag-card-body');if(showBrand(p))content.append(el('p',p.brand,'ag-eyebrow'));content.append(el('h3',p.name));if(p.kind==='紹介・比較例')content.append(el('p','動画の紹介例','ag-example-badge'));card.append(content);grid.append(card);}
      products.hidden=!result.length;
      if(!result.length&&factors.hidden){status.textContent='この分類の情報はまだありません。';status.hidden=false;}
    }
    async function refresh(){
      const ticket=++request;
      try{
        const saved=await BrandGuide.load();if(ticket!==request)return;
        const next=saved?.data?.allGenre;
        if(!next){status.textContent='商品資料はまだ保存されていません。';status.hidden=false;return;}
        if(next.revision===record?.revision)return;
        // Validate original source scope first; taxonomy is a view, not a rewrite.
        const nextGuides=readGuides(next.guides),nextFactors=readValueFactors(next.valueFactors,[...next.products,...nextGuides]);
        const project=p=>GuideTaxonomy.project(p,subgenre(p));
        const products=next.products.map(project),learning=nextGuides.map(project);
        valueFactors=GuideTaxonomy.factors(nextFactors,[...products,...learning]);guides=learning;record={...next,products};
        const focused=[genres,middleGenres,smallGenres].find(box=>[...box.children].includes(document.activeElement)),label=document.activeElement?.textContent;
        renderGenres();renderMiddle();renderSmall();render();
        if(focused){const visible=focused===genres?!genres.hidden:focused===middleGenres?!middleBox.hidden:!smallBox.hidden;if(!visible||!focusSelection(focused,label))path.focus({preventScroll:true});}
        held.replaceChildren();held.hidden=!record.held.length;
        held.append(el('summary',`資料確認待ち ${record.held.length}商品`),el('p','掲載できない理由を個別に記録しています。画像の欠けや価格未確認だけでは保留しません。'));
        for(const p of record.held)held.append(el('p',p.name+' — '+p.reason));
      }catch{status.textContent='保存済み資料を読み込めませんでした。もう一度この画面を開いてください。';status.hidden=false;}
    }
    document.addEventListener('brand-guide-saved',()=>{if(!root.hidden)refresh();});return {refresh};
  }
  function init(){const apparel=document.getElementById('app'),root=document.getElementById('all-genre');if(!root)return;const view=mount(root);const nav=document.getElementById('guide-tabs');let active='app';const positions={app:0,'all-genre':0};for(const b of nav.querySelectorAll('button'))b.addEventListener('click',()=>{const next=b.dataset.pane;if(next===active){if(next==='all-genre')view.refresh();return;}positions[active]=window.scrollY;active=next;document.title=active==='app'?'アパレル図鑑':'オールジャンル図鑑';apparel.hidden=active!=='app';root.hidden=active!=='all-genre';for(const n of nav.querySelectorAll('button'))n.setAttribute('aria-pressed',String(n===b));window.scrollTo(0,positions[active]);if(active==='all-genre')view.refresh();});}
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
  return {listedBrands,select,norm,subgenre,subgenres,featureGroups,quickGroups,factorEntries,readGuides,readValueFactors,mount};
})();
