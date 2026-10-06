import { describe, expect, it } from 'vitest';
import type { HookRequestEnd, HookRequestStart, RequestEntry, SerializedBody } from '../../src/shared/types';
import {
  applyHookEnd,
  capBody,
  entryFromHookStart,
  findHookMatch,
  findWebRequestMatch,
  isValidHookEnd,
  isValidHookStart,
  isValidSerializedBody,
  mapResourceType,
  mergeWire,
  normalizeUrlForMatch,
  pickEvictions,
  REDACTED_HEADER_VALUE,
  toPreserved,
  webRequestBodyToSerialized,
  webRequestHeadersToPairs,
} from '../../src/lib/capture';
import { base64ToBytes, bytesToBase64, utf8Encode } from '../../src/lib/encoding';

const buf = (text: string): ArrayBuffer => utf8Encode(text).slice().buffer as ArrayBuffer;
const bytesBuf = (...bytes: number[]): ArrayBuffer => Uint8Array.from(bytes).buffer as ArrayBuffer;

function start(patch: Partial<HookRequestStart> = {}): HookRequestStart {
  return {
    hookId: 'f1',
    kind: 'fetch',
    method: 'POST',
    url: 'https://api.test/items?x=1',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: { kind: 'text', text: '{"a":1}', size: 7 },
    contentType: 'application/json',
    startTime: 10_000,
    frameUrl: 'https://app.test/',
    ...patch,
  };
}

function end(patch: Partial<HookRequestEnd> = {}): HookRequestEnd {
  return { hookId: 'f1', state: 'done', status: 200, statusText: 'OK', headers: [{ name: 'a', value: 'b' }], endTime: 10_250, ...patch };
}

function hookEntry(patch: Partial<RequestEntry> = {}): RequestEntry {
  return { ...entryFromHookStart(0, start(), 'https://app.test/'), ...patch };
}

function wrEntry(patch: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'w:77',
    source: 'webRequest',
    kind: 'xhr',
    frameId: 0,
    pageUrl: '',
    method: 'POST',
    url: 'https://api.test/items?x=1',
    requestHeaders: [{ name: 'Cookie', value: 'sid=1' }],
    requestBody: null,
    requestContentType: null,
    startTime: 10_020,
    state: 'pending',
    wire: { requestId: '77', type: 'xmlhttprequest', requestHeaders: [{ name: 'Cookie', value: 'sid=1' }] },
    ...patch,
  };
}

describe('webRequestBodyToSerialized', () => {
  it('returns null without a body', () => {
    expect(webRequestBodyToSerialized(null, 100)).toBeNull();
    expect(webRequestBodyToSerialized(undefined, 100)).toBeNull();
    expect(webRequestBodyToSerialized({}, 100)).toBeNull();
    expect(webRequestBodyToSerialized({ raw: [] }, 100)).toBeNull();
  });

  it('maps errors and file uploads to unavailable', () => {
    expect(webRequestBodyToSerialized({ error: 'Unknown error.' }, 100)).toEqual({ kind: 'unavailable', reason: 'Unknown error.' });
    expect(webRequestBodyToSerialized({ raw: [{ bytes: buf('--b\r\n') }, { file: '/tmp/x.png' }] }, 100)).toEqual({
      kind: 'unavailable',
      reason: 'file upload: /tmp/x.png',
    });
  });

  it('flattens formData in key order, then value order', () => {
    expect(webRequestBodyToSerialized({ formData: { b: ['1', '2'], a: ['x'] } }, 100)).toEqual({
      kind: 'formFields',
      fields: [
        { name: 'b', value: '1' },
        { name: 'b', value: '2' },
        { name: 'a', value: 'x' },
      ],
    });
  });

  it('concatenates raw bytes into text or base64', () => {
    expect(webRequestBodyToSerialized({ raw: [{ bytes: buf('{"a":') }, { bytes: buf('"é"}') }] }, 100)).toEqual({
      kind: 'text',
      text: '{"a":"é"}',
      size: 10,
    });
    expect(webRequestBodyToSerialized({ raw: [{ bytes: bytesBuf(0, 255, 1) }] }, 100)).toEqual({
      kind: 'base64',
      base64: bytesToBase64(Uint8Array.of(0, 255, 1)),
      size: 3,
    });
    expect(webRequestBodyToSerialized({ raw: [{ bytes: new ArrayBuffer(0) }] }, 100)).toEqual({ kind: 'text', text: '', size: 0 });
  });

  it('accepts ArrayBuffers from another realm and typed-array views', () => {
    // A real ArrayBuffer whose prototype is not this realm's (what a buffer from another realm looks like).
    const foreign = Object.setPrototypeOf(Uint8Array.of(104, 105).buffer, { [Symbol.toStringTag]: 'ArrayBuffer' }) as ArrayBuffer;
    expect(foreign instanceof ArrayBuffer).toBe(false);
    expect(webRequestBodyToSerialized({ raw: [{ bytes: foreign }] }, 100)).toEqual({ kind: 'text', text: 'hi', size: 2 });
    const view = utf8Encode('xok').subarray(1) as unknown as ArrayBuffer;
    expect(webRequestBodyToSerialized({ raw: [{ bytes: view }] }, 100)).toEqual({ kind: 'text', text: 'ok', size: 2 });
  });

  it('caps raw bytes without splitting a UTF-8 character', () => {
    // "aé" + "b" = 61 C3 A9 62; a cap of 2 lands inside "é".
    expect(webRequestBodyToSerialized({ raw: [{ bytes: buf('aé') }, { bytes: buf('b') }] }, 2)).toEqual({
      kind: 'text',
      text: 'a',
      size: 4,
      truncated: true,
    });
    const binary = webRequestBodyToSerialized({ raw: [{ bytes: bytesBuf(0, 1, 2, 3, 4) }] }, 3);
    expect(binary).toEqual({ kind: 'base64', base64: bytesToBase64(Uint8Array.of(0, 1, 2)), size: 5, truncated: true });
  });
});

describe('webRequestHeadersToPairs / mapResourceType', () => {
  it('decodes binary header values', () => {
    expect(
      webRequestHeadersToPairs([
        { name: 'A', value: '1' },
        { name: 'B', binaryValue: buf('é') },
        { name: 'C', binaryValue: [0x68, 0x69] },
        { name: 'D' },
      ]),
    ).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'é' },
      { name: 'C', value: 'hi' },
      { name: 'D', value: '' },
    ]);
    expect(webRequestHeadersToPairs(undefined)).toEqual([]);
  });

  it.each([
    ['main_frame', 'document'],
    ['sub_frame', 'subdocument'],
    ['xmlhttprequest', 'xhr'],
    ['stylesheet', 'stylesheet'],
    ['script', 'script'],
    ['image', 'image'],
    ['imageset', 'image'],
    ['font', 'font'],
    ['media', 'media'],
    ['object', 'other'],
    ['ping', 'ping'],
    ['csp_report', 'ping'],
    ['websocket', 'websocket'],
    ['other', 'other'],
    ['webbundle', 'other'],
    ['toString', 'other'],
  ])('maps %s to %s', (type, kind) => expect(mapResourceType(type)).toBe(kind));
});

describe('entryFromHookStart / applyHookEnd', () => {
  it('builds a pending hook entry', () => {
    expect(entryFromHookStart(2, start(), 'https://app.test/')).toEqual({
      id: 'h:2:f1',
      source: 'hook',
      kind: 'fetch',
      frameId: 2,
      frameUrl: 'https://app.test/',
      pageUrl: 'https://app.test/',
      method: 'POST',
      url: 'https://api.test/items?x=1',
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      requestBody: { kind: 'text', text: '{"a":1}', size: 7 },
      requestContentType: 'application/json',
      startTime: 10_000,
      state: 'pending',
    });
  });

  it('keeps the page\'s fetch/XHR options (they seed the replay defaults), as a copy', () => {
    const options = { credentials: 'omit', mode: 'cors', keepalive: true };
    const entry = entryFromHookStart(0, start({ options }), 'https://app.test/');
    expect(entry.requestOptions).toEqual(options);
    expect(entry.requestOptions).not.toBe(options);
    expect(entryFromHookStart(0, start({ options: {} }), 'https://app.test/').requestOptions).toBeUndefined();
  });

  it('applies the end without mutating the input', () => {
    const entry = hookEntry();
    const done = applyHookEnd(entry, end({ body: { kind: 'text', text: 'ok', size: 2 }, responseUrl: 'https://api.test/final', redirected: true }));
    expect(entry.state).toBe('pending');
    expect(done).toMatchObject({
      state: 'done',
      endTime: 10_250,
      status: 200,
      statusText: 'OK',
      responseHeaders: [{ name: 'a', value: 'b' }],
      responseBody: { kind: 'text', text: 'ok', size: 2 },
      responseUrl: 'https://api.test/final',
      redirected: true,
    });
    expect(applyHookEnd(entry, { hookId: 'f1', state: 'error', error: 'TypeError: Failed to fetch', endTime: 0 })).toMatchObject({
      state: 'error',
      error: 'TypeError: Failed to fetch',
      endTime: 10_000,
    });
  });

  it('does not let an opaque end erase status known from webRequest', () => {
    const merged = mergeWire(hookEntry(), wrEntry({ status: 302, statusText: 'Found', responseHeaders: [{ name: 'Location', value: '/x' }] }));
    const done = applyHookEnd(merged, end({ status: 0, statusText: '', headers: [], responseType: 'opaqueredirect' }));
    expect(done).toMatchObject({ status: 302, statusText: 'Found', responseHeaders: [{ name: 'Location', value: '/x' }] });
  });
});

describe('matching', () => {
  it('normalizes URLs for matching', () => {
    expect(normalizeUrlForMatch('https://API.test:443/a b?q=1#frag')).toBe('https://api.test/a%20b?q=1');
    expect(normalizeUrlForMatch('not a url#x')).toBe('not a url');
  });

  it('finds the hook entry of a webRequest event', () => {
    const hook = hookEntry({ url: 'https://api.test/items?x=1#ignored', method: 'post' });
    expect(findHookMatch([hook], wrEntry(), 3000)).toBe(hook.id);
    expect(findHookMatch([hook], wrEntry({ kind: 'ping' }), 3000)).toBe(hook.id);
  });

  it('rejects other frames, methods, URLs, times, kinds and sources', () => {
    const hook = hookEntry();
    expect(findHookMatch([hook], wrEntry({ frameId: 1 }), 3000)).toBeNull();
    expect(findHookMatch([hook], wrEntry({ method: 'GET' }), 3000)).toBeNull();
    expect(findHookMatch([hook], wrEntry({ url: 'https://api.test/items?x=2' }), 3000)).toBeNull();
    expect(findHookMatch([hook], wrEntry({ startTime: 13_001 }), 3000)).toBeNull();
    expect(findHookMatch([hook], wrEntry({ kind: 'script' }), 3000)).toBeNull();
    expect(findHookMatch([hook], { ...wrEntry(), source: 'hook' }, 3000)).toBeNull();
    expect(findHookMatch([{ ...hook, restored: true }], wrEntry(), 3000)).toBeNull();
  });

  it('skips entries linked to another request and calls made after the network request started', () => {
    const linkedElsewhere = hookEntry({ id: 'h:0:a', startTime: 10_000, wire: { requestId: 'other' } });
    const queued = hookEntry({ id: 'h:0:b', startTime: 8_000 });
    const after = hookEntry({ id: 'h:0:c', startTime: 10_100 });
    expect(findHookMatch([linkedElsewhere, queued, after], wrEntry(), 3000)).toBe('h:0:b');
    expect(findHookMatch([after], wrEntry(), 3000)).toBeNull();
    const linkedHere = hookEntry({ id: 'h:0:d', startTime: 10_010, wire: { requestId: '77' } });
    expect(findHookMatch([queued, linkedHere], wrEntry(), 3000)).toBe('h:0:d');
  });

  it('pairs identical sequential calls in call order, never with a call that failed before the network', () => {
    // fetch(r) then fetch(r) again with a used Request body: the second call rejects without a request.
    const real = hookEntry({ id: 'h:0:real', startTime: 1000, state: 'done', endTime: 1010 });
    const failed = hookEntry({ id: 'h:0:failed', startTime: 1003, state: 'error', endTime: 1003, error: 'TypeError' });
    const wr = wrEntry({ startTime: 1002 });
    expect(findHookMatch([real, failed], wr, 3000)).toBe('h:0:real');
    expect(findHookMatch([failed], wrEntry({ startTime: 1010 }), 3000)).toBeNull();
    // Back-to-back identical requests: first network request -> first call.
    const h1 = hookEntry({ id: 'h:0:1', startTime: 1000 });
    const h2 = hookEntry({ id: 'h:0:2', startTime: 1001 });
    const wr1 = wrEntry({ id: 'w:1', startTime: 1002, wire: { requestId: '1' } });
    const wr2 = wrEntry({ id: 'w:2', startTime: 1003, wire: { requestId: '2' } });
    expect(findHookMatch([h1, h2], wr1, 3000)).toBe('h:0:1');
    expect(findHookMatch([{ ...h1, wire: { requestId: '1' } }, h2], wr2, 3000)).toBe('h:0:2');
    expect(findWebRequestMatch([wr2, wr1], h1, 3000)).toBe('w:1');
    // Beacons end before their network request starts.
    const beacon = hookEntry({ kind: 'beacon', state: 'done', startTime: 1000, endTime: 1000 });
    expect(findHookMatch([beacon], wrEntry({ kind: 'ping', startTime: 1050 }), 3000)).toBe(beacon.id);
  });

  it('matches requests of about:blank frames attributed by webRequest to an ancestor frame', () => {
    const blank = hookEntry({ frameId: 4, frameUrl: 'about:blank' });
    expect(findHookMatch([blank], wrEntry({ frameId: 0 }), 3000)).toBe(blank.id);
    expect(findWebRequestMatch([wrEntry({ frameId: 0 })], blank, 3000)).toBe('w:77');
    const real = hookEntry({ frameId: 4, frameUrl: 'https://x/' });
    expect(findHookMatch([real], wrEntry({ frameId: 0 }), 3000)).toBeNull();
    expect(findWebRequestMatch([wrEntry({ frameId: 0 })], real, 3000)).toBeNull();
  });

  it('finds an unlinked webRequest entry for a new hook entry', () => {
    const wr = wrEntry();
    const hook = hookEntry();
    expect(findWebRequestMatch([wr, hook], hook, 3000)).toBe('w:77');
    expect(findWebRequestMatch([wr], { ...hook, wire: { requestId: '1' } }, 3000)).toBeNull();
    expect(findWebRequestMatch([wrEntry({ kind: 'document' })], hook, 3000)).toBeNull();
    expect(findWebRequestMatch([wrEntry({ startTime: 20_000 })], hook, 3000)).toBeNull();
    const closer = wrEntry({ id: 'w:78', startTime: 10_001, wire: { requestId: '78' } });
    expect(findWebRequestMatch([wr, closer], hook, 3000)).toBe('w:78');
  });
});

describe('mergeWire', () => {
  it('sets wire info and fills response fields only when missing', () => {
    const wr = wrEntry({
      status: 201,
      statusText: 'Created',
      responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }],
      fromCache: false,
      initiator: 'https://app.test',
      wire: { requestId: '77', type: 'xmlhttprequest', ip: '1.2.3.4', statusCode: 201, requestHeaders: [{ name: 'Cookie', value: 'sid=1' }], responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }] },
    });
    const pending = mergeWire(hookEntry(), wr);
    expect(pending.wire).toEqual({
      requestId: '77',
      type: 'xmlhttprequest',
      ip: '1.2.3.4',
      statusCode: 201,
      requestHeaders: [{ name: 'Cookie', value: 'sid=1' }],
      responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }],
      fromCache: false,
    });
    expect(pending).toMatchObject({ status: 201, statusText: 'Created', fromCache: false, initiator: 'https://app.test' });
    expect(pending.requestHeaders).toEqual([{ name: 'Content-Type', value: 'application/json' }]);
    expect(pending.requestBody).toEqual(start().body);

    const done = applyHookEnd(hookEntry(), end());
    const merged = mergeWire(done, wr);
    expect(merged).toMatchObject({ status: 200, statusText: 'OK', responseHeaders: [{ name: 'a', value: 'b' }], state: 'done' });
  });

  it('never shows the network status on a call that failed without one', () => {
    const failed = applyHookEnd(hookEntry(), { hookId: 'f1', state: 'error', error: 'TypeError: Failed to fetch', endTime: 10_100 });
    const merged = mergeWire(failed, wrEntry({ status: 200, statusText: 'OK', wire: { requestId: '77', statusCode: 200 } }));
    expect(merged.status).toBeUndefined();
    expect(merged.statusText).toBeUndefined();
    expect(merged.wire?.statusCode).toBe(200);
  });

  it('keeps identity for repeated identical snapshots', () => {
    const once = mergeWire(hookEntry(), wrEntry());
    expect(mergeWire(once, wrEntry())).toBe(once);
    expect(mergeWire(once, wrEntry({ wire: { requestId: '77', statusCode: 200 } }))).not.toBe(once);
  });
});

describe('toPreserved', () => {
  it('prefixes the id once, marks restored and caps bodies', () => {
    const entry = applyHookEnd(hookEntry(), end({ body: { kind: 'text', text: 'x'.repeat(100), size: 100 } }));
    const preserved = toPreserved(entry, 10);
    expect(preserved).toMatchObject({ id: 'r:h:0:f1', restored: true, responseBody: { kind: 'text', text: 'x'.repeat(10), size: 100, truncated: true } });
    expect(preserved.requestBody).toBe(entry.requestBody);
    expect(toPreserved(preserved, 10).id).toBe('r:h:0:f1');
    expect('responseBody' in toPreserved(hookEntry(), 10)).toBe(false);
    expect(entry.id).toBe('h:0:f1');
  });

  it('never persists credential header values', () => {
    const entry: RequestEntry = {
      ...applyHookEnd(hookEntry({ requestHeaders: [{ name: 'Authorization', value: 'Bearer t0k' }, { name: 'X-A', value: '1' }] }), end({ headers: [{ name: 'set-cookie', value: 'sid=1; HttpOnly' }] })),
      wire: { requestId: '9', requestHeaders: [{ name: 'Cookie', value: 'sid=1' }, { name: 'Proxy-Authorization', value: 'Basic x' }], responseHeaders: [{ name: 'Set-Cookie', value: 'sid=1' }] },
    };
    const preserved = toPreserved(entry, 1000);
    const text = JSON.stringify(preserved);
    expect(text).not.toMatch(/t0k|sid=1|Basic x/);
    expect(preserved.requestHeaders).toEqual([{ name: 'Authorization', value: REDACTED_HEADER_VALUE }, { name: 'X-A', value: '1' }]);
    expect(entry.wire?.requestHeaders?.[0]?.value).toBe('sid=1'); // input untouched
  });
});

describe('pickEvictions', () => {
  const e = (id: string, kind: RequestEntry['kind'], startTime: number): RequestEntry => ({ ...hookEntry(), id, kind, startTime });

  it('evicts static resources first, oldest first', () => {
    const list = [e('x1', 'xhr', 1), e('img', 'image', 5), e('doc', 'document', 2), e('css', 'stylesheet', 3), e('f', 'fetch', 4)];
    expect(pickEvictions(list, 4)).toEqual(['css']);
    expect(pickEvictions(list, 2)).toEqual(['css', 'img', 'x1']);
    expect(pickEvictions(list, 5)).toEqual([]);
    expect(pickEvictions(list, 0)).toHaveLength(5);
  });

  it('never evicts manual entries or protected ids (the user’s edits, runs, selection)', () => {
    const list = [e('important', 'fetch', 1), e('m:1', 'manual', 2), ...Array.from({ length: 10 }, (_, i) => e(`poll${i}`, 'fetch', 10 + i))];
    expect(pickEvictions(list, 10, new Set(['important']))).toEqual(['poll0', 'poll1']);
    // Only protected entries left: the list stays above the cap.
    expect(pickEvictions(list.slice(0, 2), 1, new Set(['important']))).toEqual([]);
    expect(pickEvictions(list, 10)).toEqual(['important', 'poll0']);
  });
});

describe('isValidHookStart', () => {
  it('accepts well-formed payloads', () => {
    expect(isValidHookStart(start())).toBe(true);
    expect(isValidHookStart(start({ body: null, contentType: null, options: { credentials: 'include', keepalive: true } }))).toBe(true);
    expect(isValidHookStart(start({ kind: 'beacon', method: 'X-CUSTOM' }))).toBe(true);
    expect(isValidHookStart(start({ body: { kind: 'formData', entries: [{ name: 'f', type: 'file', fileName: 'a', mime: '', size: 1 }] } }))).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['empty hookId', start({ hookId: '' })],
    ['long hookId', start({ hookId: 'x'.repeat(201) })],
    ['unknown kind', { ...start(), kind: 'websocket' }],
    ['method with spaces', start({ method: 'GE T' })],
    ['method over 32 chars', start({ method: 'M'.repeat(33) })],
    ['empty url', start({ url: '' })],
    ['url over 64 KB', start({ url: `https://x.test/${'a'.repeat(64 * 1024)}` })],
    ['too many headers', start({ headers: Array.from({ length: 501 }, () => ({ name: 'a', value: 'b' })) })],
    ['non-string header value', { ...start(), headers: [{ name: 'a', value: 1 }] }],
    ['unknown body kind', { ...start(), body: { kind: 'stream' } }],
    ['text body without size', { ...start(), body: { kind: 'text', text: 'x' } }],
    ['negative body size', { ...start(), body: { kind: 'base64', base64: '', size: -1 } }],
    ['bad formData entry', { ...start(), body: { kind: 'formData', entries: [{ name: 'f', type: 'file' }] } }],
    ['bad formFields', { ...start(), body: { kind: 'formFields', fields: [{ name: 1, value: 'x' }] } }],
    ['undefined body', { ...start(), body: undefined }],
    ['numeric contentType', { ...start(), contentType: 5 }],
    ['NaN startTime', start({ startTime: Number.NaN })],
    ['Infinity startTime', start({ startTime: Infinity })],
    ['numeric frameUrl', { ...start(), frameUrl: 1 }],
    ['bad options', { ...start(), options: { keepalive: 'yes' } }],
  ])('rejects %s', (_label, value) => expect(isValidHookStart(value)).toBe(false));
});

describe('isValidHookEnd', () => {
  it('accepts well-formed payloads', () => {
    expect(isValidHookEnd(end())).toBe(true);
    expect(isValidHookEnd({ hookId: 'b1', state: 'done', endTime: 1 })).toBe(true);
    expect(isValidHookEnd(end({ body: null, responseType: 'opaque', redirected: false, error: 'x' }))).toBe(true);
  });

  it.each([
    ['unknown state', { ...end(), state: 'pending' }],
    ['missing endTime', { hookId: 'a', state: 'done' }],
    ['infinite status', end({ status: Infinity })],
    ['fractional status', end({ status: 200.5 })],
    ['status over 999', end({ status: 1000 })],
    ['bad headers', { ...end(), headers: 'a: b' }],
    ['bad body', { ...end(), body: { kind: 'text' } }],
    ['bad redirected', { ...end(), redirected: 'yes' }],
    ['long responseUrl', end({ responseUrl: 'x'.repeat(64 * 1024 + 1) })],
  ])('rejects %s', (_label, value) => expect(isValidHookEnd(value)).toBe(false));
});

describe('isValidSerializedBody', () => {
  it('checks every kind', () => {
    expect(isValidSerializedBody({ kind: 'unavailable', reason: 'x' })).toBe(true);
    expect(isValidSerializedBody({ kind: 'unavailable' })).toBe(false);
    expect(isValidSerializedBody({ kind: 'text', text: '', size: 0, truncated: 'no' })).toBe(false);
  });
});

describe('capBody', () => {
  it('returns the same body when it fits', () => {
    const body: SerializedBody = { kind: 'text', text: 'héllo', size: 6 };
    expect(capBody(body, 6)).toBe(body);
    expect(capBody(body, Infinity)).toBe(body);
    expect(capBody(null, 1)).toBeNull();
    expect(capBody(undefined, 1)).toBeNull();
  });

  it('truncates text by UTF-8 bytes at a character boundary', () => {
    expect(capBody({ kind: 'text', text: 'aé😀b', size: 8 }, 6)).toEqual({ kind: 'text', text: 'aé', size: 8, truncated: true });
    expect(capBody({ kind: 'text', text: 'aé😀b', size: 8 }, 7)).toEqual({ kind: 'text', text: 'aé😀', size: 8, truncated: true });
    expect(capBody({ kind: 'text', text: 'abc', size: 1 }, 2)).toEqual({ kind: 'text', text: 'ab', size: 3, truncated: true });
    expect(capBody({ kind: 'text', text: 'abc', size: 3 }, -5)).toEqual({ kind: 'text', text: '', size: 3, truncated: true });
  });

  it('truncates base64 by decoded bytes', () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    const capped = capBody({ kind: 'base64', base64: bytesToBase64(bytes), size: 10 }, 4);
    expect(capped).toEqual({ kind: 'base64', base64: bytesToBase64(bytes.subarray(0, 4)), size: 10, truncated: true });
    expect(base64ToBytes(capped?.kind === 'base64' ? capped.base64 : '')).toEqual(bytes.subarray(0, 4));
    expect(capBody({ kind: 'base64', base64: '!!!!!!!!', size: 6 }, 2)).toEqual({ kind: 'unavailable', reason: 'Body was not valid base64' });
  });

  it('shares one budget across form values', () => {
    const fd: SerializedBody = {
      kind: 'formData',
      entries: [
        { name: 'a', type: 'text', value: 'abcd' },
        { name: 'f', type: 'file', fileName: 'x', mime: '', size: 3, base64: bytesToBase64(Uint8Array.of(1, 2, 3)) },
        { name: 'b', type: 'text', value: 'xyz' },
      ],
    };
    expect(capBody(fd, 5)).toEqual({
      kind: 'formData',
      entries: [
        { name: 'a', type: 'text', value: 'abcd' },
        { name: 'f', type: 'file', fileName: 'x', mime: '', size: 3, truncated: true },
        { name: 'b', type: 'text', value: 'x', truncated: true },
      ],
    });
    expect(capBody(fd, 100)).toBe(fd);
    const fields: SerializedBody = { kind: 'formFields', fields: [{ name: 'a', value: 'aaaa' }, { name: 'b', value: 'bb' }] };
    expect(capBody(fields, 5)).toEqual({ kind: 'formFields', fields: [{ name: 'a', value: 'aaaa' }, { name: 'b', value: 'b' }] });
  });

  it('accepts the truncated flag on FormData text entries and rejects a non-boolean one', () => {
    expect(isValidSerializedBody({ kind: 'formData', entries: [{ name: 'a', type: 'text', value: 'x', truncated: true }] })).toBe(true);
    expect(isValidSerializedBody({ kind: 'formData', entries: [{ name: 'a', type: 'text', value: 'x', truncated: 'yes' }] })).toBe(false);
  });

  it('leaves unavailable bodies alone', () => {
    const body: SerializedBody = { kind: 'unavailable', reason: 'x' };
    expect(capBody(body, 0)).toBe(body);
  });
});
