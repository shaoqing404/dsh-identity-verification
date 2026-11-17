import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NativeHelperRunner } from '../../scripts/native-helper-runner.mjs';

const testFile = fileURLToPath(import.meta.url);
const testHash = createHash('sha256').update(readFileSync(testFile)).digest('hex');
const AUTH_ARGS = ['--request-id', 'Req:123', '--action-id', 'demo_verify', '--policy', 'system-owner', '--timeout-ms', '5000'];
const grant = () => ({
  schemaVersion: 1, operation: 'authenticate', requestId: 'Req:123', actionId: 'demo_verify',
  policy: 'system-owner', outcome: 'granted', reason: null, method: 'unknown', elapsedMs: 20,
});
const check = () => ({
  schemaVersion: 1, operation: 'check', systemOwner: { available: true, reason: null },
  biometricsOnly: { available: false, reason: 'biometry_not_enrolled' }, biometryType: 'touch-id',
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    return true;
  }

  closeWith(value, exitCode = 0) {
    this.stdout.end(value === undefined ? '' : `${JSON.stringify(value)}\n`);
    this.stderr.end('not returned to caller');
    this.emit('close', exitCode, null);
  }
}

function harness({ sha256 = testHash } = {}) {
  const events = new EventEmitter();
  const launches = [];
  const runner = new NativeHelperRunner({
    path: testFile, sha256,
    spawn(executable, args, options) {
      const child = new FakeChild();
      launches.push({ executable, args, options, child });
      queueMicrotask(() => events.emit('spawned', child));
      return child;
    },
  });
  return { runner, launches, nextChild: async () => (await once(events, 'spawned'))[0] };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('waits for close, validates check JSON, and drains stderr', async () => {
  const h = harness();
  const completion = h.runner.run(['--check']);
  const child = await h.nextChild();
  child.stdout.write(`${JSON.stringify(check())}\n`);
  child.stderr.write('ignored diagnostic');
  child.emit('exit', 0, null);
  await nextTurn();
  assert.equal(h.runner.busy, true);
  await assert.rejects(h.runner.run(['--check']), { code: 'helper-busy' });
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
  assert.deepEqual(await completion, { result: check(), exitCode: 0 });
  assert.equal(h.runner.busy, false);
  assert.deepEqual(h.launches[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('abort keeps the latch until close even if child error arrives first', async () => {
  const h = harness();
  const controller = new AbortController();
  const completion = h.runner.run(AUTH_ARGS, { signal: controller.signal });
  const rejected = assert.rejects(completion, { code: 'helper-aborted' });
  const child = await h.nextChild();
  controller.abort();
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('error', Object.assign(new Error('simulated early abort callback'), { name: 'AbortError' }));
  await nextTurn();
  assert.equal(h.runner.busy, true);
  await assert.rejects(h.runner.run(['--check']), { code: 'helper-busy' });
  child.emit('close', null, 'SIGTERM');
  await rejected;
  assert.equal(h.runner.busy, false);
});

test('timeout escalates from SIGTERM to SIGKILL while waiting for close', async () => {
  const h = harness();
  const completion = h.runner.run(['--check'], { timeoutMs: 40 });
  const rejected = assert.rejects(completion, { code: 'helper-timeout' });
  const child = await h.nextChild();
  await delay(600);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.runner.busy, true);
  child.emit('close', null, 'SIGKILL');
  await rejected;
  assert.equal(h.runner.busy, false);
});

test('missed close deadline rejects but stays busy until the actual close', async () => {
  const h = harness();
  const controller = new AbortController();
  const completion = h.runner.run(['--check'], { signal: controller.signal });
  const rejected = assert.rejects(completion, { code: 'helper-close-timeout' });
  const child = await h.nextChild();
  controller.abort();
  await rejected;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.runner.busy, true);
  await assert.rejects(h.runner.run(['--check']), { code: 'helper-busy' });
  child.emit('close', null, 'SIGKILL');
  assert.equal(h.runner.busy, false);
  const retry = h.runner.run(['--check']);
  const next = await h.nextChild();
  next.closeWith(check());
  assert.equal((await retry).result.operation, 'check');
});

test('rejects excessive stdout after terminating and waiting for close', async () => {
  const h = harness();
  const completion = h.runner.run(['--check']);
  const rejected = assert.rejects(completion, { code: 'helper-output-too-large' });
  const child = await h.nextChild();
  child.stdout.write(Buffer.alloc(16_385, 65));
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(h.runner.busy, true);
  child.emit('close', null, 'SIGTERM');
  await rejected;
});

test('rejects malformed JSON, wrong request binding and mismatched exit code', async () => {
  for (const [raw, result, exitCode, errorCode] of [
    ['{', undefined, 0, 'helper-invalid-output'],
    [undefined, { ...grant(), requestId: 'other' }, 0, 'helper-invalid-output'],
    [undefined, grant(), 1, 'helper-exit-mismatch'],
    [undefined, { ...grant(), outcome: 'cancelled', reason: 'user_cancel' }, 0, 'helper-exit-mismatch'],
  ]) {
    const h = harness();
    const completion = h.runner.run(AUTH_ARGS);
    const rejected = assert.rejects(completion, { code: errorCode });
    const child = await h.nextChild();
    if (raw !== undefined) child.stdout.write(raw);
    child.closeWith(result, exitCode);
    await rejected;
    assert.equal(h.runner.busy, false);
  }
});

test('rejects invalid UTF-8 even when the replacement character would form valid JSON', async () => {
  const h = harness();
  const completion = h.runner.run(['--check']);
  const rejected = assert.rejects(completion, { code: 'helper-invalid-output' });
  const child = await h.nextChild();
  const json = JSON.stringify({ ...check(), extra: 'X' });
  const bytes = Buffer.from(json);
  bytes[bytes.indexOf(Buffer.from('"X"')) + 1] = 0xff;
  child.stdout.write(bytes);
  child.closeWith(undefined);
  await rejected;
});

test('verifies hash before spawn and refuses already-aborted or invalid requests', async () => {
  const h = harness({ sha256: '0'.repeat(64) });
  await assert.rejects(h.runner.run(['--check']), { code: 'helper-integrity' });
  assert.equal(h.launches.length, 0);
  assert.equal(h.runner.busy, false);

  const valid = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(valid.runner.run(['--check'], { signal: controller.signal }), { code: 'helper-aborted' });
  await assert.rejects(valid.runner.run([...AUTH_ARGS, '--policy', 'system-owner']), { code: 'helper-invalid-arguments' });
  assert.equal(valid.launches.length, 0);
});

test('copies request arguments before awaiting integrity verification', async () => {
  const h = harness();
  const args = [...AUTH_ARGS];
  const completion = h.runner.run(args);
  args[5] = 'biometrics-only';
  const child = await h.nextChild();
  assert.equal(h.launches[0].args[5], 'system-owner');
  child.closeWith(grant());
  assert.equal((await completion).result.policy, 'system-owner');
});
