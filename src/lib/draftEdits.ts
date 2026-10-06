// Edits of a request draft described as data (the Claude Code `edit_request` tool, src/shared/control-protocol.ts
// DraftEditArgs): the same changes the editor's controls make — method, URL, query / header / form rows, the body
// as raw text or by JSON path, body type, reverts per field / section / all. Pure and atomic: either every edit
// applies, or the draft is returned unchanged with the reasons.
import type { DraftEditArgs, JsonEdit, KvEdit, RevertTarget } from '../shared/control-protocol';
import type { BodyModel, Draft, DraftSection, JNode, KVRow, MultipartPart } from '../shared/types';
import { rawTextToBody } from './body';
import { applyFullUrl, revertDraft, revertJsonNode, revertRowIn, revertSection, setBodyType } from './draft';
import { uid } from './ids';
import { alignTreeIds, changeNodeType, getNodeAtPath, isValidNumberLiteral, removeNode, updateNode, valueToJsonTree } from './json-tree';
import { createRow } from './kv';

/** An edit that cannot apply; the message says what to fix. */
export class DraftEditError extends Error {}

export interface DraftEditOutcome {
  draft: Draft;
  /** What was changed, one line each. */
  applied: string[];
}

const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const STANDARD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SECTIONS: ReadonlySet<string> = new Set<DraftSection>(['method', 'url', 'query', 'headers', 'body']);

type Seg = string | number;

function fail(message: string): never {
  throw new DraftEditError(message);
}

// ------------------------------------------------------------------------------------------- paths

/**
 * A body path: `user.name`, `items[0].id`, `a["b.c"]`, `$.user.name`, `.user` — the data-path format of the JSON
 * editor (json-tree formatPath) with an optional `$` / leading dot. "" or "$" is the root. Null when malformed.
 */
export function parseBodyPath(text: string): Seg[] | null {
  let s = text.trim();
  if (s.startsWith('$')) s = s.slice(1);
  const out: Seg[] = [];
  let i = 0;
  const ident = /^[A-Za-z_$][\w$-]*/;
  if (s && s[0] !== '.' && s[0] !== '[') {
    const m = ident.exec(s);
    if (!m) return null;
    out.push(m[0]);
    i = m[0].length;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      const m = /^[^.[\]]+/.exec(s.slice(i + 1));
      if (!m) return null;
      out.push(m[0]);
      i += 1 + m[0].length;
    } else if (c === '[') {
      const close = findClose(s, i);
      if (close < 0) return null;
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (inner.startsWith('"')) {
        try {
          const key: unknown = JSON.parse(inner);
          if (typeof key !== 'string') return null;
          out.push(key);
        } catch {
          return null;
        }
      } else if (/^'.*'$/.test(inner)) out.push(inner.slice(1, -1));
      else return null;
      i = close + 1;
    } else return null;
  }
  return out;
}

/** Index of the `]` closing the bracket at `open` (quotes inside are skipped). */
function findClose(s: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return i;
  }
  return -1;
}

function pathText(path: Seg[]): string {
  return path.length ? path.map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : /^[A-Za-z_$][\w$]*$/.test(seg) ? `${i ? '.' : ''}${seg}` : `[${JSON.stringify(seg)}]`)).join('') : '(root)';
}

// ------------------------------------------------------------------------------------------- rows

type RowMatch = (key: string, name: string) => boolean;
const exactName: RowMatch = (key, name) => key === name;
const anyCase: RowMatch = (key, name) => key.toLowerCase() === name.toLowerCase();

function rowsNamed(rows: readonly KVRow[], name: string, match: RowMatch): KVRow[] {
  return rows.filter((row) => match(row.key, name));
}

/** Apply one KvEdit to rows (query / headers / form). */
function editRows(rows: KVRow[], edit: KvEdit, match: RowMatch, what: string): KVRow[] {
  const named = rowsNamed(rows, edit.name, match);
  if (edit.remove) {
    if (!named.length) fail(`There is no ${what} named "${edit.name}" to remove`);
    const drop = edit.index !== undefined ? [named[edit.index]] : named;
    if (drop.some((row) => !row)) fail(`There is no ${what} "${edit.name}" #${edit.index}`);
    const ids = new Set(drop.map((row) => row!.id));
    return rows.filter((row) => !ids.has(row.id));
  }
  if (edit.add || !named.length) {
    if (edit.index !== undefined && edit.index > 0 && !edit.add) fail(`There is no ${what} "${edit.name}" #${edit.index}`);
    if (edit.rename !== undefined && !edit.add) fail(`There is no ${what} named "${edit.name}" to rename`);
    const row = createRow(edit.name, edit.value ?? '', edit.enabled ?? true);
    return [...rows, row];
  }
  const target = named[edit.index ?? 0];
  if (!target) fail(`There is no ${what} "${edit.name}" #${edit.index}`);
  const patch: Partial<KVRow> = {};
  if (edit.value !== undefined) patch.value = edit.value;
  if (edit.enabled !== undefined) patch.enabled = edit.enabled;
  if (edit.rename !== undefined) patch.key = edit.rename;
  return rows.map((row) => (row.id === target.id ? { ...row, ...patch } : row));
}

/** Apply one KvEdit to multipart parts (text parts by name). */
function editParts(parts: MultipartPart[], edit: KvEdit): MultipartPart[] {
  const named = parts.filter((part) => part.name === edit.name);
  if (edit.remove) {
    if (!named.length) fail(`There is no multipart part named "${edit.name}" to remove`);
    const drop = edit.index !== undefined ? [named[edit.index]] : named;
    if (drop.some((part) => !part)) fail(`There is no multipart part "${edit.name}" #${edit.index}`);
    const ids = new Set(drop.map((part) => part!.id));
    return parts.filter((part) => !ids.has(part.id));
  }
  if (edit.add || !named.length) {
    if (edit.rename !== undefined && !edit.add) fail(`There is no multipart part named "${edit.name}" to rename`);
    const part: MultipartPart = { id: uid('mp'), enabled: edit.enabled ?? true, name: edit.name, kind: 'text', value: edit.value ?? '' };
    return [...parts, part];
  }
  const target = named[edit.index ?? 0];
  if (!target) fail(`There is no multipart part "${edit.name}" #${edit.index}`);
  if (edit.value !== undefined && target.kind === 'file') fail(`"${edit.name}" is a file part: replace files in the kineReqLens overlay`);
  return parts.map((part) => {
    if (part.id !== target.id) return part;
    const next: MultipartPart = { ...part };
    if (edit.value !== undefined) next.value = edit.value;
    if (edit.enabled !== undefined) next.enabled = edit.enabled;
    if (edit.rename !== undefined) next.name = edit.rename;
    return next;
  });
}

// ------------------------------------------------------------------------------------------- JSON

const NODE_TYPES = new Set(['string', 'number', 'boolean', 'null', 'object', 'array']);

function childIndexOf(node: JNode, seg: Seg): number {
  const kids = node.children ?? [];
  if (node.type === 'object') return kids.findIndex((child) => (child.key ?? '') === String(seg));
  if (node.type === 'array') {
    const index = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : -1;
    return index >= 0 && index < kids.length ? index : -1;
  }
  return -1;
}

/** A node for `value` (with `type` forcing the JSON type: e.g. a number literal given as a string). */
function nodeFor(value: unknown, type: JsonEdit['type'], key: string | undefined): JNode {
  if (type === undefined) return valueToJsonTree(value, key);
  switch (type) {
    case 'string':
      return withKeyOf({ id: uid('j'), type: 'string', value: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }, key);
    case 'number': {
      const literal = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
      if (!isValidNumberLiteral(literal)) fail(`${JSON.stringify(value)} is not a valid JSON number`);
      return withKeyOf({ id: uid('j'), type: 'number', value: literal }, key);
    }
    case 'boolean': {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') fail(`${JSON.stringify(value)} is not a boolean`);
      return withKeyOf({ id: uid('j'), type: 'boolean', value: value === true || value === 'true' }, key);
    }
    case 'null':
      return withKeyOf({ id: uid('j'), type: 'null' }, key);
    case 'object':
    case 'array': {
      const node = valueToJsonTree(value, key);
      if (node.type !== type) fail(`The value is not ${type === 'object' ? 'an object' : 'an array'}`);
      return node;
    }
    default:
      return fail(`Unknown type "${String(type)}"`);
  }
}

function withKeyOf(node: JNode, key: string | undefined): JNode {
  return key === undefined ? node : { ...node, key };
}

function emptyContainerFor(next: Seg, key: string | undefined): JNode {
  return withKeyOf({ id: uid('j'), type: typeof next === 'number' ? 'array' : 'object', children: [] }, key);
}

/** Set (creating missing objects / an appended array item) the node at `path` to `make(existing)`. */
function setAtPath(node: JNode, path: Seg[], at: number, make: (existing: JNode | null, key: string | undefined) => JNode): JNode {
  if (at === path.length) return make(node, node.key);
  if (node.type !== 'object' && node.type !== 'array') fail(`${pathText(path.slice(0, at))} is a ${node.type}, not an object or array`);
  const seg = path[at]!;
  const kids = node.children ?? [];
  const index = childIndexOf(node, seg);
  if (index >= 0) {
    const child = kids[index]!;
    const next = setAtPath(child, path, at + 1, make);
    if (next === child) return node;
    const children = kids.slice();
    children[index] = next;
    return { ...node, children };
  }
  const rest = at + 1 < path.length;
  if (node.type === 'array') {
    const i = typeof seg === 'number' ? seg : Number(seg);
    if (i !== kids.length) fail(`${pathText(path.slice(0, at + 1))} is out of range (the array has ${kids.length} items; use index ${kids.length} to append)`);
    const created = rest ? setAtPath(emptyContainerFor(path[at + 1]!, undefined), path, at + 1, make) : make(null, undefined);
    const { key: _drop, ...item } = created;
    return { ...node, children: [...kids, item] };
  }
  const key = String(seg);
  const created = rest ? setAtPath(emptyContainerFor(path[at + 1]!, key), path, at + 1, make) : make(null, key);
  return { ...node, children: [...kids, { ...created, key }] };
}

/** Apply one JsonEdit to a tree. */
function editTree(tree: JNode, edit: JsonEdit): JNode {
  const path = parseBodyPath(edit.path);
  if (!path) fail(`"${edit.path}" is not a valid path (e.g. user.name, items[0].id, a["b.c"])`);
  const label = pathText(path);
  if (edit.remove) {
    if (!path.length) fail('The root cannot be removed (set bodyType "none" instead)');
    const node = getNodeAtPath(tree, path);
    if (!node) fail(`There is no value at ${label}`);
    return removeNode(tree, node.id);
  }
  let next = tree;
  if (edit.value !== undefined) {
    if (edit.type !== undefined && !NODE_TYPES.has(edit.type)) fail(`Unknown type "${String(edit.type)}"`);
    next = setAtPath(next, path, 0, (existing, key) => {
      const node = nodeFor(edit.value, edit.type, key);
      // Keep the ids of what is replaced, so the editor's modified markers and per-field revert keep working.
      return existing ? alignTreeIds({ ...node, ...(existing.key !== undefined ? { key: existing.key } : {}) }, existing) : node;
    });
  } else if (edit.type !== undefined) {
    if (!NODE_TYPES.has(edit.type)) fail(`Unknown type "${String(edit.type)}"`);
    const node = getNodeAtPath(next, path);
    if (!node) fail(`There is no value at ${label}`);
    next = changeNodeType(next, node.id, edit.type);
  }
  if (edit.rename !== undefined) {
    if (!path.length || typeof path[path.length - 1] === 'number') fail(`${label} is not an object member: nothing to rename`);
    const node = getNodeAtPath(next, path);
    if (!node) fail(`There is no value at ${label}`);
    next = updateNode(next, node.id, { key: edit.rename });
  }
  if (edit.value === undefined && edit.type === undefined && edit.rename === undefined) fail(`Nothing to change at ${label}: give value, type, rename or remove`);
  return next;
}

// ------------------------------------------------------------------------------------------- revert

function revertTarget(draft: Draft, target: RevertTarget): Draft {
  if (typeof target === 'string') {
    if (target === 'all') return revertDraft(draft);
    if (!SECTIONS.has(target)) fail(`Unknown revert target "${target}"`);
    // The URL field shows base + hash; its params live in the query section (the editor reverts both).
    if (target === 'url') return revertSection(revertSection(draft, 'url'), 'query');
    return revertSection(draft, target as DraftSection);
  }
  if ('path' in target) {
    const path = parseBodyPath(target.path);
    if (!path) fail(`"${target.path}" is not a valid path`);
    if (draft.body.type !== 'json') fail('The body is not JSON: nothing to revert by path');
    const current = getNodeAtPath(draft.body.tree, path);
    const original = draft.original.body.type === 'json' ? getNodeAtPath(draft.original.body.tree, path) : null;
    const id = current?.id ?? original?.id;
    if (!id) fail(`There is no value at ${pathText(path)} in the draft or the captured request`);
    return revertJsonNode(draft, id);
  }
  const [where, name, rows, originalRows, match]: [('query' | 'headers' | 'form'), string, readonly KVRow[], readonly KVRow[], RowMatch] =
    'param' in target
      ? ['query', target.param, draft.query, draft.original.query, exactName]
      : 'header' in target
        ? ['headers', target.header, draft.headers, draft.original.headers, anyCase]
        : ['form', target.field, draft.body.type === 'form' ? draft.body.rows : [], draft.original.body.type === 'form' ? draft.original.body.rows : [], exactName];
  const index = target.index ?? 0;
  if (where === 'form' && draft.body.type === 'multipart') {
    const part = draft.body.parts.filter((p) => p.name === name)[index] ?? (draft.original.body.type === 'multipart' ? draft.original.body.parts.filter((p) => p.name === name)[index] : undefined);
    if (!part) fail(`There is no multipart part "${name}" to revert`);
    return revertRowIn(draft, 'multipart', part.id);
  }
  const row = rowsNamed(rows, name, match)[index] ?? rowsNamed(originalRows, name, match)[index];
  if (!row) fail(`There is no ${where === 'query' ? 'query parameter' : where === 'headers' ? 'header' : 'form field'} "${name}" to revert`);
  return revertRowIn(draft, where, row.id);
}

// ------------------------------------------------------------------------------------------- apply

function bodyWith(draft: Draft, body: BodyModel): Draft {
  return body === draft.body ? draft : { ...draft, body };
}

/**
 * Apply `edit` to `draft` (order: revert, method, url, params, headers, bodyType, body, form, json). Send options are
 * not part of the draft (the caller applies `edit.options`). Throws DraftEditError — nothing applies — when an edit
 * cannot apply.
 */
export function applyDraftEdits(draft: Draft, edit: DraftEditArgs): DraftEditOutcome {
  let next = draft;
  const applied: string[] = [];
  for (const target of edit.revert ?? []) {
    next = revertTarget(next, target);
    applied.push(`reverted ${typeof target === 'string' ? target : JSON.stringify(target)}`);
  }
  if (edit.method !== undefined) {
    const method = edit.method.trim();
    if (!METHOD_TOKEN.test(method)) fail(`"${edit.method}" is not an HTTP method`);
    const upper = method.toUpperCase();
    next = { ...next, method: STANDARD_METHODS.has(upper) ? upper : method };
    applied.push(`method ${next.method}`);
  }
  if (edit.url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(edit.url.trim());
    } catch {
      fail(`"${edit.url}" is not an absolute URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('The URL must use http or https');
    next = applyFullUrl(next, edit.url);
    applied.push('url');
  }
  for (const kv of edit.params ?? []) {
    next = { ...next, query: editRows(next.query, kv, exactName, 'query parameter') };
    applied.push(`param ${kv.name}`);
  }
  for (const kv of edit.headers ?? []) {
    next = { ...next, headers: editRows(next.headers, kv, anyCase, 'header') };
    applied.push(`header ${kv.name}`);
  }
  if (edit.bodyType !== undefined) {
    next = setBodyType(next, edit.bodyType);
    applied.push(`body type ${edit.bodyType}`);
  }
  if (edit.body !== undefined) {
    // Like the Raw view: parsed into a body of the current type (none / unavailable become text).
    const parsed = rawTextToBody(edit.body, next.body);
    if ('error' in parsed) fail(`The body does not parse as ${next.body.type}: ${parsed.error}`);
    next = bodyWith(next, parsed.model);
    applied.push('body (raw)');
  }
  for (const kv of edit.form ?? []) {
    const body = next.body;
    if (body.type === 'form') next = bodyWith(next, { type: 'form', rows: editRows(body.rows, kv, exactName, 'form field') });
    else if (body.type === 'multipart') next = bodyWith(next, { ...body, parts: editParts(body.parts, kv) });
    else fail(`The body is ${body.type}, not a form: set bodyType "form" or "multipart" first`);
    applied.push(`field ${kv.name}`);
  }
  if (edit.json?.length) {
    let body = next.body;
    if (body.type === 'none') {
      next = setBodyType(next, 'json');
      body = next.body;
    }
    if (body.type !== 'json') fail(`The body is ${body.type}, not JSON: set bodyType "json" first (or edit the raw body)`);
    let tree = body.tree;
    for (const item of edit.json) {
      tree = editTree(tree, item);
      applied.push(`json ${item.path || '(root)'}`);
    }
    next = bodyWith(next, { ...body, tree });
  }
  return { draft: next, applied };
}
