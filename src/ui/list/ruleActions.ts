// OWNER: ui-list-menu agent. User actions on list rules and removed entries (persist + toast with Undo).
import { MAX_LIST_RULES } from '../../shared/constants';
import { uid } from '../../lib/ids';
import type { ListRule, ReqlensBridge, RequestEntry } from '../../shared/types';
import { toast } from '../components/toast';
import { currentListRules, removeFromList, restoreToList, updateListRules } from './listState';
import { addRule, removeRule, restoreRule, revertAddRule, ruleDescription, ruleLabel, setRuleEnabled, toggleRule } from './rules';
import type { AddRuleResult, PathPrefix } from './rules';
import { entryTitle } from './rowActions';

/** Toast groups: a newer rule / removal toast replaces the previous one instead of stacking. */
const RULE_TOASTS = 'list-rules';
const REMOVE_TOASTS = 'list-removed';

/** Create (or re-enable) a rule from a ladder item; toasts with Undo. */
export function createListRule(bridge: ReqlensBridge, mode: ListRule['mode'], prefix: PathPrefix): AddRuleResult {
  const spec = { mode, pattern: prefix.pattern, exact: prefix.exact };
  const done = addRule(currentListRules(bridge), spec, { id: uid('r'), now: Date.now() });
  updateListRules(bridge, () => done.rules); // writes nothing when the outcome changed nothing
  switch (done.outcome) {
    case 'limit':
      toast(`There are already ${MAX_LIST_RULES} rules — delete some first`, 'warn');
      break;
    case 'invalid':
      toast('This URL is too long for a rule', 'warn');
      break;
    case 'exists':
      toast(`Already active: ${ruleDescription(done.rule!, 'progressive')}`, 'info', { replace: RULE_TOASTS });
      break;
    default:
      toast(ruleDescription(done.rule!, 'progressive'), 'info', {
        replace: RULE_TOASTS,
        action: { label: 'Undo', onClick: () => updateListRules(bridge, (rules) => revertAddRule(rules, done)) },
      });
  }
  return done;
}

/** Create (or re-enable) a method rule ("Hide OPTIONS requests"); toasts with Undo. */
export function createMethodRule(bridge: ReqlensBridge, mode: ListRule['mode'], method: string): AddRuleResult {
  const done = addRule(currentListRules(bridge), { mode, pattern: '', exact: true, method }, { id: uid('r'), now: Date.now() });
  updateListRules(bridge, () => done.rules);
  if (done.outcome === 'limit') toast(`There are already ${MAX_LIST_RULES} rules — delete some first`, 'warn');
  else if (done.rule) {
    toast(ruleDescription(done.rule, 'progressive'), 'info', {
      replace: RULE_TOASTS,
      action: { label: 'Undo', onClick: () => updateListRules(bridge, (rules) => revertAddRule(rules, done)) },
    });
  }
  return done;
}

/** Create (or re-enable) an endpoint-template rule ("Hide this endpoint"); toasts with Undo. */
export function createTemplateRule(bridge: ReqlensBridge, mode: ListRule['mode'], template: string): AddRuleResult {
  const done = addRule(currentListRules(bridge), { mode, pattern: '', exact: true, template }, { id: uid('r'), now: Date.now() });
  updateListRules(bridge, () => done.rules);
  switch (done.outcome) {
    case 'limit':
      toast(`There are already ${MAX_LIST_RULES} rules — delete some first`, 'warn');
      break;
    case 'invalid':
      toast('This endpoint cannot be used for a rule', 'warn');
      break;
    case 'exists':
      toast(`Already active: ${ruleDescription(done.rule!, 'progressive')}`, 'info', { replace: RULE_TOASTS });
      break;
    default:
      toast(ruleDescription(done.rule!, 'progressive'), 'info', {
        replace: RULE_TOASTS,
        action: { label: 'Undo', onClick: () => updateListRules(bridge, (rules) => revertAddRule(rules, done)) },
      });
  }
  return done;
}

/** Turn a rule off (a checked ladder item was chosen); toasts with Undo. */
export function turnOffListRule(bridge: ReqlensBridge, rule: ListRule): void {
  updateListRules(bridge, (rules) => setRuleEnabled(rules, rule.id, false));
  toast(`Turned off the rule “${ruleLabel(rule)}”`, 'info', {
    replace: RULE_TOASTS,
    action: { label: 'Undo', onClick: () => updateListRules(bridge, (rules) => setRuleEnabled(rules, rule.id, true)) },
  });
}

/** Rules bar chip click. */
export function toggleListRule(bridge: ReqlensBridge, rule: ListRule): void {
  updateListRules(bridge, (rules) => toggleRule(rules, rule.id));
}

/** Rules bar ×; toasts with Undo. */
export function deleteListRule(bridge: ReqlensBridge, rule: ListRule): void {
  const index = currentListRules(bridge).findIndex((r) => r.id === rule.id);
  if (index < 0) return;
  const removed = currentListRules(bridge)[index]!;
  updateListRules(bridge, (rules) => removeRule(rules, rule.id));
  toast(`Deleted the rule “${ruleLabel(removed)}”`, 'info', {
    replace: RULE_TOASTS,
    action: { label: 'Undo', onClick: () => updateListRules(bridge, (rules) => restoreRule(rules, removed, index)) },
  });
}

/** "Clear rules"; toasts with Undo (rules added meanwhile are kept). */
export function clearListRules(bridge: ReqlensBridge): void {
  const before = currentListRules(bridge);
  if (!before.length) return;
  updateListRules(bridge, () => []);
  toast(`Cleared ${before.length} rule${before.length === 1 ? '' : 's'}`, 'info', {
    replace: RULE_TOASTS,
    action: {
      label: 'Undo',
      onClick: () =>
        updateListRules(bridge, (rules) => [...before.filter((r) => !rules.some((n) => n.id === r.id)), ...rules]),
    },
  });
}

/** Turn every rule off (empty-state shortcut when rules hide everything). */
export function disableAllListRules(bridge: ReqlensBridge): void {
  updateListRules(bridge, (rules) => (rules.some((r) => r.enabled) ? rules.map((r) => (r.enabled ? { ...r, enabled: false } : r)) : rules));
}

/** "Remove from list"; toasts with Undo. */
export function removeEntryFromList(entry: RequestEntry): void {
  removeFromList([entry.id]);
  toast(`Removed ${entryTitle(entry)} from the list`, 'info', {
    replace: REMOVE_TOASTS,
    action: { label: 'Undo', onClick: () => restoreToList([entry.id]) },
  });
}

/** "Remove N calls from list" (group rows); toasts with Undo. */
export function removeEntriesFromList(entries: readonly RequestEntry[], what: string): void {
  const ids = entries.map((e) => e.id);
  if (!ids.length) return;
  removeFromList(ids);
  toast(`Removed ${ids.length} calls of ${what} from the list`, 'info', {
    replace: REMOVE_TOASTS,
    action: { label: 'Undo', onClick: () => restoreToList(ids) },
  });
}
