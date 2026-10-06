# kineReqLens — Architecture & Build Spec

kineReqLens is a Manifest V3 extension for Microsoft Edge (and any Chromium browser ≥ 116). Clicking the toolbar
button (or **Alt+Shift+L**) opens an **always-on-top overlay over the page** that lists every HTTP request
the page makes. Selecting a request shows it **decomposed into editable sections** — method, URL, each query
parameter, each header, and the body split into its fields (JSON keys/sub-objects, GraphQL query/variables,
form fields, multipart parts). Every field can be edited, toggled, added or removed, with **revert to
default** per field, per section and for the whole request. **Send** fires the edited request and the
**test visualizer** shows the response (status, timing, size, headers, pretty/raw/preview body, diff against
the original response, history of runs).

**v0.2** adds (spec: [docs/specs/v0.2.md](specs/v0.2.md), summary in §8): an **Export** tab (types as
TypeScript / Zod / JSON Schema and a ready-made agent prompt, inferred from the captured request, response and
test runs, secrets redacted), a **Claude Code bridge** (a local MCP server + native messaging hub so Claude Code
can list / inspect / type / replay captured requests and receive "Send to Claude Code" items), and a
**request-row context menu** with path-prefix **URL rules** ("Hide / Show only requests under ▸").

This document is the contract every module is built against. Shared types live in
`src/shared/types.ts`, the message protocol in `src/shared/messages.ts`, constants in
`src/shared/constants.ts`. Typed stubs exist for every cross-module API — **implement the stubs, do not
change their exported signatures** (adding new exports is fine). If a contract is genuinely wrong, keep the
signature compatible and note it in your final report.

---------------------------------------------------------------------------------------------------------

## 1. Requirements

### Must have
1. **Overlay** — a host element in the page with a closed Shadow DOM (open only in the `--e2e` build) holding a
   single **cross-origin iframe** (`panel.html`, an extension page) that draws the whole UI, so nothing kineReqLens
   shows is part of the page's DOM (§4.4, §5). Above all page content (top layer via `popover="manual"` +
   `showPopover()`, fallback `z-index: 2147483647`); inside a page's modal `<dialog>` / fullscreen element while
   one is shown, so it stays usable. Floating window (drag by header, resize from edges/corner; default size
   follows the viewport, at most 1200×820) or docked left / right / bottom (still an overlay — never pushes page
   layout). Minimize to a small draggable pill showing the request count. Opacity setting (see-through).
   Light/dark/auto theme, forced-colors (Windows contrast themes) aware. Layout persists (chrome.storage.local).
   Open/closed state is per tab and **persists across reloads/navigations in that tab** (prerendered pages
   included, once activated).
2. **Capture** — all requests of the page:
   - `fetch`, `XMLHttpRequest`, `navigator.sendBeacon` via a MAIN-world hook (full request incl. body,
     full response incl. body) in all frames, from `document_start`, so page-load requests are captured
     when the overlay was already open (reload) — the hook buffers until the content script tells it
     whether this tab is recording.
   - Everything else (documents, form posts, scripts, styles, images, fonts, media, pings, worker fetches)
     via `chrome.webRequest` in the service worker (request headers as actually sent, request body,
     status, response headers — no response body).
   - webRequest events for fetch/XHR are **merged** into the matching hook entry (`entry.wire`), not
     listed twice (also for requests of about:blank iframes, which webRequest attributes to an ancestor frame).
   - webRequest entries are attributed to the top-level **document** they belong to, so a navigation never hands
     one page's requests (or the previous page's unload beacons) to the other (§4.3).
   - Requests kineReqLens itself sends (replays) never appear in the captured list.
3. **Request list** — newest first; method badge, status (spinner while pending), name (endpoint template with
   id chips, width-elided, query names — §8.3.2; "Full path" setting: raw path + query), host, type, duration,
   size; tooltip with full URL; optional "Group by endpoint". A call that failed shows the failure
   marker even when the network answered (status in the tooltip). Text filter (space-separated terms, all must
   match url/method/status; `-term` excludes), a "Types" dropdown (multi-select Fetch/XHR, Doc, JS, CSS, Img, Media,
   Font, Other or All types; default Fetch/XHR, persisted in `settings.listTypes`; requests the user made and the
   selected entry pass every type), record/pause, preserve log, clear,
   "+ New request" (blank manual entry), count.
   Marks entries that have an edited draft (dot) and test runs (count). Virtualized beyond ~200 rows.
   Keyboard: ↑/↓ moves selection. Banner when capture started late: "Reload to capture page-load requests"
   (a dismissal holds for the page). Entries the user holds work for — the selected one, edited drafts, test
   runs, manual entries — are never evicted at `maxEntries`.
4. **Editor** (for the selected entry; a draft is created lazily and kept per entry while the page lives):
   - Request line: method select (GET POST PUT PATCH DELETE HEAD OPTIONS + custom), URL input showing base +
     `#hash` (typing `?k=v` after the base adds params, a `#…` only changes the hash; replacing the whole field
     with a URL that has a query string — paste or select-all + type — re-parses the Params table), computed
     full-URL preview, **Send** (Ctrl/Cmd+Enter anywhere in the panel), mode select **Page** (run in the page:
     same cookies/origin/CORS as the app) /
     **Extension** (service worker: bypasses CORS; forbidden headers like Cookie/Origin/Referer applied via a
     temporary declarativeNetRequest session rule), options (credentials, redirect, timeout),
     overflow menu (Copy as cURL, Copy as fetch, Revert all).
   - **Params** section: one row per query parameter (duplicates kept, order kept): enable checkbox, key,
     value, modified marker, per-row revert, delete; add row; bulk-edit toggle (textarea `k=v` lines). Without
     params it starts collapsed to one line.
   - **Headers** section: same table. Browser-controlled (forbidden) headers show a lock + warning in Page
     mode. A collapsed read-only "Headers sent by the browser" list when `entry.wire.requestHeaders` exists.
   - **Body** section with type select (None, JSON, Form, Multipart, Text, Binary) and view toggle
     **Fields / Raw**:
     - JSON: each top-level key (or array item) is its own collapsible **section card**; nested
       objects/arrays render as collapsible groups; each leaf row has key input, type select
       (string/number/boolean/null/object/array), value editor (input; textarea for long/multiline strings;
       checkbox for boolean), modified marker + revert, duplicate, delete; "+ add field" in every container.
       Big numbers are preserved exactly (lossless parser). Invalid number literals are flagged and block Send.
     - GraphQL (JSON flavor): sections **Query** (monospace code textarea), **Variables** (JSON tree),
       **Operation name**, **Extensions**, plus any other keys. Batched operations: one group per item.
     - Form (urlencoded): key/value table like Params.
     - Multipart: one row per part — name, text value or file (name, type, size, "Replace file…" picker);
       enable/disable, revert, delete, add text part / add file part.
     - Text: monospace textarea. Binary: size + type, "Replace with file…", "Edit as text" when decodable.
     - Raw view: textarea of the serialized body; valid edits re-sync into Fields (ids aligned so modified
       markers stay correct; disabled form rows / multipart parts, which the text cannot show, are kept);
       invalid JSON shows the parse error with line:column and blocks Send (also a large edit whose parse is
       still pending), and counts as a modification so the section revert / Revert all discard it.
   - **Revert**: per field/row, per section (↺ on the section header) and **Revert all** (header button,
     visible + counted when anything is modified). Unmodified sections are sent **verbatim** (byte-exact URL
     and body as originally captured: a body captured without Content-Type is sent without one, a FormData body
     is encoded like the browser does, CRLF line breaks included).
   - Warnings list above Send (from `draftWarnings`).
5. **Test visualizer** (results area beside/below the editor; side by side when the detail pane is ≥ 800px
   wide, or ≥ 720px when it is shorter than 640px (bottom dock, small screens); stacked with a draggable divider
   otherwise, the editor taking most of the height until the first run):
   - Active run: status pill, status text, duration, size, content-type, mode used, final URL if redirected,
     `appliedViaDnr`/`droppedHeaders` notes; spinner + **Cancel** while running; error + hint on failure.
   - Body: **Pretty** (collapsible read-only JSON tree with expand/collapse all and filter; pretty XML/HTML
     falls back to raw), **Raw** (wrap toggle, copy), **Preview** (HTML in a `sandbox=""` iframe via
     `srcdoc`; images via blob URL). Large bodies render progressively ("Show more").
   - Headers table (copy).
   - **Compare**: line diff of the run vs the original captured response (or vs the previous run) with
     +/− counts.
   - **Request sent**: method, URL, headers, body of the run (+ Copy as cURL), and a note naming the
     `Cache-Control` / `Pragma: no-cache` headers the browser adds to test requests (they bypass the HTTP cache).
   - **History**: runs newest first (time, status, duration); select to view; clear. Starts collapsed when the
     results pane is short (< 420px); the user's toggle wins.
   - Results area tabs, in order: **Original response** (captured response of the entry; the tab every entry opens
     on) | **Export** | **Initiator** | **Test result** (brought to the front when a run starts, except from Export).
     The outer tab strip is owned by `detail/RequestDetail.tsx` (`rl-original-tab` / `rl-test-tab`); `response/ResultsPanel`
     renders the Test result tab (Body | Headers | Compare | Request sent of the active run + history) and the
     Original tab is a `ResponseView` of `entryToResponseDataWith(entry, {captureResponseBodies})`.
   - Send options default to the captured request: `credentials` follows the page's fetch `credentials` / XHR
     `withCredentials` (`RequestEntry.requestOptions`), else `same-origin` for hook captures and `include` for
     beacons, webRequest and manual entries; Extension mode uses `include` unless the page used `omit`
     (`defaultCredentials` in `detail/draftStore.ts`). A user override sticks per draft; Reset returns to auto.

### Nice to have (implement if cheap, never at the expense of the above)
Duplicate a captured request as a new manual entry (implemented: More menu → "Duplicate as new request" forks the
request as it would be sent now, edits included, via `bridge.addManualEntry(ManualEntryInit)`; manual bodies are
capped at `MANUAL_BODY_CAP` (50 MB, the replay limit), not at the capture cap); resize
list/detail columns (implemented); remember collapsed sections (implemented, in memory for the page lifetime).

---------------------------------------------------------------------------------------------------------

## 2. Runtime architecture

```
 ┌──────────── page (every frame) ─────────────┐        ┌──────── service worker (background.js) ───────┐
 │ MAIN world: hook.js                          │        │ tab state + preserved logs (storage.session)   │
 │  patches fetch / XHR / sendBeacon            │        │ chrome.webRequest capture  ──WR_ENTRIES──┐     │
 │  buffers until told mode on/off              │        │ subframe relay, ui.js injection         │     │
 │  runs page-mode replays (native fetch)       │        │ extension-mode replay (fetch + DNR)     │     │
 │        ▲  private MessagePort                │        └───────▲──────────────────────────────────┼─────┘
 │        ▼                                     │                │ chrome.runtime / chrome.tabs     │
 │ ISOLATED world: content.js                   │◄───────────────┘                                  │
 │  top frame: store + bridge (globalThis.__reqlens) ◄──────────────────────────────────────────────┘
 │  subframes: relay hook messages via SW       │
 │  ui.js (top frame only, injected on demand): │
 │   <reqlens-overlay> host, closed shadow root │   chrome.runtime Port (tabs.connect, nonce)
 │   └ iframe chrome-extension://…/panel.html ──┼─► panel.js: Preact UI + RemoteBridge (mirrors the bridge)
 └──────────────────────────────────────────────┘
```

v0.2, the Claude Code bridge (§8):

```
 Claude Code ──stdio MCP──► reqlens-mcp serve (one per session) ──NDJSON, $REQLENS_HOME/hub.sock (0600)──┐
                                                                                                         ▼
 service worker ◄──native messaging (connectNative 'com.reqlens.bridge')──► reqlens-mcp native-host (hub)
   │ BRIDGE_LIST / BRIDGE_ENTRY (chrome.tabs.sendMessage, top frame)   → content.js store
   └ panel link Port 'reqlens-claude-link' (selection, drafts, runs, Claude's sends, "Send to Claude Code") → panel.js

 Embedded Claude Code terminal (§8.4, docs/CLAUDE_INTEGRATION.md): panel.js xterm.js ⇄ panel link (pty-*) ⇄ worker
 relay (owner per id, 10 s reload grace, ~200 KB replay) ⇄ native messaging ⇄ hub ⇄ node-pty ⇄ `$SHELL -l -i -c 'exec claude'`
```

### 2.1 Startup / toggle sequence
1. Manifest injects `hook.js` (MAIN) and `content.js` (ISOLATED) at `document_start` in all frames.
2. hook.js installs wrappers immediately in **buffering** mode (keeps ≤ `HOOK_BUFFER_MAX` captures, gives up
   after `HOOK_BUFFER_TIMEOUT_MS` → off), posts `{__reqlens__: 'hello'}`.
3. content.js creates a `MessageChannel`, posts `{__reqlens__: 'connect'}` with the port (and again on every
   'hello'), then sends `GET_TAB_STATE` to the SW. It sends `{t:'mode', mode: open && recording ? 'on' : 'off', config}`
   to the hook. 'on' flushes the buffer; 'off' clears it and makes wrappers pure pass-through.
4. Top frame: the store is seeded with the webRequest entries the SW buffered for this document (`GET_TAB_STATE`
   attaches the document, §4.3) and with the preserved log when `preserveLog` (read through `PRESERVE_READ`).
   If `open`, it sends `LOAD_UI` → SW `chrome.scripting.executeScript({files:['ui.js']})` into the sender's
   document → ui.js reads `globalThis.__reqlens`, creates the overlay host with the `panel.html#<nonce>` iframe and
   serves the bridge to it (§4.4). A prerendered page (whose main frame is not frame 0 yet) repeats the
   `GET_TAB_STATE` / `LOAD_UI` / badge steps on `prerenderingchange`.
5. Toolbar click / Alt+Shift+L → SW `toggle(tab)`: flips `open` (opening also sets `recording: true`),
   persists, sends `TAB_STATE` to all frames. If no content script answers (page loaded before install, or
   extension reloaded), the SW injects `hook.js` (world MAIN) + `content.js` into all frames and resends.
   Restricted pages (edge://, chrome://, extension galleries, view-source:, PDF viewer) → badge `×` and
   title "kineReqLens can't run on this page". `globalThis.__reqlensToggle(tab)` is exposed in the SW for E2E tests.
6. Closing the overlay (× button) sets `open: false` → hook mode off (response reads in progress stop at once);
   entries stay in memory for this page; webRequest entries still pending are settled as aborted ("Not tracked
   while kineReqLens was closed": the SW stops tracking the tab).

### 2.2 Subframes
Subframe content scripts never mount UI. They forward hook messages with `FRAME_CAPTURE`; the SW relays them
to frame 0 as `FRAME_CAPTURE_RELAY` with `frameId`. Page-mode replays for an entry with `frameId ≠ 0` go
content(top) → SW `REPLAY` → `REPLAY_IN_PAGE` to that frame → its hook → result back.

### 2.3 Replay routing (bridge.replay)
- `mode:'page'` and `frameId === 0` → local hook over the port (`{t:'replay'}` → `{t:'replay-result'}`),
  safety timeout `timeoutMs + 5000`. Hook not connected → resolve error "Page hook unavailable on this page —
  use Extension mode".
- otherwise → SW `REPLAY`.
- Before dispatching a page-mode replay the store registers `{runId, method, url, start}` so the matching
  webRequest `xhr` event is swallowed (never listed). Only events that started at or after `start` qualify (the
  page's own identical request whose batch arrives late is merged, not swallowed). The first same-method match
  consumes the registration (a later identical page request is listed again), but it keeps swallowing the
  replay's CORS preflight (`OPTIONS`) until it expires (completion + 10 s): Chrome reports the actual request's
  `onBeforeRequest` before it sends the preflight.
- `abortReplay(runId)` → hook `{t:'abort'}` or SW `ABORT_REPLAY`.

### 2.4 Store (content/store.ts, top frame)
- `Map<id, RequestEntry>` with immutable entry updates (unchanged entries keep identity).
- Hook 'start' → `entryFromHookStart`; then `findWebRequestMatch` to absorb an already-listed wr entry.
- Hook 'end' → `applyHookEnd`.
- `WR_ENTRIES` upserts (idempotent full snapshots). For kind `xhr`/`ping`: swallowed if it matches a
  registered replay; merged via `findHookMatch` + `mergeWire` if a hook entry matches (and later snapshots of
  the same requestId keep merging into that hook entry); otherwise listed (e.g. worker fetches). Matching is
  causal: the network request starts no earlier than the JS call (2 ms slack) and within 3 s of it, a call that
  had already failed before it cannot be its match, and identical calls pair in call order (FIFO). A call that
  failed without a status never takes the network's status.
- Validates every MAIN-world payload with `isValidHookStart/End`; caps bodies with `capBody`.
- Evicts with `pickEvictions` beyond `settings.maxEntries`, never touching manual entries or the ids the UI
  marks as protected (`bridge.setProtectedEntries`: selected entry, edited drafts, test runs).
- Notifies subscribers coalesced (≤ 1 per animation frame / 50 ms).
- Badge: debounced `SET_BADGE` with the entry count.
- Preserve log: when `tabState.preserveLog`, debounced (1 s) write of the last `PRESERVED_LOG_MAX` entries via
  `toPreserved` (credential header values — Cookie, Authorization, Proxy-Authorization, Set-Cookie — replaced by
  `[not kept in the preserved log]`) through `PRESERVE_WRITE`; loaded on start as `restored` entries
  (`PRESERVE_READ`); cleared by "Clear" or when preserve log is turned off (`PRESERVE_CLEAR`). The SW stores it in
  `chrome.storage.session[preservedLogKey(sender.tab.id)]`, which stays at `TRUSTED_CONTEXTS` (content scripts
  cannot read or write storage.session; the SW sets the level explicitly at startup). A restored hook capture
  replaces the SW's restored copy of the same request.

---------------------------------------------------------------------------------------------------------

## 3. File ownership

| Agent | Owns (create/modify only these) |
|---|---|
| lib-core | `src/lib/{encoding,kv,url,headers,format,curl,diff}.ts`, `tests/unit/{encoding,kv,url,headers,format,curl,diff}.test.ts` |
| lib-json | `src/lib/json-tree.ts`, `tests/unit/json-tree.test.ts` |
| lib-body | `src/lib/{multipart,body,draft,capture}.ts`, `tests/unit/{multipart,body,draft,capture,flow}.test.ts` |
| capture-page | `src/injected/**`, `src/content/**`, `tests/unit/store.test.ts` |
| capture-bg | `src/background/**`, `static/**` (icons), `scripts/gen-icons.mjs`, `scripts/zip.mjs`, `tests/unit/bg-*.test.ts` |
| ui-shell | `src/ui/App.tsx`, `src/ui/hooks.ts`, `src/ui/list/**`, `src/ui/components/**`, `src/ui/styles/**`, `tests/unit/list-*.test.ts` |
| ui-editor | `src/ui/detail/**` |
| ui-response | `src/ui/response/**`, `tests/unit/response-*.test.ts` |

Later additions: `src/ui/frame/**` (in-page overlay host + panel server, ui.js), `src/ui/panel/**` (panel.js:
RemoteBridge, hit regions, UI-state hand-over), `src/ui/shellState.ts`, `src/shared/panel-protocol.ts`,
`static/panel.html`, `src/background/preserve.ts`, `src/injected/cancelFollow.ts`, `src/ui/detail/sendAction.ts`.

v0.2 additions: lib-typegen `src/lib/typegen.ts`; lib-prompt `src/lib/{endpoint,redact,agentPrompt}.ts`;
mcp-server `mcp/**`, `scripts/build-mcp.mjs`, `tests/unit/mcp-*.test.ts`; bridge-ext `src/background/claude/**`,
`src/content/claude.ts`, `src/ui/panel/claudeLink.ts`, `tests/unit/bridge-*.test.ts`; ui-export
`src/ui/export/**`; ui-list-menu `src/ui/list/{rules,listState,rowMenu,rowActions,ruleActions,RowContextMenu,
RulesBar,scroller}.*`, `src/ui/components/ContextMenu.tsx`; integrator `tests/e2e/{list-menu,export,
claude-bridge}.spec.ts`, `src/shared/claude-{protocol,link}.ts`.

Shared files (`src/shared/**`, `package.json`, `tsconfig.json`, build/test configs, `docs/ARCHITECTURE.md`)
and the E2E suite (`tests/e2e/**`) are owned by the integrator — do not edit them; request changes in your final report. **Do not add npm
dependencies.** Available: `preact` (+ `preact/hooks`), dev: typescript, esbuild, vitest, @playwright/test,
@types/chrome, @types/node.

Agents run in parallel; other agents' stubs may still `throw new Error('not implemented')` while you work.
Type-check with `npx tsc --noEmit -p tsconfig.json` and only fix errors in files you own. Unit tests:
`npx vitest run tests/unit/<file>.test.ts`.

---------------------------------------------------------------------------------------------------------

## 4. Module specs

### 4.1 hook.js (`src/injected/hook.ts`, MAIN world, classic IIFE)
- Guard against double install: `Symbol.for('reqlens.hook.v1')` on `window`; if present, do nothing (the
  existing hook accepts the new content script's 'connect').
- Capture native references at install (fetch, XMLHttpRequest.prototype.open/send/setRequestHeader,
  addEventListener, sendBeacon, Response.prototype.clone, MessagePort.prototype.postMessage, TextDecoder,
  Headers, Request, URL, FormData.prototype.entries, Blob.prototype.arrayBuffer, AbortController, setTimeout).
- Wrappers keep `name`/`length` and return native-looking `toString()` (`function fetch() { [native code] }`),
  also when another realm's `Function.prototype.toString` is applied to them (every frame runs the same bundle,
  so the replacement recognises the wrapper source of other realms). Capture ids come from a counter and a tag
  taken once at install (`crypto.getRandomValues`): the hook never calls page globals such as `Math.random` at
  call time.
- **Never break the page**: every capture step is inside try/catch; the native call happens first-class and
  unchanged; the wrapper returns the *same* promise native fetch returned.
- fetch snapshot (synchronous part before calling native):
  - Request input: method/url/headers from the Request (+ init overrides); body: if `init.body` given use it,
    else if the Request has a body `input.clone()` **before** calling native fetch, read it async.
    Never construct `new Request(input, init)` from a Request with a body (it disturbs the page's body).
  - String/URL input: resolve against `document.baseURI`; method from init (normalize like fetch: upper-case
    only DELETE/GET/HEAD/OPTIONS/POST/PUT); headers keep the page's casing when init.headers is an object or
    array, Headers instances iterate lower-cased.
  - Body → SerializedBody: string → text; URLSearchParams → text (+ implicit content type
    `application/x-www-form-urlencoded;charset=UTF-8`); FormData → `formData` entries (snapshot entries
    synchronously; read file contents async up to `FILE_CAPTURE_CAP`; a text value cut at the cap is marked
    `truncated: true`, so the draft knows a verbatim resend is lossy) (+ implicit `multipart/form-data`);
    Blob → bytes (implicit type = blob.type); ArrayBuffer/views → **copy synchronously**; ReadableStream →
    unavailable; other → `String(body)`. Bytes become text when `tryDecodeUtf8` succeeds, else base64.
    Respect `requestBodyCap`.
  - `contentType` = explicit Content-Type header else the implicit one.
- fetch response: `.then` attached immediately (so it runs before page handlers) → `res.clone()` → stream-read
  with cap (`responseBodyCap`), cancel the reader at the cap (truncated). A tee only cancels the network stream
  when both branches are cancelled, so kineReqLens' read must never hold a connection the page gave up:
  `ReadableStream.prototype.getReader` / `cancel` and the readers' `cancel` are wrapped (cancelFollow.ts) and a
  page cancel of its branch cancels kineReqLens' branch; responses without Content-Length (streams) are read for at
  most 5 s (`STREAMING_RESPONSE_READ_WINDOW_MS`, others 60 s); switching capture off stops every read at once
  (captures already sent end with what was read). Skip body when `captureResponseBodies` is false, for
  `text/event-stream`, `multipart/x-mixed-replace`, or opaque responses. Textual mime → text (TextDecoder, non-fatal) else base64. Record status, statusText, headers,
  url, redirected, type. Rejection → state error (AbortError → aborted).
- 'start' is posted once the request body snapshot is serialized; 'end' is always posted after 'start'.
- XHR: per-instance state in a WeakMap (`open` resets it); `setRequestHeader` appends; `send` records start
  (Document bodies serialize; implicit types per XHR spec); `loadend` → status, statusText,
  `getAllResponseHeaders()` (parseHeaderBlock), `responseURL`, body by `responseType` ('' / text →
  responseText, json → JSON.stringify(response), arraybuffer → bytes, blob → async read, document →
  XMLSerializer). abort/error/timeout listeners set the end state.
- sendBeacon: record start (kind 'beacon') and an immediate end `{state:'done'}` with no status.
- Page replay (`{t:'replay'}`): native fetch with `{method, headers, body (text — as UTF-8 bytes when no
  Content-Type header is sent, so fetch adds no `text/plain` — or decoded base64 bytes), credentials, redirect,
  signal, cache:'no-store'}`; timeout via AbortController; headers appended one by one
  (invalid → `droppedHeaders`; forbidden ones are also reported in `droppedHeaders`); full body read up to
  `responseBodyCap`; timing start/headers/end. Errors: TypeError → `errorHint` mentioning CORS / mixed content
  / CSP connect-src / network and suggesting Extension mode; timeout → `timedOut`; user abort → `aborted`.
  Replays use the saved native fetch so they are never captured.

### 4.2 content.js (`src/content/*`, ISOLATED world, every frame)
- Replace semantics: if `globalThis.__reqlens` exists from a previous instance, call its `dispose()` first.
- `lateInjection` = `document.readyState !== 'loading'` at start (manifest injection happens while loading);
  it also becomes true when capture was off once the tab state first became known (overlay closed or
  paused) and is switched on later — either way the page-load requests were missed (late banner).
- Hook port management (§2.1), mode/config pushes on every tab-state or settings change.
- Settings: read `chrome.storage.local[SETTINGS_KEY]` merged over `DEFAULT_SETTINGS` (`mergeSettings`),
  follow `chrome.storage.onChanged`; `updateSettings` writes the merged object.
- `chrome.runtime.onMessage`: TAB_STATE, WR_ENTRIES (top), FRAME_CAPTURE_RELAY (top), REPLAY_IN_PAGE (any
  frame; async `sendResponse`, `return true`), ABORT_IN_PAGE, PING; top frame (v0.2, src/content/claude.ts):
  BRIDGE_LIST `{countOnly?}` (entry summaries) and BRIDGE_ENTRY `{id}` (one full RequestEntry) for the Claude
  Code bridge.
- Prerendered top documents (`document.prerendering`): on `prerenderingchange` the tab state is read again
  (entries, preserved log, badge, LOAD_UI) — the SW refused them while the main frame was not frame 0.
- Top frame: store (§2.4), bridge on `globalThis.__reqlens` implementing `ReqlensBridge`, UI loading via
  `LOAD_UI` whenever `open` becomes true and ui.js is not loaded yet. `reloadPage()` → `location.reload()`.
- `addManualEntry(init?: ManualEntryInit)` creates `{source:'manual', kind:'manual', method:'GET',
  url: location.origin + '/', state:'done'}`, or a copy of `init` (method, url, headers, body, contentType —
  validated like hook data, body capped at `MANUAL_BODY_CAP`; `init.id` is used when it is a free `m:` id, so a
  UI behind a message channel knows the id synchronously). `setProtectedEntries(ids)` updates the eviction
  protection.
- Hook captures keep the page's fetch/XHR options as `RequestEntry.requestOptions` (seeds replay credentials).
- `globalThis.__reqlensUi` (`UiMountRecord` in `shared/types.ts`, `{bridge, destroy()}`) is left by a mounted
  ui.js; content.js uses it for LOAD_UI dedupe and PING `hasUi`, and destroys that UI when it is disposed.
- Handle "Extension context invalidated" (extension reloaded) gracefully: stop using chrome APIs, keep the
  page working.

### 4.3 background.js (`src/background/*`)
- Register every listener synchronously at top level (MV3).
- Tab state in `chrome.storage.session[tabStateKey(tabId)]` (default `DEFAULT_TAB_STATE`), mirrored in memory;
  `recordingTabs` = open && recording. Events that arrive before the async load completes are queued.
- webRequest (filter `<all_urls>`, only tabs in `recordingTabs`, ignore tabId -1, prerendering documents and the
  overlay's own `chrome-extension://<id>/` frame): onBeforeRequest
  (`requestBody`), onSendHeaders (`requestHeaders`, `extraHeaders`), onHeadersReceived (`responseHeaders`,
  `extraHeaders`; status line → statusText), onBeforeRedirect (redirected, responseUrl), onCompleted (done,
  fromCache, ip, endTime), onErrorOccurred (error; `net::ERR_ABORTED` → aborted). Builds full
  `RequestEntry` snapshots (`id: 'w:'+requestId`, `source:'webRequest'`, `kind: mapResourceType`,
  `wire: {requestId, type, ...}`, `pageUrl: ''` — the store fills it) and batches changed ones every 150 ms.
  Per-tab buffer (≤ 1000); each entry is owned by a top-level **document**: `documentId` for requests of the
  outermost frame, `parentDocumentId` (followed up the frame tree) for subframes; a top-level navigation request
  belongs to no document yet and is held. `GET_TAB_STATE` from a top frame attaches its document
  (`attachDocument`): held navigations become its own, entries of previous documents are dropped — or, with
  preserve log, handed over as `restored` entries of their page, credentials redacted — and the document's
  entries are returned. A navigation that settles without a new document attaching (download, 204, error page)
  is handed to the current document after 2 s (`WR_NAV_SETTLE_MS`; 10 s if it stays pending). Batches go to
  their document only (`chrome.tabs.sendMessage(tab, msg, {documentId})`; frame 0 when the owner is unknown
  after a SW restart); flushes of a tab are serialized and read each entry's latest snapshot when its chunk is
  sent, so a slow top frame never receives an older snapshot after a newer one. Body caps from settings.
- Messages: GET_TAB_STATE, SET_TAB_STATE (persist, broadcast TAB_STATE to all frames, update badge/recording),
  LOAD_UI (executeScript ui.js into the sender's document), FRAME_CAPTURE (relay), REPLAY, ABORT_REPLAY,
  SET_BADGE, PRESERVE_READ / PRESERVE_WRITE / PRESERVE_CLEAR (top frame only, key from `sender.tab.id`, payload
  validated and bounded), PANEL_TAB (from the overlay panel page only: its tab id). Only accept messages from
  this extension's contexts in a tab (`sender.id === chrome.runtime.id`, `sender.tab`).
- Extension-mode replay: `fetch` with credentials/redirect/AbortController timeout, `cache:'no-store'`; body
  text (as UTF-8 bytes when no Content-Type header is sent) or decoded bytes. Forbidden headers (`isForbiddenRequestHeader` and not `isUnsafeToOverride`) are
  applied through a temporary DNR session rule: unique id, `priority: 1`, action `modifyHeaders`
  (`set` each), condition `{ regexFilter: '^' + escaped(url) + '$' (fallback urlFilter '|'+url+'|'),
  initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest','other'], requestMethods: [method]
  (or omitted for non-standard), tabIds: [chrome.tabs.TAB_ID_NONE] }`; removed in `finally`; DNR-using replays
  are serialized (mutex); all replay session rules (ids below `LANGUAGE_RULE_ID_BASE`; the "Site language" rules of
  §11 above it are kept) are cleared on SW startup. Report `appliedViaDnr`.
  Unsafe headers → `droppedHeaders`. Body read up to `responseBodyCap`; textual → text else base64.
- Badge: count per tab (`999+`), cleared when closed; `×` on restricted pages. Clean up on `tabs.onRemoved`.
- `globalThis.__reqlensToggle = toggle` for tests.
- Claude Code bridge (v0.2, `src/background/claude/`, §8): `registerClaudeBridgeListeners` at top level
  (runtime.onConnect for panel links, permissions.onAdded/onRemoved, storage.onChanged, tabs.onActivated /
  onRemoved / onReplaced, windows.onFocusChanged); `ClaudeBridge.start()` reconnects after every worker start when
  `settings.claudeBridge` is on and the `nativeMessaging` permission is granted (a required manifest permission, so it
  is granted at install; the worker still checks it). E2E builds expose
  `globalThis.__reqlensClaudeStatus()`. Embedded terminals (`claude/pty.ts`, §8.4) are relayed between panel links and
  the native port; turning the bridge off kills them all.
- Icons: `scripts/gen-icons.mjs` writes `static/icons/icon-{16,32,48,128}.png` (pure Node, zlib-encoded PNG;
  lens/magnifier glyph over brackets, accent `#4f46e5`). `scripts/zip.mjs` zips `dist/` into
  `reqlens-<version>.zip` (pure Node, deflate) for the Edge Add-ons store.
- Fonts: `static/fonts/` holds Lato Regular / Semibold (the Kinebot app font) and its SIL OFL 1.1 license; the build
  copies it to `fonts/`. `panel.html` and `app.html` declare the `@font-face` rules at document level (adopted
  shadow-root sheets cannot declare fonts); the page-side layers of `ui.js` keep system fonts (not web-accessible).

### 4.4 UI (`src/ui/**`): ui.js (in-page host) + panel.html / panel.js (Preact UI in an extension frame)
- **Why a frame**: a closed shadow root does not hide text from `window.find()` / `Selection.modify()`, so any
  text drawn in the page's DOM (HttpOnly cookies from webRequest headers, other origins' subframe traffic,
  Extension-mode responses read cross-origin with the user's cookies) would be readable by page scripts. The UI
  runs in `panel.html`, a web-accessible extension page in a cross-origin iframe: find/selection, key and
  pointer listeners of the page never reach it.
- `frame/host.ts` (ui.js): creates `<reqlens-overlay>` on `document.documentElement` with inline `!important`
  styles (`position:fixed; inset:0; width:auto; height:auto; margin:0; padding:0; border:0; background:transparent;
  overflow:visible; pointer-events:none; z-index:2147483647; display:block; color-scheme: normal; zoom`), then
  `popover='manual'` + `showPopover()` when supported. `attachShadow({mode: __E2E__ ? 'open' : 'closed'})` holding
  one `<iframe src="chrome-extension://<id>/panel.html#<nonce>">` covering the viewport, clipped
  (`clip-path: path(...)`) to the hit regions the panel reports, so the rest of the page stays clickable.
  Re-raised in the top layer when another element enters it; while a page modal `<dialog>` or fullscreen element
  is shown it moves inside it with `Element.moveBefore` (state-preserving; Chromium 133+) so it is not inert, and
  back afterwards — when that is impossible (no moveBefore, a `<video>` in fullscreen) it hides instead of
  painting a layer that would forward clicks to the hidden page. The page's CSS zoom is neutralised
  (`zoom: 1 / currentCSSZoom`). Re-attached if the page removes it (MutationObserver; the whole document while
  inside a dialog, which may be removed with it). Shown / hidden with the tab's open state.
- `frame/server.ts` (ui.js): serves the bridge over a chrome.runtime Port the panel opens with
  `chrome.tabs.connect(tabId, {frameId: 0, name: 'reqlens-panel'})` (tab id from `PANEL_TAB`). Only the panel of
  its own iframe is served: the first message must carry the nonce of the iframe's URL fragment (the page can
  neither read the src of a frame in a closed shadow root nor the location of a cross-origin frame). It sends the
  state, then entry changes by identity (chunked ≤ 300 entries / ~16 MB), tab state / settings / capture info
  changes, and answers calls (`src/shared/panel-protocol.ts`). A panel that disconnects without a successor
  (the page navigated the frame away) is reloaded after 2 s.
- `panel/main.tsx` (panel.js): `RemoteBridge` (`panel/remote.ts`) mirrors the store and implements
  `ReqlensBridge` (sync getters, identity-stable arrays; `addManualEntry` shows the entry at once with the id it
  asks the store to use); the App renders into an open shadow root inside panel.html with the same adopted
  styles; `panel/hit.ts` reports hit regions (`.rl-panel`, `.rl-pill-btn`, `.rl-popup`, `.rl-toast`; the whole
  viewport while a pointer is captured — drags, resizes). `panel/uiState.ts` hands drafts, runs (only when they
  changed) and the selection to the host (debounced patches) so a reloaded panel (host re-created) resumes; runs
  in flight are marked aborted.
- Everything interactive inside the panel has `pointer-events: auto`; the rest is click-through.
- All data is rendered as text (never `dangerouslySetInnerHTML`). HTML preview only in `<iframe sandbox="" srcdoc>`.
- Theme: root container gets `data-theme="light|dark"`; tokens below defined for both.

#### CSS contract (ui-shell implements in `styles/tokens.css` + `styles/base.css`; others only use them)
Tokens: `--rl-bg, --rl-bg-elev, --rl-bg-sunken, --rl-bg-hover, --rl-bg-active, --rl-header-bg, --rl-rail-bg,
--rl-rail-hover, --rl-rail-active, --rl-sidebar-bg, --rl-list-hover, --rl-list-sel, --rl-tile, --rl-btn-bg,
--rl-btn-hover, --rl-border, --rl-border-strong, --rl-text-strong, --rl-text, --rl-text-muted, --rl-text-faint,
--rl-accent, --rl-accent-contrast (text on --rl-accent), --rl-accent-fill + --rl-accent-fill-text (primary
buttons), --rl-accent-soft, --rl-danger, --rl-danger-soft, --rl-danger-fill, --rl-warn, --rl-warn-soft, --rl-ok,
--rl-ok-soft, --rl-info, --rl-modified, --rl-focus, --rl-tint-{green,blue,purple,red,amber,neutral}-{bg,fg},
--rl-font (Lato), --rl-font-mono, --rl-fs-xs (11px), --rl-fs-sm (12px), --rl-fs-md (13px), --rl-fs-lg (15px),
--rl-label-fs / -fw / -ls (section headers), --rl-radius-xs (4px), --rl-radius-sm (6px), --rl-radius (8px),
--rl-radius-lg (12px), --rl-radius-xl (16px), --rl-radius-pill, --rl-space-1 (4px) .. --rl-space-5 (20px),
--rl-shadow, --rl-shadow-sm, --rl-row-h (28px; the request list overrides it with --rl-list-row-h, 30px),
--rl-m-get, --rl-m-post, --rl-m-put, --rl-m-patch, --rl-m-delete, --rl-m-other, --rl-json-key, --rl-json-string,
--rl-json-number, --rl-json-bool, --rl-json-null, --rl-diff-add, --rl-diff-del`.

Classes: `.rl-btn` (+ `--primary`, `--ghost`, `--danger`, `--sm`), `.rl-icon-btn` (+ `--sm`), `.rl-input`
(+ `--mono`, `--invalid`), `.rl-textarea` (+ `--mono`), `.rl-select`, `.rl-checkbox`, `.rl-badge`
(+ `--get/--post/--put/--patch/--delete/--head/--options/--other` method colors), `.rl-status` (+ `--1xx ..
--5xx`, `--pending`, `--error`, `--unknown`), `.rl-pill`, `.rl-card`, `.rl-card__header`, `.rl-card__title`,
`.rl-card__body`, `.rl-muted`, `.rl-faint`, `.rl-mono`, `.rl-empty` (centered empty state), `.rl-scroll`,
`.rl-row` (flex row, gap), `.rl-col`, `.rl-grow`, `.rl-spacer`, `.rl-modified-dot`, `.rl-warning`,
`.rl-error`, `.rl-kbd`, `.rl-spinner`, `.rl-truncate`, `.rl-chip` (+ `[aria-pressed=true]`), `.rl-table`
(compact data table), `.rl-sr-only`. Components may add their own BEM classes in their own CSS file
prefixed `rl-` + component name (e.g. `.rl-json-…`, `.rl-kv-…`, `.rl-resp-…`).

Visual direction: a member of the Kinebot product family (KineMeet, Kineloop — sampled palette and sources in
[docs/design/kine-ecosystem.md](design/kine-ecosystem.md)): Lato, neutral greys (dark: charcoal, rail darkest →
sidebar / list → content → cards), one accent hue (Kinebot blue in light, KineMeet periwinkle in dark), rounded
rail buttons and cards (12px), 8px controls, pill chips / counters, soft filled selections with an accent marker
(no outlines), small uppercase letter-spaced section headers. Method badges and status pills use the participant
avatar tints (GET / 2xx green, POST / 4xx amber, PUT / 3xx blue, PATCH purple, DELETE / 5xx red). Compact
developer-tool density (12–13px UI font, 30px list rows), modified markers in `--rl-modified` (amber), monospace
for URLs, keys, values, bodies. All text ≥ 4.5:1 in both themes (tests/unit/list-tokens-contrast.test.ts).

#### Test ids (data-testid) — required for E2E
All test ids live inside the panel frame (`page.locator('reqlens-overlay iframe').contentFrame()` in the E2E suite).
Shell: `rl-panel`, `rl-header`, `rl-minimize`, `rl-close`, `rl-dock-menu` (items `rl-dock-float|right|left|bottom`),
`rl-pill` (minimized), `rl-filter-input`, `rl-types-menu` (Types dropdown trigger; items `rl-type-chip` + `data-type`, checkboxes), `rl-record-toggle`, `rl-preserve-toggle`,
`rl-clear`, `rl-new-request`, `rl-request-list`, `rl-request-row` (+ `data-entry-id`, `data-method`, `data-kind`,
`data-url`), `rl-late-banner`, `rl-settings` (rail item; popover with `rl-settings-claude`), `rl-back` (narrow mode:
detail → list), `rl-resize-handle` (the keyboard-operable resize edge: role separator, arrow keys). Navigation rail
(§8.6): `rl-rail` (`data-expanded`), `rl-rail-item` (`data-item` requests|websocket|setups|screenshot|terminal|settings|
theme|collapse, `data-active`), `rl-view-switch` (the Requests + WebSocket group), `rl-view-http|ws|shot`,
`rl-view-http-count` / `rl-view-ws-count`, `rl-shot-view`, `rl-theme-toggle` (`data-theme-setting`), `rl-rail-toggle`.
Editor: `rl-detail`, `rl-method-select`, `rl-url-input`, `rl-url-preview`, `rl-send`, `rl-mode-select`,
`rl-revert-all`, `rl-more-menu`, `rl-section-query`, `rl-section-headers`, `rl-section-body`,
`rl-section-revert` (inside each section), `rl-kv-row` (+ `data-key`, `data-modified`), `rl-kv-enabled`,
`rl-kv-key`, `rl-kv-value`, `rl-kv-revert`, `rl-kv-delete`, `rl-kv-add`, `rl-body-type`,
`rl-body-view-fields`, `rl-body-view-raw`, `rl-raw-body`, `rl-json-node` (+ `data-path` from
`formatPath`, `data-modified`), `rl-json-key`, `rl-json-value`, `rl-json-type`, `rl-json-revert`,
`rl-json-delete`, `rl-json-add`, `rl-gql-query`, `rl-mp-part` (+ `data-name`), `rl-warnings`,
`rl-duplicate` (More menu), `rl-copy-curl`, `rl-copy-fetch`, `rl-url-revert`, `rl-cache-note` (Request sent).
v0.2 (full lists in docs/specs/v0.2.md): context menu `rl-context-menu`, `rl-context-submenu`, `rl-row-menu`,
`rl-ctx-hide` / `rl-ctx-only` (ladder items `rl-ctx-hide-option` / `rl-ctx-only-option` with `data-pattern`,
`data-exact`), `rl-ctx-copy` (`rl-ctx-copy-url|curl|fetch|types|prompt`), `rl-ctx-send-claude`
(`rl-ctx-send-claude-session`, `rl-ctx-claude-setup`), `rl-ctx-resend`, `rl-ctx-duplicate`, `rl-ctx-revert`,
`rl-ctx-remove`; rules `rl-rules-bar`, `rl-rule-chip` (`data-mode`, `data-enabled`, `data-pattern`, `data-exact`;
children `rl-rule-toggle`, `rl-rule-delete`), `rl-rules-clear`, `rl-hidden-count`, `rl-removed-restore`, rows
`data-hidden="rule|removed"`; toasts `rl-toast` (`data-kind`), `rl-toast-action`. Export `rl-export-tab`,
`rl-export`, `rl-export-types-tab` / `rl-export-prompt-tab`, `rl-export-format`, `rl-export-name`,
`rl-export-role-<role>`, `rl-export-annotate`, `rl-export-code`, `rl-export-copy`, `rl-export-notes`,
`rl-export-redact`, `rl-prompt-target`, `rl-prompt-examples`, `rl-prompt-preview`, `rl-prompt-copy`,
`rl-send-claude` (`rl-send-claude-reason`, `rl-send-claude-setup`, `rl-claude-session`); Settings → Claude Code
`rl-claude-section`, `rl-claude-enable`, `rl-claude-status` (`data-host`), `rl-claude-grant`,
`rl-claude-extension-id`, `rl-claude-cmd-install|add|channels`, `rl-claude-allow-send`, `rl-claude-share-secrets`;
history `rl-run-origin-claude`. Terminal (§8.4): `rl-claude-terminal-toggle` (rail, `aria-pressed`, `data-available`, `data-running`),
`rl-claude-terminal` (pane, `data-available`), `rl-claude-terminal-split`, `rl-claude-terminal-tab` (`data-state`
opening|running|exited|error), `rl-claude-terminal-close`, `rl-claude-terminal-new`, `rl-claude-terminal-hide`,
`rl-claude-terminal-form`, `rl-claude-terminal-cwd`, `rl-claude-terminal-start`, `rl-claude-terminal-form-error`,
`rl-claude-terminal-recent` (`data-dir`), `rl-claude-terminal-cwd-go`, folder picker `rl-claude-fp-pick`, `rl-claude-fp-home`,
`rl-claude-fp-up`, `rl-claude-fp-path` / `rl-claude-fp-list` (`data-path`, `data-loading`), `rl-claude-fp-crumb` (`data-path`),
`rl-claude-fp-refresh`, `rl-claude-fp-hidden` (`aria-pressed`), `rl-claude-fp-filter`, `rl-claude-fp-count`, `rl-claude-fp-entry`
(`data-name`, `data-git`, `data-project`, `aria-selected`), `rl-claude-fp-badge-git|project`, `rl-claude-fp-empty`, `rl-claude-fp-error`,
`rl-claude-fp-unavailable`, `rl-claude-fp-recent-browse`, `rl-claude-fp-projects` (`data-state`), `rl-claude-fp-projects-scan`,
`rl-claude-fp-projects-refresh`, `rl-claude-fp-project` (`data-dir`), `rl-claude-fp-project-browse`, `rl-claude-fp-target`
(`data-path`), `rl-claude-fp-use-current`, `rl-claude-terminal-screen`, `rl-claude-terminal-status` (`data-state`,
`data-exit-code`), `rl-claude-terminal-restart`, `rl-claude-terminal-disabled` / `rl-claude-terminal-reason` /
`rl-claude-terminal-setup`, `rl-claude-terminal-banner`.
Response: `rl-results`, `rl-result-status`, `rl-result-time`, `rl-result-size`, `rl-result-body`,
`rl-body-pretty`, `rl-body-raw`, `rl-body-preview`, `rl-resp-tab` (+ `data-tab`), `rl-run-cancel`,
`rl-run-history`, `rl-run-item`, `rl-compare`, `rl-original-tab`, `rl-result-error`; `rl-test-tab`, `rl-original-view`
(the Original response's ResponseView). `rl-results` carries `data-active-run` and `data-run-state`
(running | done | error | aborted) for tests.

---------------------------------------------------------------------------------------------------------

### 4.5 Build & tests
- `scripts/build.mjs` bundles five IIFEs and copies `static/` (manifest with the package version, icons,
  `panel.html`). `hook.js` and `content.js` run in every frame of every page at `document_start`, so they are
  minified (≈27 KB / ≈45 KB); `background.js` (≈330 KB: since v0.2 it bundles the lib pipeline for the bridge),
  `ui.js` (the in-page host, injected on demand, no Preact; ≈150 KB unminified with the screenshot page side, Find
  in page's scanner and the element locators, §13) and `panel.js` (the Preact UI, loaded by
  panel.html, ≈1.4 MB since the embedded terminal bundles xterm.js) stay readable. content.js never bundles Preact/UI code. `--e2e` builds `dist-e2e/` (open
  shadow root; `nativeMessaging` is already a required permission in static/manifest.json, so tests need no prompt —
  the build would move it out of `optional_permissions` if it were listed there),
  `--watch` builds unminified with inline source maps.
- `scripts/build-mcp.mjs` (`npm run build:mcp`) bundles `mcp/src/cli.ts` with the MCP SDK and zod into one
  executable ESM file, `mcp/dist/reqlens-mcp.mjs` (target node 20; `--outfile` for tests). `node-pty` (native, the
  embedded terminal) stays external and is required at runtime from the repo's `node_modules`. `npm run mcp:install`
  builds it and registers the native host (mcp/README.md). `npm run check` = typecheck +
  unit tests + build + build:mcp.
- Extension id: static/manifest.json carries a `"key"` (RSA public key; the private key is not kept anywhere), so the
  unpacked build has the same id on every machine, `EXTENSION_ID_UNPACKED` (src/shared/constants.ts; recomputed from
  the key by tests/unit/extension-id.test.ts). `reqlens-mcp install` always allows it. `npm run zip` (scripts/zip.mjs)
  strips `"key"` from the packaged manifest, because the stores assign their own id.
- Installer: `install.sh` / `install.ps1` (and `npm run setup`) check Node.js ≥ 20 and npm, then run
  `scripts/installer.mjs`: npm ci (skipped when node_modules matches the lockfile), node-pty check / rebuild, build,
  build:mcp, optional Claude Code bridge (`reqlens-mcp install`, `claude mcp add --scope user`, doctor) and the Load
  unpacked steps. `uninstall.sh` / `uninstall.ps1` undo the bridge. Pure parts are tested by
  tests/unit/installer.test.ts; see INSTALL.md.
- Unit tests: `npm test` (vitest, `tests/unit/**`). E2E: `npm run test:e2e` builds `dist-e2e/` and runs
  `tests/e2e/*.spec.ts` with Playwright's Chromium (`npx playwright install chromium`), headless, in a fresh temp
  profile, against a local echo server (`tests/e2e/fixtures.ts`). `RL_BROWSER=msedge npm run test:e2e` runs the
  same suite in an installed Microsoft Edge (it honours `--load-extension` too). `prerender.spec.ts` launches the
  browser itself and only attaches DevTools to the service worker (a DevTools session on the page disables
  prerendering). `npm run test:e2e` also runs `build:mcp`: `claude-bridge.spec.ts` installs the real native host
  into the temp profile's `<user-data-dir>/NativeMessagingHosts` (Chromium reads user-level manifests from there)
  with a temp `REQLENS_HOME` under `os.tmpdir()` (the socket path must fit AF_UNIX) and drives the real
  `reqlens-mcp serve` with the MCP SDK client. Unit suites that need node APIs live in `mcp/src/__tests__/*.suite.ts`
  (type-checked by mcp/tsconfig.json) and are imported by `tests/unit/mcp-*.test.ts`.

## 5. Security rules (non-negotiable)
1. MAIN-world messages are untrusted data (§messages.ts). Validate shape, cap sizes, never let them trigger
   privileged actions (extension-mode fetch, storage writes, tab state, script injection).
2. No `eval`, `new Function`, remote code, or innerHTML with captured data. Preact text rendering only.
3. HTML response preview only in a `sandbox=""` iframe (no `allow-scripts`, no `allow-same-origin`).
4. Nothing captured is drawn in the page's DOM: the UI is a cross-origin extension frame (panel.html) inside a
   closed shadow root (open only in the E2E build); the panel connection is authenticated with the frame's
   nonce. Preserved logs never contain credential header values; storage.session is for the worker only.
5. The SW accepts messages only from its own content scripts; validates `REPLAY` payloads (http/https URLs only,
   method token, header name/value sanity, sizes).
6. DNR rules are scoped to the single replay request (initiator = this extension, exact URL, method, no tab)
   and always removed.
7. No network traffic other than user-triggered replays (and, when the user allowed it, Claude's
   `send_request` / `requests resend` replays, which show in the overlay's history marked "Claude"), and the page's
   own scripts / source maps the worker fetches when the user opens the Initiator tab or Claude asks for
   `inspect initiator` (§10; cookies only for the page's own origin). No telemetry.
8. Claude Code bridge (v0.2): off by default (`settings.claudeBridge`, turned on only from the Settings click);
   `nativeMessaging` is a required manifest permission, granted at install, so enabling the bridge shows no permission
   prompt. Only extension contexts take part (the page can reach none of it): the worker accepts panel
   links only from its own `panel.html` naming its own tab, and validates every relayed call (unknown methods /
   params rejected, sizes bounded, overrides: method token, absolute http(s) URL without credentials ≤ 64 KB,
   ≤ 200 headers without CR/LF, body ≤ 5 MB). Data for Claude is redacted unless "Share secrets with Claude";
   `send_request` needs "Allow Claude to send requests" and the overlay open in that tab (or, with the control
   tools on, a panel mounted invisibly for Claude). The hub socket is 0600 in a 0700 `$REQLENS_HOME`; the hub keeps
   no captured data and logs only metadata.
9. Embedded terminal (§8.4): terminals are opened only by the panel (authenticated panel link of its own tab) from a
   click (user activation checked in the panel); the worker and the hub both validate every `pty-*` field (ids ≤ 64
   safe chars, cols/rows 1..1000, cwd ≤ 4096 chars without control chars — the hub requires an existing absolute
   directory after `~` expansion — input ≤ 64 KB) and a panel can only drive the terminals it owns. Output frames
   are chunked far below 1 MB. Terminals die with their panel (after a 10 s re-attach grace), with the bridge and
   with the hub. `REQLENS_PTY_COMMAND` is a test-only hook.
10. Find in page (§13): the page scan runs in ui.js (isolated world) for the authenticated panel only, reads the DOM
   without dispatching events or running page code, and never posts to the page's context; its only DOM changes are
   its own closed-shadow-root layers, where captured text (JSON path, value snippet) is CSS generated content, not page
   text. Password, hidden and file inputs are never read. The element locators of §13.1 follow the same rules (elements
   leave ui.js only as opaque refs).
11. Claude control tools (§8.2, docs/CLAUDE_INTEGRATION.md "Control tools"): off by default (`claudeAllowControl`,
   changed only from the Settings UI); the worker validates every `control` call strictly (unknown tools, actions and
   arguments rejected, sizes bounded); the `settings` tool refuses every Claude Code / security setting and may only
   narrow what is captured; sends keep `claudeAllowSend`, Errors fixes and dialogs `errorsFullMode` (anything
   published still needs the user's click in the dialog); answers are redacted like the bridge's, page data marked
   untrusted; panels mounted for Claude are invisible (`display: none`, inert iframe: no hit regions, input or focus)
   and removed when idle; every call is listed in Settings → Claude Code.

## 6. Quality bar
- TypeScript strict, no `any` unless unavoidable (comment why). Small focused modules, JSDoc on exports.
- Unit tests (vitest) for all `src/lib/**` behaviour incl. edge cases (unicode, big numbers, duplicates,
  encodings, truncated bodies, empty inputs).
- E2E (Playwright + Chromium with the unpacked `dist-e2e/` extension) covers capture → edit → send → result →
  revert for query, JSON, GraphQL, form, multipart, extension mode, cancel.
- Performance: hook overhead negligible when off; list virtualized; JSON editor renders collapsed beyond depth 3
  and paginates arrays > 100 items; viewers clip huge bodies with "Show more".

## 7. Known limitations (accepted)
- While the overlay is open in any tab, the webRequest listeners (`extraHeaders`, `requestBody`) make Chrome proxy
  every request; a page firing more than ~1200 truly concurrent requests can then hit
  `net::ERR_INSUFFICIENT_RESOURCES` (measured: 1500 concurrent fetches → ~140 failures; none at ≤ 1200, none while
  no tab has the overlay open). Listeners are removed whenever no tab has the overlay open.
- The service worker keeps the per-tab webRequest buffer in memory: after a worker restart, in-flight entries may
  stay pending and GET_TAB_STATE returns only entries seen since the restart (tab state itself is durable).
- Requests issued in the same task as a mode switch (open / pause / resume) are missed (the mode reaches the hook
  asynchronously). Pages that take a clean `fetch` from a fresh `about:blank` iframe before our scripts run in it
  bypass the hook (still listed via webRequest, unmerged), and a `Function.prototype.toString` taken from such a
  frame before our hook ran in it shows the wrappers' source.
- Page-mode replay swallowing matches method + URL + a 3 s window after the replay started: an identical page
  request started in that window can be swallowed instead of the replay's own event (the list stays correct, wire
  info may be swapped). Hook ↔ webRequest pairing of identical requests started within a few ms of each other
  follows call order, which the network may not.
- A streamed response without Content-Length is captured for at most 5 s (body truncated); a page cancel that
  propagates through `pipeTo` / `pipeThrough` / async iteration is not seen, so such a connection stays open for up
  to that window.
- Test requests bypass the HTTP cache (`cache: 'no-store'`), so the browser adds `Cache-Control: no-cache` and
  `Pragma: no-cache` unless the request sets them (shown in "Request sent").
- Page JS focus traps (a `focusin` listener that pulls focus back into a modal `<div>`) can take the focus from the
  overlay; native modal `<dialog>`s are handled. Without `Element.moveBefore` (Chromium < 133) the overlay hides
  while a page modal dialog or fullscreen element is shown. When the page removes the overlay host (or a dialog it
  sat in) the panel frame reloads: drafts, runs and the selection are handed over, runs in flight end as aborted,
  filters and collapsed sections reset.
- The overlay panel keeps a mirror of the page's entries (in the extension's process) and the host keeps the
  handed-over drafts and runs: captured bodies take roughly twice the memory while the overlay is open.
- Restored (preserved-log) entries carry `[not kept in the preserved log]` instead of Cookie / Authorization /
  Proxy-Authorization / Set-Cookie values; replaying one sends that placeholder unless the header is edited.
- Observing a fetch promise attaches a reaction, so a fetch rejection the page ignores no longer fires
  `unhandledrejection`. XHR `responseType: 'json'` with an invalid body is captured as `null`.
- Bulk-edit text has no escape syntax (keys starting with `#` / `//`, keys containing the separator and values
  with newlines do not round-trip). `MultipartPart` only models `form-data` dispositions: an edited
  multipart/related body is rebuilt as form-data (unmodified bodies are always re-sent verbatim).
- DNR: a plain extension-mode replay that reaches its request stage in the few ms after a header-rule replay of the
  same URL installed its rule could pick that rule up (the opposite order is serialized).
- v0.2 — URL rules / context menu: "Remove from list" is a panel-memory set of entry ids (not persisted, not
  handed over to a reloaded panel, forgotten when the list is cleared). While a rule-hidden entry is selected it
  stays listed (dimmed), so its chip count includes it while "N hidden by rules" does not. Very long URLs make the
  ladder submenu wide; when it fits on neither side it is clamped into the viewport over the parent menu.
- v0.2 — Export / redaction: redaction is heuristic (names, credential-looking values, inline patterns); text
  bodies and GraphQL documents can still carry secrets in unusual formats. Example comments in generated types
  come from captured data (personal data such as names can appear; Annotate off removes them). Recursive shapes
  are not inferred (one numbered type per depth); discriminated unions are not produced.
- v0.2 — Claude Code bridge: one hub per OS user — a second browser (profile) that enables the bridge while
  another hub is live gets "Another browser is already connected to Claude Code" and retries with backoff. While
  enabled but unreachable, the worker's reconnect timers do not keep it alive (an open native port does); retries
  resume when the worker wakes (an open overlay's panel link reconnecting wakes it). `send_request` runs with
  `settings.replayTimeoutMs` clamped to 10 min. The MCP inbox keeps ≤ 20 items in memory per session; pushes over
  16 MB are dropped by the hub. Channel notifications need Claude Code's research-preview flag
  (`--dangerously-load-development-channels server:reqlens`); without it items wait in the inbox. Run end to end
  on macOS only (Playwright's Chromium and Microsoft Edge, headless, temp profiles): Windows (named pipe, `.cmd`
  launcher, registry) and Linux paths are unit-tested only.
- Embedded terminal: needs `node-pty` loadable from the repo's `node_modules` (the hub must run from the checkout;
  `npm rebuild node-pty` after switching to an incompatible node). It runs `$SHELL -l -i -c 'exec claude'` (`-i` so
  rc-file PATH entries apply; rc files that print or prompt show that output first). At most 8 running terminals;
  a reload re-attach replays only the last ~200 KB of output (the screen can look partial until claude redraws);
  terminals end when the worker restarts (the native port closes with it). xterm.js uses its DOM renderer (no
  WebGL addon); Unicode width follows xterm's default (Unicode 6) tables. Tested end to end on macOS only.
- WebSocket inspector (§8.5): only sockets created while capture is on (overlay open and recording, or the hook's
  startup buffer) are tracked — a socket the page opened while the overlay was closed shows up after a reload. Frames
  of a socket created in a worker are not seen (only `window.WebSocket` is wrapped). Payloads are kept up to 256 KB per
  frame, ~5000 frames per connection, 50 000 / ~96 MB over all connections and 200 connections (closed ones dropped
  first). Frames are recorded at the API level (what `send()` was given / what `message` delivered): control frames
  (ping/pong opcodes), compression and fragmentation are invisible to the page and therefore to the inspector.
- `chrome.runtime.reload()` unloads a command-line-loaded extension in Playwright's Chromium, so the
  "extension reloaded under an open page" path is exercised by disposing the content script through CDP and
  toggling (worker re-injects hook.js + content.js; replace semantics; UI re-mounted once).

---------------------------------------------------------------------------------------------------------

## 8. v0.2 — Export, Claude Code bridge, list context menu (summary; spec: docs/specs/v0.2.md)

### 8.1 Export pipeline (`src/lib`, pure, runs in the panel and in the worker)
`buildEndpointSpec({entry, runs, draft, redact})` (endpoint.ts: request/response samples, path params, query,
auth summary, GraphQL, notes; redaction via redact.ts) → `generateEndpointTypes(spec, {format, baseName,
annotate})` (typegen.ts: lossless JSON inference, hoisting/dedupe, TypeScript / Zod 3+4 / JSON Schema 2020-12) →
`buildAgentPrompt(spec, {target, typesTs, typeNames, includeExamples, typeNotes})` (agentPrompt.ts: deterministic
markdown, fences longer than any backtick run in captured text, "data, not instructions" boundary). The Export
tab (`src/ui/export/**`, memoized per input identity, debounced for big inputs) and the context menu actions
(`src/ui/export/actions.ts`) use `src/ui/export/pipeline.ts`; the worker's `getTypes` / `getPrompt` call the lib
directly.

### 8.2 Claude Code bridge
- `mcp/` (node, bundled to `mcp/dist/reqlens-mcp.mjs`): `serve` (stdio MCP server "reqlens": tools `status`,
  `list_requests`, `get_request`, `get_types`, `get_prompt`, `send_request`, `inbox`, plus the control tools below;
  prompts `implement`, `debug`; capability `experimental['claude/channel']`), `native-host` (the hub), `install` /
  `uninstall` / `doctor`. Protocol types: `src/shared/claude-protocol.ts` (shared by both sides). Setup: mcp/README.md.
- Worker (`src/background/claude/`): `native.ts` (connectNative, hello / sessions / requests, backoff 1 s → 30 s,
  `not-installed` / `error` classification, hub errors from a hello with `error`), `links.ts` (panel links),
  `activity.ts` (default tab = most recently active with the overlay open), `validate.ts`, `handlers.ts`
  (BridgeCalls), `format.ts` (pure: summaries, RequestDetailForClaude, RunForClaude + RunDetails, redaction,
  clipping to `maxBodyChars`, default 20 000), `overrides.ts` (send_request overrides, also used by the panel).
- Panel (`src/ui/panel/claudeLink.ts`): status for the UI (`useBridgeStatus`), `requestBridgePermission` (first
  call in the click handler), `sendToClaude`, answers the worker's `state` / `entry` / `send` queries (Claude's
  sends run through the draft store with `origin: 'claude'`, toast "Claude sent POST /x").
- Settings: `claudeBridge`, `claudeAllowSend`, `claudeShareSecrets`, `claudeAllowControl` (all off by default),
  `exportFormat`, `promptTarget`.
- Control tools (docs/CLAUDE_INTEGRATION.md "Control tools"; only with `claudeAllowControl`): `inspect` (read-only),
  `overlay`, `requests`, `edit_request`, `list_config`, `setups`, `language`, `settings`, `errors`, `screenshot`,
  `find_in_page` (`mcp/src/control-tools.ts`, `action` enums) → bridge method `control` (`src/shared/control-protocol.ts`)
  → worker `ControlPlane` (`src/background/claude/control/`: strict validation, gates `claudeAllowControl` /
  `claudeAllowSend` / `errorsFullMode`, a settings blocklist, the visible trace) → a worker op, or a panel op over the
  panel link (`LinkQuery` kind `control`, `src/ui/panel/control.ts`). On a closed overlay the panel is mounted headless
  (host `display: none`, iframe inert; removed after `HEADLESS_IDLE_MS` idle, kept once the user opens it);
  `TabState.hidden` = open in the background (`src/ui/frame/headless.ts`: panel and frame host see a closed overlay).
  The router treats a `controlled` tab like an open overlay for CAPTURE_VISIBLE_TAB, RESOLVE_INITIATOR and REPLAY.
- "Send to Claude" of the screenshot result view (docs/CLAUDE_INTEGRATION.md "Send a screenshot to Claude"): annotated
  PNG → `shot-save` chunks (src/shared/shot-protocol.ts) → worker `ShotRelay` (src/background/claude/shots.ts) → hub
  `ShotStore` (mcp/src/shots.ts: `$REQLENS_HOME/shots/<id>.png`, 0600, 24 h / 200 files / 200 MB) → the absolute path
  goes to a Claude Code session (`InboxItem.images`; channel `image_path`, the `inbox` tool returns image content) or is
  typed into an embedded terminal (`TerminalStore.typeText`). UI: `src/ui/screenshot/{SendDialog.tsx,sendModel.ts,
  sendClient.ts,sendContext.ts}`.

### 8.3 List context menu + URL rules
`src/ui/components/ContextMenu.tsx` (generic menu: submenus, keyboard, clamping, `rl-popup` hit regions),
`src/ui/list/rowMenu.ts` (pure menu model), `RowContextMenu.tsx`, `rowActions.ts` / `ruleActions.ts` (draft store
and settings writes, Undo toasts), `rules.ts` (pure: `pathPrefixes(url)`, `matchesRule`, `applyRules`, labels),
`filter.ts` (`buildListModel(entries, filter, selectedId, {rules, removed})`: rules after chips and text, manual
entries never hidden, a hidden selected entry kept and dimmed), `RulesBar.tsx`. Rules persist in
`settings.listRules` (global). The type filter persists too: `settings.listTypes` (`ListTypeId[]`, `[]` = all types,
default `['fetch']`); the text filter stays in panel memory. `list/listState.ts` keeps pending local values of
`listRules` / `listTypes` / `setups` / `activeSetupId` until their writes are acknowledged (`persistListConfig`).

### 8.3.1 Setups (saved list configurations)
`settings.setups` (`Setup[]`, ≤ `MAX_SETUPS`: id, name ≤ 80, group ≤ 60 (`''` = ungrouped), `sites` host patterns
≤ 20, `config: SetupConfig {listTypes, listRules, defaultMode?}`, timestamps) and `settings.activeSetupId`
(always names a setup, else null). Validation + host patterns (`*.example.com` = the domain and its subdomains,
optional `:port`, lower-case punycode via URL): `src/shared/setups.ts`, used by the settings sanitizer. Pure model:
`src/ui/setups/model.ts` (capture / apply patch with fresh rule ids, "modified since applied" = types / rules
(ids, order ignored) / stored mode differ, auto-apply pick: most specific pattern, ties → most recently updated;
grouping, summaries, edits, export / import `{"kind":"kinereqlens-setups","version":1,"setups":[…]}` with
merge (same name in the same group updates) or replace). UI: navigation rail item `rl-setups-button` (active name,
modified dot) → `rl-setups-panel` (`SetupsButton.tsx` own popover — the import file chooser's window blur must not
close it — and `SetupsPanel.tsx`), actions with Undo toasts in `actions.ts`. Auto-apply runs once per page host
while the overlay is open (and on every panel load): the best matching setup is applied unless already active;
over unsaved changes of another active setup it is only offered (toast "Apply"). Tests: tests/unit/setups.test.ts,
E2E tests/e2e/setups.spec.ts.

### 8.3.2 Endpoint labels and "Group by endpoint"
Pure model `src/ui/list/endpointLabel.ts` (tests/unit/list-endpoint-label.test.ts): `endpointTemplate(url)` (cached
by URL) turns path segments into params of a kind (detectPathParams of src/lib/endpoint.ts — integer, uuid, ulid,
hex, date, slug — plus short hex `hash`, long opaque `token`, content hashes in file names `main.{hash}.js`) and
classifies query values the same way; its `key` (origin + path template, `{id}`/`{uuid}`… placeholders) is the
grouping and template-rule key. `layoutLabel(t, budget, withHost)` fits a label into a monospace character budget:
the last two literal segments with their params first, then the first query name, the host, the first segment
after the host and more of the path (`elideSegments`: one `…` gap), more query names; tighter, the query shrinks
to `?3 params` / `?3`. `groupListRows(rows, {expanded})` collapses calls sharing method + template key (≥ 2;
per list section; manual and kept-hidden entries never grouped) into `type: 'group'` rows (`aggregateGroup`:
count, outcomes / mixed, avg / last duration, time span); expanded groups list their calls (`group` = row key)
below, labelled with `concreteTemplate` (shortened values in the chips). `inlineHostFlags`: a row shows its host
inline only where it differs from the row above (the first row: the page host); lists ≥ 760 px have a host
column instead. Rendering: `EndpointChips.tsx` (`EndpointLabel`, `monoCharWidth`); `RequestList.tsx` measures
the name cell of one rendered row once per list width change (ResizeObserver via useElementSize; the cell is
`flex: 1 1 0`, so its width never depends on its label) and hands the character budget to every row. Selection
stays an entry id: a group row stands for its newest call (`cursorGroup`); `filter.ts` `activeRowKey` /
`moveRowKey` walk option rows by key (→ expands / enters, ← goes up / collapses). Group rows have their own menu
(`GroupContextMenu.tsx`, model `buildGroupMenu` in rowMenu.ts): Hide / Show only this endpoint (ListRule
`template`: origin + path template, any method, any query; `pattern: ''`, `exact: true`; sanitized in
src/shared/setups.ts, so Setups carry it), the template's literal-prefix ladder (`templatePrefixes`), Copy ▸
template / newest URL, expand, Remove N calls. Settings: `listGroup` (default false), `urlDisplay` ('template' |
'full'; Settings → URL display). The detail header shows the same template (`rl-detail-url`) with an expandable
full URL. Test ids: `rl-group-toggle` (`aria-pressed`), `rl-group-row` (`data-group-key`, `data-template`,
`data-count`, `data-expanded`, `data-mixed`; children `rl-group-expand`, `rl-group-count`, `rl-group-mixed`),
call rows `rl-request-row[data-group="call"]`, rows `data-template`, `rl-ep-query`, `rl-group-menu`
(`rl-ctx-hide-template` / `rl-ctx-only-template` with `data-template`, `rl-ctx-copy-template`, `rl-ctx-expand`),
rule chips `data-template`, `rl-detail-url` / `rl-detail-url-expand` / `rl-detail-full-url` / `rl-detail-copy-url`,
`rl-url-display` (radios with `data-value`). E2E: tests/e2e/list-menu.spec.ts, screenshot docs/screenshots/endpoints.png.

### 8.4 Embedded Claude Code terminal (docs/CLAUDE_INTEGRATION.md)
- UI (`src/ui/terminal/`): the navigation rail's **Claude Code** item toggles a pane docked under the panel body (`SplitPane` column
  with `fixed="b"` — its px height is `settings.layout.terminalHeight` — and `collapsed` when hidden, so sessions stay
  mounted). `TerminalDock.tsx` (tab strip, new-session form = `FolderPicker.tsx`: native chooser, folder browser with
  breadcrumbs / Home / Up / hidden toggle / filter / git + project badges / keyboard, quick picks = recent folders
  `settings.claudeRecentDirs` — ≤ 10, MRU, sanitized in src/content/settings.ts via `sanitizeRecentDirs` in
  src/shared/pty.ts — and detected git projects, typed-path fallback; pure path helpers `folders.ts`, request client
  `fsClient.ts`), session view with xterm.js +
  FitAddon, status line, Restart, unavailable state linking to Settings → Claude Code), `store.ts` (DOM-free
  `TerminalStore`: sessions, ids, restart, input splitting, re-attach), `session.ts` (singleton started in
  panel/main.tsx before the claude link, pane open state), `xterm.ts` (terminal factory, theme from tokens,
  clipboard keys), `texts.ts`. xterm's CSS is part of the adopted stylesheet (`styles/index.ts`). `panel/hit.ts`
  ignores mutations inside `.xterm`.
- Protocol: `PtyToHost` (`pty-open {id, cwd, cols, rows}`, `pty-input {id, data}`, `pty-resize`, `pty-close`) and
  `PtyFromHost` (`pty-opened {id, pid, cwd?}`, `pty-data {id, data}`, `pty-exit {id, code, signal}`,
  `pty-error {id, error}`) in claude-protocol.ts, carried unchanged over the panel link plus `pty-attached`
  (claude-link.ts). Pure helpers (validation, chunking, input splitting, `OutputTail`): src/shared/pty.ts.
- Worker (`src/background/claude/pty.ts`, `PtyRelay`): owner link per id, refuses foreign ids, 8 running / 32 tracked,
  replay tail of 200 K chars, 10 s grace (`PTY_GRACE_MS`) after the owner disconnects, re-attach to the next panel
  of the same tab (`PanelLinks` `onLinkOpen` / `onLinkClose` / `onPty`), `hostGone()` when the native port closes
  (`NativeHostLink` `onPortClosed`), `killAll()` when the bridge is turned off.
- Hub (`mcp/src/pty.ts`, `PtyManager`, owned by `Hub`): node-pty loaded lazily from the repo (`external` in
  build-mcp.mjs; spawn-helper exec bit restored), login + interactive shell, env + TERM / COLORTERM, cwd validation,
  16 ms batching, 64 K-char chunks, ≤ 8 terminals, SIGHUP → SIGKILL, kill all on stdin close / stop / process exit,
  `pty-error` with an `npm rebuild node-pty` hint when node-pty is unusable.
- Folder browser (`fs-*`, docs/CLAUDE_INTEGRATION.md "Working directory"): `FsToHost` / `FsFromHost` in
  claude-protocol.ts, validation in src/shared/fs.ts; panel `fsClient.ts` (ids, timeouts, link-lost, projects cache)
  over claudeLink `postFs` / `subscribeFs`; worker `src/background/claude/fs.ts` (`FsRelay`: worker-chosen ids, answers
  to the asking link only, per-type timeouts, 8 per link / 32 overall / one chooser per link, refuses when the bridge is
  off, disconnected or the hub lacks `features: ["fs"]`, fails all on `onPortClosed`); hub `mcp/src/fs.ts` (`FsService`:
  `listDirectory` — dirs only, symlinks followed, visible then hidden, natural sort, ≤ 2000 / 800 KB, markers with a 3 s
  budget —, `scanProjects` — ≤ 2 levels, realpath dedupe, repos not descended, cached 5 min —, `pickerCommand` /
  `interpretPickerRun` per OS via execFile, one chooser at a time, `REQLENS_FS_PICK_STUB` test hook). Tests:
  tests/unit/bridge-fs.test.ts, terminal-folders.test.ts, mcp-fs.test.ts (→ mcp/src/__tests__/fs.suite.ts).
- Tests: tests/unit/pty-protocol.test.ts, bridge-pty.test.ts (relay ownership / grace / replay / lifecycle, link and
  native wiring), terminal-store.test.ts, content-settings.test.ts, mcp-pty.test.ts (→ mcp/src/__tests__/pty.suite.ts:
  fake pty factory, hub relay, and a real node-pty run of `REQLENS_PTY_COMMAND`), E2E tests/e2e/claude-terminal.spec.ts.

### 8.5 WebSocket inspector (`src/lib/ws*.ts`, `src/injected/wsHook.ts`, `src/content/wsStore.ts`, `src/ui/ws/**`)
- Hook (MAIN): `window.WebSocket` is replaced by a constructor wrapper (`Reflect.construct(native, arguments,
  new.target)`, same `prototype` / constants / `[[Prototype]]`, `prototype.constructor` points at it, disguised
  `toString`); `prototype.send` / `close` are wrapped (`replaceMethod`). With capture not off, a socket gets internal
  `open` / `message` / `close` / `error` listeners at construction (before the page's). Text frames are capped with
  `textBody`, binary (ArrayBuffer / views copied synchronously, Blobs read asynchronously in order) base64-encoded at
  flush. Events (`WsHookEvent`, src/lib/ws.ts) are queued and posted as `{t:'ws', events}` every ≤ 50 ms (eagerly at
  500 queued while capturing; ≤ 4000 frames queued while buffering); while capture is off only lifecycle events of
  known sockets are posted. `{t:'ws-send', reqId, wsId, text}` → `{t:'ws-send-result'}` sends through a page socket
  (the overlay's composer, explicit click only).
- Content (top frame): `WsStore` = `WsRecorder` (validation `sanitizeWsEvents`, connections `<frameId>:<hookId>`,
  `WsLog` rings and global caps, delta journal) + coalesced subscribers; subframes validate and relay
  `FRAME_CAPTURE {t:'ws'}` (the worker accepts `t:'ws'` with an `events` array). New sockets / frames only while
  capturing; open / closing / close / error always. Bridge: `ReqlensBridge.ws?: WsBridge` (snapshot, subscribe(delta),
  clear, send).
- Frame host / panel: `{t:'ws', delta}` (first a reset snapshot, `chunkWsDelta` ≤ 2000 frames / 16 MB), calls
  `wsClear` / `wsSend`. `RemoteBridge.ws` (`src/ui/ws/store.ts` `RemoteWs`) mirrors into a `WsInspector`
  (src/lib/ws-inspector.ts: frames classified once on arrival with src/lib/ws-protocols.ts, per-channel stats kept on
  eviction, filters: text terms / `-term` / JSON path `$.a.b[0] = x`, `!=`, `~`).
- Channel detection (sticky per connection; URL / sub-protocol hints): Socket.IO / Engine.IO v3–v4, Phoenix (v1/v2),
  Action Cable, STOMP, graphql-ws + subscriptions-transport-ws (channel = operation name), generic JSON
  (channel/topic/room/stream… + event/type/action/op/cmd), raw. Control / heartbeat frames → `HEARTBEAT_CHANNEL`
  ("Heartbeats & control"), hidden in "All messages" until the Heartbeats toggle.
- UI: the navigation rail's Requests | WebSocket items (live counts, `usePanelView` in `ws/ViewSwitch.tsx`, `sessionStorage` per panel); `WsView` (mounted on first
  use, then kept hidden; re-renders ≤ 1 per frame): `Sidebar` (connections newest first, status dot, protocol badge,
  msgs, duration; channels with ↑/↓ counts, last activity, unread), `Messages` (filter, direction, heartbeats, pause,
  composer toggle; virtualized 28 px rows, sticks to the newest message, "N new messages" pill), `Detail` (meta grid,
  Pretty JSON tree via `JsonViewer` / Raw / Hex, copy). Layout: ≥ 980 px three columns; ≥ 640 px sidebar + stacked
  messages / detail; narrower a connection › channel select above them.
- Test ids: `rl-view-switch`, `rl-view-http` / `rl-view-ws` (+ `-count`), `rl-ws-view` (`data-layout`), `rl-ws-empty`,
  `rl-ws-sidebar`, `rl-ws-connection` (`data-ws-id`, `data-state`, `data-protocol`, `data-url`), `rl-ws-all`,
  `rl-ws-channel` (`data-channel`, `data-unread`), `rl-ws-clear`, `rl-ws-picker`, `rl-ws-messages-pane`, `rl-ws-filter`
  (`data-mode`), `rl-ws-dir` (items `data-value`), `rl-ws-heartbeats`, `rl-ws-pause`, `rl-ws-count`, `rl-ws-messages`,
  `rl-ws-message` (`data-frame-id`, `data-dir`, `data-opcode`, `data-channel`, `data-event`), `rl-ws-jump`,
  `rl-ws-compose-toggle`, `rl-ws-composer`, `rl-ws-composer-input`, `rl-ws-composer-send`, `rl-ws-detail`
  (`data-frame-id`), `rl-ws-detail-dir`, `rl-ws-detail-event`, `rl-ws-meta`, `rl-ws-view-pretty|raw|hex`, `rl-ws-json`,
  `rl-ws-raw`, `rl-ws-hex`, `rl-ws-copy`.
- Tests: tests/unit/ws.test.ts (validation, rings, recorder, adapters, inspector, filters), E2E tests/e2e/websocket.spec.ts
  with its RFC 6455 server tests/e2e/ws-server.ts (Socket.IO-like, JSON and graphql-transport-ws sockets).

### 8.6 Navigation rail (`src/ui/rail/Rail.tsx`, `rail.css`)
- The panel is header (brand, recording indicator, headerExtra, dock / minimize / close) over `.rl-panel__frame` = rail |
  body. Rail items, in order (shortcuts: Alt+1 Requests, Alt+2 WebSocket, Alt+3 Setups, Alt+4 Screenshot, Alt+5 Claude
  Code, Alt+6 Settings, Alt+7 Errors; Language has none): **Requests** (view `http`, badge = entries), **WebSocket** (view `ws`, badge =
  connections, live dot while sockets are open), **Setups** (`SetupsButton` with a `rail` trigger; its popover opens
  beside the item, tooltip names the active setup, modified dot), **Screenshot** (view `shot`: `ScreenshotTool` fills
  the main area, mounted on first use, then kept; only when the bridge is a `ShotHost` — not in the standalone tab),
  **Claude Code** (terminal pane toggle, dot while sessions run), **Language** ("Site language", §11: `LanguageButton`
  popover beside the item, badge = the active tag; no shortcut; not in the standalone tab), **Settings** (`PopoverButton` with `beside` + a
  custom trigger; "Claude Code" jump chip), **Errors** (view `errors`, Alt+7, badge = distinct failing endpoints, red dot
  `rl-errors-new-dot` while some were not seen, §12 — last, so the tools above keep their places). Bottom: theme quick toggle (auto → light → dark) and collapse / expand.
- 44 px with icons (labels in `title` / `aria-label`), 180 px with labels: `settings.layout.railExpanded` (default
  false; sanitized in src/content/settings.ts, persisted through `usePersistentLayout`). Panels < 520 px
  (`RAIL_COMPACT_PANEL_W`) always show icons only, without the switch (`rl-panel--compact` also trims the header).
  The list | detail split goes narrow when `panel width − rail width + 44 < NARROW_PANEL_W`.
- Keyboard: a vertical `role=toolbar` with one tab stop (roving tabindex), ↑ / ↓ / Home / End; Alt+1..7 on the
  panel window (`railShortcut`: not inside xterm, not in text fields on macOS) press the item with that
  `data-shortcut`. Current view: `aria-current="page"`, accent background and a 3 px Kinebot-blue edge bar.
- Popovers beside an anchor: `placePopupBeside` (src/ui/components/position.ts, side `'right'`).
- Tests: tests/unit/list-panel-geometry.test.ts (placePopupBeside), content-settings.test.ts (railExpanded),
  E2E tests/e2e/overlay.spec.ts ("navigation rail"), screenshot.spec.ts (opens the tool from the rail),
  screenshots.spec.ts (`docs/screenshots/sidebar.png`).

## 9. React Native (`react-native/`, `mcp/src/rn/**`, `src/background/rn/**`, `src/ui/standalone/**`, `src/ui/rn/**`)

```
 RN app (@kinebot/kinereqlens-react-native, react-native/PROTOCOL.md)
   │ WebSocket ws://<host>:<rnPort>/kinereqlens — hello {token, session, app} → welcome; captures; replay ⇄ replay-result
   ▼
 reqlens-mcp native-host (hub) — RnReceiver (mcp/src/rn/receiver.ts): validates, batches ≤ 50 ms, chunks < 1 MiB
   │ native messaging: rn-status / rn-session / rn-capture / rn-open-ui / rn-chunk  ⇄  rn-config / rn-replay / rn-abort / rn-token
   ▼
 service worker — RnBridge (src/background/rn/index.ts): sessions, capture buffer, replay routing, tab opening
   │ Port 'reqlens-standalone' (captures, status, select, replay/abort calls)    Port 'reqlens-rn' (status, token, open)
   ▼                                                                             ▼
 app.html — standalone.js: the App (full tab) over StandaloneBridge       Settings → React Native (panel.html and app.html)
```

- **Protocol types and validators**: `src/shared/rn-protocol.ts` (pure; used by the hub, the worker and the pages). The
  `rn-*` messages extend `HostToExtension` / `ExtensionToHost` (claude-protocol.ts). The app-side protocol is
  react-native/PROTOCOL.md (`src/protocol.ts` there mirrors the extension's capture types).
- **Hub receiver** (`mcp/src/rn/`): `ws.ts` (RFC 6455 handshake answer, unmasked server frames, incremental decoder of
  masked client frames with fragments, 48 MB message cap, no O(n²) re-buffering), `token.ts` (pairing token created once
  in `$REQLENS_HOME/rn-token`, 0600, atomic write; constant-time compare), `receiver.ts` (`RnReceiver`, owned by `Hub`):
  binds `127.0.0.1` (+ `::1`) or, with `rnListenLan`, `0.0.0.0` (+ `::`) on `rnPort` (default 8790), path
  `/kinereqlens` (else 404); ≤ 64 connections / 16 handshaking; hello within 5 s (4003), `v === 1` and a valid hello
  (4002), token (4001, `rejected` sent first); one live connection per `session` (a newer one replaces it, 4004);
  every later message rebuilt by `sanitizeRnClientMessage` (ids, method token, URL ≤ 64 KB, ≤ 500 headers, bodies ≤
  24 M chars, RN file parts `size: -1` → `0 + truncated`, WebSocket payloads ≤ 2 M chars) — anything else is dropped.
  Captures are queued per session and flushed every `RN_BATCH_MS` (50 ms) as `rn-capture {session, msgs}` frames of at
  most `RN_FRAME_BUDGET` (900 KB) JSON bytes; a single larger message is split into `rn-chunk {id, seq, total, part}`
  parts of JSON text (≤ budget / 3 chars, never inside a surrogate pair). `open-ui` flushes the session first, then
  sends `rn-open-ui`. `rn-replay` / `rn-abort` are relayed to the session's connection (a replay for an absent app is
  answered with an error `replay-result`). `rn-token` regenerates the token and disconnects every app. Disabling
  closes every app (1001) and the servers; the receiver reports `rn-status` on every change and stops with the hub.
- **Worker** (`src/background/rn/`): `messages.ts` (shape checks of `rn-*`, `ChunkAssembler` — ≤ 8 partials, 64 M
  chars), `index.ts` `RnBridge`: sends `rn-config {enabled, lan, port}` (settings `rnEnabled` / `rnListenLan` /
  `rnPort`, sanitized) on every hub hello and settings change; the native port is wanted when `claudeBridge ||
  rnEnabled` (and nativeMessaging is granted) — `ClaudeBridge` owns the port (`ClaudeBridgeDeps.rn` hooks), and refuses
  Claude's calls while `claudeBridge` is off. Keeps the sessions (≤ 16, disconnected ones forgotten first) and a capture
  buffer per session (≤ 10 000 messages, ≤ 96 M chars overall) that a standalone tab gets on connect (`reset: true`);
  `clear` from the tab empties it. App-mode replays (`mode: 'page'`): validated with `validateReplayRequest`, sent as
  `rn-replay`, answered from the `replay-result` in the capture stream (rebound to the request with
  `sanitizeReplayResult`, body capped), timeout `timeoutMs + 5 s`, failed at once when the app disconnects or the port
  closes; Extension-mode replays use the worker's `ReplayRunner` as for pages. `rn-open-ui` focuses the newest
  standalone tab and selects the app, or opens `app.html#session=<id>` (`chrome.tabs.create`, no new permission). Ports
  are only accepted from this extension's `app.html` (standalone) / `panel.html` or `app.html` (status).
- **Standalone tab** (`static/app.html`, `src/ui/standalone/`, bundle `standalone.js`): `bridge.ts` `StandaloneBridge`
  implements `ReqlensBridge` with one `RequestStore` + `WsStore` (the content script's pure stores) per app session;
  starts / ends go through the store's validation (`isValidHookStart/End`), WebSocket messages become inspector hook
  events (`rnWsEvents`, ids made `[A-Za-z0-9_-]`); a re-sent buffer rebuilds the session's WebSocket log. Tab state is
  always open (recording pauses capture locally, no preserve log); settings come from `chrome.storage.local`
  (`SettingsStore`). `TargetPicker.tsx` (header): the app label, a select when several sessions exist, connection dot.
  `main.tsx` sets `setShellMode('standalone')` (src/ui/shellMode.ts: replay mode "Page" is named **App**, no page
  reload / preserve log affordances, no browser-controlled-header warnings or locks in App mode — the app sends
  every header: `draftWarnings(draft, mode, {app: true})`, KVTable, RequestSent) and renders `<App standalone headerExtra={…} />` (full tab: no float / dock /
  minimize / close / resize). The Claude link (`startClaudeLink` with the tab's id; `PanelLinks` accepts app.html) gives
  it the embedded terminal; Export, Setups and list rules work unchanged. Claude's MCP tools address page tabs only.
- **Settings → React Native** (`src/ui/rn/RnSettings.tsx`, status client `status.ts`, view model `view.ts`): enable
  (still calls `permissions.request` for nativeMessaging inside the click; it is a required permission now, so no prompt
  appears), status pill (`rl-rn-status`, `data-state` off | permission | connecting
  | listening | error | not-installed), connected apps, pairing token (copy / regenerate), setup snippet + dev-menu tip,
  LAN toggle with warning, port, "Open React Native window". Test ids: `rl-rn-section`, `rl-rn-enable`, `rl-rn-status`,
  `rl-rn-detail`, `rl-rn-cmd-install`, `rl-rn-apps`, `rl-rn-app` (`data-session`), `rl-rn-token`, `rl-rn-token-copy`,
  `rl-rn-token-regenerate`, `rl-rn-snippet`, `rl-rn-devmenu-tip`, `rl-rn-lan`, `rl-rn-lan-warning`, `rl-rn-port`,
  `rl-rn-open`; standalone header `rl-rn-targets` (`data-count`, `data-connected`), `rl-rn-target` (select),
  `rl-rn-target-label`.
- **Tests**: tests/unit/mcp-rn.test.ts (→ mcp/src/__tests__/rn.suite.ts: the real hub in-process with a fake native
  messaging client; handshake / token / validation / batching / chunking / sessions, frame decoder, and the RN package
  runtime over react-native/test/rn-fakes.ts against the receiver), tests/unit/bg-rn.test.ts (worker routing),
  tests/unit/rn-standalone.test.ts (settings sanitizer, validators, StandaloneBridge, wording), E2E
  tests/e2e/react-native.spec.ts (real hub installed into the temp profile, Settings flow, RN runtime in Node, dev menu
  opens the tab, App-mode replay).

## 10. Initiator tab — "which component is consuming this endpoint"

```
 hook.js (MAIN)  fetch / XHR.send / sendBeacon / new WebSocket while capture is on: Error().stack through the
                 Error captured at install (stackTraceLimit / prepareStackTrace set and restored synchronously),
                 hook.js frames stripped, ≤ 40 frames / 8 KB (src/lib/stack.ts cleanStack)
   │ HookRequestStart.initiatorStack / ws 'new'.initiatorStack
 content.js      isValidHookStart + cleanHookStart (string, capped at a line boundary) → RequestEntry.initiatorStack
                 (preserved log: ≤ 4 KB, PRESERVED_STACK_CAP); WsConnection.initiatorStack
 panel           Initiator tab (src/ui/detail/InitiatorPanel.tsx, initiatorState.ts): parse + classify (src/lib/initiator.ts)
   │ RESOLVE_INITIATOR {frames, pageUrl} (panel page only, overlay open)
 worker          SourceResolver (src/background/sources.ts): fetch script → //# sourceMappingURL (or SourceMap header;
                 inline data: maps) → fetch map (≤ 20 MB, 15 s timeout, LRU cache ≤ ~96 M chars, 10 min TTL; cookies
                 only same-origin as the page) → VLQ decode + lookup (src/lib/sourcemap.ts, index maps too) → original
                 source / line / col / name, excerpt (±3 lines) and enclosing function names from sourcesContent
   │ Port call locateComponents {names, scroll, highlight} (panel → ui.js → bridge → hook port {t:'components'})
 hook.js         src/injected/components.ts + src/lib/component-tree.ts: roots from __REACT_DEVTOOLS_GLOBAL_HOOK__,
                 __reactContainer$ / _reactRootContainer / __reactFiber$ (React), container __k (Preact 10, mangled
                 and unmangled), __vue_app__ (Vue 3); bounded walk for the names → instance paths + host-element
                 union rects (scrollIntoView first when asked) → sanitizeComponentLocateResult in content.js
 ui.js           src/ui/frame/highlight.ts: boxes + labels in a pointer-events:none closed shadow root layer
                 (<reqlens-highlight-layer>), following scroll, removed after 4 s / Esc / the next highlight
```

- Classification: app code vs library (node_modules / vendor chunks: axios, @tanstack/query, apollo, swr, ky, fetch
  polyfills…) vs framework internals (react-dom, scheduler, preact, vue, next chunks, known React / Vue internal
  function names) vs browser extension vs native. Initiator = first app frame. Component guess = innermost
  PascalCase name among the app frames (V8 name parts, then the functions enclosing the original position — an
  anonymous `useEffect` callback is attributed to the component around it), with the innermost `use*` hook on the
  way; `App` / `Root` only as a fallback.
- UI: row menu "Show initiator / component" (`rl-ctx-initiator`, hint "no stack" without one) selects the entry and
  opens the results tab "Initiator" (`rl-initiator-tab`, request via `src/ui/detail/resultsTab.ts`): `rl-initiator`
  (`data-state` none | resolving | done), component card `rl-initiator-component` (`data-name`), `rl-initiator-path`,
  `rl-initiator-highlight`, `rl-initiator-count` (`data-count`); initiator card `rl-initiator-frame-card` with
  `rl-initiator-location`, `rl-initiator-excerpt`, `rl-initiator-vscode`, `rl-initiator-nomaps`; stack
  `rl-initiator-stack`, `rl-initiator-frame` (`data-kind`, `data-location`), `rl-initiator-library-group`,
  `rl-initiator-copy`; empty state `rl-initiator-empty`; page boxes `rl-highlight-box`. Settings → "Editor workspace
  root" (`settings.editorRoot`, `rl-settings-editor-root`) maps relative source paths (webpack://app/./src/…, /src/…)
  to `vscode://file/<root>/<path>:<line>:<col>`; absolute paths (file://, /Users/…, /home/…, C:\…, Vite /@fs/…)
  link without it. The WebSocket detail shows "Created by" (bundle positions) from the connection's stack.
- Limits: component lookup runs in the top frame only (requests of subframes show the stack, not the page lookup);
  webRequest-only entries (documents, scripts, worker fetches) and requests made before the overlay opened have no
  stack; names of minified code without source maps are meaningless (the tab says so); the enclosing-function
  heuristic counts braces (strings / comments with unbalanced braces can mislead it).
- Tests: tests/unit/initiator-{stack,sourcemap,analysis,components}.test.ts (V8 / Gecko stack formats, async frames,
  VLQ against known values and esbuild-generated maps, index / inline maps, enclosing names, classification,
  component guess, vscode links, the worker resolver with a fake fetch, React / Preact / Vue mocked trees,
  sanitizers, caps), E2E tests/e2e/initiator.spec.ts (a Preact-as-React app bundled by the spec with esbuild and a
  linked source map: ReportList's effect fetch → component, path, original ReportList.jsx:line, excerpt, VS Code
  link, collapsed framework frames, Copy stack, Highlight box around the element; empty state for a script entry).

## 11. Site language — test a site in another language without changing Edge's settings

```
 panel (Language rail item)                       service worker (src/background/language.ts, LanguageManager)
   LANGUAGE_SET_TAB {value} ───────────────────►    tab overrides: storage.session['reqlens:tab-languages'] (until closed)
   bridge.updateSettings({siteLanguages}) ──┐       site overrides: settings.siteLanguages (host → value, ≤ 200)
   LANGUAGE_STATE {refresh} ────────────────┼──►    effective(tab) = tab override ?? siteLanguages[host of the tab's page]
                                            │       DNR session rules (ids ≥ LANGUAGE_RULE_ID_BASE, rewritten atomically)
   content.js (every frame) ◄── GET_TAB_STATE.language / LANGUAGE {value} push
   hook.js ◄── {t:'lang', languages} (private port): navigator.language(s), Intl default locale, 'languagechange'
```

- **Values** (`src/shared/language.ts`): an Accept-Language list as typed ("pt-BR, en;q=0.8") normalized to the header
  form `pt-BR,en;q=0.8` — well-formed BCP-47 tags (language, script, region, variants; no extensions / wildcards)
  canonicalized with `Intl.getCanonicalLocales`, q in 0..1 with ≤ 3 decimals, duplicates and q=0 dropped, ≤ 10 tags /
  200 chars. `languagesOf` orders the tags by q (stable) for the page. The picker (`LANGUAGE_OPTIONS`, native names,
  no flags) is searched by tag prefix, then native / English names; any other valid tag is offered as a custom tag;
  optional fallbacks. Site key = the page's host name (http(s), any port).
- **Network** (DNR session rules, `buildLanguageRules`): a tab override → `{tabIds:[tab]}`, every resource type incl.
  main_frame, priority 3 (follows the tab across sites). A site override while a tab shows that host →
  `{tabIds:[tab]}`, every type but main_frame, priority 2 (subresources, API calls to other domains and subframes of
  that page; main_frame is left out so a navigation away never carries the language), plus one rule per site
  `{regexFilter: ^https?://<host>(:port)?([/?#]|$), resourceTypes:[main_frame]}`, priority 1, for the document request
  itself (before the per-tab rule follows a navigation onto the host). `requestDomains` / `initiatorDomains` are not
  used: both match subdomains, and initiatorDomains misses the document and follows the host's frames into other
  sites. Hosts are learned from `tabs.onUpdated` (url) and the top frame's GET_TAB_STATE; rules are rewritten on
  every change (serialized, coalesced), on tab close / replace, settings changes and worker start. Page-mode replays
  inherit the tab rule; extension-mode replays (the worker's own fetch, tabId -1) get `Accept-Language` added by the
  router unless the request already sets one (`withAcceptLanguage`). The rule `set`s the header, so it also replaces
  an Accept-Language the page's JS sets explicitly.
- **JS** (`src/injected/language.ts`, MAIN world): nothing is installed until a first override arrives (off = no
  change at all); then `Navigator.prototype.language` / `languages` getters (native receiver check first, frozen
  identity-stable array), Proxies of `Intl.DateTimeFormat` / `NumberFormat` / `Collator` / `PluralRules` /
  `RelativeTimeFormat` / `ListFormat` / `DisplayNames` / `Segmenter` / `DurationFormat` (construct + call traps on a
  null-prototype handler; `prototype.constructor` re-pointed; `supportedLocalesOf` wrapped) and
  `Date.prototype.toLocale(Date|Time)String`, `Number` / `BigInt.prototype.toLocaleString`,
  `String.prototype.localeCompare` fill in the override only when the locales argument is undefined. Wrappers report
  native `toString()` (`disguiseProxy` registers proxies in this realm only: their generic source text must not be
  mapped). `languagechange` is dispatched on window whenever what `navigator.languages` reports changes. The DOM (e.g.
  `<html lang>`) is never touched.
- **Timing**: the override reaches the hook asynchronously — content.js gets it with its first GET_TAB_STATE (and
  pushes from the worker), a few ms after document_start. External scripts (bundles) normally run later and see it;
  inline `<head>` scripts and `DOMContentLoaded` handlers of pages without external scripts run before and see the
  browser's language (`languagechange` fires once it applies). Apply therefore reloads the page once by default
  ("Reload the page to apply everywhere") so the document request carries the header; without it the panel offers
  "Reload to apply".
- **UI** (`src/ui/language/`): `client.ts` (worker messages from the panel page only — the router refuses content
  scripts —, `useLanguageStatus` = tab override from the worker + `settings.siteLanguages[host]`), `LanguagePanel.tsx`
  (state, picker, fallbacks, preview, scope tab / site, reload, Apply, Reset = drop the tab override and the host's
  site override), `LanguageButton.tsx` (rail item, header indicator). Setups: `SetupConfig.language` (optional;
  "Include site language" when saving), applied as the site language of the page host (Undo restores the map),
  counted by "modified since applied", summarized, compared on import.
- **Test ids**: `rl-language-button` (rail, `data-language`, `data-scope`), `rl-language-badge`, `rl-language-indicator`
  (header, `data-language`, `data-scope`), `rl-language-panel`, `rl-language-state` (`data-state` default | override,
  `data-scope`, `data-value`), `rl-language-search`, `rl-language-list`, `rl-language-option` / `rl-language-custom`
  (`data-tag`, `aria-selected`), `rl-language-invalid`, `rl-language-fallbacks`, `rl-language-preview` (`data-valid`),
  `rl-language-error`, `rl-language-scope-tab|site`, `rl-language-reload`, `rl-language-apply`, `rl-language-reset`,
  `rl-language-pending`, `rl-language-reload-now`, `rl-language-apply-error`; Setups `rl-setup-include-language`.
- **Limits**: Web / Service Workers keep the browser's `navigator.language` and their requests (tabId -1) are not
  rewritten; a page that cached `Intl.*` / the getters before the first override bypasses it; inline scripts that run
  before the override arrives (see Timing); a site override applies to the page host exactly (not subdomains), any
  port; JS in frames follows the tab's top-level host; an explicit Accept-Language set by page JS or in the editor for a
  Page-mode replay is replaced by the rule.
- **Tests**: tests/unit/language.test.ts (tags, q-values, ordering, picker search, site keys, siteLanguages sanitizer
  and equality, status validation, Setups integration), tests/unit/bg-language.test.ts (rule building, host regex,
  manager: tab / site / refresh / load / close / replace, DnrManager keeps the language rules, router: panel-only
  messages, GET_TAB_STATE language, extension-mode header), E2E tests/e2e/language.spec.ts.

## 12. Errors view — failing endpoints, Claude analysis, opt-in fixes (docs/CLAUDE_INTEGRATION.md "Errors view")

```
 panel  App: useErrorGroups(entries) (src/ui/errors/model.ts) → rail badge / new dot; useErrorAutomation
        (automation.ts: auto-capture once per endpoint per page load, auto-analyze if enabled)
        ErrorsView.tsx (list + detail + Claude section) · dialogs.tsx (confirmations) · store.ts (runs, analyses, shots)
   │ captureErrorArea (src/ui/screenshot/engine.ts): locateComponents {names, scroll} → union rect + 16 px, clamped
   │ (src/lib/screenshot.ts errorAreaRect) → shotBegin(hide overlay) → CAPTURE_VISIBLE_TAB → crop; else the viewport
   │ automatic: no scroll; shotBegin(shown, exclusive) measures → overlay covers the rect? (autoShot.ts) → hide only
   │ while the user is idle, ≤ 2.5 s (maxHiddenMs) — else capture with the overlay shown / wait and retry
   │ panel link: run-start / run-cancel / op-start  ⇄  run-event / run-done / op-done   (src/shared/errors-protocol.ts)
 worker RunRelay (src/background/claude/runs.ts): validation, worker ids, full-mode gate (settings.errorsFullMode),
        auto gate (settings.autoAnalyzeErrors, analyze only, ≤ 3 / min), ≤ 3 runs, cancel on panel close, fail on port close,
        errors-config {fullMode} → hub on every hello / settings change
   │ native messaging
 hub    RunManager (mcp/src/runs.ts): $SHELL -l -i -c 'exec claude "$@"' claude -p --output-format stream-json --verbose
        --permission-mode plan|acceptEdits [--add-dir shots] --allowedTools … (prompt on stdin, detached process group),
        stream-json → run events, screenshots in $REQLENS_HOME/shots (0700 / 0600, deleted after the run);
        GitService (mcp/src/git.ts): worktrees, diff, commit, discard, push + gh pr create, gh issue create, gh image
```

- **Model** (pure): `classifyEntry` (5xx, 4xx, network, timeout — error text "timed out" / TimeoutError —, aborted; fetch,
  xhr, beacon, document, subdocument, script, stylesheet, other; never manual or restored entries), `groupErrors`
  (key = `groupKeyOf` = method + template key; count, statuses, first / last seen, newest kind decides the chip),
  `filterGroups` / `filterCounts` (All · 5xx · 4xx · Network = network + timeout + aborted).
- **Prompts** (`src/lib/errorPrompt.ts`, pure): analysis / fix / terminal prompts, issue and PR bodies, the JSON block
  parser (`parseAnalysis`: last ```json block, else the last balanced object; files as strings or objects), the
  screenshot section (`<img width="260" …>`). Context: `src/ui/errors/context.ts` with the bridge's redacting formatters.
- **Settings**: `projectFolders` (host → folder, ≤ 200, `src/shared/errors-settings.ts`), `autoAnalyzeErrors` (false),
  `errorsFullMode` (false; enabling it goes through the warning `rl-errors-full-dialog`), `captureErrorScreens` (true).
- **Automatic screenshots** (non-intrusive; pure rules in `src/ui/errors/autoShot.ts`, run by `automation.ts`): the page
  is never scrolled; the area is measured with the overlay shown (`shotBegin {hideOverlay: false, exclusive: true}` —
  refused with `SHOT_BUSY_ERROR` while another capture session is open or Find in page peeks / picks). When none of the
  hit regions the panel reports (panel, pill, menus, toasts; `panel/hit.ts reportedHitRegions`) intersects the area,
  it is captured with the overlay shown (the crop leaves it out). Otherwise the overlay is hidden only while the user is
  not working with it (`panel/activity.ts`): the pointer over the overlay (the panel's last pointer event is newer than
  the page's, `ShotViewport.pointerAt` — the frame gets no leave event when the pointer exits through its clip), a key /
  pointer / wheel event in it within 2 s, an open menu / popover / dialog, a drag / resize (pointer captured), a focused
  text field. It also waits while the tab is hidden, the overlay is closed / minimized, or a capture session of the panel
  is open. Waiting attempts retry after 0.5 / 1 / 2 / 3 / 5 s (then every 5 s) and give up 30 s after the first one
  ("skipped — busy"; "Capture error area" stays available and cancels a waiting one). The hidden window is capped at
  2.5 s from hide to restore (`AUTO_SHOT_MAX_HIDDEN_MS`; the engine abandons the capture and ends the session, and the
  page side enforces `maxHiddenMs` by itself): a slower capture is reported as failed. States per endpoint in the store
  (`setAutoShot`; waiting / skipped / failed shown in the Screenshot section).
- **Capture sessions** (every screenshot, manual too; `engine.ts inSession`, `page/controller.ts`): begin and the page
  calls time out after 10 s, CAPTURE_VISIBLE_TAB after 10 s (`CAPTURE_REQUEST_TIMEOUT_MS`), and the session is always
  ended (`shotEnd` → `'ok' | 'cancelled' | 'expired' | 'none'`; anything but `'ok'` fails the capture: the overlay may
  have been shown again). The page side restores by itself: a session with the overlay hidden after 5 s without a call
  (`SHOT_HIDDEN_IDLE_MS`), with the overlay shown after 30 s (`SHOT_IDLE_MS`), never while a pick waits for the user (the
  picker's own 5 min timeout), at the `maxHiddenMs` cap, on Esc, when the panel disconnects. Restoring puts back the
  window's scroll position, the scroll containers an element capture scrolled (`shotElement`, §13.1), hidden fixed
  elements and the overlay. The worker fails a `captureVisibleTab` call after 15 s (`CAPTURE_CALL_TIMEOUT_MS`), so a
  hung call cannot block the queue.
- **Terminal pre-fill**: `TerminalStore.start(cwd, cols, rows, {prefill})` types the text once the output was quiet
  800 ms after `pty-opened` (≤ 15 s), never with a newline: `prefillInput` strips control characters and wraps it in a
  bracketed paste when the program enabled it (ESC[?2004h), else joins it into one line.
- **Limits**: component lookup in the top frame only; captures only in the overlay of the active, visible tab and not
  while the panel first renders; an automatic capture of a component that is off screen captures the visible page (it
  never scrolls); the pointer leaving the browser window from the overlay still counts as over it (no page event); a
  run is cancelled when its panel goes away (page reload); Claude runs are POSIX only; fixes need a git repository with
  a commit; diffs are capped (300 K chars, 60 K per file).
- **Test ids**: rail `rl-view-errors` (`data-shots`, `data-capturing`), `rl-view-errors-count`, `rl-errors-new-dot`; view
  `rl-errors-view`, `rl-errors-empty`, `rl-errors-total`, `rl-errors-filter` (`data-filter`, `aria-pressed`) +
  `rl-errors-filter-count`, `rl-errors-folder` (`data-folder`, `data-host`), `rl-errors-folder-change`,
  `rl-errors-folder-clear`, `rl-errors-folder-picker`, `rl-errors-list`, `rl-errors-group` (`data-key`, `data-kind`,
  `data-count`, `data-status`, `data-new`), `rl-errors-detail` (`data-key`), `rl-errors-outcome`, `rl-errors-calls`,
  `rl-errors-call` (`data-entry-id`), `rl-errors-response`, `rl-errors-request`, `rl-errors-show-request`,
  `rl-errors-initiator` (`data-component`), `rl-errors-initiator-component`, `rl-errors-initiator-frame`, `rl-errors-shots`,
  `rl-errors-shot` (`data-area` component | viewport, `data-component`, `data-auto`, `data-width` / `data-height` in CSS
  px), `rl-errors-capture`, `rl-errors-auto-shot` (`data-state` waiting | skipped | failed, `data-reason` gesture | popup |
  typing | pointer | input | hidden-tab | closed | session), `rl-errors-shot-view`, `rl-errors-shot-copy`,
  `rl-errors-shot-remove`, `rl-errors-shot-close`;
  Claude `rl-errors-claude` (`data-mode` safe | full), `rl-errors-claude-unavailable`, `rl-errors-no-folder`,
  `rl-errors-analyze`, `rl-errors-cancel`, `rl-errors-terminal-fix`, `rl-errors-terminal-issue`, `rl-errors-copy-issue`,
  `rl-errors-create-issue`, `rl-errors-try-fix`, `rl-errors-try-fix-pr`, `rl-errors-run` (`data-state`, `data-kind`),
  `rl-errors-run-log`, `rl-errors-run-tool`, `rl-errors-run-cost`, `rl-errors-run-error`, `rl-errors-analysis`
  (`data-kind`), `rl-errors-analysis-title`, `rl-errors-analysis-root`, `rl-errors-analysis-files`, `rl-errors-stored`,
  `rl-errors-fix` (`data-branch`, `data-worktree`, `data-discarded`), `rl-errors-diff`, `rl-errors-diff-stat`,
  `rl-errors-diff-file` (`data-path`), `rl-errors-vscode`, `rl-errors-diff-refresh`, `rl-errors-commit`,
  `rl-errors-open-pr`, `rl-errors-discard`, `rl-errors-discarded`, `rl-errors-committed`, `rl-errors-pr-url`; dialogs
  `rl-errors-dialog` (`data-kind` issue | pr | commit | discard), `rl-errors-dialog-commands`, `-title`, `-body`,
  `-message`, `-branch`, `-upload-toggle`, `-upload`, `-upload-error`, `-image` (`data-uploaded`), `-image-url`,
  `-without-image`, `-attach`, `-confirm`, `-cancel`, `-error`, `-result` (`data-url`), `-copy-image`,
  `rl-errors-gh-missing`, `rl-errors-gh-unauthenticated`, `rl-errors-gh-image-missing`; settings `rl-errors-settings`,
  `rl-errors-capture-screens`, `rl-errors-auto-analyze`, `rl-errors-full-mode`, `rl-errors-full-dialog`,
  `rl-errors-full-confirm`, `rl-errors-full-cancel`.
- **Tests**: tests/unit/errors.test.ts (classification / grouping, prompts and JSON parsing, redaction, protocol
  validation, command previews, gh-image helpers, settings, the worker relay's full-mode / auto / cap gating, rects,
  terminal pre-fill), tests/unit/mcp-runs.test.ts (→ mcp/src/__tests__/runs.suite.ts: stream-json, argv incl. hostile
  arguments through the real shell, worktree rules, the real hub with REQLENS_CLAUDE_COMMAND / REQLENS_GH_COMMAND
  stand-ins against a temp git repo with a bare origin: safe run, cancel, caps, mode gating, worktree create / diff /
  commit / discard, push + PR, issue, gh image success / SSO / missing extension), tests/unit/errors-autoshot.test.ts
  (intersection, interaction recency, busy states, retry / give-up schedule, the hidden-window cap with fake timers, the
  capture pipeline over a fake backend, session bookkeeping), tests/unit/screenshot-controller.test.ts (the page side's
  idle / cap / Esc restores, `exclusive`, picks, the page pointer time), tests/unit/bg-capture.test.ts (worker call
  timeout), E2E tests/e2e/errors.spec.ts (screenshot docs/screenshots/errors.png; automatic captures: no overlap → the
  overlay is never hidden; overlap + pointer over the panel → no hide until the pointer leaves; a slow worker capture —
  E2E build hook `globalThis.__reqlensCaptureDelayMs` in the service worker — → hidden ≤ ~2.5 s, reported as failed).

## 13. Find in page — which response values the page shows, and where a page value comes from

```
 panel   JsonViewer (opt-in `findInPage`: Original response, Test result, WebSocket message) → useFindInPage → FindClient
         collectCandidates (src/lib/findInPage.ts: leaf values deduplicated, ≤ 3000, strings > numbers > dates, shallow first)
   │ Port call findStart {scanId, candidates, locales (Site language override), watch}   (src/shared/find-protocol.ts)
 ui.js   FindManager (src/ui/frame/findInPage.ts), one per panel connection — never content.js (pages without the
         overlay pay nothing):
           variantsFor (page locale: <html lang>, the hints, navigator.language) → buildPageIndex (findIndex.ts: text
           nodes, open shadow roots, same-origin iframes, form values, title / alt / aria-label / placeholder / value /
           href / src / srcset + URL parts) → TextMatcher (exact map + indexOf over one buffer, offset table, binary
           search) → visibility → {t:'find-results'} (streamed; later passes send changes only)
           MutationObserver (document, shadow roots, iframe docs) → debounced re-scan (500 ms, ≤ 2 s while it keeps changing)
   │ Port call findLocate → peek: overlay hidden (FrameHost.setPeekHidden), scrollIntoView, showFindHighlight
   │   (highlight.ts) + showFindBar (findBar.ts); Esc / ✕ → overlay back, iframe focused, {t:'find-return', nodeId}
   │ Port call findPick → startFindPicker (findPicker.ts) → {texts, label, locales}
 panel   searchSources (src/ui/find/source.ts over src/lib/findSource.ts): captured bodies + WebSocket text frames
         → popover (FindSource.tsx) → select the request, Original response tab (resultsTab.ts), requestReveal (reveal.ts)
   │ Port calls findElements / findHighlight / findValues → element locators, element peeks, one-shot value scans
   │   (findElements.ts, §13.1) — a JSON value's camera action and the MCP screenshot / find_in_page handlers
```

- **Candidates** (`collectCandidates`, panel): every string / number / ISO date leaf; skipped: booleans, null, strings
  shorter than 3 characters (after whitespace normalization) or longer than `FIND_MAX_VALUE_CHARS` (1000), numbers with
  fewer than 3 significant digits. One candidate per distinct value (all its JSON node ids), sorted strings → numbers →
  dates, then depth, then document order, capped at `FIND_MAX_CANDIDATES` (3000; the rest is counted and shown as
  "N not searched"). Only id, kind, value and key (hint for money / byte-size numbers) go to the host.
- **Variants** (`variantsFor`, host, pure): strings → the whitespace-collapsed text; URL-like strings → decoded path and
  last segment (only file names / id-like slugs, not plain words); file names with a known extension → the base name.
  Numbers → the literal, `toFixed(2)` for fractions and money-like keys, `Intl.NumberFormat` per locale with and
  without grouping (exact for big integers: the literal is formatted as a string), `,` `.` space `'` groupings of
  integers ≥ 10 000, `1,2 MB`-style byte sizes for size-like keys. ISO dates → yyyy-mm-dd, dd/mm/yyyy, mm/dd/yyyy and the
  locale's default / short / medium / long date; date-only values also the local day of UTC midnight (what
  `new Date('2024-03-15').toLocaleDateString()` shows west of UTC); date-times the local and the written day, HH:MM and
  the locale's short time, date + time forms. Confidence: 3 exact original, 2 normalized / derived, 1 formatted.
  Locales: `<html lang>`, the panel's "Site language" hint, `navigator.language(s)` (≤ 3, canonical).
- **Matching** (`TextMatcher`): targets T_TEXT (text node), T_FIELD (input / textarea value — never password, hidden or
  file inputs — and the selected option), T_BLOCK (text of a block element joined from ≥ 2 inline pieces, whole-text only:
  `<b>1.258</b>.291`), T_ATTR, T_ATTR_PART (resolved URL, path, decoded segments, query values of href / src / srcset).
  Case-folded exact map of whole texts; variants ≥ `FIND_MIN_SUBSTRING` (5) are also searched with `indexOf` inside
  texts and attribute values (two buffers joined by U+0001, which normalization removes, so a hit never spans two
  targets), mapped back by binary search over the start offsets. Word boundaries (no `active` inside `inactive`) and
  number boundaries (no `258.291` inside `1.258.291`). Overlapping hits of one value count once; attribute hits count once
  per element and not at all when the element's own text matched. Best kind: exact > substring > attribute.
- **Limits / timing**: ≤ `FIND_MAX_TEXT_CHARS` (5 MB) of page text indexed; ≤ 200 hits kept per value (`common`
  beyond: count only, not locatable), counting stops at 1000; work in ≤ 8 ms slices yielding through a MessageChannel,
  abortable (a new findStart / an explicit rescan supersedes the running pass); re-scans wait 500 ms of quiet (at most
  2 s, longer — 3× the last pass — when passes are slow); element references are WeakRefs dropped 5 min after their pass
  (a later locate re-scans first). A result is "visible" when its element passes `checkVisibility()` (display,
  content-visibility, visibility), has client rects and a non-empty rect (a text hit: its Range).
- **Peek**: `findLocate` resolves the live, rendered matches in visual order (re-scanning once when none is left), hides
  the overlay and the minimized pill (`setPeekHidden`, independent of the open state and of the screenshot tool's
  `setCaptureHidden`), scrolls same-origin iframes then the element into view (smooth, `block: 'center'`; instant with
  reduced motion), and draws `<reqlens-find-highlight>` (a box exactly on the matched text / element, Kinebot-blue
  outline + glow, following scrolling in any scroller and in iframes, resizes and layout shifts) and
  `<reqlens-find-bar>` (top center, only the bar takes pointer events). ← / → or Enter / Shift+Enter cycle (when the
  focus is on the bar or nowhere in particular), Esc / ✕ end it: the overlay is shown again, its iframe focused and the
  panel gets `find-return` → the JsonViewer expands the way to the node, scrolls to it, focuses and flashes it. Clicking
  the page does not end it; the overlay closing, the panel going away or `pagehide` end it silently.
- **Where does this come from?** (`rl-find-source`, list toolbar): `findPick` hides the overlay and shows
  `<reqlens-find-pick>` (hover box, click picks, ↑ / ↓ parent / child, Esc cancels, 5 min timeout). The picked element's
  texts (joined text, each text node, form value, alt / title / aria-label / placeholder, resolved href / src) and the
  page's locales come back; `buildSourceQueries` (src/lib/findSource.ts) adds the numbers in them (each locale's
  separators, every reading of ambiguous tokens, byte-size units and percent), dates (ISO, numeric in both orders,
  month names of the locales and English) and times; `searchSources` walks the captured response bodies (newest first,
  ≤ 2 MB each, JSON via `JSON.parse` + iterative walk, else plain text) and WebSocket text frames (≤ 5000, newest first)
  in 8 ms slices: same text (3), containing / contained text, number, date (2), rounded number, size, percent, time
  (1). Clicking a match selects the request, opens its Original response (`requestResultsTab(id, 'original')`) and
  reveals the path (`requestReveal(originalRevealKey(id), path)`); WebSocket matches switch to the WebSocket view and
  select the message (`requestWsReveal`).
- **Panel**: one `FindController` per page connection (`findControllerOf`); of the viewers that want to scan (shown —
  `FindScopeContext`: the HTTP view or the WebSocket view is visible, the panel open and not minimized — and
  `settings.findInPage`), the most recently activated owns the page session; the others are stopped (`findStop`, the
  host disconnects its observer). Results fan out to every JSON node holding the value (`byNode`), notified ≤ once per
  animation frame; rows are memoized so streaming results only re-render the rows they change. Keyboard: L on a focused
  row locates it. Settings: `findInPage` (default true; Settings → "Find response values on the page", and the
  toolbar switch).
- **Security**: the scan runs only in ui.js (the extension's isolated world) for an authenticated panel; nothing is
  posted to the page's context, no page script runs, MAIN world not involved; the page sees no events and no DOM
  changes except our closed-shadow-root layers. Captured text in those layers (the JSON path and value snippet of the
  label and the bar) is CSS generated content (`content: attr(…)`), which `window.find()` / Selection cannot reach
  (E2E-checked). Host-side validation: `sanitizeFindScanRequest` / `sanitizeFindLocateRequest` (ids, kinds, lengths,
  canonical locales, ≤ 3000 candidates).
- **Limits**: cross-origin iframes and closed shadow roots are not read; `<canvas>`, images of text, and rows a
  virtualized list has not rendered cannot match; heavily transformed values (abbreviated, rounded beyond the
  displayed precision, converted units other than byte sizes, translated, concatenated across separate elements in
  other than whole-block form) are missed, and short / common values can match unrelated text (word and number
  boundaries and the confidence in the tooltip limit that); input values typed after a pass are seen on the next
  re-scan (typing is not a DOM mutation); the reverse search covers what the panel holds (hook-captured bodies:
  webRequest-only entries have none; bodies over 2 MB are skipped).
- **Test ids**: JSON viewer `rl-find-icon` (`data-state` visible | attr | hidden | common, `data-total`, `data-visible`),
  `rl-find-capture` (row action: screenshot of the value's element, §13.1),
  `rl-find-status` (`data-state` scanning | done | error | off | idle, `data-found`), `rl-find-rescan`, `rl-find-toggle`
  (role switch, `aria-checked`); Settings `rl-settings-find-in-page`; page layers (open shadow roots in the E2E build)
  `rl-find-highlight`, `rl-find-highlight-label` (`data-path`, `data-snippet`), `rl-find-bar`, `rl-find-bar-count`,
  `rl-find-bar-prev`, `rl-find-bar-next`, `rl-find-bar-path` (`data-text`), `rl-find-bar-close`, `rl-find-pick-layer`;
  list `rl-find-source` (`data-state`), `rl-find-source-popover` (`data-state` searching | done | error),
  `rl-find-source-query`, `rl-find-source-group` (`data-entry-id`, `data-url` / `data-ws-id`, `data-frame-id`),
  `rl-find-source-match` (`data-path`), `rl-find-source-empty`, `rl-find-source-again`, `rl-find-source-close`; JSON rows
  `.rl-jv__row--flash` after a reveal.
- **Tests**: tests/unit/find-in-page.test.ts (normalization and raw-offset mapping, ISO dates, candidates — skips,
  dedupe, priority, cap, deep trees —, variants in pt-BR / en-US / de-DE incl. time zones, URLs and file names, the
  matcher — offset table, boundaries, overlaps, block / field / attribute targets, caps, a 50 000-text buffer —, the
  summary, protocol sanitizers), tests/unit/find-source.test.ts (localized numbers, dates, times, round trip with the
  variants, leaf matching, JSON / text search), tests/unit/find-controller.test.ts (session ownership, fan-out, locate
  with an expired session, find-return, wording, ancestorIds), E2E tests/e2e/find-in-page.spec.ts (files page: icons on
  name / pt-BR size / pt-BR date / id-in-href, none on unrendered values, a late element picked up by the re-scan,
  locate → overlay hidden, box ≈ element, bar count and cycling, page clicks keep the peek, Esc / ✕ focus the node,
  generated-content check with window.find, on / off persisted; WebSocket detail; reverse pick of a name and of a pt-BR
  number) and its screenshot docs/screenshots/find-in-page.png. Element locators and captures: §13.1.

### 13.1 Element screenshots with a padding, element locators, the MCP `screenshot` / `find_in_page` handlers

```
 panel   a JSON value's camera action (FindParts.tsx FindCaptureButton, key S) · the tool's Element pick · the MCP
         handlers (src/ui/control/shot.ts runShotCommand / runFindCommand, called by the control plane's dispatcher)
   │ Port call findElements {selector | text | value, exact, limit, locales} → ui.js findElements.ts (Find in page's
   │   page index + matcher) → ElementMatch[] {ref (elementRefs.ts), tag, text, selector, page rect, visible}
   │ captureArea (src/ui/screenshot/engine.ts): shotBegin(shown, exclusive) → shotElement(ref, scroll) (scrollIntoView
   │   'nearest'; its scroll containers saved for shotEnd) → area = element + padding + SHOT_SPARE_MARGIN, clamped to
   │   the page (src/lib/elementShot.ts) → planAreaTiles → per tile: shotScroll(y, hideFixed, x); the overlay hidden
   │   only while one of its hit regions covers the part in view → CAPTURE_VISIBLE_TAB → stitch → crop element + padding
 store   ShotItem.padded {source = the whole area picture, padding, crop, limit} → result view PaddingControl: re-crop
         (setShotPadding, no capture) up to `limit`; past it recaptureShot (same ref / region), else what was captured
```

- **Padding**: `settings.shotPadding` (default 50, 0..`SHOT_PADDING_MAX` = 1000 CSS px; Settings → "Screenshot padding",
  the tool's Element mode field), per command for the MCP tool. Clamped to the page: a side that reaches the page edge
  keeps less ("padding clipped at the page edge (left)").
- **Spare margin**: `SHOT_SPARE_MARGIN` = 200 CSS px are captured beyond the padding on every side (clamped to the page)
  and kept as the capture's source picture, so the padding can grow afterwards without a new capture: the result view's
  padding control (slider + number) re-crops live up to `limit` = the smallest captured margin (sides at the page edge do
  not count); annotations move with the picture (`shiftAnnotations`). Past it (slider released / number committed) the
  element is captured again from its ref (a region from its page rect) into the same item, annotations kept relative to
  the element; when the element is gone the crop stays at what was captured and the control says why. 200 px covers the
  usual "a bit more context" and adds at most one row / column of tiles.
- **Scrolling, tiles**: the element is scrolled into view (block / inline `nearest`; its scroll containers are put back
  at shotEnd, the window as for every capture). An area that fits the viewport is captured where it already is in view,
  else centered; a larger one in viewport-sized cells row by row (`planAreaTiles`), fixed / sticky elements hidden from
  the first tile (they would repeat, or cover the area at each viewport top), stitched on an OffscreenCanvas with
  contiguous rows at fractional DPR (`tilePixels`), capped like a full page (20 000 CSS px tall, canvas limits; noted).
  An element that is (inside) `position: fixed` is captured as the viewport shows it, without scrolling. A part the page
  cannot scroll into view stays blank (noted).
- **Overlay**: hidden only while it covers the part being captured (`overlayCovers` against the panel's reported hit
  regions, as automatic error captures decide); a pick keeps it hidden for the whole capture. Every pipeline runs in a
  capture session (§12 "Capture sessions"), so it is never left hidden.
- **Locators** (`ElementQuery`; page side `src/ui/frame/findElements.ts`; top document and open shadow roots, same-origin
  iframes are not searched): a CSS selector (`Element.matches` over the composed tree); a visible text / label — the
  page's text runs joined into one case-folded buffer (a space between blocks and where the page has whitespace, none
  between inline pieces: `<b>1.258</b>.291` reads `1.258.291`), case- and whitespace-insensitive, "contains" unless
  `exact` (the element's whole text); a hit becomes the smallest element holding all of it; labels — aria-label,
  title, alt, placeholder (`exact`: the whole value) — and form values (never password / hidden / file inputs) match on
  their element; nested matches keep only the innermost ones (the smallest element showing the text, like Playwright's
  getByText); a response value — matched exactly as Find in page matches it (`variantsFor` in the page's locales and
  the "Site language" override, word / number boundaries), a text hit standing for its parent element (`exact`: the hit
  is that element's whole text); `requestId` + `path` — the panel reads the captured response's JSON (the overlay's
  path syntax, `data.items[0].name`; `"selected"` = the overlay's selection) and looks for that leaf as a value, with its
  key as hint. Matches come in document order (described ≤ `limit`, counted to 1000) with `visible` (rendered:
  checkVisibility + a non-empty box; possibly scrolled away); a command takes `index` when given, else the first
  visible match. Elements leave the page side only as refs (random ids over WeakRefs, ≤ 10 min, ≤ 2000).
- **MCP handlers** (contract `src/shared/control-shot.ts`): `runShotCommand` — target visible | full | region | element
  (default: element with a locator, else visible), padding, `image` (full resolution PNG) and `preview` (≤
  `SHOT_PREVIEW_MAX` = 1568 px on the long side; JPEG when its PNG would exceed 1.5 MB), area, notes, element info,
  match count and index; the capture joins the tool's recent strip and `open` switches the panel to the Screenshot view
  with it (`setPanelView` + `requestShotSelection`; showing the overlay is the dispatcher's). `runFindCommand` — matches
  as `ElementInfo`; `highlight` → `findHighlight`: an element peek like findLocate's (overlay hidden, box, mini-bar
  cycling the visible matches; the bar does not take the focus) that ends by itself after `ELEMENT_HIGHLIGHT_MS` (8 s;
  Esc / ✕ earlier; every command ends one first); `requestId` alone → `properties`, the response values the page shows
  (`findValues`: one scan of the response's candidates without a session — the overlay's own scan is left alone — in
  the response's order, with `as` = the form shown when it differs). Commands run one at a time (`serialize`), only on
  a free page (exclusive shotBegin: busy while the user captures, picks or looks at a value), and fail fast while the
  tab is hidden (`document.visibilityState`; a plain find still answers). They work while the overlay is mounted but not
  shown: nothing here shows it; the App registers its bridge for them (`useShotControl`).
- **Contract additions** (optional fields): `FindCommandResult.highlighted`, `.notes`, `properties[].visible`,
  `properties[].as`. Protocol: `ShotCalls.shotElement`, `shotScroll(y, hideFixed, x?)`, `ShotPickResult.ref`,
  `FindCalls.findElements` / `findHighlight` / `findValues` (validated host-side: `sanitizeElementQuery`,
  `sanitizeElementHighlightRequest`, `sanitizeFindValuesRequest`).
- **Security**: as §13 — the locators only read the DOM in ui.js for the authenticated panel; refs are opaque; the
  highlight label is CSS generated content; inner scroll positions and the window are restored.
- **Test ids**: `rl-find-capture`, `rl-shot-padding` (`data-padding`, `data-limit` px | page, `data-state` idle |
  cropping | capturing, `data-short`), `rl-shot-padding-range`, `rl-shot-padding-input`, `rl-shot-padding-note`,
  `rl-shot-note` (meta line: clipped padding, stitching…), `rl-shot-default-padding` (Element mode),
  `rl-settings-shot-padding`.
- **Tests**: tests/unit/element-shot.test.ts (padding / margin / crop math and clamping, re-crop limit, tiles, preview
  size, annotation shifts, the setting, sanitizers), element-locate.test.ts (text runs, labels, match choice, value kinds,
  paths), element-capture.test.ts (captureArea over a fake page: overlay decisions, scrolling, stitching, fixed and gone
  elements, re-crops; the handlers over a fake connection: locators, index, requestId + path, preview, open, highlight,
  properties, hidden tab, busy page), element-shot-page.test.ts (shotElement, scroll containers restored, fixed, refs,
  picks); E2E tests/e2e/element-capture.spec.ts (camera action → Screenshot view with element + 2 × padding × DPR; padding
  re-crops without a capture, then captures again past the margin; the overlay always back; the handlers through the
  E2E hook: label / value / path locators, values shown, a far and a tall element, open, highlight), screenshot.spec.ts
  (element pick exactly with padding 0, and with a padding changed afterwards).
- **Limits**: tiles scroll the window only (an element taller than its own scroll container shows what the container
  shows); same-origin iframes are not searched by the locators; a re-capture after the page changed may frame a moved
  element differently (annotations stay relative to the element).
