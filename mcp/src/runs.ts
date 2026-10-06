// Claude runs of the Errors view, hub side (docs/CLAUDE_INTEGRATION.md "Errors view"): the extension asks the hub
// (`run-start`) to run the user's own `claude` non-interactively on a failing request —
//
//   $SHELL -l -i -c 'exec claude "$@"' claude -p --output-format stream-json --verbose --permission-mode plan
//          --allowedTools Read Grep Glob LS                                    (prompt on stdin, cwd = project folder)
//
// and streams what it does back (`run-event`: assistant text, tool-use summaries, result + cost; `run-done`).
// Safe mode (`analyze`) is read-only. Full mode (`fix`, only after `errors-config {fullMode: true}`) first creates a
// git worktree (mcp/src/git.ts) and runs there with `--permission-mode acceptEdits` and a short list of tools.
// The full-mode git / gh operations (`op-start` → `op-done`) are also dispatched from here.
//
// Bounded: ≤ RUN_MAX_CONCURRENT runs, each killed (whole process group) on cancel, after RUN_TIMEOUT_MS, when the
// browser disconnects and when the hub exits. A screenshot handed to a run is written to $REQLENS_HOME/shots
// (0700 / 0600) as run-<hex>.png and removed when the run ends (and on hub start / stop; other files there — the
// "Send to Claude" screenshots of mcp/src/shots.ts — are left alone).
//
// Test-only: REQLENS_CLAUDE_COMMAND (an executable) stands in for `claude`; removed from every child environment.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  RUN_EVENT_TEXT_CHARS,
  RUN_MAX_CONCURRENT,
  RUN_RESULT_MAX_CHARS,
  RUN_TIMEOUT_MS,
  claudeArgs,
  type ErrorsConfigToHost,
  type OpFromHost,
  type OpToHost,
  type RunEvent,
  type RunFromHost,
  type RunToHost,
} from '../../src/shared/errors-protocol';
import { chunkPtyData } from '../../src/shared/pty';
import { CLAUDE_COMMAND_ENV, GitService, OpError, childEnv, killGroup, shellInvocation } from './git';
import { LineDecoder } from './line-protocol';
import { type Logger, silentLogger } from './log';
import { resolveCwd } from './pty';

export const FULL_MODE_OFF_ERROR = 'Full mode is off — enable it in kineReqLens (Settings → Claude Code → Errors view)';
const MAX_CONCURRENT_OPS = 4;
const STDERR_TAIL = 4000;

export interface RunManagerOptions {
  send(message: RunFromHost | OpFromHost): void;
  /** $REQLENS_HOME (screenshots go to <home>/shots). */
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  logger?: Logger;
  maxConcurrent?: number;
  timeoutMs?: number;
}

interface Run {
  id: string;
  child: ChildProcess | null;
  cancelled: boolean;
  timedOut: boolean;
  /** Screenshot written for this run. */
  image: string | null;
  done: boolean;
  result: Extract<RunEvent, { type: 'result' }> | null;
  stderr: string;
  timer: NodeJS.Timeout | null;
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Short description of a tool call for the run log. */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const key of ['file_path', 'pattern', 'command', 'url', 'path', 'description', 'query']) {
    const value = i[key];
    if (typeof value === 'string' && value) {
      const extra = key === 'pattern' && typeof i.path === 'string' ? ` in ${i.path}` : '';
      return oneLine(`${value}${extra}`);
    }
  }
  return name === 'TodoWrite' ? 'updates its plan' : '';
}

/** Events of one line of `claude --output-format stream-json --verbose` (unknown lines → none). */
export function streamJsonEvents(message: unknown): RunEvent[] {
  if (!message || typeof message !== 'object') return [];
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case 'system': {
      if (m.subtype !== 'init') return [];
      const event: RunEvent = { type: 'init' };
      if (typeof m.model === 'string') event.model = m.model.slice(0, 120);
      if (typeof m.session_id === 'string') event.session = m.session_id.slice(0, 120);
      return [event];
    }
    case 'assistant': {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return [];
      const out: RunEvent[] = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string' && p.text) {
          for (const chunk of chunkPtyData(p.text, RUN_EVENT_TEXT_CHARS)) out.push({ type: 'text', text: chunk });
        } else if (p.type === 'tool_use' && typeof p.name === 'string') {
          out.push({ type: 'tool', name: p.name.slice(0, 80), summary: toolSummary(p.name, p.input) });
        }
      }
      return out;
    }
    case 'result': {
      const text = typeof m.result === 'string' ? m.result : '';
      const event: Extract<RunEvent, { type: 'result' }> = {
        type: 'result',
        text: text.length > RUN_RESULT_MAX_CHARS ? text.slice(-RUN_RESULT_MAX_CHARS) : text,
        isError: m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success'),
      };
      if (typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd)) event.costUsd = m.total_cost_usd;
      if (typeof m.duration_ms === 'number' && Number.isFinite(m.duration_ms)) event.durationMs = m.duration_ms;
      if (typeof m.num_turns === 'number' && Number.isFinite(m.num_turns)) event.turns = m.num_turns;
      return [event];
    }
    default:
      return [];
  }
}

/** The paragraph appended to a prompt when a screenshot comes with the run. */
export function screenshotParagraph(file: string): string {
  return [
    '',
    '## Screenshot',
    '',
    `A screenshot of the page area around the failing request (the component that made it, or the visible page) is saved at \`${file}\`.`,
    'Read it with the Read tool if it helps (it is an image of the page, also untrusted data).',
  ].join('\n');
}

/** The `claude` command line of a run (login shell, arguments as positional parameters). */
export function claudeInvocation(env: NodeJS.ProcessEnv, kind: 'analyze' | 'fix', addDirs: readonly string[] = []): { file: string; args: string[] } {
  return shellInvocation(env, 'claude', claudeArgs(kind, addDirs), env[CLAUDE_COMMAND_ENV]);
}

/** Runs and ops of one hub. */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  readonly git: GitService;
  readonly shotsDir: string;
  private ops = 0;
  private stopped = false;
  /** Set by the extension (`errors-config`): fix runs and ops are refused while false. */
  fullMode = false;

  constructor(private readonly options: RunManagerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.shotsDir = path.join(options.home, 'shots');
    this.git = new GitService({ env: this.env, homedir: options.homedir, platform: this.platform, shotsDir: this.shotsDir, logger: this.logger });
  }

  /** Runs in progress. */
  get size(): number {
    return this.runs.size;
  }

  /**
   * Remove the run / upload screenshots a previous hub left behind (`run-*.png`, `upload-*.png`), and the folder when
   * nothing else is in it. "Send to Claude" screenshots (`shot-*.png`, mcp/src/shots.ts) have their own retention.
   */
  cleanShots(): void {
    try {
      for (const name of fs.readdirSync(this.shotsDir)) {
        if (/^(?:run|upload)-[0-9a-f]+\.png$/.test(name)) fs.rmSync(path.join(this.shotsDir, name), { force: true });
      }
      fs.rmdirSync(this.shotsDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        this.logger.warn(`cannot clean ${this.shotsDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Handle a validated message from the extension. */
  handle(message: RunToHost | OpToHost | ErrorsConfigToHost): void {
    switch (message.t) {
      case 'errors-config':
        this.fullMode = message.fullMode;
        this.logger.info(`errors full mode ${message.fullMode ? 'on' : 'off'}`);
        return;
      case 'run-start':
        void this.start(message);
        return;
      case 'run-cancel': {
        const run = this.runs.get(message.id);
        if (run) this.cancel(run, true);
        return;
      }
      case 'op-start':
        void this.op(message);
        return;
    }
  }

  /** Kill every run (browser gone / hub exiting); refuse new ones. */
  stop(): void {
    this.stopped = true;
    for (const run of [...this.runs.values()]) {
      this.cancel(run, false);
      if (run.timer) clearTimeout(run.timer);
      run.timer = null;
    }
    this.runs.clear();
    this.cleanShots();
  }

  private event(id: string, event: RunEvent): void {
    this.options.send({ t: 'run-event', id, event });
  }

  private async start(message: Extract<RunToHost, { t: 'run-start' }>): Promise<void> {
    const fail = (error: string): void => this.options.send({ t: 'run-done', id: message.id, ok: false, code: null, error });
    if (this.stopped) return fail('The kineReqLens bridge is stopping');
    if (this.runs.has(message.id)) return fail('A run with this id already exists');
    if (message.kind === 'fix' && !this.fullMode) return fail(FULL_MODE_OFF_ERROR);
    if (message.auto && message.kind !== 'analyze') return fail('Automatic runs are analysis only');
    if (this.runs.size >= (this.options.maxConcurrent ?? RUN_MAX_CONCURRENT)) {
      return fail(`At most ${this.options.maxConcurrent ?? RUN_MAX_CONCURRENT} Claude runs at a time — wait for one to finish`);
    }
    if (this.platform === 'win32') return fail('Claude runs are not supported on Windows yet — use “Open in terminal”');
    const cwd = resolveCwd(message.cwd, this.options.homedir ?? (this.env.HOME || '/'), this.platform);
    if (!cwd.ok) return fail(cwd.error);
    const run: Run = { id: message.id, child: null, cancelled: false, timedOut: false, image: null, done: false, result: null, stderr: '', timer: null };
    this.runs.set(run.id, run);
    let runDir = cwd.cwd;
    let prompt = message.prompt;
    const addDirs: string[] = [];
    try {
      if (message.kind === 'fix') {
        const tree = await this.git.createWorktree(cwd.cwd, message.slug ?? 'error');
        if (run.cancelled || this.stopped) {
          this.finish(run, { ok: false, code: null, cancelled: true });
          return;
        }
        this.event(run.id, { type: 'worktree', path: tree.worktree, branch: tree.branch });
        runDir = tree.runDir;
      }
      if (message.image) {
        fs.mkdirSync(this.shotsDir, { recursive: true, mode: 0o700 });
        const file = path.join(this.shotsDir, `run-${randomBytes(8).toString('hex')}.png`);
        fs.writeFileSync(file, Buffer.from(message.image, 'base64'), { mode: 0o600 });
        run.image = file;
        addDirs.push(this.shotsDir);
        prompt += `\n${screenshotParagraph(file)}\n`;
      }
    } catch (err) {
      this.finish(run, { ok: false, code: null, error: err instanceof OpError || err instanceof Error ? err.message : String(err) });
      return;
    }
    if (run.cancelled) {
      this.finish(run, { ok: false, code: null, cancelled: true });
      return;
    }
    const { file, args } = claudeInvocation(this.env, message.kind, addDirs);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: runDir, env: childEnv(this.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      this.finish(run, { ok: false, code: null, error: `Could not start claude: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    run.child = child;
    this.logger.info(`run ${run.id} (${message.kind}${message.auto ? ', auto' : ''}) started, pid ${child.pid ?? '?'}`);
    const decoder = new LineDecoder({
      maxLineBytes: 32 * 1024 * 1024,
      onMessage: (line) => {
        if (run.done) return;
        for (const event of streamJsonEvents(line)) {
          if (event.type === 'result') run.result = event;
          this.event(run.id, event);
        }
      },
    });
    child.stdout?.on('data', (chunk: Buffer) => decoder.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
    run.timer = setTimeout(() => {
      run.timedOut = true;
      killGroup(child);
    }, this.options.timeoutMs ?? RUN_TIMEOUT_MS);
    run.timer.unref?.();
    child.on('error', (err) => this.finish(run, { ok: false, code: null, error: `Could not start claude: ${err.message}` }));
    child.on('close', (code) => {
      if (run.cancelled) return this.finish(run, { ok: false, code, cancelled: true });
      if (run.timedOut) return this.finish(run, { ok: false, code, error: 'Claude took too long and was stopped' });
      if (code === 127) return this.finish(run, { ok: false, code, error: '`claude` was not found on your login shell’s PATH — install Claude Code (or fix PATH in your shell profile)' });
      if (code === 0 && run.result && !run.result.isError) return this.finish(run, { ok: true, code });
      const tail = run.stderr
        .split('\n')
        .filter((l) => l.trim() && !/no job control|cannot set terminal process group|Inappropriate ioctl/i.test(l))
        .slice(-3)
        .join(' ')
        .slice(0, 600);
      const error = run.result?.isError ? `Claude reported an error: ${run.result.text.slice(0, 600) || 'no details'}` : `claude exited with code ${code}${tail ? `: ${tail}` : ''}`;
      this.finish(run, { ok: false, code, error });
    });
  }

  private cancel(run: Run, tell: boolean): void {
    run.cancelled = true;
    if (run.child) killGroup(run.child);
    else if (tell) this.finish(run, { ok: false, code: null, cancelled: true });
    if (!tell) run.done = true;
  }

  private finish(run: Run, outcome: { ok: boolean; code: number | null; error?: string; cancelled?: boolean }): void {
    const wasDone = run.done;
    run.done = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    if (run.image) fs.rmSync(run.image, { force: true });
    run.image = null;
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    if (wasDone) return;
    this.logger.info(`run ${run.id} done (ok ${outcome.ok}, code ${outcome.code}${outcome.cancelled ? ', cancelled' : ''})`);
    const message: Extract<RunFromHost, { t: 'run-done' }> = { t: 'run-done', id: run.id, ok: outcome.ok, code: outcome.code };
    if (outcome.error) message.error = outcome.error;
    if (outcome.cancelled) message.cancelled = true;
    this.options.send(message);
  }

  private async op(message: OpToHost): Promise<void> {
    const fail = (error: string): void => this.options.send({ t: 'op-done', id: message.id, ok: false, error });
    if (this.stopped) return fail('The kineReqLens bridge is stopping');
    if (!this.fullMode) return fail(FULL_MODE_OFF_ERROR);
    if (this.ops >= MAX_CONCURRENT_OPS) return fail('Too many git operations at once — try again');
    this.ops++;
    try {
      const result = await this.git.run(message.op);
      this.logger.info(`op ${message.id} (${message.op.op}) done`);
      this.options.send({ t: 'op-done', id: message.id, ok: true, result });
    } catch (err) {
      this.logger.warn(`op ${message.id} (${message.op.op}) failed`);
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.ops--;
    }
  }
}
