// What the user is doing with the overlay right now (src/ui/errors/autoShot.ts OverlayActivity), so automatic
// error-area screenshots never hide the overlay under the user's hands. Panel frame only: panel/main.tsx starts it
// with the App's shadow root.
//
// Where the pointer is: the frame host clips the panel iframe to its hit regions, so the panel receives pointer events
// exactly while the pointer is over the panel, the pill, a menu or a toast, and the page receives them everywhere else.
// The frame does not reliably get a leave event (nor an updated :hover) when the pointer exits through the clip, so
// "over the overlay" is decided by time: the panel's last pointer event is newer than the page's (the page side reports
// its own with the viewport metrics, ShotViewport.pointerAt). Both use Date.now().
import type { OverlayActivity } from '../errors/autoShot';
import { reportedHitRegions } from './hit';

/** Open menus, popovers and dialogs of the overlay (rendered ones only: a hidden view's dialog does not count). */
const POPUP_SELECTOR = '.rl-popup, [role="menu"], [role="dialog"], [aria-modal="true"]';
/** Panel drags / resizes (src/ui/App.tsx). */
const GESTURE_SELECTOR = '.rl-panel--dragging, .rl-panel--resizing';
/** <input> types the user types into. */
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

let root: ShadowRoot | null = null;
/** performance.now() of the last key / pointer / wheel event in the panel. */
let lastInputAt = -Infinity;
/** Date.now() of the last pointer event in the panel (0 = none). */
let lastPointerAt = 0;
let captured = 0;

/** The focused element, through shadow roots. */
function deepActiveElement(start: ShadowRoot): Element | null {
  let el: Element | null = start.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable;
}

function rendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** Track the user's input in the overlay (panel/main.tsx). Returns the stop function. */
export function watchOverlayActivity(shadow: ShadowRoot): () => void {
  root = shadow;
  const input = () => {
    lastInputAt = performance.now();
  };
  const pointer = () => {
    lastPointerAt = Date.now();
    input();
  };
  const got = () => {
    captured++;
  };
  const lost = () => {
    captured = Math.max(0, captured - 1);
  };
  const opts = { capture: true, passive: true } as const;
  const pointerTypes = ['pointerover', 'pointermove', 'pointerdown', 'pointerup', 'wheel'] as const;
  for (const type of pointerTypes) window.addEventListener(type, pointer, opts);
  window.addEventListener('keydown', input, opts);
  shadow.addEventListener('gotpointercapture', got, true);
  shadow.addEventListener('lostpointercapture', lost, true);
  return () => {
    for (const type of pointerTypes) window.removeEventListener(type, pointer, opts);
    window.removeEventListener('keydown', input, opts);
    shadow.removeEventListener('gotpointercapture', got, true);
    shadow.removeEventListener('lostpointercapture', lost, true);
    if (root === shadow) root = null;
  };
}

/**
 * What the user is doing with the overlay now. `pagePointerAt`: Date.now() of the last pointer event the page received
 * (ShotViewport.pointerAt); the pointer is over the overlay when the panel saw it last.
 */
export function overlayActivity(pagePointerAt = 0): OverlayActivity {
  const regions = reportedHitRegions();
  const pointerInside = lastPointerAt > 0 && lastPointerAt > pagePointerAt;
  const r = root;
  if (!r) return { regions, pointerInside, lastInputAt, popupOpen: false, gesture: captured > 0, typing: false };
  let focused = false;
  try {
    focused = document.hasFocus();
  } catch {
    focused = false;
  }
  return {
    regions,
    pointerInside,
    lastInputAt,
    popupOpen: Array.from(r.querySelectorAll(POPUP_SELECTOR)).some(rendered),
    gesture: captured > 0 || r.querySelector(GESTURE_SELECTOR) !== null,
    typing: focused && isTextField(deepActiveElement(r)),
  };
}

/** The clock of OverlayActivity.lastInputAt. */
export function activityNow(): number {
  return performance.now();
}
