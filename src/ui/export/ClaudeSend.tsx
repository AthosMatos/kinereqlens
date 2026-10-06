// OWNER: ui-export agent. "Send to Claude Code" of the Agent prompt view: session picker (when more than one
// session is connected), the send button, and — when the bridge cannot deliver — the reason plus a "Set up" link.
import { useState } from 'preact/hooks';
import type { BridgeStatus } from '../../shared/claude-protocol';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { sendAvailability } from './claudeStatus';
import { openClaudeSettings } from './openSettings';
import { setExportPrefs, useExportPrefs } from './prefs';

export interface ClaudeSendProps {
  status: BridgeStatus;
  /** Nothing to send (prompt failed to build). */
  disabled?: boolean;
  /** Deliver to one session, or null = every connected session. */
  onSend(sessionId: string | null): Promise<unknown>;
}

let reasonSeq = 0;

export function ClaudeSend({ status, disabled, onSend }: ClaudeSendProps) {
  const prefs = useExportPrefs();
  const [busy, setBusy] = useState(false);
  const [reasonId] = useState(() => `rl-send-claude-reason-${++reasonSeq}`);
  const avail = sendAvailability(status);
  const sessions = avail.ok ? avail.sessions : [];
  const chosen = prefs.sessionId && sessions.some((s) => s.id === prefs.sessionId) ? prefs.sessionId : null;
  const blocked = !avail.ok || !!disabled || busy;
  const target = chosen ? sessions.find((s) => s.id === chosen) : sessions.length === 1 ? sessions[0] : undefined;

  const onClick = () => {
    if (!avail.ok) {
      toast(avail.reason, 'warn');
      return;
    }
    if (blocked) return;
    setBusy(true);
    void onSend(chosen).finally(() => setBusy(false));
  };

  const labelCounts = new Map<string, number>();
  for (const s of sessions) labelCounts.set(s.label, (labelCounts.get(s.label) ?? 0) + 1);

  return (
    <>
      {sessions.length > 1 ? (
        <select
          class="rl-select rl-export__session"
          data-testid="rl-claude-session"
          aria-label="Claude Code session"
          title={target ? target.cwd : 'Every connected Claude Code session'}
          value={chosen ?? ''}
          onChange={(e) => setExportPrefs({ sessionId: e.currentTarget.value || null })}
        >
          <option value="">All sessions ({sessions.length})</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id} title={s.cwd}>
              {(labelCounts.get(s.label) ?? 0) > 1 ? `${s.label} (pid ${s.pid})` : s.label}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        class={`rl-btn rl-btn--sm${avail.ok ? ' rl-btn--primary' : ''}`}
        data-testid="rl-send-claude"
        aria-disabled={blocked ? 'true' : undefined}
        aria-describedby={avail.ok ? undefined : reasonId}
        aria-busy={busy ? 'true' : undefined}
        title={
          avail.ok
            ? `Send this prompt to Claude Code${target ? ` (${target.label} — ${target.cwd})` : ' (every connected session)'}`
            : avail.reason
        }
        onClick={onClick}
      >
        {busy ? <span class="rl-spinner rl-export__btn-spinner" aria-hidden="true" /> : <Icon name="send" size={12} />}
        <span>Send to Claude Code</span>
      </button>
      {avail.ok ? null : (
        <div class="rl-export__reason" id={reasonId} data-testid="rl-send-claude-reason" role="note">
          <Icon name="info" size={12} class="rl-export__reason-icon" />
          <span class="rl-export__reason-text">{avail.reason}</span>
          {avail.setup ? (
            <button type="button" class="rl-export-link" data-testid="rl-send-claude-setup" onClick={openClaudeSettings}>
              Set up
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
