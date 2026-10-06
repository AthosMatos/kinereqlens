// Preserved log storage (docs/ARCHITECTURE.md §2.4). chrome.storage.session stays at its default
// TRUSTED_CONTEXTS access level, so content scripts cannot read or write it: a tab's content script persists
// and reads back its own log through PRESERVE_* messages, and the worker always derives the storage key from
// the sender's tab — no renderer can reach another tab's log (cookies, request bodies, ...).
import { PRESERVED_LOG_MAX, preservedLogKey } from '../shared/constants';
import { isRecord } from './util';

/** Largest preserved log accepted from a content script (serialized JSON length). */
export const PRESERVE_MAX_BYTES = 4 * 1024 * 1024;

/** Storage operations behind the PRESERVE_* messages (chrome.storage.session in production). */
export interface PreserveBackend {
  read(tabId: number): Promise<unknown[]>;
  /** Resolves false when the payload is rejected or the write failed. */
  write(tabId: number, entries: unknown): Promise<boolean>;
  clear(tabId: number): Promise<boolean>;
}

/**
 * Shape and size check of a preserved log sent by a content script (entries are re-validated one by one by
 * the content script that reads them back). Returns the list, or null when it is not acceptable.
 */
export function validPreservedLog(value: unknown, maxBytes = PRESERVE_MAX_BYTES): unknown[] | null {
  if (!Array.isArray(value) || value.length > PRESERVED_LOG_MAX) return null;
  if (!value.every((item) => isRecord(item) && typeof item.id === 'string' && item.id.startsWith('r:'))) return null;
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return null;
  }
  return size <= maxBytes ? value : null;
}

/** chrome.storage.session implementation. */
export const sessionPreserveBackend: PreserveBackend = {
  async read(tabId) {
    try {
      const key = preservedLogKey(tabId);
      const value: unknown = (await chrome.storage.session.get(key))[key];
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  },
  async write(tabId, entries) {
    const list = validPreservedLog(entries);
    if (!list) return false;
    try {
      await chrome.storage.session.set({ [preservedLogKey(tabId)]: list });
      return true;
    } catch {
      return false;
    }
  },
  async clear(tabId) {
    try {
      await chrome.storage.session.remove(preservedLogKey(tabId));
      return true;
    } catch {
      return false;
    }
  },
};
