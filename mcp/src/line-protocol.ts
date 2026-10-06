// Newline-delimited JSON over the hub socket: one JSON object per line. The decoder splits on the newline
// byte (so multi-byte UTF-8 characters split across chunks are safe) and drops lines longer than the limit
// without losing sync.

/** The hub drops socket lines larger than this. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;

/** One line of NDJSON (JSON.stringify never emits a raw newline). */
export function encodeLine(message: unknown): string {
  const json = JSON.stringify(message);
  if (json === undefined) throw new TypeError('Line message is not JSON-serializable');
  return `${json}\n`;
}

export type LineError =
  | { kind: 'too-long'; bytes: number }
  | { kind: 'invalid-json'; bytes: number };

export interface LineDecoderOptions {
  maxLineBytes?: number;
  onMessage: (message: unknown) => void;
  onError?: (error: LineError) => void;
}

/** Incremental NDJSON decoder (feed it every `data` chunk in order; blank lines are ignored). */
export class LineDecoder {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** Inside an oversized line: discard until the next newline. */
  private discarding = false;
  private discarded = 0;

  constructor(private readonly options: LineDecoderOptions) {
    this.maxBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  /** Bytes of an unterminated line held in memory. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Buffer | string): void {
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const newline = data.indexOf(NEWLINE);
      if (newline < 0) {
        this.append(data);
        return;
      }
      this.append(data.subarray(0, newline));
      this.endLine();
      data = data.subarray(newline + 1);
    }
  }

  private append(data: Buffer): void {
    if (data.length === 0) return;
    if (this.discarding) {
      this.discarded += data.length;
      return;
    }
    if (this.buffered + data.length > this.maxBytes) {
      this.discarding = true;
      this.discarded = this.buffered + data.length;
      this.chunks = [];
      this.buffered = 0;
      return;
    }
    this.chunks.push(data);
    this.buffered += data.length;
  }

  private endLine(): void {
    if (this.discarding) {
      this.options.onError?.({ kind: 'too-long', bytes: this.discarded });
      this.discarding = false;
      this.discarded = 0;
      return;
    }
    const line = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    const text = line.toString('utf8').trim();
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.options.onError?.({ kind: 'invalid-json', bytes: line.length });
      return;
    }
    this.options.onMessage(message);
  }
}
