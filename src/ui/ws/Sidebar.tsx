// WebSocket inspector, pane 1: connections (newest first) expandable to their detected channels.
// A keyboard-operable tree: ↑/↓ move (and select), ←/→ collapse / expand, Home/End.
import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { WsConnection } from '../../lib/ws';
import { connectionDuration } from '../../lib/ws';
import type { WsChannelStats, WsInspector } from '../../lib/ws-inspector';
import { channelLabel, DEFAULT_CHANNEL, HEARTBEAT_CHANNEL, WS_KIND_LABEL } from '../../lib/ws-protocols';
import { Icon } from '../components/Icon';
import { ago, count, shortDuration, stateLabel, stateTone, wsUrlParts } from './format';

/** What the messages pane shows: a connection and one of its channels (null = all messages). */
export interface WsSelection {
  wsId: string | null;
  channel: string | null;
}

export type SidebarItem =
  | { key: string; type: 'conn'; conn: WsConnection }
  | { key: string; type: 'all'; conn: WsConnection }
  | { key: string; type: 'channel'; conn: WsConnection; stats: WsChannelStats };

/** Channels worth listing: a raw connection's single default channel is the same as "All messages". */
export function visibleChannels(list: WsChannelStats[]): WsChannelStats[] {
  const regular = list.filter((c) => !c.heartbeat);
  if (regular.length === 1 && regular[0]!.key === DEFAULT_CHANNEL) return list.filter((c) => c.heartbeat);
  return list;
}

/** Items of the tree in display order. */
export function sidebarItems(
  inspector: WsInspector,
  connections: readonly WsConnection[],
  isExpanded: (conn: WsConnection) => boolean,
): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const conn of connections) {
    items.push({ key: `c\u001f${conn.wsId}`, type: 'conn', conn });
    if (!isExpanded(conn)) continue;
    items.push({ key: `a\u001f${conn.wsId}`, type: 'all', conn });
    for (const stats of visibleChannels(inspector.channels(conn.wsId))) {
      items.push({ key: `h\u001f${conn.wsId}\u001f${stats.key}`, type: 'channel', conn, stats });
    }
  }
  return items;
}

/** The selection an item stands for. */
export function itemSelection(item: SidebarItem): WsSelection {
  return { wsId: item.conn.wsId, channel: item.type === 'channel' ? item.stats.key : null };
}

const LIVE_MS = 2500;

export interface SidebarProps {
  inspector: WsInspector;
  items: SidebarItem[];
  selection: WsSelection;
  /** Keyboard cursor (item key); follows the selection. */
  cursor: string | null;
  now: number;
  onCursor(key: string): void;
  onSelect(selection: WsSelection): void;
  onToggle(conn: WsConnection, expanded?: boolean): void;
  isExpanded(conn: WsConnection): boolean;
  isUnread(conn: WsConnection, stats: WsChannelStats): boolean;
  onClear(): void;
}

export function Sidebar(props: SidebarProps) {
  const { inspector, items, selection, cursor, now, onCursor, onSelect, onToggle, isExpanded, isUnread } = props;
  const treeRef = useRef<HTMLDivElement>(null);
  const connections = items.filter((i) => i.type === 'conn').length;

  const cursorIndex = Math.max(
    0,
    items.findIndex((i) => i.key === cursor),
  );

  useLayoutEffect(() => {
    if (!cursor) return;
    treeRef.current?.querySelector<HTMLElement>(`#${domId(cursor)}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const activate = (item: SidebarItem) => {
    onCursor(item.key);
    onSelect(itemSelection(item));
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (!items.length) return;
    const item = items[cursorIndex]!;
    let next: SidebarItem | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = items[Math.min(items.length - 1, cursorIndex + 1)];
        break;
      case 'ArrowUp':
        next = items[Math.max(0, cursorIndex - 1)];
        break;
      case 'Home':
        next = items[0];
        break;
      case 'End':
        next = items[items.length - 1];
        break;
      case 'ArrowRight':
        if (item.type === 'conn' && !isExpanded(item.conn)) onToggle(item.conn, true);
        else if (item.type === 'conn') next = items[cursorIndex + 1];
        break;
      case 'ArrowLeft':
        if (item.type === 'conn' && isExpanded(item.conn)) onToggle(item.conn, false);
        else if (item.type !== 'conn') next = items.find((i) => i.type === 'conn' && i.conn === item.conn);
        break;
      case 'Enter':
      case ' ':
        if (item.type === 'conn') onToggle(item.conn);
        else activate(item);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next) activate(next);
  };

  return (
    <aside class="rl-ws-side" data-testid="rl-ws-sidebar" aria-label="WebSocket connections">
      <div class="rl-ws-side__head">
        <span class="rl-ws-side__title">Connections</span>
        <span class="rl-ws-side__count">{connections}</span>
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm"
          title="Clear messages (closed connections are removed)"
          aria-label="Clear WebSocket messages"
          data-testid="rl-ws-clear"
          onClick={props.onClear}
        >
          <Icon name="clear" size={14} />
        </button>
      </div>
      <div
        ref={treeRef}
        class="rl-ws-tree rl-scroll"
        role="tree"
        tabIndex={0}
        aria-label="Connections and channels"
        aria-activedescendant={items[cursorIndex] ? domId(items[cursorIndex]!.key) : undefined}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const focused = item.key === cursor;
          if (item.type === 'conn') {
            const conn = item.conn;
            const parts = wsUrlParts(conn.url);
            const kind = inspector.protocolOf(conn.wsId);
            const expanded = isExpanded(conn);
            const current = selection.wsId === conn.wsId;
            const total = conn.sent + conn.received;
            return (
              <div
                key={item.key}
                id={domId(item.key)}
                role="treeitem"
                aria-expanded={expanded ? 'true' : 'false'}
                aria-selected={current && selection.channel === null && !expanded ? 'true' : 'false'}
                aria-level={1}
                class={`rl-ws-conn${current ? ' rl-ws-conn--current' : ''}${focused ? ' rl-ws-item--cursor' : ''}`}
                data-testid="rl-ws-connection"
                data-ws-id={conn.wsId}
                data-state={conn.state}
                data-protocol={kind ?? ''}
                data-url={conn.url}
                title={`${conn.url}\n${stateLabel(conn)}${conn.protocol ? `\nSub-protocol: ${conn.protocol}` : ''}${conn.frameUrl ? `\nFrame: ${conn.frameUrl}` : ''}`}
                onClick={() => activate(item)}
              >
                <button
                  type="button"
                  class="rl-ws-conn__twisty"
                  tabIndex={-1}
                  aria-label={expanded ? 'Collapse channels' : 'Expand channels'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCursor(item.key);
                    onToggle(conn);
                  }}
                >
                  <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                </button>
                <span class={`rl-ws-dot rl-ws-dot--${stateTone(conn)}`} aria-label={stateLabel(conn)} role="img" />
                <span class="rl-ws-conn__main">
                  <span class="rl-ws-conn__url">
                    <span class="rl-ws-conn__host">{parts.host}</span>
                    <span class="rl-ws-conn__path">{parts.path === '/' ? '' : parts.path}</span>
                  </span>
                  <span class="rl-ws-conn__meta">
                    {kind && kind !== 'raw' ? <span class={`rl-ws-proto rl-ws-proto--${kind}`}>{WS_KIND_LABEL[kind]}</span> : null}
                    <span class="rl-ws-conn__msgs">
                      {count(total)} msg{total === 1 ? '' : 's'}
                    </span>
                    <span class="rl-ws-conn__sep" aria-hidden="true">
                      ·
                    </span>
                    <span class="rl-ws-conn__dur" title={conn.state === 'closed' ? stateLabel(conn) : 'Open for'}>
                      {conn.state === 'connecting' ? 'connecting…' : shortDuration(connectionDuration(conn, now))}
                    </span>
                    {conn.frameId !== 0 ? <span class="rl-ws-conn__frame">iframe</span> : null}
                  </span>
                </span>
              </div>
            );
          }
          const conn = item.conn;
          const selected = selection.wsId === conn.wsId && selection.channel === (item.type === 'channel' ? item.stats.key : null);
          if (item.type === 'all') {
            return (
              <div
                key={item.key}
                id={domId(item.key)}
                role="treeitem"
                aria-level={2}
                aria-selected={selected ? 'true' : 'false'}
                class={`rl-ws-ch rl-ws-ch--all${selected ? ' rl-ws-ch--selected' : ''}${focused ? ' rl-ws-item--cursor' : ''}`}
                data-testid="rl-ws-all"
                data-ws-id={conn.wsId}
                onClick={() => activate(item)}
              >
                <Icon name="layers" size={12} class="rl-ws-ch__icon" />
                <span class="rl-ws-ch__name">All messages</span>
                <span class="rl-ws-ch__counts">
                  <span class="rl-ws-ch__out" title="Sent">
                    ↑{count(conn.sent)}
                  </span>
                  <span class="rl-ws-ch__in" title="Received">
                    ↓{count(conn.received)}
                  </span>
                </span>
              </div>
            );
          }
          const s = item.stats;
          const live = now - s.lastTime < LIVE_MS;
          const unread = !selected && isUnread(conn, s);
          return (
            <div
              key={item.key}
              id={domId(item.key)}
              role="treeitem"
              aria-level={2}
              aria-selected={selected ? 'true' : 'false'}
              class={`rl-ws-ch${selected ? ' rl-ws-ch--selected' : ''}${focused ? ' rl-ws-item--cursor' : ''}${unread ? ' rl-ws-ch--unread' : ''}${
                s.heartbeat ? ' rl-ws-ch--hb' : ''
              }`}
              data-testid="rl-ws-channel"
              data-ws-id={conn.wsId}
              data-channel={s.key === HEARTBEAT_CHANNEL ? 'heartbeats' : s.key}
              data-unread={unread ? 'true' : 'false'}
              title={`${channelLabel(s.key)} — ${s.sent} sent, ${s.received} received`}
              onClick={() => activate(item)}
            >
              <span class={`rl-ws-ch__live${live ? ' rl-ws-ch__live--on' : ''}`} aria-hidden="true" />
              <span class="rl-ws-ch__name">{channelLabel(s.key)}</span>
              <span class="rl-ws-ch__counts">
                {s.sent ? (
                  <span class="rl-ws-ch__out" title="Sent">
                    ↑{count(s.sent)}
                  </span>
                ) : null}
                {s.received ? (
                  <span class="rl-ws-ch__in" title="Received">
                    ↓{count(s.received)}
                  </span>
                ) : null}
              </span>
              <span class="rl-ws-ch__ago" title="Last activity">
                {ago(now - s.lastTime)}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function domId(key: string): string {
  // Stable, attribute-safe id per item.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return `rl-ws-i${(h >>> 0).toString(36)}`;
}
