/**
 * React Native support (docs/ARCHITECTURE.md §9, react-native/PROTOCOL.md):
 *
 *   RN app (@kinebot/kinereqlens-react-native) ──WebSocket ws://<host>:8790/kinereqlens──► hub receiver
 *     (`reqlens-mcp native-host`, mcp/src/rn/**) ──native messaging (rn-* below)──► service worker
 *     (src/background/rn/**) ──Port 'reqlens-standalone'──► standalone tab app.html (src/ui/standalone/**)
 *
 * The app is untrusted: the hub validates every message (`sanitizeRnClientMessage`, `parseRnHello`) before it
 * forwards anything, the standalone page's store validates again. Pure module (no DOM / node / chrome APIs):
 * shared by the hub (node), the worker and the pages.
 */
import type { FormDataEntryInfo, HeaderPair, SerializedBody, WireBody } from './types';

export const RN_PROTOCOL_VERSION = 1;
export const RN_DEFAULT_PORT = 8790;
export const RN_PATH = '/kinereqlens';
export const RN_MIN_PORT = 1024;
export const RN_MAX_PORT = 65535;
/** WebSocket close codes of the receiver (react-native/src/protocol.ts CLOSE_CODES). */
export const RN_CLOSE = { BAD_TOKEN: 4001, BAD_HANDSHAKE: 4002, HANDSHAKE_TIMEOUT: 4003, REPLACED: 4004 } as const;
/** The hub batches an app's captures for at most this long before forwarding them. */
export const RN_BATCH_MS = 50;
/** Max JSON bytes of one hub → extension frame the hub aims for (native messaging caps them at 1 MiB). */
export const RN_FRAME_BUDGET = 900_000;
/** File in $REQLENS_HOME holding the pairing token (0600). */
export const RN_TOKEN_FILE = 'rn-token';
/** Port the standalone page (app.html) opens to the worker (captures, replays). */
export const RN_STANDALONE_PORT = 'reqlens-standalone';
/** Port extension pages open for the React Native status (Settings → React Native). */
export const RN_STATUS_PORT = 'reqlens-rn';
/** Standalone page of the extension. */
export const RN_STANDALONE_PAGE = 'app.html';
/** Max reassembled size of a chunked message (a replay result with a big body). */
export const RN_MAX_CHUNKED_BYTES = 64 * 1024 * 1024;

/** A usable receiver port (1024..65535), else the default. */
export function sanitizeRnPort(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= RN_MIN_PORT && value <= RN_MAX_PORT ? value : RN_DEFAULT_PORT;
}

// ---------------------------------------------------------------------------------------------------------
// Data shapes (mirrors of react-native/src/protocol.ts, validated copies)
// ---------------------------------------------------------------------------------------------------------

export interface RnAppInfo {
  name: string;
  bundleId: string;
  platform: 'ios' | 'android';
  rnVersion: string;
  hermes: boolean;
  deviceName: string;
  osVersion?: string;
  emulator?: boolean;
}

export interface RnHello {
  session: string;
  token: string;
  app: RnAppInfo;
  lib: { name: string; version: string };
  capabilities: string[];
}

/** One app JS context (`session`), as the hub reports it. */
export interface RnSessionInfo {
  session: string;
  app: RnAppInfo;
  lib: { name: string; version: string };
  capabilities: string[];
  connected: boolean;
  /** Epoch ms of the (latest) handshake. */
  connectedAt: number;
  /** Remote address of the connection ('' when unknown). */
  address: string;
}

export interface RnReplayRequest {
  runId: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  body: WireBody;
  credentials?: 'include' | 'same-origin' | 'omit';
  redirect?: 'follow' | 'manual' | 'error';
  timeoutMs?: number;
  responseBodyCap?: number;
}

/** App messages the hub forwards (validated copies). `open-ui` / `pong` / `hello` are handled by the hub. */
export type RnCaptureMessage =
  | { t: 'start'; data: Record<string, unknown> }
  | { t: 'end'; data: Record<string, unknown> }
  | { t: 'ws-open'; data: { wsId: string; url: string; protocols: string[]; time: number } }
  | { t: 'ws-ready'; data: { wsId: string; protocol: string; extensions: string; time: number } }
  | { t: 'ws-frame'; data: { wsId: string; dir: 'in' | 'out'; opcode: 'text' | 'binary'; text?: string; base64?: string; size: number; truncated: boolean; time: number } }
  | { t: 'ws-error'; data: { wsId: string; message: string; time: number } }
  | { t: 'ws-close'; data: { wsId: string; code: number; reason: string; wasClean: boolean; initiator: 'client' | 'server'; time: number } }
  | { t: 'dropped'; count: number }
  | { t: 'replay-result'; data: Record<string, unknown> };

export type RnClientMessage = RnCaptureMessage | { t: 'open-ui' } | { t: 'pong' };

export type RnReceiverState = 'off' | 'listening' | 'error';

/** The hub's receiver. */
export interface RnReceiverStatus {
  state: RnReceiverState;
  /** Address it is bound to ('127.0.0.1' or '0.0.0.0'). */
  host: string;
  port: number;
  lan: boolean;
  /** LAN IPv4 addresses of this machine (for physical devices) when `lan`. */
  addresses: string[];
  /** Pairing token apps must present. */
  token: string;
  error?: string;
}

// ---------------------------------------------------------------------------------------------------------
// hub ↔ extension (native messaging), added to HostToExtension / ExtensionToHost (claude-protocol.ts)
// ---------------------------------------------------------------------------------------------------------

export type RnHostToExtension =
  | { t: 'rn-status'; status: RnReceiverStatus }
  | ({ t: 'rn-session' } & RnSessionInfo)
  /** Batched (≤ RN_BATCH_MS) validated captures of one app session, in order. */
  | { t: 'rn-capture'; session: string; msgs: RnCaptureMessage[] }
  /** The app asked for the standalone tab (dev menu "Open kineReqLens"). */
  | { t: 'rn-open-ui'; session: string }
  /** Part `seq` (0-based) of `total` of the JSON text of one message larger than a native messaging frame. */
  | { t: 'rn-chunk'; id: string; seq: number; total: number; part: string };

export type RnExtensionToHost =
  | { t: 'rn-config'; enabled: boolean; lan: boolean; port: number }
  | { t: 'rn-replay'; session: string; data: RnReplayRequest }
  | { t: 'rn-abort'; session: string; runId: string }
  | { t: 'rn-token'; regenerate: true };

/** Status of React Native support the worker hands to extension pages. */
export interface RnStatus {
  /** settings.rnEnabled */
  enabled: boolean;
  /** The nativeMessaging permission is granted. */
  permission: boolean;
  /** Native host link: off / connecting / connected / not-installed / error. */
  host: 'off' | 'connecting' | 'connected' | 'not-installed' | 'error';
  hostError?: string;
  receiver: RnReceiverStatus | null;
  sessions: RnSessionInfo[];
  extensionId: string;
}

// ---------------------------------------------------------------------------------------------------------
// Extension pages ↔ worker (Ports RN_STANDALONE_PORT / RN_STATUS_PORT)
// ---------------------------------------------------------------------------------------------------------

export type StandaloneToWorker =
  | { t: 'hello'; v: 1 }
  | { t: 'call'; id: number; method: 'replay'; args: [session: string, req: unknown] }
  | { t: 'call'; id: number; method: 'abort'; args: [session: string, runId: string, mode: string] }
  /** Forget the buffered captures of a session (the user cleared the list). */
  | { t: 'clear'; session: string };

export type WorkerToStandalone =
  | { t: 'status'; status: RnStatus }
  /** Buffered + live captures of a session (`reset`: drop what the page has for it first). */
  | { t: 'captures'; session: string; msgs: RnCaptureMessage[]; reset?: boolean }
  | { t: 'select'; session: string }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string };

export type RnStatusToWorker = { t: 'regenerate-token' } | { t: 'open-ui'; session?: string };
export type WorkerToRnStatus = { t: 'status'; status: RnStatus };

// ---------------------------------------------------------------------------------------------------------
// Validation (untrusted app data)
// ---------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const MAX_ID = 200;
const MAX_URL = 64 * 1024;
const MAX_TEXT = 4096;
const MAX_HEADERS = 500;
const MAX_HEADER_TEXT = 64 * 1024;
/** Body text / base64 characters kept per body (the app caps bodies at 1-10 MB by default). */
const MAX_BODY_CHARS = 24 * 1024 * 1024;
const MAX_FORM_ENTRIES = 10_000;
const MAX_WS_PAYLOAD_CHARS = 2 * 1024 * 1024;
const MAX_PROTOCOLS = 32;
const ID = /^[A-Za-z0-9:_.-]{1,200}$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const START_OPTION_STRINGS = ['credentials', 'mode', 'cache', 'redirect', 'referrerPolicy', 'responseType'] as const;
const START_OPTION_FLAGS = ['keepalive', 'withCredentials'] as const;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function str(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function size(value: unknown): number {
  return finite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** True for an id an app may use (hookId / wsId / runId). */
export function isRnId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/** True for a session id (`hello.session`). */
export function isRnSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION.test(value);
}

export function sanitizeRnHeaders(value: unknown): HeaderPair[] {
  if (!Array.isArray(value)) return [];
  const out: HeaderPair[] = [];
  for (const item of value) {
    if (out.length >= MAX_HEADERS) break;
    if (isRec(item) && typeof item.name === 'string' && typeof item.value === 'string' && item.name) {
      out.push({ name: item.name.slice(0, MAX_HEADER_TEXT), value: item.value.slice(0, MAX_HEADER_TEXT) });
    }
  }
  return out;
}

function sanitizeFormEntry(value: unknown): FormDataEntryInfo | null {
  if (!isRec(value) || typeof value.name !== 'string') return null;
  const name = value.name.slice(0, MAX_TEXT);
  if (value.type === 'text' && typeof value.value === 'string') {
    const text = value.value.slice(0, MAX_BODY_CHARS);
    return value.truncated === true || text.length < value.value.length ? { name, type: 'text', value: text, truncated: true } : { name, type: 'text', value: text };
  }
  if (value.type !== 'file') return null;
  // React Native file parts ({uri, name, type}) report size -1 (contents not read): kept as 0 + truncated.
  const unknownSize = !finite(value.size) || value.size < 0;
  const entry: FormDataEntryInfo = {
    name,
    type: 'file',
    fileName: str(value.fileName, MAX_TEXT) ?? '',
    mime: str(value.mime, 256) ?? '',
    size: size(value.size),
  };
  if (typeof value.base64 === 'string' && value.base64.length <= MAX_BODY_CHARS) entry.base64 = value.base64;
  if (value.truncated === true || unknownSize) entry.truncated = true;
  return entry;
}

/** A SerializedBody rebuilt from known fields (null when malformed). */
export function sanitizeRnBody(value: unknown): SerializedBody | null {
  if (!isRec(value)) return null;
  switch (value.kind) {
    case 'text': {
      if (typeof value.text !== 'string') return null;
      const text = value.text.slice(0, MAX_BODY_CHARS);
      const body: SerializedBody = { kind: 'text', text, size: Math.max(size(value.size), text.length) };
      if (value.truncated === true || text.length < value.text.length) body.truncated = true;
      return body;
    }
    case 'base64': {
      if (typeof value.base64 !== 'string') return null;
      let base64 = value.base64.slice(0, MAX_BODY_CHARS);
      base64 = base64.slice(0, base64.length - (base64.length % 4));
      const body: SerializedBody = { kind: 'base64', base64, size: Math.max(size(value.size), Math.floor((base64.length / 4) * 3)) };
      if (value.truncated === true || base64.length < value.base64.length) body.truncated = true;
      return body;
    }
    case 'formData': {
      if (!Array.isArray(value.entries)) return null;
      const entries: FormDataEntryInfo[] = [];
      for (const item of value.entries.slice(0, MAX_FORM_ENTRIES)) {
        const entry = sanitizeFormEntry(item);
        if (entry) entries.push(entry);
      }
      return { kind: 'formData', entries };
    }
    case 'formFields': {
      if (!Array.isArray(value.fields)) return null;
      const fields: Array<{ name: string; value: string }> = [];
      for (const item of value.fields.slice(0, MAX_FORM_ENTRIES)) {
        if (isRec(item) && typeof item.name === 'string' && typeof item.value === 'string') {
          fields.push({ name: item.name.slice(0, MAX_TEXT), value: item.value.slice(0, MAX_BODY_CHARS) });
        }
      }
      return { kind: 'formFields', fields };
    }
    case 'unavailable':
      return { kind: 'unavailable', reason: str(value.reason) ?? 'unavailable' };
    default:
      return null;
  }
}

function sanitizeStart(value: unknown): Rec | null {
  if (!isRec(value) || !isRnId(value.hookId)) return null;
  if (value.kind !== 'fetch' && value.kind !== 'xhr') return null;
  if (typeof value.method !== 'string' || !METHOD.test(value.method)) return null;
  if (typeof value.url !== 'string' || !value.url || value.url.length > MAX_URL) return null;
  if (!finite(value.startTime)) return null;
  const start: Rec = {
    hookId: value.hookId,
    kind: value.kind,
    method: value.method,
    url: value.url,
    headers: sanitizeRnHeaders(value.headers),
    body: value.body === null || value.body === undefined ? null : sanitizeRnBody(value.body),
    contentType: str(value.contentType, MAX_TEXT) ?? null,
    startTime: value.startTime,
    frameUrl: '',
  };
  if (isRec(value.options)) {
    const options: Rec = {};
    for (const key of START_OPTION_STRINGS) {
      const text = str(value.options[key], 64);
      if (text !== undefined) options[key] = text;
    }
    for (const key of START_OPTION_FLAGS) if (typeof value.options[key] === 'boolean') options[key] = value.options[key];
    if (Object.keys(options).length) start.options = options;
  }
  return start;
}

function sanitizeEnd(value: unknown): Rec | null {
  if (!isRec(value) || !isRnId(value.hookId)) return null;
  if (value.state !== 'done' && value.state !== 'error' && value.state !== 'aborted') return null;
  if (!finite(value.endTime)) return null;
  const end: Rec = { hookId: value.hookId, state: value.state, endTime: value.endTime };
  if (finite(value.status) && Number.isInteger(value.status) && value.status >= 0 && value.status <= 999) end.status = value.status;
  const statusText = str(value.statusText);
  if (statusText !== undefined) end.statusText = statusText;
  if (value.headers !== undefined) end.headers = sanitizeRnHeaders(value.headers);
  if (value.body !== undefined) end.body = value.body === null ? null : sanitizeRnBody(value.body);
  const responseUrl = str(value.responseUrl, MAX_URL);
  if (responseUrl !== undefined) end.responseUrl = responseUrl;
  if (typeof value.redirected === 'boolean') end.redirected = value.redirected;
  const responseType = str(value.responseType, 64);
  if (responseType !== undefined) end.responseType = responseType;
  const error = str(value.error);
  if (error !== undefined) end.error = error;
  return end;
}

/** A replay result from the app (rebuilt; the page binds it to its own request again). */
export function sanitizeRnReplayResult(value: unknown): Rec | null {
  if (!isRec(value) || !isRnId(value.runId)) return null;
  const timing = isRec(value.timing) ? value.timing : {};
  const out: Rec = {
    runId: value.runId,
    ok: value.ok === true,
    status: finite(value.status) ? Math.floor(value.status) : 0,
    statusText: str(value.statusText) ?? '',
    headers: sanitizeRnHeaders(value.headers),
    body: sanitizeRnBody(value.body),
    url: str(value.url, MAX_URL) ?? '',
    redirected: value.redirected === true,
    timing: {
      start: finite(timing.start) ? timing.start : 0,
      end: finite(timing.end) ? timing.end : 0,
      ...(finite(timing.headers) ? { headers: timing.headers } : {}),
    },
    size: size(value.size),
  };
  for (const key of ['type', 'error', 'errorHint'] as const) {
    const text = str(value[key]);
    if (text !== undefined) out[key] = text;
  }
  if (value.aborted === true) out.aborted = true;
  if (value.timedOut === true) out.timedOut = true;
  return out;
}

/** One validated app → receiver message after the handshake (null = drop it). */
export function sanitizeRnClientMessage(value: unknown): RnClientMessage | null {
  if (!isRec(value) || typeof value.t !== 'string') return null;
  const d = value.data;
  switch (value.t) {
    case 'start': {
      const data = sanitizeStart(d);
      return data ? { t: 'start', data } : null;
    }
    case 'end': {
      const data = sanitizeEnd(d);
      return data ? { t: 'end', data } : null;
    }
    case 'ws-open': {
      if (!isRec(d) || !isRnId(d.wsId) || typeof d.url !== 'string' || !finite(d.time)) return null;
      const protocols = Array.isArray(d.protocols)
        ? d.protocols.slice(0, MAX_PROTOCOLS).filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 256))
        : [];
      return { t: 'ws-open', data: { wsId: d.wsId, url: d.url.slice(0, 8192), protocols, time: d.time } };
    }
    case 'ws-ready':
      if (!isRec(d) || !isRnId(d.wsId) || !finite(d.time)) return null;
      return { t: 'ws-ready', data: { wsId: d.wsId, protocol: str(d.protocol, 256) ?? '', extensions: str(d.extensions, 1024) ?? '', time: d.time } };
    case 'ws-frame': {
      if (!isRec(d) || !isRnId(d.wsId) || !finite(d.time)) return null;
      if ((d.dir !== 'in' && d.dir !== 'out') || (d.opcode !== 'text' && d.opcode !== 'binary')) return null;
      const payload = d.opcode === 'text' ? d.text : d.base64;
      if (typeof payload !== 'string') return null;
      const cut = payload.length > MAX_WS_PAYLOAD_CHARS;
      let kept = cut ? payload.slice(0, MAX_WS_PAYLOAD_CHARS) : payload;
      if (d.opcode === 'binary') kept = kept.slice(0, kept.length - (kept.length % 4));
      return {
        t: 'ws-frame',
        data: {
          wsId: d.wsId,
          dir: d.dir,
          opcode: d.opcode,
          ...(d.opcode === 'text' ? { text: kept } : { base64: kept }),
          size: Math.max(size(d.size), kept.length),
          truncated: d.truncated === true || cut || kept.length < payload.length,
          time: d.time,
        },
      };
    }
    case 'ws-error':
      if (!isRec(d) || !isRnId(d.wsId) || !finite(d.time)) return null;
      return { t: 'ws-error', data: { wsId: d.wsId, message: str(d.message, 1024) ?? '', time: d.time } };
    case 'ws-close':
      if (!isRec(d) || !isRnId(d.wsId) || !finite(d.time)) return null;
      return {
        t: 'ws-close',
        data: {
          wsId: d.wsId,
          code: finite(d.code) && Number.isInteger(d.code) ? d.code : 1005,
          reason: str(d.reason, 1024) ?? '',
          wasClean: d.wasClean === true,
          initiator: d.initiator === 'client' ? 'client' : 'server',
          time: d.time,
        },
      };
    case 'dropped':
      return finite(value.count) && value.count >= 0 ? { t: 'dropped', count: Math.min(Math.floor(value.count), 1e9) } : null;
    case 'replay-result': {
      const data = sanitizeRnReplayResult(d);
      return data ? { t: 'replay-result', data } : null;
    }
    case 'open-ui':
      return { t: 'open-ui' };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}

/** The `hello` handshake (null = malformed; `v` is checked separately so the reason can be told apart). */
export function parseRnHello(value: unknown): RnHello | null {
  if (!isRec(value) || value.t !== 'hello' || typeof value.token !== 'string' || !isRnSession(value.session)) return null;
  const app = isRec(value.app) ? value.app : {};
  const lib = isRec(value.lib) ? value.lib : {};
  const info: RnAppInfo = {
    name: str(app.name, 200) ?? '',
    bundleId: str(app.bundleId, 200) ?? '',
    platform: app.platform === 'android' ? 'android' : 'ios',
    rnVersion: str(app.rnVersion, 64) ?? '',
    hermes: app.hermes === true,
    deviceName: str(app.deviceName, 200) ?? '',
  };
  const osVersion = str(app.osVersion, 64);
  if (osVersion) info.osVersion = osVersion;
  if (typeof app.emulator === 'boolean') info.emulator = app.emulator;
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.slice(0, 32).filter((c): c is string => typeof c === 'string').map((c) => c.slice(0, 64))
    : [];
  return {
    session: value.session,
    token: value.token.slice(0, 1024),
    app: info,
    lib: { name: str(lib.name, 200) ?? '', version: str(lib.version, 64) ?? '' },
    capabilities,
  };
}

/** Display label of an app session: "DemoApp · iOS · iPhone 15". */
export function rnSessionLabel(info: Pick<RnSessionInfo, 'app'>): string {
  const platform = info.app.platform === 'android' ? 'Android' : 'iOS';
  return [info.app.name || info.app.bundleId || 'React Native app', platform, info.app.deviceName].filter(Boolean).join(' · ');
}

/** The app's `wsId` (`<session>:ws<n>`) as a WebSocket inspector hook id ([A-Za-z0-9_-]). */
export function rnWsHookId(wsId: string): string {
  return wsId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** The setup snippet for the app's entry file. */
export function rnSetupSnippet(token: string): string {
  return `if (__DEV__) require('@kinebot/kinereqlens-react-native').startKineReqLens({ token: '${token.replace(/[^A-Za-z0-9_-]/g, '')}' })`;
}
