// OWNER: ui-editor agent. Text inputs used across the editor: an auto-growing textarea and a value input
// that starts single-line and upgrades to a textarea (Shift+Enter or long/multiline values) without
// losing focus or caret position.
import type { JSX } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { bytesToBase64 } from '../../lib/encoding';
import { cx, isPlainEnter } from './util';

/** `field-sizing: content` (Chromium 123+) lets CSS size textareas; older engines are measured in JS. */
const FIELD_SIZING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

const NEWLINES = /[\r\n]+/g;
const HAS_NEWLINE = /[\r\n]/;

export interface AutoTextareaProps {
  value: string;
  onValue(value: string): void;
  class?: string;
  testId?: string;
  ariaLabel?: string;
  placeholder?: string;
  title?: string;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Max height in px before the textarea scrolls (default 320). */
  maxHeight?: number;
  /** Minimum visible rows (default 1). */
  minRows?: number;
  spellcheck?: boolean;
  /** When false, Enter calls onEnter and pasted newlines are stripped (header values). Default true. */
  allowNewlines?: boolean;
  onEnter?(): void;
  onKeyDown?(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void;
  onBlur?(): void;
  elRef?(el: HTMLTextAreaElement | null): void;
}

/** Textarea that grows with its content up to `maxHeight`. */
export function AutoTextarea(props: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const { value, maxHeight = 320, minRows = 1, allowNewlines = true, elRef } = props;

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      elRef?.(el);
    },
    [elRef],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || FIELD_SIZING) return;
    el.style.height = 'auto';
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, maxHeight)}px`;
  }, [value, maxHeight]);

  const onInput = (e: JSX.TargetedEvent<HTMLTextAreaElement, Event>) => {
    const el = e.currentTarget;
    let next = el.value;
    if (!allowNewlines && HAS_NEWLINE.test(next)) {
      const caret = el.selectionStart ?? next.length;
      const before = next.slice(0, caret).replace(NEWLINES, ' ');
      next = next.replace(NEWLINES, ' ');
      el.value = next;
      el.setSelectionRange(before.length, before.length);
    }
    props.onValue(next);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    props.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!allowNewlines && isPlainEnter(e)) {
      e.preventDefault();
      props.onEnter?.();
    }
  };

  return (
    <textarea
      ref={setRef}
      class={cx('rl-textarea rl-ed-autogrow', props.invalid && 'rl-ed-invalid', props.class)}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      aria-invalid={props.invalid || undefined}
      placeholder={props.placeholder}
      title={props.title}
      readOnly={props.readOnly}
      disabled={props.disabled}
      spellcheck={props.spellcheck ?? false}
      autocomplete="off"
      rows={minRows}
      style={{
        maxHeight: `${maxHeight}px`,
        // `rows` is ignored under field-sizing: content; 1.5 = line-height, 14px = padding + borders.
        minHeight: minRows > 1 ? `calc(${minRows * 1.5}em + 14px)` : undefined,
      }}
      value={value}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onBlur={props.onBlur}
    />
  );
}

export interface ValueInputProps {
  value: string;
  onValue(value: string): void;
  ariaLabel: string;
  testId?: string;
  placeholder?: string;
  class?: string;
  title?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** Values may contain newlines (Shift+Enter upgrades to a textarea). Default true. */
  allowNewlines?: boolean;
  /** Length from which a value is shown in a textarea when the editor mounts (default 80). */
  longThreshold?: number;
  /** Plain Enter in single-line mode (or always when newlines are not allowed). */
  onEnter?(): void;
  elRef?(el: HTMLInputElement | HTMLTextAreaElement | null): void;
  /** `<datalist>` id for suggestions (single-line mode only). */
  list?: string;
  maxHeight?: number;
}

/**
 * Monospace value editor. The single-line/multiline decision is made once when mounted (and when the
 * value gains a newline from outside), never while typing, so the element is not swapped under the caret.
 */
export function ValueInput(props: ValueInputProps) {
  const { value, allowNewlines = true, longThreshold = 80 } = props;
  const [multiState, setMulti] = useState(() => value.length > longThreshold || HAS_NEWLINE.test(value));
  const multi = multiState || HAS_NEWLINE.test(value);
  const pendingCaret = useRef<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const { elRef } = props;

  // Latch: once shown as a textarea (e.g. a newline arrived from a revert or raw edit) it stays one, so
  // deleting the last newline while typing never swaps the element under the caret.
  useLayoutEffect(() => {
    if (multi && !multiState) setMulti(true);
  }, [multi, multiState]);

  const setArea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      areaRef.current = el;
      elRef?.(el);
    },
    [elRef],
  );

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = areaRef.current;
    if (caret === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [multi]);

  if (multi) {
    return (
      <AutoTextarea
        value={value}
        onValue={props.onValue}
        class={cx('rl-textarea--mono rl-ed-value', props.class)}
        testId={props.testId}
        ariaLabel={props.ariaLabel}
        placeholder={props.placeholder}
        title={props.title}
        invalid={props.invalid}
        disabled={props.disabled}
        allowNewlines={allowNewlines}
        onEnter={props.onEnter}
        maxHeight={props.maxHeight}
        elRef={setArea}
      />
    );
  }

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && allowNewlines) {
      // Shift+Enter: switch to a textarea, inserting the newline at the caret, focus follows.
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? start;
      pendingCaret.current = start + 1;
      setMulti(true);
      props.onValue(`${value.slice(0, start)}\n${value.slice(end)}`);
      return;
    }
    if (!e.shiftKey) {
      e.preventDefault();
      props.onEnter?.();
    }
  };

  return (
    <input
      ref={elRef}
      type="text"
      class={cx('rl-input rl-input--mono rl-ed-value', props.invalid && 'rl-input--invalid', props.class)}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      aria-invalid={props.invalid || undefined}
      placeholder={props.placeholder}
      title={props.title ?? (value.length > 40 ? value : undefined)}
      disabled={props.disabled}
      spellcheck={false}
      autocomplete="off"
      list={props.list}
      value={value}
      onInput={(e) => props.onValue(e.currentTarget.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/** Read a picked file as base64 (rejects files above `maxBytes`). */
export async function readFileAsBase64(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(`File is too large (${file.size} bytes, max ${maxBytes})`);
  }
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}
