// Embedded Claude Code terminal, panel side (docs/CLAUDE_INTEGRATION.md "Terminal"): the sessions shown in the
// terminal pane's tab strip. Module state, so hiding the pane (or re-rendering the App) keeps every session and
// its scrollback; a reloaded panel gets its still-running terminals back from the worker (`pty-attached`, with
// the last output replayed).
//
// The store is DOM-free: each session owns a TermSink (an xterm.js Terminal in production, created by the
// factory given to `configureTerminalStore`) and talks to the worker through `postPty` / `subscribePty`.
import type { LinkPtyAttached } from '../../shared/claude-link';
import type { PtyFromHost, PtyToHost } from '../../shared/claude-protocol';
import { isPtyDim, isPtyId, newPtyId, splitPtyInput } from '../../shared/pty';
import type { PtyLinkEvent } from '../panel/claudeLink';

/** What a session writes its output to (an xterm.js Terminal). */
export interface TermSink {
  write(data: string): void;
  /** Clear screen and scrollback (Restart). */
  reset(): void;
  dispose(): void;
}

export type SessionState = 'opening' | 'running' | 'exited' | 'error';

export interface TerminalSession {
  /** Stable UI key (the pty id changes on Restart). */
  readonly key: string;
  /** Current pty id. */
  ptyId: string;
  /** Working directory as the user typed it (Restart reuses it). */
  typedCwd: string;
  /** Resolved by the hub once started (else as typed). */
  cwd: string;
  state: SessionState;
  pid?: number;
  exit?: { code: number | null; signal: number | string | null };
  /** Why it failed / ended abnormally. */
  error?: string;
  /** It started at least once (a failed first start goes back to the form instead of keeping a dead tab). */
  everRan: boolean;
  readonly term: TermSink;
  /** Text typed into the prompt (never submitted) once the program is idle after starting ("Open in terminal"). */
  prefill?: string;
  /** The program enabled bracketed paste (ESC [?2004h). */
  bracketedPaste?: boolean;
}

/** The pre-fill is typed once the output was quiet this long after the program started… */
export const PREFILL_QUIET_MS = 800;
/** …or at the latest this long after it started. */
export const PREFILL_MAX_WAIT_MS = 15_000;
/** typeText(…, {submit}): Enter goes this long after the text (a paste is taken in first). */
export const SUBMIT_DELAY_MS = 150;

/**
 * Text to type into a terminal prompt WITHOUT submitting it: control characters (ESC included) removed; with
 * bracketed paste on, the text is wrapped as one paste (newlines stay part of it); otherwise it is joined into one
 * line, so no newline can submit it.
 */
export function prefillInput(text: string, bracketed: boolean): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '');
  if (bracketed) return `\u001b[200~${clean.replace(/\n+$/, '')}\u001b[201~`;
  return clean.replace(/\s*\n\s*/g, ' ').trim();
}

export interface TerminalStoreDeps {
  post(message: PtyToHost): boolean;
  subscribe(fn: (event: PtyLinkEvent) => void): () => void;
  createTerm(session: { key: string; cwd: string }): TermSink;
  newId?(): string;
  /** A pty may only be opened from a user gesture (default: navigator.userActivation). */
  hasUserActivation?(): boolean;
  /** Called once a session the user started is running (recent directories). */
  onStarted?(typedCwd: string): void;
  /** Timers (tests). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const NOT_CONNECTED_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const LINK_LOST_ERROR = 'Lost the connection to the kineReqLens service worker — the terminal was closed';

/** Last path segment of a directory, for tab labels. */
export function dirLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return cwd || '/';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function defaultUserActivation(): boolean {
  try {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
  } catch {
    return true;
  }
}

/** The terminal sessions of this panel. */
export class TerminalStore {
  private readonly sessions: TerminalSession[] = [];
  private readonly listeners = new Set<() => void>();
  private nextKey = 1;
  private version = 0;
  private unsubscribe: (() => void) | null = null;
  private dims = { cols: 80, rows: 24 };
  /** Selected tab: a session key, or 'new' (the working-directory form). */
  active: string = 'new';
  /** Why the last start from the form failed (shown by the form), with the directory it was for. */
  formError: { cwd: string; error: string } | null = null;

  constructor(private readonly deps: TerminalStoreDeps) {
    this.unsubscribe = deps.subscribe((event) => this.onEvent(event));
  }

  /** Bumped on every change (for useSyncExternalStore-style hooks). */
  get revision(): number {
    return this.version;
  }

  list(): readonly TerminalSession[] {
    return this.sessions;
  }

  get(key: string): TerminalSession | undefined {
    return this.sessions.find((s) => s.key === key);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  select(key: string): void {
    if (key !== 'new' && !this.get(key)) return;
    if (this.active === key) return;
    this.active = key;
    this.changed();
  }

  /**
   * Start `claude` in `cwd` (from a click). `prefill`: text typed into its prompt (not submitted) once it is idle.
   * Returns the session, or an error.
   */
  start(cwd: string, cols: number, rows: number, options: { prefill?: string } = {}): { ok: true; session: TerminalSession } | { ok: false; error: string } {
    const typed = cwd.trim();
    if (!typed) return { ok: false, error: 'Choose a working directory' };
    if (!(this.deps.hasUserActivation ?? defaultUserActivation)()) return { ok: false, error: 'Click Start to open a terminal' };
    this.rememberDims(cols, rows);
    const ptyId = this.newId();
    const { cols: c, rows: r } = this.dims;
    if (!this.deps.post({ t: 'pty-open', id: ptyId, cwd: typed, cols: c, rows: r })) return { ok: false, error: NOT_CONNECTED_ERROR };
    const key = `t${this.nextKey++}`;
    const session: TerminalSession = {
      key,
      ptyId,
      typedCwd: typed,
      cwd: typed,
      state: 'opening',
      everRan: false,
      term: this.deps.createTerm({ key, cwd: typed }),
    };
    if (options.prefill) session.prefill = options.prefill;
    this.sessions.push(session);
    this.active = key;
    this.formError = null;
    this.changed();
    return { ok: true, session };
  }

  /** Kill (when running) and start again in the same directory, with a cleared screen. */
  restart(key: string, cols?: number, rows?: number): boolean {
    const session = this.get(key);
    if (!session) return false;
    if (!(this.deps.hasUserActivation ?? defaultUserActivation)()) return false;
    if (cols !== undefined && rows !== undefined) this.rememberDims(cols, rows);
    // Also for exited ones: the worker keeps an exited terminal (and its replay) until it is closed.
    this.deps.post({ t: 'pty-close', id: session.ptyId });
    session.ptyId = this.newId();
    session.state = 'opening';
    delete session.pid;
    delete session.exit;
    delete session.error;
    session.term.reset();
    this.open(session);
    this.changed();
    return true;
  }

  /** Close a tab: kill its process and drop its scrollback. */
  close(key: string): void {
    const session = this.get(key);
    if (!session) return;
    // Exited / failed sessions are still known to the worker until closed (it keeps their replay).
    this.deps.post({ t: 'pty-close', id: session.ptyId });
    this.remove(session);
  }

  private remove(session: TerminalSession): void {
    const index = this.sessions.indexOf(session);
    if (index < 0) return;
    this.sessions.splice(index, 1);
    try {
      session.term.dispose();
    } catch {
      /* already disposed */
    }
    if (this.active === session.key) {
      const next = this.sessions[Math.min(index, this.sessions.length - 1)];
      this.active = next && !this.formError ? next.key : 'new';
    }
    this.changed();
  }

  /** Keystrokes / pastes of a session (split into ≤ 64 KB chunks). */
  input(key: string, data: string): void {
    const session = this.get(key);
    if (!session || session.state !== 'running' || !data) return;
    for (const chunk of splitPtyInput(data)) this.deps.post({ t: 'pty-input', id: session.ptyId, data: chunk });
  }

  /**
   * Type `text` into a running session as the user would paste it (prefillInput: control characters stripped, one
   * bracketed paste when the program enabled it, else one line), then — with `submit` — press Enter a moment later
   * (after the program took the paste in). False when the session is not running.
   */
  typeText(key: string, text: string, options: { submit?: boolean } = {}): boolean {
    const session = this.get(key);
    if (!session || session.state !== 'running') return false;
    const input = prefillInput(text, session.bracketedPaste === true);
    if (!input) return false;
    // A pending "Open in terminal" pre-fill must not land after this text.
    delete session.prefill;
    this.input(key, input);
    if (options.submit) {
      const ptyId = session.ptyId;
      this.setTimer(() => {
        if (session.ptyId === ptyId && session.state === 'running') this.input(key, '\r');
      }, SUBMIT_DELAY_MS);
    }
    return true;
  }

  /** The terminal was fitted to a new size. */
  resize(key: string, cols: number, rows: number): void {
    if (!isPtyDim(cols) || !isPtyDim(rows)) return;
    this.rememberDims(cols, rows);
    const session = this.get(key);
    if (!session || (session.state !== 'running' && session.state !== 'opening')) return;
    this.deps.post({ t: 'pty-resize', id: session.ptyId, cols, rows });
  }

  /** Stop following the link (tests). */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private open(session: TerminalSession): void {
    const { cols, rows } = this.dims;
    if (!this.deps.post({ t: 'pty-open', id: session.ptyId, cwd: session.typedCwd, cols, rows })) {
      session.state = 'error';
      session.error = NOT_CONNECTED_ERROR;
    }
  }

  private newId(): string {
    return (this.deps.newId ?? newPtyId)();
  }

  private rememberDims(cols: number, rows: number): void {
    if (isPtyDim(cols) && isPtyDim(rows)) this.dims = { cols, rows };
  }

  private onEvent(event: PtyLinkEvent): void {
    if (event.t === 'link-lost') {
      let any = false;
      for (const session of this.sessions) {
        if (session.state !== 'opening' && session.state !== 'running') continue;
        session.state = session.state === 'opening' ? 'error' : 'exited';
        session.error = LINK_LOST_ERROR;
        any = true;
      }
      if (any) this.changed();
      return;
    }
    if (event.t === 'pty-attached') {
      this.attach(event);
      return;
    }
    const session = this.sessions.find((s) => s.ptyId === event.id);
    if (!session) return;
    this.apply(session, event);
  }

  private readonly prefillTimers = new Map<string, { quiet: unknown; max: unknown }>();

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  /** Type the pending pre-fill now (once). */
  private flushPrefill(session: TerminalSession): void {
    const timers = this.prefillTimers.get(session.key);
    if (timers) {
      this.clearTimer(timers.quiet);
      this.clearTimer(timers.max);
      this.prefillTimers.delete(session.key);
    }
    const text = session.prefill;
    delete session.prefill;
    if (!text || session.state !== 'running') return;
    this.input(session.key, prefillInput(text, session.bracketedPaste === true));
  }

  /** (Re)arm the quiet timer of a pending pre-fill (output keeps it waiting, up to PREFILL_MAX_WAIT_MS). */
  private armPrefill(session: TerminalSession): void {
    if (!session.prefill) return;
    let timers = this.prefillTimers.get(session.key);
    if (!timers) {
      timers = { quiet: null, max: this.setTimer(() => this.flushPrefill(session), PREFILL_MAX_WAIT_MS) };
      this.prefillTimers.set(session.key, timers);
    }
    this.clearTimer(timers.quiet);
    timers.quiet = this.setTimer(() => this.flushPrefill(session), PREFILL_QUIET_MS);
  }

  private apply(session: TerminalSession, event: PtyFromHost): void {
    switch (event.t) {
      case 'pty-data': {
        session.term.write(event.data);
        const on = event.data.lastIndexOf('\u001b[?2004h');
        const off = event.data.lastIndexOf('\u001b[?2004l');
        if (on > off) session.bracketedPaste = true;
        else if (off > on) session.bracketedPaste = false;
        if (session.prefill && session.state === 'running') this.armPrefill(session);
        return; // output does not re-render the tab strip
      }
      case 'pty-opened': {
        const wasOpening = session.state === 'opening';
        session.state = 'running';
        session.everRan = true;
        session.pid = event.pid;
        if (event.cwd) session.cwd = event.cwd;
        if (wasOpening) this.deps.onStarted?.(session.typedCwd);
        if (session.prefill) this.armPrefill(session);
        break;
      }
      case 'pty-exit':
        delete session.prefill;
        session.state = 'exited';
        session.exit = { code: event.code, signal: event.signal };
        break;
      case 'pty-error':
        session.error = event.error;
        if (session.state === 'opening') {
          if (!session.everRan) {
            // Bad directory, node-pty missing…: back to the form, with the reason.
            this.formError = { cwd: session.typedCwd, error: event.error };
            this.remove(session);
            return;
          }
          session.state = 'error';
        }
        break;
    }
    this.changed();
  }

  /** A terminal of this tab that outlived a panel reload. */
  private attach(event: LinkPtyAttached): void {
    if (!isPtyId(event.id) || typeof event.cwd !== 'string') return;
    let session = this.sessions.find((s) => s.ptyId === event.id);
    if (!session) {
      const key = `t${this.nextKey++}`;
      session = {
        key,
        ptyId: event.id,
        typedCwd: event.cwd,
        cwd: event.cwd,
        state: 'opening',
        everRan: event.state !== 'opening',
        term: this.deps.createTerm({ key, cwd: event.cwd }),
      };
      this.sessions.push(session);
      if (this.active === 'new') this.active = key;
    } else {
      session.term.reset();
    }
    session.state = event.state === 'exited' ? 'exited' : event.state;
    if (typeof event.pid === 'number') session.pid = event.pid;
    if (event.exit) session.exit = event.exit;
    if (typeof event.replay === 'string' && event.replay) session.term.write(event.replay);
    this.changed();
  }

  private changed(): void {
    this.version++;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[kineReqLens] terminal store listener failed', err);
      }
    }
  }
}
