/**
 * Runtime shared by the hooks: config, id generation, ordered emission (a capture's `start` always goes out
 * before its `end`), and the fetch-over-XHR context used for deduplication.
 */
import type { BodyProducer } from './body';
import { unavailable } from './body';
import type { FilterConfig } from './filter';
import { isIgnoredUrl } from './filter';
import type { ClientMessage, RnRequestEnd, RnRequestStart, SerializedBody } from './protocol';

export interface RuntimeConfig {
  captureBodies: boolean;
  requestBodyCap: number;
  responseBodyCap: number;
  wsFrameCap: number;
  filter: FilterConfig;
}

export interface Runtime {
  /** Wrappers installed by another start() generation pass through. */
  readonly gen: number;
  readonly session: string;
  readonly config: RuntimeConfig;
  send(message: ClientMessage, key: string | null): void;
  nextId(prefix?: string): string;
}

let current: Runtime | null = null;

export function setRuntime(runtime: Runtime | null): void {
  current = runtime;
}

/** The active runtime when it belongs to wrapper generation `gen`, else null (pass through). */
export function activeRuntime(gen: number): Runtime | null {
  return current && current.gen === gen ? current : null;
}

export function getRuntime(): Runtime | null {
  return current;
}

export function isIgnored(runtime: Runtime, url: string): boolean {
  return isIgnoredUrl(url, runtime.config.filter);
}

// ---------------------------------------------------------------------------------------------
// fetch-over-XHR dedupe
// ---------------------------------------------------------------------------------------------

/**
 * Set by the fetch wrapper (and by replays) for the synchronous duration of the original fetch call. React
 * Native's fetch (whatwg-fetch) creates, opens and sends its XMLHttpRequest synchronously inside that call,
 * so an XHR opened while a context is set belongs to that fetch.
 */
export interface FetchContext {
  claimed: boolean;
  /** Replays: the XHR must not be captured at all. */
  suppress: boolean;
  options: NonNullable<RnRequestStart['options']>;
}

let fetchContext: FetchContext | null = null;

export function swapFetchContext(next: FetchContext | null): FetchContext | null {
  const previous = fetchContext;
  fetchContext = next;
  return previous;
}

/** Called by the XHR hook from open(): claims the pending fetch, if any. */
export function claimFetchContext(): FetchContext | null {
  const ctx = fetchContext;
  if (!ctx || ctx.claimed) return null;
  ctx.claimed = true;
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------------------------

export interface Capture {
  id: string;
  runtime: Runtime;
  /** Resolves once `start` was sent. */
  started: Promise<void>;
  markStarted: () => void;
  ended: boolean;
}

export function beginCapture(runtime: Runtime): Capture {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { id: runtime.nextId(), runtime, started, markStarted, ended: false };
}

function settle<T>(value: T | Promise<T>, onValue: (value: T) => void, onError: () => void): void {
  if (value && typeof (value as Promise<T>).then === 'function') {
    (value as Promise<T>).then(onValue, onError);
  } else onValue(value as T);
}

/** Produce the request body (maybe async), then send `start`. */
export function scheduleStart(capture: Capture, producer: BodyProducer, build: (body: SerializedBody | null) => RnRequestStart): void {
  const emit = (body: SerializedBody | null): void => {
    try {
      capture.runtime.send({ t: 'start', data: build(body) }, capture.id);
    } catch {
      /* ignore */
    }
    capture.markStarted();
  };
  let produced: SerializedBody | null | Promise<SerializedBody | null>;
  try {
    produced = producer();
  } catch {
    produced = unavailable('The request body could not be read');
  }
  settle(produced, emit, () => emit(unavailable('The request body could not be read')));
}

/** Send `end` after `start` (once). */
export function emitEnd(capture: Capture, end: RnRequestEnd): void {
  if (capture.ended) return;
  capture.ended = true;
  capture.started.then(
    () => {
      try {
        capture.runtime.send({ t: 'end', data: end }, capture.id);
      } catch {
        /* ignore */
      }
    },
    () => undefined,
  );
}

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    const name = (error as { name?: unknown }).name;
    const message = (error as { message: string }).message;
    return typeof name === 'string' && name && name !== 'Error' ? `${name}: ${message}` : message;
  }
  return String(error);
}

export function errorName(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : '';
}

export function stripHash(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}
