import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBridge, registerClaudeBridgeListeners } from '../../src/background/claude';
import type { ClaudeBridgeDeps } from '../../src/background/claude';
import type { LinkPort } from '../../src/background/claude/links';
import { DEFAULT_SETTINGS, SETTINGS_KEY, mergeSettings, tabStateKey } from '../../src/shared/constants';
import type { Settings } from '../../src/shared/types';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

class FakeNativePort {
  posted: Array<Record<string, unknown>> = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  postMessage(m: unknown) {
    this.posted.push(m as Record<string, unknown>);
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(m: unknown) {
    for (const fn of this.messageListeners) fn(m);
  }
  close() {
    for (const fn of this.disconnectListeners) fn();
  }
}

class FakeLinkPort implements LinkPort {
  name = 'reqlens-claude-link';
  posted: Array<Record<string, unknown>> = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (_fn: () => void) => undefined };
  sender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html#n`, tab: { id: 4 } as chrome.tabs.Tab };
  postMessage(m: unknown) {
    this.posted.push(m as Record<string, unknown>);
  }
  disconnect() {}
  send(m: unknown) {
    for (const fn of this.messageListeners) fn(m);
  }
}

type Listener = (...args: unknown[]) => void;

function fakeChrome(opts: { granted: boolean }) {
  const ports: FakeNativePort[] = [];
  const listeners: Record<string, Listener[]> = {};
  const event = (name: string) => ({ addListener: (fn: Listener) => void (listeners[name] ??= []).push(fn) });
  const session: Record<string, unknown> = {};
  let granted = opts.granted;
  const chromeStub = {
    runtime: {
      id: EXT_ID,
      lastError: undefined as { message: string } | undefined,
      connectNative: vi.fn(() => {
        const port = new FakeNativePort();
        ports.push(port);
        return port;
      }),
      onConnect: event('runtime.onConnect'),
    },
    permissions: {
      contains: vi.fn(async () => granted),
      onAdded: event('permissions.onAdded'),
      onRemoved: event('permissions.onRemoved'),
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(session, items)),
      },
      onChanged: event('storage.onChanged'),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, title: 'T', url: 'https://app.test/' })),
      query: vi.fn(async () => [{ id: 4 }]),
      onActivated: event('tabs.onActivated'),
      onRemoved: event('tabs.onRemoved'),
      onReplaced: event('tabs.onReplaced'),
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event('windows.onFocusChanged') },
  };
  vi.stubGlobal('chrome', chromeStub);
  return {
    chrome: chromeStub,
    ports,
    listeners,
    session,
    grant: (value: boolean) => (granted = value),
    fire: (name: string, ...args: unknown[]) => listeners[name]?.forEach((fn) => fn(...args)),
  };
}

function harness(opts: { granted?: boolean; settings?: Partial<Settings>; open?: number[] } = {}) {
  const env = fakeChrome({ granted: opts.granted ?? true });
  let settings = mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {});
  const open = new Set(opts.open ?? [4]);
  const deps: ClaudeBridgeDeps = {
    extensionId: EXT_ID,
    extensionVersion: '0.2.0',
    ready: Promise.resolve(),
    settings: { get: () => settings },
    tabs: {
      get: (tabId) => ({ open: open.has(tabId), recording: true, preserveLog: false }),
      isOpen: (tabId) => open.has(tabId),
      openTabIds: () => [...open],
    },
    sendToFrame: vi.fn(async () => ({ pageUrl: 'https://app.test/', count: 0, rows: [] })),
  };
  const bridge = new ClaudeBridge(deps);
  registerClaudeBridgeListeners(bridge);
  const setSettings = (patch: Partial<Settings>) => {
    settings = mergeSettings(settings, patch);
    env.fire('storage.onChanged', { [SETTINGS_KEY]: { newValue: settings } }, 'local');
  };
  return { env, bridge, deps, setSettings, open };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ClaudeBridge', () => {
  it('registers every listener synchronously', () => {
    const { env } = harness();
    expect(Object.keys(env.listeners).sort()).toEqual([
      'permissions.onAdded',
      'permissions.onRemoved',
      'runtime.onConnect',
      'storage.onChanged',
      'tabs.onActivated',
      'tabs.onRemoved',
      'tabs.onReplaced',
      'windows.onFocusChanged',
    ]);
  });

  it('stays off (no native port) while disabled', async () => {
    const { env, bridge } = harness();
    await bridge.start();
    expect(env.chrome.runtime.connectNative).not.toHaveBeenCalled();
    expect(bridge.status()).toEqual({ enabled: false, permission: true, host: 'off', sessions: [], extensionId: EXT_ID });
  });

  it('connects at startup when enabled and permitted (worker restart)', async () => {
    const { env, bridge } = harness({ settings: { claudeBridge: true } });
    expect(bridge.status().host).toBe('connecting');
    await bridge.start();
    expect(env.ports).toHaveLength(1);
    expect(env.ports[0]!.posted[0]).toMatchObject({ t: 'hello', v: 1, extensionId: EXT_ID, extensionVersion: '0.2.0' });
    env.ports[0]!.receive({ t: 'hello', v: 1, hostVersion: '0.2.0' });
    env.ports[0]!.receive({ t: 'sessions', sessions: [{ id: 's1', label: 'shop', cwd: '/w/shop', pid: 1, connectedAt: 2 }] });
    expect(bridge.status()).toMatchObject({ enabled: true, permission: true, host: 'connected', hostVersion: '0.2.0', sessions: [{ id: 's1' }] });
  });

  it('follows the setting: connects when enabled, disconnects when disabled', async () => {
    const { env, bridge, setSettings } = harness();
    await bridge.start();
    setSettings({ claudeBridge: true });
    expect(env.ports).toHaveLength(1);
    setSettings({ claudeBridge: false });
    expect(env.ports[0]!.disconnected).toBe(true);
    expect(bridge.status().host).toBe('off');
  });

  it('needs the permission, and reacts to it being granted or removed', async () => {
    const { env, bridge } = harness({ granted: false, settings: { claudeBridge: true } });
    await bridge.start();
    expect(env.chrome.runtime.connectNative).not.toHaveBeenCalled();
    expect(bridge.status()).toMatchObject({ enabled: true, permission: false, host: 'off' });
    env.grant(true);
    env.fire('permissions.onAdded', { permissions: ['nativeMessaging'] });
    await vi.waitFor(() => expect(env.ports).toHaveLength(1));
    env.grant(false);
    env.fire('permissions.onRemoved', { permissions: ['nativeMessaging'] });
    await vi.waitFor(() => expect(env.ports[0]!.disconnected).toBe(true));
    expect(bridge.status()).toMatchObject({ permission: false, host: 'off' });
  });

  it('reports a missing host as not-installed', async () => {
    const { env, bridge } = harness({ settings: { claudeBridge: true } });
    await bridge.start();
    env.chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
    env.ports[0]!.close();
    env.chrome.runtime.lastError = undefined;
    expect(bridge.status()).toMatchObject({ host: 'not-installed', error: expect.stringContaining(`--extension-id ${EXT_ID}`) });
  });

  it('answers relayed calls, rejecting unknown methods', async () => {
    const { env, bridge } = harness({ settings: { claudeBridge: true } });
    await bridge.start();
    const port = env.ports[0]!;
    port.receive({ t: 'hello', v: 1, hostVersion: '1' });
    port.receive({ t: 'req', id: 'r1', sessionId: 's', method: 'eval', params: {} });
    port.receive({ t: 'req', id: 'r2', sessionId: 's', method: 'status', params: {} });
    port.receive({ t: 'req', id: 'r3', sessionId: 's', method: 'getRequest', params: { id: 'x', extra: 1 } });
    await vi.waitFor(() => expect(port.posted.filter((m) => m.t === 'res')).toHaveLength(3));
    const res = Object.fromEntries(port.posted.filter((m) => m.t === 'res').map((m) => [m.id, m]));
    expect(res.r1).toEqual({ t: 'res', id: 'r1', ok: false, error: 'Unknown method "eval"' });
    expect(res.r2).toMatchObject({ ok: true, result: { extensionVersion: '0.2.0', allowSend: false, shareSecrets: false } });
    expect(res.r3).toMatchObject({ ok: false, error: 'unknown parameter "extra" for getRequest' });
  });

  it('sends the status to a panel on hello and broadcasts changes', async () => {
    const { env, bridge, setSettings } = harness();
    await bridge.start();
    const link = new FakeLinkPort();
    env.fire('runtime.onConnect', link);
    link.send({ t: 'hello', v: 1, tabId: 4 });
    expect(link.posted[0]).toEqual({ t: 'status', status: bridge.status() });
    setSettings({ claudeBridge: true });
    expect(link.posted[link.posted.length - 1]).toMatchObject({ t: 'status', status: { enabled: true, host: 'connecting' } });
    const count = link.posted.length;
    setSettings({ claudeAllowSend: true }); // status unchanged: nothing sent
    expect(link.posted).toHaveLength(count);
  });

  it('relays a panel push to the hub', async () => {
    const { env, bridge, setSettings } = harness();
    await bridge.start();
    setSettings({ claudeBridge: true });
    const native = env.ports[0]!;
    native.receive({ t: 'hello', v: 1, hostVersion: '1' });
    native.receive({ t: 'sessions', sessions: [{ id: 's1', label: 'shop', cwd: '/w/shop', pid: 1, connectedAt: 2 }] });
    const link = new FakeLinkPort();
    env.fire('runtime.onConnect', link);
    link.send({ t: 'hello', v: 1, tabId: 4 });
    link.send({ t: 'push', id: 1, item: { entryId: 'h:0:1', title: 'POST /x', target: 'client', prompt: '# P' } });
    await vi.waitFor(() => expect(link.posted.find((m) => m.t === 'push-result')).toEqual({ t: 'push-result', id: 1, ok: true, delivered: 1 }));
    const push = native.posted.find((m) => m.t === 'push') as { item: Record<string, unknown> };
    expect(push.item).toMatchObject({ entryId: 'h:0:1', tabId: 4, target: 'client', prompt: '# P' });
    expect(typeof push.item.id).toBe('string');
    expect(typeof push.item.sentAt).toBe('number');
  });

  it('tracks the default tab from tab activation and overlay opening, persisting the order', async () => {
    const { env, bridge, open } = harness({ open: [4, 9] });
    await bridge.start();
    env.fire('tabs.onActivated', { tabId: 9, windowId: 1 });
    await vi.waitFor(() => expect(bridge.activity.ordered()).toEqual([9]));
    env.fire('storage.onChanged', { [tabStateKey(4)]: { newValue: { open: true, recording: true, preserveLog: false } } }, 'session');
    await vi.waitFor(() => expect(bridge.activity.ordered()).toEqual([4, 9]));
    env.fire('tabs.onActivated', { tabId: 12, windowId: 1 }); // overlay not open there
    env.fire('windows.onFocusChanged', -1);
    await Promise.resolve();
    expect(bridge.activity.ordered()).toEqual([4, 9]);
    vi.advanceTimersByTime(600);
    expect(env.session['reqlens:claude:activity']).toEqual([4, 9]);
    env.fire('tabs.onRemoved', 4);
    expect(bridge.activity.ordered()).toEqual([9]);
    open.add(20);
    env.fire('tabs.onReplaced', 20, 9);
    expect(bridge.activity.ordered()).toEqual([20]);
  });
});
