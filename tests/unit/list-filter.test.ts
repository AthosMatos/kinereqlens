import { describe, expect, it } from 'vitest';
import type { EntryKind, ListRule, RequestEntry } from '../../src/shared/types';
import {
  TYPE_CHIPS,
  buildListModel,
  chipForKind,
  isFiltering,
  kindLabel,
  matchesChips,
  matchesText,
  moveSelection,
  parseFilterText,
  rowIndexOf,
  toggleChip,
  type KindChipId,
  type ListFilter,
  type ListRow,
} from '../../src/ui/list/filter';

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
    state: 'done',
    status: 200,
    ...patch,
  };
}

const noFilter: ListFilter = { text: '', chips: new Set() };
const ids = (rows: ListRow[]) =>
  rows.map((r) => (r.type === 'entry' ? r.entry.id : r.type === 'separator' ? `sep(${r.pageUrl})` : r.key));

describe('type chips', () => {
  const expected: Record<KindChipId, EntryKind[]> = {
    fetch: ['fetch', 'xhr', 'beacon', 'ping'],
    doc: ['document', 'subdocument'],
    js: ['script'],
    css: ['stylesheet'],
    img: ['image'],
    media: ['media'],
    font: ['font'],
    other: ['websocket', 'other', 'manual'],
  };

  it('lists All first, then every filtering chip in order', () => {
    expect(TYPE_CHIPS.map((c) => c.id)).toEqual(['all', 'fetch', 'doc', 'js', 'css', 'img', 'media', 'font', 'other']);
    expect(TYPE_CHIPS.map((c) => c.label)).toEqual(['All', 'Fetch/XHR', 'Doc', 'JS', 'CSS', 'Img', 'Media', 'Font', 'Other']);
  });

  it('maps every entry kind to exactly the chip the spec assigns', () => {
    for (const [chip, kinds] of Object.entries(expected)) {
      for (const kind of kinds) expect(chipForKind(kind), kind).toBe(chip);
    }
    const covered = Object.values(expected).flat();
    expect(new Set(covered).size).toBe(covered.length); // no kind in two chips
  });

  it('puts unknown kinds under Other', () => {
    expect(chipForKind('teleport' as EntryKind)).toBe('other');
  });

  it('matches chips (empty selection = All)', () => {
    const img = entry({ kind: 'image' });
    expect(matchesChips(img, new Set())).toBe(true);
    expect(matchesChips(img, new Set<KindChipId>(['img']))).toBe(true);
    expect(matchesChips(img, new Set<KindChipId>(['fetch', 'js']))).toBe(false);
    expect(matchesChips(entry({ kind: 'beacon' }), new Set<KindChipId>(['fetch']))).toBe(true);
    expect(matchesChips(entry({ kind: 'manual' }), new Set<KindChipId>(['other']))).toBe(true);
  });

  it('lists requests the user made under every chip, and keeps the selected entry under any chip', () => {
    const manual = entry({ kind: 'manual' });
    expect(matchesChips(manual, new Set<KindChipId>(['fetch']))).toBe(true);
    const img = entry({ kind: 'image' });
    const fetch = entry({ kind: 'fetch' });
    const fetchOnly = { text: '', chips: new Set<KindChipId>(['fetch']) };
    expect(ids(buildListModel([img, fetch, manual], fetchOnly).rows)).toEqual([fetch.id, manual.id]);
    expect(ids(buildListModel([img, fetch], fetchOnly, img.id).rows)).toEqual([fetch.id, img.id]);
    // The text filter still applies to the selected entry.
    expect(ids(buildListModel([img, fetch], { ...fetchOnly, text: 'nomatch' }, img.id).rows)).toEqual([]);
  });

  it('has short type labels', () => {
    expect(kindLabel('document')).toBe('doc');
    expect(kindLabel('subdocument')).toBe('frame');
    expect(kindLabel('stylesheet')).toBe('css');
    expect(kindLabel('script')).toBe('js');
    expect(kindLabel('image')).toBe('img');
    expect(kindLabel('websocket')).toBe('ws');
    expect(kindLabel('xhr')).toBe('xhr');
    expect(kindLabel('manual')).toBe('manual');
  });
});

describe('toggleChip', () => {
  it('a plain click selects only that chip', () => {
    expect([...toggleChip(new Set(), 'js', false)]).toEqual(['js']);
    expect([...toggleChip(new Set<KindChipId>(['css', 'img']), 'js', false)]).toEqual(['js']);
  });

  it('a plain click on the only selected chip goes back to All', () => {
    expect(toggleChip(new Set<KindChipId>(['js']), 'js', false).size).toBe(0);
  });

  it('a plain click on one of several selected chips keeps only it', () => {
    expect([...toggleChip(new Set<KindChipId>(['js', 'css']), 'js', false)]).toEqual(['js']);
  });

  it('an additive click toggles within the selection', () => {
    expect([...toggleChip(new Set<KindChipId>(['js']), 'css', true)].sort()).toEqual(['css', 'js']);
    expect([...toggleChip(new Set<KindChipId>(['js', 'css']), 'js', true)]).toEqual(['css']);
  });

  it('All always clears the selection', () => {
    expect(toggleChip(new Set<KindChipId>(['js', 'css']), 'all', false).size).toBe(0);
    expect(toggleChip(new Set<KindChipId>(['js']), 'all', true).size).toBe(0);
  });

  it('selecting every chip is the same as All', () => {
    let sel: Set<KindChipId> = new Set();
    for (const chip of TYPE_CHIPS) if (chip.id !== 'all') sel = toggleChip(sel, chip.id, true);
    expect(sel.size).toBe(0);
  });

  it('does not mutate the input selection', () => {
    const input = new Set<KindChipId>(['js']);
    toggleChip(input, 'css', true);
    expect([...input]).toEqual(['js']);
  });
});

describe('parseFilterText', () => {
  it('splits on whitespace, lower-cases, and separates exclusions', () => {
    expect(parseFilterText('  API   -PNG 4xx\t-font  ')).toEqual({ include: ['api', '4xx'], exclude: ['png', 'font'] });
  });

  it('ignores a lone "-" and empty input', () => {
    expect(parseFilterText('-')).toEqual({ include: [], exclude: [] });
    expect(parseFilterText('')).toEqual({ include: [], exclude: [] });
    expect(parseFilterText('   ')).toEqual({ include: [], exclude: [] });
  });

  it('keeps "--x" as an exclusion of "-x"', () => {
    expect(parseFilterText('--x')).toEqual({ include: [], exclude: ['-x'] });
  });
});

describe('matchesText', () => {
  const e = entry({ method: 'POST', url: 'https://api.example.com/v1/Users?page=2', status: 404 });
  const m = (text: string) => matchesText(e, parseFilterText(text));

  it('matches url, method and status, case-insensitively', () => {
    expect(m('users')).toBe(true);
    expect(m('post')).toBe(true);
    expect(m('404')).toBe(true);
    expect(m('PAGE=2')).toBe(true);
    expect(m('delete')).toBe(false);
  });

  it('requires every include term', () => {
    expect(m('users post')).toBe(true);
    expect(m('users get')).toBe(false);
  });

  it('excludes with -term', () => {
    expect(m('-users')).toBe(false);
    expect(m('users -png')).toBe(true);
    expect(m('-post')).toBe(false);
  });

  it('understands status classes like 4xx', () => {
    expect(m('4xx')).toBe(true);
    expect(m('2xx')).toBe(false);
    expect(m('-4xx')).toBe(false);
    expect(matchesText(entry({ status: undefined, state: 'pending' }), parseFilterText('2xx'))).toBe(false);
  });

  it('matches non-ASCII URLs', () => {
    const u = entry({ url: 'https://example.com/búsqueda/日本語' });
    expect(matchesText(u, parseFilterText('日本'))).toBe(true);
    expect(matchesText(u, parseFilterText('BÚSQUEDA'))).toBe(true);
  });

  it('matches everything with an empty filter', () => {
    expect(m('')).toBe(true);
  });
});

describe('buildListModel', () => {
  it('orders newest first, ties in reverse insertion order', () => {
    const a = entry({ startTime: 10 });
    const b = entry({ startTime: 30 });
    const c = entry({ startTime: 20 });
    const d = entry({ startTime: 30 }); // same time as b, inserted later -> first
    const model = buildListModel([a, b, c, d], noFilter);
    expect(ids(model.rows)).toEqual([d.id, b.id, c.id, a.id]);
    expect(model.matched).toBe(4);
    expect(model.total).toBe(4);
  });

  it('numbers entry rows from 1 (aria-posinset)', () => {
    const model = buildListModel([entry(), entry(), entry()], noFilter);
    expect(model.rows.map((r) => (r.type === 'entry' ? r.ordinal : 0))).toEqual([1, 2, 3]);
  });

  it('applies text and chip filters', () => {
    const js = entry({ kind: 'script', url: 'https://cdn.example.com/app.js' });
    const api = entry({ kind: 'xhr', url: 'https://api.example.com/users' });
    const img = entry({ kind: 'image', url: 'https://cdn.example.com/logo.png' });
    const all = [js, api, img];
    expect(ids(buildListModel(all, { text: 'cdn', chips: new Set() }).rows)).toEqual([img.id, js.id]);
    expect(ids(buildListModel(all, { text: '', chips: new Set<KindChipId>(['fetch']) }).rows)).toEqual([api.id]);
    const model = buildListModel(all, { text: 'cdn -png', chips: new Set<KindChipId>(['js', 'img']) });
    expect(ids(model.rows)).toEqual([js.id]);
    expect(model.matched).toBe(1);
    expect(model.total).toBe(3);
  });

  it('puts restored entries after current ones, grouped under a separator per previous page', () => {
    const cur1 = entry({ startTime: 500 });
    const cur2 = entry({ startTime: 600 });
    const old1 = entry({ restored: true, pageUrl: 'https://a.example/one', startTime: 100 });
    const old2 = entry({ restored: true, pageUrl: 'https://a.example/one', startTime: 110 });
    const older = entry({ restored: true, pageUrl: 'https://a.example/zero', startTime: 50 });
    const model = buildListModel([older, old1, old2, cur1, cur2], noFilter);
    expect(ids(model.rows)).toEqual([
      cur2.id,
      cur1.id,
      'sep(https://a.example/one)',
      old2.id,
      old1.id,
      'sep(https://a.example/zero)',
      older.id,
    ]);
    expect(model.matched).toBe(5);
    const keys = model.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length); // stable unique keys
  });

  it('emits no separator when no restored entry matches', () => {
    const cur = entry({ url: 'https://x.example/api' });
    const old = entry({ restored: true, url: 'https://x.example/static.css' });
    const model = buildListModel([old, cur], { text: 'api', chips: new Set() });
    expect(ids(model.rows)).toEqual([cur.id]);
  });

  it('handles an empty list', () => {
    expect(buildListModel([], noFilter)).toEqual({ rows: [], matched: 0, total: 0, hiddenByRules: 0, removed: 0 });
  });
});

describe('buildListModel with URL rules and removed entries', () => {
  const hide = (pattern: string, patch: Partial<ListRule> = {}): ListRule => ({
    id: `r:${pattern}`,
    mode: 'hide',
    pattern,
    exact: false,
    enabled: true,
    createdAt: 0,
    ...patch,
  });
  const api = entry({ url: 'https://api.example.com/standard/reports/list-all?page=1', startTime: 10 });
  const api2 = entry({ url: 'https://api.example.com/standard/users', startTime: 20 });
  const cdn = entry({ kind: 'script', url: 'https://cdn.example.com/app.js', startTime: 30 });
  const manual = entry({ kind: 'manual', source: 'manual', url: 'https://api.example.com/standard/x', startTime: 40 });
  const all = [api, api2, cdn, manual];

  it('drops entries hidden by enabled rules and counts them, never manual entries', () => {
    const model = buildListModel(all, noFilter, null, { rules: [hide('https://api.example.com/standard/')] });
    expect(ids(model.rows)).toEqual([manual.id, cdn.id]);
    expect(model.hiddenByRules).toBe(2);
    expect(model.matched).toBe(2);
    expect(model.total).toBe(4);
    expect(buildListModel(all, noFilter, null, { rules: [hide('https://api.example.com/', { enabled: false })] }).hiddenByRules).toBe(0);
  });

  it('applies only rules', () => {
    const only: ListRule = { ...hide('https://cdn.example.com/'), mode: 'only' };
    const model = buildListModel(all, noFilter, null, { rules: [only] });
    expect(ids(model.rows)).toEqual([manual.id, cdn.id]);
    expect(model.hiddenByRules).toBe(2);
  });

  it('applies rules after chips and text (hidden counts only entries the filter matches)', () => {
    const rules = [hide('https://api.example.com/standard/reports/')];
    const text = buildListModel(all, { text: 'users', chips: new Set() }, null, { rules });
    expect(ids(text.rows)).toEqual([api2.id]);
    expect(text.hiddenByRules).toBe(0);
    const chip = buildListModel(all, { text: '', chips: new Set<KindChipId>(['fetch']) }, null, { rules });
    expect(ids(chip.rows)).toEqual([manual.id, api2.id]);
    expect(chip.hiddenByRules).toBe(1);
  });

  it('keeps the selected entry listed, marked hidden, until it is deselected', () => {
    const rules = [hide('https://api.example.com/standard/')];
    const selected = buildListModel(all, noFilter, api.id, { rules });
    expect(ids(selected.rows)).toEqual([manual.id, cdn.id, api.id]);
    const row = selected.rows.find((r) => r.type === 'entry' && r.entry.id === api.id);
    expect(row?.type === 'entry' && row.hidden).toBe('rule');
    expect(row?.type === 'entry' && row.ordinal).toBe(3);
    expect(selected.hiddenByRules).toBe(1); // api2 only: the selected one is still listed
    expect(selected.matched).toBe(3);
    const visible = selected.rows.find((r) => r.type === 'entry' && r.entry.id === cdn.id);
    expect(visible?.type === 'entry' && visible.hidden).toBeUndefined();
    expect(ids(buildListModel(all, noFilter, cdn.id, { rules }).rows)).toEqual([manual.id, cdn.id]);
  });

  it('drops removed entries (before rules) and keeps a removed selected entry marked', () => {
    const removed = new Set([cdn.id, api.id, 'gone']);
    const model = buildListModel(all, noFilter, null, { removed, rules: [hide('https://api.example.com/standard/reports/')] });
    expect(ids(model.rows)).toEqual([manual.id, api2.id]);
    expect(model.removed).toBe(2); // api counts as removed, not as hidden by the rule
    expect(model.hiddenByRules).toBe(0);
    const selected = buildListModel(all, noFilter, cdn.id, { removed });
    const row = selected.rows.find((r) => r.type === 'entry' && r.entry.id === cdn.id);
    expect(row?.type === 'entry' && row.hidden).toBe('removed');
    expect(selected.removed).toBe(1);
    // Removing works for manual entries too (it is the user's explicit choice).
    expect(ids(buildListModel(all, noFilter, null, { removed: new Set([manual.id]) }).rows)).toEqual([cdn.id, api2.id, api.id]);
  });

  it('applies rules to restored entries and drops their separator when none is left', () => {
    const old = entry({ restored: true, pageUrl: 'https://p.example/', url: 'https://api.example.com/standard/old', startTime: 5 });
    const model = buildListModel([old, cdn], noFilter, null, { rules: [hide('https://api.example.com/')] });
    expect(ids(model.rows)).toEqual([cdn.id]);
    expect(model.hiddenByRules).toBe(1);
  });
});

describe('isFiltering', () => {
  it('is true for a non-default type selection or meaningful text only', () => {
    const fetchOnly = new Set<KindChipId>(['fetch']);
    expect(isFiltering({ text: '', chips: fetchOnly })).toBe(false);
    expect(isFiltering({ text: '   ', chips: fetchOnly })).toBe(false);
    expect(isFiltering({ text: '-', chips: fetchOnly })).toBe(false);
    expect(isFiltering({ text: 'api', chips: fetchOnly })).toBe(true);
    expect(isFiltering({ text: '', chips: new Set<KindChipId>(['js']) })).toBe(true);
    // "All types" differs from the Fetch/XHR default.
    expect(isFiltering(noFilter)).toBe(true);
  });
});

describe('moveSelection / rowIndexOf', () => {
  const a = entry({ startTime: 3 });
  const b = entry({ startTime: 2 });
  const old = entry({ startTime: 1, restored: true, pageUrl: 'https://prev.example/' });
  const rows = buildListModel([old, b, a], noFilter).rows; // a, b, sep, old

  it('moves by rows, skipping separators', () => {
    expect(moveSelection(rows, a.id, 1)).toBe(b.id);
    expect(moveSelection(rows, b.id, 1)).toBe(old.id);
    expect(moveSelection(rows, old.id, -1)).toBe(b.id);
  });

  it('clamps at both ends (no wrap)', () => {
    expect(moveSelection(rows, a.id, -1)).toBe(a.id);
    expect(moveSelection(rows, old.id, 1)).toBe(old.id);
    expect(moveSelection(rows, a.id, 50)).toBe(old.id);
    expect(moveSelection(rows, old.id, -50)).toBe(a.id);
  });

  it('jumps to the first / last entry', () => {
    expect(moveSelection(rows, b.id, 'first')).toBe(a.id);
    expect(moveSelection(rows, a.id, 'last')).toBe(old.id);
  });

  it('selects the first entry when nothing (or a filtered-out entry) is selected', () => {
    expect(moveSelection(rows, null, 1)).toBe(a.id);
    expect(moveSelection(rows, null, -1)).toBe(a.id);
    expect(moveSelection(rows, 'gone', 1)).toBe(a.id);
  });

  it('returns null without entry rows', () => {
    expect(moveSelection([], null, 1)).toBeNull();
    expect(moveSelection([{ type: 'separator', key: 's', pageUrl: '' }], null, 'last')).toBeNull();
  });

  it('finds row indexes (separators count as rows)', () => {
    expect(rowIndexOf(rows, a.id)).toBe(0);
    expect(rowIndexOf(rows, old.id)).toBe(3);
    expect(rowIndexOf(rows, 'missing')).toBe(-1);
    expect(rowIndexOf(rows, null)).toBe(-1);
  });
});
