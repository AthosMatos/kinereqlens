// Toolbar badge: request count per tab while the overlay is open, "×" on pages kineReqLens cannot run on.

/** Badge background (the UI accent). */
export const BADGE_COLOR = '#0230bb';
const BADGE_TEXT_COLOR = '#ffffff';
const RESTRICTED_TEXT = '×';

export const RESTRICTED_TITLES = {
  restricted: "kineReqLens can't run on this page",
  pdf: "kineReqLens can't run on this page (PDF viewer)",
  'file-access': 'kineReqLens can\'t run on this page — enable "Allow access to file URLs" in the extension details',
} as const;

export type RestrictedReason = keyof typeof RESTRICTED_TITLES;

/** Badge text for a request count: '' for 0, '999+' beyond 999. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 999 ? '999+' : String(Math.floor(count));
}

/** Tracks per-tab badge state and talks to chrome.action. All calls are best effort. */
export class Badge {
  private readonly restricted = new Set<number>();

  /** Global badge colors (per-tab badges inherit them). */
  init(): void {
    void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(ignore);
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      void chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR }).catch(ignore);
    }
  }

  setCount(tabId: number, count: number): void {
    this.clearRestricted(tabId);
    void chrome.action.setBadgeText({ tabId, text: badgeText(count) }).catch(ignore);
  }

  clear(tabId: number): void {
    this.clearRestricted(tabId);
    void chrome.action.setBadgeText({ tabId, text: '' }).catch(ignore);
  }

  markRestricted(tabId: number, reason: RestrictedReason): void {
    this.restricted.add(tabId);
    void chrome.action.setBadgeText({ tabId, text: RESTRICTED_TEXT }).catch(ignore);
    void chrome.action.setTitle({ tabId, title: RESTRICTED_TITLES[reason] }).catch(ignore);
  }

  /** A content script answered from this tab, so it is not restricted (any more). */
  clearRestricted(tabId: number): void {
    if (!this.restricted.delete(tabId)) return;
    void chrome.action.setBadgeText({ tabId, text: '' }).catch(ignore);
    void chrome.action.setTitle({ tabId, title: defaultTitle() }).catch(ignore);
  }

  forget(tabId: number): void {
    this.restricted.delete(tabId);
  }
}

function defaultTitle(): string {
  return chrome.runtime.getManifest().action?.default_title ?? 'kineReqLens';
}

function ignore(): void {
  // The tab may be gone; badge updates are cosmetic.
}
