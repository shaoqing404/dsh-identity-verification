import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeCore, NativeCoreError, NATIVE_ACTION_ID, NATIVE_ACTION_TITLE,
  NATIVE_CALLER_ID, NATIVE_TIMEOUT_MS,
} from '../lib/native-core.js';

function fixture() {
  let wall = 1_800_000_000_000;
  let elapsed = 0;
  let serial = 0;
  const timers = new Set();
  const events = [];
  const core = new NativeCore({
    now: () => wall,
    monotonic: () => elapsed,
    makeId: () => `request-${++serial}`,
    setTimer(fn, delay) {
      const timer = { fn, at: elapsed + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    onInvalidated(event) { events.push(event); },
  });
  return {
    core, events, timers,
    advance(ms) {
      elapsed += ms;
      wall += ms;
      for (const timer of [...timers]) if (timer.at <= elapsed) {
        timers.delete(timer);
        timer.fn();
      }
    },
    changeWall(ms) { wall += ms; },
  };
}

function create(core, clientId = 'desktop:1', policy = 'system-owner') {
  return core.create({ callerId: NATIVE_CALLER_ID, clientId, policy });
}

function binding(request) {
  return { requestId: request.requestId, callerId: request.callerId, clientId: request.clientId };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof NativeCoreError && error.code === code);
}

test('request is tied to its caller, client, action and policy and completes only once', () => {
  const { core, timers } = fixture();
  const request = create(core);
  assert.deepEqual(request, {
    ok: true, requestId: 'request-1', callerId: NATIVE_CALLER_ID, clientId: 'desktop:1',
    actionId: NATIVE_ACTION_ID, title: NATIVE_ACTION_TITLE, policy: 'system-owner',
    deadline: 1_800_000_000_000 + NATIVE_TIMEOUT_MS,
  });
  throwsCode(() => create(core, 'desktop:2'), 'busy');
  throwsCode(() => core.claim({ ...binding(request), clientId: 'desktop:2' }), 'invalid-binding');
  throwsCode(() => core.finish({ ...binding(request), outcome: 'granted', reason: 'authenticated' }), 'invalid-state');
  assert.equal(core.claim(binding(request)).state, 'verifying');
  throwsCode(() => core.claim(binding(request)), 'invalid-state');
  throwsCode(() => core.finish({ ...binding(request), outcome: 'granted', reason: 'contains spaces' }), 'invalid-request');
  assert.deepEqual(core.finish({ ...binding(request), outcome: 'granted', reason: 'authenticated' }), {
    ok: true, requestId: 'request-1', callerId: NATIVE_CALLER_ID, clientId: 'desktop:1',
    actionId: NATIVE_ACTION_ID, policy: 'system-owner', outcome: 'granted', reason: 'authenticated',
  });
  throwsCode(() => core.finish({ ...binding(request), outcome: 'granted', reason: 'authenticated' }), 'invalid-binding');
  assert.equal(timers.size, 0);
  assert.equal(core.status().active, false);
  core.dispose();
});

test('only registered caller and valid fixed policy may create; invalid requests do not take the slot', () => {
  const { core } = fixture();
  throwsCode(() => core.create({ callerId: 'other', clientId: 'desktop:1', policy: 'system-owner' }), 'invalid-request');
  throwsCode(() => core.create({ callerId: NATIVE_CALLER_ID, clientId: '', policy: 'system-owner' }), 'invalid-request');
  throwsCode(() => core.create({ callerId: NATIVE_CALLER_ID, clientId: 'desktop:1', policy: 'any' }), 'invalid-request');
  throwsCode(() => core.create({ callerId: NATIVE_CALLER_ID, clientId: 'desktop:1', policy: 'system-owner', timeout: 1 }), 'invalid-request');
  assert.equal(create(core, 'desktop:1', 'biometrics-only').policy, 'biometrics-only');
  core.dispose();
});

test('monotonic deadline invalidates the request despite a wall-clock change', () => {
  const { core, events, advance, changeWall, timers } = fixture();
  const request = create(core);
  core.claim(binding(request));
  changeWall(-100_000);
  advance(NATIVE_TIMEOUT_MS - 1);
  assert.equal(core.status({}).active, true);
  advance(1);
  assert.deepEqual(events, [{ event: 'invalidated', requestId: request.requestId, reason: 'timeout' }]);
  assert.equal(timers.size, 0);
  throwsCode(() => core.finish({ ...binding(request), outcome: 'granted', reason: 'authenticated' }), 'invalid-binding');
  assert.equal(core.status().active, false);
  core.dispose();
});

test('cancel and disposal invalidate once and cannot be replayed', () => {
  const { core, events, timers } = fixture();
  const request = create(core);
  assert.deepEqual(core.cancel(binding(request)), { ok: true, requestId: request.requestId });
  throwsCode(() => core.cancel(binding(request)), 'invalid-binding');
  const next = create(core, 'desktop:2');
  core.claim(binding(next));
  core.dispose();
  core.dispose();
  assert.deepEqual(events, [
    { event: 'invalidated', requestId: request.requestId, reason: 'cancelled' },
    { event: 'invalidated', requestId: next.requestId, reason: 'dispose' },
  ]);
  assert.equal(timers.size, 0);
  throwsCode(() => core.status(), 'unavailable');
});
