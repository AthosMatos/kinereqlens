// Pure assembly of RequestEntry snapshots from chrome.webRequest events. Each helper returns a new
// object (never mutates) so the collector can keep immutable snapshots and these stay unit-testable
// without the chrome global.
import { getHeader } from '../lib/headers';
import { mapResourceType, webRequestBodyToSerialized, webRequestHeadersToPairs } from '../lib/capture';
import type { WebRequestBodyLike } from '../lib/capture';
import { utf8Decode } from '../lib/encoding';
import type { HeaderPair, RequestEntry, WireInfo } from '../shared/types';

/** Fields every webRequest event carries (subset of chrome.webRequest.WebRequestDetails). */
export interface WrBaseDetails {
  requestId: string;
  url: string;
  method: string;
  frameId: number;
  tabId: number;
  type: string;
  timeStamp: number;
  initiator?: string;
  documentLifecycle?: string;
  /** Document that made the request (absent for navigation requests). */
  documentId?: string;
  /** Parent document of the request's frame (subframes). */
  parentDocumentId?: string;
  /** -1 for the outermost frame (also non-primary main frames: prerender, bfcache, pending deletion). */
  parentFrameId?: number;
}

/** chrome.webRequest.HttpHeader (binaryValue is an ArrayBuffer in Chrome). */
export interface WrHeader {
  name: string;
  value?: string;
  binaryValue?: ArrayBuffer | number[];
}

/** onBeforeRequest `requestBody`; formData values may be ArrayBuffers for non-UTF-8 fields. */
export interface WrRequestBody {
  error?: string;
  formData?: Record<string, Array<string | ArrayBuffer>>;
  raw?: Array<{ bytes?: ArrayBuffer; file?: string }>;
}

export interface WrStatusDetails {
  statusCode: number;
  statusLine: string;
}

/** Store id of the webRequest entry for a request id. */
export function wrEntryId(requestId: string): string {
  return `w:${requestId}`;
}

/** "HTTP/1.1 404 Not Found" -> "Not Found"; "HTTP/2 200" -> "". */
export function parseStatusText(statusLine: string | undefined): string {
  if (!statusLine) return '';
  const match = /^\S+\s+\d{3}(?:\s+(.*))?$/.exec(statusLine.trim());
  return match?.[1]?.trim() ?? '';
}

/** Convert ArrayBuffer form values (non-UTF-8 fields) to text so capture helpers get plain strings. */
export function normalizeRequestBody(body: WrRequestBody | undefined | null): WebRequestBodyLike | null {
  if (!body) return null;
  const out: WebRequestBodyLike = {};
  if (body.error !== undefined) out.error = body.error;
  if (body.raw) out.raw = body.raw;
  if (body.formData) {
    const formData: Record<string, string[]> = {};
    for (const [name, values] of Object.entries(body.formData)) {
      formData[name] = values.map((v) => (typeof v === 'string' ? v : utf8Decode(new Uint8Array(v))));
    }
    out.formData = formData;
  }
  return out;
}

/** Initial (pending) snapshot from the first event seen for a request. */
export function createWrEntry(
  details: WrBaseDetails & { requestBody?: WrRequestBody | null },
  bodyCap: number,
): RequestEntry {
  const wire: WireInfo = { requestId: details.requestId, type: details.type };
  const entry: RequestEntry = {
    id: wrEntryId(details.requestId),
    source: 'webRequest',
    kind: mapResourceType(details.type),
    frameId: details.frameId,
    pageUrl: '',
    method: details.method,
    url: details.url,
    requestHeaders: [],
    requestBody: webRequestBodyToSerialized(normalizeRequestBody(details.requestBody), bodyCap),
    requestContentType: null,
    startTime: Math.round(details.timeStamp),
    state: 'pending',
    wire,
  };
  if (details.initiator !== undefined) entry.initiator = details.initiator;
  return entry;
}

/**
 * onSendHeaders: headers actually sent. Only the first hop's headers are kept (a redirect re-fires
 * onSendHeaders for the new URL, but the entry's url/method/body describe the initial request).
 */
export function withRequestHeaders(entry: RequestEntry, headers: WrHeader[] | undefined): RequestEntry {
  if (entry.redirected && entry.requestHeaders.length > 0) return entry;
  const pairs: HeaderPair[] = webRequestHeadersToPairs(headers);
  return {
    ...entry,
    requestHeaders: pairs,
    requestContentType: getHeader(pairs, 'content-type') ?? entry.requestContentType,
    wire: { ...wireOf(entry), requestHeaders: pairs },
  };
}

/** onHeadersReceived: status line and full response headers of the latest hop. */
export function withResponseHeaders(
  entry: RequestEntry,
  details: WrStatusDetails & { responseHeaders?: WrHeader[] },
): RequestEntry {
  const responseHeaders = webRequestHeadersToPairs(details.responseHeaders);
  return {
    ...entry,
    status: details.statusCode,
    statusText: parseStatusText(details.statusLine),
    responseHeaders,
    wire: { ...wireOf(entry), statusCode: details.statusCode, responseHeaders },
  };
}

/** onBeforeRedirect: the request continues at `redirectUrl` under the same request id. */
export function withRedirect(
  entry: RequestEntry,
  details: WrStatusDetails & { redirectUrl: string; fromCache?: boolean; ip?: string },
): RequestEntry {
  return {
    ...entry,
    redirected: true,
    responseUrl: details.redirectUrl,
    wire: { ...wireOf(entry), ...(details.ip !== undefined ? { ip: details.ip } : {}) },
  };
}

/** onCompleted: final status of the request. */
export function withCompleted(
  entry: RequestEntry,
  details: WrStatusDetails & { url: string; timeStamp: number; fromCache?: boolean; ip?: string },
): RequestEntry {
  const fromCache = details.fromCache === true;
  const hasStatus = details.statusCode > 0;
  const wire: WireInfo = {
    ...wireOf(entry),
    fromCache,
    ...(details.ip !== undefined ? { ip: details.ip } : {}),
    ...(hasStatus ? { statusCode: details.statusCode } : {}),
  };
  const next: RequestEntry = { ...entry, state: 'done', endTime: Math.round(details.timeStamp), fromCache, wire };
  if (hasStatus) {
    next.status = details.statusCode;
    next.statusText = parseStatusText(details.statusLine);
  }
  if (details.url && details.url !== entry.url) {
    next.responseUrl = details.url;
    next.redirected = true;
  }
  return next;
}

/** onErrorOccurred: net::ERR_ABORTED (navigation away, AbortController, ...) is an abort, not a failure. */
export function withError(
  entry: RequestEntry,
  details: { error: string; timeStamp: number; fromCache?: boolean; ip?: string },
): RequestEntry {
  return {
    ...entry,
    state: details.error === 'net::ERR_ABORTED' ? 'aborted' : 'error',
    error: details.error,
    endTime: Math.round(details.timeStamp),
    ...(details.fromCache !== undefined ? { fromCache: details.fromCache } : {}),
    wire: { ...wireOf(entry), ...(details.ip !== undefined ? { ip: details.ip } : {}) },
  };
}

/** Entry reached a final state (done / error / aborted). */
export function isSettled(entry: RequestEntry): boolean {
  return entry.state !== 'pending';
}

/**
 * Rough serialized size of an entry in bytes (bodies + headers dominate). Used to split WR_ENTRIES
 * batches well below the extension messaging limit without JSON-stringifying every snapshot.
 */
export function estimateEntrySize(entry: RequestEntry): number {
  let size = 512 + entry.url.length + (entry.responseUrl?.length ?? 0);
  for (const h of entry.requestHeaders) size += h.name.length + h.value.length + 24;
  for (const h of entry.responseHeaders ?? []) size += h.name.length + h.value.length + 24;
  // Wire headers duplicate the entry-level ones.
  size *= 2;
  const body = entry.requestBody;
  if (body) {
    switch (body.kind) {
      case 'text':
        size += body.text.length * 2;
        break;
      case 'base64':
        size += body.base64.length;
        break;
      case 'formFields':
        for (const f of body.fields) size += (f.name.length + f.value.length) * 2 + 24;
        break;
      case 'formData':
        for (const e of body.entries) size += e.name.length + (e.type === 'text' ? e.value.length * 2 : (e.base64?.length ?? 0)) + 64;
        break;
      case 'unavailable':
        size += body.reason.length;
        break;
    }
  }
  return size;
}

/** Split entries into batches of at most `maxCount` entries and (roughly) `maxBytes` each. */
export function chunkEntries(entries: RequestEntry[], maxCount: number, maxBytes: number): RequestEntry[][] {
  const chunks: RequestEntry[][] = [];
  let current: RequestEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = estimateEntrySize(entry);
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function wireOf(entry: RequestEntry): WireInfo {
  return entry.wire ?? { requestId: entry.id.replace(/^w:/, '') };
}
