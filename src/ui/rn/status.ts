// React Native status for extension pages (Settings → React Native, the standalone tab): a Port
// 'reqlens-rn' to the worker (src/background/rn/index.ts), opened on first use and re-opened when the worker
// restarts. Also the actions: regenerate the pairing token, open the standalone tab.
import { useEffect, useState } from 'preact/hooks';
import { RN_STATUS_PORT } from '../../shared/rn-protocol';
import type { RnStatus, RnStatusToWorker } from '../../shared/rn-protocol';

const RECONNECT_MS = 1000;

function extensionId(): string {
  try {
    return chrome.runtime?.id ?? '';
  } catch {
    return '';
  }
}

let status: RnStatus = { enabled: false, permission: false, host: 'off', receiver: null, sessions: [], extensionId: extensionId() };
let port: chrome.runtime.Port | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(status: RnStatus) => void>();

function isStatus(value: unknown): value is RnStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<RnStatus>;
  return typeof s.enabled === 'boolean' && typeof s.host === 'string' && Array.isArray(s.sessions);
}

/** Apply a status pushed by the worker (also used by the standalone port, which carries it too). */
export function setRnStatus(next: RnStatus): void {
  if (!isStatus(next)) return;
  status = next;
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch (err) {
      console.error('[kineReqLens] rn status listener failed', err);
    }
  }
}

function connect(): void {
  if (port || typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  let next: chrome.runtime.Port;
  try {
    next = chrome.runtime.connect({ name: RN_STATUS_PORT });
  } catch {
    return;
  }
  port = next;
  next.onMessage.addListener((message: unknown) => {
    const m = message as { t?: string; status?: unknown };
    if (m?.t === 'status' && isStatus(m.status)) setRnStatus(m.status);
  });
  next.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === next) port = null;
    // The worker restarted (or the extension reloaded): reconnect while someone is listening.
    if (listeners.size > 0 && retry === null) {
      retry = setTimeout(() => {
        retry = null;
        if (listeners.size > 0) connect();
      }, RECONNECT_MS);
    }
  });
}

export function getRnStatus(): RnStatus {
  return status;
}

export function subscribeRnStatus(fn: (status: RnStatus) => void): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
  };
}

/** The live React Native status (re-renders on change). */
export function useRnStatus(): RnStatus {
  const [value, setValue] = useState(getRnStatus);
  useEffect(() => {
    setValue(getRnStatus());
    return subscribeRnStatus(setValue);
  }, []);
  return value;
}

function send(message: RnStatusToWorker): boolean {
  connect();
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Ask the hub for a new pairing token (connected apps must be restarted with it). */
export function regenerateRnToken(): boolean {
  return send({ t: 'regenerate-token' });
}

/** Open (or focus) the standalone React Native tab, showing `session` when given. */
export function openRnWindow(session?: string): boolean {
  return send(session ? { t: 'open-ui', session } : { t: 'open-ui' });
}
