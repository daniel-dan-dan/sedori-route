import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
function appHarness({ storage = {}, api = {} } = {}) {
  const overlays = [];
  const makeElement = () => {
    let raw = '', text = '';
    const fields = new Map();
    const el = { value: '', disabled: false, isConnected: true, open: false, classList: { add() {}, remove() {} }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute() {}, focus() {},
      remove() { this.isConnected = false; },
      querySelector(selector) { return fields.get(selector.replace(/^#/, '')); },
      querySelectorAll(selector) { return [...fields.values()].filter(field => selector.split(',').map(s => s.trim()).includes(field.tag)); },
      get innerHTML() { return raw || text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); },
      set innerHTML(value) {
        raw = value;
        for (const match of value.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
          const field = makeElement(); field.tag = match[1]; field.id = match[3]; field.value = (match[2].match(/\bvalue="([^"]*)"/) || [,''])[1];
          if (field.tag === 'select') field.value = '中古品 - 良い';
          fields.set(field.id,field);
        }
      },
      get textContent() { return text; }, set textContent(value) { text = String(value); },
    }; return el;
  };
  const toastElement = makeElement();
  let operationSequence = 0;
  const context = vm.createContext({
    document: { addEventListener() {}, createElement:makeElement, body:{appendChild: el => overlays.push(el)}, getElementById: id => id === 'toast' ? toastElement : null },
    window: { addEventListener() {} }, console, setTimeout, clearTimeout,
    Storage: { savePurchaseDraft:async()=>{},getPurchaseDraft:async()=>null,clearPurchaseDraft:async()=>{},clearViewCache:async()=>{}, ...storage },
    API: { createOperationId:()=> ++operationSequence === 1 ? 'fixture-operation-id' : 'fixture-operation-id-' + operationSequence, ...api }, Intl, Date,
  });
  vm.runInContext(source.replace('return { init, loadData, toggleMapSelection };','return { showInventoryPurchaseModal, mustHoldInventorySubmission_, reorderRouteStores_, groupNearbyStores_, storeMatchesSearch_, esc };')+'\nglobalThis.subject=App;',context);
  return { app:context.subject, overlays };
}
const fixtureStore = {store_id:'fixture-store',name:'検証店舗'};
const ready = () => new Promise(resolve => setImmediate(resolve));
const form = harness => harness.overlays.at(-1);
const input = (overlay,selector,value) => { overlay.querySelector(selector).value = value; };

test('route reordering preserves inputs, adjusts adjacent order, and permits removing last store', () => {
  const {app}=appHarness(); const stores=[{store_id:'a'},{store_id:'b'},{store_id:'c'}];
  assert.deepEqual(Array.from(app.reorderRouteStores_(stores,1,-1),s=>s.store_id),['b','a','c']);
  assert.deepEqual(Array.from(app.reorderRouteStores_(stores,0,-1),s=>s.store_id),['a','b','c']);
  assert.deepEqual(Array.from(app.reorderRouteStores_(stores,1,0,true),s=>s.store_id),['a','c']);
  assert.equal(app.reorderRouteStores_([stores[0]],0,0,true).length,0);
  assert.deepEqual(stores.map(s=>s.store_id),['a','b','c']);
});
test('clusters keep selected pins independent and split after zoom changes projection', () => {
  const {app}=appHarness();const stores=[{store_id:'a',lat:1,lng:1},{store_id:'b',lat:1,lng:2},{store_id:'c',lat:1,lng:3}];
  const groups=app.groupNearbyStores_(stores,([x,y])=>({x,y}),new Set(['b']));
  assert.equal(groups.length,2); assert.equal(groups[0][0].store_id,'b');assert.equal(groups[1].length,2);
  assert.equal(app.groupNearbyStores_(stores,([x,y])=>({x:x*100,y:y*100})).length,3);
});
test('store search normalizes width and combines words across name and address',()=>{
  const {app}=appHarness();const store={name:'サンプル ＡＢＣ 店',address:'仙台市泉区',lat:38.32,lng:140.88};
  assert.equal(app.storeMatchesSearch_(store,'abc 泉区'),true);
  assert.equal(app.storeMatchesSearch_(store,'abc 山形'),false);
});
test('map fallback, five-menu navigation and waiting updates preserve safe controls',()=>{
  assert.equal([...index.matchAll(/class="nav-item(?: active)?"/g)].length,5);
  assert.match(index,/data-view="more"/);
  assert.doesNotMatch(source,/basemaps\.cartocdn\.com/);
  assert.match(source,/cyberjapandata\.gsi\.go\.jp\/xyz\/pale/);
  assert.match(source,/renderMapStoreList_\(\);\s*if \(!mapInstance/);
  assert.doesNotMatch(bootstrap,/location\.reload|type: 'SKIP_WAITING'/);
  assert.doesNotMatch(sw,/self\.skipWaiting\(/);
});
test('only a known server rejection releases a sent inventory operation',()=>{
  const {app}=appHarness();
  for(const accepted of [true,false]) for(const code of ['OPERATION_OUTCOME_UNKNOWN','PENDING_OPERATION_EXISTS','UNKNOWN_RESPONSE',undefined]) assert.equal(app.mustHoldInventorySubmission_(true,accepted,{code}),true);
  assert.equal(app.mustHoldInventorySubmission_(true,false,{code:'API_ERROR'}),false);
  assert.equal(app.mustHoldInventorySubmission_(false,false,new Error('quota')),false);
  assert.equal(app.mustHoldInventorySubmission_(true,true,{code:'API_ERROR'}),true);
});
test('continuous registration clears only after acceptance and creates a new item', async()=>{
  const sent=[];let saved;
  const h=appHarness({storage:{savePurchaseDraft:async(_key,data)=>{saved=data;}},api:{addInventoryPurchase:async payload=>{sent.push(payload);return {row:123};}}});
  h.app.showInventoryPurchaseModal(fixtureStore);await ready();const overlay=form(h);
  input(overlay,'#ip-name','商品A');input(overlay,'#ip-price','1000');
  await overlay.querySelector('#inventory-modal-next').listeners.click();
  assert.equal(sent.length,1);assert.equal(overlay.isConnected,true);assert.equal(overlay.querySelector('#ip-name').value,'');assert.equal(overlay.querySelector('#inventory-modal-next').disabled,false);
  input(overlay,'#ip-name','商品B');input(overlay,'#ip-price','1200');
  await overlay.querySelector('#inventory-modal-submit').listeners.click();
  assert.equal(sent.length,2);assert.notEqual(sent[0].operation_id,sent[1].operation_id);assert.equal(overlay.isConnected,false);assert.equal(saved.payload.product_name,'商品B');
});
for (const result of [{row:123},{_queued:true},{}]) test('local draft cleanup failure after acceptance never enables duplicate registration: '+JSON.stringify(result),async()=>{
  const sent=[];let lastDraft;
  const h=appHarness({storage:{clearPurchaseDraft:async()=>{throw Error('quota');},savePurchaseDraft:async(_key,data)=>{lastDraft=data;}},api:{addInventoryPurchase:async payload=>{sent.push(payload);return result;}}});
  h.app.showInventoryPurchaseModal(fixtureStore);await ready();const overlay=form(h);
  input(overlay,'#ip-name','商品A');input(overlay,'#ip-price','1000');
  await overlay.querySelector('#inventory-modal-next').listeners.click();
  assert.equal(overlay.querySelector('#inventory-modal-next').disabled,true);
  assert.equal(lastDraft.operationId,'fixture-operation-id');assert.equal(lastDraft.blocked,true);
  await overlay.querySelector('#inventory-modal-next').listeners.click();assert.equal(sent.length,1);
});
test('draft persistence failure prevents network submission, and a load error allows closing without overwriting',async()=>{
  let calls=0,writes=0;
  const h=appHarness({storage:{savePurchaseDraft:async()=>{throw Error('quota');}},api:{addInventoryPurchase:async()=>{calls++;}}});
  h.app.showInventoryPurchaseModal(fixtureStore);await ready();let overlay=form(h);input(overlay,'#ip-name','A');input(overlay,'#ip-price','1');
  await overlay.querySelector('#inventory-modal-next').listeners.click();assert.equal(calls,0);
  const failed=appHarness({storage:{getPurchaseDraft:async()=>{throw Error('unavailable');},savePurchaseDraft:async()=>{writes++;}}});
  failed.app.showInventoryPurchaseModal(fixtureStore);await ready();overlay=form(failed);
  await overlay.querySelector('#inventory-modal-cancel').listeners.click();assert.equal(overlay.isConnected,false);assert.equal(writes,0);
});
test('unknown results keep inputs and prevent edited re-entry from generating a new receipt',async()=>{
  let calls=0;
  const h=appHarness({api:{addInventoryPurchase:async()=>{calls++;throw Object.assign(Error('fixture'),{code:'OPERATION_OUTCOME_UNKNOWN'});}}});
  h.app.showInventoryPurchaseModal(fixtureStore);await ready();const overlay=form(h);input(overlay,'#ip-name','A');input(overlay,'#ip-price','1');
  await overlay.querySelector('#inventory-modal-next').listeners.click();
  assert.equal(overlay.querySelector('#ip-name').value,'A');assert.equal(overlay.querySelector('#ip-name').disabled,true);
  await overlay.querySelector('#inventory-modal-submit').listeners.click();assert.equal(calls,1);
});


test('quoted store names and searches stay inside escaped attributes',()=>{
  const {app}=appHarness();
  const value=app.esc('店舗\" data-extra=\"例\' <商品>');
  assert.ok(!value.includes('"'));assert.ok(!value.includes("'"));assert.ok(!value.includes('<'));
});
test('queued acceptance allows the next item but never calls the confirmed callback',async()=>{
  let callbacks=0;
  const h=appHarness({api:{addInventoryPurchase:async()=>({_queued:true})}});
  h.app.showInventoryPurchaseModal(fixtureStore,{onSaved:()=>{callbacks++;}});await ready();const overlay=form(h);
  input(overlay,'#ip-name','待機品');input(overlay,'#ip-price','1000');
  await overlay.querySelector('#inventory-modal-next').listeners.click();
  assert.equal(callbacks,0);assert.equal(overlay.querySelector('#ip-name').value,'');assert.equal(overlay.querySelector('#inventory-modal-next').disabled,false);
  assert.match(overlay.querySelector('#inventory-form-status').textContent,/反映は未確認/);
});
