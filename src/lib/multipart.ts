// OWNER: lib-body agent. multipart/form-data encode/decode (RFC 7578), binary-safe.
//
// Parsing works on raw bytes: boundaries are located with a byte search (Boyer-Moore-Horspool), so file
// contents never go through a text decoder and arbitrary binary data survives a parse -> build round trip.
// Names and filenames are kept exactly as they appear on the wire (browsers percent-encode `"`, CR and LF
// in them, which is not reversible, so no decoding is attempted).
import type { HeaderPair, MultipartPart } from '../shared/types';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from './encoding';
import { parseHeaderBlock } from './headers';
import { uid } from './ids';

const BOUNDARY_PREFIX = '----ReqLensBoundary';
const BOUNDARY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BOUNDARY_RANDOM_LENGTH = 24;
/** Largest multiple of the alphabet size that fits in a byte: bytes >= this are rejected (no modulo bias). */
const UNBIASED_BYTE_LIMIT = 256 - (256 % BOUNDARY_ALPHABET.length);

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;

const DEFAULT_FILE_MIME = 'application/octet-stream';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** "----ReqLensBoundary" + 24 random alphanumerics. */
export function generateBoundary(): string {
  let suffix = '';
  while (suffix.length < BOUNDARY_RANDOM_LENGTH) {
    for (const byte of randomBytes(BOUNDARY_RANDOM_LENGTH * 2)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      suffix += BOUNDARY_ALPHABET[byte % BOUNDARY_ALPHABET.length];
      if (suffix.length === BOUNDARY_RANDOM_LENGTH) break;
    }
  }
  return BOUNDARY_PREFIX + suffix;
}

// ---------------------------------------------------------------------------------------------
// Byte search
// ---------------------------------------------------------------------------------------------

/** Boyer-Moore-Horspool search for one fixed needle. */
class ByteFinder {
  private readonly shift = new Uint32Array(256);

  constructor(private readonly needle: Uint8Array) {
    const length = needle.length;
    this.shift.fill(length);
    for (let i = 0; i < length - 1; i++) this.shift[needle[i]] = length - 1 - i;
  }

  /** First index >= `from` where the needle occurs, or -1. */
  find(haystack: Uint8Array, from: number): number {
    const needle = this.needle;
    const length = needle.length;
    if (length === 0) return from <= haystack.length ? from : -1;
    const last = length - 1;
    let at = Math.max(0, from);
    while (at + length <= haystack.length) {
      let j = last;
      while (j >= 0 && haystack[at + j] === needle[j]) j--;
      if (j < 0) return at;
      at += this.shift[haystack[at + last]];
    }
    return -1;
  }
}

interface Delimiter {
  /** Index of "--boundary". */
  at: number;
  /** "--boundary--": end of the multipart body. */
  close: boolean;
  /** First byte after the delimiter line (start of the next part's headers). */
  next: number;
}

/**
 * Validate a "--boundary" match at `at`: it must be followed by "--" (close delimiter) or optional
 * transport padding (SP / HTAB) and a line break or the end of input. Returns null otherwise (the bytes are
 * merely a prefix of something longer, e.g. "--boundaryX").
 */
function delimiterAt(bytes: Uint8Array, at: number, length: number): Delimiter | null {
  let i = at + length;
  if (bytes[i] === DASH && bytes[i + 1] === DASH) return { at, close: true, next: i + 2 };
  while (bytes[i] === SPACE || bytes[i] === TAB) i++;
  if (i >= bytes.length) return { at, close: false, next: bytes.length };
  if (bytes[i] === CR && bytes[i + 1] === LF) return { at, close: false, next: i + 2 };
  if (bytes[i] === LF) return { at, close: false, next: i + 1 };
  return null;
}

/**
 * Next delimiter at or after `from`. A delimiter must start a line: it follows a LF, or (for the very first
 * one only) sits at the start of the body.
 */
function findDelimiter(bytes: Uint8Array, finder: ByteFinder, length: number, from: number, first: boolean): Delimiter | null {
  let at = finder.find(bytes, from);
  while (at >= 0) {
    const atLineStart = bytes[at - 1] === LF || (first && at === 0);
    const delimiter = atLineStart ? delimiterAt(bytes, at, length) : null;
    if (delimiter) return delimiter;
    at = finder.find(bytes, at + 1);
  }
  return null;
}

/** End of a part's content: the line break before the delimiter belongs to the delimiter. */
function contentEnd(bytes: Uint8Array, delimiterIndex: number, partStart: number): number {
  let end = delimiterIndex;
  if (end > partStart && bytes[end - 1] === LF) end--;
  if (end > partStart && bytes[end - 1] === CR) end--;
  return end;
}

/** True when "--boundary" occurs anywhere in `bytes` as a delimiter line. */
export function hasMultipartBoundary(bytes: Uint8Array, boundary: string): boolean {
  if (boundary === '') return false;
  const dashBoundary = utf8Encode(`--${boundary}`);
  return findDelimiter(bytes, new ByteFinder(dashBoundary), dashBoundary.length, 0, true) !== null;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** Split a part into its header block and content at the first empty line (CRLF CRLF or LF LF). */
function splitPart(part: Uint8Array): { head: Uint8Array; content: Uint8Array } {
  if (part[0] === LF) return { head: part.subarray(0, 0), content: part.subarray(1) };
  if (part[0] === CR && part[1] === LF) return { head: part.subarray(0, 0), content: part.subarray(2) };
  for (let i = 0; i < part.length; i++) {
    if (part[i] !== LF) continue;
    if (part[i + 1] === LF) return { head: part.subarray(0, i), content: part.subarray(i + 2) };
    if (part[i + 1] === CR && part[i + 2] === LF) return { head: part.subarray(0, i), content: part.subarray(i + 3) };
  }
  // No empty line: everything is headers (malformed, but keep what there is).
  return { head: part, content: part.subarray(part.length) };
}

/** Value of a quoted-string starting at the opening quote; `\"` is an escaped quote. */
function readQuoted(text: string, start: number): { value: string; end: number } {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '"') {
      value += '"';
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

/** Parameters of a Content-Disposition value (lower-cased names; the first occurrence wins). */
function dispositionParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  let i = value.indexOf(';');
  while (i >= 0 && i < value.length) {
    i++; // ';'
    while (value[i] === ' ' || value[i] === '\t') i++;
    const nameStart = i;
    while (i < value.length && value[i] !== '=' && value[i] !== ';') i++;
    const name = value.slice(nameStart, i).trim().toLowerCase();
    let paramValue = '';
    if (value[i] === '=') {
      i++;
      while (value[i] === ' ' || value[i] === '\t') i++;
      if (value[i] === '"') {
        const read = readQuoted(value, i);
        paramValue = read.value;
        i = read.end;
        while (i < value.length && value[i] !== ';') i++;
      } else {
        const valueStart = i;
        while (i < value.length && value[i] !== ';') i++;
        paramValue = value.slice(valueStart, i).trim();
      }
    }
    if (name !== '' && !params.has(name)) params.set(name, paramValue);
    if (i >= value.length) break;
  }
  return params;
}

/** RFC 8187 ext-value ("UTF-8''na%C3%AFve.txt") -> text; null when it cannot be decoded. */
function decodeExtValue(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) return null;
  const charset = match[1].toLowerCase();
  if (charset !== 'utf-8' && charset !== 'utf8') return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function parsePart(bytes: Uint8Array): MultipartPart {
  const { head, content } = splitPart(bytes);
  let name = '';
  let fileName: string | undefined;
  let mime: string | undefined;
  let seenDisposition = false;
  const extraHeaders: HeaderPair[] = [];
  for (const header of parseHeaderBlock(utf8Decode(head))) {
    const lower = header.name.toLowerCase();
    if (lower === 'content-disposition' && !seenDisposition) {
      seenDisposition = true;
      const params = dispositionParams(header.value);
      name = params.get('name') ?? '';
      fileName = params.get('filename');
      const extended = params.get('filename*');
      if (fileName === undefined && extended !== undefined) fileName = decodeExtValue(extended) ?? extended;
    } else if (lower === 'content-type' && mime === undefined) {
      mime = header.value;
    } else {
      extraHeaders.push({ name: header.name, value: header.value });
    }
  }

  const part: MultipartPart = { id: uid('mp'), enabled: true, name, kind: fileName === undefined ? 'text' : 'file', value: '' };
  if (fileName !== undefined) {
    part.fileName = fileName;
    part.base64 = bytesToBase64(content);
    part.size = content.length;
  } else {
    part.value = utf8Decode(content);
  }
  if (mime !== undefined) part.mime = mime;
  if (extraHeaders.length > 0) part.extraHeaders = extraHeaders;
  return part;
}

/**
 * Parse a multipart body. Text parts (no filename) decode as UTF-8 into `value`; parts with a filename
 * become kind 'file' with base64 content. Unknown part headers go to extraHeaders. Tolerates CRLF or LF
 * line endings, a missing final boundary, preamble/epilogue. Returns [] if the boundary never appears.
 *
 * With a missing final boundary the last part runs to the end of the input (one trailing line break is
 * dropped). A delimiter line followed by nothing at all does not produce a part.
 */
export function parseMultipart(bytes: Uint8Array, boundary: string): MultipartPart[] {
  if (boundary === '' || bytes.length === 0) return [];
  const dashBoundary = utf8Encode(`--${boundary}`);
  const finder = new ByteFinder(dashBoundary);
  const length = dashBoundary.length;
  const parts: MultipartPart[] = [];

  let delimiter = findDelimiter(bytes, finder, length, 0, true);
  while (delimiter && !delimiter.close) {
    const start = delimiter.next;
    const following = findDelimiter(bytes, finder, length, start, false);
    const end = contentEnd(bytes, following ? following.at : bytes.length, start);
    // An empty region (two delimiter lines in a row, or a delimiter at the very end) carries no part.
    if (end > start) parts.push(parsePart(bytes.subarray(start, end)));
    if (!following) break;
    delimiter = following;
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

/** Escape a field name / filename the way browsers do (WHATWG multipart/form-data encoding). */
function escapeDispositionValue(value: string): string {
  return value.replace(/["\r\n]/g, (ch) => (ch === '"' ? '%22' : ch === '\r' ? '%0D' : '%0A'));
}

/** Part header values must not contain line breaks (they would inject headers). */
function singleLine(value: string): string {
  return value.replace(/\r\n|[\r\n]/g, ' ');
}

/** HTML "multipart/form-data encoding" newline normalization (FormData names and string values): CRLF. */
export function normalizeFormDataNewlines(text: string): string {
  return /[\r\n]/.test(text) ? text.replace(/\r\n|\r|\n/g, '\r\n') : text;
}

/**
 * Header block of one part, from its "--boundary" line up to and including the empty line that precedes
 * the content. Shared by buildMultipart and the raw-text view of multipart bodies. `formData`: normalize
 * line breaks of the name like browsers do for FormData (before the %0D%0A escaping).
 */
export function multipartPartHead(part: MultipartPart, boundary: string, formData = false): string {
  const name = formData ? normalizeFormDataNewlines(part.name) : part.name;
  let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDispositionValue(name)}"`;
  if (part.kind === 'file') head += `; filename="${escapeDispositionValue(part.fileName ?? '')}"`;
  head += '\r\n';
  const type = part.kind === 'file' ? part.mime || DEFAULT_FILE_MIME : part.mime;
  if (type) head += `Content-Type: ${singleLine(type)}\r\n`;
  for (const header of part.extraHeaders ?? []) {
    const name = singleLine(header.name).replace(/:/g, '').trim();
    if (name !== '') head += `${name}: ${singleLine(header.value)}\r\n`;
  }
  return `${head}\r\n`;
}

/** Content bytes of a file part: empty when the content was never captured or is not valid base64. */
export function filePartBytes(part: MultipartPart): Uint8Array {
  if (part.missingContent || !part.base64) return new Uint8Array(0);
  try {
    return base64ToBytes(part.base64);
  } catch {
    return new Uint8Array(0);
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Text content of a part as sent (FormData normalization of line breaks when `formData`). */
export function textPartValue(part: MultipartPart, formData = false): string {
  return formData ? normalizeFormDataNewlines(part.value) : part.value;
}

/**
 * Encode enabled parts with CRLF line endings:
 *   --boundary\r\nContent-Disposition: form-data; name="x"[; filename="f"]\r\n[Content-Type: m\r\n]\r\n<data>\r\n ... --boundary--\r\n
 * Quotes/CR/LF in names and filenames are percent-encoded as browsers do (" -> %22, \r -> %0D, \n -> %0A).
 *
 * File parts always carry a Content-Type (application/octet-stream when the mime is unknown, like
 * browsers); text parts only when they have a mime. Text values are sent verbatim as UTF-8, except for
 * bodies captured from a FormData (`formData`): there line breaks in names and text values become CRLF,
 * as the browser's FormData encoder does. A part marked missingContent is sent as an empty file.
 */
export function buildMultipart(parts: MultipartPart[], boundary: string, formData = false): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (!part.enabled) continue;
    chunks.push(utf8Encode(multipartPartHead(part, boundary, formData)));
    chunks.push(part.kind === 'file' ? filePartBytes(part) : utf8Encode(textPartValue(part, formData)));
    chunks.push(utf8Encode('\r\n'));
  }
  chunks.push(utf8Encode(`--${boundary}--\r\n`));
  return concatBytes(chunks);
}
