/**
 * Suite 2 — query params: rows (duplicates kept, order kept) → edit → Send (page mode) → echo → modified markers →
 * per-row revert → revert all → verbatim URL.
 */
import { expect, test, tid } from './fixtures';

const PATH = '/api/echo/query';
const RAW_QUERY = 'foo=bar&n=1&list=a&list=b&q=hello%20world&sym=%7E%21';

test.describe('query params', () => {
  test('edit, send, revert per row and revert all', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('query');
    await rl.select(PATH);
    const preview = rl.ui.locator(tid('rl-url-preview'));
    const originalUrl = `${rl.server.origin}${PATH}?${RAW_QUERY}`;
    await expect(preview).toHaveText(originalUrl);

    // One row per parameter, duplicates kept, in order; values decoded.
    const rows = rl.kvRows('query');
    expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key))).toEqual([
      'foo',
      'n',
      'list',
      'list',
      'q',
      'sym',
    ]);
    expect(await rows.locator(tid('rl-kv-value')).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual([
      'bar',
      '1',
      'a',
      'b',
      'hello world',
      '~!',
    ]);
    await expect(rl.section('query')).toHaveAttribute('data-modified', 'false');
    await expect(rl.ui.locator(tid('rl-revert-all'))).toHaveCount(0);

    // Edit foo: only that pair changes in the URL; the others keep their exact encoding.
    const foo = rl.kvRow('query', 'foo');
    await foo.locator(tid('rl-kv-value')).fill('baz qux');
    await expect(foo).toHaveAttribute('data-modified', 'true');
    await expect(rl.kvRow('query', 'n')).toHaveAttribute('data-modified', 'false');
    await expect(rl.section('query')).toHaveAttribute('data-modified', 'true');
    await expect(rl.ui.locator(tid('rl-modified-count'))).toHaveText(/1 modified/);
    await expect(preview).toHaveText(`${rl.server.origin}${PATH}?foo=baz%20qux&n=1&list=a&list=b&q=hello%20world&sym=%7E%21`);
    // The list row shows the edited-draft dot.
    await expect(rl.row(PATH).locator('.rl-modified-dot')).toHaveCount(1);

    expect(await rl.send()).toBe('done');
    expect(await rl.status()).toContain('200');
    const echo = await rl.echo();
    expect(echo.method).toBe('GET');
    expect(echo.rawQuery).toBe('foo=baz%20qux&n=1&list=a&list=b&q=hello%20world&sym=%7E%21');
    expect(echo.query).toEqual([
      ['foo', 'baz qux'],
      ['n', '1'],
      ['list', 'a'],
      ['list', 'b'],
      ['q', 'hello world'],
      ['sym', '~!'],
    ]);
    // Page mode: same-origin cookies of the app are sent.
    expect(echo.headers.cookie).toContain('rl_session=abc123');
    // Test runs are counted on the row.
    await expect(rl.row(PATH).locator('.rl-req-row__runs')).toHaveText('1');

    // Second edit (duplicate key) + a disabled row + an added row.
    const second = rl.kvRows('query').nth(3);
    await second.locator(tid('rl-kv-value')).fill('B2');
    await rl.kvRow('query', 'n').locator(tid('rl-kv-enabled')).uncheck();
    await rl.section('query').locator(tid('rl-kv-add')).click();
    const added = rl.kvRows('query').last();
    await added.locator(tid('rl-kv-key')).fill('extra');
    await added.locator(tid('rl-kv-value')).fill('1');
    await expect(preview).toHaveText(`${rl.server.origin}${PATH}?foo=baz%20qux&list=a&list=B2&q=hello%20world&sym=%7E%21&extra=1`);
    await expect(rl.ui.locator(tid('rl-modified-count'))).toHaveText(/4 modified/);

    // Per-row revert: foo goes back to its captured value and encoding.
    await foo.locator(tid('rl-kv-revert')).click();
    await expect(foo).toHaveAttribute('data-modified', 'false');
    await expect(foo.locator(tid('rl-kv-value'))).toHaveValue('bar');
    await expect(preview).toHaveText(`${rl.server.origin}${PATH}?foo=bar&list=a&list=B2&q=hello%20world&sym=%7E%21&extra=1`);
    // Reverting an added row removes it.
    await rl.kvRow('query', 'extra').locator(tid('rl-kv-revert')).click();
    await expect(rl.kvRow('query', 'extra')).toHaveCount(0);

    // Delete a row: it can be restored from the "Removed" strip.
    await rl.kvRow('query', 'q').locator(tid('rl-kv-delete')).click();
    await expect(rl.kvRow('query', 'q')).toHaveCount(0);
    await rl.section('query').locator(tid('rl-kv-restore')).click();
    await expect(rl.kvRow('query', 'q')).toHaveCount(1);

    // Revert all: everything as captured, the URL is the verbatim original.
    await rl.ui.locator(tid('rl-revert-all')).click();
    await expect(rl.ui.locator(tid('rl-revert-all'))).toHaveCount(0);
    await expect(rl.section('query')).toHaveAttribute('data-modified', 'false');
    await expect(preview).toHaveText(originalUrl);
    await expect(rl.row(PATH).locator('.rl-modified-dot')).toHaveCount(0);
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).rawQuery).toBe(RAW_QUERY);
    // The server received exactly the captured request target.
    const received = rl.server.requestsTo(PATH);
    expect(received[received.length - 1]!.url).toBe(`${PATH}?${RAW_QUERY}`);
  });

  test('section revert, bulk edit and pasting a full URL re-parses the params', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('query');
    await rl.select(PATH);
    const preview = rl.ui.locator(tid('rl-url-preview'));

    // Bulk edit: k=v lines, # disables.
    await rl.section('query').locator(tid('rl-kv-bulk')).click();
    const bulk = rl.section('query').locator(tid('rl-kv-bulk-text'));
    await expect(bulk).toHaveValue('foo=bar\nn=1\nlist=a\nlist=b\nq=hello world\nsym=~!');
    await bulk.fill('foo=bulk\n# n=1\nlist=a\nlist=b\nq=hello world\nsym=~!');
    await rl.section('query').locator(tid('rl-kv-bulk')).click(); // Done
    await expect(rl.kvRow('query', 'foo').locator(tid('rl-kv-value'))).toHaveValue('bulk');
    await expect(rl.kvRow('query', 'n').locator(tid('rl-kv-enabled'))).not.toBeChecked();
    await expect(preview).toHaveText(`${rl.server.origin}${PATH}?foo=bulk&list=a&list=b&q=hello%20world&sym=%7E%21`);

    // Section revert (↺ on the Params header).
    await rl.section('query').locator(tid('rl-section-revert')).click();
    await expect(rl.section('query')).toHaveAttribute('data-modified', 'false');
    await expect(preview).toHaveText(`${rl.server.origin}${PATH}?${RAW_QUERY}`);

    // Pasting a full URL with a query string into the URL input re-parses the Params table.
    const url = rl.ui.locator(tid('rl-url-input'));
    await url.fill(`${rl.server.origin}/api/echo/other?x=1&y=two%20words`);
    await url.press('Enter');
    await expect(rl.kvRows('query')).toHaveCount(2);
    await expect(rl.kvRow('query', 'y').locator(tid('rl-kv-value'))).toHaveValue('two words');
    await expect(url).toHaveValue(`${rl.server.origin}/api/echo/other`);
    expect(await rl.send()).toBe('done');
    const echo = await rl.echo();
    expect(echo.path).toBe('/api/echo/other');
    expect(echo.query).toEqual([
      ['x', '1'],
      ['y', 'two words'],
    ]);
    // The URL revert brings back the captured base.
    await rl.ui.locator(tid('rl-revert-all')).click();
    await expect(url).toHaveValue(`${rl.server.origin}${PATH}`);
  });
});
