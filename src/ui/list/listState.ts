// OWNER: ui-list-menu agent. Request-list state shared by the list, its context menu, the rules bar and Setups:
//  - List configuration (settings.listRules / listTypes / setups / activeSetupId, persisted through
//    bridge.updateSettings). Edits apply at once: until every write is acknowledged the list shows the pending
//    values, so quick successive edits never build on a stale copy of the settings.
//  - Entries removed with "Remove from list". The store has no per-entry removal (bridge.clearEntries clears
//    everything), so this is a UI-level hidden set of entry ids. It lives as long as this panel (survives list
//    remounts on layout changes; not persisted, not handed over to a reloaded panel) and is cleared by "Clear".
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ListRule, ListTypeId, ReqlensBridge, Settings, SettingsPatch } from '../../shared/types';
import { toast } from '../components/toast';
import { useSettings } from '../hooks';

// ------------------------------------------------------------------------------------------- list config

/** Settings the list (and its setups) edit with optimistic local state. */
export type ListConfigKey = 'listRules' | 'listTypes' | 'setups' | 'activeSetupId';
export type ListConfig = Pick<Settings, ListConfigKey>;
type ListConfigPatch = Partial<ListConfig>;

let pending: ListConfigPatch = {};
let writesInFlight = 0;
const configListeners = new Set<() => void>();

function emitConfig(): void {
  for (const fn of [...configListeners]) fn();
}

function effective(settings: Settings): ListConfig {
  return {
    listRules: pending.listRules ?? settings.listRules ?? [],
    listTypes: pending.listTypes ?? settings.listTypes ?? ['fetch'],
    setups: pending.setups ?? settings.setups ?? [],
    activeSetupId: 'activeSetupId' in pending ? (pending.activeSetupId ?? null) : (settings.activeSetupId ?? null),
  };
}

/** The list configuration as the UI should show it right now (pending local edits included). */
export function currentListConfig(bridge: ReqlensBridge): ListConfig {
  return effective(bridge.getSettings());
}

/**
 * Apply `patch` locally at once and persist it (other settings keys in it, e.g. defaultMode, are only
 * persisted). Until every write is acknowledged the UI shows the pending values, so quick successive edits
 * never build on a stale copy of the settings. A failed write shows an error toast and the stored values return.
 */
export function persistListConfig(bridge: ReqlensBridge, patch: SettingsPatch, what = 'list settings'): Promise<void> {
  const local: ListConfigPatch = {};
  if (patch.listRules) local.listRules = patch.listRules;
  if (patch.listTypes) local.listTypes = patch.listTypes;
  if (patch.setups) local.setups = patch.setups;
  if ('activeSetupId' in patch) local.activeSetupId = patch.activeSetupId ?? null;
  pending = { ...pending, ...local };
  writesInFlight++;
  emitConfig();
  let saving: Promise<unknown>;
  try {
    saving = Promise.resolve(bridge.updateSettings(patch));
  } catch (err) {
    saving = Promise.reject(err);
  }
  return saving
    .then(
      () => undefined,
      (err: unknown) => {
        toast(`Could not save ${what}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      },
    )
    .finally(() => {
      writesInFlight--;
      if (writesInFlight === 0) {
        pending = {};
        emitConfig();
      }
    });
}

/** The rules as the list should apply them right now (pending local edits included). */
export function currentListRules(bridge: ReqlensBridge): ListRule[] {
  return currentListConfig(bridge).listRules;
}

/** The type selection as the list should apply it right now ([] = all types). */
export function currentListTypes(bridge: ReqlensBridge): ListTypeId[] {
  return currentListConfig(bridge).listTypes;
}

/**
 * Apply `fn` to the current rules and persist the result. Returns the new rules (the same array when `fn`
 * changed nothing; then nothing is written). A failed write shows an error toast and the stored rules return.
 */
export function updateListRules(bridge: ReqlensBridge, fn: (rules: ListRule[]) => ListRule[]): ListRule[] {
  const before = currentListRules(bridge);
  const next = fn(before);
  if (next === before) return before;
  void persistListConfig(bridge, { listRules: next }, 'list rules');
  return next;
}

/** Persist a new type selection (normalized by the caller; [] = all types). */
export function setListTypes(bridge: ReqlensBridge, types: ListTypeId[]): void {
  const before = currentListTypes(bridge);
  if (before.length === types.length && before.every((t, i) => t === types[i])) return;
  void persistListConfig(bridge, { listTypes: types }, 'the type filter');
}

/** Preact hook: the effective list configuration, re-rendering on settings changes and local edits. */
export function useListConfig(): ListConfig {
  const settings = useSettings();
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    configListeners.add(fn);
    return () => {
      configListeners.delete(fn);
    };
  }, []);
  const config = effective(settings);
  // Stable object while nothing changed (safe as a memo dependency).
  return useMemo(() => config, [config.listRules, config.listTypes, config.setups, config.activeSetupId]);
}

/** Preact hook: the effective list rules. */
export function useListRules(): ListRule[] {
  return useListConfig().listRules;
}

/** Preact hook: the effective type selection ([] = all types). */
export function useListTypes(): ListTypeId[] {
  return useListConfig().listTypes;
}

// ------------------------------------------------------------------------------------------- removed entries

const EMPTY: ReadonlySet<string> = new Set();
let removedIds: ReadonlySet<string> = EMPTY;
const removedListeners = new Set<() => void>();

function setRemoved(next: ReadonlySet<string>): void {
  if (next === removedIds) return;
  removedIds = next;
  for (const fn of [...removedListeners]) fn();
}

/** Ids currently removed from the list (a new Set object after every change). */
export function getRemovedEntries(): ReadonlySet<string> {
  return removedIds;
}

/** Hide these entries from the list (until restored or the list is cleared). */
export function removeFromList(ids: readonly string[]): void {
  const fresh = ids.filter((id) => !removedIds.has(id));
  if (fresh.length) setRemoved(new Set([...removedIds, ...fresh]));
}

/** Show removed entries again: these ids, or all when omitted. */
export function restoreToList(ids?: readonly string[]): void {
  if (!ids) {
    setRemoved(EMPTY);
    return;
  }
  if (!ids.some((id) => removedIds.has(id))) return;
  const next = new Set(removedIds);
  for (const id of ids) next.delete(id);
  setRemoved(next.size ? next : EMPTY);
}

/** Forget removed ids whose entries no longer exist (cleared / evicted). */
export function pruneRemoved(liveIds: ReadonlySet<string>): void {
  if (removedIds.size === 0) return;
  let stale = false;
  for (const id of removedIds) {
    if (!liveIds.has(id)) {
      stale = true;
      break;
    }
  }
  if (!stale) return;
  const next = new Set([...removedIds].filter((id) => liveIds.has(id)));
  setRemoved(next.size ? next : EMPTY);
}

/** Preact hook over the removed set. */
export function useRemovedEntries(): ReadonlySet<string> {
  const [value, setValue] = useState(removedIds);
  useEffect(() => {
    const fn = () => setValue(removedIds);
    removedListeners.add(fn);
    fn();
    return () => {
      removedListeners.delete(fn);
    };
  }, []);
  return value;
}
