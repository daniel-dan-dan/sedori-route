import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const src=readFileSync(new URL('brand-guide-sync.js',import.meta.url),'utf8');
const manifest={schemaVersion:1,revision:10,sha256:'a'.repeat(64),updatedAt:'2026-09-13',bytes:2};
function client({old=null,online=true,token='t'.repeat(40),bad=false,m=manifest,error=null,transientError=null}={}) {
 const calls=[],statuses=[],logs=[];let imports=0;
 const context={navigator:{onLine:online},TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,Date,console:{warn(...args){logs.push(args);}},
 indexedDB:{open(){const r={};queueMicrotask(()=>{const tx={objectStore:()=>({get(){const v={result:{value:token}};setTimeout(()=>tx.oncomplete(),0);return v;}})};r.result={close(){},transaction:()=>tx};r.onsuccess();});return r;}},
 fetch:async(url,opt)=>{const body=JSON.parse(opt.body);calls.push(body.action);assert.equal(opt.cache,'no-store');assert.equal(opt.credentials,'omit');if(bad)throw new Error('offline');if(transientError && calls.length===1)return new Response(JSON.stringify({success:false,error:transientError}),{headers:{'content-type':'application/json'}});if(error)return new Response(JSON.stringify({success:false,error}),{headers:{'content-type':'application/json'}});return new Response(JSON.stringify(body.action==='getBrandGuideManifest'?{success:true,data:m}:{}),{headers:{'content-type':'application/json'}});}};
 vm.createContext(context);vm.runInContext(src+'\nthis.sync=BrandGuideSync;',context);
 const run=(options={})=>context.sync.run({guide:{MAX_BYTES:10000,load:async()=>old,importFile:async(f,expected)=>{imports++;assert.equal(expected.sha256,m.sha256);return {}; }},onStatus:x=>statuses.push(x),...options});
 return {run,calls,statuses,logs,get imports(){return imports;},sync:context.sync};
}
test('first open automatically fetches manifest and package',async()=>{const h=client();await h.run();assert.deepEqual(h.calls,['getBrandGuideManifest','getBrandGuidePackage']);assert.equal(h.imports,1);});
test('same content is not downloaded again',async()=>{const h=client({old:{sha:manifest.sha256}});await h.run();assert.deepEqual(h.calls,['getBrandGuideManifest']);assert.equal(h.imports,0);});
test('current result returns the saved record so a stale view can reconcile without downloading again',async()=>{
 const old={sha:manifest.sha256,data:{updatedAt:manifest.updatedAt}};const h=client({old});const result=await h.run();
 assert.equal(result.status,'current');assert.equal(result.record,old);assert.deepEqual(h.calls,['getBrandGuideManifest']);assert.equal(h.imports,0);
});
test('deduplicated update returns the new record to every waiting view',async()=>{
 const h=client();const [first,second]=await Promise.all([h.run(),h.run()]);
 assert.equal(first.status,'saved');assert.ok(first.record);assert.equal(first.record,second.record);assert.equal(h.imports,1);
});
test('offline makes no requests and preserves data',async()=>{const h=client({online:false});await h.run();assert.equal(h.calls.length,0);assert.equal(h.imports,0);});
test('missing credential never requests private data',async()=>{const h=client({token:''});await h.run();assert.equal(h.calls.length,0);});
test('failed network never saves',async()=>{const h=client({bad:true});await h.run();assert.equal(h.imports,0);assert.match(h.statuses.at(-1),/変更していません/);});
test('older revision never replaces saved data',async()=>{const h=client({old:{sha:'b'.repeat(64),remoteRevision:11,data:{updatedAt:'2026-09-13'}}});await h.run();assert.equal(h.imports,0);assert.equal(h.calls.length,1);});
test('concurrent refresh is deduplicated',async()=>{const h=client();await Promise.all([h.run(),h.run()]);assert.equal(h.imports,1);});
test('interval suppresses extra checks',async()=>{const h=client();await h.run();await h.run();assert.equal(h.calls.length,2);});
test('truncated package never saves',async()=>{const h=client({m:{...manifest,bytes:999}});await h.run();assert.equal(h.imports,0);});
test('invalid date and oversized manifest rejected',()=>{const h=client();for(const m of [{...manifest,updatedAt:'2026-02-30'},{...manifest,bytes:50*1024*1024}])assert.throws(()=>h.sync.validateManifest(m));});

test('missing connection returns an actionable state and does not suppress connection retry',async()=>{
 const h=client({token:''});assert.equal((await h.run()).status,'auth-required');
 h.sync.configureCredential(async()=> 'g'.repeat(40));assert.equal((await h.run()).status,'saved');
 assert.equal(h.imports,1);
});
test('forced refresh bypasses the 15-minute interval after reconnecting',async()=>{
 const h=client();await h.run();await h.run({force:true});assert.equal(h.imports,2);
});
test('expired credential returns connection state instead of a generic update error',async()=>{
 const h=client({error:'UNAUTHORIZED: rejected'});assert.equal((await h.run()).status,'auth-required');assert.equal(h.imports,0);
});
test('distribution failure is distinct from missing credentials and never replaces saved data',async()=>{
 const h=client({error:'BRAND_GUIDE_UNAVAILABLE'});const result=await h.run();assert.equal(result.status,'failed');assert.equal(result.code,'RELEASE_UNAVAILABLE');assert.match(h.statuses.at(-1),/配信元/);assert.equal(h.imports,0);
});
test('transport diagnostics identify failures without exposing credentials or URLs',async()=>{
 const token='private-device-token-123456789012345678901234567890';
 const h=client({token,error:`Service failure: ${token} https://example.org/private?key=abc ${'s'.repeat(64)}`});
 await h.run();const output=JSON.stringify(h.logs);
 assert.match(output,/getBrandGuideManifest/);assert.match(output,/Service failure/);
 assert.ok(!output.includes(token));assert.ok(!output.includes('https://'));assert.ok(!output.includes('s'.repeat(64)));
 assert.equal(h.imports,0);
});

test('redirect GET rejection retries authenticated read once and succeeds',async()=>{
 const h=client({transientError:'GET_DISABLED: POST required'});assert.equal((await h.run()).status,'saved');assert.equal(h.imports,1);assert.deepEqual(h.calls,['getBrandGuideManifest','getBrandGuideManifest','getBrandGuidePackage']);assert.deepEqual(h.logs,[['[brand-guide] retry read','getBrandGuideManifest','GET_DISABLED']]);
});
test('persistent redirect rejection stops at two attempts and preserves saved data',async()=>{
 const h=client({error:'GET_DISABLED: POST required'});assert.equal((await h.run()).status,'failed');assert.equal(h.imports,0);assert.deepEqual(h.calls,['getBrandGuideManifest','getBrandGuideManifest']);
});
test('authentication rejection is not retried',async()=>{
 const h=client({error:'UNAUTHORIZED: rejected'});assert.equal((await h.run()).status,'auth-required');assert.deepEqual(h.calls,['getBrandGuideManifest']);
});
