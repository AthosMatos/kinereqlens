import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setReactNativeModule } from '../src/env';
import { getKineReqLensStatus, isKineReqLensRunning, startKineReqLens, stopKineReqLens } from '../src/index';
import type { RnWsFrame } from '../src/protocol';
import type { Receiver } from './receiver';
import { startReceiver } from './receiver';
import { captureFor, freePort, ofType, setup, sleep, startEchoServer, starts, TOKEN, until } from './helpers';
import type { Setup } from './helpers';
import { FakeBlob, FakeFileReader, fakeReactNative, makeRnGlobal } from './rn-fakes';

const g0 = globalThis as { FileReader?: unknown };
let current: Setup | null = null;
const extraReceivers: Receiver[] = [];

beforeEach(() => {
  // React Native has FileReader (and its Blobs need it).
  g0.FileReader = FakeFileReader;
});

afterEach(async () => {
  stopKineReqLens();
  _setReactNativeModule(undefined);
  delete g0.FileReader;
  if (current) await current.receiver.close();
  current = null;
  for (const receiver of extraReceivers.splice(0)) await receiver.close();
});

async function init(...args: Parameters<typeof setup>): Promise<Setup> {
  current = await setup(...args);
  return current;
}

describe('handshake', () => {
  it('sends hello with app info and gets welcomed', async () => {
    const { client, handle } = await init({}, fakeReactNative({ os: 'android', scriptURL: 'http://10.0.2.2:8081/index.bundle?platform=android&app=com.example.android', constants: { Model: 'sdk_gphone64_arm64', Manufacturer: 'Google', Fingerprint: 'google/sdk_gphone64_arm64/emu64a:14' } }));
    expect(client.hello).toMatchObject({
      t: 'hello',
      v: 1,
      token: TOKEN,
      session: handle.session,
      app: { name: 'DemoApp', bundleId: 'com.example.android', platform: 'android', rnVersion: '0.76.3', hermes: false, deviceName: 'Google sdk_gphone64_arm64', emulator: true },
    });
    await until(() => handle.status() === 'connected');
    expect(getKineReqLensStatus()).toBe('connected');
  });

  it('is rejected with a wrong token and never streams captures', async () => {
    const receiver = await startReceiver({ port: 0, token: 'right-token' });
    extraReceivers.push(receiver);
    const g = makeRnGlobal();
    const statuses: string[] = [];
    startKineReqLens({ token: 'wrong-token', host: '127.0.0.1', port: receiver.port, enabled: true, global: g, reactNative: fakeReactNative(), log: false, reconnect: { minDelayMs: 20, maxDelayMs: 100 }, onStatus: (s) => statuses.push(s) });
    await g.fetch('http://api.test/one');
    await until(() => statuses.includes('rejected'));
    expect(receiver.rejections[0]).toEqual({ reason: 'invalid pairing token', code: 4001 });
    expect(receiver.clients).toHaveLength(0);
    expect(receiver.received).toHaveLength(0);
    // Keeps retrying (slowly) in case the receiver restarts with this token.
    await until(() => receiver.rejections.length >= 2, 2000);
  });

  it('does not start without a token or when disabled', () => {
    const g = makeRnGlobal();
    const fetchBefore = g.fetch;
    expect(startKineReqLens({ token: '', enabled: true, global: g, reactNative: null, log: false })).toBeNull();
    expect(startKineReqLens({ token: 'x', enabled: false, global: g, reactNative: null, log: false })).toBeNull();
    // enabled defaults to __DEV__, which is not defined under Node.
    expect(startKineReqLens({ token: 'x', global: g, reactNative: null, log: false })).toBeNull();
    expect(g.fetch).toBe(fetchBefore);
    expect(isKineReqLensRunning()).toBe(false);
  });
});

describe('XMLHttpRequest capture (React Native semantics)', () => {
  it('captures a text XHR with request headers/body and response', async () => {
    const { receiver, g } = await init();
    g.network.handler = (req) => ({ status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/json', 'X-Id': '7' }, body: JSON.stringify({ echo: req.body }) });
    const xhr = new g.XMLHttpRequest();
    let appSaw = '';
    xhr.onload = () => {
      appSaw = xhr.responseText;
    };
    xhr.open('post', 'https://api.test/items?x=1');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', 'Bearer abc');
    xhr.send('{"a":1}');
    const { start, end } = await captureFor(receiver, 'https://api.test/items?x=1');
    expect(start).toMatchObject({
      kind: 'xhr',
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer abc' },
      ],
      body: { kind: 'text', text: '{"a":1}', size: 7 },
      contentType: 'application/json',
      frameUrl: '',
      options: { withCredentials: false, responseType: '' },
    });
    expect(end).toMatchObject({ state: 'done', status: 201, statusText: 'Created', body: { kind: 'text', text: '{"echo":"{\\"a\\":1}"}' } });
    expect(end.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Id', value: '7' },
    ]);
    expect(appSaw).toBe('{"echo":"{\\"a\\":1}"}');
    expect(start.hookId.startsWith(`${current!.handle.session}:`)).toBe(true);
  });

  it('reads json / arraybuffer / blob response types without disturbing the app', async () => {
    const { receiver, g } = await init();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    g.network.handler = (req) =>
      req.url.endsWith('json') ? { status: 200, headers: { 'content-type': 'application/json' }, body: '{"n":1}' } : { status: 200, headers: { 'content-type': 'image/png' }, body: png };

    const results: unknown[] = [];
    for (const [type, url] of [
      ['json', 'https://api.test/r.json'],
      ['arraybuffer', 'https://api.test/r.png'],
      ['blob', 'https://api.test/b.png'],
    ] as const) {
      const xhr = new g.XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = type;
      xhr.onload = () => results.push(xhr.response);
      xhr.send();
    }
    const json = await captureFor(receiver, 'https://api.test/r.json');
    expect(json.end.body).toEqual({ kind: 'text', text: '{"n":1}', size: 7 });
    expect(json.start.options).toMatchObject({ responseType: 'json' });
    const ab = await captureFor(receiver, 'https://api.test/r.png');
    expect(ab.end.body).toEqual({ kind: 'base64', base64: Buffer.from(png).toString('base64'), size: 8 });
    const blob = await captureFor(receiver, 'https://api.test/b.png');
    expect(blob.end.body).toEqual({ kind: 'base64', base64: Buffer.from(png).toString('base64'), size: 8 });
    await until(() => results.length === 3);
    expect(results[0]).toEqual({ n: 1 });
    expect(new Uint8Array(results[1] as ArrayBuffer)).toEqual(png);
    expect(FakeBlob.bytesOf(results[2] as FakeBlob)).toEqual(png);
  });

  it('reports network errors and aborts', async () => {
    const { receiver, g } = await init();
    g.network.handler = (req) => (req.url.includes('fail') ? { error: 'network' } : { status: 200, body: 'slow', delayMs: 500 });
    const failing = new g.XMLHttpRequest();
    failing.open('GET', 'https://api.test/fail');
    failing.send();
    const aborted = new g.XMLHttpRequest();
    aborted.open('GET', 'https://api.test/slow');
    aborted.send();
    setTimeout(() => aborted.abort(), 20);
    const fail = await captureFor(receiver, 'https://api.test/fail');
    expect(fail.end).toMatchObject({ state: 'error', error: 'Network error' });
    expect(fail.end.status).toBeUndefined();
    const abort = await captureFor(receiver, 'https://api.test/slow');
    expect(abort.end).toMatchObject({ state: 'aborted', error: 'Aborted' });
  });

  it('captures RN FormData parts and Blob / ArrayBuffer request bodies', async () => {
    const { receiver, g } = await init();
    // React Native FormData: getParts() -> { string } | { uri, name, type } parts.
    const form = {
      append: () => undefined,
      getParts: () => [
        { string: 'hello', fieldName: 'greeting', headers: { 'content-disposition': 'form-data; name="greeting"' } },
        { uri: 'file:///tmp/photo.jpg', name: 'photo.jpg', type: 'image/jpeg', fieldName: 'photo', headers: {} },
      ],
    };
    const send = (url: string, body: unknown): void => {
      const xhr = new g.XMLHttpRequest();
      xhr.open('POST', url);
      xhr.send(body);
    };
    send('https://api.test/form', form);
    send('https://api.test/blob', new FakeBlob(new TextEncoder().encode('blob text'), 'text/plain'));
    send('https://api.test/bin', new Uint8Array([0, 255, 1]).buffer);
    const formCapture = await captureFor(receiver, 'https://api.test/form');
    expect(formCapture.start.contentType).toBe('multipart/form-data');
    expect(formCapture.start.body).toEqual({
      kind: 'formData',
      entries: [
        { name: 'greeting', type: 'text', value: 'hello' },
        { name: 'photo', type: 'file', fileName: 'photo.jpg', mime: 'image/jpeg', size: -1, truncated: true, uri: 'file:///tmp/photo.jpg' },
      ],
    });
    expect((await captureFor(receiver, 'https://api.test/blob')).start).toMatchObject({ body: { kind: 'text', text: 'blob text', size: 9 }, contentType: 'text/plain' });
    expect((await captureFor(receiver, 'https://api.test/bin')).start.body).toEqual({ kind: 'base64', base64: 'AP8B', size: 3 });
  });

  it('applies body caps with truncated flags', async () => {
    const { receiver, g } = await init({ requestBodyCap: 4, responseBodyCap: 6 });
    g.network.handler = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'response-body-long' });
    const xhr = new g.XMLHttpRequest();
    let appSaw = '';
    xhr.onload = () => (appSaw = xhr.responseText);
    xhr.open('POST', 'https://api.test/cap');
    xhr.send('request-body');
    const { start, end } = await captureFor(receiver, 'https://api.test/cap');
    expect(start.body).toEqual({ kind: 'text', text: 'requ', size: 12, truncated: true });
    expect(end.body).toEqual({ kind: 'text', text: 'respon', size: 18, truncated: true });
    expect(appSaw).toBe('response-body-long');

    // Binary over the cap (blob path through fetch).
    g.network.handler = () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(100).fill(7) });
    const response = await g.fetch('https://api.test/bigbin');
    expect((await response.arrayBuffer()).byteLength).toBe(100);
    const bin = await captureFor(receiver, 'https://api.test/bigbin');
    expect(bin.end.body).toEqual({ kind: 'base64', base64: Buffer.from(new Uint8Array(6).fill(7)).toString('base64'), size: 100, truncated: true });
  });

  it('captureBodies: false records no body contents', async () => {
    const { receiver, g } = await init({ captureBodies: false });
    const xhr = new g.XMLHttpRequest();
    xhr.open('POST', 'https://api.test/nobody');
    xhr.send('secret');
    const { start, end } = await captureFor(receiver, 'https://api.test/nobody');
    expect(start.body).toMatchObject({ kind: 'unavailable' });
    expect(end.body).toMatchObject({ kind: 'unavailable' });
  });
});

describe('fetch', () => {
  it('reports fetch-over-XHR once, as kind fetch with its init options', async () => {
    const { receiver, g } = await init();
    g.network.handler = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    const response = await g.fetch('https://api.test/users', { method: 'post', body: 'name=x', credentials: 'include', headers: { 'X-Trace': '1' } });
    expect(await response.json()).toEqual({ ok: true });
    const { start, end } = await captureFor(receiver, 'https://api.test/users');
    expect(start).toMatchObject({
      kind: 'fetch',
      method: 'POST',
      body: { kind: 'text', text: 'name=x', size: 6 },
      // whatwg-fetch's implicit content-type is what the XHR (and the network) actually got.
      contentType: 'text/plain;charset=UTF-8',
      options: { credentials: 'include' },
    });
    expect(start.headers).toEqual([
      { name: 'x-trace', value: '1' },
      { name: 'content-type', value: 'text/plain;charset=UTF-8' },
    ]);
    expect(end).toMatchObject({ state: 'done', status: 200, body: { kind: 'text', text: '{"ok":true}', size: 11 } });
    await sleep(50);
    expect(starts(receiver).filter((s) => s.url === 'https://api.test/users')).toHaveLength(1);
    expect(g.network.requests).toHaveLength(1);
    expect(g.network.requests[0].withCredentials).toBe(true);
  });

  it('captures a fetch that does not use XHR (native fetch) through the fetch wrapper', async () => {
    const receiver = await startReceiver({ port: 0, token: TOKEN });
    extraReceivers.push(receiver);
    const g = makeRnGlobal();
    // A native (streaming) fetch implementation: Node's Response, no XMLHttpRequest involved.
    g.fetch = (async () => new Response('native body', { status: 202, headers: { 'content-type': 'text/plain', 'x-native': '1' } })) as never;
    startKineReqLens({ token: TOKEN, host: '127.0.0.1', port: receiver.port, enabled: true, global: g, reactNative: fakeReactNative(), log: false });
    await receiver.waitForClient();
    const response = (await g.fetch('https://api.test/native', { method: 'PUT', body: '{"x":1}', headers: { 'content-type': 'application/json' } })) as unknown as Response;
    expect(await response.text()).toBe('native body');
    const { start, end } = await captureFor(receiver, 'https://api.test/native');
    expect(start).toMatchObject({ kind: 'fetch', method: 'PUT', contentType: 'application/json', body: { kind: 'text', text: '{"x":1}' } });
    expect(end).toMatchObject({ state: 'done', status: 202, body: { kind: 'text', text: 'native body', size: 11 } });
    expect(end.headers).toContainEqual({ name: 'x-native', value: '1' });
  });

  it('reports a failed fetch', async () => {
    const { receiver, g } = await init();
    g.network.handler = () => ({ error: 'network' });
    await expect(g.fetch('https://api.test/down')).rejects.toThrow('Network request failed');
    const { end } = await captureFor(receiver, 'https://api.test/down');
    expect(end).toMatchObject({ state: 'error' });
  });
});

describe('filtering', () => {
  it('ignores Metro, the receiver itself and ignoreUrls', async () => {
    const { receiver, g } = await init(
      { ignoreUrls: ['analytics.test', /\/health$/] },
      fakeReactNative({ scriptURL: 'http://192.168.1.20:8081/index.bundle?platform=ios&app=x' }),
    );
    const urls = [
      'http://192.168.1.20:8081/symbolicate',
      'http://localhost:8081/logs',
      'http://192.168.1.20:8081/index.bundle?platform=ios',
      'https://analytics.test/collect',
      'https://api.test/health',
      `http://127.0.0.1:${receiver.port}/kinereqlens/anything`,
      'https://api.test/kept',
      // Expo Router API route on the Metro origin: real app traffic, kept.
      'http://192.168.1.20:8081/api/hello',
    ];
    for (const url of urls) await g.fetch(url).catch(() => undefined);
    await captureFor(receiver, 'https://api.test/kept');
    await captureFor(receiver, 'http://192.168.1.20:8081/api/hello');
    await sleep(50);
    expect(starts(receiver).map((s) => s.url).sort()).toEqual(['http://192.168.1.20:8081/api/hello', 'https://api.test/kept']);
  });
});

describe('replay', () => {
  it('runs with the original fetch and is not captured', async () => {
    const { receiver, g } = await init();
    g.network.handler = (req) => ({ status: 200, headers: { 'content-type': 'application/json', 'x-replayed': '1' }, body: JSON.stringify({ method: req.method, body: req.body, auth: req.headers.authorization }) });
    const result = await receiver.replay({
      runId: 'run-1',
      method: 'PATCH',
      url: 'https://api.test/replay',
      headers: [
        { name: 'Authorization', value: 'Bearer t' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      body: { kind: 'text', text: '{"v":2}' },
      timeoutMs: 5000,
      responseBodyCap: 1024,
    });
    expect(result).toMatchObject({
      runId: 'run-1',
      ok: true,
      status: 200,
      url: 'https://api.test/replay',
      body: { kind: 'text', text: '{"method":"PATCH","body":"{\\"v\\":2}","auth":"Bearer t"}' },
    });
    expect(result.headers).toContainEqual({ name: 'x-replayed', value: '1' });
    expect(result.timing.end).toBeGreaterThanOrEqual(result.timing.start);
    expect(g.network.requests).toHaveLength(1);
    await sleep(50);
    expect(starts(receiver)).toHaveLength(0);
  });

  it('replays binary bodies, reports failures, timeouts and aborts', async () => {
    const { receiver, g } = await init();
    g.network.handler = (req) => {
      if (req.url.endsWith('/slow')) return { status: 200, body: 'late', delayMs: 2000 };
      if (req.url.endsWith('/down')) return { error: 'network' };
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(new Uint8Array(req.body as ArrayBuffer)) };
    };
    const bin = await receiver.replay({ runId: 'b', method: 'POST', url: 'https://api.test/bin', headers: [], body: { kind: 'base64', base64: 'AAEC' } });
    expect(bin.body).toEqual({ kind: 'base64', base64: 'AAEC', size: 3 });
    const down = await receiver.replay({ runId: 'd', method: 'GET', url: 'https://api.test/down', headers: [], body: { kind: 'none' } });
    expect(down).toMatchObject({ ok: false, error: 'TypeError: Network request failed' });
    expect(down.errorHint).toBeTruthy();
    const slow = await receiver.replay({ runId: 's', method: 'GET', url: 'https://api.test/slow', headers: [], body: { kind: 'none' }, timeoutMs: 50 });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    const pending = receiver.replay({ runId: 'a', method: 'GET', url: 'https://api.test/slow', headers: [], body: { kind: 'none' } });
    await sleep(30);
    receiver.broadcast({ t: 'abort', runId: 'a' });
    expect(await pending).toMatchObject({ ok: false, aborted: true, error: 'Request cancelled' });
    const invalid = receiver.replay({ runId: 'bad', method: '', url: '', headers: [], body: { kind: 'none' } });
    expect(await invalid).toMatchObject({ ok: false, error: 'Invalid replay request' });
    await sleep(30);
    expect(starts(receiver)).toHaveLength(0);
  });
});

describe('WebSocket capture', () => {
  it('records open, ready, frames in both directions and close, preserving behaviour', async () => {
    const echo = await startEchoServer();
    try {
      const { receiver, g } = await init();
      const WS = g.WebSocket as typeof WebSocket;
      const ws = new WS(echo.url, ['chat']);
      ws.binaryType = 'arraybuffer';
      const received: unknown[] = [];
      ws.onmessage = (event) => received.push(event.data);
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
      expect(ws).toBeInstanceOf(globalThis.WebSocket);
      expect(WS.OPEN).toBe(1);
      expect(ws.protocol).toBe('chat');
      ws.send('hello');
      ws.send(new Uint8Array([1, 2, 3]));
      await until(() => received.length === 2);
      ws.close(1000, 'bye');
      await receiver.waitFor((m) => m.t === 'ws-close');
      expect(received[0]).toBe('hello');
      expect(new Uint8Array(received[1] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

      const [open] = ofType(receiver, 'ws-open');
      expect(open.data).toMatchObject({ url: echo.url, protocols: ['chat'] });
      expect(ofType(receiver, 'ws-ready')[0].data).toMatchObject({ wsId: open.data.wsId, protocol: 'chat' });
      const frames = ofType(receiver, 'ws-frame').map((m) => m.data);
      const strip = (f: RnWsFrame) => ({ dir: f.dir, opcode: f.opcode, text: f.text, base64: f.base64, size: f.size });
      expect(frames.map(strip)).toEqual([
        { dir: 'out', opcode: 'text', text: 'hello', base64: undefined, size: 5 },
        { dir: 'out', opcode: 'binary', text: undefined, base64: 'AQID', size: 3 },
        { dir: 'in', opcode: 'text', text: 'hello', base64: undefined, size: 5 },
        { dir: 'in', opcode: 'binary', text: undefined, base64: 'AQID', size: 3 },
      ]);
      expect(ofType(receiver, 'ws-close')[0].data).toMatchObject({ wsId: open.data.wsId, code: 1000, initiator: 'client' });
    } finally {
      await echo.close();
    }
  });

  it('reads Blob frames in order, caps frames, and reports server-initiated close', async () => {
    const echo = await startEchoServer();
    try {
      const { receiver, g } = await init({ wsFrameCap: 4 });
      const WS = g.WebSocket as typeof WebSocket;
      const ws = new WS(echo.url);
      // binaryType 'blob' (Node's default too): binary frames arrive as Blobs read asynchronously.
      ws.binaryType = 'blob';
      let count = 0;
      ws.onmessage = () => count++;
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      ws.send(new Uint8Array([9, 8, 7, 6, 5, 4]));
      ws.send('text after blob');
      await until(() => count === 2);
      echo.closeAll(4321);
      await receiver.waitFor((m) => m.t === 'ws-close');
      const inbound = ofType(receiver, 'ws-frame').map((m) => m.data).filter((f) => f.dir === 'in');
      expect(inbound.map((f) => [f.opcode, f.base64 ?? f.text, f.size, f.truncated])).toEqual([
        ['binary', Buffer.from([9, 8, 7, 6]).toString('base64'), 6, true],
        ['text', 'text', 15, true],
      ]);
      expect(ofType(receiver, 'ws-close')[0].data).toMatchObject({ code: 4321, initiator: 'server' });
    } finally {
      await echo.close();
    }
  });

  it('does not observe Metro HMR / ignored sockets', async () => {
    const echo = await startEchoServer();
    try {
      const { receiver, g } = await init({ ignoreUrls: ['/echo'] });
      const WS = g.WebSocket as typeof WebSocket;
      const ws = new WS(echo.url);
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      ws.send('x');
      ws.close();
      await sleep(100);
      expect(ofType(receiver, 'ws-open')).toHaveLength(0);
      expect(ofType(receiver, 'ws-frame')).toHaveLength(0);
    } finally {
      await echo.close();
    }
  });
});

describe('buffering and reconnect', () => {
  it('buffers while the receiver is down, drops the oldest beyond bufferSize, and reconnects', async () => {
    const port = await freePort();
    const g = makeRnGlobal();
    const handle = startKineReqLens({ token: TOKEN, host: '127.0.0.1', port, enabled: true, global: g, reactNative: fakeReactNative(), log: false, bufferSize: 3, reconnect: { minDelayMs: 20, maxDelayMs: 60 } });
    expect(handle).not.toBeNull();
    for (let i = 1; i <= 5; i++) await g.fetch(`https://api.test/offline/${i}`);
    await sleep(50);
    expect(handle!.status()).not.toBe('connected');

    const receiver = await startReceiver({ port, token: TOKEN });
    extraReceivers.push(receiver);
    const first = await receiver.waitForClient();
    await captureFor(receiver, 'https://api.test/offline/5');
    expect(ofType(receiver, 'dropped')).toEqual([{ t: 'dropped', count: 2 }]);
    expect(starts(receiver).map((s) => s.url)).toEqual(['https://api.test/offline/3', 'https://api.test/offline/4', 'https://api.test/offline/5']);
    expect(ofType(receiver, 'end')).toHaveLength(3);

    // The desktop side disappears and comes back: the app reconnects with the same session.
    first.terminate();
    await until(() => handle!.status() !== 'connected');
    await g.fetch('https://api.test/after-drop');
    const second = await receiver.waitForClient(2);
    expect(second.hello?.session).toBe(first.hello?.session);
    await captureFor(receiver, 'https://api.test/after-drop');
    expect(second.messages.some((m) => m.t === 'start' && m.data.url === 'https://api.test/after-drop')).toBe(true);
  });
});

describe('dev menu and stop', () => {
  it('adds "Open kineReqLens" which sends open-ui', async () => {
    const rn = fakeReactNative();
    const { receiver } = await init({}, rn);
    expect(rn.DevSettings.items.map((i) => i.title)).toEqual(['Open kineReqLens']);
    // Restarting (e.g. Fast Refresh re-running index.js) does not add a second item.
    startKineReqLens({ token: TOKEN, host: '127.0.0.1', port: receiver.port, enabled: true, global: current!.g, reactNative: rn, log: false });
    expect(rn.DevSettings.items).toHaveLength(1);
    await receiver.waitForClient(2);
    rn.DevSettings.items[0].handler();
    await receiver.waitFor((m) => m.t === 'open-ui');
  });

  it('stopKineReqLens restores fetch, XMLHttpRequest and WebSocket', async () => {
    const g = makeRnGlobal();
    const before = { fetch: g.fetch, ws: g.WebSocket, open: g.XMLHttpRequest.prototype.open, send: g.XMLHttpRequest.prototype.send, srh: g.XMLHttpRequest.prototype.setRequestHeader };
    const receiver = await startReceiver({ port: 0, token: TOKEN });
    extraReceivers.push(receiver);
    startKineReqLens({ token: TOKEN, host: '127.0.0.1', port: receiver.port, enabled: true, global: g, reactNative: fakeReactNative(), log: false });
    expect(g.fetch).not.toBe(before.fetch);
    expect(g.WebSocket).not.toBe(before.ws);
    expect(g.XMLHttpRequest.prototype.open).not.toBe(before.open);
    await receiver.waitForClient();
    stopKineReqLens();
    expect(g.fetch).toBe(before.fetch);
    expect(g.WebSocket).toBe(before.ws);
    expect(g.XMLHttpRequest.prototype.open).toBe(before.open);
    expect(g.XMLHttpRequest.prototype.send).toBe(before.send);
    expect(g.XMLHttpRequest.prototype.setRequestHeader).toBe(before.srh);
    expect(isKineReqLensRunning()).toBe(false);
    await until(() => receiver.clients.length === 0);
  });

  it('a wrapper installed on top survives stop and then passes through', async () => {
    const { receiver, g } = await init();
    const ours = g.fetch;
    const calls: string[] = [];
    g.fetch = (input: unknown, init?: Record<string, unknown>) => {
      calls.push(String(input));
      return ours(input, init);
    };
    const theirs = g.fetch;
    stopKineReqLens();
    expect(g.fetch).toBe(theirs);
    await g.fetch('https://api.test/after-stop');
    expect(calls).toEqual(['https://api.test/after-stop']);
    await sleep(30);
    expect(starts(receiver)).toHaveLength(0);
  });

  it('never throws into app code when capture internals fail', async () => {
    const { receiver, g } = await init();
    const hostile = {
      toString(): string {
        throw new Error('boom');
      },
    };
    const xhr = new g.XMLHttpRequest();
    xhr.open('POST', 'https://api.test/hostile');
    // The fake native accepts any object; our snapshot's String() throws and must be swallowed.
    expect(() => xhr.send(hostile)).not.toThrow();
    const { start } = await captureFor(receiver, 'https://api.test/hostile');
    expect(start.body).toMatchObject({ kind: 'unavailable' });
  });
});
