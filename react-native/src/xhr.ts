/**
 * XMLHttpRequest capture (prototype open / setRequestHeader / send), modelled on src/injected/xhrHook.ts.
 * React Native's fetch runs over XMLHttpRequest: an XHR opened inside a wrapped fetch() call is reported as
 * that fetch (kind 'fetch', with its init options) and the fetch wrapper stays silent, so it appears once.
 */
import type { Deferred } from './body';
import { blobBody, copyBytes, isBlobLike, NO_BODY, responseBytesBody, snapshotBody, textBody, unavailable } from './body';
import type { Capture, FetchContext, Runtime } from './context';
import { activeRuntime, beginCapture, claimFetchContext, emitEnd, isIgnored, scheduleStart, stripHash } from './context';
import { findHeader, parseHeaderBlock } from './headers';
import type { HeaderPair, RnRequestEnd, RnRequestStart, SerializedBody } from './protocol';

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
  response: Deferred<ResponsePart> | null;
  doneStatus: number;
}

interface XhrState {
  gen: number;
  /** False when open() ran while capture was off or the URL is ignored. */
  valid: boolean;
  method: string;
  url: string;
  headers: HeaderPair[];
  fetch: FetchContext | null;
  listening: boolean;
  current: XhrCapture | null;
}

type XhrLike = XMLHttpRequest & { addEventListener?: XMLHttpRequest['addEventListener'] };

const OPENED = 1;
const DONE = 4;

const states = new WeakMap<object, XhrState>();

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'].includes(upper) ? upper : method;
}

function readBody(runtime: Runtime, xhr: XhrLike, contentType: string | null): Deferred<SerializedBody | null> {
  const { captureBodies, responseBodyCap: cap } = runtime.config;
  if (!captureBodies) return unavailable('Body capture is turned off (captureBodies: false)');
  const type = String(xhr.responseType ?? '');
  switch (type) {
    case '':
    case 'text':
      return textBody(String(xhr.responseText ?? ''), cap);
    case 'json': {
      const value: unknown = xhr.response;
      return value === null || value === undefined ? null : textBody(String(JSON.stringify(value)), cap);
    }
    case 'arraybuffer': {
      const buffer = xhr.response as ArrayBuffer | null;
      if (!buffer) return null;
      const { bytes, total } = copyBytes(buffer, cap);
      return responseBytesBody(bytes, total, total > bytes.length, contentType);
    }
    case 'blob': {
      const blob = xhr.response as unknown;
      return isBlobLike(blob) ? blobBody(blob, cap, contentType)() : null;
    }
    default:
      return unavailable(`responseType "${type}" is not captured`);
  }
}

function snapshotResponse(runtime: Runtime, xhr: XhrLike): Deferred<ResponsePart> {
  const status = Number(xhr.status) || 0;
  let headers: HeaderPair[] = [];
  try {
    headers = status ? parseHeaderBlock(xhr.getAllResponseHeaders()) : [];
  } catch {
    headers = [];
  }
  let responseUrl = '';
  let statusText = '';
  try {
    responseUrl = String(xhr.responseURL ?? '');
    statusText = String(xhr.statusText ?? '');
  } catch {
    /* ignore */
  }
  const part: ResponsePart = { status, statusText, headers, responseUrl, body: null };
  if (!status) return part;
  let body: Deferred<SerializedBody | null>;
  try {
    body = readBody(runtime, xhr, findHeader(headers, 'content-type'));
  } catch {
    body = unavailable('The response body could not be read');
  }
  if (!(body && typeof (body as Promise<unknown>).then === 'function')) {
    part.body = body as SerializedBody | null;
    return part;
  }
  return (body as Promise<SerializedBody | null>).then(
    (value) => ({ ...part, body: value }),
    () => ({ ...part, body: unavailable('The response body could not be read') }),
  );
}

function emptyPart(): ResponsePart {
  return { status: 0, statusText: '', headers: [], responseUrl: '', body: null };
}

function buildEnd(xc: XhrCapture, part: ResponsePart, responseType?: string): RnRequestEnd {
  const outcome: Outcome = xc.outcome ?? (part.status ? 'done' : 'error');
  const end: RnRequestEnd = { hookId: xc.capture.id, state: outcome, endTime: Date.now() };
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
  if (responseType !== undefined) end.responseType = responseType;
  return end;
}

function finish(xhr: XhrLike, xc: XhrCapture): void {
  if (xc.finished) return;
  xc.finished = true;
  let response: Deferred<ResponsePart>;
  try {
    response = xc.response ?? (xhr.readyState === DONE ? snapshotResponse(xc.capture.runtime, xhr) : emptyPart());
  } catch {
    response = emptyPart();
  }
  Promise.resolve(response).then(
    (part) => emitEnd(xc.capture, buildEnd(xc, part)),
    () => emitEnd(xc.capture, buildEnd(xc, emptyPart())),
  );
}

function setOutcome(st: XhrState, outcome: Outcome, error?: string): void {
  const xc = st.current;
  if (xc && !xc.finished && !xc.outcome) {
    xc.outcome = outcome;
    if (error) xc.error = error;
  }
}

function snapshotIfDone(xhr: XhrLike, xc: XhrCapture): void {
  if (xc.finished || xc.response || xhr.readyState !== DONE) return;
  xc.doneStatus = Number(xhr.status) || 0;
  xc.response = snapshotResponse(xc.capture.runtime, xhr);
}

function ensureListeners(xhr: XhrLike, st: XhrState): void {
  if (st.listening || typeof xhr.addEventListener !== 'function') return;
  st.listening = true;
  const on = (type: string, handler: () => void): void => {
    xhr.addEventListener(type, () => {
      try {
        if (xhr.readyState === DONE) handler();
      } catch {
        /* never surface into the app */
      }
    });
  };
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

function beforeOpen(xhr: XhrLike): void {
  const current = states.get(xhr)?.current;
  if (current) snapshotIfDone(xhr, current);
}

function afterOpen(gen: number, xhr: XhrLike, method: unknown, url: unknown): void {
  const previous = states.get(xhr);
  const superseded = previous?.current;
  if (previous && superseded && !superseded.finished) {
    if (!superseded.response) setOutcome(previous, 'aborted', 'Superseded by a new open() call');
    else if (superseded.doneStatus > 0) setOutcome(previous, 'done');
    else setOutcome(previous, 'error', 'Network error');
    finish(xhr, superseded);
  }
  // Claim (or skip, for replays) the fetch() this XHR is running for, even when capture is off.
  const fetchCtx = claimFetchContext();
  const runtime = activeRuntime(gen);
  const st: XhrState = previous ?? { gen, valid: false, method: '', url: '', headers: [], fetch: null, listening: false, current: null };
  if (!previous) states.set(xhr, st);
  st.current = null;
  st.headers = [];
  st.method = normalizeMethod(String(method));
  st.url = String(url);
  st.fetch = fetchCtx;
  st.gen = gen;
  st.valid = !!runtime && !(fetchCtx && fetchCtx.suppress) && !isIgnored(runtime, st.url);
}

function beginSend(gen: number, xhr: XhrLike, body: unknown): XhrCapture | null {
  const runtime = activeRuntime(gen);
  const st = states.get(xhr);
  if (!runtime || !st || !st.valid || st.gen !== gen || (st.current && !st.current.finished) || xhr.readyState !== OPENED) return null;
  ensureListeners(xhr, st);
  const capture = beginCapture(runtime);
  const startTime = Date.now();
  const { method, url } = st;
  const headers = st.headers.slice();
  let snapshot = NO_BODY;
  if (method !== 'GET' && method !== 'HEAD') {
    if (!runtime.config.captureBodies) {
      snapshot = body === null || body === undefined ? NO_BODY : { body: () => unavailable('Body capture is turned off (captureBodies: false)'), implicitType: null };
    } else {
      try {
        snapshot = snapshotBody(body, runtime.config.requestBodyCap);
      } catch {
        snapshot = { body: () => unavailable('The body could not be read'), implicitType: null };
      }
    }
  }
  const contentType = findHeader(headers, 'content-type') ?? snapshot.implicitType;
  const options: NonNullable<RnRequestStart['options']> = st.fetch ? { ...st.fetch.options } : {};
  try {
    if (typeof xhr.withCredentials === 'boolean' && !st.fetch) options.withCredentials = xhr.withCredentials;
    if (!st.fetch) options.responseType = String(xhr.responseType ?? '');
    if (!st.fetch && typeof xhr.timeout === 'number' && xhr.timeout > 0) options.timeout = xhr.timeout;
  } catch {
    /* ignore */
  }
  const kind = st.fetch ? 'fetch' : 'xhr';
  const xc: XhrCapture = { capture, url, finished: false, outcome: null, response: null, doneStatus: 0 };
  st.current = xc;
  scheduleStart(capture, snapshot.body, (serialized) => ({
    hookId: capture.id,
    kind,
    method,
    url,
    headers,
    body: serialized,
    contentType,
    startTime,
    frameUrl: '',
    options,
  }));
  return xc;
}

export interface XhrPatch {
  restore(): void;
}

/** Wrap XMLHttpRequest.prototype.open / setRequestHeader / send. */
export function installXhrHook(gen: number, XHR: unknown): XhrPatch | null {
  if (typeof XHR !== 'function' || !XHR.prototype) return null;
  const proto = XHR.prototype as XMLHttpRequest;
  const nativeOpen = proto.open;
  const nativeSetRequestHeader = proto.setRequestHeader;
  const nativeSend = proto.send;
  if (typeof nativeOpen !== 'function' || typeof nativeSend !== 'function' || typeof nativeSetRequestHeader !== 'function') return null;

  const open = function open(this: XhrLike, ...args: unknown[]): void {
    try {
      beforeOpen(this);
    } catch {
      /* best effort */
    }
    (nativeOpen as (...a: unknown[]) => void).apply(this, args);
    try {
      afterOpen(gen, this, args[0], args[1]);
    } catch {
      /* best effort */
    }
  };

  const setRequestHeader = function setRequestHeader(this: XhrLike, ...args: unknown[]): void {
    (nativeSetRequestHeader as (...a: unknown[]) => void).apply(this, args);
    try {
      const st = states.get(this);
      if (st && st.valid && !st.current) st.headers.push({ name: String(args[0]), value: String(args[1]) });
    } catch {
      /* ignore */
    }
  };

  const send = function send(this: XhrLike, ...args: unknown[]): void {
    let xc: XhrCapture | null = null;
    try {
      xc = beginSend(gen, this, args.length > 0 ? args[0] : null);
    } catch {
      xc = null;
    }
    try {
      (nativeSend as (...a: unknown[]) => void).apply(this, args);
    } catch (error) {
      if (xc) {
        try {
          const st = states.get(this);
          if (st) setOutcome(st, 'error', String((error as { message?: unknown })?.message ?? error));
          finish(this, xc);
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
  };

  const target = proto as unknown as Record<string, unknown>;
  target.open = open;
  target.setRequestHeader = setRequestHeader;
  target.send = send;

  return {
    restore(): void {
      // Only undo our own patch; a wrapper installed on top of ours stays (ours then passes through).
      if (target.open === open) target.open = nativeOpen;
      if (target.setRequestHeader === setRequestHeader) target.setRequestHeader = nativeSetRequestHeader;
      if (target.send === send) target.send = nativeSend;
    },
  };
}
