const METHODS = new Set(['status', 'create', 'claim', 'finish', 'cancel']);
const MAX_FRAME_BYTES = 16384;
const COMMAND_TIMEOUT_MS = 5000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export class NativeHostChannel {
  constructor(socket, invalidated = () => {}) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    let fragments = [];
    let buffered = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });

    const dispatch = message => {
      if (!isRecord(message)) return this.close();
      if (Object.hasOwn(message, 'event')) {
        if (!hasKeys(message, ['event', 'requestId', 'reason']) || message.event !== 'invalidated'
          || typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 128
          || typeof message.reason !== 'string' || message.reason.length < 1 || message.reason.length > 128) {
          return this.close();
        }
        invalidated(message);
        return;
      }
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');
      if (hasResult === hasError || !hasKeys(message, ['id', hasResult ? 'result' : 'error'])) return this.close();
      const command = this.pending.get(message.id);
      if (!command) return this.close();
      if (hasError && (!isRecord(message.error) || typeof message.error.code !== 'string'
        || message.error.code.length < 1 || message.error.code.length > 128
        || (Object.hasOwn(message.error, 'message') && typeof message.error.message !== 'string'))) {
        return this.close();
      }
      clearTimeout(command.timer);
      this.pending.delete(message.id);
      if (hasError) {
        const error = new Error(message.error.code);
        error.code = message.error.code;
        command.reject(error);
      } else {
        command.resolve(message.result);
      }
    };

    socket.on('data', chunk => {
      if (this.closed) return;
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        while (start < bytes.length && !this.closed) {
          const newline = bytes.indexOf(10, start);
          const end = newline < 0 ? bytes.length : newline;
          const size = end - start;
          // Reserve a byte for the newline, even on a partial frame.
          if (buffered + size + 1 > MAX_FRAME_BYTES) return this.close();
          if (size > 0) {
            fragments.push(Buffer.from(bytes.subarray(start, end)));
            buffered += size;
          }
          if (newline < 0) return;
          const frame = Buffer.concat(fragments, buffered);
          fragments = [];
          buffered = 0;
          dispatch(JSON.parse(decoder.decode(frame)));
          start = newline + 1;
        }
      } catch { this.close(); }
    });
    socket.on('end', () => this.close());
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  call(method, args = {}) {
    if (this.closed || !METHODS.has(method)) return Promise.reject(new Error('native-channel-unavailable'));
    if (!Number.isSafeInteger(this.nextId)) {
      this.close();
      return Promise.reject(new Error('native-channel-unavailable'));
    }
    const id = this.nextId;
    let frame;
    try { frame = JSON.stringify({ id, method, args }) + '\n'; } catch {
      return Promise.reject(new Error('native-channel-invalid-request'));
    }
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.reject(new Error('native-channel-invalid-request'));
    this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.write(frame); } catch { this.close(); }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error('native-channel-closed'));
    }
    this.pending.clear();
    try { this.socket.destroy(); } catch { /* All pending work is already rejected. */ }
    try { this.onClose?.(); } catch { /* A callback cannot reopen the channel. */ }
  }
}
