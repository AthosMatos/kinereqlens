// Preact hooks over the panel's WebSocket mirror. Re-renders are throttled to one per animation frame, so a
// busy socket streams into the views without janking the panel.
import { useEffect, useState } from 'preact/hooks';
import type { WsInspector } from '../../lib/ws-inspector';
import { useBridge } from '../hooks';
import { wsInspectorOf } from './store';

/** The WebSocket inspector of the current bridge (null when the host does not support it). */
export function useWsInspector(): WsInspector | null {
  const bridge = useBridge();
  return bridge.ws ? wsInspectorOf(bridge.ws) : null;
}

/**
 * Re-render when the inspector changes, at most once per animation frame. Returns its version. `active=false`
 * stops following (a hidden view); it catches up when it becomes active again.
 */
export function useWsVersion(inspector: WsInspector | null, active = true): number {
  const [version, setVersion] = useState(() => inspector?.version ?? 0);
  useEffect(() => {
    if (!inspector || !active) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion(inspector.version);
      });
    };
    setVersion(inspector.version);
    const off = inspector.subscribe(update);
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [inspector, active]);
  return version;
}

/** Live connection counts for the navigation rail's WebSocket item (re-renders only when they change). */
export function useWsCounts(): { connections: number; open: number } {
  const inspector = useWsInspector();
  const read = () => {
    if (!inspector) return { connections: 0, open: 0 };
    const list = inspector.connections();
    let open = 0;
    for (const c of list) if (c.state === 'open' || c.state === 'connecting') open++;
    return { connections: list.length, open };
  };
  const [counts, setCounts] = useState(read);
  useEffect(() => {
    if (!inspector) return;
    const update = () =>
      setCounts((prev) => {
        const next = read();
        return prev.connections === next.connections && prev.open === next.open ? prev : next;
      });
    update();
    return inspector.subscribe(update);
  }, [inspector]);
  return counts;
}

/** Wall clock that ticks every `ms` while `active` (relative times, live durations). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
