// Request-list URL rules (src/ui/list/rules.ts) and the list state that persists them (src/ui/list/listState.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MAX_LIST_RULE_PATTERN, MAX_LIST_RULES, mergeSettings } from '../../src/shared/constants';
import type { ListRule, ReqlensBridge, RequestEntry, Settings, SettingsPatch } from '../../src/shared/types';
import {
  currentListRules,
  getRemovedEntries,
  pruneRemoved,
  removeFromList,
  restoreToList,
  updateListRules,
} from '../../src/ui/list/listState';
import {
  EXACT_SUFFIX,
  addRule,
  applyRules,
  canonicalPattern,
  compileRules,
  countMatches,
  findRule,
  isRuleExempt,
  isStorablePattern,
  matchesRule,
  pathPrefixes,
  patternText,
  prefixLabel,
  prefixText,
  removeRule,
  restoreRule,
  revertAddRule,
  ruleDescription,
  ruleLabel,
  sameRule,
  setRuleEnabled,
  shortenMiddle,
  shortenUrlText,
  toggleRule,
  type PathPrefix,
} from '../../src/ui/list/rules';

let seq = 0;
function entry(url: string, patch: Partial<RequestEntry> = {}): RequestEntry {
  seq += 1;
  return {
    id: `h:0:${seq}`,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.example.com/',
    method: 'GET',
    url,
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1_000 + seq,
    state: 'done',
    status: 200,
    ...patch,
  };
}

function rule(mode: ListRule['mode'], pattern: string, exact = false, patch: Partial<ListRule> = {}): ListRule {
  seq += 1;
  return { id: `r${seq}`, mode, pattern, exact, enabled: true, createdAt: seq, ...patch };
}

const patterns = (list: PathPrefix[]) => list.map((p) => (p.exact ? `${p.pattern} (exact)` : p.pattern));

const KINEBOT = 'https://api.kinebot.com.br/standard/custom-report/result/reports/list-all';

describe('pathPrefixes', () => {
  it('builds the ladder of the spec example (query ignored, exact last)', () => {
    expect(patterns(pathPrefixes(`${KINEBOT}?x=1`))).toEqual([
      'https://api.kinebot.com.br/',
      'https://api.kinebot.com.br/standard/',
      'https://api.kinebot.com.br/standard/custom-report/',
      'https://api.kinebot.com.br/standard/custom-report/result/',
      'https://api.kinebot.com.br/standard/custom-report/result/reports/',
      'https://api.kinebot.com.br/standard/custom-report/result/reports/list-all (exact)',
    ]);
    expect(pathPrefixes(KINEBOT)).toEqual(pathPrefixes(`${KINEBOT}?x=1#top`));
  });

  it('makes a trailing-slash path its own exact item', () => {
    expect(patterns(pathPrefixes('https://h.test/a/b/'))).toEqual([
      'https://h.test/',
      'https://h.test/a/',
      'https://h.test/a/b/ (exact)',
    ]);
  });

  it('gives just the origin for the root URL (with or without query / hash)', () => {
    for (const url of ['https://h.test', 'https://h.test/', 'https://h.test/?q=1', 'https://h.test/#x']) {
      expect(pathPrefixes(url)).toEqual([{ pattern: 'https://h.test/', exact: false }]);
    }
  });

  it('handles a single segment', () => {
    expect(patterns(pathPrefixes('http://h.test/ping'))).toEqual(['http://h.test/', 'http://h.test/ping (exact)']);
  });

  it('keeps non-default ports and drops default ones', () => {
    expect(patterns(pathPrefixes('https://h.test:8443/a/b'))).toEqual([
      'https://h.test:8443/',
      'https://h.test:8443/a/',
      'https://h.test:8443/a/b (exact)',
    ]);
    expect(pathPrefixes('https://h.test:443/a')[0]!.pattern).toBe('https://h.test/');
    expect(pathPrefixes('http://h.test:80/a')[0]!.pattern).toBe('http://h.test/');
  });

  it('supports IPv6 hosts (normalized)', () => {
    expect(patterns(pathPrefixes('http://[::1]:8080/api/v1/items'))).toEqual([
      'http://[::1]:8080/',
      'http://[::1]:8080/api/',
      'http://[::1]:8080/api/v1/',
      'http://[::1]:8080/api/v1/items (exact)',
    ]);
    expect(pathPrefixes('http://[0:0:0:0:0:0:0:1]/x')[0]!.pattern).toBe('http://[::1]/');
  });

  it('lower-cases scheme and host but keeps the path case', () => {
    expect(patterns(pathPrefixes('HTTPS://API.Example.COM/Users/List'))).toEqual([
      'https://api.example.com/',
      'https://api.example.com/Users/',
      'https://api.example.com/Users/List (exact)',
    ]);
  });

  it('normalizes percent-escapes and never splits on an escaped slash', () => {
    expect(patterns(pathPrefixes('https://h.test/caf%c3%a9/a%2fb/%7euser'))).toEqual([
      'https://h.test/',
      'https://h.test/caf%C3%A9/',
      'https://h.test/caf%C3%A9/a%2Fb/',
      'https://h.test/caf%C3%A9/a%2Fb/~user (exact)',
    ]);
    // A raw non-ASCII path is percent-encoded by the URL parser, so both spellings give the same ladder.
    expect(pathPrefixes('https://h.test/café/x')).toEqual(pathPrefixes('https://h.test/caf%C3%A9/x'));
  });

  it('resolves dot segments and keeps empty segments', () => {
    expect(patterns(pathPrefixes('https://h.test/a/./b/../c'))).toEqual(['https://h.test/', 'https://h.test/a/', 'https://h.test/a/c (exact)']);
    expect(patterns(pathPrefixes('https://h.test/a//b'))).toEqual([
      'https://h.test/',
      'https://h.test/a/',
      'https://h.test/a//',
      'https://h.test/a//b (exact)',
    ]);
  });

  it('never puts credentials into a pattern', () => {
    for (const p of pathPrefixes('https://user:secret@h.test/a/b')) expect(p.pattern).not.toContain('secret');
  });

  it('offers only an exact rule for non-http(s) URLs', () => {
    expect(pathPrefixes('data:text/plain,hello?x=1#y')).toEqual([{ pattern: 'data:text/plain,hello', exact: true }]);
    expect(pathPrefixes('blob:https://h.test/0b6e-11aa')).toEqual([{ pattern: 'blob:https://h.test/0b6e-11aa', exact: true }]);
    expect(pathPrefixes('about:blank')).toEqual([{ pattern: 'about:blank', exact: true }]);
    expect(pathPrefixes('DATA:image/png;base64,AAAA')).toEqual([{ pattern: 'data:image/png;base64,AAAA', exact: true }]);
    expect(pathPrefixes('ws://h.test/socket')).toEqual([{ pattern: 'ws://h.test/socket', exact: true }]);
  });

  it('copes with unparsable and empty URLs', () => {
    expect(pathPrefixes('not a url/x?y')).toEqual([{ pattern: 'not a url/x', exact: true }]);
    expect(pathPrefixes('')).toEqual([]);
  });
});

describe('matchesRule', () => {
  const prefix = { pattern: 'https://api.kinebot.com.br/standard/', exact: false };
  const exact = { pattern: KINEBOT, exact: true };

  it('matches a prefix and everything below it', () => {
    expect(matchesRule(entry('https://api.kinebot.com.br/standard/'), prefix)).toBe(true);
    expect(matchesRule(entry(KINEBOT), prefix)).toBe(true);
    expect(matchesRule(entry('https://api.kinebot.com.br/standard'), prefix)).toBe(false);
    expect(matchesRule(entry('https://api.kinebot.com.br/standardized/x'), prefix)).toBe(false);
    expect(matchesRule(entry('https://api.kinebot.com.br/other/standard/x'), prefix)).toBe(false);
  });

  it('matches an exact path with any query and hash', () => {
    expect(matchesRule(entry(KINEBOT), exact)).toBe(true);
    expect(matchesRule(entry(`${KINEBOT}?page=2&size=10#a`), exact)).toBe(true);
    expect(matchesRule(entry(`${KINEBOT}/more`), exact)).toBe(false);
    expect(matchesRule(entry(`${KINEBOT}/`), exact)).toBe(false);
  });

  it('treats a prefix written without its trailing slash as a directory', () => {
    const r = { pattern: 'https://h.test/api', exact: false };
    expect(matchesRule(entry('https://h.test/api'), r)).toBe(true);
    expect(matchesRule(entry('https://h.test/api/x'), r)).toBe(true);
    expect(matchesRule(entry('https://h.test/apis'), r)).toBe(false);
  });

  it('compares origins case-insensitively and paths case-sensitively', () => {
    expect(matchesRule(entry('https://API.Kinebot.com.br/standard/x'), prefix)).toBe(true);
    expect(matchesRule(entry('https://api.kinebot.com.br/Standard/x'), prefix)).toBe(false);
    expect(matchesRule(entry('https://h.test/a/b'), { pattern: 'HTTPS://H.TEST/a/', exact: false })).toBe(true);
  });

  it('requires the same scheme and port', () => {
    expect(matchesRule(entry('http://api.kinebot.com.br/standard/x'), prefix)).toBe(false);
    expect(matchesRule(entry('https://api.kinebot.com.br:8443/standard/x'), prefix)).toBe(false);
    expect(matchesRule(entry('https://api.kinebot.com.br:443/standard/x'), prefix)).toBe(true);
    expect(matchesRule(entry('https://sub.api.kinebot.com.br/standard/x'), prefix)).toBe(false);
  });

  it('matches the origin rule against every path of that origin', () => {
    const origin = { pattern: 'https://h.test/', exact: false };
    expect(matchesRule(entry('https://h.test'), origin)).toBe(true);
    expect(matchesRule(entry('https://h.test/a/b?c'), origin)).toBe(true);
    expect(matchesRule(entry('https://h.test.evil/a'), origin)).toBe(false);
  });

  it('treats equivalent percent-encodings as equal', () => {
    const r = { pattern: 'https://h.test/caf%C3%A9/', exact: false };
    expect(matchesRule(entry('https://h.test/café/menu'), r)).toBe(true);
    expect(matchesRule(entry('https://h.test/caf%c3%a9/menu'), r)).toBe(true);
    expect(matchesRule(entry('https://h.test/%7Euser/x'), { pattern: 'https://h.test/~user/', exact: false })).toBe(true);
    // An escaped slash is not a path separator.
    expect(matchesRule(entry('https://h.test/a%2Fb/x'), { pattern: 'https://h.test/a/', exact: false })).toBe(false);
  });

  it('matches IPv6 hosts', () => {
    expect(matchesRule(entry('http://[::1]:8080/api/x'), { pattern: 'http://[0::1]:8080/api/', exact: false })).toBe(true);
  });

  it('matches data: and blob: URLs only exactly (query / hash ignored)', () => {
    const data = { pattern: 'data:text/plain,hello', exact: true };
    expect(matchesRule(entry('data:text/plain,hello'), data)).toBe(true);
    expect(matchesRule(entry('data:text/plain,hello?x#y'), data)).toBe(true);
    expect(matchesRule(entry('data:text/plain,hello2'), data)).toBe(false);
    expect(matchesRule(entry('data:text/plain,hello'), { pattern: 'data:text/plain,hello', exact: false })).toBe(true);
    expect(matchesRule(entry('data:text/plain,hello-more'), { pattern: 'data:text/plain,hello', exact: false })).toBe(false);
    const blob = { pattern: 'blob:https://h.test/uuid', exact: true };
    expect(matchesRule(entry('blob:https://h.test/uuid'), blob)).toBe(true);
    expect(matchesRule(entry('https://h.test/uuid'), blob)).toBe(false);
    expect(matchesRule(entry('blob:https://h.test/uuid'), { pattern: 'https://h.test/', exact: false })).toBe(false);
  });

  it('ignores mode and enabled (pure URL match)', () => {
    expect(matchesRule(entry(KINEBOT), rule('only', 'https://api.kinebot.com.br/', false, { enabled: false }))).toBe(true);
  });
});

describe('compileRules / applyRules', () => {
  const a1 = entry('https://a.test/x/1');
  const a2 = entry('https://a.test/y/2');
  const b1 = entry('https://b.test/x/1');
  const manual = entry('https://a.test/x/manual', { kind: 'manual', source: 'manual' });
  const all = [a1, a2, b1, manual];

  it('keeps everything without enabled rules', () => {
    expect(applyRules(all, [])).toEqual(all);
    expect(applyRules(all, null)).toEqual(all);
    expect(applyRules(all, [rule('hide', 'https://a.test/', false, { enabled: false })])).toEqual(all);
    expect(compileRules([rule('hide', 'https://a.test/', false, { enabled: false })]).active).toBe(false);
  });

  it('hides entries matching a hide rule, never manual ones', () => {
    expect(applyRules(all, [rule('hide', 'https://a.test/x/')])).toEqual([a2, b1, manual]);
    expect(applyRules(all, [rule('hide', 'https://a.test/')])).toEqual([b1, manual]);
  });

  it('lists only entries matching some enabled only rule (plus manual ones)', () => {
    expect(applyRules(all, [rule('only', 'https://a.test/')])).toEqual([a1, a2, manual]);
    expect(applyRules(all, [rule('only', 'https://a.test/y/'), rule('only', 'https://b.test/')])).toEqual([a2, b1, manual]);
    expect(applyRules(all, [rule('only', 'https://a.test/y/'), rule('only', 'https://b.test/', false, { enabled: false })])).toEqual([a2, manual]);
  });

  it('lets hide rules win over only rules', () => {
    expect(applyRules(all, [rule('only', 'https://a.test/'), rule('hide', 'https://a.test/y/2', true)])).toEqual([a1, manual]);
  });

  it('exempts manual entries by kind or source', () => {
    expect(isRuleExempt(entry('https://a.test/', { kind: 'manual' }))).toBe(true);
    expect(isRuleExempt(entry('https://a.test/', { source: 'manual' }))).toBe(true);
    expect(isRuleExempt(a1)).toBe(false);
  });

  it('does not mutate its input', () => {
    const list = [a1, a2];
    const out = applyRules(list, [rule('hide', 'https://a.test/x/')]);
    expect(list).toEqual([a1, a2]);
    expect(out).not.toBe(list);
  });
});

describe('countMatches', () => {
  it('counts per pattern in one pass, excluding manual entries', () => {
    const list = [
      entry(`${KINEBOT}?a=1`),
      entry(`${KINEBOT}?a=2`),
      entry('https://api.kinebot.com.br/standard/other'),
      entry('https://api.kinebot.com.br/v2/x'),
      entry('https://elsewhere.test/standard/'),
      entry(KINEBOT, { kind: 'manual', source: 'manual' }),
    ];
    expect(countMatches(list, pathPrefixes(KINEBOT))).toEqual([4, 3, 2, 2, 2, 2]);
    expect(countMatches(list, [])).toEqual([]);
    expect(countMatches([], pathPrefixes(KINEBOT))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('rule editing', () => {
  const init = { id: 'new', now: 42 };

  it('adds a rule', () => {
    const r = addRule([], { mode: 'hide', pattern: 'https://h.test/a/', exact: false }, init);
    expect(r.outcome).toBe('added');
    expect(r.rules).toEqual([{ id: 'new', mode: 'hide', pattern: 'https://h.test/a/', exact: false, enabled: true, createdAt: 42 }]);
    expect(r.rule).toBe(r.rules[0]);
  });

  it('re-enables an identical disabled rule instead of duplicating it', () => {
    const existing = rule('hide', 'https://h.test/a/', false, { enabled: false });
    const other = rule('only', 'https://h.test/', false);
    const r = addRule([existing, other], { mode: 'hide', pattern: 'https://H.TEST/a/', exact: false }, init);
    expect(r.outcome).toBe('enabled');
    expect(r.rules).toHaveLength(2);
    expect(r.rules[0]).toEqual({ ...existing, enabled: true });
    expect(r.rules[1]).toBe(other);
    expect(existing.enabled).toBe(false); // not mutated
  });

  it('reports an identical enabled rule without changing anything', () => {
    const rules = [rule('hide', 'https://h.test/a/')];
    const r = addRule(rules, { mode: 'hide', pattern: 'https://h.test/a/', exact: false }, init);
    expect(r.outcome).toBe('exists');
    expect(r.rules).toBe(rules);
    expect(r.rule).toBe(rules[0]);
  });

  it('treats other modes / exact flags as different rules', () => {
    const rules = [rule('hide', 'https://h.test/a/')];
    expect(addRule(rules, { mode: 'only', pattern: 'https://h.test/a/', exact: false }, init).outcome).toBe('added');
    expect(addRule(rules, { mode: 'hide', pattern: 'https://h.test/a/', exact: true }, init).outcome).toBe('added');
  });

  it('refuses beyond MAX_LIST_RULES and over-long / empty patterns', () => {
    const many = Array.from({ length: MAX_LIST_RULES }, (_, i) => rule('hide', `https://h.test/${i}/`));
    const full = addRule(many, { mode: 'hide', pattern: 'https://h.test/new/', exact: false }, init);
    expect(full.outcome).toBe('limit');
    expect(full.rules).toBe(many);
    // ...but re-enabling an existing one still works at the limit.
    many[3] = { ...many[3]!, enabled: false };
    expect(addRule(many, { mode: 'hide', pattern: 'https://h.test/3/', exact: false }, init).outcome).toBe('enabled');
    const long = `https://h.test/${'a'.repeat(MAX_LIST_RULE_PATTERN)}`;
    expect(addRule([], { mode: 'hide', pattern: long, exact: true }, init).outcome).toBe('invalid');
    expect(addRule([], { mode: 'hide', pattern: '', exact: true }, init).outcome).toBe('invalid');
    expect(isStorablePattern('x'.repeat(MAX_LIST_RULE_PATTERN))).toBe(true);
    expect(isStorablePattern('x'.repeat(MAX_LIST_RULE_PATTERN + 1))).toBe(false);
  });

  it('undoes an add (removes an added rule, disables a re-enabled one)', () => {
    const added = addRule([], { mode: 'hide', pattern: 'https://h.test/a/', exact: false }, init);
    expect(revertAddRule(added.rules, added)).toEqual([]);
    const disabled = rule('only', 'https://h.test/', false, { enabled: false });
    const enabled = addRule([disabled], { mode: 'only', pattern: 'https://h.test/', exact: false }, init);
    expect(revertAddRule(enabled.rules, enabled)).toEqual([disabled]);
    const exists = addRule(enabled.rules, { mode: 'only', pattern: 'https://h.test/', exact: false }, init);
    expect(revertAddRule(exists.rules, exists)).toBe(exists.rules);
  });

  it('toggles, enables, removes and restores rules immutably', () => {
    const a = rule('hide', 'https://h.test/a/');
    const b = rule('only', 'https://h.test/');
    const rules = [a, b];
    const toggled = toggleRule(rules, a.id);
    expect(toggled[0]).toEqual({ ...a, enabled: false });
    expect(toggled[1]).toBe(b);
    expect(rules[0]).toBe(a);
    expect(setRuleEnabled(rules, a.id, true)).toBe(rules);
    expect(toggleRule(rules, 'missing')).toBe(rules);
    const without = removeRule(rules, a.id);
    expect(without).toEqual([b]);
    expect(removeRule(rules, 'missing')).toBe(rules);
    expect(restoreRule(without, a, 0)).toEqual([a, b]);
    expect(restoreRule(rules, a, 1)).toBe(rules);
    expect(restoreRule([], a, 5)).toEqual([a]);
  });

  it('compares rules by mode, exact and canonical pattern', () => {
    expect(sameRule({ mode: 'hide', pattern: 'https://H.test:443/a/', exact: false }, { mode: 'hide', pattern: 'https://h.test/a/', exact: false })).toBe(true);
    expect(sameRule({ mode: 'hide', pattern: 'https://h.test/a/', exact: false }, { mode: 'hide', pattern: 'https://h.test/A/', exact: false })).toBe(false);
    expect(canonicalPattern('https://h.test/caf%c3%a9')).toBe('https://h.test/caf%C3%A9');
    const rules = [rule('hide', 'https://h.test/a/'), rule('hide', 'https://h.test/a/', true)];
    expect(findRule(rules, { mode: 'hide', pattern: 'https://h.test/a/', exact: true })).toBe(rules[1]);
    expect(findRule(rules, { mode: 'only', pattern: 'https://h.test/a/', exact: true })).toBeUndefined();
  });
});

describe('labels', () => {
  it('shortens in the middle without splitting code points', () => {
    expect(shortenMiddle('abcdefghij', 20)).toBe('abcdefghij');
    expect(shortenMiddle('abcdefghij', 5)).toBe('ab…ij');
    expect(shortenMiddle('😀😀😀😀😀😀', 4)).toBe('😀😀…😀');
    expect(Array.from(shortenMiddle('😀'.repeat(50), 9))).toHaveLength(9);
  });

  it('shortens URLs by dropping middle segments, keeping host and tail', () => {
    expect(shortenUrlText('api.kinebot.com.br/standard/custom-report/result/reports/list-all', 48)).toBe(
      'api.kinebot.com.br/…/result/reports/list-all',
    );
    expect(shortenUrlText('https://h.test/a/b/c/', 19)).toBe('https://h.test/…/c/');
    expect(shortenUrlText('https://h.test/a/b/c/', 18)).toHaveLength(18);
    expect(shortenUrlText('short.test/a', 40)).toBe('short.test/a');
    // A tail that alone does not fit falls back to middle truncation.
    const long = `h.test/${'x'.repeat(80)}`;
    expect(Array.from(shortenUrlText(long, 30))).toHaveLength(30);
    expect(shortenUrlText(long, 30)).toContain('…');
  });

  it('labels ladder items with the full URL, exact ones suffixed', () => {
    const [origin, , , , , exact] = pathPrefixes(KINEBOT);
    expect(prefixLabel(origin!)).toBe('https://api.kinebot.com.br/');
    expect(prefixText(exact!)).toBe(KINEBOT); // the spec's example fits in full
    expect(prefixLabel(exact!)).toBe(`${KINEBOT} ${EXACT_SUFFIX}`);
    expect(prefixText(exact!, 40)).toBe('https://api.kinebot.com.br/…/list-all');
    expect(prefixLabel({ pattern: 'https://h.test/caf%C3%A9/', exact: false })).toBe('https://h.test/café/');
  });

  it('labels rule chips', () => {
    expect(ruleLabel({ mode: 'hide', pattern: 'https://api.kinebot.com.br/standard/', exact: false })).toBe(
      'Hidden: api.kinebot.com.br/standard/…',
    );
    expect(ruleLabel({ mode: 'only', pattern: 'https://api.kinebot.com.br/', exact: false })).toBe('Only: api.kinebot.com.br/…');
    expect(ruleLabel({ mode: 'only', pattern: 'https://h.test/a/list', exact: true })).toBe('Only: h.test/a/list');
    expect(ruleLabel({ mode: 'hide', pattern: 'http://localhost:3000/api/', exact: false })).toBe('Hidden: http://localhost:3000/api/…');
    expect(ruleLabel({ mode: 'hide', pattern: 'data:text/plain,hi', exact: true })).toBe('Hidden: data:text/plain,hi');
    const long = ruleLabel({ mode: 'hide', pattern: `${KINEBOT}/a/b/c/d`, exact: false }, 40);
    expect(long.startsWith('Hidden: api.kinebot.com.br/…/')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
  });

  it('describes rules', () => {
    expect(ruleDescription({ mode: 'hide', pattern: 'https://h.test/a/', exact: false })).toBe('Hide requests under https://h.test/a/');
    expect(ruleDescription({ mode: 'only', pattern: 'https://h.test/a', exact: true }, 'progressive')).toBe(
      `Showing only requests to https://h.test/a ${EXACT_SUFFIX}`,
    );
    expect(patternText('https://h.test/a%20b/')).toBe('h.test/a b/');
    expect(patternText('https://h.test/a%2Fb/', true)).toBe('https://h.test/a%2Fb/');
  });
});

// ------------------------------------------------------------------------------------------- list state

function fakeBridge(write: (patch: SettingsPatch) => Promise<Settings>): ReqlensBridge & { settings: Settings } {
  const b = {
    settings: mergeSettings(DEFAULT_SETTINGS, null),
    getSettings() {
      return b.settings;
    },
    updateSettings: (patch: SettingsPatch) => write(patch),
  };
  return b as unknown as ReqlensBridge & { settings: Settings };
}

describe('list rules state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies edits at once and keeps the pending value until every write settled', async () => {
    const resolvers: Array<() => void> = [];
    const bridge = fakeBridge(
      (patch) =>
        new Promise<Settings>((resolve) =>
          resolvers.push(() => {
            bridge.settings = mergeSettings(bridge.settings, patch);
            resolve(bridge.settings);
          }),
        ),
    );
    const a = rule('hide', 'https://h.test/a/');
    const b = rule('hide', 'https://h.test/b/');
    updateListRules(bridge, (rules) => [...rules, a]);
    updateListRules(bridge, (rules) => [...rules, b]); // builds on the pending value, not on stale settings
    expect(currentListRules(bridge)).toEqual([a, b]);
    resolvers[0]!();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(currentListRules(bridge)).toEqual([a, b]); // second write still pending
    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.settings.listRules).toEqual([a, b]);
    expect(currentListRules(bridge)).toBe(bridge.settings.listRules);
  });

  it('writes nothing when the edit changes nothing', () => {
    const write = vi.fn(() => Promise.resolve(DEFAULT_SETTINGS));
    const bridge = fakeBridge(write);
    const out = updateListRules(bridge, (rules) => rules);
    expect(out).toBe(bridge.settings.listRules);
    expect(write).not.toHaveBeenCalled();
  });

  it('falls back to the stored rules when a write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge = fakeBridge(() => Promise.reject(new Error('storage full')));
    updateListRules(bridge, (rules) => [...rules, rule('only', 'https://h.test/')]);
    expect(currentListRules(bridge)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(currentListRules(bridge)).toEqual([]);
  });
});

describe('removed entries', () => {
  afterEach(() => restoreToList());

  it('removes, restores and prunes ids with a new set per change', () => {
    const before = getRemovedEntries();
    removeFromList(['a', 'b']);
    const after = getRemovedEntries();
    expect(after).not.toBe(before);
    expect([...after]).toEqual(['a', 'b']);
    removeFromList(['a']);
    expect(getRemovedEntries()).toBe(after); // nothing new
    restoreToList(['a']);
    expect([...getRemovedEntries()]).toEqual(['b']);
    removeFromList(['c']);
    pruneRemoved(new Set(['c', 'x']));
    expect([...getRemovedEntries()]).toEqual(['c']);
    const pruned = getRemovedEntries();
    pruneRemoved(new Set(['c']));
    expect(getRemovedEntries()).toBe(pruned);
    restoreToList();
    expect(getRemovedEntries().size).toBe(0);
  });
});
