// "Send message": a text message sent through the page's own socket, only on an explicit click (or
// Ctrl/Cmd+Enter in the box). The frame then shows up in the list like any message the page sends.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WsConnection } from '../../lib/ws';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { useBridge } from '../hooks';

/** Drafts per connection while the panel lives. */
const drafts = new Map<string, string>();

export function Composer({ conn, onClose }: { conn: WsConnection; onClose(): void }) {
  const bridge = useBridge();
  const [text, setText] = useState(() => drafts.get(conn.wsId) ?? '');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = conn.state === 'open' && conn.frameId === 0 && !!bridge.ws;

  useEffect(() => {
    setText(drafts.get(conn.wsId) ?? '');
  }, [conn.wsId]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const send = async () => {
    if (!canSend || busy || !text || !bridge.ws) return;
    setBusy(true);
    const result = await bridge.ws.send(conn.wsId, text);
    setBusy(false);
    if (result.ok) {
      drafts.delete(conn.wsId);
      setText('');
    } else toast(`Not sent: ${result.error ?? 'unknown error'}`, 'error');
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // The panel's own Ctrl+Enter (send the selected HTTP request) must not fire.
      e.stopPropagation();
      void send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const reason = conn.frameId !== 0 ? 'Sending is only available for sockets of the top frame' : conn.state !== 'open' ? 'The connection is not open' : '';

  return (
    <form
      class="rl-ws-composer"
      data-testid="rl-ws-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={ref}
        class="rl-textarea rl-textarea--mono rl-ws-composer__input"
        rows={2}
        spellcheck={false}
        placeholder={reason || 'Message to send through the page’s socket  (Ctrl+Enter)'}
        aria-label="Message to send"
        disabled={!canSend}
        value={text}
        data-testid="rl-ws-composer-input"
        onInput={(e) => {
          const value = e.currentTarget.value;
          setText(value);
          if (value) drafts.set(conn.wsId, value);
          else drafts.delete(conn.wsId);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="rl-ws-composer__actions">
        <button
          type="submit"
          class="rl-btn rl-btn--sm rl-btn--primary"
          disabled={!canSend || busy || !text}
          title={reason || 'Send through the page’s socket (Ctrl+Enter)'}
          data-testid="rl-ws-composer-send"
        >
          <Icon name="send" size={12} />
          Send
        </button>
        <button type="button" class="rl-icon-btn rl-icon-btn--sm" title="Close the composer" aria-label="Close the composer" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
    </form>
  );
}
