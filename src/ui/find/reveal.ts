// Find in page, panel side: requests to show a JSON node from outside the viewer that displays it — the results of
// "Where does this come from?" select a request (or a WebSocket message) and ask its response viewer to expand,
// scroll to, focus and flash a path. A viewer takes a request addressed to its `revealKey` when it mounts or, if it is
// already mounted, when the request is made (like resultsTab.ts for the results tabs).
import { createContext } from 'preact';

/**
 * Whether the views a JSON viewer sits in are shown (the panel's view, open and not minimized). Find in page only
 * scans for visible viewers; without a provider a viewer counts as visible.
 */
export const FindScopeContext = createContext<boolean>(true);

/** Reveal key of an entry's Original response viewer. */
export const originalRevealKey = (entryId: string): string => `original:${entryId}`;
/** Reveal key of a WebSocket message's payload viewer. */
export const wsRevealKey = (frameId: number): string => `ws:${frameId}`;

type Path = Array<string | number>;

let pending: { key: string; path: Path } | null = null;
const listeners = new Set<() => void>();

function emit(set: Set<() => void>): void {
  for (const fn of [...set]) {
    try {
      fn();
    } catch (err) {
      console.error('[kineReqLens] reveal listener failed', err);
    }
  }
}

/** Ask the viewer with `key` to reveal `path` (replaces an older request). */
export function requestReveal(key: string, path: Path): void {
  pending = { key, path };
  emit(listeners);
}

/** The path requested for `key` (consumed), or null. */
export function takeReveal(key: string): Path | null {
  if (!pending || pending.key !== key) return null;
  const { path } = pending;
  pending = null;
  return path;
}

/** A request for `key` is waiting (not consumed). */
export function hasReveal(key: string): boolean {
  return pending?.key === key;
}

/** Called after every request. Returns the unsubscribe function. */
export function onRevealRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ------------------------------------------------------------------------------------------------ WebSocket view

export interface WsRevealRequest {
  wsId: string;
  frameId: number;
}

let wsPending: WsRevealRequest | null = null;
const wsListeners = new Set<() => void>();

/** Ask the WebSocket view to select a message (its payload viewer then takes the path request). */
export function requestWsReveal(request: WsRevealRequest, path: Path): void {
  wsPending = request;
  requestReveal(wsRevealKey(request.frameId), path);
  emit(wsListeners);
}

/** The message the WebSocket view should select (consumed), or null. */
export function takeWsReveal(): WsRevealRequest | null {
  const request = wsPending;
  wsPending = null;
  return request;
}

export function onWsRevealRequest(fn: () => void): () => void {
  wsListeners.add(fn);
  return () => {
    wsListeners.delete(fn);
  };
}
