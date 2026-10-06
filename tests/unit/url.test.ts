import { describe, expect, it } from 'vitest';
import type { KVRow } from '../../src/shared/types';
import {
  buildQueryString,
  decodeQueryComponent,
  encodeQueryComponent,
  isAbsoluteUrl,
  joinUrl,
  parseQueryString,
  resolveUrl,
  splitUrl,
} from '../../src/lib/url';
import { createRow, removeRow, updateRow } from '../../src/lib/kv';

const pairs = (rows: KVRow[]) => rows.map((r) => [r.key, r.value]);

describe('splitUrl / joinUrl', () => {
  it('splits base, query and hash', () => {
    expect(splitUrl('https://a.example:8080/p/q?x=1&y=2#frag')).toEqual({
      base: 'https://a.example:8080/p/q',
      query: 'x=1&y=2',
      hash: 'frag',
    });
    expect(splitUrl('https://a.example/')).toEqual({ base: 'https://a.example/', query: '', hash: '' });
    expect(splitUrl('https://a.example/?')).toEqual({ base: 'https://a.example/', query: '', hash: '' });
    expect(splitUrl('https://a.example/#')).toEqual({ base: 'https://a.example/', query: '', hash: '' });
  });

  it("treats a '?' after '#' as part of the hash", () => {
    expect(splitUrl('https://a.example/app#/route?tab=2')).toEqual({
      base: 'https://a.example/app',
      query: '',
      hash: '/route?tab=2',
    });
    expect(splitUrl('https://a.example/p?q=1#h?x=2#y')).toEqual({
      base: 'https://a.example/p',
      query: 'q=1',
      hash: 'h?x=2#y',
    });
  });

  it('keeps the raw encoding (no normalization)', () => {
    const url = 'https://a.example/a%2Fb/c d?q=a+b&e=%E2%82%AC&raw=[1]&x=%zz';
    const { base, query } = splitUrl(url);
    expect(base).toBe('https://a.example/a%2Fb/c d');
    expect(query).toBe('q=a+b&e=%E2%82%AC&raw=[1]&x=%zz');
    expect(joinUrl(base, query)).toBe(url);
  });

  it('keeps a second "?" inside the query', () => {
    expect(splitUrl('https://a.example/?a=1?b=2').query).toBe('a=1?b=2');
  });

  it('joins omitting empty parts', () => {
    expect(joinUrl('https://a.example/p', '')).toBe('https://a.example/p');
    expect(joinUrl('https://a.example/p', 'a=1')).toBe('https://a.example/p?a=1');
    expect(joinUrl('https://a.example/p', 'a=1', 'top')).toBe('https://a.example/p?a=1#top');
    expect(joinUrl('https://a.example/p', '', 'top')).toBe('https://a.example/p#top');
    expect(joinUrl('https://a.example/p', '', '')).toBe('https://a.example/p');
  });

  it('round-trips arbitrary URLs', () => {
    for (const url of [
      'http://x/',
      'http://x/a?b',
      'http://x/a?b=1&b=2#c',
      'http://x/a#b?c',
      'file:///tmp/a.txt?x=1',
      'https://例え.jp/パス?キー=値#フラグ',
    ]) {
      const { base, query, hash } = splitUrl(url);
      expect(joinUrl(base, query, hash)).toBe(url);
    }
  });
});

describe('parseQueryString', () => {
  it('parses keys, values, duplicates and order', () => {
    const rows = parseQueryString('a=1&b=two%20words&flag&a=2');
    expect(pairs(rows)).toEqual([
      ['a', '1'],
      ['b', 'two words'],
      ['flag', ''],
      ['a', '2'],
    ]);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows[2].raw).toEqual({ key: 'flag', value: '', hasEquals: false });
    expect(rows[1].raw).toEqual({ key: 'b', value: 'two%20words', hasEquals: true });
  });

  it("decodes '+' as space and percent escapes as UTF-8", () => {
    expect(pairs(parseQueryString('q=a+b%2Bc&e=%E2%82%AC&emoji=%F0%9F%98%80&k%20ey=v'))).toEqual([
      ['q', 'a b+c'],
      ['e', '€'],
      ['emoji', '😀'],
      ['k ey', 'v'],
    ]);
  });

  it('keeps malformed escapes literally', () => {
    expect(pairs(parseQueryString('a=%zz&b=100%&c=%E2%82&d=%FF%41&e=%41%2'))).toEqual([
      ['a', '%zz'],
      ['b', '100%'],
      ['c', '%E2%82'],
      ['d', '%FFA'],
      ['e', 'A%2'],
    ]);
  });

  it('splits at the first "=" only and allows empty keys', () => {
    expect(pairs(parseQueryString('a==b&=c&d='))).toEqual([
      ['a', '=b'],
      ['', 'c'],
      ['d', ''],
    ]);
    expect(parseQueryString('d=')[0].raw?.hasEquals).toBe(true);
  });

  it('drops empty segments and handles empty input', () => {
    expect(pairs(parseQueryString('a=1&&b=2&'))).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(parseQueryString('')).toEqual([]);
    expect(parseQueryString('&&&')).toEqual([]);
  });
});

describe('buildQueryString', () => {
  it('re-emits untouched rows byte-for-byte', () => {
    for (const query of [
      'a=1&b=two%20words&flag&a=2',
      'q=a+b&x=%7e&y=%7E&raw=[1]&weird=%zz&bad=%FF',
      'emoji=😀&encoded=%F0%9F%98%80',
      'a==b&=c&d=',
      'redirect=https%3A%2F%2Fx.example%2F%3Fa%3D1',
    ]) {
      expect(buildQueryString(parseQueryString(query))).toBe(query);
    }
  });

  it('encodes changed rows with encodeURIComponent semantics', () => {
    const rows = parseQueryString('a=1&b=2');
    const next = updateRow(rows, rows[1].id, { value: 'x y&z=€' });
    expect(buildQueryString(next)).toBe('a=1&b=x%20y%26z%3D%E2%82%AC');
  });

  it('keeps the original encoding of the unchanged component', () => {
    const rows = parseQueryString('filter%5Bname%5D=a+b&tags[]=x');
    const valueChanged = updateRow(rows, rows[0].id, { value: 'c d' });
    expect(buildQueryString(valueChanged)).toBe('filter%5Bname%5D=c%20d&tags[]=x');
    const keyChanged = updateRow(rows, rows[1].id, { key: 'labels[]' });
    expect(buildQueryString(keyChanged)).toBe('filter%5Bname%5D=a+b&labels%5B%5D=x');
  });

  it('re-emits the original text when an edit is reverted by hand', () => {
    const rows = parseQueryString('q=a+b');
    const edited = updateRow(rows, rows[0].id, { value: 'zzz' });
    const back = updateRow(edited, rows[0].id, { value: 'a b' });
    expect(buildQueryString(back)).toBe('q=a+b');
  });

  it('keeps bare flags bare (also when renamed) until they get a value', () => {
    const rows = parseQueryString('debug&x=1');
    expect(buildQueryString(updateRow(rows, rows[0].id, { key: 'verbose' }))).toBe('verbose&x=1');
    expect(buildQueryString(updateRow(rows, rows[0].id, { value: 'on' }))).toBe('debug=on&x=1');
  });

  it('emits "key=" for new rows with an empty value', () => {
    expect(buildQueryString([createRow('new', '')])).toBe('new=');
    expect(buildQueryString([createRow('', 'v')])).toBe('=v');
  });

  it('skips disabled rows and rows with empty key and value', () => {
    const rows = parseQueryString('a=1&b=2&c=3');
    const next = [...updateRow(rows, rows[1].id, { enabled: false }), createRow('', '')];
    expect(buildQueryString(next)).toBe('a=1&c=3');
    expect(buildQueryString(removeRow(rows, rows[0].id))).toBe('b=2&c=3');
    expect(buildQueryString([])).toBe('');
  });

  it('preserves duplicates and order of new rows', () => {
    const rows = [...parseQueryString('a=1'), createRow('a', '2'), createRow('b', 'ü')];
    expect(buildQueryString(rows)).toBe('a=1&a=2&b=%C3%BC');
  });
});

describe('encodeQueryComponent / decodeQueryComponent', () => {
  it('encodes like encodeURIComponent', () => {
    expect(encodeQueryComponent('a b+c&d=e/f?#')).toBe('a%20b%2Bc%26d%3De%2Ff%3F%23');
    expect(encodeQueryComponent("-_.!~*'()")).toBe("-_.!~*'()");
    expect(encodeQueryComponent('😀')).toBe('%F0%9F%98%80');
    expect(encodeQueryComponent('')).toBe('');
  });

  it('replaces lone surrogates instead of throwing', () => {
    expect(encodeQueryComponent('a\uD800b')).toBe('a%EF%BF%BDb');
    expect(encodeQueryComponent('\uDC00')).toBe('%EF%BF%BD');
  });

  it('decodes form-style', () => {
    expect(decodeQueryComponent('a+b')).toBe('a b');
    expect(decodeQueryComponent('a%2Bb')).toBe('a+b');
    expect(decodeQueryComponent('%e2%82%ac')).toBe('€');
    expect(decodeQueryComponent('plain')).toBe('plain');
    expect(decodeQueryComponent('')).toBe('');
  });

  it('keeps malformed sequences and decodes the valid parts around them', () => {
    expect(decodeQueryComponent('%')).toBe('%');
    expect(decodeQueryComponent('%%41')).toBe('%A');
    expect(decodeQueryComponent('%G1%41')).toBe('%G1A');
    expect(decodeQueryComponent('%C3%A9%C3')).toBe('é%C3');
    expect(decodeQueryComponent('%ED%A0%80x')).toBe('%ED%A0%80x'); // encoded surrogate
    expect(decodeQueryComponent('%C0%AF')).toBe('%C0%AF'); // overlong
    expect(decodeQueryComponent('a+%zz+%F0%9F%98%80')).toBe('a %zz 😀');
  });

  it('round-trips arbitrary strings', () => {
    for (const text of ['', 'a b', 'x+y', '100%', '名前 😀', 'a&b=c', '%41']) {
      expect(decodeQueryComponent(encodeQueryComponent(text))).toBe(text);
    }
  });
});

describe('isAbsoluteUrl / resolveUrl', () => {
  it('accepts http(s), ws(s) and file URLs only', () => {
    expect(isAbsoluteUrl('https://a.example/x')).toBe(true);
    expect(isAbsoluteUrl('http://localhost:3000')).toBe(true);
    expect(isAbsoluteUrl('wss://a.example/socket')).toBe(true);
    expect(isAbsoluteUrl('ws://a.example')).toBe(true);
    expect(isAbsoluteUrl('file:///tmp/x')).toBe(true);
    expect(isAbsoluteUrl('/relative')).toBe(false);
    expect(isAbsoluteUrl('relative/path')).toBe(false);
    expect(isAbsoluteUrl('//a.example/x')).toBe(false);
    expect(isAbsoluteUrl('data:text/plain,hi')).toBe(false);
    expect(isAbsoluteUrl('javascript:alert(1)')).toBe(false);
    expect(isAbsoluteUrl('blob:https://a.example/uuid')).toBe(false);
    expect(isAbsoluteUrl('')).toBe(false);
    expect(isAbsoluteUrl('http://')).toBe(false);
  });

  it('resolves relative URLs', () => {
    expect(resolveUrl('/api?x=1', 'https://a.example/app/page')).toBe('https://a.example/api?x=1');
    expect(resolveUrl('data.json', 'https://a.example/app/page')).toBe('https://a.example/app/data.json');
    expect(resolveUrl('//cdn.example/x', 'https://a.example/')).toBe('https://cdn.example/x');
    expect(resolveUrl('?q=2', 'https://a.example/p?q=1')).toBe('https://a.example/p?q=2');
    expect(resolveUrl('https://b.example/x', 'https://a.example/')).toBe('https://b.example/x');
  });

  it('keeps query encoding when resolving', () => {
    expect(resolveUrl('/s?q=a+b&e=%7e', 'https://a.example/')).toBe('https://a.example/s?q=a+b&e=%7e');
  });

  it('returns the input when resolution fails', () => {
    expect(resolveUrl('/x', 'not a base')).toBe('/x');
    expect(resolveUrl('/x', '')).toBe('/x');
    expect(resolveUrl('https://a.example/x', 'not a base')).toBe('https://a.example/x');
    expect(resolveUrl('http://[bad', 'https://a.example/')).toBe('http://[bad');
  });
});
