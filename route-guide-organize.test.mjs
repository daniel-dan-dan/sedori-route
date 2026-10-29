import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const c={};vm.runInNewContext(readFileSync(new URL('brand-guide/organize.js',import.meta.url),'utf8')+';this.org=GuideOrganize;',c);const o=c.org;
const mk=(label,id,patch={})=>({id,genre:'パソコン・周辺機器',middle:'プリンター・消耗品',subgenre:'プリンター',label,dimension:'specification',confirmed:true,explanation:'condition '+id,checks:['check '+id],sourceIds:[id],evidence:[{label:id,url:'https://www.youtube.com/watch?v='+id}],records:[{id}],...patch});
test('overlapping LCD headings consolidate while every manufacturer and size condition remains scoped',()=>{
 const a=mk('前面液晶','a',{explanation:'EPSONのジャンク複合機にある前面液晶'}),b=mk('前面の大型液晶','b',{explanation:'操作部の大きな液晶'}),input=[a,b],before=JSON.stringify(input),g=o.factors(input);
 assert.equal(g.length,1);assert.equal(g[0].variants.length,2);assert.equal(g[0].variants[0].explanation,a.explanation);assert.equal(g[0].variants[1].explanation,b.explanation);assert.equal(g[0].evidence.length,2);assert.equal(JSON.stringify(input),before);assert.equal(g[0].sharedSummary,undefined);
});
test('shared concise advice requires both supporting variants and preserves the original checks and evidence',()=>{
 const patch={genre:'オーディオ機器',middle:'再生機器',subgenre:'コンポ',dimension:'material'};
 const a=mk('WOOD CONE表記','a',patch),b=mk('木製の振動板','b',patch);assert.equal(o.factors([a])[0].sharedSummary,undefined);
 const g=o.factors([a,b])[0];assert.equal(g.label,'木製振動板');assert.equal(g.sharedSummary,true);assert.equal(g.variants[0],a);assert.equal(g.variants[1],b);assert.equal(g.sourceIds.length,2);
});
test('lookalike terms and different genres remain distinct; uncertain variants never become confirmed',()=>{
 const input=[mk('背面ボタン','a'),mk('背面パドル','b'),mk('前面液晶','c'),mk('前面の大型液晶','d',{confirmed:false}),mk('前面液晶','e',{genre:'別ジャンル'})];const g=o.factors(input);assert.equal(g.length,4);assert.equal(g.find(x=>x.variants.length===2).confirmed,false);assert.equal(g.find(x=>x.id==='e').sourceIds[0],'e');
});
test('same displayed label collects evidence without deduplicating different conditions',()=>{
 const a=mk('限定色','a'),b=mk('限定色','b');const g=o.factors([a,b]);assert.equal(g.length,1);assert.equal(g[0].variants.length,2);assert.equal(g[0].evidence.length,2);assert.equal(g[0].records.length,2);
});
test('factor sections retain all items and do not infer new factors',()=>{
 const input=['material','function','generation','condition','accessories','specification'].map((dimension,i)=>mk('項目'+i,''+i,{dimension}));const groups=o.sections(input);assert.equal(groups.flatMap(s=>s.items).length,6);assert.equal(o.sections([]).length,0);
});
test('brands only merge typography variants, retaining sub-brands and omitting unknown names',()=>{
 const g=o.brands([{brand:'Aprica'},{brand:'ＡＰＲＩＣＡ'},{brand:'POLO'},{brand:'POLO SPORT'},{brand:'ブランド未確認'}]);assert.equal(g.length,3);assert.equal(g.find(x=>x.name==='Aprica').count,2);assert.equal(g.find(x=>x.name==='Aprica').names.length,2);
});
