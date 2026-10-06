// OWNER: lib-core agent. Line diff for comparing responses (Myers or LCS; must stay fast for ~20k lines).
//
// Algorithm: Myers' O(ND) difference algorithm in its linear-space "middle snake" form (forward and
// backward searches meet in the middle, then both halves are solved recursively), after interning lines
// to integers and trimming the common prefix/suffix of every sub-problem. Memory is O(N + M); recursion
// depth is O(log D). Work is bounded by DIFF_MAX_EDITS: when the edit distance is larger, the diff falls
// back to "common prefix + one replace block + common suffix" and reports truncated=true (unless the
// replaced ranges share no line at all, in which case that single block is already the exact diff).

export interface DiffLine {
  op: 'eq' | 'add' | 'del';
  /** 1-based line number in the left text (eq/del). */
  a?: number;
  /** 1-based line number in the right text (eq/add). */
  b?: number;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /**
   * True when the diff fell back to the coarse comparison (common prefix + one replace block + common
   * suffix) because either side exceeded maxLines or the edit distance exceeded DIFF_MAX_EDITS. The
   * coarse result is still a valid edit script (it reconstructs both texts), just not a minimal one.
   */
  truncated: boolean;
}

/** Default `maxLines`: either side longer than this gets the coarse comparison. */
export const DIFF_MAX_LINES = 20_000;
/** Edit distance above which the exact diff is abandoned for the coarse comparison. */
export const DIFF_MAX_EDITS = 4_000;

/** Split into lines: '\n' separated, a trailing '\r' is dropped (CRLF), a final newline does not start a new line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  return lines;
}

const OP_EQ = 0;
const OP_DEL = 1;
const OP_ADD = 2;

/** Edit script in path order: parallel arrays of op code and 0-based line indexes (-1 when not applicable). */
class EditScript {
  readonly ops: number[] = [];
  readonly aIdx: number[] = [];
  readonly bIdx: number[] = [];

  eq(a: number, b: number): void {
    this.push(OP_EQ, a, b);
  }

  del(aFrom: number, aTo: number): void {
    for (let a = aFrom; a < aTo; a++) this.push(OP_DEL, a, -1);
  }

  add(bFrom: number, bTo: number): void {
    for (let b = bFrom; b < bTo; b++) this.push(OP_ADD, -1, b);
  }

  private push(op: number, a: number, b: number): void {
    this.ops.push(op);
    this.aIdx.push(a);
    this.bIdx.push(b);
  }
}

/** Split point returned by bisect, or one of the special outcomes. */
type Bisection = { x: number; y: number } | 'disjoint' | 'over-cap';

class MyersDiff {
  /** Set when the edit-distance cap was hit and the middle part was emitted as one replace block. */
  truncated = false;

  constructor(
    private readonly a: Int32Array,
    private readonly b: Int32Array,
    /** Number of distinct line ids (every id in `a` and `b` is in [0, idCount)). */
    private readonly idCount: number,
    private readonly script: EditScript,
  ) {}

  run(maxEdits: number): void {
    this.compare(0, this.a.length, 0, this.b.length, maxEdits);
  }

  /** Diff a[aLo, aHi) against b[bLo, bHi), appending to the script in order. */
  private compare(aLo: number, aHi: number, bLo: number, bHi: number, maxEdits: number): void {
    const { a, b, script } = this;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) script.eq(aLo++, bLo++);
    let aEnd = aHi;
    let bEnd = bHi;
    while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }

    if (aLo === aEnd) {
      script.add(bLo, bEnd);
    } else if (bLo === bEnd) {
      script.del(aLo, aEnd);
    } else {
      const split = this.bisect(aLo, aEnd, bLo, bEnd, maxEdits);
      if (split === 'disjoint' || split === 'over-cap') {
        // A replace block of ranges that share no line is the exact diff, so it is not reported as coarse.
        if (split === 'over-cap' && this.shareAnyLine(aLo, aEnd, bLo, bEnd)) this.truncated = true;
        script.del(aLo, aEnd);
        script.add(bLo, bEnd);
      } else {
        // The split point lies on an optimal path, so the halves need no cap: their distances sum to D <= cap.
        this.compare(aLo, split.x, bLo, split.y, Infinity);
        this.compare(split.x, aEnd, split.y, bEnd, Infinity);
      }
    }

    for (let k = 0; k < aHi - aEnd; k++) script.eq(aEnd + k, bEnd + k);
  }

  /** True when some line of a[aLo, aHi) also occurs in b[bLo, bHi). Linear: line ids are dense small integers. */
  private shareAnyLine(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
    const { a, b } = this;
    const inB = new Uint8Array(this.idCount);
    for (let j = bLo; j < bHi; j++) inB[b[j]] = 1;
    for (let i = aLo; i < aHi; i++) if (inB[a[i]] === 1) return true;
    return false;
  }

  /**
   * Find the middle snake of a[aLo, aHi) vs b[bLo, bHi) (both non-empty, first and last lines differ).
   * Forward paths are tracked in v1 and reverse paths in v2, indexed by diagonal k = x - y (+ offset).
   */
  private bisect(aLo: number, aHi: number, bLo: number, bHi: number, maxEdits: number): Bisection {
    const { a, b } = this;
    const n = aHi - aLo;
    const m = bHi - bLo;
    const maxD = Math.ceil((n + m) / 2);
    const offset = maxD;
    const size = 2 * maxD + 2;
    const v1 = new Int32Array(size).fill(-1);
    const v2 = new Int32Array(size).fill(-1);
    v1[offset + 1] = 0;
    v2[offset + 1] = 0;
    const delta = n - m;
    // With an odd delta the paths can only meet during a forward step, with an even delta during a reverse step.
    const front = delta % 2 !== 0;
    // Diagonals that ran off the grid are skipped from then on.
    let k1start = 0;
    let k1end = 0;
    let k2start = 0;
    let k2end = 0;

    for (let d = 0; d < maxD; d++) {
      // Any overlap found from here on implies an edit distance of at least 2d - 1.
      if (2 * d - 1 > maxEdits) return 'over-cap';

      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1o = offset + k1;
        let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
        let y1 = x1 - k1;
        while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
          x1++;
          y1++;
        }
        v1[k1o] = x1;
        if (x1 > n) {
          k1end += 2;
        } else if (y1 > m) {
          k1start += 2;
        } else if (front) {
          const k2o = offset + delta - k1;
          if (k2o >= 0 && k2o < size && v2[k2o] !== -1 && x1 >= n - v2[k2o]) {
            return { x: aLo + x1, y: bLo + y1 };
          }
        }
      }

      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2o = offset + k2;
        let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
        let y2 = x2 - k2;
        while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
          x2++;
          y2++;
        }
        v2[k2o] = x2;
        if (x2 > n) {
          k2end += 2;
        } else if (y2 > m) {
          k2start += 2;
        } else if (!front) {
          const k1o = offset + delta - k2;
          if (k1o >= 0 && k1o < size && v1[k1o] !== -1) {
            const x1 = v1[k1o];
            const y1 = offset + x1 - k1o;
            if (x1 >= n - x2) return { x: aLo + x1, y: bLo + y1 };
          }
        }
      }
    }
    // No common line at all: the whole range is one replacement.
    return 'disjoint';
  }
}

/** Map every distinct line to a small integer (0..count-1) so comparisons are integer compares. */
function intern(left: string[], right: string[]): { a: Int32Array; b: Int32Array; count: number } {
  const ids = new Map<string, number>();
  const toIds = (lines: string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i] = id;
    }
    return out;
  };
  const a = toIds(left);
  const b = toIds(right);
  return { a, b, count: ids.size };
}

/** Coarse comparison: common prefix, one replace block, common suffix. */
function coarseScript(left: string[], right: string[], script: EditScript): void {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    script.eq(start, start);
    start++;
  }
  let aEnd = left.length;
  let bEnd = right.length;
  while (aEnd > start && bEnd > start && left[aEnd - 1] === right[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  script.del(start, aEnd);
  script.add(start, bEnd);
  for (let k = 0; k < left.length - aEnd; k++) script.eq(aEnd + k, bEnd + k);
}

/** Turn the script into DiffLines; inside every change hunk deletions are listed before additions. */
function materialize(script: EditScript, left: string[], right: string[]): DiffResult {
  const { ops, aIdx, bIdx } = script;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === OP_EQ) {
      lines.push({ op: 'eq', a: aIdx[i] + 1, b: bIdx[i] + 1, text: left[aIdx[i]] });
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j] !== OP_EQ) j++;
    for (let k = i; k < j; k++) {
      if (ops[k] === OP_DEL) {
        lines.push({ op: 'del', a: aIdx[k] + 1, text: left[aIdx[k]] });
        removed++;
      }
    }
    for (let k = i; k < j; k++) {
      if (ops[k] === OP_ADD) {
        lines.push({ op: 'add', b: bIdx[k] + 1, text: right[bIdx[k]] });
        added++;
      }
    }
    i = j;
  }
  return { lines, added, removed, truncated: false };
}

/**
 * Line diff of two texts. Lines are split on '\n' (CRLF tolerated: the '\r' is not part of the line).
 * When either side has more than `maxLines` lines (default 20000) or the edit distance exceeds
 * DIFF_MAX_EDITS, the result is the coarse "prefix + one replace block + suffix" with truncated=true
 * (except when the replaced ranges share no line at all: that replace block is already exact).
 */
export function lineDiff(left: string, right: string, opts?: { maxLines?: number }): DiffResult {
  const maxLines = opts?.maxLines ?? DIFF_MAX_LINES;
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const script = new EditScript();

  if (leftLines.length > maxLines || rightLines.length > maxLines) {
    coarseScript(leftLines, rightLines, script);
    return { ...materialize(script, leftLines, rightLines), truncated: true };
  }

  const { a, b, count } = intern(leftLines, rightLines);
  const myers = new MyersDiff(a, b, count, script);
  myers.run(DIFF_MAX_EDITS);
  return { ...materialize(script, leftLines, rightLines), truncated: myers.truncated };
}

/** Hidden runs shorter than this are shown instead of being replaced by a marker. */
const MIN_COLLAPSED_RUN = 2;

/** Collapse long runs of 'eq' lines leaving `context` lines around changes; collapsed runs become a single marker. */
export function withContext(
  lines: DiffLine[],
  context?: number,
): Array<DiffLine | { op: 'skip'; count: number }> {
  const keep = Math.max(0, Math.floor(context ?? 3));
  const out: Array<DiffLine | { op: 'skip'; count: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== 'eq') {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].op === 'eq') j++;
    // Leading/trailing runs only need context on the side that touches a change.
    const head = i === 0 ? 0 : keep;
    const tail = j === lines.length ? 0 : keep;
    const hidden = j - i - head - tail;
    if (hidden >= MIN_COLLAPSED_RUN) {
      for (let k = i; k < i + head; k++) out.push(lines[k]);
      out.push({ op: 'skip', count: hidden });
      for (let k = j - tail; k < j; k++) out.push(lines[k]);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}
