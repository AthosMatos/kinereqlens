// Initiator tab state (panel): the analysis of an entry's recorded call stack, resolved through the worker's
// source-map service (RESOLVE_INITIATOR), cached per entry + stack while the panel lives, and the page-side
// component lookup (bridge.locateComponents).
import { useEffect, useState } from 'preact/hooks';
import type { ComponentLocateResult, ComponentQuery, ResolvedFrame, ResolveFrameRequest, ResolveInitiatorResponse } from '../../shared/initiator-protocol';
import { RESOLVE_MAX_FRAMES } from '../../shared/initiator-protocol';
import type { ReqlensBridge, RequestEntry } from '../../shared/types';
import type { InitiatorAnalysis } from '../../lib/initiator';
import { analyzeInitiator } from '../../lib/initiator';
import { parseStack } from '../../lib/stack';

export type ResolveFn = (frames: ResolveFrameRequest[], pageUrl: string) => Promise<ResolveInitiatorResponse>;

/** The worker's source-map service (the panel page is an extension page: it may message the worker). */
const workerResolve: ResolveFn = async (frames, pageUrl) => {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'RESOLVE_INITIATOR', frames, pageUrl })) as ResolveInitiatorResponse | undefined;
    return answer && typeof answer === 'object' ? answer : { ok: false, error: 'No answer from the extension' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

let resolver: ResolveFn = workerResolve;

/** Replace the resolver (tests). Returns the previous one. */
export function setInitiatorResolver(fn: ResolveFn): ResolveFn {
  const previous = resolver;
  resolver = fn;
  cache.clear();
  return previous;
}

export interface InitiatorState {
  /** none: no stack recorded; resolving: unresolved analysis shown meanwhile; done. */
  status: 'none' | 'resolving' | 'done';
  analysis: InitiatorAnalysis | null;
  /** Source-map resolution failed as a whole (the analysis then uses the bundle positions). */
  error?: string;
}

interface CacheEntry {
  stack: string;
  promise: Promise<{ resolved: Array<ResolvedFrame | null>; error?: string }>;
}

const CACHE_MAX = 60;
const cache = new Map<string, CacheEntry>();

/** The recorded stack of an entry ('' when none). */
export function stackOf(entry: RequestEntry): string {
  return typeof entry.initiatorStack === 'string' ? entry.initiatorStack : '';
}

/** Resolve every resolvable frame of `stack` (http(s) URLs with a line); others stay null. */
export function resolveStack(stack: string, pageUrl: string, resolve: ResolveFn = resolver): Promise<{ resolved: Array<ResolvedFrame | null>; error?: string }> {
  const frames = parseStack(stack);
  const requests: ResolveFrameRequest[] = [];
  const index: number[] = [];
  frames.forEach((f, i) => {
    if (requests.length < RESOLVE_MAX_FRAMES && /^https?:\/\//i.test(f.url) && f.line > 0) {
      requests.push({ url: f.url, line: f.line, col: f.col });
      index.push(i);
    }
  });
  const resolved: Array<ResolvedFrame | null> = frames.map(() => null);
  if (requests.length === 0) return Promise.resolve({ resolved });
  return resolve(requests, pageUrl).then((answer) => {
    if (!answer.ok) return { resolved, error: answer.error };
    answer.frames.forEach((r, k) => {
      const at = index[k];
      if (at !== undefined && r && typeof r === 'object') resolved[at] = r;
    });
    return { resolved };
  });
}

function cachedResolve(entry: RequestEntry, stack: string): CacheEntry['promise'] {
  const hit = cache.get(entry.id);
  if (hit && hit.stack === stack) return hit.promise;
  const promise = resolveStack(stack, entry.pageUrl || entry.frameUrl || '').catch((err: unknown) => ({
    resolved: [] as Array<ResolvedFrame | null>,
    error: err instanceof Error ? err.message : String(err),
  }));
  cache.set(entry.id, { stack, promise });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return promise;
}

/** Analysis of the entry's stack: the bundle-level one at once, the source-mapped one when resolved. */
export function useInitiator(entry: RequestEntry): InitiatorState {
  const stack = stackOf(entry);
  const [state, setState] = useState<InitiatorState>(() =>
    stack ? { status: 'resolving', analysis: analyzeInitiator(stack) } : { status: 'none', analysis: null },
  );
  useEffect(() => {
    if (!stack) {
      setState({ status: 'none', analysis: null });
      return;
    }
    let live = true;
    setState((s) => (s.status === 'done' && s.analysis ? s : { status: 'resolving', analysis: analyzeInitiator(stack) }));
    void cachedResolve(entry, stack).then(({ resolved, error }) => {
      if (!live) return;
      const next: InitiatorState = { status: 'done', analysis: analyzeInitiator(stack, resolved) };
      if (error) next.error = error;
      setState(next);
    });
    return () => {
      live = false;
    };
    // The analysis depends on the entry id and its stack only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, stack]);
  return state;
}

/** The bridge's optional page-side component calls (the overlay panel's RemoteBridge has them). */
export interface ComponentBridge {
  locateComponents?(query: ComponentQuery): Promise<ComponentLocateResult>;
  clearHighlight?(): void;
}

export function componentBridgeOf(bridge: ReqlensBridge): ComponentBridge {
  return bridge as ReqlensBridge & ComponentBridge;
}

export interface LocateState {
  status: 'idle' | 'unavailable' | 'locating' | 'done';
  result?: ComponentLocateResult;
}

/** Look the component names up on the page (count + path) whenever they change. Top-frame requests only. */
export function useComponentLocate(bridge: ReqlensBridge, names: readonly string[], enabled: boolean): [LocateState, (r: ComponentLocateResult) => void] {
  const key = names.join('\n');
  const [state, setState] = useState<LocateState>({ status: 'idle' });
  useEffect(() => {
    const cb = componentBridgeOf(bridge);
    if (!enabled || names.length === 0) {
      setState({ status: 'idle' });
      return;
    }
    if (!cb.locateComponents) {
      setState({ status: 'unavailable' });
      return;
    }
    let live = true;
    setState({ status: 'locating' });
    void cb.locateComponents({ names: [...names], scroll: false, highlight: false }).then((result) => {
      if (live) setState({ status: 'done', result });
    });
    return () => {
      live = false;
    };
    // `key` stands for `names`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key, enabled]);
  return [state, (result) => setState({ status: 'done', result })];
}

/** The source-mapped analysis of an entry's stack (cached like the Initiator tab), or null without a stack. */
export async function initiatorAnalysisOf(entry: RequestEntry): Promise<InitiatorAnalysis | null> {
  const stack = stackOf(entry);
  if (!stack) return null;
  const { resolved } = await cachedResolve(entry, stack);
  return analyzeInitiator(stack, resolved);
}
