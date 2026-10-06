// Page side of the screenshot tool (src/ui/screenshot/page/controller.ts): a capture session always gives the page
// back — a hidden-overlay session the panel stops driving restores after SHOT_HIDDEN_IDLE_MS (a shown one after
// SHOT_IDLE_MS, a pick waiting for the user never idles), an automatic capture's hidden window ends at its cap, Esc
// restores — and reports how it ended; exclusive sessions never join another one. Minimal DOM stubs (node).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOT_BUSY_ERROR, SHOT_HIDDEN_IDLE_MS, SHOT_IDLE_MS } from '../../src/shared/screenshot-protocol';
import type { ShotPickResult } from '../../src/shared/screenshot-protocol';
import { createShotController, hiddenCapOf } from '../../src/ui/screenshot/page/controller';
import type { ShotFrame } from '../../src/ui/screenshot/page/controller';
import { shotBeginOptions } from '../../src/ui/frame/server';

const pickers = vi.hoisted(() => [] as Array<{ mode: string; done: (r: ShotPickResult | null) => void; cancelled: boolean }>);

vi.mock('../../src/ui/screenshot/page/picker', () => ({
  startPicker: (mode: string, done: (r: ShotPickResult | null) => void) => {
    const p = { mode, done, cancelled: false };
    pickers.push(p);
    return {
      cancel: () => {
        if (p.cancelled) return;
        p.cancelled = true;
        done(null);
      },
    };
  },
}));

type KeyListener = (e: { key: string }) => void;

function stubPage() {
  const keydown = new Set<KeyListener>();
  const others = new Map<string, Set<() => void>>();
  const style = new Map<string, string>();
  const win = {
    scrollX: 0,
    scrollY: 120,
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    addEventListener: (type: string, fn: KeyListener) => {
      if (type === 'keydown') keydown.add(fn);
      else others.set(type, (others.get(type) ?? new Set()).add(fn as () => void));
    },
    removeEventListener: (type: string, fn: KeyListener) => {
      if (type === 'keydown') keydown.delete(fn);
      else others.get(type)?.delete(fn as () => void);
    },
    scrollTo: (opts: { left: number; top: number }) => {
      win.scrollX = opts.left;
      win.scrollY = opts.top;
    },
  };
  const el = { clientWidth: 1425, clientHeight: 900, scrollWidth: 1425, scrollHeight: 3000 };
  const doc = {
    compatMode: 'CSS1Compat',
    body: el,
    documentElement: {
      ...el,
      style: {
        getPropertyValue: (p: string) => style.get(p) ?? '',
        getPropertyPriority: () => '',
        setProperty: (p: string, v: string) => void style.set(p, v),
        removeProperty: (p: string) => void style.delete(p),
      },
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { hostname: 'shop.test' });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 16));
  return {
    win,
    style,
    keydown,
    pressEsc: () => [...keydown].forEach((fn) => fn({ key: 'Escape' })),
    /** A pointer event on the page itself (outside the overlay's regions). */
    pagePointer: (type = 'pointermove') => [...(others.get(type) ?? [])].forEach((fn) => fn()),
    listeners: (type: string) => others.get(type)?.size ?? 0,
  };
}

function fakeFrame(): ShotFrame & { hidden: boolean; changes: boolean[]; peekHidden: boolean } {
  const frame = {
    hidden: false,
    peekHidden: false,
    changes: [] as boolean[],
    setCaptureHidden(hidden: boolean) {
      frame.hidden = hidden;
      frame.changes.push(hidden);
    },
  };
  return frame;
}

/** Let a call that waits two frames settle. */
const frames = () => vi.advanceTimersByTimeAsync(300);

describe('page-side capture session (createShotController)', () => {
  let page: ReturnType<typeof stubPage>;
  beforeEach(() => {
    vi.useFakeTimers();
    page = stubPage();
    pickers.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a hidden-overlay session that receives no calls restores the page after SHOT_HIDDEN_IDLE_MS (≤ 5 s)', async () => {
    expect(SHOT_HIDDEN_IDLE_MS).toBeLessThanOrEqual(5_000);
    const frame = fakeFrame();
    const c = createShotController(frame);
    const begin = c.begin({ hideOverlay: true });
    await frames();
    await expect(begin).resolves.toMatchObject({ innerWidth: 1440, clientWidth: 1425, devicePixelRatio: 2, scrollY: 120, host: 'shop.test' });
    expect(frame.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(SHOT_HIDDEN_IDLE_MS - 400);
    expect(frame.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(frame.hidden).toBe(false);
    expect(page.keydown.size).toBe(0);
    // The panel's late calls fail until it ends the session, which reports the timeout.
    await expect(c.scroll(500, false)).rejects.toThrow(/timed out/);
    expect(c.end()).toBe('expired');
    // The next capture starts fresh.
    const next = c.begin({ hideOverlay: true });
    await frames();
    await expect(next).resolves.toBeTruthy();
    expect(c.end()).toBe('ok');
    expect(frame.changes).toEqual([true, false, true, false]);
  });

  it('every call keeps a hidden session alive (full-page tiles), and the page is restored when it idles', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true });
    await vi.advanceTimersByTimeAsync(4_000);
    void c.scroll(900, false);
    await vi.advanceTimersByTimeAsync(4_000);
    void c.scroll(1800, false);
    await vi.advanceTimersByTimeAsync(SHOT_HIDDEN_IDLE_MS - 100);
    expect(frame.hidden).toBe(true);
    expect(page.win.scrollY).toBe(1800);
    await vi.advanceTimersByTimeAsync(200);
    expect(frame.hidden).toBe(false);
    // Scroll position and the root style are back.
    expect(page.win.scrollY).toBe(120);
    expect(page.style.size).toBe(0);
    expect(c.end()).toBe('expired');
  });

  it('a session with the overlay shown idles after SHOT_IDLE_MS only', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: false });
    await vi.advanceTimersByTimeAsync(SHOT_HIDDEN_IDLE_MS + 1_000);
    await frames();
    const scroll = c.scroll(0, false);
    await frames();
    await expect(scroll).resolves.toBeTruthy();
    await vi.advanceTimersByTimeAsync(SHOT_IDLE_MS);
    expect(c.end()).toBe('expired');
    expect(frame.changes).toEqual([]);
  });

  it('the hidden window ends at its cap (maxHiddenMs) even while the panel keeps calling', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true, maxHiddenMs: 2_500 });
    await vi.advanceTimersByTimeAsync(1_000);
    void c.begin({ hideOverlay: true, maxHiddenMs: 2_500 });
    await vi.advanceTimersByTimeAsync(1_000);
    void c.scroll(10, false);
    await vi.advanceTimersByTimeAsync(499);
    expect(frame.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(frame.hidden).toBe(false);
    expect(c.end()).toBe('expired');
  });

  it('the cap only runs while hidden and is clamped', async () => {
    expect(hiddenCapOf(2_500)).toBe(2_500);
    expect(hiddenCapOf(10)).toBe(500);
    expect(hiddenCapOf(10 * 60_000)).toBe(SHOT_IDLE_MS);
    expect(hiddenCapOf(Number.NaN)).toBeNull();
    expect(hiddenCapOf(-1)).toBeNull();
    expect(hiddenCapOf('2500')).toBeNull();
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: false, maxHiddenMs: 600 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.end()).toBe('ok');
  });

  it('Esc on the page restores at once and cancels the capture', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true });
    await frames();
    void c.scroll(2000, false);
    await frames();
    page.pressEsc();
    expect(frame.hidden).toBe(false);
    expect(page.win.scrollY).toBe(120);
    await expect(c.scroll(0, false)).rejects.toThrow(/cancelled/);
    expect(c.end()).toBe('cancelled');
    expect(c.end()).toBe('none');
  });

  it('the viewport metrics say when the page last saw the pointer (not over the overlay)', async () => {
    const c = createShotController(fakeFrame());
    const first = c.begin({ hideOverlay: false });
    await frames();
    await expect(first).resolves.toMatchObject({ pointerAt: 0 });
    vi.setSystemTime(1_700_000_000_000);
    page.pagePointer('pointermove');
    const second = c.begin({ hideOverlay: false });
    await frames();
    await expect(second).resolves.toMatchObject({ pointerAt: 1_700_000_000_000 });
    c.end();
    expect(page.listeners('pointermove')).toBe(1);
    c.dispose();
    expect(page.listeners('pointermove')).toBe(0);
    expect(page.listeners('pointerdown')).toBe(0);
  });

  it('end() reports an intact session, or none', async () => {
    const c = createShotController(fakeFrame());
    expect(c.end()).toBe('none');
    void c.begin({ hideOverlay: true });
    await frames();
    expect(c.end()).toBe('ok');
  });

  it('an exclusive begin never joins another session nor Find in page (nothing changes on the page)', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true });
    await frames();
    await expect(c.begin({ hideOverlay: false, exclusive: true })).rejects.toThrow(SHOT_BUSY_ERROR);
    expect(frame.hidden).toBe(true);
    expect(c.end()).toBe('ok');
    frame.peekHidden = true;
    await expect(c.begin({ hideOverlay: false, exclusive: true })).rejects.toThrow(SHOT_BUSY_ERROR);
    frame.peekHidden = false;
    const free = c.begin({ hideOverlay: false, exclusive: true });
    await frames();
    await expect(free).resolves.toBeTruthy();
    // A session the page side ended (not yet acknowledged by its owner) still counts as busy.
    const c2 = createShotController(fakeFrame());
    void c2.begin({ hideOverlay: true });
    await frames();
    page.pressEsc();
    await expect(c2.begin({ hideOverlay: false, exclusive: true })).rejects.toThrow(SHOT_BUSY_ERROR);
  });

  it('a pick waiting for the user never idles; afterwards the hidden idle applies again', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true });
    await frames();
    const pick = c.pick('region');
    expect(pickers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frame.hidden).toBe(true);
    pickers[0]!.done({ mode: 'region', rect: { x: 1, y: 2, width: 30, height: 40 } });
    await frames();
    await expect(pick).resolves.toEqual({ mode: 'region', rect: { x: 1, y: 2, width: 30, height: 40 } });
    await vi.advanceTimersByTimeAsync(SHOT_HIDDEN_IDLE_MS);
    expect(frame.hidden).toBe(false);
    expect(c.end()).toBe('expired');
  });

  it('Esc during a pick cancels it (null) and restores', async () => {
    const frame = fakeFrame();
    const c = createShotController(frame);
    void c.begin({ hideOverlay: true });
    await frames();
    const pick = c.pick('element');
    page.pressEsc();
    await frames();
    await expect(pick).resolves.toBeNull();
    expect(pickers[0]!.cancelled).toBe(true);
    expect(frame.hidden).toBe(false);
    expect(c.end()).toBe('cancelled');
  });
});

describe('shotBegin options from the panel (frame/server.ts)', () => {
  it('keeps valid values only', () => {
    expect(shotBeginOptions(undefined)).toEqual({ hideOverlay: false });
    expect(shotBeginOptions({ hideOverlay: 'yes', exclusive: 1, maxHiddenMs: Number.NaN })).toEqual({ hideOverlay: false });
    expect(shotBeginOptions({ hideOverlay: true, exclusive: true, maxHiddenMs: 2_500 })).toEqual({ hideOverlay: true, exclusive: true, maxHiddenMs: 2_500 });
    expect(shotBeginOptions({ hideOverlay: true, maxHiddenMs: -5 })).toEqual({ hideOverlay: true });
  });
});
