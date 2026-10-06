/**
 * WebSocket inspector: the hook records the page's sockets (from document_start, buffered until the overlay says
 * it is recording), the panel lists connections + detected channels, splits messages by direction and shows a
 * message's payload — while the page's own sockets behave exactly as without kineReqLens.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import type { kineReqLens } from './fixtures';
import { SCREENSHOT_DIR, expect, test, tid } from './fixtures';
import type { WsTestServer } from './ws-server';
import { startWsServer } from './ws-server';

let wss: WsTestServer;
test.beforeAll(async () => {
  wss = await startWsServer();
});
test.afterAll(async () => {
  await wss.close();
});

/** Load the demo with the overlay open from document_start, then switch to the WebSocket view. */
async function openWsApp(rl: kineReqLens): Promise<void> {
  await rl.page.goto(wss.appUrl);
  await rl.openOverlay();
  await rl.page.reload();
  await expect(rl.page.locator('#status')).toHaveText('ready', { timeout: 15_000 });
  await expect(rl.panel).toBeVisible();
  await rl.ui.locator(tid('rl-view-ws')).click();
  await expect(rl.ui.locator(tid('rl-ws-view'))).toBeVisible();
  await expect(rl.ui.locator(tid('rl-view-ws-count'))).toHaveText('3');
}

function connection(rl: kineReqLens, fragment: string): Locator {
  return rl.ui.locator(`${tid('rl-ws-connection')}[data-url*="${fragment}"]`);
}

function channel(rl: kineReqLens, wsId: string, name: string): Locator {
  return rl.ui.locator(`${tid('rl-ws-channel')}[data-ws-id="${wsId}"][data-channel="${name}"]`);
}

function messages(rl: kineReqLens, filter = ''): Locator {
  return rl.ui.locator(`${tid('rl-ws-message')}${filter}`);
}

async function wsIdOf(conn: Locator): Promise<string> {
  return (await conn.getAttribute('data-ws-id'))!;
}

test('lists connections, detects channels, splits directions and shows a message', async ({ rl }) => {
  await openWsApp(rl);
  const io = connection(rl, '/socket.io/');
  const json = connection(rl, '/json');
  const gql = connection(rl, '/graphql');
  await expect(rl.ui.locator(tid('rl-ws-connection'))).toHaveCount(3);
  await expect(io).toHaveAttribute('data-protocol', 'socketio');
  await expect(json).toHaveAttribute('data-protocol', 'json');
  await expect(gql).toHaveAttribute('data-protocol', 'graphql-ws');
  await expect(io).toHaveAttribute('data-state', 'open');

  // The page talks on its own socket; the overlay shows both directions.
  await rl.page.evaluate(() => (window as unknown as { ioEmit(e: string, d: unknown): void }).ioEmit('chat message', { text: 'hello' }));
  await rl.page.waitForFunction(() =>
    (window as unknown as { __ws: { received: { io: string[] } } }).__ws.received.io.some((m) => m.includes('"echo":true')),
  );

  await io.click();
  const ioId = await wsIdOf(io);
  for (const name of ['join', 'presence', 'chat message', 'typing', 'heartbeats']) await expect(channel(rl, ioId, name)).toHaveCount(1);

  await channel(rl, ioId, 'chat message').click();
  await expect(messages(rl)).toHaveCount(2);
  await expect(messages(rl, '[data-dir="out"]')).toHaveCount(1);
  await expect(messages(rl, '[data-dir="in"]')).toHaveCount(1);
  await expect(messages(rl, '[data-dir="out"]')).toHaveAttribute('data-event', 'chat message');
  await expect(messages(rl, '[data-dir="out"]')).toContainText('{"text":"hello"}');

  // Detail of the received message: JSON tree of the packet, raw text, metadata.
  await messages(rl, '[data-dir="in"]').click();
  const detail = rl.ui.locator(tid('rl-ws-detail'));
  await expect(detail.locator(tid('rl-ws-detail-dir'))).toHaveAttribute('data-dir', 'in');
  await expect(detail.locator(tid('rl-ws-detail-event'))).toHaveText('chat message');
  await expect(detail.locator(tid('rl-ws-json'))).toContainText('hello');
  await expect(detail.locator(tid('rl-ws-json'))).toContainText('echo');
  await expect(detail.locator(tid('rl-ws-meta'))).toContainText('Socket.IO');
  await detail.locator(tid('rl-ws-view-raw')).click();
  await expect(detail.locator(tid('rl-ws-raw'))).toHaveText(/^42\["chat message",\{"text":"hello","echo":true/);

  // Keyboard: ↑ moves to the sent message.
  await rl.ui.locator(tid('rl-ws-messages')).press('ArrowUp');
  await expect(detail.locator(tid('rl-ws-detail-dir'))).toHaveAttribute('data-dir', 'out');

  // "All messages" hides heartbeat / control frames until asked.
  await rl.ui.locator(`${tid('rl-ws-all')}[data-ws-id="${ioId}"]`).click();
  await expect(messages(rl, '[data-event="chat message"]')).toHaveCount(2);
  await expect(messages(rl, '[data-channel="heartbeats"]')).toHaveCount(0);
  await rl.ui.locator(tid('rl-ws-heartbeats')).click();
  // Engine.IO open, connect (sent + answer), ping, pong.
  await expect(messages(rl, '[data-channel="heartbeats"]')).toHaveCount(5);
  await rl.ui.locator(tid('rl-ws-heartbeats')).click();

  // GraphQL subscriptions are named after their operation.
  await gql.click();
  const gqlId = await wsIdOf(gql);
  await channel(rl, gqlId, 'OnMessageAdded').click();
  await expect(messages(rl)).toHaveCount(4); // subscribe, next, next, complete
  await expect(messages(rl, '[data-dir="in"][data-event="next"]')).toHaveCount(2);
});

test('JSON channels, filters, binary frames, composer — the page socket is unaffected', async ({ rl }) => {
  await openWsApp(rl);
  const json = connection(rl, '/json');
  await json.click();
  const id = await wsIdOf(json);
  await expect(channel(rl, id, 'prices')).toHaveCount(1);
  await channel(rl, id, 'prices').click();
  // subscribe ↑, subscribed + 3 ticks ↓
  await expect(messages(rl)).toHaveCount(5);
  await rl.ui.locator(`${tid('rl-ws-dir')} [data-value="in"]`).click();
  await expect(messages(rl)).toHaveCount(4);
  await expect(messages(rl, '[data-dir="out"]')).toHaveCount(0);
  await rl.ui.locator(`${tid('rl-ws-dir')} [data-value="all"]`).click();

  // JSON path filter, then text filter with exclusion.
  const filter = rl.ui.locator(tid('rl-ws-filter'));
  await filter.fill('$.price = 102');
  await expect(filter).toHaveAttribute('data-mode', 'path');
  await expect(messages(rl)).toHaveCount(1);
  await expect(messages(rl)).toContainText('"seq":2');
  await filter.fill('tick -103');
  await expect(messages(rl)).toHaveCount(2);
  await filter.fill('');
  await expect(messages(rl)).toHaveCount(5);

  // The ping / pong pair is a heartbeat (its own group).
  await expect(channel(rl, id, 'heartbeats')).toHaveCount(1);

  // Binary: the page sends bytes, the server echoes them reversed.
  await rl.page.evaluate(() => {
    const w = window as unknown as { __ws: { sockets: { json: WebSocket } } };
    w.__ws.sockets.json.send(new Uint8Array([1, 2, 3, 250]).buffer);
  });
  await rl.page.waitForFunction(() => JSON.stringify((window as unknown as { __ws: { binaryEcho: number[] } }).__ws.binaryEcho) === '[250,3,2,1]');
  await rl.ui.locator(`${tid('rl-ws-all')}[data-ws-id="${id}"]`).click();
  await expect(messages(rl, '[data-opcode="binary"]')).toHaveCount(2);
  await messages(rl, '[data-opcode="binary"][data-dir="in"]').click();
  const detail = rl.ui.locator(tid('rl-ws-detail'));
  await expect(detail.locator(tid('rl-ws-hex'))).toContainText('fa 03 02 01');
  await expect(detail.locator(tid('rl-ws-meta'))).toContainText('Binary');

  // Composer: sent through the page's own socket on an explicit click; the page receives the server's answer.
  await rl.ui.locator(tid('rl-ws-compose-toggle')).click();
  await rl.ui.locator(tid('rl-ws-composer-input')).fill('{"channel":"chat","text":"from overlay"}');
  await rl.ui.locator(tid('rl-ws-composer-send')).click();
  await rl.page.waitForFunction(() =>
    (window as unknown as { __ws: { received: { json: string[] } } }).__ws.received.json.some((m) => m.includes('from overlay')),
  );
  await expect(channel(rl, id, 'chat')).toHaveCount(1);
  await channel(rl, id, 'chat').click();
  await expect(messages(rl, '[data-dir="out"]')).toHaveCount(1);
  await expect(messages(rl, '[data-dir="in"]')).toHaveCount(1);

  // Page-observable behaviour of WebSocket is unchanged.
  const checks = await rl.page.evaluate(async () => {
    const w = window as unknown as { __ws: { sockets: Record<string, WebSocket>; received: Record<string, string[]> } };
    const s = w.__ws.sockets.json;
    class Sub extends WebSocket {}
    const sub = new Sub(`ws://${location.host}/json`);
    const subOk = sub instanceof Sub && sub instanceof WebSocket && Object.getPrototypeOf(sub) === Sub.prototype;
    await new Promise((resolve) => sub.addEventListener('open', resolve, { once: true }));
    sub.close();
    let threw = '';
    try {
      (WebSocket as unknown as (url: string) => void)('ws://127.0.0.1:1/');
    } catch (e) {
      threw = (e as Error).constructor.name;
    }
    let syntax = '';
    try {
      new WebSocket('http://[bad');
    } catch (e) {
      syntax = (e as Error).name;
    }
    return {
      instance: s instanceof WebSocket,
      ctor: s.constructor === WebSocket,
      constants: [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED, s.OPEN],
      ctorString: Function.prototype.toString.call(WebSocket),
      sendString: String(WebSocket.prototype.send),
      name: WebSocket.name,
      length: WebSocket.length,
      proto: Object.getPrototypeOf(WebSocket) === EventTarget,
      descriptor: Object.getOwnPropertyDescriptor(window, 'WebSocket')?.enumerable,
      subOk,
      threw,
      syntax,
      negotiated: w.__ws.sockets.gql!.protocol,
      binaryType: s.binaryType,
      jsonReceived: w.__ws.received.json.length,
    };
  });
  expect(checks).toMatchObject({
    instance: true,
    ctor: true,
    constants: [0, 1, 2, 3, 1],
    ctorString: 'function WebSocket() { [native code] }',
    sendString: 'function send() { [native code] }',
    name: 'WebSocket',
    length: 1,
    proto: true,
    descriptor: false,
    subOk: true,
    threw: 'TypeError',
    syntax: 'SyntaxError',
    negotiated: 'graphql-transport-ws',
    binaryType: 'arraybuffer',
  });
  // subscribed + 3 ticks + pong + chat echo
  expect(checks.jsonReceived).toBe(6);

  // Capture follows the overlay: while it is closed nothing is recorded, but the socket keeps working.
  await rl.ui.locator(tid('rl-close')).click();
  await expect(rl.panel).toBeHidden();
  await rl.page.evaluate(() => (window as unknown as { __ws: { sockets: { json: WebSocket } } }).__ws.sockets.json.send('{"type":"ping","t":99}'));
  await rl.page.waitForFunction(() =>
    (window as unknown as { __ws: { received: { json: string[] } } }).__ws.received.json.some((m) => m.includes('"t":99')),
  );
  await rl.openOverlay();
  await rl.ui.locator(`${tid('rl-ws-all')}[data-ws-id="${id}"]`).click();
  await rl.ui.locator(tid('rl-ws-heartbeats')).click();
  await expect(messages(rl, '[data-channel="heartbeats"]')).toHaveCount(2); // ping + pong of t:1 only
});

test('streams thousands of frames: virtualized list, bounded ring, page unaffected', async ({ rl }) => {
  await openWsApp(rl);
  const json = connection(rl, '/json');
  await json.click();
  const id = await wsIdOf(json);
  await rl.ui.locator(`${tid('rl-ws-all')}[data-ws-id="${id}"]`).click();
  // 3000 sends + 3000 echoes on one socket, as fast as the page can.
  await rl.page.evaluate(() => {
    const s = (window as unknown as { __ws: { sockets: { json: WebSocket } } }).__ws.sockets.json;
    for (let i = 0; i < 3000; i++) s.send(JSON.stringify({ channel: 'bulk', type: 'item', i }));
  });
  await rl.page.waitForFunction(
    () => (window as unknown as { __ws: { received: { json: string[] } } }).__ws.received.json.filter((m) => m.includes('"bulk"')).length === 3000,
    undefined,
    { timeout: 30_000 },
  );
  // The ring keeps about the newest 5000 frames of the connection; the sidebar counts every frame.
  await expect(json).toContainText('6,007 msgs');
  await expect.poll(async () => Number(((await rl.ui.locator(tid('rl-ws-count')).textContent()) ?? '').replace(/[^0-9]/g, ''))).toBeGreaterThan(4800);
  const kept = Number(((await rl.ui.locator(tid('rl-ws-count')).textContent()) ?? '').replace(/[^0-9]/g, ''));
  expect(kept).toBeLessThanOrEqual(5000);
  // Only the visible rows are in the DOM; the newest message is in view (stick to bottom).
  expect(await messages(rl).count()).toBeLessThan(80);
  await expect(messages(rl).last()).toContainText('"i":2999');
  // Scrolling up stops following; new messages then show the jump pill.
  await rl.ui.locator(tid('rl-ws-messages')).evaluate((el) => el.scrollTo(0, 0));
  await rl.page.evaluate(() => (window as unknown as { __ws: { sockets: { json: WebSocket } } }).__ws.sockets.json.send('{"channel":"bulk","i":-1}'));
  await expect(rl.ui.locator(tid('rl-ws-jump'))).toBeVisible();
  await rl.ui.locator(tid('rl-ws-jump')).click();
  await expect(messages(rl).last()).toContainText('"i":-1');
});

test('narrow docks collapse the layout', async ({ rl }) => {
  await openWsApp(rl);
  await rl.dock('right');
  const view = rl.ui.locator(tid('rl-ws-view'));
  await expect(view).not.toHaveAttribute('data-layout', 'wide');
  await expect(rl.ui.locator(tid('rl-ws-messages-pane'))).toBeVisible();
  const last = rl.ui.locator(tid('rl-ws-messages')).locator(tid('rl-ws-message')).last();
  const lastId = (await last.getAttribute('data-frame-id'))!;
  await last.click();
  await expect(rl.ui.locator(tid('rl-ws-detail'))).toHaveAttribute('data-frame-id', lastId);
  await rl.page.waitForTimeout(400);
  await rl.page.screenshot({ path: test.info().outputPath('ws-docked.png') });
  if ((await view.getAttribute('data-layout')) === 'narrow') {
    const picker = rl.ui.locator(tid('rl-ws-picker'));
    await expect(picker).toBeVisible();
  } else {
    await expect(rl.ui.locator(tid('rl-ws-sidebar'))).toBeVisible();
  }
  await rl.dock('float');
  await expect(view).toHaveAttribute('data-layout', 'wide');
});

test('explains the empty state on a page without sockets', async ({ rl }) => {
  await rl.gotoApp();
  await rl.openOverlay();
  await rl.ui.locator(tid('rl-view-ws')).click();
  const empty = rl.ui.locator(tid('rl-ws-empty'));
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No WebSocket connections on this page yet');
  await expect(empty).toContainText('Reload the page');
  await expect(rl.ui.locator(tid('rl-view-ws-count'))).toHaveText('0');
  await rl.page.screenshot({ path: test.info().outputPath('ws-empty.png') });
  // A socket opened now shows up live.
  await rl.page.evaluate(() => {
    (window as unknown as { __late: WebSocket }).__late = new WebSocket('ws://127.0.0.1:1/never');
  });
  await expect(rl.ui.locator(tid('rl-ws-connection'))).toHaveCount(1);
  await expect(rl.ui.locator(tid('rl-view-ws-count'))).toHaveText('1');
  // The HTTP view is still one click away, unchanged.
  await rl.ui.locator(tid('rl-view-http')).click();
  await expect(rl.ui.locator(tid('rl-request-list'))).toBeVisible();
});

async function setTheme(rl: kineReqLens, theme: 'Light' | 'Dark'): Promise<void> {
  await rl.ui.locator(tid('rl-settings')).click();
  await rl.ui.getByRole('radio', { name: theme }).click();
  await rl.page.keyboard.press('Escape');
  await expect(rl.ui.locator('.rl-root')).toHaveAttribute('data-theme', theme.toLowerCase());
}

test('screenshots (light / dark)', async ({ rl }) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await openWsApp(rl);
  const emit = (event: string, data: unknown, ack?: number) =>
    rl.page.evaluate(
      ([e, d, a]) => (window as unknown as { ioEmit(e: string, d: unknown, a?: string): void }).ioEmit(e as string, d, a as string | undefined),
      [event, data, ack === undefined ? undefined : String(ack)] as const,
    );
  const lines = ['hey there 👋', 'is the deploy done?', 'yes — v2.4.1 is live', 'nice, thanks!'];
  for (const [i, text] of lines.entries()) {
    await emit('chat message', { room: 'lobby', user: i % 2 ? 'bob' : 'ann', text });
    await rl.page.waitForTimeout(30);
  }
  await emit('history', { room: 'lobby', limit: 50 }, 7);
  await rl.page.waitForTimeout(200);

  const io = connection(rl, '/socket.io/');
  await io.click();
  const ioId = await wsIdOf(io);
  await rl.ui.locator(`${tid('rl-ws-all')}[data-ws-id="${ioId}"]`).click();
  await messages(rl, '[data-dir="in"][data-event="chat message"]').nth(2).click();
  await expect(rl.ui.locator(tid('rl-ws-json'))).toBeVisible();

  for (const theme of ['Light', 'Dark'] as const) {
    await setTheme(rl, theme);
    // Focus the timeline (selected row in its focused colour), not the settings button.
    await rl.ui.locator(tid('rl-ws-messages')).focus();
    await rl.page.mouse.move(2, 890);
    await rl.page.waitForTimeout(400);
    const file = theme === 'Light' ? path.join(SCREENSHOT_DIR, 'websocket.png') : test.info().outputPath('websocket-dark.png');
    await rl.page.screenshot({ path: file, caret: 'hide', animations: 'disabled' });
  }
});
