/**
 * Setups (saved request-list configurations): save the current types / rules, change them, apply a setup again
 * (Undo), auto-apply on the page host after a reload, no auto-apply over unsaved changes (offer instead),
 * import from a file, rename / delete with Undo.
 */
import type { Locator } from '@playwright/test';
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const ONE = '/api/echo/setups-a/one';
const TWO = '/api/echo/setups-b/two';

async function fire(rl: kineReqLens): Promise<void> {
  await rl.page.evaluate(async (paths) => {
    for (const p of paths) await fetch(p).then((r) => r.text());
  }, [ONE, TWO]);
  await expect(rl.row(TWO)).toHaveCount(1);
}

function setupsButton(rl: kineReqLens): Locator {
  return rl.ui.locator(tid('rl-setups-button'));
}

async function openSetups(rl: kineReqLens): Promise<Locator> {
  const panel = rl.ui.locator(tid('rl-setups-panel'));
  if (!(await panel.isVisible().catch(() => false))) await setupsButton(rl).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function closeSetups(rl: kineReqLens): Promise<void> {
  await rl.ui.locator(tid('rl-setups-panel')).press('Escape');
  await expect(rl.ui.locator(tid('rl-setups-panel'))).toHaveCount(0);
}

async function saveCurrentAs(rl: kineReqLens, name: string, opts: { auto?: boolean; group?: string } = {}): Promise<void> {
  const panel = await openSetups(rl);
  await panel.locator(tid('rl-setups-save-open')).click();
  await panel.locator(tid('rl-setup-name')).fill(name);
  if (opts.group) await panel.locator(tid('rl-setup-group')).fill(opts.group);
  if (opts.auto) await panel.locator(tid('rl-setup-auto')).check();
  await panel.locator(tid('rl-setup-save')).click();
  await expect(panel.locator(`${tid('rl-setup-row')}[data-name="${name}"]`)).toHaveAttribute('data-active', 'true');
  await closeSetups(rl);
}

function setupRow(rl: kineReqLens, name: string): Locator {
  return rl.ui.locator(`${tid('rl-setup-row')}[data-name="${name}"]`);
}

async function stored(rl: kineReqLens): Promise<{ setups: Array<Record<string, unknown>>; activeSetupId: string | null; listTypes: string[]; listRules: unknown[] }> {
  const s = await rl.storedSettings();
  return {
    setups: (s.setups as Array<Record<string, unknown>>) ?? [],
    activeSetupId: (s.activeSetupId as string | null) ?? null,
    listTypes: (s.listTypes as string[]) ?? ['fetch'],
    listRules: (s.listRules as unknown[]) ?? [],
  };
}

test.describe('setups', () => {
  test('save → change rules → apply (Undo) → auto-apply on reload', async ({ rl }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    await fire(rl);
    const host = new URL(rl.server.origin).host;
    await expect(setupsButton(rl)).toContainText('Setups');

    // A rule hiding /api/echo/setups-a/ (row context menu), then select another row so ONE leaves the list.
    await rl.row(ONE).click({ button: 'right' });
    await rl.ui.locator(tid('rl-ctx-hide')).hover();
    await rl.ui.locator(`${tid('rl-ctx-hide-option')}[data-pattern="${rl.server.origin}/api/echo/setups-a/"]`).click();
    await rl.select(TWO);
    await expect(rl.row(ONE)).toHaveCount(0);

    // Save it, auto-applied on this host.
    await saveCurrentAs(rl, 'Hide A', { auto: true });
    await expect(setupsButton(rl)).toContainText('Hide A');
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'false');
    await expect.poll(async () => (await stored(rl)).setups.map((s) => [s.name, s.sites])).toEqual([['Hide A', [host]]]);
    const hideA = (await stored(rl)).setups[0]!.id as string;
    expect((await stored(rl)).activeSetupId).toBe(hideA);
    await openSetups(rl);
    await expect(setupRow(rl, 'Hide A').locator(tid('rl-setup-summary'))).toHaveText('Fetch/XHR · 1 rule · 1 site');
    await closeSetups(rl);

    // Change the rules: the setup shows as modified.
    await rl.ui.locator(tid('rl-rule-delete')).click();
    await expect(rl.row(ONE)).toHaveCount(1);
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'true');
    await expect(rl.ui.locator(tid('rl-setups-modified'))).toBeVisible();

    // Apply brings the rule back; Undo restores the changed state.
    await openSetups(rl);
    await expect(rl.ui.locator(tid('rl-setups-update-active'))).toContainText("Update 'Hide A' with current");
    await setupRow(rl, 'Hide A').locator(tid('rl-setup-apply')).click();
    await expect(rl.ui.locator(tid('rl-rule-chip'))).toHaveCount(1);
    await expect(rl.row(ONE)).toHaveCount(0);
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'false');
    await rl.toast("Applied setup 'Hide A'").locator(tid('rl-toast-action')).click();
    await expect(rl.ui.locator(tid('rl-rule-chip'))).toHaveCount(0);
    await expect(rl.row(ONE)).toHaveCount(1);
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'true');

    // The type filter is persisted: All types, then a second setup "Everything" (no sites) becomes active.
    await rl.ui.locator(tid('rl-types-menu')).click();
    await rl.ui.getByRole('button', { name: 'All types' }).click();
    await expect.poll(async () => (await stored(rl)).listTypes).toEqual([]);
    await saveCurrentAs(rl, 'Everything');
    await expect(setupsButton(rl)).toContainText('Everything');
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'false');

    // Reload: "Hide A" matches the host and "Everything" has no unsaved changes → auto-applied.
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.panel).toBeVisible();
    await expect(rl.toast(`Applied setup 'Hide A' for ${host}`)).toBeVisible();
    await expect(setupsButton(rl)).toContainText('Hide A');
    await expect.poll(async () => (await stored(rl)).activeSetupId).toBe(hideA);
    await expect.poll(async () => (await stored(rl)).listTypes).toEqual(['fetch']);
    await expect(rl.ui.locator(tid('rl-rule-chip'))).toHaveCount(1);
    await fire(rl);
    await expect(rl.row(ONE)).toHaveCount(0);
    // Page-load requests were captured (overlay open during the reload), the restored Fetch/XHR filter hides them.
    await expect(rl.row('/api/echo/onload-xhr')).toHaveCount(1);
    await expect(rl.row('/static/app.css')).toHaveCount(0);
  });

  test('never auto-applies over unsaved changes of another setup: offers it instead', async ({ rl }) => {
    await rl.gotoApp();
    const host = new URL(rl.server.origin).host;
    const now = Date.now();
    await rl.patchSettings({
      setups: [
        { id: 'auto', name: 'Auto', group: '', sites: [host], config: { listTypes: [], listRules: [] }, createdAt: now, updatedAt: now },
        { id: 'mine', name: 'Mine', group: '', sites: [], config: { listTypes: ['fetch'], listRules: [] }, createdAt: now, updatedAt: now },
      ],
      activeSetupId: 'mine',
      listTypes: ['doc'], // ≠ Mine's Fetch/XHR: unsaved changes
    });
    await rl.openOverlay();
    const offer = rl.toast(`Setup 'Auto' matches ${host}`);
    await expect(offer).toBeVisible();
    await expect(setupsButton(rl)).toContainText('Mine');
    await expect(setupsButton(rl)).toHaveAttribute('data-modified', 'true');
    expect((await stored(rl)).listTypes).toEqual(['doc']);
    await offer.locator(tid('rl-toast-action')).click();
    await expect(setupsButton(rl)).toContainText('Auto');
    await expect.poll(async () => (await stored(rl)).listTypes).toEqual([]);
    await expect.poll(async () => (await stored(rl)).activeSetupId).toBe('auto');
  });

  test('import (merge), groups, rename and delete with Undo', async ({ rl }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    await saveCurrentAs(rl, 'Local');
    const file = {
      kind: 'kinereqlens-setups',
      version: 1,
      setups: [
        { id: 'x1', name: 'Staging', group: 'Kinebot', sites: ['*.kinebot.com.br'], config: { listTypes: ['fetch', 'doc'], listRules: [] }, createdAt: 1, updatedAt: 1 },
        { id: 'x2', name: 'Prod', group: 'Kinebot', sites: [], config: { listTypes: ['fetch'], listRules: [], defaultMode: 'extension' }, createdAt: 1, updatedAt: 1 },
        { name: '', config: {} },
      ],
    };
    const panel = await openSetups(rl);
    await panel.locator(tid('rl-setups-import-file')).setInputFiles({
      name: 'setups.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
    const confirm = panel.locator(tid('rl-setups-import-confirm'));
    await expect(confirm).toContainText('2 setups in the file · 1 invalid skipped');
    await expect(confirm.locator(tid('rl-setups-import-merge'))).toBeChecked();
    await confirm.locator(tid('rl-setups-import-apply')).click();
    await expect(rl.toast('Imported setups: 2 new')).toBeVisible();
    await expect(panel.locator(tid('rl-setup-row'))).toHaveCount(3);
    // Ungrouped first, then the group (collapsible).
    expect(await panel.locator(tid('rl-setup-row')).evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))).toEqual(['Local', 'Prod', 'Staging']);
    await expect(setupRow(rl, 'Prod').locator(tid('rl-setup-summary'))).toHaveText('Fetch/XHR · Extension mode');
    const group = panel.locator(`${tid('rl-setups-group')}[data-group="Kinebot"]`);
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator(tid('rl-setup-row'))).toHaveCount(1);
    await group.click();
    await expect(panel.locator(tid('rl-setup-row'))).toHaveCount(3);

    // Rename from the ⋯ menu.
    await setupRow(rl, 'Prod').locator(tid('rl-setup-menu')).click();
    await rl.ui.locator(tid('rl-setup-rename')).click();
    const input = panel.locator(tid('rl-setup-rename-input'));
    await input.fill('Production');
    await input.press('Enter');
    await expect(setupRow(rl, 'Production')).toHaveCount(1);
    await expect(panel).toBeVisible();

    // Delete with Undo.
    await setupRow(rl, 'Staging').locator(tid('rl-setup-menu')).click();
    await rl.ui.locator(tid('rl-setup-delete')).click();
    await expect(setupRow(rl, 'Staging')).toHaveCount(0);
    await expect.poll(async () => (await stored(rl)).setups.length).toBe(2);
    await rl.toast("Deleted setup 'Staging'").locator(tid('rl-toast-action')).click();
    await openSetups(rl);
    await expect(setupRow(rl, 'Staging')).toHaveCount(1);
    await expect.poll(async () => (await stored(rl)).setups.map((s) => s.name)).toEqual(['Local', 'Staging', 'Production']);
  });
});
