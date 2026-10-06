/**
 * Initiator stacks (MAIN world): the call stack at the moment the page called fetch / XHR.send / sendBeacon /
 * new WebSocket, recorded only while capture is on (the wrappers return before this when it is off).
 *
 * The Error constructor is the one captured at install (a page replacing `window.Error` changes nothing), and
 * its `stackTraceLimit` / `prepareStackTrace` are adjusted for the capture only and restored synchronously
 * (no page code runs in between). Our own wrapper frames (this script's URL) are removed; the text is capped
 * (src/lib/stack.ts) and validated again by the content script.
 */
import { cleanStack, firstFrameUrl, STACK_MAX_FRAMES } from '../lib/stack';

type V8ErrorConstructor = ErrorConstructor & { stackTraceLimit?: number; prepareStackTrace?: unknown };

const NativeError = Error as V8ErrorConstructor;
/** Our wrappers' frames plus a margin, so STACK_MAX_FRAMES page frames remain after stripping them. */
const RAW_FRAME_LIMIT = STACK_MAX_FRAMES + 12;

function rawStack(): string {
  const limit = NativeError.stackTraceLimit;
  const prepare = NativeError.prepareStackTrace;
  try {
    NativeError.stackTraceLimit = RAW_FRAME_LIMIT;
    if (prepare !== undefined) NativeError.prepareStackTrace = undefined;
    const stack: unknown = new NativeError().stack;
    return typeof stack === 'string' ? stack : '';
  } finally {
    NativeError.stackTraceLimit = limit;
    if (prepare !== undefined) NativeError.prepareStackTrace = prepare;
  }
}

/** URL of hook.js itself (taken at install), whose frames are stripped. */
const OWN_URL: string = (() => {
  try {
    return firstFrameUrl(rawStack());
  } catch {
    return '';
  }
})();

/** The page's call stack (frames only, ours removed, capped), or undefined when it cannot be taken. */
export function captureInitiatorStack(): string | undefined {
  try {
    const stack = cleanStack(rawStack(), OWN_URL);
    return stack || undefined;
  } catch {
    return undefined;
  }
}
