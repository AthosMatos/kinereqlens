/**
 * Panel link of the Claude Code bridge (docs/specs/v0.2.md §B.4): a chrome.runtime Port from the overlay
 * panel (panel.html, src/ui/panel/claudeLink.ts) to the service worker (src/background/claude/links.ts).
 *
 *  - The panel opens it with `chrome.runtime.connect({name: CLAUDE_LINK_PORT_NAME})` while the bridge is
 *    enabled and sends `hello` with the tab it lives in; the worker only accepts ports from this extension's
 *    panel.html whose `hello.tabId` equals `sender.tab.id`.
 *  - The worker pushes BridgeStatus on every change and asks the panel what only the panel knows: the
 *    selection, the user's edited drafts and the test runs (`query` / `res`), and has it run Claude's
 *    `send_request` through the draft store so the run shows in the overlay's history.
 *  - "Send to Claude Code" travels panel → worker (`push`) → hub.
 *  - Embedded terminal: the panel sends `pty-*` control messages (claude-protocol.ts `PtyToHost`), the worker
 *    relays them to the hub and the hub's `PtyFromHost` events back to the panel that opened the terminal.
 *    When a panel goes away its terminals live on for PTY_GRACE_MS; a panel of the same tab connecting in
 *    that window re-attaches them (`pty-attached`, with the last PTY_REPLAY_CHARS of output).
 *  - Folder browser of the terminal's new-session form: `fs-*` requests (claude-protocol.ts `FsToHost`), answered
 *    by the hub (`FsFromHost`) to the panel that asked only (src/background/claude/fs.ts).
 *  - "Send to Claude" of the screenshot tool: `shot-save` chunks (shot-protocol.ts), answered `shot-saved` (the
 *    absolute path) / `shot-error` to the panel that asked only (src/background/claude/shots.ts).
 *
 * Both ends are extension contexts (the page can never reach this port); payloads are still validated.
 */
import type { BridgeStatus, FsFromHost, FsToHost, InboxItem, PtyFromHost, PtyToHost, RequestOverrides } from './claude-protocol';
import type { Draft, ReplayMode, TestRun } from './types';
import type { OpFromHost, OpToHost, RunFromHost, RunToHost } from './errors-protocol';
import type { ShotFromHost, ShotToHost } from './shot-protocol';
import type { PanelControlOp } from './control-protocol';

export const CLAUDE_LINK_PORT_NAME = 'reqlens-claude-link';
export const CLAUDE_LINK_VERSION = 1;

/** A terminal whose panel disconnected is killed after this long unless a panel of its tab re-attaches. */
export const PTY_GRACE_MS = 10_000;

/** Max chars of one run's response body the panel hands over (bigger bodies are clipped, `truncated`). */
export const LINK_RUN_BODY_CAP = 2_000_000;
/** Total body chars of one `entry` answer; runs beyond it travel without their response body. */
export const LINK_ENTRY_BUDGET = 16_000_000;
/** Request bodies of runs are only kept up to this size (Claude sees the run's method and URL only). */
export const LINK_RUN_REQUEST_BODY_CAP = 64 * 1024;

/** What the panel knows about its entries. */
export interface LinkState {
  /** Entry selected in the overlay, if any. */
  selectedId: string | null;
  /** Entries with an edited draft or test runs. */
  work: Array<{ id: string; modified: boolean; runs: number }>;
}

/** The panel's data for one entry. */
export interface LinkEntryData {
  /** The user's draft when it differs from the capture, else null. */
  draft: Draft | null;
  /** Test runs, newest first (bodies clipped, see LINK_RUN_BODY_CAP / LINK_ENTRY_BUDGET). */
  runs: TestRun[];
}

/** Item the panel asks the worker to deliver to Claude Code (the worker adds id, sentAt and tabId). */
export type LinkInboxDraft = Omit<InboxItem, 'id' | 'sentAt' | 'tabId'>;

export type LinkQuery =
  | { kind: 'state' }
  | { kind: 'entry'; entryId: string }
  /** Run Claude's request through the draft store (origin 'claude'); answers once the run finished. */
  | { kind: 'send'; entryId: string; overrides?: RequestOverrides; mode?: ReplayMode; timeoutMs: number }
  /** A control-plane op (src/shared/control-protocol.ts, validated by the worker); answered by src/ui/panel/control.ts. */
  | { kind: 'control'; op: PanelControlOp };

/** Answer type of each query kind. */
export interface LinkQueryResults {
  state: LinkState;
  entry: LinkEntryData;
  send: { run: TestRun };
  /** Op-specific JSON (src/ui/panel/control.ts); the worker checks its shape. */
  control: unknown;
}

export type PanelToWorker =
  /** First message. */
  | { t: 'hello'; v: number; tabId: number }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'push'; id: number; item: LinkInboxDraft }
  /** Terminal control (validated by the worker with parsePtyToHost, src/shared/pty.ts). */
  | PtyToHost
  /** Folder browser requests (validated by the worker with parseFsToHost, src/shared/fs.ts). */
  | FsToHost
  /** Errors view runs / git ops (validated by the worker with parseRunToHost, src/shared/errors-protocol.ts). */
  | RunToHost
  | OpToHost
  /** Screenshot chunks of "Send to Claude" (validated by the worker with parseShotToHost, src/shared/shot-protocol.ts). */
  | ShotToHost;

/** A terminal handed to a (re)connected panel of its tab. */
export interface LinkPtyAttached {
  t: 'pty-attached';
  id: string;
  /** Working directory (resolved by the hub when known, else as typed). */
  cwd: string;
  pid?: number;
  state: 'opening' | 'running' | 'exited';
  exit?: { code: number | null; signal: number | string | null };
  /** The last output (≤ PTY_REPLAY_CHARS chars). */
  replay: string;
}

export type WorkerToPanel =
  | { t: 'status'; status: BridgeStatus }
  | { t: 'query'; id: number; query: LinkQuery }
  | { t: 'push-result'; id: number; ok: boolean; delivered: number; error?: string }
  | PtyFromHost
  | LinkPtyAttached
  | FsFromHost
  | RunFromHost
  | OpFromHost
  | ShotFromHost;
