// OWNER: ui-response agent. Pure helpers that turn a captured response body into something displayable.
import type { HeaderPair, ResponseData, SerializedBody } from '../../shared/types';
import { base64ToBytes, tryDecodeUtf8, utf8Decode } from '../../lib/encoding';
import { getHeader, isJsonMime, isTextualMime, parseContentType } from '../../lib/headers';

/** Body display modes of the response viewer. */
export type BodyMode = 'pretty' | 'raw' | 'preview';

/** What the Preview mode can render for a body. */
export type PreviewKind = 'html' | 'image';

/** A response body normalized for display. */
export type ResolvedBody =
  /** A zero-length body. */
  | { kind: 'empty' }
  | {
      kind: 'text';
      text: string;
      /** Lower-cased mime type ('' when unknown). */
      mime: string;
      /** Full byte length before truncation. */
      size: number;
      truncated: boolean;
      /** Worth trying the lossless JSON parser (JSON mime, or JSON-looking text with a vague mime). */
      jsonCandidate: boolean;
      preview: PreviewKind | null;
    }
  | {
      kind: 'binary';
      base64: string;
      /** Decoded bytes, or null when the base64 is malformed. */
      bytes: Uint8Array | null;
      mime: string;
      size: number;
      truncated: boolean;
      preview: 'image' | null;
    }
  | { kind: 'unavailable'; reason: string };

/** Mimes for which a JSON-looking body is sniffed even though the server did not label it JSON. */
const JSON_SNIFF_MIMES = new Set(['', 'text/plain', 'text/html', 'application/octet-stream', 'binary/octet-stream']);

/** Mimes that are definitely not text even when the bytes happen to decode as UTF-8. */
function isKnownBinaryMime(mime: string): boolean {
  return /^(image|audio|video|font)\//.test(mime) || /^application\/(pdf|zip|gzip|x-gzip|wasm|x-protobuf|protobuf|vnd\.)/.test(mime);
}

/** Content-Type of a header list, parsed. */
export function responseContentType(headers: HeaderPair[]): { mime: string; charset: string | undefined } {
  const ct = parseContentType(getHeader(headers, 'content-type'));
  return { mime: ct.mime, charset: ct.params.charset };
}

/** True for HTML documents the sandboxed preview can render. */
export function isHtmlMime(mime: string): boolean {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

/** True for image types an <img> element renders. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/**
 * Detect common image formats from their magic bytes (for bodies served with a missing or generic type).
 * Returns the mime type, or null when unrecognized.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);
  const ascii = (from: number, text: string) => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM') && bytes.length > 14) return 'image/bmp';
  if (at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0) return 'image/x-icon';
  if (ascii(4, 'ftypavif')) return 'image/avif';
  return null;
}

/** Decode bytes with the declared charset when the platform knows it, else as (lossy) UTF-8. */
export function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset.trim()).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return utf8Decode(bytes);
}

function looksLikeJson(text: string): boolean {
  const head = text.slice(0, 256).trimStart();
  const first = head.charCodeAt(0) === 0xfeff ? head.charAt(1) : head.charAt(0);
  return first === '{' || first === '[';
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(text.slice(0, 512));
}

function textPreview(mime: string, text: string): PreviewKind | null {
  if (isHtmlMime(mime) || (mime === '' && looksLikeHtml(text))) return 'html';
  if (mime === 'image/svg+xml') return 'image';
  return null;
}

function textBody(text: string, mime: string, size: number, truncated: boolean): ResolvedBody {
  if (size === 0 && text === '') return { kind: 'empty' };
  return {
    kind: 'text',
    text,
    mime,
    size,
    truncated,
    jsonCandidate: isJsonMime(mime) || (JSON_SNIFF_MIMES.has(mime) && looksLikeJson(text)),
    preview: textPreview(mime, text),
  };
}

function formDataText(body: Extract<SerializedBody, { kind: 'formData' | 'formFields' }>): string {
  if (body.kind === 'formFields') return body.fields.map((f) => `${f.name}=${f.value}`).join('\n');
  return body.entries
    .map((e) => (e.type === 'text' ? `${e.name}=${e.value}` : `${e.name}=@${e.fileName} (${e.mime || 'unknown type'}, ${e.size} bytes)`))
    .join('\n');
}

/**
 * Normalize a captured body using the response Content-Type:
 *  - text bodies stay text (JSON / HTML / SVG detection for Pretty and Preview);
 *  - base64 bodies become text when the type is textual (decoded with its charset) or when the type is
 *    unknown and the bytes are valid UTF-8; otherwise binary (image preview via mime or magic bytes).
 */
export function resolveBody(body: SerializedBody, headers: HeaderPair[]): ResolvedBody {
  const { mime, charset } = responseContentType(headers);
  switch (body.kind) {
    case 'unavailable':
      return { kind: 'unavailable', reason: body.reason };
    case 'formData':
    case 'formFields': {
      const text = formDataText(body);
      return textBody(text, 'text/plain', text.length, false);
    }
    case 'text':
      return textBody(body.text, mime, body.size, body.truncated === true);
    case 'base64': {
      const truncated = body.truncated === true;
      if (body.size === 0 && body.base64 === '') return { kind: 'empty' };
      let bytes: Uint8Array | null = null;
      try {
        bytes = base64ToBytes(body.base64);
      } catch {
        bytes = null;
      }
      if (bytes && !isKnownBinaryMime(mime)) {
        if (mime !== '' && isTextualMime(mime)) return textBody(decodeText(bytes, charset), mime, body.size, truncated);
        const sniffed = sniffImageMime(bytes);
        if (!sniffed) {
          const text = tryDecodeUtf8(bytes);
          if (text !== null) return textBody(text, mime, body.size, truncated);
        }
      }
      const effectiveMime = isImageMime(mime) ? mime : (bytes && sniffImageMime(bytes)) || mime;
      return {
        kind: 'binary',
        base64: body.base64,
        bytes,
        mime: effectiveMime,
        size: body.size,
        truncated,
        preview: isImageMime(effectiveMime) && bytes ? 'image' : null,
      };
    }
  }
}

/** Which body modes make sense for a resolved body. Pretty for non-JSON text renders the raw view. */
export function availableModes(body: ResolvedBody): Record<BodyMode, boolean> {
  switch (body.kind) {
    case 'text':
      return { pretty: true, raw: true, preview: body.preview !== null };
    case 'binary':
      return { pretty: false, raw: true, preview: body.preview !== null };
    default:
      return { pretty: false, raw: false, preview: false };
  }
}

/** Mode chosen when the user has not picked one: JSON → Pretty, images → Preview, everything else → Raw. */
export function defaultMode(body: ResolvedBody, hasJsonTree: boolean): BodyMode {
  if (body.kind === 'text') {
    if (hasJsonTree) return 'pretty';
    return body.preview === 'image' ? 'preview' : 'raw';
  }
  if (body.kind === 'binary' && body.preview === 'image') return 'preview';
  return 'raw';
}

/** The mode to render: the user's pick when it is available for this body, else the default. */
export function effectiveMode(picked: BodyMode | null, body: ResolvedBody, hasJsonTree: boolean): BodyMode {
  if (picked && availableModes(body)[picked]) return picked;
  return defaultMode(body, hasJsonTree);
}

/**
 * Cut `text` to about `limit` UTF-16 units for progressive rendering, preferring a line break near the
 * cut and never splitting a surrogate pair. `end` is the index where the next chunk starts.
 */
export function sliceText(text: string, limit: number): { text: string; end: number } {
  if (text.length <= limit) return { text, end: text.length };
  let end = Math.max(1, limit);
  const nl = text.lastIndexOf('\n', end - 1);
  if (nl >= 0 && nl >= end - 4096) end = nl + 1;
  else {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { text: text.slice(0, end), end };
}

/** Number of lines as an editor would show them ("a\nb" and "a\nb\n" are both 2 lines; '' is 0). */
export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  let idx = -1;
  while ((idx = text.indexOf('\n', idx + 1)) !== -1) count++;
  return text.endsWith('\n') ? count : count + 1;
}

const HEX = '0123456789abcdef';

/**
 * Classic hex dump lines ("00000010  89 50 4e 47 …  |.PNG…|") of the first `maxBytes` bytes,
 * 16 bytes per line.
 */
export function hexDump(bytes: Uint8Array, maxBytes = 512): string[] {
  const n = Math.min(bytes.length, Math.max(0, maxBytes));
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' ';
      if (off + i < n) {
        const b = bytes[off + i];
        hex += HEX[b >> 4] + HEX[b & 15] + ' ';
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
      }
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines;
}

/** Content-Security-Policy injected into HTML previews so they cannot load anything from the network. */
export const PREVIEW_CSP =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'";

/**
 * Markup inserted at the top of every preview document:
 *  - the CSP above (no subresource loads: no network traffic, no tracking pixels);
 *  - `<base target="_blank">`, so clicking a link tries to open a popup, which `sandbox=""` blocks, instead
 *    of navigating the preview frame to a remote page. Being first, it wins over the document's own base.
 * Meta refresh needs no handling: Chromium refuses it in sandboxed documents without `allow-scripts`.
 */
export const PREVIEW_HEAD = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><base target="_blank">`;

/**
 * Prepare an HTML document for the sandboxed `srcdoc` preview: {@link PREVIEW_HEAD} is inserted right after
 * the doctype (or at the very start, which the parser hoists into <head>). The iframe's `sandbox=""` already
 * blocks scripts, forms, popups, top navigation and same-origin access.
 */
export function buildPreviewDocument(html: string): string {
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + PREVIEW_HEAD + html.slice(doctype[0].length);
  return PREVIEW_HEAD + html;
}

/** Textual body content used by "Copy body" (binary bodies copy their base64). */
export function bodyCopyText(body: ResolvedBody): string {
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'binary':
      return body.base64;
    default:
      return '';
  }
}

/** Total size of a response for the summary bar: the explicit size, else the captured body size. */
export function responseSize(resp: ResponseData): number | undefined {
  if (typeof resp.size === 'number' && resp.size >= 0) return resp.size;
  const body = resp.body;
  if (body && (body.kind === 'text' || body.kind === 'base64')) return body.size;
  return undefined;
}

/** "1 key" / "12 keys" with thousands separators. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : pluralForm}`;
}
