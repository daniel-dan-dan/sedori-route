import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./amazon-pricing.js', import.meta.url), 'utf8');

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.ownText = ''; this.className = ''; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(' '); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const result = child.find(predicate); if (result) return result; } }
  async click() { if (!this.disabled) return this.handlers.click?.({ currentTarget: this }); }
}
const item = (overrides = {}) => ({ sku: 'test-sku', asin: 'B012345678', title: '確認用の商品', currentPrice: 12800, suggestedPrice: 12300, estimatedProfit: 2100, minPrice: 11500, reasons: ['同じ条件の競合価格を確認しました。'], nextReviewAt: new Date(Date.now() + 3 * 86400000).toISOString(), observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), status: 'lower', preference: { revision: 0, excluded: false, snoozedUntil: null }, ...overrides });
const snapshot = (overrides = {}) => ({ ok: true, mode: 'suggestion_only', configured: true, generatedAt: new Date().toISOString(), items: [item()], coverage: { total: 1, loaded: 1 }, ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness({ data = snapshot(), online = true, get, update, initial = {} } = {}) {
  const calls = { get: 0, update: 0 }, cache = new Map(Object.entries(initial)), settled = [];
  const storage = { async getViewCache(id) { return cache.has(id) ? { data: cache.get(id) } : null; }, async saveViewCache(id, value) { cache.set(id, value); }, async clearViewCache(id) { cache.delete(id); }, async settlePendingAction(id, value) { settled.push({ id, ...value }); } };
  const api = { async getAmazonPricing() { calls.get++; return get ? get(calls.get) : data; }, async updateAmazonPricingPreference(body) { calls.update++; return update ? update(body) : null; }, createOperationId() { return 'updateAmazonPricingPreference-test-id'; } };
  const timers = new Map(); let timerId = 0;
  const context = { document: { createElement: tag => new Node(tag), addEventListener() {}, removeEventListener() {} }, navigator: { onLine: online }, window: { addEventListener() {}, removeEventListener() {} }, API: api, Storage: storage, Router: { navigate() {} }, Date, Intl, Number, Object, Set, setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(`${source}\nglobalThis.pricing = AmazonPricing;`, context);
  const container = new Node('main');
  return { ...context, container, calls, cache, api, storage, settled, timers, pricing: context.pricing, button: label => container.find(node => node.tagName === 'button' && node.textContent === label) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('在庫数は独立した取得時刻で失効し、オフラインは前回参考として表示する', async () => {
  for (const age of [0,86400001]) {
    const at=new Date(Date.now()-age).toISOString();
    const h=harness({data:snapshot({items:[item({availableQuantity:2,availableQuantityObservedAt:at})]})});
    await h.pricing.render(h.container);
    assert.match(h.container.textContent,age ? /前回確認 2点（参考/ : /販売可能 2点/);
    if(age) assert.doesNotMatch(h.container.textContent,/販売可能 2点/);
  }
  const cached=snapshot({items:[item({availableQuantity:2,availableQuantityObservedAt:new Date().toISOString()})]});
  const h=harness({online:false,initial:{'amazon-pricing-snapshot-v1':cached}});
  await h.pricing.render(h.container);assert.match(h.container.textContent,/前回確認 2点（参考/);
  assert.doesNotMatch(h.container.textContent,/販売可能 2点/);
  const expired=h.pricing.normalizeItem(item({availableQuantity:null,lastKnownQuantity:3,lastQuantityObservedAt:'2026-01-01T00:00:00Z'}));
  assert.equal(h.pricing.quantityCurrent(expired),false);assert.equal(expired.quantity,3);
});
test('大型の費用設定は正しい商品・区分・更新番号を読戻した場合だけ完了する',async()=>{
  let current=snapshot();
  const h=harness({get:()=>current,update:body=>{
    assert.equal(body.action,'set_size');assert.equal(body.sizeClass,'large');assert.equal(body.asin,'B012345678');
    current=snapshot({items:[item({additionalCost:1000,preference:{revision:1,excluded:false,snoozedUntil:null,sizeClass:'large'}})]});
    return {ok:true,verified:true,item:current.items[0]};
  }});
  await h.pricing.render(h.container);assert.match(h.container.textContent,/区分は未確認/);
  await h.button('大型商品に設定').click();
  assert.equal(h.calls.update,1);assert.match(h.container.textContent,/大型・1点1,000円/);
  assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'),false);
  const got=h.pricing.normalizeItem(current.items[0]);
  assert.equal(h.pricing.preferenceMatches(got,{sku:got.sku,asin:'B000OTHER1',action:'set_size',sizeClass:'large',expectedRevision:0}),false);
});

test('欠損値は0円へ変換せず、実際の0円だけを表示する', () => {
  const { pricing } = harness();
  for (const value of [null, undefined, '', ' ', '\n\t', false, true, {}, [], 'invalid']) assert.equal(pricing.money(value), '未確認');
  assert.equal(pricing.money(0), '¥0'); assert.equal(pricing.money(-800), '−¥800');
  assert.equal(pricing.normalizeItem(item({ estimatedProfit: null })).estimatedProfit, null);
});
test('取得失敗・未知mode・重複SKUを空の成功一覧として扱わない', () => {
  const { pricing } = harness();
  for (const data of [null, {}, { items: [] }, snapshot({ mode: 'auto_apply' }), snapshot({ items: [item(), item()] })]) assert.throws(() => pricing.normalizeSnapshot(data));
  assert.equal(pricing.normalizeSnapshot(snapshot({ configured: false, items: [] })).configured, false);
});
test('検索は商品名/SKU/ASIN、フィルタは対象外と様子見を区別する', () => {
  const { pricing } = harness();
  const items = [pricing.normalizeItem(item()), pricing.normalizeItem(item({ sku: 'excluded', preference: { revision: 1, excluded: true } })), pricing.normalizeItem(item({ sku: 'waiting', preference: { revision: 1, snoozedUntil: new Date(Date.now() + 86400000).toISOString() } }))];
  assert.equal(pricing.filterItems(items, '確認用 B0123').length, 2);
  assert.equal(pricing.filterItems(items, '', 'excluded').length, 1);
  assert.equal(pricing.filterItems(items, '', 'attention').length, 1);
  assert.equal(pricing.filterItems(items, '', 'snoozed').length, 1);
});
test('サーバーのkeepとcollectingを維持・情報確認中として区別する', () => {
  const { pricing } = harness();
  const items = [pricing.normalizeItem(item({ status: 'keep' })), pricing.normalizeItem(item({ sku: 'collect', status: 'collecting' }))];
  assert.equal(pricing.filterItems(items, '', 'hold').length, 1);
  assert.equal(pricing.filterItems(items, '', 'collecting').length, 1);
  assert.equal(pricing.filterItems(items, '', 'attention').length, 0);
});
test('24時間到達・未来・日時欠損は古い状態、時刻は日本時間', () => {
  const { pricing } = harness();
  assert.equal(pricing.isStale(snapshot()), false);
  assert.equal(pricing.isStale(snapshot({ generatedAt: new Date(Date.now() - 24 * 3600000).toISOString() })), true);
  assert.equal(pricing.isStale(snapshot({ generatedAt: new Date(Date.now() + 3600000).toISOString() })), true);
  assert.equal(pricing.isStale(snapshot({ generatedAt: '' })), true);
  assert.match(pricing.time('2026-09-05T23:20:00Z'), /9\/6.*8:20/);
});
test('未設定と0件を区別し、価格変更ボタンを表示しない', async () => {
  const h = harness({ data: snapshot({ configured: false, items: [], coverage: {} }) });
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /接続準備中/);
  assert.match(h.container.textContent, /在庫0件という意味ではありません/);
  assert.equal(h.button('価格を変更'), undefined);
  assert.equal(h.calls.update, 0);
});
test('商品名と外部理由はHTMLではなくtextContentのみで描画する', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const h = harness({ data: snapshot({ items: [item({ title })] }) });
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(h.container.find(node => node.tagName === 'img'), undefined);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(/);
});
test('オフラインは保存済み表示だけで、API読取・書込を呼ばない', async () => {
  const h = harness({ online: false, initial: { 'amazon-pricing-snapshot-v1': snapshot() } });
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /オフライン/);
  assert.equal(h.button('3日様子を見る').disabled, true);
  assert.match(h.container.textContent, /前回取得価格（参考）/);
  assert.doesNotMatch(h.container.textContent, /¥12,300|¥2,100|¥11,500/);
  assert.deepEqual(h.calls, { get: 0, update: 0 });
});
test('取得エラーではキャッシュを残し、古い価格で設定変更できない', async () => {
  const h = harness({ initial: { 'amazon-pricing-snapshot-v1': snapshot() }, get: async () => { throw new Error('timeout'); } });
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /最新データを確認できません/);
  assert.match(h.container.textContent, /¥12,800/);
  assert.doesNotMatch(h.container.textContent, /¥12,300|¥2,100|¥11,500/);
  assert.equal(h.button('3日様子を見る').disabled, true);
});
test('提案の期限欠損・不正・到達時はおすすめ・利益・下限を表示しない', async () => {
  for (const validUntil of ['', 'invalid', new Date(Date.now() - 1).toISOString()]) {
    const h = harness({ data: snapshot({ items: [item({ validUntil, status: 'keep' })] }) });
    await h.pricing.render(h.container);
    assert.match(h.container.textContent, /有効期限が切れているか/);
    assert.match(h.container.textContent, /最新データを再取得/);
    assert.doesNotMatch(h.container.textContent, /¥12,300|¥2,100|¥11,500/);
    assert.equal(h.pricing.itemState(h.pricing.normalizeItem(item({ validUntil }))), 'review');
  }
});
test('将来の有効期限には自動再描画を予約し、別画面の描画時に旧予約を除去する', async () => {
  const h = harness(); await h.pricing.render(h.container);
  assert.equal(h.timers.size, 1);
  const old = [...h.timers.keys()][0];
  await h.pricing.render(h.container);
  assert.equal(h.timers.has(old), false); assert.equal(h.timers.size, 1);
});
test('コンディションを日本語化し、参考下限と対象範囲を明記する', async () => {
  const h = harness({ data: snapshot({ items: [item({ condition: 'new_new' })] }) });
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /状態: 新品/);
  assert.match(h.container.textContent, /参考下限価格/);
  assert.doesNotMatch(h.container.textContent, /下げてよい最低価格/);
  assert.match(h.container.textContent, /在庫管理シートの未販売Amazon SKU（未紐付のAmazon出品は含みません）/);
  assert.equal(h.pricing.conditionLabel('used_very_good'), '中古・非常に良い');
});
test('大量SKUでも常時最大50商品を描画して前後ページ切替できる', async () => {
  const h = harness({ data: snapshot({ items: Array.from({ length: 123 }, (_, n) => item({ sku: `sku-${n}`, title: `商品${n}` })), coverage: { total: 123 } }) });
  const countCards = node => (node.tagName === 'article' ? 1 : 0) + node.children.reduce((sum, child) => sum + countCards(child), 0);
  await h.pricing.render(h.container);
  assert.equal(countCards(h.container), 50); assert.match(h.container.textContent, /1〜50件を表示/);
  await h.button('次の50件').click(); assert.equal(countCards(h.container), 50); assert.match(h.container.textContent, /51〜100件を表示/);
  await h.button('次の50件').click(); assert.equal(countCards(h.container), 23); assert.match(h.container.textContent, /101〜123件を表示/);
  assert.equal(h.button('次の50件').disabled, true);
  await h.button('前の50件').click(); assert.equal(countCards(h.container), 50);
});
test('端末記録を読めない場合は未確定送信の有無が不明なので変更しない', async () => {
  const h = harness();
  h.storage.getViewCache = async () => { throw new Error('IndexedDB failed'); };
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /端末の保存記録を確認できるまで/);
  assert.equal(h.calls.update, 0);
});
test('送信前の受付記録読戻しに失敗したらAPI書込を呼ばない', async () => {
  const h = harness(); await h.pricing.render(h.container);
  h.storage.saveViewCache = async () => {};
  h.button('3日様子を見る').click(); await settle(); await settle();
  assert.equal(h.calls.update, 0);
  assert.match(h.container.textContent, /送信していません/);
});
test('古い画面の遅い応答は新しい画面を上書きしない', async () => {
  const first = deferred();
  const h = harness({ get: call => call === 1 ? first.promise : snapshot({ items: [item({ title: '新しい画面' })] }) });
  const old = h.pricing.render(h.container); await settle();
  await h.pricing.render(h.container);
  first.resolve(snapshot({ items: [item({ title: '古い応答' })] })); await old;
  assert.match(h.container.textContent, /新しい画面/);
  assert.doesNotMatch(h.container.textContent, /古い応答/);
});
test('書込中の二重クリックを止め、応答と別の一覧読戻しまで保存を確定しない', async () => {
  const gate = deferred(); let saved;
  const h = harness({ get: call => call === 1 ? snapshot() : snapshot({ items: [saved] }), update: async body => { await gate.promise; saved = item({ preference: { revision: 1, excluded: false, snoozedUntil: new Date(Date.now() + body.days * 86400000).toISOString() } }); return { ok: true, verified: true, item: saved }; } });
  await h.pricing.render(h.container);
  const original = h.button('3日様子を見る'); original.click(); original.click(); await settle();
  assert.equal(h.calls.update, 1); gate.resolve(); await settle(); await settle();
  assert.equal(h.calls.get, 2); assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), false);
  assert.match(h.container.textContent, /様子見中/);
});
test('結果不明は永続記録を残し、再表示・最新確認でも再送しない', async () => {
  const h = harness({ update: async () => { throw new Error('network'); } });
  await h.pricing.render(h.container); h.button('対象外にする').click(); await settle(); await settle();
  assert.equal(h.calls.update, 1); assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), true);
  await h.pricing.render(h.container);
  assert.match(h.container.textContent, /二重保存を防ぐため再送しません/);
  assert.equal(h.button('対象外にする').disabled, true); assert.equal(h.calls.update, 1);
});
test('書込前の確定拒否5種類だけは受付を解除し、再取得後に操作できる', async () => {
  for (const code of ['INVALID_INPUT', 'PRICING_REFRESH_REQUIRED', 'PRICING_REVISION_CONFLICT', 'BUSY', 'UNAUTHORIZED']) {
    const h = harness({ update: async () => { throw Object.assign(new Error('confirmed rejection'), { code }); } });
    await h.pricing.render(h.container); h.button('対象外にする').click(); await settle(); await settle();
    assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), false, code);
    assert.equal(h.button('対象外にする').disabled, true, code);
    assert.match(h.container.textContent, /設定は保存されませんでした/);
    h.button('最新データを確認').click(); await settle(); await settle();
    assert.equal(h.button('対象外にする').disabled, false, code);
    assert.equal(h.calls.update, 1);
  }
});
test('不明API_ERRORやTIMEOUTは確定拒否として解除しない', async () => {
  for (const code of ['API_ERROR', 'TIMEOUT', 'UNKNOWN_RESPONSE', 'OPERATION_OUTCOME_UNKNOWN']) {
    const h = harness({ update: async () => { throw Object.assign(new Error('unknown'), { code }); } });
    await h.pricing.render(h.container); h.button('対象外にする').click(); await settle(); await settle();
    assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), true, code);
    assert.equal(h.button('対象外にする').disabled, true, code);
  }
});
test('保存後の読戻しBUSYは書込拒否ではないため未確定受付を残す', async () => {
  const h = harness({ get: async count => { if (count > 1) throw Object.assign(new Error('readback busy'), { code: 'BUSY' }); return snapshot(); }, update: async () => ({ ok: true, verified: true, item: item({ preference: { revision: 1, excluded: true, snoozedUntil: null } }) }) });
  await h.pricing.render(h.container); h.button('対象外にする').click(); await settle(); await settle();
  assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), true);
  assert.match(h.container.textContent, /保存結果を確認できませんでした/);
});
test('読取だけで保存を照合できた場合はUI受付と共通送信待ちを両方解決する', async () => {
  const operation = { sku: 'test-sku', action: 'exclude', expectedRevision: 0, operation_id: 'old-operation' };
  const h = harness({ initial: { 'amazon-pricing-preference-pending-v1': operation }, data: snapshot({ items: [item({ preference: { revision: 1, excluded: true, snoozedUntil: null } })] }) });
  await h.pricing.render(h.container);
  assert.equal(h.calls.update, 0);
  assert.deepEqual(h.settled, [{ id: 'old-operation', remove: true }]);
  assert.equal(h.cache.has('amazon-pricing-preference-pending-v1'), false);
});
test('異なる商品・同一revision・意図と違う設定では保存照合を通さない', () => {
  const { pricing } = harness();
  const pending = { sku: 'test-sku', action: 'exclude', expectedRevision: 0 };
  assert.equal(pricing.preferenceMatches(pricing.normalizeItem(item()), pending), false);
  assert.equal(pricing.preferenceMatches(pricing.normalizeItem(item({ sku: 'other', preference: { revision: 1, excluded: true } })), pending), false);
  assert.equal(pricing.preferenceMatches(pricing.normalizeItem(item({ preference: { revision: 1, excluded: true } })), pending), true);
});
test('新JSのcache bust・Service Worker登録と画面版数が揃っている', () => {
  const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const version = index.match(/data-version="v(\d+)"/)[1];
  assert.ok(index.includes(`amazon-pricing.js?v=${version}`));
  assert.ok(sw.includes(`amazon-pricing.js?v=${version}`));
  assert.equal((index.match(/class="nav-item/g) || []).length, 5, '公開済みv198の5タブを維持する');
  assert.ok(index.includes('data-view="more"'));
  assert.ok(!index.includes('data-view="amazon-pricing"'), 'Amazon価格管理はホーム入口のみ');
});
