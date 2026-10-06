# kineReqLens React Native wire protocol — v1

The app (client, `@kinebot/kinereqlens-react-native`) opens **one WebSocket** to the receiver (server) on the
developer's machine and streams what it captures; the receiver can ask the app to replay requests.

- Default URL: `ws://<host>:8790/kinereqlens` (`DEFAULT_PORT`, `DEFAULT_PATH` in `src/protocol.ts`).
- Every WebSocket message is **one UTF-8 JSON text frame** with a string field `t` (type).
- Unknown `t` values must be ignored by both sides (forward compatibility). Binary WebSocket frames are not used.
- Types live in [`src/protocol.ts`](src/protocol.ts). The capture/replay payloads mirror the extension's
  `src/shared/types.ts` (`HookRequestStart`, `HookRequestEnd`, `SerializedBody`, `ReplayRequest`,
  `ReplayResult`), so the desktop side can feed them into the same store/UI. Keep both in sync.
- A reference receiver (Node, no dependencies) is in [`test/receiver.ts`](test/receiver.ts); run one by hand with
  `npm run receiver -- --token <token>` (in `react-native/`).

## Connection lifecycle

```
app                                   receiver
 | ---- WebSocket upgrade ------------> |   GET /kinereqlens (any other path: 404)
 | ---- {t:'hello', v:1, token, …} ---> |   first message, within 5 s (else close 4003)
 | <--- {t:'welcome', v:1} ------------ |   token ok + v === 1
 | ---- buffered captures … ----------> |   {t:'dropped'} first if the offline buffer overflowed
 | <--> captures / commands ----------> |
```

Rejection: the receiver sends `{t:'rejected', reason, code}` and closes with that code.

| close code | meaning | app behaviour |
|---|---|---|
| 4001 `BAD_TOKEN` | token missing or wrong | keeps retrying at the slowest backoff (receiver may restart with that token); status `rejected` |
| 4002 `BAD_HANDSHAKE` | first message not `hello`, or unsupported `v` | retries with backoff |
| 4003 `HANDSHAKE_TIMEOUT` | no `hello` in time | retries with backoff |
| 4004 `REPLACED` | (reserved) receiver replaced the connection | retries with backoff |

The app reconnects after any close with exponential backoff (500 ms doubling, max 30 s). Until `welcome`
it sends nothing but `hello`. The token is compared in constant time (reference receiver: SHA-256 +
`timingSafeEqual`). The receiver should show the token to the developer (it is configured in the app).

`session` (in `hello`) identifies one app JS context: it stays the same across reconnects and changes on every
app reload. A receiver can use it to merge a reconnecting app into the same list and to start a new list after
a reload.

### `hello` (app → receiver)

```jsonc
{
  "t": "hello",
  "v": 1,
  "token": "…pairing token…",
  "session": "k3j9x0a1bq",
  "lib": { "name": "@kinebot/kinereqlens-react-native", "version": "0.1.0" },
  "capabilities": ["http", "websocket", "replay", "open-ui"],
  "app": {
    "name": "DemoApp",                 // AppRegistry key (or config appName)
    "bundleId": "com.example.demo",    // `app=` param of the Metro bundle URL (or config); "" when unknown
    "platform": "ios",                 // "ios" | "android"
    "rnVersion": "0.76.3",
    "hermes": true,
    "deviceName": "Google Pixel 8",
    "osVersion": "14",                 // optional
    "emulator": false                  // optional, Android only (heuristic)
  }
}
```

### `welcome` (receiver → app)

`{ "t": "welcome", "v": 1, "server": { "name": "…", "version": "…" } }` (`server` optional).

## App → receiver messages

| `t` | payload | when |
|---|---|---|
| `hello` | see above | first message of every connection |
| `start` | `data: RnRequestStart` | a fetch / XHR request was sent (body produced) |
| `end` | `data: RnRequestEnd` | it finished (always after its `start`) |
| `ws-open` | `data: { wsId, url, protocols[], headers?, time }` | the app created a WebSocket |
| `ws-ready` | `data: { wsId, protocol, extensions?, time }` | its handshake completed (`open` event) |
| `ws-frame` | `data: RnWsFrame` | a message was sent (`dir:'out'`) or received (`dir:'in'`) |
| `ws-error` | `data: { wsId, message, time }` | `error` event |
| `ws-close` | `data: { wsId, code?, reason?, wasClean?, initiator:'client'\|'server', time }` | `close` event |
| `dropped` | `count` | captures evicted from the offline buffer since the last report (sent right after `welcome`) |
| `replay-result` | `data: RnReplayResult` | answer to a `replay` (exactly one per `runId`) |
| `open-ui` | — | dev menu "Open kineReqLens" / `openKineReqLens()`: open the standalone tab |
| `pong` | `id?` | answer to `ping` (echoes `id`) |

There is no `log` message in v1.

### `start` — `RnRequestStart` (≈ `HookRequestStart`)

```jsonc
{
  "hookId": "k3j9x0a1bq:12",   // `${session}:${n}`; unique per session, use with session/app to build entry ids
  "kind": "fetch",             // "fetch" | "xhr" — fetch() over RN's XMLHttpRequest is reported ONCE, as "fetch"
  "method": "POST",
  "url": "https://api.example.com/items?x=1",
  "headers": [{ "name": "content-type", "value": "application/json" }],  // as set by the app, in order
  "body": { "kind": "text", "text": "{\"a\":1}", "size": 7 },           // SerializedBody | null
  "contentType": "application/json",   // header, else implied by the body type (FormData, Blob type…)
  "startTime": 1727870000000,          // epoch ms
  "frameUrl": "",                      // always "" (no frames in an app)
  "options": { "credentials": "include" }   // fetch init options; plain XHR: withCredentials, responseType, timeout?
}
```

For fetch-over-XHR, `headers` are those the XHR actually received (React Native's fetch lower-cases names and
adds `content-type: text/plain;charset=UTF-8` for string bodies), and `options` holds the fetch init options.

### `end` — `RnRequestEnd` (≈ `HookRequestEnd`)

```jsonc
{
  "hookId": "k3j9x0a1bq:12",
  "state": "done",              // "done" | "error" | "aborted"
  "status": 201, "statusText": "Created",
  "headers": [{ "name": "Content-Type", "value": "application/json" }],
  "body": { "kind": "text", "text": "…", "size": 18 },
  "responseUrl": "https://api.example.com/items?x=1",
  "redirected": false,
  "responseType": "default",    // fetch Response.type when known
  "endTime": 1727870000123,
  "error": "Network error"      // when state != "done"
}
```

### Bodies — `SerializedBody` (same union as the extension)

- `{kind:'text', text, size, truncated?}` — UTF-8 text; `size` = full byte length before truncation.
- `{kind:'base64', base64, size, truncated?}` — binary (response mime not textual, or request bytes that are
  not clean UTF-8).
- `{kind:'formData', entries}` — FormData. React Native file parts (`{uri, name, type}`) are reported as
  `{type:'file', fileName, mime, size:-1, truncated:true, uri}` (contents are not read).
- `{kind:'unavailable', reason}` — e.g. `captureBodies: false`, `text/event-stream`, unreadable.

Caps (app config): request bodies 1 MB, response bodies 2 MB, WebSocket frames 256 KB by default. Above the
cap the body is cut (never inside a UTF-8 character) and flagged `truncated: true`.

### `ws-frame` — `RnWsFrame`

```jsonc
{ "wsId": "k3j9x0a1bq:ws3", "dir": "in", "opcode": "text", "text": "{\"op\":1}", "size": 8, "time": 1727870000456 }
{ "wsId": "k3j9x0a1bq:ws3", "dir": "out", "opcode": "binary", "base64": "AQID", "size": 3, "truncated": false, "time": … }
```

Frames of one socket are delivered in order (Blob payloads are read asynchronously but queued per socket).

## Receiver → app messages

| `t` | payload | effect |
|---|---|---|
| `welcome` | `v`, `server?` | handshake accepted; the app flushes its buffer |
| `rejected` | `reason`, `code?` | sent before closing with 4001/4002/4003 |
| `replay` | `data: RnReplayRequest` | run a request in the app, answer with `replay-result` |
| `abort` | `runId` | cancel a running replay (its result comes back with `aborted: true`) |
| `ping` | `id?` | app answers `{t:'pong', id}` |

### `replay` — `RnReplayRequest` (≈ `ReplayRequest`)

```jsonc
{
  "runId": "run-1",
  "method": "PATCH",
  "url": "https://api.example.com/items/1",
  "headers": [{ "name": "Authorization", "value": "Bearer …" }],
  "body": { "kind": "text", "text": "{\"v\":2}" },   // WireBody: none | text | base64
  "credentials": "include",                           // optional
  "redirect": "follow",                               // optional (ignored by RN's fetch)
  "timeoutMs": 30000,                                 // optional, default 30 s
  "responseBodyCap": 10485760                         // optional, default 10 MB
  // entryId / mode / frameId are accepted and ignored
}
```

The app runs it with its **original fetch** (the one in place before kineReqLens patched it), so it goes
through the app's own networking stack. Replays are never reported as captures. React Native has no forbidden
request headers, so every header is sent (`droppedHeaders` is not used).

### `replay-result` — `RnReplayResult` (≈ `ReplayResult`)

`{ runId, ok, status, statusText, headers, body, url, redirected, type?, timing:{start, headers?, end}, size,
error?, errorHint?, aborted?, timedOut? }` — `ok` is true when a response (any status) arrived. An invalid
request that has a `runId` gets `{ ok:false, error:'Invalid replay request' }`.

## What the app never captures

- Its own connection to the receiver (same host/port and a path under the receiver path).
- Metro / Expo CLI dev endpoints on the Metro origin (from `NativeModules.SourceCode.scriptURL`) **or any
  host on port 8081**: `/symbolicate`, `/logs`, `/hot`, `/message`, `/events`, `/inspector`, `/json`,
  `/debugger-*`, `/status`, `/open-stack-frame`, `/open-url`, `/open-debugger`, `/reload`,
  `/launch-js-devtools`, `/onchange`, `*.bundle`, `*.map`, `/assets/`, `/_expo/`, `/expo-dev-plugins`. Other
  paths on the Metro origin (e.g. Expo Router API routes) are captured.
- React DevTools (port 8097).
- `ignoreUrls` entries: a string matches as a substring of the URL, a RegExp is tested against it.

## Offline buffer

While not connected the app keeps up to `bufferSize` (default 500) **captures** (all messages of one request or
one WebSocket count as one capture; at most ~20 messages per capture on average). Overflow evicts the oldest
capture entirely (and drops its later messages); the number evicted is reported with `{t:'dropped', count}`
right after the next `welcome`.
