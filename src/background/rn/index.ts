// React Native support in the service worker (docs/ARCHITECTURE.md §9): tells the hub to start / stop its
// receiver (rn-config from settings.rnEnabled / rnListenLan / rnPort), keeps the connected app sessions and a
// bounded buffer of their captures, streams them to the standalone tab(s) (Port 'reqlens-standalone'),
// routes replays (App mode → hub → app, Extension mode → the worker's ReplayRunner), opens / focuses the
// standalone tab when an app asks (rn-open-ui), and serves the status to Settings (Port 'reqlens-rn').
//
// Pure apart from the injected deps (chrome.tabs / windows, the native link): unit-tested in
// tests/unit/bg-rn.test.ts.
import { capBody } from '../../lib/capture';
import { errorReplayResult, sanitizeReplayResult } from '../../content/validate';
import {
  RN_STANDALONE_PAGE,
  RN_STANDALONE_PORT,
  RN_STATUS_PORT,
  isRnSession,
  sanitizeRnPort,
  type RnCaptureMessage,
  type RnExtensionToHost,
  type RnHostToExtension,
  type RnReceiverStatus,
  type RnSessionInfo,
  type RnStatus,
  type WorkerToStandalone,
} from '../../shared/rn-protocol';
import type { BridgeHostState } from '../../shared/claude-protocol';
import type { ReplayRequest, ReplayResult, Settings } from '../../shared/types';
import { validateReplayRequest } from '../replay-validate';
import { isRecord } from '../util';
import { ChunkAssembler, parseRnHostMessage } from './messages';

/** Captures kept per app session for a standalone tab opened later (oldest dropped first). */
export const RN_BUFFER_MAX_MSGS = 10_000;
/** Approximate payload chars kept over all sessions. */
export const RN_BUFFER_MAX_CHARS = 96 * 1024 * 1024;
/** Sessions remembered (disconnected ones are forgotten first). */
export const RN_MAX_SESSIONS = 16;
/** A page-mode (App) replay answers within its timeout plus this. */
export const RN_REPLAY_GRACE_MS = 5000;

/** Port-like surface (chrome.runtime.Port in production). */
export interface RnPort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface RnTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RnBridgeDeps {
  extensionId: string;
  settings(): Settings;
  /** nativeMessaging granted. */
  permission(): boolean;
  /** Native host link state (shared with the Claude Code bridge). */
  host(): { host: BridgeHostState; error?: string };
  /** Post to the hub; false when not connected. */
  post(message: RnExtensionToHost): boolean;
  /** Extension-mode replays (the worker's ReplayRunner). */
  replays: {
    run(tabId: number, req: ReplayRequest, invalidHeaders: string[]): Promise<ReplayResult>;
    abort(tabId: number, runId: string, frameId: number, mode: ReplayRequest['mode']): Promise<boolean>;
  };
  /** Open the standalone page (url relative to the extension root). */
  openTab(path: string): Promise<void>;
  /** Bring a tab to the front. */
  focusTab(tabId: number): Promise<void>;
  now?(): number;
  timers?: RnTimers;
}

interface Buffer {
  msgs: RnCaptureMessage[];
  chars: number[];
  total: number;
}

interface PendingReplay {
  session: string;
  req: ReplayRequest;
  start: number;
  timer: unknown;
  resolve(result: ReplayResult): void;
}

interface StandaloneLink {
  port: RnPort;
  tabId: number;
}

const defaultTimers: RnTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Approximate size of a capture (body / payload characters dominate). */
export function captureChars(msg: RnCaptureMessage): number {
  let n = 256;
  const data = (msg as { data?: unknown }).data;
  if (isRecord(data)) {
    const body = data.body;
    if (isRecord(body)) n += (typeof body.text === 'string' ? body.text.length : 0) + (typeof body.base64 === 'string' ? body.base64.length : 0);
    if (typeof data.text === 'string') n += data.text.length;
    if (typeof data.base64 === 'string') n += data.base64.length;
    if (typeof data.url === 'string') n += data.url.length;
  }
  return n;
}

/** URL of an extension page of ours (`page`, any hash / query). */
export function isOwnPage(url: string | undefined, extensionId: string, page: string): boolean {
  if (typeof url !== 'string') return false;
  return url.split('#')[0]!.split('?')[0] === `chrome-extension://${extensionId}/${page}`;
}

export class RnBridge {
  private receiver: RnReceiverStatus | null = null;
  private readonly sessions = new Map<string, RnSessionInfo>();
  private readonly buffers = new Map<string, Buffer>();
  private bufferedChars = 0;
  private readonly standalone = new Set<StandaloneLink>();
  private readonly statusPorts = new Set<RnPort>();
  private readonly pending = new Map<string, PendingReplay>();
  private readonly chunks = new ChunkAssembler();
  private lastConfig = '';
  private lastStatus = '';
  private readonly timers: RnTimers;
  private readonly now: () => number;

  constructor(private readonly deps: RnBridgeDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? Date.now;
  }

  /** The native host should run for React Native. */
  wanted(): boolean {
    return this.deps.settings().rnEnabled === true;
  }

  status(): RnStatus {
    const enabled = this.wanted();
    const native = this.deps.host();
    const host = enabled && this.deps.permission() ? native.host : 'off';
    const status: RnStatus = {
      enabled,
      permission: this.deps.permission(),
      host,
      receiver: host === 'connected' ? this.receiver : null,
      sessions: [...this.sessions.values()].sort((a, b) => a.connectedAt - b.connectedAt),
      extensionId: this.deps.extensionId,
    };
    if (native.error && (host === 'error' || host === 'not-installed')) status.hostError = native.error;
    return status;
  }

  // ---------------------------------------------------------------------------------------------- hub

  /** The native host said hello: configure its receiver. */
  onConnected(): void {
    this.lastConfig = '';
    this.sendConfig();
    this.statusChanged();
  }

  /** Settings or permission changed. */
  onSettings(): void {
    this.sendConfig();
    this.statusChanged();
  }

  /** The native port closed: the receiver and every app connection are gone. */
  onPortClosed(): void {
    this.lastConfig = '';
    this.receiver = null;
    this.chunks.clear();
    for (const [id, info] of this.sessions) if (info.connected) this.sessions.set(id, { ...info, connected: false });
    for (const pending of [...this.pending.values()]) this.settle(pending, errorReplayResult(pending.req, 'kineReqLens lost the connection to the bridge', pending.start, this.now()));
    this.statusChanged();
  }

  /** Host state changed (connecting / connected / error). */
  onHostState(): void {
    this.statusChanged();
  }

  /** A raw rn-* message of the hub. */
  onHostMessage(raw: unknown): void {
    const message = parseRnHostMessage(raw);
    if (!message) return;
    if (message.t === 'rn-chunk') {
      const whole = this.chunks.push(message);
      if (whole !== null && whole !== undefined) {
        const inner = parseRnHostMessage(whole);
        if (inner && inner.t !== 'rn-chunk') this.handle(inner);
      }
      return;
    }
    this.handle(message);
  }

  private handle(message: Exclude<RnHostToExtension, { t: 'rn-chunk' }>): void {
    switch (message.t) {
      case 'rn-status':
        this.receiver = message.status;
        this.statusChanged();
        return;
      case 'rn-session': {
        const { t: _t, ...info } = message;
        this.sessions.delete(info.session);
        this.sessions.set(info.session, info);
        this.pruneSessions();
        if (!info.connected) {
          for (const pending of [...this.pending.values()]) {
            if (pending.session === info.session) this.settle(pending, errorReplayResult(pending.req, 'The app disconnected before answering', pending.start, this.now()));
          }
        }
        this.statusChanged();
        return;
      }
      case 'rn-capture':
        this.onCaptures(message.session, message.msgs);
        return;
      case 'rn-open-ui':
        void this.openUi(message.session);
        return;
    }
  }

  private sendConfig(): void {
    const settings = this.deps.settings();
    const config = { t: 'rn-config' as const, enabled: settings.rnEnabled === true, lan: settings.rnListenLan === true, port: sanitizeRnPort(settings.rnPort) };
    const key = JSON.stringify(config);
    if (key === this.lastConfig) return;
    if (this.deps.post(config)) this.lastConfig = key;
  }

  // ---------------------------------------------------------------------------------------------- captures

  private onCaptures(session: string, msgs: RnCaptureMessage[]): void {
    const captures: RnCaptureMessage[] = [];
    for (const msg of msgs) {
      if (msg.t === 'replay-result') {
        this.onReplayResult(session, (msg as { data?: unknown }).data);
        continue;
      }
      captures.push(msg);
    }
    if (captures.length === 0) return;
    if (!this.sessions.has(session)) {
      // Captures of a session the worker did not hear about (worker restarted while the hub kept running).
      this.sessions.set(session, {
        session,
        app: { name: '', bundleId: '', platform: 'ios', rnVersion: '', hermes: false, deviceName: '' },
        lib: { name: '', version: '' },
        capabilities: [],
        connected: true,
        connectedAt: this.now(),
        address: '',
      });
      this.pruneSessions();
      this.statusChanged();
    }
    this.buffer(session, captures);
    const message: WorkerToStandalone = { t: 'captures', session, msgs: captures };
    for (const link of this.standalone) post(link.port, message);
  }

  private buffer(session: string, msgs: RnCaptureMessage[]): void {
    let buffer = this.buffers.get(session);
    if (!buffer) {
      buffer = { msgs: [], chars: [], total: 0 };
      this.buffers.set(session, buffer);
    }
    for (const msg of msgs) {
      const chars = captureChars(msg);
      buffer.msgs.push(msg);
      buffer.chars.push(chars);
      buffer.total += chars;
      this.bufferedChars += chars;
    }
    if (buffer.msgs.length > RN_BUFFER_MAX_MSGS) this.dropOldest(buffer, buffer.msgs.length - RN_BUFFER_MAX_MSGS);
    while (this.bufferedChars > RN_BUFFER_MAX_CHARS) {
      let largest: Buffer | null = null;
      for (const b of this.buffers.values()) if (!largest || b.total > largest.total) largest = b;
      if (!largest || largest.msgs.length === 0) break;
      this.dropOldest(largest, Math.max(1, Math.ceil(largest.msgs.length / 10)));
    }
  }

  private dropOldest(buffer: Buffer, count: number): void {
    const gone = buffer.chars.splice(0, count);
    buffer.msgs.splice(0, count);
    const chars = gone.reduce((a, b) => a + b, 0);
    buffer.total -= chars;
    this.bufferedChars -= chars;
  }

  private forgetBuffer(session: string): void {
    const buffer = this.buffers.get(session);
    if (!buffer) return;
    this.bufferedChars -= buffer.total;
    this.buffers.delete(session);
  }

  private pruneSessions(): void {
    while (this.sessions.size > RN_MAX_SESSIONS) {
      let victim: string | null = null;
      for (const [id, info] of this.sessions) {
        if (!info.connected) {
          victim = id;
          break;
        }
      }
      victim ??= this.sessions.keys().next().value ?? null;
      if (victim === null) break;
      this.sessions.delete(victim);
      this.forgetBuffer(victim);
    }
  }

  // ---------------------------------------------------------------------------------------------- replays

  private onReplayResult(session: string, data: unknown): void {
    if (!isRecord(data) || typeof data.runId !== 'string') return;
    const pending = this.pending.get(data.runId);
    if (!pending || pending.session !== session) return;
    const cap = pending.req.responseBodyCap;
    this.settle(pending, sanitizeReplayResult(data, pending.req, pending.start, this.now(), (body) => capBody(body, cap)));
  }

  private settle(pending: PendingReplay, result: ReplayResult): void {
    if (this.pending.get(pending.req.runId) !== pending) return;
    this.pending.delete(pending.req.runId);
    this.timers.clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** Run a replay for the standalone tab `tabId`: 'page' = inside the app, 'extension' = the worker's fetch. */
  replay(tabId: number, session: unknown, raw: unknown): Promise<ReplayResult> {
    const runId = isRecord(raw) && typeof raw.runId === 'string' ? raw.runId.slice(0, 200) : '';
    const url = isRecord(raw) && typeof raw.url === 'string' ? raw.url.slice(0, 2048) : '';
    const start = this.now();
    const validation = validateReplayRequest(raw);
    if (!validation.ok) return Promise.resolve(errorReplayResult({ runId, url }, validation.error, start, start));
    const req = validation.req;
    if (req.mode === 'extension') return this.deps.replays.run(tabId, req, validation.invalidHeaders);
    if (!isRnSession(session)) return Promise.resolve(errorReplayResult(req, 'No app selected', start, start));
    if (!this.sessions.get(session)?.connected) {
      return Promise.resolve(
        errorReplayResult(req, 'The app is not connected to kineReqLens', start, start, {
          errorHint: 'Open the app (with startKineReqLens) on the device, or use Extension mode.',
        }),
      );
    }
    if (this.pending.has(req.runId)) return Promise.resolve(errorReplayResult(req, 'A run with this id is already in progress', start, start));
    return new Promise<ReplayResult>((resolve) => {
      const pending: PendingReplay = { session, req, start, resolve, timer: null };
      pending.timer = this.timers.setTimeout(
        () => this.settle(pending, errorReplayResult(req, `No answer from the app within ${Math.round((req.timeoutMs + RN_REPLAY_GRACE_MS) / 1000)} s`, start, this.now(), { timedOut: true })),
        req.timeoutMs + RN_REPLAY_GRACE_MS,
      );
      this.pending.set(req.runId, pending);
      const sent = this.deps.post({
        t: 'rn-replay',
        session,
        data: {
          runId: req.runId,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: req.body,
          credentials: req.credentials,
          redirect: req.redirect,
          timeoutMs: req.timeoutMs,
          responseBodyCap: req.responseBodyCap,
        },
      });
      if (!sent) this.settle(pending, errorReplayResult(req, 'The kineReqLens bridge is not connected', start, this.now()));
    });
  }

  async abort(tabId: number, session: unknown, runId: unknown, mode: unknown): Promise<boolean> {
    if (typeof runId !== 'string' || !runId) return false;
    if (mode === 'extension') return this.deps.replays.abort(tabId, runId, 0, 'extension');
    const pending = this.pending.get(runId);
    if (!pending || pending.session !== session) return false;
    return this.deps.post({ t: 'rn-abort', session: pending.session, runId });
  }

  // ---------------------------------------------------------------------------------------------- pages

  /** chrome.runtime.onConnect: true when the port is one of ours (accepted or refused). */
  accept(port: RnPort): boolean {
    if (port.name !== RN_STANDALONE_PORT && port.name !== RN_STATUS_PORT) return false;
    const sender = port.sender;
    const fromStandalone = isOwnPage(sender?.url, this.deps.extensionId, RN_STANDALONE_PAGE);
    const fromPanel = isOwnPage(sender?.url, this.deps.extensionId, 'panel.html');
    const tabId = sender?.tab?.id;
    const ok = sender?.id === this.deps.extensionId && (port.name === RN_STANDALONE_PORT ? fromStandalone && typeof tabId === 'number' : fromStandalone || fromPanel);
    if (!ok) {
      try {
        port.disconnect();
      } catch {
        /* gone */
      }
      return true;
    }
    if (port.name === RN_STATUS_PORT) this.acceptStatus(port);
    else this.acceptStandalone(port, tabId as number);
    return true;
  }

  private acceptStatus(port: RnPort): void {
    this.statusPorts.add(port);
    post(port, { t: 'status', status: this.status() });
    port.onDisconnect.addListener(() => this.statusPorts.delete(port));
    port.onMessage.addListener((raw) => {
      if (!isRecord(raw)) return;
      if (raw.t === 'regenerate-token') this.deps.post({ t: 'rn-token', regenerate: true });
      else if (raw.t === 'open-ui') void this.openUi(isRnSession(raw.session) ? raw.session : null);
    });
  }

  private acceptStandalone(port: RnPort, tabId: number): void {
    const link: StandaloneLink = { port, tabId };
    this.standalone.add(link);
    port.onDisconnect.addListener(() => this.standalone.delete(link));
    post(port, { t: 'status', status: this.status() });
    for (const [session, buffer] of this.buffers) post(port, { t: 'captures', session, msgs: buffer.msgs.slice(), reset: true });
    port.onMessage.addListener((raw) => {
      if (!isRecord(raw)) return;
      if (raw.t === 'clear' && isRnSession(raw.session)) {
        const buffer = this.buffers.get(raw.session);
        if (buffer) this.dropOldest(buffer, buffer.msgs.length);
        return;
      }
      if (raw.t !== 'call' || typeof raw.id !== 'number') return;
      const id = raw.id;
      const args = Array.isArray(raw.args) ? raw.args : [];
      const reply = (value: unknown): void => post(port, { t: 'result', id, ok: true, value });
      if (raw.method === 'replay') void this.replay(tabId, args[0], args[1]).then(reply);
      else if (raw.method === 'abort') void this.abort(tabId, args[0], args[1], args[2]).then(reply);
      else post(port, { t: 'result', id, ok: false, error: 'Unknown call' });
    });
  }

  /** Open the standalone tab (or bring an open one to the front) showing `session`. */
  async openUi(session: string | null): Promise<void> {
    const target = session ?? this.latestConnected();
    const links = [...this.standalone];
    const link = links[links.length - 1];
    if (link) {
      if (target) post(link.port, { t: 'select', session: target });
      await this.deps.focusTab(link.tabId).catch(() => undefined);
      return;
    }
    await this.deps.openTab(target ? `${RN_STANDALONE_PAGE}#session=${encodeURIComponent(target)}` : RN_STANDALONE_PAGE).catch(() => undefined);
  }

  private latestConnected(): string | null {
    let best: RnSessionInfo | null = null;
    for (const info of this.sessions.values()) if (info.connected && (!best || info.connectedAt > best.connectedAt)) best = info;
    return best?.session ?? null;
  }

  private statusChanged(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    const message = { t: 'status', status } as const;
    for (const port of this.statusPorts) post(port, message);
    for (const link of this.standalone) post(link.port, message);
  }
}

function post(port: RnPort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    /* disconnected */
  }
}
