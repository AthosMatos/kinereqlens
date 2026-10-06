/**
 * Capture across stream / frame / navigation lifecycles: cancelled streams release their connection, about:blank
 * frames merge with webRequest, navigations that never commit, unload beacons, closing and reopening, and the
 * hook staying invisible to the page (toString across realms, Math.random).
 */
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

async function openBlank(rl: kineReqLens, query = ''): Promise<void> {
  // These tests follow image / document rows too: list every type (the default is Fetch/XHR only).
  await rl.patchSettings({ listTypes: [] });
  await rl.page.goto(`${rl.server.origin}/blank${query}`);
  await expect(rl.page.locator('#status')).toHaveText('ready');
}

/** Status cell state of a row: 'pending' | 'done' | 'failed' | 'aborted'. */
async function rowState(rl: kineReqLens, fragment: string): Promise<string> {
  const row = rl.row(fragment).first();
  if ((await row.locator('.rl-spinner').count()) > 0) return 'pending';
  if ((await row.locator('.rl-status--error').count()) > 0) return 'failed';
  if ((await row.locator('.rl-status--unknown').count()) > 0) return 'aborted';
  return 'done';
}

test.describe('capture lifecycle', () => {
  test('streams the page cancels are released at once, and closing the overlay releases the others', async ({ rl }) => {
    await openBlank(rl);
    await rl.openOverlay();
    const durations = await rl.page.evaluate(async () => {
      const out: number[] = [];
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        const res = await fetch(`/api/stream?id=r${i}`);
        const reader = res.body!.getReader();
        await reader.read();
        await reader.cancel();
        out.push(performance.now() - t0);
      }
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        const res = await fetch(`/api/stream?id=b${i}`);
        await res.body!.cancel();
        out.push(performance.now() - t0);
      }
      return out;
    });
    // HTTP/1.1 allows 6 connections per host: a held connection would stall the 7th fetch for a minute.
    expect(Math.max(...durations)).toBeLessThan(1000);
    const streams = rl.server.streams;
    const ids = [...Array(8).keys()].flatMap((i) => [`r${i}`, `b${i}`]);
    await expect.poll(() => ids.every((id) => streams.get(id)?.closed !== undefined), { timeout: 5000 }).toBe(true);
    for (const id of ids) expect(streams.get(id)!.closed! - streams.get(id)!.opened).toBeLessThan(1500);
    // The captures end with what was read.
    await expect(rl.row('/api/stream?id=r0')).toHaveCount(1);
    await expect.poll(() => rowState(rl, '/api/stream?id=r0')).toBe('done');

    // A cancel that propagates through pipeThrough is invisible to kineReqLens: its read window ends it...
    await rl.page.evaluate(() => {
      void (async () => {
        const res = await fetch('/api/stream?id=pipe-window');
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        await reader.read();
        await reader.cancel();
      })();
    });
    await expect.poll(() => streams.get('pipe-window')?.closed !== undefined, { timeout: 9000 }).toBe(true);
    const windowed = streams.get('pipe-window')!;
    expect(windowed.closed! - windowed.opened).toBeLessThan(7500);

    // ...and closing the overlay stops every read right away.
    await rl.page.evaluate(() => {
      void (async () => {
        const res = await fetch('/api/stream?id=pipe-close');
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        await reader.read();
        await reader.cancel();
      })();
    });
    await expect.poll(() => streams.has('pipe-close')).toBe(true);
    await rl.page.waitForTimeout(300);
    const closedAt = Date.now();
    await rl.toggle();
    await expect(rl.panel).toBeHidden();
    await expect.poll(() => streams.get('pipe-close')?.closed !== undefined, { timeout: 3000 }).toBe(true);
    expect(streams.get('pipe-close')!.closed! - closedAt).toBeLessThan(1500);
  });

  test('a request from an about:blank iframe is one row, merged with its webRequest data', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(async () => {
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      await frame.contentWindow!.fetch('/api/echo/blank-frame?x=1', { method: 'POST', body: 'from the frame' });
    });
    const row = rl.row('/api/echo/blank-frame');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-entry-id', /^h:/);
    // The webRequest event was merged (it is not listed on its own) and its headers are shown.
    await rl.page.waitForTimeout(600);
    await expect(row).toHaveCount(1);
    await rl.select('/api/echo/blank-frame');
    await expect(rl.ui.locator('.rl-ed-wire__toggle')).toContainText('Headers sent by the browser');
  });

  test('a navigation that turns into a download neither loses nor delays the current page’s requests', async ({ rl }) => {
    await openBlank(rl);
    await rl.openOverlay();
    await rl.page.evaluate(() => {
      const img = new Image();
      img.src = '/api/slowimg?ms=1200&early=1';
      document.body.appendChild(img);
      const a = document.createElement('a');
      a.id = 'dl';
      a.href = '/api/download';
      document.body.appendChild(a);
    });
    await rl.page.waitForTimeout(400);
    const download = rl.page.waitForEvent('download');
    await rl.page.evaluate(() => document.getElementById('dl')!.click());
    await download;
    // The image that was in flight when the navigation started completes in the list (no 10 s hold).
    await expect(rl.row('early=1')).toHaveCount(1, { timeout: 4000 });
    await expect.poll(() => rowState(rl, 'early=1'), { timeout: 4000 }).toBe('done');
    // Requests made afterwards show up right away, the hook capture merged with its webRequest data.
    const started = Date.now();
    await rl.page.evaluate(async () => {
      await fetch('/api/echo/after-download');
      const img = new Image();
      img.src = '/api/slowimg?ms=5&late=1';
      document.body.appendChild(img);
    });
    await expect(rl.row('late=1')).toHaveCount(1, { timeout: 4000 });
    expect(Date.now() - started).toBeLessThan(4000);
    await expect(rl.row('/api/echo/after-download')).toHaveCount(1);
  });

  test('unload beacons of the previous page are not listed as the next page’s requests', async ({ rl }) => {
    await openBlank(rl, '?page=a');
    await rl.openOverlay();
    const registerUnload = () =>
      rl.page.evaluate(() => {
        addEventListener('pagehide', () => {
          navigator.sendBeacon('/api/echo/a-unload-beacon', 'bye');
          void fetch('/api/echo/a-unload-keepalive', { method: 'POST', body: 'bye', keepalive: true });
        });
      });
    await registerUnload();
    await openBlank(rl, '?page=b');
    await expect.poll(() => rl.server.requestsTo('/api/echo/a-unload-beacon').length).toBe(1);
    await rl.page.waitForTimeout(800);
    await expect(rl.row('a-unload')).toHaveCount(0);

    // With preserve log they are kept, as entries of the previous page.
    await rl.ui.locator(tid('rl-preserve-toggle')).click();
    await registerUnload();
    await openBlank(rl, '?page=c');
    await expect.poll(() => rl.server.requestsTo('/api/echo/a-unload-beacon').length).toBe(2);
    await rl.page.waitForTimeout(800);
    const own = rl.ui.locator(`${tid('rl-request-row')}[data-url*="a-unload"]:not(.rl-req-row--restored)`);
    await expect(own).toHaveCount(0);
  });

  test('closing and reopening the overlay never leaves requests pending forever', async ({ rl }) => {
    await openBlank(rl);
    await rl.openOverlay();
    await rl.page.evaluate(() => {
      const img = new Image();
      img.src = '/api/slowimg?ms=1500&reopen=1';
      document.body.appendChild(img);
      void fetch('/api/slow?ms=1500&reopen=1');
    });
    await expect(rl.row('slowimg?ms=1500&reopen=1')).toHaveCount(1);
    await rl.toggle();
    await expect(rl.panel).toBeHidden();
    await rl.page.waitForTimeout(300);
    await rl.toggle();
    await expect(rl.panel).toBeVisible();
    await rl.page.waitForTimeout(2500);
    expect(await rowState(rl, 'slowimg?ms=1500&reopen=1')).not.toBe('pending');
    expect(await rowState(rl, '/api/slow?ms=1500&reopen=1')).toBe('done');
    await rl.select('slowimg?ms=1500&reopen=1');
    await expect(rl.ui.locator(tid('rl-detail'))).toBeVisible();
  });

  test('the hook is invisible to the page: native toString across realms, Math.random untouched', async ({ rl }) => {
    await openBlank(rl);
    const views = await rl.page.evaluate(() => {
      const frame = document.body.appendChild(document.createElement('iframe'));
      const crossToString = (frame.contentWindow as unknown as typeof globalThis).Function.prototype.toString;
      const topToString = Function.prototype.toString;
      const show = (fn: unknown) => crossToString.call(fn);
      return {
        fetch: show(window.fetch),
        open: show(XMLHttpRequest.prototype.open),
        send: show(XMLHttpRequest.prototype.send),
        setRequestHeader: show(XMLHttpRequest.prototype.setRequestHeader),
        sendBeacon: show(navigator.sendBeacon),
        toString: show(Function.prototype.toString),
        getReader: show(ReadableStream.prototype.getReader),
        cancel: show(ReadableStream.prototype.cancel),
        readerCancel: show(ReadableStreamDefaultReader.prototype.cancel),
        reverse: topToString.call((frame.contentWindow as unknown as { fetch: unknown }).fetch),
        sameRealm: topToString.call(window.fetch),
      };
    });
    expect(views).toEqual({
      fetch: 'function fetch() { [native code] }',
      open: 'function open() { [native code] }',
      send: 'function send() { [native code] }',
      setRequestHeader: 'function setRequestHeader() { [native code] }',
      sendBeacon: 'function sendBeacon() { [native code] }',
      toString: 'function toString() { [native code] }',
      getReader: 'function getReader() { [native code] }',
      cancel: 'function cancel() { [native code] }',
      readerCancel: 'function cancel() { [native code] }',
      reverse: 'function fetch() { [native code] }',
      sameRealm: 'function fetch() { [native code] }',
    });

    // A page that seeds Math.random and fetches while parsing sees no extra calls (overlay closed and open).
    const rng = async () => {
      await rl.page.goto(`${rl.server.origin}/rng`);
      await expect(rl.page.locator('#status')).toHaveText('ready');
      await rl.page.waitForTimeout(300);
      return rl.page.evaluate(() => (window as unknown as { __rngCalls: number }).__rngCalls);
    };
    expect(await rng()).toBe(0);
    await rl.openOverlay();
    expect(await rng()).toBe(0);
    await expect(rl.row('/api/echo/rng-parse?a=1')).toHaveCount(1);
  });
});
