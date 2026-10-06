import { describe, expect, it } from 'vitest';
import { LineDecoder, type LineError, encodeLine } from '../line-protocol';
import { type FrameError, NativeMessageDecoder, encodeNativeMessage } from '../nm-framing';

function nmDecoder(maxMessageBytes?: number): { decoder: NativeMessageDecoder; messages: unknown[]; errors: FrameError[] } {
  const messages: unknown[] = [];
  const errors: FrameError[] = [];
  const decoder = new NativeMessageDecoder({
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
    onMessage: (m) => messages.push(m),
    onError: (e) => errors.push(e),
  });
  return { decoder, messages, errors };
}

function rawFrame(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe('native messaging framing', () => {
  it('encodes a 4-byte little-endian length + UTF-8 JSON', () => {
    const frame = encodeNativeMessage({ t: 'hello', s: 'é' });
    const json = '{"t":"hello","s":"é"}';
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(json));
    expect(frame.subarray(4).toString('utf8')).toBe(json);
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([Buffer.byteLength(json), 0, 0, 0]));
  });

  it('refuses messages over the limit and non-JSON values', () => {
    expect(() => encodeNativeMessage({ text: 'x'.repeat(100) }, 50)).toThrow(/too large/);
    expect(() => encodeNativeMessage(undefined)).toThrow(TypeError);
    expect(encodeNativeMessage({ text: 'x'.repeat(10) }, 50).length).toBeLessThanOrEqual(54);
  });

  it('decodes frames split at every possible byte boundary', () => {
    const messages = [{ t: 'res', id: '1', ok: true, result: { text: 'héllo 🌍', n: 12345678901234567890 } }, { t: 'push' }, []];
    const stream = Buffer.concat(messages.map((m) => encodeNativeMessage(m)));
    for (let split = 1; split < stream.length; split++) {
      const { decoder, messages: out } = nmDecoder();
      decoder.push(stream.subarray(0, split));
      decoder.push(stream.subarray(split));
      expect(out).toEqual(messages);
      expect(decoder.pendingBytes).toBe(0);
    }
  });

  it('decodes a byte-at-a-time stream and several frames per chunk', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ i, pad: 'x'.repeat(i * 7) }));
    const stream = Buffer.concat(messages.map((m) => encodeNativeMessage(m)));
    const one = nmDecoder();
    for (const byte of stream) one.decoder.push(Buffer.from([byte]));
    expect(one.messages).toEqual(messages);
    const all = nmDecoder();
    all.decoder.push(stream);
    expect(all.messages).toEqual(messages);
  });

  it('keeps a partial frame pending until the rest arrives', () => {
    const frame = encodeNativeMessage({ big: 'y'.repeat(5000) });
    const { decoder, messages } = nmDecoder();
    decoder.push(frame.subarray(0, 2));
    decoder.push(frame.subarray(2, 3000));
    expect(messages).toEqual([]);
    expect(decoder.pendingBytes).toBe(3000);
    decoder.push(frame.subarray(3000));
    expect(messages).toHaveLength(1);
  });

  it('skips an oversized frame (even when it arrives in pieces) and stays in sync', () => {
    const big = encodeNativeMessage({ big: 'z'.repeat(500) });
    const next = encodeNativeMessage({ after: true });
    const { decoder, messages, errors } = nmDecoder(100);
    const stream = Buffer.concat([big, next]);
    decoder.push(stream.subarray(0, 10));
    decoder.push(stream.subarray(10, 300));
    decoder.push(stream.subarray(300));
    expect(errors).toEqual([{ kind: 'too-large', bytes: big.length - 4 }]);
    expect(messages).toEqual([{ after: true }]);
  });

  it('reports invalid JSON and continues', () => {
    const { decoder, messages, errors } = nmDecoder();
    decoder.push(Buffer.concat([rawFrame(Buffer.from('{nope')), encodeNativeMessage({ ok: 1 }), rawFrame(Buffer.alloc(0))]));
    expect(errors.map((e) => e.kind)).toEqual(['invalid-json', 'invalid-json']);
    expect(messages).toEqual([{ ok: 1 }]);
  });
});

describe('NDJSON line protocol', () => {
  function lineDecoder(maxLineBytes?: number): { decoder: LineDecoder; messages: unknown[]; errors: LineError[] } {
    const messages: unknown[] = [];
    const errors: LineError[] = [];
    const decoder = new LineDecoder({
      ...(maxLineBytes !== undefined ? { maxLineBytes } : {}),
      onMessage: (m) => messages.push(m),
      onError: (e) => errors.push(e),
    });
    return { decoder, messages, errors };
  }

  it('encodes one JSON object per line (newlines in strings stay escaped)', () => {
    expect(encodeLine({ a: 'x\ny' })).toBe('{"a":"x\\ny"}\n');
    expect(() => encodeLine(undefined)).toThrow(TypeError);
  });

  it('splits multi-byte characters across chunks safely', () => {
    const line = Buffer.from(encodeLine({ text: '日本語 🌍 émoji' }));
    for (let split = 1; split < line.length; split++) {
      const { decoder, messages } = lineDecoder();
      decoder.push(line.subarray(0, split));
      decoder.push(line.subarray(split));
      expect(messages).toEqual([{ text: '日本語 🌍 émoji' }]);
    }
  });

  it('handles several lines per chunk, CRLF and blank lines', () => {
    const { decoder, messages, errors } = lineDecoder();
    decoder.push('{"a":1}\n\n{"b":2}\r\n  \n{"c"');
    decoder.push(':3}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(errors).toEqual([]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('drops an over-long line without buffering it and recovers on the next line', () => {
    const { decoder, messages, errors } = lineDecoder(64);
    decoder.push(`{"x":"${'a'.repeat(40)}`);
    decoder.push('a'.repeat(100));
    expect(decoder.pendingBytes).toBe(0);
    decoder.push('"}\n{"ok":true}\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('too-long');
    expect(messages).toEqual([{ ok: true }]);
  });

  it('reports invalid JSON lines', () => {
    const { decoder, messages, errors } = lineDecoder();
    decoder.push('not json\n{"fine":1}\n');
    expect(errors.map((e) => e.kind)).toEqual(['invalid-json']);
    expect(messages).toEqual([{ fine: 1 }]);
  });
});
