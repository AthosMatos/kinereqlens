// Where the bridge keeps its files: $REQLENS_HOME (default ~/.reqlens) holds the hub socket, the hub log and
// the native host launcher; each browser reads the native messaging manifest from its own user-level
// NativeMessagingHosts directory (macOS / Linux) or from the path in an HKCU registry key (Windows).
import os from 'node:os';
import path from 'node:path';
import { NATIVE_HOST_NAME } from '../../src/shared/claude-protocol';

/** Resolved $REQLENS_HOME: the `REQLENS_HOME` env var, else `~/.reqlens`. */
export function reqlensHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  const fromEnv = env.REQLENS_HOME?.trim();
  return path.resolve(fromEnv ? fromEnv : path.join(homedir, '.reqlens'));
}

/** Longest usable AF_UNIX path (sun_path minus the NUL): 104 bytes on macOS/BSD, 108 on Linux. */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' ? 107 : 103;
}

/** Hub socket: `$REQLENS_HOME/hub.sock`, or the per-user named pipe on Windows. */
export function hubSocketPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
  username: string = safeUsername(),
): string {
  if (platform === 'win32') return `\\\\.\\pipe\\reqlens-hub-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  return path.join(home, 'hub.sock');
}

/** Why the socket path cannot be used (too long for AF_UNIX), or null. */
export function socketPathProblem(socketPath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  const bytes = Buffer.byteLength(socketPath);
  const max = maxSocketPathBytes(platform);
  if (bytes <= max) return null;
  return `The hub socket path is ${bytes} bytes, longer than the ${max} bytes a Unix socket allows: ${socketPath}. Use a shorter REQLENS_HOME.`;
}

/** The native host launcher the manifest points at. */
export function launcherPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(home, platform === 'win32' ? 'native-host.cmd' : 'native-host');
}

export function hubLogPath(home: string): string {
  return path.join(home, 'hub.log');
}

/** Windows keeps the manifest in $REQLENS_HOME (the registry key points at it). */
export function homeManifestPath(home: string): string {
  return path.join(home, `${NATIVE_HOST_NAME}.json`);
}

export function manifestFileName(): string {
  return `${NATIVE_HOST_NAME}.json`;
}

export type BrowserFamily = 'edge' | 'chrome' | 'chromium' | 'brave';
export const BROWSER_FAMILIES: ReadonlyArray<BrowserFamily> = ['edge', 'chrome', 'chromium', 'brave'];

/** One installable browser channel (Edge Beta, Chrome, ...). */
export interface BrowserChannel {
  family: BrowserFamily;
  name: string;
  /** The family's main channel: written even when its profile dir does not exist yet (explicit --browser). */
  stable: boolean;
  /** Present when the browser channel is installed (and was started once). */
  userDataDir: string;
  /** macOS / Linux: the user-level NativeMessagingHosts directory. */
  manifestDir?: string;
  /** Windows: HKCU key whose default value is the manifest path. */
  registryKey?: string;
}

interface ChannelDef {
  family: BrowserFamily;
  name: string;
  stable?: boolean;
  mac: string;
  linux?: string;
}

const CHANNELS: ReadonlyArray<ChannelDef> = [
  { family: 'edge', name: 'Microsoft Edge', stable: true, mac: 'Microsoft Edge', linux: 'microsoft-edge' },
  { family: 'edge', name: 'Microsoft Edge Beta', mac: 'Microsoft Edge Beta', linux: 'microsoft-edge-beta' },
  { family: 'edge', name: 'Microsoft Edge Dev', mac: 'Microsoft Edge Dev', linux: 'microsoft-edge-dev' },
  { family: 'edge', name: 'Microsoft Edge Canary', mac: 'Microsoft Edge Canary' },
  { family: 'chrome', name: 'Google Chrome', stable: true, mac: 'Google/Chrome', linux: 'google-chrome' },
  { family: 'chrome', name: 'Google Chrome Beta', mac: 'Google/Chrome Beta', linux: 'google-chrome-beta' },
  { family: 'chrome', name: 'Google Chrome Canary', mac: 'Google/Chrome Canary' },
  { family: 'chromium', name: 'Chromium', stable: true, mac: 'Chromium', linux: 'chromium' },
  { family: 'brave', name: 'Brave', stable: true, mac: 'BraveSoftware/Brave-Browser', linux: 'BraveSoftware/Brave-Browser' },
];

const WINDOWS: Record<BrowserFamily, { name: string; key: string; data: string }> = {
  edge: { name: 'Microsoft Edge', key: 'Microsoft\\Edge', data: 'Microsoft\\Edge\\User Data' },
  chrome: { name: 'Google Chrome', key: 'Google\\Chrome', data: 'Google\\Chrome\\User Data' },
  chromium: { name: 'Chromium', key: 'Chromium', data: 'Chromium\\User Data' },
  brave: { name: 'Brave', key: 'BraveSoftware\\Brave-Browser', data: 'BraveSoftware\\Brave-Browser\\User Data' },
};

/** Every browser channel the installer knows for `platform` (user-level locations under `homedir`). */
export function browserChannels(
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): BrowserChannel[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return BROWSER_FAMILIES.map((family) => ({
      family,
      name: WINDOWS[family].name,
      stable: true,
      userDataDir: path.win32.join(localAppData, WINDOWS[family].data),
      registryKey: `HKCU\\Software\\${WINDOWS[family].key}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    }));
  }
  const mac = platform === 'darwin';
  const base = mac
    ? path.join(homedir, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME?.trim() || path.join(homedir, '.config');
  const out: BrowserChannel[] = [];
  for (const def of CHANNELS) {
    const dir = mac ? def.mac : def.linux;
    if (!dir) continue;
    const userDataDir = path.join(base, ...dir.split('/'));
    out.push({
      family: def.family,
      name: def.name,
      stable: def.stable === true,
      userDataDir,
      manifestDir: path.join(userDataDir, 'NativeMessagingHosts'),
    });
  }
  return out;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || 'user';
  } catch {
    return process.env.USERNAME || process.env.USER || 'user';
  }
}
