import { describe, expect, it } from 'vitest';
import { sanitizeSettings, settingsEqual } from '../../src/content/settings';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import {
  LANGUAGE_OPTIONS,
  MAX_LANGUAGE_ITEMS,
  MAX_SITE_LANGUAGES,
  canonicalTag,
  effectiveLanguage,
  languageName,
  languagesOf,
  normalizeLanguageValue,
  normalizeSiteKey,
  parseLanguageValue,
  primaryLanguage,
  sanitizeLanguageStatus,
  sanitizeSiteLanguages,
  searchLanguages,
  siteKeyOf,
  siteLanguagesEqual,
  withSiteLanguage,
} from '../../src/shared/language';
import { sanitizeSetupConfig } from '../../src/shared/setups';
import type { Setup } from '../../src/shared/types';
import {
  applySetupPatch,
  captureConfig,
  configMatches,
  importSetups,
  isModified,
  restorePatch,
  setupSummary,
  stateLanguage,
} from '../../src/ui/setups/model';
import type { ListConfigState } from '../../src/ui/setups/model';

describe('canonicalTag', () => {
  it('canonicalizes well-formed tags', () => {
    expect(canonicalTag('pt-br')).toBe('pt-BR');
    expect(canonicalTag(' EN-us ')).toBe('en-US');
    expect(canonicalTag('es-419')).toBe('es-419');
    expect(canonicalTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalTag('ar')).toBe('ar');
    expect(canonicalTag('de-CH-1996')).toBe('de-CH-1996');
  });

  it('rejects garbage, wildcards, extensions and over-long input', () => {
    for (const bad of ['', ' ', '*', 'e', 'english!', 'pt_BR', 'pt-', '-pt', 'en-US-u-nu-arab', 'x-private', '12', 'pt-BR;q=1', 'a'.repeat(40), null, 7]) {
      expect(canonicalTag(bad), String(bad)).toBeNull();
    }
  });
});

describe('parseLanguageValue', () => {
  it('normalizes lists with q-values', () => {
    expect(parseLanguageValue('pt-BR, en;q=0.8')).toEqual({
      ok: true,
      value: 'pt-BR,en;q=0.8',
      items: [
        { tag: 'pt-BR', q: null },
        { tag: 'en', q: 0.8 },
      ],
    });
    expect(normalizeLanguageValue('pt-br ; q = 1 , en ; Q=0.500')).toBe('pt-BR,en;q=0.5');
    expect(normalizeLanguageValue('fr-FR,fr;q=0.9,en;q=0.8,de;q=0.7')).toBe('fr-FR,fr;q=0.9,en;q=0.8,de;q=0.7');
    expect(normalizeLanguageValue(' ja-JP ,, ')).toBe('ja-JP');
  });

  it('drops duplicates (first wins) and q=0 items', () => {
    expect(normalizeLanguageValue('pt-BR, PT-br;q=0.5, es;q=0')).toBe('pt-BR');
    expect(normalizeLanguageValue('en;q=0.000, de')).toBe('de');
  });

  it('refuses invalid tags, weights and empty / huge lists', () => {
    expect(parseLanguageValue('')).toMatchObject({ ok: false });
    expect(parseLanguageValue('en;q=0')).toMatchObject({ ok: false, error: 'Enter at least one language' });
    expect(parseLanguageValue('pt_BR')).toMatchObject({ ok: false });
    for (const q of ['q=2', 'q=1.5', 'q=-0.1', 'q=0.1234', 'q=', 'level=1', 'q=abc']) {
      expect(parseLanguageValue(`en;${q}`).ok, q).toBe(false);
    }
    const many = Array.from({ length: MAX_LANGUAGE_ITEMS + 1 }, (_, i) => `x${String.fromCharCode(97 + i)}`).join(',');
    expect(parseLanguageValue(many)).toMatchObject({ ok: false });
    expect(parseLanguageValue(42)).toMatchObject({ ok: false });
  });

  it('orders languages by weight, stable', () => {
    expect(languagesOf('en;q=0.5, pt-BR, de;q=0.5, fr;q=0.9')).toEqual(['pt-BR', 'fr', 'en', 'de']);
    expect(primaryLanguage('pt-BR,en;q=0.8')).toBe('pt-BR');
    expect(languagesOf('nope!')).toEqual([]);
    expect(primaryLanguage(null)).toBeNull();
  });
});

describe('picker', () => {
  it('lists valid, unique, canonical tags', () => {
    const tags = LANGUAGE_OPTIONS.map((o) => o.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) expect(canonicalTag(tag)).toBe(tag);
    for (const tag of ['pt-BR', 'en-US', 'en-GB', 'es-ES', 'es-419', 'fr-FR', 'de-DE', 'it-IT', 'ja-JP', 'zh-CN', 'ko-KR', 'ru-RU', 'ar', 'hi-IN']) {
      expect(tags).toContain(tag);
    }
  });

  it('searches by tag prefix first, then native / English names (accents ignored)', () => {
    expect(searchLanguages('').length).toBe(LANGUAGE_OPTIONS.length);
    expect(searchLanguages('pt').map((o) => o.tag).slice(0, 2)).toEqual(['pt-BR', 'pt-PT']);
    expect(searchLanguages('pt_br').map((o) => o.tag)).toContain('pt-BR');
    expect(searchLanguages('portugues').map((o) => o.tag)).toEqual(['pt-BR', 'pt-PT']);
    expect(searchLanguages('japanese').map((o) => o.tag)).toEqual(['ja-JP']);
    expect(searchLanguages('日本').map((o) => o.tag)).toEqual(['ja-JP']);
    expect(searchLanguages('latin').map((o) => o.tag)).toEqual(['es-419']);
    expect(searchLanguages('zzzz')).toEqual([]);
  });

  it('names tags', () => {
    expect(languageName('pt-BR')).toBe('Português (Brasil)');
    expect(languageName(null)).toBeNull();
  });
});

describe('site keys and siteLanguages', () => {
  it('uses the host name of http(s) pages', () => {
    expect(siteKeyOf('https://App.Example.com:8443/x?y#z')).toBe('app.example.com');
    expect(siteKeyOf('http://127.0.0.1:5173/')).toBe('127.0.0.1');
    expect(siteKeyOf('https://bücher.de/')).toBe('xn--bcher-kva.de');
    expect(siteKeyOf('https://example.com./')).toBe('example.com');
    expect(siteKeyOf('file:///tmp/a.html')).toBeNull();
    expect(siteKeyOf('chrome-extension://abc/panel.html')).toBeNull();
    expect(siteKeyOf('not a url')).toBeNull();
    expect(siteKeyOf(undefined)).toBeNull();
    expect(normalizeSiteKey('Example.COM')).toBe('example.com');
    expect(normalizeSiteKey('[::1]')).toBe('[::1]');
    for (const bad of ['', 'a/b', 'user@host', 'a b', 'x?y', 42]) expect(normalizeSiteKey(bad), String(bad)).toBeNull();
  });

  it('sanitizes the stored map (hosts canonical, values normalized, bounded)', () => {
    expect(
      sanitizeSiteLanguages({ 'Example.com': 'pt-br, en;q=0.8', 'bad host': 'en', 'ok.test': 'nope!', 'x.test': 3, 'example.com': 'de' }),
    ).toEqual({ 'example.com': 'pt-BR,en;q=0.8' });
    expect(sanitizeSiteLanguages(null)).toEqual({});
    expect(sanitizeSiteLanguages(['en'])).toEqual({});
    const big: Record<string, string> = {};
    for (let i = 0; i < MAX_SITE_LANGUAGES + 20; i++) big[`h${i}.test`] = 'en';
    expect(Object.keys(sanitizeSiteLanguages(big))).toHaveLength(MAX_SITE_LANGUAGES);
  });

  it('edits, compares and resolves', () => {
    const map = withSiteLanguage({}, 'a.test', 'pt-BR');
    expect(map).toEqual({ 'a.test': 'pt-BR' });
    expect(withSiteLanguage(map, 'a.test', null)).toEqual({});
    expect(siteLanguagesEqual({ a: 'x', b: 'y' }, { b: 'y', a: 'x' })).toBe(true);
    expect(siteLanguagesEqual({ a: 'x' }, { a: 'y' })).toBe(false);
    expect(siteLanguagesEqual({ a: 'x' }, { a: 'x', b: 'y' })).toBe(false);
    const full: Record<string, string> = {};
    for (let i = 0; i < MAX_SITE_LANGUAGES; i++) full[`h${i}.test`] = 'en';
    expect(withSiteLanguage(full, 'new.test', 'de')['new.test']).toBeUndefined();
    expect(withSiteLanguage(full, 'h1.test', 'de')['h1.test']).toBe('de');

    expect(effectiveLanguage(null, { 'a.test': 'de' }, 'a.test')).toEqual({ tab: null, site: 'de', host: 'a.test', effective: 'de', scope: 'site' });
    expect(effectiveLanguage('pt-BR', { 'a.test': 'de' }, 'a.test')).toMatchObject({ effective: 'pt-BR', scope: 'tab', site: 'de' });
    expect(effectiveLanguage(null, { 'a.test': 'de' }, 'b.test')).toMatchObject({ effective: null, scope: null });
    expect(effectiveLanguage(null, { toString: 'x' } as unknown as Record<string, string>, null).effective).toBeNull();
  });

  it('re-validates statuses received over messages', () => {
    expect(sanitizeLanguageStatus({ tab: 'pt-br', site: 'de', host: 'A.test' })).toEqual({
      tab: 'pt-BR',
      site: 'de',
      host: 'a.test',
      effective: 'pt-BR',
      scope: 'tab',
    });
    expect(sanitizeLanguageStatus({ tab: null, site: null, host: null })).toMatchObject({ effective: null, scope: null });
    expect(sanitizeLanguageStatus({ tab: '<script>', site: 'de', host: 'bad host' })).toMatchObject({ tab: null, effective: null });
    expect(sanitizeLanguageStatus('x')).toBeNull();
  });
});

describe('settings sanitizer', () => {
  it('defaults to no site languages and sanitizes the map', () => {
    expect(DEFAULT_SETTINGS.siteLanguages).toEqual({});
    expect(sanitizeSettings(null).siteLanguages).toEqual({});
    expect(sanitizeSettings({ siteLanguages: { 'A.test': 'pt-br', 'b c': 'en', 'd.test': '' } }).siteLanguages).toEqual({ 'a.test': 'pt-BR' });
    expect(sanitizeSettings({ siteLanguages: 'en' }).siteLanguages).toEqual({});
  });

  it('compares siteLanguages by value', () => {
    const a = sanitizeSettings({ siteLanguages: { 'a.test': 'pt-BR', 'b.test': 'de' } });
    const b = sanitizeSettings({ siteLanguages: { 'b.test': 'de', 'a.test': 'pt-BR' } });
    expect(settingsEqual(a, b)).toBe(true);
    expect(settingsEqual(a, sanitizeSettings({ siteLanguages: { 'a.test': 'pt-BR' } }))).toBe(false);
  });
});

describe('Setups integration', () => {
  const base: ListConfigState = { listTypes: ['fetch'], listRules: [], defaultMode: 'page', activeSetupId: null };
  const setup = (language?: string): Setup => ({
    id: 's1',
    name: 'Brazil',
    group: '',
    sites: [],
    config: { listTypes: ['fetch'], listRules: [], ...(language ? { language } : {}) },
    createdAt: 1,
    updatedAt: 1,
  });

  it('validates the stored language', () => {
    expect(sanitizeSetupConfig({ listTypes: [], listRules: [], language: 'pt-br, en;q=0.8' })?.language).toBe('pt-BR,en;q=0.8');
    expect(sanitizeSetupConfig({ listTypes: [], listRules: [], language: 'nope!' })).not.toHaveProperty('language');
    expect(sanitizeSetupConfig({ listTypes: [], listRules: [] })).not.toHaveProperty('language');
  });

  it('captures the page site language (optionally)', () => {
    const state: ListConfigState = { ...base, pageHost: 'a.test', siteLanguages: { 'a.test': 'pt-BR', 'b.test': 'de' } };
    expect(stateLanguage(state)).toBe('pt-BR');
    expect(captureConfig(state).language).toBe('pt-BR');
    expect(captureConfig(state, { includeLanguage: false })).not.toHaveProperty('language');
    expect(captureConfig({ ...state, pageHost: 'c.test' })).not.toHaveProperty('language');
    expect(captureConfig(base)).not.toHaveProperty('language');
  });

  it('applies the language to the page host and restores the map on undo', () => {
    const before: ListConfigState = { ...base, pageHost: 'a.test', siteLanguages: { 'b.test': 'de' } };
    const patch = applySetupPatch(setup('pt-BR'), { now: 5, newId: () => 'r', pageHost: 'a.test', siteLanguages: before.siteLanguages! });
    expect(patch.siteLanguages).toEqual({ 'b.test': 'de', 'a.test': 'pt-BR' });
    expect(restorePatch(before).siteLanguages).toEqual({ 'b.test': 'de' });
    // Nothing to write: no language, no host, or already set.
    expect(applySetupPatch(setup(), { now: 5, newId: () => 'r', pageHost: 'a.test', siteLanguages: {} })).not.toHaveProperty('siteLanguages');
    expect(applySetupPatch(setup('pt-BR'), { now: 5, newId: () => 'r', pageHost: null, siteLanguages: {} })).not.toHaveProperty('siteLanguages');
    expect(applySetupPatch(setup('pt-BR'), { now: 5, newId: () => 'r', pageHost: 'a.test', siteLanguages: { 'a.test': 'pt-BR' } })).not.toHaveProperty(
      'siteLanguages',
    );
    expect(restorePatch(base)).not.toHaveProperty('siteLanguages');
  });

  it('counts a different site language as modified', () => {
    const s = setup('pt-BR');
    const state = (lang: string | null): ListConfigState => ({
      ...base,
      activeSetupId: 's1',
      pageHost: 'a.test',
      siteLanguages: lang ? { 'a.test': lang } : {},
    });
    expect(isModified([s], state('pt-BR'))).toBe(false);
    expect(isModified([s], state('de'))).toBe(true);
    expect(isModified([s], state(null))).toBe(true);
    // A setup without a language ignores it.
    expect(isModified([setup()], state('de'))).toBe(false);
    expect(configMatches({ listTypes: ['fetch'], listRules: [] }, { listTypes: ['fetch'], listRules: [], language: 'x' })).toBe(true);
  });

  it('summarizes and imports the language', () => {
    expect(setupSummary(setup('pt-BR,en;q=0.8'))).toContain('Language pt-BR');
    const result = importSetups([setup('pt-BR')], [{ ...setup('de'), id: 's2' }], 'merge', { now: 9, newId: () => 'n' });
    expect(result.updated).toBe(1);
    expect(result.setups[0]!.config.language).toBe('de');
    const same = importSetups([setup('pt-BR')], [{ ...setup('pt-BR'), id: 's2' }], 'merge', { now: 9, newId: () => 'n' });
    expect(same.unchanged).toBe(1);
  });
});
