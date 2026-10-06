/**
 * Pure geometry of element / region captures with a padding (src/ui/screenshot/engine.ts captureArea, the result
 * view's padding control, the MCP `screenshot` tool in src/ui/control/shot.ts). No DOM access; unit-tested
 * (tests/unit/element-shot.test.ts).
 *
 * Coordinates are page (document) CSS px unless noted. A capture covers the element plus the padding plus a spare
 * margin (SHOT_SPARE_MARGIN) on every side, clamped to the page, so the padding can later grow by re-cropping the
 * same picture; past the captured margin a new capture is needed (unless the page edge is the limit anyway).
 */
import { DEFAULT_MAX_PAGE_HEIGHT, MAX_CANVAS_AREA, MAX_CANVAS_SIDE, intersectRect, normalizeRect } from './screenshot';
import type { Rect, Size } from './screenshot';
import { SHOT_PADDING_MAX, SHOT_PREVIEW_MAX } from '../shared/screenshot-protocol';

export type Side = 'left' | 'top' | 'right' | 'bottom';

export const SIDES: readonly Side[] = ['left', 'top', 'right', 'bottom'];

/** A value per side. */
export type Sides = Record<Side, number>;

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** A padding as accepted: a finite number, rounded and clamped to [0, max]; anything else is `fallback`. */
export function sanitizePadding(value: unknown, fallback: number, max = SHOT_PADDING_MAX): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), 0, max);
}

/** `rect` grown by `by` CSS px on every side. */
export function growRect(rect: Rect, by: number): Rect {
  const r = normalizeRect(rect);
  const b = Math.max(0, finite(by));
  return { x: r.x - b, y: r.y - b, width: r.width + 2 * b, height: r.height + 2 * b };
}

/** The page as a rect. */
export function pageRect(doc: Size): Rect {
  return { x: 0, y: 0, width: Math.max(0, finite(doc.width)), height: Math.max(0, finite(doc.height)) };
}

/** Space between `inner` and the edges of `outer` on each side (never negative). */
export function marginsOf(outer: Rect, inner: Rect): Sides {
  return {
    left: Math.max(0, inner.x - outer.x),
    top: Math.max(0, inner.y - outer.y),
    right: Math.max(0, outer.x + outer.width - (inner.x + inner.width)),
    bottom: Math.max(0, outer.y + outer.height - (inner.y + inner.height)),
  };
}

export interface PaddedRect {
  /** The element plus the padding, clamped to the page. */
  rect: Rect;
  /** Sides where the page edge left less padding than asked. */
  clipped: Side[];
  /** Padding actually kept on each side. */
  sides: Sides;
}

/** The element plus `padding` on every side, clamped to the page. Null when nothing of it is on the page. */
export function paddedRect(element: Rect, padding: number, doc: Size): PaddedRect | null {
  const el = normalizeRect(element);
  const pad = Math.max(0, finite(padding));
  const rect = intersectRect(growRect(el, pad), pageRect(doc));
  if (!rect) return null;
  const sides = marginsOf(rect, el);
  const clipped = SIDES.filter((s) => sides[s] < pad - 0.5);
  return { rect, clipped, sides };
}

/**
 * Most padding a capture of `area` around `element` can show by re-cropping: the smallest captured margin, leaving
 * out sides where the area already reaches the page edge (no capture can show more there). Infinity when every side
 * reaches the page edge.
 */
export function recropLimit(area: Rect, element: Rect, doc: Size): number {
  const m = marginsOf(area, element);
  const page = pageRect(doc);
  const atEdge: Record<Side, boolean> = {
    left: area.x <= page.x + 0.5,
    top: area.y <= page.y + 0.5,
    right: area.x + area.width >= page.x + page.width - 0.5,
    bottom: area.y + area.height >= page.y + page.height - 0.5,
  };
  let limit = Number.POSITIVE_INFINITY;
  for (const side of SIDES) if (!atEdge[side]) limit = Math.min(limit, m[side]);
  return limit;
}

export interface CaptureArea {
  /** What to capture (page CSS px). */
  area: Rect;
  /** The area was cut to fit the size limits (the bottom / right part of a huge element is left out). */
  capped: boolean;
}

/**
 * The area to capture for `element` with `padding` plus `spare` margin, clamped to the page and capped: at most
 * `maxHeight` CSS px tall (default 20 000, as a full-page capture) and within the canvas limits at `scale`. Null when
 * nothing of it is on the page.
 */
export function captureAreaFor(element: Rect, padding: number, spare: number, doc: Size, scale = 1, maxHeight = DEFAULT_MAX_PAGE_HEIGHT): CaptureArea | null {
  const grown = paddedRect(element, Math.max(0, finite(padding)) + Math.max(0, finite(spare)), doc);
  if (!grown) return null;
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const area = { ...grown.rect };
  const maxW = Math.floor(MAX_CANVAS_SIDE / s);
  const maxH = Math.floor(Math.min(maxHeight, MAX_CANVAS_SIDE / s, MAX_CANVAS_AREA / (Math.min(area.width, maxW) * s * s)));
  let capped = false;
  if (area.width > maxW) {
    area.width = maxW;
    capped = true;
  }
  if (area.height > maxH) {
    area.height = Math.max(1, maxH);
    capped = true;
  }
  return { area, capped };
}

export interface AreaCrop {
  /** The element plus the padding, within the captured area (page CSS px). */
  rect: Rect;
  /** The same in px of the area's image. */
  image: Rect;
  /** Padding kept on each side (CSS px). */
  sides: Sides;
  /** Sides where the page edge left less padding than asked. */
  clipped: Side[];
  /** The captured area holds less padding than asked on some side the page does not limit: a new capture shows more. */
  short: boolean;
}

/** An area image: what was captured (page CSS px) and its picture (`width` × `height` px at `scale` px per CSS px). */
export interface AreaImage {
  area: Rect;
  scale: number;
  width: number;
  height: number;
}

/**
 * The crop of an area image that shows `element` with `padding` (clamped to the page and to what was captured), in
 * page CSS px and in image px (whole pixels, outward). Null when the element is not in the area.
 */
export function cropArea(source: AreaImage, element: Rect, padding: number, doc: Size): AreaCrop | null {
  const want = paddedRect(element, padding, doc);
  if (!want) return null;
  const rect = intersectRect(want.rect, source.area);
  if (!rect) return null;
  const s = source.scale > 0 && Number.isFinite(source.scale) ? source.scale : 1;
  const eps = 1e-6;
  const left = clamp(Math.floor((rect.x - source.area.x) * s + eps), 0, source.width);
  const top = clamp(Math.floor((rect.y - source.area.y) * s + eps), 0, source.height);
  const right = clamp(Math.ceil((rect.x + rect.width - source.area.x) * s - eps), 0, source.width);
  const bottom = clamp(Math.ceil((rect.y + rect.height - source.area.y) * s - eps), 0, source.height);
  if (right <= left || bottom <= top) return null;
  const sides = marginsOf(rect, normalizeRect(element));
  const short = SIDES.some((side) => sides[side] < want.sides[side] - 0.5);
  return { rect, image: { x: left, y: top, width: right - left, height: bottom - top }, sides, clipped: want.clipped, short };
}

/** One capture of a stitched area: the part of the area it fills and the window scroll position to take it from. */
export interface AreaTile {
  cell: Rect;
  scrollX: number;
  scrollY: number;
}

/** Scroll position (one axis) that shows [start, start + length): the current one when it already does, else centered. */
function axisScroll(start: number, length: number, view: number, max: number, current: number): number {
  if (length <= view && start >= current - 0.5 && start + length <= current + view + 0.5) return clamp(Math.round(current), 0, max);
  return clamp(Math.round(start + length / 2 - view / 2), 0, max);
}

/** Cell boundaries splitting [start, start + length) into pieces of at most `step`. */
function cells(start: number, length: number, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const end = start + length;
  const s = Math.max(1, Math.floor(step));
  for (let a = start; a < end - 0.5; a += s) out.push([a, Math.min(s, end - a)]);
  return out.length ? out : [[start, Math.max(0, length)]];
}

/**
 * Window scroll positions that capture `area` through a viewport of `view` (client size, CSS px) on a page of `doc`:
 * one tile when the area fits (no scrolling when it is in view at `current` already, else centered), else a grid of
 * viewport-sized cells, row by row, each scrolled into view.
 */
export function planAreaTiles(area: Rect, view: Size, doc: Size, current: { x: number; y: number }): AreaTile[] {
  const vw = Math.max(1, Math.floor(finite(view.width, 1)));
  const vh = Math.max(1, Math.floor(finite(view.height, 1)));
  const maxX = Math.max(0, Math.ceil(finite(doc.width) - vw));
  const maxY = Math.max(0, Math.ceil(finite(doc.height) - vh));
  const tiles: AreaTile[] = [];
  for (const [y, h] of cells(area.y, area.height, vh)) {
    for (const [x, w] of cells(area.x, area.width, vw)) {
      tiles.push({
        cell: { x, y, width: w, height: h },
        scrollX: axisScroll(x, w, vw, maxX, finite(current.x)),
        scrollY: axisScroll(y, h, vh, maxY, finite(current.y)),
      });
    }
  }
  return tiles;
}

/** The part of a tile's cell the viewport shows at `scroll`: where it is in the viewport and where it goes in the area. */
export interface TileCopy {
  /** Viewport CSS px. */
  src: Rect;
  /** Area CSS px (relative to the area's top-left corner). */
  dest: Rect;
}

/** What of `cell` the viewport (`view`, scrolled to `scroll`) shows. Null when none of it is in view. */
export function tileCopy(cell: Rect, area: Rect, scroll: { x: number; y: number }, view: Size): TileCopy | null {
  const visible = intersectRect(cell, { x: finite(scroll.x), y: finite(scroll.y), width: Math.max(0, finite(view.width)), height: Math.max(0, finite(view.height)) });
  if (!visible) return null;
  return {
    src: { x: visible.x - scroll.x, y: visible.y - scroll.y, width: visible.width, height: visible.height },
    dest: { x: visible.x - area.x, y: visible.y - area.y, width: visible.width, height: visible.height },
  };
}

/** drawImage arguments (image px) for a TileCopy at `scale`: adjacent copies land on contiguous pixels. */
export interface TilePixels {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Whole-pixel source and destination rects of a copy (rounded ends, so neighbours neither overlap nor leave gaps). */
export function tilePixels(copy: TileCopy, scale: number, image?: Size): TilePixels | null {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const span = (a: number, len: number) => {
    const start = Math.round(a * s);
    return [start, Math.round((a + len) * s) - start] as const;
  };
  let [sx, sw] = span(copy.src.x, copy.src.width);
  let [sy, sh] = span(copy.src.y, copy.src.height);
  const [dx, dw] = span(copy.dest.x, copy.dest.width);
  const [dy, dh] = span(copy.dest.y, copy.dest.height);
  if (image) {
    sx = clamp(sx, 0, image.width);
    sy = clamp(sy, 0, image.height);
    sw = Math.min(sw, image.width - sx);
    sh = Math.min(sh, image.height - sy);
  }
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return null;
  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

/**
 * Size of the scrollable page from viewport metrics. The page side reports the scroll size floored at the window
 * size (scrollbars included); a page no larger than the window is as large as its visible content.
 */
export function pageSizeOf(v: { innerWidth: number; innerHeight: number; clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number }): Size {
  return {
    width: v.scrollWidth <= v.innerWidth ? v.clientWidth : v.scrollWidth,
    height: v.scrollHeight <= v.innerHeight ? v.clientHeight : v.scrollHeight,
  };
}

/** Size of a preview of `width` × `height` with at most `max` px on its long side (never enlarged). */
export function previewSize(width: number, height: number, max = SHOT_PREVIEW_MAX): { width: number; height: number; scale: number } {
  const w = Math.max(1, Math.round(finite(width, 1)));
  const h = Math.max(1, Math.round(finite(height, 1)));
  const scale = Math.min(1, max / Math.max(w, h));
  if (scale >= 1) return { width: w, height: h, scale: 1 };
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/** "padding clipped at the page edge (left, top)", or null. */
export function clippedNote(sides: readonly Side[]): string | null {
  return sides.length ? `padding clipped at the page edge (${sides.join(', ')})` : null;
}
