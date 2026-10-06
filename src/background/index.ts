// kineReqLens service worker (background.js).
//
// MV3 lifecycle: the worker can be terminated at any time and restarted by the next event, so every
// listener is registered synchronously below, durable state lives in chrome.storage.session (TabStore),
// and events that arrive before that state is loaded are queued by a ReadyGate.
import type { BridgeStatus } from '../shared/claude-protocol';
import type { TabMessage } from '../shared/messages';
import { Badge } from './badge';
import { createCaptureQueue } from './capture';
import { ClaudeBridge, registerClaudeBridgeListeners } from './claude';
import { TabController } from './controller';
import { DnrManager } from './dnr';
import { FALLBACK_RESOURCE_TYPES, isSettingsChange, LanguageManager } from './language';
import { sessionPreserveBackend } from './preserve';
import { ReplayRunner } from './replay';
import { ReplayObserver } from './replay-observer';
import { createMessageRouter } from './router';
import { fetchTextCapped, SourceResolver } from './sources';
import { SettingsCache } from './settings';
import { TabStore } from './tabs';
import { KeepAlive, ReadyGate, isNoReceiverError } from './util';
import { RnBridge } from './rn';
import type { RnStatus } from '../shared/rn-protocol';
import { WebRequestCollector } from './webrequest';
import { registerWebRequestListeners } from './wr-listeners';

declare global {
  /** Exposed for E2E tests: toggles the overlay in a tab (same as clicking the toolbar button). */
  var __reqlensToggle: ((tab: chrome.tabs.Tab | number) => Promise<void>) | undefined;
  /** E2E build only: the Claude Code bridge status (as the overlay's Settings show it). */
  var __reqlensClaudeStatus: (() => BridgeStatus) | undefined;
  /** E2E build only: the React Native status (Settings → React Native). */
  var __reqlensRnStatus: (() => RnStatus) | undefined;
}

const extensionId = chrome.runtime.id;

// --- state ---------------------------------------------------------------------------------------

const tabs = new TabStore();
const settings = new SettingsCache();
// "Site language" (docs/ARCHITECTURE.md §11): tab / site Accept-Language overrides and their session rules.
const languages = new LanguageManager({
  dnr: chrome.declarativeNetRequest,
  session: chrome.storage.session,
  settings: () => settings.get(),
  reloadSettings: () => settings.load(),
  queryTabs: () => chrome.tabs.query({}),
  sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  resourceTypes: () => {
    const values = Object.values(chrome.declarativeNetRequest.ResourceType ?? {}) as string[];
    return values.length ? values : FALLBACK_RESOURCE_TYPES;
  },
  // `dnr` is declared below; this only runs once the worker started.
  rulesCleared: () => dnr.clearAll(),
});
// The language state is part of `ready`, so GET_TAB_STATE (which reports the tab's language) is not answered later
// than a toggle's TAB_STATE broadcast.
const ready: Promise<void> = Promise.all([tabs.load(), settings.load()]).then(() => languages.load());
const gate = new ReadyGate(ready);

const sendToFrame = (tabId: number, frameId: number, message: TabMessage): Promise<unknown> =>
  chrome.tabs.sendMessage(tabId, message, { frameId });

const collector = new WebRequestCollector({
  shouldCreate: (tabId) => tabs.isRecording(tabId),
  shouldTrack: (tabId) => tabs.isOpen(tabId),
  bodyCap: () => settings.requestBodyCap(),
  // The overlay's own panel frame (chrome-extension://<id>/panel.html) is not a request of the page.
  ignoreUrl: (url) => url.startsWith(`chrome-extension://${extensionId}/`),
  send: async (tabId, entries, target) => {
    const message: TabMessage = { type: 'WR_ENTRIES', entries };
    try {
      // Addressed to the document the entries belong to, so a navigation in between cannot deliver them to
      // the wrong page.
      if (target.documentId) await chrome.tabs.sendMessage(tabId, message, { documentId: target.documentId });
      else await sendToFrame(tabId, 0, message);
    } catch (err) {
      // The top frame is not listening (navigating, or no content script): GET_TAB_STATE returns the buffer.
      if (!isNoReceiverError(err)) console.debug('[kineReqLens] WR_ENTRIES not delivered', err);
    }
  },
});

const badge = new Badge();
const dnr = new DnrManager(extensionId);
const observer = new ReplayObserver(`chrome-extension://${extensionId}`);
const keepAlive = new KeepAlive(() => {
  chrome.runtime.getPlatformInfo().catch(() => undefined);
});
const replays = new ReplayRunner({ dnr, observer, keepAlive, sendToFrame });

// --- listeners (synchronous, top level) ----------------------------------------------------------

const webRequest = registerWebRequestListeners({
  onBeforeRequest: (d) => gate.run(() => collector.onBeforeRequest(d)),
  onSendHeaders: (d) => gate.run(() => collector.onSendHeaders(d)),
  onHeadersReceived: (d) => {
    // tabId -1 + our initiator = an extension-mode replay (Set-Cookie / manual-redirect headers). Needs no
    // tab state, so it is not gated: the replay's fetch is waiting for it right now.
    if (d.tabId !== -1) gate.run(() => collector.onHeadersReceived(d));
    else {
      try {
        observer.onHeadersReceived(d);
      } catch (err) {
        console.debug('[kineReqLens] replay observer', err);
      }
    }
  },
  onBeforeRedirect: (d) => gate.run(() => collector.onBeforeRedirect(d)),
  onCompleted: (d) => gate.run(() => collector.onCompleted(d)),
  onErrorOccurred: (d) => gate.run(() => collector.onErrorOccurred(d)),
});

const controller = new TabController({ ready, tabs, collector, badge, replays, webRequest });
// Assigned below, once the Claude Code bridge exists (the router and React Native ask it lazily).
let claudeRef: ClaudeBridge | null = null;
// Source maps of the Initiator tab and of Claude's `inspect initiator` (one cache).
const sources = new SourceResolver({ fetchText: fetchTextCapped, now: () => Date.now() });

chrome.runtime.onMessage.addListener(
  createMessageRouter({
    extensionId,
    ready,
    tabs,
    collector,
    badge,
    replays,
    controller,
    preserve: sessionPreserveBackend,
    capture: createCaptureQueue(),
    sources,
    language: languages,
    sendToFrame,
    // Panels acting for Claude Code's control tools (a closed overlay's panel, mounted invisibly) count as open.
    controlled: (tabId) => claudeRef?.controlled(tabId) ?? false,
  }),
);

chrome.action.onClicked.addListener((tab) => {
  void controller.toggle(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void controller.onTabRemoved(tabId);
  void languages.onTabRemoved(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void controller.onTabReplaced(addedTabId, removedTabId);
  void languages.onTabReplaced(addedTabId, removedTabId);
});

// A site language follows the tab's page host (its per-tab rule is added / dropped on navigation).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined) void ready.then(() => languages.load()).then(() => languages.onTabUrl(tabId, changeInfo.url));
});

chrome.storage.onChanged.addListener((changes, areaName) => settings.handleStorageChange(changes, areaName));
// After the SettingsCache took the change: settings.siteLanguages may have changed.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (isSettingsChange(changes, areaName)) void ready.then(() => languages.load()).then(() => languages.onSettingsChanged());
});

// React Native support (docs/ARCHITECTURE.md §9): its receiver runs in the same native host as the Claude Code
// bridge, so the bridge below owns the native port and hands the rn-* traffic to it.
const rn = new RnBridge({
  extensionId,
  settings: () => settings.get(),
  permission: () => claudeRef?.permissionGranted ?? false,
  host: () => (claudeRef ? { host: claudeRef.native.state.host, error: claudeRef.native.state.error } : { host: 'off' }),
  post: (message) => claudeRef?.native.sendRn(message) ?? false,
  replays,
  openTab: async (path) => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  },
  focusTab: async (tabId) => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true });
  },
});
chrome.runtime.onConnect.addListener((port) => {
  rn.accept(port);
});

// Claude Code bridge (docs/specs/v0.2.md §B.4). Registered after the settings listener above, so the bridge
// reads the new settings when the same storage change reaches it.
const claude = new ClaudeBridge({
  extensionId,
  extensionVersion: chrome.runtime.getManifest().version,
  ready,
  settings,
  tabs,
  sendToFrame,
  controller,
  language: languages,
  sources,
  rn: {
    wanted: () => rn.wanted(),
    onMessage: (message) => rn.onHostMessage(message),
    onConnected: () => rn.onConnected(),
    onPortClosed: () => rn.onPortClosed(),
    onChange: () => rn.onSettings(),
  },
});
claudeRef = claude;
registerClaudeBridgeListeners(claude);

// --- startup work --------------------------------------------------------------------------------

badge.init();
// Rules from a worker that died mid-replay must never linger.
void dnr.clearAll();
// storage.session (tab state, preserved logs with cookies and request bodies) is for the worker only:
// content scripts reach their own tab's log through PRESERVE_* messages (§2.4). TRUSTED_CONTEXTS is the
// default; setting it explicitly also undoes the wider level older versions of kineReqLens set.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((err: unknown) => {
  console.warn('[kineReqLens] storage.session access level', err);
});
// Stop listening to the whole browser's traffic while no tab has the overlay open.
void ready.then(() => webRequest.setActive(tabs.anyOpen()));
// Reconnect to the Claude Code hub after a worker (re)start when the bridge is enabled.
void claude.start();

globalThis.__reqlensToggle = (tab) => controller.toggle(tab);
if (__E2E__) globalThis.__reqlensClaudeStatus = () => claude.status();
if (__E2E__) globalThis.__reqlensRnStatus = () => rn.status();
