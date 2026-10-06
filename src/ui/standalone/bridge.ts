// ReqlensBridge of the standalone React Native tab (app.html): one in-page RequestStore + WsStore per app
// session (the content script's pure stores), fed with the captures the worker streams over the
// 'reqlens-standalone' port (src/background/rn/index.ts). The UI shows the selected session ("target");
// replays go back over the port: mode 'page' runs inside the app (hub → app), 'extension' in the worker.
import { sanitizeReplayResult, errorReplayResult, isRecord } from '../../content/validate';
import { RequestStore } from '../../content/store';
import { WsStore } from '../../content/wsStore';
import { capBody } from '../../lib/capture';
import type { WsBridge, WsDelta, WsHookEvent, WsSendResult } from '../../lib/ws';
import { rnWsHookId } from '../../shared/rn-protocol';
import type { RnCaptureMessage, RnSessionInfo, RnStatus, StandaloneToWorker, WorkerToStandalone } from '../../shared/rn-protocol';
import type {
  CaptureInfo,
  ManualEntryInit,
  ReplayRequest,
  ReplayResult,
  ReqlensBridge,
  RequestEntry,
  Settings,
  SettingsPatch,
  TabState,
} from '../../shared/types';

/** What the bridge needs from the page's settings (src/content/settings.ts SettingsStore). */
export interface SettingsSource {
  get(): Settings;
  subscribe(fn: (settings: Settings) => void): () => void;
  update(patch: SettingsPatch): Promise<Settings>;
}

export interface StandaloneDeps {
  settings: SettingsSource;
  post(message: StandaloneToWorker): void;
  /** Coalescing window of store notifications. */
  schedule(flush: () => void): void;
  now?(): number;
  version: string;
}

/** One app session ("target") of the picker. */
export interface StandaloneTarget {
  session: string;
  info: RnSessionInfo | null;
  connected: boolean;
  entries: number;
  /** Captures the app had to drop while kineReqLens was unreachable. */
  dropped: number;
}

interface SessionData {
  session: string;
  store: RequestStore;
  ws: WsStore;
  dropped: number;
  unsubscribe: Array<() => void>;
  unsubscribeWs: () => void;
}

const NOT_CONNECTED = 'kineReqLens lost the connection to the extension — reload this tab';

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const fn of [...listeners]) {
    try {
      fn(value);
    } catch (err) {
      console.error('[kineReqLens] listener failed', err);
    }
  }
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/` : '';
  } catch {
    return '';
  }
}

/** The app's WebSocket messages as the inspector's hook events (frame 0, ids made [A-Za-z0-9_-]). */
export function rnWsEvents(msgs: RnCaptureMessage[]): WsHookEvent[] {
  const out: WsHookEvent[] = [];
  for (const msg of msgs) {
    switch (msg.t) {
      case 'ws-open':
        out.push({ e: 'new', id: rnWsHookId(msg.data.wsId), time: msg.data.time, url: msg.data.url, protocols: msg.data.protocols });
        break;
      case 'ws-ready':
        out.push({ e: 'open', id: rnWsHookId(msg.data.wsId), time: msg.data.time, protocol: msg.data.protocol, extensions: msg.data.extensions });
        break;
      case 'ws-frame': {
        const d = msg.data;
        const event: WsHookEvent = { e: 'frame', id: rnWsHookId(d.wsId), time: d.time, dir: d.dir, opcode: d.opcode, size: d.size, truncated: d.truncated };
        if (d.opcode === 'text') event.text = d.text ?? '';
        else event.base64 = d.base64 ?? '';
        out.push(event);
        break;
      }
      case 'ws-error':
        out.push({ e: 'error', id: rnWsHookId(msg.data.wsId), time: msg.data.time });
        break;
      case 'ws-close':
        if (msg.data.initiator === 'client') out.push({ e: 'closing', id: rnWsHookId(msg.data.wsId), time: msg.data.time, code: msg.data.code, reason: msg.data.reason });
        out.push({ e: 'close', id: rnWsHookId(msg.data.wsId), time: msg.data.time, code: msg.data.code, reason: msg.data.reason, wasClean: msg.data.wasClean });
        break;
      default:
        break;
    }
  }
  return out;
}

/** WsBridge of the selected session (identity-stable: the inspector follows it across target switches). */
class StandaloneWs implements WsBridge {
  private readonly listeners = new Set<(delta: WsDelta) => void>();

  constructor(private readonly current: () => SessionData | null) {}

  snapshot(): WsDelta {
    return this.current()?.ws.snapshot() ?? { reset: true, connections: [], frames: [], removed: [] };
  }

  subscribe(fn: (delta: WsDelta) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A delta of session `data` (forwarded when it is the selected one). */
  delta(data: SessionData, delta: WsDelta): void {
    if (this.current() === data) emit(this.listeners, delta);
  }

  /** The selection changed: replace everything. */
  reset(): void {
    emit(this.listeners, this.snapshot());
  }

  clear(): void {
    this.current()?.ws.clear();
  }

  async send(): Promise<WsSendResult> {
    return { ok: false, error: "Sending through the app's WebSockets is not supported" };
  }
}

export class StandaloneBridge implements ReqlensBridge {
  readonly version: string;
  readonly ws: StandaloneWs;
  private readonly sessions = new Map<string, SessionData>();
  private infos = new Map<string, RnSessionInfo>();
  private currentId: string | null = null;
  /** Session asked for before its first capture arrived (URL hash / worker 'select'). */
  private wanted: string | null = null;
  private tabState: TabState = { open: true, recording: true, preserveLog: false };
  private captureInfo: CaptureInfo = { lateInjection: false, hookConnected: false, pageUrl: '' };
  private status: RnStatus | null = null;
  private readonly entryListeners = new Set<() => void>();
  private readonly tabStateListeners = new Set<(state: TabState) => void>();
  private readonly captureListeners = new Set<(info: CaptureInfo) => void>();
  private readonly targetListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(status: RnStatus) => void>();
  private readonly pending = new Map<number, (value: unknown) => void>();
  private targets: StandaloneTarget[] = [];
  private nextCall = 1;
  private connected = true;
  private protectedIds: string[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: StandaloneDeps) {
    this.version = deps.version;
    this.now = deps.now ?? Date.now;
    this.ws = new StandaloneWs(() => this.current());
  }

  // ---------------------------------------------------------------------------------------------- worker

  /** A message of the worker. */
  handle(raw: unknown): void {
    if (!isRecord(raw)) return;
    const message = raw as WorkerToStandalone;
    switch (message.t) {
      case 'status':
        this.onStatus(message.status);
        return;
      case 'captures':
        if (typeof message.session === 'string' && Array.isArray(message.msgs)) this.onCaptures(message.session, message.msgs, message.reset === true);
        return;
      case 'select':
        if (typeof message.session === 'string') this.select(message.session);
        return;
      case 'result': {
        const resolve = this.pending.get(message.id);
        if (!resolve) return;
        this.pending.delete(message.id);
        resolve(message.ok ? message.value : null);
        return;
      }
    }
  }

  /** A (new) port to the worker is open. */
  reconnected(): void {
    this.connected = true;
    this.updateCaptureInfo();
  }

  /** The port closed. */
  disconnected(): void {
    this.connected = false;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.updateCaptureInfo();
  }

  private onStatus(status: RnStatus): void {
    if (!isRecord(status) || !Array.isArray(status.sessions)) return;
    this.status = status;
    this.infos = new Map(status.sessions.map((s) => [s.session, s] as const));
    // Connected apps are listed even before they send anything.
    for (const info of status.sessions) if (info.connected) this.ensure(info.session);
    if (!this.currentId) this.autoSelect();
    this.updateCaptureInfo();
    this.targetsChanged();
    emit(this.statusListeners, status);
  }

  private onCaptures(session: string, msgs: RnCaptureMessage[], reset: boolean): void {
    const fresh = !this.sessions.has(session);
    const data = this.ensure(session);
    // A re-sent buffer: HTTP entries are deduplicated by the store, WebSocket frames would not be — the
    // WebSocket log of the session is rebuilt from the buffer.
    if (reset && !fresh) this.replaceWs(data);
    const capturing = this.tabState.recording;
    for (const msg of msgs) {
      if (!isRecord(msg)) continue;
      if (msg.t === 'start') {
        if (capturing) data.store.handleHookStart(0, msg.data);
      } else if (msg.t === 'end') data.store.handleHookEnd(0, msg.data);
      else if (msg.t === 'dropped' && typeof msg.count === 'number') data.dropped += msg.count;
    }
    const events = rnWsEvents(msgs);
    if (events.length) data.ws.handle(0, events, { capturing });
    if (!this.currentId) this.autoSelect();
    else if (reset && this.currentId === session) {
      this.notifyEntries();
      this.ws.reset();
    }
    if (fresh || reset) this.targetsChanged();
  }

  private ensure(session: string): SessionData {
    let data = this.sessions.get(session);
    if (data) return data;
    const store = new RequestStore({
      now: this.now,
      pageUrl: () => this.pageUrlOf(session),
      limits: () => {
        const s = this.deps.settings.get();
        return { maxEntries: s.maxEntries, requestBodyCap: s.requestBodyCap, responseBodyCap: s.responseBodyCap };
      },
      schedule: this.deps.schedule,
      defaultManualUrl: () => {
        const entries = store.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const origin = originOf(entries[i]!.url);
          if (origin) return origin;
        }
        return 'https://';
      },
    });
    const created: SessionData = { session, store, ws: this.newWs(), dropped: 0, unsubscribe: [], unsubscribeWs: () => undefined };
    created.unsubscribeWs = created.ws.subscribe((delta) => this.ws.delta(created, delta));
    created.unsubscribe.push(
      store.subscribe(() => {
        if (this.currentId === session) this.notifyEntries();
        this.targetsChanged();
      }),
    );
    if (this.currentId === session) store.setProtected(this.protectedIds);
    this.sessions.set(session, created);
    return created;
  }

  private newWs(): WsStore {
    return new WsStore({ schedule: this.deps.schedule, send: async () => ({ ok: false, error: 'Not supported' }) });
  }

  private replaceWs(data: SessionData): void {
    data.unsubscribeWs();
    data.ws.dispose();
    data.ws = this.newWs();
    data.unsubscribeWs = data.ws.subscribe((delta) => this.ws.delta(data, delta));
  }

  private pageUrlOf(session: string): string {
    const info = this.infos.get(session);
    const name = info?.app.bundleId || info?.app.name || session;
    return `react-native://${encodeURIComponent(name)}`;
  }

  private autoSelect(): void {
    if (this.wanted && this.sessions.has(this.wanted)) {
      this.select(this.wanted);
      return;
    }
    // Most recently connected app, else the newest session with captures.
    let best: string | null = null;
    let bestAt = -1;
    for (const [id, info] of this.infos) if (info.connected && this.sessions.has(id) && info.connectedAt > bestAt) {
      best = id;
      bestAt = info.connectedAt;
    }
    if (!best) best = [...this.sessions.keys()].pop() ?? null;
    if (best) this.select(best);
  }

  // ---------------------------------------------------------------------------------------------- targets

  /** Show `session` (selects it as soon as it is known). */
  select(session: string): void {
    this.wanted = session;
    if (!this.sessions.has(session) && !this.infos.get(session)?.connected) return;
    this.ensure(session);
    if (this.currentId === session) return;
    this.currentId = session;
    this.current()?.store.setProtected(this.protectedIds);
    this.updateCaptureInfo();
    this.notifyEntries();
    this.ws.reset();
    this.targetsChanged();
  }

  get currentSession(): string | null {
    return this.currentId;
  }

  getTargets(): StandaloneTarget[] {
    return this.targets;
  }

  subscribeTargets(fn: () => void): () => void {
    this.targetListeners.add(fn);
    return () => {
      this.targetListeners.delete(fn);
    };
  }

  getStatus(): RnStatus | null {
    return this.status;
  }

  subscribeStatus(fn: (status: RnStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  private targetsChanged(): void {
    const next: StandaloneTarget[] = [...this.sessions.values()].map((data) => {
      const info = this.infos.get(data.session) ?? null;
      return { session: data.session, info, connected: info?.connected === true, entries: data.store.size, dropped: data.dropped };
    });
    const same =
      next.length === this.targets.length &&
      next.every((t, i) => {
        const p = this.targets[i]!;
        return p.session === t.session && p.info === t.info && p.connected === t.connected && p.entries === t.entries && p.dropped === t.dropped;
      });
    if (same) return;
    this.targets = next;
    for (const fn of [...this.targetListeners]) fn();
  }

  private current(): SessionData | null {
    return this.currentId ? (this.sessions.get(this.currentId) ?? null) : null;
  }

  private sessionOfEntry(entryId: string): string | null {
    if (this.current()?.store.get(entryId)) return this.currentId;
    for (const data of this.sessions.values()) if (data.store.get(entryId)) return data.session;
    return this.currentId;
  }

  private updateCaptureInfo(): void {
    const session = this.currentId;
    const next: CaptureInfo = {
      lateInjection: false,
      hookConnected: this.connected && !!session && this.infos.get(session)?.connected === true,
      pageUrl: session ? this.pageUrlOf(session) : '',
    };
    const cur = this.captureInfo;
    if (cur.hookConnected === next.hookConnected && cur.pageUrl === next.pageUrl) return;
    this.captureInfo = next;
    emit(this.captureListeners, next);
  }

  private notifyEntries(): void {
    for (const fn of [...this.entryListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[kineReqLens] entries listener failed', err);
      }
    }
  }

  private call(method: 'replay' | 'abort', args: unknown[]): Promise<unknown> {
    if (!this.connected) return Promise.resolve(null);
    const id = this.nextCall++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.deps.post({ t: 'call', id, method, args } as StandaloneToWorker);
      } catch {
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- ReqlensBridge

  getEntries(): RequestEntry[] {
    return this.current()?.store.getEntries() ?? EMPTY;
  }

  subscribeEntries(fn: () => void): () => void {
    this.entryListeners.add(fn);
    return () => {
      this.entryListeners.delete(fn);
    };
  }

  clearEntries(): void {
    const data = this.current();
    if (!data) return;
    data.store.clear();
    data.ws.clear();
    data.dropped = 0;
    try {
      this.deps.post({ t: 'clear', session: data.session });
    } catch {
      /* disconnected */
    }
    this.targetsChanged();
  }

  addManualEntry(init?: ManualEntryInit): RequestEntry {
    let data = this.current();
    if (!data) {
      // No app yet: a scratch target so composed requests still work (Extension mode).
      data = this.ensure('scratch');
      this.select('scratch');
    }
    return data.store.addManual(init);
  }

  getTabState(): TabState {
    return this.tabState;
  }

  subscribeTabState(fn: (state: TabState) => void): () => void {
    this.tabStateListeners.add(fn);
    return () => {
      this.tabStateListeners.delete(fn);
    };
  }

  async setTabState(patch: Partial<TabState>): Promise<TabState> {
    // The tab is always "open"; recording pauses the list; there is no page log to preserve.
    if (typeof patch.recording === 'boolean' && patch.recording !== this.tabState.recording) {
      this.tabState = { ...this.tabState, recording: patch.recording };
      emit(this.tabStateListeners, this.tabState);
    }
    return this.tabState;
  }

  getSettings(): Settings {
    return this.deps.settings.get();
  }

  subscribeSettings(fn: (settings: Settings) => void): () => void {
    return this.deps.settings.subscribe(fn);
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.deps.settings.update(patch);
  }

  async replay(req: ReplayRequest): Promise<ReplayResult> {
    const start = this.now();
    if (!this.connected) return errorReplayResult(req, NOT_CONNECTED, start, this.now());
    const session = this.sessionOfEntry(req.entryId);
    const value = await this.call('replay', [session, req]);
    if (!isRecord(value)) return errorReplayResult(req, NOT_CONNECTED, start, this.now());
    const cap = req.responseBodyCap;
    return sanitizeReplayResult(value, req, start, this.now(), (body) => capBody(body, cap));
  }

  abortReplay(runId: string): void {
    // The mode is not known here: ask both sides (the one that does not run it ignores it).
    const session = this.currentId;
    void this.call('abort', [session, runId, 'page']);
    void this.call('abort', [session, runId, 'extension']);
  }

  getCaptureInfo(): CaptureInfo {
    return this.captureInfo;
  }

  subscribeCaptureInfo(fn: (info: CaptureInfo) => void): () => void {
    this.captureListeners.add(fn);
    return () => {
      this.captureListeners.delete(fn);
    };
  }

  reloadPage(): void {
    // Nothing to reload: the app sends its traffic as it goes.
  }

  setProtectedEntries(ids: string[]): void {
    this.protectedIds = Array.isArray(ids) ? ids.slice() : [];
    this.current()?.store.setProtected(this.protectedIds);
  }

  dispose(): void {
    this.disconnected();
    for (const data of this.sessions.values()) {
      for (const off of data.unsubscribe) off();
      data.unsubscribeWs();
      data.store.dispose();
      data.ws.dispose();
    }
  }
}

const EMPTY: RequestEntry[] = [];
