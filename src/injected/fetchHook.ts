/**
 * window.fetch wrapper. The native fetch is called with the page's own `this` and `arguments`, and the very
 * promise it returned goes back to the page. Observation happens through a `.then` attached before the page
 * gets the promise (so our handler clones the response before any page handler can consume it).
 */
import type { HeaderPair, HookRequestEnd, HookRequestStart, SerializedBody } from '../shared/types';
import type { Capture } from './channel';
import { beginCapture, dropCapture, emitEnd, isDropped, MODE_OFF, state, trackRead } from './channel';
import { followPageCancel } from './cancelFollow';
import { replaceMethod } from './disguise';
import {
  call,
  errorName,
  errorText,
  isObjectLike,
  nativeFetch,
  NativeRequest,
  now,
  onSettled,
  requestClone,
  responseBody,
  responseClone,
  tagOf,
  W,
} from './natives';
import type { BodySnapshot } from './serialize';
import { bytesBody, mimeOf, NO_BODY, responseBytesBody, snapshotBody, unavailable } from './serialize';
import { readStreamCapped } from './stream';
import { captureInitiatorStack } from './initiator';
import {
  currentFrameUrl,
  findHeader,
  headersInitToPairs,
  headersToPairs,
  normalizeMethod,
  resolveRequestUrl,
  scheduleStart,
} from './util';

/** Streaming uploads never "finish"; stop reading our copy of the request body after this. */
const REQUEST_BODY_READ_TIMEOUT_MS = 3_000;
/** Responses with a Content-Length: post 'end' with what we have after this. */
const RESPONSE_BODY_READ_TIMEOUT_MS = 60_000;
/**
 * Responses without a Content-Length (chunked / streamed: NDJSON, watch endpoints, long-polls, token
 * streams) may never end. kineReqLens' clone keeps the connection open while it reads, so it stops after this
 * window (body marked truncated) even when the page cancelled its own branch in a way kineReqLens cannot see
 * (pipeThrough, async iteration). Direct cancels are followed at once (cancelFollow.ts).
 */
export const STREAMING_RESPONSE_READ_WINDOW_MS = 5_000;

interface PendingFetch {
  capture: Capture;
  signal: AbortSignal | null;
}

type Options = NonNullable<HookRequestStart['options']>;

function isRequest(value: unknown): value is Request {
  return value instanceof NativeRequest || (isObjectLike(value) && tagOf(value) === '[object Request]');
}

function stringOption(source: Record<PropertyKey, unknown> | Request | null, key: string): string | undefined {
  if (!source) return undefined;
  const value = (source as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function fetchOptions(request: Request | null, init: Record<PropertyKey, unknown> | null): Options {
  const options: Options = {};
  for (const key of ['credentials', 'mode', 'cache', 'redirect', 'referrerPolicy'] as const) {
    const value = stringOption(init, key) ?? stringOption(request, key);
    if (value !== undefined) options[key] = value;
  }
  const keepalive = init && typeof init.keepalive === 'boolean' ? init.keepalive : request?.keepalive;
  if (typeof keepalive === 'boolean') options.keepalive = keepalive;
  return options;
}

/** Clone a Request body *before* the native call (never `new Request(input, init)`: it would disturb it). */
function requestBodySnapshot(request: Request, cap: number): BodySnapshot {
  let clone: Request;
  try {
    clone = call<Request>(requestClone, request);
  } catch {
    return { body: () => unavailable('The request body was already used'), implicitType: null };
  }
  return {
    implicitType: null,
    body: async (): Promise<SerializedBody | null> => {
      const stream = clone.body;
      if (!stream) return null;
      const read = await readStreamCapped(stream, cap, { timeoutMs: REQUEST_BODY_READ_TIMEOUT_MS });
      if (read.error !== undefined && read.total === 0) return unavailable('The request body could not be read');
      return bytesBody(read.bytes, read.total, read.truncated || read.error !== undefined);
    },
  };
}

function prepare(input: unknown, init: unknown): PendingFetch | null {
  const capture = beginCapture();
  if (!capture) return null;
  try {
    const startTime = now();
    const request = isRequest(input) ? input : null;
    const options = isObjectLike(init) ? init : null;
    const url = request ? request.url : resolveRequestUrl(input);
    const method =
      options && options.method !== undefined ? normalizeMethod(String(options.method)) : request ? request.method : 'GET';
    const headers: HeaderPair[] =
      options && options.headers !== undefined
        ? headersInitToPairs(options.headers)
        : request
          ? headersToPairs(request.headers)
          : [];
    const cap = state.config.requestBodyCap;
    const bodyInit = options ? options.body : undefined;
    let snapshot: BodySnapshot;
    try {
      snapshot =
        bodyInit !== undefined && bodyInit !== null
          ? snapshotBody(bodyInit, cap, 'fetch')
          : request && request.body !== null
            ? requestBodySnapshot(request, cap)
            : NO_BODY;
    } catch {
      snapshot = { body: () => unavailable('The body could not be read'), implicitType: null };
    }
    const contentType = findHeader(headers, 'content-type') ?? snapshot.implicitType;
    const signal = ((options && options.signal) || (request && request.signal) || null) as AbortSignal | null;
    const fetchOpts = fetchOptions(request, options);
    const frameUrl = currentFrameUrl();
    const initiatorStack = captureInitiatorStack();
    scheduleStart(capture, snapshot.body, (body) => ({
      hookId: capture.hookId,
      kind: 'fetch',
      method,
      url,
      headers,
      body,
      contentType,
      startTime,
      frameUrl,
      options: fetchOpts,
      ...(initiatorStack ? { initiatorStack } : {}),
    }));
    return { capture, signal };
  } catch {
    dropCapture(capture);
    return null;
  }
}

/** Decide synchronously (before any page handler runs) whether to read our clone of the body. */
function responseBodyPlan(response: Response, contentType: string | null): 'read' | SerializedBody | null {
  if (!state.config.captureResponseBodies) return unavailable('Response body capture is turned off in settings');
  if (response.type === 'opaque' || response.type === 'opaqueredirect') {
    return unavailable('Opaque response: the body is not readable by the page');
  }
  if (response.body === null) return null;
  const { mime } = mimeOf(contentType);
  if (mime === 'text/event-stream') return unavailable('Event stream (text/event-stream) bodies are not captured');
  if (mime === 'multipart/x-mixed-replace') return unavailable('Streaming multipart bodies are not captured');
  if (response.bodyUsed) return unavailable('The response body was already used');
  return 'read';
}

/** Full length for a truncated body when the server announced it (and no content-coding changes it). */
function announcedLength(headers: HeaderPair[], read: number): number {
  const length = Number(findHeader(headers, 'content-length'));
  const coding = (findHeader(headers, 'content-encoding') ?? 'identity').trim().toLowerCase();
  return coding === 'identity' && Number.isFinite(length) && length > read ? length : read;
}

async function onResponse(pending: PendingFetch, response: Response): Promise<void> {
  const { capture } = pending;
  let end: HookRequestEnd;
  try {
    const headers = headersToPairs(response.headers);
    const contentType = findHeader(headers, 'content-type');
    end = {
      hookId: capture.hookId,
      state: 'done',
      status: response.status,
      statusText: response.statusText,
      headers,
      responseUrl: response.url,
      redirected: response.redirected,
      responseType: response.type,
      endTime: 0,
    };
    const plan = responseBodyPlan(response, contentType);
    if (plan === 'read') {
      const clone = call<Response>(responseClone, response);
      const stream = clone.body;
      if (stream) {
        // After clone() the page's response holds the other branch of the tee.
        let pageStream: unknown = null;
        try {
          pageStream = responseBody ? call(responseBody, response) : response.body;
        } catch {
          pageStream = null;
        }
        let untrack: (() => void) | null = null;
        const unbounded = findHeader(headers, 'content-length') === null;
        const read = await readStreamCapped(stream, state.config.responseBodyCap, {
          shouldStop: () => isDropped(capture),
          timeoutMs: unbounded ? STREAMING_RESPONSE_READ_WINDOW_MS : RESPONSE_BODY_READ_TIMEOUT_MS,
          control: (stop) => {
            untrack = trackRead(capture, stop);
            if (isObjectLike(pageStream)) followPageCancel(pageStream, stop);
          },
        });
        (untrack as (() => void) | null)?.();
        if (isDropped(capture)) return;
        const truncated = read.truncated || read.error !== undefined;
        end.body = responseBytesBody(read.bytes, truncated ? announcedLength(headers, read.total) : read.total, truncated, contentType);
        if (read.error !== undefined) {
          end.state = errorName(read.error) === 'AbortError' || pending.signal?.aborted ? 'aborted' : 'error';
          end.error = errorText(read.error);
        }
      } else {
        end.body = null;
      }
    } else {
      end.body = plan;
    }
  } catch (error) {
    end = { hookId: capture.hookId, state: 'error', error: errorText(error), endTime: 0 };
  }
  end.endTime = now();
  emitEnd(capture, end);
}

function onFailure(pending: PendingFetch, error: unknown): void {
  let aborted = errorName(error) === 'AbortError';
  try {
    aborted = aborted || !!pending.signal?.aborted;
  } catch {
    /* exotic signal */
  }
  emitEnd(pending.capture, {
    hookId: pending.capture.hookId,
    state: aborted ? 'aborted' : 'error',
    error: errorText(error),
    endTime: now(),
  });
}

/** Replace window.fetch with the capturing wrapper (no-op when fetch is missing). */
export function installFetchHook(): void {
  const original = nativeFetch;
  if (!original) return;
  const wrapper = {
    fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // `arguments` is forwarded as-is so the native sees exactly what the page passed.
      if (state.mode === MODE_OFF) return call<Promise<Response>>(original, this, arguments);
      let pending: PendingFetch | null = null;
      try {
        pending = prepare(input, init);
      } catch {
        pending = null;
      }
      let promise: Promise<Response>;
      try {
        promise = call<Promise<Response>>(original, this, arguments);
      } catch (error) {
        if (pending) dropCapture(pending.capture);
        throw error;
      }
      if (pending) {
        const observed = pending;
        try {
          onSettled(
            promise,
            (response) => {
              onSettled(onResponse(observed, response), () => undefined, (error) => onFailure(observed, error));
            },
            (error) => onFailure(observed, error),
          );
        } catch {
          dropCapture(observed.capture);
        }
      }
      return promise;
    },
  }.fetch;
  replaceMethod(W, 'fetch', original, wrapper);
}
