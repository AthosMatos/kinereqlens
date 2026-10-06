// OWNER: lib-body agent. Pure capture helpers shared by the content-script store and the service worker.
import type {
  EntryKind,
  FormDataEntryInfo,
  HeaderPair,
  HookRequestEnd,
  HookRequestStart,
  RequestEntry,
  SerializedBody,
  WireInfo,
} from '../shared/types';
import {
  base64ByteLength,
  base64ToBytes,
  bytesToBase64,
  tryDecodeUtf8,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from './encoding';
import { capStackText } from './stack';

/** Initiator stack kept in a preserved log (characters, cut at a line boundary). */
export const PRESERVED_STACK_CAP = 4 * 1024;

/** Minimal shape of chrome.webRequest request bodies (so this module stays testable without chrome types). */
export interface WebRequestBodyLike {
  error?: string;
  formData?: Record<string, Array<string>>;
  raw?: Array<{ bytes?: ArrayBuffer; file?: string }>;
}

/** A byte cap as a usable number: negative / NaN -> 0, fractional -> floor, Infinity stays. */
function normalizeCap(cap: number): number {
  return typeof cap === 'number' && cap >= 0 ? Math.floor(cap) : 0;
}

function unavailable(reason: string): SerializedBody {
  return { kind: 'unavailable', reason };
}

// ---------------------------------------------------------------------------------------------
// Byte / text helpers
// ---------------------------------------------------------------------------------------------

/** Length of the longest prefix of `bytes` that does not end inside a multi-byte UTF-8 sequence. */
function completeUtf8Length(bytes: Uint8Array): number {
  const length = bytes.length;
  let index = length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (bytes[index] & 0xc0) === 0x80) {
    index--;
    continuation++;
  }
  if (index < 0) return length;
  const lead = bytes[index];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return length - index >= needed ? length : index;
}

/** Prefix of `text` whose UTF-8 encoding fits in `cap` bytes, never splitting a character. */
function truncateUtf8(text: string, cap: number): string {
  if (cap <= 0) return '';
  // `cap` UTF-16 code units always encode to at least `cap` bytes, so this slice covers the byte prefix.
  const bytes = utf8Encode(text.length > cap ? text.slice(0, cap) : text);
  const head = bytes.subarray(0, Math.min(cap, bytes.length));
  return utf8Decode(head.subarray(0, completeUtf8Length(head)));
}

/** Captured request bytes: UTF-8 text when they decode cleanly, else base64. */
function bytesToSerialized(bytes: Uint8Array, total: number): SerializedBody {
  const truncated = total > bytes.length;
  const flag = truncated ? { truncated: true } : {};
  const text = tryDecodeUtf8(truncated ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes);
  if (text !== null) return { kind: 'text', text, size: total, ...flag };
  return { kind: 'base64', base64: bytesToBase64(bytes), size: total, ...flag };
}

/** Byte view of an ArrayBuffer (also one from another realm, where `instanceof` fails) or a typed array. */
function viewOf(data: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// chrome.webRequest conversions
// ---------------------------------------------------------------------------------------------

/**
 * formData -> { kind: 'formFields' } (ordered by object key order, then value order);
 * raw bytes -> concatenated, then text (if tryDecodeUtf8 succeeds) or base64, capped at `cap` bytes with
 * truncated/size set; raw `file` entries -> unavailable("file upload: <path>"); error -> unavailable(error).
 * Returns null when there is no body at all.
 */
export function webRequestBodyToSerialized(
  body: WebRequestBodyLike | undefined | null,
  cap: number,
): SerializedBody | null {
  if (!body || typeof body !== 'object') return null;
  if (body.error !== undefined) return unavailable(String(body.error) || 'Request body unavailable');
  if (body.formData && typeof body.formData === 'object') {
    const fields: Array<{ name: string; value: string }> = [];
    for (const name of Object.keys(body.formData)) {
      const values = body.formData[name];
      if (!Array.isArray(values)) continue;
      for (const value of values) fields.push({ name, value: typeof value === 'string' ? value : String(value) });
    }
    return { kind: 'formFields', fields };
  }
  if (!Array.isArray(body.raw) || body.raw.length === 0) return null;

  const chunks: Uint8Array[] = [];
  for (const element of body.raw) {
    if (element && typeof element.file === 'string') return unavailable(`file upload: ${element.file}`);
    const view = viewOf(element?.bytes);
    if (view) chunks.push(view);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const limit = normalizeCap(cap);
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return bytesToSerialized(out, total);
}

function binaryValueBytes(value: ArrayBuffer | number[]): Uint8Array {
  if (Array.isArray(value)) return Uint8Array.from(value, (n) => Number(n) & 0xff);
  return viewOf(value) ?? new Uint8Array(0);
}

/** chrome.webRequest headers ({ name, value?, binaryValue? }) -> HeaderPair[] (binaryValue decoded as UTF-8). */
export function webRequestHeadersToPairs(
  headers: Array<{ name: string; value?: string; binaryValue?: ArrayBuffer | number[] }> | undefined,
): HeaderPair[] {
  if (!Array.isArray(headers)) return [];
  const pairs: HeaderPair[] = [];
  for (const header of headers) {
    if (!header || typeof header.name !== 'string') continue;
    let value = '';
    if (typeof header.value === 'string') value = header.value;
    else if (header.binaryValue) value = utf8Decode(binaryValueBytes(header.binaryValue));
    pairs.push({ name: header.name, value });
  }
  return pairs;
}

const RESOURCE_KINDS: Readonly<Record<string, EntryKind>> = {
  main_frame: 'document',
  sub_frame: 'subdocument',
  xmlhttprequest: 'xhr',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  imageset: 'image',
  font: 'font',
  media: 'media',
  object: 'other',
  ping: 'ping',
  csp_report: 'ping',
  websocket: 'websocket',
  other: 'other',
};

/** main_frame->document, sub_frame->subdocument, xmlhttprequest->xhr, stylesheet, script, image, imageset->image, font, media, object->other, ping, csp_report->ping, websocket, other. */
export function mapResourceType(type: string): EntryKind {
  return typeof type === 'string' && Object.hasOwn(RESOURCE_KINDS, type) ? RESOURCE_KINDS[type] : 'other';
}

// ---------------------------------------------------------------------------------------------
// Hook entries
// ---------------------------------------------------------------------------------------------

/** Build a store entry from a hook 'start' message. */
export function entryFromHookStart(
  frameId: number,
  start: HookRequestStart,
  pageUrl: string,
): RequestEntry {
  const entry: RequestEntry = {
    id: `h:${frameId}:${start.hookId}`,
    source: 'hook',
    kind: start.kind,
    frameId,
    pageUrl,
    method: start.method,
    url: start.url,
    requestHeaders: start.headers.map((header) => ({ name: header.name, value: header.value })),
    requestBody: start.body ?? null,
    requestContentType: start.contentType ?? null,
    startTime: start.startTime,
    state: 'pending',
  };
  if (start.frameUrl) entry.frameUrl = start.frameUrl;
  if (start.options && Object.keys(start.options).length > 0) entry.requestOptions = { ...start.options };
  if (typeof start.initiatorStack === 'string' && start.initiatorStack) entry.initiatorStack = start.initiatorStack;
  return entry;
}

/**
 * Apply a hook 'end' message (returns a new object).
 * A status 0 / empty statusText / empty header list (opaque responses) does not replace values already
 * known from the merged webRequest data; endTime is never earlier than startTime.
 */
export function applyHookEnd(entry: RequestEntry, end: HookRequestEnd): RequestEntry {
  const endTime = Number.isFinite(end.endTime) ? Math.max(end.endTime, entry.startTime) : entry.startTime;
  const next: RequestEntry = { ...entry, state: end.state, endTime };
  if (end.status !== undefined && !(end.status === 0 && entry.status)) next.status = end.status;
  if (end.statusText !== undefined && !(end.statusText === '' && entry.statusText)) next.statusText = end.statusText;
  if (end.headers !== undefined && !(end.headers.length === 0 && entry.responseHeaders?.length)) {
    next.responseHeaders = end.headers;
  }
  if (end.body !== undefined) next.responseBody = end.body;
  if (end.responseUrl !== undefined) next.responseUrl = end.responseUrl;
  if (end.redirected !== undefined) next.redirected = end.redirected;
  if (end.error !== undefined) next.error = end.error;
  return next;
}

// ---------------------------------------------------------------------------------------------
// Matching hook <-> webRequest
// ---------------------------------------------------------------------------------------------

/** Strip the fragment and normalize for matching (URL parser serialization when parsable). */
export function normalizeUrlForMatch(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    const hashAt = url.indexOf('#');
    return hashAt < 0 ? url : url.slice(0, hashAt);
  }
}

/** webRequest kinds that can belong to a hook capture (fetch/XHR are "xmlhttprequest", beacons "ping"). */
const HOOKABLE_WR_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['xhr', 'ping']);

/**
 * A network request starts after the JS call that issued it; timestamps of the page (Date.now) and of
 * webRequest (browser clock, rounded) may differ by about a millisecond.
 */
export const WR_ORDER_SLACK_MS = 2;

/**
 * Requests from an about:blank document (an iframe without src, or one written with document.write) are
 * attributed by webRequest to the frame whose network context they use (a non-about:blank ancestor), while
 * the hook in that document reports the about:blank frame's own id.
 */
function frameMayDiffer(hook: RequestEntry): boolean {
  return typeof hook.frameUrl === 'string' && hook.frameUrl.startsWith('about:blank');
}

/** Same frame (see frameMayDiffer), method (case-insensitive) and URL (fragment ignored). */
function sameRequest(hook: RequestEntry, wr: RequestEntry, wrNormalizedUrl: string): boolean {
  return (
    (hook.frameId === wr.frameId || frameMayDiffer(hook)) &&
    hook.method.toUpperCase() === wr.method.toUpperCase() &&
    normalizeUrlForMatch(hook.url) === wrNormalizedUrl
  );
}

/**
 * `wr` can be the network side of `hook`: it started no earlier than the JS call (slack WR_ORDER_SLACK_MS)
 * and at most `windowMs` later, and the call had not already failed before the network request started
 * (e.g. a fetch rejected for a used Request body). Beacons end right away, before their network request.
 */
function canBeNetworkOf(hook: RequestEntry, wr: RequestEntry, windowMs: number): boolean {
  const lead = wr.startTime - hook.startTime;
  if (!(lead >= -WR_ORDER_SLACK_MS && lead <= windowMs)) return false;
  return !(
    hook.kind !== 'beacon' &&
    hook.state !== 'pending' &&
    hook.endTime !== undefined &&
    hook.endTime < wr.startTime - WR_ORDER_SLACK_MS
  );
}

/**
 * Find the hook entry a webRequest entry (source 'webRequest', kind xhr/ping) belongs to:
 * same frameId (any frame for hook entries of about:blank documents), same method (case-insensitive),
 * same normalized URL, started no earlier than the hook call and at most `windowMs` after it, not already
 * linked (no `wire`, or wire.requestId === wr.wire.requestId). An entry already linked to this very request
 * id wins; otherwise the earliest call wins (identical requests reach the network in call order).
 * Restored entries never match. Returns the hook entry id or null.
 */
export function findHookMatch(
  entries: Iterable<RequestEntry>,
  wr: RequestEntry,
  windowMs: number,
): string | null {
  if (wr.source !== 'webRequest' || wr.restored || !HOOKABLE_WR_KINDS.has(wr.kind)) return null;
  const requestId = wr.wire?.requestId;
  const url = normalizeUrlForMatch(wr.url);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const entry of entries) {
    if (entry.source !== 'hook' || entry.restored) continue;
    const linked = entry.wire !== undefined;
    if (linked && (requestId === undefined || entry.wire?.requestId !== requestId)) continue;
    if (!canBeNetworkOf(entry, wr, windowMs)) continue;
    const score = linked ? -Infinity : entry.startTime;
    if (score >= bestScore || !sameRequest(entry, wr, url)) continue;
    best = entry.id;
    bestScore = score;
  }
  return best;
}

/**
 * The reverse direction: find an unlinked webRequest entry for a freshly arrived hook entry.
 * Same criteria as findHookMatch (the earliest qualifying network request wins); returns null when the hook
 * entry is already linked.
 */
export function findWebRequestMatch(
  entries: Iterable<RequestEntry>,
  hook: RequestEntry,
  windowMs: number,
): string | null {
  if (hook.source !== 'hook' || hook.wire !== undefined || hook.restored) return null;
  let best: string | null = null;
  let bestStart = Infinity;
  for (const entry of entries) {
    if (entry.source !== 'webRequest' || entry.restored || !HOOKABLE_WR_KINDS.has(entry.kind)) continue;
    if (!canBeNetworkOf(hook, entry, windowMs) || entry.startTime >= bestStart) continue;
    if (!sameRequest(hook, entry, normalizeUrlForMatch(entry.url))) continue;
    best = entry.id;
    bestStart = entry.startTime;
  }
  return best;
}

function sameHeaders(a: HeaderPair[] | undefined, b: HeaderPair[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((header, i) => header.name === b[i].name && header.value === b[i].value);
}

function sameWire(a: WireInfo | undefined, b: WireInfo): boolean {
  return (
    a !== undefined &&
    a.requestId === b.requestId &&
    a.statusCode === b.statusCode &&
    a.fromCache === b.fromCache &&
    a.ip === b.ip &&
    a.type === b.type &&
    sameHeaders(a.requestHeaders, b.requestHeaders) &&
    sameHeaders(a.responseHeaders, b.responseHeaders)
  );
}

/** WireInfo of a webRequest entry (fields of `wr.wire`, falling back to the entry-level ones). */
function wireOf(wr: RequestEntry): WireInfo {
  const source = wr.wire;
  const wire: WireInfo = { requestId: source?.requestId ?? (wr.id.startsWith('w:') ? wr.id.slice(2) : wr.id) };
  const requestHeaders = source?.requestHeaders ?? (wr.requestHeaders.length > 0 ? wr.requestHeaders : undefined);
  if (requestHeaders) wire.requestHeaders = requestHeaders;
  const statusCode = source?.statusCode ?? wr.status;
  if (statusCode !== undefined) wire.statusCode = statusCode;
  const responseHeaders = source?.responseHeaders ?? wr.responseHeaders;
  if (responseHeaders) wire.responseHeaders = responseHeaders;
  const fromCache = source?.fromCache ?? wr.fromCache;
  if (fromCache !== undefined) wire.fromCache = fromCache;
  if (source?.ip !== undefined) wire.ip = source.ip;
  if (source?.type !== undefined) wire.type = source.type;
  return wire;
}

/**
 * Merge webRequest data into a hook entry: sets wire = { requestId, requestHeaders, statusCode,
 * responseHeaders, fromCache, ip, type }; fills status/statusText/responseHeaders only when the hook has
 * none yet (e.g. opaque responses); never overwrites hook request headers/body.
 * Also takes `fromCache` and (when missing) `initiator`. Returns `hook` itself when nothing changes, so
 * repeated identical snapshots keep the entry's identity.
 */
export function mergeWire(hook: RequestEntry, wr: RequestEntry): RequestEntry {
  const wire = wireOf(wr);
  const next: RequestEntry = { ...hook, wire };
  let changed = !sameWire(hook.wire, wire);
  // A call that failed without a response (CORS, network error, ...) keeps showing no status; the network's
  // status stays visible in `wire`.
  const failed = hook.state === 'error' || hook.state === 'aborted';
  if (!hook.status && wr.status && !failed) {
    next.status = wr.status;
    changed = true;
  }
  if (!hook.statusText && wr.statusText && !failed) {
    next.statusText = wr.statusText;
    changed = true;
  }
  if (!hook.responseHeaders?.length && wr.responseHeaders?.length) {
    next.responseHeaders = wr.responseHeaders;
    changed = true;
  }
  if (wr.fromCache !== undefined && hook.fromCache !== wr.fromCache) {
    next.fromCache = wr.fromCache;
    changed = true;
  }
  if (hook.initiator === undefined && wr.initiator !== undefined) {
    next.initiator = wr.initiator;
    changed = true;
  }
  return changed ? next : hook;
}

// ---------------------------------------------------------------------------------------------
// Persistence & eviction
// ---------------------------------------------------------------------------------------------

/** Value stored instead of a credential header value in a preserved log. */
export const REDACTED_HEADER_VALUE = '[not kept in the preserved log]';
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie']);

/** Headers with credential values (Cookie, Authorization, Proxy-Authorization, Set-Cookie) replaced. */
export function redactCredentialHeaders(headers: HeaderPair[]): HeaderPair[] {
  if (!headers.some((h) => CREDENTIAL_HEADERS.has(h.name.toLowerCase()))) return headers;
  return headers.map((h) => (CREDENTIAL_HEADERS.has(h.name.toLowerCase()) ? { name: h.name, value: REDACTED_HEADER_VALUE } : h));
}

/**
 * The entry with credential header values (Cookie, Authorization, Proxy-Authorization, Set-Cookie) redacted in
 * its request, response and wire headers: what a previous page's entries may carry into the next page of the
 * tab (possibly another site).
 */
export function withoutCredentials(entry: RequestEntry): RequestEntry {
  const next: RequestEntry = { ...entry, requestHeaders: redactCredentialHeaders(entry.requestHeaders) };
  if (entry.responseHeaders) next.responseHeaders = redactCredentialHeaders(entry.responseHeaders);
  if (entry.wire) {
    const wire: WireInfo = { ...entry.wire };
    if (wire.requestHeaders) wire.requestHeaders = redactCredentialHeaders(wire.requestHeaders);
    if (wire.responseHeaders) wire.responseHeaders = redactCredentialHeaders(wire.responseHeaders);
    next.wire = wire;
  }
  return next;
}

/**
 * Copy for chrome.storage persistence: bodies capped at `bodyCap` (marking truncated), id prefixed "r:",
 * restored = true. Credential header values (cookies, authorization) are never persisted.
 */
export function toPreserved(entry: RequestEntry, bodyCap: number): RequestEntry {
  const preserved: RequestEntry = {
    ...withoutCredentials(entry),
    id: entry.id.startsWith('r:') ? entry.id : `r:${entry.id}`,
    restored: true,
    requestBody: capBody(entry.requestBody, bodyCap),
  };
  if (entry.responseBody !== undefined) preserved.responseBody = capBody(entry.responseBody, bodyCap);
  if (typeof entry.initiatorStack === 'string') preserved.initiatorStack = capStackText(entry.initiatorStack, PRESERVED_STACK_CAP);
  else delete preserved.initiatorStack;
  return preserved;
}

const STATIC_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['stylesheet', 'script', 'image', 'font', 'media', 'other']);

/**
 * Pick ids to evict to get back under `max`: oldest first, evicting static resources
 * (stylesheet/script/image/font/media/other) before fetch/xhr/beacon/document entries.
 * Age is `startTime` (input order breaks ties).
 *
 * The user's work is never evicted: manual entries ("+ New", "Duplicate as new request") and the ids in
 * `protectedIds` (the selected entry, entries with an edited draft or test runs). When only protected
 * entries are left the list stays above `max`.
 */
export function pickEvictions(entries: RequestEntry[], max: number, protectedIds?: ReadonlySet<string>): string[] {
  const excess = entries.length - normalizeCap(max);
  if (excess <= 0) return [];
  const tier = (entry: RequestEntry): number => (STATIC_KINDS.has(entry.kind) ? 0 : 1);
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind !== 'manual' && !protectedIds?.has(entry.id))
    .sort((a, b) => tier(a.entry) - tier(b.entry) || a.entry.startTime - b.entry.startTime || a.index - b.index)
    .slice(0, excess)
    .map(({ entry }) => entry.id);
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted MAIN-world payloads
// ---------------------------------------------------------------------------------------------

const MAX_HOOK_ID_LENGTH = 200;
const MAX_METHOD_LENGTH = 32;
const MAX_URL_LENGTH = 64 * 1024;
const MAX_HEADERS = 500;
const MAX_HEADER_TEXT = 64 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_OPTION_TEXT = 256;
const MAX_FORM_ENTRIES = 10_000;
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOOK_KINDS: ReadonlySet<unknown> = new Set(['fetch', 'xhr', 'beacon']);
const END_STATES: ReadonlySet<unknown> = new Set(['done', 'error', 'aborted']);
const OPTION_STRINGS = ['credentials', 'mode', 'cache', 'redirect', 'referrerPolicy'] as const;
const OPTION_FLAGS = ['keepalive', 'withCredentials'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isHeaderList(value: unknown): value is HeaderPair[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_HEADERS &&
    value.every((item) => isRecord(item) && isText(item.name, MAX_HEADER_TEXT) && isText(item.value, MAX_HEADER_TEXT))
  );
}

function isFormDataEntry(value: unknown): value is FormDataEntryInfo {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  if (value.type === 'text') return typeof value.value === 'string' && isOptionalBoolean(value.truncated);
  return (
    value.type === 'file' &&
    typeof value.fileName === 'string' &&
    typeof value.mime === 'string' &&
    isSize(value.size) &&
    (value.base64 === undefined || typeof value.base64 === 'string') &&
    isOptionalBoolean(value.truncated)
  );
}

/** Runtime shape check of a SerializedBody (every kind, field types, finite sizes, bounded lists). */
export function isValidSerializedBody(value: unknown): value is SerializedBody {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'text':
      return typeof value.text === 'string' && isSize(value.size) && isOptionalBoolean(value.truncated);
    case 'base64':
      return typeof value.base64 === 'string' && isSize(value.size) && isOptionalBoolean(value.truncated);
    case 'formData':
      return Array.isArray(value.entries) && value.entries.length <= MAX_FORM_ENTRIES && value.entries.every(isFormDataEntry);
    case 'formFields':
      return (
        Array.isArray(value.fields) &&
        value.fields.length <= MAX_FORM_ENTRIES &&
        value.fields.every((field) => isRecord(field) && typeof field.name === 'string' && typeof field.value === 'string')
      );
    case 'unavailable':
      return isText(value.reason, MAX_TEXT);
    default:
      return false;
  }
}

function isOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    OPTION_STRINGS.every((key) => value[key] === undefined || isText(value[key], MAX_OPTION_TEXT)) &&
    OPTION_FLAGS.every((key) => isOptionalBoolean(value[key]))
  );
}

function isHookId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HOOK_ID_LENGTH;
}

/**
 * Runtime shape check for messages coming from the (untrusted) MAIN world.
 * Strict: hookId 1..200 chars; kind fetch/xhr/beacon; method an HTTP token of at most 32 chars; url a
 * non-empty string of at most 64 KB; at most 500 headers of strings; a valid body or null; contentType a
 * string or null; finite startTime; frameUrl a string (or absent); options of the documented types.
 */
export function isValidHookStart(value: unknown): value is HookRequestStart {
  return (
    isRecord(value) &&
    isHookId(value.hookId) &&
    HOOK_KINDS.has(value.kind) &&
    typeof value.method === 'string' &&
    value.method.length <= MAX_METHOD_LENGTH &&
    METHOD_TOKEN.test(value.method) &&
    typeof value.url === 'string' &&
    value.url.length > 0 &&
    value.url.length <= MAX_URL_LENGTH &&
    isHeaderList(value.headers) &&
    (value.body === null || isValidSerializedBody(value.body)) &&
    (value.contentType === null || isText(value.contentType, MAX_TEXT)) &&
    isFiniteNumber(value.startTime) &&
    (value.frameUrl === undefined || isText(value.frameUrl, MAX_URL_LENGTH)) &&
    (value.initiatorStack === undefined || isText(value.initiatorStack, MAX_URL_LENGTH)) &&
    isOptions(value.options)
  );
}

/**
 * Strict shape check of a hook 'end' message: hookId, state done/error/aborted, finite endTime; optional
 * status (integer 0..999), statusText, headers (<= 500), body (valid or null), responseUrl (<= 64 KB),
 * redirected, responseType and error of the documented types.
 */
export function isValidHookEnd(value: unknown): value is HookRequestEnd {
  return (
    isRecord(value) &&
    isHookId(value.hookId) &&
    END_STATES.has(value.state) &&
    isFiniteNumber(value.endTime) &&
    (value.status === undefined ||
      (isFiniteNumber(value.status) && Number.isInteger(value.status) && value.status >= 0 && value.status <= 999)) &&
    (value.statusText === undefined || isText(value.statusText, MAX_TEXT)) &&
    (value.headers === undefined || isHeaderList(value.headers)) &&
    (value.body === undefined || value.body === null || isValidSerializedBody(value.body)) &&
    (value.responseUrl === undefined || isText(value.responseUrl, MAX_URL_LENGTH)) &&
    isOptionalBoolean(value.redirected) &&
    (value.responseType === undefined || isText(value.responseType, MAX_OPTION_TEXT)) &&
    (value.error === undefined || isText(value.error, MAX_TEXT))
  );
}

// ---------------------------------------------------------------------------------------------
// Body caps
// ---------------------------------------------------------------------------------------------

function capFormData(body: Extract<SerializedBody, { kind: 'formData' }>, cap: number): SerializedBody {
  let budget = cap;
  let changed = false;
  const entries = body.entries.map((entry): FormDataEntryInfo => {
    if (entry.type === 'text') {
      const length = utf8ByteLength(entry.value);
      if (length <= budget) {
        budget -= length;
        return entry;
      }
      changed = true;
      const value = truncateUtf8(entry.value, budget);
      budget = 0;
      return { ...entry, value, truncated: true };
    }
    if (entry.base64 === undefined) return entry;
    const length = base64ByteLength(entry.base64);
    if (length <= budget) {
      budget -= length;
      return entry;
    }
    changed = true;
    return { name: entry.name, type: 'file', fileName: entry.fileName, mime: entry.mime, size: entry.size, truncated: true };
  });
  return changed ? { kind: 'formData', entries } : body;
}

function capFormFields(body: Extract<SerializedBody, { kind: 'formFields' }>, cap: number): SerializedBody {
  let budget = cap;
  let changed = false;
  const fields = body.fields.map((field) => {
    const length = utf8ByteLength(field.value);
    if (length <= budget) {
      budget -= length;
      return field;
    }
    changed = true;
    const value = truncateUtf8(field.value, budget);
    budget = 0;
    return { name: field.name, value };
  });
  return changed ? { kind: 'formFields', fields } : body;
}

/**
 * Bound a SerializedBody to `cap` bytes (text by UTF-8 length, base64 by decoded length).
 * Text is cut at a character boundary; `size` keeps the full length; `truncated` is set. formData /
 * formFields share one budget across their values (file contents over budget are dropped and marked
 * truncated). Returns the input object itself when it already fits.
 */
export function capBody(body: SerializedBody | null | undefined, cap: number): SerializedBody | null {
  if (!body) return null;
  const limit = normalizeCap(cap);
  switch (body.kind) {
    case 'text': {
      const length = utf8ByteLength(body.text);
      if (length <= limit) return body;
      const size = Math.max(length, isSize(body.size) ? body.size : 0);
      return { kind: 'text', text: truncateUtf8(body.text, limit), size, truncated: true };
    }
    case 'base64': {
      const length = base64ByteLength(body.base64);
      if (length <= limit) return body;
      const clean = body.base64.replace(/[\t\n\f\r ]+/g, '');
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(clean.slice(0, Math.ceil(limit / 3) * 4)).subarray(0, limit);
      } catch {
        return unavailable('Body was not valid base64');
      }
      const size = Math.max(length, isSize(body.size) ? body.size : 0);
      return { kind: 'base64', base64: bytesToBase64(bytes), size, truncated: true };
    }
    case 'formData':
      return capFormData(body, limit);
    case 'formFields':
      return capFormFields(body, limit);
    default:
      return body;
  }
}
