// OWNER: lib-json agent. Lossless editable JSON tree (see JNode in shared/types.ts).
//
// Requirements:
//  - parseJsonTree is a hand-written RFC 8259 parser (NOT JSON.parse): keeps number literal text exactly
//    (e.g. 12345678901234567890, 1.0, 1e3), keeps key order and duplicate keys, decodes string escapes
//    (incl. surrogate pairs), reports errors with offset/line/column, rejects trailing garbage, tolerates a
//    leading UTF-8 BOM and surrounding whitespace. Iterative or depth-guarded (no stack overflow at depth ~10k).
//  - serializeJsonTree emits number literals verbatim and strings via JSON-escaping;
//    serialize(parse(x), compact) === minified x for valid input.
//  - All mutators are immutable (return a new root, untouched subtrees keep object identity) and keep ids stable.
//
// Implementation notes:
//  - Every traversal in this module is iterative (explicit stacks), so arbitrarily deep documents
//    (100k+ levels) never overflow the call stack.
//  - Mutators locate the target once, then copy only the nodes on the root -> target path
//    (structural sharing); every sibling subtree keeps its object identity, which the UI relies on
//    for memoization.
//  - Only `object` / `array` nodes are treated as having children; a stray `children` array on a
//    scalar node is ignored everywhere (serialization, traversal, diff).
import type { JNode, JNodeType } from '../shared/types';
import { uid } from './ids';

export class JsonParseError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const ID_PREFIX = 'j';
const NO_CHILDREN: readonly JNode[] = Object.freeze([]);
const NODE_TYPES: ReadonlySet<string> = new Set<JNodeType>(['object', 'array', 'string', 'number', 'boolean', 'null']);
const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/;

/** True for `object` and `array` nodes. */
export function isContainerNode(node: JNode): boolean {
  return node.type === 'object' || node.type === 'array';
}

/** Children of a container (empty for scalars and for containers without a `children` array). */
function kids(node: JNode): readonly JNode[] {
  return (node.type === 'object' || node.type === 'array') && node.children ? node.children : NO_CHILDREN;
}

function isNodeType(type: unknown): type is JNodeType {
  return typeof type === 'string' && NODE_TYPES.has(type);
}

/** New node with a fresh id; `key` is only set when defined (object children). */
function makeNode(type: JNodeType, key: string | undefined): JNode {
  const node: JNode = { id: uid(ID_PREFIX), type };
  if (key !== undefined) node.key = key;
  return node;
}

/** The key that is meaningful for serialization: object children have one ('' when missing), others none. */
function effectiveKey(node: JNode, parent: JNode | null): string | undefined {
  return parent !== null && parent.type === 'object' ? (node.key ?? '') : undefined;
}

/** Copy of `node` without its `key` (same id, value and children array). */
function withoutKey(node: JNode): JNode {
  if (node.key === undefined) return node;
  const copy: JNode = { id: node.id, type: node.type };
  if (node.value !== undefined) copy.value = node.value;
  if (node.children !== undefined) copy.children = node.children;
  return copy;
}

/** Copy of `node` with `key` (returns the node itself when the key is already equal). */
function withKey(node: JNode, key: string): JNode {
  return node.key === key ? node : { ...node, key };
}

/**
 * Pre-order, document-order traversal. Returning `false` from `visit` skips that node's children.
 * Iterative, so depth is unbounded.
 */
function forEachNode(root: JNode, visit: (node: JNode, parent: JNode | null) => boolean | void): void {
  const nodes: JNode[] = [root];
  const parents: Array<JNode | null> = [null];
  while (nodes.length > 0) {
    const node = nodes.pop() as JNode;
    const parent = parents.pop() as JNode | null;
    if (visit(node, parent) === false) continue;
    const children = kids(node);
    for (let i = children.length - 1; i >= 0; i--) {
      nodes.push(children[i]);
      parents.push(node);
    }
  }
}

/** True when any node of the subtree satisfies `predicate` (stops at the first match). */
function someNode(root: JNode, predicate: (node: JNode) => boolean): boolean {
  const stack: JNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as JNode;
    if (predicate(node)) return true;
    const children = kids(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return false;
}

/** Next key of the form base, base+sep+2, base+sep+3, ... that no sibling uses. */
function uniqueKey(siblings: readonly JNode[], base: string, separator: string): string {
  const used = new Set<string>();
  for (const sibling of siblings) used.add(sibling.key ?? '');
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${separator}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_APOSTROPHE = 0x27;
const CH_PLUS = 0x2b;
const CH_COMMA = 0x2c;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_SLASH = 0x2f;
const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_COLON = 0x3a;
const CH_UPPER_E = 0x45;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_LOWER_E = 0x65;
const CH_LOWER_F = 0x66;
const CH_LOWER_N = 0x6e;
const CH_LOWER_T = 0x74;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_BOM = 0xfeff;

/** Single-character escapes (index = char code after the backslash). */
const SIMPLE_ESCAPES: Record<number, string> = {
  0x22: '"',
  0x5c: '\\',
  0x2f: '/',
  0x62: '\b',
  0x66: '\f',
  0x6e: '\n',
  0x72: '\r',
  0x74: '\t',
};

/** An open container while parsing. */
interface ParseFrame {
  children: JNode[];
  object: boolean;
  /** Offset of the opening bracket (for "unclosed" hints). */
  start: number;
}

const isDigit = (c: number): boolean => c >= CH_0 && c <= CH_9;

const isIdentifierStart = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24;

function hexValue(c: number): number {
  if (c >= CH_0 && c <= CH_9) return c - CH_0;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** 1-based line and column (UTF-16 code units) of `offset`. CRLF, LF and lone CR each end a line. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === CH_LF || (c === CH_CR && text.charCodeAt(i + 1) !== CH_LF)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function codePointName(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Human description of the character at `offset`, e.g. `'}'`, `"'"` or `character U+00A0`. */
function describeChar(text: string, offset: number): string {
  const cp = text.codePointAt(offset) ?? 0;
  const invisible =
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0xa0) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x200b ||
    cp === CH_BOM;
  if (invisible) return `character ${codePointName(cp)}`;
  if (cp === CH_APOSTROPHE) return `"'"`;
  return `'${String.fromCodePoint(cp)}'`;
}

/**
 * Single-pass RFC 8259 parser producing JNode trees. Containers are tracked on an explicit stack, so
 * nesting depth is limited only by memory.
 */
class TreeParser {
  private pos = 0;
  private readonly len: number;
  private readonly frames: ParseFrame[] = [];

  constructor(private readonly text: string) {
    this.len = text.length;
  }

  parse(): JNode {
    const text = this.text;
    const len = this.len;
    const frames = this.frames;
    if (len > 0 && text.charCodeAt(0) === CH_BOM) this.pos = 1;

    let root: JNode | null = null;
    /** Key for the next value (set after `"key":` inside objects, undefined inside arrays / at the root). */
    let key: string | undefined;

    value: for (;;) {
      this.skipWhitespace();
      if (this.pos >= len) this.failEnd();
      const c = text.charCodeAt(this.pos);
      const parent = frames.length > 0 ? frames[frames.length - 1] : null;

      if (c === CH_LBRACE || c === CH_LBRACKET) {
        const object = c === CH_LBRACE;
        const children: JNode[] = [];
        const node = makeNode(object ? 'object' : 'array', key);
        node.children = children;
        if (parent) parent.children.push(node);
        else root = node;
        const start = this.pos++;
        this.skipWhitespace();
        if (this.pos < len && text.charCodeAt(this.pos) === (object ? CH_RBRACE : CH_RBRACKET)) {
          this.pos++; // empty container: complete right away
        } else {
          frames.push({ children, object, start });
          key = object ? this.readKey(false) : undefined;
          continue value;
        }
      } else {
        const node = this.readScalar(c, key);
        if (parent) parent.children.push(node);
        else root = node;
      }

      // A value just completed: consume separators and closing brackets until another value is due.
      for (;;) {
        const top = frames.length > 0 ? frames[frames.length - 1] : null;
        if (!top) break value;
        this.skipWhitespace();
        if (this.pos >= len) this.failEnd();
        const d = text.charCodeAt(this.pos);
        if (d === CH_COMMA) {
          this.pos++;
          if (top.object) {
            key = this.readKey(true);
          } else {
            key = undefined;
            this.rejectTrailingComma(CH_RBRACKET);
          }
          continue value;
        }
        if (d === (top.object ? CH_RBRACE : CH_RBRACKET)) {
          this.pos++;
          frames.pop();
          continue;
        }
        this.failUnexpected(this.pos, top.object ? "expected ',' or '}'" : "expected ',' or ']'");
      }
    }

    this.skipWhitespace();
    if (this.pos < len) this.failUnexpected(this.pos, 'extra data after the JSON value');
    if (!root) this.failEnd(); // unreachable: the loop only exits after a complete root value
    return root;
  }

  private skipWhitespace(): void {
    const text = this.text;
    const len = this.len;
    let i = this.pos;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c !== CH_SPACE && c !== CH_LF && c !== CH_CR && c !== CH_TAB) break;
      i++;
    }
    this.pos = i;
  }

  /** Reads `"name"` + `:` and returns the decoded name. */
  private readKey(afterComma: boolean): string {
    this.skipWhitespace();
    if (this.pos >= this.len) this.failEnd();
    const c = this.text.charCodeAt(this.pos);
    if (c !== CH_QUOTE) {
      let hint: string;
      if (afterComma && c === CH_RBRACE) hint = 'trailing commas are not allowed';
      else if (c === CH_APOSTROPHE) hint = 'property names must use double quotes';
      else if (isIdentifierStart(c)) hint = 'property names must be double-quoted';
      else hint = 'expected a double-quoted property name';
      this.failUnexpected(this.pos, hint);
    }
    const key = this.readString();
    this.skipWhitespace();
    if (this.pos >= this.len) this.failEnd();
    if (this.text.charCodeAt(this.pos) !== CH_COLON) {
      this.failUnexpected(this.pos, "expected ':' after the property name");
    }
    this.pos++;
    return key;
  }

  private rejectTrailingComma(close: number): void {
    this.skipWhitespace();
    if (this.pos < this.len && this.text.charCodeAt(this.pos) === close) {
      this.failUnexpected(this.pos, 'trailing commas are not allowed');
    }
  }

  private readScalar(c: number, key: string | undefined): JNode {
    if (c === CH_QUOTE) {
      const node = makeNode('string', key);
      node.value = this.readString();
      return node;
    }
    if (c === CH_MINUS || isDigit(c)) {
      const node = makeNode('number', key);
      node.value = this.readNumber();
      return node;
    }
    if (c === CH_LOWER_T || c === CH_LOWER_F) {
      const truthy = c === CH_LOWER_T;
      this.readLiteral(truthy ? 'true' : 'false');
      const node = makeNode('boolean', key);
      node.value = truthy;
      return node;
    }
    if (c === CH_LOWER_N) {
      this.readLiteral('null');
      return makeNode('null', key);
    }
    let hint = 'expected a JSON value';
    if (c === CH_APOSTROPHE) hint = 'strings must use double quotes';
    else if (/^(?:NaN|Infinity|undefined)/.test(this.text.slice(this.pos, this.pos + 9))) {
      hint = 'NaN, Infinity and undefined are not valid JSON';
    }
    this.failUnexpected(this.pos, hint);
  }

  private readLiteral(word: string): void {
    for (let k = 0; k < word.length; k++) {
      const at = this.pos + k;
      if (at >= this.len) this.failEnd();
      if (this.text.charCodeAt(at) !== word.charCodeAt(k)) this.failUnexpected(at);
    }
    this.pos += word.length;
  }

  /** Reads a string starting at the opening quote; returns the decoded value. */
  private readString(): string {
    const text = this.text;
    const len = this.len;
    const quoteAt = this.pos;
    let i = quoteAt + 1;
    let chunkStart = i;
    let out = '';
    for (;;) {
      if (i >= len) this.fail('Unterminated string', quoteAt);
      const c = text.charCodeAt(i);
      if (c === CH_QUOTE) {
        this.pos = i + 1;
        return chunkStart === i ? out : out + text.slice(chunkStart, i);
      }
      if (c === CH_BACKSLASH) {
        if (i > chunkStart) out += text.slice(chunkStart, i);
        if (i + 1 >= len) this.fail('Unterminated string', quoteAt);
        const e = text.charCodeAt(i + 1);
        const simple = SIMPLE_ESCAPES[e];
        if (simple !== undefined) {
          out += simple;
          i += 2;
        } else if (e === 0x75 /* u */) {
          out += String.fromCharCode(this.readHex4(i));
          i += 6;
        } else {
          this.fail(`Invalid escape ${describeEscape(text, i + 1)} in string`, i);
        }
        chunkStart = i;
        continue;
      }
      if (c < CH_SPACE) this.fail(`Unescaped control character ${codePointName(c)} in string`, i);
      i++;
    }
  }

  /** Value of the 4 hex digits following `\u` at `backslashAt` (lone surrogates are allowed, like JSON.parse). */
  private readHex4(backslashAt: number): number {
    let value = 0;
    for (let k = 2; k < 6; k++) {
      const at = backslashAt + k;
      const digit = at < this.len ? hexValue(this.text.charCodeAt(at)) : -1;
      if (digit < 0) this.fail('Invalid Unicode escape', backslashAt);
      value = value * 16 + digit;
    }
    return value;
  }

  /** Reads a number literal and returns its exact text. */
  private readNumber(): string {
    const text = this.text;
    const len = this.len;
    const start = this.pos;
    let i = start;
    if (text.charCodeAt(i) === CH_MINUS) i++;
    const first = i < len ? text.charCodeAt(i) : -1;
    if (first === CH_0) {
      i++;
      if (i < len && isDigit(text.charCodeAt(i))) this.fail('Leading zeros are not allowed', i - 1);
    } else if (isDigit(first)) {
      i++;
      while (i < len && isDigit(text.charCodeAt(i))) i++;
    } else {
      this.fail("Expected a digit after '-'", i);
    }
    if (i < len && text.charCodeAt(i) === CH_DOT) {
      i++;
      if (!(i < len && isDigit(text.charCodeAt(i)))) this.fail('Expected a digit after the decimal point', i);
      while (i < len && isDigit(text.charCodeAt(i))) i++;
    }
    const e = i < len ? text.charCodeAt(i) : -1;
    if (e === CH_LOWER_E || e === CH_UPPER_E) {
      i++;
      const sign = i < len ? text.charCodeAt(i) : -1;
      if (sign === CH_PLUS || sign === CH_MINUS) i++;
      if (!(i < len && isDigit(text.charCodeAt(i)))) this.fail('Expected a digit in the exponent', i);
      while (i < len && isDigit(text.charCodeAt(i))) i++;
    }
    this.pos = i;
    return text.slice(start, i);
  }

  private failEnd(): never {
    const frames = this.frames;
    let hint: string | undefined;
    if (frames.length > 0) {
      const open = frames[frames.length - 1];
      const at = lineColumn(this.text, open.start);
      hint = `unclosed '${open.object ? '{' : '['}' at line ${at.line}, column ${at.column}`;
    }
    this.fail('Unexpected end of JSON input', this.len, hint);
  }

  private failUnexpected(offset: number, hint?: string): never {
    const effectiveHint = this.text.charCodeAt(offset) === CH_SLASH ? 'comments are not allowed in JSON' : hint;
    this.fail(`Unexpected ${describeChar(this.text, offset)}`, offset, effectiveHint);
  }

  private fail(what: string, offset: number, hint?: string): never {
    const { line, column } = lineColumn(this.text, offset);
    const suffix = hint ? ` (${hint})` : '';
    throw new JsonParseError(`${what} at line ${line}, column ${column}${suffix}`, offset, line, column);
  }
}

function describeEscape(text: string, at: number): string {
  const c = text.charCodeAt(at);
  return c < CH_SPACE ? `\\ followed by ${codePointName(c)}` : `'\\${String.fromCodePoint(text.codePointAt(at) ?? c)}'`;
}

/**
 * Parse JSON text into a lossless tree. Throws JsonParseError. Assigns fresh ids to every node.
 *
 * Strict RFC 8259: no comments, trailing commas, single quotes, unquoted keys, leading zeros,
 * NaN/Infinity or raw control characters in strings. A leading BOM and surrounding whitespace are
 * accepted. Error offsets are UTF-16 indices into `text`; line/column are 1-based.
 * Error messages look like "Unexpected '}' at line 3, column 5 (trailing commas are not allowed)".
 */
export function parseJsonTree(text: string): JNode {
  return new TreeParser(typeof text === 'string' ? text : String(text)).parse();
}

/** Like parseJsonTree but returns null instead of throwing. */
export function tryParseJsonTree(text: string): JNode | null {
  try {
    return parseJsonTree(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Serialization / conversion
// ---------------------------------------------------------------------------------------------

/** Longest indent unit JSON.stringify honours (longer numbers are clamped, longer strings truncated). */
const MAX_INDENT = 10;

/** Indent unit exactly as JSON.stringify derives it from its `space` argument ('' means compact). */
function indentUnit(indent: number | string | undefined): string {
  if (typeof indent === 'number') {
    return indent >= 1 ? ' '.repeat(Math.min(MAX_INDENT, Math.floor(indent))) : ''; // NaN fails the comparison
  }
  return typeof indent === 'string' ? indent.slice(0, MAX_INDENT) : '';
}

function scalarText(node: JNode): string {
  switch (node.type) {
    case 'string':
      return JSON.stringify(typeof node.value === 'string' ? node.value : String(node.value ?? ''));
    case 'number':
      return typeof node.value === 'string' ? node.value : String(node.value ?? '');
    case 'boolean':
      return node.value === true ? 'true' : 'false';
    default:
      return 'null';
  }
}

/**
 * Serialize a tree. indent undefined/0 -> compact; number -> that many spaces; string -> used as indent
 * unit. The indented layout matches JSON.stringify(value, null, indent) (empty containers as `{}` / `[]`;
 * like JSON.stringify, the indent unit is capped at 10 characters).
 * Strings are escaped exactly like JSON.stringify; number literals are emitted verbatim, even when they
 * are invalid while being edited (see treeErrors). Iterative: safe for any depth.
 */
export function serializeJsonTree(node: JNode, indent?: number | string): string {
  if (!isContainerNode(node)) return scalarText(node);
  if (kids(node).length === 0) return node.type === 'object' ? '{}' : '[]';

  const unit = indentUnit(indent);
  const colon = unit ? ': ' : ':';
  const pads: string[] = [''];
  const pad = (depth: number): string => (pads[depth] ??= unit.repeat(depth));

  const stack: JNode[] = [node];
  const nextIndex: number[] = [0];
  let out = node.type === 'object' ? '{' : '[';
  while (stack.length > 0) {
    const depth = stack.length - 1;
    const parent = stack[depth];
    const children = kids(parent);
    const i = nextIndex[depth];
    if (i < children.length) {
      nextIndex[depth] = i + 1;
      const child = children[i];
      if (i > 0) out += ',';
      if (unit) out += '\n' + pad(depth + 1);
      if (parent.type === 'object') out += JSON.stringify(child.key ?? '') + colon;
      if (child.type === 'object' || child.type === 'array') {
        const isObject = child.type === 'object';
        if (kids(child).length === 0) {
          out += isObject ? '{}' : '[]';
        } else {
          out += isObject ? '{' : '[';
          stack.push(child);
          nextIndex.push(0);
        }
      } else {
        out += scalarText(child);
      }
    } else {
      stack.pop();
      nextIndex.pop();
      if (unit) out += '\n' + pad(depth);
      out += parent.type === 'object' ? '}' : ']';
    }
  }
  return out;
}

function scalarValue(node: JNode): unknown {
  switch (node.type) {
    case 'string':
      return typeof node.value === 'string' ? node.value : String(node.value ?? '');
    case 'number':
      return Number(node.value);
    case 'boolean':
      return node.value === true;
    default:
      return null;
  }
}

type PlainContainer = unknown[] | Record<string, unknown>;

/** Own data property assignment that also works for "__proto__" (like JSON.parse). */
function assignProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/**
 * Convert to a plain JS value (numbers via Number(); may lose precision — display only).
 * Duplicate keys: the last occurrence wins (like JSON.parse). Iterative: safe for any depth.
 */
export function jsonTreeToValue(node: JNode): unknown {
  if (!isContainerNode(node)) return scalarValue(node);
  const rootValue: PlainContainer = node.type === 'array' ? [] : {};
  const work: Array<[JNode, PlainContainer]> = [[node, rootValue]];
  while (work.length > 0) {
    const [source, target] = work.pop() as [JNode, PlainContainer];
    for (const child of kids(source)) {
      let value: unknown;
      if (isContainerNode(child)) {
        const container: PlainContainer = child.type === 'array' ? [] : {};
        work.push([child, container]);
        value = container;
      } else {
        value = scalarValue(child);
      }
      if (Array.isArray(target)) target.push(value);
      else assignProperty(target, child.key ?? '', value);
    }
  }
  return rootValue;
}

/** Applies toJSON() and unboxes Number/String/Boolean objects, like JSON.stringify. */
function toJsonCompatible(value: unknown, key: string): unknown {
  let v = value;
  if (typeof v === 'object' && v !== null) {
    const toJSON: unknown = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = (toJSON as (this: unknown, key: string) => unknown).call(v, key);
  }
  if (v instanceof Number || v instanceof String || v instanceof Boolean) v = v.valueOf();
  return v;
}

function scalarNodeFromValue(value: unknown, key: string | undefined): JNode {
  switch (typeof value) {
    case 'string': {
      const node = makeNode('string', key);
      node.value = value;
      return node;
    }
    case 'number': {
      if (!Number.isFinite(value)) return makeNode('null', key);
      const node = makeNode('number', key);
      node.value = String(value);
      return node;
    }
    case 'bigint': {
      const node = makeNode('number', key);
      node.value = value.toString();
      return node;
    }
    case 'boolean': {
      const node = makeNode('boolean', key);
      node.value = value;
      return node;
    }
    default:
      return makeNode('null', key);
  }
}

type BuildTask =
  | { value: unknown; key: string | undefined; toJsonKey: string; into: JNode[] | null }
  | { exit: object };

/**
 * Build a tree from a JS value (fresh ids). Non-JSON values (undefined, functions, symbols, NaN,
 * Infinity) become null; bigint becomes an exact number literal; toJSON() is honoured; a circular
 * reference becomes null. Iterative: safe for any depth.
 */
export function valueToJsonTree(value: unknown, key?: string): JNode {
  let root: JNode | null = null;
  const onPath = new Set<object>();
  const tasks: BuildTask[] = [{ value, key, toJsonKey: key ?? '', into: null }];
  while (tasks.length > 0) {
    const task = tasks.pop() as BuildTask;
    if ('exit' in task) {
      onPath.delete(task.exit);
      continue;
    }
    const v = toJsonCompatible(task.value, task.toJsonKey);
    let node: JNode;
    if (typeof v === 'object' && v !== null && !onPath.has(v)) {
      const children: JNode[] = [];
      onPath.add(v);
      tasks.push({ exit: v });
      if (Array.isArray(v)) {
        node = makeNode('array', task.key);
        const items = v as readonly unknown[];
        for (let i = items.length - 1; i >= 0; i--) {
          tasks.push({ value: items[i], key: undefined, toJsonKey: String(i), into: children });
        }
      } else {
        node = makeNode('object', task.key);
        const record = v as Record<string, unknown>;
        const keys = Object.keys(record);
        for (let i = keys.length - 1; i >= 0; i--) {
          tasks.push({ value: record[keys[i]], key: keys[i], toJsonKey: keys[i], into: children });
        }
      }
      node.children = children;
    } else {
      node = scalarNodeFromValue(v, task.key);
    }
    if (task.into) task.into.push(node);
    else root = node;
  }
  return root as JNode; // the first task always produces the root
}

/** Deep clone. keepIds=false (the default) assigns fresh ids. Iterative: safe for any depth. */
export function cloneTree(node: JNode, keepIds?: boolean): JNode {
  const copy = (source: JNode): JNode => {
    const out: JNode = { id: keepIds ? source.id : uid(ID_PREFIX), type: source.type };
    if (source.key !== undefined) out.key = source.key;
    if (source.value !== undefined) out.value = source.value;
    return out;
  };
  const rootCopy = copy(node);
  const work: Array<[JNode, JNode]> = [[node, rootCopy]];
  while (work.length > 0) {
    const [source, target] = work.pop() as [JNode, JNode];
    if (!source.children) continue;
    const children = new Array<JNode>(source.children.length);
    for (let i = 0; i < source.children.length; i++) {
      const child = source.children[i];
      const childCopy = copy(child);
      children[i] = childCopy;
      if (child.children) work.push([child, childCopy]);
    }
    target.children = children;
  }
  return rootCopy;
}

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

export interface NodeLocation {
  node: JNode;
  parent: JNode | null;
  /** Index of the node in `parent.children`; -1 for the root. */
  index: number;
  /** Path from the root, object keys and array indices. */
  path: Array<string | number>;
}

/** Root -> target chain: nodes[0] is the root, indices[k] is the index of nodes[k + 1] in nodes[k]. */
interface Chain {
  nodes: JNode[];
  indices: number[];
}

/** Locate a node by id (iterative DFS that keeps the current root -> node chain). */
function locateChain(root: JNode, id: string): Chain | null {
  if (root.id === id) return { nodes: [root], indices: [] };
  const nodes: JNode[] = [root];
  const next: number[] = [0];
  while (nodes.length > 0) {
    const depth = nodes.length - 1;
    const children = kids(nodes[depth]);
    const i = next[depth];
    if (i >= children.length) {
      nodes.pop();
      next.pop();
      continue;
    }
    next[depth] = i + 1;
    const child = children[i];
    if (child.id === id) {
      return { nodes: [...nodes, child], indices: next.map((n) => n - 1) };
    }
    if (kids(child).length > 0) {
      nodes.push(child);
      next.push(0);
    }
  }
  return null;
}

/** Replace chain.nodes[level] with `replacement`, copying every ancestor (structural sharing). */
function rebuildChain(chain: Chain, level: number, replacement: JNode): JNode {
  let current = replacement;
  for (let k = level - 1; k >= 0; k--) {
    const parent = chain.nodes[k];
    const children = kids(parent).slice();
    children[chain.indices[k]] = current;
    current = { ...parent, children };
  }
  return current;
}

/** Remove chain's target (must not be the root) from its parent. */
function removeChainTarget(chain: Chain): JNode {
  const parentLevel = chain.nodes.length - 2;
  const parent = chain.nodes[parentLevel];
  const children = kids(parent).slice();
  children.splice(chain.indices[parentLevel], 1);
  return rebuildChain(chain, parentLevel, { ...parent, children });
}

/** Path segments (object keys / array indices) of a chain. */
function chainPath(chain: Chain): Array<string | number> {
  const path: Array<string | number> = [];
  for (let k = 0; k < chain.nodes.length - 1; k++) {
    const parent = chain.nodes[k];
    path.push(parent.type === 'object' ? (chain.nodes[k + 1].key ?? '') : chain.indices[k]);
  }
  return path;
}

/** Locate a node by id. */
export function findNode(root: JNode, id: string): NodeLocation | null {
  const chain = locateChain(root, id);
  if (!chain) return null;
  const depth = chain.nodes.length - 1;
  return {
    node: chain.nodes[depth],
    parent: depth > 0 ? chain.nodes[depth - 1] : null,
    index: depth > 0 ? chain.indices[depth - 1] : -1,
    path: chainPath(chain),
  };
}

/**
 * Node at a path (object key / array index); with duplicate keys the first match wins. Numeric
 * segments match object keys by their string form; canonical integer strings index arrays.
 */
export function getNodeAtPath(root: JNode, path: Array<string | number>): JNode | null {
  let node: JNode = root;
  for (const segment of path) {
    const children = kids(node);
    let next: JNode | undefined;
    if (node.type === 'object') {
      const key = String(segment);
      next = children.find((child) => (child.key ?? '') === key);
    } else if (node.type === 'array') {
      const index = typeof segment === 'number' ? segment : /^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
      next = Number.isInteger(index) && index >= 0 ? children[index] : undefined;
    }
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * "user.name", "tags[0]", "a[\"weird.key\"]" — the data-path format used by the UI/E2E tests. Root is "".
 * Identifier-like keys (/^[A-Za-z_$][\w$]*$/) render as `.key` (no leading dot for the first segment),
 * other keys as `["…"]` (JSON-escaped), indices as `[n]`.
 */
export function formatPath(path: Array<string | number>): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (IDENTIFIER_KEY.test(segment)) out += i === 0 ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mutators (immutable, structural sharing, ids stable)
// ---------------------------------------------------------------------------------------------

function coerceValue(type: JNodeType, value: string | boolean): string | boolean | undefined {
  if (type === 'string' || type === 'number') return typeof value === 'string' ? value : String(value);
  if (type === 'boolean') return typeof value === 'boolean' ? value : value.trim().toLowerCase() === 'true';
  return undefined;
}

/**
 * Patch key and/or value of a node. Value must match the node type (string for string/number, boolean
 * for boolean); a mismatching value is coerced (String(boolean) / "true" -> true), and a value for a
 * null/object/array node is ignored. A key is only applied to children of objects. Returns `root`
 * itself when nothing changes or the id is unknown.
 */
export function updateNode(root: JNode, id: string, patch: { key?: string; value?: string | boolean }): JNode {
  const chain = locateChain(root, id);
  if (!chain) return root;
  const depth = chain.nodes.length - 1;
  const node = chain.nodes[depth];
  const parent = depth > 0 ? chain.nodes[depth - 1] : null;
  let next = node;
  if (patch.key !== undefined && parent?.type === 'object' && patch.key !== node.key) {
    next = { ...next, key: patch.key };
  }
  if (patch.value !== undefined) {
    const value = coerceValue(node.type, patch.value);
    if (value !== undefined && value !== node.value) next = { ...next, value };
  }
  return next === node ? root : rebuildChain(chain, depth, next);
}

/** True when a valid number literal has a non-zero mantissa (exact; no float conversion). */
function isNonZeroLiteral(literal: string): boolean {
  const mantissa = literal.split(/[eE]/)[0];
  return /[1-9]/.test(mantissa);
}

function toStringValue(node: JNode): string {
  switch (node.type) {
    case 'string':
    case 'number':
      return typeof node.value === 'string' ? node.value : String(node.value ?? '');
    case 'boolean':
      return node.value === true ? 'true' : 'false';
    case 'object':
    case 'array':
      return serializeJsonTree(node);
    default:
      return '';
  }
}

function toNumberLiteral(node: JNode): string {
  switch (node.type) {
    case 'string': {
      const text = typeof node.value === 'string' ? node.value.trim() : '';
      return isValidNumberLiteral(text) ? text : '0';
    }
    case 'number':
      return typeof node.value === 'string' ? node.value : '0';
    case 'boolean':
      return node.value === true ? '1' : '0';
    default:
      return '0';
  }
}

function toBooleanValue(node: JNode): boolean {
  switch (node.type) {
    case 'boolean':
      return node.value === true;
    case 'string':
    case 'number': {
      const text = String(node.value ?? '').trim();
      if (text.toLowerCase() === 'true') return true;
      return isValidNumberLiteral(text) && isNonZeroLiteral(text);
    }
    case 'object':
    case 'array':
      return kids(node).length > 0;
    default:
      return false;
  }
}

/** The node converted to `type` (same id and key). */
function convertNode(node: JNode, type: JNodeType): JNode {
  const out: JNode = { id: node.id, type };
  if (node.key !== undefined) out.key = node.key;
  switch (type) {
    case 'string':
      out.value = toStringValue(node);
      break;
    case 'number':
      out.value = toNumberLiteral(node);
      break;
    case 'boolean':
      out.value = toBooleanValue(node);
      break;
    case 'object':
      out.children = node.type === 'array' ? kids(node).map((child, i) => withKey(child, String(i))) : [];
      break;
    case 'array':
      out.children = node.type === 'object' ? kids(node).map(withoutKey) : [];
      break;
    case 'null':
      break;
  }
  return out;
}

/**
 * Change a node's type converting its value sensibly:
 * string->number keeps text if it is a valid number literal else "0"; number->string keeps the literal text;
 * any->boolean: "true"/non-zero -> true; scalar->object/array: empty container; object<->array keeps children
 * (array->object assigns keys "0","1",...; object->array drops keys); any->null drops value/children.
 *
 * Details: string->number trims surrounding whitespace first; boolean->number gives "1"/"0";
 * boolean->string "true"/"false"; null->string ""; object/array->string is the compact JSON text;
 * object/array->number "0"; object/array->boolean is true when non-empty. The converted node keeps its
 * id; children kept by object<->array conversion keep their ids (and their subtrees keep identity).
 */
export function changeNodeType(root: JNode, id: string, type: JNodeType): JNode {
  if (!isNodeType(type)) return root;
  const chain = locateChain(root, id);
  if (!chain) return root;
  const depth = chain.nodes.length - 1;
  const node = chain.nodes[depth];
  if (node.type === type) return root;
  return rebuildChain(chain, depth, convertNode(node, type));
}

/** Remove a node. Removing the root or an unknown id returns `root` unchanged. */
export function removeNode(root: JNode, id: string): JNode {
  const chain = locateChain(root, id);
  if (!chain || chain.nodes.length < 2) return root;
  return removeChainTarget(chain);
}

/** New node of `type` with its default value (string '', number '0', boolean false, empty containers). */
function defaultNode(type: JNodeType, key: string | undefined): JNode {
  const node = makeNode(type, key);
  if (type === 'string') node.value = '';
  else if (type === 'number') node.value = '0';
  else if (type === 'boolean') node.value = false;
  else if (type === 'object' || type === 'array') node.children = [];
  return node;
}

/**
 * Add a child to an object/array node (appended, or inserted at `index`). For objects a unique key is
 * generated when none is given ("newKey", "newKey2", ...). Default type 'string' with value ''.
 * `index` is clamped to the valid range. When `parentId` is unknown or not a container the tree is
 * returned unchanged with id ''.
 */
export function addChild(
  root: JNode,
  parentId: string,
  opts?: { type?: JNodeType; key?: string; index?: number },
): { root: JNode; id: string } {
  const chain = locateChain(root, parentId);
  if (!chain) return { root, id: '' };
  const depth = chain.nodes.length - 1;
  const parent = chain.nodes[depth];
  if (!isContainerNode(parent)) return { root, id: '' };
  const siblings = kids(parent).slice();
  const requestedType = opts?.type;
  const type: JNodeType = isNodeType(requestedType) ? requestedType : 'string';
  const key = parent.type === 'object' ? (opts?.key ?? uniqueKey(siblings, 'newKey', '')) : undefined;
  const child = defaultNode(type, key);
  const requested = opts?.index;
  const at =
    requested === undefined || !Number.isFinite(requested)
      ? siblings.length
      : Math.min(Math.max(Math.trunc(requested), 0), siblings.length);
  siblings.splice(at, 0, child);
  return { root: rebuildChain(chain, depth, { ...parent, children: siblings }), id: child.id };
}

/**
 * Duplicate a node (fresh ids) right after itself; object children get a unique key "<key> copy"
 * ("<key> copy 2", ... when taken). The root cannot be duplicated (returns the tree unchanged, id '').
 */
export function duplicateNode(root: JNode, id: string): { root: JNode; id: string } {
  const chain = locateChain(root, id);
  if (!chain || chain.nodes.length < 2) return { root, id: '' };
  const depth = chain.nodes.length - 1;
  const node = chain.nodes[depth];
  const parent = chain.nodes[depth - 1];
  const siblings = kids(parent).slice();
  let copy = cloneTree(node, false);
  copy = parent.type === 'object' ? { ...copy, key: uniqueKey(siblings, `${node.key ?? ''} copy`, ' ') } : withoutKey(copy);
  siblings.splice(chain.indices[depth - 1] + 1, 0, copy);
  return { root: rebuildChain(chain, depth - 1, { ...parent, children: siblings }), id: copy.id };
}

// ---------------------------------------------------------------------------------------------
// Diff / revert / alignment
// ---------------------------------------------------------------------------------------------

export interface TreeDiff {
  /** Nodes (present in both) whose own key, type or scalar value changed. */
  changed: Set<string>;
  /** Nodes not present in the original. */
  added: Set<string>;
  /** Container ids (present in both) that lost children, with the removed original children. */
  removed: Map<string, JNode[]>;
  /** Every node id whose subtree contains any change (includes ancestors of changed/added/removed, and the nodes themselves). */
  dirty: Set<string>;
}

function hasScalarValue(node: JNode): boolean {
  return node.type === 'string' || node.type === 'number' || node.type === 'boolean';
}

/** Own key (when meaningful), type, scalar value or parent of a node present in both trees differs. */
function ownChanged(orig: JNode, origParent: JNode | null, cur: JNode, curParent: JNode | null): boolean {
  if (orig.type !== cur.type) return true;
  if (hasScalarValue(orig) && orig.value !== cur.value) return true;
  if (effectiveKey(orig, origParent) !== effectiveKey(cur, curParent)) return true;
  return (origParent?.id ?? null) !== (curParent?.id ?? null);
}

/** The relative order of children kept under the same parent differs. */
function isReordered(
  origChildren: readonly JNode[],
  curChildren: readonly JNode[],
  parentId: string,
  origParents: Map<string, JNode | null>,
  curParents: Map<string, JNode | null>,
): boolean {
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < origChildren.length && curParents.get(origChildren[i].id)?.id !== parentId) i++;
    while (j < curChildren.length && origParents.get(curChildren[j].id)?.id !== parentId) j++;
    const origDone = i >= origChildren.length;
    const curDone = j >= curChildren.length;
    if (origDone || curDone) return origDone !== curDone;
    if (origChildren[i].id !== curChildren[j].id) return true;
    i++;
    j++;
  }
}

/** id -> node / parent maps of a tree (first occurrence wins if ids are duplicated). */
interface TreeIndex {
  nodes: Map<string, JNode>;
  parents: Map<string, JNode | null>;
}

/**
 * Index of each diff baseline, built once per root object: the UI diffs every edit against the same
 * captured tree, and trees are immutable, so the index stays valid for the root's lifetime.
 */
const baselineIndexes = new WeakMap<JNode, TreeIndex>();

function indexBaseline(original: JNode): TreeIndex {
  let index = baselineIndexes.get(original);
  if (!index) {
    const nodes = new Map<string, JNode>();
    const parents = new Map<string, JNode | null>();
    forEachNode(original, (node, parent) => {
      if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
        parents.set(node.id, parent);
      }
    });
    index = { nodes, parents };
    baselineIndexes.set(original, index);
  }
  return index;
}

/**
 * Parent of every node of `current` outside subtrees shared with the original. Skipping shared
 * subtrees is exact as long as ids are unique per tree: a node inside a shared subtree sits under the
 * same parent in both trees, so it can be neither removed nor moved.
 */
function indexCurrentParents(current: JNode, origNodes: ReadonlyMap<string, JNode>): Map<string, JNode | null> {
  const parents = new Map<string, JNode | null>();
  forEachNode(current, (node, parent) => {
    if (!parents.has(node.id)) parents.set(node.id, parent);
    return origNodes.get(node.id) !== node;
  });
  return parents;
}

/**
 * Diff by node id (ids are stable across edits). Child reordering marks the parent dirty.
 * Cost is proportional to the part of `current` not shared with `original` (plus a one-time index
 * of `original`, cached per root object — trees must never be mutated in place), so diffing a small
 * edit of a large document is cheap.
 *
 * Semantics:
 *  - `changed`: present in both, and the type, scalar value, meaningful key (object children only) or
 *    parent differs. A type change is always 'changed'. On object<->array conversion the children keep
 *    their ids (so they are neither added nor removed) but each one is also 'changed', because its key
 *    was dropped (object->array) or assigned (array->object).
 *  - `added`: ids not in the original, including every descendant of an added subtree.
 *  - `removed`: for each container present in both, its original children that no longer exist
 *    anywhere in `current` (only the top-most removed node is listed; its descendants go with it).
 *    A container whose type changed to a scalar lists all its original children here.
 *  - `dirty`: ids of `current` only (removed nodes are not part of it); it is ancestor-closed, and
 *    a non-empty `dirty` is equivalent to isTreeModified().
 */
export function diffTrees(original: JNode, current: JNode): TreeDiff {
  const changed = new Set<string>();
  const added = new Set<string>();
  const removed = new Map<string, JNode[]>();
  const dirty = new Set<string>();
  if (original === current) return { changed, added, removed, dirty };

  const { nodes: origNodes, parents: origParents } = indexBaseline(original);
  const curParents = indexCurrentParents(current, origNodes);

  const selfDirty: string[] = [];
  forEachNode(current, (node, parent) => {
    const orig = origNodes.get(node.id);
    if (!orig) {
      added.add(node.id);
      selfDirty.push(node.id);
      return;
    }
    let isDirty = false;
    if (ownChanged(orig, origParents.get(node.id) ?? null, node, parent)) {
      changed.add(node.id);
      isDirty = true;
    }
    if (orig === node) {
      // Shared subtree (structural sharing): its children and everything below are identical.
      if (isDirty) selfDirty.push(node.id);
      return false;
    }
    const origChildren = kids(orig);
    const curChildren = kids(node);
    let gone: JNode[] | undefined;
    for (const child of origChildren) {
      if (!curParents.has(child.id)) (gone ??= []).push(child);
      else if (curParents.get(child.id)?.id !== node.id) isDirty = true; // moved elsewhere
    }
    if (gone) {
      removed.set(node.id, gone);
      isDirty = true;
    }
    if (!isDirty && isReordered(origChildren, curChildren, node.id, origParents, curParents)) isDirty = true;
    if (isDirty) selfDirty.push(node.id);
  });

  // Mark each self-dirty node and its ancestors; stop at an already dirty node (its ancestors are too).
  for (const id of selfDirty) {
    let cursor: string | undefined = id;
    while (cursor !== undefined && !dirty.has(cursor)) {
      dirty.add(cursor);
      cursor = curParents.get(cursor)?.id;
    }
  }
  return { changed, added, removed, dirty };
}

/** Same ids, types, scalar values, object keys and child order (root key ignored). Iterative. */
function subtreeEquals(a: JNode, b: JNode): boolean {
  const left: JNode[] = [a];
  const right: JNode[] = [b];
  while (left.length > 0) {
    const x = left.pop() as JNode;
    const y = right.pop() as JNode;
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type) return false;
    if (hasScalarValue(x) && x.value !== y.value) return false;
    const xs = kids(x);
    const ys = kids(y);
    if (xs.length !== ys.length) return false;
    const compareKeys = x.type === 'object';
    for (let i = 0; i < xs.length; i++) {
      if (compareKeys && (xs[i].key ?? '') !== (ys[i].key ?? '')) return false;
      left.push(xs[i]);
      right.push(ys[i]);
    }
  }
  return true;
}

/** True when `current` differs from `original` in any way diffTrees reports (early exit). */
export function isTreeModified(original: JNode, current: JNode): boolean {
  return !subtreeEquals(original, current);
}

/** Key a re-inserted original node should carry under `parent` in the current tree. */
function keyUnder(parent: JNode, origNode: JNode, origParent: JNode, fallback: string | undefined): string | undefined {
  if (parent.type !== 'object') return undefined;
  if (origParent.type === 'object') return origNode.key ?? '';
  return fallback ?? '';
}

function applyKey(node: JNode, key: string | undefined): JNode {
  return key === undefined ? withoutKey(node) : withKey(node, key);
}

/** Re-insert a node that was removed from `current`, next to its nearest surviving original sibling. */
function restoreRemoved(origChain: Chain, current: JNode): JNode {
  const depth = origChain.nodes.length - 1;
  const origNode = origChain.nodes[depth];
  const origParent = origChain.nodes[depth - 1];
  const parentChain = locateChain(current, origParent.id);
  if (!parentChain) return current; // the parent is gone too: revert an ancestor instead
  const parent = parentChain.nodes[parentChain.nodes.length - 1];
  if (!isContainerNode(parent)) return current;

  const children = kids(parent).slice();
  const positions = new Map<string, number>();
  children.forEach((child, i) => positions.set(child.id, i));
  const origSiblings = kids(origParent);
  let insertAt = 0;
  for (let k = origChain.indices[depth - 1] - 1; k >= 0; k--) {
    const position = positions.get(origSiblings[k].id);
    if (position !== undefined) {
      insertAt = position + 1;
      break;
    }
  }
  const fallbackKey = origNode.key ?? String(origChain.indices[depth - 1]);
  const restored = applyKey(origNode, keyUnder(parent, origNode, origParent, fallbackKey));
  children.splice(insertAt, 0, restored);
  return rebuildChain(parentChain, parentChain.nodes.length - 1, { ...parent, children });
}

/**
 * Revert the subtree rooted at `id` to its original state. If `id` is an added node it is removed.
 * If `id` is the root, returns a clone of original (same ids).
 *
 * A reverted (or re-inserted) non-root subtree is the original's own node object whenever its key
 * allows (trees are immutable), so it is shared with `original` again and later diffs skip it.
 *
 * Removed children come back when their parent (or any ancestor) is reverted. As a convenience, passing
 * the id of a removed node (one of `diff.removed` values) re-inserts it into its original parent, after
 * its nearest surviving original sibling. The reverted node stays at its current position (reverting
 * the parent also restores the child order). Returns `current` itself when nothing would change.
 */
export function revertNode(original: JNode, current: JNode, id: string): JNode {
  if (id === current.id || id === original.id) {
    return subtreeEquals(original, current) ? current : cloneTree(original, true);
  }
  const curChain = locateChain(current, id);
  const origChain = locateChain(original, id);
  if (!curChain) return origChain ? restoreRemoved(origChain, current) : current;
  if (!origChain) return removeChainTarget(curChain); // added node

  const depth = curChain.nodes.length - 1;
  const curNode = curChain.nodes[depth];
  const curParent = curChain.nodes[depth - 1];
  const origNode = origChain.nodes[origChain.nodes.length - 1];
  const origParent = origChain.nodes[origChain.nodes.length - 2];
  const key = keyUnder(curParent, origNode, origParent, curNode.key);
  if (effectiveKey(curNode, curParent) === key && subtreeEquals(origNode, curNode)) return current;
  return rebuildChain(curChain, depth, applyKey(origNode, key));
}

/** Scalars match any scalar; containers only match the same container type. */
function alignable(next: JNode, reference: JNode): boolean {
  return isContainerNode(next) || isContainerNode(reference) ? next.type === reference.type : true;
}

/** Shallow copy of `node` carrying `id` (children array shared until replaced). */
function withId(node: JNode, id: string): JNode {
  const copy: JNode = { id, type: node.type };
  if (node.key !== undefined) copy.key = node.key;
  if (node.value !== undefined) copy.value = node.value;
  if (node.children !== undefined) copy.children = node.children;
  return copy;
}

/** Unmatched subtree as-is, or with fresh ids if any of its ids is used by the reference tree. */
function freshen(subtree: JNode, referenceIds: ReadonlySet<string>): JNode {
  return someNode(subtree, (node) => referenceIds.has(node.id)) ? cloneTree(subtree, false) : subtree;
}

function groupByKey(children: readonly JNode[]): Map<string, JNode[]> {
  const groups = new Map<string, JNode[]>();
  for (const child of children) {
    const key = child.key ?? '';
    const group = groups.get(key);
    if (group) group.push(child);
    else groups.set(key, [child]);
  }
  return groups;
}

/** A matched pair of containers whose children are being aligned. */
interface AlignFrame {
  source: JNode;
  ref: JNode;
  /** Copy of `source` carrying `ref.id`; receives the aligned children. */
  out: JNode;
  /** Where the result goes: the parent's aligned children array (null for the root). */
  slot: JNode[] | null;
  index: number;
  expanded: boolean;
}

/** `aligned` (which carries `ref.id`) equals `ref` field by field, children compared by identity. */
function isSameAsReference(aligned: JNode, ref: JNode): boolean {
  if (aligned.type !== ref.type || aligned.key !== ref.key || aligned.value !== ref.value) return false;
  const a = aligned.children;
  const b = ref.children;
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The reference child `child` aligns with (key + occurrence for objects, index for arrays). */
function matchChild(
  child: JNode,
  index: number,
  refChildren: readonly JNode[],
  byKey: Map<string, JNode[]> | null,
  occurrences: Map<string, number>,
): JNode | undefined {
  if (!byKey) return refChildren[index];
  const key = child.key ?? '';
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return byKey.get(key)?.[occurrence];
}

/**
 * Re-use ids from `reference` for nodes of `next` that sit at the same structural path with the same
 * container type (used after the user edits raw JSON text, so diff/revert keep working).
 *
 * Matching is by structural path: object children by key plus occurrence index (the 2nd "a" matches
 * the 2nd "a"), array children by index. A scalar matches any scalar (so a type change such as
 * `"1"` -> `1` stays the same node, reported as 'changed'); a container only matches a container of the
 * same type, and only matched containers have their children matched. Unmatched nodes keep their (fresh)
 * ids — re-generated if they would collide with a reference id.
 *
 * Structural sharing: a matched subtree that ends up identical to its reference counterpart (same key,
 * type, value and children) is the reference object itself, so an unchanged document returns
 * `reference` and a raw edit only replaces the root -> edit paths (UI memoization and diffTrees stay
 * cheap). Other matched nodes are new objects; unmatched subtrees of `next` are reused as-is.
 * Inputs are never modified. Iterative: safe for any depth.
 */
export function alignTreeIds(next: JNode, reference: JNode): JNode {
  const referenceIds = new Set<string>();
  forEachNode(reference, (node) => {
    referenceIds.add(node.id);
  });
  if (!alignable(next, reference)) return freshen(next, referenceIds);
  const rootCopy = withId(next, reference.id);
  if (!isContainerNode(next)) return isSameAsReference(rootCopy, reference) ? reference : rootCopy;

  let root = rootCopy;
  const stack: AlignFrame[] = [{ source: next, ref: reference, out: rootCopy, slot: null, index: 0, expanded: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.expanded) {
      // Every child frame has completed (they sit above this one): share the reference when equal.
      stack.pop();
      const result = isSameAsReference(frame.out, frame.ref) ? frame.ref : frame.out;
      if (frame.slot) frame.slot[frame.index] = result;
      else root = result;
      continue;
    }
    frame.expanded = true;
    const sourceChildren = kids(frame.source);
    const refChildren = kids(frame.ref);
    const byKey = frame.source.type === 'object' ? groupByKey(refChildren) : null;
    const occurrences = new Map<string, number>();
    const children = new Array<JNode>(sourceChildren.length);
    for (let i = 0; i < sourceChildren.length; i++) {
      const child = sourceChildren[i];
      const match = matchChild(child, i, refChildren, byKey, occurrences);
      if (!match || !alignable(child, match)) {
        children[i] = freshen(child, referenceIds);
        continue;
      }
      const copy = withId(child, match.id);
      if (isContainerNode(child)) {
        children[i] = copy; // placeholder until the child frame completes
        stack.push({ source: child, ref: match, out: copy, slot: children, index: i, expanded: false });
      } else {
        children[i] = isSameAsReference(copy, match) ? match : copy;
      }
    }
    frame.out.children = children;
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Validation / stats
// ---------------------------------------------------------------------------------------------

/** RFC 8259 number literal check (no surrounding whitespace, no leading zeros, no NaN/Infinity). */
export function isValidNumberLiteral(text: string): boolean {
  return typeof text === 'string' && NUMBER_LITERAL.test(text);
}

function numberError(value: JNode['value']): string | null {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return 'Number is empty';
  if (typeof value === 'string' && isValidNumberLiteral(value)) return null;
  return `${JSON.stringify(String(value))} is not a valid JSON number`;
}

/**
 * node id -> error message for invalid number literals and other unsendable values (nodes of an
 * unknown type). An empty map means the tree serializes to valid JSON.
 */
export function treeErrors(root: JNode): Map<string, string> {
  const errors = new Map<string, string>();
  forEachNode(root, (node) => {
    if (node.type === 'number') {
      const message = numberError(node.value);
      if (message) errors.set(node.id, message);
    } else if (!isNodeType(node.type)) {
      errors.set(node.id, `Unknown value type ${JSON.stringify(String(node.type))}`);
    }
  });
  return errors;
}

/** Number of descendant nodes, excluding the node itself (for summaries like "{12}"). */
export function countNodes(node: JNode): number {
  let count = -1;
  forEachNode(node, () => {
    count++;
  });
  return count;
}
