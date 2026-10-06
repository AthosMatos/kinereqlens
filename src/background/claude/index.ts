// Claude Code bridge in the service worker (docs/specs/v0.2.md §B.4): ties the native port to the hub
// (./native.ts), the panel links (./links.ts), the default-tab order (./activity.ts) and the call handlers
// (./handlers.ts) to settings, the optional nativeMessaging permission and tab events.
//
// MV3: registerClaudeBridgeListeners() must be called synchronously at the top level of the worker; start()
// re-reads permission + settings after every worker (re)start and reconnects when the bridge is enabled.
import { DEFAULT_SETTINGS, SETTINGS_KEY, mergeSettings } from '../../shared/constants';
import type { BridgeStatus, ExtensionToHost } from '../../shared/claude-protocol';
import type { TabMessage } from '../../shared/messages';
import type { ResolvedFrame, ResolveFrameRequest } from '../../shared/initiator-protocol';
import type { LanguageStatus } from '../../shared/language';
import type { Settings, SettingsPatch, TabState } from '../../shared/types';
import { sanitizeSettings } from '../../content/settings';
import type { OpenOutcome } from '../controller';
import { injectContentScripts, isRestrictedUrl } from '../inject';
import { uid } from '../../lib/ids';
import { tabIdFromStateKey } from '../tabs';
import { isRecord } from '../util';
import { ACTIVITY_KEY, TabActivity } from './activity';
import { browserLabel } from './format';
import { bridgeErrorMessage, createBridgeHandlers } from './handlers';
import type { HandlerDeps } from './handlers';
import { PanelLinks } from './links';
import type { LinkPort } from './links';
import { NativeHostLink } from './native';
import type { HostRequest, NativePort } from './native';
import { FsRelay } from './fs';
import { PtyRelay } from './pty';
import { RunRelay } from './runs';
import { ShotRelay } from './shots';
import { completeInboxItem, isBridgeMethod } from './validate';
import { ControlPlane } from './control/plane';
import type { BrowserTab, ControlBrowser } from './control/plane';
import { HEADLESS_IDLE_MS } from '../../shared/control-protocol';
import type { PanelStateResult } from '../../shared/control-protocol';

declare global {
  /** E2E build only: idle time (ms) before a headless panel mounted for Claude is removed (tests shorten it). */
  var __reqlensHeadlessIdleMs: number | undefined;
}

/** Calls answered at the same time; more are refused (Claude retries). */
export const MAX_CONCURRENT_CALLS = 16;
/** The hub drops lines over 16 MB: answers must stay below. */
export const MAX_RESULT_CHARS = 15_000_000;
const PERSIST_DELAY_MS = 500;
const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] };

/** React Native support sharing the native host (src/background/rn/index.ts). */
export interface ClaudeBridgeRnHooks {
  /** The native host is wanted for React Native (settings.rnEnabled). */
  wanted(): boolean;
  onMessage(message: Record<string, unknown>): void;
  onConnected(): void;
  onPortClosed(): void;
  /** Settings / permission / host state changed. */
  onChange(): void;
}

export interface ClaudeBridgeDeps {
  extensionId: string;
  /** React Native support (keeps the native host running while settings.rnEnabled). */
  rn?: ClaudeBridgeRnHooks;
  extensionVersion: string;
  /** Tab state and settings loaded. */
  ready: Promise<void>;
  settings: { get(): Settings; adopt?(settings: Settings): void };
  tabs: { get(tabId: number): TabState; isOpen(tabId: number): boolean; isHidden?(tabId: number): boolean; openTabIds(): number[] };
  sendToFrame(tabId: number, frameId: number, message: TabMessage): Promise<unknown>;
  /** Opening / closing overlays for the control tools (the toolbar's checks). */
  controller?: {
    open(tabId: number, options: { hidden?: boolean }): Promise<OpenOutcome>;
    setState(tabId: number, patch: Partial<TabState>): Promise<TabState>;
  };
  /** "Site language" (src/background/language.ts). */
  language?: {
    load(): Promise<void>;
    status(tabId: number, url?: string): LanguageStatus;
    setTab(tabId: number, value: string | null): Promise<LanguageStatus>;
    refresh(tabId: number): Promise<LanguageStatus>;
  };
  /** Source maps for the initiator (src/background/sources.ts). */
  sources?: { resolve(frames: ResolveFrameRequest[], pageUrl: string): Promise<ResolvedFrame[]> };
}

function browserTabOf(tab: chrome.tabs.Tab): BrowserTab | null {
  if (typeof tab.id !== 'number' || tab.id < 0) return null;
  const out: BrowserTab = { id: tab.id, windowId: tab.windowId, active: tab.active === true, title: tab.title ?? '', url: tab.url || tab.pendingUrl || '' };
  if (typeof tab.width === 'number') out.width = tab.width;
  if (typeof tab.height === 'number') out.height = tab.height;
  return out;
}

/** chrome.tabs / windows / scripting for the control plane. */
const chromeBrowser: ControlBrowser = {
  getTab: async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return tab ? browserTabOf(tab) : null;
  },
  queryTabs: async () => (await chrome.tabs.query({})).map(browserTabOf).filter((t): t is BrowserTab => t !== null),
  getWindow: async (windowId) => {
    const win = await chrome.windows.get(windowId).catch(() => undefined);
    return win && typeof win.id === 'number' ? { id: win.id, state: win.state ?? 'normal', focused: win.focused === true } : null;
  },
  lastFocusedWindow: async () => {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    return typeof win?.id === 'number' ? win.id : null;
  },
  activate: async (tabId) => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') {
      const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
      await chrome.windows.update(tab.windowId, win?.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true });
    }
  },
  reload: async (tabId) => {
    await chrome.tabs.reload(tabId);
  },
  injectUi: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['ui.js'], injectImmediately: true });
  },
  injectContentScripts: (tabId) => injectContentScripts(tabId),
  isRestrictedUrl,
};

/** The bridge method names as the MCP tools call them (for the trace). */
const TOOL_NAMES: Record<string, string> = {
  listTabs: 'list_tabs',
  listRequests: 'list_requests',
  getRequest: 'get_request',
  getTypes: 'get_types',
  getPrompt: 'get_prompt',
  sendRequest: 'send_request',
};

interface UaBrands {
  userAgentData?: { brands?: Array<{ brand: string; version: string }> };
}

function currentBrowser(): string {
  try {
    return browserLabel((navigator as Navigator & UaBrands).userAgentData?.brands, navigator.userAgent);
  } catch {
    return 'Chromium-based browser';
  }
}

async function hasNativePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(NATIVE_PERMISSION);
  } catch {
    return false;
  }
}

export class ClaudeBridge {
  readonly activity: TabActivity;
  readonly links: PanelLinks;
  readonly native: NativeHostLink;
  /** Embedded terminals (panel ↔ hub relay). */
  readonly ptys: PtyRelay;
  /** Folder browser of the terminal's new-session form (panel ↔ hub relay). */
  readonly folders: FsRelay;
  /** Errors view: Claude runs and full-mode git ops (panel ↔ hub relay). */
  readonly runs: RunRelay;
  /** "Send to Claude" screenshots (panel ↔ hub relay). */
  readonly shots: ShotRelay;
  /** The control tools (MCP `control`): ops, headless panels, the visible trace. */
  readonly control: ControlPlane;
  private lastFullMode = false;
  private lastControl = false;
  private settingsWrite: Promise<unknown> = Promise.resolve();
  private readonly call: ReturnType<typeof createBridgeHandlers>;
  private readonly browser = currentBrowser();
  private permission = false;
  private started = false;
  private inflight = 0;
  private lastStatus = '';
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ClaudeBridgeDeps) {
    this.ptys = new PtyRelay({ send: (message) => this.native.sendPty(message) });
    this.folders = new FsRelay({
      send: (message) => this.native.sendFs(message),
      connected: () => this.native.connected,
      supported: () => this.native.supportsFs,
      enabled: () => deps.settings.get().claudeBridge === true,
    });
    this.runs = new RunRelay({
      send: (message) => this.native.sendRun(message),
      connected: () => this.native.connected,
      supported: () => this.native.supportsRuns,
      enabled: () => deps.settings.get().claudeBridge === true,
      fullMode: () => deps.settings.get().errorsFullMode === true,
      autoAnalyze: () => deps.settings.get().autoAnalyzeErrors === true,
    });
    this.shots = new ShotRelay({
      send: (message) => this.native.sendShot(message),
      connected: () => this.native.connected,
      supported: () => this.native.supportsShots,
      enabled: () => deps.settings.get().claudeBridge === true,
    });
    this.activity = new TabActivity(
      (tabId) => deps.tabs.isOpen(tabId),
      () => this.schedulePersist(),
    );
    this.links = new PanelLinks({
      extensionId: deps.extensionId,
      status: () => this.status(),
      onHello: (tabId) => {
        this.activity.touch(tabId);
        // Someone is looking at the overlay: do not make them wait for the backoff.
        this.native.retryNow();
      },
      onPush: (tabId, item) => {
        // Screenshots: only files the hub saved for a panel ("Send to Claude"), never arbitrary paths.
        if (item.images?.some((image) => !this.shots.knows(image.path))) {
          return { ok: false, delivered: 0, error: 'Unknown screenshot file — send the screenshot again' };
        }
        return this.native.push(completeInboxItem(item, tabId, uid('inbox-'), Date.now()));
      },
      onLinkOpen: (link) => this.ptys.linkOpened(link),
      onLinkClose: (link) => {
        this.ptys.linkClosed(link);
        this.folders.linkClosed(link);
        this.runs.linkClosed(link);
        this.shots.linkClosed(link);
      },
      onPty: (link, message) => this.ptys.fromPanel(link, message),
      onFs: (link, message) => this.folders.fromPanel(link, message),
      onRun: (link, message) => this.runs.fromPanel(link, message),
      onShot: (link, message) => this.shots.fromPanel(link, message),
    });
    this.native = new NativeHostLink({
      extensionId: deps.extensionId,
      connect: (name) => {
        if (typeof chrome.runtime.connectNative !== 'function') {
          throw new Error('native messaging is unavailable — reload kineReqLens in edge://extensions');
        }
        return chrome.runtime.connectNative(name) as NativePort;
      },
      lastError: () => chrome.runtime.lastError?.message,
      hello: () => ({ extensionVersion: deps.extensionVersion, browser: this.browser }),
      onRequest: (req) => this.answer(req),
      onChange: () => this.statusChanged(),
      onPty: (message) => this.ptys.fromHost(message),
      onFs: (message) => this.folders.fromHost(message),
      onRun: (message) => this.runs.fromHost(message),
      onShot: (message) => this.shots.fromHost(message),
      onPortClosed: () => {
        this.ptys.hostGone();
        this.folders.hostGone();
        this.runs.hostGone();
        this.shots.hostGone();
        deps.rn?.onPortClosed();
      },
      onConnected: () => {
        this.runs.syncConfig(true);
        deps.rn?.onConnected();
      },
      onRn: (message) => deps.rn?.onMessage(message),
    });
    const handlerDeps: HandlerDeps = {
      settings: () => deps.settings.get(),
      tabs: deps.tabs,
      activity: this.activity,
      links: this.links,
      sendToTop: (tabId, message) => deps.sendToFrame(tabId, 0, message),
      tabInfo: async (tabId) => {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        return tab ? { title: tab.title ?? '', url: tab.url ?? tab.pendingUrl ?? '' } : null;
      },
      extensionVersion: deps.extensionVersion,
      browser: this.browser,
      listFilters: async (tabId) => {
        if (!this.links.has(tabId)) return null;
        const state = (await this.links.query(tabId, { kind: 'control', op: { op: 'state' } }, 3000)) as PanelStateResult | null;
        return state && typeof state === 'object' && typeof state.textFilter === 'string' ? { textFilter: state.textFilter, removedIds: Array.isArray(state.removedIds) ? state.removedIds : [] } : null;
      },
    };
    const controller = deps.controller ?? {
      open: async () => ({ ok: false as const, reason: 'restricted' as const }),
      setState: async (tabId: number) => deps.tabs.get(tabId),
    };
    this.control = new ControlPlane({
      settings: () => deps.settings.get(),
      updateSettings: (patch) => this.writeSettings(patch),
      tabs: {
        get: (tabId) => deps.tabs.get(tabId),
        isOpen: (tabId) => deps.tabs.isOpen(tabId),
        isHidden: (tabId) => deps.tabs.isHidden?.(tabId) === true,
        openTabIds: () => deps.tabs.openTabIds(),
      },
      controller,
      links: this.links,
      activity: this.activity,
      sendToTop: (tabId, message) => deps.sendToFrame(tabId, 0, message),
      browser: chromeBrowser,
      handlers: handlerDeps,
      ...(deps.language ? { language: deps.language } : {}),
      ...(deps.sources ? { sources: deps.sources } : {}),
      onTrace: () => this.statusChanged(),
      session: {
        get: (key) => chrome.storage.session.get(key),
        set: (items) => chrome.storage.session.set(items),
      },
      ...(__E2E__ ? { headlessIdleMs: () => (typeof globalThis.__reqlensHeadlessIdleMs === 'number' ? globalThis.__reqlensHeadlessIdleMs : HEADLESS_IDLE_MS) } : {}),
    });
    handlerDeps.control = {
      run: (params) => this.control.run(params),
      defaultTab: () => this.control.defaultTab(),
      ensurePanel: (tabId) => this.control.ensurePanel(tabId),
      hold: (tabId) => this.control.hold(tabId),
      allowed: () => this.control.allowed(),
    };
    this.call = createBridgeHandlers(handlerDeps);
  }

  /** The tab's panel acts for Claude (src/background/router.ts RouterDeps.controlled). */
  controlled(tabId: number): boolean {
    return this.control.controlled(tabId);
  }

  /**
   * Persist a settings patch from the control tools (sanitized like the content scripts' writes; `layout: "default"`
   * resets the layout). Serialized; the settings cache takes the result at once.
   */
  private writeSettings(patch: SettingsPatch | (Omit<SettingsPatch, 'layout'> & { layout: 'default' })): Promise<Settings> {
    const run = this.settingsWrite.then(async () => {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const current = sanitizeSettings(stored[SETTINGS_KEY]);
      const clean: SettingsPatch = patch.layout === 'default' ? { ...patch, layout: { ...DEFAULT_SETTINGS.layout } } : (patch as SettingsPatch);
      const next = sanitizeSettings(mergeSettings(current, clean));
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      this.deps.settings.adopt?.(next);
      return next;
    });
    this.settingsWrite = run.catch(() => undefined);
    return run;
  }

  /** Load permission and the persisted tab order, then connect when enabled. Never rejects. */
  async start(): Promise<void> {
    await this.deps.ready.catch(() => undefined);
    try {
      const stored = await chrome.storage.session.get(ACTIVITY_KEY);
      this.activity.restore(stored[ACTIVITY_KEY]);
    } catch {
      /* best effort */
    }
    this.permission = await hasNativePermission();
    await this.control.restore();
    this.started = true;
    this.sync();
  }

  /** The optional nativeMessaging permission is granted (as last checked). */
  get permissionGranted(): boolean {
    return this.permission;
  }

  /** Status shown in the overlay. */
  status(): BridgeStatus {
    const enabled = this.deps.settings.get().claudeBridge === true;
    const native = this.native.state;
    let host = enabled && this.permission ? native.host : 'off';
    if (enabled && !this.started) host = 'connecting';
    const status: BridgeStatus = { enabled, permission: this.permission, host, sessions: host === 'connected' ? native.sessions : [], extensionId: this.deps.extensionId };
    const trace = this.control.traceItems();
    if (enabled && trace.length) status.trace = trace;
    if (native.hostVersion && host === 'connected') status.hostVersion = native.hostVersion;
    if (native.error && (host === 'error' || host === 'not-installed')) status.error = native.error;
    return status;
  }

  // ---- listener entry points (see registerClaudeBridgeListeners) ------------------------------------

  onConnect(port: LinkPort): void {
    this.links.accept(port);
  }

  onPermissionsChanged(): void {
    void hasNativePermission().then((granted) => {
      this.permission = granted;
      this.sync();
    });
  }

  onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    if (areaName === 'local' && changes[SETTINGS_KEY]) {
      // The settings cache (registered earlier on the same event) already holds the new value.
      this.sync();
      return;
    }
    if (areaName !== 'session') return;
    for (const [key, change] of Object.entries(changes)) {
      const tabId = tabIdFromStateKey(key);
      if (tabId !== null && isRecord(change.newValue) && change.newValue.open === true) {
        this.touchWhenReady(tabId);
        // A panel mounted invisibly for Claude belongs to the user once the overlay is opened.
        if (change.newValue.hidden !== true) this.control.onTabOpened(tabId);
      }
    }
  }

  onTabActivated(tabId: number): void {
    this.touchWhenReady(tabId);
  }

  onWindowFocusChanged(windowId: number): void {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs
      .query({ active: true, windowId })
      .then(([tab]) => {
        if (typeof tab?.id === 'number') this.touchWhenReady(tab.id);
      })
      .catch(() => undefined);
  }

  onTabRemoved(tabId: number): void {
    this.activity.remove(tabId);
    this.control.onTabRemoved(tabId);
  }

  onTabReplaced(addedTabId: number, removedTabId: number): void {
    this.activity.replace(removedTabId, addedTabId);
  }

  // ---- internals --------------------------------------------------------------------------------------

  private sync(): void {
    if (this.started) {
      const settings = this.deps.settings.get();
      const claude = settings.claudeBridge === true && this.permission;
      // Turning the bridge off ends every embedded terminal (told while the hub is still reachable).
      if (!claude && this.ptys.size > 0) this.ptys.killAll('The Claude Code bridge was turned off');
      if (!claude && this.runs.size > 0) this.runs.cancelAll('The Claude Code bridge was turned off');
      const fullMode = settings.errorsFullMode === true;
      if (this.lastFullMode && !fullMode) this.runs.cancelAll('Full mode was turned off', true);
      this.lastFullMode = fullMode;
      // Turning control off removes the panels mounted invisibly for Claude.
      const control = this.control.allowed();
      if (this.lastControl && !control) this.control.onDisabled();
      this.lastControl = control;
      this.runs.syncConfig();
      // React Native support needs the same native host (its receiver runs in the hub).
      this.native.setWanted(claude || (this.permission && this.deps.rn?.wanted() === true));
    }
    this.statusChanged();
  }

  private statusChanged(): void {
    this.deps.rn?.onChange();
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    this.links.broadcast(status);
  }

  private touchWhenReady(tabId: number): void {
    void this.deps.ready.then(
      () => this.activity.touch(tabId),
      () => undefined,
    );
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      chrome.storage.session.set({ [ACTIVITY_KEY]: this.activity.ordered() }).catch(() => undefined);
    }, PERSIST_DELAY_MS);
  }

  /** Answer one relayed call (never rejects). */
  private async answer(req: HostRequest): Promise<Extract<ExtensionToHost, { t: 'res' }>> {
    const fail = (error: string): Extract<ExtensionToHost, { t: 'res' }> => ({ t: 'res', id: req.id, ok: false, error });
    if (!isBridgeMethod(req.method)) return fail(`Unknown method "${req.method.slice(0, 64)}"`);
    if (this.inflight >= MAX_CONCURRENT_CALLS) return fail('kineReqLens is busy with other calls — try again');
    this.inflight++;
    try {
      await this.deps.ready;
      // The hub may run for React Native only: Claude's calls need the Claude Code bridge itself.
      if (this.deps.settings.get().claudeBridge !== true) return fail('The Claude Code bridge is turned off in kineReqLens (Settings → Claude Code)');
      let result: unknown;
      try {
        result = await this.call(req.method, req.params);
      } catch (err) {
        this.traceCall(req, false);
        throw err;
      }
      this.traceCall(req, true);
      const size = JSON.stringify(result)?.length ?? 0;
      if (size > MAX_RESULT_CHARS) return fail(`The answer is too large (${Math.round(size / 1e6)} MB) — use a smaller maxBodyChars`);
      return { t: 'res', id: req.id, ok: true, result };
    } catch (err) {
      return fail(bridgeErrorMessage(err));
    } finally {
      this.inflight--;
    }
  }

  /** The read tools in the visible trace (the control tools record themselves; status is left out). */
  private traceCall(req: HostRequest, ok: boolean): void {
    const tool = TOOL_NAMES[req.method];
    if (!tool) return;
    const tabId = isRecord(req.params) && typeof req.params.tabId === 'number' ? req.params.tabId : undefined;
    this.control.recordCall(tool, tabId, ok);
  }
}

/** Register the bridge's chrome event listeners. Call synchronously at the worker's top level. */
export function registerClaudeBridgeListeners(bridge: ClaudeBridge): void {
  chrome.runtime.onConnect.addListener((port) => bridge.onConnect(port));
  chrome.permissions.onAdded.addListener(() => bridge.onPermissionsChanged());
  chrome.permissions.onRemoved.addListener(() => bridge.onPermissionsChanged());
  chrome.storage.onChanged.addListener((changes, areaName) => bridge.onStorageChanged(changes, areaName));
  chrome.tabs.onActivated.addListener((info) => bridge.onTabActivated(info.tabId));
  chrome.windows.onFocusChanged.addListener((windowId) => bridge.onWindowFocusChanged(windowId));
  chrome.tabs.onRemoved.addListener((tabId) => bridge.onTabRemoved(tabId));
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => bridge.onTabReplaced(addedTabId, removedTabId));
}
