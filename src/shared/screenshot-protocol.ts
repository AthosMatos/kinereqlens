/**
 * Screenshot tool protocol (src/ui/screenshot/**).
 *
 *  panel (panel.html)  ──Port 'reqlens-panel' calls shot*──►  frame host (ui.js, top frame): hides the overlay,
 *                                                             scrolls, hides fixed headers, runs the page-side
 *                                                             region / element picker, reports viewport metrics
 *  panel               ──runtime message CAPTURE_VISIBLE_TAB──►  service worker: chrome.tabs.captureVisibleTab
 *                                                             (sender = this extension's panel page or top-frame
 *                                                             content script of an open, active tab; ≤ 2 / s)
 *
 * The image never passes through the page side: the worker answers the panel directly.
 */

/** Viewport metrics of the page, in CSS px. */
export interface ShotViewport {
  /** window.innerWidth / innerHeight (what captureVisibleTab captures, scrollbars included). */
  innerWidth: number;
  innerHeight: number;
  /** documentElement.clientWidth / clientHeight (the visible content, scrollbars excluded). */
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  /** Scrollable document size. */
  scrollWidth: number;
  scrollHeight: number;
  /** location.hostname of the page (file names). */
  host: string;
  /**
   * Date.now() of the last pointer event the page itself received, i.e. the pointer was over the page and not over
   * the overlay (whose frame gets the events in its regions); 0 = none yet. The panel compares it with its own.
   */
  pointerAt?: number;
}

/** A rect in viewport CSS px. */
export interface ShotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ShotPickMode = 'region' | 'element';

/** Options of shotBegin. */
export interface ShotBeginOptions {
  /** Hide the overlay (and its pill) while the page is captured. */
  hideOverlay: boolean;
  /**
   * Hard cap of the hidden window (ms; automatic captures): the page side shows the overlay again this long after
   * hiding it, whatever the panel does, and ends the session as expired. Clamped to [SHOT_MIN_HIDDEN_CAP_MS,
   * SHOT_IDLE_MS].
   */
  maxHiddenMs?: number;
  /**
   * Open the session only when the page is free: refused with SHOT_BUSY_ERROR (nothing changed on the page) while
   * another capture session is open or Find in page shows a match / picks an element.
   */
  exclusive?: boolean;
}

/**
 * How a session ended (the answer of shotEnd): 'ok' = it was intact; 'cancelled' = Esc on the page; 'expired' = the
 * page side restored it already (no call for too long, or hidden longer than its cap); 'none' = no session was open.
 * Anything but 'ok' means the overlay may have been shown again while the panel was still capturing.
 */
export type ShotEndState = 'ok' | 'cancelled' | 'expired' | 'none';

/** What the page-side picker selected (null = cancelled). */
export interface ShotPickResult {
  mode: ShotPickMode;
  rect: ShotRect;
  /** Element mode: the picker's label (`tag#id.class  W × H`). */
  label?: string;
  /**
   * Element mode: page-side handle of the picked element (shotElement, findHighlight), so it can be captured with a
   * padding and captured again later. Valid while the page lives (≤ ELEMENT_REF_TTL_MS, src/shared/find-protocol.ts).
   */
  ref?: string;
}

/** An element measured by shotElement (after scrolling it into view). */
export interface ShotElementGeometry {
  /** The element's border box in viewport CSS px (not clipped to the viewport). */
  rect: ShotRect;
  /** Viewport metrics at that moment (scroll position included). */
  viewport: ShotViewport;
  /**
   * The element or an ancestor is `position: fixed`: it does not move with the page, so it is captured as it shows in
   * the viewport (no scrolling, no stitching).
   */
  fixed?: boolean;
}

/** Calls the panel makes to the frame host for a capture (added to PanelCalls). */
export interface ShotCalls {
  /** Start (or continue) a capture session; hides (or shows) the overlay as asked; waits two frames. */
  shotBegin(opts: ShotBeginOptions): ShotViewport;
  /**
   * Scroll the page to `y` (and `x`, default: the position the session started at; instant); `hideFixed` hides fixed /
   * sticky elements from now on. Waits two frames.
   */
  shotScroll(y: number, hideFixed: boolean, x?: number): ShotViewport;
  /** End the session: restore scroll position, fixed elements, the overlay. Says whether it was still intact. */
  shotEnd(): ShotEndState;
  /** Show the page-side picker until the user selects or cancels (Esc). */
  shotPick(mode: ShotPickMode): ShotPickResult | null;
  /**
   * Element captures with a padding: measure a located element (`ref` from findElements / shotPick), first scrolling
   * it into view when `scroll` (its scroll containers too — they are restored when the session ends). Null when the
   * element is gone.
   */
  shotElement(ref: string, scroll: boolean): ShotElementGeometry | null;
}

export type ShotCallName = keyof ShotCalls;

export const SHOT_CALLS: readonly ShotCallName[] = ['shotBegin', 'shotScroll', 'shotEnd', 'shotPick', 'shotElement'];

/** Answer of the CAPTURE_VISIBLE_TAB runtime message. */
export type CaptureVisibleResponse = { ok: true; dataUrl: string } | { ok: false; error: string };

/** Chrome allows MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2: captures start at least this far apart. */
export const CAPTURE_MIN_INTERVAL_MS = 520;
/** Panel side: a CAPTURE_VISIBLE_TAB request not answered within this long fails (a hung request ends the session). */
export const CAPTURE_REQUEST_TIMEOUT_MS = 10_000;
/** Page side: a session with the overlay hidden ends (restored, expired) after this long without a call. */
export const SHOT_HIDDEN_IDLE_MS = 5_000;
/** Page side: a session with the overlay shown ends after this long without a call. A pick waiting for the user never idles. */
export const SHOT_IDLE_MS = 30_000;
/** Smallest accepted `maxHiddenMs`. */
export const SHOT_MIN_HIDDEN_CAP_MS = 500;
/** shotBegin with `exclusive`: the page is busy (another capture session, or Find in page on the page). */
export const SHOT_BUSY_ERROR = 'The page is busy with another capture or Find in page';
/** Tag of the page-side picker layer. */
export const SHOT_LAYER_TAG = 'reqlens-shot-layer';

// ------------------------------------------------------------------------------------------------ padding

/** Default space kept around an element / region capture, in CSS px (settings.shotPadding). */
export const DEFAULT_SHOT_PADDING = 50;
/** Largest padding (CSS px) a capture or the setting accepts. */
export const SHOT_PADDING_MAX = 1000;
/**
 * Spare margin captured beyond the padding on every side (CSS px, clamped to the page): the padding of a capture can
 * then grow by up to this much by re-cropping the same picture, without a new capture (past it, the element is
 * captured again while it is still in the page). 200 px covers the usual "a bit more context" adjustments and adds
 * at most one extra row / column of tiles to a stitched capture.
 */
export const SHOT_SPARE_MARGIN = 200;
/** Long side of the preview image of a capture returned to the chat (px; the image itself keeps full resolution). */
export const SHOT_PREVIEW_MAX = 1568;
