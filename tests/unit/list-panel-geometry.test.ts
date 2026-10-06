// Pure layout math of the overlay shell (panel docking/floating, minimized pill, popups, split panes).
// Lives under the list-* prefix because that is the shell's unit-test namespace.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { LayoutSettings } from '../../src/shared/types';
import {
  AUTO_MARGIN,
  DOCK_MIN_BOTTOM,
  DOCK_MIN_SIDE,
  DOCK_PAGE_RESERVE,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  clampDockSize,
  clampFloatRect,
  clampPoint,
  defaultPillPosition,
  defaultDockSize,
  dockResizeEdge,
  dockSizeForSwitch,
  dockSizeFromPointer,
  dockedRect,
  floatPatch,
  floatRect,
  moveFloatRect,
  panelRect,
  resizeFloatRect,
  undockRect,
} from '../../src/ui/components/panel/geometry';
import { POPUP_GAP, POPUP_MARGIN, placePopup, placePopupBeside } from '../../src/ui/components/position';
import { clampPaneSize } from '../../src/ui/components/SplitPane';
import {
  BODY_CAP_MAX_MB,
  formatCapMb,
  MAX_ENTRIES_MAX,
  MAX_ENTRIES_MIN,
  parseCapMb,
  parseMaxEntries,
} from '../../src/ui/components/panel/SettingsForm';

const vp = { width: 1440, height: 900 };
const layout = (patch: Partial<LayoutSettings> = {}): LayoutSettings => ({ ...DEFAULT_SETTINGS.layout, ...patch });

describe('floating window', () => {
  it('auto position (-1) sits in the bottom-right corner', () => {
    const r = floatRect(layout({ w: 980, h: 640 }), vp);
    expect(r).toEqual({ left: vp.width - 980 - AUTO_MARGIN, top: vp.height - 640 - AUTO_MARGIN, width: 980, height: 640 });
  });

  it('auto size (-1, the default) fits the viewport: the detail pane can show editor and results side by side', () => {
    expect(DEFAULT_SETTINGS.layout.w).toBe(-1);
    expect(floatRect(layout(), vp)).toMatchObject({ left: 1440 - 1200 - AUTO_MARGIN, width: 1200, height: 792 });
    const RAIL_W = 44; // src/ui/rail/Rail.tsx (collapsed navigation rail)
    expect(floatRect(layout(), vp).width - DEFAULT_SETTINGS.layout.listWidth - RAIL_W).toBeGreaterThanOrEqual(800);
    const laptop = floatRect(layout(), { width: 1280, height: 720 });
    expect(laptop).toMatchObject({ width: 1178, height: 634 });
    // Short (634 px): side by side from 720 px of detail width.
    expect(laptop.width - DEFAULT_SETTINGS.layout.listWidth - RAIL_W).toBeGreaterThanOrEqual(720);
    expect(floatRect(layout(), { width: 3000, height: 2000 })).toMatchObject({ width: 1200, height: 820 });
    // Undocking keeps the automatic size.
    expect(undockRect(layout(), vp, { x: 700, y: 20 }, 10)).toMatchObject({ width: 1200, height: 792 });
  });

  it('keeps an explicit position and clamps it into the viewport', () => {
    expect(floatRect(layout({ x: 100, y: 50 }), vp)).toMatchObject({ left: 100, top: 50 });
    const off = floatRect(layout({ x: 5000, y: 5000 }), vp);
    expect(off.left + off.width).toBe(vp.width);
    expect(off.top + off.height).toBe(vp.height);
  });

  it('enforces minimum and maximum sizes', () => {
    expect(floatRect(layout({ w: 10, h: 10, x: 0, y: 0 }), vp)).toMatchObject({ width: FLOAT_MIN_W, height: FLOAT_MIN_H });
    expect(floatRect(layout({ w: 99999, h: 99999, x: 0, y: 0 }), vp)).toMatchObject({ width: vp.width, height: vp.height });
  });

  it('shrinks below the minimum only when the viewport itself is smaller', () => {
    const tiny = { width: 300, height: 200 };
    expect(floatRect(layout({ x: 0, y: 0 }), tiny)).toEqual({ left: 0, top: 0, width: 300, height: 200 });
  });

  it('survives non-finite persisted values', () => {
    const r = floatRect(layout({ w: Number.NaN, h: Number.POSITIVE_INFINITY, x: Number.NaN, y: 10 }), vp);
    expect(Number.isFinite(r.left) && Number.isFinite(r.width) && Number.isFinite(r.height)).toBe(true);
    expect(r.width).toBeGreaterThanOrEqual(FLOAT_MIN_W);
  });

  it('re-clamps when the viewport shrinks', () => {
    const r = clampFloatRect({ left: 900, top: 500, width: 500, height: 400 }, { width: 1000, height: 700 });
    expect(r).toEqual({ left: 500, top: 300, width: 500, height: 400 });
  });

  it('moves by a delta, never leaving the viewport', () => {
    const start = { left: 100, top: 100, width: 600, height: 400 };
    expect(moveFloatRect(start, 50, -20, vp)).toEqual({ left: 150, top: 80, width: 600, height: 400 });
    expect(moveFloatRect(start, -500, -500, vp)).toMatchObject({ left: 0, top: 0 });
    expect(moveFloatRect(start, 5000, 5000, vp)).toMatchObject({ left: vp.width - 600, top: vp.height - 400 });
  });

  it('resizes from edges and corners keeping the opposite edges fixed', () => {
    const start = { left: 200, top: 200, width: 600, height: 400 };
    expect(resizeFloatRect(start, 'se', 40, 30, vp)).toEqual({ left: 200, top: 200, width: 640, height: 430 });
    expect(resizeFloatRect(start, 'nw', -50, -20, vp)).toEqual({ left: 150, top: 180, width: 650, height: 420 });
    expect(resizeFloatRect(start, 'e', 10, 999, vp)).toEqual({ left: 200, top: 200, width: 610, height: 400 });
    expect(resizeFloatRect(start, 'n', 999, 30, vp)).toEqual({ left: 200, top: 230, width: 600, height: 370 });
  });

  it('clamps resizing to the minimum size and the viewport', () => {
    const start = { left: 200, top: 200, width: 600, height: 400 };
    const small = resizeFloatRect(start, 'w', 10_000, 0, vp);
    expect(small.width).toBe(FLOAT_MIN_W);
    expect(small.left + small.width).toBe(800); // right edge fixed
    const big = resizeFloatRect(start, 'se', 10_000, 10_000, vp);
    expect(big).toEqual({ left: 200, top: 200, width: vp.width - 200, height: vp.height - 200 });
    expect(resizeFloatRect(start, 'nw', -10_000, -10_000, vp)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });

  it('undocks under the pointer with the floating size', () => {
    const r = undockRect(layout({ w: 800, h: 500 }), vp, { x: 700, y: 20 }, 12);
    expect(r).toEqual({ left: 300, top: 8, width: 800, height: 500 });
    expect(undockRect(layout({ w: 800, h: 500 }), vp, { x: 5, y: 5 }, 12)).toMatchObject({ left: 0, top: 0 });
  });

  it('converts a rect to persisted layout fields', () => {
    expect(floatPatch({ left: 10.4, top: 20.6, width: 600, height: 400 })).toEqual({ x: 10, y: 21, w: 600, h: 400 });
  });
});

describe('docked panel', () => {
  it('places the panel against its edge', () => {
    expect(dockedRect('right', 500, vp)).toEqual({ left: 940, top: 0, width: 500, height: 900 });
    expect(dockedRect('left', 500, vp)).toEqual({ left: 0, top: 0, width: 500, height: 900 });
    expect(dockedRect('bottom', 300, vp)).toEqual({ left: 0, top: 600, width: 1440, height: 300 });
  });

  it('clamps the docked size and always leaves some page uncovered', () => {
    expect(clampDockSize('right', 10, vp)).toBe(DOCK_MIN_SIDE);
    expect(clampDockSize('right', 99_999, vp)).toBe(vp.width - DOCK_PAGE_RESERVE);
    expect(clampDockSize('bottom', 10, vp)).toBe(DOCK_MIN_BOTTOM);
    expect(clampDockSize('bottom', 99_999, vp)).toBe(vp.height - DOCK_PAGE_RESERVE);
    expect(clampDockSize('left', Number.NaN, vp)).toBe(DOCK_MIN_SIDE);
    // A viewport narrower than the minimum: the panel takes it all rather than overflowing.
    expect(clampDockSize('right', 500, { width: 300, height: 600 })).toBe(300);
  });

  it('keeps a suitable size when switching docks, else picks a default', () => {
    expect(dockSizeForSwitch('left', 640, vp)).toBe(640);
    const bottom = dockSizeForSwitch('bottom', 900, vp); // 900 px tall would cover the page
    expect(bottom).toBeGreaterThanOrEqual(DOCK_MIN_BOTTOM);
    expect(bottom).toBeLessThanOrEqual(560);
    // A 1280x720 laptop: tall enough for the editor and a readable response.
    expect(defaultDockSize('bottom', { width: 1280, height: 720 })).toBe(432);
    expect(dockSizeForSwitch('right', 100, vp)).toBeGreaterThanOrEqual(DOCK_MIN_SIDE);
  });

  it('derives the size from a pointer on the inner edge', () => {
    expect(dockSizeFromPointer('right', vp, 1000, 0)).toBe(440);
    expect(dockSizeFromPointer('left', vp, 600, 0)).toBe(600);
    expect(dockSizeFromPointer('bottom', vp, 0, 500)).toBe(400);
  });

  it('resizes from the side facing the page', () => {
    expect(dockResizeEdge('right')).toBe('w');
    expect(dockResizeEdge('left')).toBe('e');
    expect(dockResizeEdge('bottom')).toBe('n');
  });

  it('panelRect dispatches on the dock mode', () => {
    expect(panelRect(layout({ dock: 'left', dockSize: 400 }), vp)).toEqual(dockedRect('left', 400, vp));
    expect(panelRect(layout({ dock: 'float', x: 10, y: 10 }), vp)).toEqual(floatRect(layout({ x: 10, y: 10 }), vp));
  });
});

describe('minimized pill', () => {
  const pill = { width: 100, height: 30 };
  const panel = { left: 400, top: 200, width: 600, height: 400 };

  it('defaults to the floating panel top-right corner', () => {
    expect(defaultPillPosition('float', panel, pill, vp)).toEqual({ left: 900, top: 200 });
  });

  it('defaults to a corner on the docked side', () => {
    expect(defaultPillPosition('left', panel, pill, vp)).toEqual({ left: 12, top: 12 });
    expect(defaultPillPosition('right', panel, pill, vp)).toEqual({ left: 1440 - 100 - 12, top: 12 });
    expect(defaultPillPosition('bottom', panel, pill, vp)).toEqual({ left: 1440 - 100 - 12, top: 900 - 30 - 12 });
  });

  it('is clamped into the viewport', () => {
    expect(clampPoint({ left: -20, top: 9999 }, pill, vp)).toEqual({ left: 0, top: 870 });
    expect(clampPoint({ left: Number.NaN, top: 5 }, pill, vp)).toEqual({ left: 0, top: 5 });
  });
});

describe('placePopup', () => {
  const view = { width: 1000, height: 800 };
  const popup = { width: 200, height: 150 };

  it('opens below the anchor, start-aligned', () => {
    const p = placePopup({ left: 100, top: 100, right: 130, bottom: 126 }, popup, view);
    expect(p).toMatchObject({ left: 100, top: 126 + POPUP_GAP, side: 'below' });
    expect(p.maxHeight).toBe(800 - 126 - POPUP_GAP - POPUP_MARGIN);
  });

  it('end-aligns to the anchor right edge', () => {
    expect(placePopup({ left: 500, top: 100, right: 530, bottom: 126 }, popup, view, 'end').left).toBe(330);
  });

  it('flips above when there is no room below', () => {
    const p = placePopup({ left: 100, top: 700, right: 130, bottom: 726 }, popup, view);
    expect(p.side).toBe('above');
    expect(p.top).toBe(700 - POPUP_GAP - 150);
  });

  it('uses the roomier side with a reduced max height when neither fits', () => {
    const p = placePopup({ left: 100, top: 300, right: 130, bottom: 326 }, { width: 200, height: 2000 }, view);
    expect(p.side).toBe('below');
    expect(p.maxHeight).toBe(800 - 326 - POPUP_GAP - POPUP_MARGIN);
    const up = placePopup({ left: 100, top: 600, right: 130, bottom: 626 }, { width: 200, height: 2000 }, view);
    expect(up.side).toBe('above');
    expect(up.top).toBe(POPUP_MARGIN);
  });

  it('stays inside the viewport horizontally', () => {
    expect(placePopup({ left: 950, top: 10, right: 980, bottom: 30 }, popup, view).left).toBe(1000 - 200 - POPUP_MARGIN);
    expect(placePopup({ left: 0, top: 10, right: 30, bottom: 30 }, popup, view, 'end').left).toBe(POPUP_MARGIN);
  });
});

describe('placePopupBeside', () => {
  const view = { width: 1000, height: 800 };

  it('opens right of the anchor, top-aligned', () => {
    const p = placePopupBeside({ left: 0, top: 100, right: 44, bottom: 140 }, { width: 300, height: 200 }, view);
    expect(p).toEqual({ left: 44 + POPUP_GAP, top: 100, maxHeight: 800 - 2 * POPUP_MARGIN, side: 'right' });
  });

  it('shifts up to fit, and clamps a too-tall popup into the viewport', () => {
    expect(placePopupBeside({ left: 0, top: 700, right: 44, bottom: 740 }, { width: 300, height: 200 }, view).top).toBe(800 - POPUP_MARGIN - 200);
    expect(placePopupBeside({ left: 0, top: 700, right: 44, bottom: 740 }, { width: 300, height: 2000 }, view).top).toBe(POPUP_MARGIN);
  });

  it('stays inside the viewport horizontally', () => {
    expect(placePopupBeside({ left: 900, top: 10, right: 944, bottom: 50 }, { width: 300, height: 100 }, view).left).toBe(1000 - 300 - POPUP_MARGIN);
  });
});

describe('clampPaneSize', () => {
  it('respects both minimums', () => {
    expect(clampPaneSize(300, 1000, 240, 360)).toBe(300);
    expect(clampPaneSize(100, 1000, 240, 360)).toBe(240);
    expect(clampPaneSize(900, 1000, 240, 360)).toBe(640);
  });

  it('shares space proportionally when both minimums cannot fit', () => {
    expect(clampPaneSize(300, 500, 240, 360)).toBe(200);
  });

  it('handles empty containers and non-finite requests', () => {
    expect(clampPaneSize(300, 0, 240, 360)).toBe(0);
    expect(clampPaneSize(Number.NaN, 1000, 100, 100)).toBe(500);
  });
});

describe('parseMaxEntries', () => {
  it('parses and clamps the typed value', () => {
    expect(parseMaxEntries(' 500 ')).toBe(500);
    expect(parseMaxEntries('1')).toBe(MAX_ENTRIES_MIN);
    expect(parseMaxEntries('1e9')).toBe(MAX_ENTRIES_MAX);
    expect(parseMaxEntries('250.6')).toBe(251);
  });

  it('rejects non-numbers', () => {
    expect(parseMaxEntries('')).toBeNull();
    expect(parseMaxEntries('abc')).toBeNull();
    expect(parseMaxEntries('Infinity')).toBeNull();
  });
});

describe('parseCapMb / formatCapMb', () => {
  it('parses MB to bytes and clamps', () => {
    expect(parseCapMb('2')).toBe(2 * 1024 * 1024);
    expect(parseCapMb(' 0.5 ')).toBe(512 * 1024);
    expect(parseCapMb('0')).toBe(Math.round(0.01 * 1024 * 1024));
    expect(parseCapMb('1e6')).toBe(BODY_CAP_MAX_MB * 1024 * 1024);
    expect(parseCapMb('')).toBeNull();
    expect(parseCapMb('lots')).toBeNull();
  });

  it('formats bytes as MB with at most two decimals', () => {
    expect(formatCapMb(2 * 1024 * 1024)).toBe('2');
    expect(formatCapMb(1024 * 1024 + 1)).toBe('1');
    expect(formatCapMb(1.25 * 1024 * 1024)).toBe('1.25');
  });
});

describe('detail pane direction', () => {
  it('splits side by side when wide, or when short (bottom dock / laptop) and reasonably wide', async () => {
    const { detailDirection } = await import('../../src/ui/detail/RequestDetail');
    expect(detailDirection(813, 760)).toBe('row'); // 1440x900 floating (default size, next to the rail)
    expect(detailDirection(940, 390)).toBe('row'); // 1280x720 docked bottom
    expect(detailDirection(791, 594)).toBe('row'); // 1280x720 floating
    expect(detailDirection(760, 500)).toBe('row'); // short
    expect(detailDirection(640, 860)).toBe('column'); // docked right
    expect(detailDirection(790, 900)).toBe('column');
  });
});
