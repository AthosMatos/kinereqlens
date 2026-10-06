// Folder browser of the terminal, service-worker side: validation (src/shared/fs.ts), the relay
// (src/background/claude/fs.ts) and its wiring through the panel links and the native port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FS_HOST_GONE_ERROR, FS_MAX_PENDING_PER_LINK, FS_NOT_CONNECTED_ERROR, FS_TIMEOUT_ERROR, FsRelay } from '../../src/background/claude/fs';
import { PanelLinks } from '../../src/background/claude/links';
import type { LinkHandle, LinkPort } from '../../src/background/claude/links';
import { NativeHostLink, parseHostMessage } from '../../src/background/claude/native';
import type { NativePort } from '../../src/background/claude/native';
import type { WorkerToPanel } from '../../src/shared/claude-link';
import { FS_LIST_TIMEOUT_MS, FS_MAX_ENTRIES, FS_PICK_TIMEOUT_MS } from '../../src/shared/claude-protocol';
import type { BridgeStatus, FsToHost } from '../../src/shared/claude-protocol';
import { FS_UNSUPPORTED_ERROR, isFsName, parseFsFromHost, parseFsToHost } from '../../src/shared/fs';

class FakeLink implements LinkHandle {
  posted: WorkerToPanel[] = [];
  constructor(readonly tabId: number) {}
  post(message: WorkerToPanel): boolean {
    this.posted.push(message);
    return true;
  }
}

function harness(state = { connected: true, supported: true, enabled: true }) {
  const sent: FsToHost[] = [];
  const relay = new FsRelay({
    send: (message) => {
      if (!state.connected) return false;
      sent.push(message);
      return true;
    },
    connected: () => state.connected,
    supported: () => state.supported,
    enabled: () => state.enabled,
  });
  return { relay, sent, state };
}

const listed = (id: string, extra: Record<string, unknown> = {}) => ({ t: 'fs-listed', id, path: '/home/me', parent: '/home', entries: [], home: '/home/me', sep: '/', ...extra });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fs message validation', () => {
  it('accepts only well-formed requests', () => {
    expect(parseFsToHost({ t: 'fs-list', id: 'q1', path: '~/a' })).toEqual({ t: 'fs-list', id: 'q1', path: '~/a' });
    expect(parseFsToHost({ t: 'fs-list', id: 'q1', path: '' })).toBeNull();
    expect(parseFsToHost({ t: 'fs-list', id: 'q1', path: 'a\nb' })).toBeNull();
    expect(parseFsToHost({ t: 'fs-list', id: '', path: '~' })).toBeNull();
    expect(parseFsToHost({ t: 'fs-pick', id: 'q1', startPath: '' })).toEqual({ t: 'fs-pick', id: 'q1' });
    expect(parseFsToHost({ t: 'fs-pick', id: 'q1', startPath: '/x' })).toEqual({ t: 'fs-pick', id: 'q1', startPath: '/x' });
    expect(parseFsToHost({ t: 'fs-projects', id: 'q1', refresh: false })).toEqual({ t: 'fs-projects', id: 'q1' });
    expect(parseFsToHost({ t: 'fs-write', id: 'q1', path: '/x' })).toBeNull();
    expect(parseFsToHost(null)).toBeNull();
  });

  it('cleans answers: bad entries dropped, caps, error text clipped', () => {
    const answer = parseFsFromHost(
      listed('q1', {
        entries: [
          { name: 'ok', dir: true, hidden: false, git: true, project: true, extra: 1 },
          { name: '.dot', hidden: true },
          { name: '..' },
          { name: 'a/b' },
          { name: 'a\\b' },
          { name: 'x\u0007' },
          { name: 5 },
          'nope',
        ],
        sep: 'weird',
      }),
    );
    expect(answer).toEqual({
      t: 'fs-listed',
      id: 'q1',
      path: '/home/me',
      parent: '/home',
      home: '/home/me',
      sep: '/',
      entries: [
        { name: 'ok', dir: true, hidden: false, git: true, project: true },
        { name: '.dot', dir: true, hidden: true },
      ],
    });
    const many = parseFsFromHost(listed('q1', { entries: Array.from({ length: FS_MAX_ENTRIES + 5 }, (_, i) => ({ name: `d${i}` })) }));
    expect(many?.t === 'fs-listed' && many.entries.length).toBe(FS_MAX_ENTRIES);
    expect(many?.t === 'fs-listed' && many.truncated).toBe(true);
    expect(parseFsFromHost(listed('q1', { parent: 7 }))).toBeNull();
    expect(parseFsFromHost(listed('q1', { path: 'a\u0000' }))).toBeNull();
    expect(parseFsFromHost({ t: 'fs-picked', id: 'q1', path: null })).toEqual({ t: 'fs-picked', id: 'q1', path: null });
    expect(parseFsFromHost({ t: 'fs-picked', id: 'q1', path: 3 })).toBeNull();
    expect(parseFsFromHost({ t: 'fs-projects-listed', id: 'q1', home: '/h', projects: [{ path: '/h/a', name: 'a', git: true }, { path: '/h/b', name: '' }] })).toEqual({
      t: 'fs-projects-listed',
      id: 'q1',
      home: '/h',
      projects: [{ path: '/h/a', name: 'a', git: true }],
    });
    const err = parseFsFromHost({ t: 'fs-error', id: 'q1', error: 'x'.repeat(5000) });
    expect(err?.t === 'fs-error' && err.error.length).toBe(2000);
    expect(parseFsFromHost({ t: 'fs-error', id: 'q1' })).toEqual({ t: 'fs-error', id: 'q1', error: 'Folder browser error' });
    expect(isFsName('.git')).toBe(true);
    expect(isFsName('.')).toBe(false);
  });
});

describe('FsRelay', () => {
  it('forwards requests with worker ids and routes answers only to the asking panel', () => {
    const { relay, sent } = harness();
    const a = new FakeLink(1);
    const b = new FakeLink(2);
    relay.fromPanel(a, { t: 'fs-list', id: 'same', path: '~' });
    relay.fromPanel(b, { t: 'fs-list', id: 'same', path: '/tmp' });
    expect(sent).toEqual([
      { t: 'fs-list', id: 'fs-1', path: '~' },
      { t: 'fs-list', id: 'fs-2', path: '/tmp' },
    ]);
    relay.fromHost(parseFsFromHost(listed('fs-2'))!);
    expect(a.posted).toEqual([]);
    expect(b.posted).toEqual([{ ...listed('same') }]);
    // Answered once; a second answer or an unknown id goes nowhere.
    relay.fromHost(parseFsFromHost(listed('fs-2'))!);
    relay.fromHost(parseFsFromHost(listed('fs-99'))!);
    expect(b.posted).toHaveLength(1);
    relay.fromHost({ t: 'fs-error', id: 'fs-1', error: 'No such directory: /x' });
    expect(a.posted).toEqual([{ t: 'fs-error', id: 'same', error: 'No such directory: /x' }]);
    expect(relay.size).toBe(0);
  });

  it('refuses invalid, duplicate, too many and second chooser requests', () => {
    const { relay, sent } = harness();
    const a = new FakeLink(1);
    relay.fromPanel(a, { t: 'fs-list', id: 'q1', path: 'a\u0000' });
    relay.fromPanel(a, { t: 'fs-list', id: 'bad id', path: '~' });
    expect(a.posted).toEqual([{ t: 'fs-error', id: 'q1', error: 'Invalid folder request' }]);
    relay.fromPanel(a, { t: 'fs-pick', id: 'p1' });
    relay.fromPanel(a, { t: 'fs-pick', id: 'p2' });
    relay.fromPanel(a, { t: 'fs-pick', id: 'p1' });
    expect(a.posted.slice(1)).toEqual([
      { t: 'fs-error', id: 'p2', error: 'The folder chooser is already open' },
      { t: 'fs-error', id: 'p1', error: 'A folder request with this id is already pending' },
    ]);
    for (let i = 0; i < FS_MAX_PENDING_PER_LINK; i++) relay.fromPanel(a, { t: 'fs-list', id: `l${i}`, path: '~' });
    expect(sent).toHaveLength(FS_MAX_PENDING_PER_LINK);
    expect(a.posted.at(-1)).toEqual({ t: 'fs-error', id: `l${FS_MAX_PENDING_PER_LINK - 1}`, error: 'Too many folder requests at once — try again' });
    // Another panel is not affected.
    const b = new FakeLink(2);
    relay.fromPanel(b, { t: 'fs-pick', id: 'p1' });
    expect(sent.at(-1)).toMatchObject({ t: 'fs-pick' });
    // An answer of the wrong type ends the request with an error.
    const pickId = (sent.at(-1) as { id: string }).id;
    relay.fromHost(parseFsFromHost(listed(pickId))!);
    expect(b.posted).toEqual([{ t: 'fs-error', id: 'p1', error: 'Unexpected answer from the kineReqLens bridge' }]);
  });

  it('answers at once when the bridge is off, disconnected or too old', () => {
    const { relay, sent, state } = harness();
    const a = new FakeLink(1);
    state.enabled = false;
    relay.fromPanel(a, { t: 'fs-list', id: 'q1', path: '~' });
    state.enabled = true;
    state.supported = false;
    relay.fromPanel(a, { t: 'fs-list', id: 'q2', path: '~' });
    state.connected = false;
    relay.fromPanel(a, { t: 'fs-list', id: 'q3', path: '~' });
    expect(sent).toEqual([]);
    expect(a.posted.map((m) => (m as { error: string }).error)).toEqual([
      'The Claude Code bridge is turned off in Settings → Claude Code',
      FS_UNSUPPORTED_ERROR,
      FS_NOT_CONNECTED_ERROR,
    ]);
    expect(relay.size).toBe(0);
  });

  it('times out per request type, forgets closed panels and fails everything when the hub goes', () => {
    const { relay, sent } = harness();
    const a = new FakeLink(1);
    const b = new FakeLink(2);
    relay.fromPanel(a, { t: 'fs-list', id: 'q1', path: '~' });
    relay.fromPanel(a, { t: 'fs-pick', id: 'p1' });
    vi.advanceTimersByTime(FS_LIST_TIMEOUT_MS);
    expect(a.posted).toEqual([{ t: 'fs-error', id: 'q1', error: FS_TIMEOUT_ERROR }]);
    relay.fromHost(parseFsFromHost(listed(sent[0]!.id))!);
    expect(a.posted).toHaveLength(1);
    // The chooser waits much longer.
    vi.advanceTimersByTime(FS_PICK_TIMEOUT_MS - FS_LIST_TIMEOUT_MS - 1);
    expect(a.posted).toHaveLength(1);
    relay.linkClosed(a);
    expect(relay.size).toBe(0);
    relay.fromHost({ t: 'fs-picked', id: sent[1]!.id, path: '/x' });
    vi.advanceTimersByTime(FS_PICK_TIMEOUT_MS);
    expect(a.posted).toHaveLength(1);
    relay.fromPanel(b, { t: 'fs-projects', id: 's1' });
    relay.hostGone();
    expect(b.posted).toEqual([{ t: 'fs-error', id: 's1', error: FS_HOST_GONE_ERROR }]);
    expect(relay.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Wiring

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

describe('panel link → relay → native port → relay → panel link', () => {
  it('routes fs messages end to end and fails them when the port closes', () => {
    const ports: FakeNativePort[] = [];
    let relay!: FsRelay;
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
      onFs: (message) => relay.fromHost(message),
      onPortClosed: () => relay.hostGone(),
    });
    relay = new FsRelay({ send: (m) => native.sendFs(m), connected: () => native.connected, supported: () => native.supportsFs });
    const status: BridgeStatus = { enabled: true, permission: true, host: 'connected', sessions: [], extensionId: EXT_ID };
    const links = new PanelLinks({
      extensionId: EXT_ID,
      status: () => status,
      onHello: () => undefined,
      onPush: () => ({ ok: true, delivered: 0 }),
      onLinkClose: (link) => relay.linkClosed(link),
      onFs: (link, message) => relay.fromPanel(link, message),
    });
    const panel = new FakeLinkPort();
    links.accept(panel);
    panel.send({ t: 'hello', v: 1, tabId: 7 });

    native.setWanted(true);
    const port = ports[0]!;
    // A hub without the feature: refused at once.
    port.receive({ t: 'hello', v: 1, hostVersion: 'old' });
    expect(native.supportsFs).toBe(false);
    panel.send({ t: 'fs-list', id: 'q0', path: '~' });
    expect(panel.posted.at(-1)).toEqual({ t: 'fs-error', id: 'q0', error: FS_UNSUPPORTED_ERROR });

    port.close();
    vi.advanceTimersByTime(1000);
    const next = ports[1]!;
    next.receive({ t: 'hello', v: 1, hostVersion: 'new', features: ['fs', 7] });
    expect(native.supportsFs).toBe(true);
    panel.send({ t: 'fs-list', id: 'q1', path: '~' });
    expect(next.posted.at(-1)).toEqual({ t: 'fs-list', id: 'fs-1', path: '~' });
    next.receive({ ...listed('fs-1'), entries: [{ name: 'a', dir: true, hidden: false }] });
    expect(panel.posted.at(-1)).toEqual({ ...listed('q1'), entries: [{ name: 'a', dir: true, hidden: false }] });
    // Invalid answers from the hub are dropped by the parser.
    expect(parseHostMessage({ t: 'fs-listed', id: 'fs-2' })).toBeNull();
    expect(parseHostMessage({ t: 'fs-picked', id: 'fs-2', path: '/x' })).toEqual({ t: 'fs', message: { t: 'fs-picked', id: 'fs-2', path: '/x' } });
    expect(parseHostMessage({ t: 'hello', v: 1, hostVersion: '1', features: ['fs'] })).toEqual({ t: 'hello', v: 1, hostVersion: '1', features: ['fs'] });

    panel.send({ t: 'fs-pick', id: 'p1' });
    next.close();
    expect(panel.posted.at(-1)).toEqual({ t: 'fs-error', id: 'p1', error: FS_HOST_GONE_ERROR });
    expect(native.sendFs({ t: 'fs-list', id: 'x', path: '~' })).toBe(false);
  });
});
