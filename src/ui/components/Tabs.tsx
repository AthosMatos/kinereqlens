// OWNER: ui-shell agent. Accessible tab strip (role=tablist, arrow-key navigation). Renders only the strip; callers render the panel.
import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';

export interface TabItem {
  id: string;
  label: ComponentChildren;
  /** Small count/marker rendered after the label. */
  badge?: ComponentChildren;
  /** Shows the modified dot. */
  modified?: boolean;
  disabled?: boolean;
  testId?: string;
}

export interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange(id: string): void;
  /** Extra content right-aligned in the strip (buttons). */
  actions?: ComponentChildren;
  size?: 'sm' | 'md';
  class?: string;
}

/**
 * Tab strip with automatic activation: ←/→ (and Home/End) move focus and select, skipping disabled tabs.
 * Every tab button carries `data-tab={id}` so tests can address it.
 */
export function Tabs({ tabs, active, onChange, actions, size = 'md', class: className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const enabled = tabs.filter((t) => !t.disabled);
  // Keep one tab reachable with Tab even when `active` does not match any enabled tab.
  const focusId = enabled.some((t) => t.id === active) ? active : enabled[0]?.id;

  const move = (fromId: string, delta: number | 'first' | 'last') => {
    if (!enabled.length) return;
    const from = enabled.findIndex((t) => t.id === fromId);
    let index: number;
    if (delta === 'first') index = 0;
    else if (delta === 'last') index = enabled.length - 1;
    else index = (Math.max(from, 0) + delta + enabled.length) % enabled.length;
    const target = enabled[index];
    if (!target) return;
    onChange(target.id);
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${cssEscape(target.id)}"]`);
    btn?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>, id: string) => {
    const map: Record<string, number | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: 'first',
      End: 'last',
    };
    const delta = map[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    move(id, delta);
  };

  return (
    <div class={`rl-tabs rl-tabs--${size}${className ? ` ${className}` : ''}`}>
      <div class="rl-tabs__list" role="tablist" ref={listRef}>
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              class="rl-tab"
              aria-selected={selected ? 'true' : 'false'}
              aria-disabled={t.disabled ? 'true' : undefined}
              disabled={t.disabled}
              tabIndex={t.id === focusId ? 0 : -1}
              data-tab={t.id}
              data-testid={t.testId}
              onClick={() => !t.disabled && t.id !== active && onChange(t.id)}
              onKeyDown={(e) => onKeyDown(e, t.id)}
            >
              <span class="rl-tab__label">{t.label}</span>
              {t.modified ? <span class="rl-modified-dot" aria-label="modified" role="img" /> : null}
              {t.badge !== undefined && t.badge !== null && t.badge !== false ? (
                <span class="rl-tab__badge">{t.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {actions ? <div class="rl-tabs__actions">{actions}</div> : null}
    </div>
  );
}

/** Minimal attribute-selector escaping (CSS.escape is available in Chromium, guard for tests). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
