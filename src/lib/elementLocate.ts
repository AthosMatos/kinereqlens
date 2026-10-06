/**
 * Element locators, pure part (the page side lives in src/ui/frame/findElements.ts, the panel side in
 * src/ui/control/shot.ts and src/ui/screenshot/valueShot.ts). Unit-tested (tests/unit/element-locate.test.ts).
 *
 *  - Visible text: the page's text nodes, in document order, joined into one case-folded buffer (a space between
 *    blocks and where the page has whitespace, nothing between inline pieces: "<b>1.258</b>.291" reads "1.258.291");
 *    a hit maps back to the text runs it spans, and the page side takes the smallest element holding all of them.
 *  - Labels: aria-label, title, alt, placeholder and form values match as a whole value (exact) or containing the
 *    query (the default), case- and whitespace-insensitive.
 *  - Response values: the JSON path syntax of the overlay ("data.items[0].name") and the kind Find in page gives a
 *    leaf value (string / number / ISO date).
 */
import type { JNode } from '../shared/types';
import type { ElementValueQuery } from '../shared/find-protocol';
import { FIND_MAX_VALUE_CHARS } from '../shared/find-protocol';
import { foldCase, normalizeText, parseIsoDate, segmentAt } from './findInPage';

/** The comparable form of a query or a text: whitespace-normalized and case-folded. */
export function normalizeQuery(text: string): string {
  return foldCase(normalizeText(text));
}

/** Does `value` (a label, a form value) match `query` (already normalized)? Exact: the whole value; else contains it. */
export function labelMatches(value: string | null | undefined, query: string, exact: boolean): boolean {
  if (!value || !query) return false;
  const v = normalizeQuery(value);
  return exact ? v === query : v.includes(query);
}

/** One text node's text, in document order. */
export interface TextRun {
  /** The node's normalized text. */
  text: string;
  /** A space separates it from the previous run (another block, or whitespace in the page's text). */
  spaced: boolean;
}

/** The runs joined: `text` (case-folded) and each run's [start, end) in it. */
export interface RunBuffer {
  text: string;
  starts: number[];
  ends: number[];
}

export function buildRunBuffer(runs: readonly TextRun[]): RunBuffer {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const run of runs) {
    const t = foldCase(run.text);
    if (t && text && run.spaced) text += ' ';
    starts.push(text.length);
    text += t;
    ends.push(text.length);
  }
  return { text, starts, ends };
}

/** A hit of the query in the buffer: the runs it spans (first..last) and its offsets. */
export interface RunHit {
  first: number;
  last: number;
  start: number;
  end: number;
}

/**
 * Index of the run holding buffer offset `offset`: the last run starting at or before it (an empty run shares its
 * start with the run after it, which comes later, so it never wins for an offset holding a character).
 */
function runAt(buf: RunBuffer, offset: number): number {
  return segmentAt(buf.starts, offset);
}

/** Every occurrence of `query` (normalized) in the buffer, at most `max`. */
export function findRunHits(buf: RunBuffer, query: string, max = 1000): RunHit[] {
  const hits: RunHit[] = [];
  if (!query || buf.starts.length === 0) return hits;
  let from = 0;
  while (hits.length < max) {
    const pos = buf.text.indexOf(query, from);
    if (pos < 0) break;
    const end = pos + query.length;
    hits.push({ first: runAt(buf, pos), last: runAt(buf, end - 1), start: pos, end });
    from = pos + 1;
  }
  return hits;
}

/** The buffer text of runs first..last (what an element holding exactly those runs shows). */
export function runsText(buf: RunBuffer, first: number, last: number): string {
  return buf.text.slice(buf.starts[first] ?? 0, buf.ends[last] ?? 0);
}

// ------------------------------------------------------------------------------------------------ matches

/** Which match a command uses: `index` when given (it must exist), else the first visible one, else the first. */
export function pickMatch(matches: ReadonlyArray<{ visible: boolean }>, total: number, index?: number): { index: number } | { error: string } {
  if (total === 0 || matches.length === 0) return { error: 'No element matches' };
  if (index !== undefined) {
    if (!Number.isSafeInteger(index) || index < 0) return { error: `Invalid match index ${index}` };
    if (index >= matches.length) {
      return {
        error:
          index < total
            ? `Match #${index} is beyond the ${matches.length} matches listed — use a more specific locator`
            : `Match #${index} does not exist: ${total} element${total === 1 ? '' : 's'} matched (indexes start at 0)`,
      };
    }
    return { index };
  }
  const visible = matches.findIndex((m) => m.visible);
  return { index: visible >= 0 ? visible : 0 };
}

// ------------------------------------------------------------------------------------------------ values

const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A value the user typed as a locator: an ISO date, a number literal, or text. */
export function valueQueryOf(text: string): ElementValueQuery {
  const value = text.trim();
  if (parseIsoDate(value)) return { kind: 'date', value };
  if (NUMBER_LITERAL.test(value)) return { kind: 'number', value };
  return { kind: 'string', value: text };
}

/** Path segment of `parseValuePath`. */
export type PathSegment = string | number;

/**
 * "data.items[0].name", "[0].name", `a["weird.key"]`, "$.a.b" → segments; null when malformed. Bare digit segments
 * after a dot ("items.0") are array indexes; quoted ones (`["0"]`) are object keys.
 */
export function parseValuePath(text: string): PathSegment[] | null {
  let s = text.trim();
  if (s === '' || s === '$') return [];
  if (s.startsWith('$')) s = s.slice(1);
  const out: PathSegment[] = [];
  let i = 0;
  const ident = /^[^.[\]\s"']+/;
  if (s[0] !== '.' && s[0] !== '[') {
    const m = ident.exec(s);
    if (!m) return null;
    out.push(/^\d+$/.test(m[0]) ? Number(m[0]) : m[0]);
    i = m[0].length;
  }
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      const m = ident.exec(s.slice(i + 1));
      if (!m) return null;
      out.push(/^\d+$/.test(m[0]) ? Number(m[0]) : m[0]);
      i += 1 + m[0].length;
    } else if (ch === '[') {
      const rest = s.slice(i + 1);
      const index = /^\s*(\d+)\s*\]/.exec(rest);
      if (index) {
        out.push(Number(index[1]));
        i += 1 + index[0].length;
        continue;
      }
      const quoted = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\]/.exec(rest);
      if (!quoted) return null;
      const literal = quoted[1]!;
      let key: string;
      try {
        key = literal.startsWith('"') ? (JSON.parse(literal) as string) : literal.slice(1, -1).replace(/\\(.)/g, '$1');
      } catch {
        return null;
      }
      out.push(key);
      i += 1 + quoted[0].length;
    } else return null;
  }
  return out;
}

/** The nearest object key at or above the end of `path` (array items take their array's key). */
export function keyOfPath(path: readonly PathSegment[]): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) if (typeof path[i] === 'string') return path[i] as string;
  return undefined;
}

/** The locator of a JSON leaf, the way Find in page looks for it; an error for values it cannot look for. */
export function valueQueryOfNode(node: JNode, path: readonly PathSegment[]): ElementValueQuery | { error: string } {
  const key = keyOfPath(path);
  const withKey = (q: ElementValueQuery): ElementValueQuery => (key === undefined ? q : { ...q, key });
  if (node.type === 'string') {
    const raw = String(node.value ?? '');
    if (!normalizeText(raw)) return { error: 'That value is an empty string' };
    if (raw.length > FIND_MAX_VALUE_CHARS) return { error: `That string is longer than ${FIND_MAX_VALUE_CHARS} characters` };
    return withKey({ kind: parseIsoDate(raw) ? 'date' : 'string', value: raw });
  }
  if (node.type === 'number') return withKey({ kind: 'number', value: String(node.value ?? '').trim() });
  if (node.type === 'object' || node.type === 'array') return { error: `That path holds ${node.type === 'object' ? 'an object' : 'an array'}: give the path of a single value` };
  return { error: `That path holds ${node.type === 'null' ? 'null' : 'a boolean'}: only strings, numbers and dates can be found on the page` };
}
