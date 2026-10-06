/**
 * Protocol between the overlay panel (panel.html — an extension page shown in a cross-origin iframe inside
 * the overlay host) and the in-page frame host (ui.js, the top frame's isolated world, next to content.js).
 *
 * Why an iframe: everything the overlay shows (cookies captured by webRequest, cross-origin subframe
 * traffic, Extension-mode responses) must stay out of the page's DOM. A closed shadow root does not hide
 * text from `window.find()` / `Selection.modify()`; a cross-origin frame does (docs/ARCHITECTURE.md §5).
 *
 * Transport: a chrome.runtime Port the panel opens with `chrome.tabs.connect(tabId, {frameId: 0, name})`
 * (sender = this extension, unforgeable). The host only serves the panel of the iframe it created: that
 * iframe's URL carries a random nonce in its fragment (`panel.html#<nonce>`), which the panel sends in its
 * 'hello'. The page cannot read it (the iframe sits in a closed shadow root and is cross-origin), so another
 * page embedding panel.html gets nothing.
 */
import type {
  CaptureInfo,
  ManualEntryInit,
  ReplayRequest,
  ReplayResult,
  RequestEntry,
  Settings,
  SettingsPatch,
  TabState,
} from './types';
import type { WsDelta, WsSendResult } from '../lib/ws';
import type { ShotCalls } from './screenshot-protocol';
import type { FindCalls, FindToPanel } from './find-protocol';
import type { ComponentLocateResult, ComponentQuery } from './initiator-protocol';

/** Port name of the panel connection. */
export const PANEL_PORT_NAME = 'reqlens-panel';
/** The panel page (web accessible so the page context can load it in an iframe). */
export const PANEL_PAGE = 'panel.html';
export const PANEL_PROTOCOL_VERSION = 1;

/** A region of the panel viewport (= the page viewport) that takes pointer events, in CSS px. */
export interface HitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Bridge methods the panel calls remotely (request / response). The `shot*` calls drive the screenshot tool's
 * page side (src/shared/screenshot-protocol.ts), the `find*` calls Find in page (src/shared/find-protocol.ts).
 */
export interface PanelCalls extends ShotCalls, FindCalls {
  clearEntries(): void;
  addManualEntry(init: ManualEntryInit): RequestEntry;
  setTabState(patch: Partial<TabState>): TabState;
  updateSettings(patch: SettingsPatch): Settings;
  replay(req: ReplayRequest): ReplayResult;
  abortReplay(runId: string): void;
  reloadPage(): void;
  setProtectedEntries(ids: string[]): void;
  /** WebSocket inspector: drop frames and closed connections. */
  wsClear(): void;
  /** WebSocket inspector: send a text message through the page's socket (explicit user click). */
  wsSend(wsId: string, text: string): WsSendResult;
  /** Initiator tab: find components by name in the page (optionally scroll to + highlight them). */
  locateComponents(query: ComponentQuery): ComponentLocateResult;
  /** Initiator tab: remove the component highlight. */
  clearHighlight(): void;
}

export type PanelCallName = keyof PanelCalls;

/**
 * UI state the panel hands to the host so a reloaded panel (iframe re-created: the page removed the host, or
 * a dialog it sat in) resumes with the user's drafts and runs. Opaque to the host except for its merge rule:
 * `shell` replaces, each `records[id]` / `runs[id]` replaces (null deletes). Runs (with their response bodies)
 * travel separately so editing a draft does not re-send them.
 */
export interface PanelUiState {
  shell: Record<string, unknown>;
  records: Record<string, unknown>;
  runs: Record<string, unknown>;
}

export interface PanelUiStatePatch {
  shell?: Record<string, unknown>;
  records?: Record<string, unknown | null>;
  runs?: Record<string, unknown | null>;
}

export type PanelToHost =
  /** First message: `nonce` is the fragment of the panel's URL. */
  | { t: 'hello'; v: number; nonce: string }
  | { t: 'call'; id: number; method: PanelCallName; args: unknown[] }
  /** Where the panel takes pointer events: rects, 'all' (dragging / resizing), or 'none'. */
  | { t: 'hit'; rects: HitRect[] | 'all' | 'none' }
  /** Changes of the resumable UI state (see PanelUiState for the merge rule). */
  | { t: 'ui-state'; patch: PanelUiStatePatch };

export type HostToPanel =
  | {
      t: 'state';
      version: string;
      tabState: TabState;
      settings: Settings;
      captureInfo: CaptureInfo;
      uiState: PanelUiState | null;
    }
  /** Entry changes since the last message (full snapshots; `remove` ids are gone). */
  | { t: 'entries'; upsert: RequestEntry[]; remove: string[] }
  /** The initial state and entries were sent: render. */
  | { t: 'ready' }
  /** WebSocket changes (the first one after 'state' is a reset snapshot; big deltas are chunked). */
  | { t: 'ws'; delta: WsDelta }
  | { t: 'tabState'; tabState: TabState }
  | { t: 'settings'; settings: Settings }
  | { t: 'captureInfo'; captureInfo: CaptureInfo }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  /** Find in page: scan results and the mini-bar's "Back to kineReqLens" (src/shared/find-protocol.ts). */
  | FindToPanel;
