/**
 * Reference kineReqLens React Native receiver (protocol v1, see ../PROTOCOL.md) for tests and manual pairing.
 * Node only, no dependencies: the WebSocket server handshake (RFC 6455 §4.2) and framing (§5) are
 * implemented on node:http + node:crypto.
 *
 * Written without TypeScript-only runtime syntax so `node test/receiver-cli.ts` runs it directly.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { ClientMessage, HelloMessage, RnReplayRequest, RnReplayResult, ServerMessage } from '../src/protocol.ts';
import { CLOSE_CODES, DEFAULT_PATH, PROTOCOL_VERSION, parseClientMessage } from '../src/protocol.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface ReceiverOptions {
  /** Pairing token the app must present. Default: a random one (read it from `receiver.token`). */
  token?: string;
  /** 0 = random free port. Default 8790. */
  port?: number;
  /** Default 127.0.0.1 (use 0.0.0.0 to accept devices on the LAN). */
  host?: string;
  path?: string;
  handshakeTimeoutMs?: number;
}

/** Random pairing token (URL-safe, 20 chars). */
export function createPairingToken(): string {
  return randomBytes(15).toString('base64url');
}

function tokenMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual === '') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Decode as many complete (masked, client) frames as `buffer` holds. */
export function decodeFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer; error?: string } {
  const frames: Frame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(MAX_PAYLOAD)) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
      length = Number(big);
      cursor += 8;
    }
    if (!masked) return { frames, rest: Buffer.alloc(0), error: 'client frames must be masked' };
    if (length > MAX_PAYLOAD) return { frames, rest: Buffer.alloc(0), error: 'frame too large' };
    if (buffer.length - cursor < 4 + length) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    cursor += length;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    offset = cursor;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** One app connection. `hello` is set once the handshake succeeded. */
export class ReceiverClient {
  readonly id: number;
  hello: HelloMessage | null = null;
  readonly messages: ClientMessage[] = [];
  closed = false;
  closeCode: number | undefined;
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private onText: (client: ReceiverClient, text: string) => void;
  private onGone: (client: ReceiverClient) => void;

  constructor(id: number, socket: Socket, onText: (client: ReceiverClient, text: string) => void, onGone: (client: ReceiverClient) => void) {
    this.id = id;
    this.socket = socket;
    this.onText = onText;
    this.onGone = onGone;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }

  send(message: ServerMessage | Record<string, unknown>): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
  }

  /** Low level: send a raw frame (tests). */
  sendFrame(opcode: number, payload: Buffer): void {
    if (!this.closed) this.socket.write(encodeFrame(opcode, payload));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.closeCode = code;
    this.socket.write(encodeFrame(OP_CLOSE, payload));
    this.closed = true;
    // Give the peer a moment to answer the close frame, then drop the TCP connection.
    setTimeout(() => this.socket.destroy(), 200).unref?.();
    this.onGone(this);
  }

  /** Drop the TCP connection without a close frame (simulates the desktop side disappearing). */
  terminate(): void {
    this.socket.destroy();
    this.gone();
  }

  private gone(): void {
    if (!this.closed) {
      this.closed = true;
      this.onGone(this);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const { frames, rest, error } = decodeFrames(this.buffer);
    this.buffer = rest;
    if (error) {
      this.close(1002, error);
      return;
    }
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: Frame): void {
    switch (frame.opcode) {
      case OP_PING:
        this.sendFrame(OP_PONG, frame.payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        if (!this.closed) {
          this.socket.write(encodeFrame(OP_CLOSE, frame.payload.subarray(0, 2)));
          this.closeCode = code;
          this.closed = true;
          this.socket.end();
          this.onGone(this);
        }
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (frame.fin) {
          if (frame.opcode === OP_TEXT) this.onText(this, frame.payload.toString('utf8'));
          return;
        }
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        return;
      case OP_CONTINUATION:
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === OP_TEXT) this.onText(this, payload.toString('utf8'));
        }
        return;
      default:
        this.close(1002, 'unknown opcode');
    }
  }
}

export interface ReceivedMessage {
  client: ReceiverClient;
  message: ClientMessage;
}

export interface Rejection {
  reason: string;
  code: number;
}

export class Receiver extends EventEmitter {
  readonly token: string;
  readonly path: string;
  port = 0;
  readonly host: string;
  /** Authenticated (welcomed) connections, oldest first. */
  readonly clients: ReceiverClient[] = [];
  /** Every message received after a successful handshake. */
  readonly received: ReceivedMessage[] = [];
  readonly rejections: Rejection[] = [];
  private server: Server;
  private sockets = new Set<Socket>();
  private nextId = 1;
  private handshakeTimeoutMs: number;
  private requestedPort: number;

  constructor(options: ReceiverOptions = {}) {
    super();
    this.token = options.token ?? createPairingToken();
    this.path = options.path ?? DEFAULT_PATH;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 8790;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('kineReqLens receiver: WebSocket upgrade required\n');
    });
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => this.onUpgrade(req, socket, head));
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** ws:// URL apps connect to. */
  get url(): string {
    return `ws://${this.host}:${this.port}${this.path}`;
  }

  listen(): Promise<this> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off('error', reject);
        const address = this.server.address();
        this.port = typeof address === 'object' && address ? address.port : this.requestedPort;
        resolve(this);
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients.slice()) client.close(1001, 'receiver closing');
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Send to every authenticated client. */
  broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }

  /** Resolve with the first received message (past or future) matching `predicate`. */
  waitFor(predicate: (message: ClientMessage, client: ReceiverClient) => boolean, timeoutMs = 5000, fromIndex = 0): Promise<ClientMessage> {
    for (let i = fromIndex; i < this.received.length; i++) {
      const item = this.received[i];
      if (predicate(item.message, item.client)) return Promise.resolve(item.message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', listener);
        reject(new Error('Receiver.waitFor timed out'));
      }, timeoutMs);
      const listener = (message: ClientMessage, client: ReceiverClient): void => {
        if (!predicate(message, client)) return;
        clearTimeout(timer);
        this.off('message', listener);
        resolve(message);
      };
      this.on('message', listener);
    });
  }

  /** Resolve with the `n`-th (1-based) authenticated client. */
  waitForClient(n = 1, timeoutMs = 5000): Promise<ReceiverClient> {
    let count = 0;
    const all: ReceiverClient[] = [];
    return new Promise((resolve, reject) => {
      const check = (client: ReceiverClient): void => {
        all.push(client);
        count++;
        if (count >= n) {
          clearTimeout(timer);
          this.off('client', check);
          resolve(all[n - 1]);
        }
      };
      const timer = setTimeout(() => {
        this.off('client', check);
        reject(new Error('Receiver.waitForClient timed out'));
      }, timeoutMs);
      this.on('client', check);
      for (const existing of this.allClients) {
        if (count < n) check(existing);
      }
    });
  }

  /** Ask the most recent client to replay a request and wait for the result. */
  async replay(request: RnReplayRequest, timeoutMs = 10_000): Promise<RnReplayResult> {
    const client = this.clients[this.clients.length - 1];
    if (!client) throw new Error('no client connected');
    const from = this.received.length;
    client.send({ t: 'replay', data: request });
    const message = await this.waitFor((m) => m.t === 'replay-result' && m.data.runId === request.runId, timeoutMs, from);
    return (message as { t: 'replay-result'; data: RnReplayResult }).data;
  }

  /** Every client ever welcomed (including closed ones), in order. */
  private allClients: ReceiverClient[] = [];

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = (req.url ?? '/').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (path !== this.path) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    let welcomed = false;
    const client = new ReceiverClient(
      this.nextId++,
      socket,
      (c, text) => {
        if (!welcomed) {
          welcomed = this.handshake(c, text);
          if (welcomed) clearTimeout(timer);
          return;
        }
        const message = parseClientMessage(text);
        if (!message) return;
        c.messages.push(message);
        this.received.push({ client: c, message });
        if (message.t === 'open-ui') this.emit('open-ui', c);
        this.emit('message', message, c);
      },
      (c) => {
        const index = this.clients.indexOf(c);
        if (index >= 0) this.clients.splice(index, 1);
        clearTimeout(timer);
        this.emit('disconnect', c);
      },
    );
    const timer = setTimeout(() => {
      if (!welcomed) this.reject(client, 'handshake timeout', CLOSE_CODES.HANDSHAKE_TIMEOUT);
    }, this.handshakeTimeoutMs);
    if (head && head.length) socket.unshift(head);
  }

  private reject(client: ReceiverClient, reason: string, code: number): void {
    this.rejections.push({ reason, code });
    client.send({ t: 'rejected', reason, code });
    client.close(code, reason);
    this.emit('rejected', { reason, code });
  }

  private handshake(client: ReceiverClient, text: string): boolean {
    const message = parseClientMessage(text);
    if (!message || message.t !== 'hello') {
      this.reject(client, 'expected hello', CLOSE_CODES.BAD_HANDSHAKE);
      return false;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.reject(client, `unsupported protocol version ${String(message.v)}`, CLOSE_CODES.BAD_HANDSHAKE);
      return false;
    }
    if (!tokenMatches(this.token, message.token)) {
      this.reject(client, 'invalid pairing token', CLOSE_CODES.BAD_TOKEN);
      return false;
    }
    client.hello = message;
    this.clients.push(client);
    this.allClients.push(client);
    client.send({ t: 'welcome', v: PROTOCOL_VERSION, server: { name: 'kinereqlens-reference-receiver', version: '1' } });
    this.emit('client', client);
    return true;
  }
}

/** Create and start a receiver. */
export async function startReceiver(options: ReceiverOptions = {}): Promise<Receiver> {
  return new Receiver(options).listen();
}
