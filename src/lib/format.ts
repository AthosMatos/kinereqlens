// OWNER: lib-core agent. Display formatting helpers (pure).
import type { EntryState } from '../shared/types';

const DASH = '—';
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/** 0 B, 999 B, 1.2 kB, 3.4 MB (base 1024, one decimal under 10). '—' for missing/negative/non-finite input. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return DASH;
  // Fractional sizes that round up to 1024 B are shown as "1.0 kB" by the unit logic below.
  if (Math.round(bytes) < 1024) return `${Math.round(bytes)} B`;
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // 1023.7 kB would round to "1024 kB": promote to the next unit instead.
  if (Math.round(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = rounded < 10 ? rounded.toFixed(1) : String(Math.round(value));
  return `${text} ${BYTE_UNITS[unit]}`;
}

/** 12 ms, 1.23 s, 12.3 s, 2 m 3 s, 1 h 5 m; '—' for undefined/negative. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms > 0 && ms < 1) return '<1 ms';
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (Math.round(seconds * 100) / 100 < 10) return `${seconds.toFixed(2)} s`;
  if (Math.round(seconds * 10) / 10 < 60) return `${seconds.toFixed(1)} s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} m ${totalSeconds % 60} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  return `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} m`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Local wall-clock time HH:MM:SS.mmm for an epoch ms ('—' when not a valid time). */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return DASH;
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

export interface UrlParts {
  host: string;
  /** Pathname (decoded for display, falls back to raw). */
  path: string;
  /** Last non-empty path segment, or host when path is '/'. */
  name: string;
  /** Query string without '?' ('' when none). */
  query: string;
  origin: string;
}

function safeDecode(text: string, decode: (s: string) => string): string {
  try {
    return decode(text);
  } catch {
    return text;
  }
}

/** Never throws; for unparsable URLs returns the input as name/path. */
export function urlParts(url: string): UrlParts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: '', path: url, name: url, query: '', origin: '' };
  }
  const origin = parsed.origin === 'null' ? '' : parsed.origin;
  const query = parsed.search.slice(1);
  if (parsed.protocol === 'data:') {
    // "data:image/png;base64,..." -> name "data:image/png"; the payload is not useful as a label.
    const header = parsed.pathname.split(',', 1)[0].split(';', 1)[0];
    return { host: '', path: header, name: `data:${header}`, query, origin };
  }
  const rawPath = parsed.pathname;
  const segments = rawPath.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  const host = parsed.host;
  return {
    host,
    path: safeDecode(rawPath, decodeURI),
    name: last !== undefined ? safeDecode(last, decodeURIComponent) : host || rawPath,
    query,
    origin,
  };
}

/** '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'pending' | 'error' | 'unknown'. */
export function statusClass(status: number | undefined, state?: EntryState | 'running'): string {
  if (state === 'pending' || state === 'running') return 'pending';
  if (typeof status === 'number' && Number.isFinite(status) && status >= 100 && status <= 599) {
    return `${Math.floor(status / 100)}xx`;
  }
  if (state === 'error' || state === 'aborted') return 'error';
  return 'unknown';
}

const KNOWN_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'other' (for CSS modifiers). */
export function methodClass(method: string): string {
  const lower = method.trim().toLowerCase();
  return KNOWN_METHODS.has(lower) ? lower : 'other';
}

const CC_QUOTE = 0x22;
const CC_BACKSLASH = 0x5c;

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

/** Characters that end a number/literal token. */
function isJsonDelimiter(code: number): boolean {
  return (
    isJsonWhitespace(code) ||
    code === 0x2c /* , */ ||
    code === 0x3a /* : */ ||
    code === 0x5b /* [ */ ||
    code === 0x5d /* ] */ ||
    code === 0x7b /* { */ ||
    code === 0x7d /* } */ ||
    code === CC_QUOTE
  );
}

/**
 * Re-indent JSON text that is already known to be valid. Strings, numbers and literals are copied verbatim
 * (so big numbers, exponent forms and escapes survive exactly); only insignificant whitespace changes.
 */
function reindentJson(src: string, unit: string): string {
  const out: string[] = [];
  const newlines: string[] = ['\n'];
  const newline = (depth: number): string => (newlines[depth] ??= `\n${unit.repeat(depth)}`);
  const n = src.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const code = src.charCodeAt(i);
    if (isJsonWhitespace(code)) {
      i++;
    } else if (code === CC_QUOTE) {
      let j = i + 1;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c === CC_BACKSLASH) j += 2;
        else if (c === CC_QUOTE) break;
        else j++;
      }
      out.push(src.slice(i, j + 1));
      i = j + 1;
    } else if (code === 0x7b || code === 0x5b) {
      const close = code === 0x7b ? '}' : ']';
      let j = i + 1;
      while (j < n && isJsonWhitespace(src.charCodeAt(j))) j++;
      if (src[j] === close) {
        out.push(code === 0x7b ? '{}' : '[]');
        i = j + 1;
      } else {
        depth++;
        out.push(src[i], newline(depth));
        i++;
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth--;
      out.push(newline(depth), src[i]);
      i++;
    } else if (code === 0x2c) {
      out.push(',', newline(depth));
      i++;
    } else if (code === 0x3a) {
      out.push(': ');
      i++;
    } else {
      let j = i + 1;
      while (j < n && !isJsonDelimiter(src.charCodeAt(j))) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out.join('');
}

/**
 * Pretty-print JSON text with 2-space indentation, or return null when it is not valid JSON. Must not lose
 * big-number precision (re-indent textually or via a lossless parser). JSON.parse is used only to validate;
 * the output is produced from the source text. A leading BOM is ignored.
 */
export function prettyJson(text: string): string | null {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    JSON.parse(source);
  } catch {
    return null;
  }
  return reindentJson(source, '  ');
}

/** Truncate text to max chars, returning whether it was cut. Never splits a surrogate pair. */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  const limit = Math.max(0, Math.floor(max));
  if (text.length <= limit) return { text, clipped: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), clipped: true };
}
