// OWNER: lib-core agent. Generic helpers for editable key/value rows (query params, headers, form fields).
import type { KVRow } from '../shared/types';
import { uid } from './ids';

/** New enabled row with a fresh id. */
export function createRow(key = '', value = '', enabled = true): KVRow {
  return { id: uid('kv'), enabled, key, value };
}

/** Copy of one row (same id) that shares no mutable state with the input. */
function cloneRow(row: KVRow): KVRow {
  const copy: KVRow = { ...row };
  if (row.raw) copy.raw = { ...row.raw };
  return copy;
}

/** Deep copy keeping ids. */
export function cloneRows(rows: KVRow[]): KVRow[] {
  return rows.map(cloneRow);
}

export interface RowDiff {
  /** Ids of rows present in both whose key, value or enabled flag differ. */
  changed: Set<string>;
  /** Ids of rows not present in the original. */
  added: Set<string>;
  /** Original rows that no longer exist (in original order). */
  removed: KVRow[];
  /** True when the relative order of surviving original rows changed. */
  reordered: boolean;
}

function sameContent(a: KVRow, b: KVRow): boolean {
  return a.key === b.key && a.value === b.value && a.enabled === b.enabled;
}

/** Compare rows by id. */
export function diffRows(original: KVRow[], current: KVRow[]): RowDiff {
  const originalIndex = new Map<string, number>();
  original.forEach((row, index) => {
    if (!originalIndex.has(row.id)) originalIndex.set(row.id, index);
  });

  const changed = new Set<string>();
  const added = new Set<string>();
  const seen = new Set<string>();
  let lastIndex = -1;
  let reordered = false;

  for (const row of current) {
    const index = originalIndex.get(row.id);
    // A repeated id in `current` (should not happen) is treated as an added row, never as a second match.
    if (index === undefined || seen.has(row.id)) {
      added.add(row.id);
      continue;
    }
    seen.add(row.id);
    if (!sameContent(original[index], row)) changed.add(row.id);
    if (index < lastIndex) reordered = true;
    lastIndex = index;
  }

  const removed = original.filter((row) => !seen.has(row.id));
  return { changed, added, removed, reordered };
}

/** True when anything differs: content, added/removed rows or order. */
export function rowsModified(original: KVRow[], current: KVRow[]): boolean {
  if (original.length !== current.length) return true;
  // Same length + same id at every position + same content <=> empty diff (ids are unique).
  for (let i = 0; i < current.length; i++) {
    if (original[i].id !== current[i].id || !sameContent(original[i], current[i])) return true;
  }
  return false;
}

/**
 * Where a deleted original row goes back: right after the nearest preceding original row that is still
 * present, else right before the nearest following one, else its original index clamped to the list.
 * This equals the original index whenever the rows before it are unchanged, and keeps the row next to its
 * original neighbours when rows before it were added/removed.
 */
function reinsertIndex(original: KVRow[], current: KVRow[], originalIdx: number): number {
  const position = new Map<string, number>();
  current.forEach((row, index) => position.set(row.id, index));
  for (let i = originalIdx - 1; i >= 0; i--) {
    const at = position.get(original[i].id);
    if (at !== undefined) return at + 1;
  }
  for (let i = originalIdx + 1; i < original.length; i++) {
    const at = position.get(original[i].id);
    if (at !== undefined) return at;
  }
  return Math.min(originalIdx, current.length);
}

/**
 * Revert one row by id: a changed row gets its original key/value/enabled/raw back; an added row is removed;
 * an id that only exists in `original` (deleted row) is re-inserted at its original index (clamped).
 * "Original index" is resolved against the surviving neighbours (see reinsertIndex), so the row lands
 * back between the same rows even when rows before it were added or removed.
 * Returns `current` itself when `id` is unknown to both lists.
 */
export function revertRow(original: KVRow[], current: KVRow[], id: string): KVRow[] {
  const originalIdx = original.findIndex((row) => row.id === id);
  const currentIdx = current.findIndex((row) => row.id === id);
  if (originalIdx < 0 && currentIdx < 0) return current;

  if (originalIdx < 0) return current.filter((row) => row.id !== id);

  const restored = cloneRow(original[originalIdx]);
  if (currentIdx >= 0) {
    const next = current.slice();
    next[currentIdx] = restored;
    return next;
  }
  const next = current.slice();
  next.splice(reinsertIndex(original, current, originalIdx), 0, restored);
  return next;
}

/** Immutable single-row update. Returns `rows` itself when no row has `id`. */
export function updateRow(rows: KVRow[], id: string, patch: Partial<Omit<KVRow, 'id'>>): KVRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return rows;
  const next = rows.slice();
  next[index] = { ...rows[index], ...patch, id };
  return next;
}

/** Immutable removal. Returns `rows` itself when no row has `id`. */
export function removeRow(rows: KVRow[], id: string): KVRow[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return rows;
  const next = rows.slice();
  next.splice(index, 1);
  return next;
}

const DISABLED_MARKER = /^(#|\/\/)/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

/** Index of the key/value separator, or -1. Header lines like ":authority: x" keep the leading ':' in the key. */
function separatorIndex(line: string, sep: ':' | '='): number {
  if (sep === ':' && line.startsWith(':') && line.length > 1 && TOKEN_CHAR.test(line[1])) {
    return line.indexOf(':', 1);
  }
  return line.indexOf(sep);
}

/**
 * Parse "key: value" / "key=value" lines (bulk edit). `sep` decides which separator is expected.
 *  - blank lines are ignored;
 *  - lines starting with '#' or '//' become disabled rows (marker stripped; a marker-only line is ignored);
 *  - the line is split at the first separator (a line without one is a key with an empty value);
 *  - the key is trimmed; for ':' one leading space of the value is stripped, for '=' the value is verbatim.
 */
export function parseBulk(text: string, sep: ':' | '='): Array<{ key: string; value: string; enabled: boolean }> {
  const result: Array<{ key: string; value: string; enabled: boolean }> = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = rawLine.trimStart();
    if (line.trim() === '') continue;
    let enabled = true;
    const marker = DISABLED_MARKER.exec(line);
    if (marker) {
      enabled = false;
      line = line.slice(marker[0].length).trimStart();
      if (line.trim() === '') continue;
    }
    const at = separatorIndex(line, sep);
    if (at < 0) {
      result.push({ key: line.trim(), value: '', enabled });
      continue;
    }
    let value = line.slice(at + 1);
    if (sep === ':' && value.startsWith(' ')) value = value.slice(1);
    result.push({ key: line.slice(0, at).trim(), value, enabled });
  }
  return result;
}

/**
 * Inverse of parseBulk; disabled rows are emitted prefixed with "# ". Rows with an empty key and value are
 * skipped (they carry no data). Lines are joined with '\n'.
 */
export function toBulk(rows: KVRow[], sep: ':' | '='): string {
  const glue = sep === ':' ? ': ' : '=';
  const lines: string[] = [];
  for (const row of rows) {
    if (row.key === '' && row.value === '') continue;
    lines.push(`${row.enabled ? '' : '# '}${row.key}${glue}${row.value}`);
  }
  return lines.join('\n');
}
