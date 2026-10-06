/**
 * The ReqlensBridge published on `globalThis.__reqlens` in the top frame for the lazily injected UI bundle
 * (docs/ARCHITECTURE.md §4.2). This adapter only enforces the contract — every method is bound, nothing
 * throws into the UI, `replay` never rejects and the async setters always resolve — while `BridgeHost`
 * (the top-frame content app) does the work.
 */
import type {
  CaptureInfo,
  ManualEntryInit,
  ReplayRequest,
  ReplayResult,
  ReqlensBridge,
  RequestEntry,
  Settings,
  SettingsPatch,
  TabState,
} from '../shared/types';
import type { WsBridge, WsDelta } from '../lib/ws';
import type { ComponentLocateResult, ComponentQuery } from '../shared/initiator-protocol';
import { sanitizeComponentQuery } from '../shared/initiator-protocol';
import { errorMessage } from './runtime';
import { errorReplayResult } from './validate';

/** What the bridge delegates to (implemented by the top-frame ContentApp). */
export interface BridgeHost {
  getEntries(): RequestEntry[];
  subscribeEntries(fn: () => void): () => void;
  clearEntries(): void;
  addManualEntry(init?: ManualEntryInit): RequestEntry;
  getTabState(): TabState;
  subscribeTabState(fn: (state: TabState) => void): () => void;
  setTabState(patch: Partial<TabState>): Promise<TabState>;
  getSettings(): Settings;
  subscribeSettings(fn: (settings: Settings) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  replay(req: ReplayRequest): Promise<ReplayResult>;
  abortReplay(runId: string): void;
  getCaptureInfo(): CaptureInfo;
  subscribeCaptureInfo(fn: (info: CaptureInfo) => void): () => void;
  reloadPage(): void;
  setProtectedEntries(ids: string[]): void;
  /** Initiator tab: component lookup in the top frame's page (hook). */
  locateComponents?(query: ComponentQuery): Promise<ComponentLocateResult>;
  dispose(): void;
}

const noop = (): void => undefined;

/** Subscribe, isolating the caller from host failures; always returns a callable unsubscribe. */
function safeSubscribe<A extends unknown[]>(
  subscribe: (fn: (...args: A) => void) => () => void,
  fn: (...args: A) => void,
): () => void {
  if (typeof fn !== 'function') return noop;
  try {
    const unsubscribe = subscribe(fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      try {
        unsubscribe();
      } catch {
        /* host already torn down */
      }
    };
  } catch {
    return noop;
  }
}

/** Run an async host call; on failure resolve with `fallback()` instead of rejecting. */
async function settle<T>(run: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback();
  }
}

/** Guarded view of the host's WebSocket store (nothing throws into the UI). */
function safeWs(ws: WsBridge): WsBridge {
  return Object.freeze({
    snapshot: (): WsDelta => {
      try {
        return ws.snapshot();
      } catch {
        return { reset: true, connections: [], frames: [], removed: [] };
      }
    },
    subscribe: (fn: (delta: WsDelta) => void) => safeSubscribe(ws.subscribe.bind(ws), fn),
    clear: () => {
      try {
        ws.clear();
      } catch {
        /* store gone */
      }
    },
    send: (wsId: string, text: string) => settle(() => ws.send(wsId, text), () => ({ ok: false, error: 'The page did not answer' })),
  });
}

/** Build the bridge object for `host` (`ws`: the top frame's WebSocket store). */
export function createBridge(host: BridgeHost, version: string, ws?: WsBridge): ReqlensBridge {
  const bridge: ReqlensBridge = {
    ...(ws ? { ws: safeWs(ws) } : {}),
    version,
    getEntries: () => host.getEntries(),
    subscribeEntries: (fn) => safeSubscribe(host.subscribeEntries.bind(host), fn),
    clearEntries: () => {
      try {
        host.clearEntries();
      } catch {
        /* nothing to clear */
      }
    },
    addManualEntry: (init) => host.addManualEntry(init),
    getTabState: () => host.getTabState(),
    subscribeTabState: (fn) => safeSubscribe(host.subscribeTabState.bind(host), fn),
    setTabState: (patch) => settle(() => host.setTabState(patch), () => host.getTabState()),
    getSettings: () => host.getSettings(),
    subscribeSettings: (fn) => safeSubscribe(host.subscribeSettings.bind(host), fn),
    updateSettings: (patch) => settle(() => host.updateSettings(patch), () => host.getSettings()),
    replay: (req) => {
      const start = Date.now();
      const fail = (error: unknown): ReplayResult =>
        errorReplayResult(
          { runId: typeof req?.runId === 'string' ? req.runId : '', url: typeof req?.url === 'string' ? req.url : '' },
          errorMessage(error),
          start,
          Date.now(),
        );
      try {
        return host.replay(req).catch(fail);
      } catch (error) {
        return Promise.resolve(fail(error));
      }
    },
    abortReplay: (runId) => {
      try {
        host.abortReplay(runId);
      } catch {
        /* the run is gone */
      }
    },
    getCaptureInfo: () => host.getCaptureInfo(),
    subscribeCaptureInfo: (fn) => safeSubscribe(host.subscribeCaptureInfo.bind(host), fn),
    reloadPage: () => host.reloadPage(),
    setProtectedEntries: (ids) => {
      try {
        host.setProtectedEntries(ids);
      } catch {
        /* store gone */
      }
    },
    dispose: () => host.dispose(),
  };
  if (host.locateComponents) {
    const locate = host.locateComponents.bind(host);
    bridge.locateComponents = (query) => {
      const clean = sanitizeComponentQuery(query);
      const fail = (error: unknown): ComponentLocateResult => ({
        frameworks: [],
        matches: clean.names.map((name) => ({ name, count: 0, instances: [] })),
        error: errorMessage(error),
      });
      try {
        return locate(clean).catch(fail);
      } catch (error) {
        return Promise.resolve(fail(error));
      }
    };
  }
  return Object.freeze(bridge);
}
