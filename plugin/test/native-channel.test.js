import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { bindNativeChannel, openNativeChannel, MAX_NATIVE_FRAME_BYTES } from '../lib/native-channel.js';
import { NATIVE_CALLER_ID, NATIVE_TIMEOUT_MS } from '../lib/native-core.js';

function pair(options) {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const socket = Duplex.from({ readable: toHost, writable: fromHost });
  const channel = bindNativeChannel(socket, options);
  let buffer = '';
  const queue = [];
  const waiters = [];
  fromHost.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else queue.push(value);
    }
  });
  function next() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a channel message')), 1_000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
  return {
    channel, socket, toHost, fromHost, next,
    send(id, method, args) {
      toHost.write(`${JSON.stringify({ id, method, ...(args === undefined ? {} : { args }) })}\n`);
    },
  };
}

test('disabled channel does not inspect or claim an inherited descriptor', () => {
  assert.equal(openNativeChannel({ env: {} }), null);
  assert.equal(openNativeChannel({ env: { DSH_TOUCH_ID_NATIVE_CHANNEL: '0' } }), null);
});

test('duplex protocol handles fragmented and coalesced frames and enforces binding', async () => {
  const p = pair({ makeId: () => 'request-1' });
  const payload = `${JSON.stringify({ id: 1, method: 'status' })}\n${JSON.stringify({
    id: 'second', method: 'create', args: { callerId: NATIVE_CALLER_ID, clientId: 'window:5', policy: 'system-owner' },
  })}\n`;
  p.toHost.write(payload.slice(0, 9));
  p.toHost.write(payload.slice(9, 47));
  p.toHost.write(payload.slice(47));
  const status = await p.next();
  assert.equal(status.id, 1);
  assert.equal(status.result.available, true);
  assert.equal(status.result.active, false);
  const created = await p.next();
  assert.equal(created.id, 'second');
  assert.equal(created.result.requestId, 'request-1');
  const args = { requestId: created.result.requestId, callerId: NATIVE_CALLER_ID, clientId: 'window:5' };
  p.send(3, 'claim', { ...args, clientId: 'window:6' });
  assert.equal((await p.next()).error.code, 'invalid-binding');
  p.send(4, 'claim', args);
  assert.equal((await p.next()).result.state, 'verifying');
  p.send(5, 'finish', { ...args, outcome: 'cancelled', reason: 'user-cancelled' });
  assert.equal((await p.next()).result.outcome, 'cancelled');
  p.send(6, 'finish', { ...args, outcome: 'granted', reason: 'authenticated' });
  assert.equal((await p.next()).error.code, 'invalid-binding');
  p.channel.dispose();
});

test('cancellation emits a request-specific invalidation and permits a new request', async () => {
  const p = pair();
  p.send(1, 'create', { callerId: NATIVE_CALLER_ID, clientId: 'window:1', policy: 'biometrics-only' });
  const request = (await p.next()).result;
  p.send(2, 'cancel', { requestId: request.requestId, callerId: NATIVE_CALLER_ID, clientId: 'window:1' });
  assert.deepEqual(await p.next(), { event: 'invalidated', requestId: request.requestId, reason: 'cancelled' });
  assert.deepEqual(await p.next(), { id: 2, result: { ok: true, requestId: request.requestId } });
  p.send(3, 'status', {});
  assert.equal((await p.next()).result.active, false);
  p.channel.dispose();
});

test('peer disconnect revokes the pending request and closes the private stream', async () => {
  const p = pair();
  p.send(1, 'create', { callerId: NATIVE_CALLER_ID, clientId: 'window:1', policy: 'system-owner' });
  const request = (await p.next()).result;
  const closed = new Promise((resolve) => p.socket.once('close', resolve));
  p.toHost.end();
  assert.deepEqual(await p.next(), { event: 'invalidated', requestId: request.requestId, reason: 'disconnect' });
  await closed;
  assert.equal(p.socket.destroyed, true);
});

test('deadline and plugin disposal notify the parent and revoke pending requests', async () => {
  let elapsed = 0;
  let timer;
  const p = pair({
    monotonic: () => elapsed,
    setTimer(fn) { timer = fn; return { unref() {} }; },
    clearTimer() {},
  });
  p.send(1, 'create', { callerId: NATIVE_CALLER_ID, clientId: 'window:1', policy: 'system-owner' });
  const expired = (await p.next()).result;
  elapsed = NATIVE_TIMEOUT_MS;
  timer();
  assert.deepEqual(await p.next(), { event: 'invalidated', requestId: expired.requestId, reason: 'timeout' });
  p.send(2, 'create', { callerId: NATIVE_CALLER_ID, clientId: 'window:1', policy: 'system-owner' });
  const disposed = (await p.next()).result;
  const closed = new Promise((resolve) => p.socket.once('close', resolve));
  p.channel.dispose();
  assert.deepEqual(await p.next(), { event: 'invalidated', requestId: disposed.requestId, reason: 'dispose' });
  await closed;
});

test('oversized, invalid UTF-8 and malformed envelopes close the stream', async () => {
  for (const frame of [
    Buffer.alloc(MAX_NATIVE_FRAME_BYTES + 1, 0x61),
    Buffer.from([0xff, 0x0a]),
    Buffer.from('{"id":1,"method":"status","extra":true}\n'),
  ]) {
    const p = pair();
    const closed = new Promise((resolve) => p.socket.once('close', resolve));
    p.toHost.write(frame);
    await closed;
    assert.equal(p.socket.destroyed, true);
  }
});

test('frame limit counts the newline delimiter', async () => {
  const p = pair();
  const message = JSON.stringify({ id: 1, method: 'status' });
  p.toHost.write(`${message}${' '.repeat(MAX_NATIVE_FRAME_BYTES - 1 - message.length)}\n`);
  assert.equal((await p.next()).result.available, true);
  const closed = new Promise((resolve) => p.socket.once('close', resolve));
  p.toHost.write(`${message}${' '.repeat(MAX_NATIVE_FRAME_BYTES - message.length)}\n`);
  await closed;
  assert.equal(p.socket.destroyed, true);
});

test('unknown methods and unexpected parameters cannot mutate state', async () => {
  const p = pair();
  p.send(1, 'removeAll', {});
  assert.equal((await p.next()).error.code, 'unknown-method');
  p.send(2, 'status', { unexpected: true });
  assert.equal((await p.next()).error.code, 'invalid-request');
  p.send(3, 'status');
  assert.equal((await p.next()).result.active, false);
  p.channel.dispose();
});
