/**
 * WebSocket capture: the global constructor is replaced by a subclass of the original that observes the
 * connection (open / frames both ways / error / close) without changing its behaviour. Statics, prototype
 * chain and `instanceof` keep working; sockets to the receiver / Metro / ignored URLs are not observed.
 */
import { bytesToBase64, completeUtf8Length, utf8ByteLength, utf8Decode, utf8Encode } from './encoding';
import { copyBytes, isArrayBufferLike, isBlobLike, readBlobBytes } from './body';
import type { Runtime } from './context';
import { activeRuntime, isIgnored } from './context';
import { headersInitToPairs } from './headers';
import type { ClientMessage, RnWsFrame } from './protocol';

type WsCtor = new (...args: unknown[]) => WebSocketLike;

interface WebSocketLike {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  protocol?: string;
  extensions?: string;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

interface SocketState {
  runtime: Runtime;
  wsId: string;
  /** Keeps frames in order when a binary payload must be read asynchronously (Blob). */
  chain: Promise<void>;
  clientClosed: boolean;
  closed: boolean;
}

function emit(state: SocketState, message: ClientMessage): void {
  state.chain = state.chain.then(() => {
    try {
      state.runtime.send(message, state.wsId);
    } catch {
      /* ignore */
    }
  });
}

function textFrame(state: SocketState, dir: 'in' | 'out', text: string): RnWsFrame {
  const cap = state.runtime.config.wsFrameCap;
  const size = utf8ByteLength(text);
  const frame: RnWsFrame = { wsId: state.wsId, dir, opcode: 'text', size, time: Date.now() };
  if (size <= cap) frame.text = text;
  else {
    const head = utf8Encode(text.slice(0, cap)).subarray(0, cap);
    frame.text = utf8Decode(head.subarray(0, completeUtf8Length(head)));
    frame.truncated = true;
  }
  return frame;
}

function binaryFrame(state: SocketState, dir: 'in' | 'out', bytes: Uint8Array, total: number, time: number): RnWsFrame {
  const frame: RnWsFrame = { wsId: state.wsId, dir, opcode: 'binary', base64: bytesToBase64(bytes), size: total, time };
  if (total > bytes.length) frame.truncated = true;
  return frame;
}

/** Record one frame; the payload is copied synchronously when it is mutable. */
function recordFrame(state: SocketState, dir: 'in' | 'out', data: unknown): void {
  if (state.closed && dir === 'out') return;
  const cap = state.runtime.config.wsFrameCap;
  if (typeof data === 'string') {
    emit(state, { t: 'ws-frame', data: textFrame(state, dir, data) });
    return;
  }
  const time = Date.now();
  if (isArrayBufferLike(data)) {
    const { bytes, total } = copyBytes(data, cap);
    emit(state, { t: 'ws-frame', data: binaryFrame(state, dir, bytes, total, time) });
    return;
  }
  if (isBlobLike(data)) {
    const read = readBlobBytes(data, cap).then(
      ({ bytes, total }): RnWsFrame => binaryFrame(state, dir, bytes, total, time),
      (): RnWsFrame => ({ wsId: state.wsId, dir, opcode: 'binary', size: data.size, truncated: true, base64: '', time }),
    );
    state.chain = state.chain.then(() =>
      read.then((frame) => {
        try {
          state.runtime.send({ t: 'ws-frame', data: frame }, state.wsId);
        } catch {
          /* ignore */
        }
      }),
    );
    return;
  }
  if (data !== undefined && data !== null) emit(state, { t: 'ws-frame', data: textFrame(state, dir, String(data)) });
}

function protocolList(protocols: unknown): string[] {
  if (typeof protocols === 'string') return protocols ? [protocols] : [];
  if (Array.isArray(protocols)) return protocols.map((p) => String(p));
  return [];
}

const states = new WeakMap<object, SocketState>();

function observe(runtime: Runtime, socket: WebSocketLike, args: unknown[]): void {
  const url = String(args[0]);
  if (isIgnored(runtime, url) || typeof socket.addEventListener !== 'function') return;
  const state: SocketState = { runtime, wsId: runtime.nextId('ws'), chain: Promise.resolve(), clientClosed: false, closed: false };
  states.set(socket, state);
  const options = args[2] as { headers?: unknown } | undefined;
  const headers = options && typeof options === 'object' && options.headers ? headersInitToPairs(options.headers) : [];
  emit(state, {
    t: 'ws-open',
    data: { wsId: state.wsId, url, protocols: protocolList(args[1]), ...(headers.length ? { headers } : {}), time: Date.now() },
  });
  const guard = (fn: (event: unknown) => void) => (event: unknown) => {
    try {
      fn(event);
    } catch {
      /* never surface into the app */
    }
  };
  socket.addEventListener(
    'open',
    guard(() => {
      emit(state, {
        t: 'ws-ready',
        data: { wsId: state.wsId, protocol: String(socket.protocol ?? ''), ...(socket.extensions ? { extensions: String(socket.extensions) } : {}), time: Date.now() },
      });
    }),
  );
  socket.addEventListener(
    'message',
    guard((event) => recordFrame(state, 'in', (event as { data?: unknown })?.data)),
  );
  socket.addEventListener(
    'error',
    guard((event) => {
      const message = (event as { message?: unknown })?.message;
      emit(state, { t: 'ws-error', data: { wsId: state.wsId, message: typeof message === 'string' && message ? message : 'WebSocket error', time: Date.now() } });
    }),
  );
  socket.addEventListener(
    'close',
    guard((event) => {
      if (state.closed) return;
      state.closed = true;
      const e = (event ?? {}) as { code?: unknown; reason?: unknown; wasClean?: unknown };
      emit(state, {
        t: 'ws-close',
        data: {
          wsId: state.wsId,
          ...(typeof e.code === 'number' ? { code: e.code } : {}),
          ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
          ...(typeof e.wasClean === 'boolean' ? { wasClean: e.wasClean } : {}),
          initiator: state.clientClosed ? 'client' : 'server',
          time: Date.now(),
        },
      });
    }),
  );
}

export interface WebSocketPatch {
  restore(): void;
}

/** Replace `target.WebSocket` with an observing subclass. */
export function installWebSocketHook(gen: number, target: Record<string, unknown>): WebSocketPatch | null {
  const Original = target.WebSocket as WsCtor | undefined;
  if (typeof Original !== 'function') return null;

  class WebSocket extends Original {
    constructor(...args: unknown[]) {
      super(...args);
      try {
        const runtime = activeRuntime(gen);
        if (runtime) observe(runtime, this, args);
      } catch {
        /* capture is best effort */
      }
    }

    send(data: unknown): void {
      // Validate first (the original throws while CONNECTING): record only what was actually sent.
      super.send(data);
      try {
        const state = states.get(this);
        if (state && activeRuntime(gen) === state.runtime) recordFrame(state, 'out', data);
      } catch {
        /* ignore */
      }
    }

    close(...args: unknown[]): void {
      try {
        const state = states.get(this);
        if (state) state.clientClosed = true;
      } catch {
        /* ignore */
      }
      // Forward exactly the arguments the app passed (close() and close(undefined) differ in some engines).
      (super.close as (...a: unknown[]) => void).apply(this, args);
    }
  }

  target.WebSocket = WebSocket;
  return {
    restore(): void {
      if (target.WebSocket === WebSocket) target.WebSocket = Original;
    },
  };
}
