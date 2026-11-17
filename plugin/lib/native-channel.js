import { fstatSync } from 'node:fs';
import net from 'node:net';
import { NativeCore, NativeCoreError } from './native-core.js';

export const NATIVE_CHANNEL_FD = 4;
export const MAX_NATIVE_FRAME_BYTES = 16_384;
const MAX_QUEUED_OUTPUT_BYTES = MAX_NATIVE_FRAME_BYTES * 4;
const CLOSE_FLUSH_TIMEOUT_MS = 1_000;
const METHODS = new Set(['create', 'claim', 'finish', 'cancel', 'status']);
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function validEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['id', 'method', 'args'].includes(key))
    || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'method')) return false;
  if (!(Number.isSafeInteger(value.id) && value.id >= 0)
    && !(typeof value.id === 'string' && ID.test(value.id))) return false;
  return typeof value.method === 'string' && value.method.length <= 32;
}

/**
 * Bind the one inherited, parent-owned duplex stream. Authentication is the
 * inherited channel itself: all native plugins in this Host share its trust
 * boundary and can access this process. No public route or fd3 is used.
 */
export function bindNativeChannel(socket, options = {}) {
  let closed = false;
  let closing = false;
  let fragments = [];
  let buffered = 0;
  const core = new NativeCore({ ...options, onInvalidated: (event) => send(event) });

  function close(reason) {
    if (closed || closing) return;
    closing = true;
    core.dispose(reason);
    closed = true;
    fragments = [];
    buffered = 0;
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    // Give an already-queued invalidation a chance to flush. A broken parent
    // must not keep the Host alive; EOF remains authoritative if it cannot.
    const timeout = setTimeout(() => socket.destroy(), CLOSE_FLUSH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      socket.end(() => {
        clearTimeout(timeout);
        socket.destroy();
      });
    } catch {
      clearTimeout(timeout);
      socket.destroy();
    }
  }

  function send(value) {
    if (closed || socket.destroyed || !socket.writable) return;
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    if (frame.length > MAX_NATIVE_FRAME_BYTES || socket.writableLength + frame.length > MAX_QUEUED_OUTPUT_BYTES) {
      close('disconnect');
      return;
    }
    try { socket.write(frame); } catch { close('disconnect'); }
  }

  function dispatch(value) {
    if (!validEnvelope(value)) {
      close('disconnect');
      return;
    }
    if (!METHODS.has(value.method)) {
      send({ id: value.id, error: { code: 'unknown-method', message: 'Unknown native method' } });
      return;
    }
    try {
      const result = core[value.method](value.args);
      send({ id: value.id, result });
    } catch (error) {
      if (error instanceof NativeCoreError) {
        send({ id: value.id, error: { code: error.code, message: error.message } });
      } else {
        send({ id: value.id, error: { code: 'internal-error', message: 'Native channel failed' } });
        close('disconnect');
      }
    }
  }

  function readFrame(frame) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      dispatch(JSON.parse(text));
    } catch {
      close('disconnect');
    }
  }

  function onData(chunk) {
    if (closed || closing) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && !closed && !closing) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const size = end - start;
      // Reserve one byte for the newline delimiter in the frame limit.
      if (buffered + size + 1 > MAX_NATIVE_FRAME_BYTES) {
        close('disconnect');
        return;
      }
      if (size > 0) {
        fragments.push(bytes.subarray(start, end));
        buffered += size;
      }
      if (newline < 0) return;
      const frame = Buffer.concat(fragments, buffered);
      fragments = [];
      buffered = 0;
      readFrame(frame);
      start = newline + 1;
    }
  }

  socket.on('data', onData);
  socket.on('end', () => close('disconnect'));
  socket.on('error', () => close('disconnect'));
  socket.on('close', () => close('disconnect'));
  return { dispose: () => close('dispose') };
}

/** Enable only when the lab parent explicitly supplied an inherited pipe. */
export function openNativeChannel({ env = process.env } = {}) {
  if (env.DSH_TOUCH_ID_NATIVE_CHANNEL !== '1') return null;
  const descriptor = fstatSync(NATIVE_CHANNEL_FD);
  if (!descriptor.isSocket() && !descriptor.isFIFO()) throw new Error('Native channel descriptor is not a pipe');
  const socket = new net.Socket({ fd: NATIVE_CHANNEL_FD, readable: true, writable: true });
  return bindNativeChannel(socket);
}
