// Find in page, page side (ui.js): the floating mini-bar shown while the overlay is hidden to look at a match —
// "‹ 2/5 › · <path> · ✕ Back to kineReqLens". A closed shadow root (open in the E2E build) at the top center of the
// viewport; only the bar itself takes pointer events, so the page stays usable around it. The JSON path is CSS
// generated content (attr()), never page text that window.find() / Selection could read.
import { FIND_BAR_TAG } from '../../shared/find-protocol';

export interface FindBarHandlers {
  onPrev(): void;
  onNext(): void;
  onClose(): void;
}

export interface FindBarState {
  /** 0-based index of the shown match; -1 when none is shown. */
  index: number;
  count: number;
  path: string;
  /** Replaces the count (e.g. "No longer on the page"). */
  status?: string;
}

export interface FindBar {
  readonly host: HTMLElement;
  update(state: FindBarState): void;
  /** Focus the "next" button (keyboard: ←/→, Enter, Esc). */
  focus(): void;
  remove(): void;
}

const HOST_STYLES: ReadonlyArray<[string, string]> = [
  ['position', 'fixed'],
  ['top', '12px'],
  ['left', '50%'],
  ['right', 'auto'],
  ['bottom', 'auto'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['max-width', 'calc(100vw - 24px)'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['background', 'transparent'],
  ['overflow', 'visible'],
  ['pointer-events', 'auto'],
  ['z-index', '2147483647'],
  ['display', 'block'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'translateX(-50%)'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['zoom', '1'],
  ['color-scheme', 'normal'],
];

const CSS = `:host { all: initial; }
.bar { display: flex; align-items: center; gap: 2px; box-sizing: border-box; max-width: calc(100vw - 24px); height: 36px;
  padding: 0 4px 0 10px; border-radius: 10px; background: rgba(18, 22, 36, 0.95); color: #e8ebf3;
  border: 1px solid rgba(111, 140, 255, 0.35);
  box-shadow: 0 12px 32px -8px rgba(5, 10, 30, 0.55), 0 2px 8px rgba(5, 10, 30, 0.3), 0 0 0 3px rgba(2, 48, 187, 0.18);
  font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; white-space: nowrap; }
.mark { display: inline-flex; width: 16px; height: 16px; margin-right: 6px; color: #8fa6ff; flex: none; }
.mark svg { width: 16px; height: 16px; }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; min-width: 28px; padding: 0 8px; border-radius: 7px; color: #e8ebf3; cursor: pointer; flex: none;
  font: inherit; }
button:hover { background: rgba(255, 255, 255, 0.1); }
button:focus-visible { outline: 2px solid #8fa6ff; outline-offset: 1px; }
button[disabled] { opacity: 0.4; cursor: default; background: none; }
.nav { font-size: 17px; line-height: 1; padding: 0; }
.count { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; color: #ffffff; }
.count.status { min-width: 0; padding: 0 6px; color: #f5b93c; font-weight: 500; }
.sep { width: 1px; height: 18px; margin: 0 8px; background: rgba(255, 255, 255, 0.16); flex: none; }
.path { min-width: 0; max-width: 340px; overflow: hidden; text-overflow: ellipsis; color: #8fa6ff;
  font: 600 12px/1.2 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
.path::before { content: attr(data-text); }
.back { background: #0230bb; color: #ffffff; font-weight: 600; padding: 0 10px; margin-left: 4px; }
.back:hover { background: #2a4ee0; }
.kbd { display: inline-block; padding: 1px 5px; border: 1px solid rgba(255, 255, 255, 0.35); border-bottom-width: 2px;
  border-radius: 4px; font: 600 10px/1.2 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; opacity: 0.85; }`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The crosshair mark (built with DOM APIs: no markup strings). */
function targetIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '7');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '12');
  dot.setAttribute('cy', '12');
  dot.setAttribute('r', '2.2');
  dot.setAttribute('fill', 'currentColor');
  dot.setAttribute('stroke', 'none');
  const ticks = document.createElementNS(SVG_NS, 'path');
  ticks.setAttribute('d', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3');
  svg.append(ring, dot, ticks);
  return svg;
}

function button(cls: string, testId: string, label: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.testid = testId;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.textContent = text;
  return b;
}

/** Show the bar (top-layer popover when supported). */
export function showFindBar(handlers: FindBarHandlers): FindBar {
  const host = document.createElement(FIND_BAR_TAG);
  for (const [prop, value] of HOST_STYLES) host.style.setProperty(prop, value, 'important');
  const popover = typeof host.showPopover === 'function';
  if (popover) host.popover = 'manual';
  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.dataset.testid = 'rl-find-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'kineReqLens — value on the page');
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(targetIcon());
  const prev = button('nav', 'rl-find-bar-prev', 'Previous match (←, Shift+Enter)', '‹');
  const count = document.createElement('span');
  count.className = 'count';
  count.dataset.testid = 'rl-find-bar-count';
  count.setAttribute('aria-live', 'polite');
  const next = button('nav', 'rl-find-bar-next', 'Next match (→, Enter)', '›');
  const sep1 = document.createElement('span');
  sep1.className = 'sep';
  const path = document.createElement('span');
  path.className = 'path';
  path.dataset.testid = 'rl-find-bar-path';
  const sep2 = document.createElement('span');
  sep2.className = 'sep';
  const back = button('back', 'rl-find-bar-close', 'Back to kineReqLens (Esc)', '✕ Back to kineReqLens');
  const kbd = document.createElement('span');
  kbd.className = 'kbd';
  kbd.textContent = 'Esc';
  back.appendChild(kbd);
  bar.append(mark, prev, count, next, sep1, path, sep2, back);
  shadow.append(style, bar);

  const swallow = (e: Event) => e.stopPropagation();
  prev.addEventListener('click', (e) => {
    swallow(e);
    handlers.onPrev();
  });
  next.addEventListener('click', (e) => {
    swallow(e);
    handlers.onNext();
  });
  back.addEventListener('click', (e) => {
    swallow(e);
    handlers.onClose();
  });

  (document.documentElement ?? document.body).appendChild(host);
  if (popover) {
    try {
      host.showPopover();
    } catch {
      /* z-index fallback */
    }
  }

  return {
    host,
    update(state) {
      const multiple = state.count > 1;
      prev.disabled = !multiple;
      next.disabled = !multiple;
      if (state.status) {
        count.textContent = state.status;
        count.classList.add('status');
      } else {
        count.textContent = state.index >= 0 ? `${state.index + 1}/${state.count}` : `0/${state.count}`;
        count.classList.remove('status');
      }
      path.dataset.text = state.path;
    },
    focus() {
      const target = next.disabled ? back : next;
      target.focus({ preventScroll: true });
    },
    remove() {
      if (popover) {
        try {
          host.hidePopover();
        } catch {
          /* not shown */
        }
      }
      host.remove();
    },
  };
}
