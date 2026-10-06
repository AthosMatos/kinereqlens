// "Send to Claude" screenshots, service-worker side (src/shared/shot-protocol.ts): relays the `shot-save` chunks of a
// panel to the hub, which writes the PNG to $REQLENS_HOME/shots, and the answer (`shot-saved` with the absolute path,
// or `shot-error`) back to that panel only.
//
//  - Every chunk is validated; uploads get a worker-chosen file id towards the hub (`shot-<hex>`), so panels can
//    neither collide nor name files, and must arrive in order.
//  - Bounded: SHOT_MAX_UPLOADS_PER_LINK per panel, SHOT_MAX_UPLOADS overall; an upload that stalls (no chunk / no
//    answer within SHOT_UPLOAD_TIMEOUT_MS) fails. A panel going away drops its uploads; the hub going away fails all.
//  - The paths the hub reported are remembered (bounded): an inbox item may only point Claude at those.
import type { WorkerToPanel } from '../../shared/claude-link';
import { isPtyId } from '../../shared/pty';
import { SHOT_UNSUPPORTED_ERROR, SHOT_UPLOAD_TIMEOUT_MS, newShotFileId, parseShotToHost } from '../../shared/shot-protocol';
import type { ShotFromHost, ShotToHost } from '../../shared/shot-protocol';
import type { LinkHandle } from './links';
import type { Timers } from './native';

export const SHOT_MAX_UPLOADS_PER_LINK = 2;
export const SHOT_MAX_UPLOADS = 4;
/** Paths remembered for inbox items. */
export const SHOT_MAX_SAVED_PATHS = 200;
export const SHOT_NOT_CONNECTED_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const SHOT_HOST_GONE_ERROR = 'The Claude Code bridge disconnected';
export const SHOT_TIMEOUT_ERROR = 'The kineReqLens bridge did not answer in time';

export interface ShotRelayDeps {
  /** Send to the hub; false when the bridge is not connected. */
  send(message: ShotToHost): boolean;
  connected(): boolean;
  /** The connected hub serves `shot-save` (announced in its hello). */
  supported(): boolean;
  /** settings.claudeBridge is on. */
  enabled?(): boolean;
  timers?: Timers;
  timeoutMs?: number;
  newId?(): string;
}

interface Upload {
  hostId: string;
  panelId: string;
  link: LinkHandle;
  total: number;
  /** Next expected chunk index (total = all sent, waiting for the hub). */
  next: number;
  timer: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ShotRelay {
  private readonly uploads = new Map<string, Upload>();
  private readonly saved = new Set<string>();
  private readonly timers: Timers;

  constructor(private readonly deps: ShotRelayDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Uploads in progress. */
  get size(): number {
    return this.uploads.size;
  }

  /** A path the hub reported for a screenshot it saved (recently). */
  knows(path: string): boolean {
    return this.saved.has(path);
  }

  /** A `shot-*` message from a panel (unvalidated). */
  fromPanel(link: LinkHandle, raw: unknown): void {
    const message = parseShotToHost(raw);
    const rawId = (raw as { id?: unknown } | null)?.id;
    if (!message) {
      if (isPtyId(rawId)) {
        const upload = this.find(link, rawId);
        if (upload) this.forget(upload);
        post(link, { t: 'shot-error', id: rawId, error: 'Invalid screenshot data' });
      }
      return;
    }
    const fail = (error: string, upload?: Upload): void => {
      if (upload) this.forget(upload);
      post(link, { t: 'shot-error', id: message.id, error });
    };
    let upload = this.find(link, message.id);
    if (message.seq === 0) {
      if (upload) return fail('A screenshot with this id is already being sent', upload);
      if (this.deps.enabled && !this.deps.enabled()) return fail('The Claude Code bridge is turned off in Settings → Claude Code');
      let mine = 0;
      for (const u of this.uploads.values()) if (u.link === link) mine++;
      if (mine >= SHOT_MAX_UPLOADS_PER_LINK || this.uploads.size >= SHOT_MAX_UPLOADS) return fail('Too many screenshots at once — try again');
      if (!this.deps.connected()) return fail(SHOT_NOT_CONNECTED_ERROR);
      if (!this.deps.supported()) return fail(SHOT_UNSUPPORTED_ERROR);
      upload = { hostId: (this.deps.newId ?? newShotFileId)(), panelId: message.id, link, total: message.total, next: 0, timer: null };
      this.uploads.set(upload.hostId, upload);
    } else if (!upload) {
      return fail('Unknown screenshot upload');
    }
    if (message.seq !== upload.next || message.total !== upload.total) return fail('Screenshot chunks out of order', upload);
    if (!this.deps.send({ ...message, id: upload.hostId })) return fail(SHOT_NOT_CONNECTED_ERROR, upload);
    upload.next++;
    this.arm(upload);
  }

  /** An answer from the hub (validated). */
  fromHost(message: ShotFromHost): void {
    const upload = this.uploads.get(message.id);
    if (!upload) return;
    this.forget(upload);
    if (message.t === 'shot-saved') {
      if (upload.next < upload.total) {
        post(upload.link, { t: 'shot-error', id: upload.panelId, error: 'Unexpected answer from the kineReqLens bridge' });
        return;
      }
      this.remember(message.path);
      post(upload.link, { ...message, id: upload.panelId });
      return;
    }
    post(upload.link, { ...message, id: upload.panelId });
  }

  /** A panel went away: drop its uploads. */
  linkClosed(link: LinkHandle): void {
    for (const upload of [...this.uploads.values()]) if (upload.link === link) this.forget(upload);
  }

  /** The hub is gone (native port closed / bridge off): fail every upload. */
  hostGone(error = SHOT_HOST_GONE_ERROR): void {
    for (const upload of [...this.uploads.values()]) {
      this.forget(upload);
      post(upload.link, { t: 'shot-error', id: upload.panelId, error });
    }
  }

  private find(link: LinkHandle, panelId: string): Upload | undefined {
    for (const upload of this.uploads.values()) if (upload.link === link && upload.panelId === panelId) return upload;
    return undefined;
  }

  private arm(upload: Upload): void {
    if (upload.timer !== null) this.timers.clearTimeout(upload.timer);
    upload.timer = this.timers.setTimeout(() => {
      if (this.uploads.get(upload.hostId) !== upload) return;
      this.forget(upload);
      post(upload.link, { t: 'shot-error', id: upload.panelId, error: SHOT_TIMEOUT_ERROR });
    }, this.deps.timeoutMs ?? SHOT_UPLOAD_TIMEOUT_MS);
  }

  private forget(upload: Upload): void {
    if (upload.timer !== null) this.timers.clearTimeout(upload.timer);
    upload.timer = null;
    if (this.uploads.get(upload.hostId) === upload) this.uploads.delete(upload.hostId);
  }

  private remember(path: string): void {
    this.saved.delete(path);
    this.saved.add(path);
    while (this.saved.size > SHOT_MAX_SAVED_PATHS) {
      const oldest = this.saved.values().next().value;
      if (oldest === undefined) break;
      this.saved.delete(oldest);
    }
  }
}

function post(link: LinkHandle, message: WorkerToPanel): boolean {
  try {
    return link.post(message);
  } catch {
    return false;
  }
}
