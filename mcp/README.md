# reqlens-mcp: the Claude Code bridge

One bundled Node script (`mcp/dist/reqlens-mcp.mjs`, built by `npm run build:mcp`) with two runtime roles and an
installer:

```
Claude Code ──stdio MCP──► reqlens-mcp serve         one per Claude Code session (Claude Code spawns it)
                                 │  NDJSON over $REQLENS_HOME/hub.sock (dir 0700, socket 0600)
                                 ▼
                            reqlens-mcp native-host   the hub (the browser spawns it through native messaging)
                                 │  4-byte LE length + UTF-8 JSON on stdin/stdout
                                 ▼
                            kineReqLens extension (service worker → tab content script / overlay panel)
```

Wire messages and bridge methods: `src/shared/claude-protocol.ts`. Spec: `docs/specs/v0.2.md` §B.

## Setup

The repository's installer (`./install.sh --with-claude`, Windows `install.ps1 -WithClaude`; [INSTALL.md](../INSTALL.md))
runs steps 1 and 2. By hand:

1. `npm run mcp:install`. This writes the launcher `$REQLENS_HOME/native-host` and the native messaging manifest
   `com.reqlens.bridge.json` for every installed browser (Edge, Edge Beta/Dev/Canary, Chrome, Chromium, Brave). The
   manifest allows the unpacked build's fixed extension ID (static/manifest.json `"key"`); add others, such as a
   store build's, with `-- --extension-id <id>`.
2. `claude mcp add --scope user reqlens -- node <path-to-reqlens>/mcp/dist/reqlens-mcp.mjs` (the installer prints
   the exact command with absolute paths).
3. In the browser: kineReqLens overlay → Settings → Claude Code → **Enable the Claude Code bridge**.
4. Optional: start Claude Code with `claude --dangerously-load-development-channels server:reqlens` so items sent
   with "Send to Claude Code" show up in the conversation (channels research preview). Without the flag they wait
   in the `inbox` tool.

`reqlens-mcp doctor` checks every link (node, launcher, manifests per browser, allowed ids, hub socket) and prints
fixes.

## CLI

```
reqlens-mcp [serve]                MCP server on stdio (default)
reqlens-mcp native-host            the hub (ignores the caller origin the browser appends); also runs the React
                                   Native receiver while Settings → React Native is on (docs/ARCHITECTURE.md §9)
reqlens-mcp install [--extension-id <id> ...] [--browser edge|chrome|chromium|brave|all] [--home <dir>] [--manifest-dir <dir>]
reqlens-mcp uninstall [--browser ...] [--home <dir>] [--manifest-dir <dir>]
reqlens-mcp doctor [--home <dir>] [--manifest-dir <dir>]
reqlens-mcp --help | --version
```

- `install` is idempotent. It always allows the unpacked build's fixed id (`EXTENSION_ID_UNPACKED` in
  src/shared/constants.ts) and keeps the ids of existing manifests; `--extension-id` adds more. Without `--browser` it writes for every browser whose profile directory exists (Edge if none);
  `--browser x` always writes that browser's main channel. `--manifest-dir` writes only there (E2E temp profiles:
  `<user-data-dir>/NativeMessagingHosts`). On Windows the manifest stays in `$REQLENS_HOME` and
  `HKCU\Software\<browser>\NativeMessagingHosts\com.reqlens.bridge` points at it.
- The launcher bakes in `REQLENS_HOME` and absolute node / script paths (a PATH entry such as Homebrew's
  `/opt/homebrew/bin/node` is preferred over a versioned Cellar path). Re-run `install` after moving the repo or
  switching node.
- `REQLENS_HOME` (default `~/.reqlens`) holds `hub.sock`, `hub.log` (rotated at 1 MB to `hub.log.1`) and the
  launcher. A Unix socket path is limited to 103 bytes on macOS (107 on Linux): keep `REQLENS_HOME` short.

## MCP surface (server name `reqlens`)

Tools: `status`, `list_requests`, `get_request`, `get_types`, `get_prompt`, `send_request` (refused unless the user
allowed it and the overlay is open in that tab — or, with the control tools on, in an invisible panel), `inbox`.
Control tools, only while the user turned on "Let Claude control kineReqLens" (otherwise they say where to turn it
on): `inspect` (read-only views), `overlay`, `requests`, `edit_request`, `list_config`, `setups`, `language`,
`settings`, `errors`, `screenshot` (MCP image content + the path of the full-resolution PNG in `$REQLENS_HOME/shots`),
`find_in_page` — one bridge method `control`; actions, coverage and safety:
[docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md#control-tools). Prompts: `implement`, `debug`. Capability
`experimental['claude/channel']`; every pushed inbox item emits `notifications/claude/channel` with
`{ content: <agent prompt>, meta: { source: 'reqlens', request_id, tab_id, target } }`.
Screenshots sent with "Send to Claude" (screenshot tool) carry `images` (saved by the hub in `$REQLENS_HOME/shots`, kept
24 h): the notification content ends with `Screenshot: <absolute path> (use the Read tool to view it)` and meta gets
`image_path`; `inbox` returns each image as MCP image content (`image/png`; over ~5 MB the path instead).

Timeouts: 30 s per call; control tools 60 s (`screenshot` 150 s, `find_in_page` 90 s, `requests resend` like
`send_request`, `errors` 90 s plus `waitSeconds`). `send_request` runs with the extension's replay timeout (`settings.replayTimeoutMs`, default 30 s,
clamped to 10 min for Claude's sends); the extension always answers within that plus 5 s (a timed-out run is a result), so the
server only gives up on its own after 10 min 20 s.

## Embedded terminal

The hub also runs the overlay's embedded Claude Code terminals (`pty-*` native messages, `mcp/src/pty.ts`): the real
`claude` CLI through `node-pty` in the folder the user picked, via `$SHELL -l -i -c 'exec claude'`. `node-pty` is a
native dependency loaded from the repo's `node_modules` at runtime (not bundled); if it cannot load, the overlay shows
the error with the fix (`npm install && npm rebuild node-pty` in the checkout). Details, security and the test-only
`REQLENS_PTY_COMMAND`: [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md).

## Errors view runs

The hub also runs the overlay's Errors view analyses (`run-*` / `op-*` native messages, `mcp/src/runs.ts`,
`mcp/src/git.ts`): the user's `claude -p --output-format stream-json` in the site's project folder (read-only in safe
mode), and — only after the extension enabled full mode (`errors-config`) — fix worktrees, commits, pushes and
`gh issue create` / `gh pr create` / `gh image`. Details, security and the test-only `REQLENS_CLAUDE_COMMAND` /
`REQLENS_GH_COMMAND`: [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md#errors-view).

## Behaviour notes

- The hub keeps nothing but the session list and stops when the browser closes stdin (or on SIGTERM). A second
  browser profile that enables the bridge while another hub is live gets
  `{t:'hello', v, hostVersion, error: 'Another browser is already connected to Claude Code'}` and the hub exits;
  a stale socket left by a killed hub is replaced.
- The hub never writes anything but native messaging frames to stdout; the MCP server writes only JSON-RPC to
  stdout and logs to stderr. Logs carry message types, ids and sizes, never captured data.
- MCP servers reconnect with backoff (0.5 s doubling to 10 s) and immediately when the socket file appears.
- Windows (named pipe `\\.\pipe\reqlens-hub-<user>`, `.cmd` launcher, registry) is implemented but untested.

## Tests

`npx vitest run tests/unit/mcp-*.test.ts`. The suites live in `mcp/src/__tests__/*.suite.ts` (type-checked by
`mcp/tsconfig.json` with node types); `tests/unit/mcp-*.test.ts` only import them. They use temp directories for
`REQLENS_HOME`, manifests and `HOME`, an in-process hub with a fake extension, and a bundle built into a temp dir.
