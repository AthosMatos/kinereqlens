/**
 * WebSocket capture (MAIN world). `window.WebSocket` is replaced by a constructor wrapper that builds the real
 * native socket (`Reflect.construct`, so subclasses, `instanceof`, the prototype and the static constants are
 * unchanged) and, while capture is not off, registers internal listeners on it before the page can add its own.
 * `WebSocket.prototype.send` / `close` are wrapped to record outgoing frames and page-initiated closes. The
 * page-observable behaviour never changes: natives run first-class with the page's receiver and arguments,
 * their exceptions propagate unchanged, and with capture off every wrapper is a single flag check.
 *
 * Events are queued and posted in batches (≤ WS_BATCH_MS) on the private port as `{t:'ws', events}`; frames
 * keep their order even when a Blob payload has to be read asynchronously. Payloads are capped at
 * WS_FRAME_CAP (text: UTF-8 bytes; binary: bytes, base64-encoded at flush time).
 */
import type { WsHookEvent } from '../lib/ws';
import { WS_BATCH_MS, WS_EVENTS_PER_MESSAGE, WS_FRAME_CAP, WS_HOOK_QUEUE_MAX } from '../lib/ws';
import { bytesToBase64 } from '../lib/encoding';
import { MODE_BUFFERING, MODE_OFF, MODE_ON, onModeChange, postToContent, state } from './channel';
import { replaceMethod } from './disguise';
import {
  addListener,
  arrayBufferIsView,
  blobArrayBuffer,
  blobSlice,
  call,
  clearTimer,
  defineProperty,
  errorText,
  getOwnPropertyDescriptor,
  INSTALL_TAG,
  isArray,
  mapDelete,
  mapGet,
  mapSet,
  NativeBlob,
  NativeMap,
  NativeUint8Array,
  NativeWeakMap,
  now,
  onSettled,
  setTimer,
  tagOf,
  W,
  weakMapGet,
  weakMapSet,
} from './natives';
import { copyBytes, textBody } from './serialize';
import { currentFrameUrl } from './util';
import { captureInitiatorStack } from './initiator';

/** Max payload characters per posted batch (the rest follows right after). */
const FLUSH_CHARS = 8 * 1024 * 1024;
/**
 * While capturing, a queue this long is posted at once instead of waiting for the batch timer: a burst of
 * messages can be dispatched back to back before any timer runs, and the queue must not overflow then.
 */
const FLUSH_EAGER = 500;
/** A Blob payload that takes longer than this to read is posted without its bytes (keeps the order moving). */
const PENDING_READ_MAX_MS = 5_000;
const OPEN = 1;
const CLOSING = 2;

interface Slot {
  /** Null while a Blob payload is being read. */
  ev: WsHookEvent | null;
  /** Fallback posted when the read takes too long. */
  pending?: WsHookEvent;
  /** Binary payload, encoded at flush time. */
  bytes?: Uint8Array;
  at: number;
  /** open / closing / close / error: posted even while capture is off (for sockets the store already knows). */
  lifecycle: boolean;
}

const queue: Slot[] = [];
let timer = 0;
let socketCount = 0;
const tracked = new NativeWeakMap<object, string>();
/** Open sockets by hook id (for the overlay's "Send message"); removed on close. */
const sockets = new NativeMap<string, WebSocket>();
let sendWrapper: Function | null = null;

type Getter = ((this: unknown) => unknown) | undefined;

function getter(target: object | undefined, key: string): Getter {
  try {
    return target ? (getOwnPropertyDescriptor(target, key)?.get as Getter) : undefined;
  } catch {
    return undefined;
  }
}

function read<T>(get: Getter, self: unknown, fallback: T): T {
  if (!get) return fallback;
  try {
    return call<T>(get, self);
  } catch {
    return fallback;
  }
}

const blobSize = getter(typeof Blob === 'function' ? Blob.prototype : undefined, 'size');
const messageData = getter(typeof MessageEvent === 'function' ? MessageEvent.prototype : undefined, 'data');
const closeCode = getter(typeof CloseEvent === 'function' ? CloseEvent.prototype : undefined, 'code');
const closeReason = getter(typeof CloseEvent === 'function' ? CloseEvent.prototype : undefined, 'reason');
const closeWasClean = getter(typeof CloseEvent === 'function' ? CloseEvent.prototype : undefined, 'wasClean');
const reflectConstruct = Reflect.construct;
const setPrototypeOf = Object.setPrototypeOf;
const getPrototypeOf = Object.getPrototypeOf;

// ------------------------------------------------------------------------------------------------- queue

function schedule(delay = WS_BATCH_MS): void {
  if (timer || state.mode === MODE_BUFFERING) return;
  timer = setTimer(flush, delay);
}

function enqueue(slot: Slot): Slot | null {
  // Frames are dropped under pressure (content script not answering yet); lifecycle events are kept.
  if (queue.length >= (slot.lifecycle ? WS_HOOK_QUEUE_MAX * 2 : WS_HOOK_QUEUE_MAX)) return null;
  queue.push(slot);
  if (state.mode === MODE_ON && queue.length >= FLUSH_EAGER && queue[0]!.ev) {
    if (timer) {
      clearTimer(timer);
      timer = 0;
    }
    flush();
  } else schedule();
  return slot;
}

function payloadChars(ev: WsHookEvent): number {
  return ev.e === 'frame' ? (ev.text?.length ?? 0) + (ev.base64?.length ?? 0) : 64;
}

function flush(): void {
  timer = 0;
  if (state.mode === MODE_BUFFERING) return;
  const off = state.mode === MODE_OFF;
  const t = now();
  const out: WsHookEvent[] = [];
  let chars = 0;
  let i = 0;
  for (; i < queue.length && out.length < WS_EVENTS_PER_MESSAGE && chars < FLUSH_CHARS; i++) {
    const slot = queue[i]!;
    if (!slot.ev) {
      if (t - slot.at < PENDING_READ_MAX_MS) break;
      slot.ev = slot.pending ?? null;
      if (!slot.ev) continue;
    }
    if (off && !slot.lifecycle) continue;
    let ev = slot.ev;
    if (slot.bytes && ev.e === 'frame') {
      try {
        ev = { ...ev, base64: bytesToBase64(slot.bytes) };
      } catch {
        ev = { ...ev, base64: '', truncated: true };
      }
    }
    out.push(ev);
    chars += payloadChars(ev);
  }
  queue.splice(0, i);
  if (out.length) postToContent({ t: 'ws', events: out });
  if (queue.length) schedule(queue[0]!.ev ? 0 : 25);
}

onModeChange(() => {
  if (state.mode === MODE_OFF) {
    // Paused / closed: frames (and new sockets) are not wanted; lifecycle events of known sockets still are.
    for (let i = queue.length - 1; i >= 0; i--) if (!queue[i]!.lifecycle) queue.splice(i, 1);
  }
  if (timer) {
    clearTimer(timer);
    timer = 0;
  }
  if (queue.length) schedule(0);
});

// ------------------------------------------------------------------------------------------------- frames

function isBlob(value: unknown): value is Blob {
  return value instanceof NativeBlob || (typeof value === 'object' && value !== null && tagOf(value) === '[object Blob]');
}

function isBufferSource(value: unknown): value is ArrayBuffer | ArrayBufferView {
  if (typeof value !== 'object' || value === null) return false;
  if (arrayBufferIsView(value)) return true;
  const tag = tagOf(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** Queue a frame of socket `id`. `data` is what was sent / received (string, Blob, BufferSource, other). */
function recordFrame(id: string, dir: 'in' | 'out', data: unknown): void {
  const time = now();
  if (typeof data === 'string') {
    const body = textBody(data, WS_FRAME_CAP);
    if (body.kind !== 'text') return;
    enqueue({
      ev: { e: 'frame', id, time, dir, opcode: 'text', text: body.text, size: body.size, truncated: body.truncated === true },
      at: time,
      lifecycle: false,
    });
    return;
  }
  if (isBufferSource(data)) {
    const { bytes, total } = copyBytes(data, WS_FRAME_CAP);
    enqueue({
      ev: { e: 'frame', id, time, dir, opcode: 'binary', base64: '', size: total, truncated: total > bytes.length },
      bytes,
      at: time,
      lifecycle: false,
    });
    return;
  }
  if (isBlob(data)) {
    const size = read<number>(blobSize, data, 0);
    const base: WsHookEvent = { e: 'frame', id, time, dir, opcode: 'binary', base64: '', size, truncated: size > WS_FRAME_CAP };
    const slot = enqueue({ ev: null, pending: { ...base, truncated: true }, at: time, lifecycle: false });
    if (!slot) return;
    const part = size > WS_FRAME_CAP ? call<Blob>(blobSlice, data, [0, WS_FRAME_CAP]) : data;
    onSettled(
      call<Promise<ArrayBuffer>>(blobArrayBuffer, part),
      (buffer) => {
        slot.bytes = new NativeUint8Array(buffer);
        slot.ev = base;
        schedule();
      },
      () => {
        slot.ev = slot.pending ?? null;
        schedule();
      },
    );
    return;
  }
  // Anything else was converted with ToString by the native; repeating that could run page code twice.
  const text = data === null || (typeof data !== 'object' && typeof data !== 'function' && typeof data !== 'symbol') ? String(data) : '';
  const body = textBody(text, WS_FRAME_CAP);
  if (body.kind !== 'text') return;
  enqueue({
    ev: { e: 'frame', id, time, dir, opcode: 'text', text: body.text, size: body.size, truncated: text === '' || body.truncated === true },
    at: time,
    lifecycle: false,
  });
}

// ------------------------------------------------------------------------------------------------- sockets

function protocolList(value: unknown): string[] {
  // Only plain values: reading an iterable again (the native already consumed it) could differ or run page code.
  if (typeof value === 'string') return [value];
  if (isArray(value)) return value.filter((p): p is string => typeof p === 'string').slice(0, 32);
  return [];
}

function track(socket: WebSocket, protocols: unknown, getters: SocketGetters): void {
  const id = `w${++socketCount}${INSTALL_TAG}`;
  call(weakMapSet, tracked, [socket, id]);
  call(mapSet, sockets, [id, socket]);
  const time = now();
  const initiatorStack = captureInitiatorStack();
  enqueue({
    ev: {
      e: 'new',
      id,
      time,
      url: String(read(getters.url, socket, '')),
      protocols: protocolList(protocols),
      frameUrl: currentFrameUrl(),
      ...(initiatorStack ? { initiatorStack } : {}),
    },
    at: time,
    lifecycle: false,
  });
  // Registered at construction, i.e. before any listener of the page.
  addListener(socket, 'open', () => {
    try {
      const t = now();
      enqueue({
        ev: {
          e: 'open',
          id,
          time: t,
          protocol: String(read(getters.protocol, socket, '')),
          extensions: String(read(getters.extensions, socket, '')),
        },
        at: t,
        lifecycle: true,
      });
    } catch {
      /* never surface kineReqLens errors */
    }
  });
  addListener(socket, 'message', (event) => {
    if (state.mode === MODE_OFF) return;
    try {
      recordFrame(id, 'in', read(messageData, event, undefined));
    } catch {
      /* idem */
    }
  });
  addListener(socket, 'close', (event) => {
    try {
      call(mapDelete, sockets, [id]);
      const t = now();
      enqueue({
        ev: {
          e: 'close',
          id,
          time: t,
          code: read<number>(closeCode, event, 1005),
          reason: String(read(closeReason, event, '')),
          wasClean: read<boolean>(closeWasClean, event, false) === true,
        },
        at: t,
        lifecycle: true,
      });
    } catch {
      /* idem */
    }
  });
  addListener(socket, 'error', () => {
    try {
      const t = now();
      enqueue({ ev: { e: 'error', id, time: t }, at: t, lifecycle: true });
    } catch {
      /* idem */
    }
  });
}

interface SocketGetters {
  url: Getter;
  protocol: Getter;
  extensions: Getter;
  readyState: Getter;
}

function trackedId(socket: unknown): string | undefined {
  try {
    return call<string | undefined>(weakMapGet, tracked, [socket]);
  } catch {
    return undefined;
  }
}

/**
 * Send `text` through the page's socket `wsId` (the overlay's "Send message", an explicit user action). The
 * frame is recorded like any page send.
 */
export function wsSend(wsId: unknown, text: unknown): { ok: boolean; error?: string } {
  if (typeof wsId !== 'string' || typeof text !== 'string') return { ok: false, error: 'Invalid message' };
  const socket = call<WebSocket | undefined>(mapGet, sockets, [wsId]);
  const send = sendWrapper;
  if (!socket || !send) return { ok: false, error: 'This connection is no longer open' };
  try {
    call(send, socket, [text]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** Replace window.WebSocket and wrap WebSocket.prototype.send / close (no-op without WebSocket). */
export function installWsHook(): void {
  const Native = typeof W.WebSocket === 'function' ? W.WebSocket : undefined;
  if (!Native) return;
  const proto = Native.prototype;
  const getters: SocketGetters = {
    url: getter(proto, 'url'),
    protocol: getter(proto, 'protocol'),
    extensions: getter(proto, 'extensions'),
    readyState: getter(proto, 'readyState'),
  };
  const nativeSend = proto.send;
  const nativeClose = proto.close;

  const wrapper = function WebSocket(this: unknown): WebSocket {
    if (new.target === undefined) {
      throw new TypeError(
        "Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      );
    }
    // eslint-disable-next-line prefer-rest-params
    const args = arguments;
    const socket = reflectConstruct(Native, args, new.target === wrapper ? Native : new.target) as WebSocket;
    if (state.mode !== MODE_OFF) {
      try {
        track(socket, args.length > 1 ? args[1] : undefined, getters);
      } catch {
        /* the socket works untracked */
      }
    }
    return socket;
  };

  // Same shape as the native interface object: prototype, constants, [[Prototype]] (EventTarget).
  defineProperty(wrapper, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false });
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    const descriptor = getOwnPropertyDescriptor(Native, key);
    if (descriptor) defineProperty(wrapper, key, descriptor);
  }
  setPrototypeOf(wrapper, getPrototypeOf(Native));

  const send = {
    send(this: WebSocket, _data: unknown): void {
      // eslint-disable-next-line prefer-rest-params
      if (state.mode === MODE_OFF) return call(nativeSend, this, arguments);
      const id = trackedId(this);
      const wasOpen = id !== undefined && read<number>(getters.readyState, this, 0) === OPEN;
      // eslint-disable-next-line prefer-rest-params
      const result = call<void>(nativeSend, this, arguments);
      // Sends on a closing / closed socket are discarded by the browser: nothing went out.
      if (wasOpen) {
        try {
          recordFrame(id!, 'out', _data);
        } catch {
          /* never break the page */
        }
      }
      return result;
    },
  }.send;

  const close = {
    close(this: WebSocket, code?: unknown, reason?: unknown): void {
      // eslint-disable-next-line prefer-rest-params
      if (state.mode === MODE_OFF) return call(nativeClose, this, arguments);
      const id = trackedId(this);
      const before = id !== undefined ? read<number>(getters.readyState, this, 3) : 3;
      // eslint-disable-next-line prefer-rest-params
      const result = call<void>(nativeClose, this, arguments);
      if (id !== undefined && before < CLOSING) {
        try {
          const time = now();
          const ev: WsHookEvent = { e: 'closing', id, time };
          if (typeof code === 'number') ev.code = code;
          if (typeof reason === 'string') ev.reason = reason;
          enqueue({ ev, at: time, lifecycle: true });
        } catch {
          /* idem */
        }
      }
      return result;
    },
  }.close;

  replaceMethod(proto, 'send', nativeSend, send);
  replaceMethod(proto, 'close', nativeClose, close);
  sendWrapper = send;
  // `socket.constructor === WebSocket` keeps holding for the page.
  defineProperty(proto, 'constructor', { value: wrapper, writable: true, enumerable: false, configurable: true });
  replaceMethod(W, 'WebSocket', Native, wrapper);
}
