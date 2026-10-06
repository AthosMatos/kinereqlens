// Settings → React Native: enable toggle (asks for the optional nativeMessaging permission inside the click), the
// receiver status (listening host:port, connected apps), the pairing token (copy / regenerate), the LAN toggle
// with its warning, the receiver port, the copyable setup snippet with the dev-menu tip, and "Open React Native
// window". Rendered inside the shell's SettingsForm (overlay panel and standalone tab).
import { useEffect, useState } from 'preact/hooks';
import { RN_DEFAULT_PORT, RN_MAX_PORT, RN_MIN_PORT, rnSessionLabel, rnSetupSnippet } from '../../shared/rn-protocol';
import type { Settings, SettingsPatch } from '../../shared/types';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { setupCommands } from '../export/claudeStatus';
import { Command, CopyAction } from '../export/controls';
import { requestBridgePermission } from '../panel/claudeLink';
import { openRnWindow, regenerateRnToken, useRnStatus } from './status';
import { rnStatusView } from './view';

export interface RnSettingsProps {
  settings: Settings;
  onChange(patch: SettingsPatch): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function RnSettings({ settings, onChange }: RnSettingsProps) {
  const status = useRnStatus();
  const [asking, setAsking] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [portText, setPortText] = useState(String(settings.rnPort));
  useEffect(() => setPortText(String(settings.rnPort)), [settings.rnPort]);
  useEffect(() => {
    if (optimistic === null) return;
    if (settings.rnEnabled === optimistic) {
      setOptimistic(null);
      return;
    }
    if (asking) return;
    const timer = setTimeout(() => setOptimistic(null), 4000);
    return () => clearTimeout(timer);
  }, [settings.rnEnabled, optimistic, asking]);

  const enabled = optimistic ?? settings.rnEnabled;
  const view = rnStatusView(status, settings.rnEnabled);
  const receiver = status.receiver;
  const token = receiver?.token ?? '';
  const apps = status.sessions.filter((s) => s.connected);
  const install = setupCommands(status.extensionId).install;

  /** Must run synchronously inside the click: chrome.permissions.request needs the user gesture. */
  const grant = (then?: () => void, otherwise?: () => void) => {
    let pending: Promise<boolean>;
    try {
      pending = requestBridgePermission();
    } catch (err) {
      pending = Promise.reject(err);
    }
    setAsking(true);
    pending
      .then(
        (granted) => {
          if (granted) then?.();
          else {
            otherwise?.();
            toast('Permission not granted: React Native support stays off', 'warn');
          }
        },
        (err: unknown) => {
          otherwise?.();
          toast(`Could not request the permission: ${errorText(err)}`, 'error');
        },
      )
      .finally(() => setAsking(false));
  };

  const onToggle = (box: HTMLInputElement) => {
    const on = box.checked;
    if (asking) {
      box.checked = enabled;
      return;
    }
    setOptimistic(on);
    if (!on) {
      onChange({ rnEnabled: false });
      return;
    }
    grant(
      () => onChange({ rnEnabled: true }),
      () => setOptimistic(null),
    );
  };

  const commitPort = () => {
    const n = Number(portText.trim());
    if (!Number.isInteger(n) || n < RN_MIN_PORT || n > RN_MAX_PORT) {
      setPortText(String(settings.rnPort));
      toast(`The port must be a number from ${RN_MIN_PORT} to ${RN_MAX_PORT}`, 'warn');
      return;
    }
    if (n !== settings.rnPort) onChange({ rnPort: n });
  };

  return (
    <section class="rl-claude rl-rn" data-testid="rl-rn-section" aria-labelledby="rl-rn-title">
      <div class="rl-claude__head">
        <span class="rl-settings__title" id="rl-rn-title">
          React Native
        </span>
        <span class={`rl-claude__status rl-claude__status--${view.tone}`} data-testid="rl-rn-status" data-state={view.state} role="status" aria-live="polite">
          {view.tone === 'busy' ? <span class="rl-spinner rl-claude__spinner" aria-hidden="true" /> : <span class="rl-claude__dot" aria-hidden="true" />}
          <span class="rl-claude__label">{view.label}</span>
        </span>
      </div>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-rn-enable"
          checked={enabled}
          aria-busy={asking ? 'true' : undefined}
          onChange={(e) => onToggle(e.currentTarget)}
        />
        <span>Receive traffic from React Native apps</span>
        {asking ? <span class="rl-spinner rl-claude__spinner" aria-hidden="true" /> : null}
      </label>

      {view.detail ? (
        <div class={`rl-claude__detail rl-claude__detail--${view.tone}`} data-testid="rl-rn-detail">
          {view.detail}
          {settings.rnEnabled && !status.permission ? (
            <button type="button" class="rl-export-link" disabled={asking} onClick={() => grant()}>
              Grant permission
            </button>
          ) : null}
        </div>
      ) : null}
      {view.state === 'not-installed' ? <Command command={install} testId="rl-rn-cmd-install" copyTitle="Copy the install command" /> : null}

      {settings.rnEnabled && apps.length > 0 ? (
        <ul class="rl-rn__apps" data-testid="rl-rn-apps">
          {apps.map((s) => (
            <li key={s.session} class="rl-rn__app" data-testid="rl-rn-app" data-session={s.session}>
              <span class="rl-claude__dot" aria-hidden="true" />
              <span class="rl-truncate">{rnSessionLabel(s)}</span>
              {s.address ? <span class="rl-faint rl-mono">{s.address.replace(/^::ffff:/, '')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {settings.rnEnabled ? (
        <>
          <div class="rl-settings__field">
            <span class="rl-settings__label">Pairing token</span>
            <div class="rl-export-cmd rl-rn__token">
              <code class="rl-export-cmd__text" data-testid="rl-rn-token">
                {token || '…'}
              </code>
              {token ? <CopyAction iconOnly text={() => token} label="Copy the pairing token" done="Pairing token copied" testId="rl-rn-token-copy" /> : null}
              <button
                type="button"
                class="rl-icon-btn rl-icon-btn--sm"
                title="New pairing token (connected apps must restart with it)"
                aria-label="Regenerate the pairing token"
                data-testid="rl-rn-token-regenerate"
                disabled={!token}
                onClick={() => {
                  if (regenerateRnToken()) toast('New pairing token: update startKineReqLens({ token }) in your app', 'info');
                }}
              >
                <Icon name="reload" size={12} />
              </button>
            </div>
          </div>

          <div class="rl-settings__field">
            <span class="rl-settings__label">Setup — at the top of the app's index.js</span>
            <Command command={rnSetupSnippet(token || 'PAIRING-TOKEN')} testId="rl-rn-snippet" copyTitle="Copy the setup snippet" />
            <div class="rl-rn__hint rl-faint" data-testid="rl-rn-devmenu-tip">
              Install <code class="rl-mono">react-native/</code> of the kineReqLens repository as a dev dependency. Then shake the device (or
              press Cmd+D / Cmd+M) → Dev menu → <strong>Open kineReqLens</strong> opens this window.
            </div>
          </div>

          <label class="rl-settings__check">
            <input
              type="checkbox"
              class="rl-checkbox"
              data-testid="rl-rn-lan"
              checked={settings.rnListenLan}
              aria-describedby="rl-rn-lan-warning"
              onChange={(e) => onChange({ rnListenLan: e.currentTarget.checked })}
            />
            <span>Accept physical devices on the local network</span>
          </label>
          <div class={`rl-claude__warning${settings.rnListenLan ? ' rl-claude__warning--active' : ''}`} id="rl-rn-lan-warning" data-testid="rl-rn-lan-warning">
            <Icon name="warning" size={11} class="rl-claude__warning-icon" />
            <span>
              Listens on 0.0.0.0: anyone on this network can reach the receiver (they still need the pairing token). Use it on trusted
              networks only; simulators, emulators and <code class="rl-mono">adb reverse</code> work without it.
              {settings.rnListenLan && receiver?.addresses.length ? ` Devices connect to ${receiver.addresses.join(' or ')}.` : ''}
            </span>
          </div>

          <label class="rl-settings__field rl-settings__field--inline">
            <span class="rl-settings__label">Port</span>
            <input
              type="number"
              class="rl-input rl-settings__number"
              min={RN_MIN_PORT}
              max={RN_MAX_PORT}
              placeholder={String(RN_DEFAULT_PORT)}
              value={portText}
              data-testid="rl-rn-port"
              onInput={(e) => setPortText(e.currentTarget.value)}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitPort();
                }
              }}
            />
          </label>

          <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-rn-open" onClick={() => openRnWindow()}>
            <Icon name="external" size={12} />
            Open React Native window
          </button>
        </>
      ) : null}
    </section>
  );
}
