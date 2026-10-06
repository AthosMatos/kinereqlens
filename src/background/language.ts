// "Site language" tool, worker side (docs/ARCHITECTURE.md §11): which Accept-Language override applies to each tab,
// the declarativeNetRequest session rules that send it, and the pushes that tell the tab's frames (whose hooks then
// report it through navigator.language / Intl).
//
// Scopes: a tab override (storage.session, until the tab closes) wins over the site override of the tab's page host
// (settings.siteLanguages, written by the overlay). Rules (session, ids from LANGUAGE_RULE_ID_BASE, rewritten
// atomically on every change — never touching the replay rules of dnr.ts):
//  - tab override:  {tabIds:[tab]}, every resource type incl. main_frame, priority 3 — follows the tab everywhere;
//  - site override while a tab shows that host: {tabIds:[tab]}, every type but main_frame, priority 2 — document
//    subresources, API calls to other domains and subframes of that page; main_frame is left out so navigating
//    away to another host never carries the language along;
//  - per site: {regexFilter: ^https?://host(:port)?[/?#]…, resourceTypes:[main_frame]}, priority 1 — the document
//    request itself, before the tab's rule could follow a navigation onto the host.
// requestDomains / initiatorDomains are not used: both match subdomains, and initiatorDomains misses the document
// request and would follow the host's frames into other sites' pages.
import { LANGUAGE_RULE_ID_BASE, SETTINGS_KEY, TAB_LANGUAGES_KEY } from '../shared/constants';
import type { LanguageScope, LanguageStatus } from '../shared/language';
import { effectiveLanguage, normalizeLanguageValue, sanitizeSiteLanguages, siteKeyOf, siteLanguagesEqual } from '../shared/language';
import type { TabMessage } from '../shared/messages';
import type { Settings } from '../shared/types';
import { escapeRegex } from './dnr';
import { isRecord } from './util';

type DnrRule = chrome.declarativeNetRequest.Rule;
type Dnr = Pick<typeof chrome.declarativeNetRequest, 'getSessionRules' | 'updateSessionRules'>;

/** Rule priorities: a tab override beats the site's per-tab rule, which beats the site's document rule. */
export const PRIORITY_TAB = 3;
export const PRIORITY_SITE_TAB = 2;
export const PRIORITY_SITE_DOCUMENT = 1;

/** Resource types used when the runtime enum is unavailable (unit tests, older builds). */
export const FALLBACK_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;

/** One tab's effective override, as the rule builder needs it. */
export interface TabLanguageRule {
  tabId: number;
  value: string;
  scope: LanguageScope;
}

export interface LanguageRulesInput {
  tabs: readonly TabLanguageRule[];
  /** Site key (host name) → value. */
  sites: Readonly<Record<string, string>>;
  /** Every resource type the browser knows (chrome.declarativeNetRequest.ResourceType values). */
  resourceTypes: readonly string[];
  /** First rule id (LANGUAGE_RULE_ID_BASE). */
  baseId?: number;
}

/** Anchored RE2 pattern for the URLs of a site key: http(s), that exact host, any port. */
export function siteUrlRegex(host: string): string {
  return `^https?://${escapeRegex(host)}(:[0-9]+)?([/?#]|$)`;
}

function setHeader(value: string): chrome.declarativeNetRequest.RuleAction {
  return {
    type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
    requestHeaders: [{ header: 'accept-language', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value }],
  };
}

/** The complete set of language session rules for a state (ids consecutive from `baseId`). */
export function buildLanguageRules(input: LanguageRulesInput): DnrRule[] {
  const base = input.baseId ?? LANGUAGE_RULE_ID_BASE;
  const all = input.resourceTypes as chrome.declarativeNetRequest.ResourceType[];
  const noDocument = all.filter((t) => t !== 'main_frame');
  const rules: DnrRule[] = [];
  const tabs = [...input.tabs].sort((a, b) => a.tabId - b.tabId);
  for (const tab of tabs) {
    const site = tab.scope === 'site';
    rules.push({
      id: base + rules.length,
      priority: site ? PRIORITY_SITE_TAB : PRIORITY_TAB,
      action: setHeader(tab.value),
      condition: { tabIds: [tab.tabId], resourceTypes: site ? noDocument : all },
    });
  }
  for (const host of Object.keys(input.sites).sort()) {
    rules.push({
      id: base + rules.length,
      priority: PRIORITY_SITE_DOCUMENT,
      action: setHeader(input.sites[host]!),
      condition: {
        regexFilter: siteUrlRegex(host),
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      },
    });
  }
  return rules;
}

/** The headers of an extension-mode replay with the tab's override added, unless they set Accept-Language already. */
export function withAcceptLanguage<T extends { name: string; value: string }>(headers: readonly T[], value: string | null): Array<T | { name: string; value: string }> {
  if (!value || headers.some((h) => h.name.toLowerCase() === 'accept-language')) return headers.slice();
  return [...headers, { name: 'Accept-Language', value }];
}

/** Tab overrides from storage.session (tab id → value), invalid items dropped. */
export function tabLanguagesFromStorage(value: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const tabId = Number(key);
    const lang = normalizeLanguageValue(raw);
    if (Number.isSafeInteger(tabId) && tabId >= 0 && lang) out.set(tabId, lang);
  }
  return out;
}

export interface LanguageManagerDeps {
  dnr: Dnr;
  /** storage.session (tab overrides). */
  session: Pick<chrome.storage.StorageArea, 'get' | 'set'>;
  settings(): Settings;
  /** Re-read the stored settings (after the overlay wrote siteLanguages). */
  reloadSettings(): Promise<void>;
  /** Every tab with its URL (startup). */
  queryTabs(): Promise<Array<{ id?: number; url?: string; pendingUrl?: string }>>;
  /** Message every frame of a tab (errors ignored). */
  sendToTab(tabId: number, message: TabMessage): Promise<unknown>;
  /** chrome.declarativeNetRequest.ResourceType values. */
  resourceTypes(): readonly string[];
  /** Resolves once the replay rules of a previous worker were cleared (they share the session rule space). */
  rulesCleared(): Promise<void>;
}

/** Tab / site language state and its DNR rules. */
export class LanguageManager {
  private readonly tabLanguages = new Map<number, string>();
  /** Site key of every tab's top-level page (null: not an http(s) page). */
  private readonly tabHosts = new Map<number, string | null>();
  private sites: Record<string, string> = {};
  private loaded: Promise<void> | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private syncQueued = false;

  constructor(private readonly deps: LanguageManagerDeps) {}

  /**
   * Load the tab overrides and the tabs' hosts, then start rewriting the rules (not awaited: GET_TAB_STATE answers
   * must not wait for DNR). Idempotent; never rejects.
   */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const stored = await this.deps.session.get(TAB_LANGUAGES_KEY);
        for (const [tabId, value] of tabLanguagesFromStorage(stored[TAB_LANGUAGES_KEY])) {
          if (!this.tabLanguages.has(tabId)) this.tabLanguages.set(tabId, value);
        }
      } catch (err) {
        console.warn('[kineReqLens] could not read tab languages', err);
      }
      try {
        const live = new Set<number>();
        for (const tab of await this.deps.queryTabs()) {
          if (typeof tab.id !== 'number' || tab.id < 0) continue;
          live.add(tab.id);
          if (!this.tabHosts.has(tab.id)) this.tabHosts.set(tab.id, siteKeyOf(tab.url || tab.pendingUrl));
        }
        let pruned = false;
        for (const tabId of [...this.tabLanguages.keys()]) {
          if (!live.has(tabId)) {
            this.tabLanguages.delete(tabId);
            pruned = true;
          }
        }
        if (pruned) void this.persist();
      } catch {
        /* tabs unavailable: hosts are learned from navigations */
      }
      this.sites = sanitizeSiteLanguages(this.deps.settings().siteLanguages);
      void this.sync();
    })();
    return this.loaded;
  }

  /** The override that applies to `tabId` (its page at `url`, when the caller knows it better than the worker). */
  status(tabId: number, url?: string): LanguageStatus {
    const host = url !== undefined ? siteKeyOf(url) : (this.tabHosts.get(tabId) ?? null);
    return effectiveLanguage(this.tabLanguages.get(tabId) ?? null, this.sites, host);
  }

  /** The Accept-Language value that applies to `tabId`, or null. */
  valueFor(tabId: number): string | null {
    return this.status(tabId).effective;
  }

  /** Set (or clear) the tab's own override; rules are in place when it resolves. Invalid values clear it. */
  async setTab(tabId: number, value: string | null): Promise<LanguageStatus> {
    await this.load();
    const before = this.valueFor(tabId);
    const normalized = value === null ? null : normalizeLanguageValue(value);
    if (normalized) this.tabLanguages.set(tabId, normalized);
    else this.tabLanguages.delete(tabId);
    await Promise.all([this.persist(), this.sync()]);
    this.pushIfChanged(tabId, before);
    return this.status(tabId);
  }

  /** The tab's top-level page changed (tabs.onUpdated url, or a top frame's GET_TAB_STATE). */
  onTabUrl(tabId: number, url: string | undefined): void {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || url === undefined) return;
    const host = siteKeyOf(url);
    if (this.tabHosts.has(tabId) && this.tabHosts.get(tabId) === host) return;
    this.tabHosts.set(tabId, host);
    // Only a site override makes the host matter for the rules.
    if (!this.tabLanguages.has(tabId)) void this.sync();
  }

  /** Settings changed (storage.onChanged, after the SettingsCache took them): resync when siteLanguages did. */
  onSettingsChanged(): void {
    const next = sanitizeSiteLanguages(this.deps.settings().siteLanguages);
    if (siteLanguagesEqual(next, this.sites)) return;
    const before = new Map<number, string | null>();
    for (const tabId of this.tabHosts.keys()) before.set(tabId, this.valueFor(tabId));
    this.sites = next;
    void this.sync();
    for (const [tabId, value] of before) this.pushIfChanged(tabId, value);
  }

  /** Re-read the stored settings (the overlay just wrote them) and wait for the rules. */
  async refresh(tabId: number): Promise<LanguageStatus> {
    await this.load();
    await this.deps.reloadSettings();
    this.onSettingsChanged();
    await this.sync();
    return this.status(tabId);
  }

  /** chrome.tabs.onRemoved: drop the tab's override and rules. */
  async onTabRemoved(tabId: number): Promise<void> {
    await this.load();
    this.tabHosts.delete(tabId);
    const had = this.tabLanguages.delete(tabId);
    if (had) void this.persist();
    await this.sync();
  }

  /** chrome.tabs.onReplaced: the tab's content (and override) moved to a new tab id. */
  async onTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    await this.load();
    const value = this.tabLanguages.get(removedTabId);
    const host = this.tabHosts.get(removedTabId);
    this.tabLanguages.delete(removedTabId);
    this.tabHosts.delete(removedTabId);
    if (value) this.tabLanguages.set(addedTabId, value);
    if (host !== undefined && !this.tabHosts.has(addedTabId)) this.tabHosts.set(addedTabId, host);
    if (value) void this.persist();
    await this.sync();
  }

  /** The rules for the current state (exposed for tests). */
  rules(): DnrRule[] {
    const tabs: TabLanguageRule[] = [];
    const ids = new Set<number>([...this.tabLanguages.keys(), ...this.tabHosts.keys()]);
    for (const tabId of ids) {
      const status = this.status(tabId);
      if (status.effective && status.scope) tabs.push({ tabId, value: status.effective, scope: status.scope });
    }
    return buildLanguageRules({ tabs, sites: this.sites, resourceTypes: this.deps.resourceTypes() });
  }

  /** Rewrite the language rules (serialized; a burst of changes coalesces into one more run). */
  sync(): Promise<void> {
    if (this.syncQueued) return this.syncing;
    this.syncQueued = true;
    this.syncing = this.syncing.then(async () => {
      this.syncQueued = false;
      try {
        await this.deps.rulesCleared();
        const existing = await this.deps.dnr.getSessionRules();
        const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= LANGUAGE_RULE_ID_BASE);
        await this.deps.dnr.updateSessionRules({ removeRuleIds, addRules: this.rules() });
      } catch (err) {
        console.warn('[kineReqLens] could not update the language rules', err);
      }
    });
    return this.syncing;
  }

  private pushIfChanged(tabId: number, before: string | null): void {
    const value = this.valueFor(tabId);
    if (value === before) return;
    this.deps.sendToTab(tabId, { type: 'LANGUAGE', value }).catch(() => {
      // No content script (restricted page, loading): it asks with GET_TAB_STATE when it starts.
    });
  }

  private async persist(): Promise<void> {
    const value: Record<string, string> = {};
    for (const [tabId, lang] of this.tabLanguages) value[String(tabId)] = lang;
    try {
      await this.deps.session.set({ [TAB_LANGUAGES_KEY]: value });
    } catch (err) {
      console.warn('[kineReqLens] could not persist tab languages', err);
    }
  }
}

/** Whether a storage change touched the settings (the language manager then re-checks siteLanguages). */
export function isSettingsChange(changes: Record<string, unknown>, areaName: string): boolean {
  return areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY);
}
