import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_HOST_GONE_ERROR, PTY_NOT_CONNECTED_ERROR, PtyRelay } from '../../src/background/claude/pty';
import { PanelLinks } from '../../src/background/claude/links';
import type { LinkHandle, LinkPort } from '../../src/background/claude/links';
import { NativeHostLink, parseHostMessage } from '../../src/background/claude/native';
import type { NativePort } from '../../src/background/claude/native';
import { PTY_GRACE_MS } from '../../src/shared/claude-link';
import type { WorkerToPanel } from '../../src/shared/claude-link';
import type { BridgeStatus, PtyToHost } from '../../src/shared/claude-protocol';

class FakeLink implements LinkHandle {
  posted: WorkerToPanel[] = [];
  alive = true;
  constructor(readonly tabId: number) {}
  post(message: WorkerToPanel): boolean {
    if (!this.alive) return false;
    this.posted.push(message);
    return true;
  }
  of<T extends WorkerToPanel['t']>(t: T): Array<Extract<WorkerToPanel, { t: T }>> {
    return this.posted.filter((m) => m.t === t) as Array<Extract<WorkerToPanel, { t: T }>>;
  }
}

function harness(connected = true) {
  const sent: PtyToHost[] = [];
  const state = { connected };
  const relay = new PtyRelay({
    send: (message) => {
      if (!state.connected) return false;
      sent.push(message);
      return true;
    },
  });
  return { relay, sent, state };
}

const open = (id: string, cwd = '~/project') => ({ t: 'pty-open', id, cwd, cols: 80, rows: 24 });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PtyRelay: opening', () => {
  it('forwards a valid open and tracks the panel as owner', () => {
    const { relay, sent } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('p1'));
    expect(sent).toEqual([{ t: 'pty-open', id: 'p1', cwd: '~/project', cols: 80, rows: 24 }]);
    expect(relay.describe('p1')).toMatchObject({ tabId: 7, owned: true, state: 'opening' });
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 99, cwd: '/home/me/project' });
    expect(panel.posted).toEqual([{ t: 'pty-opened', id: 'p1', pid: 99, cwd: '/home/me/project' }]);
    expect(relay.describe('p1')?.state).toBe('running');
  });

  it('refuses invalid messages, duplicates, too many terminals and a disconnected bridge', () => {
    const { relay, sent, state } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, { t: 'pty-open', id: 'p1', cwd: '~', cols: 0, rows: 24 });
    relay.fromPanel(panel, { t: 'pty-open', id: 'bad id', cwd: '~', cols: 80, rows: 24 });
    relay.fromPanel(panel, { t: 'pty-nope', id: 'p1' });
    expect(panel.of('pty-error').map((m) => [m.id, m.error])).toEqual([
      ['p1', 'Invalid terminal message'],
      ['p1', 'Invalid terminal message'],
    ]);
    for (let i = 0; i < 8; i++) relay.fromPanel(panel, open(`ok${i}`));
    relay.fromPanel(panel, open('ok0'));
    relay.fromPanel(panel, open('ninth'));
    expect(sent).toHaveLength(8);
    expect(panel.of('pty-error').slice(2).map((m) => m.error)).toEqual([
      'A terminal with this id already exists',
      expect.stringContaining('At most 8 terminals'),
    ]);
    // Exited terminals do not count against the limit.
    relay.fromHost({ t: 'pty-exit', id: 'ok0', code: 0, signal: null });
    state.connected = false;
    relay.fromPanel(panel, open('tenth'));
    expect(panel.of('pty-error').at(-1)).toEqual({ t: 'pty-error', id: 'tenth', error: PTY_NOT_CONNECTED_ERROR });
    expect(relay.describe('tenth')).toBeNull();
  });

  it('forgets a terminal whose open failed', () => {
    const { relay } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('p1', '/missing'));
    relay.fromHost({ t: 'pty-error', id: 'p1', error: 'No such directory: /missing' });
    expect(panel.of('pty-error')).toEqual([{ t: 'pty-error', id: 'p1', error: 'No such directory: /missing' }]);
    expect(relay.size).toBe(0);
  });
});

describe('PtyRelay: ownership', () => {
  it('only the owning panel can type into, resize or close a terminal', () => {
    const { relay, sent } = harness();
    const owner = new FakeLink(7);
    const other = new FakeLink(7);
    const otherTab = new FakeLink(8);
    relay.fromPanel(owner, open('p1'));
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 1 });
    sent.length = 0;
    for (const intruder of [other, otherTab]) {
      relay.fromPanel(intruder, { t: 'pty-input', id: 'p1', data: 'rm -rf /\r' });
      relay.fromPanel(intruder, { t: 'pty-resize', id: 'p1', cols: 10, rows: 10 });
      relay.fromPanel(intruder, { t: 'pty-close', id: 'p1' });
      expect(intruder.of('pty-error').map((m) => m.error)).toEqual(['Unknown terminal', 'Unknown terminal', 'Unknown terminal']);
    }
    expect(sent).toEqual([]);
    relay.fromPanel(owner, { t: 'pty-input', id: 'p1', data: 'ls\r' });
    relay.fromPanel(owner, { t: 'pty-resize', id: 'p1', cols: 100, rows: 30 });
    expect(sent).toEqual([
      { t: 'pty-input', id: 'p1', data: 'ls\r' },
      { t: 'pty-resize', id: 'p1', cols: 100, rows: 30 },
    ]);
    // Output goes to the owner only.
    relay.fromHost({ t: 'pty-data', id: 'p1', data: 'out' });
    expect(owner.of('pty-data')).toEqual([{ t: 'pty-data', id: 'p1', data: 'out' }]);
    expect(other.of('pty-data')).toEqual([]);
    relay.fromPanel(owner, { t: 'pty-close', id: 'p1' });
    expect(sent.at(-1)).toEqual({ t: 'pty-close', id: 'p1' });
    expect(relay.size).toBe(0);
  });

  it('keeps exited terminals (for Restart) until closed, without telling the hub again', () => {
    const { relay, sent } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('p1'));
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 1 });
    relay.fromHost({ t: 'pty-exit', id: 'p1', code: 2, signal: null });
    expect(panel.of('pty-exit')).toEqual([{ t: 'pty-exit', id: 'p1', code: 2, signal: null }]);
    expect(relay.describe('p1')?.state).toBe('exited');
    sent.length = 0;
    relay.fromPanel(panel, { t: 'pty-input', id: 'p1', data: 'x' });
    relay.fromPanel(panel, { t: 'pty-close', id: 'p1' });
    expect(sent).toEqual([]);
    expect(relay.size).toBe(0);
  });

  it('ignores hub events for unknown terminals', () => {
    const { relay } = harness();
    relay.fromHost({ t: 'pty-data', id: 'ghost', data: 'x' });
    relay.fromHost({ t: 'pty-exit', id: 'ghost', code: 0, signal: null });
    expect(relay.size).toBe(0);
  });
});

describe('PtyRelay: panel reload grace', () => {
  it('re-attaches a terminal to a new panel of the same tab within the grace period, with a replay', () => {
    const { relay, sent } = harness();
    const first = new FakeLink(7);
    relay.fromPanel(first, open('p1'));
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 5, cwd: '/w' });
    relay.fromHost({ t: 'pty-data', id: 'p1', data: 'hello ' });
    relay.fromPanel(first, { t: 'pty-resize', id: 'p1', cols: 90, rows: 20 });
    first.alive = false;
    relay.linkClosed(first);
    expect(relay.describe('p1')).toMatchObject({ owned: false, state: 'running' });
    // Output while nobody watches still lands in the replay.
    relay.fromHost({ t: 'pty-data', id: 'p1', data: 'world' });
    vi.advanceTimersByTime(PTY_GRACE_MS - 100);
    // A panel of another tab gets nothing.
    const elsewhere = new FakeLink(8);
    relay.linkOpened(elsewhere);
    expect(elsewhere.posted).toEqual([]);
    const second = new FakeLink(7);
    relay.linkOpened(second);
    expect(second.posted).toEqual([{ t: 'pty-attached', id: 'p1', cwd: '/w', pid: 5, state: 'running', replay: 'hello world' }]);
    vi.advanceTimersByTime(PTY_GRACE_MS * 2);
    expect(sent.filter((m) => m.t === 'pty-close')).toEqual([]);
    relay.fromPanel(second, { t: 'pty-input', id: 'p1', data: 'y' });
    expect(sent.at(-1)).toEqual({ t: 'pty-input', id: 'p1', data: 'y' });
    // The old panel no longer owns it.
    relay.fromPanel(first, { t: 'pty-input', id: 'p1', data: 'z' });
    expect(sent.at(-1)).toEqual({ t: 'pty-input', id: 'p1', data: 'y' });
  });

  it('kills a terminal whose panel did not come back within 10 s', () => {
    const { relay, sent } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('p1'));
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 5 });
    relay.linkClosed(panel);
    vi.advanceTimersByTime(PTY_GRACE_MS - 1);
    expect(sent.filter((m) => m.t === 'pty-close')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toEqual({ t: 'pty-close', id: 'p1' });
    expect(relay.size).toBe(0);
    relay.linkOpened(new FakeLink(7));
    expect(relay.size).toBe(0);
  });

  it('drops exited terminals of a closed panel at once, and terminals that exit while orphaned', () => {
    const { relay, sent } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('done'));
    relay.fromPanel(panel, open('live'));
    relay.fromHost({ t: 'pty-exit', id: 'done', code: 0, signal: null });
    relay.linkClosed(panel);
    expect(relay.describe('done')).toBeNull();
    relay.fromHost({ t: 'pty-exit', id: 'live', code: 1, signal: null });
    expect(relay.size).toBe(0);
    vi.advanceTimersByTime(PTY_GRACE_MS);
    expect(sent.filter((m) => m.t === 'pty-close')).toEqual([]);
  });

  it('caps the replay at ~200 KB', () => {
    const { relay } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('p1'));
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 5 });
    for (let i = 0; i < 10; i++) relay.fromHost({ t: 'pty-data', id: 'p1', data: String(i).repeat(50_000) });
    const replay = relay.describe('p1')!.replay;
    expect(replay.length).toBe(200 * 1024);
    expect(replay.endsWith('9'.repeat(50_000))).toBe(true);
  });
});

describe('PtyRelay: bridge lifecycle', () => {
  it('the hub going away ends every terminal', () => {
    const { relay } = harness();
    const panel = new FakeLink(7);
    relay.fromPanel(panel, open('opening'));
    relay.fromPanel(panel, open('running'));
    relay.fromHost({ t: 'pty-opened', id: 'running', pid: 1 });
    relay.hostGone();
    expect(panel.posted.slice(1)).toEqual([
      { t: 'pty-error', id: 'opening', error: PTY_HOST_GONE_ERROR },
      { t: 'pty-error', id: 'running', error: PTY_HOST_GONE_ERROR },
      { t: 'pty-exit', id: 'running', code: null, signal: null },
    ]);
    expect(relay.describe('opening')).toBeNull();
    expect(relay.describe('running')?.state).toBe('exited');
  });

  it('turning the bridge off kills them all', () => {
    const { relay, sent } = harness();
    const a = new FakeLink(7);
    const b = new FakeLink(8);
    relay.fromPanel(a, open('p1'));
    relay.fromPanel(b, open('p2'));
    relay.fromHost({ t: 'pty-opened', id: 'p2', pid: 1 });
    sent.length = 0;
    relay.killAll('The Claude Code bridge was turned off');
    expect(sent).toEqual([
      { t: 'pty-close', id: 'p1' },
      { t: 'pty-close', id: 'p2' },
    ]);
    expect(a.of('pty-error')[0]?.error).toBe('The Claude Code bridge was turned off');
    expect(b.of('pty-exit')).toHaveLength(1);
    expect(relay.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Wiring: panel links route pty messages, the native port parses and sends them.

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

class FakeLinkPort implements LinkPort {
  posted: unknown[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  name = 'reqlens-claude-link';
  sender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html#n`, tab: { id: 7 } as chrome.tabs.Tab } as chrome.runtime.MessageSender;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  disconnect(): void {}
  send(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  close(): void {
    for (const fn of this.disconnectListeners) fn();
  }
}

describe('panel links ↔ relay', () => {
  it('route pty messages of hello-ed panels and report opens / closes', () => {
    const status: BridgeStatus = { enabled: true, permission: true, host: 'connected', sessions: [], extensionId: EXT_ID };
    const { relay, sent } = harness();
    const links = new PanelLinks({
      extensionId: EXT_ID,
      status: () => status,
      onHello: () => undefined,
      onPush: () => ({ ok: true, delivered: 0 }),
      onLinkOpen: (link) => relay.linkOpened(link),
      onLinkClose: (link) => relay.linkClosed(link),
      onPty: (link, message) => relay.fromPanel(link, message),
    });
    const port = new FakeLinkPort();
    links.accept(port);
    // Before hello nothing is routed (and the port is dropped).
    port.send({ t: 'hello', v: 1, tabId: 7 });
    port.send(open('p1'));
    expect(sent).toEqual([{ t: 'pty-open', id: 'p1', cwd: '~/project', cols: 80, rows: 24 }]);
    relay.fromHost({ t: 'pty-opened', id: 'p1', pid: 3 });
    expect(port.posted.at(-1)).toEqual({ t: 'pty-opened', id: 'p1', pid: 3 });
    port.close();
    expect(relay.describe('p1')?.owned).toBe(false);
    const reloaded = new FakeLinkPort();
    links.accept(reloaded);
    reloaded.send({ t: 'hello', v: 1, tabId: 7 });
    expect(reloaded.posted.at(-1)).toMatchObject({ t: 'pty-attached', id: 'p1', pid: 3, state: 'running' });
  });
});

class FakeNativePort implements NativePort {
  posted: unknown[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  disconnect(): void {}
  receive(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  close(): void {
    for (const fn of this.disconnectListeners) fn();
  }
}

describe('native port ↔ relay', () => {
  it('parses pty events, sends pty control only while connected, reports the port closing', () => {
    expect(parseHostMessage({ t: 'pty-data', id: 'p1', data: 'x' })).toEqual({ t: 'pty', message: { t: 'pty-data', id: 'p1', data: 'x' } });
    expect(parseHostMessage({ t: 'pty-data', id: 'bad id', data: 'x' })).toBeNull();
    const ports: FakeNativePort[] = [];
    const events: unknown[] = [];
    let closed = 0;
    const native = new NativeHostLink({
      extensionId: EXT_ID,
      connect: () => {
        const p = new FakeNativePort();
        ports.push(p);
        return p;
      },
      lastError: () => undefined,
      hello: () => ({ extensionVersion: '1', browser: 'Edge' }),
      onRequest: async (req) => ({ t: 'res', id: req.id, ok: true, result: null }),
      onChange: () => undefined,
      onPty: (message) => events.push(message),
      onPortClosed: () => closed++,
    });
    expect(native.sendPty({ t: 'pty-close', id: 'p1' })).toBe(false);
    native.setWanted(true);
    const port = ports[0]!;
    expect(native.sendPty({ t: 'pty-close', id: 'p1' })).toBe(false); // no hello yet
    port.receive({ t: 'hello', v: 1, hostVersion: '1' });
    expect(native.sendPty({ t: 'pty-close', id: 'p1' })).toBe(true);
    expect(port.posted.at(-1)).toEqual({ t: 'pty-close', id: 'p1' });
    port.receive({ t: 'pty-exit', id: 'p1', code: 0, signal: null });
    expect(events).toEqual([{ t: 'pty-exit', id: 'p1', code: 0, signal: null }]);
    port.close();
    expect(closed).toBe(1);
    native.setWanted(false);
    expect(closed).toBe(1);
  });
});
