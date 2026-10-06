// Per-tab TabState: durable in chrome.storage.session (survives service-worker restarts, cleared when the
// browser or extension restarts), mirrored in memory for synchronous reads by webRequest listeners.
import { DEFAULT_TAB_STATE, preservedLogKey, tabStateKey } from '../shared/constants';
import type { TabState } from '../shared/types';
import { isRecord } from './util';

/** Fields a content script / panel may change (SET_TAB_STATE). */
const TAB_STATE_FIELDS = ['open', 'recording', 'preserveLog'] as const;
/** Fields kept in storage: `hidden` (open in the background for Claude Code) is set by the worker only. */
const STORED_FIELDS = [...TAB_STATE_FIELDS, 'hidden'] as const;

/**
 * Keep only known boolean fields of an untrusted patch. Returns null when `value` is not an object or
 * carries a known field with a non-boolean value (strict: a malformed patch changes nothing). `hidden` is not
 * accepted: only the worker's Claude Code control plane opens an overlay in the background.
 */
export function sanitizeTabStatePatch(value: unknown): Partial<TabState> | null {
  if (!isRecord(value)) return null;
  const patch: Partial<TabState> = {};
  for (const field of TAB_STATE_FIELDS) {
    if (!(field in value) || value[field] === undefined) continue;
    const v = value[field];
    if (typeof v !== 'boolean') return null;
    patch[field] = v;
  }
  return patch;
}

/** A stored value coerced into a complete TabState (missing or non-boolean fields fall back to defaults). */
export function tabStateFromStorage(value: unknown): TabState {
  const state: TabState = { ...DEFAULT_TAB_STATE };
  if (!isRecord(value)) return state;
  for (const field of STORED_FIELDS) {
    const v = value[field];
    if (typeof v === 'boolean') state[field] = v;
  }
  if (!state.open || state.hidden !== true) delete state.hidden;
  return state;
}

/** Tab id encoded in a tabStateKey(), or null for any other key. */
export function tabIdFromStateKey(key: string): number | null {
  return tabIdOfKey(key, tabStateKey);
}

/** Tab id of a tabStateKey() or preservedLogKey(), or null for any other key. */
export function tabIdFromKey(key: string): number | null {
  return tabIdOfKey(key, tabStateKey) ?? tabIdOfKey(key, preservedLogKey);
}

function tabIdOfKey(key: string, keyOf: (tabId: number) => string): number | null {
  const match = /(\d+)$/.exec(key);
  if (!match) return null;
  const tabId = Number(match[1]);
  return Number.isSafeInteger(tabId) && keyOf(tabId) === key ? tabId : null;
}

export class TabStore {
  private readonly states = new Map<number, TabState>();
  private loaded = false;

  /**
   * Load the persisted state of every existing tab. Never rejects.
   *
   * Only the state keys of live tabs are read: storage.session also holds the content scripts' preserved
   * logs (up to several MB), which must not be deserialized on every worker start.
   */
  async load(): Promise<void> {
    try {
      const tabIds = await liveTabIds();
      const keys = tabIds.map(tabStateKey);
      const stored = keys.length > 0 ? await chrome.storage.session.get(keys) : {};
      for (const tabId of tabIds) {
        const value: unknown = stored[tabStateKey(tabId)];
        // Never overwrite a state updated in memory while this load was in flight.
        if (value !== undefined && !this.states.has(tabId)) this.states.set(tabId, tabStateFromStorage(value));
      }
      void this.pruneStaleKeys(new Set(tabIds));
    } catch (err) {
      console.warn('[kineReqLens] could not read tab state', err);
    }
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Current state of a tab (a copy; the default state for unknown tabs). */
  get(tabId: number): TabState {
    return { ...(this.states.get(tabId) ?? DEFAULT_TAB_STATE) };
  }

  isOpen(tabId: number): boolean {
    return this.states.get(tabId)?.open === true;
  }

  /** Open in the background for Claude Code (capturing, panel not shown). */
  isHidden(tabId: number): boolean {
    const state = this.states.get(tabId);
    return state?.open === true && state.hidden === true;
  }

  /** Effective capture: open && recording. */
  isRecording(tabId: number): boolean {
    const state = this.states.get(tabId);
    return state !== undefined && state.open && state.recording;
  }

  /** Tabs whose overlay is open. */
  openTabIds(): number[] {
    const ids: number[] = [];
    for (const [tabId, state] of this.states) if (state.open) ids.push(tabId);
    return ids;
  }

  anyOpen(): boolean {
    for (const state of this.states.values()) if (state.open) return true;
    return false;
  }

  /** Merge a (sanitized) patch, update the mirror synchronously and persist. Resolves with the new state. */
  async update(tabId: number, patch: Partial<TabState>): Promise<TabState> {
    const next: TabState = { ...this.get(tabId), ...patch };
    // Opening / closing without saying otherwise shows the overlay (the user's toolbar button, the × button):
    // only the control plane opens one in the background. `hidden` only means something while open.
    if (patch.open !== undefined && patch.hidden === undefined) delete next.hidden;
    if (!next.open || next.hidden !== true) delete next.hidden;
    this.states.set(tabId, next);
    try {
      await chrome.storage.session.set({ [tabStateKey(tabId)]: next });
    } catch (err) {
      console.warn('[kineReqLens] could not persist tab state', err);
    }
    return { ...next };
  }

  /** Forget a closed tab: state and preserved log. */
  async remove(tabId: number): Promise<void> {
    this.states.delete(tabId);
    try {
      await chrome.storage.session.remove([tabStateKey(tabId), preservedLogKey(tabId)]);
    } catch {
      // Storage unavailable (extension shutting down) — nothing to clean.
    }
  }

  /** chrome.tabs.onReplaced: the tab content moved to a new tab id (prerender / instant swap). */
  async transfer(fromTabId: number, toTabId: number): Promise<void> {
    const state = this.states.get(fromTabId);
    if (!state) return;
    await this.update(toTabId, state);
    await this.remove(fromTabId);
  }

  /**
   * Remove state / preserved-log keys of tabs that no longer exist (their onRemoved cleanup was missed,
   * e.g. the worker was terminated mid-handler). Needs storage.session.getKeys (Chrome 130+); without it
   * such leftovers simply live until the browser restarts and clears session storage.
   */
  private async pruneStaleKeys(alive: Set<number>): Promise<void> {
    const session = chrome.storage.session;
    // Declared since Chrome 130; absent at runtime on 116..129.
    if (typeof session.getKeys !== 'function') return;
    try {
      const stale = (await session.getKeys()).filter((key) => {
        const tabId = tabIdFromKey(key);
        // Tabs known in memory may have been created after the query above.
        return tabId !== null && !alive.has(tabId) && !this.states.has(tabId);
      });
      if (stale.length > 0) await chrome.storage.session.remove(stale);
    } catch {
      // Best effort.
    }
  }
}

/** Ids of every open tab (all windows this extension can see). */
async function liveTabIds(): Promise<number[]> {
  const tabs = await chrome.tabs.query({});
  const ids: number[] = [];
  for (const tab of tabs) if (typeof tab.id === 'number' && tab.id >= 0) ids.push(tab.id);
  return ids;
}
