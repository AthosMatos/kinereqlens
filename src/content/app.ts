/**
 * content.js runtime (docs/ARCHITECTURE.md §2.1–2.4, §4.2), one instance per frame.
 *
 * Every frame: private channel to the MAIN-world hook (mode/config pushes), settings, tab state,
 * chrome.runtime messages (TAB_STATE, REPLAY_IN_PAGE, ABORT_IN_PAGE, PING; top frame: BRIDGE_LIST / BRIDGE_ENTRY
 * for the Claude Code bridge).
 * Subframes: relay hook captures to the service worker (FRAME_CAPTURE); never mount UI.
 * Top frame: request store, ReqlensBridge (`globalThis.__reqlens`), on-demand UI loading (LOAD_UI),
 * badge count, preserved log, replay routing.
 *
 * After an extension reload/update every chrome.* call fails ("Extension context invalidated"): the
 * runtime wrappers turn those into no-ops, and the overlay keeps working locally (entries, page-mode
 * replays, closing it) until the page is reloaded.
 */
import { DEFAULT_TAB_STATE, SETTINGS_KEY } from '../shared/constants';
import type { GetTabStateResponse, HookToContent } from '../shared/messages';
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
  UiMountRecord,
} from '../shared/types';
import { capBody, isValidHookEnd, isValidHookStart } from '../lib/capture';
import type { BridgeHost } from './bridge';
import { createBridge } from './bridge';
import { bridgeEntry, bridgeList } from './claude';
import { HookPort, PAGE_HOOK_UNAVAILABLE } from './hookPort';
import type { PreserveStorage } from './preserve';
import { PreservedLog } from './preserve';
import type { RuntimeMessageListener } from './runtime';
import {
  errorMessage,
  extensionId,
  isContextValid,
  onInvalidated,
  onRuntimeMessage,
  onStorageChanged,
  sendRuntime,
  storageGet,
  storageSet,
  trySendRuntime,
} from './runtime';
import type { Timers } from './schedule';
import { Debouncer, delay, frameScheduler, windowTimers } from './schedule';
import type { SettingsStorage } from './settings';
import { hookConfigOf, SettingsStore } from './settings';
import { RequestStore } from './store';
import { WsStore } from './wsStore';
import { sanitizeWsEvents } from '../lib/ws';
import { languagesOf, normalizeLanguageValue } from '../shared/language';
import type { ComponentLocateResult, ComponentQuery } from '../shared/initiator-protocol';
import {
  cleanHookEnd,
  cleanHookStart,
  errorReplayResult,
  isRecord,
  isReplayRequestLike,
  isTabState,
  sanitizeReplayResult,
  sanitizeTabStatePatch,
} from './validate';

/** Delays before each GET_TAB_STATE attempt (the service worker may be starting up). */
const TAB_STATE_ATTEMPTS_MS = [0, 250, 1000];
const BADGE_DEBOUNCE_MS = 250;
const CONTEXT_GONE = 'kineReqLens was updated or reloaded — reload the page to keep using it';
const RELOADED = 'kineReqLens was reloaded on this page';
const NO_WORKER_ANSWER = 'No answer from the kineReqLens service worker — try again';
const NOT_TRACKED_WHILE_CLOSED = 'Not tracked while kineReqLens was closed';
const EMPTY: RequestEntry[] = [];

/** What a previous content-script instance in the same world hands over when it is replaced. */
export interface CarriedState {
  entries?: unknown;
  tabState?: unknown;
  lateInjection?: boolean;
}

/** Construction options of ContentApp. */
export interface ContentAppOptions {
  win: Window;
  /** This frame is the tab's top frame (store, bridge and UI live here). */
  isTop: boolean;
  /** The content script started after the page had loaded. */
  lateInjection: boolean;
  carried?: CarriedState;
  /** Called once after dispose() (unpublishes the global handles). */
  onDisposed?: () => void;
}

function currentUrl(win: Window): string {
  try {
    return win.location.href;
  } catch {
    return '';
  }
}

/** Blank manual entries target the page origin (`location.origin + '/'`), or the page URL for opaque origins. */
function defaultManualUrl(win: Window): string {
  try {
    const origin = win.location.origin;
    return /^https?:\/\//i.test(origin) ? `${origin}/` : win.location.href;
  } catch {
    return '';
  }
}

function chromeSettingsStorage(): SettingsStorage {
  return {
    read: () => storageGet('local', SETTINGS_KEY),
    write: (settings) => storageSet('local', { [SETTINGS_KEY]: settings }),
    watch: (listener) =>
      onStorageChanged((changes, areaName) => {
        const change = areaName === 'local' ? changes[SETTINGS_KEY] : undefined;
        if (change) listener(change.newValue);
      }),
  };
}

/**
 * The preserved log lives in chrome.storage.session, which content scripts cannot access: the service worker
 * reads/writes the log of this tab (it derives the key from the sender, the key argument is informational).
 */
function workerPreserveStorage(): PreserveStorage {
  return {
    read: async () => (await trySendRuntime({ type: 'PRESERVE_READ' })) ?? [],
    write: async (_key, entries) => (await trySendRuntime({ type: 'PRESERVE_WRITE', entries }))?.ok === true,
    remove: async () => (await trySendRuntime({ type: 'PRESERVE_CLEAR' }))?.ok === true,
  };
}

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      /* a failing subscriber must not starve the others */
    }
  }
}

/** ui.js may come from an older build: only `bridge` identity and `destroy()` are relied on. */
type ContentGlobal = typeof globalThis & { __reqlensUi?: UiMountRecord };

/** The content script of one frame; in the top frame it also backs the ReqlensBridge. */
export class ContentApp implements BridgeHost {
  /** Top frame only. */
  readonly bridge: ReqlensBridge | null;
  private readonly win: Window;
  private readonly isTop: boolean;
  private readonly timers: Timers;
  private readonly settings: SettingsStore;
  private readonly hook: HookPort;
  private readonly store: RequestStore | null;
  /** Top frame: WebSocket connections + frames of every frame of the page. */
  private readonly ws: WsStore | null;
  private readonly preserved: PreservedLog | null;
  private readonly badge: Debouncer | null;
  private tabId: number | null = null;
  private tabState: TabState;
  /** Confirmed by the service worker (or given up on); until then the hook keeps buffering. */
  private tabStateKnown = false;
  /** Capture was on when the tab state first became known (the hook buffered the page load). */
  private capturedFromStart = false;
  /** Bumped whenever the tab state is set from a broadcast or a SET_TAB_STATE answer. */
  private tabStateRevision = 0;
  private initialLoad: 'pending' | 'done' | 'failed' = 'pending';
  private captureInfo: CaptureInfo;
  private readonly tabStateListeners = new Set<(state: TabState) => void>();
  private readonly captureInfoListeners = new Set<(info: CaptureInfo) => void>();
  private readonly cleanups: Array<() => void> = [];
  /** In-flight replays started from this frame, for abort routing. */
  private readonly replays = new Map<string, Pick<ReplayRequest, 'mode' | 'frameId'>>();
  private uiLoading = false;
  private waitingForRoot = false;
  private lastBadgeCount = -1;
  private started = false;
  private disposed = false;
  private readonly onDisposed: (() => void) | undefined;

  constructor(options: ContentAppOptions) {
    const { win, isTop, carried } = options;
    this.onDisposed = options.onDisposed;
    this.win = win;
    this.isTop = isTop;
    this.timers = windowTimers(win);
    // A replaced instance's state is provisional: it gates captures but the hook mode waits for the worker.
    this.tabState = isTabState(carried?.tabState) ? { ...carried.tabState } : { ...DEFAULT_TAB_STATE };
    this.captureInfo = {
      lateInjection: carried?.lateInjection ?? options.lateInjection,
      hookConnected: false,
      pageUrl: currentUrl(win),
    };
    this.settings = new SettingsStore(chromeSettingsStorage());
    this.hook = new HookPort({
      win,
      onCapture: (message) => this.onHookCapture(message),
      onConnected: () => this.setCaptureInfo({ hookConnected: true }),
      onWs: (events) => this.onHookWs(events),
      now: () => Date.now(),
      capReplayBody: (body, req) => capBody(body, req.responseBodyCap),
    });
    if (!isTop) {
      this.store = null;
      this.ws = null;
      this.preserved = null;
      this.badge = null;
      this.bridge = null;
      return;
    }
    const store = new RequestStore({
      now: () => Date.now(),
      pageUrl: () => currentUrl(win),
      limits: () => {
        const settings = this.settings.get();
        return {
          maxEntries: settings.maxEntries,
          requestBodyCap: settings.requestBodyCap,
          responseBodyCap: settings.responseBodyCap,
        };
      },
      schedule: frameScheduler(win),
      defaultManualUrl: () => defaultManualUrl(win),
    });
    if (carried?.entries !== undefined) store.adopt(carried.entries);
    this.store = store;
    this.preserved = new PreservedLog({
      storage: workerPreserveStorage(),
      timers: this.timers,
      entries: () => store.getEntries(),
    });
    this.badge = new Debouncer(this.timers, BADGE_DEBOUNCE_MS, () => this.sendBadge());
    this.ws = new WsStore({
      schedule: frameScheduler(win),
      send: (hookId, text) => this.hook.wsSend(hookId, text),
    });
    this.bridge = createBridge(this, __VERSION__, this.ws);
  }

  /** Wire listeners, connect to the hook and ask the service worker for the tab state. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.cleanups.push(onInvalidated(() => this.onContextInvalidated()));
    this.cleanups.push(onRuntimeMessage(this.onMessage));
    this.cleanups.push(this.settings.subscribe(() => this.onSettingsChanged()));
    this.settings.start();
    this.hook.start();
    this.listen(this.win, 'pageshow', (event) => {
      // Back/forward cache restore: the tab state may have changed while this page was frozen.
      if ((event as PageTransitionEvent).persisted) void this.loadTabState('refresh');
    });
    const doc = this.win.document as Document & { prerendering?: boolean };
    if (this.isTop && doc.prerendering === true) {
      // A prerendered page (speculation rules, address-bar prerender) is not the tab's main frame yet: the
      // worker refuses LOAD_UI / SET_BADGE and does not hand it the tab's buffer, and TAB_STATE broadcasts
      // do not reach it. Once it is activated, start over as the tab's top document.
      this.listen(doc, 'prerenderingchange', () => {
        this.lastBadgeCount = -1;
        void this.loadTabState('activation');
      });
    }
    if (this.store) {
      this.cleanups.push(this.store.subscribe(() => this.onEntriesChanged()));
      this.listen(this.win, 'pagehide', () => this.preserved?.flush());
      this.listen(this.win, 'popstate', () => this.refreshPageUrl());
      this.listen(this.win, 'hashchange', () => this.refreshPageUrl());
    }
    void this.settings.ready.then(() => this.pushMode());
    void this.loadTabState('initial');
  }

  // -------------------------------------------------------------------------------------------
  // BridgeHost (top frame)
  // -------------------------------------------------------------------------------------------

  getEntries(): RequestEntry[] {
    return this.store ? this.store.getEntries() : EMPTY;
  }

  subscribeEntries(fn: () => void): () => void {
    return this.store ? this.store.subscribe(fn) : () => undefined;
  }

  clearEntries(): void {
    this.store?.clear();
    this.preserved?.clear();
  }

  addManualEntry(init?: ManualEntryInit): RequestEntry {
    if (!this.store) throw new Error('Manual requests are only available in the top frame');
    return this.store.addManual(init);
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

  /** Persist through the service worker; when it is unreachable the patch is applied locally. */
  async setTabState(patch: Partial<TabState>): Promise<TabState> {
    const clean = sanitizeTabStatePatch(patch);
    if (this.disposed || Object.keys(clean).length === 0) return this.tabState;
    if (isContextValid()) {
      try {
        const result: unknown = await sendRuntime({ type: 'SET_TAB_STATE', patch: clean });
        if (isTabState(result)) {
          this.tabStateRevision++;
          this.applyTabState(result);
          return this.tabState;
        }
      } catch {
        /* fall back to a local change */
      }
    }
    this.tabStateRevision++;
    this.applyTabState({ ...this.tabState, ...clean });
    return this.tabState;
  }

  getSettings(): Settings {
    return this.settings.get();
  }

  subscribeSettings(fn: (settings: Settings) => void): () => void {
    return this.settings.subscribe(fn);
  }

  updateSettings(patch: SettingsPatch): Promise<Settings> {
    return this.settings.update(patch);
  }

  /**
   * Page mode in the top frame runs through the local hook; everything else through the service worker.
   * Page-mode replays are registered first so their own webRequest events are swallowed. Never rejects.
   */
  async replay(req: ReplayRequest): Promise<ReplayResult> {
    const start = Date.now();
    // The UI is ours, but the request is still checked before it can reach the hook or the worker.
    const raw: unknown = req;
    if (!isReplayRequestLike(raw)) {
      const runId = isRecord(raw) && typeof raw.runId === 'string' ? raw.runId : '';
      const url = isRecord(raw) && typeof raw.url === 'string' ? raw.url : '';
      return errorReplayResult({ runId, url }, 'Invalid replay request', start, start);
    }
    if (this.disposed) return errorReplayResult(req, RELOADED, start, start);
    const local = req.mode === 'page' && req.frameId === 0;
    if (local && !this.hook.connected) return errorReplayResult(req, PAGE_HOOK_UNAVAILABLE, start, start);
    if (!local && !isContextValid()) return errorReplayResult(req, CONTEXT_GONE, start, start);
    if (this.replays.has(req.runId)) return errorReplayResult(req, 'A run with this id is already in progress', start, start);
    if (req.mode === 'page') {
      this.store?.registerReplay({ runId: req.runId, method: req.method, url: req.url, start });
    }
    this.replays.set(req.runId, { mode: req.mode, frameId: req.frameId });
    try {
      return local ? await this.hook.replay(req) : await this.replayViaWorker(req, start);
    } finally {
      this.replays.delete(req.runId);
      this.store?.completeReplay(req.runId);
    }
  }

  /** Initiator tab: component lookup through this (top) frame's hook. */
  locateComponents(query: ComponentQuery): Promise<ComponentLocateResult> {
    return this.hook.locateComponents(query);
  }

  abortReplay(runId: string): void {
    if (typeof runId !== 'string' || this.hook.abort(runId)) return;
    const run = this.replays.get(runId);
    if (run) void trySendRuntime({ type: 'ABORT_REPLAY', runId, frameId: run.frameId, mode: run.mode });
  }

  getCaptureInfo(): CaptureInfo {
    return this.captureInfo;
  }

  subscribeCaptureInfo(fn: (info: CaptureInfo) => void): () => void {
    this.captureInfoListeners.add(fn);
    return () => {
      this.captureInfoListeners.delete(fn);
    };
  }

  reloadPage(): void {
    this.win.location.reload();
  }

  setProtectedEntries(ids: string[]): void {
    if (Array.isArray(ids)) this.store?.setProtected(ids);
  }

  /** Tear down (a newer content script took over). Pending replays resolve with an error. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* context may be gone */
      }
    }
    this.hook.dispose();
    this.store?.dispose();
    this.ws?.dispose();
    this.preserved?.dispose();
    this.badge?.cancel();
    this.settings.dispose();
    this.tabStateListeners.clear();
    this.captureInfoListeners.clear();
    const ui = (globalThis as ContentGlobal).__reqlensUi;
    if (ui && this.bridge && ui.bridge === this.bridge) {
      try {
        ui.destroy();
      } catch {
        /* already torn down */
      }
    }
    try {
      this.onDisposed?.();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------------------------
  // Tab state & hook mode
  // -------------------------------------------------------------------------------------------

  /**
   * Ask the worker for the tab state. 'initial' (start-up) and 'activation' (a prerendered page became the
   * tab's page) also take the webRequest entries the worker buffered for this document and restore the
   * preserved log; 'refresh' (bfcache restore) only re-reads the state.
   */
  private async loadTabState(mode: 'initial' | 'refresh' | 'activation'): Promise<void> {
    const initial = mode === 'initial';
    const full = mode !== 'refresh';
    const revision = this.tabStateRevision;
    const response = await this.requestTabState();
    if (this.disposed) return;
    if (initial) this.initialLoad = response ? 'done' : 'failed';
    if (response && typeof response.tabId === 'number' && Number.isInteger(response.tabId)) {
      this.tabId = response.tabId;
      this.preserved?.setTab(response.tabId);
    }
    if (full && response && this.store) this.store.upsertWebRequest(response.entries);
    // As early as the worker can tell: page scripts that run before this see the browser's language.
    if (response) this.applyLanguage(response.language ?? null);
    const state = response && isTabState(response.tabState) ? response.tabState : null;
    // Start reading the previous page's log before preserve-log writes are enabled.
    const restoring = full && state?.preserveLog ? this.restorePreserved() : null;
    if (state && revision === this.tabStateRevision) this.applyTabState(state);
    // No answer: treat the tab as closed so the hook stops buffering.
    else if (!this.tabStateKnown) this.applyTabState(response ? this.tabState : { ...DEFAULT_TAB_STATE });
    if (mode === 'activation' && this.tabState.open) {
      // Badge and UI were refused while prerendering.
      this.lastBadgeCount = -1;
      this.scheduleBadge();
      this.ensureUi();
    }
    if (restoring) await restoring;
  }

  private async requestTabState(): Promise<GetTabStateResponse | null> {
    for (const wait of TAB_STATE_ATTEMPTS_MS) {
      if (wait) await delay(this.timers, wait);
      if (this.disposed || !isContextValid()) return null;
      try {
        const response: unknown = await sendRuntime({ type: 'GET_TAB_STATE' });
        // Field types are checked by the caller.
        if (isRecord(response)) return response as unknown as GetTabStateResponse;
      } catch {
        /* worker starting up or unreachable: retry */
      }
    }
    return null;
  }

  private async restorePreserved(): Promise<void> {
    if (!this.preserved || !this.store) return;
    const list = await this.preserved.load();
    if (!this.disposed && list.length > 0) this.store.addRestored(list);
  }

  private applyTabState(next: TabState): void {
    if (this.disposed) return;
    const previous = this.tabState;
    const wasKnown = this.tabStateKnown;
    this.tabStateKnown = true;
    const hidden = next.open && next.hidden === true;
    if (
      previous.open !== next.open ||
      previous.recording !== next.recording ||
      previous.preserveLog !== next.preserveLog ||
      (previous.hidden === true) !== hidden
    ) {
      // `hidden`: open in the background for Claude Code (capturing; ui.js keeps the panel invisible).
      this.tabState = { open: next.open, recording: next.recording, preserveLog: next.preserveLog, ...(hidden ? { hidden: true } : {}) };
      emit(this.tabStateListeners, this.tabState);
    }
    this.pushMode();
    if (!this.isTop) return;
    if (wasKnown && previous.open && !this.tabState.open) {
      // The worker stops tracking webRequest events of a closed tab (and drops its buffer).
      this.store?.settlePendingWebRequest(NOT_TRACKED_WHILE_CLOSED);
    }
    if (!wasKnown) this.capturedFromStart = this.isCapturing();
    else if (!this.capturedFromStart && this.isCapturing() && !this.captureInfo.lateInjection) {
      // Opened (or resumed) after start-up: the page-load requests were not captured.
      this.setCaptureInfo({ lateInjection: true });
    }
    this.preserved?.setEnabled(this.tabState.preserveLog);
    if (this.tabState.open) {
      if (!previous.open || !wasKnown) {
        // The worker clears the badge while the overlay is closed: send the count again.
        this.lastBadgeCount = -1;
        this.scheduleBadge();
      }
      this.ensureUi();
    }
  }

  private isCapturing(): boolean {
    return this.tabState.open && this.tabState.recording;
  }

  /** Tell the hook whether to capture (only once the tab state and settings are known). */
  private pushMode(): void {
    if (this.disposed || !this.tabStateKnown || !this.settings.loaded) return;
    this.hook.setMode(this.isCapturing() ? 'on' : 'off', hookConfigOf(this.settings.get()));
  }

  private onSettingsChanged(): void {
    this.pushMode();
    this.store?.enforceLimit();
  }

  // -------------------------------------------------------------------------------------------
  // Hook captures
  // -------------------------------------------------------------------------------------------

  /** Untrusted MAIN-world capture. New requests are only accepted while capturing; ends always are. */
  private onHookCapture(message: HookToContent): void {
    if (this.disposed || (message.t === 'start' && !this.isCapturing())) return;
    try {
      if (this.store) this.store.handleHookMessage(0, message);
      else this.relayCapture(message);
    } catch {
      /* malformed capture */
    }
  }

  /**
   * Untrusted WebSocket batch from this frame's hook. Top frame: into the store (new sockets and frames only
   * while capturing; lifecycle events of known sockets always). Subframes: validated, then relayed.
   */
  private onHookWs(events: unknown): void {
    if (this.disposed) return;
    try {
      if (this.ws) {
        this.ws.handle(0, events, { capturing: this.isCapturing() });
        return;
      }
      if (!isContextValid()) return;
      const clean = sanitizeWsEvents(events);
      // Closed tab: the worker drops relays anyway; paused: only lifecycle events matter.
      const relay = this.isCapturing() ? clean : clean.filter((e) => e.e !== 'new' && e.e !== 'frame');
      if (relay.length) void trySendRuntime({ type: 'FRAME_CAPTURE', msg: { t: 'ws', events: relay } });
    } catch {
      /* malformed batch */
    }
  }

  /** Subframe: validate, bound and forward to the service worker, which relays it to the top frame. */
  private relayCapture(message: HookToContent): void {
    if (!isContextValid()) return;
    const { requestBodyCap, responseBodyCap } = this.settings.get();
    let msg: HookToContent | null = null;
    if (message.t === 'start' && isValidHookStart(message.data)) {
      msg = {
        t: 'start',
        data: cleanHookStart(message.data, (body) => capBody(body, requestBodyCap), currentUrl(this.win)),
      };
    } else if (message.t === 'end' && isValidHookEnd(message.data)) {
      msg = { t: 'end', data: cleanHookEnd(message.data, (body) => capBody(body, responseBodyCap)) };
    }
    if (msg) void trySendRuntime({ type: 'FRAME_CAPTURE', msg });
  }

  // -------------------------------------------------------------------------------------------
  // Service worker messages
  // -------------------------------------------------------------------------------------------

  private readonly onMessage: RuntimeMessageListener = (message, sender, sendResponse) => {
    if (this.disposed || !isRecord(message) || typeof message.type !== 'string') return undefined;
    if (sender.id !== extensionId()) return undefined;
    try {
      switch (message.type) {
        case 'TAB_STATE':
          this.onTabStateMessage(message.tabState);
          return undefined;
        case 'WR_ENTRIES':
          this.store?.upsertWebRequest(message.entries);
          return undefined;
        case 'FRAME_CAPTURE_RELAY':
          this.onFrameCaptureRelay(message);
          return undefined;
        case 'REPLAY_IN_PAGE':
          return this.onReplayInPage(message.req, sendResponse);
        case 'ABORT_IN_PAGE':
          sendResponse({ ok: typeof message.runId === 'string' && this.hook.abort(message.runId) });
          return undefined;
        case 'PING':
          sendResponse({ ok: true, hasUi: this.isUiMounted() });
          return undefined;
        case 'UI_UNMOUNT':
          // A panel mounted invisibly for Claude Code went idle: remove it unless the overlay is open meanwhile.
          sendResponse({ ok: true, unmounted: this.unmountClosedUi() });
          return undefined;
        case 'LANGUAGE':
          this.applyLanguage(message.value);
          return undefined;
        // Claude Code bridge queries (top frame only; subframes stay silent so the top frame answers).
        case 'BRIDGE_LIST':
          if (!this.store) return undefined;
          sendResponse(bridgeList(this.store.getEntries(), currentUrl(this.win), message.countOnly === true));
          return undefined;
        case 'BRIDGE_ENTRY': {
          const store = this.store;
          if (!store) return undefined;
          sendResponse(bridgeEntry((id) => store.get(id), message.id, currentUrl(this.win)));
          return undefined;
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  };

  /** "Site language" override of the tab (worker data, re-validated): pushed to this frame's hook. */
  private applyLanguage(value: unknown): void {
    if (this.disposed) return;
    const normalized = value === null || value === undefined ? null : normalizeLanguageValue(value);
    const tags = normalized ? languagesOf(normalized) : [];
    this.hook.setLanguages(tags.length ? tags : null);
  }

  private onTabStateMessage(value: unknown): void {
    if (!isTabState(value)) return;
    this.tabStateRevision++;
    this.applyTabState(value);
    // The first GET_TAB_STATE failed (worker was unreachable): try again now that it talks to us.
    if (this.initialLoad === 'failed') {
      this.initialLoad = 'pending';
      void this.loadTabState('initial');
    }
  }

  private onFrameCaptureRelay(message: Record<string, unknown>): void {
    const { frameId, frameUrl, msg } = message;
    if (!this.store || typeof frameId !== 'number' || frameId === 0 || !isRecord(msg)) return;
    if (msg.t === 'ws') {
      this.ws?.handle(frameId, msg.events, {
        capturing: this.isCapturing(),
        ...(typeof frameUrl === 'string' ? { frameUrl } : {}),
      });
      return;
    }
    if (msg.t === 'start' && !this.isCapturing()) return;
    this.store.handleHookMessage(frameId, msg, typeof frameUrl === 'string' ? frameUrl : undefined);
  }

  /** Page-mode replay in this frame on behalf of the top frame (via the worker). Answers asynchronously. */
  private onReplayInPage(value: unknown, sendResponse: (response?: unknown) => void): boolean | undefined {
    const start = Date.now();
    if (!isReplayRequestLike(value)) {
      const runId = isRecord(value) && typeof value.runId === 'string' ? value.runId : '';
      const url = isRecord(value) && typeof value.url === 'string' ? value.url : '';
      sendResponse(errorReplayResult({ runId, url }, 'Invalid replay request', start, start));
      return undefined;
    }
    void this.hook.replay(value).then(sendResponse);
    return true;
  }

  private async replayViaWorker(req: ReplayRequest, start: number): Promise<ReplayResult> {
    try {
      const result: unknown = await sendRuntime({ type: 'REPLAY', req });
      if (!isRecord(result)) return errorReplayResult(req, NO_WORKER_ANSWER, start, Date.now());
      return sanitizeReplayResult(result, req, start, Date.now(), (body) => capBody(body, req.responseBodyCap));
    } catch (error) {
      return errorReplayResult(req, isContextValid() ? errorMessage(error) : CONTEXT_GONE, start, Date.now());
    }
  }

  // -------------------------------------------------------------------------------------------
  // UI, badge, page URL
  // -------------------------------------------------------------------------------------------

  private isUiMounted(): boolean {
    const ui = (globalThis as ContentGlobal).__reqlensUi;
    return !!ui && !!this.bridge && ui.bridge === this.bridge;
  }

  /** Destroy this bridge's UI while the overlay is closed (an idle headless mount). True when it was removed. */
  private unmountClosedUi(): boolean {
    if (!this.isTop || this.tabState.open || !this.isUiMounted()) return false;
    try {
      (globalThis as ContentGlobal).__reqlensUi?.destroy();
    } catch {
      /* already torn down */
    }
    return !this.isUiMounted();
  }

  /** Inject ui.js (once per bridge) while the overlay is open. */
  private ensureUi(): void {
    if (!this.bridge || this.disposed || this.uiLoading || !this.tabState.open) return;
    if (this.isUiMounted() || !isContextValid()) return;
    const doc = this.win.document;
    if (!doc.documentElement) {
      if (!this.waitingForRoot) {
        this.waitingForRoot = true;
        this.listen(doc, 'DOMContentLoaded', () => {
          this.waitingForRoot = false;
          this.ensureUi();
        });
      }
      return;
    }
    this.uiLoading = true;
    void trySendRuntime({ type: 'LOAD_UI' }).then(() => {
      // ui.js mounts while it is injected; when that failed the next open tries again.
      this.uiLoading = false;
    });
  }

  private scheduleBadge(): void {
    if (this.badge && this.tabState.open && !this.disposed) this.badge.schedule();
  }

  private sendBadge(): void {
    if (!this.store || !this.tabState.open || this.disposed || !isContextValid()) return;
    const count = this.store.size;
    if (count === this.lastBadgeCount) return;
    this.lastBadgeCount = count;
    void trySendRuntime({ type: 'SET_BADGE', count });
  }

  private onEntriesChanged(): void {
    this.scheduleBadge();
    this.preserved?.schedule();
    this.refreshPageUrl();
  }

  /** SPA navigations change the page URL without a reload. */
  private refreshPageUrl(): void {
    const pageUrl = currentUrl(this.win);
    if (pageUrl !== this.captureInfo.pageUrl) this.setCaptureInfo({ pageUrl });
  }

  private setCaptureInfo(patch: Partial<CaptureInfo>): void {
    if (this.disposed) return;
    const next: CaptureInfo = { ...this.captureInfo, ...patch };
    const current = this.captureInfo;
    if (
      next.hookConnected === current.hookConnected &&
      next.lateInjection === current.lateInjection &&
      next.pageUrl === current.pageUrl
    ) {
      return;
    }
    this.captureInfo = next;
    emit(this.captureInfoListeners, next);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle helpers
  // -------------------------------------------------------------------------------------------

  /** Extension reloaded/removed: chrome.* is gone; keep the overlay usable locally. */
  private onContextInvalidated(): void {
    this.badge?.cancel();
    this.preserved?.dispose();
    this.uiLoading = false;
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const wrapped = (event: Event): void => {
      try {
        handler(event);
      } catch {
        /* never let kineReqLens errors reach the page */
      }
    };
    target.addEventListener(type, wrapped);
    this.cleanups.push(() => target.removeEventListener(type, wrapped));
  }
}
