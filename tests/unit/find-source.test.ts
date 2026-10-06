import { describe, expect, it } from 'vitest';
import {
  buildSourceQueries,
  containsWord,
  matchLeaf,
  numberSeparators,
  parseLocalizedDates,
  parseLocalizedNumbers,
  parseTimes,
  searchJsonValue,
  searchPlainText,
} from '../../src/lib/findSource';
import { variantsFor } from '../../src/lib/findInPage';

const values = (text: string, locales: string[] = []) => parseLocalizedNumbers(text, locales).map((n) => n.value);
const days = (text: string, locales: string[] = []) => parseLocalizedDates(text, locales).map((d) => `${d.y}-${d.m}-${d.d}`);

describe('localized numbers', () => {
  it('reads separators from the locale', () => {
    expect(numberSeparators('pt-BR')).toEqual({ group: '.', decimal: ',' });
    expect(numberSeparators('en-US')).toEqual({ group: ',', decimal: '.' });
    expect(numberSeparators('fr-FR')).toEqual({ group: ' ', decimal: ',' });
  });

  it('parses pt-BR and en-US forms, keeping every reading of ambiguous tokens', () => {
    expect(values('1.258.291 bytes', ['pt-BR'])).toEqual([1258291]);
    expect(values('1,258,291', ['en-US'])).toEqual([1258291]);
    expect(values('R$ 1.234,50', ['pt-BR'])).toEqual([1234.5]);
    expect(values('$1,234.50', ['en-US'])).toEqual([1234.5]);
    expect(values('1.234')).toEqual(expect.arrayContaining([1.234, 1234]));
    expect(values('1 234 567,5', ['fr-FR'])).toEqual([1234567.5]);
    expect(values('Total: -42', [])).toEqual([-42]);
    expect(values('−3.5', [])).toEqual([-3.5]);
  });

  it('records units and precision', () => {
    const [size] = parseLocalizedNumbers('1,2 MB', ['pt-BR']);
    expect(size).toMatchObject({ value: 1.2, decimals: 1, factors: [1e6, 1024 ** 2] });
    const [pct] = parseLocalizedNumbers('15%', []);
    expect(pct).toMatchObject({ value: 15, factors: [0.01] });
  });
});

describe('localized dates and times', () => {
  it('numeric dates in both orders, ISO, two-digit years', () => {
    expect(days('15/03/2024')).toEqual(['2024-3-15']);
    expect(days('03/04/2024')).toEqual(['2024-4-3', '2024-3-4']);
    expect(days('2024-03-15')).toEqual(['2024-3-15']);
    expect(days('3/15/24')).toEqual(['2024-3-15']);
    expect(days('15.03.2024')).toEqual(['2024-3-15']);
  });

  it('month names of the page locale and English', () => {
    expect(days('15 de mar. de 2024', ['pt-BR'])).toEqual(['2024-3-15']);
    expect(days('15 de março de 2024', ['pt-BR'])).toEqual(['2024-3-15']);
    expect(days('Mar 15, 2024')).toEqual(['2024-3-15']);
    expect(days('March 15th, 2024')).toEqual(['2024-3-15']);
    expect(days('15. März 2024', ['de-DE'])).toEqual(['2024-3-15']);
  });

  it('times in 24 h and 12 h forms', () => {
    expect(parseTimes('às 14:30').map((t) => [t.h, t.m])).toEqual([[14, 30]]);
    expect(parseTimes('2:30 PM, 12:05 am').map((t) => [t.h, t.m])).toEqual([
      [14, 30],
      [0, 5],
    ]);
    expect(parseTimes('99:99')).toEqual([]);
  });

  it('round-trips with the forward variants', () => {
    for (const locale of ['pt-BR', 'en-US', 'de-DE']) {
      for (const v of variantsFor({ kind: 'date', value: '2024-03-15' }, [locale], { timeZone: 'UTC' })) {
        if (v.label.startsWith('date')) expect(days(v.text, [locale]), `${locale}: ${v.text}`).toContain('2024-3-15');
      }
      for (const v of variantsFor({ kind: 'number', value: '1258291.5' }, [locale])) {
        expect(values(v.text, [locale]), `${locale}: ${v.text}`).toContain(1258291.5);
      }
    }
  });
});

describe('queries and leaf matching', () => {
  it('builds queries without date / time digits as numbers', () => {
    const [q] = buildSourceQueries(['Enviado em 15/03/2024 às 14:30 · 1.258.291 bytes'], ['pt-BR']);
    expect(q!.dates.map((d) => [d.y, d.m, d.d])).toEqual([[2024, 3, 15]]);
    expect(q!.times.map((t) => [t.h, t.m])).toEqual([[14, 30]]);
    expect(q!.numbers.map((n) => n.value)).toEqual([1258291]);
    expect(buildSourceQueries(['a', 'a', ' a '], [])).toHaveLength(1);
  });

  it('matches text, containment, numbers, sizes and dates', () => {
    const [name] = buildSourceQueries(['Quarterly-Report-2024.pdf'], []);
    expect(matchLeaf('quarterly-report-2024.pdf', name!)).toEqual({ score: 3, how: 'same text' });
    expect(matchLeaf('https://x.test/d/quarterly-report-2024.pdf', name!)).toEqual({ score: 2, how: 'contains the text' });
    expect(matchLeaf('report', name!)).toBeNull(); // inside a word-joined name: not a whole part
    const [sentence] = buildSourceQueries(['Uploaded by Ann Smith yesterday'], []);
    expect(matchLeaf('Ann Smith', sentence!)).toEqual({ score: 2, how: 'part of the text' });
    const [size] = buildSourceQueries(['1.258.291 bytes'], ['pt-BR']);
    expect(matchLeaf(1258291, size!)).toEqual({ score: 2, how: 'number' });
    expect(matchLeaf('1258291', size!)).toEqual({ score: 2, how: 'number' });
    const [mb] = buildSourceQueries(['1,2 MB'], ['pt-BR']);
    expect(matchLeaf(1258291, mb!)).toEqual({ score: 1, how: 'size' });
    expect(matchLeaf(5_000_000, mb!)).toBeNull();
    const [date] = buildSourceQueries(['15/03/2024'], ['pt-BR']);
    expect(matchLeaf('2024-03-15', date!)).toEqual({ score: 2, how: 'date' });
    // (2024-03-16 could be shown as the 15th west of UTC: new Date('2024-03-16') is UTC midnight.)
    expect(matchLeaf('2024-03-18', date!)).toBeNull();
  });

  it('containsWord keeps word boundaries', () => {
    expect(containsWord('inactive users', 'active')).toBe(false);
    expect(containsWord('the active users', 'active')).toBe(true);
    expect(containsWord('a-b', 'a')).toBe(true);
  });
});

describe('searching bodies', () => {
  const body = [
    { id: 'a1', name: 'report.pdf', size: 1258291, uploadedAt: '2024-03-15T14:30:00Z', url: 'https://x.test/files/report.pdf' },
    { id: 'b2', name: 'notes.txt', size: 18234, uploadedAt: '2024-03-16T09:00:00Z', url: 'https://x.test/files/notes.txt' },
  ];

  it('returns paths, best first', () => {
    const out = searchJsonValue(body, buildSourceQueries(['report.pdf'], []));
    expect(out.total).toBe(2);
    expect(out.hits.map((h) => [h.path, h.score, h.how])).toEqual([
      [[0, 'name'], 3, 'same text'],
      [[0, 'url'], 2, 'contains the text'],
    ]);
    expect(out.hits[0]!.value).toBe('"report.pdf"');
  });

  it('finds formatted numbers and dates', () => {
    const out = searchJsonValue(body, buildSourceQueries(['18.234 bytes', '16/03/2024'], ['pt-BR']));
    expect(out.hits.map((h) => h.path)).toEqual([
      [1, 'size'],
      [1, 'uploadedAt'],
    ]);
  });

  it('caps hits and leaves', () => {
    const many = Array.from({ length: 100 }, () => ({ v: 'same value' }));
    const out = searchJsonValue(many, buildSourceQueries(['same value'], []), 5);
    expect(out.hits).toHaveLength(5);
    expect(out.total).toBe(100);
    expect(searchJsonValue(many, buildSourceQueries(['same value'], []), 5, 10).total).toBe(10);
  });

  it('searches plain text with snippets', () => {
    const text = `<html><body><p>Your file report.pdf is ready.</p><p>reports.pdf is not it</p></body></html>`;
    const out = searchPlainText(text, buildSourceQueries(['Report.pdf'], []));
    expect(out.total).toBe(1);
    expect(out.hits[0]!.snippet).toContain('report.pdf is ready');
  });
});
