// Panel side of the panel connection: a ReqlensBridge that mirrors the page's store (entries, tab state,
// settings, capture info) from the frame host's messages and forwards actions to it. Getters are synchronous
// and identity-stable between notifications, like the in-page bridge (src/shared/types.ts ReqlensBridge).
import { DEFAULT_SETTINGS, DEFAULT_TAB_STATE, mergeSettings } from '../../shared/constants';
import type { HostToPanel, PanelCallName, PanelToHost, PanelUiState, PanelUiStatePatch } from '../../shared/panel-protocol';
import type { ShotCallName, ShotCalls } from '../../shared/screenshot-protocol';
import type { FindCallName, FindCalls, FindToPanel } from '../../shared/find-protocol';
import type { ComponentLocateResult, ComponentQuery } from '../../shared/initiator-protocol';
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
import { uid } from '../../lib/ids';
import { buildManualEntry } from '../../content/store';
import { RemoteWs } from '../ws/store';

type Send = (message: PanelToHost) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const DISCONNECTED = 'kineReqLens lost the connection to the page — reload the page to keep using it';

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/` : url;
  } catch {
    return '';
  }
}

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const fn of [...listeners]) {
    try {
      fn(value);
    } catch (err) {
      console.error('[kineReqLens] bridge listener failed', err);
    }
  }
}

/** ReqlensBridge over the panel port. */
export class RemoteBridge implements ReqlensBridge {
  version = '';
  private readonly entries = new Map<string, RequestEntry>();
  private sorted: RequestEntry[] | null = [];
  private tabState: TabState = { ...DEFAULT_TAB_STATE };
  private settings: Settings = mergeSettings(DEFAULT_SETTINGS, null);
  private captureInfo: CaptureInfo = { lateInjection: false, hookConnected: false, pageUrl: '' };
  private uiState: PanelUiState | null = null;
  private readonly entryListeners = new Set<() => void>();
  private readonly tabStateListeners = new Set<(state: TabState) => void>();
  private readonly settingsListeners = new Set<(settings: Settings) => void>();
  private readonly captureListeners = new Set<(info: CaptureInfo) => void>();
  private readonly findListeners = new Set<(event: FindToPanel) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextCall = 1;
  private connected = true;
  private notifyScheduled = false;
  private readyResolve: (() => void) | null = null;
  /** Resolves once the initial state and entries arrived. */
  readonly ready: Promise<void>;
  /** WebSocket connections + frames of the page (mirror). */
  readonly ws: RemoteWs;

  constructor(private readonly send: Send) {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.ws = new RemoteWs((method, args) => this.call(method, args));
  }

  /** UI state the host kept from a previous panel of this page (null for the first one). */
  getUiState(): PanelUiState | null {
    return this.uiState;
  }

  /** Hand changes of the resumable UI state to the host (kept for a reloaded panel). */
  saveUiState(patch: PanelUiStatePatch): void {
    this.post({ t: 'ui-state', patch });
  }

  /** Message from the host. */
  handle(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as HostToPanel;
    switch (msg.t) {
      case 'state':
        this.version = msg.version;
        this.uiState = msg.uiState;
        this.setTabStateLocal(msg.tabState);
        this.setSettingsLocal(msg.settings);
        this.setCaptureInfoLocal(msg.captureInfo);
        return;
      case 'entries':
        this.applyEntries(msg.upsert, msg.remove);
        return;
      case 'ws':
        this.ws.receive(msg.delta);
        return;
      case 'ready':
        this.readyResolve?.();
        this.readyResolve = null;
        return;
      case 'tabState':
        this.setTabStateLocal(msg.tabState);
        return;
      case 'settings':
        this.setSettingsLocal(msg.settings);
        return;
      case 'captureInfo':
        this.setCaptureInfoLocal(msg.captureInfo);
        return;
      case 'find-results':
      case 'find-return':
        emit(this.findListeners, msg);
        return;
      case 'result': {
        const call = this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        if (msg.ok) call.resolve(msg.value);
        else call.reject(new Error(msg.error));
        return;
      }
      default:
        return;
    }
  }

  /** The port closed: pending calls fail, later calls fail right away. */
  disconnected(): void {
    this.connected = false;
    for (const call of this.pending.values()) call.reject(new Error(DISCONNECTED));
    this.pending.clear();
  }

  // ------------------------------------------------------------------------------------------ bridge

  getEntries(): RequestEntry[] {
    if (!this.sorted) {
      const list = Array.from(this.entries.values());
      list.sort((a, b) => a.startTime - b.startTime);
      this.sorted = list;
    }
    return this.sorted;
  }

  subscribeEntries(fn: () => void): () => void {
    this.entryListeners.add(fn);
    return () => {
      this.entryListeners.delete(fn);
    };
  }

  clearEntries(): void {
    void this.call('clearEntries', []).catch(() => undefined);
  }

  addManualEntry(init?: ManualEntryInit): RequestEntry {
    if (!this.connected) throw new Error(DISCONNECTED);
    const id = uid('m:');
    const full: ManualEntryInit = { ...(init ?? {}), id };
    // Shown right away (the UI selects it); the store's copy replaces it when it arrives.
    const pageUrl = this.captureInfo.pageUrl;
    const entry = buildManualEntry(full, { id, pageUrl, defaultUrl: originOf(pageUrl), now: Date.now() });
    this.applyEntries([entry], []);
    void this.call('addManualEntry', [full]).then(
      (stored) => {
        if (stored && typeof stored === 'object' && (stored as RequestEntry).id === id) this.applyEntries([stored as RequestEntry], []);
      },
      () => this.applyEntries([], [id]),
    );
    return entry;
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
    try {
      const next = (await this.call('setTabState', [patch])) as TabState;
      if (next && typeof next === 'object') this.setTabStateLocal(next);
    } catch {
      /* keep the current state */
    }
    return this.tabState;
  }

  getSettings(): Settings {
    return this.settings;
  }

  subscribeSettings(fn: (settings: Settings) => void): () => void {
    this.settingsListeners.add(fn);
    return () => {
      this.settingsListeners.delete(fn);
    };
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const next = (await this.call('updateSettings', [patch])) as Settings;
    if (next && typeof next === 'object') this.setSettingsLocal(next);
    return this.settings;
  }

  async replay(req: ReplayRequest): Promise<ReplayResult> {
    const start = Date.now();
    try {
      return (await this.call('replay', [req])) as ReplayResult;
    } catch (err) {
      return {
        runId: req.runId,
        ok: false,
        status: 0,
        statusText: '',
        headers: [],
        body: null,
        url: req.url,
        redirected: false,
        timing: { start, end: Date.now() },
        size: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  abortReplay(runId: string): void {
    void this.call('abortReplay', [runId]).catch(() => undefined);
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
    void this.call('reloadPage', []).catch(() => undefined);
  }

  setProtectedEntries(ids: string[]): void {
    void this.call('setProtectedEntries', [ids]).catch(() => undefined);
  }

  dispose(): void {
    this.disconnected();
  }

  /** Initiator tab: component lookup / highlight in the page (frame host → content script → hook). */
  async locateComponents(query: ComponentQuery): Promise<ComponentLocateResult> {
    try {
      return (await this.call('locateComponents', [query])) as ComponentLocateResult;
    } catch (err) {
      return {
        frameworks: [],
        matches: query.names.map((name) => ({ name, count: 0, instances: [] })),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Initiator tab: remove the page highlight. */
  clearHighlight(): void {
    void this.call('clearHighlight', []).catch(() => undefined);
  }

  /** Screenshot tool: drive the page side of a capture (src/shared/screenshot-protocol.ts). */
  /** Find in page: drive the page-side scanner (src/shared/find-protocol.ts). */
  find<M extends FindCallName>(method: M, ...args: Parameters<FindCalls[M]>): Promise<ReturnType<FindCalls[M]>> {
    return this.call(method, args) as Promise<ReturnType<FindCalls[M]>>;
  }

  /** Find in page: scan results and "Back to kineReqLens" from the page side. */
  onFindEvent(fn: (event: FindToPanel) => void): () => void {
    this.findListeners.add(fn);
    return () => {
      this.findListeners.delete(fn);
    };
  }

  shot<M extends ShotCallName>(method: M, ...args: Parameters<ShotCalls[M]>): Promise<ReturnType<ShotCalls[M]>> {
    return this.call(method, args) as Promise<ReturnType<ShotCalls[M]>>;
  }

  // ------------------------------------------------------------------------------------------ internals

  private post(message: PanelToHost): void {
    if (!this.connected) return;
    try {
      this.send(message);
    } catch {
      this.disconnected();
    }
  }

  private call(method: PanelCallName, args: unknown[]): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error(DISCONNECTED));
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t: 'call', id, method, args });
      if (!this.connected) {
        this.pending.delete(id);
        reject(new Error(DISCONNECTED));
      }
    });
  }

  private applyEntries(upsert: RequestEntry[], remove: string[]): void {
    let changed = false;
    for (const id of remove) if (this.entries.delete(id)) changed = true;
    for (const entry of upsert) {
      if (!entry || typeof entry.id !== 'string') continue;
      this.entries.set(entry.id, entry);
      changed = true;
    }
    if (!changed) return;
    this.sorted = null;
    // One notification per batch of messages (several chunks may arrive in a row).
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const fn of [...this.entryListeners]) {
        try {
          fn();
        } catch (err) {
          console.error('[kineReqLens] entries listener failed', err);
        }
      }
    });
  }

  private setTabStateLocal(next: TabState): void {
    const cur = this.tabState;
    if (cur.open === next.open && cur.recording === next.recording && cur.preserveLog === next.preserveLog) return;
    this.tabState = { open: next.open, recording: next.recording, preserveLog: next.preserveLog };
    emit(this.tabStateListeners, this.tabState);
  }

  private setSettingsLocal(next: Settings): void {
    if (next === this.settings) return;
    this.settings = next;
    emit(this.settingsListeners, next);
  }

  private setCaptureInfoLocal(next: CaptureInfo): void {
    const cur = this.captureInfo;
    if (cur.hookConnected === next.hookConnected && cur.lateInjection === next.lateInjection && cur.pageUrl === next.pageUrl) return;
    this.captureInfo = { ...next };
    emit(this.captureListeners, this.captureInfo);
  }
}
