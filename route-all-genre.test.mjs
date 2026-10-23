import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('brand-guide/all-genre.js',import.meta.url),'utf8');
const make=(id,name,genre,brand='A')=>({id,name,genre,brand,model:'',features:[{label:'付属品',confirmed:false,note:'未確認'}],checks:[],photo:{image:'data:image/jpeg;base64,',label:'全体',source:'https://example.com'},prices:[],notes:[],evidence:[]});
const data=[make('a','ベビーカー','ベビー用品'),make('b','チャイルドシート','ベビー用品','B'),make('c','電気ポット','生活家電','C')];
function harness(extra={}){
 const nodes=[],document={activeElement:null,createElement:node,addEventListener(){}};
 function contains(n,target){return n===target||n.children.some(x=>contains(x,target));}
 function node(tag){const n={tag,children:[],attrs:{},listeners:{},hidden:false,open:false,append(...xs){for(const x of xs)x.parent=this;this.children.push(...xs);},replaceChildren(...xs){if(this.children.some(x=>contains(x,document.activeElement)))document.activeElement=document.body;for(const x of this.children)x.parent=null;this.children=[];this.append(...xs);},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,f){this.listeners[k]=f;},focus(){document.activeElement=this;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;}};nodes.push(n);return n;}
 document.body=node('body');document.activeElement=document.body;
 const context={URL,document,BrandGuide:{load:async()=>({data:{allGenre:{revision:'one',products:data,held:[],videoCount:1,...extra}}})}};
 vm.runInNewContext(readFileSync(new URL('brand-guide/all-genre-data.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('brand-guide/taxonomy.js',import.meta.url),'utf8')+'\n'+code+'\nthis.view=AllGenre;this.taxonomy=GuideTaxonomy;',context);const root=node('main');return {view:context.view,taxonomy:context.taxonomy,root,nodes,document};
}

const evidence=[{label:'説明',url:'https://www.youtube.com/watch?v=example&t=30'}];
data.forEach(p=>p.evidence=evidence);
const learning={...make('learn','特定モデル','ベビー用品','Guide only'),subgenre:'ベビーベッド',checks:['脚の品番'],notes:[],evidence};
const factor={id:'generic',genre:'ベビー用品',subgenre:'ベビーカー',label:'レザーハンドル',dimension:'material',generalizable:true,confirmed:true,explanation:'素材を高値の手掛かりとして説明。価格差は未確認。',checks:['素材を確認'],sourceIds:['a'],evidence};
const packageOf=(items)=>({version:1,reviewedAt:'2026-10-12',items});
const find=(h,cls)=>h.nodes.find(n=>n.className===cls);
const choose=(h,cls,text)=>find(h,cls).children.find(n=>n.tag==='button'&&n.textContent===text).listeners.click();
const contents=n=>[n.textContent,...n.children.flatMap(contents)].filter(Boolean);

test('subgenre selection and text search keep unrelated products separate',()=>{
 const h=harness();assert.equal(h.view.select(data,'ベビー用品','','','ベビーカー')[0].id,'a');assert.equal(h.view.select(data,'ベビー用品','','','電気ポット').length,0);
 assert.equal(h.view.subgenre(make('s','スノーボードブーツ','スキー・スノーボード')),'スノーボードブーツ');
 assert.equal(h.view.subgenre(make('x','分類不明','ベビー用品')),'その他');
 assert.equal(h.view.select(data,'ベビー用品','B','ベビーカー','ベビーカー').length,0);
});
test('learning records retain evidence without becoming generic factors automatically',async()=>{
 const h=harness({products:[],guides:[learning]});await h.view.mount(h.root).refresh();
 assert.equal(find(h,'ag-product-section').hidden,true);assert.equal(find(h,'ag-factor-section').hidden,true);
 assert.equal(h.view.readGuides([learning])[0].guide,true);
});
test('invalid guide sources, duplicate ids and malformed concise copy are rejected',()=>{
 const h=harness();assert.throws(()=>h.view.readGuides([{...learning,evidence:[{label:'bad',url:'javascript:alert(1)'}]}]));assert.throws(()=>h.view.readGuides([learning,learning]));
 assert.throws(()=>h.view.readGuides([{...learning,quick:{name:'x',clue:'x',check:'x',cautions:[],points:[{text:'x',confirmed:'true'}]}}]));
});
test('unreviewed labels and model names never populate high-price factors',async()=>{
 const p={...data[0],features:[{label:'OMNI Breeze',confirmed:true,note:'個別モデル'},{label:'形状・型番',confirmed:true,note:'識別'}],quick:{name:'特定モデル',points:[{text:'自称高値',confirmed:true}]}};
 const h=harness({products:[p]});await h.view.mount(h.root).refresh();assert.equal(h.view.factorEntries([p]).length,0);assert.equal(find(h,'ag-factor-section').hidden,true);
 assert.ok(!contents(find(h,'ag-factor-list')).includes('OMNI Breeze'));assert.equal(find(h,'ag-grid').children.length,1);
});
test('reviewed generic trait opens only its explanation, checks and supporting source records',async()=>{
 const h=harness({valueFactors:packageOf([factor])});await h.view.mount(h.root).refresh();
 const row=find(h,'ag-factor-row');assert.equal(row.tag,'details');assert.ok(!row.open);assert.equal(row.children[0].children[0].textContent,'レザーハンドル');
 assert.ok(contents(row).includes(factor.explanation));assert.ok(contents(row).includes('素材を確認'));assert.equal(h.nodes.filter(n=>n.tag==='a'&&n.href===evidence[0].url).length,1);
 const f=h.view.factorEntries([data[1]],[factor]);assert.equal(f.length,0);
});
test('generic review requires explicit generalizability, a trait dimension and matching evidence scope',()=>{
 const h=harness();for(const patch of [{generalizable:false},{dimension:'model'},{confirmed:'yes'},{sourceIds:['missing']},{subgenre:'チャイルドシート'},{evidence:[{label:'bad',url:'https://www.youtube.com/watch?v=other'}]},{evidence:[{label:'bad',url:'javascript:alert(1)'}]}])assert.throws(()=>h.view.readValueFactors(packageOf([{...factor,...patch}]),data));
 assert.throws(()=>h.view.readValueFactors(packageOf([factor,{...factor,id:'duplicate-label'}]),data));
 assert.equal(h.view.readValueFactors(packageOf([factor]),data).length,1);
});
test('unverified generalizable claims visibly retain uncertainty',async()=>{
 const h=harness({valueFactors:packageOf([{...factor,confirmed:false,explanation:'自動字幕由来。直接音声は未照合。'}])});await h.view.mount(h.root).refresh();
 assert.ok(contents(find(h,'ag-factor-row')).includes('要確認'));assert.ok(contents(find(h,'ag-factor-row')).includes('自動字幕由来。直接音声は未照合。'));
});
test('all three sections follow the concrete small genre',async()=>{
 const h=harness({guides:[{...learning,subgenre:'抱っこ紐'}],valueFactors:packageOf([factor])});await h.view.mount(h.root).refresh();choose(h,'ag-subgenres','ベビーカー');
 choose(h,'ag-subgenres','抱っこ紐');assert.equal(find(h,'ag-product-section').hidden,true);assert.equal(find(h,'ag-factor-section').hidden,true);assert.equal(find(h,'ag-brand-section').hidden,true);
 choose(h,'ag-genres','生活家電');assert.equal(find(h,'ag-grid').children.length,1);
 for(const cls of ['ag-genres','ag-subgenres'])assert.ok(find(h,cls).children.every(n=>n.textContent!=='すべて'));
});
test('brand section precedes factors and contains only displayed product brands once',async()=>{
 const products=[{...data[0]},{...data[0],id:'a2'}];const h=harness({products,guides:[learning],valueFactors:packageOf([factor])});await h.view.mount(h.root).refresh();
 assert.deepEqual(find(h,'ag-brand-list').children.map(n=>n.textContent),['A']);assert.ok(h.root.children.indexOf(find(h,'ag-brand-section'))<h.root.children.indexOf(find(h,'ag-factor-section')));
 choose(h,'ag-middles','睡眠・くつろぎ');choose(h,'ag-subgenres','ベビーベッド');assert.equal(find(h,'ag-brand-section').hidden,true);
});
test('initial selection uses a populated minor genre and empty libraries remain empty',async()=>{
 const h=harness({products:[make('a','抱っこ紐','ベビー用品'),make('b','電気ポット','生活家電')]});const v=h.view.mount(h.root);await v.refresh();
 const selected=cls=>find(h,cls).children.filter(n=>n.attrs['aria-pressed']==='true');assert.equal(selected('ag-genres')[0].textContent,'ベビー用品');assert.equal(selected('ag-subgenres')[0].textContent,'抱っこ紐');
 choose(h,'ag-genres','生活家電');assert.equal(selected('ag-subgenres')[0].textContent,'電気ポット');await v.refresh();assert.equal(selected('ag-genres').length,1);
 const empty=harness({products:[],guides:[]});await empty.view.mount(empty.root).refresh();assert.equal(find(empty,'ag-genres').children.length,0);
});
test('partial pictures use truthful alt text and empty held lists are hidden',async()=>{
 const p={...data[0],photo:{...data[0].photo,fullProduct:false,coverage:'partial-or-unverified'}};
 const h=harness({products:[p],held:[]});await h.view.mount(h.root).refresh();
 assert.equal(find(h,'ag-held').hidden,true);assert.equal(h.nodes.find(n=>n.tag==='img').alt,p.name+'の参考画像');
 const held=harness({held:[{id:'pending',name:'不明品',reason:'根拠なし'}]});await held.view.mount(held.root).refresh();assert.equal(find(held,'ag-held').hidden,false);
});

test('growing reviewed library accepts over 200 traits but retains a hard bound and source validation',()=>{const h=harness();const items=Array.from({length:4000},(_,i)=>({...factor,id:'factor-'+i,label:'trait-'+i}));assert.equal(h.view.readValueFactors(packageOf(items),data).length,4000);assert.throws(()=>h.view.readValueFactors(packageOf([...items,{...factor,id:'overflow',label:'overflow'}]),data));assert.throws(()=>h.view.readValueFactors(packageOf([...items.slice(0,200),{...factor,id:'bad',label:'bad',sourceIds:['missing']}]),data));});

test('unknown brand placeholders are omitted from brand lists and filters without removing their products',async()=>{
 const products=[make('known','ベビーカー','ベビー用品','Aprica'),make('unknown','ベビーカー不明品','ベビー用品','ブランド未確認'),make('maker','ベビーカー参考品','ベビー用品','メーカー未確認')];
 const h=harness({products});await h.view.mount(h.root).refresh();
 assert.deepEqual(find(h,'ag-brand-list').children.map(n=>n.textContent),['Aprica']);
 assert.equal(find(h,'ag-grid').children.length,3);
});

test('middle selection narrows leaves and keeps products, brands and reviewed factors in scope',async()=>{
 const drum={...data[0],id:'drum',genre:'楽器',subgenre:'電子ドラム',name:'電子ドラム'},guitar={...drum,id:'guitar',name:'ギター',subgenre:'ギター'};
 const trait={...factor,genre:'楽器',subgenre:'電子ドラム',sourceIds:['drum']};
 const h=harness({products:[drum,guitar],valueFactors:packageOf([trait])});await h.view.mount(h.root).refresh();
 assert.equal(find(h,'ag-middle-box').hidden,false);
 choose(h,'ag-middles','打楽器');assert.deepEqual(find(h,'ag-subgenres').children.map(n=>n.textContent),['電子ドラム']);assert.equal(find(h,'ag-grid').children.length,1);assert.ok(contents(find(h,'ag-factor-list')).includes(trait.label));
 choose(h,'ag-middles','ギター・ベース');assert.deepEqual(find(h,'ag-subgenres').children.map(n=>n.textContent),['ギター']);assert.equal(find(h,'ag-factor-section').hidden,true);
 assert.ok(contents(h.root).includes('オールジャンル図鑑'));assert.ok(!contents(h.root).includes('中ジャンル'));assert.ok(!h.nodes.some(n=>n.tag==='input'||n.tag==='select'));
});
test('aliases merge only the displayed labels while product IDs and original evidence remain intact',async()=>{
 const rows=[{...data[0],id:'x',genre:'楽器',subgenre:'楽器用ケース'},{...data[0],id:'y',genre:'楽器',subgenre:'楽器ケース'}],before=JSON.stringify(rows);
 const h=harness({products:rows});await h.view.mount(h.root).refresh();
 assert.deepEqual(find(h,'ag-subgenres').children.map(n=>n.textContent),['楽器ケース']);assert.equal(find(h,'ag-grid').children.length,2);assert.equal(JSON.stringify(rows),before);assert.equal(find(h,'ag-middle-box').hidden,true);
 assert.equal(h.taxonomy.classify('アウトドア','チェア').subgenre,'チェア');assert.equal(h.taxonomy.classify('家具','チェア').subgenre,'椅子');assert.equal(h.taxonomy.classify('生活家電','餅つき機').subgenre,'もちつき機');
});
test('moved products carry reviewed factors and preserve every original source reference',async()=>{
 const p={...data[0],genre:'生活家電',subgenre:'スピーカー'},trait={...factor,genre:p.genre,subgenre:p.subgenre},before=JSON.stringify([p,trait]);
 const h=harness({products:[p],valueFactors:packageOf([trait])});await h.view.mount(h.root).refresh();
 assert.deepEqual(find(h,'ag-genres').children.map(n=>n.textContent),['オーディオ機器']);assert.equal(find(h,'ag-grid').children.length,1);assert.ok(contents(find(h,'ag-factor-list')).includes(trait.label));assert.equal(JSON.stringify([p,trait]),before);
 const tax=h.taxonomy;const projected=[tax.project(p,p.subgenre),tax.project({...p,id:'b',genre:'楽器',subgenre:'アンプ'},'アンプ')];const split=tax.factors([{...trait,sourceIds:['a','b']}],projected);assert.equal(split.length,2);assert.deepEqual(split.flatMap(f=>f.sourceIds),['a','b']);
});
test('new unknown categories remain reachable and refreshed data repairs obsolete selections',async()=>{
 const options={products:[{...data[0],genre:'新しいジャンル',subgenre:'新しい種類'}]},h=harness(options),v=h.view.mount(h.root);await v.refresh();
 assert.equal(find(h,'ag-grid').children.length,1);assert.deepEqual(find(h,'ag-subgenres').children.map(n=>n.textContent),['新しい種類']);
 options.revision='two';options.products=[{...data[0],genre:'旅行用品',subgenre:'スーツケース'}];await v.refresh();assert.deepEqual(find(h,'ag-genres').children.map(n=>n.textContent),['旅行用品']);assert.equal(find(h,'ag-grid').children.length,1);assert.equal(find(h,'ag-middle-box').hidden,true);
 assert.equal(h.taxonomy.classify('__proto__','constructor').subgenre,'constructor');
});

test('category selection collapses at the final choice and keeps keyboard focus on a live control',async()=>{
 const h=harness();await h.view.mount(h.root).refresh();const picker=find(h,'ag-picker'),path=find(h,'ag-current-path');
 assert.equal(picker.open,false);picker.open=true;
 const old=find(h,'ag-genres').children[0];old.focus();choose(h,'ag-genres','ベビー用品');
 assert.equal(picker.open,true);assert.equal(h.document.activeElement,find(h,'ag-genres').children.find(n=>n.textContent==='ベビー用品'));assert.notEqual(h.document.activeElement,old);
 choose(h,'ag-subgenres','チャイルドシート');assert.equal(picker.open,false);assert.equal(h.document.activeElement,path);assert.equal(path.textContent,'ベビー用品 › 移動・お出かけ › チャイルドシート');
 picker.open=true;choose(h,'ag-genres','生活家電');assert.equal(picker.open,false);assert.equal(h.document.activeElement,path);assert.equal(path.textContent,'生活家電 › 調理家電 › 電気ポット');
 assert.equal(find(h,'ag-middle-box').hidden,true);assert.equal(find(h,'ag-subgenre-box').hidden,true);
});

test('one-choice rows and empty sections are omitted with only one empty-state message',async()=>{
 const h=harness({products:[],guides:[learning]});await h.view.mount(h.root).refresh();
 for(const cls of ['ag-genres','ag-middle-box','ag-subgenre-box','ag-brand-section','ag-factor-section','ag-product-section'])assert.equal(find(h,cls).hidden,true,cls);
 assert.equal(find(h,'ag-grid').children.length,0);assert.equal(find(h,'ag-factor-list').children.length,0);
 assert.equal(contents(h.root).filter(text=>text==='この分類の情報はまだありません。').length,1);
 assert.ok(!contents(h.root).some(text=>text.includes('汎用的な高値要素は未確認')));
});

test('library refresh preserves category focus even when a formerly selectable row becomes redundant',async()=>{
 const extra={products:[...data]},h=harness(extra),view=h.view.mount(h.root);await view.refresh();find(h,'ag-picker').open=true;
 find(h,'ag-subgenres').children[0].focus();extra.revision='two';await view.refresh();assert.equal(h.document.activeElement,find(h,'ag-subgenres').children[0]);
 extra.products=[data[0]];extra.revision='three';await view.refresh();assert.equal(h.document.activeElement,find(h,'ag-current-path'));assert.equal(find(h,'ag-subgenre-box').hidden,true);
});

test('brand list is available on demand and cards omit repeated brand and category names',async()=>{
 const p={...data[0],brand:'Aprica',name:'Ａｐｒｉｃａ ベビーカー'},h=harness({products:[p]});await h.view.mount(h.root).refresh();
 const brands=find(h,'ag-brand-section');assert.equal(brands.tag,'details');assert.equal(brands.open,false);assert.deepEqual(find(h,'ag-brand-list').children.map(n=>n.textContent),['Aprica']);
 assert.deepEqual(contents(find(h,'ag-card-body')),[p.name]);assert.ok(!contents(find(h,'ag-card-body')).includes('ベビーカー'));
});

test('product details keep close outside scrolling content and preserve collapsed prices and source links',async()=>{
 const p={...data[0],brand:'Aprica',name:'Aprica ベビーカー',model:'MODEL',identity:'同一品番',checks:['車輪の摩耗'],prices:[['仕入価格','1,000円']],notes:['欠品を確認'],kind:'紹介・比較例'},h=harness({products:[p]});await h.view.mount(h.root).refresh();
 const card=find(h,'ag-grid').children[0];card.focus();card.listeners.click();
 const dialog=find(h,'ag-detail'),header=find(h,'ag-detail-header'),body=find(h,'ag-detail-body');
 assert.equal(dialog.open,true);assert.deepEqual(dialog.children,[header,body]);assert.equal(header.children[0].textContent,'閉じる ×');
 assert.equal(body.children[0].tag,'img');assert.equal(body.children[1].textContent,p.name);assert.ok(contents(body).includes('動画の紹介例'));
 const checks=body.children.find(n=>n.tag==='section'),info=body.children.find(n=>n.tag==='details'),sources=body.children.at(-1);
 assert.ok(body.children.indexOf(checks)<body.children.indexOf(info));assert.equal(info.open,false);assert.equal(sources.open,false);assert.equal(sources.children[0].textContent,'出典');
 assert.ok(contents(info).includes('1,000円'));assert.ok(contents(info).includes('欠品を確認'));assert.ok(contents(info).some(x=>x.includes('今回の仕入れ品の実売・利益ではありません')));
 assert.ok(sources.children.some(n=>n.href===evidence[0].url));assert.ok(sources.children.some(n=>n.href===p.photo.source));
 header.children[0].listeners.click();assert.equal(h.document.activeElement,card);assert.ok(!h.document.body.children.includes(dialog));
});
