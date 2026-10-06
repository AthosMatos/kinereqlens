import { describe, expect, it } from 'vitest';
import { DIFF_MAX_EDITS, lineDiff, withContext, type DiffLine } from '../../src/lib/diff';

const ops = (lines: DiffLine[]) => lines.map((l) => `${l.op === 'eq' ? ' ' : l.op === 'add' ? '+' : '-'}${l.text}`);

/** Rebuild both inputs from the diff and check the line numbering. */
function reconstruct(lines: DiffLine[]): { left: string[]; right: string[] } {
  const left: string[] = [];
  const right: string[] = [];
  for (const line of lines) {
    if (line.op !== 'add') {
      left.push(line.text);
      expect(line.a).toBe(left.length);
    } else {
      expect(line.a).toBeUndefined();
    }
    if (line.op !== 'del') {
      right.push(line.text);
      expect(line.b).toBe(right.length);
    } else {
      expect(line.b).toBeUndefined();
    }
  }
  return { left, right };
}

/** Classic O(NM) LCS length, the reference for minimality. */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('lineDiff', () => {
  it('reports identical texts as all-equal', () => {
    const result = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(result).toEqual({
      lines: [
        { op: 'eq', a: 1, b: 1, text: 'a' },
        { op: 'eq', a: 2, b: 2, text: 'b' },
        { op: 'eq', a: 3, b: 3, text: 'c' },
      ],
      added: 0,
      removed: 0,
      truncated: false,
    });
  });

  it('handles empty inputs', () => {
    expect(lineDiff('', '')).toEqual({ lines: [], added: 0, removed: 0, truncated: false });
    expect(lineDiff('', 'a\nb')).toMatchObject({
      lines: [
        { op: 'add', b: 1, text: 'a' },
        { op: 'add', b: 2, text: 'b' },
      ],
      added: 2,
      removed: 0,
    });
    expect(lineDiff('a', '')).toMatchObject({ lines: [{ op: 'del', a: 1, text: 'a' }], added: 0, removed: 1 });
  });

  it('finds a minimal diff for a simple edit', () => {
    const result = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(ops(result.lines)).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.lines[1]).toEqual({ op: 'del', a: 2, text: 'b' });
    expect(result.lines[2]).toEqual({ op: 'add', b: 2, text: 'B' });
    expect(result.lines[5]).toEqual({ op: 'add', b: 5, text: 'e' });
  });

  it('lists deletions before additions inside a hunk', () => {
    expect(ops(lineDiff('x\n1\n2\ny', 'x\n3\n4\ny').lines)).toEqual([' x', '-1', '-2', '+3', '+4', ' y']);
  });

  it('tolerates CRLF and ignores a single trailing newline', () => {
    const result = lineDiff('a\r\nb\r\n', 'a\nb\nc\n');
    expect(ops(result.lines)).toEqual([' a', ' b', '+c']);
    expect(lineDiff('a\n', 'a').lines).toEqual([{ op: 'eq', a: 1, b: 1, text: 'a' }]);
    expect(lineDiff('\n', '').lines).toEqual([{ op: 'del', a: 1, text: '' }]);
  });

  it('handles duplicate and blank lines', () => {
    const result = lineDiff('x\n\nx\n\nx', 'x\nx\n\nx\n\n');
    const { left, right } = reconstruct(result.lines);
    expect(left).toEqual(['x', '', 'x', '', 'x']);
    expect(right).toEqual(['x', 'x', '', 'x', '']);
    expect(result.lines.filter((l) => l.op === 'eq')).toHaveLength(lcsLength(left, right));
  });

  it('handles unicode lines', () => {
    expect(ops(lineDiff('名前: 値\n😀\nü', '名前: 値\n😀😀\nü').lines)).toEqual([' 名前: 値', '-😀', '+😀😀', ' ü']);
  });

  it('replaces completely different texts', () => {
    const result = lineDiff('a\nb', 'c\nd');
    expect(ops(result.lines)).toEqual(['-a', '-b', '+c', '+d']);
    expect(result.truncated).toBe(false);
  });

  it('produces minimal, consistent diffs on random inputs', () => {
    const random = rng(42);
    for (let round = 0; round < 300; round++) {
      const alphabet = 1 + Math.floor(random() * 5);
      const make = () =>
        Array.from({ length: Math.floor(random() * 25) }, () => String.fromCharCode(97 + Math.floor(random() * alphabet)));
      const a = make();
      const b = make();
      const result = lineDiff(a.join('\n'), b.join('\n'));
      const rebuilt = reconstruct(result.lines);
      expect(rebuilt.left.join('\n')).toBe(a.join('\n'));
      expect(rebuilt.right.join('\n')).toBe(b.join('\n'));
      const equal = result.lines.filter((l) => l.op === 'eq').length;
      expect(equal).toBe(lcsLength(rebuilt.left, rebuilt.right));
      expect(result.removed).toBe(rebuilt.left.length - equal);
      expect(result.added).toBe(rebuilt.right.length - equal);
      expect(result.truncated).toBe(false);
    }
  });

  it('falls back to a coarse diff beyond maxLines', () => {
    const left = ['same', 'x1', 'mid', 'x2', 'tail'].join('\n');
    const right = ['same', 'y1', 'mid', 'y2', 'tail'].join('\n');
    const exact = lineDiff(left, right);
    expect(exact.truncated).toBe(false);
    expect(ops(exact.lines)).toEqual([' same', '-x1', '+y1', ' mid', '-x2', '+y2', ' tail']);
    const coarse = lineDiff(left, right, { maxLines: 4 });
    expect(coarse.truncated).toBe(true);
    expect(ops(coarse.lines)).toEqual([' same', '-x1', '-mid', '-x2', '+y1', '+mid', '+y2', ' tail']);
    expect(coarse.added).toBe(3);
    expect(coarse.removed).toBe(3);
    reconstruct(coarse.lines);
  });

  it('falls back when the edit distance exceeds the cap', () => {
    const n = DIFF_MAX_EDITS;
    // Reversed distinct lines: LCS is 1, so the edit distance is 2n - 2 > cap, but the sides share lines.
    const left = Array.from({ length: n }, (_, i) => `line ${i}`);
    const right = left.slice().reverse();
    const start = performance.now();
    const result = lineDiff(['head', ...left, 'foot'].join('\n'), ['head', ...right, 'foot'].join('\n'));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.truncated).toBe(true);
    expect(result.lines[0]).toEqual({ op: 'eq', a: 1, b: 1, text: 'head' });
    expect(result.lines[result.lines.length - 1]).toEqual({ op: 'eq', a: n + 2, b: n + 2, text: 'foot' });
    expect(result.removed).toBe(n);
    expect(result.added).toBe(n);
    expect(ops(result.lines.slice(1, 3))).toEqual([`-line 0`, `-line 1`]);
    const rebuilt = reconstruct(result.lines);
    expect(rebuilt.left).toEqual(['head', ...left, 'foot']);
    expect(rebuilt.right).toEqual(['head', ...right, 'foot']);
  });

  it('reports a large replacement without common lines as exact, not coarse', () => {
    const n = DIFF_MAX_EDITS; // 2 * n edits > cap, yet "delete all + add all" is the minimal diff
    const left = Array.from({ length: n }, (_, i) => `left ${i}`);
    const right = Array.from({ length: n }, (_, i) => `right ${i}`);
    const start = performance.now();
    const result = lineDiff(['head', ...left, 'foot'].join('\n'), ['head', ...right, 'foot'].join('\n'));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.truncated).toBe(false);
    expect(result.removed).toBe(n);
    expect(result.added).toBe(n);
    expect(ops(result.lines.slice(0, 2))).toEqual([' head', '-left 0']);
    expect(ops(result.lines.slice(n, n + 2))).toEqual([`-left ${n - 1}`, '+right 0']);
  });

  it('stays exact (and fast) just under the cap with interleaved changes', () => {
    const left: string[] = [];
    const right: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      left.push(`line ${i}`);
      // 1800 modified lines -> 3600 edits, below the 4000 cap.
      right.push(i % 5 === 0 && i < 9000 ? `changed ${i}` : `line ${i}`);
    }
    const start = performance.now();
    const result = lineDiff(left.join('\n'), right.join('\n'));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.truncated).toBe(false);
    expect(result.removed).toBe(1800);
    expect(result.added).toBe(1800);
    const rebuilt = reconstruct(result.lines);
    expect(rebuilt.left).toEqual(left);
    expect(rebuilt.right).toEqual(right);
  });

  it('diffs 10k-line pretty JSON documents in under a second', () => {
    const base = Array.from({ length: 2500 }, (_, i) => ({ id: i, name: `user ${i}`, active: i % 3 === 0 }));
    const changed = base.map((item, i) => (i % 97 === 0 ? { ...item, name: `renamed ${i}` } : item));
    changed.splice(1200, 0, { id: -1, name: 'inserted', active: true });
    const left = JSON.stringify(base, null, 2);
    const right = JSON.stringify(changed, null, 2);
    expect(left.split('\n').length).toBeGreaterThan(10_000);
    const start = performance.now();
    const result = lineDiff(left, right);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.truncated).toBe(false);
    expect(result.removed).toBe(26);
    expect(result.added).toBe(26 + 5);
  });

  it('is fast for huge inputs beyond maxLines', () => {
    const left = Array.from({ length: 100_000 }, (_, i) => `l${i}`).join('\n');
    const right = `${left}\nextra`;
    const start = performance.now();
    const result = lineDiff(left, right);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.truncated).toBe(true);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
  });
});

describe('withContext', () => {
  const eq = (n: number): DiffLine => ({ op: 'eq', a: n, b: n, text: `l${n}` });

  it('keeps context lines around changes and collapses the rest', () => {
    const lines: DiffLine[] = [];
    for (let i = 1; i <= 10; i++) lines.push(eq(i));
    lines.push({ op: 'del', a: 11, text: 'old' }, { op: 'add', b: 11, text: 'new' });
    for (let i = 12; i <= 30; i++) lines.push(eq(i));
    lines.push({ op: 'add', b: 31, text: 'more' });
    for (let i = 32; i <= 40; i++) lines.push(eq(i));

    const out = withContext(lines);
    const summary = out.map((l) => (l.op === 'skip' ? `skip ${l.count}` : l.op === 'eq' ? `eq ${l.a}` : l.op));
    expect(summary).toEqual([
      'skip 7',
      'eq 8',
      'eq 9',
      'eq 10',
      'del',
      'add',
      'eq 12',
      'eq 13',
      'eq 14',
      'skip 13',
      'eq 28',
      'eq 29',
      'eq 30',
      'add',
      'eq 32',
      'eq 33',
      'eq 34',
      'skip 6',
    ]);
  });

  it('honours a custom context and never hides a single line', () => {
    const lines: DiffLine[] = [{ op: 'add', b: 1, text: 'x' }, eq(1), eq(2), eq(3), { op: 'del', a: 4, text: 'y' }];
    expect(withContext(lines, 1).map((l) => l.op)).toEqual(['add', 'eq', 'eq', 'eq', 'del']);
    const longer = [{ op: 'add', b: 1, text: 'x' } as DiffLine, eq(1), eq(2), eq(3), eq(4), { op: 'del', a: 5, text: 'y' } as DiffLine];
    expect(withContext(longer, 1)).toEqual([longer[0], longer[1], { op: 'skip', count: 2 }, longer[4], longer[5]]);
    expect(withContext(longer, 0)).toEqual([longer[0], { op: 'skip', count: 4 }, longer[5]]);
  });

  it('collapses an all-equal diff and passes changes-only diffs through', () => {
    const same = [eq(1), eq(2), eq(3), eq(4)];
    expect(withContext(same)).toEqual([{ op: 'skip', count: 4 }]);
    const changes: DiffLine[] = [
      { op: 'del', a: 1, text: 'a' },
      { op: 'add', b: 1, text: 'b' },
    ];
    expect(withContext(changes)).toEqual(changes);
    expect(withContext([])).toEqual([]);
  });

  it('keeps short runs intact', () => {
    const lines: DiffLine[] = [eq(1), eq(2), { op: 'add', b: 3, text: 'x' }, eq(3), eq(4)];
    expect(withContext(lines)).toEqual(lines);
  });
});
