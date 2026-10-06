/**
 * hook.js — MAIN world, classic script, document_start, every frame (docs/ARCHITECTURE.md §4.1).
 *
 * Patches fetch / XMLHttpRequest / navigator.sendBeacon / WebSocket to capture full requests and responses, buffers
 * captures until the content script says whether this tab is recording, and runs page-mode replays with the
 * native fetch. It must never break the page: every capture step is guarded, natives are called with the
 * page's own receiver and arguments, and in 'off' mode the wrappers are a single flag check.
 */
// natives must be evaluated first: it snapshots the globals before anything else can touch them.
import { defineProperty, W } from './natives';
import { startChannel } from './channel';
import { installFetchHook } from './fetchHook';
import { installXhrHook } from './xhrHook';
import { installBeaconHook } from './beaconHook';
import { installCancelFollow } from './cancelFollow';
import { abortReplay, runReplay } from './replay';
import { installWsHook, wsSend } from './wsHook';
import { locateComponents } from './components';
import { setLanguages } from './language';

const INSTALLED = Symbol.for('reqlens.hook.v1');

function install(): void {
  const global = W as unknown as Record<symbol, unknown>;
  // A second injection (extension reload / programmatic re-inject) keeps the existing hook, which accepts
  // the new content script's 'connect'.
  if (global[INSTALLED]) return;
  defineProperty(W, INSTALLED, { value: true, enumerable: false, configurable: false, writable: false });
  for (const installHook of [installFetchHook, installXhrHook, installBeaconHook, installCancelFollow, installWsHook]) {
    try {
      installHook();
    } catch {
      /* this API stays unpatched; the others still work */
    }
  }
  startChannel({ replay: runReplay, abort: abortReplay, wsSend, components: locateComponents, lang: setLanguages });
}

try {
  install();
} catch {
  /* never throw into the page */
}
