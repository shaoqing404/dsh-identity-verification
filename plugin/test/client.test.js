import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationCore } from '../lib/core.js';
import { createHandler, createRoute } from '../lib/index.js';

test('configuration page sends a fixed simulation through Host and consumes its result', async () => {
  const controller = new AbortController();
  const owner = { principal: { kind: 'owner' }, interactions: 'answer', signal: controller.signal };
  const core = new SimulationCore({ browserPeer: owner, backend: () => 'ready' });
  const handler = createHandler(core);
  const calls = [];
  const send = async (url, init) => {
    const method = url.split('/').at(-1);
    calls.push(method);
    return createRoute(method, handler, owner).fetch(new Request('http://localhost/' + url, init));
  };
  const statuses = [];
  let cleanup;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { return [initial, (value) => { statuses.push(value); }]; },
    useRef(initial) { return { current: initial }; },
    useEffect(effect) { cleanup = effect(); }
  };
  let registration;
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  try {
    await import('../lib/client.js');
  } finally {
    delete globalThis.window;
  }
  assert.equal(registration.id, 'dsh-touch-id');
  const client = registration.factory((name) => {
    assert.equal(name, 'react');
    return React;
  });
  let page;
  let slotOptions;
  client.apply({
    slots: {
      inject(name, install) { assert.equal(name, 'plugins.bundle.config'); install(); },
      register(options, component) { slotOptions = options; page = component; }
    }
  });
  assert.equal(slotOptions.key, 'dsh-touch-id');
  const view = page({ send });
  assert.match(view.children[1].children[0], /仅为合成演示/);
  assert.match(view.children[2].children[0], /尚未证明 Desktop 来源/);
  await view.children[3].props.onClick();
  assert.deepEqual(calls, ['begin', 'wait', 'consume']);
  assert.equal(statuses.includes('模拟完成：Host 已消费这次合成结果。'), true);
  cleanup();
  core.dispose();
});

test('cancelling before the begin reply cancels the Host-generated request when it arrives', async () => {
  const owner = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal };
  const backend = new Promise(() => {});
  const core = new SimulationCore({ browserPeer: owner, backend: () => backend });
  const handler = createHandler(core);
  let releaseReply;
  let notifyBegin;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const beginArrived = new Promise((resolve) => { notifyBegin = resolve; });
  const calls = [];
  const send = async (url, init) => {
    const method = url.split('/').at(-1);
    calls.push(method);
    const result = await createRoute(method, handler, owner).fetch(new Request('http://localhost/' + url, init));
    if (method === 'begin') {
      notifyBegin();
      await replyGate;
    }
    return result;
  };
  const statuses = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { return [initial, (value) => { statuses.push(value); }]; },
    useRef(initial) { return { current: initial }; },
    useEffect(effect) { effect(); }
  };
  let registration;
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  try { await import('../lib/client.js?cancel-before-reply'); } finally { delete globalThis.window; }
  let page;
  let options;
  registration.factory(() => React).apply({ slots: {
    inject(_name, install) { install(); },
    register(input, component) { options = input; page = component; }
  } });
  const view = page({ send });
  const running = view.children[3].props.onClick();
  await beginArrived;
  await view.children[5].props.onClick();
  assert.equal(statuses.includes('正在取消，等待 Host 确认…'), true);
  assert.equal(statuses.includes('模拟已取消。'), false);
  releaseReply();
  await running;
  assert.equal(statuses.includes('模拟已取消。'), true);
  assert.deepEqual(calls, ['begin', 'cancel']);
  assert.equal(core.current, null);
  core.dispose();
});

async function renderRacePage(send, suffix) {
  const statuses = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { return [initial, (value) => { statuses.push(value); }]; },
    useRef(initial) { return { current: initial }; },
    useEffect(effect) { effect(); }
  };
  let registration;
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  try { await import('../lib/client.js?' + suffix); } finally { delete globalThis.window; }
  let page;
  registration.factory(() => React).apply({ slots: {
    inject(_name, install) { install(); }, register(_options, component) { page = component; }
  } });
  return { view: page({ send }), statuses };
}

test('cancel while a consumed result reply is delayed never reports cancellation', async () => {
  const owner = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal };
  const core = new SimulationCore({ browserPeer: owner, backend: () => 'ready' });
  const handler = createHandler(core);
  let releaseReply;
  let notifyConsumed;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const consumed = new Promise((resolve) => { notifyConsumed = resolve; });
  const calls = [];
  const send = async (url, init) => {
    const method = url.split('/').at(-1);
    calls.push(method);
    const result = await createRoute(method, handler, owner).fetch(new Request('http://localhost/' + url, init));
    if (method === 'consume') { notifyConsumed(); await replyGate; }
    return result;
  };
  const { view, statuses } = await renderRacePage(send, 'consume-reply-race');
  const running = view.children[3].props.onClick();
  await consumed;
  assert.equal(core.current, null);
  await view.children[5].props.onClick();
  assert.equal(statuses.includes('模拟已取消。'), false);
  assert.equal(statuses.includes('模拟结果已提交，正在等待 Host 回执。'), true);
  releaseReply();
  await running;
  assert.equal(statuses.includes('模拟完成：Host 已消费这次合成结果。'), true);
  assert.deepEqual(calls, ['begin', 'wait', 'consume']);
  core.dispose();
});

test('a lost consume reply is shown as unknown even if the Host consumed', async () => {
  const owner = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal };
  const core = new SimulationCore({ browserPeer: owner, backend: () => 'ready' });
  const handler = createHandler(core);
  const send = async (url, init) => {
    const method = url.split('/').at(-1);
    const result = await createRoute(method, handler, owner).fetch(new Request('http://localhost/' + url, init));
    if (method === 'consume') throw new Error('response lost');
    return result;
  };
  const { view, statuses } = await renderRacePage(send, 'consume-reply-lost');
  await view.children[3].props.onClick();
  assert.equal(core.current, null);
  assert.equal(statuses.includes('模拟结果未确认，Host 可能已经消费，请勿重复提交。'), true);
  assert.equal(statuses.includes('模拟已取消。'), false);
  core.dispose();
});

test('cancel is shown as confirmed only after the Host cancellation reply', async () => {
  const owner = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal };
  const core = new SimulationCore({ browserPeer: owner, backend: () => new Promise(() => {}) });
  const handler = createHandler(core);
  let releaseReply;
  let notifyWaiting;
  let notifyCancelled;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const waiting = new Promise((resolve) => { notifyWaiting = resolve; });
  const cancelled = new Promise((resolve) => { notifyCancelled = resolve; });
  const send = async (url, init) => {
    const method = url.split('/').at(-1);
    if (method === 'wait') notifyWaiting();
    const result = await createRoute(method, handler, owner).fetch(new Request('http://localhost/' + url, init));
    if (method === 'cancel') { notifyCancelled(); await replyGate; }
    return result;
  };
  const { view, statuses } = await renderRacePage(send, 'cancel-reply-race');
  const running = view.children[3].props.onClick();
  await waiting;
  const cancellation = view.children[5].props.onClick();
  await cancelled;
  assert.equal(statuses.includes('正在取消，等待 Host 确认…'), true);
  assert.equal(statuses.includes('模拟已取消。'), false);
  releaseReply();
  await cancellation;
  await running;
  assert.equal(statuses.includes('模拟已取消。'), true);
  core.dispose();
});
