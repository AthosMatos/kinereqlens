// Padded element / region captures, pure parts (src/lib/elementShot.ts): padding clamped to the page, the spare
// margin and the re-crop limit, crops in image px (DPR), tiles of areas larger than the viewport, the preview size;
// annotation shifts on re-crop; the shotPadding setting and the protocol sanitizers of the element calls.
import { describe, expect, it } from 'vitest';
import {
  captureAreaFor,
  clippedNote,
  cropArea,
  growRect,
  marginsOf,
  paddedRect,
  pageSizeOf,
  planAreaTiles,
  previewSize,
  recropLimit,
  sanitizePadding,
  tileCopy,
  tilePixels,
} from '../../src/lib/elementShot';
import { MAX_CANVAS_SIDE } from '../../src/lib/screenshot';
import { shiftAnnotations } from '../../src/ui/screenshot/annotate';
import type { Annotation } from '../../src/ui/screenshot/annotate';
import { sanitizeSettings } from '../../src/content/settings';
import { DEFAULT_SHOT_PADDING, SHOT_PADDING_MAX, SHOT_PREVIEW_MAX, SHOT_SPARE_MARGIN } from '../../src/shared/screenshot-protocol';
import {
  ELEMENT_HIGHLIGHT_MAX_MS,
  ELEMENT_HIGHLIGHT_MS,
  ELEMENT_MATCHES_MAX,
  sanitizeElementHighlightRequest,
  sanitizeElementQuery,
  sanitizeElementRef,
  sanitizeFindValuesRequest,
} from '../../src/shared/find-protocol';

const DOC = { width: 1425, height: 3000 };
const EL = { x: 100, y: 400, width: 300, height: 200 };

describe('padding geometry', () => {
  it('sanitizePadding rounds and clamps, falls back for junk', () => {
    expect(sanitizePadding(50, 7)).toBe(50);
    expect(sanitizePadding(12.6, 7)).toBe(13);
    expect(sanitizePadding(-5, 7)).toBe(0);
    expect(sanitizePadding(5000, 7)).toBe(SHOT_PADDING_MAX);
    expect(sanitizePadding(Number.NaN, 7)).toBe(7);
    expect(sanitizePadding('50', 7)).toBe(7);
    expect(sanitizePadding(undefined, 7)).toBe(7);
  });

  it('growRect / marginsOf', () => {
    expect(growRect(EL, 50)).toEqual({ x: 50, y: 350, width: 400, height: 300 });
    expect(growRect(EL, -10)).toEqual(EL);
    expect(marginsOf({ x: 50, y: 350, width: 400, height: 300 }, EL)).toEqual({ left: 50, top: 50, right: 50, bottom: 50 });
  });

  it('paddedRect keeps the padding inside the page and says which sides were clipped', () => {
    expect(paddedRect(EL, 50, DOC)).toEqual({ rect: { x: 50, y: 350, width: 400, height: 300 }, clipped: [], sides: { left: 50, top: 50, right: 50, bottom: 50 } });
    // 30 px from the left edge, 20 px from the top.
    const near = paddedRect({ x: 30, y: 20, width: 100, height: 50 }, 50, DOC)!;
    expect(near.rect).toEqual({ x: 0, y: 0, width: 180, height: 120 });
    expect(near.clipped).toEqual(['left', 'top']);
    expect(near.sides).toEqual({ left: 30, top: 20, right: 50, bottom: 50 });
    // At the bottom-right corner.
    const corner = paddedRect({ x: 1400, y: 2990, width: 25, height: 10 }, 50, DOC)!;
    expect(corner.rect).toEqual({ x: 1350, y: 2940, width: 75, height: 60 });
    expect(corner.clipped).toEqual(['right', 'bottom']);
    expect(paddedRect({ x: 5000, y: 5000, width: 10, height: 10 }, 0, DOC)).toBeNull();
    expect(clippedNote(near.clipped)).toBe('padding clipped at the page edge (left, top)');
    expect(clippedNote([])).toBeNull();
  });

  it('captureAreaFor adds the spare margin, clamped to the page, and caps huge areas', () => {
    const plan = captureAreaFor(EL, 50, SHOT_SPARE_MARGIN, DOC)!;
    expect(plan).toEqual({ area: { x: 0, y: 150, width: 650, height: 700 }, capped: false });
    // A 30 000 px tall element at DPR 2: the canvas side limit (32 000 image px) caps it.
    const tall = captureAreaFor({ x: 0, y: 0, width: 800, height: 30_000 }, 50, 200, { width: 800, height: 40_000 }, 2)!;
    expect(tall.capped).toBe(true);
    expect(tall.area.height).toBe(Math.floor(MAX_CANVAS_SIDE / 2));
    expect(tall.area.y).toBe(0);
    // The default height cap (20 000 CSS px) at DPR 1.
    const long = captureAreaFor({ x: 0, y: 100, width: 800, height: 25_000 }, 0, 0, { width: 800, height: 30_000 }, 1)!;
    expect(long).toEqual({ area: { x: 0, y: 100, width: 800, height: 20_000 }, capped: true });
  });

  it('recropLimit: the smallest captured margin, page edges do not count', () => {
    const area = captureAreaFor(EL, 50, SHOT_SPARE_MARGIN, DOC)!.area;
    // Left side reaches the page edge (x = 0); top 250, right 250, bottom 250.
    expect(recropLimit(area, EL, DOC)).toBe(250);
    // Every side at the page edge: no limit.
    expect(recropLimit({ x: 0, y: 0, width: DOC.width, height: DOC.height }, EL, DOC)).toBe(Number.POSITIVE_INFINITY);
    // Only 120 px captured below.
    expect(recropLimit({ x: 0, y: 150, width: 650, height: 570 }, EL, DOC)).toBe(120);
  });
});

describe('cropArea', () => {
  const area = { x: 0, y: 150, width: 650, height: 700 };
  const at = (scale: number) => ({ area, scale, width: Math.round(650 * scale), height: Math.round(700 * scale) });

  it('crops element + padding in image px at the capture scale (DPR)', () => {
    const c = cropArea(at(2), EL, 50, DOC)!;
    expect(c.rect).toEqual({ x: 50, y: 350, width: 400, height: 300 });
    expect(c.image).toEqual({ x: 100, y: 400, width: 800, height: 600 });
    expect(c.short).toBe(false);
    expect(c.clipped).toEqual([]);
    expect(cropArea(at(1), EL, 0, DOC)!.image).toEqual({ x: 100, y: 250, width: 300, height: 200 });
  });

  it('grows within the captured margin; beyond it the crop stops at the area (short)', () => {
    expect(cropArea(at(1), EL, 250, DOC)!.short).toBe(false);
    const beyond = cropArea(at(1), EL, 300, DOC)!;
    expect(beyond.short).toBe(true);
    expect(beyond.rect).toEqual(area);
    expect(beyond.sides).toEqual({ left: 100, top: 250, right: 250, bottom: 250 });
    // The left side is the page edge: clipped there, but not "short" (no capture could show more).
    expect(beyond.clipped).toEqual(['left']);
  });

  it('expands fractional edges outward and clamps to the picture', () => {
    const c = cropArea({ area: { x: 0, y: 0, width: 100, height: 100 }, scale: 1.5, width: 150, height: 150 }, { x: 10.3, y: 10.3, width: 20.2, height: 20.2 }, 0, DOC)!;
    expect(c.image).toEqual({ x: 15, y: 15, width: 31, height: 31 });
    expect(cropArea({ area: { x: 0, y: 0, width: 100, height: 100 }, scale: 1, width: 100, height: 100 }, { x: 500, y: 500, width: 10, height: 10 }, 0, DOC)).toBeNull();
  });
});

describe('tiles', () => {
  const view = { width: 1425, height: 900 };

  it('one tile, no scrolling, when the area is in view already', () => {
    expect(planAreaTiles({ x: 0, y: 150, width: 650, height: 700 }, view, DOC, { x: 0, y: 100 })).toEqual([
      { cell: { x: 0, y: 150, width: 650, height: 700 }, scrollX: 0, scrollY: 100 },
    ]);
  });

  it('one tile, centered, when it fits but is out of view (clamped to the page)', () => {
    expect(planAreaTiles({ x: 0, y: 2000, width: 650, height: 500 }, view, DOC, { x: 0, y: 0 })).toEqual([
      { cell: { x: 0, y: 2000, width: 650, height: 500 }, scrollX: 0, scrollY: 1800 },
    ]);
    // Near the bottom: the scroll position cannot pass the page end.
    expect(planAreaTiles({ x: 0, y: 2700, width: 650, height: 300 }, view, DOC, { x: 0, y: 0 })[0]!.scrollY).toBe(2100);
  });

  it('a grid of viewport-sized cells, row by row, for larger areas', () => {
    const tiles = planAreaTiles({ x: 0, y: 100, width: 1425, height: 2000 }, view, DOC, { x: 0, y: 0 });
    expect(tiles.map((t) => t.cell)).toEqual([
      { x: 0, y: 100, width: 1425, height: 900 },
      { x: 0, y: 1000, width: 1425, height: 900 },
      { x: 0, y: 1900, width: 1425, height: 200 },
    ]);
    expect(tiles.map((t) => t.scrollY)).toEqual([100, 1000, 1900 + 100 - 450]);
    const wide = planAreaTiles({ x: 0, y: 0, width: 2000, height: 500 }, view, { width: 2500, height: 3000 }, { x: 0, y: 0 });
    expect(wide.map((t) => [t.cell.x, t.cell.width, t.scrollX])).toEqual([
      [0, 1425, 0],
      [1425, 575, 1425 + 287 - 712],
    ]);
  });

  it('tileCopy: the visible part of a cell, in viewport and area coordinates', () => {
    const area = { x: 0, y: 100, width: 1425, height: 2000 };
    expect(tileCopy({ x: 0, y: 1900, width: 1425, height: 200 }, area, { x: 0, y: 1650 }, view)).toEqual({
      src: { x: 0, y: 250, width: 1425, height: 200 },
      dest: { x: 0, y: 1800, width: 1425, height: 200 },
    });
    // The page did not scroll far enough: only part of the cell is in view.
    expect(tileCopy({ x: 0, y: 1900, width: 1425, height: 200 }, area, { x: 0, y: 1050 }, view)!.dest.height).toBe(50);
    expect(tileCopy({ x: 0, y: 1900, width: 1425, height: 200 }, area, { x: 0, y: 0 }, view)).toBeNull();
  });

  it('tilePixels: adjacent copies land on contiguous pixels at fractional scales', () => {
    const area = { x: 0, y: 0, width: 100, height: 301 };
    const a = tilePixels(tileCopy({ x: 0, y: 0, width: 100, height: 150.5 }, area, { x: 0, y: 0 }, { width: 100, height: 200 })!, 1.25)!;
    const b = tilePixels(tileCopy({ x: 0, y: 150.5, width: 100, height: 150.5 }, area, { x: 0, y: 101 }, { width: 100, height: 200 })!, 1.25)!;
    expect(a.dy + a.dh).toBe(b.dy);
    expect(tilePixels({ src: { x: 0, y: 0, width: 10, height: 10 }, dest: { x: 0, y: 0, width: 10, height: 10 } }, 2, { width: 15, height: 15 })).toMatchObject({ sw: 15, sh: 15 });
    expect(tilePixels({ src: { x: 50, y: 0, width: 10, height: 10 }, dest: { x: 0, y: 0, width: 10, height: 10 } }, 1, { width: 20, height: 20 })).toBeNull();
  });

  it('pageSizeOf: a page no larger than the window is as large as its visible content', () => {
    const base = { innerWidth: 1440, innerHeight: 900, clientWidth: 1425, clientHeight: 900 };
    expect(pageSizeOf({ ...base, scrollWidth: 1440, scrollHeight: 3000 })).toEqual({ width: 1425, height: 3000 });
    expect(pageSizeOf({ ...base, scrollWidth: 2000, scrollHeight: 900 })).toEqual({ width: 2000, height: 900 });
  });
});

describe('preview', () => {
  it('at most SHOT_PREVIEW_MAX px on the long side, never enlarged', () => {
    expect(SHOT_PREVIEW_MAX).toBe(1568);
    expect(previewSize(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(previewSize(1568, 300)).toEqual({ width: 1568, height: 300, scale: 1 });
    const big = previewSize(2880, 40_000);
    expect(big.height).toBe(1568);
    expect(big.width).toBe(Math.round(2880 * (1568 / 40_000)));
    expect(previewSize(3136, 1000)).toEqual({ width: 1568, height: 500, scale: 0.5 });
    expect(previewSize(10, 10, 4)).toEqual({ width: 4, height: 4, scale: 0.4 });
  });
});

describe('annotations follow a re-crop', () => {
  it('shiftAnnotations moves every kind', () => {
    const list: Annotation[] = [
      { kind: 'rect', x: 10, y: 20, w: 30, h: 40, color: 'red', width: 3 },
      { kind: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, color: 'red', width: 3 },
      { kind: 'text', x: 5, y: 6, text: 'hi', color: 'red', size: 20 },
      { kind: 'pixelate', x: 10, y: 10, w: 20, h: 20, block: 10 },
    ];
    expect(shiftAnnotations(list, 50, -5)).toEqual([
      { kind: 'rect', x: 60, y: 15, w: 30, h: 40, color: 'red', width: 3 },
      { kind: 'arrow', x1: 51, y1: -3, x2: 53, y2: -1, color: 'red', width: 3 },
      { kind: 'text', x: 55, y: 1, text: 'hi', color: 'red', size: 20 },
      { kind: 'pixelate', x: 60, y: 5, w: 20, h: 20, block: 10 },
    ]);
    expect(shiftAnnotations(list, 0, 0)).toEqual(list);
  });
});

describe('settings.shotPadding', () => {
  it('defaults to 50, clamped to [0, SHOT_PADDING_MAX], integers', () => {
    expect(DEFAULT_SHOT_PADDING).toBe(50);
    expect(sanitizeSettings(null).shotPadding).toBe(50);
    expect(sanitizeSettings({ shotPadding: 120 }).shotPadding).toBe(120);
    expect(sanitizeSettings({ shotPadding: 12.4 }).shotPadding).toBe(12);
    expect(sanitizeSettings({ shotPadding: -3 }).shotPadding).toBe(0);
    expect(sanitizeSettings({ shotPadding: 99_999 }).shotPadding).toBe(SHOT_PADDING_MAX);
    expect(sanitizeSettings({ shotPadding: 'wide' }).shotPadding).toBe(50);
  });
});

describe('element call sanitizers', () => {
  it('sanitizeElementQuery takes exactly one locator', () => {
    expect(sanitizeElementQuery({ selector: '#a', limit: 5, locales: ['pt_BR', 'bogus!!'] })).toEqual({ selector: '#a', limit: 5, locales: ['pt-BR'] });
    expect(sanitizeElementQuery({ text: 'Save', exact: true })).toEqual({ text: 'Save', exact: true, limit: 20, locales: [] });
    expect(sanitizeElementQuery({ value: { kind: 'number', value: '1258291', key: 'size' }, limit: 9999 })).toEqual({
      value: { kind: 'number', value: '1258291', key: 'size' },
      limit: ELEMENT_MATCHES_MAX,
      locales: [],
    });
    expect(sanitizeElementQuery({ selector: '#a', text: 'b' })).toBeNull();
    expect(sanitizeElementQuery({})).toBeNull();
    expect(sanitizeElementQuery({ text: '   ' })).toBeNull();
    expect(sanitizeElementQuery({ text: 'x'.repeat(1001) })).toBeNull();
    expect(sanitizeElementQuery({ value: { kind: 'bool', value: 'true' } })).toBeNull();
    expect(sanitizeElementQuery(null)).toBeNull();
  });

  it('sanitizeElementHighlightRequest bounds refs, index, label and duration', () => {
    expect(sanitizeElementHighlightRequest({ refs: ['e1', 'e2', 'bad ref', 'e1'], index: 9, label: 'x'.repeat(300), durationMs: 10 })).toEqual({
      refs: ['e1', 'e2'],
      index: 1,
      label: 'x'.repeat(200),
      durationMs: 1000,
    });
    expect(sanitizeElementHighlightRequest({ refs: [] })).toEqual({ refs: [], index: 0, label: '', durationMs: ELEMENT_HIGHLIGHT_MS });
    expect(sanitizeElementHighlightRequest({ refs: ['e1'], durationMs: 1e9 })!.durationMs).toBe(ELEMENT_HIGHLIGHT_MAX_MS);
    expect(sanitizeElementHighlightRequest({ refs: 'e1' })).toBeNull();
    expect(sanitizeElementRef('e0123abcd')).toBe('e0123abcd');
    expect(sanitizeElementRef('<script>')).toBeNull();
  });

  it('sanitizeFindValuesRequest keeps valid candidates', () => {
    expect(
      sanitizeFindValuesRequest({
        candidates: [
          { id: 0, kind: 'string', value: 'abc' },
          { id: 0, kind: 'string', value: 'dup' },
          { id: 1, kind: 'nope', value: 'x' },
          { id: 2, kind: 'number', value: '12345', key: 'size' },
        ],
        locales: ['de-DE'],
      }),
    ).toEqual({
      candidates: [
        { id: 0, kind: 'string', value: 'abc' },
        { id: 2, kind: 'number', value: '12345', key: 'size' },
      ],
      locales: ['de-DE'],
    });
    expect(sanitizeFindValuesRequest({ candidates: 'x' })).toBeNull();
  });
});
