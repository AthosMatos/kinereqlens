/**
 * kineReqLens React Native wire protocol, version 1 (documented in ../PROTOCOL.md).
 *
 * One WebSocket per app JS context, from the app (client) to the receiver (server, default
 * ws://<host>:8790/kinereqlens). Every WebSocket message is one UTF-8 JSON object with a `t` (type) field.
 *
 * The data shapes mirror the extension's contracts in src/shared/types.ts (HookRequestStart / HookRequestEnd /
 * SerializedBody / ReplayRequest / ReplayResult). They are copied (not imported) so this package stays
 * standalone: keep them in sync when the extension's types change.
 *
 * Everything here is type-only except a few constants and the defensive message parsers.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8790;
export const DEFAULT_PATH = '/kinereqlens';

/** WebSocket close codes used by the receiver (4000-4999 = application defined). */
export const CLOSE_CODES = {
  /** Pairing token missing or wrong. The client keeps retrying at its slowest backoff. */
  BAD_TOKEN: 4001,
  /** Unsupported protocol version or malformed handshake. */
  BAD_HANDSHAKE: 4002,
  /** No `hello` within the handshake timeout. */
  HANDSHAKE_TIMEOUT: 4003,
  /** The receiver replaced this connection by a newer one (same session). */
  REPLACED: 4004,
} as const;

// ---------------------------------------------------------------------------------------------
// Shared shapes (mirrors of src/shared/types.ts)
// ---------------------------------------------------------------------------------------------

export interface HeaderPair {
  name: string;
  value: string;
}

export type FormDataEntryInfo =
  | { name: string; type: 'text'; value: string; truncated?: boolean }
  | {
      name: string;
      type: 'file';
      fileName: string;
      mime: string;
      /** -1 when unknown (React Native file parts reference a `uri` whose content is not read). */
      size: number;
      base64?: string;
      truncated?: boolean;
      /** React Native extension: the `uri` of a `{ uri, name, type }` FormData part. */
      uri?: string;
    };

/** Same union as the extension's SerializedBody. */
export type SerializedBody =
  | { kind: 'text'; text: string; size: number; truncated?: boolean }
  | { kind: 'base64'; base64: string; size: number; truncated?: boolean }
  | { kind: 'formData'; entries: FormDataEntryInfo[] }
  | { kind: 'formFields'; fields: Array<{ name: string; value: string }> }
  | { kind: 'unavailable'; reason: string };

export type WireBody = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'base64'; base64: string };

/** HookRequestStart-like. `frameUrl` is always '' (there are no frames in an app). */
export interface RnRequestStart {
  /** Unique per app session: `${session}:${counter}`. */
  hookId: string;
  /** 'fetch' also covers fetch() calls React Native runs over XMLHttpRequest (deduplicated). */
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  headers: HeaderPair[];
  body: SerializedBody | null;
  contentType: string | null;
  /** Epoch ms. */
  startTime: number;
  frameUrl: string;
  options?: {
    credentials?: string;
    mode?: string;
    cache?: string;
    redirect?: string;
    referrerPolicy?: string;
    keepalive?: boolean;
    withCredentials?: boolean;
    /** XMLHttpRequest.responseType the app used ('' = text). */
    responseType?: string;
    /** XMLHttpRequest.timeout (ms) when set. */
    timeout?: number;
  };
}

/** HookRequestEnd-like. */
export interface RnRequestEnd {
  hookId: string;
  state: 'done' | 'error' | 'aborted';
  status?: number;
  statusText?: string;
  headers?: HeaderPair[];
  body?: SerializedBody | null;
  responseUrl?: string;
  redirected?: boolean;
  responseType?: string;
  /** Epoch ms. */
  endTime: number;
  error?: string;
}

/** ReplayRequest-like. `mode` / `frameId` / `entryId` are accepted and ignored by the app. */
export interface RnReplayRequest {
  runId: string;
  entryId?: string;
  mode?: string;
  frameId?: number;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: WireBody;
  credentials?: 'include' | 'same-origin' | 'omit';
  redirect?: 'follow' | 'manual' | 'error';
  timeoutMs?: number;
  responseBodyCap?: number;
}

export interface RnReplayTiming {
  start: number;
  headers?: number;
  end: number;
}

/** ReplayResult-like. */
export interface RnReplayResult {
  runId: string;
  ok: boolean;
  status: number;
  statusText: string;
  headers: HeaderPair[];
  body: SerializedBody | null;
  url: string;
  redirected: boolean;
  type?: string;
  timing: RnReplayTiming;
  size: number;
  error?: string;
  errorHint?: string;
  aborted?: boolean;
  timedOut?: boolean;
  droppedHeaders?: string[];
}

// ---------------------------------------------------------------------------------------------
// WebSocket inspector shapes
// ---------------------------------------------------------------------------------------------

export interface RnWsOpen {
  /** Unique per app session: `${session}:ws${counter}`. */
  wsId: string;
  url: string;
  protocols: string[];
  /** Headers passed through React Native's non-standard third constructor argument `{ headers }`. */
  headers?: HeaderPair[];
  /** Epoch ms when the app created the socket. */
  time: number;
}

export interface RnWsReady {
  wsId: string;
  /** Sub-protocol the server selected ('' when none). */
  protocol: string;
  extensions?: string;
  time: number;
}

export interface RnWsFrame {
  wsId: string;
  /** out = sent by the app, in = received from the server. */
  dir: 'in' | 'out';
  /** text frame -> `text`; binary frame -> `base64`. */
  opcode: 'text' | 'binary';
  text?: string;
  base64?: string;
  /** Full payload byte length before truncation. */
  size: number;
  truncated?: boolean;
  time: number;
}

export interface RnWsError {
  wsId: string;
  message: string;
  time: number;
}

export interface RnWsClose {
  wsId: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  /** 'client' when the app called close(), else 'server' (or a network failure). */
  initiator: 'client' | 'server';
  time: number;
}

// ---------------------------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------------------------

export interface RnAppInfo {
  name: string;
  /** From the Metro bundle URL `app=` parameter or the config; '' when unknown. */
  bundleId: string;
  platform: 'ios' | 'android';
  /** e.g. "0.76.3" ('' when unknown). */
  rnVersion: string;
  hermes: boolean;
  deviceName: string;
  /** Extra, informational. */
  osVersion?: string;
  emulator?: boolean;
}

export interface HelloMessage {
  t: 'hello';
  v: typeof PROTOCOL_VERSION;
  token: string;
  app: RnAppInfo;
  /** Random id of this JS context; stays the same across reconnects, changes on every app reload. */
  session: string;
  lib: { name: string; version: string };
  /** Features this client implements. */
  capabilities: string[];
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** App -> receiver. */
export type ClientMessage =
  | HelloMessage
  | { t: 'start'; data: RnRequestStart }
  | { t: 'end'; data: RnRequestEnd }
  | { t: 'ws-open'; data: RnWsOpen }
  | { t: 'ws-ready'; data: RnWsReady }
  | { t: 'ws-frame'; data: RnWsFrame }
  | { t: 'ws-error'; data: RnWsError }
  | { t: 'ws-close'; data: RnWsClose }
  /** Captures evicted from the offline buffer since the last report. */
  | { t: 'dropped'; count: number }
  | { t: 'replay-result'; data: RnReplayResult }
  /** Dev menu "Open kineReqLens" (or openKineReqLens()): the desktop side opens the standalone tab. */
  | { t: 'open-ui' }
  | { t: 'pong'; id?: string };

/** Receiver -> app. */
export type ServerMessage =
  | { t: 'welcome'; v: typeof PROTOCOL_VERSION; server?: { name?: string; version?: string } }
  /** Sent right before closing with CLOSE_CODES.BAD_TOKEN / BAD_HANDSHAKE. */
  | { t: 'rejected'; reason: string; code?: number }
  | { t: 'replay'; data: RnReplayRequest }
  | { t: 'abort'; runId: string }
  | { t: 'ping'; id?: string };

export type ClientMessageType = ClientMessage['t'];
export type ServerMessageType = ServerMessage['t'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a receiver frame; null for anything malformed or unknown. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'welcome':
      return value.v === PROTOCOL_VERSION ? (value as ServerMessage) : null;
    case 'rejected':
      return { t: 'rejected', reason: typeof value.reason === 'string' ? value.reason : 'rejected' };
    case 'replay':
      return isObject(value.data) ? ({ t: 'replay', data: value.data } as unknown as ServerMessage) : null;
    case 'abort':
      return typeof value.runId === 'string' ? { t: 'abort', runId: value.runId } : null;
    case 'ping':
      return typeof value.id === 'string' ? { t: 'ping', id: value.id } : { t: 'ping' };
    default:
      return null;
  }
}

/** Parse an app frame (for receivers); null for anything malformed or unknown. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.t !== 'string') return null;
  switch (value.t) {
    case 'hello':
    case 'start':
    case 'end':
    case 'ws-open':
    case 'ws-ready':
    case 'ws-frame':
    case 'ws-error':
    case 'ws-close':
    case 'dropped':
    case 'replay-result':
    case 'open-ui':
    case 'pong':
      return value as unknown as ClientMessage;
    default:
      return null;
  }
}
