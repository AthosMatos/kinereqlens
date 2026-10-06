// OWNER: ui-editor agent. Small helpers shared by the request editor components.
import { createElement, type Component, type FunctionComponent } from 'preact';
import { useCallback, useState } from 'preact/hooks';

/** Shallow equality of two props objects (same keys, `===` values). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as Array<keyof T>;
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Memoized component (like React.memo) without importing preact/compat, whose global option hooks would
 * change event semantics for the whole overlay. The wrapper only owns `shouldComponentUpdate`; hooks live in
 * the wrapped component, so local state updates are never blocked by the props comparison.
 */
export function memo<P extends object>(
  fn: FunctionComponent<P>,
  equal: (prev: Readonly<P>, next: Readonly<P>) => boolean = shallowEqual,
): FunctionComponent<P> {
  function Memo(this: Component<P>, props: P) {
    this.shouldComponentUpdate = (next: Readonly<P>) => !equal(this.props, next);
    return createElement(fn, props);
  }
  Memo.displayName = `Memo(${fn.displayName ?? fn.name ?? 'Component'})`;
  return Memo;
}

/** Join truthy class names. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = '';
  for (const p of parts) if (p) out = out ? `${out} ${p}` : p;
  return out;
}

/** Best-effort message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Run `fn`, returning `fallback` when it throws (lib calls must never take the editor down). */
export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (__DEV__) console.warn('[reqlens] editor helper failed', err);
    return fallback;
  }
}

// Expanded/collapsed state that survives remounts (switching entries, pagination, raw <-> fields) for the
// lifetime of the page. Keys are node/section ids, which are unique per draft.
const toggleMemory = new Map<string, boolean>();
const TOGGLE_MEMORY_MAX = 5000;

/** Boolean UI state remembered per key for the page lifetime. */
export function usePersistentToggle(key: string, initial: boolean): [boolean, (next?: boolean) => void] {
  const [value, setValue] = useState(() => toggleMemory.get(key) ?? initial);
  const set = useCallback(
    (next?: boolean) => {
      setValue((prev) => {
        const v = next ?? !prev;
        if (toggleMemory.size >= TOGGLE_MEMORY_MAX) toggleMemory.clear();
        toggleMemory.set(key, v);
        return v;
      });
    },
    [key],
  );
  return [value, set];
}

/** "⌘↵" on Apple platforms, "Ctrl+↵" elsewhere. */
export const SEND_SHORTCUT_LABEL: string =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? '⌘↵'
    : 'Ctrl+↵';

/** True for Ctrl/Cmd+Enter (outside IME composition). */
export function isSendShortcut(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing;
}

/** Plain Enter (no modifiers, not composing). */
export function isPlainEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.isComposing;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
