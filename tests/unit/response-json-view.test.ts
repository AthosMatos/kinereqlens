import { describe, expect, it } from 'vitest';
import type { JNode } from '../../src/shared/types';
import { parseJsonTree } from '../../src/lib/json-tree';
import {
  collectContainerIds,
  containerSummary,
  flattenJson,
  highlightSegments,
  leafText,
  scalarCopyText,
  searchJson,
} from '../../src/ui/response/json-view';
import type { JsonRow } from '../../src/ui/response/json-view';

const toDepth = (levels: number) => (_node: JNode, depth: number) => depth < levels;
const all = () => true;

/** Rows rendered as pretty-JSON-like lines, for readable assertions. */
function render(rows: JsonRow[]): string[] {
  return rows.map((r) => {
    const indent = '  '.repeat(r.depth);
    const label = r.label === undefined ? '' : typeof r.label === 'number' ? `${r.label}: ` : `${JSON.stringify(r.label)}: `;
    const comma = r.comma ? ',' : '';
    switch (r.kind) {
      case 'leaf':
        return `${indent}${label}${leafText(r.node)}${comma}`;
      case 'open':
        return `${indent}${label}${r.node.type === 'array' ? '[' : '{'}`;
      case 'close':
        return `${indent}${r.node.type === 'array' ? ']' : '}'}${comma}`;
      case 'collapsed': {
        const s = containerSummary(r.node);
        return `${indent}${label}${s.brackets} ${s.count}${comma}`;
      }
    }
  });
}

const SAMPLE = '{"a":1,"b":{"c":[1,2],"d":"x"},"e":[],"big":12345678901234567890,"n":null}';

describe('flattenJson', () => {
  it('expands two levels initially and summarizes collapsed containers', () => {
    const root = parseJsonTree(SAMPLE);
    const { rows, more } = flattenJson(root, { isExpanded: toDepth(2), limit: 100 });
    expect(more).toBe(false);
    expect(render(rows)).toEqual([
      '{',
      '  "a": 1,',
      '  "b": {',
      '    "c": […] 2 items,',
      '    "d": "x"',
      '  },',
      '  "e": [],',
      '  "big": 12345678901234567890,',
      '  "n": null',
      '}',
    ]);
  });

  it('records paths and parent rows', () => {
    const root = parseJsonTree(SAMPLE);
    const { rows } = flattenJson(root, { isExpanded: all, limit: 100 });
    const c1 = rows.find((r) => r.kind === 'leaf' && r.path.join('/') === 'b/c/1');
    expect(c1?.label).toBe(1);
    expect(c1?.comma).toBe(false);
    const parent = rows[c1!.parentIndex];
    expect(parent.kind).toBe('open');
    expect(parent.path).toEqual(['b', 'c']);
    expect(rows[0].parentIndex).toBe(-1);
  });

  it('stops at the limit and reports more', () => {
    const root = parseJsonTree(JSON.stringify(Array.from({ length: 50 }, (_, i) => i)));
    const { rows, more } = flattenJson(root, { isExpanded: all, limit: 10 });
    expect(rows).toHaveLength(10);
    expect(more).toBe(true);
    const full = flattenJson(root, { isExpanded: all, limit: 52 });
    expect(full.rows).toHaveLength(52);
    expect(full.more).toBe(false);
  });

  it('renders a scalar root as one leaf', () => {
    const { rows } = flattenJson(parseJsonTree('"hi"'), { isExpanded: all, limit: 10 });
    expect(render(rows)).toEqual(['"hi"']);
  });

  it('only-matches mode keeps matches, their ancestors and matching subtrees', () => {
    const root = parseJsonTree('{"user":{"name":"Ann","age":3},"tags":["x","name-tag"],"meta":{"name":{"first":"A"}},"z":1}');
    const search = searchJson(root, 'name');
    const { rows } = flattenJson(root, { isExpanded: () => false, limit: 100, restrictTo: search });
    expect(render(rows)).toEqual([
      '{',
      '  "user": {',
      '    "name": "Ann"',
      '  },',
      '  "tags": [',
      '    1: "name-tag"',
      '  ],',
      '  "meta": {',
      '    "name": {…} 1 key',
      '  }',
      '}',
    ]);
  });

  it('handles very deep nesting iteratively', () => {
    const depth = 10_000;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    const root = parseJsonTree(text);
    const { rows, more } = flattenJson(root, { isExpanded: all, limit: 500 });
    expect(rows).toHaveLength(500);
    expect(more).toBe(true);
    const search = searchJson(root, 'nothing');
    expect(search.matches.size).toBe(0);
  });
});

describe('searchJson', () => {
  it('matches keys and scalar values case-insensitively', () => {
    const root = parseJsonTree('{"Name":"x","list":[{"v":"Hello"}],"flag":true,"n":null,"num":42}');
    const byId = (path: Array<string | number>) => {
      let node: JNode = root;
      for (const seg of path) node = typeof seg === 'number' ? node.children![seg] : node.children!.find((c) => c.key === seg)!;
      return node.id;
    };
    const res = searchJson(root, 'hello');
    expect([...res.matches]).toEqual([byId(['list', 0, 'v'])]);
    expect(res.ancestors).toEqual(new Set([root.id, byId(['list']), byId(['list', 0])]));
    expect(searchJson(root, 'NAME').matches.has(byId(['Name']))).toBe(true);
    expect(searchJson(root, 'true').matches.has(byId(['flag']))).toBe(true);
    expect(searchJson(root, 'null').matches.has(byId(['n']))).toBe(true);
    expect(searchJson(root, '42').matches.has(byId(['num']))).toBe(true);
    expect(searchJson(root, '   ').matches.size).toBe(0);
  });
});

describe('display helpers', () => {
  it('highlightSegments', () => {
    expect(highlightSegments('Hello hello', 'LL')).toEqual([
      { text: 'He', match: false },
      { text: 'll', match: true },
      { text: 'o he', match: false },
      { text: 'll', match: true },
      { text: 'o', match: false },
    ]);
    expect(highlightSegments('abc', '')).toEqual([{ text: 'abc', match: false }]);
    expect(highlightSegments('abc', 'zz')).toEqual([{ text: 'abc', match: false }]);
  });

  it('leafText, scalarCopyText and summaries', () => {
    const root = parseJsonTree('{"s":"a\\"b\\n","n":1.50,"b":false,"z":null,"o":{},"a":[1,2,3]}');
    const [s, n, b, z, o, a] = root.children!;
    expect(leafText(s)).toBe('"a\\"b\\n"');
    expect(scalarCopyText(s)).toBe('a"b\n');
    expect(leafText(n)).toBe('1.50');
    expect(leafText(b)).toBe('false');
    expect(leafText(z)).toBe('null');
    expect(leafText(o)).toBe('{}');
    expect(containerSummary(a)).toEqual({ brackets: '[…]', count: '3 items' });
    expect(containerSummary(root)).toEqual({ brackets: '{…}', count: '6 keys' });
    expect(collectContainerIds(root)).toEqual(new Set([root.id, o.id, a.id]));
  });
});
