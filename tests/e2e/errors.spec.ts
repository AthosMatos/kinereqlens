/**
 * The Errors view end to end (docs/CLAUDE_INTEGRATION.md "Errors view"): a component app (tests/e2e/errors-app —
 * Preact aliased as react, bundled here with esbuild and a linked source map) whose OrdersPanel fetches an endpoint
 * that answers 500; the real hub installed into the temp profile; test-only stand-ins instead of the real CLIs:
 * REQLENS_CLAUDE_COMMAND (a sh script emitting canned stream-json, editing a file in fix runs), REQLENS_GH_COMMAND
 * (a sh script answering auth / extension list / image / issue create, logging every call) and REQLENS_PTY_COMMAND
 * (the terminal). The project folder is a temp git repository with a local bare repository as origin. Everything
 * lives in temp dirs (profile, REQLENS_HOME, HOME): nothing touches a real browser profile, ~/.reqlens or ~/.claude.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { BROWSER_CHANNEL, EXTENSION_DIR, SCREENSHOT_DIR, VIEWPORT, expect, test as base, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CLI = path.join(ROOT, 'mcp/dist/reqlens-mcp.mjs');
const APP_DIR = path.join(HERE, 'errors-app');

const ANALYSIS = {
  title: 'Orders handler throws on a missing id',
  summary: 'GET /api/orders/{id} answers 500 because the handler reads the id from the body.',
  rootCause: 'src/api.js reads body.id, which is undefined for GET requests.',
  files: [{ path: 'src/api.js', line: 2, why: 'reads body.id' }],
  fixPlan: 'Read the id from the path parameters.',
  kind: 'backend',
};
const RESULT = `The handler is broken.\n\`\`\`json\n${JSON.stringify(ANALYSIS)}\n\`\`\``;

/** sh stand-in for `claude`: records its args / cwd / prompt, prints canned stream-json; fix runs edit src/api.js. */
function claudeStandIn(dir: string): string {
  const q = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, `'\\''`)}'`;
  const lines = [
    '#!/bin/sh',
    `D=${JSON.stringify(dir)}`,
    'printf "%s\\n" "$@" > "$D/args.txt"',
    'pwd > "$D/cwd.txt"',
    'cat > "$D/prompt.txt"',
    `printf '%s\\n' ${q({ type: 'system', subtype: 'init', model: 'claude-stand-in', session_id: 's1' })}`,
    `printf '%s\\n' ${q({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the orders handler.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/api.js' } }] } })}`,
    'case " $* " in *acceptEdits*) printf "export const fixed = true;\\n" >> src/api.js ;; esac',
    `printf '%s\\n' ${q({ type: 'result', subtype: 'success', is_error: false, result: RESULT, total_cost_usd: 0.0421, duration_ms: 2300, num_turns: 4 })}`,
  ];
  const file = path.join(dir, 'claude.sh');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
  return file;
}

/** sh stand-in for `gh`: logs every call; `image` mode from a file (ok | sso). */
function ghStandIn(dir: string): string {
  const lines = [
    '#!/bin/sh',
    `D=${JSON.stringify(dir)}`,
    'printf "%s\\n" "$*" >> "$D/gh.log"',
    'mode=$(cat "$D/gh-mode" 2>/dev/null)',
    'case "$1 $2" in',
    '  "auth status") exit 0;;',
    '  "extension list") printf "gh image\\tdrogers0/gh-image\\tv1.2.0\\n"; exit 0;;',
    '  "issue create") cat > "$D/issue-body.txt"; echo "https://github.com/acme/shop/issues/7"; exit 0;;',
    '  "pr create") cat > "$D/pr-body.txt"; echo "https://github.com/acme/shop/pull/8"; exit 0;;',
    'esac',
    'if [ "$1" = image ]; then',
    '  if [ "$mode" = sso ]; then echo "acme enforces SAML SSO and your session is not authorized: https://github.com/orgs/acme/sso" >&2; exit 1; fi',
    '  echo "![shot.png](https://github.com/user-attachments/assets/0f0e0d0c-1111-4222-8333-444455556666)"; exit 0',
    'fi',
    'echo "unknown $*" >&2; exit 1',
  ];
  const file = path.join(dir, 'gh.sh');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
  return file;
}

/** Stands in for the interactive `claude` of the terminal: prompts and waits (input is echoed by the tty). */
const FAKE_TERMINAL_CLAUDE = `printf 'claude ready\\n> '; read line; echo "got:$line"; sleep 30`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Errors fixture</title>
<style>body { margin: 0; font: 14px system-ui; } .page { padding: 24px; } .orders { box-sizing: border-box; width: 320px; height: 140px; padding: 12px; border: 1px solid #c33; background: #fff4f4; } .orders h2 { margin: 0 0 8px; font-size: 16px; }
.pulse { position: fixed; right: 8px; bottom: 8px; width: 6px; height: 6px; border-radius: 50%; background: #c33; animation: pulse 1s linear infinite alternate; }
@keyframes pulse { from { opacity: 0.2; } to { opacity: 1; } }</style>
</head><body><div id="root"></div><div class="pulse"></div><script src="/errors-app/app.js"></script></body></html>`;

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
  const result = await build({
    entryPoints: [path.join(APP_DIR, 'main.jsx')],
    bundle: true,
    write: false,
    outdir: path.join(APP_DIR, 'dist'),
    entryNames: 'app',
    format: 'iife',
    sourcemap: 'linked',
    jsx: 'automatic',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' },
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
  });
  const files = new Map<string, { type: string; body: Buffer }>();
  for (const file of result.outputFiles) {
    const name = path.basename(file.path);
    files.set(`/errors-app/${name}`, { type: name.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8', body: Buffer.from(file.contents) });
  }
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = files.get(url.pathname);
    if (url.pathname === '/shop') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
    } else if (file) {
      res.writeHead(200, { 'content-type': file.type, 'content-length': String(file.body.length), 'cache-control': 'no-store' });
      res.end(file.body);
    } else if (url.pathname.startsWith('/api/orders/')) {
      json(res, 500, { error: 'Cannot read properties of undefined (reading id)', trace: 'at order (src/api.js:2)' });
    } else {
      json(res, 404, { error: 'not found' });
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface ErrorsFixtures {
  profileDir: string;
  home: string;
  stubs: string;
  userHome: string;
  repo: string;
}

const test = base.extend<ErrorsFixtures>({
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
  stubs: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-stubs-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  // eslint-disable-next-line no-empty-pattern
  userHome: async ({}, use) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-home-')));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  /** <tmp>/work/shop: one commit, origin = <tmp>/work/origin.git. */
  // eslint-disable-next-line no-empty-pattern
  repo: async ({}, use) => {
    const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rl-work-')));
    const repo = path.join(work, 'shop');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(work, 'init', '-q', '--bare', path.join(work, 'origin.git'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'src/api.js'), 'export function order(body) {\n  return body.id;\n}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', path.join(work, 'origin.git'));
    await use(repo);
    rmSync(work, { recursive: true, force: true });
  },
  context: async ({ profileDir, userHome, stubs }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: BROWSER_CHANNEL,
      headless: true,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      // Inherited by the native host the browser spawns (test-only hooks, docs/CLAUDE_INTEGRATION.md "Testing hook").
      env: {
        ...(process.env as Record<string, string>),
        HOME: userHome,
        SHELL: '/bin/sh',
        REQLENS_CLAUDE_COMMAND: claudeStandIn(stubs),
        REQLENS_GH_COMMAND: ghStandIn(stubs),
        REQLENS_PTY_COMMAND: FAKE_TERMINAL_CLAUDE,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

let fixture: FixtureServer;

test.beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('mcp/dist/reqlens-mcp.mjs is missing: run `npm run build:mcp` (or `npm run test:e2e`) first');
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture?.close();
});

test.skip(process.platform === 'win32', 'POSIX shell scripts stand in for claude and gh');

function install(home: string, profileDir: string, extensionId: string): void {
  execFileSync(process.execPath, [CLI, 'install', '--extension-id', extensionId, '--home', home, '--manifest-dir', path.join(profileDir, 'NativeMessagingHosts')], {
    encoding: 'utf8',
    env: { ...process.env, REQLENS_HOME: home },
  });
}

async function openSettings(rl: kineReqLens): Promise<void> {
  if (!(await rl.ui.locator(tid('rl-claude-enable')).isVisible().catch(() => false))) await rl.ui.locator(tid('rl-settings')).click();
  await expect(rl.ui.locator(tid('rl-claude-enable'))).toBeVisible();
}

async function closeSettings(rl: kineReqLens): Promise<void> {
  await rl.page.keyboard.press('Escape');
  await expect(rl.ui.locator(tid('rl-claude-enable'))).toBeHidden();
}

async function enableBridge(rl: kineReqLens): Promise<void> {
  await openSettings(rl);
  await rl.ui.locator(tid('rl-claude-enable')).check();
  await expect(rl.ui.locator(tid('rl-claude-status'))).toContainText('Connected', { timeout: 15_000 });
  await closeSettings(rl);
}

/** Load the shop with the overlay open from document_start (the failing fetch is captured with its stack). */
async function openShop(rl: kineReqLens): Promise<void> {
  await rl.page.goto(`${fixture.origin}/shop`);
  await rl.openOverlay();
  await rl.page.reload();
  await expect(rl.page.locator('#orders-panel [role="alert"]')).toContainText('HTTP 500');
  await expect(rl.panel).toBeVisible();
}

/**
 * Wait until the automatic error-area captures are done (`shots` kept, none running). Playwright actions that need
 * a rendered frame (click actionability, screenshots) can stall when they start during a captureVisibleTab of the
 * headless browser, so the spec never acts while a capture runs.
 */
async function settled(rl: kineReqLens, shots: number): Promise<void> {
  const item = rl.ui.locator(tid('rl-view-errors'));
  await expect(item).toHaveAttribute('data-shots', String(shots), { timeout: 20_000 });
  await expect(item).toHaveAttribute('data-capturing', '0', { timeout: 20_000 });
}

function group(rl: kineReqLens, fragment: string): Locator {
  return rl.ui.locator(`${tid('rl-errors-group')}[data-key*="${fragment}"]`);
}

async function setProjectFolder(rl: kineReqLens, dir: string): Promise<void> {
  const view = rl.ui.locator(tid('rl-errors-view'));
  await view.locator(tid('rl-errors-folder-change')).click();
  const picker = view.locator(tid('rl-errors-folder-picker'));
  await picker.locator(tid('rl-claude-terminal-cwd')).fill(dir);
  await picker.locator(tid('rl-claude-terminal-start')).click();
  await expect(view.locator(tid('rl-errors-folder'))).toHaveAttribute('data-folder', dir);
  await expect.poll(async () => ((await rl.storedSettings()).projectFolders as Record<string, string>)?.['127.0.0.1']).toBe(dir);
}

test('Errors view (safe mode): grouped failures, screenshots, Claude analysis, terminal pre-fill, copy issue', async ({ rl, page, home, profileDir, extensionId, stubs, repo }) => {
  test.setTimeout(120_000);
  install(home, profileDir, extensionId);
  // Docked right (wide): the page and the view side by side for the docs screenshot.
  await rl.patchSettings({ layout: { dock: 'right', dockSize: 1080 } });
  await openShop(rl);
  const ui = rl.ui;

  // The rail item counts distinct failing endpoints and marks new ones.
  const railErrors = ui.locator(tid('rl-view-errors'));
  await expect(ui.locator(tid('rl-view-errors-count'))).toHaveText('1');
  await expect(ui.locator(tid('rl-errors-new-dot'))).toBeVisible();
  await page.evaluate(() => (window as unknown as { failMissing(): Promise<void> }).failMissing());
  await expect(ui.locator(tid('rl-view-errors-count'))).toHaveText('2');
  await settled(rl, 2);
  await railErrors.click();
  await expect(railErrors).toHaveAttribute('aria-current', 'page');
  await expect(ui.locator(tid('rl-errors-new-dot'))).toHaveCount(0);
  const view = ui.locator(tid('rl-errors-view'));
  await expect(view).toBeVisible();
  const orders = group(rl, '/api/orders/{id}');
  await expect(orders).toHaveAttribute('data-kind', '5xx');
  await expect(orders).toHaveAttribute('data-status', '500');
  await expect(group(rl, '/api/missing/{id}')).toHaveAttribute('data-kind', '4xx');

  // Filter chips.
  const chip = (id: string) => view.locator(`${tid('rl-errors-filter')}[data-filter="${id}"]`);
  await expect(chip('all').locator(tid('rl-errors-filter-count'))).toHaveText('2');
  await chip('4xx').click();
  await expect(view.locator(tid('rl-errors-group'))).toHaveCount(1);
  await expect(group(rl, '/api/missing/')).toBeVisible();
  await chip('network').click();
  await expect(view.locator(tid('rl-errors-group'))).toHaveCount(0);
  await chip('all').click();
  await expect(view.locator(tid('rl-errors-group'))).toHaveCount(2);

  // Detail: calls, the response, the initiator (component + original call site).
  await orders.click();
  const detail = view.locator(tid('rl-errors-detail'));
  await expect(detail).toHaveAttribute('data-key', /\/api\/orders\/\{id\}$/);
  await expect(detail.locator(tid('rl-errors-call'))).toHaveCount(1);
  await expect(detail.locator(tid('rl-errors-response'))).toContainText('Cannot read properties of undefined');
  await expect(detail.locator(tid('rl-errors-initiator-component'))).toHaveText('OrdersPanel', { timeout: 20_000 });
  await expect(detail.locator(tid('rl-errors-initiator-frame'))).toHaveText(/OrdersPanel\.jsx:\d+:\d+/);

  // The error area was captured when the failure was first seen: the component's box (320 × 140) + 16 px padding.
  const shot = detail.locator(tid('rl-errors-shot')).first();
  await expect(shot).toHaveAttribute('data-area', 'component', { timeout: 15_000 });
  await expect(shot).toHaveAttribute('data-component', 'OrdersPanel');
  await expect(shot).toHaveAttribute('data-auto', 'true');
  const width = Number(await shot.getAttribute('data-width'));
  const height = Number(await shot.getAttribute('data-height'));
  expect(Math.abs(width - 352)).toBeLessThanOrEqual(4);
  expect(Math.abs(height - 172)).toBeLessThanOrEqual(4);
  // Open it: the screenshot result view (annotations, copy).
  await shot.click();
  await expect(ui.locator(tid('rl-errors-shot-view'))).toBeVisible();
  await expect(ui.locator(`${tid('rl-errors-shot-view')} canvas`).first()).toBeVisible();
  await ui.locator(tid('rl-errors-shot-close')).click();
  await expect(ui.locator(tid('rl-errors-shot-view'))).toHaveCount(0);

  // Not from a component: the visible page is captured instead. That capture needs the overlay hidden, so it waits
  // while the user works with the panel: the pointer goes back to the page first.
  await page.mouse.move(4, 880);
  await page.evaluate(() => (window as unknown as { failNetwork(): Promise<void> }).failNetwork());
  const network = group(rl, '127.0.0.1:9');
  await expect(network).toHaveAttribute('data-kind', 'network', { timeout: 15_000 });
  await settled(rl, 3);
  await network.click();
  const fallback = view.locator(tid('rl-errors-detail')).locator(tid('rl-errors-shot')).first();
  await expect(fallback).toHaveAttribute('data-area', 'viewport', { timeout: 15_000 });
  expect(Number(await fallback.getAttribute('data-width'))).toBeGreaterThan(1000);

  // Claude needs the bridge and a project folder; full-mode actions are hidden in safe mode.
  await orders.click();
  await expect(detail.locator(tid('rl-errors-claude'))).toHaveAttribute('data-mode', 'safe');
  await expect(detail.locator(tid('rl-errors-claude-unavailable'))).toContainText('bridge is off');
  await expect(detail.locator(tid('rl-errors-analyze'))).toBeDisabled();
  for (const id of ['rl-errors-create-issue', 'rl-errors-try-fix', 'rl-errors-try-fix-pr']) await expect(detail.locator(tid(id))).toHaveCount(0);
  await enableBridge(rl);
  await expect(detail.locator(tid('rl-errors-no-folder'))).toBeVisible();
  await setProjectFolder(rl, repo);

  // Analyze: the stand-in claude runs read-only in the project folder with the screenshot.
  await detail.locator(tid('rl-errors-analyze')).click();
  const run = detail.locator(tid('rl-errors-run')).first();
  await expect(run).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(run.locator(tid('rl-errors-run-tool'))).toContainText('src/api.js');
  await expect(run.locator(tid('rl-errors-run-cost'))).toHaveText('$0.0421');
  const card = run.locator(tid('rl-errors-analysis'));
  await expect(card).toHaveAttribute('data-kind', 'backend');
  await expect(card.locator(tid('rl-errors-analysis-title'))).toHaveText(ANALYSIS.title);
  await expect(card.locator(tid('rl-errors-analysis-files'))).toContainText('src/api.js:2');
  const args = readFileSync(path.join(stubs, 'args.txt'), 'utf8').trim().split('\n');
  expect(args.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan']);
  expect(args.slice(-5)).toEqual(['--allowedTools', 'Read', 'Grep', 'Glob', 'LS']);
  expect(args).toContain('--add-dir');
  expect(realpathSync(readFileSync(path.join(stubs, 'cwd.txt'), 'utf8').trim())).toBe(repo);
  const prompt = readFileSync(path.join(stubs, 'prompt.txt'), 'utf8');
  expect(prompt).toContain('untrusted');
  expect(prompt).toContain('/api/orders/{id}');
  expect(prompt).toContain('`OrdersPanel`');
  expect(prompt).toMatch(/OrdersPanel\.jsx:\d+:\d+/);
  expect(prompt).toContain('## Screenshot');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'errors.png'), caret: 'hide', animations: 'disabled' });
  // The analysis is kept for this endpoint.
  await expect
    .poll(async () => {
      const sw = await rl.sw();
      return sw.evaluate(async () => Object.keys(((await chrome.storage.local.get('reqlens:error-analyses'))['reqlens:error-analyses'] ?? {}) as object));
    })
    .toEqual([expect.stringMatching(/^GET http:\/\/127\.0\.0\.1:\d+\/api\/orders\/\{id\}$/)]);

  // Copy issue: markdown title + body.
  const copies = await rl.captureCopies();
  await detail.locator(tid('rl-errors-copy-issue')).click();
  await expect.poll(async () => (await copies())[0] ?? '').toContain(`# ${ANALYSIS.title}`);
  expect((await copies())[0]).toContain('## Root cause');

  // Open in terminal: Claude starts in the project folder with the fix prompt typed in — not submitted.
  await detail.locator(tid('rl-errors-terminal-fix')).click();
  await expect(ui.locator(tid('rl-claude-terminal'))).toBeVisible();
  const status = ui.locator(tid('rl-claude-terminal-status'));
  await expect(status).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  const screen = ui.locator(tid('rl-claude-terminal-screen'));
  await expect(screen).toContainText('claude ready');
  await expect(screen).toContainText('Fix the failing request GET', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await expect(screen).not.toContainText('got:');
  await expect(status).toHaveAttribute('data-state', 'running');
});

test('Errors view (full mode): warning, issue with gh image upload, fix in a worktree, discard', async ({ rl, page, home, profileDir, extensionId, stubs, repo }) => {
  test.setTimeout(150_000);
  install(home, profileDir, extensionId);
  await rl.patchSettings({ projectFolders: { '127.0.0.1': repo } });
  await openShop(rl);
  const ui = rl.ui;
  await settled(rl, 1);
  await enableBridge(rl);
  await ui.locator(tid('rl-view-errors')).click();
  const view = ui.locator(tid('rl-errors-view'));
  const detail = view.locator(tid('rl-errors-detail'));
  await expect(detail.locator(tid('rl-errors-claude'))).toHaveAttribute('data-mode', 'safe');
  await expect(detail.locator(tid('rl-errors-create-issue'))).toHaveCount(0);

  // Full mode needs the warning dialog: Cancel keeps it off, Enable turns it on.
  await openSettings(rl);
  const full = ui.locator(tid('rl-errors-full-mode'));
  await full.click();
  const warning = ui.locator(tid('rl-errors-full-dialog'));
  await expect(warning).toContainText('git worktree');
  await expect(warning).toContainText('git push');
  await ui.locator(tid('rl-errors-full-cancel')).click();
  await expect(full).not.toBeChecked();
  expect((await rl.storedSettings()).errorsFullMode ?? false).toBe(false);
  await full.click();
  await ui.locator(tid('rl-errors-full-confirm')).click();
  await expect(full).toBeChecked();
  await expect.poll(async () => (await rl.storedSettings()).errorsFullMode).toBe(true);
  await closeSettings(rl);
  await expect(detail.locator(tid('rl-errors-claude'))).toHaveAttribute('data-mode', 'full');
  await expect(detail.locator(tid('rl-errors-shot')).first()).toHaveAttribute('data-area', 'component', { timeout: 15_000 });

  // Create issue: editable preview, the exact commands, and nothing uploaded before the confirm click.
  await detail.locator(tid('rl-errors-create-issue')).click();
  const dialog = ui.locator(tid('rl-errors-dialog'));
  await expect(dialog).toHaveAttribute('data-kind', 'issue');
  const upload = dialog.locator(tid('rl-errors-dialog-upload'));
  await expect(upload).toBeEnabled({ timeout: 15_000 });
  await expect(dialog.locator(tid('rl-errors-dialog-upload-toggle'))).toBeChecked();
  const commands = dialog.locator(tid('rl-errors-dialog-commands'));
  await expect(commands).toContainText(`cd ${repo}`);
  await expect(commands).toContainText("gh image '<screenshot.png>'");
  await expect(commands).toContainText('gh issue create --title');
  await dialog.locator(tid('rl-errors-dialog-title')).fill('Orders endpoint answers 500');
  const ghLog = () => (existsSync(path.join(stubs, 'gh.log')) ? readFileSync(path.join(stubs, 'gh.log'), 'utf8') : '');
  expect(ghLog()).not.toMatch(/^image /m);
  expect(ghLog()).not.toContain('issue create');

  // SSO failure: a friendly message, then "Create without image" is offered.
  writeFileSync(path.join(stubs, 'gh-mode'), 'sso');
  await upload.click();
  await expect(dialog.locator(tid('rl-errors-dialog-upload-error'))).toContainText('https://github.com/orgs/acme/sso');
  expect(ghLog()).not.toContain('issue create');
  await expect(dialog.locator(tid('rl-errors-dialog-without-image'))).toBeVisible();

  // Retry (authorized now): uploaded, embedded in the body, previewed; then the issue is created on a second click.
  writeFileSync(path.join(stubs, 'gh-mode'), 'ok');
  await dialog.locator(tid('rl-errors-dialog-upload')).click();
  await expect(dialog.locator(tid('rl-errors-dialog-image'))).toHaveAttribute('data-uploaded', 'true');
  const embed = '<img width="260" alt="error screenshot" src="https://github.com/user-attachments/assets/0f0e0d0c-1111-4222-8333-444455556666" />';
  await expect(dialog.locator(tid('rl-errors-dialog-body'))).toHaveValue(new RegExp(`## Screenshot\\n\\n${embed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  expect(ghLog()).toMatch(/^image \S+upload-[0-9a-f]+\.png$/m);
  expect(ghLog()).not.toContain('issue create');
  await expect(commands).not.toContainText('gh image');
  await dialog.locator(tid('rl-errors-dialog-confirm')).click();
  await expect(dialog.locator(tid('rl-errors-dialog-result'))).toHaveAttribute('data-url', 'https://github.com/acme/shop/issues/7');
  expect(ghLog()).toContain('issue create --title Orders endpoint answers 500 --body-file -');
  expect(readFileSync(path.join(stubs, 'issue-body.txt'), 'utf8')).toContain(embed);
  await dialog.locator(tid('rl-errors-dialog-cancel')).click();
  await expect(dialog).toHaveCount(0);

  // Try fix: a new worktree next to the repo, Claude edits there, the diff shows; the checkout stays clean.
  await detail.locator(tid('rl-errors-try-fix')).click();
  const run = detail.locator(`${tid('rl-errors-run')}[data-kind="fix"]`).first();
  await expect(run).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const fix = run.locator(tid('rl-errors-fix'));
  await expect(fix).toHaveAttribute('data-branch', /^kinereqlens\/fix-[a-z0-9-]+-[0-9a-f]{6}$/);
  const worktree = (await fix.getAttribute('data-worktree'))!;
  expect(path.dirname(worktree)).toBe(path.join(path.dirname(repo), '.kinereqlens-worktrees'));
  const args = readFileSync(path.join(stubs, 'args.txt'), 'utf8').trim().split('\n');
  expect(args).toContain('acceptEdits');
  expect(args).toContain('Bash(npm test:*)');
  expect(realpathSync(readFileSync(path.join(stubs, 'cwd.txt'), 'utf8').trim())).toBe(worktree);
  const diff = fix.locator(tid('rl-errors-diff'));
  await expect(diff).toBeVisible({ timeout: 15_000 });
  await expect(diff.locator(tid('rl-errors-diff-file'))).toHaveAttribute('data-path', 'src/api.js');
  await expect(diff).toContainText('export const fixed = true;');
  await expect(fix.locator(tid('rl-errors-vscode'))).toHaveAttribute('href', `vscode://file${encodeURI(worktree)}`);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(readFileSync(path.join(worktree, 'src/api.js'), 'utf8')).toContain('fixed = true');

  // Discard: confirm dialog with the exact commands; the worktree and its branch are gone.
  const branch = (await fix.getAttribute('data-branch'))!;
  await fix.locator(tid('rl-errors-discard')).click();
  await expect(dialog).toHaveAttribute('data-kind', 'discard');
  await expect(dialog.locator(tid('rl-errors-dialog-commands'))).toContainText(`git worktree remove --force ${worktree}`);
  await expect(dialog.locator(tid('rl-errors-dialog-commands'))).toContainText(`git branch -D ${branch}`);
  expect(existsSync(worktree)).toBe(true);
  await dialog.locator(tid('rl-errors-dialog-confirm')).click();
  await expect(fix.locator(tid('rl-errors-discarded'))).toBeVisible();
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, 'branch', '--list', branch).trim()).toBe('');
});

// ------------------------------------------------------------------------------------------------ automatic captures

interface HostChange {
  t: number;
  display: string;
}

/**
 * Record every display change of the overlay host (`<reqlens-overlay>`, hidden by setCaptureHidden for a page
 * capture) from now on, with its time (performance.now() of the page): a MutationObserver in the page's main world.
 */
async function watchHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hostLog: Array<{ t: number; display: string }> };
    w.__hostLog = [];
    const host = document.querySelector('reqlens-overlay') as HTMLElement;
    const record = () => {
      const display = host.style.getPropertyValue('display');
      const last = w.__hostLog[w.__hostLog.length - 1];
      if (!last || last.display !== display) w.__hostLog.push({ t: performance.now(), display });
    };
    record();
    new MutationObserver(record).observe(host, { attributes: true, attributeFilter: ['style'] });
  });
}

/** The recorded windows in which the overlay was hidden: start and length (ms; open ones last until now). */
async function hiddenWindows(page: Page): Promise<Array<{ start: number; ms: number }>> {
  const { log, now } = await page.evaluate(() => ({ log: (window as unknown as { __hostLog: HostChange[] }).__hostLog, now: performance.now() }));
  const out: Array<{ start: number; ms: number }> = [];
  log.forEach((change, i) => {
    if (change.display !== 'none') return;
    const end = log.slice(i + 1).find((c) => c.display !== 'none')?.t ?? now;
    out.push({ start: change.t, ms: end - change.t });
  });
  return out;
}

const showReports = (page: Page) => page.evaluate(() => (window as unknown as { showReports(): void }).showReports());

test('automatic error screenshots: the overlay is never hidden when it does not cover the component', async ({ rl, page }) => {
  // Docked right, 900 px: the page's components (left column) are not under the panel.
  await rl.patchSettings({ layout: { dock: 'right', dockSize: 900 } });
  await openShop(rl);
  await settled(rl, 1);
  const ui = rl.ui;
  await ui.locator(tid('rl-view-errors')).click();
  // The user keeps working with the panel (pointer over it, recent input): no reason to wait, nothing is hidden.
  await page.mouse.move(1000, 450);
  await watchHost(page);
  await showReports(page);
  await expect(page.locator('#reports-panel [role="alert"]')).toContainText('HTTP 404');
  await settled(rl, 2);
  const detail = ui.locator(tid('rl-errors-view')).locator(tid('rl-errors-detail'));
  await group(rl, '/api/reports/{id}').click();
  await expect(detail).toHaveAttribute('data-key', /\/api\/reports\/\{id\}$/);
  const shot = detail.locator(tid('rl-errors-shot')).first();
  await expect(shot).toHaveAttribute('data-area', 'component');
  await expect(shot).toHaveAttribute('data-component', 'ReportsPanel');
  await expect(shot).toHaveAttribute('data-auto', 'true');
  // The component's box (320 × 140) + 16 px padding: the crop leaves the panel out.
  expect(Math.abs(Number(await shot.getAttribute('data-width')) - 352)).toBeLessThanOrEqual(4);
  expect(Math.abs(Number(await shot.getAttribute('data-height')) - 172)).toBeLessThanOrEqual(4);
  await expect(detail.locator(tid('rl-errors-auto-shot'))).toHaveCount(0);
  expect(await hiddenWindows(page)).toEqual([]);
  await expect(rl.host).toHaveCSS('display', 'block');
});

test('automatic error screenshots: wait while the user works with an overlay that covers the component', async ({ rl, page }) => {
  // Docked left, 900 px: the panel covers the page's components, so a capture has to hide it.
  await rl.patchSettings({ layout: { dock: 'left', dockSize: 900 } });
  await openShop(rl);
  await settled(rl, 1);
  const ui = rl.ui;
  await ui.locator(tid('rl-view-errors')).click();
  // The pointer stays over the panel.
  await page.mouse.move(450, 450);
  await watchHost(page);
  await showReports(page);
  const reports = group(rl, '/api/reports/{id}');
  await expect(reports).toBeVisible();
  const detail = ui.locator(tid('rl-errors-view')).locator(tid('rl-errors-detail'));
  // The newest endpoint is shown: its automatic screenshot waits.
  await expect(detail).toHaveAttribute('data-key', /\/api\/reports\/\{id\}$/);
  const note = detail.locator(tid('rl-errors-auto-shot'));
  await expect(note).toHaveAttribute('data-state', 'waiting');
  await expect(note).toHaveAttribute('data-reason', 'pointer');
  await page.waitForTimeout(4_000);
  expect(await hiddenWindows(page)).toEqual([]);
  await expect(ui.locator(tid('rl-view-errors'))).toHaveAttribute('data-shots', '1');
  await expect(note).toHaveAttribute('data-state', 'waiting');

  // The pointer goes back to the page: after a quiet moment the overlay hides briefly and the area is captured.
  await page.mouse.move(1200, 450);
  const leftAt = await page.evaluate(() => performance.now());
  await settled(rl, 2);
  await expect(note).toHaveCount(0);
  const shot = detail.locator(tid('rl-errors-shot')).first();
  await expect(shot).toHaveAttribute('data-component', 'ReportsPanel');
  await expect(shot).toHaveAttribute('data-auto', 'true');
  const hidden = await hiddenWindows(page);
  expect(hidden).toHaveLength(1);
  expect(hidden[0]!.start).toBeGreaterThan(leftAt);
  expect(hidden[0]!.ms).toBeLessThan(2_500);
  await expect(rl.host).toHaveCSS('display', 'block');
});

test('automatic error screenshots: a slow capture is abandoned at the 2.5 s cap and reported as failed', async ({ rl, page }) => {
  await rl.patchSettings({ layout: { dock: 'left', dockSize: 900 } });
  await openShop(rl);
  await settled(rl, 1);
  const ui = rl.ui;
  await ui.locator(tid('rl-view-errors')).click();
  await page.mouse.move(1200, 450);
  // E2E build hook: every captureVisibleTab of the worker now takes 8 s.
  const sw = await rl.sw();
  await sw.evaluate(() => {
    (globalThis as unknown as { __reqlensCaptureDelayMs?: number }).__reqlensCaptureDelayMs = 8_000;
  });
  await watchHost(page);
  await showReports(page);
  const detail = ui.locator(tid('rl-errors-view')).locator(tid('rl-errors-detail'));
  await expect(detail).toHaveAttribute('data-key', /\/api\/reports\/\{id\}$/);
  const note = detail.locator(tid('rl-errors-auto-shot'));
  await expect(note).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  await expect(note).toContainText('within 2.5 s');
  // Hidden once, for about the cap — not for the 8 s the capture takes — and shown again.
  const hidden = await hiddenWindows(page);
  expect(hidden).toHaveLength(1);
  expect(hidden[0]!.ms).toBeGreaterThan(1_500);
  expect(hidden[0]!.ms).toBeLessThan(3_500);
  await expect(rl.host).toHaveCSS('display', 'block');
  // The late picture is dropped.
  await page.waitForTimeout(6_000);
  await expect(ui.locator(tid('rl-view-errors'))).toHaveAttribute('data-shots', '1');
  expect(await hiddenWindows(page)).toHaveLength(1);

  // "Capture error area" takes it now (capture speed back to normal).
  await sw.evaluate(() => {
    (globalThis as unknown as { __reqlensCaptureDelayMs?: number }).__reqlensCaptureDelayMs = 0;
  });
  await detail.locator(tid('rl-errors-capture')).click();
  await settled(rl, 2);
  await expect(note).toHaveCount(0);
  await expect(detail.locator(tid('rl-errors-shot')).first()).toHaveAttribute('data-auto', 'false');
});
