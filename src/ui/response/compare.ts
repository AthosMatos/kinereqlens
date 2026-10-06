// OWNER: ui-response agent. Pure helpers behind the Compare view (body text for diffing, header/status changes).
import type { HeaderPair, ResponseData } from '../../shared/types';
import type { DiffLine } from '../../lib/diff';
import { prettyJson } from '../../lib/format';
import { resolveBody } from './body-model';

/** Text of one side of a body comparison. */
export interface CompareText {
  text: string;
  kind: 'json' | 'text' | 'binary' | 'empty' | 'none';
  truncated: boolean;
}

/** 32-bit FNV-1a hash of a string, as 8 hex digits (cheap fingerprint for binary bodies). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Body text to diff: pretty-printed (lossless) JSON when the body is JSON, the raw text otherwise, and a
 * one-line fingerprint for binary bodies (size, type and hash, so different bytes never look identical).
 */
export function responseCompareText(resp: ResponseData): CompareText {
  if (!resp.body) return { text: '', kind: 'none', truncated: false };
  const body = resolveBody(resp.body, resp.headers);
  switch (body.kind) {
    case 'empty':
      return { text: '', kind: 'empty', truncated: false };
    case 'unavailable':
      return { text: '', kind: 'none', truncated: false };
    case 'binary':
      return {
        text: `[binary body · ${body.size} bytes · ${body.mime || 'unknown type'} · fnv1a ${fnv1a(body.base64)}]`,
        kind: 'binary',
        truncated: body.truncated,
      };
    case 'text': {
      const pretty = body.jsonCandidate ? prettyJson(body.text) : null;
      return pretty !== null
        ? { text: pretty, kind: 'json', truncated: body.truncated }
        : { text: body.text, kind: 'text', truncated: body.truncated };
    }
  }
}

/** One header difference. `before`/`after` are all values of that header joined with ", ". */
export interface HeaderChange {
  name: string;
  before?: string;
  after?: string;
  /** Header that naturally changes between responses (date, request ids, timings…). */
  volatile: boolean;
}

export interface HeaderComparison {
  added: HeaderChange[];
  removed: HeaderChange[];
  changed: HeaderChange[];
  /** Number of headers present with identical values on both sides. */
  same: number;
}

const VOLATILE_HEADERS = new Set([
  'date',
  'age',
  'expires',
  'last-modified',
  'etag',
  'set-cookie',
  'server-timing',
  'x-request-id',
  'x-correlation-id',
  'request-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-amz-id-2',
  'x-amzn-trace-id',
  'x-cloud-trace-context',
  'cf-ray',
  'x-runtime',
  'x-response-time',
  'x-served-by',
  'x-timer',
  'x-cache',
  'x-cache-hits',
  'traceparent',
  'tracestate',
  'x-trace-id',
  'report-to',
  'nel',
  'content-length',
]);

/** True for headers that are expected to differ between two otherwise identical responses. */
export function isVolatileHeader(name: string): boolean {
  return VOLATILE_HEADERS.has(name.toLowerCase());
}

/** Group headers by lower-cased name, keeping first-seen casing and joining repeated values. */
function groupHeaders(headers: HeaderPair[]): Map<string, { name: string; value: string }> {
  const out = new Map<string, { name: string; value: string }>();
  for (const h of headers) {
    const key = h.name.toLowerCase();
    const prev = out.get(key);
    if (prev) prev.value += `, ${h.value}`;
    else out.set(key, { name: h.name, value: h.value });
  }
  return out;
}

/** Case-insensitive header comparison; output lists keep the order headers appear in. */
export function compareHeaders(before: HeaderPair[], after: HeaderPair[]): HeaderComparison {
  const a = groupHeaders(before);
  const b = groupHeaders(after);
  const result: HeaderComparison = { added: [], removed: [], changed: [], same: 0 };
  for (const [key, { name, value }] of b) {
    const prev = a.get(key);
    if (!prev) result.added.push({ name, after: value, volatile: isVolatileHeader(key) });
    else if (prev.value !== value) result.changed.push({ name, before: prev.value, after: value, volatile: isVolatileHeader(key) });
    else result.same++;
  }
  for (const [key, { name, value }] of a) {
    if (!b.has(key)) result.removed.push({ name, before: value, volatile: isVolatileHeader(key) });
  }
  return result;
}

/** Number of header differences that are not just volatile noise. */
export function significantHeaderChanges(cmp: HeaderComparison): number {
  const count = (list: HeaderChange[]) => list.filter((c) => !c.volatile).length;
  return count(cmp.added) + count(cmp.removed) + count(cmp.changed);
}

/** A rendered diff row: a line, or a collapsed run of unchanged lines (`id` = its index in the context list). */
export type DiffRow = DiffLine | { op: 'skip'; count: number; id: number };

/**
 * Re-expand selected collapsed runs of a `withContext` result. `lines` is the full diff and `collapsed` the
 * output of `withContext(lines)` (same order; each skip marker stands for `count` consecutive lines).
 */
export function expandContext(
  lines: DiffLine[],
  collapsed: Array<DiffLine | { op: 'skip'; count: number }>,
  expanded: ReadonlySet<number>,
): DiffRow[] {
  const out: DiffRow[] = [];
  let cursor = 0;
  collapsed.forEach((item, id) => {
    if (item.op !== 'skip') {
      out.push(item);
      cursor++;
      return;
    }
    if (expanded.has(id)) {
      const end = Math.min(lines.length, cursor + item.count);
      for (; cursor < end; cursor++) out.push(lines[cursor]);
    } else {
      out.push({ op: 'skip', count: item.count, id });
      cursor += item.count;
    }
  });
  return out;
}
