import { describe, expect, it } from 'vitest';
import { sanitizeSettings, settingsEqual } from '../../src/content/settings';
import { DEFAULT_SETTINGS, MAX_SETUP_SITES, MAX_SETUPS } from '../../src/shared/constants';
import { normalizeListTypes, sanitizeListTypes } from '../../src/shared/setups';
import type { ListRule, Setup } from '../../src/shared/types';
import {
  applySetupPatch,
  canonicalGroup,
  captureConfig,
  configMatches,
  createSetup,
  decideAutoApply,
  duplicateSetup,
  exportFileName,
  exportSetups,
  groupNames,
  groupSetups,
  importSetups,
  importSummary,
  isModified,
  moveSetupToGroup,
  normalizeHostPattern,
  pageSite,
  parseSetupsFile,
  pickAutoApplySetup,
  removeSetup,
  renameSetup,
  restorePatch,
  restoreSetup,
  searchSetups,
  setSetupSites,
  setupSummary,
  typesSummary,
  uniqueName,
  updateSetupConfig,
} from '../../src/ui/setups/model';
import type { ListConfigState } from '../../src/ui/setups/model';

const rule = (id: string, over: Partial<ListRule> = {}): ListRule => ({
  id,
  mode: 'hide',
  pattern: 'https://api.example.com/health',
  exact: true,
  enabled: true,
  createdAt: 1,
  ...over,
});
const methodRule = (id: string, method: string, mode: ListRule['mode'] = 'hide'): ListRule => ({
  id,
  mode,
  pattern: '',
  method,
  exact: true,
  enabled: true,
  createdAt: 1,
});

function setup(id: string, over: Partial<Setup> = {}): Setup {
  return {
    id,
    name: `Setup ${id}`,
    group: '',
    sites: [],
    config: { listTypes: ['fetch'], listRules: [] },
    createdAt: 10,
    updatedAt: 10,
    ...over,
  };
}

const baseState = (over: Partial<ListConfigState> = {}): ListConfigState => ({
  listTypes: ['fetch'],
  listRules: [],
  defaultMode: 'page',
  activeSetupId: null,
  ...over,
});

let seq = 0;
const newId = () => `n${++seq}`;

// ------------------------------------------------------------------------------------------- sanitizer

describe('settings sanitizer: listTypes / setups / activeSetupId', () => {
  it('defaults: Fetch/XHR, no setups, nothing active', () => {
    const s = sanitizeSettings(null);
    expect(s.listTypes).toEqual(['fetch']);
    expect(s.setups).toEqual([]);
    expect(s.activeSetupId).toBeNull();
    expect(DEFAULT_SETTINGS.listTypes).toEqual(['fetch']);
  });

  it('listTypes: known ids only, menu order, deduplicated; every type = [] (all); junk falls back', () => {
    expect(sanitizeSettings({ listTypes: ['img', 'fetch', 'img', 'nope'] }).listTypes).toEqual(['fetch', 'img']);
    expect(sanitizeSettings({ listTypes: [] }).listTypes).toEqual([]);
    expect(sanitizeSettings({ listTypes: ['other', 'font', 'media', 'img', 'css', 'js', 'doc', 'fetch'] }).listTypes).toEqual([]);
    expect(sanitizeSettings({ listTypes: ['nope'] }).listTypes).toEqual(['fetch']);
    expect(sanitizeSettings({ listTypes: 'fetch' }).listTypes).toEqual(['fetch']);
    expect(sanitizeListTypes([1, null], ['doc'])).toEqual(['doc']);
    expect(normalizeListTypes(new Set(['js', 'fetch']))).toEqual(['fetch', 'js']);
  });

  it('setups: invalid items dropped, labels cleaned, sites normalized, rules sanitized, duplicate ids dropped', () => {
    const long = 'x'.repeat(100);
    const s = sanitizeSettings({
      setups: [
        {
          id: 'a',
          name: '  My\n  setup ',
          group: ` ${'g'.repeat(70)} `,
          sites: ['API.Example.com', 'bad host', '*.example.com:8443', 'api.example.com', 'https://x.test/path'],
          config: {
            listTypes: ['doc', 'zzz'],
            listRules: [rule('r1'), { id: 'r2', mode: 'nope', pattern: 'x' }, methodRule('r3', 'OPTIONS')],
            defaultMode: 'extension',
          },
          createdAt: 5,
          updatedAt: 'later',
        },
        { id: 'a', name: 'dup', config: {} },
        { id: 'b', name: '   ', config: {} },
        { id: 'bad id!', name: 'x', config: {} },
        { id: 'c', name: long, config: { defaultMode: 'warp' } },
        { id: 'd', name: 'no config' },
        'junk',
      ],
      activeSetupId: 'c',
    });
    expect(s.setups.map((x) => x.id)).toEqual(['a', 'c']);
    const [a, c] = s.setups;
    expect(a).toEqual({
      id: 'a',
      name: 'My setup',
      group: 'g'.repeat(60),
      sites: ['api.example.com', '*.example.com:8443', 'x.test'],
      config: { listTypes: ['doc'], listRules: [rule('r1'), methodRule('r3', 'OPTIONS')], defaultMode: 'extension' },
      createdAt: 5,
      updatedAt: 5,
    });
    expect(c!.name).toHaveLength(80);
    expect(c!.config).toEqual({ listTypes: ['fetch'], listRules: [] });
    expect(s.activeSetupId).toBe('c');
  });

  it('activeSetupId must name a setup; at most MAX_SETUPS setups and MAX_SETUP_SITES sites', () => {
    expect(sanitizeSettings({ setups: [setup('a')], activeSetupId: 'zz' }).activeSetupId).toBeNull();
    expect(sanitizeSettings({ setups: [setup('a')], activeSetupId: 3 }).activeSetupId).toBeNull();
    const many = Array.from({ length: MAX_SETUPS + 5 }, (_, i) => setup(`s${i}`));
    expect(sanitizeSettings({ setups: many }).setups).toHaveLength(MAX_SETUPS);
    const sites = Array.from({ length: 30 }, (_, i) => `h${i}.example.com`);
    expect(sanitizeSettings({ setups: [setup('a', { sites })] }).setups[0]!.sites).toHaveLength(MAX_SETUP_SITES);
  });

  it('settingsEqual compares listTypes and setups by value', () => {
    const a = sanitizeSettings({ setups: [setup('a', { sites: ['x.test'] })], listTypes: ['doc'] });
    const b = sanitizeSettings(JSON.parse(JSON.stringify(a)));
    expect(a.setups).not.toBe(b.setups);
    expect(settingsEqual(a, b)).toBe(true);
    expect(settingsEqual(a, { ...b, listTypes: ['fetch'] })).toBe(false);
    expect(settingsEqual(a, { ...b, setups: [{ ...b.setups[0]!, name: 'other' }] })).toBe(false);
    expect(settingsEqual(a, { ...b, activeSetupId: 'a' })).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- host patterns

describe('host patterns', () => {
  it('normalizes what users type', () => {
    expect(normalizeHostPattern('API.Kinebot.com.br')).toBe('api.kinebot.com.br');
    expect(normalizeHostPattern(' *.kinebot.com.br ')).toBe('*.kinebot.com.br');
    expect(normalizeHostPattern('localhost:05173')).toBe('localhost:5173');
    expect(normalizeHostPattern('https://app.example.com:8443/a?b#c')).toBe('app.example.com:8443');
    expect(normalizeHostPattern('example.com.')).toBe('example.com');
    expect(normalizeHostPattern('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeHostPattern('*.bücher.de')).toBe('*.xn--bcher-kva.de');
    expect(normalizeHostPattern('[::1]:8080')).toBe('[::1]:8080');
    expect(normalizeHostPattern('127.0.0.1:3000')).toBe('127.0.0.1:3000');
  });

  it('rejects what is not a host pattern', () => {
    for (const bad of ['', '   ', 'a b.com', '*', '*.', 'a.*.com', '*example.com', 'host:0', 'host:70000', 'user@host', '*.127.0.0.1', 'a..b', 'x%41.com', 42]) {
      expect(normalizeHostPattern(bad), String(bad)).toBeNull();
    }
  });

  it('pageSite: host + non-default port of http(s) pages only', () => {
    expect(pageSite('https://API.example.com/x')).toBe('api.example.com');
    expect(pageSite('http://localhost:5173/app')).toBe('localhost:5173');
    expect(pageSite('https://example.com:443/')).toBe('example.com');
    expect(pageSite('file:///tmp/x.html')).toBeNull();
    expect(pageSite('not a url')).toBeNull();
  });
});

describe('auto-apply choice', () => {
  const all = setup('all', { sites: ['*.kinebot.com.br'], updatedAt: 50 });
  const api = setup('api', { sites: ['api.kinebot.com.br'], updatedAt: 20 });
  const apiPort = setup('apiPort', { sites: ['api.kinebot.com.br:8443'], updatedAt: 1 });
  const wildApi = setup('wildApi', { sites: ['*.api.kinebot.com.br'], updatedAt: 99 });

  it('most specific pattern wins: more labels, then exact over wildcard, then explicit port', () => {
    expect(pickAutoApplySetup([all, api], 'https://api.kinebot.com.br/x')?.setup.id).toBe('api');
    expect(pickAutoApplySetup([all, api], 'https://app.kinebot.com.br/')?.setup.id).toBe('all');
    // A wildcard also covers the bare domain.
    expect(pickAutoApplySetup([all], 'https://kinebot.com.br/')?.setup.id).toBe('all');
    // Exact beats a wildcard with as many labels.
    expect(pickAutoApplySetup([wildApi, api], 'https://api.kinebot.com.br/')?.setup.id).toBe('api');
    expect(pickAutoApplySetup([wildApi, api], 'https://v2.api.kinebot.com.br/')?.setup.id).toBe('wildApi');
    // Port: only that port, and more specific than any port.
    expect(pickAutoApplySetup([api, apiPort], 'https://api.kinebot.com.br:8443/')?.setup.id).toBe('apiPort');
    expect(pickAutoApplySetup([apiPort], 'https://api.kinebot.com.br/')).toBeNull();
    expect(pickAutoApplySetup([setup('p', { sites: ['example.com:443'] })], 'https://EXAMPLE.com/')?.setup.id).toBe('p');
  });

  it('ties go to the most recently updated setup; non-http pages never match', () => {
    const older = setup('older', { sites: ['x.test'], updatedAt: 5 });
    const newer = setup('newer', { sites: ['x.test'], updatedAt: 9 });
    expect(pickAutoApplySetup([newer, older], 'http://x.test/')?.setup.id).toBe('newer');
    expect(pickAutoApplySetup([older, newer], 'http://x.test/')?.setup.id).toBe('newer');
    expect(pickAutoApplySetup([older], 'file:///x.test')).toBeNull();
    expect(pickAutoApplySetup([older], 'http://notx.test/')).toBeNull();
  });

  it('matches IDN hosts through their punycode form', () => {
    const idn = setup('idn', { sites: [normalizeHostPattern('bücher.de')!] });
    expect(pickAutoApplySetup([idn], 'https://bücher.de/')?.setup.id).toBe('idn');
    expect(pickAutoApplySetup([idn], 'https://xn--bcher-kva.de/')?.setup.id).toBe('idn');
  });

  it('decideAutoApply: nothing when already active; offer instead of overwriting unsaved changes', () => {
    const a = setup('a', { sites: ['x.test'] });
    const b = setup('b', { config: { listTypes: ['doc'], listRules: [] } });
    const url = 'http://x.test/';
    expect(decideAutoApply([a, b], baseState({ activeSetupId: 'a' }), url)).toEqual({ kind: 'none' });
    expect(decideAutoApply([a, b], baseState(), url)).toEqual({ kind: 'apply', setup: a, host: 'x.test' });
    // b active and unmodified (types = doc): apply a.
    expect(decideAutoApply([a, b], baseState({ activeSetupId: 'b', listTypes: ['doc'] }), url).kind).toBe('apply');
    // b active but modified: only offer.
    expect(decideAutoApply([a, b], baseState({ activeSetupId: 'b', listTypes: ['img'] }), url)).toEqual({ kind: 'offer', setup: a, host: 'x.test' });
    expect(decideAutoApply([a, b], baseState(), 'http://y.test/')).toEqual({ kind: 'none' });
  });
});

// ------------------------------------------------------------------------------------------- capture / apply

describe('capture, apply, modified', () => {
  it('captures types, rules and (optionally) the replay mode', () => {
    const state = baseState({ listTypes: ['img', 'fetch'], listRules: [rule('r1')], defaultMode: 'extension' });
    const config = captureConfig(state);
    expect(config).toEqual({ listTypes: ['fetch', 'img'], listRules: [rule('r1')], defaultMode: 'extension' });
    expect(config.listRules[0]).not.toBe(state.listRules[0]);
    expect(captureConfig(state, { includeMode: false })).not.toHaveProperty('defaultMode');
  });

  it('createSetup validates; empty names are refused', () => {
    const config = captureConfig(baseState());
    expect(createSetup({ name: '  ', config }, { id: 'x', now: 1 })).toBeNull();
    expect(createSetup({ name: ' A ', group: ' G ', sites: ['X.test', '??'], config }, { id: 'x', now: 7 })).toEqual({
      id: 'x',
      name: 'A',
      group: 'G',
      sites: ['x.test'],
      config,
      createdAt: 7,
      updatedAt: 7,
    });
  });

  it('applying replaces types + rules (fresh ids) + mode when stored, and marks the setup active', () => {
    const s = setup('a', { config: { listTypes: ['doc'], listRules: [rule('r1'), methodRule('r2', 'OPTIONS')], defaultMode: 'extension' } });
    const patch = applySetupPatch(s, { now: 99, newId });
    expect(patch.activeSetupId).toBe('a');
    expect(patch.listTypes).toEqual(['doc']);
    expect(patch.defaultMode).toBe('extension');
    expect(patch.listRules.map((r) => r.id)).not.toContain('r1');
    expect(new Set(patch.listRules.map((r) => r.id)).size).toBe(2);
    expect(patch.listRules.every((r) => r.createdAt === 99)).toBe(true);
    expect(patch.listRules[1]).toMatchObject({ method: 'OPTIONS', mode: 'hide' });
    expect(applySetupPatch(setup('b'), { now: 1, newId })).not.toHaveProperty('defaultMode');
  });

  it('restorePatch puts back the previous configuration and active setup', () => {
    const before = baseState({ listTypes: [], listRules: [rule('r9')], defaultMode: 'extension', activeSetupId: 'old' });
    expect(restorePatch(before)).toEqual({ listTypes: [], listRules: [rule('r9')], defaultMode: 'extension', activeSetupId: 'old' });
  });

  it('modified: rule ids / order / timestamps do not count; types, rules, enabled flags and a stored mode do', () => {
    const s = setup('a', { config: { listTypes: ['fetch'], listRules: [rule('r1'), methodRule('r2', 'OPTIONS')], defaultMode: 'page' } });
    const applied = applySetupPatch(s, { now: 5, newId });
    const state = baseState({ ...applied, defaultMode: 'page' });
    expect(isModified([s], state)).toBe(false);
    expect(isModified([s], { ...state, listRules: [...state.listRules].reverse() })).toBe(false);
    expect(isModified([s], { ...state, listTypes: [] })).toBe(true);
    expect(isModified([s], { ...state, listRules: state.listRules.slice(1) })).toBe(true);
    expect(isModified([s], { ...state, listRules: state.listRules.map((r) => ({ ...r, enabled: false })) })).toBe(true);
    expect(isModified([s], { ...state, defaultMode: 'extension' })).toBe(true);
    // Canonical patterns: same URL spelled differently.
    expect(configMatches({ listTypes: ['fetch'], listRules: [rule('x', { pattern: 'https://API.example.com/health' })] }, captureConfig(baseState({ listRules: [rule('y')] })))).toBe(true);
    // A setup without a stored mode ignores the mode; no active setup → never modified.
    const noMode = setup('b');
    expect(isModified([noMode], baseState({ activeSetupId: 'b', defaultMode: 'extension' }))).toBe(false);
    expect(isModified([s], baseState({ listTypes: ['img'] }))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- grouping / labels

describe('grouping, search, summaries', () => {
  const list = [
    setup('1', { name: 'Zeta', group: 'Work' }),
    setup('2', { name: 'alpha', group: '' }),
    setup('3', { name: 'Beta', group: 'api' }),
    setup('4', { name: 'Setup 10', group: 'Work' }),
    setup('5', { name: 'Setup 2', group: 'Work', sites: ['staging.example.com'] }),
  ];

  it('ungrouped first, then groups by name; setups by name (numeric aware)', () => {
    expect(groupSetups(list).map((g) => [g.group, g.setups.map((s) => s.name)])).toEqual([
      ['', ['alpha']],
      ['api', ['Beta']],
      ['Work', ['Setup 2', 'Setup 10', 'Zeta']],
    ]);
    expect(groupNames(list)).toEqual(['api', 'Work']);
    expect(canonicalGroup(list, '  work ')).toBe('Work');
    expect(canonicalGroup(list, 'New')).toBe('New');
  });

  it('search matches name, group and sites (all terms)', () => {
    expect(searchSetups(list, 'work setup').map((s) => s.id)).toEqual(['4', '5']);
    expect(searchSetups(list, 'STAGING').map((s) => s.id)).toEqual(['5']);
    expect(searchSetups(list, '  ')).toHaveLength(5);
  });

  it('summary line', () => {
    const s = setup('a', {
      sites: ['a.test', 'b.test'],
      config: {
        listTypes: ['fetch'],
        listRules: [rule('1'), rule('2', { pattern: 'https://x/' }), rule('3', { pattern: 'https://y/' }), methodRule('4', 'OPTIONS')],
      },
    });
    expect(setupSummary(s)).toBe('Fetch/XHR · 3 rules · OPTIONS hidden · 2 sites');
    expect(
      setupSummary(
        setup('b', {
          config: { listTypes: [], listRules: [rule('1', { enabled: false }), methodRule('2', 'GET', 'only')], defaultMode: 'extension' },
          sites: ['x.test'],
        }),
      ),
    ).toBe('All types · 1 rule (1 off) · only GET · Extension mode · 1 site');
    expect(typesSummary(['fetch', 'doc'])).toBe('Fetch/XHR, Doc');
    expect(typesSummary(['fetch', 'doc', 'js'])).toBe('3 types');
  });
});

// ------------------------------------------------------------------------------------------- edits

describe('edits', () => {
  const list = [setup('a', { name: 'One', group: 'G', sites: ['x.test'] }), setup('b', { name: 'Two' })];

  it('rename / move / sites / config return the same array when nothing changes', () => {
    expect(renameSetup(list, 'a', '  One ', 5)).toBe(list);
    expect(renameSetup(list, 'a', '   ', 5)).toBe(list);
    expect(renameSetup(list, 'zz', 'X', 5)).toBe(list);
    const renamed = renameSetup(list, 'a', ' Uno ', 5);
    expect(renamed[0]).toMatchObject({ name: 'Uno', updatedAt: 5 });
    expect(renamed[1]).toBe(list[1]);
    expect(moveSetupToGroup(list, 'b', 'g', 6)[1]).toMatchObject({ group: 'G', updatedAt: 6 });
    expect(moveSetupToGroup(list, 'a', 'G', 6)).toBe(list);
    expect(setSetupSites(list, 'a', ['X.test'], 7)).toBe(list);
    expect(setSetupSites(list, 'a', ['y.test', 'bad host'], 7)[0]!.sites).toEqual(['y.test']);
    const updated = updateSetupConfig(list, 'b', { listTypes: ['img'], listRules: [rule('r')] }, 8);
    expect(updated[1]).toMatchObject({ config: { listTypes: ['img'], listRules: [rule('r')] }, updatedAt: 8 });
  });

  it('duplicate: right after the source, unique name, no sites', () => {
    const { setups, copy } = duplicateSetup(list, 'a', { id: 'c', now: 9 });
    expect(setups.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(copy).toMatchObject({ id: 'c', name: 'One copy', group: 'G', sites: [], createdAt: 9 });
    const again = duplicateSetup(setups, 'a', { id: 'd', now: 9 });
    expect(again.copy!.name).toBe('One copy 2');
    expect(uniqueName(list, 'two', '')).toBe('two 2');
    expect(uniqueName(list, 'Two', 'Other')).toBe('Two');
  });

  it('remove + restore at the old position', () => {
    const done = removeSetup(list, 'a');
    expect(done.setups.map((s) => s.id)).toEqual(['b']);
    expect(done.index).toBe(0);
    expect(restoreSetup(done.setups, done.removed!, done.index).map((s) => s.id)).toEqual(['a', 'b']);
    expect(restoreSetup(list, list[0]!, 1)).toBe(list);
    expect(removeSetup(list, 'zz').removed).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- export / import

describe('export / import', () => {
  const existing = [
    setup('a', { name: 'API', group: 'Work', sites: ['api.test'] }),
    setup('b', { name: 'Docs' }),
  ];

  it('round-trips through the JSON file format', () => {
    const text = exportSetups(existing);
    const data = JSON.parse(text);
    expect(Object.keys(data)).toEqual(['kind', 'version', 'setups']);
    expect(data).toMatchObject({ kind: 'kinereqlens-setups', version: 1 });
    const parsed = parseSetupsFile(text);
    expect(parsed).toEqual({ ok: true, setups: existing, invalid: 0 });
    expect(exportFileName([existing[0]!], new Date(2026, 9, 2))).toBe('kinereqlens-setup-api.json');
    expect(exportFileName(existing, new Date(2026, 9, 2))).toBe('kinereqlens-setups-2026-10-02.json');
  });

  it('refuses other files and counts invalid items', () => {
    expect(parseSetupsFile('{')).toMatchObject({ ok: false });
    expect(parseSetupsFile('[]')).toMatchObject({ ok: false });
    expect(parseSetupsFile(JSON.stringify({ kind: 'other', version: 1, setups: [] }))).toMatchObject({ ok: false });
    expect(parseSetupsFile(JSON.stringify({ kind: 'kinereqlens-setups', version: 2, setups: [] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('newer'),
    });
    expect(parseSetupsFile(JSON.stringify({ kind: 'kinereqlens-setups', version: 1 }))).toMatchObject({ ok: false });
    const parsed = parseSetupsFile(
      `﻿${JSON.stringify({
        kind: 'kinereqlens-setups',
        version: 1,
        setups: [{ name: 'No id', config: {} }, { id: 'x', name: '', config: {} }, 7, setup('ok')],
      })}`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.invalid).toBe(2);
    expect(parsed.setups.map((s) => s.name)).toEqual(['No id', 'Setup ok']);
    expect(parsed.setups[0]!.id).toBe('import-0');
  });

  it('merge: same name in the same group updates (keeps id), identical is unchanged, id collisions get fresh ids', () => {
    const incoming = [
      setup('zz', { name: 'api', group: 'work', sites: ['new.test'], updatedAt: 3 }), // updates a
      setup('b', { name: 'Docs' }), // identical to b
      setup('a', { name: 'Something else' }), // id taken → fresh id
      setup('q', { name: 'Brand new' }),
    ];
    const r = importSetups(existing, incoming, 'merge', { now: 100, newId });
    expect([r.added, r.updated, r.unchanged, r.dropped]).toEqual([2, 1, 1, 0]);
    expect(r.setups[0]).toMatchObject({ id: 'a', name: 'api', group: 'work', sites: ['new.test'], createdAt: 10, updatedAt: 100 });
    expect(r.setups[1]).toBe(existing[1]);
    const ids = r.setups.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.setups.find((s) => s.name === 'Something else')!.id).not.toBe('a');
    expect(r.setups.find((s) => s.name === 'Brand new')!.id).toBe('q');
    expect(importSummary(r)).toBe('2 new · 1 updated · 1 unchanged');
  });

  it('replace: the file becomes the list (duplicate ids renamed); the limit drops the rest', () => {
    const r = importSetups(existing, [setup('x', { name: 'X' }), setup('x', { name: 'Y' })], 'replace', { now: 1, newId });
    expect(r.setups.map((s) => s.name)).toEqual(['X', 'Y']);
    expect(new Set(r.setups.map((s) => s.id)).size).toBe(2);
    expect(r.added).toBe(2);
    const many = Array.from({ length: MAX_SETUPS + 3 }, (_, i) => setup(`m${i}`, { name: `M${i}` }));
    const merged = importSetups(existing, many, 'merge', { now: 1, newId });
    expect(merged.setups).toHaveLength(MAX_SETUPS);
    expect(merged.dropped).toBe(5);
    expect(importSummary(merged)).toContain('5 skipped');
  });
});
