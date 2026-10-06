import { describe, expect, it } from 'vitest';
import { isRestrictedUrl } from '../../src/background/inject';
import { badgeText } from '../../src/background/badge';

describe('isRestrictedUrl', () => {
  it.each([
    'edge://settings',
    'edge://newtab/',
    'chrome://extensions',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
    'extension://abc/page.html',
    'chrome-search://local-ntp/local-ntp.html',
    'chrome-error://chromewebdata/',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com/',
    'about:newtab',
    'about:settings',
    'data:text/html,<h1>hi</h1>',
    'javascript:void(0)',
    'https://chromewebstore.google.com/detail/foo/abc',
    'https://chrome.google.com/webstore/detail/foo',
    'https://chrome.google.com/webstore',
    'https://microsoftedge.microsoft.com/addons/detail/foo/abc',
    'https://MicrosoftEdge.Microsoft.com/Addons/category/x',
  ])('%s is restricted', (url) => {
    expect(isRestrictedUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://localhost:3000/app?x=1',
    'https://chrome.google.com/search', // not the gallery
    'https://microsoftedge.microsoft.com/', // not the add-ons path
    'https://microsoftedge.microsoft.com/addonsfoo',
    'https://example.com/report.pdf', // decided by the scripting probe, not the URL
    'file:///Users/me/index.html',
    'about:blank',
    'about:srcdoc',
    '',
    'not a url',
  ])('%s is not restricted by URL', (url) => {
    expect(isRestrictedUrl(url)).toBe(false);
  });
});

describe('badgeText', () => {
  it('formats counts', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-3)).toBe('');
    expect(badgeText(Number.NaN)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(999)).toBe('999');
    expect(badgeText(1000)).toBe('999+');
    expect(badgeText(12.7)).toBe('12');
  });
});
