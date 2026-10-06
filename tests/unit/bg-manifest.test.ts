// The manifest the store packages ship (static/manifest.json; scripts/build.mjs only sets the version).
import { describe, expect, it } from 'vitest';

type FsModule = { readFileSync(path: URL, encoding: 'utf8'): string };
const fsSpecifier = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as FsModule;
const manifest = JSON.parse(readFileSync(new URL('../../static/manifest.json', import.meta.url), 'utf8')) as {
  description: string;
  web_accessible_resources?: Array<{ resources: string[]; matches: string[] }>;
  permissions: string[];
};

describe('manifest', () => {
  it('keeps the description within the 132-character limit of the manifest / store listings', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it('exposes only the overlay panel page to web pages', () => {
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['panel.html'], matches: ['<all_urls>'] }]);
  });

  it('requests no permission beyond what the features use', () => {
    expect([...manifest.permissions].sort()).toEqual(['declarativeNetRequestWithHostAccess', 'nativeMessaging', 'scripting', 'storage', 'webRequest']);
  });
});
