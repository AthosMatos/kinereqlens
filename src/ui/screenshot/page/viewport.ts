// Page-side helpers of the screenshot tool (ui.js, top frame isolated world): viewport metrics, frame waits,
// hiding fixed / sticky elements for full-page captures. No Preact here (ui.js stays small).
import { OVERLAY_HOST_TAG } from '../../../shared/constants';
import { SHOT_LAYER_TAG } from '../../../shared/screenshot-protocol';
import type { ShotViewport } from '../../../shared/screenshot-protocol';

/** The element whose client size is the viewport (body in quirks mode). */
function viewportElement(): Element {
  return document.compatMode === 'BackCompat' && document.body ? document.body : document.documentElement;
}

/** Current viewport metrics (CSS px). */
export function readViewport(): ShotViewport {
  const de = document.documentElement;
  const body = document.body;
  const vp = viewportElement();
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  return {
    innerWidth,
    innerHeight,
    clientWidth: vp.clientWidth || innerWidth,
    clientHeight: vp.clientHeight || innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollWidth: Math.max(de?.scrollWidth ?? 0, body?.scrollWidth ?? 0, innerWidth),
    scrollHeight: Math.max(de?.scrollHeight ?? 0, body?.scrollHeight ?? 0, innerHeight),
    host: location.hostname,
  };
}

/**
 * Resolve after two animation frames (the change is then composited, so captureVisibleTab sees it), plus a short
 * settle delay. A timeout covers throttled rendering.
 */
export function afterTwoFrames(settleMs = 30): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      setTimeout(resolve, settleMs);
    };
    const fallback = setTimeout(finish, 250);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

/** Our own elements in the page (never hidden / picked). */
export function isOwnElement(el: Element): boolean {
  return el.localName === OVERLAY_HOST_TAG || el.localName === SHOT_LAYER_TAG;
}

interface Hidden {
  el: HTMLElement | SVGElement;
  value: string;
  priority: string;
}

/** Elements visited at most when looking for fixed / sticky elements (huge DOMs are not fully scanned). */
const SCAN_LIMIT = 30_000;

/**
 * Hide every visible `position: fixed | sticky` element that intersects the viewport (headers, cookie bars,
 * chat buttons), so they appear once (first tile) instead of on every tile of a full-page capture. Returns the
 * restore function.
 */
export function hideFixedElements(): () => void {
  const hidden: Hidden[] = [];
  const root = document.documentElement;
  if (!root) return () => undefined;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let visited = 0;
  for (let node = walker.nextNode(); node && visited < SCAN_LIMIT; node = walker.nextNode(), visited++) {
    const el = node as Element;
    if (isOwnElement(el) || !(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    hidden.push({ el, value: el.style.getPropertyValue('visibility'), priority: el.style.getPropertyPriority('visibility') });
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  return () => {
    for (const h of hidden.splice(0)) {
      if (h.value) h.el.style.setProperty('visibility', h.value, h.priority);
      else h.el.style.removeProperty('visibility');
    }
  };
}

/** Set an inline !important style on <html> for the capture; returns the restore function. */
export function overrideRootStyle(prop: string, value: string): () => void {
  const root = document.documentElement;
  if (!root) return () => undefined;
  const prev = root.style.getPropertyValue(prop);
  const prio = root.style.getPropertyPriority(prop);
  root.style.setProperty(prop, value, 'important');
  return () => {
    if (prev) root.style.setProperty(prop, prev, prio);
    else root.style.removeProperty(prop);
  };
}

/** The parent of a node in the composed tree (a shadow root's host). */
function composedParentElement(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (parent.nodeType === 11) return (parent as ShadowRoot).host ?? null;
  return parent.nodeType === 1 ? (parent as Element) : null;
}

/**
 * Remember the scroll position of every scroll container around `el` (not the window: the session restores it), so a
 * scrollIntoView for a capture can be undone. Returns the restore function (instant scrolls).
 */
export function saveScrollPositions(el: Element): () => void {
  const saved: Array<{ el: Element; left: number; top: number }> = [];
  const root = document.scrollingElement ?? document.documentElement;
  for (let node = composedParentElement(el); node && saved.length < 64; node = composedParentElement(node)) {
    if (node === root || node === document.body || node === document.documentElement) continue;
    if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) continue;
    saved.push({ el: node, left: node.scrollLeft, top: node.scrollTop });
  }
  return () => {
    for (const s of saved) {
      if (s.el.scrollLeft === s.left && s.el.scrollTop === s.top) continue;
      try {
        s.el.scrollTo({ left: s.left, top: s.top, behavior: 'instant' as ScrollBehavior });
      } catch {
        s.el.scrollLeft = s.left;
        s.el.scrollTop = s.top;
      }
    }
  };
}

/** `el` or one of its ancestors is `position: fixed` (it stays put while the page scrolls). */
export function isFixedPositioned(el: Element): boolean {
  for (let node: Element | null = el; node; node = composedParentElement(node)) {
    if (node === document.documentElement) return false;
    try {
      if (getComputedStyle(node).position === 'fixed') return true;
    } catch {
      return false;
    }
  }
  return false;
}
