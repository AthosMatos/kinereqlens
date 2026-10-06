import { describe, expect, it } from 'vitest';
import type { BridgeStatus, ClaudeSessionInfo } from '../../src/shared/claude-protocol';
import {
  UNKNOWN_EXTENSION_ID,
  bridgeStatusView,
  sendAvailability,
  sessionLabels,
  setupCommands,
} from '../../src/ui/export/claudeStatus';

const session = (id: string, label: string): ClaudeSessionInfo => ({ id, label, cwd: `/work/${label}`, pid: 100, connectedAt: 1 });

const base: BridgeStatus = {
  enabled: true,
  permission: true,
  host: 'connected',
  sessions: [session('a', 'api')],
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
};

describe('bridgeStatusView', () => {
  it('reports off, permission, install and error states', () => {
    expect(bridgeStatusView({ ...base, enabled: false })).toMatchObject({ tone: 'off', label: 'Off' });
    expect(bridgeStatusView({ ...base, permission: false })).toMatchObject({ tone: 'warn', label: 'Permission needed' });
    expect(bridgeStatusView({ ...base, host: 'not-installed' })).toMatchObject({ tone: 'warn', label: 'Not installed' });
    expect(bridgeStatusView({ ...base, host: 'error', error: 'Another browser is already connected to Claude Code' })).toMatchObject({
      tone: 'error',
      label: 'Error: Another browser is already connected to Claude Code',
    });
    expect(bridgeStatusView({ ...base, host: 'connecting' })).toMatchObject({ tone: 'busy', label: 'Connecting…' });
    expect(bridgeStatusView({ ...base, host: 'off' })).toMatchObject({ tone: 'busy' });
  });

  it('counts and names the sessions when connected', () => {
    expect(bridgeStatusView(base)).toEqual({ tone: 'ok', label: 'Connected · 1 session: api', detail: '/work/api' });
    const two = bridgeStatusView({ ...base, sessions: [session('a', 'api'), session('b', 'web')] });
    expect(two).toMatchObject({ label: 'Connected · 2 sessions: api, web', detail: '/work/api · /work/web' });
    expect(bridgeStatusView({ ...base, sessions: [] })).toMatchObject({ tone: 'ok', label: 'Connected · no Claude Code session' });
  });
});

describe('sessionLabels', () => {
  it('collapses repeated labels with a count', () => {
    expect(sessionLabels([session('a', 'api'), session('b', 'api'), session('c', 'web')])).toBe('api ×2, web');
    expect(sessionLabels([])).toBe('');
  });
});

describe('sendAvailability', () => {
  it('is available only when connected with at least one session', () => {
    expect(sendAvailability(base)).toEqual({ ok: true, sessions: base.sessions });
    expect(sendAvailability({ ...base, sessions: [] })).toMatchObject({ ok: false, setup: false });
    expect(sendAvailability({ ...base, enabled: false })).toMatchObject({ ok: false, setup: true });
    expect(sendAvailability({ ...base, permission: false })).toMatchObject({ ok: false, setup: true });
    expect(sendAvailability({ ...base, host: 'not-installed' })).toMatchObject({ ok: false, setup: true });
    expect(sendAvailability({ ...base, host: 'error', error: 'boom' })).toMatchObject({ ok: false, reason: 'Bridge error: boom' });
    expect(sendAvailability({ ...base, host: 'connecting' })).toMatchObject({ ok: false, setup: false });
  });
});

describe('setupCommands', () => {
  it('embeds the extension id in the install command', () => {
    const cmds = setupCommands(base.extensionId);
    expect(cmds.install).toBe(`npm run mcp:install -- --extension-id ${base.extensionId}`);
    expect(cmds.add).toBe('claude mcp add --scope user reqlens -- node <path-to-reqlens>/mcp/dist/reqlens-mcp.mjs');
    expect(cmds.channels).toBe('claude --dangerously-load-development-channels server:reqlens');
  });

  it('falls back to a placeholder for a missing or odd id', () => {
    expect(setupCommands('').install).toContain(UNKNOWN_EXTENSION_ID);
    expect(setupCommands('x; rm -rf /').install).toContain(UNKNOWN_EXTENSION_ID);
  });
});
