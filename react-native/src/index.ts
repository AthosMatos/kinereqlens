/**
 * kineReqLens for React Native: streams the app's fetch / XMLHttpRequest / WebSocket traffic to the
 * kineReqLens receiver on the developer's machine and runs replays the receiver asks for.
 *
 *   if (__DEV__) require('@kinebot/kinereqlens-react-native').startKineReqLens({ token: '…' });
 *
 * Plain API, no React component. Nothing here throws into app code or changes the app's networking.
 */
import type { Runtime } from './context';
import { setRuntime } from './context';
import type { ReactNativeLike } from './env';
import { _setReactNativeModule, appInfo, defaultHost, getReactNative, metroServer, scriptUrl } from './env';
import type { FetchPatch } from './fetch';
import { installFetchHook } from './fetch';
import type { UrlPattern } from './filter';
import type { ClientMessage, HelloMessage, ServerMessage } from './protocol';
import { DEFAULT_PATH, DEFAULT_PORT, PROTOCOL_VERSION } from './protocol';
import { abortAllReplays, abortReplay, runReplay } from './replay';
import type { SocketCtor, TransportStatus } from './transport';
import { Transport } from './transport';
import type { WebSocketPatch } from './websocket';
import { installWebSocketHook } from './websocket';
import type { XhrPatch } from './xhr';
import { installXhrHook } from './xhr';

declare const __DEV__: boolean | undefined;

export const VERSION = '0.1.0';
export const LIB_NAME = '@kinebot/kinereqlens-react-native';

export interface KineReqLensOptions {
  /** Pairing token shown by the receiver (required; the receiver rejects connections without it). */
  token: string;
  /** Receiver host. Default: defaultHost() (simulator / emulator / Metro host logic). */
  host?: string;
  /** Receiver port. Default 8790. */
  port?: number;
  /** Receiver path. Default '/kinereqlens'. */
  path?: string;
  /** Default: __DEV__. When false, startKineReqLens does nothing. */
  enabled?: boolean;
  /** Capture request/response bodies (default true). */
  captureBodies?: boolean;
  /** Extra URLs never captured: substring (string) or RegExp, matched against the full URL. */
  ignoreUrls?: UrlPattern[];
  /** Per-body caps in bytes (default 1 MB request, 2 MB response); bodies above are truncated (flagged). */
  requestBodyCap?: number;
  responseBodyCap?: number;
  /** Per-frame cap for WebSocket payloads (default 256 KB). */
  wsFrameCap?: number;
  /** Capture WebSockets (default true). */
  captureWebSockets?: boolean;
  /** Captures held while the receiver is unreachable (default 500; oldest dropped first). */
  bufferSize?: number;
  /** Add "Open kineReqLens" to the React Native dev menu (default true). */
  devMenu?: boolean;
  /** Reconnect backoff (default 500 ms doubling up to 30 s). */
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  /** Handshake info overrides. */
  appName?: string;
  bundleId?: string;
  deviceName?: string;
  /** Connection status callback (connecting / connected / disconnected / rejected / stopped). */
  onStatus?: (status: TransportStatus, detail?: string) => void;
  /** Log connection problems with console.log (default true). */
  log?: boolean;
  /**
   * Advanced / tests: the global object to patch (default globalThis) and the `react-native` module to read
   * (default require('react-native')).
   */
  global?: Record<string, unknown>;
  reactNative?: ReactNativeLike | null;
}

export interface KineReqLensHandle {
  /** ws:// URL of the receiver. */
  readonly url: string;
  readonly session: string;
  status(): TransportStatus;
  /** Ask the desktop side to open the standalone kineReqLens tab. */
  openUi(): void;
  stop(): void;
}

interface Instance extends KineReqLensHandle {
  transport: Transport;
  restore(): void;
}

const MB = 1024 * 1024;
let instance: Instance | null = null;
let generation = 0;
let counter = 0;

function randomId(): string {
  let out = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function devDefault(): boolean {
  try {
    return typeof __DEV__ !== 'undefined' && !!__DEV__;
  } catch {
    return false;
  }
}

function addDevMenu(rn: ReactNativeLike | null): void {
  try {
    const devSettings = rn?.DevSettings;
    const add = devSettings?.addMenuItem;
    if (!devSettings || typeof add !== 'function') return;
    // Menu items cannot be removed: add ours once per DevSettings (one per JS context), also when this module
    // is evaluated twice (Fast Refresh of the entry file, duplicated package copies).
    const g = globalThis as { __kineReqLensMenus?: WeakSet<object> };
    const added = g.__kineReqLensMenus ?? (g.__kineReqLensMenus = new WeakSet<object>());
    if (added.has(devSettings)) return;
    added.add(devSettings);
    add.call(devSettings, 'Open kineReqLens', () => {
      openKineReqLens();
    });
  } catch {
    /* no dev menu */
  }
}

/**
 * Start capturing. Returns null when disabled (default: outside __DEV__), when no token is given, or when
 * the environment has nothing to patch. Calling it again replaces the previous instance.
 */
export function startKineReqLens(options: KineReqLensOptions): KineReqLensHandle | null {
  try {
    const enabled = options?.enabled ?? devDefault();
    if (!enabled) return null;
    const log = options.log === false ? undefined : (message: string) => console.log(`[kineReqLens] ${message}`);
    if (typeof options.token !== 'string' || !options.token) {
      log?.('not started: pass the pairing token shown by the receiver, startKineReqLens({ token })');
      return null;
    }
    if (instance) stopKineReqLens();

    if (options.reactNative !== undefined) _setReactNativeModule(options.reactNative);
    const rn = getReactNative();
    const target = options.global ?? (globalThis as unknown as Record<string, unknown>);
    const host = options.host || defaultHost();
    const port = String(positive(options.port, DEFAULT_PORT));
    const path = options.path || DEFAULT_PATH;
    const url = `ws://${formatHost(host)}:${port}${path}`;
    const OriginalWebSocket = target.WebSocket as SocketCtor | undefined;
    const originalFetch = target.fetch;
    if (typeof OriginalWebSocket !== 'function') {
      log?.('not started: WebSocket is not available');
      return null;
    }
    const session = randomId();
    const gen = ++generation;
    const metro = metroServer(scriptUrl(rn));

    let transport: Transport | null = null;
    const runtime: Runtime = {
      gen,
      session,
      config: {
        captureBodies: options.captureBodies !== false,
        requestBodyCap: positive(options.requestBodyCap, 1 * MB),
        responseBodyCap: positive(options.responseBodyCap, 2 * MB),
        wsFrameCap: positive(options.wsFrameCap, 256 * 1024),
        filter: {
          ignoreUrls: Array.isArray(options.ignoreUrls) ? options.ignoreUrls.slice() : [],
          receiver: { host: host.replace(/^\[|\]$/g, '').toLowerCase(), port, path },
          metro,
        },
      },
      send: (message: ClientMessage, key: string | null) => transport?.send(message, key),
      nextId: (prefix = '') => `${session}:${prefix}${++counter}`,
    };

    // Built per connection: AppRegistry usually gets its component after index.js called us.
    const hello = (): HelloMessage => ({
      t: 'hello',
      v: PROTOCOL_VERSION,
      token: options.token,
      app: appInfo({ appName: options.appName, bundleId: options.bundleId, deviceName: options.deviceName }),
      session,
      lib: { name: LIB_NAME, version: VERSION },
      capabilities: ['http', 'websocket', 'replay', 'open-ui'],
    });
    const onMessage = (message: ServerMessage): void => {
      if (message.t === 'replay') {
        runReplay(originalFetch, message.data, (result) => transport?.send({ t: 'replay-result', data: result }, null));
      } else if (message.t === 'abort') abortReplay(message.runId);
    };
    transport = new Transport({
      url,
      WebSocketImpl: OriginalWebSocket,
      hello,
      onMessage,
      bufferSize: Math.max(1, Math.floor(positive(options.bufferSize, 500))),
      minDelayMs: positive(options.reconnect?.minDelayMs, 500),
      maxDelayMs: positive(options.reconnect?.maxDelayMs, 30_000),
      handshakeTimeoutMs: 10_000,
      onStatus: options.onStatus,
      log,
    });

    const patches: Array<XhrPatch | FetchPatch | WebSocketPatch> = [];
    const xhr = installXhrHook(gen, target.XMLHttpRequest);
    if (xhr) patches.push(xhr);
    const fetchPatch = installFetchHook(gen, target);
    if (fetchPatch) patches.push(fetchPatch);
    if (options.captureWebSockets !== false) {
      const ws = installWebSocketHook(gen, target);
      if (ws) patches.push(ws);
    }
    setRuntime(runtime);

    const created: Instance = {
      url,
      session,
      transport,
      status: () => created.transport.status,
      openUi: () => created.transport.send({ t: 'open-ui' }, null),
      stop: () => {
        if (instance === created) stopKineReqLens();
      },
      restore: () => {
        for (const patch of patches.reverse()) {
          try {
            patch.restore();
          } catch {
            /* ignore */
          }
        }
      },
    };
    instance = created;
    if (options.devMenu !== false) addDevMenu(rn);
    transport.start();
    return created;
  } catch (error) {
    try {
      console.log(`[kineReqLens] failed to start: ${String(error)}`);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Stop capturing, close the receiver connection and restore fetch / XMLHttpRequest / WebSocket. */
export function stopKineReqLens(): void {
  const current = instance;
  if (!current) return;
  instance = null;
  try {
    setRuntime(null);
    abortAllReplays();
    current.restore();
    current.transport.stop();
  } catch {
    /* ignore */
  }
}

/** Ask the receiver to open the standalone kineReqLens tab (what the dev menu item does). */
export function openKineReqLens(): void {
  try {
    instance?.openUi();
  } catch {
    /* ignore */
  }
}

export function isKineReqLensRunning(): boolean {
  return instance !== null;
}

export function getKineReqLensStatus(): TransportStatus | 'off' {
  return instance ? instance.status() : 'off';
}

export { defaultHost, resolveDefaultHost, isAndroidEmulator, bundleIdFromScriptUrl } from './env';
export type { ReactNativeLike, HostInputs } from './env';
export type { UrlPattern } from './filter';
export type { TransportStatus } from './transport';
export * from './protocol';
