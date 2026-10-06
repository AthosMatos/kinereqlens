/**
 * JavaScript call stack text (`Error().stack`) parsing and trimming. Small and table-free: hook.js (MAIN world,
 * every frame) bundles `cleanStack` to record the initiator of a request; the panel parses the result.
 *
 * Formats: V8 (Chrome / Edge / Node) `    at fn (url:line:col)`, `    at url:line:col`, `    at async fn (…)`,
 * `    at new Foo (…)`, `    at Object.fn [as alias] (…)`, eval frames, `<anonymous>` / `native` / `index N`;
 * SpiderMonkey / JavaScriptCore `fn@url:line:col` (`async*fn@…`).
 */

/** One parsed stack frame. `line` / `col` are 1-based (0 when unknown). */
export interface StackFrame {
  /** The original line, trimmed. */
  raw: string;
  /** Function name as printed ('' for anonymous code), without `async ` / `new `. */
  fn: string;
  /** Script URL ('' for native / eval / anonymous frames). */
  url: string;
  line: number;
  col: number;
  /** An `await` continuation (`at async fn`). */
  async: boolean;
  /** A constructor call (`at new Foo`). */
  ctor: boolean;
  /** No script location: native code, `<anonymous>`, `index N`, eval. */
  native: boolean;
}

/** Most frames kept for one request. */
export const STACK_MAX_FRAMES = 40;
/** Largest stack text kept for one request (characters). */
export const STACK_MAX_CHARS = 8 * 1024;

const V8_WITH_LOCATION = /^at\s+(?:(async)\s+)?(?:(new)\s+)?(.*?)\s+\((.*)\)$/;
const V8_LOCATION_ONLY = /^at\s+(?:(async)\s+)?(?:(new)\s+)?(.*)$/;
const GECKO = /^(?:(async)\*)?([^@]*)@(.*)$/;

function parseLocation(location: string): { url: string; line: number; col: number } | null {
  const loc = location.trim();
  if (!loc || loc === 'native' || loc === '<anonymous>' || /^index \d+$/.test(loc) || loc.startsWith('eval at ')) return null;
  const full = /^(.*?):(\d+):(\d+)$/.exec(loc);
  if (full) return { url: full[1]!, line: Number(full[2]), col: Number(full[3]) };
  const lineOnly = /^(.*?):(\d+)$/.exec(loc);
  if (lineOnly && /^[a-z][a-z0-9+.-]*:/i.test(lineOnly[1]!)) return { url: lineOnly[1]!, line: Number(lineOnly[2]), col: 0 };
  return null;
}

function frameOf(raw: string, fn: string, location: string, isAsync: boolean, ctor: boolean): StackFrame {
  const loc = parseLocation(location);
  return {
    raw,
    fn: fn.trim(),
    url: loc?.url ?? '',
    line: loc?.line ?? 0,
    col: loc?.col ?? 0,
    async: isAsync,
    ctor,
    native: loc === null,
  };
}

/** Parse one stack line, or null when it is not a frame (e.g. the "Error: message" header). */
export function parseStackLine(line: string): StackFrame | null {
  const raw = line.trim();
  if (!raw) return null;
  if (raw.startsWith('at ')) {
    const withLoc = V8_WITH_LOCATION.exec(raw);
    if (withLoc) return frameOf(raw, withLoc[3]!, withLoc[4]!, !!withLoc[1], !!withLoc[2]);
    const only = V8_LOCATION_ONLY.exec(raw);
    if (!only) return null;
    const rest = only[3]!;
    // `at fn` with no location at all (e.g. `at async Promise.all (index 0)` is matched above).
    const loc = parseLocation(rest);
    return loc ? frameOf(raw, '', rest, !!only[1], !!only[2]) : frameOf(raw, rest, '', !!only[1], !!only[2]);
  }
  const gecko = GECKO.exec(raw);
  if (gecko && /:\d+(?::\d+)?$/.test(gecko[3]!)) return frameOf(raw, gecko[2]!, gecko[3]!, !!gecko[1], false);
  return null;
}

/** Every frame of a stack text (non-frame lines are skipped), at most `max`. */
export function parseStack(stack: string, max = 200): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    if (frames.length >= max) break;
    const frame = parseStackLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** URL of the first frame of a stack (the script that created the Error), or ''. */
export function firstFrameUrl(stack: string): string {
  for (const line of stack.split('\n')) {
    const frame = parseStackLine(line);
    if (frame) return frame.url;
  }
  return '';
}

/**
 * The frame lines of `stack` without the header and without frames of `ownUrl` (kineReqLens' own wrappers),
 * at most STACK_MAX_FRAMES lines and STACK_MAX_CHARS characters (cut at a line boundary). '' when nothing is left.
 */
export function cleanStack(stack: string, ownUrl: string): string {
  const out: string[] = [];
  let size = 0;
  for (const line of stack.split('\n')) {
    if (out.length >= STACK_MAX_FRAMES) break;
    const frame = parseStackLine(line);
    if (!frame) continue;
    if (ownUrl && frame.url === ownUrl) continue;
    const text = frame.raw.length > 1024 ? frame.raw.slice(0, 1024) : frame.raw;
    if (size + text.length + 1 > STACK_MAX_CHARS) break;
    out.push(text);
    size += text.length + 1;
  }
  return out.join('\n');
}

/** `stack` cut to at most `max` characters at a line boundary ('' stays ''). */
export function capStackText(stack: string, max = STACK_MAX_CHARS): string {
  if (stack.length <= max) return stack;
  const cut = stack.lastIndexOf('\n', max);
  return cut > 0 ? stack.slice(0, cut) : stack.slice(0, max);
}
