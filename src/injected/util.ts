/** Small helpers shared by the fetch / XHR / sendBeacon wrappers. */
import type { HeaderPair, SerializedBody } from '../shared/types';
import type { Capture } from './channel';
import { emitStart } from './channel';
import type { BodyProducer } from './serialize';
import { unavailable } from './serialize';
import {
  call,
  headersForEach,
  isArray,
  mapForEach,
  NativeHeaders,
  NativeMap,
  NativeURL,
  objectKeys,
  onSettled,
  tagOf,
  toPromise,
} from './natives';
import type { HookRequestStart } from '../shared/types';

const NORMALIZED_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];

/** fetch/XHR method normalization: only the six standard methods are upper-cased. */
export function normalizeMethod(method: string): string {
  if (!/^[A-Za-z]+$/.test(method)) return method;
  const upper = method.toUpperCase();
  return NORMALIZED_METHODS.includes(upper) ? upper : method;
}

/** Resolve like fetch/XHR do (against the document base URL); the raw text when it does not parse. */
export function resolveRequestUrl(input: unknown): string {
  const raw = typeof input === 'string' ? input : String(input);
  try {
    return new NativeURL(raw, document.baseURI).href;
  } catch {
    try {
      return new NativeURL(raw, location.href).href;
    } catch {
      return raw;
    }
  }
}

/** This frame's URL ('' when unavailable). */
export function currentFrameUrl(): string {
  try {
    return location.href;
  } catch {
    return '';
  }
}

/** Iterate a Headers instance with the native forEach (names lower-cased, values combined). */
export function headersToPairs(headers: unknown): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  try {
    call(headersForEach, headers, [
      (value: string, name: string) => {
        pairs.push({ name, value });
      },
    ]);
  } catch {
    /* not a Headers object */
  }
  return pairs;
}

/**
 * HeadersInit as written by the page (keeps the page's casing for records and arrays). One-shot iterables
 * (generators, custom iterators) are not read: consuming them would change what the native call receives.
 */
export function headersInitToPairs(init: unknown): HeaderPair[] {
  if (init === null || init === undefined || (typeof init !== 'object' && typeof init !== 'function')) return [];
  if (init instanceof NativeHeaders || tagOf(init) === '[object Headers]') return headersToPairs(init);
  const pairs: HeaderPair[] = [];
  if (isArray(init)) {
    for (let index = 0; index < init.length; index++) {
      const pair: unknown = init[index];
      if (isArray(pair) && pair.length >= 2) pairs.push({ name: String(pair[0]), value: String(pair[1]) });
    }
    return pairs;
  }
  if (init instanceof NativeMap) {
    call(mapForEach, init, [(value: unknown, name: unknown) => pairs.push({ name: String(name), value: String(value) })]);
    return pairs;
  }
  const record = init as Record<string | symbol, unknown>;
  if (typeof record[Symbol.iterator] === 'function') return pairs;
  for (const name of objectKeys(record)) pairs.push({ name, value: String(record[name]) });
  return pairs;
}

/** First value of a header (case-insensitive), or null. */
export function findHeader(headers: HeaderPair[], name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of headers) if (header.name.toLowerCase() === wanted) return header.value;
  return null;
}

/**
 * Serialize the body snapshot after the native call has been dispatched (always at least one microtask
 * later, so a synchronous native throw can still drop the capture) and emit 'start'.
 */
export function scheduleStart(
  capture: Capture,
  produce: BodyProducer,
  build: (body: SerializedBody | null) => HookRequestStart,
): void {
  const emit = (body: SerializedBody | null): void => emitStart(capture, build(body));
  onSettled(
    toPromise(undefined),
    () => {
      let produced: SerializedBody | null | Promise<SerializedBody | null>;
      try {
        produced = produce();
      } catch {
        emit(unavailable('The body could not be read'));
        return;
      }
      onSettled(toPromise(produced), emit, () => emit(unavailable('The body could not be read')));
    },
    () => undefined,
  );
}
