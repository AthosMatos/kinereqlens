// OWNER: ui-export agent. Settings → Claude Code (spec v0.2 §B.5): enable toggle (asks for the optional
// nativeMessaging permission inside the click), live bridge status, setup steps with copyable commands, and
// the two risky toggles with their warnings. Rendered inside the shell's SettingsForm.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings, SettingsPatch } from '../../shared/types';
import type { ControlTraceItem } from '../../shared/control-protocol';
import { formatClock } from '../../lib/format';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { requestBridgePermission, useBridgeStatus } from '../panel/claudeLink';
import { bridgeStatusView, setupCommands } from './claudeStatus';
import { Command, CopyAction } from './controls';
import { CLAUDE_SECTION_TESTID } from './openSettings';

export interface ClaudeSettingsProps {
  settings: Settings;
  onChange(patch: SettingsPatch): void;
}

function runtimeId(): string {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : '';
  } catch {
    return '';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ClaudeSettings({ settings, onChange }: ClaudeSettingsProps) {
  const status = useBridgeStatus();
  const [asking, setAsking] = useState(false);
  // The enable box follows the click at once (the permission prompt and the settings round trip lag behind).
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => {
    if (optimistic === null) return;
    if (settings.claudeBridge === optimistic) {
      setOptimistic(null);
      return;
    }
    if (asking) return;
    // The save failed (the shell toasts it): fall back to the stored value.
    const timer = setTimeout(() => setOptimistic(null), 4000);
    return () => clearTimeout(timer);
  }, [settings.claudeBridge, optimistic, asking]);
  const enabled = optimistic ?? settings.claudeBridge;
  const view = bridgeStatusView({ ...status, enabled: settings.claudeBridge });
  const extensionId = status.extensionId || runtimeId();
  const commands = setupCommands(extensionId);
  const connected = settings.claudeBridge && status.host === 'connected';

  /** Must run synchronously inside the user's click: chrome.permissions.request needs the gesture. */
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
          if (granted) {
            then?.();
            return;
          }
          otherwise?.();
          toast('Permission not granted: the Claude Code bridge stays off', 'warn');
        },
        (err: unknown) => {
          otherwise?.();
          toast(`Could not request the permission: ${errorText(err)}`, 'error');
        },
      )
      .finally(() => setAsking(false));
  };

  const onToggleEnable = (box: HTMLInputElement) => {
    const on = box.checked;
    if (asking) {
      // A permission prompt is already open: ignore the extra toggle.
      box.checked = enabled;
      return;
    }
    setOptimistic(on);
    if (!on) {
      onChange({ claudeBridge: false });
      return;
    }
    grant(
      () => onChange({ claudeBridge: true }),
      () => setOptimistic(null),
    );
  };

  return (
    <section
      class="rl-claude"
      data-testid={CLAUDE_SECTION_TESTID}
      aria-labelledby="rl-claude-title"
      tabIndex={-1}
    >
      <div class="rl-claude__head">
        <span class="rl-settings__title" id="rl-claude-title">
          Claude Code
        </span>
        <span
          class={`rl-claude__status rl-claude__status--${view.tone}`}
          data-testid="rl-claude-status"
          data-host={settings.claudeBridge ? status.host : 'off'}
          role="status"
          aria-live="polite"
        >
          {view.tone === 'busy' ? <span class="rl-spinner rl-claude__spinner" aria-hidden="true" /> : <span class="rl-claude__dot" aria-hidden="true" />}
          <span class="rl-claude__label">{view.label}</span>
        </span>
      </div>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-claude-enable"
          data-claude-focus=""
          checked={enabled}
          aria-busy={asking ? 'true' : undefined}
          aria-describedby="rl-claude-detail"
          onChange={(e) => onToggleEnable(e.currentTarget)}
        />
        <span>Enable the Claude Code bridge</span>
        {asking ? <span class="rl-spinner rl-claude__spinner" aria-hidden="true" /> : null}
      </label>

      {view.detail ? (
        <div class={`rl-claude__detail rl-claude__detail--${view.tone}`} id="rl-claude-detail" data-testid="rl-claude-detail">
          {view.detail}
          {settings.claudeBridge && !status.permission ? (
            <button type="button" class="rl-export-link" data-testid="rl-claude-grant" disabled={asking} onClick={() => grant()}>
              Grant permission
            </button>
          ) : null}
        </div>
      ) : null}

      <details class="rl-claude__setup" open={!connected}>
        <summary class="rl-claude__summary">
          <Icon name="chevron-right" size={11} class="rl-claude__chevron" />
          Setup
        </summary>
        <ol class="rl-claude__steps">
          <li class="rl-claude__step">
            <div class="rl-claude__step-title">Install the local bridge (in your reqlens checkout)</div>
            <Command command={commands.install} testId="rl-claude-cmd-install" copyTitle="Copy the install command" />
            <div class="rl-claude__id rl-faint">
              Extension id <code class="rl-mono" data-testid="rl-claude-extension-id">{extensionId || 'unknown'}</code>
              {extensionId ? (
                <CopyAction iconOnly text={() => extensionId} label="Copy the extension id" done="Extension id copied" />
              ) : null}
            </div>
          </li>
          <li class="rl-claude__step">
            <div class="rl-claude__step-title">Add the MCP server to Claude Code (the installer prints the exact path)</div>
            <Command command={commands.add} testId="rl-claude-cmd-add" copyTitle="Copy the claude mcp add command" />
          </li>
          <li class="rl-claude__step">
            <div class="rl-claude__step-title">
              Optional: start Claude with channels so prompts you send appear right away (research preview)
            </div>
            <Command command={commands.channels} testId="rl-claude-cmd-channels" copyTitle="Copy the channels command" />
            <div class="rl-claude__hint rl-faint">Without it, sent items wait in the kineReqLens inbox — ask Claude to check it.</div>
          </li>
        </ol>
      </details>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-claude-allow-send"
          checked={settings.claudeAllowSend}
          aria-describedby="rl-claude-allow-send-warning"
          onChange={(e) => onChange({ claudeAllowSend: e.currentTarget.checked })}
        />
        <span>Allow Claude to send requests</span>
      </label>
      <div
        class={`rl-claude__warning${settings.claudeAllowSend ? ' rl-claude__warning--active' : ''}`}
        id="rl-claude-allow-send-warning"
      >
        <Icon name="warning" size={11} class="rl-claude__warning-icon" />
        <span>
          Claude can replay captured requests with this tab's cookies and session — while the overlay is open (or, when you let
          Claude control kineReqLens, from its invisible panel). Its runs show in the history marked “Claude”.
        </span>
      </div>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-claude-allow-control"
          checked={settings.claudeAllowControl}
          aria-describedby="rl-claude-allow-control-warning"
          onChange={(e) => onChange({ claudeAllowControl: e.currentTarget.checked })}
        />
        <span>Let Claude control kineReqLens (includes screenshots of pages)</span>
      </label>
      <div
        class={`rl-claude__warning${settings.claudeAllowControl ? ' rl-claude__warning--active' : ''}`}
        id="rl-claude-allow-control-warning"
      >
        <Icon name="warning" size={11} class="rl-claude__warning-icon" />
        <span>
          From the chat, Claude can do what you do here — open or hide the overlay, capture in the background, filter, edit, run
          Errors view analyses, set the site language and non-security settings — and take screenshots of the page, even while the
          overlay is closed. It can never change these Claude settings. Its actions are listed below.
        </span>
      </div>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-claude-share-secrets"
          checked={settings.claudeShareSecrets}
          aria-describedby="rl-claude-share-secrets-warning"
          onChange={(e) => onChange({ claudeShareSecrets: e.currentTarget.checked })}
        />
        <span>Share secrets with Claude</span>
      </label>
      <div
        class={`rl-claude__warning${settings.claudeShareSecrets ? ' rl-claude__warning--active' : ''}`}
        id="rl-claude-share-secrets-warning"
      >
        <Icon name="warning" size={11} class="rl-claude__warning-icon" />
        <span>
          Authorization headers, cookies, tokens and passwords go to Claude (and into copied prompts and types) unredacted. Off by
          default.
        </span>
      </div>

      <ErrorsSettings settings={settings} onChange={onChange} />
      <ClaudeTrace trace={settings.claudeBridge ? (status.trace ?? []) : []} />
    </section>
  );
}

/** Tool names as the user knows them (the MCP tools of Claude Code). */
function traceLabel(item: ControlTraceItem): string {
  return item.action ? `${item.tool} ${item.action.replace(/_/g, ' ')}` : item.tool.replace(/_/g, ' ');
}

/** Settings → Claude Code → "Recent Claude actions": what Claude Code did through kineReqLens (newest first). */
function ClaudeTrace({ trace }: { trace: readonly ControlTraceItem[] }) {
  if (!trace.length) return null;
  return (
    <details class="rl-claude__trace" data-testid="rl-claude-trace" open>
      <summary class="rl-claude__summary">
        <Icon name="chevron-right" size={11} class="rl-claude__chevron" />
        Recent Claude actions
      </summary>
      <ol class="rl-claude__trace-list">
        {trace.slice(0, 15).map((item, i) => (
          <li
            key={`${item.at}-${i}`}
            class={`rl-claude__trace-item${item.ok ? '' : ' rl-claude__trace-item--failed'}`}
            data-testid="rl-claude-trace-item"
            data-tool={item.tool}
            data-action={item.action ?? ''}
            data-tab={item.tabId ?? ''}
            data-ok={item.ok ? 'true' : 'false'}
          >
            <span class="rl-mono rl-faint">{formatClock(item.at)}</span>
            <span class="rl-claude__trace-what">{traceLabel(item)}</span>
            {item.tabId !== undefined ? <span class="rl-faint">tab {item.tabId}</span> : null}
            {item.ok ? null : <span class="rl-claude__trace-failed">failed</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Settings → Claude Code → Errors view: automatic screenshots / analyses and the opt-in full mode (with its warning). */
function ErrorsSettings({ settings, onChange }: ClaudeSettingsProps) {
  const [confirming, setConfirming] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);
  /** Close the warning and give the focus back to the checkbox (it keeps Esc working for the Settings popover). */
  const settle = (enable: boolean) => {
    setConfirming(false);
    if (enable) onChange({ errorsFullMode: true });
    boxRef.current?.focus({ preventScroll: true });
  };
  return (
    <div class="rl-claude__errors" data-testid="rl-errors-settings">
      <div class="rl-claude__step-title">Errors view</div>
      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-errors-capture-screens"
          checked={settings.captureErrorScreens}
          onChange={(e) => onChange({ captureErrorScreens: e.currentTarget.checked })}
        />
        <span>Screenshot the error area of new failing endpoints</span>
      </label>
      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-errors-auto-analyze"
          checked={settings.autoAnalyzeErrors}
          aria-describedby="rl-errors-auto-analyze-note"
          onChange={(e) => onChange({ autoAnalyzeErrors: e.currentTarget.checked })}
        />
        <span>Analyze new failing endpoints automatically</span>
      </label>
      <div class={`rl-claude__warning${settings.autoAnalyzeErrors ? ' rl-claude__warning--active' : ''}`} id="rl-errors-auto-analyze-note">
        <Icon name="warning" size={11} class="rl-claude__warning-icon" />
        <span>
          Each new failing endpoint starts a read-only Claude run in the site’s project folder (at most one per endpoint per page load,
          three per minute) — every run uses Claude tokens.
        </span>
      </div>
      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          ref={boxRef}
          data-testid="rl-errors-full-mode"
          checked={settings.errorsFullMode}
          aria-describedby="rl-errors-full-mode-note"
          onChange={(e) => {
            const box = e.currentTarget;
            if (!box.checked) {
              setConfirming(false);
              onChange({ errorsFullMode: false });
              return;
            }
            // Turning it on needs the explicit confirmation below.
            box.checked = false;
            setConfirming(true);
          }}
        />
        <span>Full mode: fixes, issues and pull requests</span>
      </label>
      {confirming ? (
        <div class="rl-claude__confirm" role="alertdialog" aria-labelledby="rl-errors-full-title" data-testid="rl-errors-full-dialog">
          <div class="rl-claude__confirm-title" id="rl-errors-full-title">
            <Icon name="warning" size={12} /> Enable full mode?
          </div>
          <ul class="rl-claude__confirm-list">
            <li>kineReqLens may run your Claude Code with file edits (accept-edits mode) — always in a new git worktree next to your repository, never in your checkout.</li>
            <li>It may run git commit and git push and the GitHub CLI (gh issue create, gh pr create, gh image) on your behalf — each only after you confirm a dialog that shows the exact commands.</li>
            <li>Pushed branches, issues, pull requests and uploaded images are public to everyone who can see the repository.</li>
          </ul>
          <div class="rl-claude__confirm-actions">
            <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-full-cancel" onClick={() => settle(false)}>
              Cancel
            </button>
            <button
              type="button"
              class="rl-btn rl-btn--sm rl-btn--primary rl-btn--danger"
              data-testid="rl-errors-full-confirm"
              onClick={() => settle(true)}
            >
              Enable full mode
            </button>
          </div>
        </div>
      ) : null}
      <div class={`rl-claude__warning${settings.errorsFullMode ? ' rl-claude__warning--active' : ''}`} id="rl-errors-full-mode-note">
        <Icon name="warning" size={11} class="rl-claude__warning-icon" />
        <span>
          Off by default (safe mode: read-only analysis, terminal prompts, copy). On: Claude edits files in git worktrees, and git push / gh run
          after your confirmation.
        </span>
      </div>
    </div>
  );
}
