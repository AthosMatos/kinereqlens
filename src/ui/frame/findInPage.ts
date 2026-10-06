// Find in page, page side (ui.js, top frame isolated world — never content.js, so pages without the overlay pay
// nothing). Driven only by the authenticated panel connection (frame/server.ts):
//  - scan sessions (one per panel connection; a new findStart supersedes the previous one): the page index
//    (findIndex.ts) and the matcher (src/lib/findInPage.ts), in ≤ FIND_SLICE_MS slices yielding through a
//    MessageChannel, abortable; results stream to the panel ({t:'find-results'}, only changes after the first pass);
//  - re-scans while the panel shows the response: a MutationObserver (document, open shadow roots, same-origin
//    iframe documents) debounced FIND_RESCAN_DEBOUNCE_MS (at most FIND_RESCAN_MAX_WAIT_MS while the page keeps
//    changing; longer when scans are slow); element references are WeakRefs dropped after FIND_REFS_TTL_MS;
//  - locate ("peek"): the overlay hidden, the first visible match scrolled into view (same-origin iframes first),
//    the live highlight and the mini-bar; ←/→, Enter / Shift+Enter cycle, Esc / ✕ restores the overlay and sends
//    {t:'find-return'} so the panel focuses the JSON node; clicking the page keeps the peek;
//  - the element picker of "Where does this come from?".
// The page cannot observe any of it: reading the DOM fires no events, MutationObserver records stay in this world,
// and the only DOM changes are our own closed-shadow-root layers.
import { OVERLAY_HOST_TAG } from '../../shared/constants';
import { HIGHLIGHT_LAYER_TAG } from '../../shared/initiator-protocol';
import { SHOT_LAYER_TAG } from '../../shared/screenshot-protocol';
import {
  FIND_BAR_TAG,
  FIND_HIGHLIGHT_TAG,
  FIND_MAX_HITS,
  FIND_MAX_TEXT_CHARS,
  FIND_PICK_TAG,
  FIND_REFS_TTL_MS,
  FIND_RESCAN_DEBOUNCE_MS,
  FIND_RESCAN_MAX_WAIT_MS,
  FIND_SLICE_MS,
  sanitizeElementHighlightRequest,
  sanitizeFindLocateRequest,
  sanitizeFindScanRequest,
  sanitizeLocales,
  sanitizeScanId,
} from '../../shared/find-protocol';
import type {
  ElementHighlightResult,
  FindCandidateWire,
  FindLocateRequest,
  FindLocateResult,
  FindMatchKind,
  FindPickResult,
  FindResult,
  FindScanStats,
  FindToPanel,
} from '../../shared/find-protocol';
import { TextMatcher, resultKey, summarizeHits, variantsFor } from '../../lib/findInPage';
import type { MatchVariant } from '../../lib/findInPage';
import { buildPageIndex, hitElement, hitRect, isRendered } from './findIndex';
import { elementOf } from './elementRefs';
import type { ViewRect } from './findIndex';
import { showFindBar } from './findBar';
import type { FindBar } from './findBar';
import { startFindPicker } from './findPicker';
import type { FindPickerHandle } from './findPicker';
import { showFindHighlight } from './highlight';
import type { FindHighlight, LiveTarget } from './highlight';

/** What the manager needs from the overlay host. */
export interface FindFrame {
  /** Hide the overlay (pill included) while a match is shown or an element is picked. */
  setPeekHidden(hidden: boolean): void;
  readonly iframe: HTMLIFrameElement;
}

export interface FindManager {
  start(raw: unknown): { ok: boolean; error?: string };
  stop(scanId: unknown): void;
  rescan(scanId: unknown): void;
  locate(raw: unknown): Promise<FindLocateResult>;
  pick(): Promise<FindPickResult | null>;
  /** Show located elements (findHighlight: refs from findElements) the way locate shows a value; refs [] ends it. */
  highlight(raw: unknown): ElementHighlightResult;
  /** The overlay was closed: end a peek / pick without returning to the panel. */
  overlayClosed(): void;
  dispose(): void;
}

/** Our own layers in the page: never indexed, their mutations never trigger a re-scan. */
export const OWN_TAGS: ReadonlySet<string> = new Set([OVERLAY_HOST_TAG, HIGHLIGHT_LAYER_TAG, SHOT_LAYER_TAG, FIND_HIGHLIGHT_TAG, FIND_BAR_TAG, FIND_PICK_TAG]);
const OBSERVED_ATTRS = ['title', 'alt', 'aria-label', 'placeholder', 'value', 'href', 'src', 'srcset', 'hidden'];
/** Partial results are flushed to the panel at most this often during a scan. */
const FLUSH_MS = 120;
/** Slow scans space re-scans out: the wait is this many times the last scan's work time (≤ 10 s). */
const SLOW_SCAN_FACTOR = 3;

interface Prepared {
  wire: FindCandidateWire;
  variants: MatchVariant[] | null;
}

interface HitRef {
  node: WeakRef<Node>;
  start: number;
  end: number;
  frames: Array<WeakRef<HTMLIFrameElement>> | null;
  kind: FindMatchKind;
}

interface Job {
  aborted: boolean;
  promise: Promise<void>;
}

interface Session {
  scanId: string;
  prepared: Prepared[];
  hintLocales: string[];
  locales: string[];
  watch: boolean;
  hits: Map<number, HitRef[]>;
  results: Map<number, Omit<FindResult, 'id'>>;
  sent: Map<number, string>;
  passes: number;
  job: Job | null;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  firstPending: number;
  refsTimer: ReturnType<typeof setTimeout> | null;
  observer: MutationObserver | null;
  observed: Set<Node>;
  lastMs: number;
}

/** A match being shown. */
interface Match {
  node: Node;
  start: number;
  end: number;
  frames: HTMLIFrameElement[] | null;
}

interface Peek {
  /** The scan session of a located value; null for an element highlight (findHighlight: no find-return). */
  scanId: string | null;
  nodeId: string;
  req: FindLocateRequest;
  matches: Match[];
  index: number;
  bar: FindBar;
  highlight: FindHighlight;
  cleanup(): void;
}

function isOwnElement(el: Element): boolean {
  return OWN_TAGS.has(el.localName);
}

function isOwnNode(node: Node): boolean {
  return node.nodeType === 1 && isOwnElement(node as Element);
}

/** Mutations that can change what the page shows (not our own layers coming and going). */
function relevant(records: readonly MutationRecord[]): boolean {
  for (const r of records) {
    if (isOwnNode(r.target)) continue;
    if (r.type === 'childList') {
      const changed = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
      if (changed.length > 0 && changed.every(isOwnNode)) continue;
    }
    return true;
  }
  return false;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Locales the page shows numbers / dates in: its <html lang>, the panel's hints, the browser's language. */
export function pageLocales(hints: readonly string[]): string[] {
  const lang = document.documentElement?.getAttribute('lang') ?? '';
  return sanitizeLocales([lang, ...hints, navigator.language, ...(navigator.languages ?? []).slice(0, 2)]);
}

/** Work time accounting and yielding (MessageChannel: not clamped like nested timers). */
class SliceClock {
  private sliceStart = performance.now();
  work = 0;
  slices = 1;
  private readonly channel = new MessageChannel();
  private waiting: Array<() => void> = [];

  constructor() {
    this.channel.port1.onmessage = () => {
      const waiting = this.waiting;
      this.waiting = [];
      for (const fn of waiting) fn();
    };
  }

  over(): boolean {
    return performance.now() - this.sliceStart > FIND_SLICE_MS;
  }

  pause(): Promise<void> {
    this.work += performance.now() - this.sliceStart;
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.sliceStart = performance.now();
        this.slices++;
        resolve();
      });
      this.channel.port2.postMessage(0);
    });
  }

  finish(): number {
    this.work += performance.now() - this.sliceStart;
    this.channel.port1.close();
    return this.work;
  }
}

/** Create the manager of one panel connection; `post` sends events to that panel. */
export function createFindManager(frame: FindFrame, post: (message: FindToPanel) => void): FindManager {
  let session: Session | null = null;
  let peek: Peek | null = null;
  let picker: { handle: FindPickerHandle; resolve(result: FindPickResult | null): void } | null = null;
  let disposed = false;

  // ---- scanning ---------------------------------------------------------------------------------------

  const send = (message: FindToPanel) => {
    if (disposed) return;
    try {
      post(message);
    } catch {
      /* panel gone */
    }
  };

  const disposeSession = (s: Session) => {
    if (s.job) s.job.aborted = true;
    s.job = null;
    if (s.timer) clearTimeout(s.timer);
    if (s.refsTimer) clearTimeout(s.refsTimer);
    s.timer = null;
    s.refsTimer = null;
    s.observer?.disconnect();
    s.observer = null;
    s.observed.clear();
    s.hits.clear();
  };

  const observe = (s: Session, roots: ReadonlyArray<Node>) => {
    if (!s.watch || disposed) return;
    if (!s.observer) {
      s.observer = new MutationObserver((records) => {
        if (session !== s || !relevant(records)) return;
        if (s.job) s.dirty = true;
        else schedule(s);
      });
    }
    for (const root of roots) {
      if (s.observed.has(root)) continue;
      s.observed.add(root);
      try {
        s.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: OBSERVED_ATTRS });
      } catch {
        /* detached root */
      }
    }
  };

  const schedule = (s: Session) => {
    if (session !== s || disposed) return;
    const now = Date.now();
    if (!s.firstPending) s.firstPending = now;
    if (s.timer) clearTimeout(s.timer);
    const wait = Math.max(FIND_RESCAN_DEBOUNCE_MS, Math.min(10_000, s.lastMs * SLOW_SCAN_FACTOR));
    const due = Math.min(now + wait, s.firstPending + Math.max(FIND_RESCAN_MAX_WAIT_MS, wait));
    s.timer = setTimeout(
      () => {
        s.timer = null;
        s.firstPending = 0;
        if (session !== s) return;
        if (s.job) s.dirty = true;
        else startJob(s);
      },
      Math.max(0, due - now),
    );
  };

  const prepare = (s: Session, p: Prepared): MatchVariant[] => {
    if (!p.variants) {
      try {
        p.variants = variantsFor(p.wire, s.locales);
      } catch {
        p.variants = [];
      }
    }
    return p.variants;
  };

  const runScan = async (s: Session, job: Job): Promise<void> => {
    const clock = new SliceClock();
    try {
      // The page may have switched its language (SPA): re-format the values.
      const locales = pageLocales(s.hintLocales);
      if (locales.join() !== s.locales.join()) {
        s.locales = locales;
        for (const p of s.prepared) p.variants = null;
      }
      const index = await buildPageIndex(document, {
        maxChars: FIND_MAX_TEXT_CHARS,
        ownTags: OWN_TAGS,
        overBudget: () => clock.over(),
        pause: () => clock.pause(),
        aborted: () => job.aborted || session !== s,
      });
      if (!index || job.aborted || session !== s) return;
      observe(s, [document, ...index.roots]);
      const matcher = new TextMatcher(index.table);
      const hits = new Map<number, HitRef[]>();
      const batch: Array<{ result: FindResult; key: string }> = [];
      let lastFlush = performance.now();
      let found = 0;
      // A result counts as sent only once it was posted (an aborted pass must not swallow it).
      const flush = (done: boolean, stats?: FindScanStats) => {
        const items = batch.splice(0);
        for (const item of items) s.sent.set(item.result.id, item.key);
        send({ t: 'find-results', scanId: s.scanId, results: items.map((i) => i.result), done, ...(stats ? { stats } : {}) });
        lastFlush = performance.now();
      };
      const yieldIfNeeded = async (): Promise<boolean> => {
        if (!clock.over()) return true;
        await clock.pause();
        return !job.aborted && session === s;
      };
      for (const p of s.prepared) {
        const variants = prepare(s, p);
        const mj = matcher.begin(variants);
        while (!mj.step()) if (!(await yieldIfNeeded())) return;
        const outcome = mj.outcome();
        const refs: HitRef[] = [];
        const visible: boolean[] = [];
        if (outcome.total <= FIND_MAX_HITS) {
          for (const h of outcome.hits) {
            const node = index.nodes[h.target]!;
            const fr = index.frames[h.target] ?? null;
            visible.push(hitRect(node, h.start, h.end, fr) !== null);
            refs.push({ node: new WeakRef(node), start: h.start, end: h.end, frames: fr ? fr.map((f) => new WeakRef(f)) : null, kind: h.kind });
            if (!(await yieldIfNeeded())) return;
          }
        }
        const summary = summarizeHits(outcome, visible, variants);
        if (summary.total > 0) {
          found++;
          hits.set(p.wire.id, refs);
        }
        const key = resultKey(summary);
        const previous = s.sent.get(p.wire.id);
        if (previous === undefined ? summary.total > 0 : previous !== key) batch.push({ result: { id: p.wire.id, ...summary }, key });
        s.results.set(p.wire.id, summary);
        if (batch.length > 0 && performance.now() - lastFlush > FLUSH_MS) flush(false);
        if (!(await yieldIfNeeded())) return;
      }
      s.hits = hits;
      s.passes++;
      if (s.refsTimer) clearTimeout(s.refsTimer);
      // Element references are not kept forever: a later locate scans again.
      s.refsTimer = setTimeout(() => s.hits.clear(), FIND_REFS_TTL_MS);
      s.lastMs = clock.work;
      flush(true, { candidates: s.prepared.length, found, indexedChars: index.chars, truncated: index.truncated, locales: s.locales, ms: Math.round(clock.work) });
    } finally {
      clock.finish();
    }
  };

  const startJob = (s: Session): Job => {
    if (s.job) s.job.aborted = true;
    s.dirty = false;
    const job: Job = { aborted: false, promise: Promise.resolve() };
    s.job = job;
    job.promise = runScan(s, job)
      .catch((err) => {
        if (!job.aborted) send({ t: 'find-results', scanId: s.scanId, results: [], done: true, error: errorText(err) });
      })
      .finally(() => {
        if (s.job !== job) return;
        s.job = null;
        if (s.dirty && session === s && !disposed) {
          s.dirty = false;
          schedule(s);
        }
      });
    return job;
  };

  // ---- peek (locate) ------------------------------------------------------------------------------------

  const toRect = (r: ViewRect | null) => (r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);

  const targetFor = (m: Match, req: FindLocateRequest): LiveTarget => ({
    rect: () => toRect(hitRect(m.node, m.start, m.end, m.frames)),
    path: req.path,
    snippet: req.snippet,
  });

  /** Live, rendered matches of a candidate, in visual order (top to bottom, then left to right). */
  const resolveMatches = (s: Session, candidateId: number): Match[] => {
    const out: Array<Match & { at: ViewRect }> = [];
    for (const ref of s.hits.get(candidateId) ?? []) {
      const node = ref.node.deref();
      if (!node?.isConnected) continue;
      const frames = ref.frames ? ref.frames.map((f) => f.deref()) : null;
      if (frames && frames.some((f) => !f?.isConnected)) continue;
      const chain = frames as HTMLIFrameElement[] | null;
      const at = hitRect(node, ref.start, ref.end, chain);
      if (!at) continue;
      out.push({ node, start: ref.start, end: ref.end, frames: chain, at });
    }
    out.sort((a, b) => a.at.y + window.scrollY - (b.at.y + window.scrollY) || a.at.x - b.at.x);
    return out.map(({ at: _at, ...m }) => m);
  };

  const scrollTo = (m: Match) => {
    const el = hitElement(m.node);
    if (!el) return;
    let smooth = true;
    try {
      smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* default */
    }
    try {
      for (const f of m.frames ?? []) f.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: smooth ? 'smooth' : ('instant' as ScrollBehavior) });
    } catch {
      /* detached */
    }
  };

  const showMatch = (p: Peek, index: number) => {
    // Matches removed from the page meanwhile are skipped.
    p.matches = p.matches.filter((m) => m.node.isConnected);
    if (p.matches.length === 0) {
      p.index = -1;
      p.bar.update({ index: -1, count: 0, path: p.req.path, status: 'No longer on the page' });
      p.highlight.update();
      return;
    }
    const n = p.matches.length;
    p.index = ((index % n) + n) % n;
    const m = p.matches[p.index]!;
    scrollTo(m);
    p.highlight.set(targetFor(m, p.req));
    p.bar.update({ index: p.index, count: n, path: p.req.path });
  };

  const endPeek = (returnToPanel: boolean) => {
    const p = peek;
    if (!p) return;
    peek = null;
    p.cleanup();
    p.bar.remove();
    p.highlight.remove();
    frame.setPeekHidden(false);
    if (returnToPanel) {
      try {
        frame.iframe.focus({ preventScroll: true });
      } catch {
        /* host gone */
      }
      if (p.scanId !== null) send({ t: 'find-return', scanId: p.scanId, nodeId: p.nodeId });
    }
  };

  const endPick = () => {
    const current = picker;
    picker = null;
    current?.handle.cancel();
  };

  /**
   * Hide the overlay and show `matches` (from `opts.index`). `opts.autoEndMs`: the peek ends by itself (silently) after
   * that long without the user cycling the matches; `opts.focus: false` leaves the keyboard focus where it is.
   */
  const beginPeek = (scanId: string | null, req: FindLocateRequest, matches: Match[], opts: { index?: number; autoEndMs?: number; focus?: boolean } = {}) => {
    endPeek(false);
    endPick();
    frame.setPeekHidden(true);
    const scrollTargets = new Set<EventTarget>();
    for (const m of matches) for (const f of m.frames ?? []) if (f.contentWindow) scrollTargets.add(f.contentWindow);
    // The highlight first: the bar, shown after it, stays above it in the top layer.
    const highlight = showFindHighlight(targetFor(matches[0]!, req), [...scrollTargets]);
    let autoEnd: ReturnType<typeof setTimeout> | null = null;
    /** (Re)arm the automatic end: the user cycling the matches keeps the peek up. */
    const arm = () => {
      if (!opts.autoEndMs) return;
      if (autoEnd) clearTimeout(autoEnd);
      autoEnd = setTimeout(() => peek === p && endPeek(false), opts.autoEndMs);
    };
    const cycle = (step: number) => {
      arm();
      showMatch(p, p.index + step);
    };
    const p: Peek = {
      scanId,
      nodeId: req.nodeId,
      req,
      matches,
      index: 0,
      highlight,
      bar: showFindBar({
        onPrev: () => peek === p && cycle(-1),
        onNext: () => peek === p && cycle(1),
        onClose: () => peek === p && endPeek(true),
      }),
      cleanup: () => undefined,
    };
    const onKey = (e: KeyboardEvent) => {
      if (peek !== p) return;
      const t = e.target;
      const ours = t === p.bar.host;
      const neutral = !t || t === document || t === document.body || t === document.documentElement || t === window;
      if (e.key === 'Escape') {
        if (ours || neutral) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        endPeek(true);
        return;
      }
      if ((!ours && !neutral) || e.altKey || e.ctrlKey || e.metaKey) return;
      let step = 0;
      if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.shiftKey)) step = 1;
      else if (e.key === 'ArrowLeft' || (e.key === 'Enter' && e.shiftKey)) step = -1;
      if (!step) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cycle(step);
    };
    const onPageHide = () => endPeek(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', onPageHide);
    p.cleanup = () => {
      if (autoEnd) clearTimeout(autoEnd);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', onPageHide);
    };
    peek = p;
    arm();
    showMatch(p, opts.index ?? 0);
    if (opts.focus !== false) p.bar.focus();
  };

  // ---- api ----------------------------------------------------------------------------------------------

  const api: FindManager = {
    start(raw) {
      const req = sanitizeFindScanRequest(raw);
      if (!req) return { ok: false, error: 'Invalid find request' };
      if (session) {
        if (peek?.scanId === session.scanId) endPeek(false);
        disposeSession(session);
      }
      const s: Session = {
        scanId: req.scanId,
        prepared: req.candidates.map((wire) => ({ wire, variants: null })),
        hintLocales: req.locales,
        locales: pageLocales(req.locales),
        watch: req.watch,
        hits: new Map(),
        results: new Map(),
        sent: new Map(),
        passes: 0,
        job: null,
        dirty: false,
        timer: null,
        firstPending: 0,
        refsTimer: null,
        observer: null,
        observed: new Set(),
        lastMs: 0,
      };
      session = s;
      // Changes made while the first pass runs re-scan afterwards.
      observe(s, [document]);
      startJob(s);
      return { ok: true };
    },
    stop(raw) {
      const scanId = sanitizeScanId(raw);
      const s = session;
      if (!s || s.scanId !== scanId) return;
      if (peek?.scanId === s.scanId) endPeek(false);
      disposeSession(s);
      session = null;
    },
    rescan(raw) {
      const s = session;
      if (s && s.scanId === sanitizeScanId(raw)) startJob(s);
    },
    async locate(raw) {
      const req = sanitizeFindLocateRequest(raw);
      if (!req) throw new Error('Invalid locate request');
      const s = session;
      const expired: FindLocateResult = { ok: false, reason: 'expired', message: 'The page was scanned again — try once more' };
      if (!s || s.scanId !== req.scanId) return expired;
      if (s.results.get(req.candidateId)?.common) {
        const r = s.results.get(req.candidateId)!;
        return { ok: false, reason: 'common', message: `Found ${r.total}${r.more ? '+' : ''}× on the page — too common to show one` };
      }
      let matches = resolveMatches(s, req.candidateId);
      if (matches.length === 0) {
        // The page changed (or the references expired): scan again, then look once more.
        if (s.job && !s.job.aborted) await s.job.promise;
        else await startJob(s).promise;
        if (session !== s) return expired;
        matches = resolveMatches(s, req.candidateId);
      }
      if (matches.length === 0) {
        const alive = (s.hits.get(req.candidateId) ?? []).some((h) => h.node.deref()?.isConnected);
        return alive
          ? { ok: false, reason: 'hidden', message: 'On the page, but not visible right now' }
          : { ok: false, reason: 'gone', message: 'No longer on the page' };
      }
      beginPeek(s.scanId, req, matches);
      return { ok: true, count: matches.length };
    },
    highlight(raw) {
      const req = sanitizeElementHighlightRequest(raw);
      if (!req) throw new Error('Invalid highlight request');
      if (req.refs.length === 0) {
        // Ends an element highlight only (a value the user is looking at stays).
        if (peek && peek.scanId === null) endPeek(false);
        return { ok: true, count: 0 };
      }
      const wanted = elementOf(req.refs[req.index]);
      const elements = req.refs.map((ref) => elementOf(ref)).filter((el): el is Element => !!el && isRendered(el));
      if (elements.length === 0) {
        const alive = req.refs.some((ref) => elementOf(ref));
        return { ok: false, message: alive ? 'The element is on the page but not visible' : 'The element is no longer on the page' };
      }
      const matches: Match[] = elements.map((el) => ({ node: el, start: 0, end: 0, frames: null }));
      const index = Math.max(0, wanted ? elements.indexOf(wanted) : 0);
      const label = req.label || 'kineReqLens';
      beginPeek(null, { scanId: 'element', candidateId: 0, nodeId: 'element', path: label, snippet: '' }, matches, {
        index,
        autoEndMs: req.durationMs,
        // Asked from the chat: the user may be typing in the page.
        focus: false,
      });
      return { ok: true, count: matches.length };
    },
    pick() {
      endPeek(false);
      endPick();
      frame.setPeekHidden(true);
      return new Promise<FindPickResult | null>((resolve) => {
        const entry = {
          resolve,
          handle: startFindPicker((result) => {
            if (picker === entry) picker = null;
            frame.setPeekHidden(false);
            try {
              frame.iframe.focus({ preventScroll: true });
            } catch {
              /* host gone */
            }
            resolve(result ? { ...result, locales: pageLocales([]) } : null);
          }, isOwnElement),
        };
        picker = entry;
      });
    },
    overlayClosed() {
      endPeek(false);
      endPick();
    },
    dispose() {
      if (disposed) return;
      endPeek(false);
      endPick();
      disposed = true;
      if (session) disposeSession(session);
      session = null;
    },
  };
  return api;
}
