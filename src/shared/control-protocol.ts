/**
 * Claude Code control plane (docs/CLAUDE_INTEGRATION.md "Control tools"): everything the user can do in the overlay,
 * driven from a Claude Code chat through the reqlens MCP server, without seeing the overlay.
 *
 *   MCP tool (mcp/src/control-tools.ts)  ──bridge method `control` {tool, action, tabId?, activate?, args}──►  hub
 *        ──native messaging──►  service worker (src/background/claude/control/): validation, gating (settings
 *        claudeAllowControl / claudeAllowSend / errorsFullMode), target tab, then either a worker-side handler
 *        (tabs, overlay state, list filters, setups, language, settings, initiator) or a panel op over the panel link
 *        (`LinkQuery` kind 'control') — the panel is mounted invisibly when the overlay is closed (headless) and
 *        unmounted again after an idle period.
 *
 * Results are already-rendered markdown (page data fenced / escaped, redacted unless the user shares secrets) plus
 * optional images (screenshots). Everything here is JSON-safe and pure (shared by the MCP server, the worker and
 * the panel).
 */
import type { RunForClaude } from './claude-protocol';
import type { FindCommandArgs, FindCommandResult, ShotCommandArgs, ShotCommandResult } from './control-shot';
import type { Draft, DockMode, ListTypeId, ManualEntryInit, ReplayMode, ReplayRequest, TestRun, UrlDisplay } from './types';

// ---------------------------------------------------------------------------------------------------------
// Tools and actions (MCP surface)
// ---------------------------------------------------------------------------------------------------------

export const CONTROL_ACTIONS = {
  /** Read-only views. */
  inspect: [
    'tabs',
    'overlay',
    'setups',
    'websocket',
    'ws_messages',
    'language',
    'settings',
    'errors',
    'run',
    'compare',
    'snippet',
    'initiator',
    'source',
    'activity',
  ],
  overlay: ['open', 'close', 'show', 'hide', 'minimize', 'restore', 'dock', 'view', 'select', 'highlight', 'reload_page', 'use_tab', 'activate_tab'],
  requests: ['record', 'preserve_log', 'clear', 'new', 'duplicate', 'remove', 'restore', 'resend', 'cancel', 'select_run', 'clear_runs', 'ws_send', 'ws_clear'],
  edit_request: ['edit'],
  list_config: ['types', 'add_rule', 'toggle_rule', 'delete_rule', 'clear_rules', 'group', 'url_display', 'text'],
  setups: ['save', 'apply', 'update', 'rename', 'move', 'sites', 'duplicate', 'delete', 'import'],
  language: ['set', 'reset'],
  settings: ['set'],
  errors: ['capture', 'analyze', 'cancel', 'fix', 'issue', 'commit', 'pull_request', 'discard'],
  screenshot: ['capture'],
  find_in_page: ['find'],
} as const;

export type ControlTool = keyof typeof CONTROL_ACTIONS;
export type ControlAction<T extends ControlTool = ControlTool> = (typeof CONTROL_ACTIONS)[T][number];
export const CONTROL_TOOLS = Object.keys(CONTROL_ACTIONS) as ControlTool[];

/** Params of the bridge method `control` (validated strictly by the worker, src/background/claude/control/validate.ts). */
export interface ControlParams {
  tool: ControlTool;
  /** One of CONTROL_ACTIONS[tool]; optional for the single-action tools (edit_request, settings, screenshot, find_in_page). */
  action?: string;
  /** Target tab (default: the tab Claude was told to use, else the last overlay tab, else the active tab). */
  tabId?: number;
  /** screenshot / find_in_page: make the tab the active one (and restore its minimized window) when it is not visible. */
  activate?: boolean;
  /** Action arguments (see the `*Args` types below). */
  args?: Record<string, unknown>;
}

/** An image of a control result (MCP image content). */
export interface ControlImage {
  /** base64, no `data:` prefix. */
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  width?: number;
  height?: number;
}

/** What a control call returns: markdown for Claude, and images. */
export interface ControlResult {
  text: string;
  images?: ControlImage[];
  /** A test run (resend, inspect run): rendered by the MCP server like send_request's result, after `text`. */
  run?: RunForClaude & Record<string, unknown>;
}

/** One line of the visible trace (Settings → Claude Code → "Recent Claude actions"). */
export interface ControlTraceItem {
  at: number;
  /** MCP tool, e.g. "overlay", or an existing tool such as "send_request". */
  tool: string;
  action?: string;
  tabId?: number;
  ok: boolean;
}

/** Max trace lines kept by the worker (newest first) / shown in Settings. */
export const CONTROL_TRACE_MAX = 30;

/** A headless panel (mounted for Claude while the overlay is closed) is removed after this long without a command. */
export const HEADLESS_IDLE_MS = 2 * 60_000;

/** Shown when the control tools are off. */
export const CONTROL_DISABLED =
  'Controlling kineReqLens is turned off. Ask the user to turn on "Let Claude control kineReqLens (includes screenshots of pages)" in the kineReqLens overlay (Settings → Claude Code). Until then only status, list_requests, get_request, get_types, get_prompt, send_request and inbox work.';

// ---------------------------------------------------------------------------------------------------------
// Argument shapes (after validation)
// ---------------------------------------------------------------------------------------------------------

export type PanelView = 'http' | 'ws' | 'errors' | 'shot';
export type ResultsTabName = 'original' | 'export' | 'initiator' | 'test';

/** One edit of a key/value table (query params, headers, form fields / multipart text parts). */
export interface KvEdit {
  name: string;
  /** New value (set: the first row named `name`, or the `index`-th of them; add: a new row). */
  value?: string;
  enabled?: boolean;
  /** Remove the row(s). */
  remove?: boolean;
  /** Append a new row even when one with that name exists. */
  add?: boolean;
  /** Which row of that name (0-based), when there are duplicates. */
  index?: number;
  /** Rename the row. */
  rename?: string;
}

export type JsonValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/** One edit of a JSON body by path ("user.name", "items[0]", 'a["b.c"]'; "" = the root). */
export interface JsonEdit {
  path: string;
  /** New value (any JSON; objects / arrays replace the node). Missing parents are created as objects. */
  value?: unknown;
  /** Change the node's type (the value converts like the editor's type select). */
  type?: JsonValueType;
  /** Rename the key of an object member. */
  rename?: string;
  remove?: boolean;
}

export type RevertTarget =
  | 'all'
  | 'method'
  | 'url'
  | 'query'
  | 'headers'
  | 'body'
  | { param: string; index?: number }
  | { header: string; index?: number }
  | { field: string; index?: number }
  | { path: string };

/** What `edit_request` changes in the draft (applied in this order: revert, method, url, params, headers, bodyType, body, form, json, options). */
export interface DraftEditArgs {
  revert?: RevertTarget[];
  method?: string;
  /** Absolute URL; its query replaces the params, its fragment the hash. */
  url?: string;
  params?: KvEdit[];
  headers?: KvEdit[];
  bodyType?: 'none' | 'json' | 'form' | 'multipart' | 'text';
  /** Raw body text (parsed like the editor's Raw view). */
  body?: string;
  form?: KvEdit[];
  json?: JsonEdit[];
  options?: {
    mode?: ReplayMode;
    /** 'auto' = follow the captured request. */
    credentials?: ReplayRequest['credentials'] | 'auto';
    redirect?: ReplayRequest['redirect'];
    /** 'default' = the settings' replay timeout. */
    timeoutMs?: number | 'default';
  };
}

/** A list rule spec for `list_config add_rule`. */
export interface RuleArgs {
  mode: 'hide' | 'only';
  /** URL prefix (origin + path, no query); `exact` = that path only. */
  url?: string;
  exact?: boolean;
  method?: string;
  /** Endpoint template ("https://api.example.com/users/{id}") or a request id whose endpoint is meant. */
  template?: string;
  requestId?: string;
}

export interface WsMessagesArgs {
  wsId?: string;
  channel?: string;
  direction?: 'all' | 'in' | 'out';
  /** Text terms (`-term` excludes) or a JSON path test like `$.type = update` (the WebSocket view's filter). */
  filter?: string;
  heartbeats?: boolean;
  limit?: number;
  /** Only frames older than this frame id (paging back). */
  before?: number;
  /** One message in full (pretty JSON / text / hex). */
  frameId?: number;
}

// ---------------------------------------------------------------------------------------------------------
// Worker → panel ops (LinkQuery kind 'control'); args already validated by the worker
// ---------------------------------------------------------------------------------------------------------

export type PanelControlOp =
  | { op: 'state' }
  | { op: 'select'; entryId: string | null }
  | { op: 'view'; view: PanelView; resultsTab?: ResultsTabName; exportTab?: 'types' | 'prompt'; entryId?: string }
  | { op: 'highlight'; entryId: string }
  | { op: 'clear' }
  | { op: 'new'; init: ManualEntryInit; select: boolean }
  | { op: 'duplicate'; entryId: string; select: boolean }
  | { op: 'remove'; entryIds: string[] }
  | { op: 'restore'; entryIds?: string[] }
  | { op: 'resend'; entryId: string; runId?: string; timeoutMs: number }
  | { op: 'cancel'; entryId: string; runId?: string }
  | { op: 'select_run'; entryId: string; runId: string }
  | { op: 'clear_runs'; entryId: string }
  | { op: 'edit'; entryId: string; edit: DraftEditArgs }
  | { op: 'request'; entryId: string }
  | { op: 'runs'; entryId: string }
  | { op: 'text_filter'; text: string }
  | { op: 'ws_list'; wsId?: string }
  | ({ op: 'ws_messages' } & WsMessagesArgs)
  | { op: 'ws_send'; wsId: string; text: string }
  | { op: 'ws_clear' }
  | { op: 'errors'; filter?: 'all' | '5xx' | '4xx' | 'network'; key?: string; shots?: boolean }
  | { op: 'errors_capture'; key: string }
  | { op: 'errors_analyze'; key: string; waitMs: number }
  | { op: 'errors_cancel'; key: string }
  | { op: 'errors_fix'; key: string; pr: boolean }
  | { op: 'errors_dialog'; key: string; dialog: 'issue' | 'commit' | 'pr' | 'discard' }
  | { op: 'source'; texts: string[] }
  | { op: 'screenshot'; args: ShotCommandArgs; save: boolean }
  | { op: 'find'; args: FindCommandArgs };

export type PanelControlName = PanelControlOp['op'];

// ---------------------------------------------------------------------------------------------------------
// Panel answers (raw data: the worker redacts and formats it)
// ---------------------------------------------------------------------------------------------------------

export interface PanelStateResult {
  view: PanelView;
  selectedId: string | null;
  textFilter: string;
  /** "Remove from list" (panel memory). */
  removedIds: string[];
  entryCount: number;
  /** Entries with an edited draft or test runs. */
  work: Array<{ id: string; modified: boolean; runs: number }>;
  runningRuns: number;
  /** Errors view Claude runs (analyses, fixes) in progress: a headless panel is kept while there are any. */
  claudeRuns?: number;
  terminalOpen: boolean;
}

export interface PanelSendOptions {
  mode: ReplayMode;
  credentials: ReplayRequest['credentials'];
  credentialsAuto: boolean;
  redirect: ReplayRequest['redirect'];
  timeoutMs: number;
}

/** `edit` and `request`: the draft and the request it sends now. */
export interface PanelDraftResult {
  entryId: string;
  draft: Draft;
  modified: boolean;
  options: PanelSendOptions;
  /** The request Send would send now (edits included). */
  request: ReplayRequest | null;
  warnings: string[];
  /** Errors that block Send (invalid numbers, a raw body that does not parse…). */
  blocking: number;
  rawError?: string;
  applied?: string[];
}

export interface PanelRunsResult {
  entryId: string;
  runs: TestRun[];
  activeRunId: string | null;
}

export interface PanelWsChannel {
  key: string;
  kind: string;
  heartbeat: boolean;
  sent: number;
  received: number;
  count: number;
  lastTime: number;
}

export interface PanelWsConnection {
  wsId: string;
  url: string;
  frameId: number;
  state: string;
  protocol: string;
  detected: string | null;
  createdAt: number;
  closedAt?: number;
  closeCode?: number;
  closeReason?: string;
  sent: number;
  received: number;
  kept: number;
  heartbeats: number;
  channels: PanelWsChannel[];
}

export interface PanelWsFrame {
  id: number;
  dir: 'in' | 'out';
  time: number;
  opcode: string;
  size: number;
  truncated: boolean;
  channel: string;
  event?: string;
  heartbeat: boolean;
  /** Payload text (clipped), or a hex preview of binary frames. */
  text: string;
  textClipped: boolean;
  binary: boolean;
  /** One frame in full: its payload as JSON when it is JSON. */
  json?: unknown;
}

export interface PanelWsMessagesResult {
  wsId: string;
  url: string;
  total: number;
  frames: PanelWsFrame[];
  /** More (older) frames match beyond these. */
  more: boolean;
  filterError?: string;
  frame?: PanelWsFrame;
}

export interface PanelErrorGroup {
  key: string;
  method: string;
  endpoint: string;
  kind: string;
  kinds: string[];
  count: number;
  statuses: number[];
  lastStatus?: number;
  firstSeen: number;
  lastSeen: number;
  entryIds: string[];
  shots: number;
  running: boolean;
  hasAnalysis: boolean;
}

export interface PanelErrorRun {
  id: string;
  kind: string;
  state: string;
  auto: boolean;
  startedAt: number;
  endedAt?: number;
  error?: string;
  costUsd?: number;
  analysis: unknown;
  /** Last lines of the run's log (text / tool calls). */
  log: string[];
  worktree?: { path: string; branch: string };
  diffStat?: string;
  committed?: string;
  prUrl?: string;
  discarded?: boolean;
}

export interface PanelErrorShot {
  id: string;
  createdAt: number;
  auto: boolean;
  component?: string;
  width: number;
  height: number;
  /** PNG, base64 (only the newest shots, when asked). */
  data?: string;
}

export interface PanelErrorsResult {
  groups: PanelErrorGroup[];
  fullMode: boolean;
  folder: string | null;
  host: string | null;
  detail?: {
    group: PanelErrorGroup;
    runs: PanelErrorRun[];
    analysis: unknown;
    storedAt?: number;
    shots: PanelErrorShot[];
    autoShot: unknown;
    /** The markdown issue (Copy issue). */
    issue?: { title: string; body: string };
  };
}

export interface PanelScreenshotResult extends Omit<ShotCommandResult, 'image'> {
  image: Omit<ShotCommandResult['image'], 'data'>;
  /** Where the full-resolution image was saved ($REQLENS_HOME/shots). */
  path?: string;
  bytes?: number;
  saveError?: string;
}

export type PanelFindResult = FindCommandResult;

// ---------------------------------------------------------------------------------------------------------
// Small helpers shared by the sides
// ---------------------------------------------------------------------------------------------------------

export function isControlTool(value: unknown): value is ControlTool {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONTROL_ACTIONS, value);
}

export function isControlAction(tool: ControlTool, action: unknown): action is ControlAction {
  return typeof action === 'string' && (CONTROL_ACTIONS[tool] as readonly string[]).includes(action);
}

/** Rail views by the names the tools use. */
export const VIEW_NAMES: Readonly<Record<string, PanelView>> = {
  requests: 'http',
  http: 'http',
  websocket: 'ws',
  ws: 'ws',
  errors: 'errors',
  screenshot: 'shot',
  shot: 'shot',
};

export const DOCK_MODES: readonly DockMode[] = ['float', 'right', 'left', 'bottom'];
export const URL_DISPLAYS: readonly UrlDisplay[] = ['template', 'full'];
export type { ListTypeId };
