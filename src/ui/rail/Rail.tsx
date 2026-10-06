// OWNER: ui-shell agent. Navigation rail on the left edge of the panel: one-click access to the views (Requests,
// WebSocket, Screenshot, Errors) and tools (Setups, Claude Code terminal, Language, Settings), plus a theme quick
// toggle and the collapse / expand switch at the bottom.
//
// - 44 px wide with icons only (labels as tooltips), ~180 px with labels (`settings.layout.railExpanded`); the
//   App forces icons only on narrow panels (< RAIL_COMPACT_PANEL_W).
// - A vertical toolbar: one tab stop (roving tabindex), ↑ / ↓ / Home / End move between items. Alt+1..7 (handled by
//   the App's window keydown, see `railShortcut`) press the item with that `data-shortcut`: Requests 1, WebSocket 2,
//   Setups 3, Screenshot 4, Claude Code 5, Settings 6, Errors 7 (Language has none).
// - Every item sits in a `rl-rail-item` slot (`data-item`, `data-active`); the buttons keep the test ids they had
//   in the header (`rl-view-http|ws` (+ `-count`), `rl-setups-button`, `rl-claude-terminal-toggle`, `rl-settings`).
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '../../shared/types';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { PopoverButton } from '../components/Menu';
import { SetupsButton } from '../setups/SetupsButton';
import { LanguageButton } from '../language/LanguageButton';
import { useTerminalStore } from '../terminal/session';
import { useWsCounts } from '../ws/hooks';
import type { PanelView } from '../ws/ViewSwitch';

export type RailItemId =
  | 'requests'
  | 'websocket'
  | 'errors'
  | 'setups'
  | 'screenshot'
  | 'language'
  | 'terminal'
  | 'settings'
  | 'theme'
  | 'collapse';

/** Collapsed / expanded rail widths in px (keep in sync with rail.css). */
export const RAIL_W = 44;
export const RAIL_EXPANDED_W = 180;
/** Panels narrower than this always show the rail with icons only. */
export const RAIL_COMPACT_PANEL_W = 520;

const THEME_ORDER: ReadonlyArray<Settings['theme']> = ['auto', 'light', 'dark'];
const THEME_INFO: Record<Settings['theme'], { label: string; icon: IconName }> = {
  auto: { label: 'Auto', icon: 'contrast' },
  light: { label: 'Light', icon: 'sun' },
  dark: { label: 'Dark', icon: 'moon' },
};

/** The theme after `theme` in the quick toggle's cycle (auto → light → dark → auto). */
export function nextTheme(theme: Settings['theme']): Settings['theme'] {
  return THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function editable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return true;
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type);
}

/**
 * The rail shortcut (1..7) of an Alt+digit keydown, else null. Not inside the Claude Code terminal (its shell
 * gets Alt keys), nor in text fields on macOS (Option+digit types a character there).
 */
export function railShortcut(e: KeyboardEvent): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return null;
  const m = /^Digit([1-7])$/.exec(e.code);
  if (!m) return null;
  const target = e.composedPath()[0];
  if (target instanceof Element && target.closest('.xterm')) return null;
  if (MAC && target instanceof Element && editable(target)) return null;
  return Number(m[1]);
}

/** Press the rail item with that shortcut inside `root` (focus first, so popovers take the focus from it). */
export function pressRailShortcut(root: ParentNode | null, n: number): boolean {
  const button = root?.querySelector<HTMLButtonElement>(`.rl-rail [data-shortcut="${n}"]:not([disabled])`);
  if (!button || button.getClientRects().length === 0) return false;
  button.focus({ preventScroll: true });
  button.click();
  return true;
}

function badgeText(n: number): string {
  return n > 999 ? '999+' : String(n);
}

export interface RailProps {
  view: PanelView;
  onView(view: PanelView): void;
  httpCount: number;
  /** Distinct failing endpoints on this page (Errors view). */
  errorsCount: number;
  /** Some failing endpoint was not seen in the Errors view yet. */
  errorsNew: boolean;
  /** Error-area screenshots kept / being captured (data attributes: tests wait for captures to settle). */
  errorsShots?: number;
  errorsCapturing?: number;
  /** Labels shown (the effective state: false while forced compact). */
  expanded: boolean;
  /** The panel is wide enough for labels (the collapse / expand switch is shown). */
  canExpand: boolean;
  onToggleExpanded(): void;
  /** The screenshot tool can run here (the overlay; not the standalone tab). */
  screenshot: boolean;
  /** The "Site language" tool can run here (the overlay in a page tab; not the standalone tab). */
  language?: boolean;
  terminalOpen: boolean;
  /** Why the terminal cannot run (null: available). */
  terminalReason: string | null;
  onToggleTerminal(): void;
  theme: Settings['theme'];
  onTheme(theme: Settings['theme']): void;
  /** Settings popover content. */
  settings(close: () => void): ComponentChildren;
}

interface ItemContentProps {
  icon: IconName;
  label: ComponentChildren;
  badge?: { text: string; zero: boolean; testId?: string };
  dot?: 'live' | 'run' | 'modified' | 'new' | null;
  dotTestId?: string;
  dotLabel?: string;
}

function ItemContent({ icon, label, badge, dot, dotTestId, dotLabel }: ItemContentProps) {
  return (
    <>
      <span class="rl-rail__icon">
        <Icon name={icon} size={17} />
        {dot ? (
          <span
            class={`rl-rail__dot rl-rail__dot--${dot}`}
            role={dotLabel ? 'img' : undefined}
            aria-label={dotLabel}
            aria-hidden={dotLabel ? undefined : 'true'}
            data-testid={dotTestId}
          />
        ) : null}
      </span>
      <span class="rl-rail__label rl-truncate">{label}</span>
      {badge ? (
        <span class="rl-rail__badge" data-zero={badge.zero ? 'true' : 'false'} data-testid={badge.testId}>
          {badge.text}
        </span>
      ) : null}
    </>
  );
}

export function Rail(props: RailProps) {
  const ws = useWsCounts();
  const terminals = useTerminalStore();
  const running = terminals.list().filter((s) => s.state === 'running' || s.state === 'opening').length;
  const navRef = useRef<HTMLElement>(null);

  const activeItem: RailItemId = props.view === 'ws' ? 'websocket' : props.view === 'shot' ? 'screenshot' : props.view === 'errors' ? 'errors' : 'requests';
  const [focused, setFocusKey] = useState<RailItemId>(activeItem);
  // The tab stop follows the active view unless the focus is in the rail.
  useEffect(() => {
    if (!navRef.current?.contains(deepActive(navRef.current))) setFocusKey(activeItem);
  }, [activeItem]);
  const hidden =
    (focused === 'screenshot' && !props.screenshot) ||
    (focused === 'language' && !props.language) ||
    (focused === 'collapse' && !props.canExpand);
  const focusKey = hidden ? activeItem : focused;

  /** Common attributes of a rail button: roving tab stop, shortcut, focus tracking. */
  const attrs = (key: RailItemId, shortcut?: number): JSX.HTMLAttributes<HTMLButtonElement> => ({
    tabIndex: focusKey === key ? 0 : -1,
    'data-rail-key': key,
    'data-shortcut': shortcut === undefined ? undefined : String(shortcut),
    'aria-keyshortcuts': shortcut === undefined ? undefined : `Alt+${shortcut}`,
    onFocus: () => setFocusKey(key),
  } as JSX.HTMLAttributes<HTMLButtonElement>);

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    if (!target?.matches?.('[data-rail-key]')) return; // keys inside the Settings / Setups popovers
    const buttons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-key]') ?? []).filter(
      (b) => !b.disabled && b.getClientRects().length > 0,
    );
    const i = buttons.indexOf(target as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else return;
    e.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };

  const httpTitle = `Requests — ${props.httpCount} captured (Alt+1)`;
  const wsTitle = `WebSocket — ${ws.connections} connection${ws.connections === 1 ? '' : 's'}${ws.open ? `, ${ws.open} open` : ''} (Alt+2)`;
  const errorsTitle = `Errors — ${props.errorsCount} failing endpoint${props.errorsCount === 1 ? '' : 's'}${props.errorsNew ? ' (new)' : ''} (Alt+7)`;
  const shotTitle = 'Screenshot — capture the page or the panel (Alt+4)';
  const terminalTitle = props.terminalOpen
    ? `Hide the Claude Code terminal${running ? ` — ${running} running` : ''} (Alt+5)`
    : props.terminalReason
      ? `Claude Code terminal — ${props.terminalReason} (Alt+5)`
      : `Open a Claude Code terminal${running ? ` — ${running} running` : ''} (Alt+5)`;
  const themeInfo = THEME_INFO[props.theme];
  const upcoming = THEME_INFO[nextTheme(props.theme)];
  const themeTitle = `Theme: ${themeInfo.label}${props.theme === 'auto' ? ' (follows the system)' : ''} — switch to ${upcoming.label}`;

  const viewItem = (key: RailItemId, view: PanelView, shortcut: number, title: string, content: ComponentChildren, data?: Record<string, string>) => {
    const active = props.view === view;
    return (
      <div class="rl-rail__slot" data-testid="rl-rail-item" data-item={key} data-active={active ? 'true' : 'false'}>
        <button
          {...attrs(key, shortcut)}
          type="button"
          class="rl-rail__btn"
          title={title}
          aria-label={title}
          aria-current={active ? 'page' : undefined}
          data-view={view}
          data-testid={`rl-view-${view}`}
          {...data}
          onClick={() => props.onView(view)}
        >
          {content}
        </button>
      </div>
    );
  };

  return (
    <nav
      ref={navRef}
      class={`rl-rail${props.expanded ? ' rl-rail--expanded' : ''}`}
      aria-label="kineReqLens"
      data-testid="rl-rail"
      data-expanded={props.expanded ? 'true' : 'false'}
    >
      <div class="rl-rail__bar" role="toolbar" aria-orientation="vertical" aria-label="Views and tools" onKeyDown={onKeyDown}>
        <div class="rl-rail__group" role="group" aria-label="View" data-testid="rl-view-switch">
          {viewItem(
            'requests',
            'http',
            1,
            httpTitle,
            <ItemContent
              icon="requests"
              label="Requests"
              badge={{ text: badgeText(props.httpCount), zero: props.httpCount === 0, testId: 'rl-view-http-count' }}
            />,
          )}
          {viewItem(
            'websocket',
            'ws',
            2,
            wsTitle,
            <ItemContent
              icon="plug"
              label="WebSocket"
              badge={{ text: badgeText(ws.connections), zero: ws.connections === 0, testId: 'rl-view-ws-count' }}
              dot={ws.open ? 'live' : null}
              dotLabel={ws.open ? 'live' : undefined}
            />,
          )}
        </div>

        <div class="rl-rail__slot" data-testid="rl-rail-item" data-item="setups">
          <SetupsButton
            rail={{
              class: 'rl-rail__btn',
              attrs: attrs('setups', 3),
              content: ({ active, modified }) => (
                <ItemContent
                  icon="layers"
                  label={active ? active.name : 'Setups'}
                  dot={modified ? 'modified' : null}
                  dotTestId={modified ? 'rl-setups-modified' : undefined}
                />
              ),
            }}
          />
        </div>

        {props.screenshot
          ? viewItem('screenshot', 'shot', 4, shotTitle, <ItemContent icon="camera" label="Screenshot" />)
          : null}

        <div class="rl-rail__slot" data-testid="rl-rail-item" data-item="terminal" data-active={props.terminalOpen ? 'true' : 'false'}>
          <button
            {...attrs('terminal', 5)}
            type="button"
            class="rl-rail__btn rl-rail__btn--toggle"
            title={terminalTitle}
            aria-label={terminalTitle}
            aria-pressed={props.terminalOpen ? 'true' : 'false'}
            data-available={props.terminalReason ? 'false' : 'true'}
            data-running={String(running)}
            data-testid="rl-claude-terminal-toggle"
            onClick={props.onToggleTerminal}
          >
            <ItemContent icon="terminal" label="Claude Code" dot={running ? 'run' : null} dotLabel={running ? `${running} running` : undefined} />
          </button>
        </div>

        {props.language ? (
          <div class="rl-rail__slot" data-testid="rl-rail-item" data-item="language">
            <LanguageButton
              class="rl-rail__btn"
              attrs={attrs('language')}
              content={({ tag }) => (
                <ItemContent
                  icon="globe"
                  label="Language"
                  badge={tag ? { text: tag, zero: false, testId: 'rl-language-badge' } : undefined}
                />
              )}
            />
          </div>
        ) : null}

        <div class="rl-rail__slot" data-testid="rl-rail-item" data-item="settings">
          <PopoverButton
            title="Settings (Alt+6)"
            beside
            class="rl-rail__btn"
            testId="rl-settings"
            trigger={{ content: <ItemContent icon="settings" label="Settings" />, attrs: attrs('settings', 6) }}
          >
            {props.settings}
          </PopoverButton>
        </div>

        {/* Errors (view): after Settings so the tools above keep their places (popovers beside them). */}
        <div class="rl-rail__group" role="group" aria-label="Errors">
          {viewItem(
            'errors',
            'errors',
            7,
            errorsTitle,
            <ItemContent
              icon="warning"
              label="Errors"
              badge={{ text: badgeText(props.errorsCount), zero: props.errorsCount === 0, testId: 'rl-view-errors-count' }}
              dot={props.errorsNew ? 'new' : null}
              dotTestId={props.errorsNew ? 'rl-errors-new-dot' : undefined}
              dotLabel={props.errorsNew ? 'new errors' : undefined}
            />,
            { 'data-shots': String(props.errorsShots ?? 0), 'data-capturing': String(props.errorsCapturing ?? 0) },
          )}
        </div>

        <span class="rl-rail__spacer" />

        <div class="rl-rail__slot rl-rail__slot--minor" data-testid="rl-rail-item" data-item="theme">
          <button
            {...attrs('theme')}
            type="button"
            class="rl-rail__btn"
            title={themeTitle}
            aria-label={themeTitle}
            data-theme-setting={props.theme}
            data-testid="rl-theme-toggle"
            onClick={() => props.onTheme(nextTheme(props.theme))}
          >
            <ItemContent icon={themeInfo.icon} label={`Theme: ${themeInfo.label}`} />
          </button>
        </div>
        {props.canExpand ? (
          <div class="rl-rail__slot rl-rail__slot--minor" data-testid="rl-rail-item" data-item="collapse">
            <button
              {...attrs('collapse')}
              type="button"
              class="rl-rail__btn rl-rail__btn--collapse"
              title={props.expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
              aria-label={props.expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
              aria-expanded={props.expanded ? 'true' : 'false'}
              data-testid="rl-rail-toggle"
              onClick={props.onToggleExpanded}
            >
              <ItemContent icon="sidebar" label="Collapse" />
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function deepActive(el: HTMLElement): Element | null {
  const root = el.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
}
