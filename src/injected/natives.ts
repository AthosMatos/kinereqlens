/**
 * Native references captured when hook.js is evaluated. The manifest runs hook.js at document_start, before
 * any page script, so later page patches of these globals can neither observe nor break kineReqLens. (On a late
 * injection into an already running page we capture whatever is installed at that moment.)
 *
 * Every method is invoked through the captured `Reflect.apply`, never through `fn.call` / `fn.apply`.
 */

const reflectApply = Reflect.apply;

/** `fn.apply(self, args)` through the captured Reflect.apply (immune to Function.prototype patches). */
export function call<R = unknown>(fn: Function, self: unknown, args: ArrayLike<unknown> = []): R {
  return reflectApply(fn, self, args) as R;
}

export const W = window;
export const defineProperty = Object.defineProperty;
export const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
export const objectKeys = Object.keys;
export const isArray = Array.isArray;
export const dateNow = Date.now;
export const jsonStringify = JSON.stringify;
export const mathMin = Math.min;
export const fnToString = Function.prototype.toString;
const objectToString = Object.prototype.toString;

export const NativePromise = Promise;
const promiseThen = Promise.prototype.then;
const promiseResolve = Promise.resolve;

export const NativeWeakMap = WeakMap;
export const weakMapGet = WeakMap.prototype.get;
export const weakMapSet = WeakMap.prototype.set;
export const weakMapDelete = WeakMap.prototype.delete;
export const NativeMap = Map;
export const mapForEach = Map.prototype.forEach;
export const mapGet = Map.prototype.get;
export const mapSet = Map.prototype.set;
export const mapDelete = Map.prototype.delete;
export const NativeSet = Set;
export const setHas = Set.prototype.has;
export const setAdd = Set.prototype.add;

export const NativeUint8Array = Uint8Array;
export const arrayBufferIsView = ArrayBuffer.isView;

export const NativeURL = URL;
export const NativeURLSearchParams = URLSearchParams;
export const urlSearchParamsToString = URLSearchParams.prototype.toString;
export const NativeHeaders = Headers;
export const headersForEach = Headers.prototype.forEach;
export const headersAppend = Headers.prototype.append;
export const NativeRequest = Request;
export const requestClone = Request.prototype.clone;
export const responseClone = Response.prototype.clone;
export const NativeAbortController = AbortController;
export const abortControllerAbort = AbortController.prototype.abort;
export const NativeFormData = FormData;
export const formDataEntries = FormData.prototype.entries;
export const NativeBlob = Blob;
export const blobSlice = Blob.prototype.slice;
export const blobArrayBuffer = Blob.prototype.arrayBuffer;
export const NativeReadableStream = ReadableStream;
export const streamGetReader = ReadableStream.prototype.getReader;
export const streamCancel = ReadableStream.prototype.cancel;
export const streamLocked = getOwnPropertyDescriptor(ReadableStream.prototype, 'locked')?.get;
export const NativeDefaultReader = ReadableStreamDefaultReader;
export const readerRead = ReadableStreamDefaultReader.prototype.read;
export const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
export const NativeByobReader: typeof ReadableStreamBYOBReader | undefined =
  typeof ReadableStreamBYOBReader === 'function' ? ReadableStreamBYOBReader : undefined;
export const responseBody = getOwnPropertyDescriptor(Response.prototype, 'body')?.get;
export const NativeTextDecoder = TextDecoder;
export const textDecoderDecode = TextDecoder.prototype.decode;
export const NativeXMLSerializer = XMLSerializer;
export const xmlSerializeToString = XMLSerializer.prototype.serializeToString;
export const NativeDocument = Document;

export const addEventListenerFn = EventTarget.prototype.addEventListener;
export const stopImmediatePropagationFn = Event.prototype.stopImmediatePropagation;
export const portPostMessage = MessagePort.prototype.postMessage;
export const portStart = MessagePort.prototype.start;
const windowPostMessage = W.postMessage;
const setTimeoutFn = W.setTimeout;
const clearTimeoutFn = W.clearTimeout;

export const nativeFetch: typeof fetch | undefined = typeof W.fetch === 'function' ? W.fetch : undefined;
export const NativeXHR: typeof XMLHttpRequest | undefined =
  typeof W.XMLHttpRequest === 'function' ? W.XMLHttpRequest : undefined;

/**
 * Random tag taken once at install (document_start, before page scripts). Capture ids never read a
 * page-replaceable global such as Math.random at call time, so seeded page RNGs are not disturbed.
 */
export const INSTALL_TAG: string = (() => {
  try {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    return values[0]!.toString(36) + values[1]!.toString(36);
  } catch {
    return Date.now().toString(36);
  }
})();

/** Epoch milliseconds. */
export function now(): number {
  return call<number>(dateNow, Date);
}

/** Native setTimeout on the window. */
export function setTimer(fn: () => void, ms: number): number {
  return call<number>(setTimeoutFn, W, [fn, ms]);
}

/** Native clearTimeout on the window. */
export function clearTimer(id: number): void {
  call(clearTimeoutFn, W, [id]);
}

/** Native window.postMessage(message, "*"). */
export function postToWindow(message: unknown): void {
  call(windowPostMessage, W, [message, '*']);
}

/** `Object.prototype.toString` brand tag, e.g. "[object Blob]" (also works for cross-realm objects). */
export function tagOf(value: unknown): string {
  return call<string>(objectToString, value);
}

/** Objects and functions (anything that can carry properties). */
export function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Promise.resolve through the captured intrinsic. */
export function toPromise<T>(value: T | PromiseLike<T>): Promise<T> {
  return call<Promise<T>>(promiseResolve, NativePromise, [value]);
}

/** Attach handlers with the captured Promise.prototype.then (the returned promise is never left rejected). */
export function onSettled<T>(promise: PromiseLike<T>, onValue: (value: T) => void, onError: (error: unknown) => void): void {
  call(promiseThen, promise, [
    (value: T) => {
      try {
        onValue(value);
      } catch {
        /* never surface kineReqLens errors to the page */
      }
    },
    (error: unknown) => {
      try {
        onError(error);
      } catch {
        /* idem */
      }
    },
  ]);
}

/** Native EventTarget.prototype.addEventListener. */
export function addListener(target: EventTarget, type: string, fn: (event: Event) => void, capture = false): void {
  call(addEventListenerFn, target, [type, fn, capture]);
}

/** Best-effort "Name: message" text for any thrown / rejected value. */
export function errorText(error: unknown): string {
  try {
    if (isObjectLike(error)) {
      const name = typeof error.name === 'string' ? error.name : '';
      const message = typeof error.message === 'string' ? error.message : '';
      if (name || message) return name && message ? `${name}: ${message}` : name || message;
    }
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

/** `error.name` when it is a string (e.g. 'AbortError'), else ''. */
export function errorName(error: unknown): string {
  try {
    return isObjectLike(error) && typeof error.name === 'string' ? error.name : '';
  } catch {
    return '';
  }
}
