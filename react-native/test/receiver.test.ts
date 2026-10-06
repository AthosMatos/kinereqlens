import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startKineReqLens, stopKineReqLens } from '../src/index';
import type { Receiver } from './receiver';
import { decodeFrames, encodeFrame, startReceiver } from './receiver';
import { TOKEN, captureFor, until } from './helpers';
import { fakeReactNative, makeRnGlobal } from './rn-fakes';

const receivers: Receiver[] = [];
async function receiverFor(options: Parameters<typeof startReceiver>[0] = {}): Promise<Receiver> {
  const receiver = await startReceiver({ port: 0, token: TOKEN, ...options });
  receivers.push(receiver);
  return receiver;
}

afterEach(async () => {
  stopKineReqLens();
  for (const receiver of receivers.splice(0)) await receiver.close();
});

function hello(token: string, v = 1): string {
  return JSON.stringify({ t: 'hello', v, token, session: 's', lib: { name: 't', version: '0' }, capabilities: [], app: { name: 'raw', bundleId: '', platform: 'ios', rnVersion: '', hermes: false, deviceName: 'node' } });
}

function closeOf(ws: WebSocket): Promise<{ code: number; reason: string; messages: string[] }> {
  const messages: string[] = [];
  ws.addEventListener('message', (event) => messages.push(String(event.data)));
  return new Promise((resolve) => ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason, messages })));
}

describe('reference receiver', () => {
  it('rejects a wrong or missing token with {t:"rejected"} and close 4001', async () => {
    const receiver = await receiverFor();
    for (const token of ['wrong', '']) {
      const ws = new WebSocket(receiver.url);
      const closed = closeOf(ws);
      ws.onopen = () => ws.send(hello(token));
      const { code, messages } = await closed;
      expect(code).toBe(4001);
      expect(JSON.parse(messages[0])).toEqual({ t: 'rejected', reason: 'invalid pairing token', code: 4001 });
    }
    expect(receiver.clients).toHaveLength(0);
  });

  it('rejects other protocol versions / a first message that is not hello (4002) and silent clients (4003)', async () => {
    const receiver = await receiverFor({ handshakeTimeoutMs: 100 });
    const v2 = new WebSocket(receiver.url);
    const v2Closed = closeOf(v2);
    v2.onopen = () => v2.send(hello(TOKEN, 2));
    expect((await v2Closed).code).toBe(4002);
    const junk = new WebSocket(receiver.url);
    const junkClosed = closeOf(junk);
    junk.onopen = () => junk.send('{"t":"start","data":{}}');
    expect((await junkClosed).code).toBe(4002);
    const silent = new WebSocket(receiver.url);
    expect((await closeOf(silent)).code).toBe(4003);
  });

  it('welcomes a valid hello, answers WebSocket pings and handles large text messages', async () => {
    const receiver = await receiverFor();
    const ws = new WebSocket(receiver.url);
    const messages: string[] = [];
    ws.onmessage = (event) => messages.push(String(event.data));
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
    ws.send(hello(TOKEN));
    await until(() => messages.length === 1);
    expect(JSON.parse(messages[0])).toMatchObject({ t: 'welcome', v: 1 });
    const big = 'x'.repeat(200_000);
    ws.send(JSON.stringify({ t: 'start', data: { hookId: 'h', url: big } }));
    const got = await receiver.waitFor((m) => m.t === 'start');
    expect((got as { data: { url: string } }).data.url).toHaveLength(200_000);
    ws.close();
  });

  it('serves 404 / 426 outside the WebSocket path', async () => {
    const receiver = await receiverFor();
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: receiver.port, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(426);
    const other = new WebSocket(`ws://127.0.0.1:${receiver.port}/elsewhere`);
    const result = await new Promise<string>((resolve) => {
      other.onerror = () => resolve('error');
      other.onopen = () => resolve('open');
    });
    expect(result).toBe('error');
  });

  it('frame codec: 7/16/64-bit lengths, masking and fragmentation', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = (opcode: number, payload: Buffer, fin = true): Buffer => {
      const plain = encodeFrame(opcode, payload);
      const headerLength = plain.length - payload.length;
      const header = Buffer.from(plain.subarray(0, headerLength));
      if (!fin) header[0] &= 0x7f;
      header[1] |= 0x80;
      const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      return Buffer.concat([header, mask, body]);
    };
    for (const size of [5, 300, 70_000]) {
      const payload = Buffer.alloc(size, 0x61);
      const { frames, rest } = decodeFrames(masked(1, payload));
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.equals(payload)).toBe(true);
      expect(rest.length).toBe(0);
    }
    const parts = Buffer.concat([masked(1, Buffer.from('he'), false), masked(0, Buffer.from('llo'))]);
    const partial = decodeFrames(parts.subarray(0, parts.length - 2));
    expect(partial.frames).toHaveLength(1);
    expect(decodeFrames(parts).frames.map((f) => [f.fin, f.opcode, f.payload.toString()])).toEqual([
      [false, 1, 'he'],
      [true, 0, 'llo'],
    ]);
    expect(decodeFrames(encodeFrame(1, Buffer.from('unmasked'))).error).toBe('client frames must be masked');
  });

  it('answers app-level {t:"ping"} with {t:"pong"} through the client runtime', async () => {
    const receiver = await receiverFor();
    const g = makeRnGlobal();
    startKineReqLens({ token: TOKEN, host: '127.0.0.1', port: receiver.port, enabled: true, global: g, reactNative: fakeReactNative(), log: false });
    const client = await receiver.waitForClient();
    client.send({ t: 'ping', id: 'p1' });
    expect(await receiver.waitFor((m) => m.t === 'pong')).toEqual({ t: 'pong', id: 'p1' });
    // And the connection keeps streaming afterwards.
    await g.fetch('https://api.test/after-ping');
    await captureFor(receiver, 'https://api.test/after-ping');
  });
});
