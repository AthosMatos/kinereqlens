// Observes this extension's own replay requests through chrome.webRequest (tabId -1, initiator
// chrome-extension://<id>). A service-worker fetch never exposes Set-Cookie and gives no status/headers
// for `redirect: 'manual'` (opaqueredirect), but webRequest sees the real response headers of every hop.
// Strictly best effort: results are merged when they arrived in time, nothing ever waits long for them.
import { webRequestHeadersToPairs } from '../lib/capture';
import type { HeaderPair } from '../shared/types';
import { parseStatusText } from './wr-entry';
import type { WrHeader } from './wr-entry';

/** Response headers of one hop as seen by webRequest. */
export interface ObservedHop {
  url: string;
  statusCode: number;
  statusText: string;
  headers: HeaderPair[];
}

export interface ReplayWatch {
  readonly method: string;
  readonly url: string;
  requestId: string | null;
  hops: ObservedHop[];
  notify: Set<() => void>;
}

export interface OwnHeadersDetails {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  initiator?: string;
  statusCode: number;
  statusLine: string;
  responseHeaders?: WrHeader[];
}

export class ReplayObserver {
  private readonly watches: ReplayWatch[] = [];

  /** @param initiator `chrome-extension://<id>` — only requests initiated by this extension are considered. */
  constructor(private readonly initiator: string) {}

  /** Start watching a replay about to be sent (call before fetch). */
  watch(method: string, url: string): ReplayWatch {
    const watch: ReplayWatch = { method: method.toUpperCase(), url, requestId: null, hops: [], notify: new Set() };
    this.watches.push(watch);
    return watch;
  }

  unwatch(watch: ReplayWatch): void {
    const index = this.watches.indexOf(watch);
    if (index >= 0) this.watches.splice(index, 1);
    watch.notify.clear();
  }

  get size(): number {
    return this.watches.length;
  }

  /** webRequest.onHeadersReceived for tabId -1. */
  onHeadersReceived(details: OwnHeadersDetails): void {
    if (this.watches.length === 0 || details.tabId !== -1 || details.initiator !== this.initiator) return;
    const watch = this.match(details);
    if (!watch) return;
    watch.requestId = details.requestId;
    watch.hops.push({
      url: details.url,
      statusCode: details.statusCode,
      statusText: parseStatusText(details.statusLine),
      headers: webRequestHeadersToPairs(details.responseHeaders),
    });
    for (const fn of [...watch.notify]) fn();
  }

  /** The latest hop observed for `url`, waiting at most `waitMs` for it to arrive. */
  async hopFor(watch: ReplayWatch, url: string, waitMs: number): Promise<ObservedHop | undefined> {
    const find = (): ObservedHop | undefined => {
      for (let i = watch.hops.length - 1; i >= 0; i--) if (watch.hops[i].url === url) return watch.hops[i];
      return undefined;
    };
    const found = find();
    if (found || waitMs <= 0) return found;
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        watch.notify.delete(check);
        resolve(find());
      };
      const check = (): void => {
        if (find()) done();
      };
      const timer = setTimeout(done, waitMs);
      watch.notify.add(check);
    });
  }

  private match(details: OwnHeadersDetails): ReplayWatch | undefined {
    // Later hops of an already-bound request (redirects keep the request id).
    const bound = this.watches.find((w) => w.requestId === details.requestId);
    if (bound) return bound;
    // First hop: the oldest unbound watch for this method + URL (FIFO for identical concurrent replays).
    const method = details.method.toUpperCase();
    return this.watches.find((w) => w.requestId === null && w.method === method && w.url === details.url);
  }
}

/** Add Set-Cookie lines seen by webRequest when the fetch response (which hides them) has none. */
export function mergeSetCookies(headers: HeaderPair[], hop: ObservedHop | undefined): HeaderPair[] {
  if (!hop) return headers;
  const isSetCookie = (h: HeaderPair): boolean => /^set-cookie2?$/i.test(h.name);
  if (headers.some(isSetCookie)) return headers;
  const cookies = hop.headers.filter(isSetCookie).map((h) => ({ name: h.name.toLowerCase(), value: h.value }));
  return cookies.length > 0 ? [...headers, ...cookies] : headers;
}
