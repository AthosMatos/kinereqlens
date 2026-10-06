/**
 * Page-mode replays: run an edited request with the native fetch captured at install, so it carries the
 * page's cookies/origin/CORS context and is never captured by our own wrapper.
 */
import type { HeaderPair, ReplayRequest, ReplayResult, WireBody } from '../shared/types';
import { base64ToBytes, utf8Encode } from '../lib/encoding';
import { isForbiddenRequestHeader } from '../lib/headers';
import {
  abortControllerAbort,
  call,
  clearTimer,
  errorName,
  errorText,
  headersAppend,
  isArray,
  isObjectLike,
  NativeAbortController,
  nativeFetch,
  NativeHeaders,
  now,
  onSettled,
  setTimer,
  W,
} from './natives';
import { readStreamCapped } from './stream';
import { responseBytesBody } from './serialize';
import { findHeader, headersToPairs } from './util';

interface ActiveReplay {
  abort(): void;
}

const active = new Map<string, ActiveReplay>();

const CREDENTIALS = ['include', 'same-origin', 'omit'] as const;
const REDIRECTS = ['follow', 'manual', 'error'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_CAP = 10 * 1024 * 1024;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function finiteOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function parseHeaders(value: unknown): HeaderPair[] {
  if (!isArray(value)) return [];
  const headers: HeaderPair[] = [];
  for (const item of value) {
    if (isObjectLike(item) && typeof item.name === 'string' && typeof item.value === 'string') {
      headers.push({ name: item.name, value: item.value });
    }
  }
  return headers;
}

function parseWireBody(value: unknown): WireBody {
  if (isObjectLike(value)) {
    if (value.kind === 'text' && typeof value.text === 'string') return { kind: 'text', text: value.text };
    if (value.kind === 'base64' && typeof value.base64 === 'string') return { kind: 'base64', base64: value.base64 };
  }
  return { kind: 'none' };
}

/** Defensive parse of the (content-script-built) request; null when unusable. */
function parseRequest(value: unknown): ReplayRequest | null {
  if (!isObjectLike(value)) return null;
  const { runId, method, url } = value;
  if (typeof runId !== 'string' || !runId || typeof method !== 'string' || typeof url !== 'string') return null;
  return {
    runId,
    entryId: typeof value.entryId === 'string' ? value.entryId : '',
    mode: 'page',
    frameId: typeof value.frameId === 'number' ? value.frameId : 0,
    method,
    url,
    headers: parseHeaders(value.headers),
    body: parseWireBody(value.body),
    credentials: oneOf(value.credentials, CREDENTIALS, 'include'),
    redirect: oneOf(value.redirect, REDIRECTS, 'follow'),
    timeoutMs: finiteOr(value.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 3_600_000),
    responseBodyCap: finiteOr(value.responseBodyCap, DEFAULT_RESPONSE_CAP, 0, 512 * 1024 * 1024),
  };
}

function baseResult(req: { runId: string; url: string }, start: number): ReplayResult {
  return {
    runId: req.runId,
    ok: false,
    status: 0,
    statusText: '',
    headers: [],
    body: null,
    url: req.url,
    redirected: false,
    timing: { start, end: start },
    size: 0,
  };
}

/** Human hint for a fetch TypeError in page mode. */
function hintFor(message: string, method: string, hasBody: boolean): string {
  if (hasBody && (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD')) {
    return 'GET/HEAD requests cannot have a body — remove the body or change the method.';
  }
  if (/parse URL|Invalid URL/i.test(message)) return 'The URL is not valid — check the request URL.';
  if (/method/i.test(message)) return 'This HTTP method is not allowed by the browser.';
  if (/header/i.test(message)) return 'A header name or value is not valid.';
  return (
    'The browser blocked the request or the network failed — likely CORS, mixed content (http:// from an ' +
    'https:// page), a CSP connect-src rule, or the server is unreachable. Try Extension mode.'
  );
}

function buildInit(req: ReplayRequest, signal: AbortSignal, dropped: string[]): RequestInit {
  const headers = new NativeHeaders();
  let hasContentType = false;
  for (const { name, value } of req.headers) {
    if (isForbiddenRequestHeader(name)) {
      dropped.push(name);
      continue;
    }
    try {
      call(headersAppend, headers, [name, value]);
      if (name.trim().toLowerCase() === 'content-type') hasContentType = true;
    } catch {
      dropped.push(name);
    }
  }
  const init: RequestInit = {
    method: req.method,
    headers,
    credentials: req.credentials,
    redirect: req.redirect,
    signal,
    cache: 'no-store',
  };
  // fetch() labels a string body "text/plain;charset=UTF-8" when no Content-Type is set; the request must
  // carry exactly the headers shown (a captured bytes body had none), so such text goes out as bytes.
  if (req.body.kind === 'text') init.body = hasContentType ? req.body.text : (utf8Encode(req.body.text) as Uint8Array<ArrayBuffer>);
  // base64ToBytes allocates a fresh (non-shared) ArrayBuffer.
  else if (req.body.kind === 'base64') init.body = base64ToBytes(req.body.base64) as Uint8Array<ArrayBuffer>;
  return init;
}

async function execute(req: ReplayRequest): Promise<ReplayResult> {
  const start = now();
  const result = baseResult(req, start);
  const fetchFn = nativeFetch;
  if (!fetchFn) return { ...result, error: 'fetch is not available in this frame' };

  const controller = new NativeAbortController();
  let aborted = false;
  let timedOut = false;
  const abort = (): void => {
    try {
      call(abortControllerAbort, controller);
    } catch {
      /* ignore */
    }
  };
  active.set(req.runId, {
    abort: () => {
      aborted = true;
      abort();
    },
  });
  const timer = setTimer(() => {
    timedOut = true;
    abort();
  }, req.timeoutMs);
  const dropped: string[] = [];
  try {
    let init: RequestInit;
    try {
      init = buildInit(req, controller.signal, dropped);
    } catch (error) {
      return { ...result, error: `Invalid request body: ${errorText(error)}` };
    }
    if (dropped.length) result.droppedHeaders = dropped;
    const response = await call<Promise<Response>>(fetchFn, W, [req.url, init]);
    result.timing.headers = now();
    result.ok = true;
    result.status = response.status;
    result.statusText = response.statusText;
    result.headers = headersToPairs(response.headers);
    result.url = response.url || req.url;
    result.redirected = response.redirected;
    result.type = response.type;
    const stream = response.body;
    if (stream) {
      const read = await readStreamCapped(stream, req.responseBodyCap);
      const contentType = findHeader(result.headers, 'content-type');
      const truncated = read.truncated || read.error !== undefined;
      result.size = read.total;
      result.body = responseBytesBody(read.bytes, read.total, truncated, contentType);
      if (read.error !== undefined) {
        result.ok = false;
        result.error = timedOut
          ? `Timed out after ${req.timeoutMs} ms while reading the response body`
          : aborted
            ? 'Cancelled while reading the response body'
            : `Failed while reading the response body: ${errorText(read.error)}`;
      }
    }
  } catch (error) {
    result.ok = false;
    if (timedOut) result.error = `Timed out after ${req.timeoutMs} ms`;
    else if (aborted || errorName(error) === 'AbortError') result.error = 'Request cancelled';
    else {
      result.error = errorText(error);
      if (errorName(error) === 'TypeError') {
        result.errorHint = hintFor(result.error, req.method, req.body.kind !== 'none');
      }
    }
  } finally {
    clearTimer(timer);
    active.delete(req.runId);
  }
  if (timedOut) result.timedOut = true;
  if (aborted) result.aborted = true;
  result.timing.end = now();
  return result;
}

/** Handle `{t:'replay'}`; always replies exactly once. */
export function runReplay(data: unknown, reply: (result: ReplayResult) => void): void {
  const req = parseRequest(data);
  if (!req) {
    const runId = isObjectLike(data) && typeof data.runId === 'string' ? data.runId : '';
    const url = isObjectLike(data) && typeof data.url === 'string' ? data.url : '';
    if (runId) reply({ ...baseResult({ runId, url }, now()), error: 'Invalid replay request' });
    return;
  }
  onSettled(execute(req), reply, (error) => reply({ ...baseResult(req, now()), error: errorText(error) }));
}

/** Handle `{t:'abort'}`. */
export function abortReplay(runId: unknown): void {
  if (typeof runId === 'string') active.get(runId)?.abort();
}
