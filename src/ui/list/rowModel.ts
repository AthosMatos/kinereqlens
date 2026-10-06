// OWNER: ui-shell agent. Pure per-row display data for the request list (no DOM, unit tested).
import { formatClock, formatDuration } from '../../lib/format';
import type { HeaderPair, RequestEntry } from '../../shared/types';
import type { EndpointGroup } from './endpointLabel';
import { templateText } from './endpointLabel';

/** What the status cell shows. */
export type StatusCell =
  | { kind: 'pending' }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' }
  | { kind: 'code'; status: number; statusText: string }
  | { kind: 'none' };

export function statusCell(entry: RequestEntry): StatusCell {
  switch (entry.state) {
    case 'pending':
      return { kind: 'pending' };
    case 'aborted':
      return { kind: 'aborted' };
    case 'error':
      // The call failed even when the network answered (CORS, body read failed): show the failure, with the
      // network's status in the message — a green "200" would read as success.
      return {
        kind: 'error',
        message: entry.status ? `${entry.status} · ${entry.error || 'Request failed'}` : entry.error || 'Request failed',
      };
    default:
      if (entry.status) return { kind: 'code', status: entry.status, statusText: entry.statusText ?? '' };
      return { kind: 'none' };
  }
}

/** Wall time of the request in ms, or null while pending / unknown. */
export function durationMs(entry: RequestEntry): number | null {
  if (entry.endTime === undefined || !Number.isFinite(entry.endTime)) return null;
  const ms = entry.endTime - entry.startTime;
  return ms >= 0 ? ms : null;
}

function headerValue(headers: readonly HeaderPair[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/**
 * Response size in bytes: the captured body's full size, else Content-Length (page-visible headers, then
 * the wire headers seen by webRequest). Null when unknown.
 */
export function responseSize(entry: RequestEntry): number | null {
  const body = entry.responseBody;
  if (body && (body.kind === 'text' || body.kind === 'base64') && Number.isFinite(body.size)) return body.size;
  const raw =
    headerValue(entry.responseHeaders, 'content-length') ?? headerValue(entry.wire?.responseHeaders, 'content-length');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** Row tooltip: method + full URL, plus the final URL when redirected and the error when failed. */
export function rowTooltip(entry: RequestEntry): string {
  const lines = [`${entry.method} ${entry.url}`];
  if (entry.redirected && entry.responseUrl && entry.responseUrl !== entry.url) lines.push(`→ ${entry.responseUrl}`);
  if (entry.state === 'error' && entry.error) lines.push(`Error: ${entry.error}`);
  if (entry.state === 'aborted') lines.push('Canceled');
  if (entry.fromCache) lines.push('Served from cache');
  if (entry.restored) lines.push('From a previous page (preserved log)');
  return lines.join('\n');
}

/**
 * Short query preview for the name cell: "?a=1&b=2" capped to `max` characters (with an ellipsis), or ''
 * when there is no query.
 */
export function queryPreview(query: string, max = 80): string {
  if (!query) return '';
  const text = `?${query}`;
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

const OUTCOME_TEXT: Record<string, string> = { error: 'failed', aborted: 'canceled', unknown: 'no status' };

/**
 * Group row tooltip: method + template (scheme included), call count and outcomes, durations, time span, and
 * the newest call's URL.
 */
export function groupTooltip(group: EndpointGroup): string {
  const { stats } = group;
  const lines = [`${group.method} ${templateText(group.template, true)}`];
  const outcomes = stats.outcomes.map((o) => `${OUTCOME_TEXT[o.outcome] ?? o.outcome} ×${o.count}`);
  if (stats.pending) outcomes.push(`pending ×${stats.pending}`);
  lines.push(`${stats.count} calls${outcomes.length ? ` · ${outcomes.join(' · ')}` : ''}`);
  if (stats.avgMs !== null) lines.push(`avg ${formatDuration(stats.avgMs)} · last ${formatDuration(stats.lastMs)}`);
  lines.push(`${formatClock(stats.oldestTime)} – ${formatClock(stats.newestTime)}`);
  lines.push(`Newest: ${group.newest.url}`);
  return lines.join('\n');
}
