// Strict validation of the bridge calls relayed by the hub (docs/specs/v0.2.md §B.4). Anything Claude sends
// is untrusted: unknown methods and unknown parameters are rejected, ids are bounded, numbers must be finite
// integers in range, arrays and strings are bounded. Error texts are shown to Claude, so they say what to fix.
import { BRIDGE_METHODS } from '../../shared/claude-protocol';
import type { BridgeCalls, BridgeMethod, InboxItem, PromptTarget, RequestOverrides, TypeFormat } from '../../shared/claude-protocol';
import type { ReplayMode } from '../../shared/types';
import type { LinkInboxDraft } from '../../shared/claude-link';
import { isRecord } from '../util';
import { parseInboxImages } from '../../shared/shot-protocol';

export const MAX_ID_CHARS = 128;
export const MAX_QUERY_CHARS = 1024;
export const MAX_FILTER_ITEMS = 32;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_OFFSET = 1_000_000;
export const DEFAULT_MAX_BODY_CHARS = 20_000;
export const MAX_BODY_CHARS = 1_000_000;
export const MAX_OVERRIDE_URL_CHARS = 64 * 1024;
export const MAX_OVERRIDE_HEADERS = 200;
export const MAX_OVERRIDE_QUERY = 1000;
export const MAX_OVERRIDE_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_HEADER_VALUE_CHARS = 16 * 1024;
export const MAX_INBOX_PROMPT_CHARS = 8_000_000;

const TYPE_FORMATS: ReadonlySet<string> = new Set<TypeFormat>(['typescript', 'zod', 'json-schema']);
const PROMPT_TARGETS: ReadonlySet<string> = new Set<PromptTarget>(['client', 'server', 'tests', 'explain']);
const MODES: ReadonlySet<string> = new Set<ReplayMode>(['page', 'extension']);
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
/** Methods fetch refuses to send. */
const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(['CONNECT', 'TRACE', 'TRACK']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const STATUS_FILTER = /^(?:[1-5]xx|[1-5]\d\d|pending|error|failed|aborted)$/i;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** A malformed call; the message is returned to Claude as is. */
export class ParamError extends Error {}

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === 'string' && (BRIDGE_METHODS as readonly string[]).includes(value);
}

type Check = (value: unknown, name: string) => unknown;

function fail(message: string): never {
  throw new ParamError(message);
}

const tabId: Check = (value, name) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} must be a tab id (non-negative integer) from list_tabs/status`);

const entryId: Check = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a request id from list_requests, or "selected"`);
  if (value.length > MAX_ID_CHARS) fail(`${name} is too long (max ${MAX_ID_CHARS} characters)`);
  if (CONTROL_CHARS.test(value)) fail(`${name} contains control characters`);
  return value;
};

const bool: Check = (value, name) => (typeof value === 'boolean' ? value : fail(`${name} must be true or false`));

function integer(min: number, max: number, clampMax: boolean): Check {
  return (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) fail(`${name} must be an integer`);
    if (value < min) fail(`${name} must be at least ${min}`);
    if (value > max) return clampMax ? max : fail(`${name} must be at most ${max}`);
    return value;
  };
}

function oneOf(values: ReadonlySet<string>): Check {
  return (value, name) =>
    typeof value === 'string' && values.has(value) ? value : fail(`${name} must be one of: ${[...values].join(', ')}`);
}

function boundedString(max: number): Check {
  return (value, name) => {
    if (typeof value !== 'string') fail(`${name} must be a string`);
    if (value.length > max) fail(`${name} is too long (max ${max} characters)`);
    return value;
  };
}

function stringList(item: (value: string, name: string) => string): Check {
  return (value, name) => {
    if (!Array.isArray(value)) fail(`${name} must be an array of strings`);
    if (value.length > MAX_FILTER_ITEMS) fail(`${name} has too many items (max ${MAX_FILTER_ITEMS})`);
    return value.map((v, i) => {
      if (typeof v !== 'string' || v.length === 0 || v.length > 32) fail(`${name}[${i}] must be a short non-empty string`);
      return item(v, `${name}[${i}]`);
    });
  };
}

const kindItem = (v: string): string => v.toLowerCase();
const methodItem = (v: string, name: string): string => (METHOD_TOKEN.test(v) ? v.toUpperCase() : fail(`${name} is not an HTTP method`));
const statusItem = (v: string, name: string): string =>
  STATUS_FILTER.test(v) ? v.toLowerCase() : fail(`${name} must look like "2xx", "404", "error", "failed" or "pending"`);

const baseName: Check = (value, name) =>
  typeof value === 'string' && IDENTIFIER.test(value) ? value : fail(`${name} must be an identifier like "GetUserOrders"`);

const overrides: Check = (value, name) => {
  const result = validateOverrides(value);
  return result.ok ? result.value : fail(`${name}: ${result.error}`);
};

interface Field {
  check: Check;
  required?: boolean;
}

const SCHEMAS: { [M in BridgeMethod]: Record<string, Field> } = {
  status: {},
  listTabs: {},
  listRequests: {
    tabId: { check: tabId },
    query: { check: boundedString(MAX_QUERY_CHARS) },
    kinds: { check: stringList(kindItem) },
    methods: { check: stringList(methodItem) },
    statuses: { check: stringList(statusItem) },
    limit: { check: integer(1, MAX_LIST_LIMIT, true) },
    offset: { check: integer(0, MAX_OFFSET, false) },
    errorsOnly: { check: bool },
    overlayFilters: { check: bool },
  },
  getRequest: {
    tabId: { check: tabId },
    id: { check: entryId, required: true },
    maxBodyChars: { check: integer(0, MAX_BODY_CHARS, true) },
    includeRuns: { check: bool },
  },
  getTypes: {
    tabId: { check: tabId },
    id: { check: entryId, required: true },
    format: { check: oneOf(TYPE_FORMATS) },
    baseName: { check: baseName },
    annotate: { check: bool },
  },
  getPrompt: {
    tabId: { check: tabId },
    id: { check: entryId, required: true },
    target: { check: oneOf(PROMPT_TARGETS) },
    includeExamples: { check: bool },
  },
  sendRequest: {
    tabId: { check: tabId },
    id: { check: entryId, required: true },
    overrides: { check: overrides },
    mode: { check: oneOf(MODES) },
    maxBodyChars: { check: integer(0, MAX_BODY_CHARS, true) },
  },
  // Validated by ./control/validate.ts (validateControl): tool, action and per-action arguments.
  control: {},
};

/**
 * Validate the params of a call. `undefined` / `null` params mean "no params"; `null` field values mean
 * "absent". Throws ParamError with a message for Claude.
 */
export function validateParams<M extends BridgeMethod>(method: M, params: unknown): BridgeCalls[M]['params'] {
  const schema: Record<string, Field> = SCHEMAS[method];
  if (params === undefined || params === null) params = {};
  if (!isRecord(params)) fail('params must be an object');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) fail(`unknown parameter "${key}" for ${method}`);
  }
  for (const [key, field] of Object.entries(schema)) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (field.required) fail(`missing parameter "${key}"`);
      continue;
    }
    out[key] = field.check(value, key);
  }
  return out as BridgeCalls[M]['params'];
}

/** Validation of RequestOverrides (send_request). */
export function validateOverrides(value: unknown): Validation<RequestOverrides> {
  try {
    return { ok: true, value: checkOverrides(value) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['method', 'url', 'query', 'headers', 'body']);

function checkOverrides(value: unknown): RequestOverrides {
  if (!isRecord(value)) fail('overrides must be an object');
  for (const key of Object.keys(value)) if (!OVERRIDE_KEYS.has(key)) fail(`unknown override "${key}"`);
  const out: RequestOverrides = {};
  const { method, url, query, headers, body } = value;
  if (method !== undefined && method !== null) {
    if (typeof method !== 'string' || !METHOD_TOKEN.test(method)) fail('method must be an HTTP method token, e.g. "POST"');
    if (FORBIDDEN_METHODS.has(method.toUpperCase())) fail(`method ${method.toUpperCase()} cannot be sent from a browser`);
    out.method = method;
  }
  if (url !== undefined && url !== null) out.url = checkUrl(url);
  if (query !== undefined && query !== null) out.query = checkPairs(query, 'query', MAX_OVERRIDE_QUERY, false) as Array<[string, string]>;
  if (headers !== undefined && headers !== null) out.headers = checkHeaders(headers);
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string') fail('body must be a string (raw body text)');
    if (body.length > MAX_OVERRIDE_BODY_BYTES || (body.length * 3 > MAX_OVERRIDE_BODY_BYTES && utf8Bytes(body) > MAX_OVERRIDE_BODY_BYTES)) {
      fail('body is too large (max 5 MB)');
    }
    out.body = body;
  }
  return out;
}

function checkUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('url must be an absolute http(s) URL');
  if (value.length > MAX_OVERRIDE_URL_CHARS) fail('url is too long (max 64 KB)');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail('url must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('url must use http or https');
  if (parsed.username || parsed.password) fail('url must not contain credentials');
  return value;
}

function checkPairs(value: unknown, name: string, max: number, allowNull: boolean): Array<[string, string | null]> {
  if (!Array.isArray(value)) fail(`${name} must be an array of [name, value] pairs`);
  if (value.length > max) fail(`${name} has too many items (max ${max})`);
  let total = 0;
  return value.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') fail(`${name}[${i}] must be a [name, value] pair`);
    const [key, v] = pair as [string, unknown];
    if (!(typeof v === 'string' || (allowNull && v === null))) fail(`${name}[${i}] value must be a string${allowNull ? ' or null' : ''}`);
    total += key.length + (typeof v === 'string' ? v.length : 0);
    if (total > MAX_OVERRIDE_URL_CHARS) fail(`${name} is too large (max 64 KB in total)`);
    return [key, v as string | null];
  });
}

function checkHeaders(value: unknown): Array<[string, string | null]> {
  const pairs = checkPairs(value, 'headers', MAX_OVERRIDE_HEADERS, true);
  pairs.forEach(([name, v], i) => {
    if (!HEADER_NAME.test(name)) fail(`headers[${i}] has an invalid header name`);
    if (v !== null && (v.length > MAX_HEADER_VALUE_CHARS || /[\r\n\0]/.test(v))) fail(`headers[${i}] has an invalid value`);
  });
  return pairs;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Validation of an inbox item the panel asks to deliver ("Send to Claude Code"). */
export function validateInboxDraft(value: unknown): Validation<LinkInboxDraft> {
  if (!isRecord(value)) return { ok: false, error: 'Invalid item' };
  const { entryId: id, title, target, prompt, sessionId } = value;
  const images = parseInboxImages(value.images);
  if (!images) return { ok: false, error: 'Invalid screenshot' };
  // A screenshot item may come without a request.
  if (typeof id !== 'string' || (id.length === 0 && images.length === 0) || id.length > MAX_ID_CHARS) return { ok: false, error: 'Invalid request id' };
  if (typeof title !== 'string' || title.length > 2048) return { ok: false, error: 'Invalid title' };
  if (typeof target !== 'string' || !PROMPT_TARGETS.has(target)) return { ok: false, error: 'Invalid prompt target' };
  if (typeof prompt !== 'string' || prompt.length === 0) return { ok: false, error: 'The prompt is empty' };
  if (prompt.length > MAX_INBOX_PROMPT_CHARS) return { ok: false, error: 'The prompt is too large to send' };
  if (!(sessionId === undefined || sessionId === null || (typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= MAX_ID_CHARS))) {
    return { ok: false, error: 'Invalid session id' };
  }
  const item: LinkInboxDraft = { entryId: id, title, target: target as PromptTarget, prompt };
  if (typeof sessionId === 'string') item.sessionId = sessionId;
  else if (sessionId === null) item.sessionId = null;
  if (images.length) item.images = images;
  return { ok: true, value: item };
}

/** Complete an item the panel sent with the worker-side fields. */
export function completeInboxItem(draft: LinkInboxDraft, tabId: number, id: string, now: number): InboxItem {
  return { ...draft, id, sentAt: now, tabId };
}
