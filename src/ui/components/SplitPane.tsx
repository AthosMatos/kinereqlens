// OWNER: ui-shell agent. Two-pane layout with a draggable divider (pointer events + pointer capture).
import type { ComponentChildren, JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useElementSize } from '../hooks';

export interface SplitPaneProps {
  /** 'row' = side by side (vertical divider), 'column' = stacked (horizontal divider). */
  direction: 'row' | 'column';
  /** Size of the first pane: a ratio 0..1 when `unit` is 'ratio' (default), or px when 'px'. */
  size: number;
  unit?: 'ratio' | 'px';
  onSizeChange(size: number): void;
  /** Minimum px of each pane (default 120). */
  minA?: number;
  minB?: number;
  class?: string;
  testId?: string;
  /**
   * Which pane `size` (px) belongs to: 'a' (default) or 'b' (e.g. a bottom drawer whose height is kept while
   * the container resizes). Only with `unit: 'px'`.
   */
  fixed?: 'a' | 'b';
  /** Hide pane B and the divider (pane B stays mounted, so its state survives). */
  collapsed?: boolean;
  children: [ComponentChildren, ComponentChildren];
}

/** Layout thickness of the divider in px (its hit area is wider, drawn by CSS). */
const DIVIDER_PX = 1;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * Clamp the first pane's px size so both panes respect their minimum. When the container is too small for
 * both minimums, the space is shared proportionally to them.
 */
export function clampPaneSize(requested: number, total: number, minA: number, minB: number): number {
  if (total <= 0) return 0;
  if (minA + minB > total) return Math.round((total * minA) / (minA + minB));
  const value = Number.isFinite(requested) ? requested : total / 2;
  return Math.round(Math.min(Math.max(value, minA), total - minB));
}

interface DragSession {
  pointerId: number;
  /** Container start edge (client px). */
  origin: number;
  /** Pointer offset from the divider when the drag started. */
  grab: number;
  /** Latest pane size of this drag (px). */
  last: number;
}

/**
 * Resizable two-pane container. `onSizeChange` fires when a drag ends or on a keyboard step (never on every
 * pointermove), so callers may persist the value directly. The divider is a focusable `separator`:
 * arrows move it by 16px (Shift: 64px), Home/End jump to the minimums.
 */
export function SplitPane(props: SplitPaneProps) {
  const { direction, size, unit = 'ratio', onSizeChange, minA = 120, minB = 120, testId, collapsed = false } = props;
  const fixedB = props.fixed === 'b' && unit === 'px';
  const row = direction === 'row';
  const containerRef = useRef<HTMLDivElement>(null);
  const measured = useElementSize(containerRef);
  const total = Math.max(0, (row ? measured.width : measured.height) - DIVIDER_PX);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const session = useRef<DragSession | null>(null);

  const requestedPx = fixedB ? total - size : unit === 'px' ? size : size * total;
  const paneA = total > 0 ? clampPaneSize(dragPx ?? requestedPx, total, minA, minB) : null;
  const basis =
    paneA !== null ? `${paneA}px` : unit === 'px' ? `${Math.max(0, size)}px` : `${clampRatio(size) * 100}%`;
  // A fixed pane B keeps its px size and pane A takes the rest (no lag when the container resizes).
  let styleA: JSX.CSSProperties = { flex: `0 0 ${basis}` };
  let styleB: JSX.CSSProperties | undefined;
  if (fixedB) {
    styleA = { flex: '1 1 0' };
    styleB = { flex: `0 0 ${paneA !== null ? total - paneA : Math.max(0, size)}px` };
  }
  if (collapsed) {
    styleA = { flex: '1 1 auto' };
    styleB = { display: 'none' };
  }

  const emit = (px: number) => {
    if (total <= 0) return;
    const clamped = clampPaneSize(px, total, minA, minB);
    if (fixedB) onSizeChange(total - clamped);
    else onSizeChange(unit === 'px' ? clamped : Math.round((clamped / total) * 10_000) / 10_000);
  };

  const pointerPos = (e: PointerEvent) => (row ? e.clientX : e.clientY);

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || paneA === null || !containerRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const origin = row ? rect.left : rect.top;
    session.current = { pointerId: e.pointerId, origin, grab: pointerPos(e) - (origin + paneA), last: paneA };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragPx(paneA);
  };

  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId) return;
    s.last = clampPaneSize(pointerPos(e) - s.origin - s.grab, total, minA, minB);
    setDragPx(s.last);
  };

  const endDrag = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId) return;
    session.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    emit(s.last);
    setDragPx(null);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (paneA === null) return;
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const back = row ? 'ArrowLeft' : 'ArrowUp';
    const forward = row ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (e.key === back) next = paneA - step;
    else if (e.key === forward) next = paneA + step;
    else if (e.key === 'Home') next = minA;
    else if (e.key === 'End') next = total - minB;
    if (next === null) return;
    e.preventDefault();
    emit(next);
  };

  const classes = [
    'rl-split',
    `rl-split--${direction}`,
    dragPx !== null ? 'rl-split--dragging' : '',
    props.class ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={containerRef} class={classes} data-testid={testId}>
      <div class="rl-split__pane rl-split__pane--a" style={styleA}>
        {props.children[0]}
      </div>
      <div
        class="rl-split__divider"
        hidden={collapsed}
        role="separator"
        tabIndex={0}
        aria-orientation={row ? 'vertical' : 'horizontal'}
        aria-label="Resize panes"
        aria-valuemin={minA}
        aria-valuemax={total > 0 ? Math.max(minA, total - minB) : undefined}
        aria-valuenow={paneA ?? undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      />
      <div class="rl-split__pane rl-split__pane--b" style={styleB}>
        {props.children[1]}
      </div>
    </div>
  );
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0.05), 0.95);
}
