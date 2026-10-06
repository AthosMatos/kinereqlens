// OWNER: ui-export agent. Hooks of the Export tab: deferred (debounced) generation, optimistic persisted
// choices (format / target), copy feedback, and binding the live settings for the one-shot actions.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ReqlensBridge, Settings, SettingsPatch } from '../../shared/types';
import { toast } from '../components/toast';
import { bindExportSettings } from './actions';

export interface DeferredValue<T> {
  /** Latest value (possibly for older inputs while `stale`); null before the first computation. */
  value: T | null;
  /** The inputs changed and a recomputation is scheduled. */
  stale: boolean;
}

/**
 * A value derived from `deps` by an expensive, externally memoized `compute`. It is computed during render
 * when cheap (`defer` false) or already cached (`peek`); otherwise after `delayMs` of quiet (trailing
 * debounce) while the previous value stays on screen, and — for the very first value — after one frame, so
 * the tab paints before the work starts.
 */
export function useDeferredValue<T>(
  compute: () => T,
  peek: () => T | undefined,
  deps: readonly unknown[],
  defer: boolean,
  delayMs: number,
): DeferredValue<T> {
  const [held, setHeld] = useState<{ value: T } | null>(null);
  const computeRef = useRef(compute);
  computeRef.current = compute;

  let fresh: { value: T } | null = null;
  const cached = peek();
  if (cached !== undefined) fresh = { value: cached };
  else if (!defer) fresh = { value: compute() };
  const isFresh = fresh !== null;
  const hasHeld = held !== null;

  useEffect(() => {
    if (isFresh) return;
    const timer = setTimeout(() => setHeld({ value: computeRef.current() }), hasHeld ? delayMs : 16);
    return () => clearTimeout(timer);
  }, [isFresh, hasHeld, delayMs, ...deps]);

  const shown = fresh ?? held;
  return { value: shown ? shown.value : null, stale: !isFresh };
}

/** `value`, but lagging by `delayMs` while it keeps changing (only when `enabled`; otherwise immediate). */
export function useDebouncedValue<T>(value: T, delayMs: number, enabled: boolean): T {
  const [lagged, setLagged] = useState(value);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setLagged(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, enabled]);
  return enabled ? lagged : value;
}

type ChoiceKey = 'exportFormat' | 'promptTarget';

/**
 * A setting chosen in the Export tab: applied at once (optimistic), persisted through the bridge, and
 * dropped back to the stored value if saving fails.
 */
export function usePersistedChoice<K extends ChoiceKey>(
  bridge: ReqlensBridge,
  stored: Settings[K],
  key: K,
): [Settings[K], (value: Settings[K]) => void] {
  const [pending, setPending] = useState<Settings[K] | null>(null);
  useEffect(() => {
    if (pending !== null && stored === pending) setPending(null);
  }, [stored, pending]);
  const set = useCallback(
    (value: Settings[K]) => {
      setPending(value);
      const fail = (err: unknown) => {
        setPending(null);
        toast(`Could not save the choice: ${err instanceof Error ? err.message : String(err)}`, 'error');
      };
      try {
        bridge.updateSettings({ [key]: value } as SettingsPatch).catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    [bridge, key],
  );
  return [pending ?? stored, set];
}

/** `[copied, markCopied]`: `copied` stays true for a moment after a successful copy (button feedback). */
export function useCopyFeedback(durationMs = 1400): [boolean, (ok: boolean) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const mark = useCallback(
    (ok: boolean) => {
      if (timer.current !== null) clearTimeout(timer.current);
      setCopied(ok);
      if (ok) timer.current = setTimeout(() => setCopied(false), durationMs);
    },
    [durationMs],
  );
  return [copied, mark];
}

/** Let the one-shot export actions (context menu) read the live settings of this bridge. */
export function useExportSettingsBinding(bridge: ReqlensBridge): void {
  useEffect(() => {
    bindExportSettings(() => bridge.getSettings());
  }, [bridge]);
}
