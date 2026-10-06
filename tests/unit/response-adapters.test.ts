import { describe, expect, it } from 'vitest';
import type { ReplayRequest, ReplayResult, RequestEntry, TestRun } from '../../src/shared/types';
import {
  displayStatusText,
  entryToResponseData,
  entryToResponseDataWith,
  hasComparableBody,
  isOpaque,
  kindLabel,
  NOT_SENT_NOTE,
  reasonPhrase,
  resultToResponseData,
  runToResponseData,
  statusLabel,
} from '../../src/ui/response/adapters';

function entry(over: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'GET',
    url: 'https://api.test/items?q=1',
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1_000,
    endTime: 1_250,
    state: 'done',
    status: 200,
    statusText: 'OK',
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    responseBody: { kind: 'text', text: '{"a":1}', size: 7 },
    ...over,
  };
}

function result(over: Partial<ReplayResult> = {}): ReplayResult {
  return {
    runId: 'r1',
    ok: true,
    status: 201,
    statusText: '',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: { kind: 'text', text: '{"ok":true}', size: 11 },
    url: 'https://api.test/items',
    redirected: false,
    type: 'cors',
    timing: { start: 5_000, headers: 5_040, end: 5_100 },
    size: 11,
    ...over,
  };
}

const request: ReplayRequest = {
  runId: 'r1',
  entryId: 'h:0:1',
  mode: 'page',
  frameId: 0,
  method: 'GET',
  url: 'https://api.test/items',
  headers: [],
  body: { kind: 'none' },
  credentials: 'include',
  redirect: 'follow',
  timeoutMs: 30_000,
  responseBodyCap: 1024,
};

describe('entryToResponseData', () => {
  it('maps a hook-captured response with its body', () => {
    const data = entryToResponseData(
      entry({ responseUrl: 'https://api.test/final', redirected: true }),
    );
    expect(data).toMatchObject({
      state: 'done',
      status: 200,
      statusText: 'OK',
      url: 'https://api.test/final',
      redirected: true,
      durationMs: 250,
      size: 7,
    });
    expect(data.body).toEqual({ kind: 'text', text: '{"a":1}', size: 7 });
    expect(data.bodyNote).toBeUndefined();
  });

  it('falls back to the request URL and leaves duration undefined while pending', () => {
    const data = entryToResponseData(entry({ state: 'pending', endTime: undefined, status: undefined, responseBody: undefined }));
    expect(data.url).toBe('https://api.test/items?q=1');
    expect(data.durationMs).toBeUndefined();
    expect(data.bodyNote).toBe('Waiting for the response…');
  });

  it('explains missing bodies of webRequest entries with the entry kind', () => {
    const data = entryToResponseData(
      entry({
        source: 'webRequest',
        kind: 'document',
        status: undefined,
        responseHeaders: undefined,
        responseBody: undefined,
        wire: {
          requestId: '42',
          statusCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'text/html' },
            { name: 'content-length', value: '5120' },
          ],
        },
      }),
    );
    expect(data.body).toBeNull();
    expect(data.status).toBe(200);
    expect(data.headers).toHaveLength(2);
    expect(data.size).toBe(5120);
    expect(data.bodyNote).toBe(
      "Response body isn't available for document requests captured from the network layer — send a test request to see it.",
    );
  });

  it('prefers the more complete header list (network level vs page visible)', () => {
    const data = entryToResponseData(
      entry({
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        wire: {
          requestId: '1',
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'set-cookie', value: 'a=1' },
          ],
        },
      }),
    );
    expect(data.headers.map((h) => h.name)).toEqual(['content-type', 'set-cookie']);
  });

  it('describes beacons, manual entries, failures and empty statuses', () => {
    expect(entryToResponseData(entry({ kind: 'beacon', status: undefined, responseBody: null })).bodyNote).toMatch(/sendBeacon/);
    const manual = entryToResponseData(entry({ source: 'manual', kind: 'manual', status: undefined, responseBody: undefined }));
    expect(manual.bodyNote).toBe(NOT_SENT_NOTE);
    expect(manual.body).toBeNull();
    expect(entryToResponseData(entry({ state: 'error', error: 'Failed to fetch', responseBody: undefined })).bodyNote).toMatch(/failed/);
    expect(entryToResponseData(entry({ state: 'aborted', responseBody: undefined })).bodyNote).toMatch(/aborted/);
    expect(entryToResponseData(entry({ status: 204, statusText: '', responseBody: null })).bodyNote).toBe('No body (204 No Content).');
    expect(entryToResponseData(entry({ method: 'HEAD', responseBody: null })).bodyNote).toBe('HEAD responses have no body.');
  });

  it('turns unavailable bodies into a note with the reason', () => {
    const data = entryToResponseData(entry({ responseBody: { kind: 'unavailable', reason: 'opaque response' } }));
    expect(data.body).toBeNull();
    expect(data.bodyNote).toBe('Response body unavailable — opaque response');
  });

  it('mentions streaming and disabled capture', () => {
    const sse = entry({ responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], responseBody: null });
    expect(entryToResponseData(sse).bodyNote).toMatch(/Streaming responses \(text\/event-stream\)/);
    const off = entryToResponseDataWith(entry({ responseBody: null }), { captureResponseBodies: false });
    expect(off.bodyNote).toMatch(/capture is disabled/);
    expect(entryToResponseData(entry({ responseBody: null })).bodyNote).toMatch(/wasn't captured/);
  });
});

describe('resultToResponseData', () => {
  it('maps a successful replay', () => {
    const data = resultToResponseData(result());
    expect(data).toMatchObject({ state: 'done', status: 201, durationMs: 100, size: 11, type: 'cors' });
    expect(data.error).toBeUndefined();
    expect(data.bodyNote).toBeUndefined();
  });

  it('maps network errors with hint and no status', () => {
    const data = resultToResponseData(
      result({ ok: false, status: 0, body: null, size: 0, error: 'Failed to fetch', errorHint: 'Try Extension mode' }),
    );
    expect(data.state).toBe('error');
    expect(data.status).toBeUndefined();
    expect(data.error).toBe('Failed to fetch');
    expect(data.errorHint).toBe('Try Extension mode');
    expect(data.bodyNote).toMatch(/failed/);
  });

  it('maps timeouts and aborts', () => {
    const timeout = resultToResponseData(result({ ok: false, status: 0, body: null, timedOut: true }));
    expect(timeout.state).toBe('error');
    expect(timeout.error).toBe('Timed out');
    expect(timeout.bodyNote).toMatch(/Timed out/);
    const aborted = resultToResponseData(result({ ok: false, status: 0, body: null, aborted: true }));
    expect(aborted.state).toBe('aborted');
    expect(aborted.error).toBeUndefined();
    expect(aborted.bodyNote).toMatch(/Cancelled/);
  });

  it('explains opaque responses', () => {
    const data = resultToResponseData(result({ status: 0, type: 'opaqueredirect', body: null, size: 0 }));
    expect(data.status).toBe(0);
    expect(isOpaque(data)).toBe(true);
    expect(statusLabel(data)).toBe('Opaque');
    expect(data.bodyNote).toMatch(/Redirect not followed/);
  });
});

describe('runToResponseData', () => {
  it('maps running runs to the running state', () => {
    const run: TestRun = { runId: 'r1', entryId: 'e', request, startedAt: 1, state: 'running' };
    const data = runToResponseData(run);
    expect(data.state).toBe('running');
    expect(data.body).toBeNull();
    expect(statusLabel(data)).toBe('Sending');
  });

  it('uses the result of finished runs (and the request method for HEAD notes)', () => {
    const run: TestRun = { runId: 'r1', entryId: 'e', request: { ...request, method: 'HEAD' }, startedAt: 1, state: 'done', result: result({ body: null, status: 200 }) };
    const data = runToResponseData(run);
    expect(data.status).toBe(200);
    expect(data.bodyNote).toBe('HEAD responses have no body.');
  });

  it('handles finished runs without a result', () => {
    const run: TestRun = { runId: 'r1', entryId: 'e', request, startedAt: 1, state: 'error' };
    expect(runToResponseData(run)).toMatchObject({ state: 'error', error: 'No result was recorded for this run.' });
  });
});

describe('labels', () => {
  it('statusLabel covers every state', () => {
    expect(statusLabel({ state: 'done', status: 404 })).toBe('404');
    expect(statusLabel({ state: 'pending' })).toBe('Pending');
    expect(statusLabel({ state: 'error' })).toBe('Error');
    expect(statusLabel({ state: 'aborted' })).toBe('Aborted');
    expect(statusLabel({ state: 'done' })).toBe('—');
  });

  it('fills empty HTTP/2 status texts with the reason phrase', () => {
    expect(reasonPhrase(404)).toBe('Not Found');
    expect(reasonPhrase(299)).toBe('');
    expect(reasonPhrase(undefined)).toBe('');
    expect(displayStatusText({ status: 201, statusText: '' })).toBe('Created');
    expect(displayStatusText({ status: 200, statusText: 'Fine' })).toBe('Fine');
  });

  it('kindLabel and hasComparableBody', () => {
    expect(kindLabel('xhr')).toBe('XHR/fetch');
    expect(kindLabel('stylesheet')).toBe('stylesheet');
    expect(hasComparableBody(resultToResponseData(result()))).toBe(true);
    expect(hasComparableBody(entryToResponseData(entry({ responseBody: null })))).toBe(false);
    expect(hasComparableBody(null)).toBe(false);
  });
});
