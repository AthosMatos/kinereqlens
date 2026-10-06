// Page-side picker of the screenshot tool (ui.js): a temporary full-viewport layer in a closed shadow root
// (open in the E2E build, like the overlay host) to drag a region or pick an element. Started only by the
// authenticated panel connection (frame/server.ts), never by page messages. Every listener it adds is removed
// when it finishes; the layer is removed from the page.
import { elementLabel, normalizeElementRect, rectFromPoints } from '../../../lib/screenshot';
import type { Rect } from '../../../lib/screenshot';
import { SHOT_LAYER_TAG } from '../../../shared/screenshot-protocol';
import type { ShotPickMode, ShotPickResult } from '../../../shared/screenshot-protocol';
import { isOwnElement, readViewport } from './viewport';

export interface PickerHandle {
  /** Cancel (resolves the pick with null). Idempotent. */
  cancel(): void;
}

/** What the picker hands the controller: the selection, and in element mode the element (never sent to the panel). */
export type PickedArea = ShotPickResult & { element?: Element };

/** A pick that is never finished ends by itself. */
const PICK_TIMEOUT_MS = 5 * 60_000;
/** Region drags smaller than this (CSS px) count as a stray click. */
const MIN_REGION = 4;
const WHEEL_STEP_MS = 90;

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
  ['overflow', 'visible'],
  ['pointer-events', 'auto'],
  ['z-index', '2147483647'],
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
.layer { position: fixed; inset: 0; cursor: crosshair; outline: none; touch-action: none; user-select: none; }
.dim { position: fixed; inset: 0; background: rgba(10, 16, 40, 0.28); pointer-events: none; }
.box { position: fixed; display: none; box-sizing: border-box; pointer-events: none; border-radius: 2px; }
.box--element { border: 2px solid #0230bb; background: rgba(2, 48, 187, 0.14); }
.box--region { border: 1px solid #ffffff; outline: 1px solid #0230bb; box-shadow: 0 0 0 200vmax rgba(10, 16, 40, 0.38); }
.label { position: fixed; display: none; pointer-events: none; padding: 3px 6px; border-radius: 4px; background: #0230bb;
  color: #ffffff; font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); }
.hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center;
  max-width: calc(100vw - 32px); padding: 7px 12px; border-radius: 8px; background: rgba(18, 22, 36, 0.92); color: #e8ebf3;
  font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; white-space: nowrap; overflow: hidden;
  pointer-events: none; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
.hint b { color: #ffffff; font-weight: 600; }
.kbd { display: inline-block; min-width: 16px; padding: 1px 4px; border: 1px solid rgba(255, 255, 255, 0.3); border-bottom-width: 2px;
  border-radius: 4px; font: 500 10.5px/1.2 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; text-align: center; }`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Node): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  parent.appendChild(node);
  return node;
}

/** Hint line: plain text and key caps (textContent only). */
function fillHint(hint: HTMLElement, parts: Array<string | { key: string }>): void {
  for (const part of parts) {
    if (typeof part === 'string') hint.appendChild(document.createTextNode(part));
    else el('span', 'kbd', hint).textContent = part.key;
  }
}

/**
 * Show the picker. `done` is called exactly once: with the selection (viewport CSS px, clipped to the visible
 * content) or null when cancelled.
 */
export function startPicker(mode: ShotPickMode, done: (result: PickedArea | null) => void): PickerHandle {
  const host = document.createElement(SHOT_LAYER_TAG);
  for (const [prop, value] of HOST_STYLES) host.style.setProperty(prop, value, 'important');
  const popover = typeof host.showPopover === 'function';
  if (popover) host.popover = 'manual';
  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const layer = el('div', 'layer', shadow);
  layer.tabIndex = -1;
  layer.setAttribute('role', 'application');
  layer.setAttribute('aria-label', mode === 'region' ? 'kineReqLens screenshot: drag to select an area' : 'kineReqLens screenshot: pick an element');
  const dim = mode === 'region' ? el('div', 'dim', layer) : null;
  const box = el('div', `box box--${mode}`, layer);
  const label = el('div', 'label', layer);
  const hint = el('div', 'hint', layer);
  if (mode === 'region') fillHint(hint, [{ key: 'Drag' }, ' to select an area · ', { key: 'Esc' }, ' cancel']);
  else fillHint(hint, [{ key: 'Click' }, ' capture · ', { key: '↑' }, ' ', { key: '↓' }, ' / wheel parent · child · ', { key: 'Esc' }, ' cancel']);

  let finished = false;
  let current: Element | null = null;
  /** Elements we went up from (ArrowDown walks back down this path). */
  let below: Element[] = [];
  let pointer: { x: number; y: number } | null = null;
  let dragStart: { x: number; y: number; id: number } | null = null;
  let region: Rect | null = null;
  let lastWheel = 0;

  const viewportSize = () => {
    const v = readViewport();
    return { width: v.clientWidth, height: v.clientHeight };
  };

  const showBox = (rect: Rect | null, text: string) => {
    if (!rect) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    label.textContent = text;
    label.style.display = 'block';
    const lw = label.offsetWidth;
    const lh = label.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.y - lh - 4;
    if (top < 4) top = rect.y + rect.height + 4;
    if (top + lh > vh - 4) top = Math.max(4, rect.y + 4);
    label.style.top = `${top}px`;
    label.style.left = `${Math.max(4, Math.min(rect.x, vw - lw - 4))}px`;
  };

  const elementRect = (target: Element | null): Rect | null =>
    target ? normalizeElementRect(target.getBoundingClientRect(), viewportSize()) : null;

  const describe = (target: Element, rect: Rect): string =>
    elementLabel({ tag: target.localName || target.tagName, id: target.id, classes: Array.from(target.classList) }, rect);

  const renderElement = () => {
    const rect = elementRect(current);
    showBox(rect, current && rect ? describe(current, rect) : '');
  };

  const hitTest = (x: number, y: number): Element | null => {
    for (const candidate of document.elementsFromPoint(x, y)) {
      if (candidate === host || isOwnElement(candidate)) continue;
      return candidate;
    }
    return null;
  };

  const setCurrent = (next: Element | null, resetPath: boolean) => {
    if (resetPath) below = [];
    current = next;
    renderElement();
  };

  const goParent = () => {
    if (!current) {
      setCurrent(hitTest(window.innerWidth / 2, window.innerHeight / 2), true);
      return;
    }
    const parent = current.parentElement;
    if (!parent || current === document.documentElement) return;
    below.push(current);
    setCurrent(parent, false);
  };

  const goChild = () => {
    if (!current) {
      setCurrent(hitTest(window.innerWidth / 2, window.innerHeight / 2), true);
      return;
    }
    const back = below.pop();
    if (back && back.isConnected && current.contains(back)) {
      setCurrent(back, false);
      return;
    }
    below = [];
    const children = Array.from(current.children).filter((c) => !isOwnElement(c));
    const contains = (c: Element) => {
      if (!pointer) return false;
      const r = c.getBoundingClientRect();
      return pointer.x >= r.left && pointer.x < r.right && pointer.y >= r.top && pointer.y < r.bottom;
    };
    const next = children.find(contains) ?? children.find((c) => elementRect(c) !== null);
    if (next) setCurrent(next, false);
  };

  const finish = (result: PickedArea | null) => {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      done(result);
    } catch {
      /* caller's problem */
    }
  };

  const finishElement = () => {
    if (!current) return;
    const rect = elementRect(current);
    if (!rect) return;
    finish({ mode: 'element', rect, label: describe(current, rect), element: current });
  };

  // ---- listeners (all removed in cleanup) -------------------------------------------------------------
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    if (mode === 'region') {
      dragStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
      try {
        layer.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (mode === 'element') {
      const next = hitTest(e.clientX, e.clientY);
      if (next === current) return;
      // After ↑ / wheel up, moving inside the chosen ancestor keeps it.
      if (current && next && below.length > 0 && current.contains(next)) return;
      setCurrent(next, true);
      return;
    }
    if (!dragStart) return;
    if (dim) dim.style.display = 'none';
    region = normalizeElementRect(
      (() => {
        const r = rectFromPoints(dragStart.x, dragStart.y, e.clientX, e.clientY);
        return { left: r.x, top: r.y, width: r.width, height: r.height };
      })(),
      viewportSize(),
    );
    showBox(region, region ? `${Math.round(region.width)} × ${Math.round(region.height)}` : '');
  };
  const onPointerUp = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    if (mode === 'element') {
      if (!current) setCurrent(hitTest(e.clientX, e.clientY), true);
      finishElement();
      return;
    }
    if (!dragStart) return;
    dragStart = null;
    if (region && region.width >= MIN_REGION && region.height >= MIN_REGION) {
      finish({ mode: 'region', rect: region });
      return;
    }
    region = null;
    showBox(null, '');
    if (dim) dim.style.display = 'block';
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (mode !== 'element' || e.deltaY === 0) return;
    const now = Date.now();
    if (now - lastWheel < WHEEL_STEP_MS) return;
    lastWheel = now;
    if (e.deltaY < 0) goParent();
    else goChild();
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const handled = (() => {
      switch (e.key) {
        case 'Escape':
          finish(null);
          return true;
        case 'ArrowUp':
          if (mode === 'element') goParent();
          return mode === 'element';
        case 'ArrowDown':
          if (mode === 'element') goChild();
          return mode === 'element';
        case 'Enter':
          if (mode === 'element') finishElement();
          return mode === 'element';
        default:
          return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const onScrollOrResize = () => {
    if (mode === 'element') renderElement();
    else if (!dragStart) showBox(null, '');
  };
  const onPageHide = () => finish(null);

  layer.addEventListener('pointerdown', onPointerDown);
  layer.addEventListener('pointermove', onPointerMove);
  layer.addEventListener('pointerup', onPointerUp);
  layer.addEventListener('wheel', onWheel, { passive: false });
  layer.addEventListener('contextmenu', swallow);
  layer.addEventListener('click', swallow);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  window.addEventListener('pagehide', onPageHide);
  const timeout = setTimeout(() => finish(null), PICK_TIMEOUT_MS);

  function cleanup(): void {
    clearTimeout(timeout);
    layer.removeEventListener('pointerdown', onPointerDown);
    layer.removeEventListener('pointermove', onPointerMove);
    layer.removeEventListener('pointerup', onPointerUp);
    layer.removeEventListener('wheel', onWheel);
    layer.removeEventListener('contextmenu', swallow);
    layer.removeEventListener('click', swallow);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
    window.removeEventListener('pagehide', onPageHide);
    if (popover) {
      try {
        host.hidePopover();
      } catch {
        /* not shown */
      }
    }
    host.remove();
  }

  (document.documentElement ?? document.body).appendChild(host);
  if (popover) {
    try {
      host.showPopover();
    } catch {
      /* z-index fallback */
    }
  }
  layer.focus({ preventScroll: true });
  if (mode === 'element' && pointer === null) renderElement();

  return { cancel: () => finish(null) };
}
