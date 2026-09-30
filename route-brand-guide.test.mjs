import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('./brand-guide.js', import.meta.url), 'utf8');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function harness(options = {}) {
  let durable = options.old ? structuredClone(options.old) : null;
  let closes = 0;
  const fake = {
    open(name) {
      assert.equal(name, 'sedori-private-brand-guide');
      const req = {};
      const db = { close() { closes++; }, transaction() {
        let draft = structuredClone(durable); let finished = false; let timer;
        const tx = { error: null, abort() { if (finished) return; finished = true; clearTimeout(timer); queueMicrotask(() => tx.onabort?.()); } };
        function finish() {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (finished) return;
            if (options.abort) { tx.error = new Error('transaction aborted'); tx.abort(); return; }
            finished = true; durable = draft; tx.oncomplete?.();
          }, 0);
        }
        tx.objectStore = () => ({
          get(key) {
            assert.equal(key, 'active'); const r = {};
            queueMicrotask(() => { if (finished) return; r.result = structuredClone(draft); r.onsuccess?.({ target: r }); finish(); }); return r;
          },
          put(value, key) {
            assert.equal(key, 'active');
            if (options.quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
            draft = structuredClone(value); if (options.mismatch) draft.sha = 'wrong';
            const r = {}; queueMicrotask(() => { if (!finished) { r.onsuccess?.(); finish(); } }); return r;
          },
        });
        return tx;
      } };
      queueMicrotask(() => {
        if (options.blocked) { req.onblocked?.(); req.result = db; req.onsuccess?.(); }
        else { req.result = db; req.onsuccess?.(); }
      });
      return req;
    },
  };
  const context = { module: { exports: {} }, URL, TextEncoder, Uint8Array, crypto: webcrypto, indexedDB: fake, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return { guide: context.module.exports, durable: () => durable, closes: () => closes };
}
function fixture() {
  return {
    version: 1, updatedAt: '2026-09-13',
    brands: Array.from({ length: 30 }, (_, i) => ({ id: `brand-${i}`, name: `Brand ${i}`, aliases: ['バトナー', 'BATONER'],
      groups: [{ period: '2024年', photos: [{ image: 'data:image/jpeg;base64,/9j/2Q==', source: 'https://example.org/photo', basis: '掲載年', currentOfficial: false }] }],
      method: { code: 'TEST', highlight: '', result: '不明', how: '検索', caution: '未確認', mode: '検索' },
      sources: [{ title: 'source', url: 'https://example.org' }],
    })),
    baycrews: { title: 'test', how: 'test', caution: 'test', confirmed: Array(5).fill('a'), unconfirmed: Array(15).fill('b'), examples: Array(2).fill({ brand: 'a', code: '24', year: '2024', url: 'https://example.org' }), source: 'https://example.org' },
  };
}
function envelope(data) {
  const payload = JSON.stringify(data);
  return JSON.stringify({ format: 'private-brand-guide', schemaVersion: 1, payload, sha256: createHash('sha256').update(payload).digest('hex') });
}
test('30-brand package passes checksum and preserves text', async () => {
  const { guide } = harness(); const data = fixture(); const parsed = await guide.parsePackage(envelope(data));
  assert.equal(JSON.stringify(parsed.data), JSON.stringify(data));
  assert.equal(guide.validate(parsed.data).photos, 30);
});
test('Japanese/English, hiragana/katakana and full-width search', () => {
  const { guide } = harness(); const b = fixture().brands[0];
  for (const q of ['バトナー', 'ばとなー', 'ﾊﾞﾄﾅｰ', 'ＢＡＴＯＮＥＲ', 'batoner', 'Brand 0']) assert.equal(guide.matches(b, q), true);
  assert.equal(guide.matches(b, 'nothing'), false);
});
test('changed bytes and invalid JSON cannot replace saved data', async () => {
  const { guide } = harness();
  await assert.rejects(guide.parsePackage(envelope(fixture()).replace('掲載年', '購入年')), /壊れ/);
  await assert.rejects(guide.parsePackage('{'), /読めません/);
});
for (const [name, change] of [
  ['wrong schema', d => d.version = 2],
  ['non-string date', d => d.updatedAt = ['2026-09-13']],
  ['impossible date', d => d.updatedAt = '2026-02-31'],
  ['empty library', d => d.brands = []],
  ['duplicate id', d => d.brands[1].id = d.brands[0].id],
  ['duplicate brand', d => d.brands[1].name = d.brands[0].name],
  ['remote photo', d => d.brands[0].groups[0].photos[0].image = 'https://example.org/a.jpg'],
  ['SVG photo', d => d.brands[0].groups[0].photos[0].image = 'data:image/svg+xml;base64,PHN2Zz4='],
  ['script link', d => d.brands[0].sources[0].url = 'javascript:alert(1)'],
  ['local-file source', d => d.brands[0].groups[0].photos[0].source = 'file:///Users/private'],
  ['credential URL', d => d.brands[0].sources[0].url = 'https://password@example.org'],
  ['missing caution', d => delete d.brands[0].method.caution],
  ['missing appendix', d => delete d.baycrews],
]) test(`reject ${name}`, async () => {
  const { guide } = harness(); const data = fixture(); change(data); await assert.rejects(guide.parsePackage(envelope(data)));
});
test('file size limit is enforced before file reading', async () => {
  const { guide } = harness(); await assert.rejects(guide.importFile({ size: 41*1024*1024, text() { assert.fail('must not read'); } }), /40MB/);
});
test('successful transaction persists and closes database', async () => {
  const h = harness(); const record = { data: fixture(), sha: 'new' }; await h.guide.save(record);
  assert.equal(h.durable().sha, 'new'); assert.equal((await h.guide.load()).sha, 'new'); assert.equal(h.closes(), 2);
});
for (const mode of ['abort', 'quota', 'mismatch']) test(`${mode} retains previously saved library`, async () => {
  const old = { data: fixture(), sha: 'old' }; const h = harness({ old, [mode]: true });
  await assert.rejects(h.guide.save({ data: fixture(), sha: 'new' }));
  assert.equal(h.durable().sha, 'old'); assert.equal(h.closes(), 1);
});
test('older package cannot downgrade library in another tab', async () => {
  const old = { data: fixture(), sha: 'old' }; const h = harness({ old }); const next = fixture(); next.updatedAt = '2026-09-12';
  await assert.rejects(h.guide.save({ data: next, sha: 'older' }), /古い/); assert.equal(h.durable().sha, 'old');
});
test('blocked open closes late connection and does not change data', async () => {
  const h = harness({ blocked: true }); await assert.rejects(h.guide.load(), /他のタブ/); assert.equal(h.closes(), 1);
});
test('public viewer has no network/upload, inventory DB, HTML injection or bundled pictures', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|innerHTML|Storage\.|API\.|data:image\/jpeg;base64,\/9/);
  assert.match(source, /textContent/); assert.match(source, /referrerPolicy = 'no-referrer'/);
  for (const file of ['brand-guide.js', 'brand-guide.css']) {
    assert.ok(read('sw.js').includes(`./${file}?v=`)); assert.ok(read('index.html').includes(`${file}?v=`));
  }
  assert.doesNotMatch(read('app.js'), /btn-brand-guide/);
  assert.match(read('index.html'), /data-view="brand-guide"/);
  assert.match(read('app.js'), /if \(Router.getCurrentView\(\) === 'brand-guide'\) return/);
  assert.match(read('router.js'), /'brand-guide': 'brand-guide'/);
});
test('direct guide startup never opens inventory API or synchronizes pending writes', async () => {
  const app = read('app.js');
  const start = app.indexOf('async function init()');
  const end = app.indexOf('\n  async function loadData()', start);
  const routes = new Map(); let redirected = '';
  const context = {
    window: { location: { hash: '#brand-guide', replace: value => { redirected = value; } } },
    document: { getElementById: () => null },
    Router: { register: (name, fn) => routes.set(name, fn), navigate: name => routes.get(name)({}) },
    setTitle() {},
    setupNav() { assert.fail('business UI init must not run'); }, registerViews() { assert.fail('business route init must not run'); },
    API: new Proxy({}, { get() { assert.fail('API must not be accessed'); } }),
    Storage: new Proxy({}, { get() { assert.fail('inventory storage must not be accessed'); } }),
  };
  vm.runInNewContext(app.slice(start, end) + '\nthis.run = init;', context);
  await context.run(); assert.equal(redirected, 'brand-guide.html');
});
test('standalone guide excludes inventory scripts and prohibits remote connections', () => {
  const html = read('brand-guide.html');
  assert.doesNotMatch(html, /src="(?:storage|api|app|quiz|amazon-pricing)\.js/);
  assert.match(html, /connect-src 'self' https:\/\/script.google.com/);
  assert.match(html, /img-src 'self' data: blob:;/);
  assert.match(html, /brand-guide-entry\.js/);
  assert.match(html, /brand-guide-sync\.js/);
});

test('future additions accept 31 brands and expanded appendix', async () => {
  const { guide } = harness(); const data = fixture();
  const extra = structuredClone(data.brands[0]); extra.id = 'new-brand'; extra.name = 'NEW BRAND'; data.brands.push(extra);
  data.baycrews.confirmed.push('NEW BRAND'); data.baycrews.examples.push(structuredClone(data.baycrews.examples[0]));
  const record = await guide.parsePackage(envelope(data)); assert.equal(record.data.brands.length, 31);
});


test('source-backed research-only brands require explicit missing-photo status', async () => {
  const { guide } = harness(); const data = fixture();
  data.brands[0].groups = [];
  await assert.rejects(guide.parsePackage(envelope(data)));
  data.brands[0].photoStatus = 'uncollected';
  const parsed = await guide.parsePackage(envelope(data));
  assert.equal(guide.validate(parsed.data).photos, 29);
  data.brands[0].sources = [];
  await assert.rejects(guide.parsePackage(envelope(data)));
});

test('family overview accepts a source-only page and keeps line links within the guide', async () => {
  const { guide } = harness(); const data = fixture(); const brand = data.brands[0];
  brand.groups = []; brand.photoStatus = 'uncollected';
  brand.overview = { intro: '系列の案内', note: '開始年は製造年ではありません',
    lines: [{ name: 'Polo Ralph Lauren', detail: '別ページでタグを見る' }],
    milestones: [{ year: '1993', detail: 'Double RL開始' }],
    steps: ['首元のライン名を読む'], relatedBrand: 'Brand 1' };
  assert.equal(guide.validate((await guide.parsePackage(envelope(data))).data).photos, 29);
  brand.overview.relatedBrand = 'Missing brand';
  await assert.rejects(guide.parsePackage(envelope(data)));
  brand.overview.relatedBrand = 'Brand 1'; brand.overview.milestones[0].year = '19xx';
  await assert.rejects(guide.parsePackage(envelope(data)));
});

test('family line pages link to their parent and do not inflate the top-level brand count', async () => {
  const { guide } = harness(); const data = fixture();
  const family = data.brands[0], child = data.brands[1];
  family.overview = { intro: '系列案内', note: '製造年ではありません',
    lines: [{ name: child.name, detail: 'タグを見る', targetBrand: child.name }],
    milestones: [], steps: ['タグを確認'] };
  child.parentBrand = family.name;
  assert.equal(guide.validate(data).brands, 29);
  assert.equal(guide.validate(data).photos, 30);
  family.overview.lines[0].targetBrand = '別ブランド';
  await assert.rejects(guide.parsePackage(envelope(data)));
  family.overview.lines[0].targetBrand = child.name;
  child.parentBrand = 'Missing parent';
  await assert.rejects(guide.parsePackage(envelope(data)));
});


test('tag timeline displays years and observed ranges without seasons or provenance labels', () => {
  const { guide } = harness();
  for (const [input, expected] of [
    ['2026年秋・公式掲載例', '2026年'],
    ['2011年3月の記事で確認（同品番）', '2011年'],
    ['2026年・2023年の掲載例', '2023〜2026年'],
    ['2023〜2026年', '2023〜2026年'],
    ['17AW出品者表記・2024年中古記事・2026年公式掲載例', '2017〜2026年'],
    ['1990年代の公式掲載例', '1990年代'],
    ['1970年代後半〜1980年代初めの目安：青タグ', '1970〜1980年代'],
    ['年代未確認｜白いタグ', '年代不明'],
  ]) assert.equal(guide.tagPeriod(input).label, expected);
});

test('tag timeline is oldest first, stable within a year, unknown photos excluded, without altering evidence', () => {
  const { guide } = harness();
  const groups = ['2026年秋', '年代未確認', '2023年春夏', '2023年秋冬', '2011〜2014年']
    .map((period, id) => ({ period, id, photos: [{ basis: 'original source' }] }));
  const before = JSON.stringify(groups);
  const ordered = guide.tagTimeline(groups);
  assert.equal(ordered.map(g => g.id).join(','), '4,2,3,0');
  assert.equal(JSON.stringify(groups), before);
  assert.equal(ordered[0].photos, groups[4].photos);
});

test('right swipe returns only for a deliberate horizontal single gesture', () => {
  const { guide } = harness(); const start = { x: 20, y: 100, time: 100 };
  assert.equal(guide.isBackSwipe(start, { x: 140, y: 115, time: 500 }), true);
  for (const end of [
    { x: -100, y: 100, time: 500 }, // left swipe
    { x: 60, y: 100, time: 500 }, // tap / small movement
    { x: 140, y: 250, time: 500 }, // vertical scroll
    { x: 140, y: 100, time: 15000 }, // stale gesture
    { x: 140, y: 100, time: 50 },
  ]) assert.equal(guide.isBackSwipe(start, end), false);
  assert.equal(guide.isBackSwipe(null, { x: 140, y: 100, time: 500 }), false);
});

test('optional quick guide rejects misplaced highlights and oversized tables; old packages remain valid', async () => {
  const { guide } = harness(); const data = fixture();
  const q = { target: '品番', reading: '検索', result: '年代不明', note: '', highlight: 'ES', start: 1, rows: [['24', '2024年']] };
  data.brands[0].method.quickGuide = q;
  await guide.parsePackage(envelope(data));
  q.start = 0; await assert.rejects(guide.parsePackage(envelope(data)));
  q.start = 1; q.rows = Array(41).fill(['24','2024年']); await assert.rejects(guide.parsePackage(envelope(data)));
  delete data.brands[0].method.quickGuide; await guide.parsePackage(envelope(data));
});

test('a reverse-side example must point to a recorded source for that brand', async () => {
  const { guide } = harness(); const data = fixture();
  const q = { target: '品質表示タグ', reading: '表と裏を比べる', result: '', note: '',
    highlight: '', start: -1, rows: [], reverseCode: '22-08', reverseSource: 'https://example.org' };
  data.brands[0].method.quickGuide = q;
  await guide.parsePackage(envelope(data));
  q.reverseSource = 'https://unrelated.example.org';
  await assert.rejects(guide.parsePackage(envelope(data)));
});

test('dated listings and search instructions do not become dating rules', () => {
  const { guide } = harness(); const b = fixture().brands[0];
  b.method.quickGuide = { siteText: '公式の2026年ページにあります', inferenceText: '型番をネットで検索します', result: '2026年', rows: [] };
  let view = guide.modelExplanation(b);
  assert.equal(view.siteText, ''); assert.equal(view.result, '');
  assert.equal(view.inferenceText, '分かりません');
  b.method.quickGuide.canInferYear = false;
  assert.equal(guide.modelExplanation(b).inferenceText, '分かりません');
});

test('an identified analytical source and supported year rule remain distinct', () => {
  const { guide } = harness(); const b = fixture().brands[0];
  b.method.quickGuide = { siteSource: 'https://example.org', siteText: '先頭2桁を発売年として読む解説', canInferYear: true, inferenceText: '24から2024年が候補です', result: '2024年', rows: [['24','2024年']] };
  let view = guide.modelExplanation(b);
  assert.equal(view.siteText, '先頭2桁を発売年として読む解説');
  assert.equal(view.inferenceText, '24から2024年が候補です');
  b.method.quickGuide.siteSource = 'https://unmatched.example.org';
  assert.equal(guide.modelExplanation(b).siteText, '');
  assert.match(source, /'AI推測'/);
  assert.doesNotMatch(source, /'この図鑑での推測'/);
});
