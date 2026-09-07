import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const api = readFileSync(process.env.ROUTE_NETWORK_API_SOURCE || new URL('api.js', import.meta.url), 'utf8');
const pair = readFileSync(process.env.ROUTE_NETWORK_PAIR_SOURCE || new URL('pair.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sources = [
  ['ping', api.slice(api.indexOf('  async function request_('), api.indexOf('  function get(action')) + '\nglobalThis.subject = () => request_("ping");'],
  ['pair', pair.slice(pair.indexOf('  async function fetchWithTimeout('), pair.indexOf('  async function attemptPair(')) + '\nglobalThis.subject = () => fetchWithTimeout("https://fixture.invalid/");'],
];
for (const [name, source] of sources) test(`${name} response-body timeout stays active after headers`, async () => {
  const timers = new Map(); let timerId = 0, signal;
  const context = vm.createContext({
    AbortController, ready: async () => {}, baseUrl: 'https://fixture.invalid/',
    readJson_: async response => JSON.parse(await response.text()),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":'));
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    },
  });
  vm.runInContext(source, context);
  const pending = context.subject();
  const rejected = assert.rejects(pending);
  await tick(); await tick();
  assert.equal(timers.size, 1, 'deadline must not end at response headers');
  [...timers.values()][0]();
  await rejected;
  assert.equal(signal.aborted, true); assert.equal(timers.size, 0);
});

test('malformed success or HTTP failure must not settle an uncertain write', async () => {
  const code = api.slice(api.indexOf('  function apiError_('), api.indexOf('  function get(action'));
  for (const [body, status] of [[null, 200], [[], 200], [{success:'false', data:{}}, 200], [{success:true}, 200], [{success:true, data:{}}, 503]]) {
    const settled = [];
    const context = vm.createContext({
      AbortController, setTimeout, clearTimeout,
      ready: async () => {}, baseUrl: 'https://fixture.invalid/', hasToken: () => true, getToken: () => 'fixture',
      READ_ACTIONS: new Set(), DEFAULT_TIMEOUT_MS: 1000,
      Storage: { reservePendingAction: async () => ({}), settlePendingAction: async (_id, value) => settled.push(value) },
      fetch: async () => new Response(JSON.stringify(body), {status}),
    });
    vm.runInContext(code + '\nglobalThis.subject = () => request_("addStore", {operation_id:"fixture-op"}, {queueOnFailure:false});', context);
    await assert.rejects(context.subject(), error => error.code === 'UNKNOWN_RESPONSE');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].remove, undefined, 'unknown write must retain its original receipt');
  }
});

test('valid success and explicit rejection retain the GAS envelope contract', async () => {
  const code = api.slice(api.indexOf('  function apiError_('), api.indexOf('  async function request_('));
  const context = vm.createContext({ window: {dispatchEvent() {}}, CustomEvent: class {} });
  vm.runInContext(code + '\nglobalThis.subject = readJson_;', context);
  for (const data of [null, [], {ok:true}]) {
    assert.equal(JSON.stringify(await context.subject(new Response(JSON.stringify({success:true,data})), 'getConfig')), JSON.stringify(data));
  }
  await assert.rejects(context.subject(new Response(JSON.stringify({success:false,error:'UNAUTHORIZED: denied'})), 'getConfig'), error => error.code === 'UNAUTHORIZED');
});
