import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsFromHost, PtyFromHost } from '../../../src/shared/claude-protocol';
import { FsService, PICK_PROMPT, WINDOWS_PICK_SCRIPT, folderKind, interpretPickerRun, listDirectory, pickerCommand, scanProjects } from '../fs';
import type { PickerCommand, PickerRun } from '../fs';
import { parseExtensionMessage } from '../messages';
import { PtyManager } from '../pty';
import type { PtyProcess, PtySpawnOptions } from '../pty';
import { removeDir, startHub, tempDir, waitFor } from './helpers';

let root: string;
let home: string;

function mkdir(...parts: string[]): string {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(...parts: string[]): void {
  const file = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}

beforeEach(() => {
  root = tempDir('rl-fs-');
  home = path.join(root, 'home');
  fs.mkdirSync(home);
});

afterEach(() => {
  removeDir(root);
});

describe('listDirectory', () => {
  it('lists only sub-directories, visible first, sorted naturally, with git / project / hidden flags', async () => {
    mkdir('repo', '.git');
    touch('node-app', 'package.json');
    touch('py', 'pyproject.toml');
    touch('gomod', 'go.mod');
    touch('rusty', 'Cargo.toml');
    touch('worktree', '.git'); // a worktree / submodule has a .git file
    mkdir('plain');
    mkdir('item10');
    mkdir('item9');
    mkdir('Alpha');
    mkdir('.config');
    touch('notes.txt');
    fs.symlinkSync(path.join(home, 'plain'), path.join(home, 'linked'));
    fs.symlinkSync(path.join(home, 'notes.txt'), path.join(home, 'file-link'));
    const result = await listDirectory('~', { homedir: home });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { listing } = result;
    expect(listing.path).toBe(home);
    expect(listing.parent).toBe(root);
    expect(listing.home).toBe(home);
    expect(listing.sep).toBe('/');
    expect(listing.truncated).toBeUndefined();
    expect(listing.entries.map((e) => e.name)).toEqual(['Alpha', 'gomod', 'item9', 'item10', 'linked', 'node-app', 'plain', 'py', 'repo', 'rusty', 'worktree', '.config']);
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(byName.repo).toEqual({ name: 'repo', dir: true, hidden: false, git: true, project: true });
    expect(byName.worktree).toMatchObject({ git: true, project: true });
    for (const name of ['node-app', 'py', 'gomod', 'rusty']) expect(byName[name]).toEqual({ name, dir: true, hidden: false, project: true });
    expect(byName.plain).toEqual({ name: 'plain', dir: true, hidden: false });
    expect(byName['.config']).toEqual({ name: '.config', dir: true, hidden: true });
  });

  it('expands ~/…, and refuses relative, missing and non-directory paths', async () => {
    mkdir('a', 'b');
    touch('file.txt');
    const sub = await listDirectory('~/a', { homedir: home });
    expect(sub.ok && sub.listing.entries.map((e) => e.name)).toEqual(['b']);
    const dotted = await listDirectory(`${home}/a/b/..`, { homedir: home });
    expect(dotted.ok && dotted.listing.path).toBe(path.join(home, 'a'));
    expect(await listDirectory('a', { homedir: home })).toEqual({ ok: false, error: 'Use an absolute path (or ~/…): a' });
    expect(await listDirectory(path.join(home, 'nope'), { homedir: home })).toEqual({ ok: false, error: `No such directory: ${path.join(home, 'nope')}` });
    expect(await listDirectory(path.join(home, 'file.txt'), { homedir: home })).toEqual({ ok: false, error: `Not a directory: ${path.join(home, 'file.txt')}` });
    expect(await listDirectory('   ', { homedir: home })).toEqual({ ok: false, error: 'Choose a working directory' });
  });

  it('has no parent at the root, and reports unreadable folders', async () => {
    const top = await listDirectory('/', { homedir: home });
    expect(top.ok && top.listing.parent).toBeNull();
    if (process.getuid?.() === 0) return; // root reads everything
    const locked = mkdir('locked');
    fs.chmodSync(locked, 0o000);
    try {
      expect(await listDirectory(locked, { homedir: home })).toEqual({ ok: false, error: `Cannot read ${locked}: permission denied` });
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('caps the entries (count and bytes) and skips names with control characters', async () => {
    for (let i = 0; i < 30; i++) mkdir(`d${String(i).padStart(2, '0')}`);
    mkdir('.hidden');
    try {
      mkdir('bad\nname');
    } catch {
      /* not allowed on this file system */
    }
    const capped = await listDirectory(home, { homedir: home, maxEntries: 10 });
    expect(capped.ok && capped.listing.entries.length).toBe(10);
    expect(capped.ok && capped.listing.truncated).toBe(true);
    const budget = await listDirectory(home, { homedir: home, budgetBytes: 200 });
    expect(budget.ok && budget.listing.entries.length).toBeLessThan(10);
    expect(budget.ok && budget.listing.truncated).toBe(true);
    const all = await listDirectory(home, { homedir: home });
    expect(all.ok && all.listing.entries.map((e) => e.name).filter((n) => n.includes('\n'))).toEqual([]);
    expect(all.ok && all.listing.entries.at(-1)?.name).toBe('.hidden');
    // Past the marker deadline the names still come back, unmarked.
    mkdir('d00', '.git');
    const late = await listDirectory(home, { homedir: home, markerDeadlineMs: -1 });
    expect(late.ok && late.listing.entries.find((e) => e.name === 'd00')).toEqual({ name: 'd00', dir: true, hidden: false });
  });

  it('folderKind marks git and project folders', async () => {
    mkdir('x', '.git');
    touch('y', 'go.mod');
    mkdir('z');
    expect(await folderKind(path.join(home, 'x'))).toEqual({ git: true, project: true });
    expect(await folderKind(path.join(home, 'y'))).toEqual({ git: false, project: true });
    expect(await folderKind(path.join(home, 'z'))).toEqual({ git: false, project: false });
  });
});

describe('scanProjects', () => {
  it('finds git repositories ≤ 2 levels under the usual folders, deduplicated, without descending into repos', async () => {
    mkdir('Documents', 'GitHub', 'reqlens', '.git');
    touch('Documents', 'GitHub', 'reqlens', 'package.json');
    mkdir('Documents', 'GitHub', 'reqlens', 'nested', '.git'); // inside a repo: not listed
    mkdir('Documents', 'deep', 'er', 'repo', '.git'); // 3 levels: too deep
    mkdir('Documents', 'notes');
    mkdir('code', 'api', '.git');
    touch('code', 'tool', '.git');
    mkdir('code', 'node_modules', 'pkg', '.git');
    mkdir('code', '.cache', 'x', '.git');
    mkdir('src', '.git'); // the root itself is a repo
    mkdir('elsewhere', 'repo', '.git'); // not a scanned root
    fs.symlinkSync(path.join(home, 'code'), path.join(home, 'GitHub')); // same folder twice (code is scanned first)
    const { projects, truncated } = await scanProjects(home);
    expect(truncated).toBe(false);
    expect(projects).toEqual([
      { path: path.join(home, 'code', 'api'), name: 'api', git: true },
      { path: path.join(home, 'Documents', 'GitHub', 'reqlens'), name: 'reqlens', git: true, project: true },
      { path: path.join(home, 'src'), name: 'src', git: true },
      { path: path.join(home, 'code', 'tool'), name: 'tool', git: true },
    ]);
  });

  it('stops at the project limit and with missing roots', async () => {
    for (let i = 0; i < 5; i++) mkdir('code', `r${i}`, '.git');
    expect(await scanProjects(home, { roots: ['nope'] })).toEqual({ projects: [], truncated: false });
    const capped = await scanProjects(home, { maxProjects: 2 });
    expect(capped.projects).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('native folder chooser commands', () => {
  it('macOS: osascript choose folder with the start folder as argv (no escaping)', () => {
    const built = pickerCommand('darwin', '/Users/me/a "b"', {});
    expect(built).toEqual({
      ok: true,
      command: {
        kind: 'osascript',
        file: '/usr/bin/osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'activate',
          '-e',
          `POSIX path of (choose folder with prompt "${PICK_PROMPT}" default location (POSIX file (item 1 of argv)))`,
          '-e',
          'end run',
          '/Users/me/a "b"',
        ],
      },
    });
  });

  it('Windows: PowerShell FolderBrowserDialog in STA, the start folder in the environment', () => {
    const built = pickerCommand('win32', 'C:\\Users\\me\\code', { SystemRoot: 'D:\\Win' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toEqual({
      kind: 'powershell',
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_PICK_SCRIPT],
      env: { REQLENS_FS_PICK_START: 'C:\\Users\\me\\code' },
    });
    expect(WINDOWS_PICK_SCRIPT).toContain('System.Windows.Forms.FolderBrowserDialog');
    expect(WINDOWS_PICK_SCRIPT).toContain('$env:REQLENS_FS_PICK_START');
    expect(WINDOWS_PICK_SCRIPT).not.toContain('C:\\Users');
    expect(pickerCommand('win32', 'C:\\x', {}).ok && (pickerCommand('win32', 'C:\\x', {}) as { command: PickerCommand }).command.file).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('Linux: zenity, else kdialog, else an error', () => {
    const which = (have: string[]) => (name: string) => (have.includes(name) ? `/usr/bin/${name}` : null);
    expect(pickerCommand('linux', '/home/me', {}, which(['zenity', 'kdialog']))).toEqual({
      ok: true,
      command: { kind: 'zenity', file: '/usr/bin/zenity', args: ['--file-selection', '--directory', `--title=${PICK_PROMPT}`, '--filename=/home/me/'] },
    });
    expect(pickerCommand('linux', '/home/me', {}, which(['kdialog']))).toEqual({
      ok: true,
      command: { kind: 'kdialog', file: '/usr/bin/kdialog', args: ['--getexistingdirectory', '/home/me', '--title', PICK_PROMPT] },
    });
    const none = pickerCommand('linux', '/home/me', {}, which([]));
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toContain('zenity or kdialog');
    expect(pickerCommand('aix', '/', {}).ok).toBe(false);
  });

  it('interprets the chooser result: folder, cancel, failure, timeout', () => {
    const osa: PickerCommand = { kind: 'osascript', file: 'osascript', args: [] };
    const zen: PickerCommand = { kind: 'zenity', file: 'zenity', args: [] };
    const ps: PickerCommand = { kind: 'powershell', file: 'powershell.exe', args: [] };
    const run = (code: number | null, stdout = '', stderr = '', timedOut = false): PickerRun => ({ code, stdout, stderr, timedOut });
    expect(interpretPickerRun(osa, run(0, '/Users/me/code/\n'))).toEqual({ ok: true, path: '/Users/me/code' });
    expect(interpretPickerRun(osa, run(0, '/\n'))).toEqual({ ok: true, path: '/' });
    expect(interpretPickerRun(osa, run(1, '', '0:80: execution error: User canceled. (-128)'))).toEqual({ ok: true, path: null });
    expect(interpretPickerRun(osa, run(1, '', 'boom'))).toEqual({ ok: false, error: 'The folder chooser failed: boom' });
    expect(interpretPickerRun(zen, run(1))).toEqual({ ok: true, path: null });
    expect(interpretPickerRun(zen, run(0, '/home/me/x\n'))).toEqual({ ok: true, path: '/home/me/x' });
    expect(interpretPickerRun(zen, run(5))).toEqual({ ok: false, error: 'The folder chooser failed (exit code 5)' });
    expect(interpretPickerRun(ps, run(0, ''))).toEqual({ ok: true, path: null });
    expect(interpretPickerRun(ps, run(0, 'C:\\Users\\me\r\n'))).toEqual({ ok: true, path: 'C:\\Users\\me' });
    expect(interpretPickerRun(ps, run(0, 'C:\\'))).toEqual({ ok: true, path: 'C:\\' });
    expect(interpretPickerRun(osa, run(null, '', '', true)).ok).toBe(false);
  });
});

function service(options: Partial<ConstructorParameters<typeof FsService>[0]> = {}) {
  const sent: FsFromHost[] = [];
  const svc = new FsService({ send: (m) => sent.push(m), homedir: home, env: {}, platform: 'darwin', ...options });
  return { svc, sent };
}

describe('FsService', () => {
  it('answers listings and errors with the request id', async () => {
    mkdir('one');
    const { svc, sent } = service();
    svc.handle({ t: 'fs-list', id: 'q1', path: '~' });
    svc.handle({ t: 'fs-list', id: 'q2', path: '~/missing' });
    await waitFor(() => sent.length === 2 || undefined);
    const listed = sent.find((m) => m.id === 'q1');
    expect(listed).toMatchObject({ t: 'fs-listed', id: 'q1', path: home, entries: [{ name: 'one', dir: true, hidden: false }] });
    expect(sent.find((m) => m.id === 'q2')).toEqual({ t: 'fs-error', id: 'q2', error: `No such directory: ${path.join(home, 'missing')}` });
  });

  it('opens one chooser at a time and validates what it returns', async () => {
    const chosen = mkdir('picked');
    const runs: Array<{ command: PickerCommand; finish(run: PickerRun): void; cancelled: boolean }> = [];
    const { svc, sent } = service({
      runPicker: (command) => {
        let finish!: (run: PickerRun) => void;
        const done = new Promise<PickerRun>((resolve) => (finish = resolve));
        const entry = { command, finish, cancelled: false };
        runs.push(entry);
        return { done, cancel: () => (entry.cancelled = true) };
      },
    });
    svc.handle({ t: 'fs-pick', id: 'p1', startPath: '~/nope' });
    svc.handle({ t: 'fs-pick', id: 'p2' });
    await waitFor(() => sent.length === 1 || undefined);
    expect(sent[0]).toEqual({ t: 'fs-error', id: 'p2', error: 'The folder chooser is already open' });
    expect(svc.picking).toBe(true);
    // An invalid start folder falls back to home.
    expect(runs[0]!.command.args.at(-1)).toBe(home);
    runs[0]!.finish({ code: 0, stdout: `${chosen}/\n`, stderr: '' });
    await waitFor(() => sent.length === 2 || undefined);
    expect(sent[1]).toEqual({ t: 'fs-picked', id: 'p1', path: chosen });
    expect(svc.picking).toBe(false);

    svc.handle({ t: 'fs-pick', id: 'p3', startPath: chosen });
    await waitFor(() => runs.length === 2 || undefined);
    expect(runs[1]!.command.args.at(-1)).toBe(chosen);
    runs[1]!.finish({ code: 1, stdout: '', stderr: 'User canceled. (-128)' });
    await waitFor(() => sent.length === 3 || undefined);
    expect(sent[2]).toEqual({ t: 'fs-picked', id: 'p3', path: null });

    svc.handle({ t: 'fs-pick', id: 'p4' });
    await waitFor(() => runs.length === 3 || undefined);
    runs[2]!.finish({ code: 0, stdout: `${path.join(home, 'gone')}\n`, stderr: '' });
    await waitFor(() => sent.length === 4 || undefined);
    expect(sent[3]).toMatchObject({ t: 'fs-error', id: 'p4', error: expect.stringContaining('No such directory') });

    svc.handle({ t: 'fs-pick', id: 'p5' });
    await waitFor(() => runs.length === 4 || undefined);
    svc.stop();
    expect(runs[3]!.cancelled).toBe(true);
    svc.handle({ t: 'fs-list', id: 'q9', path: '~' });
    expect(sent.at(-1)).toEqual({ t: 'fs-error', id: 'q9', error: 'The kineReqLens bridge is stopping' });
  });

  it('reports a missing chooser, and honours the test-only REQLENS_FS_PICK_STUB', async () => {
    const stubbed = mkdir('stubbed');
    const none = service({ platform: 'linux', which: () => null });
    none.svc.handle({ t: 'fs-pick', id: 'p1' });
    await waitFor(() => none.sent.length === 1 || undefined);
    expect(none.sent[0]).toMatchObject({ t: 'fs-error', id: 'p1', error: expect.stringContaining('zenity or kdialog') });

    const stub = service({ env: { REQLENS_FS_PICK_STUB: '~/stubbed' }, runPicker: () => { throw new Error('no dialog in tests'); } });
    stub.svc.handle({ t: 'fs-pick', id: 'p2' });
    await waitFor(() => stub.sent.length === 1 || undefined);
    expect(stub.sent[0]).toEqual({ t: 'fs-picked', id: 'p2', path: stubbed });
    const cancel = service({ env: { REQLENS_FS_PICK_STUB: 'cancel' } });
    cancel.svc.handle({ t: 'fs-pick', id: 'p3' });
    await waitFor(() => cancel.sent.length === 1 || undefined);
    expect(cancel.sent[0]).toEqual({ t: 'fs-picked', id: 'p3', path: null });
  });

  it('caches the projects scan until refreshed', async () => {
    mkdir('code', 'one', '.git');
    const { svc, sent } = service();
    svc.handle({ t: 'fs-projects', id: 's1' });
    await waitFor(() => sent.length === 1 || undefined);
    expect(sent[0]).toEqual({ t: 'fs-projects-listed', id: 's1', home, projects: [{ path: path.join(home, 'code', 'one'), name: 'one', git: true }] });
    mkdir('code', 'two', '.git');
    svc.handle({ t: 'fs-projects', id: 's2' });
    await waitFor(() => sent.length === 2 || undefined);
    expect((sent[1] as Extract<FsFromHost, { t: 'fs-projects-listed' }>).projects).toHaveLength(1);
    svc.handle({ t: 'fs-projects', id: 's3', refresh: true });
    await waitFor(() => sent.length === 3 || undefined);
    expect((sent[2] as Extract<FsFromHost, { t: 'fs-projects-listed' }>).projects.map((p) => p.name)).toEqual(['one', 'two']);
  });
});

describe('fs messages from the extension', () => {
  it('are strictly validated', () => {
    expect(parseExtensionMessage({ t: 'fs-list', id: 'a', path: '~/x' })).toEqual({ t: 'fs-list', id: 'a', path: '~/x' });
    expect(parseExtensionMessage({ t: 'fs-list', id: 'a', path: 'x\u0000' })).toBeNull();
    expect(parseExtensionMessage({ t: 'fs-list', id: 'a b', path: '~' })).toBeNull();
    expect(parseExtensionMessage({ t: 'fs-list', id: 'a', path: 'x'.repeat(5000) })).toBeNull();
    expect(parseExtensionMessage({ t: 'fs-pick', id: 'a' })).toEqual({ t: 'fs-pick', id: 'a' });
    expect(parseExtensionMessage({ t: 'fs-pick', id: 'a', startPath: '/x' })).toEqual({ t: 'fs-pick', id: 'a', startPath: '/x' });
    expect(parseExtensionMessage({ t: 'fs-pick', id: 'a', startPath: 5 })).toBeNull();
    expect(parseExtensionMessage({ t: 'fs-projects', id: 'a', refresh: true })).toEqual({ t: 'fs-projects', id: 'a', refresh: true });
    expect(parseExtensionMessage({ t: 'fs-projects', id: 'a', refresh: 'yes' })).toBeNull();
    expect(parseExtensionMessage({ t: 'fs-read', id: 'a', path: '/etc/passwd' })).toBeNull();
  });
});

describe('hub folder browser', () => {
  it('announces the feature and relays fs requests', async () => {
    mkdir('proj', '.git');
    const reqlensHome = tempDir('rl-fsh-');
    const { hub, ext } = await startHub(reqlensHome, { fs: { homedir: home, env: {} } });
    try {
      expect(await ext.nth('hello', 1)).toMatchObject({ features: ['fs', 'runs', 'shots'] });
      ext.sendHello();
      ext.send({ t: 'fs-list', id: 'q1', path: '~' });
      ext.send({ t: 'fs-list', id: 'bad id', path: '~' });
      ext.send({ t: 'fs-list', id: 'q2', path: '~/nope' });
      const listed = await ext.nth('fs-listed', 1);
      expect(listed).toMatchObject({ id: 'q1', path: home, entries: [{ name: 'proj', dir: true, hidden: false, git: true, project: true }] });
      expect(await ext.nth('fs-error', 1)).toMatchObject({ id: 'q2', error: expect.stringContaining('No such directory') });
      expect(ext.of('fs-listed').concat(ext.of('fs-error') as never[]).map((m) => m.id)).not.toContain('bad id');
    } finally {
      await hub.stop();
      removeDir(reqlensHome);
    }
  });
});

describe('terminal environment', () => {
  it('never passes the folder chooser stub to claude', () => {
    const spawned: PtySpawnOptions[] = [];
    const proc: PtyProcess = { pid: 1, onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined };
    const sent: PtyFromHost[] = [];
    const manager = new PtyManager({
      send: (m) => sent.push(m),
      loadSpawn: () => (_file, _args, options) => {
        spawned.push(options);
        return proc;
      },
      env: { SHELL: '/bin/sh', REQLENS_FS_PICK_STUB: '/tmp', REQLENS_PTY_COMMAND: 'x' },
      platform: 'darwin',
      homedir: home,
    });
    manager.handle({ t: 'pty-open', id: 'p1', cwd: '~', cols: 80, rows: 24 });
    expect(sent[0]).toMatchObject({ t: 'pty-opened' });
    expect(spawned[0]!.env.REQLENS_FS_PICK_STUB).toBeUndefined();
    expect(spawned[0]!.env.REQLENS_PTY_COMMAND).toBeUndefined();
    manager.killAll();
  });
});
