/**
 * v0.2 §B — the Claude Code bridge end to end, with the real pieces: the extension (dist-e2e) ⇄ the real hub
 * (`reqlens-mcp native-host`, registered by `reqlens-mcp install --manifest-dir <profile>/NativeMessagingHosts`,
 * spawned by Chromium) ⇄ the real MCP server (`reqlens-mcp serve`) driven by the MCP SDK client.
 *
 * Everything lives in temp dirs: the browser profile (Chromium reads `<user-data-dir>/NativeMessagingHosts`)
 * and REQLENS_HOME (short os.tmpdir() path: the hub socket must fit AF_UNIX). Nothing touches a real browser
 * profile or ~/.reqlens. Needs `mcp/dist/reqlens-mcp.mjs` (`npm run build:mcp`; `npm run test:e2e` builds it).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Notification } from '@modelcontextprotocol/sdk/types.js';
import type { Locator } from '@playwright/test';
import { chromium } from '@playwright/test';
import { BROWSER_CHANNEL, EXTENSION_DIR, VIEWPORT, expect, test as base, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'mcp/dist/reqlens-mcp.mjs');
const PATH = '/api/echo/json';

interface BridgeFixtures {
  /** The temp browser profile (user-data-dir). */
  profileDir: string;
  /** Temp REQLENS_HOME. */
  home: string;
}

const test = base.extend<BridgeFixtures>({
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
  // Same browser as the shared fixture, but on a profile this spec can register the native host in.
  context: async ({ profileDir }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

test.beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('mcp/dist/reqlens-mcp.mjs is missing: run `npm run build:mcp` (or `npm run test:e2e`) first');
});

function cli(args: string[], home: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REQLENS_HOME: home } });
}

function text(result: unknown): string {
  return ((result as CallToolResult).content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

async function openClaudeSettings(rl: kineReqLens): Promise<void> {
  if (await rl.ui.locator(tid('rl-claude-enable')).isVisible().catch(() => false)) return;
  await rl.ui.locator(tid('rl-settings')).click();
  await expect(rl.ui.locator(tid('rl-claude-section'))).toBeVisible();
}

async function closeSettings(rl: kineReqLens): Promise<void> {
  if (!(await rl.ui.locator(tid('rl-claude-enable')).isVisible().catch(() => false))) return;
  await rl.page.keyboard.press('Escape');
  await expect(rl.ui.locator(tid('rl-claude-enable'))).toBeHidden();
}

/** Spawn `reqlens-mcp serve` as Claude Code would and connect the SDK client; collects notifications. */
async function startMcp(home: string): Promise<{ client: Client; notifications: Notification[]; stderr: () => string }> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'serve'],
    env: { ...(process.env as Record<string, string>), REQLENS_HOME: home, CLAUDE_PROJECT_DIR: path.join(os.tmpdir(), 'e2e-project') },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'reqlens-e2e', version: '0.0.0' });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };
  await client.connect(transport);
  return { client, notifications, stderr: () => stderr };
}

test.describe('Claude Code bridge (real hub + MCP server)', () => {
  test('enable in Settings, Claude reads and sends through the overlay, "Send to Claude Code" becomes a channel notification', async ({
    rl,
    page,
    home,
    profileDir,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    cli(['install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], home);

    await rl.openApp();
    await rl.clickApp('json');
    await page.evaluate(() => fetch('/api/echo/auth?token=e2e-query-secret-123', { headers: { Authorization: 'Bearer e2e-bearer-secret-123456' } }).then((r) => r.text()));
    await expect(rl.row('/api/echo/auth')).toHaveCount(1);

    // Settings → Claude Code → Enable: the browser spawns the hub.
    await openClaudeSettings(rl);
    const status = rl.ui.locator(tid('rl-claude-status'));
    await expect(status).toContainText('Off');
    await rl.ui.locator(tid('rl-claude-enable')).check();
    await expect(status).toContainText('Connected', { timeout: 15_000 });
    await expect(rl.ui.locator(tid('rl-claude-extension-id'))).toHaveText(extensionId);

    const mcp = await startMcp(home);
    try {
      const { client, notifications } = mcp;
      expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toBeTruthy();
      await expect(status).toContainText('1 session: e2e-project', { timeout: 10_000 });
      const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });

      let result = await call('status');
      expect(text(result)).toContain('kineReqLens: connected');
      expect(text(result)).toContain('send_request: off');

      result = await call('list_requests', { kinds: ['fetch', 'xhr'] });
      const list = text(result);
      const jsonId = /^\| (\S+) \| POST \| 200 \| fetch \|.*\/api\/echo\/json/m.exec(list)?.[1];
      const authId = /^\| (\S+) \| GET \|.*\/api\/echo\/auth/m.exec(list)?.[1];
      expect(jsonId, list).toBeTruthy();
      expect(authId, list).toBeTruthy();
      expect(list).not.toContain('e2e-query-secret-123');

      result = await call('get_request', { id: authId });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('Authorization: Bearer <redacted>');
      expect(text(result)).not.toContain('e2e-bearer-secret-123456');
      expect(text(result)).not.toContain('e2e-query-secret-123');

      result = await call('get_types', { id: jsonId, format: 'zod' });
      expect(text(result)).toContain('z.object(');
      expect(text(result)).toContain('RequestBody');
      result = await call('get_prompt', { id: jsonId, target: 'tests' });
      expect(text(result)).toContain('## Task');
      expect(text(result)).toContain('## Acceptance checklist');

      // "selected" follows the overlay.
      await closeSettings(rl);
      await rl.select(PATH);
      result = await call('get_request', { id: 'selected' });
      expect(text(result)).toContain(`POST ${rl.server.origin}${PATH}`);

      // send_request: refused until the user allows it, then runs through the overlay (history badge, toast).
      result = await call('send_request', { id: jsonId });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Allow Claude to send requests');
      await openClaudeSettings(rl);
      await rl.ui.locator(tid('rl-claude-allow-send')).check();
      await closeSettings(rl);
      await expect
        .poll(async () => ((await (await rl.sw()).evaluate(async () => (await chrome.storage.local.get('reqlens:settings'))['reqlens:settings'])) as { claudeAllowSend?: boolean })?.claudeAllowSend)
        .toBe(true);
      const before = rl.server.requestsTo(PATH, 'POST').length;
      result = await call('send_request', { id: jsonId, overrides: { headers: [['X-From-Claude', 'yes']] } });
      expect(result.isError, text(result)).toBeFalsy();
      expect(text(result)).toContain('by Claude');
      expect(text(result)).toContain('## Response headers');
      const sent = rl.server.requestsTo(PATH, 'POST').slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers['x-from-claude']).toBe('yes');
      await expect(rl.ui.locator(tid('rl-run-origin-claude')).first()).toBeVisible();
      await expect(rl.ui.locator(tid('rl-toast')).filter({ hasText: 'Claude sent POST' }).first()).toBeVisible();

      // "Send to Claude Code" from the Export tab → hub push → channel notification + inbox.
      await rl.ui.locator(tid('rl-export-tab')).click();
      await rl.ui.locator(tid('rl-export-prompt-tab')).click();
      const send = rl.ui.locator(tid('rl-send-claude'));
      await expect(send).not.toHaveAttribute('aria-disabled', 'true');
      await send.click();
      await expect.poll(() => notifications.filter((n) => n.method === 'notifications/claude/channel').length, { timeout: 10_000 }).toBe(1);
      const note = notifications.find((n) => n.method === 'notifications/claude/channel')!;
      const params = note.params as { content: string; meta: Record<string, string> };
      expect(params.meta.source).toBe('reqlens');
      expect(params.content).toContain('## Task');
      await expect(rl.ui.locator(tid('rl-toast')).filter({ hasText: 'Sent to Claude Code' }).first()).toBeVisible();

      // The row context menu sends too.
      await rl.row('/api/echo/auth').click({ button: 'right' });
      await rl.ui.locator(tid('rl-ctx-send-claude')).click();
      await expect.poll(() => notifications.filter((n) => n.method === 'notifications/claude/channel').length, { timeout: 10_000 }).toBe(2);
      const second = notifications.filter((n) => n.method === 'notifications/claude/channel')[1]!.params as { content: string };
      expect(second.content).not.toContain('e2e-bearer-secret-123456');

      result = await call('inbox', { clear: true });
      expect(text(result)).toContain('2 new items');

      // Turning the bridge off stops the hub; the MCP server explains how to turn it back on.
      await openClaudeSettings(rl);
      await rl.ui.locator(tid('rl-claude-enable')).uncheck();
      await expect(status).toContainText('Off');
      await expect.poll(() => existsSync(path.join(home, 'hub.sock')), { timeout: 10_000 }).toBe(false);
      result = await call('list_requests');
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Claude Code → Enable');
    } catch (err) {
      console.log(`reqlens-mcp serve stderr:\n${mcp.stderr()}`);
      throw err;
    } finally {
      await mcp.client.close().catch(() => undefined);
    }
  });

  test('without the native host installed, Settings says "Not installed" with the install command', async ({ rl, extensionId }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    await openClaudeSettings(rl);
    await rl.ui.locator(tid('rl-claude-enable')).check();
    const status = rl.ui.locator(tid('rl-claude-status'));
    await expect(status).toContainText('Not installed', { timeout: 15_000 });
    await expect(rl.ui.locator(tid('rl-claude-cmd-install'))).toContainText(`--extension-id ${extensionId}`);
  });
});

// ------------------------------------------------------------------------------------------------------------
// "Send to Claude" of the screenshot tool: capture → dialog → the hub saves the annotated PNG in REQLENS_HOME/shots
// → a connected Claude Code session (channel notification + inbox image) or an embedded terminal (typed text).
// The terminal runs the test-only REQLENS_PTY_COMMAND stand-in (a loop appending every line it reads to typed.txt);
// HOME is a temp folder, so nothing reads or writes the real home, ~/.reqlens or ~/.claude.
// ------------------------------------------------------------------------------------------------------------

/** Stands in for `claude`: appends every line it reads to $PWD/typed.txt. */
const FAKE_CLAUDE = 'printf "ready\\n"; while IFS= read -r line; do printf "%s\\n" "$line" >> "$PWD/typed.txt"; echo "got-line"; done';

const shotTest = test.extend<{ userHome: string; workDir: string }>({
  // eslint-disable-next-line no-empty-pattern
  userHome: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-home-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  workDir: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-work-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  context: async ({ profileDir, userHome }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      // Inherited by the native host the browser spawns (test-only hook, see mcp/src/pty.ts).
      env: { ...(process.env as Record<string, string>), HOME: userHome, SHELL: '/bin/sh', REQLENS_PTY_COMMAND: FAKE_CLAUDE },
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

shotTest.describe('Send to Claude (screenshot tool)', () => {
  shotTest.skip(process.platform === 'win32', 'POSIX shell script stands in for claude');

  shotTest('capture → a Claude Code session gets the image (channel + inbox), a terminal gets the prompt and path typed', async ({
    rl,
    home,
    profileDir,
    workDir,
    extensionId,
  }) => {
    shotTest.setTimeout(150_000);
    cli(['install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], home);
    await rl.openApp();
    await rl.clickApp('json');
    await expect(rl.row(PATH)).toHaveCount(1);
    await rl.select(PATH);
    const ui = rl.ui;

    // Bridge off: the dialog explains why and links to Settings → Claude Code.
    const shotItem = ui.locator(`${tid('rl-rail-item')}[data-item="screenshot"]`);
    await shotItem.locator(tid('rl-view-shot')).click();
    await ui.locator(tid('rl-shot-capture')).click();
    await expect(ui.locator(tid('rl-shot-result'))).toBeVisible({ timeout: 15_000 });
    await ui.locator(tid('rl-shot-send')).click();
    const dialog = ui.locator(tid('rl-shot-send-dialog'));
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(tid('rl-shot-send-unavailable'))).toContainText('bridge is off');
    await expect(dialog.locator(tid('rl-shot-send-confirm'))).toBeDisabled();
    await dialog.locator(tid('rl-shot-send-setup')).click();
    await expect(dialog).toBeHidden();
    await expect(ui.locator(tid('rl-claude-section'))).toBeVisible();
    await ui.locator(tid('rl-claude-enable')).check();
    await expect(ui.locator(tid('rl-claude-status'))).toContainText('Connected', { timeout: 15_000 });
    await rl.page.keyboard.press('Escape');
    await expect(ui.locator(tid('rl-claude-enable'))).toBeHidden();

    // A Claude Code session (the real MCP server) and an embedded terminal.
    const mcp = await startMcp(home);
    try {
      const { client, notifications } = mcp;
      await ui.locator(tid('rl-claude-terminal-toggle')).click();
      await ui.locator(tid('rl-claude-terminal-cwd')).fill(workDir);
      await ui.locator(tid('rl-claude-terminal-start')).click();
      await expect(ui.locator(tid('rl-claude-terminal-status'))).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
      const screen = ui.locator(tid('rl-claude-terminal-screen'));
      await expect(screen).toContainText('ready', { timeout: 15_000 });

      // Annotate, then send to the Claude Code session (the default target) with the page URL + request context.
      const canvas = ui.locator(tid('rl-shot-canvas'));
      const box = (await canvas.boundingBox())!;
      await rl.page.mouse.move(box.x + 20, box.y + 20);
      await rl.page.mouse.down();
      await rl.page.mouse.move(box.x + 120, box.y + 80, { steps: 4 });
      await rl.page.mouse.up();
      await expect(ui.locator(tid('rl-shot-result'))).toHaveAttribute('data-annotations', '1');
      await ui.locator(tid('rl-shot-send')).click();
      await expect(dialog).toBeVisible();
      const targets = dialog.locator(tid('rl-shot-target'));
      await expect(targets).toHaveCount(2);
      await expect(targets.nth(0)).toHaveAttribute('data-kind', 'claude');
      await expect(targets.nth(0)).toHaveAttribute('aria-checked', 'true');
      await expect(targets.nth(0)).toContainText('e2e-project');
      await expect(targets.nth(1)).toHaveAttribute('data-kind', 'terminal');
      await expect(dialog.locator(tid('rl-shot-send-now'))).toHaveCount(0);
      await expect(dialog.locator(tid('rl-shot-ctx-url'))).toBeChecked();
      await expect(dialog.locator(tid('rl-shot-ctx-request'))).toBeChecked();
      await expect(dialog.locator(tid('rl-shot-send-confirm'))).toBeDisabled();
      await dialog.locator(`${tid('rl-shot-template')}[data-template="wrong"]`).click();
      await expect(dialog.locator(tid('rl-shot-prompt'))).toHaveValue(/^What’s wrong in this screen\?/);
      await dialog.locator(tid('rl-shot-send-confirm')).click();
      const sent = dialog.locator(tid('rl-shot-sent'));
      await expect(sent).toBeVisible({ timeout: 15_000 });
      const shotPath = (await sent.getAttribute('data-path'))!;
      expect(path.dirname(shotPath)).toBe(path.join(home, 'shots'));
      expect(statSync(shotPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(shotPath)).mode & 0o777).toBe(0o700);
      expect(readFileSync(shotPath).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      await expect(dialog.locator(tid('rl-shot-sent-path'))).toHaveValue(shotPath);
      await expect(rl.toast('Sent to Claude Code · e2e-project').first()).toBeVisible();

      await expect.poll(() => notifications.filter((n) => n.method === 'notifications/claude/channel').length, { timeout: 10_000 }).toBe(1);
      const note = notifications.find((n) => n.method === 'notifications/claude/channel')!.params as { content: string; meta: Record<string, string> };
      expect(note.content).toContain('What’s wrong in this screen?');
      expect(note.content).toContain(`- Page: ${rl.server.origin}/`);
      expect(note.content).toContain(`- Selected request: POST ${rl.server.origin}${PATH} → 200`);
      expect(note.content).toContain(`Screenshot: ${shotPath} (use the Read tool to view it)`);
      expect(note.meta.image_path).toBe(shotPath);
      const inbox = (await client.callTool({ name: 'inbox', arguments: {} }, undefined, { timeout: 30_000 })) as CallToolResult;
      const image = inbox.content.find((c) => c.type === 'image') as { type: 'image'; data: string; mimeType: string } | undefined;
      expect(image?.mimeType).toBe('image/png');
      expect(Buffer.from(image!.data, 'base64').equals(readFileSync(shotPath))).toBe(true);
      expect(text(inbox)).toContain('What’s wrong in this screen?');
      await dialog.locator(tid('rl-shot-send-done')).click();
      await expect(dialog).toBeHidden();

      // The terminal: "Send immediately" off types the prompt and the path but does not press Enter.
      const typed = path.join(workDir, 'typed.txt');
      const sendToTerminal = async (prompt: string, now: boolean): Promise<string> => {
        await ui.locator(tid('rl-shot-send')).click();
        const terminal: Locator = dialog.locator(`${tid('rl-shot-target')}[data-kind="terminal"]`);
        await terminal.click();
        await expect(terminal).toHaveAttribute('aria-checked', 'true');
        const toggle = dialog.locator(tid('rl-shot-send-now'));
        if ((await toggle.isChecked()) !== now) await toggle.click();
        await dialog.locator(tid('rl-shot-ctx-url')).uncheck();
        await dialog.locator(tid('rl-shot-prompt')).fill(prompt);
        await dialog.locator(tid('rl-shot-send-confirm')).click();
        await expect(dialog.locator(tid('rl-shot-sent'))).toBeVisible({ timeout: 15_000 });
        const file = (await dialog.locator(tid('rl-shot-sent')).getAttribute('data-path'))!;
        await dialog.locator(tid('rl-shot-send-done')).click();
        return file;
      };
      const first = await sendToTerminal('SHOTMARK one', false);
      expect(first).not.toBe(shotPath);
      await expect(screen).toContainText('SHOTMARK one');
      await rl.page.waitForTimeout(500);
      expect(existsSync(typed)).toBe(false);
      await screen.click();
      await rl.page.keyboard.press('Enter');
      await expect.poll(() => (existsSync(typed) ? readFileSync(typed, 'utf8') : ''), { timeout: 10_000 }).toContain(first);
      const line1 = readFileSync(typed, 'utf8').trim();
      expect(line1.startsWith('SHOTMARK one')).toBe(true);
      expect(line1).toContain(`Selected request: POST ${rl.server.origin}${PATH} → 200`);
      expect(line1.endsWith(first)).toBe(true);

      // "Send immediately" on (remembered as the last choice): typed and submitted.
      const second = await sendToTerminal('SHOTMARK two', true);
      await expect.poll(() => readFileSync(typed, 'utf8').trim().split('\n').length, { timeout: 10_000 }).toBe(2);
      const line2 = readFileSync(typed, 'utf8').trim().split('\n')[1]!;
      expect(line2.startsWith('SHOTMARK two')).toBe(true);
      expect(line2.endsWith(second)).toBe(true);
      // The terminal stays the remembered target.
      await ui.locator(tid('rl-shot-send')).click();
      await expect(dialog.locator(`${tid('rl-shot-target')}[data-kind="terminal"]`)).toHaveAttribute('aria-checked', 'true');
      await dialog.locator(tid('rl-shot-send-cancel')).click();
      await expect(dialog).toBeHidden();
    } catch (err) {
      console.log(`reqlens-mcp serve stderr:\n${mcp.stderr()}`);
      const log = path.join(home, 'hub.log');
      console.log(`hub.log:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}`);
      throw err;
    } finally {
      await mcp.client.close().catch(() => undefined);
    }
  });
});
