/**
 * Element captures with a padding (docs/ARCHITECTURE.md "Screenshot tool"): a catalog page fetches /api/catalog and
 * renders its values in absolutely positioned elements.
 *
 *  - a response property's camera action captures the element showing that value with the default padding and opens
 *    the Screenshot view (image = element + 2 × padding, × DPR); the padding control re-crops without a new capture
 *    within the captured margin and captures again past it; the overlay is always shown again;
 *  - the MCP handlers (runShotCommand / runFindCommand, through the E2E test hook): locators by label, by a value as
 *    the page formats it, by request + JSON path, the values a response shows, a far element (scrolled to and back),
 *    a tall one (stitched), `open`, and `highlight` (overlay hidden while the element is shown, back on Esc).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Frame } from '@playwright/test';
import type { kineReqLens } from './fixtures';
import { expect, test, tid } from './fixtures';

const CATALOG = { product: { name: 'Aurora desk lamp', price: 1258291, sku: 'AUR-0042-XL' } };

const PAGE = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Catalog</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 16px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111; background: rgb(250, 250, 250); }
  #status { position: absolute; left: 10px; top: 10px; }
  #name { position: absolute; left: 200px; top: 300px; width: 240px; height: 40px; margin: 0; overflow: hidden;
    background: rgb(20, 160, 90); color: #fff; font-size: 16px; line-height: 40px; }
  #price { position: absolute; left: 200px; top: 420px; width: 160px; height: 30px; background: rgb(250, 200, 0); }
  #close { position: absolute; left: 600px; top: 300px; width: 32px; height: 32px; }
  #deep { position: absolute; left: 300px; top: 2400px; width: 200px; height: 100px; background: rgb(0, 0, 255); color: #fff; }
  #tall { position: absolute; left: 700px; top: 600px; width: 300px; height: 1400px; background: rgb(200, 0, 200); }
  .spacer { height: 3200px; }
</style></head><body>
<div id="status">loading</div>
<h1 id="name">…</h1>
<div id="price">…</div>
<button id="close" aria-label="Close dialog">×</button>
<div id="deep">Deep value</div>
<div id="tall">Tall block</div>
<div class="spacer"></div>
<script>
(async () => {
  const data = await (await fetch('/api/catalog')).json();
  document.getElementById('name').textContent = data.product.name;
  document.getElementById('price').textContent = data.product.price.toLocaleString('en-US');
  document.getElementById('status').textContent = 'ready';
})();
</script></body></html>`;

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

async function startFixture(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/catalog') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
    } else if (url.pathname === '/api/catalog') {
      const body = JSON.stringify(CATALOG);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
      res.end(body);
    } else {
      res.writeHead(url.pathname === '/favicon.ico' ? 204 : 404);
      res.end();
    }
  });
  server.keepAliveTimeout = 500;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture?.close();
});

interface ShotSummary {
  image: { width: number; height: number; mimeType: string; bytes: number };
  preview: { width: number; height: number };
  area: { x: number; y: number; width: number; height: number };
  padding: number;
  element?: { tag: string; selector: string; text: string; visible: boolean };
  matches?: number;
  matchIndex?: number;
  notes?: string[];
}

interface FindSummary {
  matches: Array<{ tag: string; selector: string; text: string; visible: boolean; rect: { x: number; y: number; width: number; height: number } }>;
  total: number;
  properties?: Array<{ path: string; value: string; matches: number; visible?: number; as?: string }>;
  highlighted?: number;
  notes?: string[];
}

interface Hook {
  latest(): { id: string; mode: string; width: number; height: number; padding?: number; limit?: number; count: number } | null;
  pixels(points: Array<[number, number]>): Promise<Array<[number, number, number, number]>>;
  shot(args: Record<string, unknown>): Promise<ShotSummary>;
  find(args: Record<string, unknown>): Promise<FindSummary>;
}

const hookShot = (frame: Frame, args: Record<string, unknown>) => frame.evaluate((a) => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.shot(a), args);
const hookFind = (frame: Frame, args: Record<string, unknown>) => frame.evaluate((a) => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.find(a), args);
const latest = (frame: Frame) => frame.evaluate(() => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.latest());
const pixels = (frame: Frame, points: Array<[number, number]>) =>
  frame.evaluate((pts) => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.pixels(pts), points);

/** Load the catalog with the overlay open from document_start (the /api/catalog response is captured). */
async function openCatalog(rl: kineReqLens): Promise<void> {
  await rl.page.goto(`${fixture.origin}/catalog`);
  await rl.openOverlay();
  await rl.page.reload();
  await expect(rl.page.locator('#status')).toHaveText('ready', { timeout: 15_000 });
  await expect(rl.panel).toBeVisible();
  await expect(rl.row('/api/catalog')).toHaveCount(1);
}

/** Count the panel's CAPTURE_VISIBLE_TAB requests from now on (one per visible-tab capture). */
async function countCaptures(frame: Frame): Promise<() => Promise<number>> {
  await frame.evaluate(() => {
    const w = window as unknown as { __captures: number };
    w.__captures = 0;
    const runtime = chrome.runtime as unknown as { sendMessage: (...args: unknown[]) => unknown };
    const original = runtime.sendMessage.bind(chrome.runtime);
    runtime.sendMessage = (message: unknown, ...rest: unknown[]) => {
      if ((message as { type?: string } | null)?.type === 'CAPTURE_VISIBLE_TAB') w.__captures++;
      return original(message, ...rest);
    };
  });
  return () => frame.evaluate(() => (window as unknown as { __captures: number }).__captures);
}

/** The overlay is shown again (never left hidden by a capture or a highlight). */
async function overlayBack(rl: kineReqLens): Promise<void> {
  await expect(rl.host).toHaveCSS('display', 'block');
  await expect(rl.panel).toBeVisible();
  await expect(rl.page.locator('reqlens-shot-layer')).toHaveCount(0);
}

type RGB = [number, number, number];

function expectColor(actual: number[] | undefined, expected: RGB, what: string): void {
  expect(actual, what).toBeDefined();
  const [r, g, b] = actual!;
  const close = Math.abs(r! - expected[0]) <= 8 && Math.abs(g! - expected[1]) <= 8 && Math.abs(b! - expected[2]) <= 8;
  expect(close, `${what}: rgb(${r}, ${g}, ${b}) ≈ rgb(${expected.join(', ')})`).toBe(true);
}

test('a response property\'s camera action captures its element with padding; the padding re-crops, then captures again', async ({ rl }) => {
  await openCatalog(rl);
  const frame = rl.panelFrame();
  const dpr = await rl.page.evaluate(() => window.devicePixelRatio);
  const px = (css: number) => String(Math.round(css * dpr));

  await rl.select('/api/catalog');
  await rl.ui.locator(tid('rl-original-tab')).click();
  const view = rl.ui.locator(tid('rl-original-view'));
  const row = view.locator('.rl-jv__row[data-path="product.name"]');
  await expect(row.locator(tid('rl-find-icon'))).toHaveAttribute('data-state', 'visible');
  // Not on the page: no camera action.
  await view.locator('.rl-jv__row[data-path="product.sku"]').hover();
  await expect(view.locator(`.rl-jv__row[data-path="product.sku"] ${tid('rl-find-capture')}`)).toHaveCount(0);

  const captures = await countCaptures(frame);
  await row.hover();
  await row.locator(tid('rl-find-capture')).click();

  // The Screenshot view opens with the capture: element (240 × 40) + 2 × 50.
  const result = rl.ui.locator(tid('rl-shot-result'));
  await expect(rl.ui.locator(tid('rl-shot-view'))).toBeVisible();
  await expect(result).toHaveAttribute('data-width', px(340));
  await expect(result).toHaveAttribute('data-height', px(140));
  await expect(result).toHaveAttribute('data-mode', 'element');
  const padding = rl.ui.locator(tid('rl-shot-padding'));
  await expect(padding).toHaveAttribute('data-padding', '50');
  // Captured: 250 px around it (padding + 200 spare), the left side up to the page edge.
  await expect(padding).toHaveAttribute('data-limit', '250');
  await expect(rl.ui.locator(tid('rl-shot-meta'))).toContainText('product.name');
  await overlayBack(rl);
  expect(await captures()).toBe(1);
  const [inside, around] = await pixels(frame, [
    [170 * dpr, 70 * dpr],
    [10 * dpr, 10 * dpr],
  ]);
  expectColor(inside, [20, 160, 90], 'the element');
  expectColor(around, [250, 250, 250], 'the padding (page background)');

  // Smaller padding: re-cropped, no new capture.
  const input = rl.ui.locator(tid('rl-shot-padding-input'));
  await input.fill('20');
  await input.press('Enter');
  await expect(padding).toHaveAttribute('data-padding', '20');
  await expect(result).toHaveAttribute('data-width', px(280));
  await expect(result).toHaveAttribute('data-height', px(80));
  // The slider, within the captured margin.
  await rl.ui.locator(tid('rl-shot-padding-range')).evaluate((el: HTMLInputElement) => {
    el.value = '150';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(padding).toHaveAttribute('data-padding', '150');
  await expect(result).toHaveAttribute('data-width', px(540));
  await expect(result).toHaveAttribute('data-height', px(340));
  expect(await captures()).toBe(1);
  expect((await latest(frame))!.count).toBe(1);

  // Past the captured margin: the element is captured again (same capture in the strip), clipped at the page edge.
  await input.fill('300');
  await input.press('Enter');
  await expect(padding).toHaveAttribute('data-padding', '300');
  await expect(result).toHaveAttribute('data-width', px(740));
  await expect(result).toHaveAttribute('data-height', px(640));
  await expect(padding).toHaveAttribute('data-state', 'idle');
  expect(await captures()).toBe(2);
  expect((await latest(frame))!.count).toBe(1);
  await overlayBack(rl);
});

test('MCP handlers: locators, values shown, far / tall elements, open, highlight', async ({ rl }) => {
  await openCatalog(rl);
  const frame = rl.panelFrame();
  const dpr = await rl.page.evaluate(() => window.devicePixelRatio);
  const entryId = (await rl.row('/api/catalog').getAttribute('data-entry-id'))!;

  // A label (aria-label), contains + case-insensitive; exact.
  const close = await hookFind(frame, { text: 'close DIALOG' });
  expect(close.total).toBe(1);
  expect(close.matches[0]).toMatchObject({ tag: 'button', selector: '#close', visible: true });
  expect((await hookFind(frame, { text: 'close', exact: true })).total).toBe(0);
  // Visible text, smallest element.
  const name = await hookFind(frame, { text: 'aurora desk' });
  expect(name.matches.map((m) => m.selector)).toEqual(['#name']);
  // A response value as the page formats it (1258291 → "1,258,291").
  const price = await hookFind(frame, { value: '1258291' });
  expect(price.matches[0]).toMatchObject({ selector: '#price', text: '1,258,291' });
  // The values of the response the page shows.
  const props = await hookFind(frame, { requestId: entryId });
  expect(props.properties).toEqual([
    { path: 'product.name', value: 'Aurora desk lamp', matches: 1, visible: 1 },
    { path: 'product.price', value: '1258291', matches: 1, visible: 1, as: '1,258,291' },
  ]);
  expect(props.total).toBe(2);

  // A far element: scrolled to, captured, the page put back.
  await rl.page.evaluate(() => window.scrollTo(0, 120));
  const deep = await hookShot(frame, { text: 'Deep value', padding: 30 });
  expect([deep.image.width, deep.image.height]).toEqual([Math.round(260 * dpr), Math.round(160 * dpr)]);
  expect(deep.area).toEqual({ x: 270, y: 2370, width: 260, height: 160 });
  expect(deep).toMatchObject({ padding: 30, matches: 1, matchIndex: 0, element: { selector: '#deep' } });
  expect(await rl.page.evaluate(() => window.scrollY)).toBe(120);
  await overlayBack(rl);
  const [blue] = await pixels(frame, [[130 * dpr, 80 * dpr]]);
  expectColor(blue, [0, 0, 255], 'the far element');

  // Taller than the viewport: stitched from tiles.
  const tall = await hookShot(frame, { selector: '#tall', padding: 10 });
  expect([tall.image.width, tall.image.height]).toEqual([Math.round(320 * dpr), Math.round(1420 * dpr)]);
  expect(tall.notes?.some((n) => /^stitched from \d+ tiles$/.test(n))).toBe(true);
  expect(tall.preview.height).toBeLessThanOrEqual(1568);
  const [top, bottom] = await pixels(frame, [
    [160 * dpr, 30 * dpr],
    [160 * dpr, 1390 * dpr],
  ]);
  expectColor(top, [200, 0, 200], 'top of the tall element');
  expectColor(bottom, [200, 0, 200], 'bottom of the tall element');
  expect(await rl.page.evaluate(() => window.scrollY)).toBe(120);
  await overlayBack(rl);

  // Request + JSON path; `open` shows it in the Screenshot view.
  const byPath = await hookShot(frame, { requestId: entryId, path: 'product.name', padding: 0, open: true });
  expect(byPath.element).toMatchObject({ selector: '#name', text: 'Aurora desk lamp' });
  expect([byPath.image.width, byPath.image.height]).toEqual([Math.round(240 * dpr), Math.round(40 * dpr)]);
  await expect(rl.ui.locator(tid('rl-shot-view'))).toBeVisible();
  await expect(rl.ui.locator(tid('rl-shot-result'))).toHaveAttribute('data-shot-id', (await latest(frame))!.id);
  await overlayBack(rl);

  // Highlight: the overlay steps aside while the element is shown; Esc brings it back.
  const shown = await hookFind(frame, { selector: '#price', highlight: true });
  expect(shown.highlighted).toBe(0);
  await expect(rl.host).toBeHidden();
  await expect(rl.page.locator(tid('rl-find-highlight'))).toBeVisible();
  await expect(rl.page.locator(tid('rl-find-bar-path'))).toHaveAttribute('data-text', 'the selector “#price”');
  await rl.page.keyboard.press('Escape');
  await expect(rl.page.locator(tid('rl-find-highlight'))).toHaveCount(0);
  await overlayBack(rl);
});
