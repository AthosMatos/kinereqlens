import { describe, expect, it } from 'vitest';
import type { PtyToHost } from '../../src/shared/claude-protocol';
import type { PtyLinkEvent } from '../../src/ui/panel/claudeLink';
import { LINK_LOST_ERROR, NOT_CONNECTED_ERROR, TerminalStore, dirLabel } from '../../src/ui/terminal/store';
import type { TermSink } from '../../src/ui/terminal/store';
import { sessionStatusText, terminalUnavailableReason } from '../../src/ui/terminal/texts';

class FakeTerm implements TermSink {
  out = '';
  resets = 0;
  disposed = false;
  write(data: string): void {
    this.out += data;
  }
  reset(): void {
    this.resets++;
    this.out = '';
  }
  dispose(): void {
    this.disposed = true;
  }
}

function harness(options: { connected?: boolean; gesture?: boolean } = {}) {
  const posted: PtyToHost[] = [];
  const terms: FakeTerm[] = [];
  const started: string[] = [];
  let listener: ((event: PtyLinkEvent) => void) | null = null;
  let ids = 0;
  const state = { connected: options.connected ?? true, gesture: options.gesture ?? true };
  const store = new TerminalStore({
    post: (m) => {
      if (!state.connected) return false;
      posted.push(m);
      return true;
    },
    subscribe: (fn) => {
      listener = fn;
      return () => (listener = null);
    },
    createTerm: () => {
      const t = new FakeTerm();
      terms.push(t);
      return t;
    },
    newId: () => `pty-${++ids}`,
    hasUserActivation: () => state.gesture,
    onStarted: (dir) => started.push(dir),
  });
  const emit = (event: PtyLinkEvent) => listener?.(event);
  return { store, posted, terms, started, emit, state };
}

describe('TerminalStore', () => {
  it('starts a session from a click, then follows the hub', () => {
    const { store, posted, terms, started, emit } = harness();
    const result = store.start('  ~/app ', 100, 30);
    expect(result.ok).toBe(true);
    expect(posted).toEqual([{ t: 'pty-open', id: 'pty-1', cwd: '~/app', cols: 100, rows: 30 }]);
    const [session] = store.list();
    expect(session).toMatchObject({ state: 'opening', typedCwd: '~/app' });
    expect(store.active).toBe(session!.key);
    emit({ t: 'pty-opened', id: 'pty-1', pid: 9, cwd: '/home/me/app' });
    expect(session).toMatchObject({ state: 'running', pid: 9, cwd: '/home/me/app' });
    expect(started).toEqual(['~/app']);
    emit({ t: 'pty-data', id: 'pty-1', data: 'hi' });
    expect(terms[0]!.out).toBe('hi');
    store.input(session!.key, 'ls\r');
    store.resize(session!.key, 120, 40);
    store.resize(session!.key, 0, 40);
    expect(posted.slice(1)).toEqual([
      { t: 'pty-input', id: 'pty-1', data: 'ls\r' },
      { t: 'pty-resize', id: 'pty-1', cols: 120, rows: 40 },
    ]);
    emit({ t: 'pty-exit', id: 'pty-1', code: 0, signal: null });
    expect(session!.state).toBe('exited');
    store.input(session!.key, 'ignored');
    expect(posted).toHaveLength(3);
  });

  it('refuses without a user gesture or a connected bridge', () => {
    const noGesture = harness({ gesture: false });
    expect(noGesture.store.start('~/app', 80, 24)).toMatchObject({ ok: false });
    expect(noGesture.posted).toEqual([]);
    const offline = harness({ connected: false });
    expect(offline.store.start('~/app', 80, 24)).toEqual({ ok: false, error: NOT_CONNECTED_ERROR });
    expect(offline.store.list()).toHaveLength(0);
    expect(harness().store.start('   ', 80, 24)).toMatchObject({ ok: false });
  });

  it('a first start that fails goes back to the form with the reason', () => {
    const { store, emit, terms } = harness();
    store.start('/missing', 80, 24);
    emit({ t: 'pty-error', id: 'pty-1', error: 'No such directory: /missing' });
    expect(store.list()).toHaveLength(0);
    expect(store.active).toBe('new');
    expect(store.formError).toEqual({ cwd: '/missing', error: 'No such directory: /missing' });
    expect(terms[0]!.disposed).toBe(true);
  });

  it('restart kills and reopens in the same folder with a fresh id and a cleared screen', () => {
    const { store, posted, emit, terms } = harness();
    store.start('~/app', 80, 24);
    const key = store.list()[0]!.key;
    emit({ t: 'pty-opened', id: 'pty-1', pid: 1 });
    emit({ t: 'pty-exit', id: 'pty-1', code: 1, signal: null });
    expect(store.restart(key, 90, 20)).toBe(true);
    expect(posted.slice(-2)).toEqual([
      { t: 'pty-close', id: 'pty-1' },
      { t: 'pty-open', id: 'pty-2', cwd: '~/app', cols: 90, rows: 20 },
    ]);
    expect(terms[0]!.resets).toBe(1);
    expect(store.get(key)).toMatchObject({ state: 'opening', ptyId: 'pty-2' });
    // Late events of the old process are ignored.
    emit({ t: 'pty-data', id: 'pty-1', data: 'old' });
    expect(terms[0]!.out).toBe('');
    // A restart that fails keeps the tab (it ran before).
    emit({ t: 'pty-error', id: 'pty-2', error: 'boom' });
    expect(store.get(key)).toMatchObject({ state: 'error', error: 'boom' });
  });

  it('close kills the process and selects a neighbour', () => {
    const { store, posted, emit, terms } = harness();
    store.start('/a', 80, 24);
    store.start('/b', 80, 24);
    const [a, b] = store.list();
    emit({ t: 'pty-opened', id: 'pty-1', pid: 1 });
    store.close(b!.key);
    expect(posted.at(-1)).toEqual({ t: 'pty-close', id: 'pty-2' });
    expect(terms[1]!.disposed).toBe(true);
    expect(store.active).toBe(a!.key);
    store.close(a!.key);
    expect(store.active).toBe('new');
  });

  it('re-attaches terminals handed back after a panel reload, with their replay', () => {
    const { store, emit, terms } = harness();
    emit({ t: 'pty-attached', id: 'pty-old', cwd: '/w/app', pid: 4, state: 'running', replay: 'scrollback' });
    const [session] = store.list();
    expect(session).toMatchObject({ ptyId: 'pty-old', cwd: '/w/app', state: 'running', pid: 4, everRan: true });
    expect(terms[0]!.out).toBe('scrollback');
    expect(store.active).toBe(session!.key);
    emit({ t: 'pty-attached', id: 'bad id', cwd: '/x', state: 'running', replay: '' });
    expect(store.list()).toHaveLength(1);
  });

  it('losing the worker link ends running sessions', () => {
    const { store, emit } = harness();
    store.start('/a', 80, 24);
    emit({ t: 'pty-opened', id: 'pty-1', pid: 1 });
    emit({ t: 'link-lost' });
    expect(store.list()[0]).toMatchObject({ state: 'exited', error: LINK_LOST_ERROR });
  });

  it('splits big pastes', () => {
    const { store, posted, emit } = harness();
    store.start('/a', 80, 24);
    emit({ t: 'pty-opened', id: 'pty-1', pid: 1 });
    store.input(store.list()[0]!.key, 'x'.repeat(150_000));
    expect(posted.filter((m) => m.t === 'pty-input')).toHaveLength(3);
  });
});

describe('terminal pane texts', () => {
  it('labels and status lines', () => {
    expect(dirLabel('/Users/me/app/')).toBe('app');
    expect(dirLabel('~')).toBe('~');
    expect(dirLabel('/')).toBe('/');
    expect(dirLabel('C:\\work\\api')).toBe('api');
    expect(sessionStatusText({ state: 'exited', cwd: '/a', exit: { code: 2, signal: null } })).toBe('Exited (code 2)');
    expect(sessionStatusText({ state: 'exited', cwd: '/a', exit: { code: null, signal: 1 } })).toBe('Exited (signal 1)');
    expect(sessionStatusText({ state: 'exited', cwd: '/a', exit: { code: 127, signal: null } })).toContain('not found');
    expect(sessionStatusText({ state: 'running', cwd: '/a' })).toBe('Running · /a');
  });

  it('explains why the terminal is unavailable', () => {
    const base = { enabled: true, permission: true, host: 'connected' as const, sessions: [], extensionId: 'x' };
    expect(terminalUnavailableReason(base)).toBeNull();
    expect(terminalUnavailableReason({ ...base, enabled: false })).toContain('off');
    expect(terminalUnavailableReason({ ...base, permission: false })).toContain('permission');
    expect(terminalUnavailableReason({ ...base, host: 'not-installed' })).toContain('not installed');
    expect(terminalUnavailableReason({ ...base, host: 'error', error: 'boom' })).toContain('boom');
  });
});
