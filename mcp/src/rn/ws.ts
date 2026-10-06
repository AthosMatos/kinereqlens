// Minimal RFC 6455 server side for the React Native receiver (no dependencies): the upgrade answer (§4.2), frame
// encoding (unmasked server frames) and an incremental decoder of masked client frames (§5) with fragment
// reassembly and size limits. Ported from react-native/test/receiver.ts, without its O(n²) re-buffering.
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** `Sec-WebSocket-Accept` for a client key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encode one unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** A close frame with a code and a (cut) reason. */
export function closeFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 120);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload);
}

export interface FrameDecoderEvents {
  /** A complete text message (fragments joined). */
  onText(text: string): void;
  onPing(payload: Buffer): void;
  onClose(code: number): void;
  /** Protocol violation: the connection must be closed with 1002 / 1009. */
  onError(code: 1002 | 1009, reason: string): void;
}

/** Incremental decoder of client frames. Binary messages are ignored (the protocol only uses text). */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = -1;
  private failed = false;

  constructor(
    private readonly events: FrameDecoderEvents,
    /** Max bytes of one message (all fragments); may be raised later (after the handshake). */
    public maxMessageBytes: number,
  ) {}

  push(chunk: Buffer): void {
    if (this.failed || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (!this.failed && this.next());
  }

  /** Decode one frame when complete. */
  private next(): boolean {
    if (this.buffered < 2) return false;
    const head = this.peek(Math.min(this.buffered, 14));
    const b0 = head[0]!;
    const b1 = head[1]!;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (head.length < 4) return false;
      length = head.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (head.length < 10) return false;
      const big = head.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) return this.fail(1009, 'message too large');
      length = Number(big);
      offset = 10;
    }
    if (!masked) return this.fail(1002, 'client frames must be masked');
    if (length > this.maxMessageBytes) return this.fail(1009, 'message too large');
    if (this.buffered < offset + 4 + length) return false;
    const frame = this.take(offset + 4 + length);
    const mask = frame.subarray(offset, offset + 4);
    const payload = frame.subarray(offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]!;
    this.onFrame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    return true;
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_PING:
        this.events.onPing(payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.events.onClose(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmentOpcode !== -1) {
          this.fail(1002, 'new message inside a fragmented one');
          return;
        }
        if (fin) {
          if (opcode === OP_TEXT) this.events.onText(payload.toString('utf8'));
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      case OP_CONTINUATION:
        if (this.fragmentOpcode === -1) {
          this.fail(1002, 'continuation without a message');
          return;
        }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessageBytes) {
          this.fail(1009, 'message too large');
          return;
        }
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments, this.fragmentBytes);
          const text = this.fragmentOpcode === OP_TEXT;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = -1;
          if (text) this.events.onText(whole.toString('utf8'));
        }
        return;
      default:
        this.fail(1002, 'unknown opcode');
    }
  }

  private fail(code: 1002 | 1009, reason: string): boolean {
    this.failed = true;
    this.chunks = [];
    this.buffered = 0;
    this.events.onError(code, reason);
    return false;
  }

  /** The first `n` buffered bytes (without consuming them). */
  private peek(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const parts: Buffer[] = [];
    let have = 0;
    for (const chunk of this.chunks) {
      parts.push(chunk);
      have += chunk.length;
      if (have >= n) break;
    }
    return Buffer.concat(parts, have).subarray(0, n);
  }

  /** Consume `n` bytes (a writable copy when they span chunks). */
  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    let out: Buffer;
    if (first.length >= n) {
      out = Buffer.from(first.subarray(0, n));
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      const all = Buffer.concat(this.chunks, this.buffered);
      out = Buffer.from(all.subarray(0, n));
      this.chunks = all.length > n ? [all.subarray(n)] : [];
    }
    this.buffered -= n;
    return out;
  }
}
