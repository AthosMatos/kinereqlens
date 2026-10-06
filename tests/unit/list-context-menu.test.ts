// Request-row context menu: placement math (src/ui/components/ContextMenu.tsx) and the item model
// (src/ui/list/rowMenu.ts). Lives under the list-* prefix (the shell's unit-test namespace).
import { describe, expect, it, vi } from 'vitest';
import type { BridgeStatus } from '../../src/shared/claude-protocol';
import type { ListRule, RequestEntry } from '../../src/shared/types';
import {
  SUBMENU_OVERLAP,
  SUBMENU_TOP_OFFSET,
  placeAtPoint,
  placeContextMenu,
  placeSubmenu,
  type ContextMenuEntry,
  type ContextMenuItem,
} from '../../src/ui/components/ContextMenu';
import { POPUP_MARGIN } from '../../src/ui/components/position';
import { buildRowMenu, claudeUnavailableReason, isSendableUrl, type RowMenuActions, type RowMenuInput } from '../../src/ui/list/rowMenu';
import { EXACT_SUFFIX, countMatches, pathPrefixes } from '../../src/ui/list/rules';

const VP = { width: 1000, height: 700 };
const M = POPUP_MARGIN;

describe('placeAtPoint', () => {
  it('opens right of and below the pointer when it fits', () => {
    expect(placeAtPoint({ x: 100, y: 120 }, { width: 220, height: 300 }, VP)).toEqual({ left: 100, top: 120, maxHeight: 700 - 2 * M });
  });

  it('flips to the left / above at the right / bottom edges', () => {
    expect(placeAtPoint({ x: 900, y: 650 }, { width: 220, height: 300 }, VP)).toMatchObject({ left: 680, top: 350 });
  });

  it('clamps when neither side fits', () => {
    const p = placeAtPoint({ x: 150, y: 50 }, { width: 400, height: 800 }, { width: 450, height: 600 });
    expect(p.left).toBe(450 - M - 400);
    expect(p.top).toBe(M);
    expect(p.maxHeight).toBe(600 - 2 * M);
  });

  it('never goes past the top-left margin', () => {
    const p = placeAtPoint({ x: -20, y: -5 }, { width: 100, height: 100 }, VP);
    expect(p).toMatchObject({ left: M, top: M });
  });
});

describe('placeSubmenu', () => {
  const item = { left: 300, top: 200, right: 500, bottom: 228 };

  it('opens to the right of the item, lined up with it', () => {
    expect(placeSubmenu(item, { width: 250, height: 200 }, VP)).toEqual({
      left: 500 - SUBMENU_OVERLAP,
      top: 200 - SUBMENU_TOP_OFFSET,
      maxHeight: 700 - 2 * M,
      side: 'right',
    });
  });

  it('flips to the left at the right edge', () => {
    const p = placeSubmenu({ left: 700, top: 200, right: 900, bottom: 228 }, { width: 250, height: 200 }, VP);
    expect(p.side).toBe('left');
    expect(p.left).toBe(700 - 250 + SUBMENU_OVERLAP);
  });

  it('keeps going left once a parent flipped, unless it does not fit there', () => {
    expect(placeSubmenu(item, { width: 250, height: 200 }, VP, 'left')).toMatchObject({ side: 'left', left: 300 - 250 + SUBMENU_OVERLAP });
    expect(placeSubmenu({ left: 100, top: 0, right: 300, bottom: 28 }, { width: 250, height: 200 }, VP, 'left').side).toBe('right');
  });

  it('picks the roomier side and clamps when neither fits', () => {
    const p = placeSubmenu({ left: 200, top: 10, right: 350, bottom: 38 }, { width: 600, height: 100 }, { width: 700, height: 500 });
    expect(p.side).toBe('right');
    expect(p.left).toBe(700 - M - 600);
  });

  it('moves up to fit at the bottom', () => {
    const p = placeSubmenu({ left: 100, top: 650, right: 300, bottom: 678 }, { width: 200, height: 300 }, VP);
    expect(p.top).toBe(700 - M - 300);
  });
});

describe('placeContextMenu', () => {
  it('places below an anchor rect, aligned to its end edge', () => {
    const p = placeContextMenu({ rect: { left: 400, top: 100, right: 420, bottom: 120 }, align: 'end' }, { width: 200, height: 150 }, VP);
    expect(p).toMatchObject({ left: 220, top: 124 });
  });

  it('places at a point', () => {
    expect(placeContextMenu({ x: 10, y: 20 }, { width: 200, height: 150 }, VP)).toMatchObject({ left: 10, top: 20 });
  });
});

// ------------------------------------------------------------------------------------------- items

const KINEBOT = 'https://api.kinebot.com.br/standard/custom-report/result/reports/list-all';

function entry(url: string, patch: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.kinebot.com.br/',
    method: 'POST',
    url,
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1,
    state: 'done',
    status: 200,
    ...patch,
  };
}

const CONNECTED: BridgeStatus = {
  enabled: true,
  permission: true,
  host: 'connected',
  sessions: [{ id: 's1', label: 'reqlens', cwd: '/w/reqlens', pid: 1, connectedAt: 1 }],
  extensionId: 'abc',
};

function actions(): RowMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  const fns = {
    addRule: vi.fn(),
    disableRule: vi.fn(),
    copyUrl: vi.fn(),
    copyCurl: vi.fn(),
    copyFetch: vi.fn(),
    copyTypes: vi.fn(),
    copyPrompt: vi.fn(),
    sendToClaude: vi.fn(),
    openClaudeSetup: vi.fn(),
    resend: vi.fn(),
    duplicate: vi.fn(),
    showInitiator: vi.fn(),
    revert: vi.fn(),
    remove: vi.fn(),
  };
  return fns as RowMenuActions & Record<string, ReturnType<typeof vi.fn>>;
}

function input(patch: Partial<RowMenuInput> = {}): RowMenuInput {
  const e = patch.entry ?? entry(`${KINEBOT}?x=1`);
  const prefixes = pathPrefixes(e.url);
  return {
    entry: e,
    prefixes,
    counts: prefixes.map((_, i) => 10 - i),
    rules: [],
    modified: false,
    exportFormat: 'typescript',
    promptTarget: 'client',
    claude: CONNECTED,
    actions: actions(),
    ...patch,
  };
}

function items(menu: readonly ContextMenuEntry[]): ContextMenuItem[] {
  return menu.filter((e): e is ContextMenuItem => e.type !== 'separator');
}

function byTestId(menu: readonly ContextMenuEntry[], testId: string): ContextMenuItem {
  const found = items(menu).find((i) => i.testId === testId);
  if (!found) throw new Error(`no item ${testId}`);
  return found;
}

describe('buildRowMenu', () => {
  it('has the spec items in order', () => {
    const menu = buildRowMenu(input({ modified: true }));
    expect(items(menu).map((i) => i.testId)).toEqual([
      'rl-ctx-hide',
      'rl-ctx-only',
      'rl-ctx-copy',
      'rl-ctx-send-claude',
      'rl-ctx-initiator',
      'rl-ctx-resend',
      'rl-ctx-duplicate',
      'rl-ctx-revert',
      'rl-ctx-remove',
    ]);
  });

  it('offers Revert edits only for modified drafts', () => {
    expect(items(buildRowMenu(input())).some((i) => i.testId === 'rl-ctx-revert')).toBe(false);
  });

  it('lists the path-prefix ladder with counts under Hide / Show only', () => {
    const inp = input();
    const hide = byTestId(buildRowMenu(inp), 'rl-ctx-hide');
    const ladder = items(hide.submenu ?? []);
    expect(ladder.map((i) => i.label)).toEqual([
      'https://api.kinebot.com.br/',
      'https://api.kinebot.com.br/standard/',
      'https://api.kinebot.com.br/standard/custom-report/',
      'https://api.kinebot.com.br/standard/custom-report/result/',
      'https://api.kinebot.com.br/standard/custom-report/result/reports/',
      KINEBOT,
    ]);
    expect(ladder.map((i) => i.hint)).toEqual(['· 10', '· 9', '· 8', '· 7', '· 6', '· 5']);
    expect(ladder.map((i) => i.suffix)).toEqual([undefined, undefined, undefined, undefined, undefined, EXACT_SUFFIX]);
    expect(ladder.every((i) => i.mono && i.checked === false && i.testId === 'rl-ctx-hide-option')).toBe(true);
    expect(ladder[5]!.data).toEqual({ pattern: KINEBOT, exact: 'true' });
    ladder[1]!.onSelect!();
    expect(inp.actions.addRule).toHaveBeenCalledWith('hide', { pattern: 'https://api.kinebot.com.br/standard/', exact: false });
    const only = items(byTestId(buildRowMenu(inp), 'rl-ctx-only').submenu ?? []);
    expect(only.map((i) => i.testId)).toEqual(Array(6).fill('rl-ctx-only-option'));
    only[0]!.onSelect!();
    expect(inp.actions.addRule).toHaveBeenCalledWith('only', { pattern: 'https://api.kinebot.com.br/', exact: false });
  });

  it('works with real counts', () => {
    const e = entry(KINEBOT);
    const list = [e, entry('https://api.kinebot.com.br/standard/x'), entry('https://other.test/')];
    const prefixes = pathPrefixes(e.url);
    const ladder = items(byTestId(buildRowMenu(input({ entry: e, prefixes, counts: countMatches(list, prefixes) })), 'rl-ctx-hide').submenu ?? []);
    expect(ladder.map((i) => i.hint)).toEqual(['· 2', '· 2', '· 1', '· 1', '· 1', '· 1']);
  });

  it('checks ladder items whose rule is active; choosing one turns it off', () => {
    const active: ListRule = { id: 'r1', mode: 'hide', pattern: 'https://API.kinebot.com.br/standard/', exact: false, enabled: true, createdAt: 1 };
    const off: ListRule = { id: 'r2', mode: 'hide', pattern: 'https://api.kinebot.com.br/', exact: false, enabled: false, createdAt: 1 };
    const other: ListRule = { id: 'r3', mode: 'only', pattern: 'https://api.kinebot.com.br/', exact: false, enabled: true, createdAt: 1 };
    const inp = input({ rules: [active, off, other] });
    const ladder = items(byTestId(buildRowMenu(inp), 'rl-ctx-hide').submenu ?? []);
    expect(ladder.map((i) => i.checked)).toEqual([false, true, false, false, false, false]);
    ladder[1]!.onSelect!();
    expect(inp.actions.disableRule).toHaveBeenCalledWith(active);
    ladder[0]!.onSelect!(); // disabled rule: re-enabled through addRule (dedupe)
    expect(inp.actions.addRule).toHaveBeenCalledWith('hide', { pattern: 'https://api.kinebot.com.br/', exact: false });
    const only = items(byTestId(buildRowMenu(inp), 'rl-ctx-only').submenu ?? []);
    expect(only[0]!.checked).toBe(true);
  });

  it('offers a single exact item for data: URLs and cannot resend them', () => {
    const e = entry('data:application/json,{}');
    const menu = buildRowMenu(input({ entry: e, prefixes: pathPrefixes(e.url), counts: [1] }));
    const ladder = items(byTestId(menu, 'rl-ctx-hide').submenu ?? []);
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.suffix).toBe(EXACT_SUFFIX);
    const resend = byTestId(menu, 'rl-ctx-resend');
    expect(resend.disabled).toBe(true);
    expect(resend.description).toMatch(/http/);
  });

  it('disables over-long ladder items', () => {
    const long = `https://h.test/a/${'x'.repeat(3000)}`;
    const e = entry(long);
    const ladder = items(byTestId(buildRowMenu(input({ entry: e, prefixes: pathPrefixes(long), counts: [1, 1, 1] })), 'rl-ctx-hide').submenu ?? []);
    expect(ladder.map((i) => !!i.disabled)).toEqual([false, false, true]);
    expect(ladder[2]!.description).toBeTruthy();
    expect(Array.from(ladder[2]!.label).length).toBeLessThanOrEqual(80);
  });

  it('has the copy items, labelled with the export settings', () => {
    const inp = input({ exportFormat: 'zod', promptTarget: 'tests', modified: true });
    const copy = byTestId(buildRowMenu(inp), 'rl-ctx-copy');
    const sub = items(copy.submenu ?? []);
    expect(sub.map((i) => i.testId)).toEqual(['rl-ctx-copy-url', 'rl-ctx-copy-curl', 'rl-ctx-copy-fetch', 'rl-ctx-copy-types', 'rl-ctx-copy-prompt']);
    expect(sub[3]!.label).toBe('Types (Zod)');
    expect(sub[4]!.label).toBe('Agent prompt (tests)');
    expect(sub[1]!.hint).toBe('edited');
    for (const i of sub) i.onSelect!();
    for (const name of ['copyUrl', 'copyCurl', 'copyFetch', 'copyTypes', 'copyPrompt']) {
      expect(inp.actions[name as keyof RowMenuActions]).toHaveBeenCalledTimes(1);
    }
  });

  it('wires the remaining actions', () => {
    const inp = input({ modified: true });
    const menu = buildRowMenu(inp);
    for (const id of ['rl-ctx-send-claude', 'rl-ctx-resend', 'rl-ctx-duplicate', 'rl-ctx-revert', 'rl-ctx-remove']) {
      byTestId(menu, id).onSelect!();
    }
    expect(inp.actions.sendToClaude).toHaveBeenCalledWith(null);
    expect(inp.actions.resend).toHaveBeenCalled();
    expect(inp.actions.duplicate).toHaveBeenCalled();
    expect(inp.actions.revert).toHaveBeenCalled();
    expect(inp.actions.remove).toHaveBeenCalled();
  });

  it('disables Send to Claude Code with a reason, offering setup when Settings can fix it', () => {
    const inp = input({ claude: { ...CONNECTED, enabled: false, host: 'off', sessions: [] } });
    const menu = buildRowMenu(inp);
    const off = byTestId(menu, 'rl-ctx-send-claude');
    expect(off.disabled).toBe(true);
    expect(off.description).toMatch(/off/);
    expect(off.onSelect).toBeUndefined();
    byTestId(menu, 'rl-ctx-claude-setup').onSelect!();
    expect(inp.actions.openClaudeSetup).toHaveBeenCalled();
    // No session yet: nothing to set up, just the reason.
    const noSession = buildRowMenu(input({ claude: { ...CONNECTED, sessions: [] } }));
    expect(byTestId(noSession, 'rl-ctx-send-claude').description).toMatch(/No Claude Code session/);
    expect(items(noSession).some((i) => i.testId === 'rl-ctx-claude-setup')).toBe(false);
  });

  it('picks a session in a submenu when several are connected', () => {
    const sessions = [
      { id: 's1', label: 'reqlens', cwd: '/w/reqlens', pid: 1, connectedAt: 1 },
      { id: 's2', label: 'api', cwd: '/w/api', pid: 2, connectedAt: 2 },
    ];
    const inp = input({ claude: { ...CONNECTED, sessions } });
    const send = byTestId(buildRowMenu(inp), 'rl-ctx-send-claude');
    const sub = items(send.submenu ?? []);
    expect(sub.map((i) => i.label)).toEqual(['All sessions (2)', 'reqlens', 'api']);
    expect(sub[2]!.data).toEqual({ 'session-id': 's2' });
    sub[2]!.onSelect!();
    expect(inp.actions.sendToClaude).toHaveBeenCalledWith('s2');
    sub[0]!.onSelect!();
    expect(inp.actions.sendToClaude).toHaveBeenCalledWith(null);
  });

  it('offers "Show initiator / component", hinting entries without a stack', () => {
    const inp = input();
    const item = byTestId(buildRowMenu(inp), 'rl-ctx-initiator');
    expect(item.label).toBe('Show initiator / component');
    expect(item.hint).toBe('no stack');
    item.onSelect?.();
    expect(inp.actions.showInitiator).toHaveBeenCalledTimes(1);
    const withStack = input({ entry: { ...entry(KINEBOT), initiatorStack: 'at a (https://x.test/a.js:1:1)' } });
    expect(byTestId(buildRowMenu(withStack), 'rl-ctx-initiator').hint).toBeUndefined();
    const { showInitiator: _omit, ...rest } = actions();
    expect(items(buildRowMenu(input({ actions: rest }))).some((i) => i.testId === 'rl-ctx-initiator')).toBe(false);
  });

  it('keeps item ids unique per level', () => {
    const check = (menu: readonly ContextMenuEntry[]) => {
      const ids = menu.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const i of items(menu)) if (i.submenu) check(i.submenu);
    };
    check(buildRowMenu(input({ modified: true, claude: { ...CONNECTED, sessions: [...CONNECTED.sessions, { ...CONNECTED.sessions[0]!, id: 's2' }] } })));
  });
});

describe('claudeUnavailableReason', () => {
  it('explains every unavailable state', () => {
    expect(claudeUnavailableReason(CONNECTED)).toBeNull();
    for (const status of [
      { ...CONNECTED, enabled: false },
      { ...CONNECTED, permission: false },
      { ...CONNECTED, host: 'connecting' as const },
      { ...CONNECTED, host: 'not-installed' as const },
      { ...CONNECTED, host: 'error' as const, error: 'boom' },
      { ...CONNECTED, host: 'off' as const },
      { ...CONNECTED, sessions: [] },
    ]) {
      expect(claudeUnavailableReason(status)).toBeTruthy();
    }
    expect(claudeUnavailableReason({ ...CONNECTED, host: 'error', error: 'boom' })).toMatch(/boom/);
  });
});

describe('isSendableUrl', () => {
  it('accepts http(s) only', () => {
    expect(isSendableUrl('https://h.test/')).toBe(true);
    expect(isSendableUrl('HTTP://h.test/')).toBe(true);
    expect(isSendableUrl('data:text/plain,x')).toBe(false);
    expect(isSendableUrl('blob:https://h.test/x')).toBe(false);
    expect(isSendableUrl('ws://h.test/')).toBe(false);
  });
});
