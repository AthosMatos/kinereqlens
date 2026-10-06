import { describe, expect, it } from 'vitest';
import { warningsOf } from '../../src/ui/detail/derived';
import { setShellMode } from '../../src/ui/shellMode';
import type { BodyModel, Draft, JNode, KVRow, MultipartPart, RequestEntry, SerializedBody } from '../../src/shared/types';
import {
  applyFullUrl,
  applyTypedUrl,
  buildReplayRequest,
  createDraft,
  draftSections,
  draftUrl,
  draftWarnings,
  isDraftModified,
  revertDraft,
  revertJsonNode,
  revertRowIn,
  revertSection,
  setBody,
  setBodyType,
  type BuildOptions,
} from '../../src/lib/draft';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from '../../src/lib/encoding';
import { parseContentType } from '../../src/lib/headers';
import { addChild, removeNode, serializeJsonTree, updateNode } from '../../src/lib/json-tree';
import { createRow, removeRow, updateRow } from '../../src/lib/kv';
import { parseMultipart } from '../../src/lib/multipart';

const OPTS: BuildOptions = {
  runId: 'run-1',
  mode: 'page',
  frameId: 0,
  credentials: 'include',
  redirect: 'follow',
  timeoutMs: 30_000,
  responseBodyCap: 1024,
};

function entry(patch: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'GET',
    url: 'https://api.test/items?a=1&b=two%20words#frag',
    requestHeaders: [{ name: 'Accept', value: 'application/json' }],
    requestBody: null,
    requestContentType: null,
    startTime: 1000,
    state: 'done',
    ...patch,
  };
}

const text = (t: string): SerializedBody => ({ kind: 'text', text: t, size: utf8Encode(t).length });
/** A text capture cut off by the capture cap: `size` is the full length. */
const truncatedText = (t: string, size: number): SerializedBody => ({ kind: 'text', text: t, size, truncated: true });

const jsonEntry = (body = '{"user":{"name":"Ann","age":30},"tags":["a"]}') =>
  entry({
    method: 'POST',
    url: 'https://api.test/users',
    requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    requestBody: text(body),
    requestContentType: 'application/json',
  });

function jsonBody(draft: Draft) {
  if (draft.body.type !== 'json') throw new Error(`expected json, got ${draft.body.type}`);
  return draft.body;
}

const child = (node: JNode, key: string): JNode => {
  const found = node.children?.find((c) => c.key === key);
  if (!found) throw new Error(`no child ${key}`);
  return found;
};

const header = (draft: Draft, name: string): KVRow | undefined =>
  draft.headers.find((row) => row.key.toLowerCase() === name.toLowerCase());

const wireText = (body: { kind: string; text?: string; base64?: string }): string =>
  body.kind === 'text' ? (body.text ?? '') : body.kind === 'base64' ? utf8Decode(base64ToBytes(body.base64 ?? '')) : '';

const NOTHING = { method: false, url: false, query: false, headers: false, body: false };

describe('createDraft', () => {
  it('decomposes the request', () => {
    const draft = createDraft(entry());
    expect(draft).toMatchObject({ entryId: 'h:0:1', method: 'GET', base: 'https://api.test/items', hash: 'frag' });
    expect(draft.query.map((r) => [r.key, r.value])).toEqual([
      ['a', '1'],
      ['b', 'two words'],
    ]);
    expect(draft.headers.map((r) => [r.key, r.value, r.enabled])).toEqual([['Accept', 'application/json', true]]);
    expect(draft.body).toEqual({ type: 'none' });
    expect(draft.originalWire).toEqual({ url: 'https://api.test/items?a=1&b=two%20words#frag', body: { kind: 'none' }, bodyIncomplete: false });
  });

  it('is not modified when fresh, and original is a deep copy with the same ids', () => {
    const draft = createDraft(jsonEntry());
    expect(draftSections(draft)).toEqual(NOTHING);
    expect(isDraftModified(draft)).toBe(false);
    expect(draft.original.query).not.toBe(draft.query);
    expect(draft.original.headers.map((r) => r.id)).toEqual(draft.headers.map((r) => r.id));
    expect(draft.original.headers[0]).not.toBe(draft.headers[0]);
    expect(jsonBody(draft).tree.id).toBe((draft.original.body as { tree: JNode }).tree.id);
  });

  it('adds the implicit Content-Type row only when none exists', () => {
    const implicit = createDraft(entry({ method: 'POST', requestBody: text('hi'), requestContentType: 'text/plain;charset=UTF-8', requestHeaders: [] }));
    expect(implicit.headers.map((r) => [r.key, r.value])).toEqual([['Content-Type', 'text/plain;charset=UTF-8']]);
    expect(draftSections(implicit).headers).toBe(false);
    const explicit = createDraft(
      entry({ requestHeaders: [{ name: 'content-type', value: 'text/csv' }], requestBody: text('a,b'), requestContentType: 'text/csv' }),
    );
    expect(explicit.headers.map((r) => [r.key, r.value])).toEqual([['content-type', 'text/csv']]);
  });

  it('keeps one boundary for a FormData body: model, Content-Type row and originalWire', () => {
    const draft = createDraft(
      entry({
        method: 'POST',
        requestHeaders: [],
        requestBody: { kind: 'formData', entries: [{ name: 'a', type: 'text', value: '1' }] },
        requestContentType: 'multipart/form-data',
      }),
    );
    if (draft.body.type !== 'multipart') throw new Error('expected multipart');
    const boundary = draft.body.boundary;
    const ct = header(draft, 'content-type');
    expect(ct?.value).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(draft.originalWire.body.kind).toBe('base64');
    const wire = draft.originalWire.body.kind === 'base64' ? base64ToBytes(draft.originalWire.body.base64) : new Uint8Array();
    expect(parseMultipart(wire, boundary).map((p) => [p.name, p.value])).toEqual([['a', '1']]);
    expect(draft.original.headers.find((r) => r.id === ct?.id)?.value).toBe(ct?.value);
  });

  it('adds the generated boundary to an explicit multipart Content-Type without one', () => {
    const draft = createDraft(
      entry({
        method: 'POST',
        requestHeaders: [{ name: 'Content-Type', value: 'multipart/form-data' }],
        requestBody: { kind: 'formData', entries: [] },
        requestContentType: 'multipart/form-data',
      }),
    );
    const boundary = draft.body.type === 'multipart' ? draft.body.boundary : '';
    expect(header(draft, 'content-type')?.value).toBe(`multipart/form-data; boundary=${boundary}`);
  });

  it('disables and locks browser-controlled headers of webRequest entries', () => {
    const draft = createDraft(
      entry({
        id: 'w:9',
        source: 'webRequest',
        kind: 'xhr',
        requestHeaders: [
          { name: 'Cookie', value: 'sid=1' },
          { name: 'Content-Type', value: 'application/json' },
          { name: 'sec-ch-ua', value: '"Edge"' },
          { name: 'X-Token', value: 't' },
        ],
      }),
    );
    expect(draft.headers.map((r) => [r.key, r.enabled, !!r.locked])).toEqual([
      ['Cookie', false, true],
      ['Content-Type', true, false],
      ['sec-ch-ua', false, true],
      ['X-Token', true, false],
    ]);
    // A hook entry keeps what the page set (locked for display only).
    const hook = createDraft(entry({ requestHeaders: [{ name: 'Cookie', value: 'x' }] }));
    expect(hook.headers[0]).toMatchObject({ enabled: true, locked: true });
  });

  it('flags lossy originals as bodyIncomplete', () => {
    const truncated = createDraft(entry({ method: 'POST', requestBody: truncatedText('abc', 10) }));
    expect(truncated.originalWire.bodyIncomplete).toBe(true);
    const missingFile = createDraft(
      entry({
        method: 'POST',
        requestBody: { kind: 'formData', entries: [{ name: 'f', type: 'file', fileName: 'x', mime: '', size: 5, truncated: true }] },
        requestContentType: 'multipart/form-data',
      }),
    );
    expect(missingFile.originalWire.bodyIncomplete).toBe(true);
    const cutText = createDraft(
      entry({
        method: 'POST',
        requestBody: { kind: 'formData', entries: [{ name: 't', type: 'text', value: 'abc', truncated: true }] },
        requestContentType: 'multipart/form-data',
      }),
    );
    expect(cutText.originalWire.bodyIncomplete).toBe(true);
    const fullText = createDraft(
      entry({
        method: 'POST',
        requestBody: { kind: 'formData', entries: [{ name: 't', type: 'text', value: 'abc' }] },
        requestContentType: 'multipart/form-data',
      }),
    );
    expect(fullText.originalWire.bodyIncomplete).toBe(false);
    const unavailable = createDraft(entry({ method: 'POST', requestBody: { kind: 'unavailable', reason: 'stream' } }));
    expect(unavailable.originalWire).toMatchObject({ body: { kind: 'none' }, bodyIncomplete: true });
    const wrMultipart = createDraft(
      entry({ method: 'POST', requestBody: { kind: 'formFields', fields: [] }, requestContentType: 'multipart/form-data; boundary=x' }),
    );
    expect(wrMultipart.originalWire.bodyIncomplete).toBe(true);
    const wrForm = createDraft(
      entry({ method: 'POST', requestBody: { kind: 'formFields', fields: [{ name: 'a', value: '1 2' }] }, requestContentType: 'application/x-www-form-urlencoded' }),
    );
    expect(wrForm.originalWire).toEqual({ url: wrForm.originalWire.url, body: { kind: 'text', text: 'a=1+2' }, bodyIncomplete: false });
  });
});

describe('draftSections', () => {
  it('tracks every section by content', () => {
    let draft = createDraft(jsonEntry());
    draft = { ...draft, method: 'PUT' };
    expect(draftSections(draft).method).toBe(true);
    draft = { ...draft, method: 'POST' };
    expect(draftSections(draft).method).toBe(false);

    draft = { ...draft, hash: 'x' };
    expect(draftSections(draft).url).toBe(true);
    draft = { ...draft, hash: '' };

    const accept = draft.headers[0];
    draft = { ...draft, headers: updateRow(draft.headers, accept.id, { value: 'text/plain' }) };
    expect(draftSections(draft).headers).toBe(true);
    draft = { ...draft, headers: updateRow(draft.headers, accept.id, { value: 'application/json' }) };
    expect(draftSections(draft)).toEqual(NOTHING);
  });

  it('treats a JSON value typed back to the original as unmodified', () => {
    const draft = createDraft(jsonEntry());
    const name = child(child(jsonBody(draft).tree, 'user'), 'name');
    const edited = setBody(draft, { ...jsonBody(draft), tree: updateNode(jsonBody(draft).tree, name.id, { value: 'Bob' }) });
    expect(draftSections(edited).body).toBe(true);
    const back = setBody(edited, { ...jsonBody(edited), tree: updateNode(jsonBody(edited).tree, name.id, { value: 'Ann' }) });
    expect(draftSections(back).body).toBe(false);
    expect(isDraftModified(back)).toBe(false);
  });
});

describe('revert', () => {
  it('revertDraft restores everything and returns the draft itself when clean', () => {
    const draft = createDraft(jsonEntry());
    expect(revertDraft(draft)).toBe(draft);
    const tree = jsonBody(draft).tree;
    const edited: Draft = {
      ...draft,
      method: 'PATCH',
      base: 'https://other.test/x',
      query: [createRow('q', '1')],
      headers: [],
      body: { ...jsonBody(draft), tree: removeNode(tree, child(tree, 'tags').id) },
    };
    const reverted = revertDraft(edited);
    expect(draftSections(reverted)).toEqual(NOTHING);
    expect(reverted.headers.map((r) => r.id)).toEqual(draft.headers.map((r) => r.id));
    expect(buildReplayRequest(reverted, OPTS).request).toEqual(buildReplayRequest(draft, OPTS).request);
  });

  it('revertSection reverts one section only', () => {
    const draft = createDraft(entry());
    const edited: Draft = { ...draft, method: 'DELETE', hash: '', query: [] };
    const method = revertSection(edited, 'method');
    expect(draftSections(method)).toMatchObject({ method: false, url: true, query: true });
    const url = revertSection(method, 'url');
    expect(draftSections(url)).toMatchObject({ url: false, query: true });
    expect(draftSections(revertSection(url, 'query'))).toEqual(NOTHING);
    expect(revertSection(draft, 'body')).toBe(draft);
  });

  it('reverting the body after a type switch also restores the auto-managed Content-Type', () => {
    const draft = createDraft(jsonEntry());
    const switched = setBodyType(draft, 'form');
    expect(header(switched, 'content-type')?.value).toBe('application/x-www-form-urlencoded');
    const reverted = revertSection(switched, 'body');
    expect(draftSections(reverted)).toEqual(NOTHING);
    // A Content-Type set by hand is not touched.
    const custom = { ...switched, headers: updateRow(switched.headers, switched.headers[0].id, { value: 'text/x-custom' }) };
    expect(header(revertSection(custom, 'body'), 'content-type')?.value).toBe('text/x-custom');
  });

  it('revertRowIn handles changed, added and deleted query/header rows', () => {
    const draft = createDraft(entry());
    const [a, b] = draft.query;
    let edited: Draft = { ...draft, query: [{ ...a, value: '9' }, createRow('new', 'x')] };
    edited = revertRowIn(edited, 'query', a.id);
    expect(edited.query.map((r) => [r.key, r.value])).toEqual([
      ['a', '1'],
      ['new', 'x'],
    ]);
    edited = revertRowIn(edited, 'query', edited.query[1].id);
    edited = revertRowIn(edited, 'query', b.id);
    expect(edited.query.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(draftSections(edited).query).toBe(false);
    expect(revertRowIn(edited, 'query', 'unknown')).toBe(edited);

    const removed = { ...draft, headers: removeRow(draft.headers, draft.headers[0].id) };
    expect(draftSections(revertRowIn(removed, 'headers', draft.headers[0].id)).headers).toBe(false);
  });

  it('revertRowIn handles form rows and multipart parts', () => {
    const form = createDraft(
      entry({ method: 'POST', requestBody: text('a=1&b=2'), requestContentType: 'application/x-www-form-urlencoded' }),
    );
    if (form.body.type !== 'form') throw new Error('expected form');
    const [ra, rb] = form.body.rows;
    const formEdited = setBody(form, { type: 'form', rows: [{ ...ra, value: 'x' }] });
    const formBack = revertRowIn(revertRowIn(formEdited, 'form', ra.id), 'form', rb.id);
    expect(draftSections(formBack).body).toBe(false);
    expect(revertRowIn(form, 'multipart', ra.id)).toBe(form);

    const mp = createDraft(
      entry({
        method: 'POST',
        requestBody: {
          kind: 'formData',
          entries: [
            { name: 'a', type: 'text', value: '1' },
            { name: 'b', type: 'text', value: '2' },
            { name: 'c', type: 'text', value: '3' },
          ],
        },
        requestContentType: 'multipart/form-data',
      }),
    );
    if (mp.body.type !== 'multipart') throw new Error('expected multipart');
    const [pa, pb, pc] = mp.body.parts;
    const added: MultipartPart = { id: 'added', enabled: true, name: 'z', kind: 'text', value: '' };
    const mpEdited = setBody(mp, { ...mp.body, parts: [added, { ...pa, value: 'changed' }, pc] });
    let back = revertRowIn(mpEdited, 'multipart', pb.id); // deleted: goes back after "a"
    expect(back.body.type === 'multipart' && back.body.parts.map((p) => p.id)).toEqual(['added', pa.id, pb.id, pc.id]);
    back = revertRowIn(revertRowIn(back, 'multipart', 'added'), 'multipart', pa.id);
    expect(draftSections(back).body).toBe(false);
  });

  it('revertJsonNode restores one node', () => {
    const draft = createDraft(jsonEntry());
    const tree = jsonBody(draft).tree;
    const age = child(child(tree, 'user'), 'age');
    let edited = setBody(draft, { ...jsonBody(draft), tree: updateNode(tree, age.id, { value: '31' }) });
    const added = addChild(jsonBody(edited).tree, tree.id, { key: 'extra' });
    edited = setBody(edited, { ...jsonBody(edited), tree: added.root });
    const partly = revertJsonNode(edited, age.id);
    expect(serializeJsonTree(jsonBody(partly).tree)).toBe('{"user":{"name":"Ann","age":30},"tags":["a"],"extra":""}');
    expect(draftSections(revertJsonNode(partly, added.id)).body).toBe(false);
    expect(revertJsonNode(draft, 'nope')).toBe(draft);
  });

  it('revertJsonNode removes nodes when the original body was not JSON', () => {
    const draft = setBodyType(createDraft(entry({ method: 'POST', requestBody: text('plain'), requestContentType: 'text/plain' })), 'json');
    const added = addChild(jsonBody(draft).tree, jsonBody(draft).tree.id, { key: 'k' });
    const withNode = setBody(draft, { ...jsonBody(draft), tree: added.root });
    expect(jsonBody(revertJsonNode(withNode, added.id)).tree.children).toEqual([]);
  });
});

describe('applyFullUrl / draftUrl', () => {
  it('re-uses original ids so an unchanged URL stays unmodified and verbatim', () => {
    const draft = createDraft(entry());
    const same = applyFullUrl(draft, ' https://api.test/items?a=1&b=two%20words#frag ');
    expect(draftSections(same)).toEqual(NOTHING);
    expect(draftUrl(same)).toBe('https://api.test/items?a=1&b=two%20words#frag');
  });

  it('marks only changed params as modified, matching duplicates in order', () => {
    const draft = createDraft(entry({ url: 'https://x.test/p?a=1&a=2&b=3' }));
    const next = applyFullUrl(draft, 'https://x.test/p?a=1&a=5&c=7#h');
    expect(next.query.map((r) => r.id).slice(0, 2)).toEqual([draft.query[0].id, draft.query[1].id]);
    expect(next.query[2].id).not.toBe(draft.query[2].id);
    expect(next.hash).toBe('h');
    expect(draftUrl(next)).toBe('https://x.test/p?a=1&a=5&c=7#h');
  });

  it('keeps ids of rows the user added', () => {
    const draft = createDraft(entry({ url: 'https://x.test/?a=1' }));
    const added = createRow('n', 'v');
    const next = applyFullUrl({ ...draft, query: [...draft.query, added] }, 'https://x.test/?a=1&n=w');
    expect(next.query.map((r) => r.id)).toEqual([draft.query[0].id, added.id]);
  });

  it('keeps the original query text when only the base changed', () => {
    const draft = createDraft(entry({ url: 'https://x.test/p?a=%7e&&b=+#h' }));
    expect(draftUrl({ ...draft, base: 'https://y.test/q' })).toBe('https://y.test/q?a=%7e&&b=+#h');
  });

  it('rebuilds the query keeping untouched rows byte for byte', () => {
    const draft = createDraft(entry({ url: 'https://x.test/p?x=%7e&y=a+b&flag' }));
    const query = updateRow(draft.query, draft.query[1].id, { value: 'c d' });
    expect(draftUrl({ ...draft, query })).toBe('https://x.test/p?x=%7e&y=c%20d&flag');
    const disabled = updateRow(draft.query, draft.query[0].id, { enabled: false });
    expect(draftUrl({ ...draft, query: disabled })).toBe('https://x.test/p?y=a+b&flag');
  });
});

describe('applyTypedUrl (URL field typing)', () => {
  const six = () => createDraft(entry({ url: 'https://api.test/q?foo=bar&n=1&list=a&list=b&q=hello%20world&sym=%7E%21' }));

  it('appends params typed after "?" and keeps the existing (edited and added) ones', () => {
    let d = six();
    d = { ...d, query: updateRow(d.query, d.query[0].id, { value: 'EDITED' }) };
    d = { ...d, query: [...d.query, createRow('mine', '1')] };
    const start = d.query;
    let typed = applyTypedUrl(d, 'https://api.test/q?', start);
    expect(typed.query).toEqual(start);
    typed = applyTypedUrl(typed, 'https://api.test/q?extra', start);
    const extraId = typed.query[7].id;
    typed = applyTypedUrl(typed, 'https://api.test/q?extra=1', start);
    expect(typed.query.map((r) => r.key)).toEqual(['foo', 'n', 'list', 'list', 'q', 'sym', 'mine', 'extra']);
    expect(typed.query[0].value).toBe('EDITED');
    expect(typed.query[7]).toMatchObject({ id: extraId, value: '1' }); // stable while typing
    expect(draftUrl(typed)).toContain('?foo=EDITED&n=1');
    expect(draftUrl(typed)).toMatch(/&mine=1&extra=1$/);
  });

  it('replaces the params when the edit replaced the whole field with a URL that has a query', () => {
    const d = six();
    const replaced = applyTypedUrl(d, 'https://api.test/other?x=1&foo=bar', d.query, true);
    expect(replaced.base).toBe('https://api.test/other');
    expect(replaced.query.map((r) => r.key)).toEqual(['x', 'foo']);
    expect(replaced.query[1].id).toBe(d.query[0].id); // the captured "foo" keeps its id
    // Without a query the params stay (the field never showed them).
    expect(applyTypedUrl(d, 'https://api.test/other', d.query, true).query).toBe(d.query);
  });

  it('a "#" only changes the hash, never the params', () => {
    const d = six();
    const typed = applyTypedUrl(d, 'https://api.test/q#top', null);
    expect(typed.query).toBe(d.query);
    expect(typed.hash).toBe('top');
    expect(draftUrl(typed)).toBe('https://api.test/q?foo=bar&n=1&list=a&list=b&q=hello%20world&sym=%7E%21#top');
    expect(draftUrl(revertSection(typed, 'url'))).toBe(d.originalWire.url);
    expect(applyTypedUrl(d, 'https://api.test/q', null)).toBe(d);
  });
});

describe('setBodyType / setBody', () => {
  it('lets a generic captured Content-Type follow the body (JSON sent as text/plain, JSON:API)', () => {
    for (const type of ['text/plain;charset=UTF-8', 'application/vnd.api+json']) {
      const d = createDraft(entry({ method: 'POST', requestBody: text('{"a":"1"}'), requestContentType: type }));
      expect(d.body.type).toBe('json');
      const form = setBodyType(d, 'form');
      const { request } = buildReplayRequest(form, OPTS);
      expect(request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value).toBe('application/x-www-form-urlencoded');
      expect(request.body).toEqual({ kind: 'text', text: 'a=1' });
      // Switching back and reverting restore the captured type.
      expect(revertSection(form, 'body').headers.find((h) => h.key === 'Content-Type')?.value).toBe(type);
    }
  });

  it('keeps a specific Content-Type and warns when it cannot describe the new body', () => {
    const d = createDraft(entry({ method: 'POST', requestBody: text('<a/>'), requestContentType: 'application/xml' }));
    const json = setBodyType(d, 'json');
    expect(json.headers.find((h) => h.key === 'Content-Type')?.value).toBe('application/xml');
    expect(draftWarnings(json, 'page').map((w) => w.message)).toContainEqual(expect.stringMatching(/application\/xml but the body is JSON/));
    expect(draftWarnings(d, 'page').some((w) => /but the body is/.test(w.message))).toBe(false);
  });

  it('replaces the default Content-Type and keeps a custom one', () => {
    const draft = createDraft(jsonEntry());
    const text = setBodyType(draft, 'text');
    expect(header(text, 'content-type')?.value).toBe('text/plain;charset=UTF-8');
    expect(header(text, 'content-type')?.id).toBe(header(draft, 'content-type')?.id);

    const custom = { ...draft, headers: updateRow(draft.headers, draft.headers[0].id, { value: 'application/vnd.x' }) };
    expect(header(setBodyType(custom, 'text'), 'content-type')?.value).toBe('application/vnd.x');

    const charset = { ...draft, headers: updateRow(draft.headers, draft.headers[0].id, { value: 'application/json; charset=utf-8' }) };
    expect(header(setBodyType(charset, 'form'), 'content-type')?.value).toBe('application/x-www-form-urlencoded');
  });

  it('removes it for none, adds it when missing, and includes the multipart boundary', () => {
    const draft = createDraft(jsonEntry());
    expect(header(setBodyType(draft, 'none'), 'content-type')).toBeUndefined();
    const bare = createDraft(entry({ method: 'POST', requestHeaders: [] }));
    const mp = setBodyType(bare, 'multipart');
    const boundary = mp.body.type === 'multipart' ? mp.body.boundary : '';
    expect(header(mp, 'content-type')?.value).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(setBodyType(draft, 'json')).toBe(draft);
  });

  it('setBody returns the draft itself for the same model', () => {
    const draft = createDraft(jsonEntry());
    expect(setBody(draft, draft.body)).toBe(draft);
    expect(setBody(draft, { type: 'text', text: 'x' }).body).toEqual({ type: 'text', text: 'x' });
  });
});

describe('buildReplayRequest', () => {
  it('sends the original URL and body verbatim when unmodified', () => {
    const raw = '{ "user" : { "name":"Ann" } }';
    const draft = createDraft({ ...jsonEntry(raw), url: 'https://api.test/u?x=%7e#h' });
    const { request, warnings } = buildReplayRequest(draft, OPTS);
    expect(warnings).toEqual([]);
    expect(request).toEqual({
      runId: 'run-1',
      entryId: 'h:0:1',
      mode: 'page',
      frameId: 0,
      method: 'POST',
      url: 'https://api.test/u?x=%7e#h',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: { kind: 'text', text: raw },
      credentials: 'include',
      redirect: 'follow',
      timeoutMs: 30_000,
      responseBodyCap: 1024,
    });
  });

  it('serializes a modified body', () => {
    const draft = createDraft(jsonEntry('{ "a" : 1 }'));
    const a = child(jsonBody(draft).tree, 'a');
    const edited = setBody(draft, { ...jsonBody(draft), tree: updateNode(jsonBody(draft).tree, a.id, { value: '2' }) });
    expect(buildReplayRequest(edited, OPTS).request.body).toEqual({ kind: 'text', text: '{"a":2}' });
  });

  it('drops the body of GET/HEAD requests with a warning', () => {
    const draft = { ...createDraft(jsonEntry()), method: 'get' };
    const { request, warnings } = buildReplayRequest(draft, OPTS);
    expect(request.body).toEqual({ kind: 'none' });
    expect(warnings.join()).toMatch(/GET requests cannot have a body/);
    expect(buildReplayRequest(createDraft(entry()), OPTS).warnings).toEqual([]);
  });

  it('makes Content-Type carry the multipart boundary (rewrite or add)', () => {
    const draft = setBodyType(createDraft(jsonEntry()), 'multipart');
    const boundary = draft.body.type === 'multipart' ? draft.body.boundary : '';
    const ctId = header(draft, 'content-type')?.id ?? '';

    const wrong = { ...draft, headers: updateRow(draft.headers, ctId, { value: 'multipart/form-data; boundary=old; x=1' }) };
    expect(buildReplayRequest(wrong, OPTS).request.headers).toEqual([
      { name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}; x=1` },
    ]);
    const missing = { ...draft, headers: [] };
    expect(buildReplayRequest(missing, OPTS).request.headers).toEqual([
      { name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` },
    ]);
    const other = { ...draft, headers: updateRow(draft.headers, ctId, { value: 'text/plain' }) };
    const result = buildReplayRequest(other, OPTS);
    expect(result.request.headers).toEqual([{ name: 'Content-Type', value: 'text/plain' }]);
    expect(result.warnings.join()).toMatch(/multipart/);
  });

  it('uses GET for an empty method and passes the options through', () => {
    const draft = { ...createDraft(entry()), method: '  ' };
    const { request, warnings } = buildReplayRequest(draft, { ...OPTS, mode: 'extension', frameId: 3, credentials: 'omit', redirect: 'manual' });
    expect(request).toMatchObject({ method: 'GET', mode: 'extension', frameId: 3, credentials: 'omit', redirect: 'manual' });
    expect(warnings.join()).toMatch(/empty/);
  });

  it('warns when the verbatim original body is incomplete', () => {
    const draft = createDraft(entry({ method: 'POST', requestBody: truncatedText('abc', 9) }));
    const { request, warnings } = buildReplayRequest(draft, OPTS);
    expect(request.body).toEqual({ kind: 'text', text: 'abc' });
    expect(warnings.join()).toMatch(/truncated/);
  });

  it('omits disabled headers', () => {
    const draft = createDraft(entry({ source: 'webRequest', id: 'w:1', requestHeaders: [{ name: 'Cookie', value: 'a' }, { name: 'X', value: 'y' }] }));
    expect(buildReplayRequest(draft, OPTS).request.headers).toEqual([{ name: 'X', value: 'y' }]);
  });
});

describe('draftWarnings', () => {
  const find = (list: ReturnType<typeof draftWarnings>, pattern: RegExp) => list.filter((w) => pattern.test(w.message));

  it('is empty for a plain captured request', () => {
    expect(draftWarnings(createDraft(jsonEntry()), 'page')).toEqual([]);
  });

  it('warns about forbidden headers in page mode and unsafe ones in extension mode', () => {
    let draft = createDraft(entry());
    const cookie = createRow('Cookie', 'a=1');
    const host = createRow('Host', 'x');
    draft = { ...draft, headers: [...draft.headers, cookie, host, createRow('Referer', 'x', false)] };
    const page = draftWarnings(draft, 'page');
    expect(find(page, /controlled by the browser; ignored in Page mode — use Extension mode/).map((w) => w.targetId)).toEqual([
      cookie.id,
      host.id,
    ]);
    const ext = draftWarnings(draft, 'extension');
    expect(find(ext, /cannot be overridden/)).toEqual([expect.objectContaining({ level: 'warn', section: 'headers', targetId: host.id })]);
    expect(find(ext, /controlled by the browser/)).toEqual([]);
  });

  it('does not warn about browser-controlled headers in App mode (React Native: the app sends them)', () => {
    let draft = createDraft(entry());
    const bad = createRow('Bad Name', 'x');
    draft = { ...draft, headers: [...draft.headers, createRow('Cookie', 'a=1'), createRow('Host', 'x'), bad] };
    const app = draftWarnings(draft, 'page', { app: true });
    expect(find(app, /controlled by the browser|cannot be overridden/)).toEqual([]);
    expect(app.map((w) => w.targetId)).toEqual([bad.id]);
    expect(find(draftWarnings(draft, 'extension', { app: true }), /cannot be overridden/)).toHaveLength(1);
  });

  it('warningsOf uses App mode in the standalone React Native tab', () => {
    const withCookie = () => {
      const draft = createDraft(entry());
      return { ...draft, headers: [...draft.headers, createRow('Cookie', 'a=1')] };
    };
    expect(find(warningsOf(withCookie(), 'page'), /ignored in Page mode/)).toHaveLength(1);
    setShellMode('standalone');
    try {
      expect(find(warningsOf(withCookie(), 'page'), /controlled by the browser/)).toEqual([]);
    } finally {
      setShellMode('overlay');
    }
  });

  it('flags invalid header names and values', () => {
    const draft = createDraft(entry());
    const bad = createRow('Bad Name', 'x');
    const value = createRow('X-V', 'a\nb');
    const list = draftWarnings({ ...draft, headers: [bad, value, createRow('', 'orphan')] }, 'page');
    expect(list.map((w) => w.targetId)).toEqual([bad.id, value.id, expect.any(String)]);
    expect(list.every((w) => w.level === 'warn')).toBe(true);
  });

  it('blocks invalid JSON numbers with the node id', () => {
    const draft = createDraft(jsonEntry());
    const age = child(child(jsonBody(draft).tree, 'user'), 'age');
    const edited = setBody(draft, { ...jsonBody(draft), tree: updateNode(jsonBody(draft).tree, age.id, { value: '3O' }) });
    expect(draftWarnings(edited, 'page')).toEqual([
      expect.objectContaining({ level: 'error', section: 'body', targetId: age.id }),
    ]);
  });

  it('warns about bodies on GET/HEAD, missing file content and incomplete originals', () => {
    expect(find(draftWarnings({ ...createDraft(jsonEntry()), method: 'HEAD' }, 'page'), /HEAD requests cannot have a body/)).toHaveLength(1);
    const mp = createDraft(
      entry({
        method: 'POST',
        requestBody: { kind: 'formData', entries: [{ name: 'f', type: 'file', fileName: 'big.bin', mime: '', size: 9, truncated: true }] },
        requestContentType: 'multipart/form-data',
      }),
    );
    const list = draftWarnings(mp, 'page');
    const part = mp.body.type === 'multipart' ? mp.body.parts[0] : null;
    expect(find(list, /big\.bin.*not captured/)).toEqual([expect.objectContaining({ section: 'body', targetId: part?.id })]);
    expect(find(list, /original body was truncated/i)).toHaveLength(1);
    const unavailable = createDraft(entry({ method: 'POST', requestBody: { kind: 'unavailable', reason: 'ReadableStream' } }));
    expect(find(draftWarnings(unavailable, 'page'), /not captured \(ReadableStream\)/)).toHaveLength(1);
  });

  it('flags a non-multipart Content-Type on a multipart body', () => {
    const draft = setBodyType(createDraft(jsonEntry()), 'multipart');
    const ct = header(draft, 'content-type');
    const edited = { ...draft, headers: updateRow(draft.headers, ct?.id ?? '', { value: 'application/json' }) };
    expect(find(draftWarnings(edited, 'page'), /but the body is multipart/)).toEqual([
      expect.objectContaining({ section: 'headers', targetId: ct?.id }),
    ]);
  });

  it('rejects invalid URLs and methods', () => {
    const draft = createDraft(entry());
    const errors = (d: Draft) => draftWarnings(d, 'page').filter((w) => w.level === 'error');
    expect(errors({ ...draft, base: 'not a url', query: [] })).toEqual([expect.objectContaining({ section: 'url' })]);
    expect(errors({ ...draft, base: 'ftp://x.test/f' })[0].message).toMatch(/Only http and https/);
    expect(errors({ ...draft, base: 'https://u:p@x.test/' })[0].message).toMatch(/credentials/);
    expect(errors({ ...draft, method: 'GE T' })).toEqual([expect.objectContaining({ section: 'method' })]);
    expect(errors({ ...draft, method: 'trace' })[0].message).toMatch(/TRACE/);
    expect(draftWarnings({ ...draft, method: '' }, 'page')).toEqual([expect.objectContaining({ level: 'warn', section: 'method' })]);
  });
});

describe('multipart boundary coherence on send', () => {
  it('sends an unmodified FormData body whose boundary matches the header', () => {
    const draft = createDraft(
      entry({
        method: 'POST',
        requestHeaders: [],
        requestBody: {
          kind: 'formData',
          entries: [
            { name: 'note', type: 'text', value: 'hi' },
            { name: 'f', type: 'file', fileName: 'a.bin', mime: 'application/x-bin', size: 3, base64: bytesToBase64(Uint8Array.of(0, 1, 2)) },
          ],
        },
        requestContentType: 'multipart/form-data',
      }),
    );
    const { request } = buildReplayRequest(draft, OPTS);
    const ct = request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
    const boundary = parseContentType(ct).params.boundary;
    const parts = parseMultipart(base64ToBytes(request.body.kind === 'base64' ? request.body.base64 : ''), boundary);
    expect(parts.map((p) => [p.name, p.kind, p.base64 ?? p.value])).toEqual([
      ['note', 'text', 'hi'],
      ['f', 'file', 'AAEC'],
    ]);
    expect(wireText(request.body)).toContain('Content-Type: application/x-bin');
  });

  it('keeps BodyModel unions intact through revert helpers', () => {
    const models: BodyModel['type'][] = ['none', 'json', 'form', 'multipart', 'text', 'binary'];
    for (const type of models) {
      const draft = setBodyType(createDraft(jsonEntry()), type);
      expect(draftSections(revertDraft(draft))).toEqual(NOTHING);
    }
  });
});
