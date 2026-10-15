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
 assert.equal(find(h,'ag-grid').children[0].tag,'p');assert.equal(find(h,'ag-factor-list').children[0].tag,'p');
 assert.equal(h.view.readGuides([learning])[0].guide,true);
});
test('invalid guide sources, duplicate ids and malformed concise copy are rejected',()=>{
 const h=harness();assert.throws(()=>h.view.readGuides([{...learning,evidence:[{label:'bad',url:'javascript:alert(1)'}]}]));assert.throws(()=>h.view.readGuides([learning,learning]));
 assert.throws(()=>h.view.readGuides([{...learning,quick:{name:'x',clue:'x',check:'x',cautions:[],points:[{text:'x',confirmed:'true'}]}}]));
});
test('unreviewed labels and model names never populate high-price factors',async()=>{
 const p={...data[0],features:[{label:'OMNI Breeze',confirmed:true,note:'個別モデル'},{label:'形状・型番',confirmed:true,note:'識別'}],quick:{name:'特定モデル',points:[{text:'自称高値',confirmed:true}]}};
 const h=harness({products:[p]});await h.view.mount(h.root).refresh();assert.equal(h.view.factorEntries([p]).length,0);assert.equal(find(h,'ag-factor-list').children[0].tag,'p');
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
test('category changes reset brand and all three sections follow the concrete small genre',async()=>{
 const h=harness({valueFactors:packageOf([factor])});await h.view.mount(h.root).refresh();choose(h,'ag-subgenres','ベビーカー');
 const brands=h.nodes.find(n=>n.tag==='select');brands.value='A';brands.listeners.change();choose(h,'ag-subgenres','抱っこ紐');assert.equal(brands.value,'');assert.equal(find(h,'ag-grid').children[0].tag,'p');assert.equal(find(h,'ag-factor-list').children[0].tag,'p');assert.equal(find(h,'ag-brand-list').children[0].className,'ag-brand-empty');
 choose(h,'ag-genres','生活家電');assert.equal(find(h,'ag-grid').children.length,1);
 for(const cls of ['ag-genres','ag-subgenres'])assert.ok(find(h,cls).children.every(n=>n.textContent!=='すべて'));
});
test('brand section precedes factors and contains only displayed product brands once',async()=>{
 const products=[{...data[0]},{...data[0],id:'a2'}];const h=harness({products,guides:[learning],valueFactors:packageOf([factor])});await h.view.mount(h.root).refresh();
 assert.deepEqual(find(h,'ag-brand-list').children.map(n=>n.textContent),['A']);assert.ok(h.root.children.indexOf(find(h,'ag-brand-section'))<h.root.children.indexOf(find(h,'ag-factor-section')));
 const search=h.nodes.find(n=>n.tag==='input');search.value='存在しない';search.listeners.input();assert.equal(find(h,'ag-brand-list').children[0].className,'ag-brand-empty');
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
