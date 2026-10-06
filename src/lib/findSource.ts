// "Where does this come from?" (docs/ARCHITECTURE.md §13), pure part: the texts of an element picked on the page
// become queries — the text itself, the numbers in it read with each locale's separators (and byte-size units /
// percent), the dates in it (ISO, dd/mm/yyyy and mm/dd/yyyy, month names of each locale) and times — which are then
// looked for in captured response bodies: JSON values (with their paths) and plain text.
import { foldCase, normalizeText, parseIsoDate, significantDigits } from './findInPage';

// ------------------------------------------------------------------------------------------------ numbers

/** A number read from page text. */
export interface ParsedNumber {
  value: number;
  /** Fraction digits shown (the display precision). */
  decimals: number;
  /** Scale factors of a unit after the number: byte sizes (KB → 1000 and 1024 …) or percent (0.01). */
  factors: number[];
  /** How it was read ("pt-BR", "1,234.5"…). */
  how: string;
}

const NUMBER_TOKEN = /[-+−]?\d[\d.,'   ]*/g;
const UNIT_AFTER = /^ ?(kib|mib|gib|tib|kb|mb|gb|tb|bytes?|b|%)(?![\p{L}\p{N}])/iu;
const UNIT_FACTORS: Record<string, number[]> = {
  b: [1],
  byte: [1],
  bytes: [1],
  kb: [1e3, 1024],
  mb: [1e6, 1024 ** 2],
  gb: [1e9, 1024 ** 3],
  tb: [1e12, 1024 ** 4],
  kib: [1024],
  mib: [1024 ** 2],
  gib: [1024 ** 3],
  tib: [1024 ** 4],
  '%': [0.01],
};

const separatorCache = new Map<string, { group: string; decimal: string } | null>();

/** Group and decimal separators of a locale (NBSP / narrow NBSP as a plain space). */
export function numberSeparators(locale: string): { group: string; decimal: string } | null {
  if (!separatorCache.has(locale)) {
    let seps: { group: string; decimal: string } | null = null;
    try {
      const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
      const group = normalizeText(`a${parts.find((p) => p.type === 'group')?.value ?? ','}a`).slice(1, -1) || ' ';
      const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
      seps = { group, decimal };
    } catch {
      seps = null;
    }
    separatorCache.set(locale, seps);
  }
  return separatorCache.get(locale) ?? null;
}

/** A numeric token read with these separators (groups of exactly three digits after the first), or null. */
function readNumber(token: string, group: string, decimal: string): { value: number; decimals: number } | null {
  let intPart = token;
  let frac = '';
  const at = token.lastIndexOf(decimal);
  if (at >= 0 && decimal !== group) {
    intPart = token.slice(0, at);
    frac = token.slice(at + 1);
    if (!/^\d+$/.test(frac) || intPart.includes(decimal)) return null;
  }
  if (intPart === '') return null;
  const groups = intPart.split(group);
  if (groups.length > 1) {
    if (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
  } else if (!/^\d+$/.test(intPart)) return null;
  const value = Number(`${groups.join('')}${frac ? `.${frac}` : ''}`);
  return Number.isFinite(value) ? { value, decimals: frac.length } : null;
}

/**
 * Numbers in page text, read with the separators of each locale and the common conventions ("1.258.291" in pt-BR is
 * 1258291, "1,2 MB" is 1.2 with byte-size factors). Ambiguous tokens ("1.234") give every reading. Numbers inside a
 * date are skipped when `skip` ranges are given.
 */
export function parseLocalizedNumbers(text: string, locales: readonly string[], skip: ReadonlyArray<[number, number]> = []): ParsedNumber[] {
  const norm = normalizeText(text);
  const pairs: Array<{ group: string; decimal: string; how: string }> = [];
  const addPair = (group: string, decimal: string, how: string) => {
    if (!pairs.some((p) => p.group === group && p.decimal === decimal)) pairs.push({ group, decimal, how });
  };
  for (const locale of locales) {
    const seps = numberSeparators(locale);
    if (seps) addPair(seps.group, seps.decimal, locale);
  }
  addPair(',', '.', '1,234.5');
  addPair('.', ',', '1.234,5');
  addPair(' ', ',', '1 234,5');
  addPair("'", '.', "1'234.5");
  const out: ParsedNumber[] = [];
  for (const m of norm.matchAll(NUMBER_TOKEN)) {
    const startAt = m.index ?? 0;
    let token = m[0];
    // Trailing separators / spaces belong to the sentence ("12, 13").
    token = token.replace(/[.,' ]+$/, '');
    const end = startAt + token.length;
    if (skip.some(([s, e]) => startAt < e && end > s)) continue;
    let sign = 1;
    if (/^[-−]/.test(token)) {
      sign = -1;
      token = token.slice(1);
    } else if (token.startsWith('+')) token = token.slice(1);
    const unit = UNIT_AFTER.exec(norm.slice(end));
    const factors = unit ? (UNIT_FACTORS[unit[1]!.toLowerCase()] ?? []) : [];
    for (const pair of pairs) {
      // A space only groups digits in locales that group with it (else "12 2024" would be one number).
      if (token.includes(' ') && pair.group !== ' ') continue;
      const read = readNumber(token, pair.group, pair.decimal);
      if (!read) continue;
      const value = sign * read.value;
      if (out.some((p) => p.value === value && p.decimals === read.decimals)) continue;
      out.push({ value, decimals: read.decimals, factors, how: pair.how });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ dates

export interface ParsedDate {
  y: number;
  m: number;
  d: number;
  how: string;
  /** Range in the normalized text (numbers inside it are not read as numbers). */
  at: [number, number];
}

export interface ParsedTime {
  h: number;
  m: number;
  /** Range in the normalized text. */
  at: [number, number];
}

function validDay(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fullYear(text: string): number {
  const n = Number(text);
  return text.length === 2 ? (n < 70 ? 2000 + n : 1900 + n) : n;
}

const monthCache = new Map<string, Map<string, number>>();

/** Lower-cased month names (long and short, standalone and in-date forms, trailing dots dropped) → month. */
function monthNames(locale: string): Map<string, number> {
  let names = monthCache.get(locale);
  if (names) return names;
  names = new Map();
  try {
    for (const month of ['long', 'short'] as const) {
      const alone = new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' });
      const inDate = new Intl.DateTimeFormat(locale, { month, day: 'numeric', timeZone: 'UTC' });
      for (let i = 0; i < 12; i++) {
        const at = Date.UTC(2024, i, 15);
        const forms = [alone.format(at), inDate.formatToParts(at).find((p) => p.type === 'month')?.value ?? ''];
        for (const form of forms) {
          const name = form.toLowerCase().replace(/\.$/, '').trim();
          if (name.length >= 3 && !/\d/.test(name) && !names.has(name)) names.set(name, i + 1);
        }
      }
    }
  } catch {
    /* unknown locale */
  }
  monthCache.set(locale, names);
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dates in page text: ISO (2024-03-15), numeric with / . or - (both day-first and month-first readings when valid,
 * two-digit years), and with month names of the given locales and English ("15 de mar. de 2024", "Mar 15, 2024",
 * "15 March 2024").
 */
export function parseLocalizedDates(text: string, locales: readonly string[]): ParsedDate[] {
  const norm = normalizeText(text);
  const out: ParsedDate[] = [];
  const push = (y: number, m: number, d: number, how: string, at: [number, number]) => {
    if (!validDay(y, m, d)) return;
    if (!out.some((x) => x.y === y && x.m === m && x.d === d)) out.push({ y, m, d, how, at });
  };
  for (const m of norm.matchAll(/(?<![\d])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d])/g)) {
    push(Number(m[1]), Number(m[2]), Number(m[3]), 'yyyy-mm-dd', [m.index!, m.index! + m[0].length]);
  }
  for (const m of norm.matchAll(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])/g)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = fullYear(m[4]!);
    const at: [number, number] = [m.index!, m.index! + m[0].length];
    push(y, b, a, 'dd/mm/yyyy', at);
    push(y, a, b, 'mm/dd/yyyy', at);
  }
  const names = new Map<string, number>();
  for (const locale of [...locales, 'en-US']) for (const [name, month] of monthNames(locale)) if (!names.has(name)) names.set(name, month);
  if (names.size > 0) {
    const alternation = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    const lower = norm.toLowerCase();
    if (lower.length === norm.length) {
      const dayFirst = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th|º|°)?\\.?\\s*(?:de\\s+)?(${alternation})\\.?,?\\s*(?:de\\s+)?(\\d{4})(?![\\p{N}])`, 'gu');
      const monthFirst = new RegExp(`(?<![\\p{L}])(${alternation})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\p{N}])`, 'gu');
      for (const m of lower.matchAll(dayFirst)) push(Number(m[3]), names.get(m[2]!)!, Number(m[1]), 'day month year', [m.index!, m.index! + m[0].length]);
      for (const m of lower.matchAll(monthFirst)) push(Number(m[3]), names.get(m[1]!)!, Number(m[2]), 'month day, year', [m.index!, m.index! + m[0].length]);
    }
  }
  return out;
}

/** Times in page text: "14:30", "2:30 PM", "14:30:05". */
export function parseTimes(text: string): ParsedTime[] {
  const out: ParsedTime[] = [];
  for (const m of normalizeText(text).matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?:\s?([ap])\.?\s?m\.?)?(?![\d])/gi)) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ampm = m[3]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (ampm === 'p' ? 12 : 0);
    }
    if (h > 23 || min > 59) continue;
    if (!out.some((t) => t.h === h && t.m === min)) out.push({ h, m: min, at: [m.index!, m.index! + m[0].length] });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ queries

/** What one picked text is looked for as. */
export interface SourceQuery {
  /** Normalized text. */
  text: string;
  /** Case-folded text. */
  lower: string;
  numbers: ParsedNumber[];
  dates: ParsedDate[];
  times: ParsedTime[];
}

/** Queries for the texts of a picked element (deduplicated; ≤ `max`). */
export function buildSourceQueries(texts: readonly string[], locales: readonly string[], max = 16): SourceQuery[] {
  const out: SourceQuery[] = [];
  for (const raw of texts) {
    const text = normalizeText(raw);
    if (!text || out.some((q) => q.text === text)) continue;
    const dates = parseLocalizedDates(text, locales);
    const times = parseTimes(text);
    // Digits of a date or a time are not numbers of their own; neither is a lone digit inside a sentence.
    const skip = [...dates.map((d) => d.at), ...times.map((t) => t.at)];
    const digitsOnly = /^[\d\s.,]+$/.test(text);
    const numbers = parseLocalizedNumbers(text, locales, skip).filter((n) => digitsOnly || significantDigits(String(Math.abs(n.value))) >= 2);
    out.push({ text, lower: foldCase(text), numbers, dates, times });
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ search

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** `needle` occurs in `hay` not inside a word ("active" is not in "inactive"). */
export function containsWord(hay: string, needle: string): boolean {
  if (!needle || needle.length > hay.length) return false;
  let from = 0;
  for (;;) {
    const pos = hay.indexOf(needle, from);
    if (pos < 0) return false;
    from = pos + 1;
    const end = pos + needle.length;
    if (pos > 0 && WORD_CHAR.test(needle[0]!) && WORD_CHAR.test(hay[pos - 1]!)) continue;
    if (end < hay.length && WORD_CHAR.test(needle[needle.length - 1]!) && WORD_CHAR.test(hay[end]!)) continue;
    return true;
  }
}

export interface LeafMatch {
  score: number;
  how: string;
}

function numberMatch(n: number, q: SourceQuery): LeafMatch | null {
  let best: LeafMatch | null = null;
  for (const p of q.numbers) {
    const eps = 1e-9 * Math.max(1, Math.abs(p.value));
    if (Math.abs(n - p.value) <= eps) return { score: 2, how: 'number' };
    // What the page shows is rounded to the digits it shows.
    const tolerance = 0.5 * 10 ** -p.decimals + eps;
    for (const f of p.factors) {
      if (f === 0.01) {
        if (Math.abs(n - p.value / 100) <= tolerance / 100) best ??= { score: 1, how: 'percent' };
      } else if (f !== 1 && Math.abs(n / f - p.value) <= tolerance) best ??= { score: 1, how: 'size' };
    }
    if (!best && Math.abs(n - p.value) <= tolerance) best = { score: 1, how: 'rounded number' };
  }
  return best;
}

function dateMatch(value: string, q: SourceQuery): LeafMatch | null {
  if (q.dates.length === 0 && q.times.length === 0) return null;
  const iso = parseIsoDate(value);
  if (!iso) return null;
  const days: Array<[number, number, number]> = [[iso.y, iso.m, iso.d]];
  const times: Array<[number, number]> = iso.time ? [[iso.time.h, iso.time.min]] : [];
  const instant = iso.time && iso.zone ? Date.parse(value.trim()) : iso.time ? Number.NaN : Date.UTC(iso.y, iso.m - 1, iso.d);
  if (Number.isFinite(instant)) {
    const local = new Date(instant);
    days.push([local.getFullYear(), local.getMonth() + 1, local.getDate()]);
    if (iso.time) times.push([local.getHours(), local.getMinutes()]);
  }
  const dayHit = q.dates.some((d) => days.some(([y, m, dd]) => d.y === y && d.m === m && d.d === dd));
  const timeHit = q.times.some((t) => times.some(([h, m]) => t.h === h && t.m === m));
  if (dayHit && timeHit) return { score: 3, how: 'date and time' };
  if (dayHit) return { score: 2, how: 'date' };
  if (timeHit && q.dates.length === 0) return { score: 1, how: 'time' };
  return null;
}

/** How well a JSON leaf (string or number) matches a query; null when it does not. */
export function matchLeaf(value: string | number, q: SourceQuery): LeafMatch | null {
  if (typeof value === 'number') return numberMatch(value, q);
  const lower = foldCase(normalizeText(value));
  if (!lower) return null;
  if (lower === q.lower) return { score: 3, how: 'same text' };
  const date = dateMatch(value, q);
  if (date) return date;
  if (/^-?\d+(?:\.\d+)?$/.test(lower)) {
    const num = numberMatch(Number(lower), q);
    if (num) return num;
  }
  if (q.lower.length >= 3 && lower.length > q.lower.length && containsWord(lower, q.lower)) return { score: 2, how: 'contains the text' };
  if (lower.length >= 4 && lower.length >= q.lower.length / 4 && containsWord(q.lower, lower)) return { score: 2, how: 'part of the text' };
  return null;
}

export interface SourceHit {
  /** Path from the body's root (object keys / array indices). */
  path: Array<string | number>;
  /** The matching value, clipped. */
  value: string;
  score: number;
  how: string;
}

export interface SourceSearch {
  /** Best first (score, then document order), at most `maxHits`. */
  hits: SourceHit[];
  /** Matching leaves (all of them). */
  total: number;
}

const VALUE_CLIP = 120;

function clip(text: string): string {
  return text.length > VALUE_CLIP ? `${text.slice(0, VALUE_CLIP - 1)}…` : text;
}

/** Search a parsed JSON value (JSON.parse output) for the queries. Iterative; keys in insertion order. */
export function searchJsonValue(root: unknown, queries: readonly SourceQuery[], maxHits = 20, maxLeaves = 500_000): SourceSearch {
  const hits: SourceHit[] = [];
  let total = 0;
  let leaves = 0;
  const stack: Array<{ value: unknown; path: Array<string | number> }> = [{ value: root, path: [] }];
  while (stack.length > 0 && leaves < maxLeaves) {
    const { value, path } = stack.pop()!;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: [...path, i] });
      continue;
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ value: (value as Record<string, unknown>)[keys[i]!], path: [...path, keys[i]!] });
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    leaves++;
    let best: LeafMatch | null = null;
    for (const q of queries) {
      const match = matchLeaf(value, q);
      if (match && (!best || match.score > best.score)) best = match;
      if (best?.score === 3) break;
    }
    if (!best) continue;
    total++;
    hits.push({ path, value: clip(typeof value === 'string' ? JSON.stringify(value) : String(value)), score: best.score, how: best.how });
  }
  // Best first, document order within a score (the walk is in document order and the sort is stable).
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, maxHits), total };
}

export interface TextHit {
  /** Offset in the text. */
  index: number;
  snippet: string;
  score: number;
  how: string;
}

/** Search a plain-text body for the queries' texts (≥ 3 characters, not inside words). */
export function searchPlainText(text: string, queries: readonly SourceQuery[], maxHits = 5): { hits: TextHit[]; total: number } {
  const hay = foldCase(text);
  const hits: TextHit[] = [];
  let total = 0;
  for (const q of queries) {
    if (q.lower.length < 3) continue;
    let from = 0;
    for (;;) {
      const pos = hay.indexOf(q.lower, from);
      if (pos < 0) break;
      from = pos + q.lower.length;
      const end = pos + q.lower.length;
      if (pos > 0 && WORD_CHAR.test(q.lower[0]!) && WORD_CHAR.test(hay[pos - 1]!)) continue;
      if (end < hay.length && WORD_CHAR.test(q.lower[q.lower.length - 1]!) && WORD_CHAR.test(hay[end]!)) continue;
      total++;
      if (hits.length < maxHits) {
        const start = Math.max(0, pos - 40);
        const snippet = `${start > 0 ? '…' : ''}${normalizeText(text.slice(start, Math.min(text.length, end + 40)))}${end + 40 < text.length ? '…' : ''}`;
        hits.push({ index: pos, snippet, score: 2, how: 'text' });
      }
      if (total >= 1000) return { hits, total };
    }
  }
  return { hits, total };
}
