// OWNER: ui-list-menu agent. Request-list URL rules ("Hide requests under …" / "Show only requests under …"):
// pure matching, the path-prefix ladder offered by the row context menu, rule-list edits and labels.
// No DOM; unit tested (tests/unit/list-rules.test.ts).
//
// A rule pattern is an origin + path without query or hash (see ListRule in src/shared/types.ts). Matching
// compares it with the entry URL's origin + pathname: origins case-insensitively (the URL parser lower-cases
// scheme and host and drops default ports), paths case-sensitively. Percent-escapes are normalized on both
// sides (hex digits upper-cased, escaped unreserved characters decoded), so `/caf%c3%a9` and `/café` match.
// Non-http(s) URLs (data:, blob:, about:, unparsable) have no path hierarchy: only exact rules on the URL
// without query/hash apply to them.
import { MAX_LIST_RULE_PATTERN, MAX_LIST_RULES } from '../../shared/constants';
import type { ListRule, RequestEntry } from '../../shared/types';
import { endpointTemplate, isTemplateKey, templateKeyOf, templateKeyText } from './endpointLabel';

/** Captured at module evaluation so nothing patched later can interfere. */
const NativeURL = URL;

/** One step of the path-prefix ladder of a URL. */
export interface PathPrefix {
  /** Rule pattern: origin + path, no query / hash (normalized like rule matching). */
  pattern: string;
  /** The exact path (any query string) rather than "this path and everything below it". */
  exact: boolean;
}

/** What a rule needs to identify: mode, pattern and exact flag (or its method / endpoint template). */
export type RuleSpec = Pick<ListRule, 'mode' | 'pattern' | 'exact' | 'method' | 'template'>;

/** What a rule matches: a URL pattern, (method rules) an HTTP method or (template rules) an endpoint template. */
export type RuleMatch = Pick<ListRule, 'pattern' | 'exact' | 'method' | 'template'>;

function entryMethod(entry: RequestEntry): string {
  return (entry.method || 'GET').toUpperCase();
}

/** URL as seen by rule matching. */
type Target =
  /** http(s): lower-case origin ("https://api.example.com:8443") and normalized pathname (starts with '/'). */
  | { kind: 'path'; origin: string; path: string }
  /** Anything else: the URL without query / hash (scheme lower-cased). Only exact rules match it. */
  | { kind: 'opaque'; key: string };

const UNRESERVED = /^[A-Za-z0-9._~-]$/;
const HTTP_PROTOCOL = /^https?:$/;

/** Upper-case percent-escape hex digits and decode escaped unreserved characters (RFC 3986 §6.2.2). */
function normalizeEscapes(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/** The URL up to its first '?' or '#', scheme lower-cased. */
function opaqueKey(url: string): string {
  const raw = url.trim();
  let end = raw.length;
  const q = raw.indexOf('?');
  const h = raw.indexOf('#');
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  const base = raw.slice(0, end);
  const colon = base.indexOf(':');
  return colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(base.slice(0, colon))
    ? `${base.slice(0, colon).toLowerCase()}${base.slice(colon)}`
    : base;
}

function targetOf(url: string): Target {
  let parsed: URL | null = null;
  try {
    parsed = new NativeURL(url);
  } catch {
    parsed = null;
  }
  if (parsed && HTTP_PROTOCOL.test(parsed.protocol) && parsed.host) {
    return { kind: 'path', origin: parsed.origin.toLowerCase(), path: normalizeEscapes(parsed.pathname || '/') };
  }
  return { kind: 'opaque', key: opaqueKey(url) };
}

// Entries are immutable (a change produces a new object), so caching per object is safe.
const entryTargets = new WeakMap<RequestEntry, Target>();
// Patterns come from a short list (rules, ladder items); bounded anyway.
const patternTargets = new Map<string, Target>();
const PATTERN_CACHE_MAX = 512;

/** Endpoint-template key of an entry's URL (cached in endpointLabel.ts by URL). */
function entryTemplate(entry: RequestEntry): string {
  return templateKeyOf(typeof entry.url === 'string' ? entry.url : '');
}

function entryTarget(entry: RequestEntry): Target {
  let target = entryTargets.get(entry);
  if (!target) {
    target = targetOf(typeof entry.url === 'string' ? entry.url : '');
    entryTargets.set(entry, target);
  }
  return target;
}

function patternTarget(pattern: string): Target {
  let target = patternTargets.get(pattern);
  if (!target) {
    target = targetOf(pattern);
    if (patternTargets.size >= PATTERN_CACHE_MAX) patternTargets.clear();
    patternTargets.set(pattern, target);
  }
  return target;
}

function targetKey(target: Target): string {
  return target.kind === 'path' ? `${target.origin}${target.path}` : target.key;
}

function targetMatches(url: Target, pattern: Target, exact: boolean): boolean {
  if (url.kind === 'opaque' || pattern.kind === 'opaque') {
    return url.kind === 'opaque' && pattern.kind === 'opaque' && url.key !== '' && url.key === pattern.key;
  }
  if (url.origin !== pattern.origin) return false;
  if (url.path === pattern.path) return true;
  if (exact) return false;
  // "/a/" covers "/a/…"; a prefix written without its trailing slash ("/a") covers "/a" and "/a/…", not "/ab".
  const dir = pattern.path.endsWith('/') ? pattern.path : `${pattern.path}/`;
  return url.path.startsWith(dir);
}

/** Pattern in canonical form (as rule matching sees it), used to compare rules. */
export function canonicalPattern(pattern: string): string {
  return targetKey(patternTarget(pattern));
}

/**
 * The path-prefix ladder of a URL, shortest first: the origin, every directory above the last path segment,
 * then the exact path (`exact: true`). Query and hash are ignored.
 *   https://h/a/b/list?x=1 -> https://h/, https://h/a/, https://h/a/b/, https://h/a/b/list (exact)
 *   https://h/a/b/         -> https://h/, https://h/a/, https://h/a/b/ (exact)
 *   https://h/             -> https://h/
 *   data:, blob:, …        -> only the exact URL (no query / hash); nothing for an empty URL.
 */
export function pathPrefixes(url: string): PathPrefix[] {
  const target = targetOf(url);
  if (target.kind === 'opaque') return target.key ? [{ pattern: target.key, exact: true }] : [];
  const prefixes: PathPrefix[] = [{ pattern: `${target.origin}/`, exact: false }];
  if (target.path === '/') return prefixes;
  const segments = target.path.split('/');
  let dir = '/';
  for (let i = 1; i < segments.length - 1; i++) {
    dir += `${segments[i]}/`;
    if (dir === target.path) break; // a trailing-slash path: its own directory is the exact item
    prefixes.push({ pattern: `${target.origin}${dir}`, exact: false });
  }
  prefixes.push({ pattern: `${target.origin}${target.path}`, exact: true });
  return prefixes;
}

/**
 * The ladder of an endpoint template (group rows): the directory prefixes of `url` whose segments are all literal
 * in its template (so every call of the endpoint falls under them), shortest first; never the exact path.
 *   https://h/a/reports/9f3c…/items/12 (template /a/reports/{uuid}/items/{id}) -> https://h/, https://h/a/,
 *   https://h/a/reports/
 */
export function templatePrefixes(url: string): PathPrefix[] {
  const t = endpointTemplate(url);
  if (!t.http) return [];
  const firstParam = t.segments.findIndex((s) => s.type === 'param');
  const literal = firstParam < 0 ? t.segments.length : firstParam;
  // The i-th directory prefix covers i leading segments.
  return pathPrefixes(url)
    .filter((p) => !p.exact)
    .filter((_, i) => i <= literal);
}

/** Whether the entry's URL falls under the rule's pattern (ignores `enabled`, `mode` and manual entries). */
export function matchesRule(entry: RequestEntry, rule: RuleMatch): boolean {
  if (rule.method) return entryMethod(entry) === rule.method;
  if (rule.template) return entryTemplate(entry) === rule.template;
  return targetMatches(entryTarget(entry), patternTarget(rule.pattern), rule.exact);
}

/** Requests the user made ("+ New", "Duplicate as new request") are never hidden by rules. */
export function isRuleExempt(entry: RequestEntry): boolean {
  return entry.kind === 'manual' || entry.source === 'manual';
}

/** The enabled rules, ready to test entries against. */
export interface CompiledRules {
  /** At least one enabled rule. */
  readonly active: boolean;
  /** True when the rules hide `entry`. */
  hides(entry: RequestEntry): boolean;
}

/**
 * Compile rules: an entry is hidden when an enabled 'hide' rule matches it, or when enabled 'only' rules exist
 * and none matches it. Disabled rules are ignored; manual entries are never hidden.
 */
export function compileRules(rules: readonly ListRule[] | null | undefined): CompiledRules {
  const hide: CompiledMatch[] = [];
  const only: CompiledMatch[] = [];
  for (const rule of rules ?? []) {
    if (!rule.enabled) continue;
    (rule.mode === 'only' ? only : hide).push(compileMatch(rule));
  }
  const active = hide.length + only.length > 0;
  return {
    active,
    hides(entry) {
      if (!active || isRuleExempt(entry)) return false;
      for (const r of hide) if (matchCompiled(entry, r)) return true;
      if (only.length === 0) return false;
      // Only-rules of the same dimension are alternatives; URL (prefix / template) and method dimensions must
      // both pass.
      const onlyUrl = only.filter((r) => !r.method);
      const onlyMethod = only.filter((r) => r.method);
      if (onlyUrl.length && !onlyUrl.some((r) => matchCompiled(entry, r))) return true;
      if (onlyMethod.length && !onlyMethod.some((r) => matchCompiled(entry, r))) return true;
      return false;
    },
  };
}

interface CompiledMatch {
  target: Target | null;
  exact: boolean;
  method?: string;
  template?: string;
}

function compileMatch(rule: RuleMatch): CompiledMatch {
  if (rule.method) return { target: null, exact: true, method: rule.method };
  if (rule.template) return { target: null, exact: true, template: rule.template };
  return { target: patternTarget(rule.pattern), exact: rule.exact };
}

function matchCompiled(entry: RequestEntry, m: CompiledMatch): boolean {
  if (m.method) return entryMethod(entry) === m.method;
  if (m.template) return entryTemplate(entry) === m.template;
  return targetMatches(entryTarget(entry), m.target!, m.exact);
}

/** The entries the rules keep (order preserved). */
export function applyRules(entries: readonly RequestEntry[], rules: readonly ListRule[] | null | undefined): RequestEntry[] {
  const compiled = compileRules(rules);
  if (!compiled.active) return entries.slice();
  return entries.filter((entry) => !compiled.hides(entry));
}

/**
 * How many entries each pattern matches (manual entries excluded: rules never apply to them). One pass over
 * the entries; `counts[i]` belongs to `patterns[i]`.
 */
export function countMatches(
  entries: readonly RequestEntry[],
  patterns: ReadonlyArray<RuleMatch>,
): number[] {
  const compiled = patterns.map(compileMatch);
  const counts = compiled.map(() => 0);
  if (!compiled.length) return counts;
  for (const entry of entries) {
    if (isRuleExempt(entry)) continue;
    for (let i = 0; i < compiled.length; i++) {
      if (matchCompiled(entry, compiled[i]!)) counts[i]!++;
    }
  }
  return counts;
}

// --------------------------------------------------------------------------------------------- editing

/** Same mode, exact flag and (canonical) pattern. */
export function sameRule(a: RuleSpec, b: RuleSpec): boolean {
  if (a.method || b.method) return a.mode === b.mode && a.method === b.method;
  if (a.template || b.template) return a.mode === b.mode && a.template === b.template;
  return a.mode === b.mode && a.exact === b.exact && canonicalPattern(a.pattern) === canonicalPattern(b.pattern);
}

/** The rule identical to `spec` (mode + pattern + exact), if any. */
export function findRule(rules: readonly ListRule[], spec: RuleSpec): ListRule | undefined {
  return rules.find((rule) => sameRule(rule, spec));
}

/** Whether `pattern` can be stored as a rule (settings drop longer / empty patterns). */
export function isStorablePattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_LIST_RULE_PATTERN;
}

export type AddRuleOutcome =
  /** A new rule was appended. */
  | 'added'
  /** An identical disabled rule was re-enabled instead of adding a duplicate. */
  | 'enabled'
  /** An identical enabled rule already exists; nothing changed. */
  | 'exists'
  /** MAX_LIST_RULES reached; nothing changed. */
  | 'limit'
  /** Empty or over-long pattern; nothing changed. */
  | 'invalid';

export interface AddRuleResult {
  rules: ListRule[];
  outcome: AddRuleOutcome;
  /** The rule that was added / re-enabled / already existed (null for 'limit' and 'invalid'). */
  rule: ListRule | null;
}

/**
 * Add a rule. An identical rule (mode + pattern + exact) is re-enabled instead of duplicated. `rules` is never
 * mutated; it is returned as is when nothing changes.
 */
export function addRule(
  rules: readonly ListRule[],
  spec: RuleSpec,
  init: { id: string; now: number },
): AddRuleResult {
  const list = rules as ListRule[];
  if (spec.template) {
    if (!isTemplateKey(spec.template) || !isStorablePattern(spec.template)) return { rules: list, outcome: 'invalid', rule: null };
  } else if (!spec.method && !isStorablePattern(spec.pattern)) return { rules: list, outcome: 'invalid', rule: null };
  const existing = findRule(rules, spec);
  if (existing) {
    if (existing.enabled) return { rules: list, outcome: 'exists', rule: existing };
    const enabled = { ...existing, enabled: true };
    return { rules: rules.map((r) => (r === existing ? enabled : r)), outcome: 'enabled', rule: enabled };
  }
  if (rules.length >= MAX_LIST_RULES) return { rules: list, outcome: 'limit', rule: null };
  const rule: ListRule = spec.template
    ? { id: init.id, mode: spec.mode, pattern: '', template: spec.template, exact: true, enabled: true, createdAt: init.now }
    : {
        id: init.id,
        mode: spec.mode,
        pattern: spec.method ? '' : spec.pattern,
        ...(spec.method ? { method: spec.method } : {}),
        exact: spec.method ? true : spec.exact,
        enabled: true,
        createdAt: init.now,
      };
  return { rules: [...rules, rule], outcome: 'added', rule };
}

/** Undo an `addRule`: remove the rule it added, or disable the rule it re-enabled. */
export function revertAddRule(rules: readonly ListRule[], result: AddRuleResult): ListRule[] {
  if (!result.rule) return rules as ListRule[];
  if (result.outcome === 'added') return removeRule(rules, result.rule.id);
  if (result.outcome === 'enabled') return setRuleEnabled(rules, result.rule.id, false);
  return rules as ListRule[];
}

/** Enable / disable one rule (same array when nothing changes). */
export function setRuleEnabled(rules: readonly ListRule[], id: string, enabled: boolean): ListRule[] {
  const index = rules.findIndex((r) => r.id === id);
  const rule = rules[index];
  if (!rule || rule.enabled === enabled) return rules as ListRule[];
  const next = rules.slice();
  next[index] = { ...rule, enabled };
  return next;
}

/** Flip one rule's `enabled`. */
export function toggleRule(rules: readonly ListRule[], id: string): ListRule[] {
  const rule = rules.find((r) => r.id === id);
  return rule ? setRuleEnabled(rules, id, !rule.enabled) : (rules as ListRule[]);
}

/** Remove one rule (same array when absent). */
export function removeRule(rules: readonly ListRule[], id: string): ListRule[] {
  return rules.some((r) => r.id === id) ? rules.filter((r) => r.id !== id) : (rules as ListRule[]);
}

/** Put a removed rule back at its old position (undo of a delete). Same array when it is still there. */
export function restoreRule(rules: readonly ListRule[], rule: ListRule, index: number): ListRule[] {
  if (rules.some((r) => r.id === rule.id)) return rules as ListRule[];
  const at = Math.min(Math.max(0, index), rules.length);
  return [...rules.slice(0, at), rule, ...rules.slice(at)];
}

// --------------------------------------------------------------------------------------------- labels

/** Code-point-safe middle truncation: "abcdef…uvwxyz" (at most `max` characters, `max` >= 2). */
export function shortenMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = Math.max(1, max - 1);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(chars.length - tail).join('') : ''}`;
}

function safeDecodeURI(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/**
 * Shorten "host/a/b/c/d" by dropping middle path segments ("host/…/c/d"), keeping the host and as many
 * trailing segments as fit; falls back to middle truncation.
 */
export function shortenUrlText(text: string, max: number): string {
  const length = (s: string) => Array.from(s).length;
  if (length(text) <= max) return text;
  const schemeEnd = text.indexOf('//');
  const slash = text.indexOf('/', schemeEnd >= 0 ? schemeEnd + 2 : 0);
  if (slash < 0) return shortenMiddle(text, max);
  const head = `${text.slice(0, slash + 1)}…/`; // "https://host/…/"
  // Segments with their trailing slash: "a/b/list" -> ["a/", "b/", "list"]; "a/b/" -> ["a/", "b/"].
  const parts = text.slice(slash + 1).match(/[^/]*\/|[^/]+$/g) ?? [];
  let tail = '';
  // parts[0] is always dropped (the whole text does not fit).
  for (let i = parts.length - 1; i >= 1; i--) {
    const next = `${parts[i]}${tail}`;
    if (length(head) + length(next) > max) break;
    tail = next;
  }
  return tail ? `${head}${tail}` : shortenMiddle(text, max);
}

/** Readable form of a pattern: percent-escapes decoded where safe, "https://" dropped unless `withScheme`. */
export function patternText(pattern: string, withScheme = false): string {
  const target = patternTarget(pattern);
  if (target.kind === 'opaque') return target.key;
  const origin = withScheme || !target.origin.startsWith('https://') ? target.origin : target.origin.slice(8);
  return `${origin}${safeDecodeURI(target.path)}`;
}

/** Suffix of an exact ladder item / rule. */
export const EXACT_SUFFIX = '(exact path, any query)';

/** URL text of a ladder item: the full URL prefix, scheme included, middle-shortened beyond `max` characters. */
export function prefixText(prefix: PathPrefix, max = 80): string {
  return shortenUrlText(patternText(prefix.pattern, true), max);
}

/** Full label of a ladder item: its URL text, exact items suffixed with EXACT_SUFFIX. */
export function prefixLabel(prefix: PathPrefix, max = 80): string {
  const text = prefixText(prefix, max);
  return prefix.exact ? `${text} ${EXACT_SUFFIX}` : text;
}

/**
 * Chip label of a rule: "Hidden: api.example.com/standard/…" / "Only: api.example.com/a/list-all". Prefix rules
 * end with "…" (that path and everything below it); exact rules show the bare path.
 */
export function ruleLabel(rule: RuleSpec, max = 48): string {
  if (rule.method) return `${rule.mode === 'hide' ? 'Hidden' : 'Only'}: ${rule.method} requests`;
  if (rule.template) {
    return `${rule.mode === 'hide' ? 'Hidden' : 'Only'}: ${shortenUrlText(templateKeyText(rule.template), Math.max(8, max))}`;
  }
  const target = patternTarget(rule.pattern);
  const text = patternText(rule.pattern);
  const below = !rule.exact && target.kind === 'path';
  const shown = shortenUrlText(text, Math.max(8, max - (below ? 1 : 0)));
  return `${rule.mode === 'hide' ? 'Hidden' : 'Only'}: ${shown}${below ? '…' : ''}`;
}

/**
 * Sentence describing a rule: "Hide requests under https://h/a/" (imperative: tooltips) or "Hiding requests
 * under …" (progressive: toasts). Long URLs are shortened.
 */
export function ruleDescription(rule: RuleSpec, style: 'imperative' | 'progressive' = 'imperative'): string {
  if (rule.method) {
    const verbM = style === 'progressive' ? (rule.mode === 'hide' ? 'Hiding' : 'Showing only') : rule.mode === 'hide' ? 'Hide' : 'Show only';
    return `${verbM} ${rule.method} requests`;
  }
  if (rule.template) {
    const verbT = style === 'progressive' ? (rule.mode === 'hide' ? 'Hiding' : 'Showing only') : rule.mode === 'hide' ? 'Hide' : 'Show only';
    return `${verbT} requests to the endpoint ${shortenUrlText(templateKeyText(rule.template, true), 96)} (any method, any query)`;
  }
  const where = shortenUrlText(patternText(rule.pattern, true), 96);
  const scope = rule.exact ? `to ${where} ${EXACT_SUFFIX}` : `under ${where}`;
  const verb =
    style === 'progressive'
      ? rule.mode === 'hide'
        ? 'Hiding'
        : 'Showing only'
      : rule.mode === 'hide'
        ? 'Hide'
        : 'Show only';
  return `${verb} requests ${scope}`;
}
