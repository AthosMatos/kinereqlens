/**
 * Documentation screenshots (docs/screenshots/*.png, 1440×900) of real UI states, produced by the E2E run.
 * Each test also asserts the state it captures, so a broken UI fails here instead of producing a bad picture.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { kineReqLens } from './fixtures';
import { SCREENSHOT_DIR, expect, test, tid } from './fixtures';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function shot(rl: kineReqLens, name: string): Promise<void> {
  // Let transitions, the elapsed timer and debounced renders settle; hide the text caret.
  await rl.page.mouse.move(2, 890);
  await rl.page.waitForTimeout(400);
  await rl.page.screenshot({ path: path.join(SCREENSHOT_DIR, name), caret: 'hide', animations: 'disabled' });
}

async function setTheme(rl: kineReqLens, theme: 'Light' | 'Dark'): Promise<void> {
  await rl.ui.locator(tid('rl-settings')).click();
  await rl.ui.getByRole('radio', { name: theme }).click();
  await rl.page.keyboard.press('Escape');
  await expect(rl.ui.locator('.rl-root')).toHaveAttribute('data-theme', theme.toLowerCase());
}

/** Collapse an editor section (what a user does to focus on the body). */
async function collapse(rl: kineReqLens, id: 'query' | 'headers' | 'body'): Promise<void> {
  const toggle = rl.section(id).locator('.rl-ed-section__toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
}

/** Filling a field scrolls it into view; start the picture at the top of the editor. */
async function editorToTop(rl: kineReqLens): Promise<void> {
  await rl.detail.locator('.rl-ed__scroll').evaluate((el) => el.scrollTo(0, 0));
}

/** Layout guards for the polish fixes these pictures show. */
const layout = {
  /** The list toolbar (record, clear, filter, Types dropdown, New) stays on one row inside the list column. */
  async listToolbarOnOneRow(rl: kineReqLens): Promise<void> {
    const row = rl.ui.locator('.rl-list__toolbar-row');
    const m = await row.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const kids = [...el.children].map((c) => c.getBoundingClientRect());
      return {
        // Vertical centres within 2 px of each other = one row.
        spread: Math.max(...kids.map((r) => r.top + r.height / 2)) - Math.min(...kids.map((r) => r.top + r.height / 2)),
        inside: kids.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1),
      };
    });
    expect(m.spread).toBeLessThanOrEqual(2);
    expect(m.inside).toBe(true);
  },
  /** "Expand all" / "Collapse all" of the response JSON viewer never split across lines. */
  async treeActionsTogether(rl: kineReqLens): Promise<void> {
    const tops = await rl.resultView
      .locator('.rl-jv__toolbar .rl-btn')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops).toHaveLength(2);
    expect(tops[0]).toBe(tops[1]);
  },
  /** A wrapped long string keeps its trailing comma right after the last character (not at the far right). */
  async commaFollowsWrappedValue(rl: kineReqLens): Promise<void> {
    const m = await rl.resultView.locator('.rl-jv__tree').evaluate((tree) => {
      for (const leaf of tree.querySelectorAll('.rl-jv__leaf')) {
        const value = leaf.querySelector('.rl-jv__value');
        const comma = leaf.querySelector(':scope > .rl-jv__punct');
        const lines = value ? [...value.getClientRects()] : [];
        if (!comma || lines.length < 2) continue;
        const last = lines[lines.length - 1]!;
        const c = comma.getBoundingClientRect();
        return { lines: lines.length, sameLine: Math.abs(c.top - last.top) < 4, gap: Math.round(c.left - last.right) };
      }
      return null;
    });
    expect(m, 'a wrapped string value with a trailing comma').not.toBeNull();
    expect(m!.sameLine).toBe(true);
    expect(m!.gap).toBeLessThanOrEqual(1);
  },
};

/** Fire a realistic mix of requests from the app. */
async function populate(rl: kineReqLens): Promise<void> {
  for (const name of ['query', 'json', 'graphql', 'form', 'multipart', 'headers', 'html', 'image', 'beacon', 'xhr-json', 'assets', 'big']) {
    await rl.clickApp(name, { via: 'script' }); // the large window presets cover the app's buttons
  }
  await rl.page.waitForTimeout(400);
}

test.describe('screenshots', () => {
  test('overview-light.png', async ({ rl }) => {
    // Floating window anchored bottom-right (auto position), resized a little beyond the 980×640 default.
    await rl.patchSettings({ layout: { dock: 'float', x: -1, y: -1, w: 1120, h: 760 } });
    await rl.openApp();
    await setTheme(rl, 'Light');
    await populate(rl);
    await rl.select('/api/echo/json');
    await collapse(rl, 'query');
    await collapse(rl, 'headers');
    await rl.jsonValue('user.address.city').fill('Paris');
    expect(await rl.send()).toBe('done');
    await layout.listToolbarOnOneRow(rl);
    await editorToTop(rl);
    await shot(rl, 'overview-light.png');
  });

  test('json-editor.png', async ({ rl }) => {
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 330 } });
    await rl.openApp();
    await populate(rl);
    await rl.select('/api/echo/json');
    await rl.jsonValue('user.address.city').fill('Paris');
    await rl.jsonNode('count').locator(tid('rl-json-type')).selectOption('string');
    await rl.section('body').locator(`${tid('rl-json-add')}[data-path="user"]`).click();
    await rl.jsonNode('user.newKey').locator(tid('rl-json-key')).fill('role');
    await rl.jsonValue('user.role').fill('admin');
    await rl.jsonNode('note').locator(tid('rl-json-delete')).click();
    await collapse(rl, 'query');
    await collapse(rl, 'headers');
    expect(await rl.send()).toBe('done');
    await expect(rl.detail.locator('.rl-detail__split')).toBeVisible();
    await layout.commaFollowsWrappedValue(rl); // the echoed User-Agent wraps in the results column
    await editorToTop(rl);
    await shot(rl, 'json-editor.png');
  });

  test('graphql.png', async ({ rl }) => {
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 330 } });
    await rl.openApp();
    await populate(rl);
    await rl.select('/graphql');
    await rl.jsonValue('variables.id').fill('7');
    await rl.jsonValue('variables.first').fill('25');
    await collapse(rl, 'query');
    await collapse(rl, 'headers');
    expect(await rl.send()).toBe('done');
    await editorToTop(rl);
    await shot(rl, 'graphql.png');
  });

  test('results-compare.png', async ({ rl }) => {
    await rl.patchSettings({ theme: 'light', layout: { dock: 'bottom', dockSize: 640, listWidth: 340, split: 0.44 } });
    await rl.openApp();
    await populate(rl);
    // GraphQL: its echo is compact, so the whole diff against the original response fits under the summary.
    await rl.select('/graphql');
    await collapse(rl, 'query');
    await collapse(rl, 'headers');
    await rl.jsonValue('variables.id').fill('7');
    await rl.jsonValue('variables.first').fill('25');
    expect(await rl.send()).toBe('done');
    await rl.respTab('compare').click();
    const compare = rl.resultView.locator(tid('rl-compare'));
    await expect(compare.locator(tid('rl-compare-original'))).toHaveAttribute('aria-pressed', 'true');
    await expect(compare.locator(tid('rl-compare-counts'))).toBeVisible();
    await expect(compare.locator('.rl-resp-diff__line--add', { hasText: '"first": 25' }).first()).toBeVisible();
    await expect(compare.locator('.rl-resp-diff__line--del', { hasText: '"first": 10' }).first()).toBeVisible();
    await editorToTop(rl);
    await shot(rl, 'results-compare.png');
  });

  test('dark-docked-right.png', async ({ rl }) => {
    await rl.patchSettings({ layout: { dock: 'right', dockSize: 760, listWidth: 300 } });
    await rl.openApp();
    await setTheme(rl, 'Dark');
    await populate(rl);
    await rl.select('/api/echo/query');
    await rl.kvRow('query', 'foo').locator(tid('rl-kv-value')).fill('baz');
    expect(await rl.send()).toBe('done');
    await expect(rl.panel).toHaveAttribute('data-dock', 'right');
    await layout.treeActionsTogether(rl);
    await layout.listToolbarOnOneRow(rl);
    await shot(rl, 'dark-docked-right.png');
  });

  test('context-menu.png', async ({ rl }) => {
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 360 } });
    await rl.openApp();
    await populate(rl);
    await rl.page.evaluate(async () => {
      for (const p of ['/api/echo/standard/custom-report/result/reports/list-all?x=1', '/api/echo/standard/custom-report/result/summary']) {
        await fetch(p).then((r) => r.text());
      }
    });
    const row = rl.row('/reports/list-all');
    await expect(row).toHaveCount(1);
    await row.click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-hide')).hover();
    const options = rl.ui.locator(tid('rl-ctx-hide-option'));
    await expect(options.last()).toContainText('(exact path, any query)');
    // The ladder stays inside the viewport.
    const box = await rl.ui.locator(tid('rl-context-submenu')).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900).toBe(true);
    await rl.page.waitForTimeout(400);
    await rl.page.screenshot({ path: path.join(SCREENSHOT_DIR, 'context-menu.png'), caret: 'hide', animations: 'disabled' });
  });

  test('export-types.png', async ({ rl }) => {
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 330 } });
    await rl.openApp();
    await populate(rl);
    await rl.select('/api/echo/json');
    await collapse(rl, 'query');
    await collapse(rl, 'headers');
    await rl.ui.locator(tid('rl-export-tab')).click();
    await expect(rl.ui.locator(tid('rl-export-code'))).toContainText('export interface');
    await editorToTop(rl);
    await shot(rl, 'export-types.png');
  });

  test('sidebar.png', async ({ rl }) => {
    // The navigation rail expanded (labels, counts, the active view in Kinebot blue) next to the request list.
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 340, railExpanded: true } });
    await rl.openApp();
    await populate(rl);
    await rl.select('/api/echo/json');
    await collapse(rl, 'query');
    await editorToTop(rl);
    const rail = rl.ui.locator(tid('rl-rail'));
    await expect(rail).toHaveAttribute('data-expanded', 'true');
    await expect(rail.locator(`${tid('rl-rail-item')}[data-item="requests"]`)).toHaveAttribute('data-active', 'true');
    // Labels never wrap or overflow the 180 px rail.
    const labels = await rail.locator('.rl-rail__label').evaluateAll((els) => els.map((e) => e.scrollWidth <= e.clientWidth + 1 && e.getClientRects().length === 1));
    expect(labels.every(Boolean)).toBe(true);
    await shot(rl, 'sidebar.png');
    // Review shots (test output only): dark, and a narrow dark dock with the rail forced to icons.
    await setTheme(rl, 'Dark');
    await rl.page.mouse.move(2, 890);
    await rl.page.waitForTimeout(400);
    await rl.page.screenshot({ path: test.info().outputPath('sidebar-dark.png'), caret: 'hide', animations: 'disabled' });
    await rl.patchSettings({ layout: { dock: 'right', dockSize: 460 } });
    await expect(rail).toHaveAttribute('data-expanded', 'false');
    await rl.ui.locator(tid('rl-view-ws')).hover();
    await rl.page.waitForTimeout(400);
    await rl.page.screenshot({ path: test.info().outputPath('sidebar-dark-narrow.png'), caret: 'hide', animations: 'disabled' });
    await setTheme(rl, 'Light');
    await rl.ui.locator(tid('rl-settings')).click();
    await expect(rl.ui.locator(tid('rl-settings-claude'))).toBeVisible();
    await rl.page.waitForTimeout(400);
    await rl.page.screenshot({ path: test.info().outputPath('sidebar-light-narrow-settings.png'), caret: 'hide', animations: 'disabled' });
  });

  test('endpoints.png', async ({ rl }) => {
    // The request list with long, id-heavy URLs: endpoint templates with id chips, "Group by endpoint" with one
    // group expanded (its calls show their concrete ids), and the detail header — light above, dark below.
    await rl.patchSettings({ theme: 'light', layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 600 } });
    await rl.openApp();
    await rl.setListTypes(['fetch']);
    await rl.page.evaluate(async (cross) => {
      const reports = ['9f3c1a2e-4b5d-4c6e-8f70-1a2b3c4d5e6f', '0b7e44a1-2c3d-4e5f-8a9b-c0d1e2f3a4b5', '5d6e7f80-91a2-4b3c-8d4e-5f60718293a4'];
      const get = (p: string) => fetch(p).then((r) => r.text()).catch(() => '');
      await get('/api/echo/v1/users/48213/orders/ORD-2024-000123?expand=items&include=customer');
      await get('/api/echo/accounts/01HZX3K9QJ5V8R2M4N6P7T9W0Y/invoices/2024-05-01/lines');
      for (let i = 0; i < reports.length; i++) {
        await get(`/api/echo/standard/custom-report/result/reports/${reports[i]}/items/${123456 + i}?companyId=${4200 + i}&token=eyJhbGciOiJIUzI1NiJ9${i}&page=${i + 1}&sort=name`);
      }
      await get(`${cross}/api/echo/tenants/7781/feature-flags?env=prod`);
      await get('/api/echo/commits/9f3c1a2e/files?path=src%2Findex.ts');
      await get('/api/echo/assets/main.3f9a8c1d.js');
      await get('/api/echo/users/me');
      await get('/api/echo/search?q=quarterly%20report&page=2&size=50');
    }, rl.server.crossOrigin);
    await expect(rl.row('/reports/')).toHaveCount(3);
    await rl.ui.locator(tid('rl-group-toggle')).click();
    const group = rl.ui.locator(tid('rl-group-row')).first();
    await expect(group).toHaveAttribute('data-count', '3');
    await group.click();
    await rl.page.keyboard.press('ArrowRight');
    await rl.page.keyboard.press('ArrowRight');
    await expect(rl.ui.locator(`${tid('rl-request-row')}[data-group="call"]`)).toHaveCount(3);
    await rl.detail.locator(tid('rl-detail-url-expand')).click();
    await expect(rl.detail.locator(tid('rl-detail-full-url'))).toBeVisible();

    /** Every label fits its cell on one line: laid out to the measured width, never cut by the CSS ellipsis. */
    const labelsFit = async () => {
      const bad = await rl.ui.locator('.rl-req-row__name').evaluateAll((els) =>
        els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getClientRects().length !== 1).map((e) => e.textContent),
      );
      expect(bad).toEqual([]);
    };
    await labelsFit();
    const box = (await rl.panel.boundingBox())!;
    const clip = { x: box.x, y: box.y, width: box.width, height: 470 };
    await rl.page.mouse.move(2, 890);
    await rl.page.waitForTimeout(400);
    const light = await rl.page.screenshot({ clip, caret: 'hide', animations: 'disabled' });
    await setTheme(rl, 'Dark');
    await rl.ui.locator(tid('rl-request-list')).focus(); // not the Settings button the theme switch left focused
    await rl.page.mouse.move(2, 890);
    await rl.page.waitForTimeout(400);
    await labelsFit();
    const dark = await rl.page.screenshot({ clip, caret: 'hide', animations: 'disabled' });

    // Both themes in one picture.
    const sheet = await rl.context.newPage();
    await sheet.setViewportSize({ width: Math.round(clip.width) + 32, height: 2 * clip.height + 48 });
    const img = (png: Buffer) => `<img src="data:image/png;base64,${png.toString('base64')}" style="display:block;width:${clip.width}px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.16)">`;
    await sheet.setContent(
      `<body style="margin:0;padding:16px;background:#ececec;display:flex;flex-direction:column;gap:16px">${img(light)}${img(dark)}</body>`,
    );
    await sheet.screenshot({ path: path.join(SCREENSHOT_DIR, 'endpoints.png'), fullPage: true });
    await sheet.close();
  });

  test('minimized.png', async ({ rl }) => {
    await rl.openApp();
    await setTheme(rl, 'Light');
    await populate(rl);
    await rl.ui.locator(tid('rl-minimize')).click();
    await expect(rl.pill).toBeVisible();
    await shot(rl, 'minimized.png');
  });
});
