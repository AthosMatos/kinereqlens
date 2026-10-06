// chrome.webRequest capture: per-tab entry assembly, the per-tab buffer returned by GET_TAB_STATE, and the
// 150 ms batched WR_ENTRIES flush to the top document.
//
// Entries are attributed to the top-level *document* they belong to (webRequest `documentId` /
// `parentDocumentId`), not only to the tab:
//  - a request of document D (or of a subframe inside D) is flushed to D only (`sendMessage({documentId})`),
//    so the outgoing page never lists the next page's requests and vice versa;
//  - a top-level navigation request belongs to no document yet: it is held until a new top document reports
//    in (GET_TAB_STATE → attachDocument) or, when the navigation never commits (download, 204, error), it is
//    handed to the current document once it settled;
//  - when a new top document attaches, entries of other documents are dropped (or, with preserve log on,
//    handed over marked as restored with their page URL), so late unload beacons of the previous page are
//    never listed as the new page's own requests.
import type { RequestEntry } from '../shared/types';
import { withoutCredentials } from '../lib/capture';
import {
  createWrEntry,
  estimateEntrySize,
  isSettled,
  withCompleted,
  withError,
  withRedirect,
  withRequestHeaders,
  withResponseHeaders,
  wrEntryId,
} from './wr-entry';
import type { WrBaseDetails, WrHeader, WrRequestBody, WrStatusDetails } from './wr-entry';

/** Batching delay for WR_ENTRIES (ms). */
export const WR_FLUSH_DELAY_MS = 150;
/** Max entries kept per tab since its last top-level navigation. */
export const WR_BUFFER_MAX = 1000;
/**
 * A top-level navigation request is held (it belongs to the document it will create) until that document
 * reports in. When it settled without a new document showing up within WR_NAV_SETTLE_MS (download, 204,
 * error page), or it is still pending after WR_NAV_HOLD_MS, it is handed to the current document.
 */
export const WR_NAV_HOLD_MS = 10_000;
export const WR_NAV_SETTLE_MS = 2_000;
const WR_CHUNK_MAX_ENTRIES = 200;
const WR_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
/** Known document → top document links kept per tab. */
const DOC_LINKS_MAX = 2000;

/** Where a WR_ENTRIES batch goes: one document, or (no document known) the tab's top frame. */
export interface FlushTarget {
  documentId?: string;
}

export interface CollectorDeps {
  /** New entries are created only for tabs that capture (open && recording). */
  shouldCreate(tabId: number): boolean;
  /** Existing entries keep being completed while the overlay is open (even when paused). */
  shouldTrack(tabId: number): boolean;
  /** Current request body cap in bytes. */
  bodyCap(): number;
  /** Deliver snapshots to a document of the tab (or its top frame). Must not reject. */
  send(tabId: number, entries: RequestEntry[], target: FlushTarget): Promise<void>;
  /** Requests that are never listed (kineReqLens' own overlay frame loading its panel page). */
  ignoreUrl?(url: string): boolean;
  now?(): number;
  flushDelayMs?: number;
  maxEntries?: number;
  navHoldMs?: number;
  navSettleMs?: number;
}

/** Options of `attachDocument`. */
export interface AttachOptions {
  /** URL of the attaching document (stamped on entries handed over as restored). */
  url?: string;
  /** Preserve log is on: entries of previous documents are handed over (restored) instead of dropped. */
  preserveLog?: boolean;
}

/** Owner of a pending top-level navigation request (no document yet). */
const NAV = '#nav';
/** No document information (worker restarted before any document attached). Flushed to frame 0. */
const UNKNOWN = '#unknown';

interface TabBuffer {
  entries: Map<string, RequestEntry>;
  /** Entry id → owning top document id (or NAV / UNKNOWN). */
  owners: Map<string, string>;
  dirty: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** In-flight flush; flushes of a tab never overlap (a later message never carries an older snapshot). */
  flushing: Promise<void> | null;
  /** Something became dirty while a flush was running: run again once it settled. */
  flushAgain: boolean;
  /** Current top document (the last one that attached), and its URL. */
  topDoc: string | null;
  topUrl: string;
  /** URLs of documents that attached (for restored page URLs). */
  docUrls: Map<string, string>;
  /** Documents replaced by a newer top document (→ their URL): nothing is sent to them any more. */
  retired: Map<string, string>;
  /** Preserve log was on when the current document attached. */
  preserveLog: boolean;
  /** Any document id seen → its top-level document id. */
  docTops: Map<string, string>;
  /** Held navigation entries → timer that hands them to the current document. */
  navTimers: Map<string, ReturnType<typeof setTimeout>>;
}

type BeforeRequestDetails = WrBaseDetails & { requestBody?: WrRequestBody | null };
type SendHeadersDetails = WrBaseDetails & { requestHeaders?: WrHeader[] };
type HeadersReceivedDetails = WrBaseDetails & WrStatusDetails & { responseHeaders?: WrHeader[] };
type RedirectDetails = WrBaseDetails & WrStatusDetails & { redirectUrl: string; fromCache?: boolean; ip?: string };
type CompletedDetails = WrBaseDetails & WrStatusDetails & { fromCache?: boolean; ip?: string };
type ErrorDetails = WrBaseDetails & { error: string; fromCache?: boolean; ip?: string };

export class WebRequestCollector {
  private readonly tabs = new Map<number, TabBuffer>();
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly maxEntries: number;
  private readonly navHoldMs: number;
  private readonly navSettleMs: number;

  constructor(private readonly deps: CollectorDeps) {
    this.now = deps.now ?? Date.now;
    this.flushDelayMs = deps.flushDelayMs ?? WR_FLUSH_DELAY_MS;
    this.maxEntries = deps.maxEntries ?? WR_BUFFER_MAX;
    this.navHoldMs = deps.navHoldMs ?? WR_NAV_HOLD_MS;
    this.navSettleMs = deps.navSettleMs ?? WR_NAV_SETTLE_MS;
  }

  onBeforeRequest(details: BeforeRequestDetails): void {
    this.upsert(details, true, (existing) => existing ?? createWrEntry(details, this.deps.bodyCap()));
  }

  onSendHeaders(details: SendHeadersDetails): void {
    this.upsert(details, true, (existing) =>
      withRequestHeaders(existing ?? createWrEntry(details, this.deps.bodyCap()), details.requestHeaders),
    );
  }

  onHeadersReceived(details: HeadersReceivedDetails): void {
    this.upsert(details, false, (existing) => existing && withResponseHeaders(existing, details));
  }

  onBeforeRedirect(details: RedirectDetails): void {
    this.upsert(details, false, (existing) => existing && withRedirect(existing, details));
  }

  onCompleted(details: CompletedDetails): void {
    this.upsert(details, false, (existing) => existing && withCompleted(existing, details));
  }

  onErrorOccurred(details: ErrorDetails): void {
    this.upsert(details, false, (existing) => existing && withError(existing, details));
  }

  /** Every buffered entry of a tab (all documents, held navigations included), oldest first. */
  getEntries(tabId: number): RequestEntry[] {
    return [...(this.tabs.get(tabId)?.entries.values() ?? [])];
  }

  /**
   * A top document of the tab asked for its state (GET_TAB_STATE). When it is a new document, it becomes the
   * tab's current one: held navigation requests are handed to it, entries of previous documents are dropped
   * (or handed over as restored entries with preserve log). Returns the entries that belong to it.
   */
  attachDocument(tabId: number, documentId: string, options: AttachOptions = {}): RequestEntry[] {
    const buffer = this.tabs.get(tabId);
    if (!buffer) {
      if (this.deps.shouldTrack(tabId)) {
        const created = this.ensureBuffer(tabId);
        created.topDoc = documentId;
        created.topUrl = options.url ?? '';
        created.docUrls.set(documentId, created.topUrl);
      }
      return [];
    }
    if (options.url !== undefined) buffer.docUrls.set(documentId, options.url);
    if (buffer.topDoc !== documentId) this.switchDocument(tabId, buffer, documentId, options);
    else {
      if (options.url !== undefined) buffer.topUrl = options.url;
      buffer.preserveLog = options.preserveLog === true;
    }
    const own: RequestEntry[] = [];
    for (const [id, entry] of buffer.entries) {
      if (buffer.owners.get(id) === documentId) own.push(entry);
    }
    return own;
  }

  /** Drop everything about a tab (overlay closed, tab removed). */
  dropTab(tabId: number): void {
    const buffer = this.tabs.get(tabId);
    if (buffer) {
      if (buffer.timer != null) clearTimeout(buffer.timer);
      for (const timer of buffer.navTimers.values()) clearTimeout(timer);
    }
    this.tabs.delete(tabId);
  }

  /**
   * Flush a tab now (pending timer cancelled). Flushes of one tab are serialized: when one is in flight the
   * call joins it and another round runs right after, with the snapshots current at that time.
   */
  flush(tabId: number): Promise<void> {
    const buffer = this.tabs.get(tabId);
    if (!buffer) return Promise.resolve();
    if (buffer.timer !== null) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (buffer.flushing) {
      buffer.flushAgain = true;
      return buffer.flushing;
    }
    const run = (async () => {
      try {
        do {
          buffer.flushAgain = false;
          await this.flushOnce(tabId, buffer);
        } while (buffer.flushAgain && this.tabs.get(tabId) === buffer);
      } finally {
        buffer.flushing = null;
      }
    })();
    buffer.flushing = run;
    return run;
  }

  // ------------------------------------------------------------------------------------------- internals

  private upsert(
    details: WrBaseDetails,
    mayCreate: boolean,
    update: (existing: RequestEntry | undefined) => RequestEntry | undefined,
  ): void {
    const { tabId } = details;
    if (tabId < 0 || details.documentLifecycle === 'prerender') return;
    if (!this.deps.shouldTrack(tabId) || this.deps.ignoreUrl?.(details.url)) return;

    const id = wrEntryId(details.requestId);
    const existing = this.tabs.get(tabId)?.entries.get(id);
    if (!existing && (!mayCreate || !this.deps.shouldCreate(tabId))) return;
    const next = update(existing);
    if (!next || next === existing) return;

    const buffer = this.ensureBuffer(tabId);
    let owner = existing ? buffer.owners.get(id) : this.ownerOf(buffer, details);
    // An entry handed over from a previous page keeps its credentials redacted through later events.
    let snapshot = next.restored ? withoutCredentials(next) : next;
    if (!existing && owner !== undefined && buffer.retired.has(owner) && buffer.preserveLog && buffer.topDoc) {
      // A late request of a previous page (unload beacon) with preserve log on: listed as that page's.
      const pageUrl = buffer.retired.get(owner) ?? '';
      snapshot = { ...withoutCredentials(next), restored: true, ...(pageUrl ? { pageUrl } : {}) };
      owner = buffer.topDoc;
    }
    buffer.entries.set(id, snapshot);
    if (!existing) {
      buffer.owners.set(id, owner ?? UNKNOWN);
      if (owner === NAV) this.armNavTimer(tabId, buffer, id, this.navHoldMs);
      this.evictOverflow(buffer);
    } else if (owner === NAV && isSettled(next) && !isSettled(existing)) {
      // The navigation finished; if no new document shows up soon, it did not commit.
      this.armNavTimer(tabId, buffer, id, this.navSettleMs);
    }
    if (!buffer.entries.has(id)) return; // evicted right away
    buffer.dirty.add(id);
    this.scheduleFlush(tabId, buffer);
  }

  /** Top-level document a request belongs to (learning document → top links on the way). */
  private ownerOf(buffer: TabBuffer, details: WrBaseDetails): string {
    const { documentId, parentDocumentId } = details;
    const parentFrameId = details.parentFrameId;
    const outermost = parentFrameId === -1 || (parentFrameId === undefined && details.frameId === 0);
    if (details.type === 'main_frame' && outermost) return NAV;
    let top: string | undefined;
    if (outermost) {
      top = documentId;
      // Worker restarted before any document attached: the active primary main frame is the current one.
      if (top && buffer.topDoc === null && details.frameId === 0 && details.documentLifecycle === 'active') {
        buffer.topDoc = top;
      }
    } else if (parentDocumentId) {
      top = parentFrameId === 0 ? parentDocumentId : buffer.docTops.get(parentDocumentId);
    }
    if (top && documentId) this.linkDocument(buffer, documentId, top);
    if (top && parentDocumentId && parentFrameId === 0) this.linkDocument(buffer, parentDocumentId, top);
    return top ?? buffer.topDoc ?? UNKNOWN;
  }

  private linkDocument(buffer: TabBuffer, documentId: string, top: string): void {
    if (buffer.docTops.get(documentId) === top) return;
    if (buffer.docTops.size >= DOC_LINKS_MAX) {
      const oldest = buffer.docTops.keys().next().value;
      if (oldest !== undefined) buffer.docTops.delete(oldest);
    }
    buffer.docTops.set(documentId, top);
  }

  /** A new top document attached: hand it the held navigations, drop (or restore) other documents' entries. */
  private switchDocument(tabId: number, buffer: TabBuffer, documentId: string, options: AttachOptions): void {
    const previous = buffer.topDoc;
    if (previous) buffer.retired.set(previous, buffer.docUrls.get(previous) ?? buffer.topUrl);
    buffer.retired.delete(documentId);
    buffer.preserveLog = options.preserveLog === true;
    buffer.topDoc = documentId;
    buffer.topUrl = options.url ?? buffer.docUrls.get(documentId) ?? '';
    for (const timer of buffer.navTimers.values()) clearTimeout(timer);
    buffer.navTimers.clear();
    for (const [id, entry] of [...buffer.entries]) {
      const owner = buffer.owners.get(id) ?? UNKNOWN;
      if (owner === documentId) continue;
      if (owner === NAV || owner === UNKNOWN) {
        buffer.owners.set(id, documentId);
        continue;
      }
      if (options.preserveLog) {
        // A request of a previous page (e.g. an unload beacon): listed as that page's, like the preserved log.
        const pageUrl = buffer.docUrls.get(owner) ?? entry.pageUrl;
        // Credentials of the previous page (possibly another site) never reach the next one.
        buffer.entries.set(id, { ...withoutCredentials(entry), restored: true, ...(pageUrl ? { pageUrl } : {}) });
        buffer.owners.set(id, documentId);
        buffer.dirty.add(id);
      } else {
        buffer.entries.delete(id);
        buffer.owners.delete(id);
        buffer.dirty.delete(id);
      }
    }
    // Keep only the document links of the new page.
    for (const [doc, top] of [...buffer.docTops]) if (top !== documentId) buffer.docTops.delete(doc);
    for (const doc of [...buffer.docUrls.keys()]) if (doc !== documentId) buffer.docUrls.delete(doc);
    if (buffer.retired.size > 50) buffer.retired = new Map([...buffer.retired].slice(-50));
    if (buffer.dirty.size > 0) this.scheduleFlush(tabId, buffer);
  }

  /** Hand a held navigation entry to the current document after `ms` (unless a new document takes it). */
  private armNavTimer(tabId: number, buffer: TabBuffer, id: string, ms: number): void {
    const previous = buffer.navTimers.get(id);
    if (previous !== undefined) clearTimeout(previous);
    buffer.navTimers.set(
      id,
      setTimeout(() => {
        buffer.navTimers.delete(id);
        if (this.tabs.get(tabId) !== buffer || buffer.owners.get(id) !== NAV) return;
        buffer.owners.set(id, buffer.topDoc ?? UNKNOWN);
        if (!buffer.entries.has(id)) return;
        buffer.dirty.add(id);
        this.scheduleFlush(tabId, buffer);
      }, ms),
    );
  }

  private ensureBuffer(tabId: number): TabBuffer {
    let buffer = this.tabs.get(tabId);
    if (!buffer) {
      buffer = {
        entries: new Map(),
        owners: new Map(),
        dirty: new Set(),
        timer: null,
        flushing: null,
        flushAgain: false,
        topDoc: null,
        topUrl: '',
        docUrls: new Map(),
        retired: new Map(),
        preserveLog: false,
        docTops: new Map(),
        navTimers: new Map(),
      };
      this.tabs.set(tabId, buffer);
    }
    return buffer;
  }

  /** Over capacity: evict the oldest settled entry (pending ones are still interesting), else the oldest. */
  private evictOverflow(buffer: TabBuffer): void {
    while (buffer.entries.size > this.maxEntries) {
      let victim: string | undefined;
      for (const [id, entry] of buffer.entries) {
        if (isSettled(entry)) {
          victim = id;
          break;
        }
      }
      victim ??= buffer.entries.keys().next().value;
      if (victim === undefined) return;
      buffer.entries.delete(victim);
      buffer.owners.delete(victim);
      buffer.dirty.delete(victim);
      const timer = buffer.navTimers.get(victim);
      if (timer !== undefined) clearTimeout(timer);
      buffer.navTimers.delete(victim);
    }
  }

  private scheduleFlush(tabId: number, buffer: TabBuffer): void {
    if (buffer.timer !== null) return;
    buffer.timer = setTimeout(() => {
      buffer.timer = null;
      if (this.tabs.get(tabId) === buffer) void this.flush(tabId);
    }, this.flushDelayMs);
  }

  /**
   * Send every dirty entry to its document, in chunks. Each chunk reads the entries' snapshots when it is
   * sent and clears their dirty flag only then, so an update that lands while a chunk is in flight is sent
   * again (later) by the next round. Held navigation entries stay dirty.
   */
  private async flushOnce(tabId: number, buffer: TabBuffer): Promise<void> {
    const groups = new Map<string, string[]>();
    for (const id of buffer.dirty) {
      const owner = buffer.owners.get(id) ?? UNKNOWN;
      if (owner === NAV) continue;
      if (buffer.retired.has(owner) || !buffer.entries.has(id)) {
        buffer.dirty.delete(id);
        continue;
      }
      const ids = groups.get(owner);
      if (ids) ids.push(id);
      else groups.set(owner, [id]);
    }
    for (const [owner, ids] of groups) {
      const target: FlushTarget = owner === UNKNOWN ? {} : { documentId: owner };
      let index = 0;
      while (index < ids.length) {
        const chunk: RequestEntry[] = [];
        let bytes = 0;
        while (index < ids.length) {
          const id = ids[index]!;
          const entry = buffer.entries.get(id);
          if (!entry || buffer.owners.get(id) !== owner || !buffer.dirty.has(id)) {
            // Evicted, handed to another document (next round), or already sent.
            index++;
            continue;
          }
          const size = estimateEntrySize(entry);
          if (chunk.length > 0 && (chunk.length >= WR_CHUNK_MAX_ENTRIES || bytes + size > WR_CHUNK_MAX_BYTES)) break;
          chunk.push(entry);
          bytes += size;
          buffer.dirty.delete(id);
          index++;
        }
        if (chunk.length === 0) continue;
        await this.deps.send(tabId, chunk, target);
        if (this.tabs.get(tabId) !== buffer) return;
      }
    }
  }
}
