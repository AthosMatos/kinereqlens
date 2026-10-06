// Page side of padded captures (src/ui/screenshot/page/controller.ts shotElement / shotScroll x, the picker's element
// refs, src/ui/frame/elementRefs.ts): the element is measured after being scrolled into view, its scroll containers
// are put back when the session ends, a fixed element says so, a gone element answers null, and a pick hands out a
// ref instead of the element. Minimal DOM stubs (node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShotPickResult } from '../../src/shared/screenshot-protocol';
import { createShotController } from '../../src/ui/screenshot/page/controller';
import { clearRefs, elementOf, refOf } from '../../src/ui/frame/elementRefs';
import { ELEMENT_REF_TTL_MS } from '../../src/shared/find-protocol';

const pickers = vi.hoisted(() => [] as Array<{ done: (r: (ShotPickResult & { element?: unknown }) | null) => void }>);

vi.mock('../../src/ui/screenshot/page/picker', () => ({
  startPicker: (_mode: string, done: (r: (ShotPickResult & { element?: unknown }) | null) => void) => {
    pickers.push({ done });
    return { cancel: () => done(null) };
  },
}));

interface FakeEl {
  isConnected: boolean;
  parentNode: FakeEl | null;
  nodeType: number;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  position: string;
  rect: { left: number; top: number; width: number; height: number };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  scrollIntoView(): void;
  scrollTo(o: { left: number; top: number }): void;
}

function el(partial: Partial<FakeEl> = {}): FakeEl {
  const e: FakeEl = {
    isConnected: true,
    parentNode: null,
    nodeType: 1,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 100,
    scrollHeight: 100,
    clientWidth: 100,
    clientHeight: 100,
    position: 'static',
    rect: { left: 10, top: 20, width: 30, height: 40 },
    getBoundingClientRect: () => e.rect,
    scrollIntoView: () => undefined,
    scrollTo: (o) => {
      e.scrollLeft = o.left;
      e.scrollTop = o.top;
    },
    ...partial,
  };
  return e;
}

function stubPage(root: FakeEl) {
  const win = {
    scrollX: 0,
    scrollY: 300,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    scrollTo: (o: { left: number; top: number }) => {
      win.scrollX = o.left;
      win.scrollY = o.top;
    },
  };
  const style = new Map<string, string>();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    compatMode: 'CSS1Compat',
    body: root,
    scrollingElement: root,
    documentElement: {
      ...root,
      clientWidth: 1425,
      clientHeight: 900,
      scrollWidth: 1425,
      scrollHeight: 3000,
      style: {
        getPropertyValue: (p: string) => style.get(p) ?? '',
        getPropertyPriority: () => '',
        setProperty: (p: string, v: string) => void style.set(p, v),
        removeProperty: (p: string) => void style.delete(p),
      },
    },
  });
  vi.stubGlobal('location', { hostname: 'shop.test' });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16));
  vi.stubGlobal('getComputedStyle', (node: FakeEl) => ({ position: node.position }));
  return { win, style };
}

const frame = () => ({ hidden: false, setCaptureHidden(h: boolean) { this.hidden = h; } });
const settle = () => vi.advanceTimersByTimeAsync(400);

describe('padded captures, page side', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pickers.length = 0;
    clearRefs();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shotElement scrolls the element into view, measures it, and the session puts its scroller back', async () => {
    const root = el();
    const scroller = el({ parentNode: root, scrollTop: 40, scrollHeight: 2000, clientHeight: 300 });
    const target = el({ parentNode: scroller });
    target.scrollIntoView = () => {
      scroller.scrollTop = 900;
      target.rect = { left: 10, top: 120, width: 30, height: 40 };
    };
    const { win } = stubPage(root);
    const c = createShotController(frame());
    const ref = refOf(target as unknown as Element);
    const measuring = c.element(ref, true);
    await settle();
    const g = await measuring;
    expect(g).toMatchObject({ rect: { x: 10, y: 120, width: 30, height: 40 }, viewport: { scrollY: 300, host: 'shop.test' } });
    expect(g!.fixed).toBeUndefined();
    expect(scroller.scrollTop).toBe(900);
    win.scrollTo({ left: 0, top: 1200 });
    expect(c.end()).toBe('ok');
    expect(scroller.scrollTop).toBe(40);
    expect(win.scrollY).toBe(300);
  });

  it('a fixed element says so; a gone or unknown element answers null', async () => {
    const root = el();
    const bar = el({ parentNode: root, position: 'fixed' });
    const inner = el({ parentNode: bar });
    stubPage(root);
    const c = createShotController(frame());
    const g = c.element(refOf(inner as unknown as Element), false);
    await settle();
    expect((await g)!.fixed).toBe(true);
    const gone = el({ parentNode: root, isConnected: false });
    expect(await c.element(refOf(gone as unknown as Element), false)).toBeNull();
    expect(await c.element('e-unknown', true)).toBeNull();
    c.end();
  });

  it('shotScroll takes an x position (default: where the session began)', async () => {
    const root = el();
    const { win } = stubPage(root);
    const c = createShotController(frame());
    const first = c.scroll(500, false, 40);
    await settle();
    expect(await first).toMatchObject({ scrollX: 40, scrollY: 500 });
    const second = c.scroll(800, false);
    await settle();
    expect(await second).toMatchObject({ scrollX: 0, scrollY: 800 });
    c.end();
    expect([win.scrollX, win.scrollY]).toEqual([0, 300]);
  });

  it('an element pick hands the panel a ref, never the element', async () => {
    const root = el();
    stubPage(root);
    const c = createShotController(frame());
    const picked = el({ parentNode: root });
    const pick = c.pick('element');
    pickers[0]!.done({ mode: 'element', rect: { x: 1, y: 2, width: 3, height: 4 }, label: 'div  3 × 4', element: picked });
    await settle();
    const result = (await pick)!;
    expect(result).toEqual({ mode: 'element', rect: { x: 1, y: 2, width: 3, height: 4 }, label: 'div  3 × 4', ref: expect.stringMatching(/^e[0-9a-f]{24}$/) });
    expect(elementOf(result.ref)).toBe(picked);
    c.end();
  });

  it('refs: one per element, dropped after the TTL', () => {
    const a = el();
    const b = el();
    const now = 1_000_000;
    const ra = refOf(a as unknown as Element, now);
    expect(refOf(a as unknown as Element, now + 10)).toBe(ra);
    expect(refOf(b as unknown as Element, now)).not.toBe(ra);
    expect(elementOf(ra, now + 100)).toBe(a);
    expect(elementOf(ra, now + 10 + ELEMENT_REF_TTL_MS + 1)).toBeNull();
    expect(elementOf(42)).toBeNull();
  });
});
