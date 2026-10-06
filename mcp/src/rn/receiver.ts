// React Native receiver of the hub (docs/ARCHITECTURE.md §9, react-native/PROTOCOL.md): a WebSocket server
// apps connect to (ws://<host>:<port>/kinereqlens, default 127.0.0.1:8790; 0.0.0.0 when LAN is allowed for
// physical devices). Every app message is untrusted: the handshake checks the pairing token (constant time),
// every later message is validated and rebuilt (src/shared/rn-protocol.ts) before it is batched (≤ 50 ms) to
// the extension over native messaging, chunked under the 1 MiB frame limit. The extension's replay / abort
// commands are relayed to the app session they name.
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import {
  RN_BATCH_MS,
  RN_CLOSE,
  RN_DEFAULT_PORT,
  RN_FRAME_BUDGET,
  RN_PATH,
  RN_PROTOCOL_VERSION,
  parseRnHello,
  sanitizeRnClientMessage,
  type RnCaptureMessage,
  type RnHostToExtension,
  type RnReceiverStatus,
  type RnReplayRequest,
  type RnSessionInfo,
} from '../../../src/shared/rn-protocol';
import type { Logger } from '../log';
import { loadOrCreateToken, tokenMatches, createToken, writeToken } from './token';
import { FrameDecoder, OP_PONG, OP_TEXT, acceptKey, closeFrame, encodeFrame } from './ws';

/** Max bytes of one app message (a replay result carries up to the replay cap, 10 MB by default, in base64). */
export const RN_MAX_MESSAGE_BYTES = 48 * 1024 * 1024;
/** Max bytes of a message before the handshake succeeded (the hello is small; strangers get no big buffers). */
const MAX_HANDSHAKE_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_HANDSHAKING = 16;
const HANDSHAKE_TIMEOUT_MS = 5000;
/** Captures waiting for the extension are dropped beyond this (the browser is not reading). */
const MAX_OUTPUT_BACKLOG = 256 * 1024 * 1024;

export interface RnConfig {
  enabled: boolean;
  lan: boolean;
  port: number;
}

export interface RnReceiverOptions {
  /** $REQLENS_HOME (the pairing token lives there). */
  home: string;
  /** Write one native messaging message given as JSON text (at most `frameBudget` bytes). False = output gone. */
  sendJson(json: string): boolean;
  /** Bytes written but not yet flushed to the browser (backpressure). */
  backlog?(): number;
  logger: Logger;
  version: string;
  platform?: NodeJS.Platform;
  handshakeTimeoutMs?: number;
  batchMs?: number;
  /** Max JSON bytes per native messaging message (tests use a small one to exercise chunking). */
  frameBudget?: number;
  /** LAN addresses (tests). */
  addresses?(): string[];
}

interface Session {
  info: RnSessionInfo;
  conn: Connection | null;
  /** JSON texts of validated messages waiting for the next flush, with their UTF-8 sizes. */
  queue: string[];
  sizes: number[];
  timer: NodeJS.Timeout | null;
}

interface Connection {
  socket: net.Socket;
  decoder: FrameDecoder | null;
  session: Session | null;
  closed: boolean;
  address: string;
  timer: NodeJS.Timeout | null;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family === 'IPv4' && !item.internal) out.push(item.address);
      }
    }
  } catch {
    /* none */
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RnReceiver {
  private config: RnConfig = { enabled: false, lan: false, port: RN_DEFAULT_PORT };
  private servers: http.Server[] = [];
  private readonly connections = new Set<Connection>();
  private readonly sessions = new Map<string, Session>();
  private token = '';
  private state: RnReceiverStatus = { state: 'off', host: '127.0.0.1', port: RN_DEFAULT_PORT, lan: false, addresses: [], token: '' };
  /** Serializes configure() calls (bind / unbind are async). */
  private chain: Promise<void> = Promise.resolve();
  private chunkSeq = 0;
  private stopped = false;
  private readonly budget: number;
  private readonly batchMs: number;

  constructor(private readonly options: RnReceiverOptions) {
    this.budget = options.frameBudget ?? RN_FRAME_BUDGET;
    this.batchMs = options.batchMs ?? RN_BATCH_MS;
  }

  get status(): RnReceiverStatus {
    return this.state;
  }

  /** Connected app sessions. */
  get sessionList(): RnSessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.conn).map((s) => s.info);
  }

  /** Start, stop or rebind the server. Resolves once applied. */
  configure(next: RnConfig): Promise<void> {
    this.chain = this.chain.then(() => this.apply(next)).catch((err) => this.options.logger.error(`rn configure: ${errorText(err)}`));
    return this.chain;
  }

  /** Relay a replay to the app (an error result comes back at once when the app is not connected). */
  replay(session: string, data: RnReplayRequest): void {
    const target = this.sessions.get(session);
    if (target?.conn && !target.conn.closed) {
      this.write(target.conn, { t: 'replay', data });
      return;
    }
    const now = Date.now();
    this.forward(session, {
      t: 'replay-result',
      data: {
        runId: data.runId,
        ok: false,
        status: 0,
        statusText: '',
        headers: [],
        body: null,
        url: data.url,
        redirected: false,
        timing: { start: now, end: now },
        size: 0,
        error: 'The app is not connected to kineReqLens',
        errorHint: 'Open the app (with startKineReqLens) on the device, or use Extension mode.',
      },
    });
    this.flush(session);
  }

  abort(session: string, runId: string): void {
    const target = this.sessions.get(session);
    if (target?.conn && !target.conn.closed) this.write(target.conn, { t: 'abort', runId });
  }

  /** New pairing token: persisted, reported, and every connected app is disconnected (it must re-pair). */
  regenerateToken(): void {
    if (this.stopped) return;
    const token = createToken();
    try {
      writeToken(this.options.home, token, this.options.platform);
    } catch (err) {
      this.options.logger.error(`rn token: ${errorText(err)}`);
      return;
    }
    this.token = token;
    for (const conn of [...this.connections]) this.close(conn, RN_CLOSE.BAD_TOKEN, 'pairing token changed');
    this.setStatus({ ...this.state, token });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.configure({ ...this.config, enabled: false });
  }

  // ---------------------------------------------------------------------------------------------- server

  private async apply(next: RnConfig): Promise<void> {
    if (this.stopped) {
      // The hub is stopping: close everything, report nothing (the extension is gone or going).
      await this.unbind();
      this.config = { ...next, enabled: false };
      return;
    }
    const wanted = next;
    const same = wanted.enabled === this.config.enabled && wanted.lan === this.config.lan && wanted.port === this.config.port;
    if (same && (this.servers.length > 0 || !wanted.enabled) && this.state.state !== 'error') {
      // Same config: just report the status again (a reconnected extension asks with rn-config).
      this.setStatus(this.state, true);
      return;
    }
    await this.unbind();
    this.config = wanted;
    const host = wanted.lan ? '0.0.0.0' : '127.0.0.1';
    if (!wanted.enabled) {
      this.setStatus({ state: 'off', host, port: wanted.port, lan: wanted.lan, addresses: [], token: this.token });
      return;
    }
    try {
      this.token = loadOrCreateToken(this.options.home, this.options.platform);
    } catch (err) {
      this.setStatus({ state: 'error', host, port: wanted.port, lan: wanted.lan, addresses: [], token: '', error: `Cannot create the pairing token: ${errorText(err)}` });
      return;
    }
    try {
      await this.bind(host, wanted.port);
    } catch (err) {
      await this.unbind();
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '';
      const error =
        code === 'EADDRINUSE'
          ? `Port ${wanted.port} is already in use — pick another port in Settings → React Native (and pass it to startKineReqLens)`
          : `Cannot listen on ${host}:${wanted.port}: ${errorText(err)}`;
      this.setStatus({ state: 'error', host, port: wanted.port, lan: wanted.lan, addresses: [], token: this.token, error });
      return;
    }
    // The iOS simulator may resolve "localhost" to ::1 first: also listen there when IPv6 is available.
    if (!wanted.lan) await this.bind('::1', wanted.port).catch(() => undefined);
    else await this.bind('::', wanted.port, true).catch(() => undefined);
    const addresses = wanted.lan ? (this.options.addresses ?? lanAddresses)() : [];
    this.options.logger.info(`rn receiver listening on ${host}:${wanted.port}${wanted.lan ? ' (LAN)' : ''}`);
    this.setStatus({ state: 'listening', host, port: wanted.port, lan: wanted.lan, addresses, token: this.token });
  }

  private bind(host: string, port: number, ipv6Only = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('kineReqLens React Native receiver: WebSocket upgrade required\n');
      });
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as net.Socket, head));
      server.on('connection', (socket) => socket.on('error', () => undefined));
      const onError = (err: Error): void => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen({ host, port, ipv6Only, exclusive: true }, () => {
        server.off('error', onError);
        server.on('error', (err) => this.options.logger.warn(`rn server error: ${err.message}`));
        this.servers.push(server);
        resolve();
      });
    });
  }

  private async unbind(): Promise<void> {
    for (const conn of [...this.connections]) this.close(conn, 1001, 'receiver closing');
    const servers = this.servers;
    this.servers = [];
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          }),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------- connections

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    socket.on('error', () => undefined);
    const path = (req.url ?? '/').split('?')[0];
    if (path !== RN_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string' || !key || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let handshaking = 0;
    for (const conn of this.connections) if (!conn.session) handshaking++;
    if (this.connections.size >= MAX_CONNECTIONS || handshaking >= MAX_HANDSHAKING) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn: Connection = { socket, decoder: null, session: null, closed: false, address: socket.remoteAddress ?? '', timer: null };
    this.connections.add(conn);
    conn.timer = setTimeout(() => {
      if (!conn.session) this.reject(conn, 'handshake timeout', RN_CLOSE.HANDSHAKE_TIMEOUT);
    }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    conn.timer.unref();
    const decoder = new FrameDecoder(
      {
        onText: (text) => this.onText(conn, text),
        onPing: (payload) => {
          if (!conn.closed) socket.write(encodeFrame(OP_PONG, payload));
        },
        onClose: () => this.close(conn, 1000, ''),
        onError: (code, reason) => this.close(conn, code, reason),
      },
      MAX_HANDSHAKE_MESSAGE_BYTES,
    );
    conn.decoder = decoder;
    socket.on('data', (chunk: Buffer) => decoder.push(chunk));
    socket.on('close', () => this.gone(conn));
    if (head && head.length) decoder.push(head);
  }

  private onText(conn: Connection, text: string): void {
    if (conn.closed) return;
    if (!conn.session) {
      this.handshake(conn, text);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const message = sanitizeRnClientMessage(raw);
    if (!message || message.t === 'pong') return;
    const session = conn.session;
    if (message.t === 'open-ui') {
      // After everything captured so far, so the tab opens with it.
      this.flush(session.info.session);
      this.sendMessage({ t: 'rn-open-ui', session: session.info.session });
      return;
    }
    this.forward(session.info.session, message);
  }

  private handshake(conn: Connection, text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    const v = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined;
    const hello = parseRnHello(raw);
    if (!hello) {
      this.reject(conn, 'expected hello', RN_CLOSE.BAD_HANDSHAKE);
      return;
    }
    if (v !== RN_PROTOCOL_VERSION) {
      this.reject(conn, `unsupported protocol version ${String(v).slice(0, 16)}`, RN_CLOSE.BAD_HANDSHAKE);
      return;
    }
    if (!tokenMatches(this.token, hello.token)) {
      this.reject(conn, 'invalid pairing token', RN_CLOSE.BAD_TOKEN);
      return;
    }
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    if (conn.decoder) conn.decoder.maxMessageBytes = RN_MAX_MESSAGE_BYTES;
    let session = this.sessions.get(hello.session);
    const previous = session?.conn ?? null;
    const info: RnSessionInfo = {
      session: hello.session,
      app: hello.app,
      lib: hello.lib,
      capabilities: hello.capabilities,
      connected: true,
      connectedAt: Date.now(),
      address: conn.address,
    };
    if (session) session.info = info;
    else {
      session = { info, conn: null, queue: [], sizes: [], timer: null };
      this.sessions.set(hello.session, session);
    }
    session.conn = conn;
    conn.session = session;
    // The same app context reconnecting before its old socket closed: the new connection wins.
    if (previous && previous !== conn) {
      previous.session = null;
      this.close(previous, RN_CLOSE.REPLACED, 'replaced by a newer connection');
    }
    this.write(conn, { t: 'welcome', v: RN_PROTOCOL_VERSION, server: { name: 'kineReqLens', version: this.options.version } });
    this.options.logger.info(`rn app connected: ${hello.app.name || '?'} (${hello.app.platform}, session ${hello.session})`);
    this.sendMessage({ t: 'rn-session', ...info });
  }

  private reject(conn: Connection, reason: string, code: number): void {
    this.options.logger.warn(`rn connection rejected: ${reason}`);
    this.write(conn, { t: 'rejected', reason, code });
    this.close(conn, code, reason);
  }

  private write(conn: Connection, message: unknown): void {
    if (conn.closed) return;
    try {
      conn.socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
    } catch {
      this.gone(conn);
    }
  }

  private close(conn: Connection, code: number, reason: string): void {
    if (conn.closed) return;
    try {
      conn.socket.write(closeFrame(code, reason));
      conn.socket.end();
    } catch {
      /* gone */
    }
    const socket = conn.socket;
    setTimeout(() => socket.destroy(), 200).unref();
    this.gone(conn);
  }

  private gone(conn: Connection): void {
    if (conn.closed && !this.connections.has(conn)) return;
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    this.connections.delete(conn);
    const session = conn.session;
    conn.session = null;
    if (!session || session.conn !== conn) return;
    session.conn = null;
    this.flush(session.info.session);
    session.info = { ...session.info, connected: false };
    this.options.logger.info(`rn app disconnected (session ${session.info.session})`);
    this.sendMessage({ t: 'rn-session', ...session.info });
    this.sessions.delete(session.info.session);
  }

  // ---------------------------------------------------------------------------------------------- extension side

  /** Queue a validated message of `session` for the next batch. */
  private forward(sessionId: string, message: RnCaptureMessage): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // An answer for a session that is gone (synthesized replay error): a throwaway queue.
      session = {
        info: { session: sessionId, app: { name: '', bundleId: '', platform: 'ios', rnVersion: '', hermes: false, deviceName: '' }, lib: { name: '', version: '' }, capabilities: [], connected: false, connectedAt: 0, address: '' },
        conn: null,
        queue: [],
        sizes: [],
        timer: null,
      };
      this.sessions.set(sessionId, session);
    }
    const json = JSON.stringify(message);
    session.queue.push(json);
    session.sizes.push(Buffer.byteLength(json));
    if (!session.timer) {
      session.timer = setTimeout(() => this.flush(sessionId), this.batchMs);
      session.timer.unref();
    }
  }

  /** Send the queued messages of a session: as few frames as fit the budget, oversized ones chunked. */
  private flush(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    const queue = session.queue;
    const sizes = session.sizes;
    session.queue = [];
    session.sizes = [];
    if (!session.conn && !session.info.connected && queue.length === 0) this.sessions.delete(sessionId);
    if (queue.length === 0) return;
    if ((this.options.backlog?.() ?? 0) > MAX_OUTPUT_BACKLOG) {
      this.options.logger.warn(`rn: browser not reading, ${queue.length} captures dropped`);
      queue.length = 0;
      queue.push(JSON.stringify({ t: 'dropped', count: sizes.length }));
      sizes.length = 0;
      sizes.push(queue[0]!.length);
    }
    const prefix = `{"t":"rn-capture","session":${JSON.stringify(sessionId)},"msgs":[`;
    const suffix = ']}';
    const overhead = Buffer.byteLength(prefix) + suffix.length;
    let group: string[] = [];
    let bytes = overhead;
    const emit = (): void => {
      if (group.length) this.sendJson(prefix + group.join(',') + suffix);
      group = [];
      bytes = overhead;
    };
    for (let i = 0; i < queue.length; i++) {
      const json = queue[i]!;
      const size = sizes[i]! + 1;
      if (overhead + size > this.budget) {
        emit();
        this.sendJson(prefix + json + suffix);
        continue;
      }
      if (bytes + size > this.budget) emit();
      group.push(json);
      bytes += size;
    }
    emit();
    if (!session.conn && !session.info.connected) this.sessions.delete(sessionId);
  }

  private sendMessage(message: RnHostToExtension): void {
    this.sendJson(JSON.stringify(message));
  }

  /** One message as one frame, or as rn-chunk parts when it is larger than the budget. */
  private sendJson(json: string): void {
    if (Buffer.byteLength(json) <= this.budget) {
      this.options.sendJson(json);
      return;
    }
    // JSON-escaping a part at most triples it (quotes / backslashes double, non-ASCII is ≤ 3 UTF-8 bytes).
    const partChars = Math.max(2, Math.floor((this.budget - 200) / 3));
    const parts: string[] = [];
    for (let at = 0; at < json.length; ) {
      let end = Math.min(json.length, at + partChars);
      // Never split a surrogate pair.
      if (end < json.length) {
        const c = json.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
      }
      parts.push(json.slice(at, end));
      at = end;
    }
    const id = `c${++this.chunkSeq}`;
    parts.forEach((part, seq) => this.options.sendJson(JSON.stringify({ t: 'rn-chunk', id, seq, total: parts.length, part })));
  }

  private setStatus(next: RnReceiverStatus, force = false): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed || force) {
      this.sendMessage({ t: 'rn-status', status: next });
      // A (re)connected extension also needs the apps that are connected right now.
      if (force) for (const session of this.sessions.values()) if (session.conn) this.sendMessage({ t: 'rn-session', ...session.info });
    }
  }
}
