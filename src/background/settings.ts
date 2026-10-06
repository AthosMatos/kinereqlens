// Read-only view of the user's Settings for the service worker (body caps for webRequest capture).
// The content script owns writes; the worker follows chrome.storage.onChanged.
import { DEFAULT_SETTINGS, SETTINGS_KEY, mergeSettings } from '../shared/constants';
import type { Settings, SettingsPatch } from '../shared/types';
import { isRecord } from './util';

/** Upper bound for the webRequest request-body cap, whatever the stored settings say. */
const MAX_REQUEST_BODY_CAP = 64 * 1024 * 1024;

/** Settings merged over defaults; non-object stored values fall back to defaults. */
export function settingsFromStorage(value: unknown): Settings {
  return mergeSettings(DEFAULT_SETTINGS, isRecord(value) ? (value as SettingsPatch) : null);
}

/** Sanitized request body cap in bytes (falls back to the default for garbage values). */
export function requestBodyCapOf(settings: Settings): number {
  const cap = settings.requestBodyCap;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return DEFAULT_SETTINGS.requestBodyCap;
  return Math.min(Math.floor(cap), MAX_REQUEST_BODY_CAP);
}

/** In-memory mirror of chrome.storage.local[SETTINGS_KEY]. */
export class SettingsCache {
  private current: Settings = settingsFromStorage(null);

  /** Loads the stored settings; never rejects (defaults stay in place on failure). */
  async load(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      this.current = settingsFromStorage(stored[SETTINGS_KEY]);
    } catch (err) {
      console.warn('[kineReqLens] could not read settings', err);
    }
  }

  get(): Settings {
    return this.current;
  }

  /** Take settings the worker just wrote itself (the storage change event follows later). */
  adopt(settings: Settings): void {
    this.current = settings;
  }

  requestBodyCap(): number {
    return requestBodyCapOf(this.current);
  }

  /** chrome.storage.onChanged handler. */
  handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    if (areaName !== 'local') return;
    const change = changes[SETTINGS_KEY];
    if (change) this.current = settingsFromStorage(change.newValue);
  }
}
