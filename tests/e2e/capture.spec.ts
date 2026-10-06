/**
 * Suite 8 — capture robustness: with the hook active the page's own fetch/XHR keep working and receive correct
 * bodies (incl. XHR responseType json/arraybuffer, streams, clones, aborts, errors); sendBeacon is listed;
 * webRequest-only entries (image/script/document) are listed with their status; hook entries are merged with
 * their webRequest events; replays (and their preflights) are never listed; the list filter works.
 */
import { expect, test, tid } from './fixtures';
import { bigJson, makePng } from './server';

test.describe('capture robustness', () => {
  test("the page's own fetch / XHR behave exactly as without the extension", async ({ rl }) => {
    await rl.openApp();
    const results = await rl.page.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const xhr = (method: string, url: string, responseType: XMLHttpRequestResponseType, body?: XMLHttpRequestBodyInit) =>
        new Promise<XMLHttpRequest>((resolve) => {
          const x = new XMLHttpRequest();
          x.open(method, url);
          x.responseType = responseType;
          x.onloadend = () => resolve(x);
          x.send(body ?? null);
        });

      let r = await fetch('/api/echo/robust?a=1', { method: 'POST', body: 'hello-body', headers: { 'X-T': '1' } });
      let j = await r.json();
      out.fetchText = [r.status, j.bodyText, j.headers['x-t'], r.headers.get('content-type')];

      const req = new Request('/api/echo/robust-request', { method: 'PUT', body: 'from-request', headers: { 'Content-Type': 'text/plain' } });
      r = await fetch(req);
      out.requestObject = [(await r.json()).bodyText, req.bodyUsed];

      r = await fetch('/api/echo/robust-binary', { method: 'POST', body: new Uint8Array([0, 1, 2, 250, 255]) });
      out.binaryUpload = (await r.json()).bodyBase64;

      r = await fetch('/api/echo/robust-json', { method: 'POST', body: JSON.stringify({ x: [1, 2] }), headers: { 'content-type': 'application/json' } });
      out.jsonUpload = JSON.parse((await r.json()).bodyText);

      r = await fetch('/api/image?w=16&h=16');
      const ab = new Uint8Array(await r.arrayBuffer());
      out.arrayBuffer = [ab.length, Array.from(ab.slice(0, 4))];

      r = await fetch('/api/big?n=3000');
      const reader = r.body!.getReader();
      let streamed = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamed += value.length;
      }
      out.stream = streamed;
      out.bigText = (await (await fetch('/api/big?n=3000')).text()).length;

      r = await fetch('/api/echo/robust-clone');
      const copy = r.clone();
      out.clone = [(await r.json()).path, (await copy.json()).path];

      const ac = new AbortController();
      const pending = fetch('/api/slow?ms=3000', { signal: ac.signal });
      ac.abort();
      out.abort = await pending.then(() => 'resolved', (e: Error) => e.name);
      out.networkError = await fetch('http://127.0.0.1:1/unreachable').then(() => 'resolved', (e: Error) => e.name);

      let x = await xhr('GET', '/api/echo/xhr-json?kind=json', 'json');
      out.xhrJson = [x.status, x.response.method, x.response.path];
      x = await xhr('GET', '/api/image?w=16&h=16', 'arraybuffer');
      out.xhrArrayBuffer = [(x.response as ArrayBuffer).byteLength, Array.from(new Uint8Array(x.response as ArrayBuffer).slice(0, 4))];
      x = await xhr('GET', '/api/image?w=16&h=16', 'blob');
      out.xhrBlob = [(x.response as Blob).size, (x.response as Blob).type];
      x = await xhr('POST', '/api/echo/xhr-text', '', 'xhr-body');
      out.xhrText = [x.status, JSON.parse(x.responseText).bodyText, x.getResponseHeader('content-type')];
      const sync = new XMLHttpRequest();
      sync.open('GET', '/api/echo/xhr-sync?s=1', false);
      sync.send();
      out.xhrSync = [sync.status, JSON.parse(sync.responseText).rawQuery];

      out.native = [fetch.name, fetch.length, String(fetch), String(XMLHttpRequest.prototype.open), String(navigator.sendBeacon)];
      return out;
    });

    const png = makePng(16, 16);
    expect(results).toEqual({
      fetchText: [200, 'hello-body', '1', 'application/json; charset=utf-8'],
      requestObject: ['from-request', true],
      binaryUpload: Buffer.from([0, 1, 2, 250, 255]).toString('base64'),
      jsonUpload: { x: [1, 2] },
      arrayBuffer: [png.length, [137, 80, 78, 71]],
      stream: bigJson(3000).length,
      bigText: bigJson(3000).length,
      clone: ['/api/echo/robust-clone', '/api/echo/robust-clone'],
      abort: 'AbortError',
      networkError: 'TypeError',
      xhrJson: [200, 'GET', '/api/echo/xhr-json'],
      xhrArrayBuffer: [png.length, [137, 80, 78, 71]],
      xhrBlob: [png.length, 'image/png'],
      xhrText: [200, 'xhr-body', 'application/json; charset=utf-8'],
      xhrSync: [200, 's=1'],
      native: [
        'fetch',
        1,
        'function fetch() { [native code] }',
        'function open() { [native code] }',
        'function sendBeacon() { [native code] }',
      ],
    });

    // ...and every one of them was captured with its request and response.
    await expect(rl.row('/api/echo/robust-request')).toHaveAttribute('data-method', 'PUT');
    await expect(rl.row('/api/echo/xhr-sync?s=1')).toHaveAttribute('data-kind', 'xhr');
    await expect(rl.row('/api/slow?ms=3000').locator('.rl-req-row__status [title="Canceled"]')).toHaveCount(1); // aborted
    await expect(rl.row('127.0.0.1:1/unreachable').locator('.rl-status--error')).toHaveCount(1);

    await rl.select('/api/echo/robust-request');
    await expect(rl.section('body').locator(tid('rl-body-type'))).toHaveValue('text');
    await expect(rl.section('body').locator(tid('rl-raw-body'))).toHaveValue('from-request');
    await rl.select('/api/echo/robust-binary');
    await expect(rl.section('body').locator(tid('rl-binary-body'))).toContainText('5 B');
    await rl.select('/api/echo/xhr-json');
    await rl.ui.locator(tid('rl-original-tab')).click();
    expect(JSON.parse(await rl.rawBody(rl.ui.locator(tid('rl-original-view'))))).toMatchObject({ path: '/api/echo/xhr-json' });
    await rl.select('/api/image?w=16&h=16');
    await rl.ui.locator(tid('rl-original-tab')).click();
    await expect(rl.ui.locator(tid('rl-original-view')).locator('img.rl-resp-image__img')).toBeVisible();
  });

  test('app buttons: XHR json / arraybuffer and sendBeacon are captured', async ({ rl, server }) => {
    await rl.openApp();
    await rl.clickApp('xhr-json');
    expect(await rl.appLog('xhr-json')).toBe('GET');
    await rl.clickApp('xhr-buffer');
    expect(await rl.appLog('xhr-buffer')).toBe(String(makePng(16, 16).length));
    await expect(rl.row('/api/echo/xhr-json?kind=json')).toHaveAttribute('data-kind', 'xhr');

    await rl.clickApp('beacon');
    expect(await rl.appLog('beacon')).toBe('true');
    const beacon = rl.row('/api/beacon');
    await expect(beacon).toHaveCount(1);
    await expect(beacon).toHaveAttribute('data-kind', 'beacon');
    await expect(beacon).toHaveAttribute('data-method', 'POST');
    await expect.poll(() => server.requestsTo('/api/beacon', 'POST').map((r) => r.body.toString())).toEqual(['beacon-payload']);
    // The browser's 'ping' webRequest event is merged into the beacon entry, not listed again.
    await rl.page.waitForTimeout(600);
    await expect(beacon).toHaveCount(1);
    await rl.select('/api/beacon');
    await expect(rl.section('body').locator(tid('rl-raw-body'))).toHaveValue('beacon-payload');
  });

  test('webRequest-only entries (document, script, image) are listed with status; hook entries are merged', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('assets');
    const image = rl.row('/api/image?w=20&h=20&asset=1');
    const script = rl.row('/static/extra.js');
    await expect(image).toHaveAttribute('data-kind', 'image');
    await expect(script).toHaveAttribute('data-kind', 'script');
    await expect(image.locator('.rl-req-row__status')).toHaveText('200');
    await expect(script.locator('.rl-req-row__status')).toHaveText('200');
    const doc = rl.ui.locator(`${tid('rl-request-row')}[data-kind="document"]`);
    await expect(doc).toHaveCount(1);
    await expect(doc.locator('.rl-req-row__status')).toHaveText('200');
    await expect(image.locator('.rl-req-row__size')).toHaveText(`${makePng(20, 20).length} B`);

    // Detail of a webRequest entry: status, response headers; no body (webRequest can't read it).
    await rl.select('/api/image?w=20&h=20&asset=1');
    await rl.ui.locator(tid('rl-original-tab')).click();
    const original = rl.ui.locator(tid('rl-original-view'));
    await expect(original.locator(tid('rl-result-status'))).toHaveText('200');
    await expect(original.locator(tid('rl-result-body'))).toContainText("isn't available for image requests captured from the network layer");
    await rl.respTab('headers', original).click();
    await expect(original.locator('.rl-resp-headers')).toContainText('image/png');

    // The page-load fetch was seen by the hook and by webRequest: one row, with the wire headers merged in.
    await expect(rl.row('/api/echo/onload?boot=1')).toHaveCount(1);
    await expect(rl.row('/api/echo/onload-xhr?boot=2')).toHaveCount(1);
    await rl.select('/api/echo/onload?boot=1');
    await expect(rl.section('headers').locator('.rl-ed-wire__toggle')).toContainText('Headers sent by the browser');
  });

  test('replays and their CORS preflights are never listed', async ({ rl, server }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.clickApp('cross');
    await rl.page.waitForTimeout(500); // let webRequest batches settle
    const before = await rl.rowSummaries();
    const received = server.requests.length;

    await rl.select('/api/echo/json');
    expect(await rl.send()).toBe('done'); // page mode
    await rl.setMode('extension');
    expect(await rl.send()).toBe('done');

    // A page-mode replay with a custom header to the other origin triggers a CORS preflight (OPTIONS).
    await rl.select(`${server.crossOrigin}/api/echo/cross`);
    await rl.section('headers').locator(tid('rl-kv-add')).click();
    const row = rl.kvRows('headers').last();
    await row.locator(tid('rl-kv-key')).fill('X-Preflight');
    await row.locator(tid('rl-kv-value')).fill('1');
    expect(await rl.send()).toBe('error');
    await expect.poll(() => server.requestsTo('/api/echo/cross', 'OPTIONS').length).toBeGreaterThan(0);
    await rl.setMode('extension');
    expect(await rl.send()).toBe('done');

    await rl.page.waitForTimeout(1000);
    expect(server.requests.length).toBeGreaterThanOrEqual(received + 4);
    expect(await rl.rowSummaries()).toEqual(before);
    // An identical request made by the page afterwards is listed again.
    await rl.clickApp('json');
    await expect(rl.row('/api/echo/json')).toHaveCount(2);
  });

  test('the list shows Fetch/XHR by default; the Types choice is persisted', async ({ rl }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    await rl.page.reload();
    await rl.waitForApp();
    const types = rl.ui.locator(tid('rl-types-menu'));
    await expect(rl.row('/api/echo/onload-xhr')).toHaveCount(1);
    await rl.page.waitForTimeout(600); // webRequest-only entries arrive in 150 ms batches
    await expect(types).toContainText('Fetch/XHR');
    await expect(rl.row('/static/app.css')).toHaveCount(0);
    const kinds = new Set((await rl.rowSummaries()).map((s) => s.split(' ')[1]));
    expect([...kinds].every((k) => ['fetch', 'xhr', 'beacon', 'ping'].includes(k!)), [...kinds].join()).toBe(true);

    await rl.setListTypes(['fetch', 'css']);
    await expect(rl.row('/static/app.css')).toHaveCount(1);
    await expect.poll(async () => ((await rl.storedSettings()).listTypes as string[] | undefined)?.slice().sort()).toEqual(['css', 'fetch']);
    await rl.page.reload();
    await rl.waitForApp();
    await expect(rl.row('/static/app.css')).toHaveCount(1);
    await expect(types).toContainText('Fetch/XHR, CSS');
  });

  test('list filter: text terms, exclusions and the Types dropdown', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.clickApp('graphql');
    await rl.clickApp('assets');
    const filter = rl.ui.locator(tid('rl-filter-input'));
    const urls = async () => (await rl.rowSummaries()).map((s) => new URL(s.split(' ')[2]!).pathname);

    await filter.fill('echo -onload');
    await expect.poll(urls).toEqual(['/api/echo/json']);
    await filter.fill('POST');
    await expect.poll(async () => (await urls()).sort()).toEqual(['/api/echo/json', '/graphql']);
    await filter.fill('');

    const kinds = async () => new Set((await rl.rowSummaries()).map((s) => s.split(' ')[1]));
    await rl.setListTypes(['img']);
    await expect(rl.ui.locator(tid('rl-types-menu'))).toContainText('Img');
    await expect.poll(kinds).toEqual(new Set(['image']));
    await rl.setListTypes(['js']);
    await expect.poll(kinds).toEqual(new Set(['script']));
    await rl.setListTypes(['doc']);
    await expect(rl.rows).toHaveCount(1);
    await rl.setListTypes(['img', 'js']);
    await expect.poll(kinds).toEqual(new Set(['image', 'script']));
    await rl.setListTypes('all');
    await expect(rl.ui.locator(tid('rl-types-menu'))).toContainText('All types');
    expect(await rl.rows.count()).toBeGreaterThan(8);

    // Keyboard: ↓ moves the selection through the list.
    await rl.rows.first().click();
    const first = await rl.rows.first().getAttribute('data-entry-id');
    await rl.page.keyboard.press('ArrowDown');
    await expect(rl.rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rl.detail).not.toHaveAttribute('data-entry-id', first!);
  });
});
