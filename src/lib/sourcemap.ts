/**
 * Source map support for the Initiator tab (pure, no DOM, no deps): Base64 VLQ decoding, Source Map v3 parsing
 * (plain and index maps with inline `sections`), generated → original position lookup, `sourceMappingURL`
 * detection, `data:` map URLs, code excerpts and an "enclosing function name" heuristic.
 *
 * Lines and columns are 0-based inside this module (like the spec) unless a name says otherwise; V8 stack
 * frames are 1-based, so callers convert (`line - 1`, `col - 1`).
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i;

/** Decode one Base64 VLQ field list (e.g. "AAgBC" → [0, 0, 16, 1]). Throws on invalid input. */
export function decodeVlq(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? BASE64_VALUE[code]! : -1;
    if (digit < 0) throw new Error(`Invalid VLQ character "${text[i]}"`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      if (shift > 50) throw new Error('VLQ value too large');
      continue;
    }
    const negative = value % 2 === 1;
    const magnitude = Math.floor(value / 2);
    out.push(negative ? -magnitude || 0 : magnitude);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error('Truncated VLQ value');
  return out;
}

/** Encode numbers as Base64 VLQ (tests and fixtures). */
export function encodeVlq(values: readonly number[]): string {
  let out = '';
  for (const v of values) {
    let vlq = v < 0 ? (-v * 2) + 1 : v * 2;
    do {
      let digit = vlq % 32;
      vlq = Math.floor(vlq / 32);
      if (vlq > 0) digit |= 32;
      out += BASE64[digit];
    } while (vlq > 0);
  }
  return out;
}

/**
 * Decoded `mappings`: per generated line, segments of 5 int32 (generated column, source index, original line,
 * original column, name index) with -1 for absent fields, sorted by generated column.
 */
export interface DecodedMappings {
  /** Offset (in segments) of the first segment of each generated line; length = lines + 1. */
  lineStarts: Int32Array;
  /** 5 values per segment. */
  segments: Int32Array;
}

const FIELDS = 5;

/** Decode a whole `mappings` string. Absolute values are reconstructed from the relative VLQ fields. */
export function decodeMappings(mappings: string): DecodedMappings {
  let segments = new Int32Array(Math.max(64, Math.ceil(mappings.length / 3) * FIELDS));
  let count = 0;
  const lineStarts: number[] = [0];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;
  let genCol = 0;
  let lineSorted = true;
  let lineFirst = 0;
  let i = 0;
  const n = mappings.length;
  const fields = [0, 0, 0, 0, 0];
  const finishLine = () => {
    if (!lineSorted) sortSegments(segments, lineFirst, count);
    lineStarts.push(count);
    lineFirst = count;
    lineSorted = true;
    genCol = 0;
  };
  while (i < n) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59 /* ; */) {
      finishLine();
      i++;
      continue;
    }
    if (ch === 44 /* , */) {
      i++;
      continue;
    }
    // One segment: up to 5 VLQ values until ',' / ';' / end.
    let f = 0;
    let value = 0;
    let shift = 0;
    while (i < n) {
      const c = mappings.charCodeAt(i);
      if (c === 44 || c === 59) break;
      const digit = c < 128 ? BASE64_VALUE[c]! : -1;
      if (digit < 0) throw new Error(`Invalid character in mappings at ${i}`);
      i++;
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
        if (shift > 50) throw new Error('VLQ value too large');
        continue;
      }
      const magnitude = Math.floor(value / 2);
      if (f < 5) fields[f] = value % 2 === 1 ? -magnitude : magnitude;
      f++;
      value = 0;
      shift = 0;
    }
    if (shift !== 0) throw new Error('Truncated VLQ value in mappings');
    if (f === 0) continue;
    if (count * FIELDS + FIELDS > segments.length) {
      const bigger = new Int32Array(segments.length * 2);
      bigger.set(segments);
      segments = bigger;
    }
    const at = count * FIELDS;
    const prevCol = genCol;
    genCol += fields[0]!;
    if (count > lineFirst && genCol < prevCol) lineSorted = false;
    segments[at] = genCol;
    if (f >= 4) {
      srcIdx += fields[1]!;
      srcLine += fields[2]!;
      srcCol += fields[3]!;
      segments[at + 1] = srcIdx;
      segments[at + 2] = srcLine;
      segments[at + 3] = srcCol;
      if (f >= 5) {
        nameIdx += fields[4]!;
        segments[at + 4] = nameIdx;
      } else segments[at + 4] = -1;
    } else {
      segments[at + 1] = -1;
      segments[at + 2] = -1;
      segments[at + 3] = -1;
      segments[at + 4] = -1;
    }
    count++;
  }
  finishLine();
  return { lineStarts: Int32Array.from(lineStarts), segments: segments.subarray(0, count * FIELDS) };
}

function sortSegments(segments: Int32Array, from: number, to: number): void {
  const items: number[][] = [];
  for (let s = from; s < to; s++) items.push(Array.from(segments.subarray(s * FIELDS, s * FIELDS + FIELDS)));
  items.sort((a, b) => a[0]! - b[0]!);
  items.forEach((item, k) => segments.set(item, (from + k) * FIELDS));
}

/** An original position (0-based line / column). */
export interface OriginalPosition {
  sourceIndex: number;
  /** Source path as listed in the map, `sourceRoot` applied. */
  source: string;
  line: number;
  column: number;
  name?: string;
  /** The generated column was before the first mapped segment of its line: the nearest one was used. */
  approximate?: boolean;
}

interface BasicMap {
  sources: string[];
  sourcesContent: Array<string | null>;
  names: string[];
  mappings: string;
  decoded: DecodedMappings | null;
}

interface Section {
  line: number;
  column: number;
  map: SourceMapConsumer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinRoot(root: string, source: string): string {
  if (!root || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/')) return source;
  return root.endsWith('/') ? root + source : `${root}/${source}`;
}

/** A parsed Source Map v3 (mappings decoded lazily, on the first lookup). */
export class SourceMapConsumer {
  private readonly basic: BasicMap | null;
  private readonly sections: Section[] | null;

  private constructor(basic: BasicMap | null, sections: Section[] | null) {
    this.basic = basic;
    this.sections = sections;
  }

  /** Parse a map from its JSON text or parsed object. Throws on anything that is not a v3 map. */
  static parse(input: string | unknown): SourceMapConsumer {
    let value: unknown = input;
    if (typeof input === 'string') {
      // Maps may start with the XSSI guard `)]}'`.
      const text = input.startsWith(")]}'") ? input.slice(input.indexOf('\n') + 1) : input;
      value = JSON.parse(text);
    }
    if (!isRecord(value)) throw new Error('Not a source map');
    if (value.version !== 3 && value.version !== '3') throw new Error('Unsupported source map version');
    if (Array.isArray(value.sections)) {
      const sections: Section[] = [];
      for (const s of value.sections) {
        if (!isRecord(s) || !isRecord(s.offset) || !isRecord(s.map)) continue;
        const line = Number(s.offset.line);
        const column = Number(s.offset.column);
        if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
        sections.push({ line, column, map: SourceMapConsumer.parse(s.map) });
      }
      sections.sort((a, b) => a.line - b.line || a.column - b.column);
      return new SourceMapConsumer(null, sections);
    }
    if (typeof value.mappings !== 'string' || !Array.isArray(value.sources)) throw new Error('Source map without mappings');
    const root = typeof value.sourceRoot === 'string' ? value.sourceRoot : '';
    const sources = value.sources.map((s) => (typeof s === 'string' ? joinRoot(root, s) : ''));
    const sourcesContent = Array.isArray(value.sourcesContent)
      ? sources.map((_, i) => {
          const c = (value.sourcesContent as unknown[])[i];
          return typeof c === 'string' ? c : null;
        })
      : sources.map(() => null);
    const names = Array.isArray(value.names) ? value.names.map((n) => (typeof n === 'string' ? n : '')) : [];
    return new SourceMapConsumer({ sources, sourcesContent, names, mappings: value.mappings, decoded: null }, null);
  }

  /** Every source path of the map (sections flattened). */
  get sources(): string[] {
    if (this.basic) return this.basic.sources.slice();
    return (this.sections ?? []).flatMap((s) => s.map.sources);
  }

  /** Original position of a generated (0-based) line / column, or null when it is not mapped. */
  originalPositionFor(line: number, column: number): (OriginalPosition & { content: string | null }) | null {
    if (this.sections) {
      let section: Section | null = null;
      for (const s of this.sections) {
        if (s.line < line || (s.line === line && s.column <= column)) section = s;
        else break;
      }
      if (!section) return null;
      return section.map.originalPositionFor(line - section.line, line === section.line ? column - section.column : column);
    }
    const map = this.basic;
    if (!map || line < 0 || column < 0) return null;
    if (!map.decoded) map.decoded = decodeMappings(map.mappings);
    const { lineStarts, segments } = map.decoded;
    if (line >= lineStarts.length - 1) return null;
    const first = lineStarts[line]!;
    const last = lineStarts[line + 1]! - 1;
    if (last < first) return null;
    // Greatest generated column <= column.
    let lo = first;
    let hi = last;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid * FIELDS]! <= column) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let approximate = false;
    if (found < 0) {
      found = first;
      approximate = true;
    }
    // Skip back over unmapped (1-field) segments.
    while (found >= first && segments[found * FIELDS + 1]! < 0) found--;
    if (found < first) return null;
    const at = found * FIELDS;
    const sourceIndex = segments[at + 1]!;
    const nameIndex = segments[at + 4]!;
    const pos: OriginalPosition & { content: string | null } = {
      sourceIndex,
      source: map.sources[sourceIndex] ?? '',
      line: segments[at + 2]!,
      column: segments[at + 3]!,
      content: map.sourcesContent[sourceIndex] ?? null,
    };
    if (nameIndex >= 0 && map.names[nameIndex]) pos.name = map.names[nameIndex];
    if (approximate) pos.approximate = true;
    return pos;
  }
}

// --------------------------------------------------------------------------------------------- discovery

/**
 * The `sourceMappingURL` of a script (`//# sourceMappingURL=…`, legacy `//@`, or `/*# … *\/`), the last one
 * in the text, or null. Inline `data:` URLs are returned as-is.
 */
export function findSourceMappingUrl(script: string): string | null {
  const key = 'sourceMappingURL=';
  let at = script.length;
  for (let guard = 0; guard < 8; guard++) {
    const index = script.lastIndexOf(key, at);
    if (index < 0) return null;
    at = index - 1;
    // Must be the start of a comment: "//# ", "//@ ", "/*# ", "/*@ ".
    const before = script.slice(Math.max(0, index - 6), index);
    if (!/(?:\/\/|\/\*)[#@]\s*$/.test(before)) continue;
    // Only whitespace and other comments may follow the line it is on... keep it simple: up to whitespace / "*/".
    let end = index + key.length;
    while (end < script.length && !/\s/.test(script[end]!) && !(script[end] === '*' && script[end + 1] === '/')) end++;
    const url = script.slice(index + key.length, end).trim();
    if (url) return url;
  }
  return null;
}

/** Decode a `data:` URL holding a source map (base64 or percent-encoded) to text; null when it is not one. */
export function decodeDataUrl(url: string): string | null {
  const match = /^data:([^,]*),/i.exec(url);
  if (!match) return null;
  const meta = match[1]!.toLowerCase();
  const payload = url.slice(match[0].length);
  try {
    if (meta.split(';').includes('base64')) {
      const binary = atob(payload.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- text helpers

/** Offsets of the start of every line (\n, \r\n and \r line breaks). */
export function lineStartsOf(text: string): Int32Array {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return Int32Array.from(starts);
}

function lineText(text: string, starts: Int32Array, line: number): string {
  const start = starts[line]!;
  const next = line + 1 < starts.length ? starts[line + 1]! : text.length;
  return text.slice(start, next).replace(/\r?\n$|\r$/, '');
}

/** A few lines of code around a position. */
export interface CodeExcerpt {
  /** 1-based number of `lines[0]`. */
  startLine: number;
  lines: string[];
  /** 1-based line of the position. */
  line: number;
  /** 1-based column of the position inside its (possibly clipped) line text. */
  column: number;
  /** Lines were clipped around the column (minified code). */
  clipped?: boolean;
}

const EXCERPT_LINE_MAX = 240;

/** Up to `context` lines before / after the 0-based `line`; long lines are clipped around `column`. */
export function excerptAround(text: string, line: number, column: number, context = 3, starts = lineStartsOf(text)): CodeExcerpt | null {
  if (line < 0 || line >= starts.length) return null;
  const from = Math.max(0, line - context);
  const to = Math.min(starts.length - 1, line + context);
  const lines: string[] = [];
  let clipped = false;
  let focusColumn = column + 1;
  for (let l = from; l <= to; l++) {
    let t = lineText(text, starts, l);
    if (t.length > EXCERPT_LINE_MAX) {
      clipped = true;
      const anchor = l === line ? column : 0;
      const start = Math.max(0, Math.min(anchor - EXCERPT_LINE_MAX / 2, t.length - EXCERPT_LINE_MAX));
      if (l === line) focusColumn = column - start + 1;
      t = t.slice(start, start + EXCERPT_LINE_MAX);
    }
    lines.push(t);
  }
  const excerpt: CodeExcerpt = { startLine: from + 1, lines, line: line + 1, column: focusColumn };
  if (clipped) excerpt.clipped = true;
  return excerpt;
}

/** Offset of a 0-based line / column in `text` (clamped). */
export function offsetOf(starts: Int32Array, text: string, line: number, column: number): number {
  if (line < 0) return 0;
  if (line >= starts.length) return text.length;
  return Math.min(text.length, starts[line]! + Math.max(0, column));
}

/** True when a generated line looks minified (very long). */
export function looksMinified(text: string, line: number, starts = lineStartsOf(text)): boolean {
  if (line < 0 || line >= starts.length) return false;
  const end = line + 1 < starts.length ? starts[line + 1]! : text.length;
  return end - starts[line]! > 1000;
}

// --------------------------------------------------------------------------------------------- enclosing names

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'yield', 'new', 'do', 'else', 'try', 'finally']);
const IDENT_CHAR = /[\w$]/;
const SCAN_LIMIT = 400_000;

function skipSpaceBack(text: string, i: number): number {
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  return i;
}

function identBefore(text: string, end: number): { name: string; start: number } | null {
  let i = end;
  while (i >= 0 && IDENT_CHAR.test(text[i]!)) i--;
  const name = text.slice(i + 1, end + 1);
  return name && !/^\d/.test(name) ? { name, start: i + 1 } : null;
}

/** Index of the "(" matching the ")" at `close`, or -1. */
function matchingOpenParen(text: string, close: number): number {
  let depth = 0;
  for (let i = close, limit = Math.max(0, close - 4000); i >= limit; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** What precedes `start`: `name =` / `name:` / `name(` assignment target name, else null. */
function assignedName(text: string, start: number): string | null {
  let i = skipSpaceBack(text, start - 1);
  // `async` before arrow params / function.
  if (text.slice(Math.max(0, i - 4), i + 1) === 'async') i = skipSpaceBack(text, i - 5);
  const c = text[i];
  if (c === '=' && text[i - 1] !== '=' && text[i - 1] !== '!' && text[i - 1] !== '>' && text[i - 1] !== '<') {
    i = skipSpaceBack(text, i - 1);
    // `const X: FC<Props> = (` — skip a simple type annotation.
    const colonType = /:\s*[\w$.<>,\s[\]|]*$/.exec(text.slice(Math.max(0, i - 120), i + 1));
    if (colonType && !/^\s*$/.test(colonType[0].slice(1))) {
      const j = skipSpaceBack(text, i - colonType[0].length);
      const id = identBefore(text, j);
      if (id) return id.name;
    }
    const id = identBefore(text, i);
    return id ? id.name : null;
  }
  if (c === ':') {
    const id = identBefore(text, skipSpaceBack(text, i - 1));
    return id ? id.name : null;
  }
  return null;
}

/**
 * The function owning the block that opens at `brace` ("{"), when that block is a function body: its name
 * ('' for an anonymous function / arrow), or null when the block is not a function body (if / for / object
 * literal / JSX expression / class body: class bodies return the class name).
 */
function functionNameOfBlock(text: string, brace: number): string | null {
  let i = skipSpaceBack(text, brace - 1);
  if (i < 0) return null;
  // Arrow function with a block body: `(...) => {` / `x => {`.
  if (text[i] === '>' && text[i - 1] === '=') {
    i = skipSpaceBack(text, i - 2);
    // `(): Type => {`: skip a return type annotation.
    const typed = /\)\s*:\s*[^()=;{}]*$/.exec(text.slice(Math.max(0, i - 160), i + 1));
    if (typed && text[i] !== ')') i = i - typed[0].length + 1;
    let start: number;
    if (text[i] === ')') {
      start = matchingOpenParen(text, i);
      if (start < 0) return '';
    } else {
      const id = identBefore(text, i);
      if (!id) return '';
      start = id.start;
    }
    return assignedName(text, start) ?? '';
  }
  // `function name(...) {`, `name(...) {` (method), `function (...) {` assigned to a name.
  const typed = /\)\s*:\s*[^(){};=]*$/.exec(text.slice(Math.max(0, i - 160), i + 1));
  if (typed && text[i] !== ')') i = i - typed[0].length + 1;
  if (text[i] === ')') {
    const open = matchingOpenParen(text, i);
    if (open < 0) return null;
    let j = skipSpaceBack(text, open - 1);
    // Generic parameters `name<T>(`.
    if (text[j] === '>') {
      const lt = text.lastIndexOf('<', j);
      if (lt > 0 && j - lt < 200) j = skipSpaceBack(text, lt - 1);
    }
    const id = identBefore(text, j);
    if (!id) return null;
    if (id.name === 'function') return assignedName(text, id.start) ?? '';
    if (CONTROL_WORDS.has(id.name)) return null;
    const before = skipSpaceBack(text, id.start - 1);
    // `function name(` / `function* name(`.
    const kw = text.slice(Math.max(0, before - 8), before + 1);
    if (/function\s*\*?$/.test(kw) || /function$/.test(kw)) return id.name;
    // A call `foo(...) {` is not valid JS; in practice this is a method `name(...) {` (class / object literal).
    if (text[before] === '.') return null;
    return id.name;
  }
  // Class body: `class Name extends Base {`.
  const head = text.slice(Math.max(0, i - 300), i + 1);
  const cls = /class\s+([A-Za-z_$][\w$]*)[^{};()]*$/.exec(head);
  if (cls) return cls[1]!;
  return null;
}

/**
 * Names of the functions enclosing a 0-based line / column of `text`, innermost first (anonymous functions are
 * skipped), at most `max`. A brace-counting heuristic (strings and comments are not parsed), good enough to
 * find the component around a `useEffect(() => { fetch(…) })` callback.
 */
export function enclosingFunctionNames(text: string, line: number, column: number, max = 6, starts = lineStartsOf(text)): string[] {
  const names: string[] = [];
  let i = offsetOf(starts, text, line, column) - 1;
  const limit = Math.max(0, i - SCAN_LIMIT);
  let depth = 0;
  for (; i >= limit && names.length < max; i--) {
    const c = text.charCodeAt(i);
    if (c === 125 /* } */) depth++;
    else if (c === 123 /* { */) {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = functionNameOfBlock(text, i);
      if (name) names.push(name);
    }
  }
  return names;
}
