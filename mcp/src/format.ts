// Text rendering of bridge results for Claude (concise markdown). Pure functions. Captured values come from
// web pages: they go into table cells, code fences (fence longer than any backtick run inside) or single lines
// with newlines collapsed, so page data cannot fake the structure of a result.
import type {
  BodyForClaude,
  BridgeCalls,
  ClaudeSessionInfo,
  InboxItem,
  RequestDetailForClaude,
  RequestSummary,
  RunForClaude,
  TabSummary,
} from '../../src/shared/claude-protocol';
import type { HubClientStatus } from './client';
import { screenshotLine } from '../../src/shared/shot-protocol';
import { UNTRUSTED_NOTE, cell, clipToolText, code, fence, formatBytes, formatDuration, isoTime } from '../../src/shared/markdown';

export const DEFAULT_MAX_BODY_CHARS = 20_000;
// Markdown helpers shared with the extension's control plane (src/shared/markdown.ts).
export { MAX_TOOL_TEXT_CHARS, UNTRUSTED_NOTE, cell, clipToolText, code, fence, formatBytes, formatDuration } from '../../src/shared/markdown';

function statusLabel(status: number | undefined, state: string): string {
  if (status !== undefined) return String(status);
  return state === 'done' ? '—' : state;
}

function bodyLang(body: BodyForClaude): string {
  if (body.kind === 'json' || body.kind === 'graphql') return 'json';
  const type = (body.contentType ?? '').toLowerCase();
  if (type.includes('html')) return 'html';
  if (type.includes('xml')) return 'xml';
  if (type.includes('javascript')) return 'js';
  if (type.includes('css')) return 'css';
  return '';
}

function headerBlock(headers: Array<[string, string]>): string {
  if (headers.length === 0) return '_No headers._';
  return fence(headers.map(([name, value]) => `${name}: ${value}`).join('\n'), 'http');
}

function queryTable(query: Array<[string, string]>): string {
  const rows = query.map(([name, value]) => `| ${cell(name)} | ${cell(value, 2000)} |`);
  return ['| name | value |', '|---|---|', ...rows].join('\n');
}

/** Body section: heading line with metadata, then a code block (or the note for binary/unavailable). */
export function formatBody(title: string, body: BodyForClaude | null | undefined, level = '###'): string {
  if (!body || body.kind === 'none') return `${level} ${title}\n_No body._`;
  const meta = [body.contentType, body.kind, body.size !== undefined ? formatBytes(body.size) : undefined]
    .filter((part): part is string => !!part)
    .join(' · ');
  const heading = `${level} ${title}${meta ? ` · ${meta}` : ''}${body.truncated ? ' (truncated)' : ''}`;
  if (body.kind === 'binary' || body.kind === 'unavailable') return `${heading}\n_${body.text.replace(/[\r\n]+/g, ' ') || body.kind}_`;
  if (!body.text) return `${heading}\n_Empty body._`;
  return `${heading}\n${fence(body.text, bodyLang(body))}`;
}

// ---------------------------------------------------------------------------------------------------------
// Setup hints
// ---------------------------------------------------------------------------------------------------------

export interface SetupContext {
  /** The native host launcher exists in $REQLENS_HOME (i.e. `reqlens-mcp install` ran). */
  installed: boolean;
  /** Absolute path of reqlens-mcp.mjs (for the doctor command). */
  scriptPath?: string;
  socketPath?: string;
  /** A configuration problem that makes connecting impossible (e.g. socket path too long). */
  problem?: string;
}

export const ENABLE_HINT = 'Open Edge → kineReqLens overlay → Settings → Claude Code → Enable';
export const INSTALL_HINT =
  'Run `npm run mcp:install -- --extension-id <id>` in the kineReqLens repo (the id is shown in the overlay under Settings → Claude Code)';

/** Why kineReqLens cannot be reached, with what to do about it. */
export function notConnectedText(status: HubClientStatus, setup: SetupContext): string {
  const doctor = setup.scriptPath ? `\`node "${setup.scriptPath}" doctor\`` : '`reqlens-mcp doctor`';
  if (setup.problem) return `kineReqLens is not connected: ${setup.problem}`;
  if (status.state === 'connected' && !status.extension.connected) {
    return 'kineReqLens: the bridge is running but the extension has not finished connecting. Try again in a moment.';
  }
  if (status.lastErrorCode === 'EACCES' || status.lastErrorCode === 'EPERM') {
    return `kineReqLens is not connected: permission denied on the hub socket${setup.socketPath ? ` ${setup.socketPath}` : ''}. Run ${doctor} for details.`;
  }
  if (!setup.installed) {
    return [
      'kineReqLens is not connected: the browser bridge (native messaging host) is not installed.',
      'Setup:',
      `1. ${INSTALL_HINT}.`,
      `2. ${ENABLE_HINT}.`,
      `Then run ${doctor} if it still does not connect.`,
    ].join('\n');
  }
  if (status.state === 'connecting' || status.lastErrorCode === 'ETIMEDOUT') {
    return `kineReqLens is not connected yet: still connecting to the bridge. Try again in a moment; if it persists run ${doctor}.`;
  }
  return [
    'kineReqLens is not connected: the browser bridge is not running.',
    `${ENABLE_HINT} (the browser must be running with the kineReqLens extension).`,
    `If it is enabled and still not connected, run ${doctor}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------------------------------------

export interface StatusView {
  hub: HubClientStatus;
  session: Omit<ClaudeSessionInfo, 'connectedAt'>;
  /** The extension's answer to `status` (absent when not connected or when it failed). */
  result?: BridgeCalls['status']['result'];
  /** Not-connected explanation or the error of the status call. */
  problem?: string;
  /** Unseen inbox items of this session. */
  inbox: number;
}

function tabsTable(tabs: TabSummary[]): string {
  const rows = tabs.map(
    (tab) =>
      `| ${tab.active ? '*' : ''} | ${tab.tabId} | ${tab.open ? (tab.hidden ? 'open (hidden)' : 'open') : 'closed'} | ${tab.recording ? 'on' : 'paused'} | ${tab.entryCount} | ${cell(tab.title, 80)} | ${cell(tab.url)} |`,
  );
  return ['| default | tabId | overlay | recording | requests | title | url |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

export function formatStatus(view: StatusView): string {
  const lines: string[] = [];
  const result = view.result;
  if (result) {
    const ext = view.hub.extension;
    const browser = result.browser || ext.browser || 'browser';
    lines.push(`kineReqLens: connected (extension ${result.extensionVersion || ext.version || '?'}, ${browser}).`);
    lines.push(
      result.allowSend
        ? 'send_request: allowed.'
        : 'send_request: off (the user can enable "Allow Claude to send requests" in kineReqLens Settings → Claude Code).',
    );
    lines.push(result.shareSecrets ? 'Secrets: shared with Claude (not redacted).' : 'Secrets: redacted ("<redacted>").');
    lines.push(
      result.allowControl === true
        ? 'Control tools: on (inspect, overlay, requests, edit_request, list_config, setups, language, settings, errors, screenshot, find_in_page).'
        : 'Control tools: off (the user can enable "Let Claude control kineReqLens" in kineReqLens Settings → Claude Code).',
    );
  } else {
    lines.push(view.problem ?? 'kineReqLens is not connected.');
  }
  lines.push(`This session: ${view.session.label} (${view.session.id}).`);
  if (view.inbox > 0) lines.push(`Inbox: ${view.inbox} new item(s) — call the inbox tool.`);
  if (result) {
    lines.push('');
    if (result.tabs.length === 0) {
      lines.push('No tab has kineReqLens open. Ask the user to open the overlay (toolbar button or Alt+Shift+L) in the tab to inspect.');
    } else {
      lines.push('Tabs (default = used when tabId is omitted):');
      lines.push(tabsTable(result.tabs));
    }
  }
  return lines.join('\n');
}

function requestFlags(request: RequestSummary): string {
  const flags: string[] = [];
  if (request.selected) flags.push('selected');
  if (request.modified) flags.push('edited');
  if (request.runs > 0) flags.push(`${request.runs} run${request.runs === 1 ? '' : 's'}`);
  return flags.join(', ');
}

export function formatRequestList(result: BridgeCalls['listRequests']['result'], offset = 0): string {
  const { requests, total, tabId } = result;
  if (requests.length === 0) {
    return total > 0
      ? `Tab ${tabId}: no requests in this range (${total} match in total).`
      : `Tab ${tabId}: no captured requests match.`;
  }
  const first = offset + 1;
  const last = offset + requests.length;
  const lines = [`Tab ${tabId} · ${total} request${total === 1 ? '' : 's'} match (showing ${first}–${last}, newest first).`, ''];
  lines.push('| id | method | status | kind | duration | size | url | notes |', '|---|---|---|---|---|---|---|---|');
  for (const request of requests) {
    lines.push(
      `| ${cell(request.id, 80)} | ${cell(request.method, 16)} | ${statusLabel(request.status, request.state)} | ${request.kind} | ${formatDuration(request.durationMs)} | ${formatBytes(request.size)} | ${cell(request.url)} | ${cell(requestFlags(request))} |`,
    );
  }
  if (last < total) lines.push('', `${total - last} more: call list_requests with offset ${last} (or narrow with query/methods/statuses).`);
  return lines.join('\n');
}

function requestSection(title: string, request: RequestDetailForClaude['request']): string {
  const parts = [`## ${title}`, `${request.method} ${request.url}`];
  if (request.query.length > 0) parts.push('### Query', queryTable(request.query));
  parts.push('### Headers', headerBlock(request.headers));
  parts.push(formatBody('Body', request.body));
  return parts.join('\n');
}

function responseSection(response: RequestDetailForClaude['response']): string {
  if (!response) return '## Response\n_No response (pending, failed or aborted)._';
  const status = response.status !== undefined ? `${response.status}${response.statusText ? ` ${response.statusText}` : ''}` : '—';
  const parts = [`## Response · ${status}`, '### Headers', headerBlock(response.headers), formatBody('Body', response.body)];
  if (response.note) parts.push(`_Note: ${response.note.replace(/[\r\n]+/g, ' ')}_`);
  return parts.join('\n');
}

function runHeading(run: RunForClaude, prefix: string, statusText?: string): string {
  const status = statusLabel(run.status, run.state);
  const parts = [
    `${prefix} \`${run.runId}\``,
    run.origin === 'claude' ? 'by Claude' : 'by the user',
    run.state,
    `${run.mode} mode`,
    run.status !== undefined && statusText ? `${status} ${statusText}` : status,
    formatDuration(run.durationMs),
    isoTime(run.startedAt),
  ];
  return parts.join(' · ');
}

function runSection(run: RunForClaude, index: number): string {
  const parts = [`### ${runHeading(run, `${index + 1}. run`)}`, `${run.request.method} ${run.request.url}`];
  if (run.error) parts.push(`Error: ${run.error.replace(/[\r\n]+/g, ' ')}`);
  if (run.responseBody !== undefined) parts.push(formatBody('Response body', run.responseBody, '####'));
  return parts.join('\n');
}

export function formatRequestDetail(detail: RequestDetailForClaude): string {
  const { summary } = detail;
  const meta = [
    code(summary.id),
    summary.kind,
    statusLabel(summary.status, summary.state),
    formatDuration(summary.durationMs),
    formatBytes(summary.size),
    requestFlags(summary),
  ].filter((part) => part && part !== '—');
  const parts = [`# ${summary.method} ${summary.url}`, meta.join(' · '), `Page: ${detail.pageUrl || '—'} · started ${isoTime(summary.startTime)}`];
  if (detail.redacted) parts.push('Secret values are redacted ("<redacted>").');
  parts.push('', UNTRUSTED_NOTE, '', requestSection('Request', detail.request), '', responseSection(detail.response));
  if (detail.edited) parts.push('', requestSection("Edited version (the user's unsent draft)", detail.edited));
  if (detail.runs && detail.runs.length > 0) {
    parts.push('', '## Test runs (newest first)', ...detail.runs.map((run, index) => runSection(run, index)));
  }
  return clipToolText(parts.join('\n'));
}

export function formatTypes(result: BridgeCalls['getTypes']['result']): string {
  const lang = result.format === 'json-schema' ? 'json' : 'ts';
  const parts = [fence(result.code, lang)];
  const names = Object.entries(result.names);
  if (names.length > 0) parts.push(`Root types: ${names.map(([role, name]) => `${role} → \`${name}\``).join(', ')}`);
  if (result.notes.length > 0) parts.push('Notes:', ...result.notes.map((note) => `- ${note.replace(/[\r\n]+/g, ' ')}`));
  return clipToolText(parts.join('\n'));
}

export function formatPromptResult(result: BridgeCalls['getPrompt']['result']): string {
  return clipToolText(result.prompt);
}

/**
 * Extra facts the extension adds to send_request's RunForClaude (src/background/claude/format.ts `RunDetails`).
 * All optional: an older extension sends plain RunForClaude.
 */
export interface RunExtras {
  statusText?: string;
  responseHeaders?: Array<[string, string]>;
  finalUrl?: string;
  droppedHeaders?: string[];
  appliedViaDnr?: string[];
  redacted?: boolean;
}

function nameList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value.filter((v): v is string => typeof v === 'string').map((v) => code(v.slice(0, 200)));
  return names.length ? names.join(', ') : null;
}

/** Run result; also renders the RunExtras when the extension includes them. */
export function formatRun(run: RunForClaude & RunExtras): string {
  const statusText = typeof run.statusText === 'string' ? cell(run.statusText, 80).replace(/^—$/, '') : '';
  const parts = [`# ${runHeading(run, 'Run', statusText)}`, `${run.request.method} ${run.request.url}`];
  if (typeof run.finalUrl === 'string' && run.finalUrl) parts.push(`Redirected to: ${run.finalUrl.replace(/[\r\n]+/g, ' ')}`);
  if (run.error) parts.push(`Error: ${run.error.replace(/[\r\n]+/g, ' ')}`);
  const dropped = nameList(run.droppedHeaders);
  if (dropped) parts.push(`Headers the browser did not send: ${dropped}`);
  const dnr = nameList(run.appliedViaDnr);
  if (dnr) parts.push(`Forbidden headers applied through a declarativeNetRequest rule: ${dnr}`);
  if (run.redacted === true) parts.push('Secret values are redacted ("<redacted>").');
  parts.push('', UNTRUSTED_NOTE, '');
  if (Array.isArray(run.responseHeaders)) parts.push('## Response headers', headerBlock(run.responseHeaders));
  if (run.responseBody !== undefined) parts.push(formatBody('Response body', run.responseBody, '##'));
  return clipToolText(parts.join('\n'));
}

export function formatInbox(items: InboxItem[], cleared: number): string {
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push('No new items in the kineReqLens inbox. (The user adds items with "Send to Claude Code" in the overlay.)');
  } else {
    lines.push(`${items.length} new item${items.length === 1 ? '' : 's'} sent from kineReqLens with "Send to Claude Code" (oldest first):`);
    for (const item of items) {
      const images = item.images ?? [];
      const facts = [
        ...(item.entryId ? [`request ${code(item.entryId)}`] : []),
        `tab ${item.tabId}`,
        ...(images.length ? [`${images.length} screenshot${images.length === 1 ? '' : 's'}`] : [`target ${item.target}`]),
        `sent ${isoTime(item.sentAt)}`,
      ];
      lines.push('', '---', `## ${item.title.replace(/[\r\n]+/g, ' ')}`, facts.join(' · '), '', item.prompt);
      for (const image of images) lines.push('', `${screenshotLine(image.path)} — ${image.width} × ${image.height} px`);
    }
  }
  if (cleared > 0) lines.push('', `Inbox cleared (${cleared} item${cleared === 1 ? '' : 's'} removed).`);
  return clipToolText(lines.join('\n'));
}
