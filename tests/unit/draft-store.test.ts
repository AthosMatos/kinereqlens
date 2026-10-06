import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { ReplayRequest, ReplayResult, ReqlensBridge, RequestEntry } from '../../src/shared/types';
import {
  applyRawText,
  ensureRecord,
  exportRecord,
  exportRuns,
  getRecord,
  importRecords,
  pruneDrafts,
  sendDraft,
  setBodyView,
  updateDraft,
} from '../../src/ui/detail/draftStore';
import { sendEntry } from '../../src/ui/detail/sendAction';

let seq = 0;
function jsonEntry(text: string): RequestEntry {
  seq++;
  return {
    id: `h:0:ds${seq}`,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'POST',
    url: 'https://api.test/big',
    requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    requestBody: { kind: 'text', text, size: text.length },
    requestContentType: 'application/json',
    startTime: 1000,
    state: 'done',
  };
}

function fakeBridge(): { bridge: ReqlensBridge; sent: ReplayRequest[] } {
  const sent: ReplayRequest[] = [];
  const bridge = {
    replay: vi.fn(async (req: ReplayRequest) => {
      sent.push(req);
      return { runId: req.runId, ok: true, status: 200, statusText: 'OK', headers: [], body: null, url: req.url, redirected: false, timing: { start: 0, end: 0 }, size: 0 } satisfies ReplayResult;
    }),
    abortReplay: vi.fn(),
  } as unknown as ReqlensBridge;
  return { bridge, sent };
}

/** A JSON body over the synchronous raw-parse limit (200 000 chars). */
const bigJson = () => JSON.stringify({ items: Array.from({ length: 12_000 }, (_, i) => ({ id: i, name: `item ${i}` })) });

describe('draft store: sending', () => {
  it('never sends the stale body behind a large raw edit that does not parse', () => {
    const entry = jsonEntry(bigJson());
    ensureRecord(entry);
    setBodyView(entry.id, 'raw');
    const invalid = bigJson().replace(/}]}$/, '},]}');
    applyRawText(entry.id, invalid);
    expect(getRecord(entry.id)?.raw).toMatchObject({ pending: true, error: null });
    const { bridge, sent } = fakeBridge();
    // The shell / editor path toasts and refuses.
    expect(sendEntry(bridge, entry, DEFAULT_SETTINGS)).toBeNull();
    expect(getRecord(entry.id)?.raw?.error).toMatch(/trailing comma|Unexpected/i);
    // sendDraft itself refuses too (other callers).
    expect(() => sendDraft(bridge, entry, DEFAULT_SETTINGS)).toThrow(/raw body does not parse/);
    expect(sent).toEqual([]);
  });

  it('sends a valid large raw edit after parsing it', () => {
    const entry = jsonEntry(bigJson());
    ensureRecord(entry);
    setBodyView(entry.id, 'raw');
    const edited = bigJson().replace('"item 0"', '"first"');
    applyRawText(entry.id, edited);
    const { bridge, sent } = fakeBridge();
    expect(sendEntry(bridge, entry, DEFAULT_SETTINGS)).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: 'text' });
    expect((sent[0]!.body as { text: string }).text).toContain('"first"');
  });
});

describe('draft store: hand-over to a reloaded panel', () => {
  it('exports edited records and restores them (runs that were in flight become aborted)', () => {
    const entry = jsonEntry('{"a":1}');
    ensureRecord(entry);
    expect(exportRecord(entry.id)).toBeNull(); // nothing a fresh draft would not recreate
    updateDraft(entry.id, (d) => ({ ...d, method: 'PUT' }));
    const { bridge } = fakeBridge();
    (bridge.replay as unknown as { mockImplementation(fn: () => Promise<never>): void }).mockImplementation(() => new Promise<never>(() => undefined));
    sendDraft(bridge, entry, DEFAULT_SETTINGS);
    const saved = JSON.parse(JSON.stringify(exportRecord(entry.id)));
    const runs = JSON.parse(JSON.stringify(exportRuns(entry.id)));
    expect(saved).toMatchObject({ entryId: entry.id, draft: { method: 'PUT' } });
    expect(saved.runs).toBeUndefined(); // runs travel separately
    pruneDrafts(new Set());
    expect(getRecord(entry.id)).toBeUndefined();
    importRecords([saved], { [entry.id]: runs });
    const rec = getRecord(entry.id)!;
    expect(rec.draft?.method).toBe('PUT');
    expect(rec.meta.modified).toBe(true);
    expect(rec.runs[0]).toMatchObject({ state: 'aborted' });
    expect(rec.runs[0]!.result?.error).toMatch(/reloaded/);
  });
});
