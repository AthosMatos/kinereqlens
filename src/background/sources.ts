// Source-map resolution for the Initiator tab (RESOLVE_INITIATOR, src/shared/initiator-protocol.ts).
//
// The worker fetches the page's scripts and their source maps with its host permissions (the page never sees
// these requests, and they are not listed: they have no tab), caps every download at SOURCE_FETCH_MAX_BYTES
// with a timeout, and caches scripts and decoded maps by URL (LRU, bounded by size). Credentials (cookies) are
// only sent to the page's own origin, like the page's own script loads; other origins are fetched without.
// Started only by the overlay panel, i.e. by a user opening the Initiator tab.
import type { ResolvedFrame, ResolveFrameRequest } from '../shared/initiator-protocol';
import { RESOLVE_MAX_FRAMES, SOURCE_FETCH_MAX_BYTES, SOURCE_FETCH_TIMEOUT_MS } from '../shared/initiator-protocol';
import {
  decodeDataUrl,
  enclosingFunctionNames,
  excerptAround,
  findSourceMappingUrl,
  lineStartsOf,
  looksMinified,
  SourceMapConsumer,
} from '../lib/sourcemap';
import { errorMessage } from './util';

/** Total characters of cached scripts + map texts / sources kept. */
const CACHE_BUDGET_CHARS = 96 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;

export interface FetchedText {
  text: string;
  /** SourceMap / X-SourceMap response header. */
  mapHeader: string | null;
}

export interface SourceResolverDeps {
  /** GET `url` as text (≤ maxBytes, rejects on HTTP errors / timeout / over the cap). */
  fetchText(url: string, options: { credentials: RequestCredentials; maxBytes: number; timeoutMs: number }): Promise<FetchedText>;
  now(): number;
}

class TooLargeError extends Error {}

interface ScriptInfo {
  text: string;
  starts: Int32Array;
  mapUrl: string | null;
}

interface MapInfo {
  consumer: SourceMapConsumer;
  /** Line starts of sourcesContent entries, computed on demand. */
  starts: Map<number, Int32Array>;
}

type CacheValue = { ok: true; value: ScriptInfo | MapInfo; size: number } | { ok: false; error: Extract<ResolvedFrame, { ok: false }> };

interface CacheItem {
  value: Promise<CacheValue>;
  size: number;
  at: number;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function isFetchable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Fetches, caches and maps; one instance per worker. */
export class SourceResolver {
  private readonly cache = new Map<string, CacheItem>();
  private used = 0;

  constructor(private readonly deps: SourceResolverDeps) {}

  /** Resolve frames (at most RESOLVE_MAX_FRAMES; the rest come back as unsupported). */
  async resolve(frames: ResolveFrameRequest[], pageUrl: string): Promise<ResolvedFrame[]> {
    const pageOrigin = originOf(pageUrl);
    return Promise.all(
      frames.map((frame, i) =>
        i < RESOLVE_MAX_FRAMES ? this.resolveOne(frame, pageOrigin).catch((err: unknown) => failure('fetch-failed', errorMessage(err))) : failure('unsupported-url'),
      ),
    );
  }

  private async resolveOne(frame: ResolveFrameRequest, pageOrigin: string): Promise<ResolvedFrame> {
    if (!isFetchable(frame.url) || !(frame.line > 0)) return failure('unsupported-url');
    const script = await this.script(frame.url, pageOrigin);
    if (!script.ok) return script.error;
    const info = script.value as ScriptInfo;
    const line = frame.line - 1;
    const col = Math.max(0, frame.col - 1);
    const generatedContext = (): Pick<Extract<ResolvedFrame, { ok: false }>, 'minified' | 'enclosing' | 'excerpt'> => {
      const minified = looksMinified(info.text, line, info.starts);
      const out: Pick<Extract<ResolvedFrame, { ok: false }>, 'minified' | 'enclosing' | 'excerpt'> = {};
      if (minified) out.minified = true;
      const excerpt = excerptAround(info.text, line, col, 3, info.starts);
      if (excerpt) out.excerpt = excerpt;
      if (!minified) {
        const enclosing = enclosingFunctionNames(info.text, line, col, 6, info.starts);
        if (enclosing.length) out.enclosing = enclosing;
      }
      return out;
    };
    if (!info.mapUrl) return { ...failure('no-map'), ...generatedContext() };
    const map = await this.map(info.mapUrl, pageOrigin);
    if (!map.ok) return { ...map.error, ...generatedContext() };
    const mapInfo = map.value as MapInfo;
    let pos: ReturnType<SourceMapConsumer['originalPositionFor']>;
    try {
      pos = mapInfo.consumer.originalPositionFor(line, col);
    } catch (err) {
      return { ...failure('bad-map', errorMessage(err)), ...generatedContext() };
    }
    if (!pos) return { ...failure('no-mapping'), ...generatedContext() };
    const resolved: Extract<ResolvedFrame, { ok: true }> = { ok: true, source: pos.source, line: pos.line + 1, col: pos.column + 1 };
    if (pos.name) resolved.name = pos.name;
    if (pos.approximate) resolved.approximate = true;
    if (pos.content !== null) {
      let starts = mapInfo.starts.get(pos.sourceIndex);
      if (!starts) {
        starts = lineStartsOf(pos.content);
        mapInfo.starts.set(pos.sourceIndex, starts);
      }
      const excerpt = excerptAround(pos.content, pos.line, pos.column, 3, starts);
      if (excerpt) resolved.excerpt = excerpt;
      const enclosing = enclosingFunctionNames(pos.content, pos.line, pos.column, 6, starts);
      if (enclosing.length) resolved.enclosing = enclosing;
    }
    return resolved;
  }

  private script(url: string, pageOrigin: string): Promise<CacheValue> {
    const key = `s:${url.split('#')[0]}`;
    return this.cached(key, async () => {
      const fetched = await this.fetch(url, pageOrigin);
      const comment = findSourceMappingUrl(fetched.text);
      const ref = comment ?? fetched.mapHeader;
      let mapUrl: string | null = null;
      if (ref) {
        try {
          mapUrl = ref.startsWith('data:') ? ref : new URL(ref, url).href;
        } catch {
          mapUrl = null;
        }
      }
      const info: ScriptInfo = { text: fetched.text, starts: lineStartsOf(fetched.text), mapUrl };
      return { ok: true, value: info, size: fetched.text.length };
    });
  }

  private map(mapUrl: string, pageOrigin: string): Promise<CacheValue> {
    // Inline maps are keyed by their text (cached with the script that carries them).
    const key = mapUrl.startsWith('data:') ? `d:${mapUrl.length}:${mapUrl.slice(-64)}:${mapUrl.slice(0, 256)}` : `m:${mapUrl}`;
    return this.cached(key, async () => {
      let text: string | null;
      if (mapUrl.startsWith('data:')) {
        text = decodeDataUrl(mapUrl);
        if (text === null) return { ok: false, error: failure('bad-map', 'Unreadable inline source map') };
      } else {
        if (!isFetchable(mapUrl)) return { ok: false, error: failure('unsupported-url') };
        text = (await this.fetch(mapUrl, pageOrigin)).text;
      }
      let consumer: SourceMapConsumer;
      try {
        consumer = SourceMapConsumer.parse(text);
      } catch (err) {
        return { ok: false, error: failure('bad-map', errorMessage(err)) };
      }
      return { ok: true, value: { consumer, starts: new Map() }, size: text.length * 2 };
    });
  }

  private async fetch(url: string, pageOrigin: string): Promise<FetchedText> {
    const credentials: RequestCredentials = pageOrigin && originOf(url) === pageOrigin ? 'include' : 'omit';
    return this.deps.fetchText(url, { credentials, maxBytes: SOURCE_FETCH_MAX_BYTES, timeoutMs: SOURCE_FETCH_TIMEOUT_MS });
  }

  /** Cached by key (in-flight requests shared); failures are cached briefly too (by the same TTL). */
  private cached(key: string, load: () => Promise<CacheValue>): Promise<CacheValue> {
    const now = this.deps.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      // LRU: move to the end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value;
    }
    if (hit) this.drop(key);
    const item: CacheItem = { value: Promise.resolve({ ok: false, error: failure('fetch-failed') }), size: 0, at: now };
    item.value = load()
      .catch((err: unknown): CacheValue => ({
        ok: false,
        error: err instanceof TooLargeError ? failure('too-large', err.message) : failure('fetch-failed', errorMessage(err)),
      }))
      .then((value) => {
        if (value.ok && this.cache.get(key) === item) {
          item.size = value.size;
          this.used += value.size;
          this.evict(key);
        }
        return value;
      });
    this.cache.set(key, item);
    return item.value;
  }

  private drop(key: string): void {
    const item = this.cache.get(key);
    if (!item) return;
    this.used -= item.size;
    this.cache.delete(key);
  }

  private evict(keep: string): void {
    for (const key of [...this.cache.keys()]) {
      if (this.used <= CACHE_BUDGET_CHARS) return;
      if (key !== keep) this.drop(key);
    }
  }
}

function failure(reason: Extract<ResolvedFrame, { ok: false }>['reason'], detail?: string): Extract<ResolvedFrame, { ok: false }> {
  return detail ? { ok: false, reason, detail: detail.slice(0, 300) } : { ok: false, reason };
}

/** Production fetcher: GET with an abort timeout, streamed so the size cap holds without Content-Length. */
export async function fetchTextCapped(
  url: string,
  options: { credentials: RequestCredentials; maxBytes: number; timeoutMs: number },
): Promise<FetchedText> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch(url, { credentials: options.credentials, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > options.maxBytes) throw new TooLargeError(`${length} bytes`);
    const mapHeader = res.headers.get('sourcemap') ?? res.headers.get('x-sourcemap');
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), mapHeader };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TooLargeError(`over ${options.maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { text: new TextDecoder('utf-8').decode(bytes), mapHeader };
  } finally {
    clearTimeout(timer);
  }
}

/** Shape check of a RESOLVE_INITIATOR payload: frames with http(s)-ish URLs ≤ 64 KB and positive positions. */
export function sanitizeResolveFrames(value: unknown): ResolveFrameRequest[] | null {
  if (!Array.isArray(value) || value.length > RESOLVE_MAX_FRAMES * 2) return null;
  const out: ResolveFrameRequest[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { url, line, col } = item as Record<string, unknown>;
    if (typeof url !== 'string' || url.length > 64 * 1024) return null;
    if (typeof line !== 'number' || typeof col !== 'number' || !Number.isFinite(line) || !Number.isFinite(col)) return null;
    out.push({ url, line: Math.floor(line), col: Math.floor(col) });
  }
  return out;
}
