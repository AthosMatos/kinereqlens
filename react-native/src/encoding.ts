/**
 * Byte/text helpers that work on every React Native engine (Hermes before 0.74 has no atob/btoa and no
 * TextDecoder; JSC has neither TextEncoder nor TextDecoder). Native implementations are used when present,
 * pure-JS fallbacks otherwise. No Node APIs.
 */

const CHUNK = 0x2000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // base64url tolerance
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

interface Codecs {
  encode: ((text: string) => Uint8Array) | null;
  decodeLenient: ((bytes: Uint8Array) => string) | null;
  decodeStrict: ((bytes: Uint8Array) => string) | null;
}

function nativeCodecs(): Codecs {
  const g = globalThis as { TextEncoder?: typeof TextEncoder; TextDecoder?: typeof TextDecoder };
  const codecs: Codecs = { encode: null, decodeLenient: null, decodeStrict: null };
  try {
    if (typeof g.TextEncoder === 'function') {
      const encoder = new g.TextEncoder();
      codecs.encode = (text) => encoder.encode(text);
    }
  } catch {
    /* fallback */
  }
  try {
    if (typeof g.TextDecoder === 'function') {
      const lenient = new g.TextDecoder('utf-8', { ignoreBOM: true });
      const strict = new g.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      codecs.decodeLenient = (bytes) => lenient.decode(bytes);
      codecs.decodeStrict = (bytes) => strict.decode(bytes);
    }
  } catch {
    /* fallback */
  }
  return codecs;
}

let codecs: Codecs = nativeCodecs();

/** Test hook: force the pure-JS implementations (true) or re-detect native ones (false). */
export function _forceJsCodecs(force: boolean): void {
  codecs = force ? { encode: null, decodeLenient: null, decodeStrict: null } : nativeCodecs();
}

/** UTF-8 encode (lone surrogates become U+FFFD). */
export function utf8Encode(text: string): Uint8Array {
  if (codecs.encode) return codecs.encode(text);
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[n++] = code;
    else if (code < 0x800) {
      out[n++] = 0xc0 | (code >> 6);
      out[n++] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      out[n++] = 0xe0 | (code >> 12);
      out[n++] = 0x80 | ((code >> 6) & 63);
      out[n++] = 0x80 | (code & 63);
    } else {
      out[n++] = 0xf0 | (code >> 18);
      out[n++] = 0x80 | ((code >> 12) & 63);
      out[n++] = 0x80 | ((code >> 6) & 63);
      out[n++] = 0x80 | (code & 63);
    }
  }
  return out.subarray(0, n);
}

/** UTF-8 byte length of a JS string without allocating. */
export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

function codeUnitsToString(units: number[]): string {
  let out = '';
  for (let i = 0; i < units.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, units.slice(i, i + CHUNK));
  }
  return out;
}

/** JS UTF-8 decoder. strict: returns null on invalid input; lenient: invalid sequences become U+FFFD. */
function jsDecode(bytes: Uint8Array, strict: boolean): string | null {
  const units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      units.push(b0);
      i++;
      continue;
    }
    let need = 0;
    let code = 0;
    let min = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      code = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      code = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      code = b0 & 0x07;
      min = 0x10000;
    } else {
      if (strict) return null;
      units.push(0xfffd);
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      const b = bytes[i + j];
      if (b === undefined || (b & 0xc0) !== 0x80) break;
      code = (code << 6) | (b & 0x3f);
    }
    if (j <= need || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      if (strict) return null;
      units.push(0xfffd);
      i += Math.max(1, j);
      continue;
    }
    if (code >= 0x10000) {
      code -= 0x10000;
      units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else units.push(code);
    i += need + 1;
  }
  return codeUnitsToString(units);
}

/** Lenient UTF-8 decode. */
export function utf8Decode(bytes: Uint8Array): string {
  if (codecs.decodeLenient) return codecs.decodeLenient(bytes);
  return jsDecode(bytes, false) as string;
}

function isBinaryControlByte(byte: number): boolean {
  return byte < 0x20 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b;
}

/** Strict decode; null when the bytes are not valid UTF-8 or look binary (NUL / most C0 control bytes). */
export function tryDecodeUtf8(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) if (isBinaryControlByte(bytes[i])) return null;
  if (codecs.decodeStrict) {
    try {
      return codecs.decodeStrict(bytes);
    } catch {
      return null;
    }
  }
  return jsDecode(bytes, true);
}

/** Length of the longest prefix of `bytes` that does not end inside a multi-byte UTF-8 sequence. */
export function completeUtf8Length(bytes: Uint8Array): number {
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

/** Standard padded base64 (pure JS: no btoa on older Hermes). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  const length = bytes.length;
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    if (chunk.length >= 0x4000) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (i < length) {
    const b1 = i + 1 < length ? bytes[i + 1] : 0;
    const n = (bytes[i] << 16) | (b1 << 8);
    chunk += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  parts.push(chunk);
  return parts.join('');
}

/** Decode base64 (padding optional, whitespace ignored, base64url accepted). Throws on invalid input. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\t\n\f\r =]+/g, '');
  if (clean.length % 4 === 1) throw new Error('Invalid base64 input');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? B64_LOOKUP[code] : -1;
    if (value < 0) throw new Error('Invalid base64 input');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** Byte length of base64 data without decoding it. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/[\t\n\f\r =]+/g, '');
  return Math.floor((clean.length * 3) / 4);
}
