// React Native receiver of the hub (mcp/src/rn/**): the real hub in-process with a fake native messaging client,
// apps simulated by raw WebSocket clients (Node's WebSocket) and by the real RN package runtime
// (react-native/src) over React Native fakes (react-native/test/rn-fakes.ts).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostToExtension } from '../../../src/shared/claude-protocol';
import type { RnCaptureMessage, RnReceiverStatus } from '../../../src/shared/rn-protocol';
import { sanitizeRnClientMessage } from '../../../src/shared/rn-protocol';
import { parseRnExtensionMessage } from '../messages';
import { FrameDecoder, encodeFrame } from '../rn/ws';
import type { FakeExtension } from './helpers';
import { removeDir, sleep, startHub, tempDir, waitFor } from './helpers';

// The RN package is type-checked by its own tsconfig (DOM lib): imported through non-literal specifiers.
interface RnHandle {
  session: string;
  stop(): void;
  openUi(): void;
}
interface RnGlobal {
  fetch(input: unknown, init?: Record<string, unknown>): Promise<{ text(): Promise<string>; status: number }>;
  network: { handler: (req: { method: string; url: string; headers: Record<string, string> }) => unknown; requests: Array<{ url: string; method: string; headers: Record<string, string> }> };
}
interface RnModule {
  startKineReqLens(options: Record<string, unknown>): RnHandle | null;
  stopKineReqLens(): void;
}
interface FakesModule {
  makeRnGlobal(): RnGlobal;
  fakeReactNative(options?: Record<string, unknown>): unknown;
  FakeFileReader: unknown;
}
const rnIndex = '../../../react-native/src/index.ts';
const rnFakes = '../../../react-native/test/rn-fakes.ts';
const loadRn = async (): Promise<{ rn: RnModule; fakes: FakesModule }> => ({
  rn: (await import(/* @vite-ignore */ rnIndex)) as RnModule,
  fakes: (await import(/* @vite-ignore */ rnFakes)) as FakesModule,
});

let root: string;
let home: string;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  root = tempDir('rl-rn-');
  home = path.join(root, 'home');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeDir(root);
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Msg = HostToExtension & Record<string, unknown>;

function statuses(ext: FakeExtension): RnReceiverStatus[] {
  return (ext.received as Msg[]).filter((m) => m.t === 'rn-status').map((m) => m.status as RnReceiverStatus);
}

/** Every capture message of a session, chunks reassembled, in order. */
function captures(ext: FakeExtension, session?: string): RnCaptureMessage[] {
  const out: RnCaptureMessage[] = [];
  const parts = new Map<string, string[]>();
  for (const raw of ext.received as Msg[]) {
    let m: Msg | null = raw;
    if (raw.t === 'rn-chunk') {
      const list = parts.get(raw.id as string) ?? [];
      list[raw.seq as number] = raw.part as string;
      parts.set(raw.id as string, list);
      m = list.filter((p) => p !== undefined).length === raw.total ? (JSON.parse(list.join('')) as Msg) : null;
    }
    if (m && m.t === 'rn-capture' && (!session || m.session === session)) out.push(...(m.msgs as RnCaptureMessage[]));
  }
  return out;
}

async function hubWithReceiver(extra: Parameters<typeof startHub>[1] = {}): Promise<{ ext: FakeExtension; port: number; token: string; hub: Awaited<ReturnType<typeof startHub>>['hub'] }> {
  const { hub, ext } = await startHub(home, extra);
  cleanups.push(() => hub.stop());
  const port = await freePort();
  ext.send({ t: 'rn-config', enabled: true, lan: false, port });
  const status = await waitFor(() => statuses(ext).find((s) => s.state === 'listening'), 3000, 'receiver listening');
  expect(status).toMatchObject({ host: '127.0.0.1', port, lan: false });
  return { ext, port, token: status.token, hub };
}

/** A raw WebSocket app client. */
async function connect(port: number, pathname = '/kinereqlens'): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<{ code: number }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  const messages: unknown[] = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code })));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  cleanups.push(() => ws.close());
  return { ws, messages, closed };
}

const hello = (token: string, session = 'sess1', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    t: 'hello',
    v: 1,
    token,
    session,
    lib: { name: '@kinebot/kinereqlens-react-native', version: '0.1.0' },
    capabilities: ['http', 'websocket', 'replay', 'open-ui'],
    app: { name: 'DemoApp', bundleId: 'com.example.demo', platform: 'ios', rnVersion: '0.76.3', hermes: true, deviceName: 'iPhone 15' },
    ...extra,
  });

const start = (hookId: string, url = 'https://api.example.com/items') => ({
  t: 'start',
  data: { hookId, kind: 'fetch', method: 'GET', url, headers: [{ name: 'accept', value: '*/*' }], body: null, contentType: null, startTime: 1000, frameUrl: '' },
});

describe('React Native receiver: handshake', () => {
  it('persists a 0600 pairing token and keeps it across restarts', async () => {
    const { token, hub } = await hubWithReceiver();
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const file = path.join(home, 'rn-token');
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await hub.stop();
    const again = await hubWithReceiver();
    expect(again.token).toBe(token);
  });

  it('rejects a wrong token (4001), a non-hello first message and a wrong version (4002), and other paths (404)', async () => {
    const { port, token } = await hubWithReceiver();
    const bad = await connect(port);
    bad.ws.send(hello('wrong-token-wrong-token'));
    expect((await bad.closed).code).toBe(4001);
    expect(bad.messages).toEqual([{ t: 'rejected', reason: 'invalid pairing token', code: 4001 }]);

    const notHello = await connect(port);
    notHello.ws.send(JSON.stringify(start('x:1')));
    expect((await notHello.closed).code).toBe(4002);

    const version = await connect(port);
    version.ws.send(hello(token, 's2', { v: 2 }));
    expect((await version.closed).code).toBe(4002);

    await expect(connect(port, '/other')).rejects.toThrow();
  });

  it('refuses big messages before the handshake (1009)', async () => {
    const { port } = await hubWithReceiver();
    const big = await connect(port);
    big.ws.send('x'.repeat(100_000));
    expect((await big.closed).code).toBe(1009);
  });

  it('closes a connection that never says hello (4003)', async () => {
    const { port } = await hubWithReceiver({ rn: { handshakeTimeoutMs: 100 } });
    const quiet = await connect(port);
    expect((await quiet.closed).code).toBe(4003);
  });

  it('welcomes a valid app, reports the session, and its disconnect', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.find((m) => (m as { t: string }).t === 'welcome'), 3000, 'welcome');
    const session = await waitFor(() => (ext.received as Msg[]).find((m) => m.t === 'rn-session' && m.connected === true), 3000, 'rn-session');
    expect(session).toMatchObject({ session: 'sess1', app: { name: 'DemoApp', platform: 'ios', deviceName: 'iPhone 15' }, connected: true });
    app.ws.close();
    await waitFor(() => (ext.received as Msg[]).find((m) => m.t === 'rn-session' && m.connected === false), 3000, 'disconnect');
  });

  it('regenerating the token disconnects apps and changes the file', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.length > 0, 3000, 'welcome');
    ext.send({ t: 'rn-token', regenerate: true });
    expect((await app.closed).code).toBe(4001);
    const next = await waitFor(() => statuses(ext).find((s) => s.token && s.token !== token), 3000, 'new token');
    expect(fs.readFileSync(path.join(home, 'rn-token'), 'utf8').trim()).toBe(next.token);
  });

  it('stops listening when disabled', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.length > 0, 3000, 'welcome');
    ext.send({ t: 'rn-config', enabled: false, lan: false, port });
    expect((await app.closed).code).toBe(1001);
    await waitFor(() => statuses(ext).at(-1)?.state === 'off', 3000, 'off');
    await expect(connect(port)).rejects.toThrow();
  });
});

describe('React Native receiver: forwarding', () => {
  it('validates app messages: unknown / malformed ones are dropped, the rest rebuilt', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.length > 0, 3000, 'welcome');
    app.ws.send('not json');
    app.ws.send(JSON.stringify({ t: 'log', text: 'x' }));
    app.ws.send(JSON.stringify({ t: 'start', data: { hookId: 'bad id with spaces', kind: 'fetch', method: 'GET', url: 'https://x/', headers: [], body: null, contentType: null, startTime: 1 } }));
    app.ws.send(JSON.stringify({ t: 'start', data: { ...start('sess1:1').data, method: 'GE T' } }));
    const evil = start('sess1:2');
    (evil.data as Record<string, unknown>).extra = 'dropped';
    (evil.data as Record<string, unknown>).headers = [{ name: 'a', value: 'b' }, { name: 1, value: 'x' }, 'junk'];
    app.ws.send(JSON.stringify(evil));
    app.ws.send(JSON.stringify({ t: 'end', data: { hookId: 'sess1:2', state: 'done', status: 200, endTime: 1100, body: { kind: 'text', text: 'ok', size: 2 }, junk: true } }));
    const got = await waitFor(() => (captures(ext).length >= 2 ? captures(ext) : undefined), 3000, 'captures');
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ t: 'start', data: { ...start('sess1:2').data, headers: [{ name: 'a', value: 'b' }] } });
    expect(got[1]).toEqual({ t: 'end', data: { hookId: 'sess1:2', state: 'done', status: 200, endTime: 1100, body: { kind: 'text', text: 'ok', size: 2 } } });
  });

  it('batches messages arriving within the window into one native message', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.length > 0, 3000, 'welcome');
    for (let i = 1; i <= 20; i++) app.ws.send(JSON.stringify(start(`sess1:${i}`, `https://api.example.com/${i}`)));
    await waitFor(() => captures(ext).length === 20, 3000, '20 captures');
    const frames = (ext.received as Msg[]).filter((m) => m.t === 'rn-capture');
    expect(frames.length).toBeLessThanOrEqual(3);
    expect(captures(ext).map((m) => (m as { data: { url: string } }).data.url)).toEqual(Array.from({ length: 20 }, (_, i) => `https://api.example.com/${i + 1}`));
  });

  it('splits batches over the frame budget and chunks single oversized messages', async () => {
    const { port, token, ext } = await hubWithReceiver({ rn: { frameBudget: 4096 } });
    const app = await connect(port);
    app.ws.send(hello(token));
    await waitFor(() => app.messages.length > 0, 3000, 'welcome');
    for (let i = 1; i <= 30; i++) app.ws.send(JSON.stringify(start(`sess1:${i}`, `https://api.example.com/${'p'.repeat(200)}/${i}`)));
    const big = 'é"\\'.repeat(5000) + '😀'.repeat(3000);
    app.ws.send(JSON.stringify({ t: 'end', data: { hookId: 'sess1:1', state: 'done', status: 200, endTime: 2, body: { kind: 'text', text: big, size: 1 } } }));
    await waitFor(() => captures(ext).length === 31, 5000, '31 captures');
    for (const raw of ext.received as Msg[]) expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(4096);
    expect((ext.received as Msg[]).filter((m) => m.t === 'rn-capture').length).toBeGreaterThan(1);
    expect((ext.received as Msg[]).some((m) => m.t === 'rn-chunk')).toBe(true);
    const end = captures(ext).find((m) => m.t === 'end') as unknown as { data: { body: { text: string } } };
    expect(end.data.body.text).toBe(big);
  });

  it('keeps several app sessions apart', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const a = await connect(port);
    const b = await connect(port);
    a.ws.send(hello(token, 'appA'));
    b.ws.send(hello(token, 'appB', { app: { name: 'Other', platform: 'android', deviceName: 'Pixel 8' } }));
    await waitFor(() => a.messages.length > 0 && b.messages.length > 0, 3000, 'welcomes');
    a.ws.send(JSON.stringify(start('appA:1', 'https://a.example/')));
    b.ws.send(JSON.stringify(start('appB:1', 'https://b.example/')));
    await waitFor(() => captures(ext, 'appA').length === 1 && captures(ext, 'appB').length === 1, 3000, 'both');
    expect(((captures(ext, 'appB')[0] as { data: { url: string } }).data).url).toBe('https://b.example/');
    const sessions = (ext.received as Msg[]).filter((m) => m.t === 'rn-session').map((m) => [m.session, (m.app as { platform: string }).platform]);
    expect(sessions).toEqual(expect.arrayContaining([['appA', 'ios'], ['appB', 'android']]));
  });

  it('answers a replay for a disconnected session with an error result', async () => {
    const { ext } = await hubWithReceiver();
    ext.send({ t: 'rn-replay', session: 'gone1', data: { runId: 'run-1', method: 'GET', url: 'https://x.example/', headers: [], body: { kind: 'none' } } });
    const result = await waitFor(() => captures(ext, 'gone1')[0], 3000, 'replay-result');
    expect(result).toMatchObject({ t: 'replay-result', data: { runId: 'run-1', ok: false, error: 'The app is not connected to kineReqLens' } });
  });
});

describe('React Native receiver with the RN package runtime', () => {
  it('captures fetch, opens the UI from the dev menu, and replays inside the app', async () => {
    const { port, token, ext } = await hubWithReceiver();
    const { rn, fakes } = await loadRn();
    // React Native has FileReader (its Blobs need it).
    const g0 = globalThis as { FileReader?: unknown };
    g0.FileReader = fakes.FakeFileReader;
    cleanups.push(() => delete g0.FileReader);
    const g = fakes.makeRnGlobal();
    g.network.handler = (req) =>
      req.url.endsWith('/replayed')
        ? { status: 201, headers: { 'content-type': 'application/json' }, body: '{"replayed":true}' }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[1,2]}' };
    const reactNative = fakes.fakeReactNative() as { DevSettings: { items: Array<{ title: string; handler(): void }> } };
    const handle = rn.startKineReqLens({ token, host: '127.0.0.1', port, enabled: true, global: g, reactNative, log: false, reconnect: { minDelayMs: 20, maxDelayMs: 200 } });
    expect(handle).not.toBeNull();
    cleanups.push(() => rn.stopKineReqLens());

    const session = await waitFor(() => (ext.received as Msg[]).find((m) => m.t === 'rn-session' && m.connected === true), 5000, 'session');
    expect(session.session).toBe(handle!.session);
    const response = await g.fetch('https://api.example.com/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(await response.text()).toBe('{"items":[1,2]}');
    await waitFor(() => captures(ext).some((m) => m.t === 'end'), 5000, 'end');
    const [startMsg, endMsg] = captures(ext).filter((m) => m.t === 'start' || m.t === 'end');
    expect(startMsg).toMatchObject({ t: 'start', data: { kind: 'fetch', method: 'POST', url: 'https://api.example.com/items', body: { kind: 'text', text: '{"a":1}' } } });
    expect(endMsg).toMatchObject({ t: 'end', data: { state: 'done', status: 200, body: { kind: 'text', text: '{"items":[1,2]}' } } });
    // Every forwarded message passes the shared validator unchanged (it is what the hub produced).
    for (const m of captures(ext)) expect(sanitizeRnClientMessage(m)).toEqual(m);

    reactNative.DevSettings.items.find((i) => i.title === 'Open kineReqLens')!.handler();
    await waitFor(() => (ext.received as Msg[]).find((m) => m.t === 'rn-open-ui' && m.session === handle!.session), 3000, 'open-ui');

    ext.send({
      t: 'rn-replay',
      session: handle!.session,
      data: { runId: 'run-7', method: 'PATCH', url: 'https://api.example.com/replayed', headers: [{ name: 'X-Test', value: '1' }], body: { kind: 'text', text: '{"v":2}' }, timeoutMs: 5000 },
    });
    const result = await waitFor(() => captures(ext).find((m) => m.t === 'replay-result'), 5000, 'replay-result');
    expect(result).toMatchObject({ t: 'replay-result', data: { runId: 'run-7', ok: true, status: 201, body: { kind: 'text', text: '{"replayed":true}' } } });
    const sent = g.network.requests.find((r) => r.url.endsWith('/replayed'))!;
    expect(sent.method).toBe('PATCH');
    // Replays run with the app's original fetch and are never captured.
    await sleep(150);
    expect(captures(ext).filter((m) => m.t === 'start')).toHaveLength(1);
  });
});

describe('React Native receiver units', () => {
  it('parses extension control messages strictly', () => {
    expect(parseRnExtensionMessage({ t: 'rn-config', enabled: true, lan: 'yes', port: 80 })).toEqual({ t: 'rn-config', enabled: true, lan: false, port: 8790 });
    expect(parseRnExtensionMessage({ t: 'rn-config', enabled: 1 })).toBeNull();
    expect(parseRnExtensionMessage({ t: 'rn-replay', session: 'bad session', data: {} })).toBeNull();
    expect(parseRnExtensionMessage({ t: 'rn-replay', session: 's1', data: { runId: 'r', method: 'GET', url: 'https://x/', headers: [], body: { kind: 'weird' } } })).toBeNull();
    expect(parseRnExtensionMessage({ t: 'rn-abort', session: 's1', runId: 'r1' })).toEqual({ t: 'rn-abort', session: 's1', runId: 'r1' });
    expect(parseRnExtensionMessage({ t: 'rn-token', regenerate: false })).toBeNull();
  });

  it('decodes fragmented and split frames and rejects unmasked or oversized ones', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = (opcode: number, fin: boolean, payload: Buffer): Buffer => {
      const plain = encodeFrame(opcode, payload);
      const headerLength = plain.length - payload.length;
      const out = Buffer.alloc(plain.length + 4);
      plain.copy(out, 0, 0, headerLength);
      out[0] = (fin ? 0x80 : 0) | opcode;
      out[1] = out[1]! | 0x80;
      mask.copy(out, headerLength);
      for (let i = 0; i < payload.length; i++) out[headerLength + 4 + i] = payload[i]! ^ mask[i & 3]!;
      return out;
    };
    const texts: string[] = [];
    const errors: number[] = [];
    const decoder = new FrameDecoder({ onText: (t) => texts.push(t), onPing: () => undefined, onClose: () => undefined, onError: (code) => errors.push(code) }, 70_000);
    const bytes = Buffer.concat([masked(0x1, false, Buffer.from('hel')), masked(0x0, true, Buffer.from('lo')), masked(0x1, true, Buffer.from('x'.repeat(66_000)))]);
    for (let i = 0; i < bytes.length; i += 7) decoder.push(bytes.subarray(i, i + 7));
    expect(texts).toEqual(['hello', 'x'.repeat(66_000)]);
    decoder.push(masked(0x1, true, Buffer.alloc(80_000, 0x61)));
    expect(errors).toEqual([1009]);
    const unmasked: number[] = [];
    new FrameDecoder({ onText: () => undefined, onPing: () => undefined, onClose: () => undefined, onError: (code) => unmasked.push(code) }, 1000).push(encodeFrame(0x1, Buffer.from('hi')));
    expect(unmasked).toEqual([1002]);
  });
});
