// Page-side capture session of the screenshot tool (ui.js, top frame). Driven only by the authenticated panel
// connection (frame/server.ts → PanelSession). Hides the overlay while the page is captured, scrolls for
// full-page captures (fixed / sticky elements hidden after the first tile), runs the region / element picker,
// and always restores the page: on shotEnd, on Esc while the overlay is hidden, when the panel disconnects, when the
// panel stops calling (SHOT_HIDDEN_IDLE_MS while the overlay is hidden, SHOT_IDLE_MS while it is shown; never while
// a pick waits for the user — the picker has its own timeout) and when a hidden window passes the cap the panel asked
// for (`maxHiddenMs`, automatic captures). A session the page side ended by itself fails the panel's further calls
// and is reported by end() ('cancelled' / 'expired'), so the panel never keeps a picture that may show the overlay.
// The viewport metrics also say when the page last saw the pointer (ShotViewport.pointerAt): the overlay's frame gets
// the pointer events in its regions, the page everywhere else, so automatic captures can tell whether the pointer is
// over the overlay.
import type { ShotBeginOptions, ShotElementGeometry, ShotEndState, ShotPickMode, ShotPickResult, ShotViewport } from '../../../shared/screenshot-protocol';
import { SHOT_BUSY_ERROR, SHOT_HIDDEN_IDLE_MS, SHOT_IDLE_MS, SHOT_MIN_HIDDEN_CAP_MS } from '../../../shared/screenshot-protocol';
import { elementOf, refOf } from '../../frame/elementRefs';
import { startPicker } from './picker';
import type { PickerHandle } from './picker';
import { afterTwoFrames, hideFixedElements, isFixedPositioned, overrideRootStyle, readViewport, saveScrollPositions } from './viewport';

/** What the controller needs from the overlay host. */
export interface ShotFrame {
  setCaptureHidden(hidden: boolean): void;
  /** Find in page hides the overlay to show a match / pick an element: exclusive sessions are refused meanwhile. */
  readonly peekHidden?: boolean;
}

export interface ShotController {
  begin(opts: ShotBeginOptions): Promise<ShotViewport>;
  /** Scroll the window to (x, y); x defaults to where it was when the session began. */
  scroll(y: number, hideFixed: boolean, x?: number): Promise<ShotViewport>;
  pick(mode: ShotPickMode): Promise<ShotPickResult | null>;
  /** Measure a located element (elementRefs.ts), scrolling it into view first when `scroll`; null when it is gone. */
  element(ref: string, scroll: boolean): Promise<ShotElementGeometry | null>;
  /** Restore everything (idempotent) and say how the session ended; the next begin starts a fresh session. */
  end(): ShotEndState;
  dispose(): void;
}

export interface ShotControllerOptions {
  /** Idle end of a session whose overlay is hidden (default SHOT_HIDDEN_IDLE_MS). */
  hiddenIdleMs?: number;
  /** Idle end of a session whose overlay is shown (default SHOT_IDLE_MS). */
  idleMs?: number;
}

const CANCELLED = 'Screenshot cancelled';
const EXPIRED = 'Screenshot timed out — the overlay was shown again';

interface Session {
  scrollX: number;
  scrollY: number;
  restores: Array<() => void>;
  fixedHidden: boolean;
  overlayHidden: boolean;
  /** `scroll-behavior: auto` is forced on <html> (instant scrolls). */
  smoothOff: boolean;
}

/** A begin's `maxHiddenMs` as applied: clamped to [SHOT_MIN_HIDDEN_CAP_MS, SHOT_IDLE_MS]; null = no cap. */
export function hiddenCapOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(SHOT_IDLE_MS, Math.max(SHOT_MIN_HIDDEN_CAP_MS, Math.round(value)));
}

/** Pointer events that mean the pointer is over the page (outside the overlay's regions, which its frame takes). */
const PAGE_POINTER_EVENTS = ['pointermove', 'pointerdown', 'wheel'] as const;

export function createShotController(frame: ShotFrame, options: ShotControllerOptions = {}): ShotController {
  const hiddenIdleMs = options.hiddenIdleMs ?? SHOT_HIDDEN_IDLE_MS;
  const idleMs = options.idleMs ?? SHOT_IDLE_MS;
  /** When the page last saw the pointer (reported with the viewport: automatic captures wait while it is over the overlay). */
  let pointerAt = 0;
  const onPagePointer = () => {
    pointerAt = Date.now();
  };
  const listen = { capture: true, passive: true } as const;
  for (const type of PAGE_POINTER_EVENTS) window.addEventListener(type, onPagePointer, listen);
  const viewport = (): ShotViewport => ({ ...readViewport(), pointerAt });
  let session: Session | null = null;
  let picker: PickerHandle | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  /** Hard cap of the current hidden window (begin's maxHiddenMs). */
  let cap: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /**
   * The page side ended the session by itself (Esc → 'cancelled', a timeout → 'expired'): the panel's further calls
   * fail until it ends the session, and end() reports it.
   */
  let ended: 'cancelled' | 'expired' | null = null;

  const clearIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };

  const clearCap = () => {
    if (cap) clearTimeout(cap);
    cap = null;
  };

  /** (Re)arm the idle end after a call: short while the overlay is hidden, none while a pick waits for the user. */
  const touch = () => {
    clearIdle();
    if (!session || picker) return;
    idle = setTimeout(() => stop('expired'), session.overlayHidden ? hiddenIdleMs : idleMs);
  };

  /** End the session from the page side (Esc, a timeout): the page is restored right away. */
  const stop = (why: 'cancelled' | 'expired') => {
    if (!session) return;
    ended = why;
    restore();
  };

  /** While the overlay is hidden, Esc on the page cancels the capture (the panel cannot be reached). */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !session) return;
    stop('cancelled');
  };

  const check = () => {
    if (disposed || ended === 'cancelled') throw new Error(CANCELLED);
    if (ended === 'expired') throw new Error(EXPIRED);
  };

  /** Instant scrolling while the session lasts (a page's `scroll-behavior: smooth` would animate our scrolls). */
  const smoothOff = (s: Session) => {
    if (s.smoothOff) return;
    s.smoothOff = true;
    s.restores.push(overrideRootStyle('scroll-behavior', 'auto'));
  };

  const ensure = (): Session => {
    if (!session) session = { scrollX: window.scrollX, scrollY: window.scrollY, restores: [], fixedHidden: false, overlayHidden: false, smoothOff: false };
    return session;
  };

  const setOverlayHidden = (s: Session, hidden: boolean) => {
    if (hidden === s.overlayHidden) return;
    s.overlayHidden = hidden;
    frame.setCaptureHidden(hidden);
    if (hidden) window.addEventListener('keydown', onKeyDown, true);
    else {
      window.removeEventListener('keydown', onKeyDown, true);
      clearCap();
    }
  };

  /** Undo every change of the current session. */
  const restore = () => {
    clearIdle();
    clearCap();
    const s = session;
    session = null;
    const p = picker;
    picker = null;
    p?.cancel();
    if (!s) return;
    for (const undo of s.restores.reverse()) {
      try {
        undo();
      } catch {
        /* element gone */
      }
    }
    if (window.scrollX !== s.scrollX || window.scrollY !== s.scrollY) {
      window.scrollTo({ left: s.scrollX, top: s.scrollY, behavior: 'instant' as ScrollBehavior });
    }
    setOverlayHidden(s, false);
  };

  const api: ShotController = {
    async begin(opts) {
      // An automatic capture never joins (or disturbs) a session of someone else, nor Find in page's peek / pick.
      if (opts.exclusive && (session || ended || picker || frame.peekHidden)) throw new Error(SHOT_BUSY_ERROR);
      check();
      const s = ensure();
      setOverlayHidden(s, opts.hideOverlay);
      const capMs = opts.hideOverlay ? hiddenCapOf(opts.maxHiddenMs) : null;
      if (capMs !== null && !cap) cap = setTimeout(() => stop('expired'), capMs);
      touch();
      await afterTwoFrames();
      check();
      return viewport();
    },
    async scroll(y, hideFixed, x) {
      check();
      const s = ensure();
      touch();
      smoothOff(s);
      const top = Number.isFinite(y) ? Math.max(0, y) : 0;
      const left = x !== undefined && Number.isFinite(x) ? Math.max(0, x) : s.scrollX;
      window.scrollTo({ left, top, behavior: 'instant' as ScrollBehavior });
      if (hideFixed && !s.fixedHidden) {
        s.fixedHidden = true;
        s.restores.push(hideFixedElements());
      }
      await afterTwoFrames(60);
      check();
      return viewport();
    },
    pick(mode) {
      try {
        check();
      } catch (err) {
        return Promise.reject(err);
      }
      ensure();
      picker?.cancel();
      return new Promise((resolve) => {
        let handle: PickerHandle | null = null;
        let finished = false;
        handle = startPicker(mode, (picked) => {
          finished = true;
          if (handle && picker === handle) picker = null;
          // The session (still open unless restored) idles again until the panel's next call.
          touch();
          // The element itself stays here: the panel gets a handle (a padded capture measures it again).
          let result: ShotPickResult | null = null;
          if (picked) {
            const { element, ...rest } = picked;
            result = element ? { ...rest, ref: refOf(element) } : rest;
          }
          // The layer is gone from the page before the capture starts.
          void afterTwoFrames().then(() => resolve(result));
        });
        if (!finished) picker = handle;
        // The pick waits for the user: no idle end meanwhile (touch() skips while a picker is up).
        touch();
      });
    },
    async element(ref, scroll) {
      check();
      const s = ensure();
      touch();
      const el = elementOf(ref);
      if (!el) return null;
      if (scroll) {
        smoothOff(s);
        // Its scroll containers are put back when the session ends (the window's position too, as for every scroll).
        s.restores.push(saveScrollPositions(el));
        try {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
        } catch {
          /* detached meanwhile */
        }
        await afterTwoFrames(60);
        check();
        if (!el.isConnected) return null;
      }
      const r = el.getBoundingClientRect();
      const geometry: ShotElementGeometry = { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, viewport: viewport() };
      if (isFixedPositioned(el)) geometry.fixed = true;
      return geometry;
    },
    end() {
      const state: ShotEndState = ended ?? (session ? 'ok' : 'none');
      restore();
      ended = null;
      return state;
    },
    dispose() {
      restore();
      disposed = true;
      for (const type of PAGE_POINTER_EVENTS) window.removeEventListener(type, onPagePointer, listen);
    },
  };
  return api;
}
