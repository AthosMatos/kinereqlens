// OWNER: lib-body agent. Captured body <-> editable BodyModel <-> wire body.
//
// Principle: never lose data. Whenever a captured body cannot be represented losslessly by a structured
// model (invalid JSON, non-UTF-8 bytes, unknown boundary, ...) it falls back to text or binary, which
// carry the exact captured content.
import type {
  BodyModel,
  BodyType,
  FormDataEntryInfo,
  JNode,
  KVRow,
  MultipartPart,
  SerializedBody,
  WireBody,
} from '../shared/types';
import { base64ToBytes, bytesToBase64, tryDecodeUtf8, utf8Decode, utf8Encode } from './encoding';
import { isJsonMime, isTextualMime, parseContentType } from './headers';
import { uid } from './ids';
import {
  JsonParseError,
  alignTreeIds,
  isTreeModified,
  parseJsonTree,
  serializeJsonTree,
  tryParseJsonTree,
} from './json-tree';
import { rowsModified } from './kv';
import {
  buildMultipart,
  filePartBytes,
  generateBoundary,
  hasMultipartBoundary,
  multipartPartHead,
  parseMultipart,
  textPartValue,
} from './multipart';
import { buildQueryString, parseQueryString } from './url';

type ModelOf<T extends BodyModel['type']> = Extract<BodyModel, { type: T }>;
type JsonModel = ModelOf<'json'>;
type MultipartModel = ModelOf<'multipart'>;
type BinaryModel = ModelOf<'binary'>;

/** Fresh objects (never shared) so no caller can observe another model's mutation. */
const none = (): BodyModel => ({ type: 'none' });
const noWireBody = (): WireBody => ({ kind: 'none' });

const JSON_CONTENT_TYPE = 'application/json';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const TEXT_CONTENT_TYPE = 'text/plain;charset=UTF-8';
const BINARY_CONTENT_TYPE = 'application/octet-stream';
/** Content-Type buildMultipart writes for a file part without a mime. */
const DEFAULT_FILE_MIME = 'application/octet-stream';
const FORM_MIME = 'application/x-www-form-urlencoded';
const GRAPHQL_MIME = 'application/graphql';

/** Strict UTF-8 decoder (no control-character heuristics): valid UTF-8 always round-trips through it. */
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function decodeBase64(base64: string): Uint8Array | null {
  try {
    return base64ToBytes(base64);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/** Skip GraphQL "ignored tokens" (whitespace, commas, BOM, # comments) starting at `from`. */
function skipIgnored(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
    } else if (ch === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else {
      break;
    }
  }
  return i;
}

const OPERATION_KEYWORD = /^(?:query|mutation|subscription|fragment)(?![_0-9A-Za-z])/;
const SELECTION_START = /^(?:[_A-Za-z]|\.\.\.)/;

/**
 * Heuristic GraphQL document check (query/mutation/subscription/fragment/{ after comments/whitespace).
 * A keyword must be followed somewhere by a selection set ('{'); a leading '{' must open a selection
 * (a field name or '...'), which rules out JSON objects such as `{"match": ...}`.
 */
export function looksLikeGraphql(text: string): boolean {
  if (typeof text !== 'string') return false;
  const start = skipIgnored(text, 0);
  if (text[start] === '{') {
    const inner = skipIgnored(text, start + 1);
    return SELECTION_START.test(text.slice(inner, inner + 3));
  }
  const rest = text.slice(start, start + 16);
  const keyword = OPERATION_KEYWORD.exec(rest);
  return keyword !== null && text.indexOf('{', start + keyword[0].length) >= 0;
}

/** Exposed for tests and the GraphQL editor: find the top-level child node by key. */
export function childByKey(tree: JNode, key: string): JNode | undefined {
  if (tree.type !== 'object' || !tree.children) return undefined;
  return tree.children.find((child) => child.key === key);
}

/** A GraphQL request object: a GraphQL "query" string, or an automatic persisted query (no query text). */
function isGraphqlOperation(node: JNode): boolean {
  if (node.type !== 'object') return false;
  const query = childByKey(node, 'query');
  if (query) return query.type === 'string' && typeof query.value === 'string' && looksLikeGraphql(query.value);
  const extensions = childByKey(node, 'extensions');
  return extensions !== undefined && childByKey(extensions, 'persistedQuery')?.type === 'object';
}

/** GraphQL flavor of a JSON tree: a single operation object, a non-empty array of them, or none. */
export function jsonFlavor(tree: JNode): JsonModel['flavor'] {
  if (tree.type === 'object') return isGraphqlOperation(tree) ? 'graphql' : undefined;
  if (tree.type === 'array' && tree.children && tree.children.length > 0) {
    return tree.children.every(isGraphqlOperation) ? 'graphql-batch' : undefined;
  }
  return undefined;
}

function jsonModel(tree: JNode): JsonModel {
  const flavor = jsonFlavor(tree);
  return flavor ? { type: 'json', tree, flavor } : { type: 'json', tree };
}

const LOOKS_LIKE_JSON_CONTAINER = /^[﻿\s]*[[{]/;

/** Model for captured text with the given (effective) Content-Type. */
function detectText(text: string, contentType: string | null): BodyModel {
  const { mime, params } = parseContentType(contentType);
  if (mime === GRAPHQL_MIME) return { type: 'text', text };
  if (isJsonMime(mime)) {
    const tree = tryParseJsonTree(text);
    return tree ? jsonModel(tree) : { type: 'text', text };
  }
  if (mime === FORM_MIME) return { type: 'form', rows: parseQueryString(text) };
  if (mime.startsWith('multipart/') && params.boundary) {
    const bytes = utf8Encode(text);
    const parts = parseMultipart(bytes, params.boundary);
    if (parts.length > 0 || hasMultipartBoundary(bytes, params.boundary)) {
      return { type: 'multipart', boundary: params.boundary, parts };
    }
    return { type: 'text', text };
  }
  if ((mime === '' || mime === 'text/plain') && LOOKS_LIKE_JSON_CONTAINER.test(text)) {
    const tree = tryParseJsonTree(text);
    if (tree && (tree.type === 'object' || tree.type === 'array')) return jsonModel(tree);
  }
  return { type: 'text', text };
}

/** An empty captured body: nothing was sent, unless the capture cap cut everything off. */
function emptyBody(truncated: boolean | undefined): BodyModel {
  return truncated ? { type: 'unavailable', reason: 'Body was not captured (capture size limit)' } : none();
}

function binaryModel(base64: string, size: number, contentType: string | null): BinaryModel {
  const mime = contentType?.trim();
  return mime ? { type: 'binary', base64, size, mime } : { type: 'binary', base64, size };
}

/** Model for captured bytes (base64). */
function detectBytes(body: Extract<SerializedBody, { kind: 'base64' }>, contentType: string | null): BodyModel {
  const bytes = decodeBase64(body.base64);
  if (!bytes) return binaryModel(body.base64, body.size, contentType); // keep undecodable data verbatim
  if (bytes.length === 0) return emptyBody(body.truncated);
  const { mime, params } = parseContentType(contentType);
  if (mime.startsWith('multipart/') && params.boundary) {
    const parts = parseMultipart(bytes, params.boundary);
    if (parts.length > 0 || hasMultipartBoundary(bytes, params.boundary)) {
      return { type: 'multipart', boundary: params.boundary, parts };
    }
  }
  // Without a mime only text that also passes the "looks like text" heuristic counts; a textual mime
  // accepts any valid UTF-8 (control characters included), which still round-trips byte for byte.
  const text = mime === '' ? tryDecodeUtf8(bytes) : isTextualMime(mime) ? strictUtf8(bytes) : null;
  return text !== null ? detectText(text, contentType) : binaryModel(body.base64, bytes.length, contentType);
}

function textPart(name: string, value: string, enabled = true): MultipartPart {
  return { id: uid('mp'), enabled, name, kind: 'text', value };
}

function formEntryToPart(entry: FormDataEntryInfo): MultipartPart {
  if (entry.type === 'text') return textPart(entry.name, entry.value);
  const part: MultipartPart = {
    id: uid('mp'),
    enabled: true,
    name: entry.name,
    kind: 'file',
    value: '',
    fileName: entry.fileName,
    mime: entry.mime,
    size: entry.size,
  };
  if (entry.base64 !== undefined) part.base64 = entry.base64;
  if (entry.base64 === undefined || entry.truncated) part.missingContent = true;
  return part;
}

const FORM_SAFE_BYTE = /[*\-._0-9A-Za-z]/;

/** application/x-www-form-urlencoded byte serializer (WHATWG URL §5.2): what browsers send for forms. */
function formUrlEncode(text: string): string {
  let out = '';
  for (const byte of utf8Encode(text)) {
    if (byte === 0x20) out += '+';
    else if (byte < 0x80 && FORM_SAFE_BYTE.test(String.fromCharCode(byte))) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Rows for fields pre-parsed by chrome.webRequest. `raw` is the browser's own form encoding, so
 * re-serializing unchanged rows reproduces the bytes a browser form submission sends.
 */
function formFieldRows(fields: Array<{ name: string; value: string }>): KVRow[] {
  return fields.map((field) => ({
    id: uid('q'),
    enabled: true,
    key: field.name,
    value: field.value,
    raw: { key: formUrlEncode(field.name), value: formUrlEncode(field.value), hasEquals: true },
  }));
}

function detectFormFields(fields: Array<{ name: string; value: string }>, contentType: string | null): BodyModel {
  const { mime, params } = parseContentType(contentType);
  if (mime.startsWith('multipart/')) {
    return {
      type: 'multipart',
      boundary: params.boundary || generateBoundary(),
      parts: fields.map((field) => textPart(field.name, field.value)),
    };
  }
  return { type: 'form', rows: formFieldRows(fields) };
}

/**
 * Turn a captured body into an editable model, using the effective Content-Type:
 *  - null / empty text                                   -> none
 *  - unavailable                                         -> unavailable
 *  - text/base64 whose mime is JSON, or any text that parses as a JSON object/array when the mime is
 *    absent/text/plain                                   -> json (flavor 'graphql' when the object has a string
 *                                                           "query" that looks like GraphQL; 'graphql-batch' for an
 *                                                           array of such objects; mime application/graphql -> text)
 *  - x-www-form-urlencoded text                          -> form (rows with raw preserved)
 *  - formData (hook FormData)                            -> multipart (fresh boundary)
 *  - multipart/* base64/text with boundary param         -> multipart (parsed, original boundary kept)
 *  - formFields + urlencoded mime                        -> form; formFields + multipart mime -> multipart (text parts;
 *                                                           boundary from content type or fresh)
 *  - other textual text                                  -> text
 *  - base64 that decodes as UTF-8 with a textual/absent mime -> text, else binary
 *  - JSON-looking text that fails to parse               -> text (never lose data)
 *
 * Also: automatic persisted queries (no "query", `extensions.persistedQuery`) get the 'graphql' flavor;
 * an empty body cut off by the capture cap is 'unavailable'; binary `mime` is the full Content-Type.
 */
export function detectBody(body: SerializedBody | null, contentType: string | null): BodyModel {
  if (!body) return none();
  switch (body.kind) {
    case 'unavailable':
      return { type: 'unavailable', reason: body.reason };
    case 'formData':
      return { type: 'multipart', boundary: generateBoundary(), parts: body.entries.map(formEntryToPart), formData: true };
    case 'formFields':
      return detectFormFields(body.fields, contentType);
    case 'text':
      return body.text === '' ? emptyBody(body.truncated) : detectText(body.text, contentType);
    case 'base64':
      return body.base64 === '' ? emptyBody(body.truncated) : detectBytes(body, contentType);
    default:
      return { type: 'unavailable', reason: 'Unsupported body format' };
  }
}

// ---------------------------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------------------------

/** Default Content-Type for a body type: json -> application/json, form -> application/x-www-form-urlencoded, multipart -> multipart/form-data; boundary=..., text -> text/plain;charset=UTF-8, binary -> application/octet-stream, none -> null. */
export function defaultContentType(model: BodyModel): string | null {
  switch (model.type) {
    case 'json':
      return JSON_CONTENT_TYPE;
    case 'form':
      return FORM_CONTENT_TYPE;
    case 'multipart':
      return `multipart/form-data; boundary=${model.boundary}`;
    case 'text':
      return TEXT_CONTENT_TYPE;
    case 'binary':
      // The captured/picked type of the bytes when known.
      return model.mime || BINARY_CONTENT_TYPE;
    default:
      return null;
  }
}

/**
 * Wire representation of a model:
 *   none/unavailable -> none; json -> compact serializeJsonTree text; form -> buildQueryString(rows);
 *   multipart -> base64 of buildMultipart(parts, boundary); text -> text; binary -> base64.
 * `contentType` is the value the request should carry for this model when the user has not set one
 * (multipart includes `; boundary=...`), or null for none.
 */
export function bodyToWire(model: BodyModel): { body: WireBody; contentType: string | null } {
  const contentType = defaultContentType(model);
  switch (model.type) {
    case 'json':
      return { body: { kind: 'text', text: serializeJsonTree(model.tree) }, contentType };
    case 'form':
      return { body: { kind: 'text', text: buildQueryString(model.rows) }, contentType };
    case 'multipart':
      return {
        body: { kind: 'base64', base64: bytesToBase64(buildMultipart(model.parts, model.boundary, model.formData === true)) },
        contentType,
      };
    case 'text':
      return { body: { kind: 'text', text: model.text }, contentType };
    case 'binary':
      return { body: { kind: 'base64', base64: model.base64 }, contentType };
    default:
      return { body: noWireBody(), contentType: null };
  }
}

/** Convert a captured body into a verbatim wire body (formData/formFields are encoded via the matching model). */
export function serializedToWire(body: SerializedBody | null, contentType: string | null): WireBody {
  if (!body) return noWireBody();
  switch (body.kind) {
    case 'text':
      return { kind: 'text', text: body.text };
    case 'base64':
      return { kind: 'base64', base64: body.base64 };
    case 'formData':
    case 'formFields':
      return bodyToWire(detectBody(body, contentType)).body;
    default:
      return noWireBody();
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

function sameExtraHeaders(a: MultipartPart['extraHeaders'], b: MultipartPart['extraHeaders']): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((header, i) => header.name === y[i].name && header.value === y[i].value);
}

/** Field-by-field equality of two parts, ids ignored (absent optional fields equal their empty value). */
export function samePartContent(a: MultipartPart, b: MultipartPart): boolean {
  return (
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.value === b.value &&
    (a.fileName ?? '') === (b.fileName ?? '') &&
    (a.mime ?? '') === (b.mime ?? '') &&
    (a.base64 ?? '') === (b.base64 ?? '') &&
    (a.size ?? 0) === (b.size ?? 0) &&
    !!a.missingContent === !!b.missingContent &&
    sameExtraHeaders(a.extraHeaders, b.extraHeaders)
  );
}

function partsModified(original: MultipartPart[], current: MultipartPart[]): boolean {
  if (original.length !== current.length) return true;
  for (let i = 0; i < current.length; i++) {
    if (original[i] === current[i]) continue;
    if (original[i].id !== current[i].id || !samePartContent(original[i], current[i])) return true;
  }
  return false;
}

/**
 * Deep-compare two models (json via isTreeModified by id, rows via rowsModified, parts by id/fields).
 * Content is compared, so typing a value back to its original is not a modification. The GraphQL
 * `flavor` is presentation only and ignored; a multipart boundary change counts (the bytes differ).
 */
export function bodyModified(original: BodyModel, current: BodyModel): boolean {
  if (original === current) return false;
  if (original.type !== current.type) return true;
  switch (current.type) {
    case 'none':
      return false;
    case 'unavailable':
      return (original as ModelOf<'unavailable'>).reason !== current.reason;
    case 'json':
      return isTreeModified((original as JsonModel).tree, current.tree);
    case 'form':
      return rowsModified((original as ModelOf<'form'>).rows, current.rows);
    case 'multipart': {
      const before = original as MultipartModel;
      return before.boundary !== current.boundary || partsModified(before.parts, current.parts);
    }
    case 'text':
      return (original as ModelOf<'text'>).text !== current.text;
    case 'binary': {
      const before = original as BinaryModel;
      return before.base64 !== current.base64 || (before.mime ?? '') !== (current.mime ?? '');
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Conversion between body types
// ---------------------------------------------------------------------------------------------

function newJsonNode(type: JNode['type'], key?: string): JNode {
  const node: JNode = { id: uid('j'), type };
  if (key !== undefined) node.key = key;
  return node;
}

/** Object node whose children are string fields. */
function stringObject(fields: Array<{ key: string; value: string }>): JNode {
  const root = newJsonNode('object');
  root.children = fields.map(({ key, value }) => {
    const child = newJsonNode('string', key);
    child.value = value;
    return child;
  });
  return root;
}

/** Form-like text of a JSON value: strings as-is, other scalars as literals, containers as compact JSON. */
function jsonFieldText(node: JNode): string {
  switch (node.type) {
    case 'string':
      return typeof node.value === 'string' ? node.value : String(node.value ?? '');
    case 'null':
      return '';
    default:
      return serializeJsonTree(node);
  }
}

/** Key/value fields of a structured model (disabled rows/parts keep their flag; files are dropped). */
function fieldsOf(model: BodyModel): Array<{ key: string; value: string; enabled: boolean }> {
  switch (model.type) {
    case 'form':
      return model.rows.map((row) => ({ key: row.key, value: row.value, enabled: row.enabled }));
    case 'multipart':
      return model.parts
        .filter((part) => part.kind === 'text')
        .map((part) => ({ key: part.name, value: part.value, enabled: part.enabled }));
    case 'json': {
      const children = model.tree.children ?? [];
      if (model.tree.type === 'object') {
        return children.map((child) => ({ key: child.key ?? '', value: jsonFieldText(child), enabled: true }));
      }
      if (model.tree.type === 'array') {
        return children.map((child, i) => ({ key: String(i), value: jsonFieldText(child), enabled: true }));
      }
      return [];
    }
    default:
      return [];
  }
}

function trimLineBreaks(text: string): string {
  return text.replace(/^[\r\n]+|[\r\n]+$/g, '');
}

function decodeBinaryLeniently(model: BinaryModel): string {
  const bytes = decodeBase64(model.base64);
  return bytes ? utf8Decode(bytes) : '';
}

function toJson(model: BodyModel): BodyModel {
  if (model.type === 'form' || model.type === 'multipart') {
    return { type: 'json', tree: stringObject(fieldsOf(model).filter((field) => field.enabled)) };
  }
  const text = model.type === 'text' ? model.text : model.type === 'binary' ? decodeBinaryLeniently(model) : '';
  const tree = tryParseJsonTree(text);
  return tree ? jsonModel(tree) : { type: 'json', tree: stringObject([]) };
}

function toForm(model: BodyModel): BodyModel {
  if (model.type === 'text' || model.type === 'binary') {
    const text = model.type === 'text' ? model.text : decodeBinaryLeniently(model);
    return { type: 'form', rows: parseQueryString(trimLineBreaks(text)) };
  }
  const rows: KVRow[] = fieldsOf(model).map((field) => ({ id: uid('q'), enabled: field.enabled, key: field.key, value: field.value }));
  return { type: 'form', rows };
}

function toMultipart(model: BodyModel): BodyModel {
  const boundary = generateBoundary();
  if (model.type === 'binary') {
    const part: MultipartPart = {
      id: uid('mp'),
      enabled: true,
      name: 'file',
      kind: 'file',
      value: '',
      fileName: 'file',
      mime: parseContentType(model.mime).mime || BINARY_CONTENT_TYPE,
      base64: model.base64,
      size: model.size,
    };
    return { type: 'multipart', boundary, parts: [part] };
  }
  if (model.type === 'text') {
    return { type: 'multipart', boundary, parts: model.text === '' ? [] : [textPart('text', model.text)] };
  }
  return { type: 'multipart', boundary, parts: fieldsOf(model).map((f) => textPart(f.key, f.value, f.enabled)) };
}

function toBinary(model: BodyModel): BodyModel {
  let bytes: Uint8Array;
  if (model.type === 'multipart') bytes = buildMultipart(model.parts, model.boundary, model.formData === true);
  else if (model.type === 'json' || model.type === 'form' || model.type === 'text') {
    const wire = bodyToWire(model).body;
    bytes = utf8Encode(wire.kind === 'text' ? wire.text : '');
  } else bytes = new Uint8Array(0);
  const mime = defaultContentType(model);
  const binary: BinaryModel = { type: 'binary', base64: bytesToBase64(bytes), size: bytes.length };
  if (mime) binary.mime = mime;
  return binary;
}

/**
 * Switch body type, carrying data over where possible (json<->text via serialize/parse, form<->text via
 * query string, form->multipart text parts, multipart->form drops files, anything->none). Never throws:
 * text that is not valid JSON converts to json as an empty object.
 *
 * Also: form/multipart -> json gives an object of string fields; json -> form/multipart takes the
 * top-level fields; binary -> multipart becomes one file part; json -> text is pretty-printed (2 spaces).
 * Converting to 'unavailable' is not possible and returns the model unchanged.
 */
export function convertBody(model: BodyModel, to: BodyType): BodyModel {
  if (model.type === to) return model;
  try {
    switch (to) {
      case 'none':
        return none();
      case 'json':
        return toJson(model);
      case 'form':
        return toForm(model);
      case 'multipart':
        return toMultipart(model);
      case 'text':
        return { type: 'text', text: model.type === 'binary' ? decodeBinaryLeniently(model) : bodyToRawText(model) };
      case 'binary':
        return toBinary(model);
      default:
        return model;
    }
  } catch {
    // Defensive: conversions only use non-throwing helpers, but a malformed model must not crash the UI.
    return to === 'json' ? { type: 'json', tree: stringObject([]) } : model;
  }
}

/** Short label for the UI badge: "JSON", "GraphQL", "Form", "Multipart", "Text", "Binary", "None", "Unavailable". */
export function bodyTypeLabel(model: BodyModel): string {
  switch (model.type) {
    case 'json':
      return model.flavor ? 'GraphQL' : 'JSON';
    case 'form':
      return 'Form';
    case 'multipart':
      return 'Multipart';
    case 'text':
      return 'Text';
    case 'binary':
      return 'Binary';
    case 'unavailable':
      return 'Unavailable';
    default:
      return 'None';
  }
}

// ---------------------------------------------------------------------------------------------
// Raw view
// ---------------------------------------------------------------------------------------------

/** Placeholder shown instead of file content that is not readable text. */
function fileContentPlaceholder(part: MultipartPart): string {
  if (part.missingContent || !part.base64) {
    return part.missingContent ? `<file content not captured: ${part.size ?? 0} bytes>` : '';
  }
  const bytes = decodeBase64(part.base64);
  if (!bytes) return `<invalid file content>`;
  return tryDecodeUtf8(bytes) ?? `<binary file content: ${bytes.length} bytes>`;
}

/** Readable text of a multipart body: the encoded form, with unreadable file contents as placeholders. */
function multipartToText(model: MultipartModel): string {
  let out = '';
  const formData = model.formData === true;
  for (const part of model.parts) {
    if (!part.enabled) continue;
    out += multipartPartHead(part, model.boundary, formData);
    out += part.kind === 'file' ? fileContentPlaceholder(part) : textPartValue(part, formData);
    out += '\r\n';
  }
  return `${out}--${model.boundary}--\r\n`;
}

/**
 * Pretty text for showing a model in raw mode (json with 2-space indent, form as query string, multipart as decoded text).
 * Binary shows its UTF-8 text when it is valid text, else a size placeholder; none/unavailable show ''.
 */
export function bodyToRawText(model: BodyModel): string {
  switch (model.type) {
    case 'json':
      return serializeJsonTree(model.tree, 2);
    case 'form':
      return buildQueryString(model.rows);
    case 'multipart':
      return multipartToText(model);
    case 'text':
      return model.text;
    case 'binary': {
      const bytes = decodeBase64(model.base64);
      return (bytes && tryDecodeUtf8(bytes)) ?? `<binary body: ${bytes?.length ?? model.size} bytes>`;
    }
    default:
      return '';
  }
}

/** Give parsed rows the ids of reference rows with the same key and occurrence index. */
function alignRows(rows: KVRow[], reference: KVRow[]): KVRow[] {
  const byKey = groupBy(reference, (row) => row.key);
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const n = occurrences.get(row.key) ?? 0;
    occurrences.set(row.key, n + 1);
    const match = byKey.get(row.key)?.[n];
    return match ? { ...row, id: match.id } : row;
  });
}

/** Give parsed parts the ids of reference parts with the same name and occurrence index. */
function alignParts(parts: MultipartPart[], reference: MultipartPart[]): MultipartPart[] {
  const byName = groupBy(reference, (part) => part.name);
  const occurrences = new Map<string, number>();
  return parts.map((part) => {
    const n = occurrences.get(part.name) ?? 0;
    occurrences.set(part.name, n + 1);
    const match = byName.get(part.name)?.[n];
    if (!match) return part;
    if (part.kind !== 'file' || match.kind !== 'file') return { ...part, id: match.id };
    return alignFilePart(part, match);
  });
}

/**
 * A re-parsed file part that still shows `match`'s placeholder text keeps the real content, and the
 * Content-Type that buildMultipart defaulted (no mime -> application/octet-stream) maps back to `match`.
 */
function alignFilePart(part: MultipartPart, match: MultipartPart): MultipartPart {
  const aligned: MultipartPart = { ...part, id: match.id };
  if ((part.mime ?? '') === (match.mime || DEFAULT_FILE_MIME)) {
    if (match.mime === undefined) delete aligned.mime;
    else aligned.mime = match.mime;
  }
  if (utf8Decode(filePartBytes(part)) !== fileContentPlaceholder(match)) return aligned;
  delete aligned.base64;
  delete aligned.missingContent;
  if (match.base64 !== undefined) aligned.base64 = match.base64;
  if (match.size !== undefined) aligned.size = match.size;
  if (match.missingContent) aligned.missingContent = true;
  return aligned;
}

/**
 * Re-insert the disabled items of `like` that a raw text cannot represent (it shows enabled ones only), with
 * their ids, each after the item that preceded it in `like` (or at its old index).
 */
function keepDisabled<T extends { id: string; enabled: boolean }>(parsed: T[], like: T[]): T[] {
  if (!like.some((item) => !item.enabled)) return parsed;
  const out = parsed.slice();
  const present = new Set(out.map((item) => item.id));
  like.forEach((item, index) => {
    if (item.enabled || present.has(item.id)) return;
    let at = -1;
    for (let i = index - 1; i >= 0 && at < 0; i--) {
      const prev = like[i]!.id;
      at = out.findIndex((o) => o.id === prev);
      if (at >= 0) at += 1;
    }
    if (at < 0) at = Math.min(index, out.length);
    out.splice(at, 0, item);
    present.add(item.id);
  });
  return out;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function jsonErrorMessage(error: unknown): string {
  if (error instanceof JsonParseError) {
    return /line \d+/.test(error.message) ? error.message : `${error.message} (line ${error.line}, column ${error.column})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse raw text typed by the user back into a model of the same type as `like`
 * (json: parse + alignTreeIds with like.tree; form: parseQueryString; text: as-is).
 * Returns { error } for invalid JSON (message includes line:column).
 *
 * Also: form rows re-use the ids of `like` rows by key + occurrence (leading/trailing line breaks are
 * ignored); multipart re-parses with like's boundary (text unchanged from bodyToRawText returns `like`);
 * binary keeps `like` when the text is unchanged, else becomes the UTF-8 bytes of the text; none /
 * unavailable become text when non-empty.
 */
export function rawTextToBody(text: string, like: BodyModel): { model: BodyModel } | { error: string } {
  switch (like.type) {
    case 'json': {
      let tree: JNode;
      try {
        tree = parseJsonTree(text);
      } catch (error) {
        return { error: jsonErrorMessage(error) };
      }
      return { model: jsonModel(alignTreeIds(tree, like.tree)) };
    }
    case 'form': {
      // The raw text only shows enabled rows: disabled ones the text cannot represent are kept.
      const rows = alignRows(parseQueryString(trimLineBreaks(text)), like.rows.filter((row) => row.enabled));
      return { model: { type: 'form', rows: keepDisabled(rows, like.rows) } };
    }
    case 'text':
      return { model: text === like.text ? like : { type: 'text', text } };
    case 'multipart': {
      if (text === bodyToRawText(like)) return { model: like };
      const bytes = utf8Encode(text);
      const parts = parseMultipart(bytes, like.boundary);
      if (parts.length === 0 && !hasMultipartBoundary(bytes, like.boundary)) {
        return { error: `No multipart parts found (expected boundary "${like.boundary}")` };
      }
      const model: MultipartModel = {
        type: 'multipart',
        boundary: like.boundary,
        parts: keepDisabled(alignParts(parts, like.parts.filter((part) => part.enabled)), like.parts),
      };
      if (like.formData) model.formData = true;
      return { model };
    }
    case 'binary': {
      if (text === bodyToRawText(like)) return { model: like };
      const bytes = utf8Encode(text);
      const model: BinaryModel = { type: 'binary', base64: bytesToBase64(bytes), size: bytes.length };
      if (like.mime) model.mime = like.mime;
      return { model };
    }
    default:
      return { model: text === '' ? like : { type: 'text', text } };
  }
}
