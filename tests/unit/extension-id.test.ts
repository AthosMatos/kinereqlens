// The unpacked build's id is pinned by the "key" in static/manifest.json (the same on every machine, so the native
// messaging host can allow it up front), and the store package (`npm run zip`) ships without that key.
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID_UNPACKED } from '../../src/shared/constants';

type FsModule = { readFileSync(path: URL, encoding: 'utf8'): string };
type UrlModule = { fileURLToPath(url: URL): string };
interface ZipModule {
  storeManifest(text: string): string;
  packageFiles(srcDir: string): Promise<Array<{ name: string; data: Uint8Array }>>;
}
const fsSpecifier = 'node:fs';
const urlSpecifier = 'node:url';
const zipSpecifier = '../../scripts/zip.mjs';
const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as FsModule;
const { fileURLToPath } = (await import(/* @vite-ignore */ urlSpecifier)) as UrlModule;
const zip = (await import(/* @vite-ignore */ zipSpecifier)) as ZipModule;

const manifestText = readFileSync(new URL('../../static/manifest.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText) as Record<string, unknown> & { key?: string };

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key), (char) => char.charCodeAt(0));
}

/** Chromium's id for a manifest key: sha256 of the DER public key, first 32 hex digits mapped 0-f → a-p. */
async function idFromKey(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes(key)));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

describe('extension id', () => {
  it('EXTENSION_ID_UNPACKED is the id Chromium derives from static/manifest.json "key"', async () => {
    expect(typeof manifest.key).toBe('string');
    expect(EXTENSION_ID_UNPACKED).toMatch(/^[a-p]{32}$/);
    expect(await idFromKey(manifest.key ?? '')).toBe(EXTENSION_ID_UNPACKED);
  });

  it('the key is a 2048-bit RSA public key (SubjectPublicKeyInfo DER), not a private key', async () => {
    const key = await crypto.subtle.importKey('spki', keyBytes(manifest.key ?? ''), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']);
    expect(key.type).toBe('public');
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
  });
});

describe('store package (npm run zip)', () => {
  it('ships the manifest without "key" and every other field unchanged', async () => {
    const files = await zip.packageFiles(fileURLToPath(new URL('../../static/', import.meta.url)));
    const entry = files.find((file) => file.name === 'manifest.json');
    expect(entry).toBeDefined();
    const packaged = JSON.parse(new TextDecoder().decode(entry?.data)) as Record<string, unknown>;
    const { key: _key, ...rest } = manifest;
    expect(packaged).toEqual(rest);
    expect(Object.keys(packaged)).not.toContain('key');
    expect(files.map((file) => file.name)).toContain('panel.html');
  });

  it('leaves a manifest without "key" untouched', () => {
    const text = JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0' }, null, 2);
    expect(zip.storeManifest(text)).toBe(text);
    expect(JSON.parse(zip.storeManifest(manifestText))).not.toHaveProperty('key');
  });
});
