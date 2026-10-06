// Setups button (a navigation rail item, src/ui/rail/Rail.tsx, or a plain header button): shows the active setup (dot when modified since applied), opens the Setups panel, and
// auto-applies the setup matching the page host when the overlay opens or the page host changes.
//
// The popover is its own (not components/Menu's PopoverButton): picking an import file opens the browser's
// file chooser, which blurs the window — a PopoverButton would close (and drop the import) right then.
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReqlensBridge, Setup } from '../../shared/types';
import { useOutsideDismiss } from '../components/dismiss';
import { Icon } from '../components/Icon';
import { placePopup, placePopupBeside } from '../components/position';
import type { PopupPlacement } from '../components/position';
import { useBridge, useCaptureInfo, useSettings, useTabState } from '../hooks';
import { useListConfig } from '../list/listState';
import { applySetup, offerSetup } from './actions';
import { activeSetup, decideAutoApply, isModified, pageHostOf } from './model';
import type { ListConfigState } from './model';
import { SetupsPanel } from './SetupsPanel';
import { siteKeyOf } from '../../shared/language';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Host the auto-apply check last ran for while the overlay was open (null: check again). */
let checkedHost: string | null = null;

/**
 * Auto-apply: once per page host while the overlay is open (and again after it was closed and reopened, or on
 * a reload — a new panel), apply the setup whose sites match the host best, unless it is already active.
 * Unsaved changes of a different active setup are never overwritten: the setup is only offered.
 */
function useAutoApply(bridge: ReqlensBridge, open: boolean, pageUrl: string, setups: Setup[], state: ListConfigState): void {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!open) {
      checkedHost = null;
      return;
    }
    const host = pageHostOf(pageUrl)?.display ?? null;
    if (!host) {
      checkedHost = null;
      return;
    }
    // No setups yet (or settings still arriving): nothing to decide, check again when they change.
    if (host === checkedHost || setups.length === 0) return;
    checkedHost = host;
    const decision = decideAutoApply(setups, latest.current, pageUrl);
    if (decision.kind === 'apply') applySetup(bridge, decision.setup, { host: decision.host });
    else if (decision.kind === 'offer') offerSetup(bridge, decision.setup, decision.host);
  }, [bridge, open, pageUrl, setups]);
}

function viewportSize(): { width: number; height: number } {
  const el = document.documentElement;
  return { width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight };
}

function deepActive(el: HTMLElement): Element | null {
  const root = el.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
}

/** Anchored popover state (like components/Menu's usePopup) with a "file chooser open" guard. */
function useSetupsPopover(beside: boolean) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** The file chooser is open: the window blur it causes must not close the popover. */
  const picking = useRef(false);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPlacement(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useOutsideDismiss(open, [triggerRef, popupRef] as RefObject<HTMLElement>[], () => {
    if (!picking.current) close(false);
  });

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    if (!trigger.isConnected || trigger.getClientRects().length === 0) {
      close(false); // the panel got minimized / hidden
      return;
    }
    const size = { width: popup.offsetWidth, height: popup.scrollHeight };
    const anchor = trigger.getBoundingClientRect();
    const next = beside ? placePopupBeside(anchor, size, viewportSize()) : placePopup(anchor, size, viewportSize(), 'end');
    setPlacement((prev) =>
      prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight && prev.side === next.side ? prev : next,
    );
  }, [beside, close]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onMove = () => reposition();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    // The content grows / shrinks (save form, import summary, inline editors).
    const ro = new ResizeObserver(onMove);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      ro.disconnect();
    };
  }, [open, reposition]);

  // Focus the first control once placed (unless focus is already inside).
  useEffect(() => {
    if (!open || !placement) return;
    const popup = popupRef.current;
    if (!popup || popup.contains(deepActive(popup))) return;
    (popup.querySelector<HTMLElement>(FOCUSABLE) ?? popup).focus({ preventScroll: true });
  }, [open, placement !== null]);

  /** Wraps opening the file chooser: ignores the blur until a file was chosen or the chooser was dismissed. */
  const setPicking = useCallback((on: boolean) => {
    picking.current = on;
    if (!on) return;
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      // `change` / `cancel` fire around the focus event; keep the guard a moment longer.
      setTimeout(() => {
        picking.current = false;
      }, 1000);
    };
    window.addEventListener('focus', onFocus);
  }, []);

  const style: JSX.CSSProperties = placement
    ? { left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.maxHeight}px` }
    : { left: '0px', top: '0px', visibility: 'hidden' };

  return { open, setOpen, close, triggerRef, popupRef, contentRef, placement, style, setPicking };
}

export interface SetupsButtonProps {
  /**
   * Navigation rail item (src/ui/rail/): `class` replaces the button classes, `content` its inside, `attrs` adds
   * attributes (tabIndex, data-*, focus handlers); the panel then opens to the right of the item.
   */
  rail?: {
    class: string;
    content(info: { active: Setup | null; modified: boolean; title: string }): ComponentChildren;
    attrs?: JSX.HTMLAttributes<HTMLButtonElement>;
  };
}

/** The "Setups" button (navigation rail or header) + panel. */
export function SetupsButton({ rail }: SetupsButtonProps = {}) {
  const bridge = useBridge();
  const settings = useSettings();
  const config = useListConfig();
  const capture = useCaptureInfo();
  const tab = useTabState();
  const pageHost = siteKeyOf(capture.pageUrl);
  const state = useMemo<ListConfigState>(
    () => ({
      listTypes: config.listTypes,
      listRules: config.listRules,
      defaultMode: settings.defaultMode,
      activeSetupId: config.activeSetupId,
      pageHost,
      siteLanguages: settings.siteLanguages,
    }),
    [config.listTypes, config.listRules, settings.defaultMode, config.activeSetupId, pageHost, settings.siteLanguages],
  );
  const active = activeSetup(config.setups, state);
  const modified = useMemo(() => isModified(config.setups, state), [config.setups, state]);
  useAutoApply(bridge, tab.open, capture.pageUrl, config.setups, state);

  const p = useSetupsPopover(!!rail);
  const popupId = 'rl-setups-popup';

  const onKey = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    // Inline editors / nested menus that handled Escape themselves keep the panel open.
    if (e.key === 'Escape' && p.open && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      p.close(true);
    }
  };

  const onFocusOut = (e: JSX.TargetedFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!(next instanceof Node)) return;
    if (p.popupRef.current?.contains(next) || p.triggerRef.current?.contains(next)) return;
    p.close(false);
  };

  const title = active
    ? `Setup: ${active.name}${modified ? ' — modified since applied' : ''}`
    : 'Setups — save and switch request-list configurations';

  return (
    <span class="rl-popup-anchor">
      <button
        {...rail?.attrs}
        ref={p.triggerRef}
        type="button"
        class={rail ? rail.class : `rl-btn rl-btn--ghost rl-btn--sm rl-setups-btn${active ? ' rl-setups-btn--active' : ''}`}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={p.open ? 'true' : 'false'}
        aria-controls={p.open ? popupId : undefined}
        data-testid="rl-setups-button"
        data-active-setup={active?.id ?? ''}
        data-modified={modified ? 'true' : 'false'}
        onClick={() => (p.open ? p.close(false) : p.setOpen(true))}
        onKeyDown={onKey}
      >
        {rail ? (
          rail.content({ active, modified, title })
        ) : (
          <>
            <Icon name="layers" size={13} />
            <span class="rl-setups-btn__name">{active ? active.name : 'Setups'}</span>
            {modified ? <span class="rl-setups-btn__dot" aria-hidden="true" data-testid="rl-setups-modified" /> : null}
            <Icon name="chevron-down" size={11} class="rl-btn__caret" />
          </>
        )}
      </button>
      {p.open ? (
        <div
          ref={p.popupRef}
          id={popupId}
          class={`rl-popup rl-popover rl-setups-popover${p.placement ? ` rl-popup--${p.placement.side}` : ''}`}
          role="dialog"
          aria-label="Setups"
          tabIndex={-1}
          style={p.style}
          data-testid="rl-setups-panel"
          onKeyDown={onKey}
          onFocusOut={onFocusOut}
        >
          <div ref={p.contentRef}>
            <SetupsPanel
              setups={config.setups}
              state={state}
              active={active}
              modified={modified}
              pageUrl={capture.pageUrl}
              onPicking={p.setPicking}
            />
          </div>
        </div>
      ) : null}
    </span>
  );
}
