/**
 * Safe wrappers over the chrome.* APIs used by the content script.
 *
 * After the extension is reloaded or updated, an already-injected content script keeps running but every
 * chrome.* call throws "Extension context invalidated". These wrappers detect that once, notify listeners
 * (so the content script can stop using chrome APIs) and never throw into the caller unless asked to.
 * "Receiving end does not exist" / closed message ports are treated as ordinary failures.
 */
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages';

const INVALIDATED = /extension context invalidated/i;

let invalidated = false;
const invalidationListeners = new Set<() => void>();

/** Message text of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

function markInvalidated(): void {
  if (invalidated) return;
  invalidated = true;
  for (const listener of [...invalidationListeners]) {
    try {
      listener();
    } catch {
      /* listeners must not break each other */
    }
  }
}

/** Inspect an error from a chrome.* call; flags context invalidation as a side effect. */
function noteError(error: unknown): Error {
  const message = errorMessage(error);
  if (INVALIDATED.test(message)) markInvalidated();
  return error instanceof Error ? error : new Error(message);
}

/** False once the extension context is gone (extension reloaded/updated/removed). */
export function isContextValid(): boolean {
  if (invalidated) return false;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) return true;
  } catch {
    /* accessing chrome.runtime can throw once invalidated */
  }
  markInvalidated();
  return false;
}

/** Subscribe to context invalidation (fires at most once). Returns an unsubscribe function. */
export function onInvalidated(listener: () => void): () => void {
  if (invalidated) {
    listener();
    return () => undefined;
  }
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/** chrome.runtime.sendMessage; rejects with an Error on failure (including an invalidated context). */
export async function sendRuntime<T extends RuntimeRequest>(message: T): Promise<RuntimeResponse<T['type']>> {
  if (!isContextValid()) throw new Error('Extension context invalidated');
  try {
    return (await chrome.runtime.sendMessage(message)) as RuntimeResponse<T['type']>;
  } catch (error) {
    throw noteError(error);
  }
}

/** Like sendRuntime but resolves `undefined` on any failure. */
export async function trySendRuntime<T extends RuntimeRequest>(
  message: T,
): Promise<RuntimeResponse<T['type']> | undefined> {
  try {
    return await sendRuntime(message);
  } catch {
    return undefined;
  }
}

/** chrome.storage areas used by the content script. */
export type StorageAreaName = 'local' | 'session';

function area(name: StorageAreaName): chrome.storage.StorageArea | null {
  if (!isContextValid()) return null;
  try {
    return chrome.storage?.[name] ?? null;
  } catch (error) {
    noteError(error);
    return null;
  }
}

/** Value stored under `key`, or undefined (missing key, no access, invalidated context). */
export async function storageGet(name: StorageAreaName, key: string): Promise<unknown> {
  const storage = area(name);
  if (!storage) return undefined;
  try {
    const items = await storage.get(key);
    return items?.[key];
  } catch (error) {
    noteError(error);
    return undefined;
  }
}

/** Resolves true when written. */
export async function storageSet(name: StorageAreaName, items: Record<string, unknown>): Promise<boolean> {
  const storage = area(name);
  if (!storage) return false;
  try {
    await storage.set(items);
    return true;
  } catch (error) {
    noteError(error);
    return false;
  }
}

/** Resolves true when removed. */
export async function storageRemove(name: StorageAreaName, key: string): Promise<boolean> {
  const storage = area(name);
  if (!storage) return false;
  try {
    await storage.remove(key);
    return true;
  } catch (error) {
    noteError(error);
    return false;
  }
}

type StorageChanges = Record<string, chrome.storage.StorageChange>;

/** chrome.storage.onChanged subscription. Returns an unsubscribe function (safe after invalidation). */
export function onStorageChanged(listener: (changes: StorageChanges, areaName: string) => void): () => void {
  if (!isContextValid()) return () => undefined;
  const wrapped = (changes: StorageChanges, areaName: string): void => {
    try {
      listener(changes, areaName);
    } catch {
      /* isolate listener errors */
    }
  };
  try {
    chrome.storage.onChanged.addListener(wrapped);
  } catch (error) {
    noteError(error);
    return () => undefined;
  }
  return () => {
    try {
      chrome.storage.onChanged.removeListener(wrapped);
    } catch {
      /* context gone: nothing to remove */
    }
  };
}

/** chrome.runtime.onMessage listener signature. */
export type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

/** chrome.runtime.onMessage subscription. Returns an unsubscribe function (safe after invalidation). */
export function onRuntimeMessage(listener: RuntimeMessageListener): () => void {
  if (!isContextValid()) return () => undefined;
  try {
    chrome.runtime.onMessage.addListener(listener);
  } catch (error) {
    noteError(error);
    return () => undefined;
  }
  return () => {
    try {
      chrome.runtime.onMessage.removeListener(listener);
    } catch {
      /* context gone */
    }
  };
}

/** This extension's id, or undefined when the context is gone. */
export function extensionId(): string | undefined {
  try {
    return chrome.runtime?.id;
  } catch {
    return undefined;
  }
}
