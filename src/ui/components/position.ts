// OWNER: ui-shell agent. Pure geometry for anchored popups (menus, popovers). No DOM access.

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PopupPlacement {
  left: number;
  top: number;
  /** Max height so the popup never leaves the viewport (it scrolls internally beyond this). */
  maxHeight: number;
  /** Which side of the anchor the popup ended up on ('right': beside a navigation rail item). */
  side: 'below' | 'above' | 'right';
}

/** Gap between the anchor and the popup, and the minimum distance kept from the viewport edges. */
export const POPUP_GAP = 4;
export const POPUP_MARGIN = 8;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Place a popup of `popup` size next to `anchor` inside a `viewport` (fixed-position coordinates).
 * Prefers below the anchor, flips above when it does not fit below but fits above, otherwise uses the
 * roomier side with a reduced max height. Horizontally aligned to the anchor's start or end edge and
 * clamped into the viewport.
 */
export function placePopup(
  anchor: AnchorRect,
  popup: Size,
  viewport: Size,
  align: 'start' | 'end' = 'start',
): PopupPlacement {
  const spaceBelow = viewport.height - anchor.bottom - POPUP_GAP - POPUP_MARGIN;
  const spaceAbove = anchor.top - POPUP_GAP - POPUP_MARGIN;

  let side: PopupPlacement['side'];
  if (popup.height <= spaceBelow) side = 'below';
  else if (popup.height <= spaceAbove) side = 'above';
  else side = spaceBelow >= spaceAbove ? 'below' : 'above';

  const room = Math.max(0, side === 'below' ? spaceBelow : spaceAbove);
  const height = Math.min(popup.height, room);
  const top =
    side === 'below'
      ? anchor.bottom + POPUP_GAP
      : Math.max(POPUP_MARGIN, anchor.top - POPUP_GAP - height);

  const preferredLeft = align === 'end' ? anchor.right - popup.width : anchor.left;
  const left = clamp(preferredLeft, POPUP_MARGIN, viewport.width - popup.width - POPUP_MARGIN);

  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(room), side };
}

/**
 * Place a popup to the right of `anchor` (a navigation rail item): top-aligned with the anchor and shifted up
 * as far as needed to fit, clamped into the viewport (it then overlaps the anchor rather than leaving the
 * viewport). The max height is the viewport minus the margins.
 */
export function placePopupBeside(anchor: AnchorRect, popup: Size, viewport: Size): PopupPlacement {
  const room = Math.max(0, viewport.height - 2 * POPUP_MARGIN);
  const height = Math.min(popup.height, room);
  const top = clamp(anchor.top, POPUP_MARGIN, viewport.height - POPUP_MARGIN - height);
  const left = clamp(anchor.right + POPUP_GAP, POPUP_MARGIN, viewport.width - popup.width - POPUP_MARGIN);
  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(room), side: 'right' };
}
