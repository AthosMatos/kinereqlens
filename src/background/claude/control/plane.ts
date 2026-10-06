// The control plane in the service worker (docs/CLAUDE_INTEGRATION.md "Control tools", src/shared/control-protocol.ts):
// validates a `control` call, gates it (settings.claudeAllowControl; claudeAllowSend for sends; errorsFullMode for
// the full-mode Errors flows), picks the target tab, runs the op — in the worker, or in the tab's panel over the panel
// link — and records it in the visible trace.
//
// Headless panels: an op that needs a panel while the overlay is closed mounts one invisibly (content scripts injected
// when missing, then ui.js: the host stays `display: none`, its iframe inert). Mounts made here are removed again after
// HEADLESS_IDLE_MS without a command (UI_UNMOUNT), unless the user opened the overlay meanwhile — it then simply shows
// that panel, with what Claude selected, edited or filtered. While an op runs (and while a headless panel is mounted)
// the tab counts as `controlled`: the worker lets its panel capture the tab, resolve initiators and replay like an
// open overlay's.
import { CONTROL_DISABLED, CONTROL_TRACE_MAX, HEADLESS_IDLE_MS } from '../../../shared/control-protocol';
import type { ControlParams, ControlResult, ControlTraceItem, PanelControlOp, PanelStateResult } from '../../../shared/control-protocol';
import type { LinkQuery } from '../../../shared/claude-link';
import type { TabMessage } from '../../../shared/messages';
import type { ResolvedFrame, ResolveFrameRequest } from '../../../shared/initiator-protocol';
import type { LanguageStatus } from '../../../shared/language';
import type { Settings, SettingsPatch, TabState } from '../../../shared/types';
import { MAX_TOOL_TEXT_CHARS, clipToolText } from '../../../shared/markdown';
import type { OpenOutcome } from '../../controller';
import { isRecord } from '../../util';
import { BridgeError, SEND_DISABLED } from '../handlers';
import type { HandlerDeps } from '../handlers';
import { LinkError } from '../links';
import type { Timers } from '../native';
import { OPS } from './ops';
import { validateControl } from './validate';
import type { ValidControl } from './validate';

/** An open overlay's panel (re)connecting. */
export const PANEL_WAIT_MS = 4000;
/** A headless mount: content scripts, ui.js, the panel page loading and its link connecting. */
export const MOUNT_WAIT_MS = 12_000;
/** Default time an op may take in the panel. */
export const OP_TIMEOUT_MS = 20_000;
/** How long an idle headless panel may take to say whether it still has work in progress. */
export const BUSY_QUERY_MS = 3000;
/** chrome.storage.session key of the plane's state (pinned tab, trace, headless mounts). */
export const CONTROL_STATE_KEY = 'reqlens:claude:control';
const PERSIST_DELAY_MS = 300;

export const FULL_MODE_REQUIRED =
  'This needs the Errors view full mode, which only the user can turn on (kineReqLens → Settings → Claude Code → Errors view → Full mode).';

/** Ops that send real requests (also need settings.claudeAllowSend). */
const SEND_OPS = new Set(['requests.resend', 'requests.ws_send']);
/** Ops that need settings.errorsFullMode (as the Errors view's full-mode buttons). */
const FULL_OPS = new Set(['errors.fix', 'errors.issue', 'errors.commit', 'errors.pull_request', 'errors.discard']);

export interface BrowserTab {
  id: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  width?: number;
  height?: number;
}

export interface BrowserWindow {
  id: number;
  state: string;
  focused: boolean;
}

/** The chrome.tabs / windows / scripting calls the plane needs (fakes in tests). */
export interface ControlBrowser {
  getTab(tabId: number): Promise<BrowserTab | null>;
  queryTabs(): Promise<BrowserTab[]>;
  getWindow(windowId: number): Promise<BrowserWindow | null>;
  /** The last focused normal window. */
  lastFocusedWindow(): Promise<number | null>;
  /** Make the tab active and its window focused (restores a minimized window). */
  activate(tabId: number): Promise<void>;
  reload(tabId: number): Promise<void>;
  /** Inject ui.js into the tab's top frame. */
  injectUi(tabId: number): Promise<void>;
  /** Inject hook.js + content.js into every frame (pages loaded before the extension). False when impossible. */
  injectContentScripts(tabId: number): Promise<boolean>;
  isRestrictedUrl(url: string): boolean;
}

export interface ControlDeps {
  settings(): Settings;
  /** Persist a settings patch (sanitized; `layout: "default"` resets the layout). */
  updateSettings(patch: SettingsPatch | (Omit<SettingsPatch, 'layout'> & { layout: 'default' })): Promise<Settings>;
  tabs: { get(tabId: number): TabState; isOpen(tabId: number): boolean; isHidden(tabId: number): boolean; openTabIds(): number[] };
  controller: {
    open(tabId: number, options: { hidden?: boolean }): Promise<OpenOutcome>;
    setState(tabId: number, patch: Partial<TabState>): Promise<TabState>;
  };
  links: {
    has(tabId: number): boolean;
    tabIds(): number[];
    waitFor(tabId: number, timeoutMs: number): Promise<boolean>;
    query(tabId: number, query: Extract<LinkQuery, { kind: 'control' }>, timeoutMs: number): Promise<unknown>;
  };
  activity: { defaultTab(openTabIds: readonly number[]): number | null; ordered(): number[] };
  sendToTop(tabId: number, message: TabMessage): Promise<unknown>;
  browser: ControlBrowser;
  /** The bridge's handler deps (entries and panel state are fetched like list_requests / get_request). */
  handlers: HandlerDeps;
  language?: {
    load(): Promise<void>;
    status(tabId: number, url?: string): LanguageStatus;
    setTab(tabId: number, value: string | null): Promise<LanguageStatus>;
    refresh(tabId: number): Promise<LanguageStatus>;
  };
  sources?: { resolve(frames: ResolveFrameRequest[], pageUrl: string): Promise<ResolvedFrame[]> };
  /** The trace changed (newest first). */
  onTrace?(trace: ControlTraceItem[]): void;
  session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  timers?: Timers;
  now?(): number;
  /** Idle time before a headless panel is removed (default HEADLESS_IDLE_MS; read at every arm). */
  headlessIdleMs?(): number;
  /** Wait between activating a tab and capturing it (rendering). */
  settleMs?: number;
}

interface HeadlessMount {
  /** Mounted by the plane (removed when idle); false: a closed overlay's existing panel. */
  ours: boolean;
  timer: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The call being run: lazily resolved tab, the panel and page helpers ops use. */
export class OpCall {
  private resolved: number | null = null;

  constructor(
    readonly plane: ControlPlane,
    readonly call: ValidControl,
    readonly settings: Settings,
  ) {}

  get args(): Record<string, unknown> {
    return this.call.args;
  }

  get deps(): ControlDeps {
    return this.plane.deps;
  }

  /** The target tab (resolved once; the op is counted in flight for it). */
  async tab(): Promise<number> {
    if (this.resolved !== null) return this.resolved;
    const tabId = await this.plane.resolveTab(this.call.tabId);
    this.resolved = tabId;
    this.plane.begin(tabId);
    return tabId;
  }

  /** The tab, when one was resolved (for the trace). */
  get tabId(): number | null {
    return this.resolved;
  }

  /** Run a panel op in the target tab, mounting a headless panel when the overlay is closed. */
  async panel<T>(op: PanelControlOp, timeoutMs = OP_TIMEOUT_MS): Promise<T> {
    const tabId = await this.tab();
    return this.plane.panelOp<T>(tabId, op, timeoutMs, true);
  }

  /** Like panel(), but null instead of mounting a panel. */
  async panelIfMounted<T>(op: PanelControlOp, timeoutMs = OP_TIMEOUT_MS): Promise<T | null> {
    const tabId = await this.tab();
    if (!this.plane.deps.links.has(tabId) && !this.plane.deps.tabs.isOpen(tabId)) return null;
    return this.plane.panelOp<T>(tabId, op, timeoutMs, false);
  }
}

export class ControlPlane {
  private readonly headless = new Map<number, HeadlessMount>();
  private readonly inflight = new Map<number, number>();
  private trace: ControlTraceItem[] = [];
  private pinned: number | null = null;
  private persistTimer: unknown = null;
  private readonly timers: Timers;

  constructor(readonly deps: ControlDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Restore the pinned tab, the trace and headless mounts after a worker restart. Never rejects. */
  async restore(): Promise<void> {
    if (!this.deps.session) return;
    try {
      const stored = (await this.deps.session.get(CONTROL_STATE_KEY))[CONTROL_STATE_KEY];
      if (!isRecord(stored)) return;
      if (typeof stored.pinned === 'number' && Number.isSafeInteger(stored.pinned)) this.pinned ??= stored.pinned;
      if (Array.isArray(stored.trace) && this.trace.length === 0) this.trace = stored.trace.filter(isTraceItem).slice(0, CONTROL_TRACE_MAX);
      if (Array.isArray(stored.headless)) {
        for (const tabId of stored.headless) if (typeof tabId === 'number' && !this.headless.has(tabId)) this.armHeadless(tabId, true);
      }
      this.deps.onTrace?.(this.trace);
    } catch {
      /* best effort */
    }
  }

  /** settings.claudeBridge and settings.claudeAllowControl. */
  allowed(): boolean {
    const s = this.deps.settings();
    return s.claudeBridge === true && s.claudeAllowControl === true;
  }

  /**
   * The tab's panel acts for Claude right now (an op in flight, or a headless panel mounted): the worker treats it like
   * an open overlay's (captures, initiators, replays).
   */
  controlled(tabId: number): boolean {
    return this.allowed() && ((this.inflight.get(tabId) ?? 0) > 0 || this.headless.has(tabId));
  }

  /** Recent calls, newest first. */
  traceItems(): ControlTraceItem[] {
    return this.trace.slice();
  }

  /** The tab Claude was told to use (overlay use_tab), when it still exists. */
  async defaultTab(): Promise<number | null> {
    if (this.pinned === null) return null;
    if (await this.deps.browser.getTab(this.pinned).catch(() => null)) return this.pinned;
    this.pinned = null;
    this.schedulePersist();
    return null;
  }

  pin(tabId: number | null): void {
    this.pinned = tabId;
    this.schedulePersist();
  }

  /**
   * Target tab of a control call: `tabId`, else the tab Claude was told to use, else the last tab whose overlay was
   * active, else the active tab of the last focused window.
   */
  async resolveTab(tabId: number | undefined): Promise<number> {
    const { browser } = this.deps;
    if (tabId !== undefined) {
      if (!(await browser.getTab(tabId).catch(() => null))) throw new BridgeError(`There is no tab ${tabId} — see inspect tabs`);
      return tabId;
    }
    const pinned = await this.defaultTab();
    if (pinned !== null) return pinned;
    const overlay = this.deps.activity.defaultTab(this.deps.tabs.openTabIds());
    if (overlay !== null && (await browser.getTab(overlay).catch(() => null))) return overlay;
    const windowId = await browser.lastFocusedWindow().catch(() => null);
    const tabs = await browser.queryTabs().catch(() => [] as BrowserTab[]);
    const active = tabs.find((t) => t.active && (windowId === null || t.windowId === windowId)) ?? tabs.find((t) => t.active);
    if (!active) throw new BridgeError('There is no browser tab to use — pass tabId (see inspect tabs)');
    return active.id;
  }

  // ---- runs -------------------------------------------------------------------------------------------

  /** Answer one `control` call (throws BridgeError / ParamError / LinkError with a message for Claude). */
  async run(params: ControlParams): Promise<ControlResult> {
    const call = validateControl(params);
    const key = `${call.tool}.${call.action}`;
    const settings = this.deps.settings();
    const op = new OpCall(this, call, settings);
    let ok = false;
    try {
      if (!this.allowed()) throw new BridgeError(CONTROL_DISABLED);
      if (SEND_OPS.has(key) && settings.claudeAllowSend !== true) throw new BridgeError(SEND_DISABLED);
      if (FULL_OPS.has(key) && settings.errorsFullMode !== true) throw new BridgeError(FULL_MODE_REQUIRED);
      const handler = OPS[key];
      if (!handler) throw new BridgeError(`${call.tool} ${call.action} is not available`);
      const result = await handler(op);
      ok = true;
      return { ...result, text: clipToolText(result.text, MAX_TOOL_TEXT_CHARS) };
    } finally {
      const tabId = op.tabId;
      if (tabId !== null) this.end(tabId);
      this.record({ at: this.now(), tool: call.tool, action: call.action, ...(tabId !== null ? { tabId } : {}), ok });
    }
  }

  /** Record a call of one of the read tools (list_requests, get_request…) in the trace. */
  recordCall(tool: string, tabId: number | undefined, ok: boolean): void {
    this.record({ at: this.now(), tool, ...(tabId !== undefined ? { tabId } : {}), ok });
  }

  /** Count a call of another tool (send_request on a closed overlay) as running in `tabId`. Returns the release. */
  hold(tabId: number): () => void {
    this.begin(tabId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.end(tabId);
    };
  }

  /** An op uses `tabId` (counted while it runs). */
  begin(tabId: number): void {
    this.inflight.set(tabId, (this.inflight.get(tabId) ?? 0) + 1);
  }

  end(tabId: number): void {
    const n = (this.inflight.get(tabId) ?? 1) - 1;
    if (n > 0) this.inflight.set(tabId, n);
    else this.inflight.delete(tabId);
    const mount = this.headless.get(tabId);
    if (mount) this.armHeadless(tabId, mount.ours);
  }

  private record(item: ControlTraceItem): void {
    this.trace = [item, ...this.trace].slice(0, CONTROL_TRACE_MAX);
    this.deps.onTrace?.(this.trace);
    this.schedulePersist();
  }

  // ---- panels ---------------------------------------------------------------------------------------

  /** Run an op in the tab's panel (mounting it headless when `mount` and the overlay is closed). */
  async panelOp<T>(tabId: number, op: PanelControlOp, timeoutMs: number, mount: boolean): Promise<T> {
    await this.ensurePanel(tabId, mount);
    try {
      return (await this.deps.links.query(tabId, { kind: 'control', op }, timeoutMs)) as T;
    } catch (err) {
      if (err instanceof LinkError && /did not answer in time/.test(err.message)) {
        throw new BridgeError(`The kineReqLens panel in tab ${tabId} did not finish "${op.op}" in time`);
      }
      throw err;
    }
  }

  /**
   * A panel of `tabId` is connected: the open overlay's, a closed overlay's still-mounted one, or one mounted here
   * invisibly (`mount`). Throws BridgeError with the reason otherwise.
   */
  async ensurePanel(tabId: number, mount = true): Promise<void> {
    const { links, tabs, browser } = this.deps;
    if (links.has(tabId)) {
      if (!tabs.isOpen(tabId) && !this.headless.has(tabId)) this.armHeadless(tabId, false);
      return;
    }
    if (tabs.isOpen(tabId)) {
      if (await links.waitFor(tabId, PANEL_WAIT_MS)) return;
      throw new BridgeError(`The kineReqLens overlay is open in tab ${tabId} but its panel did not connect — reload the page`);
    }
    if (!mount) throw new BridgeError(`The kineReqLens overlay is not open in tab ${tabId}`);
    const tab = await browser.getTab(tabId).catch(() => null);
    if (!tab) throw new BridgeError(`There is no tab ${tabId} — see inspect tabs`);
    if (tab.url && browser.isRestrictedUrl(tab.url)) throw new BridgeError(`kineReqLens cannot run on this page (${tab.url.split(/[?#]/)[0]!.slice(0, 120)})`);
    let ping = await this.ping(tabId);
    if (!ping) {
      if (!(await browser.injectContentScripts(tabId).catch(() => false))) {
        throw new BridgeError(`kineReqLens cannot run in tab ${tabId} (a browser page, the PDF viewer, or a file:// page without file access)`);
      }
      ping = await this.ping(tabId);
      if (!ping) throw new BridgeError(`kineReqLens did not start in tab ${tabId} — reload the page`);
    }
    const ours = !ping.hasUi;
    this.armHeadless(tabId, ours);
    if (ours) {
      try {
        await browser.injectUi(tabId);
      } catch (err) {
        this.forgetHeadless(tabId);
        throw new BridgeError(`Could not start the kineReqLens panel in tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!(await links.waitFor(tabId, MOUNT_WAIT_MS))) {
      throw new BridgeError(`The kineReqLens panel did not connect in tab ${tabId} (is the page still loading?) — try again, or reload the page`);
    }
  }

  private async ping(tabId: number): Promise<{ hasUi: boolean } | null> {
    try {
      const reply: unknown = await this.deps.sendToTop(tabId, { type: 'PING' });
      return isRecord(reply) && reply.ok === true ? { hasUi: reply.hasUi === true } : null;
    } catch {
      return null;
    }
  }

  /** (Re)start the idle timer of a headless panel. */
  private armHeadless(tabId: number, ours: boolean): void {
    const current = this.headless.get(tabId);
    if (current?.timer) this.timers.clearTimeout(current.timer);
    const mount: HeadlessMount = { ours: current?.ours ?? ours, timer: null };
    mount.timer = this.timers.setTimeout(() => void this.idle(tabId, mount), this.deps.headlessIdleMs?.() ?? HEADLESS_IDLE_MS);
    this.headless.set(tabId, mount);
    if (!current) this.schedulePersist();
  }

  private async idle(tabId: number, mount: HeadlessMount): Promise<void> {
    if (this.headless.get(tabId) !== mount) return;
    if ((this.inflight.get(tabId) ?? 0) > 0) {
      this.armHeadless(tabId, mount.ours);
      return;
    }
    // Not idle while the panel still works for Claude: a test request or an Errors view Claude run (an analysis or a
    // fix, bounded by the hub's run timeout) whose result only this panel receives.
    if (mount.ours && !this.deps.tabs.isOpen(tabId) && (await this.panelBusy(tabId))) {
      if (this.headless.get(tabId) === mount) this.armHeadless(tabId, mount.ours);
      return;
    }
    if (this.headless.get(tabId) !== mount) return;
    this.forgetHeadless(tabId);
    // The user opened the overlay meanwhile: it is theirs now. A closed overlay's own panel is left alone.
    if (this.deps.tabs.isOpen(tabId) || !mount.ours) return;
    await this.deps.sendToTop(tabId, { type: 'UI_UNMOUNT' }).catch(() => undefined);
  }

  /** The tab's panel has work in progress (test requests, Errors view Claude runs); false when it does not answer. */
  private async panelBusy(tabId: number): Promise<boolean> {
    if (!this.deps.links.has(tabId)) return false;
    try {
      const state = (await this.deps.links.query(tabId, { kind: 'control', op: { op: 'state' } }, BUSY_QUERY_MS)) as Partial<PanelStateResult> | null;
      return !!state && typeof state === 'object' && ((state.runningRuns ?? 0) > 0 || (state.claudeRuns ?? 0) > 0);
    } catch {
      return false;
    }
  }

  private forgetHeadless(tabId: number): void {
    const mount = this.headless.get(tabId);
    if (!mount) return;
    if (mount.timer) this.timers.clearTimeout(mount.timer);
    this.headless.delete(tabId);
    this.schedulePersist();
  }

  /** Is a headless panel (mounted for Claude) live in `tabId`? */
  isHeadless(tabId: number): boolean {
    return this.headless.has(tabId) && !this.deps.tabs.isOpen(tabId);
  }

  /** The overlay of `tabId` was opened by anyone: a headless panel there is the user's now. */
  onTabOpened(tabId: number): void {
    this.forgetHeadless(tabId);
  }

  onTabRemoved(tabId: number): void {
    this.forgetHeadless(tabId);
    if (this.pinned === tabId) this.pin(null);
  }

  /** The bridge or the control setting was turned off: headless panels go (theirs only). */
  onDisabled(): void {
    for (const [tabId, mount] of [...this.headless]) {
      this.forgetHeadless(tabId);
      if (mount.ours && !this.deps.tabs.isOpen(tabId)) void this.deps.sendToTop(tabId, { type: 'UI_UNMOUNT' }).catch(() => undefined);
    }
  }

  // ---- the page ---------------------------------------------------------------------------------------

  /**
   * The tab is on screen (active in its window, the window not minimized), or made so with `activate`. Screenshots
   * capture what the browser shows.
   */
  async ensureVisible(tabId: number, activate: boolean): Promise<void> {
    const { browser } = this.deps;
    const tab = await browser.getTab(tabId).catch(() => null);
    if (!tab) throw new BridgeError(`There is no tab ${tabId}`);
    const win = await browser.getWindow(tab.windowId).catch(() => null);
    const minimized = win?.state === 'minimized';
    if (tab.active && !minimized) return;
    if (!activate) {
      const why = !tab.active ? 'another tab is active in its window' : 'its window is minimized';
      throw new BridgeError(
        `Tab ${tabId} is not visible (${why}). Screenshots and page highlights need the tab on screen: pass activate: true to bring it to the front, or ask the user to switch to it.`,
      );
    }
    await browser.activate(tabId);
    await new Promise((resolve) => this.timers.setTimeout(() => resolve(undefined), this.deps.settleMs ?? 400));
    const after = await browser.getTab(tabId).catch(() => null);
    const afterWin = after ? await browser.getWindow(after.windowId).catch(() => null) : null;
    if (!after?.active || afterWin?.state === 'minimized') throw new BridgeError(`Could not bring tab ${tabId} to the front`);
  }

  /** Make the overlay of `tabId` visible (open it, or show an overlay open in the background). */
  async reveal(tabId: number): Promise<TabState> {
    const { tabs, controller } = this.deps;
    if (tabs.isOpen(tabId)) return tabs.isHidden(tabId) ? controller.setState(tabId, { hidden: false }) : tabs.get(tabId);
    const opened = await controller.open(tabId, { hidden: false });
    if (!opened.ok) throw new BridgeError(openFailure(tabId, opened.reason));
    this.onTabOpened(tabId);
    return opened.state;
  }

  // ---- persistence ------------------------------------------------------------------------------------

  private schedulePersist(): void {
    if (!this.deps.session || this.persistTimer !== null) return;
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null;
      const headless = [...this.headless].filter(([, m]) => m.ours).map(([tabId]) => tabId);
      void this.deps.session?.set({ [CONTROL_STATE_KEY]: { pinned: this.pinned, trace: this.trace, headless } }).catch(() => undefined);
    }, PERSIST_DELAY_MS);
  }
}

/** Why the overlay could not be opened, for Claude. */
export function openFailure(tabId: number, reason: Extract<OpenOutcome, { ok: false }>['reason']): string {
  switch (reason) {
    case 'gone':
      return `There is no tab ${tabId}`;
    case 'pdf':
      return `kineReqLens cannot run on the PDF viewer (tab ${tabId})`;
    case 'file-access':
      return `kineReqLens cannot run on this file:// page: the user must allow "Access to file URLs" for kineReqLens`;
    default:
      return `kineReqLens cannot run on this page (tab ${tabId}: a browser page or an extension gallery)`;
  }
}

function isTraceItem(value: unknown): value is ControlTraceItem {
  return isRecord(value) && typeof value.at === 'number' && typeof value.tool === 'string' && typeof value.ok === 'boolean';
}
