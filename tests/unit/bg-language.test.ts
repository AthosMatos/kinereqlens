import { describe, expect, it, vi } from 'vitest';
import type { Badge } from '../../src/background/badge';
import type { TabController } from '../../src/background/controller';
import {
  FALLBACK_RESOURCE_TYPES,
  LanguageManager,
  PRIORITY_SITE_DOCUMENT,
  PRIORITY_SITE_TAB,
  PRIORITY_TAB,
  buildLanguageRules,
  isSettingsChange,
  siteUrlRegex,
  tabLanguagesFromStorage,
  withAcceptLanguage,
} from '../../src/background/language';
import type { LanguageManagerDeps } from '../../src/background/language';
import { DnrManager } from '../../src/background/dnr';
import type { ReplayRunner } from '../../src/background/replay';
import { createMessageRouter } from '../../src/background/router';
import type { RouterDeps } from '../../src/background/router';
import type { TabStore } from '../../src/background/tabs';
import type { WebRequestCollector } from '../../src/background/webrequest';
import { DEFAULT_SETTINGS, LANGUAGE_RULE_ID_BASE, SETTINGS_KEY, TAB_LANGUAGES_KEY, mergeSettings } from '../../src/shared/constants';
import type { TabMessage } from '../../src/shared/messages';
import type { ReplayRequest, Settings } from '../../src/shared/types';

type Rule = chrome.declarativeNetRequest.Rule;
const TYPES = [...FALLBACK_RESOURCE_TYPES];

describe('siteUrlRegex (host matching)', () => {
  const matches = (host: string, url: string) => new RegExp(siteUrlRegex(host), 'i').test(url);
  it('matches http(s) URLs of exactly that host, any port', () => {
    expect(matches('example.com', 'https://example.com/')).toBe(true);
    expect(matches('example.com', 'http://example.com:8080/a?b')).toBe(true);
    expect(matches('example.com', 'https://example.com?x')).toBe(true);
    expect(matches('example.com', 'https://example.com')).toBe(true);
    expect(matches('127.0.0.1', 'http://127.0.0.1:5173/app')).toBe(true);
  });
  it('does not match subdomains, look-alikes, other schemes or the host in a path', () => {
    expect(matches('example.com', 'https://www.example.com/')).toBe(false);
    expect(matches('example.com', 'https://example.com.evil.test/')).toBe(false);
    expect(matches('example.com', 'https://exampleXcom/')).toBe(false);
    expect(matches('example.com', 'https://evil.test/https://example.com/')).toBe(false);
    expect(matches('example.com', 'ftp://example.com/')).toBe(false);
    expect(matches('example.com', 'https://example.com@evil.test/')).toBe(false);
  });
});

describe('buildLanguageRules', () => {
  it('builds tab, per-tab site and site document rules with unique ids from the base', () => {
    const rules = buildLanguageRules({
      tabs: [
        { tabId: 7, value: 'de', scope: 'site' },
        { tabId: 3, value: 'pt-BR,en;q=0.8', scope: 'tab' },
      ],
      sites: { 'b.test': 'de', 'a.test': 'fr' },
      resourceTypes: TYPES,
    });
    expect(rules.map((r) => r.id)).toEqual([0, 1, 2, 3].map((i) => LANGUAGE_RULE_ID_BASE + i));
    const [tab, siteTab, siteA, siteB] = rules as [Rule, Rule, Rule, Rule];
    expect(tab).toEqual({
      id: LANGUAGE_RULE_ID_BASE,
      priority: PRIORITY_TAB,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'accept-language', operation: 'set', value: 'pt-BR,en;q=0.8' }] },
      condition: { tabIds: [3], resourceTypes: TYPES },
    });
    expect(siteTab.priority).toBe(PRIORITY_SITE_TAB);
    expect(siteTab.condition.tabIds).toEqual([7]);
    expect(siteTab.condition.resourceTypes).not.toContain('main_frame');
    expect(siteTab.condition.resourceTypes).toHaveLength(TYPES.length - 1);
    expect(siteA.condition).toEqual({ regexFilter: siteUrlRegex('a.test'), isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] });
    expect(siteA.priority).toBe(PRIORITY_SITE_DOCUMENT);
    expect(siteA.action.requestHeaders?.[0]?.value).toBe('fr');
    expect(siteB.condition.regexFilter).toBe(siteUrlRegex('b.test'));
    // Tab rules never match the worker's own (tab-less) requests: no rule without tabIds except the document rules.
    for (const rule of rules) expect(rule.condition.tabIds === undefined ? rule.condition.resourceTypes : ['ok']).not.toContain('xmlhttprequest');
  });

  it('is empty without overrides', () => {
    expect(buildLanguageRules({ tabs: [], sites: {}, resourceTypes: TYPES })).toEqual([]);
  });
});

describe('helpers', () => {
  it('adds Accept-Language to extension replays unless set', () => {
    expect(withAcceptLanguage([{ name: 'X', value: '1' }], 'pt-BR')).toEqual([
      { name: 'X', value: '1' },
      { name: 'Accept-Language', value: 'pt-BR' },
    ]);
    expect(withAcceptLanguage([{ name: 'accept-language', value: 'fr' }], 'pt-BR')).toEqual([{ name: 'accept-language', value: 'fr' }]);
    expect(withAcceptLanguage([{ name: 'X', value: '1' }], null)).toEqual([{ name: 'X', value: '1' }]);
  });

  it('reads tab overrides from storage', () => {
    expect([...tabLanguagesFromStorage({ '3': 'pt-br', x: 'de', '-1': 'de', '4': 'nope!', '5': 5 })]).toEqual([[3, 'pt-BR']]);
    expect(tabLanguagesFromStorage(null).size).toBe(0);
  });

  it('recognizes settings changes', () => {
    expect(isSettingsChange({ [SETTINGS_KEY]: {} }, 'local')).toBe(true);
    expect(isSettingsChange({ [SETTINGS_KEY]: {} }, 'session')).toBe(false);
    expect(isSettingsChange({ other: {} }, 'local')).toBe(false);
  });
});

/** In-memory DNR session rules + storage.session + tabs for the manager. */
function harness(opts: { tabs?: Array<{ id: number; url?: string }>; stored?: unknown; sites?: Record<string, string> } = {}) {
  let rules: Rule[] = [{ id: 5, priority: 1, action: { type: 'block' } as chrome.declarativeNetRequest.RuleAction, condition: {} }];
  let session: Record<string, unknown> = opts.stored === undefined ? {} : { [TAB_LANGUAGES_KEY]: opts.stored };
  let settings: Settings = mergeSettings(DEFAULT_SETTINGS, { siteLanguages: opts.sites ?? {} });
  let storedSettings: Settings = settings;
  const sent: Array<[number, TabMessage]> = [];
  const updates: number[] = [];
  const deps: LanguageManagerDeps = {
    dnr: {
      getSessionRules: async () => rules.slice(),
      updateSessionRules: async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
        updates.push(1);
        const remove = new Set(options.removeRuleIds ?? []);
        const next = rules.filter((r) => !remove.has(r.id));
        for (const r of options.addRules ?? []) {
          if (next.some((x) => x.id === r.id)) throw new Error(`duplicate id ${r.id}`);
          next.push(r);
        }
        rules = next;
      },
    } as unknown as LanguageManagerDeps['dnr'],
    session: {
      get: async (key: unknown) => ({ [String(key)]: session[String(key)] }),
      set: async (items: Record<string, unknown>) => {
        session = { ...session, ...items };
      },
    } as unknown as LanguageManagerDeps['session'],
    settings: () => settings,
    reloadSettings: async () => {
      settings = storedSettings;
    },
    queryTabs: async () => opts.tabs ?? [],
    sendToTab: async (tabId, message) => {
      sent.push([tabId, message]);
    },
    resourceTypes: () => TYPES,
    rulesCleared: async () => undefined,
  };
  const manager = new LanguageManager(deps);
  return {
    manager,
    sent,
    updates,
    rules: () => rules,
    langRules: () => rules.filter((r) => r.id >= LANGUAGE_RULE_ID_BASE),
    session: () => session[TAB_LANGUAGES_KEY],
    setSites(sites: Record<string, string>) {
      settings = mergeSettings(settings, { siteLanguages: sites });
    },
    storeSites(sites: Record<string, string>) {
      storedSettings = mergeSettings(settings, { siteLanguages: sites });
    },
  };
}

describe('LanguageManager', () => {
  it('sets / clears a tab override: rules, storage, pushes; other rules untouched', async () => {
    const h = harness({ tabs: [{ id: 1, url: 'https://a.test/' }, { id: 2, url: 'https://b.test/' }] });
    await h.manager.load();
    expect(h.langRules()).toEqual([]);
    const status = await h.manager.setTab(1, 'pt-br');
    expect(status).toMatchObject({ tab: 'pt-BR', effective: 'pt-BR', scope: 'tab', host: 'a.test' });
    expect(h.langRules()).toHaveLength(1);
    expect(h.langRules()[0]!.condition.tabIds).toEqual([1]);
    expect(h.rules().some((r) => r.id === 5)).toBe(true);
    expect(h.session()).toEqual({ '1': 'pt-BR' });
    expect(h.sent).toEqual([[1, { type: 'LANGUAGE', value: 'pt-BR' }]]);
    expect(h.manager.valueFor(2)).toBeNull();

    await h.manager.setTab(1, null);
    expect(h.langRules()).toEqual([]);
    expect(h.session()).toEqual({});
    expect(h.sent.at(-1)).toEqual([1, { type: 'LANGUAGE', value: null }]);
    // An invalid value clears too.
    await h.manager.setTab(2, 'nope!');
    expect(h.manager.valueFor(2)).toBeNull();
  });

  it('follows the tab host for site overrides and pushes when settings change', async () => {
    const h = harness({ tabs: [{ id: 1, url: 'https://a.test/x' }, { id: 2, url: 'https://b.test/' }], sites: { 'a.test': 'de' } });
    await h.manager.load();
    await h.manager.sync(); // load() starts the rewrite without waiting for it
    expect(h.manager.status(1)).toMatchObject({ site: 'de', effective: 'de', scope: 'site' });
    // Per-tab rule (no main_frame) for tab 1 + the site's document rule.
    expect(h.langRules().map((r) => r.condition.tabIds ?? r.condition.regexFilter)).toEqual([[1], siteUrlRegex('a.test')]);

    h.manager.onTabUrl(2, 'https://a.test/other');
    await h.manager.sync();
    expect(h.langRules().map((r) => r.condition.tabIds ?? 'doc')).toEqual([[1], [2], 'doc']);
    h.manager.onTabUrl(1, 'https://c.test/');
    await h.manager.sync();
    expect(h.langRules().map((r) => r.condition.tabIds ?? 'doc')).toEqual([[2], 'doc']);

    h.setSites({ 'a.test': 'fr', 'c.test': 'ja' });
    h.manager.onSettingsChanged();
    await h.manager.sync();
    expect(h.sent).toEqual(
      expect.arrayContaining([
        [1, { type: 'LANGUAGE', value: 'ja' }],
        [2, { type: 'LANGUAGE', value: 'fr' }],
      ]),
    );
    expect(h.langRules()).toHaveLength(4);
    // No change → no push, no rewrite.
    const pushes = h.sent.length;
    const writes = h.updates.length;
    h.manager.onSettingsChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sent.length).toBe(pushes);
    expect(h.updates.length).toBe(writes);
  });

  it('lets a tab override win over the site and re-reads settings on refresh', async () => {
    const h = harness({ tabs: [{ id: 1, url: 'https://a.test/' }] });
    await h.manager.load();
    await h.manager.setTab(1, 'pt-BR');
    h.storeSites({ 'a.test': 'de' });
    const status = await h.manager.refresh(1);
    expect(status).toMatchObject({ tab: 'pt-BR', site: 'de', effective: 'pt-BR', scope: 'tab' });
    const tabRule = h.langRules().find((r) => r.condition.tabIds?.[0] === 1)!;
    expect(tabRule.priority).toBe(PRIORITY_TAB);
    expect(tabRule.condition.resourceTypes).toContain('main_frame');
    expect(h.sent.filter(([, m]) => m.type === 'LANGUAGE')).toHaveLength(1);
    await h.manager.setTab(1, null);
    expect(h.manager.status(1)).toMatchObject({ effective: 'de', scope: 'site' });
    expect(h.sent.at(-1)).toEqual([1, { type: 'LANGUAGE', value: 'de' }]);
  });

  it('restores stored tab overrides of live tabs on load and cleans up closed / replaced tabs', async () => {
    const h = harness({ tabs: [{ id: 1, url: 'https://a.test/' }, { id: 2 }], stored: { '1': 'pt-BR', '2': 'es-419', '9': 'de' } });
    await h.manager.load();
    await h.manager.sync();
    expect(h.manager.valueFor(1)).toBe('pt-BR');
    expect(h.manager.valueFor(9)).toBeNull();
    expect(h.langRules().map((r) => r.condition.tabIds)).toEqual([[1], [2]]);
    await h.manager.onTabReplaced(3, 2);
    expect(h.manager.valueFor(3)).toBe('es-419');
    expect(h.manager.valueFor(2)).toBeNull();
    await h.manager.onTabRemoved(1);
    expect(h.langRules().map((r) => r.condition.tabIds)).toEqual([[3]]);
    expect(h.session()).toEqual({ '3': 'es-419' });
  });
});

describe('DnrManager keeps the language rules', () => {
  it('clears only replay rules at startup', async () => {
    let rules = [{ id: 3 }, { id: LANGUAGE_RULE_ID_BASE }, { id: LANGUAGE_RULE_ID_BASE + 4 }] as Rule[];
    const removed: number[][] = [];
    const api = {
      getSessionRules: async () => rules,
      updateSessionRules: async (o: chrome.declarativeNetRequest.UpdateRuleOptions) => {
        removed.push(o.removeRuleIds ?? []);
        rules = rules.filter((r) => !(o.removeRuleIds ?? []).includes(r.id));
      },
    } as unknown as typeof chrome.declarativeNetRequest;
    await new DnrManager('ext', api).clearAll();
    expect(removed).toEqual([[3]]);
    expect(rules.map((r) => r.id)).toEqual([LANGUAGE_RULE_ID_BASE, LANGUAGE_RULE_ID_BASE + 4]);
  });
});

describe('router', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop';
  const panelSender = { id: EXT, tab: { id: 4 } as chrome.tabs.Tab, frameId: 9, url: `chrome-extension://${EXT}/panel.html#nonce` };
  const pageSender = { id: EXT, tab: { id: 4 } as chrome.tabs.Tab, frameId: 0, documentId: 'd', url: 'https://a.test/page' };

  function setup() {
    const language = {
      load: vi.fn(async () => undefined),
      status: vi.fn((tabId: number, url?: string) => ({ tab: null, site: url ? 'de' : null, host: 'a.test', effective: url ? 'de' : null, scope: url ? ('site' as const) : null })),
      valueFor: vi.fn((_tabId: number) => 'pt-BR'),
      setTab: vi.fn(async (_tabId: number, value: string | null) => ({ tab: value, site: null, host: 'a.test', effective: value, scope: value ? ('tab' as const) : null })),
      refresh: vi.fn(async () => ({ tab: null, site: 'de', host: 'a.test', effective: 'de', scope: 'site' as const })),
      onTabUrl: vi.fn(),
    };
    const run = vi.fn(async (_tabId: number, req: ReplayRequest) => ({ runId: req.runId, ok: true, req }));
    const deps: RouterDeps = {
      extensionId: EXT,
      ready: Promise.resolve(),
      tabs: { get: () => ({ open: true, recording: true, preserveLog: false }), isOpen: () => true, isLoaded: true } as unknown as TabStore,
      collector: { attachDocument: () => [], getEntries: () => [] } as unknown as WebRequestCollector,
      badge: { clearRestricted: () => undefined } as unknown as Badge,
      replays: { run } as unknown as ReplayRunner,
      controller: {} as unknown as TabController,
      preserve: { read: async () => [], write: async () => true, clear: async () => true },
      language,
      sendToFrame: async () => undefined,
    };
    const listener = createMessageRouter(deps);
    const send = (message: unknown, from: chrome.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => {
        if (!listener(message, from, resolve)) resolve(undefined);
      });
    return { send, language, run };
  }

  it('serves LANGUAGE_* to the panel page only', async () => {
    const r = setup();
    expect(await r.send({ type: 'LANGUAGE_SET_TAB', value: 'pt-BR' }, panelSender)).toMatchObject({ tab: 'pt-BR' });
    expect(r.language.setTab).toHaveBeenCalledWith(4, 'pt-BR');
    expect(await r.send({ type: 'LANGUAGE_STATE', refresh: true }, panelSender)).toMatchObject({ effective: 'de' });
    expect(r.language.refresh).toHaveBeenCalledWith(4);
    // A content script (the page could drive it) gets nothing changed.
    expect(await r.send({ type: 'LANGUAGE_SET_TAB', value: 'de' }, pageSender)).toMatchObject({ effective: null });
    expect(r.language.setTab).toHaveBeenCalledTimes(1);
    // Malformed value: status only.
    await r.send({ type: 'LANGUAGE_SET_TAB', value: 42 }, panelSender);
    expect(r.language.setTab).toHaveBeenCalledTimes(1);
  });

  it('answers GET_TAB_STATE with the language (top frame tells the page URL)', async () => {
    const r = setup();
    expect(await r.send({ type: 'GET_TAB_STATE' }, pageSender)).toMatchObject({ language: 'de' });
    expect(r.language.onTabUrl).toHaveBeenCalledWith(4, 'https://a.test/page');
    expect(await r.send({ type: 'GET_TAB_STATE' }, { ...pageSender, frameId: 3 })).toMatchObject({ language: 'pt-BR' });
  });

  it('adds the tab language to extension-mode replays only', async () => {
    const r = setup();
    const req: ReplayRequest = {
      runId: 'r1',
      entryId: 'e',
      mode: 'extension',
      frameId: 0,
      method: 'GET',
      url: 'https://api.test/x',
      headers: [{ name: 'X-A', value: '1' }],
      body: { kind: 'none' },
      credentials: 'include',
      redirect: 'follow',
      timeoutMs: 1000,
      responseBodyCap: 1000,
    };
    await r.send({ type: 'REPLAY', req }, pageSender);
    expect(r.run.mock.calls[0]![1].headers).toEqual([
      { name: 'X-A', value: '1' },
      { name: 'Accept-Language', value: 'pt-BR' },
    ]);
    await r.send({ type: 'REPLAY', req: { ...req, runId: 'r2', headers: [{ name: 'Accept-Language', value: 'fr' }] } }, pageSender);
    expect(r.run.mock.calls[1]![1].headers).toEqual([{ name: 'Accept-Language', value: 'fr' }]);
    await r.send({ type: 'REPLAY', req: { ...req, runId: 'r3', mode: 'page' } }, pageSender);
    expect(r.run.mock.calls[2]![1].headers).toEqual([{ name: 'X-A', value: '1' }]);
  });
});
