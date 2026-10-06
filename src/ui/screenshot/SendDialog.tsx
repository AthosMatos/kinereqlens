// "Send to Claude" dialog of the screenshot result view (docs/CLAUDE_INTEGRATION.md "Send a screenshot to Claude"):
// target (connected Claude Code sessions, running embedded terminals; remembered), prompt with quick templates,
// optional context, "Send immediately" for terminals. Sending saves the annotated PNG through the hub
// (sendClient.ts) and hands its absolute path to the target. Model: sendModel.ts.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { copyText } from '../components/clipboard';
import { toast } from '../components/toast';
import { openClaudeSettings } from '../export/openSettings';
import { sendToClaude, useBridgeStatus } from '../panel/claudeLink';
import { setTerminalPaneOpen, terminalStore, useTerminalStore } from '../terminal/session';
import { saveShotToHub } from './sendClient';
import {
  SHOT_PROMPT_MAX_CHARS,
  SHOT_TEMPLATES,
  applyTemplate,
  buildShotPrompt,
  buildShotTargets,
  defaultShotTarget,
  parseShotSendPrefs,
  requestSummaryLine,
  shotImageName,
  shotItemTitle,
  shotSendUnavailable,
  targetName,
  terminalShotText,
} from './sendModel';
import type { ShotSendContext, ShotSendPrefs, ShotTarget } from './sendModel';
import type { ShotItem } from './store';

const PREFS_KEY = 'reqlens:shot-send';

function loadPrefs(): ShotSendPrefs {
  try {
    return parseShotSendPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'));
  } catch {
    return parseShotSendPrefs(null);
  }
}

function savePrefs(prefs: ShotSendPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: not remembered */
  }
}

export interface SendDialogProps {
  item: ShotItem;
  /** The PNG with the annotations burnt in. */
  exportBlob(): Promise<Blob>;
  context: ShotSendContext;
  onClose(): void;
}

type Phase = { kind: 'edit' } | { kind: 'sending'; step: string } | { kind: 'done'; path: string; target: string } | { kind: 'error'; error: string };

export function SendDialog({ item, exportBlob, context, onClose }: SendDialogProps) {
  const status = useBridgeStatus();
  const terms = useTerminalStore();
  const [prefs] = useState(loadPrefs);
  const targets = useMemo(
    () => buildShotTargets(status, terms.list().map((s) => ({ key: s.key, cwd: s.cwd, state: s.state, ...(typeof s.pid === 'number' ? { pid: s.pid } : {}) }))),
    [status, terms.revision],
  );
  const unavailable = shotSendUnavailable(status, targets);
  const [chosen, setChosen] = useState<string | null>(null);
  const target: ShotTarget | null = targets.find((t) => t.id === chosen) ?? defaultShotTarget(targets, prefs.target);
  const [prompt, setPrompt] = useState('');
  const [includeUrl, setIncludeUrl] = useState(prefs.includeUrl);
  const [includeRequest, setIncludeRequest] = useState(prefs.includeRequest);
  const [includeAnalysis, setIncludeAnalysis] = useState(prefs.includeAnalysis);
  const [sendNow, setSendNow] = useState(prefs.sendNow);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);

  useEffect(() => {
    promptRef.current?.focus({ preventScroll: true });
    return () => {
      live.current = false;
    };
  }, []);

  const busy = phase.kind === 'sending';
  const canSend = !!target && !!prompt.trim() && !busy && !unavailable;

  const send = async (): Promise<void> => {
    if (!target || !canSend) return;
    const choice = { includeUrl, includeRequest, includeAnalysis };
    savePrefs({ target: { kind: target.kind, id: target.id, cwd: target.cwd }, sendNow, ...choice });
    const update = (next: Phase): void => {
      if (live.current) setPhase(next);
    };
    update({ kind: 'sending', step: 'Saving the screenshot…' });
    let blob: Blob;
    try {
      blob = await exportBlob();
    } catch (err) {
      update({ kind: 'error', error: `Could not export the screenshot: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const name = shotImageName(item.host, item.createdAt);
    const saved = await saveShotToHub(blob, name);
    if (!saved.ok) {
      update({ kind: 'error', error: saved.error });
      return;
    }
    const text = buildShotPrompt(prompt, context, choice);
    if (target.kind === 'claude') {
      update({ kind: 'sending', step: 'Sending to Claude Code…' });
      const entryId = includeRequest && context.request && context.entryId ? context.entryId : '';
      const result = await sendToClaude({
        entryId,
        title: shotItemTitle(item.host, prompt),
        target: 'explain',
        prompt: text,
        sessionId: target.sessionId ?? null,
        images: [{ path: saved.path, name, width: item.width, height: item.height }],
      });
      if (!result.ok) {
        update({ kind: 'error', error: result.error ?? 'Claude Code did not get the screenshot' });
        return;
      }
    } else {
      const store = terminalStore();
      if (!target.termKey || !store.typeText(target.termKey, terminalShotText(text, saved.path), { submit: sendNow })) {
        update({ kind: 'error', error: 'That terminal is no longer running' });
        return;
      }
      store.select(target.termKey);
      setTerminalPaneOpen(true);
    }
    const label = targetName(target);
    update({ kind: 'done', path: saved.path, target: label });
    toast(`Sent to ${label}`, 'success', { action: { label: 'Copy path', onClick: () => void copyText(saved.path, 'Path copied') } });
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    // Keys stay in the dialog (the result view's tool shortcuts must not fire).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && phase.kind !== 'done') {
      e.preventDefault();
      void send();
    }
  };

  const check = (testId: string, label: string, value: boolean, set: (v: boolean) => void, detail: string): JSX.Element => (
    <label class="rl-shot__send-check" title={detail}>
      <input type="checkbox" class="rl-checkbox" data-testid={testId} checked={value} disabled={busy} onChange={(e) => set(e.currentTarget.checked)} />
      <span>{label}</span>
      <span class="rl-shot__send-check-detail rl-mono rl-truncate">{detail}</span>
    </label>
  );

  return (
    <div class="rl-shot__send-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={onKeyDown}>
      <div class="rl-shot__send" role="dialog" aria-modal="true" aria-label="Send to Claude" data-testid="rl-shot-send-dialog" data-phase={phase.kind}>
        <div class="rl-shot__send-head">
          <Icon name="send" size={13} />
          <span class="rl-shot__send-title">Send to Claude</span>
          <span class="rl-spacer rl-grow" />
          <span class="rl-faint">
            {item.width} × {item.height} px{item.annotations.length ? ` · ${item.annotations.length} annotation${item.annotations.length === 1 ? '' : 's'}` : ''}
          </span>
          <button type="button" class="rl-icon-btn rl-icon-btn--sm" aria-label="Close" data-testid="rl-shot-send-close" disabled={busy} onClick={onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        {phase.kind === 'done' ? (
          <div class="rl-shot__send-body" data-testid="rl-shot-sent" data-path={phase.path}>
            <div class="rl-shot__send-done">
              <Icon name="check" size={14} /> Sent to {phase.target}
            </div>
            <label class="rl-shot__send-label" for="rl-shot-sent-path">
              Screenshot file (kept 24 hours)
            </label>
            <div class="rl-shot__send-path">
              <input id="rl-shot-sent-path" class="rl-input rl-input--mono" readOnly value={phase.path} data-testid="rl-shot-sent-path" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-shot-sent-copy" onClick={() => void copyText(phase.path, 'Path copied')}>
                <Icon name="copy" size={11} /> Copy
              </button>
            </div>
            <div class="rl-shot__send-foot">
              <span class="rl-spacer rl-grow" />
              <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-shot-send-done" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div class="rl-shot__send-body">
            <div class="rl-shot__send-label" id="rl-shot-send-to">
              Send to
            </div>
            {unavailable ? (
              <div class="rl-shot__send-unavailable" role="note" data-testid="rl-shot-send-unavailable">
                <Icon name="info" size={12} />
                <span>{unavailable.reason}</span>
                {unavailable.setup ? (
                  <button
                    type="button"
                    class="rl-export-link"
                    data-testid="rl-shot-send-setup"
                    onClick={() => {
                      onClose();
                      openClaudeSettings();
                    }}
                  >
                    Settings → Claude Code
                  </button>
                ) : null}
              </div>
            ) : (
              <div class="rl-shot__send-targets" role="radiogroup" aria-labelledby="rl-shot-send-to">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    class="rl-shot__send-target"
                    aria-checked={target?.id === t.id}
                    data-testid="rl-shot-target"
                    data-kind={t.kind}
                    data-target-id={t.id}
                    data-cwd={t.cwd}
                    data-this-window={t.thisWindow ? 'true' : undefined}
                    title={t.cwd}
                    disabled={busy}
                    onClick={() => setChosen(t.id)}
                  >
                    <Icon name={t.kind === 'claude' ? 'plug' : 'terminal'} size={12} />
                    <span class="rl-shot__send-target-label rl-truncate">{t.label}</span>
                    <span class="rl-shot__send-target-detail rl-truncate">{t.kind === 'claude' ? `Claude Code · ${t.detail}` : t.detail}</span>
                  </button>
                ))}
              </div>
            )}

            <label class="rl-shot__send-label" for="rl-shot-prompt">
              Prompt
            </label>
            <div class="rl-shot__send-chips" role="group" aria-label="Quick prompts">
              {SHOT_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  class="rl-shot__send-chip"
                  data-testid="rl-shot-template"
                  data-template={t.id}
                  title={t.text}
                  disabled={busy}
                  onClick={() => {
                    setPrompt((p) => applyTemplate(p, t.text));
                    promptRef.current?.focus({ preventScroll: true });
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <textarea
              id="rl-shot-prompt"
              ref={promptRef}
              class="rl-textarea rl-shot__send-prompt"
              data-testid="rl-shot-prompt"
              rows={4}
              maxLength={SHOT_PROMPT_MAX_CHARS}
              placeholder="What should Claude do with this screenshot?"
              value={prompt}
              disabled={busy}
              onInput={(e) => setPrompt(e.currentTarget.value)}
            />

            {context.pageUrl || context.request || context.analysis ? (
              <div class="rl-shot__send-context" role="group" aria-label="Context">
                {context.pageUrl ? check('rl-shot-ctx-url', 'Page URL', includeUrl, setIncludeUrl, context.pageUrl) : null}
                {context.request ? check('rl-shot-ctx-request', 'Selected request', includeRequest, setIncludeRequest, requestSummaryLine(context.request)) : null}
                {context.analysis ? check('rl-shot-ctx-analysis', 'Error analysis', includeAnalysis, setIncludeAnalysis, context.analysis.split('\n')[0] ?? '') : null}
              </div>
            ) : null}

            {target?.kind === 'terminal' ? (
              <label class="rl-shot__send-check" title="On: types the prompt and presses Enter. Off: only types it — review it and press Enter yourself.">
                <input type="checkbox" class="rl-checkbox" data-testid="rl-shot-send-now" checked={sendNow} disabled={busy} onChange={(e) => setSendNow(e.currentTarget.checked)} />
                <span>Send immediately</span>
                <span class="rl-shot__send-check-detail">{sendNow ? 'types the prompt and presses Enter' : 'only types it — you press Enter'}</span>
              </label>
            ) : null}

            {phase.kind === 'error' ? (
              <div class="rl-shot__send-error" role="alert" data-testid="rl-shot-send-error">
                <Icon name="warning" size={12} /> {phase.error}
              </div>
            ) : null}

            <div class="rl-shot__send-foot">
              {phase.kind === 'sending' ? (
                <span class="rl-faint" aria-live="polite">
                  <span class="rl-spinner" aria-hidden="true" /> {phase.step}
                </span>
              ) : (
                <span class="rl-faint">The annotated image is sent.</span>
              )}
              <span class="rl-spacer rl-grow" />
              <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-shot-send-cancel" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                class="rl-btn rl-btn--sm rl-btn--primary"
                data-testid="rl-shot-send-confirm"
                disabled={!canSend}
                title={unavailable ? unavailable.reason : !prompt.trim() ? 'Write a prompt (or pick a quick prompt)' : target ? `Send to ${targetName(target)} (Ctrl+Enter)` : ''}
                onClick={() => void send()}
              >
                <Icon name="send" size={12} />
                {target?.kind === 'terminal' && !sendNow ? 'Type into terminal' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
