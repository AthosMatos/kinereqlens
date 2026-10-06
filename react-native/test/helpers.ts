import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { KineReqLensHandle, KineReqLensOptions } from '../src/index';
import { startKineReqLens } from '../src/index';
import type { ClientMessage, RnRequestEnd, RnRequestStart } from '../src/protocol';
import type { Receiver, ReceiverClient } from './receiver';
import { decodeFrames, encodeFrame, startReceiver } from './receiver';
import type { FakeRn, RnGlobal } from './rn-fakes';
import { fakeReactNative, makeRnGlobal } from './rn-fakes';

export const TOKEN = 'test-pairing-token';

export interface Setup {
  receiver: Receiver;
  g: RnGlobal;
  rn: FakeRn;
  handle: KineReqLensHandle;
  client: ReceiverClient;
}

export async function setup(options: Partial<KineReqLensOptions> = {}, rn: FakeRn = fakeReactNative()): Promise<Setup> {
  const receiver = await startReceiver({ port: 0, token: TOKEN });
  const g = makeRnGlobal();
  const handle = startKineReqLens({
    token: TOKEN,
    host: '127.0.0.1',
    port: receiver.port,
    enabled: true,
    global: g,
    reactNative: rn,
    log: false,
    reconnect: { minDelayMs: 20, maxDelayMs: 200 },
    ...options,
  });
  if (!handle) throw new Error('startKineReqLens returned null');
  const client = await receiver.waitForClient();
  return { receiver, g, rn, handle, client };
}

export function starts(receiver: Receiver): RnRequestStart[] {
  return receiver.received.filter((r) => r.message.t === 'start').map((r) => (r.message as { data: RnRequestStart }).data);
}

export async function startFor(receiver: Receiver, url: string, timeoutMs = 3000): Promise<RnRequestStart> {
  const message = await receiver.waitFor((m) => m.t === 'start' && m.data.url === url, timeoutMs);
  return (message as { data: RnRequestStart }).data;
}

/** Wait for the start + end of the request to `url`. */
export async function captureFor(receiver: Receiver, url: string, timeoutMs = 3000): Promise<{ start: RnRequestStart; end: RnRequestEnd }> {
  const start = await startFor(receiver, url, timeoutMs);
  const message = await receiver.waitFor((m) => m.t === 'end' && m.data.hookId === start.hookId, timeoutMs);
  return { start, end: (message as { data: RnRequestEnd }).data };
}

export function ofType<T extends ClientMessage['t']>(receiver: Receiver, t: T): Array<Extract<ClientMessage, { t: T }>> {
  return receiver.received.filter((r) => r.message.t === t).map((r) => r.message as Extract<ClientMessage, { t: T }>);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until() timed out');
    await sleep(stepMs);
  }
}

/** A free TCP port (listen on 0, close). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Minimal WebSocket echo server (text and binary), using the receiver's frame codec. */
export async function startEchoServer(): Promise<{ url: string; close: () => Promise<void>; server: Server; closeAll: (code: number) => void }> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('upgrade', (req, socket: Socket) => {
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0].trim();
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
        '\r\n',
    );
    sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)));
          socket.end();
        } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          socket.write(encodeFrame(frame.opcode, frame.payload));
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/echo`,
    server,
    closeAll: (code: number) => {
      for (const socket of sockets) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        socket.write(encodeFrame(0x8, payload));
        socket.end();
      }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
