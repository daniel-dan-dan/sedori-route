import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
const source=readFileSync(new URL('brand-guide-sync.js',import.meta.url),'utf8');
const assetSource=readFileSync(new URL('brand-guide-assets.js',import.meta.url),'utf8');
const manifest={schemaVersion:1,revision:10,sha256:'a'.repeat(64),updatedAt:'2026-10-23',bytes:2};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function clock(){let now=1000000,id=0;const timers=new Map();return {Date:class extends Date{static now(){return now;}},get now(){return now;},get timers(){return timers;},setTimeout(fn,ms){timers.set(++id,{fn,at:now+ms});return id;},clearTimeout(key){timers.delete(key);},async advance(ms){const target=now+ms;await flush();for(;;){const first=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;timers.delete(first[0]);now=first[1].at;first[1].fn();await flush();}now=target;await flush();}};}
function harness(fetchResponse,{guide:extra={},m=manifest}={}){
 const time=clock(),calls=[],logs=[];let imports=0,saved=null;
 const context={URL,navigator:{onLine:true},TextEncoder,TextDecoder,Uint8Array,AbortController,Date:time.Date,setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,console:{warn(...args){logs.push(args);}},fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push({body,url,options});return fetchResponse?fetchResponse({body,url,options,index:calls.length}):Response.json(body.action==='getBrandGuideManifest'?{success:true,data:m}:{});}};
 vm.runInNewContext(source+'\nthis.sync=BrandGuideSync;',context);context.sync.configureCredential(async()=> 't'.repeat(40));
 const guide={MAX_BYTES:10000,load:async()=>saved,importFile:async()=>{imports++;saved={sha:m.sha256,data:{updatedAt:m.updatedAt}};return saved;},...extra};
 return {time,calls,logs,context,guide,get imports(){return imports;},run:(options={})=>context.sync.run({guide,...options})};
}
const rejection=()=>Response.json({success:false,error:'GET_DISABLED: POST required'});
async function failed(h,options){const promise=h.run(options);await h.time.advance(1000);return promise;}

test('redirect failures wait once, then recover at their absolute retry time without the 15-minute block',async()=>{
 let healthy=false;const h=harness(({body})=>healthy?Response.json(body.action==='getBrandGuideManifest'?{success:true,data:manifest}:{}):rejection());
 const first=h.run();await flush();assert.equal(h.calls.length,1);await h.time.advance(999);assert.equal(h.calls.length,1);await h.time.advance(1);
 const result=await first;assert.equal(result.code,'CONTENT_REDIRECT_FAILED');assert.equal(result.retryable,true);assert.equal(result.retryAt,h.time.now+3000);
 const early=await h.run();assert.equal(early.status,'retry-pending');assert.equal(early.retryAt,result.retryAt);assert.equal(h.calls.length,2);
 healthy=true;await h.time.advance(3000);const recovered=await h.run();assert.equal(recovered.status,'saved');assert.equal(h.imports,1);assert.ok(h.time.now<1000000+15*60*1000);
 assert.equal(h.calls.every(call=>call.options.method==='POST'&&call.body.auth_token==='t'.repeat(40)),true);assert.equal(new Set(h.calls.map(c=>c.url)).size,h.calls.length);
});
test('three scheduled recoveries stop at their budget; explicit force starts a fresh cycle',async()=>{
 const h=harness(()=>rejection());let result=await failed(h);
 for(const delay of [3000,10000,30000]){assert.equal(result.retryAt-h.time.now,delay);await h.time.advance(delay);result=await failed(h);}
 assert.equal(result.retryable,false);assert.equal(result.retryAt,undefined);const stoppedAt=h.calls.length;assert.equal(stoppedAt,8);
 assert.equal(await h.run(),undefined);assert.equal(h.calls.length,stoppedAt);
 result=await failed(h,{force:true});assert.equal(result.retryAt-h.time.now,3000);assert.equal(h.calls.length,stoppedAt+2);
});
test('successful current and saved results reset the recovery backoff',async()=>{
 let healthy=false;const h=harness(({body})=>healthy?Response.json(body.action==='getBrandGuideManifest'?{success:true,data:manifest}:{}):rejection());
 let result=await failed(h);await h.time.advance(3000);result=await failed(h);assert.equal(result.retryAt-h.time.now,10000);
 healthy=true;await h.time.advance(10000);assert.equal((await h.run()).status,'saved');
 assert.equal((await h.run({force:true})).status,'current');healthy=false;await h.time.advance(15*60*1000);
 result=await failed(h);assert.equal(result.retryAt-h.time.now,3000);
});
for(const [name,response]of [['404',()=>new Response('',{status:404})],['429',()=>new Response('',{status:429})],['503',()=>new Response('',{status:503})],['network',()=>{throw new TypeError('network');}]])test(`${name} read failure has bounded request and recovery retries`,async()=>{
 const h=harness(response),result=await failed(h);assert.equal(h.calls.length,2);assert.equal(result.retryable,true);assert.equal(result.retryAt-h.time.now,3000);assert.equal(h.imports,0);
});
for(const [name,response]of [['authentication',()=>Response.json({success:false,error:'UNAUTHORIZED: denied'})],['invalid JSON',()=>new Response('{',{headers:{'content-type':'application/json'}})],['invalid manifest',()=>Response.json({success:true,data:{...manifest,bytes:0}})],['HTML',()=>new Response('<html>bad</html>',{headers:{'content-type':'text/html'}})],['403',()=>new Response('',{status:403})],['oversized response',()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'100000'}})]])test(`${name} is not automatically retried`,async()=>{
 const h=harness(response),result=await h.run();assert.equal(result.retryable,false);assert.equal(result.retryAt,undefined);assert.equal(h.calls.length,1);assert.equal(h.imports,0);
});
for(const name of ['TypeError','AbortError'])test(`${name} from saving never becomes a transport retry`,async()=>{
 const h=harness(null,{guide:{importFile:async()=>{const e=new Error('local save failed');e.name=name;throw e;}}});
 const result=await h.run();assert.equal(result.retryable,false);assert.equal(result.retryAt,undefined);assert.equal(h.calls.length,2);
});
test('the original response-body deadline remains active and prevents a second request after expiry',async()=>{
 let signal;const h=harness(({options})=>{signal=options.signal;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"success":'));signal.addEventListener('abort',()=>controller.error(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});}}),{headers:{'content-type':'application/json'}});});
 const pending=h.run();await flush();await h.time.advance(60000);const result=await pending;
 assert.equal(signal.aborted,true);assert.equal(result.code,'READ_TIMEOUT');assert.equal(result.retryable,true);assert.equal(h.calls.length,1);assert.equal(h.time.timers.size,0);
});
test('a slow first rejection and retry wait share the original 60-second deadline',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));const pending=h.run();await flush();await h.time.advance(59500);resolve(rejection());await flush();await h.time.advance(500);
 const result=await pending;assert.equal(result.code,'READ_TIMEOUT');assert.equal(h.calls.length,1);assert.equal(h.time.timers.size,0);
});
test('concurrent force keeps one in-flight read and one recovery cycle',async()=>{
 const h=harness(()=>rejection()),first=h.run(),second=h.run({force:true});assert.equal(first,second);await h.time.advance(1000);const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(a.retryAt-h.time.now,3000);assert.equal(h.calls.length,2);
 h.context.navigator.onLine=false;await h.time.advance(3000);assert.equal(await h.run(),undefined);assert.equal(h.calls.length,2);
 h.context.navigator.onLine=true;const recovery=await failed(h);assert.equal(recovery.retryAt-h.time.now,10000);
});
test('redirect diagnostics contain only a boolean and destination class, never a full route or secret',async()=>{
 const secret='private-location-secret-12345678901234567890';
 const h=harness(()=>{const r=rejection();Object.defineProperties(r,{url:{value:'https://script.googleusercontent.com/macros/echo?user_content_key='+secret},redirected:{value:true}});return r;});await failed(h);
 const output=JSON.stringify(h.logs);assert.ok(!output.includes(secret));assert.ok(!output.includes('https://'));assert.ok(!output.includes('t'.repeat(40)));
 assert.equal(h.logs[0].at(-1).redirected,true);assert.equal(h.logs[0].at(-1).destination,'google-content');
});

function assetDatabase(){const stores=new Map(['images','bundles','library'].map(name=>[name,new Map()]));return {stores,indexedDB:{open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(names,mode){const draft=new Map([...stores].map(([n,values])=>[n,new Map(values)]));let queued=0,finished=false;const tx={abort(){finished=true;queueMicrotask(()=>tx.onabort?.());}};function operation(action){queued++;const r={};queueMicrotask(()=>{if(finished)return;action(r);r.onsuccess?.({target:r});queued--;queueMicrotask(()=>{if(!finished&&queued===0){finished=true;if(mode==='readwrite')for(const [n,values]of draft)stores.set(n,values);tx.oncomplete?.();}});});return r;}tx.objectStore=name=>({get:key=>operation(r=>r.result=draft.get(name).get(key)),put:(value,key)=>operation(()=>draft.get(name).set(key,structuredClone(value)))});return tx;}};request.onsuccess?.();});return request;}}};}
const hash=value=>createHash('sha256').update(value).digest('hex');
test('assets-v2 recovery reuses successful bundles and never installs incomplete metadata',async()=>{
 const db=assetDatabase(),assetContext={module:{exports:{}},indexedDB:db.indexedDB,crypto:webcrypto,TextEncoder,Uint8Array,atob,setTimeout,clearTimeout};vm.runInNewContext(assetSource,assetContext);const assets=assetContext.module.exports;
 const bundles=Array.from({length:4},(_,i)=>{const bytes=Buffer.from([255,216,255,217,i]),sha256=hash(bytes),image='data:image/jpeg;base64,'+bytes.toString('base64'),raw=JSON.stringify({format:'private-brand-guide-assets',schemaVersion:1,images:[{sha256,image}]});return {raw,sha256:hash(raw),bytes:Buffer.byteLength(raw),imageShas:[sha256]};});
 const indexData={brands:[{groups:[{photos:bundles.map(b=>({assetSha256:b.imageShas[0]}))}]}],assetManifest:{version:1,bundles:bundles.map(({raw,...b})=>b)},updatedAt:manifest.updatedAt};
 const raw='{}',m={...manifest,schemaVersion:2,transport:'assets-v2',bytes:Buffer.byteLength(raw)};let failing=true,imports=0;
 const h=harness(({body})=>{if(body.action==='getBrandGuideManifest')return Response.json({success:true,data:m});if(!body.assetBundleSha)return Response.json({});const bundle=bundles.find(b=>b.sha256===body.assetBundleSha);return failing&&bundle===bundles[1]?rejection():new Response(bundle.raw,{headers:{'content-type':'application/json'}});},{m,guide:{parsePackage:async()=>({schemaVersion:2,sha:m.sha256,data:indexData}),prepareAssets:(...args)=>assets.prepare(...args),importFile:async()=>{imports++;return {sha:m.sha256,data:indexData};}}});
 const first=h.run();for(let i=0;i<100&&!h.calls.some(c=>c.body.assetBundleSha===bundles[1].sha256);i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(h.calls.some(c=>c.body.assetBundleSha===bundles[1].sha256));await h.time.advance(1000);const failedResult=await first;assert.equal(failedResult.retryable,true);assert.equal(imports,0);
 assert.equal(db.stores.get('bundles').has(bundles[0].sha256),true);assert.equal(db.stores.get('bundles').has(bundles[2].sha256),true);assert.equal(db.stores.get('bundles').has(bundles[3].sha256),false);
 failing=false;await h.time.advance(3000);assert.equal((await h.run()).status,'saved');assert.equal(imports,1);
 const requests=sha=>h.calls.filter(c=>c.body.assetBundleSha===sha).length;assert.equal(requests(bundles[0].sha256),1);assert.equal(requests(bundles[2].sha256),1);assert.equal(requests(bundles[1].sha256),3);assert.equal(requests(bundles[3].sha256),1);
});
