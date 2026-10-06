// OWNER: lib-core agent. Header utilities. All name comparisons are case-insensitive.
import type { HeaderPair, KVRow } from '../shared/types';
import { createRow } from './kv';
import { uid } from './ids';

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const UNSAFE_TO_OVERRIDE = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Fetch-spec forbidden request header names (browser-controlled; silently dropped by fetch in page/SW):
 * accept-charset, accept-encoding, access-control-request-headers, access-control-request-method,
 * access-control-request-private-network, connection, content-length, cookie, cookie2, date, dnt, expect,
 * host, keep-alive, origin, referer, set-cookie, te, trailer, transfer-encoding, upgrade, via,
 * plus any name starting with "proxy-" or "sec-".
 */
export function isForbiddenRequestHeader(name: string): boolean {
  const lower = normalizeName(name);
  return FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
}

/**
 * Headers that must never be overridden even via declarativeNetRequest in extension mode
 * (they would corrupt framing): content-length, host, connection, keep-alive, te, trailer,
 * transfer-encoding, upgrade, expect, and proxy-*.
 */
export function isUnsafeToOverride(name: string): boolean {
  const lower = normalizeName(name);
  return UNSAFE_TO_OVERRIDE.has(lower) || lower.startsWith('proxy-');
}

/** Rows from header pairs; `locked` is set for forbidden request headers. */
export function headersToRows(headers: HeaderPair[]): KVRow[] {
  return headers.map((header) => {
    const row: KVRow = { id: uid('h'), enabled: true, key: header.name, value: header.value };
    if (isForbiddenRequestHeader(header.name)) row.locked = true;
    return row;
  });
}

/** Enabled rows with a non-empty trimmed name, in order. Names are emitted trimmed; values are kept verbatim. */
export function rowsToHeaders(rows: KVRow[]): HeaderPair[] {
  const headers: HeaderPair[] = [];
  for (const row of rows) {
    const name = row.key.trim();
    if (row.enabled && name !== '') headers.push({ name, value: row.value });
  }
  return headers;
}

/** First value for `name`, or undefined. */
export function getHeader(headers: HeaderPair[], name: string): string | undefined {
  const wanted = normalizeName(name);
  return headers.find((header) => normalizeName(header.name) === wanted)?.value;
}

function findEnabledRowIndex(rows: KVRow[], name: string): number {
  const wanted = normalizeName(name);
  return rows.findIndex((row) => row.enabled && normalizeName(row.key) === wanted);
}

/** First enabled row value for `name`, or undefined. */
export function getRowHeader(rows: KVRow[], name: string): string | undefined {
  const index = findEnabledRowIndex(rows, name);
  return index < 0 ? undefined : rows[index].value;
}

/**
 * Update the first enabled row named `name` (case-insensitive) or append a new row. Immutable.
 * The existing row keeps its id and name casing; `rows` itself is returned when the value is unchanged.
 */
export function setRowHeader(rows: KVRow[], name: string, value: string): KVRow[] {
  const index = findEnabledRowIndex(rows, name);
  if (index < 0) {
    const row = createRow(name, value);
    if (isForbiddenRequestHeader(name)) row.locked = true;
    return [...rows, row];
  }
  if (rows[index].value === value) return rows;
  const next = rows.slice();
  next[index] = { ...rows[index], value };
  return next;
}

/** Remove every row named `name` (enabled or not). Immutable; `rows` itself is returned when none matched. */
export function removeRowHeader(rows: KVRow[], name: string): KVRow[] {
  const wanted = normalizeName(name);
  const next = rows.filter((row) => normalizeName(row.key) !== wanted);
  return next.length === rows.length ? rows : next;
}

/**
 * Parse the raw `getAllResponseHeaders()` / header-block text ("Name: value\r\n...") into pairs.
 * Values are trimmed; obsolete line folding (continuation lines starting with SP/HTAB) is joined with a
 * space; status lines, lines without a name and HTTP/2 pseudo-headers (":status") are skipped.
 */
export function parseHeaderBlock(text: string): HeaderPair[] {
  const headers: HeaderPair[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const previous = headers[headers.length - 1];
    if ((line.startsWith(' ') || line.startsWith('\t')) && previous) {
      const continuation = line.trim();
      previous.value = previous.value ? `${previous.value} ${continuation}` : continuation;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === '' || /\s/.test(name)) continue;
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return headers;
}

export interface ContentType {
  /** Lower-cased "type/subtype", '' when absent. */
  mime: string;
  /** Lower-cased parameter names; values unquoted. */
  params: Record<string, string>;
}

/** One `;name=value` parameter of a header value, with the exact source text it was parsed from. */
interface ParamToken {
  /** Source text including the leading ';'. */
  raw: string;
  /** Whitespace between ';' and the name. */
  lead: string;
  /** Name as written (trimmed). */
  name: string;
  /** Unquoted value; null when the parameter has no '='. */
  value: string | null;
  /** The value was written as a quoted-string. */
  quoted: boolean;
}

const HTTP_WHITESPACE = /[\t\n\r ]/;

function isHttpWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && HTTP_WHITESPACE.test(ch);
}

/** Read a quoted-string starting at the opening quote; returns the unescaped value and the index after it. */
function readQuoted(text: string, start: number): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
    } else if (ch === '"') {
      return { value, end: i + 1 };
    } else {
      value += ch;
      i++;
    }
  }
  return { value, end: i };
}

/** Tokenize a Content-Type-like value (WHATWG MIME parsing rules, keeping source spans). */
function tokenizeParams(text: string): { mimeRaw: string; params: ParamToken[] } {
  const firstSemicolon = text.indexOf(';');
  const mimeRaw = firstSemicolon < 0 ? text : text.slice(0, firstSemicolon);
  const params: ParamToken[] = [];
  let pos = mimeRaw.length;
  while (pos < text.length) {
    const start = pos;
    pos++; // ';'
    while (isHttpWhitespace(text[pos])) pos++;
    const lead = text.slice(start + 1, pos);
    const nameStart = pos;
    while (pos < text.length && text[pos] !== ';' && text[pos] !== '=') pos++;
    const name = text.slice(nameStart, pos).trim();
    let value: string | null = null;
    let quoted = false;
    if (text[pos] === '=') {
      pos++;
      if (text[pos] === '"') {
        const read = readQuoted(text, pos);
        value = read.value;
        quoted = true;
        pos = read.end;
        // Anything between the closing quote and the next ';' is ignored, as browsers do.
        while (pos < text.length && text[pos] !== ';') pos++;
      } else {
        const valueStart = pos;
        while (pos < text.length && text[pos] !== ';') pos++;
        value = text.slice(valueStart, pos).trim();
      }
    }
    params.push({ raw: text.slice(start, pos), lead, name, value, quoted });
  }
  return { mimeRaw, params };
}

/** Parse a Content-Type value. Duplicate parameters: the first one wins (WHATWG). */
export function parseContentType(value: string | null | undefined): ContentType {
  if (!value) return { mime: '', params: {} };
  const { mimeRaw, params } = tokenizeParams(value);
  const result: ContentType = { mime: mimeRaw.trim().toLowerCase(), params: {} };
  for (const param of params) {
    const name = param.name.toLowerCase();
    // Unquoted empty values are invalid per WHATWG; a quoted "" is a legitimate empty value.
    if (name === '' || param.value === null || Object.hasOwn(result.params, name)) continue;
    if (param.value === '' && !param.quoted) continue;
    result.params[name] = param.value;
  }
  return result;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Token as-is, anything else as a quoted-string with '"' and '\' escaped. */
function formatParamValue(value: string): string {
  return TOKEN.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Replace/add a parameter (e.g. boundary) keeping the rest of the header intact: the mime type, every
 * other parameter and their source text are untouched; the first occurrence of `param` is rewritten in
 * place (later duplicates are dropped) or `; param=value` is appended. Values that are not HTTP tokens
 * are quoted.
 */
export function setContentTypeParam(value: string, param: string, paramValue: string): string {
  const wanted = param.trim().toLowerCase();
  const formatted = formatParamValue(paramValue);
  const { mimeRaw, params } = tokenizeParams(value);
  let replaced = false;
  let out = mimeRaw;
  for (const token of params) {
    if (token.name.toLowerCase() !== wanted) {
      out += token.raw;
    } else if (!replaced) {
      out += `;${token.lead}${token.name}=${formatted}`;
      replaced = true;
    }
  }
  if (replaced) return out;
  const base = out.replace(/[\s;]+$/, '');
  return base === '' ? `${param}=${formatted}` : `${base}; ${param}=${formatted}`;
}

/** "type/subtype" in lower case, parameters stripped. */
function bareMime(mime: string): string {
  const semicolon = mime.indexOf(';');
  return (semicolon < 0 ? mime : mime.slice(0, semicolon)).trim().toLowerCase();
}

const TEXTUAL_SUBTYPES = new Set([
  'json',
  'xml',
  'javascript',
  'x-javascript',
  'ecmascript',
  'x-ecmascript',
  'x-www-form-urlencoded',
  'graphql',
  'csv',
  'yaml',
  'x-yaml',
  'x-ndjson',
  'ndjson',
  'event-stream',
]);

/** text/*, json (+json suffix), xml (+xml), javascript, ecmascript, x-www-form-urlencoded, graphql, csv, yaml, x-ndjson, event-stream. */
export function isTextualMime(mime: string): boolean {
  const bare = bareMime(mime);
  const slash = bare.indexOf('/');
  if (slash <= 0) return false;
  const type = bare.slice(0, slash);
  const subtype = bare.slice(slash + 1);
  if (type === 'text') return true;
  return (
    TEXTUAL_SUBTYPES.has(subtype) || subtype.endsWith('+json') || subtype.endsWith('+xml') || subtype.endsWith('+yaml')
  );
}

/** application/json, text/json, *+json, application/x-ndjson is NOT json. */
export function isJsonMime(mime: string): boolean {
  const bare = bareMime(mime);
  const slash = bare.indexOf('/');
  if (slash <= 0) return false;
  const subtype = bare.slice(slash + 1);
  return subtype === 'json' || subtype.endsWith('+json');
}
