// Errors view runs, service-worker side (docs/CLAUDE_INTEGRATION.md "Errors view"): relays `run-*` / `op-*`
// messages between the panel links (./links.ts) and the hub's native port (./native.ts), and answers the panel
// that asked — only it.
//
//  - Every message is validated (src/shared/errors-protocol.ts) and gets a worker-chosen id towards the hub.
//  - Full mode: `run-start` of kind `fix` and every `op-start` are refused unless settings.errorsFullMode is on (the
//    hub refuses them too: `errors-config` is sent on every hub hello and settings change).
//  - Automatic analyses (`auto: true`) only with settings.autoAnalyzeErrors, safe mode only, ≤ AUTO_MAX_PER_MINUTE.
//  - ≤ RUN_MAX_CONCURRENT runs; a panel that goes away cancels its runs (the hub kills the process group); the hub
//    going away fails everything.
import type { WorkerToPanel } from '../../shared/claude-link';
import { OP_TIMEOUT_MS, RUN_MAX_CONCURRENT, RUN_TIMEOUT_MS, parseRunToHost } from '../../shared/errors-protocol';
import type { ErrorsConfigToHost, OpFromHost, OpToHost, RunFromHost, RunToHost } from '../../shared/errors-protocol';
import { isPtyId } from '../../shared/pty';
import type { LinkHandle } from './links';
import type { Timers } from './native';

export const RUNS_NOT_CONNECTED_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const RUNS_UNSUPPORTED_ERROR = 'Claude analysis needs an updated kineReqLens bridge — run `npm run mcp:install` in your reqlens checkout';
export const RUNS_HOST_GONE_ERROR = 'The Claude Code bridge disconnected';
export const FULL_MODE_REQUIRED_ERROR = 'Full mode is off — enable it in Settings → Claude Code → Errors view';
export const AUTO_MAX_PER_MINUTE = 3;
const MAX_OPS = 16;

export interface RunRelayDeps {
  send(message: RunToHost | OpToHost | ErrorsConfigToHost): boolean;
  connected(): boolean;
  /** The hub announced `runs`. */
  supported(): boolean;
  /** settings.claudeBridge. */
  enabled(): boolean;
  /** settings.errorsFullMode. */
  fullMode(): boolean;
  /** settings.autoAnalyzeErrors. */
  autoAnalyze(): boolean;
  timers?: Timers;
  now?(): number;
}

interface Pending {
  hostId: string;
  panelId: string;
  link: LinkHandle;
  kind: 'run' | 'op';
  /** A full-mode request (fix run or op). */
  full: boolean;
  timer: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RunRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private readonly autoStarts: number[] = [];
  private seq = 0;
  private lastConfig: boolean | null = null;

  constructor(private readonly deps: RunRelayDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Runs in flight. */
  get runs(): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.kind === 'run') n++;
    return n;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Tell the hub whether full mode is on (on every hello and settings change; `force` re-sends). */
  syncConfig(force = false): void {
    if (!this.deps.connected() || !this.deps.supported()) {
      this.lastConfig = null;
      return;
    }
    const fullMode = this.deps.enabled() && this.deps.fullMode();
    if (!force && this.lastConfig === fullMode) return;
    if (this.deps.send({ t: 'errors-config', fullMode })) this.lastConfig = fullMode;
  }

  /** A `run-*` / `op-*` message from a panel (unvalidated). */
  fromPanel(link: LinkHandle, raw: unknown): void {
    const message = parseRunToHost(raw);
    const rawId = (raw as { id?: unknown } | null)?.id;
    const rawT = (raw as { t?: unknown } | null)?.t;
    const failRaw = (error: string): void => {
      if (!isPtyId(rawId)) return;
      if (rawT === 'op-start') post(link, { t: 'op-done', id: rawId, ok: false, error });
      else post(link, { t: 'run-done', id: rawId, ok: false, code: null, error });
    };
    if (!message || message.t === 'errors-config') return failRaw('Invalid request');
    if (message.t === 'run-cancel') {
      for (const entry of this.pending.values()) {
        if (entry.link === link && entry.kind === 'run' && entry.panelId === message.id) {
          this.deps.send({ t: 'run-cancel', id: entry.hostId });
          return;
        }
      }
      return;
    }
    const isOp = message.t === 'op-start';
    const fail = (error: string): void => {
      if (isOp) post(link, { t: 'op-done', id: message.id, ok: false, error });
      else post(link, { t: 'run-done', id: message.id, ok: false, code: null, error });
    };
    if (!this.deps.enabled()) return fail('The Claude Code bridge is turned off in Settings → Claude Code');
    const full = isOp || (message.t === 'run-start' && message.kind === 'fix');
    if (full && !this.deps.fullMode()) return fail(FULL_MODE_REQUIRED_ERROR);
    for (const p of this.pending.values()) if (p.link === link && p.panelId === message.id) return fail('A request with this id is already pending');
    if (!isOp && this.runs >= RUN_MAX_CONCURRENT) return fail(`At most ${RUN_MAX_CONCURRENT} Claude runs at a time — wait for one to finish`);
    if (isOp && this.pending.size - this.runs >= MAX_OPS) return fail('Too many git operations at once — try again');
    if (message.t === 'run-start' && message.auto) {
      if (!this.deps.autoAnalyze() || message.kind !== 'analyze') return fail('Automatic analysis is off');
      const now = this.deps.now?.() ?? Date.now();
      while (this.autoStarts.length && now - this.autoStarts[0]! > 60_000) this.autoStarts.shift();
      if (this.autoStarts.length >= AUTO_MAX_PER_MINUTE) return fail('Automatic analysis paused: at most 3 per minute');
      this.autoStarts.push(now);
    }
    if (!this.deps.connected()) return fail(RUNS_NOT_CONNECTED_ERROR);
    if (!this.deps.supported()) return fail(RUNS_UNSUPPORTED_ERROR);
    // The hub must know the current mode before it sees the request.
    this.syncConfig();
    const hostId = `${isOp ? 'op' : 'run'}-${++this.seq}`;
    const entry: Pending = { hostId, panelId: message.id, link, kind: isOp ? 'op' : 'run', full, timer: null };
    this.pending.set(hostId, entry);
    if (!this.deps.send({ ...message, id: hostId })) {
      this.pending.delete(hostId);
      return fail(RUNS_NOT_CONNECTED_ERROR);
    }
    // Safety net: the hub ends runs itself after RUN_TIMEOUT_MS (plus the worktree setup).
    entry.timer = this.timers.setTimeout(
      () => {
        if (this.pending.get(hostId) !== entry) return;
        this.pending.delete(hostId);
        if (entry.kind === 'run') this.deps.send({ t: 'run-cancel', id: hostId });
        fail('The kineReqLens bridge did not answer in time');
      },
      isOp ? OP_TIMEOUT_MS : RUN_TIMEOUT_MS + 120_000,
    );
  }

  /** A message from the hub (validated). */
  fromHost(message: RunFromHost | OpFromHost): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.t === 'run-event') {
      if (entry.kind === 'run') post(entry.link, { ...message, id: entry.panelId });
      return;
    }
    if ((message.t === 'run-done') !== (entry.kind === 'run')) return;
    this.forget(entry);
    post(entry.link, { ...message, id: entry.panelId } as RunFromHost | OpFromHost);
  }

  /** A panel went away: cancel its runs, forget its ops. */
  linkClosed(link: LinkHandle): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.link !== link) continue;
      if (entry.kind === 'run') this.deps.send({ t: 'run-cancel', id: entry.hostId });
      this.forget(entry);
    }
  }

  /** The hub is gone: fail everything. */
  hostGone(error = RUNS_HOST_GONE_ERROR): void {
    this.lastConfig = null;
    for (const entry of [...this.pending.values()]) {
      this.forget(entry);
      if (entry.kind === 'op') post(entry.link, { t: 'op-done', id: entry.panelId, ok: false, error });
      else post(entry.link, { t: 'run-done', id: entry.panelId, ok: false, code: null, error });
    }
  }

  /** The bridge or full mode was turned off: cancel runs (fix runs too when full mode went off). */
  cancelAll(error: string, onlyFull = false): void {
    for (const entry of [...this.pending.values()]) {
      if (onlyFull && !entry.full) continue;
      if (entry.kind === 'run') this.deps.send({ t: 'run-cancel', id: entry.hostId });
      this.forget(entry);
      if (entry.kind === 'op') post(entry.link, { t: 'op-done', id: entry.panelId, ok: false, error });
      else post(entry.link, { t: 'run-done', id: entry.panelId, ok: false, code: null, error, cancelled: true });
    }
  }

  private forget(entry: Pending): void {
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    entry.timer = null;
    if (this.pending.get(entry.hostId) === entry) this.pending.delete(entry.hostId);
  }
}

function post(link: LinkHandle, message: WorkerToPanel): boolean {
  try {
    return link.post(message);
  } catch {
    return false;
  }
}
