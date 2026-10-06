/**
 * Screenshot tool (src/ui/screenshot/**): visible area, element (exactly, and with a padding that can be changed
 * afterwards), region, full page (scroll-and-stitch, fixed header hidden after the first tile, scroll restored) and
 * panel-component captures, checked by image size and pixel colors. The tool is opened from the navigation rail (it
 * fills the panel's main view); the E2E build's test hook (`window.__reqlensScreenshot`,
 * src/ui/screenshot/testHook.tsx) reads the captures back.
 */
import type { Frame, Page } from '@playwright/test';
import type { kineReqLens } from './fixtures';
import { expect, test, tid } from './fixtures';

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const TARGET: RGB = [20, 160, 90];
const CHILD: RGB = [250, 200, 0];
const BANDS: RGB[] = [
  [0, 0, 255],
  [0, 200, 0],
  [200, 0, 200],
  [0, 200, 200],
  [120, 120, 120],
];
const BAND_H = 600;
const PAGE_H = BANDS.length * BAND_H;

interface Hook {
  latest(): { id: string; mode: string; width: number; height: number; scale: number; annotations: number; padding?: number } | null;
  pixels(points: Array<[number, number]>): Promise<Array<[number, number, number, number]>>;
}

/** A tall page: a fixed red header, colored bands, a 300×200 target with a child. */
async function buildPage(page: Page): Promise<void> {
  await page.evaluate(
    ({ bands, bandH }) => {
      document.head.insertAdjacentHTML(
        'beforeend',
        `<style>
          html, body { margin: 0; padding: 0; }
          #hdr { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: rgb(255, 0, 0); z-index: 5; }
          .band { height: ${bandH}px; }
          #shot-target { position: absolute; left: 40px; top: 150px; width: 300px; height: 200px; background: rgb(20, 160, 90); }
          #shot-child { position: absolute; left: 20px; top: 20px; width: 100px; height: 50px; background: rgb(250, 200, 0); }
        </style>`,
      );
      document.body.innerHTML =
        '<div id="hdr"></div>' +
        bands.map((c) => `<div class="band" style="background: rgb(${c.join(',')})"></div>`).join('') +
        '<div id="shot-target"><div id="shot-child"></div></div>';
    },
    { bands: BANDS, bandH: BAND_H },
  );
}

async function setup(rl: kineReqLens): Promise<{ frame: Frame; metrics: { cw: number; ch: number; dpr: number } }> {
  await rl.page.goto(`${rl.server.origin}/blank`);
  await buildPage(rl.page);
  await rl.openOverlay();
  const frame = rl.panelFrame();
  const item = rl.ui.locator(`${tid('rl-rail-item')}[data-item="screenshot"]`);
  await item.locator(tid('rl-view-shot')).click();
  await expect(item).toHaveAttribute('data-active', 'true');
  await expect(rl.ui.locator(tid('rl-shot'))).toBeVisible();
  await expect(rl.ui.locator(tid('rl-request-list'))).toBeHidden();
  const metrics = await rl.page.evaluate(() => ({
    cw: document.documentElement.clientWidth,
    ch: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
  }));
  return { frame, metrics };
}

const latest = (frame: Frame) => frame.evaluate(() => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.latest());
const pixels = (frame: Frame, points: Array<[number, number]>) =>
  frame.evaluate((pts) => (window as unknown as { __reqlensScreenshot: Hook }).__reqlensScreenshot.pixels(pts), points);

function expectColor(actual: number[] | undefined, expected: RGB, what: string): void {
  expect(actual, what).toBeDefined();
  const [r, g, b] = actual!;
  const close = Math.abs(r! - expected[0]) <= 8 && Math.abs(g! - expected[1]) <= 8 && Math.abs(b! - expected[2]) <= 8;
  expect(close, `${what}: rgb(${r}, ${g}, ${b}) ≈ rgb(${expected.join(', ')})`).toBe(true);
}

async function chooseMode(rl: kineReqLens, mode: string): Promise<void> {
  const button = rl.ui.locator(`${tid('rl-shot-mode')}[data-mode="${mode}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-checked', 'true');
}

async function captureAndWait(rl: kineReqLens, frame: Frame, mode: string, timeout = 15_000) {
  const before = (await latest(frame))?.id ?? null;
  await rl.ui.locator(tid('rl-shot-capture')).click();
  await expect.poll(async () => (await latest(frame))?.id ?? null, { timeout }).not.toBe(before);
  const shot = (await latest(frame))!;
  expect(shot.mode).toBe(mode);
  await expect(rl.ui.locator(tid('rl-shot-result'))).toHaveAttribute('data-shot-id', shot.id);
  return shot;
}

/** The overlay is shown again after a page capture. */
async function overlayBack(rl: kineReqLens): Promise<void> {
  await expect(rl.host).toHaveCSS('display', 'block');
  await expect(rl.panel).toBeVisible();
  await expect(rl.page.locator('reqlens-shot-layer')).toHaveCount(0);
}

test('visible area: page only (overlay hidden), device-pixel size, annotate + undo, download', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await chooseMode(rl, 'visible');
  const shot = await captureAndWait(rl, frame, 'visible');
  expect(shot.width).toBe(Math.round(metrics.cw * metrics.dpr));
  expect(shot.height).toBe(Math.round(metrics.ch * metrics.dpr));
  await overlayBack(rl);

  const s = metrics.dpr;
  const [header, center, target] = await pixels(frame, [
    [700 * s, 30 * s],
    [720 * s, 450 * s],
    [100 * s, 300 * s],
  ]);
  expectColor(header, RED, 'fixed header');
  // The overlay panel covers the center of the viewport while it is open: the capture shows the page there.
  expectColor(center, BANDS[0]!, 'page under the overlay');
  expectColor(target, TARGET, 'target element');

  // Annotate: a rectangle, then undo.
  const result = rl.ui.locator(tid('rl-shot-result'));
  await rl.ui.locator(`${tid('rl-shot-tool')}[data-tool="rect"]`).click();
  const box = (await rl.ui.locator(tid('rl-shot-canvas')).boundingBox())!;
  await rl.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await rl.page.mouse.down();
  await rl.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 5 });
  await rl.page.mouse.up();
  await expect(result).toHaveAttribute('data-annotations', '1');
  await rl.ui.locator(tid('rl-shot-undo')).click();
  await expect(result).toHaveAttribute('data-annotations', '0');

  // Zoom: fit → 100%.
  await rl.ui.locator(tid('rl-shot-zoom')).click();
  await expect(rl.ui.locator(tid('rl-shot-zoom'))).toHaveAttribute('data-zoom', '1');

  // Copy: a PNG ClipboardItem (recorded in the panel frame; the system clipboard is never touched).
  await frame.evaluate(() => {
    const w = window as unknown as { __copied: Array<{ types: string[]; size: number }> };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          for (const item of items) w.__copied.push({ types: [...item.types], size: (await item.getType('image/png')).size });
        },
      },
    });
  });
  await rl.ui.locator(tid('rl-shot-copy')).click();
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { __copied: Array<{ types: string[]; size: number }> }).__copied))
    .toEqual([{ types: ['image/png'], size: expect.any(Number) }]);
  await expect(rl.toast('Screenshot copied')).toBeVisible();

  const download = rl.page.waitForEvent('download');
  await rl.ui.locator(tid('rl-shot-download')).click();
  expect((await download).suggestedFilename()).toMatch(/^kinereqlens-127\.0\.0\.1-\d{8}-\d{6}\.png$/);

  await expect(rl.ui.locator(tid('rl-shot-recent-item'))).toHaveCount(1);
});

/** The Element mode's default padding (settings.shotPadding). */
async function setDefaultPadding(rl: kineReqLens, padding: number): Promise<void> {
  const field = rl.ui.locator(tid('rl-shot-default-padding'));
  await field.fill(String(padding));
  await field.press('Enter');
  await expect.poll(async () => (await rl.storedSettings()).shotPadding).toBe(padding);
}

test('element: hover label, ↑/↓ parent/child, click captures exactly the element (padding 0)', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await chooseMode(rl, 'element');
  await expect(rl.ui.locator(tid('rl-shot-default-padding'))).toHaveValue('50');
  await setDefaultPadding(rl, 0);
  await rl.ui.locator(tid('rl-shot-capture')).click();
  const layer = rl.page.locator('reqlens-shot-layer');
  await expect(layer).toHaveCount(1);
  await expect(rl.host).toHaveCSS('display', 'none');

  const label = rl.page.locator('reqlens-shot-layer .label');
  await rl.page.mouse.move(300, 300);
  await expect(label).toHaveText('div#shot-target  300 × 200');
  await rl.page.keyboard.press('ArrowUp');
  await expect(label).toHaveText(/^body {2}\d+ × \d+$/);
  await rl.page.keyboard.press('ArrowDown');
  await expect(label).toHaveText('div#shot-target  300 × 200');
  await rl.page.keyboard.press('ArrowDown');
  await expect(label).toHaveText('div#shot-child  100 × 50');
  await rl.page.mouse.wheel(0, -100);
  await expect(label).toHaveText('div#shot-target  300 × 200');

  const before = (await latest(frame))?.id ?? null;
  await rl.page.mouse.click(300, 300);
  await expect.poll(async () => (await latest(frame))?.id ?? null).not.toBe(before);
  const shot = (await latest(frame))!;
  expect(shot.mode).toBe('element');
  expect(shot.width).toBe(Math.round(300 * metrics.dpr));
  expect(shot.height).toBe(Math.round(200 * metrics.dpr));
  await overlayBack(rl);
  const s = metrics.dpr;
  const [body, child] = await pixels(frame, [
    [250 * s, 150 * s],
    [50 * s, 40 * s],
  ]);
  expectColor(body, TARGET, 'element body');
  expectColor(child, CHILD, 'element child');
  await expect(rl.ui.locator(tid('rl-shot-meta'))).toContainText('div#shot-target');
});

test('element pick keeps the padding around the element; the padding is changed afterwards without a new capture', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await chooseMode(rl, 'element');
  await setDefaultPadding(rl, 20);
  await rl.ui.locator(tid('rl-shot-capture')).click();
  await expect(rl.page.locator('reqlens-shot-layer')).toHaveCount(1);
  await rl.page.mouse.move(300, 300);
  await expect(rl.page.locator('reqlens-shot-layer .label')).toHaveText('div#shot-target  300 × 200');
  const before = (await latest(frame))?.id ?? null;
  await rl.page.mouse.click(300, 300);
  await expect.poll(async () => (await latest(frame))?.id ?? null).not.toBe(before);
  const s = metrics.dpr;
  const shot = (await latest(frame))!;
  expect(shot.mode).toBe('element');
  expect(shot.padding).toBe(20);
  expect(shot.width).toBe(Math.round(340 * s));
  expect(shot.height).toBe(Math.round(240 * s));
  await overlayBack(rl);
  const [around, body] = await pixels(frame, [
    [8 * s, 8 * s],
    [170 * s, 120 * s],
  ]);
  expectColor(around, BANDS[0]!, 'the padding (the page around the element)');
  expectColor(body, TARGET, 'element body');

  // The padding control: 0 shows exactly the element, 60 more of the page (both from the same capture).
  const result = rl.ui.locator(tid('rl-shot-result'));
  const input = rl.ui.locator(tid('rl-shot-padding-input'));
  await input.fill('0');
  await input.press('Enter');
  await expect(result).toHaveAttribute('data-width', String(Math.round(300 * s)));
  await expect(result).toHaveAttribute('data-height', String(Math.round(200 * s)));
  // 60 px: clipped at the left page edge (the element is 40 px from it).
  await input.fill('60');
  await input.press('Enter');
  await expect(result).toHaveAttribute('data-width', String(Math.round(400 * s)));
  await expect(result).toHaveAttribute('data-height', String(Math.round(320 * s)));
  expect((await latest(frame))!.id).toBe(shot.id);
  await expect(rl.ui.locator(tid('rl-shot-recent-item'))).toHaveCount(1);
  await overlayBack(rl);
});

test('region drag captures the rectangle; Esc cancels and restores the overlay', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await chooseMode(rl, 'region');
  await rl.ui.locator(tid('rl-shot-capture')).click();
  await expect(rl.page.locator('reqlens-shot-layer')).toHaveCount(1);
  await rl.page.mouse.move(500, 100);
  await rl.page.mouse.down();
  await rl.page.mouse.move(600, 180, { steps: 3 });
  await rl.page.mouse.move(700, 250, { steps: 3 });
  await expect(rl.page.locator('reqlens-shot-layer .label')).toHaveText('200 × 150');
  await rl.page.mouse.up();
  await expect.poll(async () => (await latest(frame))?.mode ?? null).toBe('region');
  const shot = (await latest(frame))!;
  expect(shot.width).toBe(Math.round(200 * metrics.dpr));
  expect(shot.height).toBe(Math.round(150 * metrics.dpr));
  await overlayBack(rl);

  // Esc on the page cancels the pick.
  await chooseMode(rl, 'element');
  await rl.ui.locator(tid('rl-shot-capture')).click();
  await expect(rl.page.locator('reqlens-shot-layer')).toHaveCount(1);
  await rl.page.keyboard.press('Escape');
  await overlayBack(rl);
  await expect(rl.ui.locator(tid('rl-shot-status'))).toContainText('Cancelled');
  expect((await latest(frame))!.id).toBe(shot.id);
});

test('full page: scroll-and-stitch to the document height, fixed header only once, scroll restored', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await rl.page.evaluate(() => window.scrollTo(0, 400));
  await chooseMode(rl, 'fullpage');
  const shot = await captureAndWait(rl, frame, 'fullpage', 30_000);
  expect(shot.width).toBe(Math.round(metrics.cw * metrics.dpr));
  expect(shot.height).toBe(Math.round(PAGE_H * metrics.dpr));
  await overlayBack(rl);

  const s = metrics.dpr;
  const points: Array<[number, number]> = BANDS.map((_, i) => [720 * s, (i * BAND_H + BAND_H / 2) * s]);
  // Header in the first tile; the second tile starts at the viewport height, where the header would be again.
  points.push([720 * s, 30 * s], [720 * s, (metrics.ch + 30) * s], [100 * s, 300 * s]);
  const colors = await pixels(frame, points);
  BANDS.forEach((band, i) => expectColor(colors[i], band, `band ${i}`));
  expectColor(colors[BANDS.length], RED, 'header in the first tile');
  expectColor(colors[BANDS.length + 1], BANDS[1]!, 'no header in the second tile');
  expectColor(colors[BANDS.length + 2], TARGET, 'target element');

  // The page is as it was.
  expect(await rl.page.evaluate(() => window.scrollY)).toBe(400);
  expect(await rl.page.evaluate(() => getComputedStyle(document.getElementById('hdr')!).visibility)).toBe('visible');
  expect(await rl.page.evaluate(() => document.documentElement.style.cssText)).toBe('');
});

test('panel component: crops the visible tab to a kineReqLens element (overlay shown)', async ({ rl }) => {
  const { frame, metrics } = await setup(rl);
  await chooseMode(rl, 'component');
  await rl.ui.locator(tid('rl-shot-component')).selectOption('panel');
  const box = (await rl.panel.boundingBox())!;
  const shot = await captureAndWait(rl, frame, 'component');
  const right = Math.min(metrics.cw, box.x + box.width);
  const bottom = Math.min(metrics.ch, box.y + box.height);
  expect(Math.abs(shot.width - (right - Math.max(0, box.x)) * metrics.dpr)).toBeLessThanOrEqual(2);
  expect(Math.abs(shot.height - (bottom - Math.max(0, box.y)) * metrics.dpr)).toBeLessThanOrEqual(2);
  // The panel itself is in the picture, not the page behind it (the page's band is pure blue).
  const [inside] = await pixels(frame, [[Math.round(shot.width / 2), Math.round(12 * metrics.dpr)]]);
  const [r, g, b] = inside!;
  expect(Math.abs(r! - 0) <= 8 && Math.abs(g! - 0) <= 8 && Math.abs(b! - 255) <= 8, `panel header pixel rgb(${r}, ${g}, ${b})`).toBe(false);
  await expect(rl.panel).toBeVisible();
});
