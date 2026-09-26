import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

const apiSource = readFileSync(new URL('api.js', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('storage.js', import.meta.url), 'utf8');

// A shared transactional fixture: requests are asynchronous and transactions
// serialize across connections. It exercises the real Storage/API code without
// real browser credentials, product data, network requests, or dependencies.
function memoryIndexedDb() {
  const databases = new Map();
  function database(name) {
    if (!databases.has(name)) databases.set(name, { stores: new Map(), transactions: [], active: false });
    return databases.get(name);
  }
  function startNext(state) {
    if (state.active || !state.transactions.length) return;
    state.active = true;
    const transaction = state.transactions.shift();
    queueMicrotask(() => transaction.run());
  }
  return {
    open(name) {
      const fresh = !databases.has(name);
      const state = database(name);
      const result = {
        objectStoreNames: { contains: key => state.stores.has(key) },
        createObjectStore(key, options = {}) { state.stores.set(key, { values: new Map(), next: 1, options }); },
        transaction(storeName) {
          const operations = [];
          const tx = { oncomplete: null, onerror: null, onabort: null };
          const store = state.stores.get(storeName);
          assert.ok(store, `fixture store missing: ${storeName}`);
          const request = operation => {
            const req = { result: undefined, onsuccess: null, onerror: null };
            operations.push(() => { req.result = operation(); req.onsuccess?.({ target: req }); });
            return req;
          };
          tx.objectStore = () => ({
            getAll: () => request(() => [...store.values.values()].map(value => structuredClone(value))),
            get: key => request(() => structuredClone(store.values.get(key))),
            add: value => request(() => {
              const key = store.options.keyPath ? value[store.options.keyPath] : store.next++;
              if (store.values.has(key)) throw Error('fixture duplicate key');
              store.values.set(key, structuredClone(value)); return key;
            }),
            put: (value, explicitKey) => request(() => {
              const key = explicitKey ?? (store.options.keyPath ? value[store.options.keyPath] : store.next++);
              store.values.set(key, structuredClone(value)); return key;
            }),
            delete: key => request(() => store.values.delete(key)),
            clear: () => request(() => store.values.clear()),
            openCursor() {
              let entries;
              const req = { result: undefined, onsuccess: null, onerror: null };
              let index = 0;
              const next = () => {
                entries ??= [...store.values.entries()];
                const entry = entries[index++];
                req.result = entry ? { primaryKey: entry[0], value: structuredClone(entry[1]), continue: () => operations.push(next) } : null;
                req.onsuccess?.({ target: req });
              };
              operations.push(next); return req;
            },
          });
          tx.run = () => {
            try {
              while (operations.length) operations.shift()();
              tx.oncomplete?.({ target: tx });
            } catch (error) {
              tx.onerror?.({ target: { error } });
              tx.onabort?.({ target: { error } });
            } finally {
              state.active = false; startNext(state);
            }
          };
          state.transactions.push(tx); startNext(state); return tx;
        },
      };
      const req = { result, onsuccess: null, onupgradeneeded: null, onerror: null };
      queueMicrotask(() => {
        if (fresh) req.onupgradeneeded?.({ target: { result } });
        req.onsuccess?.({ target: { result } });
      });
      return req;
    },
  };
}

function harness(indexedDB, fetchImpl) {
  const values = new Map([['daniel_route_device_auth_v1', 'fixture-not-a-real-secret']]);
  const context = vm.createContext({
    indexedDB, crypto: webcrypto, URL, AbortController, setTimeout, clearTimeout,
    queueMicrotask, structuredClone,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    navigator: { onLine: true },
    window: { dispatchEvent() {}, addEventListener() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    console: { warn() {} },
    fetch: fetchImpl,
  });
  vm.runInContext(`${storageSource}\n${apiSource}\nglobalThis.subject = { API, Storage };`, context);
  return context.subject;
}
const response = (data, error = '') => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: !error, data, error }) });
const unknown = () => response(null, 'OPERATION_OUTCOME_UNKNOWN: fixture only');
const purchase = { product_name: 'fixture product', purchase_date: '2026-09-05', store_id: 's-fixture', store_name: 'fixture shop', purchase_price: 1000 };
const item = { inventory_uuid: 'inv_00000000-0000-4000-8000-000000000001', expected_date: '2026-09-05', expected_shop: '', shop: 'fixture shop' };


const appSource = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const gasSource = readFileSync(process.env.STORE_GAS_CODE || new URL('../gas/Code.gs', import.meta.url), 'utf8');
function stopServer() {
  const headers=['route_id','stop_order','store_id','arrival_time','departure_time','purchase_amount','purchase_items','status'];
  const rows=[headers,['route-a',1,'store-a','','',0,0,'planned']];
  let writes=0;
  const sheet={getDataRange(){return this.getRange(1,1,rows.length,headers.length)},getRange(row,col,height=1,width=1){
    return {getValues:()=>Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>rows[row+y-1]?.[col+x-1]??'')),
      setValue:value=>{rows[row-1][col-1]=value;writes++;}};
  }};
  const ctx={console,Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>[...createHash('sha256').update(v).digest()]},
    SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet})},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:content=>({getContent:()=>content,setMimeType(){return this}})}};
  vm.runInNewContext(gasSource,ctx);
  const result=value=>JSON.parse(value.getContent());
  return {read:()=>result(ctx.getRouteStops_({route_id:'route-a'})).data,
    update:body=>result(ctx.updateStop_(body)),state:()=>rows[1][7],writes:()=>writes};
}
const stopBody={route_id:'route-a',store_id:'store-a',status:'skipped',departure_time:'2026-09-26T00:00:00Z'};

test('stop entity reservation blocks changed status and route end from overtaking an unresolved update',async()=>{
  const server=stopServer(),writes=[];
  const {API,Storage}=harness(memoryIndexedDb(),async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.action==='getRouteStops') return response(server.read());
    writes.push(body);throw new TypeError('Failed to fetch');
  });
  await assert.rejects(API.updateStop(stopBody,{queueOnFailure:false}));
  await assert.rejects(API.updateStop({...stopBody,status:'visited',departure_time:'later'},{queueOnFailure:false}),{code:'PENDING_OPERATION_EXISTS'});
  await assert.rejects(API.endRoute({route_id:'route-a'}),{code:'PENDING_OPERATION_EXISTS'});
  assert.equal(writes.length,1);
  assert.equal((await Storage.getPendingActions()).length,1);
});
test('server compare-before-write prevents an old guarded queue entry overwriting a later visit',async()=>{
  const server=stopServer();let first=true;
  const {API,Storage}=harness(memoryIndexedDb(),async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.action==='getRouteStops')return response(server.read());
    if(first){first=false;throw new TypeError('Failed to fetch');}
    const r=server.update(body);return response(r.data,r.error);
  });
  await assert.rejects(API.updateStop(stopBody,{queueOnFailure:false}));
  const revision=server.read()[0].stop_revision;
  assert.equal(server.update({...stopBody,status:'visited',expected_stop_revision:revision}).success,true);
  const writes=server.writes();
  assert.equal(await Storage.syncPending(),0);
  assert.equal(server.state(),'visited');assert.equal(server.writes(),writes);
  assert.equal((await Storage.getPendingActions()).length,0,'only the explicit pre-write refusal is settled');
  // A fresh deliberate operation is possible after that known rejection.
  await API.updateStop({...stopBody,status:'skipped'},{queueOnFailure:false});
  assert.equal(server.state(),'skipped');
});
test('legacy unguarded stop queue remains intact and is never automatically resent',async()=>{
  let calls=0;const {API,Storage}=harness(memoryIndexedDb(),async()=>{calls++;throw Error('unexpected network')});
  await API.ready();
  await Storage.reservePendingAction({action:'updateStop',body:stopBody,operation_id:'legacy-stop',timestamp:Date.now(),attempts:0});
  assert.equal(await Storage.syncPending(),0);assert.equal(calls,0);
  assert.equal((await Storage.getPendingActions())[0].operation_id,'legacy-stop');
  assert.match((await Storage.getPendingQueueStatus()).blockedReasons[0],/旧版/);
});
test('unknown guarded stop outcome is retained and not replayed',async()=>{
  const server=stopServer();let writes=0;
  const {API,Storage}=harness(memoryIndexedDb(),async(_url,options)=>{
    if(JSON.parse(options.body).action==='getRouteStops')return response(server.read());
    writes++;return unknown();
  });
  await assert.rejects(API.updateStop(stopBody),{code:'OPERATION_OUTCOME_UNKNOWN'});
  assert.equal(await Storage.syncPending(),0);assert.equal(writes,1);
  assert.equal((await Storage.getPendingActions()).length,1);
});
test('old server or unavailable revision read sends no update and reserves nothing',async()=>{
  for(const unavailable of [false,true]) {
    const calls=[];const {API,Storage}=harness(memoryIndexedDb(),async(_url,options)=>{
      calls.push(JSON.parse(options.body).action);
      if(unavailable)throw new TypeError('offline fixture');
      return response([{store_id:'store-a',status:'planned'}]);
    });
    await assert.rejects(API.updateStop(stopBody));
    assert.deepEqual(calls,['getRouteStops']);assert.equal((await Storage.getPendingActions()).length,0);
  }
});
test('successful guarded updates reuse the returned revision and server refuses unguarded or stale writes',async()=>{
  const server=stopServer(),calls=[];
  const firstRevision=server.read()[0].stop_revision;
  const {API}=harness(memoryIndexedDb(),async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    if(body.action==='getRouteStops')return response(server.read());
    const r=server.update(body);return response(r.data,r.error);
  });
  await API.updateStop(stopBody);
  await API.updateStop({...stopBody,status:'visited'});
  assert.deepEqual(calls.map(c=>c.action),['getRouteStops','updateStop','updateStop']);
  assert.notEqual(calls[1].expected_stop_revision,calls[2].expected_stop_revision);
  const writes=server.writes();
  assert.match(server.update(stopBody).error,/STOP_UPDATE_REQUIRED/);
  assert.match(server.update({...stopBody,expected_stop_revision:firstRevision}).error,/STOP_REFRESH_REQUIRED/);
  assert.equal(server.writes(),writes);
});

function appHarness(apiStorage, chosenStore) {
  const instrumented=appSource.replace('return { init, loadData, toggleMapSelection };',
    'return {audit:{startPatrol,setRoute(value){optimizedRoute=value},getState(){return patrolState},getPending(){return pendingStartState}}};');
  const toast={textContent:'',classList:{add(){},remove(){}}};
  const ctx={...apiStorage,Router:{navigate(){},getCurrentView(){return 'home'}},
    RouteOptimizer:{generateMapsUrl(){return ''},generateMapsSegments(){return []}},
    document:{getElementById(id){return id==='toast'?toast:null},addEventListener(){},createElement(){return {textContent:'',innerHTML:''}}},
    window:{addEventListener(){}},navigator:{onLine:true},console,URL,Intl,Date,Promise,Map,Set,
    setTimeout(){return 1},clearTimeout(){},setInterval(){return 1},clearInterval(){}};
  vm.runInNewContext(instrumented+';globalThis.auditApp=App.audit;',ctx);
  ctx.auditApp.setRoute({orderedStores:[{store_id:chosenStore,name:chosenStore}],totalDistanceKm:1});
  return {...ctx.auditApp,toast};
}
function routeServer() {
  const receipts=new Map(),requests=[];
  return {receipts,requests,fetch:async(_url,options)=>{
    const req=JSON.parse(options.body);requests.push(req);
    if(!receipts.has(req.operation_id))receipts.set(req.operation_id,{route_id:'route-'+(receipts.size+1),start_time:'2026-09-26 08:00:00'});
    return response(receipts.get(req.operation_id));
  }};
}
const routeCandidate={routeId:'pending',startOperationId:'crashed-route-start',startTime:123,
  startRequest:{store_ids:['original-store'],total_distance_km:1},stops:[{store_id:'original-store'}],currentIdx:0};
test('two tabs reserve one route start even when their selected stores differ',async()=>{
  const db=memoryIndexedDb(),server=routeServer();
  const left=harness(db,server.fetch),right=harness(db,server.fetch);await Promise.all([left.API.ready(),right.API.ready()]);
  const a=appHarness(left,'store-A'),b=appHarness(right,'store-B');
  await Promise.all([a.startPatrol(),b.startPatrol()]);
  assert.equal(server.receipts.size,1);
  assert.equal(new Set(server.requests.map(r=>r.operation_id)).size,1);
  assert.equal(a.getState().routeId,b.getState().routeId);
  assert.equal((await left.Storage.getCurrentRoute()).routeId,a.getState().routeId);
});
test('a crash immediately after reservation recovers the same receipt without a lease or a new route',async()=>{
  const db=memoryIndexedDb(),server=routeServer(),first=harness(db,server.fetch);
  await first.Storage.reserveRouteStart(routeCandidate);
  const reloaded=harness(db,server.fetch);await reloaded.API.ready();
  const app=appHarness(reloaded,'different-store');await app.startPatrol();
  assert.equal(server.requests[0].operation_id,routeCandidate.startOperationId);
  assert.deepEqual(server.requests[0].store_ids,['original-store']);
  assert.equal(app.getPending(),null);assert.equal(server.receipts.size,1);
});
test('local confirmation failure retains pending start; reload recovers the existing server receipt',async()=>{
  const db=memoryIndexedDb(),server=routeServer(),first=harness(db,server.fetch);
  const broken={...first,Storage:{...first.Storage,confirmRouteStart:async()=>{throw Error('storage failure')}}};
  const app=appHarness(broken,'store-A');await app.startPatrol();
  assert.equal((await first.Storage.getCurrentRoute()).routeId,'pending');
  assert.match(app.toast.textContent,/同じ内容|同じ受付/);
  const retry=harness(db,server.fetch);const recovered=appHarness(retry,'store-B');await recovered.startPatrol();
  assert.equal(server.receipts.size,1);assert.equal(recovered.getState().routeId,'route-1');
});
test('a delayed confirmation preserves progress made by another tab and rejected cleanup cannot erase it',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no network')});
  await Storage.reserveRouteStart(routeCandidate);
  await Storage.confirmRouteStart(routeCandidate.startOperationId,{...routeCandidate,routeId:'route-1',currentIdx:1});
  const late=await Storage.confirmRouteStart(routeCandidate.startOperationId,{...routeCandidate,routeId:'route-1',currentIdx:0});
  assert.equal(late.currentIdx,1);
  await Storage.clearRejectedRouteStart(routeCandidate.startOperationId);
  assert.equal((await Storage.getCurrentRoute()).routeId,'route-1');
});
test('failed reservation read never sends a route start or clears saved state',async()=>{
  const server=routeServer(),subject=harness(memoryIndexedDb(),server.fetch);let cleared=0;
  const app=appHarness({...subject,Storage:{...subject.Storage,reserveRouteStart:async()=>{throw Error('read failed')},clearRejectedRouteStart:async()=>{cleared++}}},'store-A');
  await app.startPatrol();assert.equal(server.requests.length,0);assert.equal(cleared,0);
});

function inventoryHarness(Storage,fetcher) {
  const source=appSource.slice(appSource.indexOf('  function inventorySectionForRoute_('),appSource.indexOf('  function renderInventoryFetchError_('));
  const events=[];let section=null;
  const context={Storage,API:{getInventoryPurchases:fetcher},Router:{getCurrentView(){return 'history-detail'}},
    document:{getElementById(){return section}},normalizeRouteDate_:v=>v,inventoryByDateCache:{},inventoryRefreshInFlightByDate:{},
    renderInventoryForRoute:(route,items)=>events.push({kind:'render',route:route.route_id,items}),
    renderInventoryFetchError_:(route,message)=>events.push({kind:'error',route:route.route_id,message})};
  vm.runInNewContext(source+';globalThis.api={loadInventoryForRoute,fetchInventoryForDate_,refreshInventoryForRoute};',context);
  return {...context.api,events,show(route){if(section)section.isConnected=false;section={innerHTML:'',isConnected:true,dataset:{routeId:route.route_id,routeDate:route.date}};return section}};
}
const routeA={route_id:'route-A',date:'2026-09-25'},routeB={route_id:'route-B',date:'2026-09-26'};
test('legacy double-wrapped inventory and stops caches are recovered without modifying unrelated caches',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no network')});
  for(const key of ['inventory_2026-09-26','stops_route-B']) {
    await Storage.saveViewCache(key,{data:[{name:'saved'}]});
    assert.ok(Array.isArray((await Storage.getViewCache(key)).data));
  }
  await Storage.saveViewCache('unrelated',{data:[1]});
  assert.ok(Array.isArray((await Storage.getViewCache('unrelated')).data.data));
});
test('fresh and legacy cached inventory including an empty result render offline after reload',async()=>{
  for(const legacy of [false,true])for(const items of [[{product_name:'saved-item'}],[]]) {
    const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no transport')});
    if(legacy)await Storage.saveViewCache('inventory_'+routeB.date,{data:items});
    else await inventoryHarness(Storage,async()=>items).fetchInventoryForDate_(routeB.date);
    const saved=await Storage.getViewCache('inventory_'+routeB.date);assert.ok(Array.isArray(saved.data));
    let calls=0;const reload=inventoryHarness(Storage,async()=>{calls++;throw Error('offline')});reload.show(routeB);
    await reload.loadInventoryForRoute(routeB,{backgroundRefresh:false});
    assert.equal(calls,0);assert.equal(reload.events[0].kind,'render');assert.equal(reload.events[0].items.length,items.length);
  }
});
for(const failed of [false,true])test('late previous-route refresh '+(failed?'error':'success')+' never overwrites the current detail',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no transport')});let finish;
  const page=inventoryHarness(Storage,async params=>params.from===routeA.date?new Promise((resolve,reject)=>{finish=failed?()=>reject(Error('old error')):()=>resolve([{name:'A'}])}):[{name:'B'}]);
  page.show(routeA);const a=page.refreshInventoryForRoute(routeA,routeA.date,{showErrors:true});
  page.show(routeB);await page.refreshInventoryForRoute(routeB,routeB.date,{showErrors:true});
  finish();await a;
  assert.deepEqual(page.events.map(e=>[e.kind,e.route]),[['render','route-B']]);
});
test('two details for the same date share the read while only the newest section is painted',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no transport')});let finish,calls=0;
  const page=inventoryHarness(Storage,()=>{calls++;return new Promise(resolve=>{finish=resolve})});
  const other={...routeA,route_id:'route-other'};
  page.show(routeA);const a=page.refreshInventoryForRoute(routeA,routeA.date);
  page.show(other);const b=page.refreshInventoryForRoute(other,other.date);
  finish([]);await Promise.all([a,b]);
  assert.equal(calls,1);assert.deepEqual(page.events.map(e=>e.route),['route-other']);
});
test('late first-load inventory response cannot paint a replaced detail section',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no transport')});let finish,started;
  const began=new Promise(resolve=>{started=resolve});
  const page=inventoryHarness(Storage,params=>params.from===routeA.date?new Promise(resolve=>{finish=resolve;started()}):Promise.resolve([{name:'B'}]));
  page.show(routeA);const a=page.loadInventoryForRoute(routeA);await began;
  page.show(routeB);await page.loadInventoryForRoute(routeB);
  finish([{name:'A'}]);await a;
  assert.deepEqual(page.events.map(e=>e.route),['route-B']);
});

test('malformed inventory data never overwrites a valid cached list with an empty result',async()=>{
  const {Storage}=harness(memoryIndexedDb(),()=>{throw Error('no transport')});
  await Storage.saveViewCache('inventory_'+routeB.date,[{name:'saved'}]);
  const page=inventoryHarness(Storage,async()=>({wrong:'shape'}));
  await assert.rejects(page.fetchInventoryForDate_(routeB.date),/応答形式/);
  assert.equal((await Storage.getViewCache('inventory_'+routeB.date)).data[0].name,'saved');
});
test('late route-stop detail load cannot replace another route header',async()=>{
  let resolveA;
  const prefix=appSource.slice(appSource.indexOf('  async function renderHistoryDetail('),appSource.indexOf('    const dateStr = formatRouteDate_(route.date);',appSource.indexOf('  async function renderHistoryDetail(')));
  const ctx={historyRenderSequence:0,stopsCacheByRouteId:{},setTitle(){},esc:String,
    Router:{getCurrentView:()=> 'history-detail',navigate(){}},
    Storage:{getViewCache:async()=>null,saveViewCache:async()=>{}},
    API:{getRouteStops:()=>new Promise(resolve=>{resolveA=resolve})},events:[]};
  vm.runInNewContext(prefix+'events.push(route.route_id);}\nglobalThis.render=renderHistoryDetail;',ctx);
  const container={isConnected:true,innerHTML:''};
  const first=ctx.render(container,{route:{...routeA}});
  await new Promise(resolve=>setImmediate(resolve));
  await ctx.render(container,{route:{...routeB,stops:[]}});
  resolveA([{store_id:'store-A'}]);await first;
  assert.deepEqual(ctx.events,['route-B']);
});
