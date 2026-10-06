/**
 * Claude Code bridge protocol (docs/specs/v0.2.md §B, docs/ARCHITECTURE.md §8; setup and CLI: mcp/README.md).
 *
 *   Claude Code ──stdio MCP──► reqlens-mcp serve  (one per Claude Code session, spawned by Claude Code)
 *                                   │  newline-delimited JSON over a Unix socket (~/.reqlens/hub.sock, 0600)
 *                                   ▼
 *                              reqlens-mcp native-host  (the hub; spawned by the browser via native messaging)
 *                                   │  native messaging (4-byte LE length + UTF-8 JSON on stdin/stdout)
 *                                   ▼
 *                              extension service worker ──► top-frame content script (store) / panel (drafts, runs)
 *
 * Everything here must be JSON-safe. The extension is the source of truth; the hub only relays and keeps
 * nothing but the session list. Native messaging caps host→browser messages at 1 MB: requests from the hub are
 * small; large payloads only flow browser→host (responses, pushes).
 */
import type { RnExtensionToHost, RnHostToExtension } from './rn-protocol';
import type { ErrorsConfigToHost, OpFromHost, OpToHost, RunFromHost, RunToHost } from './errors-protocol';
import type { InboxImage, ShotFromHost, ShotToHost } from './shot-protocol';
import type { ControlParams, ControlResult, ControlTraceItem } from './control-protocol';
import type { ReplayMode, RequestEntry, RunState } from './types';

/** Native messaging host name (registered by `reqlens-mcp install`). */
export const NATIVE_HOST_NAME = 'com.reqlens.bridge';
export const BRIDGE_PROTOCOL_VERSION = 1;
/** Max bytes of one host→extension message (Chromium limit is 1 MiB; keep a margin). */
export const NATIVE_MAX_INBOUND_BYTES = 1_000_000;
/**
 * `sendRequest` runs with the user's `settings.replayTimeoutMs`, clamped to [1 s, this] by the extension, which
 * always answers within that plus a few seconds (a timed-out run is a result). The MCP server does not know the
 * user's setting, so it waits up to this bound (plus a margin) before giving up on its own.
 */
export const BRIDGE_SEND_MAX_TIMEOUT_MS = 10 * 60_000;

export type TypeFormat = 'typescript' | 'zod' | 'json-schema';
/** What the generated agent prompt asks for. */
export type PromptTarget = 'client' | 'server' | 'tests' | 'explain';

/** One Claude Code session (one MCP server process) connected to the hub. */
export interface ClaudeSessionInfo {
  /** Random id chosen by the MCP server process. */
  id: string;
  /** Short label for pickers: basename of `cwd`. */
  label: string;
  /** Working directory of the Claude Code session (the project). */
  cwd: string;
  pid: number;
  /**
   * Parent pid of the MCP server = the `claude` process (optional: older servers omit it). The overlay matches it
   * against its embedded terminals' pids ("this window").
   */
  ppid?: number;
  connectedAt: number;
}

export type BridgeHostState = 'off' | 'connecting' | 'connected' | 'not-installed' | 'error';

/** Bridge status shown in the overlay (Settings → Claude Code, Export tab). */
export interface BridgeStatus {
  /** settings.claudeBridge */
  enabled: boolean;
  /** The optional `nativeMessaging` permission is granted. */
  permission: boolean;
  host: BridgeHostState;
  hostVersion?: string;
  /** Human-readable reason for 'not-installed' / 'error'. */
  error?: string;
  sessions: ClaudeSessionInfo[];
  /** This extension's id (needed by `reqlens-mcp install --extension-id`). */
  extensionId: string;
  /** Recent MCP calls, newest first (Settings → Claude Code → "Recent Claude actions"). */
  trace?: ControlTraceItem[];
}

// ---------------------------------------------------------------------------------------------------------
// Bridge methods (Claude → extension). Called by MCP tools, relayed by the hub, answered by the SW.
// `tabId` omitted = the tab where the overlay was most recently active.
// ---------------------------------------------------------------------------------------------------------

export interface TabSummary {
  tabId: number;
  title: string;
  url: string;
  /** Overlay open in this tab. */
  open: boolean;
  recording: boolean;
  entryCount: number;
  /** The default tab for calls without tabId. */
  active: boolean;
  /** Open in the background for Claude Code (capturing, not shown). */
  hidden?: boolean;
}

export interface RequestSummary {
  id: string;
  method: string;
  url: string;
  kind: RequestEntry['kind'];
  state: RequestEntry['state'];
  status?: number;
  startTime: number;
  durationMs?: number;
  /** Response body bytes when known. */
  size?: number;
  /** The user has an edited draft for it. */
  modified: boolean;
  runs: number;
  /** Currently selected in the overlay. */
  selected: boolean;
}

/** Text rendering of a body for Claude: decoded text (JSON pretty-printed), or a note for binary/unavailable. */
export interface BodyForClaude {
  contentType: string | null;
  /** 'json' | 'graphql' | 'form' | 'multipart' | 'text' | 'binary' | 'none' | 'unavailable'. */
  kind: string;
  text: string;
  truncated: boolean;
  /** Full size in bytes when known. */
  size?: number;
}

export interface RequestDetailForClaude {
  summary: RequestSummary;
  pageUrl: string;
  request: {
    method: string;
    url: string;
    query: Array<[string, string]>;
    headers: Array<[string, string]>;
    body: BodyForClaude | null;
  };
  response: {
    status?: number;
    statusText?: string;
    headers: Array<[string, string]>;
    body: BodyForClaude | null;
    /** Why the body is missing, when it is. */
    note?: string;
  } | null;
  /** The user's edited version (only when modified). */
  edited?: RequestDetailForClaude['request'];
  /** Most recent test runs, newest first. */
  runs?: RunForClaude[];
  /** True when secret values were replaced by "<redacted>". */
  redacted: boolean;
}

export interface RunForClaude {
  runId: string;
  origin: 'user' | 'claude';
  state: RunState;
  mode: ReplayMode;
  startedAt: number;
  durationMs?: number;
  status?: number;
  error?: string;
  request: { method: string; url: string };
  responseBody?: BodyForClaude | null;
}

export interface RequestOverrides {
  method?: string;
  /** Full absolute URL (replaces the query too unless `query` is given). */
  url?: string;
  /** Replaces all query params. */
  query?: Array<[string, string]>;
  /** Merged into the request headers by name (case-insensitive); value null removes the header. */
  headers?: Array<[string, string | null]>;
  /** Raw body text (replaces the body). */
  body?: string;
}

export interface BridgeCalls {
  status: {
    params: Record<string, never>;
    result: {
      extensionVersion: string;
      browser: string;
      tabs: TabSummary[];
      allowSend: boolean;
      shareSecrets: boolean;
      /** settings.claudeAllowControl (absent from older extensions = off). */
      allowControl?: boolean;
    };
  };
  listTabs: { params: Record<string, never>; result: { tabs: TabSummary[] } };
  listRequests: {
    params: {
      tabId?: number;
      query?: string;
      kinds?: string[];
      methods?: string[];
      statuses?: string[];
      limit?: number;
      offset?: number;
      /** Only failed requests (statuses "failed"). */
      errorsOnly?: boolean;
      /** Only what the overlay's list shows (types, rules, text filter, removed). */
      overlayFilters?: boolean;
    };
    result: { tabId: number; total: number; requests: RequestSummary[] };
  };
  getRequest: {
    params: { tabId?: number; id: string; maxBodyChars?: number; includeRuns?: boolean };
    result: RequestDetailForClaude;
  };
  getTypes: {
    params: { tabId?: number; id: string; format?: TypeFormat; baseName?: string; annotate?: boolean };
    result: { format: TypeFormat; code: string; names: Record<string, string>; notes: string[] };
  };
  getPrompt: {
    params: { tabId?: number; id: string; target?: PromptTarget; includeExamples?: boolean };
    result: { prompt: string; target: PromptTarget };
  };
  sendRequest: {
    params: { tabId?: number; id: string; overrides?: RequestOverrides; mode?: ReplayMode; maxBodyChars?: number };
    result: RunForClaude;
  };
  /** The control tools (src/shared/control-protocol.ts); refused unless settings.claudeAllowControl. */
  control: { params: ControlParams; result: ControlResult };
}

export type BridgeMethod = keyof BridgeCalls;
export const BRIDGE_METHODS: ReadonlyArray<BridgeMethod> = [
  'status',
  'listTabs',
  'listRequests',
  'getRequest',
  'getTypes',
  'getPrompt',
  'sendRequest',
  'control',
];

/** Something the user sent from the overlay ("Send to Claude Code"). */
export interface InboxItem {
  id: string;
  sentAt: number;
  tabId: number;
  entryId: string;
  /** e.g. "POST /api/orders". */
  title: string;
  target: PromptTarget;
  /** The generated agent prompt (markdown). */
  prompt: string;
  /** Session it is addressed to; null/absent = every connected session. */
  sessionId?: string | null;
  /**
   * Screenshots saved by the hub ("Send to Claude" of the screenshot tool; src/shared/shot-protocol.ts). Items
   * with images may have an empty `entryId` (no request attached).
   */
  images?: InboxImage[];
}

// ---------------------------------------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// Embedded terminal (docs/CLAUDE_INTEGRATION.md "Terminal"): the panel asks the worker, which asks the hub, to
// run the real `claude` CLI in a pseudo-terminal (node-pty) in a folder the user picked. Ids are chosen by the
// panel (random, ≤ PTY_MAX_ID_CHARS); the worker tracks which panel owns which id. Validation helpers and the
// output chunker live in ./pty.ts (shared by the panel, the worker and the hub).
// ---------------------------------------------------------------------------------------------------------

/** Max length of a terminal id. */
export const PTY_MAX_ID_CHARS = 64;
/** Terminal columns / rows are integers in 1..PTY_MAX_DIM. */
export const PTY_MAX_DIM = 1000;
/** Max UTF-8 bytes of one `pty-input` chunk (the panel splits bigger pastes). */
export const PTY_MAX_INPUT_BYTES = 64 * 1024;
/** Max chars of one `pty-data` chunk: JSON escapes ≤ 6 bytes per char keep a frame < 400 KB (limit 1 MB). */
export const PTY_DATA_CHUNK_CHARS = 64 * 1024;
/** The hub batches pty output for this long before sending it. */
export const PTY_BATCH_MS = 16;
/** Max terminals one hub runs at a time. */
export const PTY_MAX_SESSIONS = 8;
/** Max chars of a working directory as typed (before `~` expansion). */
export const PTY_MAX_CWD_CHARS = 4096;

/** extension → hub: terminal control. */
export type PtyToHost =
  | { t: 'pty-open'; id: string; cwd: string; cols: number; rows: number }
  | { t: 'pty-input'; id: string; data: string }
  | { t: 'pty-resize'; id: string; cols: number; rows: number }
  | { t: 'pty-close'; id: string };

/** hub → extension: terminal events. */
export type PtyFromHost =
  /** `cwd` (optional): the resolved working directory. */
  | { t: 'pty-opened'; id: string; pid: number; cwd?: string }
  | { t: 'pty-data'; id: string; data: string }
  | { t: 'pty-exit'; id: string; code: number | null; signal: number | string | null }
  | { t: 'pty-error'; id: string; error: string };

// ---------------------------------------------------------------------------------------------------------
// Folder browser of the embedded terminal (docs/CLAUDE_INTEGRATION.md "Working directory"): the new-session form
// lists folders (names of sub-directories only, never file contents), opens the OS-native folder chooser and
// finds git projects under the usual folders — all answered by the hub, relayed by the worker like the `pty-*`
// messages (owner panel per request, timeouts). Ids are chosen by the panel (isPtyId rules); the worker rewrites
// them so panels never see each other's requests. Validation helpers live in ./fs.ts.
// ---------------------------------------------------------------------------------------------------------

/** A listing returns at most this many sub-directories (sorted, visible ones first). */
export const FS_MAX_ENTRIES = 2000;
/** Max chars of one folder name. */
export const FS_MAX_NAME_CHARS = 1024;
/** Max projects of one scan. */
export const FS_MAX_PROJECTS = 200;
/** The worker answers `fs-error` when the hub did not answer in time. */
export const FS_LIST_TIMEOUT_MS = 20_000;
export const FS_PROJECTS_TIMEOUT_MS = 60_000;
/** The native folder chooser waits for the user. */
export const FS_PICK_TIMEOUT_MS = 10 * 60_000;
/** Feature the hub announces in its hello when it serves `fs-*` (older hubs drop them). */
export const HUB_FEATURE_FS = 'fs';

/** A sub-directory of a listing. */
export interface FsEntry {
  name: string;
  dir: true;
  /** Dot-folder. */
  hidden: boolean;
  /** Contains `.git` (a repository or worktree). */
  git?: boolean;
  /** A git repository or a folder with a project marker (package.json, pyproject.toml, go.mod, Cargo.toml). */
  project?: boolean;
}

/** A project found by `fs-projects`. */
export interface FsProject {
  path: string;
  name: string;
  git: boolean;
  /** Has a project marker. */
  project?: boolean;
}

/** extension → hub: folder browser requests. */
export type FsToHost =
  /** `path`: absolute or `~/…`. */
  | { t: 'fs-list'; id: string; path: string }
  /** Open the OS-native folder chooser (starting in `startPath` when valid, else home). */
  | { t: 'fs-pick'; id: string; startPath?: string }
  /** Git repositories ≤ 2 levels under ~/Documents, ~/Projects, ~/dev, ~/code, ~/src, ~/GitHub (cached unless `refresh`). */
  | { t: 'fs-projects'; id: string; refresh?: boolean };

/** hub → extension: folder browser answers. */
export type FsFromHost =
  | {
      t: 'fs-listed';
      id: string;
      /** Resolved absolute path. */
      path: string;
      /** null at a root. */
      parent: string | null;
      entries: FsEntry[];
      home: string;
      /** Path separator of the hub's platform. */
      sep: '/' | '\\';
      /** More sub-directories than FS_MAX_ENTRIES. */
      truncated?: boolean;
    }
  /** `path` null: the user cancelled. */
  | { t: 'fs-picked'; id: string; path: string | null }
  | { t: 'fs-projects-listed'; id: string; projects: FsProject[]; home: string; truncated?: boolean }
  | { t: 'fs-error'; id: string; error: string };

/** hub → extension (native messaging, ≤ NATIVE_MAX_INBOUND_BYTES). */
export type HostToExtension =
  /** `features`: optional capabilities (HUB_FEATURE_FS). */
  | { t: 'hello'; v: number; hostVersion: string; features?: string[] }
  | { t: 'sessions'; sessions: ClaudeSessionInfo[] }
  | { t: 'req'; id: string; sessionId: string; method: BridgeMethod; params: unknown }
  | PtyFromHost
  | FsFromHost
  /** Errors view runs and git ops (src/shared/errors-protocol.ts). */
  | RunFromHost
  | OpFromHost
  /** React Native receiver (src/shared/rn-protocol.ts). */
  | RnHostToExtension
  /** Screenshots saved for "Send to Claude" (src/shared/shot-protocol.ts). */
  | ShotFromHost;

/** extension → hub (native messaging). */
export type ExtensionToHost =
  | { t: 'hello'; v: number; extensionVersion: string; extensionId: string; browser: string }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  | { t: 'push'; item: InboxItem }
  | PtyToHost
  | FsToHost
  /** Errors view runs, git ops and the full-mode switch (src/shared/errors-protocol.ts). */
  | RunToHost
  | OpToHost
  | ErrorsConfigToHost
  /** React Native receiver control (src/shared/rn-protocol.ts). */
  | RnExtensionToHost
  /** Screenshot chunks for "Send to Claude" (src/shared/shot-protocol.ts). */
  | ShotToHost;

/** MCP server → hub (Unix socket, one JSON object per line). */
export type McpToHub =
  | { t: 'hello'; v: number; session: Omit<ClaudeSessionInfo, 'connectedAt'> }
  | { t: 'req'; id: string; method: BridgeMethod; params: unknown };

/** hub → MCP server (Unix socket, one JSON object per line). */
export type HubToMcp =
  | { t: 'hello'; v: number; hostVersion: string; extension: { connected: boolean; version?: string; browser?: string } }
  | { t: 'ext'; connected: boolean; version?: string; browser?: string }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  | { t: 'push'; item: InboxItem };
