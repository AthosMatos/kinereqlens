// Chromium native messaging framing: every message is a 4-byte little-endian length followed by that many
// bytes of UTF-8 JSON. The decoder is incremental (a frame may arrive split across any number of chunks, and
// one chunk may hold several frames) and survives oversized or malformed frames without losing sync.

/** Chromium caps extension → host messages at 64 MiB. */
export const NM_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 4;

/**
 * Encode one message as a native messaging frame. Throws when the JSON is larger than `maxBytes`
 * (host → extension messages must stay under Chromium's 1 MiB limit: pass NATIVE_MAX_INBOUND_BYTES).
 */
export function encodeNativeMessage(message: unknown, maxBytes = NM_MAX_MESSAGE_BYTES): Buffer {
  const json = JSON.stringify(message);
  if (json === undefined) throw new TypeError('Native message is not JSON-serializable');
  const body = Buffer.from(json, 'utf8');
  if (body.length > maxBytes) throw new RangeError(`Native message too large (${body.length} bytes > ${maxBytes})`);
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

export type FrameError =
  | { kind: 'too-large'; bytes: number }
  | { kind: 'invalid-json'; bytes: number };

export interface NativeMessageDecoderOptions {
  /** Frames whose declared length exceeds this are skipped (reported through `onError`). */
  maxMessageBytes?: number;
  onMessage: (message: unknown) => void;
  onError?: (error: FrameError) => void;
}

/** Incremental decoder for a native messaging byte stream (feed it every `data` chunk in order). */
export class NativeMessageDecoder {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** Bytes of an oversized frame still to be discarded. */
  private skipping = 0;

  constructor(private readonly options: NativeMessageDecoderOptions) {
    this.maxBytes = options.maxMessageBytes ?? NM_MAX_MESSAGE_BYTES;
  }

  /** Bytes received but not yet consumed (a partial header or body). */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Buffer): void {
    let data = chunk;
    if (this.skipping > 0) {
      const skip = Math.min(this.skipping, data.length);
      this.skipping -= skip;
      data = data.subarray(skip);
    }
    if (data.length === 0) return;
    this.chunks.push(data);
    this.buffered += data.length;
    this.drain();
  }

  private drain(): void {
    while (this.skipping === 0 && this.buffered >= HEADER_BYTES) {
      const length = this.peekLength();
      if (length > this.maxBytes) {
        this.consume(HEADER_BYTES);
        const skip = Math.min(length, this.buffered);
        this.consume(skip);
        this.skipping = length - skip;
        this.options.onError?.({ kind: 'too-large', bytes: length });
        continue;
      }
      if (this.buffered < HEADER_BYTES + length) return;
      this.consume(HEADER_BYTES);
      const body = this.consume(length);
      let message: unknown;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        this.options.onError?.({ kind: 'invalid-json', bytes: length });
        continue;
      }
      this.options.onMessage(message);
    }
  }

  private peekLength(): number {
    const head = this.chunks[0];
    if (head && head.length >= HEADER_BYTES) return head.readUInt32LE(0);
    return this.flatten().readUInt32LE(0);
  }

  /** Merge the buffered chunks into one (only needed when a header or body straddles chunks). */
  private flatten(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(bytes: number): Buffer {
    if (bytes === 0) return Buffer.alloc(0);
    const head = this.chunks[0];
    const source = head && head.length >= bytes ? head : this.flatten();
    const out = source.subarray(0, bytes);
    const rest = source.subarray(bytes);
    if (rest.length > 0) this.chunks[0] = rest;
    else this.chunks.shift();
    this.buffered -= bytes;
    return out;
  }
}
