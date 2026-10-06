// Top-frame answers to the service worker's Claude Code bridge queries (BRIDGE_LIST / BRIDGE_ENTRY,
// docs/specs/v0.2.md §B.4). Pure over the store's entries; the worker formats and redacts.
import type { BridgeEntryResponse, BridgeListResponse, BridgeListRow } from '../shared/messages';
import type { HeaderPair, RequestEntry } from '../shared/types';

/** URLs in list rows are clipped to this many chars (data: URLs can be megabytes). */
export const BRIDGE_ROW_URL_MAX = 4096;
const MAX_ID_LENGTH = 128;

function contentLength(headers: HeaderPair[] | undefined): number | undefined {
  const raw = headers?.find((h) => h.name.toLowerCase() === 'content-length')?.value;
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function responseSize(entry: RequestEntry): number | undefined {
  const body = entry.responseBody;
  if (body && (body.kind === 'text' || body.kind === 'base64')) return body.size;
  return contentLength(entry.responseHeaders) ?? contentLength(entry.wire?.responseHeaders);
}

/** Lightweight summary of one entry. */
export function bridgeListRow(entry: RequestEntry): BridgeListRow {
  const row: BridgeListRow = {
    id: entry.id,
    source: entry.source,
    method: entry.method,
    url: entry.url.length > BRIDGE_ROW_URL_MAX ? `${entry.url.slice(0, BRIDGE_ROW_URL_MAX)}…` : entry.url,
    kind: entry.kind,
    state: entry.state,
    startTime: entry.startTime,
  };
  const status = entry.status ?? entry.wire?.statusCode;
  if (typeof status === 'number') row.status = status;
  if (typeof entry.endTime === 'number' && entry.endTime >= entry.startTime) row.durationMs = entry.endTime - entry.startTime;
  const size = responseSize(entry);
  if (size !== undefined) row.size = size;
  return row;
}

/** BRIDGE_LIST answer. */
export function bridgeList(entries: readonly RequestEntry[], pageUrl: string, countOnly: boolean): BridgeListResponse {
  return { pageUrl, count: entries.length, rows: countOnly ? [] : entries.map(bridgeListRow) };
}

/** BRIDGE_ENTRY answer (null for unknown or malformed ids). */
export function bridgeEntry(lookup: (id: string) => RequestEntry | undefined, id: unknown, pageUrl: string): BridgeEntryResponse {
  const valid = typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
  return { pageUrl, entry: valid ? (lookup(id) ?? null) : null };
}
