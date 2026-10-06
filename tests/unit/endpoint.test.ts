import { describe, expect, it } from 'vitest';
import { childByKey } from '../../src/lib/body';
import { applyFullUrl, createDraft, setBody } from '../../src/lib/draft';
import { buildEndpointSpec, detectPathParams, suggestBaseName, type EndpointSpec } from '../../src/lib/endpoint';
import { serializeJsonTree, updateNode } from '../../src/lib/json-tree';
import type { HeaderPair, JNode, ReplayRequest, ReplayResult, RequestEntry, SerializedBody, TestRun } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function text(value: string, extra: { truncated?: boolean } = {}): SerializedBody {
  return { kind: 'text', text: value, size: value.length, ...extra };
}

function jsonBody(value: unknown): SerializedBody {
  return text(JSON.stringify(value));
}

const JSON_HEADERS: HeaderPair[] = [{ name: 'content-type', value: 'application/json; charset=utf-8' }];

function entry(patch: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    frameUrl: 'https://app.example.com/orders',
    pageUrl: 'https://app.example.com/orders',
    method: 'GET',
    url: 'https://api.example.com/v1/items',
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: T0,
    endTime: T0 + 120,
    state: 'done',
    status: 200,
    statusText: 'OK',
    responseHeaders: JSON_HEADERS,
    responseBody: jsonBody({ ok: true }),
    ...patch,
  };
}

let runCounter = 0;
function run(
  base: RequestEntry,
  startedAt: number,
  result: Partial<ReplayResult> & { status: number },
  request: Partial<ReplayRequest> = {},
  state: TestRun['state'] = 'done',
): TestRun {
  const runId = `run-${++runCounter}`;
  const fullRequest: ReplayRequest = {
    runId,
    entryId: base.id,
    mode: 'page',
    frameId: 0,
    method: base.method,
    url: base.url,
    headers: base.requestHeaders,
    body: base.requestBody?.kind === 'text' ? { kind: 'text', text: base.requestBody.text } : { kind: 'none' },
    credentials: 'include',
    redirect: 'follow',
    timeoutMs: 30_000,
    responseBodyCap: 1_000_000,
    ...request,
  };
  const fullResult: ReplayResult = {
    runId,
    ok: true,
    statusText: '',
    headers: JSON_HEADERS,
    body: null,
    url: fullRequest.url,
    redirected: false,
    timing: { start: startedAt, end: startedAt + 50 },
    size: 0,
    ...result,
  };
  return { runId, entryId: base.id, request: fullRequest, startedAt, state, result: fullResult };
}

const compact = (node: JNode | undefined) => (node ? serializeJsonTree(node) : undefined);

/** Spec without JSON node ids (fresh per parse), for equality across builds. */
function withoutIds(spec: EndpointSpec): unknown {
  return JSON.parse(JSON.stringify(spec, (key, value) => (key === 'id' ? undefined : value)));
}

// A realistic order-creation call: hook-captured JSON POST with a nested body, cookies seen on the wire and
// a JSON response with a big integer.
const ORDER_BODY = {
  customerId: 42,
  note: 'Leave at the door',
  items: [
    { sku: 'SKU-1', qty: 2, options: { giftWrap: true } },
    { sku: 'SKU-2', qty: 1, options: { giftWrap: false } },
  ],
  payment: { method: 'card', card_number: '4111111111111111', cvv: '123' },
  account: { email: 'ada@example.com', password: 'hunter2' },
};
const ORDER_RESPONSE = '{"id":9001,"externalRef":12345678901234567890,"status":"pending","items":[{"sku":"SKU-1"}],"sessionToken":"tok_abc"}';
const orderEntry = (patch: Partial<RequestEntry> = {}) =>
  entry({
    method: 'POST',
    url: 'https://api.example.com/v2/customers/42/orders?expand=items&tag=a&tag=b&api_key=live-key-123',
    requestHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: `Bearer ${JWT}` },
      { name: 'X-Client-Version', value: '4.2.0' },
      { name: 'Accept', value: '*/*' },
    ],
    requestBody: jsonBody(ORDER_BODY),
    requestContentType: 'application/json',
    status: 201,
    statusText: 'Created',
    responseHeaders: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'location', value: '/v2/orders/9001' },
      { name: 'x-ratelimit-remaining', value: '99' },
      { name: 'x-powered-by', value: 'Express' },
    ],
    responseBody: text(ORDER_RESPONSE),
    requestOptions: { credentials: 'include', mode: 'cors' },
    wire: {
      requestId: '77',
      requestHeaders: [
        { name: 'Cookie', value: 'sid=s3ss10n; theme=dark; _ga=GA1.2.3' },
        { name: 'User-Agent', value: 'Mozilla/5.0' },
      ],
    },
    ...patch,
  });

describe('detectPathParams', () => {
  it('detects ids and names them after the previous segment', () => {
    expect(detectPathParams('/api/users/123/orders/550e8400-e29b-41d4-a716-446655440000')).toEqual({
      template: '/api/users/{userId}/orders/{orderId}',
      params: [
        { name: 'userId', example: '123', kind: 'integer', index: 2 },
        { name: 'orderId', example: '550e8400-e29b-41d4-a716-446655440000', kind: 'uuid', index: 4 },
      ],
    });
  });

  it.each([
    ['/categories/7', '/categories/{categoryId}', 'integer'],
    ['/addresses/7', '/addresses/{addressId}', 'integer'],
    ['/custom-reports/7', '/custom-reports/{customReportId}', 'integer'],
    ['/statuses/7', '/statuses/{statusId}', 'integer'],
    ['/people/7', '/people/{personId}', 'integer'],
    ['/docs/507f1f77bcf86cd799439011', '/docs/{docId}', 'hex'],
    ['/events/01ARZ3NDEKTSV4RRFFQ69G5FAV', '/events/{eventId}', 'ulid'],
    ['/reports/2024-01-31', '/reports/{date}', 'date'],
    ['/reports/2024-01-31T10:00:00Z', '/reports/{date}', 'date'],
    ['/posts/a1b2-c3d4', '/posts/{postId}', 'slug'],
    ['/orders/ORD-2024-000123', '/orders/{orderId}', 'slug'],
  ])('%s -> %s (%s)', (pathname, template, kind) => {
    const out = detectPathParams(pathname);
    expect(out.template).toBe(template);
    expect(out.params.map((p) => p.kind)).toEqual([kind]);
  });

  it('never treats versions, plain words or words with a digit as params', () => {
    for (const pathname of [
      '/api/v1/users',
      '/v2beta1/things',
      '/standard/custom-report/result/reports/list-all',
      '/auth/oauth2callback',
      '/stats/covid19-stats',
      '/s3-uploads/list',
      '/html5-player',
    ]) {
      expect(detectPathParams(pathname)).toEqual({ template: pathname, params: [] });
    }
  });

  it('falls back to id, id2… when there is no resource name', () => {
    expect(detectPathParams('/123/456').template).toBe('/{id}/{id2}');
    expect(detectPathParams('/api/123').template).toBe('/api/{id}');
    expect(detectPathParams('/users/1/2').template).toBe('/users/{userId}/{id}');
    expect(detectPathParams('/a/1/b/2/a/3').template).toBe('/a/{aId}/b/{bId}/a/{aId2}');
  });

  it('keeps trailing slashes, empty segments and the raw encoding of literal segments', () => {
    expect(detectPathParams('/a/b/').template).toBe('/a/b/');
    expect(detectPathParams('/files//42/').template).toBe('/files//{fileId}/');
    expect(detectPathParams('/caf%C3%A9/menu%20items/12')).toEqual({
      template: '/caf%C3%A9/menu%20items/{menuItemId}',
      params: [{ name: 'menuItemId', example: '12', kind: 'integer', index: 2 }],
    });
    expect(detectPathParams('/')).toEqual({ template: '/', params: [] });
    expect(detectPathParams('')).toEqual({ template: '/', params: [] });
  });
});

describe('suggestBaseName', () => {
  const name = (method: string, pathTemplate: string, graphql: EndpointSpec['graphql'] = null) =>
    suggestBaseName({ method, pathTemplate, graphql });

  it.each([
    ['GET', '/api/users/{userId}/orders', 'GetUserOrders'],
    ['POST', '/orders', 'CreateOrder'],
    ['GET', '/api/v1/users/{userId}', 'GetUser'],
    ['DELETE', '/orgs/{orgId}/members/{memberId}', 'DeleteOrgMember'],
    ['PATCH', '/users/{userId}/settings', 'UpdateUserSettings'],
    ['PUT', '/categories/{categoryId}', 'UpdateCategory'],
    ['GET', '/standard/custom-report/result/reports/list-all', 'ListAllReports'],
    ['POST', '/api/orders/search', 'SearchOrders'],
    ['POST', '/auth/login', 'Login'],
    ['POST', '/auth/refresh-token', 'RefreshToken'],
    ['GET', '/feed.json', 'GetFeed'],
    ['GET', '/', 'GetRoot'],
    ['POST', '/v2/customers/{customerId}/orders', 'CreateCustomerOrder'],
    ['PROPFIND', '/files', 'PropfindFiles'],
  ])('%s %s -> %s', (method, template, expected) => {
    expect(name(method, template)).toBe(expected);
  });

  it('uses the GraphQL operation name', () => {
    expect(name('POST', '/graphql', { operationName: 'GetUser', operationType: 'query', query: '' })).toBe('GetUser');
    expect(name('POST', '/graphql', { operationName: 'createOrder', operationType: 'mutation', query: '' })).toBe('CreateOrder');
    expect(name('POST', '/graphql', { operationName: null, operationType: 'mutation', query: '' })).toBe('GraphqlMutation');
  });

  it('always returns a usable identifier', () => {
    expect(name('GET', '/2024/report')).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    expect(name('GET', '/x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe('buildEndpointSpec — hook JSON POST', () => {
  const base = orderEntry();
  const runs = [
    run(base, T0 + 2000, { status: 422, body: jsonBody({ error: 'validation_failed', fields: [{ path: 'items[0].qty', message: 'must be > 0' }] }) }, {
      body: { kind: 'text', text: '{"customerId":42,"items":[]}' },
    }),
    run(base, T0 + 1000, { status: 201, body: text('{"id":9002,"externalRef":1,"status":"pending","items":[]}') }),
  ];
  const spec = buildEndpointSpec({ entry: base, runs });

  it('describes the endpoint', () => {
    expect(spec.method).toBe('POST');
    expect(spec.origin).toBe('https://api.example.com');
    expect(spec.pathTemplate).toBe('/v2/customers/{customerId}/orders');
    expect(spec.pathParams).toEqual([{ name: 'customerId', example: '42', kind: 'integer', index: 2 }]);
    expect(spec.url).toBe('https://api.example.com/v2/customers/42/orders?expand=items&tag=a&tag=b&api_key=<redacted>');
    expect(spec.pageOrigin).toBe('https://app.example.com');
    expect(spec.credentials).toBe('include');
    expect(spec.capturedAt).toBe(T0);
    expect(spec.graphql).toBeNull();
  });

  it('collects query params (repeated, required across samples, redacted)', () => {
    expect(spec.query).toEqual([
      { name: 'expand', examples: ['items'], repeated: false, required: true, redacted: false },
      { name: 'tag', examples: ['a', 'b'], repeated: true, required: true, redacted: false },
      { name: 'api_key', examples: ['<redacted>'], repeated: false, required: true, redacted: true },
    ]);
  });

  it('keeps relevant headers only and summarizes auth without values', () => {
    expect(spec.requestHeaders).toEqual([
      { name: 'Content-Type', value: 'application/json', redacted: false },
      { name: 'Authorization', value: 'Bearer <redacted>', redacted: true },
      { name: 'X-Client-Version', value: '4.2.0', redacted: false },
    ]);
    expect(spec.auth).toEqual([
      { scheme: 'bearer', location: 'Authorization', note: 'Bearer token (JWT) in the Authorization header' },
      { scheme: 'api-key', location: 'api_key', note: 'API key in the "api_key" query parameter' },
      { scheme: 'cookie', location: 'sid', note: 'Session cookie "sid" sent by the browser (+2 other cookies)' },
    ]);
    expect(JSON.stringify(spec)).not.toContain(JWT);
    expect(JSON.stringify(spec)).not.toContain('s3ss10n');
  });

  it('uses the request body (and the 2xx run request) as samples, redacted at any depth', () => {
    const body = spec.requestBody;
    expect(body?.kind).toBe('json');
    expect(body?.contentType).toBe('application/json');
    expect(body?.samples).toHaveLength(2);
    const first = compact(body?.samples[0]);
    expect(first).toContain('"card_number":"<redacted>"');
    expect(first).toContain('"cvv":"<redacted>"');
    expect(first).toContain('"password":"<redacted>"');
    expect(first).toContain('"email":"ada@example.com"');
    // The 422 run's request is an invalid input: not a sample of the contract.
    expect(body?.samples.some((sample) => compact(sample) === '{"customerId":42,"items":[]}')).toBe(false);
  });

  it('groups responses by status, keeps big integers exact and records sources', () => {
    expect(spec.responses.map((r) => [r.status, r.statusText, r.sources])).toEqual([
      [201, 'Created', ['original', 'run']],
      [422, undefined, ['run']],
    ]);
    const created = spec.responses[0];
    expect(created.body?.kind).toBe('json');
    expect(created.body?.samples).toHaveLength(2);
    expect(compact(created.body?.samples[0])).toBe(
      '{"id":9001,"externalRef":12345678901234567890,"status":"pending","items":[{"sku":"SKU-1"}],"sessionToken":"<redacted>"}',
    );
    expect(created.headers).toEqual([
      { name: 'content-type', value: 'application/json; charset=utf-8', redacted: false },
      { name: 'location', value: '/v2/orders/9001', redacted: false },
      { name: 'x-ratelimit-remaining', value: '99', redacted: false },
    ]);
    expect(compact(spec.responses[1].body?.samples[0])).toContain('"validation_failed"');
  });

  it('flags redaction and adds no caveats for a clean capture', () => {
    expect(spec.redacted).toBe(true);
    expect(spec.notes).toEqual([]);
  });

  it('is deterministic and independent of the run order', () => {
    const again = buildEndpointSpec({ entry: base, runs: [...runs].reverse() });
    expect(withoutIds(again)).toEqual(withoutIds(spec));
  });

  it('never mutates its input', () => {
    const before = JSON.stringify({ base, runs });
    buildEndpointSpec({ entry: base, runs });
    expect(JSON.stringify({ base, runs })).toBe(before);
  });
});

describe('buildEndpointSpec — GET with query and path ids', () => {
  const base = entry({
    url: 'https://api.example.com/api/v1/projects/7f3c2a9e-1b2d-4c5e-8f90-123456789abc/tasks/981?status=open&page=2&sort=-created',
    requestHeaders: [
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Api-Version', value: '2024-06-01' },
    ],
    responseBody: jsonBody({ id: 981, title: 'Ship v0.2', done: false }),
  });
  const extra = run(base, T0 + 500, { status: 200, body: jsonBody({ id: 982, title: 'Docs', done: true, assignee: 'ada' }) }, {
    url: 'https://api.example.com/api/v1/projects/7f3c2a9e-1b2d-4c5e-8f90-123456789abc/tasks/982?status=closed&page=1&sort=-created&include=tags',
  });
  const spec = buildEndpointSpec({ entry: base, runs: [extra] });

  it('templates every id segment', () => {
    expect(spec.pathTemplate).toBe('/api/v1/projects/{projectId}/tasks/{taskId}');
    expect(spec.pathParams.map((p) => [p.name, p.kind, p.example])).toEqual([
      ['projectId', 'uuid', '7f3c2a9e-1b2d-4c5e-8f90-123456789abc'],
      ['taskId', 'integer', '981'],
    ]);
  });

  it('marks params missing from some samples as optional', () => {
    expect(spec.query.map((q) => [q.name, q.required, q.examples])).toEqual([
      ['status', true, ['open', 'closed']],
      ['page', true, ['2', '1']],
      ['sort', true, ['-created']],
      ['include', false, ['tags']],
    ]);
  });

  it('has no request body and merges both 200 samples', () => {
    expect(spec.requestBody).toBeNull();
    expect(spec.responses).toHaveLength(1);
    expect(spec.responses[0].sources).toEqual(['original', 'run']);
    expect(spec.responses[0].body?.samples).toHaveLength(2);
    expect(spec.requestHeaders.map((h) => h.name)).toEqual(['Accept', 'X-Api-Version']);
    expect(spec.redacted).toBe(false);
    expect(spec.credentials).toBe('same-origin');
  });

  it('ignores a body on a GET and says so', () => {
    const withBody = buildEndpointSpec({ entry: entry({ requestBody: text('{"x":1}'), requestContentType: 'application/json' }) });
    expect(withBody.requestBody).toBeNull();
    expect(withBody.notes).toContain('A GET request cannot carry a body: the captured body is ignored.');
  });
});

describe('buildEndpointSpec — GraphQL', () => {
  const request = {
    operationName: 'Login',
    query: 'mutation Login($email: String!) {\n  login(email: $email, password: "hunter2") { token user { id name } }\n}',
    variables: { email: 'ada@example.com' },
  };
  const base = entry({
    method: 'POST',
    url: 'https://app.example.com/graphql',
    frameUrl: 'https://app.example.com/',
    pageUrl: 'https://app.example.com/',
    requestHeaders: [{ name: 'content-type', value: 'application/json' }],
    requestContentType: 'application/json',
    requestBody: jsonBody(request),
    responseBody: jsonBody({ data: { login: { token: JWT, user: { id: '1', name: 'Ada' } } } }),
  });
  const spec = buildEndpointSpec({ entry: base });

  it('extracts the operation and keeps the whole request object as the sample', () => {
    expect(spec.graphql).toEqual({
      operationName: 'Login',
      operationType: 'mutation',
      query: 'mutation Login($email: String!) {\n  login(email: $email, password: "<redacted>") { token user { id name } }\n}',
    });
    expect(spec.requestBody?.kind).toBe('graphql');
    const sample = spec.requestBody?.samples[0] as JNode;
    expect(compact(childByKey(sample, 'variables'))).toBe('{"email":"ada@example.com"}');
    // The document inside the JSON sample is redacted too.
    expect(compact(sample)).not.toContain('hunter2');
    expect(compact(spec.responses[0].body?.samples[0])).toBe('{"data":{"login":{"token":"<redacted>","user":{"id":"1","name":"Ada"}}}}');
    expect(suggestBaseName(spec)).toBe('Login');
  });

  it('reads the operation from the document when operationName is absent', () => {
    const anonymous = buildEndpointSpec({
      entry: { ...base, requestBody: jsonBody({ query: '# list\n{ viewer { id } }' }) },
    });
    expect(anonymous.graphql).toEqual({ operationName: null, operationType: 'query', query: '# list\n{ viewer { id } }' });
    const named = buildEndpointSpec({ entry: { ...base, requestBody: jsonBody({ query: 'query Viewer { viewer { id } }' }) } });
    expect(named.graphql?.operationName).toBe('Viewer');
    const picked = buildEndpointSpec({
      entry: {
        ...base,
        requestBody: jsonBody({ operationName: 'B', query: 'query A { a } mutation B { b }' }),
      },
    });
    expect(picked.graphql).toMatchObject({ operationName: 'B', operationType: 'mutation' });
  });

  it('notes persisted queries and batches', () => {
    const persisted = buildEndpointSpec({
      entry: {
        ...base,
        requestBody: jsonBody({ operationName: 'Feed', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } }),
      },
    });
    expect(persisted.graphql).toEqual({ operationName: 'Feed', operationType: null, query: '' });
    expect(persisted.notes.some((note) => note.startsWith('Automatic persisted query'))).toBe(true);
    const batch = buildEndpointSpec({
      entry: { ...base, requestBody: jsonBody([{ query: '{ a }' }, { query: '{ b }' }]) },
    });
    expect(batch.graphql).toBeNull();
    expect(batch.requestBody?.kind).toBe('json');
    expect(batch.notes).toContain('GraphQL batch request (2 operations): typed as a JSON array.');
  });

  it('recognizes GraphQL sent as GET query parameters', () => {
    const get = buildEndpointSpec({
      entry: entry({ url: 'https://app.example.com/graphql?operationName=Me&query=query%20Me%20%7B%20me%20%7B%20id%20%7D%20%7D' }),
    });
    expect(get.graphql).toEqual({ operationName: 'Me', operationType: 'query', query: 'query Me { me { id } }' });
    expect(get.requestBody).toBeNull();
  });
});

describe('buildEndpointSpec — form and multipart', () => {
  it('describes urlencoded fields, redacting passwords', () => {
    const spec = buildEndpointSpec({
      entry: entry({
        method: 'POST',
        url: 'https://app.example.com/login',
        requestContentType: 'application/x-www-form-urlencoded',
        requestBody: text('username=ada&password=hunter2&scope=read&scope=write'),
        status: 302,
        statusText: 'Found',
        responseHeaders: [
          { name: 'Location', value: '/home' },
          { name: 'Set-Cookie', value: 'sid=new; Path=/; HttpOnly' },
        ],
        responseBody: text(''),
      }),
    });
    expect(spec.requestBody).toEqual({
      contentType: 'application/x-www-form-urlencoded',
      kind: 'form',
      samples: [],
      fields: [
        { name: 'username', kind: 'text', example: 'ada', repeated: false, required: true },
        { name: 'password', kind: 'text', example: '<redacted>', repeated: false, required: true },
        { name: 'scope', kind: 'text', example: 'read', repeated: true, required: true },
      ],
      truncated: false,
    });
    expect(spec.responses).toEqual([
      {
        status: 302,
        statusText: 'Found',
        body: null,
        sources: ['original'],
        headers: [
          { name: 'Location', value: '/home', redacted: false },
          { name: 'Set-Cookie', value: 'sid=<redacted>; Path=/; HttpOnly', redacted: true },
        ],
      },
    ]);
    expect(suggestBaseName(spec)).toBe('Login');
  });

  it('describes multipart text and file parts without the random boundary', () => {
    const spec = buildEndpointSpec({
      entry: entry({
        method: 'POST',
        url: 'https://api.example.com/v1/users/550e8400-e29b-41d4-a716-446655440000/avatar',
        requestContentType: 'multipart/form-data; boundary=----WebKitFormBoundaryabc',
        requestBody: {
          kind: 'formData',
          entries: [
            { name: 'caption', type: 'text', value: 'Me at the beach' },
            { name: 'file', type: 'file', fileName: 'me.png', mime: 'image/png', size: 20480, base64: 'iVBORw0KGgo=' },
            { name: 'token', type: 'text', value: 'abc' },
          ],
        },
        status: 204,
        statusText: 'No Content',
        responseHeaders: [],
        responseBody: text(''),
      }),
    });
    expect(spec.requestBody?.contentType).toBe('multipart/form-data');
    expect(spec.requestBody?.kind).toBe('multipart');
    expect(spec.requestBody?.fields).toEqual([
      { name: 'caption', kind: 'text', example: 'Me at the beach', repeated: false, required: true },
      { name: 'file', kind: 'file', example: 'me.png (image/png, 20 kB)', repeated: false, required: true },
      { name: 'token', kind: 'text', example: '<redacted>', repeated: false, required: true },
    ]);
    expect(spec.responses[0]).toMatchObject({ status: 204, body: null });
    expect(spec.pathTemplate).toBe('/v1/users/{userId}/avatar');
  });

  it('describes text and binary bodies', () => {
    const xml = buildEndpointSpec({
      entry: entry({
        method: 'POST',
        url: 'https://soap.example.com/svc',
        requestContentType: 'text/xml',
        requestBody: text('<auth><user>ada</user><password>hunter2</password></auth>'),
        responseHeaders: [{ name: 'content-type', value: 'image/png' }],
        responseBody: { kind: 'base64', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', size: 24 },
      }),
    });
    expect(xml.requestBody).toMatchObject({ kind: 'text', text: '<auth><user>ada</user><password><redacted></password></auth>' });
    expect(xml.responses[0].body).toMatchObject({ kind: 'binary', text: 'Binary body (image/png, 24 B)' });
  });
});

describe('buildEndpointSpec — webRequest-only document', () => {
  const doc = entry({
    id: 'w:55',
    source: 'webRequest',
    kind: 'document',
    method: 'GET',
    url: 'https://app.example.com/reports/2024-01-31?print=true',
    frameUrl: undefined,
    pageUrl: 'https://app.example.com/reports/2024-01-31?print=true',
    requestHeaders: [
      { name: 'Accept', value: 'text/html,application/xhtml+xml' },
      { name: 'User-Agent', value: 'Mozilla/5.0' },
      { name: 'sec-ch-ua', value: '"Chromium"' },
      { name: 'Sec-Fetch-Mode', value: 'navigate' },
      { name: 'Upgrade-Insecure-Requests', value: '1' },
      { name: 'Cookie', value: 'PHPSESSID=abc123; lang=en' },
    ],
    responseHeaders: [
      { name: 'Content-Type', value: 'text/html; charset=utf-8' },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    responseBody: undefined,
    wire: { requestId: '55', type: 'main_frame' },
  });
  const spec = buildEndpointSpec({ entry: doc });

  it('drops browser headers, keeps the session cookie as auth and explains the missing body', () => {
    expect(spec.requestHeaders.map((h) => h.name)).toEqual(['Accept']);
    expect(spec.auth).toEqual([{ scheme: 'cookie', location: 'PHPSESSID', note: 'Session cookie "PHPSESSID" sent by the browser (+1 other cookie)' }]);
    expect(spec.credentials).toBe('include');
    expect(spec.pathTemplate).toBe('/reports/{date}');
    expect(spec.responses).toEqual([
      {
        status: 200,
        statusText: 'OK',
        body: {
          contentType: 'text/html; charset=utf-8',
          kind: 'unavailable',
          samples: [],
          text: 'document request seen by the network layer only',
          truncated: false,
        },
        sources: ['original'],
        headers: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8', redacted: false },
          { name: 'Cache-Control', value: 'no-store', redacted: false },
        ],
      },
    ]);
    expect(spec.notes).toEqual([
      'Captured as a page navigation (document request), not a fetch/XHR call.',
      'Response bodies are not available for requests seen only by the network layer: send a test request from kineReqLens to capture one.',
    ]);
  });

  it('prefers a run JSON body over a body that was not readable', () => {
    const htmlRun = run(doc, T0 + 10, { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], body: jsonBody({ rows: [] }) });
    const withRun = buildEndpointSpec({ entry: doc, runs: [htmlRun] });
    expect(withRun.responses[0].body?.kind).toBe('json');
    expect(withRun.responses[0].sources).toEqual(['original', 'run']);
    expect(withRun.notes).not.toContain(
      'Response bodies are not available for requests seen only by the network layer: send a test request from kineReqLens to capture one.',
    );
  });
});

describe('buildEndpointSpec — runs', () => {
  const base = entry({ method: 'POST', url: 'https://api.example.com/v1/items', requestContentType: 'application/json', requestBody: jsonBody({ name: 'a' }) });

  it('ignores failed, running and other-endpoint runs', () => {
    const runs = [
      run(base, T0 + 1, { status: 0, ok: false, error: 'Failed to fetch' }, {}, 'error'),
      run(base, T0 + 2, { status: 500 }, {}, 'running'),
      run(base, T0 + 3, { status: 404, body: jsonBody({ error: 'nope' }) }, { url: 'https://api.example.com/v1/other' }),
      run(base, T0 + 4, { status: 404, body: jsonBody({ error: 'gone' }) }, { method: 'DELETE' }),
      run(base, T0 + 5, { status: 503, body: text('upstream down'), headers: [{ name: 'content-type', value: 'text/plain' }] }),
    ];
    const spec = buildEndpointSpec({ entry: base, runs });
    expect(spec.responses.map((r) => r.status)).toEqual([200, 503]);
    expect(spec.responses[1].body).toMatchObject({ kind: 'text', text: 'upstream down', contentType: 'text/plain' });
  });

  it('keeps at most five bodies per status', () => {
    const runs = Array.from({ length: 12 }, (_, i) => run(base, T0 + i, { status: 200, body: jsonBody({ n: i }) }));
    const spec = buildEndpointSpec({ entry: base, runs });
    expect(spec.responses[0].body?.samples.map((s) => compact(s))).toEqual(['{"ok":true}', '{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('notes truncated and unparsable JSON responses', () => {
    const spec = buildEndpointSpec({
      entry: entry({ responseBody: text('{"rows":[{"id":1},{"id":', { truncated: true }) }),
    });
    expect(spec.responses[0].body).toMatchObject({ kind: 'text', truncated: true });
    expect(spec.notes).toEqual([
      'A 200 response body was truncated at capture: its example is incomplete.',
      'The 200 response is declared JSON but could not be parsed (truncated): shown as text.',
    ]);
  });
});

describe('buildEndpointSpec — edited draft', () => {
  const base = entry({
    method: 'PATCH',
    url: 'https://api.example.com/v1/items/7',
    requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    requestContentType: 'application/json',
    requestBody: jsonBody({ name: 'Lamp', qty: 1 }),
    responseBody: jsonBody({ id: 7, name: 'Lamp', qty: 1 }),
  });

  function editedQty(value: string) {
    let draft = createDraft(base);
    if (draft.body.type !== 'json') throw new Error('expected json');
    const qty = draft.body.tree.children?.[1] as JNode;
    draft = setBody(draft, { ...draft.body, tree: updateNode(draft.body.tree, qty.id, { value }) });
    return draft;
  }

  it('uses the modified draft as the primary sample and notes it', () => {
    const spec = buildEndpointSpec({ entry: base, draft: editedQty('5') });
    expect(spec.notes[0]).toBe('The edited draft is the request sample (it differs from the captured request).');
    expect(spec.requestBody?.samples.map((s) => compact(s))).toEqual(['{"name":"Lamp","qty":5}', '{"name":"Lamp","qty":1}']);
    expect(spec.responses[0].sources).toEqual(['original']);
  });

  it('ignores an unmodified draft', () => {
    const spec = buildEndpointSpec({ entry: base, draft: createDraft(base) });
    expect(spec.notes).toEqual([]);
    expect(spec.requestBody?.samples).toHaveLength(1);
  });

  it('drops the captured response when the draft targets another endpoint', () => {
    const moved = applyFullUrl(createDraft(base), 'https://api.example.com/v1/archive/7');
    const spec = buildEndpointSpec({ entry: base, draft: moved });
    expect(spec.pathTemplate).toBe('/v1/archive/{archiveId}');
    expect(spec.responses).toEqual([]);
  });
});

describe('buildEndpointSpec — redaction off and robustness', () => {
  it('keeps secrets when redaction is off and warns about them', () => {
    const spec = buildEndpointSpec({ entry: orderEntry(), redact: false });
    expect(spec.redacted).toBe(false);
    expect(spec.url).toContain('api_key=live-key-123');
    expect(spec.requestHeaders[1].value).toBe(`Bearer ${JWT}`);
    expect(compact(spec.requestBody?.samples[0])).toContain('"password":"hunter2"');
    expect(spec.notes).toContain('Secret values are included unredacted ("Share secrets with Claude" is on): never commit, log or echo them.');
    expect(spec.auth[0]).toEqual({ scheme: 'bearer', location: 'Authorization', note: 'Bearer token (JWT) in the Authorization header' });
  });

  it('does not warn when redaction is off but nothing is secret', () => {
    expect(buildEndpointSpec({ entry: entry(), redact: false }).notes).toEqual([]);
  });

  it('never throws on odd entries', () => {
    const odd: RequestEntry[] = [
      entry({ url: 'not a url' }),
      entry({ url: 'data:image/png;base64,iVBORw0KGgo=', kind: 'image', responseBody: undefined, source: 'webRequest' }),
      entry({ state: 'error', status: undefined, error: 'net::ERR_CONNECTION_REFUSED', responseBody: undefined }),
      entry({ state: 'pending', status: undefined, responseBody: undefined }),
      entry({ method: '', requestHeaders: undefined as unknown as HeaderPair[] }),
      entry({ requestBody: { kind: 'unavailable', reason: 'Streaming request body (ReadableStream) is not captured' }, method: 'POST' }),
      entry({ responseHeaders: [{ name: 'content-type', value: 'application/json' }], responseBody: text('{nope') }),
    ];
    for (const item of odd) expect(() => buildEndpointSpec({ entry: item })).not.toThrow();
    expect(buildEndpointSpec({ entry: odd[1] }).notes).toContain('Not an HTTP(S) URL: there is no endpoint path to implement.');
    expect(buildEndpointSpec({ entry: odd[2] }).notes).toContain('The captured request failed: net::ERR_CONNECTION_REFUSED.');
    expect(buildEndpointSpec({ entry: odd[2] }).responses).toEqual([]);
    expect(buildEndpointSpec({ entry: odd[4] }).method).toBe('GET');
    expect(buildEndpointSpec({ entry: odd[5] }).requestBody).toMatchObject({ kind: 'unavailable' });
    expect(buildEndpointSpec({ entry: odd[6] }).responses[0].body).toMatchObject({ kind: 'text', text: '{nope' });
  });

  it('skips malformed runs and copes with partial or missing entries', () => {
    const base = entry();
    const junk = [null, {}, { state: 'done', result: { ok: true, status: 200 } }] as unknown as TestRun[];
    expect(buildEndpointSpec({ entry: base, runs: junk }).responses.map((r) => r.sources)).toEqual([['original']]);
    const partial = buildEndpointSpec({ entry: { url: 'https://api.example.com/v1/users/12?token=abc', method: 'post' } as unknown as RequestEntry });
    expect(partial).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/v1/users/12?token=<redacted>',
      pathTemplate: '/v1/users/{userId}',
      responses: [],
      redacted: true,
    });
    const fallback = buildEndpointSpec({ entry: null as unknown as RequestEntry });
    expect(fallback).toMatchObject({ method: 'GET', url: '', origin: '', pathTemplate: '/', responses: [], redacted: false });
    expect(fallback.notes[0]).toMatch(/^kineReqLens could not analyze this request \(/);
  });

  it('does not parse bodies over 5 MB', () => {
    const huge = `{"rows":[${'1,'.repeat(3 * 1024 * 1024)}1]}`;
    const spec = buildEndpointSpec({ entry: entry({ responseBody: text(huge) }) });
    expect(spec.responses[0].body).toMatchObject({ kind: 'text', truncated: true });
    expect(spec.responses[0].body?.text?.length).toBe(8000);
    expect(spec.notes).toEqual(['A 200 response body is larger than 5 MB: it was not analyzed.']);
  });

  it('redacts secret-looking path segments in the template', () => {
    const spec = buildEndpointSpec({ entry: entry({ url: `https://api.example.com/reset/${JWT}/confirm` }) });
    expect(spec.pathTemplate).toBe('/reset/<redacted>/confirm');
    expect(spec.url).toBe('https://api.example.com/reset/<redacted>/confirm');
  });

  it('notes restored, redirected and cached captures', () => {
    const spec = buildEndpointSpec({
      entry: entry({ restored: true, redirected: true, responseUrl: 'https://api.example.com/v1/items/?token=abc', fromCache: true }),
    });
    expect(spec.notes).toEqual([
      'Restored from a preserved log: Cookie / Authorization values were not kept.',
      'The request was redirected to https://api.example.com/v1/items/?token=<redacted>.',
      'The captured response came from the browser cache.',
    ]);
  });
});
