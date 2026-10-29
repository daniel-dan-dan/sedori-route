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
 const version=html.match(/data-version="(v\d+)"/)[1];assert.ok(sw.includes('brand-guide-'+version));assert.match(read('brand-guide/bootstrap.js'),/scope:'\.\/'/);
 const assets=vm.runInNewContext(sw.slice(sw.indexOf('const ASSETS =')+15,sw.indexOf(';',sw.indexOf('const ASSETS ='))));
 for(const asset of assets){if(asset==='./')continue;const path=new URL(asset.split('?')[0],new URL('brand-guide/',import.meta.url));assert.ok(readFileSync(path).length);}
});

function appHarness() {
 const renders=[],listeners={},nodes=[];let publicConfigured=0;
 const container={replaceChildren(node){this.child=node;}};
 function node(tag){const n={tag,textContent:'',children:[],append(...children){this.children.push(...children);},setAttribute(){},addEventListener(){}};nodes.push(n);return n;}
 const context={document:{getElementById(){return container;},createElement:node,addEventListener(type,fn){listeners[type]=fn;}},
 BrandGuideSync:{configurePublicRead(){publicConfigured++;}},GuideWorker:{ready:Promise.resolve(null)},BrandGuide:{render:async(c,options)=>{renders.push(options);}}};
 vm.runInNewContext(read('brand-guide/app.js'),context);
 return {renders,nodes,get publicConfigured(){return publicConfigured;},async start(){await listeners.DOMContentLoaded();}};
}
test('standalone starts public reading without a connection code or credential helper',async()=>{
 const h=appHarness();await h.start();assert.equal(h.publicConfigured,1);assert.equal(h.renders.length,1);assert.equal(h.renders[0].publicRead,true);assert.equal(h.renders[0].onConnection,undefined);assert.ok(!h.nodes.some(n=>n.tag==='input'));
});
test('standalone page no longer loads credential registration code',()=>{
 assert.doesNotMatch(read('brand-guide/index.html'),/src="credentials\.js/);assert.doesNotMatch(read('brand-guide/app.js'),/GuideCredentials|registerRouteDevice|接続コード/);
});

test('worker upgrades reuse the existing guide URL and never register the store worker',async()=>{
 for(const [previous,expected] of [[null,'https://example.org/brand-guide/sw.js'],['https://example.org/brand-guide/sw.js?v=3','https://example.org/brand-guide/sw.js?v=3'],['https://example.org/sw.js?v=243','https://example.org/brand-guide/sw.js']]) {
   let registered;const context={URL,document:{baseURI:'https://example.org/brand-guide/',getElementById(){return null;}},navigator:{serviceWorker:{controller:previous?{scriptURL:previous}:null,addEventListener(){},register:async(url,options)=>{registered=url;assert.equal(options.updateViaCache,'none');assert.equal(options.scope,'./');return {active:{},addEventListener(){}};}}}};
   vm.runInNewContext(read('brand-guide/bootstrap.js')+'\nthis.worker=GuideWorker;',context);await context.worker.ready;assert.equal(registered,expected);
 }
});

test('worker confirmation uses the displayed version rather than permanently comparing with v18',async()=>{
 for(const [pageVersion,workerVersion,expectedNotice] of [['v26','v26',false],['v99','v99',false],['v26','v22',true]]) {
  const listeners={},notices=[];
  const context={URL,document:{baseURI:'https://example.org/brand-guide/',getElementById(id){return id==='app-version-badge'?{dataset:{version:pageVersion}}:null;},createElement(){return {setAttribute(){}};},body:{prepend(node){notices.push(node);}}},navigator:{serviceWorker:{addEventListener(event,listener){listeners[event]=listener;},register:async()=>({active:{},addEventListener(){}})}}};
  vm.runInNewContext(read('brand-guide/bootstrap.js'),context);
  listeners.message({data:{type:'SW_VERSION',cacheName:'brand-guide-'+workerVersion}});
  assert.equal(notices.length,expectedNotice?1:0);
 }
});

 test("standalone release cache busts all versioned assets consistently", () => { const html=readFileSync(new URL("./brand-guide/index.html",import.meta.url),"utf8"); const sw=readFileSync(new URL("./brand-guide/sw.js",import.meta.url),"utf8"); const version=html.match(/data-version="v(\d+)"/)[1]; const versions=[...html.matchAll(/\?v=(\d+)/g),...sw.matchAll(/\?v=(\d+)/g)].map(m=>m[1]); assert.ok(versions.length>10); assert.ok(versions.every(v=>v===version)); });

test('offline navigation icons accept SVG and reject an HTML error response',()=>{
 const source=read('brand-guide/sw.js');
 const context={URL,self:{location:{href:'https://example.org/brand-guide/sw.js',origin:'https://example.org'}}};
 vm.runInNewContext(source.slice(0,source.indexOf("self.addEventListener('install'"))+'\nthis.validate=validAssetResponse_;this.assets=ASSETS;',context);
 const icons=context.assets.filter(asset=>asset.endsWith('.svg'));
 assert.equal(icons.length,3);
 for(const icon of icons){
  assert.equal(context.validate(icon,new Response('<svg/>',{headers:{'content-type':'image/svg+xml; charset=utf-8'}})),true);
  assert.equal(context.validate(icon,new Response('<html>not found</html>',{headers:{'content-type':'text/html'}})),false);
 }
});
