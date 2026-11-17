import { randomUUID } from 'node:crypto';

// M2 is intentionally a closed, synthetic action. There is no native helper.
export const DEMO_OPERATION = 'demo.consume';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_DELAY_MS = 350;

function failure(code) {
  return { ok: false, code };
}

// Internal binding for the synthetic core. The public Fetch route is gated by
// Connection's owner check; Fetch does not reveal the calling Peer to us.
export function allowedPeer(peer, browserPeer) {
  return peer != null && peer === browserPeer && peer.principal?.kind === 'owner'
    && peer.interactions === 'answer' && peer.signal != null && !peer.signal.aborted;
}

export function syntheticBackend({ signal }, delayMs = DEFAULT_DELAY_MS) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('cancelled');
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('ready');
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve('cancelled');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SimulationCore {
  constructor({ browserPeer, backend = syntheticBackend, timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now, makeId = randomUUID } = {}) {
    if (!browserPeer || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('A browser Peer and a positive timeout are required');
    }
    this.browserPeer = browserPeer;
    this.backend = backend;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.makeId = makeId;
    this.current = null;
    this.disposed = false;
  }

  authorize(peer) {
    return !this.disposed && allowedPeer(peer, this.browserPeer);
  }

  begin(peer, operation) {
    if (this.disposed) return failure('disposed');
    if (!this.authorize(peer)) return failure('forbidden');
    if (operation !== DEMO_OPERATION) return failure('invalid-operation');
    if (this.current) return failure('busy');

    const id = this.makeId();
    const controller = new AbortController();
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });
    const record = { id, operation, peer, controller, finished, settle, state: 'pending',
      expiresAt: this.now() + this.timeoutMs, timer: null, peerAbort: null };
    this.current = record;
    record.timer = setTimeout(() => this.end(record, 'timeout'), this.timeoutMs);
    record.peerAbort = () => this.end(record, 'cancelled');
    peer.signal.addEventListener('abort', record.peerAbort, { once: true });

    Promise.resolve().then(() => {
      if (this.current !== record || record.state !== 'pending' || controller.signal.aborted) return;
      if (this.now() >= record.expiresAt) return this.end(record, 'timeout');
      return this.backend({ id, operation, signal: controller.signal });
    })
      .then((result) => {
        if (this.current !== record || record.state !== 'pending') return;
        if (this.now() >= record.expiresAt) return this.end(record, 'timeout');
        if (result !== 'ready') return this.end(record, result === 'cancelled' ? 'cancelled' : 'unexpected');
        record.state = 'ready';
        record.settle({ ok: true, state: 'ready' });
      }, () => this.end(record, 'unexpected'));
    return { ok: true, id, operation, expiresAt: record.expiresAt };
  }

  find(peer, id, operation) {
    if (this.disposed) return failure('disposed');
    if (!this.authorize(peer)) return failure('forbidden');
    const record = this.current;
    if (!record || record.id !== id || record.peer !== peer) return failure('unknown-request');
    if (record.operation !== operation) {
      this.end(record, 'operation-changed');
      return failure('operation-changed');
    }
    if (this.now() >= record.expiresAt) {
      this.end(record, 'timeout');
      return failure('timeout');
    }
    return record;
  }

  async wait(peer, id, operation, signal) {
    const record = this.find(peer, id, operation);
    if (record.ok === false) return record;
    if (signal?.aborted) {
      this.end(record, 'cancelled');
      return failure('cancelled');
    }
    const onAbort = () => this.end(record, 'cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await record.finished;
      // A ready settlement cannot survive a subsequent cancellation or expiry.
      if (result.ok && this.current !== record) return failure(record.state);
      if (result.ok && this.now() >= record.expiresAt) {
        this.end(record, 'timeout');
        return failure('timeout');
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  consume(peer, id, operation) {
    const record = this.find(peer, id, operation);
    if (record.ok === false) return record;
    if (record.state !== 'ready') return failure('not-ready');
    this.end(record, 'consumed');
    return { ok: true, state: 'consumed', operation: record.operation, id: record.id };
  }

  cancel(peer, id, operation) {
    const record = this.find(peer, id, operation);
    if (record.ok === false) return record;
    this.end(record, 'cancelled');
    return { ok: true, state: 'cancelled' };
  }

  end(record, state) {
    if (this.current !== record) return;
    this.current = null;
    record.state = state;
    clearTimeout(record.timer);
    record.peer.signal.removeEventListener('abort', record.peerAbort);
    record.controller.abort();
    record.settle(failure(state));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current) this.end(this.current, 'disposed');
  }
}
