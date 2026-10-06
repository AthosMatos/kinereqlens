// The hub (`reqlens-mcp native-host`): spawned by the browser through native messaging, it relays between the
// extension (native messaging frames on stdin/stdout) and every Claude Code session's MCP server (NDJSON on
// the Unix socket $REQLENS_HOME/hub.sock). It keeps nothing but the session list, and stops when the browser
// closes stdin. Never writes anything but native messaging frames to `output`.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  BRIDGE_PROTOCOL_VERSION,
  HUB_FEATURE_FS,
  NATIVE_MAX_INBOUND_BYTES,
  type BridgeMethod,
  type ClaudeSessionInfo,
  type ExtensionToHost,
  type HostToExtension,
  type HubToMcp,
  type InboxItem,
} from '../../src/shared/claude-protocol';
import { LineDecoder, MAX_LINE_BYTES, encodeLine } from './line-protocol';
import { type Logger, silentLogger } from './log';
import { parseExtensionMessage, parseMcpMessage, sessionInfo } from './messages';
import { NativeMessageDecoder, encodeNativeMessage } from './nm-framing';
import { hubSocketPath, socketPathProblem } from './paths';
import { FsService, type FsServiceOptions } from './fs';
import { PtyManager, type PtyManagerOptions } from './pty';
import { RnReceiver, type RnReceiverOptions } from './rn/receiver';
import { RunManager, type RunManagerOptions } from './runs';
import { HUB_FEATURE_RUNS } from '../../src/shared/errors-protocol';
import { HUB_FEATURE_SHOTS } from '../../src/shared/shot-protocol';
import { ShotStore, type ShotStoreOptions } from './shots';

/** Error the extension shows when a second browser (profile) starts a hub while another one is live. */
export const HUB_BUSY_ERROR = 'Another browser is already connected to Claude Code';
/** Sent to MCP servers for requests still pending when the extension goes away. */
export const EXTENSION_GONE_ERROR = 'The browser disconnected before answering (kineReqLens bridge closed)';

/** Hub-side safety net for requests the extension never answers (MCP servers time out much earlier). */
const HUB_REQUEST_TIMEOUT_MS = 15 * 60_000;
const MAX_PENDING_PER_CONNECTION = 64;
const MAX_PROTOCOL_ERRORS = 20;
const PROBE_TIMEOUT_MS = 1000;

export interface HubOptions {
  /** $REQLENS_HOME (created 0700 when missing). */
  home: string;
  /** Defaults to hubSocketPath(home). */
  socketPath?: string;
  /** Native messaging from the extension (the process stdin). */
  input: NodeJS.ReadableStream;
  /** Native messaging to the extension (the process stdout). */
  output: NodeJS.WritableStream;
  version: string;
  logger?: Logger;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  /** Socket lines longer than this are dropped (default MAX_LINE_BYTES = 16 MB). */
  maxLineBytes?: number;
  /** Embedded terminal options (tests inject a fake node-pty; cli.ts passes the repo dir for hints). */
  pty?: Omit<PtyManagerOptions, 'send' | 'logger'>;
  /** Folder browser options (tests inject a fake chooser, a home directory). */
  fs?: Omit<FsServiceOptions, 'send' | 'logger'>;
  /** React Native receiver options (tests: timings, frame budget). */
  rn?: Partial<Omit<RnReceiverOptions, 'home' | 'sendJson' | 'logger' | 'version'>>;
  /** Errors view runs / git ops (tests: env with the REQLENS_CLAUDE_COMMAND / REQLENS_GH_COMMAND stand-ins). */
  runs?: Partial<Omit<RunManagerOptions, 'send' | 'logger' | 'home'>>;
  /** "Send to Claude" screenshots (tests: clock, limits, retention). */
  shots?: Partial<Omit<ShotStoreOptions, 'send' | 'logger' | 'dir'>>;
}

export type HubStartResult =
  | { status: 'listening'; socketPath: string }
  /** Another live hub owns the socket (told the extension, then stopped). */
  | { status: 'refused'; reason: string }
  | { status: 'error'; reason: string };

interface Connection {
  socket: net.Socket;
  session: ClaudeSessionInfo | null;
  /** Hub request ids in flight for this connection. */
  pending: Set<string>;
  errors: number;
}

interface PendingRequest {
  conn: Connection;
  clientId: string;
  timer: NodeJS.Timeout;
}

interface ExtensionInfo {
  connected: boolean;
  version?: string;
  browser?: string;
}

/** The native messaging ↔ socket relay. */
export class Hub {
  readonly socketPath: string;
  /** Resolves once the hub has stopped (extension gone, refused, or stop()). */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private server: net.Server | null = null;
  private listening: Promise<void> | null = null;
  /** inode of the socket file we bound, so shutdown never unlinks another hub's socket. */
  private socketIno: number | null = null;
  private readonly connections = new Set<Connection>();
  private readonly sessions = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingRequest>();
  private extension: ExtensionInfo = { connected: false };
  /** Embedded terminals (`pty-*` messages from the extension). */
  readonly ptys: PtyManager;
  /** Folder browser of the terminal's new-session form (`fs-*` messages from the extension). */
  readonly folders: FsService;
  /** React Native receiver (`rn-*` messages from the extension). */
  readonly rn: RnReceiver;
  /** Errors view: Claude runs and full-mode git / gh operations (`run-*`, `op-*`, `errors-config`). */
  readonly runs: RunManager;
  /** "Send to Claude" screenshots (`shot-save` messages): $REQLENS_HOME/shots/shot-*.png, kept 24 h. */
  readonly shots: ShotStore;
  private outputOpen = true;
  private stopping = false;
  private seq = 0;

  constructor(private readonly options: HubOptions) {
    this.platform = options.platform ?? process.platform;
    this.socketPath = options.socketPath ?? hubSocketPath(options.home, this.platform);
    this.logger = options.logger ?? silentLogger;
    this.timeoutMs = options.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS;
    this.ptys = new PtyManager({ ...(options.pty ?? {}), logger: this.logger, send: (message) => void this.sendExtension(message) });
    this.folders = new FsService({ ...(options.fs ?? {}), logger: this.logger, send: (message) => void this.sendExtension(message) });
    this.runs = new RunManager({ ...(options.runs ?? {}), home: options.home, logger: this.logger, send: (message) => void this.sendExtension(message) });
    this.shots = new ShotStore({
      platform: this.platform,
      ...(options.shots ?? {}),
      dir: this.runs.shotsDir,
      logger: this.logger,
      send: (message) => void this.sendExtension(message),
    });
    this.rn = new RnReceiver({
      ...(options.rn ?? {}),
      home: options.home,
      version: options.version,
      logger: this.logger,
      platform: this.platform,
      sendJson: (json) => this.sendExtensionJson(json),
      backlog: () => {
        const output = this.options.output as NodeJS.WritableStream & { writableLength?: number };
        return typeof output.writableLength === 'number' ? output.writableLength : 0;
      },
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** Connected Claude Code sessions, oldest first. */
  get sessionList(): ClaudeSessionInfo[] {
    const out: ClaudeSessionInfo[] = [];
    for (const conn of this.sessions.values()) if (conn.session) out.push(conn.session);
    return out.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** Start reading the extension and listening on the socket. */
  async start(): Promise<HubStartResult> {
    this.attachExtension();
    const problem = this.platform === 'win32' ? null : socketPathProblem(this.socketPath, this.platform);
    if (problem) return this.fail('error', problem);
    try {
      this.prepareHome();
      this.listening = this.listen();
      await this.listening;
    } catch (err) {
      if (err instanceof HubBusyError) return this.fail('refused', HUB_BUSY_ERROR);
      return this.fail('error', `Cannot listen on ${this.socketPath}: ${errorText(err)}`);
    }
    if (this.stopping) return { status: 'error', reason: 'stopped during startup' };
    this.logger.info(`listening on ${this.socketPath}`);
    // This hub owns $REQLENS_HOME now: run screenshots a previous (crashed) hub left behind go; "Send to Claude"
    // screenshots are kept for 24 h (sessions read them later), pruned now and hourly.
    this.runs.cleanShots();
    this.shots.start();
    this.sendExtension({
      t: 'hello',
      v: BRIDGE_PROTOCOL_VERSION,
      hostVersion: this.options.version,
      features: [HUB_FEATURE_FS, HUB_FEATURE_RUNS, HUB_FEATURE_SHOTS],
    });
    this.sendSessions();
    return { status: 'listening', socketPath: this.socketPath };
  }

  /** Stop: fail pending calls, tell MCP servers, close the socket. Idempotent. */
  async stop(reason = 'stopped'): Promise<void> {
    if (this.stopping) return this.closed;
    this.stopping = true;
    this.logger.info(`stopping: ${reason}`);
    this.ptys.killAll(reason);
    this.folders.stop();
    this.runs.stop();
    this.shots.stop();
    const rnStopped = this.rn.stop();
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.sendConn(request.conn, { t: 'res', id: request.clientId, ok: false, error: EXTENSION_GONE_ERROR });
      this.pending.delete(id);
    }
    if (this.extension.connected) this.broadcast({ t: 'ext', connected: false });
    for (const conn of this.connections) conn.socket.end();
    // A stop during startup waits for the bind to settle so the server it creates is closed too.
    await this.listening?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          for (const conn of this.connections) conn.socket.destroy();
        }, 500);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
      this.unlinkOwnSocket();
    }
    await rnStopped;
    this.resolveClosed();
  }

  // ---------------------------------------------------------------------------------------------------
  // Extension side
  // ---------------------------------------------------------------------------------------------------

  private attachExtension(): void {
    const decoder = new NativeMessageDecoder({
      onMessage: (message) => this.onExtensionMessage(message),
      onError: (error) => this.logger.warn(`extension frame dropped: ${error.kind} (${error.bytes} bytes)`),
    });
    const input = this.options.input;
    input.on('data', (chunk: Buffer | string) => decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    input.on('end', () => void this.stop('extension disconnected (stdin closed)'));
    input.on('close', () => void this.stop('extension disconnected (stdin closed)'));
    input.on('error', (err: unknown) => void this.stop(`stdin error: ${errorText(err)}`));
    this.options.output.on('error', (err: unknown) => {
      this.outputOpen = false;
      void this.stop(`stdout error: ${errorText(err)}`);
    });
  }

  private onExtensionMessage(raw: unknown): void {
    const message = parseExtensionMessage(raw);
    if (!message) {
      this.logger.warn('invalid message from the extension dropped');
      return;
    }
    switch (message.t) {
      case 'hello':
        this.onExtensionHello(message);
        return;
      case 'res':
        this.onExtensionResponse(message);
        return;
      case 'push':
        this.onPush(message.item);
        return;
      case 'pty-open':
      case 'pty-input':
      case 'pty-resize':
      case 'pty-close':
        this.ptys.handle(message);
        return;
      case 'fs-list':
      case 'fs-pick':
      case 'fs-projects':
        this.folders.handle(message);
        return;
      case 'run-start':
      case 'run-cancel':
      case 'op-start':
      case 'errors-config':
        this.runs.handle(message);
        return;
      case 'rn-config':
        if (!this.stopping) void this.rn.configure({ enabled: message.enabled, lan: message.lan, port: message.port });
        return;
      case 'rn-replay':
        this.rn.replay(message.session, message.data);
        return;
      case 'rn-abort':
        this.rn.abort(message.session, message.runId);
        return;
      case 'rn-token':
        this.rn.regenerateToken();
        return;
      case 'shot-save':
        this.shots.handle(message);
        return;
    }
  }

  private onExtensionHello(message: Extract<ExtensionToHost, { t: 'hello' }>): void {
    this.logger.info(`extension hello: v${message.v} ${message.extensionId} ${message.extensionVersion} (${message.browser})`);
    this.extension = { connected: true, version: message.extensionVersion, browser: message.browser };
    this.broadcast({ t: 'ext', ...this.extension });
  }

  private onExtensionResponse(message: Extract<ExtensionToHost, { t: 'res' }>): void {
    const request = this.pending.get(message.id);
    if (!request) {
      this.logger.warn(`response for unknown request ${message.id} dropped`);
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    request.conn.pending.delete(message.id);
    const reply: HubToMcp = message.ok
      ? { t: 'res', id: request.clientId, ok: true, result: message.result }
      : { t: 'res', id: request.clientId, ok: false, error: message.error };
    this.sendConn(request.conn, reply);
  }

  private onPush(item: InboxItem): void {
    if (item.images?.some((image) => path.dirname(image.path) !== this.shots.dir)) {
      this.logger.warn(`push ${item.id} dropped: screenshot outside ${this.shots.dir}`);
      return;
    }
    if (item.sessionId) {
      const conn = this.sessions.get(item.sessionId);
      if (!conn) {
        this.logger.warn(`push ${item.id} for unknown session ${item.sessionId} dropped`);
        return;
      }
      this.sendConn(conn, { t: 'push', item });
      return;
    }
    this.broadcast({ t: 'push', item });
  }

  private sendExtension(message: HostToExtension): boolean {
    if (!this.outputOpen) return false;
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(message, NATIVE_MAX_INBOUND_BYTES);
    } catch (err) {
      this.logger.error(`cannot send ${message.t} to the extension: ${errorText(err)}`);
      return false;
    }
    try {
      this.options.output.write(frame);
      return true;
    } catch (err) {
      this.outputOpen = false;
      void this.stop(`stdout write failed: ${errorText(err)}`);
      return false;
    }
  }

  /** One native messaging frame from JSON text (the React Native receiver keeps it under the 1 MiB limit). */
  private sendExtensionJson(json: string): boolean {
    if (!this.outputOpen) return false;
    const body = Buffer.from(json, 'utf8');
    if (body.length > NATIVE_MAX_INBOUND_BYTES) {
      this.logger.error(`rn message too large for native messaging (${body.length} bytes) dropped`);
      return false;
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    try {
      this.options.output.write(frame);
      return true;
    } catch (err) {
      this.outputOpen = false;
      void this.stop(`stdout write failed: ${errorText(err)}`);
      return false;
    }
  }

  private sendSessions(): void {
    if (this.stopping) return;
    this.sendExtension({ t: 'sessions', sessions: this.sessionList });
  }

  // ---------------------------------------------------------------------------------------------------
  // Socket side
  // ---------------------------------------------------------------------------------------------------

  private prepareHome(): void {
    if (this.platform === 'win32') return;
    fs.mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.options.home, 0o700);
    } catch {
      // Not ours to change (e.g. a shared REQLENS_HOME): the socket itself is still 0600.
    }
  }

  private async listen(): Promise<void> {
    try {
      await this.bind();
    } catch (err) {
      if (errorCode(err) !== 'EADDRINUSE') throw err;
      if (this.platform === 'win32' || (await probeSocket(this.socketPath)) === 'live') throw new HubBusyError();
      const stat = fs.lstatSync(this.socketPath, { throwIfNoEntry: false });
      if (stat && !stat.isSocket()) throw new Error(`${this.socketPath} exists and is not a socket`);
      this.logger.warn('removing stale hub socket');
      fs.rmSync(this.socketPath, { force: true });
      await this.bind();
    }
    if (this.platform !== 'win32') {
      fs.chmodSync(this.socketPath, 0o600);
      this.socketIno = fs.statSync(this.socketPath).ino;
    }
  }

  private bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      const onError = (err: Error): void => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        server.on('error', (err) => this.logger.error(`socket server error: ${err.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  private unlinkOwnSocket(): void {
    if (this.platform === 'win32' || this.socketIno === null) return;
    try {
      const stat = fs.lstatSync(this.socketPath, { throwIfNoEntry: false });
      if (stat && stat.isSocket() && stat.ino === this.socketIno) fs.unlinkSync(this.socketPath);
    } catch (err) {
      this.logger.warn(`cannot remove the socket: ${errorText(err)}`);
    }
  }

  private onConnection(socket: net.Socket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const conn: Connection = { socket, session: null, pending: new Set(), errors: 0 };
    this.connections.add(conn);
    const decoder = new LineDecoder({
      maxLineBytes: this.options.maxLineBytes ?? MAX_LINE_BYTES,
      onMessage: (message) => this.onConnMessage(conn, message),
      onError: (error) => this.protocolError(conn, `line dropped: ${error.kind} (${error.bytes} bytes)`),
    });
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (err) => this.logger.warn(`session socket error: ${err.message}`));
    socket.on('close', () => this.onConnClose(conn));
  }

  private onConnMessage(conn: Connection, raw: unknown): void {
    const parsed = parseMcpMessage(raw);
    if (!parsed.ok) {
      if (parsed.id !== undefined) this.sendConn(conn, { t: 'res', id: parsed.id, ok: false, error: parsed.error });
      this.protocolError(conn, parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.t === 'hello') {
      this.onSessionHello(conn, message.v, message.session);
      return;
    }
    if (!conn.session) {
      this.sendConn(conn, { t: 'res', id: message.id, ok: false, error: 'Send hello before requests' });
      return;
    }
    this.forwardRequest(conn, message.id, message.method, message.params);
  }

  private onSessionHello(conn: Connection, version: number, session: Omit<ClaudeSessionInfo, 'connectedAt'>): void {
    if (conn.session) {
      this.protocolError(conn, 'duplicate hello');
      return;
    }
    if (version !== BRIDGE_PROTOCOL_VERSION) this.logger.warn(`session ${session.id} speaks protocol v${version}`);
    const previous = this.sessions.get(session.id);
    if (previous) {
      // Same MCP server reconnecting before we noticed its old socket closing: the new connection wins.
      previous.session = null;
      previous.socket.destroy();
    }
    conn.session = sessionInfo(session, Date.now());
    this.sessions.set(session.id, conn);
    this.logger.info(`session ${session.id} connected (${session.label}, pid ${session.pid})`);
    this.sendConn(conn, {
      t: 'hello',
      v: BRIDGE_PROTOCOL_VERSION,
      hostVersion: this.options.version,
      extension: { ...this.extension },
    });
    this.sendSessions();
  }

  private forwardRequest(conn: Connection, clientId: string, method: BridgeMethod, params: unknown): void {
    const session = conn.session;
    if (!session) return;
    const fail = (error: string): void => this.sendConn(conn, { t: 'res', id: clientId, ok: false, error });
    if (this.stopping || !this.outputOpen) return fail(EXTENSION_GONE_ERROR);
    if (conn.pending.size >= MAX_PENDING_PER_CONNECTION) return fail('Too many concurrent kineReqLens requests');
    const id = `${++this.seq}`;
    const message: HostToExtension = { t: 'req', id, sessionId: session.id, method, params };
    let frame: Buffer;
    try {
      frame = encodeNativeMessage(message, NATIVE_MAX_INBOUND_BYTES);
    } catch (err) {
      return fail(`Request too large for the browser bridge: ${errorText(err)}`);
    }
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      conn.pending.delete(id);
      fail('The kineReqLens extension did not answer');
    }, this.timeoutMs);
    timer.unref();
    this.pending.set(id, { conn, clientId, timer });
    conn.pending.add(id);
    try {
      this.options.output.write(frame);
    } catch (err) {
      this.outputOpen = false;
      void this.stop(`stdout write failed: ${errorText(err)}`);
    }
  }

  private onConnClose(conn: Connection): void {
    this.connections.delete(conn);
    for (const id of conn.pending) {
      const request = this.pending.get(id);
      if (request) clearTimeout(request.timer);
      this.pending.delete(id);
    }
    conn.pending.clear();
    const session = conn.session;
    if (session && this.sessions.get(session.id) === conn) {
      this.sessions.delete(session.id);
      this.logger.info(`session ${session.id} disconnected`);
      this.sendSessions();
    }
  }

  private protocolError(conn: Connection, error: string): void {
    this.logger.warn(`session protocol error: ${error}`);
    conn.errors += 1;
    if (conn.errors >= MAX_PROTOCOL_ERRORS) conn.socket.destroy();
  }

  private sendConn(conn: Connection, message: HubToMcp): void {
    if (conn.socket.destroyed || !conn.socket.writable) return;
    let line = encodeLine(message);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      if (message.t !== 'res') {
        this.logger.warn(`${message.t} too large for the hub socket dropped`);
        return;
      }
      line = encodeLine({ t: 'res', id: message.id, ok: false, error: 'Response too large for the hub socket' });
    }
    conn.socket.write(line);
  }

  private broadcast(message: HubToMcp): void {
    for (const conn of this.sessions.values()) this.sendConn(conn, message);
  }

  private fail(status: 'refused' | 'error', reason: string): HubStartResult {
    this.logger.error(reason);
    // Not part of HostToExtension: the extension shows `error` from a hello when present.
    const notice = { t: 'hello', v: BRIDGE_PROTOCOL_VERSION, hostVersion: this.options.version, error: reason };
    this.sendExtension(notice as HostToExtension);
    void this.stop(reason);
    return { status, reason };
  }
}

class HubBusyError extends Error {
  constructor() {
    super(HUB_BUSY_ERROR);
  }
}

/** Is a hub listening on `socketPath`? ('stale' = the file exists but nobody accepts). */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<'live' | 'stale' | 'missing'> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (result: 'live' | 'stale' | 'missing'): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // A hub that does not even accept within the timeout is treated as live (never steal its socket).
    const timer = setTimeout(() => done('live'), timeoutMs);
    socket.once('connect', () => done('live'));
    socket.once('error', (err) => done(errorCode(err) === 'ENOENT' ? 'missing' : 'stale'));
  });
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
