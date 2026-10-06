// WebSocket inspector view (header switch "WebSocket"): connections + channels | messages | message detail.
// Wide: three columns. Medium: sidebar | messages over detail. Narrow: a connection / channel picker above
// messages over detail.
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { WsConnection, WsFrame } from '../../lib/ws';
import type { WsChannelStats } from '../../lib/ws-inspector';
import { filterFrames, parseWsFilter } from '../../lib/ws-inspector';
import { channelLabel } from '../../lib/ws-protocols';
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { memo } from '../components/memo';
import { SplitPane } from '../components/SplitPane';
import { useBridge, useElementSize, useTabState } from '../hooks';
import { isStandaloneShell } from '../shellMode';
import { MessageDetail } from './Detail';
import { indexOfId, wsUrlParts } from './format';
import { useNow, useWsInspector, useWsVersion } from './hooks';
import type { WsListFilter } from './Messages';
import { Messages } from './Messages';
import type { SidebarItem, WsSelection } from './Sidebar';
import { itemSelection, Sidebar, sidebarItems } from './Sidebar';
import { FindScopeContext, onWsRevealRequest, takeWsReveal } from '../find/reveal';

const WIDE_MIN = 980;
const MEDIUM_MIN = 640;
const EMPTY: readonly WsFrame[] = [];

/** Pane sizes, kept while the panel lives. */
const sizes = { side: 260, detail: 0.42, detailStack: 0.45 };

type Layout = 'wide' | 'medium' | 'narrow';

function WsViewImpl({ active }: { active: boolean }) {
  const bridge = useBridge();
  const inspector = useWsInspector();
  useWsVersion(inspector, active);
  const tabState = useTabState();
  const rootRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(rootRef);
  const layout: Layout = width === 0 || width >= WIDE_MIN ? 'wide' : width >= MEDIUM_MIN ? 'medium' : 'narrow';

  const connections = inspector ? inspector.connections() : [];
  const newestFirst = useMemo(() => connections.slice().reverse(), [connections]);
  const anyOpen = connections.some((c) => c.state === 'open' || c.state === 'connecting');
  const now = useNow(active && connections.length > 0 && anyOpen);

  // ---- selection ------------------------------------------------------------------------------------
  const [selection, setSelection] = useState<WsSelection>({ wsId: null, channel: null });
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const conn = selection.wsId ? (inspector?.log.getConnection(selection.wsId) ?? null) : null;

  // Follow the newest connection until the user picks one; drop a selection whose connection is gone.
  const userPicked = useRef(false);
  useEffect(() => {
    const newest = newestFirst[0];
    if (!newest) {
      if (selection.wsId) setSelection({ wsId: null, channel: null });
      return;
    }
    if (!conn || (!userPicked.current && selection.wsId !== newest.wsId)) {
      setSelection({ wsId: newest.wsId, channel: null });
      setCursor(`a\u001f${newest.wsId}`);
    }
  }, [newestFirst, conn]);

  const select = useCallback((next: WsSelection) => {
    userPicked.current = true;
    setSelection((prev) => (prev.wsId === next.wsId && prev.channel === next.channel ? prev : next));
  }, []);
  // Another connection: its own messages (a channel change of the same connection keeps the selected one).
  const shownWsId = useRef(selection.wsId);
  /** A message to select once its connection is shown ("Where does this come from?"). */
  const pendingFrame = useRef<number | null>(null);
  useEffect(() => {
    if (shownWsId.current === selection.wsId) return;
    shownWsId.current = selection.wsId;
    setSelectedFrame(pendingFrame.current);
    pendingFrame.current = null;
    setPausedAt(null);
  }, [selection.wsId]);

  // "Where does this come from?" results: select the message (its payload viewer reveals the JSON path).
  useEffect(() => {
    const take = () => {
      const request = takeWsReveal();
      if (!request) return;
      if (shownWsId.current === request.wsId) setSelectedFrame(request.frameId);
      else pendingFrame.current = request.frameId;
      select({ wsId: request.wsId, channel: null });
    };
    take();
    return onWsRevealRequest(take);
  }, [select]);

  // ---- expansion (open connections and the selected one start expanded) -----------------------------
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());
  const isExpanded = useCallback(
    (c: WsConnection) => toggled.get(c.wsId) ?? (c.wsId === selection.wsId || c.state !== 'closed'),
    [toggled, selection.wsId],
  );
  const onToggle = useCallback(
    (c: WsConnection, expanded?: boolean) =>
      setToggled((prev) => {
        const next = new Map(prev);
        next.set(c.wsId, expanded ?? !isExpanded(c));
        return next;
      }),
    [isExpanded],
  );

  // ---- unread channels: new frames since the channel was last looked at -------------------------------
  const seen = useRef(new Map<string, number>());
  const baseline = useRef<number | null>(null);
  if (baseline.current === null && inspector) {
    let max = 0;
    for (const c of connections) {
      const f = inspector.frames(c.wsId);
      if (f.length) max = Math.max(max, f[f.length - 1]!.id);
    }
    baseline.current = max;
  }
  const isUnread = useCallback(
    (c: WsConnection, s: WsChannelStats) => s.lastId > (seen.current.get(`${c.wsId}\u001f${s.key}`) ?? baseline.current ?? 0),
    [],
  );

  // ---- messages of the selection ------------------------------------------------------------------------
  const [filter, setFilter] = useState<WsListFilter>({ text: '', dir: 'all', heartbeats: false });
  const parsed = useMemo(() => parseWsFilter(filter.text), [filter.text]);
  const allFrames = conn && inspector ? inspector.frames(conn.wsId) : EMPTY;
  const filtered = useMemo(
    () => (inspector ? filterFrames(allFrames, (f) => inspector.info(f), { ...filter, channel: selection.channel }, parsed) : EMPTY),
    [allFrames, filter, selection.channel, parsed, inspector],
  );
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const shown = useMemo(() => {
    if (pausedAt === null) return filtered;
    let end = filtered.length;
    while (end > 0 && filtered[end - 1]!.id > pausedAt) end--;
    return end === filtered.length ? filtered : filtered.slice(0, end);
  }, [filtered, pausedAt]);
  const onPause = useCallback(
    (paused: boolean) => setPausedAt(paused ? (allFrames.length ? allFrames[allFrames.length - 1]!.id : 0) : null),
    [allFrames],
  );

  // The selected channel (or all of a connection) is "seen".
  useEffect(() => {
    if (!inspector || !conn || !active) return;
    for (const s of inspector.channels(conn.wsId)) {
      if (selection.channel === null || selection.channel === s.key) seen.current.set(`${conn.wsId}\u001f${s.key}`, s.lastId);
    }
  });

  const frameIndex = indexOfId(allFrames, selectedFrame);
  const frame = frameIndex >= 0 ? allFrames[frameIndex]! : null;
  const [composeOpen, setComposeOpen] = useState(false);
  const listFocus = useRef<(() => void) | null>(null);

  const clear = useCallback(() => {
    bridge.ws?.clear();
    setSelectedFrame(null);
    setPausedAt(null);
  }, [bridge]);
  const resume = useCallback(() => {
    void bridge.setTabState({ recording: true });
  }, [bridge]);

  const items: SidebarItem[] = inspector ? sidebarItems(inspector, newestFirst, isExpanded) : [];

  // ---- render ------------------------------------------------------------------------------------------
  if (!inspector) {
    return (
      <div ref={rootRef} class="rl-ws" data-testid="rl-ws-view">
        <div class="rl-empty">
          <div class="rl-empty__title">WebSocket inspection is not available</div>
          <div class="rl-empty__text">Reload the page to load the current version of kineReqLens.</div>
        </div>
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div ref={rootRef} class="rl-ws rl-ws--empty" data-testid="rl-ws-view" data-layout={layout}>
        <WsEmpty recording={tabState.recording} onReload={() => bridge.reloadPage()} onResume={resume} />
      </div>
    );
  }

  const sidebar = (
    <Sidebar
      inspector={inspector}
      items={items}
      selection={selection}
      cursor={cursor}
      now={now}
      onCursor={setCursor}
      onSelect={(sel) => {
        select(sel);
        if (layout === 'narrow') listFocus.current?.();
      }}
      onToggle={onToggle}
      isExpanded={isExpanded}
      isUnread={isUnread}
      onClear={clear}
    />
  );

  const messages = conn ? (
    <Messages
      inspector={inspector}
      conn={conn}
      channel={selection.channel}
      frames={shown}
      total={allFrames.length}
      filter={filter}
      parsed={parsed}
      onFilter={setFilter}
      heartbeatCount={inspector.heartbeatCount(conn.wsId)}
      selectedId={selectedFrame}
      onSelect={setSelectedFrame}
      paused={pausedAt !== null}
      pending={filtered.length - shown.length}
      onPause={onPause}
      recording={tabState.recording}
      onResume={resume}
      composeOpen={composeOpen}
      onCompose={setComposeOpen}
      focusRef={listFocus}
    />
  ) : (
    <div class="rl-empty">
      <div class="rl-empty__title">Select a connection</div>
    </div>
  );

  // Find in page scans only while this view is shown.
  const detail = (
    <FindScopeContext.Provider value={active}>
      <MessageDetail inspector={inspector} conn={conn} frame={frame} dropped={selectedFrame !== null && !frame} />
    </FindScopeContext.Provider>
  );

  const stacked = (
    <SplitPane
      direction="column"
      size={sizes.detailStack}
      minA={120}
      minB={140}
      class="rl-ws__stack"
      onSizeChange={(v) => {
        sizes.detailStack = v;
      }}
    >
      {[messages, detail]}
    </SplitPane>
  );

  let body: JSX.Element;
  if (layout === 'wide') {
    body = (
      <SplitPane
        direction="row"
        unit="px"
        size={sizes.side}
        minA={200}
        minB={520}
        class="rl-ws__split"
        onSizeChange={(v) => {
          sizes.side = v;
        }}
      >
        {[
          sidebar,
          <SplitPane
            direction="row"
            size={1 - sizes.detail}
            minA={300}
            minB={280}
            class="rl-ws__split"
            onSizeChange={(v) => {
              sizes.detail = 1 - v;
            }}
          >
            {[messages, detail]}
          </SplitPane>,
        ]}
      </SplitPane>
    );
  } else if (layout === 'medium') {
    body = (
      <SplitPane
        direction="row"
        unit="px"
        size={Math.min(sizes.side, 240)}
        minA={180}
        minB={360}
        class="rl-ws__split"
        onSizeChange={(v) => {
          sizes.side = v;
        }}
      >
        {[sidebar, stacked]}
      </SplitPane>
    );
  } else {
    body = (
      <div class="rl-ws__narrow">
        <NarrowPicker items={items} selection={selection} onSelect={select} onCursor={setCursor} />
        {stacked}
      </div>
    );
  }

  return (
    <div ref={rootRef} class={`rl-ws rl-ws--${layout}`} data-testid="rl-ws-view" data-layout={layout}>
      {body}
    </div>
  );
}

/** The WebSocket view; memoized so the HTTP list's updates do not re-render it. */
export const WsView = memo(WsViewImpl);

/** Narrow layout: one select for connection › channel. */
function NarrowPicker({
  items,
  selection,
  onSelect,
  onCursor,
}: {
  items: SidebarItem[];
  selection: WsSelection;
  onSelect(sel: WsSelection): void;
  onCursor(key: string): void;
}) {
  const options = items.filter((i) => i.type !== 'conn');
  const value = options.find((i) => {
    const s = itemSelection(i);
    return s.wsId === selection.wsId && s.channel === selection.channel;
  });
  return (
    <div class="rl-ws-picker">
      <Icon name="plug" size={14} class="rl-ws-picker__icon" />
      <select
        class="rl-select rl-ws-picker__select"
        aria-label="Connection and channel"
        data-testid="rl-ws-picker"
        value={value?.key ?? ''}
        onChange={(e) => {
          const item = options.find((i) => i.key === e.currentTarget.value);
          if (!item) return;
          onCursor(item.key);
          onSelect(itemSelection(item));
        }}
      >
        {items
          .filter((i) => i.type === 'conn')
          .map((c) => {
            const parts = wsUrlParts(c.conn.url);
            return (
              <optgroup key={c.key} label={`${parts.host}${parts.path === '/' ? '' : parts.path} — ${c.conn.state}`}>
                {options
                  .filter((o) => o.conn === c.conn)
                  .map((o) => (
                    <option key={o.key} value={o.key}>
                      {`${o.type === 'all' ? 'All messages' : channelLabel(o.stats.key)}  —  ${parts.host}${parts.path === '/' ? '' : parts.path}`}
                    </option>
                  ))}
              </optgroup>
            );
          })}
      </select>
    </div>
  );
}

function WsEmpty({ recording, onReload, onResume }: { recording: boolean; onReload(): void; onResume(): void }) {
  return (
    <div class="rl-empty rl-ws-empty" data-testid="rl-ws-empty">
      <span class="rl-ws-empty__art" aria-hidden="true">
        <Icon name="plug" size={26} />
      </span>
      <div class="rl-empty__title">No WebSocket connections on this page yet</div>
      <div class="rl-empty__text">
        {recording
          ? isStandaloneShell()
            ? 'They appear here as soon as the app opens one, with every message sent and received, grouped by channel.'
            : 'They appear here as soon as the page opens one, with every message sent and received, grouped by channel. Reload the page to catch sockets it opens while loading.'
          : 'Recording is paused: new connections and messages are not captured until you resume.'}
      </div>
      <div class="rl-ws-empty__actions">
        {recording ? null : (
          <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" onClick={onResume}>
            <Icon name="record" size={12} />
            Resume recording
          </button>
        )}
        {isStandaloneShell() ? null : (
          <button type="button" class="rl-btn rl-btn--sm" onClick={onReload}>
            <Icon name="reload" size={12} />
            Reload page
          </button>
        )}
      </div>
      <div class="rl-ws-empty__hint rl-faint">
        <BrandMark size={12} /> Socket.IO, Phoenix, Action Cable, STOMP and GraphQL subscriptions are recognised
      </div>
    </div>
  );
}
