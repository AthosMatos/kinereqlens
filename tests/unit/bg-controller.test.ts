import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Badge, BADGE_COLOR, RESTRICTED_TITLES } from '../../src/background/badge';
import { TabController } from '../../src/background/controller';
import type { ReplayRunner } from '../../src/background/replay';
import { TabStore } from '../../src/background/tabs';
import { WebRequestCollector } from '../../src/background/webrequest';
import type { WebRequestRegistration } from '../../src/background/wr-listeners';
import { preservedLogKey, tabStateKey } from '../../src/shared/constants';

const TAB = 21;

interface FakeOptions {
  url?: string;
  /** Content script answers PING in the top frame. */
  contentScript?: boolean;
  /** document.contentType of the top frame, or 'throw' when it cannot be scripted. */
  probe?: string;
  injectFails?: boolean;
}

/** Minimal chrome.* stand-in recording every call the controller makes. */
function fakeChrome(opts: FakeOptions = {}) {
  const session = new Map<string, unknown>();
  const sent: Array<{ tabId: number; message: unknown; frameId?: number }> = [];
  const injected: string[] = [];
  const texts: Record<string, string> = {};
  const titles: Record<string, string> = {};
  let contentScript = opts.contentScript ?? true;
  const chrome = {
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: opts.url ?? 'https://app.example.com/' })),
      query: vi.fn(async () => [{ id: TAB }]),
      sendMessage: vi.fn(async (tabId: number, message: { type: string }, options?: { frameId?: number }) => {
        sent.push({ tabId, message, frameId: options?.frameId });
        if (!contentScript) throw new Error('Could not establish connection. Receiving end does not exist.');
        return message.type === 'PING' ? { ok: true, hasUi: false } : undefined;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (injection: { files?: string[]; world?: string; func?: () => unknown }) => {
        if (injection.func) {
          if (opts.probe === 'throw') throw new Error('Cannot access contents of url "edge://settings/"');
          return [{ result: opts.probe ?? 'text/html' }];
        }
        if (opts.injectFails) throw new Error('Cannot access contents of the page');
        injected.push(`${injection.files?.join(',')}@${injection.world ?? 'ISOLATED'}`);
        if (injection.files?.includes('content.js')) contentScript = true;
        return [];
      }),
    },
    storage: {
      session: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => session.has(k)).map((k) => [k, session.get(k)]))),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) session.delete(k);
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(async ({ tabId, text }: { tabId: number; text: string }) => {
        texts[tabId] = text;
      }),
      setTitle: vi.fn(async ({ tabId, title }: { tabId: number; title: string }) => {
        titles[tabId] = title;
      }),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeTextColor: vi.fn(async () => undefined),
    },
    runtime: { getManifest: () => ({ action: { default_title: 'Toggle kineReqLens overlay (Alt+Shift+L)' } }) },
  };
  return { chrome, session, sent, injected, texts, titles };
}

async function setup(opts: FakeOptions = {}) {
  const fake = fakeChrome(opts);
  vi.stubGlobal('chrome', fake.chrome);
  const tabs = new TabStore();
  const ready = tabs.load();
  await ready;
  const collector = new WebRequestCollector({
    shouldCreate: (tabId) => tabs.isRecording(tabId),
    shouldTrack: (tabId) => tabs.isOpen(tabId),
    bodyCap: () => 1024,
    send: async () => undefined,
  });
  const badge = new Badge();
  const replays = { abortTab: vi.fn() };
  let active = false;
  const webRequest: WebRequestRegistration = {
    get active() {
      return active;
    },
    setActive: (next: boolean) => {
      active = next;
    },
  };
  const controller = new TabController({ ready, tabs, collector, badge, replays: replays as unknown as ReplayRunner, webRequest });
  const tabStates = () => fake.sent.filter((s) => (s.message as { type: string }).type === 'TAB_STATE');
  return { ...fake, tabs, collector, badge, controller, replays, webRequest, tabStates };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TabController.toggle', () => {
  it('opens the overlay (recording), persists and broadcasts the state', async () => {
    const t = await setup();
    await t.controller.toggle({ id: TAB, url: 'https://app.example.com/' } as chrome.tabs.Tab);
    const expected = { open: true, recording: true, preserveLog: false };
    expect(t.tabs.get(TAB)).toEqual(expected);
    expect(t.session.get(tabStateKey(TAB))).toEqual(expected);
    expect(t.tabStates()).toEqual([{ tabId: TAB, message: { type: 'TAB_STATE', tabState: expected }, frameId: undefined }]);
    expect(t.injected).toEqual([]);
    expect(t.webRequest.active).toBe(true);
  });

  it('closes it on the next toggle, clearing badge and buffered capture', async () => {
    const t = await setup();
    await t.controller.toggle(TAB);
    const dropTab = vi.spyOn(t.collector, 'dropTab');
    await t.controller.toggle(TAB);
    expect(t.tabs.get(TAB).open).toBe(false);
    expect(t.tabStates().at(-1)?.message).toEqual({ type: 'TAB_STATE', tabState: { open: false, recording: true, preserveLog: false } });
    expect(t.texts[TAB]).toBe('');
    expect(dropTab).toHaveBeenCalledWith(TAB);
    expect(t.webRequest.active).toBe(false);
  });

  it('applies rapid toggles in order', async () => {
    const t = await setup();
    await Promise.all([t.controller.toggle(TAB), t.controller.toggle(TAB), t.controller.toggle(TAB)]);
    expect(t.tabStates().map((s) => (s.message as { tabState: { open: boolean } }).tabState.open)).toEqual([true, false, true]);
  });

  it('injects hook.js (MAIN) and content.js when no content script answers, then resends the state', async () => {
    const t = await setup({ contentScript: false });
    await t.controller.toggle(TAB);
    expect(t.injected).toEqual(['hook.js@MAIN', 'content.js@ISOLATED']);
    expect(t.tabStates()).toHaveLength(2);
    expect(t.tabs.get(TAB).open).toBe(true);
  });

  it('marks restricted URLs without touching the tab', async () => {
    const t = await setup();
    await t.controller.toggle({ id: TAB, url: 'edge://settings/' } as chrome.tabs.Tab);
    expect(t.texts[TAB]).toBe('×');
    expect(t.titles[TAB]).toBe(RESTRICTED_TITLES.restricted);
    expect(t.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(t.tabs.get(TAB).open).toBe(false);
  });

  it('marks pages that cannot be scripted and the PDF viewer', async () => {
    const blocked = await setup({ probe: 'throw' });
    await blocked.controller.toggle({ id: TAB } as chrome.tabs.Tab); // no url: not visible without host access
    expect(blocked.texts[TAB]).toBe('×');
    expect(blocked.tabs.get(TAB).open).toBe(false);
    vi.unstubAllGlobals();

    const pdf = await setup({ probe: 'application/pdf' });
    await pdf.controller.toggle(TAB);
    expect(pdf.titles[TAB]).toBe(RESTRICTED_TITLES.pdf);
    expect(pdf.tabs.get(TAB).open).toBe(false);
  });

  it('closes again and marks the tab when content scripts cannot be injected', async () => {
    const t = await setup({ contentScript: false, injectFails: true });
    await t.controller.toggle(TAB);
    expect(t.tabs.get(TAB).open).toBe(false);
    expect(t.texts[TAB]).toBe('×');
  });

  it('clears a previous restricted mark once the page can run kineReqLens', async () => {
    const t = await setup();
    t.badge.markRestricted(TAB, 'restricted');
    await t.controller.toggle(TAB);
    expect(t.texts[TAB]).toBe('');
    expect(t.titles[TAB]).toBe('Toggle kineReqLens overlay (Alt+Shift+L)');
  });

  it('ignores invalid tab ids', async () => {
    const t = await setup();
    await t.controller.toggle({ id: undefined } as chrome.tabs.Tab);
    await t.controller.toggle(-1);
    expect(t.chrome.tabs.get).not.toHaveBeenCalled();
  });
});

describe('TabController.open (Claude Code control plane)', () => {
  it('opens in the background: capturing, hidden; the toolbar shows it, then closes it', async () => {
    const t = await setup();
    const opened = await t.controller.open(TAB, { hidden: true });
    expect(opened).toEqual({ ok: true, state: { open: true, recording: true, preserveLog: false, hidden: true } });
    expect(t.tabs.isRecording(TAB)).toBe(true);
    expect(t.tabs.isHidden(TAB)).toBe(true);
    expect(t.tabStates().at(-1)?.message).toEqual({ type: 'TAB_STATE', tabState: { open: true, recording: true, preserveLog: false, hidden: true } });
    // The toolbar button reveals a hidden overlay instead of closing it…
    await t.controller.toggle(TAB);
    expect(t.tabs.get(TAB)).toEqual({ open: true, recording: true, preserveLog: false });
    // …and closes it the next time.
    await t.controller.toggle(TAB);
    expect(t.tabs.get(TAB).open).toBe(false);
  });

  it('an open overlay only changes its hidden flag; closing clears it; restricted pages are refused', async () => {
    const t = await setup();
    await t.controller.toggle(TAB);
    await expect(t.controller.open(TAB, { hidden: true })).resolves.toMatchObject({ ok: true, state: { open: true, hidden: true } });
    await t.controller.setState(TAB, { open: false });
    expect(t.tabs.get(TAB)).toEqual({ open: false, recording: true, preserveLog: false });
    const r = await setup({ url: 'edge://settings/' });
    await expect(r.controller.open(TAB, {})).resolves.toEqual({ ok: false, reason: 'restricted' });
    const pdf = await setup({ probe: 'application/pdf' });
    await expect(pdf.controller.open(TAB, { hidden: true })).resolves.toEqual({ ok: false, reason: 'pdf' });
  });
});

describe('tab state: the hidden flag', () => {
  it('content scripts cannot set it; storage keeps it only while open', async () => {
    const { sanitizeTabStatePatch, tabStateFromStorage } = await import('../../src/background/tabs');
    expect(sanitizeTabStatePatch({ open: true, hidden: true })).toEqual({ open: true });
    expect(tabStateFromStorage({ open: true, recording: true, preserveLog: false, hidden: true })).toEqual({ open: true, recording: true, preserveLog: false, hidden: true });
    expect(tabStateFromStorage({ open: false, recording: true, preserveLog: false, hidden: true })).toEqual({ open: false, recording: true, preserveLog: false });
  });
});

describe('TabController tab lifecycle', () => {
  it('forgets a removed tab: state, preserved log, runs and listeners', async () => {
    const t = await setup();
    await t.controller.toggle(TAB);
    t.session.set(preservedLogKey(TAB), []);
    await t.controller.onTabRemoved(TAB);
    expect(t.session.has(tabStateKey(TAB))).toBe(false);
    expect(t.session.has(preservedLogKey(TAB))).toBe(false);
    expect(t.replays.abortTab).toHaveBeenCalledWith(TAB);
    expect(t.webRequest.active).toBe(false);
  });

  it('carries the state over to a replacing tab', async () => {
    const t = await setup();
    await t.controller.toggle(TAB);
    await t.controller.onTabReplaced(TAB + 1, TAB);
    expect(t.tabs.isOpen(TAB + 1)).toBe(true);
    expect(t.tabs.isOpen(TAB)).toBe(false);
  });

  it('reloads persisted state of live tabs after a worker restart', async () => {
    const t = await setup();
    await t.controller.toggle(TAB);
    const restarted = new TabStore();
    await restarted.load();
    expect(restarted.isRecording(TAB)).toBe(true);
    expect(t.chrome.storage.session.get).toHaveBeenLastCalledWith([tabStateKey(TAB)]);
  });
});

describe('Badge', () => {
  it('uses the accent color and formats counts', async () => {
    const t = await setup();
    t.badge.init();
    expect(t.chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: BADGE_COLOR });
    expect(BADGE_COLOR).toBe('#0230bb');
    t.badge.setCount(TAB, 1500);
    expect(t.texts[TAB]).toBe('999+');
    t.badge.clear(TAB);
    expect(t.texts[TAB]).toBe('');
  });
});
