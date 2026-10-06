// Element locators, pure parts (src/lib/elementLocate.ts): the text-run buffer (blocks spaced, inline pieces joined,
// case / whitespace folding) and its hits, label matching, which match a command takes, value kinds and JSON paths.
import { describe, expect, it } from 'vitest';
import {
  buildRunBuffer,
  findRunHits,
  keyOfPath,
  labelMatches,
  normalizeQuery,
  parseValuePath,
  pickMatch,
  runsText,
  valueQueryOf,
  valueQueryOfNode,
} from '../../src/lib/elementLocate';
import { getNodeAtPath, parseJsonTree } from '../../src/lib/json-tree';

describe('text runs', () => {
  // <h1>Shared files</h1> <p>Latest upload: <b>quarterly</b>-report.pdf</p> <p>Save  changes</p>
  const runs = [
    { text: 'Shared files', spaced: true },
    { text: 'Latest upload:', spaced: true },
    { text: 'quarterly', spaced: true },
    { text: '-report.pdf', spaced: false },
    { text: 'Save changes', spaced: true },
  ];
  const buf = buildRunBuffer(runs);

  it('joins blocks with a space and inline pieces without one, case-folded', () => {
    expect(buf.text).toBe('shared files latest upload: quarterly-report.pdf save changes');
    expect(runsText(buf, 2, 3)).toBe('quarterly-report.pdf');
  });

  it('maps a hit to the runs it spans', () => {
    expect(findRunHits(buf, normalizeQuery('QUARTERLY-report'))).toEqual([{ first: 2, last: 3, start: 28, end: 44 }]);
    expect(findRunHits(buf, normalizeQuery('upload: quarterly'))).toEqual([{ first: 1, last: 2, start: 20, end: 37 }]);
    expect(findRunHits(buf, normalizeQuery('  save\\u00a0 CHANGES '.replace('\\u00a0', ' ')))).toEqual([{ first: 4, last: 4, start: 49, end: 61 }]);
    expect(findRunHits(buf, 'nothing here')).toEqual([]);
    expect(findRunHits(buf, '')).toEqual([]);
  });

  it('finds every occurrence (capped)', () => {
    const b = buildRunBuffer([
      { text: 'Save', spaced: true },
      { text: 'save', spaced: true },
      { text: 'Saved', spaced: true },
    ]);
    expect(findRunHits(b, 'save').map((h) => h.first)).toEqual([0, 1, 2]);
    expect(findRunHits(b, 'save', 2)).toHaveLength(2);
  });

  it('empty runs never hold a hit', () => {
    const b = buildRunBuffer([
      { text: 'abc', spaced: true },
      { text: '', spaced: true },
      { text: 'def', spaced: false },
    ]);
    expect(b.text).toBe('abcdef');
    expect(findRunHits(b, 'cd')).toEqual([{ first: 0, last: 2, start: 2, end: 4 }]);
    expect(findRunHits(b, 'def')).toEqual([{ first: 2, last: 2, start: 3, end: 6 }]);
  });

  it('labelMatches: contains by default, whole value with exact', () => {
    const q = normalizeQuery('Close');
    expect(labelMatches('Close dialog', q, false)).toBe(true);
    expect(labelMatches('Close dialog', q, true)).toBe(false);
    expect(labelMatches('  CLOSE ', q, true)).toBe(true);
    expect(labelMatches(null, q, false)).toBe(false);
    expect(labelMatches('', q, false)).toBe(false);
  });
});

describe('pickMatch', () => {
  const matches = [{ visible: false }, { visible: true }, { visible: true }];

  it('defaults to the first visible match', () => {
    expect(pickMatch(matches, 3)).toEqual({ index: 1 });
    expect(pickMatch([{ visible: false }], 1)).toEqual({ index: 0 });
  });

  it('takes `index` as given, with clear errors', () => {
    expect(pickMatch(matches, 3, 0)).toEqual({ index: 0 });
    expect(pickMatch(matches, 3, 2)).toEqual({ index: 2 });
    expect(pickMatch(matches, 3, 3)).toEqual({ error: 'Match #3 does not exist: 3 elements matched (indexes start at 0)' });
    expect(pickMatch(matches, 40, 5)).toEqual({ error: 'Match #5 is beyond the 3 matches listed — use a more specific locator' });
    expect(pickMatch(matches, 3, -1)).toEqual({ error: 'Invalid match index -1' });
    expect(pickMatch([], 0)).toEqual({ error: 'No element matches' });
  });
});

describe('values', () => {
  it('valueQueryOf: dates, number literals, text', () => {
    expect(valueQueryOf('2024-03-15T14:30:00Z')).toEqual({ kind: 'date', value: '2024-03-15T14:30:00Z' });
    expect(valueQueryOf(' 1258291 ')).toEqual({ kind: 'number', value: '1258291' });
    expect(valueQueryOf('-12.5')).toEqual({ kind: 'number', value: '-12.5' });
    expect(valueQueryOf('1.258.291')).toEqual({ kind: 'string', value: '1.258.291' });
    expect(valueQueryOf('quarterly-report-2024.pdf')).toEqual({ kind: 'string', value: 'quarterly-report-2024.pdf' });
  });

  it('parseValuePath reads the overlay\'s path format', () => {
    expect(parseValuePath('data.items[0].name')).toEqual(['data', 'items', 0, 'name']);
    expect(parseValuePath('[0].name')).toEqual([0, 'name']);
    expect(parseValuePath('$.a.b')).toEqual(['a', 'b']);
    expect(parseValuePath('a["weird.key"].b')).toEqual(['a', 'weird.key', 'b']);
    expect(parseValuePath("a['x']")).toEqual(['a', 'x']);
    expect(parseValuePath('items.0')).toEqual(['items', 0]);
    expect(parseValuePath('a["0"]')).toEqual(['a', '0']);
    expect(parseValuePath('')).toEqual([]);
    expect(parseValuePath('$')).toEqual([]);
    expect(parseValuePath('a[')).toBeNull();
    expect(parseValuePath('a..b')).toBeNull();
    expect(parseValuePath('a[x]')).toBeNull();
  });

  it('keyOfPath: the nearest object key (array items take their array\'s key)', () => {
    expect(keyOfPath(['files', 0, 'size'])).toBe('size');
    expect(keyOfPath(['sizes', 3])).toBe('sizes');
    expect(keyOfPath([0, 1])).toBeUndefined();
  });

  it('valueQueryOfNode: the kinds Find in page looks for, with the key hint', () => {
    const root = parseJsonTree('{"files":[{"name":"a.pdf","size":1258291,"at":"2024-03-15","ok":true,"none":null,"blank":"  ","tags":[]}]}');
    const at = (p: string) => {
      const path = parseValuePath(p)!;
      return valueQueryOfNode(getNodeAtPath(root, path)!, path);
    };
    expect(at('files[0].name')).toEqual({ kind: 'string', value: 'a.pdf', key: 'name' });
    expect(at('files[0].size')).toEqual({ kind: 'number', value: '1258291', key: 'size' });
    expect(at('files[0].at')).toEqual({ kind: 'date', value: '2024-03-15', key: 'at' });
    expect(at('files[0].ok')).toEqual({ error: 'That path holds a boolean: only strings, numbers and dates can be found on the page' });
    expect(at('files[0].none')).toEqual({ error: 'That path holds null: only strings, numbers and dates can be found on the page' });
    expect(at('files[0].blank')).toEqual({ error: 'That value is an empty string' });
    expect(at('files[0].tags')).toEqual({ error: 'That path holds an array: give the path of a single value' });
  });
});
