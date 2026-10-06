import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_MAX_INBOUND_BYTES, PTY_DATA_CHUNK_CHARS, PTY_MAX_SESSIONS } from '../../../src/shared/claude-protocol';
import type { PtyFromHost } from '../../../src/shared/claude-protocol';
import { parseExtensionMessage } from '../messages';
import { encodeNativeMessage } from '../nm-framing';
import { PtyManager, loadNodePty, ptyCommand, resolveCwd } from '../pty';
import type { PtyProcess, PtySpawn, PtySpawnOptions } from '../pty';
import { removeDir, startHub, tempDir, waitFor } from './helpers';

class FakePty implements PtyProcess {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  kills: Array<string | undefined> = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: PtySpawnOptions,
  ) {}
  onData(fn: (data: string) => void): void {
    this.dataListeners.push(fn);
  }
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(fn);
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  emit(data: string): void {
    for (const fn of this.dataListeners) fn(data);
  }
  exit(exitCode: number, signal = 0): void {
    for (const fn of this.exitListeners) fn({ exitCode, signal });
  }
}

let root: string;
let homedir: string;
let project: string;

beforeEach(() => {
  root = tempDir('rl-pty-');
  homedir = path.join(root, 'home');
  project = path.join(homedir, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(homedir, 'file.txt'), 'x');
});

afterEach(() => {
  vi.useRealTimers();
  removeDir(root);
});

function harness(options: { env?: NodeJS.ProcessEnv; loadSpawn?: () => PtySpawn; platform?: NodeJS.Platform; maxSessions?: number } = {}) {
  const sent: PtyFromHost[] = [];
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = (file, args, opts) => {
    const pty = new FakePty(file, args, opts);
    ptys.push(pty);
    return pty;
  };
  const manager = new PtyManager({
    send: (message) => sent.push(message),
    loadSpawn: options.loadSpawn ?? (() => spawn),
    env: options.env ?? { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: homedir },
    platform: options.platform ?? 'darwin',
    homedir,
    repoDir: '/repo/reqlens',
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  });
  const of = <T extends PtyFromHost['t']>(t: T) => sent.filter((m) => m.t === t) as Array<Extract<PtyFromHost, { t: T }>>;
  return { manager, sent, ptys, of };
}

describe('ptyCommand', () => {
  it('runs claude through the login + interactive shell', () => {
    expect(ptyCommand({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l', '-i', '-c', 'exec claude'] });
    expect(ptyCommand({}, 'darwin').args).toEqual(['-l', '-i', '-c', 'exec claude']);
    expect(['/bin/zsh', '/bin/sh']).toContain(ptyCommand({}, 'linux').file);
    // A relative SHELL is not trusted.
    expect(ptyCommand({ SHELL: 'zsh' }, 'darwin').file).not.toBe('zsh');
  });

  it('uses cmd.exe + claude.cmd on Windows', () => {
    expect(ptyCommand({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32')).toEqual({ file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/c', 'claude.cmd'] });
    expect(ptyCommand({}, 'win32').file).toBe('cmd.exe');
  });

  it('honours the test-only REQLENS_PTY_COMMAND', () => {
    expect(ptyCommand({ SHELL: '/bin/bash', REQLENS_PTY_COMMAND: 'echo hi' }, 'linux').args).toEqual(['-l', '-i', '-c', 'echo hi']);
    expect(ptyCommand({ REQLENS_PTY_COMMAND: 'echo hi' }, 'win32').args).toEqual(['/d', '/c', 'echo hi']);
    expect(ptyCommand({ SHELL: '/bin/bash', REQLENS_PTY_COMMAND: '  ' }, 'linux').args[3]).toBe('exec claude');
  });
});

describe('resolveCwd', () => {
  it('expands ~ and requires an existing absolute directory', () => {
    expect(resolveCwd('~', homedir, 'darwin')).toEqual({ ok: true, cwd: homedir });
    expect(resolveCwd('  ~/project  ', homedir, 'darwin')).toEqual({ ok: true, cwd: project });
    expect(resolveCwd(`${project}/../project/`, homedir, 'darwin')).toEqual({ ok: true, cwd: project });
    expect(resolveCwd('project', homedir, 'darwin')).toMatchObject({ ok: false, error: expect.stringContaining('absolute') });
    expect(resolveCwd('~other/x', homedir, 'darwin')).toMatchObject({ ok: false });
    expect(resolveCwd('', homedir, 'darwin')).toMatchObject({ ok: false });
    expect(resolveCwd('~/missing', homedir, 'darwin')).toMatchObject({ ok: false, error: expect.stringContaining('No such directory') });
    expect(resolveCwd('~/file.txt', homedir, 'darwin')).toMatchObject({ ok: false, error: expect.stringContaining('Not a directory') });
  });
});

describe('PtyManager', () => {
  it('spawns the shell in the resolved folder with a truecolor xterm env, and reports the pid', () => {
    const { manager, ptys, sent } = harness({ env: { SHELL: '/bin/zsh', HOME: homedir, REQLENS_PTY_COMMAND: 'echo hi', OTHER: 'kept' } });
    manager.handle({ t: 'pty-open', id: 'p1', cwd: '~/project', cols: 120, rows: 40 });
    expect(ptys).toHaveLength(1);
    const pty = ptys[0]!;
    expect(pty.file).toBe('/bin/zsh');
    expect(pty.args).toEqual(['-l', '-i', '-c', 'echo hi']);
    expect(pty.options).toMatchObject({ name: 'xterm-256color', cols: 120, rows: 40, cwd: project });
    expect(pty.options.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', OTHER: 'kept', HOME: homedir });
    expect(pty.options.env.REQLENS_PTY_COMMAND).toBeUndefined();
    expect(sent).toEqual([{ t: 'pty-opened', id: 'p1', pid: pty.pid, cwd: project }]);
    expect(manager.size).toBe(1);
  });

  it('refuses bad folders, duplicate ids and more than the max sessions', () => {
    const { manager, ptys, of } = harness({ maxSessions: 2 });
    manager.handle({ t: 'pty-open', id: 'bad', cwd: 'relative/dir', cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p2', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p3', cwd: project, cols: 80, rows: 24 });
    expect(ptys).toHaveLength(2);
    expect(of('pty-error').map((m) => [m.id, m.error])).toEqual([
      ['bad', expect.stringContaining('absolute')],
      ['p1', 'A terminal with this id already exists'],
      ['p3', expect.stringContaining('At most 2 terminals')],
    ]);
    expect(PTY_MAX_SESSIONS).toBe(8);
  });

  it('answers with a fix hint when node-pty cannot be loaded or spawn fails', () => {
    const missing = harness({
      loadSpawn: () => {
        throw new Error("Cannot find module 'node-pty'\nRequire stack: …");
      },
    });
    missing.manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    const error = missing.of('pty-error')[0]!.error;
    expect(error).toContain("Cannot find module 'node-pty'");
    expect(error).not.toContain('Require stack');
    expect(error).toContain('npm rebuild node-pty');
    expect(error).toContain('/repo/reqlens');

    const broken = harness({
      loadSpawn: () => () => {
        throw new Error('posix_spawnp failed.');
      },
    });
    broken.manager.handle({ t: 'pty-open', id: 'p2', cwd: project, cols: 80, rows: 24 });
    expect(broken.of('pty-error')[0]!.error).toMatch(/Could not start zsh in .*posix_spawnp failed.*npm rebuild node-pty/);
    expect(broken.manager.size).toBe(0);
  });

  it('batches output for ~16 ms and chunks big output', () => {
    vi.useFakeTimers();
    const { manager, ptys, of } = harness();
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    const pty = ptys[0]!;
    pty.emit('a');
    pty.emit('b');
    pty.emit('c');
    expect(of('pty-data')).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(of('pty-data')).toEqual([{ t: 'pty-data', id: 'p1', data: 'abc' }]);
    // A burst bigger than the flush threshold goes out at once, in chunks.
    const big = '\u001b[31mé😀'.repeat(60_000);
    pty.emit(big);
    const chunks = of('pty-data').slice(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.data).join('')).toBe(big);
    for (const chunk of chunks) {
      expect(chunk.data.length).toBeLessThanOrEqual(PTY_DATA_CHUNK_CHARS);
      // Every frame stays far below the browser's 1 MB host → extension limit.
      expect(encodeNativeMessage(chunk, NATIVE_MAX_INBOUND_BYTES).length).toBeLessThan(NATIVE_MAX_INBOUND_BYTES / 2);
    }
  });

  it('flushes pending output before reporting the exit', () => {
    vi.useFakeTimers();
    const { manager, ptys, sent } = harness();
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    ptys[0]!.emit('bye\r\n');
    ptys[0]!.exit(3);
    expect(sent.slice(1)).toEqual([
      { t: 'pty-data', id: 'p1', data: 'bye\r\n' },
      { t: 'pty-exit', id: 'p1', code: 3, signal: null },
    ]);
    expect(manager.size).toBe(0);
    ptys[1]?.exit(0);
    ptys[0]!.exit(1, 9);
    expect(sent).toHaveLength(3);
  });

  it('forwards input and resizes; ignores unknown ids', () => {
    const { manager, ptys } = harness();
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-input', id: 'p1', data: 'hello\r' });
    manager.handle({ t: 'pty-resize', id: 'p1', cols: 100, rows: 30 });
    manager.handle({ t: 'pty-input', id: 'nope', data: 'x' });
    manager.handle({ t: 'pty-resize', id: 'nope', cols: 1, rows: 1 });
    manager.handle({ t: 'pty-close', id: 'nope' });
    expect(ptys[0]!.written).toEqual(['hello\r']);
    expect(ptys[0]!.sizes).toEqual([[100, 30]]);
  });

  it('closing kills with SIGHUP (SIGKILL if it lingers) and sends nothing more', () => {
    vi.useFakeTimers();
    const { manager, ptys, sent } = harness();
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p2', cwd: project, cols: 80, rows: 24 });
    ptys[0]!.emit('late');
    manager.handle({ t: 'pty-close', id: 'p1' });
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(3000);
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL']);
    ptys[0]!.exit(0);
    expect(sent.filter((m) => m.id === 'p1').map((m) => m.t)).toEqual(['pty-opened']);
    // One that exits in time is not SIGKILLed.
    manager.handle({ t: 'pty-close', id: 'p2' });
    ptys[1]!.exit(0, 1);
    vi.advanceTimersByTime(5000);
    expect(ptys[1]!.kills).toEqual(['SIGHUP']);
  });

  it('killAll ends every terminal and refuses new ones', () => {
    const { manager, ptys, of } = harness();
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    manager.handle({ t: 'pty-open', id: 'p2', cwd: project, cols: 80, rows: 24 });
    manager.killAll('browser gone');
    expect(ptys.map((p) => p.kills)).toEqual([['SIGHUP'], ['SIGHUP']]);
    expect(manager.size).toBe(0);
    manager.handle({ t: 'pty-open', id: 'p3', cwd: project, cols: 80, rows: 24 });
    expect(of('pty-error').at(-1)).toMatchObject({ id: 'p3' });
    expect(ptys).toHaveLength(2);
  });

  it('kills without a signal on Windows', () => {
    const { manager, ptys } = harness({ platform: 'win32', env: {} });
    manager.handle({ t: 'pty-open', id: 'p1', cwd: project, cols: 80, rows: 24 });
    expect(ptys[0]!.file).toBe('cmd.exe');
    manager.handle({ t: 'pty-close', id: 'p1' });
    expect(ptys[0]!.kills).toEqual([undefined]);
  });
});

describe('pty messages from the extension', () => {
  it('are strictly validated', () => {
    expect(parseExtensionMessage({ t: 'pty-open', id: 'pty-1', cwd: '~/x', cols: 80, rows: 24 })).toEqual({ t: 'pty-open', id: 'pty-1', cwd: '~/x', cols: 80, rows: 24 });
    expect(parseExtensionMessage({ t: 'pty-open', id: 'pty-1', cwd: '~/x', cols: 0, rows: 24 })).toBeNull();
    expect(parseExtensionMessage({ t: 'pty-open', id: 'x'.repeat(65), cwd: '~/x', cols: 80, rows: 24 })).toBeNull();
    expect(parseExtensionMessage({ t: 'pty-input', id: 'pty-1', data: 'x'.repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseExtensionMessage({ t: 'pty-resize', id: 'pty-1', cols: 1001, rows: 5 })).toBeNull();
    expect(parseExtensionMessage({ t: 'pty-close', id: 'pty-1' })).toEqual({ t: 'pty-close', id: 'pty-1' });
    expect(parseExtensionMessage({ t: 'pty-kill', id: 'pty-1' })).toBeNull();
  });
});

describe('hub terminals', () => {
  it('relays pty messages and kills every terminal when the browser disconnects', async () => {
    const home = path.join(root, 'rlhome');
    const ptys: FakePty[] = [];
    const spawn: PtySpawn = (file, args, opts) => {
      const pty = new FakePty(file, args, opts);
      ptys.push(pty);
      return pty;
    };
    const { hub, ext } = await startHub(home, { pty: { loadSpawn: () => spawn, homedir, env: { SHELL: '/bin/zsh' } } });
    ext.sendHello();
    ext.send({ t: 'pty-open', id: 'p1', cwd: '~/project', cols: 90, rows: 20 });
    const opened = await ext.nth('pty-opened', 1);
    expect(opened).toEqual({ t: 'pty-opened', id: 'p1', pid: ptys[0]!.pid, cwd: project });
    ext.send({ t: 'pty-input', id: 'p1', data: 'ls\r' });
    await waitFor(() => ptys[0]!.written.length > 0);
    expect(ptys[0]!.written).toEqual(['ls\r']);
    ptys[0]!.emit('out');
    expect((await ext.nth('pty-data', 1)).data).toBe('out');
    // Invalid messages are dropped (the hub stays up).
    ext.send({ t: 'pty-open', id: 'p2', cwd: '~/project', cols: 90.5, rows: 20 });
    ext.disconnect();
    await hub.closed;
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.kills).toEqual(['SIGHUP']);
  });
});

// A real pseudo-terminal through node-pty (skipped where node-pty is unavailable).
let realSpawn: PtySpawn | null = null;
try {
  realSpawn = process.platform === 'win32' ? null : loadNodePty(import.meta.url);
} catch {
  realSpawn = null;
}

describe.skipIf(!realSpawn)('hub terminals with node-pty (real)', () => {
  it('runs a command in the folder and streams its output, then its exit code', async () => {
    const home = path.join(root, 'rlhome');
    const { hub, ext } = await startHub(home, {
      pty: { homedir, env: { ...process.env, REQLENS_PTY_COMMAND: 'pwd; echo "hi é 😀"; exit 3' } },
    });
    try {
      ext.send({ t: 'pty-open', id: 'real-1', cwd: '~/project', cols: 80, rows: 24 });
      const exit = await ext.nth('pty-exit', 1, 15_000);
      expect(exit).toMatchObject({ id: 'real-1', code: 3 });
      const output = ext.of('pty-data').map((m) => m.data).join('');
      expect(output).toContain('hi é 😀');
      expect(output).toContain(fs.realpathSync(project));
    } finally {
      await hub.stop();
    }
  }, 20_000);

  it('chunks a large burst and kills the terminal when the browser disconnects', async () => {
    const home = path.join(root, 'rlhome');
    const { hub, ext } = await startHub(home, {
      pty: { homedir, env: { ...process.env, REQLENS_PTY_COMMAND: "head -c 400000 /dev/zero | tr '\\0' x; echo; echo done; sleep 30" } },
    });
    ext.send({ t: 'pty-open', id: 'real-2', cwd: os.tmpdir(), cols: 200, rows: 50 });
    const opened = await ext.nth('pty-opened', 1, 15_000);
    await waitFor(() => ext.of('pty-data').map((m) => m.data).join('').includes('done'), 15_000, 'the burst');
    const chunks = ext.of('pty-data');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.data.length).toBeLessThanOrEqual(PTY_DATA_CHUNK_CHARS);
    expect(chunks.map((m) => m.data).join('').split('x').length - 1).toBe(400_000);
    ext.disconnect();
    await hub.closed;
    await waitFor(
      () => {
        try {
          process.kill(opened.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      5000,
      'the terminal process to end',
    );
  }, 30_000);
});
