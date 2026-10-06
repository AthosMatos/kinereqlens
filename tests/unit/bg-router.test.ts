import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Badge } from '../../src/background/badge';
import type { TabController } from '../../src/background/controller';
import type { ReplayRunner } from '../../src/background/replay';
import { asRuntimeRequest, createMessageRouter, isRelayableHookMessage, senderContext } from '../../src/background/router';
import type { RouterDeps } from '../../src/background/router';
import type { TabStore } from '../../src/background/tabs';
import type { WebRequestCollector } from '../../src/background/webrequest';
import type { TabMessage } from '../../src/shared/messages';
import type { ReplayRequest, RequestEntry, TabState } from '../../src/shared/types';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const TAB = 12;

function sender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return { id: EXT_ID, tab: { id: TAB } as chrome.tabs.Tab, frameId: 0, documentId: 'doc-1', url: 'https://app.example.com/', ...overrides };
}

const wrEntry = { id: 'w:1', source: 'webRequest', kind: 'script' } as RequestEntry;

function replayRequest(overrides: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    runId: 'run-1',
    entryId: 'h:0:1',
    mode: 'extension',
    frameId: 0,
    method: 'GET',
    url: 'https://api.example.com/x#hash',
    headers: [{ name: 'Bad Name', value: '1' }],
    body: { kind: 'none' },
    credentials: 'include',
    redirect: 'follow',
    timeoutMs: 1000,
    responseBodyCap: 1000,
    ...overrides,
  };
}

function harness(initial: Partial<TabState> = { open: true }) {
  let state: TabState = { open: false, recording: true, preserveLog: false, ...initial };
  const relayed: Array<[number, number, TabMessage]> = [];
  const calls = {
    attachDocument: vi.fn((_tabId: number, _doc: string, _options: unknown) => [wrEntry]),
    clearRestricted: vi.fn(),
    setCount: vi.fn(),
    clearBadge: vi.fn(),
    run: vi.fn(async (_tabId: number, req: ReplayRequest, invalid: string[]) => ({ runId: req.runId, ok: true, invalid, req })),
    abort: vi.fn(async () => true),
    setState: vi.fn(async (_tabId: number, patch: Partial<TabState>) => (state = { ...state, ...patch })),
    preserveRead: vi.fn(async (tabId: number) => [{ id: `r:log-of-${tabId}` }]),
    preserveWrite: vi.fn(async (_tabId: number, _entries: unknown) => true),
    preserveClear: vi.fn(async (_tabId: number) => true),
  };
  const deps: RouterDeps = {
    extensionId: EXT_ID,
    ready: Promise.resolve(),
    tabs: { get: () => ({ ...state }), isOpen: () => state.open, isLoaded: true } as unknown as TabStore,
    collector: { attachDocument: calls.attachDocument, getEntries: () => [wrEntry] } as unknown as WebRequestCollector,
    badge: { clearRestricted: calls.clearRestricted, setCount: calls.setCount, clear: calls.clearBadge } as unknown as Badge,
    replays: { run: calls.run, abort: calls.abort } as unknown as ReplayRunner,
    controller: { setState: calls.setState } as unknown as TabController,
    preserve: { read: calls.preserveRead, write: calls.preserveWrite, clear: calls.preserveClear },
    sendToFrame: async (tabId, frameId, message) => {
      relayed.push([tabId, frameId, message]);
    },
  };
  const listener = createMessageRouter(deps);
  /** Dispatch like chrome.runtime.onMessage and wait for the async answer. */
  const send = (message: unknown, from = sender()): Promise<{ handled: boolean; response: unknown }> =>
    new Promise((resolve) => {
      let handled = false;
      handled = listener(message, from, (response) => resolve({ handled, response }));
      if (!handled) resolve({ handled, response: undefined });
    });
  return { send, calls, relayed, getState: () => state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('senderContext', () => {
  it('accepts only this extension’s content scripts in a tab', () => {
    expect(senderContext(sender(), EXT_ID)).toEqual({ tabId: TAB, frameId: 0, documentId: 'doc-1', url: 'https://app.example.com/' });
    expect(senderContext(sender({ id: 'other' }), EXT_ID)).toBeNull();
    expect(senderContext(sender({ tab: undefined }), EXT_ID)).toBeNull();
    expect(senderContext(sender({ tab: { id: -1 } as chrome.tabs.Tab }), EXT_ID)).toBeNull();
    expect(senderContext(sender({ frameId: undefined }), EXT_ID)).toBeNull();
  });
});

describe('asRuntimeRequest / isRelayableHookMessage', () => {
  it('narrows known message types only', () => {
    expect(asRuntimeRequest({ type: 'GET_TAB_STATE' })).toEqual({ type: 'GET_TAB_STATE' });
    expect(asRuntimeRequest({ type: 'EVAL' })).toBeNull();
    expect(asRuntimeRequest('GET_TAB_STATE')).toBeNull();
    expect(asRuntimeRequest(null)).toBeNull();
  });

  it('relays only hook start/end messages', () => {
    expect(isRelayableHookMessage({ t: 'start', data: {} })).toBe(true);
    expect(isRelayableHookMessage({ t: 'end', data: {} })).toBe(true);
    expect(isRelayableHookMessage({ t: 'replay-result', data: {} })).toBe(false);
    expect(isRelayableHookMessage({ t: 'start' })).toBe(false);
  });

  it('relays WebSocket batches (validated again by the top frame)', () => {
    expect(isRelayableHookMessage({ t: 'ws', events: [] })).toBe(true);
    expect(isRelayableHookMessage({ t: 'ws', events: 'x' })).toBe(false);
    expect(isRelayableHookMessage({ t: 'ws-send-result', reqId: 1, ok: true })).toBe(false);
  });
});

describe('createMessageRouter', () => {
  it('ignores foreign senders and unknown messages without answering', async () => {
    const { send } = harness();
    expect(await send({ type: 'GET_TAB_STATE' }, sender({ id: 'evil' }))).toEqual({ handled: false, response: undefined });
    expect(await send({ type: 'GET_TAB_STATE' }, sender({ tab: undefined }))).toEqual({ handled: false, response: undefined });
    expect(await send({ type: 'NOPE' })).toEqual({ handled: false, response: undefined });
  });

  it('GET_TAB_STATE returns the buffer to top frames only', async () => {
    const { send, calls } = harness();
    expect((await send({ type: 'GET_TAB_STATE' })).response).toEqual({
      tabId: TAB,
      frameId: 0,
      tabState: { open: true, recording: true, preserveLog: false },
      entries: [wrEntry],
    });
    expect(calls.attachDocument).toHaveBeenCalledWith(TAB, 'doc-1', { url: 'https://app.example.com/', preserveLog: false });
    expect(calls.clearRestricted).toHaveBeenCalledWith(TAB);
    const sub = (await send({ type: 'GET_TAB_STATE' }, sender({ frameId: 4 }))).response;
    expect(sub).toMatchObject({ frameId: 4, entries: [] });
    // A prerendering main frame reports a non-zero frame id: it must not take over the tab's buffer.
    const prerender = (await send({ type: 'GET_TAB_STATE' }, sender({ frameId: 9, documentId: 'doc-2', documentLifecycle: 'prerender' } as Partial<chrome.runtime.MessageSender>))).response;
    expect(prerender).toMatchObject({ frameId: 9, entries: [] });
    expect(calls.attachDocument).toHaveBeenCalledTimes(1);
  });

  it('SET_TAB_STATE applies sanitized patches only', async () => {
    const { send, calls } = harness();
    expect((await send({ type: 'SET_TAB_STATE', patch: { recording: false, evil: 1 } })).response).toMatchObject({ recording: false });
    expect(calls.setState).toHaveBeenCalledWith(TAB, { recording: false });
    expect((await send({ type: 'SET_TAB_STATE', patch: { open: 'yes' } })).response).toMatchObject({ open: true });
    expect(calls.setState).toHaveBeenCalledTimes(1);
  });

  it('LOAD_UI injects ui.js into the requesting top document', async () => {
    const executeScript = vi.fn(async () => []);
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    const { send } = harness();
    expect((await send({ type: 'LOAD_UI' })).response).toEqual({ ok: true });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: TAB, documentIds: ['doc-1'] }, files: ['ui.js'], injectImmediately: true });
    expect((await send({ type: 'LOAD_UI' }, sender({ frameId: 2 }))).response).toMatchObject({ ok: false });
    executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    expect((await send({ type: 'LOAD_UI' })).response).toEqual({ ok: false, error: 'Cannot access contents of the page' });
  });

  it('FRAME_CAPTURE relays subframe hook messages to the top frame', async () => {
    const { send, relayed } = harness();
    const msg = { t: 'start', data: { hookId: '1' } };
    await send({ type: 'FRAME_CAPTURE', msg }, sender({ frameId: 7, url: 'https://ads.example/frame' }));
    expect(relayed).toEqual([[TAB, 0, { type: 'FRAME_CAPTURE_RELAY', frameId: 7, frameUrl: 'https://ads.example/frame', msg }]]);
    await send({ type: 'FRAME_CAPTURE', msg }); // from the top frame itself
    await send({ type: 'FRAME_CAPTURE', msg: { t: 'replay-result', data: {} } }, sender({ frameId: 7 }));
    expect(relayed).toHaveLength(1);
  });

  it('does not relay while the overlay is closed', async () => {
    const { send, relayed } = harness({ open: false });
    await send({ type: 'FRAME_CAPTURE', msg: { t: 'end', data: {} } }, sender({ frameId: 7 }));
    expect(relayed).toEqual([]);
  });

  it('REPLAY validates the payload and the sender before running', async () => {
    const { send, calls } = harness();
    const ok = (await send({ type: 'REPLAY', req: replayRequest() })).response as { invalid: string[]; req: ReplayRequest };
    expect(calls.run).toHaveBeenCalledTimes(1);
    expect(ok.req.url).toBe('https://api.example.com/x');
    expect(ok.req.headers).toEqual([]);
    expect(ok.invalid).toEqual(['Bad Name']);

    expect((await send({ type: 'REPLAY', req: replayRequest({ url: 'file:///etc/passwd' }) })).response).toMatchObject({
      ok: false,
      runId: 'run-1',
      error: expect.stringMatching(/http/),
    });
    expect((await send({ type: 'REPLAY', req: replayRequest() }, sender({ frameId: 3 }))).response).toMatchObject({ ok: false });
    expect((await send({ type: 'REPLAY', req: 'garbage' })).response).toMatchObject({ ok: false, runId: '' });
    expect(calls.run).toHaveBeenCalledTimes(1);
  });

  it('REPLAY requires the overlay to be open', async () => {
    const { send, calls } = harness({ open: false });
    expect((await send({ type: 'REPLAY', req: replayRequest() })).response).toMatchObject({ ok: false, error: expect.stringMatching(/Open the kineReqLens overlay/) });
    expect(calls.run).not.toHaveBeenCalled();
  });

  it('ABORT_REPLAY validates its fields', async () => {
    const { send, calls } = harness();
    expect((await send({ type: 'ABORT_REPLAY', runId: 'r', frameId: 0, mode: 'extension' })).response).toEqual({ ok: true });
    expect(calls.abort).toHaveBeenCalledWith(TAB, 'r', 0, 'extension');
    expect((await send({ type: 'ABORT_REPLAY', runId: 'r', frameId: -1, mode: 'page' })).response).toEqual({ ok: false });
    expect((await send({ type: 'ABORT_REPLAY', runId: 'r', frameId: 0, mode: 'other' })).response).toEqual({ ok: false });
  });

  it('SET_BADGE shows the count while open, from the top frame', async () => {
    const { send, calls } = harness();
    await send({ type: 'SET_BADGE', count: 42 });
    expect(calls.setCount).toHaveBeenCalledWith(TAB, 42);
    await send({ type: 'SET_BADGE', count: 1 }, sender({ frameId: 2 }));
    await send({ type: 'SET_BADGE', count: 'many' });
    expect(calls.setCount).toHaveBeenCalledTimes(1);
  });

  it('PRESERVE_* only ever touch the sender tab’s own log, from its top frame', async () => {
    const { send, calls } = harness();
    expect((await send({ type: 'PRESERVE_READ', tabId: 99 })).response).toEqual([{ id: `r:log-of-${TAB}` }]);
    expect(calls.preserveRead).toHaveBeenCalledWith(TAB);
    expect((await send({ type: 'PRESERVE_WRITE', entries: [{ id: 'r:1' }] })).response).toEqual({ ok: true });
    expect(calls.preserveWrite).toHaveBeenCalledWith(TAB, [{ id: 'r:1' }]);
    expect((await send({ type: 'PRESERVE_CLEAR' })).response).toEqual({ ok: true });
    expect(calls.preserveClear).toHaveBeenCalledWith(TAB);
    // Subframes (possibly another site) get nothing and change nothing.
    expect((await send({ type: 'PRESERVE_READ' }, sender({ frameId: 3 }))).response).toEqual([]);
    expect((await send({ type: 'PRESERVE_WRITE', entries: [] }, sender({ frameId: 3 }))).response).toEqual({ ok: false });
    expect((await send({ type: 'PRESERVE_CLEAR' }, sender({ frameId: 3 }))).response).toEqual({ ok: false });
    expect(calls.preserveRead).toHaveBeenCalledTimes(1);
    expect(calls.preserveWrite).toHaveBeenCalledTimes(1);
    expect(calls.preserveClear).toHaveBeenCalledTimes(1);
  });

  it('answers with a typed fallback when a handler fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { send, calls } = harness();
    calls.setState.mockRejectedValueOnce(new Error('storage down'));
    expect((await send({ type: 'SET_TAB_STATE', patch: { open: false } })).response).toEqual({ open: true, recording: true, preserveLog: false });
    calls.run.mockRejectedValueOnce(new Error('boom'));
    expect((await send({ type: 'REPLAY', req: replayRequest() })).response).toMatchObject({ ok: false, runId: 'run-1', error: 'boom' });
  });
});

describe('validPreservedLog', () => {
  it('accepts bounded arrays of restored entries only', async () => {
    const { validPreservedLog } = await import('../../src/background/preserve');
    expect(validPreservedLog([{ id: 'r:w:1' }])).toEqual([{ id: 'r:w:1' }]);
    expect(validPreservedLog([{ id: 'w:1' }])).toBeNull();
    expect(validPreservedLog('x')).toBeNull();
    expect(validPreservedLog([{ id: 'r:1', big: 'x'.repeat(100) }], 50)).toBeNull();
    expect(validPreservedLog(Array.from({ length: 301 }, (_, i) => ({ id: `r:${i}` })))).toBeNull();
  });
});
