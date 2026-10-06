// What the Errors view tells Claude about a failing endpoint (src/lib/errorPrompt.ts ErrorPromptContext): the newest
// failing call (URL, headers, bodies — redacted per settings.claudeShareSecrets with the bridge's formatters,
// src/background/claude/format.ts), the group's counts and the source-mapped initiator.
import type { RequestEntry, Settings } from '../../shared/types';
import type { ErrorPromptContext, PromptFrame } from '../../lib/errorPrompt';
import type { InitiatorAnalysis } from '../../lib/initiator';
import { functionLabel, locationText } from '../../lib/initiator';
import { bodyOut, formatContext, headersOut, requestHeadersOf, urlOut } from '../../background/claude/format';
import type { ErrorGroup } from './model';
import { classifyEntry } from './model';

/** Response body chars handed to Claude (the prompt clips further). */
const BODY_CHARS = 20_000;

/** Prompt frames of an initiator analysis (app frames first is not needed: innermost first, as recorded). */
export function promptFrames(analysis: InitiatorAnalysis): PromptFrame[] {
  return analysis.frames.map((f) => ({ location: locationText(f), fn: functionLabel(f).replace(/^\(anonymous\)$/, ''), kind: f.kind }));
}

/** Component + call site summary of an initiator analysis. */
export function initiatorSummary(analysis: InitiatorAnalysis | null): ErrorPromptContext['initiator'] {
  if (!analysis) return null;
  const frames = promptFrames(analysis);
  const out: NonNullable<ErrorPromptContext['initiator']> = { frames, sourceMapped: analysis.sourceMapped };
  if (analysis.component) {
    out.component = analysis.component.name;
    if (analysis.component.hook) out.hook = analysis.component.hook;
  }
  if (analysis.initiatorIndex >= 0) out.top = frames[analysis.initiatorIndex];
  return out;
}

/** The prompt context of a group, from its newest failing call (or `entry` when given). */
export function errorContextOf(group: ErrorGroup, entry: RequestEntry, initiator: InitiatorAnalysis | null, settings: Pick<Settings, 'claudeShareSecrets'>): ErrorPromptContext {
  const ctx = formatContext(!settings.claudeShareSecrets);
  const kind = classifyEntry(entry) ?? group.kind;
  const responseHeaders = entry.wire?.responseHeaders ?? entry.responseHeaders ?? [];
  const contentType = responseHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? null;
  const hasResponse = entry.state === 'done' && typeof entry.status === 'number';
  const out: ErrorPromptContext = {
    method: (entry.method || 'GET').toUpperCase(),
    url: urlOut(entry.url, ctx),
    endpoint: group.endpoint,
    pageUrl: entry.pageUrl ? urlOut(entry.pageUrl, ctx) : '',
    kind,
    count: group.count,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    statuses: group.statuses,
    request: { headers: headersOut(requestHeadersOf(entry), ctx), body: bodyOut(entry.requestBody, entry.requestContentType, ctx, BODY_CHARS) },
    response: hasResponse ? { headers: headersOut(responseHeaders, ctx), body: bodyOut(entry.responseBody ?? null, contentType, ctx, BODY_CHARS) } : null,
    initiator: initiatorSummary(initiator),
    redacted: false,
  };
  if (typeof entry.status === 'number' && entry.status > 0) out.status = entry.status;
  if (entry.statusText) out.statusText = entry.statusText;
  if (entry.error) out.errorText = entry.error.slice(0, 1000);
  if (entry.endTime !== undefined) out.durationMs = Math.max(0, entry.endTime - entry.startTime);
  out.redacted = ctx.redacted;
  return out;
}
