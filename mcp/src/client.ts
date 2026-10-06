// MCP-server side of the hub socket: connects to $REQLENS_HOME/hub.sock, introduces this Claude Code session
// (`hello`), turns bridge calls into `req` lines with per-request timeouts, and hands pushed inbox items to the
// server. Reconnects with backoff (0.5 s doubling to 10 s) and immediately when the socket file reappears.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeCalls,
  type BridgeMethod,
  type ClaudeSessionInfo,
  type HubToMcp,
  type InboxItem,
} from '../../src/shared/claude-protocol';
import { LineDecoder, MAX_LINE_BYTES, encodeLine } from './line-protocol';
import { type Logger, silentLogger } from './log';
import { parseHubMessage } from './messages';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long a call waits for an in-flight (re)connection before reporting "not connected". */
const CONNECT_WAIT_MS = 1500;
const HELLO_TIMEOUT_MS = 5000;

export type HubConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed';

export interface ExtensionLink {
  connected: boolean;
  version?: string;
  browser?: string;
}

export interface HubClientStatus {
  state: HubConnectionState;
  extension: ExtensionLink;
  hostVersion?: string;
  hubProtocol?: number;
  /** errno code of the last failed attempt or drop (ENOENT = no hub, ECONNREFUSED = stale socket, EACCES). */
  lastErrorCode?: string;
  lastError?: string;
}

export type BridgeErrorCode = 'not-connected' | 'timeout' | 'disconnected' | 'remote' | 'too-large';

/** A failed bridge call; `code` lets the tools add setup hints. */
export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** The part of HubClient the MCP tools use (tests substitute fakes). */
export interface BridgeClient {
  status(): HubClientStatus;
  call<M extends BridgeMethod>(
    method: M,
    params: BridgeCalls[M]['params'],
    options?: { timeoutMs?: number },
  ): Promise<BridgeCalls[M]['result']>;
}

export interface HubClientOptions {
  socketPath: string;
  session: Omit<ClaudeSessionInfo, 'connectedAt'>;
  logger?: Logger;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** Directory watched for the socket file (default: its parent; null disables, as on Windows pipes). */
  watchDir?: string | null;
  onPush?: (item: InboxItem) => void;
  onStatus?: (status: HubClientStatus) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Reconnecting client of the hub socket. */
export class HubClient implements BridgeClient {
  private readonly logger: Logger;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly timeoutMs: number;
  private readonly watchDir: string | null;
  private socket: net.Socket | null = null;
  private state: HubConnectionState = 'idle';
  private extension: ExtensionLink = { connected: false };
  private hostVersion: string | undefined;
  private hubProtocol: number | undefined;
  private lastErrorCode: string | undefined;
  private lastError: string | undefined;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly pending = new Map<string, Pending>();
  private waiters: Array<(connected: boolean) => void> = [];
  private seq = 0;

  constructor(private readonly options: HubClientOptions) {
    this.logger = options.logger ?? silentLogger;
    this.minBackoff = options.minBackoffMs ?? 500;
    this.maxBackoff = options.maxBackoffMs ?? 10_000;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.watchDir = options.watchDir === undefined ? path.dirname(options.socketPath) : options.watchDir;
    this.backoff = this.minBackoff;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  /** Stop reconnecting and drop the connection (pending calls fail). */
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.watcher?.close();
    this.watcher = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.failPending(new BridgeError('disconnected', 'The kineReqLens MCP server is shutting down'));
    this.settleWaiters(false);
  }

  status(): HubClientStatus {
    const out: HubClientStatus = { state: this.state, extension: { ...this.extension } };
    if (this.hostVersion !== undefined) out.hostVersion = this.hostVersion;
    if (this.hubProtocol !== undefined) out.hubProtocol = this.hubProtocol;
    if (this.lastErrorCode !== undefined) out.lastErrorCode = this.lastErrorCode;
    if (this.lastError !== undefined) out.lastError = this.lastError;
    return out;
  }

  /**
   * Resolves true once connected to the hub. Between attempts it starts one immediately, so a hub that came
   * up since the last attempt is found without waiting for the backoff.
   */
  ensureConnected(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    if (this.state === 'closed') return Promise.resolve(false);
    if (!this.socket) this.connectNow();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (connected: boolean): void => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(connected);
      };
      this.waiters.push(finish);
    });
  }

  async call<M extends BridgeMethod>(
    method: M,
    params: BridgeCalls[M]['params'],
    options: { timeoutMs?: number } = {},
  ): Promise<BridgeCalls[M]['result']> {
    if (!(await this.ensureConnected())) throw new BridgeError('not-connected', 'Not connected to the kineReqLens hub');
    const socket = this.socket;
    if (!socket) throw new BridgeError('not-connected', 'Not connected to the kineReqLens hub');
    const id = `${++this.seq}`;
    const line = encodeLine({ t: 'req', id, method, params });
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new BridgeError('too-large', 'Request too large');
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `kineReqLens did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(line);
    });
    return result as BridgeCalls[M]['result'];
  }

  // ---------------------------------------------------------------------------------------------------

  private connectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private connect(): void {
    if (this.state === 'closed' || this.socket) return;
    this.setState('connecting');
    this.ensureWatcher();
    const socket = net.connect(this.options.socketPath);
    this.socket = socket;
    const decoder = new LineDecoder({
      maxLineBytes: MAX_LINE_BYTES,
      onMessage: (message) => this.onHubMessage(socket, message),
      onError: (error) => this.logger.warn(`hub line dropped: ${error.kind} (${error.bytes} bytes)`),
    });
    socket.on('connect', () => {
      socket.write(encodeLine({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, session: this.options.session }));
      // Something that accepts but never says hello is not a hub: drop it and retry later.
      const helloTimer = setTimeout(() => {
        if (this.socket !== socket || this.state === 'connected') return;
        this.lastErrorCode = 'ETIMEDOUT';
        this.lastError = 'The hub did not answer hello';
        socket.destroy();
      }, HELLO_TIMEOUT_MS);
      helloTimer.unref();
    });
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.lastErrorCode = err.code;
      this.lastError = err.message;
    });
    socket.on('close', () => this.onClose(socket));
  }

  private onHubMessage(socket: net.Socket, raw: unknown): void {
    if (socket !== this.socket) return;
    const message = parseHubMessage(raw);
    if (!message) {
      this.logger.warn('invalid message from the hub dropped');
      return;
    }
    switch (message.t) {
      case 'hello':
        this.onHello(message);
        return;
      case 'ext':
        this.extension = linkOf(message);
        this.notifyStatus();
        return;
      case 'res':
        this.onResponse(message);
        return;
      case 'push':
        if (message.item.sessionId && message.item.sessionId !== this.options.session.id) return;
        this.options.onPush?.(message.item);
        return;
    }
  }

  private onHello(message: Extract<HubToMcp, { t: 'hello' }>): void {
    if (message.v !== BRIDGE_PROTOCOL_VERSION) {
      this.logger.warn(`hub speaks bridge protocol v${message.v}, this server v${BRIDGE_PROTOCOL_VERSION}`);
    }
    this.hostVersion = message.hostVersion;
    this.hubProtocol = message.v;
    this.extension = linkOf(message.extension);
    this.lastErrorCode = undefined;
    this.lastError = undefined;
    this.backoff = this.minBackoff;
    this.logger.info(`connected to the hub ${message.hostVersion} (extension ${this.extension.connected ? 'connected' : 'not connected'})`);
    this.setState('connected');
    this.settleWaiters(true);
  }

  private onResponse(message: Extract<HubToMcp, { t: 'res' }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new BridgeError('remote', message.error));
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    const wasConnected = this.state === 'connected';
    this.extension = { connected: false };
    if (wasConnected) this.logger.warn('lost the connection to the hub');
    this.failPending(
      new BridgeError('disconnected', 'Lost the connection to kineReqLens (the browser closed or the bridge was disabled)'),
    );
    if (this.state === 'closed') return;
    this.setState('disconnected');
    this.settleWaiters(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state === 'closed') return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  /** Watch the socket's directory so a hub starting up is picked up at once (best effort). */
  private ensureWatcher(): void {
    if (this.watcher || !this.watchDir) return;
    const name = path.basename(this.options.socketPath);
    try {
      this.watcher = fs.watch(this.watchDir, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== name) return;
        if (this.state === 'connected' || this.state === 'closed' || this.socket) return;
        this.connectNow();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // The directory does not exist yet: retried on the next attempt.
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private settleWaiters(connected: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(connected);
  }

  private setState(state: HubConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    this.options.onStatus?.(this.status());
  }
}

function linkOf(info: { connected: boolean; version?: string; browser?: string }): ExtensionLink {
  const link: ExtensionLink = { connected: info.connected };
  if (info.version) link.version = info.version;
  if (info.browser) link.browser = info.browser;
  return link;
}
