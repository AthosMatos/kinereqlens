// Context menu of a request row's method badge (GET, POST, OPT…): hide / show only requests of that method.
import type { RefObject } from 'preact';
import { useMemo } from 'preact/hooks';
import type { RequestEntry } from '../../shared/types';
import { ContextMenu } from '../components/ContextMenu';
import type { ContextMenuAnchor, ContextMenuEntry } from '../components/ContextMenu';
import { copyText } from '../components/clipboard';
import { useBridge } from '../hooks';
import { useListRules } from './listState';
import { createMethodRule, toggleListRule } from './ruleActions';
import { countMatches, findRule } from './rules';

export interface MethodContextMenuProps {
  entry: RequestEntry;
  entries: readonly RequestEntry[];
  anchor: ContextMenuAnchor;
  keyboard: boolean;
  ignore?: ReadonlyArray<RefObject<HTMLElement>>;
  onClose(restoreFocus: boolean): void;
}

export function MethodContextMenu({ entry, entries, anchor, keyboard, ignore, onClose }: MethodContextMenuProps) {
  const bridge = useBridge();
  const rules = useListRules();
  const method = (entry.method || 'GET').toUpperCase();
  const [count] = useMemo(() => countMatches(entries, [{ pattern: '', exact: true, method }]), [entries, method]);
  const methodRules = rules.filter((r) => r.method && r.enabled);
  const hideRule = findRule(rules, { mode: 'hide', pattern: '', exact: true, method });
  const onlyRule = findRule(rules, { mode: 'only', pattern: '', exact: true, method });

  const items: ContextMenuEntry[] = [
    {
      id: 'hide',
      label: `Hide ${method} requests`,
      hint: String(count),
      icon: 'eye',
      checked: hideRule?.enabled === true,
      testId: 'rl-ctx-method-hide',
      onSelect: () => (hideRule?.enabled ? toggleListRule(bridge, hideRule) : void createMethodRule(bridge, 'hide', method)),
    },
    {
      id: 'only',
      label: `Show only ${method} requests`,
      hint: String(count),
      icon: 'filter',
      checked: onlyRule?.enabled === true,
      testId: 'rl-ctx-method-only',
      onSelect: () => (onlyRule?.enabled ? toggleListRule(bridge, onlyRule) : void createMethodRule(bridge, 'only', method)),
    },
    { type: 'separator', id: 'sep' },
    {
      id: 'all',
      label: 'Show all methods',
      icon: 'revert',
      disabled: methodRules.length === 0,
      description: methodRules.length === 0 ? 'No method rule is active' : undefined,
      testId: 'rl-ctx-method-all',
      onSelect: () => methodRules.forEach((r) => toggleListRule(bridge, r)),
    },
    { id: 'copy', label: 'Copy method', icon: 'copy', onSelect: () => void copyText(method, 'Method copied') },
  ];

  return (
    <ContextMenu
      anchor={anchor}
      items={items}
      label={`${method} requests`}
      testId="rl-method-menu"
      focusFirst={keyboard}
      ignore={ignore}
      onClose={onClose}
    />
  );
}
