import { describe, expect, it } from 'vitest';
import type { WsConnection, WsDelta, WsFrame, WsHookEvent } from '../../src/lib/ws';
import {
  applyWsDelta,
  capWsText,
  chunkWsDelta,
  sanitizeWsEvent,
  sanitizeWsEvents,
  utf8Length,
  WS_FRAME_CAP,
  WsLog,
  WsRecorder,
} from '../../src/lib/ws';
import {
  actionCableChannelName,
  classifyFrame,
  createClassifyContext,
  DEFAULT_CHANNEL,
  graphqlOperationName,
  HEARTBEAT_CHANNEL,
  parseSocketIo,
  parseStomp,
  protocolHint,
} from '../../src/lib/ws-protocols';
import type { WsKind } from '../../src/lib/ws-protocols';
import {
  filterFrames,
  framePreview,
  frameMatches,
  parseJsonPath,
  parseWsFilter,
  payloadText,
  valuesAtPath,
  WsInspector,
} from '../../src/lib/ws-inspector';
import { WsStore } from '../../src/content/wsStore';

const text = (t: string) => ({ opcode: 'text' as const, text: t });

function classifyAll(frames: string[], kind: WsKind | null = null) {
  const ctx = createClassifyContext(kind);
  return { ctx, out: frames.map((f) => classifyFrame(text(f), ctx)) };
}

function conn(wsId: string, over: Partial<WsConnection> = {}): WsConnection {
  return {
    wsId,
    frameId: 0,
    url: 'wss://example.test/ws',
    protocols: [],
    protocol: '',
    extensions: '',
    state: 'open',
    createdAt: 1,
    errors: 0,
    sent: 0,
    received: 0,
    bytesSent: 0,
    bytesReceived: 0,
    lastActivity: 1,
    ...over,
  };
}

function frame(id: number, wsId: string, over: Partial<WsFrame> = {}): WsFrame {
  return { id, wsId, dir: 'in', time: id, opcode: 'text', text: `m${id}`, size: 2, truncated: false, ...over };
}

// ------------------------------------------------------------------------------------------------ validation

describe('sanitizeWsEvents (untrusted hook data)', () => {
  it('accepts well-formed events and re-creates their fields', () => {
    const events = sanitizeWsEvents([
      { e: 'new', id: 'w1abc', time: 1, url: 'wss://x/y', protocols: ['a', 5, 'b'], frameUrl: 'https://p/', extra: 1 },
      { e: 'open', id: 'w1abc', time: 2, protocol: 'a', extensions: 'permessage-deflate' },
      { e: 'frame', id: 'w1abc', time: 3, dir: 'in', opcode: 'text', text: 'héllo', size: 0 },
      { e: 'frame', id: 'w1abc', time: 4, dir: 'out', opcode: 'binary', base64: 'AAEC', size: 3 },
      { e: 'closing', id: 'w1abc', time: 5, code: 1000, reason: 'bye' },
      { e: 'close', id: 'w1abc', time: 6, code: 1000, reason: 'bye', wasClean: true },
      { e: 'error', id: 'w1abc', time: 7 },
    ]);
    expect(events.map((e) => e.e)).toEqual(['new', 'open', 'frame', 'frame', 'closing', 'close', 'error']);
    expect(events[0]).toEqual({ e: 'new', id: 'w1abc', time: 1, url: 'wss://x/y', protocols: ['a', 'b'], frameUrl: 'https://p/' });
    // Size is at least the real UTF-8 length.
    expect(events[2]).toMatchObject({ text: 'héllo', size: 6, truncated: false });
    expect(events[3]).toMatchObject({ base64: 'AAEC', size: 3 });
  });

  it('rejects malformed events', () => {
    const bad: unknown[] = [
      null,
      'x',
      { e: 'new', id: 'w1', time: 1 }, // no url
      { e: 'frame', id: 'w1', time: 1, dir: 'up', opcode: 'text', text: 'a', size: 1 },
      { e: 'frame', id: 'w1', time: 1, dir: 'in', opcode: 'text', size: 1 }, // no text
      { e: 'frame', id: 'w1', time: 1, dir: 'in', opcode: 'binary', base64: 'not base64!', size: 1 },
      { e: 'open', id: 'bad id', time: 1 },
      { e: 'open', id: 'x'.repeat(65), time: 1 },
      { e: 'open', id: 'w1', time: Number.NaN },
      { e: 'nope', id: 'w1', time: 1 },
    ];
    expect(sanitizeWsEvents(bad)).toEqual([]);
    expect(sanitizeWsEvents('nope')).toEqual([]);
  });

  it('caps payloads at WS_FRAME_CAP and marks them truncated', () => {
    const big = 'é'.repeat(WS_FRAME_CAP); // 2 bytes each
    const ev = sanitizeWsEvent({ e: 'frame', id: 'w1', time: 1, dir: 'in', opcode: 'text', text: big, size: 0 }) as Extract<WsHookEvent, { e: 'frame' }>;
    expect(ev.truncated).toBe(true);
    expect(utf8Length(ev.text!)).toBeLessThanOrEqual(WS_FRAME_CAP);
    const b64 = 'A'.repeat(Math.ceil(WS_FRAME_CAP / 3) * 4 + 400);
    const bin = sanitizeWsEvent({ e: 'frame', id: 'w1', time: 1, dir: 'in', opcode: 'binary', base64: b64, size: 999999 }) as Extract<WsHookEvent, { e: 'frame' }>;
    expect(bin.truncated).toBe(true);
    expect(bin.size).toBe(999999);
    expect(bin.base64!.length).toBe(Math.ceil(WS_FRAME_CAP / 3) * 4);
  });

  it('capWsText never splits a surrogate pair', () => {
    const t = '😀'.repeat(10); // 4 bytes each
    const capped = capWsText(t, 10);
    expect(capped).toEqual({ text: '😀😀', truncated: true });
    expect(capWsText('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
});

// ------------------------------------------------------------------------------------------------ ring buffers

describe('WsLog', () => {
  it('keeps frames per connection in a bounded ring', () => {
    const log = new WsLog({ perConnection: 10, totalFrames: 1000, totalBytes: 1e9, maxConnections: 10 });
    log.upsert(conn('a'));
    for (let i = 1; i <= 25; i++) log.append(frame(i, 'a'));
    const frames = log.frames('a');
    expect(frames.length).toBe(10);
    expect(frames[0]!.id).toBe(16);
    expect(frames[9]!.id).toBe(25);
    expect(log.totalFrames).toBe(10);
  });

  it('ignores frames of unknown connections and replays of old ids', () => {
    const log = new WsLog();
    expect(log.append(frame(1, 'x'))).toBe(false);
    log.upsert(conn('x'));
    expect(log.append(frame(2, 'x'))).toBe(true);
    expect(log.append(frame(2, 'x'))).toBe(false);
    expect(log.append(frame(1, 'x'))).toBe(false);
    expect(log.frames('x').map((f) => f.id)).toEqual([2]);
  });

  it('evicts the globally oldest frames over the total cap', () => {
    const evicted: number[] = [];
    const log = new WsLog({ perConnection: 1000, totalFrames: 10, totalBytes: 1e9, maxConnections: 10 }, { evicted: (f) => evicted.push(...f.map((x) => x.id)) });
    log.upsert(conn('a'));
    log.upsert(conn('b'));
    for (let i = 1; i <= 12; i++) log.append(frame(i, i % 2 ? 'a' : 'b'));
    expect(log.totalFrames).toBeLessThanOrEqual(10);
    expect(evicted.slice(0, 2)).toEqual([1, 2]);
    const kept = [...log.frames('a'), ...log.frames('b')].map((f) => f.id).sort((x, y) => x - y);
    expect(kept[0]).toBeGreaterThan(2);
    expect(kept[kept.length - 1]).toBe(12);
  });

  it('evicts by payload bytes too', () => {
    const log = new WsLog({ perConnection: 1000, totalFrames: 1000, totalBytes: 10_000, maxConnections: 10 });
    log.upsert(conn('a'));
    for (let i = 1; i <= 20; i++) log.append(frame(i, 'a', { text: 'x'.repeat(1000) }));
    expect(log.totalBytes).toBeLessThanOrEqual(10_000);
    expect(log.frames('a').at(-1)!.id).toBe(20);
  });

  it('drops closed connections first beyond maxConnections', () => {
    const log = new WsLog({ perConnection: 10, totalFrames: 100, totalBytes: 1e9, maxConnections: 2 });
    log.upsert(conn('a'));
    log.upsert(conn('b', { state: 'closed' }));
    log.upsert(conn('c'));
    expect(log.connections().map((c) => c.wsId)).toEqual(['a', 'c']);
  });

  it('keeps identity of unchanged views', () => {
    const log = new WsLog();
    log.upsert(conn('a'));
    log.append(frame(1, 'a'));
    const v1 = log.frames('a');
    expect(log.frames('a')).toBe(v1);
    const list = log.connections();
    expect(log.connections()).toBe(list);
    log.append(frame(2, 'a'));
    expect(log.frames('a')).not.toBe(v1);
  });
});

// ------------------------------------------------------------------------------------------------ recorder

describe('WsRecorder', () => {
  const lifecycle: WsHookEvent[] = [
    { e: 'new', id: 'w1', time: 10, url: 'wss://h/s', protocols: ['chat'] },
    { e: 'open', id: 'w1', time: 11, protocol: 'chat', extensions: '' },
    { e: 'frame', id: 'w1', time: 12, dir: 'out', opcode: 'text', text: 'hi', size: 2 },
    { e: 'frame', id: 'w1', time: 13, dir: 'in', opcode: 'text', text: 'hello', size: 5 },
  ];

  it('builds connections, frames and deltas', () => {
    const r = new WsRecorder();
    expect(r.apply(0, lifecycle, { capturing: true })).toBe(true);
    const delta = r.takeDelta()!;
    expect(delta.connections).toHaveLength(1);
    expect(delta.connections[0]).toMatchObject({ wsId: '0:w1', state: 'open', protocol: 'chat', sent: 1, received: 1, bytesSent: 2, bytesReceived: 5 });
    expect(delta.frames.map((f) => [f.dir, f.text])).toEqual([
      ['out', 'hi'],
      ['in', 'hello'],
    ]);
    expect(r.takeDelta()).toBeNull();
  });

  it('respects capture: no new sockets or frames while paused, lifecycle still applies', () => {
    const r = new WsRecorder();
    r.apply(0, lifecycle, { capturing: true });
    r.takeDelta();
    r.apply(
      0,
      [
        { e: 'new', id: 'w2', time: 20, url: 'wss://h/2', protocols: [] },
        { e: 'frame', id: 'w1', time: 21, dir: 'in', opcode: 'text', text: 'x', size: 1 },
        { e: 'close', id: 'w1', time: 22, code: 1000, reason: '', wasClean: true },
      ],
      { capturing: false },
    );
    const d = r.takeDelta()!;
    expect(d.frames).toEqual([]);
    expect(d.connections.map((c) => [c.wsId, c.state])).toEqual([['0:w1', 'closed']]);
    expect(r.log.size).toBe(1);
  });

  it('namespaces sockets by frame and keeps subframe URLs', () => {
    const r = new WsRecorder();
    r.apply(3, [{ e: 'new', id: 'w1', time: 1, url: 'wss://a/', protocols: [] }], { capturing: true, frameUrl: 'https://sub/' });
    r.apply(0, [{ e: 'new', id: 'w1', time: 1, url: 'wss://b/', protocols: [] }], { capturing: true });
    expect(r.log.connections().map((c) => [c.wsId, c.frameUrl])).toEqual([
      ['3:w1', 'https://sub/'],
      ['0:w1', undefined],
    ]);
  });

  it('ignores events of unknown sockets and invalid frame ids', () => {
    const r = new WsRecorder();
    expect(r.apply(0, [{ e: 'open', id: 'zz', time: 1, protocol: '', extensions: '' }], { capturing: true })).toBe(false);
    expect(r.apply(-1, lifecycle, { capturing: true })).toBe(false);
  });

  it('clear keeps live sockets (counters reset) and drops closed ones', () => {
    const r = new WsRecorder();
    r.apply(0, lifecycle, { capturing: true });
    r.apply(0, [{ e: 'new', id: 'w2', time: 1, url: 'wss://h/2', protocols: [] }, { e: 'close', id: 'w2', time: 2, code: 1006, reason: '', wasClean: false }], { capturing: true });
    r.takeDelta();
    r.clear();
    const d = r.takeDelta()!;
    expect(d.reset).toBe(true);
    expect(d.connections.map((c) => [c.wsId, c.sent, c.received])).toEqual([['0:w1', 0, 0]]);
    expect(d.frames).toEqual([]);
  });

  it('mirrors deltas idempotently (snapshot + overlapping delta)', () => {
    const r = new WsRecorder();
    r.apply(0, lifecycle, { capturing: true });
    const snap = r.snapshot();
    const delta = r.takeDelta()!;
    const mirror = new WsLog();
    applyWsDelta(mirror, snap);
    applyWsDelta(mirror, delta);
    expect(mirror.frames('0:w1').map((f) => f.text)).toEqual(['hi', 'hello']);
  });

  it('chunks large deltas, connections first and removals last', () => {
    const frames = Array.from({ length: 5 }, (_, i) => frame(i + 1, 'a'));
    const chunks = chunkWsDelta({ reset: true, connections: [conn('a')], frames, removed: ['z'] }, 2);
    expect(chunks.map((c) => c.frames.length)).toEqual([2, 2, 1]);
    expect(chunks[0]!.reset).toBe(true);
    expect(chunks[0]!.connections).toHaveLength(1);
    expect(chunks[1]!.connections).toHaveLength(0);
    expect(chunks.map((c) => c.removed)).toEqual([[], [], ['z']]);
  });
});

describe('WsStore (content)', () => {
  it('coalesces deltas and only sends through open top-frame sockets', async () => {
    const flushes: Array<() => void> = [];
    const sent: string[] = [];
    const store = new WsStore({ schedule: (f) => flushes.push(f), send: async (id, t) => (sent.push(`${id}:${t}`), { ok: true }) });
    const deltas: WsDelta[] = [];
    store.subscribe((d) => deltas.push(d));
    store.handle(0, [{ e: 'new', id: 'w1', time: 1, url: 'wss://h/', protocols: [] }], { capturing: true });
    store.handle(0, [{ e: 'open', id: 'w1', time: 2, protocol: '', extensions: '' }], { capturing: true });
    store.handle(2, [{ e: 'new', id: 'w9', time: 1, url: 'wss://sub/', protocols: [] }, { e: 'open', id: 'w9', time: 2, protocol: '', extensions: '' }], { capturing: true });
    expect(flushes).toHaveLength(1);
    flushes[0]!();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.connections.map((c) => c.state)).toEqual(['open', 'open']);
    expect(await store.send('0:w1', 'ping')).toEqual({ ok: true });
    expect(sent).toEqual(['w1:ping']);
    expect((await store.send('2:w9', 'x')).ok).toBe(false);
    expect((await store.send('0:nope', 'x')).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ protocols

describe('protocol hints', () => {
  it('reads URLs and sub-protocols', () => {
    expect(protocolHint('wss://h/socket.io/?EIO=4&transport=websocket', [])).toBe('socketio');
    expect(protocolHint('wss://h/live/websocket?vsn=2.0.0', [])).toBe('phoenix');
    expect(protocolHint('wss://h/cable', [])).toBe('actioncable');
    expect(protocolHint('wss://h/q', ['graphql-transport-ws'])).toBe('graphql-ws');
    expect(protocolHint('wss://h/q', [], 'graphql-ws')).toBe('graphql-ws');
    expect(protocolHint('wss://h/stomp', ['v12.stomp', 'v11.stomp'])).toBe('stomp');
    expect(protocolHint('wss://h/x', ['actioncable-v1-json'])).toBe('actioncable');
    expect(protocolHint('wss://h/plain', [])).toBeNull();
  });
});

describe('Socket.IO / Engine.IO', () => {
  it('parses packets', () => {
    expect(parseSocketIo('42["chat",{"a":1}]')).toMatchObject({ engine: 4, type: 2, dataStart: 2, data: ['chat', { a: 1 }] });
    expect(parseSocketIo('42/admin,7["x"]')).toMatchObject({ type: 2, namespace: '/admin', ackId: 7, dataStart: 10 });
    expect(parseSocketIo('431[{"ok":true}]')).toMatchObject({ type: 3, ackId: 1 });
    expect(parseSocketIo('451-["upload",{"_placeholder":true,"num":0}]')).toMatchObject({ type: 5, attachments: 1 });
    expect(parseSocketIo('40/admin,')).toMatchObject({ type: 0, namespace: '/admin' });
    expect(parseSocketIo('2probe')).toMatchObject({ engine: 2 });
    expect(parseSocketIo('7x')).toBeNull();
    expect(parseSocketIo('2hello')).toBeNull();
  });

  it('classifies a v4 session: open, connect, events, acks, heartbeats', () => {
    const { ctx, out } = classifyAll([
      '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000}',
      '40',
      '40{"sid":"def"}',
      '42["chat message",{"text":"hi"}]',
      '42/admin,["stats",1]',
      '4213["get",{"id":1}]',
      '4313[{"id":1}]',
      '2',
      '3',
      '44{"message":"nope"}',
    ]);
    expect(ctx.kind).toBe('socketio');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['HB', 'open'],
      ['HB', 'connect'],
      ['HB', 'connect'],
      ['chat message', 'chat message'],
      ['/admin stats', 'stats'],
      ['get', 'get'],
      ['acks', 'ack 13'],
      ['HB', 'ping'],
      ['HB', 'pong'],
      ['errors', 'connect_error'],
    ]);
    expect(out[3]).toMatchObject({ kind: 'socketio', payloadStart: 2 });
  });

  it('is sticky: bare "2"/"3" are heartbeats only on a Socket.IO connection', () => {
    expect(classifyAll(['2']).out[0]).toMatchObject({ channel: DEFAULT_CHANNEL, kind: 'raw' });
    expect(classifyAll(['2'], 'socketio').out[0]).toMatchObject({ channel: HEARTBEAT_CHANNEL, heartbeat: true });
  });

  it('routes binary attachments to their event channel', () => {
    const ctx = createClassifyContext('socketio');
    classifyFrame(text('451-["upload",{"_placeholder":true,"num":0}]'), ctx);
    expect(classifyFrame({ opcode: 'binary' }, ctx)).toMatchObject({ channel: 'upload', event: 'attachment' });
    expect(classifyFrame({ opcode: 'binary' }, ctx)).toMatchObject({ channel: DEFAULT_CHANNEL });
  });
});

describe('Phoenix', () => {
  it('v2 arrays and v1 objects; heartbeats on the phoenix topic', () => {
    const { ctx, out } = classifyAll([
      '["1","1","room:lobby","phx_join",{}]',
      '["1","1","room:lobby","phx_reply",{"status":"ok","response":{}}]',
      '[null,"2","phoenix","heartbeat",{}]',
      '["1",null,"room:lobby","new_msg",{"body":"hi"}]',
      '{"topic":"room:2","event":"shout","payload":{},"ref":null}',
    ]);
    expect(ctx.kind).toBe('phoenix');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['room:lobby', 'phx_join'],
      ['room:lobby', 'phx_reply'],
      ['HB', 'heartbeat'],
      ['room:lobby', 'new_msg'],
      ['room:2', 'shout'],
    ]);
  });
});

describe('Action Cable', () => {
  it('channels from identifiers, control frames as heartbeats', () => {
    const id = JSON.stringify({ channel: 'ChatChannel', room: '1' });
    const { ctx, out } = classifyAll([
      '{"type":"welcome"}',
      '{"type":"ping","message":1700000000}',
      JSON.stringify({ command: 'subscribe', identifier: id }),
      JSON.stringify({ identifier: id, type: 'confirm_subscription' }),
      JSON.stringify({ command: 'message', identifier: id, data: JSON.stringify({ action: 'speak', text: 'hi' }) }),
      JSON.stringify({ identifier: id, message: { type: 'said', text: 'hi' } }),
    ]);
    expect(ctx.kind).toBe('actioncable');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['HB', 'welcome'],
      ['HB', 'ping'],
      ['ChatChannel · room=1', 'subscribe'],
      ['ChatChannel · room=1', 'confirm_subscription'],
      ['ChatChannel · room=1', 'speak'],
      ['ChatChannel · room=1', 'said'],
    ]);
    expect(actionCableChannelName('{"channel":"A"}')).toBe('A');
    expect(actionCableChannelName('nope')).toBeNull();
  });
});

describe('STOMP', () => {
  it('parses frames and maps subscriptions to destinations', () => {
    const f = parseStomp('MESSAGE\ndestination:/topic/a\nsubscription:sub-0\n\n{"x":1}\0');
    expect(f).toMatchObject({ command: 'MESSAGE', headers: { destination: '/topic/a', subscription: 'sub-0' } });
    expect('MESSAGE\ndestination:/topic/a\nsubscription:sub-0\n\n{"x":1}\0'.slice(f!.bodyStart, f!.bodyEnd)).toBe('{"x":1}');
    const { ctx, out } = classifyAll([
      'CONNECT\naccept-version:1.2\nhost:x\n\n\0',
      'CONNECTED\nversion:1.2\n\n\0',
      'SUBSCRIBE\nid:sub-0\ndestination:/topic/prices\n\n\0',
      'MESSAGE\nsubscription:sub-0\nmessage-id:1\n\n{"p":1}\0',
      'SEND\ndestination:/app/hello\ncontent-type:application/json\n\n{"n":"x"}\0',
      '\n',
      'UNSUBSCRIBE\nid:sub-0\n\n\0',
      'ERROR\nmessage:bad\n\n\0',
    ]);
    expect(ctx.kind).toBe('stomp');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['HB', 'CONNECT'],
      ['HB', 'CONNECTED'],
      ['/topic/prices', 'SUBSCRIBE'],
      ['/topic/prices', 'MESSAGE'],
      ['/app/hello', 'SEND'],
      ['HB', 'heart-beat'],
      ['/topic/prices', 'UNSUBSCRIBE'],
      ['errors', 'ERROR'],
    ]);
  });
});

describe('graphql-ws / subscriptions-transport-ws', () => {
  it('names channels after the subscribed operation', () => {
    const { ctx, out } = classifyAll([
      '{"type":"connection_init","payload":{}}',
      '{"type":"connection_ack"}',
      '{"id":"1","type":"subscribe","payload":{"query":"subscription OnMessage { message { id } }"}}',
      '{"id":"1","type":"next","payload":{"data":{"message":{"id":"7"}}}}',
      '{"id":"2","type":"start","payload":{"query":"subscription { x }","operationName":"Ticker"}}',
      '{"id":"2","type":"data","payload":{}}',
      '{"type":"ka"}',
      '{"id":"3","type":"subscribe","payload":{"query":"subscription { y }"}}',
      '{"id":"1","type":"complete"}',
      '{"type":"ping"}',
    ]);
    expect(ctx.kind).toBe('graphql-ws');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['HB', 'connection_init'],
      ['HB', 'connection_ack'],
      ['OnMessage', 'subscribe'],
      ['OnMessage', 'next'],
      ['Ticker', 'start'],
      ['Ticker', 'data'],
      ['HB', 'ka'],
      ['subscription #3', 'subscribe'],
      ['OnMessage', 'complete'],
      ['HB', 'ping'],
    ]);
    expect(graphqlOperationName({ query: 'query  Foo($a: ID) { a }' })).toBe('Foo');
  });
});

describe('generic JSON and raw', () => {
  it('uses channel/topic/room/stream keys, then event-ish keys', () => {
    const { ctx, out } = classifyAll([
      '{"channel":"prices","event":"tick","p":1}',
      '{"topic":"orders","type":"created"}',
      '{"room":42,"action":"join"}',
      '{"type":"chat","text":"hi"}',
      '{"op":"ping"}',
      '{"ping":1}',
      '[1,2,3]',
      '{"stream":{"id":1}}',
    ]);
    expect(ctx.kind).toBe('json');
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.event])).toEqual([
      ['prices', 'tick'],
      ['orders', 'created'],
      ['42', 'join'],
      ['chat', 'chat'],
      ['HB', 'ping'],
      ['HB', 'ping'],
      [DEFAULT_CHANNEL, undefined],
      ['{"id":1}', undefined],
    ]);
  });

  it('raw text goes to one default channel; ping/pong words are heartbeats', () => {
    const { out } = classifyAll(['hello there', 'PING', '{broken json']);
    expect(out.map((c) => [c.channel === HEARTBEAT_CHANNEL ? 'HB' : c.channel, c.kind])).toEqual([
      [DEFAULT_CHANNEL, 'raw'],
      ['HB', 'raw'],
      [DEFAULT_CHANNEL, 'raw'],
    ]);
    expect(classifyFrame({ opcode: 'binary' }, createClassifyContext())).toMatchObject({ channel: DEFAULT_CHANNEL, kind: 'raw' });
  });
});

// ------------------------------------------------------------------------------------------------ inspector

describe('WsInspector', () => {
  function seeded() {
    const insp = new WsInspector();
    insp.apply({
      reset: true,
      connections: [conn('io', { url: 'wss://h/socket.io/?EIO=4&transport=websocket' }), conn('js')],
      frames: [
        frame(1, 'io', { text: '0{"sid":"x"}' }),
        frame(2, 'io', { text: '40', dir: 'out' }),
        frame(3, 'io', { text: '42["chat",{"user":{"name":"Ann"},"n":1}]' }),
        frame(4, 'io', { text: '42["chat",{"user":{"name":"Bob"},"n":2}]', dir: 'out' }),
        frame(5, 'io', { text: '42["typing",true]' }),
        frame(6, 'io', { text: '2' }),
        frame(7, 'js', { text: '{"channel":"a","v":1}' }),
      ],
      removed: [],
    });
    return insp;
  }

  it('classifies on arrival and keeps per-channel stats', () => {
    const insp = seeded();
    expect(insp.protocolOf('io')).toBe('socketio');
    expect(insp.protocolOf('js')).toBe('json');
    const ch = insp.channels('io');
    expect(ch.map((c) => [c.key === HEARTBEAT_CHANNEL ? 'HB' : c.key, c.sent, c.received])).toEqual([
      ['chat', 1, 1],
      ['typing', 0, 1],
      ['HB', 1, 2],
    ]);
    expect(insp.heartbeatCount('io')).toBe(3);
  });

  it('filters by channel, direction, heartbeats, text and JSON path', () => {
    const insp = seeded();
    const frames = insp.frames('io');
    const info = (f: WsFrame) => insp.info(f);
    const ids = (filter: Parameters<typeof filterFrames>[2]) => filterFrames(frames, info, filter).map((f) => f.id);
    expect(ids({ text: '', dir: 'all', heartbeats: false, channel: null })).toEqual([3, 4, 5]);
    expect(ids({ text: '', dir: 'all', heartbeats: true, channel: null })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids({ text: '', dir: 'out', heartbeats: false, channel: null })).toEqual([4]);
    expect(ids({ text: '', dir: 'all', heartbeats: false, channel: 'chat' })).toEqual([3, 4]);
    expect(ids({ text: '', dir: 'all', heartbeats: false, channel: HEARTBEAT_CHANNEL })).toEqual([1, 2, 6]);
    expect(ids({ text: 'bob', dir: 'all', heartbeats: false, channel: null })).toEqual([4]);
    expect(ids({ text: 'chat -bob', dir: 'all', heartbeats: false, channel: null })).toEqual([3]);
    // Socket.IO: paths address the first argument.
    expect(ids({ text: '$.user.name = Ann', dir: 'all', heartbeats: false, channel: null })).toEqual([3]);
    expect(ids({ text: '$.n', dir: 'all', heartbeats: false, channel: null })).toEqual([3, 4]);
    expect(ids({ text: '$[0] = typing', dir: 'all', heartbeats: false, channel: null })).toEqual([5]);
    expect(ids({ text: '.user.name ~ o', dir: 'all', heartbeats: false, channel: null })).toEqual([4]);
  });

  it('previews Socket.IO arguments and strips packet prefixes', () => {
    const insp = seeded();
    const f3 = insp.frames('io')[2]!;
    expect(framePreview(f3, insp.info(f3))).toBe('{"user":{"name":"Ann"},"n":1}');
    expect(payloadText(f3, insp.info(f3))).toBe('["chat",{"user":{"name":"Ann"},"n":1}]');
    const bin = frame(9, 'js', { opcode: 'binary', text: undefined, base64: 'iVBORw0KGgo=', size: 8 });
    expect(framePreview(bin, { channel: DEFAULT_CHANNEL, kind: 'raw' })).toBe('89 50 4e 47 0d 0a 1a 0a');
  });

  it('decrements stats on eviction and resets on clear', () => {
    const insp = new WsInspector({ perConnection: 2, totalFrames: 100, totalBytes: 1e9, maxConnections: 10 });
    insp.apply({ connections: [conn('a')], frames: [frame(1, 'a', { text: '{"channel":"x"}' }), frame(2, 'a', { text: '{"channel":"y"}' }), frame(3, 'a', { text: '{"channel":"y"}' })], removed: [] });
    expect(insp.channels('a').map((c) => [c.key, c.count])).toEqual([['y', 2]]);
    insp.apply({ reset: true, connections: [conn('a')], frames: [], removed: [] });
    expect(insp.channels('a')).toEqual([]);
    expect(insp.frames('a')).toHaveLength(0);
  });

  it('JSON path parsing', () => {
    expect(parseJsonPath('$.a.b[0]["c d"]')).toEqual(['a', 'b', 0, 'c d']);
    expect(parseJsonPath('$.items[*].id')).toEqual(['items', '*', 'id']);
    expect(parseJsonPath('$.a[')).toBeNull();
    expect(valuesAtPath({ items: [{ id: 1 }, { id: 2 }] }, ['items', '*', 'id'])).toEqual([1, 2]);
    expect(parseWsFilter('$.a = "x y"')).toEqual({ type: 'path', path: ['a'], op: '=', value: 'x y' });
    expect(parseWsFilter('$.a[').type).toBe('invalid');
    expect(parseWsFilter('  ')).toEqual({ type: 'none' });
    const f = frame(1, 'a', { text: '{"a":{"b":[1,2]}}' });
    expect(frameMatches(f, { channel: 'm', kind: 'json' }, parseWsFilter('$.a.b[1] = 2'))).toBe(true);
    expect(frameMatches(f, { channel: 'm', kind: 'json' }, parseWsFilter('$.a.b[1] != 2'))).toBe(false);
  });
});
