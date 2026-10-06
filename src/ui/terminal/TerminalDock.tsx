// The Claude Code terminal pane docked at the bottom of the panel (docs/CLAUDE_INTEGRATION.md "Terminal"): a
// tab strip of sessions (+ opens the new-session form, × kills and closes), the form (FolderPicker.tsx: native
// folder chooser, folder browser, recent folders, detected projects, typed path fallback), and the active session's xterm.js screen with its status line (running /
// exited (code) + Restart). Unavailable — with the reason and a link to Settings → Claude Code — while the
// bridge is off, not installed or disconnected.
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { getActiveElementInUi } from '../components/root';
import { openClaudeSettings } from '../export/openSettings';
import { useBridgeStatus } from '../panel/claudeLink';
import { FolderPicker } from './FolderPicker';
import { useTerminalStore } from './session';
import { dirLabel } from './store';
import type { TerminalSession, TerminalStore } from './store';
import { sessionStatusText, terminalUnavailableReason } from './texts';
import { terminalFont, terminalTheme } from './xterm';
import type { XtermSink } from './xterm';

export { terminalUnavailableReason } from './texts';

export interface TerminalDockProps {
  theme: 'light' | 'dark';
  recentDirs: readonly string[];
  onHide(): void;
}

/**
 * May the pane take the keyboard focus now? Only when the user is working with it (focus inside the pane, on its
 * navigation rail toggle, or nowhere) — never away from an open popover such as Settings, which would close it.
 */
function mayTakeFocus(): boolean {
  const active = getActiveElementInUi();
  if (!active) return true;
  return !!active.closest('.rl-term') || active.getAttribute('data-testid') === 'rl-claude-terminal-toggle';
}

/** Rough terminal size of an element before any terminal is measured (7.2 × 15 px cells). */
function estimateDims(el: HTMLElement | null): { cols: number; rows: number } {
  const width = el?.clientWidth ?? 0;
  const height = el?.clientHeight ?? 0;
  return {
    cols: Math.min(1000, Math.max(20, Math.floor((width - 16) / 7.2) || 80)),
    rows: Math.min(1000, Math.max(5, Math.floor((height - 30) / 15) || 24)),
  };
}

export function TerminalDock({ theme, recentDirs, onHide }: TerminalDockProps) {
  const store = useTerminalStore();
  const status = useBridgeStatus();
  const reason = terminalUnavailableReason(status);
  const sessions = store.list();
  const active = store.active === 'new' ? null : (store.get(store.active) ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keys typed in the terminal are not panel shortcuts (Ctrl+Enter = send request, list navigation…).
  const stopKeys = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => e.stopPropagation();

  return (
    <div
      class="rl-term"
      data-testid="rl-claude-terminal"
      data-available={reason ? 'false' : 'true'}
      onKeyDown={stopKeys}
      role="region"
      aria-label="Claude Code terminal"
    >
      <div class="rl-term__bar">
        <div class="rl-term__tabs" role="tablist" aria-label="Claude Code sessions">
          {sessions.map((s) => (
            <div
              key={s.key}
              class={`rl-term__tab${s.key === store.active ? ' rl-term__tab--active' : ''}`}
              data-testid="rl-claude-terminal-tab"
              data-state={s.state}
            >
              <button
                type="button"
                role="tab"
                class="rl-term__tab-btn"
                aria-selected={s.key === store.active ? 'true' : 'false'}
                title={s.cwd}
                onClick={() => store.select(s.key)}
              >
                <span class={`rl-term__dot rl-term__dot--${s.state}`} aria-hidden="true" />
                <span class="rl-term__tab-label rl-truncate">{dirLabel(s.cwd)}</span>
              </button>
              <button
                type="button"
                class="rl-icon-btn rl-icon-btn--sm rl-term__tab-close"
                title={s.state === 'running' || s.state === 'opening' ? 'Stop Claude and close this tab' : 'Close this tab'}
                aria-label={`Close ${dirLabel(s.cwd)}`}
                data-testid="rl-claude-terminal-close"
                onClick={() => store.close(s.key)}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
          <button
            type="button"
            role="tab"
            class={`rl-icon-btn rl-icon-btn--sm rl-term__new${store.active === 'new' ? ' rl-term__new--active' : ''}`}
            aria-selected={store.active === 'new' ? 'true' : 'false'}
            title="New Claude Code session"
            aria-label="New Claude Code session"
            data-testid="rl-claude-terminal-new"
            onClick={() => store.select('new')}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm"
          title="Hide the terminal (sessions keep running)"
          aria-label="Hide the terminal"
          data-testid="rl-claude-terminal-hide"
          onClick={onHide}
        >
          <Icon name="chevron-down" size={13} />
        </button>
      </div>

      <div class="rl-term__body" ref={bodyRef}>
        {reason && (!active || active.state === 'opening') ? (
          <Unavailable reason={reason} />
        ) : active ? (
          <SessionView key={active.key} store={store} session={active} theme={theme} disabled={reason !== null} />
        ) : (
          <NewSession store={store} recentDirs={recentDirs} bodyRef={bodyRef} />
        )}
        {reason && active && active.state !== 'opening' ? (
          <div class="rl-term__banner" data-testid="rl-claude-terminal-banner" role="status">
            <Icon name="warning" size={12} />
            <span class="rl-grow">{reason}</span>
            <button type="button" class="rl-export-link" onClick={openClaudeSettings}>
              Settings
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div class="rl-empty rl-term__empty" data-testid="rl-claude-terminal-disabled">
      <span class="rl-term__art" aria-hidden="true">
        <Icon name="terminal" size={24} />
      </span>
      <div class="rl-empty__title">Claude Code terminal unavailable</div>
      <div class="rl-empty__text" data-testid="rl-claude-terminal-reason">
        {reason}
      </div>
      <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-claude-terminal-setup" onClick={openClaudeSettings}>
        <Icon name="settings" size={12} />
        Open Settings → Claude Code
      </button>
    </div>
  );
}

interface NewSessionProps {
  store: TerminalStore;
  recentDirs: readonly string[];
  bodyRef: { current: HTMLDivElement | null };
}

/** The new-session form: the folder picker, starting `claude` in the chosen folder. */
function NewSession({ store, recentDirs, bodyRef }: NewSessionProps) {
  const [autoFocus] = useState(mayTakeFocus);
  /** Runs inside the click / key handler (a pty may only be opened from a user gesture). */
  const start = (dir: string): string | null => {
    const { cols, rows } = estimateDims(bodyRef.current);
    const result = store.start(dir, cols, rows);
    return result.ok ? null : result.error;
  };
  return <FolderPicker recentDirs={recentDirs} failed={store.formError} autoFocus={autoFocus} onStart={start} />;
}

interface SessionViewProps {
  store: TerminalStore;
  session: TerminalSession;
  theme: 'light' | 'dark';
  disabled: boolean;
}

function SessionView({ store, session, theme, disabled }: SessionViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sink = session.term as XtermSink;

  // Open (first time) or re-attach the terminal's element, keep it fitted, report size changes.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = sink.terminal;
    const root = host.closest('.rl-root');
    terminal.options.fontFamily = terminalFont(root);
    terminal.options.theme = terminalTheme(root, theme);
    if (!terminal.element) terminal.open(host);
    else if (terminal.element.parentElement !== host) host.appendChild(terminal.element);
    let frame = 0;
    const fit = () => {
      frame = 0;
      if (host.clientWidth < 10 || host.clientHeight < 10) return;
      try {
        sink.fit.fit();
      } catch {
        /* not rendered yet */
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    terminal.refresh(0, terminal.rows - 1);
    store.resize(session.key, terminal.cols, terminal.rows);
    const resized = terminal.onResize(({ cols, rows }) => store.resize(session.key, cols, rows));
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    if (mayTakeFocus()) terminal.focus();
    return () => {
      observer.disconnect();
      resized.dispose();
      if (frame) cancelAnimationFrame(frame);
    };
    // The session object and its terminal are stable for a key.
  }, [session.key]);

  useEffect(() => {
    const root = hostRef.current?.closest('.rl-root') ?? null;
    sink.terminal.options.theme = terminalTheme(root, theme);
  }, [theme]);

  const restart = () => {
    const terminal = sink.terminal;
    store.restart(session.key, terminal.cols, terminal.rows);
    terminal.focus();
  };

  const tone = session.state === 'running' ? 'ok' : session.state === 'opening' ? 'busy' : session.state === 'error' ? 'error' : 'idle';
  return (
    <div class="rl-term__session">
      <div class="rl-term__screen" ref={hostRef} data-testid="rl-claude-terminal-screen" />
      <div
        class={`rl-term__status rl-term__status--${tone}`}
        data-testid="rl-claude-terminal-status"
        data-state={session.state}
        data-exit-code={session.exit?.code ?? undefined}
        role="status"
        aria-live="polite"
        title={session.pid ? `pid ${session.pid} · ${session.cwd}` : session.cwd}
      >
        {session.state === 'opening' ? <span class="rl-spinner rl-term__spinner" aria-hidden="true" /> : <span class={`rl-term__dot rl-term__dot--${session.state}`} aria-hidden="true" />}
        <span class="rl-term__status-text rl-truncate">{sessionStatusText(session)}</span>
        <span class="rl-spacer" />
        {session.state !== 'opening' ? (
          <button
            type="button"
            class={`rl-btn rl-btn--sm${session.state === 'running' ? ' rl-btn--ghost' : ''}`}
            data-testid="rl-claude-terminal-restart"
            disabled={disabled}
            title={session.state === 'running' ? 'Stop Claude and start it again in the same folder' : 'Start Claude again in the same folder'}
            onClick={restart}
          >
            <Icon name="reload" size={12} />
            Restart
          </button>
        ) : null}
      </div>
    </div>
  );
}
