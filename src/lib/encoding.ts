// OWNER: lib-core agent. Pure byte/text helpers usable in every context (MAIN world, content, SW, UI).
// Must not rely on Node APIs (no Buffer). Must handle large inputs without call-stack overflow
// (no String.fromCharCode(...hugeArray)).
//
// The native primitives are bound once, when the module is evaluated. In the MAIN-world hook bundle that
// happens at document_start, before any page script runs, so a page that later patches TextDecoder, btoa,
// ... cannot observe or break kineReqLens' encoding.

const encoder = new TextEncoder();
const nativeEncode: (text: string) => Uint8Array = encoder.encode.bind(encoder);

/** BOM handling: `ignoreBOM: true` keeps a leading U+FEFF in the output, so decode/encode round-trips bytes. */
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const nativeDecodeLenient: (bytes: Uint8Array) => string = lenientDecoder.decode.bind(lenientDecoder);
const nativeDecodeStrict: (bytes: Uint8Array) => string = strictDecoder.decode.bind(strictDecoder);

const nativeBtoa: (data: string) => string = globalThis.btoa.bind(globalThis);
const nativeAtob: (data: string) => string = globalThis.atob.bind(globalThis);
const fromCharCode = String.fromCharCode;
/** Reflect.apply instead of fromCharCode.apply, so a page patching Function.prototype.apply is not involved. */
const reflectApply = Reflect.apply;

/** Bytes per String.fromCharCode call; far below every engine's argument-count limit. */
const CHUNK = 0x8000;

/** Encode a JS string as UTF-8 bytes. Lone surrogates become U+FFFD (EF BF BD). */
export function utf8Encode(text: string): Uint8Array {
  return nativeEncode(text);
}

/** Decode UTF-8 bytes; invalid sequences become U+FFFD. A leading BOM is kept (not stripped). */
export function utf8Decode(bytes: Uint8Array): string {
  return nativeDecodeLenient(bytes);
}

/**
 * True for C0 control bytes that do not occur in ordinary text. Allowed: \b (08), \t (09), \n (0A),
 * \f (0C), \r (0D) and ESC (1B, ANSI colour codes in logs). UTF-8 never uses bytes < 0x80 inside a
 * multi-byte sequence, so scanning the raw bytes is equivalent to scanning the decoded text.
 */
function isBinaryControlByte(byte: number): boolean {
  return byte < 0x20 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b;
}

/** Decode strictly; returns null when the bytes are not valid UTF-8 (or contain NUL / most C0 control chars, i.e. look binary). */
export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) {
    if (isBinaryControlByte(bytes[i])) return null;
  }
  try {
    return nativeDecodeStrict(bytes);
  } catch {
    return null;
  }
}

/** Standard base64 (with '=' padding) of arbitrary bytes. Linear time, safe for multi-megabyte inputs. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // A typed array is a valid argument list at runtime; the cast only satisfies the number[] parameter type.
    parts.push(reflectApply(fromCharCode, null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return nativeBtoa(parts.join(''));
}

const BASE64_WHITESPACE = /[\t\n\f\r ]+/g;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;

/** Throws on invalid base64. Accepts missing padding and whitespace. */
export function base64ToBytes(base64: string): Uint8Array {
  let clean = base64.replace(BASE64_WHITESPACE, '');
  // Strip up to two padding characters; atob re-validates the length afterwards.
  if (clean.endsWith('=')) clean = clean.slice(0, clean.endsWith('==') ? -2 : -1);
  if (clean.length % 4 === 1 || !BASE64_ALPHABET.test(clean)) {
    throw new Error('Invalid base64 input');
  }
  let binary: string;
  try {
    binary = nativeAtob(clean);
  } catch {
    throw new Error('Invalid base64 input');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Decoded byte length of a base64 string without decoding it. Whitespace and padding are ignored. */
export function base64ByteLength(base64: string): number {
  let symbols = 0;
  for (let i = 0; i < base64.length; i++) {
    const c = base64.charCodeAt(i);
    // Skip '=', space, \t, \n, \f, \r.
    if (c === 0x3d || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) continue;
    symbols++;
  }
  return Math.floor((symbols * 3) / 4);
}

/** UTF-8 byte length of a string without allocating the encoded bytes (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) length += 1;
    else if (c < 0x800) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else {
        length += 3;
      }
    } else length += 3;
  }
  return length;
}
