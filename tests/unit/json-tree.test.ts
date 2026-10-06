import { describe, expect, it } from 'vitest';
import type { JNode, JNodeType } from '../../src/shared/types';
import {
  JsonParseError,
  addChild,
  alignTreeIds,
  changeNodeType,
  cloneTree,
  countNodes,
  diffTrees,
  duplicateNode,
  findNode,
  formatPath,
  getNodeAtPath,
  isContainerNode,
  isTreeModified,
  isValidNumberLiteral,
  jsonTreeToValue,
  parseJsonTree,
  removeNode,
  revertNode,
  serializeJsonTree,
  treeErrors,
  tryParseJsonTree,
  updateNode,
  valueToJsonTree,
} from '../../src/lib/json-tree';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const parse = parseJsonTree;
const ser = serializeJsonTree;

/** Node at a path; fails the test when missing. */
function at(root: JNode, ...path: Array<string | number>): JNode {
  const node = getNodeAtPath(root, path);
  if (!node) throw new Error(`no node at ${formatPath(path)}`);
  return node;
}

const idAt = (root: JNode, ...path: Array<string | number>): string => at(root, ...path).id;

/** Iterative pre-order list of every node. */
function allNodes(root: JNode): JNode[] {
  const out: JNode[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop() as JNode;
    out.push(node);
    const children = isContainerNode(node) ? (node.children ?? []) : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

const allIds = (root: JNode): string[] => allNodes(root).map((n) => n.id);

/** Recursively freezes a tree (iteratively) so any in-place mutation throws in strict mode. */
function deepFreeze<T extends JNode>(root: T): T {
  for (const node of allNodes(root)) {
    if (node.children) Object.freeze(node.children);
    Object.freeze(node);
  }
  return root;
}

function parseError(text: string): JsonParseError {
  try {
    parseJsonTree(text);
  } catch (error) {
    expect(error).toBeInstanceOf(JsonParseError);
    return error as JsonParseError;
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail`);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

describe('parseJsonTree — structure', () => {
  it('parses every value type with keys, order and fresh unique ids', () => {
    const tree = parse('{"s":"x","n":1.50,"t":true,"f":false,"z":null,"o":{"k":[]},"a":[1,"2",{}]}');
    expect(tree.type).toBe('object');
    expect(tree.key).toBeUndefined();
    expect(tree.children?.map((c) => c.key)).toEqual(['s', 'n', 't', 'f', 'z', 'o', 'a']);
    expect(at(tree, 's')).toMatchObject({ type: 'string', value: 'x' });
    expect(at(tree, 'n')).toMatchObject({ type: 'number', value: '1.50' });
    expect(at(tree, 't')).toMatchObject({ type: 'boolean', value: true });
    expect(at(tree, 'f')).toMatchObject({ type: 'boolean', value: false });
    expect(at(tree, 'z').type).toBe('null');
    expect('value' in at(tree, 'z')).toBe(false);
    expect(at(tree, 'o', 'k')).toMatchObject({ type: 'array', children: [] });
    expect(at(tree, 'a').children?.map((c) => c.type)).toEqual(['number', 'string', 'object']);
    // array children carry no key property at all
    expect(at(tree, 'a').children?.every((c) => !('key' in c))).toBe(true);
    const ids = allIds(tree);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('assigns fresh ids on every parse', () => {
    const a = allIds(parse('[1,[2]]'));
    const b = allIds(parse('[1,[2]]'));
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('parses scalar roots', () => {
    expect(parse('"hi"')).toMatchObject({ type: 'string', value: 'hi' });
    expect(parse(' 42 ')).toMatchObject({ type: 'number', value: '42' });
    expect(parse('true')).toMatchObject({ type: 'boolean', value: true });
    expect(parse('null').type).toBe('null');
  });

  it('keeps number literal text verbatim', () => {
    const literals = ['12345678901234567890', '-0', '0', '1e-7', '1E+2', '1.0', '0.10', '-1.5e-300', '1e400', '123456789012345678901234567890.000000000000000000001'];
    const tree = parse(`[${literals.join(',')}]`);
    expect(tree.children?.map((c) => c.value)).toEqual(literals);
  });

  it('keeps duplicate keys in order', () => {
    const tree = parse('{"a":1,"b":2,"a":3}');
    expect(tree.children?.map((c) => [c.key, c.value])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['a', '3'],
    ]);
  });

  it('decodes every escape, including surrogate pairs and lone surrogates', () => {
    const tree = parse('["\\"\\\\\\/\\b\\f\\n\\r\\t", "\\u00e9\\u00E9", "\\ud83d\\ude00", "\\ud800", "café 😀", "\\u0000"]');
    expect(tree.children?.map((c) => c.value)).toEqual(['"\\/\b\f\n\r\t', 'éé', '😀', '\ud800', 'café 😀', '\u0000']);
  });

  it('accepts a leading BOM and surrounding JSON whitespace', () => {
    expect(ser(parse('﻿{"a":1}'))).toBe('{"a":1}');
    expect(ser(parse('﻿ \t\r\n [ 1 , 2 ] \n\t '))).toBe('[1,2]');
  });

  it('accepts DEL and non-ASCII characters inside strings', () => {
    expect(parse('"\u007f  "').value).toBe('\u007f  ');
  });

  it('coerces non-string input like JSON.parse does', () => {
    expect(parse(123 as unknown as string)).toMatchObject({ type: 'number', value: '123' });
  });
});

describe('parseJsonTree — errors', () => {
  const cases: Array<[input: string, message: string, offset: number, line: number, column: number]> = [
    ['', 'Unexpected end of JSON input at line 1, column 1', 0, 1, 1],
    ['   ', 'Unexpected end of JSON input at line 1, column 4', 3, 1, 4],
    ['﻿', 'Unexpected end of JSON input at line 1, column 2', 1, 1, 2],
    ['{', "Unexpected end of JSON input at line 1, column 2 (unclosed '{' at line 1, column 1)", 1, 1, 2],
    ['[1, [2', "Unexpected end of JSON input at line 1, column 7 (unclosed '[' at line 1, column 5)", 6, 1, 7],
    ['{"a":1,}', "Unexpected '}' at line 1, column 8 (trailing commas are not allowed)", 7, 1, 8],
    ['[1,2,]', "Unexpected ']' at line 1, column 6 (trailing commas are not allowed)", 5, 1, 6],
    ['{\n  "a": 1,\n  "b": 2,\n    }', "Unexpected '}' at line 4, column 5 (trailing commas are not allowed)", 26, 4, 5],
    ['[1,\r\n2,\r\n]', "Unexpected ']' at line 3, column 1 (trailing commas are not allowed)", 9, 3, 1],
    ['[1,\r]', "Unexpected ']' at line 2, column 1 (trailing commas are not allowed)", 4, 2, 1],
    ['[01]', 'Leading zeros are not allowed at line 1, column 2', 1, 1, 2],
    ['-01', 'Leading zeros are not allowed at line 1, column 2', 1, 1, 2],
    ['-', "Expected a digit after '-' at line 1, column 2", 1, 1, 2],
    ['-Infinity', "Expected a digit after '-' at line 1, column 2", 1, 1, 2],
    ['1.', 'Expected a digit after the decimal point at line 1, column 3', 2, 1, 3],
    ['1.e5', 'Expected a digit after the decimal point at line 1, column 3', 2, 1, 3],
    ['1e', 'Expected a digit in the exponent at line 1, column 3', 2, 1, 3],
    ['1e+', 'Expected a digit in the exponent at line 1, column 4', 3, 1, 4],
    ['.5', "Unexpected '.' at line 1, column 1 (expected a JSON value)", 0, 1, 1],
    ['+1', "Unexpected '+' at line 1, column 1 (expected a JSON value)", 0, 1, 1],
    ['NaN', "Unexpected 'N' at line 1, column 1 (NaN, Infinity and undefined are not valid JSON)", 0, 1, 1],
    ['[Infinity]', "Unexpected 'I' at line 1, column 2 (NaN, Infinity and undefined are not valid JSON)", 1, 1, 2],
    ['undefined', "Unexpected 'u' at line 1, column 1 (NaN, Infinity and undefined are not valid JSON)", 0, 1, 1],
    ['tru', 'Unexpected end of JSON input at line 1, column 4', 3, 1, 4],
    ['trux', "Unexpected 'x' at line 1, column 4", 3, 1, 4],
    ['True', "Unexpected 'T' at line 1, column 1 (expected a JSON value)", 0, 1, 1],
    ['nul', 'Unexpected end of JSON input at line 1, column 4', 3, 1, 4],
    ["{'a':1}", `Unexpected "'" at line 1, column 2 (property names must use double quotes)`, 1, 1, 2],
    ["['a']", `Unexpected "'" at line 1, column 2 (strings must use double quotes)`, 1, 1, 2],
    ['{a:1}', "Unexpected 'a' at line 1, column 2 (property names must be double-quoted)", 1, 1, 2],
    ['{1:1}', "Unexpected '1' at line 1, column 2 (expected a double-quoted property name)", 1, 1, 2],
    ['{"a" 1}', "Unexpected '1' at line 1, column 6 (expected ':' after the property name)", 5, 1, 6],
    ['{"a":}', "Unexpected '}' at line 1, column 6 (expected a JSON value)", 5, 1, 6],
    ['{"a":1 "b":2}', `Unexpected '"' at line 1, column 8 (expected ',' or '}')`, 7, 1, 8],
    ['[1 2]', "Unexpected '2' at line 1, column 4 (expected ',' or ']')", 3, 1, 4],
    ['[1}', "Unexpected '}' at line 1, column 3 (expected ',' or ']')", 2, 1, 3],
    ['[,1]', "Unexpected ',' at line 1, column 2 (expected a JSON value)", 1, 1, 2],
    ['{"a":1}}', "Unexpected '}' at line 1, column 8 (extra data after the JSON value)", 7, 1, 8],
    ['1 2', "Unexpected '2' at line 1, column 3 (extra data after the JSON value)", 2, 1, 3],
    ['[1] // c', "Unexpected '/' at line 1, column 5 (comments are not allowed in JSON)", 4, 1, 5],
    ['/* x */ 1', "Unexpected '/' at line 1, column 1 (comments are not allowed in JSON)", 0, 1, 1],
    ['{"a":1,/*x*/"b":2}', "Unexpected '/' at line 1, column 8 (comments are not allowed in JSON)", 7, 1, 8],
    ['"a\nb"', 'Unescaped control character U+000A in string at line 1, column 3', 2, 1, 3],
    ['"a\tb"', 'Unescaped control character U+0009 in string at line 1, column 3', 2, 1, 3],
    ['"\u0000"', 'Unescaped control character U+0000 in string at line 1, column 2', 1, 1, 2],
    ['"\\x"', "Invalid escape '\\x' in string at line 1, column 2", 1, 1, 2],
    ["'\\'", `Unexpected "'" at line 1, column 1 (strings must use double quotes)`, 0, 1, 1],
    ['"\\u12g4"', 'Invalid Unicode escape at line 1, column 2', 1, 1, 2],
    ['"\\u12"', 'Invalid Unicode escape at line 1, column 2', 1, 1, 2],
    ['"abc', 'Unterminated string at line 1, column 1', 0, 1, 1],
    ['["ok", "abc\\', 'Unterminated string at line 1, column 8', 7, 1, 8],
    ['[ ]', 'Unexpected character U+00A0 at line 1, column 2 (expected a JSON value)', 1, 1, 2],
    [' ﻿1', 'Unexpected character U+FEFF at line 1, column 2 (expected a JSON value)', 1, 1, 2],
    ['["😀" x]', "Unexpected 'x' at line 1, column 7 (expected ',' or ']')", 6, 1, 7],
    ['{"a":[1,{"b":2]}', "Unexpected ']' at line 1, column 15 (expected ',' or '}')", 14, 1, 15],
  ];

  it.each(cases)('rejects %j', (input, message, offset, line, column) => {
    const error = parseError(input);
    expect(error.message).toBe(message);
    expect(error.name).toBe('JsonParseError');
    expect({ offset: error.offset, line: error.line, column: error.column }).toEqual({ offset, line, column });
  });

  it('tryParseJsonTree returns null instead of throwing', () => {
    expect(tryParseJsonTree('{')).toBeNull();
    expect(tryParseJsonTree('[1]')?.type).toBe('array');
  });
});

describe('parseJsonTree — strictness parity with JSON.parse (fuzz)', () => {
  const seeds = [
    '{"a":[1,2.5,-3e2,{"b":null,"c":true}],"d":"x\\ny","e":{},"f":[]}',
    '[0,-0,1e5,"\\u00e9",false,null,{"k":"v"}]',
    '{"nested":{"deep":{"deeper":[[[1]]]}},"s":"a\\"b"}',
    '"just a string"',
    '12.5e-3',
  ];
  const alphabet = '{}[],:"\\ \t\n0123456789.eE+-truefalsn\'/axé\u0001';

  it('accepts exactly what JSON.parse accepts and yields the same value', () => {
    const random = rng(1234);
    let accepted = 0;
    for (let n = 0; n < 4000; n++) {
      let text = pick(random, seeds);
      const edits = 1 + Math.floor(random() * 3);
      for (let e = 0; e < edits; e++) {
        const pos = Math.floor(random() * (text.length + 1));
        const op = random();
        const ch = pick(random, [...alphabet]);
        if (op < 0.33) text = text.slice(0, pos) + ch + text.slice(pos);
        else if (op < 0.66) text = text.slice(0, pos) + text.slice(pos + 1);
        else text = text.slice(0, pos) + ch + text.slice(pos + 1);
      }
      let expected: unknown;
      let nativeOk = true;
      try {
        expected = JSON.parse(text);
      } catch {
        nativeOk = false;
      }
      const tree = tryParseJsonTree(text);
      expect(tree !== null, `input ${JSON.stringify(text)}`).toBe(nativeOk);
      if (tree) {
        accepted++;
        expect(JSON.stringify(jsonTreeToValue(tree))).toBe(JSON.stringify(expected));
        expect(JSON.stringify(JSON.parse(ser(tree)))).toBe(JSON.stringify(expected));
      }
    }
    expect(accepted).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

describe('serializeJsonTree', () => {
  const samples = [
    '{"a":[1,2,{"b":null}],"c":"x","d":{"e":{"f":[true,false]}},"g":[],"h":{}}',
    '[[],[[]],{},[{}],"",0]',
    '{"":"empty key","with space":1,"quote\\"key":"v","unicodeé":"😀"}',
    '"top"',
    '[]',
    '{}',
    '-12.5',
  ];

  it.each(samples)('compact output equals JSON.stringify(JSON.parse(x)) for %j', (text) => {
    expect(ser(parse(text))).toBe(JSON.stringify(JSON.parse(text)));
  });

  it.each(samples)('indented output matches JSON.stringify(v, null, indent) for %j', (text) => {
    const tree = parse(text);
    const value = JSON.parse(text);
    expect(ser(tree, 2)).toBe(JSON.stringify(value, null, 2));
    expect(ser(tree, 4)).toBe(JSON.stringify(value, null, 4));
    expect(ser(tree, '\t')).toBe(JSON.stringify(value, null, '\t'));
    expect(ser(tree, '--')).toBe(JSON.stringify(value, null, '--'));
  });

  it('treats undefined, 0, negative numbers and "" as compact', () => {
    const tree = parse('{"a":[1]}');
    for (const indent of [undefined, 0, 0.5, -2, '', Number.NaN]) expect(ser(tree, indent)).toBe('{"a":[1]}');
  });

  it('derives the indent unit exactly like JSON.stringify (fractions floored, capped at 10)', () => {
    const tree = parse('{"a":[1,{"b":null}]}');
    const value = JSON.parse('{"a":[1,{"b":null}]}');
    for (const indent of [1, 2.9, 10, 11, 1000, Number.POSITIVE_INFINITY, ' ', 'abcdefghijklmnop']) {
      expect(ser(tree, indent)).toBe(JSON.stringify(value, null, indent));
    }
  });

  it('round-trips to the minified input, keeping number literals verbatim', () => {
    const pretty = `{
      "big": 12345678901234567890,
      "negZero": -0,
      "tiny": 1e-7,
      "upper": 1E+2,
      "float": 1.0,
      "list": [ 0.10 , -1.5e-300 ],
      "nested": { "dup": 1, "dup": 2 }
    }`;
    const minified = '{"big":12345678901234567890,"negZero":-0,"tiny":1e-7,"upper":1E+2,"float":1.0,"list":[0.10,-1.5e-300],"nested":{"dup":1,"dup":2}}';
    expect(ser(parse(pretty))).toBe(minified);
    expect(ser(parse(minified))).toBe(minified);
    expect(ser(parse(ser(parse(pretty), 2)))).toBe(minified);
  });

  it('escapes strings exactly like JSON.stringify (controls, quotes, lone surrogates, U+2028)', () => {
    let all = '';
    for (let c = 0; c < 0x80; c++) all += String.fromCharCode(c);
    all += '  \ud800 \udfff 😀 é';
    const node: JNode = { id: 'x', type: 'string', value: all };
    expect(ser(node)).toBe(JSON.stringify(all));
    expect(parse(ser(node)).value).toBe(all);
    expect(ser(parse('"\\u00e9\\ud83d\\ude00\\u001f\\/"'))).toBe('"é😀\\u001f/"');
  });

  it('escapes keys', () => {
    const tree: JNode = { id: 'r', type: 'object', children: [{ id: 'c', type: 'null', key: 'a"\n\\b' }] };
    expect(ser(tree)).toBe('{"a\\"\\n\\\\b":null}');
  });

  it('emits invalid number literals as-is and tolerates sloppy nodes', () => {
    const tree: JNode = {
      id: 'r',
      type: 'object',
      children: [
        { id: '1', type: 'number', key: 'n', value: '1.2.3' },
        { id: '2', type: 'object', key: 'o' },
        { id: '3', type: 'array', key: 'a' },
        { id: '4', type: 'string' },
        { id: '5', type: 'null', key: 'z', value: 'ignored', children: [{ id: '6', type: 'null' }] },
      ],
    };
    expect(ser(tree)).toBe('{"n":1.2.3,"o":{},"a":[],"":"","z":null}');
  });

  it('serializes array children without keys even if a key is present', () => {
    const tree: JNode = { id: 'r', type: 'array', children: [{ id: 'c', type: 'boolean', key: 'stray', value: true }] };
    expect(ser(tree)).toBe('[true]');
  });
});

// ---------------------------------------------------------------------------------------------
// Deep nesting / performance
// ---------------------------------------------------------------------------------------------

describe('depth safety', () => {
  const DEPTH = 100_000;

  it('parses, serializes and walks 100k nested arrays without overflowing', () => {
    const text = '['.repeat(DEPTH) + '1' + ']'.repeat(DEPTH);
    const tree = parse(text);
    expect(ser(tree)).toBe(text);
    expect(countNodes(tree)).toBe(DEPTH);
    const leafPath = new Array<number>(DEPTH).fill(0);
    const leaf = at(tree, ...leafPath);
    expect(leaf).toMatchObject({ type: 'number', value: '1' });

    const location = findNode(tree, leaf.id);
    expect(location?.path.length).toBe(DEPTH);

    const original = cloneTree(tree, true);
    const edited = updateNode(tree, leaf.id, { value: '2' });
    expect(ser(edited)).toBe('['.repeat(DEPTH) + '2' + ']'.repeat(DEPTH));
    const diff = diffTrees(original, edited);
    expect(diff.changed).toEqual(new Set([leaf.id]));
    expect(diff.dirty.size).toBe(DEPTH + 1);
    expect(isTreeModified(original, edited)).toBe(true);
    const reverted = revertNode(original, edited, leaf.id);
    expect(isTreeModified(original, reverted)).toBe(false);

    const aligned = alignTreeIds(parse(text), original);
    expect(isTreeModified(original, aligned)).toBe(false);
    expect(treeErrors(tree).size).toBe(0);

    let value = jsonTreeToValue(tree);
    for (let i = 0; i < DEPTH; i++) value = (value as unknown[])[0];
    expect(value).toBe(1);
  });

  it('handles 100k nested objects', () => {
    const text = '{"a":'.repeat(DEPTH) + 'null' + '}'.repeat(DEPTH);
    const tree = parse(text);
    expect(ser(tree)).toBe(text);
    const rebuilt = valueToJsonTree(jsonTreeToValue(tree));
    expect(ser(rebuilt)).toBe(text);
  });

  it('pretty-prints moderately deep documents like JSON.stringify', () => {
    const text = '[{"k":'.repeat(500) + '0' + '}]'.repeat(500);
    expect(ser(parse(text), 2)).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });
});

describe('performance', () => {
  it('parses and serializes a 5 MB document in under 1.5 s', () => {
    const items: unknown[] = [];
    let size = 0;
    for (let i = 0; size < 5 * 1024 * 1024; i++) {
      const item = {
        id: i,
        uuid: `5f1c${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-0123456789ab`,
        name: `User número ${i} 😀`,
        email: `user${i}@example.com`,
        active: i % 3 === 0,
        score: i * 1.25 - 7,
        ratio: 1 / (i + 3),
        tags: ['alpha', 'beta', 'gamma "quoted"', 'line\nbreak'],
        address: { street: `${i} Main St`, city: 'Springfield', geo: { lat: 37.774929 + i / 1e6, lng: -122.419416 } },
        note: null,
      };
      items.push(item);
      size += JSON.stringify(item).length + 1;
    }
    const text = JSON.stringify(items);
    expect(text.length).toBeGreaterThanOrEqual(5 * 1024 * 1024);

    const started = performance.now();
    const tree = parse(text);
    const out = ser(tree);
    const elapsed = performance.now() - started;

    expect(out).toBe(text);
    expect(elapsed).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

describe('jsonTreeToValue / valueToJsonTree / cloneTree', () => {
  it('converts to plain values (last duplicate wins, __proto__ stays an own property)', () => {
    const text = '{"a":1,"b":[true,null,"x",{"c":-0}],"a":3,"__proto__":{"polluted":1},"big":12345678901234567890}';
    const value = jsonTreeToValue(parse(text)) as Record<string, unknown>;
    expect(JSON.stringify(value)).toBe(JSON.stringify(JSON.parse(text)));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.is(((value.b as unknown[])[3] as { c: number }).c, -0)).toBe(true);
    expect(value.big).toBe(12345678901234567890);
  });

  it('builds trees from JS values', () => {
    const tree = valueToJsonTree({
      s: 'x',
      n: 1.5,
      i: 10n ** 20n,
      b: false,
      z: null,
      u: undefined,
      fn: () => 1,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      d: new Date(0),
      boxed: new String('boxed'),
      arr: [1, undefined, [2]],
    });
    expect(ser(tree)).toBe(
      '{"s":"x","n":1.5,"i":100000000000000000000,"b":false,"z":null,"u":null,"fn":null,"nan":null,"inf":null,"d":"1970-01-01T00:00:00.000Z","boxed":"boxed","arr":[1,null,[2]]}',
    );
    expect(valueToJsonTree('v', 'k')).toMatchObject({ type: 'string', key: 'k', value: 'v' });
    expect(valueToJsonTree(undefined).type).toBe('null');
  });

  it('turns circular references into null but keeps shared (non-circular) references', () => {
    const shared = { k: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, shared];
    expect(ser(valueToJsonTree(cyclic))).toBe('{"shared":{"k":1},"again":{"k":1},"self":null,"list":[null,{"k":1}]}');
  });

  it('round-trips plain values', () => {
    const value = { a: [1, 'two', { three: [null, true] }], '': {}, 'weird key': -2.5e-8 };
    expect(jsonTreeToValue(valueToJsonTree(value))).toEqual(value);
  });

  it('clones deeply with fresh ids by default, or the same ids', () => {
    const tree = deepFreeze(parse('{"a":[1,{"b":"c"}]}'));
    const fresh = cloneTree(tree);
    const same = cloneTree(tree, true);
    expect(ser(fresh)).toBe(ser(tree));
    expect(allIds(fresh).some((id) => allIds(tree).includes(id))).toBe(false);
    expect(allIds(same)).toEqual(allIds(tree));
    const originals = new Set(allNodes(tree));
    expect(allNodes(same).some((n) => originals.has(n))).toBe(false);
    expect(isTreeModified(tree, same)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Paths / lookup
// ---------------------------------------------------------------------------------------------

describe('formatPath / findNode / getNodeAtPath', () => {
  it.each<[Array<string | number>, string]>([
    [[], ''],
    [['user', 'name'], 'user.name'],
    [['tags', 0], 'tags[0]'],
    [['a.b'], '["a.b"]'],
    [[0, 'x'], '[0].x'],
    [['a', 'weird.key'], 'a["weird.key"]'],
    [['$el', '_x1', 'with space', 'q"uote', ''], '$el._x1["with space"]["q\\"uote"][""]'],
    [['0'], '["0"]'],
    [['1abc', 2, 3], '["1abc"][2][3]'],
    [['ünïcode'], '["ünïcode"]'],
  ])('formats %j as %j', (path, expected) => {
    expect(formatPath(path)).toBe(expected);
  });

  it('finds nodes with parent, index and path', () => {
    const tree = parse('{"user":{"tags":["x",{"deep":1}]},"dup":1,"dup":2}');
    const deep = at(tree, 'user', 'tags', 1, 'deep');
    const location = findNode(tree, deep.id);
    expect(location?.node).toBe(deep);
    expect(location?.parent).toBe(at(tree, 'user', 'tags', 1));
    expect(location?.index).toBe(0);
    expect(location?.path).toEqual(['user', 'tags', 1, 'deep']);
    expect(formatPath(location?.path ?? [])).toBe('user.tags[1].deep');

    const secondDup = tree.children?.[2] as JNode;
    expect(findNode(tree, secondDup.id)).toMatchObject({ index: 2, path: ['dup'] });
    expect(findNode(tree, tree.id)).toEqual({ node: tree, parent: null, index: -1, path: [] });
    expect(findNode(tree, 'missing')).toBeNull();
  });

  it('resolves paths (first duplicate wins, lenient segment types)', () => {
    const tree = parse('{"a":[10,20],"a":"second","0":{"x":true}}');
    expect(at(tree, 'a', 1).value).toBe('20');
    expect(at(tree, 'a', '1').value).toBe('20');
    expect(at(tree, 0, 'x').value).toBe(true);
    expect(getNodeAtPath(tree, [])).toBe(tree);
    expect(getNodeAtPath(tree, ['a', 2])).toBeNull();
    expect(getNodeAtPath(tree, ['a', -1])).toBeNull();
    expect(getNodeAtPath(tree, ['a', 'x'])).toBeNull();
    expect(getNodeAtPath(tree, ['a', '01'])).toBeNull();
    expect(getNodeAtPath(tree, ['a', 0, 'deeper'])).toBeNull();
    expect(getNodeAtPath(tree, ['nope'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------------------------

const SAMPLE = '{"a":{"x":1,"y":[1,2]},"b":{"z":true},"c":[{"k":"v"}],"s":"text"}';

/**
 * Asserts that `next` copied exactly the root -> target path of `prev` (same ids, new objects) and that
 * every sibling subtree off that path kept its object identity.
 */
function expectPathCopied(prev: JNode, next: JNode, path: Array<string | number>): void {
  for (let depth = 0; depth <= path.length; depth++) {
    const prefix = path.slice(0, depth);
    const prevNode = at(prev, ...prefix);
    const nextNode = at(next, ...prefix);
    expect(nextNode).not.toBe(prevNode);
    expect(nextNode.id).toBe(prevNode.id);
    if (depth === path.length) break;
    const step = path[depth];
    (prevNode.children ?? []).forEach((child, i) => {
      const onPath = prevNode.type === 'object' ? child.key === step : i === step;
      if (!onPath) expect(nextNode.children?.[i]).toBe(child);
    });
  }
}

describe('updateNode', () => {
  it('updates values immutably with structural sharing and stable ids', () => {
    const tree = deepFreeze(parse(SAMPLE));
    const x = at(tree, 'a', 'x');
    const next = updateNode(tree, x.id, { value: '2' });
    expect(ser(next)).toBe('{"a":{"x":2,"y":[1,2]},"b":{"z":true},"c":[{"k":"v"}],"s":"text"}');
    expect(ser(tree)).toBe(SAMPLE);
    expectPathCopied(tree, next, ['a', 'x']);
    expect(at(next, 'a', 'y')).toBe(at(tree, 'a', 'y'));
    expect(at(next, 'b')).toBe(at(tree, 'b'));
    expect(at(next, 'c')).toBe(at(tree, 'c'));
    expect(at(next, 's')).toBe(at(tree, 's'));
    expect(allIds(next)).toEqual(allIds(tree));
  });

  it('renames keys of object children only', () => {
    const tree = deepFreeze(parse(SAMPLE));
    const renamed = updateNode(tree, idAt(tree, 'b'), { key: 'renamed' });
    expect(ser(renamed)).toBe('{"a":{"x":1,"y":[1,2]},"renamed":{"z":true},"c":[{"k":"v"}],"s":"text"}');
    expect(at(renamed, 'renamed', 'z')).toBe(at(tree, 'b', 'z'));
    // array items and the root have no key to rename
    expect(updateNode(tree, idAt(tree, 'c', 0), { key: 'nope' })).toBe(tree);
    expect(updateNode(tree, tree.id, { key: 'nope' })).toBe(tree);
  });

  it('updates key and value together, and returns the same root for no-ops', () => {
    const tree = deepFreeze(parse(SAMPLE));
    const s = at(tree, 's');
    expect(ser(updateNode(tree, s.id, { key: 't', value: 'new' }))).toContain('"t":"new"');
    expect(updateNode(tree, s.id, { value: 'text' })).toBe(tree);
    expect(updateNode(tree, s.id, { key: 's' })).toBe(tree);
    expect(updateNode(tree, s.id, {})).toBe(tree);
    expect(updateNode(tree, 'missing', { value: 'x' })).toBe(tree);
  });

  it('coerces mismatched values and ignores values for null/containers', () => {
    const tree = parse('{"b":false,"s":"","n":1,"z":null,"o":{}}');
    expect(at(updateNode(tree, idAt(tree, 'b'), { value: true }), 'b').value).toBe(true);
    expect(at(updateNode(tree, idAt(tree, 'b'), { value: 'TRUE' }), 'b').value).toBe(true);
    expect(at(updateNode(tree, idAt(tree, 's'), { value: true }), 's').value).toBe('true');
    expect(at(updateNode(tree, idAt(tree, 'n'), { value: 'abc' }), 'n').value).toBe('abc');
    expect(updateNode(tree, idAt(tree, 'z'), { value: 'x' })).toBe(tree);
    expect(updateNode(tree, idAt(tree, 'o'), { value: 'x' })).toBe(tree);
  });
});

describe('changeNodeType', () => {
  const tree = deepFreeze(parse('{"s":"42","s2":" 7 ","bad":"abc","n":12345678901234567890,"z0":0.000,"t":true,"f":false,"nul":null,"o":{"a":1,"b":[2]},"arr":["x",{"y":1}],"e":[]}'));
  const convert = (key: string, type: JNodeType): JNode => at(changeNodeType(tree, idAt(tree, key), type), key);

  it('string -> number keeps valid literals, else "0"', () => {
    expect(convert('s', 'number')).toMatchObject({ type: 'number', value: '42' });
    expect(convert('s2', 'number').value).toBe('7');
    expect(convert('bad', 'number').value).toBe('0');
  });

  it('number -> string keeps the literal text', () => {
    expect(convert('n', 'string')).toMatchObject({ type: 'string', value: '12345678901234567890' });
  });

  it('any -> boolean', () => {
    expect(convert('n', 'boolean').value).toBe(true);
    expect(convert('z0', 'boolean').value).toBe(false);
    expect(convert('s', 'boolean').value).toBe(true);
    expect(convert('bad', 'boolean').value).toBe(false);
    expect(convert('nul', 'boolean').value).toBe(false);
    expect(convert('o', 'boolean').value).toBe(true);
    expect(convert('e', 'boolean').value).toBe(false);
    const t = parse('["true"," TRUE ","0","-0.0e5","false"]');
    expect(t.children?.map((c) => at(changeNodeType(t, c.id, 'boolean'), t.children?.indexOf(c) ?? 0).value)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('boolean/null/container -> string and number', () => {
    expect(convert('t', 'string').value).toBe('true');
    expect(convert('f', 'number').value).toBe('0');
    expect(convert('t', 'number').value).toBe('1');
    expect(convert('nul', 'string').value).toBe('');
    expect(convert('nul', 'number').value).toBe('0');
    expect(convert('o', 'string').value).toBe('{"a":1,"b":[2]}');
    expect(convert('arr', 'number').value).toBe('0');
  });

  it('scalar -> object/array gives an empty container; any -> null drops value and children', () => {
    expect(convert('s', 'object')).toEqual({ id: idAt(tree, 's'), type: 'object', key: 's', children: [] });
    expect(convert('t', 'array')).toEqual({ id: idAt(tree, 't'), type: 'array', key: 't', children: [] });
    expect(convert('o', 'null')).toEqual({ id: idAt(tree, 'o'), type: 'null', key: 'o' });
    expect(convert('s', 'null')).toEqual({ id: idAt(tree, 's'), type: 'null', key: 's' });
  });

  it('object -> array keeps children (and their ids) but drops keys', () => {
    const next = changeNodeType(tree, idAt(tree, 'o'), 'array');
    const o = at(next, 'o');
    expect(o.type).toBe('array');
    expect(o.children?.map((c) => c.id)).toEqual(at(tree, 'o').children?.map((c) => c.id));
    expect(o.children?.every((c) => !('key' in c))).toBe(true);
    expect(at(next, 'o', 1).children).toBe(at(tree, 'o', 'b').children);
    expect(ser(o)).toBe('[1,[2]]');
  });

  it('array -> object assigns keys "0", "1", ...', () => {
    const next = changeNodeType(tree, idAt(tree, 'arr'), 'object');
    expect(ser(at(next, 'arr'))).toBe('{"0":"x","1":{"y":1}}');
    expect(at(next, 'arr', '1', 'y')).toBe(at(tree, 'arr', 1, 'y'));
  });

  it('is a no-op for the same type or unknown ids, and shares untouched subtrees', () => {
    expect(changeNodeType(tree, idAt(tree, 's'), 'string')).toBe(tree);
    expect(changeNodeType(tree, 'missing', 'null')).toBe(tree);
    expect(changeNodeType(tree, idAt(tree, 's'), 'bogus' as JNodeType)).toBe(tree);
    const next = changeNodeType(tree, idAt(tree, 's'), 'number');
    expect(at(next, 'o')).toBe(at(tree, 'o'));
    expect(changeNodeType(tree, tree.id, 'array').type).toBe('array');
  });
});

describe('removeNode', () => {
  it('removes object members and array items immutably', () => {
    const tree = deepFreeze(parse(SAMPLE));
    const next = removeNode(tree, idAt(tree, 'a', 'y', 0));
    expect(ser(next)).toBe('{"a":{"x":1,"y":[2]},"b":{"z":true},"c":[{"k":"v"}],"s":"text"}');
    expect(at(next, 'a', 'x')).toBe(at(tree, 'a', 'x'));
    expect(at(next, 'b')).toBe(at(tree, 'b'));
    expect(ser(removeNode(tree, idAt(tree, 'b')))).toBe('{"a":{"x":1,"y":[1,2]},"c":[{"k":"v"}],"s":"text"}');
  });

  it('cannot remove the root; unknown ids are no-ops', () => {
    const tree = parse('[1]');
    expect(removeNode(tree, tree.id)).toBe(tree);
    expect(removeNode(tree, 'missing')).toBe(tree);
  });
});

describe('addChild', () => {
  it('appends with unique generated keys and string default', () => {
    const tree = deepFreeze(parse('{"newKey":1}'));
    const first = addChild(tree, tree.id);
    expect(at(first.root, 'newKey2')).toMatchObject({ id: first.id, type: 'string', value: '' });
    const second = addChild(first.root, tree.id);
    expect(second.root.children?.map((c) => c.key)).toEqual(['newKey', 'newKey2', 'newKey3']);
    const empty = parse('{}');
    expect(addChild(empty, empty.id).root.children?.[0].key).toBe('newKey');
    expect(at(second.root, 'newKey')).toBe(at(tree, 'newKey'));
  });

  it('uses the given key (even a duplicate), type defaults and index', () => {
    const tree = parse('{"a":1,"b":2}');
    const r1 = addChild(tree, tree.id, { key: 'a', type: 'number', index: 1 });
    expect(ser(r1.root)).toBe('{"a":1,"a":0,"b":2}');
    expect(ser(addChild(tree, tree.id, { key: 'o', type: 'object', index: 0 }).root)).toBe('{"o":{},"a":1,"b":2}');
    expect(ser(addChild(tree, tree.id, { key: 'l', type: 'array', index: 99 }).root)).toBe('{"a":1,"b":2,"l":[]}');
    expect(ser(addChild(tree, tree.id, { key: 'f', type: 'boolean', index: -5 }).root)).toBe('{"f":false,"a":1,"b":2}');
    expect(ser(addChild(tree, tree.id, { key: 'z', type: 'null', index: Number.NaN }).root)).toBe('{"a":1,"b":2,"z":null}');
    expect(ser(addChild(tree, tree.id, { key: '' }).root)).toBe('{"a":1,"b":2,"":""}');
  });

  it('adds array items without keys', () => {
    const tree = parse('{"list":[1,2]}');
    const list = at(tree, 'list');
    const { root, id } = addChild(tree, list.id, { type: 'number', index: 1, key: 'ignored' });
    expect(ser(root)).toBe('{"list":[1,0,2]}');
    expect('key' in (findNode(root, id)?.node ?? {})).toBe(false);
    expect(findNode(root, id)?.path).toEqual(['list', 1]);
  });

  it('refuses scalar parents and unknown ids', () => {
    const tree = parse('{"s":"x"}');
    expect(addChild(tree, idAt(tree, 's'))).toEqual({ root: tree, id: '' });
    expect(addChild(tree, 'missing')).toEqual({ root: tree, id: '' });
  });
});

describe('duplicateNode', () => {
  it('duplicates object members right after themselves with fresh ids and "<key> copy"', () => {
    const tree = deepFreeze(parse('{"a":{"x":[1]},"b":2}'));
    const first = duplicateNode(tree, idAt(tree, 'a'));
    expect(ser(first.root)).toBe('{"a":{"x":[1]},"a copy":{"x":[1]},"b":2}');
    const copy = at(first.root, 'a copy');
    expect(copy.id).toBe(first.id);
    const copyIds = allIds(copy);
    expect(copyIds.some((id) => allIds(tree).includes(id))).toBe(false);
    const second = duplicateNode(first.root, idAt(first.root, 'a'));
    expect(second.root.children?.map((c) => c.key)).toEqual(['a', 'a copy 2', 'a copy', 'b']);
    expect(at(second.root, 'b')).toBe(at(tree, 'b'));
  });

  it('duplicates array items without keys', () => {
    const tree = parse('[{"k":1},2]');
    const { root, id } = duplicateNode(tree, idAt(tree, 0));
    expect(ser(root)).toBe('[{"k":1},{"k":1},2]');
    expect(findNode(root, id)?.index).toBe(1);
    expect('key' in at(root, 1)).toBe(false);
  });

  it('cannot duplicate the root; unknown ids are no-ops', () => {
    const tree = parse('{}');
    expect(duplicateNode(tree, tree.id)).toEqual({ root: tree, id: '' });
    expect(duplicateNode(tree, 'missing')).toEqual({ root: tree, id: '' });
  });
});

// ---------------------------------------------------------------------------------------------
// Diff / revert
// ---------------------------------------------------------------------------------------------

const setOf = (...ids: string[]): Set<string> => new Set(ids);

describe('diffTrees / isTreeModified', () => {
  const original = deepFreeze(parse('{"user":{"name":"Ann","age":30},"tags":["a","b","c"],"flag":true}'));
  const ids = {
    root: original.id,
    user: idAt(original, 'user'),
    name: idAt(original, 'user', 'name'),
    age: idAt(original, 'user', 'age'),
    tags: idAt(original, 'tags'),
    a: idAt(original, 'tags', 0),
    b: idAt(original, 'tags', 1),
    c: idAt(original, 'tags', 2),
    flag: idAt(original, 'flag'),
  };

  it('reports nothing for identical trees (including equal clones)', () => {
    for (const current of [original, cloneTree(original, true)]) {
      const diff = diffTrees(original, current);
      expect(diff.changed.size + diff.added.size + diff.removed.size + diff.dirty.size).toBe(0);
      expect(isTreeModified(original, current)).toBe(false);
    }
  });

  it('marks a changed value and its ancestors', () => {
    const current = updateNode(original, ids.name, { value: 'Bob' });
    const diff = diffTrees(original, current);
    expect(diff.changed).toEqual(setOf(ids.name));
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    expect(diff.dirty).toEqual(setOf(ids.name, ids.user, ids.root));
    expect(isTreeModified(original, current)).toBe(true);
  });

  it('treats a number literal rewrite as a change (1.0 vs 1)', () => {
    const t = deepFreeze(parse('[1.0]'));
    expect(diffTrees(t, updateNode(t, idAt(t, 0), { value: '1' })).changed).toEqual(setOf(idAt(t, 0)));
  });

  it('marks key renames and type changes as changed', () => {
    const renamed = updateNode(original, ids.age, { key: 'years' });
    expect(diffTrees(original, renamed).changed).toEqual(setOf(ids.age));
    const retyped = changeNodeType(original, ids.flag, 'string');
    const diff = diffTrees(original, retyped);
    expect(diff.changed).toEqual(setOf(ids.flag));
    expect(diff.dirty).toEqual(setOf(ids.flag, ids.root));
  });

  it('reports added nodes (with descendants) and dirty ancestors', () => {
    const { root: withObj, id: objId } = addChild(original, ids.user, { key: 'address', type: 'object' });
    const { root: current, id: leafId } = addChild(withObj, objId, { key: 'city' });
    const diff = diffTrees(original, current);
    expect(diff.added).toEqual(setOf(objId, leafId));
    expect(diff.changed.size).toBe(0);
    expect(diff.dirty).toEqual(setOf(leafId, objId, ids.user, ids.root));
  });

  it('reports removed children under their surviving parent only', () => {
    const current = removeNode(removeNode(original, ids.b), ids.user);
    const diff = diffTrees(original, current);
    expect([...diff.removed.keys()].sort()).toEqual([ids.root, ids.tags].sort());
    expect(diff.removed.get(ids.tags)?.map((n) => n.id)).toEqual([ids.b]);
    expect(diff.removed.get(ids.root)?.map((n) => n.id)).toEqual([ids.user]);
    expect(diff.dirty).toEqual(setOf(ids.tags, ids.root));
    expect(diff.dirty.has(ids.name)).toBe(false);
  });

  it('marks the parent (only) dirty when children are reordered', () => {
    const tags = at(original, 'tags');
    const reorderedTags: JNode = { ...tags, children: [...(tags.children ?? [])].reverse() };
    const current: JNode = { ...original, children: original.children?.map((c) => (c.id === ids.tags ? reorderedTags : c)) };
    const diff = diffTrees(original, current);
    expect(diff.changed.size).toBe(0);
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    expect(diff.dirty).toEqual(setOf(ids.tags, ids.root));
    expect(isTreeModified(original, current)).toBe(true);
  });

  it('does not flag a pure insertion or removal as a reorder of the remaining children', () => {
    const inserted = addChild(original, ids.tags, { index: 1 });
    const diff = diffTrees(original, inserted.root);
    expect(diff.dirty).toEqual(setOf(inserted.id, ids.tags, ids.root));
  });

  it('object <-> array conversion: node and kept children are changed, nothing added/removed', () => {
    const asArray = changeNodeType(original, ids.user, 'array');
    const diff = diffTrees(original, asArray);
    expect(diff.changed).toEqual(setOf(ids.user, ids.name, ids.age));
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    const backToObject = changeNodeType(asArray, ids.user, 'object');
    // the container is an object again (not changed itself), but its children now have keys "0"/"1"
    const roundTrip = diffTrees(original, backToObject);
    expect(roundTrip.changed).toEqual(setOf(ids.name, ids.age));
    expect(roundTrip.dirty).toEqual(setOf(ids.name, ids.age, ids.user, ids.root));
    expect(ser(at(backToObject, 'user'))).toBe('{"0":"Ann","1":30}');
    const tagsAsObject = changeNodeType(original, ids.tags, 'object');
    expect(diffTrees(original, tagsAsObject).changed).toEqual(setOf(ids.tags, ids.a, ids.b, ids.c));
  });

  it('container -> scalar lists the lost children as removed', () => {
    const current = changeNodeType(original, ids.tags, 'null');
    const diff = diffTrees(original, current);
    expect(diff.changed).toEqual(setOf(ids.tags));
    expect(diff.removed.get(ids.tags)?.map((n) => n.id)).toEqual([ids.a, ids.b, ids.c]);
  });

  it('flags a different root id as added', () => {
    const fresh = parse(ser(original));
    const diff = diffTrees(original, fresh);
    expect(diff.added.size).toBe(allIds(fresh).length);
    expect(isTreeModified(original, fresh)).toBe(true);
  });

  it('ignores root keys and keys of array items', () => {
    const withRootKey: JNode = { ...original, key: 'whatever' };
    expect(isTreeModified(original, withRootKey)).toBe(false);
    expect(diffTrees(original, withRootKey).dirty.size).toBe(0);
  });

  it('reports a shared subtree moved to another parent (same result as an unshared copy)', () => {
    const base = deepFreeze(parse('{"a":{"x":{"k":1}},"b":{}}'));
    const a = at(base, 'a');
    const b = at(base, 'b');
    const x = at(base, 'a', 'x');
    // `x` keeps its object identity but now lives under `b`
    const moved: JNode = { ...base, children: [{ ...a, children: [] }, { ...b, children: [x] }] };
    for (const current of [moved, cloneTree(moved, true)]) {
      const diff = diffTrees(base, current);
      expect(diff.changed).toEqual(setOf(x.id));
      expect(diff.added.size).toBe(0);
      expect(diff.removed.size).toBe(0);
      expect(diff.dirty).toEqual(setOf(x.id, a.id, b.id, base.id));
    }
  });

  it('gives consistent results when many trees are diffed against one baseline', () => {
    const name = idAt(original, 'user', 'name');
    const first = updateNode(original, name, { value: 'One' });
    const second = removeNode(original, ids.c);
    expect(diffTrees(original, first).changed).toEqual(setOf(name));
    expect(diffTrees(original, second).removed.get(ids.tags)?.map((n) => n.id)).toEqual([ids.c]);
    expect(diffTrees(original, first).removed.size).toBe(0);
    // a different baseline (an edited tree) is indexed on its own
    expect(diffTrees(first, second).changed).toEqual(setOf(name));
    expect(diffTrees(first, original).changed).toEqual(setOf(name));
  });
});

describe('revertNode', () => {
  const original = deepFreeze(parse('{"user":{"name":"Ann","age":30},"tags":["a","b","c","d"],"flag":true}'));
  const name = idAt(original, 'user', 'name');
  const user = idAt(original, 'user');
  const tags = idAt(original, 'tags');

  it('reverts a changed leaf, keeping unrelated edits and sharing structure', () => {
    let current = updateNode(original, name, { value: 'Bob', key: 'first' });
    current = updateNode(current, idAt(current, 'flag'), { value: false });
    const reverted = revertNode(original, current, name);
    expect(ser(reverted)).toBe('{"user":{"name":"Ann","age":30},"tags":["a","b","c","d"],"flag":false}');
    expect(diffTrees(original, reverted).changed).toEqual(setOf(idAt(original, 'flag')));
    expect(at(reverted, 'tags')).toBe(at(current, 'tags'));
    expect(at(reverted, 'user', 'age')).toBe(at(current, 'user', 'age'));
  });

  it('reverts a type change back to the original type and value', () => {
    const current = changeNodeType(original, user, 'array');
    const reverted = revertNode(original, current, user);
    expect(isTreeModified(original, reverted)).toBe(false);
  });

  it('removes added nodes', () => {
    const { root: current, id } = addChild(original, user, { key: 'extra' });
    const reverted = revertNode(original, current, id);
    expect(isTreeModified(original, reverted)).toBe(false);
    expect(at(reverted, 'tags')).toBe(at(current, 'tags'));
  });

  it('restores removed children when the parent is reverted', () => {
    const current = removeNode(removeNode(original, idAt(original, 'tags', 1)), idAt(original, 'user', 'age'));
    const reverted = revertNode(original, current, tags);
    expect(ser(reverted)).toBe('{"user":{"name":"Ann"},"tags":["a","b","c","d"],"flag":true}');
    expect(diffTrees(original, reverted).dirty).toEqual(setOf(user, original.id));
  });

  it('re-inserts a removed node by its own id next to its nearest surviving sibling', () => {
    const [a, b, c] = (at(original, 'tags').children ?? []).map((n) => n.id);
    let current = removeNode(removeNode(original, b), c);
    current = revertNode(original, current, c);
    expect(ser(at(current, 'tags'))).toBe('["a","c","d"]');
    current = revertNode(original, current, b);
    expect(ser(at(current, 'tags'))).toBe('["a","b","c","d"]');
    expect(isTreeModified(original, current)).toBe(false);
    const withoutFirst = removeNode(original, a);
    expect(ser(at(revertNode(original, withoutFirst, a), 'tags'))).toBe('["a","b","c","d"]');
  });

  it('does nothing when the removed node parent is gone too', () => {
    const current = removeNode(original, user);
    expect(revertNode(original, current, name)).toBe(current);
    expect(isTreeModified(original, revertNode(original, current, user))).toBe(false);
  });

  it('reverting the root returns a clone of the original with the same ids', () => {
    const current = changeNodeType(updateNode(original, name, { value: 'x' }), tags, 'string');
    const reverted = revertNode(original, current, current.id);
    expect(reverted).not.toBe(original);
    expect(allIds(reverted)).toEqual(allIds(original));
    expect(ser(reverted)).toBe(ser(original));
    expect(isTreeModified(original, reverted)).toBe(false);
    // also when the current root itself was replaced
    const replaced = parse('[1]');
    expect(isTreeModified(original, revertNode(original, replaced, replaced.id))).toBe(false);
  });

  it('returns the current tree itself when nothing would change', () => {
    const current = updateNode(original, name, { value: 'Bob' });
    expect(revertNode(original, current, idAt(original, 'flag'))).toBe(current);
    expect(revertNode(original, original, original.id)).toBe(original);
    expect(revertNode(original, current, 'missing')).toBe(current);
  });

  it('puts the original subtree objects back (shared with the original again)', () => {
    const edited = updateNode(updateNode(original, name, { value: 'Bob' }), idAt(original, 'tags', 0), { value: 'z' });
    const reverted = revertNode(original, edited, user);
    expect(at(reverted, 'user')).toBe(at(original, 'user'));
    expect(at(reverted, 'tags')).toBe(at(edited, 'tags'));
    const removed = removeNode(original, idAt(original, 'tags', 2));
    const restored = revertNode(original, removed, idAt(original, 'tags', 2));
    expect(at(restored, 'tags', 2)).toBe(at(original, 'tags', 2));
    // the root is still reverted to a copy (same ids, new objects)
    expect(revertNode(original, edited, edited.id)).not.toBe(original);
  });

  it('restores the original key of a renamed container', () => {
    const current = updateNode(original, user, { key: 'person' });
    const reverted = revertNode(original, current, user);
    expect(at(reverted, 'user').id).toBe(user);
    expect(isTreeModified(original, reverted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------------------------

describe('alignTreeIds', () => {
  const reference = deepFreeze(parse('{"a":1,"list":[{"x":"1"},{"x":"2"}],"dup":"first","dup":"second","obj":{"k":true}}'));

  it('re-uses every id when the structure is unchanged', () => {
    const next = deepFreeze(parse(ser(reference, 2)));
    const aligned = alignTreeIds(next, reference);
    expect(allIds(aligned)).toEqual(allIds(reference));
    expect(isTreeModified(reference, aligned)).toBe(false);
    expect(ser(next)).toBe(ser(reference)); // inputs untouched
  });

  it('keeps diff markers precise after a raw edit', () => {
    const next = parse('{"a":2,"list":[{"x":"1"},{"x":"2","y":null}],"dup":"first","dup":"SECOND","obj":{"k":true},"new":[]}');
    const aligned = alignTreeIds(next, reference);
    const diff = diffTrees(reference, aligned);
    const newY = at(aligned, 'list', 1, 'y').id;
    const newKey = at(aligned, 'new').id;
    expect(diff.changed).toEqual(setOf(idAt(reference, 'a'), reference.children?.[3].id as string));
    expect(diff.added).toEqual(setOf(newY, newKey));
    expect(diff.removed.size).toBe(0);
    expect(diff.dirty.has(idAt(reference, 'obj'))).toBe(false);
    expect(diff.dirty.has(idAt(reference, 'list', 0))).toBe(false);
  });

  it('matches duplicate keys by occurrence', () => {
    const next = parse('{"dup":"x","other":1,"dup":"y","dup":"z"}');
    const aligned = alignTreeIds(next, reference);
    const dups = (aligned.children ?? []).filter((c) => c.key === 'dup');
    expect(dups[0].id).toBe(reference.children?.[2].id);
    expect(dups[1].id).toBe(reference.children?.[3].id);
    expect(dups[2].id).not.toBe(reference.children?.[2].id);
    expect(dups[2].id).not.toBe(reference.children?.[3].id);
  });

  it('matches array items by index', () => {
    const next = parse('{"list":[{"x":"2"}]}');
    const aligned = alignTreeIds(next, reference);
    expect(at(aligned, 'list', 0).id).toBe(idAt(reference, 'list', 0));
    expect(at(aligned, 'list', 0, 'x').id).toBe(idAt(reference, 'list', 0, 'x'));
    const diff = diffTrees(reference, aligned);
    expect(diff.changed).toEqual(setOf(idAt(reference, 'list', 0, 'x')));
    expect(diff.removed.get(idAt(reference, 'list'))?.map((n) => n.id)).toEqual([idAt(reference, 'list', 1)]);
  });

  it('matches scalars of different types but never mismatched container types', () => {
    const next = deepFreeze(parse('{"a":"1","list":{"0":{"x":"1"}},"obj":{"k":[1]},"dup":{}}'));
    const aligned = alignTreeIds(next, reference);
    expect(at(aligned, 'a').id).toBe(idAt(reference, 'a')); // number -> string stays the same node
    expect(at(aligned, 'list').id).not.toBe(idAt(reference, 'list')); // array -> object: unmatched
    expect(at(aligned, 'list')).toBe(at(next, 'list')); // unmatched subtrees are reused as-is
    expect(at(aligned, 'list', '0', 'x').id).not.toBe(idAt(reference, 'list', 0, 'x'));
    expect(at(aligned, 'obj').id).toBe(idAt(reference, 'obj'));
    expect(at(aligned, 'obj', 'k').id).not.toBe(idAt(reference, 'obj', 'k')); // boolean -> array: unmatched
    expect(at(aligned, 'dup').id).not.toBe(reference.children?.[2].id); // string -> object: unmatched
    expect(diffTrees(reference, aligned).changed).toEqual(setOf(idAt(reference, 'a')));
  });

  it('keeps fresh ids when the root container type differs, and matches scalar roots', () => {
    const next = parse('[1]');
    expect(alignTreeIds(next, reference)).toBe(next);
    const scalarRef = parse('"x"');
    expect(alignTreeIds(parse('5'), scalarRef).id).toBe(scalarRef.id);
  });

  it('never produces duplicate ids, even when `next` re-uses reference ids at other paths', () => {
    // An insertion at the front of a cloned array shifts every item: index matching would hand
    // reference ids to other nodes, so the leftover node must get a fresh id.
    const ref = parse('[{"v":1},{"v":2}]');
    const cloned = cloneTree(ref, true);
    const { root: shifted } = addChild(cloned, cloned.id, { type: 'object', index: 0 });
    const aligned = alignTreeIds(shifted, ref);
    const ids = allIds(aligned);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns the reference itself when nothing changed', () => {
    expect(alignTreeIds(parse(ser(reference, 2)), reference)).toBe(reference);
    const scalarRef = deepFreeze(parse('"x"'));
    expect(alignTreeIds(parse('"x"'), scalarRef)).toBe(scalarRef);
    const emptyRef = deepFreeze(parse('{}'));
    expect(alignTreeIds(parse('{ }'), emptyRef)).toBe(emptyRef);
  });

  it('shares every untouched reference subtree after a raw edit (only edited paths are new)', () => {
    const next = parse('{"a":1,"list":[{"x":"1"},{"x":"changed"}],"dup":"first","dup":"second","obj":{"k":true}}');
    const aligned = alignTreeIds(next, reference);
    expect(aligned).not.toBe(reference);
    expect(at(aligned, 'a')).toBe(at(reference, 'a'));
    expect(at(aligned, 'list', 0)).toBe(at(reference, 'list', 0));
    expect(at(aligned, 'obj')).toBe(at(reference, 'obj'));
    expect(aligned.children?.[2]).toBe(reference.children?.[2]);
    expect(aligned.children?.[3]).toBe(reference.children?.[3]);
    // the edited path is copied, keeping the reference ids
    for (const path of [['list'], ['list', 1], ['list', 1, 'x']] as const) {
      expect(at(aligned, ...path)).not.toBe(at(reference, ...path));
      expect(at(aligned, ...path).id).toBe(idAt(reference, ...path));
    }
    const diff = diffTrees(reference, aligned);
    expect(diff.changed).toEqual(setOf(idAt(reference, 'list', 1, 'x')));
    expect(diff.dirty).toEqual(setOf(idAt(reference, 'list', 1, 'x'), idAt(reference, 'list', 1), idAt(reference, 'list'), reference.id));
  });

  it('does not share when only the key spelling, order or a nested value differs', () => {
    const swapped = alignTreeIds(parse('{"obj":{"k":true},"a":1}'), deepFreeze(parse('{"a":1,"obj":{"k":true}}')));
    expect(swapped.children?.map((c) => c.key)).toEqual(['obj', 'a']);
    const ref = deepFreeze(parse('{"o":{"deep":[1,2]}}'));
    const aligned = alignTreeIds(parse('{"o":{"deep":[1,3]}}'), ref);
    expect(at(aligned, 'o')).not.toBe(at(ref, 'o'));
    expect(at(aligned, 'o', 'deep', 0)).toBe(at(ref, 'o', 'deep', 0));
    expect(ser(aligned)).toBe('{"o":{"deep":[1,3]}}');
  });

  it('round-trips the current tree through raw text without losing ids', () => {
    let current = updateNode(reference, idAt(reference, 'a'), { value: '5' });
    current = addChild(current, idAt(current, 'obj'), { key: 'added' }).root;
    const aligned = alignTreeIds(parse(ser(current, 2)), current);
    expect(isTreeModified(current, aligned)).toBe(false);
    expect(diffTrees(reference, aligned).changed).toEqual(diffTrees(reference, current).changed);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation / stats
// ---------------------------------------------------------------------------------------------

describe('isValidNumberLiteral / treeErrors / countNodes', () => {
  it.each(['0', '-0', '1', '-1', '10', '1.5', '0.0', '1e5', '1E5', '1e+5', '1e-5', '-1.5E-300', '12345678901234567890'])(
    'accepts %j',
    (text) => expect(isValidNumberLiteral(text)).toBe(true),
  );

  it.each(['', ' ', ' 1', '1 ', '01', '-01', '+1', '.5', '5.', '1e', '1e+', '0x10', 'NaN', 'Infinity', '-', '1.2.3', '1_000', '١'])(
    'rejects %j',
    (text) => expect(isValidNumberLiteral(text)).toBe(false),
  );

  it('rejects non-strings', () => {
    expect(isValidNumberLiteral(1 as unknown as string)).toBe(false);
  });

  it('flags invalid number literals and unknown types by node id', () => {
    const tree = parse('{"a":1,"b":[2,3]}');
    expect(treeErrors(tree).size).toBe(0);
    let current = updateNode(tree, idAt(tree, 'a'), { value: '1.2.3' });
    current = updateNode(current, idAt(current, 'b', 1), { value: '' });
    const errors = treeErrors(current);
    expect([...errors.keys()].sort()).toEqual([idAt(tree, 'a'), idAt(tree, 'b', 1)].sort());
    expect(errors.get(idAt(tree, 'a'))).toBe('"1.2.3" is not a valid JSON number');
    expect(errors.get(idAt(tree, 'b', 1))).toBe('Number is empty');
    expect(treeErrors(updateNode(current, idAt(tree, 'a'), { value: '7' })).has(idAt(tree, 'a'))).toBe(false);
    const weird = { id: 'w', type: 'date', key: 'k' } as unknown as JNode;
    expect(treeErrors({ id: 'r', type: 'object', children: [weird] }).get('w')).toMatch(/Unknown value type/);
    const sloppy: JNode = { id: 'r', type: 'array', children: [{ id: 'm', type: 'number' }, { id: 'b', type: 'number', value: true }] };
    expect(treeErrors(sloppy)).toEqual(
      new Map([
        ['m', 'Number is empty'],
        ['b', '"true" is not a valid JSON number'],
      ]),
    );
  });

  it('counts descendants', () => {
    expect(countNodes(parse('{"a":[1,2],"b":{}}'))).toBe(4);
    expect(countNodes(parse('1'))).toBe(0);
    expect(countNodes(parse('[]'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Property test: random edit sequences
// ---------------------------------------------------------------------------------------------

describe('random edit sequences (property test)', () => {
  const TYPES: JNodeType[] = ['object', 'array', 'string', 'number', 'boolean', 'null'];
  const KEYS = ['a', 'b', 'dup', 'dup', 'with space', 'é', ''];
  const STRINGS = ['', 'x', 'quote"d', 'line\nbreak', '😀', '\ud800', 'tab\t'];
  const NUMBERS = ['0', '-0', '1.50', '12345678901234567890', '1e-7', '1E+2'];
  const BASE = '{"a":{"x":1,"y":[1,2,{"z":null}]},"dup":"one","dup":"two","list":[true,false,"s",{"k":{"deep":[0.10]}}],"s":"text"}';

  function checkInvariants(original: JNode, current: JNode): void {
    const ids = allIds(current);
    expect(new Set(ids).size).toBe(ids.length);
    const idSet = new Set(ids);

    const diff = diffTrees(original, current);
    expect(isTreeModified(original, current)).toBe(diff.dirty.size > 0);
    // structural sharing with the original is only an optimization: an unshared deep copy diffs the same
    const unshared = diffTrees(original, cloneTree(current, true));
    expect(diff.changed).toEqual(unshared.changed);
    expect(diff.added).toEqual(unshared.added);
    expect(diff.removed).toEqual(unshared.removed);
    expect(diff.dirty).toEqual(unshared.dirty);
    for (const id of [...diff.changed, ...diff.added, ...diff.removed.keys()]) expect(diff.dirty.has(id)).toBe(true);
    for (const id of diff.dirty) {
      expect(idSet.has(id)).toBe(true);
      const parent = findNode(current, id)?.parent;
      if (parent) expect(diff.dirty.has(parent.id)).toBe(true);
    }

    expect(treeErrors(current).size).toBe(0);
    const text = serializeJsonTree(current);
    expect(() => JSON.parse(text)).not.toThrow();
    const aligned = alignTreeIds(parseJsonTree(serializeJsonTree(current, 2)), current);
    expect(isTreeModified(current, aligned)).toBe(false);

    const reverted = revertNode(original, current, current.id);
    expect(isTreeModified(original, reverted)).toBe(false);
    expect(serializeJsonTree(reverted)).toBe(serializeJsonTree(original));
  }

  it.each<[label: string, seed: number, shared: boolean]>([
    ['an unshared copy', 42, false],
    ['the original itself (structural sharing)', 7, true],
  ])('keeps every invariant across 400 random edits starting from %s', (_label, seed, shared) => {
    const random = rng(seed);
    let effectiveEdits = 0;
    const original = deepFreeze(parseJsonTree(BASE));
    const originalText = serializeJsonTree(original);
    let current: JNode = shared ? original : cloneTree(original, true);
    for (let step = 0; step < 400; step++) {
      const nodes = allNodes(current);
      const node = pick(random, nodes);
      const op = Math.floor(random() * 8);
      const before = current;
      switch (op) {
        case 0:
          if (node.type === 'string') current = updateNode(current, node.id, { value: pick(random, STRINGS) });
          else if (node.type === 'number') current = updateNode(current, node.id, { value: pick(random, NUMBERS) });
          else if (node.type === 'boolean') current = updateNode(current, node.id, { value: !node.value });
          break;
        case 1:
          current = updateNode(current, node.id, { key: pick(random, KEYS) });
          break;
        case 2:
          current = changeNodeType(current, node.id, pick(random, TYPES));
          break;
        case 3:
          current = removeNode(current, node.id);
          break;
        case 4:
          current = addChild(current, node.id, { type: pick(random, TYPES), index: Math.floor(random() * 4) }).root;
          break;
        case 5:
          current = duplicateNode(current, node.id).root;
          break;
        default: {
          const candidates = [...allIds(current), ...allIds(original)];
          current = revertNode(original, current, pick(random, candidates));
        }
      }
      deepFreeze(current);
      if (current !== before) {
        effectiveEdits++;
        checkInvariants(original, current);
      }
      if (allNodes(current).length > 400) current = revertNode(original, current, current.id);
    }
    expect(serializeJsonTree(original)).toBe(originalText);
    expect(effectiveEdits).toBeGreaterThan(150);
  });
});
