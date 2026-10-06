// OWNER: ui-export agent. Tiny, safe syntax colouring for the Export tab: generated TypeScript / Zod, JSON Schema
// and the agent prompt (markdown with fenced code). Pure: it only splits text into classified pieces; the view
// renders each piece as a text node inside a <span> (never as HTML).
//
// Invariant: joining every token's text of every line with '\n' gives back the input exactly.

/** Token classes (CSS: `.rl-tok--<kind>`); '' = plain text. */
export type TokenKind = '' | 'kw' | 'type' | 'key' | 'str' | 'num' | 'lit' | 'com' | 'fn' | 'h' | 'fence' | 'code';

export interface Token {
  k: TokenKind;
  t: string;
}

/** One rendered line (no '\n' inside any token). */
export type Line = Token[];

export type CodeLanguage = 'ts' | 'json' | 'plain';

const TS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'class',
  'const',
  'declare',
  'default',
  'enum',
  'export',
  'extends',
  'from',
  'function',
  'implements',
  'import',
  'in',
  'infer',
  'interface',
  'keyof',
  'let',
  'namespace',
  'new',
  'readonly',
  'return',
  'satisfies',
  'type',
  'typeof',
  'var',
]);
const TS_LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const TS_BUILTIN_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'unknown', 'any', 'never', 'void']);

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Index of the next non-blank character at or after `i` (spaces/tabs only, stays on the line). */
function skipBlanks(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/** `key:` / `key?:` follows at `i` (property keys in interfaces, object literals and JSON). */
function keyFollows(s: string, i: number): boolean {
  let j = skipBlanks(s, i);
  if (s[j] === '?') j++;
  return s[j] === ':';
}

/** End (exclusive) of a quoted string starting at `start`; single/double quotes stop at the line end. */
function stringEnd(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n' && quote !== '`') return i;
    i++;
  }
  return s.length;
}

/** End (exclusive) of a number literal starting at `start` (optional leading '-', fraction, exponent, BigInt n). */
function numberEnd(s: string, start: number): number {
  const m = /^-?(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/.exec(s.slice(start, start + 400));
  return m ? start + m[0].length : start + 1;
}

class TokenSink {
  readonly tokens: Token[] = [];

  push(k: TokenKind, t: string): void {
    if (!t) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.k === k) last.t += t;
    else this.tokens.push({ k, t });
  }
}

/** Flat tokens of TypeScript-like source (also used for Zod output). */
export function tokenizeTs(src: string): Token[] {
  const out = new TokenSink();
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out.push('com', src.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out.push('com', src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      const stop = stringEnd(src, i);
      out.push(keyFollows(src, stop) ? 'key' : 'str', src.slice(i, stop));
      i = stop;
    } else if (isDigit(c) && !isIdentPart(src[i - 1] ?? ' ')) {
      const stop = numberEnd(src, i);
      out.push('num', src.slice(i, stop));
      i = stop;
    } else if (isIdentStart(c)) {
      let stop = i + 1;
      while (stop < src.length && isIdentPart(src[stop]!)) stop++;
      const word = src.slice(i, stop);
      out.push(classifyWord(src, i, stop, word), word);
      i = stop;
    } else {
      out.push('', c);
      i++;
    }
  }
  return out.tokens;
}

function classifyWord(src: string, start: number, stop: number, word: string): TokenKind {
  const prev = src[start - 1];
  const afterDot = prev === '.';
  // A word followed by ':' is a property name, even a keyword one (`type: string`).
  if (!afterDot && keyFollows(src, stop)) return 'key';
  if (!afterDot && TS_KEYWORDS.has(word)) return 'kw';
  if (TS_LITERALS.has(word)) return 'lit';
  if (src[skipBlanks(src, stop)] === '(') return 'fn';
  if (TS_BUILTIN_TYPES.has(word)) return 'type';
  if (!afterDot && /^[A-Z]/.test(word)) return 'type';
  return '';
}

/** Flat tokens of JSON (keys, strings, numbers, true/false/null). Tolerates invalid JSON. */
export function tokenizeJson(src: string): Token[] {
  const out = new TokenSink();
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      const stop = stringEnd(src, i);
      out.push(keyFollows(src, stop) ? 'key' : 'str', src.slice(i, stop));
      i = stop;
    } else if (isDigit(c) || (c === '-' && isDigit(src[i + 1] ?? ''))) {
      const stop = numberEnd(src, i);
      out.push('num', src.slice(i, stop));
      i = stop;
    } else if (isIdentStart(c)) {
      let stop = i + 1;
      while (stop < src.length && isIdentPart(src[stop]!)) stop++;
      const word = src.slice(i, stop);
      out.push(word === 'true' || word === 'false' || word === 'null' ? 'lit' : '', word);
      i = stop;
    } else {
      out.push('', c);
      i++;
    }
  }
  return out.tokens;
}

/** Split flat tokens into lines (tokens spanning line breaks, e.g. block comments, are cut at each '\n'). */
export function toLines(tokens: Token[]): Line[] {
  const lines: Line[] = [[]];
  for (const tok of tokens) {
    const parts = tok.t.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push([]);
      const text = parts[p]!;
      if (text) lines[lines.length - 1]!.push({ k: tok.k, t: text });
    }
  }
  return lines;
}

/** Lines of classified tokens for generated code. */
export function highlightCode(src: string, lang: CodeLanguage): Line[] {
  if (lang === 'ts') return toLines(tokenizeTs(src));
  if (lang === 'json') return toLines(tokenizeJson(src));
  return src.split('\n').map((t) => (t ? [{ k: '', t }] : []));
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;

function fenceLanguage(info: string): CodeLanguage {
  const lang = info.toLowerCase();
  if (lang === 'ts' || lang === 'typescript' || lang === 'tsx' || lang === 'js' || lang === 'javascript') return 'ts';
  if (lang === 'json' || lang === 'jsonc') return 'json';
  return 'plain';
}

/** One markdown prose line: headings, HTML comments, `inline code`. */
function markdownLine(line: string): Line {
  if (/^#{1,6}\s/.test(line)) return [{ k: 'h', t: line }];
  if (/^\s*<!--.*-->\s*$/.test(line)) return [{ k: 'com', t: line }];
  const out = new TokenSink();
  const re = /`[^`\n]+`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push('', line.slice(last, m.index));
    out.push('code', m[0]);
    last = m.index + m[0].length;
  }
  out.push('', line.slice(last));
  return out.tokens;
}

/**
 * Lines of the agent prompt: headings, HTML comments and inline code are classified; fenced blocks keep their
 * fences as `fence` tokens and colour their content by the fence language (ts / json), other prose stays plain.
 */
export function highlightMarkdown(src: string): Line[] {
  const lines = src.split('\n');
  const out: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE.exec(line);
    if (!open) {
      out.push(markdownLine(line));
      i++;
      continue;
    }
    const marker = open[1]!;
    out.push([{ k: 'fence', t: line }]);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trimStart().startsWith(marker)) body.push(lines[j++]!);
    if (body.length) out.push(...highlightCode(body.join('\n'), fenceLanguage(open[2] ?? '')));
    if (j < lines.length) out.push([{ k: 'fence', t: lines[j]! }]);
    i = j + 1;
  }
  return out;
}

/** The text of highlighted lines (inverse of the highlighters; used by tests and Copy fallbacks). */
export function linesToText(lines: Line[]): string {
  return lines.map((line) => line.map((tok) => tok.t).join('')).join('\n');
}
