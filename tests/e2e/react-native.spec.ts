/**
 * React Native support end to end, with the real pieces: the extension (dist-e2e) ⇄ the real hub
 * (`reqlens-mcp native-host`, registered by `reqlens-mcp install --manifest-dir <profile>/NativeMessagingHosts`,
 * spawned by Chromium) whose receiver accepts the real RN package runtime (react-native/src) running in this
 * Node process over React Native fakes (react-native/test/rn-fakes.ts: XHR, whatwg-fetch over it, Blob /
 * FileReader; no real network — the fake network answers).
 *
 * Flow: Settings → React Native → enable (the browser spawns the hub, the receiver listens), the app connects
 * with the pairing token shown there, its dev menu "Open kineReqLens" opens the standalone tab, which lists the
 * app's requests; a replay in "App" mode runs inside the app (its original fetch) and is not captured again.
 *
 * Everything lives in temp dirs (browser profile, REQLENS_HOME). Needs `mcp/dist/reqlens-mcp.mjs`
 * (`npm run build:mcp`) and `dist-e2e/` (`npm run build:e2e`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BROWSER_CHANNEL, EXTENSION_DIR, VIEWPORT, expect, test as base, tid } from './fixtures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'mcp/dist/reqlens-mcp.mjs');

interface RnFixtures {
  profileDir: string;
  home: string;
}

const test = base.extend<RnFixtures>({
  // eslint-disable-next-line no-empty-pattern
  profileDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reqlens-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rlh-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  context: async ({ profileDir }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

test.beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('mcp/dist/reqlens-mcp.mjs is missing: run `npm run build:mcp` first');
});

function cli(args: string[], home: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REQLENS_HOME: home } });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The RN package and its fakes are plain TS modules of this repository (their own tsconfig): loaded at runtime.
interface NetRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
interface RnGlobal {
  fetch(input: unknown, init?: Record<string, unknown>): Promise<{ status: number; text(): Promise<string> }>;
  network: { handler: (req: NetRequest) => unknown; requests: NetRequest[] };
}
interface FakeRn {
  DevSettings: { items: Array<{ title: string; handler(): void }> };
}
interface RnModules {
  startKineReqLens(options: Record<string, unknown>): { session: string } | null;
  stopKineReqLens(): void;
  makeRnGlobal(): RnGlobal;
  fakeReactNative(options?: Record<string, unknown>): FakeRn;
  FakeFileReader: unknown;
}

async function loadRn(): Promise<RnModules> {
  const index = path.join(ROOT, 'react-native/src/index.ts');
  const fakes = path.join(ROOT, 'react-native/test/rn-fakes.ts');
  const rn = (await import(index)) as Pick<RnModules, 'startKineReqLens' | 'stopKineReqLens'>;
  const f = (await import(fakes)) as Pick<RnModules, 'makeRnGlobal' | 'fakeReactNative' | 'FakeFileReader'>;
  return { startKineReqLens: rn.startKineReqLens, stopKineReqLens: rn.stopKineReqLens, makeRnGlobal: f.makeRnGlobal, fakeReactNative: f.fakeReactNative, FakeFileReader: f.FakeFileReader };
}

const standaloneRow = (page: Page, fragment: string) => page.locator(`${tid('rl-request-row')}[data-url*="${fragment}"]`);

test.describe('React Native (real hub receiver + RN runtime)', () => {
  test('enable in Settings, the app pairs, its dev menu opens the standalone tab, requests are listed and replayed in the app', async ({
    rl,
    context,
    home,
    profileDir,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    cli(['install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], home);
    const port = await freePort();
    await rl.patchSettings({ rnPort: port });

    // Settings → React Native → enable: the browser spawns the hub, whose receiver starts listening.
    await rl.gotoApp();
    await rl.openOverlay();
    await rl.ui.locator(tid('rl-settings')).click();
    const section = rl.ui.locator(tid('rl-rn-section'));
    await expect(section).toBeVisible();
    const status = section.locator(tid('rl-rn-status'));
    await expect(status).toHaveAttribute('data-state', 'off');
    await section.locator(tid('rl-rn-enable')).check();
    await expect(status).toHaveAttribute('data-state', 'listening', { timeout: 20_000 });
    await expect(status).toContainText(`Listening on 127.0.0.1:${port}`);
    const token = ((await section.locator(tid('rl-rn-token')).textContent()) ?? '').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await expect(section.locator(tid('rl-rn-snippet'))).toHaveText(`if (__DEV__) require('@kinebot/kinereqlens-react-native').startKineReqLens({ token: '${token}' })`);
    expect(await rl.storedSettings()).toMatchObject({ rnEnabled: true, rnListenLan: false, rnPort: port });

    // The app (RN runtime over fakes, in this Node process) pairs with the token.
    const rn = await loadRn();
    const g0 = globalThis as { FileReader?: unknown };
    g0.FileReader = rn.FakeFileReader;
    const g = rn.makeRnGlobal();
    g.network.handler = (req) =>
      req.url.includes('/replayed') || req.method === 'PUT'
        ? { status: 201, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replayed: true, method: req.method }) }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [1, 2, 3] }) };
    const reactNative = rn.fakeReactNative({ os: 'android', constants: { Model: 'Pixel 8' } });
    const handle = rn.startKineReqLens({
      token,
      host: '127.0.0.1',
      port,
      enabled: true,
      global: g,
      reactNative,
      appName: 'DemoApp',
      deviceName: 'Pixel 8',
      log: false,
      reconnect: { minDelayMs: 50, maxDelayMs: 500 },
    });
    expect(handle).not.toBeNull();
    try {
      await expect(section.locator(tid('rl-rn-app'))).toHaveCount(1, { timeout: 15_000 });
      await expect(section.locator(tid('rl-rn-app'))).toContainText('DemoApp · Android · Pixel 8');
      await expect(status).toContainText('1 app');

      // Traffic before the tab exists is buffered by the worker.
      const first = await g.fetch('https://api.example.com/items?page=1', { headers: { Authorization: 'Bearer rn-secret' } });
      expect(first.status).toBe(200);
      expect(await first.text()).toBe('{"items":[1,2,3]}');

      // Dev menu → "Open kineReqLens": the hub forwards open-ui, the worker opens the standalone tab.
      const opened = context.waitForEvent('page', { predicate: (p) => p.url().startsWith(`chrome-extension://${extensionId}/app.html`) });
      reactNative.DevSettings.items.find((item) => item.title === 'Open kineReqLens')!.handler();
      const app = await opened;
      expect(app.url()).toContain(`#session=${handle!.session}`);
      await expect(app.locator(tid('rl-panel'))).toBeVisible();
      await expect(app.locator(tid('rl-panel'))).not.toHaveAttribute('data-dock', /bottom|left|right/);
      // Full-tab layout: no dock / minimize / close.
      await expect(app.locator(tid('rl-dock-menu'))).toHaveCount(0);
      await expect(app.locator(tid('rl-minimize'))).toHaveCount(0);
      await expect(app.locator(tid('rl-close'))).toHaveCount(0);
      await expect(app.locator(tid('rl-preserve-toggle'))).toHaveCount(0);
      // The navigation rail works in the full tab too (no screenshot tool: it captures a page).
      await expect(app.locator(tid('rl-rail'))).toBeVisible();
      await expect(app.locator(`${tid('rl-rail-item')}[data-item="screenshot"]`)).toHaveCount(0);
      await expect(app.locator(`${tid('rl-rail-item')}[data-item="requests"]`)).toHaveAttribute('data-active', 'true');
      await expect(app.locator(tid('rl-rn-target-label'))).toContainText('DemoApp · Android · Pixel 8');
      await expect(app.locator(tid('rl-rn-targets'))).toHaveAttribute('data-connected', 'true');

      await expect(standaloneRow(app, 'api.example.com/items?page=1')).toHaveCount(1);
      // Live traffic after the tab opened.
      await g.fetch('https://api.example.com/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"qty":2}' });
      await expect(standaloneRow(app, 'api.example.com/orders')).toHaveCount(1);
      await expect(standaloneRow(app, 'api.example.com/orders')).toHaveAttribute('data-method', 'POST');
      await app.screenshot({ path: test.info().outputPath('standalone-rail.png') });

      // Replay in the app: edit the method, send in "App" mode.
      const row = standaloneRow(app, 'api.example.com/orders');
      const entryId = (await row.getAttribute('data-entry-id'))!;
      await row.click();
      const detail = app.locator(tid('rl-detail'));
      await expect(detail).toHaveAttribute('data-entry-id', entryId);
      const mode = app.locator(tid('rl-mode-select'));
      await expect(mode.locator('option[value="page"]')).toHaveText('App');
      await mode.selectOption('page');
      await app.locator(tid('rl-method-select')).selectOption('PUT');
      // A browser-controlled header (Cookie) is sent by the app: no Page-mode warning, no lock.
      const headers = app.locator(tid('rl-section-headers'));
      await headers.locator(tid('rl-kv-add')).click();
      const cookieRow = headers.locator(tid('rl-kv-row')).last();
      await cookieRow.locator(tid('rl-kv-key')).fill('Cookie');
      await cookieRow.locator(tid('rl-kv-value')).fill('sid=app-1');
      await expect(headers.locator(`${tid('rl-kv-row')}[data-key="Cookie"]`)).toHaveCount(1);
      await expect(cookieRow.locator('.rl-kv-lock')).toHaveCount(0);
      await expect(app.locator(`${tid('rl-warnings')} li`).filter({ hasText: 'controlled by the browser' })).toHaveCount(0);
      const results = app.locator(tid('rl-results'));
      // The entry opens on "Original response"; the Test result panel mounts once the run starts.
      const before = (await results.count()) > 0 ? ((await results.getAttribute('data-active-run')) ?? '') : '';
      const sentBefore = g.network.requests.length;
      await app.locator(tid('rl-send')).click();
      await expect(results).toBeVisible();
      await expect(results).not.toHaveAttribute('data-active-run', before);
      await expect(results).toHaveAttribute('data-run-state', 'done', { timeout: 20_000 });
      await expect(app.locator(tid('rl-result-view')).locator(tid('rl-result-status'))).toContainText('201');
      // It ran inside the app (its fake network saw it) with the edited method, body and headers.
      const replayed = g.network.requests.slice(sentBefore);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toMatchObject({ method: 'PUT', url: 'https://api.example.com/orders' });
      expect(String(replayed[0]!.body)).toBe('{"qty":2}');
      expect(replayed[0]!.headers).toMatchObject({ cookie: 'sid=app-1' });
      // ... and was not captured as a new request.
      await app.waitForTimeout(300);
      await expect(app.locator(tid('rl-request-row'))).toHaveCount(2);

      // Settings → React Native is available in the standalone tab too.
      await app.locator(tid('rl-settings')).click();
      await expect(app.locator(tid('rl-rn-status'))).toHaveAttribute('data-state', 'listening');
      await expect(app.locator(tid('rl-rn-token'))).toHaveText(token);
      await app.keyboard.press('Escape');

      // The app goes away: the tab keeps its requests and shows it disconnected.
      rn.stopKineReqLens();
      await expect(app.locator(tid('rl-rn-targets'))).toHaveAttribute('data-connected', 'false', { timeout: 10_000 });
      await expect(app.locator(tid('rl-request-row'))).toHaveCount(2);
    } finally {
      rn.stopKineReqLens();
      delete g0.FileReader;
    }
  });
});
