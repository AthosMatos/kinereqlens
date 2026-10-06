// The overlay panel (cross-origin iframe) <-> frame host (page) protocol: hit regions, UI-state hand-over,
// entry chunks, and the panel's mirroring bridge.
import { describe, expect, it } from 'vitest';
import type { HostToPanel, PanelToHost } from '../../src/shared/panel-protocol';
import type { RequestEntry } from '../../src/shared/types';
import { DEFAULT_SETTINGS, DEFAULT_TAB_STATE } from '../../src/shared/constants';
import { clipPathFor } from '../../src/ui/frame/host';
import { chunkForPanel, mergeUiState, sanitizeHitRects } from '../../src/ui/frame/server';
import { RemoteBridge } from '../../src/ui/panel/remote';

const entry = (id: string, startTime: number, patch: Partial<RequestEntry> = {}): RequestEntry => ({
  id,
  source: 'hook',
  kind: 'fetch',
  frameId: 0,
  pageUrl: 'https://app.test/',
  method: 'GET',
  url: `https://app.test/${id}`,
  requestHeaders: [],
  requestBody: null,
  requestContentType: null,
  startTime,
  state: 'done',
  ...patch,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('frame host', () => {
  it('clips the panel frame to the reported regions (nothing when there are none)', () => {
    expect(clipPathFor([{ left: 10.4, top: 20, width: 100, height: 50 }])).toBe('path(nonzero, "M 10 20 h 100 v 50 h -100 Z")');
    expect(clipPathFor([])).toBe('polygon(0px 0px, 0px 0px, 0px 0px)');
    expect(clipPathFor([{ left: 0, top: 0, width: 0, height: 10 }])).toBe('polygon(0px 0px, 0px 0px, 0px 0px)');
  });

  it('validates hit regions from the panel', () => {
    expect(sanitizeHitRects('all')).toBe('all');
    expect(sanitizeHitRects('nope')).toBeNull();
    expect(sanitizeHitRects([{ left: 1, top: 2, width: -5, height: 3 }, { left: 'x' }])).toEqual([{ left: 1, top: 2, width: 0, height: 3 }]);
    expect(sanitizeHitRects(Array.from({ length: 50 }, () => ({ left: 0, top: 0, width: 1, height: 1 })))).toHaveLength(32);
  });

  it('merges UI-state patches: shell replaces, records replace or delete', () => {
    let state = mergeUiState(null, { shell: { selectedId: 'a' }, records: { a: { x: 1 }, b: { y: 2 } }, runs: { b: [1] } });
    state = mergeUiState(state, { records: { a: null, c: { z: 3 } } });
    expect(state).toEqual({ shell: { selectedId: 'a' }, records: { b: { y: 2 }, c: { z: 3 } }, runs: { b: [1] } });
    expect(mergeUiState(state, { runs: { b: null } }).runs).toEqual({});
  });

  it('splits large entry updates into bounded messages', () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const entries = [1, 2, 3, 4, 5].map((i) => entry(`e${i}`, i, { requestBody: { kind: 'text', text: big, size: big.length } }));
    const chunks = chunkForPanel(entries);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(chunkForPanel(Array.from({ length: 700 }, (_, i) => entry(`n${i}`, i))).map((c) => c.length)).toEqual([300, 300, 100]);
  });
});

describe('RemoteBridge (panel side)', () => {
  function connected() {
    const sent: PanelToHost[] = [];
    const bridge = new RemoteBridge((m) => sent.push(m));
    const deliver = (m: HostToPanel) => bridge.handle(JSON.parse(JSON.stringify(m)));
    deliver({ t: 'state', version: '1.2.3', tabState: { ...DEFAULT_TAB_STATE, open: true }, settings: DEFAULT_SETTINGS, captureInfo: { lateInjection: false, hookConnected: true, pageUrl: 'https://app.test/page' }, uiState: null });
    deliver({ t: 'entries', upsert: [entry('b', 2), entry('a', 1)], remove: [] });
    deliver({ t: 'ready' });
    return { bridge, sent, deliver };
  }

  it('mirrors state and entries (sorted, identity-stable between changes)', async () => {
    const { bridge, deliver } = connected();
    await bridge.ready;
    expect(bridge.version).toBe('1.2.3');
    expect(bridge.getTabState().open).toBe(true);
    const first = bridge.getEntries();
    expect(first.map((e) => e.id)).toEqual(['a', 'b']);
    expect(bridge.getEntries()).toBe(first);
    let notified = 0;
    bridge.subscribeEntries(() => notified++);
    deliver({ t: 'entries', upsert: [entry('c', 3)], remove: ['a'] });
    await tick();
    expect(notified).toBe(1);
    expect(bridge.getEntries().map((e) => e.id)).toEqual(['b', 'c']);
    expect(bridge.getEntries()[0]).toBe(first[1]); // unchanged entries keep their identity
  });

  it('forwards calls and resolves them with the host’s answer; replay never rejects', async () => {
    const { bridge, sent, deliver } = connected();
    const pending = bridge.setTabState({ recording: false });
    const call = sent.find((m) => m.t === 'call' && m.method === 'setTabState') as Extract<PanelToHost, { t: 'call' }>;
    deliver({ t: 'result', id: call.id, ok: true, value: { open: true, recording: false, preserveLog: false } });
    expect(await pending).toEqual({ open: true, recording: false, preserveLog: false });
    const replay = bridge.replay({ runId: 'r1', url: 'https://x/' } as never);
    bridge.disconnected();
    expect(await replay).toMatchObject({ runId: 'r1', ok: false, error: expect.stringMatching(/connection/) });
  });

  it('shows a new manual entry at once with the id it asks the store to use', () => {
    const { bridge, sent } = connected();
    const created = bridge.addManualEntry({ method: 'POST' });
    expect(created).toMatchObject({ source: 'manual', method: 'POST', url: 'https://app.test/' });
    expect(created.id).toMatch(/^m:/);
    const call = sent.find((m) => m.t === 'call' && m.method === 'addManualEntry') as Extract<PanelToHost, { t: 'call' }>;
    expect(call.args[0]).toMatchObject({ id: created.id, method: 'POST' });
    expect(bridge.getEntries().some((e) => e.id === created.id)).toBe(true);
  });
});
