/**
 * content.js start-up: replace a previous instance living in the same isolated world (programmatic
 * re-injection, extension reload), publish the bridge in the top frame and start the per-frame app.
 */
import type { ReqlensBridge } from '../shared/types';
import type { CarriedState } from './app';
import { ContentApp } from './app';

/** Disposer every content-script instance (top frame and subframes) leaves on the global object. */
interface InstanceHandle {
  dispose(): void;
}

type ContentGlobal = typeof globalThis & {
  __reqlens?: ReqlensBridge;
  __reqlensContent?: InstanceHandle;
};

function isTopFrame(win: Window): boolean {
  try {
    return win.top === win;
  } catch {
    return false;
  }
}

/** Read what a previous bridge can hand over (it may come from an older build: every call is guarded). */
function carryFrom(previous: ReqlensBridge): CarriedState {
  const carried: CarriedState = {};
  try {
    carried.entries = previous.getEntries();
  } catch {
    /* nothing to carry */
  }
  try {
    carried.tabState = previous.getTabState();
  } catch {
    /* worker will tell */
  }
  try {
    const late = previous.getCaptureInfo().lateInjection;
    if (typeof late === 'boolean') carried.lateInjection = late;
  } catch {
    /* fresh value */
  }
  return carried;
}

/** Dispose the previous instance (replace semantics) and return what it handed over. */
function takeOver(g: ContentGlobal): CarriedState | undefined {
  let carried: CarriedState | undefined;
  const previous = g.__reqlens;
  if (previous && typeof previous === 'object') {
    carried = carryFrom(previous);
    try {
      previous.dispose();
    } catch {
      /* half torn down already */
    }
  }
  const handle = g.__reqlensContent;
  if (handle && typeof handle.dispose === 'function') {
    try {
      handle.dispose();
    } catch {
      /* idem */
    }
  }
  delete g.__reqlens;
  delete g.__reqlensContent;
  return carried;
}

/** Start content.js in this frame. Returns the app (null when start-up failed). */
export function bootContentScript(win: Window = window): ContentApp | null {
  const g = globalThis as ContentGlobal;
  const lateInjection = win.document.readyState !== 'loading';
  const carried = takeOver(g);
  const handle: InstanceHandle = { dispose: () => app.dispose() };
  const app: ContentApp = new ContentApp({
    win,
    isTop: isTopFrame(win),
    lateInjection,
    carried,
    // However it is disposed (bridge.dispose() or a successor), unpublish what still points at it.
    onDisposed: () => {
      if (g.__reqlensContent === handle) delete g.__reqlensContent;
      if (app.bridge && g.__reqlens === app.bridge) delete g.__reqlens;
    },
  });
  g.__reqlensContent = handle;
  // The bridge must be on the global object before ui.js can be injected (ui.js compares its identity).
  if (app.bridge) g.__reqlens = app.bridge;
  app.start();
  return app;
}
