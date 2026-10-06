/**
 * "Site language" (docs/ARCHITECTURE.md §11): the rail's Language tool overrides Accept-Language (DNR session rules)
 * and navigator.language / the Intl default locale (MAIN-world hook) for this tab or this site, without touching the
 * browser's settings. Tab scope: document + fetch carry the header, the page's language APIs report it, another tab is
 * unaffected, extension-mode replays send it, Reset restores the defaults. Site scope: applied live (languagechange),
 * persisted in settings.siteLanguages, kept across reloads and in new tabs of that host, Reset removes it.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

interface PageLanguage {
  language: string;
  languages: string[];
  numberLocale: string;
  dateLocale: string;
  formatted: string;
}

function pageLanguage(page: Page): Promise<PageLanguage> {
  return page.evaluate(() => ({
    language: navigator.language,
    languages: [...navigator.languages],
    numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
    dateLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    formatted: (1234.5).toLocaleString(),
  }));
}

async function fetchAcceptLanguage(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (p) => {
    const echo = (await (await fetch(p)).json()) as { headers: Record<string, string> };
    return echo.headers['accept-language'];
  }, path);
}

/** Accept-Language of the latest document request for `path` the server received. */
function documentAcceptLanguage(rl: kineReqLens, path: string): string | undefined {
  const requests = rl.server.requestsTo(path, 'GET');
  const last = requests[requests.length - 1];
  const value = last?.headers['accept-language'];
  return Array.isArray(value) ? value.join(', ') : value;
}

async function openLanguage(rl: kineReqLens): Promise<Locator> {
  const panel = rl.ui.locator(tid('rl-language-panel'));
  if (!(await panel.isVisible().catch(() => false))) await rl.ui.locator(tid('rl-language-button')).click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Click a control that reloads the page and wait for the app to be ready again. */
async function reloadingClick(rl: kineReqLens, target: Locator): Promise<void> {
  await Promise.all([rl.page.waitForEvent('load'), target.click()]);
  await rl.waitForApp();
  await expect(rl.panel).toBeVisible();
}

/**
 * Close a second tab of the context. Headless Chromium then keeps routing input over the bottom ~90 px of the first
 * tab's (cross-origin) overlay iframe to the page — the strip the second tab's UI took — until the viewport changes,
 * so clicks on panel controls down there would miss. A 1 px viewport nudge makes it recompute its input regions.
 */
async function closeOtherTab(rl: kineReqLens, other: Page): Promise<void> {
  await other.close();
  const size = rl.page.viewportSize();
  if (!size) return;
  await rl.page.setViewportSize({ width: size.width, height: size.height - 1 });
  await rl.page.setViewportSize(size);
}

test('tab scope: header on document and fetch, navigator + Intl, other tab unaffected, extension replay, reset', async ({ rl, context, page }) => {
  await rl.patchSettings({ listTypes: [] });
  await rl.gotoApp();
  const before = await pageLanguage(page);
  const beforeHeader = documentAcceptLanguage(rl, '/app');
  expect(before.language).not.toBe('pt-BR');
  expect(beforeHeader).toBeTruthy();
  expect(beforeHeader).not.toContain('pt-BR');
  await rl.openOverlay();

  const rail = rl.ui.locator(`${tid('rl-rail-item')}[data-item="language"]`);
  await expect(rail).toBeVisible();
  await expect(rl.ui.locator(tid('rl-language-badge'))).toHaveCount(0);
  await expect(rl.ui.locator(tid('rl-language-indicator'))).toHaveCount(0);

  const panel = await openLanguage(rl);
  await expect(panel.locator(tid('rl-language-state'))).toHaveAttribute('data-state', 'default');
  // Validation: a garbage tag and a bad weight.
  await panel.locator(tid('rl-language-search')).fill('not_a_tag!');
  await expect(panel.locator(tid('rl-language-invalid'))).toBeVisible();
  await panel.locator(tid('rl-language-search')).fill('portug');
  await panel.locator(`${tid('rl-language-option')}[data-tag="pt-BR"]`).click();
  await panel.locator(tid('rl-language-fallbacks')).fill('en;q=2');
  await expect(panel.locator(tid('rl-language-error'))).toBeVisible();
  await expect(panel.locator(tid('rl-language-apply'))).toBeDisabled();
  await panel.locator(tid('rl-language-fallbacks')).fill('');
  await expect(panel.locator(tid('rl-language-preview'))).toHaveText('Accept-Language: pt-BR');
  await expect(panel.locator(tid('rl-language-scope-tab'))).toBeChecked();
  await expect(panel.locator(tid('rl-language-reload'))).toBeChecked();

  // Apply reloads the page once: the document request and the page's scripts see the language.
  await reloadingClick(rl, panel.locator(tid('rl-language-apply')));
  expect(documentAcceptLanguage(rl, '/app')).toBe('pt-BR');
  expect(documentAcceptLanguage(rl, '/static/app.js')).toBe('pt-BR');
  expect(await fetchAcceptLanguage(page, '/api/echo/lang-fetch')).toBe('pt-BR');
  await expect.poll(() => page.evaluate(() => navigator.language)).toBe('pt-BR');
  expect(await pageLanguage(page)).toEqual({
    language: 'pt-BR',
    languages: ['pt-BR'],
    numberLocale: 'pt-BR',
    dateLocale: 'pt-BR',
    formatted: '1.234,5',
  });
  // The wrappers look native and keep the usual invariants; explicit locales still win.
  expect(
    await page.evaluate(() => ({
      getter: Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')!.get!.toString(),
      ctor: Function.prototype.toString.call(Intl.NumberFormat),
      name: Intl.NumberFormat.name,
      instance: new Intl.NumberFormat() instanceof Intl.NumberFormat,
      constructor: new Intl.Collator().constructor === Intl.Collator,
      explicit: (1234.5).toLocaleString('en-US'),
      date: new Date(Date.UTC(2026, 0, 31, 12)).toLocaleDateString(undefined, { timeZone: 'UTC' }),
      compare: ['b', 'a'].sort((x, y) => x.localeCompare(y)).join(''),
      frozen: Object.isFrozen(navigator.languages) && navigator.languages === navigator.languages,
    })),
  ).toEqual({
    getter: 'function get language() { [native code] }',
    ctor: 'function NumberFormat() { [native code] }',
    name: 'NumberFormat',
    instance: true,
    constructor: true,
    explicit: '1,234.5',
    date: '31/01/2026',
    compare: 'ab',
    frozen: true,
  });

  await expect(rl.ui.locator(tid('rl-language-badge'))).toHaveText('pt-BR');
  await expect(rl.ui.locator(tid('rl-language-indicator'))).toHaveAttribute('data-language', 'pt-BR');
  await expect(rl.ui.locator(tid('rl-language-indicator'))).toHaveAttribute('data-scope', 'tab');

  // Extension-mode replays (the worker's own fetch) send the tab's language too.
  await page.evaluate(() => fetch('/api/echo/lang-replay').then((r) => r.text()));
  await rl.select('/api/echo/lang-replay');
  await rl.setMode('extension');
  expect(await rl.send()).toBe('done');
  expect((await rl.echo()).headers['accept-language']).toBe('pt-BR');

  // Another tab (same site) keeps the browser's language.
  const other = await context.newPage();
  await other.goto(`${rl.server.origin}/blank`);
  expect(documentAcceptLanguage(rl, '/blank')).toBe(beforeHeader);
  expect(await fetchAcceptLanguage(other, '/api/echo/lang-other')).toBe(beforeHeader);
  expect((await pageLanguage(other)).language).toBe(before.language);
  await closeOtherTab(rl, other);

  // Reset (reloads): back to the defaults.
  const again = await openLanguage(rl);
  await expect(again.locator(tid('rl-language-state'))).toHaveAttribute('data-state', 'override');
  await expect(again.locator(tid('rl-language-state'))).toHaveAttribute('data-scope', 'tab');
  await reloadingClick(rl, again.locator(tid('rl-language-reset')));
  expect(documentAcceptLanguage(rl, '/app')).toBe(beforeHeader);
  expect(await fetchAcceptLanguage(page, '/api/echo/lang-after')).toBe(beforeHeader);
  expect(await pageLanguage(page)).toEqual(before);
  await expect(rl.ui.locator(tid('rl-language-indicator'))).toHaveCount(0);
  await expect(rl.ui.locator(tid('rl-language-badge'))).toHaveCount(0);
});

test('site scope: live switch with languagechange, persisted across reloads and tabs, reset', async ({ rl, context, page }) => {
  await rl.gotoApp();
  const before = await pageLanguage(page);
  const beforeHeader = documentAcceptLanguage(rl, '/app');
  await rl.openOverlay();
  await page.evaluate(() => {
    const w = window as unknown as { __langChanges: string[] };
    w.__langChanges = [];
    window.addEventListener('languagechange', () => w.__langChanges.push(navigator.language));
  });

  const panel = await openLanguage(rl);
  // A tag that is not in the list: offered as a custom tag (canonicalized).
  await panel.locator(tid('rl-language-search')).fill('de-at');
  await panel.locator(tid('rl-language-custom')).click();
  await panel.locator(tid('rl-language-fallbacks')).fill('en;q=0.8');
  await expect(panel.locator(tid('rl-language-preview'))).toHaveText('Accept-Language: de-AT,en;q=0.8');
  await panel.locator(tid('rl-language-scope-site')).check();
  await panel.locator(tid('rl-language-reload')).uncheck();
  await panel.locator(tid('rl-language-apply')).click();
  await expect(panel.locator(tid('rl-language-pending'))).toBeVisible();
  await expect(panel.locator(tid('rl-language-state'))).toHaveAttribute('data-scope', 'site');

  // Live, without a reload: the hook got the push, fired languagechange, and the rules apply to new requests.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __langChanges: string[] }).__langChanges)).toEqual(['de-AT']);
  expect((await pageLanguage(page)).languages).toEqual(['de-AT', 'en']);
  expect(await fetchAcceptLanguage(page, '/api/echo/site-live')).toBe('de-AT,en;q=0.8');
  expect((await rl.storedSettings()).siteLanguages).toEqual({ '127.0.0.1': 'de-AT,en;q=0.8' });

  // Persisted: a reload and a new tab on the same host get it from the first request on.
  await page.reload();
  await rl.waitForApp();
  expect(documentAcceptLanguage(rl, '/app')).toBe('de-AT,en;q=0.8');
  await expect.poll(() => page.evaluate(() => navigator.language)).toBe('de-AT');
  expect(await pageLanguage(page)).toMatchObject({ language: 'de-AT', languages: ['de-AT', 'en'], numberLocale: 'de-AT' });
  await expect(rl.ui.locator(tid('rl-language-indicator'))).toHaveAttribute('data-scope', 'site');

  const other = await context.newPage();
  await other.goto(`${rl.server.origin}/blank`);
  expect(documentAcceptLanguage(rl, '/blank')).toBe('de-AT,en;q=0.8');
  await expect.poll(() => other.evaluate(() => navigator.language)).toBe('de-AT');
  await closeOtherTab(rl, other);

  // Reset removes the site's language.
  const again = await openLanguage(rl);
  await expect(again.locator(tid('rl-language-state'))).toHaveAttribute('data-value', 'de-AT,en;q=0.8');
  await reloadingClick(rl, again.locator(tid('rl-language-reset')));
  expect((await rl.storedSettings()).siteLanguages).toEqual({});
  expect(documentAcceptLanguage(rl, '/app')).toBe(beforeHeader);
  expect(await pageLanguage(page)).toEqual(before);
});
