import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HELLO_TIMEOUT_MS,
  NativeHostLink,
  classifyDisconnect,
  parseHostMessage,
  reconnectDelayMs,
} from '../../src/background/claude/native';
import type { HostRequest, NativeDeps, NativePort } from '../../src/background/claude/native';
import type { InboxItem } from '../../src/shared/claude-protocol';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

class FakePort implements NativePort {
  posted: unknown[] = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** The host sends a message. */
  receive(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  /** The host goes away (browser side fires onDisconnect). */
  close(): void {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) fn();
  }
}

function harness(opts: { connectThrows?: boolean } = {}) {
  const ports: FakePort[] = [];
  let lastError: string | undefined;
  const changes = vi.fn();
  const requests: HostRequest[] = [];
  const deps: NativeDeps = {
    extensionId: EXT_ID,
    connect: vi.fn((name: string) => {
      expect(name).toBe('com.reqlens.bridge');
      if (opts.connectThrows) throw new Error('chrome.runtime.connectNative is not a function');
      const port = new FakePort();
      ports.push(port);
      return port;
    }),
    lastError: () => lastError,
    hello: () => ({ extensionVersion: '0.2.0', browser: 'Microsoft Edge 131' }),
    onRequest: async (req) => {
      requests.push(req);
      return { t: 'res', id: req.id, ok: true, result: { echo: req.method } };
    },
    onChange: changes,
  };
  const link = new NativeHostLink(deps);
  return {
    link,
    ports,
    changes,
    requests,
    deps,
    setLastError: (message: string | undefined) => (lastError = message),
    port: () => ports[ports.length - 1]!,
  };
}

const session = (id: string) => ({ id, label: 'proj', cwd: '/home/u/proj', pid: 42, connectedAt: 1 });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnectDelayMs', () => {
  it('backs off from 1 s, doubling, capped at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('treats garbage attempts as the first attempt', () => {
    expect(reconnectDelayMs(-3)).toBe(1000);
    expect(reconnectDelayMs(Number.NaN)).toBe(1000);
    expect(reconnectDelayMs(Number.POSITIVE_INFINITY)).toBe(1000);
  });
});

describe('classifyDisconnect', () => {
  it('maps "host not found" to not-installed with the install command', () => {
    const reason = classifyDisconnect('Specified native messaging host not found.', EXT_ID);
    expect(reason.host).toBe('not-installed');
    expect(reason.error).toContain(`npm run mcp:install -- --extension-id ${EXT_ID}`);
  });

  it('maps everything else to error', () => {
    expect(classifyDisconnect('Access to the specified native messaging host is forbidden.', EXT_ID)).toMatchObject({ host: 'error' });
    expect(classifyDisconnect('Access to the specified native messaging host is forbidden.', EXT_ID).error).toContain('--extension-id');
    expect(classifyDisconnect('Native host has exited.', EXT_ID)).toMatchObject({ host: 'error', error: expect.stringContaining('exited') });
    expect(classifyDisconnect('Error when communicating with the native messaging host.', EXT_ID)).toEqual({
      host: 'error',
      error: 'Error when communicating with the native messaging host.',
    });
    expect(classifyDisconnect(undefined, EXT_ID)).toEqual({ host: 'error', error: 'The kineReqLens bridge disconnected' });
  });
});

describe('parseHostMessage', () => {
  it('accepts hello, sessions and req', () => {
    expect(parseHostMessage({ t: 'hello', v: 1, hostVersion: '0.2.0' })).toEqual({ t: 'hello', v: 1, hostVersion: '0.2.0' });
    expect(parseHostMessage({ t: 'sessions', sessions: [session('a'), { id: 'bad' }, session('a'), session('b')] })).toEqual({
      t: 'sessions',
      sessions: [session('a'), session('b')],
    });
    expect(parseHostMessage({ t: 'req', id: 'r1', sessionId: 's1', method: 'status', params: {} })).toEqual({
      t: 'req',
      req: { id: 'r1', sessionId: 's1', method: 'status', params: {} },
    });
  });

  it('turns an unsolicited error answer into a host error', () => {
    expect(parseHostMessage({ t: 'res', id: '', ok: false, error: 'Another browser is already connected to Claude Code' })).toEqual({
      t: 'host-error',
      error: 'Another browser is already connected to Claude Code',
    });
  });

  it('turns a hello carrying an error (what reqlens-mcp native-host sends before exiting) into a host error', () => {
    expect(parseHostMessage({ t: 'hello', v: 1, hostVersion: '0.1.0', error: 'Another browser is already connected to Claude Code' })).toEqual({
      t: 'host-error',
      error: 'Another browser is already connected to Claude Code',
    });
    expect(parseHostMessage({ t: 'hello', v: 1, hostVersion: '0.1.0', error: '' })).toEqual({ t: 'host-error', error: 'The kineReqLens bridge could not start' });
    expect(parseHostMessage({ t: 'hello', v: 1, hostVersion: '0.1.0', error: 'x'.repeat(5000) })).toEqual({ t: 'host-error', error: 'The kineReqLens bridge could not start' });
  });

  it('ignores malformed messages', () => {
    for (const bad of [null, 'x', [], { t: 'hello' }, { t: 'req', id: 'x'.repeat(200) }, { t: 'req' }, { t: 'res', ok: true }, { t: 'nope' }, { t: 'sessions', sessions: 3 }]) {
      expect(parseHostMessage(bad)).toBeNull();
    }
  });

  it('bounds the session list', () => {
    const many = Array.from({ length: 100 }, (_, i) => session(`s${i}`));
    const parsed = parseHostMessage({ t: 'sessions', sessions: many });
    expect(parsed?.t === 'sessions' && parsed.sessions.length).toBe(64);
  });
});

describe('NativeHostLink', () => {
  it('connects when wanted, sends hello, becomes connected on the host hello', () => {
    const h = harness();
    h.link.setWanted(true);
    expect(h.link.state.host).toBe('connecting');
    expect(h.port().posted[0]).toEqual({ t: 'hello', v: 1, extensionId: EXT_ID, extensionVersion: '0.2.0', browser: 'Microsoft Edge 131' });
    h.port().receive({ t: 'hello', v: 1, hostVersion: '0.2.0' });
    expect(h.link.state).toMatchObject({ host: 'connected', hostVersion: '0.2.0', sessions: [] });
    h.port().receive({ t: 'sessions', sessions: [session('s1')] });
    expect(h.link.state.sessions).toEqual([session('s1')]);
    expect(h.changes).toHaveBeenCalled();
  });

  it('answers relayed requests on the same port', async () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().receive({ t: 'hello', v: 1, hostVersion: '1' });
    h.port().receive({ t: 'req', id: 'r1', sessionId: 's1', method: 'status', params: {} });
    await vi.waitFor(() => expect(h.port().posted).toContainEqual({ t: 'res', id: 'r1', ok: true, result: { echo: 'status' } }));
    expect(h.requests[0]).toEqual({ id: 'r1', sessionId: 's1', method: 'status', params: {} });
  });

  it('classifies a missing host as not-installed and retries with backoff while wanted', () => {
    const h = harness();
    h.link.setWanted(true);
    h.setLastError('Specified native messaging host not found.');
    h.port().close();
    expect(h.link.state.host).toBe('not-installed');
    expect(h.link.state.error).toContain('mcp:install');
    expect(h.ports).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(h.ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.ports).toHaveLength(2);
    h.port().close();
    vi.advanceTimersByTime(1999);
    expect(h.ports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.ports).toHaveLength(3);
  });

  it('resets the backoff after a successful hello', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().close();
    vi.advanceTimersByTime(1000);
    h.port().close();
    vi.advanceTimersByTime(2000);
    h.port().receive({ t: 'hello', v: 1, hostVersion: '1' });
    h.setLastError('Native host has exited.');
    h.port().close();
    expect(h.link.state.host).toBe('error');
    const before = h.ports.length;
    vi.advanceTimersByTime(1000);
    expect(h.ports.length).toBe(before + 1);
  });

  it('keeps the error the hub reported over the generic exit message', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().receive({ t: 'res', id: '', ok: false, error: 'Another browser is already connected to Claude Code' });
    expect(h.link.state).toMatchObject({ host: 'error', error: 'Another browser is already connected to Claude Code' });
    h.setLastError('Native host has exited.');
    h.port().close();
    expect(h.link.state.error).toBe('Another browser is already connected to Claude Code');
  });

  it('never reports connected for a hub hello that carries an error', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().receive({ t: 'hello', v: 1, hostVersion: '0.1.0', error: 'Another browser is already connected to Claude Code' });
    expect(h.link.state).toMatchObject({ host: 'error', error: 'Another browser is already connected to Claude Code' });
    h.setLastError('Native host has exited.');
    h.port().close();
    expect(h.link.state).toMatchObject({ host: 'error', error: 'Another browser is already connected to Claude Code' });
  });

  it('disconnects and goes off when no longer wanted, without retrying', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().receive({ t: 'hello', v: 1, hostVersion: '1' });
    h.port().receive({ t: 'sessions', sessions: [session('s1')] });
    h.link.setWanted(false);
    expect(h.port().disconnected).toBe(true);
    expect(h.link.state).toEqual({ host: 'off', sessions: [] });
    vi.advanceTimersByTime(60_000);
    expect(h.ports).toHaveLength(1);
  });

  it('cancels a pending retry when disabled', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().close();
    h.link.setWanted(false);
    vi.advanceTimersByTime(60_000);
    expect(h.ports).toHaveLength(1);
    expect(h.link.state.host).toBe('off');
  });

  it('gives up on a host that never says hello', () => {
    const h = harness();
    h.link.setWanted(true);
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS);
    expect(h.ports[0]!.disconnected).toBe(true);
    expect(h.link.state).toMatchObject({ host: 'error', error: 'The kineReqLens bridge did not answer' });
    vi.advanceTimersByTime(1000);
    expect(h.ports).toHaveLength(2);
  });

  it('reports a connect that throws as an error and retries', () => {
    const h = harness({ connectThrows: true });
    h.link.setWanted(true);
    expect(h.link.state.host).toBe('error');
    expect(h.link.state.error).toContain('connectNative');
    vi.advanceTimersByTime(1000);
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
  });

  it('retryNow skips the backoff wait', () => {
    const h = harness();
    h.link.setWanted(true);
    h.port().close();
    h.link.retryNow();
    expect(h.ports).toHaveLength(2);
    // The cancelled 1 s timer does not connect a second time (the hello timeout is 10 s).
    vi.advanceTimersByTime(5_000);
    expect(h.ports).toHaveLength(2);
  });

  it('ignores events of a port it already replaced', () => {
    const h = harness();
    h.link.setWanted(true);
    const first = h.port();
    h.link.setWanted(false);
    h.link.setWanted(true);
    first.receive({ t: 'hello', v: 1, hostVersion: 'old' });
    first.close();
    expect(h.link.state.host).toBe('connecting');
  });

  describe('push', () => {
    const item = (sessionId?: string | null): InboxItem => ({
      id: 'i1',
      sentAt: 1,
      tabId: 3,
      entryId: 'h:0:1',
      title: 'POST /api/orders',
      target: 'client',
      prompt: '# Prompt',
      ...(sessionId !== undefined ? { sessionId } : {}),
    });

    it('refuses while not connected', () => {
      const h = harness();
      expect(h.link.push(item())).toMatchObject({ ok: false, delivered: 0 });
    });

    it('delivers to every session or to the addressed one', () => {
      const h = harness();
      h.link.setWanted(true);
      h.port().receive({ t: 'hello', v: 1, hostVersion: '1' });
      expect(h.link.push(item())).toMatchObject({ ok: false, error: expect.stringContaining('No Claude Code session') });
      h.port().receive({ t: 'sessions', sessions: [session('s1'), session('s2')] });
      expect(h.link.push(item())).toEqual({ ok: true, delivered: 2 });
      expect(h.link.push(item('s2'))).toEqual({ ok: true, delivered: 1 });
      expect(h.link.push(item('gone'))).toMatchObject({ ok: false, error: expect.stringContaining('no longer connected') });
      expect(h.port().posted.filter((m) => (m as { t: string }).t === 'push')).toHaveLength(2);
    });
  });
});
