// Claude's send_request overrides (RequestOverrides, already validated by ./validate.ts) applied to the
// request built from the user's draft. Pure: used by the panel (src/ui/panel/claudeLink.ts), unit-tested.
import type { RequestOverrides } from '../../shared/claude-protocol';
import type { HeaderPair, ReplayRequest } from '../../shared/types';
import { encodeQueryComponent, splitUrl } from '../../lib/url';

const BODYLESS = new Set(['GET', 'HEAD']);

/** `url` with its query replaced by `pairs` (hash dropped: fetch never sends it). */
export function withQuery(url: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  const { base } = splitUrl(url);
  const query = pairs.map(([k, v]) => `${encodeQueryComponent(k)}=${encodeQueryComponent(v)}`).join('&');
  return query ? `${base}?${query}` : base;
}

/** Merge header overrides by name (case-insensitive): a value replaces every header of that name, null removes them. */
export function mergeHeaders(headers: readonly HeaderPair[], overrides: ReadonlyArray<readonly [string, string | null]>): HeaderPair[] {
  const names = new Set(overrides.map(([name]) => name.toLowerCase()));
  const out = headers.filter((h) => !names.has(h.name.toLowerCase()));
  const added = new Set<string>();
  // The last override of a name wins.
  for (let i = overrides.length - 1; i >= 0; i--) {
    const [name, value] = overrides[i]!;
    const key = name.toLowerCase();
    if (added.has(key)) continue;
    added.add(key);
    if (value !== null) out.push({ name, value });
  }
  return out;
}

/**
 * Apply overrides: method; url (full absolute URL, replaces the query unless `query` is given); query (replaces
 * all params); headers (merged by name); body (raw text). A GET/HEAD request drops the draft's body unless
 * Claude set one explicitly (then fetch reports the error).
 */
export function applyOverrides(req: ReplayRequest, overrides: RequestOverrides | undefined): ReplayRequest {
  if (!overrides) return req;
  const method = overrides.method ?? req.method;
  let url = overrides.url !== undefined ? splitUrl(overrides.url).base + queryPart(overrides.url) : req.url;
  if (overrides.query !== undefined) url = withQuery(url, overrides.query);
  const headers = overrides.headers ? mergeHeaders(req.headers, overrides.headers) : req.headers;
  let body = overrides.body !== undefined ? { kind: 'text' as const, text: overrides.body } : req.body;
  if (overrides.body === undefined && BODYLESS.has(method.toUpperCase())) body = { kind: 'none' };
  return { ...req, method, url, headers, body };
}

function queryPart(url: string): string {
  const { query } = splitUrl(url);
  return query ? `?${query}` : '';
}
