import { describe, expect, it } from 'vitest';
import {
  base64ByteLength,
  base64ToBytes,
  bytesToBase64,
  tryDecodeUtf8,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from '../../src/lib/encoding';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('utf8Encode / utf8Decode', () => {
  it('round-trips ASCII, accents, CJK, emoji and surrogate pairs', () => {
    for (const text of ['', 'hello', 'çãé ü', '日本語テキスト', '👍🏽 family: 👨‍👩‍👧‍👦', '𝄞 music', 'a\u0000b']) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
  });

  it('encodes code points with the right byte sequences', () => {
    expect(Array.from(utf8Encode('A'))).toEqual([0x41]);
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8Encode('€'))).toEqual([0xe2, 0x82, 0xac]);
    expect(Array.from(utf8Encode('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('encodes lone surrogates as U+FFFD', () => {
    expect(Array.from(utf8Encode('\uD800'))).toEqual([0xef, 0xbf, 0xbd]);
    expect(Array.from(utf8Encode('x\uDC00'))).toEqual([0x78, 0xef, 0xbf, 0xbd]);
  });

  it('replaces invalid sequences with U+FFFD when decoding', () => {
    expect(utf8Decode(bytes(0x61, 0xff, 0x62))).toBe('a�b');
    expect(utf8Decode(bytes(0xe2, 0x82))).toBe('�');
    expect(utf8Decode(bytes(0xc0, 0xaf))).toBe('��'); // overlong '/'
  });

  it('keeps a leading BOM', () => {
    expect(utf8Decode(bytes(0xef, 0xbb, 0xbf, 0x7b, 0x7d))).toBe('﻿{}');
  });

  it('decodes an empty array', () => {
    expect(utf8Decode(new Uint8Array(0))).toBe('');
  });
});

describe('tryDecodeUtf8', () => {
  it('returns text for valid UTF-8', () => {
    expect(tryDecodeUtf8(utf8Encode('{"a":"ü😀"}'))).toBe('{"a":"ü😀"}');
    expect(tryDecodeUtf8(new Uint8Array(0))).toBe('');
  });

  it('allows tab, newline, carriage return, form feed, backspace and ESC', () => {
    const text = 'a\tb\nc\r\nd\fe\bf\u001b[31mred\u001b[0m';
    expect(tryDecodeUtf8(utf8Encode(text))).toBe(text);
  });

  it('rejects NUL and other C0 control characters', () => {
    expect(tryDecodeUtf8(bytes(0x61, 0x00, 0x62))).toBeNull();
    for (const control of [0x01, 0x02, 0x07, 0x0b, 0x0e, 0x1a, 0x1f]) {
      expect(tryDecodeUtf8(bytes(0x61, control))).toBeNull();
    }
  });

  it('allows DEL and C1 code points encoded as valid UTF-8', () => {
    expect(tryDecodeUtf8(bytes(0x7f))).toBe('\u007f');
    expect(tryDecodeUtf8(bytes(0xc2, 0x85))).toBe('\u0085');
  });

  it('rejects invalid UTF-8', () => {
    expect(tryDecodeUtf8(bytes(0xff))).toBeNull();
    expect(tryDecodeUtf8(bytes(0xc3))).toBeNull(); // truncated sequence
    expect(tryDecodeUtf8(bytes(0xed, 0xa0, 0x80))).toBeNull(); // encoded surrogate
    expect(tryDecodeUtf8(bytes(0xc0, 0x80))).toBeNull(); // overlong NUL
    expect(tryDecodeUtf8(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // PNG signature
  });

  it('keeps a BOM as-is', () => {
    expect(tryDecodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a');
  });
});

describe('base64', () => {
  it('encodes known vectors (RFC 4648)', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(bytesToBase64(utf8Encode(plain))).toBe(encoded);
      expect(utf8Decode(base64ToBytes(encoded))).toBe(plain);
    }
  });

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const encoded = bytesToBase64(all);
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(all));
    expect(encoded).toContain('+');
    expect(encoded).toContain('/');
  });

  it('round-trips UTF-8 text with emoji', () => {
    const text = 'olá 👋 — 世界';
    expect(utf8Decode(base64ToBytes(bytesToBase64(utf8Encode(text))))).toBe(text);
  });

  it('accepts missing padding and whitespace', () => {
    expect(utf8Decode(base64ToBytes('Zg'))).toBe('f');
    expect(utf8Decode(base64ToBytes('Zm8'))).toBe('fo');
    expect(utf8Decode(base64ToBytes('Zg='))).toBe('f');
    expect(utf8Decode(base64ToBytes(' Zm9v\nYmFy\r\n\t'))).toBe('foobar');
    expect(utf8Decode(base64ToBytes('Zm9v Yg = ='))).toBe('foob');
    expect(base64ToBytes('').length).toBe(0);
    expect(base64ToBytes('  \n').length).toBe(0);
  });

  it('throws on invalid base64', () => {
    expect(() => base64ToBytes('Zm9v!')).toThrow();
    expect(() => base64ToBytes('Z')).toThrow(); // impossible length
    expect(() => base64ToBytes('Zm9vY')).toThrow();
    expect(() => base64ToBytes('Zg===')).toThrow();
    expect(() => base64ToBytes('Z=g=')).toThrow();
    expect(() => base64ToBytes('Zm9v-_')).toThrow(); // base64url alphabet is not standard base64
    expect(() => base64ToBytes('Zm9vä')).toThrow();
  });

  it('handles 1 MB of bytes in well under a second (no call-stack overflow)', () => {
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const start = performance.now();
    const encoded = bytesToBase64(big);
    const decoded = base64ToBytes(encoded);
    const elapsed = performance.now() - start;
    expect(encoded.length).toBe(Math.ceil(big.length / 3) * 4);
    expect(decoded.length).toBe(big.length);
    expect(decoded[123_457]).toBe(big[123_457]);
    expect(decoded[big.length - 1]).toBe(big[big.length - 1]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('respects the byteOffset/length of subarray views', () => {
    const backing = utf8Encode('xx{"é":1}yy');
    const view = backing.subarray(2, backing.length - 2);
    expect(bytesToBase64(view)).toBe(bytesToBase64(utf8Encode('{"é":1}')));
    expect(tryDecodeUtf8(view)).toBe('{"é":1}');
    expect(utf8Decode(view)).toBe('{"é":1}');
  });

  it('does not depend on Function.prototype.apply (pages may patch it)', () => {
    const input = utf8Encode('foobar');
    const original = Function.prototype.apply;
    let encoded: string | Error;
    // Only the call under test runs while apply is patched (the test runner itself relies on apply).
    Function.prototype.apply = function patched(): never {
      throw new Error('patched apply called');
    };
    try {
      encoded = bytesToBase64(input);
    } catch (error) {
      encoded = error as Error;
    } finally {
      Function.prototype.apply = original;
    }
    expect(encoded).toBe('Zm9vYmFy');
  });

  it('computes the decoded length without decoding', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('Zg==')).toBe(1);
    expect(base64ByteLength('Zg')).toBe(1);
    expect(base64ByteLength('Zm8=')).toBe(2);
    expect(base64ByteLength('Zm9v')).toBe(3);
    expect(base64ByteLength('Zm9v\nYmFy')).toBe(6);
    expect(base64ByteLength(' Zm9vYg = = ')).toBe(4);
    const sample = new Uint8Array(1000).map((_, i) => i);
    expect(base64ByteLength(bytesToBase64(sample))).toBe(1000);
  });
});

describe('utf8ByteLength', () => {
  it('matches TextEncoder for every kind of code point', () => {
    for (const text of ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\uD800', '\uDC00x', '\uD83D😀', '日本語'.repeat(50)]) {
      expect(utf8ByteLength(text)).toBe(utf8Encode(text).length);
    }
  });

  it('counts surrogate pairs as 4 bytes and lone surrogates as 3', () => {
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\uD83D')).toBe(3);
    expect(utf8ByteLength('\uD83Dx')).toBe(4);
  });
});
