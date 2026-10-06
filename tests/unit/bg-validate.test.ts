import { describe, expect, it } from 'vitest';
import { REPLAY_LIMITS, isHttpToken, isValidHeaderValue, validateReplayRequest } from '../../src/background/replay-validate';
import type { ReplayRequest } from '../../src/shared/types';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: ReplayRequest = {
    runId: 'run-1',
    entryId: 'h:0:1',
    mode: 'extension',
    frameId: 0,
    method: 'POST',
    url: 'https://api.example.com/items?a=1#frag',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'sid=1' },
    ],
    body: { kind: 'text', text: '{"a":1}' },
    credentials: 'include',
    redirect: 'follow',
    timeoutMs: 30_000,
    responseBodyCap: 1024,
  };
  return { ...base, ...overrides };
}

function expectError(value: unknown, pattern: RegExp): void {
  const result = validateReplayRequest(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}

describe('validateReplayRequest', () => {
  it('accepts a well-formed request and strips the fragment', () => {
    const result = validateReplayRequest(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.req.url).toBe('https://api.example.com/items?a=1');
    expect(result.req.headers).toHaveLength(2);
    expect(result.invalidHeaders).toEqual([]);
  });

  it('returns a sanitized copy without unknown fields', () => {
    const result = validateReplayRequest(request({ evil: true, __proto__: { polluted: 1 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.req).sort()).toEqual(
      ['body', 'credentials', 'entryId', 'frameId', 'headers', 'method', 'mode', 'redirect', 'responseBodyCap', 'runId', 'timeoutMs', 'url'].sort(),
    );
  });

  it('rejects non-objects', () => {
    expectError(null, /object/);
    expectError('REPLAY', /object/);
    expectError([], /object/);
  });

  it('only allows http and https URLs', () => {
    expectError(request({ url: 'file:///etc/passwd' }), /http/);
    expectError(request({ url: 'chrome://settings' }), /http/);
    expectError(request({ url: 'javascript:alert(1)' }), /http/);
    expectError(request({ url: 'ws://example.com/socket' }), /http/);
    expectError(request({ url: '/relative/path' }), /Invalid URL/);
    expectError(request({ url: '' }), /Missing URL/);
    expectError(request({ url: 42 }), /Missing URL/);
  });

  it('rejects URLs with embedded credentials', () => {
    expectError(request({ url: 'https://user:pass@example.com/' }), /credentials/);
  });

  it('rejects oversized URLs', () => {
    expectError(request({ url: `https://example.com/?q=${'a'.repeat(REPLAY_LIMITS.urlLength)}` }), /too long/);
  });

  it('requires a method token and refuses methods fetch cannot send', () => {
    expectError(request({ method: 'GE T' }), /method/);
    expectError(request({ method: '' }), /method/);
    expectError(request({ method: 'GET\r\nX: y' }), /method/);
    expectError(request({ method: 'connect' }), /CONNECT/);
    expectError(request({ method: 'TRACE' }), /TRACE/);
    expect(validateReplayRequest(request({ method: 'PROPFIND' })).ok).toBe(true);
  });

  it('drops headers with invalid names or values and reports them', () => {
    const result = validateReplayRequest(
      request({
        headers: [
          { name: 'X-Good', value: 'ok' },
          { name: 'Bad Name', value: 'x' },
          { name: 'X-Inject', value: 'a\r\nSet-Cookie: x=1' },
          { name: 'X-Nul', value: 'a\u0000b' },
          { name: 'X-Unicode', value: 'café ☃' },
          { name: ' X-Trimmed ', value: 'v' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.req.headers).toEqual([
      { name: 'X-Good', value: 'ok' },
      { name: 'X-Trimmed', value: 'v' },
    ]);
    expect(result.invalidHeaders).toEqual(['Bad Name', 'X-Inject', 'X-Nul', 'X-Unicode']);
  });

  it('rejects malformed header lists', () => {
    expectError(request({ headers: 'Cookie: a' }), /array/);
    expectError(request({ headers: [{ name: 'X' }] }), /Malformed header/);
    expectError(request({ headers: Array.from({ length: REPLAY_LIMITS.headerCount + 1 }, (_, i) => ({ name: `X-${i}`, value: '1' })) }), /Too many/);
    expectError(request({ headers: [{ name: 'X-Big', value: 'a'.repeat(REPLAY_LIMITS.headerValueLength + 1) }] }), /too long/);
  });

  it('validates bodies', () => {
    expect(validateReplayRequest(request({ body: { kind: 'none' } })).ok).toBe(true);
    expect(validateReplayRequest(request({ body: { kind: 'base64', base64: 'AAEC\n/w==' } })).ok).toBe(true);
    expectError(request({ body: { kind: 'base64', base64: 'not base64!' } }), /base64/);
    expectError(request({ body: { kind: 'base64', base64: 'AAECA' } }), /base64/);
    expectError(request({ body: { kind: 'text', text: 5 } }), /Malformed/);
    expectError(request({ body: { kind: 'stream' } }), /Unknown body/);
    expectError(request({ body: null }), /Malformed body/);
  });

  it('drops bodies on GET and HEAD', () => {
    for (const method of ['GET', 'head']) {
      const result = validateReplayRequest(request({ method }));
      expect(result.ok && result.req.body).toEqual({ kind: 'none' });
    }
  });

  it('validates enums and numbers', () => {
    expectError(request({ mode: 'background' }), /mode/);
    expectError(request({ credentials: 'always' }), /credentials/);
    expectError(request({ redirect: 'auto' }), /redirect/);
    expectError(request({ frameId: -1 }), /frameId/);
    expectError(request({ frameId: 1.5 }), /frameId/);
    expectError(request({ timeoutMs: 0 }), /timeout/);
    expectError(request({ timeoutMs: Number.POSITIVE_INFINITY }), /timeout/);
    expectError(request({ responseBodyCap: -1 }), /cap/);
    expectError(request({ runId: '' }), /runId/);
    expectError(request({ runId: 'x'.repeat(REPLAY_LIMITS.runIdLength + 1) }), /runId/);
  });

  it('clamps large timeouts and caps', () => {
    const result = validateReplayRequest(request({ timeoutMs: 1e12, responseBodyCap: 1e12 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.req.timeoutMs).toBe(REPLAY_LIMITS.timeoutMs);
    expect(result.req.responseBodyCap).toBe(REPLAY_LIMITS.responseBodyCap);
  });
});

describe('token / header value helpers', () => {
  it('recognizes HTTP tokens', () => {
    expect(isHttpToken('X-Custom_1.2')).toBe(true);
    expect(isHttpToken("!#$%&'*+-.^_`|~")).toBe(true);
    expect(isHttpToken('a b')).toBe(false);
    expect(isHttpToken('a:b')).toBe(false);
    expect(isHttpToken('')).toBe(false);
  });

  it('accepts Latin-1 values without CR/LF/NUL', () => {
    expect(isValidHeaderValue('Bearer abc.def')).toBe(true);
    expect(isValidHeaderValue('café')).toBe(true);
    expect(isValidHeaderValue('')).toBe(true);
    expect(isValidHeaderValue('a\nb')).toBe(false);
    expect(isValidHeaderValue('☃')).toBe(false);
  });
});
