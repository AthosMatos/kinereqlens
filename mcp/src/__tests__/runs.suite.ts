// Errors view runs and git ops, hub side (mcp/src/runs.ts, mcp/src/git.ts): the real hub with a fake extension,
// the test-only stand-ins REQLENS_CLAUDE_COMMAND / REQLENS_GH_COMMAND (POSIX sh scripts written here) and a temp git
// repository with a local bare repository as `origin`. Never runs the real claude or gh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeArgs, opCommandLines, screenshotEmbed } from '../../../src/shared/errors-protocol';
import type { OpFromHost, RunFromHost } from '../../../src/shared/errors-protocol';
import { execTool, firstUrl, isWorktreePathOf, parseWorktreeList, shellInvocation, splitDiff, worktreePlan } from '../git';
import type { Hub } from '../hub';
import { FULL_MODE_OFF_ERROR, claudeInvocation, streamJsonEvents, toolSummary } from '../runs';
import { FakeExtension, removeDir, sleep, startHub, tempDir, waitFor } from './helpers';

const posix = process.platform !== 'win32';
const d = posix ? describe : describe.skip;
const itPosix = posix ? it : it.skip;

/** 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const ANALYSIS = { title: 'Orders handler throws on missing id', summary: 'The handler reads id from the body.', rootCause: 'id is undefined', files: [{ path: 'src/api.js', line: 2, why: 'reads body.id' }], fixPlan: 'Read the id from the path', kind: 'backend' };
const RESULT_TEXT = `Found it.\n\`\`\`json\n${JSON.stringify(ANALYSIS)}\n\`\`\``;

function claudeScript(dir: string): string {
  const lines = [
    '#!/bin/sh',
    `D=${JSON.stringify(dir)}`,
    'printf "%s\\n" "$@" > "$D/args.txt"',
    'pwd > "$D/cwd.txt"',
    'env | grep "^REQLENS_" > "$D/env.txt"',
    'cat > "$D/prompt.txt"',
    'mode=$(cat "$D/claude-mode" 2>/dev/null)',
    `printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-test', session_id: 's1' })}'`,
    'echo "not json: shell noise"',
    `printf '%s\\n' '${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the handler.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/api.js' } }] } })}'`,
    'if [ "$mode" = slow ]; then sleep 30; fi',
    'case " $* " in *acceptEdits*) printf "export const fixed = true;\\n" >> src/api.js; printf "new\\n" > src/new.js ;; esac',
    'if [ "$mode" = fail ]; then echo "boom: no credits" >&2; exit 3; fi',
    `printf '%s\\n' '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: RESULT_TEXT, total_cost_usd: 0.0123, duration_ms: 1500, num_turns: 3 }).replace(/'/g, `'\\''`)}'`,
  ];
  const file = path.join(dir, 'claude-stand-in.sh');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
  return file;
}

function ghScript(dir: string): string {
  const lines = [
    '#!/bin/sh',
    `D=${JSON.stringify(dir)}`,
    'printf "%s\\n" "$*" >> "$D/gh.log"',
    'mode=$(cat "$D/gh-mode" 2>/dev/null)',
    'case "$1 $2" in',
    '  "auth status") [ "$mode" = noauth ] && { echo "You are not logged into any GitHub hosts" >&2; exit 1; }; exit 0;;',
    '  "extension list") [ "$mode" = noext ] && exit 0; printf "gh image\\tdrogers0/gh-image\\tv1.2.0\\n"; exit 0;;',
    '  "issue create") cat > "$D/issue-body.txt"; echo "https://github.com/acme/app/issues/7"; exit 0;;',
    '  "pr create") cat > "$D/pr-body.txt"; echo "https://github.com/acme/app/pull/8"; exit 0;;',
    'esac',
    'if [ "$1" = image ]; then',
    '  if [ "$mode" = sso ]; then echo "acme enforces SAML SSO and your session is not authorized. Visit https://github.com/orgs/acme/sso" >&2; exit 1; fi',
    '  if [ "$mode" = empty ]; then exit 0; fi',
    '  cp "$2" "$D/uploaded.png"; echo "![shot.png](https://github.com/user-attachments/assets/1234abcd-0000-4000-8000-123456789abc)"; exit 0',
    'fi',
    'echo "unknown $*" >&2; exit 1',
  ];
  const file = path.join(dir, 'gh-stand-in.sh');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
  return file;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** parent/app (one commit, origin = parent/origin.git). */
function makeRepo(parent: string): { repo: string; origin: string } {
  const repo = path.join(parent, 'app');
  const origin = path.join(parent, 'origin.git');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(parent, 'init', '-q', '--bare', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'src/api.js'), 'export function order(body) {\n  return body.id;\n}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  return { repo: fs.realpathSync(repo), origin };
}

let root: string;
let stubs: string;
let home: string;
let parent: string;
let env: NodeJS.ProcessEnv;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  root = tempDir('rl-runs-');
  stubs = path.join(root, 'stubs');
  home = path.join(root, 'home');
  parent = path.join(root, 'work');
  fs.mkdirSync(stubs);
  fs.mkdirSync(parent);
  fs.mkdirSync(path.join(root, 'userhome'));
  env = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'userhome'),
    SHELL: '/bin/sh',
    REQLENS_CLAUDE_COMMAND: claudeScript(stubs),
    REQLENS_GH_COMMAND: ghScript(stubs),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeDir(root);
});

async function hub(extra: { maxConcurrent?: number } = {}): Promise<{ hub: Hub; ext: FakeExtension }> {
  const started = await startHub(home, { runs: { env, homedir: env.HOME, ...extra } });
  cleanups.push(() => started.hub.stop());
  started.ext.sendHello();
  await started.ext.nth('hello', 1);
  return started;
}

type RunMsg = RunFromHost | OpFromHost;

function runMessages(ext: FakeExtension, id: string): RunMsg[] {
  return ext.received.filter((m) => (m as { id?: string }).id === id) as RunMsg[];
}

async function runDone(ext: FakeExtension, id: string, timeoutMs = 15_000): Promise<Extract<RunFromHost, { t: 'run-done' }>> {
  return waitFor(() => runMessages(ext, id).find((m): m is Extract<RunFromHost, { t: 'run-done' }> => m.t === 'run-done'), timeoutMs, `run-done of ${id}`);
}

async function opDone(ext: FakeExtension, id: string, timeoutMs = 20_000): Promise<OpFromHost> {
  return waitFor(() => runMessages(ext, id).find((m): m is OpFromHost => m.t === 'op-done'), timeoutMs, `op-done of ${id}`);
}

function events(ext: FakeExtension, id: string) {
  return runMessages(ext, id)
    .filter((m): m is Extract<RunFromHost, { t: 'run-event' }> => m.t === 'run-event')
    .map((m) => m.event);
}

// ------------------------------------------------------------------------------------------------ pure

describe('stream-json parsing', () => {
  it('maps init, assistant text / tool use and result lines to run events', () => {
    expect(streamJsonEvents({ type: 'system', subtype: 'init', model: 'opus', session_id: 'abc' })).toEqual([{ type: 'init', model: 'opus', session: 'abc' }]);
    expect(
      streamJsonEvents({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'order', path: 'src' } }, { type: 'thinking', thinking: 'x' }] },
      }),
    ).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool', name: 'Grep', summary: 'order in src' },
    ]);
    expect(streamJsonEvents({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.5, duration_ms: 10, num_turns: 2 })).toEqual([
      { type: 'result', text: 'done', isError: false, costUsd: 0.5, durationMs: 10, turns: 2 },
    ]);
    expect(streamJsonEvents({ type: 'result', subtype: 'error_max_turns', is_error: false })).toEqual([{ type: 'result', text: '', isError: true }]);
    expect(streamJsonEvents({ type: 'user', message: { content: [] } })).toEqual([]);
    expect(streamJsonEvents('nope')).toEqual([]);
    expect(streamJsonEvents(null)).toEqual([]);
  });

  it('chunks long assistant text and keeps the end of long results', () => {
    const big = 'x'.repeat(150_000);
    const out = streamJsonEvents({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } });
    expect(out.length).toBe(3);
    expect(out.map((e) => (e.type === 'text' ? e.text.length : 0)).reduce((a, b) => a + b)).toBe(150_000);
    const result = streamJsonEvents({ type: 'result', subtype: 'success', result: `${'y'.repeat(300_000)}END` })[0]!;
    expect(result.type === 'result' && result.text.endsWith('END') && result.text.length <= 120_000).toBe(true);
  });

  it('summarizes tool calls on one bounded line', () => {
    expect(toolSummary('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(toolSummary('Bash', { command: 'npm\n test' })).toBe('npm test');
    expect(toolSummary('Read', { file_path: 'z'.repeat(500) }).length).toBeLessThanOrEqual(200);
    expect(toolSummary('X', null)).toBe('');
  });
});

describe('claude / gh command lines', () => {
  it('safe and fix runs get exactly the documented flags', () => {
    expect(claudeArgs('analyze')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--allowedTools', 'Read', 'Grep', 'Glob', 'LS']);
    const fix = claudeArgs('fix', ['/tmp/shots']);
    expect(fix.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    expect(fix.slice(6, 8)).toEqual(['--add-dir', '/tmp/shots']);
    expect(fix.slice(8)).toEqual(['--allowedTools', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'LS', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)']);
  });

  it('runs claude through the login shell with a constant script and the arguments as positional parameters', () => {
    expect(claudeInvocation({ SHELL: '/bin/zsh' }, 'analyze')).toEqual({ file: '/bin/zsh', args: ['-l', '-i', '-c', 'exec claude "$@"', 'claude', ...claudeArgs('analyze')] });
    expect(shellInvocation({ SHELL: '/bin/bash' }, 'gh', ['issue', 'create'])).toEqual({ file: '/bin/bash', args: ['-l', '-i', '-c', 'exec gh "$@"', 'gh', 'issue', 'create'] });
    // Stand-in: "$0" is the executable, never spliced into the script.
    expect(shellInvocation({ SHELL: '/bin/sh' }, 'claude', ['-p'], '/x/stand in.sh')).toEqual({ file: '/bin/sh', args: ['-l', '-i', '-c', 'exec "$0" "$@"', '/x/stand in.sh', '-p'] });
  });

  itPosix('hostile arguments reach the program verbatim and are never run by the shell', async () => {
    const out = path.join(stubs, 'printed.txt');
    const printer = path.join(stubs, 'print.sh');
    fs.writeFileSync(printer, `#!/bin/sh\nfor a in "$@"; do printf '[%s]\\n' "$a"; done > ${JSON.stringify(out)}\n`, { mode: 0o755 });
    const pwned = path.join(stubs, 'pwned');
    const hostile = [`'; touch ${pwned}; '`, `$(touch ${pwned})`, `\`touch ${pwned}\``, `"; touch ${pwned} #`, 'a b\nc', '--allowedTools', '*', '$HOME', ''];
    const call = shellInvocation({ ...env }, 'claude', hostile, printer);
    const result = await execTool(call.file, call.args, { cwd: stubs, env: { ...env, HOME: env.HOME } });
    expect(result.code).toBe(0);
    expect(fs.existsSync(pwned)).toBe(false);
    expect(fs.readFileSync(out, 'utf8')).toBe(hostile.map((a) => `[${a}]\n`).join(''));
  });
});

describe('worktree rules', () => {
  it('plans worktrees next to the repository on kinereqlens/fix-* branches', () => {
    const plan = worktreePlan('/w/my app', 'Orders 500: id!', 'a1b2c3');
    expect(plan).toEqual({ parent: '/w/.kinereqlens-worktrees', dir: '/w/.kinereqlens-worktrees/my-app-orders-500-id-a1b2c3', branch: 'kinereqlens/fix-orders-500-id-a1b2c3' });
    expect(worktreePlan('/w/app', '', 'ff00aa').branch).toBe('kinereqlens/fix-error-ff00aa');
    expect(worktreePlan('/w/app', '../../etc/passwd', '000000').dir).toBe('/w/.kinereqlens-worktrees/app-etc-passwd-000000');
  });

  it('accepts only this feature’s worktree folders of the repository', () => {
    expect(isWorktreePathOf('/w/app', '/w/.kinereqlens-worktrees/app-x-1')).toBe(true);
    expect(isWorktreePathOf('/w/app', '/w/app')).toBe(false);
    expect(isWorktreePathOf('/w/app', '/w/.kinereqlens-worktrees/other-x-1')).toBe(false);
    expect(isWorktreePathOf('/w/app', '/w/.kinereqlens-worktrees/app-x/nested')).toBe(false);
    expect(isWorktreePathOf('/w/app', '/elsewhere/.kinereqlens-worktrees/app-x-1')).toBe(false);
  });

  it('parses git worktree list --porcelain, splits diffs and finds URLs', () => {
    expect(parseWorktreeList('worktree /w/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/.kinereqlens-worktrees/app-x\nHEAD def\nbranch refs/heads/kinereqlens/fix-x\n\nworktree /w/d\nHEAD 1\ndetached\n')).toEqual([
      { path: '/w/app', branch: 'main' },
      { path: '/w/.kinereqlens-worktrees/app-x', branch: 'kinereqlens/fix-x' },
      { path: '/w/d', branch: null },
    ]);
    const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\ndiff --git a/b.js b/b.js\nnew file mode 100644\n--- /dev/null\n+++ b/b.js\n@@ -0,0 +1 @@\n+n\n';
    const split = splitDiff(diff);
    expect(split.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['a.js', 2, 1],
      ['b.js', 1, 0],
    ]);
    expect(splitDiff(diff, 1).truncated).toBe(true);
    expect(splitDiff(diff, 10, 30).files[0]!.truncated).toBe(true);
    expect(firstUrl('Creating issue…\nhttps://github.com/a/b/issues/1\n')).toBe('https://github.com/a/b/issues/1');
    expect(firstUrl('nothing')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ hub

d('hub runs (safe mode)', () => {
  it('runs the stand-in claude read-only, streams events, appends the screenshot and cleans up', async () => {
    const { repo } = makeRepo(parent);
    const { ext, hub: h } = await hub();
    ext.send({ t: 'run-start', id: 'r1', kind: 'analyze', cwd: repo, prompt: '# Analyze\nuntrusted data below', image: PNG });
    const done = await runDone(ext, 'r1');
    expect(done).toMatchObject({ ok: true, code: 0 });
    const evs = events(ext, 'r1');
    expect(evs[0]).toEqual({ type: 'init', model: 'claude-test', session: 's1' });
    expect(evs).toContainEqual({ type: 'text', text: 'Looking at the handler.' });
    expect(evs).toContainEqual({ type: 'tool', name: 'Read', summary: 'src/api.js' });
    const result = evs.find((e) => e.type === 'result');
    expect(result).toMatchObject({ type: 'result', isError: false, costUsd: 0.0123, turns: 3 });
    expect(result && result.type === 'result' && result.text).toContain('"rootCause":"id is undefined"');
    const args = fs.readFileSync(path.join(stubs, 'args.txt'), 'utf8').trim().split('\n');
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--add-dir', h.runs.shotsDir, '--allowedTools', 'Read', 'Grep', 'Glob', 'LS']);
    expect(fs.realpathSync(fs.readFileSync(path.join(stubs, 'cwd.txt'), 'utf8').trim())).toBe(repo);
    const prompt = fs.readFileSync(path.join(stubs, 'prompt.txt'), 'utf8');
    expect(prompt.startsWith('# Analyze\nuntrusted data below')).toBe(true);
    const shot = /saved at `([^`]+\.png)`/.exec(prompt)![1]!;
    expect(path.dirname(shot)).toBe(h.runs.shotsDir);
    // The screenshot only lives during the run.
    expect(fs.existsSync(shot)).toBe(false);
    // Test hooks never reach the child.
    expect(fs.readFileSync(path.join(stubs, 'env.txt'), 'utf8')).toBe('');
    // Safe mode never touches the repository.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('writes the screenshot 0600 in a 0700 folder while the run runs', async () => {
    const { repo } = makeRepo(parent);
    fs.writeFileSync(path.join(stubs, 'claude-mode'), 'slow');
    const { ext, hub: h } = await hub();
    ext.send({ t: 'run-start', id: 'r1', kind: 'analyze', cwd: repo, prompt: 'p', image: PNG });
    await waitFor(() => events(ext, 'r1').some((e) => e.type === 'tool'), 10_000, 'tool event');
    const files = fs.readdirSync(h.runs.shotsDir);
    expect(files.length).toBe(1);
    expect(fs.statSync(h.runs.shotsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(h.runs.shotsDir, files[0]!)).mode & 0o777).toBe(0o600);
    ext.send({ t: 'run-cancel', id: 'r1' });
    expect(await runDone(ext, 'r1')).toMatchObject({ ok: false, cancelled: true });
    expect(fs.readdirSync(h.runs.shotsDir)).toEqual([]);
  });

  it('cancel kills the process group', async () => {
    const { repo } = makeRepo(parent);
    fs.writeFileSync(path.join(stubs, 'claude-mode'), 'slow');
    const { ext } = await hub();
    ext.send({ t: 'run-start', id: 'r1', kind: 'analyze', cwd: repo, prompt: 'p' });
    await waitFor(() => events(ext, 'r1').some((e) => e.type === 'tool'), 10_000, 'tool event');
    const started = Date.now();
    ext.send({ t: 'run-cancel', id: 'r1' });
    expect(await runDone(ext, 'r1', 8000)).toMatchObject({ ok: false, cancelled: true });
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('reports failures with the stderr tail, bad folders and the concurrency cap', async () => {
    const { repo } = makeRepo(parent);
    const { ext } = await hub({ maxConcurrent: 1 });
    fs.writeFileSync(path.join(stubs, 'claude-mode'), 'fail');
    ext.send({ t: 'run-start', id: 'r1', kind: 'analyze', cwd: repo, prompt: 'p' });
    const failed = await runDone(ext, 'r1');
    expect(failed).toMatchObject({ ok: false, code: 3 });
    expect(failed.error).toContain('boom: no credits');
    ext.send({ t: 'run-start', id: 'r2', kind: 'analyze', cwd: path.join(parent, 'missing'), prompt: 'p' });
    expect((await runDone(ext, 'r2')).error).toContain('No such directory');
    fs.writeFileSync(path.join(stubs, 'claude-mode'), 'slow');
    ext.send({ t: 'run-start', id: 'r3', kind: 'analyze', cwd: repo, prompt: 'p' });
    await waitFor(() => events(ext, 'r3').length > 0, 10_000, 'r3 running');
    ext.send({ t: 'run-start', id: 'r4', kind: 'analyze', cwd: repo, prompt: 'p' });
    expect((await runDone(ext, 'r4')).error).toMatch(/At most 1 Claude run/);
    ext.send({ t: 'run-cancel', id: 'r3' });
    await runDone(ext, 'r3');
  });

  it('refuses fix runs, ops and invalid messages while full mode is off', async () => {
    const { repo } = makeRepo(parent);
    const { ext } = await hub();
    ext.send({ t: 'run-start', id: 'f1', kind: 'fix', cwd: repo, prompt: 'p' });
    expect(await runDone(ext, 'f1')).toMatchObject({ ok: false, error: FULL_MODE_OFF_ERROR });
    ext.send({ t: 'op-start', id: 'o1', op: { op: 'issue-create', cwd: repo, title: 't', body: 'b' } });
    expect(await opDone(ext, 'o1')).toEqual({ t: 'op-done', id: 'o1', ok: false, error: FULL_MODE_OFF_ERROR });
    ext.send({ t: 'op-start', id: 'o2', op: { op: 'check', cwd: repo } });
    expect(await opDone(ext, 'o2')).toMatchObject({ ok: false, error: FULL_MODE_OFF_ERROR });
    // An auto run must be an analysis; invalid messages are dropped.
    ext.send({ t: 'run-start', id: 'a1', kind: 'fix', auto: true, cwd: repo, prompt: 'p' });
    ext.send({ t: 'run-start', id: 'bad id!', kind: 'analyze', cwd: repo, prompt: 'p' });
    ext.send({ t: 'run-start', id: 'b2', kind: 'analyze', cwd: repo, prompt: 'p', image: 'not-a-png' });
    await sleep(300);
    expect(runMessages(ext, 'a1')).toEqual([]);
    expect(runMessages(ext, 'b2')).toEqual([]);
    expect(fs.existsSync(path.join(stubs, 'gh.log'))).toBe(false);
    // Turning full mode on and off again: refused again.
    ext.send({ t: 'errors-config', fullMode: true });
    ext.send({ t: 'errors-config', fullMode: false });
    ext.send({ t: 'op-start', id: 'o3', op: { op: 'check', cwd: repo } });
    expect(await opDone(ext, 'o3')).toMatchObject({ ok: false, error: FULL_MODE_OFF_ERROR });
  });
});

d('hub full mode: worktrees, commit, discard, issue, image, pull request', () => {
  async function fullHub(): Promise<FakeExtension> {
    const { ext } = await hub();
    ext.send({ t: 'errors-config', fullMode: true });
    return ext;
  }

  async function fix(ext: FakeExtension, repo: string, id: string): Promise<{ path: string; branch: string }> {
    ext.send({ t: 'run-start', id, kind: 'fix', cwd: repo, prompt: '# Fix', slug: 'Orders 500' });
    expect(await runDone(ext, id)).toMatchObject({ ok: true });
    const tree = events(ext, id).find((e) => e.type === 'worktree');
    if (!tree || tree.type !== 'worktree') throw new Error('no worktree event');
    return { path: tree.path, branch: tree.branch };
  }

  it('creates a worktree, runs claude there with acceptEdits, diffs, commits and discards', async () => {
    const { repo } = makeRepo(parent);
    const ext = await fullHub();
    const tree = await fix(ext, repo, 'f1');
    expect(tree.branch).toMatch(/^kinereqlens\/fix-orders-500-[0-9a-f]{6}$/);
    expect(path.dirname(tree.path)).toBe(path.join(fs.realpathSync(parent), '.kinereqlens-worktrees'));
    expect(path.basename(tree.path)).toMatch(/^app-orders-500-[0-9a-f]{6}$/);
    const args = fs.readFileSync(path.join(stubs, 'args.txt'), 'utf8').trim().split('\n');
    expect(args.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    expect(args).toContain('Bash(git diff:*)');
    expect(fs.realpathSync(fs.readFileSync(path.join(stubs, 'cwd.txt'), 'utf8').trim())).toBe(tree.path);
    // The edit happened in the worktree only.
    expect(fs.readFileSync(path.join(tree.path, 'src/api.js'), 'utf8')).toContain('fixed = true');
    expect(fs.readFileSync(path.join(repo, 'src/api.js'), 'utf8')).not.toContain('fixed');

    ext.send({ t: 'op-start', id: 'd1', op: { op: 'worktree-diff', cwd: repo, worktree: tree.path } });
    const diff = await opDone(ext, 'd1');
    expect(diff.ok).toBe(true);
    const result = (diff as { result: { stat: string; files: Array<{ path: string; additions: number }> } }).result;
    expect(result.files.map((f) => f.path).sort()).toEqual(['src/api.js', 'src/new.js']);
    expect(result.stat).toContain('src/api.js');

    ext.send({ t: 'op-start', id: 'c1', op: { op: 'worktree-commit', cwd: repo, worktree: tree.path, message: 'Fix orders\n\nbody', attach: { name: 'error-screenshot.png', base64: PNG } } });
    const commit = await opDone(ext, 'c1');
    expect(commit).toMatchObject({ ok: true, result: { sha: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(git(tree.path, 'log', '-1', '--format=%B').trim()).toBe('Fix orders\n\nbody');
    expect(git(tree.path, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['.github/kinereqlens/error-screenshot.png', 'src/api.js', 'src/new.js']);
    ext.send({ t: 'op-start', id: 'c2', op: { op: 'worktree-commit', cwd: repo, worktree: tree.path, message: 'again' } });
    expect(await opDone(ext, 'c2')).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to commit') });

    // Wrong branch / foreign folders are refused.
    ext.send({ t: 'op-start', id: 'x1', op: { op: 'worktree-discard', cwd: repo, worktree: tree.path, branch: 'kinereqlens/fix-other' } });
    expect(await opDone(ext, 'x1')).toMatchObject({ ok: false, error: expect.stringContaining('Refused') });
    ext.send({ t: 'op-start', id: 'x2', op: { op: 'worktree-diff', cwd: repo, worktree: repo } });
    expect(await opDone(ext, 'x2')).toMatchObject({ ok: false, error: expect.stringContaining('Refused') });
    const fake = path.join(fs.realpathSync(parent), '.kinereqlens-worktrees', 'app-fake-000000');
    fs.mkdirSync(fake);
    ext.send({ t: 'op-start', id: 'x3', op: { op: 'worktree-discard', cwd: repo, worktree: fake, branch: 'kinereqlens/fix-fake-000000' } });
    expect(await opDone(ext, 'x3')).toMatchObject({ ok: false, error: expect.stringContaining('Refused') });
    expect(fs.existsSync(fake)).toBe(true);
    fs.rmdirSync(fake);

    ext.send({ t: 'op-start', id: 'r1', op: { op: 'worktree-discard', cwd: repo, worktree: tree.path, branch: tree.branch } });
    expect(await opDone(ext, 'r1')).toMatchObject({ ok: true });
    expect(fs.existsSync(tree.path)).toBe(false);
    expect(git(repo, 'branch', '--list', tree.branch).trim()).toBe('');
    expect(fs.existsSync(path.join(fs.realpathSync(parent), '.kinereqlens-worktrees'))).toBe(false);
  });

  it('pushes to origin and opens the pull request with gh (body on stdin) only when asked', async () => {
    const { repo, origin } = makeRepo(parent);
    const ext = await fullHub();
    const tree = await fix(ext, repo, 'f1');
    expect(fs.existsSync(path.join(stubs, 'gh.log'))).toBe(false);
    const body = '## Problem\n\n`POST /orders` → 500\n\n## Screenshot\n\n' + screenshotEmbed('https://github.com/user-attachments/assets/abc');
    ext.send({ t: 'op-start', id: 'p1', op: { op: 'pr-create', cwd: repo, worktree: tree.path, branch: tree.branch, message: 'Fix orders', title: "Fix: orders '500' $(x)", body } });
    const pr = await opDone(ext, 'p1', 30_000);
    expect(pr).toMatchObject({ ok: true, result: { url: 'https://github.com/acme/app/pull/8' } });
    expect(git(origin, 'branch', '--list', tree.branch).trim()).toContain(tree.branch);
    const log = fs.readFileSync(path.join(stubs, 'gh.log'), 'utf8');
    expect(log).toContain(`pr create --title Fix: orders '500' $(x) --body-file - --head ${tree.branch}`);
    expect(fs.readFileSync(path.join(stubs, 'pr-body.txt'), 'utf8')).toBe(body);
    expect(opCommandLines({ op: 'pr-create', cwd: repo, worktree: tree.path, branch: tree.branch, message: 'm', title: 't', body: 'b' }).join('\n')).toContain(`git push -u origin ${tree.branch}`);
  });

  it('creates issues with the body on stdin and checks gh / gh-image', async () => {
    const { repo } = makeRepo(parent);
    git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
    const ext = await fullHub();
    ext.send({ t: 'op-start', id: 'k1', op: { op: 'check', cwd: repo } });
    expect(await opDone(ext, 'k1')).toMatchObject({ ok: true, result: { git: true, repo: true, gh: 'ok', ghImage: true, origin: true, repoSlug: 'acme/app', repoRoot: repo } });
    ext.send({ t: 'op-start', id: 'i1', op: { op: 'issue-create', cwd: repo, title: 'Orders fail; `rm -rf`', body: 'line 1\n$(touch x)\n' } });
    expect(await opDone(ext, 'i1')).toMatchObject({ ok: true, result: { url: 'https://github.com/acme/app/issues/7' } });
    expect(fs.readFileSync(path.join(stubs, 'issue-body.txt'), 'utf8')).toBe('line 1\n$(touch x)\n');
    expect(fs.existsSync(path.join(repo, 'x'))).toBe(false);
    fs.writeFileSync(path.join(stubs, 'gh-mode'), 'noauth');
    ext.send({ t: 'op-start', id: 'k2', op: { op: 'check', cwd: repo } });
    expect(await opDone(ext, 'k2')).toMatchObject({ ok: true, result: { gh: 'unauthenticated', ghImage: false } });
  });

  it('uploads screenshots with gh image (repo from origin) and explains gh-image failures', async () => {
    const { repo } = makeRepo(parent);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    const ext = await fullHub();
    ext.send({ t: 'op-start', id: 'u1', op: { op: 'image-upload', cwd: repo, image: PNG } });
    expect(await opDone(ext, 'u1')).toEqual({ t: 'op-done', id: 'u1', ok: true, result: { url: 'https://github.com/user-attachments/assets/1234abcd-0000-4000-8000-123456789abc' } });
    const log = fs.readFileSync(path.join(stubs, 'gh.log'), 'utf8');
    expect(log).toMatch(/^image \S+upload-[0-9a-f]{16}\.png --repo acme\/app$/m);
    expect(fs.readFileSync(path.join(stubs, 'uploaded.png')).toString('base64')).toBe(PNG);
    // The temp file is gone.
    expect(fs.readdirSync(path.join(home, 'shots'))).toEqual([]);

    fs.writeFileSync(path.join(stubs, 'gh-mode'), 'sso');
    ext.send({ t: 'op-start', id: 'u2', op: { op: 'image-upload', cwd: repo, image: PNG } });
    expect(await opDone(ext, 'u2')).toMatchObject({ ok: false, error: expect.stringContaining('https://github.com/orgs/acme/sso') });
    fs.writeFileSync(path.join(stubs, 'gh-mode'), 'empty');
    ext.send({ t: 'op-start', id: 'u3', op: { op: 'image-upload', cwd: repo, image: PNG } });
    expect(await opDone(ext, 'u3')).toMatchObject({ ok: false, error: expect.stringContaining('gh image failed') });
    fs.writeFileSync(path.join(stubs, 'gh-mode'), 'noext');
    fs.rmSync(path.join(stubs, 'gh.log'));
    ext.send({ t: 'op-start', id: 'u4', op: { op: 'image-upload', cwd: repo, image: PNG } });
    expect(await opDone(ext, 'u4')).toMatchObject({ ok: false, error: expect.stringContaining('gh extension install drogers0/gh-image') });
    // Never installs the extension, never uploads without it.
    expect(fs.readFileSync(path.join(stubs, 'gh.log'), 'utf8')).toBe('extension list\n');
  });

  it('kills runs and cleans the screenshots when the browser disconnects', async () => {
    const { repo } = makeRepo(parent);
    fs.writeFileSync(path.join(stubs, 'claude-mode'), 'slow');
    const { ext, hub: h } = await hub();
    ext.send({ t: 'run-start', id: 'r1', kind: 'analyze', cwd: repo, prompt: 'p', image: PNG });
    await waitFor(() => events(ext, 'r1').some((e) => e.type === 'tool'), 10_000, 'tool event');
    expect(h.runs.size).toBe(1);
    ext.disconnect();
    await h.closed;
    expect(h.runs.size).toBe(0);
    expect(fs.existsSync(h.runs.shotsDir)).toBe(false);
  });
});
