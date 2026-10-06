/**
 * Runtime shape checks for data crossing into the content script. MAIN-world data is untrusted (the page
 * can forge it); service-worker data is trusted but still checked so a bug there cannot crash the UI.
 */
import type {
  FormDataEntryInfo,
  HeaderPair,
  HookRequestEnd,
  HookRequestStart,
  ReplayRequest,
  ReplayResult,
  RequestEntry,
  SerializedBody,
  TabState,
} from '../shared/types';
import { base64ByteLength, utf8ByteLength } from '../lib/encoding';
import { capStackText } from '../lib/stack';

/** Upper bound on header lines accepted from untrusted sources. */
const MAX_HEADERS = 500;
/** Upper bound on header name/value length accepted from untrusted sources. */
const MAX_HEADER_TEXT = 64 * 1024;
const MAX_TEXT = 4096;

/** Non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Well-formed header pairs only, bounded in count and length. */
export function sanitizeHeaders(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) return [];
  const headers: HeaderPair[] = [];
  for (const item of value) {
    if (headers.length >= MAX_HEADERS) break;
    if (isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string') {
      headers.push({ name: item.name.slice(0, MAX_HEADER_TEXT), value: item.value.slice(0, MAX_HEADER_TEXT) });
    }
  }
  return headers;
}

function sanitizeFormEntry(value: unknown): FormDataEntryInfo | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (value.type === 'text' && typeof value.value === 'string') {
    return value.truncated === true
      ? { name: value.name, type: 'text', value: value.value, truncated: true }
      : { name: value.name, type: 'text', value: value.value };
  }
  if (value.type !== 'file') return null;
  const entry: FormDataEntryInfo = {
    name: value.name,
    type: 'file',
    fileName: optionalString(value.fileName) ?? '',
    mime: optionalString(value.mime) ?? '',
    size: finiteNumber(value.size) ?? 0,
  };
  if (typeof value.base64 === 'string') entry.base64 = value.base64;
  if (value.truncated === true) entry.truncated = true;
  return entry;
}

/** A well-formed SerializedBody (fields re-created, unknown kinds rejected) or null. */
export function sanitizeSerializedBody(value: unknown): SerializedBody | null {
  if (!isRecord(value)) return null;
  const truncated = value.truncated === true ? { truncated: true } : {};
  switch (value.kind) {
    case 'text':
      if (typeof value.text !== 'string') return null;
      return { kind: 'text', text: value.text, size: finiteNumber(value.size) ?? utf8ByteLength(value.text), ...truncated };
    case 'base64':
      if (typeof value.base64 !== 'string') return null;
      return {
        kind: 'base64',
        base64: value.base64,
        size: finiteNumber(value.size) ?? base64ByteLength(value.base64),
        ...truncated,
      };
    case 'formData': {
      if (!Array.isArray(value.entries)) return null;
      const entries: FormDataEntryInfo[] = [];
      for (const item of value.entries) {
        const entry = sanitizeFormEntry(item);
        if (entry) entries.push(entry);
      }
      return { kind: 'formData', entries };
    }
    case 'formFields': {
      if (!Array.isArray(value.fields)) return null;
      const fields = value.fields.filter(
        (field): field is { name: string; value: string } =>
          isRecord(field) && typeof field.name === 'string' && typeof field.value === 'string',
      );
      return { kind: 'formFields', fields: fields.map(({ name, value: fieldValue }) => ({ name, value: fieldValue })) };
    }
    case 'unavailable':
      return { kind: 'unavailable', reason: optionalString(value.reason) ?? 'unavailable' };
    default:
      return null;
  }
}

/** Structural TabState check. */
export function isTabState(value: unknown): value is TabState {
  return (
    isRecord(value) &&
    typeof value.open === 'boolean' &&
    typeof value.recording === 'boolean' &&
    typeof value.preserveLog === 'boolean'
  );
}

/** Keep only boolean TabState fields of a patch. */
export function sanitizeTabStatePatch(value: unknown): Partial<TabState> {
  const patch: Partial<TabState> = {};
  if (!isRecord(value)) return patch;
  for (const key of ['open', 'recording', 'preserveLog'] as const) {
    if (typeof value[key] === 'boolean') patch[key] = value[key];
  }
  return patch;
}

const ENTRY_SOURCES = new Set(['hook', 'webRequest', 'manual']);
const ENTRY_STATES = new Set(['pending', 'done', 'error', 'aborted']);

/** Structural check for a RequestEntry (from the service worker, storage or a replaced instance). */
export function isRequestEntryLike(value: unknown): value is RequestEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.source === 'string' &&
    ENTRY_SOURCES.has(value.source) &&
    typeof value.kind === 'string' &&
    typeof value.frameId === 'number' &&
    typeof value.method === 'string' &&
    typeof value.url === 'string' &&
    Array.isArray(value.requestHeaders) &&
    typeof value.startTime === 'number' &&
    Number.isFinite(value.startTime) &&
    typeof value.state === 'string' &&
    ENTRY_STATES.has(value.state)
  );
}

/** A failed ReplayResult (never-reject contract of bridge.replay). */
export function errorReplayResult(
  req: Pick<ReplayRequest, 'runId' | 'url'>,
  error: string,
  start: number,
  end: number,
  extra: Partial<ReplayResult> = {},
): ReplayResult {
  return {
    runId: req.runId,
    ok: false,
    status: 0,
    statusText: '',
    headers: [],
    body: null,
    url: req.url,
    redirected: false,
    timing: { start, end },
    size: 0,
    error,
    ...extra,
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string').slice(0, MAX_HEADERS);
}

/**
 * Re-create a ReplayResult from untrusted/foreign data, bound to the request we actually sent (`runId`
 * and fallbacks come from `req`). `capBodyFn` bounds the body size.
 */
export function sanitizeReplayResult(
  value: unknown,
  req: ReplayRequest,
  start: number,
  now: number,
  capBodyFn: (body: SerializedBody | null) => SerializedBody | null,
): ReplayResult {
  if (!isRecord(value)) return errorReplayResult(req, 'Malformed replay result', start, now);
  const timing = isRecord(value.timing) ? value.timing : {};
  const result: ReplayResult = {
    runId: req.runId,
    ok: value.ok === true,
    status: finiteNumber(value.status) ?? 0,
    statusText: optionalString(value.statusText) ?? '',
    headers: sanitizeHeaders(value.headers),
    body: capBodyFn(sanitizeSerializedBody(value.body)),
    url: optionalString(value.url, 64 * 1024) ?? req.url,
    redirected: value.redirected === true,
    timing: {
      start: finiteNumber(timing.start) ?? start,
      end: finiteNumber(timing.end) ?? now,
    },
    size: finiteNumber(value.size) ?? 0,
  };
  const headersAt = finiteNumber(timing.headers);
  if (headersAt !== undefined) result.timing.headers = headersAt;
  const type = optionalString(value.type);
  if (type !== undefined) result.type = type;
  const error = optionalString(value.error);
  if (error !== undefined) result.error = error;
  const hint = optionalString(value.errorHint);
  if (hint !== undefined) result.errorHint = hint;
  if (value.aborted === true) result.aborted = true;
  if (value.timedOut === true) result.timedOut = true;
  const viaDnr = stringList(value.appliedViaDnr);
  if (viaDnr) result.appliedViaDnr = viaDnr;
  const dropped = stringList(value.droppedHeaders);
  if (dropped) result.droppedHeaders = dropped;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Hook payloads (MAIN world, untrusted): rebuilt from known fields only
// ---------------------------------------------------------------------------------------------

type BodyCap = (body: SerializedBody | null) => SerializedBody | null;

const START_OPTION_STRINGS = ['credentials', 'mode', 'cache', 'redirect', 'referrerPolicy'] as const;
const START_OPTION_FLAGS = ['keepalive', 'withCredentials'] as const;

function sanitizeStartOptions(value: unknown): HookRequestStart['options'] | undefined {
  if (!isRecord(value)) return undefined;
  const options: NonNullable<HookRequestStart['options']> = {};
  for (const key of START_OPTION_STRINGS) {
    const text = optionalString(value[key], 64);
    if (text !== undefined) options[key] = text;
  }
  for (const key of START_OPTION_FLAGS) {
    if (typeof value[key] === 'boolean') options[key] = value[key];
  }
  return options;
}

/**
 * Copy of a hook 'start' payload (already shape-checked with `isValidHookStart`) holding only the known
 * fields: headers sanitized, body re-created and bounded by `cap`, missing frameUrl filled from `frameUrl`.
 */
export function cleanHookStart(data: HookRequestStart, cap: BodyCap, frameUrl = ''): HookRequestStart {
  const start: HookRequestStart = {
    hookId: String(data.hookId).slice(0, 200),
    kind: data.kind,
    method: String(data.method).slice(0, MAX_TEXT),
    url: String(data.url),
    headers: sanitizeHeaders(data.headers),
    body: cap(sanitizeSerializedBody(data.body)),
    contentType: typeof data.contentType === 'string' ? data.contentType.slice(0, MAX_TEXT) : null,
    startTime: data.startTime,
    frameUrl: (typeof data.frameUrl === 'string' && data.frameUrl) || frameUrl,
  };
  const options = sanitizeStartOptions(data.options);
  if (options) start.options = options;
  // Text only (rendered as text, parsed by the panel), capped at a line boundary.
  if (typeof data.initiatorStack === 'string' && data.initiatorStack) start.initiatorStack = capStackText(data.initiatorStack);
  return start;
}

/** Copy of a hook 'end' payload (already shape-checked with `isValidHookEnd`) holding only the known fields. */
export function cleanHookEnd(data: HookRequestEnd, cap: BodyCap): HookRequestEnd {
  const end: HookRequestEnd = {
    hookId: String(data.hookId).slice(0, 200),
    state: data.state,
    endTime: data.endTime,
  };
  const status = finiteNumber(data.status);
  if (status !== undefined) end.status = status;
  const statusText = optionalString(data.statusText);
  if (statusText !== undefined) end.statusText = statusText;
  if (data.headers !== undefined) end.headers = sanitizeHeaders(data.headers);
  if (data.body !== undefined) end.body = cap(sanitizeSerializedBody(data.body));
  const responseUrl = optionalString(data.responseUrl, 64 * 1024);
  if (responseUrl !== undefined) end.responseUrl = responseUrl;
  if (typeof data.redirected === 'boolean') end.redirected = data.redirected;
  const responseType = optionalString(data.responseType, 64);
  if (responseType !== undefined) end.responseType = responseType;
  const error = optionalString(data.error);
  if (error !== undefined) end.error = error;
  return end;
}

// ---------------------------------------------------------------------------------------------
// Replay requests (from the UI or the service worker)
// ---------------------------------------------------------------------------------------------

/** Structural check of a ReplayRequest; the hook and the service worker validate the details again. */
export function isReplayRequestLike(value: unknown): value is ReplayRequest {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    value.runId !== '' &&
    (value.mode === 'page' || value.mode === 'extension') &&
    typeof value.frameId === 'number' &&
    Number.isInteger(value.frameId) &&
    value.frameId >= 0 &&
    typeof value.method === 'string' &&
    typeof value.url === 'string' &&
    Array.isArray(value.headers) &&
    isRecord(value.body) &&
    typeof value.timeoutMs === 'number' &&
    Number.isFinite(value.timeoutMs) &&
    typeof value.responseBodyCap === 'number'
  );
}
