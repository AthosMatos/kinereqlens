// Panel-side WebSocket state: the mirror (WsInspector) fed by the host's 'ws' messages, and the lookup the
// views use. RemoteBridge (panel/remote.ts) owns one RemoteWs; any other WsBridge (tests, in-page bridge) gets an
// inspector that follows its snapshot + deltas.
import type { WsBridge, WsDelta, WsFrame, WsSendResult } from '../../lib/ws';
import { WsInspector } from '../../lib/ws-inspector';

type Call = (method: 'wsClear' | 'wsSend', args: unknown[]) => Promise<unknown>;

/** WsBridge of the panel: mirrors the host's deltas into a WsInspector, forwards actions over the port. */
export class RemoteWs implements WsBridge {
  readonly inspector = new WsInspector();
  private readonly listeners = new Set<(delta: WsDelta) => void>();

  constructor(private readonly call: Call) {}

  /** A 'ws' message from the host. */
  receive(delta: WsDelta): void {
    if (!delta || typeof delta !== 'object') return;
    this.inspector.apply(delta);
    for (const fn of [...this.listeners]) {
      try {
        fn(delta);
      } catch (err) {
        console.error('[kineReqLens] ws listener failed', err);
      }
    }
  }

  snapshot(): WsDelta {
    return snapshotOf(this.inspector);
  }

  subscribe(fn: (delta: WsDelta) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  clear(): void {
    void this.call('wsClear', []).catch(() => undefined);
  }

  async send(wsId: string, text: string): Promise<WsSendResult> {
    try {
      const result = (await this.call('wsSend', [wsId, text])) as WsSendResult | null;
      return result && typeof result === 'object' && typeof result.ok === 'boolean' ? result : { ok: false, error: 'No answer' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function snapshotOf(inspector: WsInspector): WsDelta {
  const connections = inspector.connections().slice();
  const frames: WsFrame[] = [];
  for (const c of connections) frames.push(...inspector.frames(c.wsId));
  frames.sort((a, b) => a.id - b.id);
  return { reset: true, connections, frames, removed: [] };
}

const followers = new WeakMap<WsBridge, WsInspector>();

/** The inspector mirroring `ws` (RemoteWs: its own; other bridges: one created on first use). */
export function wsInspectorOf(ws: WsBridge): WsInspector {
  if (ws instanceof RemoteWs) return ws.inspector;
  let inspector = followers.get(ws);
  if (!inspector) {
    const created = new WsInspector();
    created.apply(ws.snapshot());
    ws.subscribe((delta) => created.apply(delta));
    followers.set(ws, created);
    inspector = created;
  }
  return inspector;
}
