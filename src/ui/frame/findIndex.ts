// Find in page, page side (ui.js, top frame isolated world): the page's text as the matcher's target table
// (src/lib/findInPage.ts). Text nodes under <body> (open shadow roots and same-origin iframes included), the text of
// block elements built from several inline pieces, form values (never passwords) and a few attributes — with URL
// parts of href / src. Built in time slices; reading the DOM is invisible to the page (no events, no mutations).
import { normalizeText, rawRange, T_ATTR, T_ATTR_PART, T_BLOCK, T_FIELD, T_TEXT } from '../../lib/findInPage';
import type { TargetTable } from '../../lib/findInPage';

/** The page's text and where each piece lives. */
export interface PageIndex {
  table: TargetTable & { groups: number[] };
  /** Node of each target: the Text node (T_TEXT) or the element. */
  nodes: Node[];
  /** Same-origin iframes a target is inside (outermost first); null in the top document. */
  frames: Array<HTMLIFrameElement[] | null>;
  /** Roots to observe besides the top document: open shadow roots and same-origin iframe documents. */
  roots: Array<ShadowRoot | Document>;
  /** Characters indexed. */
  chars: number;
  /** Stopped at the text limit. */
  truncated: boolean;
}

export interface IndexOptions {
  /** Most characters indexed. */
  maxChars: number;
  /** Local names of elements never indexed (our own layers). */
  ownTags: ReadonlySet<string>;
  /** The slice is used up: call pause(). */
  overBudget(): boolean;
  /** Yield to the page. */
  pause(): Promise<void>;
  /** The scan was superseded: stop. */
  aborted(): boolean;
}

/** Elements whose content is never shown as text. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'datalist', 'object', 'embed', 'canvas']);
/** Text of these is not page text (the field's value is indexed instead) or not shown. */
const SKIP_TEXT_PARENTS = new Set(['textarea', 'option', 'optgroup', 'title', 'desc']);
/** Inline elements: their text joins the nearest block's text ("<b>1.258</b>.291"). Also used by the element locators. */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'label', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'del', 'ins',
]);
/** Attributes indexed (URL parts for href / src / srcset). */
const ATTRS = ['title', 'alt', 'aria-label', 'placeholder', 'value', 'href', 'src', 'srcset'] as const;
/** Inputs whose value is not shown as text (or must never be read). */
const HIDDEN_INPUTS = new Set(['password', 'hidden', 'file', 'checkbox', 'radio', 'image', 'range', 'color']);
const MAX_ATTR_CHARS = 2048;
const MAX_BLOCK_CHARS = 1000;
const MAX_URL_PARTS = 12;
const CHECK_EVERY = 64;
/** Nodes visited at most (a page moving nodes around between slices cannot keep the walk going). */
const MAX_NODES = 2_000_000;

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

interface WalkContext {
  walker: TreeWalker;
  frames: HTMLIFrameElement[] | null;
  doc: Document;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/**
 * Build the index of `doc` (time-sliced). Null when aborted. Elements with aria-hidden="true" are skipped when they
 * are not rendered either; closed shadow roots and cross-origin iframes cannot be read.
 */
export async function buildPageIndex(doc: Document, opts: IndexOptions): Promise<PageIndex | null> {
  const texts: string[] = [];
  const kinds: number[] = [];
  const groups: number[] = [];
  const nodes: Node[] = [];
  const frames: Array<HTMLIFrameElement[] | null> = [];
  const roots: Array<ShadowRoot | Document> = [];
  const groupIds = new Map<Element, number>();
  const blocks = new Map<Element, { parts: string[]; count: number; frames: HTMLIFrameElement[] | null }>();
  let chars = 0;
  let truncated = false;

  const groupOf = (el: Element | null): number => {
    if (!el) return -1;
    let id = groupIds.get(el);
    if (id === undefined) {
      id = groupIds.size;
      groupIds.set(el, id);
    }
    return id;
  };

  const add = (text: string, kind: number, node: Node, group: number, fr: HTMLIFrameElement[] | null): boolean => {
    if (!text) return true;
    if (chars + text.length > opts.maxChars) {
      truncated = true;
      return false;
    }
    chars += text.length;
    texts.push(text);
    kinds.push(kind);
    groups.push(group);
    nodes.push(node);
    frames.push(fr);
    return true;
  };

  const filter = {
    acceptNode(node: Node): number {
      if (isElement(node)) {
        const name = node.localName;
        if (SKIP_TAGS.has(name) || opts.ownTags.has(name)) return FILTER_REJECT;
        if (node.getAttribute('aria-hidden') === 'true' && node.getClientRects().length === 0) return FILTER_REJECT;
        return FILTER_ACCEPT;
      }
      const parent = node.parentElement;
      return parent && SKIP_TEXT_PARENTS.has(parent.localName) ? FILTER_REJECT : FILTER_ACCEPT;
    },
  };

  const walkerFor = (root: Node, d: Document) => d.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);

  const stack: WalkContext[] = [];
  const start = doc.body ?? doc.documentElement;
  if (!start) return { table: { texts, kinds, groups }, nodes, frames, roots, chars, truncated };
  stack.push({ walker: walkerFor(start, doc), frames: null, doc });

  const urlParts = (raw: string, d: Document): string[] => {
    const parts: string[] = [];
    let url: URL;
    try {
      url = new URL(raw, d.baseURI);
    } catch {
      return parts;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return parts;
    const push = (text: string) => {
      const norm = normalizeText(text);
      if (norm.length >= 3 && norm !== raw && !parts.includes(norm) && parts.length < MAX_URL_PARTS) parts.push(norm);
    };
    push(url.href);
    let path = url.pathname;
    try {
      path = decodeURI(path);
    } catch {
      /* keep encoded */
    }
    if (path.length > 1) push(path);
    for (const seg of url.pathname.split('/')) {
      if (!seg) continue;
      try {
        push(decodeURIComponent(seg));
      } catch {
        push(seg);
      }
    }
    for (const value of url.searchParams.values()) push(value);
    return parts;
  };

  const indexAttributes = (el: Element, ctx: WalkContext): boolean => {
    if (!el.hasAttributes()) return true;
    const name = el.localName;
    const group = groupOf(el);
    for (const attr of ATTRS) {
      const raw = el.getAttribute(attr);
      if (!raw || raw.length > MAX_ATTR_CHARS) continue;
      if (attr === 'value' && (name === 'input' || name === 'textarea' || name === 'select' || name === 'option' || name === 'button')) continue;
      if ((attr === 'src' || attr === 'href') && /^\s*(?:data|javascript):/i.test(raw)) continue;
      const norm = normalizeText(raw);
      if (norm.length < 3) continue;
      if (!add(norm, T_ATTR, el, group, ctx.frames)) return false;
      if (attr === 'href' || attr === 'src') {
        for (const part of urlParts(raw.trim(), ctx.doc)) if (!add(part, T_ATTR_PART, el, group, ctx.frames)) return false;
      } else if (attr === 'srcset') {
        for (const candidate of raw.split(',')) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) for (const part of urlParts(url, ctx.doc)) if (!add(part, T_ATTR_PART, el, group, ctx.frames)) return false;
        }
      }
    }
    return true;
  };

  const indexField = (el: Element, ctx: WalkContext): boolean => {
    const name = el.localName;
    let value = '';
    if (name === 'input') {
      const input = el as HTMLInputElement;
      if (HIDDEN_INPUTS.has((input.type || 'text').toLowerCase())) return true;
      value = input.value;
    } else if (name === 'textarea') {
      value = (el as HTMLTextAreaElement).value;
    } else if (name === 'select') {
      value = Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.text).join(' ');
    } else if (name === 'button') {
      return true;
    } else return true;
    const norm = normalizeText(value);
    return norm ? add(norm, T_FIELD, el, groupOf(el), ctx.frames) : true;
  };

  let steps = 0;
  while (stack.length > 0) {
    if (++steps > MAX_NODES) {
      truncated = true;
      break;
    }
    if (steps % CHECK_EVERY === 0 && opts.overBudget()) {
      await opts.pause();
      if (opts.aborted()) return null;
    }
    const ctx = stack[stack.length - 1]!;
    let node: Node | null;
    try {
      node = ctx.walker.nextNode();
    } catch {
      node = null;
    }
    if (!node) {
      stack.pop();
      continue;
    }
    if (isElement(node)) {
      if (!indexAttributes(node, ctx) || !indexField(node, ctx)) break;
      const shadow = (node as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        stack.push({ walker: walkerFor(shadow, ctx.doc), frames: ctx.frames, doc: ctx.doc });
      }
      if (node.localName === 'iframe' || node.localName === 'frame') {
        let inner: Document | null = null;
        try {
          inner = (node as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        const body = inner?.body ?? inner?.documentElement;
        if (inner && body) {
          roots.push(inner);
          stack.push({ walker: walkerFor(body, inner), frames: [...(ctx.frames ?? []), node as HTMLIFrameElement], doc: inner });
        }
      }
      continue;
    }
    const text = node as Text;
    const norm = normalizeText(text.data);
    if (!norm) continue;
    const parent = text.parentElement;
    if (!add(norm, T_TEXT, text, groupOf(parent), ctx.frames)) break;
    // The nearest block element collects the text of its inline pieces.
    let block = parent;
    while (block && INLINE_TAGS.has(block.localName) && block.parentElement) block = block.parentElement;
    if (block) {
      const acc = blocks.get(block);
      if (acc) {
        acc.parts.push(text.data);
        acc.count++;
      } else blocks.set(block, { parts: [text.data], count: 1, frames: ctx.frames });
    }
  }

  for (const [block, acc] of blocks) {
    if (acc.count < 2 || truncated) continue;
    const joined = normalizeText(acc.parts.join(''));
    if (joined.length >= 3 && joined.length <= MAX_BLOCK_CHARS && !add(joined, T_BLOCK, block, groupOf(block), acc.frames)) break;
  }
  return { table: { texts, kinds, groups }, nodes, frames, roots, chars, truncated };
}

// ------------------------------------------------------------------------------------------------ geometry

/** A rect in the top document's viewport (CSS px). */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type VisibilityCheck = (options?: Record<string, boolean>) => boolean;

/** Rendered: connected, checkVisibility (display, content-visibility, visibility), and some client rects. */
export function isRendered(el: Element): boolean {
  if (!el.isConnected) return false;
  const check = (el as Element & { checkVisibility?: VisibilityCheck }).checkVisibility;
  try {
    if (typeof check === 'function') {
      if (!check.call(el, { checkVisibilityCSS: true, visibilityProperty: true })) return false;
    } else {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
  } catch {
    return false;
  }
  return el.getClientRects().length > 0;
}

/** Offset of an iframe's content box in its own document's viewport. */
function frameOffset(frame: HTMLIFrameElement): { x: number; y: number } {
  const r = frame.getBoundingClientRect();
  let padX = 0;
  let padY = 0;
  try {
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    padX = Number.parseFloat(style?.paddingLeft ?? '0') || 0;
    padY = Number.parseFloat(style?.paddingTop ?? '0') || 0;
  } catch {
    /* detached */
  }
  return { x: r.left + frame.clientLeft + padX, y: r.top + frame.clientTop + padY };
}

/**
 * Viewport rect (top document) of a hit: the matched characters of a text node (a Range), else the element. Null when
 * the node is gone or not rendered.
 */
export function hitRect(node: Node, start: number, end: number, frameChain: readonly HTMLIFrameElement[] | null): ViewRect | null {
  if (!node.isConnected) return null;
  let rect: DOMRect;
  if (node.nodeType === 3) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || !isRendered(parent)) return null;
    const range = text.ownerDocument.createRange();
    const raw = rawRange(text.data, start, end) ?? [0, text.data.length];
    try {
      range.setStart(text, raw[0]);
      range.setEnd(text, raw[1]);
    } catch {
      return null;
    }
    rect = range.getBoundingClientRect();
  } else {
    const el = node as Element;
    if (!isRendered(el)) return null;
    rect = el.getBoundingClientRect();
  }
  if (rect.width <= 0 && rect.height <= 0) return null;
  let x = rect.left;
  let y = rect.top;
  if (frameChain) {
    for (let i = frameChain.length - 1; i >= 0; i--) {
      const frame = frameChain[i]!;
      if (!frame.isConnected || !isRendered(frame)) return null;
      const o = frameOffset(frame);
      x += o.x;
      y += o.y;
    }
  }
  return { x, y, width: rect.width, height: rect.height };
}

/** The element to scroll to for a hit (a text node's parent). */
export function hitElement(node: Node): Element | null {
  return node.nodeType === 3 ? (node as Text).parentElement : isElement(node) ? node : null;
}
