import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import AllGenreData from './brand-guide/all-genre-data.js';

const sources=['brand-guide-assets.js','brand-guide.js'].map(name=>readFileSync(new URL(name,import.meta.url),'utf8')).join('\n');
const LEGACY='sedori-private-brand-guide',CURRENT='sedori-private-guide-images';
const image='data:image/jpeg;base64,/9j/2Q==',url='https://www.youtube.com/watch?v=example';
function data(){return {version:1,updatedAt:'2026-10-23',brands:[{id:'brand',name:'Brand',aliases:[],groups:[{period:'2024年',photos:[{image,source:url,basis:'掲載例',currentOfficial:false}]}],method:{code:'',highlight:'',result:'',how:'',caution:'',mode:''},sources:[{title:'出典',url}]}],baycrews:{title:'',how:'',caution:'',confirmed:[],unconfirmed:[],examples:[],source:url}};}
function record(schemaVersion=1){const value=data();if(schemaVersion===2){const sha='a'.repeat(64);value.brands[0].groups[0].photos[0]={...value.brands[0].groups[0].photos[0],image:undefined,assetSha256:sha};value.assetManifest={version:1,bundles:[{sha256:'b'.repeat(64),bytes:100,imageShas:[sha]}]};}return {schemaVersion,data:value,sha:'old-'+schemaVersion,remoteRevision:10};}
function envelope(value){const payload=JSON.stringify(value);return JSON.stringify({format:'private-brand-guide',schemaVersion:1,payload,sha256:createHash('sha256').update(payload).digest('hex')});}
function file(value){const raw=envelope(value);return {size:Buffer.byteLength(raw),text:async()=>raw};}
function harness({legacy=null,current=null,fail=null}={}){
  const stored=new Map([[LEGACY,legacy],[CURRENT,current]]);let writeCount=0;
  const indexedDB={open(name){assert.ok(stored.has(name));const request={};const db={close(){},transaction(_store,mode){
    let draft=structuredClone(stored.get(name)),done=false,timer;
    const tx={error:null,abort(){if(done)return;done=true;clearTimeout(timer);queueMicrotask(()=>tx.onabort?.());}};
    function finish(){clearTimeout(timer);timer=setTimeout(()=>{if(done)return;if(mode==='readwrite'&&name===CURRENT&&fail==='abort'){tx.error=new Error('abort');tx.abort();return;}done=true;if(mode==='readwrite'){stored.set(name,draft);writeCount++;}tx.oncomplete?.();},0);}
    tx.objectStore=()=>({get(key){assert.equal(key,'active');const r={};queueMicrotask(()=>{if(done)return;r.result=structuredClone(draft);r.onsuccess?.({target:r});finish();});return r;},put(value,key){assert.equal(key,'active');if(name===CURRENT&&fail==='quota')throw Object.assign(new Error('quota'),{name:'QuotaExceededError'});draft=structuredClone(value);if(name===CURRENT&&fail==='mismatch')draft.sha='wrong';const r={};queueMicrotask(()=>{if(!done){r.onsuccess?.();finish();}});return r;}});return tx;}};
    queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
  class Image{naturalWidth=40;naturalHeight=20;set src(value){if(value)queueMicrotask(()=>this.onload?.());}}
  const context={module:{exports:{}},AllGenreData,Image,indexedDB,URL,TextEncoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout};
  vm.runInNewContext(sources,context);return {guide:context.module.exports,saved:name=>stored.get(name),writes:()=>writeCount};
}

test('legacy-photo import replaces schema2 active library and survives reopening without changing legacy backup',async()=>{
  const old=record(2),legacy=record(1),h=harness({legacy,current:old}),next=data();next.brands[0].name='Newly imported';
  const imported=await h.guide.importFile(file(next));
  assert.equal((await h.guide.load()).sha,imported.sha);
  assert.equal(h.saved(CURRENT).data.brands[0].name,'Newly imported');
  assert.equal(h.saved(CURRENT).schemaVersion,1);assert.equal(h.saved(LEGACY).sha,legacy.sha);assert.equal(h.writes(),1);
});
test('first save migrates to current active library while retaining legacy data and downgrade protection',async()=>{
  const legacy=record(1),h=harness({legacy}),older=data();older.updatedAt='2026-10-22';
  await assert.rejects(h.guide.importFile(file(older)),/古い/);assert.equal(h.saved(CURRENT),null);
  const next=data();next.brands[0].name='Migrated';const imported=await h.guide.importFile(file(next));
  assert.equal((await h.guide.load()).sha,imported.sha);assert.equal(h.saved(LEGACY).sha,legacy.sha);
});
for(const fail of ['abort','quota','mismatch'])test(`${fail} during cross-schema import retains the original active and legacy records`,async()=>{
  const current=record(2),legacy=record(1),h=harness({legacy,current,fail});
  await assert.rejects(h.guide.importFile(file(data())));
  assert.equal(h.saved(CURRENT).sha,current.sha);assert.equal(h.saved(LEGACY).sha,legacy.sha);assert.equal(h.writes(),0);
});
test('same content cannot discard a known remote revision and older remote releases cannot replace it',async()=>{
  const old=record(1),h=harness({current:old});
  const same={...structuredClone(old),remoteRevision:undefined};await h.guide.save(same);assert.equal((await h.guide.load()).remoteRevision,10);
  await assert.rejects(h.guide.save({...record(1),sha:'older',remoteRevision:9}),/以前の版/);assert.equal((await h.guide.load()).remoteRevision,10);
});
function withAllGenre(){const value=data(),product={id:'product',name:'ベビーカー',brand:'Brand',genre:'ベビー用品',subgenre:'ベビーカー',model:'',identity:'',photo:{image,fullProduct:true,label:'商品全体',source:url},features:[],checks:[],prices:[],notes:[],evidence:[{label:'動画',url}]};value.allGenre={version:1,revision:'test',videoCount:1,products:[product],held:[],guides:[{id:'guide',name:'説明',brand:'Brand',genre:'ベビー用品',subgenre:'ベビーカー',model:'',features:[],checks:[],notes:[],evidence:[{label:'動画',url}]}],valueFactors:{version:1,reviewedAt:'2026-10-23',items:[{id:'factor',genre:'ベビー用品',subgenre:'ベビーカー',label:'確認ポイント',dimension:'condition',generalizable:true,confirmed:true,explanation:'状態を確認',checks:[],sourceIds:['product'],evidence:[{label:'動画',url}]}]}};return value;}
test('unrecognised genre names cannot resolve inherited properties during shared classification',()=>{
 for(const genre of ['constructor','__proto__','toString'])assert.equal(AllGenreData.subgenre({genre,name:'Unknown',model:''}),'その他');
});
const invalids=[
 ['invalid guide source',a=>a.guides[0].evidence[0].url='https://example.org'],
 ['invalid quick-copy type',a=>a.guides[0].quick={name:'',clue:'',check:'',points:[],cautions:[]}],
 ['duplicate guide/product id',a=>a.guides[0].id=a.products[0].id],
 ['oversized factor label',a=>a.valueFactors.items[0].label='a'.repeat(61)],
 ['different source genre',a=>a.valueFactors.items[0].genre='楽器'],
 ['different source subgenre',a=>a.valueFactors.items[0].subgenre='チャイルドシート'],
 ['unrelated video evidence',a=>a.valueFactors.items[0].evidence[0].url='https://www.youtube.com/watch?v=other'],
 ['duplicate factor label',a=>a.valueFactors.items.push({...a.valueFactors.items[0],id:'duplicate'})],
];
for(const [label,change]of invalids)test(`${label} is rejected before committing any replacement`,async()=>{
 const old=record(2),h=harness({current:old}),value=withAllGenre();change(value.allGenre);
 await assert.rejects(h.guide.importFile(file(value)));assert.equal(h.writes(),0);assert.equal(h.saved(CURRENT).sha,old.sha);
});
test('accepted guide and factor limits pass the exact validators used by the display',async()=>{
 const h=harness(),value=withAllGenre();value.allGenre.valueFactors.items[0].label='a'.repeat(60);
 await h.guide.importFile(file(value));const saved=(await h.guide.load()).data.allGenre;
 const guides=AllGenreData.readGuides(saved.guides);assert.equal(guides.length,1);
 assert.equal(AllGenreData.readValueFactors(saved.valueFactors,[...saved.products,...guides]).length,1);
});
test('valid import can repair an existing payload rejected by the display validator',async()=>{
 const current=record(1);current.data=withAllGenre();current.data.allGenre.guides[0].evidence[0].url='https://example.org';
 const h=harness({current});await assert.rejects(h.guide.load());
 const imported=await h.guide.importFile(file(data()));assert.equal((await h.guide.load()).sha,imported.sha);
});
