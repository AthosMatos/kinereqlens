// OWNER: ui-shell agent. Pure filtering / ordering / navigation for the request list (no DOM, unit tested).
import type { EntryKind, ListRule, ListTypeId, RequestEntry } from '../../shared/types';
import type { EndpointGroup } from './endpointLabel';
import { compileRules } from './rules';

/** Request types of the "Types" filter menu. 'all' is the absence of any other type. */
export type TypeChipId = 'all' | ListTypeId;
/** A chip that actually filters (everything but 'all'); persisted as Settings.listTypes. */
export type KindChipId = ListTypeId;

export interface TypeChip {
  id: TypeChipId;
  label: string;
  kinds: readonly EntryKind[];
}

export const TYPE_CHIPS: readonly TypeChip[] = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'fetch', label: 'Fetch/XHR', kinds: ['fetch', 'xhr', 'beacon', 'ping'] },
  { id: 'doc', label: 'Doc', kinds: ['document', 'subdocument'] },
  { id: 'js', label: 'JS', kinds: ['script'] },
  { id: 'css', label: 'CSS', kinds: ['stylesheet'] },
  { id: 'img', label: 'Img', kinds: ['image'] },
  { id: 'media', label: 'Media', kinds: ['media'] },
  { id: 'font', label: 'Font', kinds: ['font'] },
  { id: 'other', label: 'Other', kinds: ['websocket', 'other', 'manual'] },
];

const CHIP_BY_KIND: ReadonlyMap<EntryKind, KindChipId> = new Map(
  TYPE_CHIPS.flatMap((chip) =>
    chip.id === 'all' ? [] : chip.kinds.map((kind) => [kind, chip.id as KindChipId] as const),
  ),
);

/** The chip an entry kind belongs to (unknown kinds fall under 'other'). */
export function chipForKind(kind: EntryKind): KindChipId {
  return CHIP_BY_KIND.get(kind) ?? 'other';
}

/** Short label for the Type column. */
export function kindLabel(kind: EntryKind): string {
  switch (kind) {
    case 'document':
      return 'doc';
    case 'subdocument':
      return 'frame';
    case 'stylesheet':
      return 'css';
    case 'script':
      return 'js';
    case 'image':
      return 'img';
    case 'websocket':
      return 'ws';
    default:
      return kind;
  }
}

/** Selected chips; an empty set means "All". */
export type ChipSelection = ReadonlySet<KindChipId>;

/**
 * Chip click semantics (DevTools-like): a plain click selects only that chip (or All);
 * an additive click (Ctrl/Cmd) toggles it within the current selection.
 */
export function toggleChip(selection: ChipSelection, id: TypeChipId, additive: boolean): Set<KindChipId> {
  if (id === 'all') return new Set();
  if (!additive) return selection.size === 1 && selection.has(id) ? new Set() : new Set([id]);
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  // Every chip selected is the same as All.
  return next.size === TYPE_CHIPS.length - 1 ? new Set() : next;
}

export interface ParsedFilter {
  /** Lower-cased terms that must all match. */
  include: string[];
  /** Lower-cased terms (without the leading '-') that must not match. */
  exclude: string[];
}

/** "api -png 4xx" -> { include: ['api', '4xx'], exclude: ['png'] }. A lone "-" is ignored. */
export function parseFilterText(text: string): ParsedFilter {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of text.trim().toLowerCase().split(/\s+/)) {
    if (!raw || raw === '-') continue;
    if (raw.startsWith('-')) exclude.push(raw.slice(1));
    else include.push(raw);
  }
  return { include, exclude };
}

const STATUS_CLASS_TERM = /^([1-5])xx$/;

// Entries are immutable (a change produces a new object), so caching per object is safe.
const haystackCache = new WeakMap<RequestEntry, string>();

function haystack(entry: RequestEntry): string {
  let text = haystackCache.get(entry);
  if (text === undefined) {
    text = `${entry.method}\n${entry.url}\n${entry.status ?? ''}`.toLowerCase();
    haystackCache.set(entry, text);
  }
  return text;
}

/** One term against url / method / status. "4xx"-style terms also match the status class. */
function termMatches(entry: RequestEntry, term: string): boolean {
  const cls = STATUS_CLASS_TERM.exec(term);
  if (cls && entry.status !== undefined && Math.floor(entry.status / 100) === Number(cls[1])) return true;
  return haystack(entry).includes(term);
}

export function matchesText(entry: RequestEntry, filter: ParsedFilter): boolean {
  for (const term of filter.include) if (!termMatches(entry, term)) return false;
  for (const term of filter.exclude) if (termMatches(entry, term)) return false;
  return true;
}

/**
 * Type-chip match. Requests the user made ("+ New", "Duplicate as new request") are listed under every
 * chip: hiding a request right after creating it would make it impossible to find again.
 */
export function matchesChips(entry: RequestEntry, chips: ChipSelection): boolean {
  return chips.size === 0 || entry.kind === 'manual' || chips.has(chipForKind(entry.kind));
}

/** Why a listed entry would be hidden: it is only shown because it is selected. */
export type HiddenReason = 'rule' | 'removed';

export type ListRow =
  | {
      type: 'entry';
      key: string;
      entry: RequestEntry;
      /** 1-based position among entry rows (for aria-posinset). */
      ordinal: number;
      /**
       * Set on the selected entry when URL rules or "Remove from list" hide it: it stays listed (dimmed) while
       * selected, so the detail pane is not yanked away, and disappears once deselected.
       */
      hidden?: HiddenReason;
      /** Key of the (expanded) group row this call is listed under ("Group by endpoint"). */
      group?: string;
    }
  | {
      /** "Group by endpoint": calls sharing method + host + path template (see endpointLabel.ts). */
      type: 'group';
      key: string;
      /** 1-based position among option rows (groups and calls). */
      ordinal: number;
      expanded: boolean;
      group: EndpointGroup;
    }
  | {
      type: 'separator';
      key: string;
      /** Page the following restored entries were captured on. */
      pageUrl: string;
    };

/** An entry row of the list. */
export type EntryRow = Extract<ListRow, { type: 'entry' }>;

export interface ListFilter {
  text: string;
  chips: ChipSelection;
}

/** What hides entries besides the text / chip filter. */
export interface ListVisibility {
  /** URL rules (settings.listRules); disabled ones are ignored. Applied after chips / text. */
  rules?: readonly ListRule[] | null;
  /** Ids the user removed from the list ("Remove from list"); checked before the rules. */
  removed?: ReadonlySet<string> | null;
}

export interface ListModel {
  rows: ListRow[];
  /** Entry rows after filtering (including a selected entry kept although hidden). */
  matched: number;
  /** All entries, before filtering. */
  total: number;
  /** Entries that pass chips / text but are hidden by URL rules (not counting a kept selected entry). */
  hiddenByRules: number;
  /** Entries that pass chips / text but were removed from the list (not counting a kept selected entry). */
  removed: number;
}

/** Newest first; ties keep reverse insertion order. */
function newestFirst(list: Array<{ entry: RequestEntry; index: number }>): void {
  list.sort((a, b) => b.entry.startTime - a.entry.startTime || b.index - a.index);
}

interface Listed {
  entry: RequestEntry;
  index: number;
  hidden?: HiddenReason;
}

/**
 * Filter and order entries for display: current-page entries newest first, then restored (preserved-log)
 * entries newest first, each group of a previous page preceded by a separator row. `selectedId` passes the
 * type chips. After chips / text, entries removed by the user and entries hidden by URL rules are dropped
 * (manual entries never are hidden by rules); the selected entry stays, marked `hidden`.
 */
export function buildListModel(
  entries: readonly RequestEntry[],
  filter: ListFilter,
  selectedId: string | null = null,
  visibility: ListVisibility = {},
): ListModel {
  const parsed = parseFilterText(filter.text);
  const rules = compileRules(visibility.rules);
  const removedIds = visibility.removed;
  const current: Listed[] = [];
  const restored: Listed[] = [];
  let hiddenByRules = 0;
  let removed = 0;
  entries.forEach((entry, index) => {
    // The selected entry stays visible under any type chip (the text filter still applies).
    if (!(entry.id === selectedId || matchesChips(entry, filter.chips)) || !matchesText(entry, parsed)) return;
    let hidden: HiddenReason | undefined;
    if (removedIds?.has(entry.id)) hidden = 'removed';
    else if (rules.active && rules.hides(entry)) hidden = 'rule';
    if (hidden && entry.id !== selectedId) {
      if (hidden === 'removed') removed++;
      else hiddenByRules++;
      return;
    }
    (entry.restored ? restored : current).push(hidden ? { entry, index, hidden } : { entry, index });
  });
  newestFirst(current);
  newestFirst(restored);

  const rows: ListRow[] = [];
  let ordinal = 0;
  const push = ({ entry, hidden }: Listed) => {
    const row: EntryRow = { type: 'entry', key: entry.id, entry, ordinal: ++ordinal };
    if (hidden) row.hidden = hidden;
    rows.push(row);
  };
  current.forEach(push);
  let lastPage: string | null = null;
  for (const item of restored) {
    if (item.entry.pageUrl !== lastPage) {
      lastPage = item.entry.pageUrl;
      rows.push({ type: 'separator', key: `sep:${rows.length}:${item.entry.pageUrl}`, pageUrl: item.entry.pageUrl });
    }
    push(item);
  }
  return { rows, matched: ordinal, total: entries.length, hiddenByRules, removed };
}

/** True when any filter (text or chip) is active. */
/** The list shows only fetch/XHR (+ beacons/pings) by default: kineReqLens is about HTTP API requests. */
export const DEFAULT_CHIPS: ReadonlySet<KindChipId> = new Set<KindChipId>(['fetch']);

/** The type selection is the default (Fetch/XHR only). */
export function isDefaultChips(chips: ChipSelection): boolean {
  return chips.size === DEFAULT_CHIPS.size && [...DEFAULT_CHIPS].every((id) => chips.has(id));
}

/** Text filter set, or a type selection other than the default. */
export function isFiltering(filter: ListFilter): boolean {
  if (!isDefaultChips(filter.chips)) return true;
  const parsed = parseFilterText(filter.text);
  return parsed.include.length > 0 || parsed.exclude.length > 0;
}

/**
 * Selection after a keyboard move. `delta` is a row step (±1, ±page) or an absolute end.
 * Separators are skipped; the selection clamps at the ends (no wrap). With nothing selected, any move
 * selects the first entry ('last' selects the last). Returns null when there are no entry rows.
 */
export function moveSelection(
  rows: readonly ListRow[],
  currentId: string | null,
  delta: number | 'first' | 'last',
): string | null {
  const ids: string[] = [];
  for (const row of rows) if (row.type === 'entry') ids.push(row.entry.id);
  if (!ids.length) return null;
  if (delta === 'first') return ids[0] ?? null;
  if (delta === 'last') return ids[ids.length - 1] ?? null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  if (at < 0) return ids[0] ?? null;
  const next = Math.min(Math.max(at + delta, 0), ids.length - 1);
  return ids[next] ?? null;
}

/** Index of the row showing `entryId`, or -1. */
export function rowIndexOf(rows: readonly ListRow[], entryId: string | null): number {
  if (entryId === null) return -1;
  return rows.findIndex((row) => row.type === 'entry' && row.entry.id === entryId);
}

// ------------------------------------------------------------------------------------------- row cursor
// With "Group by endpoint" the list's options are entry rows and group rows; the selection stays an entry id
// (a group row stands for its newest call), and keyboard moves walk the option rows by key.

/** Rows that are options of the listbox (entries and groups, not separators). */
export function isOptionRow(row: ListRow): row is Exclude<ListRow, { type: 'separator' }> {
  return row.type !== 'separator';
}

/**
 * Key of the row showing the selection: the cursor group when it holds the selected entry, else the entry's own
 * row, else the (collapsed) group holding it; null when nothing shows it.
 */
export function activeRowKey(rows: readonly ListRow[], selectedId: string | null, cursorGroup: string | null = null): string | null {
  if (selectedId === null) return null;
  const holds = (row: ListRow) => row.type === 'group' && row.group.entries.some((e) => e.id === selectedId);
  if (cursorGroup && rows.some((row) => row.key === cursorGroup && holds(row))) return cursorGroup;
  const own = rows.find((row) => row.type === 'entry' && row.entry.id === selectedId);
  if (own) return own.key;
  return rows.find(holds)?.key ?? null;
}

/** Index of the row with this key, or -1. */
export function rowIndexOfKey(rows: readonly ListRow[], key: string | null): number {
  if (key === null) return -1;
  return rows.findIndex((row) => row.key === key);
}

/** Like moveSelection, over option row keys (groups included). */
export function moveRowKey(rows: readonly ListRow[], currentKey: string | null, delta: number | 'first' | 'last'): string | null {
  const keys: string[] = [];
  for (const row of rows) if (isOptionRow(row)) keys.push(row.key);
  if (!keys.length) return null;
  if (delta === 'first') return keys[0] ?? null;
  if (delta === 'last') return keys[keys.length - 1] ?? null;
  const at = currentKey === null ? -1 : keys.indexOf(currentKey);
  if (at < 0) return keys[0] ?? null;
  return keys[Math.min(Math.max(at + delta, 0), keys.length - 1)] ?? null;
}
