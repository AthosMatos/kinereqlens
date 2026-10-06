import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeStatus } from '../../src/shared/claude-protocol';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import type { RequestEntry, Settings } from '../../src/shared/types';

// Real lib pipeline; the clipboard, toasts and the bridge link are mocked.
const h = vi.hoisted(() => ({
  copied: [] as Array<{ text: string; label?: string }>,
  toasts: [] as Array<{ message: string; kind?: string }>,
  pushed: [] as unknown[],
  status: null as unknown,
}));
vi.mock('../../src/ui/components/clipboard', () => ({
  copyText: vi.fn(async (text: string, label?: string) => {
    h.copied.push({ text, label });
    return true;
  }),
}));
vi.mock('../../src/ui/components/toast', () => ({
  toast: vi.fn((message: string, kind?: string) => h.toasts.push({ message, kind })),
}));
vi.mock('../../src/ui/panel/claudeLink', () => ({
  getBridgeStatus: () => h.status,
  sendToClaude: vi.fn(async (item: unknown) => {
    h.pushed.push(item);
    return { ok: true, delivered: 1 };
  }),
}));

const actions = await import('../../src/ui/export/actions');

const connected: BridgeStatus = {
  enabled: true,
  permission: true,
  host: 'connected',
  sessions: [{ id: 's1', label: 'shop', cwd: '/work/shop', pid: 1, connectedAt: 1 }],
  extensionId: 'x',
};

let seq = 0;
function postEntry(): RequestEntry {
  const response = '{"id":7,"status":"open","items":[{"sku":"A-1","qty":2}]}';
  const body = '{"items":[{"sku":"A-1","qty":2}],"note":"leave at door"}';
  return {
    id: `h:0:${++seq}`,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://shop.test/cart',
    method: 'POST',
    url: 'https://api.shop.test/api/orders?api_key=supersecretvalue',
    requestHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: 'Bearer secret-token-123' },
    ],
    requestBody: { kind: 'text', text: body, size: body.length },
    requestContentType: 'application/json',
    startTime: 1,
    endTime: 2,
    state: 'done',
    status: 201,
    statusText: 'Created',
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    responseBody: { kind: 'text', text: response, size: response.length },
  };
}

function bind(patch: Partial<Settings>): void {
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  actions.bindExportSettings(() => settings);
}

beforeEach(() => {
  h.copied.length = 0;
  h.toasts.length = 0;
  h.pushed.length = 0;
  h.status = connected;
  actions.bindExportSettings(null);
});

describe('copyTypes', () => {
  it('uses settings.exportFormat unless a format is given', async () => {
    bind({ exportFormat: 'zod' });
    expect(await actions.copyTypes(postEntry())).toBe(true);
    expect(h.copied[0]!.text.startsWith("import { z } from 'zod';")).toBe(true);
    expect(h.copied[0]!.label).toBe('Zod types copied');
    expect(await actions.copyTypes(postEntry(), 'typescript')).toBe(true);
    expect(h.copied[1]!.text).toContain('export interface');
    expect(h.copied[1]!.label).toBe('TypeScript types copied');
  });

  it('falls back to the default settings without a bound reader or chrome.storage', async () => {
    expect(await actions.copyTypes(postEntry())).toBe(true);
    expect(h.copied[0]!.label).toBe('TypeScript types copied');
  });

  it('honours the base name typed in the Export tab', async () => {
    const { setBaseNameOverride } = await import('../../src/ui/export/prefs');
    const entry = postEntry();
    setBaseNameOverride(entry.id, 'placeOrder');
    await actions.copyTypes(entry, 'typescript');
    expect(h.copied[0]!.text).toContain('PlaceOrderRequestBody');
  });
});

describe('copyAgentPrompt', () => {
  it('redacts secrets unless shareSecrets is on', async () => {
    bind({ promptTarget: 'tests' });
    expect(await actions.copyAgentPrompt(postEntry())).toBe(true);
    const redacted = h.copied[0]!.text;
    expect(redacted).not.toContain('secret-token-123');
    expect(redacted).not.toContain('supersecretvalue');
    bind({ claudeShareSecrets: true });
    await actions.copyAgentPrompt(postEntry(), 'client');
    expect(h.copied[1]!.text).toContain('supersecretvalue');
    expect(h.copied[1]!.label).toBe('Agent prompt copied');
  });
});

describe('sendEntryToClaude', () => {
  it('pushes the prompt with the title and target', async () => {
    bind({ promptTarget: 'server' });
    const entry = postEntry();
    expect(await actions.sendEntryToClaude(entry)).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toMatchObject({ entryId: entry.id, target: 'server', sessionId: null });
    expect((h.pushed[0] as { title: string }).title).toMatch(/^POST \/api\/orders/);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'success' });
  });

  it('addresses a known session only', async () => {
    await actions.sendEntryToClaude(postEntry(), { sessionId: 's1' });
    await actions.sendEntryToClaude(postEntry(), { sessionId: 'gone' });
    expect(h.pushed.map((p) => (p as { sessionId: unknown }).sessionId)).toEqual(['s1', null]);
  });

  it('explains instead of sending when the bridge cannot deliver', async () => {
    h.status = { ...connected, enabled: false };
    expect(await actions.sendEntryToClaude(postEntry())).toBe(false);
    expect(h.pushed).toHaveLength(0);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'warn' });
    expect(h.toasts.at(-1)!.message).toContain('Settings → Claude Code');
  });
});
