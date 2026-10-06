// OWNER: ui-shell agent. Button that opens a small dropdown menu / popover positioned inside the shadow root
// (closes on outside pointerdown, Escape, or selection; keyboard navigable).
//
// Popups use `position: fixed` with coordinates computed from the trigger's bounding rect, rendered in place
// (no portal), so they escape `overflow` clipping of their ancestors. Ancestors must therefore not set
// `transform`, `filter`, `contain` or `will-change: transform` (those would become the containing block).
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useOutsideDismiss } from './dismiss';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { placePopup, placePopupBeside } from './position';
import type { PopupPlacement } from './position';

export interface MenuItem {
  label: string;
  onSelect(): void;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  /** Renders as a checkable item (menuitemradio) with a check mark when true. */
  checked?: boolean;
}

export interface MenuButtonProps {
  title: string;
  icon?: IconName;
  label?: ComponentChildren;
  items: MenuItem[];
  align?: 'start' | 'end';
  testId?: string;
  class?: string;
}

export interface PopoverButtonProps {
  title: string;
  icon?: IconName;
  label?: ComponentChildren;
  align?: 'start' | 'end';
  /** Open to the right of the trigger (a navigation rail item) instead of below / above it. */
  beside?: boolean;
  /**
   * Custom trigger: `content` replaces the icon / label / caret and `class` the default button classes;
   * `attrs` are extra button attributes (tabIndex, data-*, aria-keyshortcuts, focus handlers).
   */
  trigger?: { content: ComponentChildren; attrs?: JSX.HTMLAttributes<HTMLButtonElement> };
  testId?: string;
  class?: string;
  /** Popover content; receives a close() callback. */
  children: (close: () => void) => ComponentChildren;
}

let popupSeq = 0;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function viewportSize(): { width: number; height: number } {
  const el = document.documentElement;
  return {
    width: el.clientWidth || window.innerWidth,
    height: el.clientHeight || window.innerHeight,
  };
}

/** Open/close state, outside dismissal and anchored positioning shared by MenuButton and PopoverButton. */
function usePopup(align: 'start' | 'end', beside = false) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`rl-popup-${++popupSeq}`);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPlacement(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useOutsideDismiss(open, [triggerRef, popupRef] as RefObject<HTMLElement>[], () => close(false));

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    if (!trigger.isConnected || trigger.getClientRects().length === 0) {
      close(false); // trigger got hidden (panel minimized / closed)
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const size = { width: popup.offsetWidth, height: popup.scrollHeight };
    setPlacement(beside ? placePopupBeside(rect, size, viewportSize()) : placePopup(rect, size, viewportSize(), align));
  }, [align, beside, close]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const root = triggerRef.current?.getRootNode() ?? document;
    const onMove = () => reposition();
    window.addEventListener('resize', onMove);
    // Scroll events do not cross shadow boundaries; listen on the root that contains the trigger too.
    window.addEventListener('scroll', onMove, true);
    if (root !== document) root.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      if (root !== document) root.removeEventListener('scroll', onMove, true);
    };
  }, [open, reposition]);

  const popupStyle: JSX.CSSProperties = placement
    ? { left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.maxHeight}px` }
    : { left: '0px', top: '0px', visibility: 'hidden' };

  return { open, setOpen, close, triggerRef, popupRef, popupId: idRef.current, popupStyle, placement };
}

interface TriggerProps {
  title: string;
  icon?: IconName;
  label?: ComponentChildren;
  testId?: string;
  class?: string;
  open: boolean;
  popupId: string;
  haspopup: 'menu' | 'dialog';
  triggerRef: RefObject<HTMLButtonElement>;
  onToggle(): void;
  onKeyDown?(e: JSX.TargetedKeyboardEvent<HTMLButtonElement>): void;
  custom?: PopoverButtonProps['trigger'];
}

function Trigger(p: TriggerProps) {
  if (p.custom) {
    return (
      <button
        {...p.custom.attrs}
        ref={p.triggerRef}
        type="button"
        class={p.class}
        title={p.title}
        aria-label={p.title}
        aria-haspopup={p.haspopup}
        aria-expanded={p.open ? 'true' : 'false'}
        aria-controls={p.open ? p.popupId : undefined}
        data-testid={p.testId}
        onClick={p.onToggle}
        onKeyDown={p.onKeyDown}
      >
        {p.custom.content}
      </button>
    );
  }
  const iconOnly = p.label === undefined || p.label === null;
  const base = iconOnly ? 'rl-icon-btn' : 'rl-btn rl-btn--ghost rl-btn--sm';
  return (
    <button
      ref={p.triggerRef}
      type="button"
      class={p.class ? `${base} ${p.class}` : base}
      title={p.title}
      aria-label={iconOnly ? p.title : undefined}
      aria-haspopup={p.haspopup}
      aria-expanded={p.open ? 'true' : 'false'}
      aria-controls={p.open ? p.popupId : undefined}
      data-testid={p.testId}
      onClick={p.onToggle}
      onKeyDown={p.onKeyDown}
    >
      {p.icon ? <Icon name={p.icon} size={iconOnly ? 15 : 13} /> : null}
      {iconOnly ? null : <span class="rl-btn__label">{p.label}</span>}
      {iconOnly ? null : <Icon name="chevron-down" size={11} class="rl-btn__caret" />}
    </button>
  );
}

function menuItems(popup: HTMLElement | null): HTMLButtonElement[] {
  if (!popup) return [];
  return Array.from(popup.querySelectorAll<HTMLButtonElement>('[data-rl-menuitem]:not([disabled])'));
}

function focusItem(popup: HTMLElement | null, which: 'first' | 'last' | number): void {
  const list = menuItems(popup);
  if (!list.length) return;
  const index = which === 'first' ? 0 : which === 'last' ? list.length - 1 : which;
  list[(index + list.length) % list.length]?.focus({ preventScroll: true });
}

/** Dropdown menu of actions. Arrow keys / Home / End move between items, Enter/Space selects, Escape closes. */
export function MenuButton(props: MenuButtonProps) {
  const { title, icon, label, items, align = 'start', testId } = props;
  const p = usePopup(align);
  const pendingFocus = useRef<'first' | 'last'>('first');

  useEffect(() => {
    if (p.open && p.placement) focusItem(p.popupRef.current, pendingFocus.current);
  }, [p.open, p.placement !== null]);

  const openWith = (focus: 'first' | 'last') => {
    pendingFocus.current = focus;
    p.setOpen(true);
  };

  const onTriggerKey = (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openWith(e.key === 'ArrowDown' ? 'first' : 'last');
    } else if (e.key === 'Escape' && p.open) {
      e.preventDefault();
      p.close(true);
    }
  };

  const onMenuKey = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const list = menuItems(p.popupRef.current);
    const current = list.indexOf(e.target as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(p.popupRef.current, current + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(p.popupRef.current, current < 0 ? -1 : current - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(p.popupRef.current, 'first');
        break;
      case 'End':
        e.preventDefault();
        focusItem(p.popupRef.current, 'last');
        break;
      case 'Escape':
        e.preventDefault();
        p.close(true);
        break;
      case 'Tab':
        p.close(false);
        break;
    }
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    p.close(true);
    item.onSelect();
  };

  const hasChecks = items.some((i) => i.checked !== undefined);

  return (
    <span class="rl-popup-anchor">
      <Trigger
        title={title}
        icon={icon}
        label={label}
        testId={testId}
        class={props.class}
        open={p.open}
        popupId={p.popupId}
        haspopup="menu"
        triggerRef={p.triggerRef}
        onToggle={() => (p.open ? p.close(false) : openWith('first'))}
        onKeyDown={onTriggerKey}
      />
      {p.open ? (
        <div
          ref={p.popupRef}
          id={p.popupId}
          class={`rl-popup rl-menu${p.placement ? ` rl-popup--${p.placement.side}` : ''}`}
          role="menu"
          aria-label={title}
          style={p.popupStyle}
          onKeyDown={onMenuKey}
        >
          {items.map((item, index) => {
            const checkable = item.checked !== undefined;
            return (
              <button
                key={`${index}:${item.label}`}
                type="button"
                class={`rl-menu__item${item.danger ? ' rl-menu__item--danger' : ''}`}
                role={checkable ? 'menuitemradio' : 'menuitem'}
                aria-checked={checkable ? (item.checked ? 'true' : 'false') : undefined}
                tabIndex={-1}
                disabled={item.disabled}
                data-rl-menuitem=""
                data-testid={item.testId}
                onClick={() => select(item)}
              >
                {hasChecks ? (
                  <span class="rl-menu__check" aria-hidden="true">
                    {item.checked ? <Icon name="check" size={13} /> : null}
                  </span>
                ) : null}
                {item.icon ? <Icon name={item.icon} size={14} class="rl-menu__icon" /> : null}
                <span class="rl-menu__label">{item.label}</span>
                {item.hint ? <span class="rl-menu__hint">{item.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/** Same trigger/positioning behaviour as MenuButton but with arbitrary content (forms, settings). */
export function PopoverButton(props: PopoverButtonProps) {
  const { title, icon, label, align = 'start', testId, children } = props;
  const p = usePopup(align, props.beside);
  const closeAndRefocus = useCallback(() => p.close(true), [p.close]);

  useEffect(() => {
    if (!p.open || !p.placement) return;
    const popup = p.popupRef.current;
    if (!popup || popup.contains(getDeepActive(popup))) return;
    const first = popup.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? popup).focus({ preventScroll: true });
  }, [p.open, p.placement !== null]);

  const onKey = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    // A nested menu (or input) that already handled Escape keeps the popover open.
    if (e.key === 'Escape' && p.open && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      p.close(true);
    }
  };

  // Keyboard focus moving elsewhere in the overlay (Tab) closes the popover. Focus leaving the document
  // (relatedTarget null) is covered by the outside-pointer / window-blur dismissal instead.
  const onFocusOut = (e: JSX.TargetedFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!(next instanceof Node)) return;
    if (p.popupRef.current?.contains(next) || p.triggerRef.current?.contains(next)) return;
    p.close(false);
  };

  return (
    <span class="rl-popup-anchor">
      <Trigger
        title={title}
        icon={icon}
        label={label}
        testId={testId}
        class={props.class}
        open={p.open}
        popupId={p.popupId}
        haspopup="dialog"
        triggerRef={p.triggerRef}
        onToggle={() => (p.open ? p.close(false) : p.setOpen(true))}
        onKeyDown={onKey}
        custom={props.trigger}
      />
      {p.open ? (
        <div
          ref={p.popupRef}
          id={p.popupId}
          class={`rl-popup rl-popover${p.placement ? ` rl-popup--${p.placement.side}` : ''}`}
          role="dialog"
          aria-label={title}
          tabIndex={-1}
          style={p.popupStyle}
          onKeyDown={onKey}
          onFocusOut={onFocusOut}
        >
          {children(closeAndRefocus)}
        </div>
      ) : null}
    </span>
  );
}

/** The focused element as seen from inside `el`'s root (document or shadow root). */
function getDeepActive(el: HTMLElement): Element | null {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot || root instanceof Document) return root.activeElement;
  return null;
}
