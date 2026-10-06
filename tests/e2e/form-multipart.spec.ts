/**
 * Suite 5 — urlencoded form (XHR) and multipart FormData with a file → edit → Send → echo shows the edited fields
 * and the file content.
 */
import { expect, test, tid } from './fixtures';

interface Part {
  name: string;
  fileName?: string;
  contentType?: string;
  value: string;
}

/** Minimal multipart/form-data parser for the echo body. */
function parseMultipart(body: string, contentType: string | null): Part[] {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType ?? '')?.[2];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  return body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const raw = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, split);
      const value = raw.slice(split + 4);
      const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
      return {
        name: /name="([^"]*)"/.exec(disp)?.[1] ?? '',
        fileName: /filename="([^"]*)"/.exec(disp)?.[1],
        contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1],
        value,
      };
    });
}

test.describe('form and multipart bodies', () => {
  test('urlencoded XHR form: edit, add, disable, send, revert', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('form');
    await rl.select('/api/echo/form');
    await expect(rl.row('/api/echo/form')).toHaveAttribute('data-kind', 'xhr');
    const body = rl.section('body');
    await expect(body.locator(tid('rl-body-type'))).toHaveValue('form');
    expect(await rl.kvRows('body').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key))).toEqual(['a', 'b', 'c']);
    await expect(rl.kvRow('body', 'b').locator(tid('rl-kv-value'))).toHaveValue('two words');
    await expect(rl.kvRow('body', 'c').locator(tid('rl-kv-value'))).toHaveValue('é');

    await rl.kvRow('body', 'b').locator(tid('rl-kv-value')).fill('three words & more');
    await expect(rl.kvRow('body', 'b')).toHaveAttribute('data-modified', 'true');
    expect(await rl.send()).toBe('done');
    let echo = await rl.echo();
    expect(echo.method).toBe('POST');
    expect(echo.contentType).toBe('application/x-www-form-urlencoded');
    // Untouched fields keep their captured encoding byte for byte.
    expect(echo.bodyText).toBe('a=1&b=three%20words%20%26%20more&c=%C3%A9');
    expect([...new URLSearchParams(echo.bodyText)]).toEqual([
      ['a', '1'],
      ['b', 'three words & more'],
      ['c', 'é'],
    ]);

    // Add a field and disable one.
    await body.locator(tid('rl-kv-add')).click();
    const added = rl.kvRows('body').last();
    await added.locator(tid('rl-kv-key')).fill('d');
    await added.locator(tid('rl-kv-value')).fill('4');
    await rl.kvRow('body', 'a').locator(tid('rl-kv-enabled')).uncheck();
    expect(await rl.send()).toBe('done');
    echo = await rl.echo();
    expect(echo.bodyText).toBe('b=three%20words%20%26%20more&c=%C3%A9&d=4');

    // Raw view of the form body.
    await body.locator(tid('rl-body-view-raw')).click();
    await expect(body.locator(tid('rl-raw-body'))).toHaveValue('b=three%20words%20%26%20more&c=%C3%A9&d=4');
    await body.locator(tid('rl-body-view-fields')).click();

    // Section revert restores the captured body; it is re-sent verbatim.
    await body.locator(tid('rl-section-revert')).click();
    await expect(rl.kvRow('body', 'b').locator(tid('rl-kv-value'))).toHaveValue('two words');
    await expect(rl.kvRow('body', 'd')).toHaveCount(0);
    expect(await rl.send()).toBe('done');
    expect((await rl.echo()).bodyText).toBe('a=1&b=two+words&c=%C3%A9');
  });

  test('multipart FormData with a file: edit text part, add part, replace file', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('multipart');
    await rl.select('/api/echo/upload');
    const body = rl.section('body');
    await expect(body.locator(tid('rl-body-type'))).toHaveValue('multipart');
    const parts = body.locator(tid('rl-mp-part'));
    expect(await parts.evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.name}:${(e as HTMLElement).dataset.kind}`))).toEqual([
      'title:text',
      'attachment:file',
    ]);
    const title = body.locator(`${tid('rl-mp-part')}[data-name="title"]`);
    const file = body.locator(`${tid('rl-mp-part')}[data-name="attachment"]`);
    await expect(title.locator(tid('rl-mp-value'))).toHaveValue('Quarterly report');
    await expect(file.locator(tid('rl-mp-filename'))).toHaveValue('notes.txt');
    await expect(file.locator(tid('rl-mp-mime'))).toHaveValue('text/plain');
    await expect(file.locator('.rl-mp-file__size')).toHaveText('18 B');

    // Edit the text part: the captured file content is sent along.
    await title.locator(tid('rl-mp-value')).fill('Annual report');
    await expect(title).toHaveAttribute('data-modified', 'true');
    await expect(file).toHaveAttribute('data-modified', 'false');
    expect(await rl.send()).toBe('done');
    let echo = await rl.echo();
    expect(echo.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(parseMultipart(echo.bodyText, echo.contentType)).toEqual([
      { name: 'title', fileName: undefined, contentType: undefined, value: 'Annual report' },
      { name: 'attachment', fileName: 'notes.txt', contentType: 'text/plain', value: 'hello file content' },
    ]);

    // Add a text part and replace the file through the picker.
    await body.locator(tid('rl-mp-add-text')).click();
    const extra = parts.last();
    await extra.locator(tid('rl-mp-name')).fill('extra');
    await extra.locator(tid('rl-mp-value')).fill('yes');
    await file.locator(tid('rl-mp-file')).setInputFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: Buffer.from('id,name\n1,Ada\n') });
    await expect(file.locator(tid('rl-mp-filename'))).toHaveValue('new.csv');
    await expect(file).toHaveAttribute('data-modified', 'true');
    expect(await rl.send()).toBe('done');
    echo = await rl.echo();
    expect(parseMultipart(echo.bodyText, echo.contentType)).toEqual([
      { name: 'title', fileName: undefined, contentType: undefined, value: 'Annual report' },
      { name: 'attachment', fileName: 'new.csv', contentType: 'text/csv', value: 'id,name\n1,Ada\n' },
      { name: 'extra', fileName: undefined, contentType: undefined, value: 'yes' },
    ]);

    // Per-part revert, then revert all.
    await file.locator(tid('rl-mp-revert')).click();
    await expect(file.locator(tid('rl-mp-filename'))).toHaveValue('notes.txt');
    await rl.ui.locator(tid('rl-revert-all')).click();
    await expect(parts).toHaveCount(2);
    await expect(title.locator(tid('rl-mp-value'))).toHaveValue('Quarterly report');
    expect(await rl.send()).toBe('done');
    echo = await rl.echo();
    expect(parseMultipart(echo.bodyText, echo.contentType).map((p) => p.value)).toEqual(['Quarterly report', 'hello file content']);
  });
});
