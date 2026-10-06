// OWNER: ui-shell agent. Outside-pointer dismissal that works across the overlay's (closed) shadow boundary.
import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/**
 * While `active`, calls `onDismiss` when a pointerdown happens outside every element in `refs`:
 * anywhere else inside the overlay's shadow root, or anywhere on the page itself.
 *
 * Events from inside a shadow root are retargeted to its host for document-level listeners (and the
 * overlay stops their propagation at the shadow root), so two listeners are needed: one on the shadow
 * root for clicks inside the overlay, one on the document (capture) for clicks on the page.
 */
export function useOutsideDismiss(
  active: boolean,
  refs: ReadonlyArray<RefObject<HTMLElement>>,
  onDismiss: () => void,
): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!active) return;
    const anchor = refsRef.current.map((r) => r.current).find((el): el is HTMLElement => !!el);
    if (!anchor) return;
    const root = anchor.getRootNode();
    const isInside = (event: Event) => {
      const path = event.composedPath();
      return refsRef.current.some((r) => r.current !== null && path.includes(r.current));
    };

    const onInner = (event: Event) => {
      if (!isInside(event)) latest.current();
    };
    const onPage = (event: Event) => {
      if (root instanceof ShadowRoot && event.target === root.host) return; // handled by onInner
      latest.current();
    };
    const onWindowBlur = () => latest.current();

    root.addEventListener('pointerdown', onInner, true);
    const pageListener = root instanceof ShadowRoot;
    if (pageListener) document.addEventListener('pointerdown', onPage, true);
    // Clicking into a cross-origin iframe of the page only shows up as a window blur.
    window.addEventListener('blur', onWindowBlur);
    return () => {
      root.removeEventListener('pointerdown', onInner, true);
      if (pageListener) document.removeEventListener('pointerdown', onPage, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [active]);
}
