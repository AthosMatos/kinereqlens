import { describe, expect, it } from 'vitest';
import { DraftEditError, applyDraftEdits, parseBodyPath } from '../../src/lib/draftEdits';
import { buildReplayRequest, createDraft, isDraftModified } from '../../src/lib/draft';
import type { Draft, RequestEntry } from '../../src/shared/types';

const JSON_BODY = '{"user":{"name":"Ada","tags":["a","b"]},"big":12345678901234567890,"note":null}';

function entry(over: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'POST',
    url: 'https://api.test/orders?page=1&sort=asc&page=2#frag',
    requestHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'one' },
    ],
    requestBody: { kind: 'text', text: JSON_BODY, size: JSON_BODY.length },
    requestContentType: 'application/json',
    startTime: 1,
    state: 'done',
    status: 200,
    ...over,
  };
}

function sent(draft: Draft) {
  return buildReplayRequest(draft, { runId: 'r', mode: 'page', frameId: 0, credentials: 'include', redirect: 'follow', timeoutMs: 1000, responseBodyCap: 0 }).request;
}

function bodyText(draft: Draft): string {
  const body = sent(draft).body;
  return body.kind === 'text' ? body.text : '';
}

describe('parseBodyPath', () => {
  it('reads the editor\'s data-path format, with $ / leading dots, indices and quoted keys', () => {
    expect(parseBodyPath('user.name')).toEqual(['user', 'name']);
    expect(parseBodyPath('$.user.tags[1]')).toEqual(['user', 'tags', 1]);
    expect(parseBodyPath('.user')).toEqual(['user']);
    expect(parseBodyPath('a["b.c"][0]')).toEqual(['a', 'b.c', 0]);
    expect(parseBodyPath("a['x y']")).toEqual(['a', 'x y']);
    expect(parseBodyPath('[2].id')).toEqual([2, 'id']);
    expect(parseBodyPath('')).toEqual([]);
    expect(parseBodyPath('$')).toEqual([]);
    expect(parseBodyPath('a[')).toBeNull();
    expect(parseBodyPath('a[x]')).toBeNull();
    expect(parseBodyPath('a..b')).toBeNull();
  });
});

describe('applyDraftEdits', () => {
  it('sets, adds, removes, disables and renames query params (duplicates by index)', () => {
    const draft = createDraft(entry());
    const { draft: next, applied } = applyDraftEdits(draft, {
      params: [
        { name: 'page', index: 1, value: '9' },
        { name: 'sort', remove: true },
        { name: 'q', value: 'x y' },
        { name: 'page', add: true, value: '10', enabled: false },
      ],
    });
    expect(applied).toEqual(['param page', 'param sort', 'param q', 'param page']);
    expect(sent(next).url).toBe('https://api.test/orders?page=1&page=9&q=x%20y#frag');
    const renamed = applyDraftEdits(next, { params: [{ name: 'q', rename: 'query' }] }).draft;
    expect(sent(renamed).url).toContain('query=x%20y');
  });

  it('matches headers case-insensitively; a missing one is added; remove drops every one of that name', () => {
    const draft = createDraft(entry());
    const next = applyDraftEdits(draft, {
      headers: [
        { name: 'x-trace', value: 'two' },
        { name: 'Authorization', value: 'Bearer t' },
        { name: 'content-type', remove: true },
      ],
    }).draft;
    const headers = sent(next).headers.map((h) => `${h.name}: ${h.value}`);
    expect(headers).toContain('X-Trace: two');
    expect(headers).toContain('Authorization: Bearer t');
    expect(headers.some((h) => /content-type/i.test(h))).toBe(false);
  });

  it('edits a JSON body by path: values, created parents, appended items, types, renames, removals; untouched values exact', () => {
    const draft = createDraft(entry());
    const next = applyDraftEdits(draft, {
      json: [
        { path: 'user.name', value: 'Grace' },
        { path: 'user.address.city', value: 'Paris' },
        { path: 'user.tags[2]', value: 'c' },
        { path: 'count', value: '12345678901234567891', type: 'number' },
        { path: 'note', value: { deep: [1, 2] } },
        { path: 'user.tags', rename: 'labels' },
      ],
    }).draft;
    const text = bodyText(next);
    expect(JSON.parse(text)).toMatchObject({ user: { name: 'Grace', labels: ['a', 'b', 'c'], address: { city: 'Paris' } }, note: { deep: [1, 2] } });
    expect(text).toContain('12345678901234567890');
    expect(text).toContain('"count":12345678901234567891');
    const removed = applyDraftEdits(next, { json: [{ path: 'big', remove: true }] }).draft;
    expect(JSON.parse(bodyText(removed))).not.toHaveProperty('big');
  });

  it('keeps node ids so a per-path revert restores the captured value', () => {
    const draft = createDraft(entry());
    const edited = applyDraftEdits(draft, { json: [{ path: 'user.name', value: 'Grace' }, { path: 'user.tags[0]', value: 'z' }] }).draft;
    const reverted = applyDraftEdits(edited, { revert: [{ path: 'user.name' }] }).draft;
    expect(JSON.parse(bodyText(reverted)).user).toEqual({ name: 'Ada', tags: ['z', 'b'] });
    const all = applyDraftEdits(reverted, { revert: ['all'] }).draft;
    expect(isDraftModified(all)).toBe(false);
  });

  it('reverts a param, a header and a section', () => {
    const draft = createDraft(entry());
    const edited = applyDraftEdits(draft, { params: [{ name: 'page', value: '5' }], headers: [{ name: 'X-Trace', value: 'two' }], method: 'put' }).draft;
    expect(edited.method).toBe('PUT');
    const a = applyDraftEdits(edited, { revert: [{ param: 'page' }, { header: 'x-trace' }] }).draft;
    expect(sent(a).url).toBe('https://api.test/orders?page=1&sort=asc&page=2#frag');
    expect(sent(a).headers.find((h) => h.name === 'X-Trace')?.value).toBe('one');
    const b = applyDraftEdits(a, { revert: ['method'] }).draft;
    expect(isDraftModified(b)).toBe(false);
  });

  it('replaces the URL (query and hash) and the raw body like the Raw view', () => {
    const draft = createDraft(entry());
    const next = applyDraftEdits(draft, { url: 'https://api.test/v2/orders?id=7#top', body: '{"a": [1, 2]}' }).draft;
    expect(sent(next).url).toBe('https://api.test/v2/orders?id=7#top');
    expect(next.hash).toBe('top');
    expect(JSON.parse(bodyText(next))).toEqual({ a: [1, 2] });
  });

  it('changes the body type and edits form fields', () => {
    const draft = createDraft(entry({ requestBody: { kind: 'text', text: 'a=1&b=2', size: 7 }, requestContentType: 'application/x-www-form-urlencoded', requestHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }] }));
    const next = applyDraftEdits(draft, { form: [{ name: 'a', value: '9' }, { name: 'c', value: 'new' }, { name: 'b', enabled: false }] }).draft;
    expect(bodyText(next)).toBe('a=9&c=new');
    const json = applyDraftEdits(next, { bodyType: 'json' }).draft;
    expect(json.body.type).toBe('json');
  });

  it('a JSON edit of a body-less request creates a JSON object body', () => {
    const draft = createDraft(entry({ method: 'POST', requestBody: null, requestContentType: null, requestHeaders: [] }));
    const next = applyDraftEdits(draft, { json: [{ path: 'a.b', value: 1 }] }).draft;
    expect(JSON.parse(bodyText(next))).toEqual({ a: { b: 1 } });
  });

  it('is atomic: one failing edit changes nothing and says why', () => {
    const draft = createDraft(entry());
    const fails = (edit: Parameters<typeof applyDraftEdits>[1], message: RegExp) => {
      expect(() => applyDraftEdits(draft, edit)).toThrow(DraftEditError);
      expect(() => applyDraftEdits(draft, edit)).toThrow(message);
    };
    fails({ params: [{ name: 'page', value: '3' }, { name: 'nope', remove: true }] }, /no query parameter named "nope"/);
    fails({ json: [{ path: 'user.tags[5]', value: 1 }] }, /out of range.*use index 2 to append/);
    fails({ json: [{ path: 'count', value: 'abc', type: 'number' }] }, /not a valid JSON number/);
    fails({ json: [{ path: 'user..x', value: 1 }] }, /not a valid path/);
    fails({ json: [{ path: '', remove: true }] }, /root cannot be removed/);
    fails({ url: 'ftp://x/' }, /http or https/);
    fails({ method: 'GE T' }, /not an HTTP method/);
    fails({ form: [{ name: 'a', value: '1' }] }, /not a form/);
    fails({ body: '{"broken": ' }, /does not parse/);
    fails({ revert: [{ param: 'missing' }] }, /no query parameter "missing"/);
  });
});
