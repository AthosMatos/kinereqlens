// Errors view model (pure, docs/ARCHITECTURE.md §12): which captured requests failed, grouped by endpoint (method +
// host + path template, src/ui/list/endpointLabel.ts), with the filter chips' counts.
import type { RequestEntry } from '../../shared/types';
import type { ErrorKind } from '../../lib/errorPrompt';
import { endpointTemplate, groupKeyOf, templateText } from '../list/endpointLabel';

export type ErrorFilter = 'all' | '5xx' | '4xx' | 'network';

export const ERROR_FILTERS: ReadonlyArray<{ id: ErrorFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: '5xx', label: '5xx' },
  { id: '4xx', label: '4xx' },
  { id: 'network', label: 'Network' },
];

/** Short badge text of a kind. */
export const KIND_BADGE: Readonly<Record<ErrorKind, string>> = {
  '5xx': '5xx',
  '4xx': '4xx',
  network: 'Network',
  timeout: 'Timeout',
  aborted: 'Aborted',
};

/** Entry kinds that can be failing endpoints (images, fonts, media, sockets and user-made requests are not). */
const ERROR_ENTRY_KINDS: ReadonlySet<RequestEntry['kind']> = new Set(['fetch', 'xhr', 'beacon', 'document', 'subdocument', 'script', 'stylesheet', 'other']);

const TIMEOUT_RE = /time[d\s-]*out|TimeoutError/i;

/** Why a captured request failed, or null (pending, succeeded, not an endpoint, user-made, restored). */
export function classifyEntry(entry: RequestEntry): ErrorKind | null {
  if (entry.source === 'manual' || entry.restored || !ERROR_ENTRY_KINDS.has(entry.kind)) return null;
  switch (entry.state) {
    case 'pending':
      return null;
    case 'aborted':
      return TIMEOUT_RE.test(entry.error ?? '') ? 'timeout' : 'aborted';
    case 'error':
      return TIMEOUT_RE.test(entry.error ?? '') ? 'timeout' : 'network';
    case 'done': {
      const status = entry.status;
      if (typeof status !== 'number') return null;
      if (status >= 500 && status <= 599) return '5xx';
      if (status >= 400 && status <= 499) return '4xx';
      return null;
    }
    default:
      return null;
  }
}

/** Does a kind pass a filter chip? */
export function kindMatches(kind: ErrorKind, filter: ErrorFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'network') return kind === 'network' || kind === 'timeout' || kind === 'aborted';
  return kind === filter;
}

/** One failing endpoint. */
export interface ErrorGroup {
  /** method + template key, e.g. "GET https://api.example.com/orders/{id}". */
  key: string;
  method: string;
  /** host[:port] ('' for non-http URLs). */
  host: string;
  /** "api.example.com/orders/{id}". */
  template: string;
  /** "GET api.example.com/orders/{id}". */
  endpoint: string;
  /** Kind of the newest failing call. */
  kind: ErrorKind;
  /** Every kind seen, most recent first. */
  kinds: ErrorKind[];
  /** Failing calls. */
  count: number;
  /** HTTP status of the newest failing call (when it had one). */
  lastStatus?: number;
  /** Distinct statuses seen, newest first. */
  statuses: number[];
  firstSeen: number;
  lastSeen: number;
  /** Failing calls, newest first. */
  entryIds: string[];
}

function seenAt(entry: RequestEntry): number {
  return entry.endTime ?? entry.startTime;
}

/** Group the failing entries by endpoint, newest failure first. */
export function groupErrors(entries: readonly RequestEntry[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  const newest = new Map<string, number>();
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    if (!kind) continue;
    const key = groupKeyOf(entry);
    const at = seenAt(entry);
    let group = groups.get(key);
    if (!group) {
      const t = endpointTemplate(entry.url);
      const method = (entry.method || 'GET').toUpperCase();
      const template = templateText(t);
      group = { key, method, host: t.host, template, endpoint: `${method} ${template}`, kind, kinds: [], count: 0, statuses: [], firstSeen: at, lastSeen: at, entryIds: [] };
      groups.set(key, group);
      newest.set(key, -Infinity);
    }
    group.count++;
    group.entryIds.push(entry.id);
    if (!group.kinds.includes(kind)) group.kinds.push(kind);
    if (typeof entry.status === 'number' && entry.status > 0 && !group.statuses.includes(entry.status)) group.statuses.push(entry.status);
    if (at < group.firstSeen) group.firstSeen = at;
    if (at >= newest.get(key)!) {
      newest.set(key, at);
      group.lastSeen = at;
      group.kind = kind;
      if (typeof entry.status === 'number' && entry.status > 0) group.lastStatus = entry.status;
      else delete group.lastStatus;
    }
  }
  const byTime = (ids: string[], map: Map<string, RequestEntry>) => ids.sort((a, b) => seenAt(map.get(b)!) - seenAt(map.get(a)!));
  const index = new Map(entries.map((e) => [e.id, e] as const));
  const out = [...groups.values()];
  for (const g of out) {
    byTime(g.entryIds, index);
    // Kinds and statuses newest first.
    const order = g.entryIds.map((id) => index.get(id)!);
    g.kinds = [...new Set(order.map((e) => classifyEntry(e)!))];
    g.statuses = [...new Set(order.map((e) => e.status).filter((s): s is number => typeof s === 'number' && s > 0))].slice(0, 10);
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen || a.key.localeCompare(b.key));
}

/** Groups with a failure of the filter's kind (the newest kind decides). */
export function filterGroups(groups: readonly ErrorGroup[], filter: ErrorFilter): ErrorGroup[] {
  return filter === 'all' ? [...groups] : groups.filter((g) => kindMatches(g.kind, filter));
}

/** Counts per chip. */
export function filterCounts(groups: readonly ErrorGroup[]): Record<ErrorFilter, number> {
  const out: Record<ErrorFilter, number> = { all: groups.length, '5xx': 0, '4xx': 0, network: 0 };
  for (const g of groups) for (const f of ['5xx', '4xx', 'network'] as const) if (kindMatches(g.kind, f)) out[f]++;
  return out;
}

/** Same groups (keys, counts and newest kinds), for memo / notification checks. */
export function groupsSignature(groups: readonly ErrorGroup[]): string {
  return groups.map((g) => `${g.key}\u0001${g.count}\u0001${g.kind}\u0001${g.lastSeen}`).join('\u0002');
}

/** Persisted-analysis key of an endpoint (host + template + method). */
export function analysisKeyOf(group: Pick<ErrorGroup, 'key'>): string {
  return group.key;
}
