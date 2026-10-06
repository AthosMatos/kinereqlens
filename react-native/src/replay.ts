/**
 * Replays requested by the receiver, executed with the app's original fetch (the one in place before
 * startKineReqLens patched it) so they carry the app's networking stack (cookies, native TLS config, ...).
 * They are never captured: the XHR React Native's fetch opens is suppressed through the fetch context.
 */
import { responseBytesBody } from './body';
import { errorName, errorText, swapFetchContext } from './context';
import { base64ToBytes } from './encoding';
import { findHeader, headersInitToPairs } from './headers';
import type { HeaderPair, RnReplayRequest, RnReplayResult, WireBody } from './protocol';
import { readResponseBytes } from './response';

type AnyFetch = (...args: unknown[]) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_CAP = 10 * 1024 * 1024;
const CREDENTIALS = ['include', 'same-origin', 'omit'];
const REDIRECTS = ['follow', 'manual', 'error'];

const active = new Map<string, () => void>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function parseHeaders(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) return [];
  const headers: HeaderPair[] = [];
  for (const item of value) {
    if (isObject(item) && typeof item.name === 'string' && typeof item.value === 'string') headers.push({ name: item.name, value: item.value });
  }
  return headers;
}

function parseBody(value: unknown): WireBody {
  if (isObject(value)) {
    if (value.kind === 'text' && typeof value.text === 'string') return { kind: 'text', text: value.text };
    if (value.kind === 'base64' && typeof value.base64 === 'string') return { kind: 'base64', base64: value.base64 };
  }
  return { kind: 'none' };
}

interface ParsedReplay {
  runId: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: WireBody;
  credentials: string;
  redirect: string;
  timeoutMs: number;
  responseBodyCap: number;
}

export function parseReplay(value: unknown): ParsedReplay | null {
  if (!isObject(value)) return null;
  const { runId, method, url } = value;
  if (typeof runId !== 'string' || !runId || typeof method !== 'string' || !method || typeof url !== 'string' || !url) return null;
  return {
    runId,
    method,
    url,
    headers: parseHeaders(value.headers),
    body: parseBody(value.body),
    credentials: typeof value.credentials === 'string' && CREDENTIALS.includes(value.credentials) ? value.credentials : 'include',
    redirect: typeof value.redirect === 'string' && REDIRECTS.includes(value.redirect) ? value.redirect : 'follow',
    timeoutMs: finiteOr(value.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 3_600_000),
    responseBodyCap: finiteOr(value.responseBodyCap, DEFAULT_RESPONSE_CAP, 0, 512 * 1024 * 1024),
  };
}

function baseResult(runId: string, url: string, start: number): RnReplayResult {
  return { runId, ok: false, status: 0, statusText: '', headers: [], body: null, url, redirected: false, timing: { start, end: start }, size: 0 };
}

function hintFor(message: string, method: string, hasBody: boolean): string {
  const upper = method.toUpperCase();
  if (hasBody && (upper === 'GET' || upper === 'HEAD')) return 'GET/HEAD requests cannot have a body — remove the body or change the method.';
  if (/parse URL|Invalid URL|unsupported URL/i.test(message)) return 'The URL is not valid — check the request URL.';
  return 'The request failed in the app — the server is unreachable from the device, TLS failed, or (Android) cleartext HTTP is blocked.';
}

async function execute(fetchFn: AnyFetch, req: ParsedReplay): Promise<RnReplayResult> {
  const start = Date.now();
  const result = baseResult(req.runId, req.url, start);
  let aborted = false;
  let timedOut = false;
  const AbortCtor = (globalThis as { AbortController?: new () => { signal: unknown; abort(): void } }).AbortController;
  const controller = typeof AbortCtor === 'function' ? new AbortCtor() : null;
  let rejectEarly: (error: Error) => void = () => undefined;
  const early = new Promise<never>((_, reject) => {
    rejectEarly = reject;
  });
  early.catch(() => undefined);
  const stop = (why: 'abort' | 'timeout'): void => {
    if (why === 'abort') aborted = true;
    else timedOut = true;
    try {
      controller?.abort();
    } catch {
      /* ignore */
    }
    rejectEarly(new Error(why === 'abort' ? 'Request cancelled' : 'Timed out'));
  };
  active.set(req.runId, () => stop('abort'));
  const timer = setTimeout(() => stop('timeout'), req.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    const list: Array<[string, string]> = [];
    for (const { name, value } of req.headers) list.push([name, value]);
    for (const [name, value] of list) headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    const init: Record<string, unknown> = { method: req.method, headers, credentials: req.credentials, redirect: req.redirect };
    if (controller) init.signal = controller.signal;
    if (req.body.kind === 'text') init.body = req.body.text;
    else if (req.body.kind === 'base64') {
      const bytes = base64ToBytes(req.body.base64);
      init.body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    // Suppress capture of the XHR React Native's fetch opens for this replay.
    const previous = swapFetchContext({ claimed: false, suppress: true, options: {} });
    let pending: Promise<unknown>;
    try {
      pending = fetchFn.call(globalThis, req.url, init);
    } finally {
      swapFetchContext(previous);
    }
    const response = (await Promise.race([pending, early])) as {
      status?: number;
      statusText?: string;
      headers?: unknown;
      url?: string;
      redirected?: boolean;
      type?: string;
    };
    result.timing.headers = Date.now();
    result.ok = true;
    result.status = Number(response.status) || 0;
    result.statusText = String(response.statusText ?? '');
    result.headers = headersInitToPairs(response.headers);
    result.url = typeof response.url === 'string' && response.url ? response.url : req.url;
    result.redirected = !!response.redirected;
    if (typeof response.type === 'string') result.type = response.type;
    try {
      const read = await Promise.race([readResponseBytes(response, req.responseBodyCap, req.timeoutMs), early]);
      result.size = read.total;
      result.body = responseBytesBody(read.bytes, read.total, read.truncated, findHeader(result.headers, 'content-type'));
      if (read.error !== undefined) {
        result.ok = false;
        result.error = `Failed while reading the response body: ${errorText(read.error)}`;
      }
    } catch (error) {
      result.ok = false;
      result.error = timedOut
        ? `Timed out after ${req.timeoutMs} ms while reading the response body`
        : aborted
          ? 'Cancelled while reading the response body'
          : `Failed while reading the response body: ${errorText(error)}`;
    }
  } catch (error) {
    result.ok = false;
    if (timedOut) result.error = `Timed out after ${req.timeoutMs} ms`;
    else if (aborted || errorName(error) === 'AbortError') result.error = 'Request cancelled';
    else {
      result.error = errorText(error);
      result.errorHint = hintFor(result.error, req.method, req.body.kind !== 'none');
    }
  } finally {
    clearTimeout(timer);
    active.delete(req.runId);
  }
  if (timedOut) result.timedOut = true;
  if (aborted) result.aborted = true;
  result.timing.end = Date.now();
  return result;
}

/** Run a `{t:'replay'}` request; replies exactly once (also for invalid requests that carry a runId). */
export function runReplay(fetchFn: unknown, data: RnReplayRequest | unknown, reply: (result: RnReplayResult) => void): void {
  const req = parseReplay(data);
  const now = Date.now();
  if (!req) {
    const runId = isObject(data) && typeof data.runId === 'string' ? data.runId : '';
    const url = isObject(data) && typeof data.url === 'string' ? data.url : '';
    if (runId) reply({ ...baseResult(runId, url, now), error: 'Invalid replay request' });
    return;
  }
  if (typeof fetchFn !== 'function') {
    reply({ ...baseResult(req.runId, req.url, now), error: 'fetch is not available in this app' });
    return;
  }
  execute(fetchFn as AnyFetch, req).then(reply, (error) => reply({ ...baseResult(req.runId, req.url, now), error: errorText(error) }));
}

export function abortReplay(runId: string): void {
  active.get(runId)?.();
}

export function abortAllReplays(): void {
  for (const abort of Array.from(active.values())) abort();
}
