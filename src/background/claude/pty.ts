// Embedded Claude Code terminal, service-worker side (docs/CLAUDE_INTEGRATION.md "Terminal"): relays `pty-*`
// messages between the panel links (./links.ts) and the hub's native port (./native.ts).
//
//  - Only panels can open terminals (the links accept nothing but this extension's panel.html in its own tab);
//    every message is validated (src/shared/pty.ts) and a panel may only drive the terminals it opened.
//  - Each terminal keeps the last PTY_REPLAY_CHARS of output. When its panel disconnects (reload, navigation,
//    overlay closed) the terminal lives on for PTY_GRACE_MS: a panel of the same tab connecting in that window
//    re-attaches it (`pty-attached` with the replay); otherwise it is killed.
//  - The hub going away (native port closed) ends every terminal; turning the bridge off kills them all.
import { PTY_GRACE_MS } from '../../shared/claude-link';
import type { LinkPtyAttached, WorkerToPanel } from '../../shared/claude-link';
import { PTY_MAX_SESSIONS } from '../../shared/claude-protocol';
import type { PtyFromHost, PtyToHost } from '../../shared/claude-protocol';
import { OutputTail, PTY_REPLAY_CHARS, isPtyId, parsePtyToHost } from '../../shared/pty';
import type { LinkHandle } from './links';
import type { Timers } from './native';

/** Terminals (running or exited, not yet closed by their panel) the worker tracks at most. */
export const PTY_MAX_RECORDS = 32;

export const PTY_NOT_CONNECTED_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const PTY_HOST_GONE_ERROR = 'The Claude Code bridge disconnected — the terminal was closed';

export interface PtyRelayDeps {
  /** Send to the hub; false when the bridge is not connected. */
  send(message: PtyToHost): boolean;
  timers?: Timers;
  graceMs?: number;
  replayChars?: number;
}

type PtyState = LinkPtyAttached['state'];

interface PtyRecord {
  id: string;
  tabId: number;
  /** The panel driving it; null while waiting for a panel of its tab to re-attach. */
  owner: LinkHandle | null;
  cwd: string;
  pid?: number;
  state: PtyState;
  exit?: { code: number | null; signal: number | string | null };
  tail: OutputTail;
  grace: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Which panel owns which terminal, output replay and the reload grace period. */
export class PtyRelay {
  private readonly records = new Map<string, PtyRecord>();
  private readonly timers: Timers;
  private readonly graceMs: number;
  private readonly replayChars: number;

  constructor(private readonly deps: PtyRelayDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.graceMs = deps.graceMs ?? PTY_GRACE_MS;
    this.replayChars = deps.replayChars ?? PTY_REPLAY_CHARS;
  }

  /** Terminals tracked (any state). */
  get size(): number {
    return this.records.size;
  }

  /** Snapshot for tests and diagnostics. */
  describe(id: string): { tabId: number; owned: boolean; state: PtyState; replay: string } | null {
    const rec = this.records.get(id);
    return rec ? { tabId: rec.tabId, owned: rec.owner !== null, state: rec.state, replay: rec.tail.text() } : null;
  }

  /** A `pty-*` message from a panel (unvalidated). */
  fromPanel(link: LinkHandle, raw: unknown): void {
    const message = parsePtyToHost(raw);
    if (!message) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (isPtyId(id)) post(link, { t: 'pty-error', id, error: 'Invalid terminal message' });
      return;
    }
    if (message.t === 'pty-open') {
      this.open(link, message);
      return;
    }
    const rec = this.records.get(message.id);
    if (!rec || rec.owner !== link) {
      // Never reveal (or touch) another panel's terminal.
      post(link, { t: 'pty-error', id: message.id, error: 'Unknown terminal' });
      return;
    }
    if (message.t === 'pty-close') {
      this.forget(rec);
      if (rec.state !== 'exited') this.deps.send(message);
      return;
    }
    if (rec.state === 'exited') return;
    this.deps.send(message);
  }

  /** A terminal event from the hub. */
  fromHost(message: PtyFromHost): void {
    const rec = this.records.get(message.id);
    if (!rec) return;
    switch (message.t) {
      case 'pty-opened':
        rec.state = 'running';
        rec.pid = message.pid;
        if (message.cwd) rec.cwd = message.cwd;
        break;
      case 'pty-data':
        rec.tail.push(message.data);
        break;
      case 'pty-exit':
        rec.state = 'exited';
        rec.exit = { code: message.code, signal: message.signal };
        if (!rec.owner) {
          this.forget(rec);
          return;
        }
        break;
      case 'pty-error':
        // An error while opening means it never started.
        if (rec.state === 'opening') this.forget(rec);
        break;
    }
    if (rec.owner) post(rec.owner, message);
  }

  /** A panel connected: hand it the orphaned terminals of its tab. */
  linkOpened(link: LinkHandle): void {
    for (const rec of this.records.values()) {
      if (rec.owner !== null || rec.tabId !== link.tabId) continue;
      rec.owner = link;
      this.clearGrace(rec);
      const attached: LinkPtyAttached = { t: 'pty-attached', id: rec.id, cwd: rec.cwd, state: rec.state, replay: rec.tail.text() };
      if (rec.pid !== undefined) attached.pid = rec.pid;
      if (rec.exit) attached.exit = rec.exit;
      post(link, attached);
    }
  }

  /** A panel went away: its terminals wait PTY_GRACE_MS for a successor, then are killed. */
  linkClosed(link: LinkHandle): void {
    for (const rec of [...this.records.values()]) {
      if (rec.owner !== link) continue;
      rec.owner = null;
      if (rec.state === 'exited') {
        this.forget(rec);
        continue;
      }
      this.clearGrace(rec);
      rec.grace = this.timers.setTimeout(() => {
        rec.grace = null;
        if (this.records.get(rec.id) !== rec || rec.owner !== null) return;
        this.forget(rec);
        this.deps.send({ t: 'pty-close', id: rec.id });
      }, this.graceMs);
    }
  }

  /** The hub is gone (native port closed): every terminal ended with it. */
  hostGone(error = PTY_HOST_GONE_ERROR): void {
    for (const rec of [...this.records.values()]) {
      if (rec.state === 'exited') continue;
      const owner = rec.owner;
      if (owner) post(owner, { t: 'pty-error', id: rec.id, error });
      if (!owner || rec.state === 'opening') {
        this.forget(rec);
        continue;
      }
      rec.state = 'exited';
      rec.exit = { code: null, signal: null };
      post(owner, { t: 'pty-exit', id: rec.id, code: null, signal: null });
    }
  }

  /** Close every terminal (the bridge is being turned off) and tell their panels. */
  killAll(error: string): void {
    for (const rec of [...this.records.values()]) {
      this.forget(rec);
      if (rec.state === 'exited') continue;
      this.deps.send({ t: 'pty-close', id: rec.id });
      if (rec.owner) {
        post(rec.owner, { t: 'pty-error', id: rec.id, error });
        if (rec.state === 'running') post(rec.owner, { t: 'pty-exit', id: rec.id, code: null, signal: null });
      }
    }
  }

  private open(link: LinkHandle, message: Extract<PtyToHost, { t: 'pty-open' }>): void {
    const fail = (error: string): void => void post(link, { t: 'pty-error', id: message.id, error });
    if (this.records.has(message.id)) return fail('A terminal with this id already exists');
    let alive = 0;
    for (const rec of this.records.values()) if (rec.state !== 'exited') alive++;
    if (alive >= PTY_MAX_SESSIONS) return fail(`At most ${PTY_MAX_SESSIONS} terminals can run at a time — close one first`);
    if (this.records.size >= PTY_MAX_RECORDS) return fail('Too many terminal tabs — close some first');
    const rec: PtyRecord = {
      id: message.id,
      tabId: link.tabId,
      owner: link,
      cwd: message.cwd,
      state: 'opening',
      tail: new OutputTail(this.replayChars),
      grace: null,
    };
    this.records.set(rec.id, rec);
    if (!this.deps.send(message)) {
      this.forget(rec);
      fail(PTY_NOT_CONNECTED_ERROR);
    }
  }

  private forget(rec: PtyRecord): void {
    this.clearGrace(rec);
    if (this.records.get(rec.id) === rec) this.records.delete(rec.id);
  }

  private clearGrace(rec: PtyRecord): void {
    if (rec.grace !== null) this.timers.clearTimeout(rec.grace);
    rec.grace = null;
  }
}

function post(link: LinkHandle, message: WorkerToPanel): boolean {
  try {
    return link.post(message);
  } catch {
    return false;
  }
}
