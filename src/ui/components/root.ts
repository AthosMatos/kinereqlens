// OWNER: ui-shell agent. Registry of the overlay's render root inside the shadow root.
//
// Module-level helpers (toast, clipboard fallback) need a place inside the shadow root to attach
// transient elements without portals to document.body. The panel entry (panel/main.tsx) registers the container.

let uiRoot: HTMLElement | null = null;

/** Register (or clear with null) the element the overlay renders into. Called by panel/main.tsx. */
export function setUiRoot(el: HTMLElement | null): void {
  uiRoot = el;
}

/** Clear the registration, but only if `el` is still the registered root (a newer mount may own it). */
export function clearUiRoot(el: HTMLElement): void {
  if (uiRoot === el) uiRoot = null;
}

/** The overlay render container inside the shadow root, or null before mount / after destroy. */
export function getUiRoot(): HTMLElement | null {
  return uiRoot && uiRoot.isConnected ? uiRoot : null;
}

/** Currently focused element inside the overlay's shadow root (null when focus is elsewhere). */
export function getActiveElementInUi(): HTMLElement | null {
  const root = uiRoot?.getRootNode();
  if (root && root instanceof ShadowRoot) {
    const active = root.activeElement;
    return active instanceof HTMLElement ? active : null;
  }
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}
