// OWNER: ui-export agent. Pure view models of the Claude Code bridge status (Settings → Claude Code, the Export
// tab's "Send to Claude Code", the request-list context menu) and the setup commands.
import type { BridgeStatus, ClaudeSessionInfo } from '../../shared/claude-protocol';

export type StatusTone = 'off' | 'busy' | 'ok' | 'warn' | 'error';

export interface StatusView {
  tone: StatusTone;
  /** Short label, e.g. "Connected · 2 sessions". */
  label: string;
  /** One sentence telling the user what is going on / what to do next. */
  detail?: string;
}

/** "api, web" (labels of the sessions, deduplicated with their count when several share a label). */
export function sessionLabels(sessions: readonly ClaudeSessionInfo[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.label || 'session', (counts.get(s.label || 'session') ?? 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ');
}

/** Status line of Settings → Claude Code. */
export function bridgeStatusView(status: BridgeStatus): StatusView {
  if (!status.enabled) {
    return { tone: 'off', label: 'Off', detail: 'Enable the bridge to send requests and agent prompts to Claude Code.' };
  }
  if (!status.permission) {
    return {
      tone: 'warn',
      label: 'Permission needed',
      detail: 'kineReqLens needs the "communicate with cooperating native applications" permission to reach the local bridge.',
    };
  }
  switch (status.host) {
    case 'not-installed':
      return {
        tone: 'warn',
        label: 'Not installed',
        detail: 'The local bridge (reqlens-mcp) is not installed for this browser yet — run step 1 below.',
      };
    case 'error':
      return {
        tone: 'error',
        label: status.error ? `Error: ${status.error}` : 'Error: the local bridge stopped unexpectedly',
        detail: 'Run `node mcp/dist/reqlens-mcp.mjs doctor` in your reqlens checkout to diagnose it.',
      };
    case 'connected': {
      const n = status.sessions.length;
      if (n === 0) {
        return {
          tone: 'ok',
          label: 'Connected · no Claude Code session',
          detail: 'Start Claude Code in your project (with the reqlens MCP server added, step 2).',
        };
      }
      return {
        tone: 'ok',
        label: `Connected · ${n} session${n === 1 ? '' : 's'}: ${sessionLabels(status.sessions)}`,
        detail: [...new Set(status.sessions.map((s) => s.cwd).filter(Boolean))].join(' · ') || undefined,
      };
    }
    case 'connecting':
    case 'off':
      return { tone: 'busy', label: 'Connecting…' };
  }
}

export type SendAvailability =
  | { ok: true; sessions: ClaudeSessionInfo[] }
  /** `setup`: the fix is in Settings → Claude Code (as opposed to "start a Claude Code session"). */
  | { ok: false; reason: string; setup: boolean };

/** Whether "Send to Claude Code" can deliver right now, and why not. */
export function sendAvailability(status: BridgeStatus): SendAvailability {
  if (!status.enabled) return { ok: false, reason: 'The Claude Code bridge is off.', setup: true };
  if (!status.permission) return { ok: false, reason: 'The Claude Code bridge needs a browser permission.', setup: true };
  switch (status.host) {
    case 'not-installed':
      return { ok: false, reason: 'The Claude Code bridge is not installed.', setup: true };
    case 'error':
      return { ok: false, reason: status.error ? `Bridge error: ${status.error}` : 'The Claude Code bridge reported an error.', setup: true };
    case 'connecting':
    case 'off':
      return { ok: false, reason: 'Connecting to the Claude Code bridge…', setup: false };
    case 'connected':
      break;
  }
  if (status.sessions.length === 0) {
    return { ok: false, reason: 'No Claude Code session is connected — start `claude` in your project.', setup: false };
  }
  return { ok: true, sessions: status.sessions };
}

/** Placeholder shown in commands until the extension id is known. */
export const UNKNOWN_EXTENSION_ID = '<extension-id>';

/** Setup commands of Settings → Claude Code (spec B.5). */
export function setupCommands(extensionId: string): { install: string; add: string; channels: string } {
  const id = /^[\w-]{1,64}$/.test(extensionId) ? extensionId : UNKNOWN_EXTENSION_ID;
  return {
    install: `npm run mcp:install -- --extension-id ${id}`,
    add: 'claude mcp add --scope user reqlens -- node <path-to-reqlens>/mcp/dist/reqlens-mcp.mjs',
    channels: 'claude --dangerously-load-development-channels server:reqlens',
  };
}
