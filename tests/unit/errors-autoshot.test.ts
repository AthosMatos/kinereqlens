// Automatic error-area screenshots (src/ui/errors/autoShot.ts): when the overlay may be hidden (hit-region
// intersection, the user's interaction with the overlay), the retry / give-up schedule, and the capture pipeline's
// guarantees (src/ui/screenshot/engine.ts): the overlay stays shown when it does not cover the area, the hidden window
// is capped, the page session is always ended, a busy page is never disturbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HitRect } from '../../src/shared/panel-protocol';
import type { ComponentLocateResult } from '../../src/shared/initiator-protocol';
import { SHOT_BUSY_ERROR } from '../../src/shared/screenshot-protocol';
import type { ShotEndState, ShotViewport } from '../../src/shared/screenshot-protocol';
import {
  AUTO_SHOT_BUDGET_MS,
  AUTO_SHOT_MAX_HIDDEN_MS,
  AUTO_SHOT_RETRY_MS,
  INTERACTION_QUIET_MS,
  AutoShotWait,
  busyReason,
  decideOverlay,
  overlayCovers,
  retryDelay,
  runAutoShot,
} from '../../src/ui/errors/autoShot';
import type { AttemptResult, AutoShotDeps, AutoShotState, OverlayActivity, WaitReason } from '../../src/ui/errors/autoShot';
import { ShotTimeoutError, captureErrorArea, createShotBackend, inSession, isShotBusy, shotSessionActive, withTimeout } from '../../src/ui/screenshot/engine';
import type { ShotBackend, ShotHost } from '../../src/ui/screenshot/engine';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const hit = (left: number, top: number, width: number, height: number): HitRect => ({ left, top, width, height });

/** Nothing going on: the pointer elsewhere, no input for a long time. */
const idle = (patch: Partial<OverlayActivity> = {}): OverlayActivity => ({
  regions: [hit(899, -1, 543, 902)],
  pointerInside: false,
  lastInputAt: -Infinity,
  popupOpen: false,
  gesture: false,
  typing: false,
  ...patch,
});

describe('overlay covers the capture rect (hit regions)', () => {
  it('only when a region intersects the rect', () => {
    // Panel docked right from x = 900 (with its 1 px hit margin): a component at the left is not covered.
    expect(overlayCovers(rect(8, 64, 352, 172), [hit(899, -1, 543, 902)])).toBe(false);
    // The whole viewport is.
    expect(overlayCovers(rect(0, 0, 1440, 900), [hit(899, -1, 543, 902)])).toBe(true);
    // Touching edges do not intersect; one pixel of overlap does.
    expect(overlayCovers(rect(0, 0, 899, 900), [hit(899, -1, 543, 902)])).toBe(false);
    expect(overlayCovers(rect(0, 0, 900, 900), [hit(899, -1, 543, 902)])).toBe(true);
  });

  it('any region counts (pill, open menu, toast); empty ones never do', () => {
    const regions = [hit(1300, 850, 112, 30), hit(400, 300, 200, 160), hit(0, 0, 0, 900)];
    expect(overlayCovers(rect(10, 10, 300, 200), regions)).toBe(false);
    expect(overlayCovers(rect(500, 400, 50, 50), regions)).toBe(true);
    expect(overlayCovers(rect(1350, 860, 10, 10), regions)).toBe(true);
    expect(overlayCovers(rect(10, 10, 300, 200), [])).toBe(false);
  });

  it("'all' (a drag / resize) and unknown regions cover everything", () => {
    expect(overlayCovers(rect(10, 10, 20, 20), 'all')).toBe(true);
    expect(overlayCovers(rect(10, 10, 20, 20), null)).toBe(true);
  });
});

describe('the user is busy with the overlay', () => {
  it('pointer inside, recent input, open popup, drag / resize, typing', () => {
    const now = 100_000;
    expect(busyReason(idle(), now)).toBeNull();
    expect(busyReason(idle({ pointerInside: true }), now)).toBe('pointer');
    expect(busyReason(idle({ popupOpen: true }), now)).toBe('popup');
    expect(busyReason(idle({ gesture: true }), now)).toBe('gesture');
    expect(busyReason(idle({ regions: 'all' }), now)).toBe('gesture');
    expect(busyReason(idle({ typing: true }), now)).toBe('typing');
  });

  it('a key / pointer event counts for INTERACTION_QUIET_MS', () => {
    const now = 100_000;
    expect(INTERACTION_QUIET_MS).toBe(2_000);
    expect(busyReason(idle({ lastInputAt: now - 10 }), now)).toBe('input');
    expect(busyReason(idle({ lastInputAt: now - 1_999 }), now)).toBe('input');
    expect(busyReason(idle({ lastInputAt: now - 2_000 }), now)).toBeNull();
    expect(busyReason(idle({ lastInputAt: now - 500 }), now, 400)).toBeNull();
  });

  it('the most telling reason wins', () => {
    const now = 1_000;
    expect(busyReason(idle({ gesture: true, popupOpen: true, typing: true, pointerInside: true, lastInputAt: now }), now)).toBe('gesture');
    expect(busyReason(idle({ popupOpen: true, typing: true, pointerInside: true }), now)).toBe('popup');
    expect(busyReason(idle({ typing: true, pointerInside: true }), now)).toBe('typing');
    expect(busyReason(idle({ pointerInside: true, lastInputAt: now }), now)).toBe('pointer');
  });
});

describe('decideOverlay', () => {
  const area = rect(8, 64, 352, 172);
  const now = 50_000;

  it('captures with the overlay shown when it does not cover the area — even while the user works with it', () => {
    expect(decideOverlay(area, idle(), now)).toEqual({ overlay: 'visible' });
    expect(decideOverlay(area, idle({ pointerInside: true, typing: true, lastInputAt: now }), now)).toEqual({ overlay: 'visible' });
  });

  it('hides it when it covers the area and the user is not busy, waits otherwise', () => {
    const covering = idle({ regions: [hit(0, 0, 700, 900)] });
    expect(decideOverlay(area, covering, now)).toEqual({ overlay: 'hide' });
    expect(decideOverlay(area, { ...covering, pointerInside: true }, now)).toEqual({ wait: 'pointer' });
    expect(decideOverlay(area, { ...covering, lastInputAt: now - 300 }, now)).toEqual({ wait: 'input' });
    expect(decideOverlay(area, { ...covering, popupOpen: true }, now)).toEqual({ wait: 'popup' });
    expect(decideOverlay(area, idle({ regions: 'all' }), now)).toEqual({ wait: 'gesture' });
  });
});

describe('retry schedule (runAutoShot)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deps(attempts: Array<AttemptResult | Error>, patch: Partial<AutoShotDeps> = {}) {
    const states: AutoShotState[] = [];
    const times: number[] = [];
    const queue = [...attempts];
    const d: AutoShotDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      blocked: () => null,
      attempt: async () => {
        times.push(Date.now());
        const next = queue.shift() ?? { wait: 'pointer' as WaitReason };
        if (next instanceof Error) throw next;
        return next;
      },
      cancelled: () => false,
      onState: (s) => states.push(s),
      ...patch,
    };
    return { d, states, times };
  }

  it('retry delays back off and then repeat', () => {
    expect(AUTO_SHOT_RETRY_MS).toEqual([500, 1_000, 2_000, 3_000, 5_000]);
    expect([0, 1, 2, 3, 4, 5, 12].map((n) => retryDelay(n))).toEqual([500, 1_000, 2_000, 3_000, 5_000, 5_000, 5_000]);
    expect(retryDelay(-3)).toBe(500);
  });

  it('done at once', async () => {
    const { d, states, times } = deps([{ done: true }]);
    await expect(runAutoShot(d)).resolves.toEqual({ state: 'done' });
    expect(times).toHaveLength(1);
    expect(states).toEqual([{ state: 'capturing' }, { state: 'done' }]);
  });

  it('waits with backoff while the user is busy, then captures', async () => {
    const start = Date.now();
    const { d, states, times } = deps([{ wait: 'pointer' }, { wait: 'input' }, { done: true }]);
    const run = runAutoShot(d);
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual({ state: 'done' });
    expect(times.map((t) => t - start)).toEqual([0, 500, 1_500]);
    expect(states.filter((s) => s.state === 'waiting')).toEqual([
      { state: 'waiting', reason: 'pointer' },
      { state: 'waiting', reason: 'input' },
    ]);
  });

  it('gives up after the budget: "skipped — busy" with the last reason', async () => {
    const start = Date.now();
    const { d, states, times } = deps([]);
    const run = runAutoShot(d);
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual({ state: 'skipped', reason: 'pointer' });
    expect(AUTO_SHOT_BUDGET_MS).toBe(30_000);
    // 0, .5, 1.5, 3.5, 6.5, 11.5, 16.5, 21.5, 26.5 and a last one exactly at the budget.
    expect(times.map((t) => t - start)).toEqual([0, 500, 1_500, 3_500, 6_500, 11_500, 16_500, 21_500, 26_500, 30_000]);
    expect(states[states.length - 1]).toEqual({ state: 'skipped', reason: 'pointer' });
  });

  it('does not even attempt while blocked (tab hidden, overlay closed, another capture)', async () => {
    const start = Date.now();
    let blocked: WaitReason | null = 'session';
    setTimeout(() => (blocked = null), 2_000);
    const { d, times, states } = deps([{ done: true }], { blocked: () => blocked });
    const run = runAutoShot(d);
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual({ state: 'done' });
    expect(times.map((t) => t - start)).toEqual([3_500]);
    expect(states[0]).toEqual({ state: 'waiting', reason: 'session' });
  });

  it('reports a failed capture and stops', async () => {
    const { d, times } = deps([new Error('The page could not be captured within 2.5 s')]);
    await expect(runAutoShot(d)).resolves.toEqual({ state: 'failed', error: 'The page could not be captured within 2.5 s' });
    expect(times).toHaveLength(1);
  });

  it('stops silently when cancelled (a manual capture took over)', async () => {
    let cancelled = false;
    const { d, states, times } = deps([{ wait: 'typing' }, { done: true }], { cancelled: () => cancelled });
    const run = runAutoShot(d);
    await vi.advanceTimersByTimeAsync(100);
    cancelled = true;
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeNull();
    expect(times).toHaveLength(1);
    expect(states.map((s) => s.state)).toEqual(['capturing', 'waiting']);
  });
});

describe('cap timer (withTimeout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles with the work before the cap', async () => {
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('png'), 2_000));
    const capped = withTimeout(work, AUTO_SHOT_MAX_HIDDEN_MS, 'too slow');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(capped).resolves.toBe('png');
  });

  it('rejects at the cap and drops the late result', async () => {
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('png'), 6_000));
    const capped = withTimeout(work, AUTO_SHOT_MAX_HIDDEN_MS, 'too slow');
    const settled = vi.fn();
    capped.then(settled, settled);
    await vi.advanceTimersByTimeAsync(AUTO_SHOT_MAX_HIDDEN_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toBeInstanceOf(ShotTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------------ engine

const VIEWPORT: ShotViewport = {
  innerWidth: 1440,
  innerHeight: 900,
  clientWidth: 1440,
  clientHeight: 900,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
  scrollWidth: 1440,
  scrollHeight: 900,
  host: 'shop.test',
};

const ORDERS: ComponentLocateResult = {
  frameworks: ['preact'],
  matches: [{ name: 'OrdersPanel', count: 1, instances: [{ path: ['App', 'OrdersPanel'], rect: { x: 24, y: 80, width: 320, height: 140 } }] }],
};

interface Call {
  op: 'begin' | 'end' | 'capture';
  at: number;
  hide?: boolean;
  opts?: unknown;
}

function fakeBackend(behaviour: { capture?: () => Promise<Blob>; end?: ShotEndState; beginError?: Error } = {}) {
  const calls: Call[] = [];
  const backend: ShotBackend = {
    begin: async (hide, opts) => {
      calls.push({ op: 'begin', at: Date.now(), hide, opts });
      if (behaviour.beginError) throw behaviour.beginError;
      return VIEWPORT;
    },
    scroll: async () => VIEWPORT,
    end: async () => {
      calls.push({ op: 'end', at: Date.now() });
      return behaviour.end ?? 'ok';
    },
    pick: async () => null,
    captureVisible: async () => {
      calls.push({ op: 'capture', at: Date.now() });
      return behaviour.capture ? behaviour.capture() : new Blob(['png']);
    },
  };
  return { backend, calls };
}

describe('error-area capture pipeline (captureErrorArea)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The decode / crop / encode steps (no image work in node).
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1440, height: 900, close() {} }));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { drawImage() {}, imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
        }
        async convertToBlob() {
          return new Blob(['png']);
        }
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const locate = vi.fn(async () => ORDERS);
  const auto = (decision: (r: { x: number; y: number; width: number; height: number }) => 'visible' | 'hide') => ({
    scroll: false,
    exclusive: true,
    maxHiddenMs: AUTO_SHOT_MAX_HIDDEN_MS,
    overlay: decision,
  });

  it('automatic, overlay not covering: measured and captured with the overlay shown, never hidden, never scrolled', async () => {
    const { backend, calls } = fakeBackend();
    const decide = vi.fn(() => 'visible' as const);
    const out = await captureErrorArea(backend, locate, ['OrdersPanel'], auto(decide));
    expect(locate).toHaveBeenLastCalledWith({ names: ['OrdersPanel'], scroll: false, highlight: false });
    expect(decide).toHaveBeenCalledWith({ x: 8, y: 64, width: 352, height: 172 }, VIEWPORT);
    expect(calls.map((c) => c.op)).toEqual(['begin', 'capture', 'end']);
    expect(calls[0]).toMatchObject({ hide: false, opts: { exclusive: true } });
    expect(out).toMatchObject({ area: 'component', component: 'OrdersPanel', rect: { x: 8, y: 64, width: 352, height: 172 } });
  });

  it('automatic, the user is busy: the session ends without hiding or capturing', async () => {
    const { backend, calls } = fakeBackend();
    await expect(
      captureErrorArea(
        backend,
        locate,
        ['OrdersPanel'],
        auto(() => {
          throw new AutoShotWait('pointer');
        }),
      ),
    ).rejects.toBeInstanceOf(AutoShotWait);
    expect(calls.map((c) => c.op)).toEqual(['begin', 'end']);
    expect(calls.some((c) => c.op === 'begin' && c.hide)).toBe(false);
  });

  it('automatic, overlay covering: hidden with the cap; a slow capture is abandoned at the cap and the overlay restored at once', async () => {
    const { backend, calls } = fakeBackend({ capture: () => new Promise((resolve) => setTimeout(() => resolve(new Blob(['png'])), 8_000)) });
    const start = Date.now();
    const run = captureErrorArea(backend, locate, ['OrdersPanel'], auto(() => 'hide'));
    const settled = vi.fn();
    run.then(settled, settled);
    await vi.advanceTimersByTimeAsync(AUTO_SHOT_MAX_HIDDEN_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'end')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toBeInstanceOf(ShotTimeoutError);
    const hidden = calls.find((c) => c.op === 'begin' && c.hide)!;
    expect(hidden.opts).toEqual({ maxHiddenMs: AUTO_SHOT_MAX_HIDDEN_MS });
    const end = calls.find((c) => c.op === 'end')!;
    expect(end.at - hidden.at).toBe(AUTO_SHOT_MAX_HIDDEN_MS);
    expect(end.at - start).toBe(AUTO_SHOT_MAX_HIDDEN_MS);
    // The late picture changes nothing (no second end, no result).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c.op === 'end')).toHaveLength(1);
  });

  it('automatic, overlay covering, capture in time: one picture, the session ended', async () => {
    const { backend, calls } = fakeBackend({ capture: () => new Promise((resolve) => setTimeout(() => resolve(new Blob(['png'])), 700)) });
    const run = captureErrorArea(backend, locate, ['OrdersPanel'], auto(() => 'hide'));
    await vi.advanceTimersByTimeAsync(700);
    await expect(run).resolves.toMatchObject({ area: 'component', component: 'OrdersPanel' });
    expect(calls.map((c) => `${c.op}${c.hide === undefined ? '' : c.hide ? ':hide' : ':show'}`)).toEqual(['begin:show', 'begin:hide', 'capture', 'end']);
  });

  it('a busy page (another capture, Find in page) is left alone: no end for a refused begin', async () => {
    const { backend, calls } = fakeBackend({ beginError: new Error(SHOT_BUSY_ERROR) });
    const err = await captureErrorArea(backend, locate, ['OrdersPanel'], auto(() => 'hide')).catch((e: unknown) => e);
    expect(isShotBusy(err)).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['begin']);
  });

  it('a session the page side ended first (timeout, Esc) yields no picture', async () => {
    const expired = fakeBackend({ end: 'expired' });
    await expect(captureErrorArea(expired.backend, locate, ['OrdersPanel'], auto(() => 'hide'))).rejects.toThrow(/interrupted/);
    const cancelled = fakeBackend({ end: 'cancelled' });
    await expect(captureErrorArea(cancelled.backend, locate, ['OrdersPanel'])).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('manual: hidden right away (component scrolled into view), the session always ended — also on failure', async () => {
    const ok = fakeBackend();
    await expect(captureErrorArea(ok.backend, locate, ['OrdersPanel'])).resolves.toMatchObject({ area: 'component' });
    expect(locate).toHaveBeenLastCalledWith({ names: ['OrdersPanel'], scroll: true, highlight: false });
    expect(ok.calls.map((c) => `${c.op}${c.hide === undefined ? '' : c.hide ? ':hide' : ':show'}`)).toEqual(['begin:hide', 'capture', 'end']);
    const failing = fakeBackend({ capture: async () => Promise.reject(new Error('Switch to this tab')) });
    await expect(captureErrorArea(failing.backend, locate, ['OrdersPanel'])).rejects.toThrow('Switch to this tab');
    expect(failing.calls.map((c) => c.op)).toEqual(['begin', 'capture', 'end']);
  });

  it('no component found: the visible page', async () => {
    const { backend } = fakeBackend();
    const out = await captureErrorArea(backend, async () => ({ frameworks: [], matches: [{ name: 'OrdersPanel', count: 0, instances: [] }] }), ['OrdersPanel'], auto(() => 'hide'));
    expect(out).toMatchObject({ area: 'viewport', rect: { x: 0, y: 0, width: 1440, height: 900 } });
  });
});

describe('page session bookkeeping (createShotBackend / inSession)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function host(answers: { begin?: () => Promise<unknown>; end?: () => Promise<unknown> } = {}) {
    const calls: string[] = [];
    const h: ShotHost = {
      shot: ((method: string) => {
        calls.push(method);
        if (method === 'shotBegin') return answers.begin ? answers.begin() : Promise.resolve(VIEWPORT);
        if (method === 'shotEnd') return answers.end ? answers.end() : Promise.resolve('ok');
        return Promise.resolve(VIEWPORT);
      }) as ShotHost['shot'],
    };
    return { h, calls };
  }

  it('a session counts as active between begin and end (automatic captures wait meanwhile)', async () => {
    const { h } = host();
    const backend = createShotBackend(h);
    expect(shotSessionActive()).toBe(false);
    await backend.begin(true);
    expect(shotSessionActive()).toBe(true);
    await expect(backend.end()).resolves.toBe('ok');
    expect(shotSessionActive()).toBe(false);
  });

  it('a refused (busy) begin leaves no session behind', async () => {
    const { h } = host({ begin: () => Promise.reject(new Error(SHOT_BUSY_ERROR)) });
    const backend = createShotBackend(h);
    await expect(backend.begin(false, { exclusive: true })).rejects.toThrow(SHOT_BUSY_ERROR);
    expect(shotSessionActive()).toBe(false);
  });

  it('a hung begin times out and the session is still ended', async () => {
    vi.useFakeTimers();
    const { h, calls } = host({ begin: () => new Promise(() => undefined) });
    const backend = createShotBackend(h);
    const run = inSession(backend, () => backend.begin(true));
    const settled = vi.fn();
    run.then(settled, settled);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled.mock.calls[0]![0]).toBeInstanceOf(ShotTimeoutError);
    expect(calls).toEqual(['shotBegin', 'shotEnd']);
    expect(shotSessionActive()).toBe(false);
  });

  it('an older page side that answers nothing to shotEnd counts as intact', async () => {
    const { h } = host({ end: () => Promise.resolve(undefined) });
    const backend = createShotBackend(h);
    await backend.begin(false);
    await expect(backend.end()).resolves.toBe('ok');
  });
});
