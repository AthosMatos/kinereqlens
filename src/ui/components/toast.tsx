// OWNER: ui-shell agent. Global toast notifications. `toast()` is callable from any UI module.
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** A button inside the toast (e.g. "Undo"). Clicking it runs `onClick` and dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Auto-dismiss delay; default by kind (longer for toasts with an action). */
  durationMs?: number;
  /**
   * Group key: the new toast replaces any visible toast of the same group (e.g. successive "Undo" toasts of
   * one feature do not stack up; only the latest change can be undone from a toast).
   */
  replace?: string;
}

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  group?: string;
}

const MAX_VISIBLE = 4;
const DURATION_MS: Record<ToastKind, number> = { info: 2500, success: 2500, warn: 4000, error: 5000 };
/** Toasts with an action stay long enough to reach the button. */
const ACTION_DURATION_MS = 6000;
/** After the pointer / focus leaves an action toast it stays this long. */
const RESUME_DURATION_MS = 2500;
const KIND_ICON: Record<ToastKind, IconName> = { info: 'info', success: 'check', warn: 'warning', error: 'warning' };

let nextId = 1;
let items: ToastItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function startTimer(id: number, ms: number): void {
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => dismiss(id), ms),
  );
}

function dismiss(id: number): void {
  clearTimer(id);
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

/**
 * Show a transient message (auto-dismiss ~2.5s, errors ~5s, ~6s with an action). Returns a function that
 * dismisses it.
 */
export function toast(message: string, kind: ToastKind = 'info', options?: ToastOptions): () => void {
  const text = String(message ?? '').trim();
  if (!text) return () => undefined;
  const action = options?.action;
  const group = options?.replace;
  // Collapse an identical message that is still on screen instead of stacking duplicates (never one with an
  // action: its button belongs to a different change).
  if (!action) {
    const dup = items.find((t) => t.message === text && t.kind === kind && !t.action);
    if (dup) dismiss(dup.id);
  }
  if (group) for (const old of items.filter((t) => t.group === group)) dismiss(old.id);
  const durationMs = options?.durationMs ?? (action ? ACTION_DURATION_MS : DURATION_MS[kind]);
  const item: ToastItem = {
    id: nextId++,
    message: text,
    kind,
    ...(action ? { action } : {}),
    ...(group ? { group } : {}),
  };
  const next = [...items, item];
  const overflow = Math.max(0, next.length - MAX_VISIBLE);
  for (const old of next.slice(0, overflow)) clearTimer(old.id);
  items = next.slice(overflow);
  startTimer(item.id, durationMs);
  emit();
  return () => dismiss(item.id);
}

function runAction(item: ToastItem): void {
  dismiss(item.id);
  try {
    item.action?.onClick();
  } catch (err) {
    console.warn('[reqlens] toast action failed', err);
  }
}

/** A toast with an action button: a group (not one big button), paused while hovered / focused. */
function ActionToast({ item }: { item: ToastItem }) {
  const hold = () => clearTimer(item.id);
  const resume = () => startTimer(item.id, RESUME_DURATION_MS);
  return (
    <div
      class={`rl-toast rl-toast--${item.kind} rl-toast--with-action`}
      role="group"
      aria-label={item.message}
      data-testid="rl-toast"
      data-kind={item.kind}
      onPointerEnter={hold}
      onPointerLeave={resume}
      onFocusIn={hold}
      onFocusOut={resume}
    >
      <Icon name={KIND_ICON[item.kind]} size={14} class="rl-toast__icon" />
      <span class="rl-toast__text">{item.message}</span>
      <button type="button" class="rl-toast__action" data-testid="rl-toast-action" onClick={() => runAction(item)}>
        {item.action!.label}
      </button>
      <button
        type="button"
        class="rl-icon-btn rl-icon-btn--sm rl-toast__close"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => dismiss(item.id)}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

/** Rendered once by App. */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    const update = () => setList(items);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  return (
    <div class="rl-toasts" role="status" aria-live="polite" aria-relevant="additions">
      {list.map((t) =>
        t.action ? (
          <ActionToast key={t.id} item={t} />
        ) : (
          <button
            key={t.id}
            type="button"
            class={`rl-toast rl-toast--${t.kind}`}
            data-testid="rl-toast"
            data-kind={t.kind}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            <Icon name={KIND_ICON[t.kind]} size={14} class="rl-toast__icon" />
            <span class="rl-toast__text">{t.message}</span>
          </button>
        ),
      )}
    </div>
  );
}
