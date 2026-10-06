// OWNER: ui-shell agent. Preact hooks over the content-script bridge. Signatures are a contract used by other UI agents.
import { createContext } from 'preact';
import type { RefObject } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CaptureInfo, ReqlensBridge, RequestEntry, Settings, TabState } from '../shared/types';

export const BridgeContext = createContext<ReqlensBridge | null>(null);

export function useBridge(): ReqlensBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('BridgeContext missing');
  return bridge;
}

/**
 * Snapshot of an external store that re-renders on change.
 * The snapshot is kept in state, so it is referentially stable between notifications (safe as a memo dep).
 */
function useBridgeValue<T>(
  read: (bridge: ReqlensBridge) => T,
  subscribe: (bridge: ReqlensBridge, onChange: () => void) => () => void,
): T {
  const bridge = useBridge();
  const [value, setValue] = useState<T>(() => read(bridge));
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const update = () =>
      setValue((prev) => {
        const next = readRef.current(bridge);
        return sameSnapshot(prev, next) ? prev : next;
      });
    // Catch changes that happened between the initial render and this subscription.
    update();
    return subscribe(bridge, update);
  }, [bridge]);

  return value;
}

/** Identity, or element-wise identity for arrays (the bridge may hand out a fresh array of the same entries). */
function sameSnapshot<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** All entries (oldest first); re-renders on change. */
export function useEntries(): RequestEntry[] {
  return useBridgeValue(
    (b) => b.getEntries(),
    (b, fn) => b.subscribeEntries(fn),
  );
}

export function useSettings(): Settings {
  return useBridgeValue(
    (b) => b.getSettings(),
    (b, fn) => b.subscribeSettings(fn),
  );
}

export function useTabState(): TabState {
  return useBridgeValue(
    (b) => b.getTabState(),
    (b, fn) => b.subscribeTabState(fn),
  );
}

export function useCaptureInfo(): CaptureInfo {
  return useBridgeValue(
    (b) => b.getCaptureInfo(),
    (b, fn) => b.subscribeCaptureInfo(fn),
  );
}

/** Live size of an element via ResizeObserver ({0,0} before first measure). */
export function useElementSize(ref: RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observed = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);

  // Runs after every commit but only (re)subscribes when the ref points at a different element.
  useLayoutEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el) {
      setSize((s) => (s.width === 0 && s.height === 0 ? s : { width: 0, height: 0 }));
      return;
    }
    const apply = (width: number, height: number) => {
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
    };
    const ro = new ResizeObserver((records) => {
      const record = records[records.length - 1];
      if (!record) return;
      const box = record.borderBoxSize?.[0];
      if (box) apply(box.inlineSize, box.blockSize);
      else apply(record.contentRect.width, record.contentRect.height);
    });
    ro.observe(el);
    observed.current = { el, ro };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
  });

  useEffect(
    () => () => {
      observed.current?.ro.disconnect();
      observed.current = null;
    },
    [],
  );

  return size;
}

/** Whether a media query matches, following changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => safeMatchMedia(query)?.matches ?? false);
  useEffect(() => {
    const mql = safeMatchMedia(query);
    if (!mql) return;
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function safeMatchMedia(query: string): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

/** Resolved theme ('light' | 'dark') from settings.theme + prefers-color-scheme. */
export function useResolvedTheme(): 'light' | 'dark' {
  const { theme } = useSettings();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** True when the user asked the OS to minimise animation. */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/**
 * Debounced callback: the latest arguments win and `fn` runs `delayMs` after the last call.
 * Returns `[call, flush]`; pending calls are flushed on unmount so nothing is lost.
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): [(...args: A) => void, () => void] {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const state = useRef<{ timer: ReturnType<typeof setTimeout> | null; args: A | null }>({ timer: null, args: null });

  const api = useRef<[(...args: A) => void, () => void] | null>(null);
  if (!api.current) {
    const flush = () => {
      const s = state.current;
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = null;
      const args = s.args;
      s.args = null;
      if (args) fnRef.current(...args);
    };
    const call = (...args: A) => {
      const s = state.current;
      s.args = args;
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = setTimeout(flush, delayMs);
    };
    api.current = [call, flush];
  }

  useEffect(() => () => api.current?.[1](), []);
  return api.current;
}
