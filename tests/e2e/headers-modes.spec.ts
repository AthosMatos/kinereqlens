/**
 * Suite 6 — headers and send modes: custom headers are sent; a cross-origin request fails in Page mode (with a CORS
 * hint) and succeeds in Extension mode; in Extension mode browser-controlled headers (Cookie, Origin, Referer)
 * are applied through a temporary declarativeNetRequest rule, while Page mode reports them as not sent.
 */
import { expect, test, tid } from './fixtures';

test.describe('headers and send modes', () => {
  test('edited and added headers are sent; browser headers are listed read-only', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('headers');
    await rl.select('/api/echo/headers');
    const headers = rl.section('headers');
    expect(await rl.kvRows('headers').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key))).toEqual([
      'X-Custom',
      'Accept',
    ]);
    await rl.kvRow('headers', 'X-Custom').locator(tid('rl-kv-value')).fill('edited');
    await headers.locator(tid('rl-kv-add')).click();
    const added = rl.kvRows('headers').last();
    await added.locator(tid('rl-kv-key')).fill('X-Added');
    await added.locator(tid('rl-kv-value')).fill('yes please');
    await rl.kvRow('headers', 'Accept').locator(tid('rl-kv-enabled')).uncheck();
    await expect(headers).toHaveAttribute('data-modified', 'true');

    expect(await rl.send()).toBe('done');
    const echo = await rl.echo();
    expect(echo.headers['x-custom']).toBe('edited');
    expect(echo.headers['x-added']).toBe('yes please');
    expect(echo.headers.accept).toBe('*/*'); // the disabled Accept was not sent; fetch's default applies
    expect(echo.headers.cookie).toContain('rl_session=abc123');

    // The headers the browser actually sent (webRequest, merged into the hook entry) are listed read-only.
    await headers.locator('.rl-ed-wire__toggle').click();
    const wire = headers.locator(tid('rl-wire-headers'));
    await expect(wire).toBeVisible();
    await expect(wire).toContainText('X-Custom');
    await expect(wire).toContainText('User-Agent');

    // Revert the headers section.
    await headers.locator(tid('rl-section-revert')).click();
    await expect(rl.kvRows('headers')).toHaveCount(2);
    await expect(rl.kvRow('headers', 'X-Custom').locator(tid('rl-kv-value'))).toHaveValue('original');
  });

  test('cross-origin request: fails in Page mode with a hint, succeeds in Extension mode', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('cross');
    expect(await rl.appLog('cross')).toBe('blocked: TypeError'); // the page itself is blocked by CORS
    const url = `${rl.server.crossOrigin}/api/echo/cross?x=1`;
    await expect(rl.row(url)).toHaveCount(1);
    await rl.select(url);
    await expect(rl.ui.locator(tid('rl-mode-select'))).toHaveValue('page');

    const before = rl.server.requestsTo('/api/echo/cross').length;
    expect(await rl.send()).toBe('error');
    const error = rl.resultView.locator(tid('rl-result-error'));
    await expect(error).toBeVisible();
    await expect(error).toContainText('CORS');
    await expect(error).toContainText('Try Extension mode');
    // The request did reach the server (CORS hides the response from the page, it does not stop a simple GET).
    expect(rl.server.requestsTo('/api/echo/cross').length).toBe(before + 1);

    await rl.setMode('extension');
    expect(await rl.send()).toBe('done');
    expect(await rl.status()).toContain('200');
    await expect(rl.resultView.locator(tid('rl-result-mode'))).toHaveText('Extension');
    const echo = await rl.echo();
    expect(echo.path).toBe('/api/echo/cross');
    expect(echo.query).toEqual([['x', '1']]);
  });

  test('Extension mode applies Cookie / Origin / Referer via DNR; Page mode reports them as not sent', async ({ rl, sw }) => {
    await rl.openApp();
    await rl.clickApp('headers');
    await rl.select('/api/echo/headers');
    const headers = rl.section('headers');
    const forbidden: Array<[string, string]> = [
      ['Cookie', 'injected=1; other=2'],
      ['Origin', 'https://reqlens.test'],
      ['Referer', 'https://reqlens.test/from'],
    ];
    for (const [name, value] of forbidden) {
      await headers.locator(tid('rl-kv-add')).click();
      const row = rl.kvRows('headers').last();
      await row.locator(tid('rl-kv-key')).fill(name);
      await row.locator(tid('rl-kv-value')).fill(value);
      // Page mode: lock + warning on browser-controlled headers.
      await expect(rl.kvRow('headers', name)).toHaveClass(/rl-kv-row--lock-warn/);
    }
    await expect(rl.ui.locator(tid('rl-warnings'))).toBeVisible();

    await rl.setMode('extension');
    await expect(rl.kvRow('headers', 'Cookie')).toHaveClass(/rl-kv-row--lock-info/);
    expect(await rl.send()).toBe('done');
    let echo = await rl.echo();
    expect(echo.headers.cookie).toBe('injected=1; other=2');
    expect(echo.headers.origin).toBe('https://reqlens.test');
    expect(echo.headers.referer).toBe('https://reqlens.test/from');
    expect(echo.headers['x-custom']).toBe('original');
    const notice = rl.resultView.locator('.rl-resp-notice--info', { hasText: 'declarativeNetRequest' });
    await expect(notice).toBeVisible();
    for (const [name] of forbidden) await expect(notice).toContainText(name);
    // The temporary session rule is gone once the replay finished.
    expect(await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules().then((r) => r.length))).toBe(0);

    // "Request sent" tags the headers that went through DNR.
    await rl.respTab('request').click();
    await expect(rl.ui.locator(tid('rl-request-sent'))).toContainText('via DNR');

    // Page mode cannot send them and says so; the page's own cookie is sent instead.
    await rl.setMode('page');
    expect(await rl.send()).toBe('done');
    echo = await rl.echo();
    expect(echo.headers.cookie).toBe('rl_session=abc123');
    expect(echo.headers.origin).toBeUndefined();
    expect(echo.headers.referer).toBe(rl.server.appUrl);
    const dropped = rl.resultView.locator('.rl-resp-notice--warn', { hasText: 'Not sent' });
    await expect(dropped).toContainText('Cookie');
    await expect(dropped).toContainText('Origin');
    await expect(dropped).toContainText('Switch to Extension mode');
  });

  test('send options: credentials omit drops the cookie, Reset restores the captured default', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('query');
    await rl.select('/api/echo/query');
    await rl.withSendOptions(async (form) => {
      await expect(form).toContainText('Credentials (as captured)');
      await form.locator(tid('rl-opt-credentials')).selectOption('omit');
    });
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).headers.cookie).toBeUndefined();
    // Reset returns to the captured default (same-origin -> the cookie is sent again).
    await rl.withSendOptions(async (form) => {
      await form.getByRole('button', { name: 'Reset' }).click();
      await expect(form).toContainText('Credentials (as captured)');
    });
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).headers.cookie).toBe('rl_session=abc123');
  });
});
