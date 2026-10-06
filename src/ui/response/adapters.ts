// OWNER: ui-response agent. Normalize captured entries and replay results for the response viewer.
import type {
  EntryKind,
  HeaderPair,
  ReplayResult,
  RequestEntry,
  ResponseData,
  SerializedBody,
  TestRun,
} from '../../shared/types';
import { getHeader, parseContentType } from '../../lib/headers';

/** bodyNote of user-composed requests that were never sent. */
export const NOT_SENT_NOTE = 'Not sent yet';

/** Human label of an entry kind as used in sentences ("… for script requests …"). */
const KIND_LABELS: Record<EntryKind, string> = {
  fetch: 'fetch',
  xhr: 'XHR/fetch',
  beacon: 'beacon',
  document: 'document',
  subdocument: 'iframe document',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  media: 'media',
  websocket: 'WebSocket',
  ping: 'ping',
  manual: 'manual',
  other: 'other',
};

/** Human label of an entry kind. */
export function kindLabel(kind: EntryKind): string {
  return KIND_LABELS[kind] ?? kind;
}

const REASON_PHRASES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  511: 'Network Authentication Required',
};

/** Standard reason phrase for a status code ('' when unknown). HTTP/2+ responses carry no statusText. */
export function reasonPhrase(status: number | undefined): string {
  return (status !== undefined && REASON_PHRASES[status]) || '';
}

/** Status text to display: the server's own text when present, else the standard reason phrase. */
export function displayStatusText(resp: Pick<ResponseData, 'status' | 'statusText'>): string {
  const own = resp.statusText?.trim();
  return own ? own : reasonPhrase(resp.status);
}

/** Statuses whose responses never carry a body. */
function isNoBodyStatus(status: number | undefined): boolean {
  return status !== undefined && ((status >= 100 && status < 200) || status === 204 || status === 205 || status === 304);
}

/** True when a response is opaque to the page (no-cors fetch / manual redirect). */
export function isOpaque(resp: Pick<ResponseData, 'type' | 'status' | 'state'>): boolean {
  return resp.type === 'opaque' || resp.type === 'opaqueredirect' || (resp.status === 0 && resp.state === 'done');
}

/**
 * Text of the status pill: the status code, or the state when there is none
 * ("Sending", "Pending", "Error", "Aborted", "Opaque", "—").
 */
export function statusLabel(resp: Pick<ResponseData, 'state' | 'status' | 'type'>): string {
  if (resp.state === 'running') return 'Sending';
  if (resp.state === 'pending') return 'Pending';
  if (resp.status !== undefined && resp.status > 0) return String(resp.status);
  if (resp.state === 'aborted') return 'Aborted';
  if (resp.state === 'error') return 'Error';
  if (isOpaque(resp)) return 'Opaque';
  return '—';
}

/** The more complete of the page-visible and network-level header lists. */
function pickResponseHeaders(entry: RequestEntry): HeaderPair[] {
  const page = entry.responseHeaders ?? [];
  const wire = entry.wire?.responseHeaders ?? [];
  return wire.length > page.length ? wire : page;
}

function contentLengthOf(headers: HeaderPair[]): number | undefined {
  const raw = getHeader(headers, 'content-length');
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function bodySize(body: SerializedBody | null): number | undefined {
  return body && (body.kind === 'text' || body.kind === 'base64') ? body.size : undefined;
}

/** Split an `unavailable` body into (null body, explanatory note). */
function normalizeBody(body: SerializedBody | null | undefined): { body: SerializedBody | null; note?: string } {
  if (!body) return { body: null };
  if (body.kind === 'unavailable') return { body: null, note: `Response body unavailable — ${body.reason}` };
  return { body };
}

function noBodyNote(status: number | undefined, method: string): string | undefined {
  if (isNoBodyStatus(status)) {
    const reason = reasonPhrase(status);
    return `No body (${status}${reason ? ` ${reason}` : ''}).`;
  }
  if (method.toUpperCase() === 'HEAD') return 'HEAD responses have no body.';
  return undefined;
}

/** Options for {@link entryToResponseDataWith}. */
export interface EntryResponseOptions {
  /** `settings.captureResponseBodies`; when false, a missing hook-captured body is explained as disabled. */
  captureResponseBodies?: boolean;
}

function entryBodyNote(entry: RequestEntry, status: number | undefined, opts: EntryResponseOptions): string {
  if (entry.source === 'manual' || entry.kind === 'manual') return NOT_SENT_NOTE;
  if (entry.state === 'pending') return 'Waiting for the response…';
  if (entry.kind === 'beacon') return "sendBeacon requests don't expose a response to the page — send a test request to see it.";
  if (entry.source === 'webRequest') {
    return `Response body isn't available for ${kindLabel(entry.kind)} requests captured from the network layer — send a test request to see it.`;
  }
  if (entry.state === 'aborted') return 'The request was aborted before the response body arrived.';
  if (entry.state === 'error') return 'The request failed — no response body was received.';
  const noBody = noBodyNote(status, entry.method);
  if (noBody) return noBody;
  const mime = parseContentType(getHeader(pickResponseHeaders(entry), 'content-type')).mime;
  if (mime === 'text/event-stream' || mime === 'multipart/x-mixed-replace') {
    return `Streaming responses (${mime}) aren't captured — send a test request to see a snapshot.`;
  }
  if (opts.captureResponseBodies === false) {
    return 'Response body capture is disabled in Settings — send a test request to see the body.';
  }
  return "The response body wasn't captured — send a test request to see it.";
}

/** Like {@link entryToResponseData}, with extra context that refines the explanation of missing bodies. */
export function entryToResponseDataWith(entry: RequestEntry, opts: EntryResponseOptions): ResponseData {
  const status = entry.status ?? entry.wire?.statusCode;
  const headers = pickResponseHeaders(entry);
  const { body, note } = normalizeBody(entry.source === 'manual' ? null : entry.responseBody);
  const data: ResponseData = {
    state: entry.state,
    status,
    statusText: entry.statusText,
    headers,
    body,
    url: entry.responseUrl ?? entry.url,
    redirected: entry.redirected,
    durationMs: entry.endTime !== undefined ? Math.max(0, entry.endTime - entry.startTime) : undefined,
    size: bodySize(body) ?? (entry.state === 'done' ? contentLengthOf(headers) : undefined),
    error: entry.error,
  };
  if (!body) data.bodyNote = note ?? entryBodyNote(entry, status, opts);
  return data;
}

/** Original captured response of an entry (bodyNote explains missing bodies for webRequest/beacon/manual entries). */
export function entryToResponseData(entry: RequestEntry): ResponseData {
  return entryToResponseDataWith(entry, {});
}

function resultBodyNote(result: ReplayResult, method: string | undefined): string {
  if (result.aborted) return 'Cancelled — no response was received.';
  if (result.timedOut) return 'Timed out — no response was received.';
  if (!result.ok) return 'No response — the request failed before a response arrived.';
  if (result.type === 'opaqueredirect') return 'Redirect not followed (redirect: "manual") — the response is opaque.';
  if (result.type === 'opaque') return 'Opaque response — its body is not readable.';
  return noBodyNote(result.status, method ?? '') ?? 'No response body.';
}

function resultToResponseDataFor(result: ReplayResult, method?: string): ResponseData {
  const state: ResponseData['state'] = result.aborted ? 'aborted' : result.ok ? 'done' : 'error';
  const { body, note } = normalizeBody(result.body);
  const error =
    result.ok || result.aborted ? result.error : (result.error ?? (result.timedOut ? 'Timed out' : 'Request failed'));
  const data: ResponseData = {
    state,
    status: result.ok || result.status > 0 ? result.status : undefined,
    statusText: result.statusText,
    headers: result.headers ?? [],
    body,
    url: result.url || undefined,
    redirected: result.redirected,
    type: result.type,
    durationMs: Math.max(0, result.timing.end - result.timing.start),
    size: result.size,
    error,
    errorHint: result.errorHint,
  };
  if (!body) data.bodyNote = note ?? resultBodyNote(result, method);
  return data;
}

/** Normalize a replay result. */
export function resultToResponseData(result: ReplayResult): ResponseData {
  return resultToResponseDataFor(result);
}

/** Running runs map to state 'running'; finished runs use their result. */
export function runToResponseData(run: TestRun): ResponseData {
  if (run.state === 'running') {
    return { state: 'running', headers: [], body: null, url: run.request.url, bodyNote: 'Waiting for the response…' };
  }
  if (run.result) return resultToResponseDataFor(run.result, run.request.method);
  return {
    state: run.state,
    headers: [],
    body: null,
    url: run.request.url,
    error: run.state === 'error' ? 'No result was recorded for this run.' : undefined,
    bodyNote: run.state === 'aborted' ? 'Cancelled — no response was received.' : 'No response.',
  };
}

/** Whether a response has a body worth comparing against (text or binary content). */
export function hasComparableBody(resp: ResponseData | null | undefined): boolean {
  const kind = resp?.body?.kind;
  return kind === 'text' || kind === 'base64';
}
