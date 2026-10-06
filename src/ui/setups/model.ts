// Setups: saved, named, grouped request-list configuration presets (settings.setups / activeSetupId).
// Pure logic (no DOM, no bridge), unit tested in tests/unit/setups.test.ts: capture / apply, "modified since
// applied", host-pattern auto-apply, grouping and search, summaries, list edits, JSON export / import.
import { MAX_SETUP_GROUP, MAX_SETUP_NAME, MAX_SETUPS } from '../../shared/constants';
import {
  cleanLabel,
  hostPatternMatches,
  hostPatternSpecificity,
  isSetupId,
  listTypesEqual,
  normalizeHostPattern,
  normalizeListTypes,
  pageHostOf,
  parseHostPattern,
  sanitizeSetup,
  sanitizeSetupConfig,
  sanitizeSites,
} from '../../shared/setups';
import type { PageHost } from '../../shared/setups';
import type { ListRule, ListTypeId, ReplayMode, Setup, SetupConfig } from '../../shared/types';
import { TYPE_CHIPS } from '../list/filter';
import { primaryLanguage, withSiteLanguage } from '../../shared/language';
import { canonicalPattern } from '../list/rules';

export { normalizeHostPattern, pageHostOf, parseHostPattern } from '../../shared/setups';
export type { PageHost } from '../../shared/setups';

/** `kind` of an exported setups file. */
export const SETUPS_FILE_KIND = 'kinereqlens-setups';
/** Format version written by this build (files of a newer version are refused). */
export const SETUPS_FILE_VERSION = 1;
/** Largest import file accepted (characters). */
export const MAX_IMPORT_CHARS = 8 * 1024 * 1024;

/** The part of Settings a setup captures and replaces. */
export interface ListConfigState {
  listTypes: ListTypeId[];
  listRules: ListRule[];
  defaultMode: ReplayMode;
  activeSetupId: string | null;
  /** Site key (host name) of the page, for the site language (absent / null: not an http(s) page). */
  pageHost?: string | null;
  /** settings.siteLanguages (absent: the language is not part of this state). */
  siteLanguages?: Record<string, string>;
}

/** Settings patch that applies (or restores) a list configuration. */
export interface ListConfigPatch {
  listTypes: ListTypeId[];
  listRules: ListRule[];
  activeSetupId: string | null;
  defaultMode?: ReplayMode;
  /** The setup's language applied to the page host (or the map restored by Undo). */
  siteLanguages?: Record<string, string>;
}

/** The site language of the page in `state` (settings.siteLanguages[pageHost]), or null. */
export function stateLanguage(state: Pick<ListConfigState, 'pageHost' | 'siteLanguages'>): string | null {
  const host = state.pageHost;
  const map = state.siteLanguages;
  return host && map && Object.prototype.hasOwnProperty.call(map, host) ? map[host]! : null;
}

// ------------------------------------------------------------------------------------------- capture / apply

/**
 * The current list configuration as a setup config (rules copied; `includeMode` stores the replay mode,
 * `includeLanguage` the page's site language when it has one).
 */
export function captureConfig(
  state: ListConfigState,
  { includeMode = true, includeLanguage = true }: { includeMode?: boolean; includeLanguage?: boolean } = {},
): SetupConfig {
  const config: SetupConfig = {
    listTypes: normalizeListTypes(state.listTypes),
    listRules: state.listRules.map((r) => ({ ...r })),
  };
  if (includeMode) config.defaultMode = state.defaultMode;
  const language = includeLanguage ? stateLanguage(state) : null;
  if (language) config.language = language;
  return config;
}

export interface SetupInit {
  name: string;
  group?: string;
  sites?: readonly string[];
  config: SetupConfig;
}

/** A new setup (validated like stored ones), or null when the name is empty. */
export function createSetup(init: SetupInit, ctx: { id: string; now: number }): Setup | null {
  return sanitizeSetup({
    id: ctx.id,
    name: init.name,
    group: init.group ?? '',
    sites: init.sites ?? [],
    config: init.config,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
}

/**
 * The settings patch applying `setup`: its type selection and rules (with fresh rule ids, so the applied rules
 * never share ids with the stored setup), its replay mode when it has one, and the setup as the active one.
 */
export function applySetupPatch(
  setup: Setup,
  ctx: { now: number; newId: () => string; pageHost?: string | null; siteLanguages?: Record<string, string> },
): ListConfigPatch {
  const patch: ListConfigPatch = {
    listTypes: normalizeListTypes(setup.config.listTypes),
    listRules: setup.config.listRules.map((r) => ({ ...r, id: ctx.newId(), createdAt: ctx.now })),
    activeSetupId: setup.id,
  };
  if (setup.config.defaultMode) patch.defaultMode = setup.config.defaultMode;
  // A setup's language is a site language of the page it is applied on (persisted for that host).
  const language = setup.config.language;
  if (language && ctx.pageHost && ctx.siteLanguages && ctx.siteLanguages[ctx.pageHost] !== language) {
    const next = withSiteLanguage(ctx.siteLanguages, ctx.pageHost, language);
    if (next[ctx.pageHost] === language) patch.siteLanguages = next;
  }
  return patch;
}

/** The patch restoring `state` (Undo of an apply). */
export function restorePatch(state: ListConfigState): ListConfigPatch {
  const patch: ListConfigPatch = {
    listTypes: state.listTypes.slice(),
    listRules: state.listRules.map((r) => ({ ...r })),
    defaultMode: state.defaultMode,
    activeSetupId: state.activeSetupId,
  };
  if (state.siteLanguages) patch.siteLanguages = { ...state.siteLanguages };
  return patch;
}

/** What makes two rules behave the same (ids and timestamps ignored, patterns compared canonically). */
function ruleKey(rule: ListRule): string {
  const on = rule.enabled ? 'on' : 'off';
  if (rule.method) return `${rule.mode} method ${rule.method} ${on}`;
  if (rule.template) return `${rule.mode} template ${on} ${rule.template}`;
  return `${rule.mode} url ${rule.exact ? 'exact' : 'prefix'} ${on} ${canonicalPattern(rule.pattern)}`;
}

/** Same rules, in any order (ids / creation times ignored). */
export function sameRules(a: readonly ListRule[], b: readonly ListRule[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(ruleKey).sort();
  const y = b.map(ruleKey).sort();
  return x.every((k, i) => k === y[i]);
}

/**
 * Whether `current` behaves like `config`: same types and rules, and the same replay mode / site language when
 * `config` stores one.
 */
export function configMatches(config: SetupConfig, current: SetupConfig): boolean {
  if (!listTypesEqual(normalizeListTypes(config.listTypes), normalizeListTypes(current.listTypes))) return false;
  if (!sameRules(config.listRules, current.listRules)) return false;
  if (config.language !== undefined && config.language !== current.language) return false;
  return config.defaultMode === undefined || config.defaultMode === current.defaultMode;
}

/** The active setup, if `state.activeSetupId` names one. */
export function activeSetup(setups: readonly Setup[], state: Pick<ListConfigState, 'activeSetupId'>): Setup | null {
  return state.activeSetupId ? (setups.find((s) => s.id === state.activeSetupId) ?? null) : null;
}

/** The current configuration differs from the active setup (false without an active setup). */
export function isModified(setups: readonly Setup[], state: ListConfigState): boolean {
  const active = activeSetup(setups, state);
  return !!active && !configMatches(active.config, captureConfig(state));
}

// ------------------------------------------------------------------------------------------- auto-apply

export interface AutoApplyMatch {
  setup: Setup;
  /** The site pattern that matched. */
  site: string;
  host: PageHost;
}

function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The setup to auto-apply on `pageUrl`: among setups with a site pattern matching the page host, the most
 * specific pattern wins (more host labels, exact host over wildcard, explicit port over any); ties go to the
 * most recently updated setup. Null for non-http(s) pages or when nothing matches.
 */
export function pickAutoApplySetup(setups: readonly Setup[], pageUrl: string): AutoApplyMatch | null {
  const host = pageHostOf(pageUrl);
  if (!host) return null;
  let best: { match: AutoApplyMatch; spec: number[] } | null = null;
  for (const setup of setups) {
    let mine: { site: string; spec: number[] } | null = null;
    for (const site of setup.sites) {
      const pattern = parseHostPattern(site);
      if (!pattern || !hostPatternMatches(pattern, host)) continue;
      const spec = hostPatternSpecificity(pattern);
      if (!mine || compareSpecificity(spec, mine.spec) > 0) mine = { site, spec };
    }
    if (!mine) continue;
    const order = best ? compareSpecificity(mine.spec, best.spec) : 1;
    if (!best || order > 0 || (order === 0 && setup.updatedAt > best.match.setup.updatedAt)) {
      best = { match: { setup, site: mine.site, host }, spec: mine.spec };
    }
  }
  return best?.match ?? null;
}

export type AutoApplyDecision =
  | { kind: 'none' }
  /** Apply it (toast with Undo). */
  | { kind: 'apply'; setup: Setup; host: string }
  /** The current configuration has unsaved changes of another active setup: only offer it (toast "Apply"). */
  | { kind: 'offer'; setup: Setup; host: string };

/** What to do when the overlay opens on (or navigates to) `pageUrl`. */
export function decideAutoApply(setups: readonly Setup[], state: ListConfigState, pageUrl: string): AutoApplyDecision {
  const match = pickAutoApplySetup(setups, pageUrl);
  if (!match || match.setup.id === state.activeSetupId) return { kind: 'none' };
  const host = match.host.display;
  return isModified(setups, state) ? { kind: 'offer', setup: match.setup, host } : { kind: 'apply', setup: match.setup, host };
}

/** "Auto-apply on <host>" site for the page (host + non-default port), or null for non-http(s) pages. */
export function pageSite(pageUrl: string): string | null {
  const host = pageHostOf(pageUrl);
  return host ? normalizeHostPattern(host.display) : null;
}

// ------------------------------------------------------------------------------------------- grouping / search

/** Locale-aware, case-insensitive, numeric ("Setup 2" before "Setup 10"). */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

export interface SetupGroup {
  /** '' = ungrouped. */
  group: string;
  setups: Setup[];
}

/** Setups by group: ungrouped first, then groups by name; setups by name inside each. Empty groups omitted. */
export function groupSetups(setups: readonly Setup[]): SetupGroup[] {
  const groups = new Map<string, Setup[]>();
  for (const setup of setups) {
    const list = groups.get(setup.group);
    if (list) list.push(setup);
    else groups.set(setup.group, [setup]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : compareText(a, b)))
    .map(([group, list]) => ({ group, setups: list.sort((x, y) => compareText(x.name, y.name) || x.createdAt - y.createdAt) }));
}

/** Existing group names, sorted (for suggestions). */
export function groupNames(setups: readonly Setup[]): string[] {
  return [...new Set(setups.map((s) => s.group).filter(Boolean))].sort(compareText);
}

/** `input` cleaned, spelled like an existing group that differs only in case. */
export function canonicalGroup(setups: readonly Setup[], input: string): string {
  const group = cleanLabel(input, MAX_SETUP_GROUP);
  if (!group) return '';
  const lower = group.toLocaleLowerCase();
  return setups.find((s) => s.group.toLocaleLowerCase() === lower)?.group ?? group;
}

/** Setups whose name, group or sites contain every space-separated term (case-insensitive). */
export function searchSetups(setups: readonly Setup[], query: string): Setup[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return setups.slice();
  return setups.filter((s) => {
    const text = `${s.name}\n${s.group}\n${s.sites.join('\n')}`.toLocaleLowerCase();
    return terms.every((t) => text.includes(t));
  });
}

// ------------------------------------------------------------------------------------------- labels

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "All types", "Fetch/XHR", "Fetch/XHR, Doc", "3 types". */
export function typesSummary(types: readonly ListTypeId[]): string {
  if (types.length === 0) return 'All types';
  const labels = TYPE_CHIPS.filter((c) => c.id !== 'all' && types.includes(c.id as ListTypeId)).map((c) => c.label);
  return labels.length <= 2 ? labels.join(', ') : `${labels.length} types`;
}

/** One line describing a setup: "Fetch/XHR · 3 rules · OPTIONS hidden · 2 sites". */
export function setupSummary(setup: Pick<Setup, 'config' | 'sites'>): string {
  const { config } = setup;
  const parts = [typesSummary(config.listTypes)];
  const urlRules = config.listRules.filter((r) => !r.method);
  if (urlRules.length) {
    const off = urlRules.filter((r) => !r.enabled).length;
    parts.push(`${plural(urlRules.length, 'rule')}${off ? ` (${off} off)` : ''}`);
  }
  const methods = (mode: ListRule['mode']) =>
    config.listRules.filter((r) => r.method && r.enabled && r.mode === mode).map((r) => r.method!);
  const hidden = methods('hide');
  if (hidden.length) parts.push(`${hidden.join(', ')} hidden`);
  const only = methods('only');
  if (only.length) parts.push(`only ${only.join(', ')}`);
  if (config.defaultMode === 'extension') parts.push('Extension mode');
  if (config.language) parts.push(`Language ${primaryLanguage(config.language) ?? config.language}`);
  if (setup.sites.length) parts.push(plural(setup.sites.length, 'site'));
  return parts.join(' · ');
}

// ------------------------------------------------------------------------------------------- edits

function sameLabel(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** A setup named `name` exists in `group` (case-insensitive), other than `exceptId`. */
export function findByName(setups: readonly Setup[], name: string, group: string, exceptId?: string): Setup | undefined {
  const n = cleanLabel(name, MAX_SETUP_NAME);
  return setups.find((s) => s.id !== exceptId && sameLabel(s.name, n) && sameLabel(s.group, group));
}

/** `base`, or "base 2", "base 3", … — the first name not taken in `group`. */
export function uniqueName(setups: readonly Setup[], base: string, group: string): string {
  const name = cleanLabel(base, MAX_SETUP_NAME) || 'Setup';
  if (!findByName(setups, name, group)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const head = Array.from(name).slice(0, MAX_SETUP_NAME - suffix.length).join('').trimEnd();
    const candidate = `${head}${suffix}`;
    if (!findByName(setups, candidate, group)) return candidate;
  }
}

function edit(setups: readonly Setup[], id: string, fn: (s: Setup) => Setup | null): Setup[] {
  const index = setups.findIndex((s) => s.id === id);
  const current = setups[index];
  if (!current) return setups as Setup[];
  const next = fn(current);
  if (!next || next === current) return setups as Setup[];
  const out = setups.slice();
  out[index] = next;
  return out;
}

/** Rename (same array when the name is empty or unchanged). */
export function renameSetup(setups: readonly Setup[], id: string, name: string, now: number): Setup[] {
  const clean = cleanLabel(name, MAX_SETUP_NAME);
  return edit(setups, id, (s) => (!clean || clean === s.name ? null : { ...s, name: clean, updatedAt: now }));
}

/** Move to another group ('' = ungrouped). */
export function moveSetupToGroup(setups: readonly Setup[], id: string, group: string, now: number): Setup[] {
  const clean = canonicalGroup(setups, group);
  return edit(setups, id, (s) => (clean === s.group ? null : { ...s, group: clean, updatedAt: now }));
}

/** Replace the auto-apply sites (normalized, invalid ones dropped). */
export function setSetupSites(setups: readonly Setup[], id: string, sites: readonly string[], now: number): Setup[] {
  const clean = sanitizeSites(sites);
  return edit(setups, id, (s) =>
    clean.length === s.sites.length && clean.every((x, i) => x === s.sites[i]) ? null : { ...s, sites: clean, updatedAt: now },
  );
}

/** Store a new configuration in a setup. */
export function updateSetupConfig(setups: readonly Setup[], id: string, config: SetupConfig, now: number): Setup[] {
  const clean = sanitizeSetupConfig(config);
  return edit(setups, id, (s) => (clean ? { ...s, config: clean, updatedAt: now } : null));
}

/**
 * Copy of a setup right after it, named "<name> copy" (unique in its group). The copy has no sites, so it
 * never changes which setup is auto-applied where.
 */
export function duplicateSetup(setups: readonly Setup[], id: string, ctx: { id: string; now: number }): { setups: Setup[]; copy: Setup | null } {
  const index = setups.findIndex((s) => s.id === id);
  const source = setups[index];
  if (!source || setups.length >= MAX_SETUPS) return { setups: setups as Setup[], copy: null };
  const copy: Setup = {
    ...source,
    id: ctx.id,
    name: uniqueName(setups, `${source.name} copy`, source.group),
    sites: [],
    config: { ...source.config, listTypes: source.config.listTypes.slice(), listRules: source.config.listRules.map((r) => ({ ...r })) },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  return { setups: [...setups.slice(0, index + 1), copy, ...setups.slice(index + 1)], copy };
}

/** Remove a setup; `index` is where it was (for Undo). */
export function removeSetup(setups: readonly Setup[], id: string): { setups: Setup[]; removed: Setup | null; index: number } {
  const index = setups.findIndex((s) => s.id === id);
  if (index < 0) return { setups: setups as Setup[], removed: null, index };
  return { setups: setups.filter((s) => s.id !== id), removed: setups[index]!, index };
}

/** Put a removed setup back at its old position (same array when it is there already). */
export function restoreSetup(setups: readonly Setup[], setup: Setup, index: number): Setup[] {
  if (setups.some((s) => s.id === setup.id)) return setups as Setup[];
  const at = Math.min(Math.max(0, index), setups.length);
  return [...setups.slice(0, at), setup, ...setups.slice(at)];
}

// ------------------------------------------------------------------------------------------- export / import

/** JSON file content for `setups`. */
export function exportSetups(setups: readonly Setup[]): string {
  return `${JSON.stringify({ kind: SETUPS_FILE_KIND, version: SETUPS_FILE_VERSION, setups }, null, 2)}\n`;
}

/** File name for an export: "kinereqlens-setups-2026-10-02.json" / "kinereqlens-setup-<name>.json". */
export function exportFileName(setups: readonly Setup[], now: Date): string {
  if (setups.length === 1) {
    const slug = setups[0]!.name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
      .slice(0, 40);
    if (slug) return `kinereqlens-setup-${slug}.json`;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `kinereqlens-setups-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

export type ParsedSetupsFile =
  | {
      ok: true;
      /** Valid setups of the file, in file order (ids may collide with each other or with existing ones). */
      setups: Setup[];
      /** Items that were not valid setups. */
      invalid: number;
    }
  | { ok: false; error: string };

/** Read an exported setups file. */
export function parseSetupsFile(text: string): ParsedSetupsFile {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: 'The file is too large' };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: 'The file is not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: 'Not a kineReqLens setups file' };
  const file = data as Record<string, unknown>;
  if (file.kind !== SETUPS_FILE_KIND) return { ok: false, error: 'Not a kineReqLens setups file' };
  if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1) {
    return { ok: false, error: 'Unknown setups file version' };
  }
  if (file.version > SETUPS_FILE_VERSION) return { ok: false, error: 'The file was made by a newer version of kineReqLens' };
  if (!Array.isArray(file.setups)) return { ok: false, error: 'The file has no setups' };
  const setups: Setup[] = [];
  let invalid = 0;
  file.setups.forEach((item, i) => {
    // A missing / malformed id gets a placeholder; import assigns a fresh id where needed.
    const withId =
      typeof item === 'object' && item !== null && !Array.isArray(item) && !isSetupId((item as Record<string, unknown>).id)
        ? { ...(item as object), id: `import-${i}` }
        : item;
    const setup = sanitizeSetup(withId);
    if (setup) setups.push(setup);
    else invalid++;
  });
  return { ok: true, setups, invalid };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportResult {
  setups: Setup[];
  /** New setups added. */
  added: number;
  /** Existing setups (same id or same name in the same group) overwritten with the imported version. */
  updated: number;
  /** Imported setups identical to an existing one. */
  unchanged: number;
  /** Not imported because MAX_SETUPS was reached. */
  dropped: number;
}

function sameContent(a: Setup, b: Setup): boolean {
  return (
    a.name === b.name &&
    a.group === b.group &&
    a.sites.length === b.sites.length &&
    a.sites.every((s, i) => s === b.sites[i]) &&
    a.config.defaultMode === b.config.defaultMode &&
    a.config.language === b.config.language &&
    listTypesEqual(a.config.listTypes, b.config.listTypes) &&
    sameRules(a.config.listRules, b.config.listRules)
  );
}

/**
 * Combine imported setups with the existing ones.
 *  - merge: an imported setup with the id of an existing one in the same group and with the same name, or
 *    else with the same name in the same group (case-insensitive), overwrites it (keeping its id); any other is
 *    added — under a fresh id when its id is taken.
 *  - replace: the imported setups become the whole list (duplicate ids within the file get fresh ids).
 * At most MAX_SETUPS are kept; the rest are counted as `dropped`.
 */
export function importSetups(
  existing: readonly Setup[],
  incoming: readonly Setup[],
  mode: ImportMode,
  ctx: { now: number; newId: () => string },
): ImportResult {
  const result: Setup[] = mode === 'merge' ? existing.slice() : [];
  const used = new Set(result.map((s) => s.id));
  const freshId = (id: string) => {
    let next = id;
    while (used.has(next)) next = ctx.newId();
    used.add(next);
    return next;
  };
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let dropped = 0;
  for (const item of incoming) {
    if (mode === 'merge') {
      const sameGroupName = (s: Setup) => sameLabel(s.name, item.name) && sameLabel(s.group, item.group);
      const index = result.findIndex((s) => s.id === item.id && sameGroupName(s));
      const at = index >= 0 ? index : result.findIndex(sameGroupName);
      const match = result[at];
      if (match) {
        if (sameContent(match, item)) unchanged++;
        else {
          result[at] = { ...item, id: match.id, createdAt: match.createdAt, updatedAt: Math.max(item.updatedAt, ctx.now) };
          updated++;
        }
        continue;
      }
    }
    if (result.length >= MAX_SETUPS) {
      dropped++;
      continue;
    }
    result.push({ ...item, id: freshId(item.id) });
    added++;
  }
  return { setups: result, added, updated, unchanged, dropped };
}

/** "2 new · 1 updated · 1 unchanged · 3 skipped (limit)". */
export function importSummary(r: Pick<ImportResult, 'added' | 'updated' | 'unchanged' | 'dropped'>): string {
  const parts: string[] = [];
  parts.push(`${r.added} new`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
  if (r.dropped) parts.push(`${r.dropped} skipped (limit of ${MAX_SETUPS})`);
  return parts.join(' · ');
}
