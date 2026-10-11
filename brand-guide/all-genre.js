/* Private product records are loaded only from the existing verified library. */
const AllGenre = (() => {
  'use strict';
  const norm = value => value.normalize('NFKC').toLowerCase().replace(/[\s・._-]/g, '');
  const SUBGENRES = {
    'ベビー用品':['ベビーカー','抱っこ紐','チャイルドシート','ジュニアシート','ベビーチェア','スイング','ベビーベッド','バウンサー'],
    '生活家電':['炊飯器','電気ポット','コーヒーマシン','空気清浄機','掃除機','冷暖房','除湿機','ミシン'],
    'スポーツ':['グローブ','ゴルフ','その他スポーツ'],
    '楽器':['電子ドラム','鍵盤楽器','管楽器','弦楽器','その他楽器'],
    'スキー・スノーボード':['スキーブーツ','スキー板','スノーボード','スノーボードブーツ']
  };
  const RULES = [
    ['ベビーカー',/ベビーカー|stroller/i],['抱っこ紐',/抱っこ|抱っこひも|キャリア/i],
    ['ジュニアシート',/ジュニアシート/],['チャイルドシート',/チャイルドシート|クルリラ|フォームフィット/],['ベビーチェア',/ベビーチェア|トリップトラップ|マテルナ/],
    ['スイング',/スイング|ネムリラ/],['ベビーベッド',/ベビーベッド|ココネル/],['バウンサー',/バウンサー|Bliss Air|Wuggy/i],
    ['スノーボードブーツ',/スノーボード.*ブーツ/],['スキーブーツ',/スキー.*ブーツ/],['スキー板',/スキー板/],['スノーボード',/スノーボード/],
    ['炊飯器',/炊飯器/],['電気ポット',/電気ポット|電気ケトル/],['コーヒーマシン',/コーヒー|エスプレッソ/],
    ['空気清浄機',/空気清浄/],['掃除機',/掃除機|クリーナー/],['除湿機',/除湿/],['ミシン',/ミシン/],['冷暖房',/ファン|クーラー|ヒーター|エアコン/],
    ['グローブ',/グローブ/],['ゴルフ',/ゴルフ/],['電子ドラム',/電子ドラム/],['鍵盤楽器',/ピアノ|キーボード|補助ペダル/],
    ['管楽器',/サックス|フルート|トランペット/],['弦楽器',/バイオリン|ギター|大正琴/]
  ];
  function subgenre(p) {
    if (typeof p.subgenre==='string' && p.subgenre.trim()) return p.subgenre.trim();
    const text=[p.name,p.model].join(' '), allowed=SUBGENRES[p.genre] || [];
    return RULES.find(([label,re])=>allowed.includes(label) && re.test(text))?.[0] || 'その他';
  }
  function subgenres(products,genre) {
    if(!genre)return [];
    return [...new Set([...(SUBGENRES[genre] || []),...products.filter(p=>p.genre===genre).map(subgenre)])];
  }
  function select(products, genre, brand, query, small='') {
    const terms = norm(query).split(/[,、]+/).filter(Boolean);
    return products.filter(p => (!genre || p.genre === genre) && (!brand || p.brand === brand) && (!small || subgenre(p)===small) && terms.every(t => norm([p.name,p.brand,p.model,p.genre,subgenre(p),...p.features.map(f=>f.label)].join(' ')).includes(t)));
  }
  function el(tag, text, cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; }
  // Learning records have no product photo; verify their bounded text and sources
  // before use, independently of the whole-product image gate.
  function readGuides(value) {
    if(value===undefined)return [];
    const str=(x,max)=>typeof x==='string' && x.length<=max;
    const strings=(xs,max,count)=>Array.isArray(xs)&&xs.length<=count&&xs.every(x=>str(x,max));
    const url=x=>{try{const u=new URL(x);return u.protocol==='https:' && ['www.youtube.com','youtube.com','youtu.be'].includes(u.hostname) && !u.username && !u.password;}catch{return false;}};
    if(!Array.isArray(value)||value.length>200)throw new Error('Invalid learning records');
    const ids=new Set();
    for(const g of value){
      if(!g || !['id','name','brand','genre','subgenre','model'].every(k=>str(g[k],1500)) || !g.id || ids.has(g.id) || !g.name || !g.genre || !g.subgenre || !g.brand ||
        !Array.isArray(g.features) || g.features.length>3 || !g.features.every(f=>f&&str(f.label,80)&&typeof f.confirmed==='boolean'&&str(f.note,3000)) ||
        !strings(g.checks,1000,3) || !strings(g.notes,3000,40) || !Array.isArray(g.evidence) || g.evidence.length<1 || g.evidence.length>30 || !g.evidence.every(e=>e&&str(e.label,1000)&&url(e.url)))throw new Error('Invalid learning record');
      ids.add(g.id);
    }
    return value.map(g=>({...g,guide:true}));
  }
  function button(text, action, cls='ag-button') { const n=el('button',text,cls);n.type='button';n.addEventListener('click',action);return n; }
  function link(text,url) { const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener noreferrer';n.referrerPolicy='no-referrer';return n; }
  function photo(p) { const n=el('img');n.src=p.photo.image;n.alt=p.name+'の商品全体';n.loading='lazy';n.decoding='async';return n; }
  function features(p) {const box=el('div',undefined,'ag-features');for(const f of p.features){box.append(el('span',f.label+(f.confirmed?'':' · 要確認'),f.confirmed?'ag-chip':'ag-chip ag-unconfirmed'));}return box;}
  function detail(p,trigger) {
    const d=el('dialog',undefined,'ag-detail');d.setAttribute('aria-label',p.name);
    d.append(button('閉じる ×',()=>d.close(),'ag-button ag-close'),el('p',p.brand,'ag-eyebrow'),el('h2',p.name),photo(p),el('p',p.photo.label,'ag-muted'),features(p));
    const checks=el('section');checks.append(el('h3','店頭で確認'));const ul=el('ul');for(const x of p.checks)ul.append(el('li',x));checks.append(ul);d.append(checks);
    const disclosure=el('details');disclosure.append(el('summary','型番・価格・根拠を見る'),el('p',p.model||'型番：未確認'),el('p',p.identity,'ag-muted'));
    const dl=el('dl',undefined,'ag-prices');for(const row of p.prices){dl.append(el('dt',row[0]),el('dd',row[1]));}disclosure.append(dl,el('p',p.kind==='紹介・比較例'?'動画で紹介された比較例です。今回の仕入れ品の実売・利益ではありません。':'動画当時の価格です。その他費用が未確認のため、確定利益ではありません。','ag-muted'));
    for(const f of p.features)disclosure.append(el('h4',f.label+(f.confirmed?'（動画の説明）':'（要確認）')),el('p',f.note));
    for(const note of p.notes)disclosure.append(el('p',note,'ag-muted'));
    disclosure.append(el('h3','動画の根拠'));for(const e of p.evidence)disclosure.append(link(e.label,e.url));
    d.append(disclosure,link('画像の出典を開く',p.photo.source));d.addEventListener('close',()=>{d.remove();trigger.focus();});document.body.append(d);d.showModal();
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
  function mount(root) {
    let record=null, guides=[], genre='', small='', brand='', query='', request=0;
    const header=el('header',undefined,'ag-header');header.append(el('h1','オールジャンル'),el('p','ジャンルを選んで、特徴と商品を確認。','ag-muted'));
    const search=el('input');search.type='search';search.placeholder='ブランド・商品名・型番';search.setAttribute('aria-label','商品を検索');
    const genres=el('div',undefined,'ag-genres');genres.setAttribute('role','group');genres.setAttribute('aria-label','大ジャンル');
    const smallBox=el('section',undefined,'ag-subgenre-box');smallBox.hidden=true;
    const smallLabel=el('p','小ジャンル','ag-filter-label');const smallGenres=el('div',undefined,'ag-subgenres');smallGenres.setAttribute('role','group');smallGenres.setAttribute('aria-label','小ジャンル');smallBox.append(smallLabel,smallGenres);
    const brands=el('select');brands.setAttribute('aria-label','ブランドで絞り込み');
    const tools=el('div',undefined,'ag-tools');tools.append(search,brands);
    const status=el('p','資料を読み込み中…','ag-muted');status.setAttribute('role','status');
    const factors=el('section',undefined,'ag-factor-section');factors.setAttribute('aria-labelledby','ag-factors-title');
    const factorTitle=el('h2','高値要素','ag-section-title');factorTitle.id='ag-factors-title';const factorList=el('div',undefined,'ag-factor-list');factors.append(factorTitle,factorList);
    const products=el('section',undefined,'ag-product-section');products.setAttribute('aria-labelledby','ag-products-title');
    const productTitle=el('h2','利益商品','ag-section-title');productTitle.id='ag-products-title';const grid=el('div',undefined,'ag-grid');products.append(productTitle,grid);
    const held=el('details',undefined,'ag-held');root.append(header,genres,smallBox,tools,status,factors,products,held);
    function renderGenres(){genres.replaceChildren();for(const g of ['',...new Set([...record.products,...guides].map(p=>p.genre))]){const b=button(g||'すべて',()=>{genre=g;small='';brand='';renderGenres();renderSmall();renderBrands();render();},'ag-genre');b.setAttribute('aria-pressed',String(g===genre));genres.append(b);}}
    function renderSmall(){smallBox.hidden=!genre;smallGenres.replaceChildren();for(const g of ['',...subgenres([...record.products,...guides],genre)]){const b=button(g||'すべて',()=>{small=g;brand='';renderSmall();renderBrands();render();},'ag-genre ag-subgenre');b.setAttribute('aria-pressed',String(g===small));smallGenres.append(b);}}
    function renderBrands(){brands.replaceChildren();for(const b of ['',...new Set(select([...record.products,...guides],genre,'','',small).map(p=>p.brand))].sort((a,b)=>a.localeCompare(b,'ja'))){const o=el('option',b||'すべてのブランド');o.value=b;brands.append(o);}brands.value=brand;}
    function render(){
      const result=select(record.products,genre,brand,query,small);
      status.textContent=[genre,small].filter(Boolean).join(' › ')+(genre?' · ':'')+`${result.length}商品`;
      factorList.replaceChildren();
      for(const group of featureGroups([...select(guides,genre,brand,query,small),...result])){
        const row=el('details',undefined,'ag-factor-row'),summary=el('summary'),title=el('span',group.label,'ag-factor-label');
        summary.append(title);if(!group.confirmed)summary.append(el('span','要確認','ag-factor-pending'));
        const scope=(!genre?group.genre+' / ':'')+(!small?group.subgenre+' · ':'');
        summary.append(el('span',scope+[...new Set(group.products.map(p=>p.brand))].join('・'),'ag-factor-brands'));row.append(summary);
        for(const p of group.products){const f=p.features.find(f=>f.label===group.label && f.confirmed===group.confirmed);if(p.guide){row.append(el('p',p.name,'ag-eyebrow'),el('p',f.note,'ag-muted'));for(const x of p.checks)row.append(el('p','店頭：'+x,'ag-muted'));for(const x of p.notes)row.append(el('p',x,'ag-muted'));for(const e of p.evidence)row.append(link(e.label,e.url));}else{const item=button(p.name,()=>detail(p,item),'ag-factor-product');row.append(item,el('p',f.note,'ag-muted'));}}
        factorList.append(row);
      }
      if(!factorList.children.length)factorList.append(el('p','この条件の高値要素は未登録です。','ag-empty'));
      grid.replaceChildren();
      for(const p of result){const card=button('',()=>detail(p,card),'ag-card');card.append(photo(p));const content=el('div',undefined,'ag-card-body');content.append(el('p',p.brand,'ag-eyebrow'),el('h3',p.name),el('p',subgenre(p),'ag-card-type'));if(p.kind==='紹介・比較例')content.append(el('p','動画の紹介例','ag-example-badge'));card.append(content);grid.append(card);}
      if(!result.length)grid.append(el('p','この小ジャンルの商品は未登録です。','ag-empty'));
    }
    search.addEventListener('input',()=>{query=search.value;if(record)render();});brands.addEventListener('change',()=>{brand=brands.value;if(record)render();});
    async function refresh(){const ticket=++request;try{const saved=await BrandGuide.load();if(ticket!==request)return;const next=saved?.data?.allGenre;if(!next){status.textContent='商品資料はまだ保存されていません。アパレルブランド図鑑で最新資料を受信してください。';return;}if(next.revision===record?.revision)return;guides=readGuides(next.guides);record=next;if(![...record.products,...guides].some(p=>p.genre===genre)){genre='';small='';}if(!subgenres([...record.products,...guides],genre).includes(small))small='';if(!select([...record.products,...guides],genre,'','',small).some(p=>p.brand===brand))brand='';renderGenres();renderSmall();renderBrands();render();held.replaceChildren();held.append(el('summary',`画像確認待ち ${record.held.length}商品`),el('p','商品全体の画像を確認してから掲載します。'));for(const p of record.held)held.append(el('p',p.name+' — '+p.reason));}catch{status.textContent='保存済み資料を読み込めませんでした。もう一度この画面を開いてください。';}}
    document.addEventListener('brand-guide-saved',()=>{if(!root.hidden)refresh();});return {refresh};
  }
  function init(){const apparel=document.getElementById('app'),root=document.getElementById('all-genre');if(!root)return;const view=mount(root);const nav=document.getElementById('guide-tabs');let active='app';const positions={app:0,'all-genre':0};for(const b of nav.querySelectorAll('button'))b.addEventListener('click',()=>{const next=b.dataset.pane;if(next===active){if(next==='all-genre')view.refresh();return;}positions[active]=window.scrollY;active=next;apparel.hidden=active!=='app';root.hidden=active!=='all-genre';for(const n of nav.querySelectorAll('button'))n.setAttribute('aria-pressed',String(n===b));window.scrollTo(0,positions[active]);if(active==='all-genre')view.refresh();});}
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
  return {select,norm,subgenre,subgenres,featureGroups,readGuides,mount};
})();
