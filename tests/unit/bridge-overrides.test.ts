import { describe, expect, it } from 'vitest';
import { applyOverrides, mergeHeaders, withQuery } from '../../src/background/claude/overrides';
import type { ReplayRequest } from '../../src/shared/types';

function request(overrides: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    runId: 'run-1',
    entryId: 'h:0:1',
    mode: 'page',
    frameId: 0,
    method: 'POST',
    url: 'https://api.example.com/orders?page=2&sort=asc',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'a' },
      { name: 'x-trace', value: 'b' },
    ],
    body: { kind: 'text', text: '{"a":1}' },
    credentials: 'same-origin',
    redirect: 'follow',
    timeoutMs: 30_000,
    responseBodyCap: 1000,
    ...overrides,
  };
}

describe('withQuery', () => {
  it('replaces the query and drops the hash', () => {
    expect(withQuery('https://a.test/p?x=1#frag', [['q', 'a b'], ['q', 'ü&=']])).toBe('https://a.test/p?q=a%20b&q=%C3%BC%26%3D');
    expect(withQuery('https://a.test/p?x=1', [])).toBe('https://a.test/p');
  });
});

describe('mergeHeaders', () => {
  it('replaces every header of a name, removes on null, last override wins', () => {
    const merged = mergeHeaders(request().headers, [
      ['x-TRACE', 'c'],
      ['Content-Type', null],
      ['Accept', 'text/plain'],
      ['Accept', 'application/json'],
    ]);
    expect(merged).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'x-TRACE', value: 'c' },
    ]);
  });
});

describe('applyOverrides', () => {
  it('returns the request untouched without overrides', () => {
    const req = request();
    expect(applyOverrides(req, undefined)).toBe(req);
    expect(applyOverrides(req, {})).toEqual(req);
  });

  it('applies method, url, query, headers and body', () => {
    const out = applyOverrides(request(), {
      method: 'PUT',
      url: 'https://api.example.com/orders/7?keep=1#x',
      headers: [['X-Trace', 'z']],
      body: 'raw text',
    });
    expect(out.method).toBe('PUT');
    expect(out.url).toBe('https://api.example.com/orders/7?keep=1');
    expect(out.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'z' },
    ]);
    expect(out.body).toEqual({ kind: 'text', text: 'raw text' });
    expect(out.runId).toBe('run-1');
    expect(out.mode).toBe('page');
  });

  it('query replaces the params of the (overridden) URL', () => {
    expect(applyOverrides(request(), { query: [['page', '3']] }).url).toBe('https://api.example.com/orders?page=3');
    expect(applyOverrides(request(), { url: 'https://b.test/x?y=1', query: [['z', '2']] }).url).toBe('https://b.test/x?z=2');
  });

  it('drops the draft body when switching to GET/HEAD, but keeps an explicit body', () => {
    expect(applyOverrides(request(), { method: 'GET' }).body).toEqual({ kind: 'none' });
    expect(applyOverrides(request(), { method: 'head' }).body).toEqual({ kind: 'none' });
    expect(applyOverrides(request(), { method: 'GET', body: 'x' }).body).toEqual({ kind: 'text', text: 'x' });
  });
});
