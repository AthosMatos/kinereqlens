// chrome.runtime.onMessage routing. Only this extension's content scripts (sender.id === runtime id, with
// a tab) are served; every payload is validated before it can cause a privileged action.
import { DEFAULT_TAB_STATE } from '../shared/constants';
import type { GetTabStateResponse, HookToContent, RuntimeRequest, TabMessage } from '../shared/messages';
import { PANEL_PAGE } from '../shared/panel-protocol';
import type { ReplayResult, TabState } from '../shared/types';
import type { CaptureVisibleResponse } from '../shared/screenshot-protocol';
import type { ResolveInitiatorResponse } from '../shared/initiator-protocol';
import type { SourceResolver } from './sources';
import { sanitizeResolveFrames } from './sources';
import type { Badge } from './badge';
import type { CaptureQueue } from './capture';
import type { PreserveBackend } from './preserve';
import type { TabController } from './controller';
import { errorResult } from './replay';
import type { ReplayRunner } from './replay';
import { validateReplayRequest } from './replay-validate';
import { sanitizeTabStatePatch } from './tabs';
import type { TabStore } from './tabs';
import { errorMessage, isRecord } from './util';
import type { LanguageManager } from './language';
import { withAcceptLanguage } from './language';
import type { LanguageStatus } from '../shared/language';
import { effectiveLanguage } from '../shared/language';
import type { WebRequestCollector } from './webrequest';

/** Where a message came from, once the sender passed validation. */
export interface SenderContext {
  tabId: number;
  frameId: number;
  documentId?: string;
  url?: string;
}

const REQUEST_TYPES = new Set<RuntimeRequest['type']>([
  'GET_TAB_STATE',
  'SET_TAB_STATE',
  'LOAD_UI',
  'FRAME_CAPTURE',
  'REPLAY',
  'ABORT_REPLAY',
  'SET_BADGE',
  'PRESERVE_READ',
  'PRESERVE_WRITE',
  'PRESERVE_CLEAR',
  'PANEL_TAB',
  'CAPTURE_VISIBLE_TAB',
  'RESOLVE_INITIATOR',
  'LANGUAGE_STATE',
  'LANGUAGE_SET_TAB',
]);

/** Accept only content scripts of this extension running in a tab. */
export function senderContext(sender: chrome.runtime.MessageSender, extensionId: string): SenderContext | null {
  if (sender.id !== extensionId) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return null;
  const frameId = sender.frameId;
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId < 0) return null;
  const ctx: SenderContext = { tabId, frameId };
  if (typeof sender.documentId === 'string') ctx.documentId = sender.documentId;
  if (typeof sender.url === 'string') ctx.url = sender.url;
  return ctx;
}

/** Narrow an incoming message to a known RuntimeRequest type (fields are validated per handler). */
export function asRuntimeRequest(message: unknown): (Record<string, unknown> & { type: RuntimeRequest['type'] }) | null {
  if (!isRecord(message) || typeof message.type !== 'string') return null;
  return REQUEST_TYPES.has(message.type as RuntimeRequest['type'])
    ? (message as Record<string, unknown> & { type: RuntimeRequest['type'] })
    : null;
}

/** Hook messages a subframe may relay to the top frame ('replay-result' travels via sendResponse only). */
export function isRelayableHookMessage(value: unknown): value is HookToContent {
  if (!isRecord(value)) return false;
  // WebSocket batches (validated again by the top frame, src/lib/ws.ts sanitizeWsEvents).
  if (value.t === 'ws') return Array.isArray(value.events);
  return (value.t === 'start' || value.t === 'end') && isRecord(value.data);
}

export interface RouterDeps {
  extensionId: string;
  ready: Promise<void>;
  tabs: TabStore;
  collector: WebRequestCollector;
  badge: Badge;
  replays: ReplayRunner;
  controller: TabController;
  preserve: PreserveBackend;
  /** Screenshot captures (CAPTURE_VISIBLE_TAB); without it the message is refused. */
  capture?: Pick<CaptureQueue, 'capture'>;
  /** Source-map resolution for the Initiator tab (RESOLVE_INITIATOR); without it the message is refused. */
  sources?: Pick<SourceResolver, 'resolve'>;
  /** "Site language" state (GET_TAB_STATE language, LANGUAGE_*, extension-mode Accept-Language); optional. */
  language?: Pick<LanguageManager, 'load' | 'status' | 'valueFor' | 'setTab' | 'refresh' | 'onTabUrl'>;
  /**
   * The tab's panel is acting for Claude Code (src/background/claude/control/plane.ts `controlled`: a control op in
   * flight, or a panel mounted invisibly for Claude, with "Let Claude control kineReqLens" on): it may capture the tab,
   * resolve initiators and replay like an open overlay's panel.
   */
  controlled?(tabId: number): boolean;
  sendToFrame(tabId: number, frameId: number, message: TabMessage): Promise<unknown>;
}

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean;

/** Build the chrome.runtime.onMessage listener. */
export function createMessageRouter(deps: RouterDeps): Listener {
  return (message, sender, sendResponse) => {
    const ctx = senderContext(sender, deps.extensionId);
    const request = ctx ? asRuntimeRequest(message) : null;
    if (!ctx || !request) return false;
    handle(deps, request, ctx).then(sendResponse, (err: unknown) => {
      console.error('[kineReqLens] message handler failed', request.type, err);
      sendResponse(fallbackResponse(deps, request, ctx, err));
    });
    return true;
  };
}

async function handle(deps: RouterDeps, msg: Record<string, unknown> & { type: RuntimeRequest['type'] }, ctx: SenderContext): Promise<unknown> {
  await deps.ready;
  switch (msg.type) {
    case 'GET_TAB_STATE':
      return getTabState(deps, ctx, await languageOf(deps, ctx));
    case 'SET_TAB_STATE': {
      const patch = sanitizeTabStatePatch(msg.patch);
      return patch ? deps.controller.setState(ctx.tabId, patch) : deps.tabs.get(ctx.tabId);
    }
    case 'LOAD_UI':
      return loadUi(ctx);
    case 'FRAME_CAPTURE':
      relayFrameCapture(deps, ctx, msg.msg);
      return undefined;
    case 'REPLAY':
      return replay(deps, ctx, msg.req);
    case 'ABORT_REPLAY':
      return abortReplay(deps, ctx, msg);
    case 'SET_BADGE':
      setBadge(deps, ctx, msg.count);
      return undefined;
    // The preserved log of the sender's own tab only, and only for its top frame.
    case 'PRESERVE_READ':
      return ctx.frameId === 0 ? deps.preserve.read(ctx.tabId) : [];
    case 'PRESERVE_WRITE':
      return { ok: ctx.frameId === 0 && (await deps.preserve.write(ctx.tabId, msg.entries)) };
    case 'PRESERVE_CLEAR':
      return { ok: ctx.frameId === 0 && (await deps.preserve.clear(ctx.tabId)) };
    case 'PANEL_TAB':
      // Only our own panel page (the overlay iframe); it then connects to the tab's top frame itself.
      return isPanelPage(ctx.url, deps.extensionId) ? { tabId: ctx.tabId } : null;
    case 'CAPTURE_VISIBLE_TAB':
      return captureVisibleTab(deps, ctx);
    case 'RESOLVE_INITIATOR':
      return resolveInitiator(deps, ctx, msg);
    case 'LANGUAGE_STATE':
    case 'LANGUAGE_SET_TAB':
      return languageRequest(deps, ctx, msg);
  }
}

const NO_LANGUAGE: LanguageStatus = effectiveLanguage(null, {}, null);

/** "Site language" requests: only from our overlay panel page in the tab (it acts on its own tab). */
async function languageRequest(deps: RouterDeps, ctx: SenderContext, msg: Record<string, unknown>): Promise<LanguageStatus> {
  const language = deps.language;
  if (!language || !isPanelPage(ctx.url, deps.extensionId)) return { ...NO_LANGUAGE };
  await language.load();
  if (msg.type === 'LANGUAGE_SET_TAB') {
    const value = msg.value === null ? null : typeof msg.value === 'string' ? msg.value.slice(0, 1000) : undefined;
    if (value === undefined) return language.status(ctx.tabId);
    return language.setTab(ctx.tabId, value);
  }
  return msg.refresh === true ? language.refresh(ctx.tabId) : language.status(ctx.tabId);
}

/** Source-map resolution: only for our overlay panel page, only while the overlay is open in that tab. */
async function resolveInitiator(deps: RouterDeps, ctx: SenderContext, msg: Record<string, unknown>): Promise<ResolveInitiatorResponse> {
  if (!deps.sources) return { ok: false, error: 'Source maps are not available' };
  if (!isPanelPage(ctx.url, deps.extensionId)) return { ok: false, error: 'Only the kineReqLens overlay can resolve stacks' };
  if (!overlayActive(deps, ctx.tabId)) return { ok: false, error: 'Open the kineReqLens overlay first' };
  const frames = sanitizeResolveFrames(msg.frames);
  if (!frames) return { ok: false, error: 'Invalid frames' };
  const pageUrl = typeof msg.pageUrl === 'string' ? msg.pageUrl.slice(0, 64 * 1024) : '';
  return { ok: true, frames: await deps.sources.resolve(frames, pageUrl) };
}

/**
 * Screenshot of the sender's tab: only for our overlay panel page or the top frame's content script (subframe
 * content scripts never take part), only while the overlay is open in that tab.
 */
async function captureVisibleTab(deps: RouterDeps, ctx: SenderContext): Promise<CaptureVisibleResponse> {
  if (!deps.capture) return { ok: false, error: 'Screenshots are not available' };
  if (!isPanelPage(ctx.url, deps.extensionId) && ctx.frameId !== 0) return { ok: false, error: 'Screenshots can only be taken from the kineReqLens overlay' };
  if (!overlayActive(deps, ctx.tabId)) return { ok: false, error: 'Open the kineReqLens overlay to take screenshots' };
  return deps.capture.capture(ctx.tabId);
}

/** The overlay is open in the tab, or its panel acts for Claude Code (RouterDeps.controlled). */
function overlayActive(deps: RouterDeps, tabId: number): boolean {
  return deps.tabs.isOpen(tabId) || deps.controlled?.(tabId) === true;
}

/** URL of this extension's overlay panel page. */
export function isPanelPage(url: string | undefined, extensionId: string): boolean {
  if (typeof url !== 'string') return false;
  const bare = url.split('#')[0]!.split('?')[0];
  return bare === `chrome-extension://${extensionId}/${PANEL_PAGE}`;
}

/** The language override for a frame asking GET_TAB_STATE (a top frame also tells the worker the tab's page). */
async function languageOf(deps: RouterDeps, ctx: SenderContext): Promise<string | null> {
  const language = deps.language;
  if (!language) return null;
  try {
    await language.load();
    if (ctx.frameId !== 0) return language.valueFor(ctx.tabId);
    language.onTabUrl(ctx.tabId, ctx.url);
    return language.status(ctx.tabId, ctx.url).effective;
  } catch {
    return null;
  }
}

function getTabState(deps: RouterDeps, ctx: SenderContext, language: string | null = null): GetTabStateResponse {
  // frameId 0 is the tab's primary main frame. A prerendering main frame reports another frame id (and asks
  // again once it is activated), so it never takes over the tab's webRequest buffer while the visible page
  // is still the previous one.
  const top = ctx.frameId === 0;
  const tabState = deps.tabs.get(ctx.tabId);
  let entries: GetTabStateResponse['entries'] = [];
  if (top) {
    // The (new) top document is listening: it owns the tab's webRequest buffer from now on, and it is
    // evidently scriptable.
    entries = ctx.documentId
      ? deps.collector.attachDocument(ctx.tabId, ctx.documentId, {
          ...(ctx.url !== undefined ? { url: ctx.url } : {}),
          preserveLog: tabState.preserveLog,
        })
      : deps.collector.getEntries(ctx.tabId);
    deps.badge.clearRestricted(ctx.tabId);
  }
  const response: GetTabStateResponse = { tabId: ctx.tabId, frameId: ctx.frameId, tabState, entries };
  if (language) response.language = language;
  return response;
}

async function loadUi(ctx: SenderContext): Promise<{ ok: boolean; error?: string }> {
  if (ctx.frameId !== 0) return { ok: false, error: 'The overlay can only be loaded in the top frame' };
  try {
    await chrome.scripting.executeScript({
      // Target the exact document that asked, so a navigation in between cannot receive the UI.
      target: ctx.documentId ? { tabId: ctx.tabId, documentIds: [ctx.documentId] } : { tabId: ctx.tabId, frameIds: [0] },
      files: ['ui.js'],
      injectImmediately: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function relayFrameCapture(deps: RouterDeps, ctx: SenderContext, payload: unknown): void {
  if (ctx.frameId === 0 || !deps.tabs.isOpen(ctx.tabId) || !isRelayableHookMessage(payload)) return;
  const relay: TabMessage = { type: 'FRAME_CAPTURE_RELAY', frameId: ctx.frameId, msg: payload };
  if (ctx.url !== undefined) relay.frameUrl = ctx.url;
  deps.sendToFrame(ctx.tabId, 0, relay).catch(() => {
    // Top frame not listening (navigating); the capture is lost like any request of a dying page.
  });
}

async function replay(deps: RouterDeps, ctx: SenderContext, payload: unknown): Promise<ReplayResult> {
  const runId = isRecord(payload) && typeof payload.runId === 'string' ? payload.runId.slice(0, 200) : '';
  const url = isRecord(payload) && typeof payload.url === 'string' ? payload.url.slice(0, 2048) : '';
  if (ctx.frameId !== 0) return errorResult(runId, url, Date.now(), 'Replays can only be started from the kineReqLens overlay');
  if (!overlayActive(deps, ctx.tabId)) return errorResult(runId, url, Date.now(), 'Open the kineReqLens overlay to send requests');
  const validation = validateReplayRequest(payload);
  if (!validation.ok) return errorResult(runId, url, Date.now(), validation.error);
  let req = validation.req;
  // Page-mode replays get the tab's language through its DNR rule; the worker's own fetch (tabId -1) does not.
  if (req.mode === 'extension' && deps.language) {
    const value = deps.language.valueFor(ctx.tabId);
    if (value) req = { ...req, headers: withAcceptLanguage(req.headers, value) };
  }
  return deps.replays.run(ctx.tabId, req, validation.invalidHeaders);
}

async function abortReplay(deps: RouterDeps, ctx: SenderContext, msg: Record<string, unknown>): Promise<{ ok: boolean }> {
  const { runId, frameId, mode } = msg;
  if (typeof runId !== 'string' || runId === '') return { ok: false };
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId < 0) return { ok: false };
  if (mode !== 'page' && mode !== 'extension') return { ok: false };
  return { ok: await deps.replays.abort(ctx.tabId, runId, frameId, mode) };
}

function setBadge(deps: RouterDeps, ctx: SenderContext, count: unknown): void {
  if (ctx.frameId !== 0 || typeof count !== 'number' || !Number.isFinite(count)) return;
  if (deps.tabs.isOpen(ctx.tabId)) deps.badge.setCount(ctx.tabId, count);
  else deps.badge.clear(ctx.tabId);
}

/** Response sent when a handler throws, so callers awaiting a typed answer still get one. */
function fallbackResponse(deps: RouterDeps, msg: Record<string, unknown> & { type: RuntimeRequest['type'] }, ctx: SenderContext, err: unknown): unknown {
  const tabState = (): TabState => (deps.tabs.isLoaded ? deps.tabs.get(ctx.tabId) : { ...DEFAULT_TAB_STATE });
  switch (msg.type) {
    case 'GET_TAB_STATE':
      return { tabId: ctx.tabId, frameId: ctx.frameId, tabState: tabState(), entries: [] } satisfies GetTabStateResponse;
    case 'SET_TAB_STATE':
      return tabState();
    case 'LOAD_UI':
      return { ok: false, error: errorMessage(err) };
    case 'REPLAY': {
      const req = isRecord(msg.req) ? msg.req : {};
      return errorResult(typeof req.runId === 'string' ? req.runId : '', typeof req.url === 'string' ? req.url : '', Date.now(), errorMessage(err));
    }
    case 'ABORT_REPLAY':
    case 'PRESERVE_WRITE':
    case 'PRESERVE_CLEAR':
      return { ok: false };
    case 'PRESERVE_READ':
      return [];
    case 'PANEL_TAB':
      return null;
    case 'CAPTURE_VISIBLE_TAB':
      return { ok: false, error: errorMessage(err) } satisfies CaptureVisibleResponse;
    case 'RESOLVE_INITIATOR':
      return { ok: false, error: errorMessage(err) } satisfies ResolveInitiatorResponse;
    case 'LANGUAGE_STATE':
    case 'LANGUAGE_SET_TAB':
      return { ...NO_LANGUAGE };
    default:
      return undefined;
  }
}
