/**
 * The embedded Claude Code terminal end to end: the panel's xterm.js pane ⇄ the worker's relay ⇄ the real hub
 * (`reqlens-mcp native-host`, spawned by Chromium from a temp profile's NativeMessagingHosts) ⇄ node-pty.
 *
 * Instead of the real `claude` CLI the hub runs the test-only REQLENS_PTY_COMMAND (passed through the browser's
 * environment to the native host): a tiny interactive shell script. Everything lives in temp dirs (profile,
 * REQLENS_HOME, the working directory, and HOME — so the folder browser lists a temp home, never yours); nothing
 * touches a real browser profile, ~/.reqlens or ~/.claude. The native folder chooser is not exercised: the test-only
 * REQLENS_FS_PICK_STUB makes the hub answer "Choose folder…" with <HOME>/code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { BROWSER_CHANNEL, EXTENSION_DIR, VIEWPORT, expect, test as base, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'mcp/dist/reqlens-mcp.mjs');
/** Stands in for `claude`: prints Unicode, prompts, echoes one line, exits 7. */
const FAKE_CLAUDE = `printf 'ready \\303\\251 \\342\\234\\223 [%s]\\n' "$(pwd)"; printf '> '; read line; echo "got:$line"; exit 7`;

interface TerminalFixtures {
  profileDir: string;
  home: string;
  workDir: string;
  /** HOME of the browser and of the hub it spawns. */
  userHome: string;
}

const test = base.extend<TerminalFixtures>({
  // eslint-disable-next-line no-empty-pattern
  profileDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reqlens-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use, testInfo) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rlh-'));
    await use(dir);
    if (testInfo.status !== testInfo.expectedStatus) {
      const log = path.join(dir, 'hub.log');
      console.log(`hub.log:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}`);
    }
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  workDir: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-work-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  userHome: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-home-')));
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
      env: {
        ...(process.env as Record<string, string>),
        HOME: userHome,
        SHELL: '/bin/sh',
        REQLENS_PTY_COMMAND: FAKE_CLAUDE,
        REQLENS_FS_PICK_STUB: path.join(userHome, 'code'),
      },
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

async function enableBridge(rl: kineReqLens): Promise<void> {
  if (!(await rl.ui.locator(tid('rl-claude-enable')).isVisible().catch(() => false))) {
    await rl.ui.locator(tid('rl-settings')).click();
  }
  await rl.ui.locator(tid('rl-claude-enable')).check();
  await expect(rl.ui.locator(tid('rl-claude-status'))).toContainText('Connected', { timeout: 15_000 });
  await rl.page.keyboard.press('Escape');
  await expect(rl.ui.locator(tid('rl-claude-enable'))).toBeHidden();
}

test.skip(process.platform === 'win32', 'POSIX shell script stands in for claude');

test('Claude terminal: unavailable until the bridge is on, then runs, takes input, exits, restarts, re-attaches', async ({
  rl,
  page,
  home,
  profileDir,
  workDir,
  extensionId,
}) => {
  test.setTimeout(120_000);
  execFileSync(process.execPath, [CLI, 'install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], {
    encoding: 'utf8',
    env: { ...process.env, REQLENS_HOME: home },
  });
  await rl.gotoApp();
  await rl.openOverlay();
  const ui = rl.ui;

  // Bridge off: the pane explains why and links to Settings → Claude Code.
  const toggle = ui.locator(tid('rl-claude-terminal-toggle'));
  await expect(toggle).toHaveAttribute('data-available', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(ui.locator(tid('rl-claude-terminal-disabled'))).toBeVisible();
  await expect(ui.locator(tid('rl-claude-terminal-reason'))).toContainText('bridge is off');
  await ui.locator(tid('rl-claude-terminal-setup')).click();
  await expect(ui.locator(tid('rl-claude-section'))).toBeVisible();

  await enableBridge(rl);
  await expect(toggle).toHaveAttribute('data-available', 'true');

  // The working-directory form: a bad folder is refused with the reason.
  const cwd = ui.locator(tid('rl-claude-terminal-cwd'));
  await cwd.fill(path.join(workDir, 'missing'));
  await ui.locator(tid('rl-claude-terminal-start')).click();
  await expect(ui.locator(tid('rl-claude-terminal-form-error'))).toContainText('No such directory');
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(0);

  // Start in a real folder: output (Unicode) shows in xterm, keystrokes reach the process.
  await cwd.fill(workDir);
  await ui.locator(tid('rl-claude-terminal-start')).click();
  const tab = ui.locator(tid('rl-claude-terminal-tab'));
  await expect(tab).toHaveCount(1);
  const status = ui.locator(tid('rl-claude-terminal-status'));
  await expect(status).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  const screen = ui.locator(tid('rl-claude-terminal-screen'));
  await expect(screen).toContainText(`ready é ✓ [${workDir}]`, { timeout: 15_000 });
  await expect(screen).toContainText('>');
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('got:hello');
  await expect(status).toHaveAttribute('data-state', 'exited');
  await expect(status).toHaveAttribute('data-exit-code', '7');
  await expect(status).toContainText('Exited (code 7)');

  // The folder joined the recent list (persisted).
  await expect.poll(async () => (await rl.storedSettings()).claudeRecentDirs).toEqual([workDir]);

  // Restart: same folder, fresh screen.
  await ui.locator(tid('rl-claude-terminal-restart')).click();
  await expect(status).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  await expect(screen).toContainText('ready é ✓');
  await expect(screen).not.toContainText('got:hello');

  // Reload the panel frame: the running terminal is handed back with its output replayed.
  await rl.panelFrame().evaluate(() => location.reload());
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(1, { timeout: 15_000 });
  await expect(ui.locator(tid('rl-claude-terminal-status'))).toHaveAttribute('data-state', 'running');
  await expect(ui.locator(tid('rl-claude-terminal-screen'))).toContainText('ready é ✓', { timeout: 10_000 });
  await ui.locator(tid('rl-claude-terminal-screen')).click();
  await page.keyboard.type('again');
  await page.keyboard.press('Enter');
  await expect(ui.locator(tid('rl-claude-terminal-screen'))).toContainText('got:again');
  await expect(ui.locator(tid('rl-claude-terminal-status'))).toHaveAttribute('data-state', 'exited');

  // "+" offers the recent folder; clicking it starts a second session.
  await ui.locator(tid('rl-claude-terminal-new')).click();
  const recent = ui.locator(tid('rl-claude-terminal-recent'));
  await expect(recent).toHaveCount(1);
  await expect(recent).toHaveAttribute('data-dir', workDir);
  await recent.click();
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(2);
  await expect(ui.locator(tid('rl-claude-terminal-status'))).toHaveAttribute('data-state', 'running', { timeout: 15_000 });

  // × closes (kills) a session; hiding the pane keeps the others.
  await ui.locator(tid('rl-claude-terminal-tab')).nth(1).locator(tid('rl-claude-terminal-close')).click();
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(1);
  await toggle.click();
  await expect(ui.locator(tid('rl-claude-terminal'))).toBeHidden();
  await toggle.click();
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(1);

  // The pane height is resizable (keyboard on the divider) and persisted.
  const before = Number((await rl.storedSettings() as { layout?: { terminalHeight?: number } }).layout?.terminalHeight ?? 300);
  const divider = ui.locator(`${tid('rl-claude-terminal-split')} > .rl-split__divider`);
  await divider.focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await rl.storedSettings() as { layout?: { terminalHeight?: number } }).layout?.terminalHeight).toBe(before + 64);
});

test('Claude terminal: browse folders (chooser, badges, hidden, filter, keyboard, projects) and start there', async ({
  rl,
  page,
  home,
  profileDir,
  userHome,
  extensionId,
}) => {
  test.setTimeout(120_000);
  // <HOME>/code: alpha (git), beta (package.json), gamma/inner, .secret (hidden).
  const code = path.join(userHome, 'code');
  for (const dir of ['alpha/.git', 'beta', 'gamma/inner', '.secret']) mkdirSync(path.join(code, dir), { recursive: true });
  writeFileSync(path.join(code, 'beta', 'package.json'), '{}');
  writeFileSync(path.join(code, 'README.md'), 'files are never listed');
  execFileSync(process.execPath, [CLI, 'install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], {
    encoding: 'utf8',
    env: { ...process.env, REQLENS_HOME: home },
  });
  await rl.gotoApp();
  await rl.openOverlay();
  const ui = rl.ui;
  await enableBridge(rl);
  await ui.locator(tid('rl-claude-terminal-toggle')).click();

  // The browser opens in the home folder (no recent folder yet).
  const list = ui.locator(tid('rl-claude-fp-list'));
  await expect(list).toHaveAttribute('data-path', userHome, { timeout: 15_000 });
  await expect(list.locator(`${tid('rl-claude-fp-entry')}[data-name="code"]`)).toBeVisible();
  await expect(ui.locator(tid('rl-claude-fp-target'))).toHaveText('~');

  // "Choose folder…" (native dialog stubbed by the hub) jumps to <HOME>/code.
  await ui.locator(tid('rl-claude-fp-pick')).click();
  await expect(list).toHaveAttribute('data-path', code);
  const entries = list.locator(tid('rl-claude-fp-entry'));
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toHaveAttribute('data-name', 'alpha');
  await expect(entries.nth(0)).toHaveAttribute('data-git', 'true');
  await expect(entries.nth(0).locator(tid('rl-claude-fp-badge-git'))).toHaveText('git');
  await expect(entries.nth(1)).toHaveAttribute('data-name', 'beta');
  await expect(entries.nth(1).locator(tid('rl-claude-fp-badge-project'))).toHaveText('project');
  await expect(entries.nth(2)).toHaveAttribute('data-name', 'gamma');
  await expect(list).not.toContainText('README.md');
  const crumbs = ui.locator(tid('rl-claude-fp-crumb'));
  await expect(crumbs.last()).toHaveText('code');

  // Hidden folders on demand.
  const hidden = ui.locator(tid('rl-claude-fp-hidden'));
  await hidden.click();
  await expect(hidden).toHaveAttribute('aria-pressed', 'true');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(3)).toHaveAttribute('data-name', '.secret');
  await hidden.click();
  await expect(entries).toHaveCount(3);

  // Double-click enters a folder; Up comes back with it highlighted.
  await entries.nth(2).dblclick();
  await expect(list).toHaveAttribute('data-path', path.join(code, 'gamma'));
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toHaveAttribute('data-name', 'inner');
  await ui.locator(tid('rl-claude-fp-up')).click();
  await expect(list).toHaveAttribute('data-path', code);
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute('data-name', 'gamma');
  await expect(ui.locator(tid('rl-claude-fp-target'))).toHaveText('~/code/gamma');

  // Breadcrumbs and Home.
  await expect(crumbs).toHaveCount(2);
  await expect(crumbs.first()).toHaveText('~');
  await expect(crumbs.first()).toHaveAttribute('data-path', userHome);
  await crumbs.first().click();
  await expect(list).toHaveAttribute('data-path', userHome);
  await ui.locator(tid('rl-claude-fp-home')).click();
  await expect(list).toHaveAttribute('data-path', userHome);
  await list.locator(`${tid('rl-claude-fp-entry')}[data-name="code"]`).dblclick();
  await expect(list).toHaveAttribute('data-path', code);

  // Keyboard: type to filter, arrows, → opens, ← goes up.
  await list.focus();
  await page.keyboard.type('gam');
  await expect(ui.locator(tid('rl-claude-fp-filter'))).toHaveValue('gam');
  await expect(entries).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(list).toHaveAttribute('data-path', path.join(code, 'gamma'));
  await page.keyboard.press('ArrowLeft');
  await expect(list).toHaveAttribute('data-path', code);
  await expect(ui.locator(tid('rl-claude-fp-filter'))).toHaveValue('');
  await page.keyboard.press('Home');
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute('data-name', 'alpha');
  await page.keyboard.press('ArrowDown');
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute('data-name', 'beta');

  // Detected projects (git repositories under ~/code).
  await ui.locator(tid('rl-claude-fp-projects-scan')).click();
  const project = ui.locator(tid('rl-claude-fp-project'));
  await expect(project).toHaveCount(1, { timeout: 15_000 });
  await expect(project).toHaveAttribute('data-dir', path.join(code, 'alpha'));

  // Enter starts Claude in the highlighted folder.
  await list.focus();
  await page.keyboard.type('alp');
  await expect(list.locator('[aria-selected="true"]')).toHaveAttribute('data-name', 'alpha');
  await expect(ui.locator(tid('rl-claude-fp-target'))).toHaveText('~/code/alpha');
  await page.keyboard.press('Enter');
  const status = ui.locator(tid('rl-claude-terminal-status'));
  await expect(status).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  await expect(ui.locator(tid('rl-claude-terminal-screen'))).toContainText(`ready é ✓ [${path.join(code, 'alpha')}]`, { timeout: 15_000 });
  await expect.poll(async () => (await rl.storedSettings()).claudeRecentDirs).toEqual([path.join(code, 'alpha')]);

  // A new session's browser opens where this panel last browsed; "Start Claude here" uses the click-highlighted folder.
  await ui.locator(tid('rl-claude-terminal-new')).click();
  await expect(list).toHaveAttribute('data-path', code);
  await expect(ui.locator(tid('rl-claude-terminal-recent'))).toHaveAttribute('data-dir', path.join(code, 'alpha'));
  await list.locator(`${tid('rl-claude-fp-entry')}[data-name="beta"]`).click();
  await expect(ui.locator(tid('rl-claude-fp-target'))).toHaveAttribute('data-path', path.join(code, 'beta'));
  await ui.locator(tid('rl-claude-terminal-start')).click();
  await expect(ui.locator(tid('rl-claude-terminal-tab'))).toHaveCount(2);
  await expect(ui.locator(tid('rl-claude-terminal-screen'))).toContainText(`[${path.join(code, 'beta')}]`, { timeout: 15_000 });
});
