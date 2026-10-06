// Shape validation of everything the hub and the MCP server receive (native messaging frames from the
// extension, socket lines from MCP servers / from the hub). Invalid messages are dropped or answered with an
// error; nothing here trusts the peer.
import {
  BRIDGE_METHODS,
  type BridgeMethod,
  type ClaudeSessionInfo,
  type ExtensionToHost,
  type HubToMcp,
  type InboxItem,
  type McpToHub,
  type PromptTarget,
  type TypeFormat,
} from '../../src/shared/claude-protocol';
import { isFsMessageType, parseFsToHost } from '../../src/shared/fs';
import { isPtyMessageType, parsePtyToHost } from '../../src/shared/pty';
import { isRunMessageType, parseRunToHost } from '../../src/shared/errors-protocol';
import {
  isRnId,
  isRnSession,
  sanitizeRnHeaders,
  sanitizeRnPort,
  type RnExtensionToHost,
  type RnReplayRequest,
} from '../../src/shared/rn-protocol';
import type { WireBody } from '../../src/shared/types';
import { isShotMessageType, parseInboxImages, parseShotToHost } from '../../src/shared/shot-protocol';

export const PROMPT_TARGETS: ReadonlyArray<PromptTarget> = ['client', 'server', 'tests', 'explain'];
export const TYPE_FORMATS: ReadonlyArray<TypeFormat> = ['typescript', 'zod', 'json-schema'];

/** Max length of message / session / request ids. */
export const MAX_ID_CHARS = 128;
const MAX_LABEL_CHARS = 200;
const MAX_PATH_CHARS = 4096;
const MAX_INFO_CHARS = 200;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty id without control characters, at most MAX_ID_CHARS. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === 'string' && (BRIDGE_METHODS as ReadonlyArray<string>).includes(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRes(m: Rec): Extract<ExtensionToHost, { t: 'res' }> | null {
  if (!isId(m.id) || typeof m.ok !== 'boolean') return null;
  if (m.ok) return { t: 'res', id: m.id, ok: true, result: m.result };
  const error = typeof m.error === 'string' && m.error ? m.error : 'Unknown error';
  return { t: 'res', id: m.id, ok: false, error };
}

/** A pushed inbox item, or null when malformed. */
export function parseInboxItem(value: unknown): InboxItem | null {
  if (!isRecord(value)) return null;
  const { id, sentAt, tabId, entryId, title, target, prompt, sessionId } = value;
  if (!isId(id) || !isFiniteNumber(sentAt) || !Number.isInteger(tabId) || typeof entryId !== 'string') return null;
  if (typeof title !== 'string' || typeof prompt !== 'string') return null;
  if (!PROMPT_TARGETS.includes(target as PromptTarget)) return null;
  if (sessionId !== undefined && sessionId !== null && !isId(sessionId)) return null;
  // Screenshots ("Send to Claude"): absolute .png paths with a name and a size; older items have none.
  const images = parseInboxImages(value.images);
  if (!images) return null;
  const item: InboxItem = {
    id,
    sentAt,
    tabId: tabId as number,
    entryId: entryId.slice(0, 1024),
    title: title.slice(0, 500),
    target: target as PromptTarget,
    prompt,
    sessionId: sessionId ?? null,
  };
  if (images.length) item.images = images;
  return item;
}

/** Extension → hub (native messaging). */
export function parseExtensionMessage(value: unknown): ExtensionToHost | null {
  if (!isRecord(value)) return null;
  // Embedded terminal control (strictly validated: ids, cwd, dimensions, input size).
  if (isPtyMessageType(value.t)) return parsePtyToHost(value);
  // Folder browser of the terminal's new-session form (paths validated again by mcp/src/fs.ts).
  if (isFsMessageType(value.t)) return parseFsToHost(value);
  // Errors view runs / git ops / config (prompts, paths, ops validated; full mode gated by the RunManager).
  if (isRunMessageType(value.t)) return parseRunToHost(value);
  // "Send to Claude" screenshot chunks (worker-chosen file ids; PNG checked once assembled, mcp/src/shots.ts).
  if (isShotMessageType(value.t)) return parseShotToHost(value, { fileIds: true });
  switch (value.t) {
    case 'hello':
      if (!isFiniteNumber(value.v)) return null;
      return {
        t: 'hello',
        v: value.v,
        extensionVersion: optionalString(value.extensionVersion, MAX_INFO_CHARS) ?? '',
        extensionId: optionalString(value.extensionId, MAX_INFO_CHARS) ?? '',
        browser: optionalString(value.browser, MAX_INFO_CHARS) ?? '',
      };
    case 'res':
      return parseRes(value);
    case 'push': {
      const item = parseInboxItem(value.item);
      return item ? { t: 'push', item } : null;
    }
    case 'rn-config':
    case 'rn-replay':
    case 'rn-abort':
    case 'rn-token':
      return parseRnExtensionMessage(value);
    default:
      return null;
  }
}

const RN_CREDENTIALS = ['include', 'same-origin', 'omit'] as const;
const RN_REDIRECTS = ['follow', 'manual', 'error'] as const;

function parseWireBody(value: unknown): WireBody | null {
  if (!isRecord(value) || value.kind === 'none') return { kind: 'none' };
  if (value.kind === 'text' && typeof value.text === 'string') return { kind: 'text', text: value.text };
  if (value.kind === 'base64' && typeof value.base64 === 'string') return { kind: 'base64', base64: value.base64 };
  return null;
}

/** A replay the extension asks the app to run (the extension validated it already; re-checked here). */
export function parseRnReplayRequest(value: unknown): RnReplayRequest | null {
  if (!isRecord(value) || !isRnId(value.runId)) return null;
  if (typeof value.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(value.method)) return null;
  if (typeof value.url !== 'string' || !value.url || value.url.length > 64 * 1024) return null;
  const body = parseWireBody(value.body);
  if (!body) return null;
  const req: RnReplayRequest = { runId: value.runId, method: value.method, url: value.url, headers: sanitizeRnHeaders(value.headers), body };
  if ((RN_CREDENTIALS as ReadonlyArray<unknown>).includes(value.credentials)) req.credentials = value.credentials as RnReplayRequest['credentials'];
  if ((RN_REDIRECTS as ReadonlyArray<unknown>).includes(value.redirect)) req.redirect = value.redirect as RnReplayRequest['redirect'];
  if (isFiniteNumber(value.timeoutMs) && value.timeoutMs > 0) req.timeoutMs = Math.min(value.timeoutMs, 3_600_000);
  if (isFiniteNumber(value.responseBodyCap) && value.responseBodyCap >= 0) req.responseBodyCap = Math.min(value.responseBodyCap, 512 * 1024 * 1024);
  return req;
}

/** Extension → hub React Native control messages. */
export function parseRnExtensionMessage(value: Rec): RnExtensionToHost | null {
  switch (value.t) {
    case 'rn-config':
      if (typeof value.enabled !== 'boolean') return null;
      return { t: 'rn-config', enabled: value.enabled, lan: value.lan === true, port: sanitizeRnPort(value.port) };
    case 'rn-replay': {
      if (!isRnSession(value.session)) return null;
      const data = parseRnReplayRequest(value.data);
      return data ? { t: 'rn-replay', session: value.session, data } : null;
    }
    case 'rn-abort':
      return isRnSession(value.session) && isRnId(value.runId) ? { t: 'rn-abort', session: value.session, runId: value.runId } : null;
    case 'rn-token':
      return value.regenerate === true ? { t: 'rn-token', regenerate: true } : null;
    default:
      return null;
  }
}

export type McpMessageParse =
  | { ok: true; message: McpToHub }
  /** `id` is set when the message was a request the hub can answer with an error. */
  | { ok: false; error: string; id?: string };

/** MCP server → hub (socket line). */
export function parseMcpMessage(value: unknown): McpMessageParse {
  if (!isRecord(value)) return { ok: false, error: 'Message is not an object' };
  if (value.t === 'hello') {
    const session = value.session;
    if (!isFiniteNumber(value.v) || !isRecord(session)) return { ok: false, error: 'Malformed hello' };
    const { id, label, cwd, pid, ppid } = session;
    if (!isId(id) || typeof cwd !== 'string' || !Number.isInteger(pid) || (pid as number) < 0) {
      return { ok: false, error: 'Malformed hello session' };
    }
    const cleanCwd = cwd.slice(0, MAX_PATH_CHARS);
    const info: Omit<ClaudeSessionInfo, 'connectedAt'> = {
      id,
      label: (typeof label === 'string' && label ? label : cleanCwd).slice(0, MAX_LABEL_CHARS),
      cwd: cleanCwd,
      pid: pid as number,
    };
    if (Number.isSafeInteger(ppid) && (ppid as number) > 0) info.ppid = ppid as number;
    return { ok: true, message: { t: 'hello', v: value.v, session: info } };
  }
  if (value.t === 'req') {
    if (!isId(value.id)) return { ok: false, error: 'Malformed request id' };
    if (!isBridgeMethod(value.method)) {
      return { ok: false, id: value.id, error: `Unknown method: ${String(value.method).slice(0, 64)}` };
    }
    if (value.params !== undefined && value.params !== null && !isRecord(value.params)) {
      return { ok: false, id: value.id, error: 'params must be an object' };
    }
    return { ok: true, message: { t: 'req', id: value.id, method: value.method, params: value.params ?? {} } };
  }
  return { ok: false, error: `Unknown message type: ${String(value.t).slice(0, 32)}` };
}

function parseExtInfo(value: unknown): { connected: boolean; version?: string; browser?: string } | null {
  if (!isRecord(value) || typeof value.connected !== 'boolean') return null;
  const out: { connected: boolean; version?: string; browser?: string } = { connected: value.connected };
  const version = optionalString(value.version, MAX_INFO_CHARS);
  const browser = optionalString(value.browser, MAX_INFO_CHARS);
  if (version) out.version = version;
  if (browser) out.browser = browser;
  return out;
}

/** Hub → MCP server (socket line). */
export function parseHubMessage(value: unknown): HubToMcp | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'hello': {
      const extension = parseExtInfo(value.extension);
      if (!isFiniteNumber(value.v) || !extension) return null;
      return { t: 'hello', v: value.v, hostVersion: optionalString(value.hostVersion, MAX_INFO_CHARS) ?? '', extension };
    }
    case 'ext': {
      const info = parseExtInfo(value);
      return info ? { t: 'ext', ...info } : null;
    }
    case 'res':
      return parseRes(value);
    case 'push': {
      const item = parseInboxItem(value.item);
      return item ? { t: 'push', item } : null;
    }
    default:
      return null;
  }
}

/** Session info as the hub reports it to the extension. */
export function sessionInfo(session: Omit<ClaudeSessionInfo, 'connectedAt'>, connectedAt: number): ClaudeSessionInfo {
  const info: ClaudeSessionInfo = { id: session.id, label: session.label, cwd: session.cwd, pid: session.pid, connectedAt };
  if (session.ppid !== undefined) info.ppid = session.ppid;
  return info;
}
