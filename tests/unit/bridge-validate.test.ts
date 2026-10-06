import { describe, expect, it } from 'vitest';
import {
  MAX_LIST_LIMIT,
  ParamError,
  completeInboxItem,
  isBridgeMethod,
  validateInboxDraft,
  validateOverrides,
  validateParams,
} from '../../src/background/claude/validate';
import { BRIDGE_METHODS } from '../../src/shared/claude-protocol';

const expectError = (fn: () => unknown, message: RegExp) => {
  expect(fn).toThrow(ParamError);
  expect(fn).toThrow(message);
};

describe('isBridgeMethod', () => {
  it('accepts exactly the protocol methods', () => {
    for (const method of BRIDGE_METHODS) expect(isBridgeMethod(method)).toBe(true);
    for (const bad of ['', 'constructor', 'toString', '__proto__', 'STATUS', 'deleteAll', 3, null]) expect(isBridgeMethod(bad)).toBe(false);
  });
});

describe('validateParams', () => {
  it('accepts missing / null params for parameterless methods and rejects any parameter', () => {
    expect(validateParams('status', undefined)).toEqual({});
    expect(validateParams('status', null)).toEqual({});
    expect(validateParams('listTabs', {})).toEqual({});
    expectError(() => validateParams('status', { tabId: 1 }), /unknown parameter "tabId"/);
    expectError(() => validateParams('status', []), /params must be an object/);
    expectError(() => validateParams('status', 'x'), /params must be an object/);
  });

  it('validates listRequests filters', () => {
    expect(
      validateParams('listRequests', { tabId: 4, query: 'orders -png', kinds: ['Fetch', 'xhr'], methods: ['post'], statuses: ['2XX', '404', 'failed'], limit: 20, offset: 40 }),
    ).toEqual({ tabId: 4, query: 'orders -png', kinds: ['fetch', 'xhr'], methods: ['POST'], statuses: ['2xx', '404', 'failed'], limit: 20, offset: 40 });
    expect(validateParams('listRequests', { limit: 10_000 })).toEqual({ limit: MAX_LIST_LIMIT });
    expect(validateParams('listRequests', { tabId: null, query: null })).toEqual({});
    expectError(() => validateParams('listRequests', { limit: 0 }), /limit must be at least 1/);
    expectError(() => validateParams('listRequests', { limit: 2.5 }), /limit must be an integer/);
    expectError(() => validateParams('listRequests', { limit: Number.NaN }), /limit must be an integer/);
    expectError(() => validateParams('listRequests', { limit: '5' }), /limit must be an integer/);
    expectError(() => validateParams('listRequests', { offset: -1 }), /offset must be at least 0/);
    expectError(() => validateParams('listRequests', { offset: Number.POSITIVE_INFINITY }), /offset must be an integer/);
    expectError(() => validateParams('listRequests', { tabId: -1 }), /tabId/);
    expectError(() => validateParams('listRequests', { tabId: 1.5 }), /tabId/);
    expectError(() => validateParams('listRequests', { methods: ['GET POST'] }), /methods\[0\] is not an HTTP method/);
    expectError(() => validateParams('listRequests', { statuses: ['ok'] }), /statuses\[0\]/);
    expectError(() => validateParams('listRequests', { kinds: Array.from({ length: 33 }, () => 'fetch') }), /too many items/);
    expectError(() => validateParams('listRequests', { kinds: 'fetch' }), /array of strings/);
    expectError(() => validateParams('listRequests', { query: 'x'.repeat(1025) }), /too long/);
    expectError(() => validateParams('listRequests', { sort: 'asc' }), /unknown parameter "sort"/);
  });

  it('requires bounded ids', () => {
    expect(validateParams('getRequest', { id: 'selected' })).toEqual({ id: 'selected' });
    expect(validateParams('getRequest', { id: 'h:0:12', maxBodyChars: 5_000_000, includeRuns: false })).toEqual({
      id: 'h:0:12',
      maxBodyChars: 1_000_000,
      includeRuns: false,
    });
    expectError(() => validateParams('getRequest', {}), /missing parameter "id"/);
    expectError(() => validateParams('getRequest', { id: '' }), /request id/);
    expectError(() => validateParams('getRequest', { id: 7 }), /request id/);
    expectError(() => validateParams('getRequest', { id: 'x'.repeat(129) }), /too long/);
    expectError(() => validateParams('getRequest', { id: 'a\nb' }), /control characters/);
    expectError(() => validateParams('getRequest', { id: 'a', includeRuns: 'yes' }), /true or false/);
  });

  it('validates enums and identifiers', () => {
    expect(validateParams('getTypes', { id: 'a', format: 'zod', baseName: 'GetOrders' })).toEqual({ id: 'a', format: 'zod', baseName: 'GetOrders' });
    expectError(() => validateParams('getTypes', { id: 'a', format: 'python' }), /format must be one of/);
    expectError(() => validateParams('getTypes', { id: 'a', baseName: 'not a name' }), /identifier/);
    expect(validateParams('getPrompt', { id: 'a', target: 'tests', includeExamples: true })).toEqual({ id: 'a', target: 'tests', includeExamples: true });
    expectError(() => validateParams('getPrompt', { id: 'a', target: 'deploy' }), /target must be one of/);
    expectError(() => validateParams('sendRequest', { id: 'a', mode: 'proxy' }), /mode must be one of/);
  });

  it('validates send overrides through the method', () => {
    expect(validateParams('sendRequest', { id: 'a', overrides: { method: 'PATCH' } })).toEqual({ id: 'a', overrides: { method: 'PATCH' } });
    expectError(() => validateParams('sendRequest', { id: 'a', overrides: { url: 'ftp://x' } }), /overrides: url must use http or https/);
  });
});

describe('validateOverrides', () => {
  it('accepts every documented override', () => {
    const value = {
      method: 'POST',
      url: 'https://api.example.com/orders?x=1',
      query: [['a', '1'], ['a', '2']],
      headers: [['Content-Type', 'application/json'], ['X-Old', null]],
      body: '{"a":1}',
    };
    expect(validateOverrides(value)).toEqual({ ok: true, value });
  });

  it('rejects unknown keys and bad shapes', () => {
    expect(validateOverrides(null)).toMatchObject({ ok: false });
    expect(validateOverrides({ cookies: 'x' })).toEqual({ ok: false, error: 'unknown override "cookies"' });
    expect(validateOverrides({ method: 'GE T' })).toMatchObject({ ok: false, error: expect.stringContaining('method') });
    expect(validateOverrides({ method: 'connect' })).toMatchObject({ ok: false, error: expect.stringContaining('CONNECT') });
    expect(validateOverrides({ url: '/relative' })).toMatchObject({ ok: false, error: expect.stringContaining('absolute') });
    expect(validateOverrides({ url: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: expect.stringContaining('http') });
    expect(validateOverrides({ url: 'https://user:pw@example.com/' })).toMatchObject({ ok: false, error: expect.stringContaining('credentials') });
    expect(validateOverrides({ url: `https://example.com/${'a'.repeat(70_000)}` })).toMatchObject({ ok: false, error: expect.stringContaining('64 KB') });
    expect(validateOverrides({ query: [['a']] })).toMatchObject({ ok: false });
    expect(validateOverrides({ query: [['a', null]] })).toMatchObject({ ok: false, error: expect.stringContaining('must be a string') });
    expect(validateOverrides({ headers: [['Bad Name', 'x']] })).toMatchObject({ ok: false, error: expect.stringContaining('header name') });
    expect(validateOverrides({ headers: [['X', 'a\r\nInjected: 1']] })).toMatchObject({ ok: false, error: expect.stringContaining('invalid value') });
    expect(validateOverrides({ body: 3 })).toMatchObject({ ok: false, error: expect.stringContaining('string') });
  });

  it('bounds headers and body size', () => {
    const headers = Array.from({ length: 201 }, (_, i) => [`X-${i}`, 'v']);
    expect(validateOverrides({ headers })).toMatchObject({ ok: false, error: expect.stringContaining('max 200') });
    expect(validateOverrides({ body: 'a'.repeat(5 * 1024 * 1024 + 1) })).toMatchObject({ ok: false, error: expect.stringContaining('5 MB') });
    // 2 M three-byte characters = 6 MB of UTF-8.
    expect(validateOverrides({ body: '€'.repeat(2 * 1024 * 1024) })).toMatchObject({ ok: false, error: expect.stringContaining('5 MB') });
    expect(validateOverrides({ body: 'a'.repeat(1024 * 1024) })).toMatchObject({ ok: true });
  });
});

describe('inbox items from the panel', () => {
  const draft = { entryId: 'h:0:1', title: 'POST /orders', target: 'client', prompt: '# Implement' };

  it('accepts valid items and completes them', () => {
    expect(validateInboxDraft(draft)).toEqual({ ok: true, value: draft });
    expect(validateInboxDraft({ ...draft, sessionId: 's1' })).toEqual({ ok: true, value: { ...draft, sessionId: 's1' } });
    expect(validateInboxDraft({ ...draft, sessionId: null })).toEqual({ ok: true, value: { ...draft, sessionId: null } });
    const ok = validateInboxDraft(draft);
    if (!ok.ok) throw new Error('expected ok');
    expect(completeInboxItem(ok.value, 9, 'inbox-1', 1234)).toEqual({ ...draft, id: 'inbox-1', sentAt: 1234, tabId: 9 });
  });

  it('rejects malformed items', () => {
    expect(validateInboxDraft(null)).toMatchObject({ ok: false });
    expect(validateInboxDraft({ ...draft, target: 'deploy' })).toMatchObject({ ok: false });
    expect(validateInboxDraft({ ...draft, prompt: '' })).toMatchObject({ ok: false });
    expect(validateInboxDraft({ ...draft, entryId: 'x'.repeat(200) })).toMatchObject({ ok: false });
    expect(validateInboxDraft({ ...draft, sessionId: 5 })).toMatchObject({ ok: false });
  });
});
