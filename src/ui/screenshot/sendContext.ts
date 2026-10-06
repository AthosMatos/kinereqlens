// What "Send to Claude" offers as context (src/ui/screenshot/sendModel.ts ShotSendContext): the page URL and the
// selected request (redacted per "Share secrets with Claude" with the bridge's formatters), and — from the Errors
// view — the related error analysis.
import type { ErrorAnalysis } from '../../lib/errorPrompt';
import { formatContext, urlOut } from '../../background/claude/format';
import type { ReqlensBridge, RequestEntry, Settings } from '../../shared/types';
import { endpointTemplate } from '../list/endpointLabel';
import type { ShotRequestSummary, ShotSendContext } from './sendModel';

/** method + URL template (no query) + status of a request. */
export function requestSummaryOf(entry: RequestEntry, settings: Pick<Settings, 'claudeShareSecrets'>): ShotRequestSummary {
  const t = endpointTemplate(entry.url);
  const url = t.http ? `${t.origin}${t.path || '/'}` : urlOut(entry.url, formatContext(!settings.claudeShareSecrets));
  const out: ShotRequestSummary = { method: (entry.method || 'GET').toUpperCase(), url };
  if (typeof entry.status === 'number' && entry.status > 0) out.status = entry.status;
  else if (entry.error) out.status = entry.error.slice(0, 80);
  else if (entry.state && entry.state !== 'done') out.status = entry.state;
  return out;
}

/** The analysis as a few lines of text. */
export function analysisText(analysis: ErrorAnalysis): string {
  const lines = [`${analysis.title} (${analysis.kind})`];
  if (analysis.summary) lines.push(analysis.summary);
  if (analysis.rootCause) lines.push(`Root cause: ${analysis.rootCause}`);
  if (analysis.files.length) {
    lines.push('Files:', ...analysis.files.slice(0, 10).map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''}${f.why ? ` — ${f.why}` : ''}`));
  }
  if (analysis.fixPlan) lines.push(`Fix plan: ${analysis.fixPlan}`);
  return lines.join('\n').slice(0, 8000);
}

/** The page URL of the overlay's tab, redacted ('' when unknown). */
export function pageUrlOf(bridge: ReqlensBridge | null, settings: Pick<Settings, 'claudeShareSecrets'> | null): string {
  if (!bridge) return '';
  let url = '';
  try {
    url = bridge.getCaptureInfo().pageUrl;
  } catch {
    url = '';
  }
  return url ? urlOut(url, formatContext(!(settings?.claudeShareSecrets ?? false))) : '';
}

/** Context of the screenshot tool: page URL and the request selected in the list (if any). */
export function shotContextFromBridge(bridge: ReqlensBridge | null, selectedId: string | null): ShotSendContext {
  if (!bridge) return {};
  let settings: Settings | null = null;
  try {
    settings = bridge.getSettings();
  } catch {
    settings = null;
  }
  const ctx: ShotSendContext = {};
  const pageUrl = pageUrlOf(bridge, settings);
  if (pageUrl) ctx.pageUrl = pageUrl;
  const entry = selectedId ? bridge.getEntries().find((e) => e.id === selectedId) : undefined;
  if (entry) {
    ctx.entryId = entry.id;
    ctx.request = requestSummaryOf(entry, settings ?? { claudeShareSecrets: false });
  }
  return ctx;
}
