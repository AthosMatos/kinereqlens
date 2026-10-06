/** Which URLs are never captured: the receiver itself, Metro / dev tooling, and the app's ignoreUrls. */
import { effectivePort, isLoopback, parseUrl } from './env';

export type UrlPattern = string | RegExp;

export interface FilterConfig {
  ignoreUrls: UrlPattern[];
  receiver: { host: string; port: string; path: string };
  /** Metro dev server (from the bundle URL), null when unknown. */
  metro: { host: string; port: string } | null;
}

/** Metro / Expo CLI dev endpoints (symbolication, logs, HMR, inspector, bundles, ...). */
const METRO_PATHS: RegExp[] = [
  /^\/symbolicate\b/,
  /^\/logs\b/,
  /^\/hot\b/,
  /^\/message\b/,
  /^\/events\b/,
  /^\/inspector\b/,
  /^\/json\b/,
  /^\/debugger-proxy\b/,
  /^\/debugger-ui\b/,
  /^\/debugger-frontend\b/,
  /^\/status\b/,
  /^\/open-stack-frame\b/,
  /^\/open-url\b/,
  /^\/open-debugger\b/,
  /^\/reload\b/,
  /^\/launch-js-devtools\b/,
  /^\/onchange\b/,
  /\.bundle$/,
  /\.map$/,
  /^\/assets\//,
  /^\/_expo\//,
  /^\/expo-dev-plugins\b/,
];

const METRO_DEFAULT_PORT = '8081';
/** React DevTools standalone / Flipper-era ports. */
const DEVTOOLS_PORTS = new Set(['8097']);

function sameHost(a: string, b: string): boolean {
  return a === b || (isLoopback(a) && isLoopback(b));
}

export function matchesPattern(url: string, pattern: UrlPattern): boolean {
  if (typeof pattern === 'string') return pattern !== '' && url.includes(pattern);
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(url);
  }
  return false;
}

/** True when the request/socket to `url` must not be captured. Never throws. */
export function isIgnoredUrl(url: string, config: FilterConfig): boolean {
  try {
    const parsed = parseUrl(url);
    if (parsed) {
      const port = effectivePort(parsed);
      const { receiver, metro } = config;
      if (sameHost(parsed.host, receiver.host) && port === receiver.port && parsed.path.startsWith(receiver.path)) return true;
      if (DEVTOOLS_PORTS.has(port)) return true;
      const isMetro = (metro !== null && sameHost(parsed.host, metro.host) && port === metro.port) || port === METRO_DEFAULT_PORT;
      if (isMetro && METRO_PATHS.some((re) => re.test(parsed.path))) return true;
    }
    for (const pattern of config.ignoreUrls) if (matchesPattern(url, pattern)) return true;
    return false;
  } catch {
    return false;
  }
}
