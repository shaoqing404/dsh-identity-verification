import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { NativeHostChannel } from '../native-auth-channel.mjs';
import { bindNativeChannel } from '../../plugin/lib/native-channel.js';
import { NATIVE_CALLER_ID } from '../../plugin/lib/native-core.js';

function fixture(onInvalidated = () => {}) {
  const fromHost = new PassThrough();
  const toHost = new PassThrough();
  toHost.resume();
  const socket = Duplex.from({ readable: fromHost, writable: toHost });
  const channel = new NativeHostChannel(socket, onInvalidated);
  return {
    channel,
    socket,
    send(value) { fromHost.write(`${JSON.stringify(value)}\n`); },
    bytes(value) { fromHost.write(value); },
    end() { fromHost.end(); },
  };
}

test('valid fragmented replies and events preserve correlation', async () => {
  const events = [];
  const f = fixture(event => events.push(event));
  const first = f.channel.call('status');
  const second = f.channel.call('claim', { requestId: 'r' });
  const frames = [
    { event: 'invalidated', requestId: 'r-previous', reason: 'timeout' },
    { id: 2, result: { ok: true, state: 'verifying' } },
    { id: 1, result: { available: true, active: false } },
  ].map(value => `${JSON.stringify(value)}\n`).join('');
  f.bytes(frames.slice(0, 7));
  f.bytes(frames.slice(7, 65));
  f.bytes(frames.slice(65));
  assert.deepEqual(await first, { available: true, active: false });
  assert.deepEqual(await second, { ok: true, state: 'verifying' });
  assert.deepEqual(events, [{ event: 'invalidated', requestId: 'r-previous', reason: 'timeout' }]);
  assert.equal(f.channel.closed, false);
  f.channel.close();
});

test('valid error response rejects only its request and the channel remains usable', async () => {
  const f = fixture();
  const first = f.channel.call('create');
  f.send({ id: 1, error: { code: 'busy', message: 'Another request is active' } });
  await assert.rejects(first, error => error.code === 'busy');
  const next = f.channel.call('status');
  f.send({ id: 2, result: { available: true } });
  assert.deepEqual(await next, { available: true });
  f.channel.close();
});

test('main parser interoperates with the actual Host core on an in-memory duplex', async () => {
  const toHost = new PassThrough();
  const toMain = new PassThrough();
  const hostSocket = Duplex.from({ readable: toHost, writable: toMain });
  const mainSocket = Duplex.from({ readable: toMain, writable: toHost });
  const host = bindNativeChannel(hostSocket);
  const events = [];
  const main = new NativeHostChannel(mainSocket, event => events.push(event));
  assert.equal((await main.call('status')).available, true);
  const request = await main.call('create', {
    callerId: NATIVE_CALLER_ID, clientId: 'window-1-generation-1', policy: 'system-owner',
  });
  const binding = { requestId: request.requestId, callerId: request.callerId, clientId: request.clientId };
  assert.equal((await main.call('claim', binding)).state, 'verifying');
  assert.equal((await main.call('finish', { ...binding, outcome: 'granted', reason: 'authenticated' })).outcome, 'granted');
  const next = await main.call('create', {
    callerId: NATIVE_CALLER_ID, clientId: 'window-1-generation-1', policy: 'biometrics-only',
  });
  assert.equal((await main.call('cancel', { requestId: next.requestId, callerId: next.callerId, clientId: next.clientId })).ok, true);
  assert.deepEqual(events, [{ event: 'invalidated', requestId: next.requestId, reason: 'cancelled' }]);
  main.close();
  host.dispose();
});

test('null, malformed messages, unknown ids and invalid events close and reject all pending requests', async () => {
  const badMessages = [
    null, [], 1, 'text', {},
    { id: 2, result: {} },
    { id: '1', result: {} },
    { id: 1 },
    { id: 1, result: {}, extra: true },
    { id: 1, result: {}, error: { code: 'failed' } },
    { id: 1, error: null },
    { id: 1, error: { code: 42 } },
    { id: 1, error: { code: 'failed', message: 1 } },
    { event: 'other', requestId: 'r', reason: 'timeout' },
    { event: 'invalidated', requestId: 1, reason: 'timeout' },
    { event: 'invalidated', requestId: 'r' },
    { event: 'invalidated', requestId: 'r', reason: 'timeout', extra: true },
  ];
  for (const value of badMessages) {
    const f = fixture();
    const pending = f.channel.call('status');
    f.send(value);
    await assert.rejects(pending, /native-channel-closed/);
    assert.equal(f.channel.closed, true, JSON.stringify(value));
  }
});

test('invalid UTF-8, invalid JSON and oversized partial frames close the channel', async () => {
  for (const frame of [
    Buffer.from([0xff, 0x0a]),
    Buffer.from('{not-json}\n'),
    Buffer.alloc(16_384, 0x61),
  ]) {
    const f = fixture();
    const pending = f.channel.call('status');
    f.bytes(frame);
    await assert.rejects(pending, /native-channel-closed/);
    assert.equal(f.channel.closed, true);
  }
});

test('incoming frame byte limit includes its newline', async () => {
  const f = fixture();
  const first = f.channel.call('status');
  const message = JSON.stringify({ id: 1, result: { available: true } });
  f.bytes(`${message}${' '.repeat(16_383 - message.length)}\n`);
  assert.deepEqual(await first, { available: true });
  const second = f.channel.call('status');
  const oversized = JSON.stringify({ id: 2, result: {} });
  f.bytes(`${oversized}${' '.repeat(16_384 - oversized.length)}\n`);
  await assert.rejects(second, /native-channel-closed/);
});

test('duplicate response id closes the channel and rejects a different pending request', async () => {
  const f = fixture();
  const first = f.channel.call('status');
  const second = f.channel.call('status');
  f.send({ id: 1, result: {} });
  assert.deepEqual(await first, {});
  f.send({ id: 1, result: {} });
  await assert.rejects(second, /native-channel-closed/);
  assert.equal(f.channel.closed, true);
});

test('EOF rejects pending work, closes once, and prevents further calls', async () => {
  const f = fixture();
  let closed = 0;
  f.channel.onClose = () => { closed++; };
  const first = f.channel.call('status');
  const second = f.channel.call('claim');
  f.end();
  await Promise.all([
    assert.rejects(first, /native-channel-closed/),
    assert.rejects(second, /native-channel-closed/),
  ]);
  assert.equal(closed, 1);
  await assert.rejects(f.channel.call('status'), /native-channel-unavailable/);
  f.channel.close();
  assert.equal(closed, 1);
});

test('callback and synchronous write failures close instead of escaping the data handler', async () => {
  const f = fixture(() => { throw new Error('callback failure'); });
  const pending = f.channel.call('status');
  f.send({ event: 'invalidated', requestId: 'r', reason: 'timeout' });
  await assert.rejects(pending, /native-channel-closed/);
  assert.equal(f.channel.closed, true);

  const badWrite = fixture();
  badWrite.socket.write = () => { throw new Error('write failure'); };
  await assert.rejects(badWrite.channel.call('status'), /native-channel-closed/);
  assert.equal(badWrite.channel.closed, true);
});

test('oversized or unserializable local arguments do not leave a pending call', async () => {
  const f = fixture();
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(f.channel.call('create', cyclic), /native-channel-invalid-request/);
  await assert.rejects(f.channel.call('create', { data: 'x'.repeat(16_384) }), /native-channel-invalid-request/);
  assert.equal(f.channel.pending.size, 0);
  const pending = f.channel.call('status');
  f.send({ id: 1, result: { active: false } });
  assert.deepEqual(await pending, { active: false });
  f.channel.close();
});
