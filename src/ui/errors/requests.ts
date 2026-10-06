// Requests to the Errors view from outside it (the Claude Code control plane, src/ui/panel/control.ts): select an
// endpoint and, for the full-mode outward actions, open its confirmation dialog — the user still confirms every
// issue / commit / push / pull request / discard with a click there. Taken by the view when it mounts, or at once
// when it is mounted (like src/ui/detail/resultsTab.ts).

export type ErrorsDialogRequest = 'issue' | 'commit' | 'pr' | 'discard';

export interface ErrorsRequest {
  /** ErrorGroup.key of the endpoint. */
  key: string;
  dialog?: ErrorsDialogRequest;
}

let pending: ErrorsRequest | null = null;
const listeners = new Set<() => void>();

/** Ask the Errors view to show `key` (and open a dialog). Replaces an older request. */
export function requestErrorsAction(request: ErrorsRequest): void {
  pending = { ...request };
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[kineReqLens] errors request listener failed', err);
    }
  }
}

/** The pending request (not consumed). */
export function peekErrorsRequest(): ErrorsRequest | null {
  return pending;
}

/** Consume the pending request when it is about `key` (any key when omitted). */
export function takeErrorsRequest(key?: string): ErrorsRequest | null {
  if (!pending || (key !== undefined && pending.key !== key)) return null;
  const request = pending;
  pending = null;
  return request;
}

/** Drop the dialog part of the pending request of `key` (the endpoint is shown; the dialog is opened elsewhere). */
export function takeErrorsDialog(key: string): ErrorsDialogRequest | null {
  if (!pending || pending.key !== key || !pending.dialog) return null;
  const dialog = pending.dialog;
  pending = null;
  return dialog;
}

/** Called after every request. Returns the unsubscribe function. */
export function onErrorsRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
