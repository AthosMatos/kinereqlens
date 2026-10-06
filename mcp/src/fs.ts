// Folder browser of the embedded terminal, hub side (docs/CLAUDE_INTEGRATION.md "Working directory"): the
// overlay's new-session form asks for the sub-directories of a folder (`fs-list`), the OS-native folder chooser
// (`fs-pick`) and the git projects under the usual folders (`fs-projects`). Only directory names are ever read —
// never file contents —, every path is resolved and validated (`~` expansion, absolute, existing directory), and
// every answer stays far below the browser's 1 MB native message limit.
//
// These requests only come from clicks in the overlay panel (the worker relays nothing else); the hub still
// treats them as untrusted input.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FS_MAX_ENTRIES, FS_MAX_PROJECTS, FS_PICK_TIMEOUT_MS } from '../../src/shared/claude-protocol';
import type { FsEntry, FsFromHost, FsProject, FsToHost } from '../../src/shared/claude-protocol';
import { isFsName } from '../../src/shared/fs';
import { type Logger, silentLogger } from './log';
import { resolveCwd } from './pty';

/** Files that make a folder a project (besides `.git`). */
export const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'] as const;
/** Folders of the home directory scanned for git projects (≤ 2 levels deep). Case variants are deduplicated. */
export const PROJECT_ROOTS = ['Documents', 'Projects', 'projects', 'dev', 'code', 'Code', 'src', 'GitHub', 'github'] as const;
/** Never descended into while scanning for projects. */
const SCAN_SKIP = new Set(['node_modules', 'Library', 'vendor', 'target', 'dist', 'build', '__pycache__']);
/** Title of the native folder chooser. */
export const PICK_PROMPT = 'Choose a folder for Claude Code';
/** Test-only: `fs-pick` answers this path (or `cancel`) instead of opening a dialog. */
export const PICK_STUB_ENV = 'REQLENS_FS_PICK_STUB';

/** Bytes of entries / projects JSON per answer (the browser refuses host messages over 1 MB). */
const ANSWER_BUDGET_BYTES = 800_000;
/** Marker checks of a listing stop after this long (slow network drives): the names still come back. */
const MARKER_DEADLINE_MS = 3000;
const MARKER_BATCH = 64;
const SCAN_MAX_DIRS = 5000;
const SCAN_DEADLINE_MS = 10_000;
const SCAN_DEPTH = 2;
const PROJECTS_TTL_MS = 5 * 60_000;
const MAX_CONCURRENT_LISTS = 4;
const PICKER_MAX_OUTPUT = 64 * 1024;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
    if (code === 'ENOENT') return 'no such directory';
    if (code === 'ENOTDIR') return 'not a directory';
  }
  return err instanceof Error ? err.message : String(err);
}

function exists(file: string): Promise<boolean> {
  return fs.promises.lstat(file).then(
    () => true,
    () => false,
  );
}

function isDirectory(file: string): Promise<boolean> {
  return fs.promises.stat(file).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/** Sub-directories of `dir` (symlinks to directories included), names validated. */
async function subdirectories(dir: string, entries: fs.Dirent[]): Promise<string[]> {
  const out: string[] = [];
  const links: string[] = [];
  for (const entry of entries) {
    if (!isFsName(entry.name)) continue;
    if (entry.isDirectory()) out.push(entry.name);
    else if (entry.isSymbolicLink()) links.push(entry.name);
  }
  for (let i = 0; i < links.length; i += MARKER_BATCH) {
    const batch = links.slice(i, i + MARKER_BATCH);
    const dirs = await Promise.all(batch.map((name) => isDirectory(path.join(dir, name))));
    batch.forEach((name, j) => {
      if (dirs[j]) out.push(name);
    });
  }
  return out;
}

/** git / project markers of one folder. */
export async function folderKind(dir: string): Promise<{ git: boolean; project: boolean }> {
  const [git, ...markers] = await Promise.all([exists(path.join(dir, '.git')), ...PROJECT_MARKERS.map((m) => exists(path.join(dir, m)))]);
  return { git: git === true, project: git === true || markers.some(Boolean) };
}

export interface ListOptions {
  homedir: string;
  platform?: NodeJS.Platform;
  maxEntries?: number;
  budgetBytes?: number;
  markerDeadlineMs?: number;
}

export type Listing = Omit<Extract<FsFromHost, { t: 'fs-listed' }>, 't' | 'id'>;
export type ListResult = { ok: true; listing: Listing } | { ok: false; error: string };

/**
 * The sub-directories of `input` (absolute or `~/…`): visible ones first, then dot-folders, each sorted by name
 * (numeric, case-insensitive); at most `maxEntries`, git / project folders marked.
 */
export async function listDirectory(input: string, options: ListOptions): Promise<ListResult> {
  const resolved = resolveCwd(input, options.homedir, options.platform);
  if (!resolved.ok) return resolved;
  const dir = resolved.cwd;
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `Cannot read ${dir}: ${errorText(err)}` };
  }
  const names = await subdirectories(dir, dirents);
  const sorted = names
    .map((name) => ({ name, hidden: name.startsWith('.') }))
    .sort((a, b) => (a.hidden === b.hidden ? collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1) : a.hidden ? 1 : -1));
  const max = options.maxEntries ?? FS_MAX_ENTRIES;
  let truncated = sorted.length > max;
  const kept = sorted.slice(0, max);
  const deadline = Date.now() + (options.markerDeadlineMs ?? MARKER_DEADLINE_MS);
  const entries: FsEntry[] = [];
  let bytes = 0;
  const budget = options.budgetBytes ?? ANSWER_BUDGET_BYTES;
  for (let i = 0; i < kept.length; i += MARKER_BATCH) {
    const batch = kept.slice(i, i + MARKER_BATCH);
    const kinds = Date.now() < deadline ? await Promise.all(batch.map((e) => folderKind(path.join(dir, e.name)))) : batch.map(() => null);
    let full = false;
    for (let j = 0; j < batch.length; j++) {
      const { name, hidden } = batch[j]!;
      const entry: FsEntry = { name, dir: true, hidden };
      const kind = kinds[j];
      if (kind?.git) entry.git = true;
      if (kind?.project) entry.project = true;
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes > budget) {
        full = true;
        break;
      }
      entries.push(entry);
    }
    if (full) {
      truncated = true;
      break;
    }
  }
  const parent = path.dirname(dir);
  const listing: Listing = { path: dir, parent: parent === dir ? null : parent, entries, home: options.homedir, sep: path.sep === '\\' ? '\\' : '/' };
  if (truncated) listing.truncated = true;
  return { ok: true, listing };
}

export interface ScanOptions {
  roots?: readonly string[];
  maxProjects?: number;
  maxDirs?: number;
  deadlineMs?: number;
  budgetBytes?: number;
}

/** Git repositories at most two levels below the usual project folders of `homedir` (repos are not descended). */
export async function scanProjects(homedir: string, options: ScanOptions = {}): Promise<{ projects: FsProject[]; truncated: boolean }> {
  const roots = options.roots ?? PROJECT_ROOTS;
  const maxProjects = options.maxProjects ?? FS_MAX_PROJECTS;
  const maxDirs = options.maxDirs ?? SCAN_MAX_DIRS;
  const deadline = Date.now() + (options.deadlineMs ?? SCAN_DEADLINE_MS);
  const seen = new Set<string>();
  const found: FsProject[] = [];
  let visited = 0;
  let truncated = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= maxProjects || visited >= maxDirs || Date.now() > deadline) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = await fs.promises.realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    visited++;
    const kind = await folderKind(dir);
    if (kind.git) {
      const name = path.basename(dir);
      if (isFsName(name)) {
        const project: FsProject = { path: dir, name, git: true };
        const markers = await Promise.all(PROJECT_MARKERS.map((m) => exists(path.join(dir, m))));
        if (markers.some(Boolean)) project.project = true;
        found.push(project);
      }
      return;
    }
    if (depth >= SCAN_DEPTH) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const children = (await subdirectories(dir, dirents)).filter((name) => !name.startsWith('.') && !SCAN_SKIP.has(name)).sort(collator.compare);
    for (let i = 0; i < children.length; i += 16) {
      await Promise.all(children.slice(i, i + 16).map((name) => visit(path.join(dir, name), depth + 1)));
    }
  };

  for (const root of roots) {
    if (!isFsName(root)) continue;
    const dir = path.join(homedir, root);
    if (!(await isDirectory(dir))) continue;
    await visit(dir, 0);
  }
  found.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));
  const projects: FsProject[] = [];
  let bytes = 0;
  const budget = options.budgetBytes ?? ANSWER_BUDGET_BYTES;
  for (const project of found.slice(0, maxProjects)) {
    bytes += Buffer.byteLength(JSON.stringify(project)) + 1;
    if (bytes > budget) {
      truncated = true;
      break;
    }
    projects.push(project);
  }
  return { projects, truncated: truncated || found.length > maxProjects };
}

// -------------------------------------------------------------------------------------------- native chooser

/** How to run the OS-native folder chooser. Arguments are passed as argv (never through a shell). */
export interface PickerCommand {
  file: string;
  args: string[];
  /** Extra environment (Windows: the start folder, read by the script). */
  env?: Record<string, string>;
  /** Which chooser it is (for messages and exit code handling). */
  kind: 'osascript' | 'powershell' | 'zenity' | 'kdialog';
}

/** Find an executable on PATH (plus the usual system folders). */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? '').split(path.delimiter), '/usr/bin', '/usr/local/bin', '/bin'];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** PowerShell: a FolderBrowserDialog (needs -STA) owned by a topmost form; the start folder comes from the env. */
export const WINDOWS_PICK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  `$dialog.Description = '${PICK_PROMPT}'`,
  '$dialog.ShowNewFolderButton = $true',
  'if ($env:REQLENS_FS_PICK_START) { $dialog.SelectedPath = $env:REQLENS_FS_PICK_START }',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  '$owner.Dispose()',
].join('; ');

/** The native folder chooser command for `platform`, starting in `startPath` (an existing absolute folder). */
export function pickerCommand(
  platform: NodeJS.Platform,
  startPath: string,
  env: NodeJS.ProcessEnv,
  which: (name: string) => string | null = (name) => whichOnPath(name, env),
): { ok: true; command: PickerCommand } | { ok: false; error: string } {
  switch (platform) {
    case 'darwin':
      // `choose folder` with the start folder passed as argv (no AppleScript string escaping needed).
      return {
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
            startPath,
          ],
        },
      };
    case 'win32': {
      const root = env.SystemRoot || env.windir || 'C:\\Windows';
      return {
        ok: true,
        command: {
          kind: 'powershell',
          file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_PICK_SCRIPT],
          env: { REQLENS_FS_PICK_START: startPath },
        },
      };
    }
    default: {
      if (platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd' && platform !== 'netbsd') {
        return { ok: false, error: `No native folder chooser on ${platform} — browse the folders below` };
      }
      const zenity = which('zenity');
      if (zenity) {
        const start = startPath.endsWith('/') ? startPath : `${startPath}/`;
        return { ok: true, command: { kind: 'zenity', file: zenity, args: ['--file-selection', '--directory', `--title=${PICK_PROMPT}`, `--filename=${start}`] } };
      }
      const kdialog = which('kdialog');
      if (kdialog) {
        return { ok: true, command: { kind: 'kdialog', file: kdialog, args: ['--getexistingdirectory', startPath, '--title', PICK_PROMPT] } };
      }
      return { ok: false, error: 'No native folder chooser found (install zenity or kdialog) — browse the folders below' };
    }
  }
}

export interface PickerRun {
  /** Exit code (null when killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed by the timeout. */
  timedOut?: boolean;
}

/** What a chooser run means: the chosen folder, null (cancelled) or an error. */
export function interpretPickerRun(command: PickerCommand, run: PickerRun): { ok: true; path: string | null } | { ok: false; error: string } {
  if (run.timedOut) return { ok: false, error: 'The folder chooser was open too long and was closed' };
  const stderr = run.stderr.trim().split('\n')[0]?.slice(0, 300) ?? '';
  if (run.code !== 0) {
    if (command.kind === 'osascript' && /-128|cancel/i.test(run.stderr)) return { ok: true, path: null };
    if ((command.kind === 'zenity' || command.kind === 'kdialog') && run.code === 1) return { ok: true, path: null };
    return { ok: false, error: `The folder chooser failed${stderr ? `: ${stderr}` : run.code !== null ? ` (exit code ${run.code})` : ''}` };
  }
  const out = run.stdout.replace(/[\r\n]+$/, '');
  if (!out.trim()) return { ok: true, path: null };
  let chosen = out;
  // osascript ends folders with "/"; keep a root as is.
  while (chosen.length > 1 && /[\\/]$/.test(chosen) && !/^[A-Za-z]:\\$/.test(chosen)) chosen = chosen.slice(0, -1);
  return { ok: true, path: chosen };
}

/** Run a chooser (execFile, no shell) and collect its output; `cancel()` kills it. */
function runPickerProcess(command: PickerCommand, env: NodeJS.ProcessEnv, timeoutMs: number): { done: Promise<PickerRun>; cancel(): void } {
  let cancel = (): void => undefined;
  const done = new Promise<PickerRun>((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...env, ...(command.env ?? {}) };
    delete childEnv[PICK_STUB_ENV];
    const child = execFile(
      command.file,
      command.args,
      { env: childEnv, timeout: timeoutMs, maxBuffer: PICKER_MAX_OUTPUT, encoding: 'utf8', windowsHide: false },
      (err, stdout, stderr) => {
        const error = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (error && typeof error.code === 'string') {
          resolve({ code: null, stdout: '', stderr: `${command.file}: ${error.message}` });
          return;
        }
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: error?.killed === true && (error as { signal?: string }).signal === 'SIGTERM',
        });
      },
    );
    cancel = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
  });
  return { done, cancel: () => cancel() };
}

// -------------------------------------------------------------------------------------------- service

export interface FsServiceOptions {
  /** Deliver an answer to the extension. */
  send(message: FsFromHost): void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  logger?: Logger;
  /** Runs the native chooser (tests inject a fake). */
  runPicker?(command: PickerCommand, env: NodeJS.ProcessEnv): { done: Promise<PickerRun>; cancel(): void };
  which?(name: string): string | null;
  projectsTtlMs?: number;
  scan?: ScanOptions;
  pickTimeoutMs?: number;
}

/** Answers the folder browser requests of one hub. */
export class FsService {
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly homedir: string;
  private lists = 0;
  private picker: { id: string; cancel(): void } | null = null;
  private projects: { at: number; projects: FsProject[]; truncated: boolean } | null = null;
  private scanning: Promise<{ projects: FsProject[]; truncated: boolean }> | null = null;
  private stopped = false;

  constructor(private readonly options: FsServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.homedir = options.homedir ?? os.homedir();
  }

  /** A native chooser is open. */
  get picking(): boolean {
    return this.picker !== null;
  }

  /** Handle a validated request (answers asynchronously, never throws). */
  handle(message: FsToHost): void {
    const fail = (error: string): void => this.send({ t: 'fs-error', id: message.id, error });
    if (this.stopped) return fail('The kineReqLens bridge is stopping');
    const run = (): Promise<void> => {
      switch (message.t) {
        case 'fs-list':
          return this.list(message.id, message.path);
        case 'fs-pick':
          return this.pick(message.id, message.startPath);
        case 'fs-projects':
          return this.findProjects(message.id, message.refresh === true);
      }
    };
    run().catch((err: unknown) => {
      this.logger.warn(`${message.t} ${message.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      fail(`The folder browser failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Close an open chooser; refuse further requests. */
  stop(): void {
    this.stopped = true;
    this.picker?.cancel();
    this.picker = null;
  }

  private send(message: FsFromHost): void {
    if (this.stopped && message.t !== 'fs-error') return;
    this.options.send(message);
  }

  private async list(id: string, input: string): Promise<void> {
    if (this.lists >= MAX_CONCURRENT_LISTS) {
      this.send({ t: 'fs-error', id, error: 'Too many folder requests at once — try again' });
      return;
    }
    this.lists++;
    try {
      const result = await listDirectory(input, { homedir: this.homedir, platform: this.platform });
      if (!result.ok) {
        this.send({ t: 'fs-error', id, error: result.error });
        return;
      }
      this.logger.info(`fs-list ${id}: ${result.listing.entries.length} folders${result.listing.truncated ? ' (truncated)' : ''}`);
      this.send({ t: 'fs-listed', id, ...result.listing });
    } finally {
      this.lists--;
    }
  }

  private async pick(id: string, startPath: string | undefined): Promise<void> {
    if (this.picker) {
      this.send({ t: 'fs-error', id, error: 'The folder chooser is already open' });
      return;
    }
    const start = startPath ? resolveCwd(startPath, this.homedir, this.platform) : null;
    const startDir = start?.ok ? start.cwd : this.homedir;
    const stub = this.env[PICK_STUB_ENV]?.trim();
    if (stub) {
      // Test-only (docs/CLAUDE_INTEGRATION.md "Testing hook"): no dialog.
      if (stub === 'cancel') return this.send({ t: 'fs-picked', id, path: null });
      const chosen = resolveCwd(stub, this.homedir, this.platform);
      this.send(chosen.ok ? { t: 'fs-picked', id, path: chosen.cwd } : { t: 'fs-error', id, error: chosen.error });
      return;
    }
    const built = pickerCommand(this.platform, startDir, this.env, this.options.which);
    if (!built.ok) {
      this.send({ t: 'fs-error', id, error: built.error });
      return;
    }
    const command = built.command;
    const runner = this.options.runPicker ?? ((cmd, env) => runPickerProcess(cmd, env, this.options.pickTimeoutMs ?? FS_PICK_TIMEOUT_MS));
    const handle = runner(command, this.env);
    const picker = { id, cancel: handle.cancel };
    this.picker = picker;
    this.logger.info(`fs-pick ${id}: ${command.kind} opened`);
    let run: PickerRun;
    try {
      run = await handle.done;
    } finally {
      if (this.picker === picker) this.picker = null;
    }
    if (this.stopped) return;
    const result = interpretPickerRun(command, run);
    if (!result.ok) {
      this.logger.warn(`fs-pick ${id}: ${result.error}`);
      this.send({ t: 'fs-error', id, error: result.error });
      return;
    }
    if (result.path === null) {
      this.send({ t: 'fs-picked', id, path: null });
      return;
    }
    const chosen = resolveCwd(result.path, this.homedir, this.platform);
    this.send(chosen.ok ? { t: 'fs-picked', id, path: chosen.cwd } : { t: 'fs-error', id, error: chosen.error });
  }

  private async findProjects(id: string, refresh: boolean): Promise<void> {
    const ttl = this.options.projectsTtlMs ?? PROJECTS_TTL_MS;
    const cached = this.projects;
    let result: { projects: FsProject[]; truncated: boolean };
    if (!refresh && cached && Date.now() - cached.at < ttl) result = cached;
    else {
      if (!this.scanning) {
        const scanning = scanProjects(this.homedir, this.options.scan);
        this.scanning = scanning;
        scanning.then(
          (found) => {
            this.projects = { at: Date.now(), ...found };
          },
          () => undefined,
        );
        void scanning.finally(() => {
          if (this.scanning === scanning) this.scanning = null;
        }).catch(() => undefined);
      }
      result = await this.scanning;
      this.logger.info(`fs-projects ${id}: ${result.projects.length} found`);
    }
    const answer: FsFromHost = { t: 'fs-projects-listed', id, projects: result.projects, home: this.homedir };
    if (result.truncated) answer.truncated = true;
    this.send(answer);
  }
}
