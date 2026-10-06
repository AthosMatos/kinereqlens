// OWNER: ui-editor agent. "Send" of an entry's draft as triggered by the user (button, Ctrl/Cmd+Enter in the
// editor or anywhere in the panel): parse pending raw text, refuse while there are blocking errors, start the run.
import type { ReqlensBridge, RequestEntry, Settings } from '../../shared/types';
import { toast } from '../components/toast';
import { blockingErrorsOf } from './derived';
import { ensureRecord, flushRawParse, rawApplies, resolveSendOptions, sendDraft } from './draftStore';
import { errorMessage, pluralize } from './util';

/** Send the current draft of `entry` (toasts instead of throwing). Returns the run id, or null. */
export function sendEntry(bridge: ReqlensBridge, entry: RequestEntry, settings: Settings): string | null {
  // A large raw edit is parsed after an idle delay: parse it now, so its error (if any) blocks this send.
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) return null;
  const mode = resolveSendOptions(rec.options, settings, entry).mode;
  const errs = blockingErrorsOf(rec.draft, mode) + (rawApplies(rec) && rec.raw.error ? 1 : 0);
  if (errs > 0) {
    toast(`Fix ${pluralize(errs, 'error')} before sending`, 'warn');
    return null;
  }
  try {
    return sendDraft(bridge, entry, settings);
  } catch (err) {
    toast(`Could not build the request: ${errorMessage(err)}`, 'error');
    return null;
  }
}
