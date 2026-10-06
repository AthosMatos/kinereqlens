// OWNER: ui-list-menu agent. Actions of the request-row context menu that work on drafts and runs. They reuse
// the draft store (src/ui/detail/draftStore.ts) and the editor's helpers, and toast instead of throwing.
import { toCurl, toFetchSnippet } from '../../lib/curl';
import { createDraft } from '../../lib/draft';
import { urlParts } from '../../lib/format';
import { uid } from '../../lib/ids';
import type { ReplayRequest, ReqlensBridge, RequestEntry, Settings, TestRun } from '../../shared/types';
import { copyText } from '../components/clipboard';
import { toast } from '../components/toast';
import {
  buildRequestFor,
  ensureRecord,
  flushRawParse,
  rawApplies,
  resendRun,
  resolveSendOptions,
  revertAll,
} from '../detail/draftStore';
import { manualInitOf } from '../detail/duplicate';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "GET list-all" for toasts. */
export function entryTitle(entry: Pick<RequestEntry, 'method' | 'url'>): string {
  const name = urlParts(entry.url).name || entry.url;
  return `${entry.method || 'GET'} ${name.length > 60 ? `${name.slice(0, 59)}…` : name}`;
}

/** The request the editor would send now (edits included), or null (with a toast) when it cannot be built. */
function requestAsSentNow(entry: RequestEntry, settings: Settings, runId: string): ReplayRequest | null {
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) {
    toast(`Could not build the request${rec.draftError ? `: ${rec.draftError}` : ''}`, 'error');
    return null;
  }
  // Raw text that does not parse leaves the previous body in the model: never hand out that stale body.
  if (rawApplies(rec) && rec.raw.error) {
    toast(`Fix the raw body first (${rec.raw.error})`, 'warn');
    return null;
  }
  try {
    return buildRequestFor(rec.draft, entry, resolveSendOptions(rec.options, settings, entry), settings, runId).request;
  } catch (err) {
    toast(`Could not build the request: ${errorText(err)}`, 'error');
    return null;
  }
}

/** Copy the request as it would be sent now as a cURL command or a fetch() snippet. */
export function copyEntrySnippet(entry: RequestEntry, settings: Settings, kind: 'curl' | 'fetch'): void {
  const request = requestAsSentNow(entry, settings, 'copy');
  if (!request) return;
  const snippet = { method: request.method, url: request.url, headers: request.headers, body: request.body };
  void copyText(kind === 'curl' ? toCurl(snippet) : toFetchSnippet(snippet), kind === 'curl' ? 'cURL copied' : 'fetch copied');
}

/**
 * "Duplicate as new request": fork the request as it would be sent now (edits included) into a manual entry.
 * Returns the new entry id, or null.
 */
export function duplicateEntry(bridge: ReqlensBridge, entry: RequestEntry, settings: Settings): string | null {
  const request = requestAsSentNow(entry, settings, 'duplicate');
  if (!request) return null;
  try {
    const copy = bridge.addManualEntry(manualInitOf(request));
    toast('Duplicated as a new request', 'info');
    return copy.id;
  } catch (err) {
    toast(`Could not duplicate: ${errorText(err)}`, 'error');
    return null;
  }
}

/**
 * "Resend unchanged": send the captured request as-is (a fresh draft of the capture, not the edited one)
 * through the normal run flow, with the entry's send options (mode, credentials, timeout). Returns the run id.
 */
export function resendUnchanged(bridge: ReqlensBridge, entry: RequestEntry, settings: Settings): string | null {
  try {
    const rec = ensureRecord(entry);
    const { request, warnings } = buildRequestFor(
      createDraft(entry),
      entry,
      resolveSendOptions(rec.options, settings, entry),
      settings,
      uid('run'),
    );
    // resendRun re-sends a run's request (with a fresh run id): hand it the captured one.
    const captured: TestRun = { runId: request.runId, entryId: entry.id, request, startedAt: Date.now(), state: 'done' };
    const runId = resendRun(bridge, entry.id, captured);
    if (runId && warnings[0]) toast(warnings[0], 'warn');
    return runId;
  } catch (err) {
    toast(`Could not resend: ${errorText(err)}`, 'error');
    return null;
  }
}

/** "Revert edits": discard every edit of the entry's draft. */
export function revertEntryEdits(entry: RequestEntry): void {
  revertAll(entry.id);
  toast('Edits reverted', 'info');
}
