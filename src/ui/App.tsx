// OWNER: ui-shell agent. Overlay panel chrome: header, navigation rail, docking / floating window, minimized pill,
// body layout.
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { DockMode, LayoutSettings, RequestEntry, SettingsPatch } from '../shared/types';
import { methodClass, urlParts } from '../lib/format';
import { Icon } from './components/Icon';
import { BrandMark, BrandWordmark } from './components/BrandMark';
import type { IconName } from './components/Icon';
import { MenuButton } from './components/Menu';
import type { MenuItem } from './components/Menu';
import { memo } from './components/memo';
import {
  NARROW_PANEL_W,
  clampDockSize,
  clampPoint,
  defaultPillPosition,
  dockResizeEdge,
  dockSizeForSwitch,
  dockedRect,
  floatPatch,
  moveFloatRect,
  panelRect,
  resizeFloatRect,
  undockRect,
} from './components/panel/geometry';
import type { Point, Rect, ResizeEdge, Viewport } from './components/panel/geometry';
import { isInteractiveTarget, startPointerSession } from './components/panel/pointer';
import { MIN_OPACITY, SettingsForm } from './components/panel/SettingsForm';
import { usePersistentLayout } from './components/panel/usePersistentLayout';
import { SplitPane } from './components/SplitPane';
import { ToastHost, toast } from './components/toast';
import { RequestDetail } from './detail/RequestDetail';
import { entriesWithWork, pruneDrafts, subscribeMeta } from './detail/draftStore';
import { sendEntry } from './detail/sendAction';
import { isSendShortcut } from './detail/util';
import {
  useBridge,
  useDebouncedCallback,
  useElementSize,
  useEntries,
  useResolvedTheme,
  useSettings,
  useTabState,
} from './hooks';
import { RequestList } from './list/RequestList';
import { RAIL_COMPACT_PANEL_W, RAIL_EXPANDED_W, RAIL_W, Rail, pressRailShortcut, railShortcut } from './rail/Rail';
import { LanguageIndicator } from './language/LanguageButton';
import { ScreenshotTool, isShotHost } from './screenshot';
import { useShotControl } from './screenshot/open';
import { useBridgeStatus } from './panel/claudeLink';
import { getShellState, onShellSelectionRequest, setShellSelection } from './shellState';
import { pushRecentDir } from '../shared/pty';
import { TerminalDock, terminalUnavailableReason } from './terminal/TerminalDock';
import { onTerminalStarted, useTerminalPane } from './terminal/session';
import { usePanelView } from './ws/ViewSwitch';
import type { PanelView } from './ws/ViewSwitch';
import { WsView } from './ws/WsView';
import { ErrorsView } from './errors/ErrorsView';
import { FindScopeContext, requestWsReveal } from './find/reveal';
import { useErrorAutomation, useErrorGroups } from './errors/automation';
import { capturingCount, isSeen, shotsTotal, useErrorsStore } from './errors/store';

/** Re-render the (heavy) editor only when its own entry object changes, not on every captured request. */
const MemoDetail = memo(RequestDetail);

const LIST_MIN_W = 240;
const DETAIL_MIN_W = 360;
/** Claude Code terminal pane: minimum heights of the panel content above it and of the pane itself. */
const TERMINAL_ABOVE_MIN_H = 140;
const TERMINAL_MIN_H = 120;
const FLOAT_DRAG_THRESHOLD = 3;
/** Dragging a docked header this far undocks it into a floating window. */
const UNDOCK_THRESHOLD = 12;
const OPACITY_PERSIST_DELAY_MS = 250;
const PRUNE_DELAY_MS = 1000;
const PILL_FALLBACK = { width: 112, height: 30 };

const DOCK_OPTIONS: ReadonlyArray<{ dock: DockMode; label: string; icon: IconName }> = [
  { dock: 'float', label: 'Floating window', icon: 'float' },
  { dock: 'right', label: 'Dock to right', icon: 'dock-right' },
  { dock: 'left', label: 'Dock to left', icon: 'dock-left' },
  { dock: 'bottom', label: 'Dock to bottom', icon: 'dock-bottom' },
];

const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// Where the minimized pill was dragged to (per page lifetime; null = anchored to the panel).
let rememberedPill: Point | null = null;

type Interaction = 'move' | 'resize' | null;

function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, MIN_OPACITY), 1) : 1;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function applyRect(el: HTMLElement | null, r: Rect): void {
  if (!el) return;
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

export interface AppProps {
  /**
   * Full-tab layout (the standalone React Native tab, src/ui/standalone/): no floating window, docking, minimize
   * or close; page-only affordances are hidden through src/ui/shellMode.ts.
   */
  standalone?: boolean;
  /** Extra header content (standalone: the app target picker). */
  headerExtra?: ComponentChildren;
}

/** Root of the overlay UI. */
export function App({ standalone = false, headerExtra }: AppProps = {}) {
  const bridge = useBridge();
  const settings = useSettings();
  const tabState = useTabState();
  const entries = useEntries();
  const theme = useResolvedTheme();

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const measured = useElementSize(rootRef);
  const vp: Viewport = useMemo(
    () => ({
      width: measured.width || window.innerWidth || 1024,
      height: measured.height || window.innerHeight || 768,
    }),
    [measured.width, measured.height],
  );

  const [layout, updateLayout] = usePersistentLayout(bridge, settings.layout);
  const rect: Rect = standalone ? { left: 0, top: 0, width: vp.width, height: vp.height } : panelRect(layout, vp);
  // Navigation rail: labels only when asked for and the panel is wide enough (narrow docks: icons only).
  const compact = rect.width < RAIL_COMPACT_PANEL_W;
  const railExpanded = layout.railExpanded && !compact;
  const railWidth = railExpanded ? RAIL_EXPANDED_W : RAIL_W;
  // List | detail side by side needs the room next to the rail (the threshold counts a collapsed rail as panel).
  const narrow = rect.width - railWidth + RAIL_W < NARROW_PANEL_W;
  const [interaction, setInteraction] = useState<Interaction>(null);

  // Latest values for pointer sessions (handlers outlive the render that created them).
  const live = useRef({ rect, layout, vp });
  live.current = { rect, layout, vp };

  // ---- selection -------------------------------------------------------------------------------
  // (Visibility: the frame host shows / hides the overlay with the tab's open state.)
  const [selectedId, setSelectedId] = useState<string | null>(() => getShellState().selectedId);
  const [narrowView, setNarrowView] = useState<'list' | 'detail'>(() => (getShellState().selectedId ? 'detail' : 'list'));
  // Layout effect: the Claude Code bridge (panel/claudeLink.ts) answers "selected" from the shell state, so it
  // must follow the selection as soon as it is committed (a passive effect lags up to a frame behind).
  useLayoutEffect(() => setShellSelection(selectedId), [selectedId]);
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e] as const)), [entries]);
  const selected = selectedId ? (entryById.get(selectedId) ?? null) : null;
  // A freshly created entry may be selected before the store notifies us; only drop a selection whose
  // entry was seen and then disappeared (cleared / evicted).
  const selectionSeen = useRef(false);

  useEffect(() => {
    if (!selectedId) return;
    if (entryById.has(selectedId)) selectionSeen.current = true;
    else if (selectionSeen.current) {
      selectionSeen.current = false;
      setSelectedId(null);
      setNarrowView('list');
    }
  }, [entryById, selectedId]);

  const select = useCallback(
    (id: string | null, openDetail = false) => {
      selectionSeen.current = id !== null && entryById.has(id);
      setSelectedId(id);
      if (id && openDetail) setNarrowView('detail');
    },
    [entryById],
  );

  const onListSelect = useCallback((id: string, activate: boolean) => select(id, activate), [select]);
  // Stable for the memoized detail pane (select changes with every entries update).
  const selectRef = useRef(select);
  selectRef.current = select;
  const onSelectEntry = useCallback((id: string) => selectRef.current(id, true), []);
  // The Claude Code control plane (src/ui/panel/control.ts) selects a request from outside the App.
  useEffect(
    () =>
      onShellSelectionRequest((id) => {
        selectRef.current(id, true);
        if (!id) setNarrowView('list');
      }),
    [],
  );

  const newRequest = useCallback(() => {
    try {
      const entry = bridge.addManualEntry();
      select(entry.id, true);
    } catch (err) {
      toast(`Could not create a request: ${errorText(err)}`, 'error');
    }
  }, [bridge, select]);

  const clearAll = useCallback(() => {
    try {
      bridge.clearEntries();
    } catch (err) {
      toast(`Could not clear: ${errorText(err)}`, 'error');
      return;
    }
    pruneDrafts(new Set());
    select(null);
    setNarrowView('list');
  }, [bridge, select]);

  // Drop drafts/runs of entries that were evicted (debounced; cheap even with thousands of entries).
  const [schedulePrune] = useDebouncedCallback(() => {
    pruneDrafts(new Set(bridge.getEntries().map((e) => e.id)));
  }, PRUNE_DELAY_MS);
  useEffect(() => schedulePrune(), [entries, schedulePrune]);

  // The selected entry and every entry with an edited draft or test runs are never evicted at maxEntries.
  // (Coalesced in a microtask, not a timer: the store must know before the next capture can evict them.)
  const selectedRefForProtect = useRef<string | null>(selectedId);
  selectedRefForProtect.current = selectedId;
  const protect = useRef({ last: '', queued: false });
  const scheduleProtect = useCallback(() => {
    if (protect.current.queued) return;
    protect.current.queued = true;
    queueMicrotask(() => {
      protect.current.queued = false;
      const ids = entriesWithWork();
      const sel = selectedRefForProtect.current;
      if (sel && !ids.includes(sel)) ids.push(sel);
      const key = ids.join('\n');
      if (key === protect.current.last) return;
      protect.current.last = key;
      bridge.setProtectedEntries(ids);
    });
  }, [bridge]);
  useEffect(() => subscribeMeta(scheduleProtect), [scheduleProtect]);
  useEffect(() => scheduleProtect(), [selectedId, scheduleProtect]);

  // ---- settings --------------------------------------------------------------------------------
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
  const [persistOpacity] = useDebouncedCallback((value: number) => {
    bridge.updateSettings({ opacity: value }).catch((err) => toast(`Could not save: ${errorText(err)}`, 'error'));
  }, OPACITY_PERSIST_DELAY_MS);
  useEffect(() => {
    if (opacityPreview !== null && Math.abs(settings.opacity - opacityPreview) < 0.001) setOpacityPreview(null);
  }, [settings.opacity, opacityPreview]);
  const opacity = clampOpacity(opacityPreview ?? settings.opacity);

  const onOpacityInput = useCallback(
    (value: number) => {
      const v = clampOpacity(value);
      setOpacityPreview(v);
      persistOpacity(v);
    },
    [persistOpacity],
  );

  const changeSettings = useCallback(
    (patch: SettingsPatch) => {
      bridge.updateSettings(patch).catch((err) => toast(`Could not save settings: ${errorText(err)}`, 'error'));
    },
    [bridge],
  );

  // ---- Claude Code terminal pane ------------------------------------------------------------------
  const [storedView, setView] = usePanelView();
  // The screenshot tool needs the overlay's page connection (not the standalone tab's bridge).
  const shotAvailable = isShotHost(bridge);
  // The MCP screenshot / find commands (src/ui/control/shot.ts) and the response viewer's camera button use it too.
  useShotControl(bridge);
  const view: PanelView = storedView === 'shot' && !shotAvailable ? 'http' : storedView;
  const wsMounted = useRef(false);
  const shotMounted = useRef(false);
  const errorsMounted = useRef(false);
  // Errors view: failing endpoints of this page, the rail's badge / "new" dot, auto capture / analysis.
  useErrorsStore();
  const errorGroups = useErrorGroups(entries);
  useErrorAutomation({ bridge, entries, groups: errorGroups, settings, visible: tabState.open && !(standalone ? false : layout.minimized) });
  const errorsNew = view !== 'errors' && errorGroups.some((g) => !isSeen(g.key));
  /** The view the screenshot tool's close button returns to. */
  const lastDataView = useRef<PanelView>(view === 'shot' ? 'http' : view);
  if (view !== 'shot') lastDataView.current = view;
  const [terminalOpen, setTerminalOpen] = useTerminalPane();
  // Mounted on first open, then kept (hidden) so sessions and scrollback survive toggling.
  const terminalMounted = useRef(false);
  if (terminalOpen) terminalMounted.current = true;
  const bridgeStatus = useBridgeStatus();
  const terminalReason = terminalUnavailableReason(bridgeStatus);
  const recentDirsRef = useRef(settings.claudeRecentDirs);
  recentDirsRef.current = settings.claudeRecentDirs;
  useEffect(() => {
    onTerminalStarted((dir) => {
      const next = pushRecentDir(recentDirsRef.current, dir);
      if (next.join('\n') === recentDirsRef.current.join('\n')) return;
      recentDirsRef.current = next;
      changeSettings({ claudeRecentDirs: next });
    });
    return () => onTerminalStarted(null);
  }, [changeSettings]);

  // ---- minimized pill geometry -------------------------------------------------------------------
  const pillMeasured = useElementSize(pillRef);
  const pillSize = {
    width: pillMeasured.width || PILL_FALLBACK.width,
    height: pillMeasured.height || PILL_FALLBACK.height,
  };
  const [pillPos, setPillPos] = useState<Point | null>(rememberedPill);
  const pillAt = clampPoint(pillPos ?? defaultPillPosition(layout.dock, rect, pillSize, vp), pillSize, vp);
  // ---- layout actions --------------------------------------------------------------------------
  const setDock = useCallback(
    (dock: DockMode) => {
      const current = live.current.layout;
      if (dock === current.dock) return;
      const patch: Partial<LayoutSettings> = { dock };
      if (dock !== 'float') patch.dockSize = dockSizeForSwitch(dock, current.dockSize, live.current.vp);
      updateLayout(patch);
    },
    [updateLayout],
  );

  const setMinimized = useCallback(
    (minimized: boolean) => {
      updateLayout({ minimized });
      // Keep keyboard focus with the overlay: the pill after minimizing, the header after restoring.
      requestAnimationFrame(() => {
        const target = minimized
          ? pillRef.current
          : panelRef.current?.querySelector<HTMLElement>('[data-testid="rl-minimize"]');
        target?.focus({ preventScroll: true });
      });
    },
    [updateLayout],
  );

  const closeOverlay = useCallback(() => {
    bridge.setTabState({ open: false }).catch((err) => toast(`Could not close: ${errorText(err)}`, 'error'));
  }, [bridge]);

  const resetLayout = useCallback(() => {
    rememberedPill = null;
    setPillPos(null);
    updateLayout({ ...DEFAULT_SETTINGS.layout });
  }, [updateLayout]);

  // ---- move (header drag) ------------------------------------------------------------------------
  const onHeaderPointerDown = (e: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (standalone || e.button !== 0 || isInteractiveTarget(e, e.currentTarget)) return;
    e.preventDefault(); // no text selection while dragging
    const header = e.currentTarget;
    let start = live.current.rect;
    let origin = { x: e.clientX, y: e.clientY };
    let current: Rect | null = null;
    const grabY = Math.min(Math.max(e.clientY - start.top, 6), 28);
    const docked = live.current.layout.dock !== 'float';

    startPointerSession(e, header, {
      threshold: docked ? UNDOCK_THRESHOLD : FLOAT_DRAG_THRESHOLD,
      onStart: () => setInteraction('move'),
      onMove: (_dx, _dy, ev) => {
        const { layout: l, vp: v } = live.current;
        if (l.dock !== 'float' && !current) {
          current = undockRect(l, v, { x: ev.clientX, y: ev.clientY }, grabY);
          start = current;
          origin = { x: ev.clientX, y: ev.clientY };
          updateLayout({ dock: 'float', ...floatPatch(current) });
          return;
        }
        current = moveFloatRect(start, ev.clientX - origin.x, ev.clientY - origin.y, v);
        applyRect(panelRef.current, current);
      },
      onEnd: (moved) => {
        setInteraction(null);
        if (moved && current) updateLayout(floatPatch(current));
      },
    });
  };

  // ---- resize (edges / corners) ------------------------------------------------------------------
  const onResizePointerDown = (edge: ResizeEdge, e: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { rect: start, layout: l } = live.current;
    let current: Rect | null = null;
    let dockSize: number | null = null;

    startPointerSession(e, e.currentTarget, {
      onStart: () => setInteraction('resize'),
      onMove: (dx, dy) => {
        const v = live.current.vp;
        if (l.dock === 'float') {
          current = resizeFloatRect(start, edge, dx, dy, v);
        } else {
          const base = l.dock === 'bottom' ? start.height : start.width;
          const delta = l.dock === 'right' ? -dx : l.dock === 'left' ? dx : -dy;
          dockSize = clampDockSize(l.dock, base + delta, v);
          current = dockedRect(l.dock, dockSize, v);
        }
        applyRect(panelRef.current, current);
      },
      onEnd: (moved) => {
        setInteraction(null);
        if (!moved || !current) return;
        if (l.dock === 'float') updateLayout(floatPatch(current));
        else if (dockSize !== null) updateLayout({ dockSize });
      },
    });
  };

  // ---- keyboard resize (arrow keys on the focusable resize handle) ------------------------------------
  const onResizeKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const { rect: r, layout: l, vp: v } = live.current;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault();
    if (l.dock === 'float') {
      updateLayout(floatPatch(resizeFloatRect(r, 'se', dx, dy, v)));
      return;
    }
    const base = l.dock === 'bottom' ? r.height : r.width;
    const delta = l.dock === 'right' ? -dx : l.dock === 'left' ? dx : -dy;
    if (delta !== 0) updateLayout({ dockSize: clampDockSize(l.dock, base + delta, v) });
  };

  // ---- minimized pill ----------------------------------------------------------------------------
  const pillDragged = useRef(false);

  const onPillPointerDown = (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const start = pillAt;
    const size = pillSize;
    let current: Point | null = null;
    pillDragged.current = false;
    startPointerSession(e, el, {
      threshold: 4,
      onStart: () => {
        pillDragged.current = true;
      },
      onMove: (dx, dy) => {
        current = clampPoint({ left: start.left + dx, top: start.top + dy }, size, live.current.vp);
        el.style.left = `${current.left}px`;
        el.style.top = `${current.top}px`;
      },
      onEnd: (moved) => {
        if (moved && current) {
          rememberedPill = current;
          setPillPos(current);
        }
      },
    });
  };

  const onPillClick = () => {
    // A drag ends with a click event on the same button; only a real click restores.
    if (pillDragged.current) {
      pillDragged.current = false;
      return;
    }
    setMinimized(false);
  };

  // ---- Ctrl/Cmd+Enter anywhere in the panel sends the selected request -------------------------------
  // (The editor handles it itself while focus is inside it.)
  const onPanelKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || !isSendShortcut(e) || !selected || view !== 'http') return;
    e.preventDefault();
    sendEntry(bridge, selected, settings);
  };

  // ---- Alt+1..7 press the navigation rail's items ---------------------------------------------------
  // On the window: the frame (or the standalone tab) is all ours, and the focus may be on its body after a popover
  // or view closed. Only while the panel is shown (pressRailShortcut skips hidden items).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const n = railShortcut(e);
      if (n !== null && pressRailShortcut(panelRef.current, n)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- render ----------------------------------------------------------------------------------
  const visible = tabState.open;
  const minimized = !standalone && layout.minimized;
  const recording = tabState.recording;
  const count = entries.length;
  // Top-level view (HTTP | WebSocket | Screenshot). The WebSocket and Screenshot views mount on first use and then
  // stay (hidden) mounted: the inspector keeps its selection, a capture in progress keeps running.
  if (view === 'ws') wsMounted.current = true;
  if (view === 'shot') shotMounted.current = true;
  if (view === 'errors') errorsMounted.current = true;

  const dockItems: MenuItem[] = DOCK_OPTIONS.map((o) => ({
    label: o.label,
    icon: o.icon,
    checked: layout.dock === o.dock,
    testId: `rl-dock-${o.dock}`,
    onSelect: () => setDock(o.dock),
  }));
  const dockIcon = DOCK_OPTIONS.find((o) => o.dock === layout.dock)?.icon ?? 'float';

  const panelClasses = [
    'rl-panel',
    standalone ? 'rl-panel--standalone' : `rl-panel--${layout.dock === 'float' ? 'float' : `dock-${layout.dock}`}`,
    narrow ? 'rl-panel--narrow' : '',
    compact ? 'rl-panel--compact' : '',
    interaction ? `rl-panel--${interaction === 'move' ? 'dragging' : 'resizing'}` : '',
    !visible || minimized ? 'rl-panel--hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // "Where does this come from?" matched a WebSocket message: open it in the WebSocket view.
  const showWsFrame = (wsId: string, frameId: number, path: Array<string | number> | null) => {
    requestWsReveal({ wsId, frameId }, path ?? []);
    setView('ws');
  };
  const listEl = (
    <RequestList
      entries={entries}
      selectedId={selectedId}
      onSelect={onListSelect}
      onNewRequest={newRequest}
      onClear={clearAll}
      onShowWsFrame={showWsFrame}
    />
  );
  const detailEl = selected ? (
    <MemoDetail key={selected.id} bridge={bridge} entry={selected} onSelectEntry={onSelectEntry} />
  ) : (
    <DetailEmpty hasEntries={count > 0} onNewRequest={newRequest} />
  );

  let body: JSX.Element;
  if (!narrow) {
    body = (
      <SplitPane
        direction="row"
        unit="px"
        size={layout.listWidth}
        minA={LIST_MIN_W}
        minB={DETAIL_MIN_W}
        class="rl-panel__split"
        onSizeChange={(listWidth) => updateLayout({ listWidth })}
      >
        {[listEl, <div class="rl-detail-host">{detailEl}</div>]}
      </SplitPane>
    );
  } else if (narrowView === 'detail' && selected) {
    body = (
      <div class="rl-narrow">
        <NarrowBar entry={selected} onBack={() => setNarrowView('list')} />
        <div class="rl-detail-host">{detailEl}</div>
      </div>
    );
  } else {
    body = <div class="rl-narrow">{listEl}</div>;
  }

  const panelStyle: JSX.CSSProperties = {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: String(opacity),
  };

  const resizeEdges = standalone ? [] : layout.dock === 'float' ? RESIZE_EDGES : [dockResizeEdge(layout.dock)];
  /** The edge that can also be moved with the keyboard: the dock's inner edge, or the window's corner. */
  const keyboardEdge: ResizeEdge = layout.dock === 'float' ? 'se' : dockResizeEdge(layout.dock);

  return (
    <div ref={rootRef} class="rl-root" data-theme={theme}>
      <section
        ref={panelRef}
        class={panelClasses}
        style={panelStyle}
        role="region"
        aria-label="kineReqLens"
        data-testid="rl-panel"
        data-dock={layout.dock}
        onKeyDown={onPanelKeyDown}
      >
        <header class="rl-header" data-testid="rl-header" onPointerDown={onHeaderPointerDown}>
          <div class="rl-header__brand">
            <BrandMark size={18} class="rl-header__logo" />
            <BrandWordmark class="rl-header__title" />
          </div>
          {headerExtra}
          <span class={`rl-rec${recording ? ' rl-rec--on' : ''}`} role="status">
            {recording ? <span class="rl-rec__dot" aria-hidden="true" /> : <Icon name="pause" size={10} />}
            <span class="rl-rec__label">{recording ? 'Recording' : 'Paused'}</span>
          </span>
          {standalone ? null : <LanguageIndicator />}
          <span class="rl-spacer" />
          <div class="rl-header__actions">
            {standalone ? null : <MenuButton title="Dock position" icon={dockIcon} items={dockItems} align="end" testId="rl-dock-menu" />}
            {standalone ? null : (
              <>
                <button
                  type="button"
                  class="rl-icon-btn"
                  title="Minimize"
                  aria-label="Minimize"
                  data-testid="rl-minimize"
                  onClick={() => setMinimized(true)}
                >
                  <Icon name="minimize" size={15} />
                </button>
                <button
                  type="button"
                  class="rl-icon-btn rl-header__close"
                  title="Close (Alt+Shift+L)"
                  aria-label="Close kineReqLens"
                  data-testid="rl-close"
                  onClick={closeOverlay}
                >
                  <Icon name="close" size={15} />
                </button>
              </>
            )}
          </div>
        </header>

        <div class="rl-panel__frame">
          <Rail
            view={view}
            onView={setView}
            httpCount={count}
            errorsCount={errorGroups.length}
            errorsNew={errorsNew}
            errorsShots={shotsTotal()}
            errorsCapturing={capturingCount()}
            expanded={railExpanded}
            canExpand={!compact}
            onToggleExpanded={() => updateLayout({ railExpanded: !layout.railExpanded })}
            screenshot={shotAvailable}
            language={!standalone}
            terminalOpen={terminalOpen}
            terminalReason={terminalReason}
            onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
            theme={settings.theme}
            onTheme={(next) => changeSettings({ theme: next })}
            settings={() => (
              <SettingsForm
                settings={settings}
                opacity={opacity}
                onOpacityInput={onOpacityInput}
                onChange={changeSettings}
                onResetLayout={resetLayout}
                version={bridge.version}
              />
            )}
          />
          <div class="rl-panel__body">
            <SplitPane
              direction="column"
              unit="px"
              fixed="b"
              size={layout.terminalHeight}
              minA={TERMINAL_ABOVE_MIN_H}
              minB={TERMINAL_MIN_H}
              collapsed={!terminalOpen}
              class="rl-panel__terminal-split"
              testId="rl-claude-terminal-split"
              onSizeChange={(terminalHeight) => updateLayout({ terminalHeight })}
            >
              {[
                <div class="rl-panel__main">
                  <div class="rl-view-host" hidden={view !== 'http'}>
                    {/* Find in page scans only for response viewers that are shown. */}
                    <FindScopeContext.Provider value={view === 'http' && visible && !minimized}>{body}</FindScopeContext.Provider>
                  </div>
                  {wsMounted.current ? (
                    <div class="rl-view-host" hidden={view !== 'ws'}>
                      <WsView active={view === 'ws' && visible && !minimized} />
                    </div>
                  ) : null}
                  {errorsMounted.current ? (
                    <div class="rl-view-host" hidden={view !== 'errors'}>
                      <ErrorsView
                        bridge={bridge}
                        entries={entries}
                        groups={errorGroups}
                        settings={settings}
                        onChange={changeSettings}
                        active={view === 'errors' && visible && !minimized}
                        onShowRequest={(id) => {
                          setView('http');
                          select(id, true);
                        }}
                      />
                    </div>
                  ) : null}
                  {shotMounted.current && shotAvailable ? (
                    <div class="rl-view-host" hidden={view !== 'shot'} data-testid="rl-shot-view">
                      <ScreenshotTool onClose={() => setView(lastDataView.current)} />
                    </div>
                  ) : null}
                </div>,
                terminalMounted.current ? (
                  <TerminalDock theme={theme} recentDirs={settings.claudeRecentDirs} onHide={() => setTerminalOpen(false)} />
                ) : null,
              ]}
            </SplitPane>
          </div>
        </div>

        {resizeEdges.map((edge) =>
          edge === keyboardEdge ? (
            <div
              key={edge}
              class={`rl-resize rl-resize--${edge}`}
              role="separator"
              tabIndex={0}
              aria-label={layout.dock === 'float' ? 'Resize the kineReqLens window (arrow keys)' : 'Resize the kineReqLens panel (arrow keys)'}
              aria-orientation={layout.dock === 'bottom' ? 'horizontal' : 'vertical'}
              aria-valuenow={layout.dock === 'bottom' ? rect.height : rect.width}
              aria-valuemin={0}
              aria-valuemax={layout.dock === 'bottom' ? vp.height : vp.width}
              data-testid="rl-resize-handle"
              onKeyDown={onResizeKeyDown}
              onPointerDown={(e) => onResizePointerDown(edge, e)}
            />
          ) : (
            <div
              key={edge}
              class={`rl-resize rl-resize--${edge}`}
              aria-hidden="true"
              onPointerDown={(e) => onResizePointerDown(edge, e)}
            />
          ),
        )}

        {visible && !minimized ? <ToastHost /> : null}
      </section>

      {visible && minimized ? (
        <>
          <button
            ref={pillRef}
            type="button"
            class={`rl-pill-btn${recording ? ' rl-pill-btn--recording' : ''}`}
            style={{ left: `${pillAt.left}px`, top: `${pillAt.top}px` }}
            title="Restore kineReqLens"
            aria-label={`Restore kineReqLens — ${count} request${count === 1 ? '' : 's'}${recording ? ', recording' : ', paused'}`}
            data-testid="rl-pill"
            onPointerDown={onPillPointerDown}
            onClick={onPillClick}
          >
            <BrandMark size={16} class="rl-pill-btn__logo" />
            <span class="rl-pill-btn__count">{count}</span>
            {recording ? <span class="rl-pill-btn__dot" aria-hidden="true" /> : <Icon name="pause" size={10} />}
          </button>
          <div class="rl-toasts-anchor">
            <ToastHost />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Detail pane placeholder when nothing is selected. */
function DetailEmpty({ hasEntries, onNewRequest }: { hasEntries: boolean; onNewRequest(): void }) {
  return (
    <div class="rl-empty rl-detail-empty">
      <span class="rl-detail-empty__art" aria-hidden="true">
        <BrandMark size={30} />
      </span>
      <div class="rl-empty__title">{hasEntries ? 'Select a request' : 'Nothing selected yet'}</div>
      <div class="rl-empty__text">
        Pick a request to edit its query params, headers and body fields, then send it and inspect the
        response side by side.
      </div>
      <div class="rl-detail-empty__keys rl-faint">
        <span class="rl-kbd">↑</span>
        <span class="rl-kbd">↓</span>
        <span>browse the list</span>
        <span class="rl-kbd">Ctrl</span>+<span class="rl-kbd">Enter</span>
        <span>send</span>
      </div>
      <button type="button" class="rl-btn rl-btn--sm" onClick={onNewRequest}>
        <Icon name="plus" size={12} />
        New request
      </button>
    </div>
  );
}

/** Narrow-layout bar above the detail: back to the list + what is selected. */
function NarrowBar({ entry, onBack }: { entry: RequestEntry; onBack(): void }) {
  const parts = useMemo(() => urlParts(entry.url), [entry.url]);
  return (
    <div class="rl-narrow-bar">
      <button type="button" class="rl-btn rl-btn--ghost rl-btn--sm" data-testid="rl-back" onClick={onBack} title="Back to the request list">
        <Icon name="chevron-right" size={13} class="rl-icon--flip" />
        Requests
      </button>
      <span class={`rl-badge rl-badge--${methodClass(entry.method)}`}>{entry.method}</span>
      <span class="rl-narrow-bar__name rl-mono rl-truncate" title={entry.url}>
        {parts.name}
        {parts.query ? <span class="rl-faint">?{parts.query}</span> : null}
      </span>
    </div>
  );
}
