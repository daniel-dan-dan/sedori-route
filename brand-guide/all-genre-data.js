/* Shared private-record validation; no DOM, network, or storage access. */
const AllGenreData = (() => {
  'use strict';
  const SUBGENRES = {
    'ベビー用品':['ベビーカー','抱っこ紐','チャイルドシート','ジュニアシート','ベビーチェア','スイング','ベビーベッド','バウンサー'],
    '生活家電':['炊飯器','電気ポット','コーヒーマシン','空気清浄機','掃除機','冷暖房','除湿機','ミシン'],
    'スポーツ':['グローブ','ゴルフ','その他スポーツ'],
    '楽器':['電子ドラム','鍵盤楽器','管楽器','弦楽器','その他楽器'],
    'スキー・スノーボード':['スキーブーツ','スキー板','スノーボード','スノーボードブーツ']
  };
  const RULES = [
    ['ベビーカー',/ベビーカー|stroller/i],['抱っこ紐',/抱っこ|抱っこひも|キャリア/i],
    ['ジュニアシート',/ジュニアシート/],['チャイルドシート',/チャイルドシート|クルリラ|フォームフィット/],['ベビーチェア',/ベビーチェア|トリップトラップ|マテルナ/],
    ['スイング',/スイング|ネムリラ/],['ベビーベッド',/ベビーベッド|ココネル/],['バウンサー',/バウンサー|Bliss Air|Wuggy/i],
    ['スノーボードブーツ',/スノーボード.*ブーツ/],['スキーブーツ',/スキー.*ブーツ/],['スキー板',/スキー板/],['スノーボード',/スノーボード/],
    ['炊飯器',/炊飯器/],['電気ポット',/電気ポット|電気ケトル/],['コーヒーマシン',/コーヒー|エスプレッソ/],
    ['空気清浄機',/空気清浄/],['掃除機',/掃除機|クリーナー/],['除湿機',/除湿/],['ミシン',/ミシン/],['冷暖房',/ファン|クーラー|ヒーター|エアコン/],
    ['グローブ',/グローブ/],['ゴルフ',/ゴルフ/],['電子ドラム',/電子ドラム/],['鍵盤楽器',/ピアノ|キーボード|補助ペダル/],
    ['管楽器',/サックス|フルート|トランペット/],['弦楽器',/バイオリン|ギター|大正琴/]
  ];
  function subgenre(p) {
    if (typeof p.subgenre==='string' && p.subgenre.trim()) return p.subgenre.trim();
    const text=[p.name,p.model].join(' '), allowed=Object.hasOwn(SUBGENRES,p.genre) ? SUBGENRES[p.genre] : [];
    return RULES.find(([label,re])=>allowed.includes(label) && re.test(text))?.[0] || 'その他';
  }
  function readGuides(value) {
    if(value===undefined)return [];
    const str=(x,max)=>typeof x==='string' && x.length<=max;
    const strings=(xs,max,count)=>Array.isArray(xs)&&xs.length<=count&&xs.every(x=>str(x,max));
    const url=x=>{try{const u=new URL(x);return u.protocol==='https:' && ['www.youtube.com','youtube.com','youtu.be'].includes(u.hostname) && !u.username && !u.password;}catch{return false;}};
    if(!Array.isArray(value)||value.length>200)throw new Error('Invalid learning records');
    const ids=new Set();
    for(const g of value){
      if(!g || !['name','brand','genre','subgenre','model'].every(k=>str(g[k],1500)) || !str(g.id,100) || !g.id || ids.has(g.id) || !g.name || !g.genre || !g.subgenre || !g.brand ||
        !Array.isArray(g.features) || g.features.length>3 || !g.features.every(f=>f&&str(f.label,80)&&typeof f.confirmed==='boolean'&&str(f.note,3000)) ||
        !strings(g.checks,1000,3) || !strings(g.notes,3000,40) || !Array.isArray(g.evidence) || g.evidence.length<1 || g.evidence.length>30 || !g.evidence.every(e=>e&&str(e.label,1000)&&url(e.url)))throw new Error('Invalid learning record');
      ids.add(g.id);
      if(g.quick!==undefined){
        const q=g.quick;
        if(!q || !str(q.name,100) || !q.name || !str(q.clue,120) || !str(q.check,100) ||
          !Array.isArray(q.points) || q.points.length>3 || !q.points.every(p=>p&&str(p.text,60)&&p.text&&typeof p.confirmed==='boolean') ||
          !strings(q.cautions,80,3))throw new Error('Invalid quick guide');
      }
    }
    return value.map(g=>({...g,guide:true}));
  }
  function readValueFactors(value,records,maxItems=4000) {
    if(value===undefined)return [];
    const text=(x,max)=>typeof x==='string'&&x.trim()&&x.length<=max;
    const rows=new Map(records.map(p=>[p.id,p])),ids=new Set(),keys=new Set();
    const dimensions=['material','function','generation','condition','accessories','specification'];
    const url=x=>{try{const u=new URL(x);return u.protocol==='https:'&&['www.youtube.com','youtube.com','youtu.be'].includes(u.hostname)&&!u.username&&!u.password;}catch{return false;}};
    if(!value||value.version!==1||!text(value.reviewedAt,100)||!Array.isArray(value.items)||value.items.length>maxItems)throw new Error('Invalid reviewed factors');
    for(const f of value.items){
      if(!f||!text(f.id,100)||ids.has(f.id)||!text(f.genre,100)||!text(f.subgenre,100)||!text(f.label,60)||
        !dimensions.includes(f.dimension)||f.generalizable!==true||typeof f.confirmed!=='boolean'||!text(f.explanation,1500)||
        !Array.isArray(f.checks)||f.checks.length>3||!f.checks.every(x=>text(x,300))||
        !Array.isArray(f.sourceIds)||!f.sourceIds.length||f.sourceIds.length>30||!f.sourceIds.every(id=>rows.has(id)&&rows.get(id).genre===f.genre&&subgenre(rows.get(id))===f.subgenre)||
        !Array.isArray(f.evidence)||!f.evidence.length||f.evidence.length>30||!f.evidence.every(e=>e&&text(e.label,1000)&&url(e.url)&&f.sourceIds.some(id=>rows.get(id).evidence.some(x=>x.url===e.url))))throw new Error('Invalid reviewed factor');
      const key=JSON.stringify([f.genre,f.subgenre,f.label]);if(keys.has(key))throw new Error('Duplicate reviewed factor');ids.add(f.id);keys.add(key);
    }
    return value.items;
  }
  return {subgenre,readGuides,readValueFactors};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = AllGenreData;
