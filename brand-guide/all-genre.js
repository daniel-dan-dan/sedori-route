/* Private product records are loaded only from the existing verified library. */
const AllGenre = (() => {
  'use strict';
  const norm = value => value.normalize('NFKC').toLowerCase().replace(/[\s・._-]/g, '');
  function select(products, genre, brand, query) {
    const terms = norm(query).split(/[,、]+/).filter(Boolean);
    return products.filter(p => (!genre || p.genre === genre) && (!brand || p.brand === brand) && terms.every(t => norm([p.name,p.brand,p.model,p.genre,...p.features.map(f=>f.label)].join(' ')).includes(t)));
  }
  function el(tag, text, cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; }
  function button(text, action, cls='ag-button') { const n=el('button',text,cls);n.type='button';n.addEventListener('click',action);return n; }
  function link(text,url) { const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener noreferrer';n.referrerPolicy='no-referrer';return n; }
  function photo(p) { const n=el('img');n.src=p.photo.image;n.alt=p.name+'の商品全体';n.loading='lazy';n.decoding='async';return n; }
  function features(p) {const box=el('div',undefined,'ag-features');for(const f of p.features){box.append(el('span',f.label+(f.confirmed?'':' · 要確認'),f.confirmed?'ag-chip':'ag-chip ag-unconfirmed'));}return box;}
  function detail(p,trigger) {
    const d=el('dialog',undefined,'ag-detail');d.setAttribute('aria-label',p.name);
    d.append(button('閉じる ×',()=>d.close(),'ag-button ag-close'),el('p',p.brand,'ag-eyebrow'),el('h2',p.name),photo(p),el('p',p.photo.label,'ag-muted'),features(p));
    const checks=el('section');checks.append(el('h3','店頭で確認'));const ul=el('ul');for(const x of p.checks)ul.append(el('li',x));checks.append(ul);d.append(checks);
    const disclosure=el('details');disclosure.append(el('summary','型番・価格・根拠を見る'),el('p',p.model||'型番：未確認'),el('p',p.identity,'ag-muted'));
    const dl=el('dl',undefined,'ag-prices');for(const row of p.prices){dl.append(el('dt',row[0]),el('dd',row[1]));}disclosure.append(dl,el('p','動画当時の価格です。その他費用が未確認のため、確定利益ではありません。','ag-muted'));
    for(const f of p.features)disclosure.append(el('h4',f.label+(f.confirmed?'（動画の説明）':'（要確認）')),el('p',f.note));
    for(const note of p.notes)disclosure.append(el('p',note,'ag-muted'));
    disclosure.append(el('h3','動画の根拠'));for(const e of p.evidence)disclosure.append(link(e.label,e.url));
    d.append(disclosure,link('画像の出典を開く',p.photo.source));d.addEventListener('close',()=>{d.remove();trigger.focus();});document.body.append(d);d.showModal();
  }
  function mount(root) {
    let record=null, genre='', brand='', query='', request=0;
    const header=el('header',undefined,'ag-header');header.append(el('p','SOURCING LIBRARY','ag-eyebrow'),el('h1','オールジャンル'),el('p','形を覚えて、高値の特徴を確認。','ag-muted'));
    const search=el('input');search.type='search';search.placeholder='ブランド・商品名・型番';search.setAttribute('aria-label','商品を検索');
    const genres=el('div',undefined,'ag-genres');genres.setAttribute('aria-label','ジャンル');
    const brands=el('select');brands.setAttribute('aria-label','ブランドで絞り込み');
    const tools=el('div',undefined,'ag-tools');tools.append(search,brands);
    const status=el('p','資料を読み込み中…','ag-muted');status.setAttribute('role','status');
    const grid=el('div',undefined,'ag-grid');const held=el('details',undefined,'ag-held');root.append(header,genres,tools,status,grid,held);
    function renderGenres(){genres.replaceChildren();for(const g of ['',...new Set(record.products.map(p=>p.genre))]){const b=button(g||'すべて',()=>{genre=g;brand='';renderGenres();renderBrands();render();},'ag-genre');b.setAttribute('aria-pressed',String(g===genre));genres.append(b);}}
    function renderBrands(){brands.replaceChildren();for(const b of ['',...new Set(record.products.filter(p=>!genre||p.genre===genre).map(p=>p.brand))].sort((a,b)=>a.localeCompare(b,'ja'))){const o=el('option',b||'すべてのブランド');o.value=b;brands.append(o);}brands.value=brand;}
    function render(){const result=select(record.products,genre,brand,query);status.textContent=`${result.length}商品 · ${record.videoCount}本の動画から`;grid.replaceChildren();for(const p of result){const card=button('',()=>detail(p,card),'ag-card');card.append(photo(p));const content=el('div',undefined,'ag-card-body');content.append(el('p',p.brand,'ag-eyebrow'),el('h2',p.name),features(p));card.append(content);grid.append(card);}if(!result.length)grid.append(el('p','該当する商品はありません。条件を変えてください。','ag-empty'));}
    search.addEventListener('input',()=>{query=search.value;if(record)render();});brands.addEventListener('change',()=>{brand=brands.value;if(record)render();});
    async function refresh(){const ticket=++request;try{const saved=await BrandGuide.load();if(ticket!==request)return;const next=saved?.data?.allGenre;if(!next){status.textContent='商品資料はまだ保存されていません。アパレルブランド図鑑で最新資料を受信してください。';return;}if(next.revision===record?.revision)return;record=next;if(!record.products.some(p=>p.genre===genre))genre='';if(!record.products.some(p=>(!genre||p.genre===genre)&&p.brand===brand))brand='';renderGenres();renderBrands();render();held.replaceChildren();held.append(el('summary',`画像確認待ち ${record.held.length}商品`),el('p','商品全体の画像を確認してから掲載します。'));for(const p of record.held)held.append(el('p',p.name+' — '+p.reason));}catch{status.textContent='保存済み資料を読み込めませんでした。もう一度この画面を開いてください。';}}
    document.addEventListener('brand-guide-saved',()=>{if(!root.hidden)refresh();});return {refresh};
  }
  function init(){const apparel=document.getElementById('app'),root=document.getElementById('all-genre');if(!root)return;const view=mount(root);const nav=document.getElementById('guide-tabs');let active='app';const positions={app:0,'all-genre':0};for(const b of nav.querySelectorAll('button'))b.addEventListener('click',()=>{const next=b.dataset.pane;if(next===active){if(next==='all-genre')view.refresh();return;}positions[active]=window.scrollY;active=next;apparel.hidden=active!=='app';root.hidden=active!=='all-genre';for(const n of nav.querySelectorAll('button'))n.setAttribute('aria-pressed',String(n===b));window.scrollTo(0,positions[active]);if(active==='all-genre')view.refresh();});}
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',init);
  return {select,norm,mount};
})();
