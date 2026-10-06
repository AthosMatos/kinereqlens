// Folder browser of the terminal, panel side: pure path helpers (src/ui/terminal/folders.ts), the request
// client (src/ui/terminal/fsClient.ts) and the panel link's `fs-*` routing (src/ui/panel/claudeLink.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsEntry, FsToHost } from '../../src/shared/claude-protocol';
import { FS_LIST_TIMEOUT_MS } from '../../src/shared/claude-protocol';
import { FS_UNSUPPORTED_ERROR } from '../../src/shared/fs';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/constants';
import type { ReqlensBridge, Settings } from '../../src/shared/types';
import type { FsLinkEvent } from '../../src/ui/panel/claudeLink';
import { baseName, breadcrumbs, childPath, filterEntries, homeBreadcrumbs, parentOfTyped, tildePath } from '../../src/ui/terminal/folders';
import { FS_CLIENT_TIMEOUT_ERROR, FS_LINK_DOWN_ERROR, FsClient, FsRequestError } from '../../src/ui/terminal/fsClient';

describe('folder path helpers', () => {
  it('breadcrumbs: POSIX, Windows drives and UNC shares', () => {
    expect(breadcrumbs('/', '/')).toEqual([{ label: '/', path: '/' }]);
    expect(breadcrumbs('/Users/me/code', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'me', path: '/Users/me' },
      { label: 'code', path: '/Users/me/code' },
    ]);
    expect(breadcrumbs('c:\\Users\\me', '\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' },
    ]);
    expect(breadcrumbs('C:\\', '\\')).toEqual([{ label: 'C:', path: 'C:\\' }]);
    expect(breadcrumbs('\\\\srv\\share\\proj', '\\')).toEqual([
      { label: '\\\\srv\\share', path: '\\\\srv\\share\\' },
      { label: 'proj', path: '\\\\srv\\share\\proj' },
    ]);
  });

  it('homeBreadcrumbs folds the home directory into ~', () => {
    expect(homeBreadcrumbs('/Users/me/code/app', '/', '/Users/me')).toEqual([
      { label: '~', path: '/Users/me' },
      { label: 'code', path: '/Users/me/code' },
      { label: 'app', path: '/Users/me/code/app' },
    ]);
    expect(homeBreadcrumbs('/Users/me', '/', '/Users/me/')).toEqual([{ label: '~', path: '/Users/me' }]);
    expect(homeBreadcrumbs('/opt/x', '/', '/Users/me')).toEqual(breadcrumbs('/opt/x', '/'));
    expect(homeBreadcrumbs('C:\\Users\\Me\\x', '\\', 'c:\\users\\me')[0]).toEqual({ label: '~', path: 'C:\\Users\\Me' });
  });

  it('childPath / parentOfTyped / baseName', () => {
    expect(childPath('/a', 'b', '/')).toBe('/a/b');
    expect(childPath('/', 'b', '/')).toBe('/b');
    expect(childPath('C:\\', 'b', '\\')).toBe('C:\\b');
    expect(childPath('C:\\a', 'b', '\\')).toBe('C:\\a\\b');
    expect(parentOfTyped('~/code/app')).toBe('~/code');
    expect(parentOfTyped('~/code/app/')).toBe('~/code');
    expect(parentOfTyped('~/app')).toBe('~');
    expect(parentOfTyped('/app')).toBe('/');
    expect(parentOfTyped('/')).toBeNull();
    expect(parentOfTyped('~')).toBeNull();
    expect(parentOfTyped('C:\\app')).toBe('C:\\');
    expect(baseName('/a/b/')).toBe('b');
    expect(baseName('C:\\a\\b')).toBe('b');
  });

  it('filterEntries: hidden only when asked (or typed), prefix matches first, case-insensitive', () => {
    const entries: FsEntry[] = ['api', 'web-app', 'App', '.config', '.app-cache'].map((name) => ({ name, dir: true, hidden: name.startsWith('.') }));
    expect(filterEntries(entries, '', false).map((e) => e.name)).toEqual(['api', 'web-app', 'App']);
    expect(filterEntries(entries, '', true)).toHaveLength(5);
    expect(filterEntries(entries, 'app', false).map((e) => e.name)).toEqual(['App', 'web-app']);
    expect(filterEntries(entries, 'APP', true).map((e) => e.name)).toEqual(['App', 'web-app', '.app-cache']);
    expect(filterEntries(entries, '.c', false).map((e) => e.name)).toEqual(['.config']);
    expect(filterEntries(entries, 'cache', false)).toEqual([]);
    expect(filterEntries(entries, 'zzz', true)).toEqual([]);
  });

  it('tildePath', () => {
    expect(tildePath('/Users/me', '/Users/me')).toBe('~');
    expect(tildePath('/Users/me/code', '/Users/me/')).toBe('~/code');
    expect(tildePath('/Users/meow', '/Users/me')).toBe('/Users/meow');
    expect(tildePath('/x', null)).toBe('/x');
    expect(tildePath('c:\\users\\me\\x', 'C:\\Users\\me', '\\')).toBe('~\\x');
  });
});

function client(options: { post?: (m: FsToHost) => boolean; activation?: boolean } = {}) {
  const posted: FsToHost[] = [];
  let listener: ((event: FsLinkEvent) => void) | null = null;
  let n = 0;
  const c = new FsClient({
    post: options.post ?? ((m) => (posted.push(m), true)),
    subscribe: (fn) => {
      listener = fn;
      return () => (listener = null);
    },
    newId: () => `q${++n}`,
    hasUserActivation: () => options.activation ?? true,
  });
  return { c, posted, emit: (event: unknown) => listener?.(event as FsLinkEvent) };
}

describe('FsClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists, picks and caches projects', async () => {
    const { c, posted, emit } = client();
    const listing = c.list('~');
    expect(posted).toEqual([{ t: 'fs-list', id: 'q1', path: '~' }]);
    emit({ t: 'fs-listed', id: 'q1', path: '/h', parent: '/', entries: [{ name: 'a', dir: true, hidden: false }], home: '/h', sep: '/' });
    await expect(listing).resolves.toEqual({ path: '/h', parent: '/', entries: [{ name: 'a', dir: true, hidden: false }], home: '/h', sep: '/' });

    const pick = c.pick('/h');
    expect(posted.at(-1)).toEqual({ t: 'fs-pick', id: 'q2', startPath: '/h' });
    emit({ t: 'fs-picked', id: 'q2', path: null });
    await expect(pick).resolves.toBeNull();

    expect(c.cachedProjects).toBeNull();
    const projects = c.projects();
    emit({ t: 'fs-projects-listed', id: 'q3', home: '/h', projects: [{ path: '/h/code/x', name: 'x', git: true }] });
    await expect(projects).resolves.toEqual({ home: '/h', truncated: false, projects: [{ path: '/h/code/x', name: 'x', git: true }] });
    await expect(c.projects()).resolves.toBe(c.cachedProjects);
    expect(posted).toHaveLength(3);
    void c.projects(true);
    expect(posted.at(-1)).toEqual({ t: 'fs-projects', id: 'q4', refresh: true });
  });

  it('rejects on errors (flagging an unusable bridge), wrong answers, timeouts and a lost link', async () => {
    const { c, emit } = client();
    const missing = c.list('/nope');
    emit({ t: 'fs-error', id: 'q1', error: 'No such directory: /nope' });
    await expect(missing).rejects.toMatchObject({ message: 'No such directory: /nope', unavailable: false });
    const old = c.list('~');
    emit({ t: 'fs-error', id: 'q2', error: FS_UNSUPPORTED_ERROR });
    await expect(old).rejects.toMatchObject({ unavailable: true });
    const wrong = c.list('~');
    emit({ t: 'fs-picked', id: 'q3', path: '/x' });
    await expect(wrong).rejects.toBeInstanceOf(FsRequestError);
    const slow = c.list('~');
    vi.advanceTimersByTime(FS_LIST_TIMEOUT_MS + 5000);
    await expect(slow).rejects.toMatchObject({ message: FS_CLIENT_TIMEOUT_ERROR });
    const lost = c.list('~');
    emit({ t: 'link-lost' });
    await expect(lost).rejects.toMatchObject({ message: FS_LINK_DOWN_ERROR, unavailable: true });
    // Garbage and unknown ids are ignored.
    emit({ t: 'fs-listed', id: 'q99' });
    emit(null);
  });

  it('refuses without a link, and opens the chooser only from a user gesture', async () => {
    await expect(client({ post: () => false }).c.list('~')).rejects.toMatchObject({ message: FS_LINK_DOWN_ERROR });
    const { c, posted } = client({ activation: false });
    await expect(c.pick()).rejects.toThrow('Choose folder');
    expect(posted).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- panel link

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

class FakeRuntimePort {
  posted: unknown[] = [];
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  constructor(public name: string) {}
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  disconnect() {}
  receive(m: unknown) {
    for (const fn of this.messageListeners) fn(m);
  }
  close() {
    for (const fn of this.disconnectListeners) fn();
  }
}

describe('panel link: fs routing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('posts fs requests, hands fs answers to subscribers and reports the link going away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ports: FakeRuntimePort[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: EXT_ID,
        lastError: undefined,
        connect: ({ name }: { name: string }) => {
          const port = new FakeRuntimePort(name);
          ports.push(port);
          return port;
        },
      },
      permissions: { contains: async () => true, request: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    });
    vi.resetModules();
    const link = await import('../../src/ui/panel/claudeLink');
    const settings: Settings = mergeSettings(DEFAULT_SETTINGS, { claudeBridge: true });
    const bridge = { getSettings: () => settings, subscribeSettings: () => () => undefined } as unknown as ReqlensBridge;
    expect(link.postFs({ t: 'fs-list', id: 'q1', path: '~' })).toBe(false);
    link.startClaudeLink(4, bridge);
    const port = ports[0]!;
    const events: FsLinkEvent[] = [];
    const ptyEvents: unknown[] = [];
    link.subscribeFs((e) => events.push(e));
    link.subscribePty((e) => ptyEvents.push(e));
    expect(link.postFs({ t: 'fs-list', id: 'q1', path: '~' })).toBe(true);
    expect(port.posted.at(-1)).toEqual({ t: 'fs-list', id: 'q1', path: '~' });
    port.receive({ t: 'fs-picked', id: 'q1', path: '/x' });
    expect(events).toEqual([{ t: 'fs-picked', id: 'q1', path: '/x' }]);
    expect(ptyEvents).toEqual([]);
    port.close();
    expect(events.at(-1)).toEqual({ t: 'link-lost' });
  });
});
