// OWNER: ui-response agent. Small building blocks shared by the response views.
import type { ComponentChildren } from 'preact';
import { useCallback, useState } from 'preact/hooks';
import type { ResponseData } from '../../shared/types';
import { statusClass } from '../../lib/format';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { statusLabel } from './adapters';

/** Characters of text rendered per "Show more" step. */
export const TEXT_PAGE_CHARS = 200_000;
/** JSON viewer rows rendered per "Show more" step. */
export const JSON_PAGE_ROWS = 2_000;
/** Diff rows rendered per "Show more" step. */
export const DIFF_PAGE_ROWS = 2_000;

// ---------------------------------------------------------------------------------------------
// Segmented control (mutually exclusive chips)
// ---------------------------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  id: T;
  label: ComponentChildren;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

export interface SegmentedProps<T extends string> {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange(value: T): void;
  label: string;
}

/** Group of `.rl-chip` toggle buttons where exactly one is pressed. */
export function Segmented<T extends string>({ options, value, onChange, label }: SegmentedProps<T>) {
  return (
    <div class="rl-resp-seg" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          class="rl-chip rl-resp-seg__item"
          aria-pressed={opt.id === value}
          disabled={opt.disabled}
          title={opt.title}
          data-testid={opt.testId}
          data-value={opt.id}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------------------------

export interface StatusPillProps {
  resp: Pick<ResponseData, 'state' | 'status' | 'type' | 'statusText'>;
  testId?: string;
  title?: string;
}

/** `.rl-pill.rl-status` pill coloured by status class (2xx green … 5xx red); spinner while pending/running. */
export function StatusPill({ resp, testId, title }: StatusPillProps) {
  const cls = statusClass(resp.status, resp.state);
  const busy = resp.state === 'running' || resp.state === 'pending';
  return (
    <span
      class={`rl-pill rl-status rl-status--${cls} rl-resp-pill`}
      data-testid={testId}
      data-status={resp.status ?? ''}
      data-state={resp.state}
      title={title}
    >
      {busy && <span class="rl-spinner rl-resp-pill__spinner" aria-hidden="true" />}
      {statusLabel(resp)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons & notices
// ---------------------------------------------------------------------------------------------

export interface CopyButtonProps {
  /** Text to copy (a function defers expensive serialization until the click). */
  text: string | (() => string);
  label?: ComponentChildren;
  /** Toast shown on success. */
  done?: string;
  title?: string;
  testId?: string;
  iconOnly?: boolean;
  disabled?: boolean;
}

/** Ghost button that copies text to the clipboard (toast on success / failure). */
export function CopyButton({ text, label = 'Copy', done = 'Copied', title, testId, iconOnly, disabled }: CopyButtonProps) {
  const onClick = () => void copyText(typeof text === 'function' ? text() : text, done);
  const name = title ?? (typeof label === 'string' ? label : 'Copy');
  if (iconOnly) {
    return (
      <button type="button" class="rl-icon-btn rl-icon-btn--sm" title={name} aria-label={name} data-testid={testId} disabled={disabled} onClick={onClick}>
        <Icon name="copy" size={13} />
      </button>
    );
  }
  return (
    <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" title={name} data-testid={testId} disabled={disabled} onClick={onClick}>
      <Icon name="copy" size={12} />
      <span>{label}</span>
    </button>
  );
}

export interface NoticeProps {
  tone: 'info' | 'warn' | 'error';
  icon?: IconName;
  children: ComponentChildren;
  testId?: string;
  role?: 'alert' | 'status';
}

/** Shared contract class of each tone (info notices are styled by `.rl-resp-notice--info` alone). */
const NOTICE_BASE_CLASS: Record<NoticeProps['tone'], string> = { info: '', warn: 'rl-warning ', error: 'rl-error ' };

/** Inline notice row (info / warning / error) under the summary bar. */
export function Notice({ tone, icon, children, testId, role }: NoticeProps) {
  return (
    <div class={`${NOTICE_BASE_CLASS[tone]}rl-resp-notice rl-resp-notice--${tone}`} data-testid={testId} role={role}>
      <Icon name={icon ?? (tone === 'info' ? 'info' : 'warning')} size={13} class="rl-resp-notice__icon" />
      <div class="rl-resp-notice__body">{children}</div>
    </div>
  );
}

export interface ShowMoreProps {
  /** e.g. "Showing 2,000 rows". */
  status: ComponentChildren;
  onMore(): void;
  onAll?(): void;
  moreLabel?: string;
}

/** Footer of a progressively rendered view. */
export function ShowMore({ status, onMore, onAll, moreLabel = 'Show more' }: ShowMoreProps) {
  return (
    <div class="rl-resp-more">
      <span class="rl-muted">{status}</span>
      <button type="button" class="rl-btn rl-btn--sm" onClick={onMore}>
        {moreLabel}
      </button>
      {onAll && (
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={onAll}>
          Show all
        </button>
      )}
    </div>
  );
}

/**
 * A page limit that resets to `step` whenever `source` changes (new body / tree / diff), so progressive
 * rendering restarts for new content without remounting the component.
 */
export function usePageLimit(source: unknown, step: number): [number, (limit: number) => void] {
  const [state, setState] = useState<{ source: unknown; limit: number }>({ source, limit: step });
  const limit = state.source === source ? state.limit : step;
  const setLimit = useCallback((next: number) => setState({ source, limit: next }), [source]);
  return [limit, setLimit];
}

/**
 * True when the user has selected text inside the overlay, so click-to-copy does not hijack a selection.
 * Chromium exposes a shadow root's own selection via `ShadowRoot.getSelection()`.
 */
export function hasTextSelection(el: Element): boolean {
  const rootNode = el.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
  const sel = typeof rootNode.getSelection === 'function' ? rootNode.getSelection() : document.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}
