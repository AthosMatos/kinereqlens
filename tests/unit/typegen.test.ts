import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z as zod3 } from 'zod';
import { z as zod4 } from 'zod/v4';
import { suggestBaseName, type BodySpec, type EndpointSpec, type ResponseSpec } from '../../src/lib/endpoint';
import { parseJsonTree } from '../../src/lib/json-tree';
import { REDACTED } from '../../src/lib/redact';
import {
  emitTypes,
  generateEndpointTypes,
  inferFromSamples,
  inferType,
  mergeTypes,
  singularPascal,
  type EmitOptions,
  type NamedType,
  type TypeNode,
} from '../../src/lib/typegen';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const tree = parseJsonTree;
const infer = (...texts: string[]): TypeNode => inferFromSamples(texts.map((t) => tree(t)));
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/** Order-insensitive form (fields by name, examples sorted) for commutativity checks. */
function canon(t: TypeNode): unknown {
  switch (t.kind) {
    case 'object':
      return { kind: 'object', fields: [...t.fields].sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => ({ ...f, type: canon(f.type) })) };
    case 'array':
      return { ...t, items: canon(t.items) };
    case 'union':
      return { kind: 'union', members: t.members.map(canon) };
    case 'string':
      return t.examples ? { ...t, examples: [...t.examples].sort() } : t;
    default:
      return t;
  }
}

/** Field of an object type (fails the test when missing). */
function field(t: TypeNode, name: string): TypeNode {
  if (t.kind !== 'object') throw new Error(`not an object: ${t.kind}`);
  const found = t.fields.find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found.type;
}

// --- TypeScript compiler (generated code must type-check, and every sample must be assignable) ---

// Next to this file (inside the repo), so `zod` resolves from node_modules whatever the working directory.
const HERE = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const VIRTUAL_DIR = `${HERE}/__typegen_virtual__`;
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
};
const realSourceFiles = new Map<string, ts.SourceFile | undefined>();

/** Diagnostics of an in-memory program (files live in a virtual folder inside the repo, so `zod` resolves). */
function typeErrors(files: Record<string, string>): string[] {
  const virtual = new Map(Object.entries(files).map(([name, text]) => [`${VIRTUAL_DIR}/${name}`, text]));
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const readReal = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError) => {
    const text = virtual.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, language, true);
    if (!realSourceFiles.has(fileName)) realSourceFiles.set(fileName, readReal(fileName, language, onError));
    return realSourceFiles.get(fileName);
  };
  host.fileExists = (fileName) => virtual.has(fileName) || ts.sys.fileExists(fileName);
  host.directoryExists = (dir) => dir === VIRTUAL_DIR || ts.sys.directoryExists(dir);
  host.readFile = (fileName) => virtual.get(fileName) ?? ts.sys.readFile(fileName);
  const program = ts.createProgram([...virtual.keys()], COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${d.file.fileName.slice(VIRTUAL_DIR.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '';
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

interface Case {
  /** Root type name. */
  name: string;
  /** JSON texts. */
  samples: string[];
}

/** A module whose consts only type-check when every sample is assignable to its root type. */
function sampleModule(from: string, cases: readonly Case[], prelude = ''): string {
  const lines = [`import type * as T from './${from}';`, prelude];
  cases.forEach((c, i) => c.samples.forEach((s, j) => lines.push(`export const s${i}_${j}: T.${c.name} = ${s};`)));
  return `${lines.join('\n')}\n`;
}

// --- Zod: evaluate the generated module against the real zod package (v3 API and v4 API) ---

interface ZodSchemaLike {
  safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } };
}

function loadZod(code: string, z: unknown): Record<string, ZodSchemaLike> {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, ZodSchemaLike> = {};
  const require = (id: string): unknown => {
    if (id !== 'zod') throw new Error(`unexpected import ${id}`);
    return { z };
  };
  new Function('require', 'exports', js)(require, exports);
  return exports;
}

const ZODS = [
  ['zod 3', zod3],
  ['zod 4', zod4],
] as const;

function zodParses(code: string, name: string, value: unknown): Array<[string, boolean, string]> {
  return ZODS.map(([label, z]) => {
    const result = loadZod(code, z)[`${name}Schema`].safeParse(value);
    return [label, result.success, result.success ? '' : JSON.stringify(result.error?.issues)];
  });
}

function expectZodAccepts(code: string, name: string, value: unknown): void {
  for (const [label, ok, issues] of zodParses(code, name, value)) expect(ok, `${label}: ${issues}`).toBe(true);
}

// --- JSON Schema: a validator for exactly the subset the emitter produces ---

type Schema = { [key: string]: unknown };
const KNOWN_KEYWORDS = new Set([
  '$schema', '$ref', '$defs', '$comment', 'anyOf', 'type', 'format', 'examples', 'description', 'properties',
  'required', 'items', 'contentEncoding', 'additionalProperties',
]);
const FORMAT_CHECKS: Record<string, (v: string) => boolean> = {
  'date-time': (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d\d-\d\d$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
  time: (v) => /^\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  uri: (v) => URL.canParse(v),
  ipv4: (v) => v.split('.').length === 4 && v.split('.').every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255),
  base64: (v) => btoa(atob(v)) === v,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      throw new Error(`unknown type ${String(type)}`);
  }
}

function validate(schema: Schema, value: unknown, doc: Schema, path = '$'): string[] {
  const errors: string[] = [];
  for (const keyword of Object.keys(schema)) if (!KNOWN_KEYWORDS.has(keyword)) errors.push(`${path}: unexpected keyword ${keyword}`);
  if (typeof schema.$ref === 'string') {
    const defs = doc.$defs as Record<string, Schema>;
    const target = Object.hasOwn(defs, schema.$ref.slice(8)) ? defs[schema.$ref.slice(8)] : undefined;
    if (!schema.$ref.startsWith('#/$defs/') || !target) errors.push(`${path}: dangling ${schema.$ref}`);
    else errors.push(...validate(target, value, doc, path));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: Schema) => validate(s, value, doc, path).length === 0)) {
    errors.push(`${path}: no anyOf branch matches`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) errors.push(`${path}: expected ${types.join(' | ')}`);
  }
  if (typeof value === 'string' && typeof schema.format === 'string' && !FORMAT_CHECKS[schema.format](value)) {
    errors.push(`${path}: not a ${schema.format}`);
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validate(sub as Schema, value[key], doc, `${path}.${key}`));
    }
  }
  if (isRecord(value) && isRecord(schema.additionalProperties)) {
    const declared = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(declared, key)) errors.push(...validate(schema.additionalProperties as Schema, value[key], doc, `${path}.${key}`));
    }
  }
  if (isRecord(value) && Array.isArray(schema.required)) {
    for (const key of schema.required as string[]) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing ${key}`);
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, i) => errors.push(...validate(schema.items as Schema, item, doc, `${path}[${i}]`)));
  }
  return errors;
}

/**
 * Emit `types` in all three formats and check each against the samples: TS + Zod type-check (samples
 * assigned to the TS types and to the z.infer types), Zod 3 and Zod 4 parse every sample, and the JSON Schema
 * document validates every sample both through its root index and through the named `$defs` entry.
 */
function verifyAllFormats(types: NamedType[], cases: readonly Case[], opts?: EmitOptions, prelude = ''): Record<'ts' | 'zod' | 'schema', string> {
  const out = {
    ts: emitTypes(types, 'typescript', opts),
    zod: emitTypes(types, 'zod', opts),
    schema: emitTypes(types, 'json-schema', opts),
  };
  expect(
    typeErrors({
      'types.ts': out.ts,
      'types.check.ts': sampleModule('types', cases, prelude),
      'zod.ts': out.zod,
      'zod.check.ts': sampleModule('zod', cases, prelude),
    }),
  ).toEqual([]);
  const doc = JSON.parse(out.schema) as Schema;
  expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  for (const c of cases) {
    for (const sample of c.samples) {
      const value: unknown = JSON.parse(sample);
      expectZodAccepts(out.zod, c.name, value);
      expect(validate(doc, value, doc)).toEqual([]);
      expect(validate((doc.$defs as Record<string, Schema>)[c.name], value, doc)).toEqual([]);
    }
  }
  return out;
}

const COMPILE_TIMEOUT = 60_000;

// --- EndpointSpec fixtures ---

function endpoint(patch: Partial<EndpointSpec> = {}): EndpointSpec {
  return {
    method: 'GET',
    url: 'https://api.example.com/orders',
    origin: 'https://api.example.com',
    pathTemplate: '/orders',
    pathParams: [],
    query: [],
    requestHeaders: [],
    auth: [],
    requestBody: null,
    responses: [],
    graphql: null,
    pageOrigin: 'https://app.example.com',
    capturedAt: 0,
    notes: [],
    redacted: false,
    ...patch,
  };
}

function jsonBody(texts: string[], patch: Partial<BodySpec> = {}): BodySpec {
  return { contentType: 'application/json', kind: 'json', samples: texts.map((t) => tree(t)), truncated: false, ...patch };
}

function response(status: number, body: BodySpec | null): ResponseSpec {
  return { status, body, sources: ['original'], headers: [] };
}

// ---------------------------------------------------------------------------------------------
// Realistic payloads
// ---------------------------------------------------------------------------------------------

const ORDER_1 = JSON.stringify({
  order: {
    id: 1001,
    status: 'paid',
    createdAt: '2024-05-01T10:00:00Z',
    ref: '3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60',
    items: [
      { sku: 'A1', qty: 2, price: 9.5, product: { id: 1, name: 'Pen' } },
      { sku: 'B2', qty: 1, price: 3, discount: 0.5, product: { id: 2, name: 'Ink' } },
    ],
    billingAddress: { line1: '1 Main St', city: 'Springfield' },
    shippingAddress: { line1: '2 Side St', city: 'Shelbyville' },
    customer: { id: 7, email: 'ann@example.com' },
    note: null,
    tags: [],
    meta: {},
  },
});
const ORDER_2 = JSON.stringify({
  order: {
    id: 1002,
    status: 'pending',
    createdAt: '2024-05-02T10:00:00.250+02:00',
    ref: '0b9f3c1e-2d4a-4e5f-8a6b-7c8d9e0f1a2b',
    items: [],
    billingAddress: { line1: '3 High St', city: 'Ogdenville' },
    shippingAddress: { line1: '3 High St', city: 'Ogdenville' },
    customer: { id: 8, email: 'bob@example.org' },
    note: 'Leave at the door',
    tags: ['gift'],
    meta: {},
  },
});

const USERS_PAGE_1 = JSON.stringify({
  data: [
    { id: 1, name: 'Ann', email: 'ann@example.com', role: 'admin', avatarUrl: 'https://cdn.example.com/a.png', lastLoginAt: '2024-05-01T08:00:00Z' },
    { id: 2, name: 'Bob', email: 'bob@example.com', role: 'member', lastLoginAt: null },
  ],
  meta: { page: 1, perPage: 2, total: 3, nextCursor: 'eyJvZmZzZXQiOjIwfQ==' },
  links: { self: 'https://api.example.com/users?page=1', next: 'https://api.example.com/users?page=2', prev: null },
});
const USERS_PAGE_2 = JSON.stringify({
  data: [{ id: 3, name: 'Cid', email: 'cid@example.com', role: 'member', lastLoginAt: '2024-04-30T23:59:59Z', deletedAt: '2024-05-03' }],
  meta: { page: 2, perPage: 2, total: 3, nextCursor: null },
  links: { self: 'https://api.example.com/users?page=2', next: null, prev: 'https://api.example.com/users?page=1' },
});

// ---------------------------------------------------------------------------------------------
// singularPascal
// ---------------------------------------------------------------------------------------------

describe('singularPascal', () => {
  it('handles the documented examples', () => {
    expect(singularPascal('items')).toBe('Item');
    expect(singularPascal('categories')).toBe('Category');
    expect(singularPascal('addresses')).toBe('Address');
    expect(singularPascal('data')).toBe('Data');
    expect(singularPascal('user_ids')).toBe('UserId');
  });

  it('singularizes only the last word, across naming styles', () => {
    expect(singularPascal('lineItems')).toBe('LineItem');
    expect(singularPascal('order-lines')).toBe('OrderLine');
    expect(singularPascal('ORDER_LINES')).toBe('OrderLine');
    expect(singularPascal('userIDs')).toBe('UserId');
    expect(singularPascal('URLs')).toBe('Url');
    expect(singularPascal('htmlContents')).toBe('HtmlContent');
    expect(singularPascal('itemsList')).toBe('ItemsList');
    expect(singularPascal('v2Records')).toBe('V2Record');
  });

  it('knows common English plural rules and exceptions', () => {
    const cases: Record<string, string> = {
      boxes: 'Box', matches: 'Match', dishes: 'Dish', buzzes: 'Buzz', quizzes: 'Quiz', classes: 'Class',
      statuses: 'Status', status: 'Status', aliases: 'Alias', alias: 'Alias', buses: 'Bus', responses: 'Response',
      cases: 'Case', analyses: 'Analysis', analysis: 'Analysis', indices: 'Index', matrices: 'Matrix',
      people: 'Person', children: 'Child', men: 'Man', women: 'Woman', movies: 'Movie', cookies: 'Cookie',
      caches: 'Cache', menus: 'Menu', apis: 'Api', uris: 'Uri', series: 'Series', species: 'Species', news: 'News',
      metadata: 'Metadata', media: 'Media', criteria: 'Criterion', wolves: 'Wolf', moves: 'Move', shoes: 'Shoe',
      heroes: 'Hero', photos: 'Photo', address: 'Address', access: 'Access', bonus: 'Bonus', canvas: 'Canvas',
      gps: 'Gps', ids: 'Id', keys: 'Key', days: 'Day', entries: 'Entry', processes: 'Process', axes: 'Axis',
    };
    for (const [key, expected] of Object.entries(cases)) expect(singularPascal(key), key).toBe(expected);
  });

  it('drops diacritics and non-Latin characters; empty input gives ""', () => {
    expect(singularPascal('ações')).toBe('Acoe');
    expect(singularPascal('cafés')).toBe('Cafe');
    expect(singularPascal('名前')).toBe('');
    expect(singularPascal('')).toBe('');
    expect(singularPascal('__')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------------------------

describe('inferType', () => {
  it('types scalars', () => {
    expect(inferType(tree('null'))).toEqual({ kind: 'null' });
    expect(inferType(tree('true'))).toEqual({ kind: 'boolean' });
    expect(inferType(tree('"hi"'))).toEqual({ kind: 'string', examples: ['hi'] });
    expect(inferType(tree('42'))).toEqual({ kind: 'number', integer: true });
    expect(inferType(tree('-0'))).toEqual({ kind: 'number', integer: true });
    expect(inferType(tree('4.5'))).toEqual({ kind: 'number', integer: false });
  });

  it('judges integers from the literal text, so 1.0 and 1e3 are not integers', () => {
    expect(inferType(tree('1.0'))).toEqual({ kind: 'number', integer: false });
    expect(inferType(tree('1e3'))).toEqual({ kind: 'number', integer: false });
  });

  it('flags integers beyond ±(2^53-1) as unsafe, exactly at the boundary', () => {
    expect(inferType(tree('9007199254740991'))).toEqual({ kind: 'number', integer: true });
    expect(inferType(tree('-9007199254740991'))).toEqual({ kind: 'number', integer: true });
    expect(inferType(tree('9007199254740992'))).toEqual({ kind: 'number', integer: true, unsafeInteger: true });
    expect(inferType(tree('-9007199254740993'))).toEqual({ kind: 'number', integer: true, unsafeInteger: true });
    expect(inferType(tree('12345678901234567890'))).toEqual({ kind: 'number', integer: true, unsafeInteger: true });
    expect(inferType(tree('1000000000000000'))).toEqual({ kind: 'number', integer: true });
  });

  it('types empty containers', () => {
    expect(inferType(tree('[]'))).toEqual({ kind: 'array', items: { kind: 'unknown' }, maxItems: 0 });
    expect(inferType(tree('{}'))).toEqual({ kind: 'object', fields: [] });
  });

  it('merges array items and records the length', () => {
    expect(inferType(tree('[1, 2.5, 3]'))).toEqual({ kind: 'array', items: { kind: 'number', integer: false }, maxItems: 3 });
    expect(inferType(tree('[1, "a", null]'))).toEqual({
      kind: 'array',
      maxItems: 3,
      items: { kind: 'union', members: [{ kind: 'string', examples: ['a'] }, { kind: 'number', integer: true }, { kind: 'null' }] },
    });
  });

  it('keeps the first position and the last value of duplicate keys (like JSON.parse)', () => {
    const t = inferType(tree('{"a": 1, "b": true, "a": "x"}'));
    expect(t).toEqual({
      kind: 'object',
      fields: [
        { name: 'a', type: { kind: 'string', examples: ['x'] }, optional: false },
        { name: 'b', type: { kind: 'boolean' }, optional: false },
      ],
    });
  });

  it('keeps no example for long strings', () => {
    expect(inferType(tree(JSON.stringify('x'.repeat(101))))).toEqual({ kind: 'string' });
    expect(inferType(tree(JSON.stringify('x'.repeat(100))))).toEqual({ kind: 'string', examples: ['x'.repeat(100)] });
  });

  it('does not keep the redaction marker as an example', () => {
    expect(inferType(tree(JSON.stringify(REDACTED)))).toEqual({ kind: 'string' });
  });
});

describe('string formats', () => {
  const formatOf = (value: string): string | undefined => {
    const t = inferType(tree(JSON.stringify(value)));
    return t.kind === 'string' ? t.format : undefined;
  };

  it('detects RFC 3339 date-times with Z or an offset only', () => {
    expect(formatOf('2024-05-01T10:00:00Z')).toBe('date-time');
    expect(formatOf('2024-05-01T10:00:00.123456Z')).toBe('date-time');
    expect(formatOf('2024-05-01T10:00:00-03:00')).toBe('date-time');
    expect(formatOf('2024-02-29T23:59:59+14:00')).toBe('date-time');
    for (const no of ['2024-05-01T10:00:00', '2024-05-01 10:00:00Z', '2024-05-01T10:00Z', '2024-05-01t10:00:00z', '2023-02-29T00:00:00Z', '2024-05-01T24:00:00Z', '2024-05-01T10:00:60Z', '2024-05-01T10:00:00+0200']) {
      expect(formatOf(no), no).toBeUndefined();
    }
  });

  it('detects calendar dates (leap years included) and offset times', () => {
    expect(formatOf('2024-02-29')).toBe('date');
    expect(formatOf('2000-02-29')).toBe('date');
    expect(formatOf('1999-12-31')).toBe('date');
    for (const no of ['2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '2024-1-1', '20240101']) expect(formatOf(no), no).toBeUndefined();
    expect(formatOf('10:30:00Z')).toBe('time');
    expect(formatOf('10:30:00.5+01:00')).toBe('time');
    expect(formatOf('10:30:00')).toBeUndefined();
  });

  it('detects RFC 9562 UUIDs (and nil), not arbitrary 8-4-4-4-12 hex', () => {
    expect(formatOf('3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60')).toBe('uuid');
    expect(formatOf('018F3C1E-2D4A-7E5F-BA6B-7C8D9E0F1A2B')).toBe('uuid');
    expect(formatOf('00000000-0000-0000-0000-000000000000')).toBe('uuid');
    expect(formatOf('3f1c2a9e-8b7d-0c6e-9f0a-1b2c3d4e5f60')).toBeUndefined();
    expect(formatOf('3f1c2a9e-8b7d-4c6e-cf0a-1b2c3d4e5f60')).toBeUndefined();
  });

  it('detects emails, http(s) URLs and IPv4 conservatively', () => {
    expect(formatOf('a@b.co')).toBe('email');
    expect(formatOf("o'neil+tag@mail.example.com")).toBe('email');
    for (const no of ['a@b', '.a@b.co', 'a..b@c.co', 'a b@c.co', '@b.co']) expect(formatOf(no), no).toBeUndefined();
    expect(formatOf('https://api.example.com/v1/users?page=2#top')).toBe('uri');
    expect(formatOf('http://localhost:8080/')).toBe('uri');
    for (const no of ['ftp://example.com/x', '/relative/path', 'https://', 'https://exa mple.com', 'https://example.com/ü', 'mailto:a@b.co']) {
      expect(formatOf(no), no).toBeUndefined();
    }
    expect(formatOf('192.168.0.1')).toBe('ipv4');
    for (const no of ['256.1.1.1', '1.2.3', '01.2.3.4']) expect(formatOf(no), no).toBeUndefined();
  });

  it('detects base64 only when it cannot be a word, path or MIME type', () => {
    expect(formatOf('aGVsbG8gd29ybGQ=')).toBe('base64');
    expect(formatOf(btoa('x'.repeat(20) + String.fromCharCode(255, 254, 1)))).toBe('base64');
    for (const no of ['application/json', 'HelloWorldHello1', 'abcdabcdabcdabcd', '/api/users/12345', 'deadbeefdeadbeefdeadbeefdeadbeef']) {
      expect(formatOf(no), no).toBeUndefined();
    }
  });

  it('keeps a format only when every sample has it', () => {
    expect(infer('"2024-05-01T10:00:00Z"', '"2024-05-02T10:00:00+01:00"')).toMatchObject({ kind: 'string', format: 'date-time' });
    expect(infer('"2024-05-01T10:00:00Z"', '"2024-05-02"')).toEqual({
      kind: 'string',
      examples: ['2024-05-01T10:00:00Z', '2024-05-02'],
    });
    expect(infer('"2024-05-01T10:00:00Z"', '""')).not.toHaveProperty('format');
  });
});

describe('mergeTypes', () => {
  const A = inferType(tree('{"id": 1, "name": "a", "tags": ["x"], "when": "2024-05-01T10:00:00Z"}'));
  const B = inferType(tree('{"id": 2.5, "extra": true, "tags": [], "when": null, "name": "b"}'));
  const C = inferType(tree('[{"x": 1}, "s", null, [1]]'));

  it('merges objects field-wise: missing fields become optional', () => {
    expect(mergeTypes(A, B)).toEqual({
      kind: 'object',
      fields: [
        { name: 'id', type: { kind: 'number', integer: false }, optional: false },
        { name: 'name', type: { kind: 'string', examples: ['a', 'b'] }, optional: false },
        { name: 'tags', type: { kind: 'array', items: { kind: 'string', examples: ['x'] }, maxItems: 1 }, optional: false },
        {
          name: 'when',
          type: { kind: 'union', members: [{ kind: 'string', format: 'date-time', examples: ['2024-05-01T10:00:00Z'] }, { kind: 'null' }] },
          optional: false,
        },
        { name: 'extra', type: { kind: 'boolean' }, optional: true },
      ],
    });
  });

  it('is commutative and idempotent (up to first-seen order)', () => {
    for (const [x, y] of [[A, B], [A, C], [B, C], [C, C]] as const) {
      expect(canon(mergeTypes(x, y))).toEqual(canon(mergeTypes(y, x)));
    }
    for (const t of [A, B, C]) expect(mergeTypes(t, t)).toEqual(t);
    expect(canon(mergeTypes(mergeTypes(A, B), C))).toEqual(canon(mergeTypes(A, mergeTypes(B, C))));
  });

  it('treats unknown as the identity', () => {
    expect(mergeTypes({ kind: 'unknown' }, A)).toBe(A);
    expect(mergeTypes(A, { kind: 'unknown' })).toBe(A);
    expect(inferFromSamples([])).toEqual({ kind: 'unknown' });
  });

  it('ANDs integer flags and ORs the unsafe flag', () => {
    expect(mergeTypes({ kind: 'number', integer: true }, { kind: 'number', integer: true })).toEqual({ kind: 'number', integer: true });
    expect(mergeTypes({ kind: 'number', integer: true, unsafeInteger: true }, { kind: 'number', integer: false })).toEqual({
      kind: 'number',
      integer: false,
      unsafeInteger: true,
    });
  });

  it('keeps one member per kind, never nests unions, orders members canonically', () => {
    const u = mergeTypes(infer('null'), mergeTypes(infer('1'), infer('"a"')));
    expect(u).toEqual({ kind: 'union', members: [{ kind: 'string', examples: ['a'] }, { kind: 'number', integer: true }, { kind: 'null' }] });
    const v = mergeTypes(u, mergeTypes(infer('2.5'), infer('{"a": 1}')));
    expect(v).toEqual({
      kind: 'union',
      members: [
        { kind: 'string', examples: ['a'] },
        { kind: 'number', integer: false },
        { kind: 'object', fields: [{ name: 'a', type: { kind: 'number', integer: true }, optional: false }] },
        { kind: 'null' },
      ],
    });
    expect(mergeTypes(v, v)).toEqual(v);
  });

  it('merges arrays of differently shaped objects into one object with optional fields', () => {
    const t = infer('[{"type": "click", "x": 1, "y": 2}, {"type": "key", "key": "a"}, {"type": "click", "x": 3, "y": 4}]');
    expect(t).toEqual({
      kind: 'array',
      maxItems: 3,
      items: {
        kind: 'object',
        fields: [
          { name: 'type', type: { kind: 'string', examples: ['click', 'key'] }, optional: false },
          { name: 'x', type: { kind: 'number', integer: true }, optional: true },
          { name: 'y', type: { kind: 'number', integer: true }, optional: true },
          { name: 'key', type: { kind: 'string', examples: ['a'] }, optional: true },
        ],
      },
    });
  });

  it('caps examples at three distinct values', () => {
    expect(infer('["a", "b", "a", "c", "d"]')).toMatchObject({ items: { examples: ['a', 'b', 'c'] } });
  });

  it('merges multiple samples (sparse optional fields, nullable fields)', () => {
    const t = infer(USERS_PAGE_1, USERS_PAGE_2);
    const user = (field(t, 'data') as Extract<TypeNode, { kind: 'array' }>).items;
    expect(user.kind === 'object' && user.fields.map((f) => `${f.name}${f.optional ? '?' : ''}`)).toEqual([
      'id', 'name', 'email', 'role', 'avatarUrl?', 'lastLoginAt', 'deletedAt?',
    ]);
    expect(field(user, 'lastLoginAt')).toMatchObject({ kind: 'union', members: [{ kind: 'string', format: 'date-time' }, { kind: 'null' }] });
    expect(field(user, 'deletedAt')).toMatchObject({ kind: 'string', format: 'date' });
    expect(field(field(t, 'meta'), 'nextCursor')).toMatchObject({ kind: 'union', members: [{ kind: 'string', format: 'base64' }, { kind: 'null' }] });
  });

  it('does not mutate its inputs', () => {
    const a = infer('{"a": 1}');
    const b = infer('{"b": "x"}');
    const before = JSON.stringify([a, b]);
    mergeTypes(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------

describe('emitTypes: TypeScript', () => {
  it(
    'is checked by a harness that really rejects mismatching samples',
    () => {
      const code = emitTypes([{ name: 'R', type: infer('{"a": 1, "b": "x"}') }], 'typescript');
      const check = `import type { R } from './r';\nexport const x: R = { "a": "nope", "b": "x" };\nexport const y: R = { "a": 1 };\n`;
      expect(typeErrors({ 'r.ts': code, 'r.check.ts': check })).toHaveLength(2);
      expect(typeErrors({ 'broken.ts': 'export interface X { a: }' }).length).toBeGreaterThan(0);
      const zod = emitTypes([{ name: 'R', type: infer('{"a": 1, "b": "x"}') }], 'zod');
      expect(typeErrors({ 'zod.ts': zod, 'zod.check.ts': check.replace('./r', './zod') })).toHaveLength(2);
    },
    COMPILE_TIMEOUT,
  );

  it(
    'hoists and names nested objects like hand-written code',
    () => {
      const type = infer(ORDER_1, ORDER_2);
      const { ts: code } = verifyAllFormats(
        [{ name: 'GetOrderResponse', type, description: 'Response of GET /orders/{orderId}.' }],
        [{ name: 'GetOrderResponse', samples: [ORDER_1, ORDER_2] }],
      );
      expect(code).toBe(
        [
          '/** Response of GET /orders/{orderId}. */',
          'export interface GetOrderResponse {',
          '  order: Order;',
          '}',
          '',
          'export interface Order {',
          '  id: number;',
          '  status: string; // e.g. "paid", "pending"',
          '  createdAt: string; // date-time, e.g. "2024-05-01T10:00:00Z", "2024-05-02T10:00:00.250+02:00"',
          '  ref: string; // uuid',
          '  items: OrderItem[];',
          '  billingAddress: Address;',
          '  shippingAddress: Address;',
          '  customer: Customer;',
          '  note: string | null; // e.g. "Leave at the door"',
          '  tags: string[]; // e.g. "gift"',
          '  meta: Record<string, unknown>;',
          '}',
          '',
          'export interface OrderItem {',
          '  sku: string; // e.g. "A1", "B2"',
          '  qty: number;',
          '  price: number;',
          '  product: Product;',
          '  discount?: number;',
          '}',
          '',
          'export interface Product {',
          '  id: number;',
          '  name: string; // e.g. "Pen", "Ink"',
          '}',
          '',
          'export interface Address {',
          '  line1: string; // e.g. "1 Main St", "3 High St"',
          '  city: string; // e.g. "Springfield", "Ogdenville"',
          '}',
          '',
          'export interface Customer {',
          '  id: number;',
          '  email: string; // email',
          '}',
          '',
        ].join('\n'),
      );
    },
    COMPILE_TIMEOUT,
  );

  it(
    'names paginated list responses after their parent for generic keys',
    () => {
      const type = infer(USERS_PAGE_1, USERS_PAGE_2);
      const { ts: code } = verifyAllFormats([{ name: 'ListUsersResponse', type }], [{ name: 'ListUsersResponse', samples: [USERS_PAGE_1, USERS_PAGE_2] }]);
      expect(code).toContain(
        [
          'export interface ListUsersResponse {',
          '  data: ListUsersResponseData[];',
          '  meta: ListUsersResponseMeta;',
          '  links: ListUsersResponseLinks;',
          '}',
        ].join('\n'),
      );
      expect(code).toContain('  avatarUrl?: string; // uri\n');
      expect(code).toContain('  lastLoginAt: string | null; // date-time, e.g. "2024-05-01T08:00:00Z", "2024-04-30T23:59:59Z"\n');
      expect(code).toContain('  deletedAt?: string; // date, e.g. "2024-05-03"\n');
      expect(code).toContain('  nextCursor: string | null; // base64\n');
      expect(code).toContain('  prev: string | null; // uri\n');
    },
    COMPILE_TIMEOUT,
  );

  it(
    'emits arrays of arrays, mixed arrays, empty arrays and nullable items',
    () => {
      const sample = JSON.stringify({
        matrix: [[1, 2], [3, 4.5]],
        grid: [[{ x: 1 }], [{ x: 2, y: 3 }], []],
        mixed: [1, 'a', null, { k: true }, [1]],
        empty: [],
        maybeOrders: [{ id: 1 }, null],
        nested: [[[['deep']]]],
      });
      const { ts: code } = verifyAllFormats([{ name: 'Shapes', type: infer(sample) }], [{ name: 'Shapes', samples: [sample] }]);
      expect(code).toContain('  matrix: number[][];\n');
      expect(code).toContain('  grid: Grid[][];\n');
      expect(code).toContain('  mixed: (string | number | Mixed | number[] | null)[]; // e.g. "a"\n');
      expect(code).toContain('  empty: unknown[];\n');
      expect(code).toContain('  maybeOrders: (MaybeOrder | null)[];\n');
      expect(code).toContain('  nested: string[][][][]; // e.g. "deep"\n');
      expect(code).toContain('export interface Grid {\n  x: number;\n  y?: number;\n}');
    },
    COMPILE_TIMEOUT,
  );

  it(
    'quotes keys that are not identifiers and handles __proto__ and reserved words safely',
    () => {
      const sample = `{"x-trace": "t", "123": 1, "with space": 2, "valid_id": 3, "$dollar": 4, "": 5, "café": 6, "line${'\\u2028'}sep": 7, "__proto__": {"polluted": true}, "constructor": 8, "new": 9, "default": 10, "class": 11, "get": 12, "toString": 13}`;
      const out = verifyAllFormats([{ name: 'Weird', type: infer(sample) }], [{ name: 'Weird', samples: [sample] }]);
      expect(out.ts).toContain('  "x-trace": string; // e.g. "t"\n');
      expect(out.ts).toContain('  "123": number;\n');
      expect(out.ts).toContain('  "with space": number;\n');
      expect(out.ts).toContain('  valid_id: number;\n  $dollar: number;\n  "": number;\n  "café": number;\n');
      expect(out.ts).toContain('  "line\\u2028sep": number;\n');
      expect(out.ts).toContain('  __proto__: Proto;\n  constructor: number;\n  new: number;\n');
      expect(out.ts).toContain('export interface Proto {\n  polluted: boolean;\n}');
      expect(out.zod).toContain('  ["__proto__"]: ProtoSchema,\n');
      // Parsing a document with a "__proto__" key never touches Object.prototype.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const schema = JSON.parse(out.schema) as { $defs: { Weird: { properties: object; required: string[] } } };
      expect(Object.keys(schema.$defs.Weird.properties)).toContain('__proto__');
      expect(schema.$defs.Weird.required).toContain('__proto__');
    },
    COMPILE_TIMEOUT,
  );

  it('never lets example values or descriptions escape their comments', () => {
    const sample = JSON.stringify({ a: `x\nexport const pwned = 1;`, b: `y${LINE_SEPARATOR}export const pwned2 = 2;`, c: '*/ export const pwned3 = 3; /*' });
    const types: NamedType[] = [{ name: 'Root', type: infer(sample), description: `Doc */ export const pwned4 = 4; /*\nsecond line${LINE_SEPARATOR}third` }];
    for (const format of ['typescript', 'zod'] as const) {
      const code = emitTypes(types, format);
      expect(code).not.toContain(LINE_SEPARATOR);
      // With comments stripped, nothing of the injected text may remain.
      const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, removeComments: true } }).outputText;
      expect(js).not.toContain('pwned');
      expect(typeErrors({ 'inject.ts': code })).toEqual([]);
    }
    expect(emitTypes(types, 'typescript')).toContain('/**\n * Doc *\\/ export const pwned4 = 4; /*\n * second line\n * third\n */\n');
  }, COMPILE_TIMEOUT);

  it(
    'resolves name collisions deterministically and avoids global names',
    () => {
      const sample = JSON.stringify({
        customer: { id: 1 },
        invoice: { customer: { name: 'x' }, items: [{ sku: 'a' }] },
        cart: { items: [{ qty: 1 }] },
        event: { at: 'x' },
        date: { y: 2024 },
        '2fa': { enabled: true },
        名前: { a: 1 },
        a: { a: { a: { b: 1 } } },
        error: { code: 'E1' },
      });
      const { ts: code } = verifyAllFormats([{ name: 'Root', type: infer(sample) }], [{ name: 'Root', samples: [sample] }]);
      const declared = [...code.matchAll(/^export interface (\w+)/gm)].map((m) => m[1]);
      expect(declared).toEqual([
        'Root', 'Customer', 'Invoice', 'InvoiceCustomer', 'InvoiceItem', 'Cart', 'CartItem', 'RootEvent', 'RootDate',
        'Root2fa', 'RootValue', 'A', 'A2', 'A3', 'RootError',
      ]);
      expect(emitTypes([{ name: 'Root', type: infer(sample) }], 'typescript')).toBe(code);
    },
    COMPILE_TIMEOUT,
  );

  it('numbers keys nested in themselves instead of stuttering (trees, wrappers)', () => {
    const categories = JSON.stringify({
      categories: [{ id: 1, children: [{ id: 2, children: [{ id: 3, children: [{ id: 4, leaf: true }] }] }] }],
    });
    const code = emitTypes([{ name: 'Root', type: infer(categories) }], 'typescript');
    expect([...code.matchAll(/^export interface (\w+)/gm)].map((m) => m[1])).toEqual([
      'Root', 'Category', 'CategoryChild', 'CategoryChild2', 'CategoryChild3',
    ]);
    const deep = `${'{"level": '.repeat(4)}1${'}'.repeat(4)}`;
    expect([...emitTypes([{ name: 'Root', type: infer(deep) }], 'typescript').matchAll(/^export interface (\w+)/gm)].map((m) => m[1])).toEqual([
      'Root', 'Level', 'Level2', 'Level3',
    ]);
  });

  it(
    'types objects keyed by ids as dictionaries',
    () => {
      const a = JSON.stringify({
        usersById: { '101': { name: 'Ann', email: 'ann@example.com' }, '102': { name: 'Bob', email: 'bob@example.com', admin: true } },
        visitsByDay: { '2024-05-01': 3, '2024-05-02': 12345678901234567890 },
        sessions: { '3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60': { active: true } },
        rates: { USD: 1, EUR: 0.9 },
        matrix: { '0': { '0': 1, '1': 2 }, '1': { '0': 3 } },
      });
      const b = JSON.stringify({
        usersById: { '103': { name: 'Cid', email: 'cid@example.com' } },
        visitsByDay: {},
        sessions: {},
        rates: { USD: 1, EUR: 0.95 },
        matrix: {},
      });
      const out = verifyAllFormats([{ name: 'Stats', type: infer(a, b) }], [{ name: 'Stats', samples: [a, b] }]);
      expect(out.ts).toContain(
        [
          'export interface Stats {',
          '  usersById: Record<string, User>;',
          '  visitsByDay: Record<string, number>; // precision: exceeds 2^53',
          '  sessions: Record<string, Session>;',
          '  rates: Rates;',
          '  matrix: Record<string, Record<string, number>>;',
          '}',
          '',
          'export interface User {',
          '  name: string; // e.g. "Ann", "Bob", "Cid"',
          '  email: string; // email',
          '  admin?: boolean;',
          '}',
        ].join('\n'),
      );
      expect(out.ts).toContain('export interface Rates {\n  USD: number;\n  EUR: number;\n}');
      expect(out.zod).toContain('  usersById: z.record(z.string(), UserSchema),\n');
      expect(JSON.parse(out.schema).$defs.Stats.properties.visitsByDay).toEqual({
        type: 'object',
        additionalProperties: { type: 'integer', $comment: 'precision: exceeds 2^53' },
      });
      const doc = JSON.parse(out.schema) as Schema;
      expect(validate(doc, { ...JSON.parse(a), usersById: { '1': { name: 3 } } }, doc)).toEqual([
        '$.usersById.1.name: expected string',
        '$.usersById.1: missing email',
      ]);
      expect(emitTypes([{ name: 'ById', type: infer('{"1": {"a": 1}, "2": {"a": 2}}') }], 'typescript')).toBe(
        'export type ById = Record<string, ByIdValue>;\n\nexport interface ByIdValue {\n  a: number;\n}\n',
      );
    },
    COMPILE_TIMEOUT,
  );

  it('dedupes identical shapes under the common trailing words of their keys', () => {
    const sample = JSON.stringify({
      billingAddress: { street: 's', zip: '1' },
      shippingAddress: { street: 't', zip: '2' },
      homeAddress: { zip: '3', street: 'u' },
      from: { lat: 1.5, lng: 2.5 },
      to: { lat: 3.5, lng: 4.5 },
    });
    const code = emitTypes([{ name: 'Root', type: infer(sample) }], 'typescript');
    expect([...code.matchAll(/^export interface (\w+)/gm)].map((m) => m[1])).toEqual(['Root', 'Address', 'From']);
    expect(code).toContain('  billingAddress: Address;\n  shippingAddress: Address;\n  homeAddress: Address;\n  from: From;\n  to: From;\n');
  });

  it(
    'turns a root whose shape is already declared into an alias',
    () => {
      const body = '{"name": "Ann", "email": "ann@example.com"}';
      const types: NamedType[] = [
        { name: 'UpdateUserRequestBody', type: infer(body) },
        { name: 'UpdateUserResponse', type: infer(body) },
      ];
      const out = verifyAllFormats(types, [
        { name: 'UpdateUserRequestBody', samples: [body] },
        { name: 'UpdateUserResponse', samples: [body] },
      ]);
      expect(out.ts).toContain('export type UpdateUserResponse = UpdateUserRequestBody;');
      expect(out.zod).toContain('export const UpdateUserResponseSchema = UpdateUserRequestBodySchema;\nexport type UpdateUserResponse = z.infer<typeof UpdateUserResponseSchema>;');
      expect(JSON.parse(out.schema).$defs.UpdateUserResponse).toEqual({ $ref: '#/$defs/UpdateUserRequestBody' });
    },
    COMPILE_TIMEOUT,
  );

  it(
    'emits non-object roots as type aliases with hoisted items',
    () => {
      const list = '[{"id": 1, "name": "a"}, {"id": 2, "name": "b", "archived": true}]';
      const out = verifyAllFormats(
        [
          { name: 'ListOrdersResponse', type: infer(list) },
          { name: 'Count', type: infer('12345678901234567890') },
          { name: 'Nothing', type: infer('null') },
          { name: 'Anything', type: inferFromSamples([]) },
          { name: 'Ids', type: infer('["3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60"]') },
          { name: 'Empty', type: infer('{}') },
        ],
        [
          { name: 'ListOrdersResponse', samples: [list] },
          { name: 'Count', samples: ['12345678901234567890'] },
          { name: 'Nothing', samples: ['null'] },
          { name: 'Anything', samples: ['{"x": [1]}'] },
          { name: 'Ids', samples: ['["3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60"]'] },
          { name: 'Empty', samples: ['{"x": 1}'] },
        ],
      );
      expect(out.ts).toContain('export type ListOrdersResponse = ListOrdersResponseItem[];\n\nexport interface ListOrdersResponseItem {\n  id: number;\n  name: string; // e.g. "a", "b"\n  archived?: boolean;\n}');
      expect(out.ts).toContain('export type Count = number; // precision: exceeds 2^53\n');
      expect(out.ts).toContain('export type Nothing = null; // only null observed\n');
      expect(out.ts).toContain('export type Anything = unknown;\n');
      expect(out.ts).toContain('export type Ids = string[]; // uuid\n');
      expect(out.ts).toContain('export type Empty = Record<string, unknown>;\n');
      expect(out.zod).toContain('export const CountSchema = z.number(); // precision: exceeds 2^53\n');
      expect(out.zod).toContain('export const IdsSchema = z.array(z.string().uuid());\n');
      expect(out.zod).toContain('export const EmptySchema = z.record(z.string(), z.unknown());\n');
      const schema = JSON.parse(out.schema);
      expect(schema.anyOf).toHaveLength(6);
      expect(schema.$defs.Anything).toEqual({});
      expect(schema.$defs.Count).toEqual({ type: 'integer', $comment: 'precision: exceeds 2^53' });
    },
    COMPILE_TIMEOUT,
  );

  it(
    'inlines everything with hoist: false',
    () => {
      const type = infer(ORDER_1, ORDER_2);
      const out = verifyAllFormats([{ name: 'GetOrderResponse', type }], [{ name: 'GetOrderResponse', samples: [ORDER_1, ORDER_2] }], { hoist: false });
      expect(out.ts.match(/^export /gm)).toHaveLength(1);
      expect(out.ts).toContain('    items: {\n      sku: string; // e.g. "A1", "B2"\n');
      expect(out.ts).toContain('      discount?: number;\n    }[];\n');
      expect(out.zod.match(/^export const /gm)).toHaveLength(1);
      expect(Object.keys(JSON.parse(out.schema).$defs)).toEqual(['GetOrderResponse']);
    },
    COMPILE_TIMEOUT,
  );

  it('drops every comment and JSON Schema annotation with annotate: false', () => {
    const types: NamedType[] = [{ name: 'GetOrderResponse', type: infer(ORDER_1, ORDER_2), description: 'Kept.' }];
    const code = emitTypes(types, 'typescript', { annotate: false });
    expect(code).not.toContain('//');
    expect(code).toContain('/** Kept. */');
    expect(emitTypes(types, 'zod', { annotate: false })).not.toContain('//');
    expect(emitTypes(types, 'zod', { annotate: false })).toContain('createdAt: z.string().datetime({ offset: true }),');
    const schema = emitTypes(types, 'json-schema', { annotate: false });
    expect(schema).not.toMatch(/"(format|examples|\$comment)"/);
  });

  it('sanitizes and dedupes root names', () => {
    const t = infer('{"a": 1}');
    const code = emitTypes(
      [
        { name: 'get user orders', type: t },
        { name: 'GetUserOrders', type: infer('{"b": 1}') },
        { name: '123', type: infer('{"c": 1}') },
        { name: '', type: infer('{"d": 1}') },
      ],
      'typescript',
    );
    expect([...code.matchAll(/^export interface (\w+)/gm)].map((m) => m[1])).toEqual(['GetUserOrders', 'GetUserOrders2', 'T123', 'Type4']);
  });

  it('emits nothing for no types (and an empty schema document)', () => {
    expect(emitTypes([], 'typescript')).toBe('');
    expect(emitTypes([], 'zod')).toBe('');
    expect(JSON.parse(emitTypes([], 'json-schema'))).toEqual({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: {} });
  });

  it('is deterministic', () => {
    const types: NamedType[] = [{ name: 'R', type: infer(ORDER_1, ORDER_2, USERS_PAGE_1) }];
    for (const format of ['typescript', 'zod', 'json-schema'] as const) {
      expect(emitTypes(types, format)).toBe(emitTypes(structuredClone(types), format));
    }
  });
});

describe('emitTypes: Zod', () => {
  it('declares hoisted schemas before use, maps formats, integers and nullability', () => {
    const code = emitTypes([{ name: 'GetOrderResponse', type: infer(ORDER_1, ORDER_2) }], 'zod');
    const order = (name: string): number => code.indexOf(`export const ${name}Schema =`);
    expect(code.startsWith("import { z } from 'zod';\n\n")).toBe(true);
    expect(order('Product')).toBeLessThan(order('OrderItem'));
    expect(order('OrderItem')).toBeLessThan(order('Order'));
    expect(order('Address')).toBeLessThan(order('Order'));
    expect(order('Order')).toBeLessThan(order('GetOrderResponse'));
    expect(code).toContain('  id: z.number().int(),\n');
    expect(code).toContain('  createdAt: z.string().datetime({ offset: true }), // e.g. "2024-05-01T10:00:00Z", "2024-05-02T10:00:00.250+02:00"\n');
    expect(code).toContain('  ref: z.string().uuid(),\n');
    expect(code).toContain('  email: z.string().email(),\n');
    expect(code).toContain('  note: z.string().nullable(), // e.g. "Leave at the door"\n');
    expect(code).toContain('  discount: z.number().optional(),\n');
    expect(code).toContain('  meta: z.record(z.string(), z.unknown()),\n');
    expect(code).toContain('export type Order = z.infer<typeof OrderSchema>;\n');
  });

  it('rejects data that does not match (the schemas are not trivially permissive)', () => {
    const code = emitTypes([{ name: 'GetOrderResponse', type: infer(ORDER_1, ORDER_2) }], 'zod');
    const order = JSON.parse(ORDER_1) as { order: Record<string, unknown> };
    const bad = [
      { order: { ...order.order, id: 1.5 } },
      { order: { ...order.order, createdAt: 'yesterday' } },
      { order: { ...order.order, ref: 'not-a-uuid' } },
      { order: { ...order.order, status: undefined } },
      { order: { ...order.order, note: 3 } },
    ];
    for (const value of bad) for (const [label, ok] of zodParses(code, 'GetOrderResponse', value)) expect(ok, label).toBe(false);
  });

  it('keeps unsafe integers out of .int() (Zod 4 limits .int() to safe integers)', () => {
    const sample = '{"id": 12345678901234567890, "ids": [9007199254740993]}';
    const code = emitTypes([{ name: 'Big', type: infer(sample) }], 'zod');
    expect(code).toContain('  id: z.number(), // precision: exceeds 2^53\n');
    expect(code).toContain('  ids: z.array(z.number()), // precision: exceeds 2^53\n');
    expectZodAccepts(code, 'Big', JSON.parse(sample));
  });

  it('comments the formats Zod has no shared validator for', () => {
    const sample = '{"day": "2024-05-01", "at": "10:00:00Z", "ip": "10.0.0.1", "blob": "aGVsbG8gd29ybGQ=", "site": "https://example.com"}';
    const code = emitTypes([{ name: 'F', type: infer(sample) }], 'zod');
    expect(code).toContain('  day: z.string(), // date, e.g. "2024-05-01"\n');
    expect(code).toContain('  at: z.string(), // time, e.g. "10:00:00Z"\n');
    expect(code).toContain('  ip: z.string(), // ipv4\n');
    expect(code).toContain('  blob: z.string(), // base64\n');
    expect(code).toContain('  site: z.string().url(),\n');
    expectZodAccepts(code, 'F', JSON.parse(sample));
  });

  it('emits unions with z.union and .nullable()', () => {
    const code = emitTypes([{ name: 'U', type: infer('{"v": 1}', '{"v": "a"}', '{"v": null}', '{"v": [true]}') }], 'zod');
    expect(code).toContain('  v: z.union([z.string(), z.number().int(), z.array(z.boolean())]).nullable(), // e.g. "a"\n');
    for (const v of [1, 'a', null, [true]]) expectZodAccepts(code, 'U', { v });
  });
});

describe('emitTypes: JSON Schema', () => {
  it('emits $defs, required, formats and examples', () => {
    const schema = JSON.parse(emitTypes([{ name: 'GetOrderResponse', type: infer(ORDER_1, ORDER_2) }], 'json-schema'));
    expect(schema.$ref).toBe('#/$defs/GetOrderResponse');
    expect(Object.keys(schema.$defs)).toEqual(['GetOrderResponse', 'Order', 'OrderItem', 'Product', 'Address', 'Customer']);
    expect(schema.$defs.OrderItem.required).toEqual(['sku', 'qty', 'price', 'product']);
    expect(schema.$defs.Order.properties.createdAt).toEqual({
      type: 'string',
      format: 'date-time',
      examples: ['2024-05-01T10:00:00Z', '2024-05-02T10:00:00.250+02:00'],
    });
    expect(schema.$defs.Order.properties.note).toEqual({ type: ['string', 'null'], examples: ['Leave at the door'] });
    expect(schema.$defs.Order.properties.items).toEqual({ type: 'array', items: { $ref: '#/$defs/OrderItem' } });
    expect(schema.$defs.Order.properties.tags).toEqual({ type: 'array', items: { type: 'string', examples: ['gift'] } });
    expect(schema.$defs.Order.properties.customer).toEqual({ $ref: '#/$defs/Customer' });
    expect(schema.$defs.Customer.properties.email).toEqual({ type: 'string', format: 'email' });
  });

  it('rejects data that does not match', () => {
    const doc = JSON.parse(emitTypes([{ name: 'GetOrderResponse', type: infer(ORDER_1, ORDER_2) }], 'json-schema')) as Schema;
    const order = (JSON.parse(ORDER_1) as { order: Record<string, unknown> }).order;
    const { status: _status, ...withoutStatus } = order;
    expect(validate(doc, { order: withoutStatus }, doc)).toEqual(['$.order: missing status']);
    expect(validate(doc, { order: { ...order, id: 1.5 } }, doc)).toEqual(['$.order.id: expected integer']);
    expect(validate(doc, { order: { ...order, ref: 'x' } }, doc)).toEqual(['$.order.ref: not a uuid']);
  });

  it('uses anyOf for unions with objects or arrays', () => {
    const schema = JSON.parse(emitTypes([{ name: 'U', type: infer('{"v": {"a": 1}}', '{"v": [1]}', '{"v": null}') }], 'json-schema'));
    expect(schema.$defs.U.properties.v).toEqual({ anyOf: [{ $ref: '#/$defs/V' }, { type: 'array', items: { type: 'integer' } }, { type: 'null' }] });
  });
});

describe('big and deep payloads', () => {
  it(
    'types 50 levels of nesting (hoisted and inline)',
    () => {
      const depth = 50;
      const sample = `${'{"level": '.repeat(depth)}{"leaf": true, "at": "2024-05-01"}${'}'.repeat(depth)}`;
      const type = infer(sample);
      const hoisted = verifyAllFormats([{ name: 'Deep', type }], [{ name: 'Deep', samples: [sample] }]);
      expect(hoisted.ts.match(/^export interface /gm)).toHaveLength(depth + 1);
      const inline = verifyAllFormats([{ name: 'Deep', type }], [{ name: 'Deep', samples: [sample] }], { hoist: false });
      expect(inline.ts).toContain(`${'  '.repeat(depth + 1)}leaf: boolean;\n`);
    },
    COMPILE_TIMEOUT,
  );

  it('types values nested deeper than 100 levels as unknown', () => {
    const sample = `${'['.repeat(150)}1${']'.repeat(150)}`;
    const code = emitTypes([{ name: 'TooDeep', type: infer(sample) }], 'typescript');
    expect(code).toBe(`export type TooDeep = unknown${'[]'.repeat(100)};\n`);
    expect(typeErrors({ 'deep.ts': code, 'deep.check.ts': `import type { TooDeep } from './deep';\nexport const x: TooDeep = ${sample};\n` })).toEqual([]);
  }, COMPILE_TIMEOUT);

  it('handles 5k-item arrays with sparse optional fields in < 300 ms', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      createdAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
      score: i % 3 === 0 ? i + 0.5 : i,
      tags: i % 5 === 0 ? [] : ['a', 'b'],
      address: { city: 'Springfield', zip: String(10_000 + i), geo: { lat: 1.5, lng: -2.5 } },
      manager: i % 11 === 0 ? null : { id: i + 1, name: 'M' },
      ...(i % 7 === 0 ? { nickname: `n${i}` } : {}),
      ...(i === 4321 ? { flags: { beta: true } } : {}),
    }));
    const text = JSON.stringify({ data: items, total: 5000, nextPage: null });
    const root = tree(text);
    const spec = endpoint({ responses: [response(200, { ...jsonBody([]), samples: [root] })] });

    const started = performance.now();
    const type = inferType(root);
    const outputs = (['typescript', 'zod', 'json-schema'] as const).map((format) => emitTypes([{ name: 'ListUsersResponse', type }], format));
    const generated = generateEndpointTypes(spec, { format: 'typescript', baseName: 'ListUsers' });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(300);
    expect(outputs[0]).toContain('  nickname?: string; // e.g. "n0", "n7", "n14"\n');
    expect(outputs[0]).toContain('  flags?: Flags;\n');
    expect(outputs[0]).toContain('  manager: Manager | null;\n');
    expect(outputs[0]).toContain('  score: number;\n');
    expect(outputs[0]).toContain('  uuid: string; // uuid\n');
    expect(generated.code).toBe(outputs[0].replace('export interface ListUsersResponse {', '/** Response body of GET /orders (200). */\nexport interface ListUsersResponse {'));
    const value: unknown = JSON.parse(text);
    expectZodAccepts(outputs[1], 'ListUsersResponse', value);
    const doc = JSON.parse(outputs[2]) as Schema;
    expect(validate(doc, value, doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// generateEndpointTypes
// ---------------------------------------------------------------------------------------------

describe('generateEndpointTypes', () => {
  const restSpec = (): EndpointSpec =>
    endpoint({
      method: 'GET',
      url: 'https://api.example.com/api/users/42/orders?page=1&status=paid&status=open',
      pathTemplate: '/api/users/{userId}/orders/{orderRef}',
      pathParams: [
        { name: 'userId', example: '42', kind: 'integer', index: 2 },
        { name: 'orderRef', example: '3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60', kind: 'uuid', index: 4 },
      ],
      query: [
        { name: 'page', examples: ['1', '2'], repeated: false, required: false, redacted: false },
        { name: 'status', examples: ['paid', 'open'], repeated: true, required: true, redacted: false },
        { name: 'access_token', examples: [REDACTED], repeated: false, required: true, redacted: true },
        { name: 'since', examples: ['2024-05-01'], repeated: false, required: false, redacted: false },
      ],
      responses: [
        response(200, jsonBody([ORDER_1, ORDER_2])),
        response(206, jsonBody([ORDER_2])),
        response(404, jsonBody(['{"error": {"code": "not_found", "message": "No such order"}}'])),
        response(500, jsonBody(['{"error": {"code": "internal", "message": "Oops", "traceId": "abc"}}'])),
      ],
    });

  it(
    'types path params, query, merged 2xx responses and merged 4xx/5xx errors',
    () => {
      const result = generateEndpointTypes(restSpec(), { format: 'typescript', baseName: 'GetUserOrder' });
      expect(result.names).toEqual({
        pathParams: 'GetUserOrderPathParams',
        query: 'GetUserOrderQuery',
        response: 'GetUserOrderResponse',
        errorResponse: 'GetUserOrderErrorResponse',
      });
      expect(result.notes).toEqual([]);
      expect(result.code).toContain(
        [
          '/** Path parameters of GET /api/users/{userId}/orders/{orderRef}. */',
          'export interface GetUserOrderPathParams {',
          '  userId: string; // e.g. "42"',
          '  orderRef: string; // uuid',
          '}',
          '',
          '/** Query parameters of GET /api/users/{userId}/orders/{orderRef}. */',
          'export interface GetUserOrderQuery {',
          '  page?: string; // e.g. "1", "2"',
          '  status: string[]; // e.g. "paid", "open"',
          '  access_token: string;',
          '  since?: string; // date, e.g. "2024-05-01"',
          '}',
          '',
          '/** Response body of GET /api/users/{userId}/orders/{orderRef} (200, 206). */',
          'export interface GetUserOrderResponse {',
          '  order: Order;',
          '}',
        ].join('\n'),
      );
      expect(result.code).toContain(
        [
          '/** Error response body of GET /api/users/{userId}/orders/{orderRef} (404, 500). */',
          'export interface GetUserOrderErrorResponse {',
          '  error: GetUserOrderErrorResponseError;',
          '}',
          '',
          'export interface GetUserOrderErrorResponseError {',
          '  code: string; // e.g. "not_found", "internal"',
          '  message: string; // e.g. "No such order", "Oops"',
          '  traceId?: string; // e.g. "abc"',
          '}',
        ].join('\n'),
      );
      const zod = generateEndpointTypes(restSpec(), { format: 'zod', baseName: 'GetUserOrder' });
      expectZodAccepts(zod.code, 'GetUserOrderQuery', { status: ['paid'], access_token: 'x' });
      expectZodAccepts(zod.code, 'GetUserOrderErrorResponse', { error: { code: 'x', message: 'y' } });
      expect(typeErrors({ 'e.ts': result.code, 'z.ts': zod.code })).toEqual([]);
    },
    COMPILE_TIMEOUT,
  );

  it('defaults the base name to suggestBaseName(spec) and sanitizes a user-edited one', () => {
    const spec = restSpec();
    expect(generateEndpointTypes(spec, { format: 'typescript' }).names.response).toBe(`${suggestBaseName(spec)}Response`);
    expect(generateEndpointTypes(spec, { format: 'typescript', baseName: '   ' }).names.response).toBe(`${suggestBaseName(spec)}Response`);
    expect(generateEndpointTypes(spec, { format: 'typescript', baseName: 'my orders-list' }).names.response).toBe('MyOrdersListResponse');
    expect(generateEndpointTypes(spec, { format: 'typescript', baseName: '2fa' }).names.response).toBe('T2faResponse');
  });

  it('types a JSON request body and reports a single sample, precision and truncation', () => {
    const spec = endpoint({
      method: 'POST',
      pathTemplate: '/orders',
      requestBody: jsonBody(['{"customerId": 12345678901234567890, "items": [{"sku": "A1", "qty": 2}], "coupon": null}']),
      responses: [response(201, jsonBody(['{"id": 9007199254740993, "status": "created"}'], { truncated: true }))],
    });
    const result = generateEndpointTypes(spec, { format: 'typescript', baseName: 'CreateOrder' });
    expect(result.names).toEqual({ requestBody: 'CreateOrderRequestBody', response: 'CreateOrderResponse' });
    expect(result.code).toContain(
      'export interface CreateOrderRequestBody {\n  customerId: number; // precision: exceeds 2^53\n  items: CreateOrderRequestBodyItem[];\n  coupon: null; // only null observed\n}',
    );
    expect(generateEndpointTypes(spec, { format: 'zod', baseName: 'CreateOrder' }).code).toContain('  coupon: z.null(), // only null observed\n');
    expect(JSON.parse(generateEndpointTypes(spec, { format: 'json-schema', baseName: 'CreateOrder' }).code).$defs.CreateOrderRequestBody.properties.coupon).toEqual({
      type: 'null',
      $comment: 'only null observed',
    });
    expect(result.notes).toEqual([
      'Integers beyond 2^53 (CreateOrderRequestBody.customerId, CreateOrderResponse.id) lose precision with JSON.parse: read them as strings or BigInt.',
      'A response sample was truncated; CreateOrderResponse may be incomplete.',
      "Only one response sample: optional fields can't be detected; send more test requests to refine.",
    ]);
  });

  it(
    'types form and multipart fields (text -> string, file -> Blob)',
    () => {
      const fields: BodySpec['fields'] = [
        { name: 'email', kind: 'text', example: 'ann@example.com', repeated: false, required: true },
        { name: 'tags', kind: 'text', example: 'a', repeated: true, required: false },
        { name: 'avatar', kind: 'file', repeated: false, required: true },
        { name: 'photos', kind: 'file', repeated: true, required: false },
        { name: 'password', kind: 'text', example: REDACTED, repeated: false, required: true },
      ];
      const spec = endpoint({
        method: 'POST',
        pathTemplate: '/profile',
        requestBody: { contentType: 'multipart/form-data; boundary=x', kind: 'multipart', samples: [], fields, truncated: false },
      });
      const out = Object.fromEntries(
        (['typescript', 'zod', 'json-schema'] as const).map((format) => [format, generateEndpointTypes(spec, { format, baseName: 'UpdateProfile' })]),
      );
      expect(out.typescript.names).toEqual({ requestBody: 'UpdateProfileRequestBody' });
      expect(out.typescript.notes).toEqual([]);
      expect(out.typescript.code).toContain(
        'export interface UpdateProfileRequestBody {\n  email: string; // email\n  tags?: string[]; // e.g. "a"\n  avatar: Blob;\n  photos?: Blob[];\n  password: string;\n}',
      );
      expect(out.zod.code).toContain('  avatar: z.instanceof(Blob),\n  photos: z.array(z.instanceof(Blob)).optional(),\n');
      expect(JSON.parse(out['json-schema'].code).$defs.UpdateProfileRequestBody.properties.avatar).toEqual({ type: 'string', contentEncoding: 'binary' });
      expect(
        typeErrors({
          'f.ts': out.typescript.code,
          'f.check.ts': "import type { UpdateProfileRequestBody } from './f';\nexport const x: UpdateProfileRequestBody = { email: 'a@b.co', avatar: new Blob([]), password: 'p' };\n",
          'z.ts': out.zod.code,
        }),
      ).toEqual([]);
      expectZodAccepts(out.zod.code, 'UpdateProfileRequestBody', { email: 'a@b.co', avatar: new Blob(['x']), photos: [new Blob([])], password: 'p' });
      for (const [, ok] of zodParses(out.zod.code, 'UpdateProfileRequestBody', { email: 'a@b.co', avatar: 'x', password: 'p' })) expect(ok).toBe(false);

      const form = generateEndpointTypes(
        { ...spec, requestBody: { contentType: 'application/x-www-form-urlencoded', kind: 'form', samples: [], fields: fields.slice(0, 2), truncated: false } },
        { format: 'typescript', baseName: 'Login' },
      );
      expect(form.code).toContain('export interface LoginRequestBody {\n  email: string; // email\n  tags?: string[]; // e.g. "a"\n}');
    },
    COMPILE_TIMEOUT,
  );

  it(
    'types GraphQL Variables and Data (null data skipped, errors typed separately)',
    () => {
      const request = JSON.stringify({
        operationName: 'GetUser',
        query: 'query GetUser($id: ID!, $first: Int) { user(id: $id) { id name posts(first: $first) { edges { node { id title } } pageInfo { hasNextPage endCursor } } } }',
        variables: { id: 'u_1', first: 2 },
      });
      const ok = JSON.stringify({
        data: { user: { id: 'u_1', name: 'Ann', posts: { edges: [{ node: { id: 'p1', title: 'Hi' } }], pageInfo: { hasNextPage: false, endCursor: null } } } },
      });
      const ok2 = JSON.stringify({ data: { user: { id: 'u_2', name: 'Bob', posts: { edges: [], pageInfo: { hasNextPage: true, endCursor: 'YXJyYXljb25uZWN0aW9uOjE=' } } } } });
      const failed = JSON.stringify({ data: null, errors: [{ message: 'Not authorized' }] });
      const spec = endpoint({
        method: 'POST',
        pathTemplate: '/graphql',
        graphql: { operationName: 'GetUser', operationType: 'query', query: 'query GetUser { ... }' },
        requestBody: jsonBody([request], { kind: 'graphql' }),
        responses: [response(200, jsonBody([ok, ok2, failed])), response(400, jsonBody(['{"errors": [{"message": "Syntax Error"}]}']))],
      });
      const result = generateEndpointTypes(spec, { format: 'typescript' });
      expect(result.names).toEqual({ graphqlVariables: 'GetUserVariables', graphqlData: 'GetUserData', errorResponse: 'GetUserErrorResponse' });
      expect(result.notes).toEqual([]);
      expect(result.code).toContain('/** Variables of the GraphQL query GetUser. */\nexport interface GetUserVariables {\n  id: string; // e.g. "u_1"\n  first: number;\n}');
      expect(result.code).toContain('/** The `data` of the GraphQL query GetUser response. */\nexport interface GetUserData {\n  user: User;\n}');
      expect(result.code).toContain('export interface User {\n  id: string; // e.g. "u_1", "u_2"\n  name: string; // e.g. "Ann", "Bob"\n  posts: Posts;\n}');
      expect(result.code).toContain('export interface Posts {\n  edges: PostsEdge[];\n  pageInfo: PageInfo;\n}');
      expect(result.code).toContain('export interface PostsEdge {\n  node: PostsEdgeNode;\n}');
      expect(result.code).toContain('  endCursor: string | null; // base64\n');
      const zod = generateEndpointTypes(spec, { format: 'zod' }).code;
      expectZodAccepts(zod, 'GetUserData', JSON.parse(ok).data);
      expectZodAccepts(zod, 'GetUserVariables', { id: 'x', first: 1 });
      expect(typeErrors({ 'g.ts': result.code, 'z.ts': zod })).toEqual([]);
    },
    COMPILE_TIMEOUT,
  );

  it('follows the base name for GraphQL roles and handles batches and GET variables', () => {
    const batch = JSON.stringify([
      { operationName: 'Other', query: 'query Other { me { id } }', variables: { x: 1 } },
      { operationName: 'Search', query: 'query Search($q: String!) { search(q: $q) { id } }', variables: { q: 'pen' } },
    ]);
    const batchResponse = JSON.stringify([{ data: { me: { id: 'me' } } }, { data: { search: [{ id: 's1' }] } }]);
    const spec = endpoint({
      method: 'POST',
      pathTemplate: '/graphql',
      graphql: { operationName: 'Search', operationType: 'query', query: 'query Search { ... }' },
      requestBody: jsonBody([batch], { kind: 'graphql' }),
      responses: [response(200, jsonBody([batchResponse]))],
    });
    const result = generateEndpointTypes(spec, { format: 'typescript', baseName: 'SearchProducts' });
    expect(result.names).toEqual({ graphqlVariables: 'SearchProductsVariables', graphqlData: 'SearchProductsData' });
    expect(result.code).toContain('export interface SearchProductsVariables {\n  q: string; // e.g. "pen"\n}');
    expect(result.code).toContain('export interface SearchProductsData {\n  search: Search[];\n}');

    const get = endpoint({
      method: 'GET',
      pathTemplate: '/graphql',
      graphql: { operationName: 'Me', operationType: 'query', query: '{ me { id } }' },
      query: [
        { name: 'query', examples: ['{ me { id } }'], repeated: false, required: true, redacted: false },
        { name: 'variables', examples: ['{"locale":"en"}'], repeated: false, required: true, redacted: false },
        { name: 'v', examples: ['3'], repeated: false, required: false, redacted: false },
      ],
      responses: [response(200, jsonBody(['{"data": {"me": {"id": "1"}}}']))],
    });
    const getResult = generateEndpointTypes(get, { format: 'typescript', baseName: 'Me' });
    expect(getResult.names).toEqual({ query: 'MeQuery', graphqlVariables: 'MeVariables', graphqlData: 'MeData' });
    expect(getResult.code).toContain('export interface MeQuery {\n  v?: string; // e.g. "3"\n}');
    expect(getResult.code).toContain('export interface MeVariables {\n  locale: string; // e.g. "en"\n}');
  });

  it('omits empty GraphQL variables', () => {
    const spec = endpoint({
      method: 'POST',
      pathTemplate: '/graphql',
      graphql: { operationName: 'Me', operationType: 'query', query: '{ me { id } }' },
      requestBody: jsonBody(['{"query": "{ me { id } }", "variables": {}}'], { kind: 'graphql' }),
      responses: [response(200, jsonBody(['{"data": {"me": {"id": "1"}}}', '{"data": {"me": {"id": "2"}}}']))],
    });
    expect(generateEndpointTypes(spec, { format: 'typescript', baseName: 'Me' }).names).toEqual({ graphqlData: 'MeData' });
  });

  it('explains what could not be typed', () => {
    const html = generateEndpointTypes(
      endpoint({ responses: [response(200, { contentType: 'text/html', kind: 'text', samples: [], text: '<html>', truncated: false })] }),
      { format: 'typescript', baseName: 'Page' },
    );
    expect(html.names).toEqual({});
    expect(html.code).toBe('');
    expect(html.notes).toEqual([
      'The 200 response body is not JSON (text/html), so there is no Response type.',
      'Nothing to type: no path or query parameters and no JSON bodies were captured.',
    ]);

    const broken = generateEndpointTypes(
      endpoint({
        method: 'PUT',
        requestBody: { contentType: 'text/plain', kind: 'text', samples: [], text: 'hi', truncated: false },
        responses: [response(200, { contentType: 'application/json', kind: 'json', samples: [], text: '{"a":', truncated: true }), response(204, null)],
      }),
      { format: 'json-schema', baseName: 'Put' },
    );
    expect(broken.notes).toEqual([
      'The request body is not JSON (text/plain), so there is no RequestBody type.',
      'The 200 response body was truncated and is not valid JSON, so there is no Response type.',
      'Nothing to type: no path or query parameters and no JSON bodies were captured.',
    ]);
    expect(JSON.parse(broken.code)).toEqual({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: {} });

    const missing = generateEndpointTypes(
      endpoint({ method: 'POST', requestBody: { contentType: null, kind: 'unavailable', samples: [], truncated: false } }),
      { format: 'typescript', baseName: 'X' },
    );
    expect(missing.notes[0]).toBe('The request body was not captured, so there is no RequestBody type.');
  });

  it('notes redacted JSON values and depth-limited values', () => {
    const deep = `${'{"a": '.repeat(120)}1${'}'.repeat(120)}`;
    const spec = endpoint({
      responses: [
        response(200, jsonBody([`{"token": "${REDACTED}", "user": {"pin": "${REDACTED}"}}`, `{"token": "${REDACTED}", "user": {"pin": "${REDACTED}"}}`])),
        response(500, jsonBody([deep])),
      ],
    });
    const result = generateEndpointTypes(spec, { format: 'typescript', baseName: 'Login' });
    expect(result.notes).toEqual([
      'Redacted values are typed as string: their real type is hidden.',
      'Values nested deeper than 100 levels are typed as unknown.',
    ]);
    expect(result.code).toContain('export interface LoginResponse {\n  token: string;\n  user: User;\n}');
    expect(result.code).toContain('export interface User {\n  pin: string;\n}');
  });

  it('emits the requested format with the same names', () => {
    for (const format of ['typescript', 'zod', 'json-schema'] as const) {
      const result = generateEndpointTypes(restSpec(), { format, baseName: 'GetUserOrder' });
      expect(result.format).toBe(format);
      expect(result.code).toContain('GetUserOrderErrorResponse');
    }
    const schema = JSON.parse(generateEndpointTypes(restSpec(), { format: 'json-schema', baseName: 'GetUserOrder' }).code);
    expect(schema.anyOf.map((r: { $ref: string }) => r.$ref)).toEqual([
      '#/$defs/GetUserOrderPathParams',
      '#/$defs/GetUserOrderQuery',
      '#/$defs/GetUserOrderResponse',
      '#/$defs/GetUserOrderErrorResponse',
    ]);
    expect(schema.$defs.GetUserOrderResponse.description).toBe('Response body of GET /api/users/{userId}/orders/{orderRef} (200, 206).');
  });

  it('honours hoist and annotate', () => {
    const plain = generateEndpointTypes(restSpec(), { format: 'typescript', baseName: 'G', hoist: false, annotate: false });
    expect(plain.code).not.toContain('//');
    expect(plain.code.match(/^export /gm)).toHaveLength(4);
  });
});
