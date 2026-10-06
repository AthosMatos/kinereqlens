// Hit regions of the panel: the parts of the (viewport-sized) panel document that take pointer events. The
// frame host clips the iframe to them, so the page stays clickable everywhere else.
import type { HitRect } from '../../shared/panel-protocol';

/** Elements that take pointer events (everything else in .rl-root is pointer-events: none). */
const HIT_SELECTOR = '.rl-panel:not(.rl-panel--hidden), .rl-pill-btn, .rl-popup, .rl-toast';
/** While dragging / resizing (pointer captured) the whole viewport belongs to the gesture. */
const GESTURE_SELECTOR = '.rl-panel--dragging, .rl-panel--resizing';

/** Current hit regions of `root`. */
export function hitRegions(root: ParentNode, captured: boolean): HitRect[] | 'all' {
  if (captured || root.querySelector(GESTURE_SELECTOR)) return 'all';
  const rects: HitRect[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(HIT_SELECTOR))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // A pixel of margin keeps borders and focus rings hit-testable.
    rects.push({ left: Math.floor(r.left) - 1, top: Math.floor(r.top) - 1, width: Math.ceil(r.width) + 2, height: Math.ceil(r.height) + 2 });
  }
  return rects;
}

/**
 * Containers whose own re-renders never move a hit region (they live inside .rl-panel): the embedded terminal
 * and the WebSocket inspector's streaming timeline / connection tree.
 */
const STATIC_HIT_CONTAINERS = '.xterm, .rl-ws-list, .rl-ws-tree';

function insideTerminal(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(STATIC_HIT_CONTAINERS);
}

/** The regions last reported to the frame host (null before the first report). */
let reported: HitRect[] | 'all' | null = null;

/**
 * The hit regions the panel last reported to the frame host — where the overlay can paint and take the pointer (the
 * iframe is clipped to them). Null before the first report.
 */
export function reportedHitRegions(): HitRect[] | 'all' | null {
  return reported;
}

function sameRegions(a: HitRect[] | 'all' | null, b: HitRect[] | 'all'): boolean {
  if (a === b) return true;
  if (a === null || a === 'all' || b === 'all' || a.length !== b.length) return false;
  return a.every((r, i) => r.left === b[i]!.left && r.top === b[i]!.top && r.width === b[i]!.width && r.height === b[i]!.height);
}

/**
 * Report hit regions of `root` (a shadow root) whenever its layout may have changed: DOM / style / class
 * mutations, pointer capture, viewport resizes. Returns the stop function.
 */
export function watchHitRegions(root: ShadowRoot, report: (rects: HitRect[] | 'all') => void): () => void {
  let last: HitRect[] | 'all' | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let captured = 0;
  const compute = () => {
    timer = null;
    const next = hitRegions(root, captured > 0);
    if (sameRegions(last, next)) return;
    last = next;
    reported = next;
    report(next);
  };
  // Not requestAnimationFrame: while the frame is clipped away entirely (before the first report) the
  // browser may throttle its rendering, so animation frames would never come.
  const schedule = () => {
    if (!timer) timer = setTimeout(compute, 0);
  };
  // The embedded terminal (xterm.js) re-renders its rows on every output chunk: those mutations never move a
  // hit region (the terminal lives inside .rl-panel), so they do not trigger a recompute.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (!insideTerminal(record.target)) {
        schedule();
        return;
      }
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  const onGot = () => {
    captured++;
    schedule();
  };
  const onLost = () => {
    captured = Math.max(0, captured - 1);
    schedule();
  };
  root.addEventListener('gotpointercapture', onGot, true);
  root.addEventListener('lostpointercapture', onLost, true);
  window.addEventListener('resize', schedule);
  schedule();
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    root.removeEventListener('gotpointercapture', onGot, true);
    root.removeEventListener('lostpointercapture', onLost, true);
    window.removeEventListener('resize', schedule);
  };
}
