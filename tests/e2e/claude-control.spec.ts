/**
 * The control tools end to end (docs/CLAUDE_INTEGRATION.md "Control tools"), with the real pieces: the extension
 * (dist-e2e) ⇄ the real hub (`reqlens-mcp native-host`, installed into the temp profile) ⇄ the real MCP server
 * (`reqlens-mcp serve`) driven by the MCP SDK client over stdio. The overlay is never opened by the test: everything
 * goes through the chat tools, and the overlay must stay invisible (headless panels, capture in the background).
 *
 * Everything lives in temp dirs (browser profile, REQLENS_HOME); nothing touches a real profile or ~/.reqlens.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page, Worker } from '@playwright/test';
import { chromium } from '@playwright/test';
import { BROWSER_CHANNEL, EXTENSION_DIR, VIEWPORT, expect, test as base } from './fixtures';
import type { kineReqLens } from './fixtures';
import type { WsTestServer } from './ws-server';
import { startWsServer } from './ws-server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'mcp/dist/reqlens-mcp.mjs');

interface ControlFixtures {
  profileDir: string;
  home: string;
  mcp: Mcp;
  /**
   * Every time the overlay host was displayed in a page of the context (OVERLAY_MONITOR): empty when the overlay was
   * never shown. Kept on the test side, so it survives reloads and navigations.
   */
  overlayShown: string[];
}

interface Mcp {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Text of a successful call (fails the test otherwise). */
  ok(name: string, args?: Record<string, unknown>): Promise<string>;
  stderr(): string;
}

function text(result: CallToolResult): string {
  return (result.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

const test = base.extend<ControlFixtures>({
  // eslint-disable-next-line no-empty-pattern
  profileDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reqlens-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rlh-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  overlayShown: async ({}, use) => {
    await use([]);
  },
  context: async ({ profileDir, overlayShown }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    // The never-shown monitor, in every page from its first script on.
    await context.exposeBinding('__rlReportOverlayShown', (source, why: unknown) => {
      overlayShown.push(`${source.page?.url() ?? '?'}: ${String(why).slice(0, 300)}`);
    });
    await context.addInitScript({ content: OVERLAY_MONITOR });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  mcp: async ({ home, profileDir, extensionId, rl }, use) => {
    execFileSync(process.execPath, [CLI, 'install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], {
      encoding: 'utf8',
      env: { ...process.env, REQLENS_HOME: home },
    });
    // The user enables the bridge and lets Claude control kineReqLens (Settings → Claude Code); written directly, so
    // the overlay is never opened.
    await rl.patchSettings({ claudeBridge: true, claudeAllowControl: true, listTypes: [] });
    const sw = await rl.sw();
    await expect
      .poll(() => sw.evaluate(() => (globalThis as { __reqlensClaudeStatus?: () => { host: string } }).__reqlensClaudeStatus?.().host), { timeout: 15_000 })
      .toBe('connected');
    let stderr = '';
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      env: { ...(process.env as Record<string, string>), REQLENS_HOME: home, CLAUDE_PROJECT_DIR: path.join(os.tmpdir(), 'e2e-control') },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'reqlens-control-e2e', version: '0.0.0' });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;
    const mcp: Mcp = {
      client,
      call,
      ok: async (name, args = {}) => {
        const result = await call(name, args);
        expect(result.isError, `${name} ${JSON.stringify(args)} → ${text(result)}`).toBeFalsy();
        return text(result);
      },
      stderr: () => stderr,
    };
    try {
      await use(mcp);
    } catch (err) {
      console.log(`reqlens-mcp serve stderr:\n${stderr}`);
      const log = path.join(home, 'hub.log');
      console.log(`hub.log:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}`);
      throw err;
    } finally {
      await client.close().catch(() => undefined);
    }
  },
});

test.beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('mcp/dist/reqlens-mcp.mjs is missing: run `npm run build:mcp` (or `npm run test:e2e`) first');
});

/**
 * Runs in every page (top frame, from document start): reports each time the overlay host (`reqlens-overlay`) is
 * displayed — checked after every DOM / style change of the page (MutationObserver, including a `display` other than
 * none that was set and reset again in one task) and on every animation frame.
 */
const OVERLAY_MONITOR = `(() => {
  if (window.top !== window) return;
  const report = (why) => { try { window.__rlReportOverlayShown(why); } catch {} };
  const SHOWN_STYLE = /(?:^|;)\\s*display:\\s*(?!none\\b)[a-z]/;
  let shown = false;
  const check = (why) => {
    let display = null;
    for (const host of document.querySelectorAll('reqlens-overlay')) {
      const value = getComputedStyle(host).display;
      if (value !== 'none') display = value;
    }
    if (display !== null && !shown) report(why + ': display ' + display);
    shown = display !== null;
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target.localName === 'reqlens-overlay' && SHOWN_STYLE.test(r.oldValue || '')) report('style was ' + r.oldValue.slice(0, 200));
    }
    check('after a DOM change');
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  const frame = () => { check('on a frame'); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();`;

/** The overlay was never displayed so far in this test (any page, any time — see OVERLAY_MONITOR). */
async function expectNeverShown(page: Page, overlayShown: readonly string[]): Promise<void> {
  // Let a report the page just made reach the test first.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50))).catch(() => undefined);
  expect(overlayShown, 'the overlay was never shown').toEqual([]);
}

/** The overlay host is absent, or present but not displayed — never visible, never taking pointer events. */
async function expectOverlayInvisible(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const host = document.querySelector('reqlens-overlay') as HTMLElement | null;
    if (!host) return { host: false, display: 'none', inert: true };
    const iframe = host.shadowRoot?.querySelector('iframe') ?? null;
    return { host: true, display: getComputedStyle(host).display, inert: iframe ? iframe.inert : true };
  });
  expect(state.display, 'the overlay host is not displayed').toBe('none');
  expect(state.inert, 'the hidden overlay frame is inert').toBe(true);
}

async function hostCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('reqlens-overlay').length);
}

/**
 * `overlay reload_page`, then wait for the new document (the old one may still say "ready" for a moment: commands
 * made then would act on the page being replaced) and for it to be ready.
 */
async function reloadThroughTool(page: Page, mcp: Mcp): Promise<void> {
  await page.evaluate(() => {
    (window as { __rlBeforeReload?: boolean }).__rlBeforeReload = true;
  });
  await mcp.ok('overlay', { action: 'reload_page' });
  await expect
    .poll(() => page.evaluate(() => (window as { __rlBeforeReload?: boolean }).__rlBeforeReload === true).catch(() => true), { timeout: 15_000 })
    .toBe(false);
  await expect(page.locator('#status')).toHaveText('ready', { timeout: 15_000 });
}

async function tabIdOf(sw: Worker, url: string): Promise<number> {
  return sw.evaluate(async (u: string) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, url);
}

/** A request id of the list whose url contains `fragment`. */
function idOf(list: string, method: string, fragment: string): string {
  const row = list.split('\n').find((l) => l.startsWith('| ') && l.includes(` ${method} `) && l.includes(fragment));
  const id = row?.split('|')[1]?.trim();
  expect(id, `no ${method} ${fragment} in\n${list}`).toBeTruthy();
  return id!;
}

test.describe('Claude Code control tools (real hub + MCP server, overlay never opened)', () => {
  test('control off by default; on: background capture, filters, setups, edit + send, settings blocklist — overlay never shown', async ({ rl, page, mcp, server, overlayShown }) => {
    test.setTimeout(180_000);
    const sw = await rl.sw();
    await rl.gotoApp();
    await expectOverlayInvisible(page);

    // Off: the read tools work, the control tools explain where to turn them on.
    await rl.patchSettings({ claudeAllowControl: false });
    let status = await mcp.ok('status');
    expect(status).toContain('Control tools: off');
    const refused = await mcp.call('overlay', { action: 'open' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Let Claude control kineReqLens');
    await rl.patchSettings({ claudeAllowControl: true });
    await expect.poll(async () => text(await mcp.call('status'))).toContain('Control tools: on');

    // The tab list and the default target (the active tab: no overlay was ever opened).
    const tabId = await tabIdOf(sw, page.url());
    const tabs = await mcp.ok('inspect', { action: 'tabs' });
    expect(tabs).toMatch(new RegExp(`\\| \\* \\| ${tabId} \\|`));
    expect(tabs).toContain('closed');

    // Capture in the background, then reload so the page load is captured: the overlay never shows.
    let out = await mcp.ok('requests', { action: 'record', on: true });
    expect(out).toContain('open in the background');
    await expectOverlayInvisible(page);
    await reloadThroughTool(page, mcp);
    await rl.clickApp('json');
    await rl.clickApp('query');
    let list = '';
    await expect
      .poll(async () => {
        list = await mcp.ok('list_requests', { kinds: ['fetch', 'xhr'] });
        return list;
      })
      .toContain('/api/echo/json');
    const jsonId = idOf(list, 'POST', '/api/echo/json');
    const queryId = idOf(list, 'GET', '/api/echo/query');
    await expectOverlayInvisible(page);
    expect(await mcp.ok('inspect', { action: 'tabs' })).toContain('open in the background (hidden)');

    // List filters: a hide rule and the types; list_requests with the overlay's filters follows them.
    out = await mcp.ok('list_config', { action: 'add_rule', mode: 'hide', url: `${server.origin}/api/echo/query`, exact: true });
    const ruleId = /Added rule `([^`]+)`/.exec(out)?.[1];
    expect(ruleId, out).toBeTruthy();
    out = await mcp.ok('list_requests', { overlayFilters: true, limit: 500 });
    expect(out).not.toContain('/api/echo/query');
    expect(out).toContain('/api/echo/json');
    await mcp.ok('list_config', { action: 'types', types: ['doc'] });
    await expect
      .poll(async () => {
        out = await mcp.ok('list_requests', { overlayFilters: true, limit: 500 });
        return out;
      })
      .toContain(' document ');
    expect(out).not.toContain('/api/echo/json');
    // Setups: save the current configuration, change it, apply the setup back.
    out = await mcp.ok('setups', { action: 'save', name: 'Docs only', sites: ['127.0.0.1'] });
    expect(out).toContain('Saved setup');
    const setupId = /\| (s[^ |]+) \| Docs only \|/.exec(out)?.[1];
    expect(setupId, out).toBeTruthy();
    await mcp.ok('list_config', { action: 'types', types: ['all'] });
    await mcp.ok('list_config', { action: 'delete_rule', ruleId });
    expect(await mcp.ok('inspect', { action: 'overlay' })).toContain('No list rules.');
    out = await mcp.ok('setups', { action: 'apply', setupId });
    expect(out).toContain('Applied setup');
    let overlay = await mcp.ok('inspect', { action: 'overlay' });
    expect(overlay).toContain('Types: doc');
    expect(overlay).toContain('/api/echo/query');
    expect(overlay).toContain('setup: `Docs only`');
    const stored = (await rl.storedSettings()) as { listTypes: string[]; activeSetupId: string };
    expect(stored.listTypes).toEqual(['doc']);
    expect(stored.activeSetupId).toBe(setupId);
    const exported = await mcp.ok('inspect', { action: 'setups', export: true });
    expect(exported).toContain('"kind": "kinereqlens-setups"');
    await mcp.ok('list_config', { action: 'types', types: ['all'] });
    await mcp.ok('list_config', { action: 'clear_rules' });

    // Edit the draft like the editor does, then send it (needs "Allow Claude to send requests").
    out = await mcp.ok('edit_request', {
      requestId: jsonId,
      headers: [{ name: 'X-From-Claude', value: 'control' }],
      json: [
        { path: 'user.name', value: 'edited by Claude' },
        { path: 'extra.flag', value: true },
      ],
      params: [{ name: 'via', value: 'mcp' }],
    });
    expect(out).toContain('X-From-Claude: control');
    expect(out).toContain('"edited by Claude"');
    expect(out).toContain('via=mcp');
    const refusedSend = await mcp.call('send_request', { id: jsonId });
    expect(text(refusedSend)).toContain('Allow Claude to send requests');
    await rl.patchSettings({ claudeAllowSend: true });
    await expect.poll(async () => ((await rl.storedSettings()) as { claudeAllowSend?: boolean }).claudeAllowSend).toBe(true);
    const before = server.requestsTo('/api/echo/json', 'POST').length;
    out = await mcp.ok('send_request', { id: jsonId });
    expect(out).toContain('by Claude');
    const sent = server.requestsTo('/api/echo/json', 'POST').slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['x-from-claude']).toBe('control');
    expect(sent[0]!.url).toContain('via=mcp');
    const rawBody = sent[0]!.body.toString('utf8');
    const sentBody = JSON.parse(rawBody) as { user: { name: string }; extra: { flag: boolean } };
    expect(sentBody.user.name).toBe('edited by Claude');
    expect(sentBody.extra.flag).toBe(true);
    // Untouched values are sent exactly (the big number is not rounded).
    expect(rawBody).toContain('12345678901234567890');
    // The run, compared with the captured response; the request as cURL.
    out = await mcp.ok('inspect', { action: 'run', requestId: jsonId });
    expect(out).toContain('## Request sent');
    expect(out).toContain('X-From-Claude: control');
    out = await mcp.ok('inspect', { action: 'compare', requestId: jsonId });
    expect(out).toContain('edited by Claude');
    out = await mcp.ok('inspect', { action: 'snippet', requestId: jsonId, format: 'curl' });
    expect(out).toContain('curl ');
    expect(out).toContain('X-From-Claude: control');
    // Revert everything: the draft equals the capture again.
    out = await mcp.ok('edit_request', { requestId: jsonId, revert: ['all'] });
    expect(out).toContain('unchanged: same as captured');
    // Resend unchanged (the captured request).
    out = await mcp.ok('requests', { action: 'resend', requestId: queryId });
    expect(out).toContain('Re-sent the captured request unchanged');
    expect(out).toContain('200');

    // Settings: the security ones are refused, the others change.
    for (const key of ['claudeAllowSend', 'claudeShareSecrets', 'claudeAllowControl', 'errorsFullMode', 'autoAnalyzeErrors', 'rnEnabled', 'projectFolders', 'editorRoot']) {
      const result = await mcp.call('settings', { values: { [key]: key === 'projectFolders' ? { x: '/' } : key === 'editorRoot' ? '/tmp' : true } });
      expect(result.isError, key).toBe(true);
      expect(text(result)).toContain('Claude cannot change it');
    }
    const raise = await mcp.call('settings', { values: { responseBodyCap: 999_999_999 } });
    expect(text(raise)).toContain('may only lower it');
    out = await mcp.ok('settings', { values: { theme: 'dark', layout: { railExpanded: true }, maxEntries: 500 } });
    expect(out).toContain('theme = "dark"');
    const after = (await rl.storedSettings()) as { theme: string; maxEntries: number; claudeShareSecrets: boolean; layout: { railExpanded: boolean } };
    expect(after.theme).toBe('dark');
    expect(after.maxEntries).toBe(500);
    expect(after.layout.railExpanded).toBe(true);
    expect(after.claudeShareSecrets).toBe(false);
    expect(await mcp.ok('inspect', { action: 'settings' })).toContain('claudeAllowControl');

    // The trace the user sees in Settings → Claude Code.
    const trace = await sw.evaluate(
      () => (globalThis as { __reqlensClaudeStatus?: () => { trace?: Array<{ tool: string; action?: string }> } }).__reqlensClaudeStatus?.().trace ?? [],
    );
    expect(trace.some((t) => t.tool === 'edit_request')).toBe(true);
    expect(trace.some((t) => t.tool === 'send_request')).toBe(true);
    expect(await mcp.ok('inspect', { action: 'activity' })).toContain('list_config');

    // Minimize / restore and dock change the (global) layout; a hidden overlay stays hidden.
    await mcp.ok('overlay', { action: 'minimize' });
    await mcp.ok('overlay', { action: 'dock', dock: 'right' });
    await expectOverlayInvisible(page);
    await mcp.ok('overlay', { action: 'restore' });
    expect(((await rl.storedSettings()) as { layout: { dock: string; minimized: boolean } }).layout).toMatchObject({ dock: 'right', minimized: false });
    status = await mcp.ok('status');
    expect(status).toContain('Control tools: on');
    await expectOverlayInvisible(page);
    await expectNeverShown(page, overlayShown);
  });

  test('closed overlay: a headless panel runs the command, stays invisible and goes away when idle', async ({ rl, page, mcp, overlayShown }) => {
    test.setTimeout(120_000);
    const sw = await rl.sw();
    await sw.evaluate(() => {
      (globalThis as { __reqlensHeadlessIdleMs?: number }).__reqlensHeadlessIdleMs = 2500;
    });
    await rl.gotoApp();
    expect(await hostCount(page)).toBe(0);
    // A read of the overlay state never mounts a panel.
    let out = await mcp.ok('inspect', { action: 'overlay' });
    expect(out).toContain('Panel: not loaded');
    expect(await hostCount(page)).toBe(0);
    // A panel action mounts one invisibly (the overlay stays closed).
    out = await mcp.ok('requests', { action: 'new', method: 'POST', url: `${rl.server.origin}/api/echo/made-by-claude`, body: '{"a":1}', headers: [['Content-Type', 'application/json']] });
    const id = /Created `([^`]+)`/.exec(out)?.[1];
    expect(id, out).toBeTruthy();
    expect(await hostCount(page)).toBe(1);
    await expectOverlayInvisible(page);
    out = await mcp.ok('inspect', { action: 'overlay' });
    expect(out).toContain('headless panel mounted for Claude');
    expect(out).toContain(`selected request: \`${id}\``);
    await mcp.ok('overlay', { action: 'view', view: 'errors' });
    await expectOverlayInvisible(page);
    // Pointer and keyboard go to the page, not to the hidden panel.
    await page.mouse.click(10, 10);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('REQLENS-OVERLAY');
    // Idle: the headless panel is removed again.
    await expect.poll(() => hostCount(page), { timeout: 20_000 }).toBe(0);
    // Mounted again by the next command.
    out = await mcp.ok('requests', { action: 'new', url: `${rl.server.origin}/api/echo/again` });
    expect(out).toContain('Created');
    expect(await hostCount(page)).toBe(1);
    await expectOverlayInvisible(page);
    await expectNeverShown(page, overlayShown);
  });

  // The only test where the overlay is shown: by the user (toolbar button) and by an explicit `overlay show`.
  test('the user opens the overlay: the headless panel shows what Claude did and stays; overlay show / hide', async ({ rl, page, mcp, overlayShown }) => {
    test.setTimeout(90_000);
    const sw = await rl.sw();
    await sw.evaluate(() => {
      (globalThis as { __reqlensHeadlessIdleMs?: number }).__reqlensHeadlessIdleMs = 2500;
    });
    await rl.gotoApp();
    // Claude works in a headless panel: a new request (selected), a text filter, the rail expanded.
    let out = await mcp.ok('requests', { action: 'new', url: `${rl.server.origin}/api/echo/second` });
    const second = /Created `([^`]+)`/.exec(out)?.[1];
    expect(second, out).toBeTruthy();
    await mcp.ok('list_config', { action: 'text', text: 'second' });
    await mcp.ok('settings', { values: { layout: { railExpanded: true } } });
    expect(await hostCount(page)).toBe(1);
    await expectOverlayInvisible(page);
    await expectNeverShown(page, overlayShown);
    // The user opens the overlay (toolbar button): the same panel, with Claude's selection, filter and layout.
    await rl.toggle();
    await expect(rl.panel).toBeVisible();
    // The monitor saw it (so "never shown" in the other tests means something).
    await expect.poll(() => overlayShown.length).toBeGreaterThan(0);
    await expect(rl.detail).toHaveAttribute('data-entry-id', second!);
    await expect(rl.ui.locator('[data-testid="rl-filter-input"]')).toHaveValue('second');
    await expect(rl.ui.locator('[data-testid="rl-rail"]')).toHaveAttribute('data-expanded', 'true');
    // It is the user's now: never removed as idle.
    await page.waitForTimeout(4000);
    expect(await hostCount(page)).toBe(1);
    await expect(rl.panel).toBeVisible();
    // Settings → Claude Code lists what Claude did (newest first).
    await rl.ui.locator('[data-testid="rl-settings"]').click();
    await expect(rl.ui.locator('[data-testid="rl-claude-section"]')).toBeVisible();
    const trace = rl.ui.locator('[data-testid="rl-claude-trace-item"]');
    await expect(trace.first()).toHaveAttribute('data-tool', 'settings');
    await expect(rl.ui.locator('[data-testid="rl-claude-trace-item"][data-tool="list_config"][data-action="text"][data-ok="true"]')).toHaveCount(1);
    await expect(rl.ui.locator('[data-testid="rl-claude-trace-item"][data-tool="requests"][data-action="new"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(rl.ui.locator('[data-testid="rl-claude-section"]')).toBeHidden();
    // Hide (keeps capturing in the background) and show again.
    out = await mcp.ok('overlay', { action: 'hide' });
    expect(out).toContain('hidden');
    await expectOverlayInvisible(page);
    expect(await mcp.ok('inspect', { action: 'tabs' })).toContain('open in the background (hidden)');
    await mcp.ok('overlay', { action: 'show' });
    await expect(rl.panel).toBeVisible();
    await expect(rl.detail).toHaveAttribute('data-entry-id', second!);
  });

  test('websocket messages through the tools', async ({ rl, page, mcp, overlayShown }) => {
    test.setTimeout(120_000);
    const wss: WsTestServer = await startWsServer();
    try {
      await page.goto(wss.appUrl);
      await mcp.ok('requests', { action: 'record', on: true });
      await reloadThroughTool(page, mcp);
      let out = '';
      await expect
        .poll(async () => {
          out = await mcp.ok('inspect', { action: 'websocket' });
          return (out.match(/^### `/gm) ?? []).length;
        }, { timeout: 15_000 })
        .toBe(3);
      expect(out).toContain('socketio');
      const wsId = /### `([^`]+)` \S*\/json/.exec(out)?.[1];
      expect(wsId, out).toBeTruthy();
      // The page's sockets open a moment before their first messages reach the (hidden) panel.
      await expect
        .poll(async () => {
          out = await mcp.ok('inspect', { action: 'ws_messages', wsId, limit: 10 });
          return /^\| \d+ \|/m.test(out);
        }, { timeout: 30_000 })
        .toBe(true);
      const frameId = Number(/^\| (\d+) \|/m.exec(out)?.[1]);
      expect(frameId).toBeGreaterThan(0);
      out = await mcp.ok('inspect', { action: 'ws_messages', wsId, frameId });
      expect(out).toContain(`## Message ${frameId}`);
      await expectOverlayInvisible(page);
      await expectNeverShown(page, overlayShown);
    } finally {
      await wss.close();
    }
  });

  test('site language through the tools', async ({ rl, page, mcp, overlayShown }) => {
    test.setTimeout(90_000);
    await rl.gotoApp();
    let out = await mcp.ok('language', { action: 'set', value: 'pt-BR', scope: 'tab' });
    expect(out).toContain('pt-BR');
    await rl.waitForApp();
    await expect.poll(() => page.evaluate(() => navigator.language)).toBe('pt-BR');
    out = await mcp.ok('inspect', { action: 'language' });
    expect(out).toContain('Tab override: `pt-BR`');
    await mcp.ok('language', { action: 'reset' });
    await rl.waitForApp();
    await expect.poll(() => page.evaluate(() => navigator.language)).not.toBe('pt-BR');
    expect(await hostCount(page)).toBe(0);
    await expectNeverShown(page, overlayShown);
  });
});

// ------------------------------------------------------------------------------------------------------------
// screenshot / find_in_page through the tools: a catalog page whose values sit in absolutely positioned elements of
// known sizes. The overlay is never opened: the commands run in a headless panel (or in the background capture).
// ------------------------------------------------------------------------------------------------------------

const CATALOG = { product: { name: 'Aurora desk lamp', price: 1258291, sku: 'AUR-0042-XL' } };
const CATALOG_PAGE = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Catalog</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 16px/1.3 system-ui, sans-serif; color: #111; background: rgb(250, 250, 250); }
  #status { position: absolute; left: 10px; top: 10px; }
  #name { position: absolute; left: 200px; top: 300px; width: 240px; height: 40px; margin: 0; overflow: hidden;
    background: rgb(20, 160, 90); color: #fff; font-size: 16px; line-height: 40px; }
  #price { position: absolute; left: 200px; top: 420px; width: 160px; height: 30px; background: rgb(250, 200, 0); }
  .spacer { height: 2000px; }
</style></head><body>
<div id="status">loading</div>
<h1 id="name">…</h1>
<div id="price">…</div>
<div class="spacer"></div>
<script>
(async () => {
  const data = await (await fetch('/api/catalog')).json();
  document.getElementById('name').textContent = data.product.name;
  document.getElementById('price').textContent = data.product.price.toLocaleString('en-US');
  document.getElementById('status').textContent = 'ready';
})();
</script></body></html>`;

async function startCatalog(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/catalog') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(CATALOG_PAGE);
    } else if (url.pathname === '/api/catalog') {
      const body = JSON.stringify(CATALOG);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
      res.end(body);
    } else {
      res.writeHead(url.pathname === '/favicon.ico' ? 204 : 404);
      res.end();
    }
  });
  server.keepAliveTimeout = 500;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Width and height of a PNG (IHDR). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test.describe('screenshot and find_in_page through the tools (overlay never opened)', () => {
  test('element by text with padding: image size and the saved file; full page preview; find_in_page; the overlay never shown', async ({ rl, page, mcp, home, overlayShown }) => {
    test.setTimeout(150_000);
    const catalog = await startCatalog();
    try {
      await page.goto(`${catalog.origin}/catalog`);
      await expect(page.locator('#status')).toHaveText('ready');
      const dpr = await page.evaluate(() => window.devicePixelRatio);

      // An element by its visible text, 50 px of padding: (240 + 2 × 50) × (40 + 2 × 50) CSS px.
      const shot = await mcp.call('screenshot', { text: 'Aurora desk lamp', padding: 50 });
      expect(shot.isError, text(shot)).toBeFalsy();
      const body = text(shot);
      expect(body).toContain('340 × 140 CSS px at page 150,250 (padding 50 px)');
      expect(body).toContain('<h1>');
      const image = shot.content.find((c) => c.type === 'image') as { type: 'image'; data: string; mimeType: string } | undefined;
      expect(image?.mimeType).toBe('image/png');
      expect(pngSize(Buffer.from(image!.data, 'base64'))).toEqual({ width: Math.round(340 * dpr), height: Math.round(140 * dpr) });
      const saved = /saved to (\S+\.png)/.exec(body)?.[1];
      expect(saved, body).toBeTruthy();
      expect(path.dirname(saved!)).toBe(path.join(home, 'shots'));
      expect(statSync(saved!).mode & 0o777).toBe(0o600);
      expect(pngSize(readFileSync(saved!))).toEqual({ width: Math.round(340 * dpr), height: Math.round(140 * dpr) });
      await expectOverlayInvisible(page);

      // No padding: just the element.
      const tight = await mcp.call('screenshot', { selector: '#price', padding: 0 });
      expect(text(tight)).toContain('160 × 30 CSS px at page 200,420');
      const tightImage = tight.content.find((c) => c.type === 'image') as { data: string };
      expect(pngSize(Buffer.from(tightImage.data, 'base64'))).toEqual({ width: Math.round(160 * dpr), height: Math.round(30 * dpr) });

      // The full page (scrolled and stitched): the chat gets a preview of at most 1568 px, the file the full resolution.
      const full = await mcp.call('screenshot', { target: 'full' });
      expect(full.isError, text(full)).toBeFalsy();
      const fullText = text(full);
      const fullSize = /→ (\d+) × (\d+) px image \(preview below: (\d+) × (\d+)\)/.exec(fullText);
      expect(fullSize, fullText).toBeTruthy();
      const [fullW, fullH, previewW, previewH] = fullSize!.slice(1).map(Number) as [number, number, number, number];
      expect(fullH).toBeGreaterThanOrEqual(Math.round(2000 * dpr));
      expect(Math.max(previewW, previewH)).toBe(1568);
      const fullImage = full.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
      if (fullImage.mimeType === 'image/png') expect(pngSize(Buffer.from(fullImage.data, 'base64'))).toEqual({ width: previewW, height: previewH });
      const fullSaved = /saved to (\S+\.png)/.exec(fullText)?.[1];
      expect(fullSaved, fullText).toBeTruthy();
      expect(pngSize(readFileSync(fullSaved!))).toEqual({ width: fullW, height: fullH });
      await expectOverlayInvisible(page);

      // find_in_page: elements by text, and by a value as the page formats it.
      let out = await mcp.ok('find_in_page', { text: 'Aurora desk lamp' });
      expect(out).toContain('1 match(es)');
      expect(out).toMatch(/<h1> .*at 200,300 240×40/);
      out = await mcp.ok('find_in_page', { value: '1258291' });
      expect(out).toMatch(/at 200,420 160×30/);
      await expectOverlayInvisible(page);
      // Showing a match on the page never reveals the hidden overlay, also when it ends (Esc here).
      out = await mcp.ok('find_in_page', { text: 'Aurora desk lamp', highlight: true });
      expect(out).toContain('Highlighted match 0');
      expect(await page.locator('reqlens-find-highlight').count()).toBe(1);
      await expectOverlayInvisible(page);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.locator('reqlens-find-highlight').count()).toBe(0);
      await expectOverlayInvisible(page);
      await expectNeverShown(page, overlayShown);

      // With the request captured (in the background): the values the page shows, and an element by request + path.
      await mcp.ok('requests', { action: 'record', on: true });
      await reloadThroughTool(page, mcp);
      let list = '';
      await expect
        .poll(async () => {
          list = await mcp.ok('list_requests', { query: 'catalog', kinds: ['fetch'] });
          return list;
        })
        .toContain('/api/catalog');
      const catalogId = idOf(list, 'GET', '/api/catalog');
      out = await mcp.ok('find_in_page', { requestId: catalogId });
      expect(out).toContain('product.name');
      expect(out).toContain('product.price');
      const byPath = await mcp.call('screenshot', { requestId: catalogId, path: 'product.price', padding: 10 });
      expect(text(byPath), text(byPath)).toContain('180 × 50 CSS px at page 190,410');
      // A highlight while kineReqLens captures in the background ends by itself (8 s): the overlay stays hidden.
      out = await mcp.ok('find_in_page', { requestId: catalogId, path: 'product.name', highlight: true });
      expect(out).toContain('Highlighted match 0');
      expect(await page.locator('reqlens-find-highlight').count()).toBe(1);
      await expect.poll(() => page.locator('reqlens-find-highlight').count(), { timeout: 15_000 }).toBe(0);
      await expectOverlayInvisible(page);
      await expectNeverShown(page, overlayShown);
      // A screenshot of a tab that is not visible is refused with the reason.
      const other = await rl.context.newPage();
      await other.goto(`${catalog.origin}/catalog`);
      const hidden = await mcp.call('screenshot', { tabId: await tabIdOf(await rl.sw(), page.url()) });
      expect(hidden.isError).toBe(true);
      expect(text(hidden)).toContain('is not visible');
      expect(text(hidden)).toContain('activate: true');
      const activated = await mcp.call('screenshot', { tabId: await tabIdOf(await rl.sw(), page.url()), activate: true });
      expect(activated.isError, text(activated)).toBeFalsy();
      await other.close();
      await expectOverlayInvisible(page);
      await expectNeverShown(page, overlayShown);
    } finally {
      await catalog.close();
    }
  });
});

export type { kineReqLens };
