import { describe, expect, it } from 'vitest';
import type { ResponseData } from '../../src/shared/types';
import { lineDiff, withContext } from '../../src/lib/diff';
import {
  compareHeaders,
  expandContext,
  fnv1a,
  isVolatileHeader,
  responseCompareText,
  significantHeaderChanges,
} from '../../src/ui/response/compare';

const resp = (over: Partial<ResponseData>): ResponseData => ({ state: 'done', headers: [], body: null, ...over });
const json = (text: string) =>
  resp({ headers: [{ name: 'content-type', value: 'application/json' }], body: { kind: 'text', text, size: text.length } });

describe('responseCompareText', () => {
  it('pretty-prints JSON losslessly', () => {
    const out = responseCompareText(json('{"a":1,"big":12345678901234567890}'));
    expect(out.kind).toBe('json');
    expect(out.text).toBe('{\n  "a": 1,\n  "big": 12345678901234567890\n}');
  });

  it('falls back to raw text for invalid JSON and non-JSON', () => {
    expect(responseCompareText(json('{"a":'))).toMatchObject({ kind: 'text', text: '{"a":' });
    const plain = resp({ headers: [{ name: 'content-type', value: 'text/plain' }], body: { kind: 'text', text: 'x', size: 1 } });
    expect(responseCompareText(plain)).toMatchObject({ kind: 'text', text: 'x' });
  });

  it('fingerprints binary bodies so equal sizes with different bytes still differ', () => {
    const png = (base64: string) => resp({ headers: [{ name: 'content-type', value: 'image/png' }], body: { kind: 'base64', base64, size: 3 } });
    const a = responseCompareText(png('AAEC'));
    const b = responseCompareText(png('AAED'));
    expect(a.kind).toBe('binary');
    expect(a.text).toContain('3 bytes');
    expect(a.text).not.toBe(b.text);
  });

  it('reports missing and empty bodies', () => {
    expect(responseCompareText(resp({}))).toEqual({ text: '', kind: 'none', truncated: false });
    expect(responseCompareText(resp({ body: { kind: 'text', text: '', size: 0 } }))).toMatchObject({ kind: 'empty' });
  });

  it('carries truncation', () => {
    const t = resp({ body: { kind: 'text', text: 'abc', size: 10, truncated: true } });
    expect(responseCompareText(t).truncated).toBe(true);
  });
});

describe('compareHeaders', () => {
  it('finds added, removed and changed headers case-insensitively', () => {
    const cmp = compareHeaders(
      [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Old', value: '1' },
        { name: 'Date', value: 'Mon' },
        { name: 'Vary', value: 'Accept' },
        { name: 'Vary', value: 'Origin' },
      ],
      [
        { name: 'content-type', value: 'application/json' },
        { name: 'date', value: 'Tue' },
        { name: 'vary', value: 'Accept, Origin' },
        { name: 'X-New', value: '2' },
      ],
    );
    expect(cmp.same).toBe(2);
    expect(cmp.added).toEqual([{ name: 'X-New', after: '2', volatile: false }]);
    expect(cmp.removed).toEqual([{ name: 'X-Old', before: '1', volatile: false }]);
    expect(cmp.changed).toEqual([{ name: 'date', before: 'Mon', after: 'Tue', volatile: true }]);
    expect(significantHeaderChanges(cmp)).toBe(2);
  });

  it('isVolatileHeader', () => {
    expect(isVolatileHeader('Date')).toBe(true);
    expect(isVolatileHeader('X-Request-Id')).toBe(true);
    expect(isVolatileHeader('content-type')).toBe(false);
  });
});

describe('expandContext', () => {
  const left = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const right = left.replace('line 20', 'line twenty');
  const diff = lineDiff(left, right);
  const collapsed = withContext(diff.lines, 3);

  it('keeps skip markers that are not expanded', () => {
    const rows = expandContext(diff.lines, collapsed, new Set());
    const skips = rows.filter((r) => r.op === 'skip');
    expect(skips.length).toBeGreaterThan(0);
    const shownLines = rows.filter((r) => r.op !== 'skip').length;
    const hidden = skips.reduce((n, s) => n + (s.op === 'skip' ? s.count : 0), 0);
    expect(shownLines + hidden).toBe(diff.lines.length);
  });

  it('restores the exact lines of expanded runs', () => {
    const ids = new Set(collapsed.flatMap((item, id) => (item.op === 'skip' ? [id] : [])));
    const rows = expandContext(diff.lines, collapsed, ids);
    expect(rows).toEqual(diff.lines);
  });
});

describe('fnv1a', () => {
  it('matches the reference values', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });
});
