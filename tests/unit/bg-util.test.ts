import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestBodyCapOf, settingsFromStorage } from '../../src/background/settings';
import { sanitizeTabStatePatch, tabIdFromKey, tabIdFromStateKey, tabStateFromStorage } from '../../src/background/tabs';
import { KeepAlive, Mutex, ReadyGate, errorMessage, isNoReceiverError, withTimeout } from '../../src/background/util';
import { DEFAULT_SETTINGS, DEFAULT_TAB_STATE, preservedLogKey, tabStateKey } from '../../src/shared/constants';

afterEach(() => {
  vi.useRealTimers();
});

describe('errorMessage / isNoReceiverError', () => {
  it('extracts messages from anything thrown', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('text')).toBe('text');
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
    expect(errorMessage(new DOMException('', 'AbortError'))).toBe('AbortError');
  });

  it('recognizes "no content script" messaging failures', () => {
    expect(isNoReceiverError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
    expect(isNoReceiverError(new Error('No frame with id 5 in tab 3.'))).toBe(true);
    expect(isNoReceiverError(new Error('The message port closed before a response was received.'))).toBe(true);
    expect(isNoReceiverError(new Error('Extension context invalidated.'))).toBe(false);
  });
});

describe('Mutex', () => {
  it('grants the lock in FIFO order', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const releaseA = await mutex.acquire();
    const b = mutex.acquire().then((release) => {
      order.push('b');
      release();
    });
    const c = mutex.acquire().then((release) => {
      order.push('c');
      release();
    });
    order.push('a');
    releaseA();
    releaseA(); // idempotent
    await Promise.all([b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(mutex.isLocked).toBe(false);
  });

  it('lets waiters leave the queue when aborted', async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    const controller = new AbortController();
    const waiting = mutex.acquire(controller.signal);
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(mutex.isLocked).toBe(false);
    await expect(mutex.acquire(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ReadyGate', () => {
  it('queues work until ready, then runs it in order and immediately afterwards', async () => {
    let resolve: () => void = () => undefined;
    const gate = new ReadyGate(new Promise<void>((r) => (resolve = r)));
    const ran: number[] = [];
    gate.run(() => ran.push(1));
    gate.run(() => {
      throw new Error('isolated');
    });
    gate.run(() => ran.push(2));
    expect(ran).toEqual([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resolve();
    await Promise.resolve();
    expect(ran).toEqual([1, 2]);
    expect(gate.isOpen).toBe(true);
    gate.run(() => ran.push(3));
    expect(ran).toEqual([1, 2, 3]);
    spy.mockRestore();
  });

  it('opens even when startup failed, and bounds the queue', async () => {
    const gate = new ReadyGate(Promise.reject(new Error('x')), 2);
    const ran: number[] = [];
    for (let i = 0; i < 5; i++) gate.run(() => ran.push(i));
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual([0, 1]);
  });
});

describe('KeepAlive', () => {
  it('pings only while held', () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const keepAlive = new KeepAlive(ping, 1000);
    const a = keepAlive.acquire();
    const b = keepAlive.acquire();
    vi.advanceTimersByTime(2500);
    expect(ping).toHaveBeenCalledTimes(2);
    a();
    a();
    vi.advanceTimersByTime(1000);
    expect(ping).toHaveBeenCalledTimes(3);
    b();
    vi.advanceTimersByTime(5000);
    expect(ping).toHaveBeenCalledTimes(3);
  });
});

describe('withTimeout', () => {
  it('resolves, rejects, or times out', async () => {
    await expect(withTimeout(Promise.resolve(1), 50, 'late')).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error('no')), 50, 'late')).rejects.toThrow('no');
    await expect(withTimeout(new Promise(() => undefined), 5, 'late')).rejects.toThrow('late');
  });
});

describe('tab state helpers', () => {
  it('sanitizes untrusted patches strictly', () => {
    expect(sanitizeTabStatePatch({ open: true, preserveLog: false, extra: 'x' })).toEqual({ open: true, preserveLog: false });
    expect(sanitizeTabStatePatch({ recording: undefined })).toEqual({});
    expect(sanitizeTabStatePatch({ open: 'true' })).toBeNull();
    expect(sanitizeTabStatePatch(null)).toBeNull();
    expect(sanitizeTabStatePatch([true])).toBeNull();
  });

  it('coerces stored values field by field', () => {
    expect(tabStateFromStorage(undefined)).toEqual(DEFAULT_TAB_STATE);
    expect(tabStateFromStorage({ open: true, recording: 'no' })).toEqual({ ...DEFAULT_TAB_STATE, open: true });
    expect(tabStateFromStorage({ open: true, recording: false, preserveLog: true })).toEqual({ open: true, recording: false, preserveLog: true });
  });

  it('parses tab ids out of storage keys', () => {
    expect(tabIdFromStateKey(tabStateKey(42))).toBe(42);
    expect(tabIdFromStateKey(preservedLogKey(42))).toBeNull();
    expect(tabIdFromStateKey('reqlens:tab:x')).toBeNull();
    expect(tabIdFromStateKey('other:42')).toBeNull();
    expect(tabIdFromKey(preservedLogKey(7))).toBe(7);
    expect(tabIdFromKey(tabStateKey(7))).toBe(7);
    expect(tabIdFromKey('reqlens:settings')).toBeNull();
  });
});

describe('settings helpers', () => {
  it('merges stored settings over defaults', () => {
    expect(settingsFromStorage(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromStorage('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromStorage({ requestBodyCap: 10, layout: { w: 1 } })).toMatchObject({ requestBodyCap: 10, layout: { w: 1, h: DEFAULT_SETTINGS.layout.h } });
  });

  it('sanitizes the request body cap', () => {
    expect(requestBodyCapOf({ ...DEFAULT_SETTINGS, requestBodyCap: 2048.7 })).toBe(2048);
    expect(requestBodyCapOf({ ...DEFAULT_SETTINGS, requestBodyCap: -1 })).toBe(DEFAULT_SETTINGS.requestBodyCap);
    expect(requestBodyCapOf({ ...DEFAULT_SETTINGS, requestBodyCap: Number.NaN })).toBe(DEFAULT_SETTINGS.requestBodyCap);
    expect(requestBodyCapOf({ ...DEFAULT_SETTINGS, requestBodyCap: 1e15 })).toBe(64 * 1024 * 1024);
  });
});
