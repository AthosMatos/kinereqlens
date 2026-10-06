import { describe, expect, it } from 'vitest';
import type { MultipartPart } from '../../src/shared/types';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from '../../src/lib/encoding';
import {
  buildMultipart,
  filePartBytes,
  generateBoundary,
  hasMultipartBoundary,
  multipartPartHead,
  parseMultipart,
} from '../../src/lib/multipart';

const B = 'XyZ';

const text = (name: string, value: string, extra: Partial<MultipartPart> = {}): MultipartPart => ({
  id: `t-${name}`,
  enabled: true,
  name,
  kind: 'text',
  value,
  ...extra,
});

const file = (name: string, fileName: string, bytes: Uint8Array, mime = 'application/octet-stream'): MultipartPart => ({
  id: `f-${name}`,
  enabled: true,
  name,
  kind: 'file',
  value: '',
  fileName,
  mime,
  base64: bytesToBase64(bytes),
  size: bytes.length,
});

const enc = (s: string) => utf8Encode(s);
const allBytes = () => Uint8Array.from({ length: 256 }, (_, i) => i);

/** Comparable view of parsed parts (ids are random). */
const shape = (parts: MultipartPart[]) => parts.map(({ id: _id, ...rest }) => rest);

describe('generateBoundary', () => {
  it('has the documented format', () => {
    expect(generateBoundary()).toMatch(/^----ReqLensBoundary[A-Za-z0-9]{24}$/);
  });

  it('is random', () => {
    const seen = new Set(Array.from({ length: 200 }, generateBoundary));
    expect(seen.size).toBe(200);
  });
});

describe('buildMultipart', () => {
  it('encodes text and file parts with CRLF framing', () => {
    const bytes = buildMultipart([text('a', '1'), file('f', 'x.txt', enc('hi'), 'text/plain')], B);
    expect(utf8Decode(bytes)).toBe(
      '--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n' +
        '--XyZ\r\nContent-Disposition: form-data; name="f"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
        '--XyZ--\r\n',
    );
  });

  it('skips disabled parts and emits only the close delimiter when empty', () => {
    expect(utf8Decode(buildMultipart([text('a', '1', { enabled: false })], B))).toBe('--XyZ--\r\n');
    expect(utf8Decode(buildMultipart([], B))).toBe('--XyZ--\r\n');
  });

  it('percent-encodes quotes, CR and LF in names and filenames like browsers', () => {
    const out = utf8Decode(buildMultipart([file('a"b\r\nc', 'q"\n.bin', enc(''))], B));
    expect(out).toContain('name="a%22b%0D%0Ac"; filename="q%22%0A.bin"');
  });

  it('keeps text values verbatim (UTF-8, no newline normalization)', () => {
    const out = buildMultipart([text('k', 'ünï\ncodé 😀\r\n')], B);
    expect(utf8Decode(out)).toContain('\r\n\r\nünï\ncodé 😀\r\n\r\n--XyZ--');
  });

  it('defaults the file mime and writes mime / extra headers of text parts', () => {
    const noMime = { ...file('f', 'a', enc('x')), mime: '' };
    const out = utf8Decode(
      buildMultipart([noMime, text('j', '{}', { mime: 'application/json', extraHeaders: [{ name: 'X-A', value: 'b\r\nInjected: 1' }] })], B),
    );
    expect(out).toContain('filename="a"\r\nContent-Type: application/octet-stream\r\n\r\nx');
    expect(out).toContain('name="j"\r\nContent-Type: application/json\r\nX-A: b Injected: 1\r\n\r\n{}');
  });

  it('sends an empty file for missing or undecodable content', () => {
    const missing: MultipartPart = { ...file('f', 'big.bin', enc('partial')), missingContent: true };
    const broken: MultipartPart = { ...file('g', 'x.bin', enc('')), base64: '!!!' };
    const out = utf8Decode(buildMultipart([missing, broken], B));
    expect(out).toContain('filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--XyZ');
    expect(out).toContain('filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--XyZ--');
    expect(filePartBytes(missing)).toHaveLength(0);
  });

  it('exposes the per-part header block', () => {
    expect(multipartPartHead(text('a', 'v'), B)).toBe('--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n');
  });
});

describe('parseMultipart', () => {
  it('round-trips build output, binary-safe for every byte value', () => {
    const binary = allBytes();
    const parts = [text('a', 'one'), text('a', 'two'), text('uni', 'ç😀\r\nx'), file('blob', 'all.bin', binary)];
    const parsed = parseMultipart(buildMultipart(parts, B), B);
    expect(shape(parsed)).toEqual(shape(parts));
    expect(base64ToBytes(parsed[3].base64 ?? '')).toEqual(binary);
  });

  it('does not split on boundary look-alikes inside content', () => {
    // Look-alikes only: "--XyZ" not followed by "--", padding + line break, or the end of input.
    const tricky = enc('line\r\n--XyZnot-a-delimiter\r\n--XyZ-x inline\n--XyZx\r\nend --XyZ');
    const parts = [file('f', 'f.bin', tricky), text('t', 'a --XyZ b')];
    const parsed = parseMultipart(buildMultipart(parts, B), B);
    expect(parsed).toHaveLength(2);
    expect(base64ToBytes(parsed[0].base64 ?? '')).toEqual(tricky);
    expect(parsed[1].value).toBe('a --XyZ b');
  });

  it('keeps content that is itself a line break', () => {
    const parsed = parseMultipart(buildMultipart([text('nl', '\r\n'), file('f', 'f', enc('\n'))], B), B);
    expect(parsed[0].value).toBe('\r\n');
    expect(utf8Decode(base64ToBytes(parsed[1].base64 ?? ''))).toBe('\n');
  });

  it('tolerates LF line endings, preamble, epilogue and transport padding', () => {
    const body = 'preamble text\n--XyZ  \nContent-Disposition: form-data; name="a"\n\nA\n--XyZ\nContent-Disposition: form-data; name="b"\n\nB\n--XyZ--\nepilogue';
    expect(parseMultipart(enc(body), B).map((p) => [p.name, p.value])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });

  it('tolerates a missing final boundary', () => {
    const body = '--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\nA\r\n--XyZ\r\nContent-Disposition: form-data; name="b"\r\n\r\nlast\r\n';
    expect(parseMultipart(enc(body), B).map((p) => p.value)).toEqual(['A', 'last']);
    expect(parseMultipart(enc('--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\ncut'), B)[0].value).toBe('cut');
  });

  it('returns [] when the boundary never appears (or is empty)', () => {
    expect(parseMultipart(enc('just some text'), B)).toEqual([]);
    expect(parseMultipart(enc('x--XyZ\r\n'), B)).toEqual([]); // not at a line start
    expect(parseMultipart(enc('--XyZ\r\n'), '')).toEqual([]);
    expect(parseMultipart(new Uint8Array(0), B)).toEqual([]);
  });

  it('returns [] for an empty multipart body', () => {
    expect(parseMultipart(enc('--XyZ--\r\n'), B)).toEqual([]);
  });

  it('parses disposition parameters, file kinds and extra headers', () => {
    const body =
      '--XyZ\r\nContent-Disposition: form-data; filename=""; name="up"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n' +
      '--XyZ\r\ncontent-disposition: form-data; name=plain; filename*=UTF-8\'\'na%C3%AFve.txt\r\nX-Trace: 1\r\n\r\nabc\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="q\\"x"\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n' +
      '--XyZ--';
    const [empty, ext, quoted] = parseMultipart(enc(body), B);
    expect(empty).toMatchObject({ name: 'up', kind: 'file', fileName: '', base64: '', size: 0, mime: 'application/octet-stream' });
    expect(ext).toMatchObject({ name: 'plain', kind: 'file', fileName: 'naïve.txt', extraHeaders: [{ name: 'X-Trace', value: '1' }] });
    expect(utf8Decode(base64ToBytes(ext.base64 ?? ''))).toBe('abc');
    expect(quoted).toMatchObject({ name: 'q"x', kind: 'text', value: '{"a":1}', mime: 'application/json' });
  });

  it('keeps browser-escaped names exactly as sent (round trip)', () => {
    const wire = buildMultipart([text('a"b', 'v')], B);
    const [part] = parseMultipart(wire, B);
    expect(part.name).toBe('a%22b');
    expect(buildMultipart([part], B)).toEqual(wire);
  });

  it('handles a part without headers', () => {
    const [part] = parseMultipart(enc('--XyZ\r\n\r\nbare\r\n--XyZ--'), B);
    expect(part).toMatchObject({ name: '', kind: 'text', value: 'bare' });
  });

  it('assigns unique ids and enables every part', () => {
    const parsed = parseMultipart(buildMultipart([text('a', '1'), text('b', '2')], B), B);
    expect(new Set(parsed.map((p) => p.id)).size).toBe(2);
    expect(parsed.every((p) => p.enabled)).toBe(true);
  });

  it('parses large binary bodies', () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    const parsed = parseMultipart(buildMultipart([file('big', 'big.bin', big), text('after', 'ok')], B), B);
    expect(parsed[0].size).toBe(big.length);
    expect(parsed[0].base64 === bytesToBase64(big)).toBe(true);
    expect(parsed[1].value).toBe('ok');
  });
});

describe('hasMultipartBoundary', () => {
  it('detects a delimiter line', () => {
    expect(hasMultipartBoundary(enc('--XyZ--\r\n'), B)).toBe(true);
    expect(hasMultipartBoundary(enc('a\n--XyZ\n'), B)).toBe(true);
    expect(hasMultipartBoundary(enc('a--XyZ'), B)).toBe(false);
    expect(hasMultipartBoundary(enc('--XyZ'), '')).toBe(false);
  });
});
