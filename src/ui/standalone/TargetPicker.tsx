// Header control of the standalone React Native tab: which app session the list shows. A select when several
// apps / devices sent traffic, else the app's label; the connection state as a dot.
import { useEffect, useState } from 'preact/hooks';
import { rnSessionLabel } from '../../shared/rn-protocol';
import type { RnStatus } from '../../shared/rn-protocol';
import type { StandaloneBridge, StandaloneTarget } from './bridge';

function useTargets(bridge: StandaloneBridge): { targets: StandaloneTarget[]; current: string | null; status: RnStatus | null } {
  const read = () => ({ targets: bridge.getTargets(), current: bridge.currentSession, status: bridge.getStatus() });
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    update();
    const offTargets = bridge.subscribeTargets(update);
    const offStatus = bridge.subscribeStatus(update);
    return () => {
      offTargets();
      offStatus();
    };
  }, [bridge]);
  return value;
}

/** Label of a target ("DemoApp · iOS · iPhone 15", or its session id before the app said hello). */
export function targetLabel(target: StandaloneTarget): string {
  if (target.session === 'scratch' && !target.info) return 'Composed requests';
  return target.info ? rnSessionLabel(target.info) : `Session ${target.session}`;
}

function idleText(status: RnStatus | null): string {
  if (!status || !status.enabled) return 'React Native is off — turn it on in Settings';
  if (status.host !== 'connected') return 'Starting the receiver…';
  if (status.receiver?.state === 'error') return 'The receiver is not listening — see Settings';
  return 'Waiting for a React Native app…';
}

export function TargetPicker({ bridge }: { bridge: StandaloneBridge }) {
  const { targets, current, status } = useTargets(bridge);
  const selected = targets.find((t) => t.session === current) ?? null;
  useEffect(() => {
    document.title = selected ? `kineReqLens — ${targetLabel(selected)}` : 'kineReqLens — React Native';
  }, [selected]);

  if (targets.length === 0) {
    return (
      <div class="rl-rn-targets" data-testid="rl-rn-targets" data-count="0">
        <span class="rl-rn-targets__idle rl-faint" data-testid="rl-rn-target-label">
          {idleText(status)}
        </span>
      </div>
    );
  }
  const dot = (target: StandaloneTarget | null) => (
    <span
      class={`rl-rn-targets__dot${target?.connected ? ' rl-rn-targets__dot--on' : ''}`}
      title={target?.connected ? 'Connected' : 'Disconnected'}
      aria-hidden="true"
    />
  );
  return (
    <div class="rl-rn-targets" data-testid="rl-rn-targets" data-count={String(targets.length)} data-connected={selected?.connected ? 'true' : 'false'}>
      {dot(selected)}
      {targets.length > 1 ? (
        <select
          class="rl-select rl-rn-targets__select"
          aria-label="React Native app"
          data-testid="rl-rn-target"
          value={current ?? ''}
          onChange={(e) => bridge.select(e.currentTarget.value)}
        >
          {targets.map((t) => (
            <option key={t.session} value={t.session}>
              {targetLabel(t)}
              {t.connected ? '' : ' (disconnected)'}
              {` — ${t.entries}`}
            </option>
          ))}
        </select>
      ) : (
        <span class="rl-rn-targets__label rl-truncate" data-testid="rl-rn-target-label" title={selected ? targetLabel(selected) : ''}>
          {selected ? targetLabel(selected) : ''}
          {selected && !selected.connected ? <span class="rl-faint"> (disconnected)</span> : null}
        </span>
      )}
      {selected && selected.dropped > 0 ? (
        <span class="rl-rn-targets__dropped rl-faint" title="Captures the app dropped while kineReqLens was unreachable">
          {selected.dropped} dropped
        </span>
      ) : null}
    </div>
  );
}
