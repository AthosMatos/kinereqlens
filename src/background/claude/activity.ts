// Which tab a Claude Code call without `tabId` is about: the tab where the overlay was most recently active
// (tab activated / window focused while its overlay is open, overlay opened, panel connected). The order is
// kept in chrome.storage.session so it survives service-worker restarts.

/** chrome.storage.session key of the persisted order (no trailing digits: TabStore's key pruning ignores it). */
export const ACTIVITY_KEY = 'reqlens:claude:activity';
const MAX_TRACKED = 64;

/** Most-recent-first list of tabs whose overlay was active. */
export class TabActivity {
  private order: number[] = [];

  /**
   * @param isOpen  whether the overlay is open in a tab (only such tabs are recorded by `touch`)
   * @param persist called with the new order after every change
   */
  constructor(
    private readonly isOpen: (tabId: number) => boolean,
    private readonly persist: (order: number[]) => void = () => undefined,
  ) {}

  /** The overlay of `tabId` was active just now (ignored when it is not open there). */
  touch(tabId: number): void {
    if (!isTabId(tabId) || !this.isOpen(tabId)) return;
    if (this.order[0] === tabId) return;
    this.order = [tabId, ...this.order.filter((id) => id !== tabId)].slice(0, MAX_TRACKED);
    this.persist(this.order);
  }

  remove(tabId: number): void {
    if (!this.order.includes(tabId)) return;
    this.order = this.order.filter((id) => id !== tabId);
    this.persist(this.order);
  }

  /** chrome.tabs.onReplaced: the tab content moved to a new id. */
  replace(fromTabId: number, toTabId: number): void {
    if (!this.order.includes(fromTabId) || !isTabId(toTabId)) return;
    this.order = this.order.filter((id) => id !== toTabId).map((id) => (id === fromTabId ? toTabId : id));
    this.persist(this.order);
  }

  /** Merge a persisted order under the tabs touched since startup. */
  restore(value: unknown): void {
    if (!Array.isArray(value)) return;
    const merged = [...this.order];
    for (const id of value) if (isTabId(id) && !merged.includes(id)) merged.push(id);
    this.order = merged.slice(0, MAX_TRACKED);
  }

  /** Most recent first. */
  ordered(): number[] {
    return [...this.order];
  }

  /**
   * Default tab: the most recent one whose overlay is open; else any tab with the overlay open (lowest id
   * first, deterministic); else the most recent one (its entries may still be in memory); else null.
   */
  defaultTab(openTabIds: readonly number[]): number | null {
    for (const id of this.order) if (this.isOpen(id)) return id;
    const open = [...openTabIds].filter(isTabId).sort((a, b) => a - b);
    if (open.length > 0) return open[0]!;
    return this.order[0] ?? null;
  }
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
