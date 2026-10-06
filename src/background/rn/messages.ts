// Worker side of the hub's React Native messages (src/shared/rn-protocol.ts): shape checks of `rn-*` frames and
// reassembly of `rn-chunk` parts. The hub validated the app's data already; the standalone page's store
// validates captures again before showing them.
import {
  RN_MAX_CHUNKED_BYTES,
  isRnSession,
  type RnAppInfo,
  type RnCaptureMessage,
  type RnHostToExtension,
  type RnReceiverStatus,
  type RnSessionInfo,
} from '../../shared/rn-protocol';
import { isRecord } from '../util';

const CAPTURE_TYPES: ReadonlySet<string> = new Set(['start', 'end', 'ws-open', 'ws-ready', 'ws-frame', 'ws-error', 'ws-close', 'dropped', 'replay-result']);
const MAX_MSGS_PER_FRAME = 20_000;
const MAX_PARTIALS = 8;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function parseApp(value: unknown): RnAppInfo {
  const app = isRecord(value) ? value : {};
  const info: RnAppInfo = {
    name: text(app.name, 200),
    bundleId: text(app.bundleId, 200),
    platform: app.platform === 'android' ? 'android' : 'ios',
    rnVersion: text(app.rnVersion, 64),
    hermes: app.hermes === true,
    deviceName: text(app.deviceName, 200),
  };
  if (typeof app.osVersion === 'string' && app.osVersion) info.osVersion = app.osVersion.slice(0, 64);
  if (typeof app.emulator === 'boolean') info.emulator = app.emulator;
  return info;
}

function parseStatus(value: unknown): RnReceiverStatus | null {
  if (!isRecord(value)) return null;
  const state = value.state === 'listening' || value.state === 'error' ? value.state : 'off';
  const status: RnReceiverStatus = {
    state,
    host: text(value.host, 64) || '127.0.0.1',
    port: typeof value.port === 'number' && Number.isInteger(value.port) ? value.port : 0,
    lan: value.lan === true,
    addresses: Array.isArray(value.addresses) ? value.addresses.filter((a): a is string => typeof a === 'string').slice(0, 16).map((a) => a.slice(0, 64)) : [],
    token: /^[A-Za-z0-9_-]{0,128}$/.test(text(value.token, 128)) ? text(value.token, 128) : '',
  };
  if (typeof value.error === 'string' && value.error) status.error = value.error.slice(0, 2000);
  return status;
}

/** A validated rn-* message of the hub (null = ignore). */
export function parseRnHostMessage(value: unknown): RnHostToExtension | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'rn-status': {
      const status = parseStatus(value.status);
      return status ? { t: 'rn-status', status } : null;
    }
    case 'rn-session': {
      if (!isRnSession(value.session)) return null;
      const lib = isRecord(value.lib) ? value.lib : {};
      const info: RnSessionInfo = {
        session: value.session,
        app: parseApp(value.app),
        lib: { name: text(lib.name, 200), version: text(lib.version, 64) },
        capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((c): c is string => typeof c === 'string').slice(0, 32) : [],
        connected: value.connected === true,
        connectedAt: typeof value.connectedAt === 'number' && Number.isFinite(value.connectedAt) ? value.connectedAt : 0,
        address: text(value.address, 128),
      };
      return { t: 'rn-session', ...info };
    }
    case 'rn-capture': {
      if (!isRnSession(value.session) || !Array.isArray(value.msgs)) return null;
      const msgs = value.msgs
        .slice(0, MAX_MSGS_PER_FRAME)
        .filter((m): m is RnCaptureMessage => isRecord(m) && typeof m.t === 'string' && CAPTURE_TYPES.has(m.t));
      return { t: 'rn-capture', session: value.session, msgs };
    }
    case 'rn-open-ui':
      return isRnSession(value.session) ? { t: 'rn-open-ui', session: value.session } : null;
    case 'rn-chunk': {
      const { id, seq, total, part } = value;
      if (typeof id !== 'string' || id.length > 64 || typeof part !== 'string') return null;
      if (typeof seq !== 'number' || typeof total !== 'number' || !Number.isInteger(seq) || !Number.isInteger(total)) return null;
      if (total < 1 || total > 100_000 || seq < 0 || seq >= total) return null;
      return { t: 'rn-chunk', id, seq, total, part };
    }
    default:
      return null;
  }
}

/** True for the message types this module handles. */
export function isRnHostMessageType(t: unknown): boolean {
  return typeof t === 'string' && t.startsWith('rn-');
}

interface Partial {
  parts: string[];
  received: number;
  chars: number;
  total: number;
}

/** Joins rn-chunk parts back into the message they carry (bounded: a few partials, RN_MAX_CHUNKED_BYTES). */
export class ChunkAssembler {
  private readonly partials = new Map<string, Partial>();

  /** The complete message once its last part arrived, else null. */
  push(chunk: Extract<RnHostToExtension, { t: 'rn-chunk' }>): unknown {
    let partial = this.partials.get(chunk.id);
    if (!partial) {
      if (this.partials.size >= MAX_PARTIALS) {
        const oldest = this.partials.keys().next().value;
        if (oldest !== undefined) this.partials.delete(oldest);
      }
      partial = { parts: new Array<string>(chunk.total), received: 0, chars: 0, total: chunk.total };
      this.partials.set(chunk.id, partial);
    }
    if (partial.total !== chunk.total || partial.parts[chunk.seq] !== undefined) {
      this.partials.delete(chunk.id);
      return null;
    }
    partial.parts[chunk.seq] = chunk.part;
    partial.received++;
    partial.chars += chunk.part.length;
    if (partial.chars > RN_MAX_CHUNKED_BYTES) {
      this.partials.delete(chunk.id);
      return null;
    }
    if (partial.received < partial.total) return null;
    this.partials.delete(chunk.id);
    try {
      return JSON.parse(partial.parts.join('')) as unknown;
    } catch {
      return null;
    }
  }

  clear(): void {
    this.partials.clear();
  }
}
