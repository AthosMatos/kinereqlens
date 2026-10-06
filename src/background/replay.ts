// Test-request execution in the service worker:
//  - extension mode: fetch from the worker (no CORS), browser-controlled headers via a DNR session rule;
//  - page mode for a subframe: forwarded to that frame's content script (REPLAY_IN_PAGE).
import { base64ToBytes, bytesToBase64, tryDecodeUtf8, utf8Decode, utf8Encode } from '../lib/encoding';
import { getHeader, isTextualMime, parseContentType } from '../lib/headers';
import type { HeaderPair, ReplayRequest, ReplayResult, SerializedBody } from '../shared/types';
import type { TabMessage } from '../shared/messages';
import type { DnrManager } from './dnr';
import { splitReplayHeaders } from './dnr';
import { mergeSetCookies } from './replay-observer';
import type { ReplayObserver, ReplayWatch } from './replay-observer';
import type { KeepAlive } from './util';
import { errorMessage, isNoReceiverError, isRecord, withTimeout } from './util';

/**
 * Extra time a forwarded page-mode replay gets beyond its own timeout before the worker gives up. Longer
 * than the content script's own safety margin (timeoutMs + 5 s) so the frame's more specific error wins.
 */
export const PAGE_REPLAY_GRACE_MS = 8000;
/** Max time spent waiting for webRequest to report Set-Cookie / redirect headers of a finished replay. */
const OBSERVER_WAIT_MS = 100;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** A failed run (no response). */
export function errorResult(
  runId: string,
  url: string,
  start: number,
  error: string,
  extra: Partial<ReplayResult> = {},
  now: number = Date.now(),
): ReplayResult {
  return {
    runId,
    ok: false,
    status: 0,
    statusText: '',
    headers: [],
    body: null,
    url,
    redirected: false,
    timing: { start, end: now },
    size: 0,
    error,
    ...extra,
  };
}

/** Decode a (possibly truncated) response body: textual mime -> text (declared charset), else base64. */
export function decodeResponseBody(bytes: Uint8Array, contentType: string | null | undefined, truncated: boolean): SerializedBody {
  const size = bytes.byteLength;
  const flags = truncated ? { truncated: true as const } : {};
  const { mime, params } = parseContentType(contentType);
  if (mime === '') {
    const text = tryDecodeUtf8(bytes);
    return text !== null ? { kind: 'text', text, size, ...flags } : { kind: 'base64', base64: bytesToBase64(bytes), size, ...flags };
  }
  if (isTextualMime(mime)) return { kind: 'text', text: decodeText(bytes, params.charset), size, ...flags };
  return { kind: 'base64', base64: bytesToBase64(bytes), size, ...flags };
}

function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      // Unknown label: fall back to UTF-8.
    }
  }
  return utf8Decode(bytes);
}

/**
 * Read a body stream up to `cap` bytes, cancelling the stream at the cap. A read failure (abort,
 * timeout, connection reset) stops reading and is returned with the bytes received so far.
 */
export async function readBodyCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean; error?: unknown }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let error: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) {
        chunks.push(value.subarray(0, cap - total));
        total = cap;
        truncated = true;
        reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    error = err;
    truncated = true;
  } finally {
    reader.releaseLock();
  }
  const bytes = concatBytes(chunks, total);
  return error === undefined ? { bytes, truncated } : { bytes, truncated, error };
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === total) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** fetch Headers -> pairs (names come lower-cased and combined by the Headers class). */
export function headersToPairs(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => pairs.push({ name, value }));
  return pairs;
}

/** Hint for a fetch TypeError in extension mode. */
export function networkErrorHint(req: ReplayRequest): string {
  if (req.redirect === 'error') return 'The server redirected and redirect mode is "error" — switch redirect to follow or manual.';
  return 'Network error: DNS failure, refused connection, invalid TLS certificate, or the request was blocked by the browser or another extension.';
}

/** Loose shape check of a ReplayResult coming back from a content script. */
export function isReplayResultFor(value: unknown, runId: string): value is ReplayResult {
  return (
    isRecord(value) &&
    value.runId === runId &&
    typeof value.ok === 'boolean' &&
    typeof value.status === 'number' &&
    Array.isArray(value.headers) &&
    isRecord(value.timing)
  );
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export interface ReplayRunnerDeps {
  dnr: DnrManager;
  observer: ReplayObserver;
  keepAlive: KeepAlive;
  sendToFrame(tabId: number, frameId: number, message: TabMessage): Promise<unknown>;
  fetch?: typeof fetch;
  now?(): number;
}

type AbortCause = 'timeout' | 'user';

interface RunningReplay {
  tabId: number;
  abort(cause: AbortCause): void;
}

export class ReplayRunner {
  private readonly running = new Map<string, RunningReplay>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: ReplayRunnerDeps) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Run a validated replay. Never rejects. `invalidHeaders` (removed during validation) are reported in
   * `droppedHeaders` together with headers that cannot be sent in the chosen mode.
   */
  run(tabId: number, req: ReplayRequest, invalidHeaders: string[]): Promise<ReplayResult> {
    if (this.running.has(req.runId)) {
      return Promise.resolve(errorResult(req.runId, req.url, this.now(), 'A run with this id is already in progress'));
    }
    return req.mode === 'page' ? this.runInFrame(tabId, req, invalidHeaders) : this.runExtension(tabId, req, invalidHeaders);
  }

  /** Abort a run started from `tabId`. Page-mode runs are aborted in their frame. */
  async abort(tabId: number, runId: string, frameId: number, mode: ReplayRequest['mode']): Promise<boolean> {
    const run = this.running.get(runId);
    if (run && run.tabId === tabId) {
      run.abort('user');
      if (mode === 'extension') return true;
    }
    if (mode !== 'page') return false;
    try {
      await this.deps.sendToFrame(tabId, frameId, { type: 'ABORT_IN_PAGE', runId });
      return true;
    } catch {
      return false;
    }
  }

  /** Abort every run of a closed tab. */
  abortTab(tabId: number): void {
    for (const run of [...this.running.values()]) if (run.tabId === tabId) run.abort('user');
  }

  // --- page mode in a subframe --------------------------------------------------------------

  private async runInFrame(tabId: number, req: ReplayRequest, invalidHeaders: string[]): Promise<ReplayResult> {
    const start = this.now();
    const release = this.deps.keepAlive.acquire();
    let settle: ((r: ReplayResult) => void) | null = null;
    const aborted = new Promise<ReplayResult>((resolve) => (settle = resolve));
    this.running.set(req.runId, {
      tabId,
      // The frame normally answers an ABORT_IN_PAGE itself; this only matters when it is gone.
      abort: () => setTimeout(() => settle?.(errorResult(req.runId, req.url, start, 'Aborted', { aborted: true }, this.now())), 1000),
    });
    try {
      const reply = await Promise.race([
        withTimeout(
          this.deps.sendToFrame(tabId, req.frameId, { type: 'REPLAY_IN_PAGE', req }),
          req.timeoutMs + PAGE_REPLAY_GRACE_MS,
          `No answer from the page frame within ${Math.round((req.timeoutMs + PAGE_REPLAY_GRACE_MS) / 1000)} s`,
        ),
        aborted,
      ]);
      if (!isReplayResultFor(reply, req.runId)) {
        return errorResult(req.runId, req.url, start, 'The page frame did not return a result', {
          errorHint: 'kineReqLens may not be active in that frame — reload the page or use Extension mode.',
        });
      }
      return invalidHeaders.length > 0
        ? { ...reply, droppedHeaders: [...new Set([...(reply.droppedHeaders ?? []), ...invalidHeaders])] }
        : reply;
    } catch (err) {
      const gone = isNoReceiverError(err);
      return errorResult(req.runId, req.url, start, gone ? 'The frame that made this request is gone' : errorMessage(err), {
        errorHint: gone
          ? 'The iframe navigated or was removed. Reload the page to capture it again, or use Extension mode.'
          : 'Use Extension mode to send the request from the extension instead.',
      });
    } finally {
      settle = null;
      this.running.delete(req.runId);
      release();
    }
  }

  // --- extension mode -----------------------------------------------------------------------

  private async runExtension(tabId: number, req: ReplayRequest, invalidHeaders: string[]): Promise<ReplayResult> {
    const { fetchHeaders, dnrHeaders, dropped } = splitReplayHeaders(req.headers);
    const droppedHeaders = [...invalidHeaders, ...dropped];
    const controller = new AbortController();
    let cause: AbortCause | null = null;
    const abort = (why: AbortCause): void => {
      if (cause !== null) return;
      cause = why;
      controller.abort(new DOMException(why === 'timeout' ? 'Timed out' : 'Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => abort('timeout'), req.timeoutMs);
    this.running.set(req.runId, { tabId, abort });
    const release = this.deps.keepAlive.acquire();
    const watch = this.deps.observer.watch(req.method, req.url);

    let start = this.now();
    let headersAt: number | undefined;
    let appliedViaDnr: string[] = [];
    let response: Response | null = null;
    const notes = (): Partial<ReplayResult> => ({
      ...(appliedViaDnr.length > 0 ? { appliedViaDnr } : {}),
      ...(droppedHeaders.length > 0 ? { droppedHeaders: [...new Set(droppedHeaders)] } : {}),
    });

    try {
      const init = buildFetchInit(req, fetchHeaders, droppedHeaders, controller.signal);
      const send = (): Promise<Response> => {
        start = this.now();
        return this.fetchImpl(req.url, init);
      };
      if (dnrHeaders.length > 0) {
        const outcome = await this.deps.dnr.withHeaders({ url: req.url, method: req.method, headers: dnrHeaders }, controller.signal, send);
        response = outcome.value;
        appliedViaDnr = outcome.applied;
        droppedHeaders.push(...outcome.failed);
      } else {
        response = await this.deps.dnr.withoutHeaders(req.url, controller.signal, send);
      }
      headersAt = this.now();
      return await this.finish(req, response, watch, start, headersAt, notes, () => cause);
    } catch (err) {
      return this.failure(req, err, cause, watch, start, headersAt, response, notes());
    } finally {
      clearTimeout(timer);
      this.running.delete(req.runId);
      this.deps.observer.unwatch(watch);
      release();
    }
  }

  private async finish(
    req: ReplayRequest,
    response: Response,
    watch: ReplayWatch,
    start: number,
    headersAt: number,
    notes: () => Partial<ReplayResult>,
    causeOf: () => AbortCause | null,
  ): Promise<ReplayResult> {
    let status = response.status;
    let statusText = response.statusText;
    let headers = headersToPairs(response.headers);
    let body: SerializedBody | null = null;
    let size = 0;

    if (response.type === 'opaqueredirect') {
      // redirect: 'manual' hides the 3xx; webRequest saw it.
      const hop = await this.deps.observer.hopFor(watch, req.url, OBSERVER_WAIT_MS);
      if (hop) {
        status = hop.statusCode;
        statusText = hop.statusText;
        headers = hop.headers;
      }
    } else if (response.body) {
      if (req.responseBodyCap <= 0) {
        response.body.cancel().catch(() => undefined);
        body = { kind: 'unavailable', reason: 'Response body capture is disabled (cap = 0)' };
      } else {
        const read = await readBodyCapped(response.body, req.responseBodyCap);
        body = decodeResponseBody(read.bytes, getHeader(headers, 'content-type'), read.truncated);
        size = read.bytes.byteLength;
        if (read.error !== undefined) {
          // Aborted / timed out / reset while streaming: report the failure with what arrived so far.
          const failed = await this.failure(req, read.error, causeOf(), watch, start, headersAt, response, notes());
          return { ...failed, body, size };
        }
      }
    }

    // Timing ends with the body; the (bounded) wait for webRequest below is kineReqLens overhead.
    const end = this.now();
    if (response.type !== 'opaqueredirect') {
      const finalUrl = stripHash(response.url || req.url);
      headers = mergeSetCookies(headers, await this.deps.observer.hopFor(watch, finalUrl, OBSERVER_WAIT_MS));
    }

    return {
      runId: req.runId,
      ok: true,
      status,
      statusText,
      headers,
      body,
      url: response.url || req.url,
      redirected: response.redirected,
      type: response.type,
      timing: { start, headers: headersAt, end },
      size,
      ...notes(),
    };
  }

  private async failure(
    req: ReplayRequest,
    err: unknown,
    cause: AbortCause | null,
    watch: ReplayWatch,
    start: number,
    headersAt: number | undefined,
    response: Response | null,
    notes: Partial<ReplayResult>,
  ): Promise<ReplayResult> {
    // Abort / timeout after the headers arrived keeps what is known about the response.
    const partial: Partial<ReplayResult> = response
      ? {
          status: response.status,
          statusText: response.statusText,
          headers: headersToPairs(response.headers),
          url: response.url || req.url,
          redirected: response.redirected,
          type: response.type,
          timing: { start, headers: headersAt, end: this.now() },
        }
      : {};
    if (cause === 'timeout') {
      return errorResult(req.runId, req.url, start, `Timed out after ${formatSeconds(req.timeoutMs)}`, {
        ...notes,
        ...partial,
        timedOut: true,
        errorHint: 'Increase the timeout in the request options, or check that the server responds.',
      });
    }
    if (cause === 'user') return errorResult(req.runId, req.url, start, 'Aborted', { ...notes, ...partial, aborted: true });

    const message = errorMessage(err);
    let errorHint = err instanceof TypeError ? networkErrorHint(req) : undefined;
    if (req.redirect === 'error') {
      const hop = await this.deps.observer.hopFor(watch, req.url, OBSERVER_WAIT_MS);
      const location = hop && getHeader(hop.headers, 'location');
      if (hop && location) errorHint = `The server answered ${hop.statusCode} redirecting to ${location}; redirect mode is "error".`;
    }
    return errorResult(req.runId, req.url, start, message, { ...notes, ...partial, ...(errorHint ? { errorHint } : {}) });
  }
}

function buildFetchInit(req: ReplayRequest, headers: HeaderPair[], dropped: string[], signal: AbortSignal): RequestInit {
  const fetchHeaders = new Headers();
  for (const { name, value } of headers) {
    try {
      fetchHeaders.append(name, value);
    } catch {
      dropped.push(name);
    }
  }
  const hasContentType = fetchHeaders.has('content-type');
  const init: RequestInit = {
    method: req.method,
    headers: fetchHeaders,
    credentials: req.credentials,
    redirect: req.redirect,
    cache: 'no-store',
    signal,
  };
  // A string body would gain "Content-Type: text/plain;charset=UTF-8" when none is set: send exactly the
  // headers shown (a captured bytes body had no Content-Type), so such text goes out as bytes.
  if (req.body.kind === 'text') init.body = hasContentType ? req.body.text : toArrayBufferView(utf8Encode(req.body.text));
  else if (req.body.kind === 'base64') init.body = toArrayBufferView(base64ToBytes(req.body.base64));
  return init;
}

/** BodyInit needs an ArrayBuffer-backed view (not SharedArrayBuffer); copy only when it is not. */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

function stripHash(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}
