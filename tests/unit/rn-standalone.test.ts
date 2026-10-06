// React Native in the extension pages: settings sanitizer (rnEnabled / rnListenLan / rnPort), the shared
// validators, the standalone tab's bridge (per-app stores, target switching, WebSocket mapping, replays) and the
// Settings status view.
import { describe, expect, it } from 'vitest';
import { sanitizeSettings } from '../../src/content/settings';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import {
  parseRnHello,
  rnSessionLabel,
  rnSetupSnippet,
  rnWsHookId,
  sanitizeRnClientMessage,
  sanitizeRnPort,
} from '../../src/shared/rn-protocol';
import type { RnSessionInfo, RnStatus, StandaloneToWorker } from '../../src/shared/rn-protocol';
import type { ReplayRequest, Settings, SettingsPatch } from '../../src/shared/types';
import { StandaloneBridge, rnWsEvents } from '../../src/ui/standalone/bridge';
import { rnStatusView } from '../../src/ui/rn/view';
import { replayModeName, setShellMode } from '../../src/ui/shellMode';
import { modeLabel } from '../../src/ui/response/results-model';

describe('settings sanitizer: React Native', () => {
  it('defaults to off, loopback, port 8790', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ rnEnabled: false, rnListenLan: false, rnPort: 8790 });
    expect(sanitizeSettings(null)).toMatchObject({ rnEnabled: false, rnListenLan: false, rnPort: 8790 });
  });

  it('keeps valid values and replaces garbage', () => {
    expect(sanitizeSettings({ rnEnabled: true, rnListenLan: true, rnPort: 9100 })).toMatchObject({ rnEnabled: true, rnListenLan: true, rnPort: 9100 });
    expect(sanitizeSettings({ rnEnabled: 'yes', rnListenLan: 1, rnPort: 80 })).toMatchObject({ rnEnabled: false, rnListenLan: false, rnPort: 8790 });
    for (const port of [0, 1023, 65536, 8790.5, '9000', NaN, null]) expect(sanitizeRnPort(port)).toBe(8790);
    expect(sanitizeRnPort(1024)).toBe(1024);
    expect(sanitizeRnPort(65535)).toBe(65535);
  });
});

describe('shared validators', () => {
  it('parses hello and rebuilds app info', () => {
    expect(parseRnHello({ t: 'hello', v: 1, token: 't', session: 'bad session', app: {} })).toBeNull();
    const hello = parseRnHello({ t: 'hello', v: 1, token: 'tok', session: 's1', app: { name: 'A', platform: 'weird', hermes: 'yes', emulator: true }, lib: {}, capabilities: ['http', 3] });
    expect(hello).toEqual({
      session: 's1',
      token: 'tok',
      app: { name: 'A', bundleId: '', platform: 'ios', rnVersion: '', hermes: false, deviceName: '', emulator: true },
      lib: { name: '', version: '' },
      capabilities: ['http'],
    });
  });

  it('normalizes React Native file parts (size -1) so the store accepts them', () => {
    const msg = sanitizeRnClientMessage({
      t: 'start',
      data: {
        hookId: 's1:1',
        kind: 'fetch',
        method: 'POST',
        url: 'https://x.example/upload',
        headers: [],
        body: { kind: 'formData', entries: [{ name: 'f', type: 'file', fileName: 'a.jpg', mime: 'image/jpeg', size: -1, truncated: true, uri: 'file:///a.jpg' }] },
        contentType: 'multipart/form-data',
        startTime: 1,
        frameUrl: '',
        options: { credentials: 'include', timeout: 5, responseType: 'blob' },
      },
    });
    expect(msg).toMatchObject({
      t: 'start',
      data: { body: { kind: 'formData', entries: [{ name: 'f', type: 'file', fileName: 'a.jpg', mime: 'image/jpeg', size: 0, truncated: true }] }, options: { credentials: 'include', responseType: 'blob' } },
    });
    expect(JSON.stringify(msg)).not.toContain('file:///');
  });

  it('cuts oversized WebSocket payloads and keeps base64 aligned', () => {
    const msg = sanitizeRnClientMessage({ t: 'ws-frame', data: { wsId: 's1:ws1', dir: 'in', opcode: 'binary', base64: 'QUJD'.repeat(600_000) + 'QQ', size: 3, time: 1 } });
    const data = (msg as { data: { base64: string; truncated: boolean; size: number } }).data;
    expect(data.base64.length % 4).toBe(0);
    expect(data.truncated).toBe(true);
    expect(sanitizeRnClientMessage({ t: 'ws-frame', data: { wsId: 's1:ws1', dir: 'up', opcode: 'text', text: 'x', size: 1, time: 1 } })).toBeNull();
  });

  it('labels, snippet and ids', () => {
    expect(rnSessionLabel({ app: { name: 'Demo', bundleId: '', platform: 'android', rnVersion: '', hermes: true, deviceName: 'Pixel 8' } })).toBe('Demo · Android · Pixel 8');
    expect(rnSetupSnippet("abc'); evil()//")).toBe("if (__DEV__) require('@kinebot/kinereqlens-react-native').startKineReqLens({ token: 'abcevil' })");
    expect(rnWsHookId('k3j9:ws12')).toBe('k3j9_ws12');
  });
});

interface Harness {
  bridge: StandaloneBridge;
  posted: StandaloneToWorker[];
  flush(): void;
}

function harness(): Harness {
  let settings: Settings = { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_SETTINGS.layout } };
  const listeners = new Set<(s: Settings) => void>();
  const queue: Array<() => void> = [];
  const posted: StandaloneToWorker[] = [];
  const bridge = new StandaloneBridge({
    settings: {
      get: () => settings,
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      update: async (patch: SettingsPatch) => (settings = { ...settings, ...(patch as Partial<Settings>), layout: settings.layout }),
    },
    post: (m) => void posted.push(m),
    schedule: (fn) => void queue.push(fn),
    now: () => 5000,
    version: 'test',
  });
  return { bridge, posted, flush: () => queue.splice(0).forEach((fn) => fn()) };
}

const info = (session: string, name: string, connectedAt = 1, connected = true): RnSessionInfo => ({
  session,
  app: { name, bundleId: `com.${name.toLowerCase()}`, platform: 'ios', rnVersion: '0.76.3', hermes: true, deviceName: 'iPhone 15' },
  lib: { name: 'lib', version: '0.1.0' },
  capabilities: [],
  connected,
  connectedAt,
  address: '',
});

const status = (...sessions: RnSessionInfo[]): RnStatus => ({ enabled: true, permission: true, host: 'connected', receiver: null, sessions, extensionId: 'x' });

const start = (session: string, n: number, url = `https://api.example.com/${n}`) => ({
  t: 'start' as const,
  data: { hookId: `${session}:${n}`, kind: 'fetch', method: 'GET', url, headers: [], body: null, contentType: null, startTime: n, frameUrl: '' },
});
const end = (session: string, n: number) => ({ t: 'end' as const, data: { hookId: `${session}:${n}`, state: 'done', status: 200, endTime: n + 1, body: { kind: 'text', text: 'ok', size: 2 } } });

describe('StandaloneBridge', () => {
  it('keeps one store per app and shows the selected one', () => {
    const h = harness();
    h.bridge.handle({ t: 'status', status: status(info('a1', 'Alpha', 1), info('b1', 'Beta', 2)) });
    expect(h.bridge.currentSession).toBe('b1'); // most recently connected
    h.bridge.handle({ t: 'captures', session: 'a1', msgs: [start('a1', 1), end('a1', 1)] });
    h.bridge.handle({ t: 'captures', session: 'b1', msgs: [start('b1', 1), start('b1', 2)] });
    h.flush();
    expect(h.bridge.getEntries().map((e) => e.id)).toEqual(['h:0:b1:1', 'h:0:b1:2']);
    expect(h.bridge.getTargets().map((t) => [t.session, t.entries, t.connected])).toEqual([
      ['a1', 1, true],
      ['b1', 2, true],
    ]);
    let notified = 0;
    h.bridge.subscribeEntries(() => notified++);
    h.bridge.select('a1');
    expect(notified).toBe(1);
    const [entry] = h.bridge.getEntries();
    expect(entry).toMatchObject({ id: 'h:0:a1:1', state: 'done', status: 200, responseBody: { kind: 'text', text: 'ok' }, pageUrl: 'react-native://com.alpha' });
    expect(h.bridge.getCaptureInfo()).toMatchObject({ hookConnected: true, lateInjection: false });
  });

  it('a re-sent buffer does not duplicate entries or WebSocket frames', () => {
    const h = harness();
    const msgs = [
      start('s1', 1),
      { t: 'ws-open' as const, data: { wsId: 's1:ws1', url: 'wss://echo.example/', protocols: [], time: 1 } },
      { t: 'ws-ready' as const, data: { wsId: 's1:ws1', protocol: '', extensions: '', time: 2 } },
      { t: 'ws-frame' as const, data: { wsId: 's1:ws1', dir: 'out' as const, opcode: 'text' as const, text: 'hi', size: 2, truncated: false, time: 3 } },
    ];
    h.bridge.handle({ t: 'captures', session: 's1', msgs, reset: true });
    h.bridge.handle({ t: 'captures', session: 's1', msgs, reset: true });
    h.flush();
    expect(h.bridge.getEntries()).toHaveLength(1);
    const snapshot = h.bridge.ws.snapshot();
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0]).toMatchObject({ wsId: '0:s1_ws1', url: 'wss://echo.example/', state: 'open', sent: 1 });
    expect(snapshot.frames.map((f) => f.text)).toEqual(['hi']);
  });

  it('maps the app WebSocket messages to inspector events', () => {
    expect(
      rnWsEvents([
        { t: 'ws-error', data: { wsId: 'a:ws1', message: 'x', time: 4 } },
        { t: 'ws-close', data: { wsId: 'a:ws1', code: 1000, reason: 'bye', wasClean: true, initiator: 'client', time: 5 } },
        { t: 'ws-frame', data: { wsId: 'a:ws1', dir: 'in', opcode: 'binary', base64: 'AQID', size: 3, truncated: false, time: 6 } },
      ]),
    ).toEqual([
      { e: 'error', id: 'a_ws1', time: 4 },
      { e: 'closing', id: 'a_ws1', time: 5, code: 1000, reason: 'bye' },
      { e: 'close', id: 'a_ws1', time: 5, code: 1000, reason: 'bye', wasClean: true },
      { e: 'frame', id: 'a_ws1', time: 6, dir: 'in', opcode: 'binary', size: 3, truncated: false, base64: 'AQID' },
    ]);
  });

  it('drops invalid captures, pauses with recording off, and clears through the worker', () => {
    const h = harness();
    h.bridge.handle({ t: 'captures', session: 's1', msgs: [start('s1', 1), { t: 'start', data: { hookId: 's1:2', kind: 'fetch', method: 'G T', url: '' } }] });
    h.flush();
    expect(h.bridge.getEntries()).toHaveLength(1);
    void h.bridge.setTabState({ recording: false, open: false });
    expect(h.bridge.getTabState()).toEqual({ open: true, recording: false, preserveLog: false });
    h.bridge.handle({ t: 'captures', session: 's1', msgs: [start('s1', 3)] });
    h.flush();
    expect(h.bridge.getEntries()).toHaveLength(1);
    h.bridge.clearEntries();
    h.flush();
    expect(h.bridge.getEntries()).toHaveLength(0);
    expect(h.posted).toContainEqual({ t: 'clear', session: 's1' });
  });

  it('sends replays for the entry session and binds the answer to the request', async () => {
    const h = harness();
    h.bridge.handle({ t: 'captures', session: 's1', msgs: [start('s1', 1)] });
    h.flush();
    const req: ReplayRequest = {
      runId: 'r1',
      entryId: 'h:0:s1:1',
      mode: 'page',
      frameId: 0,
      method: 'GET',
      url: 'https://api.example.com/1',
      headers: [],
      body: { kind: 'none' },
      credentials: 'include',
      redirect: 'follow',
      timeoutMs: 1000,
      responseBodyCap: 4,
    };
    const pending = h.bridge.replay(req);
    const call = h.posted.find((m) => m.t === 'call') as Extract<StandaloneToWorker, { t: 'call' }>;
    expect(call).toMatchObject({ method: 'replay', args: ['s1', req] });
    h.bridge.handle({ t: 'result', id: call.id, ok: true, value: { runId: 'other', ok: true, status: 200, headers: [], body: { kind: 'text', text: 'abcdefgh', size: 8 }, url: req.url, timing: { start: 1, end: 2 }, size: 8 } });
    const result = await pending;
    expect(result).toMatchObject({ runId: 'r1', ok: true, status: 200, body: { kind: 'text', truncated: true } });
    h.bridge.disconnected();
    expect((await h.bridge.replay({ ...req, runId: 'r2' })).ok).toBe(false);
  });

  it('WebSocket sends through the app are refused', async () => {
    expect(await harness().bridge.ws.send()).toEqual({ ok: false, error: "Sending through the app's WebSockets is not supported" });
  });
});

describe('UI wording', () => {
  it('names the page mode "App" in the standalone tab', () => {
    expect(modeLabel('page')).toBe('Page');
    setShellMode('standalone');
    try {
      expect(replayModeName('page')).toBe('App');
      expect(modeLabel('page')).toBe('App');
      expect(modeLabel('extension')).toBe('Extension');
    } finally {
      setShellMode('overlay');
    }
  });

  it('status pill', () => {
    const base: RnStatus = { enabled: true, permission: true, host: 'connected', receiver: null, sessions: [], extensionId: 'x' };
    expect(rnStatusView(base, false).state).toBe('off');
    expect(rnStatusView({ ...base, permission: false }, true).state).toBe('permission');
    expect(rnStatusView({ ...base, host: 'not-installed', hostError: 'run install' }, true)).toMatchObject({ state: 'not-installed', detail: 'run install' });
    expect(rnStatusView(base, true).state).toBe('connecting');
    const receiver = { state: 'listening' as const, host: '127.0.0.1', port: 8790, lan: false, addresses: [], token: 't' };
    expect(rnStatusView({ ...base, receiver, sessions: [info('a', 'A')] }, true)).toMatchObject({ state: 'listening', label: 'Listening on 127.0.0.1:8790 · 1 app' });
    expect(rnStatusView({ ...base, receiver: { ...receiver, state: 'error', error: 'Port 8790 is already in use' } }, true)).toMatchObject({ state: 'error', detail: 'Port 8790 is already in use' });
  });
});
