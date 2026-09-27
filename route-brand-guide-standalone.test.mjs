import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
function harness({legacy='',own='',failRequest=false}={}) {
 const stores=new Map([['brand-guide-credentials',new Map(own ? [['guide-device-token-v1',{value:own}]] : [])],['sedori-route-credentials',new Map(legacy ? [['daniel_route_device_auth_v1',{value:legacy}]] : [])]]);
 const writes=[],requests=[];
 const indexedDB={open(name){ const request={};queueMicrotask(()=>{
   if(!stores.has(name)) {stores.set(name,new Map());request.transaction={abort(){queueMicrotask(()=>request.onerror?.());}};request.onupgradeneeded?.();}
   request.result={close(){},createObjectStore(){},transaction(store,mode){let timer;const tx={objectStore(){return {get(key){const r={result:stores.get(name)?.get(key)};clearTimeout(timer);timer=setTimeout(()=>tx.oncomplete?.(),0);return r;},put(row){stores.get(name).set(row.key,row);writes.push({name,key:row.key});clearTimeout(timer);timer=setTimeout(()=>tx.oncomplete?.(),0);return {};}};}};return tx;}};request.onsuccess?.();
 });return request;}};
 const context={indexedDB,crypto:webcrypto,btoa,Uint8Array,TextDecoder,AbortController,setTimeout,clearTimeout,Date,
 fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');if(failRequest && requests.length===1)throw new Error('network');return new Response(JSON.stringify({success:true,data:{registered:true,device_id:body.device_id}}),{headers:{'content-type':'application/json'}});}};
 vm.createContext(context);vm.runInContext(read('brand-guide/credentials.js')+'\nthis.guide=GuideCredentials;',context);
 return {guide:context.guide,stores,writes,requests};
}
test('existing library remains in the same private DB; separate app never loads route business scripts',()=>{
 const html=read('brand-guide/index.html'),manifest=JSON.parse(read('brand-guide/manifest.json'));
 assert.equal(manifest.scope,'./');assert.equal(manifest.start_url,'./');assert.equal(manifest.name,'ブランド図鑑');
 assert.match(html,/manifest.json/);assert.doesNotMatch(html,/src="(?:\.\.\/)?(?:api|storage|pair|quiz)\.js/);
 assert.match(read('brand-guide.js'),/sedori-private-brand-guide/);
 assert.match(read('brand-guide/sw.js'),/CACHE_PREFIX = 'brand-guide-'/);
 assert.doesNotMatch(read('brand-guide/sw.js'),/sedori-route-/);
});
test('credential is inherited once and never changes the store app database',async()=>{
 const h=harness({legacy:'r'.repeat(40)});assert.equal(await h.guide.get(),'r'.repeat(40));
 h.stores.get('sedori-route-credentials').clear();assert.equal(await h.guide.get(),'r'.repeat(40));
 assert.equal(h.writes.filter(x=>x.name==='sedori-route-credentials').length,0);
});
test('own credential wins over a different old credential',async()=>{
 const h=harness({legacy:'r'.repeat(40),own:'g'.repeat(40)});assert.equal(await h.guide.get(),'g'.repeat(40));assert.equal(h.writes.length,0);
});
test('an unpaired browser does not request remote data',async()=>{
 const h=harness();assert.equal(await h.guide.get(),'');assert.equal(h.requests.length,0);
});
test('registration failure keeps the old credential; retry uses the exact pending identity',async()=>{
 const h=harness({own:'g'.repeat(40),failRequest:true});await assert.rejects(h.guide.connect('p'.repeat(40)));
 assert.equal(await h.guide.get(),'g'.repeat(40));await h.guide.connect('p'.repeat(40));
 assert.equal(h.requests[0].device_id,h.requests[1].device_id);assert.equal(h.requests[0].device_token,h.requests[1].device_token);
 assert.equal(await h.guide.get(),h.requests[1].device_token);assert.equal(h.requests[1].action,'registerRouteDevice');
});
test('duplicate connect clicks share one registration; malformed code never registers',async()=>{
 const h=harness();await assert.rejects(h.guide.connect('bad'));assert.equal(h.requests.length,0);
 await Promise.all([h.guide.connect('p'.repeat(40)),h.guide.connect('p'.repeat(40))]);assert.equal(h.requests.length,1);
});
test('every standalone asset exists and version/scope stay consistent',()=>{
 const sw=read('brand-guide/sw.js'),html=read('brand-guide/index.html');
 assert.match(sw,/brand-guide-v10/);assert.match(html,/data-version="v10"/);assert.match(read('brand-guide/bootstrap.js'),/scope:'\.\/'/);
 const assets=vm.runInNewContext(sw.slice(sw.indexOf('const ASSETS =')+15,sw.indexOf(';',sw.indexOf('const ASSETS ='))));
 for(const asset of assets){if(asset==='./')continue;const path=new URL(asset.split('?')[0],new URL('brand-guide/',import.meta.url));assert.ok(readFileSync(path).length);}
});

function appHarness({failConnect=false}={}) {
 const renders=[],listeners={},nodes=[];const container={replaceChildren(node){this.child=node;}};
 function node(tag){const n={tag,textContent:'',children:[],listeners:{},append(...children){this.children.push(...children);},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;}};nodes.push(n);return n;}
 const context={document:{getElementById(){return container;},createElement:node,addEventListener(type,fn){listeners[type]=fn;}},
 BrandGuideSync:{configureCredential(){}},GuideCredentials:{get:async()=>'',connect:async()=>{if(failConnect)throw new Error('接続できませんでした');}},GuideWorker:{ready:Promise.resolve(null)},
 BrandGuide:{render:async(c,options)=>{renders.push(options);}}};
 vm.runInNewContext(read('brand-guide/app.js'),context);
 return {renders,nodes,async start(){await listeners.DOMContentLoaded();},settings(){renders.at(-1).onConnection();}};
}
test('standalone connection success returns directly to the library with a forced download',async()=>{
 const h=appHarness();await h.start();h.settings();const input=h.nodes.find(n=>n.tag==='input');input.value='p'.repeat(40);
 await h.nodes.find(n=>n.textContent==='この図鑑を接続する').listeners.click();assert.equal(input.value,'');assert.equal(h.renders.length,2);assert.equal(h.renders.at(-1).forceSync,true);
});
test('failed connection stays on settings and never starts a download',async()=>{
 const h=appHarness({failConnect:true});await h.start();h.settings();h.nodes.find(n=>n.tag==='input').value='p'.repeat(40);
 const connect=h.nodes.find(n=>n.textContent==='この図鑑を接続する');await connect.listeners.click();assert.equal(h.renders.length,1);assert.equal(connect.disabled,false);assert.ok(h.nodes.some(n=>n.textContent.includes('接続できませんでした')));
});

test('worker upgrades reuse the existing guide URL and never register the store worker',async()=>{
 for(const [previous,expected] of [[null,'https://example.org/brand-guide/sw.js'],['https://example.org/brand-guide/sw.js?v=3','https://example.org/brand-guide/sw.js?v=3'],['https://example.org/sw.js?v=213','https://example.org/brand-guide/sw.js']]) {
   let registered;const context={URL,document:{baseURI:'https://example.org/brand-guide/',getElementById(){return null;}},navigator:{serviceWorker:{controller:previous?{scriptURL:previous}:null,addEventListener(){},register:async(url,options)=>{registered=url;assert.equal(options.updateViaCache,'none');assert.equal(options.scope,'./');return {active:{},addEventListener(){}};}}}};
   vm.runInNewContext(read('brand-guide/bootstrap.js')+'\nthis.worker=GuideWorker;',context);await context.worker.ready;assert.equal(registered,expected);
 }
});
