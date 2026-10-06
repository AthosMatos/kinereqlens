import { describe, expect, it } from 'vitest';
import {
  clip,
  formatBytes,
  formatClock,
  formatDuration,
  methodClass,
  prettyJson,
  statusClass,
  urlParts,
} from '../../src/lib/format';

describe('formatBytes', () => {
  it('formats bytes with base 1024 and one decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 kB');
    expect(formatBytes(1229)).toBe('1.2 kB');
    expect(formatBytes(10 * 1024)).toBe('10 kB');
    expect(formatBytes(150 * 1024)).toBe('150 kB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('never shows "10.0" or "1024" of a unit', () => {
    expect(formatBytes(9.97 * 1024)).toBe('10 kB');
    expect(formatBytes(1023.8 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1023.6)).toBe('1.0 kB');
    expect(formatBytes(1023.4)).toBe('1023 B');
  });

  it('returns a dash for missing or invalid sizes', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds, seconds and minutes', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(0.3)).toBe('<1 ms');
    expect(formatDuration(12)).toBe('12 ms');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
    expect(formatDuration(12_345)).toBe('12.3 s');
    expect(formatDuration(123_000)).toBe('2 m 3 s');
    expect(formatDuration(3_725_000)).toBe('1 h 2 m');
  });

  it('carries over at unit boundaries', () => {
    expect(formatDuration(999.7)).toBe('1.00 s');
    expect(formatDuration(9_999)).toBe('10.0 s');
    expect(formatDuration(59_990)).toBe('1 m 0 s');
    expect(formatDuration(3_599_700)).toBe('1 h 0 m');
  });

  it('returns a dash for undefined / negative', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatClock', () => {
  it('formats local wall-clock time with milliseconds', () => {
    const date = new Date(2024, 0, 2, 3, 4, 5, 6);
    expect(formatClock(date.getTime())).toBe('03:04:05.006');
    expect(formatClock(new Date(2024, 0, 2, 23, 59, 59, 999).getTime())).toBe('23:59:59.999');
  });

  it('returns a dash for invalid input', () => {
    expect(formatClock(Number.NaN)).toBe('—');
  });
});

describe('urlParts', () => {
  it('splits a typical API URL', () => {
    expect(urlParts('https://api.example.com:8443/v1/users/42?expand=true&x=1#frag')).toEqual({
      host: 'api.example.com:8443',
      path: '/v1/users/42',
      name: '42',
      query: 'expand=true&x=1',
      origin: 'https://api.example.com:8443',
    });
  });

  it('uses the host as name for the root path and ignores trailing slashes', () => {
    expect(urlParts('https://example.com/').name).toBe('example.com');
    expect(urlParts('https://example.com').name).toBe('example.com');
    expect(urlParts('https://example.com/api/items/').name).toBe('items');
  });

  it('decodes the path and name for display', () => {
    const parts = urlParts('https://example.com/files/my%20report%E2%82%AC.pdf');
    expect(parts.path).toBe('/files/my report€.pdf');
    expect(parts.name).toBe('my report€.pdf');
    expect(urlParts('https://example.com/a%2Fb').name).toBe('a/b');
  });

  it('falls back to raw text when decoding fails', () => {
    const parts = urlParts('https://example.com/bad%E2%82/x%zz');
    expect(parts.path).toBe('/bad%E2%82/x%zz');
    expect(parts.name).toBe('x%zz');
  });

  it('handles unicode hosts and file / data URLs', () => {
    expect(urlParts('https://例え.jp/パス').host).toBe('xn--r8jz45g.jp');
    expect(urlParts('https://例え.jp/パス').name).toBe('パス');
    const file = urlParts('file:///Users/me/index.html');
    expect(file.name).toBe('index.html');
    expect(file.origin).toBe('');
    expect(urlParts('data:image/png;base64,iVBORw0KGgo=').name).toBe('data:image/png');
  });

  it('never throws on unparsable input', () => {
    expect(urlParts('/relative/path?x=1')).toEqual({
      host: '',
      path: '/relative/path?x=1',
      name: '/relative/path?x=1',
      query: '',
      origin: '',
    });
    expect(urlParts('').name).toBe('');
  });
});

describe('statusClass', () => {
  it('maps status codes to classes', () => {
    expect(statusClass(101)).toBe('1xx');
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204, 'done')).toBe('2xx');
    expect(statusClass(304)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(599)).toBe('5xx');
  });

  it('prefers pending/running, then the status, then error state', () => {
    expect(statusClass(undefined, 'pending')).toBe('pending');
    expect(statusClass(200, 'pending')).toBe('pending');
    expect(statusClass(undefined, 'running')).toBe('pending');
    expect(statusClass(undefined, 'error')).toBe('error');
    expect(statusClass(0, 'error')).toBe('error');
    expect(statusClass(undefined, 'aborted')).toBe('error');
    expect(statusClass(500, 'error')).toBe('5xx');
  });

  it('returns unknown otherwise', () => {
    expect(statusClass(undefined)).toBe('unknown');
    expect(statusClass(undefined, 'done')).toBe('unknown');
    expect(statusClass(0, 'done')).toBe('unknown');
    expect(statusClass(42)).toBe('unknown');
    expect(statusClass(600)).toBe('unknown');
    expect(statusClass(Number.NaN)).toBe('unknown');
  });
});

describe('methodClass', () => {
  it('maps known methods case-insensitively', () => {
    expect(methodClass('GET')).toBe('get');
    expect(methodClass('post')).toBe('post');
    expect(methodClass('Put')).toBe('put');
    expect(methodClass('PATCH')).toBe('patch');
    expect(methodClass('DELETE')).toBe('delete');
    expect(methodClass('HEAD')).toBe('head');
    expect(methodClass('OPTIONS')).toBe('options');
  });

  it('maps everything else to other', () => {
    expect(methodClass('PROPFIND')).toBe('other');
    expect(methodClass('')).toBe('other');
    expect(methodClass('GETX')).toBe('other');
  });
});

describe('prettyJson', () => {
  it('indents objects and arrays with two spaces', () => {
    expect(prettyJson('{"a":1,"b":[true,false,null],"c":{"d":"x"}}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    false,\n    null\n  ],\n  "c": {\n    "d": "x"\n  }\n}',
    );
  });

  it('keeps empty containers compact', () => {
    expect(prettyJson('{"a":{},"b":[ ],"c":{ \n }}')).toBe('{\n  "a": {},\n  "b": [],\n  "c": {}\n}');
    expect(prettyJson('[]')).toBe('[]');
    expect(prettyJson(' { } ')).toBe('{}');
  });

  it('preserves number literals exactly', () => {
    const text = '{"big":12345678901234567890123,"neg":-0,"exp":1E+400,"frac":1.10,"tiny":5e-324}';
    expect(prettyJson(text)).toBe(
      '{\n  "big": 12345678901234567890123,\n  "neg": -0,\n  "exp": 1E+400,\n  "frac": 1.10,\n  "tiny": 5e-324\n}',
    );
  });

  it('copies strings verbatim, including escapes and structural characters', () => {
    const text = '{"s":"a\\"b\\\\","t":"{[,:]}","u":"\\u00e9\\ud83d\\ude00 😀","n":"line\\nbreak","k\\"ey":"\\\\"}';
    expect(prettyJson(text)).toBe(
      '{\n  "s": "a\\"b\\\\",\n  "t": "{[,:]}",\n  "u": "\\u00e9\\ud83d\\ude00 😀",\n  "n": "line\\nbreak",\n  "k\\"ey": "\\\\"\n}',
    );
  });

  it('re-indents already formatted or oddly spaced JSON', () => {
    const messy = '{\r\n\t"a" :\t[ 1 ,2\n],\n    "b":"c"   }';
    expect(prettyJson(messy)).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "c"\n}');
    const pretty = prettyJson(messy)!;
    expect(prettyJson(pretty)).toBe(pretty);
  });

  it('handles primitives and a leading BOM', () => {
    expect(prettyJson('42')).toBe('42');
    expect(prettyJson(' "x" ')).toBe('"x"');
    expect(prettyJson('null')).toBe('null');
    expect(prettyJson('﻿{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('returns null for invalid JSON', () => {
    for (const text of ['', ' ', '{', '{"a":1,}', "{'a':1}", 'undefined', '{"a":1} x', 'NaN', '[1,]', '01']) {
      expect(prettyJson(text)).toBeNull();
    }
  });

  it('nests arrays of objects', () => {
    expect(prettyJson('[{"a":[{}]},[]]')).toBe('[\n  {\n    "a": [\n      {}\n    ]\n  },\n  []\n]');
  });

  it('handles deep nesting without recursion problems', () => {
    const depth = 2000;
    const text = '['.repeat(depth) + '1' + ']'.repeat(depth);
    const out = prettyJson(text);
    expect(out).not.toBeNull();
    expect(out!.split('\n')).toHaveLength(depth * 2 + 1);
  });

  it('is fast on a large document', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b'], n: 1.5 }));
    const text = JSON.stringify({ items });
    const start = performance.now();
    const out = prettyJson(text)!;
    expect(performance.now() - start).toBeLessThan(1000);
    expect(JSON.parse(out)).toEqual({ items });
    expect(out).toBe(JSON.stringify({ items }, null, 2));
  });
});

describe('clip', () => {
  it('returns the text untouched when short enough', () => {
    expect(clip('hello', 5)).toEqual({ text: 'hello', clipped: false });
    expect(clip('', 0)).toEqual({ text: '', clipped: false });
  });

  it('cuts to max chars', () => {
    expect(clip('hello world', 5)).toEqual({ text: 'hello', clipped: true });
    expect(clip('abc', 0)).toEqual({ text: '', clipped: true });
    expect(clip('abc', -3)).toEqual({ text: '', clipped: true });
  });

  it('never splits a surrogate pair', () => {
    expect(clip('a😀b', 2)).toEqual({ text: 'a', clipped: true });
    expect(clip('a😀b', 3)).toEqual({ text: 'a😀', clipped: true });
  });
});
