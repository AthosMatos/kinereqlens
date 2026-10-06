/**
 * React Native environment access: the optional `react-native` peer, the Metro bundle URL, default receiver
 * host, app/device info. Every read is defensive; nothing here may throw.
 */
import type { RnAppInfo } from './protocol';

// Metro (CommonJS) provides `require`; under ESM hosts the call below throws and is caught.
declare const require: (id: string) => unknown;

/** The subset of the `react-native` module this package reads. */
export interface ReactNativeLike {
  Platform?: {
    OS?: string;
    Version?: string | number;
    isPad?: boolean;
    constants?: Record<string, unknown>;
  };
  NativeModules?: Record<string, unknown>;
  TurboModuleRegistry?: { get?: (name: string) => unknown };
  DevSettings?: { addMenuItem?: (title: string, handler: () => void) => void };
  AppRegistry?: { getAppKeys?: () => string[] };
}

let override: ReactNativeLike | null | undefined;
let cached: ReactNativeLike | null | undefined;

/** Test hook: use this object as the `react-native` module (null = not available, undefined = real one). */
export function _setReactNativeModule(module: ReactNativeLike | null | undefined): void {
  override = module;
  cached = undefined;
}

export function getReactNative(): ReactNativeLike | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  cached = null;
  try {
    // A literal require so Metro resolves the (optional peer) dependency statically.
    cached = require('react-native') as ReactNativeLike;
  } catch {
    cached = null;
  }
  return cached;
}

// ---------------------------------------------------------------------------------------------
// URL parsing (React Native's URL polyfill throws on .hostname/.port in many versions)
// ---------------------------------------------------------------------------------------------

export interface ParsedUrl {
  scheme: string;
  host: string;
  /** '' when absent. */
  port: string;
  path: string;
  query: string;
}

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?([^?#]*)(\?[^#]*)?/i;

export function parseUrl(url: string): ParsedUrl | null {
  const match = URL_RE.exec(url);
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    host: match[2].toLowerCase(),
    port: match[3] ?? '',
    path: match[4] || '/',
    query: match[5] ?? '',
  };
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443', exp: '80', exps: '443' };

/** Port with the scheme default filled in. */
export function effectivePort(parsed: ParsedUrl): string {
  return parsed.port || DEFAULT_PORTS[parsed.scheme] || '';
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare) || bare === '0.0.0.0';
}

// ---------------------------------------------------------------------------------------------
// Metro bundle URL / host
// ---------------------------------------------------------------------------------------------

/** NativeModules.SourceCode.scriptURL (old + new architecture), null when unknown. */
export function scriptUrl(rn: ReactNativeLike | null = getReactNative()): string | null {
  try {
    const sourceCode = rn?.NativeModules?.SourceCode as { scriptURL?: unknown; getConstants?: () => { scriptURL?: unknown } } | undefined;
    let url: unknown = sourceCode?.scriptURL;
    if (!url && typeof sourceCode?.getConstants === 'function') url = sourceCode.getConstants().scriptURL;
    if (!url && typeof rn?.TurboModuleRegistry?.get === 'function') {
      const turbo = rn.TurboModuleRegistry.get('SourceCode') as { getConstants?: () => { scriptURL?: unknown } } | null;
      url = turbo?.getConstants?.().scriptURL;
    }
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  }
}

/** Metro origin parts from a bundle URL (http/https/exp only; file:// = embedded release bundle -> null). */
export function metroServer(url: string | null): { host: string; port: string } | null {
  if (!url) return null;
  const parsed = parseUrl(url);
  if (!parsed || !['http', 'https', 'exp', 'exps'].includes(parsed.scheme) || !parsed.host) return null;
  return { host: parsed.host, port: parsed.scheme.startsWith('exp') ? parsed.port || '8081' : effectivePort(parsed) };
}

function constants(rn: ReactNativeLike | null): Record<string, unknown> {
  try {
    const value = rn?.Platform?.constants;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Heuristic from Android Platform.constants (Fingerprint / Model / Brand / Hardware). */
export function isAndroidEmulator(c: Record<string, unknown>): boolean {
  const fingerprint = str(c.Fingerprint).toLowerCase();
  const model = str(c.Model).toLowerCase();
  const brand = str(c.Brand).toLowerCase();
  const hardware = str(c.Hardware).toLowerCase();
  return (
    fingerprint.startsWith('generic') ||
    fingerprint.includes('emulator') ||
    fingerprint.includes('sdk_gphone') ||
    fingerprint.includes('/sdk_') ||
    model.includes('emulator') ||
    model.includes('android sdk built for') ||
    model.startsWith('sdk_gphone') ||
    brand === 'generic' ||
    hardware === 'goldfish' ||
    hardware === 'ranchu'
  );
}

export interface HostInputs {
  platform: string;
  scriptURL: string | null;
  /** Android emulator (ignored on iOS). */
  emulator: boolean;
}

/**
 * Receiver host for a device:
 *  1. Metro serves the bundle from a non-loopback host (physical device on the LAN, Android emulator via
 *     10.0.2.2, Expo LAN URLs): the developer machine is that host.
 *  2. Android with a loopback / unknown bundle host: emulator -> 10.0.2.2 (the host machine); physical
 *     device -> localhost (works with `adb reverse tcp:8790 tcp:8790`).
 *  3. Otherwise (iOS simulator shares the Mac's network): localhost.
 */
export function resolveDefaultHost(inputs: HostInputs): string {
  const metro = metroServer(inputs.scriptURL);
  if (metro && !isLoopback(metro.host)) return metro.host;
  if (inputs.platform === 'android') return inputs.emulator ? '10.0.2.2' : 'localhost';
  return 'localhost';
}

/** Default receiver host for the running app (see resolveDefaultHost). */
export function defaultHost(): string {
  try {
    const rn = getReactNative();
    const platform = str(rn?.Platform?.OS);
    return resolveDefaultHost({ platform, scriptURL: scriptUrl(rn), emulator: platform === 'android' && isAndroidEmulator(constants(rn)) });
  } catch {
    return 'localhost';
  }
}

/** `app=` query parameter React Native adds to dev bundle URLs (the bundle identifier / package name). */
export function bundleIdFromScriptUrl(url: string | null): string {
  if (!url) return '';
  const match = /[?&]app=([^&#]*)/.exec(url);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function rnVersion(c: Record<string, unknown>): string {
  const v = c.reactNativeVersion as { major?: unknown; minor?: unknown; patch?: unknown; prerelease?: unknown } | undefined;
  if (!v || typeof v !== 'object') return '';
  const base = `${String(v.major ?? 0)}.${String(v.minor ?? 0)}.${String(v.patch ?? 0)}`;
  return v.prerelease !== undefined && v.prerelease !== null ? `${base}-${String(v.prerelease)}` : base;
}

export interface AppInfoOverrides {
  appName?: string;
  bundleId?: string;
  deviceName?: string;
}

export function appInfo(overrides: AppInfoOverrides = {}): RnAppInfo {
  const rn = getReactNative();
  const c = constants(rn);
  const os = str(rn?.Platform?.OS);
  const platform = (os === 'ios' ? 'ios' : 'android') as RnAppInfo['platform'];
  const url = scriptUrl(rn);
  let name = '';
  try {
    name = rn?.AppRegistry?.getAppKeys?.()[0] ?? '';
  } catch {
    name = '';
  }
  const osVersion = os === 'ios' ? str(c.osVersion) : String(rn?.Platform?.Version ?? c.Release ?? '');
  const emulator = os === 'android' ? isAndroidEmulator(c) : undefined;
  let deviceName: string;
  if (os === 'android') {
    const maker = str(c.Manufacturer) || str(c.Brand);
    deviceName = [maker, str(c.Model)].filter(Boolean).join(' ') || 'Android device';
  } else {
    deviceName = `${rn?.Platform?.isPad ? 'iPad' : 'iPhone'}${osVersion ? ` (iOS ${osVersion})` : ''}`;
  }
  const info: RnAppInfo = {
    name: overrides.appName ?? (name || 'React Native app'),
    bundleId: overrides.bundleId ?? bundleIdFromScriptUrl(url),
    platform,
    rnVersion: rnVersion(c),
    hermes: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object' && (globalThis as { HermesInternal?: unknown }).HermesInternal !== null,
    deviceName: overrides.deviceName ?? deviceName,
  };
  if (osVersion) info.osVersion = osVersion;
  if (emulator !== undefined) info.emulator = emulator;
  return info;
}
