// OWNER: ui-editor agent. Memoized derived data for drafts. Every cache is a WeakMap keyed by the immutable
// draft / rows / tree objects, so typing re-derives only what actually changed and nothing leaks.
import type {
  BodyModel,
  Draft,
  DraftSection,
  JNode,
  KVRow,
  MultipartPart,
  ReplayMode,
} from '../../shared/types';
import { draftSections, draftUrl, draftWarnings, type DraftWarning } from '../../lib/draft';
import { diffTrees, treeErrors, type TreeDiff } from '../../lib/json-tree';
import { diffRows, type RowDiff } from '../../lib/kv';
import { isStandaloneShell } from '../shellMode';
import { safely } from './util';

/** Stable empty arrays so "no original rows/parts" still works as a WeakMap key. */
export const EMPTY_ROWS: KVRow[] = [];
export const EMPTY_PARTS: MultipartPart[] = [];

const NO_SECTIONS: Record<DraftSection, boolean> = {
  method: false,
  url: false,
  query: false,
  headers: false,
  body: false,
};

function memo2<A extends object, B extends object, R>(
  cache: WeakMap<A, WeakMap<B, R>>,
  a: A,
  b: B,
  compute: () => R,
): R {
  let inner = cache.get(a);
  if (!inner) {
    inner = new WeakMap();
    cache.set(a, inner);
  }
  let value = inner.get(b);
  if (value === undefined) {
    value = compute();
    inner.set(b, value);
  }
  return value;
}

// --------------------------------------------------------------------------------------------- sections

const sectionsCache = new WeakMap<Draft, Record<DraftSection, boolean>>();

/** Modified flags per section (cached per draft object). */
export function sectionsOf(draft: Draft): Record<DraftSection, boolean> {
  let s = sectionsCache.get(draft);
  if (!s) {
    s = safely(() => draftSections(draft), NO_SECTIONS);
    sectionsCache.set(draft, s);
  }
  return s;
}

const urlCache = new WeakMap<Draft, string>();

/** draftUrl(draft) cached per draft; falls back to the base when it cannot be computed. */
export function urlOf(draft: Draft): string {
  let url = urlCache.get(draft);
  if (url === undefined) {
    url = safely(() => draftUrl(draft), draft.base);
    urlCache.set(draft, url);
  }
  return url;
}

export function isModifiedCached(draft: Draft): boolean {
  const s = sectionsOf(draft);
  return s.method || s.url || s.query || s.headers || s.body;
}

// --------------------------------------------------------------------------------------------- warnings

const warningsCache = new WeakMap<Draft, Partial<Record<ReplayMode, DraftWarning[]>>>();
const NO_WARNINGS: DraftWarning[] = [];

/** draftWarnings(draft, mode), cached per draft and mode (App mode in the standalone React Native tab). */
export function warningsOf(draft: Draft, mode: ReplayMode): DraftWarning[] {
  let byMode = warningsCache.get(draft);
  if (!byMode) {
    byMode = {};
    warningsCache.set(draft, byMode);
  }
  let list = byMode[mode];
  if (!list) {
    list = safely(() => draftWarnings(draft, mode, { app: isStandaloneShell() }), NO_WARNINGS);
    byMode[mode] = list;
  }
  return list;
}

/**
 * Number of problems that block Send: error-level warnings plus invalid JSON values of the body (counted once
 * even when draftWarnings reports them too).
 */
export function blockingErrorsOf(draft: Draft, mode: ReplayMode): number {
  const treeErrs = draft.body.type === 'json' ? treeErrorsOf(draft.body.tree) : NO_TREE_ERRORS;
  let n = treeErrs.size;
  for (const w of warningsOf(draft, mode)) {
    if (w.level === 'error' && !(w.targetId && treeErrs.has(w.targetId))) n++;
  }
  return n;
}

export interface WarningIndex {
  /** targetId -> joined messages (strings keep memoized rows cheap to compare). */
  byTarget: Map<string, { level: DraftWarning['level']; message: string }>;
  bySection: Map<DraftWarning['section'], { errors: number; warns: number }>;
  errors: number;
}

const warningIndexCache = new WeakMap<DraftWarning[], WarningIndex>();

const LEVEL_RANK: Record<DraftWarning['level'], number> = { error: 2, warn: 1, info: 0 };

/** Lookup tables over a warnings list (cached per list). */
export function indexWarnings(list: DraftWarning[]): WarningIndex {
  let idx = warningIndexCache.get(list);
  if (idx) return idx;
  idx = { byTarget: new Map(), bySection: new Map(), errors: 0 };
  for (const w of list) {
    if (w.level === 'error') idx.errors++;
    const sec = idx.bySection.get(w.section) ?? { errors: 0, warns: 0 };
    if (w.level === 'error') sec.errors++;
    else if (w.level === 'warn') sec.warns++;
    idx.bySection.set(w.section, sec);
    if (w.targetId) {
      const prev = idx.byTarget.get(w.targetId);
      if (!prev) idx.byTarget.set(w.targetId, { level: w.level, message: w.message });
      else {
        idx.byTarget.set(w.targetId, {
          level: LEVEL_RANK[w.level] > LEVEL_RANK[prev.level] ? w.level : prev.level,
          message: `${prev.message}\n${w.message}`,
        });
      }
    }
  }
  warningIndexCache.set(list, idx);
  return idx;
}

// --------------------------------------------------------------------------------------------- rows

const rowDiffCache = new WeakMap<KVRow[], WeakMap<KVRow[], RowDiff>>();
const EMPTY_ROW_DIFF: RowDiff = { changed: new Set(), added: new Set(), removed: [], reordered: false };

/** diffRows(original, current), cached per (original, current) pair. */
export function rowDiffOf(original: KVRow[], current: KVRow[]): RowDiff {
  return memo2(rowDiffCache, original, current, () => safely(() => diffRows(original, current), EMPTY_ROW_DIFF));
}

function rowChangeCount(d: RowDiff): number {
  return d.changed.size + d.added.size + d.removed.length + (d.reordered ? 1 : 0);
}

// --------------------------------------------------------------------------------------------- JSON

const treeDiffCache = new WeakMap<JNode, WeakMap<JNode, TreeDiff | null>>();

/** diffTrees(original, current), cached; null when diffing failed (everything is treated as modified). */
export function treeDiffOf(original: JNode, current: JNode): TreeDiff | null {
  return memo2(treeDiffCache, original, current, () => safely<TreeDiff | null>(() => diffTrees(original, current), null));
}

const treeErrorsCache = new WeakMap<JNode, Map<string, string>>();
const NO_TREE_ERRORS = new Map<string, string>();

/** treeErrors(tree) cached per tree root. */
export function treeErrorsOf(tree: JNode): Map<string, string> {
  let m = treeErrorsCache.get(tree);
  if (!m) {
    m = safely(() => treeErrors(tree), NO_TREE_ERRORS);
    treeErrorsCache.set(tree, m);
  }
  return m;
}

/** Added nodes counted once per added subtree (a duplicated object counts as one change). */
function topLevelAdded(tree: JNode, added: Set<string>): number {
  if (added.size === 0) return 0;
  let n = 0;
  const stack: JNode[] = [tree];
  while (stack.length) {
    const node = stack.pop()!;
    if (added.has(node.id)) {
      n++;
      continue;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return n;
}

// --------------------------------------------------------------------------------------------- multipart

export interface PartsDiff {
  changed: Set<string>;
  added: Set<string>;
  removed: MultipartPart[];
}

function sameHeaders(a: MultipartPart['extraHeaders'], b: MultipartPart['extraHeaders']): boolean {
  if (a === b) return true;
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((h, i) => h.name === y[i]!.name && h.value === y[i]!.value);
}

/** Field-by-field equality of two parts (ids ignored). */
export function samePart(a: MultipartPart, b: MultipartPart): boolean {
  return (
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.value === b.value &&
    (a.fileName ?? '') === (b.fileName ?? '') &&
    (a.mime ?? '') === (b.mime ?? '') &&
    (a.base64 ?? '') === (b.base64 ?? '') &&
    (a.size ?? 0) === (b.size ?? 0) &&
    !!a.missingContent === !!b.missingContent &&
    sameHeaders(a.extraHeaders, b.extraHeaders)
  );
}

const partsDiffCache = new WeakMap<MultipartPart[], WeakMap<MultipartPart[], PartsDiff>>();

/** Compare multipart parts by id (cached). */
export function partsDiffOf(original: MultipartPart[], current: MultipartPart[]): PartsDiff {
  return memo2(partsDiffCache, original, current, () => {
    const orig = new Map(original.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const diff: PartsDiff = { changed: new Set(), added: new Set(), removed: [] };
    for (const p of current) {
      const o = orig.get(p.id);
      seen.add(p.id);
      if (!o) diff.added.add(p.id);
      else if (o !== p && !samePart(o, p)) diff.changed.add(p.id);
    }
    for (const o of original) if (!seen.has(o.id)) diff.removed.push(o);
    return diff;
  });
}

/** Original rows of a form body (EMPTY_ROWS when the original body was not a form). */
export function originalFormRows(original: BodyModel): KVRow[] {
  return original.type === 'form' ? original.rows : EMPTY_ROWS;
}

/** Original parts of a multipart body (EMPTY_PARTS otherwise). */
export function originalParts(original: BodyModel): MultipartPart[] {
  return original.type === 'multipart' ? original.parts : EMPTY_PARTS;
}

/** Original JSON tree (null when the original body was not JSON). */
export function originalTree(original: BodyModel): JNode | null {
  return original.type === 'json' ? original.tree : null;
}

// --------------------------------------------------------------------------------------------- counting

function bodyChangeCount(original: BodyModel, current: BodyModel): number {
  if (original.type !== current.type) return 1;
  if (current.type === 'json' && original.type === 'json') {
    const d = treeDiffOf(original.tree, current.tree);
    if (!d) return 1;
    let removed = 0;
    for (const list of d.removed.values()) removed += list.length;
    return d.changed.size + topLevelAdded(current.tree, d.added) + removed;
  }
  if (current.type === 'form' && original.type === 'form') {
    return rowChangeCount(rowDiffOf(original.rows, current.rows));
  }
  if (current.type === 'multipart' && original.type === 'multipart') {
    const d = partsDiffOf(original.parts, current.parts);
    return d.changed.size + d.added.size + d.removed.length;
  }
  return 1;
}

const countCache = new WeakMap<Draft, number>();

/** Number of modified items (rows, parts, JSON nodes, method, URL) for the "N modified" header badge. */
export function modifiedCountOf(draft: Draft): number {
  let n = countCache.get(draft);
  if (n !== undefined) return n;
  const s = sectionsOf(draft);
  n = 0;
  if (s.method) n += 1;
  if (s.url) n += 1;
  if (s.query) n += Math.max(1, rowChangeCount(rowDiffOf(draft.original.query, draft.query)));
  if (s.headers) n += Math.max(1, rowChangeCount(rowDiffOf(draft.original.headers, draft.headers)));
  if (s.body) n += Math.max(1, safely(() => bodyChangeCount(draft.original.body, draft.body), 1));
  countCache.set(draft, n);
  return n;
}
