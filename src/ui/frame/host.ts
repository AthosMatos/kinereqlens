// Overlay host in the page (ui.js, top frame isolated world): <reqlens-overlay> on <html>, top layer, closed
// shadow root holding ONE cross-origin iframe (panel.html). The panel draws the whole UI inside that frame,
// so nothing kineReqLens shows is part of the page's DOM (window.find / Selection cannot reach it).
//
// The iframe covers the viewport; its clip-path is set to the regions the panel reports (panel, pill, open
// menus, toasts), so the rest of the page stays clickable. Also handles: top-layer re-raising, page modal
// dialogs and fullscreen elements (the host moves inside them so it is not inert), page CSS zoom, and the
// page removing the host.
import { OVERLAY_HOST_TAG } from '../../shared/constants';
import type { HitRect } from '../../shared/panel-protocol';

/** Controller for the overlay host element. */
export interface FrameHost {
  /** The `<reqlens-overlay>` element. */
  readonly host: HTMLElement;
  /** The panel iframe (inside the closed shadow root). */
  readonly iframe: HTMLIFrameElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  /** Regions of the viewport the panel takes pointer events in. */
  setHitRegions(rects: HitRect[] | 'all' | 'none'): void;
  /**
   * Screenshot tool: hide the overlay while the page is captured (independent of show / hide, which follow the
   * tab's open state), then restore it.
   */
  setCaptureHidden(hidden: boolean): void;
  /**
   * Find in page: hide the overlay (pill included) while the user looks at a match on the page or picks an element
   * (independent of show / hide and of setCaptureHidden), then restore it.
   */
  setPeekHidden(hidden: boolean): void;
  /** Find in page currently hides the overlay (setPeekHidden): automatic screenshots wait meanwhile. */
  readonly peekHidden: boolean;
  /** Called once if a newer overlay instance (e.g. after an extension reload) replaces this one. */
  onStale(fn: () => void): void;
  /** Remove the host and stop all observers / listeners. */
  destroy(): void;
}

/** Inline !important styles that make the host a full-viewport, click-through, unstyled layer. */
const HOST_STYLES: ReadonlyArray<[string, string]> = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['min-width', '0'],
  ['min-height', '0'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['background', 'transparent'],
  ['overflow', 'visible'],
  ['pointer-events', 'none'],
  ['z-index', '2147483647'],
  ['display', 'block'],
  ['color-scheme', 'normal'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['contain', 'none'],
  ['box-shadow', 'none'],
  ['outline', '0'],
  ['zoom', '1'],
];

/** The iframe fills the host; page CSS cannot reach it (closed shadow root). */
const FRAME_CSS = `:host { all: initial; }
iframe {
  position: fixed; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0;
  display: block; background: transparent; color-scheme: normal; pointer-events: auto;
  visibility: visible; opacity: 1; transform: none; filter: none;
}`;

/** No pointer events anywhere (before the panel reported its regions). */
const CLIP_NONE = 'polygon(0px 0px, 0px 0px, 0px 0px)';

/** Re-attach budget: a page that keeps removing the host is not fought forever. */
const REATTACH_LIMIT = 20;
const REATTACH_WINDOW_MS = 10_000;
const INSTANCE_ATTR = 'data-reqlens-instance';
/** Fullscreen elements that cannot hold the host (replaced / void elements). */
const NO_CHILDREN = new Set(['VIDEO', 'CANVAS', 'IMG', 'IFRAME', 'EMBED', 'OBJECT', 'AUDIO', 'INPUT', 'TEXTAREA', 'SELECT']);

type MoveBefore = (node: Node, child: Node | null) => void;

function supportsPopover(el: HTMLElement): boolean {
  return typeof el.showPopover === 'function' && typeof el.hidePopover === 'function';
}

function isPopoverOpen(el: HTMLElement): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return false;
  }
}

function isModal(el: Element): boolean {
  try {
    return el.matches(':modal');
  } catch {
    return false;
  }
}

function applyHostStyles(host: HTMLElement, display: 'block' | 'none'): void {
  for (const [prop, value] of HOST_STYLES) {
    host.style.setProperty(prop, prop === 'display' ? display : value, 'important');
  }
}

function adoptStyles(shadow: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(FRAME_CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = FRAME_CSS;
    shadow.appendChild(style);
  }
}

/** Remove overlay hosts left behind by previous UI instances (other worlds / extension reloads). */
function removeOtherHosts(keep: HTMLElement | null): void {
  for (const el of Array.from(document.querySelectorAll(OVERLAY_HOST_TAG))) {
    if (el !== keep) el.remove();
  }
}

/** clip-path covering exactly `rects` (union of rectangles). */
export function clipPathFor(rects: HitRect[]): string {
  const parts: string[] = [];
  for (const r of rects) {
    const w = Math.max(0, Math.round(r.width));
    const h = Math.max(0, Math.round(r.height));
    if (w === 0 || h === 0) continue;
    parts.push(`M ${Math.round(r.left)} ${Math.round(r.top)} h ${w} v ${h} h ${-w} Z`);
  }
  return parts.length ? `path(nonzero, "${parts.join(' ')}")` : CLIP_NONE;
}

/** Effective CSS zoom of an element (Chrome 128+ `currentCSSZoom`; computed `zoom` otherwise). */
function effectiveZoom(el: Element | null): number {
  if (!el) return 1;
  const current = (el as Element & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === 'number' && Number.isFinite(current) && current > 0) return current;
  let zoom = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(value) && value > 0) zoom *= value;
  }
  return zoom;
}

/**
 * Create and attach the overlay host with the panel iframe (`src`). It starts hidden; call `show()` when the
 * overlay is open.
 */
export function createFrameHost(src: string): FrameHost {
  removeOtherHosts(null);

  const host = document.createElement(OVERLAY_HOST_TAG);
  const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  host.setAttribute(INSTANCE_ATTR, instance);
  host.setAttribute('aria-live', 'off');
  applyHostStyles(host, 'none');
  const popover = supportsPopover(host);
  if (popover) host.popover = 'manual';

  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  adoptStyles(shadow);

  let visible = false;
  let destroyed = false;
  let staleHandlers: Array<() => void> = [];
  const reattachTimes: number[] = [];
  let clip = CLIP_NONE;
  /** Hidden while a page modal / fullscreen element is shown that kineReqLens cannot be moved inside. */
  let suppressed = false;
  /** The page modal dialog / fullscreen element the host currently sits in. */
  let blockedBy: Element | null = null;
  /** Hidden for a screenshot of the page (setCaptureHidden). */
  let captureHidden = false;
  /** Hidden while Find in page shows a match / picks an element (setPeekHidden). */
  let peekHidden = false;
  /** Hidden by a tool (screenshot capture, find peek) regardless of the open state. */
  const toolHidden = () => captureHidden || peekHidden;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'kineReqLens');
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.style.setProperty('clip-path', clip, 'important');
  shadow.appendChild(iframe);

  /**
   * While the overlay is not shown (closed, or open in the background for Claude Code — the panel may still run
   * Claude's commands headless) the frame is inert as well as `display: none`: it can never take the focus or a
   * pointer / key event, whatever the panel does. Only show() lifts it.
   */
  const setInert = (inert: boolean) => {
    iframe.inert = inert;
    if (inert) {
      iframe.setAttribute('tabindex', '-1');
      iframe.setAttribute('aria-hidden', 'true');
    } else {
      iframe.removeAttribute('tabindex');
      iframe.removeAttribute('aria-hidden');
    }
  };
  setInert(true);

  // ---- top layer ------------------------------------------------------------------------------------
  const raise = () => {
    if (!popover || !visible || suppressed || toolHidden() || !host.isConnected) return;
    try {
      if (isPopoverOpen(host)) host.hidePopover();
      host.showPopover();
    } catch {
      // Not connected / invalid state: the z-index fallback still applies.
    }
  };

  const moveBefore = (Element.prototype as unknown as { moveBefore?: MoveBefore }).moveBefore;

  /** Move the host under `parent` keeping the panel frame alive (Element.moveBefore, Chromium 133+). */
  const moveTo = (parent: Element): boolean => {
    if (host.parentNode === parent) return true;
    if (!moveBefore || !host.isConnected || !parent.isConnected) return false;
    try {
      moveBefore.call(parent, host, null);
      return true;
    } catch {
      return false;
    }
  };

  /** The page element that covers the page / makes everything else inert: fullscreen, else a modal dialog. */
  const blockingElement = (): Element | null => {
    const fs = document.fullscreenElement;
    if (fs && fs !== host) return fs;
    let modal: Element | null = null;
    // The last open modal in document order is usually the top-most one.
    for (const dialog of Array.from(document.querySelectorAll('dialog'))) if (isModal(dialog)) modal = dialog;
    return modal;
  };

  /**
   * Follow page modals / fullscreen: while one is shown, everything outside it is inert (a modal dialog) or
   * covered (fullscreen). Move inside it so the overlay stays usable on top; when that is not possible (a
   * <video> in fullscreen, no moveBefore), hide instead of painting a dead layer that forwards clicks to the
   * hidden page.
   */
  const placeHost = () => {
    if (destroyed) return;
    const blocking = blockingElement();
    const root = document.documentElement;
    if (blocking) {
      const canHold = !NO_CHILDREN.has(blocking.tagName);
      const inside = canHold && (blocking.contains(host) || moveTo(blocking));
      suppressed = !inside;
      blockedBy = inside ? blocking : null;
    } else {
      suppressed = false;
      blockedBy = null;
      if (root && host.isConnected && host.parentNode !== root && !moveTo(root)) root.appendChild(host);
    }
    if ((suppressed || toolHidden()) && popover && isPopoverOpen(host)) {
      try {
        host.hidePopover();
      } catch {
        /* ignore */
      }
    }
    host.style.setProperty('display', visible && !suppressed && !toolHidden() ? 'block' : 'none', 'important');
    observeTree();
    syncZoom();
    raise();
  };

  // Another element entering the top layer later (fullscreen, a page popover / dialog) would paint above
  // the overlay; placeHost re-raises it (or moves it inside a modal). Rate-limited so two parties doing the
  // same can never ping-pong.
  let lastPlace = 0;
  let placeTimer = 0;
  const onTopLayerChange = () => {
    if (destroyed) return;
    const now = Date.now();
    if (now - lastPlace < 100) {
      if (!placeTimer) {
        placeTimer = window.setTimeout(() => {
          placeTimer = 0;
          onTopLayerChange();
        }, 120);
      }
      return;
    }
    lastPlace = now;
    placeHost();
  };
  const onToggle = (e: Event) => {
    if (e.target !== host) onTopLayerChange();
  };
  const onClose = (e: Event) => {
    if (e.target instanceof HTMLDialogElement) onTopLayerChange();
  };
  document.addEventListener('fullscreenchange', onTopLayerChange, true);
  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('close', onClose, true);

  // ---- zoom -----------------------------------------------------------------------------------------
  /** The page's CSS zoom (e.g. html { zoom: 1.5 }) must not scale the overlay or misplace its popups. */
  const syncZoom = () => {
    if (destroyed) return;
    const zoom = effectiveZoom(host.parentElement);
    host.style.setProperty('zoom', Math.abs(zoom - 1) < 0.001 ? '1' : String(1 / zoom), 'important');
  };

  // ---- attach / re-attach ---------------------------------------------------------------------------
  const attach = () => {
    (document.documentElement ?? document.body)?.appendChild(host);
    placeHost();
  };

  const markStale = () => {
    const handlers = staleHandlers;
    staleHandlers = [];
    api.destroy();
    for (const fn of handlers) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };

  const reattachAllowed = (): boolean => {
    const now = Date.now();
    while (reattachTimes.length && now - (reattachTimes[0] ?? 0) > REATTACH_WINDOW_MS) reattachTimes.shift();
    if (reattachTimes.length >= REATTACH_LIMIT) return false;
    reattachTimes.push(now);
    return true;
  };

  const onMutation = () => {
    if (destroyed) return;
    if (host.isConnected) {
      // A dialog / fullscreen element we sit in stopped blocking without an event reaching us, or the
      // page's zoom changed.
      if (blockedBy && blockingElement() !== blockedBy) onTopLayerChange();
      else syncZoom();
      return;
    }
    const newer = document.querySelector(`${OVERLAY_HOST_TAG}:not([${INSTANCE_ATTR}="${instance}"])`);
    if (newer) {
      markStale();
      return;
    }
    if (!reattachAllowed()) return;
    // Removed by the page, or together with a dialog it was moved into. The panel frame reloads (it
    // reconnects and resumes from the state it handed over).
    blockedBy = null;
    attach();
  };

  const observer = new MutationObserver(onMutation);
  let observing: 'root' | 'tree' | null = null;
  let observedRoot: Element | null = null;
  const observeTree = () => {
    const root = document.documentElement;
    if (!root) return;
    // While inside a dialog / fullscreen element, any subtree change may remove it with us inside.
    const mode = blockedBy ? 'tree' : 'root';
    if (mode === observing && observedRoot === root) return;
    observer.disconnect();
    observing = mode;
    observedRoot = root;
    if (mode === 'tree') {
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'style', 'class'] });
    } else {
      observer.observe(root, { childList: true, attributes: true, attributeFilter: ['style', 'class'] });
      // document.open() / replacing <html> swaps the root element itself.
      observer.observe(document, { childList: true });
    }
  };

  window.addEventListener('resize', syncZoom);

  attach();
  // Set once the frame is connected, so it loads in this page's context.
  iframe.src = src;

  /** Apply a change of captureHidden / peekHidden. */
  const applyToolHidden = () => {
    if (!visible) return;
    if (toolHidden()) {
      if (popover && isPopoverOpen(host)) {
        try {
          host.hidePopover();
        } catch {
          // ignore
        }
      }
      host.style.setProperty('display', 'none', 'important');
    } else if (!host.isConnected) attach();
    else placeHost();
  };

  const api: FrameHost = {
    host,
    iframe,
    get visible() {
      return visible;
    },
    get peekHidden() {
      return peekHidden;
    },
    show() {
      if (destroyed) return;
      visible = true;
      setInert(false);
      applyHostStyles(host, toolHidden() ? 'none' : 'block');
      if (!host.isConnected) attach();
      else placeHost();
    },
    hide() {
      if (destroyed) return;
      visible = false;
      setInert(true);
      if (popover && isPopoverOpen(host)) {
        try {
          host.hidePopover();
        } catch {
          // ignore
        }
      }
      applyHostStyles(host, 'none');
      syncZoom();
    },
    setHitRegions(rects) {
      const next = rects === 'all' ? 'none' : rects === 'none' ? CLIP_NONE : clipPathFor(rects);
      if (next === clip) return;
      clip = next;
      iframe.style.setProperty('clip-path', clip, 'important');
    },
    setCaptureHidden(hidden) {
      if (destroyed || hidden === captureHidden) return;
      captureHidden = hidden;
      applyToolHidden();
    },
    setPeekHidden(hidden) {
      if (destroyed || hidden === peekHidden) return;
      peekHidden = hidden;
      applyToolHidden();
    },
    onStale(fn) {
      if (!destroyed) staleHandlers.push(fn);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      if (placeTimer) clearTimeout(placeTimer);
      window.removeEventListener('resize', syncZoom);
      document.removeEventListener('fullscreenchange', onTopLayerChange, true);
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('close', onClose, true);
      host.remove();
    },
  };
  return api;
}
