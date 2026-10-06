import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_KEY, TabActivity } from '../../src/background/claude/activity';
import { tabIdFromKey } from '../../src/background/tabs';

function harness(open: number[]) {
  const openSet = new Set(open);
  const persist = vi.fn();
  const activity = new TabActivity((tabId) => openSet.has(tabId), persist);
  return { activity, openSet, persist };
}

describe('TabActivity (default tab for calls without tabId)', () => {
  it('orders tabs most recent first, only while their overlay is open', () => {
    const { activity, persist } = harness([1, 2, 3]);
    activity.touch(1);
    activity.touch(2);
    activity.touch(4); // overlay closed there: ignored
    activity.touch(1);
    expect(activity.ordered()).toEqual([1, 2]);
    expect(persist).toHaveBeenLastCalledWith([1, 2]);
  });

  it('does not persist when nothing changes', () => {
    const { activity, persist } = harness([1]);
    activity.touch(1);
    activity.touch(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('defaults to the most recent tab whose overlay is still open', () => {
    const { activity, openSet } = harness([1, 2, 3]);
    activity.touch(3);
    activity.touch(2);
    activity.touch(1);
    expect(activity.defaultTab([...openSet])).toBe(1);
    openSet.delete(1);
    expect(activity.defaultTab([...openSet])).toBe(2);
  });

  it('falls back to any open tab, then to the most recent one, then null', () => {
    const { activity, openSet } = harness([7, 5]);
    expect(activity.defaultTab([7, 5])).toBe(5);
    activity.touch(7);
    openSet.clear();
    expect(activity.defaultTab([])).toBe(7);
    activity.remove(7);
    expect(activity.defaultTab([])).toBeNull();
  });

  it('follows tab replacement and removal', () => {
    const { activity, openSet } = harness([1, 2]);
    activity.touch(1);
    activity.touch(2);
    openSet.add(9);
    activity.replace(1, 9);
    expect(activity.ordered()).toEqual([2, 9]);
    activity.remove(2);
    expect(activity.ordered()).toEqual([9]);
  });

  it('restores a persisted order under the tabs touched since startup, ignoring garbage', () => {
    const { activity } = harness([1, 2, 3]);
    activity.touch(3);
    activity.restore([1, 'x', -1, 3, 2.5, 2]);
    expect(activity.ordered()).toEqual([3, 1, 2]);
    activity.restore('nope');
    expect(activity.ordered()).toEqual([3, 1, 2]);
  });

  it('bounds the number of tracked tabs', () => {
    const open = Array.from({ length: 100 }, (_, i) => i);
    const { activity } = harness(open);
    for (const id of open) activity.touch(id);
    expect(activity.ordered()).toHaveLength(64);
    expect(activity.ordered()[0]).toBe(99);
  });

  it('uses a storage key the tab-state pruning never treats as a tab key', () => {
    expect(tabIdFromKey(ACTIVITY_KEY)).toBeNull();
  });
});
