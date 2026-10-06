// OWNER: ui-list-menu agent. Context menu with submenus (request-list rows; reusable).
//
// Every open level (the menu, then one submenu per level) is its own `position: fixed` `.rl-popup` panel. The
// panels are siblings inside one wrapper (`display: contents`), never nested in each other: the popup enter
// animation's transform would make a parent panel the containing block of a nested fixed panel. `.rl-popup` is
// what src/ui/panel/hit.ts reports as a hit region, so panels that stick out of the overlay panel (submenus
// beside a narrow list) stay clickable; once a panel's enter animation ends a class change makes the hit regions
// re-measure it at its final size. Like Menu.tsx, render it where no ancestor has transform / filter / contain /
// a size `container` (those would become the containing block of the fixed panels).
//
// Keyboard (WAI-ARIA menu pattern): ↑/↓ (wrapping), Home/End, → / Enter / Space open a submenu, ← closes it,
// Escape closes the current level (the whole menu at the top), Tab closes, typing jumps to a matching item.
// Pointer: hover moves the focus and opens / closes submenus after a short delay; outside pointerdown, wheel /
// touch scrolling outside, window resize and window blur close the menu.
import type { JSX, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useOutsideDismiss } from './dismiss';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { POPUP_MARGIN, placePopup } from './position';
import type { AnchorRect, Size } from './position';

export interface ContextMenuItem {
  type?: 'item';
  /** Unique within its level. */
  id: string;
  label: string;
  /** Muted text after the label, never cut off (the label is ellipsized first). Part of the accessible name. */
  suffix?: string;
  /** Second, muted line (e.g. why the item is disabled). Also its accessible description. */
  description?: string;
  icon?: IconName;
  /** Right-aligned hint (a count, a shortcut). */
  hint?: string;
  title?: string;
  /** Shown and focusable (aria-disabled) but cannot be chosen. */
  disabled?: boolean;
  danger?: boolean;
  /** Monospace label (URLs). */
  mono?: boolean;
  /** A menuitemcheckbox with this state (check mark when true). */
  checked?: boolean;
  testId?: string;
  /** Extra data-* attributes (keys without the "data-" prefix), e.g. for tests. */
  data?: Readonly<Record<string, string>>;
  /** Items of a submenu (opened by hover, click, → / Enter / Space); `onSelect` is not called. */
  submenu?: readonly ContextMenuEntry[];
  /** Called after the menu closed. */
  onSelect?(): void;
}

export interface ContextMenuSeparator {
  type: 'separator';
  id: string;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export type ContextMenuAnchor =
  /** Pointer position (client px): the menu opens there, flipping left / up at the viewport edges. */
  | { x: number; y: number }
  /** An element's rect (keyboard, a "⋯" button): below it (or above), aligned with its start or end edge. */
  | { rect: AnchorRect; align?: 'start' | 'end' };

export interface ContextMenuProps {
  anchor: ContextMenuAnchor;
  items: readonly ContextMenuEntry[];
  /** Accessible name of the menu. */
  label: string;
  /** data-testid of the top-level panel (submenus get `rl-context-submenu`). */
  testId?: string;
  /** Focus the first item when opening (keyboard-opened menus); otherwise the menu panel itself is focused. */
  focusFirst?: boolean;
  /** Elements whose pointerdown does not count as outside (e.g. the button that toggles the menu). */
  ignore?: ReadonlyArray<RefObject<HTMLElement>>;
  /**
   * The menu wants to close. `restoreFocus` is true when it was closed from the keyboard or by choosing an
   * item (put the focus back where the menu was opened from); false for outside clicks, scrolling, resize, blur.
   */
  onClose(restoreFocus: boolean): void;
}

// --------------------------------------------------------------------------------------------- geometry

export interface MenuPlacement {
  left: number;
  top: number;
  /** The panel scrolls internally beyond this. */
  maxHeight: number;
}

export interface SubmenuPlacement extends MenuPlacement {
  /** Side of the parent item the submenu opened on (deeper levels keep going that way). */
  side: 'right' | 'left';
}

/** Submenus overlap their parent panel by its padding, so the pointer never crosses a gap. */
export const SUBMENU_OVERLAP = 4;
/** Offset that lines the first submenu item up with its parent item (panel padding + border). */
export const SUBMENU_TOP_OFFSET = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Menu opened at a pointer position: right of / below the point, flipped to the left / above it when it does
 * not fit (and the flipped side does), clamped into the viewport.
 */
export function placeAtPoint(point: { x: number; y: number }, size: Size, viewport: Size): MenuPlacement {
  const m = POPUP_MARGIN;
  const maxHeight = Math.max(0, viewport.height - 2 * m);
  const height = Math.min(size.height, maxHeight);
  let left = point.x;
  if (left + size.width > viewport.width - m && point.x - size.width >= m) left = point.x - size.width;
  let top = point.y;
  if (top + height > viewport.height - m && point.y - height >= m) top = point.y - height;
  return {
    left: Math.round(clamp(left, m, viewport.width - m - size.width)),
    top: Math.round(clamp(top, m, viewport.height - m - height)),
    maxHeight: Math.floor(maxHeight),
  };
}

/**
 * Submenu beside its parent item: on `prefer`'s side, flipped to the other side when it does not fit there but
 * does there (otherwise the roomier side, clamped). Vertically lined up with the item, moved up to fit.
 */
export function placeSubmenu(item: AnchorRect, size: Size, viewport: Size, prefer: 'right' | 'left' = 'right'): SubmenuPlacement {
  const m = POPUP_MARGIN;
  const rightX = item.right - SUBMENU_OVERLAP;
  const leftX = item.left - size.width + SUBMENU_OVERLAP;
  const fitsRight = rightX + size.width <= viewport.width - m;
  const fitsLeft = leftX >= m;
  let side = prefer;
  if (side === 'right' && !fitsRight) side = fitsLeft ? 'left' : viewport.width - item.right >= item.left ? 'right' : 'left';
  else if (side === 'left' && !fitsLeft) side = fitsRight ? 'right' : viewport.width - item.right >= item.left ? 'right' : 'left';
  const maxHeight = Math.max(0, viewport.height - 2 * m);
  const height = Math.min(size.height, maxHeight);
  return {
    left: Math.round(clamp(side === 'right' ? rightX : leftX, m, viewport.width - m - size.width)),
    top: Math.round(clamp(item.top - SUBMENU_TOP_OFFSET, m, viewport.height - m - height)),
    maxHeight: Math.floor(maxHeight),
    side,
  };
}

/** Placement of the top-level panel for an anchor. */
export function placeContextMenu(anchor: ContextMenuAnchor, size: Size, viewport: Size): MenuPlacement {
  if ('rect' in anchor) {
    const p = placePopup(anchor.rect, size, viewport, anchor.align ?? 'start');
    return { left: p.left, top: p.top, maxHeight: p.maxHeight };
  }
  return placeAtPoint(anchor, size, viewport);
}

// --------------------------------------------------------------------------------------------- component

/** Delay before hovering an item opens its submenu (or closes a sibling's). */
const HOVER_DELAY_MS = 140;
const TYPEAHEAD_RESET_MS = 600;

let menuSeq = 0;

interface Level {
  /** Stable per open path ("root", "root/copy", ...). */
  key: string;
  items: readonly ContextMenuEntry[];
  /** Id of the item in the previous level that opened this one. */
  parentId: string | null;
}

function isItem(entry: ContextMenuEntry): entry is ContextMenuItem {
  return entry.type !== 'separator';
}

function findItem(entries: readonly ContextMenuEntry[], id: string): ContextMenuItem | undefined {
  for (const entry of entries) if (isItem(entry) && entry.id === id) return entry;
  return undefined;
}

function viewportSize(): Size {
  const el = document.documentElement;
  return { width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight };
}

function dataAttributes(data: ContextMenuItem['data']): Record<string, string> {
  const out: Record<string, string> = {};
  if (data) for (const [key, value] of Object.entries(data)) out[`data-${key}`] = value;
  return out;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A context menu with submenus, rendered at `anchor` while mounted (mount = open). */
export function ContextMenu(props: ContextMenuProps) {
  const { anchor, items, label, testId = 'rl-context-menu', focusFirst = false, ignore } = props;
  const [path, setPathState] = useState<string[]>([]);
  const [placements, setPlacements] = useState<Readonly<Record<string, MenuPlacement>>>({});
  const [settled, setSettled] = useState<Readonly<Record<string, true>>>({});
  const layerRef = useRef<HTMLDivElement>(null);
  const panels = useRef<Array<HTMLDivElement | null>>([]);
  const itemEls = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ level: number; which: 'first' | 'panel' } | null>({
    level: 0,
    which: focusFirst ? 'first' : 'panel',
  });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const idBase = useRef(`rl-ctx-${++menuSeq}`).current;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const pathRef = useRef(path);
  pathRef.current = path;

  const setPath = (next: string[]) => {
    if (!sameStrings(next, pathRef.current)) {
      pathRef.current = next;
      setPathState(next);
    }
  };

  const levels = useMemo(() => {
    const out: Level[] = [{ key: 'root', items, parentId: null }];
    for (const id of path) {
      const last = out[out.length - 1]!;
      const item = findItem(last.items, id);
      if (!item?.submenu || item.disabled) break;
      out.push({ key: `${last.key}/${id}`, items: item.submenu, parentId: id });
    }
    return out;
  }, [items, path]);

  const close = (restoreFocus: boolean) => onCloseRef.current(restoreFocus);
  const itemKey = (level: number, id: string) => `${level}\n${id}`;

  const cancelHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  // Place every level that has no placement yet (measured while rendered hidden at 0,0), drop closed ones.
  useLayoutEffect(() => {
    const vp = viewportSize();
    const next: Record<string, MenuPlacement> = {};
    let changed = Object.keys(placements).some((key) => !levels.some((l) => l.key === key));
    let side: 'right' | 'left' = 'right';
    levels.forEach((level, i) => {
      const known = placements[level.key];
      if (known) {
        next[level.key] = known;
        if ('side' in known) side = (known as SubmenuPlacement).side;
        return;
      }
      const panel = panels.current[i];
      if (!panel) return;
      const size = { width: panel.offsetWidth, height: panel.scrollHeight };
      if (i === 0) {
        next[level.key] = placeContextMenu(anchor, size, vp);
      } else {
        const parent = level.parentId === null ? undefined : itemEls.current.get(itemKey(i - 1, level.parentId));
        if (!parent) return;
        const placed = placeSubmenu(parent.getBoundingClientRect(), size, vp, side);
        side = placed.side;
        next[level.key] = placed;
      }
      changed = true;
    });
    if (changed) setPlacements(next);
  });

  // Move the focus once the level it should go to is placed (visible), before it is painted.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const level = levels[pending.level];
    if (!level || !placements[level.key]) return;
    pendingFocus.current = null;
    if (pending.which === 'panel') panels.current[pending.level]?.focus({ preventScroll: true });
    else focusAt(pending.level, 0);
  });

  // A path whose items disappeared (items replaced while open) is trimmed to what still exists.
  useEffect(() => {
    if (levels.length - 1 < path.length) setPath(path.slice(0, levels.length - 1));
  }, [levels, path]);

  useOutsideDismiss(true, [layerRef, ...(ignore ?? [])], () => close(false));

  // Scrolling outside the menu (wheel / touch), resizing: the anchor moved, close. (Not `scroll` events: the
  // list scrolls itself programmatically to keep rows in place while requests stream in.)
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const root = layer.getRootNode();
    // composedPath, not target: the document-level listener sees events from the shadow root retargeted to its host.
    const onScrollGesture = (event: Event) => {
      if (event.composedPath().includes(layer)) return;
      close(false);
    };
    const onResize = () => close(false);
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const targets: EventTarget[] = root === document ? [document] : [root, document];
    for (const t of targets) {
      t.addEventListener('wheel', onScrollGesture, opts);
      t.addEventListener('touchmove', onScrollGesture, opts);
    }
    window.addEventListener('resize', onResize);
    return () => {
      for (const t of targets) {
        t.removeEventListener('wheel', onScrollGesture, opts);
        t.removeEventListener('touchmove', onScrollGesture, opts);
      }
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => cancelHover, []);

  const focusables = (level: number): HTMLButtonElement[] => {
    const panel = panels.current[level];
    return panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-rl-ctxitem]')) : [];
  };

  const focusAt = (level: number, index: number) => {
    const list = focusables(level);
    if (!list.length) return;
    list[((index % list.length) + list.length) % list.length]?.focus({ preventScroll: false });
  };

  const openSubmenu = (level: number, item: ContextMenuItem, focusIt: boolean) => {
    cancelHover();
    setPath([...pathRef.current.slice(0, level), item.id]);
    if (focusIt) pendingFocus.current = { level: level + 1, which: 'first' };
  };

  /** Close the levels above `level` and focus the item of `level` that opened the next one. */
  const closeAbove = (level: number) => {
    cancelHover();
    const parentId = pathRef.current[level];
    setPath(pathRef.current.slice(0, level));
    if (parentId !== undefined) itemEls.current.get(itemKey(level, parentId))?.focus({ preventScroll: true });
  };

  const choose = (level: number, item: ContextMenuItem, keyboard: boolean) => {
    if (item.disabled) return;
    if (item.submenu) {
      openSubmenu(level, item, keyboard);
      return;
    }
    close(true);
    item.onSelect?.();
  };

  const onItemPointerEnter = (level: number, item: ContextMenuItem, e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'touch') return;
    e.currentTarget.focus({ preventScroll: true });
    cancelHover();
    const wanted = item.submenu && !item.disabled ? [...pathRef.current.slice(0, level), item.id] : pathRef.current.slice(0, level);
    if (sameStrings(wanted, pathRef.current)) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setPath(wanted);
    }, HOVER_DELAY_MS);
  };

  const typeTo = (level: number, key: string, current: number) => {
    const now = Date.now();
    const t = typeahead.current;
    t.text = now - t.at < TYPEAHEAD_RESET_MS ? t.text + key.toLowerCase() : key.toLowerCase();
    t.at = now;
    const list = focusables(level);
    const levelItems = levels[level]?.items ?? [];
    const labelOf = (el: HTMLButtonElement) => findItem(levelItems, el.dataset.ctxId ?? '')?.label.toLowerCase() ?? '';
    // A repeated single letter cycles; a longer prefix first re-checks the current item.
    const start = t.text.length === 1 ? current + 1 : Math.max(0, current);
    for (let i = 0; i < list.length; i++) {
      const index = (start + i) % list.length;
      if (labelOf(list[index]!).startsWith(t.text)) {
        list[index]!.focus({ preventScroll: false });
        return;
      }
    }
  };

  const onPanelKeyDown = (level: number) => (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const list = focusables(level);
    const active = list.findIndex((el) => el === (el.getRootNode() as Document | ShadowRoot).activeElement);
    const activeItem = active >= 0 ? findItem(levels[level]?.items ?? [], list[active]!.dataset.ctxId ?? '') : undefined;
    switch (e.key) {
      case 'ArrowDown':
        focusAt(level, active < 0 ? 0 : active + 1);
        break;
      case 'ArrowUp':
        focusAt(level, active < 0 ? -1 : active - 1);
        break;
      case 'Home':
        focusAt(level, 0);
        break;
      case 'End':
        focusAt(level, -1);
        break;
      case 'ArrowRight':
        if (activeItem?.submenu && !activeItem.disabled) openSubmenu(level, activeItem, true);
        break;
      case 'ArrowLeft':
        if (level > 0) closeAbove(level - 1);
        break;
      case 'Escape':
        if (level > 0) closeAbove(level - 1);
        else close(true);
        break;
      case 'Tab':
        close(true);
        break;
      default:
        if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeTo(level, e.key, active);
          break;
        }
        return; // Enter / Space activate the focused button natively (click)
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const renderItem = (level: number, item: ContextMenuItem, index: number, checkable: boolean, iconGap: boolean) => {
    const open = item.submenu !== undefined && path[level] === item.id && levels.length > level + 1;
    const domId = `${idBase}-${level}-${index}`;
    const classes = ['rl-menu__item', 'rl-ctx__item'];
    if (item.danger) classes.push('rl-menu__item--danger');
    if (item.disabled) classes.push('rl-ctx__item--disabled');
    if (item.description) classes.push('rl-ctx__item--two-line');
    return (
      <button
        key={item.id}
        ref={(el) => {
          const key = itemKey(level, item.id);
          if (el) itemEls.current.set(key, el);
          else itemEls.current.delete(key);
        }}
        id={domId}
        type="button"
        class={classes.join(' ')}
        role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={item.checked}
        aria-haspopup={item.submenu ? 'menu' : undefined}
        aria-expanded={item.submenu ? open : undefined}
        aria-controls={open ? `${idBase}-m${level + 1}` : undefined}
        aria-disabled={item.disabled ? 'true' : undefined}
        aria-describedby={item.description ? `${domId}-d` : undefined}
        tabIndex={-1}
        title={item.title}
        data-rl-ctxitem=""
        data-ctx-id={item.id}
        data-testid={item.testId}
        {...dataAttributes(item.data)}
        onClick={(e) => choose(level, item, e.detail === 0)}
        onPointerEnter={(e) => onItemPointerEnter(level, item, e)}
      >
        {checkable ? (
          <span class="rl-menu__check" aria-hidden="true">
            {item.checked ? <Icon name="check" size={13} /> : null}
          </span>
        ) : null}
        {item.icon ? (
          <Icon name={item.icon} size={14} class="rl-menu__icon" />
        ) : iconGap ? (
          <span class="rl-ctx__icon-gap" aria-hidden="true" />
        ) : null}
        <span class="rl-ctx__text">
          <span class="rl-ctx__line">
            <span class={`rl-menu__label${item.mono ? ' rl-ctx__label--mono' : ''}`}>{item.label}</span>
            {item.suffix ? <span class="rl-ctx__suffix"> {item.suffix}</span> : null}
          </span>
          {item.description ? (
            <span id={`${domId}-d`} class="rl-ctx__desc">
              {item.description}
            </span>
          ) : null}
        </span>
        {item.hint ? <span class="rl-menu__hint rl-ctx__hint">{item.hint}</span> : null}
        {item.submenu ? <Icon name="chevron-right" size={12} class="rl-ctx__chevron" /> : null}
      </button>
    );
  };

  return (
    <div ref={layerRef} class="rl-ctx-layer" onContextMenu={(e) => e.preventDefault()}>
      {levels.map((level, i) => {
        const placement = placements[level.key];
        const style: JSX.CSSProperties = placement
          ? { left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.maxHeight}px` }
          : { left: '0px', top: '0px', visibility: 'hidden' };
        const entries = level.items;
        const checkable = entries.some((e) => isItem(e) && e.checked !== undefined);
        const iconGap = entries.some((e) => isItem(e) && e.icon !== undefined);
        const parentIndex = i > 0 ? (levels[i - 1]?.items ?? []).findIndex((e) => isItem(e) && e.id === level.parentId) : -1;
        const classes = ['rl-popup', 'rl-menu', 'rl-ctx'];
        if (i > 0) classes.push('rl-ctx--sub');
        if (settled[level.key]) classes.push('rl-ctx--settled');
        return (
          <div
            key={level.key}
            ref={(el) => {
              panels.current[i] = el;
            }}
            id={`${idBase}-m${i}`}
            class={classes.join(' ')}
            role="menu"
            aria-label={i === 0 ? label : undefined}
            aria-labelledby={i > 0 && parentIndex >= 0 ? `${idBase}-${i - 1}-${parentIndex}` : undefined}
            aria-orientation="vertical"
            tabIndex={-1}
            style={style}
            data-testid={i === 0 ? testId : 'rl-context-submenu'}
            data-level={String(i)}
            onKeyDown={onPanelKeyDown(i)}
            onPointerEnter={i > 0 ? cancelHover : undefined}
            onAnimationEnd={() => setSettled((s) => (s[level.key] ? s : { ...s, [level.key]: true }))}
          >
            {entries.map((entry, index) =>
              isItem(entry) ? (
                renderItem(i, entry, index, checkable, iconGap)
              ) : (
                <div key={entry.id} class="rl-ctx__sep" role="separator" />
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}
