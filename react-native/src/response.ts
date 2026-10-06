/** Read a fetch Response body (whatwg-fetch over XHR in React Native, or a native streaming fetch), capped. */
import { isBlobLike, readBlobBytes } from './body';
import { utf8Encode } from './encoding';

export interface ReadResult {
  bytes: Uint8Array;
  total: number;
  truncated: boolean;
  error?: unknown;
}

interface ResponseLike {
  body?: unknown;
  blob?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

function hasFileReader(): boolean {
  return typeof (globalThis as { FileReader?: unknown }).FileReader === 'function';
}

async function readStream(reader: ReaderLike, cap: number, timeoutMs: number): Promise<ReadResult> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === 'timeout') {
        truncated = true;
        break;
      }
      if (next.done) break;
      const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(0);
      total += value.length;
      if (kept < cap) {
        const room = cap - kept;
        const slice = value.length > room ? value.subarray(0, room) : value;
        chunks.push(slice);
        kept += slice.length;
      }
      if (total > cap) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    return { ...concat(chunks, kept), total, truncated: true, error };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (truncated) reader.cancel().catch(() => undefined);
  return { ...concat(chunks, kept), total, truncated };
}

function concat(chunks: Uint8Array[], length: number): { bytes: Uint8Array } {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes };
}

/**
 * Body bytes of `response` (consumes it: pass a clone when the app still needs it). React Native's
 * whatwg-fetch keeps the body as a Blob, read through FileReader; native fetch streams are read up to `cap`.
 */
export async function readResponseBytes(response: unknown, cap: number, timeoutMs = 30_000): Promise<ReadResult> {
  const res = response as ResponseLike;
  const stream = res.body as { getReader?: () => ReaderLike } | null | undefined;
  if (stream && typeof stream.getReader === 'function') return readStream(stream.getReader(), cap, timeoutMs);
  if (typeof res.blob === 'function' && hasFileReader()) {
    const blob = await res.blob();
    if (isBlobLike(blob)) {
      const { bytes, total } = await readBlobBytes(blob, cap);
      return { bytes, total, truncated: total > cap };
    }
  }
  if (typeof res.arrayBuffer === 'function') {
    const buffer = new Uint8Array(await res.arrayBuffer());
    return { bytes: buffer.length > cap ? buffer.slice(0, cap) : buffer, total: buffer.length, truncated: buffer.length > cap };
  }
  if (typeof res.text === 'function') {
    const buffer = utf8Encode(await res.text());
    return { bytes: buffer.length > cap ? buffer.slice(0, cap) : buffer, total: buffer.length, truncated: buffer.length > cap };
  }
  return { bytes: new Uint8Array(0), total: 0, truncated: false };
}
