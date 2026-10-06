// Full-mode git / gh operations of the Errors view, hub side (docs/CLAUDE_INTEGRATION.md "Errors view — full mode"):
// fix worktrees (`<repo parent>/.kinereqlens-worktrees/<repo>-<slug>-<short>` on a `kinereqlens/fix-…` branch),
// their diff, commit, discard, push + pull request, issues, and screenshot uploads with the `gh image` extension.
//
// Every command is an argv array (never a shell string with data in it): git runs directly, gh through the user's
// login shell (`$SHELL -l -i -c 'exec gh "$@"' gh <args>`, data as positional parameters) so PATH and gh's auth
// match their terminal. git / gh only ever run inside the mapped project folder (a git work tree) or one of the
// worktrees this feature created for its repository — checked against `git worktree list` every time.
//
// Test-only: REQLENS_GH_COMMAND (an executable) stands in for `gh`; it is removed from every child environment.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACH_DIR,
  BRANCH_PREFIX,
  DIFF_FILE_MAX_CHARS,
  DIFF_MAX_CHARS,
  DIFF_MAX_FILES,
  GH_IMAGE_EXTENSION,
  GH_IMAGE_INSTALL,
  WORKTREES_DIR,
  attachmentUrlOf,
  explainImageUploadError,
  githubRepoSlug,
  imageUploadArgs,
  isFixBranch,
  opSteps,
  slugify,
  type DiffFile,
  type GitOp,
  type OpAttachment,
  type OpResults,
  type ToolCheck,
  type WorktreeDiff,
} from '../../src/shared/errors-protocol';
import { type Logger, silentLogger } from './log';
import { resolveCwd } from './pty';

/** Test hooks of the Errors view (documented in docs/CLAUDE_INTEGRATION.md "Testing hook"), never passed on. */
export const CLAUDE_COMMAND_ENV = 'REQLENS_CLAUDE_COMMAND';
export const GH_COMMAND_ENV = 'REQLENS_GH_COMMAND';
const TEST_HOOK_ENVS = [CLAUDE_COMMAND_ENV, GH_COMMAND_ENV, 'REQLENS_PTY_COMMAND', 'REQLENS_FS_PICK_STUB'];

const GIT_TIMEOUT_MS = 2 * 60_000;
const NETWORK_TIMEOUT_MS = 4 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

export interface ExecResult {
  /** Exit code; null when killed / not started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn error or timeout. */
  error?: string;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

/** The environment of every child: the hub's own, test hooks removed, the usual tool folders on PATH. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of TEST_HOOK_ENVS) delete out[key];
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  const parts = (out.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  out.PATH = parts.join(path.delimiter);
  // Never let git / gh wait for a password on a terminal nobody sees.
  out.GIT_TERMINAL_PROMPT = '0';
  out.GH_PROMPT_DISABLED = '1';
  return out;
}

/** The user's login shell (absolute $SHELL, else zsh / sh). */
export function loginShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL && path.isAbsolute(env.SHELL)) return env.SHELL;
  return fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
}

/**
 * A CLI run through the login shell with its arguments as positional parameters: the script is a constant, so no
 * argument is ever parsed by the shell. `override` (a test stand-in executable) replaces `name`.
 */
export function shellInvocation(env: NodeJS.ProcessEnv, name: 'claude' | 'gh', args: readonly string[], override?: string | null): { file: string; args: string[] } {
  const stand = override?.trim() || null;
  const script = stand ? 'exec "$0" "$@"' : `exec ${name} "$@"`;
  return { file: loginShell(env), args: ['-l', '-i', '-c', script, stand ?? name, ...args] };
}

/** Kill a detached child's whole process group (SIGTERM, then SIGKILL). */
export function killGroup(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  const pid = child.pid;
  const send = (signal: NodeJS.Signals) => {
    try {
      if (pid && process.platform !== 'win32') process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* gone */
      }
    }
  };
  send('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) send('SIGKILL');
  }, graceMs);
  timer.unref?.();
}

/** Run a program (argv), feed `stdin`, collect bounded output; never rejects. */
export function execTool(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: errorText(err) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    timer.unref?.();
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: ExecResult = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (timedOut) result.error = `${path.basename(file)} took too long and was stopped`;
      else if (error) result.error = error;
      resolve(result);
    };
    child.on('error', (e) => finish(null, errorText(e)));
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });
}

// ------------------------------------------------------------------------------------------------ pure rules

/** Where the worktree of a fix goes, and its branch. */
export function worktreePlan(repoRoot: string, slug: string, short: string): { dir: string; branch: string; parent: string } {
  const clean = slugify(slug);
  const repoName = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
  const parent = path.join(path.dirname(repoRoot), WORKTREES_DIR);
  return { parent, dir: path.join(parent, `${repoName}-${clean}-${short}`), branch: `${BRANCH_PREFIX}${clean}-${short}` };
}

/** Is `candidate` (a real path) a worktree folder this feature makes for `repoRoot`? */
export function isWorktreePathOf(repoRoot: string, candidate: string): boolean {
  const parent = path.join(path.dirname(repoRoot), WORKTREES_DIR);
  const repoName = path.basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
  const name = path.basename(candidate);
  return path.dirname(candidate) === parent && name.startsWith(`${repoName}-`) && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

/** `git worktree list --porcelain` → [{path, branch}] (branch without refs/heads/, null when detached). */
export function parseWorktreeList(output: string): Array<{ path: string; branch: string | null }> {
  const out: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      out.push(current);
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  return out;
}

/** Split a unified diff per file, with +/- counts, within the budgets. */
export function splitDiff(diff: string, maxFiles = DIFF_MAX_FILES, maxChars = DIFF_MAX_CHARS, maxFileChars = DIFF_FILE_MAX_CHARS): { files: DiffFile[]; truncated: boolean } {
  const files: DiffFile[] = [];
  let truncated = false;
  let used = 0;
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const header = /^diff --git a\/(.*?) b\/(.*)$/m.exec(part);
    const plus = /^\+\+\+ b\/(.*)$/m.exec(part);
    const filePath = (plus?.[1] ?? header?.[2] ?? 'unknown').trim();
    let additions = 0;
    let deletions = 0;
    for (const line of part.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    const room = Math.max(0, Math.min(maxFileChars, maxChars - used));
    const file: DiffFile = { path: filePath.slice(0, 1024), additions, deletions, diff: part.slice(0, room) };
    if (part.length > room) {
      file.truncated = true;
      truncated = true;
    }
    used += file.diff.length;
    files.push(file);
  }
  return { files, truncated };
}

/** The first http(s) URL printed by gh (issue / PR create print it on stdout). */
export function firstUrl(output: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/.exec(output);
  return m ? m[0] : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLines(text: string, n = 3): string {
  return text
    .trim()
    .split('\n')
    .slice(0, n)
    .join(' ')
    .slice(0, 600);
}

// ------------------------------------------------------------------------------------------------ service

export interface GitServiceOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  /** Where screenshots for `gh image` are written (0700; files 0600, removed after the upload). */
  shotsDir: string;
  logger?: Logger;
  exec?: typeof execTool;
}

export class OpError extends Error {}

/** git / gh for one hub. */
export class GitService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly exec: typeof execTool;
  private readonly homedir: string;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: GitServiceOptions) {
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? silentLogger;
    this.exec = options.exec ?? execTool;
    this.homedir = options.homedir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
  }

  /** Environment for children. */
  get childEnv(): NodeJS.ProcessEnv {
    return childEnv(this.env);
  }

  git(cwd: string, args: readonly string[], stdin?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
    return this.exec('git', args, { cwd, env: this.childEnv, stdin, timeoutMs });
  }

  gh(cwd: string, args: readonly string[], stdin?: string, timeoutMs = NETWORK_TIMEOUT_MS): Promise<ExecResult> {
    const call = shellInvocation(this.env, 'gh', args, this.env[GH_COMMAND_ENV]);
    return this.exec(call.file, call.args, { cwd, env: this.childEnv, stdin, timeoutMs });
  }

  /** Resolve the project folder: an existing absolute directory. */
  resolveFolder(input: string): string {
    const resolved = resolveCwd(input, this.homedir, this.platform);
    if (!resolved.ok) throw new OpError(resolved.error);
    return fs.realpathSync(resolved.cwd);
  }

  /** The repository root of a project folder (a git work tree), real path. */
  async repoRoot(folder: string): Promise<string> {
    const top = await this.git(folder, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || !top.stdout.trim()) {
      if (top.error && /ENOENT/.test(top.error)) throw new OpError('git is not installed (or not on PATH)');
      throw new OpError(`${folder} is not inside a git repository`);
    }
    return fs.realpathSync(top.stdout.trim());
  }

  /** git present? repo? origin? gh installed and authenticated? gh-image extension? */
  async check(cwd: string): Promise<ToolCheck> {
    const folder = this.resolveFolder(cwd);
    const version = await this.git(folder, ['--version']);
    const out: ToolCheck = { git: version.code === 0, repo: false, gh: 'error' };
    if (out.git) {
      try {
        out.repoRoot = await this.repoRoot(folder);
        out.repo = true;
        const origin = await this.git(folder, ['remote', 'get-url', 'origin']);
        out.origin = origin.code === 0 && origin.stdout.trim().length > 0;
        const slug = out.origin ? githubRepoSlug(origin.stdout.trim()) : null;
        if (slug) out.repoSlug = slug;
      } catch {
        out.repo = false;
      }
    }
    const auth = await this.gh(folder, ['auth', 'status'], undefined, GIT_TIMEOUT_MS);
    if (auth.code === 0) out.gh = 'ok';
    else if (auth.code === 127 || /command not found|not found: gh/i.test(auth.stderr)) out.gh = 'missing';
    else if (auth.code !== null) {
      out.gh = 'unauthenticated';
      out.ghDetail = firstLines(auth.stderr || auth.stdout) || 'Run `gh auth login`';
    } else out.ghDetail = auth.error ?? 'gh could not be started';
    if (out.gh === 'ok') {
      const ext = await this.gh(folder, ['extension', 'list'], undefined, GIT_TIMEOUT_MS);
      out.ghImage = ext.code === 0 && ext.stdout.includes(GH_IMAGE_EXTENSION);
    } else out.ghImage = false;
    return out;
  }

  /** Create the fix worktree (new branch at HEAD). */
  async createWorktree(cwd: string, slug: string): Promise<{ repoRoot: string; worktree: string; branch: string; runDir: string }> {
    const folder = this.resolveFolder(cwd);
    const repoRoot = await this.repoRoot(folder);
    const head = await this.git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) throw new OpError('The repository has no commit yet (HEAD) — commit something first');
    const plan = worktreePlan(repoRoot, slug, randomBytes(3).toString('hex'));
    fs.mkdirSync(plan.parent, { recursive: true });
    const add = await this.git(repoRoot, ['worktree', 'add', '-b', plan.branch, plan.dir, 'HEAD']);
    if (add.code !== 0) throw new OpError(`git worktree add failed: ${firstLines(add.stderr || add.error || '')}`);
    const worktree = fs.realpathSync(plan.dir);
    // A project folder below the repository root: run in the same sub-folder of the worktree.
    const sub = path.relative(repoRoot, folder);
    const runDir = sub && !sub.startsWith('..') && fs.existsSync(path.join(worktree, sub)) ? path.join(worktree, sub) : worktree;
    this.logger.info(`worktree created on ${plan.branch}`);
    return { repoRoot, worktree, branch: plan.branch, runDir };
  }

  /** Check that `worktree` is one of this feature's worktrees of the project's repository (and its branch). */
  async validateWorktree(cwd: string, worktreeInput: string, branch?: string): Promise<{ repoRoot: string; worktree: string; branch: string }> {
    const repoRoot = await this.repoRoot(this.resolveFolder(cwd));
    let worktree: string;
    try {
      worktree = this.resolveFolder(worktreeInput);
    } catch {
      throw new OpError('The fix worktree no longer exists');
    }
    if (!isWorktreePathOf(repoRoot, worktree)) throw new OpError('Refused: not a kineReqLens worktree of this project');
    const list = await this.git(repoRoot, ['worktree', 'list', '--porcelain']);
    const entry = parseWorktreeList(list.stdout).find((w) => {
      try {
        return fs.realpathSync(w.path) === worktree;
      } catch {
        return false;
      }
    });
    if (!entry || !entry.branch || !isFixBranch(entry.branch)) throw new OpError('Refused: not a kineReqLens worktree of this project');
    if (branch !== undefined && entry.branch !== branch) throw new OpError('Refused: the branch does not match the worktree');
    return { repoRoot, worktree, branch: entry.branch };
  }

  async diff(cwd: string, worktreeInput: string): Promise<WorktreeDiff> {
    const { worktree } = await this.validateWorktree(cwd, worktreeInput);
    // New files show up in `git diff HEAD` once they are intent-to-add.
    await this.git(worktree, ['add', '-A', '--intent-to-add']);
    const stat = await this.git(worktree, ['diff', 'HEAD', '--stat']);
    const full = await this.git(worktree, ['diff', 'HEAD', '--no-color', '--no-ext-diff']);
    if (full.code !== 0) throw new OpError(`git diff failed: ${firstLines(full.stderr)}`);
    const split = splitDiff(full.stdout);
    const out: WorktreeDiff = { stat: stat.stdout.slice(0, 20_000), files: split.files };
    if (split.truncated) out.truncated = true;
    return out;
  }

  private writeAttachment(worktree: string, attach: OpAttachment): void {
    const dir = path.join(worktree, ATTACH_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, attach.name), Buffer.from(attach.base64, 'base64'));
  }

  /** `git add -A` + `git commit -F -` (exactly opSteps). Throws when there is nothing to commit. */
  private async commitIn(worktree: string, message: string): Promise<string> {
    const add = await this.git(worktree, ['add', '-A']);
    if (add.code !== 0) throw new OpError(`git add failed: ${firstLines(add.stderr)}`);
    const commit = await this.git(worktree, ['commit', '-F', '-'], message);
    if (commit.code !== 0) {
      const text = `${commit.stdout}\n${commit.stderr}`;
      if (/nothing to commit|no changes added/i.test(text)) throw new OpError('Nothing to commit: the worktree has no changes');
      throw new OpError(`git commit failed: ${firstLines(commit.stderr || commit.stdout)}`);
    }
    const sha = await this.git(worktree, ['rev-parse', 'HEAD']);
    return sha.stdout.trim();
  }

  async commit(cwd: string, worktreeInput: string, message: string, attach?: OpAttachment): Promise<{ sha: string }> {
    const { worktree } = await this.validateWorktree(cwd, worktreeInput);
    if (attach) this.writeAttachment(worktree, attach);
    return { sha: await this.commitIn(worktree, message) };
  }

  async discard(cwd: string, worktreeInput: string, branch: string): Promise<Record<string, never>> {
    const { repoRoot, worktree } = await this.validateWorktree(cwd, worktreeInput, branch);
    const steps = opSteps({ op: 'worktree-discard', cwd: repoRoot, worktree, branch });
    for (const step of steps) {
      const result = await this.git(repoRoot, step.args);
      if (result.code !== 0) throw new OpError(`git ${step.args.slice(0, 2).join(' ')} failed: ${firstLines(result.stderr)}`);
    }
    try {
      fs.rmdirSync(path.dirname(worktree));
    } catch {
      /* other worktrees left: keep the folder */
    }
    return {};
  }

  async issueCreate(cwd: string, title: string, body: string): Promise<{ url: string }> {
    const folder = this.resolveFolder(cwd);
    await this.repoRoot(folder);
    const [step] = opSteps({ op: 'issue-create', cwd: folder, title, body });
    const result = await this.gh(folder, step!.args, body);
    const url = firstUrl(result.stdout);
    if (result.code !== 0 || !url) throw new OpError(`gh issue create failed: ${firstLines(result.stderr || result.stdout || result.error || '')}`);
    return { url };
  }

  /** Upload a PNG with `gh image` (the gh-image extension); the file lives in shotsDir only during the upload. */
  async imageUpload(cwd: string, base64: string): Promise<{ url: string }> {
    const folder = this.resolveFolder(cwd);
    const repoRoot = await this.repoRoot(folder);
    const ext = await this.gh(folder, ['extension', 'list'], undefined, GIT_TIMEOUT_MS);
    if (ext.code !== 0 || !ext.stdout.includes(GH_IMAGE_EXTENSION)) {
      throw new OpError(`The gh-image extension is not installed — run \`${GH_IMAGE_INSTALL}\` yourself (kineReqLens never installs it), or copy the image instead.`);
    }
    const origin = await this.git(repoRoot, ['remote', 'get-url', 'origin']);
    const slug = origin.code === 0 ? githubRepoSlug(origin.stdout.trim()) : null;
    fs.mkdirSync(this.options.shotsDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.options.shotsDir, `upload-${randomBytes(8).toString('hex')}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 });
    try {
      const result = await this.gh(folder, imageUploadArgs(file, slug));
      const url = attachmentUrlOf(result.stdout);
      if (result.code !== 0 || !url) throw new OpError(explainImageUploadError(`${result.stderr}\n${result.stdout}\n${result.error ?? ''}`));
      return { url };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async prCreate(op: Extract<GitOp, { op: 'pr-create' }>): Promise<{ url: string; sha: string }> {
    const { worktree, branch } = await this.validateWorktree(op.cwd, op.worktree, op.branch);
    if (op.attach) this.writeAttachment(worktree, op.attach);
    const status = await this.git(worktree, ['status', '--porcelain']);
    let sha: string;
    if (status.stdout.trim()) sha = await this.commitIn(worktree, op.message);
    else sha = (await this.git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    const push = await this.git(worktree, ['push', '-u', 'origin', branch], undefined, NETWORK_TIMEOUT_MS);
    if (push.code !== 0) throw new OpError(`git push failed: ${firstLines(push.stderr || push.error || '')}`);
    const steps = opSteps({ ...op, worktree, branch });
    const pr = steps[steps.length - 1]!;
    const result = await this.gh(worktree, pr.args, op.body);
    const url = firstUrl(result.stdout);
    if (result.code !== 0 || !url) throw new OpError(`gh pr create failed (the branch was pushed): ${firstLines(result.stderr || result.stdout || result.error || '')}`);
    return { url, sha };
  }

  /** Run one validated op. */
  async run(op: GitOp): Promise<OpResults[GitOp['op']]> {
    switch (op.op) {
      case 'check':
        return this.check(op.cwd);
      case 'issue-create':
        return this.issueCreate(op.cwd, op.title, op.body);
      case 'image-upload':
        return this.imageUpload(op.cwd, op.image);
      case 'worktree-diff':
        return this.diff(op.cwd, op.worktree);
      case 'worktree-commit':
        return this.commit(op.cwd, op.worktree, op.message, op.attach);
      case 'worktree-discard':
        return this.discard(op.cwd, op.worktree, op.branch);
      case 'pr-create':
        return this.prCreate(op);
    }
  }
}
