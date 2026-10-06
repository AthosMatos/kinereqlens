/**
 * global fetch wrapper. The original fetch always runs with the app's own `this`/arguments and the very
 * promise it returned goes back to the app.
 *
 * Dedupe: while the original runs (synchronously), a FetchContext is set. React Native's fetch opens its
 * XMLHttpRequest during that call; the XHR hook claims the context and reports the request as kind 'fetch'.
 * Only when no XHR claimed it (a native fetch implementation) does this wrapper capture the request itself.
 */
import type { BodySnapshot } from './body';
import { bytesBody, NO_BODY, responseBytesBody, snapshotBody, unavailable } from './body';
import type { Capture, FetchContext, Runtime } from './context';
import { activeRuntime, beginCapture, emitEnd, errorName, errorText, isIgnored, scheduleStart, swapFetchContext } from './context';
import { findHeader, headersInitToPairs, mimeOf } from './headers';
import type { HeaderPair, RnRequestEnd, RnRequestStart } from './protocol';
import { readResponseBytes } from './response';

type Options = NonNullable<RnRequestStart['options']>;
type AnyFetch = (...args: unknown[]) => Promise<unknown>;

interface RequestLike {
  url: string;
  method?: string;
  headers?: unknown;
  clone?: () => { arrayBuffer?: () => Promise<ArrayBuffer> };
  credentials?: string;
  _bodyInit?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequestLike(value: unknown): value is RequestLike {
  return isObject(value) && typeof value.url === 'string' && typeof (value as { method?: unknown }).method === 'string';
}

export function fetchOptions(input: unknown, init: unknown): Options {
  const options: Options = {};
  const request = isRequestLike(input) ? (input as unknown as Record<string, unknown>) : null;
  const opts = isObject(init) ? init : null;
  for (const key of ['credentials', 'mode', 'cache', 'redirect', 'referrerPolicy'] as const) {
    const value = opts && typeof opts[key] === 'string' ? opts[key] : request && typeof request[key] === 'string' ? request[key] : undefined;
    if (typeof value === 'string') options[key] = value;
  }
  const keepalive = opts && typeof opts.keepalive === 'boolean' ? opts.keepalive : undefined;
  if (keepalive !== undefined) options.keepalive = keepalive;
  return options;
}

function inputUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (isRequestLike(input)) return input.url;
  if (isObject(input) && typeof input.href === 'string') return input.href;
  return String(input);
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(upper) ? upper : method;
}

function requestBodySnapshot(runtime: Runtime, input: unknown, init: Record<string, unknown> | null): BodySnapshot {
  if (!runtime.config.captureBodies) {
    const has = (init && init.body !== undefined && init.body !== null) || (isRequestLike(input) && input._bodyInit !== undefined);
    return has ? { body: () => unavailable('Body capture is turned off (captureBodies: false)'), implicitType: null } : NO_BODY;
  }
  const cap = runtime.config.requestBodyCap;
  if (init && init.body !== undefined && init.body !== null) return snapshotBody(init.body, cap);
  if (isRequestLike(input) && typeof input.clone === 'function') {
    let clone: { arrayBuffer?: () => Promise<ArrayBuffer> };
    try {
      clone = input.clone();
    } catch {
      return { body: () => unavailable('The request body was already used'), implicitType: null };
    }
    if (typeof clone.arrayBuffer !== 'function') return NO_BODY;
    const read = clone.arrayBuffer.bind(clone);
    return {
      implicitType: null,
      body: async () => {
        const bytes = new Uint8Array(await read());
        if (bytes.length === 0) return null;
        return bytesBody(bytes.length > cap ? bytes.slice(0, cap) : bytes, bytes.length, bytes.length > cap);
      },
    };
  }
  return NO_BODY;
}

interface Pending {
  capture: Capture;
  signal: { aborted?: boolean } | null;
}

function prepare(runtime: Runtime, input: unknown, init: unknown, startTime: number, ctx: FetchContext): Pending | null {
  const url = inputUrl(input);
  if (isIgnored(runtime, url)) return null;
  const request = isRequestLike(input) ? input : null;
  const opts = isObject(init) ? init : null;
  const method = opts && opts.method !== undefined ? normalizeMethod(String(opts.method)) : request?.method ? request.method : 'GET';
  const headers: HeaderPair[] =
    opts && opts.headers !== undefined ? headersInitToPairs(opts.headers) : request ? headersInitToPairs(request.headers) : [];
  let snapshot: BodySnapshot;
  try {
    snapshot = method === 'GET' || method === 'HEAD' ? NO_BODY : requestBodySnapshot(runtime, input, opts);
  } catch {
    snapshot = { body: () => unavailable('The body could not be read'), implicitType: null };
  }
  const capture = beginCapture(runtime);
  const contentType = findHeader(headers, 'content-type') ?? snapshot.implicitType;
  const signal = ((opts && opts.signal) || (request && (request as unknown as Record<string, unknown>).signal) || null) as Pending['signal'];
  scheduleStart(capture, snapshot.body, (body) => ({
    hookId: capture.id,
    kind: 'fetch',
    method,
    url,
    headers,
    body,
    contentType,
    startTime,
    frameUrl: '',
    options: ctx.options,
  }));
  return { capture, signal };
}

async function onResponse(pending: Pending, response: unknown): Promise<void> {
  const { capture } = pending;
  const runtime = capture.runtime;
  const res = response as { status?: number; statusText?: string; headers?: unknown; url?: string; redirected?: boolean; type?: string; clone?: () => unknown };
  const headers = headersInitToPairs(res.headers);
  const contentType = findHeader(headers, 'content-type');
  const end: RnRequestEnd = {
    hookId: capture.id,
    state: 'done',
    status: Number(res.status) || 0,
    statusText: String(res.statusText ?? ''),
    headers,
    endTime: 0,
  };
  if (typeof res.url === 'string' && res.url) end.responseUrl = res.url;
  if (typeof res.redirected === 'boolean') end.redirected = res.redirected;
  if (typeof res.type === 'string') end.responseType = res.type;
  const { mime } = mimeOf(contentType);
  if (!runtime.config.captureBodies) end.body = unavailable('Body capture is turned off (captureBodies: false)');
  else if (mime === 'text/event-stream') end.body = unavailable('Event stream (text/event-stream) bodies are not captured');
  else if (typeof res.clone !== 'function') end.body = unavailable('The response cannot be cloned');
  else {
    // Clone synchronously, before any app handler can consume the body.
    let clone: unknown;
    try {
      clone = res.clone();
    } catch {
      clone = null;
    }
    if (!clone) end.body = unavailable('The response body was already used');
    else {
      try {
        const read = await readResponseBytes(clone, runtime.config.responseBodyCap);
        end.body = responseBytesBody(read.bytes, read.total, read.truncated, contentType);
        if (read.error !== undefined) {
          end.state = errorName(read.error) === 'AbortError' || pending.signal?.aborted ? 'aborted' : 'error';
          end.error = errorText(read.error);
        }
      } catch {
        end.body = unavailable('The response body could not be read');
      }
    }
  }
  end.endTime = Date.now();
  emitEnd(capture, end);
}

function onFailure(pending: Pending, error: unknown): void {
  let aborted = errorName(error) === 'AbortError';
  try {
    aborted = aborted || !!pending.signal?.aborted;
  } catch {
    /* ignore */
  }
  emitEnd(pending.capture, { hookId: pending.capture.id, state: aborted ? 'aborted' : 'error', error: errorText(error), endTime: Date.now() });
}

export interface FetchPatch {
  restore(): void;
}

/** Replace `target.fetch` with the capturing wrapper. */
export function installFetchHook(gen: number, target: Record<string, unknown>): FetchPatch | null {
  const original = target.fetch;
  if (typeof original !== 'function') return null;
  const nativeFetch = original as AnyFetch;
  const wrapper = function fetch(this: unknown, ...args: unknown[]): Promise<unknown> {
    const runtime = activeRuntime(gen);
    if (!runtime) return nativeFetch.apply(this, args);
    const startTime = Date.now();
    let ctx: FetchContext;
    try {
      ctx = { claimed: false, suppress: false, options: fetchOptions(args[0], args[1]) };
    } catch {
      ctx = { claimed: false, suppress: false, options: {} };
    }
    const previous = swapFetchContext(ctx);
    let promise: Promise<unknown>;
    try {
      promise = nativeFetch.apply(this, args);
    } finally {
      swapFetchContext(previous);
    }
    if (!ctx.claimed) {
      try {
        const pending = prepare(runtime, args[0], args[1], startTime, ctx);
        if (pending && promise && typeof promise.then === 'function') {
          promise.then(
            (response) => {
              onResponse(pending, response).catch((error) => onFailure(pending, error));
            },
            (error) => onFailure(pending, error),
          );
        }
      } catch {
        /* capture is best effort */
      }
    }
    return promise;
  };
  target.fetch = wrapper;
  return {
    restore(): void {
      if (target.fetch === wrapper) target.fetch = original;
    },
  };
}
