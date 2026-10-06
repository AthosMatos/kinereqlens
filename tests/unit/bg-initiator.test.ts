import { describe, expect, it, vi } from 'vitest';
import { createMessageRouter } from '../../src/background/router';
import type { RouterDeps } from '../../src/background/router';
import { sanitizeResolveFrames } from '../../src/background/sources';
import type { TabStore } from '../../src/background/tabs';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PANEL_URL = `chrome-extension://${EXT_ID}/panel.html#nonce`;

function router(open = true) {
  const resolve = vi.fn(async (frames: Array<{ url: string }>) => frames.map(() => ({ ok: false as const, reason: 'no-map' as const })));
  const deps = {
    extensionId: EXT_ID,
    ready: Promise.resolve(),
    tabs: { isOpen: () => open, isLoaded: true, get: () => ({ open, recording: true, preserveLog: false }) } as unknown as TabStore,
    sources: { resolve },
    sendToFrame: async () => undefined,
  } as unknown as RouterDeps;
  const listener = createMessageRouter(deps);
  const send = (message: unknown, url: string): Promise<unknown> =>
    new Promise((done) => {
      const handled = listener(message, { id: EXT_ID, tab: { id: 3 } as chrome.tabs.Tab, frameId: 5, url }, done);
      if (!handled) done(undefined);
    });
  return { send, resolve };
}

const MESSAGE = { type: 'RESOLVE_INITIATOR', frames: [{ url: 'https://app.test/a.js', line: 1, col: 2 }], pageUrl: 'https://app.test/' };

describe('RESOLVE_INITIATOR routing', () => {
  it('serves only the overlay panel page of a tab with the overlay open', async () => {
    const { send, resolve } = router();
    expect(await send(MESSAGE, PANEL_URL)).toEqual({ ok: true, frames: [{ ok: false, reason: 'no-map' }] });
    expect(resolve).toHaveBeenCalledWith([{ url: 'https://app.test/a.js', line: 1, col: 2 }], 'https://app.test/');
    expect(await send(MESSAGE, 'https://app.test/')).toMatchObject({ ok: false });
    expect(await send(MESSAGE, `chrome-extension://${EXT_ID}/app.html`)).toMatchObject({ ok: false });
    expect(resolve).toHaveBeenCalledTimes(1);
    const closed = router(false);
    expect(await closed.send(MESSAGE, PANEL_URL)).toMatchObject({ ok: false, error: 'Open the kineReqLens overlay first' });
    expect(await send({ ...MESSAGE, frames: 'x' }, PANEL_URL)).toMatchObject({ ok: false, error: 'Invalid frames' });
  });

  it('validates frame lists', () => {
    expect(sanitizeResolveFrames([{ url: 'https://a/x.js', line: 3.7, col: 1 }])).toEqual([{ url: 'https://a/x.js', line: 3, col: 1 }]);
    expect(sanitizeResolveFrames([{ url: 1, line: 1, col: 1 }])).toBeNull();
    expect(sanitizeResolveFrames([{ url: 'x', line: NaN, col: 1 }])).toBeNull();
    expect(sanitizeResolveFrames(Array.from({ length: 200 }, () => ({ url: 'x', line: 1, col: 1 })))).toBeNull();
    expect(sanitizeResolveFrames(null)).toBeNull();
  });
});
