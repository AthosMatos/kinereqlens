// Tab-level orchestration: applying TabState changes (persist, broadcast, badge, capture on/off) and the
// toolbar toggle with on-demand content-script injection.
import type { TabMessage } from '../shared/messages';
import type { TabState } from '../shared/types';
import type { Badge } from './badge';
import { injectContentScripts, isRestrictedUrl, pingTopFrame, probeTopFrame } from './inject';
import type { ReplayRunner } from './replay';
import type { TabStore } from './tabs';
import type { WebRequestCollector } from './webrequest';
import type { WebRequestRegistration } from './wr-listeners';

export interface ControllerDeps {
  ready: Promise<void>;
  tabs: TabStore;
  collector: WebRequestCollector;
  badge: Badge;
  replays: ReplayRunner;
  webRequest: WebRequestRegistration;
}

/** What `TabController.open` did. */
export type OpenOutcome = { ok: true; state: TabState } | { ok: false; reason: 'gone' | 'restricted' | 'pdf' | 'file-access' };

export class TabController {
  /** Per-tab promise chain so rapid toggles apply in order. */
  private readonly toggles = new Map<number, Promise<void>>();

  constructor(private readonly deps: ControllerDeps) {}

  /** Apply a sanitized patch: persist, update capture/badge, and broadcast TAB_STATE to every frame. */
  async setState(tabId: number, patch: Partial<TabState>): Promise<TabState> {
    const { tabs, collector, badge, webRequest } = this.deps;
    const wasOpen = tabs.isOpen(tabId);
    const persisted = tabs.update(tabId, patch); // updates the in-memory mirror synchronously
    webRequest.setActive(tabs.anyOpen());
    const next = await persisted;
    if (wasOpen && !next.open) {
      collector.dropTab(tabId);
      badge.clear(tabId);
    }
    this.broadcast(tabId, next);
    return next;
  }

  /** Toolbar button / Alt+Shift+L. Accepts a tab or a tab id (E2E tests call it with an id). */
  toggle(tabOrId: chrome.tabs.Tab | number): Promise<void> {
    const tabId = typeof tabOrId === 'number' ? tabOrId : tabOrId.id;
    if (tabId === undefined || !Number.isSafeInteger(tabId) || tabId < 0) return Promise.resolve();
    return this.serialize(tabId, () => this.toggleNow(tabId, typeof tabOrId === 'number' ? undefined : tabOrId)).then(
      () => undefined,
      (err: unknown) => console.error('[kineReqLens] toggle failed', err),
    );
  }

  /**
   * Open the overlay in a tab (Claude Code control plane): the toolbar button's checks and content-script injection;
   * `hidden` keeps the panel invisible while the tab captures. An overlay that is already open only changes its
   * `hidden` flag. Serialized with toggles of the same tab.
   */
  open(tabId: number, options: { hidden?: boolean } = {}): Promise<OpenOutcome> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return Promise.resolve({ ok: false, reason: 'gone' });
    return this.serialize(tabId, async () => {
      const { tabs } = this.deps;
      await this.deps.ready;
      const hidden = options.hidden === true;
      if (tabs.isOpen(tabId)) {
        const state = tabs.isHidden(tabId) === hidden ? tabs.get(tabId) : await this.setState(tabId, { hidden });
        return { ok: true, state };
      }
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) return { ok: false, reason: 'gone' };
      return this.openNow(tabId, tab, hidden);
    });
  }

  /** Run `fn` after the tab's previous toggle / open (rapid toggles apply in order). */
  private serialize<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.toggles.get(tabId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.toggles.set(tabId, settled);
    void settled.then(() => {
      if (this.toggles.get(tabId) === settled) this.toggles.delete(tabId);
    });
    return run;
  }

  /** chrome.tabs.onRemoved */
  async onTabRemoved(tabId: number): Promise<void> {
    const { tabs, collector, badge, replays, webRequest } = this.deps;
    await this.deps.ready;
    collector.dropTab(tabId);
    replays.abortTab(tabId);
    badge.forget(tabId);
    await tabs.remove(tabId);
    webRequest.setActive(tabs.anyOpen());
  }

  /** chrome.tabs.onReplaced: carry the state over to the new tab id. */
  async onTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    await this.deps.ready;
    this.deps.collector.dropTab(removedTabId);
    this.deps.replays.abortTab(removedTabId);
    await this.deps.tabs.transfer(removedTabId, addedTabId);
    this.deps.webRequest.setActive(this.deps.tabs.anyOpen());
  }

  private async toggleNow(tabId: number, given: chrome.tabs.Tab | undefined): Promise<void> {
    const { tabs } = this.deps;
    await this.deps.ready;
    const tab = given ?? (await chrome.tabs.get(tabId).catch(() => undefined));
    if (!tab) return;

    if (tabs.isOpen(tabId)) {
      // Open in the background for Claude Code: the toolbar button shows it (same panel, same state).
      await this.setState(tabId, tabs.isHidden(tabId) ? { hidden: false } : { open: false });
      return;
    }
    await this.openNow(tabId, tab, false);
  }

  /** Open a closed overlay: restricted-page checks, then capture on, then content scripts injected when missing. */
  private async openNow(tabId: number, tab: chrome.tabs.Tab, hidden: boolean): Promise<OpenOutcome> {
    const { tabs, badge } = this.deps;
    // tab.url is only exposed for pages matching the host permissions, so an undefined URL is not
    // conclusive; the scripting probe decides.
    const url = tab.url || tab.pendingUrl || undefined;
    if (url && isRestrictedUrl(url)) {
      badge.markRestricted(tabId, 'restricted');
      return { ok: false, reason: 'restricted' };
    }
    const probe = await probeTopFrame(tabId, url);
    if (!probe.ok) {
      badge.markRestricted(tabId, probe.reason);
      return { ok: false, reason: probe.reason };
    }

    badge.clearRestricted(tabId);
    const opened = await this.setState(tabId, hidden ? { open: true, recording: true, hidden: true } : { open: true, recording: true });
    if (await pingTopFrame(tabId)) return { ok: true, state: opened };

    // Page loaded before the extension was installed/reloaded: inject now. The fresh content scripts ask
    // for GET_TAB_STATE themselves; the resend covers frames whose scripts were already running.
    if (await injectContentScripts(tabId)) {
      this.broadcast(tabId, tabs.get(tabId));
      return { ok: true, state: tabs.get(tabId) };
    }
    await this.setState(tabId, { open: false });
    badge.markRestricted(tabId, 'restricted');
    return { ok: false, reason: 'restricted' };
  }

  private broadcast(tabId: number, tabState: TabState): void {
    const message: TabMessage = { type: 'TAB_STATE', tabState };
    chrome.tabs.sendMessage(tabId, message).catch(() => {
      // No content script in this tab (yet): it reads the state with GET_TAB_STATE when it starts.
    });
  }
}
