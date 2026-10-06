/**
 * Channel detection for WebSocket frames: protocol adapters that name the channel / event of each message.
 *
 * Adapters: Socket.IO over Engine.IO (v3/v4 packets), Phoenix channels (v1 objects / v2 arrays), Action Cable,
 * STOMP, graphql-ws + subscriptions-transport-ws, generic JSON (channel/topic/room/stream + event/type/action/op/
 * cmd keys) and raw text. Detection is sticky per connection: a confident match (or the URL / negotiated
 * sub-protocol) fixes the connection's protocol, so ambiguous frames ("2", "40", "\n") are read the same way.
 * Protocol-level control and heartbeat frames are put in the HEARTBEAT_CHANNEL group.
 */

export type WsKind = 'socketio' | 'phoenix' | 'actioncable' | 'stomp' | 'graphql-ws' | 'json' | 'raw';

/** Detected channel of a frame. */
export interface WsFrameClass {
  /** Channel key (HEARTBEAT_CHANNEL for control / heartbeat frames, DEFAULT_CHANNEL when nothing better). */
  channel: string;
  event?: string;
  kind: WsKind;
  /** Control / heartbeat frame (hidden by default). */
  heartbeat?: boolean;
  /** Offset of the JSON payload in the text (Socket.IO packet prefix, STOMP body). */
  payloadStart?: number;
  /** End offset of the payload (STOMP: before the NUL terminator). */
  payloadEnd?: number;
}

/** Per-connection state the adapters keep (sticky protocol, graphql operation names, STOMP subscriptions). */
export interface WsClassifyContext {
  kind: WsKind | null;
  gqlOps: Map<string, string>;
  stompSubs: Map<string, string>;
  /** Socket.IO: channel of the last binary event, for its attachment frames. */
  ioBinaryChannel: string | null;
  ioBinaryPending: number;
}

/** Channel key of the control / heartbeat group (a control character keeps it apart from real names). */
export const HEARTBEAT_CHANNEL = '\u001fheartbeats';
export const DEFAULT_CHANNEL = 'messages';
const MAX_NAME = 96;

/** Human names of the protocols. */
export const WS_KIND_LABEL: Record<WsKind, string> = {
  socketio: 'Socket.IO',
  phoenix: 'Phoenix',
  actioncable: 'Action Cable',
  stomp: 'STOMP',
  'graphql-ws': 'GraphQL',
  json: 'JSON',
  raw: 'Raw',
};

export function createClassifyContext(kind: WsKind | null = null): WsClassifyContext {
  return { kind, gqlOps: new Map(), stompSubs: new Map(), ioBinaryChannel: null, ioBinaryPending: 0 };
}

/** Protocol suggested by the URL and the requested / negotiated sub-protocols (null when unknown). */
export function protocolHint(url: string, protocols: readonly string[], negotiated = ''): WsKind | null {
  const subs = [negotiated, ...protocols].map((p) => p.toLowerCase());
  if (subs.some((p) => p === 'graphql-transport-ws' || p === 'graphql-ws')) return 'graphql-ws';
  if (subs.some((p) => /^v1\d\.stomp$|^stomp$/.test(p))) return 'stomp';
  if (subs.some((p) => p.startsWith('actioncable-'))) return 'actioncable';
  let path = '';
  let query = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname.toLowerCase();
    query = parsed.search;
  } catch {
    path = url.toLowerCase();
  }
  if (path.includes('/socket.io') || /[?&]EIO=\d/.test(query)) return 'socketio';
  if (/\/websocket\/?$/.test(path) && /[?&]vsn=\d/.test(query)) return 'phoenix';
  if (/\/cable\/?$/.test(path)) return 'actioncable';
  if (/\/graphql/.test(path) && subs.length > 1) return 'graphql-ws';
  return null;
}

function name(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value.slice(0, MAX_NAME) : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trimStart();
  const c = t.charCodeAt(0);
  // Only objects / arrays (and quoted strings for Socket.IO-less JSON) are worth a parse.
  if (c !== 0x7b && c !== 0x5b) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const HEARTBEAT_WORDS = new Set(['ping', 'pong', 'heartbeat', 'hb', 'keepalive', 'keep-alive', 'keep_alive', 'ka', 'heartbeat_ack']);

function heartbeat(kind: WsKind, event?: string): WsFrameClass {
  return event ? { channel: HEARTBEAT_CHANNEL, event, kind, heartbeat: true } : { channel: HEARTBEAT_CHANNEL, kind, heartbeat: true };
}

// ------------------------------------------------------------------------------------------------- Socket.IO

/** A parsed Engine.IO / Socket.IO text packet. */
export interface SocketIoPacket {
  engine: number;
  /** Socket.IO packet type (engine 4 only). */
  type?: number;
  namespace?: string;
  ackId?: number;
  attachments?: number;
  /** Offset of the JSON data in the text, when present. */
  dataStart?: number;
  data?: unknown;
  /** The data part is not valid JSON. */
  invalid?: boolean;
}

const ENGINE_TYPES = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'];
const IO_TYPES = ['connect', 'disconnect', 'event', 'ack', 'connect_error', 'binary_event', 'binary_ack'];

/** Parse an Engine.IO (v3/v4) text packet with its Socket.IO payload. Null when it is not one. */
export function parseSocketIo(text: string): SocketIoPacket | null {
  const engine = text.charCodeAt(0) - 48;
  if (!(engine >= 0 && engine <= 6)) return null;
  if (engine !== 4) {
    const rest = text.slice(1);
    const packet: SocketIoPacket = { engine };
    if (rest) {
      if (engine === 0) {
        const json = tryJson(rest);
        if (!json.ok) return null;
        packet.data = json.value;
        packet.dataStart = 1;
      } else if (rest !== 'probe') return null;
    }
    return packet;
  }
  const type = text.charCodeAt(1) - 48;
  if (!(type >= 0 && type <= 6)) return null;
  const packet: SocketIoPacket = { engine, type };
  let i = 2;
  if (type === 5 || type === 6) {
    const dash = text.indexOf('-', i);
    if (dash < 0 || !/^\d+$/.test(text.slice(i, dash))) return null;
    packet.attachments = Number(text.slice(i, dash));
    i = dash + 1;
  }
  if (text[i] === '/') {
    const comma = text.indexOf(',', i);
    const end = comma < 0 ? text.length : comma;
    packet.namespace = text.slice(i, end);
    i = comma < 0 ? end : comma + 1;
  }
  const digits = /^\d+/.exec(text.slice(i, i + 20));
  if (digits) {
    const after = i + digits[0].length;
    if (text[after] === '[' || (after === text.length && (type === 3 || type === 6))) {
      packet.ackId = Number(digits[0]);
      i = after;
    }
  }
  if (i < text.length) {
    try {
      packet.data = JSON.parse(text.slice(i));
      packet.dataStart = i;
    } catch {
      packet.invalid = true;
    }
  }
  return packet;
}

function nsPrefix(ns: string | undefined, label: string): string {
  return ns && ns !== '/' ? `${ns} ${label}` : label;
}

/** Socket.IO adapter. `confident` = the frame alone proves the protocol. */
function classifySocketIo(text: string, ctx: WsClassifyContext): { cls: WsFrameClass; confident: boolean } | null {
  const p = parseSocketIo(text);
  if (!p || p.invalid) return null;
  const kind: WsKind = 'socketio';
  if (p.engine !== 4) {
    const confident = p.engine === 0 && isRecord(p.data) && typeof p.data.sid === 'string';
    if (!confident && ctx.kind !== 'socketio') return null;
    return { cls: heartbeat(kind, ENGINE_TYPES[p.engine]), confident };
  }
  const type = p.type!;
  const known = ctx.kind === 'socketio';
  switch (type) {
    case 0:
    case 1: {
      const confident = p.namespace !== undefined || isRecord(p.data);
      if (!confident && !known) return null;
      return { cls: { ...heartbeat(kind, nsPrefix(p.namespace, IO_TYPES[type]!)) }, confident };
    }
    case 2:
    case 5: {
      if (!Array.isArray(p.data) || typeof p.data[0] !== 'string') return null;
      const event = p.data[0].slice(0, MAX_NAME) || '(empty)';
      const channel = nsPrefix(p.namespace, event);
      if (type === 5 && p.attachments) {
        ctx.ioBinaryChannel = channel;
        ctx.ioBinaryPending = p.attachments;
      }
      return { cls: { channel, event, kind, payloadStart: p.dataStart }, confident: true };
    }
    case 3:
    case 6: {
      if (p.data !== undefined && !Array.isArray(p.data)) return null;
      if (!known && p.data === undefined) return null;
      const channel = nsPrefix(p.namespace, 'acks');
      if (type === 6 && p.attachments) {
        ctx.ioBinaryChannel = channel;
        ctx.ioBinaryPending = p.attachments;
      }
      const cls: WsFrameClass = { channel, event: p.ackId !== undefined ? `ack ${p.ackId}` : 'ack', kind };
      if (p.dataStart !== undefined) cls.payloadStart = p.dataStart;
      return { cls, confident: p.data !== undefined };
    }
    case 4: {
      if (!known && !isRecord(p.data)) return null;
      const cls: WsFrameClass = { channel: nsPrefix(p.namespace, 'errors'), event: 'connect_error', kind };
      if (p.dataStart !== undefined) cls.payloadStart = p.dataStart;
      return { cls, confident: isRecord(p.data) };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------- Phoenix

/** Phoenix channels: `[join_ref, ref, topic, event, payload]` (serializer v2) or `{topic, event, payload, ref}` (v1). */
export function classifyPhoenix(value: unknown): { cls: WsFrameClass; confident: boolean } | null {
  let topic: unknown;
  let event: unknown;
  let confident = false;
  if (Array.isArray(value)) {
    if (value.length !== 5) return null;
    const [joinRef, ref] = value;
    if (!(joinRef === null || typeof joinRef === 'string') || !(ref === null || typeof ref === 'string')) return null;
    topic = value[2];
    event = value[3];
    confident = typeof topic === 'string' && typeof event === 'string';
  } else if (isRecord(value)) {
    if (!('payload' in value) || !('ref' in value)) return null;
    topic = value.topic;
    event = value.event;
    confident = typeof topic === 'string' && typeof event === 'string';
  }
  if (!confident) return null;
  const t = name(topic) ?? '(no topic)';
  const e = name(event) ?? '';
  if (t === 'phoenix' || e === 'heartbeat') return { cls: heartbeat('phoenix', e || 'heartbeat'), confident };
  return { cls: { channel: t, event: e, kind: 'phoenix' }, confident };
}

// ------------------------------------------------------------------------------------------------- Action Cable

/** "ChatChannel · room=1" from an Action Cable identifier (a JSON string). */
export function actionCableChannelName(identifier: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(identifier);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const channel = name(parsed.channel);
  if (!channel) return null;
  const params = Object.entries(parsed)
    .filter(([k]) => k !== 'channel')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return (params.length ? `${channel} · ${params.join(' ')}` : channel).slice(0, MAX_NAME);
}

const CABLE_CONTROL = new Set(['welcome', 'ping', 'disconnect']);

export function classifyActionCable(value: unknown): { cls: WsFrameClass; confident: boolean } | null {
  if (!isRecord(value)) return null;
  const kind: WsKind = 'actioncable';
  const type = typeof value.type === 'string' ? value.type : null;
  if (type && CABLE_CONTROL.has(type) && value.identifier === undefined) {
    return { cls: heartbeat(kind, type), confident: type === 'welcome' || (type === 'ping' && typeof value.message === 'number') };
  }
  if (typeof value.identifier !== 'string') return null;
  const channel = actionCableChannelName(value.identifier);
  if (!channel) return null;
  let event = 'message';
  if (type) event = type;
  else if (typeof value.command === 'string') {
    event = value.command;
    if (value.command === 'message' && typeof value.data === 'string') {
      try {
        const data: unknown = JSON.parse(value.data);
        if (isRecord(data) && name(data.action)) event = name(data.action)!;
      } catch {
        /* keep 'message' */
      }
    }
  } else if (isRecord(value.message)) {
    event = name(value.message.type) ?? name(value.message.action) ?? name(value.message.event) ?? 'message';
  }
  return { cls: { channel, event, kind }, confident: true };
}

// ------------------------------------------------------------------------------------------------- STOMP

/** A parsed STOMP frame. */
export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  bodyStart: number;
  bodyEnd: number;
}

const STOMP_COMMANDS = new Set([
  'CONNECT', 'STOMP', 'CONNECTED', 'SEND', 'SUBSCRIBE', 'UNSUBSCRIBE', 'BEGIN', 'COMMIT', 'ABORT', 'ACK', 'NACK',
  'DISCONNECT', 'MESSAGE', 'RECEIPT', 'ERROR',
]);

/** Parse a STOMP 1.x frame (command line, headers, blank line, body, NUL). Null when it is not one. */
export function parseStomp(text: string): StompFrame | null {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const command = text.slice(0, nl).replace(/\r$/, '');
  if (!STOMP_COMMANDS.has(command)) return null;
  const headers: Record<string, string> = {};
  let i = nl + 1;
  while (i < text.length) {
    let end = text.indexOf('\n', i);
    if (end < 0) end = text.length;
    const line = text.slice(i, end).replace(/\r$/, '');
    i = end + 1;
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon);
      // The first occurrence of a repeated header wins (STOMP 1.2).
      if (!(key in headers)) headers[key] = line.slice(colon + 1);
    }
  }
  const bodyStart = Math.min(i, text.length);
  let bodyEnd = text.indexOf('\0', bodyStart);
  if (bodyEnd < 0) bodyEnd = text.length;
  return { command, headers, bodyStart, bodyEnd };
}

const STOMP_CONTROL = new Set(['CONNECT', 'STOMP', 'CONNECTED', 'DISCONNECT', 'RECEIPT']);

function classifyStomp(text: string, ctx: WsClassifyContext): { cls: WsFrameClass; confident: boolean } | null {
  const kind: WsKind = 'stomp';
  if (/^[\r\n]+$/.test(text)) return ctx.kind === 'stomp' ? { cls: heartbeat(kind, 'heart-beat'), confident: false } : null;
  const f = parseStomp(text);
  if (!f) return null;
  if (STOMP_CONTROL.has(f.command)) return { cls: heartbeat(kind, f.command), confident: true };
  const h = f.headers;
  let channel: string;
  switch (f.command) {
    case 'SUBSCRIBE':
      channel = name(h.destination) ?? '(no destination)';
      if (h.id !== undefined) ctx.stompSubs.set(h.id, channel);
      break;
    case 'UNSUBSCRIBE':
      channel = (h.id !== undefined ? ctx.stompSubs.get(h.id) : undefined) ?? `subscription ${h.id ?? '?'}`;
      break;
    case 'MESSAGE':
      channel = name(h.destination) ?? (h.subscription !== undefined ? ctx.stompSubs.get(h.subscription) : undefined) ?? '(no destination)';
      break;
    case 'SEND':
      channel = name(h.destination) ?? '(no destination)';
      break;
    case 'ERROR':
      channel = 'errors';
      break;
    case 'ACK':
    case 'NACK':
      channel = 'acks';
      break;
    default:
      channel = 'transactions';
  }
  return { cls: { channel, event: f.command, kind, payloadStart: f.bodyStart, payloadEnd: f.bodyEnd }, confident: true };
}

// ------------------------------------------------------------------------------------------------- GraphQL

const GQL_CONTROL = new Set(['connection_init', 'connection_ack', 'connection_error', 'connection_terminate', 'ka', 'ping', 'pong']);
const GQL_START = new Set(['subscribe', 'start']);
const GQL_FOLLOW = new Set(['next', 'data', 'complete', 'stop', 'error']);

/** Operation name of a GraphQL document: explicit, else the first named operation, else null. */
export function graphqlOperationName(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const explicit = name(payload.operationName);
  if (explicit) return explicit;
  if (typeof payload.query !== 'string') return null;
  const m = /\b(subscription|query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(payload.query);
  return m ? m[2]! : null;
}

function classifyGraphql(value: unknown, ctx: WsClassifyContext): { cls: WsFrameClass; confident: boolean } | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const kind: WsKind = 'graphql-ws';
  const type = value.type;
  const known = ctx.kind === 'graphql-ws';
  if (GQL_CONTROL.has(type)) {
    if (!known && type !== 'connection_init' && type !== 'connection_ack' && type !== 'ka') return null;
    return { cls: heartbeat(kind, type), confident: type !== 'ping' && type !== 'pong' };
  }
  const id = name(value.id);
  if (GQL_START.has(type)) {
    if (!id || !isRecord(value.payload) || typeof value.payload.query !== 'string') return null;
    const kindWord = /^\s*(subscription|mutation|query)\b/.exec(value.payload.query)?.[1] ?? 'operation';
    const op = graphqlOperationName(value.payload) ?? `${kindWord} #${id}`;
    ctx.gqlOps.set(id, op);
    return { cls: { channel: op, event: type, kind }, confident: true };
  }
  if (GQL_FOLLOW.has(type) && id) {
    const op = ctx.gqlOps.get(id);
    if (!op && !known) return null;
    return { cls: { channel: op ?? `operation #${id}`, event: type, kind }, confident: !!op };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- generic

const CHANNEL_KEYS = ['channel', 'topic', 'room', 'stream', 'subject', 'destination'];
const EVENT_KEYS = ['event', 'type', 'action', 'op', 'cmd', 'method'];

function compactName(value: unknown): string | null {
  const direct = name(value);
  if (direct) return direct;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value).slice(0, MAX_NAME);
    } catch {
      return null;
    }
  }
  return null;
}

/** Generic JSON: a channel-ish key names the channel, an event-ish key the event. */
export function classifyGenericJson(value: unknown): WsFrameClass {
  if (!isRecord(value)) return { channel: DEFAULT_CHANNEL, kind: 'json' };
  let channel: string | null = null;
  for (const key of CHANNEL_KEYS) {
    if (key in value) {
      channel = compactName(value[key]);
      if (channel) break;
    }
  }
  let event: string | null = null;
  for (const key of EVENT_KEYS) {
    if (key in value) {
      event = name(value[key]);
      if (event) break;
    }
  }
  const keys = Object.keys(value);
  if (
    (event && HEARTBEAT_WORDS.has(event.toLowerCase())) ||
    (keys.length === 1 && HEARTBEAT_WORDS.has(keys[0]!.toLowerCase()))
  ) {
    return heartbeat('json', event ?? keys[0]);
  }
  const cls: WsFrameClass = { channel: channel ?? event ?? DEFAULT_CHANNEL, kind: 'json' };
  if (event) cls.event = event;
  return cls;
}

// ------------------------------------------------------------------------------------------------- entry point

/** The frame fields classification needs. */
export interface ClassifiableFrame {
  opcode: 'text' | 'binary';
  text?: string;
}

type Adapter = (text: string, json: unknown, hasJson: boolean, ctx: WsClassifyContext) => { cls: WsFrameClass; confident: boolean } | null;

const ADAPTERS: Partial<Record<WsKind, Adapter>> = {
  socketio: (text, _json, _has, ctx) => classifySocketIo(text, ctx),
  stomp: (text, _json, _has, ctx) => classifyStomp(text, ctx),
  phoenix: (_text, json, has) => (has ? classifyPhoenix(json) : null),
  actioncable: (_text, json, has) => (has ? classifyActionCable(json) : null),
  'graphql-ws': (_text, json, has, ctx) => (has ? classifyGraphql(json, ctx) : null),
};

/** Order tried when the connection's protocol is not known yet (most distinctive first). */
const DETECT_ORDER: WsKind[] = ['stomp', 'graphql-ws', 'actioncable', 'phoenix', 'socketio'];

/**
 * Channel / event of one frame. Updates `ctx` (sticky protocol on a confident match, graphql operation names,
 * STOMP subscriptions). Frames must be classified in order for the stateful adapters.
 */
export function classifyFrame(frame: ClassifiableFrame, ctx: WsClassifyContext): WsFrameClass {
  if (frame.opcode === 'binary' || frame.text === undefined) {
    if (ctx.kind === 'socketio' && ctx.ioBinaryChannel) {
      const channel = ctx.ioBinaryChannel;
      if (--ctx.ioBinaryPending <= 0) ctx.ioBinaryChannel = null;
      return { channel, event: 'attachment', kind: 'socketio' };
    }
    return { channel: DEFAULT_CHANNEL, kind: ctx.kind === 'json' || !ctx.kind ? 'raw' : ctx.kind };
  }
  const text = frame.text;
  const parsed = tryJson(text);
  const json = parsed.ok ? parsed.value : undefined;
  const order = ctx.kind && ADAPTERS[ctx.kind] ? [ctx.kind, ...DETECT_ORDER.filter((k) => k !== ctx.kind)] : DETECT_ORDER;
  for (const kind of order) {
    // Once a connection's protocol is known, other protocols' adapters must not claim its frames.
    if (ctx.kind && ADAPTERS[ctx.kind] && kind !== ctx.kind) break;
    const result = ADAPTERS[kind]!(text, json, parsed.ok, ctx);
    if (!result) continue;
    if (result.confident && (!ctx.kind || ctx.kind === 'json')) ctx.kind = kind;
    return result.cls;
  }
  if (parsed.ok) {
    if (!ctx.kind) ctx.kind = 'json';
    return classifyGenericJson(json);
  }
  const word = text.trim().toLowerCase();
  if (HEARTBEAT_WORDS.has(word)) return heartbeat('raw', word);
  return { channel: DEFAULT_CHANNEL, kind: 'raw' };
}

/** Display label of a channel key. */
export function channelLabel(channel: string): string {
  return channel === HEARTBEAT_CHANNEL ? 'Heartbeats & control' : channel;
}
