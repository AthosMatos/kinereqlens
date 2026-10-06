/**
 * Playwright fixtures for the kineReqLens E2E suite.
 *
 *  - `server`      worker-scoped local servers (tests/e2e/server.ts): main origin + a cross origin.
 *  - `context`     a fresh persistent Chromium context per test: unpacked `dist-e2e/` extension (open shadow root,
 *                  so locators pierce the overlay), a new temp profile (deleted afterwards), headless, 1440×900.
 *  - `sw`          the extension's service worker; `extensionId`.
 *  - `page`        the context's first tab.
 *  - `openOverlay` / `panel`  shortcuts for `rl.openOverlay()` / `rl.panel`.
 *  - `rl`          helpers: openOverlay() (toolbar-toggle equivalent via `globalThis.__reqlensToggle` in the worker),
 *                  openApp(), panel/list/editor/results locators, send(), echo().
 *
 * Never touches a real browser profile. Build first: `npm run test:e2e` (= build:e2e + playwright test).
 */
import { test as base, chromium, expect } from '@playwright/test';
import type { BrowserContext, Frame, FrameLocator, Locator, Page, Worker } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EchoResponse, TestServers } from './server';
import { startServers } from './server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIR = path.join(ROOT, process.env.REQLENS_E2E_DIST || 'dist-e2e');
export const SCREENSHOT_DIR = path.join(ROOT, 'docs/screenshots');
export const VIEWPORT = { width: 1440, height: 900 } as const;
/** `RL_BROWSER=msedge npm run test:e2e` runs the suite in Microsoft Edge (the extension's target browser). */
export const BROWSER_CHANNEL = process.env.RL_BROWSER === 'msedge' ? 'msedge' : 'chromium';

/** `[data-testid="…"]` selector. */
export const tid = (id: string): string => `[data-testid="${id}"]`;

type Section = 'query' | 'headers' | 'body';

/** Helpers bound to one page of the test context. */
export class kineReqLens {
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    readonly server: TestServers,
  ) {}

  // ------------------------------------------------------------------------------------------- worker

  /** The extension's current service worker (it may have been restarted). */
  async sw(): Promise<Worker> {
    const workers = this.context.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'));
    return workers[workers.length - 1] ?? (await this.context.waitForEvent('serviceworker'));
  }

  /** Toolbar-button equivalent for this page's tab (`globalThis.__reqlensToggle` in the worker). */
  async toggle(): Promise<void> {
    const sw = await this.sw();
    const result = await sw.evaluate(async (url: string) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url) ?? tabs.find((t) => t.active);
      // Exposed by background.js for tests (docs/ARCHITECTURE.md §2.1).
      const toggle = (globalThis as { __reqlensToggle?: (tab: chrome.tabs.Tab) => Promise<void> }).__reqlensToggle;
      if (!tab || !toggle) return `no ${tab ? 'toggle' : 'tab'}`;
      await toggle(tab);
      return 'ok';
    }, this.page.url());
    expect(result, 'toggle reached the tab').toBe('ok');
  }

  /** Open the overlay (toggle) and wait for the panel. */
  async openOverlay(): Promise<void> {
    if (await this.panel.isVisible().catch(() => false)) return;
    await this.toggle();
    await expect(this.panel).toBeVisible();
  }

  /** The settings object persisted in chrome.storage.local (what the UI wrote). */
  async storedSettings(): Promise<Record<string, unknown>> {
    const sw = await this.sw();
    return sw.evaluate(async () => ((await chrome.storage.local.get('reqlens:settings'))['reqlens:settings'] ?? {}) as Record<string, unknown>);
  }

  /** Overwrite (part of) the persisted settings, e.g. a layout preset. Content scripts follow storage.onChanged. */
  async patchSettings(patch: Record<string, unknown>): Promise<void> {
    const sw = await this.sw();
    await sw.evaluate(async (p: Record<string, unknown>) => {
      const key = 'reqlens:settings';
      const current = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
      const layout = { ...((current.layout as object) ?? {}), ...((p.layout as object) ?? {}) };
      await chrome.storage.local.set({ [key]: { ...current, ...p, layout } });
    }, patch);
  }

  // ------------------------------------------------------------------------------------------- app page

  async gotoApp(): Promise<void> {
    await this.page.goto(this.server.appUrl);
    await this.waitForApp();
  }

  async waitForApp(): Promise<void> {
    await expect(this.page.locator('#status')).toHaveText('ready', { timeout: 15_000 });
  }

  /**
   * Load the app with the overlay open from document_start: load, open the overlay, reload, and wait until the
   * page-load requests (hook + webRequest) are listed.
   */
  async openApp(): Promise<void> {
    // The list shows only Fetch/XHR by default; most suites also assert document/script/style rows.
    await this.patchSettings({ listTypes: [] });
    await this.gotoApp();
    await this.openOverlay();
    await this.page.reload();
    await this.waitForApp();
    await expect(this.panel).toBeVisible();
    await expect(this.row('/api/echo/onload-xhr')).toHaveCount(1);
    // webRequest-only entries arrive in 150 ms batches (hook captures show up immediately).
    await expect(this.row('/static/app.css')).toHaveCount(1);
    await expect(this.row('/static/app.js')).toHaveCount(1);
  }

  /**
   * Click an app button and wait until its handler finished (each click appends one log line).
   * `via: 'script'` clicks programmatically (`button.click()`), for layouts where the overlay covers the button.
   */
  async clickApp(name: string, { via = 'pointer' }: { via?: 'pointer' | 'script' } = {}): Promise<void> {
    const key = `done_${name.replace(/-/g, '_')}`;
    const before = await this.page.evaluate((k) => Number(document.body.dataset[k] ?? 0), key);
    if (via === 'script') await this.page.evaluate((id) => document.getElementById(id)!.click(), `btn-${name}`);
    else await this.page.locator(`#btn-${name}`).click();
    await this.page.waitForFunction(([k, n]) => Number(document.body.dataset[k as string] ?? 0) > (n as number), [key, before] as const);
  }

  /** The app's log line for a button (last one). */
  async appLog(name: string): Promise<string> {
    const text = (await this.page.locator('#log').textContent()) ?? '';
    const lines = text.split('\n').filter((l) => l.startsWith(`${name}: `));
    return lines.length ? lines[lines.length - 1]!.slice(name.length + 2) : '';
  }

  // ------------------------------------------------------------------------------------------- shell

  get host(): Locator {
    return this.page.locator('reqlens-overlay');
  }

  /** The overlay UI: panel.html in the (cross-origin) iframe inside the host's shadow root. */
  get ui(): FrameLocator {
    return this.page.locator('reqlens-overlay iframe').contentFrame();
  }

  get panel(): Locator {
    return this.ui.locator(tid('rl-panel'));
  }

  /** The panel.html frame itself (cross-origin extension frame), for evaluating code in the overlay UI. */
  panelFrame(): Frame {
    const frame = this.page.frames().find((f) => f.url().startsWith('chrome-extension://') && f.url().includes('/panel.html'));
    if (!frame) throw new Error('panel frame not found (open the overlay first)');
    return frame;
  }

  /**
   * Record what the overlay copies: replaces `navigator.clipboard` in the panel frame with a recorder, so the
   * system clipboard is never touched. Returns a reader of the copied texts, oldest first. The panel frame is
   * re-created when the page reloads: call it again after a reload.
   */
  async captureCopies(): Promise<() => Promise<string[]>> {
    const frame = this.panelFrame();
    await frame.evaluate(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => void w.__copied.push(text) },
      });
    });
    return () => frame.evaluate(() => (window as unknown as { __copied: string[] }).__copied.slice());
  }

  /** Toasts (`rl-toast`) whose text matches. */
  toast(text: string | RegExp): Locator {
    return this.ui.locator(tid('rl-toast')).filter({ hasText: text });
  }

  /** The request-row context menu (top level). */
  get contextMenu(): Locator {
    return this.ui.locator(tid('rl-context-menu'));
  }

  /** Right-click the first row whose URL contains `fragment` and wait for its context menu. */
  async openRowMenu(fragment: string): Promise<Locator> {
    await this.row(fragment).first().click({ button: 'right' });
    await expect(this.contextMenu).toBeVisible();
    return this.contextMenu;
  }

  get pill(): Locator {
    return this.ui.locator(tid('rl-pill'));
  }

  get rows(): Locator {
    return this.ui.locator(tid('rl-request-row'));
  }

  /** Request rows whose URL contains `fragment`. */
  row(fragment: string): Locator {
    return this.ui.locator(`${tid('rl-request-row')}[data-url*="${fragment}"]`);
  }

  /** `method kind url` of every listed row, top (newest) first. */
  async rowSummaries(): Promise<string[]> {
    return this.rows.evaluateAll((els) =>
      els.map((e) => `${(e as HTMLElement).dataset.method} ${(e as HTMLElement).dataset.kind} ${(e as HTMLElement).dataset.url}`),
    );
  }

  /**
   * Pick the list's request types in the "Types" dropdown (`rl-types-menu`): `'all'`, or exactly these type ids
   * (fetch, doc, js, css, img, media, font, other). Closes the dropdown afterwards.
   */
  async setListTypes(types: 'all' | readonly string[]): Promise<void> {
    const trigger = this.ui.locator(tid('rl-types-menu'));
    await trigger.click();
    const popup = this.ui.locator('.rl-types');
    await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: 'All types' }).click();
    if (types !== 'all') {
      const items = popup.locator(tid('rl-type-chip'));
      for (const id of await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type!))) {
        const box = popup.locator(`${tid('rl-type-chip')}[data-type="${id}"] input`);
        const want = types.includes(id);
        if ((await box.isChecked()) !== want) await box.click();
        await expect(box).toBeChecked({ checked: want });
      }
    }
    await trigger.click();
    await expect(popup).toHaveCount(0);
  }

  async select(fragment: string): Promise<void> {
    // Read the id first: in the narrow layout the list gives way to the detail.
    const id = (await this.row(fragment).first().getAttribute('data-entry-id'))!;
    await this.row(fragment).first().click();
    await expect(this.detail).toBeVisible();
    await expect(this.detail).toHaveAttribute('data-entry-id', id);
  }

  async dock(mode: 'float' | 'right' | 'left' | 'bottom'): Promise<void> {
    await this.ui.locator(tid('rl-dock-menu')).click();
    await this.ui.locator(tid(`rl-dock-${mode}`)).click();
    await expect(this.panel).toHaveAttribute('data-dock', mode);
  }

  // ------------------------------------------------------------------------------------------- editor

  get detail(): Locator {
    return this.ui.locator(tid('rl-detail'));
  }

  section(id: Section): Locator {
    return this.ui.locator(tid(`rl-section-${id}`));
  }

  kvRows(section: Section): Locator {
    return this.section(section).locator(tid('rl-kv-row'));
  }

  kvRow(section: Section, key: string): Locator {
    return this.section(section).locator(`${tid('rl-kv-row')}[data-key="${key}"]`);
  }

  jsonNode(pathKey: string): Locator {
    return this.ui.locator(`${tid('rl-json-node')}[data-path='${pathKey}']`);
  }

  jsonValue(pathKey: string): Locator {
    return this.jsonNode(pathKey).locator(tid('rl-json-value')).first();
  }

  async setMode(mode: 'page' | 'extension'): Promise<void> {
    await this.ui.locator(tid('rl-mode-select')).selectOption(mode);
  }

  /** Open the request options popover, apply `fn`, close it. */
  async withSendOptions(fn: (form: Locator) => Promise<void>): Promise<void> {
    await this.ui.locator(tid('rl-send-options')).click();
    const form = this.ui.locator(tid('rl-send-options-form'));
    await expect(form).toBeVisible();
    await fn(form);
    await form.getByRole('button', { name: 'Done' }).click();
    await expect(form).toHaveCount(0);
  }

  // ------------------------------------------------------------------------------------------- results

  get results(): Locator {
    return this.ui.locator(tid('rl-results'));
  }

  /** The active run's response view (Test result tab). */
  get resultView(): Locator {
    return this.ui.locator(tid('rl-result-view'));
  }

  respTab(name: string, scope: Locator = this.resultView): Locator {
    return scope.locator(`${tid('rl-resp-tab')}[data-tab="${name}"]`);
  }

  /** Click Send and wait until the new run settled. Returns the run state. */
  async send(): Promise<string> {
    // An entry opens on "Original response"; the Test result panel (rl-results) mounts once a run starts.
    const before = (await this.results.count()) > 0 ? ((await this.results.getAttribute('data-active-run')) ?? '') : '';
    await this.ui.locator(tid('rl-send')).click();
    await expect(this.results).toBeVisible();
    await expect(this.results).not.toHaveAttribute('data-active-run', before);
    await expect(this.results).not.toHaveAttribute('data-run-state', 'running', { timeout: 20_000 });
    return (await this.results.getAttribute('data-run-state')) ?? '';
  }

  /** Text of the active run's status pill. */
  async status(): Promise<string> {
    return ((await this.resultView.locator(tid('rl-result-status')).textContent()) ?? '').trim();
  }

  /** The raw response body of the active run, read from the Raw body view. */
  async rawBody(scope: Locator = this.resultView): Promise<string> {
    await this.respTab('body', scope).click();
    const raw = scope.locator(tid('rl-body-raw'));
    if ((await raw.getAttribute('aria-pressed')) !== 'true') await raw.click();
    const body = scope.locator(tid('rl-result-body'));
    await expect(body).toHaveAttribute('data-mode', 'raw');
    return (await body.locator('pre').first().textContent()) ?? '';
  }

  /** The echo server's JSON answer of the active run. */
  async echo<T = EchoResponse>(): Promise<T> {
    return JSON.parse(await this.rawBody()) as T;
  }
}

interface WorkerFixtures {
  server: TestServers;
}

interface TestFixtures {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  page: Page;
  rl: kineReqLens;
  /** Open the overlay in `page` (toolbar-toggle equivalent) and wait for the panel. Same as `rl.openOverlay()`. */
  openOverlay: () => Promise<void>;
  /** The overlay panel (`rl-panel`); every other locator helper lives on `rl`. */
  panel: Locator;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServers();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error('dist-e2e/ is missing: run `npm run build:e2e` (or `npm run test:e2e`) first');
    }
    const profile = mkdtempSync(path.join(os.tmpdir(), 'reqlens-e2e-'));
    // Playwright's Chromium by default; RL_BROWSER=msedge runs the suite in an installed Microsoft Edge (which
    // honours --load-extension too). The new headless mode runs extensions.
    const context = await chromium.launchPersistentContext(profile, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  page: async ({ context, sw }, use) => {
    void sw; // the extension is up before the first navigation
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
  rl: async ({ page, context, server }, use) => {
    await use(new kineReqLens(page, context, server));
  },
  openOverlay: async ({ rl }, use) => {
    await use(() => rl.openOverlay());
  },
  panel: async ({ rl }, use) => {
    await use(rl.panel);
  },
});

export { expect };
