import { describe, expect, it } from 'vitest';
import {
  MAX_URL_CHARS,
  bodyOut,
  browserLabel,
  filterRequests,
  formatContext,
  headersOut,
  queryPairs,
  redactText,
  requestDetail,
  requestHeadersOf,
  runOut,
  summarize,
  tabOut,
  urlOut,
} from '../../src/background/claude/format';
import { bridgeEntry, bridgeList, bridgeListRow } from '../../src/content/claude';
import type { RequestSummary } from '../../src/shared/claude-protocol';
import type { LinkState } from '../../src/shared/claude-link';
import type { Draft, RequestEntry, TestRun } from '../../src/shared/types';
import { createDraft, applyFullUrl } from '../../src/lib/draft';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.example.com/orders',
    method: 'POST',
    url: 'https://api.example.com/v1/orders?page=2&access_token=abc123',
    requestHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: `Bearer ${JWT}` },
    ],
    requestBody: { kind: 'text', text: '{"item":"book","qty":12345678901234567890,"password":"hunter2"}', size: 64 },
    requestContentType: 'application/json',
    startTime: 1000,
    endTime: 1250,
    state: 'done',
    status: 201,
    statusText: 'Created',
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'Set-Cookie', value: 'sid=s3cr3t; Path=/; HttpOnly' },
    ],
    responseBody: { kind: 'text', text: '{"id":7,"token":"t0k3n"}', size: 24 },
    ...overrides,
  };
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    entryId: 'h:0:1',
    startedAt: 5000,
    state: 'done',
    origin: 'claude',
    request: {
      runId: 'run-1',
      entryId: 'h:0:1',
      mode: 'extension',
      frameId: 0,
      method: 'POST',
      url: 'https://api.example.com/v1/orders?access_token=abc123',
      headers: [],
      body: { kind: 'none' },
      credentials: 'include',
      redirect: 'follow',
      timeoutMs: 1000,
      responseBodyCap: 1000,
    },
    result: {
      runId: 'run-1',
      ok: true,
      status: 422,
      statusText: 'Unprocessable Content',
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'x-session-id', value: 'abc' },
      ],
      body: { kind: 'text', text: '{"error":"qty too large"}', size: 25 },
      url: 'https://api.example.com/v1/orders',
      redirected: false,
      timing: { start: 5000, headers: 5100, end: 5180 },
      size: 25,
    },
    ...overrides,
  };
}

describe('content-side rows (BRIDGE_LIST / BRIDGE_ENTRY)', () => {
  it('summarizes an entry', () => {
    expect(bridgeListRow(entry())).toEqual({
      id: 'h:0:1',
      source: 'hook',
      method: 'POST',
      url: 'https://api.example.com/v1/orders?page=2&access_token=abc123',
      kind: 'fetch',
      state: 'done',
      status: 201,
      startTime: 1000,
      durationMs: 250,
      size: 24,
    });
  });

  it('falls back to the wire status and Content-Length, clips huge URLs', () => {
    const row = bridgeListRow(
      entry({
        source: 'webRequest',
        status: undefined,
        responseBody: undefined,
        responseHeaders: undefined,
        wire: { requestId: '1', statusCode: 304, responseHeaders: [{ name: 'content-length', value: '512' }] },
        url: `data:text/plain,${'a'.repeat(10_000)}`,
        endTime: undefined,
      }),
    );
    expect(row.status).toBe(304);
    expect(row.size).toBe(512);
    expect(row.durationMs).toBeUndefined();
    expect(row.url.length).toBeLessThan(4200);
  });

  it('answers lists and lookups', () => {
    const entries = [entry(), entry({ id: 'h:0:2' })];
    expect(bridgeList(entries, 'https://app/', true)).toEqual({ pageUrl: 'https://app/', count: 2, rows: [] });
    expect(bridgeList(entries, 'https://app/', false).rows.map((r) => r.id)).toEqual(['h:0:1', 'h:0:2']);
    const lookup = (id: string) => entries.find((e) => e.id === id);
    expect(bridgeEntry(lookup, 'h:0:2', 'p').entry?.id).toBe('h:0:2');
    expect(bridgeEntry(lookup, 'nope', 'p').entry).toBeNull();
    expect(bridgeEntry(lookup, 42, 'p').entry).toBeNull();
    expect(bridgeEntry(lookup, 'x'.repeat(500), 'p').entry).toBeNull();
  });
});

describe('redaction primitives', () => {
  it('redacts URLs, headers and free text only when asked', () => {
    const on = formatContext(true);
    expect(urlOut('https://api.example.com/x?access_token=abc123&page=2', on)).toBe('https://api.example.com/x?access_token=<redacted>&page=2');
    expect(on.redacted).toBe(true);
    const off = formatContext(false);
    expect(urlOut('https://api.example.com/x?access_token=abc123', off)).toBe('https://api.example.com/x?access_token=abc123');
    expect(off.redacted).toBe(false);
    expect(headersOut([{ name: 'Authorization', value: 'Bearer abcdefghijkl' }], formatContext(true))).toEqual([['Authorization', 'Bearer <redacted>']]);
    expect(headersOut([{ name: 'Authorization', value: 'Bearer abcdefghijkl' }], formatContext(false))).toEqual([['Authorization', 'Bearer abcdefghijkl']]);
  });

  it('clips very long URLs', () => {
    expect(urlOut(`https://a.test/${'x'.repeat(20_000)}`, formatContext(false)).length).toBe(MAX_URL_CHARS + 1);
  });

  it('decodes query pairs', () => {
    expect(queryPairs('https://a.test/?q=a+b&x=%C3%BC&flag')).toEqual([
      ['q', 'a b'],
      ['x', 'ü'],
      ['flag', ''],
    ]);
    expect(queryPairs('not a url')).toEqual([]);
  });

  it('redacts secrets in text that is not parseable JSON', () => {
    const ctx = formatContext(true);
    const text = `{"user":"ann","access_token":"abc","n":1,"password": 1234, "cut": "${JWT}", "auth":"Bearer abcdefghijk`;
    const out = redactText(text, ctx);
    expect(out).toContain('"user":"ann"');
    expect(out).toContain('"access_token":"<redacted>"');
    expect(out).toContain('"password": "<redacted>"');
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('abcdefghijk');
    expect(ctx.redacted).toBe(true);
    expect(redactText('a=1&client_secret=xyz&b=2', formatContext(true))).toBe('a=1&client_secret=<redacted>&b=2');
    const clean = formatContext(true);
    expect(redactText('plain words', clean)).toBe('plain words');
    expect(clean.redacted).toBe(false);
  });

  it('redacts well-known API key formats and XML secrets in text bodies', () => {
    const ctx = formatContext(true);
    const out = redactText('<config><password>hunter2</password><key>sk_' + 'live_abcdefghijklmnopqrstuvwx</key><mode>test</mode></config>', ctx);
    expect(out).toBe('<config><password><redacted></password><key><redacted></key><mode>test</mode></config>');
    expect(ctx.redacted).toBe(true);
  });
});

describe('bodyOut', () => {
  it('pretty-prints JSON losslessly and redacts sensitive keys', () => {
    const ctx = formatContext(true);
    const body = bodyOut({ kind: 'text', text: '{"qty":12345678901234567890,"password":"hunter2"}', size: 47 }, 'application/json', ctx, 20_000);
    expect(body).toEqual({
      contentType: 'application/json',
      kind: 'json',
      text: '{\n  "qty": 12345678901234567890,\n  "password": "<redacted>"\n}',
      truncated: false,
      size: 47,
    });
    expect(ctx.redacted).toBe(true);
  });

  it('keeps secrets when sharing them', () => {
    const body = bodyOut({ kind: 'text', text: '{"password":"hunter2"}', size: 22 }, 'application/json', formatContext(false), 100);
    expect(body?.text).toContain('hunter2');
  });

  it('clips to maxBodyChars and reports capture truncation', () => {
    const text = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => i) });
    const clipped = bodyOut({ kind: 'text', text, size: text.length }, 'application/json', formatContext(true), 50);
    expect(clipped?.text.length).toBe(50);
    expect(clipped?.truncated).toBe(true);
    const cut = bodyOut({ kind: 'text', text: '{"a":1,"token":"zz', size: 9999, truncated: true }, 'application/json', formatContext(true), 1000);
    expect(cut).toMatchObject({ kind: 'text', truncated: true, size: 9999 });
    expect(cut?.text).toContain('"token":"zz');
    expect(bodyOut({ kind: 'text', text: 'abc', size: 3 }, 'text/plain', formatContext(false), 0)).toMatchObject({ text: '', truncated: true });
  });

  it('renders GraphQL, forms, multipart, binary, unavailable and empty bodies', () => {
    const ctx = formatContext(true);
    expect(bodyOut({ kind: 'text', text: '{"query":"query Q { me { id } }","variables":{}}', size: 10 }, 'application/json', ctx, 1000)?.kind).toBe('graphql');
    expect(bodyOut({ kind: 'text', text: 'a=1&password=p%40ss&b=x%20y', size: 10 }, 'application/x-www-form-urlencoded', ctx, 1000)).toMatchObject({
      kind: 'form',
      text: 'a=1&password=<redacted>&b=x%20y',
    });
    const multipart = bodyOut(
      {
        kind: 'formData',
        entries: [
          { name: 'title', type: 'text', value: 'hello' },
          { name: 'api_key', type: 'text', value: 'k-123' },
          { name: 'file', type: 'file', fileName: 'a.png', mime: 'image/png', size: 2048, base64: 'iVBORw0KGgo=' },
        ],
      },
      'multipart/form-data',
      ctx,
      1000,
    );
    expect(multipart?.kind).toBe('multipart');
    expect(multipart?.text).toContain('--- part "title"\nhello');
    expect(multipart?.text).toContain('--- part "api_key"\n<redacted>');
    expect(multipart?.text).toContain('--- part "file" (file "a.png", image/png, 2.0 kB)');
    expect(bodyOut({ kind: 'base64', base64: '/9j/4AAQSkZJRg==', size: 10 }, 'image/jpeg', ctx, 1000)).toMatchObject({
      kind: 'binary',
      text: '<binary body: 10 B, image/jpeg>',
    });
    expect(bodyOut({ kind: 'unavailable', reason: 'ReadableStream body' }, null, ctx, 1000)).toMatchObject({ kind: 'unavailable', text: 'ReadableStream body' });
    expect(bodyOut({ kind: 'text', text: '', size: 0 }, 'application/json', ctx, 1000)).toBeNull();
    expect(bodyOut(null, null, ctx, 1000)).toBeNull();
  });
});

describe('summaries and filtering', () => {
  const panel: LinkState = { selectedId: 'h:0:2', work: [{ id: 'h:0:1', modified: true, runs: 3 }] };

  it('adds the panel flags', () => {
    const ctx = formatContext(true);
    const s = summarize(bridgeListRow(entry()), panel, ctx);
    expect(s).toMatchObject({ id: 'h:0:1', modified: true, runs: 3, selected: false, status: 201, durationMs: 250, size: 24 });
    expect(s.url).toBe('https://api.example.com/v1/orders?page=2&access_token=<redacted>');
    expect(summarize(bridgeListRow(entry({ id: 'h:0:2' })), panel, ctx)).toMatchObject({ modified: false, runs: 0, selected: true });
    expect(summarize(bridgeListRow(entry()), null, ctx)).toMatchObject({ modified: false, runs: 0, selected: false });
  });

  const summaries: RequestSummary[] = [
    { id: 'a', method: 'GET', url: 'https://api.test/users', kind: 'fetch', state: 'done', status: 200, startTime: 1, modified: false, runs: 0, selected: false },
    { id: 'b', method: 'POST', url: 'https://api.test/orders', kind: 'xhr', state: 'done', status: 422, startTime: 3, modified: false, runs: 0, selected: false },
    { id: 'c', method: 'GET', url: 'https://cdn.test/logo.png', kind: 'image', state: 'done', status: 304, startTime: 2, modified: false, runs: 0, selected: false },
    { id: 'd', method: 'GET', url: 'https://api.test/slow', kind: 'fetch', state: 'pending', startTime: 4, modified: false, runs: 0, selected: false },
    { id: 'e', method: 'DELETE', url: 'https://api.test/orders/1', kind: 'fetch', state: 'error', startTime: 4, modified: false, runs: 0, selected: false },
  ];
  const ids = (params: Parameters<typeof filterRequests>[1]) => filterRequests(summaries, params).requests.map((r) => r.id);

  it('sorts newest first (ties: later in capture order first) and paginates', () => {
    expect(ids({})).toEqual(['e', 'd', 'b', 'c', 'a']);
    expect(filterRequests(summaries, { limit: 2, offset: 1 })).toEqual({ total: 5, requests: [summaries[3], summaries[1]] });
  });

  it('filters by text terms (all must match, -term excludes), kind, method and status', () => {
    expect(ids({ query: 'api.test orders' })).toEqual(['e', 'b']);
    expect(ids({ query: 'api.test -orders' })).toEqual(['d', 'a']);
    expect(ids({ query: '422' })).toEqual(['b']);
    expect(ids({ kinds: ['image', 'xhr'] })).toEqual(['b', 'c']);
    expect(ids({ kinds: ['Fetch/XHR'] })).toEqual(['e', 'd', 'b', 'a']);
    expect(ids({ kinds: ['img'] })).toEqual(['c']);
    expect(ids({ methods: ['get'] })).toEqual(['d', 'c', 'a']);
    expect(ids({ statuses: ['2xx', '3xx'] })).toEqual(['c', 'a']);
    expect(ids({ statuses: ['422'] })).toEqual(['b']);
    expect(ids({ statuses: ['pending'] })).toEqual(['d']);
    expect(ids({ statuses: ['failed'] })).toEqual(['e', 'b']);
    expect(ids({ statuses: ['error'] })).toEqual(['e']);
  });
});

describe('requestDetail', () => {
  it('formats request, response and redaction', () => {
    const detail = requestDetail(
      { entry: entry(), panel: null, draft: null, runs: [], includeRuns: true, captureResponseBodies: true },
      formatContext(true),
      20_000,
    );
    expect(detail.redacted).toBe(true);
    expect(detail.pageUrl).toBe('https://app.example.com/orders');
    expect(detail.request.url).toBe('https://api.example.com/v1/orders?page=2&access_token=<redacted>');
    expect(detail.request.query).toEqual([
      ['page', '2'],
      ['access_token', '<redacted>'],
    ]);
    expect(detail.request.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer <redacted>'],
    ]);
    expect(detail.request.body?.text).toContain('12345678901234567890');
    expect(detail.request.body?.text).not.toContain('hunter2');
    expect(detail.response?.status).toBe(201);
    expect(detail.response?.headers).toContainEqual(['Set-Cookie', 'sid=<redacted>; Path=/; HttpOnly']);
    expect(detail.response?.body?.text).toBe('{\n  "id": 7,\n  "token": "<redacted>"\n}');
    expect(detail.edited).toBeUndefined();
    expect(detail.runs).toBeUndefined();
    expect(JSON.stringify(detail)).not.toMatch(/hunter2|t0k3n|s3cr3t|abc123|dozjg/);
  });

  it('shares everything when secrets are shared', () => {
    const detail = requestDetail(
      { entry: entry(), panel: null, draft: null, runs: [], includeRuns: true, captureResponseBodies: true },
      formatContext(false),
      20_000,
    );
    expect(detail.redacted).toBe(false);
    expect(JSON.stringify(detail)).toMatch(/hunter2/);
    expect(detail.request.headers).toContainEqual(['Authorization', `Bearer ${JWT}`]);
  });

  it('explains a missing response body and merges wire-only request headers', () => {
    const wr = entry({
      source: 'webRequest',
      kind: 'document',
      responseBody: undefined,
      requestHeaders: [{ name: 'Accept', value: 'text/html' }],
      wire: { requestId: '9', requestHeaders: [{ name: 'accept', value: 'text/html' }, { name: 'Cookie', value: 'sid=1' }] },
    });
    expect(requestHeadersOf(wr)).toEqual([
      { name: 'Accept', value: 'text/html' },
      { name: 'Cookie', value: 'sid=1' },
    ]);
    const detail = requestDetail({ entry: wr, panel: null, draft: null, runs: [], includeRuns: true, captureResponseBodies: true }, formatContext(true), 100);
    expect(detail.response?.body).toBeNull();
    expect(detail.response?.note).toMatch(/network layer/);
    expect(detail.request.headers).toContainEqual(['Cookie', 'sid=<redacted>']);
  });

  it('has no response for manual entries', () => {
    const manual = entry({ source: 'manual', kind: 'manual', responseBody: undefined, status: undefined });
    expect(requestDetail({ entry: manual, panel: null, draft: null, runs: [], includeRuns: true, captureResponseBodies: true }, formatContext(true), 100).response).toBeNull();
  });

  it('includes the edited version and runs (newest first, older bodies shorter)', () => {
    const e = entry();
    const draft: Draft = applyFullUrl(createDraft(e), 'https://api.example.com/v2/orders?page=9');
    const runs = Array.from({ length: 7 }, (_, i) =>
      run({
        runId: `run-${i}`,
        result: { ...run().result!, body: { kind: 'text', text: `{"error":"${'x'.repeat(5000)}"}`, size: 5012 } },
      }),
    );
    const detail = requestDetail(
      { entry: e, panel: { selectedId: e.id, work: [{ id: e.id, modified: true, runs: 7 }] }, draft, runs, includeRuns: true, captureResponseBodies: true },
      formatContext(true),
      20_000,
    );
    expect(detail.summary).toMatchObject({ modified: true, runs: 7, selected: true });
    expect(detail.edited?.url).toBe('https://api.example.com/v2/orders?page=9');
    expect(detail.edited?.headers).toContainEqual(['Authorization', 'Bearer <redacted>']);
    expect(detail.edited?.body?.text).not.toContain('hunter2');
    expect(detail.runs).toHaveLength(5);
    expect(detail.runs?.[0]?.responseBody?.text.length).toBeGreaterThan(5000);
    expect(detail.runs?.[1]?.responseBody?.text.length).toBe(2000);
    const without = requestDetail({ entry: e, panel: null, draft: null, runs, includeRuns: false, captureResponseBodies: true }, formatContext(true), 20_000);
    expect(without.runs).toBeUndefined();
  });
});

describe('runOut', () => {
  it('formats a run, with transport details for send_request', () => {
    const out = runOut(run(), formatContext(true), 1000, true);
    expect(out).toMatchObject({
      runId: 'run-1',
      origin: 'claude',
      state: 'done',
      mode: 'extension',
      startedAt: 5000,
      durationMs: 180,
      status: 422,
      statusText: 'Unprocessable Content',
      request: { method: 'POST', url: 'https://api.example.com/v1/orders?access_token=<redacted>' },
      responseHeaders: [
        ['content-type', 'application/json'],
        ['x-session-id', '<redacted>'],
      ],
      redacted: true,
    });
    expect(out.responseBody?.text).toBe('{\n  "error": "qty too large"\n}');
    const brief = runOut(run({ origin: undefined }), formatContext(true), 1000, false);
    expect(brief.origin).toBe('user');
    expect(brief.responseHeaders).toBeUndefined();
  });

  it('reports failures and running runs', () => {
    const failed = run({
      state: 'error',
      result: { ...run().result!, ok: false, status: 0, error: 'Failed to fetch', errorHint: 'Blocked by CORS in Page mode — try Extension mode', body: null },
    });
    const out = runOut(failed, formatContext(true), 1000, true);
    expect(out.status).toBeUndefined();
    expect(out.error).toBe('Failed to fetch — Blocked by CORS in Page mode — try Extension mode');
    expect(out.responseBody).toBeNull();
    const running = runOut(run({ state: 'running', result: undefined }), formatContext(true), 1000, true);
    expect(running.durationMs).toBeUndefined();
    expect(running.state).toBe('running');
  });
});

describe('tabs and browser', () => {
  it('formats a tab summary', () => {
    expect(
      tabOut({ tabId: 3, title: 'Orders', url: 'https://app.test/?session=abc', open: true, recording: true, entryCount: 12 }, 3, formatContext(true)),
    ).toEqual({ tabId: 3, title: 'Orders', url: 'https://app.test/?session=<redacted>', open: true, recording: true, entryCount: 12, active: true });
    expect(tabOut({ tabId: 4, title: 't', url: 'u', open: false, recording: true, entryCount: 0 }, 3, formatContext(false))).toMatchObject({
      recording: false,
      active: false,
    });
  });

  it('labels the browser', () => {
    expect(browserLabel([{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Microsoft Edge', version: '131' }, { brand: 'Chromium', version: '131' }], '')).toBe(
      'Microsoft Edge 131',
    );
    expect(browserLabel([{ brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }], '')).toBe('Google Chrome 130');
    expect(browserLabel(undefined, 'Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Microsoft Edge 131');
    expect(browserLabel(undefined, 'Mozilla/5.0 ... Chrome/129.0.0.0 Safari/537.36')).toBe('Chromium 129');
    expect(browserLabel(undefined, 'curl')).toBe('Chromium-based browser');
  });
});
