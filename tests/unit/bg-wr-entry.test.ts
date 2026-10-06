import { describe, expect, it, vi } from 'vitest';
import {
  chunkEntries,
  createWrEntry,
  estimateEntrySize,
  normalizeRequestBody,
  parseStatusText,
  withCompleted,
  withError,
  withRedirect,
  withRequestHeaders,
  withResponseHeaders,
  wrEntryId,
} from '../../src/background/wr-entry';
import type { RequestEntry } from '../../src/shared/types';

// While src/lib/capture.ts (owned by lib-body) is still a stub, its webRequest helpers fall back to the
// minimal stand-ins below, written from the JSDoc contract in that file. Once the real implementation
// lands, every call goes to it and these tests exercise the actual integration.
const { captureWithFallback } = vi.hoisted(() => {
  type Capture = typeof import('../../src/lib/capture');
  const KINDS: Record<string, string> = {
    main_frame: 'document',
    sub_frame: 'subdocument',
    xmlhttprequest: 'xhr',
    stylesheet: 'stylesheet',
    script: 'script',
    image: 'image',
    imageset: 'image',
    font: 'font',
    media: 'media',
    object: 'other',
    ping: 'ping',
    csp_report: 'ping',
    websocket: 'websocket',
  };
  const decode = (bytes: Uint8Array): string | null => {
    if (bytes.some((b) => b < 0x20 && ![0x09, 0x0a, 0x0d].includes(b))) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  const reference: Pick<Capture, 'mapResourceType' | 'webRequestHeadersToPairs' | 'webRequestBodyToSerialized'> = {
    mapResourceType: (type) => (KINDS[type] ?? 'other') as ReturnType<Capture['mapResourceType']>,
    webRequestHeadersToPairs: (headers) =>
      (headers ?? []).map(({ name, value, binaryValue }) => ({
        name,
        value: value ?? new TextDecoder().decode(new Uint8Array(binaryValue ?? [])),
      })),
    webRequestBodyToSerialized: (body, cap) => {
      if (!body) return null;
      if (body.error !== undefined) return { kind: 'unavailable', reason: body.error };
      if (body.formData) {
        return {
          kind: 'formFields',
          fields: Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value }))),
        };
      }
      const raw = body.raw ?? [];
      const file = raw.find((part) => part.file !== undefined);
      if (file) return { kind: 'unavailable', reason: `file upload: ${file.file}` };
      const parts = raw.map((part) => new Uint8Array(part.bytes ?? new ArrayBuffer(0)));
      const size = parts.reduce((sum, part) => sum + part.length, 0);
      const all = new Uint8Array(size);
      parts.reduce((offset, part) => (all.set(part, offset), offset + part.length), 0);
      const bytes = all.subarray(0, cap);
      const flags = size > cap ? { truncated: true } : {};
      const text = decode(bytes);
      return text !== null
        ? { kind: 'text', text, size, ...flags }
        : { kind: 'base64', base64: btoa(String.fromCharCode(...bytes)), size, ...flags };
    },
  };
  const isStub = (err: unknown): boolean => err instanceof Error && err.message === 'not implemented';
  function captureWithFallback(actual: Capture): Capture {
    const wrapped = { ...actual };
    for (const name of Object.keys(reference) as Array<keyof typeof reference>) {
      const real = actual[name] as (...args: unknown[]) => unknown;
      const stand = reference[name] as (...args: unknown[]) => unknown;
      (wrapped as Record<string, unknown>)[name] = (...args: unknown[]) => {
        try {
          return real(...args);
        } catch (err) {
          if (isStub(err)) return stand(...args);
          throw err;
        }
      };
    }
    return wrapped;
  }
  return { captureWithFallback };
});
vi.mock('../../src/lib/capture', async (importOriginal) => captureWithFallback(await importOriginal()));

const enc = new TextEncoder();
const buffer = (text: string): ArrayBuffer => enc.encode(text).buffer as ArrayBuffer;

const base = {
  requestId: '1234',
  url: 'https://api.example.com/items?a=1',
  method: 'POST',
  frameId: 0,
  tabId: 5,
  type: 'xmlhttprequest',
  timeStamp: 1_700_000_000_123.6,
  initiator: 'https://app.example.com',
};

function created(overrides: Partial<typeof base> = {}, requestBody?: Parameters<typeof createWrEntry>[0]['requestBody']): RequestEntry {
  return createWrEntry({ ...base, ...overrides, requestBody }, 1024 * 1024);
}

describe('parseStatusText', () => {
  it.each([
    ['HTTP/1.1 200 OK', 'OK'],
    ['HTTP/1.1 404 Not Found', 'Not Found'],
    ['HTTP/1.1 307 Internal Redirect', 'Internal Redirect'],
    ['HTTP/2 200', ''],
    ['HTTP/1.1 500', ''],
    ['', ''],
    ['garbage', ''],
  ])('%j -> %j', (line, text) => {
    expect(parseStatusText(line)).toBe(text);
  });

  it('accepts undefined', () => {
    expect(parseStatusText(undefined)).toBe('');
  });
});

describe('createWrEntry', () => {
  it('builds a pending webRequest snapshot', () => {
    const entry = created();
    expect(entry).toMatchObject({
      id: 'w:1234',
      source: 'webRequest',
      kind: 'xhr',
      frameId: 0,
      pageUrl: '',
      method: 'POST',
      url: base.url,
      requestHeaders: [],
      requestBody: null,
      requestContentType: null,
      startTime: 1_700_000_000_124,
      state: 'pending',
      wire: { requestId: '1234', type: 'xmlhttprequest' },
      initiator: 'https://app.example.com',
    });
    expect(wrEntryId('1234')).toBe(entry.id);
  });

  it('maps resource types to entry kinds', () => {
    expect(created({ type: 'main_frame' }).kind).toBe('document');
    expect(created({ type: 'sub_frame' }).kind).toBe('subdocument');
    expect(created({ type: 'image' }).kind).toBe('image');
    expect(created({ type: 'ping' }).kind).toBe('ping');
  });

  it('serializes raw bodies as text when they are UTF-8', () => {
    const entry = created({}, { raw: [{ bytes: buffer('{"a":') }, { bytes: buffer('"é"}') }] });
    expect(entry.requestBody).toMatchObject({ kind: 'text', text: '{"a":"é"}' });
  });

  it('serializes parsed form data, decoding ArrayBuffer values', () => {
    const entry = created({}, { formData: { q: ['one', buffer('two')], empty: [''] } });
    expect(entry.requestBody).toEqual({
      kind: 'formFields',
      fields: [
        { name: 'q', value: 'one' },
        { name: 'q', value: 'two' },
        { name: 'empty', value: '' },
      ],
    });
  });

  it('is JSON-safe (no ArrayBuffers survive)', () => {
    const entry = created({}, { raw: [{ bytes: new Uint8Array([0, 1, 2, 255]).buffer }] });
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect(entry.requestBody?.kind).toBe('base64');
  });
});

describe('normalizeRequestBody', () => {
  it('passes through null and error bodies', () => {
    expect(normalizeRequestBody(undefined)).toBeNull();
    expect(normalizeRequestBody({ error: 'Unknown error' })).toEqual({ error: 'Unknown error' });
  });
});

describe('event updates', () => {
  it('records the headers actually sent, including binary values', () => {
    const original = created();
    const entry = withRequestHeaders(original, [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'sid=1' },
      { name: 'X-Bin', binaryValue: buffer('bin') },
    ]);
    expect(entry.requestHeaders).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Cookie', value: 'sid=1' },
      { name: 'X-Bin', value: 'bin' },
    ]);
    expect(entry.wire?.requestHeaders).toEqual(entry.requestHeaders);
    expect(entry.requestContentType).toBe('application/json');
    expect(original.requestHeaders).toEqual([]); // immutable
  });

  it('keeps the first hop request headers after a redirect', () => {
    let entry = withRequestHeaders(created(), [{ name: 'Accept', value: 'first' }]);
    entry = withRedirect(entry, { redirectUrl: 'https://cdn.example.com/x', statusCode: 302, statusLine: 'HTTP/1.1 302 Found' });
    entry = withRequestHeaders(entry, [{ name: 'Accept', value: 'second' }]);
    expect(entry.requestHeaders).toEqual([{ name: 'Accept', value: 'first' }]);
    expect(entry.redirected).toBe(true);
    expect(entry.responseUrl).toBe('https://cdn.example.com/x');
  });

  it('records the response status line and headers', () => {
    const entry = withResponseHeaders(created(), {
      statusCode: 201,
      statusLine: 'HTTP/1.1 201 Created',
      responseHeaders: [
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    });
    expect(entry.status).toBe(201);
    expect(entry.statusText).toBe('Created');
    expect(entry.responseHeaders).toHaveLength(2);
    expect(entry.wire).toMatchObject({ statusCode: 201, responseHeaders: entry.responseHeaders });
  });

  it('completes with cache/ip info and the final URL', () => {
    const entry = withCompleted(created(), {
      url: 'https://api.example.com/items?a=1',
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      timeStamp: 1_700_000_000_500.2,
      fromCache: true,
      ip: '203.0.113.7',
    });
    expect(entry).toMatchObject({ state: 'done', endTime: 1_700_000_000_500, fromCache: true, status: 200, statusText: 'OK' });
    expect(entry.wire).toMatchObject({ fromCache: true, ip: '203.0.113.7', statusCode: 200 });
    expect(entry.responseUrl).toBeUndefined();

    const redirected = withCompleted(created(), { url: 'https://other.example.com/', statusCode: 200, statusLine: '', timeStamp: 1 });
    expect(redirected.responseUrl).toBe('https://other.example.com/');
    expect(redirected.redirected).toBe(true);
  });

  it('treats net::ERR_ABORTED as aborted and anything else as an error', () => {
    expect(withError(created(), { error: 'net::ERR_ABORTED', timeStamp: 10 })).toMatchObject({ state: 'aborted', error: 'net::ERR_ABORTED', endTime: 10 });
    expect(withError(created(), { error: 'net::ERR_NAME_NOT_RESOLVED', timeStamp: 10 }).state).toBe('error');
  });
});

describe('chunkEntries', () => {
  const entries = Array.from({ length: 450 }, (_, i) => created({ requestId: String(i) }));

  it('splits by count', () => {
    const chunks = chunkEntries(entries, 200, Number.POSITIVE_INFINITY);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(entries);
  });

  it('splits by estimated size, keeping oversized entries alone', () => {
    const big = { ...created({ requestId: 'big' }), requestBody: { kind: 'text' as const, text: 'x'.repeat(10_000), size: 10_000 } };
    const small = created({ requestId: 'small' });
    const limit = estimateEntrySize(small) * 2 + 1;
    const chunks = chunkEntries([small, big, small, small, small], 100, limit);
    expect(chunks.map((c) => c.map((e) => e.id))).toEqual([['w:small'], ['w:big'], ['w:small', 'w:small'], ['w:small']]);
  });

  it('returns no chunks for no entries', () => {
    expect(chunkEntries([], 10, 10)).toEqual([]);
  });
});
