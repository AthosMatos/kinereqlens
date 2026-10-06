// OWNER: ui-editor agent. Editor footer: warnings list, mode select, request options, more menu and Send.
import type { JSX } from 'preact';
import { isStandaloneShell, replayModeName } from '../shellMode';
import type { ReplayMode, ReplayRequest } from '../../shared/types';
import type { DraftWarning } from '../../lib/draft';
import { Icon } from '../components/Icon';
import { MenuButton, PopoverButton, type MenuItem } from '../components/Menu';
import { DEFAULT_SEND_OPTIONS, setSendOptions, type ResolvedSendOptions } from './draftStore';
import { cx, SEND_SHORTCUT_LABEL } from './util';

const LEVEL_ORDER: Record<DraftWarning['level'], number> = { error: 0, warn: 1, info: 2 };

export interface SendBarProps {
  entryId: string;
  resolved: ResolvedSendOptions;
  /** Timeout from settings (used when the draft has no override). */
  defaultTimeoutMs: number;
  /** draftWarnings + editor-level issues (raw parse errors). */
  warnings: DraftWarning[];
  running: boolean;
  /** Problems that block Send (error-level warnings, invalid JSON values, raw parse error). */
  errorCount: number;
  modified: boolean;
  onSend(): void;
  onCopy(kind: 'curl' | 'fetch'): void;
  /** Fork the current request into a new manual entry. */
  onDuplicate?(): void;
  onRevertAll(): void;
  /** Scroll to / focus the row or node a warning is about. */
  onReveal(targetId: string): void;
}

export function SendBar(props: SendBarProps) {
  const { entryId, resolved, warnings } = props;
  const sorted = warnings.length > 1 ? [...warnings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) : warnings;
  const errors = props.errorCount;
  const blocked = errors > 0;

  const items: MenuItem[] = [
    { label: 'Copy as cURL', icon: 'code', onSelect: () => props.onCopy('curl'), testId: 'rl-copy-curl' },
    { label: 'Copy as fetch', icon: 'code', onSelect: () => props.onCopy('fetch'), testId: 'rl-copy-fetch' },
    ...(props.onDuplicate
      ? [{ label: 'Duplicate as new request', icon: 'plus' as const, onSelect: props.onDuplicate, testId: 'rl-duplicate' }]
      : []),
    {
      label: 'Revert all',
      icon: 'revert',
      onSelect: props.onRevertAll,
      disabled: !props.modified,
      danger: true,
      testId: 'rl-menu-revert-all',
    },
  ];

  return (
    <div class="rl-ed-footer">
      {sorted.length > 0 && (
        <ul class="rl-ed-warnings" data-testid="rl-warnings" aria-label="Warnings" aria-live="polite">
          {sorted.map((w, i) => (
            <li
              key={`${w.section}:${w.targetId ?? ''}:${i}`}
              class={cx('rl-ed-warning', `rl-ed-warning--${w.level}`)}
              data-level={w.level}
              data-section={w.section}
            >
              <Icon name={w.level === 'info' ? 'info' : 'warning'} size={12} />
              <span class="rl-ed-warning__msg">{w.message}</span>
              {w.targetId && (
                <button
                  type="button"
                  class="rl-btn rl-btn--ghost rl-btn--sm rl-ed-warning__show"
                  onClick={() => props.onReveal(w.targetId!)}
                >
                  Show
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class="rl-ed-sendbar">
        <select
          class="rl-select rl-ed-mode"
          data-testid="rl-mode-select"
          aria-label="Send mode"
          title={
            isStandaloneShell()
              ? 'App: runs inside the React Native app with its own fetch (its cookies, TLS and networking). Extension: runs from the extension (no CORS; browser-controlled headers applied via a temporary rule).'
              : 'Page: runs inside the page (same cookies, origin and CORS as the app). Extension: runs from the extension (no CORS; browser-controlled headers applied via a temporary rule).'
          }
          value={resolved.mode}
          onChange={(e) => setSendOptions(entryId, { mode: e.currentTarget.value as ReplayMode })}
        >
          <option value="page">{replayModeName('page')}</option>
          <option value="extension">Extension</option>
        </select>
        <PopoverButton
          title="Request options"
          icon="settings"
          testId="rl-send-options"
          label={optionsSummary(resolved, props.defaultTimeoutMs)}
          align="start"
          class="rl-ed-options-btn"
        >
          {(close) => (
            <SendOptionsForm
              entryId={entryId}
              resolved={resolved}
              defaultTimeoutMs={props.defaultTimeoutMs}
              onDone={close}
            />
          )}
        </PopoverButton>
        <MenuButton title="More actions" icon="more" testId="rl-more-menu" items={items} align="start" />
        <span class="rl-spacer" />
        {errors > 0 && (
          <span class="rl-ed-sendbar__blocked" role="status">
            <Icon name="warning" size={12} />
            {errors} error{errors === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          class={cx('rl-btn rl-btn--primary rl-ed-send', props.running && 'rl-ed-send--running')}
          data-testid="rl-send"
          disabled={blocked}
          aria-busy={props.running || undefined}
          title={blocked ? 'Fix the errors before sending' : `Send (${SEND_SHORTCUT_LABEL})`}
          onClick={props.onSend}
        >
          {props.running ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name="send" size={13} />}
          <span>{props.running ? 'Sending…' : 'Send'}</span>
          <kbd class="rl-kbd rl-ed-send__kbd">{SEND_SHORTCUT_LABEL}</kbd>
        </button>
      </div>
    </div>
  );
}

/** Compact label of non-default options, e.g. "omit · manual · 10 s". */
function optionsSummary(o: ResolvedSendOptions, defaultTimeoutMs: number): string | undefined {
  const parts: string[] = [];
  if (!o.credentialsAuto) parts.push(o.credentials);
  if (o.redirect !== DEFAULT_SEND_OPTIONS.redirect) parts.push(`redirect: ${o.redirect}`);
  if (o.timeoutMs !== defaultTimeoutMs) parts.push(`${Math.round(o.timeoutMs / 100) / 10} s`);
  return parts.length ? parts.join(' · ') : undefined;
}

interface SendOptionsFormProps {
  entryId: string;
  resolved: ResolvedSendOptions;
  defaultTimeoutMs: number;
  onDone(): void;
}

function SendOptionsForm({ entryId, resolved, defaultTimeoutMs, onDone }: SendOptionsFormProps) {
  const onTimeout = (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    const seconds = Number(e.currentTarget.value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      e.currentTarget.value = String(resolved.timeoutMs / 1000);
      return;
    }
    const ms = Math.round(seconds * 1000);
    setSendOptions(entryId, { timeoutMs: ms === defaultTimeoutMs ? undefined : ms });
  };

  return (
    <div class="rl-ed-options" data-testid="rl-send-options-form">
      <label
        class="rl-ed-options__field"
        title={resolved.credentialsAuto ? 'Follows the captured request (Reset restores this)' : undefined}
      >
        <span>Credentials{resolved.credentialsAuto ? ' (as captured)' : ''}</span>
        <select
          class="rl-select"
          data-testid="rl-opt-credentials"
          value={resolved.credentials}
          onChange={(e) =>
            setSendOptions(entryId, { credentials: e.currentTarget.value as ReplayRequest['credentials'] })
          }
        >
          <option value="include">include — send cookies</option>
          <option value="same-origin">same-origin</option>
          <option value="omit">omit — no cookies</option>
        </select>
      </label>
      <label class="rl-ed-options__field">
        <span>Redirects</span>
        <select
          class="rl-select"
          data-testid="rl-opt-redirect"
          value={resolved.redirect}
          onChange={(e) => setSendOptions(entryId, { redirect: e.currentTarget.value as ReplayRequest['redirect'] })}
        >
          <option value="follow">follow</option>
          <option value="manual">manual — stop at 3xx</option>
          <option value="error">error — fail on redirect</option>
        </select>
      </label>
      <label class="rl-ed-options__field">
        <span>Timeout (s)</span>
        <input
          type="number"
          class="rl-input rl-input--mono"
          data-testid="rl-opt-timeout"
          min={1}
          max={600}
          step={1}
          value={String(resolved.timeoutMs / 1000)}
          onChange={onTimeout}
        />
      </label>
      <div class="rl-row rl-ed-options__actions">
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm"
          onClick={() =>
            setSendOptions(entryId, {
              credentials: undefined,
              redirect: DEFAULT_SEND_OPTIONS.redirect,
              timeoutMs: undefined,
            })
          }
        >
          Reset
        </button>
        <span class="rl-spacer" />
        <button type="button" class="rl-btn rl-btn--sm" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
