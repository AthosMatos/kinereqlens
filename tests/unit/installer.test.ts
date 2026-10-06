// scripts/installer.mjs (the logic behind install.sh / install.ps1): argument spellings, browser detection per OS,
// the npm ci shortcut, the Claude Code MCP entry and doctor parsing, Windows command lines. Pure functions only; the
// whole installer runs end to end in INSTALL.md's manual test (temp HOME).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_ID_UNPACKED } from '../../src/shared/constants';

type Family = 'edge' | 'chrome' | 'chromium' | 'brave';
interface Options {
  command: 'install' | 'uninstall';
  yes: boolean;
  help: boolean;
  claude: boolean | null;
  browsers: string[];
  update: boolean;
  open: boolean;
  dryRun: boolean;
}
interface Detected {
  family: Family;
  launch: string | null;
}
interface InstallerModule {
  BROWSERS: Family[];
  UsageError: new (message: string) => Error;
  parseArgs(argv: string[]): Options;
  flagName(arg: string): string | null;
  helpText(command: string): string;
  which(name: string, env: Record<string, string>, platform: string): string | null;
  extensionIdFromKey(key: string): string;
  detectBrowsers(ctx: {
    platform: string;
    env: Record<string, string>;
    homedir: string;
    exists: (file: string) => boolean;
    which?: (name: string) => string | null;
  }): Detected[];
  chooseBrowsers(requested: string[], detected: Detected[]): { families: Family[]; primary: Family };
  depsUpToDate(root: string): boolean;
  mcpAddArgs(nodePath: string, scriptPath: string, home: string | null): string[];
  parseMcpGet(output: string): { command: string | null; args: string | null; scope: string | null };
  sameMcpServer(parsed: { command: string | null; args: string | null }, nodePath: string, args: string[]): boolean;
  doctorSummary(output: string): { problems: Array<{ level: string; title: string; fix: string | null }>; summary: string | null };
  winQuote(arg: string): string;
  commandSpec(file: string, args: string[], platform: string, env: Record<string, string>): { file: string; args: string[]; verbatim: boolean };
  buildToolsHint(platform: string, osRelease?: string): string[];
}
interface FsModule {
  readFileSync(path: URL, encoding: 'utf8'): string;
  mkdtempSync(prefix: string): string;
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string, options?: { mode: number }): void;
  rmSync(path: string, options: { recursive: true; force: true }): void;
}
interface OsModule {
  tmpdir(): string;
}

const specifiers = { installer: '../../scripts/installer.mjs', fs: 'node:fs', os: 'node:os' };
const installer = (await import(/* @vite-ignore */ specifiers.installer)) as InstallerModule;
const fs = (await import(/* @vite-ignore */ specifiers.fs)) as FsModule;
const os = (await import(/* @vite-ignore */ specifiers.os)) as OsModule;

const defaults: Options = { command: 'install', yes: false, help: false, claude: null, browsers: [], update: false, open: true, dryRun: false };

describe('arguments', () => {
  it('defaults to install with nothing set', () => {
    expect(installer.parseArgs([])).toEqual(defaults);
    expect(installer.parseArgs(['install'])).toEqual(defaults);
    expect(installer.parseArgs(['uninstall']).command).toBe('uninstall');
  });

  it('accepts GNU and PowerShell spellings alike', () => {
    const gnu = installer.parseArgs(['install', '--yes', '--with-claude', '--update', '--no-open', '--dry-run']);
    const ps = installer.parseArgs(['install', '-Yes', '-WithClaude', '-Update', '-NoOpen', '-DryRun']);
    const expected = { ...defaults, yes: true, claude: true, update: true, open: false, dryRun: true };
    expect(gnu).toEqual(expected);
    expect(ps).toEqual(expected);
    expect(installer.parseArgs(['-y', '-noclaude', '-WhatIf'])).toEqual({ ...defaults, yes: true, claude: false, dryRun: true });
    expect(installer.parseArgs(['-h']).help).toBe(true);
    expect(installer.parseArgs(['-Help']).help).toBe(true);
    expect(installer.flagName('edge')).toBeNull();
  });

  it('reads browsers as values, comma lists, repeats and several words (PowerShell arrays)', () => {
    expect(installer.parseArgs(['--browser', 'edge']).browsers).toEqual(['edge']);
    expect(installer.parseArgs(['--browser=chrome,edge']).browsers).toEqual(['chrome', 'edge']);
    expect(installer.parseArgs(['--browser', 'chrome', '--browser', 'Brave']).browsers).toEqual(['chrome', 'brave']);
    expect(installer.parseArgs(['-Browser', 'edge', 'chromium', '-Yes']).browsers).toEqual(['edge', 'chromium']);
    expect(installer.parseArgs(['-Browser', 'edge chrome']).browsers).toEqual(['edge', 'chrome']);
    expect(installer.parseArgs(['--browser', 'all']).browsers).toEqual(['all']);
  });

  it('rejects unknown options, browsers and stray words', () => {
    expect(() => installer.parseArgs(['--force'])).toThrow(/Unknown option: --force/);
    expect(() => installer.parseArgs(['--browser', 'netscape'])).toThrow(/Unknown browser "netscape"/);
    expect(() => installer.parseArgs(['--browser'])).toThrow(/--browser needs a value/);
    expect(() => installer.parseArgs(['--browser', '--yes'])).toThrow(/--browser needs a value/);
    expect(() => installer.parseArgs(['now'])).toThrow(/Unexpected argument: now/);
    expect(() => installer.parseArgs(['uninstall', '--update'])).toThrow(/Unknown option: --update/);
    expect(() => installer.parseArgs(['uninstall', '--with-claude'])).toThrow(installer.UsageError);
  });

  it('documents every option in the help', () => {
    const help = installer.helpText('install');
    for (const flag of ['--yes', '--with-claude', '--no-claude', '--browser', '--update', '--no-open', '--dry-run', '--help']) expect(help).toContain(flag);
    expect(installer.helpText('uninstall')).toContain('--no-claude');
  });
});

describe('extension id', () => {
  it('derives the fixed unpacked id from static/manifest.json "key"', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../static/manifest.json', import.meta.url), 'utf8')) as { key: string };
    expect(installer.extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID_UNPACKED);
  });
});

describe('browsers', () => {
  const only = (files: string[]) => (file: string) => files.includes(file);

  it('finds macOS apps and profile folders, Edge first', () => {
    const detected = installer.detectBrowsers({
      platform: 'darwin',
      env: {},
      homedir: '/Users/me',
      exists: only(['/Applications/Google Chrome.app', '/Users/me/Applications/Microsoft Edge Beta.app', '/Users/me/Library/Application Support/BraveSoftware/Brave-Browser']),
    });
    expect(detected).toEqual([
      { family: 'edge', launch: 'Microsoft Edge Beta' },
      { family: 'chrome', launch: 'Google Chrome' },
      { family: 'brave', launch: null },
    ]);
  });

  it('finds Linux commands and profile folders (XDG_CONFIG_HOME)', () => {
    const detected = installer.detectBrowsers({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/xdg' },
      homedir: '/home/me',
      exists: only(['/xdg/chromium']),
      which: (name) => (name === 'google-chrome-stable' ? '/usr/bin/google-chrome-stable' : null),
    });
    expect(detected).toEqual([
      { family: 'chrome', launch: '/usr/bin/google-chrome-stable' },
      { family: 'chromium', launch: null },
    ]);
  });

  it('finds Windows executables and profiles under the usual folders', () => {
    const detected = installer.detectBrowsers({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      homedir: 'C:\\Users\\me',
      exists: only(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data']),
    });
    expect(detected).toEqual([
      { family: 'edge', launch: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
      { family: 'chrome', launch: null },
    ]);
  });

  it('chooses the requested browsers (Edge first), else the installed ones, else Edge', () => {
    const detected: Detected[] = [
      { family: 'chrome', launch: 'Google Chrome' },
      { family: 'brave', launch: null },
    ];
    expect(installer.chooseBrowsers([], detected)).toEqual({ families: ['chrome', 'brave'], primary: 'chrome' });
    expect(installer.chooseBrowsers([], [])).toEqual({ families: ['edge'], primary: 'edge' });
    expect(installer.chooseBrowsers(['brave', 'edge'], detected)).toEqual({ families: ['edge', 'brave'], primary: 'edge' });
    expect(installer.chooseBrowsers(['all'], detected)).toEqual({ families: installer.BROWSERS, primary: 'chrome' });
    expect(installer.chooseBrowsers(['all'], [])).toEqual({ families: installer.BROWSERS, primary: 'edge' });
  });
});

describe('npm ci shortcut', () => {
  let root: string;
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } },
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
      'node_modules/b': { version: '2.0.0', integrity: 'sha512-b', dev: true },
      'node_modules/@esbuild/linux-x64': { version: '0.25.0', optional: true },
    },
  };
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(`${root}/${file.split('/').slice(0, -1).join('/')}`, { recursive: true });
    fs.writeFileSync(`${root}/${file}`, JSON.stringify(value));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(`${os.tmpdir()}/rl-installer-`);
    write('package.json', { name: 'x', dependencies: { a: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
    write('package-lock.json', lock);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const installAll = (): void => {
    write('node_modules/.package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/a': lock.packages['node_modules/a'], 'node_modules/b': lock.packages['node_modules/b'] } });
    write('node_modules/a/package.json', { name: 'a', version: '1.0.0' });
    write('node_modules/b/package.json', { name: 'b', version: '2.0.0' });
  };

  it('skips npm ci only when node_modules matches the lockfile (other platforms\' optional packages aside)', () => {
    expect(installer.depsUpToDate(root)).toBe(false);
    installAll();
    expect(installer.depsUpToDate(root)).toBe(true);
  });

  it('runs npm ci after a lockfile change, a missing folder or a new dependency', () => {
    installAll();
    write('package-lock.json', { ...lock, packages: { ...lock.packages, 'node_modules/a': { version: '1.1.0', integrity: 'sha512-a2' } } });
    expect(installer.depsUpToDate(root)).toBe(false);
    write('package-lock.json', lock);
    fs.rmSync(`${root}/node_modules/b`, { recursive: true, force: true });
    expect(installer.depsUpToDate(root)).toBe(false);
    installAll();
    write('package.json', { name: 'x', dependencies: { a: '^1.0.0', c: '^1.0.0' }, devDependencies: { b: '^2.0.0' } });
    expect(installer.depsUpToDate(root)).toBe(false);
  });
});

describe('Claude Code MCP entry', () => {
  // The format of `claude mcp get <name>` (Claude Code 2.x).
  const getOutput = [
    'reqlens:',
    '  Scope: User config (available in all your projects)',
    '  Status: ✓ Connected',
    '  Type: stdio',
    '  Command: /opt/homebrew/bin/node',
    '  Args: /Users/me/reqlens/mcp/dist/reqlens-mcp.mjs',
    '',
    'To remove this server, run: claude mcp remove "reqlens" -s user',
  ].join('\n');

  it('registers node + the bundle in user scope (plus --home for a custom REQLENS_HOME)', () => {
    expect(installer.mcpAddArgs('/n/node', '/r/mcp.mjs', null)).toEqual(['mcp', 'add', '--scope', 'user', 'reqlens', '--', '/n/node', '/r/mcp.mjs']);
    expect(installer.mcpAddArgs('/n/node', '/r/mcp.mjs', '/tmp/rl')).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'reqlens',
      '--',
      '/n/node',
      '/r/mcp.mjs',
      'serve',
      '--home',
      '/tmp/rl',
    ]);
  });

  it('reads the command, args and scope of an existing entry', () => {
    const parsed = installer.parseMcpGet(getOutput);
    expect(parsed).toEqual({ command: '/opt/homebrew/bin/node', args: '/Users/me/reqlens/mcp/dist/reqlens-mcp.mjs', scope: 'user' });
    expect(installer.sameMcpServer(parsed, '/opt/homebrew/bin/node', ['/Users/me/reqlens/mcp/dist/reqlens-mcp.mjs'])).toBe(true);
    expect(installer.sameMcpServer(parsed, 'node', ['/Users/me/reqlens/mcp/dist/reqlens-mcp.mjs'])).toBe(false);
    expect(installer.sameMcpServer(parsed, '/opt/homebrew/bin/node', ['/elsewhere/reqlens-mcp.mjs'])).toBe(false);
    const local = installer.parseMcpGet(getOutput.replace('User config (available in all your projects)', 'Local config (private to you in this project)').replace('-s user', '-s local'));
    expect(local.scope).toBe('local');
    expect(installer.parseMcpGet('reqlens:\n  Scope: Project config (shared via .mcp.json)\n  Type: http\n  URL: http://x').scope).toBe('project');
  });
});

describe('doctor summary', () => {
  it('keeps the problems with their fix and the summary line', () => {
    const output = [
      'reqlens-mcp doctor (REQLENS_HOME=/u/.reqlens)',
      '[ok]   Node v22.11.0',
      '       /usr/bin/node',
      '[warn] Hub not running (no browser has the bridge enabled right now)',
      '       fix: open the browser, then kineReqLens overlay → Settings → Claude Code → Enable',
      '[FAIL] Launcher missing: /u/.reqlens/native-host',
      '       fix: re-run the installer: npm run mcp:install',
      '',
      '1 problem found.',
      'Claude Code: claude mcp add --scope user reqlens -- "/usr/bin/node" "/r/mcp.mjs"',
    ].join('\n');
    expect(installer.doctorSummary(output)).toEqual({
      problems: [
        { level: 'warn', title: 'Hub not running (no browser has the bridge enabled right now)', fix: 'open the browser, then kineReqLens overlay → Settings → Claude Code → Enable' },
        { level: 'fail', title: 'Launcher missing: /u/.reqlens/native-host', fix: 're-run the installer: npm run mcp:install' },
      ],
      summary: '1 problem found.',
    });
    expect(installer.doctorSummary('[ok]   x\n\nNo problems found.\n').summary).toBe('No problems found.');
  });
});

describe('Windows command lines', () => {
  it('runs .cmd files (npm.cmd, claude.cmd) through cmd.exe with quoted arguments', () => {
    expect(installer.winQuote('ci')).toBe('ci');
    expect(installer.winQuote('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(installer.winQuote('a&b')).toBe('"a&b"');
    expect(installer.winQuote('')).toBe('""');
    expect(installer.commandSpec('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'build'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" run build"'],
      verbatim: true,
    });
    expect(installer.commandSpec('C:\\Users\\me\\.local\\bin\\claude.exe', ['mcp', 'get', 'reqlens'], 'win32', {})).toEqual({
      file: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      args: ['mcp', 'get', 'reqlens'],
      verbatim: false,
    });
    expect(installer.commandSpec('/usr/bin/npm', ['ci'], 'linux', {}).verbatim).toBe(false);
  });
});

describe('PATH lookup', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(`${os.tmpdir()}/rl-which-`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds executables only', () => {
    fs.writeFileSync(`${dir}/tool`, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(`${dir}/data`, 'x', { mode: 0o644 });
    expect(installer.which('tool', { PATH: `relative:${dir}` }, 'darwin')).toBe(`${dir}/tool`);
    expect(installer.which('data', { PATH: dir }, 'darwin')).toBeNull();
    expect(installer.which('missing', { PATH: dir }, 'darwin')).toBeNull();
  });
});

describe('build tools hint', () => {
  it('names the toolchain per OS and Linux distribution', () => {
    expect(installer.buildToolsHint('darwin').join(' ')).toContain('xcode-select --install');
    expect(installer.buildToolsHint('win32').join(' ')).toContain('Visual Studio Build Tools');
    expect(installer.buildToolsHint('linux', 'ID=ubuntu\nID_LIKE=debian\n').join(' ')).toContain('build-essential');
    expect(installer.buildToolsHint('linux', 'ID="fedora"\n').join(' ')).toContain('dnf install gcc-c++');
    expect(installer.buildToolsHint('linux', 'ID=arch\n').join(' ')).toContain('base-devel');
    expect(installer.buildToolsHint('linux', '').join(' ')).toContain('Python 3');
  });
});
