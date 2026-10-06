// OWNER: ui-shell agent. Request list column: toolbar, rules bar, late-capture banner, (virtualized) rows, status
// bar, and the row context menu (ui-list-menu agent).
import type { JSX } from 'preact';
import { isStandaloneShell } from '../shellMode';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RequestEntry, UrlDisplay } from '../../shared/types';
import type { ContextMenuAnchor } from '../components/ContextMenu';
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { useBridge, useCaptureInfo, useElementSize, useSettings, useTabState } from '../hooks';
import { normalizeListTypes } from '../../shared/setups';
import {
  DEFAULT_CHIPS,
  TYPE_CHIPS,
  activeRowKey,
  buildListModel,
  isDefaultChips,
  isFiltering,
  isOptionRow,
  moveRowKey,
  rowIndexOfKey,
} from './filter';
import type { KindChipId, ListFilter, ListRow } from './filter';
import { groupListRows, inlineHostFlags } from './endpointLabel';
import { monoCharWidth } from './EndpointChips';
import { GroupContextMenu } from './GroupContextMenu';
import { pruneRemoved, restoreToList, setListTypes, useListRules, useListTypes, useRemovedEntries } from './listState';
import { GroupRow, PreviousPageSeparator, RequestRow } from './RequestRow';
import { MethodContextMenu } from './MethodContextMenu';
import { RowContextMenu } from './RowContextMenu';
import { clearListRules, deleteListRule, disableAllListRules, toggleListRule } from './ruleActions';
import { countMatches } from './rules';
import { RulesBar } from './RulesBar';
import { PopoverButton } from '../components/Menu';
import { FindSourceButton } from '../find/FindSource';
import { VIRTUALIZE_THRESHOLD, scrollAnchor, scrollTopToReveal, visibleRange } from './virtual';

export interface RequestListProps {
  /** All entries, oldest first (as returned by the bridge). */
  entries: RequestEntry[];
  selectedId: string | null;
  /** `activate` is true for clicks / Enter (open the detail in narrow layouts), false for arrow keys. */
  onSelect(id: string, activate: boolean): void;
  onNewRequest(): void;
  onClear(): void;
  /** "Where does this come from?" found a WebSocket message: show it (switches to the WebSocket view). */
  onShowWsFrame?(wsId: string, frameId: number, path: Array<string | number> | null): void;
}

const DEFAULT_ROW_HEIGHT = 28;

// The text filter survives remounts (narrow <-> wide layout switches) for the lifetime of the page; the type
// selection is persisted (settings.listTypes) and saved in setups.
let rememberedText = '';
/** The late-capture banner was dismissed (for this page; survives list remounts on layout changes). */
let bannerWasDismissed = false;
/** Expanded "Group by endpoint" rows (for the panel's lifetime; survives list remounts). */
let rememberedExpanded: ReadonlySet<string> = new Set();
const filterTextListeners = new Set<(text: string) => void>();

/** The list's text filter (panel memory). */
export function getListFilterText(): string {
  return rememberedText;
}

/** Set the list's text filter from outside the list (the Claude Code control plane, src/ui/panel/control.ts). */
export function setListFilterText(text: string): void {
  rememberedText = text;
  for (const fn of [...filterTextListeners]) fn(text);
}

function readRowHeight(el: HTMLElement): number {
  const value = parseFloat(getComputedStyle(el).getPropertyValue('--rl-row-h'));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROW_HEIGHT;
}

function reportError(action: string) {
  return (err: unknown) => toast(`${action}: ${err instanceof Error ? err.message : String(err)}`, 'error');
}

/** An open row context menu. */
interface RowMenuState {
  /** Bumped per open, so every open mounts a fresh menu. */
  seq: number;
  /** 'method' = opened on the row's method badge; 'group' = on a "Group by endpoint" row. */
  scope: 'row' | 'method' | 'group';
  /** The entry (for a group: its newest call). */
  entryId: string;
  /** Group row key (scope 'group'). */
  groupKey: string | null;
  anchor: ContextMenuAnchor;
  /** Opened from the keyboard (focus the first item). */
  keyboard: boolean;
  /** Opened from the row's "⋯" button (a click on it closes the menu again). */
  fromButton: boolean;
}

/** What a row (or the keyboard) asks the list for. */
export type RowMenuRequest = (
  entryId: string,
  anchor: ContextMenuAnchor,
  how: 'pointer' | 'keyboard' | 'button',
  button?: HTMLElement,
  scope?: 'row' | 'method' | 'group',
  groupKey?: string,
) => void;

/** The request list column. */
export function RequestList({ entries, selectedId, onSelect, onNewRequest, onClear, onShowWsFrame }: RequestListProps) {
  const bridge = useBridge();
  const tabState = useTabState();
  const capture = useCaptureInfo();
  const [filterText, setFilterTextState] = useState(rememberedText);
  useEffect(() => {
    // A text set from outside before this subscribed (effects of a panel mounted for Claude run late) applies now.
    setFilterTextState(rememberedText);
    filterTextListeners.add(setFilterTextState);
    return () => {
      filterTextListeners.delete(setFilterTextState);
    };
  }, []);
  const listTypes = useListTypes();
  const chips = useMemo<ReadonlySet<KindChipId>>(() => new Set(listTypes), [listTypes]);
  const filter = useMemo<ListFilter>(() => ({ text: filterText, chips }), [filterText, chips]);
  const [bannerDismissed, setBannerDismissedState] = useState(bannerWasDismissed);
  const setBannerDismissed = (value: boolean) => {
    bannerWasDismissed = value;
    setBannerDismissedState(value);
  };
  const filterInputRef = useRef<HTMLInputElement>(null);
  const listFocusRef = useRef<(() => void) | null>(null);

  const setFilter = (next: ListFilter) => {
    rememberedText = next.text;
    setFilterTextState(next.text);
    if (next.chips !== chips) setListTypes(bridge, normalizeListTypes(next.chips));
  };

  const rules = useListRules();
  const removed = useRemovedEntries();
  const model = useMemo(
    () => buildListModel(entries, filter, selectedId, { rules, removed }),
    [entries, filter, selectedId, rules, removed],
  );

  // ---- Group by endpoint (settings.listGroup, applied at once while the write is in flight) ---------------
  const settings = useSettings();
  const urlDisplay: UrlDisplay = settings.urlDisplay === 'full' ? 'full' : 'template';
  const [grouped, setGroupedState] = useState(settings.listGroup === true);
  useEffect(() => setGroupedState(settings.listGroup === true), [settings.listGroup]);
  const setGrouped = (value: boolean) => {
    setGroupedState(value);
    bridge.updateSettings({ listGroup: value }).catch(reportError('Could not save the grouping'));
  };
  const [expanded, setExpandedState] = useState(rememberedExpanded);
  const setExpanded = (next: ReadonlySet<string>) => {
    rememberedExpanded = next;
    setExpandedState(next);
  };
  /** The group row the user picked (it stands for its newest call); null when an entry row was picked. */
  const [cursorGroup, setCursorGroup] = useState<string | null>(null);
  const rows = useMemo(() => (grouped ? groupListRows(model.rows, { expanded }) : model.rows), [grouped, model.rows, expanded]);

  const selectEntry = (id: string, activate: boolean) => {
    setCursorGroup(null);
    onSelect(id, activate);
  };
  const pickGroup = (key: string, activate: boolean) => {
    const row = rows.find((r) => r.key === key);
    if (row?.type !== 'group') return;
    setCursorGroup(key);
    onSelect(row.group.newest.id, activate);
  };
  const toggleGroup = (key: string, open?: boolean) => {
    const isOpen = expanded.has(key);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    const next = new Set(expanded);
    if (want) next.add(key);
    else next.delete(key);
    setExpanded(next);
    // Keep the cursor on the group when it collapses over the selected call.
    if (!want) pickGroup(key, false);
  };
  const ruleCounts = useMemo(() => (rules.length ? countMatches(entries, rules) : []), [entries, rules]);
  const filtering = isFiltering(filter);
  const narrowed = filtering || model.hiddenByRules > 0 || model.removed > 0;

  // Forget removed ids of entries that are gone (cleared / evicted).
  useEffect(() => {
    if (removed.size) pruneRemoved(new Set(entries.map((e) => e.id)));
  }, [entries, removed]);

  // ---- row context menu ------------------------------------------------------------------------------
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const menuSeq = useRef(0);
  const menuButtonRef = useRef<HTMLElement | null>(null);
  const menuEntry = menu ? (entries.find((e) => e.id === menu.entryId) ?? null) : null;
  const menuGroupRow = menu?.groupKey ? rows.find((r) => r.key === menu.groupKey) : undefined;
  const menuGroup = menuGroupRow?.type === 'group' ? menuGroupRow : null;
  useEffect(() => {
    if (menu && (!menuEntry || (menu.scope === 'group' && !menuGroup))) setMenu(null); // cleared / evicted while open
  }, [menu, menuEntry, menuGroup]);

  const requestMenu: RowMenuRequest = (entryId, anchor, how, button, scope = 'row', groupKey) => {
    const key = scope === 'group' ? (groupKey ?? null) : null;
    if (how === 'button' && menu?.fromButton && menu.entryId === entryId && menu.groupKey === key) {
      setMenu(null); // second click on the same "⋯" closes
      return;
    }
    menuButtonRef.current = how === 'button' ? (button ?? null) : null;
    if (key) {
      if (key !== activeRowKey(rows, selectedId, cursorGroup)) pickGroup(key, false);
    } else if (entryId !== selectedId || cursorGroup) selectEntry(entryId, false);
    setMenu({ seq: ++menuSeq.current, scope, entryId, groupKey: key, anchor, keyboard: how === 'keyboard', fromButton: how === 'button' });
  };
  const closeMenu = (restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) listFocusRef.current?.();
  };

  const toggleRecording = () => {
    bridge.setTabState({ recording: !tabState.recording }).catch(reportError('Could not change recording'));
  };
  const setPreserve = (value: boolean) => {
    bridge.setTabState({ preserveLog: value }).catch(reportError('Could not change preserve log'));
  };

  const onFilterKey = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && filter.text) {
      e.preventDefault();
      setFilter({ ...filter, text: '' });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const key = activeRowKey(rows, selectedId, cursorGroup) ?? moveRowKey(rows, null, 'first');
      const row = key ? rows[rowIndexOfKey(rows, key)] : undefined;
      if (row?.type === 'group') pickGroup(row.key, false);
      else if (row?.type === 'entry') selectEntry(row.entry.id, false);
      listFocusRef.current?.();
    }
  };

  const showBanner = capture.lateInjection && !bannerDismissed;

  // The context menu renders beside the list, not inside it: .rl-list is a size container, which would become
  // the containing block of the menu's fixed-position panels.
  return (
    <>
      <div class="rl-list">
        <div class="rl-list__toolbar">
          <div class="rl-list__toolbar-row">
            <button
              type="button"
              class={`rl-icon-btn rl-list__record${tabState.recording ? ' rl-list__record--on' : ''}`}
              aria-pressed={tabState.recording ? 'true' : 'false'}
              title={tabState.recording ? 'Pause recording' : 'Resume recording'}
              aria-label={tabState.recording ? 'Pause recording' : 'Resume recording'}
              data-testid="rl-record-toggle"
              onClick={toggleRecording}
            >
              <Icon name={tabState.recording ? 'record' : 'pause'} size={14} />
            </button>
            <button
              type="button"
              class="rl-icon-btn"
              title="Clear requests"
              aria-label="Clear requests"
              data-testid="rl-clear"
              onClick={onClear}
            >
              <Icon name="clear" size={15} />
            </button>
            <div class="rl-search">
              <Icon name="filter" size={13} class="rl-search__icon" />
              <input
                ref={filterInputRef}
                type="text"
                class="rl-input rl-search__input"
                placeholder="Filter"
                title="Filter by URL, method or status: space-separated terms, -term excludes (e.g. api -png 4xx)"
                aria-label="Filter requests by URL, method or status"
                spellcheck={false}
                autocomplete="off"
                value={filter.text}
                data-testid="rl-filter-input"
                onInput={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
                onKeyDown={onFilterKey}
              />
              {filter.text ? (
                <button
                  type="button"
                  class="rl-icon-btn rl-icon-btn--sm rl-search__clear"
                  title="Clear filter"
                  aria-label="Clear filter"
                  onClick={() => {
                    setFilter({ ...filter, text: '' });
                    filterInputRef.current?.focus();
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
            </div>
            <TypesMenu chips={filter.chips} onChange={(chips) => setFilter({ ...filter, chips })} />
            <button
              type="button"
              class={`rl-icon-btn rl-list__group${grouped ? ' rl-list__group--on' : ''}`}
              aria-pressed={grouped ? 'true' : 'false'}
              title={grouped ? 'Group by endpoint: on — click to list every call' : 'Group by endpoint (method + host + path template)'}
              aria-label="Group by endpoint"
              data-testid="rl-group-toggle"
              onClick={() => setGrouped(!grouped)}
            >
              <Icon name="layers" size={14} />
            </button>
            <FindSourceButton entries={entries} onSelectEntry={(id) => selectEntry(id, true)} onShowWsFrame={onShowWsFrame} />
            <button
              type="button"
              class="rl-btn rl-btn--sm rl-list__new"
              title="Compose a new request"
              aria-label="New request"
              data-testid="rl-new-request"
              onClick={onNewRequest}
            >
              <Icon name="plus" size={13} />
              <span>New</span>
            </button>
          </div>
        </div>

        {rules.length ? (
          <RulesBar
            rules={rules}
            counts={ruleCounts}
            onToggle={(rule) => toggleListRule(bridge, rule)}
            onDelete={(rule) => deleteListRule(bridge, rule)}
            onClear={() => clearListRules(bridge)}
          />
        ) : null}

        {showBanner ? (
          <div class="rl-banner" role="status" data-testid="rl-late-banner">
            <Icon name="info" size={14} class="rl-banner__icon" />
            <span class="rl-banner__text">kineReqLens started after this page loaded. Reload to capture page-load requests.</span>
            <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" onClick={() => bridge.reloadPage()}>
              <Icon name="reload" size={12} />
              Reload
            </button>
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => setBannerDismissed(true)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ) : null}

        <RowsView
          rows={rows}
          selectedId={selectedId}
          cursorGroup={cursorGroup}
          onSelect={selectEntry}
          onPickGroup={pickGroup}
          onToggleGroup={toggleGroup}
          focusRef={listFocusRef}
          menuKey={menu ? (menu.groupKey ?? menu.entryId) : null}
          onRowMenu={requestMenu}
          urlDisplay={urlDisplay}
          empty={
            model.matched > 0 ? null : (
              <EmptyState
                total={model.total}
                filtering={filtering}
                hiddenByRules={model.hiddenByRules}
                removed={model.removed}
                recording={tabState.recording}
                onClearFilter={() => setFilter({ text: '', chips: new Set(DEFAULT_CHIPS) })}
                onDisableRules={() => disableAllListRules(bridge)}
                onRestoreRemoved={() => restoreToList()}
                onResume={toggleRecording}
                onReload={() => bridge.reloadPage()}
              />
            )
          }
        />

        <div class="rl-list__footer">
          {isStandaloneShell() ? null : (
            <label class="rl-list__preserve" title="Keep requests across page loads in this tab">
              <input
                type="checkbox"
                class="rl-checkbox"
                checked={tabState.preserveLog}
                data-testid="rl-preserve-toggle"
                onChange={(e) => setPreserve(e.currentTarget.checked)}
              />
              <span>Preserve log</span>
            </label>
          )}
          <span class="rl-spacer" />
          <span class="rl-list__count" aria-live="polite">
            {narrowed ? `${model.matched} / ${model.total}` : model.total} request{model.total === 1 ? '' : 's'}
          </span>
          {model.hiddenByRules > 0 ? (
            <span
              class="rl-list__hidden"
              title={`${model.hiddenByRules} request${model.hiddenByRules === 1 ? ' is' : 's are'} hidden by the list rules above`}
              data-testid="rl-hidden-count"
            >
              {model.hiddenByRules} hidden<span class="rl-list__hidden-long"> by rules</span>
            </span>
          ) : null}
          {model.removed > 0 ? (
            <button
              type="button"
              class="rl-list__removed"
              title="Show the requests you removed from the list again"
              data-testid="rl-removed-restore"
              onClick={() => restoreToList()}
            >
              {model.removed} removed · Show
            </button>
          ) : null}
        </div>
      </div>
      {menu && menuEntry && menu.scope === 'group' && menuGroup ? (
        <GroupContextMenu
          key={menu.seq}
          group={menuGroup.group}
          expanded={menuGroup.expanded}
          entries={entries}
          anchor={menu.anchor}
          keyboard={menu.keyboard}
          ignore={menu.fromButton ? [menuButtonRef] : undefined}
          onToggle={() => toggleGroup(menuGroup.key)}
          onClose={closeMenu}
        />
      ) : menu && menuEntry && menu.scope === 'method' ? (
        <MethodContextMenu
          key={menu.seq}
          entry={menuEntry}
          entries={entries}
          anchor={menu.anchor}
          keyboard={menu.keyboard}
          onClose={closeMenu}
        />
      ) : menu && menuEntry ? (
        <RowContextMenu
          key={menu.seq}
          entry={menuEntry}
          entries={entries}
          anchor={menu.anchor}
          keyboard={menu.keyboard}
          ignore={menu.fromButton ? [menuButtonRef] : undefined}
          onClose={closeMenu}
          onSelectEntry={(id) => onSelect(id, true)}
        />
      ) : null}
    </>
  );
}

interface EmptyStateProps {
  total: number;
  filtering: boolean;
  hiddenByRules: number;
  removed: number;
  recording: boolean;
  onClearFilter(): void;
  onDisableRules(): void;
  onRestoreRemoved(): void;
  onResume(): void;
  onReload(): void;
}

function EmptyState(props: EmptyStateProps) {
  const { total, filtering, hiddenByRules, removed, recording, onClearFilter, onResume, onReload } = props;
  if (total > 0 && (filtering || hiddenByRules > 0 || removed > 0)) {
    const notes: string[] = [];
    if (hiddenByRules > 0) notes.push(`${hiddenByRules} hidden by rules`);
    if (removed > 0) notes.push(`${removed} removed from the list`);
    return (
      <div class="rl-empty rl-list__empty">
        <Icon name="filter" size={22} class="rl-empty__icon" />
        <div class="rl-empty__title">No requests match</div>
        {notes.length ? <div class="rl-empty__text">{notes.join(' · ')}</div> : null}
        <div class="rl-list__empty-actions">
          {filtering ? (
            <button type="button" class="rl-btn rl-btn--sm" onClick={onClearFilter}>
              Clear filters
            </button>
          ) : null}
          {hiddenByRules > 0 ? (
            <button type="button" class="rl-btn rl-btn--sm" onClick={props.onDisableRules}>
              Turn rules off
            </button>
          ) : null}
          {removed > 0 ? (
            <button type="button" class="rl-btn rl-btn--sm" onClick={props.onRestoreRemoved}>
              Show removed
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!recording) {
    return (
      <div class="rl-empty rl-list__empty">
        <Icon name="pause" size={22} class="rl-empty__icon" />
        <div class="rl-empty__title">Recording is paused</div>
        <div class="rl-empty__text">New requests are not captured until you resume.</div>
        <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" onClick={onResume}>
          <Icon name="record" size={12} />
          Resume recording
        </button>
      </div>
    );
  }
  return (
    <div class="rl-empty rl-list__empty">
      <span class="rl-list__radar" aria-hidden="true">
        <BrandMark size={28} />
      </span>
      <div class="rl-empty__title">Waiting for requests…</div>
      {isStandaloneShell() ? (
        <div class="rl-empty__text">Use the app to trigger requests: they appear here as it sends them.</div>
      ) : (
        <>
          <div class="rl-empty__text">
            Use the page to trigger requests, or reload it to capture everything it loads.
          </div>
          <button type="button" class="rl-btn rl-btn--sm" onClick={onReload}>
            <Icon name="reload" size={12} />
            Reload page
          </button>
        </>
      )}
    </div>
  );
}

interface RowsViewProps {
  rows: ListRow[];
  selectedId: string | null;
  /** Group row the user put the cursor on (it stands for its newest call), or null. */
  cursorGroup: string | null;
  onSelect(id: string, activate: boolean): void;
  onPickGroup(groupKey: string, activate: boolean): void;
  onToggleGroup(groupKey: string, expanded?: boolean): void;
  /** Receives a function that focuses the list (used by the filter input's ArrowDown). */
  focusRef: { current: (() => void) | null };
  /** Key of the row whose context menu is open (entry id or group row key). */
  menuKey: string | null;
  onRowMenu: RowMenuRequest;
  urlDisplay: UrlDisplay;
  empty: JSX.Element | null;
}

/** The ContextMenu key also fires a keyboard `contextmenu` event right after its keydown: not a second open. */
const KEY_MENU_GRACE_MS = 600;

function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey);
}

function rectOf(el: Element): { left: number; top: number; right: number; bottom: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** List width from which rows have a host column (CSS: @container rl-list (min-width: 760px)). */
const HOST_COLUMN_MIN_WIDTH = 760;

/** Gap between the name and marks cells of a row (CSS .rl-req-row gap). */
const ROW_GAP_PX = 6;

/**
 * Characters available to row labels: the name cell (+ the marks cell when shown) of a rendered row, in units of the
 * name font's monospace character. One layout read per list width change (ResizeObserver via useElementSize), never
 * per row; every row then lays its label out against the same budget.
 */
function useLabelBudget(scrollRef: { current: HTMLDivElement | null }, width: number, hasRows: boolean, mode: string): number {
  const [budget, setBudget] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasRows || width <= 0) return;
    const row = el.querySelector<HTMLElement>('.rl-req-row');
    const name = row?.querySelector<HTMLElement>('.rl-req-row__name');
    if (!row || !name) return;
    const marks = row.querySelector<HTMLElement>('.rl-req-row__marks');
    let px = name.getBoundingClientRect().width;
    const marksWidth = marks ? marks.getBoundingClientRect().width : 0;
    if (marksWidth > 0) px += marksWidth + ROW_GAP_PX;
    const char = monoCharWidth(name);
    // One character of slack: chip padding and sub-pixel widths must never push the label past the cell.
    const next = Math.max(8, Math.floor(px / char) - 1);
    setBudget((b) => (b === next ? b : next));
  }, [width, hasRows, mode]);
  return budget;
}

/** Scrollable listbox. Fixed-height rows; virtualized beyond VIRTUALIZE_THRESHOLD rows. */
function RowsView(props: RowsViewProps) {
  const { rows, selectedId, cursorGroup, onSelect, onPickGroup, onToggleGroup, focusRef, menuKey, onRowMenu, urlDisplay, empty } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width: viewportWidth, height: viewportHeight } = useElementSize(scrollRef);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [scrollTop, setScrollTop] = useState(0);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const scrollFrame = useRef(0);
  const virtual = rows.length > VIRTUALIZE_THRESHOLD;
  const options = useMemo(() => rows.reduce((n, r) => (isOptionRow(r) ? n + 1 : n), 0), [rows]);
  // Inline hosts only where there is no host column.
  const hostColumn = viewportWidth >= HOST_COLUMN_MIN_WIDTH;
  const hostFlags = useMemo(() => (hostColumn ? null : inlineHostFlags(rows)), [rows, hostColumn]);
  const budget = useLabelBudget(scrollRef, viewportWidth, rows.length > 0 && !empty, urlDisplay);

  focusRef.current = () => scrollRef.current?.focus({ preventScroll: true });

  useLayoutEffect(() => {
    if (scrollRef.current) setRowHeight(readRowHeight(scrollRef.current));
  }, []);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  const rememberAnchor = (top: number) => {
    if (top <= 0) {
      anchor.current = null; // pinned to the top: new (newest-first) rows push in visibly
      return;
    }
    const a = scrollAnchor(top, rowHeight);
    const row = rows[a.index];
    anchor.current = row ? { key: row.key, offset: a.offset } : null;
  };

  // Keep the rows the user is looking at in place when new entries are inserted above them.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    const index = rows.findIndex((r) => r.key === a.key);
    if (index < 0) return;
    const target = index * rowHeight + a.offset;
    if (Math.abs(el.scrollTop - target) >= 1) {
      el.scrollTop = target;
      setScrollTop(el.scrollTop);
    }
  }, [rows, rowHeight]);

  const reveal = (key: string | null) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = scrollTopToReveal(rowIndexOfKey(rows, key), rowHeight, el.scrollTop, el.clientHeight);
    if (top !== null) {
      el.scrollTop = top;
      setScrollTop(el.scrollTop);
      rememberAnchor(el.scrollTop);
    }
  };

  const activeKey = activeRowKey(rows, selectedId, cursorGroup);
  const activeIndex = rowIndexOfKey(rows, activeKey);
  // Reveal selection changes that come from outside (e.g. "+ New request"), including a selected entry that
  // only shows up in `rows` a moment after it was selected.
  useLayoutEffect(() => reveal(activeKey), [activeKey, activeIndex >= 0]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    rememberAnchor(el.scrollTop);
    if (!virtual) return;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
  };

  const focusList = () => scrollRef.current?.focus({ preventScroll: true });

  /** Select the row with this key (a group row stands for its newest call). */
  const pickKey = (key: string, activate: boolean) => {
    const row = rows.find((r) => r.key === key);
    if (!row || row.type === 'separator') return;
    if (row.type === 'group') onPickGroup(row.key, activate);
    else onSelect(row.entry.id, activate);
  };

  const pick = (id: string, activate: boolean) => {
    onSelect(id, activate);
    focusList();
  };
  const pickGroup = (key: string, activate: boolean) => {
    onPickGroup(key, activate);
    focusList();
  };
  const toggleGroup = (key: string) => {
    onToggleGroup(key);
    focusList();
  };

  const keyMenuAt = useRef(-Infinity);

  const rowElement = (key: string): HTMLElement | null => {
    const row = rows.find((r) => r.key === key);
    if (!row || row.type === 'separator') return null;
    const id = row.type === 'group' ? groupDomId(row.key) : rowDomId(row.entry.id);
    return scrollRef.current?.ownerDocument.getElementById(id) ?? findById(scrollRef.current, id);
  };

  /** Context menu of the active row (or the first one) from the keyboard, below the row. */
  const openKeyboardMenu = () => {
    const el = scrollRef.current;
    if (!el) return;
    const key = activeKey !== null && activeIndex >= 0 ? activeKey : moveRowKey(rows, null, 'first');
    if (!key) return;
    reveal(key);
    const row = rows.find((r) => r.key === key);
    if (!row || row.type === 'separator') return;
    const rowEl = rowElement(key);
    const box = rectOf(rowEl ?? el);
    // Start under the row's name, not at its far left edge.
    const rect = rowEl ? { ...box, left: Math.min(box.left + 48, box.right) } : { ...box, bottom: box.top };
    if (row.type === 'group') onRowMenu(row.group.newest.id, { rect }, 'keyboard', undefined, 'group', row.key);
    else onRowMenu(row.entry.id, { rect }, 'keyboard');
  };

  const onContextMenu = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || empty) return;
    const target = e.target instanceof Element ? e.target : null;
    const groupEl = target?.closest<HTMLElement>('[data-group-key]');
    if (groupEl && el.contains(groupEl)) {
      e.preventDefault();
      el.focus({ preventScroll: true });
      const row = rows.find((r) => r.key === groupEl.dataset.groupKey);
      if (row?.type === 'group') onRowMenu(row.group.newest.id, { x: e.clientX, y: e.clientY }, 'pointer', undefined, 'group', row.key);
      return;
    }
    const rowEl = target?.closest<HTMLElement>('[data-entry-id]');
    if (rowEl && el.contains(rowEl)) {
      // Right-click / long-press on a row: that row, at the pointer.
      e.preventDefault();
      el.focus({ preventScroll: true });
      const onBadge = !!target?.closest('.rl-req-row__method');
      onRowMenu(rowEl.dataset.entryId ?? '', { x: e.clientX, y: e.clientY }, 'pointer', undefined, onBadge ? 'method' : 'row');
      return;
    }
    // Keyboard-generated (ContextMenu key; Shift+F10 on some platforms): targets the focused listbox and has no
    // mouse button. A right-click on empty space keeps the browser's own menu.
    if (target !== el || e.button === 2) return;
    e.preventDefault();
    const opened = performance.now() - keyMenuAt.current < KEY_MENU_GRACE_MS;
    keyMenuAt.current = -Infinity;
    if (!opened) openKeyboardMenu();
  };

  const onMenuButton = (id: string, button: HTMLElement) => {
    focusList();
    onRowMenu(id, { rect: rectOf(button), align: 'end' }, 'button', button);
  };
  const onGroupMenuButton = (key: string, button: HTMLElement) => {
    focusList();
    const row = rows.find((r) => r.key === key);
    if (row?.type === 'group') onRowMenu(row.group.newest.id, { rect: rectOf(button), align: 'end' }, 'button', button, 'group', key);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (isMenuKey(e) && !empty) {
      e.preventDefault();
      keyMenuAt.current = performance.now();
      openKeyboardMenu();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const active = activeIndex >= 0 ? rows[activeIndex] : undefined;
    // Tree-like keys on groups: → expands (then moves to the first call), ← collapses / goes up to the group.
    if (e.key === 'ArrowRight' && active?.type === 'group') {
      e.preventDefault();
      if (!active.expanded) onToggleGroup(active.key, true);
      else {
        const next = rows[activeIndex + 1];
        if (next?.type === 'entry' && next.group === active.key) onSelect(next.entry.id, false);
      }
      return;
    }
    if (e.key === 'ArrowLeft' && active && active.type !== 'separator') {
      if (active.type === 'group' && active.expanded) {
        e.preventDefault();
        onToggleGroup(active.key, false);
        return;
      }
      if (active.type === 'entry' && active.group) {
        e.preventDefault();
        onPickGroup(active.group, false);
        return;
      }
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight) - 1);
    let delta: number | 'first' | 'last' | null = null;
    if (e.key === 'ArrowDown') delta = 1;
    else if (e.key === 'ArrowUp') delta = -1;
    else if (e.key === 'PageDown') delta = page;
    else if (e.key === 'PageUp') delta = -page;
    else if (e.key === 'Home') delta = 'first';
    else if (e.key === 'End') delta = 'last';
    else if ((e.key === 'Enter' || e.key === ' ') && selectedId) {
      e.preventDefault();
      if (active?.type === 'group') onPickGroup(active.key, true);
      else onSelect(selectedId, true);
      return;
    }
    if (delta === null) return;
    e.preventDefault();
    const next = moveRowKey(rows, activeKey, delta);
    if (next && next !== activeKey) pickKey(next, false);
    // The effect on the active row reveals it; also reveal when unchanged (e.g. at the ends).
    else if (next) reveal(next);
  };

  const range = virtual
    ? visibleRange(scrollTop, viewportHeight || 800, rowHeight, rows.length)
    : { start: 0, end: rows.length };
  const activeRow = activeIndex >= range.start && activeIndex < range.end ? rows[activeIndex] : undefined;
  const activeDescendant =
    activeRow?.type === 'group' ? groupDomId(activeRow.key) : activeRow?.type === 'entry' ? rowDomId(activeRow.entry.id) : undefined;

  const renderRow = (row: ListRow, index: number) => {
    const style: JSX.CSSProperties | undefined = virtual
      ? { position: 'absolute', top: `${index * rowHeight}px`, left: '0px', right: '0px' }
      : undefined;
    if (row.type === 'separator') return <PreviousPageSeparator key={row.key} pageUrl={row.pageUrl} style={style} />;
    if (row.type === 'group') {
      return (
        <GroupRow
          key={row.key}
          group={row.group}
          groupKey={row.key}
          expanded={row.expanded}
          selected={row.key === activeKey}
          domId={groupDomId(row.key)}
          ordinal={row.ordinal}
          setSize={options}
          style={style}
          budget={budget}
          showHost={hostFlags?.[index] === true}
          menuOpen={row.key === menuKey}
          onPick={pickGroup}
          onToggle={toggleGroup}
          onMenuButton={onGroupMenuButton}
        />
      );
    }
    return (
      <RequestRow
        key={row.key}
        entry={row.entry}
        selected={row.key === activeKey}
        domId={rowDomId(row.entry.id)}
        ordinal={row.ordinal}
        setSize={options}
        style={style}
        onPick={pick}
        hidden={row.hidden}
        menuOpen={row.entry.id === menuKey}
        onMenuButton={onMenuButton}
        budget={budget}
        showHost={hostFlags?.[index] === true}
        urlDisplay={urlDisplay}
        inGroup={row.group !== undefined}
      />
    );
  };

  const visibleRows = rows.slice(range.start, range.end).map((row, i) => renderRow(row, range.start + i));

  return (
    <div
      ref={scrollRef}
      class={`rl-list__scroll rl-scroll${virtual ? ' rl-list__scroll--virtual' : ''}`}
      role={empty ? undefined : 'listbox'}
      aria-label="Requests"
      aria-activedescendant={activeDescendant}
      tabIndex={empty ? undefined : 0}
      aria-keyshortcuts={empty ? undefined : 'Shift+F10'}
      data-testid="rl-request-list"
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {empty ??
        (virtual ? (
          <div class="rl-list__spacer" style={{ height: `${rows.length * rowHeight}px` }}>
            {visibleRows}
          </div>
        ) : (
          visibleRows
        ))}
    </div>
  );
}

/** An element by id inside the list (the panel renders into a shadow root, where document.getElementById misses). */
function findById(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>('[role="option"]')) if (el.id === id) return el;
  return null;
}

/** DOM id of a row; entry ids may contain ':' which is fine in id attributes. */
function rowDomId(entryId: string): string {
  return `rl-row-${entryId}`;
}

/** DOM id of a group row (keys hold spaces: not allowed in ids). */
function groupDomId(key: string): string {
  return `rl-grp-${key.replace(/\s+/g, '_')}`;
}

/** Label of the Types button for a selection. */
function typesLabel(chips: ReadonlySet<KindChipId>): string {
  if (chips.size === 0) return 'All types';
  const labels = TYPE_CHIPS.filter((c) => c.id !== 'all' && chips.has(c.id as KindChipId)).map((c) => c.label);
  return labels.length <= 2 ? labels.join(', ') : `${labels.length} types`;
}

/** "Types" dropdown: Fetch/XHR by default; documents, scripts, styles, images, media, fonts and others on demand. */
function TypesMenu({ chips, onChange }: { chips: ReadonlySet<KindChipId>; onChange(chips: Set<KindChipId>): void }) {
  const toggle = (id: KindChipId) => {
    const next = new Set(chips.size === 0 ? (TYPE_CHIPS.filter((c) => c.id !== 'all').map((c) => c.id) as KindChipId[]) : chips);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size === 0 ? new Set(DEFAULT_CHIPS) : next);
  };
  const changed = !isDefaultChips(chips);
  return (
    <PopoverButton
      title="Filter by request type"
      icon="filter"
      label={typesLabel(chips)}
      align="end"
      testId="rl-types-menu"
      class={`rl-btn rl-btn--sm rl-list__types${changed ? ' rl-list__types--changed' : ''}`}
    >
      {() => (
        <div class="rl-types" role="group" aria-label="Request types">
          {TYPE_CHIPS.filter((c) => c.id !== 'all').map((chip) => (
            <label key={chip.id} class="rl-types__item" data-testid="rl-type-chip" data-type={chip.id}>
              <input
                type="checkbox"
                class="rl-checkbox"
                checked={chips.size === 0 || chips.has(chip.id as KindChipId)}
                onChange={() => toggle(chip.id as KindChipId)}
              />
              <span>{chip.label}</span>
            </label>
          ))}
          <div class="rl-types__actions">
            <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={() => onChange(new Set())}>
              All types
            </button>
            <button
              type="button"
              class="rl-btn rl-btn--sm rl-btn--ghost"
              disabled={!changed}
              onClick={() => onChange(new Set(DEFAULT_CHIPS))}
            >
              Only Fetch/XHR
            </button>
          </div>
        </div>
      )}
    </PopoverButton>
  );
}
