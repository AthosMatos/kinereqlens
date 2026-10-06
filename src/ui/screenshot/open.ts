// Where the screenshot / Find in page commands get the page connection, and how a capture is opened in the overlay's
// Screenshot view from outside the tool (the MCP `screenshot` tool with `open`, the response viewer's camera button).
// The App registers its bridge (useShotControl); opening switches the panel's view (ws/ViewSwitch.tsx setPanelView)
// and the tool selects the requested capture (store.ts requestShotSelection).
import { useEffect } from 'preact/hooks';
import type { ReqlensBridge } from '../../shared/types';
import { isFindHost } from '../find/controller';
import type { FindHost } from '../find/controller';
import { setPanelView } from '../ws/ViewSwitch';
import { isShotHost } from './engine';
import type { ShotHost } from './engine';
import { requestShotSelection } from './store';

/** The panel's bridge to the page with the screenshot and Find in page calls (RemoteBridge). */
export type ControlHost = ReqlensBridge & ShotHost & FindHost;

export function isControlHost(value: unknown): value is ControlHost {
  return isShotHost(value) && isFindHost(value) && typeof (value as Partial<ReqlensBridge>).getEntries === 'function';
}

let host: ControlHost | null = null;

/** The bridge the App registered (null outside the overlay, e.g. in the standalone tab). */
export function controlHost(): ControlHost | null {
  return host;
}

/** Register (or clear) the page connection the commands use. */
export function registerControlHost(next: ControlHost | null): void {
  host = next;
}

/** Show capture `id` in the overlay's Screenshot view (switches the panel's view; showing the overlay is up to the caller). */
export function openShotInView(id: string): void {
  requestShotSelection(id);
  setPanelView('shot');
}

/** App: the page connection the screenshot / find commands (src/ui/control/shot.ts) use while the App is mounted. */
export function useShotControl(bridge: ReqlensBridge): void {
  useEffect(() => {
    if (!isControlHost(bridge)) return;
    registerControlHost(bridge);
    return () => {
      if (host === bridge) host = null;
    };
  }, [bridge]);
}
