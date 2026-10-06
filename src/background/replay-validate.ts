// Strict validation of REPLAY payloads before the service worker sends anything (security rule 5):
// http(s) URLs only, RFC 9110 method token, header name/value sanity, bounded sizes. Returns a sanitized
// copy containing only known fields.
import { base64ByteLength, utf8ByteLength } from '../lib/encoding';
import type { HeaderPair, ReplayRequest, WireBody } from '../shared/types';
import { isRecord } from './util';

export const REPLAY_LIMITS = {
  runIdLength: 200,
  entryIdLength: 1024,
  methodLength: 64,
  /** Chromium's maximum URL length. */
  urlLength: 2 * 1024 * 1024,
  headerCount: 500,
  headerNameLength: 1024,
  headerValueLength: 64 * 1024,
  /** Decoded request body bytes. */
  bodyBytes: 50 * 1024 * 1024,
  timeoutMs: 10 * 60 * 1000,
  responseBodyCap: 100 * 1024 * 1024,
} as const;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** fetch() throws for these methods. */
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
/** Header values must be ByteStrings without CR/LF/NUL. */
const INVALID_HEADER_VALUE = /[\0\r\n]|[^\u0000-ÿ]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CREDENTIALS = new Set<ReplayRequest['credentials']>(['include', 'same-origin', 'omit']);
const REDIRECTS = new Set<ReplayRequest['redirect']>(['follow', 'manual', 'error']);

export type ReplayValidation =
  | {
      ok: true;
      req: ReplayRequest;
      /** Names of headers removed because their name or value is not valid HTTP. */
      invalidHeaders: string[];
    }
  | { ok: false; error: string };

/** True for an RFC 9110 token (method and header-name syntax). */
export function isHttpToken(value: string): boolean {
  return TOKEN.test(value);
}

/** Header value fetch / DNR will accept (no CR, LF, NUL; Latin-1 only). */
export function isValidHeaderValue(value: string): boolean {
  return !INVALID_HEADER_VALUE.test(value);
}

/**
 * Validate an untrusted REPLAY payload. Structural problems reject the whole request; individual headers
 * with an invalid name or value are removed and reported (mirroring how page mode reports them).
 */
export function validateReplayRequest(value: unknown): ReplayValidation {
  if (!isRecord(value)) return fail('Replay request must be an object');

  const { runId, entryId, mode, frameId, method, url, timeoutMs, responseBodyCap } = value;
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > REPLAY_LIMITS.runIdLength) {
    return fail('Invalid runId');
  }
  if (typeof entryId !== 'string' || entryId.length > REPLAY_LIMITS.entryIdLength) return fail('Invalid entryId');
  if (mode !== 'page' && mode !== 'extension') return fail('Invalid mode');
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId < 0) return fail('Invalid frameId');

  if (typeof method !== 'string' || method.length > REPLAY_LIMITS.methodLength || !isHttpToken(method)) {
    return fail('Invalid HTTP method');
  }
  if (FORBIDDEN_METHODS.has(method.toUpperCase())) return fail(`The ${method.toUpperCase()} method cannot be sent by fetch`);

  const urlCheck = checkUrl(url);
  if ('error' in urlCheck) return fail(urlCheck.error);

  const headers = checkHeaders(value.headers);
  if ('error' in headers) return fail(headers.error);

  const body = checkBody(value.body);
  if ('error' in body) return fail(body.error);

  const credentials = value.credentials;
  if (typeof credentials !== 'string' || !CREDENTIALS.has(credentials as ReplayRequest['credentials'])) {
    return fail('Invalid credentials option');
  }
  const redirect = value.redirect;
  if (typeof redirect !== 'string' || !REDIRECTS.has(redirect as ReplayRequest['redirect'])) {
    return fail('Invalid redirect option');
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail('Invalid timeout');
  if (typeof responseBodyCap !== 'number' || !Number.isFinite(responseBodyCap) || responseBodyCap < 0) {
    return fail('Invalid response body cap');
  }

  // GET/HEAD cannot carry a body in fetch; the draft layer already drops it (with a warning).
  const upper = method.toUpperCase();
  const wireBody: WireBody = upper === 'GET' || upper === 'HEAD' ? { kind: 'none' } : body.body;

  return {
    ok: true,
    invalidHeaders: headers.invalid,
    req: {
      runId,
      entryId,
      mode,
      frameId,
      method,
      url: urlCheck.url,
      headers: headers.valid,
      body: wireBody,
      credentials: credentials as ReplayRequest['credentials'],
      redirect: redirect as ReplayRequest['redirect'],
      timeoutMs: Math.min(Math.ceil(timeoutMs), REPLAY_LIMITS.timeoutMs),
      responseBodyCap: Math.min(Math.floor(responseBodyCap), REPLAY_LIMITS.responseBodyCap),
    },
  };
}

function fail(error: string): ReplayValidation {
  return { ok: false, error };
}

/** Normalized absolute http(s) URL without fragment (fetch never sends it; DNR matches without it). */
function checkUrl(url: unknown): { url: string } | { error: string } {
  if (typeof url !== 'string' || url.length === 0) return { error: 'Missing URL' };
  if (url.length > REPLAY_LIMITS.urlLength) return { error: 'URL is too long' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url.slice(0, 200)}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http and https URLs can be replayed (got ${parsed.protocol})` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: 'URLs with embedded credentials cannot be sent by fetch — use an Authorization header instead' };
  }
  parsed.hash = '';
  return { url: parsed.href };
}

function checkHeaders(value: unknown): { valid: HeaderPair[]; invalid: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'Headers must be an array' };
  if (value.length > REPLAY_LIMITS.headerCount) return { error: 'Too many headers' };
  const valid: HeaderPair[] = [];
  const invalid: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
      return { error: 'Malformed header' };
    }
    if (item.name.length > REPLAY_LIMITS.headerNameLength || item.value.length > REPLAY_LIMITS.headerValueLength) {
      return { error: `Header ${item.name.slice(0, 64)} is too long` };
    }
    const name = item.name.trim();
    if (!isHttpToken(name) || !isValidHeaderValue(item.value)) {
      invalid.push(name || item.name);
      continue;
    }
    valid.push({ name, value: item.value });
  }
  return { valid, invalid };
}

function checkBody(value: unknown): { body: WireBody } | { error: string } {
  if (!isRecord(value)) return { error: 'Malformed body' };
  switch (value.kind) {
    case 'none':
      return { body: { kind: 'none' } };
    case 'text': {
      if (typeof value.text !== 'string') return { error: 'Malformed text body' };
      if (value.text.length > REPLAY_LIMITS.bodyBytes || utf8ByteLength(value.text) > REPLAY_LIMITS.bodyBytes) {
        return { error: 'Request body is too large' };
      }
      return { body: { kind: 'text', text: value.text } };
    }
    case 'base64': {
      if (typeof value.base64 !== 'string') return { error: 'Malformed binary body' };
      const compact = value.base64.replace(/\s+/g, '');
      if (!BASE64.test(compact) || compact.length % 4 === 1) return { error: 'Binary body is not valid base64' };
      if (base64ByteLength(compact) > REPLAY_LIMITS.bodyBytes) return { error: 'Request body is too large' };
      return { body: { kind: 'base64', base64: compact } };
    }
    default:
      return { error: 'Unknown body kind' };
  }
}
