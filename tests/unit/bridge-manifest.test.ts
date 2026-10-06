// The Claude Code bridge's permission is requested at install time: Chromium does not add
// chrome.runtime.connectNative to an already-running service worker when an optional grant arrives.
import { describe, expect, it } from 'vitest';

type FsModule = { readFileSync(path: URL, encoding: 'utf8'): string };
const fsSpecifier = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as FsModule;
const manifest = JSON.parse(readFileSync(new URL('../../static/manifest.json', import.meta.url), 'utf8')) as {
  permissions: string[];
  optional_permissions?: string[];
};
const buildScript = readFileSync(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');

describe('manifest: Claude Code bridge', () => {
  it('requests nativeMessaging as a regular permission', () => {
    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.optional_permissions ?? []).not.toContain('nativeMessaging');
  });

  it('grants it at install time in the E2E build', () => {
    expect(buildScript).toMatch(/if \(e2e\) \{[\s\S]*'nativeMessaging'[\s\S]*manifest\.permissions/);
  });
});
