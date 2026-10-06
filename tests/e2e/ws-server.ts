/**
 * Minimal WebSocket test server for the WebSocket inspector E2E (no dependencies: RFC 6455 handshake and
 * framing on node:http / node:crypto). Serves a demo page at `/ws-app` that opens three sockets:
 *
 *  - `/socket.io/?EIO=4&transport=websocket` — a Socket.IO v4-like chat (Engine.IO open, connect, events, acks,
 *    ping/pong heartbeats);
 *  - `/json` — a plain JSON protocol with `channel` / `type` keys (subscribe → ticks, echo, ping → pong), binary echo;
 *  - `/graphql` — graphql-transport-ws subscriptions (connection_init / subscribe → next… → complete).
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsTestServer {
  url: string;
  appUrl: string;
  close(): Promise<void>;
}

/** One server-side connection. */
class Peer {
  private buffer = Buffer.alloc(0);
  closed = false;

  constructor(
    readonly socket: Socket,
    readonly path: string,
    private readonly onText: (peer: Peer, text: string) => void,
    private readonly onBinary: (peer: Peer, data: Buffer) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
    });
  }

  sendText(text: string): void {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  sendBinary(data: Buffer): void {
    this.write(0x2, data);
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + maskLen + len);
      if (opcode === 0x1) this.onText(this, payload.toString('utf8'));
      else if (opcode === 0x2) this.onBinary(this, payload);
      else if (opcode === 0x8) {
        this.write(0x8, payload.subarray(0, 2));
        this.closed = true;
        this.socket.end();
        return;
      } else if (opcode === 0x9) this.write(0xa, payload);
    }
  }
}

// ------------------------------------------------------------------------------------------------- protocols

function socketIo(peer: Peer, text: string): void {
  if (text === '40') {
    peer.sendText('40{"sid":"srv-1"}');
    // Engine.IO heartbeat: the client answers "3".
    setTimeout(() => peer.sendText('2'), 20);
    return;
  }
  const m = /^42(\d*)(\[.*)$/s.exec(text);
  if (!m) return;
  const ack = m[1];
  const [event, data] = JSON.parse(m[2]!) as [string, unknown];
  if (ack) {
    peer.sendText(`43${ack}${JSON.stringify([{ ok: true, event }])}`);
    return;
  }
  if (event === 'chat message') {
    peer.sendText(`42${JSON.stringify(['chat message', { ...(data as object), echo: true, at: 1700000000000 }])}`);
    peer.sendText(`42${JSON.stringify(['typing', { user: 'server', typing: false }])}`);
  } else if (event === 'join') {
    peer.sendText(`42${JSON.stringify(['presence', { room: (data as { room: string }).room, users: ['ann', 'bob', 'you'] }])}`);
  }
}

function jsonProtocol(peer: Peer, text: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    peer.sendText(`echo: ${text}`);
    return;
  }
  if (msg.type === 'ping') {
    peer.sendJson({ type: 'pong', t: msg.t });
    return;
  }
  if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
    peer.sendJson({ channel: msg.channel, type: 'subscribed' });
    for (let i = 1; i <= 3; i++) {
      setTimeout(() => peer.sendJson({ channel: msg.channel, type: 'tick', price: 100 + i, seq: i }), i * 15);
    }
    return;
  }
  peer.sendJson({ channel: typeof msg.channel === 'string' ? msg.channel : 'echo', type: 'echo', data: msg });
}

function graphql(peer: Peer, text: string): void {
  const msg = JSON.parse(text) as { type: string; id?: string; payload?: { query?: string } };
  if (msg.type === 'connection_init') peer.sendJson({ type: 'connection_ack' });
  else if (msg.type === 'subscribe' && msg.id) {
    const id = msg.id;
    for (let i = 1; i <= 2; i++) {
      setTimeout(() => peer.sendJson({ id, type: 'next', payload: { data: { messageAdded: { id: String(i), text: `update ${i}` } } } }), i * 15);
    }
    setTimeout(() => peer.sendJson({ id, type: 'complete' }), 60);
  } else if (msg.type === 'ping') peer.sendJson({ type: 'pong' });
}

// ------------------------------------------------------------------------------------------------- page

/** The demo page. `window.__ws` exposes its sockets and what they received for the test's checks. */
export const WS_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>WebSocket demo</title>
<style>body{font:14px system-ui;margin:24px;color:#222}h1{font-size:18px}#log{white-space:pre;font:12px ui-monospace,monospace;color:#555}</style>
</head><body>
<h1>Realtime demo</h1>
<p>Chat over Socket.IO, prices over a JSON socket, GraphQL subscriptions.</p>
<div id="status">connecting</div>
<pre id="log"></pre>
<script>
(() => {
  const log = (line) => { document.getElementById('log').textContent += line + '\\n'; };
  const state = { received: { io: [], json: [], gql: [] }, binaryEcho: null, sockets: {} };
  window.__ws = state;
  const base = 'ws://' + location.host;

  const io = new WebSocket(base + '/socket.io/?EIO=4&transport=websocket');
  state.sockets.io = io;
  io.onmessage = (e) => {
    state.received.io.push(e.data);
    if (typeof e.data !== 'string') return;
    if (e.data[0] === '0') io.send('40');
    else if (e.data === '2') io.send('3');
    else if (e.data.startsWith('40')) {
      io.send('42' + JSON.stringify(['join', { room: 'lobby' }]));
    }
  };
  window.ioEmit = (event, data, ack) => io.send('42' + (ack || '') + JSON.stringify([event, data]));

  const json = new WebSocket(base + '/json');
  json.binaryType = 'arraybuffer';
  state.sockets.json = json;
  json.addEventListener('message', (e) => {
    if (typeof e.data === 'string') state.received.json.push(e.data);
    else state.binaryEcho = Array.from(new Uint8Array(e.data));
  });
  json.onopen = () => {
    json.send(JSON.stringify({ type: 'subscribe', channel: 'prices' }));
    json.send(JSON.stringify({ type: 'ping', t: 1 }));
  };

  const gql = new WebSocket(base + '/graphql', 'graphql-transport-ws');
  state.sockets.gql = gql;
  gql.onmessage = (e) => state.received.gql.push(e.data);
  gql.onopen = () => {
    gql.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    gql.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: 'subscription OnMessageAdded { messageAdded { id text } }' } }));
  };

  let open = 0;
  for (const s of [io, json, gql]) s.addEventListener('open', () => { if (++open === 3) document.getElementById('status').textContent = 'ready'; });
  log('sockets created');
})();
</script>
</body></html>`;

/** Start the server on 127.0.0.1 (random port). */
export async function startWsServer(): Promise<WsTestServer> {
  const peers = new Set<Peer>();
  const server = http.createServer((req, res) => {
    if (req.url === '/ws-app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(WS_APP_HTML);
      return;
    }
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const requested = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
    if (requested.length) lines.push(`Sec-WebSocket-Protocol: ${requested[0]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const path = (req.url ?? '/').split('?')[0]!;
    const peer = new Peer(
      socket,
      path,
      (p, text) => {
        try {
          if (path.startsWith('/socket.io')) socketIo(p, text);
          else if (path === '/json') jsonProtocol(p, text);
          else if (path === '/graphql') graphql(p, text);
        } catch {
          /* malformed test input */
        }
      },
      (p, data) => {
        // Binary echo, reversed so the page can tell the server's answer from its own bytes.
        p.sendBinary(Buffer.from([...data].reverse()));
      },
    );
    peers.add(peer);
    socket.on('close', () => peers.delete(peer));
    if (path.startsWith('/socket.io')) {
      peer.sendText('0{"sid":"eio-1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    appUrl: `${url}/ws-app`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const peer of peers) peer.socket.destroy();
        server.close(() => resolve());
      }),
  };
}
