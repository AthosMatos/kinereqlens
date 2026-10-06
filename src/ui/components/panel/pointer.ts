// OWNER: ui-shell agent. Pointer-capture drag sessions with rAF-throttled move callbacks.

export interface PointerSessionHandlers {
  /** Movement (px from the start point) before the drag "starts"; default 0. */
  threshold?: number;
  /** Throttled to one call per animation frame; dx/dy are relative to the pointerdown position. */
  onMove(dx: number, dy: number, event: PointerEvent): void;
  /** Always called once; `moved` is false when the threshold was never crossed (a click). */
  onEnd(moved: boolean, event: PointerEvent): void;
  /** Called when the threshold is first crossed (before the first onMove). */
  onStart?(event: PointerEvent): void;
}

/**
 * Start a drag from a pointerdown on `el`: captures the pointer (so iframes / the page never steal the
 * gesture), reports moves once per frame and cleans everything up on pointerup / cancel / capture loss.
 */
export function startPointerSession(down: PointerEvent, el: HTMLElement, handlers: PointerSessionHandlers): void {
  const { threshold = 0 } = handlers;
  const pointerId = down.pointerId;
  const x0 = down.clientX;
  const y0 = down.clientY;
  let moved = false;
  let frame = 0;
  let latest: PointerEvent | null = null;
  let ended = false;

  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer already released (synthetic events) — the listeners below still work while over `el`.
  }

  const flushMove = () => {
    frame = 0;
    const ev = latest;
    latest = null;
    if (ev && moved) handlers.onMove(ev.clientX - x0, ev.clientY - y0, ev);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
      moved = true;
      handlers.onStart?.(ev);
    }
    latest = ev;
    if (!frame) frame = requestAnimationFrame(flushMove);
  };

  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || ended) return;
    ended = true;
    if (frame) cancelAnimationFrame(frame);
    if (latest) flushMove();
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', finish);
    el.removeEventListener('lostpointercapture', finish);
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      // ignore
    }
    handlers.onEnd(moved, ev);
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
}

/** True when a pointerdown started on an interactive control (buttons, inputs, menus...) inside `container`. */
export function isInteractiveTarget(event: Event, container: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === container) return false;
    if (!(node instanceof Element)) continue;
    if (node.matches('button, a, input, select, textarea, label, [role="menu"], [role="dialog"], [contenteditable], [data-no-drag]')) {
      return true;
    }
  }
  return false;
}
