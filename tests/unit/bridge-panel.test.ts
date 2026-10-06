import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import type { BridgeStatus } from '../../src/shared/claude-protocol';
import type { ReplayRequest, ReplayResult, ReqlensBridge, RequestEntry, Settings, TestRun } from '../../src/shared/types';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

let seq = 0;
function jsonEntry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  seq++;
  const text = '{"item":"book","qty":2}';
  return {
    id: `h:0:p${seq}`,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'POST',
    url: 'https://api.test/orders?x=1',
    requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    requestBody: { kind: 'text', text, size: text.length },
    requestContentType: 'application/json',
    startTime: 1000,
    state: 'done',
    ...overrides,
  };
}

function okResult(req: ReplayRequest, body = '{"ok":true}'): ReplayResult {
  return {
    runId: req.runId,
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: { kind: 'text', text: body, size: body.length },
    url: req.url,
    redirected: false,
    timing: { start: 1, end: 2 },
    size: body.length,
  };
}

interface FakeBridge extends ReqlensBridge {
  sent: ReplayRequest[];
  setSettings(patch: Partial<Settings>): void;
  resolveNext(result?: Partial<ReplayResult>): void;
}

function fakeBridge(entries: RequestEntry[], opts: { manual?: boolean; settings?: Partial<Settings> } = {}): FakeBridge {
  let settings = mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {});
  const settingsListeners = new Set<(s: Settings) => void>();
  const sent: ReplayRequest[] = [];
  const waiting: Array<() => void> = [];
  const bridge = {
    sent,
    getEntries: () => entries,
    getSettings: () => settings,
    subscribeSettings: (fn: (s: Settings) => void) => {
      settingsListeners.add(fn);
      return () => settingsListeners.delete(fn);
    },
    setSettings(patch: Partial<Settings>) {
      settings = mergeSettings(settings, patch);
      for (const fn of settingsListeners) fn(settings);
    },
    replay: vi.fn((req: ReplayRequest) => {
      sent.push(req);
      if (!opts.manual) return Promise.resolve(okResult(req));
      return new Promise<ReplayResult>((resolve) => waiting.push(() => resolve(okResult(req))));
    }),
    resolveNext() {
      waiting.shift()?.();
    },
    abortReplay: vi.fn(),
  };
  return bridge as unknown as FakeBridge;
}

// ------------------------------------------------------------------------------------------- draft store

describe('draft store: runForClaude', () => {
  it('runs the draft through the normal flow with origin "claude" and resolves when it finishes', async () => {
    const { runForClaude, getRecord, getEntryMeta } = await import('../../src/ui/detail/draftStore');
    const entry = jsonEntry();
    const bridge = fakeBridge([entry]);
    const run = await runForClaude(bridge, entry, DEFAULT_SETTINGS, {
      mode: 'extension',
      timeoutMs: 5000,
      adjust: (req) => ({ ...req, method: 'PUT', runId: 'ignored', entryId: 'ignored' }),
    });
    expect(run).toMatchObject({ origin: 'claude', state: 'done', entryId: entry.id });
    expect(run.result?.status).toBe(200);
    expect(bridge.sent[0]).toMatchObject({ method: 'PUT', mode: 'extension', timeoutMs: 5000, entryId: entry.id, credentials: 'include' });
    expect(bridge.sent[0]!.runId).toBe(run.runId);
    // In the history (marked) and the active run; the user's draft is untouched.
    const rec = getRecord(entry.id)!;
    expect(rec.runs[0]).toBe(run);
    expect(rec.activeRunId).toBe(run.runId);
    expect(rec.draft?.method).toBe('POST');
    expect(getEntryMeta(entry.id)).toMatchObject({ modified: false, runs: 1 });
  });

  it('resolves a Claude run even when it was pruned before finishing', async () => {
    const { runForClaude, pruneDrafts } = await import('../../src/ui/detail/draftStore');
    const entry = jsonEntry();
    const bridge = fakeBridge([entry], { manual: true });
    const pending = runForClaude(bridge, entry, DEFAULT_SETTINGS);
    pruneDrafts(new Set());
    expect(bridge.abortReplay).toHaveBeenCalled();
    bridge.resolveNext();
    await expect(pending).resolves.toMatchObject({ entryId: entry.id, state: 'done' });
  });

  it('rejects when the raw body does not parse', async () => {
    const { runForClaude, ensureRecord, setBodyView, applyRawText } = await import('../../src/ui/detail/draftStore');
    const entry = jsonEntry();
    ensureRecord(entry);
    setBodyView(entry.id, 'raw');
    applyRawText(entry.id, '{"item":');
    await expect(runForClaude(fakeBridge([entry]), entry, DEFAULT_SETTINGS)).rejects.toThrow(/raw body does not parse/);
  });
});

// ------------------------------------------------------------------------------------------- claudeLink

class FakeRuntimePort {
  posted: Array<Record<string, unknown>> = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  constructor(public name: string) {}
  postMessage(m: unknown) {
    if (this.disconnected) throw new Error('disconnected');
    this.posted.push(m as Record<string, unknown>);
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(m: unknown) {
    for (const fn of this.messageListeners) fn(m);
  }
  close() {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) fn();
  }
  last() {
    return this.posted[this.posted.length - 1];
  }
}

function stubChrome(opts: { granted?: boolean; requestThrows?: boolean } = {}) {
  const ports: FakeRuntimePort[] = [];
  let granted = opts.granted ?? false;
  const stub = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      connect: vi.fn(({ name }: { name: string }) => {
        const port = new FakeRuntimePort(name);
        ports.push(port);
        return port;
      }),
    },
    permissions: {
      contains: vi.fn(async () => granted),
      request: vi.fn(() => {
        if (opts.requestThrows) throw new Error('Only permissions specified in the manifest may be requested.');
        granted = true;
        return Promise.resolve(true);
      }),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
  };
  vi.stubGlobal('chrome', stub);
  return { stub, ports, port: () => ports[ports.length - 1]! };
}

const connectedStatus: BridgeStatus = {
  enabled: true,
  permission: true,
  host: 'connected',
  sessions: [{ id: 's1', label: 'shop', cwd: '/w/shop', pid: 1, connectedAt: 1 }],
  extensionId: EXT_ID,
};

async function freshLink() {
  vi.resetModules();
  const link = await import('../../src/ui/panel/claudeLink');
  const store = await import('../../src/ui/detail/draftStore');
  const shell = await import('../../src/ui/shellState');
  return { link, store, shell };
}

describe('claudeLink', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts off with the extension id and only connects while the bridge is enabled', async () => {
    const env = stubChrome({ granted: true });
    const { link } = await freshLink();
    const bridge = fakeBridge([]);
    link.startClaudeLink(4, bridge);
    expect(env.stub.runtime.connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(link.getBridgeStatus()).toEqual({ enabled: false, permission: true, host: 'off', sessions: [], extensionId: EXT_ID }));
    bridge.setSettings({ claudeBridge: true });
    expect(env.ports).toHaveLength(1);
    expect(env.port().name).toBe('reqlens-claude-link');
    expect(env.port().posted[0]).toEqual({ t: 'hello', v: 1, tabId: 4 });
    // startClaudeLink is idempotent.
    link.startClaudeLink(4, bridge);
    expect(env.ports).toHaveLength(1);
  });

  it('mirrors the pushed status and notifies subscribers; ignores malformed ones', async () => {
    const env = stubChrome({ granted: true });
    const { link } = await freshLink();
    const bridge = fakeBridge([], { settings: { claudeBridge: true } });
    link.startClaudeLink(4, bridge);
    const seen: BridgeStatus[] = [];
    link.subscribeBridgeStatus((s) => seen.push(s));
    env.port().receive({ t: 'status', status: connectedStatus });
    expect(link.getBridgeStatus()).toEqual(connectedStatus);
    expect(seen).toEqual([connectedStatus]);
    env.port().receive({ t: 'status', status: { host: 'nope' } });
    expect(link.getBridgeStatus()).toEqual(connectedStatus);
    expect(link.isBridgeStatus(connectedStatus)).toBe(true);
  });

  it('reconnects with backoff after the worker goes away, and disconnects when disabled', async () => {
    const env = stubChrome({ granted: true });
    const { link } = await freshLink();
    const bridge = fakeBridge([], { settings: { claudeBridge: true } });
    link.startClaudeLink(4, bridge);
    env.port().receive({ t: 'status', status: connectedStatus });
    env.port().close();
    expect(link.getBridgeStatus()).toMatchObject({ host: 'connecting', sessions: [] });
    vi.advanceTimersByTime(499);
    expect(env.ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(env.ports).toHaveLength(2);
    env.port().close();
    vi.advanceTimersByTime(999);
    expect(env.ports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(env.ports).toHaveLength(3);
    bridge.setSettings({ claudeBridge: false });
    expect(env.port().disconnected).toBe(true);
    expect(link.getBridgeStatus()).toMatchObject({ enabled: false, host: 'off' });
    vi.advanceTimersByTime(60_000);
    expect(env.ports).toHaveLength(3);
  });

  it('answers state and entry queries from the draft store and the selection', async () => {
    const env = stubChrome({ granted: true });
    const { link, store, shell } = await freshLink();
    const entry = jsonEntry();
    const bridge = fakeBridge([entry], { settings: { claudeBridge: true } });
    link.startClaudeLink(4, bridge);
    store.ensureRecord(entry);
    store.updateDraft(entry.id, (d) => ({ ...d, method: 'PATCH' }));
    shell.setShellSelection(entry.id);
    env.port().receive({ t: 'query', id: 1, query: { kind: 'state' } });
    env.port().receive({ t: 'query', id: 2, query: { kind: 'entry', entryId: entry.id } });
    env.port().receive({ t: 'query', id: 3, query: { kind: 'entry', entryId: 'unknown' } });
    await vi.waitFor(() => expect(env.port().posted.filter((m) => m.t === 'res')).toHaveLength(3));
    const res = Object.fromEntries(env.port().posted.filter((m) => m.t === 'res').map((m) => [m.id, m]));
    expect(res[1]).toEqual({ t: 'res', id: 1, ok: true, result: { selectedId: entry.id, work: [{ id: entry.id, modified: true, runs: 0 }] } });
    expect(res[2]).toMatchObject({ ok: true, result: { draft: { method: 'PATCH', entryId: entry.id }, runs: [] } });
    expect(res[3]).toEqual({ t: 'res', id: 3, ok: true, result: { draft: null, runs: [] } });
  });

  it('runs a send query through the draft store with the overrides and toasts it', async () => {
    const env = stubChrome({ granted: true });
    const { link, store } = await freshLink();
    const toast = await import('../../src/ui/components/toast');
    const spy = vi.spyOn(toast, 'toast');
    const entry = jsonEntry();
    const bridge = fakeBridge([entry], { settings: { claudeBridge: true } });
    link.startClaudeLink(4, bridge);
    env.port().receive({
      t: 'query',
      id: 7,
      query: { kind: 'send', entryId: entry.id, overrides: { method: 'PUT', query: [['y', '2']] }, mode: 'extension', timeoutMs: 4000 },
    });
    await vi.waitFor(() => expect(env.port().posted.find((m) => m.t === 'res')).toBeDefined());
    const res = env.port().posted.find((m) => m.t === 'res') as { ok: boolean; result: { run: TestRun } };
    expect(res.ok).toBe(true);
    expect(res.result.run).toMatchObject({ origin: 'claude', state: 'done' });
    expect(bridge.sent[0]).toMatchObject({ method: 'PUT', url: 'https://api.test/orders?y=2', mode: 'extension', timeoutMs: 4000 });
    expect(store.getRecord(entry.id)?.runs[0]?.origin).toBe('claude');
    expect(spy).toHaveBeenCalledWith('Claude sent PUT /orders?y=2', 'info');
  });

  it('refuses a send for an unknown entry or a draft with blocking errors', async () => {
    const env = stubChrome({ granted: true });
    const { link, store } = await freshLink();
    const entry = jsonEntry();
    const bridge = fakeBridge([entry], { settings: { claudeBridge: true } });
    link.startClaudeLink(4, bridge);
    env.port().receive({ t: 'query', id: 1, query: { kind: 'send', entryId: 'nope', timeoutMs: 1000 } });
    store.ensureRecord(entry);
    store.updateDraft(entry.id, (d) => (d.body.type === 'json' ? { ...d, body: { ...d.body, tree: { ...d.body.tree, children: d.body.tree.children!.map((c) => (c.key === 'qty' ? { ...c, value: '12abc' } : c)) } } } : d));
    env.port().receive({ t: 'query', id: 2, query: { kind: 'send', entryId: entry.id, timeoutMs: 1000 } });
    await vi.waitFor(() => expect(env.port().posted.filter((m) => m.t === 'res')).toHaveLength(2));
    const res = Object.fromEntries(env.port().posted.filter((m) => m.t === 'res').map((m) => [m.id, m]));
    expect(res[1]).toMatchObject({ ok: false, error: expect.stringContaining('No request with id "nope"') });
    expect(res[2]).toMatchObject({ ok: false, error: expect.stringContaining('error(s) that block sending') });
    expect(bridge.sent).toHaveLength(0);
  });

  it('sendToClaude explains why it cannot send, and resolves with the worker answer', async () => {
    const env = stubChrome({ granted: true });
    const { link } = await freshLink();
    const bridge = fakeBridge([]);
    link.startClaudeLink(4, bridge);
    const item = { entryId: 'h:0:1', title: 'POST /x', target: 'client' as const, prompt: '# P' };
    await expect(link.sendToClaude(item)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('off') });
    bridge.setSettings({ claudeBridge: true });
    env.port().receive({ t: 'status', status: { ...connectedStatus, sessions: [] } });
    await expect(link.sendToClaude(item)).resolves.toMatchObject({ ok: false, error: expect.stringContaining('No Claude Code session') });
    env.port().receive({ t: 'status', status: connectedStatus });
    const pending = link.sendToClaude({ ...item, sessionId: 's1' });
    const push = env.port().last()!;
    expect(push).toMatchObject({ t: 'push', item: { ...item, sessionId: 's1' } });
    env.port().receive({ t: 'push-result', id: push.id, ok: true, delivered: 1 });
    await expect(pending).resolves.toEqual({ ok: true, delivered: 1 });
    const lost = link.sendToClaude(item);
    env.port().close();
    await expect(lost).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Lost the connection') });
  });

  it('requests the permission, falling back to contains() when it cannot be requested', async () => {
    let env = stubChrome({ granted: false });
    let mod = await freshLink();
    await expect(mod.link.requestBridgePermission()).resolves.toBe(true);
    expect(env.stub.permissions.request).toHaveBeenCalledWith({ permissions: ['nativeMessaging'] });
    expect(mod.link.getBridgeStatus().permission).toBe(true);
    vi.unstubAllGlobals();
    env = stubChrome({ granted: true, requestThrows: true });
    mod = await freshLink();
    await expect(mod.link.requestBridgePermission()).resolves.toBe(true);
    expect(env.stub.permissions.contains).toHaveBeenCalled();
  });

  it('clips runs handed to the worker', async () => {
    stubChrome();
    const { link } = await freshLink();
    const base: TestRun = {
      runId: 'r',
      entryId: 'e',
      startedAt: 1,
      state: 'done',
      request: {
        runId: 'r',
        entryId: 'e',
        mode: 'page',
        frameId: 0,
        method: 'POST',
        url: 'https://a.test/',
        headers: [],
        body: { kind: 'text', text: 'x'.repeat(100_000) },
        credentials: 'include',
        redirect: 'follow',
        timeoutMs: 1,
        responseBodyCap: 1,
      },
      result: okResult({ runId: 'r', url: 'https://a.test/' } as ReplayRequest, 'y'.repeat(3_000_000)),
    };
    const [first, second] = link.clipRunsForLink([base, base], 2_500_000);
    expect(first!.request.body).toEqual({ kind: 'none' });
    expect(first!.result!.body).toMatchObject({ kind: 'text', truncated: true });
    expect((first!.result!.body as { text: string }).text.length).toBe(2_000_000);
    expect((second!.result!.body as { text: string }).text.length).toBe(500_000);
    const [, third] = link.clipRunsForLink([base, base], 2_000_000);
    expect(third!.result!.body).toMatchObject({ kind: 'unavailable' });
    const small = { ...base, request: { ...base.request, body: { kind: 'none' as const } }, result: undefined };
    expect(link.clipRunsForLink([small])[0]).toBe(small);
  });
});
