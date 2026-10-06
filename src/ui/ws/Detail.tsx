// WebSocket inspector, pane 3: one message — metadata, and its payload as a JSON tree, raw text or hex.
import { useMemo, useState } from 'preact/hooks';
import type { WsConnection, WsFrame } from '../../lib/ws';
import type { WsInspector } from '../../lib/ws-inspector';
import { payloadText } from '../../lib/ws-inspector';
import { channelLabel, HEARTBEAT_CHANNEL, WS_KIND_LABEL } from '../../lib/ws-protocols';
import { tryParseJsonTree } from '../../lib/json-tree';
import { base64ToBytes, utf8Encode } from '../../lib/encoding';
import { formatBytes, formatClock } from '../../lib/format';
import { Icon } from '../components/Icon';
import { hexDump } from '../response/body-model';
import { JsonViewer } from '../response/JsonViewer';
import { CopyButton, Segmented } from '../response/parts';
import { relTime } from './format';
import { analyzeInitiator, locationText } from '../../lib/initiator';
import { hasReveal, wsRevealKey } from '../find/reveal';

type View = 'pretty' | 'raw' | 'hex';

/** Hex dump bytes shown before "Show all". */
const HEX_PAGE = 16 * 1024;
/** Remembered view per payload type while the panel lives. */
let preferredText: View = 'pretty';

export interface DetailProps {
  inspector: WsInspector;
  conn: WsConnection | null;
  frame: WsFrame | null;
  /** A message was selected but dropped from the buffer since. */
  dropped: boolean;
}

export function MessageDetail({ inspector, conn, frame, dropped }: DetailProps) {
  if (!frame || !conn) {
    return (
      <section class="rl-ws-detail rl-ws-detail--empty" data-testid="rl-ws-detail" aria-label="Message">
        <div class="rl-empty">
          <Icon name={dropped ? 'info' : 'code'} size={22} class="rl-empty__icon" />
          <div class="rl-empty__title">{dropped ? 'Message no longer kept' : 'Select a message'}</div>
          <div class="rl-empty__text">
            {dropped
              ? 'It was dropped from the buffer (the oldest messages go first) or cleared.'
              : 'Its payload shows here as a JSON tree, raw text or hex, with direction, time, size and channel.'}
          </div>
          {dropped ? null : (
            <div class="rl-detail-empty__keys rl-faint">
              <span class="rl-kbd">↑</span>
              <span class="rl-kbd">↓</span>
              <span>browse messages</span>
            </div>
          )}
        </div>
      </section>
    );
  }
  return <FrameDetail key={frame.id} inspector={inspector} conn={conn} frame={frame} />;
}

function FrameDetail({ inspector, conn, frame }: { inspector: WsInspector; conn: WsConnection; frame: WsFrame }) {
  const cls = inspector.info(frame);
  const binary = frame.opcode === 'binary';
  const payload = useMemo(() => (binary ? '' : payloadText(frame, cls)), [frame, cls, binary]);
  const tree = useMemo(() => (binary ? null : tryParseJsonTree(payload.trim())), [payload, binary]);
  const bytes = useMemo(() => {
    if (binary) {
      try {
        return base64ToBytes(frame.base64 ?? '');
      } catch {
        return new Uint8Array(0);
      }
    }
    return null;
  }, [frame, binary]);
  // A "Where does this come from?" result opens the message on its JSON tree.
  const [view, setViewState] = useState<View>(() => (binary ? 'hex' : tree ? (hasReveal(wsRevealKey(frame.id)) ? 'pretty' : preferredText) : 'raw'));
  const setView = (v: View) => {
    if (!binary && v !== 'hex') preferredText = v;
    setViewState(v);
  };
  const effective: View = view === 'pretty' && !tree ? 'raw' : view;
  const [wrap, setWrap] = useState(true);
  const [hexAll, setHexAll] = useState(false);
  const kind = inspector.protocolOf(conn.wsId);
  const out = frame.dir === 'out';

  const copyText = () => (binary ? (frame.base64 ?? '') : (frame.text ?? ''));
  const hexBytes = useMemo(() => bytes ?? (effective === 'hex' ? utf8Encode(frame.text ?? '') : null), [bytes, effective, frame]);
  const hexLines = useMemo(
    () => (effective === 'hex' && hexBytes ? hexDump(hexBytes, hexAll ? hexBytes.length : HEX_PAGE) : []),
    [effective, hexBytes, hexAll],
  );

  const meta: Array<[string, string, string?]> = [
    ['Time', formatClock(frame.time), new Date(frame.time).toISOString()],
    ['Since open', relTime(frame.time - (conn.openedAt ?? conn.createdAt)).replace(/^\+/, '')],
    ['Size', `${formatBytes(frame.size)}${frame.size >= 1024 ? ` (${frame.size.toLocaleString('en-US')} B)` : ''}`],
    ['Opcode', binary ? 'Binary (0x2)' : 'Text (0x1)'],
    ['Channel', channelLabel(cls.channel)],
  ];
  if (cls.event) meta.push(['Event', cls.event]);
  if (kind && kind !== 'raw') meta.push(['Protocol', WS_KIND_LABEL[kind]]);
  const createdBy = useMemo(() => createdByText(conn.initiatorStack), [conn.initiatorStack]);
  if (createdBy) meta.push(['Created by', createdBy, conn.initiatorStack]);

  return (
    <section class="rl-ws-detail" data-testid="rl-ws-detail" data-frame-id={frame.id} aria-label="Message">
      <header class="rl-ws-detail__head">
        <span class={`rl-ws-dirpill rl-ws-dirpill--${frame.dir}`} data-testid="rl-ws-detail-dir" data-dir={frame.dir}>
          <Icon name={out ? 'arrow-up' : 'arrow-down'} size={12} />
          {out ? 'Sent' : 'Received'}
        </span>
        {cls.event || cls.channel === HEARTBEAT_CHANNEL ? (
          <span class="rl-ws-msg__event rl-ws-detail__event" data-testid="rl-ws-detail-event">
            {cls.event ?? 'control'}
          </span>
        ) : null}
        <span class="rl-ws-detail__time rl-faint" title={new Date(frame.time).toISOString()}>
          {formatClock(frame.time)}
        </span>
        <span class="rl-spacer" />
        <CopyButton text={copyText} label="Copy" done="Message copied" title="Copy the whole message" testId="rl-ws-copy" />
      </header>

      <dl class="rl-ws-meta" data-testid="rl-ws-meta">
        {meta.map(([k, v, title]) => (
          <div class="rl-ws-meta__row" key={k}>
            <dt>{k}</dt>
            <dd title={title ?? v}>{v}</dd>
          </div>
        ))}
      </dl>

      {frame.truncated ? (
        <div class="rl-warning rl-ws-detail__note">
          <Icon name="warning" size={12} />
          Only the first {formatBytes(binary ? (bytes?.length ?? 0) : payload.length)} of this {formatBytes(frame.size)} message were kept.
        </div>
      ) : null}

      <div class="rl-ws-detail__bar">
        <Segmented<View>
          label="Payload view"
          value={effective}
          onChange={setView}
          options={[
            { id: 'pretty', label: 'Pretty', disabled: !tree, title: tree ? 'JSON tree' : 'Not JSON', testId: 'rl-ws-view-pretty' },
            { id: 'raw', label: binary ? 'Base64' : 'Raw', testId: 'rl-ws-view-raw' },
            { id: 'hex', label: 'Hex', testId: 'rl-ws-view-hex' },
          ]}
        />
        <span class="rl-spacer" />
        {effective === 'raw' ? (
          <button type="button" class="rl-chip" aria-pressed={wrap ? 'true' : 'false'} onClick={() => setWrap(!wrap)} title="Wrap long lines">
            Wrap
          </button>
        ) : null}
      </div>

      <div class="rl-ws-detail__body rl-scroll" data-view={effective}>
        {effective === 'pretty' && tree ? (
          <JsonViewer root={tree} initialDepth={3} testId="rl-ws-json" findInPage revealKey={wsRevealKey(frame.id)} />
        ) : effective === 'raw' ? (
          <pre class={`rl-ws-raw rl-mono${wrap ? ' rl-ws-raw--wrap' : ''}`} data-testid="rl-ws-raw">
            {binary ? frame.base64 : frame.text}
          </pre>
        ) : (
          <div class="rl-ws-hex">
            <pre class="rl-ws-raw rl-mono" data-testid="rl-ws-hex" aria-label="Hex dump">
              {hexLines.join('\n')}
            </pre>
            {hexBytes && hexBytes.length > HEX_PAGE && !hexAll ? (
              <button type="button" class="rl-btn rl-btn--sm" onClick={() => setHexAll(true)}>
                Show all {formatBytes(hexBytes.length)}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** "<Component> · file.js:12:5" of the code that called `new WebSocket()` (bundle positions), or null. */
function createdByText(stack: string | undefined): string | null {
  if (typeof stack !== 'string' || !stack) return null;
  const analysis = analyzeInitiator(stack);
  const frame = analysis.frames[analysis.initiatorIndex];
  if (!frame) return null;
  const where = locationText(frame);
  return analysis.component ? `<${analysis.component.name}> · ${where}` : where;
}
