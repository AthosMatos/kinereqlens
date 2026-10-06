/**
 * The single WebSocket to the receiver: handshake, offline buffer (bounded by captures), reconnect with
 * exponential backoff. Never throws into callers.
 */
import type { ClientMessage, HelloMessage, ServerMessage } from './protocol';
import { CLOSE_CODES, parseServerMessage } from './protocol';

export type TransportStatus = 'idle' | 'connecting' | 'handshaking' | 'connected' | 'disconnected' | 'rejected' | 'stopped';

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type SocketCtor = new (url: string) => unknown;

export interface TransportOptions {
  url: string;
  WebSocketImpl: SocketCtor;
  hello: () => HelloMessage;
  onMessage: (message: ServerMessage) => void;
  /** Maximum captures (distinct keys) held while disconnected. */
  bufferSize: number;
  minDelayMs: number;
  maxDelayMs: number;
  handshakeTimeoutMs: number;
  onStatus?: (status: TransportStatus, detail?: string) => void;
  log?: (message: string) => void;
}

interface Queued {
  key: string | null;
  text: string;
}

const OPEN = 1;
/** Keyless messages (open-ui, replay results) kept while disconnected. */
const MAX_KEYLESS = 50;
/** Ids of evicted captures remembered so their later messages (end, frames) are dropped too. */
const MAX_EVICTED = 5000;

export class Transport {
  status: TransportStatus = 'idle';
  /** Captures evicted from the buffer, not yet reported to a receiver. */
  dropped = 0;
  private socket: SocketLike | null = null;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private rejected = false;
  private warnedRejected = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Queued[] = [];
  /** Queued message count per capture key, in first-seen order (Map keeps insertion order). */
  private keys = new Map<string, number>();
  private keyless = 0;
  private evicted = new Set<string>();

  constructor(private readonly options: TransportOptions) {}

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  get connected(): boolean {
    return this.ready;
  }

  /** Number of messages currently buffered (tests/diagnostics). */
  get buffered(): number {
    return this.queue.length;
  }

  /** Queue or send. `key` groups the messages of one capture for buffer eviction. */
  send(message: ClientMessage, key: string | null = null): void {
    if (this.stopped) return;
    if (key !== null && this.evicted.has(key)) return;
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch {
      return;
    }
    if (this.ready && this.queue.length === 0 && this.write(text)) return;
    this.enqueue({ key, text });
  }

  /** Send only when connected (pong); never buffered. */
  sendNow(message: ClientMessage): void {
    if (!this.ready) return;
    try {
      this.write(JSON.stringify(message));
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      try {
        socket.close(1000, 'stopped');
      } catch {
        /* ignore */
      }
    }
    this.queue = [];
    this.keys.clear();
    this.setStatus('stopped');
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    this.status = status;
    try {
      this.options.onStatus?.(status, detail);
    } catch {
      /* ignore */
    }
  }

  private write(text: string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private enqueue(item: Queued): void {
    if (item.key === null) {
      if (this.keyless >= MAX_KEYLESS) {
        const index = this.queue.findIndex((q) => q.key === null);
        if (index >= 0) this.queue.splice(index, 1);
        this.keyless--;
      }
      this.keyless++;
    } else {
      const count = this.keys.get(item.key);
      if (count === undefined) {
        this.keys.set(item.key, 1);
        while (this.keys.size > this.options.bufferSize) this.evictOldest();
      } else this.keys.set(item.key, count + 1);
    }
    this.queue.push(item);
    // Hard bound on messages too (chatty WebSockets): about 20 messages per capture on average.
    const maxMessages = Math.max(100, this.options.bufferSize * 20);
    while (this.queue.length > maxMessages && this.keys.size > 1) this.evictOldest();
    if (this.queue.length > maxMessages) this.queue.splice(0, this.queue.length - maxMessages);
  }

  private evictOldest(): void {
    const oldest = this.keys.keys().next();
    if (oldest.done) return;
    const key = oldest.value;
    this.keys.delete(key);
    this.queue = this.queue.filter((q) => q.key !== key);
    this.evicted.add(key);
    if (this.evicted.size > MAX_EVICTED) {
      const first = this.evicted.values().next();
      if (!first.done) this.evicted.delete(first.value);
    }
    this.dropped++;
  }

  private flush(): void {
    if (this.dropped > 0 && this.write(JSON.stringify({ t: 'dropped', count: this.dropped }))) this.dropped = 0;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (!this.write(item.text)) return;
      this.queue.shift();
      if (item.key === null) this.keyless--;
      else {
        const count = (this.keys.get(item.key) ?? 1) - 1;
        if (count <= 0) this.keys.delete(item.key);
        else this.keys.set(item.key, count);
      }
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.timer = null;
    this.handshakeTimer = null;
  }

  private detach(socket: SocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    let socket: SocketLike;
    try {
      socket = new this.options.WebSocketImpl(this.options.url) as SocketLike;
    } catch (error) {
      this.options.log?.(`cannot open ${this.options.url}: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.setStatus('connecting');
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setStatus('handshaking');
      try {
        socket.send(JSON.stringify(this.options.hello()));
      } catch {
        this.down(socket);
        return;
      }
      this.handshakeTimer = setTimeout(() => {
        if (this.socket === socket && !this.ready) {
          try {
            socket.close(1000, 'handshake timeout');
          } catch {
            /* ignore */
          }
          this.down(socket);
        }
      }, this.options.handshakeTimeoutMs);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerMessage(event?.data);
      if (!message) return;
      if (message.t === 'welcome') {
        if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.ready = true;
        this.attempt = 0;
        this.rejected = false;
        this.warnedRejected = false;
        this.setStatus('connected');
        this.flush();
        return;
      }
      if (message.t === 'rejected') {
        this.rejected = true;
        if (!this.warnedRejected) {
          this.warnedRejected = true;
          this.options.log?.(`receiver rejected the connection: ${message.reason}`);
        }
        return;
      }
      if (!this.ready) return;
      if (message.t === 'ping') {
        this.sendNow(message.id === undefined ? { t: 'pong' } : { t: 'pong', id: message.id });
        return;
      }
      try {
        this.options.onMessage(message);
      } catch {
        /* never let a handler break the socket */
      }
    };
    socket.onclose = (event) => {
      if (event && event.code === CLOSE_CODES.BAD_TOKEN) this.rejected = true;
      this.down(socket);
    };
    socket.onerror = () => {
      // Most implementations fire close right after error; make sure a lost socket is retried anyway.
      setTimeout(() => {
        if (this.socket === socket && socket.readyState !== OPEN) this.down(socket);
      }, 1000);
    };
  }

  /** The socket is gone (idempotent per socket). */
  private down(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.detach(socket);
    this.socket = null;
    this.ready = false;
    if (this.stopped) return;
    if (this.rejected) this.setStatus('rejected');
    else this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    const { minDelayMs, maxDelayMs } = this.options;
    const delay = this.rejected ? maxDelayMs : Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(this.attempt, 16));
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
