import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const scripts=['brand-guide/all-genre-data.js','brand-guide/taxonomy.js','brand-guide/organize.js','brand-guide/all-genre.js'].map(path=>readFileSync(new URL(path,import.meta.url),'utf8')).join('\n');
const evidence=[{label:'説明',url:'https://www.youtube.com/watch?v=example&t=30'}];
const make=(id,name,genre,brand='A')=>({id,name,genre,brand,model:'',identity:'同一品番',features:[{label:'付属品',confirmed:false,note:'未確認'}],checks:[],photo:{image:'data:image/jpeg;base64,',label:'全体',source:'https://example.com'},prices:[],notes:[],evidence});
const data=[make('a','ベビーカー','ベビー用品'),make('b','チャイルドシート','ベビー用品','B'),make('c','電気ポット','生活家電','C')];
const learning={...make('learn','特定モデル','ベビー用品','Guide only'),subgenre:'ベビーベッド',checks:['脚の品番']};
const factor={id:'generic',genre:'ベビー用品',subgenre:'ベビーカー',label:'レザーハンドル',dimension:'material',generalizable:true,confirmed:true,explanation:'素材を高値の手掛かりとして説明。価格差は未確認。',checks:['素材を確認'],sourceIds:['a'],evidence};
const packageOf=items=>({version:1,reviewedAt:'2026-10-12',items});

// A deterministic DOM/history harness. Tests act on visible controls and state,
// rather than snapshots of the chosen markup. This does not replace real-device QA.
function harness(extra={}){
 const listeners=()=>({events:{},addEventListener(type,fn){(this.events[type]??=[]).push(fn);},removeEventListener(type,fn){this.events[type]=(this.events[type]||[]).filter(f=>f!==fn);},dispatchEvent(event){event.target??=this;event.currentTarget=this;event.preventDefault??=()=>{event.defaultPrevented=true;};event.stopPropagation??=()=>{event.cancelBubble=true;};for(const fn of [...(this.events[event.type]||[])])fn(event);if(event.bubbles&&!event.cancelBubble)this.parentNode?.dispatchEvent(event);return !event.defaultPrevented;}});
 let document;const nodes=[],timers=new Map();let nextTimer=0,now=0;
 const schedule=(fn)=>{timers.set(++nextTimer,fn);return nextTimer;};
 function matches(n,selector){
  return selector.split(',').some(raw=>{
   const s=raw.trim();if(!s)return false;if(s==='*')return true;
   if(s.includes(' ')){const parts=s.split(/\s+/),last=parts.pop();if(!matches(n,last))return false;let p=n.parentNode;while(p){if(matches(p,parts.join(' ')))return true;p=p.parentNode;}return false;}
   const tag=s.match(/^[a-z][a-z0-9-]*/i)?.[0];if(tag&&n.tag!==tag.toLowerCase())return false;
   for(const [,id] of s.matchAll(/#([\w-]+)/g))if(n.id!==id)return false;
   for(const [,cls] of s.matchAll(/\.([\w-]+)/g))if(!n.className.split(/\s+/).includes(cls))return false;
   for(const [,attr,,value] of s.matchAll(/\[([\w-]+)(?:\s*([=])\s*["']?([^\]"']*)["']?)?\]/g)){const actual=n.getAttribute(attr);if(value===undefined?actual===null:actual!==value)return false;}
   return true;
  });
 }
 function node(tag){
  const n={...listeners(),tag:tag.toLowerCase(),tagName:tag.toUpperCase(),nodeType:1,children:[],attrs:{},dataset:{},className:'',hidden:false,open:false,value:'',_text:'',parentNode:null,style:{setProperty(k,v){this[k]=v;},removeProperty(k){delete this[k];}},
   append(...xs){for(let x of xs){if(typeof x==='string'){const t=node('#text');t._text=x;x=t;}x.remove();x.parentNode=this;this.children.push(x);}},appendChild(x){this.append(x);return x;},insertBefore(x,ref){if(!ref)return this.appendChild(x);x.remove();const at=this.children.indexOf(ref);if(at<0)throw new Error('insertBefore missing reference');x.parentNode=this;this.children.splice(at,0,x);return x;},
   prepend(...xs){for(const x of xs.reverse()){x.remove();x.parentNode=this;this.children.unshift(x);}},
   replaceChildren(...xs){if(this.children.some(x=>x.contains(document.activeElement)))document.activeElement=document.body;for(const x of this.children)x.parentNode=null;this.children=[];this._text='';this.append(...xs);},
   remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;},contains(x){return this===x||this.children.some(c=>c.contains(x));},
   setAttribute(k,v){v=String(v);this.attrs[k]=v;if(k==='class')this.className=v;if(k==='id')this.id=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;},getAttribute(k){if(k==='class')return this.className||null;if(k==='id')return this.id||null;if(k.startsWith('data-')){const v=this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];if(v!==undefined)return v;}return this.attrs[k]??null;},removeAttribute(k){delete this.attrs[k];},hasAttribute(k){return this.getAttribute(k)!==null;},
   querySelectorAll(s){return this.children.flatMap(c=>[...(matches(c,s)?[c]:[]),...c.querySelectorAll(s)]);},querySelector(s){return this.querySelectorAll(s)[0]||null;},matches(s){return matches(this,s);},closest(s){for(let p=this;p;p=p.parentNode)if(matches(p,s))return p;return null;},
   focus(){document.activeElement=this;},blur(){document.activeElement=document.body;},click(){this.dispatchEvent({type:'click',bubbles:true,target:this});},getBoundingClientRect(){return {x:0,y:0,left:0,top:0,right:390,bottom:844,width:390,height:844};},scrollIntoView(){},setPointerCapture(){},releasePointerCapture(){},
   showModal(){this.open=true;},close(){this.open=false;this.dispatchEvent({type:'close'});}
  };
  Object.defineProperties(n,{textContent:{get(){return this._text+this.children.map(c=>c.textContent).join('');},set(v){this.replaceChildren();this._text=String(v??'');}},firstChild:{get(){return this.children[0]||null;}},firstElementChild:{get(){return this.children[0]||null;}},lastElementChild:{get(){return this.children.at(-1)||null;}},childNodes:{get(){return this.children;}},parentElement:{get(){return this.parentNode;}},isConnected:{get(){return !!document?.body?.contains(this);}}});
  n.classList={add(...cs){n.className=[...new Set([...n.className.split(/\s+/).filter(Boolean),...cs])].join(' ');},remove(...cs){n.className=n.className.split(/\s+/).filter(c=>!cs.includes(c)).join(' ');},contains(c){return n.className.split(/\s+/).includes(c);},toggle(c,force){const add=force??!this.contains(c);this[add?'add':'remove'](c);return add;}};
  nodes.push(n);return n;
 }
 document={...listeners(),activeElement:null,title:'アパレル図鑑',createElement:node,createDocumentFragment:()=>node('fragment'),createTextNode(text){const n=node('#text');n._text=text;return n;},getElementById(id){return this.body.querySelector('#'+id);},querySelector(s){return this.body.querySelector(s);},querySelectorAll(s){return this.body.querySelectorAll(s);}};
 document.body=node('body');document.documentElement=node('html');document.documentElement.clientWidth=390;document.documentElement.style={};document.activeElement=document.body;
 const root=node('main');root.id='all-genre';document.body.append(root);
 const window={...listeners(),scrollY:0,pageYOffset:0,innerWidth:390,innerHeight:844,scrollTo(a,b){this.scrollY=this.pageYOffset=typeof a==='object'?a.top:b;},requestAnimationFrame:schedule,cancelAnimationFrame:id=>timers.delete(id),setTimeout:schedule,clearTimeout:id=>timers.delete(id),matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})};
 const location={href:'https://example.com/brand-guide/',origin:'https://example.com',pathname:'/brand-guide/',hash:''};
 const stack=[{state:null,url:location.href}];let index=0;
 const history={get state(){return stack[index].state;},get length(){return stack.length;},pushState(state,_,url){stack.splice(++index);stack.push({state,url:url||location.href});if(url){const next=new URL(url,location.href);location.href=next.href;location.hash=next.hash;}},replaceState(state,_,url){stack[index]={state,url:url||location.href};if(url){const next=new URL(url,location.href);location.href=next.href;location.hash=next.hash;}},go(delta){const next=index+delta;if(next<0||next>=stack.length)return;index=next;location.href=stack[index].url;location.hash=new URL(location.href,'https://example.com').hash;window.dispatchEvent({type:'popstate',state:this.state});},back(){this.go(-1);},forward(){this.go(1);}};
 const stored=new Map(),sessionStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,String(v)),removeItem:k=>stored.delete(k)};
 Object.assign(window,{document,history,location,sessionStorage});
 const context={URL,console,document,window,history,location,sessionStorage,performance:{now:()=>now},requestAnimationFrame:schedule,cancelAnimationFrame:id=>timers.delete(id),setTimeout:schedule,clearTimeout:id=>timers.delete(id),navigator:{},BrandGuide:{load:async()=>({data:{allGenre:{revision:'one',products:data,held:[],videoCount:1,...extra}}})}};
 vm.runInNewContext(scripts+'\nthis.view=AllGenre;this.taxonomy=GuideTaxonomy;',context);
 const h={view:context.view,taxonomy:context.taxonomy,root,nodes,document,window,history,context,extra,
  async flush(){for(let round=0;round<10;round++){await Promise.resolve();if(!timers.size)continue;const batch=[...timers.values()];timers.clear();now+=350;for(const fn of batch)fn(now);}},
  async start(){this.mounted=this.view.mount(root);await this.mounted.refresh();if(this.mounted.activate)await this.mounted.activate();await this.flush();return this;},
  async boot(){const apparel=node('main');apparel.id='app';const nav=node('nav');nav.id='guide-tabs';for(const [pane,label] of [['app','アパレル図鑑'],['all-genre','オールジャンル図鑑']]){const b=node('button');b.dataset.pane=pane;b.textContent=label;nav.append(b);}root.hidden=true;document.body.append(apparel,nav);document.dispatchEvent({type:'DOMContentLoaded'});nav.children[1].click();await this.flush();this.nav=nav;this.apparel=apparel;return this;},
  async click(text){const target=findButton(this,text);assert.ok(target,`Button ${text} absent in ${root.textContent}`);target.click();await this.flush();return target;},
  async refresh(){await this.mounted.refresh();await this.flush();},
  async input(value){const input=root.querySelector('input');assert.ok(input);input.value=value;input.dispatchEvent({type:'input'});await this.flush();return input;}
 };return h;
}
const visible=n=>!n.hidden&&(!n.parentNode||visible(n.parentNode));
function accessibleText(n){return n.getAttribute('aria-hidden')==='true'?'':n._text+n.children.map(accessibleText).join('');}
function findButton(h,text){return h.root.querySelectorAll('button,summary').filter(visible).find(n=>accessibleText(n).trim().replace(/^[‹›←]\s*/, '')===text)||h.root.querySelectorAll('button,summary').filter(visible).find(n=>n.getAttribute('aria-label')===text);}
const q=(h,selector)=>h.root.querySelector(selector);
const productRows=h=>h.root.querySelectorAll('.ag-product-row');
async function openStrollers(h){await h.click('ベビー用品');if(q(h,'input'))return;if(findButton(h,'移動・お出かけ'))await h.click('移動・お出かけ');if(q(h,'input'))return;if(findButton(h,'ベビーカー'))await h.click('ベビーカー');}
async function openOnly(h,genre){await h.click(genre);}

// Validation and source-scope coverage carried forward from the former UI.
test('subgenre and text filters keep unrelated product identities separate',()=>{
 const h=harness();assert.equal(h.view.select(data,'ベビー用品','','','ベビーカー')[0].id,'a');assert.equal(h.view.select(data,'ベビー用品','','','電気ポット').length,0);
 assert.equal(h.view.subgenre(make('s','スノーボードブーツ','スキー・スノーボード')),'スノーボードブーツ');assert.equal(h.view.subgenre(make('x','分類不明','ベビー用品')),'その他');
 assert.equal(h.view.select(data,'ベビー用品','B','ベビーカー','ベビーカー').length,0);
});
test('invalid learning sources, duplicate ids and malformed short copy are rejected',()=>{
 const h=harness();assert.throws(()=>h.view.readGuides([{...learning,evidence:[{label:'bad',url:'javascript:alert(1)'}]}]));assert.throws(()=>h.view.readGuides([learning,learning]));
 assert.throws(()=>h.view.readGuides([{...learning,quick:{name:'x',clue:'x',check:'x',cautions:[],points:[{text:'x',confirmed:'true'}]}}]));assert.equal(h.view.readGuides([learning])[0].guide,true);
});
test('generic review requires explicit generalizability, a valid dimension and matching evidence scope',()=>{
 const h=harness();for(const patch of [{generalizable:false},{dimension:'model'},{confirmed:'yes'},{sourceIds:['missing']},{subgenre:'チャイルドシート'},{evidence:[{label:'bad',url:'https://www.youtube.com/watch?v=other'}]},{evidence:[{label:'bad',url:'javascript:alert(1)'}]}])assert.throws(()=>h.view.readValueFactors(packageOf([{...factor,...patch}]),data));
 assert.throws(()=>h.view.readValueFactors(packageOf([factor,{...factor,id:'duplicate-label'}]),data));assert.equal(h.view.readValueFactors(packageOf([factor]),data).length,1);assert.equal(h.view.factorEntries([data[1]],[factor]).length,0);
});
test('large reviewed libraries preserve the hard bound and per-source validation',()=>{
 const h=harness(),items=Array.from({length:4000},(_,i)=>({...factor,id:'factor-'+i,label:'trait-'+i}));assert.equal(h.view.readValueFactors(packageOf(items),data).length,4000);
 assert.throws(()=>h.view.readValueFactors(packageOf([...items,{...factor,id:'overflow',label:'overflow'}]),data));assert.throws(()=>h.view.readValueFactors(packageOf([...items.slice(0,200),{...factor,id:'bad',label:'bad',sourceIds:['missing']}]),data));
});
test('unknown brands remain omitted from name filters without deleting source products',()=>{
 const h=harness(),rows=[make('a','ベビーカー','ベビー用品','Aprica'),make('b','ベビーカー','ベビー用品','ブランド未確認')];assert.deepEqual(Array.from(h.view.listedBrands(rows)),['Aprica']);assert.equal(h.view.select(rows,'ベビー用品','','').length,2);
});

test('top starts with genre choices, not an arbitrary product category or keyboard',async()=>{
 const h=await harness().start();assert.ok(findButton(h,'ベビー用品'));assert.ok(findButton(h,'生活家電'));assert.equal(productRows(h).length,0);assert.equal(q(h,'input'),null);assert.ok(!h.root.textContent.includes('中ジャンル'));assert.equal(h.document.activeElement?.tag==='input',false);
});
test('category selection exposes only the chosen branch and skips single-choice levels',async()=>{
 const rows=[...data,learning],h=await harness({products:rows}).start();await h.click('ベビー用品');assert.ok(findButton(h,'移動・お出かけ'));assert.ok(findButton(h,'睡眠・くつろぎ'));assert.equal(findButton(h,'電気ポット'),undefined);
 await h.click('移動・お出かけ');assert.ok(findButton(h,'ベビーカー'));assert.ok(findButton(h,'チャイルドシート'));await h.click('ベビーカー');assert.equal(productRows(h).length,1);assert.ok(q(h,'input'));assert.equal(h.document.activeElement?.tag==='input',false);
 await h.click('戻る');assert.ok(findButton(h,'チャイルドシート'));await h.click('戻る');assert.ok(findButton(h,'睡眠・くつろぎ'));await h.click('戻る');await h.click('生活家電');assert.equal(productRows(h).length,1);assert.ok(h.root.textContent.includes('電気ポット'));
});
test('unreviewed product features and learning records never become generic high-value claims',async()=>{
 const p={...data[0],features:[{label:'OMNI Breeze',confirmed:true,note:'個別モデル'}]},h=await harness({products:[p],guides:[learning]}).start();await openStrollers(h);assert.equal(findButton(h,'高値要素を見る'),undefined);assert.equal(productRows(h).length,1);
 const empty=await harness({products:[],guides:[learning]}).start();await empty.click('ベビー用品');assert.equal(productRows(empty).length,0);assert.equal(findButton(empty,'高値要素を見る'),undefined);assert.equal(empty.root.textContent.split('この分類の情報はまだありません。').length-1,1);
});
test('product detail preserves source and price context without duplicating modal layers',async()=>{
 const p={...data[0],brand:'Aprica',name:'Aprica ベビーカー',model:'MODEL',identity:'同一品番',checks:['車輪の摩耗'],prices:[['仕入価格','1,000円']],notes:['欠品を確認'],kind:'紹介・比較例'},h=await harness({products:[p]}).start();await openStrollers(h);
 h.window.scrollY=640;productRows(h)[0].click();await h.flush();assert.ok(q(h,'.ag-detail-page'));assert.equal(h.document.body.querySelectorAll('dialog').length,0);assert.ok(h.root.textContent.includes('車輪の摩耗'));
 const details=h.root.querySelectorAll('details'),info=details.find(d=>d.textContent.includes('型番・価格・詳しい説明')),sources=details.find(d=>d.textContent.startsWith('出典'));
 assert.ok(info);assert.equal(info.open,false);assert.equal(sources.open,false);assert.ok(info.textContent.includes('1,000円'));assert.ok(info.textContent.includes('欠品を確認'));assert.ok(info.textContent.includes('今回の仕入れ品の実売・利益ではありません'));assert.ok(sources.querySelectorAll('a').some(a=>a.href===evidence[0].url));assert.ok(sources.querySelectorAll('a').some(a=>a.href===p.photo.source));
 await h.click('戻る');assert.equal(productRows(h).length,1);assert.equal(h.window.scrollY,640);
});
test('reviewed category-wide factors retain their explanation, uncertainty and evidence',async()=>{
 const f={...factor,confirmed:false,explanation:'自動字幕由来。直接音声は未照合。'},h=await harness({valueFactors:packageOf([f])}).start();await openStrollers(h);await h.click('高値要素を見る');assert.ok(q(h,'.ag-factor-page'));assert.ok(h.root.textContent.includes('要確認'));assert.ok(h.root.textContent.includes(f.explanation));assert.ok(h.root.textContent.includes('素材を確認'));assert.ok(h.root.querySelectorAll('a').some(a=>a.href===evidence[0].url));await h.click('戻る');assert.equal(productRows(h).length,1);
});
test('brand and query stay with the list on detail/back and do not filter category advice',async()=>{
 const rows=[{...data[0],brand:'Aprica',model:'AB-10'},{...data[0],id:'aa',brand:'APRICA',model:'BB-20'},{...data[0],id:'b',brand:'Combi',model:'CC-30'},data[2]],h=await harness({products:rows,valueFactors:packageOf([factor])}).start();await openStrollers(h);
 const picker=q(h,'.ag-brand-picker');assert.ok(picker);assert.equal(picker.open,false);picker.open=true;await h.click('Aprica');assert.equal(productRows(h).length,2);await h.input('ＢＢ-２０');assert.equal(productRows(h).length,1);h.window.scrollY=350;productRows(h)[0].click();await h.flush();await h.click('戻る');assert.equal(q(h,'input').value,'ＢＢ-２０');assert.equal(productRows(h).length,1);assert.equal(h.window.scrollY,350);assert.equal(h.document.activeElement?.tag==='input',false);
 await h.click('高値要素を見る');assert.ok(h.root.textContent.includes(factor.explanation));await h.click('戻る');assert.equal(q(h,'input').value,'ＢＢ-２０');
 await h.input('does not exist');assert.equal(productRows(h).length,0);assert.ok(findButton(h,'高値要素を見る'));await h.input('');assert.equal(productRows(h).length,2);
});
test('unknown brand items and partial photos remain visible with truthful image text',async()=>{
 const p={...data[0],brand:'ブランド未確認',photo:{...data[0].photo,fullProduct:false}},h=await harness({products:[p]}).start();await openStrollers(h);assert.equal(productRows(h).length,1);assert.equal(q(h,'img').alt,p.name+'の参考画像');assert.ok(!q(h,'.ag-brand-picker')||q(h,'.ag-brand-picker').hidden);assert.equal(h.root.textContent.includes('資料確認待ち 0商品'),false);
});
test('aliases and cross-genre moves retain product ids and original reviewed source data',async()=>{
 const rows=[{...data[0],id:'x',genre:'楽器',subgenre:'楽器用ケース'},{...data[0],id:'y',genre:'楽器',subgenre:'楽器ケース'}],before=JSON.stringify(rows),h=await harness({products:rows}).start();await h.click('楽器');assert.equal(productRows(h).length,2);assert.equal(JSON.stringify(rows),before);assert.equal(h.taxonomy.classify('アウトドア','チェア').subgenre,'チェア');assert.equal(h.taxonomy.classify('家具','チェア').subgenre,'椅子');
 const p={...data[0],genre:'生活家電',subgenre:'スピーカー'},trait={...factor,genre:p.genre,subgenre:p.subgenre},saved=JSON.stringify([p,trait]),m=await harness({products:[p],valueFactors:packageOf([trait])}).start();assert.ok(findButton(m,'オーディオ機器'));await m.click('オーディオ機器');assert.equal(productRows(m).length,1);await m.click('高値要素を見る');assert.ok(m.root.textContent.includes(trait.explanation));assert.equal(JSON.stringify([p,trait]),saved);
});
test('new unknown categories remain reachable and truly empty libraries have no phantom choices',async()=>{
 const h=await harness({products:[{...data[0],genre:'新しいジャンル',subgenre:'新しい種類'}]}).start();await h.click('新しいジャンル');assert.equal(productRows(h).length,1);assert.ok(h.root.textContent.includes('新しい種類'));
 const empty=await harness({products:[],guides:[]}).start();assert.equal(empty.root.querySelectorAll('.ag-category').length,0);assert.equal(productRows(empty).length,0);assert.equal(q(empty,'input'),null);assert.equal(empty.document.activeElement?.tag==='input',false);
});
test('refresh keeps a valid detail and list state but safely repairs removed categories',async()=>{
 const extra={products:[...data]},h=await harness(extra).start();await openStrollers(h);await h.input('ベビー');h.window.scrollY=280;productRows(h)[0].click();await h.flush();extra.revision='two';extra.products=[{...data[0],checks:['新版の確認']},data[1],data[2]];await h.refresh();assert.ok(q(h,'.ag-detail-page'));assert.equal(h.root.textContent.includes('新版の確認'),false);await h.click('戻る');assert.equal(q(h,'input').value,'ベビー');assert.equal(h.window.scrollY,280);productRows(h)[0].click();await h.flush();assert.ok(h.root.textContent.includes('新版の確認'));await h.click('戻る');
 extra.revision='three';extra.products=[{...data[0],genre:'旅行用品',subgenre:'スーツケース'}];await h.refresh();assert.equal(productRows(h).length,0);assert.ok(findButton(h,'旅行用品'));await h.click('旅行用品');assert.equal(productRows(h).length,1);
});
test('browser back restores the previous list without opening the search keyboard',async()=>{
 const h=await harness().start();await openStrollers(h);await h.input('ベビー');h.window.scrollY=460;productRows(h)[0].click();await h.flush();h.history.back();await h.flush();assert.equal(productRows(h).length,1);assert.equal(q(h,'input').value,'ベビー');assert.equal(h.window.scrollY,460);assert.equal(h.document.activeElement?.tag==='input',false);
});
test('switching away and back preserves the current page and its scroll position',async()=>{
 const h=await harness().start();await openStrollers(h);productRows(h)[0].click();await h.flush();h.window.scrollY=180;assert.equal(typeof h.mounted.deactivate,'function');h.mounted.deactivate();h.root.hidden=true;h.window.scrollY=900;h.root.hidden=false;h.mounted.activate();await h.flush();assert.ok(q(h,'.ag-detail-page'));assert.equal(h.window.scrollY,180);assert.equal(h.document.body.querySelectorAll('dialog').length,0);
});


test('actual tab wiring preserves detail through an apparel round trip and browser back',async()=>{
 const h=await harness().boot();await openStrollers(h);await h.input('ベビー');h.window.scrollY=510;productRows(h)[0].click();await h.flush();assert.ok(q(h,'.ag-detail-page'));h.window.scrollY=145;
 h.nav.children[0].click();await h.flush();assert.equal(h.root.hidden,true);assert.equal(h.apparel.hidden,false);h.window.scrollY=800;
 h.nav.children[1].click();await h.flush();assert.equal(h.root.hidden,false);assert.ok(q(h,'.ag-detail-page'));assert.equal(h.window.scrollY,145);
 h.history.back();await h.flush();assert.equal(productRows(h).length,1);assert.equal(q(h,'input').value,'ベビー');assert.equal(h.window.scrollY,510);assert.equal(h.document.activeElement?.tag==='input',false);
});

test('right swipe follows the finger and returns to the same filtered list position',async()=>{
 const h=await harness().start();await openStrollers(h);await h.input('ベビー');h.window.scrollY=540;productRows(h)[0].click();await h.flush();const page=q(h,'.ag-detail-page');h.window.scrollY=120;
 const point=(x,y=160)=>({identifier:1,clientX:x,clientY:y});
 h.root.dispatchEvent({type:'touchstart',target:page,touches:[point(70)],timeStamp:0});h.root.dispatchEvent({type:'touchmove',target:page,touches:[point(225)],cancelable:true,timeStamp:100});
 assert.ok(page.style.transform.includes('155px'));assert.ok(q(h,'.ag-swipe-preview'));assert.ok(q(h,'.ag-detail-page'));
 h.root.dispatchEvent({type:'touchend',target:page,changedTouches:[point(240)],timeStamp:160});await h.flush();assert.equal(q(h,'.ag-swipe-preview'),null);assert.equal(q(h,'.ag-detail-page'),null);assert.equal(q(h,'input').value,'ベビー');assert.equal(productRows(h).length,1);assert.equal(h.window.scrollY,540);assert.equal(h.document.activeElement?.tag==='input',false);
});
test('short, vertical and native-edge gestures do not accidentally navigate back',async()=>{
 const h=await harness().start();await openStrollers(h);productRows(h)[0].click();await h.flush();const page=q(h,'.ag-detail-page');const point=(x,y)=>({identifier:1,clientX:x,clientY:y});
 for(const [start,end] of [[[70,120],[110,121]],[[70,120],[85,210]],[[10,120],[220,121]]]){
  h.root.dispatchEvent({type:'touchstart',target:page,touches:[point(...start)],timeStamp:0});h.root.dispatchEvent({type:'touchmove',target:page,touches:[point(...end)],cancelable:true,timeStamp:400});h.root.dispatchEvent({type:'touchend',target:page,changedTouches:[point(...end)],timeStamp:600});await h.flush();assert.ok(q(h,'.ag-detail-page'));assert.equal(q(h,'.ag-swipe-preview'),null);
 }
});
test('photo enlargement is dismissed on tab exit and never remains over the other guide',async()=>{
 const h=await harness().boot();await openStrollers(h);productRows(h)[0].click();await h.flush();const image=q(h,'.ag-hero-image');image.click();await h.flush();assert.equal(h.document.body.querySelectorAll('dialog').length,1);
 h.nav.children[0].click();await h.flush();assert.equal(h.document.body.querySelectorAll('dialog').length,0);assert.equal(h.root.hidden,true);h.nav.children[1].click();await h.flush();assert.ok(q(h,'.ag-detail-page'));
});
test('an invalid new source package leaves valid products and selected filters available',async()=>{
 const extra={products:[...data],valueFactors:packageOf([factor])},h=await harness(extra).start();await openStrollers(h);await h.input('ベビー');h.window.scrollY=260;
 extra.revision='invalid';extra.valueFactors=packageOf([{...factor,sourceIds:['missing']}]);await h.refresh();assert.equal(q(h,'input').value,'ベビー');assert.equal(productRows(h).length,1);assert.equal(h.window.scrollY,260);assert.ok(h.root.textContent.includes('保存済み資料を読み込めませんでした。'));
 await h.click('高値要素を見る');assert.ok(h.root.textContent.includes(factor.explanation));
});
test('consolidated factor headings never discard distinct model conditions or source links',async()=>{
 const e1=[{label:'EPSON例',url:'https://www.youtube.com/watch?v=epson'}],e2=[{label:'別モデル例',url:'https://www.youtube.com/watch?v=other'}];
 const a={...make('p1','プリンター例A','パソコン・周辺機器','EPSON'),subgenre:'プリンター',evidence:e1},b={...a,id:'p2',name:'プリンター例B',brand:'別メーカー',evidence:e2};
 const f1={...factor,id:'f1',genre:a.genre,subgenre:a.subgenre,label:'前面液晶',sourceIds:['p1'],explanation:'EPSONの特定モデルの前面液晶',evidence:e1},f2={...f1,id:'f2',label:'前面の大型液晶',sourceIds:['p2'],explanation:'大型液晶がある別モデル',confirmed:false,evidence:e2};
 const h=await harness({products:[a,b],valueFactors:packageOf([f1,f2])}).start();await h.click('パソコン・周辺機器');await h.click('高値要素を見る');assert.equal(h.root.querySelectorAll('.ag-factor-item').length,1);assert.ok(h.root.textContent.includes(f1.explanation));assert.ok(h.root.textContent.includes(f2.explanation));assert.ok(h.root.textContent.includes('要確認'));
 const urls=h.root.querySelectorAll('a').map(a=>a.href);assert.ok(urls.includes(e1[0].url));assert.ok(urls.includes(e2[0].url));assert.ok(h.root.querySelectorAll('details').every(d=>d.open===false));
});

test('browser forward into apparel keeps the correct hidden all-genre detail frame',async()=>{
 const h=await harness().boot();await openStrollers(h);await h.input('ベビー');h.window.scrollY=430;productRows(h)[0].click();await h.flush();h.window.scrollY=170;
 h.nav.children[0].click();await h.flush();h.history.back();await h.flush();assert.equal(h.root.hidden,false);assert.equal(productRows(h).length,1);assert.equal(h.window.scrollY,430);
 h.history.forward();await h.flush();assert.equal(h.root.hidden,true);assert.equal(h.apparel.hidden,false);h.nav.children[1].click();await h.flush();assert.ok(q(h,'.ag-detail-page'));assert.equal(h.window.scrollY,170);
});
test('multitouch and search-field gestures cannot trigger the custom back swipe',async()=>{
 const h=await harness().start();await openStrollers(h);const search=q(h,'input'),point=(id,x,y=130)=>({identifier:id,clientX:x,clientY:y});
 h.root.dispatchEvent({type:'touchstart',target:search,touches:[point(1,60)],timeStamp:0});h.root.dispatchEvent({type:'touchmove',target:search,touches:[point(1,220)],cancelable:true,timeStamp:100});h.root.dispatchEvent({type:'touchend',target:search,changedTouches:[point(1,220)],timeStamp:150});await h.flush();assert.equal(productRows(h).length,1);assert.equal(q(h,'.ag-swipe-preview'),null);
 productRows(h)[0].click();await h.flush();const page=q(h,'.ag-detail-page');h.root.dispatchEvent({type:'touchstart',target:page,touches:[point(1,60)],timeStamp:0});h.root.dispatchEvent({type:'touchmove',target:page,touches:[point(1,100)],cancelable:true,timeStamp:100});assert.ok(q(h,'.ag-swipe-preview'));
 h.root.dispatchEvent({type:'touchmove',target:page,touches:[point(1,150),point(2,200)],cancelable:true,timeStamp:120});await h.flush();assert.ok(q(h,'.ag-detail-page'));assert.equal(q(h,'.ag-swipe-preview'),null);
});

test('an obsolete failed refresh cannot overwrite a newer successful refresh status',async()=>{
 const h=await harness().start();await openStrollers(h);let rejectEarlier;
 h.context.BrandGuide.load=()=>new Promise((_,reject)=>{rejectEarlier=reject;});const earlier=h.mounted.refresh();
 h.context.BrandGuide.load=async()=>({data:{allGenre:{revision:'newer',products:[...data],held:[],videoCount:1}}});await h.mounted.refresh();await h.flush();
 rejectEarlier(new Error('old read failed'));await earlier;await h.flush();assert.equal(productRows(h).length,1);assert.equal(q(h,'.ag-status').hidden,true);
});

test('a successful same-revision reread clears an earlier load error without losing search state',async()=>{
 const h=await harness().start();await openStrollers(h);await h.input('ベビー');
 h.context.BrandGuide.load=async()=>{throw new Error('temporary read failure');};await h.refresh();assert.equal(q(h,'.ag-status').hidden,false);
 h.context.BrandGuide.load=async()=>({data:{allGenre:{revision:'one',products:data,held:[],videoCount:1}}});await h.refresh();assert.equal(q(h,'.ag-status').hidden,true);assert.equal(q(h,'input').value,'ベビー');assert.equal(productRows(h).length,1);
});
test('a valid pending detail update clears an earlier error while keeping the opened record stable',async()=>{
 const h=await harness().start();await openStrollers(h);productRows(h)[0].click();await h.flush();
 h.context.BrandGuide.load=async()=>{throw new Error('temporary read failure');};await h.refresh();assert.equal(q(h,'.ag-status').hidden,false);
 h.context.BrandGuide.load=async()=>({data:{allGenre:{revision:'newer',products:[{...data[0],checks:['新しい確認点']},data[1],data[2]],held:[],videoCount:1}}});await h.refresh();assert.equal(q(h,'.ag-status').hidden,true);assert.ok(q(h,'.ag-detail-page'));assert.equal(h.root.textContent.includes('新しい確認点'),false);
 await h.click('戻る');productRows(h)[0].click();await h.flush();assert.ok(h.root.textContent.includes('新しい確認点'));
});
