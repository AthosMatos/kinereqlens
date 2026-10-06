/**
 * Preserved log: restored across a reload through the service worker, credentials never persisted, and no
 * content script (of any tab) can read chrome.storage.session directly.
 */
import { expect, test, tid } from './fixtures';

test.describe('preserve log', () => {
  test('restores after a reload without persisting credentials; storage.session is closed to content scripts', async ({ rl, context, server }) => {
    await rl.openApp();
    await rl.ui.locator(tid('rl-preserve-toggle')).click();
    await rl.clickApp('json');
    await rl.page.waitForTimeout(1500); // debounced write (1 s)
    await rl.page.reload();
    await rl.waitForApp();
    const restored = rl.ui.locator(`${tid('rl-request-row')}.rl-req-row--restored[data-url$="/api/echo/json"]`);
    await expect(restored).toHaveCount(1);
    // The restored page document carries its Cookie header, redacted. (Doc type only: the list is virtualized and
    // the restored rows sit at its end.)
    await rl.setListTypes(['doc']);
    const doc = rl.ui.locator(`${tid('rl-request-row')}.rl-req-row--restored[data-kind="document"]`).first();
    await doc.click();
    await expect(rl.kvRow('headers', 'Cookie').locator(tid('rl-kv-value'))).toHaveValue('[not kept in the preserved log]');

    // Another tab (another site, overlay never opened there): its content script cannot read the log.
    const other = await context.newPage();
    const cdp = await context.newCDPSession(other);
    const contexts: Array<{ id: number; name: string; auxData?: { type?: string } }> = [];
    cdp.on('Runtime.executionContextCreated', (e: { context: { id: number; name: string; auxData?: { type?: string } } }) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    await other.goto(`${server.crossOrigin}/blank`);
    await expect(other.locator('#status')).toHaveText('ready');
    await expect.poll(() => contexts.some((c) => c.auxData?.type === 'isolated' && /kineReqLens/.test(c.name))).toBe(true);
    const isolated = contexts.filter((c) => c.auxData?.type === 'isolated' && /kineReqLens/.test(c.name)).at(-1)!;
    const { result } = (await cdp.send('Runtime.evaluate', {
      contextId: isolated.id,
      awaitPromise: true,
      returnByValue: true,
      expression: `chrome.storage.session.get(null).then((v) => 'read ' + Object.keys(v).join(','), (e) => 'blocked: ' + e.message)`,
    })) as { result: { value: string } };
    expect(result.value).toMatch(/^blocked/);
    await other.close();
  });
});
