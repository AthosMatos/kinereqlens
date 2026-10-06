// Loggers. The hub owns stdout for native messaging and the MCP server owns it for JSON-RPC, so neither may
// ever print there: the hub logs to $REQLENS_HOME/hub.log (rotated), the MCP server to stderr (Claude Code
// keeps it in its MCP logs). Logs carry message types, ids and sizes only — never captured request data.
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Hub log rotation threshold. */
export const LOG_MAX_BYTES = 1024 * 1024;

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function formatLine(level: LogLevel, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase()} ${message.replace(/[\r\n]+/g, ' ')}\n`;
}

/**
 * Append-only file logger; when the file would exceed `maxBytes` it is renamed to `<file>.1` (replacing the
 * previous one) and a new file is started. Logging never throws.
 */
export function createFileLogger(file: string, maxBytes: number = LOG_MAX_BYTES): Logger {
  let size = -1;
  const write = (level: LogLevel, message: string): void => {
    const line = formatLine(level, message);
    try {
      if (size < 0) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += bytes;
    } catch {
      size = -1;
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}

/** Logger writing `[prefix] LEVEL message` lines to stderr. */
export function createStderrLogger(prefix = 'reqlens-mcp', stream: NodeJS.WritableStream = process.stderr): Logger {
  const write = (level: LogLevel, message: string): void => {
    try {
      stream.write(`[${prefix}] ${level.toUpperCase()} ${message.replace(/[\r\n]+/g, ' ')}\n`);
    } catch {
      // stderr closed: nothing useful left to do.
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}

/**
 * Route console.* to `logger` so a stray console.log (ours or a dependency's) can never corrupt a stdout
 * that carries protocol bytes.
 */
export function redirectConsole(logger: Logger): void {
  const join = (args: unknown[]): string => args.map((arg) => (typeof arg === 'string' ? arg : safeString(arg))).join(' ');
  console.log = (...args: unknown[]) => logger.info(join(args));
  console.info = (...args: unknown[]) => logger.info(join(args));
  console.debug = (...args: unknown[]) => logger.info(join(args));
  console.warn = (...args: unknown[]) => logger.warn(join(args));
  console.error = (...args: unknown[]) => logger.error(join(args));
}

function safeString(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
