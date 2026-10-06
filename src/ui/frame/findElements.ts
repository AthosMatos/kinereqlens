// Element locators and one-shot value scans, page side (ui.js, top frame isolated world), next to Find in page's
// scanner and reusing it: the page index (findIndex.ts), the matcher and the value formats (src/lib/findInPage.ts).
// Driven only by the authenticated panel connection (frame/server.ts: findElements, findValues); nothing runs in the
// page's own JS world, reading the DOM fires no events, and the elements found are handed out as opaque refs
// (elementRefs.ts).
//
// Locators (src/shared/find-protocol.ts ElementQuery):
//  - selector: Element.matches over the top document and its open shadow roots, in document order;
//  - text: the page's text runs joined (src/lib/elementLocate.ts) — a hit becomes the smallest element holding the
//    whole of it — plus labels: aria-label, title, alt, placeholder (whole value or containing the query) and form
//    values. Case- and whitespace-insensitive; "contains" unless `exact`. When matches nest, only the innermost ones
//    are kept (the smallest element that shows the text);
//  - value: a response value, matched exactly as Find in page matches it (formatted numbers and dates, URL parts, word
//    and number boundaries); a text hit stands for the text node's parent element. `exact`: the hit is the element's
//    whole text.
// Same-origin iframes are not searched by the locators; elements in open shadow roots are.
import {
  ELEMENT_COUNT_CAP,
  FIND_MAX_HITS,
  FIND_MAX_TEXT_CHARS,
  FIND_SLICE_MS,
  sanitizeElementQuery,
  sanitizeFindValuesRequest,
} from '../../shared/find-protocol';
import type { ElementMatch, ElementQuery, ElementQueryResult, ElementValueQuery, FindResult, FindValuesResult } from '../../shared/find-protocol';
import { T_FIELD, T_TEXT, TextMatcher, normalizeText, summarizeHits, variantsFor } from '../../lib/findInPage';
import type { MatchVariant } from '../../lib/findInPage';
import { buildRunBuffer, findRunHits, labelMatches, normalizeQuery, runsText } from '../../lib/elementLocate';
import type { TextRun } from '../../lib/elementLocate';
import { INLINE_TAGS, buildPageIndex, hitElement, hitRect, isRendered } from './findIndex';
import type { PageIndex } from './findIndex';
import { OWN_TAGS, pageLocales } from './findInPage';
import { refOf } from './elementRefs';

/** Attributes that label an element (the `text` locator matches them as a whole or containing the query). */
const LABEL_ATTRS = ['aria-label', 'title', 'alt', 'placeholder'] as const;
const LABEL_SELECTOR = LABEL_ATTRS.map((a) => `[${a}]`).join(',');
/** Inputs whose value is never read (and never shown as text). */
const SECRET_INPUTS = new Set(['password', 'hidden', 'file']);
/** Elements walked at most by a selector query. */
const MAX_NODES = 2_000_000;
const TEXT_MAX = 200;
/** Matches whose selector is shortened (each costs a few querySelectorAll calls). */
const SHORT_SELECTORS = 20;
const SKIP_TEXT_PARENTS = new Set(['script', 'style', 'noscript', 'template', 'title']);

/** Work in slices, yielding through a MessageChannel (not throttled like timers in background tabs). */
interface Clock {
  over(): boolean;
  pause(): Promise<void>;
  close(): void;
  readonly ms: number;
}

function createClock(): Clock {
  const channel = new MessageChannel();
  let sliceStart = performance.now();
  let work = 0;
  let waiting: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const list = waiting;
    waiting = [];
    for (const fn of list) fn();
  };
  return {
    over: () => performance.now() - sliceStart > FIND_SLICE_MS,
    pause: () =>
      new Promise<void>((resolve) => {
        work += performance.now() - sliceStart;
        waiting.push(() => {
          sliceStart = performance.now();
          resolve();
        });
        channel.port2.postMessage(0);
      }),
    close: () => channel.port1.close(),
    get ms() {
      return work + (performance.now() - sliceStart);
    },
  };
}

function indexOf(clock: Clock): Promise<PageIndex | null> {
  return buildPageIndex(document, {
    maxChars: FIND_MAX_TEXT_CHARS,
    ownTags: OWN_TAGS,
    overBudget: () => clock.over(),
    pause: () => clock.pause(),
    aborted: () => false,
  });
}

// ------------------------------------------------------------------------------------------------ composed tree

/** Parent in the composed tree: a shadow root's parent is its host. */
function composedParent(node: Node): Node | null {
  if (node.nodeType === 11) return (node as ShadowRoot).host ?? null;
  return node.parentNode;
}

function composedParentElement(el: Element): Element | null {
  for (let p = composedParent(el); p; p = composedParent(p)) if (p.nodeType === 1) return p as Element;
  return null;
}

/** Is `inner` `outer` or inside it (across shadow roots)? */
function composedContains(outer: Node, inner: Node): boolean {
  for (let n: Node | null = inner; n; n = composedParent(n)) if (n === outer) return true;
  return false;
}

/** Chain from the document down to `node` (shadow roots included). */
function chainOf(node: Node): Node[] {
  const chain: Node[] = [];
  for (let n: Node | null = node; n; n = composedParent(n)) chain.push(n);
  return chain.reverse();
}

/** Document order across shadow roots (a host's shadow tree comes before its light children, as the walks see it). */
function sortComposed(elements: Element[]): Element[] {
  const chains = new Map<Element, Node[]>();
  const chain = (el: Element) => {
    let c = chains.get(el);
    if (!c) {
      c = chainOf(el);
      chains.set(el, c);
    }
    return c;
  };
  return elements.sort((a, b) => {
    if (a === b) return 0;
    const ca = chain(a);
    const cb = chain(b);
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    if (i >= ca.length) return -1;
    if (i >= cb.length) return 1;
    const x = ca[i]!;
    const y = cb[i]!;
    if (x.nodeType === 11) return -1;
    if (y.nodeType === 11) return 1;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

/** The smallest element holding both nodes (across shadow roots). */
function commonElement(a: Node, b: Node): Element | null {
  const ancestors = new Set<Node>();
  for (let n: Node | null = a; n; n = composedParent(n)) ancestors.add(n);
  for (let n: Node | null = b; n; n = composedParent(n)) {
    if (!ancestors.has(n)) continue;
    let el: Node | null = n;
    while (el && el.nodeType !== 1) el = composedParent(el);
    return el as Element | null;
  }
  return null;
}

/** Drop every element that contains another one of the set (the smallest elements win). */
function innermost(found: Set<Element>): Element[] {
  const outer = new Set<Element>();
  for (const el of found) {
    for (let p = composedParentElement(el); p; p = composedParentElement(p)) {
      if (found.has(p)) outer.add(p);
    }
  }
  return [...found].filter((el) => !outer.has(el));
}

/** The nearest block (non-inline) ancestor of a text node: runs in one block join without a space. */
function blockOf(node: Node): Element | null {
  let el = node.parentElement;
  while (el && INLINE_TAGS.has(el.localName) && el.parentElement) el = el.parentElement;
  return el;
}

// ------------------------------------------------------------------------------------------------ locators

async function bySelector(selector: string, clock: Clock): Promise<Element[]> {
  try {
    document.querySelector(selector);
  } catch {
    throw new Error('Invalid CSS selector');
  }
  const filter = {
    acceptNode: (node: Node) => (OWN_TAGS.has((node as Element).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  };
  const out: Element[] = [];
  const stack: TreeWalker[] = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT, filter)];
  let steps = 0;
  while (stack.length > 0 && out.length < ELEMENT_COUNT_CAP && steps < MAX_NODES) {
    if (++steps % 64 === 0 && clock.over()) await clock.pause();
    const walker = stack[stack.length - 1]!;
    const el = walker.nextNode() as Element | null;
    if (!el) {
      stack.pop();
      continue;
    }
    try {
      if (el.matches(selector)) out.push(el);
    } catch {
      /* not matchable in this tree */
    }
    const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
    if (shadow) stack.push(document.createTreeWalker(shadow, NodeFilter.SHOW_ELEMENT, filter));
  }
  return out;
}

/** Shadow roots of the top document (iframe documents of the index are left out). */
function shadowRoots(index: PageIndex): ShadowRoot[] {
  return index.roots.filter((r): r is ShadowRoot => r.nodeType === 11);
}

function byText(index: PageIndex, query: string, exact: boolean): Element[] {
  const found = new Set<Element>();
  const runs: TextRun[] = [];
  const runNodes: Text[] = [];
  let prevBlock: Element | null = null;
  let prevRaw = '';
  const { texts, kinds } = index.table;
  for (let t = 0; t < texts.length; t++) {
    if (index.frames[t]) continue;
    const kind = kinds[t];
    if (kind === T_TEXT) {
      const node = index.nodes[t] as Text;
      const block = blockOf(node);
      runs.push({ text: texts[t]!, spaced: block !== prevBlock || /^\s/.test(node.data) || /\s$/.test(prevRaw) });
      runNodes.push(node);
      prevBlock = block;
      prevRaw = node.data;
    } else if (kind === T_FIELD && labelMatches(texts[t], query, exact)) {
      found.add(index.nodes[t] as Element);
    }
  }
  const buf = buildRunBuffer(runs);
  const rejected = new Set<Element>();
  for (const hit of findRunHits(buf, query, ELEMENT_COUNT_CAP * 4)) {
    const el = commonElement(runNodes[hit.first]!, runNodes[hit.last]!);
    if (!el || found.has(el) || rejected.has(el)) continue;
    if (exact) {
      // The smallest element holding the hit must show exactly the query (no other text).
      let first = hit.first;
      let last = hit.last;
      while (first > 0 && composedContains(el, runNodes[first - 1]!)) first--;
      while (last + 1 < runNodes.length && composedContains(el, runNodes[last + 1]!)) last++;
      if (runsText(buf, first, last) !== query) {
        rejected.add(el);
        continue;
      }
    }
    found.add(el);
  }
  // Labels (any length: the page index keeps attributes of 3+ characters only); not <head> elements (<link title>).
  for (const root of [document, ...shadowRoots(index)]) {
    for (const el of Array.from(root.querySelectorAll(LABEL_SELECTOR))) {
      if (OWN_TAGS.has(el.localName) || found.has(el) || el.closest('head')) continue;
      if (LABEL_ATTRS.some((a) => labelMatches(el.getAttribute(a), query, exact))) found.add(el);
      if (found.size >= ELEMENT_COUNT_CAP * 2) break;
    }
  }
  return sortComposed(innermost(found));
}

/** Normalized text of an element (light DOM text nodes), for the `exact` check of value hits. */
function textOfElement(el: Element, max: number): string {
  let out = '';
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length <= max; n = walker.nextNode()) {
    if (SKIP_TEXT_PARENTS.has(n.parentElement?.localName ?? '')) continue;
    out += (n as Text).data;
  }
  return normalizeQuery(out);
}

function byValue(index: PageIndex, value: ElementValueQuery, exact: boolean, hints: readonly string[]): Element[] {
  const variants = variantsFor(value, pageLocales(hints));
  const outcome = new TextMatcher(index.table).match(variants, { maxHits: ELEMENT_COUNT_CAP, countCap: ELEMENT_COUNT_CAP });
  const found = new Set<Element>();
  for (const hit of outcome.hits) {
    if (index.frames[hit.target]) continue;
    const node = index.nodes[hit.target]!;
    const el = hitElement(node);
    if (!el || found.has(el)) continue;
    if (exact) {
      const whole = index.table.texts[hit.target] ?? '';
      if (hit.start !== 0 || hit.end !== whole.length) continue;
      // A text node's parent may show more than the node.
      if (node.nodeType === 3 && textOfElement(el, whole.length + 64) !== normalizeQuery(whole)) continue;
    }
    found.add(el);
  }
  return sortComposed(innermost(found));
}

// ------------------------------------------------------------------------------------------------ description

/** Visible text of an element (or its form value / label), ≤ TEXT_MAX characters. */
export function elementText(el: Element): string {
  const name = el.localName;
  let text = '';
  if (name === 'input') {
    const input = el as HTMLInputElement;
    if (!SECRET_INPUTS.has((input.type || 'text').toLowerCase())) text = input.value;
  } else if (name === 'textarea') text = (el as HTMLTextAreaElement).value;
  else if (name === 'select') text = Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.text).join(' ');
  else {
    const pieces: string[] = [];
    let length = 0;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && length < TEXT_MAX * 2; n = walker.nextNode()) {
      if (SKIP_TEXT_PARENTS.has(n.parentElement?.localName ?? '')) continue;
      pieces.push((n as Text).data);
      length += (n as Text).data.length;
    }
    text = pieces.join(' ');
  }
  let norm = normalizeText(text);
  if (!norm) for (const attr of LABEL_ATTRS) if (!norm) norm = normalizeText(el.getAttribute(attr) ?? '');
  return norm.length > TEXT_MAX ? `${norm.slice(0, TEXT_MAX - 1)}…` : norm;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function unique(root: Document | ShadowRoot, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * A CSS selector that finds `el` again within its document or shadow root (best effort): `#id` when unique, else a
 * `tag:nth-of-type(n)` chain from an ancestor with a unique id (or from the top), which `shorten` then cuts to the
 * shortest tail that is still unique (a few querySelectorAll calls: only for the first matches of a query).
 */
export function selectorOf(el: Element, shorten = true): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  let anchored = false;
  let node: Element | null = el;
  for (let depth = 0; node && depth < 64; depth++) {
    if (node.id) {
      const byId = `#${cssEscape(node.id)}`;
      if (unique(root, byId)) {
        parts.unshift(byId);
        anchored = true;
        break;
      }
    }
    let part = node.localName;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === node!.localName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  if (shorten && parts.length > 1) {
    // The full chain is unique by construction; keep the shortest unique tail (anchored at an id when there is one).
    for (let k = parts.length - 1; k >= 1; k--) {
      const tail = parts.slice(k);
      if (anchored && k > 0 && tail.length < parts.length) {
        const withAnchor = [parts[0]!, ...tail].join(' ');
        if (unique(root, withAnchor)) return withAnchor;
      }
      if (unique(root, tail.join(' > '))) return tail.join(' > ');
    }
  }
  return parts.join(' > ');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** What the panel learns about a match (page CSS px). `shorten`: spend a few queries on a short selector. */
export function describeElement(el: Element, shorten = true): ElementMatch {
  const r = el.getBoundingClientRect();
  return {
    ref: refOf(el),
    tag: el.localName,
    text: elementText(el),
    selector: selectorOf(el, shorten),
    rect: { x: round2(r.left + window.scrollX), y: round2(r.top + window.scrollY), width: round2(r.width), height: round2(r.height) },
    visible: isRendered(el) && r.width > 0 && r.height > 0,
  };
}

// ------------------------------------------------------------------------------------------------ api

/** findElements: the elements matching `raw` (an ElementQuery), described in document order. */
export async function locateElements(raw: unknown): Promise<ElementQueryResult> {
  const query: ElementQuery | null = sanitizeElementQuery(raw);
  if (!query) return { matches: [], total: 0, error: 'Give exactly one locator: a CSS selector, a text or a value' };
  const clock = createClock();
  try {
    let found: Element[];
    if (query.selector !== undefined) {
      found = await bySelector(query.selector, clock);
    } else {
      const index = await indexOf(clock);
      if (!index) return { matches: [], total: 0 };
      found = query.text !== undefined ? byText(index, normalizeQuery(query.text), query.exact === true) : byValue(index, query.value!, query.exact === true, query.locales);
    }
    const matches: ElementMatch[] = [];
    for (const el of found.slice(0, query.limit)) {
      matches.push(describeElement(el, matches.length < SHORT_SELECTORS));
      if (clock.over()) await clock.pause();
    }
    return { matches, total: Math.min(found.length, ELEMENT_COUNT_CAP) };
  } catch (err) {
    return { matches: [], total: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clock.close();
  }
}

/** findValues: one scan of the page for the candidates of `raw` — what it shows of each (found ones only). */
export async function scanValues(raw: unknown): Promise<FindValuesResult> {
  const req = sanitizeFindValuesRequest(raw);
  if (!req) return { results: [], error: 'Invalid request' };
  const clock = createClock();
  try {
    const locales = pageLocales(req.locales);
    const index = await indexOf(clock);
    if (!index) return { results: [] };
    const matcher = new TextMatcher(index.table);
    const results: FindResult[] = [];
    for (const candidate of req.candidates) {
      let variants: MatchVariant[];
      try {
        variants = variantsFor(candidate, locales);
      } catch {
        variants = [];
      }
      const job = matcher.begin(variants);
      while (!job.step()) if (clock.over()) await clock.pause();
      const outcome = job.outcome();
      const visible =
        outcome.total <= FIND_MAX_HITS ? outcome.hits.map((h) => hitRect(index.nodes[h.target]!, h.start, h.end, index.frames[h.target] ?? null) !== null) : [];
      const summary = summarizeHits(outcome, visible, variants);
      if (summary.total > 0) results.push({ id: candidate.id, ...summary });
      if (clock.over()) await clock.pause();
    }
    return {
      results,
      stats: { candidates: req.candidates.length, found: results.length, indexedChars: index.chars, truncated: index.truncated, locales, ms: Math.round(clock.ms) },
    };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clock.close();
  }
}
