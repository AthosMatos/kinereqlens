// Native messaging port to the Claude Code hub (`reqlens-mcp native-host`, docs/specs/v0.2.md §B.1/§B.4).
// Connected while the bridge is wanted (settings.claudeBridge && the optional nativeMessaging permission);
// failures are classified from chrome.runtime.lastError and retried with backoff (1 s → 30 s) while wanted.
// An open native port keeps the MV3 service worker alive; after a worker restart the bridge reconnects at
// startup.
import { BRIDGE_PROTOCOL_VERSION, HUB_FEATURE_FS, NATIVE_HOST_NAME } from '../../shared/claude-protocol';
import type { BridgeHostState, ClaudeSessionInfo, ExtensionToHost, FsFromHost, FsToHost, InboxItem, PtyFromHost, PtyToHost } from '../../shared/claude-protocol';
import { isFsMessageType, parseFsFromHost } from '../../shared/fs';
import { isPtyMessageType, parsePtyFromHost } from '../../shared/pty';
import { HUB_FEATURE_RUNS, isRunMessageType, parseRunFromHost } from '../../shared/errors-protocol';
import type { ErrorsConfigToHost, OpFromHost, OpToHost, RunFromHost, RunToHost } from '../../shared/errors-protocol';
import type { RnExtensionToHost } from '../../shared/rn-protocol';
import { HUB_FEATURE_SHOTS, isShotMessageType, parseShotFromHost } from '../../shared/shot-protocol';
import type { ShotFromHost, ShotToHost } from '../../shared/shot-protocol';
import { isRnHostMessageType } from '../rn/messages';
import { errorMessage, isRecord } from '../util';

export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** A host that never says hello is treated as broken. */
export const HELLO_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 64;
const MAX_ID = 128;

/** Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s … capped at 30 s. */
export function reconnectDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), 16) : 0;
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** n);
}

export interface DisconnectReason {
  host: Extract<BridgeHostState, 'not-installed' | 'error'>;
  error: string;
}

/** Classify the chrome.runtime.lastError message of a native port that disconnected. */
export function classifyDisconnect(lastError: string | undefined, extensionId: string): DisconnectReason {
  const message = (lastError ?? '').trim();
  const install = `npm run mcp:install -- --extension-id ${extensionId}`;
  if (/native messaging host not found/i.test(message)) {
    return { host: 'not-installed', error: `The kineReqLens bridge is not installed — run \`${install}\`` };
  }
  if (/forbidden/i.test(message)) {
    return { host: 'error', error: `This extension is not allowed to use the kineReqLens bridge — re-run \`${install}\`` };
  }
  if (/has exited/i.test(message)) return { host: 'error', error: 'The kineReqLens bridge exited (see ~/.reqlens/hub.log)' };
  return { host: 'error', error: message || 'The kineReqLens bridge disconnected' };
}

/** A bridge call relayed by the hub. `method` is unchecked. */
export interface HostRequest {
  id: string;
  sessionId: string;
  method: string;
  params: unknown;
}

/** A validated message from the hub. */
export type ParsedHostMessage =
  | { t: 'hello'; v: number; hostVersion: string; features?: string[] }
  | { t: 'sessions'; sessions: ClaudeSessionInfo[] }
  | { t: 'req'; req: HostRequest }
  /** The hub reports a problem with itself (e.g. another browser owns the socket) before exiting. */
  | { t: 'host-error'; error: string }
  /** Embedded terminal event (validated by parsePtyFromHost). */
  | { t: 'pty'; message: PtyFromHost }
  /** Folder browser answer (validated by parseFsFromHost). */
  | { t: 'fs'; message: FsFromHost }
  /** Errors view run / op message (validated by parseRunFromHost). */
  | { t: 'run'; message: RunFromHost | OpFromHost }
  /** React Native receiver message (validated by the RnBridge, src/background/rn/messages.ts). */
  | { t: 'rn'; message: Record<string, unknown> }
  /** "Send to Claude" screenshot answer (validated by parseShotFromHost). */
  | { t: 'shot'; message: ShotFromHost };

function cleanString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function parseSession(value: unknown): ClaudeSessionInfo | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, MAX_ID);
  const label = cleanString(value.label, 256);
  const cwd = cleanString(value.cwd, 4096);
  const { pid, connectedAt } = value;
  if (!id || label === null || cwd === null) return null;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) return null;
  if (typeof connectedAt !== 'number' || !Number.isFinite(connectedAt)) return null;
  const session: ClaudeSessionInfo = { id, label, cwd, pid, connectedAt };
  if (typeof value.ppid === 'number' && Number.isSafeInteger(value.ppid) && value.ppid > 0) session.ppid = value.ppid;
  return session;
}

/** Validate one message of the hub (null = ignore it). */
export function parseHostMessage(value: unknown): ParsedHostMessage | null {
  if (!isRecord(value)) return null;
  if (isPtyMessageType(value.t)) {
    const message = parsePtyFromHost(value);
    return message ? { t: 'pty', message } : null;
  }
  if (isFsMessageType(value.t)) {
    const message = parseFsFromHost(value);
    return message ? { t: 'fs', message } : null;
  }
  if (isRnHostMessageType(value.t)) return { t: 'rn', message: value };
  if (isShotMessageType(value.t)) {
    const message = parseShotFromHost(value);
    return message ? { t: 'shot', message } : null;
  }
  if (isRunMessageType(value.t)) {
    const message = parseRunFromHost(value);
    return message ? { t: 'run', message } : null;
  }
  switch (value.t) {
    case 'hello': {
      // A hub that cannot serve (another browser owns the socket, socket path too long…) says hello with an
      // `error` and exits (mcp/src/hub.ts): show that instead of "connected" then "exited".
      if (value.error !== undefined && value.error !== null) {
        const error = cleanString(value.error, 2000);
        return { t: 'host-error', error: error || 'The kineReqLens bridge could not start' };
      }
      if (typeof value.v !== 'number') return null;
      const hello: ParsedHostMessage = { t: 'hello', v: value.v, hostVersion: cleanString(value.hostVersion, 64) ?? '' };
      if (Array.isArray(value.features)) {
        hello.features = value.features.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 32).slice(0, 32);
      }
      return hello;
    }
    case 'sessions': {
      if (!Array.isArray(value.sessions)) return null;
      const sessions: ClaudeSessionInfo[] = [];
      const seen = new Set<string>();
      for (const item of value.sessions.slice(0, MAX_SESSIONS)) {
        const session = parseSession(item);
        if (session && !seen.has(session.id)) {
          seen.add(session.id);
          sessions.push(session);
        }
      }
      return { t: 'sessions', sessions };
    }
    case 'req': {
      const id = cleanString(value.id, MAX_ID);
      if (!id) return null;
      const sessionId = cleanString(value.sessionId, MAX_ID) ?? '';
      const method = cleanString(value.method, 64) ?? '';
      return { t: 'req', req: { id, sessionId, method, params: value.params } };
    }
    case 'res':
    case 'error': {
      // The extension never sends requests to the hub, so an error 'res' is about the hub itself.
      if (value.ok === true) return null;
      const error = cleanString(value.error, 2000);
      return error ? { t: 'host-error', error } : null;
    }
    default:
      return null;
  }
}

/** Port-like surface used by the controller (chrome.runtime.Port in production, a fake in tests). */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NativeDeps {
  extensionId: string;
  /** chrome.runtime.connectNative (throws when unavailable). */
  connect(name: string): NativePort;
  /** chrome.runtime.lastError message, read inside onDisconnect. */
  lastError(): string | undefined;
  /** Extension identity sent in hello. */
  hello(): { extensionVersion: string; browser: string };
  /** Answer a relayed call (never rejects). */
  onRequest(req: HostRequest): Promise<Extract<ExtensionToHost, { t: 'res' }>>;
  /** Host state or sessions changed. */
  onChange(): void;
  /** A terminal event from the hub. */
  onPty?(message: PtyFromHost): void;
  /** A folder browser answer from the hub. */
  onFs?(message: FsFromHost): void;
  /** An Errors view run / op message from the hub. */
  onRun?(message: RunFromHost | OpFromHost): void;
  /** The native port went away (disconnect, timeout or turned off): every terminal of that hub is gone. */
  onPortClosed?(): void;
  /** The hub said hello (connected). */
  onConnected?(): void;
  /** A React Native receiver message (`rn-*`, unvalidated). */
  onRn?(message: Record<string, unknown>): void;
  /** A "Send to Claude" screenshot answer from the hub. */
  onShot?(message: ShotFromHost): void;
  timers?: Timers;
}

export interface NativeState {
  host: BridgeHostState;
  hostVersion?: string;
  error?: string;
  sessions: ClaudeSessionInfo[];
}

export interface PushResult {
  ok: boolean;
  delivered: number;
  error?: string;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Owns the native port: connect / hello / sessions / requests / reconnect. */
export class NativeHostLink {
  private port: NativePort | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  private helloTimer: unknown = null;
  /** Error the hub reported on the current port (kept over the generic "exited" on disconnect). */
  private hostError: string | null = null;
  /** Features the connected hub announced in its hello. */
  private features: readonly string[] = [];
  private current: NativeState = { host: 'off', sessions: [] };
  private readonly timers: Timers;

  constructor(private readonly deps: NativeDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  get state(): NativeState {
    return this.current;
  }

  get connected(): boolean {
    return this.current.host === 'connected';
  }

  /** Desired state: connect (now, or on the pending retry) when true, disconnect when false. */
  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) {
      if (wanted && !this.port && this.retryTimer === null) this.connect();
      return;
    }
    this.wanted = wanted;
    if (wanted) {
      this.attempt = 0;
      this.connect();
      return;
    }
    this.clearTimers();
    const port = this.port;
    this.port = null;
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      this.deps.onPortClosed?.();
    }
    this.attempt = 0;
    this.set({ host: 'off', sessions: [] });
  }

  /** Skip the backoff wait (someone is looking at the status right now). */
  retryNow(): void {
    if (!this.wanted || this.port || this.retryTimer === null) return;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  /** Deliver an inbox item to one session (`item.sessionId`) or every session. */
  push(item: InboxItem): PushResult {
    if (!this.port || !this.connected) {
      return { ok: false, delivered: 0, error: 'Claude Code is not connected — check Settings → Claude Code' };
    }
    const sessions = this.current.sessions;
    const target = item.sessionId ?? null;
    if (target !== null && !sessions.some((s) => s.id === target)) {
      return { ok: false, delivered: 0, error: 'That Claude Code session is no longer connected' };
    }
    const delivered = target !== null ? 1 : sessions.length;
    if (delivered === 0) return { ok: false, delivered: 0, error: 'No Claude Code session is connected — start `claude` in your project' };
    if (!this.post({ t: 'push', item })) return { ok: false, delivered: 0, error: 'Claude Code bridge disconnected' };
    return { ok: true, delivered };
  }

  /** Send a React Native receiver control message to the hub. False when not connected. */
  sendRn(message: RnExtensionToHost): boolean {
    if (!this.port || !this.connected) return false;
    return this.post(message);
  }

  /** The connected hub serves the folder browser (`fs-*`). */
  get supportsFs(): boolean {
    return this.connected && this.features.includes(HUB_FEATURE_FS);
  }

  /** Send a folder browser request to the hub. False when not connected (or the post failed). */
  sendFs(message: FsToHost): boolean {
    if (!this.port || !this.connected) return false;
    return this.post(message);
  }

  /** The connected hub runs Claude analyses / git ops (`run-*`, `op-*`). */
  get supportsRuns(): boolean {
    return this.connected && this.features.includes(HUB_FEATURE_RUNS);
  }

  /** Send an Errors view message to the hub. False when not connected (or the post failed). */
  sendRun(message: RunToHost | OpToHost | ErrorsConfigToHost): boolean {
    if (!this.port || !this.connected) return false;
    return this.post(message);
  }

  /** The connected hub saves "Send to Claude" screenshots (`shot-save`). */
  get supportsShots(): boolean {
    return this.connected && this.features.includes(HUB_FEATURE_SHOTS);
  }

  /** Send a screenshot chunk to the hub. False when not connected (or the post failed). */
  sendShot(message: ShotToHost): boolean {
    if (!this.port || !this.connected) return false;
    return this.post(message);
  }

  /** Send a terminal control message to the hub. False when not connected (or the post failed). */
  sendPty(message: PtyToHost): boolean {
    if (!this.port || !this.connected) return false;
    return this.post(message);
  }

  private connect(): void {
    if (!this.wanted || this.port) return;
    this.retryTimer = null;
    this.hostError = null;
    this.features = [];
    let port: NativePort;
    try {
      port = this.deps.connect(NATIVE_HOST_NAME);
    } catch (err) {
      this.failed({ host: 'error', error: `Could not start the kineReqLens bridge: ${errorMessage(err)}` });
      return;
    }
    this.port = port;
    this.set({ host: 'connecting', sessions: [] });
    port.onMessage.addListener((message) => {
      if (this.port === port) this.onMessage(port, message);
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError here also marks it as checked.
      const lastError = this.deps.lastError();
      if (this.port !== port) return;
      this.port = null;
      this.clearHelloTimer();
      this.deps.onPortClosed?.();
      const reason = classifyDisconnect(lastError, this.deps.extensionId);
      this.failed(this.hostError ? { host: 'error', error: this.hostError } : reason);
    });
    const hello = this.deps.hello();
    this.post({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, extensionId: this.deps.extensionId, ...hello });
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = null;
      if (this.port !== port || this.connected) return;
      this.hostError = 'The kineReqLens bridge did not answer';
      this.drop(port);
    }, HELLO_TIMEOUT_MS);
  }

  private onMessage(port: NativePort, raw: unknown): void {
    const message = parseHostMessage(raw);
    if (!message) return;
    switch (message.t) {
      case 'hello':
        this.clearHelloTimer();
        this.attempt = 0;
        this.features = message.features ?? [];
        this.set({ host: 'connected', hostVersion: message.hostVersion, sessions: this.current.sessions });
        this.deps.onConnected?.();
        return;
      case 'sessions':
        this.set({ ...this.current, sessions: message.sessions });
        return;
      case 'host-error':
        this.hostError = message.error;
        this.set({ host: 'error', error: message.error, sessions: [] });
        return;
      case 'req':
        void this.deps.onRequest(message.req).then((res) => {
          if (this.port === port) this.post(res);
        });
        return;
      case 'pty':
        this.deps.onPty?.(message.message);
        return;
      case 'fs':
        this.deps.onFs?.(message.message);
        return;
      case 'run':
        this.deps.onRun?.(message.message);
        return;
      case 'rn':
        this.deps.onRn?.(message.message);
        return;
      case 'shot':
        this.deps.onShot?.(message.message);
        return;
    }
  }

  /** Close a port we gave up on and treat it as a failure. */
  private drop(port: NativePort): void {
    this.port = null;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    this.deps.onPortClosed?.();
    this.failed({ host: 'error', error: this.hostError ?? 'The kineReqLens bridge disconnected' });
  }

  private failed(reason: DisconnectReason): void {
    this.set({ host: reason.host, error: reason.error, sessions: [] });
    if (!this.wanted) return;
    const wait = reconnectDelayMs(this.attempt);
    this.attempt++;
    this.retryTimer = this.timers.setTimeout(() => this.connect(), wait);
  }

  private post(message: ExtensionToHost): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch (err) {
      console.debug('[kineReqLens] native postMessage failed', err);
      return false;
    }
  }

  private set(next: NativeState): void {
    const prev = this.current;
    this.current = next;
    if (
      prev.host !== next.host ||
      prev.error !== next.error ||
      prev.hostVersion !== next.hostVersion ||
      JSON.stringify(prev.sessions) !== JSON.stringify(next.sessions)
    ) {
      this.deps.onChange();
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private clearTimers(): void {
    this.clearHelloTimer();
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
