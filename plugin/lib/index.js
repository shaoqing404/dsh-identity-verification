import { DEMO_OPERATION, SimulationCore } from './core.js';
import { openNativeChannel } from './native-channel.js';

export const inject = ['connection'];
export const ROUTE_PREFIX = '/api/touch-id-simulation/';
export const MAX_BODY_BYTES = 4096;
const METHODS = new Set(['begin', 'wait', 'consume', 'cancel']);

function validPayload(method, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (method === 'begin') return keys.length === 1 && keys[0] === 'operation'
    && typeof payload.operation === 'string';
  return keys.length === 2 && keys[0] === 'id' && keys[1] === 'operation'
    && typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 128
    && typeof payload.operation === 'string';
}

// The synthetic handler is private to the owner-gated Connection routes.
// It cannot invoke a helper or accept a caller-supplied result.
export function createHandler(core) {
  return async (endpoint, payload, signal, peer) => {
    const method = endpoint;
    if (!METHODS.has(method) || !validPayload(method, payload)) {
      return { ok: true, value: { ok: false, code: 'invalid-request' } };
    }
    if (!core.authorize(peer)) {
      return { ok: true, value: { ok: false, code: core.disposed ? 'disposed' : 'forbidden' } };
    }
    if (signal?.aborted) return { ok: true, value: { ok: false, code: 'cancelled' } };
    let value;
    switch (method) {
      case 'begin': value = core.begin(peer, payload.operation); break;
      case 'wait': value = await core.wait(peer, payload.id, payload.operation, signal); break;
      case 'consume': value = core.consume(peer, payload.id, payload.operation); break;
      case 'cancel': value = core.cancel(peer, payload.id, payload.operation); break;
    }
    return { ok: true, value };
  };
}

export function createRoute(method, handler, ownerToken) {
  return {
    path: ROUTE_PREFIX + method,
    methods: ['POST'],
    requestBody: 'streaming',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('unsupported content type', { status: 415 });
      }
      const reader = request.body?.getReader();
      if (!reader) return new Response('invalid request', { status: 400 });
      let body = '';
      let bytes = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BODY_BYTES) return new Response('request too large', { status: 413 });
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } catch {
        return new Response('invalid request', { status: 400 });
      } finally {
        reader.releaseLock();
      }
      let payload;
      try { payload = JSON.parse(body); } catch { return new Response('invalid request', { status: 400 }); }
      const result = await handler(method, payload, request.signal, ownerToken);
      return Response.json(result.value, { headers: { 'cache-control': 'no-store' } });
    }
  };
}

export function apply(ctx) {
  if (process.env.DSH_TOUCH_ID_NATIVE_CHANNEL === '1') {
    ctx.effect(() => {
      let channel;
      try { channel = openNativeChannel(); } catch { console.error('touch-id: private native channel unavailable'); }
      return () => channel?.dispose();
    }, 'touch-id: private native channel lifetime');
  }
  // Exact Fetch routes do not expose the calling Peer. Connection itself
  // enforces owner admission; this token is solely a synthetic core binding.
  const core = new SimulationCore({ browserPeer: ctx.connection.browserPeer });
  const handler = createHandler(core);
  for (const method of METHODS) {
    ctx.effect(() => ctx.connection.fetch.register(createRoute(method, handler, core.browserPeer)),
      `touch-id-simulation: ${method} synthetic route`);
  }
  ctx.effect(() => () => core.dispose(), 'touch-id-simulation: core lifetime');
}

export { DEMO_OPERATION };
