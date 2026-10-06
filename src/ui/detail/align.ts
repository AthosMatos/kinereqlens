// OWNER: ui-editor agent. Id alignment for bodies re-parsed from the Raw view, so rows/nodes that still match
// the captured request keep its ids and the modified markers stay precise.
import type { BodyModel, KVRow } from '../../shared/types';
import { alignTreeIds } from '../../lib/json-tree';
import { createRow } from '../../lib/kv';
import { safely } from './util';

/**
 * Give re-parsed rows the ids of reference rows with the same key and occurrence index (the 2nd `a` takes the
 * id of the 2nd `a`). Unmatched rows keep their own ids. Disabled rows are not part of a raw text (they were
 * carried over with their ids) and keep them. Returns `rows` itself when nothing changed.
 */
export function alignRowIds(rows: KVRow[], reference: KVRow[]): KVRow[] {
  if (rows.length === 0 || reference.length === 0) return rows;
  const byKey = new Map<string, KVRow[]>();
  for (const r of reference) {
    const list = byKey.get(r.key);
    if (list) list.push(r);
    else byKey.set(r.key, [r]);
  }
  const taken = new Set<string>(rows.filter((row) => !row.enabled).map((row) => row.id));
  const occurrences = new Map<string, number>();
  let changed = false;
  const out = rows.map((row) => {
    if (!row.enabled) return row;
    const n = occurrences.get(row.key) ?? 0;
    occurrences.set(row.key, n + 1);
    const match = byKey.get(row.key)?.[n];
    if (!match || taken.has(match.id)) return row;
    taken.add(match.id);
    if (match.id === row.id) return row;
    changed = true;
    return { ...row, id: match.id };
  });
  if (!changed) return rows;
  // A fresh id that happens to equal a taken reference id would now be duplicated: re-key those rows.
  const seen = new Set<string>();
  return out.map((row, i) => {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      return row;
    }
    return { ...row, id: `${row.id}~${i}` };
  });
}

/**
 * Align a model parsed from raw text with the captured body (preferred) and the body it replaces, so nodes and
 * rows that match the capture keep the capture's ids. Never throws.
 */
export function alignParsedBody(parsed: BodyModel, original: BodyModel, previous: BodyModel): BodyModel {
  if (parsed.type === 'json') {
    const reference = original.type === 'json' ? original.tree : previous.type === 'json' ? previous.tree : null;
    if (!reference) return parsed;
    const tree = safely(() => alignTreeIds(parsed.tree, reference), parsed.tree);
    return tree === parsed.tree ? parsed : { ...parsed, tree };
  }
  if (parsed.type === 'form') {
    const reference = original.type === 'form' ? original.rows : previous.type === 'form' ? previous.rows : null;
    if (!reference) return parsed;
    const rows = alignRowIds(parsed.rows, reference);
    return rows === parsed.rows ? parsed : { type: 'form', rows };
  }
  return parsed;
}

/** One parsed bulk-edit line (kv.parseBulk output). */
export type BulkLine = { key: string; value: string; enabled: boolean };

/**
 * Rows for bulk-edited lines, re-using ids so unchanged rows stay unmodified and edited ones stay "changed"
 * rather than "removed + added". Candidates: current rows, then captured rows that are no longer present.
 * Pass 1 matches by key (same position first); pass 2 gives a renamed line the row at its position when that
 * row's key no longer appears anywhere in the text.
 */
export function mergeBulkRows(existing: KVRow[], original: KVRow[], parsed: BulkLine[]): KVRow[] {
  const present = new Set(existing.map((r) => r.id));
  const pool = existing.concat(original.filter((r) => !present.has(r.id)));
  const used = new Set<string>();
  const take = (r: KVRow) => {
    used.add(r.id);
    return r;
  };
  const byKey: Array<KVRow | undefined> = parsed.map((p, i) => {
    const at = existing[i];
    if (at && !used.has(at.id) && at.key === p.key) return take(at);
    const match = pool.find((r) => !used.has(r.id) && r.key === p.key);
    return match ? take(match) : undefined;
  });
  const keys = new Set(parsed.map((p) => p.key));
  const merged = parsed.map((p, i) => {
    let base = byKey[i];
    const at = existing[i];
    if (!base && at && !used.has(at.id) && !keys.has(at.key)) base = take(at);
    if (!base) return createRow(p.key, p.value, p.enabled);
    if (base.key === p.key && base.value === p.value && base.enabled === p.enabled) return base;
    return { ...base, key: p.key, value: p.value, enabled: p.enabled };
  });
  // Keep the array identity when nothing changed (blank lines, whitespace between lines).
  return merged.length === existing.length && merged.every((r, i) => r === existing[i]) ? existing : merged;
}
