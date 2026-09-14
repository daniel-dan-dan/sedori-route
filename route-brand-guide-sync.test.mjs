import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const src=readFileSync(new URL('brand-guide-sync.js',import.meta.url),'utf8');
const manifest={schemaVersion:1,revision:10,sha256:'a'.repeat(64),updatedAt:'2026-09-13',bytes:2};
function client({old=null,online=true,token='t'.repeat(40),bad=false,m=manifest}={}) {
 const calls=[],statuses=[];let imports=0;
 const context={navigator:{onLine:online},TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,Date,
 indexedDB:{open(){const r={};queueMicrotask(()=>{const tx={objectStore:()=>({get(){const v={result:{value:token}};setTimeout(()=>tx.oncomplete(),0);return v;}})};r.result={close(){},transaction:()=>tx};r.onsuccess();});return r;}},
 fetch:async(url,opt)=>{const body=JSON.parse(opt.body);calls.push(body.action);assert.equal(opt.cache,'no-store');assert.equal(opt.credentials,'omit');if(bad)throw new Error('offline');return new Response(JSON.stringify(body.action==='getBrandGuideManifest'?{success:true,data:m}:{}),{headers:{'content-type':'application/json'}});}};
 vm.createContext(context);vm.runInContext(src+'\nthis.sync=BrandGuideSync;',context);
 const run=()=>context.sync.run({guide:{MAX_BYTES:10000,load:async()=>old,importFile:async(f,expected)=>{imports++;assert.equal(expected.sha256,m.sha256);return {}; }},onStatus:x=>statuses.push(x)});
 return {run,calls,statuses,get imports(){return imports;},sync:context.sync};
}
test('first open automatically fetches manifest and package',async()=>{const h=client();await h.run();assert.deepEqual(h.calls,['getBrandGuideManifest','getBrandGuidePackage']);assert.equal(h.imports,1);});
test('same content is not downloaded again',async()=>{const h=client({old:{sha:manifest.sha256}});await h.run();assert.deepEqual(h.calls,['getBrandGuideManifest']);assert.equal(h.imports,0);});
test('offline makes no requests and preserves data',async()=>{const h=client({online:false});await h.run();assert.equal(h.calls.length,0);assert.equal(h.imports,0);});
test('missing credential never requests private data',async()=>{const h=client({token:''});await h.run();assert.equal(h.calls.length,0);});
test('failed network never saves',async()=>{const h=client({bad:true});await h.run();assert.equal(h.imports,0);assert.match(h.statuses.at(-1),/変更していません/);});
test('older revision never replaces saved data',async()=>{const h=client({old:{sha:'b'.repeat(64),remoteRevision:11,data:{updatedAt:'2026-09-13'}}});await h.run();assert.equal(h.imports,0);assert.equal(h.calls.length,1);});
test('concurrent refresh is deduplicated',async()=>{const h=client();await Promise.all([h.run(),h.run()]);assert.equal(h.imports,1);});
test('interval suppresses extra checks',async()=>{const h=client();await h.run();await h.run();assert.equal(h.calls.length,2);});
test('truncated package never saves',async()=>{const h=client({m:{...manifest,bytes:999}});await h.run();assert.equal(h.imports,0);});
test('invalid date and oversized manifest rejected',()=>{const h=client();for(const m of [{...manifest,updatedAt:'2026-02-30'},{...manifest,bytes:50*1024*1024}])assert.throws(()=>h.sync.validateManifest(m));});
