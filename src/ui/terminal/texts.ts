// Texts of the Claude Code terminal pane (pure, unit-tested).
import type { BridgeStatus } from '../../shared/claude-protocol';
import type { TerminalSession } from './store';

/** Why the terminal cannot run right now (null = it can). */
export function terminalUnavailableReason(status: BridgeStatus): string | null {
  if (!status.enabled) return 'The Claude Code bridge is off. Enable it in Settings → Claude Code to run Claude here.';
  if (!status.permission) return 'kineReqLens needs the native messaging permission — grant it in Settings → Claude Code.';
  switch (status.host) {
    case 'connected':
      return null;
    case 'connecting':
      return 'Connecting to the kineReqLens bridge…';
    case 'not-installed':
      return 'The kineReqLens bridge is not installed yet — follow the setup steps in Settings → Claude Code.';
    default:
      return `The kineReqLens bridge is disconnected${status.error ? `: ${status.error}` : ''}. See Settings → Claude Code.`;
  }
}

/** Status line text of a session. */
export function sessionStatusText(session: Pick<TerminalSession, 'state' | 'cwd' | 'exit' | 'error'>): string {
  switch (session.state) {
    case 'opening':
      return `Starting claude in ${session.cwd}…`;
    case 'running':
      return `Running · ${session.cwd}`;
    case 'error':
      return session.error ?? 'The terminal could not start';
    case 'exited': {
      const exit = session.exit;
      let text = 'Exited';
      if (exit && exit.signal !== null) text = `Exited (signal ${exit.signal})`;
      else if (exit && exit.code !== null) text = `Exited (code ${exit.code})`;
      if (exit?.code === 127) text += ' — `claude` was not found on your login shell’s PATH (install Claude Code, or check ~/.zshrc / ~/.bashrc)';
      if (session.error) text += ` — ${session.error}`;
      return text;
    }
  }
}
