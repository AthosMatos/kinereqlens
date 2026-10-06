import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJsonTree, getNodeAtPath } from '../../src/lib/json-tree';
import type { FindCallName, FindResult, FindToPanel } from '../../src/shared/find-protocol';
import { FindClient, FindController } from '../../src/ui/find/controller';
import type { FindHost } from '../../src/ui/find/controller';
import { findIconState, findStatusText, findStatusTitle, findTooltip } from '../../src/ui/find/text';
import { ancestorIds } from '../../src/ui/response/json-view';

/** A fake page side: records calls, answers locate from a queue, emits events on demand. */
class FakeHost implements FindHost {
  calls: Array<{ method: FindCallName; args: unknown[] }> = [];
  locateAnswers: unknown[] = [];
  private listeners = new Set<(e: FindToPanel) => void>();

  find(method: FindCallName, ...args: unknown[]): Promise<never> {
    this.calls.push({ method, args });
    if (method === 'findStart') return Promise.resolve({ ok: true }) as Promise<never>;
    if (method === 'findLocate') return Promise.resolve(this.locateAnswers.shift() ?? { ok: true, count: 1 }) as Promise<never>;
    return Promise.resolve(undefined) as Promise<never>;
  }

  onFindEvent(fn: (e: FindToPanel) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: FindToPanel): void {
    for (const fn of this.listeners) fn(event);
  }

  started(): Array<{ scanId: string; candidates: Array<{ id: number; value: string }>; locales: string[]; watch: boolean }> {
    return this.calls.filter((c) => c.method === 'findStart').map((c) => c.args[0] as never);
  }

  stopped(): string[] {
    return this.calls.filter((c) => c.method === 'findStop').map((c) => c.args[0] as string);
  }
}

function result(id: number, total: number, extra: Partial<FindResult> = {}): FindResult {
  return { id, total, more: false, visible: total, attrOnly: false, common: false, kind: total ? 'exact' : null, confidence: 3, as: '', asLabel: '', ...extra };
}

const tree = () => parseJsonTree(JSON.stringify({ items: [{ name: 'alpha-one', n: 12345 }, { name: 'alpha-one', n: 999 }], label: 'beta-two' }));

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FindController', () => {
  it('starts a watched scan with the candidates and fans results out to every node holding the value', async () => {
    const host = new FakeHost();
    const controller = new FindController(host, () => ['pt-BR']);
    const root = tree();
    const client = new FindClient(root);
    controller.want(client, true);
    const [start] = host.started();
    expect(start).toMatchObject({ locales: ['pt-BR'], watch: true });
    expect(start!.candidates.map((c) => c.value)).toEqual(['beta-two', 'alpha-one', '12345', '999']);
    expect(client.snapshot.phase).toBe('scanning');

    const alpha = start!.candidates.find((c) => c.value === 'alpha-one')!.id;
    host.emit({ t: 'find-results', scanId: start!.scanId, results: [result(alpha, 2)], done: false });
    host.emit({ t: 'find-results', scanId: 'other-scan', results: [result(0, 5)], done: true });
    host.emit({
      t: 'find-results',
      scanId: start!.scanId,
      results: [],
      done: true,
      stats: { candidates: 4, found: 1, indexedChars: 10, truncated: false, locales: ['pt-BR'], ms: 1 },
    });
    const snap = client.snapshot;
    expect(snap.phase).toBe('done');
    expect(snap.found).toBe(1);
    const first = getNodeAtPath(root, ['items', 0, 'name'])!;
    const second = getNodeAtPath(root, ['items', 1, 'name'])!;
    expect(snap.byNode.get(first.id)?.result.total).toBe(2);
    expect(snap.byNode.get(second.id)).toBe(snap.byNode.get(first.id));
    expect(snap.byNode.size).toBe(2);

    // A later pass reports the value gone.
    host.emit({ t: 'find-results', scanId: start!.scanId, results: [result(alpha, 0)], done: true });
    expect(client.snapshot.byNode.size).toBe(0);
    expect(client.snapshot.found).toBe(0);
  });

  it('the most recently activated client owns the session; the previous one resumes when it leaves', () => {
    const host = new FakeHost();
    const controller = new FindController(host, () => []);
    const a = new FindClient(tree());
    const b = new FindClient(tree());
    controller.want(a, true);
    const scanA = host.started()[0]!.scanId;
    controller.want(b, true);
    expect(host.stopped()).toEqual([scanA]);
    expect(a.snapshot.phase).toBe('idle');
    expect(b.scanId).toBe(host.started()[1]!.scanId);
    controller.want(b, false);
    expect(host.stopped()).toEqual([scanA, host.started()[1]!.scanId]);
    expect(host.started()).toHaveLength(3);
    expect(a.scanId).toBe(host.started()[2]!.scanId);
    controller.want(a, false);
    expect(a.scanId).toBeNull();
  });

  it('a tree without searchable values never starts a page scan', () => {
    const host = new FakeHost();
    const controller = new FindController(host, () => []);
    const client = new FindClient(parseJsonTree('{"ok":true,"n":1}'));
    controller.want(client, true);
    expect(host.started()).toHaveLength(0);
    expect(client.snapshot.phase).toBe('done');
  });

  it('locates a node, restarting an expired session once', async () => {
    const host = new FakeHost();
    const controller = new FindController(host, () => []);
    const root = tree();
    const client = new FindClient(root);
    controller.want(client, true);
    const scanId = host.started()[0]!.scanId;
    const label = host.started()[0]!.candidates.find((c) => c.value === 'beta-two')!.id;
    host.emit({ t: 'find-results', scanId, results: [result(label, 1)], done: true });
    const node = getNodeAtPath(root, ['label'])!;

    expect(await controller.locate(client, node.id, 'label', '"beta-two"')).toEqual({ ok: true, count: 1 });
    const call = host.calls.find((c) => c.method === 'findLocate')!;
    expect(call.args[0]).toEqual({ scanId, candidateId: label, nodeId: node.id, path: 'label', snippet: '"beta-two"' });

    host.locateAnswers.push({ ok: false, reason: 'expired', message: 'gone' }, { ok: true, count: 3 });
    const pending = controller.locate(client, node.id, 'label', '"beta-two"');
    await vi.waitFor(() => expect(host.started()).toHaveLength(2));
    const restarted = host.started()[1]!.scanId;
    host.emit({ t: 'find-results', scanId: restarted, results: [result(label, 3)], done: true });
    expect(await pending).toEqual({ ok: true, count: 3 });

    // Not a found node: nothing to locate.
    expect(await controller.locate(client, getNodeAtPath(root, ['items', 1, 'n'])!.id, 'x', 'y')).toBeNull();
  });

  it('routes "Back to kineReqLens" to the client of the scan', () => {
    const host = new FakeHost();
    const controller = new FindController(host, () => []);
    const client = new FindClient(tree());
    const back = vi.fn();
    client.onReturn(back);
    controller.want(client, true);
    host.emit({ t: 'find-return', scanId: 'stale', nodeId: 'j1' });
    host.emit({ t: 'find-return', scanId: host.started()[0]!.scanId, nodeId: 'j2' });
    expect(back.mock.calls).toEqual([['j2']]);
  });

  it('a failed start shows the error', async () => {
    const host = new FakeHost();
    host.find = ((method: FindCallName) =>
      method === 'findStart' ? Promise.resolve({ ok: false, error: 'Invalid find request' }) : Promise.resolve(undefined)) as never;
    const controller = new FindController(host, () => []);
    const client = new FindClient(tree());
    controller.want(client, true);
    await vi.waitFor(() => expect(client.snapshot.phase).toBe('error'));
    expect(client.snapshot.error).toBe('Invalid find request');
  });
});

describe('wording', () => {
  it('icon states and tooltips', () => {
    expect(findIconState(result(0, 3, { visible: 2 }))).toBe('visible');
    expect(findIconState(result(0, 1, { attrOnly: true, kind: 'attr' }))).toBe('attr');
    expect(findIconState(result(0, 2, { visible: 0 }))).toBe('hidden');
    expect(findIconState(result(0, 400, { common: true }))).toBe('common');
    expect(findTooltip(result(0, 3, { visible: 2 }))).toBe('Found 3× on the page (2 visible) — click to show it');
    expect(findTooltip(result(0, 1, { visible: 1, confidence: 1, as: '1.258.291' }))).toBe('Found 1× on the page (1 visible) as “1.258.291” — click to show it');
    expect(findTooltip(result(0, 1, { attrOnly: true }))).toMatch(/^Only found in a link \/ image URL/);
    expect(findTooltip(result(0, 1000, { common: true, more: true }))).toBe('Found 1,000+× on the page — too common to show one');
    expect(findTooltip(result(0, 2, { visible: 0 }))).toBe('Found 2× on the page, none visible right now');
  });

  it('status line', () => {
    const base = { phase: 'done' as const, found: 12, searched: 40, dropped: 0, stats: null, error: null, byNode: new Map() };
    expect(findStatusText(base, true)).toBe('Find in page: 12 values found');
    expect(findStatusText({ ...base, found: 1 }, true)).toBe('Find in page: 1 value found');
    expect(findStatusText({ ...base, found: 0 }, true)).toBe('Find in page: no values found');
    expect(findStatusText({ ...base, phase: 'scanning', found: 0 }, true)).toBe('Find in page: scanning…');
    expect(findStatusText(base, false)).toBe('Find in page: off');
    expect(findStatusTitle({ ...base, dropped: 5 }, true)).toContain('5 more values not searched');
  });
});

describe('ancestorIds', () => {
  it('lists the containers down to a node', () => {
    const root = parseJsonTree('{"a":{"b":[1,{"c":true}]},"d":2}');
    const c = getNodeAtPath(root, ['a', 'b', 1, 'c'])!;
    const ids = ancestorIds(root, c.id)!;
    expect(ids).toEqual([root.id, getNodeAtPath(root, ['a'])!.id, getNodeAtPath(root, ['a', 'b'])!.id, getNodeAtPath(root, ['a', 'b', 1])!.id]);
    expect(ancestorIds(root, root.id)).toEqual([]);
    expect(ancestorIds(root, 'missing')).toBeNull();
    expect(ancestorIds(root, getNodeAtPath(root, ['d'])!.id)).toEqual([root.id]);
  });
});
