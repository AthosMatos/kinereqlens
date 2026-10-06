/**
 * kineReqLens reads its own clone of every captured fetch response. `Response.clone()` tees the body, and a tee
 * only cancels the network stream once *both* branches are cancelled: when the page cancels its branch
 * (`reader.cancel()`, `body.cancel()`), the connection would stay open — still downloading — until kineReqLens'
 * read reaches its cap or window. For long-lived streams (NDJSON, watch endpoints, long-polls) on HTTP/1.1
 * that exhausts the per-host connection pool.
 *
 * So the cancel methods are wrapped (natives first, same receiver and arguments, same promise returned):
 * when the page cancels the branch of a response kineReqLens is reading, kineReqLens cancels its branch too.
 * Cancels that propagate internally (pipeTo / pipeThrough, async iteration `break`) are not visible here;
 * the read window of unbounded responses covers those (fetchHook.ts).
 */
import { replaceMethod } from './disguise';
import {
  call,
  NativeByobReader,
  NativeDefaultReader,
  NativeReadableStream,
  NativeWeakMap,
  streamCancel,
  streamGetReader,
  streamLocked,
  weakMapDelete,
  weakMapGet,
  weakMapSet,
} from './natives';

/** Page-side branch of a response kineReqLens reads → stop kineReqLens' read. */
const followers = new NativeWeakMap<object, () => void>();
/** Reader obtained from such a branch → the branch. */
const readerStreams = new NativeWeakMap<object, object>();
/** Branch → its latest reader (an older, released reader cancelling does nothing to the stream). */
const currentReaders = new NativeWeakMap<object, object>();

/** Stop kineReqLens' read of a response when the page cancels `pageStream` (its branch of the body). */
export function followPageCancel(pageStream: object, stop: () => void): void {
  call(weakMapSet, followers, [pageStream, stop]);
}

function isLocked(stream: object): boolean {
  try {
    return streamLocked ? call<boolean>(streamLocked, stream) : false;
  } catch {
    return false;
  }
}

function fire(stream: object): void {
  const stop = call<(() => void) | undefined>(weakMapGet, followers, [stream]);
  if (!stop) return;
  call(weakMapDelete, followers, [stream]);
  stop();
}

function wrapReaderCancel(proto: { cancel: (reason?: unknown) => Promise<void> }): void {
  const original = proto.cancel;
  const cancel = {
    cancel(this: object): Promise<void> {
      // `arguments` is forwarded as-is (the reason).
      const result = call<Promise<void>>(original, this, arguments);
      try {
        const stream = call<object | undefined>(weakMapGet, readerStreams, [this]);
        // Only the reader that holds the lock cancels the stream (a released reader's cancel rejects).
        if (stream && call<object | undefined>(weakMapGet, currentReaders, [stream]) === this && isLocked(stream)) fire(stream);
      } catch {
        /* capture is best effort */
      }
      return result;
    },
  }.cancel;
  replaceMethod(proto, 'cancel', original, cancel);
}

/** Wrap ReadableStream.prototype.getReader / cancel and the readers' cancel. */
export function installCancelFollow(): void {
  const proto = NativeReadableStream.prototype;
  const nativeGetReader = streamGetReader;
  const nativeCancel = streamCancel;

  const getReader = {
    getReader(this: object): ReadableStreamDefaultReader | ReadableStreamBYOBReader {
      const reader = call<ReadableStreamDefaultReader | ReadableStreamBYOBReader>(nativeGetReader, this, arguments);
      try {
        if (call<(() => void) | undefined>(weakMapGet, followers, [this])) {
          call(weakMapSet, readerStreams, [reader, this]);
          call(weakMapSet, currentReaders, [this, reader]);
        }
      } catch {
        /* best effort */
      }
      return reader;
    },
  }.getReader;

  const cancel = {
    cancel(this: object): Promise<void> {
      // A locked stream's cancel() rejects without cancelling anything.
      let follow = false;
      try {
        follow = !isLocked(this);
      } catch {
        follow = false;
      }
      const result = call<Promise<void>>(nativeCancel, this, arguments);
      if (follow) {
        try {
          fire(this);
        } catch {
          /* best effort */
        }
      }
      return result;
    },
  }.cancel;

  replaceMethod(proto, 'getReader', nativeGetReader, getReader);
  replaceMethod(proto, 'cancel', nativeCancel, cancel);
  wrapReaderCancel(NativeDefaultReader.prototype as unknown as { cancel: (reason?: unknown) => Promise<void> });
  if (NativeByobReader) wrapReaderCancel(NativeByobReader.prototype as unknown as { cancel: (reason?: unknown) => Promise<void> });
}
