/**
 * The overlay inside a hostile or unusual page: page scripts cannot read what it shows, page key listeners
 * cannot eat its keystrokes, page modals / fullscreen / CSS zoom do not make it a dead layer, the user's
 * work survives maxEntries, and the default layouts leave room for the body editor and the response.
 */
import { HTTPONLY_COOKIE } from './server';
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const SECRET = HTTPONLY_COOKIE.split('=')[1]!;

/** Visible height of `inner` inside the scroll container `outer` (both in the panel frame). */
async function visibleHeight(rl: kineReqLens, inner: string, outer: string): Promise<number> {
  const a = await rl.ui.locator(inner).first().boundingBox();
  const b = await rl.ui.locator(outer).first().boundingBox();
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

async function hostParent(rl: kineReqLens): Promise<string> {
  return rl.page.evaluate(() => document.querySelector('reqlens-overlay')?.parentNode?.nodeName ?? 'none');
}

test.describe('overlay safety', () => {
  test('page scripts cannot read the overlay: HttpOnly cookies, Extension-mode responses, other frames', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => fetch('/api/login'));
    // A cross-origin iframe makes a request with a token the top page never sees.
    await rl.page.evaluate((cross) => {
      const f = document.createElement('iframe');
      f.src = `${cross}/blank`;
      f.id = 'widget';
      document.body.appendChild(f);
    }, rl.server.crossOrigin);
    const widget = rl.page.frameLocator('#widget');
    await expect(widget.locator('#status')).toHaveText('ready');
    const frame = rl.page.frames().find((f) => f.url().startsWith(rl.server.crossOrigin))!;
    await frame.evaluate(() => fetch('/api/echo/widget?access_token=IFRAME_TOKEN_5150'));
    await expect(rl.row('access_token=IFRAME_TOKEN_5150')).toHaveCount(1);

    // The document request shows the HttpOnly cookie as the browser sent it.
    await rl.clickApp('cross');
    await rl.select('/api/echo/cross');
    await rl.setMode('extension');
    expect(await rl.send()).toBe('done');
    // The Extension-mode response (a cross-origin read with the user's cookies) is on screen in the overlay.
    expect(await rl.rawBody()).toContain(SECRET);
    await expect(rl.ui.getByText(SECRET).first()).toBeVisible();

    const leaks = await rl.page.evaluate(
      ([secret]) => {
        const found = (text: string) => {
          getSelection()?.removeAllRanges();
          // window.find searches the flat tree (closed shadow roots included), inputs too.
          return (window as unknown as { find(s: string, cs: boolean, back: boolean, wrap: boolean): boolean }).find(text, false, false, true);
        };
        const sel = (() => {
          getSelection()?.removeAllRanges();
          (window as unknown as { find(s: string): boolean }).find('Acme Orders');
          const s = getSelection()!;
          s.modify('extend', 'forward', 'documentboundary');
          return s.toString();
        })();
        return {
          control: found('Acme Orders'),
          cookie: found(secret!),
          token: found('IFRAME_TOKEN_5150'),
          selection: sel.includes(secret!) || sel.includes('IFRAME_TOKEN_5150'),
          documentCookie: document.cookie.includes(secret!),
        };
      },
      [SECRET],
    );
    expect(leaks).toEqual({ control: true, cookie: false, token: false, selection: false, documentCookie: false });
  });

  test('page key listeners in the capture phase cannot eat keystrokes typed into the overlay', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => {
      (window as unknown as { __eaten: string[] }).__eaten = [];
      window.addEventListener(
        'keydown',
        (e) => {
          const el = document.activeElement;
          if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
          if (e.key === 'k' || e.key === '/') {
            e.preventDefault();
            (window as unknown as { __eaten: string[] }).__eaten.push(e.key);
          }
        },
        true,
      );
    });
    const filter = rl.ui.locator(tid('rl-filter-input'));
    await filter.click();
    await rl.page.keyboard.type('kick');
    await expect(filter).toHaveValue('kick');
    expect(await rl.page.evaluate(() => (window as unknown as { __eaten: string[] }).__eaten)).toEqual([]);
    await filter.fill('');
    // List keyboard navigation and the send shortcut still work.
    await rl.rows.first().click();
    await rl.page.keyboard.press('ArrowDown');
    await expect(rl.rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  });

  test('a page modal dialog: the overlay moves into it and stays usable; it comes back when the dialog goes', async ({ rl }) => {
    await rl.openApp();
    await rl.page.evaluate(() => {
      const d = document.createElement('dialog');
      d.id = 'dlg';
      d.innerHTML = '<p>Delete everything?</p><button id="confirm">Confirm: delete everything</button>';
      document.body.appendChild(d);
      (window as unknown as { __confirmed: number }).__confirmed = 0;
      d.querySelector('#confirm')!.addEventListener('click', () => (window as unknown as { __confirmed: number }).__confirmed++);
      d.addEventListener('click', (e) => {
        if (e.target === d) d.close(); // "click outside to close"
      });
      d.showModal();
    });
    await expect.poll(() => hostParent(rl)).toBe('DIALOG');
    await rl.select('/api/echo/onload-xhr');
    await rl.ui.locator(tid('rl-filter-input')).fill('onload');
    await expect(rl.ui.locator(tid('rl-filter-input'))).toHaveValue('onload');
    expect(await rl.page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open)).toBe(true);
    expect(await rl.page.evaluate(() => (window as unknown as { __confirmed: number }).__confirmed)).toBe(0);

    await rl.page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).close());
    await expect.poll(() => hostParent(rl)).toBe('HTML');
    await expect(rl.panel).toBeVisible();
    // The detail survived the moves (the panel frame was not reloaded).
    await expect(rl.ui.locator(tid('rl-filter-input'))).toHaveValue('onload');

    // A dialog removed while open (framework unmount) takes the host with it: it is re-attached.
    await rl.page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).showModal());
    await expect.poll(() => hostParent(rl)).toBe('DIALOG');
    await rl.page.evaluate(() => document.getElementById('dlg')!.remove());
    await expect.poll(() => hostParent(rl)).toBe('HTML');
    await expect(rl.panel).toBeVisible();
    await expect(rl.detail).toHaveAttribute('data-entry-id', /.+/);
  });

  test('a fullscreen page element: the overlay is shown inside it and clicks reach the overlay', async ({ rl }) => {
    await rl.openApp();
    await rl.dock('right');
    await rl.page.evaluate(() => {
      const stage = document.createElement('div');
      stage.id = 'stage';
      stage.style.cssText = 'background:#222;color:#fff';
      stage.textContent = 'stage';
      document.body.appendChild(stage);
      (window as unknown as { __stageClicks: number }).__stageClicks = 0;
      stage.addEventListener('click', () => {
        (window as unknown as { __stageClicks: number }).__stageClicks++;
        if (!document.fullscreenElement) void stage.requestFullscreen();
      });
    });
    await rl.page.locator('#stage').click({ force: true, position: { x: 5, y: 5 } });
    await expect.poll(() => rl.page.evaluate(() => document.fullscreenElement?.id ?? '')).toBe('stage');
    await expect.poll(() => hostParent(rl)).toBe('DIV');
    const clicks = await rl.page.evaluate(() => (window as unknown as { __stageClicks: number }).__stageClicks);
    await rl.select('/api/echo/onload-xhr');
    expect(await rl.page.evaluate(() => (window as unknown as { __stageClicks: number }).__stageClicks)).toBe(clicks);
    await rl.page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => hostParent(rl)).toBe('HTML');
    await expect(rl.panel).toBeVisible();
  });

  test('the floating window can be dragged; the page stays clickable around it', async ({ rl }) => {
    await rl.openApp();
    const before = (await rl.panel.boundingBox())!;
    const header = (await rl.ui.locator(tid('rl-header')).boundingBox())!;
    const x = header.x + header.width / 2;
    const y = header.y + header.height / 2;
    await rl.page.mouse.move(x, y);
    await rl.page.mouse.down();
    await rl.page.mouse.move(x + 40, y - 60, { steps: 8 });
    await rl.page.mouse.up();
    // (clamped to the viewport on the right)
    await expect.poll(async () => Math.round((await rl.panel.boundingBox())!.y)).toBe(Math.round(before.y - 60));
    // Outside the panel the page receives the clicks (the overlay frame is clipped to the panel again once the
    // drag ended).
    const button = (await rl.page.locator('#btn-query').boundingBox())!;
    const at = [button.x + button.width / 2, button.y + button.height / 2];
    await expect.poll(() => rl.page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.id, at)).toBe('btn-query');
    await rl.clickApp('query');
    expect(await rl.appLog('query')).toBe('200');
    // Minimized: only the pill takes clicks.
    await rl.ui.locator(tid('rl-minimize')).click();
    await expect(rl.pill).toBeVisible();
    const box = (await rl.pill.boundingBox())!;
    const tagAt = (px: number, py: number) =>
      rl.page.evaluate(([qx, qy]) => document.elementFromPoint(qx!, qy!)?.tagName.toLowerCase(), [px, py]);
    await expect.poll(() => tagAt(box.x + box.width / 2, box.y + box.height / 2)).toBe('reqlens-overlay');
    await expect.poll(() => tagAt(before.x + 50, before.y + 200)).not.toBe('reqlens-overlay');
  });

  test('page CSS zoom neither scales the overlay nor misplaces its menus', async ({ rl }) => {
    await rl.openApp();
    const before = (await rl.panel.boundingBox())!;
    await rl.page.evaluate(() => {
      document.documentElement.style.zoom = '1.5';
    });
    await expect.poll(async () => Math.round((await rl.panel.boundingBox())!.width)).toBe(Math.round(before.width));
    await rl.dock('right');
    await rl.dock('float');
  });

  test('edited, selected and hand-made requests survive maxEntries', async ({ rl }) => {
    await rl.patchSettings({ maxEntries: 30 });
    await rl.openApp();
    await rl.ui.locator(tid('rl-new-request')).click();
    await expect(rl.detail).toHaveAttribute('data-entry-id', /^m:/);
    const manualId = (await rl.detail.getAttribute('data-entry-id'))!;
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    await rl.jsonValue('count').fill('99');
    expect(await rl.send()).toBe('done');
    await rl.page.evaluate(async () => {
      for (let i = 0; i < 40; i++) await fetch(`/api/echo/poll?i=${i}`);
    });
    await expect(rl.row('/api/echo/poll?i=39')).toHaveCount(1);
    await expect(rl.rows).not.toHaveCount(0);
    const sw = await rl.sw();
    const ids = await sw.evaluate(async (url: string) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url)!;
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: () => (globalThis as unknown as { __reqlens: { getEntries(): Array<{ id: string; url: string }> } }).__reqlens.getEntries().map((e) => `${e.id} ${e.url}`),
      });
      return r!.result as string[];
    }, rl.page.url());
    expect(ids.length, ids.join('\n')).toBe(30);
    expect(ids.some((s) => s.endsWith('/api/echo/json'))).toBe(true);
    expect(ids.some((s) => s.startsWith(`${manualId} `))).toBe(true);
    expect(ids.some((s) => s.endsWith('/api/echo/onload?boot=1'))).toBe(false); // unprotected: evicted
    await expect(rl.detail).toBeVisible();
    await expect(rl.jsonValue('count')).toHaveValue('99');
  });

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    test(`default layout at ${size.width}x${size.height} shows the body editor and a readable response`, async ({ rl }) => {
      await rl.page.setViewportSize(size);
      await rl.openApp();
      await rl.clickApp('json', { via: 'script' });
      await rl.select('/api/echo/json');
      expect(await visibleHeight(rl, tid('rl-section-body'), '.rl-ed__scroll')).toBeGreaterThanOrEqual(100);
      expect(await rl.send()).toBe('done');
      expect((await rl.ui.locator(tid('rl-result-body')).boundingBox())!.height).toBeGreaterThanOrEqual(200);
    });
  }

  test('docked bottom on a 1280x720 screen leaves room for the editor and the response', async ({ rl }) => {
    await rl.page.setViewportSize({ width: 1280, height: 720 });
    await rl.openApp();
    await rl.dock('bottom');
    await rl.clickApp('json', { via: 'script' });
    await rl.select('/api/echo/json');
    expect((await rl.ui.locator('.rl-ed__scroll').boundingBox())!.height).toBeGreaterThanOrEqual(120);
    expect(await rl.send()).toBe('done');
    expect((await rl.ui.locator(tid('rl-result-body')).boundingBox())!.height).toBeGreaterThanOrEqual(80);
  });

  test('a narrow dock keeps the body header tools inside the card', async ({ rl }) => {
    await rl.patchSettings({ layout: { dock: 'right', dockSize: 340 } });
    await rl.openApp();
    await rl.clickApp('graphql', { via: 'script' });
    await rl.select('/graphql');
    const body = rl.section('body');
    const card = (await body.boundingBox())!;
    for (const id of ['rl-body-type', 'rl-body-view-fields', 'rl-body-view-raw']) {
      const box = (await body.locator(tid(id)).boundingBox())!;
      expect(box.x + box.width, id).toBeLessThanOrEqual(card.x + card.width + 1);
    }
    const overflow = await rl.ui.locator('.rl-ed__scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('Ctrl/Cmd+Enter sends the selected request with focus in the list', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select('/api/echo/json');
    // The entry opens on "Original response": no Test result panel until a run starts.
    await expect(rl.ui.locator(tid('rl-original-response'))).toBeVisible();
    await expect(rl.results).toHaveCount(0);
    await rl.row('/api/echo/json').first().click();
    await rl.page.keyboard.press('ControlOrMeta+Enter');
    await expect(rl.results).toHaveAttribute('data-active-run', /.+/);
  });

  test('controls name the field they act on; the late banner stays dismissed across layouts', async ({ rl }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    const banner = rl.ui.locator(tid('rl-late-banner'));
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
    await rl.clickApp('json');
    await rl.dock('right');
    await expect(banner).toHaveCount(0);
    await rl.select('/api/echo/json');
    const names = await rl.section('body').locator(tid('rl-json-delete')).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names.length).toBeGreaterThan(3);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Delete user.address.city');
    await rl.ui.locator(tid('rl-back')).click();
    await expect(banner).toHaveCount(0);
    // The dock edge is a keyboard-operable separator.
    const handle = rl.ui.locator(tid('rl-resize-handle'));
    const width = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await rl.page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBe(width + 16);
  });

  test('Windows contrast themes: checked boxes and a changed Types filter stay distinguishable', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('query');
    await rl.select('/api/echo/query');
    await rl.kvRow('query', 'foo').locator(tid('rl-kv-enabled')).uncheck();
    await rl.page.emulateMedia({ forcedColors: 'active' });
    const frame = rl.page.frames().find((f) => f.url().includes('/panel.html'))!;
    expect(await frame.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const bg = (key: string) =>
      rl.kvRow('query', key).locator(tid('rl-kv-enabled')).evaluate((el) => getComputedStyle(el).backgroundColor);
    // (polled: the checkbox colors transition)
    await expect.poll(async () => (await bg('n')) !== (await bg('foo'))).toBe(true);
    const dot = rl.kvRow('query', 'foo').locator('.rl-modified-dot');
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    // A non-default "Types" selection keeps its marker (an outline instead of the accent border).
    const types = rl.ui.locator(tid('rl-types-menu'));
    await rl.setListTypes(['fetch', 'doc']);
    await expect(types).toHaveClass(/rl-list__types--changed/);
    expect(await types.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });
});
