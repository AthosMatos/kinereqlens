/**
 * Suite 3 — JSON body: section cards → edit a nested value, change a type, add and delete fields → Send → echoed
 * bodyText exactly as expected (big number preserved) → revert per field / section / all → raw view round-trip.
 */
import { JSON_BODY } from './server';
import { expect, test, tid } from './fixtures';

const PATH = '/api/echo/json';

test.describe('JSON body', () => {
  test('field edits are sent losslessly and revert per field, section and all', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select(PATH);
    const body = rl.section('body');
    await expect(body.locator(tid('rl-body-type'))).toHaveValue('json');
    await expect(body.locator(tid('rl-body-view-fields'))).toHaveAttribute('aria-pressed', 'true');

    // One section card per top-level key.
    const cards = body.locator('.rl-jed > .rl-jed-list--cards > .rl-jed-card');
    await expect(cards).toHaveCount(6);
    const topKeys = await cards.evaluateAll((els) =>
      els.map((c) => c.querySelector<HTMLElement>('[data-testid="rl-json-node"]')?.dataset.path),
    );
    expect(topKeys).toEqual(['user', 'tags', 'active', 'big', 'count', 'note']);
    // Nested containers render as groups; types and values as captured; the big number is exact.
    await expect(rl.jsonNode('user.address')).toHaveAttribute('data-type', 'object');
    await expect(rl.jsonValue('user.address.city')).toHaveValue('London');
    await expect(rl.jsonNode('tags')).toHaveAttribute('data-type', 'array');
    await expect(rl.jsonValue('tags[1]')).toHaveValue('beta');
    await expect(rl.jsonValue('active')).toBeChecked();
    await expect(rl.jsonValue('big')).toHaveValue('12345678901234567890');
    await expect(rl.jsonNode('note')).toHaveAttribute('data-type', 'null');

    // 1. nested value
    await rl.jsonValue('user.address.city').fill('Paris');
    await expect(rl.jsonNode('user.address.city')).toHaveAttribute('data-modified', 'true');
    await expect(rl.jsonNode('user')).toHaveAttribute('data-modified', 'true'); // dirty container
    await expect(rl.jsonNode('user.name')).toHaveAttribute('data-modified', 'false');
    // 2. type change: number -> string keeps the literal text
    await rl.jsonNode('count').locator(tid('rl-json-type')).selectOption('string');
    await expect(rl.jsonNode('count')).toHaveAttribute('data-type', 'string');
    await expect(rl.jsonValue('count')).toHaveValue('3');
    // 3. add fields (object member + array item)
    await body.locator(`${tid('rl-json-add')}[data-path="user"]`).click();
    await rl.jsonNode('user.newKey').locator(tid('rl-json-key')).fill('role');
    await rl.jsonValue('user.role').fill('admin');
    await body.locator(`${tid('rl-json-add')}[data-path="tags"]`).click();
    await rl.jsonValue('tags[2]').fill('gamma');
    // 4. delete a field
    await rl.jsonNode('note').locator(tid('rl-json-delete')).click();
    await expect(rl.jsonNode('note')).toHaveCount(0);
    // 5. boolean
    await rl.jsonValue('active').uncheck();

    expect(await rl.send()).toBe('done');
    expect(await rl.status()).toContain('200');
    const echo = await rl.echo();
    expect(echo.contentType).toBe('application/json');
    expect(echo.bodyText).toBe(
      '{"user":{"name":"Ada","address":{"city":"Paris","zip":"N1"},"role":"admin"},"tags":["alpha","beta","gamma"],' +
        '"active":false,"big":12345678901234567890,"count":"3"}',
    );

    // Revert per field: the nested value and the type change.
    await rl.jsonNode('user.address.city').locator(tid('rl-json-revert')).click();
    await expect(rl.jsonValue('user.address.city')).toHaveValue('London');
    await expect(rl.jsonNode('user.address.city')).toHaveAttribute('data-modified', 'false');
    await rl.jsonNode('count').locator(tid('rl-json-revert')).click();
    await expect(rl.jsonNode('count')).toHaveAttribute('data-type', 'number');
    // Reverting an added field removes it.
    await rl.jsonNode('user.role').locator(tid('rl-json-revert')).click();
    await expect(rl.jsonNode('user.role')).toHaveCount(0);
    await expect(rl.jsonNode('user')).toHaveAttribute('data-modified', 'false');

    // Revert the Body section: the deleted field and the array item come back / go away.
    await expect(body).toHaveAttribute('data-modified', 'true');
    await body.locator(tid('rl-section-revert')).click();
    await expect(body).toHaveAttribute('data-modified', 'false');
    await expect(rl.jsonNode('note')).toHaveCount(1);
    await expect(rl.jsonNode('tags[2]')).toHaveCount(0);
    await expect(rl.jsonValue('active')).toBeChecked();

    // Revert all (body + a header edit), then the original body is re-sent byte for byte.
    await rl.jsonValue('user.name').fill('Grace');
    await rl.kvRow('headers', 'Content-Type').locator(tid('rl-kv-value')).fill('application/json; charset=utf-8');
    await expect(rl.ui.locator(tid('rl-modified-count'))).toHaveText(/2 modified/);
    await rl.ui.locator(tid('rl-revert-all')).click();
    await expect(rl.ui.locator(tid('rl-revert-all'))).toHaveCount(0);
    await expect(rl.jsonValue('user.name')).toHaveValue('Ada');
    expect(await rl.send()).toBe('done');
    const verbatim = await rl.echo();
    expect(verbatim.bodyText).toBe(JSON_BODY);
    expect(verbatim.contentType).toBe('application/json');
  });

  test('raw view edits re-sync into fields; parse errors and invalid numbers block Send', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select(PATH);
    const body = rl.section('body');
    const send = rl.ui.locator(tid('rl-send'));

    // An invalid number literal is flagged and blocks Send until fixed.
    await rl.jsonValue('count').fill('3x');
    await expect(rl.jsonValue('count')).toHaveAttribute('aria-invalid', 'true');
    await expect(send).toBeDisabled();
    await rl.jsonValue('count').fill('4');
    await expect(send).toBeEnabled();

    // Raw view shows the serialized body (pretty), big number intact, including the field edit.
    await body.locator(tid('rl-body-view-raw')).click();
    const raw = body.locator(tid('rl-raw-body'));
    const text = await raw.inputValue();
    expect(text).toContain('"big": 12345678901234567890');
    expect(text).toContain('"count": 4');
    expect(JSON.parse(text.replace('12345678901234567890', '0'))).toMatchObject({ user: { address: { city: 'London' } } });

    // A valid raw edit re-syncs into the Fields view (with modified markers on the right nodes).
    const edited = text.replace('"London"', '"Berlin"').replace('"note": null', '"note": null,\n  "extra": [1, 2.50]');
    await raw.fill(edited);
    await expect(body.locator(tid('rl-raw-error'))).toHaveCount(0);
    await body.locator(tid('rl-body-view-fields')).click();
    await expect(rl.jsonValue('user.address.city')).toHaveValue('Berlin');
    await expect(rl.jsonNode('user.address.city')).toHaveAttribute('data-modified', 'true');
    await expect(rl.jsonNode('user.address.zip')).toHaveAttribute('data-modified', 'false');
    await expect(rl.jsonNode('extra')).toHaveAttribute('data-modified', 'true');
    await expect(rl.jsonValue('extra[1]')).toHaveValue('2.50');

    // Invalid raw JSON: error with line:column, Send and the Fields view are blocked.
    await body.locator(tid('rl-body-view-raw')).click();
    await raw.fill('{\n  "user": {\n    "name": "Ada",,\n  }\n}');
    const error = body.locator(tid('rl-raw-error'));
    await expect(error).toBeVisible();
    await expect(error).toContainText(/line 3/i);
    await expect(error).toContainText(/col(umn)?\s*\d+/i);
    await expect(send).toBeDisabled();
    await expect(body.locator(tid('rl-body-view-fields'))).toBeDisabled();
    await expect(rl.ui.locator(tid('rl-warnings'))).toContainText('Raw body');

    // Fix it: the edit round-trips through the model and is sent compactly with literals preserved.
    await raw.fill(edited);
    await expect(error).toHaveCount(0);
    await expect(send).toBeEnabled();
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).bodyText).toBe(
      '{"user":{"name":"Ada","address":{"city":"Berlin","zip":"N1"}},"tags":["alpha","beta"],"active":true,' +
        '"big":12345678901234567890,"count":4,"note":null,"extra":[1,2.50]}',
    );
  });
});
