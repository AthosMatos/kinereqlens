/**
 * Validation of the request-list configuration kept in Settings — list rules, the type filter and Setups
 * (saved presets) — and the host patterns setups are auto-applied on. Pure and shared: the content script's
 * settings sanitizer (src/content/settings.ts) and the UI's setups model (src/ui/setups/model.ts) both use it.
 */
import {
  LIST_TYPE_IDS,
  MAX_LIST_RULE_PATTERN,
  MAX_LIST_RULES,
  MAX_SETUP_GROUP,
  MAX_SETUP_NAME,
  MAX_SETUP_SITES,
  MAX_SETUPS,
} from './constants';
import type { ListRule, ListTypeId, ReplayMode, Setup, SetupConfig } from './types';
import { normalizeLanguageValue } from './language';

/** Captured at module evaluation so nothing patched later can interfere. */
const NativeURL = URL;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------------------------------- list rules

const METHOD_TOKEN = /^[A-Z0-9!#$%&'*+.^_`|~-]{1,32}$/;
/** Endpoint-template rule value: an http(s) origin + absolute path template, no query / hash / whitespace. */
const TEMPLATE_KEY = /^https?:\/\/[^/?#\s]+\/[^?#\s]*$/i;

function isTemplateValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LIST_RULE_PATTERN && TEMPLATE_KEY.test(value);
}

/** Valid rules only (bad items dropped), at most MAX_LIST_RULES, duplicate ids dropped. */
export function sanitizeListRules(value: unknown): ListRule[] {
  if (!Array.isArray(value)) return [];
  const out: ListRule[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_LIST_RULES) break;
    if (!isRecord(item)) continue;
    const { id, mode, pattern, method, template, exact, enabled, createdAt } = item;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || ids.has(id)) continue;
    if (mode !== 'hide' && mode !== 'only') continue;
    if (template !== undefined) {
      // Endpoint-template rule (method-agnostic): the template is the whole match.
      if (!isTemplateValue(template) || method !== undefined) continue;
      ids.add(id);
      out.push({
        id,
        mode,
        pattern: '',
        template,
        exact: true,
        enabled: enabled !== false,
        createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
      });
      continue;
    }
    const methodRule = typeof method === 'string' && METHOD_TOKEN.test(method);
    if (method !== undefined && !methodRule) continue;
    if (typeof pattern !== 'string' || pattern.length > MAX_LIST_RULE_PATTERN) continue;
    if (!methodRule && pattern.length === 0) continue;
    ids.add(id);
    out.push({
      id,
      mode,
      pattern: methodRule ? '' : pattern,
      ...(methodRule ? { method: method as string } : {}),
      exact: exact === true,
      enabled: enabled !== false,
      createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    });
  }
  return out;
}

/** Value equality of two rule lists (ids included, order matters). */
export function listRulesEqual(a: readonly ListRule[], b: readonly ListRule[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i]!;
    return (
      r.id === o.id &&
      r.mode === o.mode &&
      r.pattern === o.pattern &&
      r.method === o.method &&
      r.template === o.template &&
      r.exact === o.exact &&
      r.enabled === o.enabled &&
      r.createdAt === o.createdAt
    );
  });
}

// ------------------------------------------------------------------------------------------- list types

const TYPE_IDS: ReadonlySet<string> = new Set(LIST_TYPE_IDS);

/** Whether `value` is a known list type id. */
export function isListTypeId(value: unknown): value is ListTypeId {
  return typeof value === 'string' && TYPE_IDS.has(value);
}

/** Known ids only, deduplicated, in menu order; every type selected collapses to [] (all types). */
export function normalizeListTypes(ids: Iterable<unknown>): ListTypeId[] {
  const set = new Set<string>();
  for (const id of ids) if (isListTypeId(id)) set.add(id);
  if (set.size === LIST_TYPE_IDS.length) return [];
  return LIST_TYPE_IDS.filter((id) => set.has(id));
}

/**
 * A stored type selection: not an array → `fallback`; a non-empty array without any known id → `fallback`
 * (an unknown selection must not silently become "all types"); otherwise `normalizeListTypes`.
 */
export function sanitizeListTypes(value: unknown, fallback: readonly ListTypeId[]): ListTypeId[] {
  if (!Array.isArray(value)) return fallback.slice();
  if (value.length > 0 && !value.some(isListTypeId)) return fallback.slice();
  return normalizeListTypes(value);
}

/** Same selection (both normalized). */
export function listTypesEqual(a: readonly ListTypeId[], b: readonly ListTypeId[]): boolean {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
}

// ------------------------------------------------------------------------------------------- host patterns

/** A parsed host pattern. */
export interface HostPattern {
  /** "*.example.com": the domain and every subdomain. */
  wildcard: boolean;
  /** Lower-case ASCII host (punycode for IDNs; IPv6 in brackets). */
  host: string;
  /** Port digits ('' = any port). */
  port: string;
}

const HOST_PORT = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Parse a host pattern (anything the user may type: "Api.Example.com", "*.example.com:8443", a full URL). */
export function parseHostPattern(input: unknown): HostPattern | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text || text.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // A pasted URL: its host (and explicit port).
    const at = text.indexOf('//') + 2;
    text = text.slice(at);
  }
  text = text.split(/[/?#]/, 1)[0] ?? '';
  if (text.includes('@')) return null;
  let wildcard = false;
  if (text.startsWith('*.')) {
    wildcard = true;
    text = text.slice(2);
  }
  if (!text || text.includes('*')) return null;
  const m = HOST_PORT.exec(text);
  if (!m) return null;
  const hostPart = m[1] ?? '';
  let port = '';
  if (m[2] !== undefined) {
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    port = String(n);
  }
  if (!hostPart || /[\s\\%]/.test(hostPart)) return null;
  let host: string;
  try {
    host = new NativeURL(`http://${hostPart}/`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.startsWith('.') || host.includes('..')) return null;
  if (wildcard && (IPV4.test(host) || host.startsWith('['))) return null;
  return { wildcard, host, port };
}

/** Canonical text of a host pattern ("*.example.com:8443"), or null when it is not a valid pattern. */
export function normalizeHostPattern(input: unknown): string | null {
  const p = parseHostPattern(input);
  return p ? hostPatternText(p) : null;
}

export function hostPatternText(p: HostPattern): string {
  return `${p.wildcard ? '*.' : ''}${p.host}${p.port ? `:${p.port}` : ''}`;
}

/** Host, effective port and whether the page is http(s) — what host patterns are matched against. */
export interface PageHost {
  host: string;
  /** Explicit port, or the scheme's default (443 / 80). */
  port: string;
  /** Host with a non-default port, as shown to the user and used for "Auto-apply on <host>". */
  display: string;
}

/** The host of a page URL (http / https only), or null. */
export function pageHostOf(pageUrl: string): PageHost | null {
  let url: URL;
  try {
    url = new NativeURL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return { host, port, display: url.port ? `${host}:${url.port}` : host };
}

/** Whether a page host matches a pattern ("*.example.com" also matches example.com itself). */
export function hostPatternMatches(pattern: HostPattern, page: PageHost): boolean {
  if (pattern.port && pattern.port !== page.port) return false;
  if (page.host === pattern.host) return true;
  return pattern.wildcard && page.host.endsWith(`.${pattern.host}`);
}

/**
 * How specific a pattern is, compared lexicographically: more host labels, then an exact host over a
 * wildcard, then an explicit port over any port.
 */
export function hostPatternSpecificity(pattern: HostPattern): [number, number, number] {
  return [pattern.host.split('.').length, pattern.wildcard ? 0 : 1, pattern.port ? 1 : 0];
}

// ------------------------------------------------------------------------------------------- setups

const SETUP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MODES: ReadonlyArray<ReplayMode> = ['page', 'extension'];

/** Whether `id` can be a setup id. */
export function isSetupId(id: unknown): id is string {
  return typeof id === 'string' && SETUP_ID.test(id);
}

/** Trim, collapse whitespace, drop control characters, cut to `max` code points. */
export function cleanLabel(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text;
}

/** Valid, canonical, unique host patterns (at most MAX_SETUP_SITES). */
export function sanitizeSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= MAX_SETUP_SITES) break;
    const pattern = normalizeHostPattern(item);
    if (pattern && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

/** A complete setup config, or null when `value` is not an object. */
export function sanitizeSetupConfig(value: unknown): SetupConfig | null {
  if (!isRecord(value)) return null;
  const config: SetupConfig = {
    listTypes: sanitizeListTypes(value.listTypes, ['fetch']),
    listRules: sanitizeListRules(value.listRules),
  };
  if (typeof value.defaultMode === 'string' && (MODES as readonly string[]).includes(value.defaultMode)) {
    config.defaultMode = value.defaultMode as ReplayMode;
  }
  const language = value.language === undefined ? null : normalizeLanguageValue(value.language);
  if (language) config.language = language;
  return config;
}

/** A valid setup, or null (bad id, empty name, missing config). */
export function sanitizeSetup(value: unknown): Setup | null {
  if (!isRecord(value)) return null;
  if (!isSetupId(value.id)) return null;
  const name = cleanLabel(value.name, MAX_SETUP_NAME);
  if (!name) return null;
  const config = sanitizeSetupConfig(value.config);
  if (!config) return null;
  const createdAt = timestamp(value.createdAt, 0);
  return {
    id: value.id,
    name,
    group: cleanLabel(value.group, MAX_SETUP_GROUP),
    sites: sanitizeSites(value.sites),
    config,
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  };
}

/** Valid setups only, duplicate ids dropped, at most MAX_SETUPS. */
export function sanitizeSetups(value: unknown): Setup[] {
  if (!Array.isArray(value)) return [];
  const out: Setup[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_SETUPS) break;
    const setup = sanitizeSetup(item);
    if (!setup || ids.has(setup.id)) continue;
    ids.add(setup.id);
    out.push(setup);
  }
  return out;
}

/** The active setup id when it names one of `setups`, else null. */
export function sanitizeActiveSetupId(value: unknown, setups: readonly Setup[]): string | null {
  return typeof value === 'string' && setups.some((s) => s.id === value) ? value : null;
}

function configsIdentical(a: SetupConfig, b: SetupConfig): boolean {
  return a.defaultMode === b.defaultMode && a.language === b.language && listTypesEqual(a.listTypes, b.listTypes) && listRulesEqual(a.listRules, b.listRules);
}

/** Value equality of two setup lists (order matters). */
export function setupsEqual(a: readonly Setup[], b: readonly Setup[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const o = b[i]!;
    return (
      s === o ||
      (s.id === o.id &&
        s.name === o.name &&
        s.group === o.group &&
        s.createdAt === o.createdAt &&
        s.updatedAt === o.updatedAt &&
        s.sites.length === o.sites.length &&
        s.sites.every((x, j) => x === o.sites[j]) &&
        configsIdentical(s.config, o.config))
    );
  });
}
