// OWNER: ui-shell agent. Pure panel geometry: docking, clamping to the viewport, drag and resize math.
import type { DockMode, LayoutSettings } from '../../../shared/types';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

/** Floating window minimum size (shrinks further only when the viewport itself is smaller). */
export const FLOAT_MIN_W = 380;
export const FLOAT_MIN_H = 260;
/** Docked minimum width (left/right) and height (bottom). */
export const DOCK_MIN_SIDE = 340;
export const DOCK_MIN_BOTTOM = 180;
/** Page area a docked panel always leaves uncovered so the page stays reachable. */
export const DOCK_PAGE_RESERVE = 48;
/** Distance from the viewport corner for the automatic (x/y = -1) floating position. */
export const AUTO_MARGIN = 16;
/** Below this panel width the list and detail are shown one at a time. */
export const NARROW_PANEL_W = 720;
/**
 * Automatic floating size (layout w/h = -1, the default): large enough for the list plus a detail pane that
 * shows editor and results side by side on common screens, while leaving part of the page visible (the
 * window sits in the bottom-right corner).
 */
export const AUTO_FLOAT_MAX_W = 1200;
export const AUTO_FLOAT_MAX_H = 820;
export const AUTO_FLOAT_VW = 0.92;
export const AUTO_FLOAT_VH = 0.88;

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));
const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

function roundRect(r: Rect): Rect {
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function floatMins(vp: Viewport): { minW: number; minH: number } {
  return { minW: Math.min(FLOAT_MIN_W, vp.width), minH: Math.min(FLOAT_MIN_H, vp.height) };
}

/** Clamp a floating rect: size within [min, viewport], position so the whole window stays visible. */
export function clampFloatRect(r: Rect, vp: Viewport): Rect {
  const { minW, minH } = floatMins(vp);
  const width = clamp(finite(r.width, FLOAT_MIN_W), minW, vp.width);
  const height = clamp(finite(r.height, FLOAT_MIN_H), minH, vp.height);
  const left = clamp(finite(r.left, 0), 0, vp.width - width);
  const top = clamp(finite(r.top, 0), 0, vp.height - height);
  return roundRect({ left, top, width, height });
}

/** Floating size from persisted layout; a negative w/h means "auto" (sized to the viewport). */
function floatSize(layout: LayoutSettings, vp: Viewport): { width: number; height: number } {
  const { minW, minH } = floatMins(vp);
  const w = finite(layout.w, FLOAT_MIN_W);
  const h = finite(layout.h, FLOAT_MIN_H);
  const width = w < 0 ? Math.min(AUTO_FLOAT_MAX_W, Math.round(vp.width * AUTO_FLOAT_VW)) : w;
  const height = h < 0 ? Math.min(AUTO_FLOAT_MAX_H, Math.round(vp.height * AUTO_FLOAT_VH)) : h;
  return { width: clamp(width, minW, vp.width), height: clamp(height, minH, vp.height) };
}

/** Floating rect from persisted layout; negative x/y means "auto" (bottom-right corner), negative w/h auto size. */
export function floatRect(layout: LayoutSettings, vp: Viewport): Rect {
  const { width, height } = floatSize(layout, vp);
  const left = layout.x < 0 ? vp.width - width - AUTO_MARGIN : layout.x;
  const top = layout.y < 0 ? vp.height - height - AUTO_MARGIN : layout.y;
  return clampFloatRect({ left, top, width, height }, vp);
}

/** Clamp a docked size (width for left/right, height for bottom). */
export function clampDockSize(dock: Exclude<DockMode, 'float'>, size: number, vp: Viewport): number {
  const extent = dock === 'bottom' ? vp.height : vp.width;
  const min = Math.min(dock === 'bottom' ? DOCK_MIN_BOTTOM : DOCK_MIN_SIDE, extent);
  const max = Math.max(min, extent - DOCK_PAGE_RESERVE);
  return Math.round(clamp(finite(size, min), min, max));
}

/** A sensible docked size for a dock mode in this viewport (used when switching orientation). */
export function defaultDockSize(dock: Exclude<DockMode, 'float'>, vp: Viewport): number {
  // Bottom: tall enough for the request line, an editor and a readable response (a 324px dock on a 720px
  // laptop screen left 20px for the editor).
  const preferred = dock === 'bottom' ? clamp(vp.height * 0.6, 260, 560) : clamp(vp.width * 0.5, DOCK_MIN_SIDE, 760);
  return clampDockSize(dock, preferred, vp);
}

/**
 * Docked size to use when switching to `dock`: the current size is kept when it suits the new orientation
 * (at least the minimum, at most 70% of the viewport extent), otherwise a sensible default is used.
 */
export function dockSizeForSwitch(dock: Exclude<DockMode, 'float'>, current: number, vp: Viewport): number {
  const extent = dock === 'bottom' ? vp.height : vp.width;
  const min = dock === 'bottom' ? DOCK_MIN_BOTTOM : DOCK_MIN_SIDE;
  if (Number.isFinite(current) && current >= min && current <= extent * 0.7) return clampDockSize(dock, current, vp);
  return defaultDockSize(dock, vp);
}

/** Docked rect for a dock mode and size. */
export function dockedRect(dock: Exclude<DockMode, 'float'>, size: number, vp: Viewport): Rect {
  const s = clampDockSize(dock, size, vp);
  switch (dock) {
    case 'right':
      return { left: vp.width - s, top: 0, width: s, height: vp.height };
    case 'left':
      return { left: 0, top: 0, width: s, height: vp.height };
    case 'bottom':
      return { left: 0, top: vp.height - s, width: vp.width, height: s };
  }
}

/** The panel's rect for the current layout, clamped to the viewport. */
export function panelRect(layout: LayoutSettings, vp: Viewport): Rect {
  return layout.dock === 'float' ? floatRect(layout, vp) : dockedRect(layout.dock, layout.dockSize, vp);
}

/** Move a floating rect by a pointer delta (clamped). */
export function moveFloatRect(start: Rect, dx: number, dy: number, vp: Viewport): Rect {
  return clampFloatRect({ ...start, left: start.left + dx, top: start.top + dy }, vp);
}

/** Resize a floating rect from an edge or corner by a pointer delta; the opposite edges stay fixed. */
export function resizeFloatRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, vp: Viewport): Rect {
  const { minW, minH } = floatMins(vp);
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let { left, top, width, height } = start;
  if (edge.includes('e')) width = clamp(start.width + dx, minW, vp.width - start.left);
  if (edge.includes('w')) {
    left = clamp(start.left + dx, 0, right - minW);
    width = right - left;
  }
  if (edge.includes('s')) height = clamp(start.height + dy, minH, vp.height - start.top);
  if (edge.includes('n')) {
    top = clamp(start.top + dy, 0, bottom - minH);
    height = bottom - top;
  }
  return roundRect({ left, top, width, height });
}

/** Docked size for a pointer position on the panel's inner edge. */
export function dockSizeFromPointer(dock: Exclude<DockMode, 'float'>, vp: Viewport, x: number, y: number): number {
  const raw = dock === 'right' ? vp.width - x : dock === 'left' ? x : vp.height - y;
  return clampDockSize(dock, raw, vp);
}

/** The resize edge of a docked panel (its side facing the page). */
export function dockResizeEdge(dock: Exclude<DockMode, 'float'>): ResizeEdge {
  return dock === 'right' ? 'w' : dock === 'left' ? 'e' : 'n';
}

/**
 * Floating rect when undocking by dragging the header: the window keeps its floating size and is placed
 * under the pointer, horizontally centred on it, with the pointer `grabY` px below the window's top edge.
 */
export function undockRect(layout: LayoutSettings, vp: Viewport, pointer: { x: number; y: number }, grabY: number): Rect {
  const { width, height } = floatSize(layout, vp);
  return clampFloatRect({ left: pointer.x - width / 2, top: pointer.y - grabY, width, height }, vp);
}

/** Persistable layout fields for a floating rect. */
export function floatPatch(r: Rect): Pick<LayoutSettings, 'x' | 'y' | 'w' | 'h'> {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

/** Clamp a point so a box of `size` placed there stays inside the viewport. */
export function clampPoint(p: Point, size: { width: number; height: number }, vp: Viewport): Point {
  return {
    left: Math.round(clamp(finite(p.left, 0), 0, vp.width - size.width)),
    top: Math.round(clamp(finite(p.top, 0), 0, vp.height - size.height)),
  };
}

/** Where the minimized pill appears by default: at the panel's top-right corner, or a dock-side corner. */
export function defaultPillPosition(
  dock: DockMode,
  panel: Rect,
  pill: { width: number; height: number },
  vp: Viewport,
): Point {
  const gap = 12;
  let p: Point;
  switch (dock) {
    case 'float':
      p = { left: panel.left + panel.width - pill.width, top: panel.top };
      break;
    case 'left':
      p = { left: gap, top: gap };
      break;
    case 'bottom':
      p = { left: vp.width - pill.width - gap, top: vp.height - pill.height - gap };
      break;
    default:
      p = { left: vp.width - pill.width - gap, top: gap };
  }
  return clampPoint(p, pill, vp);
}
