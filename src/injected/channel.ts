/**
 * Hook side of the MAIN-world <-> content-script channel: handshake, private MessagePort, capture mode
 * (buffering / on / off) and ordered emission of 'start' / 'end' messages.
 *
 * Ordering guarantees per capture: 'start' is emitted once the request body snapshot is serialized and
 * 'end' is always emitted after its 'start' (an early end is queued on the capture).
 */
import { DEFAULT_HOOK_CONFIG, HOOK_BUFFER_MAX, HOOK_BUFFER_TIMEOUT_MS } from '../shared/constants';
import { HANDSHAKE_KEY, PROTOCOL_VERSION } from '../shared/messages';
import type { HookToContent } from '../shared/messages';
import type { HookConfig, HookRequestEnd, HookRequestStart, ReplayResult } from '../shared/types';
import type { ComponentLocateResult } from '../shared/initiator-protocol';
import {
  addListener,
  call,
  clearTimer,
  INSTALL_TAG,
  isObjectLike,
  mapDelete,
  mapForEach,
  mapSet,
  NativeMap,
  portPostMessage,
  portStart,
  postToWindow,
  setTimer,
  stopImmediatePropagationFn,
  W,
} from './natives';

/** Capture modes: buffering until the content script answers, capturing, or pure pass-through. */
export const MODE_BUFFERING = 0;
export const MODE_ON = 1;
export const MODE_OFF = 2;
type Mode = typeof MODE_BUFFERING | typeof MODE_ON | typeof MODE_OFF;

/** Shared hook state. Wrappers check `state.mode === MODE_OFF` first and then pass straight through. */
export const state: { mode: Mode; config: HookConfig } = {
  mode: MODE_BUFFERING,
  config: { ...DEFAULT_HOOK_CONFIG },
};

/**
 * Internal handshake acknowledgement, posted on every adopted port so the content script knows the hook is
 * connected. It never leaves the content script (not part of the shared HookToContent union).
 */
type HookOutgoing = HookToContent | { t: 'ready'; v: number };

const STATUS_PENDING = 0;
const STATUS_BUFFERED = 1;
const STATUS_SENT = 2;
const STATUS_DROPPED = 3;

/** One request being captured. */
export interface Capture {
  readonly hookId: string;
  status: number;
  startEmitted: boolean;
  ended: boolean;
  queuedEnd: HookRequestEnd | null;
}

/** Replay handlers the channel dispatches port messages to (implemented in replay.ts). */
export interface ChannelHandlers {
  /** `{t:'replay'}` from the content script; `reply` posts the result back on the same port. */
  replay(data: unknown, reply: (result: ReplayResult) => void): void;
  abort(runId: unknown): void;
  /** `{t:'ws-send'}`: send a text message through one of the page's sockets (wsHook.ts). */
  wsSend?(wsId: unknown, text: unknown): { ok: boolean; error?: string };
  /** `{t:'components'}`: find components by name in the page's UI tree (components.ts). */
  components?(names: unknown, scroll: unknown): ComponentLocateResult;
  /** `{t:'lang'}`: the "Site language" override of this tab (language.ts). */
  lang?(languages: unknown): void;
}

let currentPort: MessagePort | null = null;
let handlers: ChannelHandlers | null = null;
let bufferTimer = 0;
let bufferedCaptures = 0;
const buffer: Array<{ capture: Capture; message: HookToContent }> = [];
let captureCount = 0;
/** Body reads of kineReqLens' own response clones in progress, so capture-off can release them at once. */
const activeReads = new NativeMap<Capture, () => void>();
/** Called after every mode switch (wsHook flushes or drops its queue). */
const modeListeners: Array<() => void> = [];

/** Run `fn` after every capture mode change. */
export function onModeChange(fn: () => void): void {
  modeListeners.push(fn);
}

/** Post a message on the current port whatever the mode (callers decide what may be sent). False without port. */
export function postToContent(message: HookToContent): boolean {
  if (!currentPort) return false;
  post(currentPort, message);
  return true;
}

/** Hook-local capture id: never touches page globals (Math.random) at call time. */
function nextHookId(): string {
  captureCount++;
  return `${captureCount}${INSTALL_TAG}`;
}

/**
 * Register the early stop of a body read (cancels kineReqLens' branch, the read resolves with what it has).
 * Called when capture switches off. Returns the unregister function.
 */
export function trackRead(capture: Capture, stop: () => void): () => void {
  call(mapSet, activeReads, [capture, stop]);
  return () => {
    call(mapDelete, activeReads, [capture]);
  };
}

function stopActiveReads(): void {
  const stops: Array<() => void> = [];
  call(mapForEach, activeReads, [(stop: () => void) => stops.push(stop)]);
  for (const stop of stops) {
    try {
      stop();
    } catch {
      /* already finished */
    }
  }
}

function post(port: MessagePort, message: HookOutgoing): void {
  try {
    call(portPostMessage, port, [message]);
  } catch {
    /* DataCloneError or closed port: drop */
  }
}

/** Start capturing a request, or null when capture is off (or the startup buffer is full). */
export function beginCapture(): Capture | null {
  if (state.mode === MODE_OFF) return null;
  if (state.mode === MODE_BUFFERING) {
    if (bufferedCaptures >= HOOK_BUFFER_MAX) return null;
    bufferedCaptures++;
  }
  return { hookId: nextHookId(), status: STATUS_PENDING, startEmitted: false, ended: false, queuedEnd: null };
}

/** Forget a capture whose request never happened (its start has not been emitted yet). */
export function dropCapture(capture: Capture): void {
  capture.status = STATUS_DROPPED;
  capture.queuedEnd = null;
}

/** True when nothing more will be emitted for this capture, so body reads can stop early. */
export function isDropped(capture: Capture): boolean {
  return capture.status === STATUS_DROPPED || (state.mode === MODE_OFF && capture.status !== STATUS_SENT);
}

/** Post (or buffer) the 'start' of a capture, then any end that arrived before it. */
export function emitStart(capture: Capture, data: HookRequestStart): void {
  if (capture.startEmitted || capture.status === STATUS_DROPPED) return;
  capture.startEmitted = true;
  const message: HookToContent = { t: 'start', data };
  if (state.mode === MODE_ON && currentPort) {
    capture.status = STATUS_SENT;
    post(currentPort, message);
  } else if (state.mode === MODE_BUFFERING) {
    capture.status = STATUS_BUFFERED;
    buffer.push({ capture, message });
  } else {
    dropCapture(capture);
    return;
  }
  const queued = capture.queuedEnd;
  if (queued) {
    capture.queuedEnd = null;
    emitEnd(capture, queued);
  }
}

/** Post (or buffer) the 'end' of a capture; queued until its 'start' was emitted. */
export function emitEnd(capture: Capture, data: HookRequestEnd): void {
  if (capture.ended || capture.status === STATUS_DROPPED) return;
  if (!capture.startEmitted) {
    capture.queuedEnd = data;
    return;
  }
  capture.ended = true;
  const message: HookToContent = { t: 'end', data };
  if (capture.status === STATUS_SENT) {
    if (currentPort) post(currentPort, message);
  } else if (capture.status === STATUS_BUFFERED) {
    buffer.push({ capture, message });
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sanitizeConfig(value: unknown): HookConfig {
  const config = isObjectLike(value) ? value : {};
  return {
    captureResponseBodies:
      typeof config.captureResponseBodies === 'boolean'
        ? config.captureResponseBodies
        : DEFAULT_HOOK_CONFIG.captureResponseBodies,
    requestBodyCap: positiveInt(config.requestBodyCap, DEFAULT_HOOK_CONFIG.requestBodyCap),
    responseBodyCap: positiveInt(config.responseBodyCap, DEFAULT_HOOK_CONFIG.responseBodyCap),
  };
}

function stopBuffering(): void {
  if (bufferTimer) clearTimer(bufferTimer);
  bufferTimer = 0;
  bufferedCaptures = 0;
}

function setMode(mode: unknown, config: unknown): void {
  if (mode !== 'on' && mode !== 'off') return;
  state.config = sanitizeConfig(config);
  const items = buffer.splice(0, buffer.length);
  stopBuffering();
  if (mode === 'on') {
    state.mode = MODE_ON;
    for (const { capture, message } of items) {
      if (capture.status === STATUS_DROPPED) continue;
      capture.status = STATUS_SENT;
      if (currentPort) post(currentPort, message);
    }
  } else {
    state.mode = MODE_OFF;
    for (const { capture } of items) dropCapture(capture);
    // Overlay closed / paused: stop reading response streams now (a still-open stream would otherwise keep
    // its connection busy until the read window ends); captures already sent end with what was read.
    stopActiveReads();
  }
  for (const fn of modeListeners) {
    try {
      fn();
    } catch {
      /* one hook's failure must not stop the others */
    }
  }
}

function onPortMessage(port: MessagePort, event: Event): void {
  try {
    const data: unknown = (event as MessageEvent).data;
    if (!isObjectLike(data)) return;
    // Only the latest content script controls capture: a replaced (or orphaned, after an extension reload)
    // instance must not switch capture off for its successor.
    if (data.t === 'mode') {
      if (port === currentPort) setMode(data.mode, data.config);
    }
    else if (data.t === 'lang') {
      if (port === currentPort) handlers?.lang?.(data.languages);
    }
    else if (data.t === 'replay') handlers?.replay(data.data, (result) => post(port, { t: 'replay-result', data: result }));
    else if (data.t === 'abort') handlers?.abort(data.runId);
    else if (data.t === 'ws-send' && handlers?.wsSend) {
      const result = handlers.wsSend(data.wsId, data.text);
      post(port, { t: 'ws-send-result', reqId: typeof data.reqId === 'number' ? data.reqId : 0, ...result });
    } else if (data.t === 'components' && handlers?.components) {
      const result = handlers.components(data.names, data.scroll);
      post(port, { t: 'components-result', reqId: typeof data.reqId === 'number' ? data.reqId : 0, data: result });
    }
  } catch {
    /* ignore malformed messages */
  }
}

/** Latest 'connect' wins; earlier ports keep receiving replies to replays they requested. */
function adopt(port: MessagePort): void {
  addListener(port, 'message', (event) => onPortMessage(port, event));
  call(portStart, port);
  currentPort = port;
  post(port, { t: 'ready', v: PROTOCOL_VERSION });
}

function onWindowMessage(event: Event): void {
  try {
    const message = event as MessageEvent;
    if (message.source !== W) return;
    const data: unknown = message.data;
    if (!isObjectLike(data) || data[HANDSHAKE_KEY] !== 'connect' || data.v !== PROTOCOL_VERSION) return;
    const port = message.ports && message.ports[0];
    if (!port) return;
    // Our private handshake is not the page's business.
    call(stopImmediatePropagationFn, event);
    adopt(port);
  } catch {
    /* ignore */
  }
}

/** Listen for 'connect', announce ourselves with 'hello' and arm the startup-buffer timeout. */
export function startChannel(channelHandlers: ChannelHandlers): void {
  handlers = channelHandlers;
  // Capture phase on the target itself: runs before any listener the page adds later.
  addListener(W, 'message', onWindowMessage, true);
  bufferTimer = setTimer(() => {
    bufferTimer = 0;
    if (state.mode === MODE_BUFFERING) setMode('off', state.config);
  }, HOOK_BUFFER_TIMEOUT_MS);
  postToWindow({ [HANDSHAKE_KEY]: 'hello', v: PROTOCOL_VERSION });
}
