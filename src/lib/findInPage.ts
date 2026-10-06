// Find in page (docs/ARCHITECTURE.md §13), pure part shared by the panel and the page-side scanner (ui.js):
//  - which response values to look for: collectCandidates (JNode tree → deduplicated, prioritized, capped values),
//  - the text forms a page shows them in: variantsFor (normalized strings, URL path / last segment, file base names,
//    numbers and dates formatted per locale) with a confidence (exact original > normalized / derived > formatted),
//  - the matcher over the page's text: TextMatcher (exact map + substring search over a concatenated buffer with an
//    offset table mapped back by binary search; word-boundary checks; overlapping hits counted once),
//  - the per-value summary sent to the panel: summarizeHits.
// No DOM access here.
import type { JNode } from '../shared/types';
import type { FindCandidateWire, FindMatchKind, FindResult, FindValueKind } from '../shared/find-protocol';
import { FIND_COUNT_CAP, FIND_MAX_CANDIDATES, FIND_MAX_HITS, FIND_MAX_VALUE_CHARS, FIND_MIN_SUBSTRING } from '../shared/find-protocol';
import { formatPath } from './json-tree';

// ------------------------------------------------------------------------------------------------ normalization

/** C0 controls (other than whitespace), DEL, soft hyphen and zero-width characters: dropped by normalizeText. */
const INVISIBLE_CLASS = '[\\u0000-\\u0008\\u000e-\\u001f\\u007f\\u00ad\\u200b-\\u200d\\u2060]';
const INVISIBLE_TEST = new RegExp(INVISIBLE_CLASS);
const INVISIBLE_ALL = new RegExp(INVISIBLE_CLASS, 'g');
const WS_RUNS = /\s+/g;
const WS_CHAR = /\s/;

/**
 * Text as the matcher compares it: invisible characters dropped, every run of whitespace (NBSP and narrow NBSP
 * included) collapsed to one space, trimmed. The separator of the matcher's buffers can never survive it.
 */
export function normalizeText(text: string): string {
  const visible = INVISIBLE_TEST.test(text) ? text.replace(INVISIBLE_ALL, '') : text;
  return visible.replace(WS_RUNS, ' ').trim();
}

/** Lower-cased text when that keeps its length (offsets stay valid), else the text itself. */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

/**
 * Offsets in `raw` of the range [start, end) of `normalizeText(raw)` (to put a DOM Range on a text node).
 * Null when the range is empty or outside the normalized text.
 */
export function rawRange(raw: string, start: number, end: number): [number, number] | null {
  if (start < 0 || end <= start) return null;
  let n = 0;
  let pendingSpace = -1;
  let seenContent = false;
  let rawStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (INVISIBLE_TEST.test(ch)) continue;
    if (WS_CHAR.test(ch)) {
      if (seenContent && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      // The whitespace run before this character is one space at normalized offset n.
      if (n === start) rawStart = pendingSpace;
      n++;
      if (n === end) return [rawStart, pendingSpace + 1];
      pendingSpace = -1;
    }
    if (n === start) rawStart = i;
    n++;
    seenContent = true;
    if (n === end) return rawStart >= 0 ? [rawStart, i + 1] : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ value kinds

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

export interface IsoDateParts {
  y: number;
  m: number;
  d: number;
  time: { h: number; min: number; s: number } | null;
  /** 'Z', '+02:00', '-0300', … as written; null when the text has no zone (a local time). */
  zone: string | null;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Parts of an ISO 8601 date ("2024-03-15") or date-time ("2024-03-15T14:30:00Z"), or null. */
export function parseIsoDate(text: string): IsoDateParts | null {
  const m = ISO_DATE.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (m[4] === undefined) return { y, m: mo, d, time: null, zone: null };
  const h = Number(m[4]);
  const min = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (h > 23 || min > 59 || s > 59) return null;
  return { y, m: mo, d, time: { h, min, s }, zone: m[8] ? m[8].toUpperCase() : null };
}

/** Digits of a number literal without sign, leading zeros, decimal point, trailing fraction zeros and exponent. */
export function significantDigits(literal: string): number {
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE][+-]?\d+)?$/.exec(literal.trim());
  if (!m) return 0;
  const digits = `${m[1] ?? ''}${(m[2] ?? '').replace(/0+$/, '')}`;
  return digits.replace(/^0+/, '').length;
}

// ------------------------------------------------------------------------------------------------ candidates

/** A response value to look for, with the JSON nodes that hold it. */
export interface FindCandidate extends FindCandidateWire {
  /** JSON node ids holding this value, in document order. */
  nodeIds: string[];
  /** formatPath of the first node holding it. */
  path: string;
  /** Depth of the shallowest node holding it. */
  depth: number;
}

export interface CandidateOptions {
  /** Shorter strings (after normalization) are not searched. Default 3. */
  minStringLength?: number;
  /** Numbers with fewer significant digits are not searched. Default 3. */
  minNumberDigits?: number;
  /** Distinct values kept. Default FIND_MAX_CANDIDATES. */
  maxCandidates?: number;
  /** Longer strings are not searched. Default FIND_MAX_VALUE_CHARS. */
  maxValueChars?: number;
}

export interface CandidateSet {
  /** Kept values, by priority (ids = index). */
  candidates: FindCandidate[];
  /** JSON node id → candidate id. */
  byNode: Map<string, number>;
  /** Distinct values beyond the cap (not searched). */
  dropped: number;
  /** Leaves never searched: booleans, null, short or blank strings, small numbers, very long strings. */
  skipped: number;
}

interface PathLink {
  parent: PathLink | null;
  seg: string | number;
}

const KIND_RANK: Record<FindValueKind, number> = { string: 0, number: 1, date: 2 };

function pathOf(link: PathLink | null): Array<string | number> {
  const out: Array<string | number> = [];
  for (let l = link; l; l = l.parent) out.push(l.seg);
  return out.reverse();
}

/** The nearest object key above a leaf (array items inherit their array's key). */
function keyOf(link: PathLink | null): string | undefined {
  for (let l = link; l; l = l.parent) if (typeof l.seg === 'string') return l.seg;
  return undefined;
}

/**
 * The leaf values of `root` worth looking for on the page, deduplicated (one candidate per distinct value, with every
 * node holding it), prioritized (strings, then numbers, then dates; shallower first; then document order) and capped.
 * Iterative (no recursion limit).
 */
export function collectCandidates(root: JNode, options: CandidateOptions = {}): CandidateSet {
  const minString = options.minStringLength ?? 3;
  const minDigits = options.minNumberDigits ?? 3;
  const max = Math.max(0, options.maxCandidates ?? FIND_MAX_CANDIDATES);
  const maxChars = options.maxValueChars ?? FIND_MAX_VALUE_CHARS;

  interface Acc {
    kind: FindValueKind;
    value: string;
    key: string | undefined;
    nodeIds: string[];
    link: PathLink | null;
    depth: number;
    order: number;
  }
  const byValue = new Map<string, Acc>();
  let skipped = 0;
  let order = 0;
  const stack: Array<{ node: JNode; depth: number; link: PathLink | null }> = [{ node: root, depth: 0, link: null }];
  while (stack.length > 0) {
    const { node, depth, link } = stack.pop()!;
    if (node.type === 'object' || node.type === 'array') {
      const kids = node.children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const child = kids[i]!;
        stack.push({ node: child, depth: depth + 1, link: { parent: link, seg: node.type === 'array' ? i : (child.key ?? '') } });
      }
      continue;
    }
    let kind: FindValueKind | null = null;
    let value = '';
    let dedupe = '';
    if (node.type === 'string') {
      const raw = String(node.value ?? '');
      const norm = normalizeText(raw);
      if (norm.length >= minString && raw.length <= maxChars) {
        value = raw;
        if (parseIsoDate(raw)) {
          kind = 'date';
          dedupe = `d\u0000${raw.trim()}`;
        } else {
          kind = 'string';
          dedupe = `s\u0000${norm}`;
        }
      }
    } else if (node.type === 'number') {
      const literal = String(node.value ?? '').trim();
      if (literal && significantDigits(literal) >= minDigits) {
        kind = 'number';
        value = literal;
        dedupe = `n\u0000${literal}`;
      }
    }
    if (!kind) {
      skipped++;
      continue;
    }
    const acc = byValue.get(dedupe);
    if (acc) {
      acc.nodeIds.push(node.id);
      if (depth < acc.depth) acc.depth = depth;
      continue;
    }
    byValue.set(dedupe, { kind, value, key: keyOf(link), nodeIds: [node.id], link, depth, order: order++ });
  }

  const all = Array.from(byValue.values());
  all.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.depth - b.depth || a.order - b.order);
  const kept = all.slice(0, max);
  const candidates: FindCandidate[] = [];
  const byNode = new Map<string, number>();
  kept.forEach((acc, id) => {
    const candidate: FindCandidate = { id, kind: acc.kind, value: acc.value, nodeIds: acc.nodeIds, path: formatPath(pathOf(acc.link)), depth: acc.depth };
    if (acc.key !== undefined) candidate.key = acc.key;
    candidates.push(candidate);
    for (const nodeId of acc.nodeIds) byNode.set(nodeId, id);
  });
  return { candidates, byNode, dropped: all.length - kept.length, skipped };
}

/** The wire form of candidates (what the host needs). */
export function toWire(candidates: readonly FindCandidate[]): FindCandidateWire[] {
  return candidates.map((c) => (c.key === undefined ? { id: c.id, kind: c.kind, value: c.value } : { id: c.id, kind: c.kind, value: c.value, key: c.key }));
}

// ------------------------------------------------------------------------------------------------ variants

/** One text form of a value. */
export interface MatchVariant {
  /** Normalized text. */
  text: string;
  /** 3 the exact original, 2 normalized / derived (URL path, file name), 1 formatted (locale number, date…). */
  confidence: 1 | 2 | 3;
  /** What the form is ("number (pt-BR)", "date (dd/mm/yyyy)"…), for tooltips. */
  label: string;
}

export interface VariantOptions {
  /** IANA time zone dates are shown in (default: the runtime's). */
  timeZone?: string;
  /** Variants kept per value (default 40). */
  maxVariants?: number;
}

const MONEY_KEY = /price|amount|total|cost|fee|balance|salary|subtotal|tax|discount|paid|due|revenue|charge|credit|debit|valor|pre[cç]o|money|budget/i;
const SIZE_KEY = /size|bytes|length|tamanho/i;
const FILE_EXT =
  /^(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|txt|md|json|xml|ya?ml|zip|gz|tgz|tar|rar|7z|png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico|mp4|mov|webm|avi|mkv|mp3|wav|ogg|flac|m4a|fig|sketch|psd|ai|eps|html?|css|js|ts|sql|log|epub|ics|vcf|eml|key|numbers|pages|apk|ipa|dmg|exe|msi|iso)$/i;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

const formatterCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | null>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat | null {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  if (!formatterCache.has(key)) {
    try {
      formatterCache.set(key, new Intl.NumberFormat(locale, options));
    } catch {
      formatterCache.set(key, null);
    }
  }
  return formatterCache.get(key) as Intl.NumberFormat | null;
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  if (!formatterCache.has(key)) {
    try {
      formatterCache.set(key, new Intl.DateTimeFormat(locale, options));
    } catch {
      formatterCache.set(key, null);
    }
  }
  return formatterCache.get(key) as Intl.DateTimeFormat | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Digits grouped by three with `sep` ("1258291" → "1,258,291"). */
function group3(digits: string, sep: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return out;
}

/** Path and last segment (both URI-decoded) of a URL-like string ("https://…", "//host/…", "/a/b"), or null. */
export function urlParts(text: string): { path: string; last: string } | null {
  if (/\s/.test(text) || text.length > 4096) return null;
  let path: string;
  if (SCHEME_URL.test(text) || text.startsWith('//')) {
    try {
      path = new URL(text, 'http://base.invalid').pathname;
    } catch {
      return null;
    }
  } else if (text.startsWith('/') && text.length > 1) {
    path = text.split(/[?#]/)[0]!;
  } else {
    return null;
  }
  const segs = path.split('/').filter(Boolean);
  const decode = (s: string, fn: (s: string) => string) => {
    try {
      return fn(s);
    } catch {
      return s;
    }
  };
  const lastRaw = segs[segs.length - 1] ?? '';
  return { path: path.length > 1 ? decode(path, decodeURI) : '', last: decode(lastRaw, decodeURIComponent) };
}

/** "report-2024" of a file-name-like "report-2024.pdf" (known extensions only), or null. */
export function fileBaseName(text: string): string | null {
  if (/[\\/]/.test(text)) return null;
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return null;
  return FILE_EXT.test(text.slice(dot + 1)) ? text.slice(0, dot) : null;
}

interface Zoned {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

/** Calendar date and wall time of an instant in `timeZone` (the runtime's when undefined). */
function zonedParts(ms: number, timeZone: string | undefined): Zoned | null {
  if (!Number.isFinite(ms)) return null;
  if (!timeZone) {
    const date = new Date(ms);
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(), h: date.getHours(), min: date.getMinutes() };
  }
  const fmt = dateFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  if (!fmt) return null;
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(ms)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour! % 24, min: parts.minute! };
}

/** Builds a deduplicated (case-folded) list of variants, keeping the first (best) of equal forms. */
class VariantList {
  readonly list: MatchVariant[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly max: number) {}

  add(text: string | null | undefined, confidence: 1 | 2 | 3, label: string): void {
    if (!text || this.list.length >= this.max) return;
    const norm = normalizeText(text);
    if (norm.length < 3) return;
    const key = foldCase(norm);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ text: norm, confidence, label });
  }
}

function stringVariants(value: string, out: VariantList): void {
  const norm = normalizeText(value);
  out.add(norm, norm === value ? 3 : 2, norm === value ? 'text' : 'text (spaces normalized)');
  const url = urlParts(norm);
  if (url) {
    const base = url.last ? fileBaseName(url.last) : null;
    // A plain word ("/api/v1/settings" → "settings") would be found everywhere: only file names and id-like slugs.
    if (base || /[^\p{L}]/u.test(url.last)) out.add(url.last, 2, 'last URL segment');
    out.add(url.path, 2, 'URL path');
    if (base) out.add(base, 2, 'file name without extension');
    return;
  }
  const base = fileBaseName(norm);
  if (base) out.add(base, 2, 'file name without extension');
}

function numberVariants(literal: string, key: string | undefined, locales: readonly string[], out: VariantList): void {
  out.add(literal, 3, 'number');
  const n = Number(literal);
  if (!Number.isFinite(n)) return;
  const plain = /^-?\d+(?:\.\d+)?$/.test(literal);
  if (!plain) out.add(String(n), 2, 'number');
  // Intl formats a numeric string exactly (big integers, long fractions).
  const exact: number | `${number}` = plain ? (literal as `${number}`) : n;
  const integer = Number.isInteger(n);
  const money = key !== undefined && MONEY_KEY.test(key);
  const twoDecimals = !integer || money;
  if (twoDecimals && Math.abs(n) < 1e15) out.add(n.toFixed(2), 2, 'number with 2 decimals');
  const fmt = (locale: string, options: Intl.NumberFormatOptions): string | null => {
    try {
      return numberFormat(locale, options)?.format(exact) ?? null;
    } catch {
      return null;
    }
  };
  for (const locale of locales) {
    out.add(fmt(locale, { maximumFractionDigits: 20 }), 1, `number (${locale})`);
    out.add(fmt(locale, { maximumFractionDigits: 20, useGrouping: false }), 1, `number (${locale}, no grouping)`);
    if (twoDecimals) {
      out.add(fmt(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 1, `number (${locale}, 2 decimals)`);
      out.add(fmt(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }), 1, `number (${locale}, 2 decimals)`);
    }
  }
  if (integer && plain && Math.abs(n) >= 10_000) {
    const digits = literal.replace(/^-/, '');
    const sign = literal.startsWith('-') ? '-' : '';
    for (const sep of [',', '.', ' ', "'"]) out.add(`${sign}${group3(digits, sep)}`, 1, 'grouped number');
  }
  if (integer && n >= 1024 && key !== undefined && SIZE_KEY.test(key)) {
    const units = ['KB', 'MB', 'GB', 'TB'];
    for (const base of [1024, 1000]) {
      let v = n / base;
      let u = 0;
      while (v >= base && u < units.length - 1) {
        v /= base;
        u++;
      }
      for (const locale of locales) {
        for (const digits of [1, 2]) {
          const text = numberFormat(locale, { maximumFractionDigits: digits })?.format(v);
          if (text) out.add(`${text} ${units[u]}`, 1, `size in ${units[u]} (${locale})`);
        }
      }
    }
  }
}

function dateVariants(value: string, locales: readonly string[], timeZone: string | undefined, out: VariantList): void {
  const literal = value.trim();
  out.add(literal, 3, 'date');
  const p = parseIsoDate(literal);
  if (!p) return;
  const days: Array<[number, number, number]> = [];
  const times: Array<[number, number]> = [];
  /** Instants to format as date + time, with the zone they are shown in. */
  const instants: Array<{ ms: number; zone: string | undefined }> = [];
  const addDay = (y: number, m: number, d: number) => {
    if (!days.some((x) => x[0] === y && x[1] === m && x[2] === d)) days.push([y, m, d]);
  };
  const addTime = (h: number, min: number) => {
    if (!times.some((x) => x[0] === h && x[1] === min)) times.push([h, min]);
  };
  if (!p.time) {
    addDay(p.y, p.m, p.d);
    // new Date('2024-03-15') is UTC midnight: a page that formats it in local time may show the day before.
    const local = zonedParts(Date.UTC(p.y, p.m - 1, p.d), timeZone);
    if (local) addDay(local.y, local.m, local.d);
  } else {
    // The wall time as written (a zone-less date-time is a local time; a server may also show its own clock).
    const wall = Date.UTC(p.y, p.m - 1, p.d, p.time.h, p.time.min, p.time.s);
    if (p.zone) {
      const zone = p.zone === 'Z' ? 'Z' : p.zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2').replace(/^([+-]\d{2})$/, '$1:00');
      const iso = `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.time.h)}:${pad2(p.time.min)}:${pad2(p.time.s)}${zone}`;
      const instant = Date.parse(iso);
      const local = zonedParts(instant, timeZone);
      if (local) {
        addDay(local.y, local.m, local.d);
        addTime(local.h, local.min);
        instants.push({ ms: instant, zone: timeZone });
      }
    }
    addDay(p.y, p.m, p.d);
    addTime(p.time.h, p.time.min);
    instants.push({ ms: wall, zone: 'UTC' });
  }
  const fmt = (locale: string, options: Intl.DateTimeFormatOptions, ms: number): string | null => {
    try {
      return dateFormat(locale, options)?.format(ms) ?? null;
    } catch {
      return null;
    }
  };
  for (const [y, m, d] of days) {
    out.add(`${y}-${pad2(m)}-${pad2(d)}`, 2, 'date (yyyy-mm-dd)');
    const noon = Date.UTC(y, m - 1, d, 12);
    for (const locale of locales) {
      out.add(fmt(locale, { timeZone: 'UTC' }, noon), 1, `date (${locale})`);
      out.add(fmt(locale, { timeZone: 'UTC', dateStyle: 'short' }, noon), 1, `date (${locale}, short)`);
      out.add(fmt(locale, { timeZone: 'UTC', dateStyle: 'medium' }, noon), 1, `date (${locale}, medium)`);
      out.add(fmt(locale, { timeZone: 'UTC', dateStyle: 'long' }, noon), 1, `date (${locale}, long)`);
    }
    out.add(`${pad2(d)}/${pad2(m)}/${y}`, 1, 'date (dd/mm/yyyy)');
    out.add(`${pad2(m)}/${pad2(d)}/${y}`, 1, 'date (mm/dd/yyyy)');
  }
  for (const instant of instants) {
    for (const locale of locales) {
      out.add(fmt(locale, { timeZone: instant.zone, dateStyle: 'short', timeStyle: 'short' }, instant.ms), 1, `date and time (${locale})`);
      out.add(
        fmt(locale, { timeZone: instant.zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }, instant.ms),
        1,
        `date and time (${locale})`,
      );
    }
  }
  for (const [h, min] of times) {
    out.add(`${pad2(h)}:${pad2(min)}`, 1, 'time (HH:MM)');
    for (const locale of locales) out.add(fmt(locale, { timeZone: 'UTC', timeStyle: 'short' }, Date.UTC(1970, 0, 1, h, min)), 1, `time (${locale})`);
  }
}

/**
 * The text forms a page may show a value in, best first: strings → the normalized text, plus the path and the
 * (decoded) last segment of URL-like strings and the base name of file names; numbers → the literal, toFixed(2) for
 * fractions and money-like keys, Intl.NumberFormat per locale with and without grouping, grouped forms of large
 * integers, byte sizes for size-like keys; ISO dates → the date per locale (default, short, medium, long),
 * dd/mm/yyyy, mm/dd/yyyy, yyyy-mm-dd, and for date-times date + time and HH:MM (local and as written).
 */
export function variantsFor(
  candidate: Pick<FindCandidateWire, 'kind' | 'value' | 'key'>,
  locales: readonly string[],
  options: VariantOptions = {},
): MatchVariant[] {
  const out = new VariantList(options.maxVariants ?? 40);
  switch (candidate.kind) {
    case 'string':
      stringVariants(candidate.value, out);
      break;
    case 'number':
      numberVariants(candidate.value.trim(), candidate.key, locales, out);
      break;
    case 'date':
      dateVariants(candidate.value, locales, options.timeZone, out);
      break;
  }
  return out.list;
}

// ------------------------------------------------------------------------------------------------ matcher

/** Target kinds of the page index. */
export const T_TEXT = 0;
/** Displayed value of a form field (input / textarea value, selected option). */
export const T_FIELD = 1;
/** Text of a block element joined from several inline pieces ("<b>1.258</b>.291"): whole-text matches only. */
export const T_BLOCK = 2;
/** Attribute value (title, alt, aria-label, placeholder, value, href, src, srcset). */
export const T_ATTR = 3;
/** A part of a URL attribute (resolved URL, path, decoded segment, query value): whole-text matches only. */
export const T_ATTR_PART = 4;

/** The page's text, as the scanner hands it to the matcher. */
export interface TargetTable {
  /** Normalized texts. */
  texts: string[];
  /** T_* kind of each text. */
  kinds: number[];
  /**
   * The element each target belongs to (an id per element): attribute hits count once per element, and not at all
   * when the element's own text matched. Optional (every target its own element).
   */
  groups?: number[];
}

export interface MatchHit {
  /** Index into the target table. */
  target: number;
  /** Range in the target's normalized text. */
  start: number;
  end: number;
  kind: FindMatchKind;
  confidence: number;
  /** Index of the variant that matched. */
  variant: number;
}

export interface MatchOutcome {
  /** The first `maxHits` hits. */
  hits: MatchHit[];
  /** Hits counted (stops at `countCap`). */
  total: number;
  /** Counting stopped at the cap. */
  more: boolean;
}

export interface MatchOptions {
  maxHits?: number;
  countCap?: number;
  /** Variants shorter than this only match whole texts. */
  minSubstring?: number;
}

/** Never part of a normalized text (a C0 control): separates the texts in a buffer. */
const SEP = '\u0001';
const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT = /[0-9]/;
const NUMBER_SEPARATORS = new Set(['.', ',', ' ', "'"]);

interface SearchBuffer {
  text: string;
  starts: Int32Array;
  targets: Int32Array;
  /** 4-grams present in `text` (a variant with an absent one cannot occur: no indexOf needed). */
  grams: GramFilter;
}

/**
 * Presence bitset of the 4-character sequences of a text (hashed; false positives possible, no false negatives). Most
 * forms of a value are not on the page (other locales, other date formats): they are rejected in O(length) instead of
 * an O(buffer) indexOf.
 */
export class GramFilter {
  private readonly bits: Uint32Array;
  private readonly mask: number;

  constructor(text: string) {
    let size = 1 << 12;
    // ~4 bits per character keeps the false-positive rate low; at most 4 M bits (512 KB).
    while (size < text.length * 4 && size < 1 << 22) size <<= 1;
    this.mask = size - 1;
    this.bits = new Uint32Array(size >>> 5);
    for (let i = 0; i + 4 <= text.length; i++) {
      const h = this.hash(text, i);
      this.bits[h >>> 5]! |= 1 << (h & 31);
    }
  }

  private hash(text: string, i: number): number {
    let h = text.charCodeAt(i);
    h = Math.imul(h, 0x9e3779b1) ^ text.charCodeAt(i + 1);
    h = Math.imul(h, 0x85ebca77) ^ text.charCodeAt(i + 2);
    h = Math.imul(h, 0xc2b2ae3d) ^ text.charCodeAt(i + 3);
    h ^= h >>> 15;
    return h & this.mask;
  }

  /** False when `key` (≥ 4 characters) certainly does not occur in the text. */
  mayContain(key: string): boolean {
    for (let i = 0; i + 4 <= key.length; i++) {
      const h = this.hash(key, i);
      if ((this.bits[h >>> 5]! & (1 << (h & 31))) === 0) return false;
    }
    return true;
  }
}

function buildBuffer(table: TargetTable, accept: (kind: number) => boolean): SearchBuffer {
  const parts: string[] = [];
  const starts: number[] = [];
  const targets: number[] = [];
  let offset = 0;
  for (let t = 0; t < table.texts.length; t++) {
    if (!accept(table.kinds[t]!)) continue;
    const folded = foldCase(table.texts[t]!);
    starts.push(offset);
    targets.push(t);
    parts.push(folded);
    offset += folded.length + 1;
  }
  const text = parts.join(SEP);
  return { text, starts: Int32Array.from(starts), targets: Int32Array.from(targets), grams: new GramFilter(text) };
}

/** Index of the buffer segment containing `offset` (binary search over the start offsets). */
export function segmentAt(starts: Int32Array | readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A hit inside a longer text must not start / end inside a word (an "active" inside "inactive"), nor inside a
 * longer number ("258.291" inside "1.258.291", "12345" inside "123456").
 */
function boundaryOk(buf: string, pos: number, end: number, segStart: number, segEnd: number, key: string): boolean {
  const first = key[0]!;
  const last = key[key.length - 1]!;
  if (pos > segStart) {
    const before = buf[pos - 1]!;
    if (WORD_CHAR.test(first) && WORD_CHAR.test(before)) return false;
    if (DIGIT.test(first) && NUMBER_SEPARATORS.has(before) && pos - 1 > segStart && DIGIT.test(buf[pos - 2]!)) return false;
  }
  if (end < segEnd) {
    const after = buf[end]!;
    if (WORD_CHAR.test(last) && WORD_CHAR.test(after)) return false;
    if (DIGIT.test(last) && NUMBER_SEPARATORS.has(after) && end + 1 < segEnd && DIGIT.test(buf[end + 1]!)) return false;
  }
  return true;
}

/** Incremental matching of one value: `step()` searches one variant; true once finished. */
export class MatchJob {
  private readonly hits: MatchHit[] = [];
  private total = 0;
  private more = false;
  private next = 0;
  private readonly ranges = new Map<number, Array<[number, number]>>();
  private readonly attrGroups = new Set<number>();
  private readonly textGroups = new Set<number>();
  private readonly maxHits: number;
  private readonly countCap: number;
  private readonly minSubstring: number;

  constructor(
    private readonly matcher: TextMatcher,
    private readonly variants: readonly MatchVariant[],
    options: MatchOptions,
  ) {
    this.maxHits = options.maxHits ?? FIND_MAX_HITS;
    this.countCap = options.countCap ?? FIND_COUNT_CAP;
    this.minSubstring = options.minSubstring ?? FIND_MIN_SUBSTRING;
  }

  get done(): boolean {
    return this.more || this.next >= this.variants.length;
  }

  step(): boolean {
    if (this.done) return true;
    const index = this.next++;
    const variant = this.variants[index]!;
    const key = foldCase(variant.text);
    const m = this.matcher;
    for (const target of m.exactTargets(key)) {
      const kind = m.isAttr(target) ? 'attr' : 'exact';
      this.add(target, 0, m.textOf(target).length, kind, variant.confidence, index);
      if (this.more) return true;
    }
    if (key.length >= this.minSubstring) {
      this.scan(m.textBuffer, key, 'substring', variant.confidence, index);
      if (!this.more) this.scan(m.attrBuffer, key, 'attr', variant.confidence, index);
    }
    return this.done;
  }

  /** Run every remaining step. */
  finish(): MatchOutcome {
    while (!this.step()) {
      /* next variant */
    }
    return this.outcome();
  }

  outcome(): MatchOutcome {
    // Attribute hits on elements whose own text matched are the same place: not counted twice.
    let hits = this.hits;
    let total = this.total;
    if (this.textGroups.size > 0 && this.attrGroups.size > 0) {
      const dupes = hits.filter((h) => h.kind === 'attr' && this.textGroups.has(this.matcher.groupOf(h.target)));
      if (dupes.length > 0) {
        hits = hits.filter((h) => !dupes.includes(h));
        total -= dupes.length;
      }
    }
    return { hits, total, more: this.more };
  }

  private scan(buf: SearchBuffer, key: string, kind: FindMatchKind, confidence: number, variant: number): void {
    const text = buf.text;
    if (text.length < key.length || !buf.grams.mayContain(key)) return;
    let from = 0;
    for (;;) {
      const pos = text.indexOf(key, from);
      if (pos < 0) return;
      from = pos + key.length;
      const seg = segmentAt(buf.starts, pos);
      const segStart = buf.starts[seg]!;
      const target = buf.targets[seg]!;
      const segEnd = segStart + this.matcher.textOf(target).length;
      if (pos + key.length > segEnd) continue;
      if (!boundaryOk(text, pos, pos + key.length, segStart, segEnd, key)) continue;
      this.add(target, pos - segStart, pos - segStart + key.length, kind, confidence, variant);
      if (this.more) return;
    }
  }

  private add(target: number, start: number, end: number, kind: FindMatchKind, confidence: number, variant: number): void {
    const group = this.matcher.groupOf(target);
    if (kind === 'attr') {
      if (this.attrGroups.has(group)) return;
      this.attrGroups.add(group);
    } else {
      const ranges = this.ranges.get(target);
      if (ranges) {
        for (const [s, e] of ranges) if (start < e && end > s) return;
        ranges.push([start, end]);
      } else this.ranges.set(target, [[start, end]]);
      this.textGroups.add(group);
    }
    this.total++;
    if (this.hits.length < this.maxHits) this.hits.push({ target, start, end, kind, confidence, variant });
    if (this.total >= this.countCap) this.more = true;
  }
}

/**
 * Matcher over a page's text: whole texts by a case-folded exact map; longer variants (≥ FIND_MIN_SUBSTRING) also
 * inside texts and attribute values, with `indexOf` over one concatenated buffer per family and an offset table.
 */
export class TextMatcher {
  readonly textBuffer: SearchBuffer;
  readonly attrBuffer: SearchBuffer;
  private readonly exact = new Map<string, number[]>();

  constructor(private readonly table: TargetTable) {
    for (let t = 0; t < table.texts.length; t++) {
      const key = foldCase(table.texts[t]!);
      if (!key) continue;
      const list = this.exact.get(key);
      if (list) list.push(t);
      else this.exact.set(key, [t]);
    }
    this.textBuffer = buildBuffer(table, (k) => k === T_TEXT || k === T_FIELD);
    this.attrBuffer = buildBuffer(table, (k) => k === T_ATTR);
  }

  /** Targets whose whole (folded) text is `key`. */
  exactTargets(key: string): readonly number[] {
    return this.exact.get(key) ?? [];
  }

  isAttr(target: number): boolean {
    const kind = this.table.kinds[target];
    return kind === T_ATTR || kind === T_ATTR_PART;
  }

  textOf(target: number): string {
    return this.table.texts[target] ?? '';
  }

  groupOf(target: number): number {
    return this.table.groups?.[target] ?? -1 - target;
  }

  begin(variants: readonly MatchVariant[], options: MatchOptions = {}): MatchJob {
    return new MatchJob(this, variants, options);
  }

  match(variants: readonly MatchVariant[], options: MatchOptions = {}): MatchOutcome {
    return this.begin(variants, options).finish();
  }
}

// ------------------------------------------------------------------------------------------------ summary

const KIND_ORDER: Record<FindMatchKind, number> = { exact: 0, substring: 1, attr: 2 };

/**
 * What the panel needs to know about one value: hit counts (visible ones among the kept hits), whether every hit is an
 * attribute, whether it is too common to locate, and the best hit (exact text > substring > attribute, then the
 * highest confidence) with the form that matched.
 */
export function summarizeHits(
  outcome: MatchOutcome,
  visible: readonly boolean[],
  variants: readonly MatchVariant[],
  maxHits = FIND_MAX_HITS,
): Omit<FindResult, 'id'> {
  const { hits, total, more } = outcome;
  let visibleCount = 0;
  for (let i = 0; i < hits.length; i++) if (visible[i]) visibleCount++;
  let best: MatchHit | null = null;
  for (const hit of hits) {
    if (!best || KIND_ORDER[hit.kind] < KIND_ORDER[best.kind] || (hit.kind === best.kind && hit.confidence > best.confidence)) best = hit;
  }
  const variant = best ? variants[best.variant] : undefined;
  return {
    total,
    more,
    visible: visibleCount,
    attrOnly: hits.length > 0 && hits.every((h) => h.kind === 'attr'),
    common: total > maxHits,
    kind: best?.kind ?? null,
    confidence: best?.confidence ?? 0,
    as: variant ? variant.text.slice(0, 120) : '',
    asLabel: variant?.label ?? '',
  };
}

/** Equality key of a result (the host only re-sends results whose key changed). */
export function resultKey(r: Omit<FindResult, 'id'>): string {
  return `${r.total}|${r.more}|${r.visible}|${r.attrOnly}|${r.common}|${r.kind}|${r.confidence}|${r.as}`;
}
