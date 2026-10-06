#!/usr/bin/env node
// kineReqLens installer, shared by install.sh / install.ps1 (they first make sure Node.js 20+ and npm are there) and
// uninstall.sh / uninstall.ps1. See INSTALL.md.
//
//   node scripts/installer.mjs install   [--yes] [--with-claude | --no-claude] [--browser <name>] [--update] [--no-open] [--dry-run]
//   node scripts/installer.mjs uninstall [--yes] [--no-claude] [--browser <name>] [--dry-run]
//
// Only node: built-ins (it runs before `npm ci`). It never elevates (no sudo, no administrator prompt) and writes only
// to this checkout; the native messaging host is written by `reqlens-mcp install` ($REQLENS_HOME, the browsers'
// user-level NativeMessagingHosts folders or HKCU keys) and the Claude Code entry by `claude mcp add --scope user`.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const MIN_NODE_MAJOR = 20;
export const BROWSERS = ['edge', 'chrome', 'chromium', 'brave'];
const MCP_NAME = 'reqlens';
const NATIVE_HOST = 'com.reqlens.bridge';

/** The checkout (physical path: reqlens-mcp bakes its realpath into the launcher, the MCP entry must match). */
export const ROOT = realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * What the installer knows per browser family: display name, extensions page, where the browser lives (macOS app,
 * Linux command, Windows exe) and its profile folders (a profile folder alone also counts as installed).
 */
export const BROWSER_INFO = {
  edge: {
    name: 'Microsoft Edge',
    page: 'edge://extensions',
    macApps: ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary'],
    macProfiles: ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary'],
    linuxCommands: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev'],
    linuxProfiles: ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'],
    winExes: [
      ['ProgramFiles(x86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['ProgramFiles', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ],
    winProfile: 'Microsoft\\Edge\\User Data',
    registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  },
  chrome: {
    name: 'Google Chrome',
    page: 'chrome://extensions',
    macApps: ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Canary'],
    macProfiles: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary'],
    linuxCommands: ['google-chrome', 'google-chrome-stable', 'google-chrome-beta'],
    linuxProfiles: ['google-chrome', 'google-chrome-beta'],
    winExes: [
      ['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'],
      ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'],
      ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
    ],
    winProfile: 'Google\\Chrome\\User Data',
    registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  },
  chromium: {
    name: 'Chromium',
    page: 'chrome://extensions',
    macApps: ['Chromium'],
    macProfiles: ['Chromium'],
    linuxCommands: ['chromium', 'chromium-browser'],
    linuxProfiles: ['chromium'],
    winExes: [['LOCALAPPDATA', 'Chromium\\Application\\chrome.exe']],
    winProfile: 'Chromium\\User Data',
    registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  },
  brave: {
    name: 'Brave',
    page: 'brave://extensions',
    macApps: ['Brave Browser'],
    macProfiles: ['BraveSoftware/Brave-Browser'],
    linuxCommands: ['brave-browser', 'brave'],
    linuxProfiles: ['BraveSoftware/Brave-Browser'],
    winExes: [
      ['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['ProgramFiles(x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ],
    winProfile: 'BraveSoftware\\Brave-Browser\\User Data',
    registryKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Arguments

export class UsageError extends Error {}

/** Compact flag spelling (lower case, no dashes) → canonical name. Accepts --with-claude, -WithClaude, -withclaude. */
const FLAGS = {
  yes: 'yes',
  y: 'yes',
  help: 'help',
  h: 'help',
  '?': 'help',
  withclaude: 'with-claude',
  noclaude: 'no-claude',
  browser: 'browser',
  update: 'update',
  noopen: 'no-open',
  dryrun: 'dry-run',
  whatif: 'dry-run',
};

/** Flags each command accepts. */
const COMMAND_FLAGS = {
  install: ['yes', 'help', 'with-claude', 'no-claude', 'browser', 'update', 'no-open', 'dry-run'],
  uninstall: ['yes', 'help', 'no-claude', 'browser', 'dry-run'],
};

/** Canonical name of a flag argument ("--with-claude", "-WithClaude", "-y"), or null for a non-flag argument. */
export function flagName(arg) {
  if (!/^-{1,2}[^-]/.test(arg)) return null;
  const name = arg.replace(/^-+/, '').split(/[=:]/)[0].replace(/-/g, '').toLowerCase();
  return FLAGS[name] ?? `unknown:${arg.split(/[=:]/)[0]}`;
}

/**
 * Parse `[install|uninstall] [flags]`. `--browser` takes values as `--browser edge`, `--browser=edge,chrome`, repeated
 * flags, or several words (`-Browser edge chrome`, how PowerShell may pass an array).
 */
export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] === 'install' || args[0] === 'uninstall' ? args.shift() : 'install';
  const options = { command, yes: false, help: false, claude: null, browsers: [], update: false, open: true, dryRun: false };
  const allowed = COMMAND_FLAGS[command];
  const addBrowsers = (value) => {
    for (const name of value.split(/[\s,]+/).map((part) => part.trim().toLowerCase()).filter(Boolean)) {
      if (name !== 'all' && !BROWSERS.includes(name)) {
        throw new UsageError(`Unknown browser "${name}" (use edge, chrome, chromium, brave or all)`);
      }
      if (!options.browsers.includes(name)) options.browsers.push(name);
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = flagName(arg);
    if (flag === null) throw new UsageError(`Unexpected argument: ${arg}`);
    if (flag.startsWith('unknown:') || !allowed.includes(flag)) throw new UsageError(`Unknown option: ${arg.split(/[=:]/)[0]}`);
    const inline = /^[^=:]*[=:](.*)$/.exec(arg)?.[1];
    if (flag === 'browser') {
      if (inline) {
        addBrowsers(inline);
        continue;
      }
      let taken = 0;
      while (i + 1 < args.length && flagName(args[i + 1]) === null) {
        addBrowsers(args[++i]);
        taken += 1;
      }
      if (taken === 0) throw new UsageError('--browser needs a value: edge, chrome, chromium, brave or all');
      continue;
    }
    if (flag === 'yes') options.yes = true;
    else if (flag === 'help') options.help = true;
    else if (flag === 'with-claude') options.claude = true;
    else if (flag === 'no-claude') options.claude = false;
    else if (flag === 'update') options.update = true;
    else if (flag === 'no-open') options.open = false;
    else if (flag === 'dry-run') options.dryRun = true;
  }
  return options;
}

export function helpText(command) {
  if (command === 'uninstall') {
    return `kineReqLens uninstaller

Usage:
  macOS / Linux:  ./uninstall.sh [options]
  Windows:        powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1 [options]

Removes the native messaging host (launcher + browser manifests, HKCU keys on Windows), asks before removing the
"reqlens" MCP server from Claude Code, and shows how to remove the extension from the browser. Never deletes this
folder or $REQLENS_HOME (~/.reqlens).

Options:
  -y, --yes             Don't ask: remove the Claude Code entry too
      --no-claude       Leave the Claude Code entry alone
      --browser <name>  Only these browsers: edge, chrome, chromium, brave or all (default: all)
      --dry-run         Print the commands that would change something instead of running them
  -h, --help            This help

PowerShell spelling works too: -Yes -NoClaude -Browser edge -DryRun (-WhatIf) -Help.
`;
  }
  return `kineReqLens installer

Usage:
  macOS / Linux:  ./install.sh [options]
  Windows:        powershell -ExecutionPolicy Bypass -File .\\install.ps1 [options]
  Any OS:         npm run setup -- [options]      (Node.js already installed)

Installs the dependencies, builds the extension (dist/) and the Claude Code bridge, sets up the bridge (optional) and
shows how to load dist/ in the browser. Safe to run again; never uses sudo or an administrator prompt.

Options:
  -y, --yes             Don't ask, answer yes (Node.js itself is never installed without asking)
      --with-claude     Set up the Claude Code bridge (default: ask when \`claude\` is on PATH, else skip)
      --no-claude       Skip the Claude Code bridge
      --browser <name>  edge, chrome, chromium, brave or all; repeatable or comma-separated
                        (default: the installed ones, Edge first)
      --update          Update this checkout first (git pull --ff-only)
      --no-open         Don't open the browser or the file manager, don't touch the clipboard
      --dry-run         Print the commands that would change something instead of running them
  -h, --help            This help

PowerShell spelling works too: -Yes -WithClaude -NoClaude -Browser edge -Update -NoOpen -DryRun (-WhatIf) -Help.
Uninstall: ./uninstall.sh (Windows: uninstall.ps1). Details: INSTALL.md
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/unit/installer.test.ts)

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function exists(file) {
  return fs.existsSync(file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Absolute path of an executable on PATH (PATHEXT on Windows), or null. */
export function which(name, env = process.env, platform = process.platform) {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext.toLowerCase()}`);
      if (platform === 'win32' && ext === '' && !/\.[a-z0-9]+$/i.test(name)) continue;
      if (!isFile(candidate)) continue;
      if (platform !== 'win32') {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

/**
 * The node binary to register (same rule as reqlens-mcp install): a PATH entry that resolves to the running binary
 * (Homebrew's /opt/homebrew/bin/node survives upgrades, its versioned Cellar path does not), else `execPath`.
 */
export function stableNodePath(execPath, envPath, platform) {
  const target = realpath(execPath);
  if (!envPath) return execPath;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of envPath.split(platform === 'win32' ? ';' : ':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate) && realpath(candidate) === target) return candidate;
  }
  return execPath;
}

/** Chromium's extension id for a manifest "key": sha256 of the DER public key, first 32 hex digits mapped to a-p. */
export function extensionIdFromKey(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

/** Installed browsers in Edge-first order: [{ family, launch }] (launch: macOS app name, Linux command, Windows exe). */
export function detectBrowsers({ platform, env, homedir, exists: has = exists, which: find = (name) => which(name, env, platform) }) {
  const found = [];
  for (const family of BROWSERS) {
    const info = BROWSER_INFO[family];
    let launch = null;
    let profile = false;
    if (platform === 'darwin') {
      launch = info.macApps.find((app) => ['/Applications', path.join(homedir, 'Applications')].some((dir) => has(path.join(dir, `${app}.app`)))) ?? null;
      const support = path.join(homedir, 'Library', 'Application Support');
      profile = info.macProfiles.some((dir) => has(path.join(support, ...dir.split('/'))));
    } else if (platform === 'win32') {
      for (const [base, rel] of info.winExes) {
        const dir = env[base];
        if (dir && has(path.win32.join(dir, rel))) {
          launch = path.win32.join(dir, rel);
          break;
        }
      }
      const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
      profile = has(path.win32.join(localAppData, info.winProfile));
    } else {
      launch = info.linuxCommands.map((cmd) => find(cmd)).find(Boolean) ?? null;
      const config = env.XDG_CONFIG_HOME?.trim() || path.join(homedir, '.config');
      profile = info.linuxProfiles.some((dir) => has(path.join(config, ...dir.split('/'))));
    }
    if (launch || profile) found.push({ family, launch });
  }
  return found;
}

/**
 * Browsers to set up and the one to open: the requested families (Edge first; `all` = every family), else the
 * installed ones, else Edge.
 */
export function chooseBrowsers(requested, detected) {
  const installed = detected.map((browser) => browser.family);
  if (requested.length === 0) {
    const families = installed.length > 0 ? installed : ['edge'];
    return { families, primary: families[0] };
  }
  if (requested.includes('all')) return { families: [...BROWSERS], primary: installed[0] ?? 'edge' };
  const families = BROWSERS.filter((family) => requested.includes(family));
  return { families, primary: families[0] };
}

/**
 * Whether node_modules already matches package-lock.json (npm's own record of what it installed,
 * node_modules/.package-lock.json, has the same versions and every package is on disk), so `npm ci` can be skipped.
 */
export function depsUpToDate(root) {
  const lock = readJson(path.join(root, 'package-lock.json'));
  const installed = readJson(path.join(root, 'node_modules', '.package-lock.json'));
  const pkg = readJson(path.join(root, 'package.json'));
  if (!lock?.packages || !installed?.packages || !pkg) return false;
  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
    if (!lock.packages[`node_modules/${name}`]) return false; // package.json and the lockfile disagree: let npm ci say so
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const have = installed.packages[key];
    if (!have) {
      if (entry.optional || entry.devOptional) continue; // e.g. another platform's binary
      return false;
    }
    if (have.version !== entry.version) return false;
    if (entry.integrity && have.integrity && have.integrity !== entry.integrity) return false;
  }
  for (const key of Object.keys(installed.packages)) {
    if (key.startsWith('node_modules/') && !exists(path.join(root, key, 'package.json'))) return false;
  }
  return true;
}

/** `claude mcp add` arguments that register this checkout's MCP server (user scope). */
export function mcpAddArgs(nodePath, scriptPath, home) {
  return ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', nodePath, scriptPath, ...(home ? ['serve', '--home', home] : [])];
}

/** Command, args and scope of a `claude mcp get <name>` output. */
export function parseMcpGet(output) {
  const field = (name) => new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, 'm').exec(output)?.[1]?.trim() ?? null;
  const scope =
    /mcp remove\s+"?[^"\s]+"?\s+-s\s+(user|local|project)\b/.exec(output)?.[1] ??
    /^[ \t]*Scope:[ \t]*(user|local|project)\b/im.exec(output)?.[1]?.toLowerCase() ??
    null;
  return { command: field('Command'), args: field('Args'), scope };
}

/** Whether a registered entry runs exactly `nodePath args...`. */
export function sameMcpServer(parsed, nodePath, args) {
  return parsed.command === nodePath && (parsed.args ?? '') === args.join(' ');
}

/** The [warn] / [FAIL] lines (with their fix) and the summary line of `reqlens-mcp doctor`. */
export function doctorSummary(output) {
  const lines = output.split(/\r?\n/);
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\[(warn|FAIL)\]\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const problem = { level: match[1] === 'FAIL' ? 'fail' : 'warn', title: match[2], fix: null };
    for (let j = i + 1; j < lines.length && /^\s{4,}/.test(lines[j]); j++) {
      const fix = /^\s+fix:\s*(.*)$/.exec(lines[j]);
      if (fix) problem.fix = fix[1];
    }
    problems.push(problem);
  }
  const summary = lines.map((line) => line.trim()).find((line) => /^(No problems found\.|\d+ problems? found\.)$/.test(line)) ?? null;
  return { problems, summary };
}

/** Quote one argument for a cmd.exe command line (needed to run .cmd / .bat files such as npm.cmd). */
export function winQuote(arg) {
  if (arg !== '' && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** How to spawn `file args`: .cmd / .bat files go through cmd.exe (Node refuses to spawn them directly). */
export function commandSpec(file, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(winQuote).join(' ');
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

/** Build tools node-pty needs when it has to be compiled, per OS. */
export function buildToolsHint(platform, osRelease = '') {
  if (platform === 'darwin') return ['Install the Xcode Command Line Tools:  xcode-select --install'];
  if (platform === 'win32') {
    return [
      'Install Visual Studio Build Tools with the "Desktop development with C++" workload and Python 3',
      '(https://github.com/nodejs/node-gyp#on-windows), e.g.:  winget install Microsoft.VisualStudio.2022.BuildTools Python.Python.3.12',
    ];
  }
  const ids = `${/^ID=(.*)$/m.exec(osRelease)?.[1] ?? ''} ${/^ID_LIKE=(.*)$/m.exec(osRelease)?.[1] ?? ''}`.replace(/"/g, '');
  if (/\b(debian|ubuntu)\b/.test(ids)) return ['Install a C++ toolchain and Python 3:  sudo apt install build-essential python3'];
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return ['Install a C++ toolchain and Python 3:  sudo dnf install gcc-c++ make python3'];
  if (/\b(arch)\b/.test(ids)) return ['Install a C++ toolchain and Python 3:  sudo pacman -S --needed base-devel python'];
  if (/\b(suse|opensuse)\b/.test(ids)) return ['Install a C++ toolchain and Python 3:  sudo zypper install gcc-c++ make python3'];
  return ['Install a C++ toolchain (gcc/g++, make) and Python 3 with your package manager'];
}

/** A path for display: the home folder as ~. */
function tildify(file, homedir = os.homedir()) {
  if (!homedir) return file;
  if (file === homedir) return '~';
  return file.startsWith(homedir + path.sep) ? `~${file.slice(homedir.length)}` : file;
}

/** Every path under the home folder in a line of text, as ~/… */
function tildifyText(text, homedir = os.homedir()) {
  return homedir ? text.split(homedir + path.sep).join(`~${path.sep}`) : text;
}

// ---------------------------------------------------------------------------------------------------------------
// Output

function createUi(env = process.env, platform = process.platform) {
  const out = process.stdout;
  const color = Boolean(out.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
  const utf8 = platform !== 'win32' && /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  const ui = {
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    cyan: paint('36'),
    sym: utf8 ? { ok: '✓', warn: '!', fail: '✗', skip: '–', ask: '?' } : { ok: '+', warn: '!', fail: 'x', skip: '-', ask: '?' },
    total: 0,
    index: 0,
    warnings: [],
    line: (text = '') => out.write(`${text}\n`),
  };
  ui.step = (title) => {
    ui.index += 1;
    ui.line();
    ui.line(`${ui.bold(ui.cyan(`[${ui.index}/${ui.total}]`))} ${ui.bold(title)}`);
  };
  ui.ok = (text) => ui.line(`  ${ui.green(ui.sym.ok)} ${text}`);
  ui.info = (text) => ui.line(`  ${ui.dim(ui.sym.skip)} ${text}`);
  ui.warn = (text, remember = text) => {
    ui.line(`  ${ui.yellow(ui.sym.warn)} ${text}`);
    if (remember) ui.warnings.push(remember);
  };
  ui.fail = (text) => ui.line(`  ${ui.red(ui.sym.fail)} ${text}`);
  ui.detail = (text) => ui.line(`    ${ui.dim(text)}`);
  ui.cmd = (text) => ui.line(`  ${ui.dim(`$ ${text}`)}`);
  return ui;
}

/** A fatal, user-facing error: printed without a stack trace, exit code 1. */
class InstallerError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The run

class Installer {
  constructor(options, { env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
    this.opts = options;
    this.env = env;
    this.platform = platform;
    this.homedir = homedir;
    this.ui = createUi(env, platform);
    this.interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    this.nodePath = stableNodePath(process.execPath, env.PATH ?? env.Path, platform);
    this.script = path.join(ROOT, 'mcp', 'dist', 'reqlens-mcp.mjs');
    this.dist = path.join(ROOT, 'dist');
    const custom = env.REQLENS_HOME?.trim();
    this.reqlensHome = path.resolve(custom || path.join(homedir, '.reqlens'));
    // Only a non-default REQLENS_HOME is passed to the MCP server (the launcher bakes it in already).
    this.customHome = custom && this.reqlensHome !== path.resolve(homedir, '.reqlens') ? this.reqlensHome : null;
    const key = readJson(path.join(ROOT, 'static', 'manifest.json'))?.key;
    this.manifestKey = typeof key === 'string' ? key : null;
    this.extensionId = this.manifestKey ? extensionIdFromKey(this.manifestKey) : null;
  }

  /** Run a command. `mutates` commands are only printed with --dry-run. Never throws for a failing command. */
  run(file, args, { capture = false, mutates = false, show = null, cwd = ROOT, input, env, timeout } = {}) {
    if (show !== false) this.ui.cmd(show ?? [path.basename(file), ...args].join(' '));
    if (mutates && this.opts.dryRun) {
      this.ui.detail('(dry run: not executed)');
      return { code: 0, stdout: '', stderr: '', dry: true };
    }
    const spec = commandSpec(file, args, this.platform, this.env);
    const result = spawnSync(spec.file, spec.args, {
      cwd,
      env: env ?? this.env,
      input,
      timeout,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    const code = result.error ? 127 : (result.status ?? 1);
    return { code, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  }

  /** Run node itself (the running binary). */
  node(args, options = {}) {
    return this.run(process.execPath, args, { ...options, show: options.show ?? ['node', ...args.map((arg) => this.short(arg))].join(' ') });
  }

  /** Repo-relative path for display. */
  short(file) {
    if (!path.isAbsolute(file)) return file;
    const rel = path.relative(ROOT, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : tildify(file, this.homedir);
  }

  async ask(question, defaultYes) {
    const { ui } = this;
    const prefix = `  ${ui.cyan(ui.sym.ask)} ${question}`;
    if (this.opts.yes) {
      ui.line(`${prefix} ${ui.dim('yes (--yes)')}`);
      return true;
    }
    if (!this.interactive) {
      ui.line(`${prefix} ${ui.dim(`${defaultYes ? 'yes' : 'no'} (no terminal to ask)`)}`);
      return defaultYes;
    }
    for (;;) {
      const answer = (await prompt(`${prefix} ${ui.dim(defaultYes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
      if (answer === '') return defaultYes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  }

  // --- install -------------------------------------------------------------------------------------------------

  async install() {
    const { ui, opts } = this;
    // Set when an --update run restarted the (changed) installer: the update step already ran.
    const updated = this.env.REQLENS_INSTALLER_UPDATED === '1';
    ui.total = 6 + (opts.update || updated ? 1 : 0);
    if (updated) ui.index = 1;
    else ui.line(`${ui.bold('kineReqLens installer')}  ${ui.dim(tildify(ROOT, this.homedir))}${opts.dryRun ? ui.yellow('  (dry run)') : ''}`);
    if (opts.update && !updated) {
      const restarted = this.stepUpdate();
      if (restarted !== null) return restarted;
    }
    const browsers = this.stepPrerequisites();
    this.stepDependencies();
    const migrating = await this.stepBuildExtension();
    this.stepBuildBridge();
    await this.stepClaude(browsers);
    this.stepLoad(browsers, migrating);
    ui.line();
    if (opts.dryRun) ui.line(`${ui.bold('Dry run done:')} nothing was changed.`);
    else if (ui.warnings.length === 0) ui.line(`${ui.green(ui.bold('Done.'))} kineReqLens is ready to load from ${this.short(this.dist)}/`);
    else {
      ui.line(`${ui.yellow(ui.bold('Done, with warnings:'))}`);
      for (const warning of ui.warnings) ui.line(`  ${ui.yellow(ui.sym.warn)} ${warning}`);
    }
    return 0;
  }

  /** git pull --ff-only; restarts the installer when the pull changed it. Returns its exit code, or null to go on. */
  stepUpdate() {
    const { ui } = this;
    ui.step('Updating this checkout');
    const git = which('git', this.env, this.platform);
    if (!git) {
      ui.warn('git not found: not updated (install git, or download the new version yourself)');
      return null;
    }
    const top = this.run(git, ['rev-parse', '--show-toplevel'], { capture: true, show: false });
    if (top.code !== 0 || realpath(top.stdout.trim()) !== ROOT) {
      ui.warn('This folder is not a git clone: not updated');
      return null;
    }
    const head = () => this.run(git, ['rev-parse', 'HEAD'], { capture: true, show: false }).stdout.trim();
    const before = head();
    const pull = this.run(git, ['pull', '--ff-only'], { mutates: true, show: 'git pull --ff-only' });
    if (pull.code !== 0) {
      throw new InstallerError('git pull --ff-only failed', [
        'Local changes or a diverged branch? Check `git status`, then run the installer again.',
        'Or run it without --update to install the version you have.',
      ]);
    }
    const after = head();
    if (!before || before === after) {
      ui.ok('Already up to date');
      return null;
    }
    ui.ok(`Updated ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
    const changed = this.run(git, ['diff', '--quiet', before, after, '--', 'scripts/installer.mjs'], { capture: true, show: false });
    if (changed.code === 0) return null;
    // The installer itself changed: go on with the new one (same options, without --update).
    ui.info('The installer changed: continuing with the new version');
    const argv = process.argv.slice(2).filter((arg) => flagName(arg) !== 'update');
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'installer.mjs'), ...argv], {
      stdio: 'inherit',
      env: { ...this.env, REQLENS_INSTALLER_UPDATED: '1' },
    });
    return child.status ?? 1;
  }

  stepPrerequisites() {
    const { ui } = this;
    ui.step('Checking prerequisites');
    if (this.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
      if (this.env.SUDO_USER) throw new InstallerError('Do not run the installer with sudo.', ['Run it as your own user: it installs everything for that user.']);
      ui.warn('Running as root: kineReqLens is installed for root, not for your user account');
    }
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) {
      throw new InstallerError(`Node.js ${process.version} is too old: kineReqLens needs Node.js ${MIN_NODE_MAJOR} or newer.`, [
        'Run ./install.sh (Windows: install.ps1): it shows how to install a newer Node.js.',
      ]);
    }
    ui.ok(`Node.js ${process.version}  ${ui.dim(tildify(this.nodePath, this.homedir))}`);
    const npm = which('npm', this.env, this.platform);
    const npmVersion = npm ? this.run(npm, ['--version'], { capture: true, show: false }).stdout.trim() : '';
    if (!npmVersion) throw new InstallerError('npm not found.', ['npm comes with Node.js: reinstall Node.js, or install your distribution\'s "npm" package.']);
    this.npm = npm;
    ui.ok(`npm ${npmVersion}`);
    const git = which('git', this.env, this.platform);
    const gitVersion = git ? /\d+(\.\d+)+/.exec(this.run(git, ['--version'], { capture: true, show: false }).stdout)?.[0] : null;
    if (gitVersion) ui.ok(`git ${gitVersion}`);
    else ui.info('git not found (optional: only needed for --update)');
    this.claude = which('claude', this.env, this.platform);
    if (this.claude) ui.ok(`Claude Code  ${ui.dim(tildify(this.claude, this.homedir))}`);
    else ui.info('Claude Code not found (optional)');
    const detected = detectBrowsers({ platform: this.platform, env: this.env, homedir: this.homedir });
    const browsers = { ...chooseBrowsers(this.opts.browsers, detected), detected };
    const names = (families) => families.map((family) => BROWSER_INFO[family].name).join(', ');
    if (this.opts.browsers.length > 0) ui.ok(`Browsers: ${names(browsers.families)} ${ui.dim('(--browser)')}`);
    else if (detected.length > 0) ui.ok(`Browsers: ${names(browsers.families)}`);
    else ui.info('No supported browser found: assuming Microsoft Edge (Chrome, Chromium and Brave work too)');
    return browsers;
  }

  stepDependencies() {
    const { ui } = this;
    ui.step('Installing dependencies');
    const npmFlags = ['--no-audit', '--no-fund', '--include=dev'];
    if (!exists(path.join(ROOT, 'package-lock.json'))) {
      const result = this.run(this.npm, ['install', ...npmFlags], { mutates: true });
      if (result.code !== 0) throw this.npmError('npm install');
      ui.ok('Dependencies installed');
    } else if (depsUpToDate(ROOT)) {
      ui.ok('node_modules is up to date with package-lock.json (npm ci skipped)');
    } else {
      const result = this.run(this.npm, ['ci', ...npmFlags], { mutates: true });
      if (result.code !== 0) {
        // Usually a native build (node-pty, no prebuilt binary on Linux) without build tools: install everything
        // else without install scripts; only the embedded terminal needs node-pty.
        ui.warn('npm ci failed: retrying without install scripts (usually node-pty could not be compiled)', null);
        const retry = this.run(this.npm, ['ci', ...npmFlags, '--ignore-scripts'], { mutates: true });
        if (retry.code !== 0) throw this.npmError('npm ci');
      }
      ui.ok('Dependencies installed');
    }
    this.checkNodePty();
  }

  npmError(what) {
    const hints = ['Check your network connection and the npm messages above, then run the installer again.'];
    if (this.platform === 'win32') {
      hints.push('"EPERM" / "EBUSY": a running kineReqLens bridge keeps node-pty open. Turn Settings → Claude Code off (or close the browser) and retry.');
    }
    hints.push('Still failing? Delete the node_modules folder and run the installer again.');
    return new InstallerError(`${what} failed.`, hints);
  }

  /** node-pty (the embedded Claude terminal): exec bit, load + spawn test, rebuild, else explain. Never fatal. */
  checkNodePty() {
    const { ui } = this;
    if (this.opts.dryRun && !exists(path.join(ROOT, 'node_modules', 'node-pty'))) {
      ui.info('node-pty: checked after a real install');
      return;
    }
    this.fixSpawnHelper();
    let check = this.ptyCheck();
    if (check.code !== 0) {
      ui.warn(`node-pty does not work yet: ${errorLine(check.stderr || check.stdout) || `exit code ${check.code}`}`, null);
      const rebuild = this.run(this.npm, ['rebuild', 'node-pty'], { mutates: true });
      if (rebuild.code === 0 && !rebuild.dry) {
        this.fixSpawnHelper();
        check = this.ptyCheck();
      }
    }
    if (check.code === 0) {
      ui.ok('node-pty works (embedded Claude terminal)');
      return;
    }
    ui.warn('node-pty is not available: the embedded Claude terminal will not work (everything else does)', 'node-pty is not available: the embedded Claude terminal will not work');
    const osRelease = this.platform === 'linux' ? safeRead('/etc/os-release') : '';
    for (const line of buildToolsHint(this.platform, osRelease)) ui.detail(line);
    ui.detail('then run:  npm rebuild node-pty   (or run the installer again)');
    ui.detail('If npm says install scripts are blocked: npm approve-scripts node-pty, then npm rebuild node-pty');
  }

  /** Restore node-pty's spawn-helper exec bit (some installs drop it → "posix_spawnp failed"), like the hub does. */
  fixSpawnHelper() {
    if (this.platform === 'win32' || this.opts.dryRun) return;
    const pkg = path.join(ROOT, 'node_modules', 'node-pty');
    for (const rel of [path.join('prebuilds', `${process.platform}-${process.arch}`), path.join('build', 'Release'), path.join('build', 'Debug')]) {
      const file = path.join(pkg, rel, 'spawn-helper');
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && (stat.mode & 0o111) === 0) {
          fs.chmodSync(file, stat.mode | 0o755);
          this.ui.ok(`Made ${this.short(file)} executable`);
        }
      } catch {
        // Not there: nothing to fix.
      }
    }
  }

  /** Load node-pty and run a short-lived process in a pseudo-terminal, in a child node (a failed load cannot be retried in-process). */
  ptyCheck() {
    const code = [
      "const pty = require('node-pty');",
      "const win = process.platform === 'win32';",
      "const p = pty.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });",
      "const timer = setTimeout(() => { console.error('the test process did not exit'); process.exit(3); }, 15000);",
      'p.onExit((e) => { clearTimeout(timer); process.exit(e.exitCode === 0 ? 0 : 4); });',
    ].join('\n');
    return this.run(process.execPath, ['-e', code], { capture: true, show: false, timeout: 30_000 });
  }

  /** npm run build. Resolves whether a previous dist/ had another id (the browser will see a new extension). */
  async stepBuildExtension() {
    const { ui } = this;
    ui.step('Building the extension');
    const previous = readJson(path.join(this.dist, 'manifest.json'));
    const migrating = Boolean(previous && this.manifestKey && previous.key !== this.manifestKey);
    if (migrating) {
      ui.warn('dist/ was built without the fixed extension id. Once rebuilt, the browser sees kineReqLens as a new extension:', null);
      ui.detail('its settings, Setups and list rules stay with the old one. Before reloading it, export your Setups');
      ui.detail('(kineReqLens overlay → Setups → Export) — you can do that until you reload the extension or restart the browser.');
      if (!(await this.ask('Rebuild dist/ now?', true))) throw new InstallerError('Stopped: dist/ was not rebuilt.', ['Export your Setups, then run the installer again.']);
    }
    const result = this.run(this.npm, ['run', 'build'], { capture: true, mutates: true, show: 'npm run build' });
    if (result.code !== 0) {
      this.ui.line(result.stdout + result.stderr);
      throw new InstallerError('npm run build failed (see the output above).');
    }
    if (!result.dry) {
      const version = readJson(path.join(this.dist, 'manifest.json'))?.version;
      ui.ok(`Built ${this.short(this.dist)}/${version ? ` (kineReqLens ${version})` : ''}`);
    }
    if (this.extensionId) ui.detail(`extension id ${this.extensionId} (the same on every machine)`);
    return migrating;
  }

  stepBuildBridge() {
    const { ui } = this;
    ui.step('Building the Claude Code bridge');
    const result = this.run(this.npm, ['run', 'build:mcp'], { capture: true, mutates: true, show: 'npm run build:mcp' });
    if (result.code !== 0) {
      this.ui.line(result.stdout + result.stderr);
      throw new InstallerError('npm run build:mcp failed (see the output above).');
    }
    if (!result.dry) ui.ok(`Built ${this.short(this.script)}`);
  }

  /** Native messaging host + Claude Code MCP entry + doctor (optional). */
  async stepClaude(browsers) {
    const { ui, opts } = this;
    ui.step('Claude Code bridge');
    if (opts.claude === false) {
      ui.info('Skipped (--no-claude). Set it up later with: ./install.sh --with-claude');
      return;
    }
    if (opts.claude === null) {
      if (!this.claude) {
        ui.info('Skipped: Claude Code (`claude`) is not on PATH.');
        ui.detail('Install it (https://claude.com/claude-code), then run: ./install.sh --with-claude');
        ui.detail('(--with-claude also installs the local bridge the React Native support uses)');
        return;
      }
      ui.line(`  ${ui.dim('MCP server for Claude Code + the native messaging host (embedded terminal, Errors view, React Native)')}`);
      if (!(await this.ask('Set up the Claude Code bridge?', true))) {
        ui.info('Skipped. Set it up later with: ./install.sh --with-claude');
        return;
      }
    }

    // 1. Native messaging host: launcher in $REQLENS_HOME + manifest per browser (HKCU keys on Windows).
    const installArgs = [this.script, 'install', '--browser', browsers.families.join(',')];
    if (opts.dryRun && this.platform === 'win32') {
      for (const family of browsers.families) ui.detail(`would set ${BROWSER_INFO[family].registryKey}\\${NATIVE_HOST}`);
    }
    const host = this.node(installArgs, { capture: true, mutates: true });
    if (host.code !== 0) {
      ui.line(tildifyText((host.stderr || host.stdout).trim(), this.homedir));
      ui.warn('The native messaging host could not be installed (see above)');
      return;
    }
    const hostLines = host.stdout.split(/\r?\n/);
    const end = hostLines.indexOf('');
    for (const line of hostLines.slice(0, end < 0 ? hostLines.length : end)) ui.detail(tildifyText(line, this.homedir));
    if (!host.dry) ui.ok(`Native messaging host installed for ${browsers.families.map((family) => BROWSER_INFO[family].name).join(', ')}`);

    // 2. MCP server entry (user scope).
    const serverArgs = [this.script, ...(this.customHome ? ['serve', '--home', this.customHome] : [])];
    const addArgs = mcpAddArgs(this.nodePath, this.script, this.customHome);
    const manual = `claude ${addArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`;
    if (!this.claude) {
      ui.warn('`claude` is not on PATH: the MCP server was not registered', 'Claude Code MCP server not registered (`claude` not on PATH)');
      ui.detail(`After installing Claude Code, run:  ${manual}`);
    } else {
      await this.registerMcp(serverArgs, addArgs, manual);
    }

    // 3. doctor (read-only).
    if (opts.dryRun) {
      ui.detail('(dry run: doctor skipped)');
      return;
    }
    const doctor = this.node([this.script, 'doctor'], { capture: true });
    const { problems, summary } = doctorSummary(doctor.stdout);
    for (const problem of problems) {
      if (problem.level === 'warn' && problem.title.startsWith('Hub not running')) {
        // Expected right after an install: the browser starts the bridge once it is enabled there.
        ui.info('The bridge starts once enabled in the browser: kineReqLens overlay → Settings → Claude Code → Enable');
        continue;
      }
      const text = `doctor: ${tildifyText(problem.title, this.homedir)}`;
      if (problem.level === 'fail') ui.fail(text);
      else ui.line(`  ${ui.yellow(ui.sym.warn)} ${text}`);
      if (problem.fix) ui.detail(`fix: ${tildifyText(problem.fix, this.homedir)}`);
    }
    if (doctor.code === 0) ui.ok(`doctor: ${summary ?? 'no problems found'}`);
    else ui.warn(`doctor: ${summary ?? 'problems found'} (run: node mcp/dist/reqlens-mcp.mjs doctor)`, 'reqlens-mcp doctor found problems (see above)');
  }

  async registerMcp(serverArgs, addArgs, manual) {
    const { ui } = this;
    const runClaude = (args, options = {}) =>
      this.run(this.claude, args, { capture: true, cwd: this.homedir, timeout: 120_000, show: `claude ${args.join(' ')}`, ...options });
    const current = runClaude(['mcp', 'get', MCP_NAME], { show: false });
    if (current.code === 0) {
      const parsed = parseMcpGet(current.stdout);
      if (sameMcpServer(parsed, this.nodePath, serverArgs)) {
        ui.ok(`Claude Code MCP server "${MCP_NAME}" already registered (${parsed.scope ?? 'user'} scope)`);
        return;
      }
      ui.warn(`Claude Code already has an MCP server "${MCP_NAME}" (${parsed.scope ?? 'unknown'} scope) that runs something else:`, null);
      ui.detail(parsed.command ? `${parsed.command} ${parsed.args ?? ''}`.trim() : firstLine(current.stdout));
      if (!(await this.ask(`Replace it with this checkout's server?`, true))) {
        ui.warn(`Kept the existing "${MCP_NAME}" MCP server`, `Claude Code keeps its existing "${MCP_NAME}" MCP server (not this checkout)`);
        return;
      }
      const removed = runClaude(['mcp', 'remove', MCP_NAME, '-s', parsed.scope ?? 'user'], { mutates: true });
      if (removed.code !== 0) {
        ui.warn(`Could not remove it: ${firstLine(removed.stderr || removed.stdout)}`, 'Claude Code MCP server not registered');
        ui.detail(`Remove it yourself (claude mcp remove ${MCP_NAME} -s <scope>), then run:  ${manual}`);
        return;
      }
    }
    const added = runClaude(addArgs, { mutates: true, show: manual });
    if (added.code !== 0) {
      ui.warn(`claude mcp add failed: ${firstLine(added.stderr || added.stdout)}`, 'Claude Code MCP server not registered');
      ui.detail(`Run it yourself:  ${manual}`);
      return;
    }
    if (!added.dry) ui.ok(`Registered the MCP server "${MCP_NAME}" with Claude Code (user scope)`);
  }

  stepLoad(browsers, migrating) {
    const { ui } = this;
    const primary = BROWSER_INFO[browsers.primary];
    ui.step(`Load kineReqLens in ${primary.name}`);
    const gui = this.guiAllowed();
    const copied = gui && this.copyToClipboard(this.dist);
    if (migrating) ui.line(`  ${ui.yellow(ui.sym.warn)} First remove the old kineReqLens card (it has another id) — after exporting your Setups.`);
    ui.line(`  1. Open ${ui.bold(primary.page)}`);
    ui.line(`  2. Turn on ${ui.bold('Developer mode')}`);
    ui.line(`  3. Click ${ui.bold('Load unpacked')}`);
    ui.line(`  4. Select ${ui.bold(this.dist)}${copied ? ui.dim('   (copied to the clipboard)') : ''}`);
    const pasteTip = {
      darwin: 'in the folder dialog press Cmd+Shift+G and paste',
      linux: 'in the folder dialog press Ctrl+L and paste',
      win32: 'paste it into the address bar of the folder dialog',
    }[this.platform];
    if (copied && pasteTip) ui.detail(`Tip: ${pasteTip}`);
    if (this.extensionId) ui.detail(`The card shows ID ${this.extensionId}.`);
    for (const family of browsers.families) {
      if (family !== browsers.primary) ui.detail(`Same steps in ${BROWSER_INFO[family].name}: ${BROWSER_INFO[family].page}`);
    }
    if (this.opts.dryRun && this.opts.open) ui.detail(`(dry run: would copy the path, open ${primary.page} and show dist/ in the file manager)`);
    if (gui) {
      const launch = browsers.detected.find((browser) => browser.family === browsers.primary)?.launch ?? null;
      const opened = this.openExtensionsPage(browsers.primary, launch);
      const revealed = this.revealFolder(this.dist);
      const done = [opened ? `opened ${primary.page}` : null, revealed ? 'showed dist/ in the file manager' : null].filter(Boolean);
      if (done.length > 0) ui.detail(`(${done.join(', ')})`);
    }
    ui.line();
    ui.line(`  ${ui.dim('After an update (./install.sh --update): click the reload icon on the kineReqLens card, then turn')}`);
    ui.line(`  ${ui.dim('Settings → Claude Code off and on to restart the bridge.')}`);
  }

  guiAllowed() {
    if (!this.opts.open || this.opts.dryRun) return false;
    if (this.env.SSH_CONNECTION || this.env.SSH_TTY) return false;
    if (this.platform === 'linux' && !this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return false;
    return true;
  }

  /** Best effort; true when a clipboard tool accepted the text. */
  copyToClipboard(text) {
    const tryRun = (file, args, extraEnv) => {
      if (!file) return false;
      const result = spawnSync(file, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000, windowsHide: true, env: { ...this.env, ...extraEnv } });
      return !result.error && result.status === 0;
    };
    const find = (name) => which(name, this.env, this.platform);
    if (this.platform === 'darwin') return tryRun(find('pbcopy'), []);
    if (this.platform === 'win32') {
      return tryRun(find('powershell.exe') ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:REQLENS_CLIPBOARD'], { REQLENS_CLIPBOARD: text });
    }
    if (this.env.WAYLAND_DISPLAY && tryRun(find('wl-copy'), [])) return true;
    return tryRun(find('xclip'), ['-selection', 'clipboard']) || tryRun(find('xsel'), ['--clipboard', '--input']);
  }

  /** Best effort, never waits for the browser. */
  openExtensionsPage(family, launch) {
    const info = BROWSER_INFO[family];
    if (this.platform === 'darwin') {
      const app = launch ?? info.macApps[0];
      const result = spawnSync(which('open', this.env, this.platform) ?? '/usr/bin/open', ['-a', app, info.page], { stdio: 'ignore', timeout: 15_000 });
      return !result.error && result.status === 0;
    }
    if (this.platform === 'win32') {
      const exe = launch ?? { edge: 'msedge', chrome: 'chrome', brave: 'brave' }[family];
      if (!exe) return false;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:REQLENS_OPEN_FILE -ArgumentList $env:REQLENS_OPEN_ARG'], {
        stdio: 'ignore',
        timeout: 15_000,
        windowsHide: true,
        env: { ...this.env, REQLENS_OPEN_FILE: exe, REQLENS_OPEN_ARG: info.page },
      });
      return !result.error && result.status === 0;
    }
    return launch ? detached(launch, [info.page], this.env) : false;
  }

  revealFolder(dir) {
    if (this.platform === 'darwin') {
      const result = spawnSync(which('open', this.env, this.platform) ?? '/usr/bin/open', ['-R', dir], { stdio: 'ignore', timeout: 15_000 });
      return !result.error && result.status === 0;
    }
    if (this.platform === 'win32') {
      // explorer.exe exits with 1 even when it worked.
      const result = spawnSync('explorer.exe', [`/select,"${dir}"`], { stdio: 'ignore', timeout: 15_000, windowsVerbatimArguments: true });
      return !result.error;
    }
    const opener = which('xdg-open', this.env, this.platform);
    return opener ? detached(opener, [path.dirname(dir)], this.env) : false;
  }

  // --- uninstall -----------------------------------------------------------------------------------------------

  async uninstall() {
    const { ui, opts } = this;
    ui.total = 3;
    ui.line(`${ui.bold('kineReqLens uninstaller')}  ${ui.dim(tildify(ROOT, this.homedir))}${opts.dryRun ? ui.yellow('  (dry run)') : ''}`);

    ui.step('Removing the native messaging host');
    this.npm = which('npm', this.env, this.platform);
    if (!exists(this.script) && this.npm && exists(path.join(ROOT, 'node_modules', 'esbuild'))) {
      this.run(this.npm, ['run', 'build:mcp'], { capture: true, mutates: true, show: 'npm run build:mcp' });
    }
    if (!exists(this.script) && !opts.dryRun) {
      ui.warn('mcp/dist/reqlens-mcp.mjs is missing and cannot be built here: remove the files yourself (INSTALL.md → Uninstalling)');
    } else {
      const browserArgs = opts.browsers.length > 0 ? ['--browser', opts.browsers.join(',')] : [];
      if (opts.dryRun && this.platform === 'win32') {
        const families = opts.browsers.length === 0 || opts.browsers.includes('all') ? BROWSERS : opts.browsers;
        for (const family of families) ui.detail(`would delete ${BROWSER_INFO[family].registryKey}\\${NATIVE_HOST}`);
      }
      const result = this.node([this.script, 'uninstall', ...browserArgs], { capture: true, mutates: true });
      for (const line of result.stdout.split(/\r?\n/).filter((text) => text && !text.startsWith('Also remove the MCP server'))) {
        ui.detail(tildifyText(line, this.homedir));
      }
      if (result.code !== 0) ui.warn(`reqlens-mcp uninstall failed: ${firstLine(result.stderr) || `exit code ${result.code}`}`);
      else if (!result.dry && !result.stdout.includes('Nothing to remove')) ui.ok('Native messaging host removed');
    }

    ui.step('Claude Code MCP server');
    const claude = which('claude', this.env, this.platform);
    if (opts.claude === false) ui.info('Left alone (--no-claude)');
    else if (!claude) ui.info(`Claude Code not found. If you registered the server elsewhere: claude mcp remove ${MCP_NAME} -s user`);
    else {
      const runClaude = (args, options = {}) => this.run(claude, args, { capture: true, cwd: this.homedir, timeout: 120_000, show: `claude ${args.join(' ')}`, ...options });
      const current = runClaude(['mcp', 'get', MCP_NAME], { show: false });
      if (current.code !== 0) ui.ok(`No "${MCP_NAME}" MCP server registered`);
      else {
        const parsed = parseMcpGet(current.stdout);
        ui.detail(parsed.command ? `${parsed.command} ${parsed.args ?? ''}`.trim() : firstLine(current.stdout));
        if (await this.ask(`Remove the "${MCP_NAME}" MCP server from Claude Code (${parsed.scope ?? 'user'} scope)?`, true)) {
          const removed = runClaude(['mcp', 'remove', MCP_NAME, '-s', parsed.scope ?? 'user'], { mutates: true });
          if (removed.code !== 0) ui.warn(`claude mcp remove failed: ${firstLine(removed.stderr || removed.stdout)}`);
          else if (!removed.dry) ui.ok(`Removed the "${MCP_NAME}" MCP server`);
        } else ui.info('Kept');
      }
    }

    ui.step('Remove the extension from the browser');
    const detected = detectBrowsers({ platform: this.platform, env: this.env, homedir: this.homedir });
    const families = detected.length > 0 ? detected.map((browser) => browser.family) : ['edge'];
    for (const family of families) ui.line(`  ${BROWSER_INFO[family].name}: open ${ui.bold(BROWSER_INFO[family].page)} → kineReqLens → ${ui.bold('Remove')}`);
    ui.line();
    ui.line(`  ${ui.dim('Left in place (delete them yourself if you no longer need them):')}`);
    ui.detail(`${tildify(ROOT, this.homedir)}  (this checkout)`);
    ui.detail(`${tildify(this.reqlensHome, this.homedir)}  (bridge log, screenshots, React Native pairing token)`);
    ui.line();
    ui.line(ui.warnings.length === 0 ? ui.green(ui.bold('Done.')) : ui.yellow(ui.bold('Done, with warnings (see above).')));
    return 0;
  }
}

function firstLine(text) {
  return (text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

/** The message line of a node error output ("Error: Cannot find module …"), else its first line. */
function errorLine(text) {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => /^([A-Z]\w*)?Error\b/.test(line)) ?? firstLine(text);
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Start a GUI program without waiting for it (or failing when it is missing). */
function detached(file, args, env) {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      process.exit(130);
    });
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\nRun with --help to see the options.\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(helpText(options.command));
    return 0;
  }
  const installer = new Installer(options);
  try {
    return options.command === 'uninstall' ? await installer.uninstall() : await installer.install();
  } catch (err) {
    if (!(err instanceof InstallerError)) throw err;
    const { ui } = installer;
    ui.line();
    ui.fail(ui.bold(err.message));
    for (const hint of err.hints) ui.detail(hint);
    return 1;
  }
}

if (process.argv[1] && realpath(path.resolve(process.argv[1])) === realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`kineReqLens installer failed: ${err?.stack ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
