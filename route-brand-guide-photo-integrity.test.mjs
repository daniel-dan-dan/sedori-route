import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';

const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
function database(options={}) {
 const stores=new Map(['images','bundles','library'].map(name=>[name,new Map()]));
 let opens=0,commits=0;
 return {stores,get opens(){return opens;},get commits(){return commits;},indexedDB:{open(){
  opens++;const request={};queueMicrotask(()=>{request.result={close(){},transaction(names,mode){
   const selected=Array.isArray(names)?names:[names],draft=new Map(selected.map(name=>[name,new Map(stores.get(name))]));
   let queued=0,finished=false;
   const tx={error:null,abort(){if(finished)return;finished=true;queueMicrotask(()=>tx.onabort?.());}};
   function operation(action){queued++;const req={};queueMicrotask(()=>{
    if(finished)return;
    try{action(req);req.onsuccess?.({target:req});}catch(error){tx.error=error;tx.abort();return;}
    queued--;queueMicrotask(()=>{if(finished||queued)return;finished=true;
     if(mode==='readwrite'){for(const [name,values]of draft)stores.set(name,values);commits++;options.afterCommit?.(stores,selected);}
     tx.oncomplete?.();
    });
   });return req;}
   tx.objectStore=name=>{
    assert.ok(draft.has(name));return {
     get:key=>operation(req=>{req.result=structuredClone(draft.get(name).get(key));}),
     put(value,key){if(options.quota)throw Object.assign(new Error('quota'),{name:'QuotaExceededError'});return operation(()=>draft.get(name).set(key,structuredClone(value)));}
    };
   };return tx;
  }};request.onsuccess?.();});return request;
 }}};
}
function fixtures(count=4){
 const bundles=Array.from({length:count},(_,index)=>{
  const bytes=Buffer.from([255,216,255,217,index]),sha256=hash(bytes),image='data:image/jpeg;base64,'+bytes.toString('base64');
  const raw=JSON.stringify({format:'private-brand-guide-assets',schemaVersion:1,images:[{sha256,image}]});
  return {raw,image,sha256:hash(raw),bytes:Buffer.byteLength(raw),imageShas:[sha256]};
 });
 const data={updatedAt:'2026-10-29',brands:[{groups:[{photos:bundles.map(bundle=>({assetSha256:bundle.imageShas[0]}))}]}],assetManifest:{version:1,bundles:bundles.map(({raw,image,...bundle})=>bundle)}};
 return {bundles,data};
}
function harness(options={}){
 const db=database(options),logs=[];
 const context={module:{exports:{}},indexedDB:db.indexedDB,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,URL,AbortController,setTimeout,clearTimeout,Date,navigator:{onLine:true},console:{info(...args){logs.push(args);},warn(...args){logs.push(args);}}};
 vm.createContext(context);vm.runInContext(read('brand-guide-assets.js'),context);
 return {db,context,assets:context.module.exports,logs};
}
async function seed(h,fixture){for(const bundle of fixture.bundles)await h.assets.saveBundle(bundle.raw,bundle);}

for(const damage of ['missing','wrong-record-sha','wrong-content','invalid-image'])test(`${damage} is repaired by fetching only its affected bundle`,async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);
 const bundle=fixture.bundles[1],sha=bundle.imageShas[0],images=h.db.stores.get('images');
 if(damage==='missing')images.delete(sha);
 else{const row={...images.get(sha)};if(damage==='wrong-record-sha')row.sha256='f'.repeat(64);else row.image=damage==='invalid-image'?'not-an-image':fixture.bundles[0].image;images.set(sha,row);}
 const requests=[];
 const result=await h.assets.prepare(fixture.data,async bundle=>{requests.push(bundle.sha256);return fixture.bundles.find(item=>item.sha256===bundle.sha256).raw;});
 assert.deepEqual(requests,[bundle.sha256]);assert.equal(result.fetchedBundles,1);
 assert.equal(await h.assets.imageURI({assetSha256:sha}),bundle.image);
});
test('healthy photos survive a check without requests or new writes',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const writes=h.db.commits;
 const result=await h.assets.prepare(fixture.data,()=>assert.fail('healthy images must be reused'));
 assert.equal(result.fetchedBundles,0);assert.equal(h.db.commits,writes);
});
test('integrity scanning opens one snapshot per bundle instead of one database per image',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const before=h.db.opens;
 await h.assets.prepare(fixture.data,()=>assert.fail('unexpected network'));
 assert.equal(h.db.opens-before,fixture.bundles.length);
});
test('photos lost immediately after a commit stop before later batches or metadata activation',async()=>{
 const h=harness({afterCommit(stores,names){if(names.includes('images'))stores.get('images').clear();}}),fixture=fixtures(7),requests=[];
 const old={sha:'previous-release'};h.db.stores.get('library').set('active',old);
 await assert.rejects(h.assets.prepare(fixture.data,async bundle=>{requests.push(bundle.sha256);return fixture.bundles.find(item=>item.sha256===bundle.sha256).raw;}),error=>error.code==='PHOTO_STORAGE_LOST');
 assert.equal(requests.length,1);assert.equal(h.db.stores.get('library').get('active'),old);
});
test('quota failure is actionable and does not continue downloading or replace the library',async()=>{
 const h=harness({quota:true}),fixture=fixtures(7),requests=[];h.db.stores.get('library').set('active',{sha:'old'});
 await assert.rejects(h.assets.prepare(fixture.data,async bundle=>{requests.push(bundle.sha256);return fixture.bundles.find(item=>item.sha256===bundle.sha256).raw;}),error=>error.code==='PHOTO_STORAGE_FULL'&&/空き容量/.test(error.message));
 assert.equal(requests.length,1);assert.equal(h.db.stores.get('library').get('active').sha,'old');
});
test('missing and corrupt image errors have distinct non-sensitive diagnoses',async()=>{
 const h=harness(),fixture=fixtures(1),sha=fixture.bundles[0].imageShas[0];
 await assert.rejects(h.assets.imageURI({assetSha256:sha}),error=>error.code==='PHOTO_MISSING'&&!error.message.includes(sha));
 await seed(h,fixture);h.db.stores.get('images').get(sha).image='not-an-image';
 await assert.rejects(h.assets.imageURI({assetSha256:sha}),error=>error.code==='PHOTO_CORRUPT'&&!error.message.includes(sha));
});
function syncHarness(h,fixture,{missing=true,fail=false}={}){
 const raw='{}',manifest={schemaVersion:2,revision:123,transport:'assets-v2',sha256:hash(raw),updatedAt:fixture.data.updatedAt,bytes:raw.length};
 const record={schemaVersion:2,sha:manifest.sha256,remoteRevision:manifest.revision,data:fixture.data};
 const requests=[],statuses=[];let imports=0;
 h.context.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  if(body.action==='getBrandGuideManifest')return Response.json({success:true,data:manifest});
  assert.equal(body.sha256,manifest.sha256);assert.equal(body.revision,manifest.revision);
  assert.equal(body.transport,'assets-v2');assert.ok(body.assetBundleSha,'matching index must not be downloaded again');
  const bundle=fixture.bundles.find(item=>item.sha256===body.assetBundleSha);
  return new Response(bundle.raw,{headers:{'content-type':'application/json'}});
 };
 vm.runInContext(read('brand-guide-sync.js')+'\nthis.sync=BrandGuideSync;',h.context);h.context.sync.configurePublicRead();
 if(missing)h.db.stores.get('images').delete(fixture.bundles[0].imageShas[0]);
 return {requests,statuses,get imports(){return imports;},run:()=>h.context.sync.run({force:true,onStatus:value=>statuses.push(value),guide:{MAX_BYTES:10000,load:async()=>record,prepareAssets:fail?async()=>{throw Object.assign(new Error('端末の空き容量が足りません。'),{code:'PHOTO_STORAGE_FULL'});}:h.assets.prepare,importFile:async()=>{imports++;}}})};
}
test('a matching active index still repairs a missing photo through the pinned read-only transport',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const sync=syncHarness(h,fixture);
 const result=await sync.run();assert.equal(result.status,'current');assert.equal(result.repaired,true);
 assert.equal(sync.requests.length,2);assert.equal(sync.imports,0);
 assert.equal(await h.assets.imageURI({assetSha256:fixture.bundles[0].imageShas[0]}),fixture.bundles[0].image);
});
test('matching healthy index verifies photos and makes only the manifest request',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const sync=syncHarness(h,fixture,{missing:false});
 const result=await sync.run();assert.equal(result.status,'current');assert.equal(result.repaired,false);assert.equal(sync.requests.length,1);
});
test('a failed current-photo repair never reports current and is not retried as a network failure',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const sync=syncHarness(h,fixture,{fail:true});
 const result=await sync.run();assert.equal(result.status,'failed');assert.equal(result.code,'PHOTO_STORAGE_FULL');assert.equal(result.retryable,false);
 assert.equal(sync.requests.length,1);assert.equal(sync.imports,0);assert.match(sync.statuses.at(-1),/空き容量/);
});
test('a damaged replacement bundle is rejected before any cached photo or metadata is changed',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);const sha=fixture.bundles[0].imageShas[0];
 const damaged={sha256:sha,image:fixture.bundles[1].image};h.db.stores.get('images').set(sha,damaged);
 const old={sha:'old'};h.db.stores.get('library').set('active',old);
 await assert.rejects(h.assets.prepare(fixture.data,async bundle=>fixture.bundles.find(item=>item.sha256===bundle.sha256).raw+' '));
 assert.equal(h.db.stores.get('images').get(sha),damaged);assert.equal(h.db.stores.get('library').get('active'),old);
});
test('audit diagnostics contain counts without image hashes or source content',async()=>{
 const h=harness(),fixture=fixtures();await seed(h,fixture);
 await h.assets.prepare(fixture.data,()=>assert.fail('unexpected request'));
 const output=JSON.stringify(h.logs);assert.match(output,/checkedBundles/);
 for(const bundle of fixture.bundles){assert.ok(!output.includes(bundle.sha256));assert.ok(!output.includes(bundle.imageShas[0]));assert.ok(!output.includes(bundle.image));}
});
test('a previously failed visible photo reappears after repair without reopening the page',async()=>{
 let available=false;const image={alt:'ブランドタグ',isConnected:true,src:''};
 const context={module:{exports:{}},BrandGuideAssets:{imageURI:async()=>{if(!available)throw new Error('missing');return 'data:image/jpeg;base64,/9j/2Q==';}},document:{querySelectorAll:()=>[image]}};
 vm.runInNewContext(read('brand-guide.js'),context);const guide=context.module.exports;
 guide.setImage(image,{assetSha256:'a'.repeat(64)});await new Promise(resolve=>setImmediate(resolve));
 assert.match(image.alt,/写真を表示できません/);assert.equal(image.src,'');
 available=true;guide.refreshFailedPhotos();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(image.alt,'ブランドタグ');assert.equal(image.src,'data:image/jpeg;base64,/9j/2Q==');
});
test('an obsolete photo request cannot overwrite a newer image on the same element',async()=>{
 let finish;const image={alt:'商品',isConnected:true,src:''};
 const context={module:{exports:{}},BrandGuideAssets:{imageURI:()=>new Promise(resolve=>{finish=resolve;})}};
 vm.runInNewContext(read('brand-guide.js'),context);const guide=context.module.exports;
 guide.setImage(image,{assetSha256:'a'.repeat(64)});guide.setImage(image,{image:'new-photo'});finish('old-photo');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(image.src,'new-photo');
});
