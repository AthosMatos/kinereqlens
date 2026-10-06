/**
 * Local HTTP servers for the kineReqLens E2E suite (node:http, ephemeral ports on 127.0.0.1).
 *
 *  - main server (`origin`): the test app at GET /app plus echo/fixture endpoints;
 *  - cross server (`crossOrigin`): same endpoints on another port = another origin, never sends CORS headers,
 *    so page-mode fetches/replays to it are blocked by CORS while extension-mode replays succeed.
 *
 * Endpoints
 *  GET  /app                 test page; sets a cookie; fires some requests on load, buttons trigger the rest
 *  ANY  /api/echo[/*]        JSON {seq, method, path, rawQuery, query: [k, v][], headers, bodyText, bodyBase64, contentType}
 *  POST /graphql             JSON {seq, query, variables, operationName, extensions, data, bodyText} (array for batches;
 *                            `data` is a fixed GraphQL-style result: {user: {id: variables.id, name, posts: [{title}]}})
 *  GET  /api/html            small HTML document (with a script that must never run in the preview)
 *  GET  /api/image           PNG (?w=&h= size)
 *  ANY  /api/slow?ms=        echo after `ms` milliseconds
 *  GET  /api/big             large JSON (?n= items)
 *  POST /api/beacon          204
 *  GET  /static/app.css, /static/app.js, /static/extra.js
 *  GET  /blank                minimal page (tests add their own DOM / script through page.evaluate)
 *  GET  /api/stream?id=       NDJSON line every 100 ms, chunked (no Content-Length), never ends; open/close
 *                             times of each id are recorded in `streams`
 *  GET  /api/slowimg?ms=      PNG after `ms` milliseconds
 *  GET  /api/download         small CSV with Content-Disposition: attachment (a navigation that never commits)
 *  GET  /api/nocontent        204
 *  GET  /api/login            sets the HttpOnly cookie HTTPONLY_COOKIE (for the "page cannot read it" checks)
 *  GET  /rng                  page whose inline script replaces Math.random (counting) and fetches while parsing
 *  GET  /prerender-a, /prerender-b   speculation-rules prerender of B from A
 * Every request is appended to `requests` (seq, method, url, headers, body) for server-side assertions.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

export interface LoggedRequest {
  seq: number;
  server: 'main' | 'cross';
  method: string;
  /** Raw request target (path + query) exactly as received. */
  url: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface EchoResponse {
  seq: number;
  method: string;
  path: string;
  /** Query string as received (no decoding), without '?'. */
  rawQuery: string;
  /** Decoded query pairs in order (duplicates kept). */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  bodyText: string;
  bodyBase64: string;
  contentType: string | null;
}

/** Lifetime of one /api/stream response (epoch ms). */
export interface StreamRecord {
  opened: number;
  closed?: number;
}

export interface TestServers {
  /** http://127.0.0.1:<port> of the main server. */
  origin: string;
  /** /api/stream responses by id. */
  readonly streams: Map<string, StreamRecord>;
  /** Another origin (other port), no CORS headers. */
  crossOrigin: string;
  /** `${origin}/app` */
  appUrl: string;
  /** Every request both servers received, oldest first. */
  readonly requests: LoggedRequest[];
  /** Requests whose path starts with `prefix` (optionally filtered by method). */
  requestsTo(prefix: string, method?: string): LoggedRequest[];
  close(): Promise<void>;
}

export const SESSION_COOKIE = 'rl_session=abc123';
/** Set HttpOnly by GET /api/login: page scripts must never be able to read its value. */
export const HTTPONLY_COOKIE = 'rl_secret=HTTPONLY_SECRET_42';

// ------------------------------------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA PNG with an indigo/white checker pattern. */
export function makePng(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      row.set(on ? [79, 70, 229, 255] : [238, 242, 255, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------------------------------------ fixtures

export const PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1e1b4b}h1{color:#0230bb;margin:0 0 8px}</style></head>
<body><h1 id="title">Hello preview</h1><p>Rendered inside a sandboxed iframe.</p>
<script>document.getElementById('title').textContent = 'SCRIPT RAN';</script></body></html>`;

/** Body of the JSON request the app sends (written literally: the big number must not be rounded by JS). */
export const JSON_BODY =
  '{"user":{"name":"Ada","address":{"city":"London","zip":"N1"}},"tags":["alpha","beta"],"active":true,' +
  '"big":12345678901234567890,"count":3,"note":null}';

/** A multi-line document, as GraphQL clients (Apollo, urql, Relay) send it. */
export const GRAPHQL_QUERY = [
  'query GetUser($id: ID!, $first: Int) {',
  '  user(id: $id) {',
  '    name',
  '    posts(first: $first) {',
  '      title',
  '    }',
  '  }',
  '}',
].join('\n');

export function bigJson(n: number): string {
  const items = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    sku: `SKU-${String(i + 1).padStart(5, '0')}`,
    title: `Item number ${i + 1}`,
    price: Math.round(((i * 7919) % 10000) + 99) / 100,
    tags: ['bulk', i % 2 ? 'odd' : 'even'],
    inStock: i % 3 !== 0,
  }));
  return JSON.stringify({ total: n, items });
}

const APP_CSS = `
:root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; background: #f6f7fb; color: #1f2937; }
.top { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.top img { border-radius: 6px; }
.top h1 { font-size: 18px; margin: 0; }
.top nav { margin-left: 24px; display: flex; gap: 18px; color: #6b7280; font-size: 14px; }
.layout { display: flex; align-items: flex-start; }
.side { width: 196px; flex: none; padding: 16px 12px 16px 24px; display: flex; flex-direction: column; gap: 6px; }
.side h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #9ca3af; margin: 4px 0 4px; }
.side button { font: inherit; font-size: 13px; text-align: left; padding: 5px 10px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
.side button:hover { background: #eef2ff; border-color: #c7d2fe; }
main { flex: 1; min-width: 0; padding: 16px 24px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; max-width: 1100px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
.card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 0 0 10px; }
.card .num { font-size: 28px; font-weight: 700; }
#log { grid-column: 1 / -1; font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; min-height: 80px; margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td { padding: 6px 0; border-top: 1px solid #f1f5f9; }
`;

function appHtml(crossOrigin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme Orders</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js"></script>
</head><body>
<header class="top"><img src="/api/image?w=28&h=28" width="28" height="28" alt="">
<h1>Acme Orders</h1><nav><span>Dashboard</span><span>Orders</span><span>Customers</span><span>Reports</span></nav></header>
<div class="layout">
<aside class="side"><h2>Requests</h2>
    <button id="btn-query">GET with query</button>
    <button id="btn-json">POST JSON</button>
    <button id="btn-graphql">GraphQL</button>
    <button id="btn-form">XHR form</button>
    <button id="btn-multipart">Multipart upload</button>
    <button id="btn-headers">Custom header</button>
    <button id="btn-text">POST text</button>
    <button id="btn-cross">Cross-origin</button>
    <button id="btn-html">HTML</button>
    <button id="btn-image">Image</button>
    <button id="btn-slow">Slow</button>
    <button id="btn-big">Big JSON</button>
    <button id="btn-beacon">Beacon</button>
    <button id="btn-xhr-json">XHR json</button>
    <button id="btn-xhr-buffer">XHR arraybuffer</button>
    <button id="btn-assets">Load assets</button>
</aside>
<main>
  <section class="card"><h2>Orders today</h2><div class="num" id="orders">—</div></section>
  <section class="card"><h2>Revenue</h2><div class="num">$12,480</div></section>
  <section class="card"><h2>Open tickets</h2><div class="num">7</div></section>
  <section class="card" style="grid-column: span 2"><h2>Recent orders</h2><table>
    <tr><td>#10421</td><td>Ada Lovelace</td><td>$89.00</td></tr><tr><td>#10420</td><td>Alan Turing</td><td>$42.50</td></tr>
    <tr><td>#10419</td><td>Grace Hopper</td><td>$130.00</td></tr><tr><td>#10418</td><td>Edsger Dijkstra</td><td>$18.99</td></tr></table></section>
  <section class="card"><h2>Status</h2><div id="status">loading</div></section>
  <pre id="log"></pre>
</main>
</div>
<script>
const CROSS = ${JSON.stringify(crossOrigin)};
const JSON_BODY = ${JSON.stringify(JSON_BODY)};
const GRAPHQL_QUERY = ${JSON.stringify(GRAPHQL_QUERY)};
const log = (name, text) => {
  const el = document.getElementById('log');
  el.textContent += name + ': ' + text + '\\n';
  document.body.dataset['done_' + name.replace(/-/g, '_')] = String(Number(document.body.dataset['done_' + name.replace(/-/g, '_')] || 0) + 1);
};
const xhr = (method, url, { body, headers = {}, responseType = '' } = {}) => new Promise((resolve) => {
  const x = new XMLHttpRequest();
  x.open(method, url);
  x.responseType = responseType;
  for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
  x.onloadend = () => resolve(x);
  x.send(body ?? null);
});
const handlers = {
  query: async () => (await fetch('/api/echo/query?foo=bar&n=1&list=a&list=b&q=hello%20world&sym=%7E%21')).status,
  json: async () => (await fetch('/api/echo/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON_BODY })).status,
  graphql: async () => {
    const r = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { id: '42', first: 10 }, operationName: 'GetUser' }) });
    return (await r.json()).operationName;
  },
  form: async () => (await xhr('POST', '/api/echo/form', { body: 'a=1&b=two+words&c=%C3%A9', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status,
  multipart: async () => {
    const fd = new FormData();
    fd.append('title', 'Quarterly report');
    fd.append('attachment', new Blob(['hello file content'], { type: 'text/plain' }), 'notes.txt');
    return (await fetch('/api/echo/upload', { method: 'POST', body: fd })).status;
  },
  headers: async () => (await fetch('/api/echo/headers?h=1', { headers: { 'X-Custom': 'original', Accept: 'application/json' } })).status,
  text: async () => (await fetch('/api/echo/text', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'plain text body' })).status,
  cross: async () => { try { return (await fetch(CROSS + '/api/echo/cross?x=1')).status; } catch (e) { return 'blocked: ' + e.name; } },
  html: async () => (await fetch('/api/html')).status,
  image: async () => (await fetch('/api/image?w=64&h=48')).status,
  slow: async () => (await fetch('/api/slow?ms=200')).status,
  big: async () => (await (await fetch('/api/big')).json()).total,
  beacon: async () => navigator.sendBeacon('/api/beacon', 'beacon-payload'),
  'xhr-json': async () => { const x = await xhr('GET', '/api/echo/xhr-json?kind=json', { responseType: 'json' }); return x.response && x.response.method; },
  'xhr-buffer': async () => { const x = await xhr('GET', '/api/image?w=16&h=16', { responseType: 'arraybuffer' }); return x.response.byteLength; },
  assets: async () => {
    const img = new Image(); img.src = '/api/image?w=20&h=20&asset=1'; document.body.appendChild(img);
    await new Promise((r) => { img.onload = img.onerror = r; });
    const s = document.createElement('script'); s.src = '/static/extra.js'; document.head.appendChild(s);
    await new Promise((r) => { s.onload = s.onerror = r; });
    return 'loaded';
  },
};
for (const [name, fn] of Object.entries(handlers)) {
  document.getElementById('btn-' + name).addEventListener('click', async () => {
    try { log(name, String(await fn())); } catch (e) { log(name, 'ERROR ' + e); }
  });
}
window.addEventListener('load', async () => {
  const r = await fetch('/api/echo/onload?boot=1');
  document.getElementById('orders').textContent = String((await r.json()).query.length + 41);
  await xhr('GET', '/api/echo/onload-xhr?boot=2');
  document.getElementById('status').textContent = 'ready';
});
</script></body></html>`;
}

// ------------------------------------------------------------------------------------------------ server

function headerObject(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function echoOf(req: LoggedRequest): EchoResponse {
  const q = req.url.indexOf('?');
  const rawQuery = q >= 0 ? req.url.slice(q + 1) : '';
  const query: Array<[string, string]> = rawQuery
    ? rawQuery.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        return eq >= 0 ? [decodeComponent(pair.slice(0, eq)), decodeComponent(pair.slice(eq + 1))] : [decodeComponent(pair), ''];
      })
    : [];
  return {
    seq: req.seq,
    method: req.method,
    path: req.path,
    rawQuery,
    query,
    headers: headerObject(req.headers),
    bodyText: req.body.toString('utf8'),
    bodyBase64: req.body.toString('base64'),
    contentType: req.headers['content-type'] ?? null,
  };
}

function graphqlEcho(req: LoggedRequest): unknown {
  const text = req.body.toString('utf8');
  const one = (op: Record<string, unknown>) => {
    const variables = (op.variables ?? null) as Record<string, unknown> | null;
    return {
      seq: req.seq,
      query: op.query ?? null,
      variables,
      operationName: op.operationName ?? null,
      extensions: op.extensions ?? null,
      // A GraphQL-shaped result (the Export tab types it as <Operation>Data).
      data: { user: { id: String(variables?.id ?? ''), name: 'Ada Lovelace', posts: [{ title: 'Notes on the Analytical Engine' }] } },
    };
  };
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((op) => one(op as Record<string, unknown>));
    return { ...one(parsed as Record<string, unknown>), bodyText: text };
  } catch {
    return { seq: req.seq, error: 'invalid JSON', bodyText: text };
  }
}

const BLANK_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Blank</title></head><body><p id="status">ready</p></body></html>';

/** Inline script that counts Math.random calls (a seeded-RNG page) and fetches while the page parses. */
const RNG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>RNG</title><script>
window.__rngCalls = 0;
Math.random = function () { window.__rngCalls++; return 0.5; };
fetch('/api/echo/rng-parse?a=1');
fetch('/api/echo/rng-parse?b=2');
</script></head><body><p id="status">ready</p></body></html>`;

const PRERENDER_A = `<!doctype html><html><head><meta charset="utf-8"><title>A</title>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["/prerender-b"]}]}</script></head>
<body><a id="go" href="/prerender-b">to B</a></body></html>`;
const PRERENDER_B = `<!doctype html><html><head><meta charset="utf-8"><title>B</title><script>
window.__wasPrerendering = document.prerendering;
fetch('/api/echo/b-load');
</script></head><body><p id="status">ready</p></body></html>`;

function createHandler(
  kind: 'main' | 'cross',
  state: { seq: number; requests: LoggedRequest[]; crossOrigin: string; streams: Map<string, StreamRecord> },
) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      const parsed = new URL(url, 'http://localhost');
      const logged: LoggedRequest = {
        seq: ++state.seq,
        server: kind,
        method: req.method ?? 'GET',
        url,
        path: parsed.pathname,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      state.requests.push(logged);
      /** Send a complete body with an explicit Content-Length (like a typical static/API server). */
      const send = (status: number, headers: Record<string, string>, body: string | Buffer = '') => {
        const buf = typeof body === 'string' ? Buffer.from(body) : body;
        res.writeHead(status, { ...headers, 'content-length': String(buf.length) });
        res.end(buf);
      };
      const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
        send(status, { 'content-type': 'application/json; charset=utf-8', 'x-echo-seq': String(logged.seq), ...extra }, JSON.stringify(value));
      const p = parsed.pathname;

      if (p === '/app' && kind === 'main') {
        send(
          200,
          { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `${SESSION_COOKIE}; Path=/; SameSite=Lax`, 'cache-control': 'no-store' },
          appHtml(state.crossOrigin),
        );
      } else if (p === '/static/app.css') {
        send(200, { 'content-type': 'text/css; charset=utf-8' }, APP_CSS);
      } else if (p === '/static/app.js') {
        send(200, { 'content-type': 'text/javascript; charset=utf-8' }, 'window.appScriptLoaded = true;');
      } else if (p === '/static/extra.js') {
        send(200, { 'content-type': 'text/javascript; charset=utf-8' }, 'window.extraScriptLoaded = true;');
      } else if (p === '/api/html') {
        send(200, { 'content-type': 'text/html; charset=utf-8' }, PREVIEW_HTML);
      } else if (p === '/api/image') {
        const w = Math.min(Number(parsed.searchParams.get('w')) || 32, 512);
        const h = Math.min(Number(parsed.searchParams.get('h')) || 32, 512);
        send(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }, makePng(w, h));
      } else if (p === '/api/big') {
        json(200, JSON.parse(bigJson(Math.min(Number(parsed.searchParams.get('n')) || 2500, 50_000))));
      } else if (p === '/api/beacon' || p === '/api/nocontent') {
        res.writeHead(204);
        res.end();
      } else if (p === '/api/login') {
        json(200, { ok: true }, { 'set-cookie': `${HTTPONLY_COOKIE}; Path=/; HttpOnly; SameSite=Lax` });
      } else if (p === '/blank') {
        send(200, { 'content-type': 'text/html; charset=utf-8' }, BLANK_HTML);
      } else if (p === '/rng') {
        send(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, RNG_HTML);
      } else if (p === '/prerender-a') {
        send(200, { 'content-type': 'text/html; charset=utf-8' }, PRERENDER_A);
      } else if (p === '/prerender-b') {
        send(200, { 'content-type': 'text/html; charset=utf-8' }, PRERENDER_B);
      } else if (p === '/api/stream') {
        const id = parsed.searchParams.get('id') ?? String(logged.seq);
        const record: StreamRecord = { opened: Date.now() };
        state.streams.set(id, record);
        // Chunked, no Content-Length: a stream that never ends by itself (NDJSON / watch endpoint).
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        let n = 0;
        const write = () => res.write(`${JSON.stringify({ id, n: n++, pad: 'x'.repeat(200) })}\n`);
        write();
        const timer = setInterval(write, 100);
        res.on('close', () => {
          clearInterval(timer);
          record.closed = Date.now();
        });
      } else if (p === '/api/slowimg') {
        const ms = Math.min(Number(parsed.searchParams.get('ms')) || 0, 60_000);
        const timer = setTimeout(() => send(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }, makePng(8, 8)), ms);
        res.on('close', () => clearTimeout(timer));
      } else if (p === '/api/download') {
        send(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' }, 'a,b\n1,2\n');
      } else if (p === '/api/slow') {
        const ms = Math.min(Number(parsed.searchParams.get('ms')) || 0, 60_000);
        const timer = setTimeout(() => json(200, echoOf(logged)), ms);
        res.on('close', () => clearTimeout(timer));
      } else if (p === '/graphql') {
        json(200, graphqlEcho(logged));
      } else if (p === '/api/echo' || p.startsWith('/api/echo/')) {
        json(200, echoOf(logged));
      } else if (p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
      } else {
        json(404, { error: 'not found', path: p });
      }
    });
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Start the main and the cross-origin server on ephemeral ports. */
export async function startServers(): Promise<TestServers> {
  const state = { seq: 0, requests: [] as LoggedRequest[], crossOrigin: '', streams: new Map<string, StreamRecord>() };
  const main = http.createServer(createHandler('main', state));
  const cross = http.createServer(createHandler('cross', state));
  // Keep-alive sockets would keep close() waiting.
  main.keepAliveTimeout = 500;
  cross.keepAliveTimeout = 500;
  const [mainPort, crossPort] = await Promise.all([listen(main), listen(cross)]);
  const origin = `http://127.0.0.1:${mainPort}`;
  state.crossOrigin = `http://127.0.0.1:${crossPort}`;
  const closeOne = (s: http.Server) =>
    new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  return {
    origin,
    crossOrigin: state.crossOrigin,
    appUrl: `${origin}/app`,
    get requests() {
      return state.requests;
    },
    get streams() {
      return state.streams;
    },
    requestsTo(prefix, method) {
      return state.requests.filter((r) => r.path.startsWith(prefix) && (!method || r.method === method));
    },
    close: async () => {
      await Promise.all([closeOne(main), closeOne(cross)]);
    },
  };
}
