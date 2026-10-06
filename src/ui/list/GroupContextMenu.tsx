// OWNER: ui-shell agent. Context menu of a "Group by endpoint" row: binds the pure item model (rowMenu.ts
// buildGroupMenu) to rule, clipboard and list actions and renders it with ContextMenu.
import type { RefObject } from 'preact';
import { useMemo } from 'preact/hooks';
import type { RequestEntry } from '../../shared/types';
import { ContextMenu } from '../components/ContextMenu';
import type { ContextMenuAnchor } from '../components/ContextMenu';
import { copyText } from '../components/clipboard';
import { useBridge } from '../hooks';
import type { EndpointGroup } from './endpointLabel';
import { templateText } from './endpointLabel';
import { useListRules } from './listState';
import { groupTitle } from './RequestRow';
import { buildGroupMenu } from './rowMenu';
import { createListRule, createTemplateRule, removeEntriesFromList, turnOffListRule } from './ruleActions';
import { countMatches, templatePrefixes } from './rules';

export interface GroupContextMenuProps {
  group: EndpointGroup;
  expanded: boolean;
  /** All entries (for the match counts of the rule items). */
  entries: readonly RequestEntry[];
  anchor: ContextMenuAnchor;
  keyboard: boolean;
  ignore?: ReadonlyArray<RefObject<HTMLElement>>;
  onToggle(): void;
  onClose(restoreFocus: boolean): void;
}

export function GroupContextMenu({ group, expanded, entries, anchor, keyboard, ignore, onToggle, onClose }: GroupContextMenuProps) {
  const bridge = useBridge();
  const rules = useListRules();
  const url = group.newest.url;
  const prefixes = useMemo(() => templatePrefixes(url), [url]);
  const template = group.template.key;
  const counts = useMemo(
    () => countMatches(entries, [...prefixes, { pattern: '', exact: true, template }]),
    [entries, prefixes, template],
  );
  const items = buildGroupMenu({
    group,
    expanded,
    prefixes,
    counts: counts.slice(0, prefixes.length),
    templateCount: counts[prefixes.length] ?? 0,
    rules,
    actions: {
      addRule: (mode, prefix) => void createListRule(bridge, mode, prefix),
      disableRule: (rule) => turnOffListRule(bridge, rule),
      addTemplateRule: (mode) => void createTemplateRule(bridge, mode, template),
      copyTemplate: () => void copyText(templateText(group.template, true), 'Endpoint template copied'),
      copyUrl: () => void copyText(url, 'URL copied'),
      toggle: onToggle,
      remove: () => removeEntriesFromList(group.entries, groupTitle(group)),
    },
  });
  return (
    <ContextMenu
      anchor={anchor}
      items={items}
      label={`Actions for ${groupTitle(group)}`}
      testId="rl-group-menu"
      focusFirst={keyboard}
      ignore={ignore}
      onClose={onClose}
    />
  );
}
