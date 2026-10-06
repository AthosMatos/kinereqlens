// Requests to bring a results-area tab of an entry to the front from outside the detail pane (e.g. the row
// context menu's "Show initiator / component", the results of "Where does this come from?", the Claude Code control
// plane). The detail pane's
// results area takes the request when it shows that entry — at mount when the entry is being selected, or at once
// when it already is.

export type RequestedTab = 'initiator' | 'original' | 'export' | 'test';

let pending: { entryId: string; tab: RequestedTab } | null = null;
const listeners = new Set<() => void>();

/** Ask the results area of `entryId` to show `tab`. */
export function requestResultsTab(entryId: string, tab: RequestedTab): void {
  pending = { entryId, tab };
  for (const fn of [...listeners]) fn();
}

/** The tab requested for `entryId` (consumed), or null. */
export function takeRequestedTab(entryId: string): RequestedTab | null {
  if (!pending || pending.entryId !== entryId) return null;
  const { tab } = pending;
  pending = null;
  return tab;
}

/** Called after every request. Returns the unsubscribe function. */
export function onResultsTabRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
