// OWNER: lib-body agent. Editable draft of a request: creation, diff, revert, and building the replay request.
//
// Verbatim principle: an unmodified URL (base + hash + query) or body is sent with the exact bytes that
// were captured (`originalWire`); only modified sections are re-serialized from the editable model.
// "Modified" compares content (rows/nodes/parts are identified by id), so a value edited and typed back
// to its original is not modified.
import type {
  BodyModel,
  BodyType,
  Draft,
  DraftSection,
  DraftSnapshot,
  HeaderPair,
  KVRow,
  MultipartPart,
  ReplayMode,
  ReplayRequest,
  RequestEntry,
  SerializedBody,
  WireBody,
} from '../shared/types';
import { bodyModified, bodyToWire, convertBody, defaultContentType, detectBody, serializedToWire } from './body';
import {
  headersToRows,
  isForbiddenRequestHeader,
  isUnsafeToOverride,
  parseContentType,
  rowsToHeaders,
  setContentTypeParam,
} from './headers';
import { uid } from './ids';
import { removeNode, revertNode, treeErrors } from './json-tree';
import { cloneRows, removeRow, revertRow, rowsModified, updateRow } from './kv';
import { buildQueryString, joinUrl, parseQueryString, splitUrl } from './url';

const CONTENT_TYPE = 'Content-Type';
/** RFC 9110 token: method and header-name syntax. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** fetch() rejects these methods outright. */
const UNSENDABLE_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
/** Methods fetch refuses to send with a body. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
/** Header values must be ByteStrings without CR / LF / NUL. */
const INVALID_HEADER_VALUE = /[\0\r\n]|[^\u0000-ÿ]/;

function isContentTypeName(name: string): boolean {
  return name.trim().toLowerCase() === 'content-type';
}

function enabledContentTypeIndex(rows: KVRow[]): number {
  return rows.findIndex((row) => row.enabled && isContentTypeName(row.key));
}

/** Same "type/subtype" (parameters ignored); false when either side has none. */
function sameMime(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseContentType(a).mime;
  return left !== '' && left === parseContentType(b).mime;
}

function isJsonMime(mime: string): boolean {
  return mime === 'application/json' || mime.endsWith('+json') || mime === 'text/json';
}

/**
 * The Content-Type value describes a body of `model`'s type generically: its default type, or a type of the
 * same family (any JSON type, or text/plain — fetch's default for a JSON.stringify body — for JSON; any text
 * type for text). Such a header follows the body when its type is switched; anything else was chosen for a
 * reason and is left alone.
 */
function contentTypeFollows(value: string, model: BodyModel): boolean {
  if (sameMime(value, defaultContentType(model))) return true;
  const mime = parseContentType(value).mime;
  switch (model.type) {
    case 'json':
      return isJsonMime(mime) || mime === 'text/plain';
    case 'form':
      return mime === 'application/x-www-form-urlencoded';
    case 'multipart':
      return mime.startsWith('multipart/');
    case 'text':
      return mime.startsWith('text/');
    default:
      return false;
  }
}

/** A Content-Type that clearly cannot describe a body of this type (warned about after a type switch). */
function contentTypeMismatch(mime: string, model: BodyModel): boolean {
  if (mime === '') return false;
  switch (model.type) {
    case 'json':
      return !isJsonMime(mime) && !mime.startsWith('text/');
    case 'form':
      return mime !== 'application/x-www-form-urlencoded';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------------------------

function clonePart(part: MultipartPart): MultipartPart {
  const copy: MultipartPart = { ...part };
  if (part.extraHeaders) copy.extraHeaders = part.extraHeaders.map((header) => ({ ...header }));
  return copy;
}

/**
 * Copy of a body model that shares no mutable state with the input. JSON trees are the exception: they are
 * immutable values (every json-tree mutator returns a new root with structural sharing), so the original and
 * the current tree share node objects, which keeps diffs proportional to the edit instead of the document.
 */
function cloneBody(model: BodyModel): BodyModel {
  switch (model.type) {
    case 'form':
      return { type: 'form', rows: cloneRows(model.rows) };
    case 'multipart':
      return { ...model, parts: model.parts.map(clonePart) };
    default:
      return { ...model };
  }
}

function cloneSnapshot(snapshot: DraftSnapshot): DraftSnapshot {
  return {
    method: snapshot.method,
    base: snapshot.base,
    hash: snapshot.hash,
    query: cloneRows(snapshot.query),
    headers: cloneRows(snapshot.headers),
    body: cloneBody(snapshot.body),
  };
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

/** The enabled multipart Content-Type row carries `boundary` (rewritten in place when it differs). */
function withRowBoundary(rows: KVRow[], boundary: string): KVRow[] {
  const index = enabledContentTypeIndex(rows);
  if (index < 0) return rows;
  const { mime, params } = parseContentType(rows[index].value);
  if (!mime.startsWith('multipart/') || params.boundary === boundary) return rows;
  return updateRow(rows, rows[index].id, { value: setContentTypeParam(rows[index].value, 'boundary', boundary) });
}

function initialHeaders(entry: RequestEntry, body: BodyModel): KVRow[] {
  let rows = headersToRows(Array.isArray(entry.requestHeaders) ? entry.requestHeaders : []);
  if (entry.source === 'webRequest') {
    // Headers the browser added (Cookie, Origin, sec-*, ...) are shown but not re-sent by default.
    rows = rows.map((row) => (isForbiddenRequestHeader(row.key) ? { ...row, enabled: false, locked: true } : row));
  }
  const implicitType = entry.requestContentType?.trim();
  if (implicitType && !rows.some((row) => isContentTypeName(row.key))) {
    rows = [...rows, { id: uid('h'), enabled: true, key: CONTENT_TYPE, value: implicitType }];
  }
  // A FormData body gets a boundary generated here: the header must announce that same boundary.
  return body.type === 'multipart' ? withRowBoundary(rows, body.boundary) : rows;
}

function capturedWireBody(body: SerializedBody | null, contentType: string | null, model: BodyModel): WireBody {
  if (body && (body.kind === 'formData' || body.kind === 'formFields')) {
    // Encoded from the draft's own model, so the verbatim resend uses the boundary shown in Content-Type.
    return bodyToWire(model).body;
  }
  return serializedToWire(body, contentType);
}

/** A verbatim resend of this captured body would not reproduce the original bytes. */
function isBodyIncomplete(body: SerializedBody | null, contentType: string | null): boolean {
  if (!body) return false;
  switch (body.kind) {
    case 'text':
    case 'base64':
      return body.truncated === true;
    case 'formData':
      return body.entries.some((entry) =>
        entry.type === 'file' ? entry.base64 === undefined || entry.truncated === true : entry.truncated === true,
      );
    case 'formFields':
      // chrome.webRequest only reports field values of a multipart body: file contents are unknown.
      return parseContentType(contentType).mime.startsWith('multipart/');
    default:
      return true;
  }
}

/**
 * Create a draft from a captured entry.
 *  - query: parseQueryString of the URL's query; base/hash via splitUrl.
 *  - headers: headersToRows(entry.requestHeaders). For webRequest-sourced entries, forbidden (browser
 *    controlled) headers are included but `enabled: false` and `locked: true`.
 *    If no Content-Type row exists but entry.requestContentType is set (implicit content type from a
 *    string/URLSearchParams/FormData/Blob body), a Content-Type row is added so the replay sends the same
 *    type. For a FormData body the row carries the boundary of the generated multipart model.
 *  - body: detectBody(entry.requestBody, entry.requestContentType).
 *  - original: deep copy with the same ids; originalWire: url + serializedToWire(requestBody).
 *
 * For formData/formFields bodies originalWire.body is encoded from the detected model (same boundary as the
 * Content-Type row). JSON trees are shared with `original` (immutable values, see cloneBody).
 */
export function createDraft(entry: RequestEntry): Draft {
  const url = typeof entry.url === 'string' ? entry.url : '';
  const { base, query, hash } = splitUrl(url);
  const requestBody = entry.requestBody ?? null;
  const contentType = entry.requestContentType ?? null;
  const body = detectBody(requestBody, contentType);
  const snapshot: DraftSnapshot = {
    method: entry.method,
    base,
    hash,
    query: parseQueryString(query),
    headers: initialHeaders(entry, body),
    body,
  };
  return {
    ...snapshot,
    entryId: entry.id,
    original: cloneSnapshot(snapshot),
    originalWire: {
      url,
      body: capturedWireBody(requestBody, contentType, body),
      bodyIncomplete: isBodyIncomplete(requestBody, contentType),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Modified state
// ---------------------------------------------------------------------------------------------

/** Modified flags per section. */
export function draftSections(draft: Draft): Record<DraftSection, boolean> {
  const original = draft.original;
  return {
    method: draft.method !== original.method,
    url: draft.base !== original.base || draft.hash !== original.hash,
    query: rowsModified(original.query, draft.query),
    headers: rowsModified(original.headers, draft.headers),
    body: bodyModified(original.body, draft.body),
  };
}

export function isDraftModified(draft: Draft): boolean {
  const sections = draftSections(draft);
  return sections.method || sections.url || sections.query || sections.headers || sections.body;
}

// ---------------------------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------------------------

/** Returns `draft` itself when nothing is modified. */
export function revertDraft(draft: Draft): Draft {
  if (!isDraftModified(draft)) return draft;
  return { ...draft, ...cloneSnapshot(draft.original) };
}

/**
 * When the body type was changed and the Content-Type header still follows the body (missing, or the
 * default type of the current model), the Content-Type rows are reverted together with the body so header
 * and body stay coherent. A Content-Type the user set by hand is left alone.
 */
function headersAfterBodyRevert(draft: Draft): KVRow[] {
  const original = draft.original;
  if (original.body.type === draft.body.type) return draft.headers;
  const index = enabledContentTypeIndex(draft.headers);
  if (index >= 0 && !contentTypeFollows(draft.headers[index].value, draft.body)) return draft.headers;
  const ids = new Set<string>();
  for (const row of [...original.headers, ...draft.headers]) {
    if (isContentTypeName(row.key)) ids.add(row.id);
  }
  let rows = draft.headers;
  for (const id of ids) rows = revertRow(original.headers, rows, id);
  return rows;
}

/** Revert one section; returns `draft` itself when that section is not modified. */
export function revertSection(draft: Draft, section: DraftSection): Draft {
  const original = draft.original;
  switch (section) {
    case 'method':
      return draft.method === original.method ? draft : { ...draft, method: original.method };
    case 'url':
      return draft.base === original.base && draft.hash === original.hash
        ? draft
        : { ...draft, base: original.base, hash: original.hash };
    case 'query':
      return rowsModified(original.query, draft.query) ? { ...draft, query: cloneRows(original.query) } : draft;
    case 'headers':
      return rowsModified(original.headers, draft.headers) ? { ...draft, headers: cloneRows(original.headers) } : draft;
    case 'body':
      if (!bodyModified(original.body, draft.body)) return draft;
      return { ...draft, body: cloneBody(original.body), headers: headersAfterBodyRevert(draft) };
    default:
      return draft;
  }
}

/** Where a deleted original item goes back: after its nearest surviving predecessor (see kv.revertRow). */
function reinsertIndex<T extends { id: string }>(original: readonly T[], current: readonly T[], originalIndex: number): number {
  const position = new Map<string, number>();
  current.forEach((item, index) => position.set(item.id, index));
  for (let i = originalIndex - 1; i >= 0; i--) {
    const at = position.get(original[i].id);
    if (at !== undefined) return at + 1;
  }
  for (let i = originalIndex + 1; i < original.length; i++) {
    const at = position.get(original[i].id);
    if (at !== undefined) return at;
  }
  return Math.min(originalIndex, current.length);
}

/** kv.revertRow semantics for any list of items with ids (used for multipart parts). */
function revertItem<T extends { id: string }>(original: readonly T[], current: T[], id: string, clone: (item: T) => T): T[] {
  const originalIndex = original.findIndex((item) => item.id === id);
  const currentIndex = current.findIndex((item) => item.id === id);
  if (originalIndex < 0 && currentIndex < 0) return current;
  if (originalIndex < 0) return current.filter((item) => item.id !== id);
  const restored = clone(original[originalIndex]);
  const next = current.slice();
  if (currentIndex >= 0) next[currentIndex] = restored;
  else next.splice(reinsertIndex(original, current, originalIndex), 0, restored);
  return next;
}

/**
 * Revert one query/header/form row or multipart part by id (see kv.revertRow semantics).
 * Returns `draft` itself when the id is unknown or the body is not of the targeted type.
 */
export function revertRowIn(draft: Draft, where: 'query' | 'headers' | 'form' | 'multipart', id: string): Draft {
  const original = draft.original;
  switch (where) {
    case 'query': {
      const query = revertRow(original.query, draft.query, id);
      return query === draft.query ? draft : { ...draft, query };
    }
    case 'headers': {
      const headers = revertRow(original.headers, draft.headers, id);
      return headers === draft.headers ? draft : { ...draft, headers };
    }
    case 'form': {
      if (draft.body.type !== 'form') return draft;
      const originalRows = original.body.type === 'form' ? original.body.rows : [];
      const rows = revertRow(originalRows, draft.body.rows, id);
      return rows === draft.body.rows ? draft : { ...draft, body: { type: 'form', rows } };
    }
    case 'multipart': {
      if (draft.body.type !== 'multipart') return draft;
      const originalParts = original.body.type === 'multipart' ? original.body.parts : [];
      const parts = revertItem(originalParts, draft.body.parts, id, clonePart);
      return parts === draft.body.parts ? draft : { ...draft, body: { ...draft.body, parts } };
    }
    default:
      return draft;
  }
}

/**
 * Revert one JSON node by id (json bodies only). When the original body was not JSON every node is new,
 * so reverting one removes it.
 */
export function revertJsonNode(draft: Draft, nodeId: string): Draft {
  const body = draft.body;
  if (body.type !== 'json') return draft;
  const originalBody = draft.original.body;
  const tree =
    originalBody.type === 'json' ? revertNode(originalBody.tree, body.tree, nodeId) : removeNode(body.tree, nodeId);
  return tree === body.tree ? draft : { ...draft, body: { ...body, tree } };
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/**
 * Parsed rows take the id of the original row with the same key and occurrence index (the 2nd "a" gets the
 * id of the 2nd original "a"); occurrences beyond the original ones take the ids of rows the user added.
 */
function reuseRowIds(parsed: KVRow[], original: KVRow[], current: KVRow[]): KVRow[] {
  const originalIds = new Set(original.map((row) => row.id));
  const candidates = new Map<string, KVRow[]>();
  for (const row of [...original, ...current.filter((r) => !originalIds.has(r.id))]) {
    const list = candidates.get(row.key);
    if (list) list.push(row);
    else candidates.set(row.key, [row]);
  }
  const occurrences = new Map<string, number>();
  const taken = new Set<string>();
  return parsed.map((row) => {
    const n = occurrences.get(row.key) ?? 0;
    occurrences.set(row.key, n + 1);
    const match = candidates.get(row.key)?.[n];
    if (!match || taken.has(match.id)) return row;
    taken.add(match.id);
    return { ...row, id: match.id };
  });
}

/**
 * Apply a full URL typed by the user: splits it, replaces base/hash, and replaces query rows with the
 * parsed query (re-using ids of original rows whose key matches in order so unchanged params are not
 * shown as modified). Surrounding whitespace is ignored.
 */
export function applyFullUrl(draft: Draft, url: string): Draft {
  const { base, query, hash } = splitUrl(url.trim());
  return { ...draft, base, hash, query: reuseRowIds(parseQueryString(query), draft.original.query, draft.query) };
}

/**
 * Text typed into the URL field, which shows `base` + `#hash` (the query lives in the Params table):
 * base and hash follow the text. `startQuery` is the rows the draft had when "?" was first typed in this
 * edit (null while it has not been):
 *  - a query typed after "?" adds rows after `startQuery` instead of replacing the table, so appending
 *    "?extra=1" adds a param and typing "#top" never touches the params (rows added by earlier keystrokes of
 *    the same edit keep their ids);
 *  - `replace`: the edit started by replacing the whole field (select all + type / paste a new URL), so a
 *    query in the text replaces the params (re-using the ids of captured rows with the same key, like a
 *    pasted URL).
 * Without "?" in the text the params are `startQuery` (the "?" was deleted again). Whitespace is ignored.
 */
export function applyTypedUrl(draft: Draft, text: string, startQuery: KVRow[] | null, replace = false): Draft {
  const trimmed = text.trim();
  const { base, query, hash } = splitUrl(trimmed);
  if (startQuery === null) {
    return draft.base === base && draft.hash === hash ? draft : { ...draft, base, hash };
  }
  const hasQuery = /^[^#]*\?/.test(trimmed);
  if (!hasQuery) return { ...draft, base, hash, query: startQuery };
  if (replace) return { ...draft, base, hash, query: reuseRowIds(parseQueryString(query), draft.original.query, startQuery) };
  const typedBefore = draft.query.slice(startQuery.length);
  const typed = parseQueryString(query).map((row, i) => {
    const previous = typedBefore[i];
    return previous ? { ...row, id: previous.id } : row;
  });
  return { ...draft, base, hash, query: [...startQuery, ...typed] };
}

/** Content-Type rows after the body changed from `previous` to `next` (see setBodyType). */
function syncContentType(rows: KVRow[], previous: BodyModel, next: BodyModel): KVRow[] {
  const nextType = defaultContentType(next);
  const index = enabledContentTypeIndex(rows);
  if (index < 0) return nextType ? [...rows, { id: uid('h'), enabled: true, key: CONTENT_TYPE, value: nextType }] : rows;
  const row = rows[index];
  if (!contentTypeFollows(row.value, previous)) return rows; // chosen for this content: keep it
  if (!nextType) return removeRow(rows, row.id);
  return row.value === nextType ? rows : updateRow(rows, row.id, { value: nextType });
}

/**
 * Change body type via convertBody and keep the Content-Type header coherent: if the current Content-Type
 * row is missing or generic for the previous model (its default type, or the same family — any JSON type or
 * text/plain for JSON, any text type for text; see contentTypeFollows), set it to the new model's default
 * (removing it for 'none').
 */
export function setBodyType(draft: Draft, type: BodyType): Draft {
  if (draft.body.type === type) return draft;
  const body = convertBody(draft.body, type);
  if (body === draft.body) return draft;
  return { ...draft, body, headers: syncContentType(draft.headers, draft.body, body) };
}

/** Replace the body model (immutable helper used by editors). */
export function setBody(draft: Draft, body: BodyModel): Draft {
  return body === draft.body ? draft : { ...draft, body };
}

/**
 * The URL that would be sent (verbatim original when base/hash/query are unmodified). When only the base or
 * hash changed, the original query text is kept byte for byte; a modified query is rebuilt with
 * buildQueryString, which keeps the raw encoding of untouched rows.
 */
export function draftUrl(draft: Draft): string {
  const original = draft.original;
  const baseSame = draft.base === original.base && draft.hash === original.hash;
  const querySame = !rowsModified(original.query, draft.query);
  if (baseSame && querySame) return draft.originalWire.url;
  const query = querySame ? splitUrl(draft.originalWire.url).query : buildQueryString(draft.query);
  return joinUrl(draft.base, query, draft.hash);
}

// ---------------------------------------------------------------------------------------------
// Replay request
// ---------------------------------------------------------------------------------------------

export interface BuildOptions {
  runId: string;
  mode: ReplayMode;
  frameId: number;
  credentials: ReplayRequest['credentials'];
  redirect: ReplayRequest['redirect'];
  timeoutMs: number;
  responseBodyCap: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function incompleteBodyMessage(original: BodyModel): string {
  return original.type === 'unavailable'
    ? `The original body was not captured (${original.reason}) — the request is sent without it`
    : 'The original body was truncated or incomplete when captured — only the captured part is sent';
}

/** Verbatim original when the body section is unmodified, else the model's encoding. */
function replayBody(draft: Draft, warnings: string[]): WireBody {
  if (!bodyModified(draft.original.body, draft.body)) {
    if (draft.originalWire.bodyIncomplete) warnings.push(incompleteBodyMessage(draft.original.body));
    return { ...draft.originalWire.body };
  }
  try {
    return bodyToWire(draft.body).body;
  } catch (error) {
    warnings.push(`The body could not be encoded (${errorText(error)}) — the request is sent without a body`);
    return { kind: 'none' };
  }
}

/** Make the Content-Type header announce the multipart boundary (rewrite its parameter or add the header). */
function withHeaderBoundary(headers: HeaderPair[], boundary: string, warnings: string[]): HeaderPair[] {
  const index = headers.findIndex((header) => isContentTypeName(header.name));
  if (index < 0) return [...headers, { name: CONTENT_TYPE, value: `multipart/form-data; boundary=${boundary}` }];
  const header = headers[index];
  const { mime, params } = parseContentType(header.value);
  if (mime !== '' && !mime.startsWith('multipart/')) {
    warnings.push(`Content-Type is ${mime} but the body is multipart — the server may not be able to parse it`);
    return headers;
  }
  if (params.boundary === boundary) return headers;
  const value = mime === '' ? `multipart/form-data; boundary=${boundary}` : setContentTypeParam(header.value, 'boundary', boundary);
  const next = headers.slice();
  next[index] = { name: header.name, value };
  return next;
}

/**
 * Build the request to send.
 *  - url: draftUrl(draft) (fetch drops the hash anyway).
 *  - headers: rowsToHeaders(draft.headers).
 *  - body: verbatim originalWire.body when the body section is unmodified, else bodyToWire(draft.body).
 *  - multipart: ensure an enabled Content-Type header carries `boundary=<model boundary>` (rewrite or add).
 *  - GET/HEAD: body dropped (warning).
 * Never throws; problems are reported as warnings.
 *
 * The method is trimmed (an empty method sends GET, with a warning); its case is kept as typed.
 */
export function buildReplayRequest(draft: Draft, opts: BuildOptions): { request: ReplayRequest; warnings: string[] } {
  const warnings: string[] = [];
  let method = typeof draft.method === 'string' ? draft.method.trim() : '';
  if (method === '') {
    method = 'GET';
    warnings.push('The method is empty — sending GET');
  }
  let url: string;
  try {
    url = draftUrl(draft);
  } catch (error) {
    url = draft.originalWire.url;
    warnings.push(`The URL could not be built (${errorText(error)}) — sending the original URL`);
  }
  let headers = rowsToHeaders(draft.headers);
  let body = replayBody(draft, warnings);
  const upper = method.toUpperCase();
  if (body.kind !== 'none' && BODYLESS_METHODS.has(upper)) {
    body = { kind: 'none' };
    warnings.push(`${upper} requests cannot have a body — the body was not sent`);
  }
  if (body.kind !== 'none' && draft.body.type === 'multipart') {
    headers = withHeaderBoundary(headers, draft.body.boundary, warnings);
  }
  const request: ReplayRequest = {
    runId: opts.runId,
    entryId: draft.entryId,
    mode: opts.mode,
    frameId: opts.frameId,
    method,
    url,
    headers,
    body,
    credentials: opts.credentials,
    redirect: opts.redirect,
    timeoutMs: opts.timeoutMs,
    responseBodyCap: opts.responseBodyCap,
  };
  return { request, warnings };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export interface DraftWarning {
  level: 'error' | 'warn' | 'info';
  /** Section the warning belongs to (for inline display). */
  section: DraftSection | 'general';
  message: string;
  /** Row/node id the warning is about, when applicable. */
  targetId?: string;
}

function methodWarnings(method: string, out: DraftWarning[]): void {
  const trimmed = method.trim();
  if (trimmed === '') {
    out.push({ level: 'warn', section: 'method', message: 'The method is empty — GET will be sent' });
  } else if (!HTTP_TOKEN.test(trimmed)) {
    out.push({ level: 'error', section: 'method', message: `"${trimmed}" is not a valid HTTP method` });
  } else if (UNSENDABLE_METHODS.has(trimmed.toUpperCase())) {
    out.push({ level: 'error', section: 'method', message: `The ${trimmed.toUpperCase()} method cannot be sent by fetch` });
  }
}

function urlWarnings(url: string, out: DraftWarning[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    out.push({ level: 'error', section: 'url', message: 'Invalid URL — enter an absolute http(s) URL' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    out.push({ level: 'error', section: 'url', message: `Only http and https URLs can be sent (got ${parsed.protocol})` });
  } else if (parsed.username !== '' || parsed.password !== '') {
    out.push({
      level: 'error',
      section: 'url',
      message: 'URLs with embedded credentials cannot be sent by fetch — use an Authorization header instead',
    });
  }
}

function headerWarnings(rows: KVRow[], mode: ReplayMode, options: DraftWarningOptions, out: DraftWarning[]): void {
  for (const row of rows) {
    if (!row.enabled) continue;
    const name = row.key.trim();
    const warn = (message: string) => out.push({ level: 'warn', section: 'headers', message, targetId: row.id });
    if (name === '') {
      if (row.value !== '') warn('A header without a name is not sent');
      continue;
    }
    if (!HTTP_TOKEN.test(name)) {
      warn(`"${name}" is not a valid header name — it will not be sent`);
      continue;
    }
    if (INVALID_HEADER_VALUE.test(row.value)) {
      warn(`The value of ${name} contains characters that cannot be sent (line breaks or non-Latin-1 text)`);
    }
    if (mode === 'page' && options.app) {
      // App mode (React Native): the app's own networking stack sends every header, browser rules do not apply.
    } else if (mode === 'page' && isForbiddenRequestHeader(name)) {
      warn(`${name} is controlled by the browser; ignored in Page mode — use Extension mode`);
    } else if (mode === 'extension' && isUnsafeToOverride(name)) {
      warn(`${name} cannot be overridden — the browser always sets it`);
    }
  }
}

/** The request would carry a body (verbatim original or the edited model). */
function sendsBody(draft: Draft, modified: boolean): boolean {
  if (!modified) return draft.originalWire.body.kind !== 'none';
  return draft.body.type !== 'none' && draft.body.type !== 'unavailable';
}

function bodyWarnings(draft: Draft, out: DraftWarning[]): void {
  const body = draft.body;
  const modified = bodyModified(draft.original.body, body);
  const method = draft.method.trim().toUpperCase();
  if (BODYLESS_METHODS.has(method) && sendsBody(draft, modified)) {
    out.push({ level: 'warn', section: 'body', message: `${method} requests cannot have a body — it will not be sent` });
  }
  if (body.type === 'json') {
    for (const [id, message] of treeErrors(body.tree)) out.push({ level: 'error', section: 'body', message, targetId: id });
  }
  if (body.type === 'multipart') {
    for (const part of body.parts) {
      if (part.enabled && part.kind === 'file' && part.missingContent) {
        out.push({
          level: 'warn',
          section: 'body',
          message: `The content of file "${part.fileName ?? part.name}" was not captured — an empty file will be sent`,
          targetId: part.id,
        });
      }
    }
    const index = enabledContentTypeIndex(draft.headers);
    const mime = index >= 0 ? parseContentType(draft.headers[index].value).mime : '';
    if (mime !== '' && !mime.startsWith('multipart/')) {
      out.push({
        level: 'warn',
        section: 'headers',
        message: `Content-Type is ${mime} but the body is multipart`,
        targetId: draft.headers[index].id,
      });
    }
  }
  if (!modified && draft.originalWire.bodyIncomplete) {
    out.push({ level: 'warn', section: 'body', message: incompleteBodyMessage(draft.original.body) });
  }
  if (body.type !== draft.original.body.type && (body.type === 'json' || body.type === 'form')) {
    const index = enabledContentTypeIndex(draft.headers);
    const mime = index >= 0 ? parseContentType(draft.headers[index].value).mime : '';
    if (contentTypeMismatch(mime, body)) {
      out.push({
        level: 'warn',
        section: 'headers',
        message: `Content-Type is ${mime} but the body is ${body.type === 'json' ? 'JSON' : 'a urlencoded form'} — the server may not parse it`,
        targetId: draft.headers[index].id,
      });
    }
  }
}

/** Context of draftWarnings. */
export interface DraftWarningOptions {
  /**
   * The 'page' mode runs inside a React Native app (the standalone tab's App mode): no browser-controlled
   * headers, so no "ignored in Page mode" warnings.
   */
  app?: boolean;
}

/**
 * Validation for the editor before sending:
 *  - page mode (not App mode, see DraftWarningOptions): each enabled forbidden header -> warn "controlled by the browser; ignored in Page mode — use Extension mode".
 *  - extension mode: enabled isUnsafeToOverride headers -> warn "cannot be overridden".
 *  - invalid JSON number literals -> error (blocks send) with targetId = node id.
 *  - body on GET/HEAD -> warn (dropped).
 *  - multipart parts with missingContent -> warn.
 *  - unmodified body with originalWire.bodyIncomplete -> warn "original body was truncated/unavailable".
 *  - invalid URL -> error.
 *
 * Also: invalid/unsendable methods and non-http(s) URLs or URLs with credentials -> error; header names or
 * values fetch would reject -> warn; a multipart body with a non-multipart Content-Type -> warn.
 */
export function draftWarnings(draft: Draft, mode: ReplayMode, options: DraftWarningOptions = {}): DraftWarning[] {
  const out: DraftWarning[] = [];
  methodWarnings(draft.method, out);
  urlWarnings(draftUrl(draft), out);
  headerWarnings(draft.headers, mode, options, out);
  bodyWarnings(draft, out);
  return out;
}
