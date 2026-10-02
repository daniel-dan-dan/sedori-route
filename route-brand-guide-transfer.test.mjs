import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('brand-guide-sync.js',import.meta.url),'utf8');
const chunkCharacters=4*1024*1024;
const raw=JSON.stringify({text:'a'.repeat(chunkCharacters*6-12)+'日本語😀'});
const manifest={schemaVersion:1,revision:123,sha256:createHash('sha256').update(raw).digest('hex'),updatedAt:'2026-10-02',bytes:Buffer.byteLength(raw),transport:'chunks-v1',characters:raw.length,chunkCharacters};
function harness({change=null,failIndex=-1,legacy=false,failOnce=false,always404=false}={}) {
 const offsets=[],statuses=[],logs=[],urls=[];let saved=0,active=0,maxActive=0;
 const context={navigator:{onLine:true},TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,Date,console:{warn(...args){logs.push(args);}},
 fetch:async(_url,opt)=>{
  urls.push(_url);assert.ok(!_url.includes('t'.repeat(40)));assert.match(_url,/\?read_request=[a-z0-9]+-[a-z0-9]+$/);
  const body=JSON.parse(opt.body);
  if(body.action==='getBrandGuideManifest')return Response.json({success:true,data:legacy?{...manifest,transport:undefined}:manifest});
  assert.equal(body.sha256,manifest.sha256);
  if(legacy)return new Response('server error',{status:500});
  assert.equal(body.transport,'chunks-v1');assert.equal(body.revision,manifest.revision);
  const index=body.offset/chunkCharacters;offsets.push(index);active++;maxActive=Math.max(maxActive,active);
  await new Promise(resolve=>setTimeout(resolve,index%2?3:1));active--;
  if(always404 || (failOnce && offsets.length===1))return new Response('temporary redirect failure',{status:404});
  if(index===failIndex)return new Response('server error',{status:500});
  const content=raw.slice(body.offset,body.offset+chunkCharacters);
  const part={format:'private-brand-guide-chunk',schemaVersion:1,sha256:manifest.sha256,revision:manifest.revision,bytes:manifest.bytes,characters:raw.length,offset:body.offset,nextOffset:body.offset+content.length,content};
  change?.(part,index);
  return Response.json({success:true,data:part});
 }};
 vm.createContext(context);vm.runInContext(source+'\nthis.sync=BrandGuideSync;',context);
 context.sync.configureCredential(async()=> 't'.repeat(40));
 return {offsets,statuses,logs,urls,get saved(){return saved;},get maxActive(){return maxActive;},get active(){return active;},run:()=>context.sync.run({guide:{MAX_BYTES:40*1024*1024,load:async()=>null,importFile:async file=>{const received=await file.text();assert.equal(received,raw);assert.equal(createHash('sha256').update(received).digest('hex'),manifest.sha256);assert.deepEqual(JSON.parse(received),JSON.parse(raw));saved++;return {}; }},onStatus:x=>statuses.push(x)})};
}
test('large unicode package reconstructs exactly with bounded concurrency before one atomic save',async()=>{
 const h=harness();assert.equal((await h.run()).status,'saved');assert.equal(h.saved,1);assert.equal(h.maxActive,3);assert.equal(h.active,0);assert.deepEqual([...h.offsets].sort((a,b)=>a-b),[0,1,2,3,4,5,6]);
});
test('part failure drains the active batch, starts no later batch, and preserves the old library',async()=>{
 const h=harness({failIndex:1});assert.equal((await h.run()).status,'failed');assert.equal(h.saved,0);assert.deepEqual([...h.offsets].sort((a,b)=>a-b),[0,1,2,3]);assert.equal(h.active,0);assert.match(h.statuses.at(-1),/変更していません/);
});
test('revision switch during transfer never saves mixed releases',async()=>{
 const h=harness({change(part,index){if(index===2)part.revision++;}});assert.equal((await h.run()).status,'failed');assert.equal(h.saved,0);
});
test('wrong offset, truncated part and mismatched identity are rejected before the next batch',async()=>{
 for(const change of [p=>p.offset++,p=>p.content=p.content.slice(1),p=>p.sha256='b'.repeat(64),p=>p.characters++,p=>p.nextOffset++,p=>p.bytes++]) {
  const h=harness({change});assert.equal((await h.run()).status,'failed');assert.equal(h.saved,0);assert.deepEqual(h.offsets,[0]);
 }
});
test('legacy large response failure is diagnosed without sensitive content',async()=>{
 const h=harness({legacy:true});assert.equal((await h.run()).status,'failed');assert.equal(h.saved,0);assert.deepEqual(h.logs,[['[brand-guide] HTTP failure','getBrandGuidePackage',500,'']]);
});
test('temporary 404 read is retried once with a fresh public request discriminator',async()=>{
 const h=harness({failOnce:true});assert.equal((await h.run()).status,'saved');assert.equal(h.saved,1);assert.equal(h.offsets.filter(i=>i===0).length,2);assert.equal(new Set(h.urls).size,h.urls.length);assert.deepEqual(h.logs,[['[brand-guide] retry read','getBrandGuidePackage',404]]);
});
test('persistent 404 stops after one retry without saving or requesting later parts',async()=>{
 const h=harness({always404:true});assert.equal((await h.run()).status,'failed');assert.equal(h.saved,0);assert.deepEqual(h.offsets,[0,0]);
});
