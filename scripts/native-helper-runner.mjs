import { spawn as spawnChild } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const MAX_OUTPUT_BYTES = 16_384;
const TERMINATE_GRACE_MS = 500;
const CLOSE_DEADLINE_MS = 2_000;
const OUTCOMES = new Set(['granted', 'cancelled', 'unavailable', 'timeout', 'error']);
const BIOMETRY_TYPES = new Set(['none', 'touch-id', 'face-id', 'optic-id', 'unknown']);
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export class NativeHelperError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeHelperError';
    this.code = code;
  }
}

function fail(code) {
  throw new NativeHelperError(code);
}

function requestFor(args) {
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) fail('helper-invalid-arguments');
  if (args.length === 1 && args[0] === '--check') return { operation: 'check' };
  if (args.length !== 8) fail('helper-invalid-arguments');
  const allowed = new Set(['--request-id', '--action-id', '--policy', '--timeout-ms']);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || options.has(args[i])) fail('helper-invalid-arguments');
    options.set(args[i], args[i + 1]);
  }
  const requestId = options.get('--request-id');
  const actionId = options.get('--action-id');
  const policy = options.get('--policy');
  const timeoutText = options.get('--timeout-ms');
  if (!REQUEST_ID.test(requestId ?? '') || actionId !== 'demo_verify'
    || !['system-owner', 'biometrics-only'].includes(policy)
    || !/^[1-9][0-9]{0,5}$/u.test(timeoutText ?? '')
    || Number(timeoutText) < 5_000 || Number(timeoutText) > 120_000) {
    fail('helper-invalid-arguments');
  }
  return { operation: 'authenticate', requestId, actionId, policy };
}

function validProbe(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.available === 'boolean'
    && (value.available ? value.reason === null : typeof value.reason === 'string' && REASON.test(value.reason));
}

function validateResponse(buffer, exitCode, request) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch {
    fail('helper-invalid-output');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.operation !== request.operation) fail('helper-invalid-output');
  if (request.operation === 'check') {
    if (!validProbe(value.systemOwner) || !validProbe(value.biometricsOnly)
      || !BIOMETRY_TYPES.has(value.biometryType)) fail('helper-invalid-output');
    if (exitCode !== 0) fail('helper-exit-mismatch');
    return value;
  }
  if (value.requestId !== request.requestId || value.actionId !== request.actionId || value.policy !== request.policy
    || !OUTCOMES.has(value.outcome) || value.method !== 'unknown'
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || (value.outcome === 'granted' ? value.reason !== null
      : typeof value.reason !== 'string' || !REASON.test(value.reason))) fail('helper-invalid-output');
  if (exitCode !== (value.outcome === 'granted' ? 0 : 1)) fail('helper-exit-mismatch');
  return value;
}

export class NativeHelperRunner {
  #path;
  #sha256;
  #spawn;
  #busy = false;

  constructor({ path: executablePath, sha256, spawn = spawnChild }) {
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
      || typeof spawn !== 'function') throw new TypeError('Invalid native helper configuration');
    this.#path = executablePath;
    this.#sha256 = sha256;
    this.#spawn = spawn;
  }

  get busy() { return this.#busy; }

  async run(args, { signal, timeoutMs = 35_000 } = {}) {
    if (this.#busy) fail('helper-busy');
    if (Array.isArray(args)) args = [...args];
    const request = requestFor(args);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000
      || (signal !== undefined && (typeof signal?.addEventListener !== 'function'
        || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean'))) {
      fail('helper-invalid-arguments');
    }

    this.#busy = true;
    let child = null;
    let childClosed = false;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(new NativeHelperError('helper-aborted'));
    const timeout = setTimeout(() => controller.abort(new NativeHelperError('helper-timeout')), timeoutMs);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      let contents;
      try { contents = await readFile(this.#path, { signal: controller.signal }); } catch {
        if (controller.signal.aborted) throw controller.signal.reason;
        fail('helper-integrity');
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (createHash('sha256').update(contents).digest('hex') !== this.#sha256) fail('helper-integrity');
      if (controller.signal.aborted) throw controller.signal.reason;

      try {
        child = this.#spawn(this.#path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        fail('helper-spawn-failed');
      }

      return await new Promise((resolve, reject) => {
        let settled = false;
        let stopReason = null;
        let killTimer;
        let closeTimer;
        let size = 0;
        const chunks = [];

        const settle = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearTimeout(closeTimer);
          controller.signal.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(result);
        };
        const stop = error => {
          if (stopReason || childClosed) return;
          stopReason = error;
          try { child.kill('SIGTERM'); } catch { /* Still wait for close. */ }
          killTimer = setTimeout(() => {
            if (!childClosed) try { child.kill('SIGKILL'); } catch { /* Still wait for close. */ }
          }, TERMINATE_GRACE_MS);
          closeTimer = setTimeout(() => {
            // The promise ends, but the exclusive latch remains held until actual close.
            settle(new NativeHelperError('helper-close-timeout'));
          }, CLOSE_DEADLINE_MS);
        };
        const onAbort = () => stop(controller.signal.reason);

        child.once('close', (exitCode, terminationSignal) => {
          childClosed = true;
          if (settled) {
            this.#busy = false;
            return;
          }
          if (stopReason) return settle(stopReason);
          if (terminationSignal || !Number.isInteger(exitCode)) return settle(new NativeHelperError('helper-terminated'));
          try {
            const result = validateResponse(Buffer.concat(chunks, size), exitCode, request);
            settle(null, { result, exitCode });
          } catch (error) {
            settle(error instanceof NativeHelperError ? error : new NativeHelperError('helper-invalid-output'));
          }
        });
        child.on('error', () => stop(new NativeHelperError('helper-spawn-failed')));
        if (!child.stdout || !child.stderr) {
          stop(new NativeHelperError('helper-spawn-failed'));
        } else {
          child.stdout.on('error', () => stop(new NativeHelperError('helper-output-failed')));
          child.stdout.on('data', chunk => {
            if (stopReason) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_OUTPUT_BYTES) return stop(new NativeHelperError('helper-output-too-large'));
            chunks.push(bytes);
          });
          child.stderr.on('error', () => stop(new NativeHelperError('helper-output-failed')));
          child.stderr.resume();
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
      if (!child || childClosed) this.#busy = false;
    }
  }
}
