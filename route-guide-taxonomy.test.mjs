import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context={};
vm.runInNewContext(readFileSync(new URL('brand-guide/taxonomy.js',import.meta.url),'utf8')+';this.taxonomy=GuideTaxonomy;',context);
const tax=context.taxonomy;

test('camera aliases share one category without changing stored records or references',()=>{
  const original=[{id:'a',genre:'カメラ',subgenre:'デジタル一眼レフ',evidence:[{url:'https://example.com/a'}]},{id:'b',genre:'カメラ・撮影機材',subgenre:'デジタル一眼レフ',evidence:[{url:'https://example.com/b'}]}];
  const before=JSON.stringify(original),projected=original.map(p=>tax.project(p,p.subgenre));
  assert.deepEqual([...new Set(projected.map(p=>p.genre))],['カメラ']);
  assert.deepEqual([...new Set(projected.map(p=>p.middle))],['デジタルカメラ']);
  const factors=tax.factors([{genre:'カメラ・撮影機材',subgenre:'デジタル一眼レフ',sourceIds:['a','b'],evidence:original[0].evidence}],projected);
  assert.deepEqual(Array.from(factors.flatMap(f=>f.sourceIds)),['a','b']);
  assert.equal(JSON.stringify(original),before);
});

test('specific leaves map to useful groups rather than a catch-all',()=>{
  const cases=[
    ['ベビー用品','ベビーモニター','安全用品'],['生活家電','洗濯機','掃除・洗濯'],['生活家電','エアコン','冷暖房'],
    ['楽器','クラシックギター','ギター・ベース'],['楽器','譜面台','ケース・周辺用品'],['楽器','箏','その他弦楽器'],
    ['スポーツ','釣り竿','釣り・マリン'],['スポーツ','卓球ラケット','ラケット競技'],['スポーツ','キーパーグローブ','球技'],
    ['キッチン用品','包丁','調理器具'],['キッチン用品','洋食器','食器・カトラリー'],['キッチン用品','グラス','カップ・グラス'],
    ['パソコン・周辺機器','ミニPC','パソコン本体'],['パソコン・周辺機器','ルーター','ネットワーク'],
    ['カメラ','レンズ','レンズ'],['カメラ・撮影機材','デジタル一眼レフ','デジタルカメラ'],['カメラ','三脚・一脚','撮影機材'],
    ['ホビー','ボードゲーム','カード・卓上遊び'],['アウトドア','寝袋','テント・寝具'],['骨董・美術品','古文書','書画・古文書']
  ];
  for(const [genre,leaf,middle] of cases)assert.equal(tax.classify(genre,leaf).middle,middle,genre+' / '+leaf);
});

test('display moves preserve each factor source exactly and unknown future categories remain accessible',()=>{
  const rows=[{id:'portable',genre:'生活家電',subgenre:'ポータブルプレーヤー'},{id:'vinyl',genre:'映像ソフト',subgenre:'レコード'}];
  const projected=rows.map(p=>tax.project(p,p.subgenre));
  assert.ok(projected.every(p=>p.genre==='オーディオ機器'));
  const factor={id:'trait',sourceIds:rows.map(p=>p.id)};
  assert.deepEqual(Array.from(tax.factors([factor],projected).flatMap(f=>f.sourceIds)),factor.sourceIds);
  const future=tax.project({id:'future',genre:'新しいジャンル'},'新しい種類');
  assert.equal(future.middle,'その他');assert.deepEqual(Array.from(tax.leaves([future],future.genre,future.middle)),['新しい種類']);
  assert.equal(tax.classify('__proto__','constructor').subgenre,'constructor');
});
