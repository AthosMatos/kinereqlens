// Panel side of the control plane (src/ui/panel/control.ts): the ops act on the same module stores as the overlay's
// controls — shell selection, panel view, results tab, list filter, "Remove from list", drafts and runs, the WebSocket
// mirror, the Errors view — with no rendered App (headless panels run effects late, or not at all).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelDraftResult, PanelStateResult, PanelWsMessagesResult, PanelErrorsResult } from '../../src/shared/control-protocol';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import type { ManualEntryInit, ReplayRequest, ReplayResult, ReqlensBridge, RequestEntry, Settings, TabState } from '../../src/shared/types';
import type { WsBridge, WsDelta } from '../../src/lib/ws';

vi.mock('../../src/ui/control/shot', () => ({
  runShotCommand: vi.fn(async () => ({
    image: { data: 'iVBORw0KGgoFULL', mimeType: 'image/png', width: 680, height: 280 },
    preview: { data: 'iVBORw0KGgoPREVIEW', mimeType: 'image/png', width: 340, height: 140 },
    area: { x: 150, y: 250, width: 340, height: 140 },
    padding: 50,
  })),
  runFindCommand: vi.fn(async () => ({ matches: [], total: 0 })),
}));
vi.mock('../../src/ui/screenshot/open', () => ({ controlHost: () => ({}) }));
vi.mock('../../src/ui/screenshot/sendClient', () => ({
  saveBase64: vi.fn(async (data: string) => ({ ok: true, path: '/home/u/.reqlens/shots/shot-1.png', bytes: data.length })),
}));

const { runPanelControl } = await import('../../src/ui/panel/control');
const { getShellState, onShellSelectionRequest, restoreShellState } = await import('../../src/ui/shellState');
const { getPanelView, setPanelView } = await import('../../src/ui/ws/ViewSwitch');
const { onResultsTabRequest, takeRequestedTab } = await import('../../src/ui/detail/resultsTab');
const { getListFilterText } = await import('../../src/ui/list/RequestList');
const { getRemovedEntries, restoreToList } = await import('../../src/ui/list/listState');
const { getRecord, pruneDrafts } = await import('../../src/ui/detail/draftStore');
const { peekErrorsRequest, takeErrorsRequest } = await import('../../src/ui/errors/requests');
const { saveBase64 } = await import('../../src/ui/screenshot/sendClient');

function entry(id: string, over: Partial<RequestEntry> = {}): RequestEntry {
  const body = '{"user":{"name":"Ada"},"n":1}';
  return {
    id,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'POST',
    url: `https://api.test/${id}?a=1`,
    requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    requestBody: { kind: 'text', text: body, size: body.length },
    requestContentType: 'application/json',
    startTime: 1,
    endTime: 2,
    state: 'done',
    status: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    responseBody: { kind: 'text', text: '{"product":{"name":"Aurora desk lamp","price":1258291}}', size: 50 },
    ...over,
  };
}

class FakeWs implements WsBridge {
  private listeners = new Set<(d: WsDelta) => void>();
  sent: Array<[string, string]> = [];
  cleared = 0;
  constructor(private readonly delta: WsDelta) {}
  snapshot(): WsDelta {
    return this.delta;
  }
  subscribe(fn: (d: WsDelta) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  clear(): void {
    this.cleared++;
  }
  async send(wsId: string, text: string) {
    this.sent.push([wsId, text]);
    return { ok: true };
  }
}

function bridge(entries: RequestEntry[], over: { settings?: Partial<Settings>; ws?: WsBridge } = {}) {
  const list = entries.slice();
  const settings = mergeSettings(DEFAULT_SETTINGS, (over.settings ?? {}) as never);
  const replays: ReplayRequest[] = [];
  const b = {
    version: 'test',
    getEntries: () => list,
    subscribeEntries: () => () => undefined,
    clearEntries: vi.fn(() => list.splice(0)),
    addManualEntry: vi.fn((init?: ManualEntryInit) => {
      const e = entry(`m:${list.length}`, { source: 'manual', kind: 'manual', method: init?.method ?? 'GET', url: init?.url ?? 'https://app.test/' });
      list.push(e);
      return e;
    }),
    getTabState: (): TabState => ({ open: false, recording: true, preserveLog: false }),
    subscribeTabState: () => () => undefined,
    setTabState: async () => ({ open: false, recording: true, preserveLog: false }),
    getSettings: () => settings,
    subscribeSettings: () => () => undefined,
    updateSettings: async () => settings,
    replay: vi.fn(async (req: ReplayRequest): Promise<ReplayResult> => {
      replays.push(req);
      return { runId: req.runId, ok: true, status: 201, statusText: 'Created', headers: [{ name: 'content-type', value: 'application/json' }], body: { kind: 'text', text: '{"ok":true}', size: 11 }, url: req.url, redirected: false, timing: { start: 1, end: 5 }, size: 11 };
    }),
    abortReplay: vi.fn(),
    getCaptureInfo: () => ({ lateInjection: false, hookConnected: true, pageUrl: 'https://app.test/' }),
    subscribeCaptureInfo: () => () => undefined,
    reloadPage: vi.fn(),
    setProtectedEntries: vi.fn(),
    dispose: vi.fn(),
    ...(over.ws ? { ws: over.ws } : {}),
  };
  return { bridge: b as unknown as ReqlensBridge, raw: b, replays, list };
}

beforeEach(() => {
  restoreShellState(null);
  setPanelView('http');
  restoreToList();
  pruneDrafts(new Set());
  takeErrorsRequest();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPanelControl', () => {
  it('select / view / results tab work without a rendered App, and a late App subscriber gets the selection', async () => {
    const { bridge: b } = bridge([entry('h:0:1'), entry('h:0:2')]);
    setPanelView('errors');
    await expect(runPanelControl({ op: 'select', entryId: 'h:0:2' }, b)).resolves.toMatchObject({ selected: 'h:0:2' });
    expect(getShellState().selectedId).toBe('h:0:2');
    expect(getPanelView()).toBe('http');
    const late: Array<string | null> = [];
    const off = onShellSelectionRequest((id) => late.push(id));
    expect(late).toEqual(['h:0:2']);
    off();
    const asked: string[] = [];
    const offTab = onResultsTabRequest(() => asked.push(takeRequestedTab('h:0:1') ?? ''));
    await runPanelControl({ op: 'view', view: 'http', resultsTab: 'initiator', entryId: 'h:0:1' }, b);
    offTab();
    expect(asked).toEqual(['initiator']);
    await expect(runPanelControl({ op: 'select', entryId: 'nope' }, b)).rejects.toThrow(/No request with id "nope"/);
  });

  it('state reports view, selection, text filter, removed requests and work', async () => {
    const { bridge: b } = bridge([entry('h:0:1'), entry('h:0:2')]);
    await runPanelControl({ op: 'text_filter', text: 'orders -png' }, b);
    expect(getListFilterText()).toBe('orders -png');
    await runPanelControl({ op: 'remove', entryIds: ['h:0:1'] }, b);
    expect([...getRemovedEntries()]).toEqual(['h:0:1']);
    await runPanelControl({ op: 'edit', entryId: 'h:0:2', edit: { headers: [{ name: 'X-A', value: '1' }] } }, b);
    const state = (await runPanelControl({ op: 'state' }, b)) as PanelStateResult;
    expect(state).toMatchObject({ view: 'http', textFilter: 'orders -png', removedIds: ['h:0:1'], entryCount: 2, work: [{ id: 'h:0:2', modified: true, runs: 0 }] });
    await runPanelControl({ op: 'restore' }, b);
    expect(getRemovedEntries().size).toBe(0);
    await expect(runPanelControl({ op: 'remove', entryIds: ['missing'] }, b)).rejects.toThrow(/No request/);
  });

  it('edit applies the draft edits and send options atomically and answers the request Send would send', async () => {
    const { bridge: b } = bridge([entry('h:0:1')]);
    const result = (await runPanelControl(
      { op: 'edit', entryId: 'h:0:1', edit: { json: [{ path: 'user.name', value: 'Grace' }], params: [{ name: 'a', value: '2' }], options: { mode: 'extension', credentials: 'omit', timeoutMs: 5000 } } },
      b,
    )) as PanelDraftResult;
    expect(result.modified).toBe(true);
    expect(result.request?.url).toBe('https://api.test/h:0:1?a=2');
    expect(result.request?.body).toEqual({ kind: 'text', text: '{"user":{"name":"Grace"},"n":1}' });
    expect(result.options).toMatchObject({ mode: 'extension', credentials: 'omit', credentialsAuto: false, timeoutMs: 5000 });
    expect(result.applied).toEqual(['param a', 'json user.name', 'send options']);
    // One failing edit changes nothing.
    await expect(runPanelControl({ op: 'edit', entryId: 'h:0:1', edit: { json: [{ path: 'n', value: 3 }, { path: 'zzz', remove: true }] } }, b)).rejects.toThrow(/Nothing was changed: There is no value at zzz/);
    const again = (await runPanelControl({ op: 'request', entryId: 'h:0:1' }, b)) as PanelDraftResult;
    expect(again.request?.body).toEqual({ kind: 'text', text: '{"user":{"name":"Grace"},"n":1}' });
    await runPanelControl({ op: 'edit', entryId: 'h:0:1', edit: { revert: ['all'], options: { credentials: 'auto', timeoutMs: 'default' } } }, b);
    expect(getRecord('h:0:1')?.meta.modified).toBe(false);
    expect(getRecord('h:0:1')?.options.credentials).toBeUndefined();
  });

  it('new / duplicate / clear / resend / runs / cancel / clear runs', async () => {
    const { bridge: b, raw, replays } = bridge([entry('h:0:1')]);
    const made = (await runPanelControl({ op: 'new', init: { method: 'PUT', url: 'https://api.test/x' }, select: true }, b)) as { id: string };
    expect(raw.addManualEntry).toHaveBeenCalledWith({ method: 'PUT', url: 'https://api.test/x' });
    expect(getShellState().selectedId).toBe(made.id);
    const resent = (await runPanelControl({ op: 'resend', entryId: 'h:0:1', timeoutMs: 5000 }, b)) as { run: { origin: string; state: string; request: ReplayRequest } };
    expect(resent.run).toMatchObject({ origin: 'claude', state: 'done' });
    expect(replays.at(-1)?.url).toBe('https://api.test/h:0:1?a=1');
    const runs = (await runPanelControl({ op: 'runs', entryId: 'h:0:1' }, b)) as { runs: unknown[] };
    expect(runs.runs).toHaveLength(1);
    await expect(runPanelControl({ op: 'cancel', entryId: 'h:0:1' }, b)).resolves.toEqual({ cancelled: [] });
    await runPanelControl({ op: 'clear_runs', entryId: 'h:0:1' }, b);
    expect(((await runPanelControl({ op: 'runs', entryId: 'h:0:1' }, b)) as { runs: unknown[] }).runs).toHaveLength(0);
    await runPanelControl({ op: 'clear' }, b);
    expect(raw.clearEntries).toHaveBeenCalled();
    expect(getShellState().selectedId).toBeNull();
  });

  it('WebSocket messages: filters, paging, one message in full, send and clear', async () => {
    const delta: WsDelta = {
      reset: true,
      connections: [{ wsId: '0:w1', frameId: 0, url: 'wss://rt.test/json', protocols: [], protocol: '', extensions: '', state: 'open', createdAt: 1, openedAt: 2, errors: 0, sent: 1, received: 2, bytesSent: 10, bytesReceived: 20, lastActivity: 5 }],
      frames: [
        { id: 1, wsId: '0:w1', dir: 'out', time: 3, opcode: 'text', text: '{"type":"subscribe","channel":"prices"}', size: 40, truncated: false },
        { id: 2, wsId: '0:w1', dir: 'in', time: 4, opcode: 'text', text: '{"type":"tick","channel":"prices","price":101}', size: 46, truncated: false },
        { id: 3, wsId: '0:w1', dir: 'in', time: 5, opcode: 'text', text: '{"type":"tick","channel":"prices","price":102}', size: 46, truncated: false },
      ],
      removed: [],
    };
    const ws = new FakeWs(delta);
    const { bridge: b } = bridge([], { ws });
    const list = (await runPanelControl({ op: 'ws_list' }, b)) as { connections: Array<{ wsId: string; channels: unknown[] }> };
    expect(list.connections[0]).toMatchObject({ wsId: '0:w1', kept: 3 });
    let msgs = (await runPanelControl({ op: 'ws_messages', wsId: '0:w1', direction: 'in' }, b)) as PanelWsMessagesResult;
    expect(msgs.frames.map((f) => f.id)).toEqual([3, 2]);
    msgs = (await runPanelControl({ op: 'ws_messages', filter: '$.price = 101' }, b)) as PanelWsMessagesResult;
    expect(msgs.frames.map((f) => f.id)).toEqual([2]);
    msgs = (await runPanelControl({ op: 'ws_messages', limit: 1 }, b)) as PanelWsMessagesResult;
    expect(msgs).toMatchObject({ total: 3, more: true });
    msgs = (await runPanelControl({ op: 'ws_messages', before: 3, limit: 5 }, b)) as PanelWsMessagesResult;
    expect(msgs.frames.map((f) => f.id)).toEqual([2, 1]);
    msgs = (await runPanelControl({ op: 'ws_messages', frameId: 2 }, b)) as PanelWsMessagesResult;
    expect(msgs.frame).toMatchObject({ id: 2, json: { type: 'tick', channel: 'prices', price: 101 } });
    await runPanelControl({ op: 'ws_send', wsId: '0:w1', text: 'hello' }, b);
    expect(ws.sent).toEqual([['0:w1', 'hello']]);
    await runPanelControl({ op: 'ws_clear' }, b);
    expect(ws.cleared).toBe(1);
  });

  it('errors: the failing endpoints; full-mode dialogs are only requested in full mode', async () => {
    const failing = entry('h:0:9', { method: 'GET', url: 'https://api.test/orders/12', status: 500, requestBody: null });
    const { bridge: b } = bridge([entry('h:0:1'), failing]);
    const result = (await runPanelControl({ op: 'errors' }, b)) as PanelErrorsResult;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ method: 'GET', kind: '5xx', count: 1, entryIds: ['h:0:9'] });
    const key = result.groups[0]!.key;
    await expect(runPanelControl({ op: 'errors_dialog', key, dialog: 'issue' }, b)).rejects.toThrow(/full mode/);
    const full = bridge([failing], { settings: { errorsFullMode: true, projectFolders: { 'app.test': '/repo' } } });
    await expect(runPanelControl({ op: 'errors_dialog', key, dialog: 'commit' }, full.bridge)).rejects.toThrow(/no fix worktree/);
    await expect(runPanelControl({ op: 'errors_dialog', key, dialog: 'issue' }, full.bridge)).resolves.toEqual({ opened: 'issue' });
    expect(peekErrorsRequest()).toEqual({ key, dialog: 'issue' });
    expect(getPanelView()).toBe('errors');
    await expect(runPanelControl({ op: 'errors_analyze', key, waitMs: 0 }, b)).rejects.toThrow(/No project folder is set/);
  });

  it('source: which captured response holds a value shown on the page', async () => {
    const { bridge: b } = bridge([entry('h:0:1')]);
    const found = (await runPanelControl({ op: 'source', texts: ['1,258,291'] }, b)) as { groups: Array<{ entryId: string; matches: Array<{ label: string }> }> };
    expect(found.groups[0]?.entryId).toBe('h:0:1');
    expect(found.groups[0]?.matches[0]?.label).toBe('product.price');
  });

  it('screenshot: the preview comes back, the full image is saved through the hub (not sent back)', async () => {
    const { bridge: b } = bridge([]);
    const answer = (await runPanelControl({ op: 'screenshot', args: { text: 'Save', padding: 50 }, save: true }, b)) as { result: Record<string, unknown>; preview: { data: string } };
    expect(saveBase64).toHaveBeenCalledWith('iVBORw0KGgoFULL', expect.stringMatching(/^kinereqlens-\d+\.png$/));
    expect(answer.preview.data).toBe('iVBORw0KGgoPREVIEW');
    expect(answer.result).toMatchObject({ path: '/home/u/.reqlens/shots/shot-1.png', image: { width: 680, height: 280 }, padding: 50 });
    expect(JSON.stringify(answer.result)).not.toContain('iVBORw0KGgoFULL');
  });
});
