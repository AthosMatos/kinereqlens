// Find in page, panel side: the JSON viewer's hook. It owns a FindClient for the viewer's tree, asks the controller to
// scan while the viewer is shown and the setting is on, and exposes the results (by JSON node id), the status line
// numbers and the actions (locate, rescan, on / off).
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JNode, ReqlensBridge, Settings } from '../../shared/types';
import { BridgeContext } from '../hooks';
import { toast } from '../components/toast';
import { loadLanguageStatus } from '../language/client';
import { localeHintsOf } from './locales';
import { FindClient, IDLE_SNAPSHOT, findControllerOf, isFindHost } from './controller';
import type { FindHost, FindSnapshot } from './controller';
import { FindScopeContext } from './reveal';
import { captureValueShot } from '../screenshot/elementCapture';
import { isControlHost } from '../screenshot/open';

export interface FindView {
  /** The page side supports it (not the standalone tab). */
  available: boolean;
  /** settings.findInPage. */
  enabled: boolean;
  snapshot: FindSnapshot;
  locate(nodeId: string, path: string, snippet: string): void;
  /** Values shown on the page can be captured (screenshot of the element with the padding). */
  canCapture: boolean;
  /** Screenshot of the element showing the value of `nodeId` (default padding), opened in the Screenshot view. */
  capture(nodeId: string, path: string): void;
  rescan(): void;
  setEnabled(on: boolean): void;
}

/** Settings of the bridge, following changes (null without a bridge). */
function useBridgeSettings(bridge: ReqlensBridge | null): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(() => bridge?.getSettings() ?? null);
  useEffect(() => {
    if (!bridge) return;
    setSettings(bridge.getSettings());
    return bridge.subscribeSettings(setSettings);
  }, [bridge]);
  return settings;
}

export { localeHintsOf };

/**
 * Find in page for a JSON viewer showing `root`. `optIn` is the viewer's prop; `onReturn` runs when the user comes
 * back from the page ("Back to kineReqLens") for one of this viewer's nodes.
 */
export function useFindInPage(root: JNode, optIn: boolean, onReturn: (nodeId: string) => void): FindView {
  const bridge = useContext(BridgeContext);
  const host: (FindHost & ReqlensBridge) | null = optIn && isFindHost(bridge) ? (bridge as FindHost & ReqlensBridge) : null;
  const shown = useContext(FindScopeContext);
  const settings = useBridgeSettings(host);
  const enabled = settings?.findInPage !== false;
  const client = useMemo(() => (host ? new FindClient(root) : null), [host, root]);
  const [snapshot, setSnapshot] = useState<FindSnapshot>(IDLE_SNAPSHOT);
  const returnRef = useRef(onReturn);
  returnRef.current = onReturn;

  const controller = useMemo(() => {
    if (!host) return null;
    void loadLanguageStatus();
    return findControllerOf(host, () => localeHintsOf(host));
  }, [host]);

  useEffect(() => {
    if (!client) {
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }
    setSnapshot(client.snapshot);
    const offChange = client.subscribe(() => setSnapshot(client.snapshot));
    const offReturn = client.onReturn((nodeId) => returnRef.current(nodeId));
    return () => {
      offChange();
      offReturn();
    };
  }, [client]);

  useEffect(() => {
    if (!client || !controller) return;
    controller.want(client, shown && enabled);
    return () => controller.want(client, false);
  }, [client, controller, shown, enabled]);

  const locate = useCallback(
    (nodeId: string, path: string, snippet: string) => {
      if (!client || !controller) return;
      controller.locate(client, nodeId, path, snippet).then(
        (result) => {
          if (result && !result.ok) toast(result.message, 'info');
        },
        (err: unknown) => toast(`Could not show it on the page: ${err instanceof Error ? err.message : String(err)}`, 'error'),
      );
    },
    [client, controller],
  );

  const rescan = useCallback(() => {
    if (client && controller) controller.rescan(client);
  }, [client, controller]);

  const shotHost = host && isControlHost(host) ? host : null;
  const capture = useCallback(
    (nodeId: string, path: string) => {
      const nf = client?.snapshot.byNode.get(nodeId);
      if (!nf || !shotHost) return;
      const { kind, value, key } = nf.candidate;
      captureValueShot(shotHost, key === undefined ? { kind, value } : { kind, value, key }, path).catch((err: unknown) =>
        toast(`Could not capture it: ${err instanceof Error ? err.message : String(err)}`, 'error'),
      );
    },
    [client, shotHost],
  );

  const setEnabled = useCallback(
    (on: boolean) => {
      host?.updateSettings({ findInPage: on }).catch((err: unknown) => toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error'));
    },
    [host],
  );

  return { available: host !== null, enabled, snapshot: enabled ? snapshot : IDLE_SNAPSHOT, locate, canCapture: shotHost !== null && enabled, capture, rescan, setEnabled };
}
