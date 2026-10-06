/**
 * Top-frame WebSocket store: validated hook events (MAIN world, untrusted) of every frame go into a WsRecorder
 * (src/lib/ws.ts: bounded rings, global caps); subscribers (the frame host serving the panel) get coalesced
 * deltas. Pure apart from the injected scheduler and hook sender, so it is unit-testable.
 */
import type { WsBridge, WsDelta, WsLimits, WsSendResult } from '../lib/ws';
import { DEFAULT_WS_LIMITS, WsRecorder } from '../lib/ws';

/** Messages typed in the overlay are bounded (the page's own sends are not). */
export const WS_SEND_MAX_CHARS = 1024 * 1024;

export interface WsStoreDeps {
  /** Run `flush` later (coalescing window). */
  schedule(flush: () => void): void;
  /** Send through the top frame's hook (`hookId` = the hook's socket id). */
  send(hookId: string, text: string): Promise<WsSendResult>;
  limits?: WsLimits;
}

export class WsStore implements WsBridge {
  private readonly recorder: WsRecorder;
  private readonly listeners = new Set<(delta: WsDelta) => void>();
  private scheduled = false;
  private disposed = false;

  constructor(private readonly deps: WsStoreDeps) {
    this.recorder = new WsRecorder(deps.limits ?? DEFAULT_WS_LIMITS);
  }

  /** Connections kept. */
  get size(): number {
    return this.recorder.log.size;
  }

  /** Untrusted events of frame `frameId`. New sockets and frames only count while `capturing`. */
  handle(frameId: number, events: unknown, options: { capturing: boolean; frameUrl?: string }): void {
    if (this.disposed) return;
    if (this.recorder.apply(frameId, events, options)) this.schedule();
  }

  snapshot(): WsDelta {
    return this.recorder.snapshot();
  }

  subscribe(fn: (delta: WsDelta) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  clear(): void {
    if (this.disposed) return;
    this.recorder.clear();
    this.schedule();
  }

  async send(wsId: string, text: string): Promise<WsSendResult> {
    if (typeof wsId !== 'string' || typeof text !== 'string') return { ok: false, error: 'Invalid message' };
    if (text.length > WS_SEND_MAX_CHARS) return { ok: false, error: 'The message is too long (max 1 MB)' };
    const conn = this.recorder.log.getConnection(wsId);
    if (!conn) return { ok: false, error: 'Unknown connection' };
    if (conn.frameId !== 0) return { ok: false, error: 'Sending is only available for sockets of the top frame' };
    if (conn.state !== 'open') return { ok: false, error: 'The connection is not open' };
    const hookId = wsId.slice(wsId.indexOf(':') + 1);
    try {
      return await this.deps.send(hookId, text);
    } catch {
      return { ok: false, error: 'The page did not answer' };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.schedule(() => {
      this.scheduled = false;
      const delta = this.recorder.takeDelta();
      if (!delta) return;
      for (const fn of [...this.listeners]) {
        try {
          fn(delta);
        } catch {
          /* a failing subscriber must not starve the others */
        }
      }
    });
  }
}
