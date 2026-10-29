/* Presentation-only consolidation. Every original condition and source is retained. */
const GuideOrganize = (() => {
  'use strict';
  const norm = value => value.normalize('NFKC').toLowerCase().replace(/[\s・._-]/g,'');
  const rules = [
    {genre:'ベビー用品',subgenre:'登山用ベビーキャリア',labels:['純正レインカバー','レインカバー付き'],label:'レインカバー付き',
      explanation:'キャリアに対応するレインカバー付き',checks:['純正タグ・対応モデル','サイズと固定部','破れ・防水部の劣化']},
    {genre:'オーディオ機器',subgenre:'コンポ',labels:['WOOD CONE表記','木製の振動板'],label:'木製振動板',
      explanation:'スピーカーの木製振動板。目印は「WOOD CONE」表記',checks:['WOOD CONE表記・材質仕様','ネット内側の振動板','左右の破れ・傷み']},
    {genre:'ホビー',subgenre:'クレーンゲーム',labels:['キャラクターコラボ','キャラクター仕様'],label:'キャラクター仕様',
      explanation:'箱・本体の作品名と専用デザイン',checks:['作品名・キャラクター名','通常版とのデザイン違い','専用景品・操作部']},
    {genre:'パソコン・周辺機器',subgenre:'プリンター',labels:['前面液晶','前面の大型液晶'],label:'前面液晶'},
    {genre:'生活家電',subgenre:'オーブンレンジ',labels:['モニター付き（Bistro）','液晶画面'],label:'液晶画面'},
    {genre:'バッグ',subgenre:'登山用リュック',labels:['大容量','60L以上'],label:'大容量'},
    {genre:'ホビー',subgenre:'戦隊玩具',labels:['古い年代','1990〜2000年代'],label:'当時物・旧年代'}
  ];
  const dimensions = [
    ['素材・つくり',['material']],['機能・仕様',['function','specification']],
    ['年代・世代',['generation']],['専用装備',['accessories']],['状態',['condition']]
  ];
  function unique(xs,key=x=>x){return xs.filter((x,i)=>xs.findIndex(y=>key(y)===key(x))===i);}
  function factors(items) {
    const groups=new Map();
    for(const f of items){
      const rule=rules.find(r=>r.genre===f.genre&&r.subgenre===f.subgenre&&r.labels.includes(f.label));
      const label=rule?.label||f.label,key=JSON.stringify([f.genre,f.middle,f.subgenre,norm(label)]);
      if(!groups.has(key))groups.set(key,{...f,label,variants:[],sourceIds:[],evidence:[],records:[],summaryRule:rule});
      const g=groups.get(key);g.variants.push(f);g.confirmed=g.variants.every(x=>x.confirmed);
      g.sourceIds=unique([...g.sourceIds,...f.sourceIds]);g.evidence=unique([...g.evidence,...f.evidence],e=>JSON.stringify([e.label,e.url]));
      g.records=unique([...g.records,...(f.records||[])],p=>p.id);
    }
    return [...groups.values()].map(g=>{const r=g.summaryRule;if(r?.explanation&&r.labels.every(label=>g.variants.some(f=>f.label===label)))return {...g,explanation:r.explanation,checks:r.checks,sharedSummary:true};return g;});
  }
  function sections(items){return dimensions.map(([label,ds])=>({label,items:items.filter(f=>ds.includes(f.dimension))})).filter(s=>s.items.length);}
  // Cosmetic spelling only; never merge different sub-brands or infer identity.
  function brands(records){
    const groups=new Map();
    for(const p of records){if(!p.brand||p.brand.includes('未確認'))continue;const key=norm(p.brand);if(!groups.has(key))groups.set(key,{name:p.brand,names:[],count:0});const g=groups.get(key);g.names=unique([...g.names,p.brand]);g.count++;}
    return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  }
  return {factors,sections,brands};
})();
