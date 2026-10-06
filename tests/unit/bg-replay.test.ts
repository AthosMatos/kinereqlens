import { afterEach, describe, expect, it, vi } from 'vitest';
import { DnrManager } from '../../src/background/dnr';
import {
  PAGE_REPLAY_GRACE_MS,
  ReplayRunner,
  decodeResponseBody,
  errorResult,
  isReplayResultFor,
  readBodyCapped,
} from '../../src/background/replay';
import { ReplayObserver, mergeSetCookies } from '../../src/background/replay-observer';
import type { OwnHeadersDetails } from '../../src/background/replay-observer';
import { KeepAlive } from '../../src/background/util';
import type { TabMessage } from '../../src/shared/messages';
import type { ReplayRequest, ReplayResult } from '../../src/shared/types';

// While src/lib/capture.ts (owned by lib-body) is still a stub, the header helper the observer calls falls back
// to minimal stand-ins of its documented contract; once implemented, the real functions are used.
const { captureWithFallback } = vi.hoisted(() => {
  type Capture = typeof import('../../src/lib/capture');
  const reference: Partial<Capture> = {
    webRequestHeadersToPairs: (headers) => (headers ?? []).map(({ name, value }) => ({ name, value: value ?? '' })),
  };
  function captureWithFallback(actual: Capture): Capture {
    const wrapped: Record<string, unknown> = { ...actual };
    for (const [name, stand] of Object.entries(reference) as Array<[keyof Capture, (...args: unknown[]) => unknown]>) {
      const real = actual[name] as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]) => {
        try {
          return real(...args);
        } catch (err) {
          if (err instanceof Error && err.message === 'not implemented') return stand(...args);
          throw err;
        }
      };
    }
    return wrapped as Capture;
  }
  return { captureWithFallback };
});
vi.mock('../../src/lib/capture', async (importOriginal) => captureWithFallback(await importOriginal()));

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const INITIATOR = `chrome-extension://${EXT_ID}`;
const TAB = 3;

type Rule = chrome.declarativeNetRequest.Rule;
type UpdateOptions = chrome.declarativeNetRequest.UpdateRuleOptions;

const enc = new TextEncoder();

function stream(...chunks: string[] | Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
      controller.close();
    },
  });
}

function request(overrides: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    runId: 'run-1',
    entryId: 'h:0:1',
    mode: 'extension',
    frameId: 0,
    method: 'POST',
    url: 'https://api.example.com/items?a=1',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: { kind: 'text', text: '{"a":1}' },
    credentials: 'include',
    redirect: 'follow',
    timeoutMs: 5_000,
    responseBodyCap: 1024,
    ...overrides,
  };
}

function fakeDnr() {
  const rules = new Map<number, Rule>();
  const api = {
    async getSessionRules(): Promise<Rule[]> {
      return [...rules.values()];
    },
    async updateSessionRules(options: UpdateOptions): Promise<void> {
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
    },
    async isRegexSupported(): Promise<{ isSupported: boolean }> {
      return { isSupported: true };
    },
  };
  return { api: api as unknown as typeof chrome.declarativeNetRequest, rules };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function harness(fetchImpl: FetchImpl, sendToFrame?: (tabId: number, frameId: number, message: TabMessage) => Promise<unknown>) {
  const dnr = fakeDnr();
  const observer = new ReplayObserver(INITIATOR);
  const calls: Array<{ url: string; init: RequestInit; rulesInstalled: Rule[] }> = [];
  const runner = new ReplayRunner({
    dnr: new DnrManager(EXT_ID, dnr.api),
    observer,
    keepAlive: new KeepAlive(() => undefined),
    sendToFrame: sendToFrame ?? (() => Promise.reject(new Error('unexpected sendToFrame'))),
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init, rulesInstalled: [...dnr.rules.values()] });
      return fetchImpl(url, init);
    }) as typeof fetch,
  });
  return { runner, observer, calls, dnr };
}

/** A fetch that only settles when its signal aborts (like a hanging server). */
const hangingFetch: FetchImpl = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

function ownHeaders(overrides: Partial<OwnHeadersDetails> = {}): OwnHeadersDetails {
  return {
    tabId: -1,
    requestId: '99',
    url: 'https://api.example.com/items?a=1',
    method: 'POST',
    initiator: INITIATOR,
    statusCode: 200,
    statusLine: 'HTTP/1.1 200 OK',
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Set-Cookie', value: 'sid=new; HttpOnly' },
      { name: 'Set-Cookie', value: 'theme=dark' },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('decodeResponseBody', () => {
  it('decodes textual types as text, honoring the charset', () => {
    expect(decodeResponseBody(enc.encode('{"é":1}'), 'application/json; charset=utf-8', false)).toEqual({
      kind: 'text',
      text: '{"é":1}',
      size: 8,
    });
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeResponseBody(latin1, 'text/plain; charset=iso-8859-1', false)).toMatchObject({ kind: 'text', text: 'café' });
  });

  it('keeps binary types as base64 and sniffs untyped bodies', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    expect(decodeResponseBody(png, 'image/png', false)).toEqual({ kind: 'base64', base64: 'iVBORwAB', size: 6 });
    expect(decodeResponseBody(enc.encode('plain'), null, false)).toMatchObject({ kind: 'text', text: 'plain' });
    expect(decodeResponseBody(png, undefined, true)).toMatchObject({ kind: 'base64', truncated: true });
  });
});

describe('readBodyCapped', () => {
  it('reads every chunk below the cap', async () => {
    const read = await readBodyCapped(stream('ab', 'cd'), 10);
    expect(new TextDecoder().decode(read.bytes)).toBe('abcd');
    expect(read.truncated).toBe(false);
  });

  it('stops and cancels at the cap', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode('0123456789'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const read = await readBodyCapped(source, 25);
    expect(read.bytes.byteLength).toBe(25);
    expect(read.truncated).toBe(true);
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('returns what arrived before a stream error', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(enc.encode('part'));
        else controller.error(new Error('reset'));
      },
    });
    const read = await readBodyCapped(source, 100);
    expect(new TextDecoder().decode(read.bytes)).toBe('part');
    expect(read.error).toBeInstanceOf(Error);
  });
});

describe('result helpers', () => {
  it('errorResult builds a failed run', () => {
    expect(errorResult('r', 'https://x/', 10, 'boom', { aborted: true }, 25)).toEqual({
      runId: 'r',
      ok: false,
      status: 0,
      statusText: '',
      headers: [],
      body: null,
      url: 'https://x/',
      redirected: false,
      timing: { start: 10, end: 25 },
      size: 0,
      error: 'boom',
      aborted: true,
    });
  });

  it('isReplayResultFor checks shape and run id', () => {
    const result = errorResult('r', 'https://x/', 1, 'e');
    expect(isReplayResultFor(result, 'r')).toBe(true);
    expect(isReplayResultFor(result, 'other')).toBe(false);
    expect(isReplayResultFor({ runId: 'r' }, 'r')).toBe(false);
    expect(isReplayResultFor(undefined, 'r')).toBe(false);
  });

  it('mergeSetCookies adds hidden Set-Cookie lines once', () => {
    const hop = { url: 'u', statusCode: 200, statusText: 'OK', headers: [{ name: 'Set-Cookie', value: 'a=1' }] };
    expect(mergeSetCookies([{ name: 'content-type', value: 'text/plain' }], hop)).toEqual([
      { name: 'content-type', value: 'text/plain' },
      { name: 'set-cookie', value: 'a=1' },
    ]);
    const already = [{ name: 'set-cookie', value: 'b=2' }];
    expect(mergeSetCookies(already, hop)).toBe(already);
    expect(mergeSetCookies(already, undefined)).toBe(already);
  });
});

describe('ReplayObserver', () => {
  it('only records requests this extension initiated without a tab', async () => {
    const observer = new ReplayObserver(INITIATOR);
    const watch = observer.watch('post', 'https://api.example.com/items?a=1');
    observer.onHeadersReceived(ownHeaders({ initiator: 'https://evil.example' }));
    observer.onHeadersReceived(ownHeaders({ tabId: 4 }));
    observer.onHeadersReceived(ownHeaders({ method: 'GET' }));
    expect(watch.hops).toEqual([]);
    observer.onHeadersReceived(ownHeaders());
    expect(watch.hops).toHaveLength(1);
    expect(watch.requestId).toBe('99');
    observer.unwatch(watch);
    expect(observer.size).toBe(0);
  });

  it('follows redirect hops by request id and waits briefly for a late hop', async () => {
    const observer = new ReplayObserver(INITIATOR);
    const watch = observer.watch('GET', 'https://a.example/start');
    observer.onHeadersReceived(ownHeaders({ method: 'GET', url: 'https://a.example/start', statusCode: 302 }));
    const late = observer.hopFor(watch, 'https://b.example/final', 50);
    observer.onHeadersReceived(ownHeaders({ method: 'GET', url: 'https://b.example/final' }));
    await expect(late).resolves.toMatchObject({ url: 'https://b.example/final', statusCode: 200, statusText: 'OK' });
    await expect(observer.hopFor(watch, 'https://never.example/', 5)).resolves.toBeUndefined();
  });
});

describe('ReplayRunner — extension mode', () => {
  it('sends with fetch, applying browser-controlled headers through a temporary DNR rule', async () => {
    const { runner, calls, dnr } = harness(async () => new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' } }));
    const result = await runner.run(
      TAB,
      request({
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Cookie', value: 'sid=1' },
          { name: 'Origin', value: 'https://app.example.com' },
          { name: 'Host', value: 'evil.example' },
        ],
      }),
      ['Bad Name'],
    );

    expect(calls).toHaveLength(1);
    const { init, rulesInstalled } = calls[0];
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'follow', cache: 'no-store', body: '{"a":1}' });
    expect([...(init.headers as Headers).entries()]).toEqual([['content-type', 'application/json']]);
    expect(rulesInstalled).toHaveLength(1);
    expect(rulesInstalled[0].action.requestHeaders).toEqual([
      { header: 'Cookie', operation: 'set', value: 'sid=1' },
      { header: 'Origin', operation: 'set', value: 'https://app.example.com' },
    ]);
    expect(dnr.rules.size).toBe(0); // removed once the response arrived

    expect(result).toMatchObject({
      runId: 'run-1',
      ok: true,
      status: 201,
      statusText: 'Created',
      body: { kind: 'text', text: '{"ok":true}', size: 11 },
      size: 11,
      url: 'https://api.example.com/items?a=1',
      redirected: false,
      appliedViaDnr: ['Cookie', 'Origin'],
      droppedHeaders: ['Bad Name', 'Host'],
    });
    expect(result.timing.headers).toBeGreaterThanOrEqual(result.timing.start);
    expect(result.timing.end).toBeGreaterThanOrEqual(result.timing.headers ?? 0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('does not install a rule when no browser-controlled header is present', async () => {
    const { runner, calls } = harness(async () => new Response(null, { status: 204 }));
    const result = await runner.run(TAB, request({ body: { kind: 'none' }, method: 'DELETE' }), []);
    expect(calls[0].rulesInstalled).toEqual([]);
    expect(calls[0].init.body).toBeUndefined();
    expect(result).toMatchObject({ ok: true, status: 204, body: null, size: 0 });
    expect(result.appliedViaDnr).toBeUndefined();
    expect(result.droppedHeaders).toBeUndefined();
  });

  it('decodes base64 request bodies to bytes', async () => {
    const { runner, calls } = harness(async () => new Response('ok'));
    await runner.run(TAB, request({ body: { kind: 'base64', base64: 'AAEC/w==' } }), []);
    expect([...(calls[0].init.body as Uint8Array)]).toEqual([0, 1, 2, 255]);
  });

  it('sends a text body as bytes when there is no Content-Type (fetch would add text/plain)', async () => {
    const { runner, calls } = harness(async () => new Response('ok'));
    await runner.run(TAB, request({ headers: [], body: { kind: 'text', text: '{"a":1}' } }), []);
    expect(calls[0].init.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(calls[0].init.body as Uint8Array)).toBe('{"a":1}');
    await runner.run(TAB, request({ headers: [{ name: 'content-type', value: 'application/json' }], body: { kind: 'text', text: '{"a":1}' } }), []);
    expect(calls[1].init.body).toBe('{"a":1}');
  });

  it('caps the response body and keeps binary bodies as base64', async () => {
    const big = new Uint8Array(3000).fill(7);
    const { runner } = harness(async () => new Response(big, { headers: { 'content-type': 'application/octet-stream' } }));
    const result = await runner.run(TAB, request({ responseBodyCap: 1000 }), []);
    expect(result.ok).toBe(true);
    expect(result.size).toBe(1000);
    expect(result.body).toMatchObject({ kind: 'base64', size: 1000, truncated: true });
  });

  it('merges Set-Cookie headers observed through webRequest', async () => {
    const { runner, observer } = harness(async () => {
      observer.onHeadersReceived(ownHeaders());
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const result = await runner.run(TAB, request(), []);
    expect(result.headers.filter((h) => h.name === 'set-cookie').map((h) => h.value)).toEqual(['sid=new; HttpOnly', 'theme=dark']);
    expect(observer.size).toBe(0);
  });

  it('reports a timeout', async () => {
    const { runner } = harness(hangingFetch);
    const result = await runner.run(TAB, request({ timeoutMs: 20 }), []);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result.error).toMatch(/Timed out/);
    expect(result.aborted).toBeUndefined();
  });

  it('can be aborted by run id, also while waiting for the DNR lock', async () => {
    const { runner } = harness(hangingFetch);
    const first = runner.run(TAB, request({ runId: 'a', headers: [{ name: 'Cookie', value: 'x=1' }] }), []);
    const second = runner.run(TAB, request({ runId: 'b', headers: [{ name: 'Cookie', value: 'x=2' }] }), []);
    await new Promise((r) => setTimeout(r, 5));
    await expect(runner.abort(TAB, 'b', 0, 'extension')).resolves.toBe(true);
    await expect(second).resolves.toMatchObject({ runId: 'b', ok: false, aborted: true });
    expect(await runner.abort(99, 'a', 0, 'extension')).toBe(false); // other tabs cannot abort it
    runner.abortTab(TAB);
    await expect(first).resolves.toMatchObject({ runId: 'a', aborted: true });
  });

  it('explains network errors', async () => {
    const { runner } = harness(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await runner.run(TAB, request(), []);
    expect(result).toMatchObject({ ok: false, error: 'Failed to fetch' });
    expect(result.errorHint).toMatch(/Network error/);
  });

  it('refuses a second concurrent run with the same id', async () => {
    const { runner } = harness(hangingFetch);
    const first = runner.run(TAB, request({ timeoutMs: 30 }), []);
    const duplicate = await runner.run(TAB, request(), []);
    expect(duplicate).toMatchObject({ ok: false, error: expect.stringMatching(/already in progress/) });
    await first;
  });
});

describe('ReplayRunner — page mode in a subframe', () => {
  const pageReq = request({ mode: 'page', frameId: 5, runId: 'p1' });

  it('forwards REPLAY_IN_PAGE to the frame and returns its result', async () => {
    const answer: ReplayResult = { ...errorResult('p1', pageReq.url, 1, ''), ok: true, status: 200, error: undefined };
    const sent: Array<[number, number, TabMessage]> = [];
    const { runner } = harness(hangingFetch, async (tabId, frameId, message) => {
      sent.push([tabId, frameId, message]);
      return answer;
    });
    const result = await runner.run(TAB, pageReq, ['Bad Name']);
    expect(sent).toEqual([[TAB, 5, { type: 'REPLAY_IN_PAGE', req: pageReq }]]);
    expect(result).toMatchObject({ ok: true, status: 200, droppedHeaders: ['Bad Name'] });
  });

  it('returns an error result when the frame is gone', async () => {
    const { runner } = harness(hangingFetch, () =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    );
    const result = await runner.run(TAB, pageReq, []);
    expect(result).toMatchObject({ ok: false, runId: 'p1', error: 'The frame that made this request is gone' });
    expect(result.errorHint).toMatch(/Extension mode/);
  });

  it('rejects malformed answers', async () => {
    const { runner } = harness(hangingFetch, async () => ({ runId: 'someone-else' }));
    expect(await runner.run(TAB, pageReq, [])).toMatchObject({ ok: false, error: 'The page frame did not return a result' });
  });

  it('gives up when the frame never answers', async () => {
    vi.useFakeTimers();
    const { runner } = harness(hangingFetch, () => new Promise(() => undefined));
    const pending = runner.run(TAB, { ...pageReq, timeoutMs: 1000 }, []);
    await vi.advanceTimersByTimeAsync(1000 + PAGE_REPLAY_GRACE_MS);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/No answer from the page frame/) });
  });

  it('forwards aborts to the frame', async () => {
    const sent: TabMessage[] = [];
    const { runner } = harness(hangingFetch, async (_tab, _frame, message) => {
      sent.push(message);
      return message.type === 'REPLAY_IN_PAGE' ? new Promise(() => undefined) : { ok: true };
    });
    const pending = runner.run(TAB, pageReq, []);
    await expect(runner.abort(TAB, 'p1', 5, 'page')).resolves.toBe(true);
    expect(sent[1]).toEqual({ type: 'ABORT_IN_PAGE', runId: 'p1' });
    // The frame never answers: the worker settles the run itself shortly after.
    await expect(pending).resolves.toMatchObject({ ok: false, aborted: true });
  });
});
