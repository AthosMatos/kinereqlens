import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_CALL_TIMEOUT_MS, CAPTURE_QUEUE_MAX, CAPTURE_TIMEOUT_ERROR, CaptureQueue } from '../../src/background/capture';
import type { CaptureDeps } from '../../src/background/capture';
import { createMessageRouter } from '../../src/background/router';
import type { RouterDeps } from '../../src/background/router';
import type { TabStore } from '../../src/background/tabs';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Deterministic clock: sleep advances time instantly. */
function fakeDeps(overrides: Partial<CaptureDeps> = {}) {
  let now = 1000;
  const starts: number[] = [];
  const deps: CaptureDeps = {
    getTab: async () => ({ active: true, windowId: 7 }),
    captureVisibleTab: async () => {
      starts.push(now);
      return PNG;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    ...overrides,
  };
  return { deps, starts, advance: (ms: number) => (now += ms) };
}

describe('CaptureQueue', () => {
  it('captures the window of the tab', async () => {
    const capture = vi.fn(async () => PNG);
    const { deps } = fakeDeps({ captureVisibleTab: capture });
    const q = new CaptureQueue(deps, 500);
    await expect(q.capture(3)).resolves.toEqual({ ok: true, dataUrl: PNG });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it('spaces captures by the minimum interval (≤ 2 / s) and runs them in order', async () => {
    const { deps, starts } = fakeDeps();
    const q = new CaptureQueue(deps, 500);
    const results = await Promise.all([q.capture(1), q.capture(1), q.capture(1)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(500);
    expect(q.pending).toBe(0);
  });

  it('does not wait when the last capture is old enough', async () => {
    const sleep = vi.fn(async () => undefined);
    const { deps, advance } = fakeDeps({ sleep });
    const q = new CaptureQueue(deps, 500);
    await q.capture(1);
    advance(600);
    await q.capture(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refuses background tabs and gone tabs', async () => {
    const q1 = new CaptureQueue(fakeDeps({ getTab: async () => ({ active: false, windowId: 1 }) }).deps);
    await expect(q1.capture(1)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/visible tab/) });
    const q2 = new CaptureQueue(fakeDeps({ getTab: async () => { throw new Error('No tab with id: 1'); } }).deps);
    await expect(q2.capture(1)).resolves.toEqual({ ok: false, error: 'The tab is gone' });
  });

  it('retries quota errors, reports other errors', async () => {
    let calls = 0;
    const quota = fakeDeps({
      captureVisibleTab: async () => {
        if (++calls < 3) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
        return PNG;
      },
    });
    await expect(new CaptureQueue(quota.deps).capture(1)).resolves.toEqual({ ok: true, dataUrl: PNG });
    expect(calls).toBe(3);

    const failing = fakeDeps({ captureVisibleTab: async () => { throw new Error('Cannot access contents of url "edge://settings/"'); } });
    await expect(new CaptureQueue(failing.deps).capture(1)).resolves.toEqual({ ok: false, error: 'Cannot access contents of url "edge://settings/"' });

    const notPng = fakeDeps({ captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA' });
    await expect(new CaptureQueue(notPng.deps).capture(1)).resolves.toMatchObject({ ok: false });
  });

  it('a failed capture does not block the queue', async () => {
    let n = 0;
    const { deps } = fakeDeps({
      captureVisibleTab: async () => {
        if (n++ === 0) throw new Error('boom');
        return PNG;
      },
    });
    const q = new CaptureQueue(deps, 10);
    const [a, b] = await Promise.all([q.capture(1), q.capture(1)]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
  });

  it('a captureVisibleTab call that never answers fails after its timeout and does not hold up the queue', async () => {
    expect(CAPTURE_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    let n = 0;
    const { deps } = fakeDeps({ captureVisibleTab: () => (n++ === 0 ? new Promise<string>(() => undefined) : Promise.resolve(PNG)) });
    const q = new CaptureQueue(deps, 0, 40);
    const [hung, next] = await Promise.all([q.capture(1), q.capture(1)]);
    expect(hung).toEqual({ ok: false, error: CAPTURE_TIMEOUT_ERROR });
    expect(next).toEqual({ ok: true, dataUrl: PNG });
    expect(q.pending).toBe(0);
  });

  it('bounds the queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps } = fakeDeps({ getTab: async () => (await gate, { active: true, windowId: 1 }) });
    const q = new CaptureQueue(deps, 0);
    const queued = Array.from({ length: CAPTURE_QUEUE_MAX }, () => q.capture(1));
    await expect(q.capture(1)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
    release();
    await Promise.all(queued);
  });
});

describe('router: CAPTURE_VISIBLE_TAB', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop';
  const PANEL = `chrome-extension://${EXT}/panel.html#nonce`;

  function route(opts: { open?: boolean; capture?: boolean } = {}) {
    const capture = vi.fn(async (_tabId: number) => ({ ok: true as const, dataUrl: PNG }));
    const deps = {
      extensionId: EXT,
      ready: Promise.resolve(),
      tabs: { isOpen: () => opts.open ?? true, isLoaded: true, get: () => ({ open: true, recording: true, preserveLog: false }) } as unknown as TabStore,
      ...(opts.capture === false ? {} : { capture: { capture } }),
    } as unknown as RouterDeps;
    const listener = createMessageRouter(deps);
    const send = (sender: Partial<chrome.runtime.MessageSender>) =>
      new Promise<unknown>((resolve) => {
        const handled = listener({ type: 'CAPTURE_VISIBLE_TAB' }, { id: EXT, tab: { id: 5 } as chrome.tabs.Tab, ...sender }, resolve);
        if (!handled) resolve('unhandled');
      });
    return { send, capture };
  }

  it('serves the panel page and the top frame content script of the sender’s tab', async () => {
    const { send, capture } = route();
    await expect(send({ frameId: 3, url: PANEL })).resolves.toEqual({ ok: true, dataUrl: PNG });
    await expect(send({ frameId: 0, url: 'https://app.example.com/' })).resolves.toEqual({ ok: true, dataUrl: PNG });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith(5);
  });

  it('refuses subframe content scripts, closed overlays, other extensions', async () => {
    const { send, capture } = route();
    await expect(send({ frameId: 2, url: 'https://ads.example.com/frame' })).resolves.toMatchObject({ ok: false });
    await expect(send({ frameId: 3, url: `chrome-extension://${EXT}/other.html` })).resolves.toMatchObject({ ok: false });
    await expect(send({ frameId: 0, id: 'someone-else' })).resolves.toBe('unhandled');
    expect(capture).not.toHaveBeenCalled();
    const closed = route({ open: false });
    await expect(closed.send({ frameId: 3, url: PANEL })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Open the kineReqLens overlay/) });
    const unavailable = route({ capture: false });
    await expect(unavailable.send({ frameId: 3, url: PANEL })).resolves.toMatchObject({ ok: false });
  });
});
