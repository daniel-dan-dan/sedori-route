import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const mapSource = source.slice(source.indexOf('  const BASE_MAP_URL ='), source.indexOf('  function initMap()'));
function harness(key = '') {
  const status = { hidden: true, textContent: '' }, layers = [], maps = [];
  const config = { carto_basemap_key: key };
  const ctx = vm.createContext({config, document:{getElementById:()=>status}, L:{tileLayer(url,options) {
    const layer = {url,options,events:{}, on(name,fn){this.events[name]=fn;}, addTo(map){this.map=map;}};
    layers.push(layer); return layer;
  }}});
  vm.runInContext(mapSource+'\nglobalThis.subject={addBaseMap_,refreshBaseMaps_};',ctx);
  const addMap = () => {
    const map = {events:{},removed:[],on(name,fn){this.events[name]=fn;},removeLayer(layer){this.removed.push(layer);}};
    maps.push(map); ctx.subject.addBaseMap_(map,'status'); return map;
  };
  return {status,layers,maps,config,addMap,refresh:ctx.subject.refreshBaseMaps_};
}
test('CARTO Voyager uses an encoded issued key with required attribution, no provider fallback',()=>{
  const h=harness('fixture&key=not-real');h.addMap();
  assert.match(h.layers[0].url,/\/voyager\/\{z\}\/\{x\}\/\{y\}\.png\?key=fixture%26key%3Dnot-real$/);
  assert.equal(h.layers[0].options.subdomains,'abcd');
  assert.equal(h.layers[0].options.maxZoom,19);
  assert.match(h.layers[0].options.attribution,/OpenStreetMap/);
  assert.match(h.layers[0].options.attribution,/CARTO/);
  assert.doesNotMatch(source,/cyberjapandata\.gsi\.go\.jp\/xyz\/pale/);
});
test('missing or malformed keys never request watermarked tiles',()=>{
  for(const key of ['', 'bad key', '{template}', 'x'.repeat(513)]) {
    const h=harness(key);h.addMap();assert.equal(h.layers.length,0);assert.equal(h.status.hidden,false);
    assert.match(h.status.textContent,/店舗一覧/);
  }
});
test('cached config without a key recovers automatically for both maps without page reload',()=>{
  const h=harness();h.addMap();h.addMap();
  assert.equal(h.layers.length,0);
  h.config.carto_basemap_key='fixture-key';h.refresh();
  assert.equal(h.layers.length,2);
  h.layers[0].events.load();assert.equal(h.status.hidden,true);
  h.refresh();assert.equal(h.layers.length,2,'unchanged config must not reload tiles');
  assert.match(source,/Storage\.cacheConfig\(config\);\s*refreshBaseMaps_\(\);/);
  assert.match(source,/refreshBaseMaps_\(\);\s*const plannedRouteChanged/);
});
test('rotation replaces only the tile layer; closing a map unsubscribes it',()=>{
  const h=harness('fixture-old');const m1=h.addMap(),m2=h.addMap();
  m1.events.unload();h.config.carto_basemap_key='fixture-new';h.refresh();
  assert.equal(h.layers.length,3);assert.equal(m1.removed.length,0);assert.equal(m2.removed.length,1);
  h.config.carto_basemap_key='';h.refresh();assert.equal(m2.removed.length,2);assert.equal(h.layers.length,3);
});
test('tile failure preserves list guidance and recovers after a successful load cycle',()=>{
  const h=harness('fixture-key');h.addMap();const e=h.layers[0].events;
  e.loading();e.tileerror();e.load();assert.equal(h.status.hidden,false);
  assert.match(h.status.textContent,/店舗一覧/);
  e.loading();e.load();assert.equal(h.status.hidden,true);
});
