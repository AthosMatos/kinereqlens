import { describe, expect, it } from 'vitest';
import type { KVRow } from '../../src/shared/types';
import {
  getHeader,
  getRowHeader,
  headersToRows,
  isForbiddenRequestHeader,
  isJsonMime,
  isTextualMime,
  isUnsafeToOverride,
  parseContentType,
  parseHeaderBlock,
  removeRowHeader,
  rowsToHeaders,
  setContentTypeParam,
  setRowHeader,
} from '../../src/lib/headers';

const row = (id: string, key: string, value: string, enabled = true): KVRow => ({ id, enabled, key, value });

describe('isForbiddenRequestHeader', () => {
  const forbidden = [
    'accept-charset',
    'accept-encoding',
    'access-control-request-headers',
    'access-control-request-method',
    'access-control-request-private-network',
    'connection',
    'content-length',
    'cookie',
    'cookie2',
    'date',
    'dnt',
    'expect',
    'host',
    'keep-alive',
    'origin',
    'referer',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'via',
  ];

  it('flags the whole fetch-spec list, case-insensitively', () => {
    for (const name of forbidden) {
      expect(isForbiddenRequestHeader(name)).toBe(true);
      expect(isForbiddenRequestHeader(name.toUpperCase())).toBe(true);
    }
    expect(isForbiddenRequestHeader('Cookie')).toBe(true);
    expect(isForbiddenRequestHeader(' Referer ')).toBe(true);
  });

  it('flags proxy-* and sec-* prefixes', () => {
    expect(isForbiddenRequestHeader('Proxy-Authorization')).toBe(true);
    expect(isForbiddenRequestHeader('Sec-Fetch-Mode')).toBe(true);
    expect(isForbiddenRequestHeader('sec-ch-ua')).toBe(true);
  });

  it('allows ordinary headers', () => {
    for (const name of ['Accept', 'Authorization', 'Content-Type', 'User-Agent', 'X-Requested-With', 'cookies', 'secret', 'proxy', 'x-sec-token']) {
      expect(isForbiddenRequestHeader(name)).toBe(false);
    }
  });
});

describe('isUnsafeToOverride', () => {
  it('flags framing headers and proxy-*', () => {
    for (const name of ['content-length', 'Host', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect', 'Proxy-Connection']) {
      expect(isUnsafeToOverride(name)).toBe(true);
    }
  });

  it('allows forbidden-but-overridable headers', () => {
    for (const name of ['cookie', 'origin', 'referer', 'sec-fetch-site', 'user-agent', 'accept-encoding', 'date']) {
      expect(isUnsafeToOverride(name)).toBe(false);
    }
  });
});

describe('headersToRows / rowsToHeaders', () => {
  it('creates enabled rows keeping order, casing and duplicates; locks forbidden ones', () => {
    const rows = headersToRows([
      { name: 'Accept', value: '*/*' },
      { name: 'Cookie', value: 'a=1' },
      { name: 'X-Dup', value: '1' },
      { name: 'x-dup', value: '2' },
    ]);
    expect(rows.map((r) => [r.key, r.value, r.enabled, r.locked])).toEqual([
      ['Accept', '*/*', true, undefined],
      ['Cookie', 'a=1', true, true],
      ['X-Dup', '1', true, undefined],
      ['x-dup', '2', true, undefined],
    ]);
    expect('locked' in rows[0]).toBe(false);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  });

  it('emits enabled rows with non-empty names, trimmed names and verbatim values', () => {
    const rows = [row('1', ' X-A ', '  spaced  '), row('2', 'X-Off', 'v', false), row('3', '   ', 'no name'), row('4', 'X-Empty', '')];
    expect(rowsToHeaders(rows)).toEqual([
      { name: 'X-A', value: '  spaced  ' },
      { name: 'X-Empty', value: '' },
    ]);
    expect(rowsToHeaders([])).toEqual([]);
  });

  it('round-trips header pairs', () => {
    const pairs = [
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'X-Unicode', value: 'olá' },
    ];
    expect(rowsToHeaders(headersToRows(pairs))).toEqual(pairs);
  });
});

describe('getHeader / getRowHeader', () => {
  const headers = [
    { name: 'Content-Type', value: 'text/plain' },
    { name: 'content-type', value: 'second' },
  ];

  it('finds the first match case-insensitively', () => {
    expect(getHeader(headers, 'CONTENT-TYPE')).toBe('text/plain');
    expect(getHeader(headers, 'accept')).toBeUndefined();
    expect(getHeader([], 'x')).toBeUndefined();
  });

  it('ignores disabled rows', () => {
    const rows = [row('1', 'Accept', 'off', false), row('2', 'accept', 'on'), row('3', 'ACCEPT', 'later')];
    expect(getRowHeader(rows, 'Accept')).toBe('on');
    expect(getRowHeader([row('1', 'Accept', 'off', false)], 'accept')).toBeUndefined();
  });
});

describe('setRowHeader / removeRowHeader', () => {
  const rows = [row('1', 'Content-Type', 'text/plain', false), row('2', 'content-type', 'application/json'), row('3', 'X-A', '1')];

  it('updates the first enabled match, keeping id and casing', () => {
    const next = setRowHeader(rows, 'Content-Type', 'text/csv');
    expect(next).not.toBe(rows);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toEqual(row('2', 'content-type', 'text/csv'));
    expect(rows[1].value).toBe('application/json');
  });

  it('returns the same array when the value is unchanged', () => {
    expect(setRowHeader(rows, 'x-a', '1')).toBe(rows);
  });

  it('appends a new row when no enabled match exists', () => {
    const next = setRowHeader([row('1', 'Accept', 'x', false)], 'Accept', 'y');
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ key: 'Accept', value: 'y', enabled: true });
    const cookie = setRowHeader([], 'Cookie', 'a=1');
    expect(cookie[0]).toMatchObject({ key: 'Cookie', value: 'a=1', locked: true });
  });

  it('removes every row with the name, enabled or not', () => {
    expect(removeRowHeader(rows, 'CONTENT-TYPE').map((r) => r.id)).toEqual(['3']);
    expect(removeRowHeader(rows, 'missing')).toBe(rows);
  });
});

describe('parseHeaderBlock', () => {
  it('parses getAllResponseHeaders() output', () => {
    const text = 'content-type: application/json; charset=utf-8\r\ncache-control: no-cache\r\nx-empty: \r\nset-cookie: a=1\r\nset-cookie: b=2\r\n';
    expect(parseHeaderBlock(text)).toEqual([
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'cache-control', value: 'no-cache' },
      { name: 'x-empty', value: '' },
      { name: 'set-cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' },
    ]);
  });

  it('splits at the first colon and trims values', () => {
    expect(parseHeaderBlock('Location:   https://a.example:8443/x  \nX-Time: 12:30:00')).toEqual([
      { name: 'Location', value: 'https://a.example:8443/x' },
      { name: 'X-Time', value: '12:30:00' },
    ]);
  });

  it('skips status lines, garbage and pseudo-headers; joins folded lines', () => {
    const text = 'HTTP/1.1 200 OK\n:status: 200\nno colon here\nbad name: x\nX-Long: part one\n  part two\n\tpart three\n\nAccept: */*';
    expect(parseHeaderBlock(text)).toEqual([
      { name: 'X-Long', value: 'part one part two part three' },
      { name: 'Accept', value: '*/*' },
    ]);
  });

  it('handles empty input and unicode', () => {
    expect(parseHeaderBlock('')).toEqual([]);
    expect(parseHeaderBlock('\r\n\r\n')).toEqual([]);
    expect(parseHeaderBlock('x-name: 名前 😀')).toEqual([{ name: 'x-name', value: '名前 😀' }]);
  });
});

describe('parseContentType', () => {
  it('lower-cases the mime and parameter names, keeps values', () => {
    expect(parseContentType('Multipart/Form-Data; Boundary=----AbC123')).toEqual({
      mime: 'multipart/form-data',
      params: { boundary: '----AbC123' },
    });
    expect(parseContentType('application/json;charset=UTF-8')).toEqual({
      mime: 'application/json',
      params: { charset: 'UTF-8' },
    });
  });

  it('handles absent values', () => {
    expect(parseContentType(null)).toEqual({ mime: '', params: {} });
    expect(parseContentType(undefined)).toEqual({ mime: '', params: {} });
    expect(parseContentType('')).toEqual({ mime: '', params: {} });
    expect(parseContentType('text/plain')).toEqual({ mime: 'text/plain', params: {} });
  });

  it('unquotes quoted values with escapes, including ";" inside quotes', () => {
    expect(parseContentType('multipart/mixed; boundary="a;b \\"c\\" \\\\d"; charset=utf-8')).toEqual({
      mime: 'multipart/mixed',
      params: { boundary: 'a;b "c" \\d', charset: 'utf-8' },
    });
    expect(parseContentType('text/plain; x=""')).toEqual({ mime: 'text/plain', params: { x: '' } });
    expect(parseContentType('text/plain; x="unterminated')).toEqual({ mime: 'text/plain', params: { x: 'unterminated' } });
    expect(parseContentType('text/plain; x="a" junk; y=1')).toEqual({ mime: 'text/plain', params: { x: 'a', y: '1' } });
  });

  it('tolerates whitespace, empty params and duplicates (first wins)', () => {
    expect(parseContentType('  text/html  ;  charset = utf-8 ;; flag ; empty= ; charset=latin1')).toEqual({
      mime: 'text/html',
      params: { charset: 'utf-8' },
    });
  });
});

describe('setContentTypeParam', () => {
  it('replaces an existing parameter in place', () => {
    expect(setContentTypeParam('multipart/form-data; boundary=old; charset=utf-8', 'boundary', 'new')).toBe(
      'multipart/form-data; boundary=new; charset=utf-8',
    );
    expect(setContentTypeParam('multipart/form-data;Boundary="old"', 'boundary', 'new')).toBe('multipart/form-data;Boundary=new');
  });

  it('adds a missing parameter', () => {
    expect(setContentTypeParam('multipart/form-data', 'boundary', 'xyz')).toBe('multipart/form-data; boundary=xyz');
    expect(setContentTypeParam('text/plain;', 'charset', 'utf-8')).toBe('text/plain; charset=utf-8');
    expect(setContentTypeParam('', 'charset', 'utf-8')).toBe('charset=utf-8');
  });

  it('keeps other parameters byte-for-byte and drops later duplicates of the target', () => {
    expect(setContentTypeParam('Multipart/Mixed;  A="x;y" ;boundary=1;boundary=2', 'BOUNDARY', 'z')).toBe(
      'Multipart/Mixed;  A="x;y" ;boundary=z',
    );
  });

  it('quotes values that are not tokens', () => {
    expect(setContentTypeParam('multipart/form-data', 'boundary', 'a b:c')).toBe('multipart/form-data; boundary="a b:c"');
    expect(setContentTypeParam('text/plain', 'x', 'say "hi" \\o/')).toBe('text/plain; x="say \\"hi\\" \\\\o/"');
    expect(setContentTypeParam('text/plain', 'x', '')).toBe('text/plain; x=""');
    const header = setContentTypeParam('multipart/form-data', 'boundary', 'we:ird;"value"');
    expect(parseContentType(header).params.boundary).toBe('we:ird;"value"');
  });
});

describe('isTextualMime / isJsonMime', () => {
  it('recognizes textual types', () => {
    for (const mime of [
      'text/plain',
      'text/html; charset=utf-8',
      'TEXT/CSV',
      'text/event-stream',
      'application/json',
      'application/problem+json',
      'application/vnd.api+json',
      'application/xml',
      'image/svg+xml',
      'application/javascript',
      'application/x-javascript',
      'application/ecmascript',
      'application/x-www-form-urlencoded',
      'application/graphql',
      'application/csv',
      'application/yaml',
      'application/x-yaml',
      'application/x-ndjson',
    ]) {
      expect(isTextualMime(mime)).toBe(true);
    }
  });

  it('rejects binary and unknown types', () => {
    for (const mime of ['', 'image/png', 'application/octet-stream', 'application/pdf', 'multipart/form-data', 'video/mp4', 'font/woff2', 'application/zip', 'json', 'application/wasm']) {
      expect(isTextualMime(mime)).toBe(false);
    }
  });

  it('recognizes JSON (but not NDJSON)', () => {
    for (const mime of ['application/json', 'APPLICATION/JSON; charset=utf-8', 'text/json', 'application/ld+json', 'application/graphql-response+json']) {
      expect(isJsonMime(mime)).toBe(true);
    }
    for (const mime of ['application/x-ndjson', 'application/jsonl', 'text/plain', '', 'application/json-seq', 'json']) {
      expect(isJsonMime(mime)).toBe(false);
    }
  });
});
