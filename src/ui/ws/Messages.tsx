// WebSocket inspector, pane 2: the selected channel's messages — toolbar (filter, direction, heartbeats,
// pause), a virtualized timeline that sticks to the newest message, and the optional composer.
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WsConnection, WsFrame } from '../../lib/ws';
import type { ParsedWsFilter, WsDirFilter, WsInspector } from '../../lib/ws-inspector';
import { framePreview } from '../../lib/ws-inspector';
import { channelLabel, DEFAULT_CHANNEL, HEARTBEAT_CHANNEL, WS_KIND_LABEL } from '../../lib/ws-protocols';
import { formatBytes, formatClock } from '../../lib/format';
import { Icon } from '../components/Icon';
import { useElementSize } from '../hooks';
import { scrollTopToReveal, visibleRange } from '../list/virtual';
import { Composer } from './Composer';
import { count, indexOfId, relTime, stateLabel, stateTone, wsUrlParts } from './format';

export const WS_ROW_H = 28;
/** Within this many px of the bottom the list keeps following new messages. */
const STICK_PX = WS_ROW_H / 2;

export interface WsListFilter {
  text: string;
  dir: WsDirFilter;
  heartbeats: boolean;
}

export interface MessagesProps {
  inspector: WsInspector;
  conn: WsConnection;
  /** null = all messages of the connection. */
  channel: string | null;
  frames: readonly WsFrame[];
  /** Frames of the connection before filtering (for the count line). */
  total: number;
  filter: WsListFilter;
  parsed: ParsedWsFilter;
  onFilter(filter: WsListFilter): void;
  heartbeatCount: number;
  selectedId: number | null;
  onSelect(id: number): void;
  paused: boolean;
  /** Messages that arrived (and match) while paused. */
  pending: number;
  onPause(paused: boolean): void;
  recording: boolean;
  onResume(): void;
  composeOpen: boolean;
  onCompose(open: boolean): void;
  /** Receives a function focusing the list (the filter's ArrowDown, the sidebar's Enter). */
  focusRef: { current: (() => void) | null };
}

const DIRS: ReadonlyArray<{ id: WsDirFilter; label: string; title: string }> = [
  { id: 'all', label: 'All', title: 'Sent and received' },
  { id: 'out', label: '↑ Sent', title: 'Only messages the page sent' },
  { id: 'in', label: '↓ Received', title: 'Only messages the page received' },
];

export function Messages(props: MessagesProps) {
  const { inspector, conn, channel, frames, filter, parsed, onFilter, selectedId, onSelect, paused, focusRef } = props;
  const filterRef = useRef<HTMLInputElement>(null);
  const onFilterKey = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && filter.text) {
      e.preventDefault();
      onFilter({ ...filter, text: '' });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const last = frames[frames.length - 1];
      if (selectedId === null && last) onSelect(last.id);
      focusRef.current?.();
    }
  };
  const parts = wsUrlParts(conn.url);
  const kind = inspector.protocolOf(conn.wsId);
  const channelName = channel === null ? 'All messages' : channelLabel(channel);
  const filtering = parsed.type === 'text' || parsed.type === 'path' || filter.dir !== 'all';
  const canSend = conn.state === 'open' && conn.frameId === 0;

  return (
    <section class="rl-ws-msgs" data-testid="rl-ws-messages-pane" aria-label="Messages">
      <div class="rl-ws-toolbar">
        <div class={`rl-search rl-ws-toolbar__search${parsed.type === 'invalid' ? ' rl-ws-toolbar__search--invalid' : ''}`}>
          <Icon name="filter" size={13} class="rl-search__icon" />
          <input
            ref={filterRef}
            type="text"
            class={`rl-input rl-search__input${parsed.type === 'invalid' ? ' rl-input--invalid' : ''}`}
            placeholder="Filter text or $.json.path"
            aria-label="Filter messages by text or JSON path"
            title={parsed.type === 'invalid' ? parsed.error : 'Text terms (all must match, -term excludes), or a JSON path: $.a.b, $.a = x, $.a != x, $.a ~ part'}
            spellcheck={false}
            autocomplete="off"
            value={filter.text}
            data-testid="rl-ws-filter"
            data-mode={parsed.type}
            onInput={(e) => onFilter({ ...filter, text: e.currentTarget.value })}
            onKeyDown={onFilterKey}
          />
          {filter.text ? (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm rl-search__clear"
              title="Clear filter"
              aria-label="Clear filter"
              onClick={() => {
                onFilter({ ...filter, text: '' });
                filterRef.current?.focus();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
        <div class="rl-ws-seg" role="radiogroup" aria-label="Direction" data-testid="rl-ws-dir">
          {DIRS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              class={`rl-ws-seg__item rl-ws-seg__item--${d.id}`}
              aria-checked={filter.dir === d.id ? 'true' : 'false'}
              title={d.title}
              data-value={d.id}
              onClick={() => onFilter({ ...filter, dir: d.id })}
            >
              {d.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="rl-chip rl-ws-toolbar__hb"
          aria-pressed={filter.heartbeats || channel === HEARTBEAT_CHANNEL ? 'true' : 'false'}
          disabled={channel !== null}
          title={channel !== null ? 'Heartbeats are a channel of their own (see the sidebar)' : filter.heartbeats ? 'Hide heartbeat and control frames' : 'Show heartbeat and control frames'}
          data-testid="rl-ws-heartbeats"
          onClick={() => onFilter({ ...filter, heartbeats: !filter.heartbeats })}
        >
          <span class="rl-ws-toolbar__hb-dot" aria-hidden="true" />
          Heartbeats
          {props.heartbeatCount ? <span class="rl-ws-toolbar__hb-count">{count(props.heartbeatCount)}</span> : null}
        </button>
        <button
          type="button"
          class={`rl-icon-btn rl-icon-btn--sm rl-ws-toolbar__pause${paused ? ' rl-ws-toolbar__pause--on' : ''}`}
          aria-pressed={paused ? 'true' : 'false'}
          title={paused ? 'Resume the live view' : 'Pause the live view (messages are still recorded)'}
          aria-label={paused ? 'Resume the live view' : 'Pause the live view'}
          data-testid="rl-ws-pause"
          onClick={() => props.onPause(!paused)}
        >
          <Icon name={paused ? 'record' : 'pause'} size={13} />
        </button>
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm"
          aria-pressed={props.composeOpen ? 'true' : 'false'}
          disabled={!canSend && !props.composeOpen}
          title={canSend ? 'Send a message through this socket' : conn.frameId !== 0 ? 'Sending is only available for sockets of the top frame' : 'The connection is not open'}
          aria-label="Compose a message"
          data-testid="rl-ws-compose-toggle"
          onClick={() => props.onCompose(!props.composeOpen)}
        >
          <Icon name="send" size={13} />
        </button>
      </div>

      <div class="rl-ws-subbar">
        <span class={`rl-ws-dot rl-ws-dot--${stateTone(conn)}`} aria-hidden="true" />
        <span class="rl-ws-subbar__channel">{channelName}</span>
        <span class="rl-ws-subbar__url rl-mono rl-truncate" title={conn.url}>
          {parts.host}
          {parts.path === '/' ? '' : parts.path}
        </span>
        {kind && kind !== 'raw' ? <span class={`rl-ws-proto rl-ws-proto--${kind}`}>{WS_KIND_LABEL[kind]}</span> : null}
        <span class="rl-ws-subbar__state">{stateLabel(conn)}</span>
        <span class="rl-spacer" />
        <span class="rl-ws-subbar__count" data-testid="rl-ws-count" aria-live="polite">
          {filtering || frames.length !== props.total ? `${count(frames.length)} of ${count(props.total)}` : count(frames.length)}
          {' '}message{props.total === 1 ? '' : 's'}
        </span>
      </div>

      <FrameList {...props} />

      {paused ? (
        <div class="rl-ws-paused" role="status">
          <Icon name="pause" size={12} />
          <span>
            List paused{props.pending ? ` · ${count(props.pending)} new` : ''}
            {!props.recording ? ' · recording is paused too' : ''}
          </span>
          <button type="button" class="rl-btn rl-btn--sm" onClick={() => props.onPause(false)}>
            Resume
          </button>
        </div>
      ) : !props.recording ? (
        <div class="rl-ws-paused" role="status">
          <Icon name="pause" size={12} />
          <span>Recording is paused — new messages are not captured</span>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" onClick={props.onResume}>
            Resume recording
          </button>
        </div>
      ) : null}

      {props.composeOpen ? <Composer conn={conn} onClose={() => props.onCompose(false)} /> : null}
    </section>
  );
}

/** Virtualized, stick-to-bottom list of frames (oldest at the top). */
function FrameList(props: MessagesProps) {
  const { inspector, conn, channel, frames, selectedId, onSelect, focusRef } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const stick = useRef(true);
  const anchor = useRef<{ id: number; offset: number } | null>(null);
  const [unseen, setUnseen] = useState(0);
  /** Newest frame id seen by the list (to count arrivals, not filter changes). */
  const lastMaxId = useRef(frames.length ? frames[frames.length - 1]!.id : 0);
  const frame = useRef(0);

  focusRef.current = () => scrollRef.current?.focus({ preventScroll: true });

  // New frames: follow them when stuck to the bottom, else keep the rows in view where they are.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newest = frames.length ? frames[frames.length - 1]!.id : 0;
    const grew = newest > lastMaxId.current ? frames.length - firstAfter(frames, lastMaxId.current) : 0;
    lastMaxId.current = Math.max(lastMaxId.current, newest);
    if (stick.current) {
      const bottom = Math.max(0, frames.length * WS_ROW_H - el.clientHeight);
      if (Math.abs(el.scrollTop - bottom) >= 1) el.scrollTop = bottom;
      setScrollTop(el.scrollTop);
      setUnseen(0);
      return;
    }
    if (grew > 0) setUnseen((n) => n + grew);
    const a = anchor.current;
    if (a) {
      const index = indexOfId(frames, a.id);
      if (index >= 0) {
        const target = index * WS_ROW_H + a.offset;
        if (Math.abs(el.scrollTop - target) >= 1) {
          el.scrollTop = target;
          setScrollTop(el.scrollTop);
        }
      }
    }
  }, [frames]);

  // A new channel / connection starts at the newest message.
  useLayoutEffect(() => {
    stick.current = true;
    setUnseen(0);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = Math.max(0, frames.length * WS_ROW_H - el.clientHeight);
      setScrollTop(el.scrollTop);
    }
  }, [conn.wsId, channel]);

  // The viewport grew (pane resize): stay at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = Math.max(0, frames.length * WS_ROW_H - el.clientHeight);
  }, [height]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    stick.current = atBottom;
    if (atBottom) {
      anchor.current = null;
      if (unseen) setUnseen(0);
    } else {
      const index = Math.floor(el.scrollTop / WS_ROW_H);
      const f = frames[index];
      anchor.current = f ? { id: f.id, offset: el.scrollTop - index * WS_ROW_H } : null;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(el.scrollTop));
  };

  const reveal = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = scrollTopToReveal(index, WS_ROW_H, el.scrollTop, el.clientHeight);
    if (top !== null) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  };

  const selectedIndex = indexOfId(frames, selectedId);
  useLayoutEffect(() => {
    if (selectedIndex >= 0 && !stick.current) reveal(selectedIndex);
  }, [selectedId]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setUnseen(0);
  };

  const pick = (index: number) => {
    const f = frames[index];
    if (!f) return;
    onSelect(f.id);
    // Inspecting an older message stops following; picking the newest keeps it.
    if (index < frames.length - 1) stick.current = false;
    reveal(index);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (!frames.length) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / WS_ROW_H) - 1);
    const from = selectedIndex < 0 ? frames.length : selectedIndex;
    let to: number;
    switch (e.key) {
      case 'ArrowDown':
        to = selectedIndex < 0 ? frames.length - 1 : Math.min(frames.length - 1, from + 1);
        break;
      case 'ArrowUp':
        to = Math.max(0, from - 1);
        break;
      case 'PageDown':
        to = Math.min(frames.length - 1, from + page);
        break;
      case 'PageUp':
        to = Math.max(0, from - page);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = frames.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    pick(to);
    if (to === frames.length - 1) jumpToLatest();
  };

  const { start, end } = visibleRange(scrollTop, height, WS_ROW_H, frames.length);
  const rows: JSX.Element[] = [];
  const showChannel = channel === null;
  for (let i = start; i < end; i++) {
    const f = frames[i]!;
    const cls = inspector.info(f);
    const selected = f.id === selectedId;
    const chip = showChannel
      ? cls.channel === HEARTBEAT_CHANNEL
        ? cls.event ?? 'control'
        : cls.channel === DEFAULT_CHANNEL && !cls.event
          ? ''
          : cls.event && cls.event !== cls.channel && cls.channel !== DEFAULT_CHANNEL
            ? `${cls.channel} · ${cls.event}`
            : cls.event ?? cls.channel
      : // Inside a channel the chip only says something when the event is not the channel's own name.
        cls.event && cls.event !== cls.channel
        ? cls.event
        : '';
    rows.push(
      <div
        key={f.id}
        id={`rl-ws-m${f.id}`}
        role="option"
        aria-selected={selected ? 'true' : 'false'}
        class={`rl-ws-msg rl-ws-msg--${f.dir}${cls.heartbeat ? ' rl-ws-msg--hb' : ''}${selected ? ' rl-ws-msg--selected' : ''}`}
        style={{ top: `${i * WS_ROW_H}px` }}
        data-testid="rl-ws-message"
        data-frame-id={f.id}
        data-dir={f.dir}
        data-opcode={f.opcode}
        data-channel={cls.channel === HEARTBEAT_CHANNEL ? 'heartbeats' : cls.channel}
        data-event={cls.event ?? ''}
        onClick={() => pick(i)}
      >
        <span class="rl-ws-msg__dir" title={f.dir === 'out' ? 'Sent by the page' : 'Received from the server'}>
          <Icon name={f.dir === 'out' ? 'arrow-up' : 'arrow-down'} size={12} />
        </span>
        <span class="rl-ws-msg__time" title={formatClock(f.time)}>
          {relTime(f.time - conn.createdAt)}
        </span>
        {chip ? (
          <span class="rl-ws-msg__event" title={chip}>
            {chip}
          </span>
        ) : null}
        <span class="rl-ws-msg__preview">
          {f.opcode === 'binary' ? <span class="rl-ws-msg__bin">BIN</span> : null}
          {framePreview(f, cls)}
        </span>
        <span class="rl-ws-msg__size" title={`${f.size} bytes${f.truncated ? ' (payload truncated)' : ''}`}>
          {formatBytes(f.size)}
          {f.truncated ? '…' : ''}
        </span>
      </div>,
    );
  }

  return (
    <div class="rl-ws-list-wrap">
      <div
        ref={scrollRef}
        class="rl-ws-list rl-scroll"
        role="listbox"
        tabIndex={0}
        aria-label="Messages (↑/↓ to move)"
        aria-activedescendant={selectedIndex >= 0 ? `rl-ws-m${selectedId}` : undefined}
        data-testid="rl-ws-messages"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div class="rl-ws-list__spacer" style={{ height: `${frames.length * WS_ROW_H}px` }}>
          {rows}
        </div>
        {frames.length === 0 ? <ListEmpty {...props} /> : null}
      </div>
      {unseen > 0 ? (
        <button type="button" class="rl-ws-jump" data-testid="rl-ws-jump" onClick={jumpToLatest}>
          <Icon name="arrow-down" size={12} />
          {count(unseen)} new message{unseen === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}

/** Index of the first frame with an id greater than `id` (frames are id-sorted). */
function firstAfter(frames: readonly WsFrame[], id: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.id <= id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function ListEmpty(props: MessagesProps) {
  const filtering = props.parsed.type === 'text' || props.parsed.type === 'path' || props.filter.dir !== 'all';
  if (props.total > 0 && filtering) {
    return (
      <div class="rl-empty rl-ws-empty-list">
        <Icon name="filter" size={20} class="rl-empty__icon" />
        <div class="rl-empty__title">No messages match</div>
        <button type="button" class="rl-btn rl-btn--sm" onClick={() => props.onFilter({ ...props.filter, text: '', dir: 'all' })}>
          Clear filters
        </button>
      </div>
    );
  }
  if (props.total > 0 && !props.filter.heartbeats && props.channel === null) {
    return (
      <div class="rl-empty rl-ws-empty-list">
        <Icon name="eye" size={20} class="rl-empty__icon" />
        <div class="rl-empty__title">Only heartbeats so far</div>
        <div class="rl-empty__text">Control and heartbeat frames are hidden.</div>
        <button type="button" class="rl-btn rl-btn--sm" onClick={() => props.onFilter({ ...props.filter, heartbeats: true })}>
          Show heartbeats
        </button>
      </div>
    );
  }
  const open = props.conn.state === 'open' || props.conn.state === 'connecting';
  return (
    <div class="rl-empty rl-ws-empty-list">
      <Icon name="plug" size={20} class="rl-empty__icon" />
      <div class="rl-empty__title">{open ? 'No messages yet' : 'No messages'}</div>
      <div class="rl-empty__text">
        {open ? 'Messages the page sends and receives on this socket appear here as they happen.' : 'This socket closed without messages being recorded.'}
      </div>
    </div>
  );
}
