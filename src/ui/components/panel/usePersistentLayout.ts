// OWNER: ui-shell agent. Local layout state with debounced persistence through bridge.updateSettings.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { LayoutSettings, ReqlensBridge } from '../../../shared/types';
import { useDebouncedCallback } from '../../hooks';

/** Debounce for layout writes: drags/resizes commit once at the end, rapid toggles coalesce. */
export const LAYOUT_PERSIST_DELAY_MS = 300;

const LAYOUT_KEYS: ReadonlyArray<keyof LayoutSettings> = [
  'dock',
  'x',
  'y',
  'w',
  'h',
  'dockSize',
  'listWidth',
  'split',
  'minimized',
  'terminalHeight',
  'railExpanded',
];

function sameLayout(a: LayoutSettings, b: LayoutSettings): boolean {
  return LAYOUT_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Layout the UI renders from, applied locally at once and written to settings debounced (~300 ms).
 * External changes (another tab, a reset) are adopted only while nothing local is pending or in flight,
 * so a stale storage echo never snaps the panel back mid-interaction. Pending writes flush on unmount
 * and on `pagehide`.
 */
export function usePersistentLayout(
  bridge: ReqlensBridge,
  persisted: LayoutSettings,
): [LayoutSettings, (patch: Partial<LayoutSettings>) => void] {
  const [layout, setLayout] = useState<LayoutSettings>(persisted);
  const pending = useRef<Partial<LayoutSettings> | null>(null);
  const inflight = useRef(0);

  const adopt = useCallback((next: LayoutSettings) => {
    setLayout((prev) => (sameLayout(prev, next) ? prev : { ...next }));
  }, []);

  const [schedule, flush] = useDebouncedCallback(() => {
    const patch = pending.current;
    pending.current = null;
    if (!patch) return;
    inflight.current += 1;
    bridge
      .updateSettings({ layout: patch })
      .then((settings) => {
        if (inflight.current === 1 && !pending.current && settings?.layout) adopt(settings.layout);
      })
      .catch(() => {
        // Extension context invalidated / storage failure: keep the local layout, nothing else to do.
      })
      .finally(() => {
        inflight.current -= 1;
      });
  }, LAYOUT_PERSIST_DELAY_MS);

  useEffect(() => {
    if (pending.current || inflight.current > 0) return;
    adopt(persisted);
  }, [persisted, adopt]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [flush]);

  const update = useCallback(
    (patch: Partial<LayoutSettings>) => {
      setLayout((prev) => ({ ...prev, ...patch }));
      pending.current = { ...(pending.current ?? {}), ...patch };
      schedule();
    },
    [schedule],
  );

  return [layout, update];
}
