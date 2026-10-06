/**
 * Suite 1 — overlay shell: toggle on/off, open state across reloads/navigations, minimize/restore, dock modes,
 * closing hides the host, page-load requests captured after a reload.
 */
import type { Locator } from '@playwright/test';
import { VIEWPORT, expect, test, tid } from './fixtures';

/** Host element state: computed display + whether it is in the top layer. */
async function hostState(host: Locator): Promise<{ display: string; popoverOpen: boolean }> {
  return host.evaluate((el) => ({
    display: getComputedStyle(el).display,
    popoverOpen: (() => {
      try {
        return el.matches(':popover-open');
      } catch {
        return false;
      }
    })(),
  }));
}

test.describe('overlay', () => {
  test('toggle shows and hides the overlay in the top layer', async ({ rl, sw, extensionId, openOverlay, panel }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(sw.url()).toBe(`chrome-extension://${extensionId}/background.js`);
    await rl.gotoApp();
    await expect(rl.host).toHaveCount(0); // ui.js is injected on demand only
    await openOverlay();
    await expect(panel).toBeVisible();
    await expect(rl.host).toHaveCount(1);
    expect(await hostState(rl.host)).toEqual({ display: 'block', popoverOpen: true });
    // The panel itself is above the page: the element at its centre belongs to the overlay host.
    const box = (await rl.panel.boundingBox())!;
    const topmost = await rl.page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.tagName.toLowerCase(),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topmost).toBe('reqlens-overlay');

    await rl.toggle();
    await expect(rl.panel).toBeHidden();
    expect(await hostState(rl.host)).toEqual({ display: 'none', popoverOpen: false });

    await rl.toggle();
    await expect(rl.panel).toBeVisible();
    await expect(rl.host).toHaveCount(1); // re-used, never duplicated
  });

  test('open state survives reloads and navigations in the tab', async ({ rl }) => {
    await rl.openApp();
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.panel).toBeVisible();
    await rl.page.goto(`${rl.server.appUrl}?second=1`);
    await rl.waitForApp();
    await expect(rl.panel).toBeVisible();
    await expect(rl.row('/api/echo/onload?boot=1')).toHaveCount(1);
    await expect(rl.host).toHaveCount(1);
  });

  test('minimize to the pill and restore', async ({ rl }) => {
    await rl.openApp();
    const count = await rl.rows.count();
    await rl.ui.locator(tid('rl-minimize')).click();
    await expect(rl.pill).toBeVisible();
    await expect(rl.panel).toBeHidden();
    await expect(rl.pill).toContainText(String(count));
    // Still capturing while minimized: the pill count follows.
    await rl.clickApp('query');
    await expect(rl.pill).toContainText(String(count + 1));
    // Minimized state is part of the persisted layout.
    await rl.page.waitForTimeout(500);
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.pill).toBeVisible();
    await rl.pill.click();
    await expect(rl.panel).toBeVisible();
    await expect(rl.pill).toHaveCount(0);
  });

  test('dock modes: right, left, bottom, float (persisted)', async ({ rl }) => {
    await rl.openApp();
    const { width: W, height: H } = VIEWPORT;

    await rl.dock('right');
    let box = (await rl.panel.boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(W);
    expect([Math.round(box.y), Math.round(box.height)]).toEqual([0, H]);

    await rl.dock('left');
    box = (await rl.panel.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect([Math.round(box.y), Math.round(box.height)]).toEqual([0, H]);

    await rl.dock('bottom');
    box = (await rl.panel.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(H);
    expect([Math.round(box.x), Math.round(box.width)]).toEqual([0, W]);

    // Docking is still an overlay: the page layout is untouched.
    expect(await rl.page.evaluate(() => [document.documentElement.clientWidth, getComputedStyle(document.body).marginRight])).toEqual([
      W,
      '0px',
    ]);

    await rl.dock('right');
    await rl.page.waitForTimeout(500); // debounced layout write
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.panel).toHaveAttribute('data-dock', 'right');
    box = (await rl.panel.boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(W);

    await rl.dock('float');
    box = (await rl.panel.boundingBox())!;
    expect(box.width).toBeLessThan(W);
    expect(box.height).toBeLessThan(H);
    expect(box.x).toBeGreaterThan(0);
    expect(box.y).toBeGreaterThan(0);
  });

  test('navigation rail: views, keyboard, shortcuts, collapse (persisted), compact on narrow docks', async ({ rl }) => {
    await rl.openApp();
    const rail = rl.ui.locator(tid('rl-rail'));
    const item = (id: string) => rail.locator(`${tid('rl-rail-item')}[data-item="${id}"]`);
    await expect(rail).toBeVisible();
    expect(await rail.locator(tid('rl-rail-item')).evaluateAll((els) => els.map((el) => el.getAttribute('data-item')))).toEqual([
      'requests',
      'websocket',
      'setups',
      'screenshot',
      'terminal',
      'language',
      'settings',
      'errors',
      'theme',
      'collapse',
    ]);
    // The header keeps the brand, the recording indicator and the window controls only.
    const header = rl.ui.locator(tid('rl-header'));
    for (const id of ['rl-view-switch', 'rl-setups-button', 'rl-claude-terminal-toggle', 'rl-settings']) {
      await expect(header.locator(tid(id))).toHaveCount(0);
      await expect(rail.locator(tid(id))).toHaveCount(1);
    }
    await expect(item('requests')).toHaveAttribute('data-active', 'true');
    await expect(rl.ui.locator(tid('rl-view-http-count'))).toHaveText(/^\d+$/);
    expect(Math.round((await rail.boundingBox())!.width)).toBe(44);

    // Click, Alt+digit and the arrow keys (a vertical toolbar with one tab stop).
    await item('websocket').click();
    await expect(item('websocket')).toHaveAttribute('data-active', 'true');
    await expect(rl.ui.locator(tid('rl-ws-view'))).toBeVisible();
    await rl.page.keyboard.press('Alt+1');
    await expect(item('requests')).toHaveAttribute('data-active', 'true');
    await expect(rl.ui.locator(tid('rl-request-list'))).toBeVisible();
    await rl.page.keyboard.press('Alt+4');
    await expect(item('screenshot')).toHaveAttribute('data-active', 'true');
    await expect(rl.ui.locator(tid('rl-shot'))).toBeVisible();
    await rl.ui.locator(tid('rl-shot-close')).click();
    await expect(item('requests')).toHaveAttribute('data-active', 'true');
    const http = rl.ui.locator(tid('rl-view-http'));
    await expect(http).toHaveAttribute('tabindex', '0');
    await expect(rail.locator('[data-rail-key][tabindex="0"]')).toHaveCount(1);
    await http.focus();
    await rl.page.keyboard.press('ArrowDown');
    await expect(rl.ui.locator(tid('rl-view-ws'))).toBeFocused();
    await rl.page.keyboard.press('End');
    await expect(rl.ui.locator(tid('rl-rail-toggle'))).toBeFocused();
    await rl.page.keyboard.press('Home');
    await expect(http).toBeFocused();
    await rl.page.keyboard.press('Alt+6');
    await expect(rl.ui.locator(tid('rl-settings'))).toHaveAttribute('aria-expanded', 'true');
    await expect(rl.ui.locator(tid('rl-settings-claude'))).toBeVisible();
    await rl.page.keyboard.press('Escape');
    await expect(rl.ui.locator(tid('rl-settings'))).toHaveAttribute('aria-expanded', 'false');
    await rl.page.keyboard.press('Alt+5');
    await expect(rl.ui.locator(tid('rl-claude-terminal-toggle'))).toHaveAttribute('aria-pressed', 'true');
    await rl.page.keyboard.press('Alt+5');
    await expect(rl.ui.locator(tid('rl-claude-terminal-toggle'))).toHaveAttribute('aria-pressed', 'false');
    await rl.page.keyboard.press('Alt+7');
    await expect(item('errors')).toHaveAttribute('data-active', 'true');
    await expect(rl.ui.locator(tid('rl-errors-view'))).toBeVisible();
    await rl.page.keyboard.press('Alt+1');
    await expect(item('requests')).toHaveAttribute('data-active', 'true');

    // Theme quick toggle: auto → light → dark → auto.
    const themeToggle = rl.ui.locator(tid('rl-theme-toggle'));
    await expect(themeToggle).toHaveAttribute('data-theme-setting', 'auto');
    await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('data-theme-setting', 'light');
    await expect(rl.ui.locator('.rl-root')).toHaveAttribute('data-theme', 'light');
    await themeToggle.click();
    await expect(rl.ui.locator('.rl-root')).toHaveAttribute('data-theme', 'dark');
    await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('data-theme-setting', 'auto');

    // Expand (labels), persisted in settings.layout.railExpanded.
    await rl.ui.locator(tid('rl-rail-toggle')).click();
    await expect(rail).toHaveAttribute('data-expanded', 'true');
    await expect(item('requests')).toContainText('Requests');
    await expect.poll(async () => Math.round((await rail.boundingBox())!.width)).toBe(180);
    await expect
      .poll(async () => ((await rl.storedSettings()) as { layout?: { railExpanded?: boolean } }).layout?.railExpanded)
      .toBe(true);
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.ui.locator(tid('rl-rail'))).toHaveAttribute('data-expanded', 'true');

    // A narrow dock shows icons only (no expand switch); a wider one gets the labels back.
    await rl.patchSettings({ layout: { dock: 'right', dockSize: 440 } });
    await expect(rl.panel).toHaveAttribute('data-dock', 'right');
    await expect(rl.ui.locator(tid('rl-rail'))).toHaveAttribute('data-expanded', 'false');
    await expect(rl.ui.locator(tid('rl-rail-toggle'))).toHaveCount(0);
    await expect(rl.ui.locator(tid('rl-request-list'))).toBeVisible();
    await rl.patchSettings({ layout: { dockSize: 900 } });
    await expect(rl.ui.locator(tid('rl-rail'))).toHaveAttribute('data-expanded', 'true');
  });

  test('closing hides the host and keeps it closed across reloads', async ({ rl }) => {
    await rl.openApp();
    await rl.ui.locator(tid('rl-close')).click();
    await expect(rl.panel).toBeHidden();
    expect(await hostState(rl.host)).toEqual({ display: 'none', popoverOpen: false });
    // Click-through while closed: the page gets the click again.
    await rl.clickApp('query');
    expect(await rl.appLog('query')).toBe('200');

    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.panel).toBeHidden();
    await expect(rl.host).toHaveCount(0); // not even injected while closed
  });

  test('page-load requests are captured after a reload', async ({ rl }) => {
    await rl.patchSettings({ listTypes: [] }); // every type: documents, styles, scripts and images too
    await rl.gotoApp();
    await rl.toggle();
    await expect(rl.panel).toBeVisible();
    // Opened after load: the banner explains it, and the page-load requests were missed.
    const banner = rl.ui.locator(tid('rl-late-banner'));
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Reload to capture page-load requests');
    await expect(rl.row('/api/echo/onload')).toHaveCount(0);

    // The banner's Reload button reloads the page with capture on from document_start.
    await banner.getByRole('button', { name: 'Reload' }).click();
    await rl.waitForApp();
    await expect(rl.panel).toBeVisible();
    await expect(banner).toHaveCount(0);
    await expect(rl.row('/api/echo/onload?boot=1')).toHaveCount(1);
    await expect(rl.row('/api/echo/onload-xhr?boot=2')).toHaveCount(1);
    await expect(rl.row('/static/app.css')).toHaveCount(1);
    await expect(rl.row('/static/app.js')).toHaveCount(1);
    await expect(rl.ui.locator(`${tid('rl-request-row')}[data-kind="document"][data-url="${rl.server.appUrl}"]`)).toHaveCount(1);

    const kinds = Object.fromEntries(
      (await rl.rowSummaries()).map((s) => {
        const [, kind, url] = s.split(' ');
        return [new URL(url!).pathname + new URL(url!).search, kind];
      }),
    );
    expect(kinds).toMatchObject({
      '/app': 'document',
      '/static/app.css': 'stylesheet',
      '/static/app.js': 'script',
      '/api/image?w=28&h=28': 'image',
      '/api/echo/onload?boot=1': 'fetch',
      '/api/echo/onload-xhr?boot=2': 'xhr',
    });
    // Each finished with its status.
    for (const fragment of ['/static/app.css', '/api/echo/onload?boot=1', '/api/echo/onload-xhr']) {
      await expect(rl.row(fragment).locator('.rl-req-row__status')).toHaveText('200');
    }
  });
});
