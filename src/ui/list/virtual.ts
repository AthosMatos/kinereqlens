// OWNER: ui-shell agent. Fixed-row-height virtualization math (pure, unit tested).

/** Rows rendered beyond the viewport on each side. */
export const OVERSCAN_ROWS = 10;
/** Lists longer than this are virtualized. */
export const VIRTUALIZE_THRESHOLD = 200;

/** Half-open range [start, end) of row indexes to render. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = OVERSCAN_ROWS,
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.min(Math.max(0, first - overscan), count);
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

/**
 * The scrollTop needed to bring row `index` fully into view, or null when it already is.
 */
export function scrollTopToReveal(
  index: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number | null {
  if (index < 0 || rowHeight <= 0) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (viewportHeight > 0 && bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return null;
}

/** The row at the top edge of the viewport and how far it is scrolled past (for scroll anchoring). */
export function scrollAnchor(scrollTop: number, rowHeight: number): { index: number; offset: number } {
  if (rowHeight <= 0) return { index: 0, offset: 0 };
  const index = Math.floor(Math.max(0, scrollTop) / rowHeight);
  return { index, offset: Math.max(0, scrollTop) - index * rowHeight };
}
