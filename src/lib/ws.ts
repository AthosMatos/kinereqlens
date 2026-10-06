/**
 * WebSocket inspector — data model and pure logic shared by the MAIN-world hook (constants), the content
 * script (validation of untrusted hook events, the recorder with bounded ring buffers) and the panel (the mirror
 * log). Protocol / channel detection lives in ws-protocols.ts, the panel's classified view in ws-inspector.ts.
 *
 * Flow: hook.js wraps `WebSocket` and batches `WsHookEvent`s (≤ 50 ms) to the content script; the top frame's
 * `WsRecorder` validates them (`sanitizeWsEvents`), keeps connections + frames in a `WsLog` (per-connection ring,
 * global caps) and hands `WsDelta`s to the frame host, which streams them to the panel.
 */

import { STACK_MAX_CHARS } from './stack';

// ------------------------------------------------------------------------------------------------- limits

/** Payload bytes kept per frame (text: UTF-8 bytes, binary: raw bytes before base64). */
export const WS_FRAME_CAP = 256 * 1024;
/** Frames kept per connection (oldest dropped first). */
export const WS_FRAMES_PER_CONNECTION = 5000;
/** Frames kept over all connections. */
export const WS_TOTAL_FRAMES = 50_000;
/** Approximate payload memory kept over all connections (UTF-16 chars × 2 / base64 chars). */
export const WS_TOTAL_BYTES = 96 * 1024 * 1024;
/** Connections kept (closed ones are dropped first). */
export const WS_MAX_CONNECTIONS = 200;
/** The hook batches events for at most this long before posting them. */
export const WS_BATCH_MS = 50;
/** Events accepted per hook message. */
export const WS_EVENTS_PER_MESSAGE = 2000;
/** Hook-side queue bound (events waiting for the content script, e.g. while it is still buffering). */
export const WS_HOOK_QUEUE_MAX = 4000;

const MAX_ID = 64;
const MAX_URL = 8192;
const MAX_PROTOCOLS = 32;
const MAX_PROTOCOL = 256;
const MAX_EXTENSIONS = 1024;
const MAX_REASON = 1024;
/** base64 characters of WS_FRAME_CAP bytes. */
const MAX_BASE64 = Math.ceil(WS_FRAME_CAP / 3) * 4;

// ------------------------------------------------------------------------------------------------- types

export type WsDirection = 'out' | 'in';
export type WsOpcode = 'text' | 'binary';
export type WsState = 'connecting' | 'open' | 'closing' | 'closed';

/** One WebSocket the page created (immutable snapshot; replaced on change). */
export interface WsConnection {
  /** Store id: `<frameId>:<hook id>`. */
  wsId: string;
  frameId: number;
  /** URL of the frame that created the socket (subframes). */
  frameUrl?: string;
  url: string;
  /** Sub-protocols the page asked for. */
  protocols: string[];
  /** Negotiated sub-protocol ('' until open / none). */
  protocol: string;
  extensions: string;
  state: WsState;
  /** `new WebSocket()` time (epoch ms). */
  createdAt: number;
  /** Handshake completed ('open' event). */
  openedAt?: number;
  closedAt?: number;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  /** 'error' events seen. */
  errors: number;
  /** Frames / payload bytes ever seen in each direction (including frames evicted from the ring). */
  sent: number;
  received: number;
  bytesSent: number;
  bytesReceived: number;
  /** Time of the latest frame or state change. */
  lastActivity: number;
  /** Call stack of `new WebSocket()` (src/lib/stack.ts), when it was recorded. */
  initiatorStack?: string;
}

/** One message frame (immutable). */
export interface WsFrame {
  /** Increasing over the whole log (store-assigned); also the order of frames. */
  id: number;
  wsId: string;
  dir: WsDirection;
  time: number;
  opcode: WsOpcode;
  /** Text frames. */
  text?: string;
  /** Binary frames (at most WS_FRAME_CAP bytes). */
  base64?: string;
  /** Full payload size in bytes. */
  size: number;
  /** Payload was cut at WS_FRAME_CAP. */
  truncated: boolean;
}

/** Events the MAIN-world hook posts (untrusted: validated by `sanitizeWsEvents`). `id` is the hook's socket id. */
export type WsHookEvent =
  | { e: 'new'; id: string; time: number; url: string; protocols: string[]; frameUrl?: string; initiatorStack?: string }
  | { e: 'open'; id: string; time: number; protocol: string; extensions: string }
  | {
      e: 'frame';
      id: string;
      time: number;
      dir: WsDirection;
      opcode: WsOpcode;
      text?: string;
      base64?: string;
      size: number;
      truncated?: boolean;
    }
  /** The page called close(). */
  | { e: 'closing'; id: string; time: number; code?: number; reason?: string }
  | { e: 'close'; id: string; time: number; code: number; reason: string; wasClean: boolean }
  | { e: 'error'; id: string; time: number };

/**
 * Changes since the previous delta. `reset` replaces everything (clear / initial snapshot); otherwise
 * connections are upserts (full snapshots), frames are appended (ids not seen yet), `removed` connections go.
 */
export interface WsDelta {
  reset?: boolean;
  connections: WsConnection[];
  frames: WsFrame[];
  removed: string[];
}

/** The WebSocket side of the bridge (content script / frame host / panel). */
export interface WsBridge {
  /** Everything currently kept, as a reset delta. */
  snapshot(): WsDelta;
  /** Coalesced change deltas. */
  subscribe(fn: (delta: WsDelta) => void): () => void;
  /** Drop all frames and closed connections (open ones stay listed, counters reset). */
  clear(): void;
  /** Send a text message through the page's own socket (top-frame sockets only; explicit user action). */
  send(wsId: string, text: string): Promise<WsSendResult>;
}

export interface WsSendResult {
  ok: boolean;
  error?: string;
}

// ------------------------------------------------------------------------------------------------- validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const HOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** True for socket ids the hook may use. */
export function isWsHookId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID && HOOK_ID.test(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** Cut text to about `cap` UTF-8 bytes (by UTF-16 units, never inside a surrogate pair). */
export function capWsText(text: string, cap = WS_FRAME_CAP): { text: string; truncated: boolean } {
  if (text.length <= cap / 3 || utf8Length(text) <= cap) return { text, truncated: false };
  // Binary search would be exact; a linear walk is fine for ≤ a few MB and keeps whole characters.
  let bytes = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (bytes + w > cap) break;
    bytes += w;
    if (w === 4) i++;
  }
  return { text: text.slice(0, i), truncated: true };
}

/** UTF-8 byte length (lone surrogates count 3). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function sanitizeFrameEvent(value: Record<string, unknown>, id: string, time: number): WsHookEvent | null {
  const dir = value.dir === 'out' || value.dir === 'in' ? value.dir : null;
  const opcode = value.opcode === 'text' || value.opcode === 'binary' ? value.opcode : null;
  if (!dir || !opcode) return null;
  let truncated = value.truncated === true;
  const declared = finite(value.size) && value.size >= 0 ? Math.floor(value.size) : 0;
  if (opcode === 'text') {
    if (typeof value.text !== 'string') return null;
    const capped = capWsText(value.text);
    truncated = truncated || capped.truncated;
    const size = Math.max(declared, capped.truncated ? 0 : utf8Length(capped.text));
    return { e: 'frame', id, time, dir, opcode, text: capped.text, size, truncated };
  }
  if (typeof value.base64 !== 'string') return null;
  let base64 = value.base64;
  if (base64.length > MAX_BASE64) {
    base64 = base64.slice(0, MAX_BASE64);
    truncated = true;
  }
  if (!BASE64.test(base64) || base64.length % 4 !== 0) return null;
  const bytes = (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  return { e: 'frame', id, time, dir, opcode, base64, size: Math.max(declared, bytes), truncated };
}

/** One validated hook event, or null. Fields are re-created (no foreign properties survive). */
export function sanitizeWsEvent(value: unknown): WsHookEvent | null {
  if (!isRecord(value) || !isWsHookId(value.id) || !finite(value.time)) return null;
  const { id, time } = value;
  switch (value.e) {
    case 'new': {
      if (typeof value.url !== 'string') return null;
      const protocols = Array.isArray(value.protocols)
        ? value.protocols
            .slice(0, MAX_PROTOCOLS)
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.slice(0, MAX_PROTOCOL))
        : [];
      const event: WsHookEvent = { e: 'new', id, time, url: value.url.slice(0, MAX_URL), protocols };
      const frameUrl = boundedString(value.frameUrl, MAX_URL);
      if (frameUrl) event.frameUrl = frameUrl;
      const stack = boundedString(value.initiatorStack, STACK_MAX_CHARS);
      if (stack) event.initiatorStack = stack;
      return event;
    }
    case 'open':
      return {
        e: 'open',
        id,
        time,
        protocol: boundedString(value.protocol, MAX_PROTOCOL) ?? '',
        extensions: boundedString(value.extensions, MAX_EXTENSIONS) ?? '',
      };
    case 'frame':
      return sanitizeFrameEvent(value, id, time);
    case 'closing': {
      const event: WsHookEvent = { e: 'closing', id, time };
      if (finite(value.code) && Number.isInteger(value.code)) event.code = value.code;
      const reason = boundedString(value.reason, MAX_REASON);
      if (reason !== undefined) event.reason = reason;
      return event;
    }
    case 'close':
      return {
        e: 'close',
        id,
        time,
        code: finite(value.code) && Number.isInteger(value.code) ? value.code : 1005,
        reason: boundedString(value.reason, MAX_REASON) ?? '',
        wasClean: value.wasClean === true,
      };
    case 'error':
      return { e: 'error', id, time };
    default:
      return null;
  }
}

/** Validated events of one hook message (untrusted MAIN-world data), at most WS_EVENTS_PER_MESSAGE. */
export function sanitizeWsEvents(value: unknown): WsHookEvent[] {
  if (!Array.isArray(value)) return [];
  const out: WsHookEvent[] = [];
  for (const item of value.slice(0, WS_EVENTS_PER_MESSAGE)) {
    const event = sanitizeWsEvent(item);
    if (event) out.push(event);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- log

/** Size limits of a WsLog. */
export interface WsLimits {
  perConnection: number;
  totalFrames: number;
  totalBytes: number;
  maxConnections: number;
}

export const DEFAULT_WS_LIMITS: WsLimits = {
  perConnection: WS_FRAMES_PER_CONNECTION,
  totalFrames: WS_TOTAL_FRAMES,
  totalBytes: WS_TOTAL_BYTES,
  maxConnections: WS_MAX_CONNECTIONS,
};

/** Approximate memory of a frame's payload. */
export function frameBytes(frame: WsFrame): number {
  return 96 + (frame.text !== undefined ? frame.text.length * 2 : 0) + (frame.base64?.length ?? 0);
}

interface Slot {
  conn: WsConnection;
  /** frames[start..] are live (lazy compaction keeps eviction O(1) amortized). */
  frames: WsFrame[];
  start: number;
  /** Bumped on every frame change of this connection. */
  version: number;
  lastId: number;
  view: WsFrame[] | null;
}

/** Hooks a WsLog calls when frames or connections leave it (used for derived stats). */
export interface WsLogListener {
  evicted?(frames: WsFrame[]): void;
  removed?(wsId: string): void;
}

/**
 * Connections + per-connection frame rings with global caps. Frames of a connection are kept in id order;
 * appending a frame whose id is not newer than the connection's last one is ignored (idempotent replays).
 */
export class WsLog {
  private readonly slots = new Map<string, Slot>();
  private list: WsConnection[] | null = null;
  private frameCount = 0;
  private byteCount = 0;
  /** Bumped on every change. */
  version = 0;

  constructor(
    private readonly limits: WsLimits = DEFAULT_WS_LIMITS,
    private readonly listener: WsLogListener = {},
  ) {}

  get size(): number {
    return this.slots.size;
  }

  get totalFrames(): number {
    return this.frameCount;
  }

  get totalBytes(): number {
    return this.byteCount;
  }

  getConnection(wsId: string): WsConnection | undefined {
    return this.slots.get(wsId)?.conn;
  }

  /** Connections in creation order (identity-stable until a connection changes). */
  connections(): WsConnection[] {
    if (!this.list) this.list = Array.from(this.slots.values(), (s) => s.conn);
    return this.list;
  }

  /** Frames of a connection, oldest first (identity-stable until they change). */
  frames(wsId: string): readonly WsFrame[] {
    const slot = this.slots.get(wsId);
    if (!slot) return EMPTY_FRAMES;
    if (!slot.view) slot.view = slot.start === 0 ? slot.frames.slice() : slot.frames.slice(slot.start);
    return slot.view;
  }

  /** Changes whenever the frames of `wsId` change. */
  frameVersion(wsId: string): number {
    return this.slots.get(wsId)?.version ?? -1;
  }

  /** Insert or replace a connection snapshot. */
  upsert(conn: WsConnection): void {
    const slot = this.slots.get(conn.wsId);
    if (slot) {
      if (slot.conn === conn) return;
      slot.conn = conn;
    } else {
      this.slots.set(conn.wsId, { conn, frames: [], start: 0, version: 0, lastId: -1, view: null });
      this.enforceConnections();
    }
    this.list = null;
    this.version++;
  }

  /** Append a frame of a known connection. Returns false when ignored (unknown connection / not newer). */
  append(frame: WsFrame): boolean {
    const slot = this.slots.get(frame.wsId);
    if (!slot || frame.id <= slot.lastId) return false;
    slot.frames.push(frame);
    slot.lastId = frame.id;
    slot.version++;
    slot.view = null;
    this.frameCount++;
    this.byteCount += frameBytes(frame);
    this.version++;
    const live = slot.frames.length - slot.start;
    // Evict in small batches (~2 %) so a busy socket does not shift its ring on every frame.
    if (live > this.limits.perConnection) {
      const slack = Math.max(1, Math.floor(this.limits.perConnection / 50));
      this.evictFrom(slot, Math.min(live, live - this.limits.perConnection + slack - 1));
    }
    if (this.frameCount > this.limits.totalFrames || this.byteCount > this.limits.totalBytes) this.evictGlobal();
    return true;
  }

  /** Remove a connection and its frames. */
  remove(wsId: string): boolean {
    const slot = this.slots.get(wsId);
    if (!slot) return false;
    for (let i = slot.start; i < slot.frames.length; i++) this.byteCount -= frameBytes(slot.frames[i]!);
    this.frameCount -= slot.frames.length - slot.start;
    this.slots.delete(wsId);
    this.list = null;
    this.version++;
    this.listener.removed?.(wsId);
    return true;
  }

  /** Drop the frames of a connection (it stays listed). */
  clearFrames(wsId: string): void {
    const slot = this.slots.get(wsId);
    if (!slot || slot.frames.length === slot.start) return;
    this.evictFrom(slot, slot.frames.length - slot.start);
  }

  clear(): void {
    if (this.slots.size === 0) return;
    for (const wsId of [...this.slots.keys()]) this.remove(wsId);
    this.frameCount = 0;
    this.byteCount = 0;
  }

  private evictFrom(slot: Slot, count: number): void {
    if (count <= 0) return;
    const end = Math.min(slot.frames.length, slot.start + count);
    const gone = slot.frames.slice(slot.start, end);
    for (const f of gone) this.byteCount -= frameBytes(f);
    this.frameCount -= gone.length;
    slot.start = end;
    if (slot.start > 1024 && slot.start * 2 > slot.frames.length) {
      slot.frames = slot.frames.slice(slot.start);
      slot.start = 0;
    }
    slot.version++;
    slot.view = null;
    this.version++;
    if (gone.length) this.listener.evicted?.(gone);
  }

  /** Over a global cap: drop the oldest frames (lowest ids) across connections down to ~98 % of the caps. */
  private evictGlobal(): void {
    const frameGoal = Math.floor(this.limits.totalFrames * 0.98);
    const byteGoal = Math.floor(this.limits.totalBytes * 0.98);
    while (this.frameCount > frameGoal || this.byteCount > byteGoal) {
      let oldest: Slot | null = null;
      for (const slot of this.slots.values()) {
        if (slot.start >= slot.frames.length) continue;
        if (!oldest || slot.frames[slot.start]!.id < oldest.frames[oldest.start]!.id) oldest = slot;
      }
      if (!oldest) break;
      // Take a run of this connection's frames that are older than every other connection's head.
      let limit = Infinity;
      for (const slot of this.slots.values()) {
        if (slot === oldest || slot.start >= slot.frames.length) continue;
        limit = Math.min(limit, slot.frames[slot.start]!.id);
      }
      let n = 0;
      let bytes = 0;
      for (let i = oldest.start; i < oldest.frames.length && oldest.frames[i]!.id < limit; i++) {
        n++;
        bytes += frameBytes(oldest.frames[i]!);
        if (this.frameCount - n <= frameGoal && this.byteCount - bytes <= byteGoal) break;
      }
      this.evictFrom(oldest, Math.max(1, n));
    }
  }

  /** Over the connection cap: drop the oldest closed connections first, then the oldest ones. */
  private enforceConnections(): void {
    while (this.slots.size > this.limits.maxConnections) {
      let victim: string | null = null;
      for (const [wsId, slot] of this.slots) {
        if (slot.conn.state === 'closed') {
          victim = wsId;
          break;
        }
      }
      if (victim === null) victim = this.slots.keys().next().value ?? null;
      if (victim === null) break;
      this.remove(victim);
    }
  }
}

const EMPTY_FRAMES: readonly WsFrame[] = Object.freeze([]) as readonly WsFrame[];

// ------------------------------------------------------------------------------------------------- recorder

/** Options of one batch of hook events. */
export interface WsApplyOptions {
  /** Capture is on (open && recording): new connections and frames are accepted. */
  capturing: boolean;
  /** URL of the frame the events came from (subframes, from the worker relay). */
  frameUrl?: string;
}

/**
 * Content-script side: turns validated hook events into log changes and a delta journal for subscribers.
 * Lifecycle events (open / closing / close / error) of known connections are applied even while capture is
 * off, so a paused overlay does not leave sockets "open" forever.
 */
export class WsRecorder {
  readonly log: WsLog;
  private nextId = 1;
  private dirty = new Set<string>();
  private newFrames: WsFrame[] = [];
  private removedIds = new Set<string>();
  private resetPending = false;

  constructor(limits: WsLimits = DEFAULT_WS_LIMITS) {
    this.log = new WsLog(limits, {
      removed: (wsId) => {
        this.removedIds.add(wsId);
        this.dirty.delete(wsId);
      },
    });
  }

  /** True when there are changes no delta has carried yet. */
  get hasChanges(): boolean {
    return this.resetPending || this.dirty.size > 0 || this.newFrames.length > 0 || this.removedIds.size > 0;
  }

  /** Apply untrusted events from frame `frameId` (validated here). Returns true when something changed. */
  apply(frameId: number, raw: unknown, options: WsApplyOptions): boolean {
    if (!Number.isInteger(frameId) || frameId < 0) return false;
    const events = sanitizeWsEvents(raw);
    let changed = false;
    const touched = new Map<string, WsConnection>();
    const current = (wsId: string): WsConnection | undefined => touched.get(wsId) ?? this.log.getConnection(wsId);
    for (const event of events) {
      const wsId = `${frameId}:${event.id}`;
      if (event.e === 'new') {
        if (!options.capturing || current(wsId)) continue;
        const conn: WsConnection = {
          wsId,
          frameId,
          url: event.url,
          protocols: event.protocols,
          protocol: '',
          extensions: '',
          state: 'connecting',
          createdAt: event.time,
          errors: 0,
          sent: 0,
          received: 0,
          bytesSent: 0,
          bytesReceived: 0,
          lastActivity: event.time,
        };
        const frameUrl = event.frameUrl ?? (frameId !== 0 ? options.frameUrl : undefined);
        if (frameUrl && frameId !== 0) conn.frameUrl = frameUrl;
        if (event.initiatorStack) conn.initiatorStack = event.initiatorStack;
        // Registered at once so its frames of this same batch find it.
        this.log.upsert(conn);
        touched.set(wsId, conn);
        this.dirty.add(wsId);
        changed = true;
        continue;
      }
      const conn = current(wsId);
      if (!conn) continue;
      let next: WsConnection | null = null;
      switch (event.e) {
        case 'open':
          if (conn.state === 'connecting') {
            next = { ...conn, state: 'open', openedAt: event.time, protocol: event.protocol, extensions: event.extensions, lastActivity: event.time };
          }
          break;
        case 'closing':
          if (conn.state === 'connecting' || conn.state === 'open') {
            next = { ...conn, state: 'closing', lastActivity: event.time };
            if (event.code !== undefined) next.closeCode = event.code;
            if (event.reason !== undefined) next.closeReason = event.reason;
          }
          break;
        case 'close':
          if (conn.state !== 'closed') {
            next = {
              ...conn,
              state: 'closed',
              closedAt: event.time,
              closeCode: event.code,
              closeReason: event.reason,
              wasClean: event.wasClean,
              lastActivity: event.time,
            };
          }
          break;
        case 'error':
          next = { ...conn, errors: conn.errors + 1, lastActivity: event.time };
          break;
        case 'frame': {
          if (!options.capturing || conn.state === 'closed') break;
          const frame: WsFrame = {
            id: this.nextId++,
            wsId,
            dir: event.dir,
            time: event.time,
            opcode: event.opcode,
            size: event.size,
            truncated: event.truncated === true,
          };
          if (event.text !== undefined) frame.text = event.text;
          if (event.base64 !== undefined) frame.base64 = event.base64;
          next =
            event.dir === 'out'
              ? { ...conn, sent: conn.sent + 1, bytesSent: conn.bytesSent + event.size, lastActivity: event.time }
              : { ...conn, received: conn.received + 1, bytesReceived: conn.bytesReceived + event.size, lastActivity: event.time };
          // The connection snapshot goes first so the frame finds it.
          this.log.upsert(next);
          if (this.log.append(frame)) this.newFrames.push(frame);
          break;
        }
      }
      if (next) {
        touched.set(wsId, next);
        this.log.upsert(next);
        this.dirty.add(wsId);
        changed = true;
      }
    }
    return changed;
  }

  /** Changes since the last delta (null when none). */
  takeDelta(): WsDelta | null {
    if (!this.hasChanges) return null;
    const delta: WsDelta = this.resetPending
      ? this.snapshot()
      : {
          connections: [...this.dirty].map((id) => this.log.getConnection(id)).filter((c): c is WsConnection => !!c),
          frames: this.newFrames,
          removed: [...this.removedIds],
        };
    this.dirty = new Set();
    this.newFrames = [];
    this.removedIds = new Set();
    this.resetPending = false;
    return delta;
  }

  /** Everything kept, as a reset delta. */
  snapshot(): WsDelta {
    const connections = this.log.connections().slice();
    const frames: WsFrame[] = [];
    for (const conn of connections) for (const frame of this.log.frames(conn.wsId)) frames.push(frame);
    frames.sort((a, b) => a.id - b.id);
    return { reset: true, connections, frames, removed: [] };
  }

  /** Drop all frames and closed connections; live ones stay with zeroed counters. */
  clear(): void {
    for (const conn of [...this.log.connections()]) {
      if (conn.state === 'closed') this.log.remove(conn.wsId);
      else {
        this.log.clearFrames(conn.wsId);
        this.log.upsert({ ...conn, sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, errors: 0 });
      }
    }
    this.resetPending = true;
  }
}

// ------------------------------------------------------------------------------------------------- mirror

/**
 * Apply a delta to a mirror log (the panel). Returns true when something changed. Connections are applied
 * before frames, so frames of a connection in the same delta find it.
 */
export function applyWsDelta(log: WsLog, delta: WsDelta): boolean {
  if (!isRecord(delta)) return false;
  let changed = false;
  if (delta.reset === true && log.size > 0) {
    log.clear();
    changed = true;
  }
  for (const conn of Array.isArray(delta.connections) ? delta.connections : []) {
    if (!isRecord(conn) || typeof conn.wsId !== 'string') continue;
    log.upsert(conn);
    changed = true;
  }
  for (const frame of Array.isArray(delta.frames) ? delta.frames : []) {
    if (!isRecord(frame) || typeof frame.wsId !== 'string' || !finite(frame.id)) continue;
    if (log.append(frame)) changed = true;
  }
  for (const wsId of Array.isArray(delta.removed) ? delta.removed : []) {
    if (typeof wsId === 'string' && log.remove(wsId)) changed = true;
  }
  return changed;
}

/** Split a delta into messages of at most `maxFrames` frames / ~`maxBytes` payload (first one carries the rest). */
export function chunkWsDelta(delta: WsDelta, maxFrames = 2000, maxBytes = 16 * 1024 * 1024): WsDelta[] {
  if (delta.frames.length <= maxFrames && delta.frames.reduce((n, f) => n + frameBytes(f), 0) <= maxBytes) return [delta];
  const chunks: WsDelta[] = [];
  let current: WsFrame[] = [];
  let bytes = 0;
  const flush = () => {
    const first = chunks.length === 0;
    chunks.push(
      first
        ? { ...(delta.reset ? { reset: true } : {}), connections: delta.connections, frames: current, removed: [] }
        : { connections: [], frames: current, removed: [] },
    );
    current = [];
    bytes = 0;
  };
  for (const frame of delta.frames) {
    const size = frameBytes(frame);
    if (current.length > 0 && (current.length >= maxFrames || bytes + size > maxBytes)) flush();
    current.push(frame);
    bytes += size;
  }
  flush();
  // Removals last, after every frame was delivered.
  chunks[chunks.length - 1]!.removed = delta.removed;
  return chunks;
}

/** Display state of a connection's lifetime in ms (until now when still open). */
export function connectionDuration(conn: WsConnection, now: number): number {
  const start = conn.openedAt ?? conn.createdAt;
  const end = conn.closedAt ?? now;
  return Math.max(0, end - start);
}
