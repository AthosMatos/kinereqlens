# @kinebot/kinereqlens-react-native

Streams a React Native app's network traffic — `fetch`, `XMLHttpRequest` and `WebSocket` — to kineReqLens on
the developer's machine, where a standalone kineReqLens tab lists it and lets you edit and replay requests.
Replays run **inside the app** with its original `fetch`.

- JavaScript only: no native module, no linking, no rebuild. Works in Expo Go.
- No runtime dependencies (`react-native` is an optional peer).
- Off outside `__DEV__` by default. It never changes how the app's requests behave and never throws into app
  code.

Wire protocol: [PROTOCOL.md](PROTOCOL.md).

## Install

As a dev dependency, from a checkout of this repository or from git:

```sh
# local checkout (path to the react-native/ folder of the kineReqLens repo)
npm install --save-dev ../kinereqlens/react-native
# or yarn add -D file:../kinereqlens/react-native   /   pnpm add -D ../kinereqlens/react-native

# git, pnpm >= 9 (supports a sub-directory of a repository)
pnpm add -D "github:AthosMatos/kinereqlens#path:/react-native"
```

npm and Yarn cannot install a sub-directory of a git repository: clone the repository (or add it as a git
submodule) and install from the path.

Metro loads the TypeScript sources directly (`"react-native"` field / export condition → `src/index.ts`), so
nothing has to be built. Other consumers (Node, Jest without the react-native resolver) use `dist/`: run
`npm run build` in `react-native/` once.

With a local path install, Metro must be able to see the folder. With `file:` installs npm copies or symlinks
it; for a symlink add the folder to `watchFolders` in `metro.config.js`:

```js
const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config'); // or expo/metro-config
const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../kinereqlens/react-native')];
module.exports = config;
```

## Turn it on in kineReqLens

The receiver runs in kineReqLens's local bridge (`reqlens-mcp native-host`, the same one the Claude Code bridge uses):

1. Install the bridge once, from the kineReqLens checkout: `./install.sh --with-claude` (Windows:
   `install.ps1 -WithClaude`) or `npm run mcp:install`.
2. In the kineReqLens overlay (or the React Native window): **Settings → React Native → Receive traffic from React
   Native apps**. The browser asks for the native messaging permission once; the status turns to **Listening on
   127.0.0.1:8790**. The section shows:
   - the **pairing token** (copy / regenerate — regenerating disconnects the apps until they use the new one),
   - the setup snippet with your token, ready to paste,
   - **Accept physical devices on the local network** (listens on `0.0.0.0`; see below) and the **port**,
   - the connected apps and **Open React Native window**.
3. Paste the snippet at the top of the app's entry file (below), reload the app: it appears under connected apps.
4. Dev menu → **Open kineReqLens** opens (or focuses) the standalone kineReqLens tab for that app. With several apps
   or devices connected, pick one at the top of the tab. Send mode **App** replays inside the app; **Extension**
   sends from the browser extension instead.

The token lives in `$REQLENS_HOME/rn-token` (default `~/.reqlens`, mode 0600) and stays the same across restarts.

## Usage

At the very top of the entry file (`index.js`), before anything sends requests:

```js
if (__DEV__) {
  require('@kinebot/kinereqlens-react-native').startKineReqLens({ token: 'PAIRING-TOKEN-FROM-KINEREQLENS' });
}

import { AppRegistry } from 'react-native';
// …
```

Expo Router apps have no `index.js` by default: create one with the snippet followed by
`import 'expo-router/entry';` and set `"main": "index.js"` in `package.json`.

Options (all but `token` optional):

| option | default | |
|---|---|---|
| `token` | — | pairing token shown by kineReqLens (required; the receiver rejects connections without it) |
| `host` | `defaultHost()` | machine running kineReqLens (see below) |
| `port` / `path` | `8790` / `/kinereqlens` | receiver URL `ws://host:port/path` |
| `enabled` | `__DEV__` | `false` = do nothing |
| `captureBodies` | `true` | request/response bodies (`false` = metadata only) |
| `requestBodyCap` / `responseBodyCap` | 1 MB / 2 MB | larger bodies are cut and flagged `truncated` |
| `wsFrameCap` | 256 KB | per WebSocket message |
| `ignoreUrls` | `[]` | `(string \| RegExp)[]`: substring or RegExp against the full URL |
| `captureWebSockets` | `true` | |
| `bufferSize` | 500 | captures kept while kineReqLens is unreachable (oldest dropped) |
| `devMenu` | `true` | adds **Open kineReqLens** to the dev menu |
| `reconnect` | 500 ms → 30 s | `{ minDelayMs, maxDelayMs }` exponential backoff |
| `appName` / `bundleId` / `deviceName` | detected | shown in kineReqLens |
| `onStatus` | — | `(status) => …`: `connecting` / `handshaking` / `connected` / `disconnected` / `rejected` / `stopped` |
| `log` | `true` | `console.log` connection problems (never `console.warn`, so no LogBox noise) |

Other exports: `stopKineReqLens()` (restores `fetch`, `XMLHttpRequest`, `WebSocket`), `openKineReqLens()` (same
as the dev menu item), `isKineReqLensRunning()`, `getKineReqLensStatus()`, `defaultHost()`, and the protocol
types/constants. `startKineReqLens` returns a handle (`url`, `session`, `status()`, `openUi()`, `stop()`) or
`null` when it did not start. Calling it again replaces the previous instance. No React component is needed.

Never captured: the connection to kineReqLens itself, Metro / Expo CLI internals (symbolication, logs, HMR,
inspector, bundles, …), React DevTools, and your `ignoreUrls`.

## Which host? Pairing a device

`defaultHost()` picks the developer machine from where Metro serves the bundle
(`NativeModules.SourceCode.scriptURL`):

| where the app runs | host used |
|---|---|
| iOS simulator | `localhost` |
| Android emulator | `10.0.2.2` (the emulator's alias for the host machine) |
| Physical device on the same Wi-Fi (Metro over LAN, Expo LAN URL) | the Metro host, e.g. `192.168.1.20` |
| Android device over USB with `adb reverse` (Metro at `localhost`) | `localhost` — also run `adb reverse tcp:8790 tcp:8790` |

For physical devices:

1. kineReqLens must accept LAN connections (Settings → React Native → **Accept physical devices on the local
   network**: it then listens on `0.0.0.0` and lists this machine's addresses) and the firewall must allow port 8790.
2. Pass the **pairing token** kineReqLens shows. A wrong token is rejected (status `rejected`); the app retries
   slowly, so fixing the token on the desktop side (or reloading the app with the right one) reconnects it.
3. If Metro runs through a tunnel (`expo start --tunnel`) the device cannot reach your machine directly: pass
   `host` explicitly (a LAN IP or your own tunnel to port 8790).

Without a running kineReqLens the app works normally: captures are buffered (up to `bufferSize`) and delivered
once it connects.

## Expo

- Works in **Expo Go** and development builds: it is plain JavaScript (no native module, no config plugin).
- Expo's dev server is Metro, so its internal endpoints are ignored like Metro's; Expo Router API routes
  (`/api/...` on the dev server) are app traffic and are captured.
- `expo/fetch` (the opt-in native streaming fetch) does not use `XMLHttpRequest`; calls through the global
  `fetch` are captured by the fetch wrapper, direct `import { fetch } from 'expo/fetch'` calls are not.

## Android cleartext traffic

The connection to kineReqLens is `ws://` (cleartext). Debug builds of React Native templates allow cleartext
to any host, but if your app sets `android:usesCleartextTraffic="false"` or ships a restrictive
`network_security_config`, allow the receiver's host in **debug only**
(`android/app/src/debug/res/xml/network_security_config.xml`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>   <!-- emulator -->
    <domain includeSubdomains="false">localhost</domain>  <!-- adb reverse -->
    <domain includeSubdomains="false">192.168.1.20</domain> <!-- your machine on the LAN -->
  </domain-config>
</network-security-config>
```

and reference it from `android/app/src/debug/AndroidManifest.xml`:

```xml
<application android:networkSecurityConfig="@xml/network_security_config" tools:replace="android:networkSecurityConfig" />
```

(Android matches `domain` entries by host name; for a changing LAN IP use `<base-config cleartextTrafficPermitted="true" />` in the debug config instead.) iOS allows local-network `ws://` in debug builds; on iOS 14+ the first
connection to a LAN address shows the Local Network permission prompt (needs `NSLocalNetworkUsageDescription`,
already present in React Native / Expo dev builds).

## How capture works (and what it does not change)

- `XMLHttpRequest.prototype.open / setRequestHeader / send` are wrapped; the original methods always run with
  the app's arguments and their exceptions propagate unchanged. Response bodies are read at `DONE`:
  `responseText`, `json`, `arraybuffer`, and `blob` (read with `FileReader`, like React Native itself does).
- React Native's `fetch` is whatwg-fetch over `XMLHttpRequest`. The `fetch` wrapper marks the XHR it opens, so
  each fetch is reported once, as `fetch`, with its init options. A `fetch` that does not use XHR (a native
  implementation) is captured by the wrapper itself from a `Response.clone()`.
- `WebSocket` is replaced by a subclass of the original: statics, `instanceof`, events and `send/close`
  behave the same; open / frames in both directions / error / close are reported.
- Replays requested by kineReqLens run with the `fetch` that existed before the patch and are not captured.

## Development

From `react-native/` (tools come from the repository root's `node_modules`; this package adds no
dependencies):

```sh
npm test             # vitest (also: npx vitest run --config react-native/vitest.config.ts from the root)
npm run typecheck
npm run build        # dist/index.cjs + .d.ts
npm run receiver -- --token my-token   # reference receiver on 0.0.0.0:8790, prints what the app sends
```
