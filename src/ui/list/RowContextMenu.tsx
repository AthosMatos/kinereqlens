// OWNER: ui-list-menu agent. The request-row context menu: binds the pure item model (rowMenu.ts) to the
// actions (rules, clipboard, export, Claude Code, draft store) and renders it with ContextMenu.
import type { RefObject } from 'preact';
import { useMemo } from 'preact/hooks';
import type { RequestEntry } from '../../shared/types';
import { ContextMenu } from '../components/ContextMenu';
import type { ContextMenuAnchor } from '../components/ContextMenu';
import { copyText } from '../components/clipboard';
import { getEntryMeta } from '../detail/draftStore';
import { copyAgentPrompt, copyTypes, sendEntryToClaude } from '../export/actions';
import { openClaudeSettings } from '../export/openSettings';
import { useBridge, useSettings } from '../hooks';
import { useBridgeStatus } from '../panel/claudeLink';
import { useListRules } from './listState';
import { copyEntrySnippet, duplicateEntry, entryTitle, resendUnchanged, revertEntryEdits } from './rowActions';
import { buildRowMenu } from './rowMenu';
import { requestResultsTab } from '../detail/resultsTab';
import type { RowMenuActions } from './rowMenu';
import { createListRule, removeEntryFromList, turnOffListRule } from './ruleActions';
import { countMatches, pathPrefixes } from './rules';

export interface RowContextMenuProps {
  entry: RequestEntry;
  /** All entries (for the match counts of the rule items). */
  entries: readonly RequestEntry[];
  anchor: ContextMenuAnchor;
  /** Opened from the keyboard: focus the first item. */
  keyboard: boolean;
  ignore?: ReadonlyArray<RefObject<HTMLElement>>;
  onClose(restoreFocus: boolean): void;
  /** Select (and open) another entry: the duplicate. */
  onSelectEntry(id: string): void;
}

function reportFailure(promise: Promise<unknown>): void {
  promise.catch((err: unknown) => console.warn('[reqlens] context menu action failed', err));
}

export function RowContextMenu({ entry, entries, anchor, keyboard, ignore, onClose, onSelectEntry }: RowContextMenuProps) {
  const bridge = useBridge();
  const settings = useSettings();
  const rules = useListRules();
  const claude = useBridgeStatus();
  const prefixes = useMemo(() => pathPrefixes(entry.url), [entry.url]);
  const counts = useMemo(() => countMatches(entries, prefixes), [entries, prefixes]);
  const modified = getEntryMeta(entry.id).modified;

  const actions: RowMenuActions = {
    addRule: (mode, prefix) => void createListRule(bridge, mode, prefix),
    disableRule: (rule) => turnOffListRule(bridge, rule),
    copyUrl: () => void copyText(entry.url, 'URL copied'),
    copyCurl: () => copyEntrySnippet(entry, settings, 'curl'),
    copyFetch: () => copyEntrySnippet(entry, settings, 'fetch'),
    copyTypes: () => reportFailure(copyTypes(entry, settings.exportFormat)),
    copyPrompt: () => reportFailure(copyAgentPrompt(entry, settings.promptTarget)),
    sendToClaude: (sessionId) => reportFailure(sendEntryToClaude(entry, { target: settings.promptTarget, sessionId })),
    openClaudeSetup: () => openClaudeSettings(),
    resend: () => void resendUnchanged(bridge, entry, settings),
    duplicate: () => {
      const id = duplicateEntry(bridge, entry, settings);
      if (id) onSelectEntry(id);
    },
    showInitiator: () => {
      requestResultsTab(entry.id, 'initiator');
      onSelectEntry(entry.id);
    },
    revert: () => revertEntryEdits(entry),
    remove: () => removeEntryFromList(entry),
  };

  const items = buildRowMenu({
    entry,
    prefixes,
    counts,
    rules,
    modified,
    exportFormat: settings.exportFormat,
    promptTarget: settings.promptTarget,
    claude,
    actions,
  });

  return (
    <ContextMenu
      anchor={anchor}
      items={items}
      label={`Actions for ${entryTitle(entry)}`}
      focusFirst={keyboard}
      ignore={ignore}
      onClose={onClose}
    />
  );
}
