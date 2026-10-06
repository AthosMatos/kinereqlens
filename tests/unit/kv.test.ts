import { describe, expect, it } from 'vitest';
import type { KVRow } from '../../src/shared/types';
import {
  cloneRows,
  createRow,
  diffRows,
  parseBulk,
  removeRow,
  revertRow,
  rowsModified,
  toBulk,
  updateRow,
} from '../../src/lib/kv';

const row = (id: string, key: string, value: string, enabled = true, extra: Partial<KVRow> = {}): KVRow => ({
  id,
  enabled,
  key,
  value,
  ...extra,
});

const ids = (rows: KVRow[]) => rows.map((r) => r.id);

describe('createRow / cloneRows', () => {
  it('creates enabled rows with unique ids', () => {
    const a = createRow('k', 'v');
    const b = createRow();
    expect(a).toMatchObject({ key: 'k', value: 'v', enabled: true });
    expect(b).toMatchObject({ key: '', value: '', enabled: true });
    expect(a.id).not.toBe(b.id);
    expect(createRow('x', 'y', false).enabled).toBe(false);
  });

  it('deep-copies rows keeping ids', () => {
    const rows = [row('1', 'a', '1', true, { raw: { key: 'a', value: '1', hasEquals: true } }), row('2', 'b', '2')];
    const copy = cloneRows(rows);
    expect(copy).toStrictEqual(rows);
    expect(copy[0]).not.toBe(rows[0]);
    expect(copy[0].raw).not.toBe(rows[0].raw);
    expect('raw' in copy[1]).toBe(false);
  });
});

describe('diffRows / rowsModified', () => {
  const original = [row('1', 'a', '1'), row('2', 'b', '2'), row('3', 'c', '3')];

  it('reports nothing for identical rows', () => {
    const diff = diffRows(original, cloneRows(original));
    expect(diff.changed.size).toBe(0);
    expect(diff.added.size).toBe(0);
    expect(diff.removed).toEqual([]);
    expect(diff.reordered).toBe(false);
    expect(rowsModified(original, cloneRows(original))).toBe(false);
  });

  it('detects changed key, value and enabled flag', () => {
    let current = updateRow(original, '1', { key: 'A' });
    current = updateRow(current, '2', { value: 'two' });
    current = updateRow(current, '3', { enabled: false });
    const diff = diffRows(original, current);
    expect([...diff.changed].sort()).toEqual(['1', '2', '3']);
    expect(rowsModified(original, current)).toBe(true);
  });

  it('ignores raw / locked differences (only key, value, enabled count)', () => {
    const current = updateRow(original, '1', { raw: { key: 'x', value: 'y', hasEquals: true }, locked: true });
    expect(diffRows(original, current).changed.size).toBe(0);
    expect(rowsModified(original, current)).toBe(false);
  });

  it('treats an edit reverted by hand as unmodified', () => {
    const edited = updateRow(original, '2', { value: 'zz' });
    const back = updateRow(edited, '2', { value: '2' });
    expect(rowsModified(original, back)).toBe(false);
  });

  it('detects added and removed rows in original order', () => {
    const current = [original[2], row('9', 'new', 'x')];
    const diff = diffRows(original, current);
    expect([...diff.added]).toEqual(['9']);
    expect(ids(diff.removed)).toEqual(['1', '2']);
    expect(diff.reordered).toBe(false);
    expect(rowsModified(original, current)).toBe(true);
  });

  it('detects reordering of surviving rows', () => {
    const current = [original[1], original[0], original[2]];
    const diff = diffRows(original, current);
    expect(diff.reordered).toBe(true);
    expect(diff.changed.size).toBe(0);
    expect(rowsModified(original, current)).toBe(true);
  });

  it('does not flag reordering when rows are only removed', () => {
    expect(diffRows(original, [original[0], original[2]]).reordered).toBe(false);
  });

  it('detects a remove + add of the same length', () => {
    const current = [original[0], original[1], row('4', 'c', '3')];
    expect(rowsModified(original, current)).toBe(true);
  });

  it('handles duplicate keys by id', () => {
    const dupes = [row('1', 'a', '1'), row('2', 'a', '2')];
    const current = updateRow(dupes, '2', { value: '3' });
    expect([...diffRows(dupes, current).changed]).toEqual(['2']);
  });

  it('handles empty lists', () => {
    expect(rowsModified([], [])).toBe(false);
    expect(rowsModified([], [row('1', 'a', '')])).toBe(true);
    expect(ids(diffRows(original, []).removed)).toEqual(['1', '2', '3']);
  });
});

describe('revertRow', () => {
  const raw = { key: 'a%20b', value: 'x', hasEquals: true };
  const original = [row('1', 'a b', 'x', true, { raw }), row('2', 'b', '2'), row('3', 'c', '3'), row('4', 'd', '4')];

  it('restores a changed row in place, including raw', () => {
    const current = updateRow(original, '1', { key: 'zz', value: 'yy', enabled: false, raw: undefined });
    const reverted = revertRow(original, current, '1');
    expect(reverted[0]).toStrictEqual(original[0]);
    expect(reverted[0]).not.toBe(original[0]); // copy, not shared
    expect(rowsModified(original, reverted)).toBe(false);
  });

  it('keeps the current position of a moved row', () => {
    const current = [original[1], updateRow(original, '1', { value: 'q' })[0], original[2], original[3]];
    const reverted = revertRow(original, current, '1');
    expect(ids(reverted)).toEqual(['2', '1', '3', '4']);
    expect(reverted[1].value).toBe('x');
  });

  it('removes an added row', () => {
    const current = [...original, row('9', 'new', 'v')];
    expect(ids(revertRow(original, current, '9'))).toEqual(['1', '2', '3', '4']);
  });

  it('re-inserts a deleted row at its original index', () => {
    const current = removeRow(original, '3');
    expect(ids(revertRow(original, current, '3'))).toEqual(['1', '2', '3', '4']);
    expect(ids(revertRow(original, removeRow(original, '1'), '1'))).toEqual(['1', '2', '3', '4']);
    expect(ids(revertRow(original, removeRow(original, '4'), '4'))).toEqual(['1', '2', '3', '4']);
  });

  it('re-inserts next to its original neighbours when earlier rows were removed or added', () => {
    const withoutFirstTwo = original.slice(2);
    expect(ids(revertRow(original, withoutFirstTwo, '2'))).toEqual(['2', '3', '4']);
    const prepended = [row('9', 'new', ''), original[0], original[1], original[3]];
    expect(ids(revertRow(original, prepended, '3'))).toEqual(['9', '1', '2', '3', '4']);
  });

  it('clamps the index when no original neighbour survives', () => {
    const current = [row('9', 'n', '')];
    expect(ids(revertRow(original, current, '4'))).toEqual(['9', '4']);
    expect(ids(revertRow(original, [], '3'))).toEqual(['3']);
  });

  it('returns the same array for an unknown id', () => {
    const current = cloneRows(original);
    expect(revertRow(original, current, 'nope')).toBe(current);
  });

  it('does not mutate its inputs', () => {
    const current = removeRow(original, '2');
    const snapshot = JSON.stringify([original, current]);
    revertRow(original, current, '2');
    revertRow(original, current, '1');
    expect(JSON.stringify([original, current])).toBe(snapshot);
  });
});

describe('updateRow / removeRow', () => {
  const rows = [row('1', 'a', '1'), row('2', 'b', '2')];

  it('updates immutably and keeps the id', () => {
    const next = updateRow(rows, '2', { value: 'x' });
    expect(next).not.toBe(rows);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toEqual(row('2', 'b', 'x'));
    expect(rows[1].value).toBe('2');
    const sneaky = updateRow(rows, '1', { id: 'other' } as Partial<KVRow>);
    expect(sneaky[0].id).toBe('1');
  });

  it('returns the same array when the id is missing', () => {
    expect(updateRow(rows, 'x', { value: '1' })).toBe(rows);
    expect(removeRow(rows, 'x')).toBe(rows);
  });

  it('removes by id', () => {
    expect(ids(removeRow(rows, '1'))).toEqual(['2']);
    expect(rows).toHaveLength(2);
  });
});

describe('parseBulk', () => {
  it('parses key=value lines, splitting at the first separator', () => {
    expect(parseBulk('a=1\nb=x=y\nflag\n c =  spaced ', '=')).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'x=y', enabled: true },
      { key: 'flag', value: '', enabled: true },
      { key: 'c', value: '  spaced ', enabled: true },
    ]);
  });

  it('parses header lines stripping one leading space of the value', () => {
    expect(parseBulk('Content-Type: application/json\nX-A:no-space\nX-B:   three\nAuth: Bearer a:b', ':')).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-A', value: 'no-space', enabled: true },
      { key: 'X-B', value: '  three', enabled: true },
      { key: 'Auth', value: 'Bearer a:b', enabled: true },
    ]);
  });

  it('ignores blank lines and handles CRLF / CR', () => {
    expect(parseBulk('\r\na=1\r\n\r\n   \r\nb=2\rc=3\n', '=')).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
      { key: 'c', value: '3', enabled: true },
    ]);
    expect(parseBulk('', '=')).toEqual([]);
  });

  it('turns # and // lines into disabled rows', () => {
    expect(parseBulk('# a=1\n#b=2\n// X-C: 3\n  # d: 4\n#\n//   ', ':')).toEqual([
      { key: 'a=1', value: '', enabled: false },
      { key: 'b=2', value: '', enabled: false },
      { key: 'X-C', value: '3', enabled: false },
      { key: 'd', value: '4', enabled: false },
    ]);
    expect(parseBulk('# a=1\n//b=2', '=')).toEqual([
      { key: 'a', value: '1', enabled: false },
      { key: 'b', value: '2', enabled: false },
    ]);
  });

  it('keeps empty keys and values', () => {
    expect(parseBulk('=value\nkey=', '=')).toEqual([
      { key: '', value: 'value', enabled: true },
      { key: 'key', value: '', enabled: true },
    ]);
  });

  it('keeps HTTP/2 pseudo-header names intact', () => {
    expect(parseBulk(':authority: example.com\n: odd', ':')).toEqual([
      { key: ':authority', value: 'example.com', enabled: true },
      { key: '', value: 'odd', enabled: true },
    ]);
  });

  it('handles unicode', () => {
    expect(parseBulk('名前=値 😀', '=')).toEqual([{ key: '名前', value: '値 😀', enabled: true }]);
  });
});

describe('toBulk', () => {
  it('emits one line per row, prefixing disabled rows with "# "', () => {
    const rows = [row('1', 'a', '1'), row('2', 'b', '2', false), row('3', '', ''), row('4', 'c', '')];
    expect(toBulk(rows, '=')).toBe('a=1\n# b=2\nc=');
    expect(toBulk(rows, ':')).toBe('a: 1\n# b: 2\nc: ');
    expect(toBulk([], ':')).toBe('');
  });

  it('round-trips through parseBulk', () => {
    const rows = [
      row('1', 'Accept', 'application/json'),
      row('2', 'X-Spaces', '  two leading'),
      row('3', 'X-Off', 'v', false),
      row('4', '', 'empty key'),
      row('5', 'X-Colon', 'a: b'),
    ];
    for (const sep of [':', '='] as const) {
      const parsed = parseBulk(toBulk(rows, sep), sep);
      expect(parsed).toEqual(rows.map(({ key, value, enabled }) => ({ key, value, enabled })));
    }
  });
});
