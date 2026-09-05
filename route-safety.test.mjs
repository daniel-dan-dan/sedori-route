import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const gas = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
const app = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('api.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('storage.js', import.meta.url), 'utf8');
class Sheet {
  constructor(rows = []) { this.rows = rows; this.writes = 0; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(82, ...this.rows.map(row => row.length)); }
  setFrozenRows() {}
  appendRow(row) { if (this.failAppend) throw Error('append failed'); this.rows.push([...row]); }
  getRange(r, c, h = 1, w = 1) {
    const sheet = this;
    const getValues = () => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => sheet.rows[r + y - 1]?.[c + x - 1] ?? ''));
    return {
      getRow: () => r, getValue: () => getValues()[0][0], getValues,
      getDisplayValues: () => getValues().map(row => row.map(String)),
      setValue(value) {
        if (c === 4 && sheet.failResponse) { sheet.failResponse = false; throw Error('receipt write failed'); }
        while (sheet.rows.length < r) sheet.rows.push([]);
        sheet.rows[r - 1][c - 1] = value; sheet.writes++;
      },
      createTextFinder(value) {
        return { matchEntireCell() { return this; }, findAll() {
          return getValues().flatMap((row, index) => String(row[0]) === value ? [{ getRow: () => r + index }] : []);
        } };
      },
    };
  }
  getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
}
function harness(sheet = new Sheet([['operation_id', 'action', 'created_at', 'response_json', 'payload_hash']])) {
  const properties = new Map();
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algo, text) => [...createHash('sha256').update(text).digest()], formatDate: () => '2026-09-05' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: content => ({ getContent: () => content, setMimeType() { return this; } }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
  });
  vm.runInContext(gas, ctx);
  return { ctx, sheet };
}
const result = response => JSON.parse(response.getContent());
test('受付IDと内容一致は再処理せず、異なるactionやpayloadを拒否する', () => {
  const { ctx, sheet } = harness(); let writes = 0;
  const handler = () => { writes++; return ctx.jsonOk_({ row: 4 }); };
  const a = { operation_id: 'op1', action: 'addMemo', value: 1, auth_token: 'not-a-real-key' };
  assert.equal(result(ctx.executeMutation_('addMemo', a, handler)).success, true);
  assert.equal(result(ctx.executeMutation_('addMemo', { value: 1, action: 'addMemo', operation_id: 'op1', auth_token: 'rotated-placeholder' }, handler)).success, true);
  assert.match(result(ctx.executeMutation_('addMemo', { ...a, value: 2 }, handler)).error, /CONFLICT/);
  assert.match(result(ctx.executeMutation_('addPurchase', a, handler)).error, /CONFLICT/);
  assert.equal(writes, 1); assert.equal(sheet.rows.length, 2);
});
test('実処理後の応答記録失敗はunknownを維持し、再送しても二重追加しない', () => {
  const { ctx, sheet } = harness(); let writes = 0;
  sheet.failResponse = true;
  const body = { operation_id: 'op-uncertain' };
  const handler = () => { writes++; return ctx.jsonOk_({ saved: true }); };
  assert.match(result(ctx.executeMutation_('addMemo', body, handler)).error, /OUTCOME_UNKNOWN/);
  assert.match(result(ctx.executeMutation_('addMemo', body, handler)).error, /OUTCOME_UNKNOWN/);
  assert.equal(writes, 1);
});
test('受付先行保存が失敗したら実処理ゼロ、受付ID必須、古い受付も削除しない', () => {
  const { ctx, sheet } = harness(); let writes = 0;
  const handler = () => { writes++; return ctx.jsonOk_({}); };
  sheet.failAppend = true;
  assert.equal(result(ctx.executeMutation_('addMemo', { operation_id: 'x' }, handler)).success, false);
  assert.match(result(ctx.executeMutation_('addMemo', {}, handler)).error, /ID_REQUIRED/);
  assert.equal(writes, 0);
  sheet.failAppend = false;
  for (let i = 0; i < 1001; i++) sheet.rows.push(['old-' + i, 'old', '', '{}', '']);
  ctx.executeMutation_('addMemo', { operation_id: 'new' }, handler);
  assert.equal(sheet.rows.length, 1003);
  assert.equal(sheet.rows[1][0], 'old-0');
});
function inventory() {
  const rows = [[], [], []]; rows[2][81] = '在庫UUID';
  for (let i = 0; i < 2; i++) {
    const row = []; row[6] = '2026-09-05'; row[8] = '商品' + i; row[11] = ''; row[12] = 1000;
    row[81] = `inv_00000000-0000-4000-8000-00000000000${i}`; rows.push(row);
  }
  return new Sheet(rows);
}
test('店舗更新は行番号でなくUUID、全件事前検証、変更前の店名を比較', () => {
  const sheet = inventory(); const { ctx } = harness(sheet);
  const item = { row: 999, inventory_uuid: sheet.rows[3][81], expected_shop: '', expected_date: '2026-09-05', shop: '店舗A' };
  assert.equal(result(ctx.updateInventoryShop_(item)).data.items[0].row, 4);
  assert.equal(sheet.rows[3][11], '店舗A');
  assert.throws(() => ctx.updateInventoryShop_(item), /INVENTORY_CHANGED/);
  const before = sheet.writes;
  assert.throws(() => ctx.bulkUpdateInventoryShop_({ items: [{ ...item, expected_shop: '店舗A' }, { ...item, inventory_uuid: sheet.rows[4][81], expected_shop: 'wrong' }] }), /INVENTORY_CHANGED/);
  assert.equal(sheet.writes, before);
  assert.throws(() => ctx.updateInventoryShop_({ row: 4, shop: '店舗B' }), /REFRESH_REQUIRED/);
});
test('在庫読み込み失敗を空集計に置き換えない・4行目を取得する', () => {
  const sheet = inventory(); const { ctx } = harness(sheet);
  assert.equal(result(ctx.getInventoryPurchases_({})).data[0].inventory_uuid, sheet.rows[3][81]);
  ctx.getInventorySheet_ = () => { throw Error('permission denied'); };
  assert.throws(() => ctx.aggregateInventoryByStore_([], ''), /INVENTORY_READ_FAILED/);
});
test('未確定の店舗は表示だけで書き戻さず、結果不明を再送待ちに残す', () => {
  assert.doesNotMatch(app, /店舗の自動紐付け/);
  assert.match(app, /candidates.length >= 1 && !it.shop/);
  assert.match(app, /expected_shop: item.shop/);
  assert.match(api, /error.name === 'TypeError'/);
  assert.match(api, /OPERATION_OUTCOME_UNKNOWN/);
  assert.match(storage, /last_error_code === 'OPERATION_OUTCOME_UNKNOWN'/);
});
