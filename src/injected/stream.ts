/** Capped reading of a ReadableStream branch that belongs to kineReqLens (a clone/tee, never the page's). */
import {
  arrayBufferIsView,
  call,
  clearTimer,
  mathMin,
  NativePromise,
  NativeUint8Array,
  now,
  onSettled,
  readerCancel,
  readerRead,
  setTimer,
  streamGetReader,
} from './natives';

/** Outcome of `readStreamCapped`. */
export interface StreamReadResult {
  /** At most `cap` bytes. */
  bytes: Uint8Array;
  /** Bytes read from the stream (may exceed `cap` by up to one chunk). */
  total: number;
  /** The stream had more data than was kept (cap, deadline or early stop). */
  truncated: boolean;
  /** Read error (e.g. AbortError when the request was aborted mid-body). */
  error?: unknown;
}

/** Early-stop controls of `readStreamCapped`. */
export interface StreamReadOptions {
  /** Checked after every chunk; true cancels our branch. */
  shouldStop?: () => boolean;
  /** Give up (and cancel our branch) after this many ms. */
  timeoutMs?: number;
  /**
   * Receives a function that ends the read early: kineReqLens' branch is cancelled and the read resolves with
   * what it has (truncated). Called once the reader exists.
   */
  control?: (stop: () => void) => void;
}

const TIMED_OUT = Symbol('timeout');
type ReadOutcome = ReadableStreamReadResult<unknown> | typeof TIMED_OUT;

function readWithin(reader: ReadableStreamDefaultReader<unknown>, ms: number): Promise<ReadOutcome> {
  const pending = call<Promise<ReadableStreamReadResult<unknown>>>(readerRead, reader);
  if (!(ms < Infinity)) return pending;
  return new NativePromise<ReadOutcome>((resolve, reject) => {
    const timer = setTimer(() => resolve(TIMED_OUT), ms);
    onSettled(
      pending,
      (result) => {
        clearTimer(timer);
        resolve(result);
      },
      (error) => {
        clearTimer(timer);
        reject(error);
      },
    );
  });
}

function cancel(reader: ReadableStreamDefaultReader<unknown>): void {
  try {
    // Cancels only this branch of the tee; the page's branch keeps flowing.
    onSettled(call<Promise<void>>(readerCancel, reader), () => undefined, () => undefined);
  } catch {
    /* already released */
  }
}

function toBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof NativeUint8Array) return chunk;
  if (arrayBufferIsView(chunk)) return new NativeUint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].length === length) return chunks[0];
  const out = new NativeUint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Read up to `cap` bytes, then cancel our branch. Never rejects. */
export async function readStreamCapped(
  stream: ReadableStream<unknown>,
  cap: number,
  options: StreamReadOptions = {},
): Promise<StreamReadResult> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  let error: unknown;
  const deadline = options.timeoutMs === undefined ? Infinity : now() + options.timeoutMs;
  let reader: ReadableStreamDefaultReader<unknown> | null = null;
  let stopped = false;
  try {
    reader = call<ReadableStreamDefaultReader<unknown>>(streamGetReader, stream);
    const own = reader;
    options.control?.(() => {
      if (stopped || reader !== own) return;
      stopped = true;
      // Resolves the pending read with done: true.
      cancel(own);
    });
    for (;;) {
      const outcome = await readWithin(reader, deadline - now());
      if (outcome === TIMED_OUT) {
        truncated = true;
        break;
      }
      if (outcome.done) {
        reader = null;
        break;
      }
      const chunk = toBytes(outcome.value);
      if (!chunk) {
        truncated = true;
        break;
      }
      total += chunk.length;
      if (kept < cap) {
        const take = mathMin(chunk.length, cap - kept);
        chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        kept += take;
      }
      if (total > cap || options.shouldStop?.()) {
        truncated = true;
        break;
      }
    }
  } catch (caught) {
    error = caught;
    reader = null;
  }
  if (stopped) {
    truncated = true;
    error = undefined;
  } else if (reader) cancel(reader);
  return { bytes: concat(chunks, kept), total, truncated, error };
}
