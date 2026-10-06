/**
 * Body snapshots, mirroring src/injected/serialize.ts for React Native: RN Blobs are read through FileReader
 * (readAsDataURL, available on every RN version), RN FormData parts are `{ string }` or `{ uri, name, type }`.
 */
import type { FormDataEntryInfo, SerializedBody } from './protocol';
import { base64ByteLength, base64ToBytes, bytesToBase64, completeUtf8Length, tryDecodeUtf8, utf8ByteLength, utf8Decode, utf8Encode } from './encoding';
import { isTextualMime, mimeOf } from './headers';

export type Deferred<T> = T | Promise<T>;
export type BodyProducer = () => Deferred<SerializedBody | null>;

export interface BodySnapshot {
  body: BodyProducer;
  /** Content-Type implied by the body type when the app did not set one. */
  implicitType: string | null;
}

export const NO_BODY: BodySnapshot = { body: () => null, implicitType: null };

export function unavailable(reason: string): SerializedBody {
  return { kind: 'unavailable', reason };
}

function truncateUtf8(text: string, cap: number): string {
  if (cap <= 0) return '';
  const bytes = utf8Encode(text.length > cap ? text.slice(0, cap) : text);
  const head = bytes.subarray(0, Math.min(cap, bytes.length));
  return utf8Decode(head.subarray(0, completeUtf8Length(head)));
}

/** Text bounded to `cap` UTF-8 bytes (`size` = full byte length). */
export function textBody(text: string, cap: number): SerializedBody {
  const size = utf8ByteLength(text);
  if (size <= cap) return { kind: 'text', text, size };
  return { kind: 'text', text: truncateUtf8(text, cap), size, truncated: true };
}

function finish(body: SerializedBody, truncated: boolean): SerializedBody {
  if (truncated && (body.kind === 'text' || body.kind === 'base64')) body.truncated = true;
  return body;
}

/** Request bytes: UTF-8 text when they decode cleanly, else base64. */
export function bytesBody(bytes: Uint8Array, total: number, truncated: boolean): SerializedBody {
  const text = tryDecodeUtf8(truncated ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes);
  if (text !== null) return finish({ kind: 'text', text, size: total }, truncated);
  return finish({ kind: 'base64', base64: bytesToBase64(bytes), size: total }, truncated);
}

/** Response bytes: textual mime -> text, binary mime -> base64, no mime -> sniff. */
export function responseBytesBody(bytes: Uint8Array, total: number, truncated: boolean, contentType: string | null | undefined): SerializedBody {
  const { mime } = mimeOf(contentType);
  if (!mime) return bytesBody(bytes, total, truncated);
  if (!isTextualMime(mime)) return finish({ kind: 'base64', base64: bytesToBase64(bytes), size: total }, truncated);
  const usable = truncated ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes;
  return finish({ kind: 'text', text: utf8Decode(usable), size: total }, truncated);
}

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

export function isArrayBufferLike(value: unknown): value is ArrayBuffer | ArrayBufferView {
  if (!value || typeof value !== 'object') return false;
  if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  const tag = tagOf(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** Copy at most `cap` bytes now (later mutations by the app must not leak in). */
export function copyBytes(source: ArrayBuffer | ArrayBufferView, cap: number): { bytes: Uint8Array; total: number } {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source as ArrayBuffer);
  const total = view.length;
  const length = Math.min(total, cap);
  const bytes = new Uint8Array(length);
  bytes.set(view.subarray(0, length));
  return { bytes, total };
}

/** Structural Blob check (RN Blobs are plain JS objects backed by the native BlobModule). */
export function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as { size?: unknown; type?: unknown; slice?: unknown };
  return typeof blob.size === 'number' && typeof blob.type === 'string' && typeof blob.slice === 'function';
}

type FileReaderCtor = new () => {
  onload: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  result: unknown;
  error?: unknown;
  readAsDataURL(blob: Blob): void;
};

function fileReaderCtor(): FileReaderCtor | null {
  const ctor = (globalThis as { FileReader?: unknown }).FileReader;
  return typeof ctor === 'function' ? (ctor as FileReaderCtor) : null;
}

function readAsDataUrl(Reader: FileReaderCtor, blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Read at most `cap` bytes of a Blob. React Native: FileReader.readAsDataURL (Blob.arrayBuffer() does not
 * exist there); elsewhere Blob.arrayBuffer().
 */
export async function readBlobBytes(blob: Blob, cap: number): Promise<{ bytes: Uint8Array; total: number }> {
  const total = blob.size;
  if (cap <= 0 || total === 0) return { bytes: new Uint8Array(0), total };
  const part = total > cap ? blob.slice(0, cap) : blob;
  const Reader = fileReaderCtor();
  if (Reader) {
    const url = await readAsDataUrl(Reader, part);
    const comma = url.indexOf(',');
    const payload = comma < 0 ? '' : url.slice(comma + 1);
    const bytes = base64ToBytes(payload);
    return { bytes: bytes.length > cap ? bytes.subarray(0, cap) : bytes, total };
  }
  const withArrayBuffer = part as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return { bytes: new Uint8Array(await withArrayBuffer.arrayBuffer()), total };
  }
  throw new Error('Blob contents are not readable here');
}

/** Async SerializedBody of a Blob. contentType undefined = request side (sniff text). */
export function blobBody(blob: Blob, cap: number, contentType?: string | null): BodyProducer {
  return async () => {
    const { bytes, total } = await readBlobBytes(blob, cap);
    return contentType === undefined ? bytesBody(bytes, total, total > cap) : responseBytesBody(bytes, total, total > cap, contentType);
  };
}

/** Base64 payload (e.g. from a native module) bounded to `cap`. */
export function base64Body(base64: string, cap: number, contentType: string | null): SerializedBody {
  const total = base64ByteLength(base64);
  const bytes = base64ToBytes(base64);
  const truncated = bytes.length > cap;
  return responseBytesBody(truncated ? bytes.subarray(0, cap) : bytes, total, truncated, contentType);
}

interface RnFormDataPart {
  string?: unknown;
  uri?: unknown;
  name?: unknown;
  type?: unknown;
  fieldName?: unknown;
  headers?: Record<string, unknown>;
}

function fieldNameOf(part: RnFormDataPart): string {
  if (typeof part.fieldName === 'string') return part.fieldName;
  const disposition = part.headers ? String(part.headers['content-disposition'] ?? '') : '';
  const match = /name="([^"]*)"/.exec(disposition);
  return match ? match[1] : '';
}

function formDataBody(form: object, cap: number): BodyProducer | null {
  const rn = form as { getParts?: () => RnFormDataPart[] };
  if (typeof rn.getParts === 'function') {
    const parts = rn.getParts();
    const entries: FormDataEntryInfo[] = [];
    for (const part of parts) {
      const name = fieldNameOf(part);
      if (typeof part.string === 'string') {
        const value = part.string;
        if (utf8ByteLength(value) > cap) entries.push({ name, type: 'text', value: truncateUtf8(value, cap), truncated: true });
        else entries.push({ name, type: 'text', value });
      } else {
        entries.push({
          name,
          type: 'file',
          fileName: typeof part.name === 'string' ? part.name : '',
          mime: typeof part.type === 'string' ? part.type : '',
          size: -1,
          truncated: true,
          ...(typeof part.uri === 'string' ? { uri: part.uri } : {}),
        });
      }
    }
    return () => ({ kind: 'formData', entries });
  }
  const standard = form as { entries?: () => Iterable<[string, unknown]> };
  if (typeof standard.entries !== 'function') return null;
  const items: Array<[string, unknown]> = [];
  for (const pair of standard.entries()) items.push([pair[0], pair[1]]);
  return async () => {
    const entries: FormDataEntryInfo[] = [];
    let budget = 4 * cap;
    for (const [name, value] of items) {
      if (typeof value === 'string') {
        if (utf8ByteLength(value) > cap) entries.push({ name, type: 'text', value: truncateUtf8(value, cap), truncated: true });
        else entries.push({ name, type: 'text', value });
      } else if (isBlobLike(value)) {
        const file = value as Blob & { name?: unknown };
        const info = {
          name,
          type: 'file' as const,
          fileName: typeof file.name === 'string' ? file.name : 'blob',
          mime: file.type,
          size: file.size,
        };
        if (file.size > cap || file.size > budget) {
          entries.push({ ...info, truncated: true });
          continue;
        }
        budget -= file.size;
        try {
          const { bytes } = await readBlobBytes(file, cap);
          entries.push({ ...info, base64: bytesToBase64(bytes) });
        } catch {
          entries.push({ ...info, truncated: true });
        }
      }
    }
    return { kind: 'formData', entries };
  };
}

function isFormData(value: object): boolean {
  const ctor = (globalThis as { FormData?: unknown }).FormData;
  if (typeof ctor === 'function' && value instanceof (ctor as new () => object)) return true;
  if (tagOf(value) === '[object FormData]') return true;
  return typeof (value as { getParts?: unknown }).getParts === 'function' && typeof (value as { append?: unknown }).append === 'function';
}

function isUrlSearchParams(value: object): boolean {
  const ctor = (globalThis as { URLSearchParams?: unknown }).URLSearchParams;
  if (typeof ctor === 'function' && value instanceof (ctor as new () => object)) return true;
  return tagOf(value) === '[object URLSearchParams]';
}

/**
 * Synchronous part of a request body snapshot (copies mutable buffers now, reads blobs later). Throws only
 * for values whose conversion would also make the native call throw; callers catch.
 */
export function snapshotBody(body: unknown, cap: number): BodySnapshot {
  if (body === null || body === undefined) return NO_BODY;
  if (typeof body === 'string') return { body: () => textBody(body, cap), implicitType: null };
  if (typeof body !== 'object') {
    const text = String(body);
    return { body: () => textBody(text, cap), implicitType: null };
  }
  if (isFormData(body)) {
    const producer = formDataBody(body, cap);
    if (producer) return { body: producer, implicitType: 'multipart/form-data' };
  }
  if (isUrlSearchParams(body)) {
    const text = String(body);
    return { body: () => textBody(text, cap), implicitType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (isArrayBufferLike(body)) {
    const { bytes, total } = copyBytes(body, cap);
    return { body: () => bytesBody(bytes, total, total > bytes.length), implicitType: null };
  }
  if (isBlobLike(body)) {
    return { body: blobBody(body, cap), implicitType: body.type || null };
  }
  const text = String(body);
  return { body: () => textBody(text, cap), implicitType: null };
}
