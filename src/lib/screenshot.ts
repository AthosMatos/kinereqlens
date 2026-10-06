/**
 * Pure geometry helpers of the screenshot tool (src/ui/screenshot/**): crop rectangles, CSS px → image px
 * scaling (devicePixelRatio aware), full-page scroll-and-stitch plans, element-rect normalization, labels and
 * file names. No DOM access: everything here is unit-tested (tests/unit/screenshot.test.ts).
 *
 * Coordinate spaces:
 *  - CSS px of the page viewport (what getBoundingClientRect / pointer events report);
 *  - image px of a `chrome.tabs.captureVisibleTab` PNG (CSS px × scale, scale ≈ devicePixelRatio × zoom).
 */

/** An axis-aligned rectangle (`x`/`y` = top-left corner). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** DOMRect-like input (getBoundingClientRect). */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Chromium's canvas limits: 32767 px per side, ~268 M px in total. Kept well below both. */
export const MAX_CANVAS_SIDE = 32_000;
export const MAX_CANVAS_AREA = 200_000_000;
/** Default full-page height cap (CSS px). */
export const DEFAULT_MAX_PAGE_HEIGHT = 20_000;

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Scale from viewport CSS px to captured image px: image width / viewport width (the capture includes the
 * scrollbars, so `viewportWidth` is `window.innerWidth`). Snaps to `dpr` when within 1% of it (rounding of
 * fractional zoom levels); falls back to `dpr` (or 1) when the inputs are unusable.
 */
export function captureScale(imageWidth: number, viewportWidth: number, dpr = 1): number {
  const fallback = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (!(imageWidth > 0) || !(viewportWidth > 0) || !Number.isFinite(imageWidth) || !Number.isFinite(viewportWidth)) return fallback;
  const ratio = imageWidth / viewportWidth;
  return Math.abs(ratio - fallback) / fallback < 0.01 ? fallback : ratio;
}

/** Rectangle spanned by two points (any drag direction). */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  const ax = finite(x1);
  const ay = finite(y1);
  const bx = finite(x2);
  const by = finite(y2);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

/** A rect with non-negative size (negative width / height flip the origin) and finite numbers. */
export function normalizeRect(r: Rect): Rect {
  return rectFromPoints(r.x, r.y, finite(r.x) + finite(r.width), finite(r.y) + finite(r.height));
}

/** Intersection of two rects, or null when they do not overlap (zero area). */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const na = normalizeRect(a);
  const nb = normalizeRect(b);
  const x = Math.max(na.x, nb.x);
  const y = Math.max(na.y, nb.y);
  const right = Math.min(na.x + na.width, nb.x + nb.width);
  const bottom = Math.min(na.y + na.height, nb.y + nb.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * An element's client rect clipped to the viewport (`viewport` = clientWidth × clientHeight, i.e. without
 * scrollbars), in CSS px. Null for elements that are off-screen, empty or not laid out.
 */
export function normalizeElementRect(rect: RectLike, viewport: Size): Rect | null {
  const r: Rect = { x: finite(rect.left), y: finite(rect.top), width: finite(rect.width), height: finite(rect.height) };
  return intersectRect(r, { x: 0, y: 0, width: Math.max(0, finite(viewport.width)), height: Math.max(0, finite(viewport.height)) });
}

/**
 * CSS px rect → image px rect for an image captured at `scale`, expanded outward to whole pixels (so a
 * fractional element edge is never cut) and clamped to the image. Null when nothing is left.
 */
export function toImageRect(rect: Rect, scale: number, image: Size): Rect | null {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const r = normalizeRect(rect);
  // Tolerance: 1.9999 * 2 must not become a whole extra pixel.
  const eps = 1e-6;
  const left = Math.max(0, Math.floor(r.x * s + eps));
  const top = Math.max(0, Math.floor(r.y * s + eps));
  const right = Math.min(Math.floor(image.width), Math.ceil((r.x + r.width) * s - eps));
  const bottom = Math.min(Math.floor(image.height), Math.ceil((r.y + r.height) * s - eps));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Output scale: native image px ('device') or one pixel per CSS px ('css'). */
export type OutputScale = 'device' | 'css';

/** Size of the saved PNG for an image-px crop captured at `scale`. */
export function outputSize(crop: Size, scale: number, mode: OutputScale): Size {
  if (mode === 'device' || !(scale > 0) || Math.abs(scale - 1) < 1e-6) {
    return { width: Math.max(1, Math.round(crop.width)), height: Math.max(1, Math.round(crop.height)) };
  }
  return { width: Math.max(1, Math.round(crop.width / scale)), height: Math.max(1, Math.round(crop.height / scale)) };
}

/** Rows [start, start + length) in CSS px → whole image rows, contiguous for adjacent spans. */
export function imageSpan(start: number, length: number, scale: number): { start: number; length: number } {
  const a = Math.round(start * scale);
  const b = Math.round((start + length) * scale);
  return { start: a, length: Math.max(0, b - a) };
}

export interface StitchPlanInput {
  /** Scrollable document height (CSS px). */
  contentHeight: number;
  /** Visible height of one tile (CSS px; clientHeight, no horizontal scrollbar). */
  viewportHeight: number;
  /** Tile width (CSS px; clientWidth). */
  viewportWidth: number;
  /** Capture scale (image px per CSS px). */
  scale: number;
  /** Height cap in CSS px (default DEFAULT_MAX_PAGE_HEIGHT). */
  maxHeight?: number;
}

export interface StitchPlan {
  /** Height of the stitched image in CSS px (≤ content height, ≤ the caps). */
  height: number;
  /** True when the page was taller than the caps. */
  capped: boolean;
  /** Scroll positions (CSS px, ascending, unique) to capture one tile each. */
  steps: number[];
}

/**
 * Scroll positions for a full-page capture: one tile per viewport height, the last one aligned to the bottom of
 * the (capped) area, so the tiles cover [0, height) exactly once each with overlap only at the end. The height is
 * capped by `maxHeight` and by the canvas limits at the given scale.
 */
export function planStitch(input: StitchPlanInput): StitchPlan {
  const vh = Math.max(1, Math.floor(finite(input.viewportHeight, 1)));
  const scale = input.scale > 0 && Number.isFinite(input.scale) ? input.scale : 1;
  const content = Math.max(vh, Math.ceil(finite(input.contentHeight, vh)));
  const width = Math.max(1, finite(input.viewportWidth, 1)) * scale;
  const canvasCap = Math.floor(Math.min(MAX_CANVAS_SIDE, MAX_CANVAS_AREA / width) / scale);
  const cap = Math.max(vh, Math.min(Math.floor(input.maxHeight ?? DEFAULT_MAX_PAGE_HEIGHT), canvasCap));
  const height = Math.min(content, cap);
  const steps: number[] = [];
  for (let y = 0; y < height; y += vh) steps.push(Math.min(y, height - vh));
  return { height, capped: content > height, steps: [...new Set(steps.map((s) => Math.max(0, s)))] };
}

/** The part of a tile captured at scroll position `scrollY` that fills rows [filled, total) of the result. */
export interface TileSlice {
  /** First row of the tile to copy (CSS px, relative to the viewport top). */
  srcY: number;
  /** Row of the result it goes to (CSS px). */
  destY: number;
  height: number;
}

/**
 * Which rows of a tile to copy. `scrollY` is where the page actually scrolled to (it may differ from the plan:
 * the page refused, or the document got shorter), `filled` the rows of the result already drawn. Null when the
 * tile adds nothing (it is entirely above `filled`).
 */
export function tileSlice(scrollY: number, filled: number, viewportHeight: number, total: number): TileSlice | null {
  const y = Math.max(0, finite(scrollY));
  const start = Math.max(filled, y);
  const end = Math.min(total, y + viewportHeight);
  if (end <= start) return null;
  return { srcY: start - y, destY: start, height: end - start };
}

/** Text of the element picker's label: `tag#id.class  W × H` (class list shortened). */
export function elementLabel(el: { tag: string; id?: string; classes?: readonly string[] }, size: Size): string {
  let name = el.tag.toLowerCase();
  if (el.id) name += `#${el.id}`;
  const classes = (el.classes ?? []).filter(Boolean).slice(0, 2);
  for (const c of classes) name += `.${c}`;
  if (name.length > 48) name = `${name.slice(0, 47)}…`;
  return `${name}  ${Math.round(size.width)} × ${Math.round(size.height)}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `kinereqlens-<host>-<YYYYMMDD-HHMMSS>.png` (local time; host reduced to safe file-name characters). */
export function screenshotFilename(pageUrl: string, date: Date): string {
  let host = '';
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    host = '';
  }
  host = host.replace(/[^a-z0-9.-]+/gi, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'page';
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `kinereqlens-${host}-${stamp}.png`;
}

/** Zoom that fits `image` (natural CSS size) into `box`, never above 1. */
export function fitZoom(image: Size, box: Size): number {
  if (!(image.width > 0) || !(image.height > 0) || !(box.width > 0) || !(box.height > 0)) return 1;
  return Math.min(1, box.width / image.width, box.height / image.height);
}

/** Zoom steps of the preview (fractions of the natural CSS size). */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** Next zoom step up (`dir` 1) or down (-1) from `zoom`. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i]! < zoom - 1e-6) return ZOOM_STEPS[i]!;
  return ZOOM_STEPS[0];
}

/**
 * Pixelation block (image px) for a redaction rectangle: large enough that text cannot be read back (≥ 10 CSS
 * px at the capture scale), but at most a quarter of the smaller side so the area still reads as a block.
 */
export function pixelateBlock(rect: Size, scale: number): number {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const min = Math.ceil(10 * s);
  const quarter = Math.floor(Math.min(Math.abs(rect.width), Math.abs(rect.height)) / 4);
  return Math.max(min, Math.min(quarter, Math.ceil(24 * s)), 1);
}

/** The two back corners of an arrow head at (x2, y2) pointing away from (x1, y1). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size: number): [[number, number], [number, number]] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)],
    [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)],
  ];
}

/** Decode a `data:image/png;base64,…` URL to bytes (null when it is not a base64 data URL). */
export function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,/.exec(dataUrl);
  if (!m) return null;
  const binary = atob(dataUrl.slice(m[0].length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: m[1] ?? 'application/octet-stream', bytes };
}

/** Padding around a component captured for the Errors view (CSS px). */
export const ERROR_AREA_PADDING = 16;

/** Union of rects (empty ones ignored), or null. */
export function unionRects(rects: ReadonlyArray<Rect | null | undefined>): Rect | null {
  let out: { x1: number; y1: number; x2: number; y2: number } | null = null;
  for (const r of rects) {
    if (!r || !(r.width > 0) || !(r.height > 0) || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    const box = { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
    out = out ? { x1: Math.min(out.x1, box.x1), y1: Math.min(out.y1, box.y1), x2: Math.max(out.x2, box.x2), y2: Math.max(out.y2, box.y2) } : box;
  }
  return out ? { x: out.x1, y: out.y1, width: out.x2 - out.x1, height: out.y2 - out.y1 } : null;
}

/**
 * The page area to capture for a failing request's component: the union of its instances' rects, padded, clamped
 * to the viewport (CSS px). Null when nothing of it is on screen.
 */
export function errorAreaRect(rects: ReadonlyArray<Rect | null | undefined>, viewport: Size, padding = ERROR_AREA_PADDING): Rect | null {
  const union = unionRects(rects);
  if (!union) return null;
  const padded = { x: union.x - padding, y: union.y - padding, width: union.width + padding * 2, height: union.height + padding * 2 };
  const clamped = intersectRect(padded, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!clamped || clamped.width < 2 || clamped.height < 2) return null;
  return { x: Math.round(clamped.x), y: Math.round(clamped.y), width: Math.round(clamped.width), height: Math.round(clamped.height) };
}
