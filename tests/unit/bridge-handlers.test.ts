import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkQuery, LinkQueryResults, LinkState } from '../../src/shared/claude-link';
import type { TabMessage } from '../../src/shared/messages';
import type { RequestEntry, Settings, TabState, TestRun } from '../../src/shared/types';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import { bridgeEntry, bridgeList } from '../../src/content/claude';
import type { HandlerDeps } from '../../src/background/claude/handlers';

// The export pipeline is implemented by other modules; the handlers' job is to feed it and pass its output on.
const pipeline = vi.hoisted(() => ({
  buildEndpointSpec: vi.fn((input: unknown) => ({ input, notes: ['spec note'], method: 'POST', pathTemplate: '/orders', graphql: null })),
  suggestBaseName: vi.fn(() => 'CreateOrder'),
  generateEndpointTypes: vi.fn((_spec: unknown, opts: { format: string; baseName?: string }) => ({
    format: opts.format,
    code: `// ${opts.format} ${opts.baseName}`,
    names: { requestBody: `${opts.baseName}RequestBody` },
    notes: ['types note', 'spec note'],
  })),
  buildAgentPrompt: vi.fn((_spec: unknown, opts: { target: string; typesTs: string; includeExamples?: boolean }) => `# ${opts.target}\n${opts.typesTs}\nexamples=${opts.includeExamples}`),
}));
vi.mock('../../src/lib/endpoint', () => ({ buildEndpointSpec: pipeline.buildEndpointSpec, suggestBaseName: pipeline.suggestBaseName }));
vi.mock('../../src/lib/typegen', () => ({ generateEndpointTypes: pipeline.generateEndpointTypes }));
vi.mock('../../src/lib/agentPrompt', () => ({ buildAgentPrompt: pipeline.buildAgentPrompt }));

const { BridgeError, SEND_DISABLED, bridgeErrorMessage, createBridgeHandlers } = await import('../../src/background/claude/handlers');
const { ParamError } = await import('../../src/background/claude/validate');

function entry(id: string, overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'GET',
    url: `https://api.test/${id}?token=secret-token-value`,
    requestHeaders: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnop' }],
    requestBody: null,
    requestContentType: null,
    startTime: Number(id.replace(/\D/g, '')) || 1,
    state: 'done',
    status: 200,
    ...overrides,
  };
}

function finishedRun(entryId: string): TestRun {
  return {
    runId: 'run-9',
    entryId,
    startedAt: 10,
    state: 'done',
    origin: 'claude',
    request: {
      runId: 'run-9',
      entryId,
      mode: 'page',
      frameId: 0,
      method: 'POST',
      url: 'https://api.test/x',
      headers: [],
      body: { kind: 'none' },
      credentials: 'same-origin',
      redirect: 'follow',
      timeoutMs: 1000,
      responseBodyCap: 100,
    },
    result: {
      runId: 'run-9',
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: { kind: 'text', text: '{"ok":true,"secret":"s"}', size: 24 },
      url: 'https://api.test/x',
      redirected: false,
      timing: { start: 10, end: 30 },
      size: 24,
    },
  };
}

interface Options {
  settings?: Partial<Settings>;
  open?: number[];
  linked?: number[];
  entries?: Record<number, RequestEntry[]>;
  panel?: LinkState;
  defaultTab?: number | null;
  /** The panel link of an open tab connects while a call waits for it. */
  linkArrives?: boolean;
}

function harness(opts: Options = {}) {
  let settings = mergeSettings(DEFAULT_SETTINGS, opts.settings ?? {});
  const open = new Set(opts.open ?? [1]);
  const linked = new Set(opts.linked ?? [1]);
  const entries = opts.entries ?? { 1: [entry('h:0:1'), entry('h:0:2', { method: 'POST', status: 422 })] };
  const queries: Array<{ tabId: number; query: LinkQuery; timeoutMs: number }> = [];
  const sendResult = { run: finishedRun('h:0:2') };
  const links = {
    has: (tabId: number) => linked.has(tabId),
    tabIds: () => [...linked],
    waitFor: vi.fn(async (tabId: number) => {
      if (opts.linkArrives) linked.add(tabId);
      return linked.has(tabId);
    }),
    query: vi.fn(async (tabId: number, query: LinkQuery, timeoutMs: number) => {
      queries.push({ tabId, query, timeoutMs });
      const answers: { [P in LinkQuery['kind']]: LinkQueryResults[P] } = {
        state: opts.panel ?? { selectedId: 'h:0:2', work: [{ id: 'h:0:2', modified: false, runs: 1 }] },
        entry: { draft: null, runs: [finishedRun('h:0:2')] },
        send: sendResult,
        control: null,
      };
      return answers[query.kind];
    }) as unknown as HandlerDeps['links']['query'],
  };
  const sendToTop = vi.fn(async (tabId: number, message: TabMessage) => {
    const list = entries[tabId];
    if (!list) throw new Error('Could not establish connection. Receiving end does not exist.');
    if (message.type === 'BRIDGE_LIST') return bridgeList(list, 'https://app.test/', message.countOnly === true);
    if (message.type === 'BRIDGE_ENTRY') return bridgeEntry((id) => list.find((e) => e.id === id), message.id, 'https://app.test/');
    return undefined;
  });
  const call = createBridgeHandlers({
    settings: () => settings,
    tabs: {
      get: (tabId: number): TabState => ({ open: open.has(tabId), recording: true, preserveLog: false }),
      isOpen: (tabId: number) => open.has(tabId),
      openTabIds: () => [...open],
    },
    activity: {
      defaultTab: () => (opts.defaultTab !== undefined ? opts.defaultTab : ([...open][0] ?? null)),
      ordered: () => [...open],
    },
    links,
    sendToTop,
    tabInfo: async (tabId) => (entries[tabId] ? { title: `Tab ${tabId}`, url: `https://app.test/${tabId}?session=zzz` } : null),
    extensionVersion: '0.2.0',
    browser: 'Microsoft Edge 131',
  });
  return { call, queries, links, sendToTop, setSettings: (patch: Partial<Settings>) => (settings = mergeSettings(settings, patch)) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bridge handlers', () => {
  it('status reports tabs, flags and versions', async () => {
    const h = harness({ settings: { claudeAllowSend: true } });
    await expect(h.call('status', {})).resolves.toEqual({
      extensionVersion: '0.2.0',
      browser: 'Microsoft Edge 131',
      tabs: [{ tabId: 1, title: 'Tab 1', url: 'https://app.test/1?session=<redacted>', open: true, recording: true, entryCount: 2, active: true }],
      allowSend: true,
      shareSecrets: false,
      allowControl: false,
    });
  });

  it('listTabs skips tabs that no longer exist', async () => {
    const h = harness({ open: [1, 5] });
    const { tabs } = await h.call('listTabs', undefined);
    expect(tabs.map((t) => t.tabId)).toEqual([1]);
  });

  it('listRequests merges the panel flags, filters, and defaults to the active tab', async () => {
    const h = harness();
    const result = await h.call('listRequests', { methods: ['post'] });
    expect(result.tabId).toBe(1);
    expect(result.total).toBe(1);
    expect(result.requests[0]).toMatchObject({ id: 'h:0:2', method: 'POST', status: 422, selected: true, runs: 1 });
    expect(result.requests[0]!.url).toBe('https://api.test/h:0:2?token=<redacted>');
  });

  it('listRequests works without a panel (overlay closed, entries still in memory)', async () => {
    const h = harness({ linked: [] });
    const result = await h.call('listRequests', {});
    expect(result.requests.map((r) => [r.id, r.selected, r.runs])).toEqual([
      ['h:0:2', false, 0],
      ['h:0:1', false, 0],
    ]);
    expect(h.links.query).not.toHaveBeenCalled();
  });

  it('explains when no overlay is open anywhere or the tab has no content script', async () => {
    await expect(harness({ open: [], defaultTab: null }).call('listRequests', {})).rejects.toThrow(/not open in any tab/);
    await expect(harness().call('listRequests', { tabId: 99 })).rejects.toThrow(/not running in tab 99/);
  });

  it('rejects malformed params before doing anything', async () => {
    const h = harness();
    await expect(h.call('getRequest', { id: 'x', bogus: 1 })).rejects.toBeInstanceOf(ParamError);
    expect(h.sendToTop).not.toHaveBeenCalled();
  });

  it('getRequest resolves "selected" through the panel and includes runs', async () => {
    const h = harness();
    const detail = await h.call('getRequest', { id: 'selected', maxBodyChars: 100 });
    expect(detail.summary).toMatchObject({ id: 'h:0:2', selected: true });
    expect(detail.request.headers).toEqual([['Authorization', 'Bearer <redacted>']]);
    expect(detail.runs?.[0]).toMatchObject({ runId: 'run-9', origin: 'claude', status: 201 });
    expect(detail.runs?.[0]?.responseBody?.text).toContain('"secret": "<redacted>"');
    expect(detail.redacted).toBe(true);
  });

  it('waits for the panel link of an open tab (worker just restarted), but not for closed tabs', async () => {
    const late = harness({ linked: [], linkArrives: true });
    await expect(late.call('getRequest', { id: 'selected' })).resolves.toMatchObject({ summary: { id: 'h:0:2' } });
    expect(late.links.waitFor).toHaveBeenCalledWith(1, 3000);
    const closed = harness({ linked: [], open: [], defaultTab: 1, linkArrives: true });
    await expect(closed.call('getRequest', { id: 'selected' })).rejects.toThrow(/"selected" needs the kineReqLens overlay/);
    expect(closed.links.waitFor).not.toHaveBeenCalled();
  });

  it('getRequest shares secrets when the user allows it', async () => {
    const h = harness({ settings: { claudeShareSecrets: true } });
    const detail = await h.call('getRequest', { id: 'h:0:1' });
    expect(detail.request.headers).toEqual([['Authorization', 'Bearer abcdefghijklmnop']]);
    expect(detail.redacted).toBe(false);
  });

  it('getRequest explains unknown ids and "selected" without a panel or selection', async () => {
    await expect(harness().call('getRequest', { id: 'h:0:404' })).rejects.toThrow(/No request with id "h:0:404" in tab 1/);
    await expect(harness({ linked: [] }).call('getRequest', { id: 'selected' })).rejects.toThrow(/"selected" needs the kineReqLens overlay/);
    await expect(harness({ panel: { selectedId: null, work: [] } }).call('getRequest', { id: 'selected' })).rejects.toThrow(/No request is selected/);
  });

  it('getTypes runs the pipeline with the settings defaults and the redaction policy', async () => {
    const h = harness({ settings: { exportFormat: 'zod' } });
    const result = await h.call('getTypes', { id: 'h:0:2' });
    expect(result).toEqual({ format: 'zod', code: '// zod CreateOrder', names: { requestBody: 'CreateOrderRequestBody' }, notes: ['types note', 'spec note'] });
    const input = pipeline.buildEndpointSpec.mock.calls[0]![0] as { entry: RequestEntry; runs: TestRun[]; draft: unknown; redact: boolean };
    expect(input.entry.id).toBe('h:0:2');
    expect(input.runs).toHaveLength(1);
    expect(input.draft).toBeNull();
    expect(input.redact).toBe(true);
    await h.call('getTypes', { id: 'h:0:2', format: 'json-schema', baseName: 'Foo' });
    expect(pipeline.generateEndpointTypes).toHaveBeenLastCalledWith(expect.anything(), { format: 'json-schema', baseName: 'Foo' });
  });

  it('getPrompt builds the agent prompt from TypeScript types', async () => {
    const h = harness({ settings: { promptTarget: 'tests' } });
    await expect(h.call('getPrompt', { id: 'h:0:1' })).resolves.toEqual({ prompt: '# tests\n// typescript CreateOrder\nexamples=true', target: 'tests' });
    await expect(h.call('getPrompt', { id: 'h:0:1', target: 'server', includeExamples: false })).resolves.toEqual({
      prompt: '# server\n// typescript CreateOrder\nexamples=false',
      target: 'server',
    });
  });

  describe('sendRequest', () => {
    it('is refused unless the user allowed it', async () => {
      const h = harness();
      await expect(h.call('sendRequest', { id: 'h:0:1' })).rejects.toThrow(SEND_DISABLED);
      expect(h.links.query).not.toHaveBeenCalled();
    });

    it('needs the overlay open and its panel connected in that tab', async () => {
      await expect(harness({ settings: { claudeAllowSend: true }, open: [1], linked: [] }).call('sendRequest', { id: 'h:0:1', tabId: 1 })).rejects.toThrow(
        /not open in tab 1/,
      );
      await expect(harness({ settings: { claudeAllowSend: true }, open: [], linked: [1], defaultTab: 1 }).call('sendRequest', { id: 'h:0:1' })).rejects.toThrow(
        /not open in tab 1/,
      );
      // An open overlay whose panel reconnects in time is fine.
      await expect(harness({ settings: { claudeAllowSend: true }, linked: [], linkArrives: true }).call('sendRequest', { id: 'h:0:1' })).resolves.toMatchObject({
        origin: 'claude',
      });
    });

    it('routes the run to the panel with overrides, mode and the replay timeout, and formats the result', async () => {
      const h = harness({ settings: { claudeAllowSend: true, replayTimeoutMs: 20_000 } });
      const result = await h.call('sendRequest', {
        id: 'selected',
        mode: 'extension',
        overrides: { method: 'POST', headers: [['X-Test', '1']] },
        maxBodyChars: 1000,
      });
      const send = h.queries.find((q) => q.query.kind === 'send')!;
      expect(send.query).toEqual({ kind: 'send', entryId: 'h:0:2', timeoutMs: 20_000, overrides: { method: 'POST', headers: [['X-Test', '1']] }, mode: 'extension' });
      expect(send.timeoutMs).toBe(25_000);
      expect(result).toMatchObject({ runId: 'run-9', origin: 'claude', status: 201, statusText: 'Created', responseHeaders: [['content-type', 'application/json']] });
      expect(result.responseBody?.text).toContain('<redacted>');
    });
  });
});

describe('bridgeErrorMessage', () => {
  it('passes user-facing errors through and labels unexpected ones', () => {
    expect(bridgeErrorMessage(new BridgeError('Open the overlay'))).toBe('Open the overlay');
    expect(bridgeErrorMessage(new ParamError('bad id'))).toBe('bad id');
    expect(bridgeErrorMessage(new Error('not implemented'))).toBe('kineReqLens failed: not implemented');
    expect(bridgeErrorMessage('x')).toBe('kineReqLens failed: x');
  });
});
