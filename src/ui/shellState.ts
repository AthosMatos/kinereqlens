// Shell UI state that survives a reload of the panel frame (handed to the host with the drafts, see
// src/ui/panel/uiState.ts): which request is selected. The App owns the selection; code outside it (the Claude Code
// control plane, src/ui/panel/control.ts) asks for a selection with requestShellSelection.
let selectedId: string | null = null;
const listeners = new Set<() => void>();
const requestListeners = new Set<(id: string | null) => void>();
/** A selection asked for from outside that the App has not taken yet (its listener may subscribe late). */
let pendingRequest: { id: string | null } | null = null;

export interface ShellState {
  selectedId: string | null;
}

export function getShellState(): ShellState {
  return { selectedId };
}

/** Restore the state of a previous panel (before the App renders). */
export function restoreShellState(state: unknown): void {
  const id = state && typeof state === 'object' ? (state as { selectedId?: unknown }).selectedId : null;
  selectedId = typeof id === 'string' ? id : null;
}

export function setShellSelection(id: string | null): void {
  if (id === selectedId) return;
  selectedId = id;
  for (const fn of [...listeners]) fn();
}

export function subscribeShellState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Select a request from outside the App (and open its detail). Recorded at once (so a reloaded or not yet rendered
 * App starts with it), then handed to the App's listener.
 */
export function requestShellSelection(id: string | null): void {
  setShellSelection(id);
  pendingRequest = { id };
  if (requestListeners.size === 0) return;
  pendingRequest = null;
  for (const fn of [...requestListeners]) {
    try {
      fn(id);
    } catch (err) {
      console.error('[kineReqLens] selection listener failed', err);
    }
  }
}

/**
 * The App follows selection requests. A request made before it subscribed (a panel mounted for Claude runs effects
 * late) is handed over at once. Returns the unsubscribe function.
 */
export function onShellSelectionRequest(fn: (id: string | null) => void): () => void {
  requestListeners.add(fn);
  const pending = pendingRequest;
  pendingRequest = null;
  if (pending) fn(pending.id);
  return () => {
    requestListeners.delete(fn);
  };
}
