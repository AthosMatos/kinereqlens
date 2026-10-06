// The control plane in the worker (src/background/claude/control/): argument validation, gating, routing between
// worker-side handlers and panel ops, the target tab, tab visibility, headless panels (mount, idle unmount, the user
// taking over) and the settings Claude may change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlane } from '../../src/background/claude/control/plane';
import type { BrowserTab, ControlBrowser, ControlDeps } from '../../src/background/claude/control/plane';
import { planSettingsPatch, settingVerdict, settingsView } from '../../src/background/claude/control/settings';
import { validateControl } from '../../src/background/claude/control/validate';
import { overlayVisibleIds } from '../../src/background/claude/control/listView';
import type { HandlerDeps } from '../../src/background/claude/handlers';
import { ParamError } from '../../src/background/claude/validate';
import { bridgeEntry, bridgeList } from '../../src/content/claude';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import { CONTROL_DISABLED, HEADLESS_IDLE_MS } from '../../src/shared/control-protocol';
import type { ControlParams, PanelControlOp } from '../../src/shared/control-protocol';
import type { LinkQuery } from '../../src/shared/claude-link';
import type { TabMessage } from '../../src/shared/messages';
import type { ListRule, RequestEntry, Settings, SettingsPatch, TabState } from '../../src/shared/types';
import { panelBridge, panelTabState } from '../../src/ui/frame/headless';

// ------------------------------------------------------------------------------------------------ fixtures

function entry(id: string, over: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.test/',
    method: 'GET',
    url: `https://api.test/items/${id}`,
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1,
    state: 'done',
    status: 200,
    ...over,
  };
}

interface HarnessOptions {
  settings?: Partial<Settings>;
  /** Tabs whose overlay is open. */
  open?: number[];
  hidden?: number[];
  /** Tabs with a connected panel link. */
  linked?: number[];
  tabs?: BrowserTab[];
  /** PING answers: content script present / UI mounted. */
  content?: Record<number, { hasUi: boolean } | null>;
  /** The panel connects when ui.js is injected. */
  mountConnects?: boolean;
  lastFocusedWindow?: number | null;
  windowState?: string;
}

function harness(opts: HarnessOptions = {}) {
  vi.useFakeTimers();
  let settings = mergeSettings(DEFAULT_SETTINGS, { claudeBridge: true, claudeAllowControl: true, ...(opts.settings ?? {}) } as SettingsPatch);
  const states = new Map<number, TabState>();
  for (const id of opts.open ?? []) states.set(id, { open: true, recording: true, preserveLog: false, ...(opts.hidden?.includes(id) ? { hidden: true } : {}) });
  const linked = new Set(opts.linked ?? []);
  const tabs: BrowserTab[] = opts.tabs ?? [
    { id: 1, windowId: 10, active: true, title: 'App', url: 'https://app.test/' },
    { id: 2, windowId: 10, active: false, title: 'Other', url: 'https://other.test/' },
  ];
  const content = new Map<number, { hasUi: boolean } | null>(Object.entries(opts.content ?? { 1: { hasUi: false }, 2: { hasUi: false } }).map(([k, v]) => [Number(k), v]));
  const sent: Array<{ tabId: number; message: TabMessage }> = [];
  const queries: Array<{ tabId: number; op: PanelControlOp; timeoutMs: number }> = [];
  const panelAnswers: Partial<Record<PanelControlOp['op'], unknown>> = {};
  const entries: Record<number, RequestEntry[]> = { 1: [entry('h:0:1'), entry('h:0:2', { method: 'POST', status: 500, state: 'done' })] };
  const browser: ControlBrowser = {
    getTab: vi.fn(async (tabId: number) => tabs.find((t) => t.id === tabId) ?? null),
    queryTabs: vi.fn(async () => tabs),
    getWindow: vi.fn(async (windowId: number) => ({ id: windowId, state: opts.windowState ?? 'normal', focused: true })),
    lastFocusedWindow: vi.fn(async () => (opts.lastFocusedWindow === undefined ? 10 : opts.lastFocusedWindow)),
    activate: vi.fn(async (tabId: number) => {
      for (const t of tabs) if (t.windowId === tabs.find((x) => x.id === tabId)!.windowId) t.active = t.id === tabId;
      opts.windowState = 'normal';
    }),
    reload: vi.fn(async () => undefined),
    injectUi: vi.fn(async (tabId: number) => {
      content.set(tabId, { hasUi: true });
      if (opts.mountConnects !== false) linked.add(tabId);
    }),
    injectContentScripts: vi.fn(async (tabId: number) => {
      content.set(tabId, { hasUi: false });
      return true;
    }),
    isRestrictedUrl: (url: string) => url.startsWith('edge://'),
  };
  const sendToTop = vi.fn(async (tabId: number, message: TabMessage) => {
    sent.push({ tabId, message });
    if (message.type === 'PING') {
      const answer = content.get(tabId);
      if (!answer) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true, hasUi: answer.hasUi };
    }
    if (message.type === 'UI_UNMOUNT') {
      linked.delete(tabId);
      content.set(tabId, { hasUi: false });
      return { ok: true, unmounted: true };
    }
    const list = entries[tabId] ?? [];
    if (message.type === 'BRIDGE_LIST') return bridgeList(list, 'https://app.test/', message.countOnly === true);
    if (message.type === 'BRIDGE_ENTRY') return bridgeEntry((id) => list.find((e) => e.id === id), message.id, 'https://app.test/');
    return undefined;
  });
  const links = {
    has: (tabId: number) => linked.has(tabId),
    tabIds: () => [...linked],
    waitFor: vi.fn(async (tabId: number) => linked.has(tabId)),
    query: vi.fn(async (tabId: number, query: LinkQuery, timeoutMs: number) => {
      if (query.kind !== 'control') throw new Error('unexpected query');
      queries.push({ tabId, op: query.op, timeoutMs });
      return panelAnswers[query.op.op] ?? { ok: true };
    }),
  };
  const tabStore = {
    get: (tabId: number) => states.get(tabId) ?? { open: false, recording: true, preserveLog: false },
    isOpen: (tabId: number) => states.get(tabId)?.open === true,
    isHidden: (tabId: number) => states.get(tabId)?.open === true && states.get(tabId)?.hidden === true,
    openTabIds: () => [...states].filter(([, s]) => s.open).map(([id]) => id),
  };
  const controller = {
    open: vi.fn(async (tabId: number, o: { hidden?: boolean }) => {
      const state: TabState = { open: true, recording: true, preserveLog: false, ...(o.hidden ? { hidden: true } : {}) };
      states.set(tabId, state);
      return { ok: true as const, state };
    }),
    setState: vi.fn(async (tabId: number, patch: Partial<TabState>) => {
      const next = { ...tabStore.get(tabId), ...patch };
      if (!next.open || !next.hidden) delete next.hidden;
      states.set(tabId, next);
      return next;
    }),
  };
  const written: SettingsPatch[] = [];
  const handlers = {
    settings: () => settings,
    tabs: tabStore,
    activity: { defaultTab: () => null, ordered: () => [] },
    links: { ...links, query: links.query as unknown as HandlerDeps['links']['query'] },
    sendToTop,
    tabInfo: async () => ({ title: '', url: '' }),
    extensionVersion: '0.2.0',
    browser: 'Edge',
  } as unknown as HandlerDeps;
  const deps: ControlDeps = {
    settings: () => settings,
    updateSettings: vi.fn(async (patch) => {
      written.push(patch as SettingsPatch);
      settings = mergeSettings(settings, patch as SettingsPatch);
      return settings;
    }),
    tabs: tabStore,
    controller,
    links,
    activity: { defaultTab: () => null, ordered: () => [] },
    sendToTop,
    browser,
    handlers,
    settleMs: 1,
  };
  const plane = new ControlPlane(deps);
  return {
    plane,
    deps,
    browser,
    controller,
    links,
    sent,
    queries,
    panelAnswers,
    written,
    states,
    linked,
    tabs,
    setSettings(patch: Partial<Settings>) {
      settings = mergeSettings(settings, patch as SettingsPatch);
    },
    run: (params: ControlParams) => plane.run(params),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------------ validation

describe('validateControl', () => {
  it('accepts a known tool + action and normalizes arguments; single-action tools need no action', () => {
    expect(validateControl({ tool: 'overlay', action: 'dock', tabId: 3, args: { dock: 'right' } })).toEqual({ tool: 'overlay', action: 'dock', tabId: 3, args: { dock: 'right' } });
    expect(validateControl({ tool: 'settings', args: { values: { theme: 'dark' } } })).toMatchObject({ action: 'set' });
    expect(validateControl({ tool: 'screenshot', args: { text: ' Save ', padding: 20 } })).toMatchObject({ action: 'capture', args: { text: ' Save ', padding: 20 } });
    expect(validateControl({ tool: 'setups', action: 'save', args: { name: '  Mine  ' } }).args.name).toBe('Mine');
  });

  it('rejects unknown tools, actions, arguments and malformed values with messages for Claude', () => {
    const bad = (params: unknown, message: RegExp) => {
      expect(() => validateControl(params)).toThrow(ParamError);
      expect(() => validateControl(params)).toThrow(message);
    };
    bad({ tool: 'nope', action: 'x' }, /unknown tool/);
    bad({ tool: 'overlay', action: 'explode' }, /action must be one of: open, close/);
    bad({ tool: 'overlay', action: 'open', args: { hidden: 'yes' } }, /hidden must be true or false/);
    bad({ tool: 'overlay', action: 'open', args: { colour: 1 } }, /unknown argument "colour" \(allowed: hidden\)/);
    bad({ tool: 'overlay', action: 'dock', args: {} }, /missing dock/);
    bad({ tool: 'overlay', action: 'open', tabId: -1 }, /tabId must be a tab id/);
    bad({ tool: 'overlay', action: 'open', extra: 1 }, /unknown parameter "extra"/);
    bad({ tool: 'requests', action: 'remove', args: { requestIds: Array.from({ length: 501 }, (_, i) => `id${i}`) } }, /too many items/);
    bad({ tool: 'inspect', action: 'ws_messages', args: { limit: 0 } }, /between 1 and 200/);
    bad({ tool: 'requests', action: 'new', args: { url: 'javascript:alert(1)' } }, /http or https/);
    bad({ tool: 'requests', action: 'new', args: { url: 'https://user:pw@x.test/' } }, /credentials/);
    bad({ tool: 'requests', action: 'new', args: { headers: [['Bad Name', 'v']] } }, /invalid header name/);
    bad({ tool: 'requests', action: 'new', args: { headers: [['X-A', 'a\r\nb']] } }, /invalid value/);
    bad({ tool: 'edit_request', args: { requestId: 'h:0:1' } }, /at least one change/);
    bad({ tool: 'edit_request', args: { requestId: 'h:0:1', revert: [{ param: 'a', header: 'b' }] } }, /exactly one of param, header, field, path/);
    bad({ tool: 'edit_request', args: { requestId: 'h:0:1', options: {} } }, /options is empty/);
    bad({ tool: 'list_config', action: 'add_rule', args: { mode: 'hide' } }, /exactly one of url/);
    bad({ tool: 'list_config', action: 'add_rule', args: { mode: 'hide', method: 'GET', exact: true } }, /exact is only used with url/);
    bad({ tool: 'settings', args: { values: {} } }, /must be an object of settings/);
  });

  it('screenshot / find_in_page locators: one at a time, path only with requestId, consistent targets', () => {
    expect(() => validateControl({ tool: 'screenshot', args: { selector: '#a', text: 'b' } })).toThrow(/only one of selector, text, value, requestId/);
    expect(() => validateControl({ tool: 'screenshot', args: { path: 'a.b' } })).toThrow(/path needs requestId/);
    expect(() => validateControl({ tool: 'screenshot', args: { target: 'element' } })).toThrow(/needs a locator/);
    expect(() => validateControl({ tool: 'screenshot', args: { target: 'region' } })).toThrow(/needs region/);
    expect(() => validateControl({ tool: 'screenshot', args: { region: { x: 0, y: 0, width: 5, height: 5 } } })).toThrow(/only used with target "region"/);
    expect(() => validateControl({ tool: 'screenshot', args: { target: 'full', selector: '#a' } })).toThrow(/drop the locator/);
    expect(() => validateControl({ tool: 'screenshot', args: { target: 'region', region: { x: 0, y: 0, width: 0, height: 5 } } })).toThrow(/between 1 and/);
    expect(() => validateControl({ tool: 'find_in_page', args: {} })).toThrow(/give one of selector, text, value, requestId/);
    expect(validateControl({ tool: 'find_in_page', args: { requestId: 'selected', path: 'a[0]', highlight: true } }).args).toEqual({ requestId: 'selected', path: 'a[0]', highlight: true });
    expect(validateControl({ tool: 'screenshot', args: { target: 'region', region: { x: 1, y: 2, width: 3, height: 4 }, padding: 0, open: true } }).args).toMatchObject({ padding: 0, open: true });
  });

  it('a JSON edit may set null', () => {
    const v = validateControl({ tool: 'edit_request', args: { requestId: 'x', json: [{ path: 'a', value: null }] } });
    expect(v.args.json).toEqual([{ path: 'a', value: null }]);
  });
});

// ------------------------------------------------------------------------------------------------ gating

describe('ControlPlane gating', () => {
  it('refuses every control call while "Let Claude control kineReqLens" (or the bridge) is off, and records it', async () => {
    const h = harness({ settings: { claudeAllowControl: false } });
    await expect(h.run({ tool: 'inspect', action: 'tabs' })).rejects.toThrow(CONTROL_DISABLED);
    expect(h.plane.traceItems()[0]).toMatchObject({ tool: 'inspect', action: 'tabs', ok: false });
    h.setSettings({ claudeAllowControl: true, claudeBridge: false });
    await expect(h.run({ tool: 'overlay', action: 'open' })).rejects.toThrow(/Let Claude control kineReqLens/);
    expect(h.controller.open).not.toHaveBeenCalled();
  });

  it('sends need "Allow Claude to send requests"; full-mode Errors actions need full mode', async () => {
    const h = harness({ linked: [1], open: [1] });
    await expect(h.run({ tool: 'requests', action: 'resend', args: { requestId: 'h:0:1' } })).rejects.toThrow(/Allow Claude to send requests/);
    await expect(h.run({ tool: 'requests', action: 'ws_send', args: { wsId: '0:w1', text: 'hi' } })).rejects.toThrow(/Allow Claude to send requests/);
    for (const action of ['fix', 'issue', 'commit', 'pull_request', 'discard']) {
      await expect(h.run({ tool: 'errors', action, args: { key: 'GET x' } })).rejects.toThrow(/full mode, which only the user can turn on/);
    }
    expect(h.queries).toHaveLength(0);
    // Safe-mode analysis is a control action like the others.
    h.panelAnswers.errors_analyze = { run: { id: 'run-1', kind: 'analyze', state: 'running', auto: false, startedAt: 1, analysis: null, log: [] } };
    await expect(h.run({ tool: 'errors', action: 'analyze', args: { key: 'GET x' } })).resolves.toMatchObject({ text: expect.stringContaining('read-only Claude analysis') });
  });
});

// ------------------------------------------------------------------------------------------------ routing

describe('ControlPlane routing', () => {
  it('worker-side actions never touch the panel; panel actions go over the link as control queries', async () => {
    const h = harness({ open: [1], linked: [1] });
    await h.run({ tool: 'list_config', action: 'group', args: { on: true } });
    await h.run({ tool: 'settings', args: { values: { theme: 'dark' } } });
    await h.run({ tool: 'overlay', action: 'minimize' });
    expect(h.queries).toHaveLength(0);
    expect(h.written).toEqual([{ listGroup: true }, { theme: 'dark' }, { layout: { minimized: true } }]);
    h.panelAnswers.select = { selected: 'h:0:2', method: 'POST', url: 'https://api.test/items/h:0:2' };
    const out = await h.run({ tool: 'overlay', action: 'select', args: { requestId: 'h:0:2' } });
    expect(out.text).toContain('Selected `h:0:2`');
    expect(h.queries).toEqual([{ tabId: 1, op: { op: 'select', entryId: 'h:0:2' }, timeoutMs: expect.any(Number) }]);
  });

  it('target tab: tabId, else the tab Claude was told to use, else the active tab of the last focused window', async () => {
    const h = harness({ open: [], linked: [1, 2] });
    await h.run({ tool: 'overlay', action: 'use_tab', tabId: 2 });
    h.panelAnswers.state = { view: 'http', selectedId: null, textFilter: '', removedIds: [], entryCount: 0, work: [], runningRuns: 0, terminalOpen: false };
    await h.run({ tool: 'list_config', action: 'text', args: { text: 'x' } });
    expect(h.queries.at(-1)?.tabId).toBe(2);
    await expect(h.plane.defaultTab()).resolves.toBe(2);
    h.tabs.splice(1, 1);
    await expect(h.plane.defaultTab()).resolves.toBeNull();
    await expect(h.plane.resolveTab(undefined)).resolves.toBe(1);
    await expect(h.plane.resolveTab(99)).rejects.toThrow(/There is no tab 99/);
  });

  it('record on a closed overlay opens it in the background; close / show / hide follow the tab state', async () => {
    const h = harness({ open: [] });
    const out = await h.run({ tool: 'requests', action: 'record', args: { on: true }, tabId: 1 });
    expect(out.text).toContain('open in the background');
    expect(h.controller.open).toHaveBeenCalledWith(1, { hidden: true });
    expect(h.states.get(1)).toMatchObject({ open: true, hidden: true });
    await h.run({ tool: 'overlay', action: 'show', tabId: 1 });
    expect(h.states.get(1)?.hidden).toBeUndefined();
    await h.run({ tool: 'overlay', action: 'hide', tabId: 1 });
    expect(h.states.get(1)).toMatchObject({ open: true, hidden: true });
    await h.run({ tool: 'overlay', action: 'close', tabId: 1 });
    expect(h.states.get(1)?.open).toBe(false);
  });

  it('full-mode dialogs open in the overlay, which is then shown (the user confirms there)', async () => {
    const h = harness({ open: [1], hidden: [1], linked: [1], settings: { errorsFullMode: true } });
    h.panelAnswers.errors_dialog = { opened: 'issue' };
    const out = await h.run({ tool: 'errors', action: 'issue', args: { key: 'GET https://api.test/x' } });
    expect(h.queries.at(-1)?.op).toEqual({ op: 'errors_dialog', key: 'GET https://api.test/x', dialog: 'issue' });
    expect(h.states.get(1)?.hidden).toBeUndefined();
    expect(out.text).toContain('nothing runs until the user confirms it there');
  });
});

// ------------------------------------------------------------------------------------------------ headless

describe('headless panels', () => {
  it('a closed overlay gets an invisible panel for the op; it is removed after the idle period', async () => {
    const h = harness({ open: [] });
    h.panelAnswers.new = { id: 'm:abc', method: 'GET', url: 'https://app.test/' };
    await h.run({ tool: 'requests', action: 'new', tabId: 1 });
    expect(h.browser.injectUi).toHaveBeenCalledWith(1);
    expect(h.plane.isHeadless(1)).toBe(true);
    // While the op runs and the panel is mounted, the worker treats the panel as an open overlay's.
    expect(h.plane.controlled(1)).toBe(true);
    expect(h.plane.controlled(2)).toBe(false);
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS - 1000);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sent.filter((s) => s.message.type === 'UI_UNMOUNT')).toEqual([{ tabId: 1, message: { type: 'UI_UNMOUNT' } }]);
    expect(h.plane.isHeadless(1)).toBe(false);
    expect(h.plane.controlled(1)).toBe(false);
  });

  it('every command restarts the idle timer; the user opening the overlay keeps the panel', async () => {
    const h = harness({ open: [] });
    h.panelAnswers.state = { view: 'http', selectedId: null, textFilter: '', removedIds: [], entryCount: 0, work: [], runningRuns: 0, terminalOpen: false };
    await h.run({ tool: 'list_config', action: 'text', args: { text: 'a' }, tabId: 1 });
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS - 1000);
    await h.run({ tool: 'list_config', action: 'text', args: { text: 'b' }, tabId: 1 });
    expect(h.browser.injectUi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS - 1000);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
    // The user opens the overlay: it shows this panel, which stays.
    h.states.set(1, { open: true, recording: true, preserveLog: false });
    h.plane.onTabOpened(1);
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS * 2);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
  });

  it('a panel with an Errors view Claude run (or a test request) in progress is not idle; it goes once that is done', async () => {
    const h = harness({ open: [] });
    const idleState = { view: 'errors', selectedId: null, textFilter: '', removedIds: [], entryCount: 0, work: [], runningRuns: 0, terminalOpen: false };
    h.panelAnswers.state = { ...idleState, claudeRuns: 1 };
    await h.run({ tool: 'overlay', action: 'view', args: { view: 'errors' }, tabId: 1 });
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS + 1000);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
    expect(h.plane.isHeadless(1)).toBe(true);
    expect(h.queries.at(-1)?.op).toEqual({ op: 'state' });
    h.panelAnswers.state = { ...idleState, runningRuns: 1 };
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS + 1000);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
    // Done: removed at the next idle check.
    h.panelAnswers.state = { ...idleState, claudeRuns: 0 };
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS + 1000);
    expect(h.sent.filter((s) => s.message.type === 'UI_UNMOUNT')).toHaveLength(1);
    expect(h.plane.isHeadless(1)).toBe(false);
  });

  it('a closed overlay that still has its panel is used as is and never unmounted', async () => {
    const h = harness({ open: [], linked: [1], content: { 1: { hasUi: true } } });
    h.panelAnswers.state = { view: 'http', selectedId: null, textFilter: '', removedIds: [], entryCount: 0, work: [], runningRuns: 0, terminalOpen: false };
    await h.run({ tool: 'list_config', action: 'text', args: { text: 'a' }, tabId: 1 });
    expect(h.browser.injectUi).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEADLESS_IDLE_MS * 2);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT')).toBe(false);
  });

  it('injects the content scripts first when the page has none; refuses restricted pages; reads never mount', async () => {
    const h = harness({ open: [], content: { 1: null } });
    h.panelAnswers.state = { view: 'http', selectedId: null, textFilter: '', removedIds: [], entryCount: 0, work: [], runningRuns: 0, terminalOpen: false };
    const out = await h.run({ tool: 'inspect', action: 'overlay', tabId: 1 });
    expect(out.text).toContain('Panel: not loaded');
    expect(h.browser.injectUi).not.toHaveBeenCalled();
    await h.run({ tool: 'list_config', action: 'text', args: { text: 'a' }, tabId: 1 });
    expect(h.browser.injectContentScripts).toHaveBeenCalledWith(1);
    expect(h.browser.injectUi).toHaveBeenCalledWith(1);
    const r = harness({ open: [], tabs: [{ id: 5, windowId: 1, active: true, title: 'Settings', url: 'edge://settings' }] });
    await expect(r.run({ tool: 'requests', action: 'clear', tabId: 5 })).rejects.toThrow(/cannot run on this page/);
  });

  it('a panel that does not connect is reported', async () => {
    const h = harness({ open: [], mountConnects: false });
    await expect(h.run({ tool: 'requests', action: 'clear', tabId: 1 })).rejects.toThrow(/did not connect/);
  });

  it('turning control off removes the headless panels', async () => {
    const h = harness({ open: [] });
    await h.run({ tool: 'requests', action: 'clear', tabId: 1 });
    h.plane.onDisabled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent.some((s) => s.message.type === 'UI_UNMOUNT' && s.tabId === 1)).toBe(true);
    expect(h.plane.isHeadless(1)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ visibility

describe('tab visibility (screenshots)', () => {
  it('a background tab is refused with the reason; activate brings it to the front first', async () => {
    const h = harness({ open: [1, 2], linked: [1, 2] });
    await expect(h.run({ tool: 'screenshot', tabId: 2, args: {} })).rejects.toThrow(/Tab 2 is not visible \(another tab is active in its window\).*activate: true/);
    expect(h.queries).toHaveLength(0);
    h.panelAnswers.screenshot = {
      result: { image: { mimeType: 'image/png', width: 10, height: 10 }, area: { x: 0, y: 0, width: 10, height: 10 }, padding: 0, path: '/tmp/x.png', bytes: 12 },
      preview: { data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 10, height: 10 },
    };
    const pending = h.run({ tool: 'screenshot', tabId: 2, activate: true, args: {} });
    await vi.advanceTimersByTimeAsync(10);
    const out = await pending;
    expect(h.browser.activate).toHaveBeenCalledWith(2);
    expect(out.images).toEqual([{ data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 10, height: 10 }]);
    expect(out.text).toContain('saved to /tmp/x.png');
  });

  it('a minimized window counts as not visible', async () => {
    const h = harness({ open: [1], linked: [1], windowState: 'minimized' });
    await expect(h.run({ tool: 'screenshot', tabId: 1, args: {} })).rejects.toThrow(/its window is minimized/);
  });

  it('screenshot with open shows the overlay afterwards', async () => {
    const h = harness({ open: [], linked: [] });
    h.panelAnswers.screenshot = {
      result: { image: { mimeType: 'image/png', width: 1, height: 1 }, area: { x: 0, y: 0, width: 1, height: 1 }, padding: 50 },
      preview: { data: 'AA==', mimeType: 'image/png', width: 1, height: 1 },
    };
    await h.run({ tool: 'screenshot', tabId: 1, args: { text: 'Save', open: true } });
    expect(h.queries[0]?.op).toEqual({ op: 'screenshot', args: { text: 'Save', open: true }, save: true });
    expect(h.controller.open).toHaveBeenCalledWith(1, { hidden: false });
  });
});

// ------------------------------------------------------------------------------------------------ settings

describe('settings Claude may change', () => {
  const current = mergeSettings(DEFAULT_SETTINGS, { maxEntries: 1000, captureResponseBodies: false });

  it('never the Claude Code / security settings', () => {
    for (const key of ['claudeBridge', 'claudeAllowSend', 'claudeShareSecrets', 'claudeAllowControl', 'errorsFullMode', 'autoAnalyzeErrors', 'rnEnabled', 'rnListenLan', 'rnPort', 'projectFolders', 'editorRoot', 'claudeRecentDirs']) {
      expect(settingVerdict(key), key).toBe('blocked');
      const plan = planSettingsPatch({ [key]: true }, current);
      expect(plan.ok, key).toBe(false);
    }
  });

  it('is atomic, sends list config to its own tools and only narrows what is captured', () => {
    expect(planSettingsPatch({ theme: 'dark', claudeAllowSend: true }, current)).toEqual({ ok: false, errors: [expect.stringContaining('claudeAllowSend: Claude cannot change it')] });
    expect(planSettingsPatch({ listRules: [] }, current)).toEqual({ ok: false, errors: [expect.stringContaining('list_config')] });
    expect(planSettingsPatch({ maxEntries: 2000 }, current).ok).toBe(false);
    expect(planSettingsPatch({ maxEntries: 500 }, current)).toEqual({ ok: true, patch: { maxEntries: 500 }, changed: ['maxEntries'] });
    expect(planSettingsPatch({ captureResponseBodies: true }, current).ok).toBe(false);
    expect(planSettingsPatch({ captureResponseBodies: false }, current).ok).toBe(true);
    expect(planSettingsPatch({ nonsense: 1 }, current)).toEqual({ ok: false, errors: ['nonsense: unknown setting (see inspect settings)'] });
    expect(planSettingsPatch({ layout: { dock: 'left', railExpanded: true } }, current)).toEqual({ ok: true, patch: { layout: { dock: 'left', railExpanded: true } }, changed: ['layout.dock', 'layout.railExpanded'] });
    expect(planSettingsPatch({ layout: 'default' }, current)).toMatchObject({ ok: true, patch: { layout: 'default' } });
    expect(planSettingsPatch({ layout: { colour: 1 } }, current).ok).toBe(false);
  });

  it('the settings view says what Claude may change', () => {
    const rows = settingsView(current);
    expect(rows.find((r) => r.key === 'claudeAllowControl')?.claude).toBe('no (user only)');
    expect(rows.find((r) => r.key === 'theme')?.claude).toBe('yes');
    expect(rows.find((r) => r.key === 'maxEntries')?.claude).toBe('lower only');
    expect(rows.find((r) => r.key === 'setups')?.claude).toContain('setups');
  });

  it('the settings tool refuses blocked keys end to end (nothing is written)', async () => {
    const h = harness();
    await expect(h.run({ tool: 'settings', args: { values: { claudeShareSecrets: true } } })).rejects.toThrow(/Nothing was changed/);
    expect(h.written).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ list view

describe('overlayVisibleIds', () => {
  const rows = bridgeList(
    [
      entry('a', { url: 'https://api.test/users/1' }),
      entry('b', { url: 'https://api.test/orders/1', method: 'POST' }),
      entry('c', { url: 'https://cdn.test/app.js', kind: 'script' }),
      entry('m', { url: 'https://api.test/mine', kind: 'manual', source: 'manual' }),
    ],
    '',
    false,
  ).rows;
  const rule = (over: Partial<ListRule>): ListRule => ({ id: 'r', mode: 'hide', pattern: '', exact: false, enabled: true, createdAt: 1, ...over });

  it('applies the type selection, the rules, the text filter and removed requests (manual requests stay)', () => {
    expect([...overlayVisibleIds(rows, { listTypes: ['fetch'], listRules: [] }, null)].sort()).toEqual(['a', 'b', 'm']);
    expect([...overlayVisibleIds(rows, { listTypes: [], listRules: [rule({ pattern: 'https://api.test/users/' })] }, null)].sort()).toEqual(['b', 'c', 'm']);
    expect([...overlayVisibleIds(rows, { listTypes: [], listRules: [rule({ mode: 'only', method: 'POST', exact: true })] }, null)].sort()).toEqual(['b', 'm']);
    expect([...overlayVisibleIds(rows, { listTypes: [], listRules: [] }, { textFilter: 'orders', removedIds: [] })].sort()).toEqual(['b']);
    expect([...overlayVisibleIds(rows, { listTypes: [], listRules: [] }, { textFilter: '', removedIds: ['a', 'c'] })].sort()).toEqual(['b', 'm']);
  });
});

// ------------------------------------------------------------------------------------------------ the panel's tab state

describe('panelTabState / panelBridge (overlay open in the background)', () => {
  it('reads as closed for the panel and the frame host, everything else unchanged', async () => {
    expect(panelTabState({ open: true, recording: true, preserveLog: true, hidden: true })).toEqual({ open: false, recording: true, preserveLog: true });
    expect(panelTabState({ open: true, recording: false, preserveLog: false })).toEqual({ open: true, recording: false, preserveLog: false });
    let state: TabState = { open: true, recording: true, preserveLog: false, hidden: true };
    const listeners = new Set<(s: TabState) => void>();
    const bridge = {
      version: '1',
      getTabState: () => state,
      subscribeTabState: (fn: (s: TabState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      setTabState: async (patch: Partial<TabState>) => (state = { ...state, ...patch }),
      getEntries: () => [],
    } as unknown as Parameters<typeof panelBridge>[0];
    const served = panelBridge(bridge);
    expect(served.getTabState().open).toBe(false);
    expect(served.getEntries()).toEqual([]);
    const seen: boolean[] = [];
    served.subscribeTabState((s) => seen.push(s.open));
    state = { open: true, recording: true, preserveLog: false };
    for (const fn of listeners) fn(state);
    expect(seen).toEqual([true]);
    await expect(served.setTabState({ hidden: true } as Partial<TabState>)).resolves.toMatchObject({ open: false });
  });
});
