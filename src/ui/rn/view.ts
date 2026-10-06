// Pure view model of Settings → React Native (status pill), unit-tested in tests/unit/rn-standalone.test.ts.
import type { RnStatus } from '../../shared/rn-protocol';

export type RnStateId = 'off' | 'connecting' | 'listening' | 'error' | 'not-installed' | 'permission';

export interface RnStatusView {
  state: RnStateId;
  tone: 'off' | 'busy' | 'ok' | 'warn' | 'error';
  label: string;
  detail: string;
}

function hostLabel(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** What the status pill says (pure; unit-tested). */
export function rnStatusView(status: RnStatus, enabled: boolean): RnStatusView {
  if (!enabled) return { state: 'off', tone: 'off', label: 'Off', detail: '' };
  if (!status.permission) return { state: 'permission', tone: 'warn', label: 'Permission needed', detail: 'kineReqLens needs the native messaging permission to run the receiver.' };
  if (status.host === 'not-installed') {
    return { state: 'not-installed', tone: 'warn', label: 'Bridge not installed', detail: status.hostError ?? 'The local bridge is not installed.' };
  }
  if (status.host === 'error') return { state: 'error', tone: 'error', label: 'Error', detail: status.hostError ?? 'The local bridge stopped.' };
  const receiver = status.receiver;
  if (status.host !== 'connected' || !receiver || receiver.state === 'off') return { state: 'connecting', tone: 'busy', label: 'Starting…', detail: '' };
  if (receiver.state === 'error') return { state: 'error', tone: 'error', label: 'Not listening', detail: receiver.error ?? 'The receiver could not start.' };
  const apps = status.sessions.filter((s) => s.connected).length;
  return {
    state: 'listening',
    tone: 'ok',
    label: `Listening on ${hostLabel(receiver.host, receiver.port)}${apps ? ` · ${apps} app${apps === 1 ? '' : 's'}` : ''}`,
    detail: '',
  };
}

