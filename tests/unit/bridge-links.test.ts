import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_HELLO_TIMEOUT_MS, LinkError, PanelLinks, panelSenderTab } from '../../src/background/claude/links';
import type { LinkDeps, LinkPort } from '../../src/background/claude/links';
import type { BridgeStatus } from '../../src/shared/claude-protocol';
import type { LinkInboxDraft } from '../../src/shared/claude-link';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PANEL_URL = `chrome-extension://${EXT_ID}/panel.html#nonce123`;
const TAB = 7;

class FakePort implements LinkPort {
  posted: Array<Record<string, unknown>> = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  constructor(
    public name: string,
    public sender: chrome.runtime.MessageSender,
  ) {}
  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('disconnected');
    this.posted.push(message as Record<string, unknown>);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  send(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  close(): void {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) fn();
  }
  last(): Record<string, unknown> | undefined {
    return this.posted[this.posted.length - 1];
  }
}

const status: BridgeStatus = { enabled: true, permission: true, host: 'connected', sessions: [], extensionId: EXT_ID };

function sender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return { id: EXT_ID, url: PANEL_URL, tab: { id: TAB } as chrome.tabs.Tab, frameId: 3, ...overrides };
}

function harness() {
  const deps = {
    extensionId: EXT_ID,
    status: vi.fn(() => status),
    onHello: vi.fn(),
    onPush: vi.fn((_tabId: number, _item: LinkInboxDraft) => ({ ok: true, delivered: 2 })),
  } satisfies LinkDeps;
  const links = new PanelLinks(deps);
  const connect = (from = sender(), name = 'reqlens-claude-link') => {
    const port = new FakePort(name, from);
    const handled = links.accept(port);
    return { port, handled };
  };
  const connected = (tabId = TAB) => {
    const { port } = connect(sender({ tab: { id: tabId } as chrome.tabs.Tab }));
    port.send({ t: 'hello', v: 1, tabId });
    return port;
  };
  return { links, deps, connect, connected };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('panelSenderTab', () => {
  it('accepts only this extension panel page in a tab', () => {
    expect(panelSenderTab(sender(), EXT_ID)).toBe(TAB);
    expect(panelSenderTab(sender({ id: 'other' }), EXT_ID)).toBeNull();
    expect(panelSenderTab(sender({ url: `chrome-extension://${EXT_ID}/options.html` }), EXT_ID)).toBeNull();
    expect(panelSenderTab(sender({ url: 'https://evil.test/panel.html' }), EXT_ID)).toBeNull();
    expect(panelSenderTab(sender({ url: `chrome-extension://other/panel.html` }), EXT_ID)).toBeNull();
    expect(panelSenderTab(sender({ tab: undefined }), EXT_ID)).toBeNull();
    expect(panelSenderTab(undefined, EXT_ID)).toBeNull();
  });
});

describe('PanelLinks', () => {
  it('ignores ports with other names', () => {
    const h = harness();
    const { port, handled } = h.connect(sender(), 'something-else');
    expect(handled).toBe(false);
    expect(port.disconnected).toBe(false);
  });

  it('disconnects foreign senders at once', () => {
    const h = harness();
    const { port, handled } = h.connect(sender({ url: `chrome-extension://${EXT_ID}/popup.html` }));
    expect(handled).toBe(true);
    expect(port.disconnected).toBe(true);
  });

  it('requires a hello whose tab id matches the sender tab', () => {
    const h = harness();
    const { port } = h.connect();
    port.send({ t: 'hello', v: 1, tabId: TAB + 1 });
    expect(port.disconnected).toBe(true);
    expect(h.links.has(TAB)).toBe(false);
    const wrongVersion = h.connect().port;
    wrongVersion.send({ t: 'hello', v: 99, tabId: TAB });
    expect(wrongVersion.disconnected).toBe(true);
  });

  it('drops a panel that never says hello', () => {
    const h = harness();
    const { port } = h.connect();
    vi.advanceTimersByTime(LINK_HELLO_TIMEOUT_MS);
    expect(port.disconnected).toBe(true);
  });

  it('registers the link, sends the status and reports the hello', () => {
    const h = harness();
    const port = h.connected();
    expect(h.links.has(TAB)).toBe(true);
    expect(h.links.tabIds()).toEqual([TAB]);
    expect(port.last()).toEqual({ t: 'status', status });
    expect(h.deps.onHello).toHaveBeenCalledWith(TAB);
    vi.advanceTimersByTime(LINK_HELLO_TIMEOUT_MS);
    expect(port.disconnected).toBe(false);
  });

  it('queries the newest panel of a tab and resolves with its answer', async () => {
    const h = harness();
    const older = h.connected();
    const newer = h.connected();
    const pending = h.links.query(TAB, { kind: 'state' }, 1000);
    const query = newer.last()!;
    expect(query).toMatchObject({ t: 'query', query: { kind: 'state' } });
    expect(older.posted.some((m) => m.t === 'query')).toBe(false);
    newer.send({ t: 'res', id: query.id, ok: true, result: { selectedId: 'h:0:1', work: [] } });
    await expect(pending).resolves.toEqual({ selectedId: 'h:0:1', work: [] });
  });

  it('rejects with the panel error, on timeout, and when the panel goes away', async () => {
    const h = harness();
    const port = h.connected();
    const failing = h.links.query(TAB, { kind: 'entry', entryId: 'x' }, 1000);
    port.send({ t: 'res', id: port.last()!.id, ok: false, error: 'No such entry' });
    await expect(failing).rejects.toThrow('No such entry');

    const slow = h.links.query(TAB, { kind: 'state' }, 1000);
    vi.advanceTimersByTime(1000);
    await expect(slow).rejects.toThrow(LinkError);

    const orphan = h.links.query(TAB, { kind: 'state' }, 60_000);
    port.close();
    await expect(orphan).rejects.toThrow(/closed or reloaded/);
    expect(h.links.has(TAB)).toBe(false);
    await expect(h.links.query(TAB, { kind: 'state' }, 1000)).rejects.toThrow(/not open in tab 7/);
  });

  it('falls back to the older panel when the newest disconnects', async () => {
    const h = harness();
    const older = h.connected();
    const newer = h.connected();
    newer.close();
    expect(h.links.has(TAB)).toBe(true);
    const pending = h.links.query(TAB, { kind: 'state' }, 1000);
    older.send({ t: 'res', id: older.last()!.id, ok: true, result: 1 });
    await expect(pending).resolves.toBe(1);
  });

  it('waitFor resolves when a panel of the tab says hello, or false after the timeout', async () => {
    const h = harness();
    const waiting = h.links.waitFor(TAB, 3000);
    const other = h.links.waitFor(TAB + 1, 3000);
    h.connected();
    await expect(waiting).resolves.toBe(true);
    vi.advanceTimersByTime(3000);
    await expect(other).resolves.toBe(false);
    await expect(h.links.waitFor(TAB, 3000)).resolves.toBe(true);
  });

  it('broadcasts the status to every panel', () => {
    const h = harness();
    const a = h.connected(1);
    const b = h.connected(2);
    const next: BridgeStatus = { ...status, host: 'error', error: 'boom' };
    h.links.broadcast(next);
    expect(a.last()).toEqual({ t: 'status', status: next });
    expect(b.last()).toEqual({ t: 'status', status: next });
  });

  it('relays valid pushes and answers invalid ones with an error', async () => {
    const h = harness();
    const port = h.connected();
    const item = { entryId: 'h:0:1', title: 'POST /x', target: 'client', prompt: '# P', sessionId: 's1' };
    port.send({ t: 'push', id: 5, item });
    await vi.waitFor(() => expect(port.last()).toEqual({ t: 'push-result', id: 5, ok: true, delivered: 2 }));
    expect(h.deps.onPush).toHaveBeenCalledWith(TAB, item);
    port.send({ t: 'push', id: 6, item: { ...item, target: 'nope' } });
    await vi.waitFor(() => expect(port.last()).toMatchObject({ t: 'push-result', id: 6, ok: false, delivered: 0 }));
    expect(h.deps.onPush).toHaveBeenCalledTimes(1);
  });
});
