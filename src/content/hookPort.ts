/**
 * Content-script side of the private channel to the MAIN-world hook (docs/ARCHITECTURE.md §2.1, §2.3).
 *
 * Handshake: we post `{__reqlens__:'connect'}` with a fresh MessageChannel port on start and whenever the
 * hook announces itself with 'hello' (until it has acknowledged one of our ports). The hook adopts the latest
 * port and acknowledges with an internal `{t:'ready'}` message. Older ports stay open (and listened to) so
 * messages already in flight on them are not lost.
 *
 * Everything received here is untrusted page data: captures are handed to `onCapture` for validation, and
 * replay results only resolve replays this instance started.
 */
import { HANDSHAKE_KEY, PROTOCOL_VERSION } from '../shared/messages';
import type { ContentToHook, HookToContent } from '../shared/messages';
import type { HookConfig, ReplayRequest, ReplayResult, SerializedBody } from '../shared/types';
import { errorReplayResult, isRecord, sanitizeReplayResult } from './validate';
import type { ComponentLocateResult, ComponentQuery } from '../shared/initiator-protocol';
import { COMPONENT_LOCATE_TIMEOUT_MS, sanitizeComponentLocateResult } from '../shared/initiator-protocol';

/** Replay error when the MAIN-world hook never connected in this frame. */
export const PAGE_HOOK_UNAVAILABLE = 'Page hook unavailable on this page — use Extension mode';

/** Extra time on top of the request timeout before a page replay is given up locally. */
const REPLAY_SAFETY_MS = 5_000;
/** After asking the hook to abort, resolve locally if it does not answer within this time. */
const ABORT_FALLBACK_MS = 2_000;
/** Ports kept open at most (handshake retries are rare; this only bounds forged 'hello' floods). */
const MAX_PORTS = 4;
/** A ws-send the hook does not answer resolves with an error after this. */
const WS_SEND_TIMEOUT_MS = 3_000;

/** Dependencies of HookPort. */
export interface HookPortOptions {
  win: Window;
  /** 'start' / 'end' message from the hook (unvalidated). */
  onCapture(message: HookToContent): void;
  /** The hook acknowledged a port. */
  onConnected(): void;
  /** `{t:'ws'}` batch of WebSocket events from the hook (unvalidated). */
  onWs?(events: unknown): void;
  now(): number;
  /** Bounds replay result bodies. */
  capReplayBody(body: SerializedBody | null, req: ReplayRequest): SerializedBody | null;
}

interface PendingReplay {
  req: ReplayRequest;
  start: number;
  port: MessagePort;
  resolve(result: ReplayResult): void;
  timers: number[];
}

type HookMode = Extract<ContentToHook, { t: 'mode' }>;
type HookLanguage = Extract<ContentToHook, { t: 'lang' }>;

/** Handshake, mode pushes and page-mode replays over the private MessagePort to hook.js. */
export class HookPort {
  private readonly ports: MessagePort[] = [];
  private current: MessagePort | null = null;
  private isConnected = false;
  private lastMode: HookMode | null = null;
  /** Last "Site language" push (null: none sent yet, i.e. the hook was never told about an override). */
  private lastLanguages: HookLanguage | null = null;
  private readonly pending = new Map<string, PendingReplay>();
  private readonly wsSends = new Map<number, (result: { ok: boolean; error?: string }) => void>();
  private nextWsSend = 1;
  private readonly componentQueries = new Map<number, (value: unknown) => void>();
  private nextComponentQuery = 1;
  private disposed = false;

  constructor(private readonly options: HookPortOptions) {}

  get connected(): boolean {
    return this.isConnected;
  }

  start(): void {
    this.options.win.addEventListener('message', this.onWindowMessage, true);
    this.connect();
  }

  /** Remember the mode and push it to the hook (now, and again whenever the hook (re)connects). */
  setMode(mode: 'on' | 'off', config: HookConfig): void {
    const next: HookMode = { t: 'mode', mode, config: { ...config } };
    const last = this.lastMode;
    if (
      last &&
      last.mode === next.mode &&
      last.config.captureResponseBodies === next.config.captureResponseBodies &&
      last.config.requestBodyCap === next.config.requestBodyCap &&
      last.config.responseBodyCap === next.config.responseBodyCap
    ) {
      return;
    }
    this.lastMode = next;
    this.post(next);
  }

  /**
   * "Site language": the languages the page should see (canonical tags, preferred first), null = the browser's.
   * Remembered and pushed again whenever the hook (re)connects. Nothing is sent until a first override exists, so
   * pages of tabs without one never get a message.
   */
  setLanguages(languages: string[] | null): void {
    const last = this.lastLanguages?.languages ?? null;
    if (last === null && languages === null) return;
    if (last && languages && last.length === languages.length && last.every((tag, i) => tag === languages[i])) return;
    this.lastLanguages = { t: 'lang', languages: languages ? languages.slice() : null };
    this.post(this.lastLanguages);
  }

  /** Run a page-mode replay in this frame's hook. Never rejects. */
  replay(req: ReplayRequest): Promise<ReplayResult> {
    const start = this.options.now();
    const port = this.current;
    if (this.disposed || !port || !this.isConnected) {
      return Promise.resolve(errorReplayResult(req, PAGE_HOOK_UNAVAILABLE, start, start));
    }
    if (this.pending.has(req.runId)) {
      return Promise.resolve(errorReplayResult(req, 'Duplicate run id', start, start));
    }
    return new Promise<ReplayResult>((resolve) => {
      const entry: PendingReplay = { req, start, port, resolve, timers: [] };
      this.pending.set(req.runId, entry);
      entry.timers.push(
        window.setTimeout(() => {
          this.settle(
            req.runId,
            errorReplayResult(req, `No response from the page within ${req.timeoutMs} ms`, start, this.options.now(), {
              timedOut: true,
            }),
          );
        }, req.timeoutMs + REPLAY_SAFETY_MS),
      );
      if (!this.postTo(port, { t: 'replay', data: req })) {
        this.settle(req.runId, errorReplayResult(req, PAGE_HOOK_UNAVAILABLE, start, this.options.now()));
      }
    });
  }

  /** Ask the hook to abort a replay started here. Returns false when the run is not ours. */
  abort(runId: string): boolean {
    const entry = this.pending.get(runId);
    if (!entry) return false;
    this.postTo(entry.port, { t: 'abort', runId });
    entry.timers.push(
      window.setTimeout(() => {
        this.settle(
          runId,
          errorReplayResult(entry.req, 'Request cancelled', entry.start, this.options.now(), { aborted: true }),
        );
      }, ABORT_FALLBACK_MS),
    );
    return true;
  }

  /** Send a text message through the page socket `wsId` (hook id) of this frame. Never rejects. */
  wsSend(wsId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const port = this.current;
    if (this.disposed || !port || !this.isConnected) return Promise.resolve({ ok: false, error: PAGE_HOOK_UNAVAILABLE });
    const reqId = this.nextWsSend++;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.wsSends.delete(reqId);
        resolve({ ok: false, error: 'No answer from the page' });
      }, WS_SEND_TIMEOUT_MS);
      this.wsSends.set(reqId, (result) => {
        window.clearTimeout(timer);
        this.wsSends.delete(reqId);
        resolve(result);
      });
      if (!this.postTo(port, { t: 'ws-send', reqId, wsId, text })) this.wsSends.get(reqId)?.({ ok: false, error: PAGE_HOOK_UNAVAILABLE });
    });
  }

  /**
   * Find components by name in this frame's page (Initiator tab, a panel request only). The hook's answer is
   * untrusted: it is rebuilt by `sanitizeComponentLocateResult`. Never rejects.
   */
  locateComponents(query: ComponentQuery): Promise<ComponentLocateResult> {
    const fail = (error: string): ComponentLocateResult => ({
      frameworks: [],
      matches: query.names.map((name) => ({ name, count: 0, instances: [] })),
      error,
    });
    const port = this.current;
    if (this.disposed || !port || !this.isConnected) return Promise.resolve(fail(PAGE_HOOK_UNAVAILABLE));
    const reqId = this.nextComponentQuery++;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.componentQueries.delete(reqId);
        resolve(fail('No answer from the page'));
      }, COMPONENT_LOCATE_TIMEOUT_MS);
      this.componentQueries.set(reqId, (value) => {
        window.clearTimeout(timer);
        this.componentQueries.delete(reqId);
        let result: ComponentLocateResult;
        try {
          result = sanitizeComponentLocateResult(value, query);
        } catch {
          result = fail('Malformed answer from the page');
        }
        resolve(result);
      });
      if (!this.postTo(port, { t: 'components', reqId, names: query.names, scroll: query.scroll })) {
        this.componentQueries.get(reqId)?.({ error: PAGE_HOOK_UNAVAILABLE });
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const settle of [...this.componentQueries.values()]) settle({ error: 'kineReqLens was reloaded on this page' });
    for (const settle of [...this.wsSends.values()]) settle({ ok: false, error: 'kineReqLens was reloaded on this page' });
    this.options.win.removeEventListener('message', this.onWindowMessage, true);
    for (const runId of [...this.pending.keys()]) {
      const entry = this.pending.get(runId);
      if (entry) {
        this.settle(
          runId,
          errorReplayResult(entry.req, 'kineReqLens was reloaded on this page', entry.start, this.options.now()),
        );
      }
    }
    for (const port of this.ports) {
      try {
        port.onmessage = null;
        port.close();
      } catch {
        /* already closed */
      }
    }
    this.ports.length = 0;
    this.current = null;
    this.isConnected = false;
  }

  private connect(): void {
    if (this.disposed) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    port.onmessage = (event: MessageEvent) => this.onPortMessage(port, event.data);
    this.ports.push(port);
    while (this.ports.length > MAX_PORTS) {
      const oldest = this.ports.shift();
      try {
        oldest?.close();
      } catch {
        /* ignore */
      }
    }
    this.current = port;
    try {
      this.options.win.postMessage({ [HANDSHAKE_KEY]: 'connect', v: PROTOCOL_VERSION }, '*', [channel.port2]);
    } catch {
      /* window gone */
    }
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== this.options.win) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data[HANDSHAKE_KEY] !== 'hello' || data.v !== PROTOCOL_VERSION) return;
    // Private handshake: keep it away from page listeners.
    event.stopImmediatePropagation();
    if (!this.isConnected) this.connect();
  };

  private onPortMessage(port: MessagePort, data: unknown): void {
    if (this.disposed || !isRecord(data)) return;
    switch (data.t) {
      case 'ready':
        if (port !== this.current) return;
        if (!this.isConnected) {
          this.isConnected = true;
          this.options.onConnected();
        }
        if (this.lastMode) this.postTo(port, this.lastMode);
        if (this.lastLanguages) this.postTo(port, this.lastLanguages);
        return;
      case 'start':
      case 'end':
        this.options.onCapture(data as HookToContent);
        return;
      case 'replay-result':
        this.onReplayResult(data.data);
        return;
      case 'ws':
        this.options.onWs?.(data.events);
        return;
      case 'components-result': {
        const settle = typeof data.reqId === 'number' ? this.componentQueries.get(data.reqId) : undefined;
        settle?.(data.data);
        return;
      }
      case 'ws-send-result': {
        const settle = typeof data.reqId === 'number' ? this.wsSends.get(data.reqId) : undefined;
        if (settle) {
          settle(
            data.ok === true
              ? { ok: true }
              : { ok: false, error: typeof data.error === 'string' ? data.error.slice(0, 500) : 'The message was not sent' },
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private onReplayResult(value: unknown): void {
    if (!isRecord(value) || typeof value.runId !== 'string') return;
    const entry = this.pending.get(value.runId);
    if (!entry) return;
    const now = this.options.now();
    let result: ReplayResult;
    try {
      result = sanitizeReplayResult(value, entry.req, entry.start, now, (body) =>
        this.options.capReplayBody(body, entry.req),
      );
    } catch {
      result = errorReplayResult(entry.req, 'Malformed replay result', entry.start, now);
    }
    this.settle(value.runId, result);
  }

  private settle(runId: string, result: ReplayResult): void {
    const entry = this.pending.get(runId);
    if (!entry) return;
    this.pending.delete(runId);
    for (const timer of entry.timers) window.clearTimeout(timer);
    entry.resolve(result);
  }

  private post(message: ContentToHook): void {
    if (this.current) this.postTo(this.current, message);
  }

  private postTo(port: MessagePort, message: ContentToHook): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }
}
