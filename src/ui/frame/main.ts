// Entry of ui.js (injected on demand into the top frame's isolated world, next to content.js): creates the
// overlay host with the panel iframe and serves the content script's bridge to it.
import { PANEL_PAGE } from '../../shared/panel-protocol';
import type { ReqlensBridge, UiMountRecord } from '../../shared/types';
import { panelBridge } from './headless';
import { createFrameHost } from './host';
import { startPanelServer } from './server';

type ReqlensGlobal = typeof globalThis & {
  __reqlens?: ReqlensBridge;
  __reqlensUi?: UiMountRecord;
};

/** How often a mounted UI checks that its bridge is still the current one. */
const BRIDGE_CHECK_MS = 2000;

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isBridge(value: unknown): value is ReqlensBridge {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<Record<keyof ReqlensBridge, unknown>>;
  return typeof b.getEntries === 'function' && typeof b.subscribeEntries === 'function' && typeof b.getTabState === 'function';
}

/**
 * Mount the overlay once per bridge. Injecting ui.js again for the same bridge is a no-op; a new bridge
 * (content script re-injected) replaces the previous UI.
 */
function main(): void {
  const g = globalThis as ReqlensGlobal;
  const bridge = g.__reqlens;
  if (!isBridge(bridge)) {
    console.warn('[kineReqLens] content script bridge not found; overlay not mounted');
    return;
  }
  const existing = g.__reqlensUi;
  if (existing) {
    if (existing.bridge === bridge) return;
    try {
      existing.destroy();
    } catch {
      // The previous instance may already be half torn down; continue with a fresh mount.
    }
  }

  // The panel proves it is the one in our iframe with this nonce (see src/shared/panel-protocol.ts).
  const nonce = randomNonce();
  const frame = createFrameHost(`${chrome.runtime.getURL(PANEL_PAGE)}#${nonce}`);
  const stopServer = startPanelServer(panelBridge(bridge), frame, nonce);
  let destroyed = false;
  // A newer content script may replace the bridge without re-injecting ui.js (e.g. the overlay is closed
  // in that instance). A disposed bridge never notifies again, so unmount instead of showing stale data.
  const bridgeWatch = setInterval(() => {
    if (g.__reqlens !== bridge) record.destroy();
  }, BRIDGE_CHECK_MS);
  const record: UiMountRecord = {
    bridge,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(bridgeWatch);
      try {
        stopServer();
      } finally {
        frame.destroy();
        if (g.__reqlensUi === record) delete g.__reqlensUi;
      }
    },
  };
  // A newer overlay from another world (extension reloaded) took over: unmount this one.
  frame.onStale(() => record.destroy());
  g.__reqlensUi = record;
}

main();
