// The panel's top-level view: "http" (request list + editor), "ws" (WebSocket inspector), "errors" (failing
// endpoints + Claude analysis, src/ui/errors/) or "shot" (screenshot tool), picked in the navigation rail (src/ui/rail/Rail.tsx). The choice survives view switches and a reloaded
// panel frame of the same page (sessionStorage). Module state: code outside the App (the Claude Code control plane,
// src/ui/panel/control.ts; the screenshot command) switches it with setPanelView.
import { useEffect, useState } from 'preact/hooks';

export type PanelView = 'http' | 'ws' | 'shot' | 'errors';

const KEY = 'reqlens:view';
const VIEWS: readonly PanelView[] = ['http', 'ws', 'shot', 'errors'];

function readView(): PanelView {
  try {
    const stored = sessionStorage.getItem(KEY);
    return VIEWS.find((v) => v === stored) ?? 'http';
  } catch {
    return 'http';
  }
}

let current: PanelView | null = null;
const listeners = new Set<() => void>();

/** The active view (read from sessionStorage the first time). */
export function getPanelView(): PanelView {
  current ??= readView();
  return current;
}

/** Switch the panel's view (also from outside the App). */
export function setPanelView(next: PanelView): void {
  if (!VIEWS.includes(next)) return;
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable: in memory only */
  }
  if (getPanelView() === next) return;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[kineReqLens] view listener failed', err);
    }
  }
}

/** Follow view changes. Returns the unsubscribe function. */
export function subscribePanelView(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The active view and its setter. */
export function usePanelView(): [PanelView, (view: PanelView) => void] {
  const [view, setViewState] = useState<PanelView>(getPanelView);
  useEffect(() => {
    const sync = () => setViewState(getPanelView());
    sync();
    return subscribePanelView(sync);
  }, []);
  return [view, setPanelView];
}
