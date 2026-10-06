// OWNER: lib-typegen agent. Infer types from JSON samples and emit TypeScript / Zod / JSON Schema.
//
// Pipeline: inferType / inferFromSamples (lossless JNode -> TypeNode) -> DeclarationPlan (hoists nested
// objects, names them, dedupes identical shapes) -> one printer per format. The three printers walk the same
// plan, so names and structure always agree across formats.
//
// Decisions worth knowing:
//  - A union holds at most one member per kind (string, number, boolean, object, array, null): samples that
//    disagree on the kind become a union, everything else merges. Objects always merge field-wise, so an array
//    of differently-shaped objects becomes ONE object type with optional fields. No discriminated unions:
//    TypeNode has no literal types (its JSDoc requires object members to merge), so a discriminator such as
//    `type` stays `string` and its observed values appear in the `e.g.` comment instead.
//  - Field and example order is first-seen, so mergeTypes is commutative and idempotent up to that order.
//  - Number literals are judged from their text: "1.0" is not an integer, and integer literals beyond
//    ±(2^53-1) are `unsafeInteger` (typed `number`, never `z.number().int()`, which rejects them in Zod 4).
//  - A format needs EVERY sample to match a strict pattern that Zod 3, Zod 4 and JSON Schema all accept:
//    RFC 3339 date-time / time with an offset, valid calendar dates, RFC 9562 UUIDs, http(s) URLs...
//  - Example values are captured page data: they are only printed inside `//` comments (line terminators
//    escaped) or JSON strings, and only for unformatted and date/time strings (no ids, emails, URLs).
//  - Strings equal to the redaction marker carry no example and no format (the real value is hidden).
//  - Objects keyed only by ids ({"101": {...}, "102": {...}}) print as dictionaries (Record<string, V>).
//  - Inference stops MAX_DEPTH levels down (deeper values become `unknown`), which bounds every recursive pass.
import type { TypeFormat } from '../shared/claude-protocol';
import type { JNode } from '../shared/types';
import { suggestBaseName, type BodySpec, type EndpointSpec, type PathParam, type QueryParamSpec } from './endpoint';
import { tryParseJsonTree } from './json-tree';
import { REDACTED } from './redact';

/** Inferred type model. */
export type TypeNode =
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | {
      kind: 'number';
      /** Every sample was an integer literal. */
      integer: boolean;
      /** Some sample is an integer outside ±(2^53-1): JS number would lose precision. */
      unsafeInteger?: boolean;
    }
  | {
      kind: 'string';
      /** Format detected in EVERY sample (date-time, date, time, uuid, email, uri, ...). */
      format?: StringFormat;
      /** Up to a few distinct example values (for comments/docs). */
      examples?: string[];
    }
  | { kind: 'array'; items: TypeNode; /** largest observed length */ maxItems?: number }
  | { kind: 'object'; fields: TypeField[] }
  /** Members are never unions themselves and are deduplicated (object members merged). */
  | { kind: 'union'; members: TypeNode[] };

export type StringFormat = 'date-time' | 'date' | 'time' | 'uuid' | 'email' | 'uri' | 'ipv4' | 'base64';

export interface TypeField {
  /** Key exactly as in JSON. */
  name: string;
  type: TypeNode;
  /** Missing in some samples. */
  optional: boolean;
}

// ---------------------------------------------------------------------------------------------
// Internal model: TypeNode plus `blob` (form / multipart file fields) and `record` (dictionaries), recursively.
// Every TypeNode is an IType.
// ---------------------------------------------------------------------------------------------

type NumberNode = Extract<TypeNode, { kind: 'number' }>;
type StringNode = Extract<TypeNode, { kind: 'string' }>;

type IType =
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | NumberNode
  | StringNode
  | { kind: 'blob' }
  | { kind: 'array'; items: IType; maxItems?: number }
  | { kind: 'object'; fields: IField[] }
  /** Dictionary (object keyed by ids), produced from objects by withRecords just before emission. */
  | { kind: 'record'; values: IType }
  | { kind: 'union'; members: IType[] };

type IObject = Extract<IType, { kind: 'object' }>;
type IComposite = Extract<IType, { kind: 'array' | 'object' | 'record' | 'union' }>;

interface IField {
  name: string;
  type: IType;
  optional: boolean;
}

interface IRoot {
  name: string;
  type: IType;
  description?: string;
}

/** Container levels typed before giving up (deeper values become `unknown`). */
const MAX_DEPTH = 100;
const MAX_EXAMPLES = 3;
/** Longer strings keep no example. */
const MAX_EXAMPLE_CHARS = 100;
/** Longest example (as a JSON literal, quotes excluded) printed in a code comment. */
const MAX_COMMENT_EXAMPLE_CHARS = 40;
/** Parent-prefixed names longer than this fall back to numbering. */
const MAX_PREFIXED_NAME = 48;
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const PRECISION_NOTE = 'precision: exceeds 2^53';
/** A value seen only as null: its real type is unknown, `null` is all the samples prove. */
const ONLY_NULL_NOTE = 'only null observed';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// ---------------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------------

/** What inference had to give up on (reported as notes by generateEndpointTypes). */
interface InferStats {
  depthLimited: boolean;
  redacted: boolean;
}

const newStats = (): InferStats => ({ depthLimited: false, redacted: false });

/** Infer from one JSON sample. */
export function inferType(node: JNode): TypeNode {
  return infer(node, 0, newStats());
}

function infer(node: JNode, depth: number, stats: InferStats): TypeNode {
  switch (node.type) {
    case 'null':
      return { kind: 'null' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'number':
      return numberType(String(node.value ?? ''));
    case 'string':
      return stringType(typeof node.value === 'string' ? node.value : String(node.value ?? ''), stats);
    case 'array':
    case 'object':
      if (depth >= MAX_DEPTH) {
        stats.depthLimited = true;
        return { kind: 'unknown' };
      }
      return node.type === 'array'
        ? arrayType(node.children ?? [], depth, stats)
        : objectType(node.children ?? [], depth, stats);
    default:
      return { kind: 'unknown' };
  }
}

const INTEGER_LITERAL = /^-?\d+$/;
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);

function numberType(literal: string): TypeNode {
  const text = literal.trim();
  if (!INTEGER_LITERAL.test(text)) return { kind: 'number', integer: false };
  const digits = text.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  const unsafe =
    digits.length > MAX_SAFE_DIGITS.length || (digits.length === MAX_SAFE_DIGITS.length && digits > MAX_SAFE_DIGITS);
  return unsafe ? { kind: 'number', integer: true, unsafeInteger: true } : { kind: 'number', integer: true };
}

function stringType(value: string, stats: InferStats): StringNode {
  if (value === REDACTED) {
    stats.redacted = true;
    return { kind: 'string' };
  }
  const node: StringNode = { kind: 'string' };
  const format = detectFormat(value);
  if (format) node.format = format;
  if (value.length <= MAX_EXAMPLE_CHARS) node.examples = [value];
  return node;
}

function arrayType(children: readonly JNode[], depth: number, stats: InferStats): TypeNode {
  let items: TypeNode = { kind: 'unknown' };
  for (const child of children) items = mergeTypes(items, infer(child, depth + 1, stats));
  return { kind: 'array', items, maxItems: children.length };
}

function objectType(children: readonly JNode[], depth: number, stats: InferStats): TypeNode {
  const fields: TypeField[] = [];
  const index = new Map<string, number>();
  for (const child of children) {
    const name = child.key ?? '';
    const field: TypeField = { name, type: infer(child, depth + 1, stats), optional: false };
    const at = index.get(name);
    // A duplicate key keeps its first position and its last value, like JSON.parse.
    if (at === undefined) {
      index.set(name, fields.length);
      fields.push(field);
    } else {
      fields[at] = field;
    }
  }
  return { kind: 'object', fields };
}

/**
 * Merge two inferred types (multiple samples / array items): objects merge field-wise (a field missing on one
 * side becomes optional), null + T => union with null, number integer flags AND-ed, string formats kept only
 * when shared, arrays merge items, unknown is the identity. Commutative and idempotent.
 */
export function mergeTypes(a: TypeNode, b: TypeNode): TypeNode {
  // Merging TypeNodes never produces a blob, so the result is a TypeNode again.
  return merge(a, b) as TypeNode;
}

/** Union member order (also the printed order): `string | number | Order | null`. */
const KIND_RANK: Record<IType['kind'], number> = {
  string: 0,
  number: 1,
  boolean: 2,
  blob: 3,
  object: 4,
  record: 4,
  array: 5,
  null: 6,
  unknown: 7,
  union: 8,
};

function merge(a: IType, b: IType): IType {
  if (a === b || b.kind === 'unknown') return a;
  if (a.kind === 'unknown') return b;
  if (a.kind === 'union' || b.kind === 'union' || a.kind !== b.kind) {
    return mergeUnion([...membersOf(a), ...membersOf(b)]);
  }
  return mergeSameKind(a, b);
}

function membersOf(t: IType): readonly IType[] {
  return t.kind === 'union' ? t.members : [t];
}

function mergeUnion(members: readonly IType[]): IType {
  const byKind = new Map<IType['kind'], IType>();
  for (const member of members) {
    if (member.kind === 'unknown') continue;
    const previous = byKind.get(member.kind);
    byKind.set(member.kind, previous ? mergeSameKind(previous, member) : member);
  }
  const list = [...byKind.values()].sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]);
  if (list.length === 0) return { kind: 'unknown' };
  return list.length === 1 ? list[0] : { kind: 'union', members: list };
}

/** Both sides have the same (non-union) kind. */
function mergeSameKind(a: IType, b: IType): IType {
  if (a.kind === 'number' && b.kind === 'number') {
    const node: NumberNode = { kind: 'number', integer: a.integer && b.integer };
    if (a.unsafeInteger || b.unsafeInteger) node.unsafeInteger = true;
    return node;
  }
  if (a.kind === 'string' && b.kind === 'string') {
    const node: StringNode = { kind: 'string' };
    if (a.format && a.format === b.format) node.format = a.format;
    const examples = mergeExamples(a.examples, b.examples);
    if (examples) node.examples = examples;
    return node;
  }
  if (a.kind === 'array' && b.kind === 'array') {
    const node: IType = { kind: 'array', items: merge(a.items, b.items) };
    if (a.maxItems !== undefined || b.maxItems !== undefined) node.maxItems = Math.max(a.maxItems ?? 0, b.maxItems ?? 0);
    return node;
  }
  if (a.kind === 'object' && b.kind === 'object') return mergeObjects(a, b);
  if (a.kind === 'record' && b.kind === 'record') return { kind: 'record', values: merge(a.values, b.values) };
  return a; // null, boolean, blob: nothing to merge
}

function mergeExamples(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!b?.length) return a;
  if (!a?.length) return b;
  if (a.length >= MAX_EXAMPLES) return a;
  const out = [...a];
  for (const value of b) {
    if (out.length >= MAX_EXAMPLES) break;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function mergeObjects(a: IObject, b: IObject): IType {
  const others = new Map(b.fields.map((f) => [f.name, f]));
  const fields: IField[] = a.fields.map((fa) => {
    const fb = others.get(fa.name);
    if (!fb) return fa.optional ? fa : { ...fa, optional: true };
    others.delete(fa.name);
    return { name: fa.name, type: merge(fa.type, fb.type), optional: fa.optional || fb.optional };
  });
  for (const fb of others.values()) fields.push(fb.optional ? fb : { ...fb, optional: true });
  return { kind: 'object', fields };
}

/** inferType over every sample, merged; `unknown` for no samples. */
export function inferFromSamples(samples: JNode[]): TypeNode {
  return inferSamples(samples, newStats());
}

function inferSamples(samples: readonly JNode[], stats: InferStats): TypeNode {
  let type: TypeNode = { kind: 'unknown' };
  for (const sample of samples) type = mergeTypes(type, infer(sample, 0, stats));
  return type;
}

// ---------------------------------------------------------------------------------------------
// String formats (conservative: each pattern is accepted by Zod 3, Zod 4 and JSON Schema validators)
// ---------------------------------------------------------------------------------------------

// Calendar dates with the right number of days per month, leap years included (same as Zod's date regex).
const DATE_SOURCE =
  '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8])))';
const TIME_SOURCE = '(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?';
const OFFSET_SOURCE = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)';
const DATE_TIME_RE = new RegExp(`^${DATE_SOURCE}T${TIME_SOURCE}${OFFSET_SOURCE}$`);
const DATE_RE = new RegExp(`^${DATE_SOURCE}$`);
const TIME_RE = new RegExp(`^${TIME_SOURCE}${OFFSET_SOURCE}$`);
const UUID_RE =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/;
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
const HTTP_URL_RE = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function detectFormat(value: string): StringFormat | undefined {
  if (value.length < 6) return undefined; // shorter than "a@b.co"
  if (value.length <= 2048) {
    if (DATE_TIME_RE.test(value)) return 'date-time';
    if (DATE_RE.test(value)) return 'date';
    if (TIME_RE.test(value)) return 'time';
    if (UUID_RE.test(value)) return 'uuid';
    if (value.length <= 254 && EMAIL_RE.test(value)) return 'email';
    if (isHttpUrl(value)) return 'uri';
    if (IPV4_RE.test(value)) return 'ipv4';
  }
  return isBase64(value) ? 'base64' : undefined;
}

function isHttpUrl(value: string): boolean {
  if (!HTTP_URL_RE.test(value)) return false;
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

/** Mixed-case base64 that is padded, or long and with digits: plain words, paths and MIME types never qualify. */
function isBase64(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    (value.endsWith('=') || (value.length >= 64 && /\d/.test(value))) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    BASE64_RE.test(value)
  );
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** ASCII words of a key: camelCase, snake_case, kebab-case, acronyms ("userIDs" -> user, Ids), diacritics dropped. */
function splitWords(key: string): string[] {
  return key
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([A-Z])([A-Z]+)s(?![a-z])/g, (_m, first: string, rest: string) => `${first}${rest.toLowerCase()}s`)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter((word) => word !== '');
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

function pascalCase(key: string): string {
  return splitWords(key).map(capitalize).join('');
}

/** "items" -> "Item", "categories" -> "Category", "addresses" -> "Address", "data" -> "Data", "user_ids" -> "UserId". */
export function singularPascal(key: string): string {
  const words = splitWords(key);
  if (words.length === 0) return '';
  words[words.length - 1] = singularize(words[words.length - 1].toLowerCase());
  return words.map(capitalize).join('');
}

const IRREGULAR_SINGULARS = new Map<string, string>([
  ['people', 'person'], ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['feet', 'foot'],
  ['teeth', 'tooth'], ['geese', 'goose'], ['mice', 'mouse'], ['oxen', 'ox'], ['criteria', 'criterion'],
  ['phenomena', 'phenomenon'], ['indices', 'index'], ['vertices', 'vertex'], ['matrices', 'matrix'],
  ['appendices', 'appendix'], ['analyses', 'analysis'], ['crises', 'crisis'], ['theses', 'thesis'],
  ['hypotheses', 'hypothesis'], ['diagnoses', 'diagnosis'], ['synopses', 'synopsis'],
  ['parentheses', 'parenthesis'], ['axes', 'axis'], ['quizzes', 'quiz'], ['heroes', 'hero'],
  ['potatoes', 'potato'], ['tomatoes', 'tomato'], ['echoes', 'echo'], ['vetoes', 'veto'], ['wolves', 'wolf'],
  ['knives', 'knife'], ['wives', 'wife'], ['lives', 'life'], ['halves', 'half'], ['shelves', 'shelf'],
  ['thieves', 'thief'], ['selves', 'self'], ['calves', 'calf'], ['cacti', 'cactus'], ['fungi', 'fungus'],
  ['nuclei', 'nucleus'], ['radii', 'radius'], ['stimuli', 'stimulus'], ['syllabi', 'syllabus'],
  ['alumni', 'alumnus'], ['foci', 'focus'], ['statuses', 'status'], ['aliases', 'alias'], ['buses', 'bus'],
  ['bonuses', 'bonus'], ['viruses', 'virus'], ['campuses', 'campus'], ['censuses', 'census'],
  ['focuses', 'focus'], ['radiuses', 'radius'], ['corpuses', 'corpus'], ['surpluses', 'surplus'],
  ['canvases', 'canvas'], ['biases', 'bias'], ['atlases', 'atlas'], ['gases', 'gas'], ['lenses', 'lens'],
  ['caches', 'cache'], ['niches', 'niche'], ['headaches', 'headache'], ['cliches', 'cliche'],
  ['menus', 'menu'], ['gurus', 'guru'], ['emus', 'emu'], ['haikus', 'haiku'], ['tutus', 'tutu'],
]);

/** Words ending in s that are singular or uncountable. */
const INVARIANT_WORDS = new Set([
  'news', 'series', 'species', 'analytics', 'gps', 'sms', 'dns', 'aws', 'ios', 'os', 'macos', 'kudos', 'chaos',
  'ethos', 'cosmos', 'pathos', 'thermos', 'lens', 'means', 'headquarters', 'physics', 'mathematics',
  'economics', 'ethics', 'electronics', 'politics', 'logistics', 'athletics', 'diabetes', 'alias', 'canvas',
  'bias', 'atlas', 'gas', 'has', 'was', 'this', 'axis', 'tennis', 'iris', 'chassis', 'pelvis', 'debris',
  'trellis', 'metropolis', 'yes', 'always', 'perhaps', 'towards', 'its', 'his', 'thus', 'plus', 'minus',
  'versus',
]);

/** "-ies" plurals of "-ie" words (the default turns "-ies" into "-y"). */
const IE_PLURALS = new Set([
  'movies', 'cookies', 'pies', 'ties', 'lies', 'dies', 'zombies', 'calories', 'rookies', 'hoodies', 'selfies',
  'smoothies', 'brownies', 'goodies', 'freebies', 'newbies', 'genies', 'magpies', 'aussies',
]);

/** Singular of one lower-case English word (good enough for JSON keys; unknown words stay as they are). */
function singularize(word: string): string {
  const irregular = IRREGULAR_SINGULARS.get(word);
  if (irregular) return irregular;
  if (word.length <= 2 || !word.endsWith('s') || INVARIANT_WORDS.has(word)) return word;
  if (word.endsWith('ies')) return IE_PLURALS.has(word) ? word.slice(0, -1) : `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|zz)es$/.test(word)) return word.slice(0, -2);
  if (/(?:ss|us|sis)$/.test(word)) return word;
  return word.slice(0, -1);
}

/**
 * Names too vague to stand alone: a nested object under such a key is named after its parent
 * (`items` in Order -> OrderItem, `meta` in ListOrdersResponse -> ListOrdersResponseMeta).
 */
const GENERIC_NAMES = new Set([
  'Item', 'Data', 'Datum', 'Result', 'Node', 'Edge', 'Entry', 'Element', 'Record', 'Row', 'Value', 'Meta',
  'Metadata', 'Info', 'Information', 'Detail', 'Attribute', 'Attr', 'Property', 'Prop', 'Option', 'Setting',
  'Config', 'Configuration', 'Payload', 'Content', 'Body', 'Response', 'Request', 'Error', 'Link', 'Page',
  'Pagination', 'Paging', 'Object', 'Field', 'Param', 'Parameter', 'Extra', 'Context', 'Arg', 'Argument',
  'Input', 'Output', 'Child', 'Parent', 'List', 'Summary', 'Stat', 'Statistic', 'Type', 'Kind', 'Status',
  'State', 'Source', 'Target', 'Entity', 'Resource', 'Obj', 'Val', 'Raw', 'Extension', 'Header', 'Doc',
  'Document', 'Version', 'Wrapper', 'Container', 'Root', 'Main', 'Default', 'Base', 'Common', 'General',
  'Other', 'Misc', 'Custom', 'Message', 'Inner', 'Embedded', 'Included', 'Relationship', 'Collection',
  'Group', 'Section', 'Block', 'Part', 'Component', 'Variable', 'Var', 'Rule', 'Filter', 'Sort', 'Query',
  'Key', 'Hash', 'Dict', 'Map', 'Set',
]);

/** Global (TS lib / DOM) type names a declaration must not shadow; such keys are named after their parent. */
const RESERVED_NAMES = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function', 'Date', 'Error', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'InstanceType', 'Awaited', 'JSON', 'Math',
  'Intl', 'Reflect', 'Proxy', 'Iterator', 'Generator', 'ArrayBuffer', 'DataView', 'Blob', 'File', 'FormData',
  'Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'Event', 'Node', 'Element', 'Document', 'Window',
  'Location', 'History', 'Navigator', 'Storage', 'Image', 'Text', 'Comment', 'Range', 'Selection', 'Screen',
  'Performance', 'Notification', 'Worker', 'Cache', 'Credential', 'Crypto', 'Option', 'Audio', 'Plugin',
  'Touch', 'Animation', 'Report', 'Lock', 'Attr', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
  'PropertyKey', 'PromiseLike', 'ArrayLike', 'Infinity', 'NaN',
]);

function isGeneric(name: string): boolean {
  return GENERIC_NAMES.has(name) || GENERIC_NAMES.has(singularPascal(name));
}

/** A caller-supplied name as a PascalCase identifier ("get user orders" -> "GetUserOrders"); valid ones are kept. */
function toTypeName(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (/^[A-Z][A-Za-z\d]*$/.test(trimmed)) return trimmed;
  const pascal = pascalCase(trimmed);
  if (!pascal) return fallback;
  return /^\d/.test(pascal) ? `T${pascal}` : pascal;
}

/** Longest run of trailing PascalCase words shared by every name ("BillingAddress", "ShippingAddress" -> "Address"). */
function commonTrailingWords(names: readonly string[]): string {
  if (names.length < 2 || names.some((n) => n === '')) return '';
  const split = names.map((n) => n.split(/(?=[A-Z])/));
  const shortest = Math.min(...split.map((w) => w.length));
  const common: string[] = [];
  for (let i = 1; i <= shortest; i++) {
    const word = split[0][split[0].length - i];
    if (!split.every((w) => w[w.length - i] === word)) break;
    common.unshift(word);
  }
  return common.join('');
}

// ---------------------------------------------------------------------------------------------
// Declaration plan: hoisting, naming, dedupe
// ---------------------------------------------------------------------------------------------

/** Objects with at least one field get their own declaration; `{}` stays inline as a record. */
function isNamedShape(t: IType): t is IObject {
  return t.kind === 'object' && t.fields.length > 0;
}

/** Keys that are data, not names: integers, UUID-like ids, long hex ids (Mongo, hashes), ISO dates. */
const ID_KEY_RE =
  /^(?:-?\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{16,}|\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)$/;

/**
 * Objects whose keys are all ids ({"123": {...}, "456": {...}}) are dictionaries: their values merge into one
 * `record` type, which prints as Record<string, V> / z.record / additionalProperties. Applied just before
 * emission, so TypeNode stays a lossless description of the samples.
 */
function withRecords(t: IType, memo = new WeakMap<IType, IType>()): IType {
  const cached = memo.get(t);
  if (cached) return cached;
  let out: IType;
  if (t.kind === 'array') {
    out = { ...t, items: withRecords(t.items, memo) };
  } else if (t.kind === 'union') {
    out = { kind: 'union', members: t.members.map((m) => withRecords(m, memo)) };
  } else if (t.kind === 'record') {
    out = { kind: 'record', values: withRecords(t.values, memo) };
  } else if (t.kind === 'object' && t.fields.length > 0 && t.fields.every((f) => ID_KEY_RE.test(f.name))) {
    let values: IType = { kind: 'unknown' };
    for (const f of t.fields) values = merge(values, f.type);
    out = { kind: 'record', values: withRecords(values, memo) };
  } else if (t.kind === 'object') {
    out = { kind: 'object', fields: t.fields.map((f) => ({ ...f, type: withRecords(f.type, memo) })) };
  } else {
    out = t;
  }
  memo.set(t, out);
  return out;
}

/** How a nested object is reached: as a field value, an array item or a dictionary value. */
type Position = 'field' | 'item' | 'value';

/** Name base from the key: `customer` -> Customer, `items[]` -> Item, `usersById{}` -> User. */
function baseName(key: string, position: Position): string {
  if (position === 'field') return pascalCase(key);
  if (position === 'item') return singularPascal(key);
  const words = splitWords(key);
  if (words.length > 2 && words[words.length - 2].toLowerCase() === 'by') words.length -= 2;
  else if (words.length > 1 && /^(?:map|dict|index|lookup|table)$/i.test(words[words.length - 1])) words.length -= 1;
  return singularPascal(words.join(' '));
}

const FALLBACK_WORDS: Record<Position, string> = { field: 'Value', item: 'Item', value: 'Value' };

/** Structural signature (field names, optionality, kinds, number/format flags; examples ignored), interned. */
class ShapeSignatures {
  private readonly cache = new WeakMap<IType, string>();
  private readonly ids = new Map<string, string>();

  of(t: IType): string {
    switch (t.kind) {
      case 'unknown':
        return '?';
      case 'null':
        return '0';
      case 'boolean':
        return 'b';
      case 'blob':
        return 'B';
      case 'number':
        return t.unsafeInteger ? `n!${t.integer ? 'i' : ''}` : t.integer ? 'i' : 'n';
      case 'string':
        return t.format ? `s:${t.format}` : 's';
      case 'array':
      case 'record':
      case 'union':
      case 'object':
        return this.composite(t);
    }
  }

  private composite(t: IComposite): string {
    const cached = this.cache.get(t);
    if (cached !== undefined) return cached;
    let sig: string;
    if (t.kind === 'array') {
      sig = `[${this.of(t.items)}]`;
    } else if (t.kind === 'record') {
      sig = `{*:${this.of(t.values)}}`;
    } else if (t.kind === 'union') {
      sig = `(${t.members.map((m) => this.of(m)).join('|')})`;
    } else {
      const parts = t.fields.map((f) => `${JSON.stringify(f.name)}${f.optional ? '?' : ''}:${this.of(f.type)}`).sort();
      const key = `{${parts.join(',')}}`;
      sig = this.ids.get(key) ?? `#${this.ids.size}`;
      this.ids.set(key, sig);
    }
    this.cache.set(t, sig);
    return sig;
  }
}

interface Declaration {
  name: string;
  type: IType;
  root: boolean;
  description?: string;
  /** A root whose shape is already declared under this name. */
  aliasOf?: string;
}

/**
 * Plans the declarations for a set of roots. Nested objects (with hoisting) are named from their key
 * (singularized for array items and dictionary values); vague or global-shadowing keys are prefixed with the
 * parent name; shapes reached through several keys take the keys' common trailing words (billingAddress +
 * shippingAddress -> Address); name clashes between different shapes try `<Parent><Key>`, then `<Key>2`,
 * `<Key>3`... Declarations are in pre-order (roots first, then what they use, top-down).
 */
class DeclarationPlan {
  readonly decls: Declaration[] = [];
  private readonly sigs = new ShapeSignatures();
  private readonly names = new Map<string, string>();
  private readonly taken = new Set<string>();
  private readonly bases = new Map<string, string[]>();
  /** Word each hoisted name was built from, to spot a key nested in itself (level > level > level). */
  private readonly words = new Map<string, string>();

  constructor(
    roots: readonly IRoot[],
    readonly hoist: boolean,
  ) {
    for (const root of roots) this.taken.add(root.name);
    if (hoist) for (const root of roots) this.collectRoot(root);
    for (const root of roots) this.assignRoot(root);
  }

  /** Declared name of a nested object, when it is hoisted. */
  refName(t: IType): string | undefined {
    return this.hoist && isNamedShape(t) ? this.names.get(this.sigs.of(t)) : undefined;
  }

  /** Names a declaration refers to directly. */
  dependencies(decl: Declaration): string[] {
    if (decl.aliasOf) return [decl.aliasOf];
    const out: string[] = [];
    this.collectRefs(decl.type, true, out);
    return out;
  }

  private collectRefs(t: IType, top: boolean, out: string[]): void {
    if (t.kind === 'array') {
      this.collectRefs(t.items, false, out);
    } else if (t.kind === 'record') {
      this.collectRefs(t.values, false, out);
    } else if (t.kind === 'union') {
      for (const member of t.members) this.collectRefs(member, false, out);
    } else if (t.kind === 'object') {
      const ref = top ? undefined : this.refName(t);
      if (ref) out.push(ref);
      else for (const field of t.fields) this.collectRefs(field.type, false, out);
    }
  }

  /** Pass 1: every key each shape is reached through (for the common-suffix naming rule). */
  private collectRoot(root: IRoot): void {
    if (isNamedShape(root.type)) for (const field of root.type.fields) this.collect(field.type, field.name, 'field');
    else this.collect(root.type, '', 'field');
  }

  private collect(t: IType, key: string, position: Position): void {
    if (t.kind === 'array') {
      this.collect(t.items, key, 'item');
    } else if (t.kind === 'record') {
      this.collect(t.values, key, 'value');
    } else if (t.kind === 'union') {
      for (const member of t.members) this.collect(member, key, position);
    } else if (isNamedShape(t)) {
      const sig = this.sigs.of(t);
      const base = baseName(key, position);
      const seen = this.bases.get(sig);
      if (seen) {
        if (!seen.includes(base)) seen.push(base);
        return;
      }
      this.bases.set(sig, [base]);
      for (const field of t.fields) this.collect(field.type, field.name, 'field');
    }
  }

  /** Pass 2: names, in the same traversal order. */
  private assignRoot(root: IRoot): void {
    const decl: Declaration = { name: root.name, type: root.type, root: true };
    if (root.description) decl.description = root.description;
    if (!this.hoist) {
      this.decls.push(decl);
      return;
    }
    if (isNamedShape(root.type)) {
      const sig = this.sigs.of(root.type);
      const existing = this.names.get(sig);
      if (existing) {
        this.decls.push({ ...decl, aliasOf: existing });
        return;
      }
      this.names.set(sig, root.name);
      this.decls.push(decl);
      for (const field of root.type.fields) this.assign(field.type, field.name, 'field', root.name);
      return;
    }
    this.decls.push(decl);
    this.assign(root.type, '', 'field', root.name);
  }

  private assign(t: IType, key: string, position: Position, parent: string): void {
    if (t.kind === 'array') {
      this.assign(t.items, key, 'item', parent);
    } else if (t.kind === 'record') {
      this.assign(t.values, key, 'value', parent);
    } else if (t.kind === 'union') {
      for (const member of t.members) this.assign(member, key, position, parent);
    } else if (isNamedShape(t)) {
      const sig = this.sigs.of(t);
      if (this.names.has(sig)) return;
      const common = commonTrailingWords(this.bases.get(sig) ?? []);
      const base = common && !isGeneric(common) ? common : baseName(key, position);
      const word = base || FALLBACK_WORDS[position];
      const name = this.chooseName(base, word, parent);
      this.names.set(sig, name);
      this.words.set(name, word);
      this.taken.add(name);
      this.decls.push({ name, type: t, root: false });
      for (const field of t.fields) this.assign(field.type, field.name, 'field', name);
    }
  }

  private chooseName(base: string, word: string, parent: string): string {
    const standalone = base !== '' && /^[A-Za-z]/.test(base) && !isGeneric(base) && !RESERVED_NAMES.has(base);
    // The same key inside itself (trees, wrappers) is numbered: Level, Level2, Level3 / CategoryChild, CategoryChild2.
    const chained = this.words.get(parent) === word;
    const prefixed = `${parent}${word}`;
    const candidates: string[] = [];
    if (standalone) candidates.push(base);
    if (!chained && prefixed.length <= MAX_PREFIXED_NAME) candidates.push(prefixed);
    for (const candidate of candidates) if (!this.taken.has(candidate)) return candidate;
    const fallback = /^[A-Za-z]/.test(word) && !RESERVED_NAMES.has(word) ? word : `T${word}`;
    const stem = chained ? parent.replace(/\d+$/, '') : (candidates[0] ?? fallback);
    for (let n = 2; ; n++) {
      if (!this.taken.has(`${stem}${n}`)) return `${stem}${n}`;
    }
  }
}

/** Declarations whose dependencies come first (Zod consts must be defined before use). */
function dependencyOrder(plan: DeclarationPlan): Declaration[] {
  const byName = new Map(plan.decls.map((d) => [d.name, d]));
  const done = new Set<string>();
  const out: Declaration[] = [];
  const visit = (decl: Declaration): void => {
    if (done.has(decl.name)) return;
    done.add(decl.name);
    for (const dep of plan.dependencies(decl)) {
      const target = byName.get(dep);
      if (target) visit(target);
    }
    out.push(decl);
  };
  for (const decl of plan.decls) visit(decl);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shared printing helpers
// ---------------------------------------------------------------------------------------------

/** JSON string literal that is also a valid JS string literal and safe in a `//` comment (U+2028/9 escaped). */
function stringLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function docComment(text: string): string {
  const lines = text.replace(/\*\//g, '*\\/').split(/\r\n|[\n\r\u2028\u2029]/);
  if (lines.length === 1) return `/** ${lines[0]} */\n`;
  return `/**\n${lines.map((line) => ` * ${line}`.trimEnd()).join('\n')}\n */\n`;
}

/** Example values are shown for free-form strings and dates only (ids, emails and URLs stay out of the code). */
const EXAMPLE_FORMATS = new Set<StringFormat | undefined>([undefined, 'date-time', 'date', 'time']);

/** Formats Zod expresses as a validator (the others become comments). */
const ZOD_FORMAT_METHODS: Partial<Record<StringFormat, string>> = {
  'date-time': '.datetime({ offset: true })',
  uuid: '.uuid()',
  email: '.email()',
  uri: '.url()',
};

interface ScalarFacts {
  unsafe: boolean;
  formats: StringFormat[];
  examples: string[];
}

/** Precision / format / example facts of a type's scalars, looking through arrays, dictionaries and unions (not objects). */
function scalarFacts(t: IType, facts: ScalarFacts = { unsafe: false, formats: [], examples: [] }): ScalarFacts {
  if (t.kind === 'number' && t.unsafeInteger) {
    facts.unsafe = true;
  } else if (t.kind === 'string') {
    if (t.format && !facts.formats.includes(t.format)) facts.formats.push(t.format);
    if (EXAMPLE_FORMATS.has(t.format)) facts.examples.push(...(t.examples ?? []));
  } else if (t.kind === 'array') {
    scalarFacts(t.items, facts);
  } else if (t.kind === 'record') {
    scalarFacts(t.values, facts);
  } else if (t.kind === 'union') {
    for (const member of t.members) scalarFacts(member, facts);
  }
  return facts;
}

/** Text of the trailing `//` annotation ('' for none). */
function annotation(t: IType, format: 'typescript' | 'zod'): string {
  const facts = scalarFacts(t);
  const parts: string[] = [];
  if (t.kind === 'null') parts.push(ONLY_NULL_NOTE);
  if (facts.unsafe) parts.push(PRECISION_NOTE);
  const formats = format === 'zod' ? facts.formats.filter((f) => !ZOD_FORMAT_METHODS[f]) : facts.formats;
  const examples = facts.examples
    .map(stringLiteral)
    .filter((literal) => literal.length <= MAX_COMMENT_EXAMPLE_CHARS + 2)
    .slice(0, MAX_EXAMPLES);
  const detail = [formats.join(', '), examples.length ? `e.g. ${examples.join(', ')}` : ''].filter(Boolean).join(', ');
  if (detail) parts.push(detail);
  return parts.join('; ');
}

function trailingComment(t: IType, annotate: boolean, format: 'typescript' | 'zod'): string {
  const text = annotate ? annotation(t, format) : '';
  return text ? ` // ${text}` : '';
}

// ---------------------------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------------------------

function printTypeScript(plan: DeclarationPlan, annotate: boolean): string {
  if (plan.decls.length === 0) return '';
  return `${plan.decls.map((d) => tsDeclaration(plan, d, annotate)).join('\n\n')}\n`;
}

function tsDeclaration(plan: DeclarationPlan, decl: Declaration, annotate: boolean): string {
  const doc = decl.description ? docComment(decl.description) : '';
  if (decl.aliasOf) return `${doc}export type ${decl.name} = ${decl.aliasOf};`;
  if (isNamedShape(decl.type)) {
    return `${doc}export interface ${decl.name} {\n${tsFields(plan, decl.type.fields, '  ', annotate)}\n}`;
  }
  const comment = trailingComment(decl.type, annotate, 'typescript');
  return `${doc}export type ${decl.name} = ${tsType(plan, decl.type, '', annotate)};${comment}`;
}

function tsFields(plan: DeclarationPlan, fields: readonly IField[], indent: string, annotate: boolean): string {
  return fields
    .map((f) => {
      const key = IDENTIFIER.test(f.name) ? f.name : stringLiteral(f.name);
      const comment = trailingComment(f.type, annotate, 'typescript');
      return `${indent}${key}${f.optional ? '?' : ''}: ${tsType(plan, f.type, indent, annotate)};${comment}`;
    })
    .join('\n');
}

function tsType(plan: DeclarationPlan, t: IType, indent: string, annotate: boolean): string {
  switch (t.kind) {
    case 'unknown':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return t.kind;
    case 'blob':
      return 'Blob';
    case 'array': {
      const items = tsType(plan, t.items, indent, annotate);
      return t.items.kind === 'union' ? `(${items})[]` : `${items}[]`;
    }
    case 'record':
      return `Record<string, ${tsType(plan, t.values, indent, annotate)}>`;
    case 'union':
      return t.members.map((m) => tsType(plan, m, indent, annotate)).join(' | ');
    case 'object': {
      if (t.fields.length === 0) return 'Record<string, unknown>';
      const ref = plan.refName(t);
      if (ref) return ref;
      return `{\n${tsFields(plan, t.fields, `${indent}  `, annotate)}\n${indent}}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Zod (API shared by Zod 3.23+ and Zod 4)
// ---------------------------------------------------------------------------------------------

function printZod(plan: DeclarationPlan, annotate: boolean): string {
  if (plan.decls.length === 0) return '';
  const blocks = dependencyOrder(plan).map((d) => zodDeclaration(plan, d, annotate));
  return `import { z } from 'zod';\n\n${blocks.join('\n\n')}\n`;
}

function zodDeclaration(plan: DeclarationPlan, decl: Declaration, annotate: boolean): string {
  const doc = decl.description ? docComment(decl.description) : '';
  const schema = `${decl.name}Schema`;
  let value: string;
  if (decl.aliasOf) value = `${decl.aliasOf}Schema;`;
  else if (isNamedShape(decl.type)) value = `${zodObject(plan, decl.type, '', annotate)};`;
  else value = `${zodType(plan, decl.type, '', annotate)};${trailingComment(decl.type, annotate, 'zod')}`;
  return `${doc}export const ${schema} = ${value}\nexport type ${decl.name} = z.infer<typeof ${schema}>;`;
}

function zodObject(plan: DeclarationPlan, t: IObject, indent: string, annotate: boolean): string {
  const inner = `${indent}  `;
  const lines = t.fields.map((f) => {
    // `__proto__: x` in an object literal sets the prototype; the computed form defines an own key.
    const key = f.name === '__proto__' ? '["__proto__"]' : IDENTIFIER.test(f.name) ? f.name : stringLiteral(f.name);
    const value = `${zodType(plan, f.type, inner, annotate)}${f.optional ? '.optional()' : ''}`;
    return `${inner}${key}: ${value},${trailingComment(f.type, annotate, 'zod')}`;
  });
  return `z.object({\n${lines.join('\n')}\n${indent}})`;
}

function zodType(plan: DeclarationPlan, t: IType, indent: string, annotate: boolean): string {
  switch (t.kind) {
    case 'unknown':
      return 'z.unknown()';
    case 'null':
      return 'z.null()';
    case 'boolean':
      return 'z.boolean()';
    case 'blob':
      return 'z.instanceof(Blob)';
    case 'number':
      return t.integer && !t.unsafeInteger ? 'z.number().int()' : 'z.number()';
    case 'string':
      return `z.string()${(t.format && ZOD_FORMAT_METHODS[t.format]) ?? ''}`;
    case 'array':
      return `z.array(${zodType(plan, t.items, indent, annotate)})`;
    case 'record':
      return `z.record(z.string(), ${zodType(plan, t.values, indent, annotate)})`;
    case 'object': {
      if (t.fields.length === 0) return 'z.record(z.string(), z.unknown())';
      const ref = plan.refName(t);
      return ref ? `${ref}Schema` : zodObject(plan, t, indent, annotate);
    }
    case 'union': {
      const present = t.members.filter((m) => m.kind !== 'null');
      const base =
        present.length === 1
          ? zodType(plan, present[0], indent, annotate)
          : `z.union([${present.map((m) => zodType(plan, m, indent, annotate)).join(', ')}])`;
      return present.length < t.members.length ? `${base}.nullable()` : base;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// JSON Schema (draft 2020-12)
// ---------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Assign without invoking the `__proto__` setter (keys are captured page data). */
function setOwn(target: JsonObject, key: string, value: Json): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function printJsonSchema(plan: DeclarationPlan, annotate: boolean): string {
  const defs: JsonObject = {};
  for (const decl of plan.decls) setOwn(defs, decl.name, jsonDeclaration(plan, decl, annotate));
  const roots = plan.decls.filter((d) => d.root).map((d): JsonObject => ({ $ref: `#/$defs/${d.name}` }));
  const doc: JsonObject = { $schema: JSON_SCHEMA_DIALECT };
  // anyOf, not oneOf: a value may well be valid for several roots (e.g. two objects of optional fields).
  if (roots.length === 1) doc.$ref = roots[0].$ref;
  else if (roots.length > 1) doc.anyOf = roots;
  doc.$defs = defs;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function jsonDeclaration(plan: DeclarationPlan, decl: Declaration, annotate: boolean): JsonObject {
  const schema = decl.aliasOf ? { $ref: `#/$defs/${decl.aliasOf}` } : jsonSchema(plan, decl.type, annotate, true);
  return decl.description ? { description: decl.description, ...schema } : schema;
}

const JSON_SCALARS = new Set<IType['kind']>(['null', 'boolean', 'number', 'string']);

function jsonTypeName(t: IType): string {
  if (t.kind === 'number') return t.integer ? 'integer' : 'number';
  return t.kind;
}

/** format / examples / $comment of the scalars in `t` (annotate only). */
function jsonAnnotations(t: IType, annotate: boolean): JsonObject {
  if (!annotate) return {};
  const out: JsonObject = {};
  const string = membersOf(t).find((m): m is StringNode => m.kind === 'string');
  if (string?.format) out.format = string.format;
  if (string?.examples?.length && EXAMPLE_FORMATS.has(string.format)) out.examples = string.examples.slice(0, MAX_EXAMPLES);
  if (membersOf(t).some((m) => m.kind === 'number' && m.unsafeInteger)) out.$comment = PRECISION_NOTE;
  if (t.kind === 'null') out.$comment = ONLY_NULL_NOTE;
  return out;
}

function jsonSchema(plan: DeclarationPlan, t: IType, annotate: boolean, top = false): JsonObject {
  switch (t.kind) {
    case 'unknown':
      return {};
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return { type: jsonTypeName(t), ...jsonAnnotations(t, annotate) };
    case 'blob':
      return { type: 'string', contentEncoding: 'binary' };
    case 'array':
      return t.items.kind === 'unknown' ? { type: 'array' } : { type: 'array', items: jsonSchema(plan, t.items, annotate) };
    case 'record':
      return t.values.kind === 'unknown'
        ? { type: 'object' }
        : { type: 'object', additionalProperties: jsonSchema(plan, t.values, annotate) };
    case 'union':
      if (t.members.every((m) => JSON_SCALARS.has(m.kind))) {
        return { type: t.members.map(jsonTypeName), ...jsonAnnotations(t, annotate) };
      }
      return { anyOf: t.members.map((m) => (m.kind === 'null' ? { type: 'null' } : jsonSchema(plan, m, annotate))) };
    case 'object': {
      const ref = top ? undefined : plan.refName(t);
      if (ref) return { $ref: `#/$defs/${ref}` };
      if (t.fields.length === 0) return { type: 'object' };
      const properties: JsonObject = {};
      for (const field of t.fields) setOwn(properties, field.name, jsonSchema(plan, field.type, annotate));
      const required = t.fields.filter((f) => !f.optional).map((f) => f.name);
      return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Emission entry points
// ---------------------------------------------------------------------------------------------

export interface NamedType {
  /** PascalCase type name, e.g. "CreateOrderRequestBody". */
  name: string;
  type: TypeNode;
  /** Doc comment for the root type. */
  description?: string;
}

export interface EmitOptions {
  /**
   * Hoist nested object types into their own named declarations (named from their key, singularized for
   * array items, e.g. items[] -> OrderItem), deduplicating structurally identical shapes. Default true.
   */
  hoist?: boolean;
  /** Add example values / formats / precision warnings as comments (TS, Zod) or `examples`/`format` (JSON Schema). Default true. */
  annotate?: boolean;
}

/**
 * Emit declarations for the given root types.
 *  - typescript: `export interface` for objects, `export type` otherwise; keys quoted when not identifiers;
 *    optional `?`; unions `A | B`; arrays `T[]` (parenthesized unions); unsafe integers typed `number` with a
 *    `// precision: exceeds 2^53` comment.
 *  - zod: `import { z } from 'zod';` + `export const XSchema = z.object({...})` + `export type X = z.infer<typeof XSchema>`;
 *    formats -> z.string().datetime() / .uuid() / .email() / .url(); integers -> z.number().int(); hoisted schemas declared before use.
 *  - json-schema: one JSON document (draft 2020-12) with `$defs` for every named type and a root `oneOf`/`$defs`
 *    index; `required` lists non-optional fields; `format`, `examples` when annotate.
 * Output is deterministic (stable ordering) and valid for its language.
 *
 * Details: names are sanitized to PascalCase identifiers (duplicates numbered); objects without fields are
 * `Record<string, unknown>` / `z.record(z.string(), z.unknown())` / `{type: object}`; a root whose shape is
 * already declared becomes an alias of it; the JSON Schema index is `$ref` for one root and `anyOf` for
 * several (oneOf would reject values valid for more than one root). No types: '' (TS, Zod) or a schema
 * document with empty `$defs`.
 */
export function emitTypes(types: NamedType[], format: TypeFormat, opts?: EmitOptions): string {
  return emit(types, format, opts);
}

function emit(types: readonly IRoot[], format: TypeFormat, opts: EmitOptions | undefined): string {
  const used = new Set<string>();
  const roots = types.map((t, i): IRoot => {
    const base = toTypeName(t.name, `Type${i + 1}`);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}${n}`;
    used.add(name);
    const type = withRecords(t.type);
    return t.description ? { name, type, description: t.description } : { name, type };
  });
  const plan = new DeclarationPlan(roots, opts?.hoist ?? true);
  const annotate = opts?.annotate ?? true;
  if (format === 'zod') return printZod(plan, annotate);
  if (format === 'json-schema') return printJsonSchema(plan, annotate);
  return printTypeScript(plan, annotate);
}

// ---------------------------------------------------------------------------------------------
// Whole endpoint
// ---------------------------------------------------------------------------------------------

export interface GeneratedTypes {
  format: TypeFormat;
  code: string;
  /** Root names by role: pathParams, query, requestBody, response (success), errorResponse, graphqlVariables, graphqlData. */
  names: Record<string, string>;
  notes: string[];
}

type EndpointRole =
  | 'pathParams'
  | 'query'
  | 'requestBody'
  | 'response'
  | 'errorResponse'
  | 'graphqlVariables'
  | 'graphqlData';

interface RoleRoot extends IRoot {
  role: EndpointRole;
}

/** Query parameters that carry a GraphQL GET request itself (typed as Variables, not as Query). */
const GRAPHQL_QUERY_PARAMS = new Set(['query', 'variables', 'operationName', 'extensions']);

/**
 * Types for a whole endpoint, named `<baseName><Role>`: PathParams, Query (string values; repeated params ->
 * string[]; optional when not required), RequestBody (JSON samples / form & multipart fields: text -> string,
 * file -> Blob (TS) / z.instanceof(Blob) / {type:string, contentEncoding:binary}), Response (merged 2xx
 * samples), ErrorResponse (merged 4xx/5xx JSON samples), and for GraphQL bodies <Op>Variables and <Op>Data
 * (from response.data) instead of RequestBody/Response.
 *
 * Details: `baseName` (default suggestBaseName(spec), which is the operation name for GraphQL) is sanitized to a
 * PascalCase identifier and also prefixes the GraphQL roles, so a renamed base renames every root. Roles without
 * data are omitted (no params, no JSON bodies, empty GraphQL variables). Notes cover precision loss, truncated
 * samples, a single response sample, redacted values, depth-limited values and bodies that could not be typed.
 */
export function generateEndpointTypes(spec: EndpointSpec, opts: { format: TypeFormat; baseName?: string } & EmitOptions): GeneratedTypes {
  const requested = opts.baseName?.trim();
  const base = toTypeName(requested ? requested : suggestBaseName(spec), 'Endpoint');
  const stats = newStats();
  const notes: string[] = [];
  const roots: RoleRoot[] = [];
  const add = (role: EndpointRole, suffix: string, type: IType, description: string): string => {
    const name = `${base}${suffix}`;
    roots.push({ role, name, type: withRecords(type), description });
    return name;
  };
  const title = `${spec.method.toUpperCase()} ${spec.pathTemplate}`;
  const isGraphql = spec.graphql !== null || spec.requestBody?.kind === 'graphql';

  if (spec.pathParams.length) add('pathParams', 'PathParams', pathParamsType(spec.pathParams), `Path parameters of ${title}.`);
  const query = isGraphql ? spec.query.filter((q) => !GRAPHQL_QUERY_PARAMS.has(q.name)) : spec.query;
  if (query.length) add('query', 'Query', queryType(query), `Query parameters of ${title}.`);

  if (isGraphql) {
    addGraphqlRoots(spec, stats, notes, add);
  } else {
    addRequestBody(spec.requestBody, stats, notes, (type) => add('requestBody', 'RequestBody', type, `Request body of ${title}.`));
    const success = responseSamples(spec, isSuccess);
    if (success.samples.length) {
      const name = add('response', 'Response', inferSamples(success.samples, stats), `Response body of ${title} (${success.statuses.join(', ')}).`);
      noteSamples(notes, success, name, 'response');
    } else {
      noteUntypedResponses(notes, success.untyped, 'Response');
    }
  }

  const errors = responseSamples(spec, isError);
  if (errors.samples.length) {
    const name = add('errorResponse', 'ErrorResponse', inferSamples(errors.samples, stats), `Error response body of ${title} (${errors.statuses.join(', ')}).`);
    if (errors.truncated) notes.push(`An error response sample was truncated; ${name} may be incomplete.`);
  }

  notes.unshift(...precisionNotes(roots));
  if (stats.redacted) notes.push('Redacted values are typed as string: their real type is hidden.');
  if (stats.depthLimited) notes.push(`Values nested deeper than ${MAX_DEPTH} levels are typed as unknown.`);
  if (roots.length === 0) notes.push('Nothing to type: no path or query parameters and no JSON bodies were captured.');

  const names: Record<string, string> = {};
  for (const root of roots) names[root.role] = root.name;
  return { format: opts.format, code: emit(roots, opts.format, opts), names, notes };
}

type AddRoot = (role: EndpointRole, suffix: string, type: IType, description: string) => string;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;
const isError = (status: number): boolean => status >= 400 && status < 600;

/** Plain strings from (redaction-free) examples, with a format when every example has it. */
function stringFromExamples(examples: readonly string[]): IType {
  let type: IType = { kind: 'unknown' };
  const stats = newStats(); // redacted query/form values lose nothing: they are strings anyway
  for (const example of examples) type = merge(type, stringType(example, stats));
  return type.kind === 'unknown' ? { kind: 'string' } : type;
}

/** Object type from named fields; a repeated name keeps its first definition. */
function objectOf(fields: readonly IField[]): IType {
  const unique = new Map<string, IField>();
  for (const field of fields) if (!unique.has(field.name)) unique.set(field.name, field);
  return { kind: 'object', fields: [...unique.values()] };
}

function pathParamsType(params: readonly PathParam[]): IType {
  return objectOf(params.map((p) => ({ name: p.name, type: stringFromExamples([p.example]), optional: false })));
}

function queryType(params: readonly QueryParamSpec[]): IType {
  return objectOf(
    params.map((q) => {
      const value = stringFromExamples(q.redacted ? [] : q.examples);
      return { name: q.name, type: q.repeated ? { kind: 'array', items: value } : value, optional: !q.required };
    }),
  );
}

function addRequestBody(body: BodySpec | null, stats: InferStats, notes: string[], add: (type: IType) => string): void {
  if (!body || body.kind === 'none') return;
  if (body.samples.length) {
    const name = add(inferSamples(body.samples, stats));
    if (body.truncated) notes.push(`The request body sample was truncated; ${name} may be incomplete.`);
  } else if ((body.kind === 'form' || body.kind === 'multipart') && body.fields?.length) {
    add(
      objectOf(
        body.fields.map((f) => {
          const value: IType = f.kind === 'file' ? { kind: 'blob' } : stringFromExamples(f.example === undefined ? [] : [f.example]);
          return { name: f.name, type: f.repeated ? { kind: 'array', items: value } : value, optional: !f.required };
        }),
      ),
    );
  } else if (body.kind === 'unavailable') {
    notes.push('The request body was not captured, so there is no RequestBody type.');
  } else if (body.kind !== 'form' && body.kind !== 'multipart') {
    notes.push(`The request body is not JSON (${body.contentType ?? body.kind}), so there is no RequestBody type.`);
  }
}

interface ResponseSamples {
  samples: JNode[];
  statuses: number[];
  truncated: boolean;
  /** Matching responses with a body that has no JSON sample. */
  untyped: Array<{ status: number; body: BodySpec }>;
}

function responseSamples(spec: EndpointSpec, match: (status: number) => boolean): ResponseSamples {
  const out: ResponseSamples = { samples: [], statuses: [], truncated: false, untyped: [] };
  for (const response of spec.responses) {
    const body = response.body;
    if (!match(response.status) || !body || body.kind === 'none') continue;
    if (body.samples.length === 0) {
      out.untyped.push({ status: response.status, body });
      continue;
    }
    out.samples.push(...body.samples);
    if (!out.statuses.includes(response.status)) out.statuses.push(response.status);
    out.truncated ||= body.truncated;
  }
  return out;
}

function noteSamples(notes: string[], found: Pick<ResponseSamples, 'samples' | 'truncated'>, name: string, what: string): void {
  if (found.truncated) notes.push(`A ${what} sample was truncated; ${name} may be incomplete.`);
  if (found.samples.length === 1) {
    notes.push(`Only one ${what} sample: optional fields can't be detected; send more test requests to refine.`);
  }
}

function noteUntypedResponses(notes: string[], untyped: ResponseSamples['untyped'], typeLabel: string): void {
  if (untyped.length === 0) return;
  const { status, body } = untyped[0];
  const reason =
    body.kind === 'unavailable'
      ? 'was not captured'
      : body.kind === 'json' || body.kind === 'graphql'
        ? body.truncated
          ? 'was truncated and is not valid JSON'
          : 'is not valid JSON'
        : `is not JSON (${body.contentType ?? body.kind})`;
  notes.push(`The ${status} response body ${reason}, so there is no ${typeLabel} type.`);
}

function childByKey(node: JNode | undefined, key: string): JNode | undefined {
  if (!node || node.type !== 'object') return undefined;
  let found: JNode | undefined;
  for (const child of node.children ?? []) if (child.key === key) found = child; // last duplicate wins
  return found;
}

/** The operation of a GraphQL request sample: the object itself, or the matching / first entry of a batch. */
function graphqlOperation(sample: JNode, operationName: string | null): { op: JNode; index: number } | null {
  if (sample.type === 'object') return { op: sample, index: 0 };
  if (sample.type !== 'array') return null;
  const ops = sample.children ?? [];
  let index = ops.findIndex((o) => {
    const name = childByKey(o, 'operationName');
    return operationName !== null && name?.type === 'string' && name.value === operationName;
  });
  if (index < 0) index = ops.findIndex((o) => o.type === 'object');
  return index < 0 ? null : { op: ops[index], index };
}

function addGraphqlRoots(spec: EndpointSpec, stats: InferStats, notes: string[], add: AddRoot): void {
  const gql = spec.graphql;
  const label = `GraphQL ${gql?.operationType ?? 'operation'}${gql?.operationName ? ` ${gql.operationName}` : ''}`;
  const operationName = gql?.operationName ?? null;

  const variables: JNode[] = [];
  let opIndex = -1;
  for (const sample of spec.requestBody?.samples ?? []) {
    const found = graphqlOperation(sample, operationName);
    if (!found) continue;
    if (opIndex < 0) opIndex = found.index;
    const vars = childByKey(found.op, 'variables');
    if (vars?.type === 'object') variables.push(vars);
  }
  if (variables.length === 0) {
    // GET requests carry the variables as a JSON query parameter.
    for (const example of spec.query.find((q) => q.name === 'variables' && !q.redacted)?.examples ?? []) {
      const tree = tryParseJsonTree(example);
      if (tree?.type === 'object') variables.push(tree);
    }
  }
  const variablesType = inferSamples(variables, stats);
  if (isNamedShape(variablesType)) add('graphqlVariables', 'Variables', variablesType, `Variables of the ${label}.`);

  const success = responseSamples(spec, isSuccess);
  const data: JNode[] = [];
  for (const sample of success.samples) {
    const result = sample.type === 'array' ? sample.children?.[Math.max(opIndex, 0)] : sample;
    const value = childByKey(result, 'data');
    if (value && value.type !== 'null') data.push(value);
  }
  if (data.length) {
    const name = add('graphqlData', 'Data', inferSamples(data, stats), `The \`data\` of the ${label} response.`);
    noteSamples(notes, { samples: data, truncated: success.truncated }, name, 'response');
  } else if (success.samples.length === 0) {
    noteUntypedResponses(notes, success.untyped, 'Data');
  }
}

/** One note listing where integers lose precision (first few paths). */
function precisionNotes(roots: readonly IRoot[]): string[] {
  const paths: string[] = [];
  for (const root of roots) unsafePaths(root.type, root.name, paths);
  if (paths.length === 0) return [];
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
  return [`Integers beyond 2^53 (${shown}) lose precision with JSON.parse: read them as strings or BigInt.`];
}

function unsafePaths(t: IType, path: string, out: string[]): void {
  if (t.kind === 'number') {
    if (t.unsafeInteger && !out.includes(path)) out.push(path);
  } else if (t.kind === 'array') {
    unsafePaths(t.items, `${path}[]`, out);
  } else if (t.kind === 'record') {
    unsafePaths(t.values, `${path}[*]`, out);
  } else if (t.kind === 'union') {
    for (const member of t.members) unsafePaths(member, path, out);
  } else if (t.kind === 'object') {
    for (const f of t.fields) unsafePaths(f.type, IDENTIFIER.test(f.name) ? `${path}.${f.name}` : `${path}[${stringLiteral(f.name)}]`, out);
  }
}
