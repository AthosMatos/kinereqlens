/**
 * Suite 7 — test visualizer: Pretty / Raw / Preview (HTML in a sandboxed iframe, image), Headers tab, Compare against
 * the original response and the previous run, run history, Original response tab, cancel, timeout, large bodies.
 */
import type { Locator } from '@playwright/test';
import type { kineReqLens } from './fixtures';
import { expect, test, tid } from './fixtures';
import { bigJson, makePng } from './server';

/** Open the run history list (it starts collapsed when the results pane is short). */
async function openHistory(rl: kineReqLens): Promise<Locator> {
  const history = rl.ui.locator(tid('rl-run-history'));
  const toggle = history.locator('.rl-results__history-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return history;
}

test.describe('results', () => {
  test('JSON body: pretty tree, raw text, headers tab, summary metrics', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    expect(await rl.send()).toBe('done');
    const view = rl.resultView;
    await expect(view.locator(tid('rl-result-status'))).toHaveText('200');
    await expect(view.locator(tid('rl-result-status'))).toHaveClass(/rl-status--2xx/);
    await expect(view.locator(tid('rl-result-time'))).toHaveText(/\d+(\.\d+)?\s*(ms|s)/);
    await expect(view.locator(tid('rl-result-size'))).toHaveText(/\d+(\.\d+)?\s*(B|KB|kB)/);
    await expect(view.locator('.rl-resp__ctype')).toHaveText('application/json');
    await expect(view.locator(tid('rl-result-mode'))).toHaveText('Page');

    // Pretty (default for JSON): collapsible tree with filter and expand/collapse all.
    await expect(view.locator(tid('rl-body-pretty'))).toHaveAttribute('aria-pressed', 'true');
    const tree = view.locator('.rl-jv');
    await expect(tree.locator('.rl-jv__key', { hasText: 'bodyText' })).toBeVisible();
    await expect(tree.locator('.rl-jv__key', { hasText: 'content-type' })).toBeVisible();
    // Collapse all keeps the root open (top-level keys) and folds every nested container.
    await tree.getByRole('button', { name: 'Collapse all' }).click();
    await expect(tree.locator('.rl-jv__key', { hasText: 'content-type' })).toHaveCount(0);
    await expect(tree.locator('.rl-jv__key', { hasText: 'bodyText' })).toBeVisible();
    await tree.getByRole('button', { name: 'Expand all' }).click();
    await expect(tree.locator('.rl-jv__key', { hasText: 'content-type' })).toBeVisible();
    await tree.locator('.rl-jv__filter-input').fill('London');
    await expect(tree.locator('.rl-jv__matches')).toHaveText(/\d+ match/);

    // Raw: the exact text (wrap toggle available).
    const raw = await rl.rawBody();
    expect(JSON.parse(raw)).toMatchObject({ method: 'POST', path: '/api/echo/json' });
    await expect(view.getByRole('button', { name: 'Wrap' })).toBeVisible();

    // Headers tab with a count badge.
    await rl.respTab('headers').click();
    const headers = view.locator('.rl-resp-headers');
    await expect(headers).toContainText('content-type');
    await expect(headers).toContainText('application/json; charset=utf-8');
    await expect(headers).toContainText('x-echo-seq');
    await expect(rl.respTab('headers').locator('.rl-tab__badge')).toHaveText(/\d+/);

    // Request sent: what the run put on the wire.
    await rl.respTab('request').click();
    const sent = rl.ui.locator(tid('rl-request-sent'));
    await expect(sent).toContainText('POST');
    await expect(sent).toContainText(`${rl.server.origin}/api/echo/json`);
    await expect(sent).toContainText('12345678901234567890');
  });

  test('preview: HTML in a sandboxed iframe (scripts never run) and images', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('html');
    await rl.select('/api/html');
    expect(await rl.send()).toBe('done');
    const view = rl.resultView;
    await expect(view.locator(tid('rl-body-raw'))).toHaveAttribute('aria-pressed', 'true'); // HTML defaults to raw
    await expect(view.locator(tid('rl-result-body'))).toContainText('<h1 id="title">Hello preview</h1>');
    await view.locator(tid('rl-body-preview')).click();
    const frame = view.locator(`${tid('rl-preview-host')} iframe`);
    await expect(frame).toHaveAttribute('sandbox', '');
    expect(await frame.getAttribute('srcdoc')).toContain('Hello preview');
    const content = rl.ui.frameLocator(`${tid('rl-preview-host')} iframe`);
    await expect(content.locator('#title')).toHaveText('Hello preview'); // the inline script was not executed
    await expect(content.locator('p')).toHaveText('Rendered inside a sandboxed iframe.');

    await rl.clickApp('image');
    await rl.select('/api/image?w=64&h=48');
    expect(await rl.send()).toBe('done');
    await expect(view.locator(tid('rl-body-preview'))).toHaveAttribute('aria-pressed', 'true'); // images preview by default
    const img = view.locator('img.rl-resp-image__img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => [(el as HTMLImageElement).naturalWidth, (el as HTMLImageElement).naturalHeight])).toEqual([64, 48]);
    await expect(view.locator('.rl-resp-image__meta')).toContainText('image/png');
    await expect(view.locator('.rl-resp-image__meta')).toContainText('64 × 48 px');
    // Raw for a binary body is a hex dump starting with the PNG signature.
    await view.locator(tid('rl-body-raw')).click();
    await expect(view.locator('.rl-resp-binary__hex')).toContainText('89 50 4e 47');
    await expect(view.locator('.rl-resp-binary__summary')).toContainText(`${makePng(64, 48).length} B`);
  });

  test('compare with the original response and the previous run; run history', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    await rl.jsonValue('user.address.city').fill('Paris');
    expect(await rl.send()).toBe('done');

    // Compare against the original captured response: the edited value shows up as an added line.
    await rl.respTab('compare').click();
    const compare = rl.resultView.locator(tid('rl-compare'));
    await expect(compare).toBeVisible();
    await expect(compare.locator(tid('rl-compare-original'))).toHaveAttribute('aria-pressed', 'true');
    await expect(compare.locator(tid('rl-compare-previous'))).toBeDisabled(); // only one run so far
    await expect(compare.locator(tid('rl-compare-counts'))).toHaveText(/\+\d+\s*−\d+/);
    await expect(compare.locator('.rl-resp-diff__line--add', { hasText: 'Paris' }).first()).toBeVisible();
    await expect(compare.locator('.rl-resp-diff__line--del', { hasText: 'London' }).first()).toBeVisible();
    await expect(compare).toContainText('compared as pretty-printed JSON');

    // Second and third run (different values), then compare with the previous run.
    await rl.jsonValue('user.address.city').fill('Rome');
    expect(await rl.send()).toBe('done');
    await rl.jsonValue('user.address.city').fill('Oslo');
    expect(await rl.send()).toBe('done');
    await rl.respTab('compare').click();
    await compare.locator(tid('rl-compare-previous')).click();
    await expect(compare.locator('.rl-resp-diff__side--before')).toContainText('Previous run');
    await expect(compare.locator('.rl-resp-diff__line--add', { hasText: 'Oslo' }).first()).toBeVisible();
    await expect(compare.locator('.rl-resp-diff__line--del', { hasText: 'Rome' }).first()).toBeVisible();

    // History: newest first, select an older run to view it, clear.
    await expect(rl.ui.locator(tid('rl-test-tab')).locator('.rl-tab__badge')).toHaveText('3');
    const history = await openHistory(rl);
    const items = history.locator(tid('rl-run-item'));
    await expect(items).toHaveCount(3);
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    const oldest = items.last();
    const oldestId = (await oldest.getAttribute('data-run-id'))!;
    await oldest.click();
    await expect(rl.results).toHaveAttribute('data-active-run', oldestId);
    expect(JSON.parse((await rl.echo()).bodyText)).toMatchObject({ user: { address: { city: 'Paris' } } });
    await history.locator(tid('rl-run-clear')).click();
    await expect(rl.ui.locator(tid('rl-results-empty'))).toBeVisible();
    await expect(history).toHaveCount(0);
    await expect(rl.row('/api/echo/json').locator('.rl-req-row__runs')).toHaveCount(0);
  });

  test('original response tab shows the captured response', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    await rl.ui.locator(tid('rl-original-tab')).click();
    const original = rl.ui.locator(tid('rl-original-view'));
    await expect(original.locator(tid('rl-result-status'))).toHaveText('200');
    const text = await rl.rawBody(original);
    const echo = JSON.parse(text) as { path: string; bodyText: string };
    expect(echo.path).toBe('/api/echo/json');
    expect(echo.bodyText).toContain('12345678901234567890');
    // Sending switches back to the test result.
    await rl.ui.locator(tid('rl-send')).click();
    await expect(rl.ui.locator(tid('rl-test-tab'))).toHaveAttribute('aria-selected', 'true');
    await expect(rl.results).not.toHaveAttribute('data-run-state', 'running');
  });

  for (const mode of ['page', 'extension'] as const) {
    test(`cancel a slow request and time out (${mode} mode)`, async ({ rl }) => {
      await rl.openApp();
      await rl.clickApp('slow');
      await rl.select('/api/slow');
      await rl.setMode(mode);
      await rl.kvRow('query', 'ms').locator(tid('rl-kv-value')).fill('10000');

      // Cancel while running.
      await rl.ui.locator(tid('rl-send')).click();
      await expect(rl.results).toHaveAttribute('data-run-state', 'running');
      await expect(rl.ui.locator(tid('rl-send'))).toContainText('Sending');
      await expect(rl.resultView.locator('[role="timer"]')).toBeVisible();
      await rl.ui.locator(tid('rl-run-cancel')).click();
      await expect(rl.results).toHaveAttribute('data-run-state', 'aborted', { timeout: 5000 });
      await expect(rl.resultView.locator(tid('rl-result-error'))).toContainText('Request cancelled');
      await expect(rl.resultView.locator(tid('rl-result-status'))).toHaveText(/Aborted|Cancelled/);

      // Timeout: 1 s request option against a 10 s response.
      await rl.withSendOptions(async (form) => {
        await form.locator(tid('rl-opt-timeout')).fill('1');
      });
      await expect(rl.ui.locator(tid('rl-send-options'))).toContainText('1 s');
      const started = Date.now();
      expect(await rl.send()).toBe('error');
      expect(Date.now() - started).toBeLessThan(6000);
      await expect(rl.resultView.locator(tid('rl-result-error'))).toContainText(/Timed out/);
    });
  }

  test('large JSON bodies render progressively', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('big');
    await rl.select('/api/big');
    expect(await rl.send()).toBe('done');
    const view = rl.resultView;
    await expect(view.locator('.rl-jv')).toBeVisible();
    await expect(view.locator('.rl-resp-more')).toContainText('Showing the first');
    await view.locator(tid('rl-body-raw')).click();
    const more = view.locator('.rl-resp-more');
    await expect(more).toContainText(`of ${bigJson(2500).length.toLocaleString('en-US')} characters`);
    await more.getByRole('button', { name: 'Show all' }).click();
    await expect(view.locator('.rl-resp-more')).toHaveCount(0);
    expect((await view.locator(`${tid('rl-result-body')} pre`).textContent())?.length).toBe(bigJson(2500).length);
  });
});
