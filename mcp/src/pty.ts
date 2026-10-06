// Embedded Claude Code terminals, hub side (docs/CLAUDE_INTEGRATION.md "Terminal"): the extension asks the hub
// (`pty-open`) to run the real `claude` CLI in a pseudo-terminal (node-pty) in a folder the user picked in the
// overlay; output is batched (~16 ms) and chunked so every native message stays far below the browser's 1 MB
// limit. Every terminal is killed when the browser disconnects (stdin closed) or the hub exits.
//
// node-pty is a native module: it is not bundled into mcp/dist/reqlens-mcp.mjs but required at runtime from the
// repo's node_modules (scripts/build-mcp.mjs marks it external). When it cannot be loaded, `pty-open` is answered
// with a `pty-error` that says how to fix it.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PTY_BATCH_MS, PTY_DATA_CHUNK_CHARS, PTY_MAX_SESSIONS } from '../../src/shared/claude-protocol';
import type { PtyFromHost, PtyToHost } from '../../src/shared/claude-protocol';
import { chunkPtyData } from '../../src/shared/pty';
import { type Logger, silentLogger } from './log';

/** The part of node-pty's IPty the manager uses (a fake in tests). */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** node-pty's `spawn`. */
export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export interface PtyManagerOptions {
  /** Deliver an event to the extension. */
  send(message: PtyFromHost): void;
  /** Load node-pty (throws when unavailable). Default: loadNodePty(). Called on the first `pty-open`. */
  loadSpawn?: () => PtySpawn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  logger?: Logger;
  batchMs?: number;
  maxSessions?: number;
  /** Flush right away once this many chars are buffered. */
  flushChars?: number;
  /** Where `npm rebuild node-pty` must run (shown in the error hint). */
  repoDir?: string;
}

interface Session {
  id: string;
  proc: PtyProcess;
  buffer: string;
  timer: NodeJS.Timeout | null;
  /** Closed by us (killed) or exited: no more events are sent. */
  closed: boolean;
  /** The process exited. */
  exited: boolean;
}

/** A killed terminal that is still alive after this long gets SIGKILL. */
const KILL_GRACE_MS = 3000;

/** The command a terminal runs: the user's login shell, so PATH matches their own terminal. */
export function ptyCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { file: string; args: string[] } {
  // Test-only override (documented in docs/CLAUDE_INTEGRATION.md): run this shell command instead of `claude`.
  const override = env.REQLENS_PTY_COMMAND?.trim() || null;
  if (platform === 'win32') {
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/c', override ?? 'claude.cmd'] };
  }
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
  // -l (login: profile files) and -i (interactive: rc files such as ~/.zshrc, where most installers put PATH —
  // the browser that spawned the hub usually has a minimal launchd/desktop PATH). `exec` hands the pty to claude.
  return { file: shell, args: ['-l', '-i', '-c', override ?? 'exec claude'] };
}

export type CwdResult = { ok: true; cwd: string } | { ok: false; error: string };

/** Expand `~`, require an absolute path to an existing directory. */
export function resolveCwd(input: string, homedir: string, platform: NodeJS.Platform = process.platform): CwdResult {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let dir = input.trim();
  if (!dir) return { ok: false, error: 'Choose a working directory' };
  if (dir === '~') dir = homedir;
  else if (dir.startsWith('~/') || (platform === 'win32' && dir.startsWith('~\\'))) dir = pathApi.join(homedir, dir.slice(2));
  if (!pathApi.isAbsolute(dir)) return { ok: false, error: `Use an absolute path (or ~/…): ${input.trim()}` };
  // (`path` is path.win32 on Windows itself; pathApi only matters for tests of the other platform.)
  const resolved = path.resolve(dir);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(resolved, { throwIfNoEntry: false });
  } catch (err) {
    return { ok: false, error: `Cannot open ${resolved}: ${errorText(err)}` };
  }
  if (!stat) return { ok: false, error: `No such directory: ${resolved}` };
  if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${resolved}` };
  return { ok: true, cwd: resolved };
}

/** Make node-pty's spawn-helper executable (some installs drop the exec bit → "posix_spawnp failed"). */
function fixSpawnHelper(pkgDir: string): void {
  const candidates = [
    path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(pkgDir, 'build', 'Release', 'spawn-helper'),
    path.join(pkgDir, 'build', 'Debug', 'spawn-helper'),
  ];
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat && stat.isFile() && (stat.mode & 0o111) === 0) fs.chmodSync(file, stat.mode | 0o755);
    } catch {
      /* not ours to change: spawn reports the problem */
    }
  }
}

/** Load node-pty from the node_modules next to this script (the repo's, for mcp/dist/reqlens-mcp.mjs). */
export function loadNodePty(fromUrl: string = import.meta.url): PtySpawn {
  const req = createRequire(fromUrl);
  if (process.platform !== 'win32') {
    try {
      fixSpawnHelper(path.dirname(req.resolve('node-pty/package.json')));
    } catch {
      /* resolved again (and reported) below */
    }
  }
  const mod = req('node-pty') as { spawn?: unknown };
  if (typeof mod.spawn !== 'function') throw new Error('node-pty has no spawn()');
  const spawn = mod.spawn as PtySpawn;
  return (file, args, options) => spawn(file, args, options);
}

/** All terminals of one hub. */
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly batchMs: number;
  private readonly maxSessions: number;
  private readonly flushChars: number;
  private spawn: PtySpawn | null = null;
  private stopped = false;

  constructor(private readonly options: PtyManagerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.batchMs = options.batchMs ?? PTY_BATCH_MS;
    this.maxSessions = options.maxSessions ?? PTY_MAX_SESSIONS;
    this.flushChars = options.flushChars ?? PTY_DATA_CHUNK_CHARS * 4;
  }

  /** Running terminals. */
  get size(): number {
    return this.sessions.size;
  }

  /** Handle a validated control message from the extension. */
  handle(message: PtyToHost): void {
    switch (message.t) {
      case 'pty-open':
        this.open(message);
        return;
      case 'pty-input': {
        const session = this.sessions.get(message.id);
        if (!session) return;
        try {
          session.proc.write(message.data);
        } catch (err) {
          this.logger.warn(`pty ${message.id} write failed: ${errorText(err)}`);
        }
        return;
      }
      case 'pty-resize': {
        const session = this.sessions.get(message.id);
        if (!session) return;
        try {
          session.proc.resize(message.cols, message.rows);
        } catch (err) {
          this.logger.warn(`pty ${message.id} resize failed: ${errorText(err)}`);
        }
        return;
      }
      case 'pty-close': {
        const session = this.sessions.get(message.id);
        if (session) this.kill(session, 'closed by the overlay');
        return;
      }
    }
  }

  /** Kill every terminal (the browser disconnected / the hub is exiting). Further opens are refused. */
  killAll(reason = 'hub stopping'): void {
    this.stopped = true;
    for (const session of [...this.sessions.values()]) this.kill(session, reason);
  }

  private open(message: Extract<PtyToHost, { t: 'pty-open' }>): void {
    const fail = (error: string): void => this.options.send({ t: 'pty-error', id: message.id, error });
    if (this.stopped) return fail('The kineReqLens bridge is stopping');
    if (this.sessions.has(message.id)) return fail('A terminal with this id already exists');
    if (this.sessions.size >= this.maxSessions) return fail(`At most ${this.maxSessions} terminals can run at a time — close one first`);
    const cwd = resolveCwd(message.cwd, this.options.homedir ?? os.homedir(), this.platform);
    if (!cwd.ok) return fail(cwd.error);
    let spawn: PtySpawn;
    try {
      spawn = this.spawn ?? (this.options.loadSpawn ?? (() => loadNodePty()))();
      this.spawn = spawn;
    } catch (err) {
      this.logger.error(`node-pty unavailable: ${errorText(err)}`);
      return fail(`The terminal needs node-pty, which could not be loaded (${errorText(err).split('\n')[0]}). ${this.fixHint()}`);
    }
    const { file, args } = ptyCommand(this.env, this.platform);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) if (typeof value === 'string') env[key] = value;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    // Never leak the test hook into the user's claude session.
    delete env.REQLENS_PTY_COMMAND;
    delete env.REQLENS_FS_PICK_STUB;
    let proc: PtyProcess;
    try {
      proc = spawn(file, args, { name: 'xterm-256color', cols: message.cols, rows: message.rows, cwd: cwd.cwd, env });
    } catch (err) {
      this.logger.error(`pty ${message.id} spawn failed: ${errorText(err)}`);
      return fail(`Could not start ${path.basename(file)} in ${cwd.cwd}: ${errorText(err)}. ${this.fixHint()}`);
    }
    const session: Session = { id: message.id, proc, buffer: '', timer: null, closed: false, exited: false };
    this.sessions.set(message.id, session);
    this.logger.info(`pty ${message.id} started (pid ${proc.pid}, ${message.cols}x${message.rows})`);
    this.options.send({ t: 'pty-opened', id: message.id, pid: proc.pid, cwd: cwd.cwd });
    proc.onData((data) => this.onData(session, data));
    proc.onExit((event) => this.onExit(session, event));
  }

  private onData(session: Session, data: string): void {
    if (session.closed || typeof data !== 'string' || !data) return;
    session.buffer += data;
    if (session.buffer.length >= this.flushChars) {
      this.flush(session);
      return;
    }
    if (session.timer === null) {
      session.timer = setTimeout(() => this.flush(session), this.batchMs);
      session.timer.unref?.();
    }
  }

  private flush(session: Session): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    const data = session.buffer;
    session.buffer = '';
    if (session.closed) return;
    for (const chunk of chunkPtyData(data)) this.options.send({ t: 'pty-data', id: session.id, data: chunk });
  }

  private onExit(session: Session, event: { exitCode: number; signal?: number }): void {
    session.exited = true;
    if (session.closed) return;
    this.flush(session);
    session.closed = true;
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    const code = typeof event?.exitCode === 'number' ? event.exitCode : null;
    const signal = typeof event?.signal === 'number' && event.signal !== 0 ? event.signal : null;
    this.logger.info(`pty ${session.id} exited (code ${code}, signal ${signal})`);
    this.options.send({ t: 'pty-exit', id: session.id, code, signal });
  }

  private kill(session: Session, reason: string): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    session.buffer = '';
    session.closed = true;
    this.sessions.delete(session.id);
    this.logger.info(`pty ${session.id} killed: ${reason}`);
    try {
      if (this.platform === 'win32') session.proc.kill();
      else session.proc.kill('SIGHUP');
    } catch (err) {
      this.logger.warn(`pty ${session.id} kill failed: ${errorText(err)}`);
    }
    if (this.platform === 'win32') return;
    const force = setTimeout(() => {
      if (session.exited) return;
      try {
        session.proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    force.unref?.();
  }

  private fixHint(): string {
    const dir = this.options.repoDir;
    return dir ? `Fix: run \`npm install && npm rebuild node-pty\` in ${dir}` : 'Fix: run `npm install && npm rebuild node-pty` in your reqlens checkout';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
