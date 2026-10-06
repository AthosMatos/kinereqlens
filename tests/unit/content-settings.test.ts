import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { Settings } from '../../src/shared/types';
import { SettingsStore, hookConfigOf, sanitizeSettings, settingsEqual } from '../../src/content/settings';
import type { SettingsStorage } from '../../src/content/settings';

/** In-memory storage whose reads/writes resolve when the test says so. */
function fakeStorage(initial: unknown) {
  let stored: unknown = initial;
  const watchers = new Set<(value: unknown) => void>();
  const pendingWrites: Array<() => void> = [];
  let readResolve: ((value: unknown) => void) | null = null;
  const storage: SettingsStorage = {
    read: () => new Promise((resolve) => (readResolve = resolve)),
    write: (settings) =>
      new Promise<boolean>((resolve) => {
        pendingWrites.push(() => {
          stored = settings;
          resolve(true);
        });
      }),
    watch: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  return {
    storage,
    finishRead: () => readResolve?.(stored),
    /** Complete the oldest pending write (without its change event). */
    ackWrite: () => pendingWrites.shift()?.(),
    /** Fire storage.onChanged with `value`. */
    emit: (value: unknown) => {
      for (const w of watchers) w(value);
    },
    get stored() {
      return stored;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sanitizeSettings / settingsEqual / hookConfigOf', () => {
  it('fills defaults, drops junk and clamps ranges', () => {
    const s = sanitizeSettings({ theme: 'neon', opacity: 0.01, maxEntries: 12.6, layout: { dock: 'right', split: 7, x: 'a' } });
    expect(s.theme).toBe('auto');
    expect(s.opacity).toBe(0.3);
    expect(s.maxEntries).toBe(13);
    expect(s.layout).toEqual({ ...DEFAULT_SETTINGS.layout, dock: 'right', split: 1 });
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('compares by value (layout one level deep) and extracts the hook config', () => {
    const a = sanitizeSettings(null);
    expect(settingsEqual(a, { ...a, layout: { ...a.layout } })).toBe(true);
    expect(settingsEqual(a, { ...a, layout: { ...a.layout, w: 1 } })).toBe(false);
    expect(hookConfigOf(a)).toEqual({
      captureResponseBodies: a.captureResponseBodies,
      requestBodyCap: a.requestBodyCap,
      responseBodyCap: a.responseBodyCap,
    });
  });
});

describe('claudeRecentDirs / layout.terminalHeight', () => {
  it('defaults to no recent directories and a 300 px terminal', () => {
    const s = sanitizeSettings(null);
    expect(s.claudeRecentDirs).toEqual([]);
    expect(s.layout.terminalHeight).toBe(300);
  });

  it('validates the recent directories (strings, trimmed, deduped, no control chars, ≤ 10)', () => {
    const many = Array.from({ length: 14 }, (_, i) => `~/p${i}`);
    expect(sanitizeSettings({ claudeRecentDirs: many }).claudeRecentDirs).toEqual(many.slice(0, 10));
    expect(sanitizeSettings({ claudeRecentDirs: [' /a ', '/a', 42, null, '', '/b\u0007', '/c'] }).claudeRecentDirs).toEqual(['/a', '/c']);
    expect(sanitizeSettings({ claudeRecentDirs: '/a' }).claudeRecentDirs).toEqual([]);
    expect(sanitizeSettings({ claudeRecentDirs: ['/' + 'x'.repeat(5000)] }).claudeRecentDirs).toEqual([]);
  });

  it('clamps the terminal height', () => {
    expect(sanitizeSettings({ layout: { terminalHeight: 10 } }).layout.terminalHeight).toBe(80);
    expect(sanitizeSettings({ layout: { terminalHeight: 420.6 } }).layout.terminalHeight).toBe(421);
    expect(sanitizeSettings({ layout: { terminalHeight: 'big' } }).layout.terminalHeight).toBe(300);
  });

  it('keeps the navigation rail collapsed unless a boolean says otherwise', () => {
    expect(sanitizeSettings(null).layout.railExpanded).toBe(false);
    expect(sanitizeSettings({ layout: { railExpanded: true } }).layout.railExpanded).toBe(true);
    expect(sanitizeSettings({ layout: { railExpanded: 'yes' } }).layout.railExpanded).toBe(false);
    const a = sanitizeSettings({ layout: { railExpanded: true } });
    expect(settingsEqual(a, sanitizeSettings({ layout: { railExpanded: false } }))).toBe(false);
  });

  it('compares recent directories by value', () => {
    const a = sanitizeSettings({ claudeRecentDirs: ['/a', '/b'] });
    expect(settingsEqual(a, sanitizeSettings({ claudeRecentDirs: ['/a', '/b'] }))).toBe(true);
    expect(settingsEqual(a, sanitizeSettings({ claudeRecentDirs: ['/b', '/a'] }))).toBe(false);
    expect(settingsEqual(a, sanitizeSettings({ claudeRecentDirs: ['/a'] }))).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('loads the stored value merged over defaults and notifies once', async () => {
    const fake = fakeStorage({ theme: 'dark', layout: { dock: 'left' } });
    const store = new SettingsStore(fake.storage);
    const seen: Settings[] = [];
    store.subscribe((s) => seen.push(s));
    store.start();
    expect(store.loaded).toBe(false);
    fake.finishRead();
    await store.ready;
    expect(store.loaded).toBe(true);
    expect(store.get().theme).toBe('dark');
    expect(store.get().layout.dock).toBe('left');
    expect(store.get().layout.w).toBe(DEFAULT_SETTINGS.layout.w);
    expect(seen).toHaveLength(1);
  });

  it('merges partial layout patches from different writers', async () => {
    const fake = fakeStorage(undefined);
    const store = new SettingsStore(fake.storage);
    store.start();
    fake.finishRead();
    await store.ready;
    const p1 = store.update({ layout: { dock: 'bottom' } });
    const p2 = store.update({ layout: { split: 0.3 } });
    fake.ackWrite();
    fake.ackWrite();
    await Promise.all([p1, p2]);
    expect(store.get().layout).toMatchObject({ dock: 'bottom', split: 0.3 });
    expect((fake.stored as Settings).layout).toMatchObject({ dock: 'bottom', split: 0.3 });
  });

  it('a slow initial read does not overwrite a newer local update', async () => {
    const fake = fakeStorage({ theme: 'light' });
    const store = new SettingsStore(fake.storage);
    store.start();
    const pending = store.update({ theme: 'dark' });
    fake.finishRead();
    await store.ready;
    fake.ackWrite();
    await pending;
    expect(store.get().theme).toBe('dark');
  });

  it('ignores the echo of an older local write while a newer one is in flight', async () => {
    const fake = fakeStorage(undefined);
    const store = new SettingsStore(fake.storage);
    store.start();
    fake.finishRead();
    await store.ready;
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.theme));
    const first = store.update({ theme: 'light' });
    const second = store.update({ theme: 'dark' });
    // storage.onChanged for the first write arrives while the second is still pending
    fake.emit({ ...DEFAULT_SETTINGS, theme: 'light' });
    expect(store.get().theme).toBe('dark');
    fake.ackWrite();
    fake.ackWrite();
    await Promise.all([first, second]);
    fake.emit({ ...DEFAULT_SETTINGS, theme: 'dark' });
    expect(seen).toEqual(['light', 'dark']);
  });

  it('follows changes made elsewhere once no local write is pending', async () => {
    const fake = fakeStorage(undefined);
    const store = new SettingsStore(fake.storage);
    store.start();
    fake.finishRead();
    await store.ready;
    fake.emit({ ...DEFAULT_SETTINGS, opacity: 0.5 });
    expect(store.get().opacity).toBe(0.5);
    store.dispose();
    fake.emit({ ...DEFAULT_SETTINGS, opacity: 0.9 });
    expect(store.get().opacity).toBe(0.5);
    await tick();
  });
});
