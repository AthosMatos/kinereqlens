/**
 * Editor details: typing in the URL field, recovering from an invalid raw edit, byte-exact unmodified replays
 * (untyped bytes bodies, FormData line breaks), multipart part kinds, GraphQL field keys, duplicating large
 * bodies, and the cache headers the browser adds to test requests.
 */
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

/** Request body of the n-th request the server received on `path` (0 = the page's own). */
function bodyOf(rl: kineReqLens, path: string, n: number): Buffer {
  const list = rl.server.requestsTo(path);
  const req = list[n < 0 ? list.length + n : n];
  if (!req) throw new Error(`no request #${n} to ${path}`);
  return req.body;
}

function boundaryOf(rl: kineReqLens, path: string, n: number): string {
  const list = rl.server.requestsTo(path);
  const ct = String(list[n < 0 ? list.length + n : n]?.headers['content-type'] ?? '');
  return /boundary=("?)([^";]+)\1/.exec(ct)?.[2] ?? '';
}

test.describe('editor', () => {
  test('typing "?k=v" or "#hash" in the URL field keeps the params', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('query');
    await rl.select('/api/echo/query');
    const url = rl.ui.locator(tid('rl-url-input'));
    const preview = rl.ui.locator(tid('rl-url-preview'));
    const keys = () => rl.kvRows('query').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key));

    await rl.kvRow('query', 'foo').locator(tid('rl-kv-value')).fill('EDITED');
    await url.click();
    await url.press('End');
    await url.pressSequentially('?extra=1');
    await url.press('Enter');
    expect(await keys()).toEqual(['foo', 'n', 'list', 'list', 'q', 'sym', 'extra']);
    await expect(rl.kvRow('query', 'foo').locator(tid('rl-kv-value'))).toHaveValue('EDITED');
    await expect(url).toHaveValue(`${rl.server.origin}/api/echo/query`);

    await url.click();
    await url.press('End');
    await url.pressSequentially('#top');
    await url.press('Enter');
    expect(await keys()).toEqual(['foo', 'n', 'list', 'list', 'q', 'sym', 'extra']);
    await expect(preview).toHaveText(/\?foo=EDITED&.*&extra=1#top$/);
    // The hash is visible in the field, so it can be deleted there again.
    await expect(url).toHaveValue(`${rl.server.origin}/api/echo/query#top`);
    await url.click();
    await url.press('End');
    for (let i = 0; i < 4; i++) await url.press('Backspace');
    await url.press('Enter');
    await expect(preview).not.toContainText('#');
    await expect(preview).toContainText('/api/echo/query?foo=EDITED');

    expect(await rl.send()).toBe('done');
    const echo = await rl.echo();
    expect(echo.query).toContainEqual(['extra', '1']);
    expect(echo.query).toContainEqual(['foo', 'EDITED']);

    // "Revert URL" also restores params typed into the field.
    await rl.ui.locator(tid('rl-url-revert')).click();
    expect(await keys()).toEqual(['foo', 'n', 'list', 'list', 'q', 'sym']);
  });

  test('an invalid first raw edit can be reverted (body section and Revert all)', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    const body = rl.section('body');
    await body.locator(tid('rl-body-view-raw')).click();
    const raw = body.locator(tid('rl-raw-body'));
    await raw.focus();
    await raw.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
    await rl.page.keyboard.type('x');
    await expect(body.locator(tid('rl-raw-error'))).toBeVisible();
    await expect(rl.ui.locator(tid('rl-send'))).toBeDisabled();
    await expect(body.locator(tid('rl-body-view-fields'))).toBeDisabled();
    // The way out the tooltip promises exists: the section revert and Revert all.
    await expect(rl.ui.locator(tid('rl-revert-all'))).toBeVisible();
    await body.locator(tid('rl-section-revert')).click();
    await expect(body.locator(tid('rl-raw-error'))).toHaveCount(0);
    await expect(body.locator(tid('rl-body-view-fields'))).toBeEnabled();
    await expect(rl.ui.locator(tid('rl-send'))).toBeEnabled();
    await expect(rl.ui.locator(tid('rl-revert-all'))).toHaveCount(0);
  });

  test('an unmodified bytes body without Content-Type is replayed without one (both modes)', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => fetch('/api/echo/bytes', { method: 'POST', body: new TextEncoder().encode('{"a":1}') }));
    await rl.select('/api/echo/bytes');
    expect(rl.server.requestsTo('/api/echo/bytes')[0]!.headers['content-type']).toBeUndefined();
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).contentType).toBeNull();
    await rl.setMode('extension');
    expect(await rl.send()).toBe('done');
    const echo = await rl.echo();
    expect(echo.contentType).toBeNull();
    expect(echo.bodyText).toBe('{"a":1}');
  });

  test('an unmodified FormData body is replayed byte for byte (line breaks as the browser encodes them)', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => {
      const fd = new FormData();
      fd.append('note', 'line1\nline2');
      fd.append('na\nme', 'v');
      return fetch('/api/echo/nl', { method: 'POST', body: fd });
    });
    await rl.select('/api/echo/nl');
    expect(await rl.send()).toBe('done');
    const original = bodyOf(rl, '/api/echo/nl', 0).toString('latin1').split(boundaryOf(rl, '/api/echo/nl', 0)).join('B');
    const replay = bodyOf(rl, '/api/echo/nl', 1).toString('latin1').split(boundaryOf(rl, '/api/echo/nl', 1)).join('B');
    expect(original).toContain('line1\r\nline2');
    expect(replay).toBe(original);
  });

  test('a file part switched to Text loses the file type; switching back restores the file', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => {
      const fd = new FormData();
      fd.append('avatar', new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], { type: 'image/png' }), 'a.png');
      return fetch('/api/echo/avatar', { method: 'POST', body: fd });
    });
    await rl.select('/api/echo/avatar');
    const part = rl.section('body').locator(`${tid('rl-mp-part')}[data-name="avatar"]`);
    await expect(part.locator('.rl-mp-file__size')).toHaveText('8 B');
    await part.locator(tid('rl-mp-kind')).selectOption('text');
    await part.locator(tid('rl-mp-value')).fill('just text');
    expect(await rl.send()).toBe('done');
    const sent = (await rl.echo()).bodyText;
    expect(sent).toContain('name="avatar"\r\n\r\njust text\r\n');
    expect(sent).not.toContain('image/png');
    await part.locator(tid('rl-mp-kind')).selectOption('file');
    await expect(part.locator('.rl-mp-file__size')).toHaveText('8 B');
    await expect(part.locator(tid('rl-mp-filename'))).toHaveValue('a.png');
  });

  test('a GraphQL field added with "+ Add field" keeps its key input while a standard key is typed', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('graphql');
    await rl.select('/graphql');
    const body = rl.section('body');
    await body.locator(`.rl-gql-add ${tid('rl-json-add')}`).first().click();
    const key = body.locator(tid('rl-json-key')).last();
    await expect(key).toBeFocused();
    await rl.page.keyboard.press('ControlOrMeta+A');
    await rl.page.keyboard.type('extensionsX');
    await expect(rl.jsonNode('extensionsX')).toHaveCount(1);
    await expect(rl.jsonNode('extensionsX').locator(tid('rl-json-key'))).toBeFocused();
    await expect(rl.jsonNode('extensions')).toHaveCount(0);
  });

  test('"Duplicate as new request" keeps a body larger than the capture cap intact', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('multipart');
    await rl.select('/api/echo/upload');
    const file = rl.section('body').locator(`${tid('rl-mp-part')}[data-name="attachment"]`);
    const big = Buffer.alloc(1_500_000, 'a');
    await file.locator(tid('rl-mp-file')).setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: big });
    expect(await rl.send()).toBe('done');
    const sentSize = bodyOf(rl, '/api/echo/upload', -1).length;
    expect(sentSize).toBeGreaterThan(1_500_000);
    await rl.ui.locator(tid('rl-more-menu')).click();
    await rl.ui.locator(tid('rl-duplicate')).click();
    await expect(rl.detail).toHaveAttribute('data-entry-id', /^m:/);
    expect(await rl.send()).toBe('done');
    const dupBody = bodyOf(rl, '/api/echo/upload', -1);
    expect(dupBody.length).toBe(sentSize);
    expect(dupBody.toString('latin1').trimEnd().endsWith('--')).toBe(true);
  });

  test('"Request sent" says which cache headers the browser added', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('headers');
    await rl.select('/api/echo/headers');
    expect(await rl.send()).toBe('done');
    const echo = await rl.echo();
    expect(echo.headers['cache-control']).toBe('no-cache');
    await rl.respTab('request').click();
    await expect(rl.ui.locator(tid('rl-cache-note'))).toContainText('Cache-Control: no-cache');
    await expect(rl.ui.locator(tid('rl-cache-note'))).toContainText('Pragma: no-cache');
  });
});
