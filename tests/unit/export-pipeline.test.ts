import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JNode, RequestEntry, TestRun } from '../../src/shared/types';
import type { BodySpec, EndpointSpec, ResponseSpec } from '../../src/lib/endpoint';

// The lib pipeline is mocked: these tests cover the Export tab's memoization and helpers, not generation.
const calls = vi.hoisted(() => ({ spec: 0, types: 0, prompt: 0 }));
vi.mock('../../src/lib/endpoint', () => ({
  buildEndpointSpec: vi.fn(({ entry }: { entry: RequestEntry }) => {
    calls.spec++;
    if (entry.url.includes('boom')) throw new Error('cannot parse');
    return makeSpec();
  }),
  suggestBaseName: vi.fn(() => 'get-orders!'),
}));
vi.mock('../../src/lib/typegen', () => ({
  generateEndpointTypes: vi.fn((spec: EndpointSpec, opts: { format: string; baseName?: string }) => {
    calls.types++;
    return {
      format: opts.format,
      code: `// ${opts.baseName} ${spec.pathParams.length}/${spec.query.length}/${spec.requestBody ? 1 : 0}/${spec.responses.map((r) => r.status).join(',')}`,
      names: {},
      notes: ['precision note'],
    };
  }),
}));
vi.mock('../../src/lib/agentPrompt', () => ({
  buildAgentPrompt: vi.fn((_spec: EndpointSpec, opts: { target: string; typesTs: string }) => {
    calls.prompt++;
    return `# ${opts.target}\n${opts.typesTs}`;
  }),
  endpointTitle: vi.fn(() => 'GET /api/orders'),
}));

const pipeline = await import('../../src/ui/export/pipeline');

const node: JNode = { id: 'n', type: 'object', children: [] };

function body(samples: JNode[], kind: BodySpec['kind'] = 'json'): BodySpec {
  return { contentType: 'application/json', kind, samples, truncated: false };
}

function response(status: number, b: BodySpec | null): ResponseSpec {
  return { status, body: b, sources: ['original'], headers: [] };
}

function makeSpec(patch: Partial<EndpointSpec> = {}): EndpointSpec {
  return {
    method: 'GET',
    url: 'https://api.test/api/orders/1?page=2',
    origin: 'https://api.test',
    pathTemplate: '/api/orders/{orderId}',
    pathParams: [{ name: 'orderId', example: '1', kind: 'integer', index: 2 }],
    query: [{ name: 'page', examples: ['2'], repeated: false, required: true, redacted: false }],
    requestHeaders: [],
    auth: [],
    requestBody: null,
    responses: [response(200, body([node])), response(404, body([node]))],
    graphql: null,
    pageOrigin: 'https://app.test',
    capturedAt: 0,
    notes: ['Edited draft used as the request sample'],
    redacted: false,
    ...patch,
  };
}

const entry = (url = 'https://api.test/api/orders/1'): RequestEntry => ({
  id: `h:0:${url}`,
  source: 'hook',
  kind: 'fetch',
  frameId: 0,
  pageUrl: 'https://app.test/',
  method: 'GET',
  url,
  requestHeaders: [],
  requestBody: null,
  requestContentType: null,
  startTime: 0,
  state: 'done',
  status: 200,
  responseBody: { kind: 'text', text: '{"a":1}', size: 7 },
});

beforeEach(() => {
  calls.spec = calls.types = calls.prompt = 0;
});

describe('spec memoization', () => {
  it('builds once per (entry, draft, runs, redact) identity', () => {
    const e = entry();
    const runs: TestRun[] = [];
    expect(pipeline.peekSpec(e, null, runs, true)).toBeUndefined();
    const a = pipeline.specOutcome(e, null, runs, true);
    const b = pipeline.specOutcome(e, null, runs, true);
    expect(a).toBe(b);
    expect(calls.spec).toBe(1);
    expect(pipeline.peekSpec(e, null, runs, true)).toBe(a);
    pipeline.specOutcome(e, null, runs, false);
    pipeline.specOutcome(e, null, [], false);
    expect(calls.spec).toBe(3);
  });

  it('turns failures into outcomes', () => {
    const out = pipeline.specOutcome(entry('https://api.test/boom'), null, [], true);
    expect(out).toEqual({ ok: false, error: 'cannot parse' });
  });
});

describe('types and prompt memoization', () => {
  it('caches per spec and options, and filters excluded roles', () => {
    const spec = makeSpec();
    const opts = { format: 'typescript' as const, baseName: 'GetOrder', annotate: true, exclude: new Set<never>() };
    const a = pipeline.typesOutcome(spec, opts);
    expect(pipeline.typesOutcome(spec, { ...opts, exclude: new Set() })).toBe(a);
    expect(calls.types).toBe(1);
    expect(a.ok && a.value.code).toBe('// GetOrder 1/1/0/200,404');
    const filtered = pipeline.typesOutcome(spec, { ...opts, exclude: new Set(['pathParams', 'errorResponse'] as const) });
    expect(filtered.ok && filtered.value.code).toBe('// GetOrder 0/1/0/200');
    expect(calls.types).toBe(2);
  });

  it('builds the prompt from TypeScript types of every role', () => {
    const spec = makeSpec();
    const p = pipeline.promptOutcome(spec, { target: 'tests', baseName: 'GetOrder', includeExamples: true });
    expect(p).toEqual({ ok: true, value: '# tests\n// GetOrder 1/1/0/200,404' });
    expect(pipeline.promptOutcome(spec, { target: 'tests', baseName: 'GetOrder', includeExamples: true })).toBe(p);
    expect(calls.prompt).toBe(1);
  });
});

describe('helpers', () => {
  it('sanitizes base names into identifiers', () => {
    expect(pipeline.sanitizeTypeName('get-orders!')).toBe('Getorders');
    expect(pipeline.sanitizeTypeName('createOrder')).toBe('CreateOrder');
    expect(pipeline.sanitizeTypeName('2fa')).toBe('_2fa');
    expect(pipeline.sanitizeTypeName('  ')).toBe('');
    expect(pipeline.suggestedName(makeSpec())).toBe('Getorders');
  });

  it('lists the roles present in display order', () => {
    expect(pipeline.rolesPresent(makeSpec())).toEqual(['pathParams', 'query', 'response', 'errorResponse']);
    const post = makeSpec({ pathParams: [], query: [], requestBody: body([node]), responses: [response(201, body([node]))] });
    expect(pipeline.rolesPresent(post)).toEqual(['requestBody', 'response']);
    const form = makeSpec({
      pathParams: [],
      query: [],
      requestBody: { ...body([], 'form'), fields: [{ name: 'a', kind: 'text', repeated: false, required: true }] },
      responses: [response(200, body([], 'text'))],
    });
    expect(pipeline.rolesPresent(form)).toEqual(['requestBody']);
  });

  it('names GraphQL roles Variables / Data', () => {
    expect(pipeline.roleLabel('requestBody', true)).toBe('Variables');
    expect(pipeline.roleLabel('response', true)).toBe('Data');
    expect(pipeline.roleLabel('response', false)).toBe('Response');
  });

  it('explains a missing response type', () => {
    expect(pipeline.responseHint(makeSpec(), { state: 'done' })).toEqual({ kind: 'none' });
    expect(pipeline.responseHint(makeSpec({ responses: [] }), { state: 'pending' })).toEqual({ kind: 'send', pending: true });
    expect(pipeline.responseHint(makeSpec({ responses: [response(200, null)] }), { state: 'done' })).toEqual({ kind: 'send', pending: false });
    expect(pipeline.responseHint(makeSpec({ responses: [response(204, null)] }), { state: 'done' })).toEqual({ kind: 'empty' });
    const html = makeSpec({ responses: [response(200, { ...body([], 'text'), contentType: 'text/html; charset=utf-8' })] });
    expect(pipeline.responseHint(html, { state: 'done' })).toEqual({ kind: 'not-json', contentType: 'text/html; charset=utf-8' });
  });

  it('compiles notes with the single-sample hint, deduplicated', () => {
    const spec = makeSpec();
    const types = { format: 'typescript' as const, code: '', names: {}, notes: ['precision note', 'Edited draft used as the request sample'] };
    expect(pipeline.compileNotes(spec, types, new Set())).toEqual([
      'Edited draft used as the request sample',
      'precision note',
      pipeline.ONE_SAMPLE_NOTE,
    ]);
    expect(pipeline.compileNotes(spec, types, new Set(['response']))).not.toContain(pipeline.ONE_SAMPLE_NOTE);
    const two = makeSpec({ responses: [response(200, body([node, node]))] });
    expect(pipeline.compileNotes(two, null, new Set())).not.toContain(pipeline.ONE_SAMPLE_NOTE);
  });

  it('weighs bodies to decide when to debounce', () => {
    const e = { ...entry(), requestBody: { kind: 'text' as const, text: 'x'.repeat(10), size: 10 } };
    const run = { result: { body: { kind: 'base64', base64: 'AAAA', size: 3 } } } as unknown as TestRun;
    expect(pipeline.exportWeight(e, [run])).toBe(10 + 7 + 4);
    expect(pipeline.bodyWeight({ kind: 'formFields', fields: [{ name: 'ab', value: 'cde' }] })).toBe(5);
    expect(pipeline.bodyWeight({ kind: 'unavailable', reason: 'x' })).toBe(0);
  });

  it('estimates tokens and counts lines', () => {
    expect(pipeline.tokenEstimate('x'.repeat(400))).toBe('~100 tokens');
    expect(pipeline.tokenEstimate('x'.repeat(6000))).toBe('~1.5k tokens');
    expect(pipeline.tokenEstimate('x'.repeat(80_000))).toBe('~20k tokens');
    expect(pipeline.lineCount('')).toBe(1);
    expect(pipeline.lineCount('a\nb\n')).toBe(3);
  });
});
