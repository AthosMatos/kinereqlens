// The request list as the overlay shows it (Types menu, URL / method / endpoint rules, text filter, "Remove from
// list"), applied to the bridge's list rows — for list_requests with overlayFilters and the control tools' summaries.
// Pure: the same filter / rule code the list uses (src/ui/list/filter.ts, rules.ts).
import type { BridgeListRow } from '../../../shared/messages';
import type { ListTypeId, RequestEntry, Settings } from '../../../shared/types';
import { matchesChips, matchesText, parseFilterText } from '../../../ui/list/filter';
import { compileRules } from '../../../ui/list/rules';

export interface PanelFilters {
  textFilter: string;
  removedIds: readonly string[];
}

/**
 * Ids of the rows the overlay lists: type selection (settings.listTypes), rules (settings.listRules), and — when the
 * panel is known — its text filter and "Remove from list" set.
 */
export function overlayVisibleIds(rows: readonly BridgeListRow[], settings: Pick<Settings, 'listTypes' | 'listRules'>, panel: PanelFilters | null): Set<string> {
  const chips = new Set<ListTypeId>(settings.listTypes ?? []);
  const rules = compileRules(settings.listRules ?? []);
  const text = parseFilterText(panel?.textFilter ?? '');
  const removed = new Set(panel?.removedIds ?? []);
  const out = new Set<string>();
  for (const row of rows) {
    // List rows carry every field the filters read (kind, source, method, url, status).
    const entry = row as unknown as RequestEntry;
    if (removed.has(row.id)) continue;
    if (!matchesChips(entry, chips)) continue;
    if (!matchesText(entry, text)) continue;
    if (rules.hides(entry)) continue;
    out.add(row.id);
  }
  return out;
}
