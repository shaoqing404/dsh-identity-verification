import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const NATIVE_TIMEOUT_MS = 30_000;
export const NATIVE_CALLER_ID = 'dsh-touch-id.self-check';
export const NATIVE_ACTION_ID = 'demo_verify';
export const NATIVE_ACTION_TITLE = '身份验证自检';
export const NATIVE_POLICIES = Object.freeze(['system-owner', 'biometrics-only']);
const OUTCOMES = new Set(['granted', 'cancelled', 'unavailable', 'timeout', 'error']);
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const REASON = /^[a-z][a-z0-9-]{0,63}$/u;

export class NativeCoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeCoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeCoreError(code, message);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireBinding(args, extra = []) {
  if (!exactKeys(args, ['requestId', 'callerId', 'clientId', ...extra])
    || typeof args.requestId !== 'string' || args.requestId.length === 0 || args.requestId.length > 128
    || args.callerId !== NATIVE_CALLER_ID || typeof args.clientId !== 'string' || !CLIENT_ID.test(args.clientId)) {
    fail('invalid-request', 'Invalid request binding');
  }
}

/**
 * Per-launch, single-action authorization state. This is not an access boundary
 * against other native plugins running inside the same DSH Host process.
 * Only the inherited private channel is allowed to call this core in production.
 */
export class NativeCore {
  constructor({
    onInvalidated = () => {},
    now = Date.now,
    monotonic = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    makeId = randomUUID,
  } = {}) {
    this.onInvalidated = onInvalidated;
    this.now = now;
    this.monotonic = monotonic;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.makeId = makeId;
    this.current = null;
    this.disposed = false;
  }

  ensureOpen() {
    if (this.disposed) fail('unavailable', 'Native channel is unavailable');
    if (this.current && this.monotonic() >= this.current.monotonicDeadline) this.invalidate('timeout');
  }

  status(args) {
    this.ensureOpen();
    if (args !== undefined && !exactKeys(args, [])) fail('invalid-request', 'Status takes no arguments');
    return {
      available: true,
      active: this.current !== null,
      callerId: NATIVE_CALLER_ID,
      actionId: NATIVE_ACTION_ID,
      title: NATIVE_ACTION_TITLE,
      policies: [...NATIVE_POLICIES],
    };
  }

  create(args) {
    this.ensureOpen();
    if (!exactKeys(args, ['callerId', 'clientId', 'policy']) || args.callerId !== NATIVE_CALLER_ID
      || typeof args.clientId !== 'string' || !CLIENT_ID.test(args.clientId)
      || !NATIVE_POLICIES.includes(args.policy)) {
      fail('invalid-request', 'Invalid caller, client or policy');
    }
    if (this.current) fail('busy', 'Another verification is active');
    const request = {
      requestId: this.makeId(),
      callerId: NATIVE_CALLER_ID,
      clientId: args.clientId,
      actionId: NATIVE_ACTION_ID,
      title: NATIVE_ACTION_TITLE,
      policy: args.policy,
      deadline: this.now() + NATIVE_TIMEOUT_MS,
      monotonicDeadline: this.monotonic() + NATIVE_TIMEOUT_MS,
      state: 'pending',
      timer: undefined,
    };
    this.current = request;
    // A timer may fire early; expire() rechecks the monotonic deadline.
    request.timer = this.setTimer(() => this.expire(request), NATIVE_TIMEOUT_MS);
    request.timer?.unref?.();
    return { ok: true, ...this.snapshot(request) };
  }

  expire(request) {
    if (this.current !== request) return;
    const remaining = request.monotonicDeadline - this.monotonic();
    if (remaining > 0) {
      request.timer = this.setTimer(() => this.expire(request), remaining);
      request.timer?.unref?.();
      return;
    }
    this.invalidate('timeout');
  }

  snapshot(request) {
    const { requestId, callerId, clientId, actionId, title, policy, deadline } = request;
    return { requestId, callerId, clientId, actionId, title, policy, deadline };
  }

  bound(args, extra) {
    this.ensureOpen();
    requireBinding(args, extra);
    const request = this.current;
    if (!request || args.requestId !== request.requestId || args.callerId !== request.callerId
      || args.clientId !== request.clientId) {
      fail('invalid-binding', 'No active request matches this binding');
    }
    return request;
  }

  claim(args) {
    const request = this.bound(args, []);
    if (request.state !== 'pending') fail('invalid-state', 'Request cannot be claimed again');
    request.state = 'verifying';
    return { ok: true, ...this.snapshot(request), state: request.state };
  }

  finish(args) {
    const request = this.bound(args, ['outcome', 'reason']);
    if (!OUTCOMES.has(args.outcome) || typeof args.reason !== 'string' || !REASON.test(args.reason)) {
      fail('invalid-request', 'Invalid outcome or reason classifier');
    }
    if (request.state !== 'verifying') fail('invalid-state', 'Request has not been claimed');
    this.current = null;
    this.clearTimer(request.timer);
    const { requestId, callerId, clientId, actionId, policy } = request;
    return { ok: true, requestId, callerId, clientId, actionId, policy, outcome: args.outcome, reason: args.reason };
  }

  cancel(args) {
    const request = this.bound(args, []);
    this.invalidate('cancelled');
    return { ok: true, requestId: request.requestId };
  }

  invalidate(reason) {
    const request = this.current;
    if (!request) return;
    this.current = null;
    this.clearTimer(request.timer);
    this.onInvalidated({ event: 'invalidated', requestId: request.requestId, reason });
  }

  dispose(reason = 'dispose') {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate(reason);
  }
}
