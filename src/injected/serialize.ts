/**
 * Request/response body snapshots in the MAIN world.
 *
 * `snapshotBody` does the minimum synchronously (copying mutable buffers, reading FormData entries,
 * stringifying URLSearchParams/Documents) and returns a producer for the expensive part (decoding, base64,
 * file reads) that runs after the native call has been made.
 */
import { FILE_CAPTURE_CAP } from '../shared/constants';
import type { FormDataEntryInfo, SerializedBody } from '../shared/types';
import { bytesToBase64, tryDecodeUtf8, utf8ByteLength, utf8Decode, utf8Encode } from '../lib/encoding';
import { isTextualMime } from '../lib/headers';
import {
  arrayBufferIsView,
  blobArrayBuffer,
  blobSlice,
  call,
  formDataEntries,
  mathMin,
  NativeBlob,
  NativeDocument,
  NativeFormData,
  NativeReadableStream,
  NativeTextDecoder,
  NativeUint8Array,
  NativeURLSearchParams,
  NativeXMLSerializer,
  tagOf,
  textDecoderDecode,
  urlSearchParamsToString,
  xmlSerializeToString,
} from './natives';

/** A value now or later. */
export type Deferred<T> = T | Promise<T>;
/** Produces the serialized body after the native call was made. */
export type BodyProducer = () => Deferred<SerializedBody | null>;

/** Result of the synchronous part of a body snapshot. */
export interface BodySnapshot {
  body: BodyProducer;
  /** Content-Type the browser adds when the caller did not set one. */
  implicitType: string | null;
}

/** Which API the body was passed to (decides stream/Document handling). */
export type BodyContext = 'fetch' | 'xhr' | 'beacon';

const TEXT_PLAIN = 'text/plain;charset=UTF-8';
const FORM_URLENCODED = 'application/x-www-form-urlencoded;charset=UTF-8';
const MULTIPART = 'multipart/form-data';
/** Upper bound for all file contents captured from one FormData. */
const FORM_FILES_TOTAL_CAP = 4 * FILE_CAPTURE_CAP;

/** Snapshot of a request without body. */
export const NO_BODY: BodySnapshot = { body: () => null, implicitType: null };

/** A body that exists but could not be captured. */
export function unavailable(reason: string): SerializedBody {
  return { kind: 'unavailable', reason };
}

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
  const bytes = utf8Encode(text.length > cap ? text.slice(0, cap) : text);
  const head = bytes.subarray(0, mathMin(cap, bytes.length));
  return utf8Decode(head.subarray(0, completeUtf8Length(head)));
}

/** Text body bounded to `cap` UTF-8 bytes (`size` is the full length). */
export function textBody(text: string, cap: number): SerializedBody {
  const size = utf8ByteLength(text);
  if (size <= cap) return { kind: 'text', text, size };
  return { kind: 'text', text: truncateUtf8(text, cap), size, truncated: true };
}

function finish(body: SerializedBody, truncated: boolean): SerializedBody {
  if (truncated && (body.kind === 'text' || body.kind === 'base64')) body.truncated = true;
  return body;
}

/** Request bytes: UTF-8 text when they decode cleanly, else base64. `total` is the full byte length. */
export function bytesBody(bytes: Uint8Array, total: number, truncated: boolean): SerializedBody {
  const text = tryDecodeUtf8(truncated ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes);
  if (text !== null) return finish({ kind: 'text', text, size: total }, truncated);
  return finish({ kind: 'base64', base64: bytesToBase64(bytes), size: total }, truncated);
}

/**
 * Lower-cased "type/subtype" and charset of a Content-Type value. A deliberately small parser (the hook
 * bundle stays light): the first `charset=` parameter wins, quotes are stripped.
 */
export function mimeOf(contentType: string | null | undefined): { mime: string; charset: string | undefined } {
  if (!contentType) return { mime: '', charset: undefined };
  const semicolon = contentType.indexOf(';');
  const mime = (semicolon < 0 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
  const match = semicolon < 0 ? null : /;\s*charset\s*=\s*"?([^";\s]*)/i.exec(contentType.slice(semicolon));
  return { mime, charset: match && match[1] ? match[1] : undefined };
}

function decodeWithCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? '').trim().toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return call<string>(textDecoderDecode, new NativeTextDecoder(label), [bytes]);
    } catch {
      /* unknown label: fall back to UTF-8 */
    }
  }
  return utf8Decode(bytes);
}

/** Response bytes: textual mime -> text (non-fatal decode, declared charset), binary mime -> base64. */
export function responseBytesBody(
  bytes: Uint8Array,
  total: number,
  truncated: boolean,
  contentType: string | null | undefined,
): SerializedBody {
  const { mime, charset } = mimeOf(contentType);
  if (!mime) return bytesBody(bytes, total, truncated);
  if (!isTextualMime(mime)) return finish({ kind: 'base64', base64: bytesToBase64(bytes), size: total }, truncated);
  const isUtf8 = !charset || /^utf-?8$/i.test(charset);
  const usable = truncated && isUtf8 ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes;
  return finish({ kind: 'text', text: decodeWithCharset(usable, charset), size: total }, truncated);
}

/** Synchronous copy of at most `cap` bytes of a BufferSource (so later page mutations do not leak in). */
export function copyBytes(source: ArrayBuffer | ArrayBufferView, cap: number): { bytes: Uint8Array; total: number } {
  const view = arrayBufferIsView(source)
    ? new NativeUint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new NativeUint8Array(source);
  const total = view.length;
  const length = mathMin(total, cap);
  const bytes = new NativeUint8Array(length);
  bytes.set(length === total ? view : view.subarray(0, length));
  return { bytes, total };
}

async function readBlobBytes(blob: Blob, cap: number): Promise<{ bytes: Uint8Array; total: number }> {
  const total = blob.size;
  const part = total > cap ? call<Blob>(blobSlice, blob, [0, cap]) : blob;
  const buffer = await call<Promise<ArrayBuffer>>(blobArrayBuffer, part);
  return { bytes: new NativeUint8Array(buffer), total };
}

/** Async SerializedBody of a Blob (request side), reading at most `cap` bytes. */
export function blobBody(blob: Blob, cap: number, contentType?: string | null): BodyProducer {
  // Blobs are immutable: slicing/reading later sees the same bytes.
  return async () => {
    const { bytes, total } = await readBlobBytes(blob, cap);
    return contentType === undefined
      ? bytesBody(bytes, total, total > cap)
      : responseBytesBody(bytes, total, total > cap, contentType);
  };
}

interface FileBudget {
  remaining: number;
}

async function fileEntry(name: string, file: File, budget: FileBudget): Promise<FormDataEntryInfo> {
  const info: FormDataEntryInfo = {
    name,
    type: 'file',
    fileName: String(file.name),
    mime: String(file.type),
    size: file.size,
  };
  if (info.size > FILE_CAPTURE_CAP || info.size > budget.remaining) return { ...info, truncated: true };
  budget.remaining -= info.size;
  try {
    const buffer = await call<Promise<ArrayBuffer>>(blobArrayBuffer, file);
    return { ...info, base64: bytesToBase64(new NativeUint8Array(buffer)) };
  } catch {
    return { ...info, truncated: true };
  }
}

function formDataBody(form: FormData, cap: number): BodyProducer {
  // FormData is mutable: take the entry list now; File contents are immutable and read later.
  const items: Array<[string, FormDataEntryValue]> = [];
  const iterator = call<IterableIterator<[string, FormDataEntryValue]>>(formDataEntries, form);
  for (const pair of iterator) items.push([pair[0], pair[1]]);
  return async () => {
    const budget: FileBudget = { remaining: FORM_FILES_TOTAL_CAP };
    const entries: FormDataEntryInfo[] = [];
    for (const [name, value] of items) {
      if (typeof value === 'string') {
        if (utf8ByteLength(value) > cap) entries.push({ name, type: 'text', value: truncateUtf8(value, cap), truncated: true });
        else entries.push({ name, type: 'text', value });
      } else {
        entries.push(await fileEntry(name, value, budget));
      }
    }
    return { kind: 'formData', entries };
  };
}

function isDocument(value: object, tag: string): value is Document {
  return value instanceof NativeDocument || tag === '[object Document]' || tag === '[object HTMLDocument]' || tag === '[object XMLDocument]';
}

/** XMLSerializer output (synchronous; documents are mutable). */
export function serializeDocument(doc: Document): string {
  return call<string>(xmlSerializeToString, new NativeXMLSerializer(), [doc]);
}

/**
 * Snapshot a fetch/XHR/sendBeacon body. Throws only for values whose conversion also makes the native call
 * throw (e.g. Symbols); callers catch and record the body as unavailable.
 */
export function snapshotBody(body: unknown, cap: number, context: BodyContext): BodySnapshot {
  if (body === null || body === undefined) return NO_BODY;
  if (typeof body === 'string') return { body: () => textBody(body, cap), implicitType: TEXT_PLAIN };
  if (typeof body !== 'object') {
    const text = String(body);
    return { body: () => textBody(text, cap), implicitType: TEXT_PLAIN };
  }
  const tag = tagOf(body);
  if (body instanceof NativeURLSearchParams || tag === '[object URLSearchParams]') {
    const text = call<string>(urlSearchParamsToString, body);
    return { body: () => textBody(text, cap), implicitType: FORM_URLENCODED };
  }
  if (body instanceof NativeFormData || tag === '[object FormData]') {
    return { body: formDataBody(body as FormData, cap), implicitType: MULTIPART };
  }
  if (body instanceof NativeBlob || tag === '[object Blob]' || tag === '[object File]') {
    const type = String((body as Blob).type);
    return { body: blobBody(body as Blob, cap), implicitType: type || null };
  }
  if (arrayBufferIsView(body) || tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    const { bytes, total } = copyBytes(body as ArrayBuffer | ArrayBufferView, cap);
    return { body: () => bytesBody(bytes, total, total > bytes.length), implicitType: null };
  }
  if (context === 'fetch' && (body instanceof NativeReadableStream || tag === '[object ReadableStream]')) {
    return { body: () => unavailable('Streaming request body (ReadableStream) is not captured'), implicitType: null };
  }
  if (context === 'xhr' && isDocument(body, tag)) {
    const html = body.contentType === 'text/html';
    const text = serializeDocument(body);
    return {
      body: () => textBody(text, cap),
      implicitType: html ? 'text/html;charset=UTF-8' : 'application/xml;charset=UTF-8',
    };
  }
  // Anything else is converted with ToString by the native API too.
  const text = String(body);
  return { body: () => textBody(text, cap), implicitType: TEXT_PLAIN };
}
