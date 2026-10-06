// Padded element / region captures over a fake page (src/ui/screenshot/engine.ts captureArea, cropSource) and the MCP
// handlers runShotCommand / runFindCommand (src/ui/control/shot.ts) over a fake page connection: scrolling and
// stitching, the overlay hidden only for the parts it covers (and always given back), crops and re-crops, element
// locators (index, first visible, requestId + path), highlight, the response values shown in the page, a hidden tab
// and a busy page failing fast. No image work in node: decode / draw / encode are stubbed and recorded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementMatch, ElementQuery, FindCandidateWire } from '../../src/shared/find-protocol';
import type { ShotElementGeometry, ShotViewport } from '../../src/shared/screenshot-protocol';
import { SHOT_BUSY_ERROR, SHOT_SPARE_MARGIN } from '../../src/shared/screenshot-protocol';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { RequestEntry } from '../../src/shared/types';
import type { HitRect } from '../../src/shared/panel-protocol';
import { captureArea, cropSource } from '../../src/ui/screenshot/engine';
import type { ShotBackend } from '../../src/ui/screenshot/engine';
import { runFindCommand, runShotCommand } from '../../src/ui/control/shot';
import type { ControlHost } from '../../src/ui/screenshot/open';
import { clearShots, getShots, setShotPadding } from '../../src/ui/screenshot/store';
import { getPanelView, setPanelView } from '../../src/ui/ws/ViewSwitch';
import { setShellSelection } from '../../src/ui/shellState';
import { collectCandidates } from '../../src/lib/findInPage';
import { parseJsonTree } from '../../src/lib/json-tree';

const DPR = 2;
const VIEWPORT: ShotViewport = {
  innerWidth: 1440,
  innerHeight: 900,
  clientWidth: 1425,
  clientHeight: 900,
  devicePixelRatio: DPR,
  scrollX: 0,
  scrollY: 0,
  scrollWidth: 1440,
  scrollHeight: 3000,
  host: 'shop.test',
};

interface Draw {
  canvas: { width: number; height: number };
  args: number[];
}

let draws: Draw[] = [];
let canvases: Array<{ width: number; height: number }> = [];

/** Decode / draw / encode stubs: a capture is a viewport-sized bitmap; drawImage calls are recorded. */
function stubImages(): void {
  draws = [];
  canvases = [];
  vi.stubGlobal('createImageBitmap', async (_src: unknown, ...rest: unknown[]) => {
    const opts = rest.find((r) => typeof r === 'object' && r !== null) as { resizeWidth?: number; resizeHeight?: number } | undefined;
    return { width: opts?.resizeWidth ?? VIEWPORT.innerWidth * DPR, height: opts?.resizeHeight ?? VIEWPORT.innerHeight * DPR, close() {} };
  });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        canvases.push(this);
      }
      getContext() {
        const canvas = this;
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: (...args: unknown[]) => draws.push({ canvas, args: args.slice(1) as number[] }),
        };
      }
      async convertToBlob() {
        return new Blob([`png ${this.width}x${this.height}`]);
      }
    },
  );
}

interface Call {
  op: string;
  hide?: boolean;
  exclusive?: boolean;
  y?: number;
  x?: number;
  hideFixed?: boolean;
  scrollY?: number;
}

/** A page of DOC size whose window scrolls; `element` answers shotElement. */
function fakeBackend(element: ShotElementGeometry | null | ((v: ShotViewport) => ShotElementGeometry | null), opts: { start?: Partial<ShotViewport>; busy?: boolean } = {}) {
  const calls: Call[] = [];
  let v: ShotViewport = { ...VIEWPORT, ...opts.start };
  const maxY = v.scrollHeight - v.clientHeight;
  const backend: ShotBackend = {
    begin: async (hide, o) => {
      calls.push({ op: 'begin', hide, exclusive: o?.exclusive === true });
      if (opts.busy && o?.exclusive) throw new Error(SHOT_BUSY_ERROR);
      return v;
    },
    scroll: async (y, hideFixed, x) => {
      calls.push({ op: 'scroll', y, x, hideFixed });
      v = { ...v, scrollY: Math.max(0, Math.min(maxY, y)), scrollX: x ?? v.scrollX };
      return v;
    },
    end: async () => {
      calls.push({ op: 'end' });
      return 'ok';
    },
    pick: async () => null,
    captureVisible: async () => {
      calls.push({ op: 'capture', scrollY: v.scrollY });
      return new Blob(['png']);
    },
    element: async () => {
      calls.push({ op: 'element' });
      const g = typeof element === 'function' ? element(v) : element;
      return g ? { ...g, viewport: v } : null;
    },
  };
  return { backend, calls, view: () => v };
}

/** The element at page rect `r`, measured at the current scroll position. */
const at = (r: { x: number; y: number; width: number; height: number }, extra: Partial<ShotElementGeometry> = {}) => (v: ShotViewport): ShotElementGeometry => ({
  rect: { x: r.x - v.scrollX, y: r.y - v.scrollY, width: r.width, height: r.height },
  viewport: v,
  ...extra,
});

const NO_REGIONS = () => [] as HitRect[];
const PANEL: HitRect[] = [{ left: 600, top: 100, width: 700, height: 700 }];

beforeEach(() => {
  stubImages();
  clearShots();
  setPanelView('http');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureArea (padded captures)', () => {
  it('an element in view: one capture, no scrolling, the overlay kept when it does not cover the area', async () => {
    const { backend, calls } = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    const out = await captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: NO_REGIONS, exclusive: true });
    expect(calls.map((c) => c.op)).toEqual(['begin', 'element', 'capture', 'end']);
    expect(calls[0]).toMatchObject({ hide: false, exclusive: true });
    // element + 2 × 50 at DPR 2.
    expect([out.width, out.height]).toEqual([800, 600]);
    expect(out.mode).toBe('element');
    expect(out.pageRect).toEqual({ x: 50, y: 250, width: 400, height: 300 });
    // The kept picture: + the spare margin (clamped at the left page edge).
    expect(out.source.area).toEqual({ x: 0, y: 50, width: 650, height: 700 });
    expect([out.source.width, out.source.height]).toEqual([1300, 1400]);
    expect(out.notes).toEqual([]);
    expect(out.crop.sides).toEqual({ left: 50, top: 50, right: 50, bottom: 50 });
  });

  it('the overlay is hidden only for a part it covers, and the session always ends', async () => {
    const { backend, calls } = fakeBackend(at({ x: 700, y: 300, width: 300, height: 200 }));
    await captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: () => PANEL });
    expect(calls.map((c) => `${c.op}${c.op === 'begin' ? `:${c.hide}` : ''}`)).toEqual(['begin:false', 'element', 'begin:true', 'capture', 'end']);
    // A pick hides it for the whole capture.
    const pick = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    await captureArea(pick.backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: NO_REGIONS, hideOverlay: 'always' });
    expect(pick.calls.filter((c) => c.op === 'begin').map((c) => c.hide)).toEqual([true]);
  });

  it('an element out of view is centered; a page edge clips the padding (noted)', async () => {
    const { backend, calls } = fakeBackend(at({ x: 20, y: 2200, width: 300, height: 200 }));
    const out = await captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: NO_REGIONS });
    const scroll = calls.find((c) => c.op === 'scroll')!;
    expect(scroll).toMatchObject({ hideFixed: false, x: 0 });
    // Area y 1950..2650 (spare included) → centered: 2300 − 450.
    expect(scroll.y).toBe(1850);
    expect(out.pageRect).toEqual({ x: 0, y: 2150, width: 370, height: 300 });
    expect(out.notes).toEqual(['padding clipped at the page edge (left)']);
  });

  it('an area taller than the viewport is stitched from tiles (fixed elements hidden from the first)', async () => {
    const { backend, calls } = fakeBackend(at({ x: 100, y: 500, width: 600, height: 1500 }));
    const out = await captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: NO_REGIONS });
    const scrolls = calls.filter((c) => c.op === 'scroll');
    expect(scrolls.every((c) => c.hideFixed === true)).toBe(true);
    // Area y 250..2250 → cells of 900 px: 250, 1150, 2050 (200 px, centered and clamped).
    expect(scrolls.map((c) => c.y)).toEqual([250, 1150, 1700]);
    expect(calls.filter((c) => c.op === 'capture')).toHaveLength(3);
    expect(out.notes).toContain('stitched from 3 tiles');
    // The stitched picture is the whole area at DPR 2; tiles land on contiguous rows.
    const area = canvases[0]!;
    // x 0..950 (100 − 250 clamped to 0, 700 + 250), y 250..2250.
    expect([area.width, area.height]).toEqual([1900, 4000]);
    const rows = draws.filter((d) => d.canvas === area).map((d) => [d.args[5], d.args[7]]);
    expect(rows).toEqual([
      [0, 1800],
      [1800, 1800],
      [3600, 400],
    ]);
    expect([out.width, out.height]).toEqual([1400, 3200]);
  });

  it('a fixed element is captured as the viewport shows it (no scrolling)', async () => {
    // A fixed header: at the top of the viewport whatever the scroll position.
    const header = (v: ShotViewport): ShotElementGeometry => ({ rect: { x: 0, y: 0, width: 1425, height: 60 }, viewport: v, fixed: true });
    const { backend, calls } = fakeBackend(header, { start: { scrollY: 1200 } });
    const out = await captureArea(backend, { kind: 'element', ref: 'hdr' }, { padding: 50, regions: NO_REGIONS });
    expect(calls.some((c) => c.op === 'scroll')).toBe(false);
    // Element + 250 below it, cut at the viewport's top edge.
    expect(out.source.area).toEqual({ x: 0, y: 1200, width: 1425, height: 310 });
    expect(out.source.fixed).toBe(true);
    expect(out.pageRect).toEqual({ x: 0, y: 1200, width: 1425, height: 110 });
    expect(out.notes).toEqual(['fixed element: only what the viewport shows around it was captured', 'padding clipped at the page edge (left, right)']);
  });

  it('a gone element fails and the session is ended', async () => {
    const { backend, calls } = fakeBackend(null);
    await expect(captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50 })).rejects.toThrow('The element is no longer on the page');
    expect(calls.map((c) => c.op)).toEqual(['begin', 'element', 'end']);
  });

  it('a region target needs no element; css output keeps 1 px per CSS px', async () => {
    const { backend } = fakeBackend(null);
    const out = await captureArea(backend, { kind: 'region', rect: { x: 400, y: 100, width: 200, height: 100 } }, { padding: 10, regions: NO_REGIONS, output: 'css' });
    expect(out.mode).toBe('region');
    expect([out.width, out.height, out.scale]).toEqual([220, 120, 1]);
  });

  it('cropSource re-crops the kept picture with another padding (no capture)', async () => {
    const { backend } = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    const out = await captureArea(backend, { kind: 'element', ref: 'e1' }, { padding: 50, regions: NO_REGIONS });
    const bitmap = { width: out.source.width, height: out.source.height, close() {} } as unknown as ImageBitmap;
    const less = await cropSource(out.source, 10, bitmap);
    expect([less.width, less.height]).toEqual([640, 440]);
    const more = await cropSource(out.source, 250, bitmap);
    expect(more.crop.short).toBe(false);
    expect([more.width, more.height]).toEqual([1300, 1400]);
    const beyond = await cropSource(out.source, 400, bitmap);
    expect(beyond.crop.short).toBe(true);
    expect([beyond.width, beyond.height]).toEqual([1300, 1400]);
  });
});

// ------------------------------------------------------------------------------------------------ handlers

const FILES = [{ name: 'quarterly-report-2024.pdf', size: 1258291, owner: { email: 'ana@example.test' } }];

function entry(id: string, body: unknown): RequestEntry {
  const text = JSON.stringify(body);
  return {
    id,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://shop.test/',
    method: 'GET',
    url: 'https://shop.test/api/files',
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1,
    state: 'done',
    status: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    responseBody: { kind: 'text', text, size: text.length },
  };
}

function match(ref: string, visible = true, rect = { x: 100, y: 300, width: 300, height: 200 }): ElementMatch {
  return { ref, tag: 'span', text: 'quarterly-report-2024.pdf', selector: `#${ref}`, rect, visible };
}

/** A page connection whose page side answers from fixtures. */
function fakeHost(opts: { matches?: ElementMatch[]; total?: number; shown?: string[] } = {}) {
  const finds: Array<{ method: string; arg: unknown }> = [];
  const matches = opts.matches ?? [match('e1')];
  const host = {
    getSettings: () => ({ ...DEFAULT_SETTINGS, shotPadding: 30 }),
    getCaptureInfo: () => ({ pageUrl: 'https://shop.test/', lateInjection: false, hookConnected: true }),
    getEntries: () => [entry('r1', FILES)],
    subscribeSettings: () => () => undefined,
    onFindEvent: () => () => undefined,
    shot: async () => {
      throw new Error('not used: the tests pass a backend');
    },
    find: async (method: string, arg: unknown) => {
      finds.push({ method, arg });
      if (method === 'findElements') {
        const q = arg as ElementQuery;
        return { matches: matches.slice(0, q.limit), total: opts.total ?? matches.length };
      }
      if (method === 'findHighlight') {
        const refs = (arg as { refs: string[] }).refs;
        return refs.length ? { ok: true, count: refs.length } : { ok: true, count: 0 };
      }
      if (method === 'findValues') {
        const shown = new Set(opts.shown ?? []);
        const candidates = (arg as { candidates: FindCandidateWire[] }).candidates;
        return {
          results: candidates
            .filter((c) => shown.has(c.value))
            .map((c) => ({ id: c.id, total: 2, more: false, visible: 1, attrOnly: false, common: false, kind: 'exact', confidence: c.kind === 'number' ? 1 : 3, as: c.kind === 'number' ? '1.258.291' : c.value, asLabel: '' })),
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as ControlHost;
  return { host, finds };
}

describe('runShotCommand', () => {
  it('element by text: the first visible match, the user\'s default padding, preview ≤ 1568 px, kept in the recent captures', async () => {
    const { host, finds } = fakeHost({ matches: [match('hidden', false), match('e1')] });
    const { backend } = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    const result = await runShotCommand({ text: 'quarterly' }, { host, backend });
    const query = finds.find((f) => f.method === 'findElements')!.arg as ElementQuery;
    expect(query).toMatchObject({ text: 'quarterly' });
    expect(result.matches).toBe(2);
    expect(result.matchIndex).toBe(1);
    expect(result.padding).toBe(30);
    expect(result.area).toEqual({ x: 70, y: 270, width: 360, height: 260 });
    expect([result.image.width, result.image.height, result.image.mimeType]).toEqual([720, 520, 'image/png']);
    expect(result.preview).toBe(result.image);
    expect(result.element).toEqual({ tag: 'span', text: 'quarterly-report-2024.pdf', selector: '#e1', rect: { x: 100, y: 300, width: 300, height: 200 }, visible: true });
    expect(result.notes).toEqual(['2 elements matched; captured #1, the first visible one (pass index to choose another)']);
    expect(getShots()).toHaveLength(1);
    expect(getShots()[0]!.padded?.padding).toBe(30);
    expect(getPanelView()).toBe('http');
    // The image is base64 of the PNG.
    expect(atob(result.image.data)).toBe('png 720x520');
  });

  it('`open` shows the capture in the Screenshot view; `index` picks a match; padding is clamped', async () => {
    const { host } = fakeHost({ matches: [match('e0'), match('e1')] });
    const { backend } = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    const result = await runShotCommand({ selector: 'span', index: 1, padding: 5000, open: true }, { host, backend });
    expect(result.matchIndex).toBe(1);
    expect(result.padding).toBe(1000);
    expect(result.notes).toContain('padding clipped at the page edge (left, top)');
    expect(getPanelView()).toBe('shot');
  });

  it('requestId + path locates that response value the way Find in page does', async () => {
    const { host, finds } = fakeHost();
    const { backend } = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    setShellSelection('r1');
    await runShotCommand({ requestId: 'selected', path: '[0].size' }, { host, backend });
    expect((finds.find((f) => f.method === 'findElements')!.arg as ElementQuery).value).toEqual({ kind: 'number', value: '1258291', key: 'size' });
    await expect(runShotCommand({ requestId: 'r1', path: '[0].owner' }, { host, backend })).rejects.toThrow('That path holds an object');
    await expect(runShotCommand({ requestId: 'r1', path: '[3].name' }, { host, backend })).rejects.toThrow('No value at "[3].name"');
    await expect(runShotCommand({ requestId: 'nope', path: 'a' }, { host, backend })).rejects.toThrow('No captured request with id nope');
    setShellSelection(null);
  });

  it('a large capture gets a smaller preview', async () => {
    const { host } = fakeHost();
    const { backend } = fakeBackend(at({ x: 100, y: 300, width: 1200, height: 400 }));
    const result = await runShotCommand({ selector: '#big', padding: 0 }, { host, backend });
    expect([result.image.width, result.image.height]).toEqual([2400, 800]);
    expect([result.preview.width, result.preview.height]).toEqual([1568, 523]);
  });

  it('visible and region targets; no locator → visible', async () => {
    const { host } = fakeHost();
    const { backend } = fakeBackend(null, { start: { scrollY: 400 } });
    const visible = await runShotCommand({}, { host, backend });
    expect(visible.area).toEqual({ x: 0, y: 400, width: 1425, height: 900 });
    expect(visible.padding).toBe(0);
    const region = await runShotCommand({ target: 'region', region: { x: 10, y: 500, width: 100, height: 50 }, padding: 0 }, { host, backend });
    expect(region.area).toEqual({ x: 10, y: 500, width: 100, height: 50 });
    await expect(runShotCommand({ target: 'region' }, { host, backend })).rejects.toThrow('needs a region');
  });

  it('fails fast: no match, a hidden match, a hidden tab, a busy page (overlay given back)', async () => {
    const none = fakeHost({ matches: [], total: 0 });
    await expect(runShotCommand({ text: 'nothing' }, { host: none.host, backend: fakeBackend(null).backend })).rejects.toThrow('No element on the page matches the text “nothing”');
    const hidden = fakeHost({ matches: [match('h', false)] });
    await expect(runShotCommand({ text: 'x' }, { host: hidden.host, backend: fakeBackend(null).backend })).rejects.toThrow('is on the page but not visible');
    const busy = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }), { busy: true });
    await expect(runShotCommand({ text: 'x' }, { host: fakeHost().host, backend: busy.backend })).rejects.toThrow(/busy.*try again in a moment/);
    expect(busy.calls.map((c) => c.op)).toEqual(['begin']);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const page = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    await expect(runShotCommand({ text: 'x' }, { host: fakeHost().host, backend: page.backend })).rejects.toThrow('The tab is not visible');
    expect(page.calls).toEqual([]);
  });

  it('re-crop in the store: a smaller padding without a new capture, annotations move with the picture', async () => {
    const { host } = fakeHost();
    const page = fakeBackend(at({ x: 100, y: 300, width: 300, height: 200 }));
    await runShotCommand({ text: 'x', padding: 50 }, { host, backend: page.backend });
    const item = getShots()[0]!;
    const captures = page.calls.filter((c) => c.op === 'capture').length;
    const { setAnnotations } = await import('../../src/ui/screenshot/store');
    setAnnotations(item.id, [{ kind: 'rect', x: 100, y: 100, w: 10, h: 10, color: 'red', width: 3 }]);
    const next = await setShotPadding(item.id, 10);
    expect([next!.width, next!.height]).toEqual([640, 440]);
    expect(next!.padded!.padding).toBe(10);
    expect(next!.id).toBe(item.id);
    // The origin moved 40 CSS px (80 image px) right and down.
    expect(next!.annotations[0]).toMatchObject({ x: 20, y: 20 });
    expect(page.calls.filter((c) => c.op === 'capture')).toHaveLength(captures);
    expect(next!.padded!.limit).toBe(SHOT_SPARE_MARGIN + 50);
  });
});

describe('runFindCommand', () => {
  it('lists matches (no refs) and the total', async () => {
    const { host } = fakeHost({ matches: [match('a'), match('b', false)], total: 7 });
    const result = await runFindCommand({ text: 'quarterly', limit: 1 }, { host });
    expect(result.total).toBe(7);
    expect(result.matches).toEqual([{ tag: 'span', text: 'quarterly-report-2024.pdf', selector: '#a', rect: { x: 100, y: 300, width: 300, height: 200 }, visible: true }]);
    expect(JSON.stringify(result)).not.toContain('"ref"');
  });

  it('highlight shows the chosen match (the bar cycles the visible ones)', async () => {
    const { host, finds } = fakeHost({ matches: [match('a', false), match('b'), match('c')] });
    const result = await runFindCommand({ selector: '.x', highlight: true, index: 2 }, { host });
    expect(result.highlighted).toBe(2);
    const shown = finds.filter((f) => f.method === 'findHighlight').at(-1)!.arg as { refs: string[]; index: number; label: string };
    expect(shown).toMatchObject({ refs: ['b', 'c'], index: 1, label: 'the selector “.x”' });
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    await expect(runFindCommand({ selector: '.x', highlight: true }, { host })).rejects.toThrow('The tab is not visible');
    // Without highlight a hidden tab is fine.
    expect((await runFindCommand({ selector: '.x' }, { host })).total).toBe(3);
  });

  it('requestId alone: the response values the page shows, in the response order', async () => {
    const { host, finds } = fakeHost({ shown: ['quarterly-report-2024.pdf', '1258291'] });
    const result = await runFindCommand({ requestId: 'r1' }, { host });
    expect(result.properties).toEqual([
      { path: '[0].name', value: 'quarterly-report-2024.pdf', matches: 2, visible: 1 },
      { path: '[0].size', value: '1258291', matches: 2, visible: 1, as: '1.258.291' },
    ]);
    expect(result.total).toBe(2);
    expect(result.matches).toEqual([]);
    const sent = (finds.find((f) => f.method === 'findValues')!.arg as { candidates: FindCandidateWire[] }).candidates;
    expect(sent.map((c) => c.value)).toEqual(collectCandidates(parseJsonTree(JSON.stringify(FILES))).candidates.map((c) => c.value));
  });

  it('a request without a JSON body says so', async () => {
    const host = { ...fakeHost().host, getEntries: () => [{ ...entry('r2', {}), responseBody: null }] } as unknown as ControlHost;
    await expect(runFindCommand({ requestId: 'r2' }, { host })).rejects.toThrow('has no captured body');
  });
});
