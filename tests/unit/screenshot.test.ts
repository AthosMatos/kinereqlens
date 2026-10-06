import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PAGE_HEIGHT,
  MAX_CANVAS_SIDE,
  arrowHead,
  captureScale,
  dataUrlToBytes,
  elementLabel,
  fitZoom,
  imageSpan,
  intersectRect,
  normalizeElementRect,
  normalizeRect,
  outputSize,
  pixelateBlock,
  planStitch,
  rectFromPoints,
  screenshotFilename,
  stepZoom,
  tileSlice,
  toImageRect,
} from '../../src/lib/screenshot';

describe('captureScale', () => {
  it('is image width / viewport width', () => {
    expect(captureScale(2880, 1440, 2)).toBe(2);
    expect(captureScale(1440, 1440, 1)).toBe(1);
    // Browser zoom 125% at DPR 1: the image is wider than the CSS viewport.
    expect(captureScale(1800, 1440, 1.25)).toBe(1.25);
    expect(captureScale(2000, 1000, 1)).toBe(2);
  });

  it('snaps to the devicePixelRatio within 1% (rounded fractional zoom)', () => {
    expect(captureScale(1799, 1440, 1.25)).toBe(1.25);
    expect(captureScale(1801, 1440, 1.25)).toBe(1.25);
  });

  it('falls back to the dpr (or 1) for unusable inputs', () => {
    expect(captureScale(0, 1440, 2)).toBe(2);
    expect(captureScale(2880, 0, 2)).toBe(2);
    expect(captureScale(Number.NaN, 1440, Number.NaN)).toBe(1);
    expect(captureScale(100, Infinity, 0)).toBe(1);
  });
});

describe('rects', () => {
  it('rectFromPoints handles every drag direction', () => {
    expect(rectFromPoints(10, 20, 110, 70)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(rectFromPoints(110, 70, 10, 20)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(rectFromPoints(110, 20, 10, 70)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(rectFromPoints(Number.NaN, 0, 5, 5)).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });

  it('normalizeRect flips negative sizes', () => {
    expect(normalizeRect({ x: 50, y: 50, width: -20, height: -10 })).toEqual({ x: 30, y: 40, width: 20, height: 10 });
  });

  it('intersectRect returns the overlap or null', () => {
    expect(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 60, width: 100, height: 100 })).toEqual({ x: 50, y: 60, width: 50, height: 40 });
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBeNull();
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 })).toBeNull();
  });

  it('normalizeElementRect clips to the viewport', () => {
    const vp = { width: 1000, height: 800 };
    expect(normalizeElementRect({ left: 10, top: 20, width: 300, height: 200 }, vp)).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    // Taller than the viewport and scrolled partly above it.
    expect(normalizeElementRect({ left: -50, top: -100, width: 2000, height: 3000 }, vp)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(normalizeElementRect({ left: 0, top: 900, width: 100, height: 100 }, vp)).toBeNull();
    expect(normalizeElementRect({ left: 10, top: 10, width: 0, height: 50 }, vp)).toBeNull();
    expect(normalizeElementRect({ left: 10, top: 10, width: 50, height: 50 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe('toImageRect (DPR scaling)', () => {
  const image = { width: 2880, height: 1800 };

  it('scales CSS px to image px', () => {
    expect(toImageRect({ x: 10, y: 20, width: 300, height: 200 }, 2, image)).toEqual({ x: 20, y: 40, width: 600, height: 400 });
    expect(toImageRect({ x: 0, y: 0, width: 1440, height: 900 }, 2, image)).toEqual({ x: 0, y: 0, width: 2880, height: 1800 });
  });

  it('expands fractional edges outward to whole pixels', () => {
    expect(toImageRect({ x: 10.25, y: 0.5, width: 100.5, height: 10.2 }, 1.5, image)).toEqual({ x: 15, y: 0, width: 152, height: 17 });
    // Floating point noise never adds a pixel.
    expect(toImageRect({ x: 0.1 + 0.2, y: 0, width: 0.3, height: 1 }, 10, image)).toEqual({ x: 3, y: 0, width: 3, height: 10 });
  });

  it('clamps to the image and rejects empty crops', () => {
    expect(toImageRect({ x: 1400, y: 880, width: 100, height: 100 }, 2, image)).toEqual({ x: 2800, y: 1760, width: 80, height: 40 });
    expect(toImageRect({ x: 2000, y: 0, width: 10, height: 10 }, 2, image)).toBeNull();
    expect(toImageRect({ x: 5, y: 5, width: 0, height: 10 }, 2, image)).toBeNull();
  });

  it('treats an invalid scale as 1', () => {
    expect(toImageRect({ x: 1, y: 2, width: 3, height: 4 }, 0, image)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('outputSize', () => {
  it('keeps device pixels or reduces to CSS pixels', () => {
    expect(outputSize({ width: 600, height: 400 }, 2, 'device')).toEqual({ width: 600, height: 400 });
    expect(outputSize({ width: 600, height: 400 }, 2, 'css')).toEqual({ width: 300, height: 200 });
    expect(outputSize({ width: 151, height: 3 }, 1.5, 'css')).toEqual({ width: 101, height: 2 });
    expect(outputSize({ width: 1, height: 1 }, 3, 'css')).toEqual({ width: 1, height: 1 });
  });
});

describe('imageSpan', () => {
  it('maps adjacent CSS spans to contiguous image rows', () => {
    const scale = 1.25;
    const a = imageSpan(0, 333, scale);
    const b = imageSpan(333, 333, scale);
    expect(a.start + a.length).toBe(b.start);
    expect(imageSpan(100, 50, 2)).toEqual({ start: 200, length: 100 });
  });
});

describe('planStitch / tileSlice', () => {
  const base = { viewportHeight: 900, viewportWidth: 1440, scale: 1 };

  it('one tile for a page that fits', () => {
    expect(planStitch({ ...base, contentHeight: 900 })).toEqual({ height: 900, capped: false, steps: [0] });
    // A document shorter than the viewport still captures one viewport.
    expect(planStitch({ ...base, contentHeight: 300 })).toEqual({ height: 900, capped: false, steps: [0] });
  });

  it('viewport steps, the last aligned to the bottom', () => {
    expect(planStitch({ ...base, contentHeight: 2500 })).toEqual({ height: 2500, capped: false, steps: [0, 900, 1600] });
    expect(planStitch({ ...base, contentHeight: 2700 })).toEqual({ height: 2700, capped: false, steps: [0, 900, 1800] });
    expect(planStitch({ ...base, contentHeight: 901 }).steps).toEqual([0, 1]);
  });

  it('caps the height (default 20 000 CSS px, canvas side limit at the scale)', () => {
    const tall = planStitch({ ...base, contentHeight: 100_000 });
    expect(tall.height).toBe(DEFAULT_MAX_PAGE_HEIGHT);
    expect(tall.capped).toBe(true);
    expect(tall.steps[tall.steps.length - 1]).toBe(DEFAULT_MAX_PAGE_HEIGHT - 900);
    const retina = planStitch({ ...base, scale: 2, contentHeight: 100_000 });
    expect(retina.height * 2).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(planStitch({ ...base, contentHeight: 5000, maxHeight: 3000 })).toMatchObject({ height: 3000, capped: true });
  });

  it('caps by canvas area for very wide pages', () => {
    const wide = planStitch({ ...base, viewportWidth: 10_000, scale: 2, contentHeight: 100_000 });
    expect(wide.height * 2 * 10_000 * 2).toBeLessThanOrEqual(200_000_000);
  });

  it('steps are unique and ascending, tiles cover the height once', () => {
    for (const contentHeight of [900, 1000, 1799, 1800, 1801, 4321, 20_000]) {
      const plan = planStitch({ ...base, contentHeight });
      expect([...plan.steps].sort((a, b) => a - b)).toEqual(plan.steps);
      expect(new Set(plan.steps).size).toBe(plan.steps.length);
      let filled = 0;
      for (const y of plan.steps) {
        const slice = tileSlice(y, filled, 900, plan.height);
        if (slice) {
          expect(slice.destY).toBe(filled);
          expect(slice.srcY).toBe(filled - y);
          filled = slice.destY + slice.height;
        }
      }
      expect(filled).toBe(plan.height);
    }
  });

  it('tileSlice copies only new rows and handles pages that scrolled less than planned', () => {
    expect(tileSlice(0, 0, 900, 2500)).toEqual({ srcY: 0, destY: 0, height: 900 });
    expect(tileSlice(1600, 1800, 900, 2500)).toEqual({ srcY: 200, destY: 1800, height: 700 });
    // Asked for 1800, the page stopped at 1500: rows 1800..2400 come from the tile's offset 300.
    expect(tileSlice(1500, 1800, 900, 2500)).toEqual({ srcY: 300, destY: 1800, height: 600 });
    // Nothing new.
    expect(tileSlice(0, 900, 900, 2500)).toBeNull();
    expect(tileSlice(-5, 0, 900, 900)).toEqual({ srcY: 0, destY: 0, height: 900 });
  });
});

describe('labels and file names', () => {
  it('elementLabel shows tag, id, two classes and size', () => {
    expect(elementLabel({ tag: 'DIV', id: 'card', classes: ['a', 'b', 'c'] }, { width: 300.4, height: 199.6 })).toBe('div#card.a.b  300 × 200');
    expect(elementLabel({ tag: 'span' }, { width: 1, height: 2 })).toBe('span  1 × 2');
    const long = elementLabel({ tag: 'div', id: 'x'.repeat(80) }, { width: 1, height: 1 });
    expect(long.split('  ')[0]!.length).toBe(48);
    expect(long).toContain('…');
  });

  it('screenshotFilename: kinereqlens-<host>-<timestamp>.png', () => {
    const date = new Date(2026, 9, 2, 8, 5, 9);
    expect(screenshotFilename('https://app.example.com:8443/path?q=1', date)).toBe('kinereqlens-app.example.com-20261002-080509.png');
    expect(screenshotFilename('http://127.0.0.1:3000/', date)).toBe('kinereqlens-127.0.0.1-20261002-080509.png');
    expect(screenshotFilename('not a url', date)).toBe('kinereqlens-page-20261002-080509.png');
    expect(screenshotFilename('https://xn--bcher-kva.example/', date)).toBe('kinereqlens-xn--bcher-kva.example-20261002-080509.png');
    expect(screenshotFilename('file:///C:/x.html', date)).toBe('kinereqlens-page-20261002-080509.png');
  });
});

describe('zoom', () => {
  it('fitZoom never enlarges', () => {
    expect(fitZoom({ width: 1440, height: 900 }, { width: 720, height: 900 })).toBe(0.5);
    expect(fitZoom({ width: 100, height: 100 }, { width: 720, height: 900 })).toBe(1);
    expect(fitZoom({ width: 1440, height: 20_000 }, { width: 600, height: 400 })).toBe(0.02);
    expect(fitZoom({ width: 0, height: 0 }, { width: 10, height: 10 })).toBe(1);
  });

  it('stepZoom moves between the steps', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.6, 1)).toBe(0.67);
    expect(stepZoom(0.6, -1)).toBe(0.5);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.1, -1)).toBe(0.1);
    expect(stepZoom(0.02, 1)).toBe(0.1);
  });
});

describe('annotation geometry', () => {
  it('pixelateBlock is at least 10 CSS px', () => {
    expect(pixelateBlock({ width: 400, height: 200 }, 1)).toBe(24);
    expect(pixelateBlock({ width: 400, height: 200 }, 2)).toBe(48);
    expect(pixelateBlock({ width: 20, height: 20 }, 1)).toBe(10);
    expect(pixelateBlock({ width: 20, height: 20 }, 2)).toBe(20);
  });

  it('arrowHead corners sit behind the tip, symmetric', () => {
    const [[lx, ly], [rx, ry]] = arrowHead(0, 0, 100, 0, 10);
    expect(lx).toBeLessThan(100);
    expect(rx).toBeLessThan(100);
    expect(ly).toBeCloseTo(-ry);
    expect(Math.hypot(100 - lx, ly)).toBeCloseTo(10);
  });
});

describe('dataUrlToBytes', () => {
  it('decodes base64 data URLs', () => {
    const out = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
    expect(out?.mime).toBe('image/png');
    expect(Array.from(out!.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(dataUrlToBytes('data:text/plain,hello')).toBeNull();
    expect(dataUrlToBytes('https://example.com/x.png')).toBeNull();
  });
});
