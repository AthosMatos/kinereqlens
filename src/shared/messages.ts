/**
 * Message protocol between the three execution contexts.
 *
 *  MAIN world (hook.js)  <-- MessagePort -->  content script (content.js, every frame)
 *  content script        <-- chrome.runtime / chrome.tabs messaging -->  service worker (background.js)
 *
 * SECURITY: messages coming from the MAIN world are untrusted *data* (the page can forge them).
 * They may only ever add/update captured entries or resolve a pending page-mode replay that the
 * content script itself started. They must never trigger extension-mode fetches, storage writes,
 * tab-state changes or any other privileged action.
 */
import type {
  HookConfig,
  HookRequestEnd,
  HookRequestStart,
  ReplayRequest,
  ReplayResult,
  RequestEntry,
  TabState,
} from './types';
import type { WsHookEvent } from '../lib/ws';
import type { CaptureVisibleResponse } from './screenshot-protocol';
import type { ComponentLocateResult, ResolveFrameRequest, ResolveInitiatorResponse } from './initiator-protocol';
import type { LanguageStatus } from './language';

// ---------------------------------------------------------------------------------------------
// MAIN world <-> content script
// ---------------------------------------------------------------------------------------------

/** Key used on window.postMessage handshake payloads: `{ [HANDSHAKE_KEY]: 'hello' | 'connect', v: PROTOCOL_VERSION }`. */
export const HANDSHAKE_KEY = '__reqlens__';
export const PROTOCOL_VERSION = 1;

/**
 * Handshake (window.postMessage, same window only, check `event.source === window`):
 *  1. hook.js on install posts `{ [HANDSHAKE_KEY]: 'hello', v }`.
 *  2. content.js posts `{ [HANDSHAKE_KEY]: 'connect', v }` with `[port2]` transferred, on start and
 *     whenever it sees a 'hello'. The hook adopts the most recent port (latest wins) and from then on
 *     all traffic uses that private MessagePort.
 */
export type HandshakeMessage = { [HANDSHAKE_KEY]: 'hello' | 'connect'; v: number };

export type HookToContent =
  | { t: 'start'; data: HookRequestStart }
  | { t: 'end'; data: HookRequestEnd }
  | { t: 'replay-result'; data: ReplayResult }
  /** WebSocket activity, batched ≤ WS_BATCH_MS (src/lib/ws.ts; validated with sanitizeWsEvents). */
  | { t: 'ws'; events: WsHookEvent[] }
  /** Answer to `{t:'ws-send'}`. */
  | { t: 'ws-send-result'; reqId: number; ok: boolean; error?: string }
  /** Answer to `{t:'components'}` (untrusted: sanitizeComponentLocateResult). */
  | { t: 'components-result'; reqId: number; data: ComponentLocateResult };

export type ContentToHook =
  /** 'on' flushes the hook's startup buffer and captures; 'off' drops the buffer and passes through. */
  | { t: 'mode'; mode: 'on' | 'off'; config: HookConfig }
  | { t: 'replay'; data: ReplayRequest }
  | { t: 'abort'; runId: string }
  /** Send a text message through the page's socket `wsId` (hook id; explicit user action in the overlay). */
  | { t: 'ws-send'; reqId: number; wsId: string; text: string }
  /**
   * Initiator tab: find mounted components by name (React / Preact / Vue tree walk) and measure them; `scroll`
   * brings the first instance into view first. Sent only for a panel request (src/shared/initiator-protocol.ts).
   */
  | { t: 'components'; reqId: number; names: string[]; scroll: boolean }
  /**
   * "Site language" (docs/ARCHITECTURE.md §11): the languages navigator.languages / the Intl default locale report
   * from now on, preferred first (canonical BCP-47 tags); null = the browser's own (no override).
   */
  | { t: 'lang'; languages: string[] | null };

// ---------------------------------------------------------------------------------------------
// content script -> service worker  (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------------------------

export interface GetTabStateResponse {
  tabId: number;
  frameId: number;
  tabState: TabState;
  /** webRequest entries buffered since the tab's last top-level navigation (top frame only, else []). */
  entries: RequestEntry[];
  /** "Site language" override that applies to this tab (Accept-Language value), null / absent = none. */
  language?: string | null;
}

export type RuntimeRequest =
  | { type: 'GET_TAB_STATE' } // -> GetTabStateResponse
  | { type: 'SET_TAB_STATE'; patch: Partial<TabState> } // -> TabState
  | { type: 'LOAD_UI' } // -> { ok: boolean; error?: string }   injects ui.js into the sender frame
  | { type: 'FRAME_CAPTURE'; msg: HookToContent } // subframe -> bg; relayed to frame 0 as FRAME_CAPTURE_RELAY. -> void
  | { type: 'REPLAY'; req: ReplayRequest } // -> ReplayResult (extension mode, or page mode in a subframe)
  | { type: 'ABORT_REPLAY'; runId: string; frameId: number; mode: ReplayRequest['mode'] } // -> { ok: boolean }
  | { type: 'SET_BADGE'; count: number } // -> void
  /** Top frame only: this tab's preserved log (the worker derives the storage key from the sender's tab). */
  | { type: 'PRESERVE_READ' } // -> unknown[]
  | { type: 'PRESERVE_WRITE'; entries: RequestEntry[] } // -> { ok: boolean }
  | { type: 'PRESERVE_CLEAR' } // -> { ok: boolean }
  /** From the overlay panel (panel.html in the overlay iframe): which tab it is in. -> { tabId: number } */
  | { type: 'PANEL_TAB' }
  /**
   * Screenshot tool: capture the visible area of the sender's tab (src/shared/screenshot-protocol.ts). From the
   * overlay panel page or the top frame's content script, overlay open, tab active. -> CaptureVisibleResponse
   */
  | { type: 'CAPTURE_VISIBLE_TAB' }
  /**
   * Initiator tab (from the overlay panel page only, overlay open): map stack frames to original sources through
   * the scripts' source maps (fetched by the worker, cached). -> ResolveInitiatorResponse
   */
  | { type: 'RESOLVE_INITIATOR'; frames: ResolveFrameRequest[]; pageUrl: string }
  /**
   * "Site language" (from the overlay panel page only): this tab's language state. `refresh` re-reads the stored
   * settings first (after the panel wrote settings.siteLanguages), so the DNR rules are in place when it answers.
   * -> LanguageStatus
   */
  | { type: 'LANGUAGE_STATE'; refresh?: boolean }
  /** "Site language" (overlay panel page only): set (or clear, null) this tab's own override. -> LanguageStatus */
  | { type: 'LANGUAGE_SET_TAB'; value: string | null };

export type RuntimeResponse<T extends RuntimeRequest['type']> = T extends 'GET_TAB_STATE'
  ? GetTabStateResponse
  : T extends 'SET_TAB_STATE'
    ? TabState
    : T extends 'LOAD_UI'
      ? { ok: boolean; error?: string }
      : T extends 'REPLAY'
        ? ReplayResult
        : T extends 'ABORT_REPLAY' | 'PRESERVE_WRITE' | 'PRESERVE_CLEAR'
          ? { ok: boolean }
          : T extends 'PRESERVE_READ'
            ? unknown[]
            : T extends 'PANEL_TAB'
              ? { tabId: number } | null
              : T extends 'CAPTURE_VISIBLE_TAB'
                ? CaptureVisibleResponse
                : T extends 'RESOLVE_INITIATOR'
                  ? ResolveInitiatorResponse
                  : T extends 'LANGUAGE_STATE' | 'LANGUAGE_SET_TAB'
                    ? LanguageStatus
                    : void;

// ---------------------------------------------------------------------------------------------
// service worker -> content script  (chrome.tabs.sendMessage)
// ---------------------------------------------------------------------------------------------

export type TabMessage =
  /** Sent to all frames of the tab whenever the state changes (toggle, pause, preserve log). */
  | { type: 'TAB_STATE'; tabState: TabState }
  /** Top frame only: upsert full snapshots (idempotent) of webRequest entries. */
  | { type: 'WR_ENTRIES'; entries: RequestEntry[] }
  /** Top frame only: a hook message captured in a subframe. */
  | { type: 'FRAME_CAPTURE_RELAY'; frameId: number; frameUrl?: string; msg: HookToContent }
  /** Specific frame: run a page-mode replay through that frame's hook. -> ReplayResult */
  | { type: 'REPLAY_IN_PAGE'; req: ReplayRequest }
  | { type: 'ABORT_IN_PAGE'; runId: string }
  /** -> { ok: true; hasUi: boolean } — used to detect whether content.js is present. */
  | { type: 'PING' }
  /**
   * Top frame only (Claude Code control plane): remove the UI of a closed overlay — a panel mounted invisibly for
   * Claude's commands that went idle. Ignored while the overlay is open. -> { ok: true; unmounted: boolean }
   */
  | { type: 'UI_UNMOUNT' }
  /**
   * Top frame only (Claude Code bridge, docs/specs/v0.2.md §B.4): summaries of the captured entries, oldest
   * first; `countOnly` leaves `rows` empty. -> BridgeListResponse
   */
  | { type: 'BRIDGE_LIST'; countOnly?: boolean }
  /** Top frame only (Claude Code bridge): one captured entry. -> BridgeEntryResponse */
  | { type: 'BRIDGE_ENTRY'; id: string }
  /** All frames: the "Site language" override of the tab changed (Accept-Language value, null = none). */
  | { type: 'LANGUAGE'; value: string | null };

/** One captured entry as listed for Claude Code (BRIDGE_LIST); the service worker adds the panel's flags. */
export interface BridgeListRow {
  id: string;
  source: RequestEntry['source'];
  method: string;
  /** Clipped to a few KB (data: URLs can be huge). */
  url: string;
  kind: RequestEntry['kind'];
  state: RequestEntry['state'];
  status?: number;
  startTime: number;
  durationMs?: number;
  /** Response body bytes when known (captured body size, else Content-Length). */
  size?: number;
}

export interface BridgeListResponse {
  pageUrl: string;
  count: number;
  rows: BridgeListRow[];
}

export interface BridgeEntryResponse {
  pageUrl: string;
  entry: RequestEntry | null;
}
