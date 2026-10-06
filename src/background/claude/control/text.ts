// Rendering of control-plane answers as markdown for Claude. Page data is redacted (unless the user shares secrets),
// clipped, and fenced or put on single lines (src/shared/markdown.ts), under the untrusted-data note. Pure.
import type { BodyForClaude, RequestDetailForClaude } from '../../../shared/claude-protocol';
import type {
  ControlTraceItem,
  PanelDraftResult,
  PanelErrorGroup,
  PanelErrorRun,
  PanelErrorsResult,
  PanelWsConnection,
  PanelWsFrame,
  PanelWsMessagesResult,
} from '../../../shared/control-protocol';
import type { ElementInfo, FindCommandResult } from '../../../shared/control-shot';
import type { HeaderPair, ReplayRequest } from '../../../shared/types';
import { UNTRUSTED_NOTE, cell, code, fence, formatBytes, formatDuration, isoTime, line, table } from '../../../shared/markdown';
import { toCurl, toFetchSnippet } from '../../../lib/curl';
import { lineDiff, withContext } from '../../../lib/diff';
import type { InitiatorAnalysis } from '../../../lib/initiator';
import { functionLabel, locationText, vscodeUrl } from '../../../lib/initiator';
import { bodyOut, editedRequest, headersOut, redactText, urlOut, wireToSerialized } from '../format';
import type { FormatContext } from '../format';

export { UNTRUSTED_NOTE };

/** Body section (heading + fenced text or a note). */
export function bodyBlock(title: string, body: BodyForClaude | null | undefined, level = '###'): string {
  if (!body || body.kind === 'none') return `${level} ${title}\n_No body._`;
  const meta = [body.contentType, body.kind, body.size !== undefined ? formatBytes(body.size) : undefined].filter(Boolean).join(' · ');
  const heading = `${level} ${title}${meta ? ` · ${meta}` : ''}${body.truncated ? ' (truncated)' : ''}`;
  if (body.kind === 'binary' || body.kind === 'unavailable') return `${heading}\n_${line(body.text) || body.kind}_`;
  if (!body.text) return `${heading}\n_Empty body._`;
  return `${heading}\n${fence(body.text, body.kind === 'json' || body.kind === 'graphql' ? 'json' : '')}`;
}

export function headerLines(headers: Array<[string, string]>): string {
  return headers.length ? fence(headers.map(([n, v]) => `${n}: ${v}`).join('\n'), 'http') : '_No headers._';
}

/** The draft as Send would send it (redacted), with options, warnings and blocking errors. */
export function draftText(result: PanelDraftResult, ctx: FormatContext, maxChars: number, title = 'Edited request'): string {
  const req: RequestDetailForClaude['request'] = editedRequest(result.draft, ctx, maxChars);
  const o = result.options;
  const parts = [
    `## ${title}${result.modified ? '' : ' (unchanged: same as captured)'}`,
    `${req.method} ${req.url}`,
    `Send options: ${o.mode} mode · credentials ${o.credentials}${o.credentialsAuto ? ' (auto)' : ''} · redirect ${o.redirect} · timeout ${formatDuration(o.timeoutMs)}`,
  ];
  if (result.applied?.length) parts.push(`Applied: ${result.applied.map((a) => line(a, 120)).join('; ')}`);
  if (result.blocking > 0) parts.push(`**${result.blocking} error(s) block Send**${result.rawError ? ` — raw body: ${line(result.rawError, 300)}` : ''}`);
  if (result.warnings.length) parts.push('Warnings:', ...result.warnings.slice(0, 20).map((w) => `- ${line(w, 300)}`));
  if (req.query.length) parts.push('### Query', table(['name', 'value'], req.query, 2000));
  parts.push('### Headers', headerLines(req.headers), bodyBlock('Body', req.body));
  if (ctx.redacted) parts.push('Secret values are redacted ("<redacted>").');
  return parts.join('\n');
}

/** A request as a cURL command or a fetch() snippet (redacted). */
export function snippetText(request: ReplayRequest, kind: 'curl' | 'fetch', ctx: FormatContext): string {
  const headers: HeaderPair[] = headersOut(request.headers, ctx).map(([name, value]) => ({ name, value }));
  let body = request.body;
  if (body.kind === 'text' && ctx.redact) body = { kind: 'text', text: redactText(body.text, ctx) };
  const snippet = { method: request.method, url: urlOut(request.url, ctx), headers, body };
  return kind === 'curl' ? toCurl(snippet) : toFetchSnippet(snippet);
}

/** A request as sent by a run (inspect run). */
export function sentRequestText(request: ReplayRequest, ctx: FormatContext, maxChars: number): string {
  const body = bodyOut(wireToSerialized(request.body), request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? null, ctx, maxChars);
  return [
    '## Request sent',
    `${request.method} ${urlOut(request.url, ctx)} · ${request.mode} mode · credentials ${request.credentials} · redirect ${request.redirect}`,
    '### Headers',
    headerLines(headersOut(request.headers, ctx)),
    bodyBlock('Body', body),
  ].join('\n');
}

/** A unified-style line diff of two (already redacted) texts. */
export function diffText(left: string, right: string, maxLines: number): { text: string; added: number; removed: number; truncated: boolean } {
  const diff = lineDiff(left, right);
  const out: string[] = [];
  let shown = 0;
  for (const item of withContext(diff.lines, 3)) {
    if (shown >= maxLines) {
      out.push('… (more differences not shown)');
      break;
    }
    if (item.op === 'skip') out.push(`@@ ${item.count} unchanged line${item.count === 1 ? '' : 's'} @@`);
    else out.push(`${item.op === 'add' ? '+' : item.op === 'del' ? '-' : ' '} ${item.text}`);
    shown++;
  }
  return { text: out.join('\n'), added: diff.added, removed: diff.removed, truncated: diff.truncated };
}

// ------------------------------------------------------------------------------------------- WebSocket

/** A WebSocket payload for Claude: JSON redacted like bodies, text redacted as free text. */
export function payloadOut(frame: PanelWsFrame, ctx: FormatContext, max: number): BodyForClaude | null {
  if (frame.binary) return { contentType: null, kind: 'binary', text: frame.text ? `hex ${frame.text}` : '(empty)', truncated: frame.truncated };
  const text = frame.text;
  let json = false;
  if (frame.json !== undefined) json = true;
  else {
    const t = text.trim();
    if (t && (t[0] === '{' || t[0] === '[')) {
      try {
        JSON.parse(t);
        json = true;
      } catch {
        json = false;
      }
    }
  }
  const body = bodyOut({ kind: 'text', text, size: frame.size }, json ? 'application/json' : 'text/plain', ctx, max);
  if (body && (frame.textClipped || frame.truncated)) body.truncated = true;
  return body;
}

export function wsConnectionsText(connections: PanelWsConnection[], ctx: FormatContext): string {
  if (!connections.length) return 'No WebSocket connections captured on this page (sockets are captured while kineReqLens records; reload the page to catch sockets opened at load).';
  const parts = [UNTRUSTED_NOTE, ''];
  for (const c of connections) {
    parts.push(
      `### ${code(c.wsId)} ${urlOut(c.url, ctx)}`,
      `${c.state}${c.detected ? ` · ${c.detected}` : ''}${c.protocol ? ` · subprotocol ${line(c.protocol, 60)}` : ''} · ↑ ${c.sent} sent ↓ ${c.received} received · ${c.kept} kept (${c.heartbeats} heartbeats) · opened ${isoTime(c.createdAt)}${c.closedAt ? ` · closed ${isoTime(c.closedAt)}${c.closeCode !== undefined ? ` (${c.closeCode}${c.closeReason ? ` ${line(c.closeReason, 80)}` : ''})` : ''}` : ''}`,
    );
    if (c.channels.length) {
      parts.push(table(['channel', 'kind', '↑ sent', '↓ received', 'last'], c.channels.map((ch) => [ch.heartbeat ? `${ch.key} (heartbeats)` : ch.key, ch.kind, ch.sent, ch.received, isoTime(ch.lastTime)]), 120));
    }
  }
  parts.push('', 'Messages: inspect ws_messages {wsId, channel?, filter?}.');
  return parts.join('\n');
}

export function wsMessagesText(result: PanelWsMessagesResult, ctx: FormatContext, maxChars: number): string {
  const parts = [`WebSocket ${code(result.wsId)} ${urlOut(result.url, ctx)}`, '', UNTRUSTED_NOTE, ''];
  if (result.frame) {
    const f = result.frame;
    parts.push(
      `## Message ${f.id} · ${f.dir === 'out' ? '↑ sent' : '↓ received'} · ${isoTime(f.time)} · ${f.opcode} · ${formatBytes(f.size)} · channel ${code(f.channel)}${f.event ? ` · event ${code(f.event)}` : ''}`,
      bodyBlock('Payload', payloadOut(f, ctx, maxChars), '###'),
    );
    return parts.join('\n');
  }
  if (result.filterError) parts.push(`Filter error: ${line(result.filterError, 200)}`);
  parts.push(`${result.total} message(s) match; showing the newest ${result.frames.length}, newest first${result.more ? ` (more: before ${result.frames[result.frames.length - 1]?.id})` : ''}.`);
  if (result.frames.length) {
    parts.push(
      table(
        ['id', 'dir', 'time', 'channel', 'event', 'size', 'payload'],
        result.frames.map((f) => {
          const body = payloadOut(f, ctx, 300);
          return [f.id, f.dir === 'out' ? '↑' : '↓', isoTime(f.time), f.heartbeat ? `${f.channel} ♥` : f.channel, f.event ?? '', formatBytes(f.size), body ? line(body.text, 300) : ''];
        }),
        300,
      ),
      '',
      'One message in full: inspect ws_messages {wsId, frameId}.',
    );
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------------------------------- errors

function groupRow(g: PanelErrorGroup): Array<string | number> {
  return [g.endpoint, g.kind, g.statuses.join(', ') || '—', g.count, isoTime(g.lastSeen), g.shots, g.running ? 'running' : g.hasAnalysis ? 'analyzed' : ''];
}

function analysisText(analysis: unknown, ctx: FormatContext): string | null {
  if (!analysis || typeof analysis !== 'object') return null;
  const a = analysis as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? redactText(v, ctx) : '');
  const files = Array.isArray(a.files) ? a.files.map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? `${String((f as Record<string, unknown>).path ?? '')}${(f as Record<string, unknown>).line ? `:${String((f as Record<string, unknown>).line)}` : ''}` : '')).filter(Boolean) : [];
  return [
    `**${line(str(a.title) || 'Analysis', 200)}**${a.kind ? ` · ${line(String(a.kind), 40)}` : ''}`,
    str(a.summary) && `Summary: ${str(a.summary)}`,
    str(a.rootCause) && `Root cause: ${str(a.rootCause)}`,
    files.length ? `Files: ${files.map((f) => code(f.slice(0, 300))).join(', ')}` : '',
    str(a.fixPlan) && `Fix plan: ${str(a.fixPlan)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** One Errors-view Claude run (analysis card, or the last lines of its log). */
export function runText(run: PanelErrorRun, ctx: FormatContext): string {
  const parts = [
    `- ${code(run.id)} ${run.kind}${run.auto ? ' (automatic)' : ''} · ${run.state} · started ${isoTime(run.startedAt)}${run.endedAt ? ` · ${formatDuration(run.endedAt - run.startedAt)}` : ''}${run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : ''}`,
  ];
  if (run.error) parts.push(`  Error: ${line(run.error, 300)}`);
  if (run.worktree) parts.push(`  Worktree ${code(run.worktree.path)} on ${code(run.worktree.branch)}${run.diffStat ? `\n${fence(run.diffStat.trim() || 'No changes')}` : ''}`);
  if (run.committed) parts.push(`  Committed ${run.committed.slice(0, 12)}`);
  if (run.prUrl) parts.push(`  Pull request: ${run.prUrl}`);
  if (run.discarded) parts.push('  Worktree discarded');
  const analysis = analysisText(run.analysis, ctx);
  if (analysis) parts.push(analysis.split('\n').map((l) => `  ${l}`).join('\n'));
  else if (run.log.length) parts.push(`  Log (last lines):\n${fence(redactText(run.log.join('\n'), ctx).slice(-4000))}`);
  return parts.join('\n');
}

export function errorsText(result: PanelErrorsResult, ctx: FormatContext): string {
  const parts: string[] = [];
  parts.push(`Errors view: ${result.groups.length} failing endpoint(s) · ${result.fullMode ? 'full mode' : 'safe mode'} · project folder ${result.folder ? code(result.folder) : 'not set (the user chooses it in the Errors view)'}`);
  if (result.groups.length) {
    parts.push('', UNTRUSTED_NOTE, '', table(['endpoint (key)', 'kind', 'statuses', 'calls', 'last seen', 'shots', 'Claude'], result.groups.map(groupRow).map((r, i) => [`${r[0]} — key ${result.groups[i]!.key}`, ...r.slice(1)]), 400));
  }
  const d = result.detail;
  if (d) {
    parts.push('', `## ${line(d.group.endpoint, 300)}`, `key ${code(d.group.key)} · calls ${d.group.entryIds.map((id) => code(id)).join(', ')}`);
    const analysis = analysisText(d.analysis, ctx);
    if (analysis) parts.push('### Latest analysis', analysis, d.storedAt ? `_(kept from ${isoTime(d.storedAt)})_` : '');
    if (d.runs.length) parts.push('### Claude runs', ...d.runs.map((r) => runText(r, ctx)));
    if (d.shots.length) parts.push('### Error-area screenshots', ...d.shots.map((s) => `- ${code(s.id)} ${s.width} × ${s.height} px${s.component ? ` · component ${code(s.component)}` : ''}${s.auto ? ' · automatic' : ''} · ${isoTime(s.createdAt)}${s.data ? ' (image below)' : ''}`));
    if (d.autoShot && typeof d.autoShot === 'object') parts.push(`Automatic capture: ${line(JSON.stringify(d.autoShot), 200)}`);
    if (d.issue) parts.push('### Issue draft (Copy issue)', `**${line(redactText(d.issue.title, ctx), 200)}**`, fence(redactText(d.issue.body, ctx), 'markdown'));
  }
  return parts.filter((p) => p !== undefined).join('\n');
}

// ------------------------------------------------------------------------------------------- initiator

export function initiatorText(analysis: InitiatorAnalysis | null, editorRoot: string, error?: string, ctx?: FormatContext): string {
  if (!analysis) return 'No call stack was recorded for this request (webRequest-only entries — documents, scripts, worker fetches — and requests made before kineReqLens was recording have none).';
  const parts: string[] = [];
  const c = analysis.component;
  if (c) {
    const frame = analysis.frames[c.frameIndex];
    parts.push(`Component: ${code(c.name)}${c.hook ? ` via hook ${code(c.hook)}` : ''}${frame ? ` at ${code(locationText(frame))}` : ''}`);
  } else parts.push('Component: none recognized in the app frames.');
  if (analysis.componentNames.length > 1) parts.push(`Components on the way (innermost first): ${analysis.componentNames.map((n) => code(n)).join(', ')}`);
  const init = analysis.frames[analysis.initiatorIndex];
  if (init) {
    const link = init.original ? vscodeUrl(init.original.source, init.original.line, init.original.col, editorRoot) : null;
    parts.push(`Initiator (first app frame): ${code(functionLabel(init))} at ${code(locationText(init))}${link ? ` — ${link}` : ''}`);
    const ex = init.excerpt;
    // Source excerpts can hold keys baked into the bundle: redacted like page data.
    if (ex) parts.push(fence(ex.lines.map((text, i) => `${ex.startLine + i === ex.line ? '>' : ' '} ${String(ex.startLine + i).padStart(5)} | ${ctx ? redactText(text, ctx) : text}`).join('\n')));
  }
  if (analysis.minifiedWithoutMaps) parts.push('The initiator is minified and has no source map: names are bundle names.');
  if (!analysis.sourceMapped) parts.push('No frame could be source-mapped (positions are bundle positions).');
  if (error) parts.push(`Source maps: ${line(error, 200)}`);
  parts.push(
    '### Stack',
    table(
      ['#', 'kind', 'function', 'location'],
      analysis.frames.slice(0, 40).map((f, i) => [i, `${f.kind}${f.library ? ` (${f.library})` : ''}`, functionLabel(f), locationText(f)]),
      200,
    ),
  );
  return parts.join('\n');
}

// ------------------------------------------------------------------------------------------- find / screenshot

export function elementLine(e: ElementInfo, i: number): string {
  return `${i}. <${e.tag}> ${e.visible ? '' : '(not visible) '}${code(e.selector.slice(0, 300))} at ${Math.round(e.rect.x)},${Math.round(e.rect.y)} ${Math.round(e.rect.width)}×${Math.round(e.rect.height)}${e.text ? ` — "${line(e.text, 200)}"` : ''}`;
}

export function findText(result: FindCommandResult, ctx: FormatContext): string {
  const parts = [UNTRUSTED_NOTE, ''];
  if (result.properties) {
    parts.push(`${result.total} response value(s) of this request are shown on the page.`);
    if (result.properties.length) {
      parts.push(
        table(
          ['path', 'value', 'shown as', 'matches', 'visible'],
          result.properties.map((p) => [p.path, redactText(p.value, ctx), p.as !== undefined ? redactText(p.as, ctx) : '', p.matches, p.visible ?? '']),
          300,
        ),
      );
    }
  } else {
    parts.push(`${result.total} match(es)${result.matches.length < result.total ? ` (showing ${result.matches.length})` : ''}:`);
    result.matches.forEach((m, i) => parts.push(elementLine({ ...m, text: redactText(m.text, ctx) }, i)));
  }
  if (result.highlighted !== undefined) parts.push(`Highlighted match ${result.highlighted} on the page (scrolled into view).`);
  for (const note of result.notes ?? []) parts.push(`Note: ${line(note, 300)}`);
  return parts.join('\n');
}

// ------------------------------------------------------------------------------------------- trace

export function traceText(trace: readonly ControlTraceItem[]): string {
  if (!trace.length) return 'No Claude actions recorded yet.';
  return table(['time', 'tool', 'action', 'tab', 'ok'], trace.map((t) => [isoTime(t.at), t.tool, t.action ?? '', t.tabId ?? '', t.ok ? 'yes' : 'failed']));
}

export { cell, code, fence, formatBytes, formatDuration, isoTime, line, table };
