import { describe, expect, it } from 'vitest';
import { sanitizeListRules } from '../../src/shared/setups';
import type { ListRule, RequestEntry } from '../../src/shared/types';
import {
  aggregateGroup,
  buildEndpointTemplate,
  concreteTemplate,
  elideSegments,
  endpointTemplate,
  groupKeyOf,
  groupListRows,
  inlineHostFlags,
  isTemplateKey,
  itemsCost,
  layoutLabel,
  queryNames,
  segmentText,
  summarizeQuery,
  summaryCost,
  templateKeyOf,
  templateText,
  valueKind,
  type DisplayItem,
  type EndpointTemplate,
} from '../../src/ui/list/endpointLabel';
import { activeRowKey, buildListModel, moveRowKey, type ListRow } from '../../src/ui/list/filter';
import { buildGroupMenu } from '../../src/ui/list/rowMenu';
import { addRule, compileRules, countMatches, ruleDescription, ruleLabel, sameRule, templatePrefixes } from '../../src/ui/list/rules';

const UUID = '9f3c1a2e-4b5d-4c6e-8f70-1a2b3c4d5e6f';
const LONG = `https://api.example.com/standard/custom-report/result/reports/${UUID}/items/123456?companyId=42&token=abc&page=2&sort=name`;

let seq = 0;
function entry(patch: Partial<RequestEntry> = {}): RequestEntry {
  seq += 1;
  return {
    id: `h:0:${seq}`,
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.example.com/',
    method: 'GET',
    url: `https://api.example.com/items/${seq}`,
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1_000 + seq,
    endTime: 1_100 + seq,
    state: 'done',
    status: 200,
    ...patch,
  };
}

/** The laid-out path as text ("/a/…/{id}"). */
function pathText(t: EndpointTemplate, items: DisplayItem[]): string {
  return `/${items.map((i) => (i.type === 'gap' ? '…' : segmentText(t.segments[i.index]!))).join('/')}`;
}

const allRows = (entries: RequestEntry[]) => buildListModel(entries, { text: '', chips: new Set() }).rows;

describe('endpoint templates', () => {
  it('turns ids into params of a kind and keeps literal segments', () => {
    const t = buildEndpointTemplate(LONG);
    expect(t.http).toBe(true);
    expect(t.host).toBe('api.example.com');
    expect(t.path).toBe('/standard/custom-report/result/reports/{uuid}/items/{id}');
    expect(t.key).toBe('https://api.example.com/standard/custom-report/result/reports/{uuid}/items/{id}');
    expect(templateText(t)).toBe('api.example.com/standard/custom-report/result/reports/{uuid}/items/{id}');
    const params = t.segments.filter((s) => s.type === 'param');
    expect(params).toEqual([
      { type: 'param', kind: 'uuid', value: UUID, prefix: '', suffix: '' },
      { type: 'param', kind: 'integer', value: '123456', prefix: '', suffix: '' },
    ]);
  });

  it('classifies query values: numeric-only, hashes and tokens are id-like', () => {
    const t = buildEndpointTemplate('https://h.test/x?companyId=42&q=hello&h=9f3c1a2e&d=2024-05-01&flag');
    expect(t.query.map((q) => [q.name, q.kind])).toEqual([
      ['companyId', 'integer'],
      ['q', null],
      ['h', 'hash'],
      ['d', 'date'],
      ['flag', null],
    ]);
    expect(valueKind('123')).toBe('integer');
    expect(valueKind('v2')).toBeNull();
    expect(valueKind('reports')).toBeNull();
  });

  it('detects short hex hashes, long tokens, JWTs and content hashes in file names', () => {
    expect(buildEndpointTemplate('https://h.test/commits/9f3c1a2e/files').path).toBe('/commits/{hash}/files');
    expect(buildEndpointTemplate('https://h.test/s/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9').path).toBe('/s/{token}');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(buildEndpointTemplate(`https://h.test/verify/${jwt}`).path).toBe('/verify/{token}');
    const file = buildEndpointTemplate('https://cdn.test/assets/main.3f9a8c1d.js');
    expect(file.path).toBe('/assets/main.{hash}.js');
    expect(file.segments[1]).toEqual({ type: 'param', kind: 'hash', value: '3f9a8c1d', prefix: 'main.', suffix: '.js' });
    expect(buildEndpointTemplate('https://cdn.test/assets/index-B7xK2lQp.css').path).toBe('/assets/index-{hash}.css');
    // Plain words, versions and readable file names stay literal.
    expect(buildEndpointTemplate('https://h.test/api/v2/users/me').path).toBe('/api/v2/users/me');
    expect(buildEndpointTemplate('https://h.test/oauth2callback').path).toBe('/oauth2callback');
    expect(buildEndpointTemplate('https://cdn.test/react-dom.production.min.js').path).toBe('/react-dom.production.min.js');
    expect(buildEndpointTemplate('https://h.test/deadbeef').path).toBe('/deadbeef');
  });

  it('keeps empty segments, trailing slashes and the root', () => {
    expect(buildEndpointTemplate('https://h.test/').path).toBe('/');
    expect(buildEndpointTemplate('https://h.test/a//b/').path).toBe('/a//b/');
    expect(buildEndpointTemplate('https://h.test/users/12/').path).toBe('/users/{id}/');
  });

  it('labels non-http URLs without a template', () => {
    const t = buildEndpointTemplate('data:image/png;base64,AAAA');
    expect(t.http).toBe(false);
    expect(t.label).toBe('data:image/png');
    expect(t.key).toBe('data:image/png');
    expect(buildEndpointTemplate('not a url').label).toBe('not a url');
  });

  it('caches by URL', () => {
    expect(endpointTemplate(LONG)).toBe(endpointTemplate(LONG));
    expect(templateKeyOf(LONG)).toBe(buildEndpointTemplate(LONG).key);
  });

  it('validates stored template keys', () => {
    expect(isTemplateKey('https://h.test/a/{id}')).toBe(true);
    expect(isTemplateKey('https://h.test/')).toBe(true);
    expect(isTemplateKey('https://h.test')).toBe(false);
    expect(isTemplateKey('https://h.test/a?x=1')).toBe(false);
    expect(isTemplateKey('ftp://h.test/a')).toBe(false);
    expect(isTemplateKey(42)).toBe(false);
  });
});

describe('concrete templates (calls under a group)', () => {
  it('show shortened values in the chips and id-like query values', () => {
    const t = buildEndpointTemplate(LONG);
    const c = concreteTemplate(t);
    expect(c).toBe(concreteTemplate(t));
    expect(c.key).toBe(t.key);
    expect(c.segments.filter((s) => s.type === 'param').map(segmentText)).toEqual(['9f3c1a2e…', '123456']);
    const l = layoutLabel(c, 200);
    expect(l.query!.shown.map((q) => q.label)).toEqual(['companyId=42', 'token', 'page=2', 'sort']);
    expect(summaryCost(l.query!)).toBe('?companyId=42 · token · page=2 · sort'.length);
  });
});

describe('elision', () => {
  const t = buildEndpointTemplate(LONG);
  const full = '/standard/custom-report/result/reports/{uuid}/items/{id}';

  it('shows everything when it fits', () => {
    const items = elideSegments(t.segments, 200);
    expect(pathText(t, items)).toBe(full);
    expect(itemsCost(t.segments, items)).toBeLessThanOrEqual(200);
  });

  it('keeps the last meaningful segments, then the first after the host, then more of the tail', () => {
    expect(pathText(t, elideSegments(t.segments, 40))).toBe('/standard/…/reports/{uuid}/items/{id}');
    expect(pathText(t, elideSegments(t.segments, 30))).toBe('/…/reports/{uuid}/items/{id}');
    expect(pathText(t, elideSegments(t.segments, 20))).toBe('/…/items/{id}');
    expect(pathText(t, elideSegments(t.segments, 5))).toBe('/…/{id}');
    for (const budget of [20, 30, 40, 50]) {
      expect(itemsCost(t.segments, elideSegments(t.segments, budget))).toBeLessThanOrEqual(budget);
    }
  });

  it('records the hidden segments of the gap', () => {
    const items = elideSegments(t.segments, 40);
    expect(items[1]).toEqual({ type: 'gap', hidden: [1, 2] });
  });

  it('handles single and empty paths', () => {
    const one = buildEndpointTemplate('https://h.test/a-very-long-segment-name-indeed');
    expect(pathText(one, elideSegments(one.segments, 5))).toBe('/a-very-long-segment-name-indeed');
    expect(elideSegments([], 10)).toEqual([]);
  });
});

describe('query summary', () => {
  const t = buildEndpointTemplate('https://h.test/x?companyId=1&page=2&token=abc&sort=name&list=a&list=b');

  it('groups values by name', () => {
    expect(queryNames(t.query).map((q) => [q.name, q.values, q.idLike])).toEqual([
      ['companyId', ['1'], true],
      ['page', ['2'], true],
      ['token', ['abc'], false],
      ['sort', ['name'], false],
      ['list', ['a', 'b'], false],
    ]);
  });

  it('shows as many names as fit, then "N more"', () => {
    const s = summarizeQuery(t.query, 26)!;
    expect(s.shown.map((q) => q.name)).toEqual(['companyId', 'page']);
    expect(s.more).toBe(3);
    expect(summaryCost(s)).toBeLessThanOrEqual(26);
    expect(summarizeQuery(t.query, 1)!.shown.map((q) => q.name)).toEqual(['companyId']);
    expect(summarizeQuery(t.query, 200)!.more).toBe(0);
    expect(summarizeQuery([], 10)).toBeNull();
  });
});

describe('layoutLabel', () => {
  const t = buildEndpointTemplate(LONG);

  it('fits path + query + host within the budget', () => {
    const wide = layoutLabel(t, 200, true);
    expect(wide.host).toBe(true);
    expect(wide.query!.more).toBe(0);
    expect(pathText(t, wide.items)).toBe('/standard/custom-report/result/reports/{uuid}/items/{id}');

    // The path's meaningful tail first, then the first query name, then the host.
    const mid = layoutLabel(t, 64, true);
    expect(mid.host).toBe(true);
    expect(pathText(t, mid.items)).toBe('/…/reports/{uuid}/items/{id}');
    expect(mid.query!.shown.map((q) => q.name)).toEqual(['companyId']);
    expect(mid.query!.more).toBe(3);
    const hostCost = Math.ceil(t.host.length * 0.8) + 2;
    expect(itemsCost(t.segments, mid.items) + summaryCost(mid.query!) + hostCost).toBeLessThanOrEqual(64);

    // Tighter: the host goes, the query shrinks to a count, the path keeps its tail.
    const narrow = layoutLabel(t, 48, true);
    expect(narrow.host).toBe(false);
    expect(narrow.query).toMatchObject({ shown: [], more: 4 });
    expect(summaryCost(narrow.query!)).toBe('?4 params'.length);
    expect(pathText(t, narrow.items)).toBe('/…/result/reports/{uuid}/items/{id}');
    expect(itemsCost(t.segments, narrow.items) + summaryCost(narrow.query!)).toBeLessThanOrEqual(48);

    // Tightest: "?4" and the last literal; a cut tail never keeps the first segment.
    const tiny = layoutLabel(t, 18, true);
    expect(tiny.query).toMatchObject({ shown: [], more: 4, mini: true });
    expect(pathText(t, tiny.items)).toBe('/…/items/{id}');
    const cut = elideSegments(t.segments, 24);
    expect(pathText(t, cut)).toBe('/…/{uuid}/items/{id}');

    const tight = layoutLabel(t, 24, true);
    expect(tight.host).toBe(false);
    expect(pathText(t, tight.items)).toBe('/…/items/{id}');
    expect(itemsCost(t.segments, tight.items) + summaryCost(tight.query!)).toBeLessThanOrEqual(24);
  });

  it('gives the path priority over the query', () => {
    const short = buildEndpointTemplate('https://h.test/a/b?alpha=1&beta=2&gamma=3&delta=4&epsilon=5');
    const l = layoutLabel(short, 30);
    expect(pathText(short, l.items)).toBe('/a/b');
    expect(l.query!.shown.length).toBeGreaterThan(1);
  });
});

describe('grouping', () => {
  it('keys on method + host + path template (ids, query and hash ignored)', () => {
    const a = groupKeyOf({ method: 'GET', url: `https://api.example.com/reports/${UUID}/items/1?x=1` });
    const b = groupKeyOf({ method: 'get', url: 'https://api.example.com/reports/0b3c1a2e-4b5d-4c6e-8f70-1a2b3c4d5e6f/items/22#h' });
    expect(a).toBe(b);
    expect(groupKeyOf({ method: 'POST', url: 'https://api.example.com/reports/x' })).not.toBe(
      groupKeyOf({ method: 'GET', url: 'https://api.example.com/reports/x' }),
    );
    expect(groupKeyOf({ method: 'GET', url: 'https://other.example.com/items/1' })).not.toBe(
      groupKeyOf({ method: 'GET', url: 'https://api.example.com/items/1' }),
    );
  });

  it('aggregates count, outcomes, durations and times', () => {
    const calls = [
      entry({ startTime: 100, endTime: 150, status: 200 }),
      entry({ startTime: 200, endTime: 300, status: 500 }),
      entry({ startTime: 300, endTime: undefined, state: 'pending', status: undefined }),
      entry({ startTime: 250, endTime: 280, status: 201 }),
    ];
    const s = aggregateGroup(calls);
    expect(s.count).toBe(4);
    expect(s.pending).toBe(1);
    expect(s.outcomes).toEqual([
      { outcome: '2xx', count: 2 },
      { outcome: '5xx', count: 1 },
    ]);
    expect(s.mixed).toBe(true);
    expect(s.avgMs).toBe(60);
    expect(s.lastMs).toBe(30); // the newest finished call (startTime 250)
    expect(s.newestTime).toBe(300);
    expect(s.oldestTime).toBe(100);
    expect(aggregateGroup([entry({ status: 200 }), entry({ status: 204 })]).mixed).toBe(false);
    expect(aggregateGroup([entry({ state: 'error', status: 200 }), entry({ status: 200 })]).mixed).toBe(true);
  });

  it('collapses calls of one endpoint into a group row at the newest call', () => {
    const e1 = entry({ url: 'https://api.example.com/items/1', startTime: 10 });
    const other = entry({ url: 'https://api.example.com/users/me', startTime: 20 });
    const e2 = entry({ url: 'https://api.example.com/items/2', startTime: 30 });
    const post = entry({ method: 'POST', url: 'https://api.example.com/items/3', startTime: 40 });
    const rows = groupListRows(allRows([e1, other, e2, post]), { expanded: new Set() });
    expect(rows.map((r) => (r.type === 'group' ? `group ${r.group.entries.map((e) => e.id).join(',')}` : r.key))).toEqual([
      post.id,
      `group ${e2.id},${e1.id}`,
      other.id,
    ]);
    const group = rows[1] as Extract<ListRow, { type: 'group' }>;
    expect(group.group.newest).toBe(e2);
    expect(group.group.template.path).toBe('/items/{id}');
    expect(rows.map((r) => (r.type === 'separator' ? 0 : r.ordinal))).toEqual([1, 2, 3]);

    const open = groupListRows(allRows([e1, other, e2, post]), { expanded: new Set([group.key]) });
    expect(open.map((r) => r.key)).toEqual([post.id, group.key, e2.id, e1.id, other.id]);
    expect(open.filter((r) => r.type === 'entry' && r.group === group.key)).toHaveLength(2);
    expect(open.map((r) => (r.type === 'separator' ? 0 : r.ordinal))).toEqual([1, 2, 3, 4, 5]);
  });

  it('groups per section and never groups manual or kept-hidden entries', () => {
    const cur1 = entry({ url: 'https://api.example.com/items/1' });
    const cur2 = entry({ url: 'https://api.example.com/items/2' });
    const old1 = entry({ url: 'https://api.example.com/items/3', restored: true, pageUrl: 'https://app.example.com/old' });
    const old2 = entry({ url: 'https://api.example.com/items/4', restored: true, pageUrl: 'https://app.example.com/old' });
    const manual1 = entry({ kind: 'manual', source: 'manual', url: 'https://api.example.com/items/5' });
    const manual2 = entry({ kind: 'manual', source: 'manual', url: 'https://api.example.com/items/6' });
    const rows = groupListRows(allRows([cur1, cur2, old1, old2, manual1, manual2]), { expanded: new Set() });
    expect(rows.map((r) => r.type)).toEqual(['entry', 'entry', 'group', 'separator', 'group']);
    expect(new Set(rows.filter((r) => r.type === 'group').map((r) => r.key)).size).toBe(2);

    // A selected entry hidden by a rule stays a plain row.
    const rule: ListRule = { id: 'r', mode: 'hide', pattern: 'https://api.example.com/items/1', exact: true, enabled: true, createdAt: 0 };
    const model = buildListModel([cur1, cur2], { text: '', chips: new Set() }, cur1.id, { rules: [rule] });
    expect(groupListRows(model.rows, { expanded: new Set() }).map((r) => r.type)).toEqual(['entry', 'entry']);
  });

  it('cursor helpers walk groups and calls', () => {
    const e1 = entry({ url: 'https://api.example.com/items/1', startTime: 10 });
    const e2 = entry({ url: 'https://api.example.com/items/2', startTime: 30 });
    const single = entry({ url: 'https://api.example.com/users/me', startTime: 20 });
    const collapsed = groupListRows(allRows([e1, e2, single]), { expanded: new Set() });
    const gKey = collapsed[0]!.key;
    // A call inside a collapsed group shows as the group.
    expect(activeRowKey(collapsed, e1.id)).toBe(gKey);
    expect(activeRowKey(collapsed, single.id)).toBe(single.id);
    expect(activeRowKey(collapsed, null)).toBeNull();
    const expanded = groupListRows(allRows([e1, e2, single]), { expanded: new Set([gKey]) });
    expect(activeRowKey(expanded, e2.id)).toBe(e2.id);
    expect(activeRowKey(expanded, e2.id, gKey)).toBe(gKey); // the user put the cursor on the group
    expect(moveRowKey(expanded, gKey, 1)).toBe(e2.id);
    expect(moveRowKey(expanded, e1.id, 1)).toBe(single.id);
    expect(moveRowKey(expanded, null, 'last')).toBe(single.id);
    expect(moveRowKey(expanded, single.id, -10)).toBe(gKey);
  });

  it('shows a host inline only where it changes (the first row against the page host)', () => {
    const a = entry({ url: 'https://app.example.com/a', startTime: 50 });
    const b = entry({ url: 'https://api.example.com/b', startTime: 40 });
    const c = entry({ url: 'https://api.example.com/c', startTime: 30 });
    const d = entry({ url: 'https://app.example.com/d', startTime: 20 });
    const data = entry({ url: 'data:text/plain,hi', startTime: 10 });
    expect(inlineHostFlags(allRows([a, b, c, d, data]))).toEqual([false, true, false, true, false]);
  });
});

describe('endpoint-template rules', () => {
  const template = 'https://api.example.com/items/{id}';
  const hide: ListRule = { id: 't1', mode: 'hide', pattern: '', template, exact: true, enabled: true, createdAt: 0 };

  it('match the template of any method and any query', () => {
    const rules = compileRules([hide]);
    expect(rules.hides(entry({ url: 'https://api.example.com/items/7?x=1' }))).toBe(true);
    expect(rules.hides(entry({ method: 'DELETE', url: 'https://api.example.com/items/8' }))).toBe(true);
    expect(rules.hides(entry({ url: 'https://api.example.com/items/abc' }))).toBe(false);
    expect(rules.hides(entry({ url: 'https://api.example.com/items/7/sub' }))).toBe(false);
    const only = compileRules([{ ...hide, mode: 'only' }]);
    expect(only.hides(entry({ url: 'https://api.example.com/users/me' }))).toBe(true);
    expect(only.hides(entry({ url: 'https://api.example.com/items/9' }))).toBe(false);
    expect(countMatches([entry({ url: 'https://api.example.com/items/1' }), entry({ url: 'https://api.example.com/x' })], [hide])).toEqual([1]);
  });

  it('are added, deduplicated, labelled and described', () => {
    const first = addRule([], { mode: 'hide', pattern: '', exact: true, template }, { id: 'a', now: 1 });
    expect(first.outcome).toBe('added');
    expect(first.rule).toEqual({ id: 'a', mode: 'hide', pattern: '', template, exact: true, enabled: true, createdAt: 1 });
    expect(addRule(first.rules, { mode: 'hide', pattern: '', exact: true, template }, { id: 'b', now: 2 }).outcome).toBe('exists');
    expect(addRule([], { mode: 'hide', pattern: '', exact: true, template: 'nope' }, { id: 'c', now: 3 }).outcome).toBe('invalid');
    expect(sameRule(hide, { ...hide, mode: 'only' })).toBe(false);
    expect(sameRule(hide, { mode: 'hide', pattern: 'https://api.example.com/items/', exact: false })).toBe(false);
    expect(ruleLabel(hide)).toBe('Hidden: api.example.com/items/{id}');
    expect(ruleDescription(hide)).toBe('Hide requests to the endpoint https://api.example.com/items/{id} (any method, any query)');
  });

  it('survive the settings sanitizer (Setups carry them)', () => {
    expect(sanitizeListRules([hide, { ...hide, id: 't2', template: 'javascript:alert(1)' }, { ...hide, id: 't3', method: 'GET' }])).toEqual([hide]);
  });

  it('offer the literal prefixes of the template as a ladder', () => {
    expect(templatePrefixes(`https://api.example.com/a/reports/${UUID}/items/12`).map((p) => p.pattern)).toEqual([
      'https://api.example.com/',
      'https://api.example.com/a/',
      'https://api.example.com/a/reports/',
    ]);
    expect(templatePrefixes('https://api.example.com/a/b').map((p) => p.pattern)).toEqual([
      'https://api.example.com/',
      'https://api.example.com/a/',
    ]);
    expect(templatePrefixes('data:text/plain,x')).toEqual([]);
  });
});

describe('group row menu', () => {
  it('offers template rules, the ladder, copy, expand and remove', () => {
    const e1 = entry({ url: 'https://api.example.com/items/1' });
    const e2 = entry({ url: 'https://api.example.com/items/2' });
    const row = groupListRows(allRows([e1, e2]), { expanded: new Set() })[0] as Extract<ListRow, { type: 'group' }>;
    const calls: string[] = [];
    const rule: ListRule = { id: 'x', mode: 'hide', pattern: '', template: row.group.template.key, exact: true, enabled: true, createdAt: 0 };
    const menu = buildGroupMenu({
      group: row.group,
      expanded: false,
      prefixes: templatePrefixes(e2.url),
      counts: [2, 2],
      templateCount: 2,
      rules: [rule],
      actions: {
        addRule: (mode, p) => calls.push(`add ${mode} ${p.pattern}`),
        disableRule: (r) => calls.push(`off ${r.id}`),
        addTemplateRule: (mode) => calls.push(`template ${mode}`),
        copyTemplate: () => calls.push('copy template'),
        copyUrl: () => calls.push('copy url'),
        toggle: () => calls.push('toggle'),
        remove: () => calls.push('remove'),
      },
    });
    const items = menu.filter((m): m is Extract<typeof m, { label: string }> => 'label' in m);
    expect(items.map((i) => i.testId)).toEqual([
      'rl-ctx-hide-template',
      'rl-ctx-only-template',
      'rl-ctx-hide',
      'rl-ctx-only',
      'rl-ctx-copy',
      'rl-ctx-expand',
      'rl-ctx-remove',
    ]);
    expect(items[0]!.checked).toBe(true); // the active hide rule
    expect(items[0]!.hint).toBe('· 2');
    items[0]!.onSelect?.();
    items[1]!.onSelect?.();
    items[5]!.onSelect?.();
    items[6]!.onSelect?.();
    expect(calls).toEqual(['off x', 'template only', 'toggle', 'remove']);
    expect(items[6]!.label).toBe('Remove 2 calls from list');
  });
});
