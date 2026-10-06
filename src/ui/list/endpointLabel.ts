// OWNER: ui-shell agent. Readable endpoint labels for the request list and the detail header (pure, no DOM; unit
// tested in tests/unit/list-endpoint-label.test.ts):
//  - endpointTemplate(url): the URL as an endpoint template — path segments that look like ids (integers, UUIDs,
//    ULIDs, long hex, dates, slugs: detectPathParams of src/lib/endpoint.ts; plus short hex hashes, long tokens
//    and content hashes inside file names) become params of a kind, query parameters keep their names (values
//    classified the same way) — and its key (origin + path template), shared by grouping and template rules.
//  - elideSegments / summarizeQuery / layoutLabel: what fits a character budget on one line ("/standard/…/
//    reports/{uuid}/items/{id}", "?companyId · page · 2 more").
//  - groupListRows / aggregateGroup: "Group by endpoint" (method + host + path template).
//  - inlineHostFlags: which rows show their host inline.
import { detectPathParams } from '../../lib/endpoint';
import type { PathParamKind } from '../../lib/endpoint';
import type { RequestEntry } from '../../shared/types';
import type { EntryRow, ListRow } from './filter';
import { durationMs } from './rowModel';

/** Captured at module evaluation so nothing patched later can interfere. */
const NativeURL = URL;

// ------------------------------------------------------------------------------------------- templates

/** Kind of an id-like value (path segment or query value). */
export type ParamKind = PathParamKind | 'hash' | 'token';

/** Short chip text per kind ("{id}", "{uuid}" …). */
export const KIND_LABEL: Readonly<Record<ParamKind, string>> = {
  integer: 'id',
  uuid: 'uuid',
  ulid: 'ulid',
  hex: 'hex',
  date: 'date',
  slug: 'slug',
  hash: 'hash',
  token: 'token',
};

export type TemplateSegment =
  /** A literal segment: `raw` as in the URL, `text` percent-decoded for display. */
  | { type: 'lit'; raw: string; text: string }
  /**
   * An id-like segment (or the content hash inside a file name: prefix "main.", value "3f9a8c1d", suffix ".js").
   * `value` is decoded.
   */
  | {
      type: 'param';
      kind: ParamKind;
      value: string;
      prefix: string;
      suffix: string;
      /** Show the (shortened) value instead of the kind (calls of an expanded group: their concrete ids). */
      showValue?: boolean;
    };

export interface QueryItem {
  name: string;
  value: string;
  /** Id-like value (numeric-only, UUID, hash …), else null. */
  kind: ParamKind | null;
}

export interface EndpointTemplate {
  /** http(s) URL with a host (otherwise only `label` is meaningful). */
  http: boolean;
  /** "https://api.example.com:8443" ('' when not http). */
  origin: string;
  /** "api.example.com:8443" ('' when not http). */
  host: string;
  /** Path segments ([] for "/"). Empty literal segments keep "/a//b/" shapes. */
  segments: TemplateSegment[];
  /** Path template: "/reports/{uuid}/items/{id}" (literal segments as in the URL). */
  path: string;
  /** Grouping / template-rule key: origin + path template (http), else the URL without query / hash. */
  key: string;
  query: QueryItem[];
  /** Fallback label of a non-http URL ("data:image/png", "blob:…"). */
  label: string;
  /** Concrete variant (`concreteTemplate`): params show their values, id-like query values are shown too. */
  concrete?: boolean;
}

const HASH = /^[0-9a-f]{8,15}$/i;
const TOKEN = /^[A-Za-z0-9_-]{24,}$/;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
/** "main.3f9a8c1d.js", "index-B7xK2lQp.css", "chunk.0a1b2c3d4e.min.js". */
const FILE_HASH = /^(.*?[.-])([A-Za-z0-9_]{8,32})((?:\.min)?\.[A-Za-z0-9]{1,8})$/;

function countMatching(text: string, re: RegExp): number {
  let n = 0;
  for (const ch of text) if (re.test(ch)) n++;
  return n;
}

function safeDecodeComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Extra kinds detectPathParams does not report: short hex hashes and long opaque tokens. */
function extraKind(value: string): ParamKind | null {
  const digits = countMatching(value, /\d/);
  if (HASH.test(value) && digits >= 2 && digits < value.length) return 'hash';
  if (JWT.test(value) && value.length >= 30) return 'token';
  if (TOKEN.test(value) && digits >= 2 && /[a-z]/.test(value) && /[A-Z]/.test(value)) return 'token';
  return null;
}

/**
 * detectPathParams calls short hex ids ("9f3c1a2e") and long mixed-case opaque ids slugs: they read better as
 * hashes and tokens.
 */
function refineKind(kind: PathParamKind, value: string): ParamKind {
  if (kind !== 'slug') return kind;
  if (/^[0-9a-f]+$/i.test(value)) return 'hash';
  return extraKind(value) === 'token' ? 'token' : kind;
}

/** Kind of one value (a decoded path segment or query value), or null for words. */
export function valueKind(value: string): ParamKind | null {
  if (!value || value.length > 512 || value.includes('/')) return null;
  const detected = detectPathParams(`/${encodeURIComponent(value)}`).params[0];
  return detected ? refineKind(detected.kind, value) : extraKind(value);
}

/** A content hash inside a file name ("main.3f9a8c1d.js"), else null. */
function fileHash(text: string): { prefix: string; value: string; suffix: string } | null {
  const m = FILE_HASH.exec(text);
  if (!m) return null;
  const [, prefix = '', value = '', suffix = ''] = m;
  if (!prefix || /^[.-]$/.test(prefix)) return null;
  const digits = countMatching(value, /\d/);
  const letters = countMatching(value, /[A-Za-z]/);
  if (digits === 0 || letters === 0) return null;
  const hex = /^[0-9a-f]+$/i.test(value);
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return hex || mixedCase ? { prefix, value, suffix } : null;
}

function segmentPlaceholder(seg: TemplateSegment): string {
  return seg.type === 'lit' ? seg.raw : `${seg.prefix}{${KIND_LABEL[seg.kind]}}${seg.suffix}`;
}

/** Longest value a concrete chip shows in full; longer ones keep their first 8 characters ("9f3c1a2e…"). */
const SHORT_VALUE_MAX = 12;

/** A value shortened for a chip (the full value is in its tooltip). */
export function shortValue(value: string): string {
  const chars = Array.from(value);
  return chars.length > SHORT_VALUE_MAX ? `${chars.slice(0, 8).join('')}…` : value;
}

/** Text of a param chip: "{uuid}", or its shortened value in a concrete template. */
export function chipText(seg: Extract<TemplateSegment, { type: 'param' }>): string {
  return seg.showValue ? shortValue(seg.value) : `{${KIND_LABEL[seg.kind]}}`;
}

/** Text of a segment as displayed ("reports", "{uuid}", "main.{hash}.js"). */
export function segmentText(seg: TemplateSegment): string {
  return seg.type === 'lit' ? seg.text : `${seg.prefix}${chipText(seg)}${seg.suffix}`;
}

function opaqueLabel(url: string): string {
  const raw = url.trim();
  const cut = raw.search(/[?#]/);
  const base = cut >= 0 ? raw.slice(0, cut) : raw;
  if (/^data:/i.test(base)) {
    const header = base.slice(5).split(',', 1)[0]!.split(';', 1)[0]!;
    return `data:${header}`;
  }
  return base;
}

function parseQuery(search: string): QueryItem[] {
  if (!search || search === '?') return [];
  const items: QueryItem[] = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = safeDecodeComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
    const value = eq < 0 ? '' : safeDecodeComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    items.push({ name, value, kind: valueKind(value) });
    if (items.length >= 200) break;
  }
  return items;
}

/** Build the template of a URL (uncached; use `endpointTemplate`). */
export function buildEndpointTemplate(url: string): EndpointTemplate {
  const text = typeof url === 'string' ? url : '';
  let parsed: URL | null = null;
  try {
    parsed = new NativeURL(text);
  } catch {
    parsed = null;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.host) {
    const label = opaqueLabel(text);
    return { http: false, origin: '', host: '', segments: [], path: '', key: label, query: parsed ? parseQuery(parsed.search) : [], label };
  }
  const pathname = parsed.pathname || '/';
  const rawSegments = pathname === '/' ? [] : pathname.slice(1).split('/');
  const detected = detectPathParams(pathname);
  const paramAt = new Map(detected.params.map((p) => [p.index, p]));
  const segments: TemplateSegment[] = rawSegments.map((raw, index) => {
    const decoded = safeDecodeComponent(raw);
    const param = paramAt.get(index);
    if (param) return { type: 'param', kind: refineKind(param.kind, param.example), value: param.example, prefix: '', suffix: '' };
    const extra = raw === '' ? null : extraKind(decoded);
    if (extra) return { type: 'param', kind: extra, value: decoded, prefix: '', suffix: '' };
    const file = raw === '' ? null : fileHash(decoded);
    if (file) return { type: 'param', kind: 'hash', ...file };
    return { type: 'lit', raw, text: decoded };
  });
  const path = `/${segments.map(segmentPlaceholder).join('/')}`;
  const origin = parsed.origin.toLowerCase();
  return {
    http: true,
    origin,
    host: parsed.host,
    segments,
    path,
    key: `${origin}${path}`,
    query: parseQuery(parsed.search),
    label: '',
  };
}

const TEMPLATE_CACHE_MAX = 4000;
const templateCache = new Map<string, EndpointTemplate>();

/** Cached `buildEndpointTemplate` (bounded; entries are re-rendered often, URLs repeat). */
export function endpointTemplate(url: string): EndpointTemplate {
  let t = templateCache.get(url);
  if (!t) {
    t = buildEndpointTemplate(url);
    if (templateCache.size >= TEMPLATE_CACHE_MAX) templateCache.clear();
    templateCache.set(url, t);
  }
  return t;
}

const concreteCache = new WeakMap<EndpointTemplate, EndpointTemplate>();

/**
 * The template with its params showing their (shortened) values: the label of a call listed under its group,
 * where the group row already shows the kinds. Same key; cached per template.
 */
export function concreteTemplate(t: EndpointTemplate): EndpointTemplate {
  if (t.concrete) return t;
  let c = concreteCache.get(t);
  if (!c) {
    c = { ...t, concrete: true, segments: t.segments.map((seg) => (seg.type === 'param' ? { ...seg, showValue: true } : seg)) };
    concreteCache.set(t, c);
  }
  return c;
}

/** Key of the URL's endpoint template (origin + path template; non-http: the URL without query / hash). */
export function templateKeyOf(url: string): string {
  return endpointTemplate(url).key;
}

/** Readable template text: "api.example.com/reports/{uuid}/items/{id}" ("https://" kept when `withScheme`). */
export function templateText(t: EndpointTemplate, withScheme = false): string {
  if (!t.http) return t.label;
  const origin = withScheme || !t.origin.startsWith('https://') ? t.origin : t.origin.slice(8);
  return `${origin}/${t.segments.map(segmentText).join('/')}`;
}

/** Readable form of a stored template key (rule labels): percent-escapes decoded, "https://" dropped. */
export function templateKeyText(key: string, withScheme = false): string {
  let text = key;
  try {
    text = decodeURI(key);
  } catch {
    text = key;
  }
  return withScheme ? text : text.replace(/^https:\/\//i, '');
}

/** A stored template key is well formed: an http(s) origin followed by an absolute path, no query / hash. */
export function isTemplateKey(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^/?#\s]+\/[^?#\s]*$/i.test(value);
}

// ------------------------------------------------------------------------------------------- elision

/** One item of a laid-out path: a segment (by index) or the "…" standing for elided segments. */
export type DisplayItem = { type: 'seg'; index: number } | { type: 'gap'; hidden: number[] };

/** Characters a chip takes: its text plus about one character of padding. */
const CHIP_PAD = 1;

/** Approximate width of a segment in monospace characters (chips include their padding). */
export function segmentCost(seg: TemplateSegment): number {
  if (seg.type === 'lit') return Array.from(seg.text).length;
  return seg.prefix.length + seg.suffix.length + Array.from(chipText(seg)).length + CHIP_PAD;
}

/** Width of a laid-out path: the leading "/", the items and the "/" between them. */
export function itemsCost(segments: readonly TemplateSegment[], items: readonly DisplayItem[]): number {
  let cost = 1;
  items.forEach((item, i) => {
    if (i > 0) cost += 1;
    cost += item.type === 'gap' ? 1 : segmentCost(segments[item.index]!);
  });
  return cost;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

function compose(n: number, head: boolean, tailStart: number): DisplayItem[] {
  const items: DisplayItem[] = [];
  const firstShown = head ? 1 : 0;
  if (head) items.push({ type: 'seg', index: 0 });
  if (tailStart > firstShown) items.push({ type: 'gap', hidden: range(firstShown, tailStart) });
  for (let i = tailStart; i < n; i++) items.push({ type: 'seg', index: i });
  return items;
}

/** Index of the `nth` (1-based) non-empty literal segment counted from the end, or -1. */
function literalFromEnd(segments: readonly TemplateSegment[], nth: number): number {
  let seen = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.type === 'lit' && seg.text !== '' && ++seen === nth) return i;
  }
  return -1;
}

/**
 * Fit a path into `budget` characters. Everything when it fits; otherwise the last meaningful segments — the last
 * two literal segments with their params ("reports/{uuid}/items/{id}"), else the last one ("items/{id}") — then
 * the first segment after the host when space allows, then more trailing segments; the elided middle becomes one
 * "…" gap. When even the last literal does not fit, "…/" + the last segment (the caller truncates the rest).
 */
export function elideSegments(segments: readonly TemplateSegment[], budget: number): DisplayItem[] {
  const n = segments.length;
  if (n === 0) return [];
  const all = compose(n, false, 0);
  if (itemsCost(segments, all) <= budget) return all;
  const fits = (items: DisplayItem[]) => itemsCost(segments, items) <= budget;
  const last = segments[n - 1]!.type === 'param' ? literalFromEnd(segments, 1) : n - 1;
  const second = literalFromEnd(segments, 2);
  const candidates = [second, last >= 0 ? last : n - 1].filter((i) => i >= 0 && i <= n - 1);
  let tailStart = -1;
  for (const start of candidates) {
    if (fits(compose(n, false, start))) {
      tailStart = start;
      break;
    }
  }
  if (tailStart < 0) return n === 1 ? all : compose(n, false, n - 1);
  if (tailStart === 0) return all;
  // The first segment after the host — only once the meaningful tail is complete (a lone "api" before a cut tail
  // is noise), and when it still leaves an elided middle (else it is just part of the tail).
  const head = (second < 0 || tailStart <= second) && tailStart > 1 && fits(compose(n, true, tailStart));
  const floor = head ? 1 : 0;
  while (tailStart > floor) {
    const next = compose(n, head, tailStart - 1);
    if (!fits(next)) break;
    tailStart--;
  }
  return compose(n, head, tailStart);
}

// ------------------------------------------------------------------------------------------- query

export interface QueryName {
  name: string;
  /** What the summary shows: the name, or "name=value" for an id-like value in a concrete template. */
  label: string;
  /** Every value of the parameter (duplicates kept, in order). */
  values: string[];
  /** Some value is id-like. */
  idLike: boolean;
}

export interface QuerySummary {
  /** Names shown, in URL order (each once). */
  shown: QueryName[];
  /** Further parameter names not shown ("2 more"; with no name shown: "?3 params"). */
  more: number;
  /** All names (for the tooltip). */
  all: QueryName[];
  /** Tightest form: just "?3" (no name shown, `more` = the count). */
  mini?: boolean;
}

/**
 * Query parameters by name (first-appearance order, values collected). With `values` (concrete templates),
 * id-like parameters are labelled "name=value" (shortened).
 */
export function queryNames(items: readonly QueryItem[], values = false): QueryName[] {
  const byName = new Map<string, QueryName>();
  for (const item of items) {
    let entry = byName.get(item.name);
    if (!entry) {
      entry = { name: item.name, label: item.name || '(empty)', values: [], idLike: false };
      byName.set(item.name, entry);
    }
    entry.values.push(item.value);
    if (item.kind && !entry.idLike) {
      entry.idLike = true;
      if (values) entry.label = `${entry.name}=${shortValue(item.value)}`;
    }
  }
  return [...byName.values()];
}

const QUERY_SEP = 3; // " · "
/** Gap between the path and the query summary (6 px ≈ one character). */
const QUERY_GAP = 1;

/** "3 params" — the compact query summary (no name shown). */
export function paramCountText(count: number): string {
  return `${count} param${count === 1 ? '' : 's'}`;
}

/** Width of a query summary: "?a · b · 2 more" (or "?3 params" when no name is shown). */
export function summaryCost(summary: Pick<QuerySummary, 'shown' | 'more' | 'mini'>): number {
  if (!summary.shown.length && !summary.more) return 0;
  if (summary.mini) return 1 + String(summary.more).length;
  if (!summary.shown.length) return 1 + paramCountText(summary.more).length;
  let cost = 1;
  summary.shown.forEach((q, i) => {
    cost += (i > 0 ? QUERY_SEP : 0) + Math.max(1, Array.from(q.label).length);
  });
  if (summary.more) cost += (summary.shown.length ? QUERY_SEP : 0) + `${summary.more} more`.length;
  return cost;
}

/** Names that fit `budget` characters ("?companyId · page · 2 more"); at least the first name is shown. */
export function summarizeQuery(items: readonly QueryItem[], budget: number, values = false): QuerySummary | null {
  const all = queryNames(items, values);
  if (!all.length) return null;
  const shown: QueryName[] = [];
  for (let i = 0; i < all.length; i++) {
    const candidate = [...shown, all[i]!];
    const more = all.length - candidate.length;
    if (shown.length > 0 && summaryCost({ shown: candidate, more }) > budget) break;
    shown.push(all[i]!);
  }
  return { shown, more: all.length - shown.length, all };
}

/** Tooltip of a query summary: one "name=value" line per parameter. */
export function queryTitle(names: readonly QueryName[]): string {
  return names.map((q) => q.values.map((v) => `${q.name}=${v}`).join('\n')).join('\n');
}

// ------------------------------------------------------------------------------------------- label layout

export interface LabelLayout {
  items: DisplayItem[];
  query: QuerySummary | null;
  /** The host fits beside the label (callers decide whether it is wanted at all). */
  host: boolean;
}

/** Hosts are drawn in the smaller UI font: about 0.8 monospace characters per character. */
const HOST_FACTOR = 0.8;

/** The tail of a laid-out path (first index after its last gap), or 0 when nothing is elided. */
function tailStartOf(items: readonly DisplayItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === 'gap') {
      const next = items[i + 1];
      return next && next.type === 'seg' ? next.index : Number.POSITIVE_INFINITY;
    }
  }
  return 0;
}

/**
 * Lay out a label within `budget` monospace characters. Priorities: the meaningful tail of the path (its last two
 * literal segments with their params: "reports/{uuid}/items/{id}"), then the first query name ("?companyId ·
 * 2 more"), then the host (when `withHost`), then the first path segment and more of the path, then more query
 * names. When even that does not fit, the query shrinks to a count ("?3 params") and the path to its last literal.
 */
export function layoutLabel(t: EndpointTemplate, budget: number, withHost = false): LabelLayout {
  const room = Math.max(1, Math.floor(budget));
  const n = t.segments.length;
  const names = queryNames(t.query, t.concrete);
  const hostCost = withHost && t.host ? Math.ceil(t.host.length * HOST_FACTOR) + 2 : 0;
  const fullQuery: QuerySummary | null = names.length ? { shown: names, more: 0, all: names } : null;
  const fullItems = compose(n, false, 0);
  const pathFull = itemsCost(t.segments, fullItems);
  // The query sits 6 px (about a character) after the path.
  const queryCost = (q: QuerySummary | null) => (q ? summaryCost(q) + (n ? QUERY_GAP : 0) : 0);
  if (pathFull + queryCost(fullQuery) + hostCost <= room) return { items: n ? fullItems : [], query: fullQuery, host: hostCost > 0 };

  const second = literalFromEnd(t.segments, 2);
  const essential = second < 0 ? 0 : second;
  const firstName: QuerySummary | null = names.length ? { shown: names.slice(0, 1), more: names.length - 1, all: names } : null;
  const compact: QuerySummary | null = names.length ? { shown: [], more: names.length, all: names } : null;
  const mini: QuerySummary | null = names.length ? { shown: [], more: names.length, all: names, mini: true } : null;
  const attempts: Array<{ host: boolean; query: QuerySummary | null }> = [];
  for (const host of hostCost > 0 ? [true, false] : [false]) {
    attempts.push({ host, query: fullQuery }, { host, query: firstName });
  }
  for (const host of hostCost > 0 ? [true, false] : [false]) attempts.push({ host, query: compact });
  attempts.push({ host: false, query: mini });

  for (const attempt of attempts) {
    const left = room - (attempt.host ? hostCost : 0);
    const pathRoom = left - queryCost(attempt.query);
    if (pathRoom < 1) continue;
    const items = elideSegments(t.segments, pathRoom);
    if (itemsCost(t.segments, items) > pathRoom || tailStartOf(items) > essential) continue;
    let query = attempt.query;
    // Room the path did not need goes to more query names.
    if (query && query.shown.length < names.length) {
      const spare = left - itemsCost(t.segments, items) - (n ? QUERY_GAP : 0);
      const wider = summarizeQuery(t.query, spare, t.concrete);
      if (wider && summaryCost(wider) <= spare && wider.shown.length > query.shown.length) query = wider;
    }
    return { items, query, host: attempt.host };
  }
  // Very tight: the last literal (or segment) and the parameter count.
  const items = elideSegments(t.segments, Math.max(1, room - queryCost(mini)));
  return { items, query: mini, host: false };
}

// ------------------------------------------------------------------------------------------- grouping

/** Grouping key of an entry: method + endpoint template key ("GET https://h/reports/{uuid}"). */
export function groupKeyOf(entry: Pick<RequestEntry, 'method' | 'url'>): string {
  return `${(entry.method || 'GET').toUpperCase()} ${templateKeyOf(entry.url)}`;
}

/** Status class of a call for the mixed-status indicator: '2xx' … '5xx', 'error', 'aborted', null (pending). */
export function outcomeOf(entry: RequestEntry): string | null {
  if (entry.state === 'pending') return null;
  if (entry.state === 'error') return 'error';
  if (entry.state === 'aborted') return 'aborted';
  if (typeof entry.status === 'number' && entry.status >= 100 && entry.status <= 599) return `${Math.floor(entry.status / 100)}xx`;
  return 'unknown';
}

export interface GroupStats {
  count: number;
  pending: number;
  /** Outcome classes seen (finished calls), most frequent first. */
  outcomes: Array<{ outcome: string; count: number }>;
  /** More than one outcome class among finished calls. */
  mixed: boolean;
  /** Mean duration of finished calls (ms), null when none. */
  avgMs: number | null;
  /** Duration of the newest finished call (ms), null when none. */
  lastMs: number | null;
  /** startTime of the newest call (epoch ms). */
  newestTime: number;
  /** startTime of the oldest call (epoch ms). */
  oldestTime: number;
}

/** Aggregate the calls of a group (any order). */
export function aggregateGroup(entries: readonly RequestEntry[]): GroupStats {
  let pending = 0;
  let total = 0;
  let timed = 0;
  let newest: RequestEntry | null = null;
  let lastFinished: RequestEntry | null = null;
  let oldestTime = Infinity;
  const outcomes = new Map<string, number>();
  for (const entry of entries) {
    if (!newest || entry.startTime > newest.startTime) newest = entry;
    oldestTime = Math.min(oldestTime, entry.startTime);
    const outcome = outcomeOf(entry);
    if (outcome === null) {
      pending++;
      continue;
    }
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    const ms = durationMs(entry);
    if (ms !== null) {
      total += ms;
      timed++;
      if (!lastFinished || entry.startTime > lastFinished.startTime) lastFinished = entry;
    }
  }
  const sorted = [...outcomes.entries()].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count);
  return {
    count: entries.length,
    pending,
    outcomes: sorted,
    mixed: sorted.length > 1,
    avgMs: timed ? total / timed : null,
    lastMs: lastFinished ? durationMs(lastFinished) : null,
    newestTime: newest ? newest.startTime : 0,
    oldestTime: Number.isFinite(oldestTime) ? oldestTime : 0,
  };
}

export interface EndpointGroup {
  /** Grouping key (method + template key). */
  key: string;
  method: string;
  /** Template of the newest call. */
  template: EndpointTemplate;
  /** Calls, newest first. */
  entries: RequestEntry[];
  newest: RequestEntry;
  stats: GroupStats;
}

/** A group row of the list. */
export type GroupRow = Extract<ListRow, { type: 'group' }>;

export interface GroupOptions {
  /** Group row keys that are expanded. */
  expanded: ReadonlySet<string>;
}

/** Calls that are never grouped: requests the user made, and a selected entry only listed while selected. */
function groupable(row: EntryRow): boolean {
  return !row.hidden && row.entry.kind !== 'manual' && row.entry.source !== 'manual';
}

/**
 * "Group by endpoint": within each section of the list (current page; each previous page after its separator),
 * calls sharing method + host + path template collapse into one group row (≥ 2 calls), placed where its newest call
 * was; expanded groups list their calls (newest first, `group` set) right below. Ordinals are recomputed over the
 * option rows (groups and calls).
 */
export function groupListRows(rows: readonly ListRow[], options: GroupOptions): ListRow[] {
  const out: ListRow[] = [];
  let section: EntryRow[] = [];
  let sectionIndex = 0;
  const flush = () => {
    if (!section.length) return;
    const buckets = new Map<string, EntryRow[]>();
    for (const row of section) {
      if (!groupable(row)) continue;
      const key = groupKeyOf(row.entry);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(row);
      else buckets.set(key, [row]);
    }
    const emitted = new Set<string>();
    for (const row of section) {
      const key = groupable(row) ? groupKeyOf(row.entry) : null;
      const bucket = key ? buckets.get(key) : undefined;
      if (!key || !bucket || bucket.length < 2) {
        out.push(row);
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      const entries = bucket.map((r) => r.entry);
      const rowKey = `g:${sectionIndex}:${key}`;
      const expanded = options.expanded.has(rowKey);
      out.push({
        type: 'group',
        key: rowKey,
        ordinal: 0,
        expanded,
        group: {
          key,
          method: (entries[0]!.method || 'GET').toUpperCase(),
          template: endpointTemplate(entries[0]!.url),
          entries,
          newest: entries[0]!,
          stats: aggregateGroup(entries),
        },
      });
      if (expanded) for (const r of bucket) out.push({ ...r, group: rowKey });
    }
    section = [];
  };
  for (const row of rows) {
    if (row.type === 'entry') {
      section.push(row);
      continue;
    }
    flush();
    sectionIndex++;
    out.push(row);
  }
  flush();
  let ordinal = 0;
  return out.map((row) => (row.type === 'separator' ? row : { ...row, ordinal: ++ordinal }));
}

// ------------------------------------------------------------------------------------------- hosts

const pageHosts = new Map<string, string>();

/** Host of a page URL (cached: every entry of a page carries the same pageUrl). */
function pageHostOf(pageUrl: string): string {
  let host = pageHosts.get(pageUrl);
  if (host === undefined) {
    try {
      host = new NativeURL(pageUrl).host;
    } catch {
      host = '';
    }
    if (pageHosts.size >= 256) pageHosts.clear();
    pageHosts.set(pageUrl, host);
  }
  return host;
}

/**
 * Which rows show their host inline (narrow lists; wide lists have a host column): a row without a host label is
 * on the same host as the row above it, the first row of a section (or after a separator) on the page's host.
 * Separators get false.
 */
export function inlineHostFlags(rows: readonly ListRow[]): boolean[] {
  let previous: string | null = null;
  return rows.map((row) => {
    if (row.type === 'separator') {
      previous = null;
      return false;
    }
    const entry = row.type === 'group' ? row.group.newest : row.entry;
    const t = endpointTemplate(entry.url);
    if (!t.http) return false;
    const before = previous ?? pageHostOf(entry.pageUrl);
    previous = t.host;
    return t.host !== before;
  });
}
