// OWNER: mcp-server agent. Entry of mcp/dist/reqlens-mcp.mjs:
//   reqlens-mcp [serve]        stdio MCP server for Claude Code (default)
//   reqlens-mcp native-host    the hub, spawned by the browser through native messaging
//   reqlens-mcp install|uninstall|doctor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParsedArgs, UsageError, helpText, listValue, parseArgs, singleValue } from './args';
import { doctor } from './doctor';
import { Hub } from './hub';
import {
  type BrowserChoice,
  DEFAULT_EXTENSION_ID,
  type InstallContext,
  InstallError,
  install,
  stableNodePath,
  uninstall,
} from './install';
import { createFileLogger, redirectConsole } from './log';
import { BROWSER_FAMILIES, hubLogPath, reqlensHome } from './paths';
import { runServe } from './server';

const VERSION = __VERSION__;

/** Absolute path of this script (symlinks resolved), baked into the launcher and the hints. */
function scriptPath(): string {
  const file = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function homeFrom(parsed: ParsedArgs): string {
  const home = singleValue(parsed, 'home');
  return home ? path.resolve(home) : reqlensHome();
}

function browsersFrom(parsed: ParsedArgs): BrowserChoice[] {
  const browsers = listValue(parsed, 'browser');
  for (const browser of browsers) {
    if (browser !== 'all' && !(BROWSER_FAMILIES as ReadonlyArray<string>).includes(browser)) {
      throw new UsageError(`Unknown browser "${browser}" (use edge, chrome, chromium, brave or all)`);
    }
  }
  return browsers as BrowserChoice[];
}

function installContext(parsed: ParsedArgs): InstallContext {
  const manifestDir = singleValue(parsed, 'manifest-dir');
  return {
    home: homeFrom(parsed),
    browsers: browsersFrom(parsed),
    homedir: os.homedir(),
    platform: process.platform,
    env: process.env,
    nodePath: stableNodePath(process.execPath, process.env.PATH, process.platform),
    scriptPath: scriptPath(),
    out: (line) => process.stdout.write(`${line}\n`),
    ...(manifestDir ? { manifestDir: path.resolve(manifestDir) } : {}),
  };
}

/** The hub: stdout is native messaging only, logs go to $REQLENS_HOME/hub.log. Exits when the browser leaves. */
async function runNativeHost(parsed: ParsedArgs, callerArgs: string[]): Promise<void> {
  const home = homeFrom(parsed);
  const logger = createFileLogger(hubLogPath(home));
  redirectConsole(logger);
  logger.info(`native host ${VERSION} started (pid ${process.pid}, caller ${callerArgs.join(' ').slice(0, 200) || '?'})`);
  // mcp/dist/reqlens-mcp.mjs → the reqlens checkout (where `npm rebuild node-pty` fixes a broken node-pty).
  const repoDir = path.resolve(path.dirname(scriptPath()), '..', '..');
  const hub = new Hub({ home, input: process.stdin, output: process.stdout, version: VERSION, logger, pty: { repoDir } });
  // Terminals must never outlive the hub (stop() kills them too; this covers process.exit paths).
  process.on('exit', () => hub.ptys.killAll('hub exiting'));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void hub.stop(signal));
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught: ${err.stack ?? err.message}`);
    void hub.stop('uncaught exception');
  });
  const result = await hub.start();
  await hub.closed;
  const code = result.status === 'listening' ? 0 : 1;
  process.exitCode = code;
  // Let queued frames reach the browser before exiting (an empty write calls back after earlier ones).
  const exit = (): never => process.exit(code);
  setTimeout(exit, 1000).unref();
  process.stdout.write('', exit);
}

async function main(argv: string[]): Promise<number | null> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${helpText(VERSION)}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(helpText(VERSION));
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    switch (parsed.command) {
      case 'serve': {
        const home = singleValue(parsed, 'home');
        await runServe({
          version: VERSION,
          scriptPath: scriptPath(),
          env: home ? { ...process.env, REQLENS_HOME: path.resolve(home) } : process.env,
        });
        return null;
      }
      case 'native-host':
        await runNativeHost(parsed, argv.slice(argv.indexOf('native-host') + 1));
        return null;
      case 'install': {
        // The unpacked build's fixed id is always allowed; --extension-id adds more (e.g. a store build's id).
        install({ ...installContext(parsed), extensionIds: [DEFAULT_EXTENSION_ID, ...listValue(parsed, 'extension-id')] });
        return 0;
      }
      case 'uninstall':
        uninstall(installContext(parsed));
        return 0;
      case 'doctor': {
        const { browsers: _browsers, ...ctx } = installContext(parsed);
        return (await doctor(ctx)) ? 0 : 1;
      }
    }
  } catch (err) {
    if (err instanceof InstallError || err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return err instanceof UsageError ? 2 : 1;
    }
    process.stderr.write(`reqlens-mcp ${parsed.command} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
