// Page-side highlights (ui.js, top frame isolated world), in closed shadow roots (open in the E2E build, like the
// overlay host) that never take pointer events, started only by the authenticated panel connection
// (frame/server.ts):
//  - the Initiator tab's component boxes (showHighlight): temporary boxes with a label over the instances the hook
//    found; they follow page scrolling and disappear after HIGHLIGHT_DURATION_MS, on Esc, or on the next highlight;
//  - Find in page's match box (showFindHighlight): one box that follows a live target (scrolling in any scroller,
//    resizes, layout shifts) until removed, with a label naming the JSON path and value. The label is CSS generated
//    content (attr()), so captured data never becomes page text window.find() / Selection could read.
import { HIGHLIGHT_DURATION_MS, HIGHLIGHT_LAYER_TAG } from '../../shared/initiator-protocol';
import type { ComponentRect } from '../../shared/initiator-protocol';
import { FIND_HIGHLIGHT_TAG } from '../../shared/find-protocol';

export interface HighlightBox {
  rect: ComponentRect;
  label: string;
}

const HOST_STYLES: ReadonlyArray<[string, string]> = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['background', 'transparent'],
  ['overflow', 'hidden'],
  ['pointer-events', 'none'],
  ['z-index', '2147483646'],
  ['display', 'block'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['zoom', '1'],
  ['color-scheme', 'normal'],
];

const CSS = `:host { all: initial; }
.box { position: fixed; box-sizing: border-box; pointer-events: none; border: 2px solid #0230bb; border-radius: 3px;
  background: rgba(2, 48, 187, 0.16); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7); animation: rl-pulse 0.9s ease-out 2; }
.label { position: fixed; pointer-events: none; padding: 2px 6px; border-radius: 4px; background: #0230bb; color: #ffffff;
  font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; white-space: nowrap;
  max-width: 60vw; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); }
@keyframes rl-pulse { 0% { box-shadow: 0 0 0 0 rgba(2, 48, 187, 0.55); } 100% { box-shadow: 0 0 0 10px rgba(2, 48, 187, 0); } }
@media (prefers-reduced-motion: reduce) { .box { animation: none; } }`;

let current: { remove(): void } | null = null;

/** Remove the highlight shown now (if any). */
export function clearHighlight(): void {
  current?.remove();
  current = null;
}

/**
 * Show boxes over `boxes` (viewport CSS px, measured just before). Returns the number drawn. Replaces any
 * highlight shown before.
 */
export function showHighlight(boxes: readonly HighlightBox[], durationMs = HIGHLIGHT_DURATION_MS): number {
  clearHighlight();
  const visible = boxes.filter((b) => b.rect.width > 0 || b.rect.height > 0).slice(0, 50);
  if (visible.length === 0) return 0;
  const host = document.createElement(HIGHLIGHT_LAYER_TAG);
  for (const [prop, value] of HOST_STYLES) host.style.setProperty(prop, value, 'important');
  const popover = typeof host.showPopover === 'function';
  if (popover) host.popover = 'manual';
  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const startX = window.scrollX;
  const startY = window.scrollY;
  const items = visible.map((b) => {
    const box = document.createElement('div');
    box.className = 'box';
    box.dataset.testid = 'rl-highlight-box';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = b.label;
    shadow.append(box, label);
    return { box, label, rect: b.rect };
  });
  const place = () => {
    const dx = window.scrollX - startX;
    const dy = window.scrollY - startY;
    for (const { box, label, rect } of items) {
      const x = rect.x - dx;
      const y = rect.y - dy;
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      label.style.left = `${Math.max(2, x)}px`;
      // Above the box when there is room, else inside its top edge.
      label.style.top = `${y >= 20 ? y - 19 : Math.max(2, y + 2)}px`;
    }
  };
  place();
  (document.documentElement ?? document.body).appendChild(host);
  if (popover) {
    try {
      host.showPopover();
    } catch {
      /* the z-index fallback still applies */
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') handle.remove();
  };
  const onScroll = () => place();
  const timer = window.setTimeout(() => handle.remove(), durationMs);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const handle = {
    remove() {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      host.remove();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return items.length;
}

// ------------------------------------------------------------------------------------------------ find in page

/** What the find highlight points at: a rect measured on demand (null while it is not on screen / gone). */
export interface LiveTarget {
  rect(): ComponentRect | null;
  /** JSON path and value snippet shown in the label (generated content). */
  path: string;
  snippet: string;
}

export interface FindHighlight {
  /** Point the box at another target (pulses once). */
  set(target: LiveTarget): void;
  /** Measure and place now. */
  update(): void;
  remove(): void;
}

/** Kinebot blue. */
const FIND_BLUE = '2, 48, 187';

const FIND_CSS = `:host { all: initial; }
.box { position: fixed; display: none; box-sizing: border-box; pointer-events: none; border-radius: 4px;
  outline: 2px solid rgb(${FIND_BLUE}); outline-offset: 3px; background: rgba(${FIND_BLUE}, 0.10);
  box-shadow: 0 0 0 7px rgba(${FIND_BLUE}, 0.16), 0 0 26px 6px rgba(${FIND_BLUE}, 0.38); }
.box.pulse { animation: rl-find-pulse 0.7s ease-out 2; }
.label { position: fixed; display: none; pointer-events: none; max-width: min(70vw, 560px); padding: 3px 8px 3px 7px;
  border-radius: 6px; background: rgb(${FIND_BLUE}); color: #ffffff; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; font: 600 11.5px/1.35 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  box-shadow: 0 4px 14px rgba(10, 16, 40, 0.35); }
.label::before { content: attr(data-path); }
.label::after { content: attr(data-snippet); margin-left: 6px; font-weight: 500; opacity: 0.86; }
@keyframes rl-find-pulse { 0% { outline-offset: 10px; outline-color: rgba(${FIND_BLUE}, 0.2); } 100% { outline-offset: 3px; } }
@media (prefers-reduced-motion: reduce) { .box.pulse { animation: none; } }`;

/** Re-measure at least this often while shown (layout shifts without scroll / resize events). */
const FIND_TRACK_MS = 250;

/**
 * Show the Find in page highlight (one at a time; replaces a previous one). It stays until `remove()`: following the
 * target through scrolling (any scroller, also inside same-origin iframes: `scrollTargets`), resizes and layout shifts.
 */
export function showFindHighlight(target: LiveTarget, scrollTargets: readonly EventTarget[] = []): FindHighlight {
  const host = document.createElement(FIND_HIGHLIGHT_TAG);
  for (const [prop, value] of HOST_STYLES) host.style.setProperty(prop, value, 'important');
  host.style.setProperty('z-index', '2147483646', 'important');
  const popover = typeof host.showPopover === 'function';
  if (popover) host.popover = 'manual';
  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = FIND_CSS;
  const box = document.createElement('div');
  box.className = 'box';
  box.dataset.testid = 'rl-find-highlight';
  const label = document.createElement('div');
  label.className = 'label';
  label.dataset.testid = 'rl-find-highlight-label';
  shadow.append(style, box, label);

  let current = target;
  let frame = 0;
  let removed = false;

  const place = () => {
    frame = 0;
    if (removed) return;
    const rect = current.rect();
    if (!rect) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${Math.max(rect.width, 2)}px`;
    box.style.height = `${Math.max(rect.height, 2)}px`;
    label.style.display = 'block';
    const lh = label.offsetHeight || 20;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Above the box (clear of its outline), else below it, else inside its top edge.
    let top = rect.y - lh - 9;
    if (top < 4) top = rect.y + rect.height + 9;
    if (top + lh > vh - 4) top = Math.max(4, rect.y + 4);
    label.style.top = `${top}px`;
    label.style.left = `${Math.max(4, Math.min(rect.x - 3, vw - label.offsetWidth - 4))}px`;
  };
  const schedule = () => {
    if (!frame && !removed) frame = requestAnimationFrame(place);
  };
  const setLabel = (t: LiveTarget) => {
    label.dataset.path = t.path;
    label.dataset.snippet = t.snippet;
  };

  setLabel(target);
  (document.documentElement ?? document.body).appendChild(host);
  if (popover) {
    try {
      host.showPopover();
    } catch {
      /* the z-index fallback still applies */
    }
  }
  place();
  box.classList.add('pulse');

  const listeners: Array<[EventTarget, string]> = [
    [window, 'scroll'],
    [window, 'resize'],
    ...scrollTargets.map((t): [EventTarget, string] => [t, 'scroll']),
  ];
  for (const [t, type] of listeners) t.addEventListener(type, schedule, { capture: true, passive: true });
  const timer = window.setInterval(schedule, FIND_TRACK_MS);

  return {
    set(next) {
      current = next;
      setLabel(next);
      box.classList.remove('pulse');
      // Restart the animation.
      void box.offsetWidth;
      box.classList.add('pulse');
      place();
    },
    update: place,
    remove() {
      if (removed) return;
      removed = true;
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
      for (const [t, type] of listeners) t.removeEventListener(type, schedule, true);
      host.remove();
    },
  };
}
