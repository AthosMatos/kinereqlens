import { describe, expect, it } from 'vitest';
import type { HeaderPair, SerializedBody } from '../../src/shared/types';
import { bytesToBase64, utf8Encode } from '../../src/lib/encoding';
import {
  availableModes,
  bodyCopyText,
  buildPreviewDocument,
  countLines,
  defaultMode,
  effectiveMode,
  hexDump,
  plural,
  PREVIEW_CSP,
  PREVIEW_HEAD,
  resolveBody,
  responseSize,
  sliceText,
  sniffImageMime,
} from '../../src/ui/response/body-model';

const ct = (value: string): HeaderPair[] => [{ name: 'Content-Type', value }];
const text = (t: string, extra: Partial<Extract<SerializedBody, { kind: 'text' }>> = {}): SerializedBody => ({
  kind: 'text',
  text: t,
  size: utf8Encode(t).length,
  ...extra,
});
const b64 = (bytes: number[] | Uint8Array, extra: Partial<Extract<SerializedBody, { kind: 'base64' }>> = {}): SerializedBody => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { kind: 'base64', base64: bytesToBase64(arr), size: arr.length, ...extra };
};
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

describe('resolveBody', () => {
  it('flags JSON by mime and by sniffing vague types', () => {
    const json = resolveBody(text('{"a":1}'), ct('application/json; charset=utf-8'));
    expect(json).toMatchObject({ kind: 'text', mime: 'application/json', jsonCandidate: true, preview: null });
    expect(resolveBody(text('  [1,2]'), ct('text/plain'))).toMatchObject({ jsonCandidate: true });
    expect(resolveBody(text('﻿{"a":1}'), [])).toMatchObject({ jsonCandidate: true });
    expect(resolveBody(text('{"a":1}'), ct('application/vnd.api+json'))).toMatchObject({ jsonCandidate: true });
    expect(resolveBody(text('hello'), ct('text/plain'))).toMatchObject({ jsonCandidate: false });
    expect(resolveBody(text('{"a":1}'), ct('text/css'))).toMatchObject({ jsonCandidate: false });
  });

  it('detects HTML and SVG previews', () => {
    expect(resolveBody(text('<p>x</p>'), ct('text/html'))).toMatchObject({ preview: 'html' });
    expect(resolveBody(text('<!DOCTYPE html><html></html>'), [])).toMatchObject({ preview: 'html' });
    expect(resolveBody(text('<!DOCTYPE html>'), ct('text/plain'))).toMatchObject({ preview: null });
    expect(resolveBody(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), ct('image/svg+xml'))).toMatchObject({ preview: 'image' });
  });

  it('keeps truncation and size', () => {
    expect(resolveBody(text('abc', { size: 10_000, truncated: true }), ct('text/plain'))).toMatchObject({
      size: 10_000,
      truncated: true,
    });
  });

  it('returns empty for zero-length bodies', () => {
    expect(resolveBody(text(''), ct('application/json'))).toEqual({ kind: 'empty' });
    expect(resolveBody({ kind: 'base64', base64: '', size: 0 }, [])).toEqual({ kind: 'empty' });
  });

  it('decodes textual base64 bodies with their charset', () => {
    const latin1 = resolveBody(b64([0x63, 0x61, 0x66, 0xe9]), ct('text/plain; charset=ISO-8859-1'));
    expect(latin1).toMatchObject({ kind: 'text', text: 'café' });
    const unknownCharset = resolveBody(b64(utf8Encode('héllo')), ct('text/plain; charset=x-made-up'));
    expect(unknownCharset).toMatchObject({ kind: 'text', text: 'héllo' });
  });

  it('decodes untyped base64 as text only when it is valid UTF-8', () => {
    expect(resolveBody(b64(utf8Encode('plain ✓')), [])).toMatchObject({ kind: 'text', text: 'plain ✓' });
    expect(resolveBody(b64([0, 1, 2, 0xff]), [])).toMatchObject({ kind: 'binary', preview: null });
  });

  it('recognizes images by mime or magic bytes', () => {
    const sniffed = resolveBody(b64(PNG_HEAD), ct('application/octet-stream'));
    expect(sniffed).toMatchObject({ kind: 'binary', mime: 'image/png', preview: 'image' });
    const typed = resolveBody(b64([1, 2, 3]), ct('image/webp'));
    expect(typed).toMatchObject({ kind: 'binary', mime: 'image/webp', preview: 'image' });
    expect(resolveBody(b64(utf8Encode('%PDF-1.7')), ct('application/pdf'))).toMatchObject({ kind: 'binary', preview: null });
  });

  it('tolerates malformed base64', () => {
    const body = resolveBody({ kind: 'base64', base64: '@@@not base64@@@', size: 9 }, ct('image/png'));
    expect(body).toMatchObject({ kind: 'binary', bytes: null, preview: null });
  });

  it('passes unavailable bodies through and renders form data as text', () => {
    expect(resolveBody({ kind: 'unavailable', reason: 'stream' }, [])).toEqual({ kind: 'unavailable', reason: 'stream' });
    const form = resolveBody(
      {
        kind: 'formData',
        entries: [
          { name: 'a', type: 'text', value: '1' },
          { name: 'f', type: 'file', fileName: 'x.png', mime: 'image/png', size: 3 },
        ],
      },
      [],
    );
    expect(form).toMatchObject({ kind: 'text', text: 'a=1\nf=@x.png (image/png, 3 bytes)' });
  });
});

describe('modes', () => {
  const json = resolveBody(text('{"a":1}'), ct('application/json'));
  const html = resolveBody(text('<b>x</b>'), ct('text/html'));
  const png = resolveBody(b64(PNG_HEAD), ct('image/png'));
  const bin = resolveBody(b64([0, 1, 2]), ct('application/octet-stream'));

  it('availableModes', () => {
    expect(availableModes(json)).toEqual({ pretty: true, raw: true, preview: false });
    expect(availableModes(html)).toEqual({ pretty: true, raw: true, preview: true });
    expect(availableModes(png)).toEqual({ pretty: false, raw: true, preview: true });
    expect(availableModes(bin)).toEqual({ pretty: false, raw: true, preview: false });
    expect(availableModes({ kind: 'empty' })).toEqual({ pretty: false, raw: false, preview: false });
  });

  it('defaultMode picks by content type', () => {
    expect(defaultMode(json, true)).toBe('pretty');
    expect(defaultMode(json, false)).toBe('raw');
    expect(defaultMode(html, false)).toBe('raw');
    expect(defaultMode(png, false)).toBe('preview');
    expect(defaultMode(bin, false)).toBe('raw');
  });

  it('effectiveMode keeps the pick only when available', () => {
    expect(effectiveMode('raw', json, true)).toBe('raw');
    expect(effectiveMode('preview', json, true)).toBe('pretty');
    expect(effectiveMode('pretty', bin, false)).toBe('raw');
    expect(effectiveMode(null, png, false)).toBe('preview');
  });

  it('bodyCopyText', () => {
    expect(bodyCopyText(json)).toBe('{"a":1}');
    expect(bodyCopyText(png)).toBe(bytesToBase64(new Uint8Array(PNG_HEAD)));
    expect(bodyCopyText({ kind: 'empty' })).toBe('');
  });
});

describe('text helpers', () => {
  it('sliceText cuts at a nearby newline', () => {
    const t = `${'a'.repeat(90)}\n${'b'.repeat(50)}`;
    expect(sliceText(t, 100)).toEqual({ text: `${'a'.repeat(90)}\n`, end: 91 });
    expect(sliceText('short', 100)).toEqual({ text: 'short', end: 5 });
  });

  it('sliceText never splits a surrogate pair', () => {
    const t = `ab😀cd`; // 😀 occupies indices 2-3
    const cut = sliceText(t, 3);
    expect(cut.text).toBe('ab');
    expect(cut.end).toBe(2);
  });

  it('countLines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('\n')).toBe(1);
  });

  it('hexDump formats offset, hex and ascii columns', () => {
    const lines = hexDump(new Uint8Array([...PNG_HEAD, 0x49, 0x48, 0x44, 0x52, 0x41]), 512);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|');
    expect(lines[1].startsWith('00000010  41 ')).toBe(true);
    expect(lines[1].endsWith('|A|')).toBe(true);
    expect(hexDump(new Uint8Array(100), 32)).toHaveLength(2);
  });

  it('plural', () => {
    expect(plural(1, 'key')).toBe('1 key');
    expect(plural(12345, 'item')).toBe('12,345 items');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
  });
});

describe('buildPreviewDocument', () => {
  const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><base target="_blank">`;
  it('inserts the CSP and base target right after the doctype', () => {
    expect(PREVIEW_HEAD).toBe(head);
    expect(buildPreviewDocument('<!DOCTYPE html><html><body>x</body></html>')).toBe(
      `<!DOCTYPE html>${head}<html><body>x</body></html>`,
    );
  });
  it('handles a BOM and leading whitespace before the doctype', () => {
    expect(buildPreviewDocument('﻿ \n<!doctype html><p>x</p>')).toBe(`﻿ \n<!doctype html>${head}<p>x</p>`);
  });
  it('prepends the CSP when there is no doctype', () => {
    expect(buildPreviewDocument('<p>x</p>')).toBe(`${head}<p>x</p>`);
    expect(buildPreviewDocument('')).toBe(head);
  });
  it('blocks every network fetch and form submission', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).not.toMatch(/https?:|\*|blob:/);
    expect(PREVIEW_CSP).not.toMatch(/script-src/);
  });
});

describe('misc', () => {
  it('sniffImageMime', () => {
    expect(sniffImageMime(new Uint8Array(PNG_HEAD))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(utf8Encode('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(utf8Encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(utf8Encode('hello'))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  it('responseSize prefers the explicit size', () => {
    expect(responseSize({ state: 'done', headers: [], body: text('abc'), size: 99 })).toBe(99);
    expect(responseSize({ state: 'done', headers: [], body: text('abc') })).toBe(3);
    expect(responseSize({ state: 'done', headers: [], body: null })).toBeUndefined();
  });
});
