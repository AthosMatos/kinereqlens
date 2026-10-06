/**
 * Embedded terminal helpers shared by the panel, the service worker and the hub (`reqlens-mcp native-host`):
 * strict validation of the `pty-*` messages (src/shared/claude-protocol.ts), output chunking that keeps every
 * native message far below Chromium's 1 MB host→browser limit, input splitting and the replay tail kept by the
 * worker so a reloaded panel can re-attach. Pure, no chrome.* / node APIs.
 */
import {
  PTY_DATA_CHUNK_CHARS,
  PTY_MAX_CWD_CHARS,
  PTY_MAX_DIM,
  PTY_MAX_ID_CHARS,
  PTY_MAX_INPUT_BYTES,
} from './claude-protocol';
import type { PtyFromHost, PtyToHost } from './claude-protocol';
import { MAX_RECENT_DIRS } from './constants';

/** Max chars of a `pty-error` message. */
export const PTY_MAX_ERROR_CHARS = 2000;
/** A `pty-data` chunk from the hub is refused above this (the hub sends ≤ PTY_DATA_CHUNK_CHARS). */
export const PTY_MAX_DATA_CHARS = 256 * 1024;
/** Output the worker keeps per terminal for a re-attaching panel (chars). */
export const PTY_REPLAY_CHARS = 200 * 1024;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ID_RE = /^[A-Za-z0-9_.:-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Terminal id: 1..PTY_MAX_ID_CHARS chars of [A-Za-z0-9_.:-]. */
export function isPtyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PTY_MAX_ID_CHARS && ID_RE.test(value);
}

/** Terminal columns / rows: an integer in 1..PTY_MAX_DIM. */
export function isPtyDim(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PTY_MAX_DIM;
}

/** A working directory as typed by the user (`~` allowed): non-blank, ≤ PTY_MAX_CWD_CHARS, no control chars. */
export function isPtyCwdInput(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= PTY_MAX_CWD_CHARS && !CONTROL_RE.test(value);
}

/** UTF-8 byte length of a string (lone surrogates count as the 3-byte replacement character). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Split terminal output into chunks of at most `maxChars` UTF-16 units, never between the two halves of a
 * surrogate pair. Empty input gives no chunks.
 */
export function chunkPtyData(data: string, maxChars = PTY_DATA_CHUNK_CHARS): string[] {
  const max = Math.max(2, Math.floor(maxChars));
  if (data.length <= max) return data.length ? [data] : [];
  const out: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end--;
    out.push(data.slice(start, end));
    start = end;
  }
  return out;
}

/** Split typed / pasted input into chunks of at most `maxBytes` UTF-8 bytes (surrogate pairs kept whole). */
export function splitPtyInput(data: string, maxBytes = PTY_MAX_INPUT_BYTES): string[] {
  const max = Math.max(4, Math.floor(maxBytes));
  if (data.length * 3 <= max || utf8Length(data) <= max) return data.length ? [data] : [];
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    let width: number;
    let units = 1;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (isHighSurrogate(code) && i + 1 < data.length && (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      width = 4;
      units = 2;
    } else width = 3;
    if (bytes + width > max) {
      out.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += width;
    i += units - 1;
  }
  if (start < data.length) out.push(data.slice(start));
  return out;
}

/** The last `maxChars` chars of a terminal's output (for re-attaching panels). */
export class OutputTail {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly maxChars = PTY_REPLAY_CHARS) {}

  get size(): number {
    return this.length;
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.length += data.length;
    while (this.length > this.maxChars && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const excess = this.length - this.maxChars;
      if (head.length <= excess) {
        this.chunks.shift();
        this.length -= head.length;
      } else {
        let cut = excess;
        // Do not start the tail with the second half of a surrogate pair.
        if ((head.charCodeAt(cut) & 0xfc00) === 0xdc00) cut++;
        this.chunks[0] = head.slice(cut);
        this.length -= cut;
      }
    }
  }

  text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
  }
}

/** Validate an extension → hub terminal message (null = invalid). */
export function parsePtyToHost(value: unknown): PtyToHost | null {
  if (!isRecord(value) || !isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'pty-open':
      if (!isPtyCwdInput(value.cwd) || !isPtyDim(value.cols) || !isPtyDim(value.rows)) return null;
      return { t: 'pty-open', id, cwd: value.cwd, cols: value.cols, rows: value.rows };
    case 'pty-input':
      if (typeof value.data !== 'string' || value.data.length === 0) return null;
      if (value.data.length > PTY_MAX_INPUT_BYTES || utf8Length(value.data) > PTY_MAX_INPUT_BYTES) return null;
      return { t: 'pty-input', id, data: value.data };
    case 'pty-resize':
      if (!isPtyDim(value.cols) || !isPtyDim(value.rows)) return null;
      return { t: 'pty-resize', id, cols: value.cols, rows: value.rows };
    case 'pty-close':
      return { t: 'pty-close', id };
    default:
      return null;
  }
}

function exitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function exitSignal(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 32) return value;
  return null;
}

/** Validate a hub → extension terminal message (null = invalid or not a terminal message). */
export function parsePtyFromHost(value: unknown): PtyFromHost | null {
  if (!isRecord(value) || !isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'pty-opened': {
      if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 0) return null;
      const out: PtyFromHost = { t: 'pty-opened', id, pid: value.pid };
      if (typeof value.cwd === 'string' && value.cwd.length <= PTY_MAX_CWD_CHARS * 2) out.cwd = value.cwd;
      return out;
    }
    case 'pty-data':
      if (typeof value.data !== 'string' || value.data.length > PTY_MAX_DATA_CHARS) return null;
      return { t: 'pty-data', id, data: value.data };
    case 'pty-exit':
      return { t: 'pty-exit', id, code: exitCode(value.code), signal: exitSignal(value.signal) };
    case 'pty-error': {
      const error = typeof value.error === 'string' && value.error ? value.error.slice(0, PTY_MAX_ERROR_CHARS) : 'Terminal error';
      return { t: 'pty-error', id, error };
    }
    default:
      return null;
  }
}

/** Is `t` the type of a terminal message? */
export function isPtyMessageType(t: unknown): boolean {
  return typeof t === 'string' && t.startsWith('pty-');
}

/** A fresh random terminal id. */
export function newPtyId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `pty-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Recent working directories of the Claude Code terminal: strings trimmed, non-empty, ≤ PTY_MAX_CWD_CHARS, without
 * control characters, deduplicated (first occurrence wins = most recent), at most MAX_RECENT_DIRS.
 */
export function sanitizeRecentDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= MAX_RECENT_DIRS) break;
    if (typeof item !== 'string') continue;
    const dir = item.trim();
    if (!dir || dir.length > PTY_MAX_CWD_CHARS || CONTROL_RE.test(dir) || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}

/** `dir` moved to the front of the recent list (MRU), trimmed to MAX_RECENT_DIRS. */
export function pushRecentDir(list: readonly string[], dir: string): string[] {
  return sanitizeRecentDirs([dir, ...list.filter((d) => d !== dir.trim())]);
}
