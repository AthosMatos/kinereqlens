import { describe, expect, it } from 'vitest';
import type { ListRule, RequestEntry } from '../../src/shared/types';
import { addRule, applyRules, countMatches, ruleLabel, sameRule } from '../../src/ui/list/rules';
import { sanitizeSettings } from '../../src/content/settings';

const entry = (id: string, method: string, url = 'https://api.example.com/a'): RequestEntry => ({
  id, source: 'hook', kind: 'fetch', frameId: 0, pageUrl: '', method, url, requestHeaders: [],
  requestBody: null, requestContentType: null, startTime: 1, state: 'done',
});
const rule = (mode: ListRule['mode'], method: string, enabled = true): ListRule => ({
  id: `${mode}-${method}`, mode, pattern: '', method, exact: true, enabled, createdAt: 0,
});

describe('method rules', () => {
  const list = [entry('1', 'GET'), entry('2', 'OPTIONS'), entry('3', 'POST'), entry('4', 'options')];

  it('hides a method (case-insensitive on the entry)', () => {
    expect(applyRules(list, [rule('hide', 'OPTIONS')]).map((e) => e.id)).toEqual(['1', '3']);
  });

  it('show-only methods are alternatives', () => {
    expect(applyRules(list, [rule('only', 'GET'), rule('only', 'POST')]).map((e) => e.id)).toEqual(['1', '3']);
  });

  it('combines with URL only-rules (both dimensions must pass)', () => {
    const urlOnly: ListRule = { id: 'u', mode: 'only', pattern: 'https://api.example.com/b', exact: true, enabled: true, createdAt: 0 };
    const mixed = [...list, entry('5', 'GET', 'https://api.example.com/b')];
    expect(applyRules(mixed, [urlOnly, rule('only', 'GET')]).map((e) => e.id)).toEqual(['5']);
  });

  it('counts, dedupes and labels', () => {
    expect(countMatches(list, [{ pattern: '', exact: true, method: 'OPTIONS' }])).toEqual([2]);
    const first = addRule([], { mode: 'hide', pattern: '', exact: true, method: 'GET' }, { id: 'a', now: 1 });
    expect(first.rule?.method).toBe('GET');
    expect(addRule(first.rules, { mode: 'hide', pattern: '', exact: true, method: 'GET' }, { id: 'b', now: 2 }).outcome).toBe('exists');
    expect(sameRule(rule('hide', 'GET'), rule('hide', 'POST'))).toBe(false);
    expect(ruleLabel(rule('only', 'POST'))).toBe('Only: POST requests');
  });

  it('survives the settings sanitizer; invalid methods are dropped', () => {
    const s = sanitizeSettings({ listRules: [rule('hide', 'OPTIONS'), { ...rule('hide', 'bad method'), id: 'x' }] });
    expect(s.listRules).toHaveLength(1);
    expect(s.listRules[0]).toMatchObject({ method: 'OPTIONS', pattern: '' });
  });
});
