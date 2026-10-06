// "Where does this come from?", panel side: search the captured response bodies of this page (hook-captured JSON /
// text, ≤ SOURCE_BODY_MAX each) and the WebSocket text messages for the texts of the element picked on the page.
// Runs over what the panel already has, in time slices (≤ 8 ms), abortable; results grouped by request / message.
import type { RequestEntry } from '../../shared/types';
import { formatPath } from '../../lib/json-tree';
import { buildSourceQueries, searchJsonValue, searchPlainText } from '../../lib/findSource';
import type { SourceQuery } from '../../lib/findSource';
import type { WsInspector } from '../../lib/ws-inspector';
import { payloadJson, payloadText } from '../../lib/ws-inspector';
import { resolveBody } from '../response/body-model';

/** Bodies larger than this are not searched. */
export const SOURCE_BODY_MAX = 2 * 1024 * 1024;
/** WebSocket messages searched at most (newest first). */
const SOURCE_MAX_FRAMES = 5000;
const SOURCE_MAX_GROUPS = 40;
const SLICE_MS = 8;

export interface SourceMatch {
  /** Path in the JSON body; null for a plain-text body. */
  path: Array<string | number> | null;
  /** formatPath of `path` ('' for the root), or the text snippet. */
  label: string;
  value: string;
  score: number;
  how: string;
}

export type SourceGroup =
  | { kind: 'entry'; entryId: string; time: number; score: number; total: number; matches: SourceMatch[] }
  | { kind: 'ws'; wsId: string; frameId: number; time: number; score: number; total: number; matches: SourceMatch[] };

export interface SourceResult {
  groups: SourceGroup[];
  /** Response bodies searched. */
  bodies: number;
  /** WebSocket messages searched. */
  frames: number;
  /** Bodies over SOURCE_BODY_MAX (not searched). */
  skipped: number;
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function matchesOf(value: unknown, text: string | null, queries: readonly SourceQuery[]): { total: number; matches: SourceMatch[] } {
  if (text === null) {
    const found = searchJsonValue(value, queries, 8);
    return {
      total: found.total,
      matches: found.hits.map((h) => ({ path: h.path, label: formatPath(h.path) || '(root)', value: h.value, score: h.score, how: h.how })),
    };
  }
  const found = searchPlainText(text, queries, 3);
  return { total: found.total, matches: found.hits.map((h) => ({ path: null, label: h.snippet, value: '', score: h.score, how: h.how })) };
}

/** Yield to the panel's event loop. */
const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Search `entries` (response bodies) and `ws` (text messages) for `texts` (normalized element texts). Groups are
 * sorted by best score, then newest first.
 */
export async function searchSources(
  texts: readonly string[],
  locales: readonly string[],
  entries: readonly RequestEntry[],
  ws: WsInspector | null,
  signal: { aborted: boolean },
): Promise<SourceResult> {
  const queries = buildSourceQueries(texts, locales);
  const result: SourceResult = { groups: [], bodies: 0, frames: 0, skipped: 0 };
  if (queries.length === 0) return result;
  let sliceStart = performance.now();
  const pause = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return;
    await yieldNow();
    sliceStart = performance.now();
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    if (signal.aborted) return result;
    const entry = entries[i]!;
    const body = entry.responseBody;
    if (!body || (body.kind !== 'text' && body.kind !== 'base64')) continue;
    const size = body.kind === 'text' ? body.text.length : body.base64.length * 0.75;
    if (size > SOURCE_BODY_MAX) {
      result.skipped++;
      continue;
    }
    const resolved = resolveBody(body, entry.responseHeaders ?? []);
    if (resolved.kind !== 'text' || !resolved.text) continue;
    result.bodies++;
    const json = resolved.jsonCandidate || looksLikeJson(resolved.text) ? parseJson(resolved.text) : ({ ok: false } as const);
    const { total, matches } = json.ok ? matchesOf(json.value, null, queries) : matchesOf(null, resolved.text, queries);
    if (total > 0) {
      result.groups.push({ kind: 'entry', entryId: entry.id, time: entry.startTime, score: Math.max(...matches.map((m) => m.score)), total, matches });
    }
    await pause();
  }

  if (ws) {
    const frames: Array<{ wsId: string; frame: ReturnType<WsInspector['frames']>[number] }> = [];
    for (const conn of ws.connections()) for (const frame of ws.frames(conn.wsId)) if (frame.opcode !== 'binary' && frame.text) frames.push({ wsId: conn.wsId, frame });
    frames.sort((a, b) => b.frame.id - a.frame.id);
    for (const { wsId, frame } of frames.slice(0, SOURCE_MAX_FRAMES)) {
      if (signal.aborted) return result;
      const cls = ws.info(frame);
      result.frames++;
      const value = payloadJson(frame, cls);
      const { total, matches } =
        value !== undefined && typeof value === 'object' && value !== null ? matchesOf(value, null, queries) : matchesOf(null, payloadText(frame, cls), queries);
      if (total > 0) result.groups.push({ kind: 'ws', wsId, frameId: frame.id, time: frame.time, score: Math.max(...matches.map((m) => m.score)), total, matches });
      await pause();
    }
  }

  result.groups.sort((a, b) => b.score - a.score || b.time - a.time);
  result.groups = result.groups.slice(0, SOURCE_MAX_GROUPS);
  return result;
}
