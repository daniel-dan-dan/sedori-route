import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('brand-guide/all-genre.js',import.meta.url),'utf8');
const make=(id,name,genre,brand='A')=>({id,name,genre,brand,model:'',features:[{label:'付属品',confirmed:false,note:'未確認'}],checks:[],photo:{image:'data:image/jpeg;base64,',label:'全体',source:'https://example.com'},prices:[],notes:[],evidence:[]});
const data=[make('a','ベビーカー','ベビー用品'),make('b','チャイルドシート','ベビー用品','B'),make('c','電気ポット','生活家電','C')];
function harness(extra={}){
 const nodes=[];function node(tag){const n={tag,children:[],attrs:{},listeners:{},hidden:false,append(...xs){this.children.push(...xs);},replaceChildren(...xs){this.children=xs;},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,f){this.listeners[k]=f;}};nodes.push(n);return n;}
 const context={URL,document:{createElement:node,addEventListener(){}},BrandGuide:{load:async()=>({data:{allGenre:{revision:'one',products:data,held:[],videoCount:1,...extra}}})}};
 vm.runInNewContext(code+'\nthis.view=AllGenre;',context);const root=node('main');return {view:context.view,root,nodes};
}
test('small genres do not mix unrelated types and preserve unknown categories',()=>{
 const h=harness();assert.equal(h.view.select(data,'ベビー用品','','','ベビーカー')[0].id,'a');assert.equal(h.view.select(data,'ベビー用品','','','電気ポット').length,0);
 assert.ok(h.view.subgenres(data,'ベビー用品').includes('抱っこ紐'));
 assert.equal(h.view.subgenre(make('s','スノーボードブーツ','スキー・スノーボード')),'スノーボードブーツ');
 assert.equal(h.view.subgenre(make('x','分類不明','ベビー用品')),'その他');
 assert.equal(h.view.select(data,'ベビー用品','B','ベビーカー','ベビーカー').length,0);
});
const learning={id:'learn-bed',name:'ココネルエアー',brand:'Aprica',genre:'ベビー用品',subgenre:'ベビーベッド',model:'',features:[{label:'重点モデル',confirmed:true,note:'動画の説明'}],checks:['脚の品番'],notes:['全体画像は確認待ち'],evidence:[{label:'9:30',url:'https://www.youtube.com/watch?v=shSa9vO8ZTE&t=570'}]};
test('learning records show factors without a publishable product image',async()=>{
 const h=harness({products:[],guides:[learning]});await h.view.mount(h.root).refresh();
 const section=cls=>h.nodes.find(n=>n.className===cls),choose=(box,text)=>box.children.find(n=>n.tag==='button'&&n.textContent===text).listeners.click();
 choose(section('ag-genres'),'ベビー用品');choose(section('ag-subgenres'),'ベビーベッド');
 assert.equal(section('ag-factor-list').children[0].tag,'section');assert.equal(section('ag-grid').children[0].tag,'p');
 assert.equal(h.view.select(h.view.readGuides([learning]),'ベビー用品','Aprica','','ベビーベッド').length,1);
 assert.equal(h.view.subgenre(make('j','ジュニアシート','ベビー用品')),'ジュニアシート');
});
test('malformed independent learning sources are rejected before rendering',()=>{
 const h=harness();assert.deepEqual(Array.from(h.view.readGuides(undefined)),[]);
 assert.throws(()=>h.view.readGuides([{...learning,evidence:[{label:'bad',url:'javascript:alert(1)'}]}]));
 assert.throws(()=>h.view.readGuides([learning,learning]));assert.throws(()=>h.view.readGuides([{...learning,features:[{label:'x',confirmed:'yes',note:'x'}]}]));
});
test('feature aggregation separates confirmed and unconfirmed claims',()=>{
 const h=harness(),copy=structuredClone(data);copy[1].name='ベビーカー';copy[1].features[0].confirmed=true;
 const g=h.view.featureGroups(copy.slice(0,2));assert.equal(g.length,2);assert.equal(g[0].confirmed,false);assert.equal(g[1].confirmed,true);
});
const quick={name:'注目モデル',clue:'前面の特徴',check:'タグを確認',cautions:['型番は未確認'],points:[{text:'共通の特徴',confirmed:true}]};
test('shared subgenre advice is shown once while model clues stay separate',async()=>{
 const guides=[{...learning,id:'one',brand:'A',name:'モデルA',quick:{...quick,name:'モデルA',clue:'線が2本'}},{...learning,id:'two',brand:'B',name:'モデルB',quick:{...quick,name:'モデルB',clue:'メッシュ素材'}}];
 const h=harness({products:[],guides}),groups=h.view.quickGroups(h.view.readGuides(guides));
 assert.equal(groups.length,1);assert.equal(groups[0].points.length,1);assert.equal(groups[0].checks.length,1);assert.equal(groups[0].cautions.length,1);assert.equal(groups[0].targets[0].clue,'線が2本');assert.equal(groups[0].targets[1].clue,'メッシュ素材');
 await h.view.mount(h.root).refresh();
 assert.equal(h.nodes.filter(n=>n.className==='ag-factor-row').length,1);
 assert.equal(h.nodes.filter(n=>n.className==='ag-factor-evidence').length,2);
 assert.equal(h.nodes.filter(n=>n.tag==='a'&&n.href===learning.evidence[0].url).length,2);
 const brands=h.nodes.find(n=>n.tag==='select');brands.value='B';brands.listeners.change();
 const current=h.nodes.find(n=>n.className==='ag-factor-list').children[0];
 const text=n=>[n.textContent,...n.children.flatMap(c=>text(c))].filter(Boolean);
 assert.ok(text(current).includes('見分け方：メッシュ素材'));assert.ok(!text(current).includes('見分け方：線が2本'));
});
test('bad concise copy is rejected rather than silently losing uncertainty',()=>{
 const h=harness();
 for(const q of [{...quick,points:[{text:'x',confirmed:'true'}]},{...quick,clue:'x'.repeat(121)},{...quick,points:Array(4).fill({text:'x',confirmed:true})},{...quick,cautions:['x'.repeat(81)]}])assert.throws(()=>h.view.readGuides([{...learning,quick:q}]));
});
test('model warnings stay on their own row and repeated sources do not erase them',()=>{
 const h=harness(),guides=[{...learning,id:'a',brand:'A',quick:{...quick,cautions:['モデルAの注意']}},{...learning,id:'a2',brand:'A',quick:{...quick,cautions:['別動画の注意']}},{...learning,id:'b',brand:'B',quick:{...quick,cautions:[]}}];
 const g=h.view.quickGroups(h.view.readGuides(guides))[0];assert.equal(g.targets.length,2);assert.equal(g.cautions.length,0);
 assert.deepEqual(Array.from(g.targets[0].cautions),['モデルAの注意','別動画の注意']);assert.equal(g.targets[1].cautions.length,0);
});
test('legacy facts retain uncertainty and full details when the visible list is capped',async()=>{
 const ps=[make('one','ベビーカー','ベビー用品'),make('two','ベビーカー2','ベビー用品')];
 ps[0].features=[{label:'同じ特徴',confirmed:false,note:'未確認の全文'},{label:'二番目',confirmed:true,note:'理由2'},{label:'三番目',confirmed:true,note:'理由3'}];
 ps[1].features=[{label:'同じ特徴',confirmed:true,note:'確認済みの全文'},{label:'四番目',confirmed:false,note:'理由4'}];
 const h=harness({products:ps});await h.view.mount(h.root).refresh();
 assert.equal(h.view.quickGroups(ps)[0].points.length,5);
 assert.equal(h.nodes.filter(n=>n.className==='ag-factor-row').length,5);
 assert.ok(h.nodes.some(n=>n.textContent==='未確認の全文'));assert.ok(h.nodes.some(n=>n.textContent==='理由4'));
 assert.ok(h.nodes.some(n=>n.textContent==='要確認'));
});
test('category changes reset small type and brand; both sections follow empty and matching selections',async()=>{
 const h=harness(),v=h.view.mount(h.root);await v.refresh();
 const section=cls=>h.nodes.find(n=>n.className===cls),buttons=box=>box.children.filter(n=>n.tag==='button'),choose=(box,text)=>buttons(box).find(n=>n.textContent===text).listeners.click();
 choose(section('ag-genres'),'ベビー用品');assert.equal(section('ag-subgenre-box').hidden,false);
 choose(section('ag-subgenres'),'ベビーカー');assert.equal(section('ag-grid').children.length,1);
 const brands=h.nodes.find(n=>n.tag==='select');brands.value='A';brands.listeners.change();
 choose(section('ag-subgenres'),'抱っこ紐');assert.equal(brands.value,'');assert.equal(section('ag-grid').children[0].tag,'p');assert.equal(section('ag-factor-list').children[0].tag,'p');
 choose(section('ag-genres'),'生活家電');choose(section('ag-subgenres'),'電気ポット');assert.equal(section('ag-grid').children.length,1);
 choose(section('ag-genres'),'すべて');assert.equal(section('ag-subgenre-box').hidden,true);assert.equal(section('ag-grid').children.length,3);
 assert.equal(h.root.children.filter(n=>n.tag==='section' && /ag-(factor|product)-section/.test(n.className)).length,2);
});

test('individual factors start folded, mesh and ISOFIX are separate, and conditions and source scope survive',async()=>{
 const guides=[{...learning,id:'mesh',subgenre:'抱っこ紐',name:'Model M',features:[{label:'Model M・メッシュ',confirmed:true,note:'mesh source'}],quick:{...quick,name:'Model M',points:[]}},{...learning,id:'fix',subgenre:'チャイルドシート',name:'Model I',features:[{label:'ISOFIX・新しい世代',confirmed:true,note:'fix source'}],quick:{...quick,name:'Model I',points:[{text:'ISOFIX型',confirmed:true},{text:'同じ価格なら新しい世代',confirmed:true}]}}];
 const h=harness({products:[],guides});await h.view.mount(h.root).refresh();
 const entries=h.view.factorEntries(h.view.readGuides(guides));assert.deepEqual(Array.from(entries,e=>e.label),['メッシュ','ISOFIX','新しい世代']);
 assert.equal(entries[0].records.length,1);assert.equal(entries[0].records[0].id,'mesh');
 assert.equal(entries[1].records[0].id,'fix');assert.equal(entries[2].labels[0],'同じ価格なら新しい世代');
 const rows=h.nodes.filter(n=>n.className==='ag-factor-row');assert.equal(rows.length,3);
 for(const row of rows){assert.equal(row.tag,'details');assert.ok(!row.open);assert.equal(row.children[0].tag,'summary');assert.ok(row.children[1].children.length);}
 assert.ok(h.nodes.some(n=>n.textContent==='同じ価格なら新しい世代'));
 assert.ok(h.nodes.some(n=>n.textContent==='mesh source'));assert.ok(h.nodes.some(n=>n.textContent==='fix source'));
});

test('brand section precedes factors and follows displayed products without guide-only brands or duplicates',async()=>{
 const products=[make('a','ベビーカー','ベビー用品','A'),make('b','ベビーカー2','ベビー用品','A'),make('c','抱っこ紐','ベビー用品','B')];
 const h=harness({products,guides:[{...learning,brand:'Guide only'}]});await h.view.mount(h.root).refresh();
 const section=cls=>h.nodes.find(n=>n.className===cls),list=section('ag-brand-list');
 assert.deepEqual(list.children.map(n=>n.textContent),['A','B']);assert.ok(h.root.children.indexOf(section('ag-brand-section'))<h.root.children.indexOf(section('ag-factor-section')));
 const choose=(box,text)=>box.children.find(n=>n.tag==='button'&&n.textContent===text).listeners.click();
 choose(section('ag-genres'),'ベビー用品');choose(section('ag-subgenres'),'ベビーカー');assert.deepEqual(list.children.map(n=>n.textContent),['A']);
 const search=h.nodes.find(n=>n.tag==='input');search.value='存在しない';search.listeners.input();assert.equal(list.children[0].className,'ag-brand-empty');
 search.value='';search.listeners.input();choose(section('ag-subgenres'),'抱っこ紐');assert.deepEqual(list.children.map(n=>n.textContent),['B']);
 choose(section('ag-subgenres'),'ベビーベッド');assert.equal(list.children[0].className,'ag-brand-empty');
});
