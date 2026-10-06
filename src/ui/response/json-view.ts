// OWNER: ui-response agent. Pure model of the read-only JSON viewer: flattening a JNode tree into visible
// rows (iterative, cursor based, stops at a row limit), filter search, highlighting and display text.
import type { JNode } from '../../shared/types';
import { plural } from './body-model';

export type JsonRowKind =
  /** Scalar or empty container: one line. */
  | 'leaf'
  /** Expanded container: opening bracket line (children follow). */
  | 'open'
  /** Closing bracket line of an expanded container. */
  | 'close'
  /** Collapsed non-empty container: one summary line. */
  | 'collapsed';

export interface JsonRow {
  kind: JsonRowKind;
  node: JNode;
  depth: number;
  /** Object key (string) or array index (number) shown before the value; undefined for the root. */
  label?: string | number;
  /** Path from the root (object keys and array indices). */
  path: Array<string | number>;
  /** A trailing comma follows (the node is not the last child of its parent). */
  comma: boolean;
  /** Index (in the rows array) of the parent's 'open' row, -1 for the root. */
  parentIndex: number;
}

export interface FlattenOptions {
  /** Whether a non-empty container is expanded. */
  isExpanded(node: JNode, depth: number): boolean;
  /** Stop after this many rows. */
  limit: number;
  /**
   * "Only matches" mode: show just matching nodes, their ancestors and everything inside a matching
   * container. Other nodes are skipped.
   */
  restrictTo?: SearchResult;
}

export interface FlattenResult {
  rows: JsonRow[];
  /** More rows exist beyond `limit`. */
  more: boolean;
}

export function isContainer(node: JNode): boolean {
  return node.type === 'object' || node.type === 'array';
}

function childCount(node: JNode): number {
  return node.children?.length ?? 0;
}

interface Frame {
  node: JNode;
  depth: number;
  path: Array<string | number>;
  comma: boolean;
  /** Row index of this container's 'open' row. */
  openIndex: number;
  /** Next child to visit. */
  next: number;
  insideMatch: boolean;
}

/**
 * Flatten the visible part of a tree into rows, depth first. Work is proportional to the number of rows
 * produced (children are visited through a cursor, never copied), so huge collapsed or paginated trees
 * stay cheap, and the traversal is iterative (no recursion limit on deeply nested JSON).
 */
export function flattenJson(root: JNode, opts: FlattenOptions): FlattenResult {
  const rows: JsonRow[] = [];
  const stack: Frame[] = [];
  const restrict = opts.restrictTo;
  const limit = Math.max(1, opts.limit);

  const visible = (node: JNode, insideMatch: boolean) =>
    !restrict || insideMatch || restrict.matches.has(node.id) || restrict.ancestors.has(node.id);

  /** Emit the row(s) for `node`; returns false when the limit was reached before emitting. */
  const visit = (
    node: JNode,
    depth: number,
    label: string | number | undefined,
    path: Array<string | number>,
    comma: boolean,
    parentIndex: number,
    insideMatchParent: boolean,
  ): boolean => {
    if (rows.length >= limit) return false;
    const insideMatch = insideMatchParent || (restrict?.matches.has(node.id) ?? false);
    if (!isContainer(node) || childCount(node) === 0) {
      rows.push({ kind: 'leaf', node, depth, label, path, comma, parentIndex });
      return true;
    }
    const forcedOpen = restrict !== undefined && !insideMatch && restrict.ancestors.has(node.id);
    if (!forcedOpen && !opts.isExpanded(node, depth)) {
      rows.push({ kind: 'collapsed', node, depth, label, path, comma, parentIndex });
      return true;
    }
    rows.push({ kind: 'open', node, depth, label, path, comma, parentIndex });
    stack.push({ node, depth, path, comma, openIndex: rows.length - 1, next: 0, insideMatch });
    return true;
  };

  if (visible(root, false)) visit(root, 0, undefined, [], false, -1, false);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const children = frame.node.children ?? [];
    if (frame.next < children.length) {
      const index = frame.next;
      const child = children[index];
      if (!visible(child, frame.insideMatch)) {
        frame.next++;
        continue;
      }
      if (rows.length >= limit) return { rows, more: true };
      frame.next++;
      const label = frame.node.type === 'array' ? index : (child.key ?? '');
      const comma = hasVisibleSibling(children, index + 1, frame.insideMatch, visible);
      visit(child, frame.depth + 1, label, [...frame.path, label], comma, frame.openIndex, frame.insideMatch);
      continue;
    }
    if (rows.length >= limit) return { rows, more: true };
    stack.pop();
    rows.push({
      kind: 'close',
      node: frame.node,
      depth: frame.depth,
      label: undefined,
      path: frame.path,
      comma: frame.comma,
      parentIndex: frame.openIndex,
    });
  }
  return { rows, more: false };
}

function hasVisibleSibling(
  children: JNode[],
  from: number,
  insideMatch: boolean,
  visible: (node: JNode, insideMatch: boolean) => boolean,
): boolean {
  for (let i = from; i < children.length; i++) if (visible(children[i], insideMatch)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export interface SearchResult {
  /** Nodes whose key or scalar value contains the query. */
  matches: Set<string>;
  /** Containers that have a match somewhere below them (auto-expanded while filtering). */
  ancestors: Set<string>;
}

/** Text a scalar contributes to search and display ('' for containers). */
export function scalarSearchText(node: JNode): string {
  switch (node.type) {
    case 'string':
    case 'number':
      return String(node.value ?? '');
    case 'boolean':
      return node.value === true ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      return '';
  }
}

/**
 * Case-insensitive search over object keys and scalar values. Iterative; ancestors are recorded by walking
 * the current stack down until an already-recorded ancestor (amortized linear time).
 */
export function searchJson(root: JNode, query: string): SearchResult {
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  const q = query.trim().toLowerCase();
  if (!q) return { matches, ancestors };

  const chain: JNode[] = [];
  const work: Array<{ node: JNode; depth: number }> = [{ node: root, depth: 0 }];
  while (work.length > 0) {
    const { node, depth } = work.pop()!;
    chain.length = depth;
    const keyHit = node.key !== undefined && node.key.toLowerCase().includes(q);
    const valueHit = !isContainer(node) && scalarSearchText(node).toLowerCase().includes(q);
    if (keyHit || valueHit) {
      matches.add(node.id);
      for (let i = chain.length - 1; i >= 0 && !ancestors.has(chain[i].id); i--) ancestors.add(chain[i].id);
    }
    const children = node.children;
    if (children && children.length > 0) {
      chain.push(node);
      for (let i = children.length - 1; i >= 0; i--) work.push({ node: children[i], depth: depth + 1 });
    }
  }
  return { matches, ancestors };
}

/** A piece of text, flagged when it is part of a search match. */
export interface Segment {
  text: string;
  match: boolean;
}

/** Split `text` into segments around case-insensitive occurrences of `query`. */
export function highlightSegments(text: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  // Lower-casing can change length for a few code points; fall back to no highlight then.
  if (lower.length !== text.length) return [{ text, match: false }];
  const out: Segment[] = [];
  let from = 0;
  let idx: number;
  while ((idx = lower.indexOf(q, from)) !== -1) {
    if (idx > from) out.push({ text: text.slice(from, idx), match: false });
    out.push({ text: text.slice(idx, idx + q.length), match: true });
    from = idx + q.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out.length > 0 ? out : [{ text, match: false }];
}

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

/** Max characters of a string value rendered before it is clipped (the full value stays copyable). */
export const STRING_DISPLAY_MAX = 4000;

/** Display text of a scalar or empty container as it would appear in pretty JSON. */
export function leafText(node: JNode): string {
  switch (node.type) {
    case 'string':
      return JSON.stringify(String(node.value ?? ''));
    case 'object':
      return '{}';
    case 'array':
      return '[]';
    default:
      return scalarSearchText(node);
  }
}

/** "{…}" + "12 keys" / "[…]" + "30 items" for a collapsed container. */
export function containerSummary(node: JNode): { brackets: string; count: string } {
  const n = childCount(node);
  return node.type === 'array' ? { brackets: '[…]', count: plural(n, 'item') } : { brackets: '{…}', count: plural(n, 'key') };
}

export function openBracket(node: JNode): string {
  return node.type === 'array' ? '[' : '{';
}

export function closeBracket(node: JNode): string {
  return node.type === 'array' ? ']' : '}';
}

/** Text a "copy value" action puts on the clipboard for a scalar (containers are serialized by the caller). */
export function scalarCopyText(node: JNode): string {
  return node.type === 'string' ? String(node.value ?? '') : scalarSearchText(node);
}

/** Ids of every container in the tree (used by "Expand all" in only-matches mode and tests). */
export function collectContainerIds(root: JNode): Set<string> {
  const ids = new Set<string>();
  const work: JNode[] = [root];
  while (work.length > 0) {
    const node = work.pop()!;
    if (isContainer(node)) {
      ids.add(node.id);
      if (node.children) for (const c of node.children) work.push(c);
    }
  }
  return ids;
}

/**
 * Ids of the containers from the root down to the node with `id` (excluded), in order; [] for the root itself, null
 * when the node is not in the tree. Iterative (deep trees are fine). Used to expand the way to a revealed node.
 */
export function ancestorIds(root: JNode, id: string): string[] | null {
  if (root.id === id) return [];
  const chain: JNode[] = [root];
  const next: number[] = [0];
  while (chain.length > 0) {
    const top = chain[chain.length - 1]!;
    const kids = isContainer(top) ? (top.children ?? []) : [];
    const i = next[next.length - 1]!;
    if (i >= kids.length) {
      chain.pop();
      next.pop();
      continue;
    }
    next[next.length - 1] = i + 1;
    const child = kids[i]!;
    if (child.id === id) return chain.map((n) => n.id);
    if (isContainer(child) && (child.children?.length ?? 0) > 0) {
      chain.push(child);
      next.push(0);
    }
  }
  return null;
}
