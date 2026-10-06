import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { RequestEntry } from '../../src/shared/types';
import { DEFAULT_SEND_OPTIONS, defaultCredentials, resolveSendOptions } from '../../src/ui/detail/draftStore';

type EntryLike = Pick<RequestEntry, 'source' | 'kind' | 'requestOptions'>;
const hookFetch = (requestOptions?: RequestEntry['requestOptions']): EntryLike => ({ source: 'hook', kind: 'fetch', requestOptions });

describe('defaultCredentials', () => {
  it('follows the page: fetch default same-origin, explicit credentials, XHR withCredentials', () => {
    expect(defaultCredentials(hookFetch(), 'page')).toBe('same-origin');
    expect(defaultCredentials(hookFetch({ credentials: 'include' }), 'page')).toBe('include');
    expect(defaultCredentials(hookFetch({ credentials: 'omit' }), 'page')).toBe('omit');
    expect(defaultCredentials({ source: 'hook', kind: 'xhr', requestOptions: { withCredentials: true } }, 'page')).toBe('include');
    expect(defaultCredentials({ source: 'hook', kind: 'xhr', requestOptions: { withCredentials: false } }, 'page')).toBe('same-origin');
  });

  it('ignores invalid captured values', () => {
    expect(defaultCredentials(hookFetch({ credentials: 'bogus' }), 'page')).toBe('same-origin');
  });

  it('sends cookies for beacons, browser-initiated and manual requests', () => {
    expect(defaultCredentials({ source: 'hook', kind: 'beacon' }, 'page')).toBe('include');
    expect(defaultCredentials({ source: 'webRequest', kind: 'document' }, 'page')).toBe('include');
    expect(defaultCredentials({ source: 'manual', kind: 'manual' }, 'page')).toBe('include');
    expect(defaultCredentials(null, 'page')).toBe('include');
  });

  it('acts as the signed-in user in extension mode unless the page used omit', () => {
    expect(defaultCredentials(hookFetch(), 'extension')).toBe('include');
    expect(defaultCredentials(hookFetch({ credentials: 'omit' }), 'extension')).toBe('omit');
  });
});

describe('resolveSendOptions', () => {
  it('uses the automatic credentials until the user overrides them', () => {
    const auto = resolveSendOptions(DEFAULT_SEND_OPTIONS, DEFAULT_SETTINGS, hookFetch());
    expect(auto).toMatchObject({ mode: 'page', credentials: 'same-origin', credentialsAuto: true, redirect: 'follow' });
    const ext = resolveSendOptions({ ...DEFAULT_SEND_OPTIONS, mode: 'extension' }, DEFAULT_SETTINGS, hookFetch());
    expect(ext).toMatchObject({ mode: 'extension', credentials: 'include', credentialsAuto: true });
    const manual = resolveSendOptions({ ...DEFAULT_SEND_OPTIONS, credentials: 'omit' }, DEFAULT_SETTINGS, hookFetch());
    expect(manual).toMatchObject({ credentials: 'omit', credentialsAuto: false });
  });

  it('clamps the timeout', () => {
    expect(resolveSendOptions({ ...DEFAULT_SEND_OPTIONS, timeoutMs: 1 }, DEFAULT_SETTINGS).timeoutMs).toBe(1000);
    expect(resolveSendOptions({ ...DEFAULT_SEND_OPTIONS, timeoutMs: 1e9 }, DEFAULT_SETTINGS).timeoutMs).toBe(600_000);
  });
});
