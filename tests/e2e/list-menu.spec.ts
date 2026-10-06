/**
 * v0.2 §C — request-row context menu: "Hide requests under ▸" / "Show only requests under ▸" path ladders, URL
 * rules (settings.listRules, rules bar, hidden count, Undo), Copy ▸, Remove from list, keyboard opening.
 */
import type { Frame, Page } from '@playwright/test';
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const DEEP = '/api/echo/standard/custom-report/result/reports/list-all';
const SUMMARY = '/api/echo/standard/custom-report/result/summary';
const ME = '/api/echo/standard/users/me';
const OTHER = '/api/echo/other/thing';

/** The overlay's panel.html frame (cross-origin extension frame). */
function panelFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().startsWith('chrome-extension://') && f.url().includes('/panel.html'));
  if (!frame) throw new Error('panel frame not found');
  return frame;
}

/** Record what the panel copies (navigator.clipboard.writeText) instead of touching the system clipboard. */
async function stubClipboard(page: Page): Promise<() => Promise<string[]>> {
  const frame = panelFrame(page);
  await frame.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void w.__copied.push(text) },
    });
  });
  return () => frame.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

async function listRules(rl: kineReqLens): Promise<Array<Record<string, unknown>>> {
  const sw = await rl.sw();
  return sw.evaluate(async () => {
    const stored = (await chrome.storage.local.get('reqlens:settings'))['reqlens:settings'] as { listRules?: Array<Record<string, unknown>> } | undefined;
    return stored?.listRules ?? [];
  });
}

/** Open the overlay on the test app and fire the four fetches the tests use. */
async function setup(rl: kineReqLens): Promise<void> {
  await rl.gotoApp();
  await rl.openOverlay();
  await rl.page.evaluate(async (paths) => {
    for (const p of paths) await fetch(p).then((r) => r.text());
  }, [`${DEEP}?x=1`, SUMMARY, ME, OTHER]);
  for (const p of [DEEP, SUMMARY, ME, OTHER]) await expect(rl.row(p)).toHaveCount(1);
}

test.describe('list context menu', () => {
  test('Hide requests under ▸ offers the path ladder and hides by prefix, with Undo', async ({ rl }) => {
    await setup(rl);
    const origin = rl.server.origin;
    await rl.row(DEEP).click({ button: 'right' });
    const menu = rl.ui.locator(tid('rl-context-menu'));
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('role', 'menu');
    // Right-click selects the row first.
    await expect(rl.detail).toHaveAttribute('data-entry-id', (await rl.row(DEEP).getAttribute('data-entry-id'))!);

    await rl.ui.locator(tid('rl-ctx-hide')).hover();
    const options = rl.ui.locator(tid('rl-ctx-hide-option'));
    await expect(options).toHaveCount(8);
    expect(await options.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-pattern')} ${e.getAttribute('data-exact')}`))).toEqual([
      `${origin}/ false`,
      `${origin}/api/ false`,
      `${origin}/api/echo/ false`,
      `${origin}/api/echo/standard/ false`,
      `${origin}/api/echo/standard/custom-report/ false`,
      `${origin}/api/echo/standard/custom-report/result/ false`,
      `${origin}/api/echo/standard/custom-report/result/reports/ false`,
      `${origin}${DEEP} true`,
    ]);
    await expect(options.last()).toContainText('(exact path, any query)');
    // Each item says how many current entries it matches.
    await expect(options.nth(4)).toContainText('· 2');
    await expect(options.nth(3)).toContainText('· 3');

    await options.nth(4).click();
    await expect(menu).toHaveCount(0);
    const chip = rl.ui.locator(tid('rl-rule-chip'));
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-mode', 'hide');
    await expect(chip).toContainText('Hidden:');
    await expect(rl.ui.locator(tid('rl-rules-bar'))).toBeVisible();
    // SUMMARY is gone; the selected DEEP row stays listed (dimmed) so the detail pane is not yanked away.
    await expect(rl.row(SUMMARY)).toHaveCount(0);
    await expect(rl.row(DEEP)).toHaveAttribute('data-hidden', 'rule');
    await expect(rl.row(ME)).toHaveCount(1);
    await expect(rl.row(OTHER)).toHaveCount(1);
    await expect(rl.ui.locator(tid('rl-hidden-count'))).toContainText('1 hidden');
    expect(await listRules(rl)).toMatchObject([{ mode: 'hide', pattern: `${origin}/api/echo/standard/custom-report/`, exact: false, enabled: true }]);

    // Selecting another request lets the hidden one go.
    await rl.select(ME);
    await expect(rl.row(DEEP)).toHaveCount(0);
    await expect(rl.ui.locator(tid('rl-hidden-count'))).toContainText('2 hidden');

    // Undo (toast action) removes the rule again.
    await rl.ui.locator(`${tid('rl-toast')} ${tid('rl-toast-action')}`).first().click();
    await expect(chip).toHaveCount(0);
    await expect(rl.row(DEEP)).toHaveCount(1);
    await expect(rl.row(SUMMARY)).toHaveCount(1);
    await expect.poll(() => listRules(rl)).toEqual([]);
  });

  test('Show only requests under ▸ keeps one subtree; chips toggle, dedupe and delete', async ({ rl }) => {
    await setup(rl);
    const origin = rl.server.origin;
    const pickOnly = async (rowPath: string, index: number): Promise<void> => {
      await rl.row(rowPath).click({ button: 'right' });
      await rl.ui.locator(tid('rl-ctx-only')).hover();
      await rl.ui.locator(tid('rl-ctx-only-option')).nth(index).click();
    };
    await pickOnly(ME, 3); // …/api/echo/standard/
    const chip = rl.ui.locator(tid('rl-rule-chip'));
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-mode', 'only');
    await expect(chip).toHaveAttribute('data-pattern', `${origin}/api/echo/standard/`);
    await expect(rl.row(OTHER)).toHaveCount(0);
    await expect(rl.row('/static/app.css')).toHaveCount(0);
    for (const p of [DEEP, SUMMARY, ME]) await expect(rl.row(p)).toHaveCount(1);

    // The same rule again re-enables instead of duplicating; its ladder item shows as checked.
    await chip.locator(tid('rl-rule-toggle')).click();
    await expect(chip).toHaveAttribute('data-enabled', 'false');
    await expect(rl.row(OTHER)).toHaveCount(1);
    await pickOnly(ME, 3);
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-enabled', 'true');
    await expect(rl.row(OTHER)).toHaveCount(0);

    // Manual entries are never hidden by rules.
    await rl.ui.locator(tid('rl-new-request')).click();
    await expect(rl.ui.locator(`${tid('rl-request-row')}[data-kind="manual"]`)).toHaveCount(1);

    // × deletes the rule; every request is back.
    await chip.locator(tid('rl-rule-delete')).click();
    await expect(chip).toHaveCount(0);
    await expect(rl.row(OTHER)).toHaveCount(1);
    await expect.poll(() => listRules(rl)).toEqual([]);
  });

  test('Copy ▸ URL / Types, Remove from list and restore', async ({ rl, page }) => {
    await setup(rl);
    const copied = await stubClipboard(page);
    await rl.row(ME).click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-copy')).hover();
    await rl.ui.locator(tid('rl-ctx-copy-url')).click();
    await expect.poll(copied).toEqual([`${rl.server.origin}${ME}`]);

    await rl.row(ME).click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-copy')).hover();
    await rl.ui.locator(tid('rl-ctx-copy-types')).click();
    await expect.poll(async () => (await copied()).length).toBe(2);
    const types = (await copied())[1]!;
    expect(types).toContain('export interface');
    expect(types).toMatch(/Response\b/);

    await rl.row(ME).click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-copy')).hover();
    await rl.ui.locator(tid('rl-ctx-copy-prompt')).click();
    await expect.poll(async () => (await copied()).length).toBe(3);
    expect((await copied())[2]).toMatch(/^<!-- Generated by kineReqLens from /);

    // Remove from list: hidden in this panel until restored.
    await rl.row(OTHER).click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-remove')).click();
    await rl.select(ME);
    await expect(rl.row(OTHER)).toHaveCount(0);
    const restore = rl.ui.locator(tid('rl-removed-restore'));
    await expect(restore).toContainText('1 removed');
    await restore.click();
    await expect(rl.row(OTHER)).toHaveCount(1);
  });

  test('keyboard: Shift+F10 opens the menu on the focused row, → opens the ladder, Escape closes', async ({ rl }) => {
    await setup(rl);
    await rl.select(ME);
    await rl.row(ME).focus();
    await rl.page.keyboard.press('Shift+F10');
    const menu = rl.ui.locator(tid('rl-context-menu'));
    await expect(menu).toBeVisible();
    await expect(rl.ui.locator(tid('rl-ctx-hide'))).toBeFocused();
    await rl.page.keyboard.press('ArrowRight');
    await expect(rl.ui.locator(tid('rl-ctx-hide-option')).first()).toBeFocused();
    await rl.page.keyboard.press('ArrowLeft');
    await expect(rl.ui.locator(tid('rl-ctx-hide-option'))).toHaveCount(0);
    await expect(rl.ui.locator(tid('rl-ctx-hide'))).toBeFocused();
    await rl.page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // The ⋯ row button opens the same menu.
    await rl.row(ME).hover();
    await rl.row(ME).locator(tid('rl-row-menu')).click();
    await expect(menu).toBeVisible();
    await rl.page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------------------
// Endpoint templates (row labels with id chips, detail header, URL display setting) and "Group by endpoint".

const REPORT_IDS = ['9f3c1a2e-4b5d-4c6e-8f70-1a2b3c4d5e6f', '0b7e44a1-2c3d-4e5f-8a9b-c0d1e2f3a4b5', '5d6e7f80-91a2-4b3c-8d4e-5f60718293a4'];
const reportUrl = (i: number) =>
  `/api/echo/standard/custom-report/result/reports/${REPORT_IDS[i]}/items/${123456 + i}?companyId=${4200 + i}&token=abc${i}def&page=${i + 1}`;
const REPORT_TEMPLATE = '/api/echo/standard/custom-report/result/reports/{uuid}/items/{id}';

async function storedSettings(rl: kineReqLens): Promise<Record<string, unknown>> {
  const sw = await rl.sw();
  return sw.evaluate(async () => ((await chrome.storage.local.get('reqlens:settings'))['reqlens:settings'] ?? {}) as Record<string, unknown>);
}

/** Open the overlay and fire three calls of one id-heavy endpoint plus two other requests. */
async function setupEndpoints(rl: kineReqLens): Promise<void> {
  await rl.gotoApp();
  await rl.openOverlay();
  await rl.page.evaluate(async (paths) => {
    for (const p of paths) await fetch(p).then((r) => r.text());
  }, [reportUrl(0), ME, reportUrl(1), OTHER, reportUrl(2)]);
  for (const p of ['/reports/', ME, OTHER]) await expect(rl.row(p).first()).toBeVisible();
  await expect(rl.row('/reports/')).toHaveCount(3);
}

test.describe('endpoint templates and grouping', () => {
  test('rows label endpoints as templates with id chips; the detail header too; "Full path" shows raw URLs', async ({ rl }) => {
    // A wide list: the whole template fits.
    await rl.patchSettings({ layout: { dock: 'float', x: 24, y: 24, w: 1392, h: 852, listWidth: 760 } });
    await setupEndpoints(rl);
    const origin = rl.server.origin;
    const row = rl.row(REPORT_IDS[2]!);
    await expect(row).toHaveAttribute('data-template', `${origin}${REPORT_TEMPLATE}`);
    // The id segments are chips showing their kind; the real value is in the chip's tooltip.
    const chips = row.locator('.rl-ep__chip');
    await expect(chips).toHaveText(['{uuid}', '{id}']);
    await expect(chips.first()).toHaveAttribute('title', `uuid: ${REPORT_IDS[2]}`);
    await expect(chips.last()).toHaveAttribute('title', 'id: 123458');
    // No raw id is printed in the label; the full URL stays in the row tooltip.
    await expect(row.locator('.rl-req-row__name')).not.toContainText(REPORT_IDS[2]!);
    await expect(row).toHaveAttribute('title', new RegExp(`^GET ${origin.replace(/[.]/g, '\\.')}.*${REPORT_IDS[2]}/items/123458\\?companyId=4202`));
    // Query: parameter names only, values on hover.
    const query = row.locator(tid('rl-ep-query'));
    await expect(query).toHaveText(/^\?(companyId|3 params)/);
    await expect(query).toHaveAttribute('title', 'companyId=4202\ntoken=abc2def\npage=3');
    // One line, inside the row (rows are --rl-list-row-h: 30 px, what the list virtualizer reads as --rl-row-h).
    const m = await row.evaluate((el) => {
      const name = el.querySelector('.rl-req-row__name')!;
      const box = el.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      const token = parseFloat(getComputedStyle(el).getPropertyValue('--rl-row-h'));
      return { height: Math.round(box.height), token, lines: name.getClientRects().length, inside: n.right <= box.right + 1, scroll: el.scrollWidth <= el.clientWidth + 1 };
    });
    expect(m).toEqual({ height: 30, token: 30, lines: 1, inside: true, scroll: true });

    // A narrow list elides the middle of the path but keeps its tail.
    await rl.patchSettings({ layout: { listWidth: 300 } });
    await expect(row.locator('.rl-ep__gap')).toHaveCount(1);
    await expect(row.locator('.rl-ep__chip').last()).toHaveText('{id}');

    // Detail header: the same template; the full URL expands below it.
    await rl.select(REPORT_IDS[2]!);
    const url = rl.detail.locator(tid('rl-detail-url'));
    await expect(url.locator('.rl-ep__chip').first()).toHaveText('{uuid}');
    await expect(url).toHaveAttribute('title', `${origin}${reportUrl(2)}`);
    await rl.detail.locator(tid('rl-detail-url-expand')).click();
    await expect(rl.detail.locator(tid('rl-detail-full-url'))).toHaveText(`${origin}${reportUrl(2)}`);
    await rl.detail.locator(tid('rl-detail-url-expand')).click();
    await expect(rl.detail.locator(tid('rl-detail-full-url'))).toHaveCount(0);

    // Settings → URL display → Full path: raw paths, no chips (persisted).
    await rl.ui.locator(tid('rl-settings')).click();
    const display = rl.ui.locator(tid('rl-url-display'));
    await expect(display.locator('[data-value="template"]')).toHaveAttribute('aria-checked', 'true');
    await display.locator('[data-value="full"]').click();
    await rl.page.keyboard.press('Escape');
    await expect(row.locator('.rl-ep__chip')).toHaveCount(0);
    await expect(row.locator('.rl-req-row__path')).toHaveText(`/api/echo/standard/custom-report/result/reports/${REPORT_IDS[2]}/items/123458`);
    await expect(url).toHaveText(`${origin}${reportUrl(2)}`);
    await expect.poll(async () => (await storedSettings(rl)).urlDisplay).toBe('full');
    await rl.patchSettings({ urlDisplay: 'template' });
    await expect(row.locator('.rl-ep__chip').last()).toHaveText('{id}');
  });

  test('Group by endpoint: one row per method + template; expand, keyboard, mixed status, persisted', async ({ rl }) => {
    await setupEndpoints(rl);
    // Same template, different outcomes: one finished call and one canceled call of /api/slow.
    await rl.page.evaluate(async () => {
      await fetch('/api/slow?ms=10').then((r) => r.text());
      const ctrl = new AbortController();
      const pending = fetch('/api/slow?ms=4000', { signal: ctrl.signal }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      ctrl.abort();
      await pending;
    });
    await expect(rl.row('/api/slow')).toHaveCount(2);

    const toggle = rl.ui.locator(tid('rl-group-toggle'));
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await storedSettings(rl)).listGroup).toBe(true);

    const group = rl.ui.locator(`${tid('rl-group-row')}[data-template="${rl.server.origin}${REPORT_TEMPLATE}"]`);
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('data-count', '3');
    await expect(group).toHaveAttribute('data-expanded', 'false');
    await expect(group.locator(tid('rl-group-count'))).toHaveText('×3');
    await expect(group.locator('.rl-req-row__status')).toHaveText('200');
    await expect(rl.row('/reports/')).toHaveCount(0); // collapsed
    await expect(rl.row(ME)).toHaveCount(1); // singles stay plain rows
    const slow = rl.ui.locator(`${tid('rl-group-row')}[data-template="${rl.server.origin}/api/slow"]`);
    await expect(slow).toHaveAttribute('data-mixed', 'true');
    await expect(slow.locator(tid('rl-group-mixed'))).toHaveCount(1);

    // Picking the group shows its newest call.
    await group.click();
    await expect(group).toHaveAttribute('aria-selected', 'true');
    await expect(rl.detail).toHaveAttribute('data-entry-id', /.+/);
    const detailUrl = rl.detail.locator(tid('rl-detail-url'));
    await expect(detailUrl).toHaveAttribute('title', `${rl.server.origin}${reportUrl(2)}`);

    // Keyboard: → expands, → enters the first (newest) call, ← back to the group, ← collapses.
    await rl.page.keyboard.press('ArrowRight');
    await expect(group).toHaveAttribute('data-expanded', 'true');
    const calls = rl.ui.locator(`${tid('rl-request-row')}[data-group="call"]`);
    await expect(calls).toHaveCount(3);
    await rl.page.keyboard.press('ArrowRight');
    await expect(calls.first()).toHaveAttribute('aria-selected', 'true');
    await expect(calls.first()).toHaveAttribute('data-url', `${rl.server.origin}${reportUrl(2)}`);
    // Calls under the group show their concrete ids (the group row shows the kinds).
    await expect(calls.first().locator('.rl-ep__chip').last()).toHaveText('123458');
    await expect(group.locator('.rl-ep__chip').last()).toHaveText('{id}');
    await rl.page.keyboard.press('ArrowDown');
    await expect(calls.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rl.detail.locator(tid('rl-detail-url'))).toHaveAttribute('title', `${rl.server.origin}${reportUrl(1)}`);
    await rl.page.keyboard.press('ArrowLeft');
    await expect(group).toHaveAttribute('aria-selected', 'true');
    await rl.page.keyboard.press('ArrowLeft');
    await expect(group).toHaveAttribute('data-expanded', 'false');
    await expect(calls).toHaveCount(0);
    // The chevron toggles too.
    await group.locator(tid('rl-group-expand')).click();
    await expect(calls).toHaveCount(3);
    await group.locator(tid('rl-group-expand')).click();
    await expect(calls).toHaveCount(0);

    // Off again: every call is a row.
    await toggle.click();
    await expect(rl.ui.locator(tid('rl-group-row'))).toHaveCount(0);
    await expect(rl.row('/reports/')).toHaveCount(3);
    await expect.poll(async () => (await storedSettings(rl)).listGroup).toBe(false);
  });

  test('group row menu: Hide / Show only this endpoint (template rules), the template ladder, Remove', async ({ rl }) => {
    await setupEndpoints(rl);
    const origin = rl.server.origin;
    const template = `${origin}${REPORT_TEMPLATE}`;
    await rl.ui.locator(tid('rl-group-toggle')).click();
    const group = rl.ui.locator(`${tid('rl-group-row')}[data-template="${template}"]`);
    await expect(group).toHaveCount(1);

    // The ladder only offers prefixes every call of the endpoint falls under (no id segments, no exact path).
    await group.click({ button: 'right' });
    const menu = rl.ui.locator(tid('rl-group-menu'));
    await expect(menu).toBeVisible();
    await expect(rl.ui.locator(tid('rl-ctx-hide-template'))).toContainText('· 3');
    await rl.ui.locator(tid('rl-ctx-hide')).hover();
    await expect(rl.ui.locator(tid('rl-ctx-hide-option'))).toHaveCount(7);
    expect(await rl.ui.locator(tid('rl-ctx-hide-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-pattern')))).toEqual([
      `${origin}/`,
      `${origin}/api/`,
      `${origin}/api/echo/`,
      `${origin}/api/echo/standard/`,
      `${origin}/api/echo/standard/custom-report/`,
      `${origin}/api/echo/standard/custom-report/result/`,
      `${origin}/api/echo/standard/custom-report/result/reports/`,
    ]);
    await rl.page.keyboard.press('Escape');
    await rl.page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Hide this endpoint: a template rule (any method, any query), with a rules-bar chip and Undo.
    await group.click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-hide-template')).click();
    const chip = rl.ui.locator(tid('rl-rule-chip'));
    await expect(chip).toHaveAttribute('data-template', template);
    await expect(chip).toContainText('Hidden:');
    await expect.poll(() => listRules(rl)).toMatchObject([{ mode: 'hide', pattern: '', template, exact: true, enabled: true }]);
    await rl.select(ME);
    await expect(group).toHaveCount(0);
    await expect(rl.row('/reports/')).toHaveCount(0);
    await expect(rl.ui.locator(tid('rl-hidden-count'))).toContainText('3 hidden');
    await rl.ui.locator(`${tid('rl-toast')} ${tid('rl-toast-action')}`).first().click();
    await expect(chip).toHaveCount(0);
    await expect(group).toHaveCount(1);

    // Show only this endpoint: everything else goes (also while ungrouped).
    await group.click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-only-template')).click();
    await expect(chip).toHaveAttribute('data-mode', 'only');
    await rl.ui.locator(tid('rl-group-toggle')).click();
    await expect(rl.row('/reports/')).toHaveCount(3);
    await expect(rl.row(ME)).toHaveCount(0);
    await expect(rl.row(OTHER)).toHaveCount(0);
    await chip.locator(tid('rl-rule-delete')).click();
    await expect(rl.row(ME)).toHaveCount(1);

    // Remove N calls from list.
    await rl.ui.locator(tid('rl-group-toggle')).click();
    await group.click({ button: 'right' });
    await expect(rl.ui.locator(tid('rl-ctx-remove'))).toHaveText(/Remove 3 calls from list/);
    await rl.ui.locator(tid('rl-ctx-remove')).click();
    await rl.select(ME);
    await expect(group).toHaveCount(0);
    await expect(rl.ui.locator(tid('rl-removed-restore'))).toContainText('3 removed');
    // Shift+F10 on the group row opens the group menu from the keyboard.
    await rl.ui.locator(tid('rl-removed-restore')).click();
    await group.click();
    await rl.page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await expect(rl.ui.locator(tid('rl-ctx-hide-template'))).toBeFocused();
    await rl.page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});
