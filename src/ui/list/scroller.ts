// OWNER: ui-list-menu agent (extracted from RequestList). Single-row horizontal scrollers of the list toolbar.
import { useLayoutEffect } from 'preact/hooks';

/**
 * Single-row horizontal scroller: flags `data-fade-start` / `data-fade-end` while content is hidden on that side
 * (the CSS fades that edge) and maps vertical wheel movement to horizontal scrolling. Pass `deps` that change
 * when the content changes (the scroller is re-measured).
 */
export function useHorizontalScroller(ref: { current: HTMLElement | null }, deps: readonly unknown[] = []): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-fade-start', max > 1 && el.scrollLeft > 1);
      el.toggleAttribute('data-fade-end', max > 1 && el.scrollLeft < max - 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
    };
  }, deps);
}
