// Command-line parsing for reqlens-mcp (no dependencies; small and strict).

export const COMMANDS = ['serve', 'native-host', 'install', 'uninstall', 'doctor'] as const;
export type Command = (typeof COMMANDS)[number];

const VALUE_FLAGS = new Set(['extension-id', 'browser', 'home', 'manifest-dir']);

export interface ParsedArgs {
  command: Command;
  help: boolean;
  version: boolean;
  /** Repeatable `--name value` / `--name=value` flags. */
  values: Map<string, string[]>;
}

export class UsageError extends Error {}

function isCommand(value: string): value is Command {
  return (COMMANDS as ReadonlyArray<string>).includes(value);
}

/**
 * Parse argv (without node and the script). The default command is `serve`. `native-host` ignores everything
 * after it: the browser appends the caller origin (and `--parent-window=…` on Windows).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: 'serve', help: false, version: false, values: new Map() };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v' || arg === '-V') {
      parsed.version = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq < 0 ? undefined : eq);
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option: --${name}`);
      let value: string | undefined;
      if (eq >= 0) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
      continue;
    }
    if (!commandSeen && isCommand(arg)) {
      parsed.command = arg;
      commandSeen = true;
      if (arg === 'native-host') return parsed;
      continue;
    }
    throw new UsageError(commandSeen ? `Unexpected argument: ${arg}` : `Unknown command: ${arg}`);
  }
  return parsed;
}

/** All values of a repeatable flag, comma lists split. */
export function listValue(parsed: ParsedArgs, name: string): string[] {
  return (parsed.values.get(name) ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The last value of a flag. */
export function singleValue(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.values.get(name);
  return values?.[values.length - 1];
}

export function helpText(version: string): string {
  return `reqlens-mcp ${version}: Claude Code bridge for the kineReqLens browser extension

Usage:
  reqlens-mcp [serve]        Run the MCP server on stdio (Claude Code spawns this; default command)
  reqlens-mcp native-host    Run the bridge hub (the browser spawns this through native messaging)
  reqlens-mcp install [--extension-id <id> ...] [--browser edge|chrome|chromium|brave|all]
                      [--home <dir>] [--manifest-dir <dir>]
                             Write the native host launcher and the browsers' native messaging manifests.
                             Allows the unpacked build's fixed id, every --extension-id and the ids existing
                             manifests already allow.
  reqlens-mcp uninstall [--browser ...] [--home <dir>] [--manifest-dir <dir>]
                             Remove the manifests (registry keys on Windows) and the launcher.
  reqlens-mcp doctor [--home <dir>] [--manifest-dir <dir>]
                             Check the installation and print fixes.
  reqlens-mcp --help | --version

Options:
  --extension-id <id>   Another kineReqLens extension id to allow (e.g. a store build; Settings → Claude Code
                        shows the id); repeatable. The unpacked build's id is always allowed.
  --browser <name>      edge, chrome, chromium, brave or all (default: every installed browser)
  --home <dir>          REQLENS_HOME to use (default: $REQLENS_HOME or ~/.reqlens)
  --manifest-dir <dir>  Write/check the manifest only in this NativeMessagingHosts directory

Environment:
  REQLENS_HOME          Bridge directory: hub socket, hub log (hub.log) and the native host launcher

Claude Code:
  claude mcp add --scope user reqlens -- node <path-to-reqlens>/mcp/dist/reqlens-mcp.mjs
  claude --dangerously-load-development-channels server:reqlens   (optional: push "Send to Claude Code" items)
`;
}
