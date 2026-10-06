import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRequestCollector, WR_FLUSH_DELAY_MS, WR_NAV_HOLD_MS, WR_NAV_SETTLE_MS } from '../../src/background/webrequest';
import type { FlushTarget } from '../../src/background/webrequest';
import type { RequestEntry } from '../../src/shared/types';

// While src/lib/capture.ts (owned by lib-body) is still a stub, the helpers the collector calls fall back
// to minimal stand-ins of its documented contract; once implemented, the real functions are used.
const { captureWithFallback } = vi.hoisted(() => {
  type Capture = typeof import('../../src/lib/capture');
  const reference: Partial<Capture> = {
    mapResourceType: (type) => (type === 'xmlhttprequest' ? 'xhr' : type === 'main_frame' ? 'document' : 'other'),
    webRequestHeadersToPairs: (headers) => (headers ?? []).map(({ name, value }) => ({ name, value: value ?? '' })),
    webRequestBodyToSerialized: (body) => (body ? { kind: 'unavailable', reason: 'stand-in' } : null),
  };
  function captureWithFallback(actual: Capture): Capture {
    const wrapped: Record<string, unknown> = { ...actual };
    for (const [name, stand] of Object.entries(reference) as Array<[keyof Capture, (...args: unknown[]) => unknown]>) {
      const real = actual[name] as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]) => {
        try {
          return real(...args);
        } catch (err) {
          if (err instanceof Error && err.message === 'not implemented') return stand(...args);
          throw err;
        }
      };
    }
    return wrapped as Capture;
  }
  return { captureWithFallback };
});
vi.mock('../../src/lib/capture', async (importOriginal) => captureWithFallback(await importOriginal()));

const TAB = 7;

interface Harness {
  collector: WebRequestCollector;
  sent: RequestEntry[][];
  /** Target document of each batch in `sent` ('' = the tab's top frame). */
  targets: string[];
  state: { recording: boolean; open: boolean };
}

function harness(options: { maxEntries?: number; send?: (entries: RequestEntry[], target: FlushTarget) => Promise<void> } = {}): Harness {
  // (ignoreUrl: the overlay's own panel frame is never listed.)
  const sent: RequestEntry[][] = [];
  const targets: string[] = [];
  const state = { recording: true, open: true };
  const collector = new WebRequestCollector({
    shouldCreate: (tabId) => tabId === TAB && state.open && state.recording,
    shouldTrack: (tabId) => tabId === TAB && state.open,
    bodyCap: () => 1024,
    send: async (_tabId, entries, target) => {
      sent.push(entries);
      targets.push(target.documentId ?? '');
      await options.send?.(entries, target);
    },
    maxEntries: options.maxEntries,
    ignoreUrl: (url) => url.startsWith('chrome-extension://reqlens/'),
  });
  return { collector, sent, targets, state };
}

/** Details of a request made by top document `doc` (or a navigation / subframe request with overrides). */
function docDetails(doc: string, overrides: Record<string, unknown> = {}) {
  return details({ documentId: doc, parentFrameId: -1, documentLifecycle: 'active', ...overrides });
}

function navDetails(overrides: Record<string, unknown> = {}) {
  return details({ type: 'main_frame', parentFrameId: -1, url: 'https://example.com/next', ...overrides });
}

const ids = (batch: RequestEntry[] | undefined) => (batch ?? []).map((e) => e.id);

let seq = 0;
function details(overrides: Record<string, unknown> = {}) {
  return {
    requestId: String(++seq),
    url: 'https://example.com/api',
    method: 'GET',
    frameId: 0,
    tabId: TAB,
    type: 'xmlhttprequest',
    timeStamp: Date.now(),
    ...overrides,
  };
}

const status = { statusCode: 200, statusLine: 'HTTP/1.1 200 OK' };

beforeEach(() => {
  vi.useFakeTimers();
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WebRequestCollector', () => {
  it('creates entries for recording tabs and ignores other tabs, tabId -1 and prerendering', () => {
    const { collector } = harness();
    collector.onBeforeRequest(details({ requestId: 'a' }));
    collector.onBeforeRequest(details({ requestId: 'b', tabId: 99 }));
    collector.onBeforeRequest(details({ requestId: 'c', tabId: -1 }));
    collector.onBeforeRequest(details({ requestId: 'd', documentLifecycle: 'prerender' }));
    expect(collector.getEntries(TAB).map((e) => e.id)).toEqual(['w:a']);
    expect(collector.getEntries(99)).toEqual([]);
  });

  it('never lists the overlay’s own panel frame', () => {
    const { collector } = harness();
    collector.onBeforeRequest(details({ requestId: 'panel', type: 'sub_frame', frameId: 9, url: 'chrome-extension://reqlens/panel.html#nonce' }));
    expect(collector.getEntries(TAB)).toEqual([]);
  });

  it('batches every change of a 150 ms window into one WR_ENTRIES with the latest snapshots', async () => {
    const { collector, sent } = harness();
    const d = details({ requestId: 'x' });
    collector.onBeforeRequest(d);
    collector.onSendHeaders({ ...d, requestHeaders: [{ name: 'Accept', value: '*/*' }] });
    collector.onHeadersReceived({ ...d, ...status, responseHeaders: [] });
    collector.onCompleted({ ...d, ...status, fromCache: false });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ id: 'w:x', state: 'done', status: 200, requestHeaders: [{ name: 'Accept', value: '*/*' }] });
  });

  it('ignores late events for requests it never saw', async () => {
    const { collector, sent } = harness();
    collector.onHeadersReceived({ ...details(), ...status });
    collector.onCompleted({ ...details(), ...status });
    collector.onErrorOccurred({ ...details(), error: 'net::ERR_FAILED' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
    expect(collector.getEntries(TAB)).toEqual([]);
  });

  it('creates from onSendHeaders when onBeforeRequest was missed', () => {
    const { collector } = harness();
    collector.onSendHeaders({ ...details({ requestId: 's' }), requestHeaders: [{ name: 'A', value: '1' }] });
    expect(collector.getEntries(TAB)[0]).toMatchObject({ id: 'w:s', requestHeaders: [{ name: 'A', value: '1' }] });
  });

  it('keeps completing known requests while paused but creates no new ones', async () => {
    const { collector, sent, state } = harness();
    const d = details({ requestId: 'p' });
    collector.onBeforeRequest(d);
    state.recording = false;
    collector.onBeforeRequest(details({ requestId: 'new' }));
    collector.onCompleted({ ...d, ...status });
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(collector.getEntries(TAB).map((e) => [e.id, e.state])).toEqual([['w:p', 'done']]);
    expect(sent.flat().map((e) => e.id)).toEqual(['w:p']);
  });

  it('stops tracking when the overlay is closed', () => {
    const { collector, state } = harness();
    const d = details({ requestId: 'q' });
    collector.onBeforeRequest(d);
    state.open = false;
    collector.onCompleted({ ...d, ...status });
    expect(collector.getEntries(TAB)[0].state).toBe('pending');
  });

  it('holds a navigation until its document attaches; that document gets it, the old one does not', async () => {
    const { collector, sent, targets } = harness();
    collector.attachDocument(TAB, 'A', { url: 'https://example.com/a' });
    collector.onBeforeRequest(docDetails('A', { requestId: 'old' }));
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(sent.map(ids)).toEqual([['w:old']]);
    expect(targets).toEqual(['A']);

    collector.onBeforeRequest(navDetails({ requestId: 'nav' }));
    collector.onBeforeRequest(docDetails('B', { requestId: 'sub', type: 'script' }));
    await vi.advanceTimersByTimeAsync(2000);
    // The new document's script is addressed to B only; the navigation itself is held.
    expect(sent.map(ids)).toEqual([['w:old'], ['w:sub']]);
    expect(targets).toEqual(['A', 'B']);

    expect(collector.attachDocument(TAB, 'B', { url: 'https://example.com/next' }).map((e) => e.id)).toEqual(['w:nav', 'w:sub']);
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(collector.getEntries(TAB).map((e) => e.id)).toEqual(['w:nav', 'w:sub']); // A's entries are gone
  });

  it('keeps tracking and delivering the current document while a navigation is pending (download / 204)', async () => {
    const { collector, sent, targets } = harness();
    collector.attachDocument(TAB, 'A');
    const img = docDetails('A', { requestId: 'img', type: 'image' });
    collector.onBeforeRequest(img);
    const nav = navDetails({ requestId: 'download' });
    collector.onBeforeRequest(nav);
    collector.onBeforeRequest(docDetails('A', { requestId: 'late', type: 'image' }));
    collector.onCompleted({ ...img, ...status });
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(sent.flat().map((e) => [e.id, e.state])).toEqual([
      ['w:img', 'done'],
      ['w:late', 'pending'],
    ]);
    expect(targets).toEqual(['A']);

    // The navigation turned into a download: it settles and no new document attaches.
    collector.onErrorOccurred({ ...nav, error: 'net::ERR_ABORTED' });
    await vi.advanceTimersByTimeAsync(WR_NAV_SETTLE_MS + WR_FLUSH_DELAY_MS);
    expect(sent.at(-1)?.map((e) => [e.id, e.state])).toEqual([['w:download', 'aborted']]);
    expect(targets.at(-1)).toBe('A');
    // Later requests of the page are delivered right away (no hold).
    collector.onBeforeRequest(docDetails('A', { requestId: 'after', type: 'image' }));
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(ids(sent.at(-1))).toEqual(['w:after']);
  });

  it('hands a navigation that stays pending to the current document after WR_NAV_HOLD_MS', async () => {
    const { collector, sent } = harness();
    collector.attachDocument(TAB, 'A');
    collector.onBeforeRequest(navDetails({ requestId: 'nav' }));
    await vi.advanceTimersByTimeAsync(WR_NAV_HOLD_MS - 10);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS + 20);
    expect(sent.map(ids)).toEqual([['w:nav']]);
  });

  it('never hands the previous page’s late requests (unload beacons) to the next page', async () => {
    const { collector, sent, targets } = harness();
    collector.attachDocument(TAB, 'A', { url: 'https://example.com/a' });
    collector.onBeforeRequest(navDetails({ requestId: 'nav' }));
    // pagehide beacon of A after the navigation started (and after the new document committed)
    const beacon = docDetails('A', { requestId: 'beacon', type: 'ping', method: 'POST', documentLifecycle: 'pending_deletion' });
    collector.onBeforeRequest(beacon);
    expect(collector.attachDocument(TAB, 'B').map((e) => e.id)).toEqual(['w:nav']);
    const late = docDetails('A', { requestId: 'keepalive', documentLifecycle: 'pending_deletion' });
    collector.onBeforeRequest(late);
    collector.onCompleted({ ...beacon, ...status });
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS * 2);
    // Only the navigation reaches B; A's late requests are addressed to (retired) A only, i.e. dropped.
    expect(sent.map(ids)).toEqual([['w:nav']]);
    expect(targets).toEqual(['B']);
    expect(collector.attachDocument(TAB, 'B').map((e) => e.id)).toEqual(['w:nav']);
  });

  it('with preserve log, hands the previous page’s late requests over as restored entries of that page', async () => {
    const { collector } = harness();
    collector.attachDocument(TAB, 'A', { url: 'https://example.com/a' });
    collector.onBeforeRequest(navDetails({ requestId: 'nav' }));
    collector.onBeforeRequest(docDetails('A', { requestId: 'beacon', type: 'ping', method: 'POST' }));
    const entries = collector.attachDocument(TAB, 'B', { url: 'https://example.com/next', preserveLog: true });
    expect(entries.map((e) => [e.id, e.restored ?? false, e.pageUrl])).toEqual([
      ['w:nav', false, ''],
      ['w:beacon', true, 'https://example.com/a'],
    ]);
    // A beacon of A that only starts after B attached is handed over the same way.
    collector.onBeforeRequest(docDetails('A', { requestId: 'late', type: 'ping', method: 'POST', documentLifecycle: 'pending_deletion' }));
    expect(collector.attachDocument(TAB, 'B', { preserveLog: true }).find((e) => e.id === 'w:late')).toMatchObject({
      restored: true,
      pageUrl: 'https://example.com/a',
    });
  });

  it('redacts the credentials of entries handed over from a previous page', () => {
    const { collector } = harness();
    collector.attachDocument(TAB, 'A', { url: 'https://example.com/a' });
    const img = docDetails('A', { requestId: 'img', type: 'image' });
    collector.onSendHeaders({ ...img, requestHeaders: [{ name: 'Cookie', value: 'sid=SECRET' }] });
    const [handed] = collector.attachDocument(TAB, 'B', { preserveLog: true });
    expect(JSON.stringify(handed)).not.toContain('SECRET');
    collector.onHeadersReceived({ ...img, ...status, responseHeaders: [{ name: 'Set-Cookie', value: 'sid=SECRET2' }] });
    expect(JSON.stringify(collector.getEntries(TAB))).not.toMatch(/SECRET/);
  });

  it('attributes subframe requests to their top document', async () => {
    const { collector, targets } = harness();
    collector.attachDocument(TAB, 'A');
    collector.onBeforeRequest(details({ requestId: 'frame', type: 'sub_frame', frameId: 3, parentFrameId: 0, parentDocumentId: 'A' }));
    collector.onBeforeRequest(details({ requestId: 'inner', frameId: 3, parentFrameId: 0, documentId: 'F', parentDocumentId: 'A' }));
    // nested frame of F
    collector.onBeforeRequest(details({ requestId: 'deep', frameId: 5, parentFrameId: 3, documentId: 'G', parentDocumentId: 'F' }));
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(targets).toEqual(['A']);
    expect(collector.attachDocument(TAB, 'A').map((e) => e.id)).toEqual(['w:frame', 'w:inner', 'w:deep']);
  });

  it('serializes flushes so a slow top frame never receives an older snapshot after a newer one', async () => {
    const delivered = new Map<string, RequestEntry>();
    const { collector } = harness({
      send: async (entries) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        for (const e of entries) delivered.set(e.id, e);
      },
    });
    const all = Array.from({ length: 450 }, (_, i) => details({ requestId: String(i), type: 'image' }));
    for (const d of all) collector.onBeforeRequest(d);
    await vi.advanceTimersByTimeAsync(200);
    for (const d of all.slice(400)) {
      collector.onHeadersReceived({ ...d, ...status, responseHeaders: [] });
      collector.onCompleted({ ...d, ...status });
    }
    await vi.advanceTimersByTimeAsync(3000);
    const stale = collector
      .getEntries(TAB)
      .filter((e) => delivered.get(e.id)?.state !== e.state)
      .map((e) => e.id);
    expect(stale).toEqual([]);
    expect(delivered.get('w:449')?.state).toBe('done');
  });

  it('keeps one entry across redirect hops of a navigation', () => {
    const { collector } = harness();
    const nav = details({ requestId: 'nav', type: 'main_frame' });
    collector.onBeforeRequest(nav);
    collector.onBeforeRedirect({ ...nav, ...status, statusCode: 301, redirectUrl: 'https://example.com/b' });
    collector.onBeforeRequest({ ...nav, url: 'https://example.com/b' });
    collector.onBeforeRequest(details({ requestId: 'frame', type: 'sub_frame', frameId: 3 }));
    expect(collector.getEntries(TAB).map((e) => e.id)).toEqual(['w:nav', 'w:frame']);
    expect(collector.getEntries(TAB)[0]).toMatchObject({ url: 'https://example.com/api', redirected: true });
  });

  it('evicts settled entries first beyond the buffer capacity', () => {
    const { collector } = harness({ maxEntries: 3 });
    const a = details({ requestId: 'a' });
    collector.onBeforeRequest(a); // stays pending
    const b = details({ requestId: 'b' });
    collector.onBeforeRequest(b);
    collector.onCompleted({ ...b, ...status });
    collector.onBeforeRequest(details({ requestId: 'c' }));
    collector.onBeforeRequest(details({ requestId: 'd' }));
    expect(collector.getEntries(TAB).map((e) => e.id)).toEqual(['w:a', 'w:c', 'w:d']);
  });

  it('splits large flushes into several messages', async () => {
    const { collector, sent } = harness();
    for (let i = 0; i < 450; i++) collector.onBeforeRequest(details());
    await vi.advanceTimersByTimeAsync(WR_FLUSH_DELAY_MS);
    expect(sent.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it('dropTab forgets the tab and cancels its pending flush', async () => {
    const { collector, sent } = harness();
    collector.onBeforeRequest(details());
    collector.dropTab(TAB);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(0);
    expect(collector.getEntries(TAB)).toEqual([]);
  });
});
