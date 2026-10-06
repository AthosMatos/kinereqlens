import type { PromptTarget, TypeFormat } from './claude-protocol';
import type { WsBridge } from '../lib/ws';
import type { ComponentLocateResult, ComponentQuery } from './initiator-protocol';

/**
 * Shared data contracts for every kineReqLens module.
 *
 * RULE: every value that crosses a messaging boundary (MAIN world <-> content script <-> service worker)
 * must be JSON-safe: no ArrayBuffer, Map, Set, Date, undefined-in-arrays, functions or class instances.
 * Binary data travels as base64 strings.
 */

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** One header line. Names keep the casing they were captured with; compare case-insensitively. */
export interface HeaderPair {
  name: string;
  value: string;
}

/** A body exactly as captured, in a JSON-safe form. */
export type SerializedBody =
  /** UTF-8 text. `size` is the full byte length before truncation. */
  | { kind: 'text'; text: string; size: number; truncated?: boolean }
  /** Binary (or non-UTF-8) bytes. `size` is the full byte length before truncation. */
  | { kind: 'base64'; base64: string; size: number; truncated?: boolean }
  /** A FormData object passed to fetch/XHR/sendBeacon (multipart; the browser picks the boundary). */
  | { kind: 'formData'; entries: FormDataEntryInfo[] }
  /** Form fields pre-parsed by chrome.webRequest (urlencoded or multipart; file contents unknown). */
  | { kind: 'formFields'; fields: Array<{ name: string; value: string }> }
  /** Body exists but could not be captured (stream, too large to read, opaque, ...). */
  | { kind: 'unavailable'; reason: string };

export type FormDataEntryInfo =
  /** `truncated`: the value was cut at the request body cap (a verbatim resend is lossy). */
  | { name: string; type: 'text'; value: string; truncated?: boolean }
  | {
      name: string;
      type: 'file';
      fileName: string;
      mime: string;
      size: number;
      /** File content, absent when larger than the capture cap. */
      base64?: string;
      truncated?: boolean;
    };

/** A body ready to be sent on the wire. */
export type WireBody = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'base64'; base64: string };

// ---------------------------------------------------------------------------------------------
// Captured requests
// ---------------------------------------------------------------------------------------------

export type EntryKind =
  | 'fetch'
  | 'xhr'
  | 'beacon'
  | 'document'
  | 'subdocument'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'media'
  | 'websocket'
  | 'ping'
  | 'manual'
  | 'other';

export type EntryState = 'pending' | 'done' | 'error' | 'aborted';

/** Network-level details observed by chrome.webRequest (merged into hook entries when matched). */
export interface WireInfo {
  requestId: string;
  /** Headers actually sent by the browser (cookies, UA, sec-*, ...). */
  requestHeaders?: HeaderPair[];
  statusCode?: number;
  /** Full response headers including ones hidden from page JS (e.g. Set-Cookie). */
  responseHeaders?: HeaderPair[];
  fromCache?: boolean;
  ip?: string;
  /** chrome.webRequest ResourceType, e.g. "xmlhttprequest". */
  type?: string;
}

/** One captured request as stored in the page's store and rendered by the UI. */
export interface RequestEntry {
  /** Unique within the store: `h:${frameId}:${hookId}` | `w:${requestId}` | `m:${uid}` | `r:${originalId}` (restored). */
  id: string;
  source: 'hook' | 'webRequest' | 'manual';
  kind: EntryKind;
  /** 0 = top frame. Page-mode replays execute in this frame. */
  frameId: number;
  frameUrl?: string;
  /** Top-level page URL when the request was captured (used to group a preserved log). */
  pageUrl: string;
  /** Method as sent (fetch upper-cases only DELETE/GET/HEAD/OPTIONS/POST/PUT). */
  method: string;
  /** Absolute request URL as initiated (before redirects). */
  url: string;
  /** Hook: headers set by page script. webRequest: headers actually sent. Manual: user-defined. */
  requestHeaders: HeaderPair[];
  requestBody: SerializedBody | null;
  /** Effective Content-Type of the request body (explicit header, else the browser-implied one). */
  requestContentType: string | null;
  /** Epoch milliseconds. */
  startTime: number;
  endTime?: number;
  state: EntryState;
  status?: number;
  statusText?: string;
  responseHeaders?: HeaderPair[];
  /** Only available for hook-captured fetch/XHR. */
  responseBody?: SerializedBody | null;
  /** Final URL after redirects. */
  responseUrl?: string;
  redirected?: boolean;
  error?: string;
  fromCache?: boolean;
  wire?: WireInfo;
  initiator?: string;
  /**
   * fetch init / XHR options the page used (hook captures only). Seeds the replay defaults, e.g. credentials:
   * a cross-origin `fetch()` with the default 'same-origin' must not be replayed with 'include'.
   */
  requestOptions?: HookRequestStart['options'];
  /**
   * Call stack (frame lines, V8 format) when the page made the request: hook captures made while capture was on
   * (src/lib/stack.ts; ≤ 40 frames / 8 KB). Parsed and source-mapped by the Initiator tab.
   */
  initiatorStack?: string;
  /** True when restored from a preserved log of a previous page load in this tab. */
  restored?: boolean;
}

// ---------------------------------------------------------------------------------------------
// MAIN-world hook payloads
// ---------------------------------------------------------------------------------------------

export interface HookRequestStart {
  /** Unique per frame (the store prefixes it with the frame id). */
  hookId: string;
  kind: 'fetch' | 'xhr' | 'beacon';
  method: string;
  url: string;
  headers: HeaderPair[];
  body: SerializedBody | null;
  contentType: string | null;
  startTime: number;
  frameUrl: string;
  /** Relevant fetch init / XHR options, informational. */
  options?: {
    credentials?: string;
    mode?: string;
    cache?: string;
    redirect?: string;
    referrerPolicy?: string;
    keepalive?: boolean;
    withCredentials?: boolean;
  };
  /** Call stack of the page code that made the request (frames only, kineReqLens' wrappers removed). */
  initiatorStack?: string;
}

export interface HookRequestEnd {
  hookId: string;
  state: 'done' | 'error' | 'aborted';
  status?: number;
  statusText?: string;
  headers?: HeaderPair[];
  body?: SerializedBody | null;
  responseUrl?: string;
  redirected?: boolean;
  /** Response.type for fetch: basic | cors | opaque | opaqueredirect | error. */
  responseType?: string;
  endTime: number;
  error?: string;
}

export interface HookConfig {
  captureResponseBodies: boolean;
  requestBodyCap: number;
  responseBodyCap: number;
}

// ---------------------------------------------------------------------------------------------
// Replay (test-triggered requests)
// ---------------------------------------------------------------------------------------------

/** page = run fetch inside the page (same cookies/origin/CORS as the app); extension = service worker fetch (no CORS, forbidden headers via DNR). */
export type ReplayMode = 'page' | 'extension';

export interface ReplayRequest {
  runId: string;
  entryId: string;
  mode: ReplayMode;
  /** Frame to run in for page mode. */
  frameId: number;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: WireBody;
  credentials: 'include' | 'same-origin' | 'omit';
  redirect: 'follow' | 'manual' | 'error';
  timeoutMs: number;
  responseBodyCap: number;
}

export interface ReplayTiming {
  /** Epoch ms when the request was dispatched. */
  start: number;
  /** Epoch ms when response headers arrived. */
  headers?: number;
  /** Epoch ms when the body finished (or the request failed). */
  end: number;
}

export interface ReplayResult {
  runId: string;
  /** True when a response (any status) was received. False on network error / abort / timeout. */
  ok: boolean;
  status: number;
  statusText: string;
  headers: HeaderPair[];
  body: SerializedBody | null;
  /** Final URL. */
  url: string;
  redirected: boolean;
  /** Response.type: basic | cors | opaque | opaqueredirect | error. */
  type?: string;
  timing: ReplayTiming;
  /** Bytes of (decoded) body read. */
  size: number;
  error?: string;
  /** Human hint for the error, e.g. "Blocked by CORS in Page mode — try Extension mode". */
  errorHint?: string;
  aborted?: boolean;
  timedOut?: boolean;
  /** Forbidden header names applied through a declarativeNetRequest session rule (extension mode). */
  appliedViaDnr?: string[];
  /** Header names that could not be sent (forbidden in page mode, invalid, ...). */
  droppedHeaders?: string[];
}

export type RunState = 'running' | 'done' | 'error' | 'aborted';

export interface TestRun {
  runId: string;
  entryId: string;
  request: ReplayRequest;
  startedAt: number;
  state: RunState;
  result?: ReplayResult;
  /** Who started the run: the user (Send) or Claude (the MCP `send_request` tool). Absent = user. */
  origin?: 'user' | 'claude';
}

/** Normalized response shape rendered by the response viewer (captured original or test result). */
export interface ResponseData {
  state: EntryState | 'running';
  status?: number;
  statusText?: string;
  headers: HeaderPair[];
  body: SerializedBody | null;
  url?: string;
  redirected?: boolean;
  type?: string;
  durationMs?: number;
  size?: number;
  error?: string;
  errorHint?: string;
  /** Explains why `body` is null, e.g. "Response bodies are not available for documents captured via webRequest". */
  bodyNote?: string;
}

// ---------------------------------------------------------------------------------------------
// Editing model
// ---------------------------------------------------------------------------------------------

/** One editable key/value row (query param, header, urlencoded form field). */
export interface KVRow {
  /** Stable id; original rows keep their id across edits so diff/revert work by id. */
  id: string;
  enabled: boolean;
  key: string;
  value: string;
  /** Original encoded text for query/form rows, so untouched rows are re-emitted byte-for-byte. */
  raw?: { key: string; value: string; hasEquals: boolean };
  /** Header row that the browser controls (forbidden request header); informational for the UI. */
  locked?: boolean;
}

export type JNodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/**
 * Lossless, editable JSON tree node.
 *  - string:  value = decoded string
 *  - number:  value = literal text exactly as written (keeps big ints / precision); may be temporarily invalid while typing
 *  - boolean: value = true | false
 *  - null:    no value
 *  - object:  children (each child has `key`; duplicate keys are preserved in order)
 *  - array:   children (no `key`)
 */
export interface JNode {
  id: string;
  type: JNodeType;
  key?: string;
  value?: string | boolean;
  children?: JNode[];
}

export interface MultipartPart {
  id: string;
  enabled: boolean;
  name: string;
  kind: 'text' | 'file';
  /** Text value (kind = text). */
  value: string;
  fileName?: string;
  mime?: string;
  /** File content (kind = file). */
  base64?: string;
  size?: number;
  /** File content was not captured (too large / unknown); sending will send an empty file. */
  missingContent?: boolean;
  /** Extra part headers other than Content-Disposition / Content-Type. */
  extraHeaders?: HeaderPair[];
}

export type BodyType = 'none' | 'json' | 'form' | 'multipart' | 'text' | 'binary' | 'unavailable';

export type BodyModel =
  | { type: 'none' }
  /** flavor tells the UI to present GraphQL sections (query / variables / operationName / extensions). */
  | { type: 'json'; tree: JNode; flavor?: 'graphql' | 'graphql-batch' }
  | { type: 'form'; rows: KVRow[] }
  /**
   * `formData`: captured from a FormData object, so it is encoded the way browsers encode FormData — line
   * breaks in part names and text values become CRLF (file names are left alone).
   */
  | { type: 'multipart'; boundary: string; parts: MultipartPart[]; formData?: boolean }
  | { type: 'text'; text: string }
  | { type: 'binary'; base64: string; size: number; mime?: string }
  | { type: 'unavailable'; reason: string };

export type DraftSection = 'method' | 'url' | 'query' | 'headers' | 'body';

export interface DraftSnapshot {
  method: string;
  /** URL without query string and hash. */
  base: string;
  /** Hash without '#', '' when none. Never sent by fetch; kept for display/copy. */
  hash: string;
  query: KVRow[];
  headers: KVRow[];
  body: BodyModel;
}

/** Editable copy of a captured request. Immutable: every edit returns a new Draft. */
export interface Draft extends DraftSnapshot {
  entryId: string;
  /** Deep copy of the initial state; "Revert" restores from here. Never mutated. */
  original: DraftSnapshot;
  /** Original wire pieces, re-sent verbatim when the matching section is unmodified. */
  originalWire: {
    url: string;
    body: WireBody;
    /** Original body was truncated/unavailable, so a verbatim resend is lossy. */
    bodyIncomplete: boolean;
  };
}

// ---------------------------------------------------------------------------------------------
// Tab state, settings, bridge
// ---------------------------------------------------------------------------------------------

export interface TabState {
  /** Overlay visible in this tab (toggled by the toolbar button / Alt+Shift+L). */
  open: boolean;
  /** Capturing new requests (pause button). Effective capture = open && recording. */
  recording: boolean;
  /** Keep captured entries across navigations/reloads in this tab. */
  preserveLog: boolean;
  /**
   * Open but not shown: Claude Code opened the overlay in the background (MCP `overlay` / `requests`), so the tab
   * captures while the panel stays invisible. Set only by the service worker; any open / close by the user clears
   * it (the toolbar button reveals a hidden overlay). Absent = false.
   */
  hidden?: boolean;
}

export type DockMode = 'float' | 'right' | 'left' | 'bottom';

export interface LayoutSettings {
  dock: DockMode;
  /** Floating window geometry in CSS px; x/y = -1 means "auto" (bottom-right corner). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Width (left/right) or height (bottom) when docked. */
  dockSize: number;
  /** Width of the request list column. */
  listWidth: number;
  /** Editor/results split ratio (0..1) inside the detail pane. */
  split: number;
  minimized: boolean;
  /** Height in px of the Claude Code terminal pane docked at the bottom of the panel. */
  terminalHeight: number;
  /** The left navigation rail shows its labels (~180 px) instead of icons only (44 px). */
  railExpanded: boolean;
}

export interface Settings {
  theme: 'auto' | 'light' | 'dark';
  /** Panel opacity 0.3..1 (see-through to inspect the page underneath). */
  opacity: number;
  defaultMode: ReplayMode;
  maxEntries: number;
  captureResponseBodies: boolean;
  requestBodyCap: number;
  responseBodyCap: number;
  replayResponseCap: number;
  replayTimeoutMs: number;
  /** Claude Code bridge enabled (needs the optional nativeMessaging permission + `reqlens-mcp install`). */
  claudeBridge: boolean;
  /** Let Claude send (replay) requests through kineReqLens via the MCP `send_request` tool. */
  claudeAllowSend: boolean;
  /** Share secret values (Authorization, Cookie, tokens, passwords) with Claude instead of redacting them. */
  claudeShareSecrets: boolean;
  /**
   * Let Claude control kineReqLens through the MCP control tools (overlay, filters, edits, setups, language,
   * settings, Errors view flows, screenshots of pages, Find in page). Off by default; never changeable by Claude.
   */
  claudeAllowControl: boolean;
  /** Export tab: last type format. */
  exportFormat: TypeFormat;
  /** Export tab: last agent-prompt target. */
  promptTarget: PromptTarget;
  /** Request-list URL rules created from the row context menu ("Hide requests under…" / "Show only…"). */
  listRules: ListRule[];
  /** Request-list type filter ("Types" menu): the selected types, [] = all types. Default ['fetch']. */
  listTypes: ListTypeId[];
  /** Request list "Group by endpoint": calls sharing method + host + path template collapse into one row. */
  listGroup: boolean;
  /** How request URLs are labelled: endpoint template with id chips (default) or the full path. */
  urlDisplay: UrlDisplay;
  /** Saved, named configuration presets of the request list ("Setups" rail item), at most MAX_SETUPS. */
  setups: Setup[];
  /** The setup last applied (or saved); null when none. Always the id of an entry of `setups`. */
  activeSetupId: string | null;
  /** Embedded Claude Code terminal: recently used working directories, most recent first (≤ 10, as typed). */
  claudeRecentDirs: string[];
  /** React Native: the hub's receiver accepts app connections (needs nativeMessaging + `reqlens-mcp install`). */
  rnEnabled: boolean;
  /** React Native: listen on 0.0.0.0 (physical devices on the LAN) instead of 127.0.0.1 only. */
  rnListenLan: boolean;
  /** React Native: receiver port (1024..65535, default 8790). */
  rnPort: number;
  /**
   * Initiator tab: workspace folder that relative source-map paths (webpack://app/./src/…, /src/… of a dev
   * server) are resolved against for "Open in VS Code" links. '' = only absolute source paths get links.
   */
  editorRoot: string;
  /**
   * "Site language" tool (docs/ARCHITECTURE.md §11): page host name → Accept-Language value applied on that site
   * ("pt-BR,en;q=0.8", normalized by src/shared/language.ts), at most MAX_SITE_LANGUAGES. Tab-scope overrides live in
   * the service worker (storage.session), not here.
   */
  siteLanguages: Record<string, string>;
  /**
   * Errors view (docs/CLAUDE_INTEGRATION.md "Errors view"): page host name → the project folder Claude analyses /
   * fixes run in (absolute or `~/…`, as chosen), at most MAX_PROJECT_FOLDERS. Sanitized by src/shared/errors-settings.ts.
   */
  projectFolders: Record<string, string>;
  /** Errors view: analyze new distinct failing endpoints automatically (safe mode only, rate-limited). Default false. */
  autoAnalyzeErrors: boolean;
  /**
   * Errors view "full mode": Claude may edit files in git worktrees, and kineReqLens may run git commit / push and
   * gh issue / pr create after an explicit confirmation. Default false (safe mode: read-only analysis).
   */
  errorsFullMode: boolean;
  /** Errors view: capture a screenshot of the page area of a new failing endpoint automatically. Default true. */
  captureErrorScreens: boolean;
  /**
   * Find in page (docs/ARCHITECTURE.md §13): locate icons next to response values that the page shows (scanned by the
   * overlay's page side while a response is shown). Default true.
   */
  findInPage: boolean;
  /**
   * Screenshots of an element or region (element pick, a response value's camera button, the MCP `screenshot` tool):
   * space kept around it, in CSS px (0..SHOT_PADDING_MAX, default 50). Each capture's padding can be changed after.
   */
  shotPadding: number;
  layout: LayoutSettings;
}

/**
 * A request-list URL rule. `pattern` is an origin + path WITHOUT query/hash, e.g. "https://api.example.com/",
 * "https://api.example.com/standard/" (prefix: matches that path and everything below) or
 * "https://api.example.com/standard/reports/list-all" with `exact: true` (that path, any query string).
 * Matching compares against the entry URL's origin + pathname (case-sensitive path, case-insensitive origin).
 * Hide rules remove matches; when at least one enabled 'only' rule exists, only entries matching some
 * enabled 'only' rule are listed. Manual (user-made) entries are never hidden.
 */
export interface ListRule {
  id: string;
  mode: 'hide' | 'only';
  /** URL pattern; '' for method rules. */
  pattern: string;
  /** Method rule (upper-case, e.g. "OPTIONS"): matches entries by HTTP method instead of URL. */
  method?: string;
  /**
   * Endpoint-template rule: origin + path template ("https://api.example.com/reports/{uuid}/items/{id}", see
   * src/ui/list/endpointLabel.ts) matched against the entry URL's template, any method, any query. `pattern` is ''.
   */
  template?: string;
  exact: boolean;
  enabled: boolean;
  createdAt: number;
}

/** Request-list / detail URL labels: 'template' ("/reports/{uuid}/items/{id}" with chips) or 'full' (raw path). */
export type UrlDisplay = 'template' | 'full';

/** Request types of the list's "Types" filter (every type but the implicit "All"). */
export type ListTypeId = 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'media' | 'font' | 'other';

/** What a setup stores: the request-list configuration. */
export interface SetupConfig {
  /** Same meaning as Settings.listTypes ([] = all types). */
  listTypes: ListTypeId[];
  /** List rules (ids are replaced by fresh ones when the setup is applied). */
  listRules: ListRule[];
  /** Default replay mode applied with the setup; absent = leave the current mode alone. */
  defaultMode?: ReplayMode;
  /**
   * Site language applied with the setup (to the page's host, settings.siteLanguages), a normalized Accept-Language
   * value; absent = leave the language alone.
   */
  language?: string;
}

/** A saved, named request-list configuration preset. */
export interface Setup {
  /** 1..64 characters, unique among the setups. */
  id: string;
  /** 1..80 characters (trimmed). */
  name: string;
  /** 0..60 characters; '' = ungrouped. */
  group: string;
  /**
   * Host patterns on which the setup is applied automatically when the overlay opens: "api.example.com",
   * "*.example.com" (the domain and every subdomain), optionally with ":port". Lower-case ASCII (IDNs in
   * punycode). At most MAX_SETUP_SITES.
   */
  sites: string[];
  config: SetupConfig;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

export type SettingsPatch = Partial<Omit<Settings, 'layout'>> & { layout?: Partial<LayoutSettings> };

export interface CaptureInfo {
  /**
   * Capture started after the page began loading, so early requests were missed: the content script was
   * injected late, or the overlay was opened (or recording resumed) after this document started.
   */
  lateInjection: boolean;
  /** MAIN-world hook is connected (page-mode replay and fetch/XHR capture available). */
  hookConnected: boolean;
  pageUrl: string;
}

/** Initial content of a user-composed request; everything optional (default: blank GET to the page origin). */
export interface ManualEntryInit {
  /**
   * Id for the new entry (`m:` + 1..64 of `[A-Za-z0-9_-]`), so a UI that only talks to the store through
   * messages knows it synchronously. Ignored when invalid or already taken.
   */
  id?: string;
  method?: string;
  url?: string;
  headers?: HeaderPair[];
  body?: SerializedBody | null;
  /** Effective Content-Type of `body` (usually the Content-Type header). */
  contentType?: string | null;
}

/**
 * API the top-frame content script (content.js) exposes on `globalThis.__reqlens`
 * for the lazily injected UI bundle (ui.js). Both run in the extension's isolated world.
 */
export interface ReqlensBridge {
  readonly version: string;
  /** All entries, oldest first. Unchanged entries keep object identity between calls. */
  getEntries(): RequestEntry[];
  /** Called (coalesced) after any change to entries. Returns an unsubscribe function. */
  subscribeEntries(fn: () => void): () => void;
  clearEntries(): void;
  /** Create a user-composed request (source 'manual'): blank, or a copy of `init` (validated, body capped). */
  addManualEntry(init?: ManualEntryInit): RequestEntry;
  getTabState(): TabState;
  subscribeTabState(fn: (state: TabState) => void): () => void;
  setTabState(patch: Partial<TabState>): Promise<TabState>;
  getSettings(): Settings;
  subscribeSettings(fn: (settings: Settings) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** Executes a test request. Never rejects: failures resolve with ok=false and `error`. */
  replay(req: ReplayRequest): Promise<ReplayResult>;
  abortReplay(runId: string): void;
  getCaptureInfo(): CaptureInfo;
  subscribeCaptureInfo(fn: (info: CaptureInfo) => void): () => void;
  reloadPage(): void;
  /**
   * Entries the UI holds work for (selected, edited draft, test runs): never evicted at maxEntries.
   * Manual entries are always kept. Replaces the previous set.
   */
  setProtectedEntries(ids: string[]): void;
  /** Tear down (used when a newer content script instance replaces this one). */
  dispose(): void;
  /** WebSocket connections and frames of the page (src/lib/ws.ts). Optional: older hosts lack it. */
  readonly ws?: WsBridge;
  /**
   * Initiator tab: find mounted UI components by name in the top frame (React / Preact / Vue), optionally
   * scrolling to and highlighting them (src/shared/initiator-protocol.ts). Optional: only page hosts have it.
   * Never rejects.
   */
  locateComponents?(query: ComponentQuery): Promise<ComponentLocateResult>;
}

/**
 * What a mounted ui.js leaves on the isolated world's global object (`globalThis.__reqlensUi`). content.js
 * reads it to know whether the UI is mounted for its bridge (LOAD_UI dedupe, PING `hasUi`) and calls
 * `destroy()` when it is disposed or replaced.
 */
export interface UiMountRecord {
  readonly bridge: ReqlensBridge;
  destroy(): void;
}
