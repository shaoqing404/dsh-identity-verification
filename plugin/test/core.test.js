import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_OPERATION, SimulationCore } from '../lib/core.js';
import { createHandler, createRoute, MAX_BODY_BYTES, apply } from '../lib/index.js';

function peer(kind = 'owner', interactions = 'answer') {
  const controller = new AbortController();
  return { principal: { kind }, interactions, signal: controller.signal, controller };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('core accepts only its live internal owner token and the fixed synthetic action', async () => {
  const owner = peer();
  let backendCalls = 0;
  const core = new SimulationCore({ browserPeer: owner, backend: () => { backendCalls++; return 'ready'; } });
  const unknown = peer();
  const remote = peer('guest');
  assert.equal(core.begin(undefined, DEMO_OPERATION).code, 'forbidden');
  assert.equal(core.begin(unknown, DEMO_OPERATION).code, 'forbidden');
  assert.equal(core.begin(remote, DEMO_OPERATION).code, 'forbidden');
  owner.interactions = 'none';
  assert.equal(core.begin(owner, DEMO_OPERATION).code, 'forbidden');
  owner.interactions = 'answer';
  assert.equal(core.begin(owner, 'real.authentication').code, 'invalid-operation');
  assert.equal(backendCalls, 0);
  owner.controller.abort();
  assert.equal(core.begin(owner, DEMO_OPERATION).code, 'forbidden');
  core.dispose();
});

test('one request at a time, operation-bound and consumed exactly once', async () => {
  const owner = peer();
  const response = deferred();
  const core = new SimulationCore({ browserPeer: owner, backend: () => response.promise });
  const first = core.begin(owner, DEMO_OPERATION);
  assert.equal(first.ok, true);
  assert.equal(core.begin(owner, DEMO_OPERATION).code, 'busy');
  assert.equal(core.consume(owner, first.id, DEMO_OPERATION).code, 'not-ready');
  const waited = core.wait(owner, first.id, DEMO_OPERATION);
  response.resolve('ready');
  assert.deepEqual(await waited, { ok: true, state: 'ready' });
  assert.deepEqual(core.consume(owner, first.id, DEMO_OPERATION),
    { ok: true, state: 'consumed', operation: DEMO_OPERATION, id: first.id });
  assert.equal(core.consume(owner, first.id, DEMO_OPERATION).code, 'unknown-request');
  const second = core.begin(owner, DEMO_OPERATION);
  assert.notEqual(second.id, first.id);
  assert.equal(core.consume(owner, second.id, 'other.action').code, 'operation-changed');
  assert.equal(core.consume(owner, second.id, DEMO_OPERATION).code, 'unknown-request');
  core.dispose();
});

test('timeout releases the slot and a late backend result cannot revive it', async () => {
  const owner = peer();
  const firstResult = deferred();
  const secondResult = deferred();
  let calls = 0;
  const core = new SimulationCore({ browserPeer: owner, timeoutMs: 25,
    backend: () => (++calls === 1 ? firstResult.promise : secondResult.promise) });
  const first = core.begin(owner, DEMO_OPERATION);
  assert.deepEqual(await core.wait(owner, first.id, DEMO_OPERATION), { ok: false, code: 'timeout' });
  const second = core.begin(owner, DEMO_OPERATION);
  firstResult.resolve('ready');
  await tick();
  assert.equal(core.consume(owner, first.id, DEMO_OPERATION).code, 'unknown-request');
  assert.equal(core.consume(owner, second.id, DEMO_OPERATION).code, 'not-ready');
  secondResult.resolve('ready');
  assert.equal((await core.wait(owner, second.id, DEMO_OPERATION)).state, 'ready');
  assert.equal(core.consume(owner, second.id, DEMO_OPERATION).state, 'consumed');
  core.dispose();
});

test('immediate cancellation, internal token abort or disposal prevents backend invocation', async () => {
  for (const mode of ['cancel', 'token-abort', 'dispose']) {
    const owner = peer();
    let calls = 0;
    const core = new SimulationCore({ browserPeer: owner, backend: () => { calls++; return 'ready'; } });
    const started = core.begin(owner, DEMO_OPERATION);
    if (mode === 'cancel') core.cancel(owner, started.id, DEMO_OPERATION);
    if (mode === 'token-abort') owner.controller.abort();
    if (mode === 'dispose') core.dispose();
    await tick();
    assert.equal(calls, 0);
    assert.notEqual(core.consume(owner, started.id, DEMO_OPERATION).ok, true);
    core.dispose();
  }
});

test('cancellation, aborted wait, internal token abort and plugin disposal invalidate late results', async () => {
  for (const mode of ['cancel', 'wait-abort', 'token-abort', 'dispose']) {
    const owner = peer();
    const response = deferred();
    const core = new SimulationCore({ browserPeer: owner, backend: () => response.promise });
    const started = core.begin(owner, DEMO_OPERATION);
    const controller = new AbortController();
    const waiting = core.wait(owner, started.id, DEMO_OPERATION, controller.signal);
    if (mode === 'cancel') assert.equal(core.cancel(owner, started.id, DEMO_OPERATION).state, 'cancelled');
    if (mode === 'wait-abort') controller.abort();
    if (mode === 'token-abort') owner.controller.abort();
    if (mode === 'dispose') core.dispose();
    assert.deepEqual(await waiting, { ok: false, code: mode === 'dispose' ? 'disposed' : 'cancelled' });
    response.resolve('ready');
    await tick();
    assert.notEqual(core.consume(owner, started.id, DEMO_OPERATION).ok, true);
    if (mode === 'cancel' || mode === 'wait-abort') {
      assert.equal(core.begin(owner, DEMO_OPERATION).ok, true);
    }
    core.dispose();
  }
});

test('backend failure, malformed output and ready-then-cancel never consume', async () => {
  const invalid = [null, undefined, true, false, '', 'success', 'confirmed', { status: 'ready' }, ['ready']];
  for (const backend of [() => Promise.reject(new Error('private details')), ...invalid.map((value) => () => value)]) {
    const owner = peer();
    const core = new SimulationCore({ browserPeer: owner, backend });
    const started = core.begin(owner, DEMO_OPERATION);
    const outcome = await core.wait(owner, started.id, DEMO_OPERATION);
    assert.deepEqual(outcome, { ok: false, code: 'unexpected' });
    assert.equal(JSON.stringify(outcome).includes('private details'), false);
    assert.equal(core.consume(owner, started.id, DEMO_OPERATION).code, 'unknown-request');
    core.dispose();
  }
  const owner = peer();
  const core = new SimulationCore({ browserPeer: owner, backend: () => 'ready' });
  const started = core.begin(owner, DEMO_OPERATION);
  assert.equal((await core.wait(owner, started.id, DEMO_OPERATION)).state, 'ready');
  core.cancel(owner, started.id, DEMO_OPERATION);
  assert.equal(core.consume(owner, started.id, DEMO_OPERATION).code, 'unknown-request');
  core.dispose();
});

test('synthetic handler validates input and checks its internal owner token', async () => {
  const owner = peer();
  let calls = 0;
  const core = new SimulationCore({ browserPeer: owner, backend: () => { calls++; return 'ready'; } });
  const handle = createHandler(core);
  const signal = new AbortController().signal;
  const call = (method, payload, caller = owner) => handle(method, payload, signal, caller);
  for (const input of [null, [], {}, { operation: DEMO_OPERATION, result: 'ready' },
    { operation: DEMO_OPERATION, grant: true }, { operation: 1 }, { operation: 'real.authentication' }]) {
    const result = (await call('begin', input)).value;
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'id'), false);
  }
  await tick();
  assert.equal(calls, 0);
  assert.equal((await call('begin', { operation: DEMO_OPERATION }, peer())).value.code, 'forbidden');
  const started = (await call('begin', { operation: DEMO_OPERATION })).value;
  assert.equal((await call('wait', { id: started.id, operation: DEMO_OPERATION })).value.state, 'ready');
  assert.equal((await call('consume', { id: started.id, operation: DEMO_OPERATION })).value.state, 'consumed');
  assert.equal((await call('consume', { id: started.id, operation: DEMO_OPERATION })).value.code, 'unknown-request');
  core.dispose();
});

test('streamed request body limit counts bytes before JSON parsing', async () => {
  const owner = peer();
  let calls = 0;
  const route = createRoute('begin', async () => { calls++; return { ok: true, value: { ok: false } }; }, owner);
  assert.equal(route.requestBody, 'streaming');
  const send = (body, type = 'application/json') => route.fetch(new Request('http://localhost' + route.path, {
    method: 'POST', headers: { 'content-type': type }, body
  }));
  assert.equal((await send('{}' + ' '.repeat(MAX_BODY_BYTES - 2))).status, 200);
  assert.equal(calls, 1);
  assert.equal((await send('{}' + ' '.repeat(MAX_BODY_BYTES - 1))).status, 413);
  const multibyte = JSON.stringify({ operation: '中'.repeat(1500) });
  assert.ok(multibyte.length < MAX_BODY_BYTES);
  assert.equal((await send(multibyte)).status, 413);
  assert.equal((await send('{broken')).status, 400);
  assert.equal((await send('{}', 'text/plain')).status, 415);
  assert.equal(calls, 1);
});

test('Host lifecycle withdraws all routes and invalidates a waiting request', async () => {
  const owner = peer();
  const routes = new Map();
  const effects = [];
  const ctx = {
    connection: { browserPeer: owner, fetch: { register(route) {
      routes.set(route.path, route);
      return async () => { routes.delete(route.path); };
    } } },
    effect(register) { effects.push(register()); }
  };
  apply(ctx);
  const call = async (method, payload) => {
    const route = routes.get('/api/touch-id-simulation/' + method);
    const request = new Request('http://localhost' + route.path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return (await route.fetch(request)).json();
  };
  const begun = await call('begin', { operation: DEMO_OPERATION });
  const waiting = call('wait', { id: begun.id, operation: DEMO_OPERATION });
  await tick();
  for (const dispose of effects.reverse()) await dispose();
  assert.equal((await waiting).code, 'disposed');
  assert.equal(routes.size, 0);
});
