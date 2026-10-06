/**
 * Panel-side WebSocket model: a mirror WsLog fed with WsDeltas, every frame classified once on arrival
 * (ws-protocols.ts), per-connection channel stats kept incrementally (also on eviction), plus the pure filter /
 * preview helpers of the messages pane.
 */
import type { WsConnection, WsDelta, WsFrame, WsLimits } from './ws';
import { DEFAULT_WS_LIMITS, WsLog } from './ws';
import type { WsClassifyContext, WsFrameClass, WsKind } from './ws-protocols';
import { classifyFrame, createClassifyContext, HEARTBEAT_CHANNEL, protocolHint } from './ws-protocols';

/** Stats of one detected channel of a connection. */
export interface WsChannelStats {
  key: string;
  kind: WsKind;
  heartbeat: boolean;
  sent: number;
  received: number;
  /** Frames currently kept (sent + received). */
  count: number;
  lastTime: number;
  lastId: number;
  /** Order of first appearance. */
  order: number;
}

interface ConnModel {
  ctx: WsClassifyContext;
  channels: Map<string, WsChannelStats>;
  list: WsChannelStats[] | null;
  /** Kinds seen on non-heartbeat frames (for the badge when no protocol is sticky). */
  kinds: Map<WsKind, number>;
  heartbeats: number;
  nextOrder: number;
}

const FALLBACK: WsFrameClass = { channel: 'messages', kind: 'raw' };

/** Mirror of the page's WebSocket log with channel detection. */
export class WsInspector {
  readonly log: WsLog;
  private readonly models = new Map<string, ConnModel>();
  private readonly infos = new WeakMap<WsFrame, WsFrameClass>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  /** Bumped on every change. */
  version = 0;

  constructor(limits: WsLimits = DEFAULT_WS_LIMITS) {
    this.log = new WsLog(limits, {
      evicted: (frames) => {
        for (const frame of frames) this.uncount(frame);
      },
      removed: (wsId) => {
        this.models.delete(wsId);
      },
    });
  }

  /** Apply a delta from the host. Returns true when something changed (listeners are notified, coalesced). */
  apply(delta: WsDelta): boolean {
    if (!delta || typeof delta !== 'object') return false;
    let changed = false;
    if (delta.reset === true && (this.log.size > 0 || this.models.size > 0)) {
      this.log.clear();
      this.models.clear();
      changed = true;
    }
    for (const conn of Array.isArray(delta.connections) ? delta.connections : []) {
      if (!conn || typeof conn.wsId !== 'string') continue;
      this.log.upsert(conn);
      const model = this.models.get(conn.wsId);
      if (!model) this.models.set(conn.wsId, newModel(conn));
      else if (!model.ctx.kind || model.ctx.kind === 'json') {
        const hint = protocolHint(conn.url, conn.protocols, conn.protocol);
        if (hint) model.ctx.kind = hint;
      }
      changed = true;
    }
    for (const frame of Array.isArray(delta.frames) ? delta.frames : []) {
      if (!frame || typeof frame.wsId !== 'string' || typeof frame.id !== 'number') continue;
      if (!this.log.append(frame)) continue;
      // Appending may have evicted it already (tiny limits); classify anyway so state stays in order.
      this.classify(frame);
      changed = true;
    }
    for (const wsId of Array.isArray(delta.removed) ? delta.removed : []) {
      if (typeof wsId === 'string' && this.log.remove(wsId)) changed = true;
    }
    if (changed) this.changed();
    return changed;
  }

  /** Change notifications (one per microtask). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  connections(): WsConnection[] {
    return this.log.connections();
  }

  frames(wsId: string): readonly WsFrame[] {
    return this.log.frames(wsId);
  }

  /** Channel / event of a frame. */
  info(frame: WsFrame): WsFrameClass {
    return this.infos.get(frame) ?? FALLBACK;
  }

  /** Channels of a connection: by first appearance, heartbeats last. */
  channels(wsId: string): WsChannelStats[] {
    const model = this.models.get(wsId);
    if (!model) return [];
    if (!model.list) {
      model.list = [...model.channels.values()]
        .filter((c) => c.count > 0)
        .sort((a, b) => (a.heartbeat === b.heartbeat ? a.order - b.order : a.heartbeat ? 1 : -1));
    }
    return model.list;
  }

  /** Detected protocol of a connection (null when nothing was seen yet). */
  protocolOf(wsId: string): WsKind | null {
    const model = this.models.get(wsId);
    if (!model) return null;
    if (model.ctx.kind && model.ctx.kind !== 'json') return model.ctx.kind;
    let best: WsKind | null = null;
    let n = 0;
    for (const [kind, count] of model.kinds) {
      if (count > n) {
        best = kind;
        n = count;
      }
    }
    return best ?? model.ctx.kind;
  }

  /** Heartbeat / control frames currently kept for a connection. */
  heartbeatCount(wsId: string): number {
    return this.models.get(wsId)?.heartbeats ?? 0;
  }

  /** Total frames currently kept. */
  get totalFrames(): number {
    return this.log.totalFrames;
  }

  private classify(frame: WsFrame): void {
    let model = this.models.get(frame.wsId);
    if (!model) {
      const conn = this.log.getConnection(frame.wsId);
      if (!conn) return;
      model = newModel(conn);
      this.models.set(frame.wsId, model);
    }
    let cls: WsFrameClass;
    try {
      cls = classifyFrame(frame, model.ctx);
    } catch {
      cls = FALLBACK;
    }
    this.infos.set(frame, cls);
    let stats = model.channels.get(cls.channel);
    if (!stats) {
      stats = {
        key: cls.channel,
        kind: cls.kind,
        heartbeat: cls.channel === HEARTBEAT_CHANNEL,
        sent: 0,
        received: 0,
        count: 0,
        lastTime: 0,
        lastId: 0,
        order: model.nextOrder++,
      };
      model.channels.set(cls.channel, stats);
    }
    const next = { ...stats };
    if (frame.dir === 'out') next.sent++;
    else next.received++;
    next.count++;
    next.lastTime = frame.time;
    next.lastId = frame.id;
    model.channels.set(cls.channel, next);
    model.list = null;
    if (cls.heartbeat) model.heartbeats++;
    else model.kinds.set(cls.kind, (model.kinds.get(cls.kind) ?? 0) + 1);
  }

  private uncount(frame: WsFrame): void {
    const model = this.models.get(frame.wsId);
    const cls = this.infos.get(frame);
    if (!model || !cls) return;
    const stats = model.channels.get(cls.channel);
    if (stats) {
      const next = { ...stats, count: Math.max(0, stats.count - 1) };
      if (frame.dir === 'out') next.sent = Math.max(0, next.sent - 1);
      else next.received = Math.max(0, next.received - 1);
      model.channels.set(cls.channel, next);
      model.list = null;
    }
    if (cls.heartbeat) model.heartbeats = Math.max(0, model.heartbeats - 1);
    else model.kinds.set(cls.kind, Math.max(0, (model.kinds.get(cls.kind) ?? 1) - 1));
  }

  private changed(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch {
          /* a failing view must not starve the others */
        }
      }
    });
  }
}

function newModel(conn: WsConnection): ConnModel {
  return {
    ctx: createClassifyContext(protocolHint(conn.url, conn.protocols, conn.protocol)),
    channels: new Map(),
    list: null,
    kinds: new Map(),
    heartbeats: 0,
    nextOrder: 0,
  };
}

// ------------------------------------------------------------------------------------------------- payload

/** The payload text of a text frame (Socket.IO prefix / STOMP headers stripped). */
export function payloadText(frame: WsFrame, cls: WsFrameClass): string {
  if (frame.text === undefined) return '';
  if (cls.payloadStart === undefined && cls.payloadEnd === undefined) return frame.text;
  return frame.text.slice(cls.payloadStart ?? 0, cls.payloadEnd ?? frame.text.length);
}

const parsedCache = new WeakMap<WsFrame, { ok: boolean; value: unknown }>();

/** JSON value of a frame's payload (cached), or undefined when it is not JSON. */
export function payloadJson(frame: WsFrame, cls: WsFrameClass): unknown {
  let cached = parsedCache.get(frame);
  if (!cached) {
    const text = payloadText(frame, cls).trim();
    cached = { ok: false, value: undefined };
    if (text && (text[0] === '{' || text[0] === '[' || text[0] === '"')) {
      try {
        cached = { ok: true, value: JSON.parse(text) };
      } catch {
        /* not JSON */
      }
    }
    parsedCache.set(frame, cached);
  }
  return cached.ok ? cached.value : undefined;
}

const PREVIEW_MAX = 240;
const previewCache = new WeakMap<WsFrame, string>();

/** First bytes of base64 as "89 50 4e 47". */
export function base64HeadHex(base64: string, count = 8): string {
  try {
    const bin = atob(base64.slice(0, Math.ceil(count / 3) * 4 + 4));
    let out = '';
    for (let i = 0; i < Math.min(count, bin.length); i++) out += (i ? ' ' : '') + bin.charCodeAt(i).toString(16).padStart(2, '0');
    return out;
  } catch {
    return '';
  }
}

/** One-line preview of a frame (Socket.IO: the event's arguments). */
export function framePreview(frame: WsFrame, cls: WsFrameClass): string {
  const cached = previewCache.get(frame);
  if (cached !== undefined) return cached;
  let text: string;
  if (frame.opcode === 'binary' || frame.text === undefined) {
    const head = frame.base64 ? base64HeadHex(frame.base64) : '';
    text = head ? `${head}${frame.size > 8 ? ' …' : ''}` : '(empty)';
  } else {
    text = payloadText(frame, cls);
    if (cls.kind === 'socketio' && cls.payloadStart !== undefined && cls.event && cls.event !== 'attachment') {
      const value = payloadJson(frame, cls);
      if (Array.isArray(value) && typeof value[0] === 'string' && !cls.channel.endsWith('acks')) {
        const args = value.slice(1);
        try {
          text = args.length === 0 ? '' : JSON.stringify(args.length === 1 ? args[0] : args);
        } catch {
          /* keep the raw text */
        }
      }
    }
    if (text.length > PREVIEW_MAX * 4) text = text.slice(0, PREVIEW_MAX * 4);
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > PREVIEW_MAX) text = `${text.slice(0, PREVIEW_MAX)}…`;
    if (!text) text = frame.text === '' ? '(empty)' : '';
  }
  previewCache.set(frame, text);
  return text;
}

// ------------------------------------------------------------------------------------------------- filter

export type WsDirFilter = 'all' | 'out' | 'in';

/** Filter of the messages pane. */
export interface WsFilter {
  text: string;
  dir: WsDirFilter;
  heartbeats: boolean;
  /** null = all channels of the connection. */
  channel: string | null;
}

export type JsonPathSegment = string | number;

/** A parsed filter: plain terms (all must match; `-term` excludes) or a JSON path test. */
export type ParsedWsFilter =
  | { type: 'none' }
  | { type: 'text'; include: string[]; exclude: string[] }
  | { type: 'path'; path: JsonPathSegment[]; op: 'exists' | '=' | '!=' | '~'; value: string }
  | { type: 'invalid'; error: string };

/** Parse `$.a.b[0].c`, `.type = update`, `$.user.name ~ ali` — or plain text terms. */
export function parseWsFilter(text: string): ParsedWsFilter {
  const t = text.trim();
  if (!t) return { type: 'none' };
  if (t[0] === '$' || (t[0] === '.' && /^\.[A-Za-z_$[]/.test(t))) {
    const m = /^(.*?)\s*(!=|=|~)\s*(.*)$/.exec(t);
    const pathText = m ? m[1]! : t;
    const path = parseJsonPath(pathText);
    if (!path) return { type: 'invalid', error: 'Invalid JSON path (e.g. $.data.id = 42)' };
    if (!m) return { type: 'path', path, op: 'exists', value: '' };
    return { type: 'path', path, op: m[2] as '=' | '!=' | '~', value: unquote(m[3]!.trim()) };
  }
  const include: string[] = [];
  const exclude: string[] = [];
  for (const term of t.toLowerCase().split(/\s+/)) {
    if (term.length > 1 && term[0] === '-') exclude.push(term.slice(1));
    else if (term) include.push(term);
  }
  return { type: 'text', include, exclude };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** `$.a.b[0]["c d"]` → ['a', 'b', 0, 'c d']; null when malformed. */
export function parseJsonPath(text: string): JsonPathSegment[] | null {
  let s = text.trim();
  if (s.startsWith('$')) s = s.slice(1);
  const out: JsonPathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') {
      const m = /^[A-Za-z0-9_$-]+/.exec(s.slice(i + 1));
      if (!m) return null;
      out.push(/^\d+$/.test(m[0]) ? Number(m[0]) : m[0]);
      i += 1 + m[0].length;
    } else if (s[i] === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) return null;
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (/^(['"]).*\1$/.test(inner)) out.push(inner.slice(1, -1));
      else if (inner === '*') out.push('*');
      else return null;
      i = close + 1;
    } else return null;
  }
  return out;
}

/** Values at `path` (`*` fans out over arrays / objects). */
export function valuesAtPath(value: unknown, path: readonly JsonPathSegment[]): unknown[] {
  let current: unknown[] = [value];
  for (const seg of path) {
    const next: unknown[] = [];
    for (const v of current) {
      if (seg === '*') {
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === 'object') next.push(...Object.values(v));
      } else if (Array.isArray(v) && typeof seg === 'number') {
        if (seg < v.length) next.push(v[seg]);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, String(seg))) {
        next.push((v as Record<string, unknown>)[String(seg)]);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Does one frame pass a parsed filter? */
export function frameMatches(frame: WsFrame, cls: WsFrameClass, parsed: ParsedWsFilter): boolean {
  switch (parsed.type) {
    case 'none':
      return true;
    case 'invalid':
      return true;
    case 'text': {
      const hay = `${cls.event ?? ''}\n${cls.channel}\n${frame.text ?? framePreview(frame, cls)}`.toLowerCase();
      for (const term of parsed.include) if (!hay.includes(term)) return false;
      for (const term of parsed.exclude) if (hay.includes(term)) return false;
      return true;
    }
    case 'path': {
      const value = payloadJson(frame, cls);
      if (value === undefined) return false;
      // Socket.IO events: paths address the event's first argument when they do not start with an index.
      const roots: unknown[] = [value];
      if (cls.kind === 'socketio' && Array.isArray(value) && typeof parsed.path[0] !== 'number') roots.unshift(value[1]);
      for (const root of roots) {
        const found = valuesAtPath(root, parsed.path);
        if (found.length === 0) continue;
        if (parsed.op === 'exists') return true;
        const texts = found.map(scalarText);
        if (parsed.op === '=' && texts.some((t) => t === parsed.value)) return true;
        if (parsed.op === '!=' && texts.every((t) => t !== parsed.value)) return true;
        if (parsed.op === '~' && texts.some((t) => t.toLowerCase().includes(parsed.value.toLowerCase()))) return true;
      }
      return false;
    }
  }
}

/** Frames of a connection passing the filter (same array when nothing filters). */
export function filterFrames(
  frames: readonly WsFrame[],
  info: (frame: WsFrame) => WsFrameClass,
  filter: WsFilter,
  parsed: ParsedWsFilter = parseWsFilter(filter.text),
): readonly WsFrame[] {
  const textFilter = parsed.type === 'text' || parsed.type === 'path';
  if (filter.dir === 'all' && filter.heartbeats && filter.channel === null && !textFilter) return frames;
  const out: WsFrame[] = [];
  for (const frame of frames) {
    if (filter.dir !== 'all' && frame.dir !== filter.dir) continue;
    const cls = info(frame);
    if (filter.channel !== null) {
      if (cls.channel !== filter.channel) continue;
    } else if (!filter.heartbeats && cls.heartbeat) continue;
    if (textFilter && !frameMatches(frame, cls, parsed)) continue;
    out.push(frame);
  }
  return out;
}
