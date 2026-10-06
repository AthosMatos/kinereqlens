// OWNER: ui-list-menu agent. The rules bar under the list toolbar: one chip per URL rule (click toggles, ×
// deletes) and "Clear rules".
import { useRef } from 'preact/hooks';
import type { ListRule } from '../../shared/types';
import { Icon } from '../components/Icon';
import { ruleDescription, ruleLabel } from './rules';
import { useHorizontalScroller } from './scroller';

export interface RulesBarProps {
  rules: readonly ListRule[];
  /** How many entries each rule matches (same order as `rules`). */
  counts: readonly number[];
  onToggle(rule: ListRule): void;
  onDelete(rule: ListRule): void;
  onClear(): void;
}

function chipTitle(rule: ListRule, count: number): string {
  const matches = `${count} request${count === 1 ? '' : 's'} match${count === 1 ? 'es' : ''}`;
  return `${ruleDescription(rule)}\n${matches} · ${rule.enabled ? 'On — click to turn off' : 'Off — click to turn on'}`;
}

/** Rendered only while rules exist. */
export function RulesBar({ rules, counts, onToggle, onDelete, onClear }: RulesBarProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  useHorizontalScroller(scrollerRef, [rules.length]);
  return (
    <div class="rl-rules" role="group" aria-label="List rules" data-testid="rl-rules-bar">
      <div ref={scrollerRef} class="rl-rules__chips">
        {rules.map((rule, i) => {
          const count = counts[i] ?? 0;
          return (
            <span
              key={rule.id}
              class={`rl-rule-chip rl-rule-chip--${rule.mode}${rule.enabled ? '' : ' rl-rule-chip--off'}`}
              data-testid="rl-rule-chip"
              data-mode={rule.mode}
              data-enabled={rule.enabled ? 'true' : 'false'}
              data-rule-id={rule.id}
              data-pattern={rule.pattern}
              data-template={rule.template}
              data-exact={rule.exact ? 'true' : 'false'}
            >
              <button
                type="button"
                class="rl-rule-chip__toggle"
                aria-pressed={rule.enabled ? 'true' : 'false'}
                title={chipTitle(rule, count)}
                data-testid="rl-rule-toggle"
                onClick={() => onToggle(rule)}
              >
                <Icon name={rule.mode === 'hide' ? 'filter' : 'eye'} size={11} class="rl-rule-chip__icon" />
                <span class="rl-rule-chip__label">{ruleLabel(rule)}</span>
                <span class="rl-rule-chip__count" aria-label={`${count} matching`}>
                  {count}
                </span>
              </button>
              <button
                type="button"
                class="rl-rule-chip__delete"
                title="Delete rule"
                aria-label={`Delete rule: ${ruleDescription(rule)}`}
                data-testid="rl-rule-delete"
                onClick={() => onDelete(rule)}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          );
        })}
      </div>
      <button
        type="button"
        class="rl-btn rl-btn--ghost rl-btn--sm rl-rules__clear"
        title="Delete every list rule"
        data-testid="rl-rules-clear"
        onClick={onClear}
      >
        Clear rules
      </button>
    </div>
  );
}
