import { describe, expect, it } from 'vitest';
import { parseJsonTree } from '../../src/lib/json-tree';
import {
  T_ATTR,
  T_ATTR_PART,
  T_BLOCK,
  T_FIELD,
  T_TEXT,
  TextMatcher,
  collectCandidates,
  fileBaseName,
  foldCase,
  normalizeText,
  parseIsoDate,
  rawRange,
  resultKey,
  segmentAt,
  significantDigits,
  summarizeHits,
  toWire,
  urlParts,
  variantsFor,
} from '../../src/lib/findInPage';
import type { MatchVariant, TargetTable } from '../../src/lib/findInPage';
import { sanitizeFindLocateRequest, sanitizeFindScanRequest, sanitizeLocales } from '../../src/shared/find-protocol';

const texts = (variants: MatchVariant[]) => variants.map((v) => v.text);

describe('normalizeText / rawRange', () => {
  it('collapses every kind of whitespace and drops invisible characters', () => {
    expect(normalizeText('  a \n\t b  ')).toBe('a b');
    expect(normalizeText('1 258 291')).toBe('1 258 291');
    expect(normalizeText('soft­hy​phen')).toBe('softhyphen');
    expect(normalizeText('\u0001x\u0002')).toBe('x');
    expect(normalizeText('   ')).toBe('');
  });

  it('maps normalized ranges back to raw offsets', () => {
    const raw = '  Size:\n   1.258.291  bytes ';
    const norm = normalizeText(raw);
    expect(norm).toBe('Size: 1.258.291 bytes');
    const start = norm.indexOf('1.258.291');
    const r = rawRange(raw, start, start + '1.258.291'.length)!;
    expect(raw.slice(r[0], r[1])).toBe('1.258.291');
    const space = rawRange(raw, 5, 7)!; // ": " collapsed space + "1"
    expect(raw.slice(space[0], space[1])).toBe('\n   1');
    const zw = 'ab​cd';
    expect(rawRange(zw, 1, 3)).toEqual([1, 4]);
    expect(rawRange(raw, 0, 0)).toBeNull();
    expect(rawRange(raw, 0, norm.length + 1)).toBeNull();
  });

  it('folds case only when the length stays the same', () => {
    expect(foldCase('ABC Ä')).toBe('abc ä');
    expect(foldCase('İ')).toBe('İ');
  });
});

describe('value kinds', () => {
  it('parses ISO dates and date-times', () => {
    expect(parseIsoDate('2024-03-15')).toEqual({ y: 2024, m: 3, d: 15, time: null, zone: null });
    expect(parseIsoDate('2024-03-15T14:30:05.123Z')).toEqual({ y: 2024, m: 3, d: 15, time: { h: 14, min: 30, s: 5 }, zone: 'Z' });
    expect(parseIsoDate('2024-03-15 09:05+0200')?.zone).toBe('+0200');
    expect(parseIsoDate('2024-02-30')).toBeNull();
    expect(parseIsoDate('2024-13-01')).toBeNull();
    expect(parseIsoDate('15/03/2024')).toBeNull();
  });

  it('counts significant digits', () => {
    expect(significantDigits('100')).toBe(3);
    expect(significantDigits('42')).toBe(2);
    expect(significantDigits('-0.05')).toBe(1);
    expect(significantDigits('12.50')).toBe(3);
    expect(significantDigits('1e3')).toBe(1);
    expect(significantDigits('12345678901234567890')).toBe(20);
  });

  it('recognizes URLs and file names', () => {
    expect(urlParts('https://cdn.example.com/files/My%20Report.pdf?x=1')).toEqual({ path: '/files/My Report.pdf', last: 'My Report.pdf' });
    expect(urlParts('/api/users/42')).toEqual({ path: '/api/users/42', last: '42' });
    expect(urlParts('not a url')).toBeNull();
    expect(urlParts('relative/path')).toBeNull();
    expect(fileBaseName('quarterly-report-2024.pdf')).toBe('quarterly-report-2024');
    expect(fileBaseName('example.com')).toBeNull();
    expect(fileBaseName('a/b.pdf')).toBeNull();
  });
});

describe('collectCandidates', () => {
  const tree = parseJsonTree(
    JSON.stringify({
      total: 3,
      ok: true,
      none: null,
      files: [
        { id: 'a1b2c3d4', name: 'report.pdf', size: 1258291, at: '2024-03-15T14:30:00Z', tag: 'pdf' },
        { id: 'e5f6a7b8', name: 'report.pdf', size: 99, at: '2024-03-16', tag: '  ' },
      ],
      title: 'Files   overview',
    }),
  );

  it('skips booleans, null, short strings, small numbers; dedupes values; strings first, shallow first', () => {
    const set = collectCandidates(tree);
    const summary = set.candidates.map((c) => [c.kind, c.value, c.path]);
    expect(summary).toEqual([
      ['string', 'Files   overview', 'title'],
      ['string', 'a1b2c3d4', 'files[0].id'],
      ['string', 'report.pdf', 'files[0].name'],
      ['string', 'pdf', 'files[0].tag'],
      ['string', 'e5f6a7b8', 'files[1].id'],
      ['number', '1258291', 'files[0].size'],
      ['date', '2024-03-15T14:30:00Z', 'files[0].at'],
      ['date', '2024-03-16', 'files[1].at'],
    ]);
    // total (1 digit), ok, none, size 99, blank tag
    expect(set.skipped).toBe(5);
    expect(set.dropped).toBe(0);
    const report = set.candidates.find((c) => c.value === 'report.pdf')!;
    expect(report.nodeIds).toHaveLength(2);
    for (const id of report.nodeIds) expect(set.byNode.get(id)).toBe(report.id);
    expect(set.candidates.find((c) => c.kind === 'number')!.key).toBe('size');
  });

  it('caps the number of values and counts what was dropped', () => {
    const many = parseJsonTree(JSON.stringify({ deep: { deeper: ['zzz-1', 'zzz-2'] }, items: Array.from({ length: 50 }, (_, i) => `item-${i}`), n: 12345 }));
    const set = collectCandidates(many, { maxCandidates: 10 });
    expect(set.candidates).toHaveLength(10);
    expect(set.dropped).toBe(53 - 10);
    // Shallower strings come first: the items (depth 2) before deep.deeper (depth 3); numbers after strings.
    expect(set.candidates[0]!.value).toBe('item-0');
    expect(set.candidates.every((c) => c.kind === 'string')).toBe(true);
    expect(set.candidates.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('honours the length options and the value length limit', () => {
    const t = parseJsonTree(JSON.stringify({ a: 'ab', b: 'x'.repeat(1001), c: 12 }));
    expect(collectCandidates(t).candidates).toHaveLength(0);
    const loose = collectCandidates(t, { minStringLength: 2, minNumberDigits: 2, maxValueChars: 2000 });
    expect(loose.candidates.map((c) => c.value.length)).toEqual([2, 1001, 2]);
  });

  it('wire form keeps only id, kind, value and key', () => {
    const set = collectCandidates(tree);
    const wire = toWire(set.candidates);
    expect(wire[0]).toEqual({ id: 0, kind: 'string', value: 'Files   overview', key: 'title' });
    expect(Object.keys(wire[5]!)).toEqual(['id', 'kind', 'value', 'key']);
  });

  it('handles deep trees without recursion', () => {
    let json = '"leaf-value"';
    for (let i = 0; i < 20_000; i++) json = `[${json}]`;
    const set = collectCandidates(parseJsonTree(json));
    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]!.depth).toBe(20_000);
  });
});

describe('variantsFor', () => {
  it('strings: normalized text, URL path / last segment, file base name', () => {
    expect(variantsFor({ kind: 'string', value: '  Hello   world ' }, [])).toEqual([{ text: 'Hello world', confidence: 2, label: 'text (spaces normalized)' }]);
    const url = variantsFor({ kind: 'string', value: 'https://cdn.example.com/files/2024/My%20Report.pdf' }, []);
    expect(texts(url)).toEqual(['https://cdn.example.com/files/2024/My%20Report.pdf', 'My Report.pdf', '/files/2024/My Report.pdf', 'My Report']);
    expect(url[0]!.confidence).toBe(3);
    expect(url.slice(1).every((v) => v.confidence === 2)).toBe(true);
    // A plain word at the end of an API path is not looked for on its own.
    expect(texts(variantsFor({ kind: 'string', value: '/api/v1/settings' }, []))).toEqual(['/api/v1/settings']);
    expect(texts(variantsFor({ kind: 'string', value: '/download/3f2a6c1e-8b4d' }, []))).toEqual(['/download/3f2a6c1e-8b4d', '3f2a6c1e-8b4d']);
    expect(texts(variantsFor({ kind: 'string', value: 'quarterly-report-2024.pdf' }, []))).toEqual(['quarterly-report-2024.pdf', 'quarterly-report-2024']);
  });

  it('numbers in pt-BR and en-US, with and without grouping', () => {
    const v = texts(variantsFor({ kind: 'number', value: '1258291' }, ['pt-BR', 'en-US']));
    expect(v).toEqual(expect.arrayContaining(['1258291', '1.258.291', '1,258,291', '1 258 291', "1'258'291"]));
    expect(v[0]).toBe('1258291');
    const frac = variantsFor({ kind: 'number', value: '1234.5' }, ['pt-BR', 'en-US']);
    expect(texts(frac)).toEqual(expect.arrayContaining(['1234.5', '1234.50', '1.234,5', '1234,5', '1.234,50', '1,234.5', '1,234.50']));
    expect(frac.find((x) => x.text === '1.234,5')).toMatchObject({ confidence: 1, label: 'number (pt-BR)' });
    expect(frac.find((x) => x.text === '1234.50')).toMatchObject({ confidence: 2 });
  });

  it('money-like keys get two decimals; size-like keys get byte units', () => {
    expect(texts(variantsFor({ kind: 'number', value: '1999', key: 'price' }, ['pt-BR']))).toEqual(
      expect.arrayContaining(['1999.00', '1.999,00', '1999,00']),
    );
    const size = texts(variantsFor({ kind: 'number', value: '1258291', key: 'size' }, ['pt-BR', 'en-US']));
    expect(size).toEqual(expect.arrayContaining(['1,2 MB', '1.2 MB', '1,26 MB', '1.26 MB']));
  });

  it('keeps big integers exact', () => {
    const v = texts(variantsFor({ kind: 'number', value: '12345678901234567890' }, ['en-US']));
    expect(v).toContain('12,345,678,901,234,567,890');
  });

  it('dates: locale formats, numeric orders, ISO day', () => {
    const v = texts(variantsFor({ kind: 'date', value: '2024-03-15' }, ['pt-BR', 'en-US'], { timeZone: 'UTC' }));
    expect(v).toEqual(
      expect.arrayContaining(['2024-03-15', '15/03/2024', '03/15/2024', '3/15/2024', '3/15/24', '15 de mar. de 2024', 'Mar 15, 2024', 'March 15, 2024']),
    );
  });

  it('date-times: local day and time, the time as written, date + time', () => {
    const v = texts(variantsFor({ kind: 'date', value: '2024-03-15T23:30:00Z' }, ['pt-BR', 'en-US'], { timeZone: 'America/Sao_Paulo' }));
    // 23:30Z is 20:30 in São Paulo (UTC-3): both the local and the written clock are offered.
    expect(v).toEqual(expect.arrayContaining(['15/03/2024', '20:30', '23:30', '15/03/2024, 20:30', '15/03/2024, 20:30:00', '8:30 PM']));
    const next = texts(variantsFor({ kind: 'date', value: '2024-03-15T23:30:00Z' }, ['pt-BR'], { timeZone: 'Asia/Tokyo' }));
    // 08:30 on the 16th in Tokyo.
    expect(next).toEqual(expect.arrayContaining(['16/03/2024', '08:30', '15/03/2024']));
  });

  it('a date-only value also gives the local day of UTC midnight', () => {
    const v = texts(variantsFor({ kind: 'date', value: '2024-03-15' }, ['pt-BR'], { timeZone: 'America/New_York' }));
    expect(v).toEqual(expect.arrayContaining(['15/03/2024', '14/03/2024']));
  });

  it('dedupes forms case-insensitively and bounds the list', () => {
    const v = variantsFor({ kind: 'date', value: '2024-03-15T10:00:00+02:00' }, ['pt-BR', 'en-US', 'de-DE'], { timeZone: 'UTC', maxVariants: 12 });
    expect(v).toHaveLength(12);
    expect(new Set(v.map((x) => x.text.toLowerCase())).size).toBe(12);
  });
});

/** A target table from [kind, text] pairs. */
function table(rows: Array<[number, string, number?]>): TargetTable {
  return { texts: rows.map((r) => r[1]), kinds: rows.map((r) => r[0]), groups: rows.map((r, i) => r[2] ?? 1000 + i) };
}

const variant = (text: string, confidence: 1 | 2 | 3 = 3): MatchVariant => ({ text, confidence, label: 'test' });

describe('TextMatcher', () => {
  it('maps substring hits back to their segment by binary search', () => {
    expect(segmentAt(Int32Array.from([0, 5, 9, 20]), 0)).toBe(0);
    expect(segmentAt(Int32Array.from([0, 5, 9, 20]), 8)).toBe(1);
    expect(segmentAt(Int32Array.from([0, 5, 9, 20]), 9)).toBe(2);
    expect(segmentAt(Int32Array.from([0, 5, 9, 20]), 400)).toBe(3);
  });

  it('finds whole texts exactly and longer variants inside texts (case-insensitive)', () => {
    const m = new TextMatcher(
      table([
        [T_TEXT, 'Report.pdf'],
        [T_TEXT, 'Uploaded: report.pdf by Ann'],
        [T_TEXT, 'unrelated'],
      ]),
    );
    const out = m.match([variant('report.pdf')]);
    expect(out.total).toBe(2);
    expect(out.hits.map((h) => [h.target, h.start, h.end, h.kind])).toEqual([
      [0, 0, 10, 'exact'],
      [1, 10, 20, 'substring'],
    ]);
  });

  it('respects word and number boundaries', () => {
    const m = new TextMatcher(
      table([
        [T_TEXT, 'inactive users'],
        [T_TEXT, 'Total: 1.258.291 bytes'],
        [T_TEXT, 'id 123456'],
        [T_TEXT, 'R$ 12345'],
      ]),
    );
    expect(m.match([variant('active')]).total).toBe(0);
    expect(m.match([variant('258.291')]).total).toBe(0);
    expect(m.match([variant('1.258.291')]).hits.map((h) => h.target)).toEqual([1]);
    expect(m.match([variant('12345')]).hits.map((h) => h.target)).toEqual([3]);
  });

  it('short variants only match whole texts', () => {
    const m = new TextMatcher(
      table([
        [T_TEXT, 'pdf'],
        [T_TEXT, 'a pdf file'],
      ]),
    );
    expect(m.match([variant('pdf')]).hits.map((h) => h.target)).toEqual([0]);
  });

  it('counts overlapping variants of one value once', () => {
    const m = new TextMatcher(table([[T_TEXT, 'Download quarterly-report-2024.pdf now']]));
    const out = m.match([variant('quarterly-report-2024.pdf'), variant('quarterly-report-2024', 2)]);
    expect(out.total).toBe(1);
    expect(out.hits[0]).toMatchObject({ start: 9, end: 34, confidence: 3 });
  });

  it('block texts and form fields match whole; attributes match as attribute hits', () => {
    const m = new TextMatcher(
      table([
        [T_TEXT, '1.258'],
        [T_TEXT, '.291'],
        [T_BLOCK, '1.258.291'],
        [T_FIELD, 'search: 1.258.291'],
        [T_ATTR, '/files/3f2a6c1e-8b4d-4e7a', 7],
        [T_ATTR_PART, '3f2a6c1e-8b4d-4e7a', 7],
        [T_ATTR, 'Open 3f2a6c1e-8b4d-4e7a', 7],
      ]),
    );
    const num = m.match([variant('1.258.291')]);
    expect(num.hits.map((h) => [h.target, h.kind])).toEqual([
      [2, 'exact'],
      [3, 'substring'],
    ]);
    // Three attribute hits on the same element count once.
    const id = m.match([variant('3f2a6c1e-8b4d-4e7a')]);
    expect(id.total).toBe(1);
    expect(id.hits[0]!.kind).toBe('attr');
  });

  it('drops attribute hits of an element whose text matched', () => {
    const m = new TextMatcher(
      table([
        [T_TEXT, 'report.pdf', 5],
        [T_ATTR, 'report.pdf', 5],
        [T_ATTR, 'report.pdf', 6],
      ]),
    );
    const out = m.match([variant('report.pdf')]);
    expect(out.hits.map((h) => [h.target, h.kind])).toEqual([
      [0, 'exact'],
      [2, 'attr'],
    ]);
    expect(out.total).toBe(2);
  });

  it('keeps maxHits hits and stops counting at the cap', () => {
    const rows: Array<[number, string]> = Array.from({ length: 30 }, () => [T_TEXT, 'common value']);
    const m = new TextMatcher(table(rows));
    const out = m.match([variant('common value')], { maxHits: 5, countCap: 20 });
    expect(out.hits).toHaveLength(5);
    expect(out.total).toBe(20);
    expect(out.more).toBe(true);
  });

  it('steps one variant at a time', () => {
    const m = new TextMatcher(table([[T_TEXT, 'abc def'], [T_TEXT, 'ghi jkl']]));
    const job = m.begin([variant('abc def'), variant('ghi jkl')]);
    expect(job.step()).toBe(false);
    expect(job.step()).toBe(true);
    expect(job.outcome().total).toBe(2);
  });

  it('scales to a large page buffer', () => {
    const rows: Array<[number, string]> = [];
    for (let i = 0; i < 50_000; i++) rows.push([T_TEXT, `Row ${i}: item-${i} costs ${i * 3}.00`]);
    const m = new TextMatcher(table(rows));
    const start = Date.now();
    const out = m.match([variant('item-49999')]);
    expect(out.hits.map((h) => h.target)).toEqual([49_999]);
    // A pathological (quadratic) matcher would take minutes here; a linear one takes milliseconds.
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('summarizeHits', () => {
  const variants = [variant('report.pdf', 3), variant('report', 2)];

  it('counts visible hits, picks the best kind, flags attribute-only and common values', () => {
    const r = summarizeHits(
      {
        hits: [
          { target: 0, start: 0, end: 6, kind: 'substring', confidence: 2, variant: 1 },
          { target: 1, start: 0, end: 10, kind: 'exact', confidence: 3, variant: 0 },
          { target: 2, start: 0, end: 10, kind: 'attr', confidence: 3, variant: 0 },
        ],
        total: 3,
        more: false,
      },
      [true, false, true],
      variants,
    );
    expect(r).toEqual({ total: 3, more: false, visible: 2, attrOnly: false, common: false, kind: 'exact', confidence: 3, as: 'report.pdf', asLabel: 'test' });
    const attrs = summarizeHits({ hits: [{ target: 2, start: 0, end: 10, kind: 'attr', confidence: 3, variant: 0 }], total: 1, more: false }, [true], variants);
    expect(attrs.attrOnly).toBe(true);
    expect(attrs.kind).toBe('attr');
    const common = summarizeHits({ hits: [], total: 250, more: false }, [], variants, 200);
    expect(common).toMatchObject({ common: true, total: 250, kind: null, attrOnly: false, as: '' });
    expect(resultKey(r)).not.toBe(resultKey({ ...r, visible: 1 }));
  });
});

describe('protocol sanitizers', () => {
  it('bounds the scan request', () => {
    const req = sanitizeFindScanRequest({
      scanId: 's:1',
      watch: true,
      locales: ['pt-br', 'xx-invalid-locale-$$', 'en-US', 'pt-BR', 'de', 'fr'],
      candidates: [
        { id: 0, kind: 'string', value: 'ok', key: 'name' },
        { id: 0, kind: 'string', value: 'duplicate id' },
        { id: 1, kind: 'weird', value: 'x' },
        { id: 2, kind: 'number', value: '' },
        { id: 3, kind: 'number', value: 'x'.repeat(1001) },
        { id: 4, kind: 'date', value: '2024-03-15' },
        'junk',
      ],
    });
    expect(req).toEqual({
      scanId: 's:1',
      watch: true,
      locales: ['pt-BR', 'en-US', 'de'],
      candidates: [
        { id: 0, kind: 'string', value: 'ok', key: 'name' },
        { id: 4, kind: 'date', value: '2024-03-15' },
      ],
    });
    expect(sanitizeFindScanRequest({ scanId: 'bad id!', candidates: [] })).toBeNull();
    expect(sanitizeFindScanRequest(null)).toBeNull();
    expect(sanitizeLocales('pt-BR')).toEqual([]);
    expect(sanitizeLocales(['pt_BR', '', 'EN-us'])).toEqual(['pt-BR', 'en-US']);
  });

  it('bounds the locate request', () => {
    expect(sanitizeFindLocateRequest({ scanId: 's1', candidateId: 3, nodeId: 'j1abc', path: 'a'.repeat(400), snippet: 'v' })).toEqual({
      scanId: 's1',
      candidateId: 3,
      nodeId: 'j1abc',
      path: 'a'.repeat(300),
      snippet: 'v',
    });
    expect(sanitizeFindLocateRequest({ scanId: 's1', candidateId: -1, nodeId: 'j1' })).toBeNull();
    expect(sanitizeFindLocateRequest({ scanId: 's1', candidateId: 1, nodeId: '<script>' })).toBeNull();
  });
});
