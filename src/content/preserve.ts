/**
 * Preserved log (docs/ARCHITECTURE.md §2.4): while `tabState.preserveLog` is on, the last PRESERVED_LOG_MAX
 * entries are written (debounced, 1 s) to `chrome.storage.session[preservedLogKey(tabId)]`, and the next page
 * load of the tab restores them as `restored` entries.
 *
 * chrome.storage.session has a 10 MB quota shared by the whole extension, so a log is also bounded by a byte
 * budget (newest entries win); a failed write is retried once with a quarter of the budget.
 */
import { PRESERVED_BODY_CAP, PRESERVED_LOG_MAX, preservedLogKey } from '../shared/constants';
import type { RequestEntry } from '../shared/types';
import { toPreserved } from '../lib/capture';
import type { Timers } from './schedule';
import { Debouncer } from './schedule';
import { isRequestEntryLike } from './validate';

/** Storage backend (chrome.storage.session in production). */
export interface PreserveStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: RequestEntry[]): Promise<boolean>;
  remove(key: string): Promise<boolean>;
}

/** Dependencies of PreservedLog. */
export interface PreservedLogDeps {
  storage: PreserveStorage;
  timers: Timers;
  /** Current entries, oldest first. */
  entries(): RequestEntry[];
}

/** Debounce of preserved-log writes (ms). */
export const PRESERVE_DEBOUNCE_MS = 1000;
/** Default serialized-size budget of one tab's log. */
export const PRESERVE_BUDGET_BYTES = 2 * 1024 * 1024;
const MIN_BUDGET_BYTES = 64 * 1024;

interface PreservedItem {
  entry: RequestEntry;
  /** Approximate serialized size (JSON length). */
  size: number;
}

/**
 * Entries to persist: the newest `max` entries that fit in `budget` bytes, oldest first. Restored entries are
 * already in preserved form and kept as they are (re-preserving would stack "r:" prefixes).
 */
export function selectPreserved(
  entries: readonly RequestEntry[],
  budget: number,
  convert: (entry: RequestEntry) => PreservedItem,
  max = PRESERVED_LOG_MAX,
): RequestEntry[] {
  const picked: RequestEntry[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0 && picked.length < max; index--) {
    const item = convert(entries[index]);
    if (used + item.size > budget) continue; // a smaller, older entry may still fit
    used += item.size;
    picked.push(item.entry);
  }
  return picked.reverse();
}

/** Debounced writer / reader of one tab's preserved log. */
export class PreservedLog {
  private key: string | null = null;
  private enabled = false;
  private disposed = false;
  private loading: Promise<unknown> = Promise.resolve();
  /** Entries are immutable, so their preserved form is computed once per object. */
  private readonly cache = new WeakMap<RequestEntry, PreservedItem>();
  private readonly debouncer: Debouncer;

  constructor(private readonly deps: PreservedLogDeps) {
    this.debouncer = new Debouncer(deps.timers, PRESERVE_DEBOUNCE_MS, () => {
      void this.write();
    });
  }

  /** The tab this page belongs to (known after GET_TAB_STATE). */
  setTab(tabId: number): void {
    const key = preservedLogKey(tabId);
    if (key === this.key) return;
    this.key = key;
    if (this.enabled) this.debouncer.schedule();
  }

  /** Follow `tabState.preserveLog`: turning it on persists the current entries, turning it off drops the log. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled || this.disposed) return;
    this.enabled = enabled;
    if (enabled) {
      this.debouncer.schedule();
    } else {
      this.debouncer.cancel();
      void this.remove();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Read the stored log of the tab (structurally valid entries only). Never rejects. */
  async load(): Promise<RequestEntry[]> {
    const key = this.key;
    if (!key || this.disposed) return [];
    const reading = this.deps.storage.read(key).catch(() => undefined);
    this.loading = reading;
    const value = await reading;
    return Array.isArray(value) ? value.filter(isRequestEntryLike) : [];
  }

  /** Entries changed: persist them later (no-op while disabled). */
  schedule(): void {
    if (this.enabled && !this.disposed) this.debouncer.schedule();
  }

  /** Write a pending change right away (page is being hidden / unloaded). */
  flush(): void {
    this.debouncer.flush();
  }

  /** Drop the stored log ("Clear"). */
  clear(): void {
    this.debouncer.cancel();
    void this.remove();
  }

  dispose(): void {
    this.disposed = true;
    this.debouncer.cancel();
  }

  private convert = (entry: RequestEntry): PreservedItem => {
    let item = this.cache.get(entry);
    if (!item) {
      const preserved = entry.restored ? entry : toPreserved(entry, PRESERVED_BODY_CAP);
      item = { entry: preserved, size: JSON.stringify(preserved).length };
      this.cache.set(entry, item);
    }
    return item;
  };

  private async write(): Promise<void> {
    // Never overwrite the previous page's log before it was read back.
    await this.loading;
    const key = this.key;
    if (!key || !this.enabled || this.disposed) return;
    let list: RequestEntry[];
    try {
      list = selectPreserved(this.deps.entries(), PRESERVE_BUDGET_BYTES, this.convert);
    } catch {
      return;
    }
    if (list.length === 0) {
      await this.remove();
      return;
    }
    if (await this.deps.storage.write(key, list).catch(() => false)) return;
    // Most likely the shared session quota: retry once with a smaller log.
    const smaller = selectPreserved(list, Math.max(MIN_BUDGET_BYTES, PRESERVE_BUDGET_BYTES / 4), this.convert);
    if (smaller.length > 0 && !this.disposed) await this.deps.storage.write(key, smaller).catch(() => false);
  }

  private async remove(): Promise<void> {
    if (this.key) await this.deps.storage.remove(this.key).catch(() => false);
  }
}
