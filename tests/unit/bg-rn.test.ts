// Worker side of React Native support (src/background/rn/**): hub message validation, chunk reassembly, the
// RnBridge's config / status / capture buffering / port routing / replay routing.
import { describe, expect, it, vi } from 'vitest';
import { RnBridge, isOwnPage } from '../../src/background/rn';
import type { RnBridgeDeps, RnPort } from '../../src/background/rn';
import { ChunkAssembler, parseRnHostMessage } from '../../src/background/rn/messages';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import type { RnExtensionToHost, RnStatus } from '../../src/shared/rn-protocol';
import type { ReplayRequest, ReplayResult, Settings } from '../../src/shared/types';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';

class FakePort implements RnPort {
  sent: unknown[] = [];
  disconnected = false;
  private messageFns: Array<(m: unknown) => void> = [];
  private disconnectFns: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageFns.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectFns.push(fn) };
  constructor(
    readonly name: string,
    readonly sender: chrome.runtime.MessageSender,
  ) {}
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  receive(message: unknown): void {
    for (const fn of this.messageFns) fn(message);
  }
  close(): void {
    for (const fn of this.disconnectFns) fn();
  }
  of(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => (m as { t: string }).t === t) as Array<Record<string, unknown>>;
  }
}

function standalonePort(tabId = 42): FakePort {
  return new FakePort('reqlens-standalone', { id: EXT, url: `chrome-extension://${EXT}/app.html#session=s1`, tab: { id: tabId } as chrome.tabs.Tab });
}

interface Harness {
  bridge: RnBridge;
  posted: RnExtensionToHost[];
  settings: { value: Settings };
  host: { host: 'off' | 'connecting' | 'connected' | 'error' | 'not-installed'; error?: string };
  opened: string[];
  focused: number[];
  runs: ReplayRequest[];
  timers: Array<{ fn: () => void; ms: number }>;
}

function harness(patch: Partial<Settings> = { rnEnabled: true }): Harness {
  const h = {
    posted: [] as RnExtensionToHost[],
    settings: { value: mergeSettings(DEFAULT_SETTINGS, patch) },
    host: { host: 'connected' as Harness['host']['host'] },
    opened: [] as string[],
    focused: [] as number[],
    runs: [] as ReplayRequest[],
    timers: [] as Array<{ fn: () => void; ms: number }>,
  } as Harness;
  const deps: RnBridgeDeps = {
    extensionId: EXT,
    settings: () => h.settings.value,
    permission: () => true,
    host: () => h.host,
    post: (m) => {
      if (h.host.host !== 'connected') return false;
      h.posted.push(m);
      return true;
    },
    replays: {
      run: async (_tabId, req) => {
        h.runs.push(req);
        return { runId: req.runId, ok: true, status: 204, statusText: '', headers: [], body: null, url: req.url, redirected: false, timing: { start: 1, end: 2 }, size: 0 };
      },
      abort: async () => true,
    },
    openTab: async (path) => void h.opened.push(path),
    focusTab: async (tabId) => void h.focused.push(tabId),
    now: () => 1000,
    timers: { setTimeout: (fn, ms) => (h.timers.push({ fn, ms }), h.timers.length), clearTimeout: () => undefined },
  };
  h.bridge = new RnBridge(deps);
  return h;
}

const session = (id: string, connected = true, connectedAt = 1) => ({
  t: 'rn-session',
  session: id,
  app: { name: 'DemoApp', bundleId: 'com.example', platform: 'android', rnVersion: '0.76.3', hermes: true, deviceName: 'Pixel 8' },
  lib: { name: 'lib', version: '0.1.0' },
  capabilities: ['http'],
  connected,
  connectedAt,
  address: '127.0.0.1',
});

const start = (hookId: string) => ({ t: 'start', data: { hookId, kind: 'fetch', method: 'GET', url: `https://api.example.com/${hookId}`, headers: [], body: null, contentType: null, startTime: 1, frameUrl: '' } });

const replayRequest = (mode: 'page' | 'extension', runId = 'run-1'): ReplayRequest => ({
  runId,
  entryId: 'h:0:s1:1',
  mode,
  frameId: 0,
  method: 'POST',
  url: 'https://api.example.com/items',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: { kind: 'text', text: '{"a":1}' },
  credentials: 'include',
  redirect: 'follow',
  timeoutMs: 30_000,
  responseBodyCap: 1024,
});

describe('parseRnHostMessage', () => {
  it('accepts the rn-* messages and rejects malformed ones', () => {
    expect(parseRnHostMessage({ t: 'rn-status', status: { state: 'listening', host: '127.0.0.1', port: 8790, lan: false, addresses: [], token: 'abcdefghijklmnopqrstuvwx' } })).toMatchObject({
      t: 'rn-status',
      status: { state: 'listening', port: 8790, token: 'abcdefghijklmnopqrstuvwx' },
    });
    expect(parseRnHostMessage({ t: 'rn-status', status: { state: 'x', token: '<script>' } })).toMatchObject({ status: { state: 'off', token: '' } });
    expect(parseRnHostMessage({ t: 'rn-session', session: 'bad id!', app: {} })).toBeNull();
    expect(parseRnHostMessage(session('s1'))).toMatchObject({ t: 'rn-session', session: 's1', app: { platform: 'android', deviceName: 'Pixel 8' }, connected: true });
    expect(parseRnHostMessage({ t: 'rn-capture', session: 's1', msgs: [start('a'), { t: 'log' }, 'junk', { t: 'end', data: {} }] })).toEqual({
      t: 'rn-capture',
      session: 's1',
      msgs: [start('a'), { t: 'end', data: {} }],
    });
    expect(parseRnHostMessage({ t: 'rn-chunk', id: 'c1', seq: 3, total: 2, part: 'x' })).toBeNull();
    expect(parseRnHostMessage({ t: 'rn-open-ui', session: 's1' })).toEqual({ t: 'rn-open-ui', session: 's1' });
    expect(parseRnHostMessage({ t: 'other' })).toBeNull();
  });
});

describe('ChunkAssembler', () => {
  it('joins parts in any order and drops inconsistent ones', () => {
    const assembler = new ChunkAssembler();
    const json = JSON.stringify({ t: 'rn-capture', session: 's1', msgs: [start('x')] });
    const parts = [json.slice(0, 10), json.slice(10, 30), json.slice(30)];
    expect(assembler.push({ t: 'rn-chunk', id: 'c1', seq: 2, total: 3, part: parts[2]! })).toBeNull();
    expect(assembler.push({ t: 'rn-chunk', id: 'c1', seq: 0, total: 3, part: parts[0]! })).toBeNull();
    expect(assembler.push({ t: 'rn-chunk', id: 'c1', seq: 1, total: 3, part: parts[1]! })).toEqual(JSON.parse(json));
    expect(assembler.push({ t: 'rn-chunk', id: 'c2', seq: 0, total: 2, part: 'a' })).toBeNull();
    expect(assembler.push({ t: 'rn-chunk', id: 'c2', seq: 0, total: 2, part: 'a' })).toBeNull(); // duplicate → dropped
    expect(assembler.push({ t: 'rn-chunk', id: 'c2', seq: 1, total: 2, part: 'b' })).toBeNull();
  });
});

describe('RnBridge', () => {
  it('configures the receiver from settings once connected, and again when they change', () => {
    const h = harness({ rnEnabled: true, rnListenLan: true, rnPort: 9000 });
    h.bridge.onConnected();
    expect(h.posted).toEqual([{ t: 'rn-config', enabled: true, lan: true, port: 9000 }]);
    h.bridge.onSettings();
    expect(h.posted).toHaveLength(1);
    h.settings.value = { ...h.settings.value, rnPort: 80 };
    h.bridge.onSettings();
    expect(h.posted.at(-1)).toEqual({ t: 'rn-config', enabled: true, lan: true, port: 8790 });
    expect(h.bridge.wanted()).toBe(true);
    h.settings.value = { ...h.settings.value, rnEnabled: false };
    expect(h.bridge.wanted()).toBe(false);
  });

  it('accepts only its own pages on its ports', () => {
    const h = harness();
    const foreign = new FakePort('reqlens-standalone', { id: EXT, url: 'https://evil.example/app.html', tab: { id: 1 } as chrome.tabs.Tab });
    expect(h.bridge.accept(foreign)).toBe(true);
    expect(foreign.disconnected).toBe(true);
    const panelAsStandalone = new FakePort('reqlens-standalone', { id: EXT, url: `chrome-extension://${EXT}/panel.html`, tab: { id: 1 } as chrome.tabs.Tab });
    h.bridge.accept(panelAsStandalone);
    expect(panelAsStandalone.disconnected).toBe(true);
    const status = new FakePort('reqlens-rn', { id: EXT, url: `chrome-extension://${EXT}/panel.html#n`, tab: { id: 1 } as chrome.tabs.Tab });
    h.bridge.accept(status);
    expect(status.disconnected).toBe(false);
    expect(status.of('status')).toHaveLength(1);
    expect(h.bridge.accept(new FakePort('other', { id: EXT }))).toBe(false);
    expect(isOwnPage(`chrome-extension://${EXT}/app.html?x#y`, EXT, 'app.html')).toBe(true);
  });

  it('streams captures, buffers them for a tab opened later, and forgets them on clear', () => {
    const h = harness();
    h.bridge.onHostMessage(session('s1'));
    const early = standalonePort();
    h.bridge.accept(early);
    h.bridge.onHostMessage({ t: 'rn-capture', session: 's1', msgs: [start('s1:1'), start('s1:2')] });
    expect(early.of('captures')).toEqual([{ t: 'captures', session: 's1', msgs: [start('s1:1'), start('s1:2')] }]);
    const late = standalonePort(43);
    h.bridge.accept(late);
    expect(late.of('captures')).toEqual([{ t: 'captures', session: 's1', msgs: [start('s1:1'), start('s1:2')], reset: true }]);
    late.receive({ t: 'clear', session: 's1' });
    const later = standalonePort(44);
    h.bridge.accept(later);
    expect(later.of('captures')).toEqual([{ t: 'captures', session: 's1', msgs: [], reset: true }]);
  });

  it('reassembles chunked captures', () => {
    const h = harness();
    const port = standalonePort();
    h.bridge.accept(port);
    const json = JSON.stringify({ t: 'rn-capture', session: 's1', msgs: [start('s1:9')] });
    h.bridge.onHostMessage({ t: 'rn-chunk', id: 'c1', seq: 0, total: 2, part: json.slice(0, 20) });
    h.bridge.onHostMessage({ t: 'rn-chunk', id: 'c1', seq: 1, total: 2, part: json.slice(20) });
    expect(port.of('captures')).toEqual([{ t: 'captures', session: 's1', msgs: [start('s1:9')] }]);
  });

  it('reports sessions and receiver status to status ports', () => {
    const h = harness();
    const port = new FakePort('reqlens-rn', { id: EXT, url: `chrome-extension://${EXT}/app.html`, tab: { id: 1 } as chrome.tabs.Tab });
    h.bridge.accept(port);
    h.bridge.onHostMessage({ t: 'rn-status', status: { state: 'listening', host: '127.0.0.1', port: 8790, lan: false, addresses: [], token: 'abcdefghijklmnopqrstuvwx' } });
    h.bridge.onHostMessage(session('s1'));
    const last = port.of('status').at(-1)!.status as RnStatus;
    expect(last).toMatchObject({ enabled: true, host: 'connected', receiver: { state: 'listening', token: 'abcdefghijklmnopqrstuvwx' }, sessions: [{ session: 's1', connected: true }] });
    port.receive({ t: 'regenerate-token' });
    expect(h.posted.at(-1)).toEqual({ t: 'rn-token', regenerate: true });
    h.bridge.onPortClosed();
    const closed = port.of('status').at(-1)!.status as RnStatus;
    expect(closed.sessions[0]!.connected).toBe(false);
  });

  it('opens the standalone tab for an app, or focuses the open one and selects the app', async () => {
    const h = harness();
    h.bridge.onHostMessage(session('s1'));
    h.bridge.onHostMessage({ t: 'rn-open-ui', session: 's1' });
    await vi.waitFor(() => expect(h.opened).toEqual(['app.html#session=s1']));
    const port = standalonePort(7);
    h.bridge.accept(port);
    h.bridge.onHostMessage({ t: 'rn-open-ui', session: 's1' });
    await vi.waitFor(() => expect(h.focused).toEqual([7]));
    expect(port.of('select')).toEqual([{ t: 'select', session: 's1' }]);
  });

  it('routes App-mode replays to the app and Extension-mode replays to the worker', async () => {
    const h = harness();
    h.bridge.onHostMessage(session('s1'));
    const port = standalonePort();
    h.bridge.accept(port);

    port.receive({ t: 'call', id: 1, method: 'replay', args: ['s1', replayRequest('page')] });
    expect(h.posted.at(-1)).toMatchObject({ t: 'rn-replay', session: 's1', data: { runId: 'run-1', method: 'POST', body: { kind: 'text', text: '{"a":1}' }, responseBodyCap: 1024 } });
    // The app's answer arrives inside the capture stream; it is not forwarded as a capture.
    h.bridge.onHostMessage({
      t: 'rn-capture',
      session: 's1',
      msgs: [{ t: 'replay-result', data: { runId: 'run-1', ok: true, status: 201, statusText: 'Created', headers: [], body: { kind: 'text', text: 'x'.repeat(5000), size: 5000 }, url: 'https://api.example.com/items', redirected: false, timing: { start: 1, end: 2 }, size: 5000, evil: 1 } }],
    });
    await vi.waitFor(() => expect(port.of('result')).toHaveLength(1));
    const result = port.of('result')[0]!.value as ReplayResult;
    expect(result).toMatchObject({ runId: 'run-1', ok: true, status: 201 });
    expect(result.body).toMatchObject({ kind: 'text', truncated: true });
    expect((result as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(port.of('captures')).toHaveLength(0);

    port.receive({ t: 'call', id: 2, method: 'replay', args: ['s1', replayRequest('extension', 'run-2')] });
    await vi.waitFor(() => expect(port.of('result')).toHaveLength(2));
    expect(h.runs.map((r) => r.runId)).toEqual(['run-2']);

    // Invalid requests and unknown sessions answer with errors.
    port.receive({ t: 'call', id: 3, method: 'replay', args: ['s1', { runId: 'x' }] });
    port.receive({ t: 'call', id: 4, method: 'replay', args: ['nope', replayRequest('page', 'run-4')] });
    await vi.waitFor(() => expect(port.of('result')).toHaveLength(4));
    expect((port.of('result')[2]!.value as ReplayResult).ok).toBe(false);
    expect((port.of('result')[3]!.value as ReplayResult).error).toBe('The app is not connected to kineReqLens');
  });

  it('fails App-mode replays when the app disconnects or never answers', async () => {
    const h = harness();
    h.bridge.onHostMessage(session('s1'));
    const port = standalonePort();
    h.bridge.accept(port);
    port.receive({ t: 'call', id: 1, method: 'replay', args: ['s1', replayRequest('page', 'r1')] });
    port.receive({ t: 'call', id: 2, method: 'replay', args: ['s1', replayRequest('page', 'r2')] });
    port.receive({ t: 'call', id: 3, method: 'abort', args: ['s1', 'r2', 'page'] });
    await vi.waitFor(() => expect(h.posted.some((m) => m.t === 'rn-abort')).toBe(true));
    h.timers.find((t) => t.ms === 35_000)!.fn();
    await vi.waitFor(() => expect(port.of('result').filter((r) => r.id !== 3)).toHaveLength(1));
    expect((port.of('result').find((r) => r.id === 1)!.value as ReplayResult).timedOut).toBe(true);
    h.bridge.onHostMessage(session('s1', false));
    await vi.waitFor(() => expect(port.of('result').filter((r) => r.id === 2)).toHaveLength(1));
    expect((port.of('result').find((r) => r.id === 2)!.value as ReplayResult).error).toBe('The app disconnected before answering');
  });
});
