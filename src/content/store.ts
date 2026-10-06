/**
 * Top-frame request store (docs/ARCHITECTURE.md §2.4). Pure: no chrome.* or DOM access — everything
 * environmental comes through `StoreDeps`, so it is unit-testable in Node.
 *
 *  - Hook 'start' -> entryFromHookStart, then absorbs an already-listed matching webRequest entry.
 *  - Hook 'end'   -> applyHookEnd (an end that overtakes its start, e.g. via the subframe relay, waits).
 *  - WR_ENTRIES   -> idempotent upserts; xhr/ping snapshots are swallowed when they belong to one of our
 *                    page-mode replays, merged into the matching hook entry, or listed otherwise.
 *  - Entries are immutable: an update replaces the object, unchanged entries keep their identity, and the
 *    array returned by getEntries() only changes when something changed.
 *  - Subscribers are notified coalesced through `deps.schedule`.
 */
import { MANUAL_BODY_CAP, WR_MATCH_WINDOW_MS } from '../shared/constants';
import type { HookRequestEnd, HookRequestStart, ManualEntryInit, RequestEntry } from '../shared/types';
import {
  applyHookEnd,
  capBody,
  entryFromHookStart,
  findHookMatch,
  findWebRequestMatch,
  isValidHookEnd,
  isValidHookStart,
  mergeWire,
  normalizeUrlForMatch,
  pickEvictions,
  WR_ORDER_SLACK_MS,
} from '../lib/capture';
import { uid } from '../lib/ids';
import { BoundedMap, BoundedSet } from './bounded';
import {
  cleanHookEnd,
  cleanHookStart,
  isRecord,
  isRequestEntryLike,
  sanitizeHeaders,
  sanitizeSerializedBody,
} from './validate';

/** Size limits applied by the store (from Settings). */
export interface StoreLimits {
  maxEntries: number;
  requestBodyCap: number;
  responseBodyCap: number;
}

/** Environment of the store (injected so it stays pure). */
export interface StoreDeps {
  /** Epoch milliseconds. */
  now(): number;
  /** Top-level page URL stamped on new entries. */
  pageUrl(): string;
  /** Current limits (read on every use, so settings changes apply immediately). */
  limits(): StoreLimits;
  /** Run `flush` later (the coalescing window). Called at most once per pending notification. */
  schedule(flush: () => void): void;
  /** URL of a blank manual entry (defaults to the page origin). */
  defaultManualUrl(): string;
}

/** A page-mode replay whose own webRequest event must not be listed. */
export interface ReplayRegistration {
  runId: string;
  method: string;
  url: string;
  /** Epoch ms when the replay was dispatched. */
  start: number;
}

interface PendingReplay {
  runId: string;
  method: string;
  normalizedUrl: string;
  start: number;
  expiresAt: number;
  /** Its own request was already swallowed; it only keeps matching CORS preflights (until it expires). */
  consumed: boolean;
}

/** Ids a UI may choose for manual entries. */
const MANUAL_ID = /^m:[A-Za-z0-9_-]{1,64}$/;
const TOMBSTONE_CAPACITY = 5000;
const LINK_CAPACITY = 5000;
const ORPHAN_END_CAPACITY = 200;
/** A replay that never completes stops swallowing after this. */
const REPLAY_MAX_AGE_MS = 10 * 60_000;
/** After a replay completes, its webRequest snapshots may still be in flight (150 ms batches). */
const REPLAY_GRACE_MS = 10_000;

/** Store id of a hook capture. */
export function hookEntryId(frameId: number, hookId: string): string {
  return `h:${frameId}:${hookId}`;
}

function isFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function safeNormalize(url: string): string {
  try {
    return normalizeUrlForMatch(url);
  } catch {
    return url;
  }
}

/** True for ids a UI may choose for a manual entry (`m:` + 1..64 of [A-Za-z0-9_-]). */
export function isManualId(id: unknown): id is string {
  return typeof id === 'string' && MANUAL_ID.test(id);
}

/**
 * The manual entry `init` describes (headers/body validated, body capped at MANUAL_BODY_CAP): what
 * RequestStore.addManual stores, and what a remote UI shows until the store's copy arrives.
 */
export function buildManualEntry(
  init: ManualEntryInit | undefined,
  ctx: { id: string; pageUrl: string; defaultUrl: string; now: number },
): RequestEntry {
  const method = typeof init?.method === 'string' && init.method.trim() ? init.method.trim() : 'GET';
  const url = typeof init?.url === 'string' && init.url.trim() ? init.url.trim() : ctx.defaultUrl;
  const body = init?.body ? sanitizeSerializedBody(init.body) : null;
  const contentType =
    typeof init?.contentType === 'string' && init.contentType.trim() ? init.contentType.trim().slice(0, 1024) : null;
  return {
    id: ctx.id,
    source: 'manual',
    kind: 'manual',
    frameId: 0,
    pageUrl: ctx.pageUrl,
    method,
    url,
    requestHeaders: init?.headers ? sanitizeHeaders(init.headers) : [],
    requestBody: body ? capBody(body, MANUAL_BODY_CAP) : null,
    requestContentType: contentType,
    startTime: ctx.now,
    state: 'done',
  };
}

/** Captured entries of the page, merged from hook captures and webRequest snapshots. */
export class RequestStore {
  private readonly entries = new Map<string, RequestEntry>();
  private sorted: RequestEntry[] | null = [];
  private readonly listeners = new Set<() => void>();
  private flushPending = false;
  private disposed = false;
  /** webRequest requestId -> hook entry id it was merged into. */
  private readonly wireLinks = new BoundedMap<string, string>(LINK_CAPACITY);
  /** requestIds of our own replays: every snapshot of them is dropped. */
  private readonly swallowed = new BoundedSet<string>(TOMBSTONE_CAPACITY);
  /** Ids removed by clear()/eviction: late updates must not resurrect them. */
  private readonly tombstones = new BoundedSet<string>(TOMBSTONE_CAPACITY);
  private readonly orphanEnds = new BoundedMap<string, HookRequestEnd>(ORPHAN_END_CAPACITY);
  private readonly replays = new Map<string, PendingReplay>();
  /** Entries the UI holds work for (never evicted). */
  private protectedIds: ReadonlySet<string> = new Set();

  constructor(private readonly deps: StoreDeps) {}

  // -------------------------------------------------------------------------------------------
  // Reading & subscriptions
  // -------------------------------------------------------------------------------------------

  /**
   * All entries, oldest first (by startTime, then arrival). The same array instance is returned until the
   * next change; callers must not mutate it.
   */
  getEntries(): RequestEntry[] {
    if (!this.sorted) {
      const list = Array.from(this.entries.values());
      list.sort((a, b) => a.startTime - b.startTime);
      this.sorted = list;
    }
    return this.sorted;
  }

  get(id: string): RequestEntry | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Coalesced change notifications. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------------------------
  // Hook captures (untrusted MAIN-world data)
  // -------------------------------------------------------------------------------------------

  /** Route a raw HookToContent message ('start' / 'end'; anything else is ignored). */
  handleHookMessage(frameId: number, message: unknown, frameUrl?: string): void {
    if (!isRecord(message)) return;
    if (message.t === 'start') this.handleHookStart(frameId, message.data, frameUrl);
    else if (message.t === 'end') this.handleHookEnd(frameId, message.data);
  }

  handleHookStart(frameId: number, data: unknown, frameUrl?: string): void {
    if (this.disposed || !isFrameId(frameId) || !isValidHookStart(data)) return;
    const id = hookEntryId(frameId, data.hookId);
    if (this.entries.has(id) || this.tombstones.has(id)) return;
    const cap = this.deps.limits().requestBodyCap;
    const start: HookRequestStart = cleanHookStart(data, (body) => capBody(body, cap), frameUrl ?? '');
    let entry = entryFromHookStart(frameId, start, this.deps.pageUrl());
    if (entry.id !== id) entry = { ...entry, id };
    const wrId = findWebRequestMatch(this.entries.values(), entry, WR_MATCH_WINDOW_MS);
    const wr = wrId ? this.entries.get(wrId) : undefined;
    if (wrId && wr) {
      entry = mergeWire(entry, wr);
      this.entries.delete(wrId);
      if (wr.wire) this.wireLinks.set(wr.wire.requestId, id);
    }
    const early = this.orphanEnds.take(id);
    if (early) entry = applyHookEnd(entry, early);
    this.entries.set(id, entry);
    this.changed();
    this.enforceLimit();
  }

  handleHookEnd(frameId: number, data: unknown): void {
    if (this.disposed || !isFrameId(frameId) || !isValidHookEnd(data)) return;
    const id = hookEntryId(frameId, data.hookId);
    const cap = this.deps.limits().responseBodyCap;
    const end: HookRequestEnd = cleanHookEnd(data, (body) => capBody(body, cap));
    const entry = this.entries.get(id);
    if (!entry) {
      if (!this.tombstones.has(id)) this.orphanEnds.set(id, end);
      return;
    }
    this.entries.set(id, applyHookEnd(entry, end));
    this.changed();
  }

  // -------------------------------------------------------------------------------------------
  // webRequest snapshots (service worker)
  // -------------------------------------------------------------------------------------------

  /** Upsert full webRequest entry snapshots (idempotent). */
  upsertWebRequest(list: unknown): void {
    if (this.disposed || !Array.isArray(list)) return;
    let changed = false;
    for (const item of list) {
      if (isRequestEntryLike(item) && item.source === 'webRequest' && this.upsertOne(item)) changed = true;
    }
    if (changed) {
      this.changed();
      this.enforceLimit();
    }
  }

  private upsertOne(snapshot: RequestEntry): boolean {
    const requestId = snapshot.wire?.requestId;
    if (requestId !== undefined) {
      if (this.swallowed.has(requestId)) return false;
      const linkedId = this.wireLinks.get(requestId);
      if (linkedId !== undefined) {
        const hook = this.entries.get(linkedId);
        if (!hook) return false; // cleared or evicted: do not resurrect
        this.entries.set(linkedId, mergeWire(hook, snapshot));
        return true;
      }
      if (snapshot.kind === 'xhr' || snapshot.kind === 'ping') {
        if (this.matchesReplay(snapshot)) {
          this.swallowed.add(requestId);
          return this.entries.delete(snapshot.id);
        }
        const hookId = findHookMatch(this.entries.values(), snapshot, WR_MATCH_WINDOW_MS);
        const hook = hookId ? this.entries.get(hookId) : undefined;
        if (hookId && hook) {
          this.wireLinks.set(requestId, hookId);
          this.entries.set(hookId, mergeWire(hook, snapshot));
          this.entries.delete(snapshot.id);
          return true;
        }
      }
    }
    if (this.tombstones.has(snapshot.id)) return false;
    const existing = this.entries.get(snapshot.id);
    const pageUrl = existing?.pageUrl || snapshot.pageUrl || this.deps.pageUrl();
    this.entries.set(snapshot.id, snapshot.pageUrl === pageUrl ? snapshot : { ...snapshot, pageUrl });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Replays
  // -------------------------------------------------------------------------------------------

  /** Register a page-mode replay before dispatching it, so its own webRequest event is swallowed. */
  registerReplay(registration: ReplayRegistration): void {
    this.pruneReplays();
    this.replays.set(registration.runId, {
      runId: registration.runId,
      method: registration.method.toUpperCase(),
      normalizedUrl: safeNormalize(registration.url),
      start: registration.start,
      expiresAt: registration.start + REPLAY_MAX_AGE_MS,
      consumed: false,
    });
  }

  /** The replay finished: keep swallowing for a grace period (late webRequest batches), then forget it. */
  completeReplay(runId: string): void {
    const replay = this.replays.get(runId);
    if (replay) replay.expiresAt = Math.min(replay.expiresAt, this.deps.now() + REPLAY_GRACE_MS);
  }

  private pruneReplays(): void {
    const now = this.deps.now();
    for (const [runId, replay] of this.replays) if (replay.expiresAt < now) this.replays.delete(runId);
  }

  /**
   * True when `snapshot` is the network side of a registered replay (same method, URL, close start time;
   * the registration is consumed) or its CORS preflight (OPTIONS, before or after the main request: Chrome
   * reports the actual request's onBeforeRequest before it sends the preflight).
   */
  private matchesReplay(snapshot: RequestEntry): boolean {
    if (this.replays.size === 0) return false;
    this.pruneReplays();
    const url = safeNormalize(snapshot.url);
    const method = snapshot.method.toUpperCase();
    let best: PendingReplay | null = null;
    let bestDiff = Infinity;
    let preflight = false;
    for (const replay of this.replays.values()) {
      if (replay.normalizedUrl !== url) continue;
      // A network request that started before the replay was dispatched is not the replay's (it is the page's
      // own identical request, whose snapshot may arrive after the replay started).
      if (snapshot.startTime < replay.start - WR_ORDER_SLACK_MS) continue;
      const diff = snapshot.startTime - replay.start;
      if (diff > WR_MATCH_WINDOW_MS) continue;
      if (replay.method === method) {
        if (!replay.consumed && diff < bestDiff) {
          best = replay;
          bestDiff = diff;
        }
      } else if (method === 'OPTIONS') {
        preflight = true;
      }
    }
    if (best) {
      best.consumed = true;
      return true;
    }
    return preflight;
  }

  // -------------------------------------------------------------------------------------------
  // Manual / restored / adopted entries
  // -------------------------------------------------------------------------------------------

  /**
   * A user-composed request: blank, or built from `init` (headers/body validated, body capped at
   * MANUAL_BODY_CAP — a duplicate keeps the body it would be sent with, which may exceed the capture cap).
   */
  addManual(init?: ManualEntryInit): RequestEntry {
    const wanted = typeof init?.id === 'string' && MANUAL_ID.test(init.id) && !this.entries.has(init.id) && !this.tombstones.has(init.id);
    const entry = buildManualEntry(init, {
      id: wanted ? (init!.id as string) : uid('m:'),
      pageUrl: this.deps.pageUrl(),
      defaultUrl: this.deps.defaultManualUrl(),
      now: this.deps.now(),
    });
    this.entries.set(entry.id, entry);
    this.changed();
    this.enforceLimit();
    return entry;
  }

  /**
   * Entries of a preserved log from a previous page load. Ids get the "r:" prefix; entries already present
   * (by restored or original id, or merged into a hook entry) are skipped; unfinished ones become aborted.
   * Returns how many were added.
   */
  addRestored(list: unknown): number {
    if (this.disposed || !Array.isArray(list)) return 0;
    let added = 0;
    for (const item of list) {
      if (!isRequestEntryLike(item)) continue;
      const id = item.id.startsWith('r:') ? item.id : `r:${item.id}`;
      const originalId = id.slice(2);
      const requestId = item.wire?.requestId;
      if (this.entries.has(id) || this.entries.has(originalId) || this.tombstones.has(id)) continue;
      if (requestId !== undefined && (this.wireLinks.has(requestId) || this.swallowed.has(requestId))) continue;
      if (requestId !== undefined && item.source === 'hook') {
        // The worker hands a previous page's webRequest entries over as restored too (with preserve log): the
        // page's own capture of the same request (merged with it) replaces that copy, and later snapshots of
        // the request keep merging into it.
        const wrId = `w:${requestId}`;
        if (this.entries.get(wrId)?.restored) this.entries.delete(wrId);
        this.wireLinks.set(requestId, id);
      }
      const entry: RequestEntry = { ...item, id, restored: true };
      if (entry.state === 'pending') {
        entry.state = 'aborted';
        entry.error = entry.error ?? 'Did not finish before the page was unloaded';
      }
      this.entries.set(id, entry);
      added++;
    }
    if (added) {
      this.changed();
      this.enforceLimit();
    }
    return added;
  }

  /** Take over the entries of a replaced content-script instance (same ids, same objects when valid). */
  adopt(list: unknown): void {
    if (this.disposed || !Array.isArray(list)) return;
    let added = false;
    for (const item of list) {
      if (isRequestEntryLike(item) && !this.entries.has(item.id)) {
        this.entries.set(item.id, item);
        added = true;
      }
    }
    if (added) {
      this.changed();
      this.enforceLimit();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------------------------

  /** Remove every entry; in-flight updates for them are dropped. */
  clear(): void {
    if (this.entries.size === 0 && this.orphanEnds.size === 0) return;
    for (const id of this.entries.keys()) this.tombstones.add(id);
    this.entries.clear();
    this.orphanEnds.clear();
    this.changed();
  }

  /** Entries the UI holds work for: never evicted (manual entries never are either). */
  setProtected(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (typeof id === 'string' && next.size < 100_000) next.add(id);
    this.protectedIds = next;
  }

  /**
   * webRequest entries still pending when tracking stopped (the overlay was closed: the worker drops the
   * tab's buffer and ignores later events) would show a spinner forever: settle them as aborted with `reason`.
   * Returns how many were settled.
   */
  settlePendingWebRequest(reason: string): number {
    if (this.disposed) return 0;
    const now = this.deps.now();
    let settled = 0;
    for (const [id, entry] of this.entries) {
      if (entry.source !== 'webRequest' || entry.state !== 'pending') continue;
      this.entries.set(id, { ...entry, state: 'aborted', endTime: Math.max(now, entry.startTime), error: reason });
      settled++;
    }
    if (settled) this.changed();
    return settled;
  }

  /**
   * Evict beyond `limits().maxEntries` (static resources first, then oldest). Returns true if any.
   * Internal callers mark their own mutation with `changed()` first: that invalidates the sorted cache read here.
   */
  enforceLimit(): boolean {
    const max = Math.max(1, Math.floor(this.deps.limits().maxEntries));
    if (this.entries.size <= max) return false;
    const victims = pickEvictions(this.getEntries(), max, this.protectedIds);
    let removed = false;
    for (const id of victims) {
      if (this.entries.delete(id)) {
        this.tombstones.add(id);
        removed = true;
      }
    }
    if (removed) this.changed();
    return removed;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.replays.clear();
  }

  private changed(): void {
    this.sorted = null;
    if (this.flushPending || this.disposed) return;
    this.flushPending = true;
    this.deps.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushPending = false;
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* a failing subscriber must not starve the others */
      }
    }
  }
}
