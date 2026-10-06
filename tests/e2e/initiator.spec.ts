/**
 * Initiator tab ("which component is consuming this endpoint", docs/ARCHITECTURE.md §10): a real component app
 * (tests/e2e/initiator-app — Preact aliased as react / react-dom, bundled here with esbuild and a linked source
 * map) whose ReportList fetches in an effect. The row menu's "Show initiator / component" opens the Initiator
 * tab: the component guess (ReportList, path App › ReportsPage › ReportList), the original file:line through the
 * source map, the code excerpt, VS Code links under the configured workspace root, and "Highlight on page"
 * drawing a box around the component's element. Entries without a stack show the empty state.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, tid } from './fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'initiator-app');
const REPORT_LIST = path.join(APP_DIR, 'ReportList.jsx');

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Initiator fixture</title>
<style>body { margin: 0; font: 14px system-ui; } .page { padding: 24px; } .reports { width: 320px; padding: 8px 24px; border: 1px solid #ccc; }</style>
</head><body><div id="root"></div><script src="/initiator/app.js"></script></body></html>`;

async function startFixtureServer(): Promise<FixtureServer> {
  const result = await build({
    entryPoints: [path.join(APP_DIR, 'main.jsx')],
    bundle: true,
    write: false,
    // The outputs are served from memory; sources are relative to this (virtual) folder: "../ReportList.jsx".
    outdir: path.join(APP_DIR, 'dist'),
    entryNames: 'app',
    format: 'iife',
    sourcemap: 'linked',
    jsx: 'automatic',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    nodePaths: [path.join(HERE, '../../node_modules')],
    logLevel: 'silent',
  });
  const files = new Map<string, { type: string; body: Buffer }>();
  for (const file of result.outputFiles) {
    const name = path.basename(file.path);
    files.set(`/initiator/${name}`, { type: name.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8', body: Buffer.from(file.contents) });
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = files.get(url.pathname);
    if (url.pathname === '/initiator') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
    } else if (file) {
      res.writeHead(200, { 'content-type': file.type, 'content-length': String(file.body.length), 'cache-control': 'no-store' });
      res.end(file.body);
    } else if (url.pathname === '/api/reports') {
      const body = JSON.stringify({ rows: [{ id: 1, title: 'Q1 revenue' }, { id: 2, title: 'Q2 revenue' }] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.keepAliveTimeout = 500;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** 1-based line of the fetch call in the fixture's original source. */
function fetchLine(): number {
  return readFileSync(REPORT_LIST, 'utf8').split('\n').findIndex((l) => l.includes("fetch('/api/reports")) + 1;
}

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture?.close();
});

test.describe('initiator tab', () => {
  test('shows the component, the source-mapped stack and highlights the component on the page', async ({ rl, page }) => {
    await rl.patchSettings({ editorRoot: '/Users/test/fixture-app' });
    await page.goto(`${fixture.origin}/initiator`);
    await rl.openOverlay();
    // Reload with the overlay open: the effect's fetch is captured from document_start, with its call stack.
    await page.reload();
    await expect(page.locator('#report-list li')).toHaveCount(2);
    await expect(rl.panel).toBeVisible();
    await expect(rl.row('/api/reports')).toHaveCount(1);

    const menu = await rl.openRowMenu('/api/reports');
    const item = menu.locator(tid('rl-ctx-initiator'));
    await expect(item).toHaveText(/Show initiator \/ component/);
    await item.click();

    await expect(rl.detail).toBeVisible();
    await expect(rl.ui.locator(tid('rl-initiator-tab'))).toHaveAttribute('aria-selected', 'true');
    const panel = rl.ui.locator(tid('rl-initiator'));
    await expect(panel).toHaveAttribute('data-state', 'done', { timeout: 20_000 });

    // Component guess + its path on the page (Preact tree walk) + instance count.
    const component = panel.locator(tid('rl-initiator-component'));
    await expect(component).toHaveAttribute('data-name', 'ReportList');
    await expect(component).toContainText('<ReportList>');
    await expect(panel.locator(tid('rl-initiator-path'))).toHaveText('App › ReportsPage › ReportList');
    await expect(panel.locator(tid('rl-initiator-count'))).toHaveText('1 instance on the page');
    await expect(component).toContainText('preact');

    // The initiating frame, mapped to the original file and line, with the bundle position and an excerpt.
    const line = fetchLine();
    expect(line).toBeGreaterThan(0);
    // The effect callback is anonymous: named after the component around it (source map + original source).
    await expect(panel.locator('.rl-init__fn')).toHaveText('(anonymous in ReportList)');
    await expect(panel.locator(tid('rl-initiator-location'))).toHaveText(new RegExp(`^ReportList\\.jsx:${line}:\\d+$`));
    await expect(panel.locator(tid('rl-initiator-frame-card'))).toContainText(/bundle\s*|app\.js:\d+:\d+/);
    const excerpt = panel.locator(tid('rl-initiator-excerpt'));
    await expect(excerpt.locator('.rl-init__line--focus')).toContainText("fetch('/api/reports?from=ReportList')");
    const vscode = panel.locator(tid('rl-initiator-vscode')).first();
    await expect(vscode).toHaveAttribute('href', new RegExp(`^vscode://file/Users/test/fixture-app/ReportList\\.jsx:${line}:\\d+$`));

    // The stack: app frames listed, Preact internals collapsed into library groups.
    const frames = panel.locator(`${tid('rl-initiator-stack')} > ol > ${tid('rl-initiator-frame')}`);
    await expect(frames.first()).toHaveAttribute('data-kind', 'app');
    await expect(frames.first()).toHaveAttribute('data-location', `ReportList.jsx:${line}`);
    const group = panel.locator(tid('rl-initiator-library-group')).first();
    await expect(group).toContainText(/library frames? · .*preact/);
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator(`${tid('rl-initiator-frame')}[data-kind="framework"]`).first()).toBeVisible();

    // Copy stack: original locations.
    const copies = await rl.captureCopies();
    await panel.locator(tid('rl-initiator-copy')).click();
    await expect.poll(async () => (await copies())[0] ?? '').toContain(`(ReportList.jsx:${line}:`);

    // Highlight on page: a box exactly around the component's element, removed after a few seconds.
    await panel.locator(tid('rl-initiator-highlight')).click();
    const box = page.locator(`reqlens-highlight-layer ${tid('rl-highlight-box')}`);
    await expect(box).toHaveCount(1);
    const target = (await page.locator('#report-list').boundingBox())!;
    const drawn = (await box.boundingBox())!;
    expect(Math.abs(drawn.x - target.x)).toBeLessThan(2);
    expect(Math.abs(drawn.y - target.y)).toBeLessThan(2);
    expect(Math.abs(drawn.width - target.width)).toBeLessThan(2);
    expect(Math.abs(drawn.height - target.height)).toBeLessThan(2);
    await expect(page.locator('reqlens-highlight-layer')).toContainText('ReportList');
    await expect(page.locator('reqlens-highlight-layer')).toHaveCount(0, { timeout: 8_000 });
  });

  test('requests without a recorded stack show the empty state', async ({ rl, page }) => {
    await page.goto(`${fixture.origin}/initiator`);
    await expect(page.locator('#report-list li')).toHaveCount(2);
    await rl.openOverlay();
    // A script the browser loads itself is a webRequest-only entry (no JavaScript call stack).
    await rl.patchSettings({ listTypes: [] });
    await expect(rl.row('/initiator/app.js')).toHaveCount(0);
    await page.reload();
    await expect(rl.row('/initiator/app.js')).toHaveCount(1);
    const menu = await rl.openRowMenu('/initiator/app.js');
    await expect(menu.locator(tid('rl-ctx-initiator'))).toContainText('no stack');
    await menu.locator(tid('rl-ctx-initiator')).click();
    const panel = rl.ui.locator(tid('rl-initiator'));
    await expect(panel).toHaveAttribute('data-state', 'none');
    await expect(panel.locator(tid('rl-initiator-empty'))).toContainText('No call stack for this request');
    await expect(panel.locator(tid('rl-initiator-empty'))).toContainText('The browser loaded this resource itself');
  });
});
