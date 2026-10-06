/**
 * Find in page protocol (docs/ARCHITECTURE.md §13): which page elements show a value of the response the panel
 * displays, and the way back ("Where does this come from?").
 *
 *  panel (panel.html)  collects the response's leaf values (src/lib/findInPage.ts collectCandidates)
 *    │ Port call findStart {scanId, candidates, locales, watch}
 *  frame host (ui.js, top frame isolated world — never content.js, so pages without the overlay pay nothing):
 *    indexes the page's text (text nodes, open shadow roots, same-origin iframes, form values, a few attributes),
 *    formats each value the ways a page shows it (src/lib/findInPage.ts variantsFor, in the page's locale) and
 *    matches them (time-sliced, abortable); a MutationObserver re-scans while the panel shows the response
 *    │ {t:'find-results'} (streamed, only changed results after the first pass)
 *  panel  locate icons next to the JSON values
 *    │ Port call findLocate → the host hides the overlay ("peek"), scrolls to the match, draws the highlight and the
 *    │ mini-bar; Esc / ✕ restores the overlay and sends {t:'find-return', nodeId}
 *    │ Port call findPick → page-side element picker → the element's texts; the panel searches the captured bodies
 *
 * Nothing is sent to the page's own context: the scan runs in the extension's isolated world, the layers it draws
 * live in closed shadow roots (open in the E2E build) and captured text in them is CSS generated content (not
 * found by window.find / Selection).
 */

/** Kind of a value the panel looks for. */
export type FindValueKind = 'string' | 'number' | 'date';

/** A response value, as sent to the host (the panel keeps the JSON node ids). */
export interface FindCandidateWire {
  /** Index in the scan's candidate list. */
  id: number;
  kind: FindValueKind;
  /** The string, the number literal, or the ISO date text. */
  value: string;
  /** Object key of (the first node with) the value: hints for money / byte-size numbers. */
  key?: string;
}

export interface FindScanRequest {
  scanId: string;
  candidates: FindCandidateWire[];
  /** Extra locales (e.g. the overlay's "Site language" override) to format numbers and dates with. */
  locales: string[];
  /** Re-scan (debounced) while the page changes, until findStop. */
  watch: boolean;
}

/** How the best hit of a value matched: a whole text / form value, part of a text, or an attribute. */
export type FindMatchKind = 'exact' | 'substring' | 'attr';

/** What the page shows of one candidate. */
export interface FindResult {
  /** Candidate id. */
  id: number;
  /** Hits on the page (counting stops at FIND_COUNT_CAP: `more`). */
  total: number;
  more: boolean;
  /** Hits that are rendered (client rects, checkVisibility, not zero-size). */
  visible: number;
  /** Every hit is an attribute (href, src, title, alt, …). */
  attrOnly: boolean;
  /** More than FIND_MAX_HITS hits: reported as a count, not locatable. */
  common: boolean;
  kind: FindMatchKind | null;
  /** 3 the exact value, 2 normalized / derived, 1 formatted (locale number, date…). */
  confidence: number;
  /** The text form that matched best (≤ 120 chars) and what it is ("number (pt-BR)"). */
  as: string;
  asLabel: string;
}

export interface FindScanStats {
  /** Candidates searched. */
  candidates: number;
  /** Candidates with at least one hit. */
  found: number;
  /** Characters of page text indexed. */
  indexedChars: number;
  /** The page has more text than FIND_MAX_TEXT_CHARS: the rest was not searched. */
  truncated: boolean;
  /** Locales the numbers and dates were formatted with. */
  locales: string[];
  /** Work time of the scan (ms, slices only). */
  ms: number;
}

/** Host → panel events (added to HostToPanel). */
export type FindToPanel =
  | {
      t: 'find-results';
      scanId: string;
      /** Changed results (the first pass of a scan only sends found values). */
      results: FindResult[];
      /** The pass finished (stats attached). */
      done: boolean;
      stats?: FindScanStats;
      error?: string;
    }
  /** The mini-bar's Esc / ✕: the overlay is back, focus the JSON node the user located. */
  | { t: 'find-return'; scanId: string; nodeId: string };

export interface FindLocateRequest {
  scanId: string;
  candidateId: number;
  /** The JSON node the user clicked (echoed in find-return). */
  nodeId: string;
  /** JSON path and value snippet for the highlight label / bar (shown as CSS generated content). */
  path: string;
  snippet: string;
}

export type FindLocateFailure = 'expired' | 'gone' | 'hidden' | 'common';

export type FindLocateResult = { ok: true; count: number } | { ok: false; reason: FindLocateFailure; message: string };

/** What the page-side picker took from the picked element (normalized texts, most specific first). */
export interface FindPickResult {
  texts: string[];
  /** `tag.class` description of the element. */
  label: string;
  /** Locales the page shows numbers / dates in (<html lang>, the browser's language). */
  locales: string[];
}

/** Calls the panel makes to the frame host (added to PanelCalls). */
export interface FindCalls {
  /** Start (or replace) the scan session; results arrive as find-results events. */
  findStart(req: FindScanRequest): { ok: boolean; error?: string };
  /** Stop observing and drop the session (the panel hid the response). */
  findStop(scanId: string): void;
  /** Scan the page again now. */
  findRescan(scanId: string): void;
  /** Hide the overlay, scroll to the first visible match, highlight it and show the mini-bar. */
  findLocate(req: FindLocateRequest): FindLocateResult;
  /** Page-side element picker ("Where does this come from?"); null when cancelled. */
  findPick(): FindPickResult | null;
  /**
   * Page elements matching a CSS selector, a visible text / label or a response value (element locators of the
   * screenshot tool and of the MCP `screenshot` / `find_in_page` tools), in document order.
   */
  findElements(query: ElementQuery): ElementQueryResult;
  /**
   * Show located elements on the page the way findLocate shows a value (overlay hidden, highlight, mini-bar cycling
   * the matches); the peek ends by itself after `durationMs`. `refs: []` ends such a peek.
   */
  findHighlight(req: ElementHighlightRequest): ElementHighlightResult;
  /** One scan of the page for `candidates`, without a session (no observer, no events): what it shows of each. */
  findValues(req: FindValuesRequest): FindValuesResult;
}

export type FindCallName = keyof FindCalls;

export const FIND_CALLS: readonly FindCallName[] = [
  'findStart',
  'findStop',
  'findRescan',
  'findLocate',
  'findPick',
  'findElements',
  'findHighlight',
  'findValues',
];

// ------------------------------------------------------------------------------------------------ element locators

/** A response value looked for as an element locator (one of the kinds Find in page scans for). */
export interface ElementValueQuery {
  kind: FindValueKind;
  /** The string, the number literal or the ISO date text. */
  value: string;
  /** Object key of the value (hints for money / byte-size numbers). */
  key?: string;
}

/** Which page elements to list: exactly one of `selector`, `text`, `value`. */
export interface ElementQuery {
  /** CSS selector, matched in the top document and its open shadow roots. */
  selector?: string;
  /** Visible text or label: text content, aria-label, title, alt, placeholder, form values. */
  text?: string;
  /** A response value, matched the way Find in page matches it (formatted numbers and dates included). */
  value?: ElementValueQuery;
  /** `text` / `value`: the element's whole text must match (case- and space-insensitive), not just contain it. */
  exact?: boolean;
  /** Matches described at most (≤ ELEMENT_MATCHES_MAX; more are counted, up to ELEMENT_COUNT_CAP). */
  limit: number;
  /** Extra locales to format `value` numbers / dates with (the overlay's "Site language" override). */
  locales: string[];
}

/** A page element that matched (page = document CSS px). */
export interface ElementMatch {
  /** Handle for shotElement / findHighlight, valid while the page lives (≤ ELEMENT_REF_TTL_MS). */
  ref: string;
  /** Tag name, lower case. */
  tag: string;
  /** Visible text (or label / form value), ≤ 200 characters. */
  text: string;
  /** A CSS selector that finds it again (best effort, within its own document / shadow root). */
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Rendered (not display: none / visibility: hidden, has a non-empty box); it may still be scrolled out of view. */
  visible: boolean;
}

export interface ElementQueryResult {
  /** At most `limit` matches, in document order. */
  matches: ElementMatch[];
  /** All matches (counting stops at ELEMENT_COUNT_CAP). */
  total: number;
  /** Why the query could not run (an invalid selector…). */
  error?: string;
}

export interface ElementHighlightRequest {
  /** Elements to show (refs from findElements), in the order the mini-bar cycles them. [] ends an element peek. */
  refs: string[];
  /** The one shown first. */
  index: number;
  /** Text of the highlight label and the mini-bar (CSS generated content, never page text). */
  label: string;
  /** The peek ends by itself after this long (ms, ≤ ELEMENT_HIGHLIGHT_MAX_MS). */
  durationMs: number;
}

export type ElementHighlightResult = { ok: true; count: number } | { ok: false; message: string };

export interface FindValuesRequest {
  candidates: FindCandidateWire[];
  locales: string[];
}

export interface FindValuesResult {
  /** Candidates found on the page (total > 0), by candidate id. */
  results: FindResult[];
  stats?: FindScanStats;
  error?: string;
}

/** Longest selector / text an element query accepts. */
export const ELEMENT_QUERY_MAX_CHARS = 1000;
/** Matches described per element query at most. */
export const ELEMENT_MATCHES_MAX = 200;
/** Matches counted per element query at most. */
export const ELEMENT_COUNT_CAP = 1000;
/** Element handles (refs) are dropped after this long. */
export const ELEMENT_REF_TTL_MS = 10 * 60_000;
/** Default and longest duration of an element highlight (ms). */
export const ELEMENT_HIGHLIGHT_MS = 8_000;
export const ELEMENT_HIGHLIGHT_MAX_MS = 60_000;

// ------------------------------------------------------------------------------------------------ limits

/** Distinct values searched per scan (strings first, then numbers, then dates; shallower first). */
export const FIND_MAX_CANDIDATES = 3000;
/** Longest value searched (longer strings are skipped). */
export const FIND_MAX_VALUE_CHARS = 1000;
/** Hits kept (locatable) per value; beyond that the value is "common". */
export const FIND_MAX_HITS = 200;
/** Hits counted per value at most. */
export const FIND_COUNT_CAP = 1000;
/** Page text indexed at most (characters). */
export const FIND_MAX_TEXT_CHARS = 5 * 1024 * 1024;
/** Longest work slice before yielding to the page (ms). */
export const FIND_SLICE_MS = 8;
/** Quiet time after a page mutation before re-scanning (ms), and the longest wait while it keeps changing. */
export const FIND_RESCAN_DEBOUNCE_MS = 500;
export const FIND_RESCAN_MAX_WAIT_MS = 2000;
/** Element references of a scan are dropped after this long (a locate then re-scans). */
export const FIND_REFS_TTL_MS = 5 * 60_000;
/** Locales the host formats with at most. */
export const FIND_MAX_LOCALES = 3;
/** Only variants at least this long are searched inside longer texts (shorter ones must match a whole text). */
export const FIND_MIN_SUBSTRING = 5;

/** Tags of the page-side layers (closed shadow roots). */
export const FIND_HIGHLIGHT_TAG = 'reqlens-find-highlight';
export const FIND_BAR_TAG = 'reqlens-find-bar';
export const FIND_PICK_TAG = 'reqlens-find-pick';

// ------------------------------------------------------------------------------------------------ validation

const KINDS: ReadonlySet<string> = new Set<FindValueKind>(['string', 'number', 'date']);
const SCAN_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const NODE_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A valid scan id, else null. */
export function sanitizeScanId(value: unknown): string | null {
  return typeof value === 'string' && SCAN_ID.test(value) ? value : null;
}

/** Canonical BCP-47 tags (≤ FIND_MAX_LOCALES, deduplicated), invalid ones dropped. */
export function sanitizeLocales(value: unknown, max = FIND_MAX_LOCALES): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, 16)) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 35) continue;
    let tag: string | undefined;
    try {
      // Pages sometimes write <html lang="pt_BR">.
      tag = Intl.getCanonicalLocales(item.trim().replace(/_/g, '-'))[0];
    } catch {
      tag = undefined;
    }
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** Candidates as the host accepts them: valid, distinct ids, known kinds, bounded values (≤ FIND_MAX_CANDIDATES). */
function sanitizeCandidates(raw: unknown[]): FindCandidateWire[] {
  const candidates: FindCandidateWire[] = [];
  const ids = new Set<number>();
  for (const item of raw.slice(0, FIND_MAX_CANDIDATES)) {
    if (!isRecord(item)) continue;
    const { id, kind, value, key } = item;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || ids.has(id)) continue;
    if (typeof kind !== 'string' || !KINDS.has(kind)) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > FIND_MAX_VALUE_CHARS) continue;
    ids.add(id);
    const candidate: FindCandidateWire = { id, kind: kind as FindValueKind, value };
    if (typeof key === 'string' && key.length <= 200) candidate.key = key;
    candidates.push(candidate);
  }
  return candidates;
}

/** The scan request as the host accepts it (the panel is authenticated, but the host still bounds everything). */
export function sanitizeFindScanRequest(raw: unknown): FindScanRequest | null {
  if (!isRecord(raw)) return null;
  const scanId = sanitizeScanId(raw.scanId);
  if (!scanId || !Array.isArray(raw.candidates)) return null;
  return { scanId, candidates: sanitizeCandidates(raw.candidates), locales: sanitizeLocales(raw.locales), watch: raw.watch === true };
}

/** The one-shot values scan as the host accepts it. */
export function sanitizeFindValuesRequest(raw: unknown): FindValuesRequest | null {
  if (!isRecord(raw) || !Array.isArray(raw.candidates)) return null;
  return { candidates: sanitizeCandidates(raw.candidates), locales: sanitizeLocales(raw.locales) };
}

const ELEMENT_REF = /^[A-Za-z0-9_-]{1,64}$/;

/** A valid element handle, else null. */
export function sanitizeElementRef(value: unknown): string | null {
  return typeof value === 'string' && ELEMENT_REF.test(value) ? value : null;
}

/**
 * An element query as the host accepts it: exactly one non-blank locator (selector / text ≤ ELEMENT_QUERY_MAX_CHARS,
 * value of a known kind ≤ FIND_MAX_VALUE_CHARS), limit clamped to [1, ELEMENT_MATCHES_MAX]. Null when invalid.
 */
export function sanitizeElementQuery(raw: unknown): ElementQuery | null {
  if (!isRecord(raw)) return null;
  const text = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.length <= ELEMENT_QUERY_MAX_CHARS ? v : null);
  const selector = text(raw.selector);
  const label = text(raw.text);
  let value: ElementValueQuery | null = null;
  if (isRecord(raw.value)) {
    const { kind, value: v, key } = raw.value;
    if (typeof kind === 'string' && KINDS.has(kind) && typeof v === 'string' && v.trim().length > 0 && v.length <= FIND_MAX_VALUE_CHARS) {
      value = { kind: kind as FindValueKind, value: v };
      if (typeof key === 'string' && key.length <= 200) value.key = key;
    }
  }
  if ([selector, label, value].filter((x) => x !== null).length !== 1) return null;
  const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? Math.round(raw.limit) : 20;
  const query: ElementQuery = { limit: Math.min(ELEMENT_MATCHES_MAX, Math.max(1, limit)), locales: sanitizeLocales(raw.locales) };
  if (selector !== null) query.selector = selector;
  if (label !== null) query.text = label;
  if (value !== null) query.value = value;
  if (raw.exact === true) query.exact = true;
  return query;
}

/** An element highlight request as the host accepts it (≤ 50 refs, label ≤ 200 characters). */
export function sanitizeElementHighlightRequest(raw: unknown): ElementHighlightRequest | null {
  if (!isRecord(raw) || !Array.isArray(raw.refs)) return null;
  const refs: string[] = [];
  for (const item of raw.refs.slice(0, 50)) {
    const ref = sanitizeElementRef(item);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  const index = typeof raw.index === 'number' && Number.isSafeInteger(raw.index) ? Math.min(Math.max(0, raw.index), Math.max(0, refs.length - 1)) : 0;
  const duration = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : ELEMENT_HIGHLIGHT_MS;
  return {
    refs,
    index,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
    durationMs: Math.min(ELEMENT_HIGHLIGHT_MAX_MS, Math.max(1000, Math.round(duration))),
  };
}

/** The locate request as the host accepts it. */
export function sanitizeFindLocateRequest(raw: unknown): FindLocateRequest | null {
  if (!isRecord(raw)) return null;
  const scanId = sanitizeScanId(raw.scanId);
  const { candidateId, nodeId } = raw;
  if (!scanId || typeof candidateId !== 'number' || !Number.isSafeInteger(candidateId) || candidateId < 0) return null;
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return { scanId, candidateId, nodeId, path: text(raw.path, 300), snippet: text(raw.snippet, 200) };
}
