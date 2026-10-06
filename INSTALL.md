# Installing kineReqLens

One command per machine: clone the repository and run the installer. It installs the dependencies, builds the
extension, optionally connects it to Claude Code, and walks you through loading it in the browser.

## Quick start

You need **Node.js 20 or newer with npm** (the installer tells you how to get it, and offers Homebrew / winget if you
agree), **git**, and **Microsoft Edge**, Chrome, Chromium or Brave. Optional: [Claude Code](https://claude.com/claude-code)
for the Claude features. The repository is public: no access request or SSH key is needed.

**macOS / Linux**

```sh
git clone https://github.com/AthosMatos/kinereqlens.git
cd kinereqlens
./install.sh
```

**Windows** (PowerShell)

```powershell
git clone https://github.com/AthosMatos/kinereqlens.git
cd kinereqlens
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Node.js already installed? `npm run setup` runs the right script on any OS (options after `--`:
`npm run setup -- --yes --with-claude`).

The last step tells you how to load the extension. It also copies the folder path to the clipboard, opens the
extensions page and shows the folder:

1. Open `edge://extensions` (`chrome://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `dist` folder of your clone (macOS: press Cmd+Shift+G in the dialog and paste the path; Linux: Ctrl+L).

## What the installer does

| Step | |
|---|---|
| Prerequisites | Node.js ≥ 20 and npm (install commands per OS; Homebrew / winget only after you answer yes, never with `--yes`), git (optional), Claude Code (optional), the installed browsers |
| Dependencies | `npm ci`, skipped when `node_modules` already matches `package-lock.json`. Then checks that `node-pty` (the embedded Claude terminal) loads and can start a process, restores its `spawn-helper` exec bit, and runs `npm rebuild node-pty` if needed. If it still fails, it says which build tools to install and goes on: only the terminal needs it |
| Extension | `npm run build` → `dist/` |
| Bridge | `npm run build:mcp` → `mcp/dist/reqlens-mcp.mjs` |
| Claude Code (optional) | `reqlens-mcp install`: the native messaging host (a launcher in `~/.reqlens`, a manifest per browser; HKCU registry keys on Windows). `claude mcp add --scope user reqlens -- <node> <clone>/mcp/dist/reqlens-mcp.mjs`, after asking when a different `reqlens` entry exists. `reqlens-mcp doctor` |
| Browser | The Load unpacked steps above |

- **Safe to run again**: it skips what is already done.
- **No sudo or administrator prompt**: the only exception is winget's own Node.js installer, and only if you ask for it.
- **What it writes**: the clone, `~/.reqlens` (`$REQLENS_HOME`), the browsers' user-level `NativeMessagingHosts`
  folders (HKCU keys on Windows) and Claude Code's user configuration (through `claude mcp`).

The Claude Code step runs when `claude` is on your PATH, after asking. Otherwise it is skipped, and
`./install.sh --with-claude` adds it later. The same local bridge serves the embedded terminal, the Errors view and
the React Native support.

## Options

Both spellings work with every script: `install.sh`, `install.ps1` and `npm run setup --`.

| Option | PowerShell spelling | |
|---|---|---|
| `--yes`, `-y` | `-Yes` | Don't ask, answer yes |
| `--with-claude` | `-WithClaude` | Set up the Claude Code bridge without asking. If `claude` is not on PATH it still installs the native messaging host, and prints the `claude mcp add` command for later |
| `--no-claude` | `-NoClaude` | Skip the Claude Code bridge |
| `--browser <name>` | `-Browser <name>` | `edge`, `chrome`, `chromium`, `brave` or `all`; repeatable or comma-separated. Default: the installed ones, Edge first |
| `--update` | `-Update` | `git pull --ff-only` first. If the pull changed the installer, it continues with the new one |
| `--no-open` | `-NoOpen` | Don't open the browser or file manager, and leave the clipboard alone (automatic over SSH and on Linux without a display) |
| `--dry-run` | `-DryRun`, `-WhatIf` | Print the commands that would change something, including the Windows registry keys, without running them |
| `--help` | `-Help` | |

## The extension ID

`static/manifest.json` has a `"key"` (an RSA public key). It gives the unpacked extension the same ID on every
machine, whatever folder it is loaded from: **`edijjpphloiddgmdemojcllinhcllppp`**.

- Where it lives: `EXTENSION_ID_UNPACKED` in `src/shared/constants.ts`, checked against the key by
  `tests/unit/extension-id.test.ts`.
- `reqlens-mcp install` (and `npm run mcp:install`) always allow this ID. They also allow every `--extension-id` you
  pass (for example a store build's) and the IDs an existing manifest already allows.
- The matching private key is not needed for anything and is not stored anywhere. Never add one to the repository.
- `npm run zip` packages `dist/` for Edge Add-ons and the Chrome Web Store **without** `"key"`, because the store
  assigns its own ID. To allow a store build's ID: `npm run mcp:install -- --extension-id <id>`.
- With the same ID everywhere, load only one unpacked copy per browser profile.

## Updating

```sh
./install.sh --update        # Windows: powershell -ExecutionPolicy Bypass -File .\install.ps1 -Update
```

Then click the reload icon on the kineReqLens card in `edge://extensions`. With the Claude Code bridge on, turn
**Settings → Claude Code → Enable the Claude Code bridge** off and on: that restarts the bridge with the new code.
Start a new Claude Code session so it loads the updated MCP tools.

## Uninstalling

```sh
./uninstall.sh               # Windows: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

1. Removes the native messaging host: the launcher and the manifests (HKCU keys on Windows).
2. Asks before removing the `reqlens` MCP server from Claude Code: `--yes` removes it, `--no-claude` keeps it.
3. Shows how to remove the extension: `edge://extensions` → kineReqLens → **Remove**.

It never deletes the clone or `~/.reqlens` (bridge log, screenshots, the React Native pairing token). Delete them
yourself if you want. Without Node.js, the uninstall scripts remove the native messaging host files directly, plus
the registry keys on Windows.

## Moving from an older install

Builds made before the fixed ID got an ID derived from their folder path. The browser keeps kineReqLens's settings,
Setups and list rules per extension ID, so the rebuilt extension starts empty. The installer warns you when your
`dist/` was built without the fixed ID. Then:

1. **Export your Setups first**: kineReqLens overlay → **Setups** → **Export all** (or **Export** in one setup's ⋯
   menu). You can still do this after the installer ran, until you reload the extension or restart the browser.
2. Run the installer. It rebuilds `dist/` and regenerates the native messaging host, which now allows the fixed ID
   (old IDs stay allowed).
3. In `edge://extensions`, remove the old kineReqLens card, then **Load unpacked** `dist/` again.
4. **Setups → Import**. Turn Settings → Claude Code (and React Native) back on, and check your other settings.

## Troubleshooting

- **A popup or banner about extensions in developer mode when the browser starts**: expected for unpacked
  extensions. Dismiss it. If you choose to turn them off, kineReqLens stays disabled until you turn it back on in
  `edge://extensions`.
- **node-pty / embedded terminal unavailable**: the installer prints what is missing. Install the build tools for
  your OS, then run `npm rebuild node-pty` (or the installer again):

  | OS | Build tools |
  |---|---|
  | macOS | `xcode-select --install` |
  | Debian / Ubuntu | `sudo apt install build-essential python3` |
  | Fedora | `sudo dnf install gcc-c++ make python3` |
  | Arch | `sudo pacman -S --needed base-devel python` |
  | Windows | Visual Studio Build Tools with "Desktop development with C++", plus Python 3. Rarely needed: x64 and arm64 binaries come prebuilt |

  `package.json` approves node-pty's install script for npm 11+ (`allowScripts`). If npm still says it is blocked,
  run `npm approve-scripts node-pty`.
- **"Specified native messaging host not found"** (Settings → Claude Code or React Native): the native messaging host
  is not installed for this browser. Run the installer with `--with-claude` (or `npm run mcp:install`), then turn
  Settings → Claude Code off and on. A browser you installed after kineReqLens needs this too (`--browser <name>`).
- **"Access to the specified native messaging host is forbidden"**: the manifest does not allow this extension's ID,
  for example after an old install. Run the installer again. `node mcp/dist/reqlens-mcp.mjs doctor` lists the
  allowed IDs.
- **Claude Code does not see kineReqLens**: `node mcp/dist/reqlens-mcp.mjs doctor` checks every link and prints
  fixes. `claude mcp get reqlens` must run this clone's `mcp/dist/reqlens-mcp.mjs`; `/mcp` inside Claude Code shows
  the connection. Start a new Claude Code session after the first registration.
- **Windows: "running scripts is disabled on this system"**: start the scripts with
  `powershell -ExecutionPolicy Bypass -File .\install.ps1`. This applies to that one run only.
- **Windows: `npm ci` fails with EPERM / EBUSY**: the running bridge keeps node-pty open. Turn Settings → Claude
  Code off (or close the browser), then run the installer again.
- **"The hub socket path is … longer than …"**: `REQLENS_HOME` is too deep for a Unix socket (at most 103 bytes on
  macOS). Use a shorter path.
- **Linux: Flatpak / Snap browsers** usually cannot start native messaging hosts installed outside their sandbox.
  For the Claude Code bridge, use the distribution's or the vendor's package (.deb / .rpm).
- **Start over**: delete `node_modules` (and `dist`), then run the installer again.

## Manual setup

```sh
npm ci && npm run build                      # then Load unpacked dist/
npm run mcp:install                          # Claude Code bridge: native messaging host
claude mcp add --scope user reqlens -- "$(command -v node)" "$PWD/mcp/dist/reqlens-mcp.mjs"
```

To remove things by hand:

- **Native messaging manifests**: `com.reqlens.bridge.json` in each browser's `NativeMessagingHosts` folder.
  - macOS: `~/Library/Application Support/<browser>/NativeMessagingHosts`
  - Linux: `~/.config/<browser>/NativeMessagingHosts`
  - Windows: `%USERPROFILE%\.reqlens\com.reqlens.bridge.json`, plus the
    `HKCU\Software\<browser>\NativeMessagingHosts\com.reqlens.bridge` registry keys
- **Launcher**: `~/.reqlens/native-host` (Windows: `native-host.cmd`)
- **Claude Code**: `claude mcp remove reqlens -s user`

Details: [docs/CLAUDE_INTEGRATION.md](docs/CLAUDE_INTEGRATION.md).

The installer is tested end to end on macOS. Its Linux and Windows code paths (including `install.ps1` and
`uninstall.ps1`) are implemented but have not run on those systems yet. `--dry-run` shows what they would do.
