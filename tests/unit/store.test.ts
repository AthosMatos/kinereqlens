import { describe, expect, it, vi } from 'vitest';
import { WR_MATCH_WINDOW_MS } from '../../src/shared/constants';
import type { HookRequestEnd, HookRequestStart, RequestEntry } from '../../src/shared/types';
import { hookEntryId, RequestStore } from '../../src/content/store';
import type { StoreLimits } from '../../src/content/store';

const T0 = 1_700_000_000_000;
const PAGE = 'https://app.test/page';
const API = 'https://api.test/items?x=1';

/** A store with a manual clock and a manual notification queue (flush() delivers coalesced notifications). */
function setup(limits: Partial<StoreLimits> = {}) {
  let time = T0;
  const queue: Array<() => void> = [];
  const schedule = vi.fn((flush: () => void) => {
    queue.push(flush);
  });
  const currentLimits: StoreLimits = { maxEntries: 1000, requestBodyCap: 1024, responseBodyCap: 1024, ...limits };
  const store = new RequestStore({
    now: () => time,
    pageUrl: () => PAGE,
    limits: () => currentLimits,
    schedule,
    defaultManualUrl: () => 'https://app.test/',
  });
  return {
    store,
    schedule,
    limits: currentLimits,
    advance(ms: number) {
      time += ms;
    },
    flush() {
      while (queue.length) queue.shift()?.();
    },
    get queued() {
      return queue.length;
    },
  };
}

function hookStart(overrides: Partial<HookRequestStart> = {}): HookRequestStart {
  return {
    hookId: 'a1',
    kind: 'fetch',
    method: 'GET',
    url: API,
    headers: [{ name: 'Accept', value: 'application/json' }],
    body: null,
    contentType: null,
    startTime: T0,
    frameUrl: PAGE,
    ...overrides,
  };
}

function hookEnd(overrides: Partial<HookRequestEnd> = {}): HookRequestEnd {
  return {
    hookId: 'a1',
    state: 'done',
    status: 200,
    statusText: 'OK',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: { kind: 'text', text: '{"ok":true}', size: 11 },
    endTime: T0 + 40,
    ...overrides,
  };
}

/** A full webRequest snapshot as the service worker sends it (pageUrl is left for the store to fill). */
function wrEntry(requestId: string, overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: `w:${requestId}`,
    source: 'webRequest',
    kind: 'xhr',
    frameId: 0,
    pageUrl: '',
    method: 'GET',
    url: API,
    requestHeaders: [
      { name: 'Accept', value: 'application/json' },
      { name: 'Cookie', value: 'session=1' },
    ],
    requestBody: null,
    requestContentType: null,
    startTime: T0 + 3,
    state: 'pending',
    wire: { requestId, type: 'xmlhttprequest' },
    ...overrides,
  };
}

const ids = (store: RequestStore) => store.getEntries().map((entry) => entry.id);

describe('RequestStore: hook captures', () => {
  it('creates a pending entry from a hook start', () => {
    const { store } = setup();
    store.handleHookMessage(0, { t: 'start', data: hookStart() });
    const [entry] = store.getEntries();
    expect(entry.id).toBe(hookEntryId(0, 'a1'));
    expect(entry.id).toBe('h:0:a1');
    expect(entry).toMatchObject({ source: 'hook', kind: 'fetch', method: 'GET', url: API, state: 'pending', frameId: 0 });
    expect(entry.pageUrl).toBe(PAGE);
    expect(entry.requestHeaders).toEqual([{ name: 'Accept', value: 'application/json' }]);
  });

  it('applies the matching end as a new object', () => {
    const { store } = setup();
    store.handleHookMessage(0, { t: 'start', data: hookStart() });
    const before = store.get('h:0:a1');
    store.handleHookMessage(0, { t: 'end', data: hookEnd() });
    const after = store.get('h:0:a1');
    expect(after).not.toBe(before);
    expect(before?.state).toBe('pending');
    expect(after).toMatchObject({ state: 'done', status: 200, statusText: 'OK' });
    expect(after?.responseBody).toEqual({ kind: 'text', text: '{"ok":true}', size: 11 });
  });

  it('keeps an end that overtakes its start and applies it on arrival', () => {
    const { store } = setup();
    store.handleHookEnd(2, hookEnd({ hookId: 'early', state: 'error', status: undefined, error: 'Network error' }));
    expect(store.size).toBe(0);
    store.handleHookStart(2, hookStart({ hookId: 'early' }));
    expect(store.get('h:2:early')).toMatchObject({ state: 'error', frameId: 2 });
  });

  it('namespaces ids by frame and fills the frame URL from the relay', () => {
    const { store } = setup();
    store.handleHookMessage(3, { t: 'start', data: hookStart({ frameUrl: '' }) }, 'https://ads.test/frame');
    store.handleHookMessage(0, { t: 'start', data: hookStart() });
    expect(ids(store).sort()).toEqual(['h:0:a1', 'h:3:a1']);
    expect(store.get('h:3:a1')?.frameUrl).toBe('https://ads.test/frame');
  });

  it('ignores malformed or forged payloads', () => {
    const { store, schedule } = setup();
    const garbage: unknown[] = [
      null,
      42,
      'start',
      { t: 'start' },
      { t: 'start', data: { ...hookStart(), hookId: 7 } },
      { t: 'start', data: { ...hookStart(), kind: 'websocket' } },
      { t: 'start', data: { ...hookStart(), headers: 'Accept: */*' } },
      { t: 'replay-result', data: {} },
      { t: 'end', data: { hookId: 'a1', state: 'exploded', endTime: T0 } },
    ];
    for (const message of garbage) store.handleHookMessage(0, message);
    store.handleHookStart(-1, hookStart());
    store.handleHookStart(1.5, hookStart());
    expect(store.size).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('keeps only known fields of untrusted payloads', () => {
    const { store } = setup();
    const forged = { ...hookStart(), id: 'w:evil', source: 'webRequest', restored: true, extra: 'x'.repeat(10) };
    store.handleHookStart(0, forged);
    const entry = store.get('h:0:a1');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('hook');
    expect(entry?.restored).toBeUndefined();
    expect(store.get('w:evil')).toBeUndefined();
    expect(entry as unknown as Record<string, unknown>).not.toHaveProperty('extra');
  });

  it('bounds request and response bodies with the current limits', () => {
    const { store } = setup({ requestBodyCap: 8, responseBodyCap: 4 });
    store.handleHookStart(0, hookStart({ body: { kind: 'text', text: 'abcdefghijklmnop', size: 16 } }));
    store.handleHookEnd(0, hookEnd({ body: { kind: 'text', text: '0123456789', size: 10 } }));
    const entry = store.get('h:0:a1');
    const request = entry?.requestBody;
    const response = entry?.responseBody;
    expect(request?.kind).toBe('text');
    expect(response?.kind).toBe('text');
    if (request?.kind === 'text') {
      expect(request.text.length).toBeLessThanOrEqual(8);
      expect(request.truncated).toBe(true);
    }
    if (response?.kind === 'text') {
      expect(response.text.length).toBeLessThanOrEqual(4);
      expect(response.truncated).toBe(true);
    }
  });

  it('ignores a duplicate start for an existing capture', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart());
    const first = store.get('h:0:a1');
    store.handleHookStart(0, hookStart({ url: 'https://other.test/' }));
    expect(store.get('h:0:a1')).toBe(first);
    expect(store.size).toBe(1);
  });
});

describe('RequestStore: webRequest merge', () => {
  it('merges a webRequest snapshot into an existing hook entry (hook first)', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart());
    store.upsertWebRequest([wrEntry('42')]);
    expect(ids(store)).toEqual(['h:0:a1']);
    const merged = store.get('h:0:a1');
    expect(merged?.wire?.requestId).toBe('42');
    // The page's own view of the request is kept; the wire carries what the browser sent.
    expect(merged?.requestHeaders).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(merged?.wire?.requestHeaders).toEqual(wrEntry('42').requestHeaders);
  });

  it('absorbs an already listed webRequest entry when the hook start arrives (webRequest first)', () => {
    const { store } = setup();
    store.upsertWebRequest([wrEntry('42')]);
    expect(ids(store)).toEqual(['w:42']);
    store.handleHookStart(0, hookStart());
    expect(ids(store)).toEqual(['h:0:a1']);
    expect(store.get('h:0:a1')?.wire?.requestId).toBe('42');
  });

  it('keeps merging later snapshots of the same requestId into the hook entry', () => {
    for (const order of ['hook-first', 'wr-first'] as const) {
      const { store } = setup();
      if (order === 'hook-first') {
        store.handleHookStart(0, hookStart());
        store.upsertWebRequest([wrEntry('42')]);
      } else {
        store.upsertWebRequest([wrEntry('42')]);
        store.handleHookStart(0, hookStart());
      }
      // Far outside the match window: only the requestId link can route it.
      const done = wrEntry('42', {
        state: 'done',
        status: 201,
        startTime: T0 + 10 * WR_MATCH_WINDOW_MS,
        responseHeaders: [{ name: 'set-cookie', value: 'a=b' }],
      });
      store.upsertWebRequest([done]);
      expect(ids(store)).toEqual(['h:0:a1']);
      expect(store.get('h:0:a1')?.wire?.statusCode).toBe(201);
    }
  });

  it('does not merge requests that differ in method, URL, frame or time', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart());
    store.upsertWebRequest([
      wrEntry('1', { method: 'POST' }),
      wrEntry('2', { url: 'https://api.test/other' }),
      wrEntry('3', { frameId: 5 }),
      wrEntry('4', { startTime: T0 + WR_MATCH_WINDOW_MS + 1000 }),
    ]);
    expect(store.get('h:0:a1')?.wire).toBeUndefined();
    expect(ids(store).sort()).toEqual(['h:0:a1', 'w:1', 'w:2', 'w:3', 'w:4']);
  });

  it('links each webRequest event to a different hook entry', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart({ hookId: 'a', startTime: T0 }));
    store.handleHookStart(0, hookStart({ hookId: 'b', startTime: T0 + 100 }));
    store.upsertWebRequest([wrEntry('1', { startTime: T0 + 1 }), wrEntry('2', { startTime: T0 + 101 })]);
    expect(ids(store)).toEqual(['h:0:a', 'h:0:b']);
    expect(store.get('h:0:a')?.wire?.requestId).toBe('1');
    expect(store.get('h:0:b')?.wire?.requestId).toBe('2');
  });

  it('lists unmatched xhr events (e.g. worker fetches) and other resource kinds', () => {
    const { store } = setup();
    store.upsertWebRequest([
      wrEntry('7', { url: 'https://api.test/from-worker' }),
      wrEntry('8', { kind: 'script', url: 'https://cdn.test/app.js', wire: { requestId: '8', type: 'script' } }),
      wrEntry('9', { kind: 'document', url: PAGE, wire: { requestId: '9', type: 'main_frame' } }),
    ]);
    expect(ids(store).sort()).toEqual(['w:7', 'w:8', 'w:9']);
    expect(store.get('w:7')?.pageUrl).toBe(PAGE);
  });

  it('upserts idempotently and keeps identity of untouched entries', () => {
    const { store } = setup();
    const script = wrEntry('8', { kind: 'script', url: 'https://cdn.test/app.js', wire: { requestId: '8' } });
    const image = wrEntry('9', { kind: 'image', url: 'https://cdn.test/a.png', wire: { requestId: '9' } });
    store.upsertWebRequest([script, image]);
    store.upsertWebRequest([script]);
    expect(store.size).toBe(2);
    const imageBefore = store.get('w:9');
    store.upsertWebRequest([{ ...script, state: 'done', status: 200 }]);
    expect(store.size).toBe(2);
    expect(store.get('w:8')).toMatchObject({ state: 'done', status: 200 });
    expect(store.get('w:9')).toBe(imageBefore);
  });

  it('ignores snapshots that are not webRequest entries', () => {
    const { store } = setup();
    store.upsertWebRequest([{ ...wrEntry('1'), source: 'hook' }, { id: 'w:2' }, null, 'x']);
    store.upsertWebRequest('not a list');
    expect(store.size).toBe(0);
  });
});

describe('RequestStore: replay swallowing', () => {
  it("swallows the webRequest events of a registered page-mode replay, including later snapshots", () => {
    const { store } = setup();
    store.registerReplay({ runId: 'run-1', method: 'get', url: API, start: T0 });
    store.upsertWebRequest([wrEntry('50', { startTime: T0 + 5 })]);
    store.upsertWebRequest([wrEntry('50', { startTime: T0 + 5, state: 'done', status: 200 })]);
    expect(store.size).toBe(0);
  });

  it('swallows the CORS preflight of a replay', () => {
    const { store } = setup();
    store.registerReplay({ runId: 'run-1', method: 'PUT', url: API, start: T0 });
    store.upsertWebRequest([wrEntry('60', { method: 'OPTIONS', startTime: T0 + 1 })]);
    store.upsertWebRequest([wrEntry('61', { method: 'PUT', startTime: T0 + 20 })]);
    expect(store.size).toBe(0);
  });

  it('swallows a preflight reported after the main request (Chrome order), but not a second main request', () => {
    const { store } = setup();
    store.registerReplay({ runId: 'run-1', method: 'PUT', url: API, start: T0 });
    store.upsertWebRequest([wrEntry('62', { method: 'PUT', startTime: T0 + 2 })]);
    store.upsertWebRequest([wrEntry('63', { method: 'OPTIONS', startTime: T0 + 3 })]);
    store.upsertWebRequest([wrEntry('64', { method: 'PUT', startTime: T0 + 40 })]);
    expect(ids(store)).toEqual(['w:64']);
  });

  it('never swallows the page’s own identical request that started before the replay (its snapshot arrives late)', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart({ hookId: 'page', startTime: T0 - 150 }));
    store.handleHookEnd(0, hookEnd({ hookId: 'page', endTime: T0 - 130 }));
    store.registerReplay({ runId: 'run-1', method: 'GET', url: API, start: T0 });
    // The page request's webRequest batch arrives after the replay was dispatched...
    store.upsertWebRequest([wrEntry('page', { startTime: T0 - 148, state: 'done', status: 200 })]);
    // ...then the replay's own.
    store.upsertWebRequest([wrEntry('replay', { startTime: T0 + 3, state: 'done', status: 200 })]);
    expect(ids(store)).toEqual(['h:0:page']);
    expect(store.get('h:0:page')?.wire?.requestId).toBe('page');
  });

  it('consumes the registration: a later identical page request is listed', () => {
    const { store } = setup();
    store.registerReplay({ runId: 'run-1', method: 'GET', url: API, start: T0 });
    store.upsertWebRequest([wrEntry('50', { startTime: T0 + 5 })]);
    store.upsertWebRequest([wrEntry('51', { startTime: T0 + 30 })]);
    expect(ids(store)).toEqual(['w:51']);
  });

  it('does not swallow events of other requests or outside the time window', () => {
    const { store } = setup();
    store.registerReplay({ runId: 'run-1', method: 'GET', url: API, start: T0 });
    store.upsertWebRequest([
      wrEntry('1', { url: 'https://api.test/unrelated' }),
      wrEntry('2', { method: 'DELETE' }),
      wrEntry('3', { startTime: T0 + WR_MATCH_WINDOW_MS + 500 }),
      wrEntry('4', { kind: 'image', wire: { requestId: '4', type: 'image' } }),
    ]);
    expect(ids(store).sort()).toEqual(['w:1', 'w:2', 'w:3', 'w:4']);
  });

  it('stops swallowing once a completed replay is past its grace period', () => {
    const { store, advance } = setup();
    store.registerReplay({ runId: 'run-1', method: 'GET', url: API, start: T0 });
    store.completeReplay('run-1');
    advance(60_000);
    store.upsertWebRequest([wrEntry('70', { startTime: T0 + 60_000 })]);
    expect(ids(store)).toEqual(['w:70']);
  });
});

describe('RequestStore: eviction, clear, manual and restored entries', () => {
  it('evicts static resources first, then the oldest entries', () => {
    const { store } = setup({ maxEntries: 3 });
    store.handleHookStart(0, hookStart({ hookId: 'f1', startTime: T0, url: 'https://api.test/1' }));
    store.upsertWebRequest([
      wrEntry('img', { kind: 'image', startTime: T0 + 10, url: 'https://cdn.test/a.png', wire: { requestId: 'img' } }),
    ]);
    store.handleHookStart(0, hookStart({ hookId: 'f2', startTime: T0 + 20, url: 'https://api.test/2' }));
    store.handleHookStart(0, hookStart({ hookId: 'f3', startTime: T0 + 30, url: 'https://api.test/3' }));
    expect(ids(store)).toEqual(['h:0:f1', 'h:0:f2', 'h:0:f3']);
    store.handleHookStart(0, hookStart({ hookId: 'f4', startTime: T0 + 40, url: 'https://api.test/4' }));
    expect(ids(store)).toEqual(['h:0:f2', 'h:0:f3', 'h:0:f4']);
  });

  it('never resurrects evicted entries from late updates', () => {
    const { store } = setup({ maxEntries: 1 });
    store.upsertWebRequest([wrEntry('old', { kind: 'script', startTime: T0, url: 'https://cdn.test/a.js', wire: { requestId: 'old' } })]);
    store.handleHookStart(0, hookStart({ hookId: 'new', startTime: T0 + 10 }));
    expect(ids(store)).toEqual(['h:0:new']);
    store.upsertWebRequest([wrEntry('old', { kind: 'script', state: 'done', startTime: T0, url: 'https://cdn.test/a.js', wire: { requestId: 'old' } })]);
    expect(ids(store)).toEqual(['h:0:new']);
  });

  it('applies a lowered maxEntries on enforceLimit()', () => {
    const { store, limits } = setup();
    for (let i = 0; i < 5; i++) store.handleHookStart(0, hookStart({ hookId: `x${i}`, startTime: T0 + i, url: `https://api.test/${i}` }));
    limits.maxEntries = 2;
    expect(store.enforceLimit()).toBe(true);
    expect(ids(store)).toEqual(['h:0:x3', 'h:0:x4']);
    expect(store.enforceLimit()).toBe(false);
  });

  it('clears everything and drops late updates for cleared entries', () => {
    const { store, flush } = setup();
    store.handleHookStart(0, hookStart());
    store.upsertWebRequest([wrEntry('8', { kind: 'script', url: 'https://cdn.test/a.js', wire: { requestId: '8' } })]);
    store.handleHookEnd(0, hookEnd({ hookId: 'orphan' }));
    flush();
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    flush();
    expect(store.size).toBe(0);
    expect(store.getEntries()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.handleHookEnd(0, hookEnd());
    store.upsertWebRequest([wrEntry('8', { kind: 'script', state: 'done', url: 'https://cdn.test/a.js', wire: { requestId: '8' } })]);
    // The orphan end was dropped too: its start no longer resurrects a finished entry.
    store.handleHookStart(0, hookStart({ hookId: 'orphan' }));
    expect(ids(store)).toEqual(['h:0:orphan']);
    expect(store.get('h:0:orphan')?.state).toBe('pending');
  });

  it('does not notify when clearing an empty store', () => {
    const { store, schedule } = setup();
    store.clear();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('adds blank manual entries', () => {
    const { store } = setup();
    const blank = store.addManual();
    expect(blank).toMatchObject({ source: 'manual', kind: 'manual', method: 'GET', url: 'https://app.test/', state: 'done', frameId: 0 });
    expect(blank.id.startsWith('m:')).toBe(true);
    const custom = store.addManual({ method: 'POST', url: ' https://api.test/new ' });
    expect(custom).toMatchObject({ method: 'POST', url: 'https://api.test/new' });
    expect(store.get(blank.id)).toBe(blank);
    expect(blank.id).not.toBe(custom.id);
  });

  it('copies headers and a validated body into a manual entry (Duplicate as new request), not cut at the capture cap', () => {
    const { store } = setup({ requestBodyCap: 4 });
    const copy = store.addManual({
      method: 'PUT',
      url: 'https://api.test/x',
      headers: [{ name: 'X-A', value: '1' }, { name: 7, value: 'bad' } as never],
      body: { kind: 'text', text: 'abcdefgh', size: 8 },
      contentType: ' text/plain ',
    });
    expect(copy).toMatchObject({
      method: 'PUT',
      requestHeaders: [{ name: 'X-A', value: '1' }],
      requestBody: { kind: 'text', text: 'abcdefgh', size: 8 },
      requestContentType: 'text/plain',
    });
    const junk = store.addManual({ body: { kind: 'nope' } as never, contentType: 42 as never });
    expect(junk).toMatchObject({ requestBody: null, requestContentType: null, requestHeaders: [] });
  });

  it('takes a UI-chosen manual id when valid and free', () => {
    const { store } = setup();
    expect(store.addManual({ id: 'm:chosen1' }).id).toBe('m:chosen1');
    expect(store.addManual({ id: 'm:chosen1' }).id).not.toBe('m:chosen1');
    expect(store.addManual({ id: 'h:0:x' }).id.startsWith('m:')).toBe(true);
    expect(store.addManual({ id: 'm:bad id' }).id).not.toBe('m:bad id');
  });

  it('never evicts protected entries (selected, edited, with runs) or manual entries', () => {
    const { store } = setup({ maxEntries: 3 });
    store.handleHookStart(0, hookStart({ hookId: 'important', startTime: T0, url: 'https://api.test/important' }));
    const manual = store.addManual({ id: 'm:mine' });
    store.setProtected(['h:0:important']);
    for (let i = 0; i < 6; i++) store.handleHookStart(0, hookStart({ hookId: `poll${i}`, startTime: T0 + 10 + i, url: 'https://api.test/poll' }));
    expect(ids(store)).toContain('h:0:important');
    expect(ids(store)).toContain(manual.id);
    expect(store.size).toBe(3);
    store.setProtected([]);
    store.handleHookStart(0, hookStart({ hookId: 'poll9', startTime: T0 + 30, url: 'https://api.test/poll' }));
    expect(ids(store)).not.toContain('h:0:important');
    expect(ids(store)).toContain(manual.id);
  });

  it('settles pending webRequest entries when tracking stops (overlay closed)', () => {
    const { store, advance } = setup();
    store.upsertWebRequest([wrEntry('img', { kind: 'image', url: 'https://cdn.test/a.png', wire: { requestId: 'img' } })]);
    store.upsertWebRequest([wrEntry('done', { kind: 'image', state: 'done', url: 'https://cdn.test/b.png', wire: { requestId: 'done' } })]);
    store.handleHookStart(0, hookStart());
    advance(500);
    expect(store.settlePendingWebRequest('Not tracked while kineReqLens was closed')).toBe(1);
    expect(store.get('w:img')).toMatchObject({ state: 'aborted', error: 'Not tracked while kineReqLens was closed', endTime: T0 + 500 });
    expect(store.get('w:done')?.state).toBe('done');
    expect(store.get('h:0:a1')?.state).toBe('pending'); // hook entries still get their 'end'
    expect(store.settlePendingWebRequest('again')).toBe(0);
  });

  it('restores a preserved log once, marking unfinished entries as aborted', () => {
    const { store } = setup();
    const preserved: RequestEntry[] = [
      { ...wrEntry('1', { kind: 'document', url: 'https://app.test/old', state: 'done' }), id: 'r:w:1', restored: true },
      { ...wrEntry('2', { state: 'pending' }), id: 'w:2' },
    ];
    expect(store.addRestored(preserved)).toBe(2);
    expect(store.get('r:w:1')?.restored).toBe(true);
    expect(store.get('r:w:2')).toMatchObject({ restored: true, state: 'aborted' });
    expect(store.addRestored(preserved)).toBe(0);
    expect(store.addRestored([{ nope: true }, 'x'])).toBe(0);
    expect(store.size).toBe(2);
  });

  it('a restored hook capture replaces the worker’s restored copy of the same request', () => {
    const { store } = setup();
    // GET_TAB_STATE (preserve log on) hands the previous page's webRequest entry over as restored...
    store.upsertWebRequest([{ ...wrEntry('26', { state: 'done', status: 200 }), restored: true, pageUrl: 'https://app.test/old' }]);
    // ...and the preserved log has the page's own capture of it (merged with that webRequest entry).
    const hook: RequestEntry = { ...wrEntry('x'), id: 'r:h:0:a1', source: 'hook', kind: 'fetch', restored: true, wire: { requestId: '26' } };
    expect(store.addRestored([hook])).toBe(1);
    expect(ids(store)).toEqual(['r:h:0:a1']);
    // A later snapshot of the request merges into it instead of coming back as its own row.
    store.upsertWebRequest([{ ...wrEntry('26', { state: 'done', status: 201 }), restored: true }]);
    expect(ids(store)).toEqual(['r:h:0:a1']);
  });

  it('adopts the entries of a replaced instance with their identity', () => {
    const previous = setup();
    previous.store.handleHookStart(0, hookStart());
    const carried = previous.store.getEntries();
    const { store } = setup();
    store.adopt(carried);
    expect(store.getEntries()[0]).toBe(carried[0]);
    store.handleHookEnd(0, hookEnd());
    expect(store.get('h:0:a1')?.state).toBe('done');
  });
});

describe('RequestStore: ordering, identity and notifications', () => {
  it('returns entries oldest first and the same array until something changes', () => {
    const { store } = setup();
    store.handleHookStart(0, hookStart({ hookId: 'late', startTime: T0 + 50, url: 'https://api.test/late' }));
    store.handleHookStart(0, hookStart({ hookId: 'early', startTime: T0, url: 'https://api.test/early' }));
    store.upsertWebRequest([wrEntry('mid', { kind: 'image', startTime: T0 + 20, url: 'https://cdn.test/m.png', wire: { requestId: 'mid' } })]);
    const first = store.getEntries();
    expect(first.map((entry) => entry.id)).toEqual(['h:0:early', 'w:mid', 'h:0:late']);
    expect(store.getEntries()).toBe(first);
    store.handleHookEnd(0, hookEnd({ hookId: 'late' }));
    const second = store.getEntries();
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
  });

  it('does not change anything for ignored input', () => {
    const { store, schedule } = setup();
    store.handleHookStart(0, hookStart());
    const before = store.getEntries();
    schedule.mockClear();
    store.handleHookEnd(0, { hookId: 42 });
    store.upsertWebRequest([]);
    expect(store.getEntries()).toBe(before);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('coalesces notifications until the scheduled flush runs', () => {
    const { store, schedule, flush } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.handleHookStart(0, hookStart({ hookId: '1', url: 'https://api.test/1' }));
    store.handleHookStart(0, hookStart({ hookId: '2', url: 'https://api.test/2' }));
    store.upsertWebRequest([wrEntry('9', { kind: 'font', url: 'https://cdn.test/f.woff2', wire: { requestId: '9' } })]);
    store.handleHookEnd(0, hookEnd({ hookId: '1' }));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    flush();
    expect(listener).toHaveBeenCalledTimes(1);
    store.handleHookEnd(0, hookEnd({ hookId: '2' }));
    expect(schedule).toHaveBeenCalledTimes(2);
    flush();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates failing subscribers and supports unsubscribe', () => {
    const { store, flush } = setup();
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    const healthy = vi.fn();
    store.subscribe(failing);
    const unsubscribe = store.subscribe(healthy);
    store.handleHookStart(0, hookStart());
    flush();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.handleHookEnd(0, hookEnd());
    flush();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('stops accepting input and notifying after dispose', () => {
    const { store, flush } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.handleHookStart(0, hookStart());
    store.dispose();
    flush();
    store.handleHookStart(0, hookStart({ hookId: 'after' }));
    store.upsertWebRequest([wrEntry('1')]);
    expect(listener).not.toHaveBeenCalled();
    expect(store.get('h:0:after')).toBeUndefined();
    expect(store.get('w:1')).toBeUndefined();
  });
});
