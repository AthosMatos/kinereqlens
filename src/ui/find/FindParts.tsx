// Find in page, panel side: the pieces the JSON viewer renders — the crosshair icon, a value's locate button and the
// toolbar status ("Find in page: 12 values found · Rescan · on/off").
import { Icon } from '../components/Icon';
import { ShotIcon } from '../screenshot/icons';
import type { NodeFind } from './controller';
import { findIconState, findStatusText, findStatusTitle, findTooltip } from './text';
import type { FindView } from './useFindInPage';

/** Crosshair / target glyph (stroke icon, currentColor). */
export function TargetIcon({ size = 14, class: cls }: { size?: number; class?: string }) {
  return (
    <svg
      class={cls ? `rl-icon ${cls}` : 'rl-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5" />
    </svg>
  );
}

/**
 * Locate button of a leaf value (`data-action="find-locate"`: the viewer's click delegation handles it). Kinebot blue;
 * outline when the value is only in attributes (a link / image URL); muted when nothing is visible or the value is too
 * common to show.
 */
export function FindIcon({ find }: { find: NodeFind }) {
  const r = find.result;
  const state = findIconState(r);
  const title = findTooltip(r);
  return (
    <button
      type="button"
      class={`rl-find-icon rl-find-icon--${state}`}
      data-action="find-locate"
      data-testid="rl-find-icon"
      data-state={state}
      data-total={r.total}
      data-visible={r.visible}
      tabIndex={-1}
      title={title}
      aria-label={state === 'common' ? title : `Show on the page — ${title}`}
      aria-disabled={state === 'common' ? 'true' : undefined}
    >
      <TargetIcon size={12} />
    </button>
  );
}

/**
 * Screenshot of the element showing a value (`data-action="find-capture"`, handled by the viewer's click delegation):
 * the element with the default padding, opened in the Screenshot view. A row action (shown on hover / focus).
 */
export function FindCaptureButton() {
  return (
    <button
      type="button"
      class="rl-jv__action rl-find-capture"
      data-action="find-capture"
      data-testid="rl-find-capture"
      tabIndex={-1}
      title="Screenshot of this value on the page, with padding (S) — opens it in the Screenshot view"
      aria-label="Screenshot of this value on the page"
    >
      <ShotIcon name="camera" size={12} />
    </button>
  );
}

/** Toolbar status: what was found, rescan, on / off (persisted in settings.findInPage). */
export function FindStatus({ view }: { view: FindView }) {
  if (!view.available) return null;
  const { snapshot: s, enabled } = view;
  const state = enabled ? s.phase : 'off';
  return (
    <span class={`rl-find-status rl-find-status--${state}`} data-testid="rl-find-status" data-state={state} data-found={s.found}>
      <span class="rl-find-status__label" title={findStatusTitle(s, enabled)}>
        <TargetIcon size={12} class="rl-find-status__icon" />
        <span class="rl-find-status__text">{findStatusText(s, enabled)}</span>
        {enabled && s.dropped > 0 ? <span class="rl-find-status__dropped">· {s.dropped.toLocaleString('en-US')} not searched</span> : null}
      </span>
      {enabled ? (
        <button
          type="button"
          class="rl-find-status__btn"
          data-testid="rl-find-rescan"
          title="Scan the page again"
          aria-label="Scan the page again"
          onClick={view.rescan}
        >
          <Icon name="reload" size={11} />
        </button>
      ) : null}
      <button
        type="button"
        role="switch"
        class="rl-find-toggle"
        data-testid="rl-find-toggle"
        aria-checked={enabled ? 'true' : 'false'}
        aria-label="Find in page"
        title={enabled ? 'Find in page is on — click to turn it off' : 'Find in page is off — click to turn it on'}
        onClick={() => view.setEnabled(!enabled)}
      >
        <span class="rl-find-toggle__knob" />
      </button>
    </span>
  );
}
