import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('brand-guide/all-genre.js',import.meta.url),'utf8');
const make=(id,name,genre,brand='A')=>({id,name,genre,brand,model:'',features:[{label:'付属品',confirmed:false,note:'未確認'}],checks:[],photo:{image:'data:image/jpeg;base64,',label:'全体',source:'https://example.com'},prices:[],notes:[],evidence:[]});
const data=[make('a','ベビーカー','ベビー用品'),make('b','チャイルドシート','ベビー用品','B'),make('c','電気ポット','生活家電','C')];
function harness(){
 const nodes=[];function node(tag){const n={tag,children:[],attrs:{},listeners:{},hidden:false,append(...xs){this.children.push(...xs);},replaceChildren(...xs){this.children=xs;},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,f){this.listeners[k]=f;}};nodes.push(n);return n;}
 const context={document:{createElement:node,addEventListener(){}},BrandGuide:{load:async()=>({data:{allGenre:{revision:'one',products:data,held:[],videoCount:1}}})}};
 vm.runInNewContext(code+'\nthis.view=AllGenre;',context);const root=node('main');return {view:context.view,root,nodes};
}
test('small genres do not mix unrelated types and preserve unknown categories',()=>{
 const h=harness();assert.equal(h.view.select(data,'ベビー用品','','','ベビーカー')[0].id,'a');assert.equal(h.view.select(data,'ベビー用品','','','電気ポット').length,0);
 assert.ok(h.view.subgenres(data,'ベビー用品').includes('抱っこ紐'));
 assert.equal(h.view.subgenre(make('s','スノーボードブーツ','スキー・スノーボード')),'スノーボードブーツ');
 assert.equal(h.view.subgenre(make('x','分類不明','ベビー用品')),'その他');
 assert.equal(h.view.select(data,'ベビー用品','B','ベビーカー','ベビーカー').length,0);
});
test('feature aggregation separates confirmed and unconfirmed claims',()=>{
 const h=harness(),copy=structuredClone(data);copy[1].name='ベビーカー';copy[1].features[0].confirmed=true;
 const g=h.view.featureGroups(copy.slice(0,2));assert.equal(g.length,2);assert.equal(g[0].confirmed,false);assert.equal(g[1].confirmed,true);
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
