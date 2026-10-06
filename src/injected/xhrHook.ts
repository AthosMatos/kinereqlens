/**
 * XMLHttpRequest wrappers (open / setRequestHeader / send on the prototype). Native methods always run with
 * the page's receiver and arguments; their exceptions propagate unchanged. Per-instance state lives in a
 * WeakMap; `open` resets it, so reused XHR objects produce one capture per send.
 */
import type { HeaderPair, HookRequestEnd, SerializedBody } from '../shared/types';
import { parseHeaderBlock } from '../lib/headers';
import type { Capture } from './channel';
import { beginCapture, dropCapture, emitEnd, MODE_OFF, state } from './channel';
import { replaceMethod } from './disguise';
import {
  addListener,
  call,
  errorName,
  errorText,
  jsonStringify,
  NativePromise,
  NativeWeakMap,
  NativeXHR,
  now,
  onSettled,
  toPromise,
  weakMapGet,
  weakMapSet,
} from './natives';
import type { Deferred } from './serialize';
import { blobBody, copyBytes, NO_BODY, responseBytesBody, serializeDocument, snapshotBody, textBody, unavailable } from './serialize';
import { currentFrameUrl, findHeader, normalizeMethod, resolveRequestUrl, scheduleStart } from './util';
import { captureInitiatorStack } from './initiator';

type Outcome = 'done' | 'error' | 'aborted';

interface ResponsePart {
  status: number;
  statusText: string;
  headers: HeaderPair[];
  responseUrl: string;
  body: SerializedBody | null;
}

interface XhrCapture {
  capture: Capture;
  url: string;
  finished: boolean;
  outcome: Outcome | null;
  error?: string;
  /** Snapshot taken when the request reached DONE (before page handlers can reuse the object). */
  response: Deferred<ResponsePart> | null;
  /** xhr.status at DONE (0 for network errors, aborts and timeouts). */
  doneStatus: number;
}

interface XhrState {
  /** False when the last open() happened while capture was off. */
  valid: boolean;
  method: string;
  url: string;
  async: boolean;
  headers: HeaderPair[];
  listening: boolean;
  current: XhrCapture | null;
}

const states = new NativeWeakMap<XMLHttpRequest, XhrState>();
const OPENED = 1;
const DONE = 4;

function getState(xhr: XMLHttpRequest): XhrState | undefined {
  return call<XhrState | undefined>(weakMapGet, states, [xhr]);
}

function stripHash(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

function readBody(xhr: XMLHttpRequest, contentType: string | null): Deferred<SerializedBody | null> {
  const { captureResponseBodies, responseBodyCap: cap } = state.config;
  if (!captureResponseBodies) return unavailable('Response body capture is turned off in settings');
  const type = xhr.responseType;
  switch (type) {
    case '':
    case 'text':
      return textBody(xhr.responseText, cap);
    case 'json': {
      const value: unknown = xhr.response;
      return textBody(String(jsonStringify(value)), cap);
    }
    case 'arraybuffer': {
      const buffer = xhr.response as ArrayBuffer | null;
      if (!buffer) return null;
      const { bytes, total } = copyBytes(buffer, cap);
      return responseBytesBody(bytes, total, total > bytes.length, contentType);
    }
    case 'blob': {
      const blob = xhr.response as Blob | null;
      return blob ? blobBody(blob, cap, contentType)() : null;
    }
    case 'document': {
      const doc = xhr.response as Document | null;
      return doc ? textBody(serializeDocument(doc), cap) : null;
    }
    default:
      return unavailable(`responseType "${String(type)}" is not captured`);
  }
}

/** Snapshot status/headers/body as soon as the request is DONE (before page load handlers run). */
function snapshotResponse(xhr: XMLHttpRequest): Deferred<ResponsePart> {
  const status = xhr.status;
  const headers = status ? parseHeaderBlock(xhr.getAllResponseHeaders()) : [];
  const part: ResponsePart = { status, statusText: xhr.statusText, headers, responseUrl: xhr.responseURL, body: null };
  if (!status) return part;
  let body: Deferred<SerializedBody | null>;
  try {
    body = readBody(xhr, findHeader(headers, 'content-type'));
  } catch {
    body = unavailable('The response body could not be read');
  }
  if (!(body instanceof NativePromise)) {
    part.body = body;
    return part;
  }
  return new NativePromise<ResponsePart>((resolve) => {
    onSettled(
      body as Promise<SerializedBody | null>,
      (value) => resolve({ ...part, body: value }),
      () => resolve({ ...part, body: unavailable('The response body could not be read') }),
    );
  });
}

function buildEnd(xc: XhrCapture, part: ResponsePart): HookRequestEnd {
  const outcome: Outcome = xc.outcome ?? (part.status ? 'done' : 'error');
  const end: HookRequestEnd = { hookId: xc.capture.hookId, state: outcome, endTime: now() };
  if (outcome !== 'done') end.error = xc.error ?? 'Network error';
  if (part.status) {
    end.status = part.status;
    end.statusText = part.statusText;
    end.headers = part.headers;
    end.body = part.body;
    if (part.responseUrl) {
      end.responseUrl = part.responseUrl;
      end.redirected = stripHash(part.responseUrl) !== stripHash(xc.url);
    }
  }
  return end;
}

function finish(xhr: XMLHttpRequest, xc: XhrCapture): void {
  if (xc.finished) return;
  xc.finished = true;
  let response: Deferred<ResponsePart>;
  try {
    response = xc.response ?? (xhr.readyState === DONE ? snapshotResponse(xhr) : emptyPart());
  } catch {
    response = emptyPart();
  }
  onSettled(
    toPromise(response),
    (part) => emitEnd(xc.capture, buildEnd(xc, part)),
    () => emitEnd(xc.capture, buildEnd(xc, emptyPart())),
  );
}

function emptyPart(): ResponsePart {
  return { status: 0, statusText: '', headers: [], responseUrl: '', body: null };
}

function setOutcome(st: XhrState, outcome: Outcome, error?: string): void {
  const xc = st.current;
  if (xc && !xc.finished && !xc.outcome) {
    xc.outcome = outcome;
    if (error) xc.error = error;
  }
}

/** Take the response snapshot once the request is DONE (idempotent). */
function snapshotIfDone(xhr: XMLHttpRequest, xc: XhrCapture): void {
  if (xc.finished || xc.response || xhr.readyState !== DONE) return;
  xc.doneStatus = xhr.status;
  xc.response = snapshotResponse(xhr);
}

/**
 * Our listeners are added once per XHR object and act on the state's current capture. Every terminal event
 * (load / error / abort / timeout / loadend) is dispatched while readyState is DONE; when a page handler that
 * ran before ours re-opened the object, readyState is no longer DONE and the event belongs to the superseded
 * request (already finished by `afterOpen`), so it must not touch the new capture.
 */
function ensureListeners(xhr: XMLHttpRequest, st: XhrState): void {
  if (st.listening) return;
  st.listening = true;
  const on = (type: string, handler: () => void): void =>
    addListener(xhr, type, () => {
      try {
        if (xhr.readyState === DONE) handler();
      } catch {
        /* never surface to window.onerror */
      }
    });
  on('readystatechange', () => {
    if (st.current) snapshotIfDone(xhr, st.current);
  });
  on('load', () => setOutcome(st, 'done'));
  on('error', () => setOutcome(st, 'error', 'Network error'));
  on('abort', () => setOutcome(st, 'aborted', 'Aborted'));
  on('timeout', () => setOutcome(st, 'error', 'Timed out'));
  on('loadend', () => {
    const xc = st.current;
    if (xc) finish(xhr, xc);
  });
}

/** Runs before the native open(): keep the response of a DONE request before open() discards it. */
function beforeOpen(xhr: XMLHttpRequest): void {
  const current = getState(xhr)?.current;
  if (current) snapshotIfDone(xhr, current);
}

function afterOpen(xhr: XMLHttpRequest, method: unknown, url: unknown, argCount: number, async: unknown): void {
  const previous = getState(xhr);
  // open() silently terminates an in-flight request (no events fire for it). A request that had already
  // reached DONE (re-opened from a page handler that ran before ours) completed normally.
  const superseded = previous?.current;
  if (previous && superseded && !superseded.finished) {
    if (!superseded.response) setOutcome(previous, 'aborted', 'Superseded by a new open() call');
    else if (superseded.doneStatus > 0) setOutcome(previous, 'done');
    else setOutcome(previous, 'error', 'Network error');
    finish(xhr, superseded);
  }
  if (state.mode === MODE_OFF) {
    if (previous) previous.valid = false;
    return;
  }
  const st: XhrState = previous ?? { valid: true, method: '', url: '', async: true, headers: [], listening: false, current: null };
  st.valid = true;
  st.method = normalizeMethod(String(method));
  st.url = resolveRequestUrl(url);
  st.async = argCount < 3 ? true : !!async;
  st.headers = [];
  st.current = null;
  if (!previous) call(weakMapSet, states, [xhr, st]);
}

function beginSend(xhr: XMLHttpRequest, body: unknown): XhrCapture | null {
  const st = getState(xhr);
  // Cases where the native send() throws InvalidStateError: let it, without recording anything.
  if (!st || !st.valid || (st.current && !st.current.finished) || xhr.readyState !== OPENED) return null;
  const capture = beginCapture();
  if (!capture) return null;
  try {
    ensureListeners(xhr, st);
    const startTime = now();
    const { method, url } = st;
    const headers = st.headers.slice();
    let snapshot = NO_BODY;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        snapshot = snapshotBody(body, state.config.requestBodyCap, 'xhr');
      } catch {
        snapshot = { body: () => unavailable('The body could not be read'), implicitType: null };
      }
    }
    const contentType = findHeader(headers, 'content-type') ?? snapshot.implicitType;
    let withCredentials: boolean | undefined;
    try {
      withCredentials = xhr.withCredentials;
    } catch {
      withCredentials = undefined;
    }
    const frameUrl = currentFrameUrl();
    const initiatorStack = captureInitiatorStack();
    const xc: XhrCapture = { capture, url, finished: false, outcome: null, response: null, doneStatus: 0 };
    st.current = xc;
    scheduleStart(capture, snapshot.body, (serialized) => ({
      hookId: capture.hookId,
      kind: 'xhr',
      method,
      url,
      headers,
      body: serialized,
      contentType,
      startTime,
      frameUrl,
      options: withCredentials === undefined ? {} : { withCredentials },
      ...(initiatorStack ? { initiatorStack } : {}),
    }));
    return xc;
  } catch {
    dropCapture(capture);
    return null;
  }
}

/** The native send() threw: InvalidStateError means nothing was sent; anything else (sync XHR) is a failure. */
function sendThrew(xhr: XMLHttpRequest, xc: XhrCapture, error: unknown): void {
  const st = getState(xhr);
  if (errorName(error) === 'InvalidStateError') {
    dropCapture(xc.capture);
    xc.finished = true;
    if (st && st.current === xc) st.current = null;
    return;
  }
  if (st) setOutcome(st, errorName(error) === 'AbortError' ? 'aborted' : 'error', errorText(error));
  finish(xhr, xc);
}

/** Wrap XMLHttpRequest.prototype.open / setRequestHeader / send (no-op when XHR is missing). */
export function installXhrHook(): void {
  const XHR = NativeXHR;
  if (!XHR) return;
  const proto = XHR.prototype;
  const nativeOpen = proto.open;
  const nativeSetRequestHeader = proto.setRequestHeader;
  const nativeSend = proto.send;

  const open = {
    open(this: XMLHttpRequest, method: string, url: string | URL): void {
      try {
        beforeOpen(this);
      } catch {
        /* capture is best effort */
      }
      // `arguments` is forwarded as-is (the 3-argument form treats an explicit `undefined` async as false).
      call(nativeOpen, this, arguments);
      try {
        afterOpen(this, method, url, arguments.length, arguments[2]);
      } catch {
        /* capture is best effort */
      }
    },
  }.open;

  const setRequestHeader = {
    setRequestHeader(this: XMLHttpRequest, name: string, value: string): void {
      call(nativeSetRequestHeader, this, arguments);
      if (state.mode === MODE_OFF) return;
      try {
        const st = getState(this);
        if (st && st.valid && !st.current) st.headers.push({ name: String(name), value: String(value) });
      } catch {
        /* ignore */
      }
    },
  }.setRequestHeader;

  const send = {
    send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      if (state.mode === MODE_OFF) {
        call(nativeSend, this, arguments);
        return;
      }
      let xc: XhrCapture | null = null;
      try {
        xc = beginSend(this, arguments.length > 0 ? body : null);
      } catch {
        xc = null;
      }
      try {
        call(nativeSend, this, arguments);
      } catch (error) {
        if (xc) {
          try {
            sendThrew(this, xc, error);
          } catch {
            /* ignore */
          }
        }
        throw error;
      }
      // Synchronous requests have completed (and normally fired loadend) by now.
      if (xc && !xc.finished) {
        try {
          const st = getState(this);
          if (st && !st.async) finish(this, xc);
        } catch {
          /* ignore */
        }
      }
    },
  }.send;

  replaceMethod(proto, 'open', nativeOpen, open);
  replaceMethod(proto, 'setRequestHeader', nativeSetRequestHeader, setRequestHeader);
  replaceMethod(proto, 'send', nativeSend, send);
}
