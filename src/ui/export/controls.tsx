// OWNER: ui-export agent. Small controls of the Export tab and the Claude Code settings.
import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import { useCopyFeedback } from './hooks';

export interface RadioOption<T extends string> {
  id: T;
  label: ComponentChildren;
  title?: string;
}

export interface RadioGroupProps<T extends string> {
  options: ReadonlyArray<RadioOption<T>>;
  value: T;
  onChange(value: T): void;
  label: string;
  testId?: string;
  class?: string;
}

/**
 * Segmented control with radio semantics: one tab stop, ←/→ (and Home/End) move and select, like the
 * Settings theme switch but compact (auto-width items).
 */
export function RadioGroup<T extends string>({ options, value, onChange, label, testId, class: className }: RadioGroupProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    const delta: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else if (delta[e.key] !== undefined) next = (index + delta[e.key]! + options.length) % options.length;
    else return;
    e.preventDefault();
    const target = options[next];
    if (!target) return;
    if (target.id !== value) onChange(target.id);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      class={`rl-segmented rl-export-seg${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      data-value={value}
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          class="rl-segmented__item"
          aria-checked={o.id === value ? 'true' : 'false'}
          tabIndex={i === index ? 0 : -1}
          title={o.title}
          data-value={o.id}
          onClick={() => o.id !== value && onChange(o.id)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface CheckProps {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ComponentChildren;
  testId?: string;
  title?: string;
  disabled?: boolean;
  class?: string;
}

/** Compact checkbox + label. */
export function Check({ checked, onChange, children, testId, title, disabled, class: className }: CheckProps) {
  return (
    <label class={`rl-export-check${disabled ? ' rl-export-check--disabled' : ''}${className ? ` ${className}` : ''}`} title={title}>
      <input
        type="checkbox"
        class="rl-checkbox"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

export interface CopyActionProps {
  /** Text to copy (called on click, so large outputs are not copied around on render). */
  text: () => string;
  label: string;
  /** Toast on success. */
  done: string;
  testId?: string;
  title?: string;
  disabled?: boolean;
  primary?: boolean;
  /** Icon-only button (small). */
  iconOnly?: boolean;
}

/** Copy button with inline feedback: the icon turns into a check ("Copied") for a moment. */
export function CopyAction({ text, label, done, testId, title, disabled, primary, iconOnly }: CopyActionProps) {
  const [copied, markCopied] = useCopyFeedback();
  const onClick = () => {
    if (disabled) return;
    void copyText(text(), done).then(markCopied);
  };
  const icon = <Icon name={copied ? 'check' : 'copy'} size={12} />;
  const name = title ?? label;
  if (iconOnly) {
    return (
      <button
        type="button"
        class={`rl-icon-btn rl-icon-btn--sm rl-export-copy-icon${copied ? ' rl-export-copied' : ''}`}
        title={copied ? 'Copied' : name}
        aria-label={name}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      type="button"
      class={`rl-btn rl-btn--sm${primary ? ' rl-btn--primary' : ''}${copied ? ' rl-export-copied' : ''}`}
      title={name}
      data-testid={testId}
      data-copied={copied ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export interface CommandProps {
  command: string;
  testId?: string;
  /** Accessible name of the copy button. */
  copyTitle?: string;
}

/** A shell command in a monospace box with a copy button. */
export function Command({ command, testId, copyTitle = 'Copy command' }: CommandProps) {
  return (
    <div class="rl-export-cmd">
      <code class="rl-export-cmd__text" data-testid={testId}>
        {command}
      </code>
      <CopyAction iconOnly text={() => command} label={copyTitle} done="Command copied" testId={testId ? `${testId}-copy` : undefined} />
    </div>
  );
}
