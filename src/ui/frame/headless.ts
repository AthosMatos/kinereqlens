// The overlay as the panel sees it when Claude Code drives kineReqLens without showing it (docs/CLAUDE_INTEGRATION.md
// "Control tools"): an overlay open in the background (`TabState.hidden`, set by the service worker) is a closed
// overlay for the panel and the frame host — invisible, no hit regions, no toasts or pill, no focus — while the tab
// keeps capturing. A panel mounted for Claude while the overlay is closed needs nothing extra: a closed overlay is
// already invisible (the host is `display: none` and its iframe inert, src/ui/frame/host.ts).
import type { ReqlensBridge, TabState } from '../../shared/types';

/** The tab state the panel and the frame host get: `hidden` reads as closed. */
export function panelTabState(state: TabState): TabState {
  return state.open && state.hidden === true ? { open: false, recording: state.recording, preserveLog: state.preserveLog } : state;
}

/** The content script's bridge with the tab state masked by panelTabState (everything else unchanged). */
export function panelBridge(bridge: ReqlensBridge): ReqlensBridge {
  return Object.freeze({
    ...bridge,
    getTabState: () => panelTabState(bridge.getTabState()),
    subscribeTabState: (fn: (state: TabState) => void) => bridge.subscribeTabState((state) => fn(panelTabState(state))),
    setTabState: (patch: Partial<TabState>) => bridge.setTabState(patch).then(panelTabState),
  });
}
