/**
 * Find in page (docs/ARCHITECTURE.md §13). A files page (served below) fetches /api/files and renders the names as list
 * items (the newest one also in a header), the sizes as pt-BR numbers ("1.258.291 bytes"), the dates with
 * toLocaleDateString('pt-BR') and links whose href holds the file id; one file is rendered later (on demand, 1.5 s after
 * the test asks for it). A WebSocket echo puts a value from a message on the page.
 *
 *  - locate icons on the rendered values (name, size, date; the id as attribute-only), none on values the page does not
 *    show; the late file gets its icon after the page changes (MutationObserver re-scan);
 *  - clicking an icon hides the overlay, highlights the match (box ≈ element), the mini-bar counts and cycles the
 *    matches, Esc restores the overlay and focuses the JSON node; captured text never becomes page text;
 *  - the on / off toggle (persisted);
 *  - the WebSocket message detail;
 *  - "Where does this come from?": pick a rendered name → the /api/files request with [1].name → reveal.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import type { kineReqLens } from './fixtures';
import { SCREENSHOT_DIR, expect, test, tid } from './fixtures';
import type { WsTestServer } from './ws-server';
import { startWsServer } from './ws-server';

const FILES = [
  {
    id: '3f2a6c1e-8b4d-4e7a-9c21-5d6e7f809a1b',
    name: 'quarterly-report-2024.pdf',
    size: 1258291,
    uploadedAt: '2024-03-15T14:30:00Z',
    url: 'https://cdn.example.test/blob/7f1c2d',
    checksum: 'sha256:9c1f0a7e44d2',
    owner: { email: 'ana.souza@example.test' },
  },
  {
    id: 'b7e4d2a9-1c3f-4b8e-a5d6-0f9e8d7c6b5a',
    name: 'design-mockups-final.fig',
    size: 48213504,
    uploadedAt: '2024-02-02T12:15:00Z',
    url: 'https://cdn.example.test/blob/a93be1',
    checksum: 'sha256:51d0e3bb7a90',
    owner: { email: 'joao.lima@example.test' },
  },
  {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    name: 'meeting-notes-q1.txt',
    size: 18234,
    uploadedAt: '2024-01-20T16:45:00Z',
    url: 'https://cdn.example.test/blob/0d4e77',
    checksum: 'sha256:aa83c1d9e2f4',
    owner: { email: 'bia.costa@example.test' },
  },
  {
    id: 'd9c8b7a6-5f4e-4d3c-8b1a-0e9f8d7c6b5a',
    name: 'late-arrival-budget.xlsx',
    size: 734003,
    uploadedAt: '2024-03-18T11:00:00Z',
    url: 'https://cdn.example.test/blob/f00d42',
    checksum: 'sha256:0f9e8d7c6b5a',
    owner: { email: 'rui.alves@example.test' },
  },
];

const LIVE_FILE = 'weekly-sync-agenda.docx';

function filesPageHtml(wsUrl: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Shared files</title>
<style>
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1f2124; background: #f6f7f9; }
  main { box-sizing: border-box; max-width: 600px; margin: 0; padding: 28px 32px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .latest { margin: 0 0 18px; color: #4d4d4f; }
  ul { margin: 0; padding: 0; list-style: none; background: #fff; border: 1px solid #e4e6eb; border-radius: 10px; }
  li.file { display: flex; gap: 14px; align-items: baseline; padding: 11px 14px; border-bottom: 1px solid #eef0f3; }
  li.file:last-child { border-bottom: 0; }
  .file-link { flex: 1 1 auto; min-width: 0; color: #0230bb; text-decoration: none; }
  .file-name { font-weight: 600; }
  .file-size, .file-date { color: #4d4d4f; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .live { margin-top: 18px; padding: 10px 14px; border-radius: 10px; background: #e9eeff; }
  #status { margin-top: 12px; color: #8a8d94; font-size: 12px; }
</style></head><body><main>
<h1>Shared files</h1>
<p class="latest">Latest upload: <strong id="latest">…</strong></p>
<ul id="files"></ul>
<div class="live">Live update: <span id="live-file">waiting…</span></div>
<div id="status">loading</div>
</main>
<script>
(async () => {
  const files = await (await fetch('/api/files')).json();
  const list = document.getElementById('files');
  const render = (f) => {
    const li = document.createElement('li');
    li.className = 'file';
    const a = document.createElement('a');
    a.className = 'file-link';
    a.href = '/files/' + f.id;
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.name;
    a.appendChild(name);
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = f.size.toLocaleString('pt-BR') + ' bytes';
    const date = document.createElement('time');
    date.className = 'file-date';
    date.textContent = new Date(f.uploadedAt).toLocaleDateString('pt-BR');
    li.append(a, size, date);
    list.appendChild(li);
  };
  document.getElementById('latest').textContent = files[0].name;
  files.slice(0, 3).forEach(render);
  // The late file: rendered 1.5 s after the test asks for it.
  window.scheduleLate = () => setTimeout(() => { render(files[3]); document.body.dataset.late = '1'; }, 1500);
  const ws = new WebSocket(${JSON.stringify(wsUrl)});
  ws.onopen = () => ws.send(JSON.stringify({ type: 'notify', channel: 'uploads', file: ${JSON.stringify(LIVE_FILE)} }));
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'echo') document.getElementById('live-file').textContent = m.data.file;
    } catch {}
  };
  document.getElementById('status').textContent = 'ready';
})();
</script></body></html>`;
}

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

async function startFixture(wsUrl: string): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/files-app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(filesPageHtml(wsUrl));
    } else if (url.pathname === '/api/files') {
      const body = JSON.stringify(FILES);
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

let wss: WsTestServer;
let fixture: FixtureServer;

test.beforeAll(async () => {
  wss = await startWsServer();
  fixture = await startFixture(`${wss.url.replace('http://', 'ws://')}/json`);
});

test.afterAll(async () => {
  await fixture?.close();
  await wss?.close();
});

/** Load the files page with the overlay open from document_start. */
async function openFilesApp(rl: kineReqLens): Promise<void> {
  await rl.page.goto(`${fixture.origin}/files-app`);
  await rl.openOverlay();
  await rl.page.reload();
  await expect(rl.page.locator('#status')).toHaveText('ready', { timeout: 15_000 });
  await expect(rl.page.locator('#live-file')).toHaveText(LIVE_FILE);
  await expect(rl.panel).toBeVisible();
  await expect(rl.row('/api/files')).toHaveCount(1);
}

/** Select /api/files and show its Original response. */
async function openOriginal(rl: kineReqLens): Promise<Locator> {
  await rl.select('/api/files');
  await rl.ui.locator(tid('rl-original-tab')).click();
  const view = rl.ui.locator(tid('rl-original-view'));
  await expect(view.locator('.rl-jv')).toBeVisible();
  return view;
}

/** Wait until two boxes match within `tolerance` px (the page may still be scrolling smoothly). */
async function expectSameBox(a: Locator, b: Locator, tolerance = 4): Promise<void> {
  await expect
    .poll(
      async () => {
        const x = await a.boundingBox();
        const y = await b.boundingBox();
        if (!x || !y) return Number.POSITIVE_INFINITY;
        return Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.width - y.width), Math.abs(x.height - y.height));
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(tolerance);
}

test.describe('find in page', () => {
  test('locate icons, live re-scan, locate on the page and back, on / off', async ({ rl, page }) => {
    await openFilesApp(rl);
    const view = await openOriginal(rl);
    const row = (p: string) => view.locator(`.rl-jv__row[data-path="${p}"]`);
    const icon = (p: string) => row(p).locator(tid('rl-find-icon'));

    // Rendered values: text (twice for the newest name), pt-BR number, pt-BR date; the id only in a link's href.
    await expect(icon('[0].name')).toHaveAttribute('data-state', 'visible');
    await expect(icon('[0].name')).toHaveAttribute('data-total', '2');
    await expect(icon('[0].name')).toHaveAttribute('title', /Found 2× on the page \(2 visible\)/);
    await expect(icon('[0].size')).toHaveAttribute('data-state', 'visible');
    await expect(icon('[0].size')).toHaveAttribute('title', /as “1\.258\.291”/);
    await expect(icon('[0].uploadedAt')).toHaveAttribute('data-state', 'visible');
    await expect(icon('[0].id')).toHaveAttribute('data-state', 'attr');
    await expect(icon('[0].id')).toHaveAttribute('title', /Only found in a link \/ image URL/);
    await expect(icon('[2].size')).toHaveAttribute('data-state', 'visible');
    // Not rendered anywhere: no icon.
    for (const p of ['[0].url', '[0].checksum', '[0].owner.email', '[3].name', '[3].id']) await expect(icon(p)).toHaveCount(0);
    const status = view.locator(tid('rl-find-status'));
    await expect(status).toHaveAttribute('data-state', 'done');
    await expect(status).toContainText(/Find in page: \d+ values found/);

    // The late file appears on the page: the MutationObserver re-scan adds its icons.
    await page.evaluate(() => (window as unknown as { scheduleLate(): void }).scheduleLate());
    await expect(page.locator('body')).toHaveAttribute('data-late', '1', { timeout: 5000 });
    await expect(icon('[3].name')).toHaveAttribute('data-state', 'visible', { timeout: 6000 });
    await expect(icon('[3].id')).toHaveAttribute('data-state', 'attr');

    // Locate: the overlay hides, the first match (the header) is highlighted, the bar counts the matches.
    await icon('[0].name').click();
    await expect(rl.host).toBeHidden();
    const bar = page.locator(tid('rl-find-bar'));
    await expect(bar).toBeVisible();
    const count = page.locator(tid('rl-find-bar-count'));
    await expect(count).toHaveText('1/2');
    await expect(page.locator(tid('rl-find-bar-path'))).toHaveAttribute('data-text', '[0].name');
    const box = page.locator(tid('rl-find-highlight'));
    await expect(box).toBeVisible();
    await expectSameBox(box, page.locator('#latest'));
    const label = page.locator(tid('rl-find-highlight-label'));
    await expect(label).toHaveAttribute('data-path', '[0].name');
    await expect(label).toHaveAttribute('data-snippet', `"${FILES[0]!.name}"`);
    // The path and value live in CSS generated content: page scripts cannot find them as text.
    const leaks = await page.evaluate(() => {
      const find = (window as unknown as { find(s: string, cs: boolean, back: boolean, wrap: boolean): boolean }).find;
      getSelection()?.removeAllRanges();
      const path = find('[0].name', false, false, true);
      getSelection()?.removeAllRanges();
      const control = find('Shared files', false, false, true);
      return { path, control };
    });
    expect(leaks).toEqual({ path: false, control: true });

    // → cycles to the list item; the page stays usable (a click does not end the peek).
    await page.keyboard.press('ArrowRight');
    await expect(count).toHaveText('2/2');
    await expectSameBox(box, page.locator('.file-name').first());
    await page.locator('h1').click();
    await expect(bar).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(count).toHaveText('1/2');

    // Esc: the overlay comes back and the JSON node has the focus.
    await page.keyboard.press('Escape');
    await expect(rl.host).toBeVisible();
    await expect(bar).toHaveCount(0);
    await expect(box).toHaveCount(0);
    await expect(row('[0].name')).toBeFocused();

    // The bar's ✕ works too.
    await icon('[0].uploadedAt').click();
    await expect(rl.host).toBeHidden();
    await expect(count).toHaveText('1/1');
    await expectSameBox(box, page.locator('.file-date').first());
    await page.locator(tid('rl-find-bar-close')).click();
    await expect(rl.host).toBeVisible();
    await expect(row('[0].uploadedAt')).toBeFocused();

    // Off: no icons (persisted), on again: back.
    await view.locator(tid('rl-find-toggle')).click();
    await expect(view.locator(tid('rl-find-icon'))).toHaveCount(0);
    await expect(status).toHaveAttribute('data-state', 'off');
    await expect.poll(async () => (await rl.storedSettings()).findInPage).toBe(false);
    await view.locator(tid('rl-find-toggle')).click();
    await expect(icon('[0].name')).toHaveAttribute('data-state', 'visible');
    await expect.poll(async () => (await rl.storedSettings()).findInPage).toBe(true);
  });

  test('the WebSocket message detail shows icons for rendered values', async ({ rl }) => {
    await openFilesApp(rl);
    await rl.ui.locator(tid('rl-view-ws')).click();
    await expect(rl.ui.locator(tid('rl-ws-view'))).toBeVisible();
    const echo = rl.ui.locator(`${tid('rl-ws-message')}[data-dir="in"][data-event="echo"]`).first();
    await echo.click();
    const detail = rl.ui.locator(tid('rl-ws-detail'));
    const fileRow = detail.locator('.rl-jv__row[data-path="data.file"]');
    await expect(fileRow.locator(tid('rl-find-icon'))).toHaveAttribute('data-state', 'visible');
    // "uploads" (the channel) is not on the page.
    await expect(detail.locator('.rl-jv__row[data-path="channel"]').locator(tid('rl-find-icon'))).toHaveCount(0);

    // The way back: the live value on the page comes from that message.
    await rl.ui.locator(tid('rl-view-http')).click();
    await rl.ui.locator(tid('rl-find-source')).click();
    await expect(rl.page.locator(tid('rl-find-pick-layer'))).toBeVisible();
    const live = (await rl.page.locator('#live-file').boundingBox())!;
    await rl.page.mouse.move(live.x + live.width / 2, live.y + live.height / 2);
    await rl.page.mouse.click(live.x + live.width / 2, live.y + live.height / 2);
    const popover = rl.ui.locator(tid('rl-find-source-popover'));
    await expect(popover).toHaveAttribute('data-state', 'done');
    const echoId = await echo.getAttribute('data-frame-id');
    const group = popover.locator(`${tid('rl-find-source-group')}[data-frame-id="${echoId}"]`);
    await group.locator(`${tid('rl-find-source-match')}[data-path="data.file"]`).click();
    await expect(rl.ui.locator(tid('rl-ws-view'))).toBeVisible();
    await expect(detail).toHaveAttribute('data-frame-id', echoId!);
    await expect(fileRow).toBeFocused();
  });

  test('where does this come from: pick a rendered value, find the request and reveal the JSON node', async ({ rl, page }) => {
    await openFilesApp(rl);
    const entryId = (await rl.row('/api/files').getAttribute('data-entry-id'))!;
    await rl.ui.locator(tid('rl-find-source')).click();
    await expect(rl.host).toBeHidden();
    await expect(page.locator(tid('rl-find-pick-layer'))).toBeVisible();
    const target = page.locator('.file-name').nth(1);
    const b = (await target.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(rl.host).toBeVisible();
    await expect(page.locator(tid('rl-find-pick-layer'))).toHaveCount(0);

    const popover = rl.ui.locator(tid('rl-find-source-popover'));
    await expect(popover).toHaveAttribute('data-state', 'done');
    await expect(popover.locator(tid('rl-find-source-query'))).toContainText(FILES[1]!.name);
    const group = popover.locator(`${tid('rl-find-source-group')}[data-entry-id="${entryId}"]`);
    await expect(group).toBeVisible();
    const match = group.locator(`${tid('rl-find-source-match')}[data-path="[1].name"]`);
    await expect(match).toBeVisible();
    await match.click();
    await expect(popover).toHaveCount(0);

    await expect(rl.detail).toHaveAttribute('data-entry-id', entryId);
    await expect(rl.ui.locator(tid('rl-original-tab'))).toHaveAttribute('aria-selected', 'true');
    const node = rl.ui.locator(`${tid('rl-original-view')} .rl-jv__row[data-path="[1].name"]`);
    await expect(node).toBeFocused();
    await expect(node).toHaveClass(/rl-jv__row--flash/);

    // A number shown in pt-BR is found too (reverse of the locale formatting).
    await rl.ui.locator(tid('rl-find-source')).click();
    await expect(page.locator(tid('rl-find-pick-layer'))).toBeVisible();
    const size = (await page.locator('.file-size').nth(2).boundingBox())!;
    await page.mouse.move(size.x + size.width / 2, size.y + size.height / 2);
    await page.mouse.click(size.x + size.width / 2, size.y + size.height / 2);
    await expect(popover).toHaveAttribute('data-state', 'done');
    await expect(popover.locator(`${tid('rl-find-source-match')}[data-path="[2].size"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  });

  test('find-in-page.png', async ({ rl, page }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    // Docked at the bottom: the page above, the response (editor | results side by side) below.
    await rl.patchSettings({ theme: 'light', layout: { dock: 'bottom', dockSize: 560, listWidth: 300, split: 0.4 } });
    await openFilesApp(rl);
    const view = await openOriginal(rl);
    await expect(view.locator(`.rl-jv__row[data-path="[0].name"] ${tid('rl-find-icon')}`)).toHaveAttribute('data-state', 'visible');
    await expect(view.locator(`.rl-jv__row[data-path="[0].id"] ${tid('rl-find-icon')}`)).toHaveAttribute('data-state', 'attr');
    await page.mouse.move(2, 890);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'find-in-page.png'), caret: 'hide', animations: 'disabled' });
  });
});
