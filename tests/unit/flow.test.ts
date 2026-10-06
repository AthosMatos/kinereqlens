// Realistic "capture -> edit -> revert -> send" flows across the lib modules (capture, body, draft,
// json-tree, kv, url, multipart), the way the store and the editor chain them.
import { describe, expect, it } from 'vitest';
import type { Draft, HookRequestEnd, HookRequestStart, JNode, RequestEntry, ReplayRequest } from '../../src/shared/types';
import { bodyToRawText, bodyTypeLabel, childByKey, rawTextToBody } from '../../src/lib/body';
import {
  applyHookEnd,
  capBody,
  entryFromHookStart,
  findWebRequestMatch,
  isValidHookEnd,
  isValidHookStart,
  mapResourceType,
  mergeWire,
  webRequestBodyToSerialized,
  webRequestHeadersToPairs,
} from '../../src/lib/capture';
import {
  applyFullUrl,
  buildReplayRequest,
  createDraft,
  draftSections,
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
import { getHeader, parseContentType } from '../../src/lib/headers';
import { diffTrees, getNodeAtPath, serializeJsonTree, updateNode } from '../../src/lib/json-tree';
import { updateRow } from '../../src/lib/kv';
import { parseMultipart } from '../../src/lib/multipart';

const OPTS: BuildOptions = {
  runId: 'r1',
  mode: 'page',
  frameId: 0,
  credentials: 'include',
  redirect: 'follow',
  timeoutMs: 30_000,
  responseBodyCap: 10 * 1024 * 1024,
};
const PAGE = 'https://shop.test/cart';
const CAP = 1024 * 1024;

/** What the store does with a hook 'start' (+ optional 'end') coming from the MAIN world. */
function captureFromHook(startMsg: unknown, endMsg?: unknown): RequestEntry {
  if (!isValidHookStart(startMsg)) throw new Error('invalid start');
  let entry = entryFromHookStart(0, { ...startMsg, body: capBody(startMsg.body, CAP) }, PAGE);
  if (endMsg !== undefined) {
    if (!isValidHookEnd(endMsg)) throw new Error('invalid end');
    entry = applyHookEnd(entry, { ...endMsg, body: capBody(endMsg.body, CAP) });
  }
  return entry;
}

function hookStart(patch: Partial<HookRequestStart>): HookRequestStart {
  return {
    hookId: 'f1',
    kind: 'fetch',
    method: 'GET',
    url: 'https://api.shop.test/',
    headers: [],
    body: null,
    contentType: null,
    startTime: 1_700_000_000_000,
    frameUrl: PAGE,
    ...patch,
  };
}

const hookEnd: HookRequestEnd = {
  hookId: 'f1',
  state: 'done',
  status: 200,
  statusText: 'OK',
  headers: [{ name: 'content-type', value: 'application/json' }],
  body: { kind: 'text', text: '{"ok":true}', size: 11 },
  endTime: 1_700_000_000_120,
};

const send = (draft: Draft): ReplayRequest => buildReplayRequest(draft, OPTS).request;

function bodyText(request: ReplayRequest): string {
  if (request.body.kind === 'text') return request.body.text;
  if (request.body.kind === 'base64') return utf8Decode(base64ToBytes(request.body.base64));
  return '';
}

function jsonTree(draft: Draft): JNode {
  if (draft.body.type !== 'json') throw new Error(`expected a JSON body, got ${draft.body.type}`);
  return draft.body.tree;
}

function editJson(draft: Draft, path: Array<string | number>, value: string | boolean): Draft {
  const tree = jsonTree(draft);
  const node = getNodeAtPath(tree, path);
  if (!node) throw new Error(`no node at ${path.join('.')}`);
  if (draft.body.type !== 'json') throw new Error('expected json');
  return setBody(draft, { ...draft.body, tree: updateNode(tree, node.id, { value }) });
}

describe('hook-captured JSON POST', () => {
  const raw = '{\n  "cart": {"id": 98765432109876543210, "items": [{"sku": "A-1", "qty": 1}]},\n  "coupon": null\n}';
  const entry = captureFromHook(
    hookStart({
      method: 'POST',
      url: 'https://api.shop.test/v1/cart?locale=pt-BR&ref=a%2Fb#top',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer abc' },
      ],
      body: { kind: 'text', text: raw, size: utf8Encode(raw).length },
      contentType: 'application/json',
    }),
    hookEnd,
  );

  it('replays the exact original request when nothing was edited', () => {
    const draft = createDraft(entry);
    expect(isDraftModified(draft)).toBe(false);
    expect(draftWarnings(draft, 'page')).toEqual([]);
    const request = send(draft);
    expect(request.url).toBe(entry.url);
    expect(request.body).toEqual({ kind: 'text', text: raw });
    expect(request.headers).toEqual(entry.requestHeaders);
  });

  it('edits a nested field: body re-serialized, big numbers kept, URL verbatim', () => {
    const draft = createDraft(entry);
    const edited = editJson(draft, ['cart', 'items', 0, 'qty'], '3');
    expect(draftSections(edited)).toEqual({ method: false, url: false, query: false, headers: false, body: true });
    const diff = diffTrees(jsonTree(draft), jsonTree(edited));
    expect([...diff.changed]).toEqual([getNodeAtPath(jsonTree(draft), ['cart', 'items', 0, 'qty'])?.id]);

    const request = send(edited);
    expect(request.url).toBe('https://api.shop.test/v1/cart?locale=pt-BR&ref=a%2Fb#top');
    expect(bodyText(request)).toBe('{"cart":{"id":98765432109876543210,"items":[{"sku":"A-1","qty":3}]},"coupon":null}');
  });

  it('typing the original value back makes the body unmodified and verbatim again', () => {
    const draft = createDraft(entry);
    const back = editJson(editJson(draft, ['cart', 'items', 0, 'qty'], '7'), ['cart', 'items', 0, 'qty'], '1');
    expect(isDraftModified(back)).toBe(false);
    expect(send(back).body).toEqual({ kind: 'text', text: raw });
  });

  it('blocks an invalid number and recovers through a node revert', () => {
    const draft = createDraft(entry);
    const broken = editJson(draft, ['cart', 'items', 0, 'qty'], '1x');
    const qty = getNodeAtPath(jsonTree(broken), ['cart', 'items', 0, 'qty']);
    expect(draftWarnings(broken, 'page')).toEqual([expect.objectContaining({ level: 'error', targetId: qty?.id })]);
    const fixed = revertJsonNode(broken, qty?.id ?? '');
    expect(draftWarnings(fixed, 'page')).toEqual([]);
    expect(send(fixed)).toEqual(send(draft));
  });

  it('raw-view edits keep ids aligned so only the edited node is marked', () => {
    const draft = createDraft(entry);
    const text = bodyToRawText(draft.body).replace('"A-1"', '"B-2"');
    const parsed = rawTextToBody(text, draft.body);
    if (!('model' in parsed)) throw new Error(parsed.error);
    const edited = setBody(draft, parsed.model);
    const diff = diffTrees(jsonTree(draft), jsonTree(edited));
    expect([...diff.changed]).toEqual([getNodeAtPath(jsonTree(draft), ['cart', 'items', 0, 'sku'])?.id]);
    expect(diff.added.size).toBe(0);
  });
});

describe('GET with a query string', () => {
  const url = 'https://api.shop.test/search?q=caf%C3%A9+au+lait&page=1&tag=a&tag=b&debug&sort=price%2Basc';
  const entry = captureFromHook(hookStart({ url, headers: [{ name: 'Accept', value: '*/*' }] }), hookEnd);

  it('rebuilds the URL keeping every other parameter encoded as captured', () => {
    const draft = createDraft(entry);
    const page = draft.query.find((row) => row.key === 'page');
    const edited = { ...draft, query: updateRow(draft.query, page?.id ?? '', { value: '2' }) };
    expect(draftSections(edited).query).toBe(true);
    expect(send(edited).url).toBe('https://api.shop.test/search?q=caf%C3%A9+au+lait&page=2&tag=a&tag=b&debug&sort=price%2Basc');
    expect(send(revertRowIn(edited, 'query', page?.id ?? '')).url).toBe(url);
  });

  it('disabling a duplicate and pasting the original URL back', () => {
    const draft = createDraft(entry);
    const secondTag = draft.query.filter((row) => row.key === 'tag')[1];
    const disabled = { ...draft, query: updateRow(draft.query, secondTag.id, { enabled: false }) };
    expect(send(disabled).url).toBe('https://api.shop.test/search?q=caf%C3%A9+au+lait&page=1&tag=a&debug&sort=price%2Basc');
    const pasted = applyFullUrl(disabled, url);
    expect(isDraftModified(pasted)).toBe(false);
    expect(send(pasted).url).toBe(url);
  });

  it('never sends a body on GET', () => {
    const draft = setBodyType(createDraft(entry), 'json');
    const { request, warnings } = buildReplayRequest(draft, OPTS);
    expect(request.body).toEqual({ kind: 'none' });
    expect(warnings).toHaveLength(1);
    expect(draftWarnings(draft, 'page').map((w) => w.section)).toEqual(['body']);
  });
});

describe('GraphQL request', () => {
  const op = {
    operationName: 'Product',
    query: 'query Product($id: ID!) {\n  product(id: $id) { id name price }\n}',
    variables: { id: '42', currency: 'BRL' },
  };
  const raw = JSON.stringify(op);
  const entry = captureFromHook(
    hookStart({
      method: 'POST',
      url: 'https://api.shop.test/graphql',
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: { kind: 'text', text: raw, size: raw.length },
      contentType: 'application/json',
    }),
    hookEnd,
  );

  it('detects the GraphQL flavor and edits variables only', () => {
    const draft = createDraft(entry);
    expect(draft.body.type === 'json' && draft.body.flavor).toBe('graphql');
    expect(bodyTypeLabel(draft.body)).toBe('GraphQL');
    const query = childByKey(jsonTree(draft), 'query');
    expect(query?.value).toBe(op.query);

    const edited = editJson(draft, ['variables', 'id'], '43');
    expect(edited.body.type === 'json' && edited.body.flavor).toBe('graphql');
    const sent = JSON.parse(bodyText(send(edited))) as typeof op;
    expect(sent).toEqual({ ...op, variables: { ...op.variables, id: '43' } });
    expect(send(revertSection(edited, 'body')).body).toEqual({ kind: 'text', text: raw });
  });

  it('detects batched operations', () => {
    const batch = `[${raw},${raw}]`;
    const draft = createDraft({ ...entry, requestBody: { kind: 'text', text: batch, size: batch.length } });
    expect(draft.body.type === 'json' && draft.body.flavor).toBe('graphql-batch');
  });
});

describe('urlencoded form (URLSearchParams body)', () => {
  const raw = 'email=ana%40example.com&name=Ana+Lu%C3%ADsa&tags=a&tags=b&note=';
  const entry = captureFromHook(
    hookStart({
      method: 'POST',
      url: 'https://shop.test/account',
      body: { kind: 'text', text: raw, size: raw.length },
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    }),
    hookEnd,
  );

  it('adds the implicit Content-Type, edits one field and keeps the others raw', () => {
    const draft = createDraft(entry);
    expect(draft.headers.map((h) => [h.key, h.value])).toEqual([['Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8']]);
    if (draft.body.type !== 'form') throw new Error('expected form');
    const name = draft.body.rows.find((row) => row.key === 'name');
    expect(name?.value).toBe('Ana Luísa');
    const edited = setBody(draft, { type: 'form', rows: updateRow(draft.body.rows, name?.id ?? '', { value: 'Ana B' }) });
    const request = send(edited);
    expect(bodyText(request)).toBe('email=ana%40example.com&name=Ana%20B&tags=a&tags=b&note=');
    expect(getHeader(request.headers, 'content-type')).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(send(revertRowIn(edited, 'form', name?.id ?? '')).body).toEqual({ kind: 'text', text: raw });
  });

  it('switching to JSON keeps the fields and the Content-Type follows', () => {
    const draft = createDraft(entry);
    const json = setBodyType(draft, 'json');
    expect(bodyText(send(json))).toBe('{"email":"ana@example.com","name":"Ana Luísa","tags":"a","tags":"b","note":""}');
    expect(getHeader(send(json).headers, 'content-type')).toBe('application/json');
    const reverted = revertSection(json, 'body');
    expect(isDraftModified(reverted)).toBe(false);
    expect(send(reverted)).toEqual(send(draft));
  });
});

describe('FormData with a file', () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff);
  const entry = captureFromHook(
    hookStart({
      method: 'POST',
      url: 'https://api.shop.test/upload',
      headers: [{ name: 'X-CSRF', value: 't0k' }],
      body: {
        kind: 'formData',
        entries: [
          { name: 'title', type: 'text', value: 'Café' },
          { name: 'photo', type: 'file', fileName: 'p.png', mime: 'image/png', size: png.length, base64: bytesToBase64(png) },
        ],
      },
      contentType: 'multipart/form-data',
    }),
    hookEnd,
  );

  function partsOf(request: ReplayRequest) {
    const ct = getHeader(request.headers, 'content-type') ?? '';
    const boundary = parseContentType(ct).params.boundary ?? '';
    const bytes = request.body.kind === 'base64' ? base64ToBytes(request.body.base64) : new Uint8Array();
    return parseMultipart(bytes, boundary);
  }

  it('replays the unmodified FormData coherently (one boundary everywhere)', () => {
    const draft = createDraft(entry);
    expect(isDraftModified(draft)).toBe(false);
    const parts = partsOf(send(draft));
    expect(parts.map((p) => [p.name, p.kind, p.fileName ?? '', p.mime ?? ''])).toEqual([
      ['title', 'text', '', ''],
      ['photo', 'file', 'p.png', 'image/png'],
    ]);
    expect(parts[0].value).toBe('Café');
    expect(base64ToBytes(parts[1].base64 ?? '')).toEqual(png);
  });

  it('edits a text part and keeps the file bytes intact', () => {
    const draft = createDraft(entry);
    if (draft.body.type !== 'multipart') throw new Error('expected multipart');
    const title = draft.body.parts[0];
    const edited = setBody(draft, { ...draft.body, parts: [{ ...title, value: 'Chá' }, draft.body.parts[1]] });
    const parts = partsOf(send(edited));
    expect(parts[0].value).toBe('Chá');
    expect(base64ToBytes(parts[1].base64 ?? '')).toEqual(png);
    const reverted = revertRowIn(edited, 'multipart', title.id);
    expect(isDraftModified(reverted)).toBe(false);
    expect(send(reverted)).toEqual(send(draft));
  });

  it('a user-set Content-Type with a stale boundary is fixed on send', () => {
    const draft = createDraft(entry);
    const ct = draft.headers.find((h) => h.key === 'Content-Type');
    const stale = { ...draft, headers: updateRow(draft.headers, ct?.id ?? '', { value: 'multipart/form-data; boundary=stale' }) };
    expect(partsOf(send(stale))).toHaveLength(2);
  });
});

describe('webRequest entry (worker fetch) with forbidden headers', () => {
  const sent = webRequestHeadersToPairs([
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Cookie', value: 'session=s3cr3t' },
    { name: 'Origin', value: 'https://shop.test' },
    { name: 'sec-fetch-mode', value: 'cors' },
    { name: 'X-Api-Key', value: 'k' },
  ]);
  const entry: RequestEntry = {
    id: 'w:9001',
    source: 'webRequest',
    kind: mapResourceType('xmlhttprequest'),
    frameId: 0,
    pageUrl: PAGE,
    method: 'PUT',
    url: 'https://api.shop.test/items/1',
    requestHeaders: sent,
    requestBody: webRequestBodyToSerialized({ raw: [{ bytes: utf8Encode('{"qty":2}').slice().buffer as ArrayBuffer }] }, CAP),
    requestContentType: 'application/json',
    startTime: 1_700_000_000_000,
    state: 'done',
    status: 204,
    wire: { requestId: '9001', type: 'xmlhttprequest', requestHeaders: sent },
  };

  it('shows browser headers disabled + locked and does not send them', () => {
    const draft = createDraft(entry);
    expect(draft.headers.map((h) => [h.key, h.enabled, !!h.locked])).toEqual([
      ['Content-Type', true, false],
      ['Cookie', false, true],
      ['Origin', false, true],
      ['sec-fetch-mode', false, true],
      ['X-Api-Key', true, false],
    ]);
    expect(draftWarnings(draft, 'page')).toEqual([]);
    expect(send(draft).headers.map((h) => h.name)).toEqual(['Content-Type', 'X-Api-Key']);
    expect(send(draft).body).toEqual({ kind: 'text', text: '{"qty":2}' });
  });

  it('re-enabling Cookie warns in page mode and is sent for extension mode', () => {
    const draft = createDraft(entry);
    const cookie = draft.headers.find((h) => h.key === 'Cookie');
    const enabled = { ...draft, headers: updateRow(draft.headers, cookie?.id ?? '', { enabled: true }) };
    expect(draftWarnings(enabled, 'page')).toEqual([
      expect.objectContaining({ section: 'headers', targetId: cookie?.id, level: 'warn' }),
    ]);
    expect(draftWarnings(enabled, 'extension')).toEqual([]);
    const request = buildReplayRequest(enabled, { ...OPTS, mode: 'extension' }).request;
    expect(getHeader(request.headers, 'cookie')).toBe('session=s3cr3t');
    expect(isDraftModified(revertRowIn(enabled, 'headers', cookie?.id ?? ''))).toBe(false);
  });
});

describe('hook + webRequest merge', () => {
  it('the hook entry absorbs the webRequest snapshot and the draft uses the page headers', () => {
    const wr: RequestEntry = {
      id: 'w:5',
      source: 'webRequest',
      kind: 'xhr',
      frameId: 0,
      pageUrl: '',
      method: 'POST',
      url: 'https://api.shop.test/track#x',
      requestHeaders: [{ name: 'Cookie', value: 'a=1' }],
      requestBody: null,
      requestContentType: null,
      startTime: 1_700_000_000_004,
      state: 'pending',
      wire: { requestId: '5', type: 'xmlhttprequest', requestHeaders: [{ name: 'Cookie', value: 'a=1' }] },
    };
    let hook = captureFromHook(
      hookStart({ method: 'POST', url: 'https://api.shop.test/track', body: { kind: 'text', text: 'ev=1', size: 4 }, contentType: 'text/plain;charset=UTF-8' }),
    );
    const matchId = findWebRequestMatch([wr], hook, 3000);
    expect(matchId).toBe('w:5');
    hook = mergeWire(hook, wr);
    hook = applyHookEnd(hook, hookEnd);
    expect(hook.wire?.requestHeaders).toEqual([{ name: 'Cookie', value: 'a=1' }]);
    const draft = createDraft(hook);
    expect(draft.headers.map((h) => [h.key, h.value])).toEqual([['Content-Type', 'text/plain;charset=UTF-8']]);
    expect(send(draft).body).toEqual({ kind: 'text', text: 'ev=1' });
  });
});

describe('revert all', () => {
  it('returns to a request identical to the original after editing every section', () => {
    const raw = '{"a":{"b":[1,2,3]},"c":"x"}';
    const entry = captureFromHook(
      hookStart({
        method: 'PATCH',
        url: 'https://api.shop.test/r?x=%7E1&y=2#h',
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Trace', value: 't' },
        ],
        body: { kind: 'text', text: raw, size: raw.length },
        contentType: 'application/json',
      }),
      hookEnd,
    );
    const draft = createDraft(entry);
    const original = send(draft);

    let edited = applyFullUrl({ ...draft, method: 'POST' }, 'https://other.shop.test/r2?x=9&z=1');
    edited = { ...edited, headers: updateRow(edited.headers, edited.headers[1].id, { enabled: false }) };
    edited = editJson(edited, ['a', 'b', 1], '20');
    edited = setBodyType(edited, 'form');
    expect(Object.values(draftSections(edited)).every(Boolean)).toBe(true);

    const reverted = revertDraft(edited);
    expect(isDraftModified(reverted)).toBe(false);
    expect(send(reverted)).toEqual(original);
    expect(serializeJsonTree(jsonTree(reverted))).toBe(raw);
  });
});
