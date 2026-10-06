// Folder browser of the embedded terminal, service-worker side (docs/CLAUDE_INTEGRATION.md "Working
// directory"): relays `fs-*` requests from the panel links (./links.ts) to the hub's native port (./native.ts)
// and the answers back to the panel that asked — and only to it.
//
//  - Every request is validated (src/shared/fs.ts) and gets a worker-chosen id towards the hub, so panels can
//    neither collide nor see each other's answers; unknown answers are dropped.
//  - Each request has a timeout (the hub may be busy or an old hub may drop the message): the panel then gets
//    an `fs-error`. Requests of a panel that went away are forgotten; the hub going away fails them all.
//  - Bounded: FS_MAX_PENDING_PER_LINK per panel, FS_MAX_PENDING overall, one open native chooser per panel.
import type { WorkerToPanel } from '../../shared/claude-link';
import { FS_LIST_TIMEOUT_MS, FS_PICK_TIMEOUT_MS, FS_PROJECTS_TIMEOUT_MS } from '../../shared/claude-protocol';
import type { FsFromHost, FsToHost } from '../../shared/claude-protocol';
import { FS_UNSUPPORTED_ERROR, parseFsToHost } from '../../shared/fs';
import { isPtyId } from '../../shared/pty';
import type { LinkHandle } from './links';
import type { Timers } from './native';

export const FS_MAX_PENDING_PER_LINK = 8;
export const FS_MAX_PENDING = 32;
export const FS_NOT_CONNECTED_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const FS_HOST_GONE_ERROR = 'The Claude Code bridge disconnected';
export const FS_TIMEOUT_ERROR = 'The kineReqLens bridge did not answer in time';

export interface FsRelayDeps {
  /** Send to the hub; false when the bridge is not connected. */
  send(message: FsToHost): boolean;
  /** The native port is connected to the hub. */
  connected(): boolean;
  /** The connected hub serves `fs-*` (announced in its hello; older hubs drop them). */
  supported(): boolean;
  /** settings.claudeBridge is on (the hub may be running for React Native only). */
  enabled?(): boolean;
  timers?: Timers;
  /** Per request type (tests). */
  timeouts?: Partial<Record<FsToHost['t'], number>>;
}

interface Pending {
  hostId: string;
  panelId: string;
  link: LinkHandle;
  kind: FsToHost['t'];
  timer: unknown;
}

const DEFAULT_TIMEOUTS: Record<FsToHost['t'], number> = {
  'fs-list': FS_LIST_TIMEOUT_MS,
  'fs-pick': FS_PICK_TIMEOUT_MS,
  'fs-projects': FS_PROJECTS_TIMEOUT_MS,
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Which panel asked what, with timeouts. */
export class FsRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private seq = 0;

  constructor(private readonly deps: FsRelayDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Requests waiting for the hub. */
  get size(): number {
    return this.pending.size;
  }

  /** An `fs-*` message from a panel (unvalidated). */
  fromPanel(link: LinkHandle, raw: unknown): void {
    const message = parseFsToHost(raw);
    if (!message) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (isPtyId(id)) post(link, { t: 'fs-error', id, error: 'Invalid folder request' });
      return;
    }
    const fail = (error: string): void => void post(link, { t: 'fs-error', id: message.id, error });
    if (this.deps.enabled && !this.deps.enabled()) return fail('The Claude Code bridge is turned off in Settings → Claude Code');
    let mine = 0;
    for (const p of this.pending.values()) {
      if (p.link !== link) continue;
      mine++;
      if (p.panelId === message.id) return fail('A folder request with this id is already pending');
      if (message.t === 'fs-pick' && p.kind === 'fs-pick') return fail('The folder chooser is already open');
    }
    if (mine >= FS_MAX_PENDING_PER_LINK || this.pending.size >= FS_MAX_PENDING) return fail('Too many folder requests at once — try again');
    if (!this.deps.connected()) return fail(FS_NOT_CONNECTED_ERROR);
    if (!this.deps.supported()) return fail(FS_UNSUPPORTED_ERROR);
    const hostId = `fs-${++this.seq}`;
    const entry: Pending = { hostId, panelId: message.id, link, kind: message.t, timer: null };
    this.pending.set(hostId, entry);
    if (!this.deps.send({ ...message, id: hostId })) {
      this.pending.delete(hostId);
      return fail(FS_NOT_CONNECTED_ERROR);
    }
    const ms = this.deps.timeouts?.[message.t] ?? DEFAULT_TIMEOUTS[message.t];
    entry.timer = this.timers.setTimeout(() => {
      if (this.pending.get(hostId) !== entry) return;
      this.pending.delete(hostId);
      post(link, { t: 'fs-error', id: entry.panelId, error: FS_TIMEOUT_ERROR });
    }, ms);
  }

  /** An answer from the hub (validated). */
  fromHost(message: FsFromHost): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    // fs-picked answers fs-pick only, and so on; anything else (or fs-error) ends the request too.
    const expected = entry.kind === 'fs-list' ? 'fs-listed' : entry.kind === 'fs-pick' ? 'fs-picked' : 'fs-projects-listed';
    this.forget(entry);
    if (message.t !== expected && message.t !== 'fs-error') {
      post(entry.link, { t: 'fs-error', id: entry.panelId, error: 'Unexpected answer from the kineReqLens bridge' });
      return;
    }
    post(entry.link, { ...message, id: entry.panelId } as FsFromHost);
  }

  /** A panel went away: drop its requests (answers arriving later are ignored). */
  linkClosed(link: LinkHandle): void {
    for (const entry of [...this.pending.values()]) if (entry.link === link) this.forget(entry);
  }

  /** The hub is gone (native port closed / bridge off): fail every request. */
  hostGone(error = FS_HOST_GONE_ERROR): void {
    for (const entry of [...this.pending.values()]) {
      this.forget(entry);
      post(entry.link, { t: 'fs-error', id: entry.panelId, error });
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
