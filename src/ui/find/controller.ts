// Find in page, panel side (docs/ARCHITECTURE.md §13): one controller per page connection. Each JSON viewer that
// opts in has a FindClient (its tree's candidates, computed lazily, and the results by JSON node id). Of the clients
// that want to scan (shown, setting on), the most recently activated one owns the page-side session: activating
// another one stops it (findStop) and starts the newcomer's (findStart); a hidden viewer stops observing the page.
// Results are applied by candidate and fanned out to every JSON node holding that value; subscribers are notified at
// most once per animation frame (no re-render storm while results stream in).
import type { JNode } from '../../shared/types';
import type { FindCallName, FindCalls, FindLocateResult, FindResult, FindScanStats, FindToPanel } from '../../shared/find-protocol';
import { collectCandidates, toWire } from '../../lib/findInPage';
import type { CandidateSet, FindCandidate } from '../../lib/findInPage';

/** What the panel's bridge offers for Find in page (RemoteBridge; the standalone tab has no page). */
export interface FindHost {
  find<M extends FindCallName>(method: M, ...args: Parameters<FindCalls[M]>): Promise<ReturnType<FindCalls[M]>>;
  onFindEvent(fn: (event: FindToPanel) => void): () => void;
}

export function isFindHost(value: unknown): value is FindHost {
  const v = value as Partial<FindHost> | null;
  return !!v && typeof v.find === 'function' && typeof v.onFindEvent === 'function';
}

/** A JSON node's value on the page. Identity-stable while its result does not change. */
export interface NodeFind {
  candidate: FindCandidate;
  result: FindResult;
}

export type FindPhase = 'idle' | 'scanning' | 'done' | 'error';

export interface FindSnapshot {
  phase: FindPhase;
  /** Distinct values found on the page. */
  found: number;
  /** Distinct values searched. */
  searched: number;
  /** Distinct values not searched (over the cap). */
  dropped: number;
  stats: FindScanStats | null;
  error: string | null;
  /** JSON node id → result (a new map whenever something changed). */
  byNode: ReadonlyMap<string, NodeFind>;
}

const EMPTY_MAP: ReadonlyMap<string, NodeFind> = new Map();
export const IDLE_SNAPSHOT: FindSnapshot = { phase: 'idle', found: 0, searched: 0, dropped: 0, stats: null, error: null, byNode: EMPTY_MAP };

let clientSeq = 0;
let scanSeq = 0;

/** One JSON viewer's side of Find in page. */
export class FindClient {
  readonly id = ++clientSeq;
  scanId: string | null = null;
  snapshot: FindSnapshot = IDLE_SNAPSHOT;
  private set: CandidateSet | null = null;
  private foundIds = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private readonly returnListeners = new Set<(nodeId: string) => void>();
  private frame = 0;
  /** Waiters for the end of the current pass (a locate retried after a re-scan). */
  private passWaiters: Array<() => void> = [];

  constructor(readonly root: JNode) {}

  /** The tree's candidates (collected on first use). */
  candidates(): CandidateSet {
    if (!this.set) this.set = collectCandidates(this.root);
    return this.set;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** "Back to kineReqLens" for a node of this client. */
  onReturn(fn: (nodeId: string) => void): () => void {
    this.returnListeners.add(fn);
    return () => {
      this.returnListeners.delete(fn);
    };
  }

  /** A new session for this client started. */
  begin(scanId: string): void {
    const set = this.candidates();
    this.scanId = scanId;
    this.foundIds = new Set();
    this.update({ ...IDLE_SNAPSHOT, phase: 'scanning', searched: set.candidates.length, dropped: set.dropped }, true);
  }

  /** The session ended (another viewer took over, hidden, setting off): no icons. */
  end(): void {
    this.scanId = null;
    this.foundIds = new Set();
    this.update(IDLE_SNAPSHOT, true);
    this.releaseWaiters();
  }

  fail(error: string): void {
    this.update({ ...this.snapshot, phase: 'error', error }, true);
    this.releaseWaiters();
  }

  /** A rescan was asked for: show it as scanning until its pass ends. */
  markScanning(): void {
    if (this.snapshot.phase !== 'idle') this.update({ ...this.snapshot, phase: 'scanning', error: null }, false);
  }

  /** Resolves when the current pass ends (or the session ends). */
  nextPass(): Promise<void> {
    return new Promise((resolve) => this.passWaiters.push(resolve));
  }

  apply(event: Extract<FindToPanel, { t: 'find-results' }>): void {
    const set = this.candidates();
    let byNode = this.snapshot.byNode;
    if (event.results.length > 0) {
      const next = new Map(byNode);
      for (const result of event.results) {
        const candidate = set.candidates[result.id];
        if (!candidate) continue;
        if (result.total > 0) {
          this.foundIds.add(result.id);
          const nf: NodeFind = { candidate, result };
          for (const nodeId of candidate.nodeIds) next.set(nodeId, nf);
        } else {
          this.foundIds.delete(result.id);
          for (const nodeId of candidate.nodeIds) next.delete(nodeId);
        }
      }
      byNode = next;
    }
    const phase: FindPhase = event.error ? 'error' : event.done ? 'done' : 'scanning';
    this.update(
      {
        ...this.snapshot,
        phase,
        error: event.error ?? null,
        found: this.foundIds.size,
        stats: event.stats ?? this.snapshot.stats,
        byNode,
      },
      false,
    );
    if (event.done) this.releaseWaiters();
  }

  emitReturn(nodeId: string): void {
    for (const fn of [...this.returnListeners]) {
      try {
        fn(nodeId);
      } catch (err) {
        console.error('[kineReqLens] find return failed', err);
      }
    }
  }

  private releaseWaiters(): void {
    const waiters = this.passWaiters;
    this.passWaiters = [];
    for (const fn of waiters) fn();
  }

  /** New snapshot; listeners hear about it once per animation frame (`now`: right away). */
  private update(next: FindSnapshot, now: boolean): void {
    this.snapshot = next;
    if (now) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.notify();
      return;
    }
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[kineReqLens] find listener failed', err);
      }
    }
  }
}

/** Owns the page-side session for the clients of one host. */
export class FindController {
  /** Clients that want to scan, most recently activated last. */
  private wanting: FindClient[] = [];
  private active: FindClient | null = null;

  constructor(
    private readonly host: FindHost,
    /** Extra locales for the page side (the "Site language" override), read when a scan starts. */
    private readonly localeHints: () => string[],
  ) {
    host.onFindEvent((event) => this.onEvent(event));
  }

  /** A client wants (or no longer wants) to scan. */
  want(client: FindClient, wanted: boolean): void {
    this.wanting = this.wanting.filter((c) => c !== client);
    if (wanted) this.wanting.push(client);
    this.reconcile();
  }

  /** Scan the page again for the active client. */
  rescan(client: FindClient): void {
    if (client !== this.active || !client.scanId) return;
    client.markScanning();
    void this.host.find('findRescan', client.scanId).catch(() => undefined);
  }

  /**
   * Show the value of `nodeId` on the page. Null when the client is not scanning. An expired session (the page side
   * lost it) is restarted once and the locate retried after its first pass.
   */
  async locate(client: FindClient, nodeId: string, path: string, snippet: string): Promise<FindLocateResult | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (client !== this.active || !client.scanId) return null;
      const nf = client.snapshot.byNode.get(nodeId);
      if (!nf) return null;
      const result = await this.host.find('findLocate', { scanId: client.scanId, candidateId: nf.candidate.id, nodeId, path, snippet });
      if (result.ok || result.reason !== 'expired' || attempt > 0) return result;
      const pass = client.nextPass();
      this.start(client);
      await pass;
    }
    return null;
  }

  private reconcile(): void {
    const next = this.wanting[this.wanting.length - 1] ?? null;
    if (next === this.active) return;
    const previous = this.active;
    this.active = next;
    if (previous) {
      if (previous.scanId) void this.host.find('findStop', previous.scanId).catch(() => undefined);
      previous.end();
    }
    if (next) this.start(next);
  }

  private start(client: FindClient): void {
    const scanId = `f${client.id}-${++scanSeq}`;
    client.begin(scanId);
    const set = client.candidates();
    if (set.candidates.length === 0) {
      client.apply({ t: 'find-results', scanId, results: [], done: true });
      return;
    }
    this.host
      .find('findStart', { scanId, candidates: toWire(set.candidates), locales: this.localeHints(), watch: true })
      .then(
        (answer) => {
          if (!answer?.ok && client.scanId === scanId) client.fail(answer?.error ?? 'Find in page is not available on this page');
        },
        (err: unknown) => {
          if (client.scanId === scanId) client.fail(err instanceof Error ? err.message : String(err));
        },
      );
  }

  private onEvent(event: FindToPanel): void {
    const client = this.active;
    if (!client || event.scanId !== client.scanId) return;
    if (event.t === 'find-results') client.apply(event);
    else client.emitReturn(event.nodeId);
  }
}

const controllers = new WeakMap<FindHost, FindController>();

/** The controller of `host` (created on first use with the locale hints reader). */
export function findControllerOf(host: FindHost, localeHints: () => string[]): FindController {
  let controller = controllers.get(host);
  if (!controller) {
    controller = new FindController(host, localeHints);
    controllers.set(host, controller);
  }
  return controller;
}
