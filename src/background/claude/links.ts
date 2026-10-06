// Service-worker end of the panel links (src/shared/claude-link.ts): one chrome.runtime Port per overlay
// panel. Only this extension's panel.html may connect, and its hello must name the tab it really lives in.
// The worker pushes BridgeStatus, asks the panel about selection / drafts / runs, has it run Claude's
// requests, and relays the panel's "Send to Claude Code" items to the hub.
import { CLAUDE_LINK_PORT_NAME, CLAUDE_LINK_VERSION } from '../../shared/claude-link';
import type { LinkInboxDraft, LinkQuery, LinkQueryResults, PanelToWorker, WorkerToPanel } from '../../shared/claude-link';
import type { BridgeStatus } from '../../shared/claude-protocol';
import { RN_STANDALONE_PAGE } from '../../shared/rn-protocol';
import { isPanelPage } from '../router';
import { isRecord } from '../util';
import type { Timers } from './native';
import type { PushResult } from './native';
import { validateInboxDraft } from './validate';

/** A panel must say hello this soon after connecting. */
export const LINK_HELLO_TIMEOUT_MS = 5000;
const MAX_PENDING_PER_LINK = 64;

/** Port-like surface (chrome.runtime.Port in production). */
export interface LinkPort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

/** One connected panel, as seen by the terminal relay (./pty.ts). */
export interface LinkHandle {
  readonly tabId: number;
  /** Post to this panel; false when it is gone. */
  post(message: WorkerToPanel): boolean;
}

export interface LinkDeps {
  extensionId: string;
  /** Current status, sent to a panel right after its hello. */
  status(): BridgeStatus;
  /** A panel of `tabId` connected (or reconnected). */
  onHello(tabId: number): void;
  /** Deliver an inbox item the panel of `tabId` sent. */
  onPush(tabId: number, item: LinkInboxDraft): PushResult | Promise<PushResult>;
  /** A panel said hello (after onHello). */
  onLinkOpen?(link: LinkHandle): void;
  /** A panel that said hello disconnected. */
  onLinkClose?(link: LinkHandle): void;
  /** A `pty-*` message of a panel (unvalidated). */
  onPty?(link: LinkHandle, message: Record<string, unknown>): void;
  /** An `fs-*` (folder browser) message of a panel (unvalidated). */
  onFs?(link: LinkHandle, message: Record<string, unknown>): void;
  /** A `run-*` / `op-*` (Errors view) message of a panel (unvalidated). */
  onRun?(link: LinkHandle, message: Record<string, unknown>): void;
  /** A `shot-*` ("Send to Claude" screenshot) message of a panel (unvalidated). */
  onShot?(link: LinkHandle, message: Record<string, unknown>): void;
  timers?: Timers;
}

/** The query could not be answered (no panel, panel gone, timeout, panel error). */
export class LinkError extends Error {}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: unknown;
}

interface Link extends LinkHandle {
  port: LinkPort;
  tabId: number;
  pending: Map<number, Pending>;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The standalone (React Native) page, which hosts the same UI as the overlay panel. */
function isStandalonePage(url: string | undefined, extensionId: string): boolean {
  return typeof url === 'string' && url.split('#')[0]!.split('?')[0] === `chrome-extension://${extensionId}/${RN_STANDALONE_PAGE}`;
}

/** Validated sender tab of a panel port, or null when the sender is not this extension's panel (or standalone) page. */
export function panelSenderTab(sender: chrome.runtime.MessageSender | undefined, extensionId: string): number | null {
  if (!sender || sender.id !== extensionId || !(isPanelPage(sender.url, extensionId) || isStandalonePage(sender.url, extensionId))) return null;
  const tabId = sender.tab?.id;
  return typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null;
}

export class PanelLinks {
  /** Links per tab, oldest first (the newest one answers queries). */
  private readonly byTab = new Map<number, Link[]>();
  /** Callers of waitFor() per tab. */
  private readonly waiting = new Map<number, Set<() => void>>();
  private nextId = 1;
  private readonly timers: Timers;

  constructor(private readonly deps: LinkDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** chrome.runtime.onConnect. Returns false for ports that are not panel links (left alone). */
  accept(port: LinkPort): boolean {
    if (port.name !== CLAUDE_LINK_PORT_NAME) return false;
    const tabId = panelSenderTab(port.sender, this.deps.extensionId);
    if (tabId === null) {
      safeDisconnect(port);
      return true;
    }
    let link: Link | null = null;
    const helloTimer = this.timers.setTimeout(() => {
      if (!link) safeDisconnect(port);
    }, LINK_HELLO_TIMEOUT_MS);
    port.onMessage.addListener((message) => {
      if (link) {
        this.onMessage(link, message);
        return;
      }
      if (!isHello(message, tabId)) {
        this.timers.clearTimeout(helloTimer);
        safeDisconnect(port);
        return;
      }
      this.timers.clearTimeout(helloTimer);
      const created: Link = { port, tabId, pending: new Map(), post: (m) => post(port, m) };
      link = created;
      this.add(created);
      post(port, { t: 'status', status: this.deps.status() });
      this.deps.onHello(tabId);
      this.deps.onLinkOpen?.(created);
    });
    port.onDisconnect.addListener(() => {
      this.timers.clearTimeout(helloTimer);
      if (link) {
        this.remove(link, 'The kineReqLens overlay was closed or reloaded');
        this.deps.onLinkClose?.(link);
      }
    });
    return true;
  }

  /** A panel of this tab is connected. */
  has(tabId: number): boolean {
    return (this.byTab.get(tabId)?.length ?? 0) > 0;
  }

  /** Tabs with a connected panel. */
  tabIds(): number[] {
    return [...this.byTab.keys()];
  }

  /**
   * Resolves true once a panel of `tabId` is connected (at once when one is), false after `timeoutMs`. After a
   * worker restart the panels reconnect within about a second, while the hub may already be calling.
   */
  waitFor(tabId: number, timeoutMs: number): Promise<boolean> {
    if (this.has(tabId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const set = this.waiting.get(tabId) ?? new Set<() => void>();
      this.waiting.set(tabId, set);
      const done = (connected: boolean): void => {
        this.timers.clearTimeout(timer);
        set.delete(onLink);
        if (set.size === 0 && this.waiting.get(tabId) === set) this.waiting.delete(tabId);
        resolve(connected);
      };
      const onLink = (): void => done(true);
      const timer = this.timers.setTimeout(() => done(false), timeoutMs);
      set.add(onLink);
    });
  }

  /** Ask the newest panel of `tabId`. Rejects with LinkError (no panel, disconnected, timeout, panel error). */
  query<K extends LinkQuery['kind']>(tabId: number, query: Extract<LinkQuery, { kind: K }>, timeoutMs: number): Promise<LinkQueryResults[K]> {
    const links = this.byTab.get(tabId);
    const link = links?.[links.length - 1];
    if (!link) return Promise.reject(new LinkError(`The kineReqLens overlay is not open in tab ${tabId}`));
    if (link.pending.size >= MAX_PENDING_PER_LINK) return Promise.reject(new LinkError('The kineReqLens overlay is busy — try again'));
    const id = this.nextId++;
    return new Promise<LinkQueryResults[K]>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        link.pending.delete(id);
        reject(new LinkError('The kineReqLens overlay did not answer in time'));
      }, timeoutMs);
      link.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (!post(link.port, { t: 'query', id, query })) {
        this.timers.clearTimeout(timer);
        link.pending.delete(id);
        reject(new LinkError('The kineReqLens overlay disconnected'));
      }
    });
  }

  /** Send the status to every connected panel. */
  broadcast(status: BridgeStatus): void {
    for (const links of this.byTab.values()) for (const link of links) post(link.port, { t: 'status', status });
  }

  private add(link: Link): void {
    const list = this.byTab.get(link.tabId) ?? [];
    list.push(link);
    this.byTab.set(link.tabId, list);
    for (const wake of [...(this.waiting.get(link.tabId) ?? [])]) wake();
  }

  private remove(link: Link, reason: string): void {
    const list = this.byTab.get(link.tabId);
    if (list) {
      const rest = list.filter((l) => l !== link);
      if (rest.length) this.byTab.set(link.tabId, rest);
      else this.byTab.delete(link.tabId);
    }
    for (const pending of link.pending.values()) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(new LinkError(reason));
    }
    link.pending.clear();
  }

  private onMessage(link: Link, raw: unknown): void {
    if (!isRecord(raw)) return;
    const message = raw as Partial<PanelToWorker> & Record<string, unknown>;
    if (message.t === 'res' && typeof message.id === 'number') {
      const pending = link.pending.get(message.id);
      if (!pending) return;
      link.pending.delete(message.id);
      this.timers.clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new LinkError(typeof message.error === 'string' ? message.error.slice(0, 2000) : 'The kineReqLens overlay could not answer'));
      return;
    }
    if (message.t === 'push' && typeof message.id === 'number') {
      void this.onPush(link, message.id, message.item);
      return;
    }
    if (typeof message.t === 'string' && message.t.startsWith('pty-')) this.deps.onPty?.(link, raw);
    else if (typeof message.t === 'string' && message.t.startsWith('fs-')) this.deps.onFs?.(link, raw);
    else if (typeof message.t === 'string' && (message.t.startsWith('run-') || message.t.startsWith('op-'))) this.deps.onRun?.(link, raw);
    else if (typeof message.t === 'string' && message.t.startsWith('shot-')) this.deps.onShot?.(link, raw);
  }

  private async onPush(link: Link, id: number, rawItem: unknown): Promise<void> {
    const item = validateInboxDraft(rawItem);
    let result: PushResult;
    if (!item.ok) result = { ok: false, delivered: 0, error: item.error };
    else {
      try {
        result = await this.deps.onPush(link.tabId, item.value);
      } catch (err) {
        result = { ok: false, delivered: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const reply: WorkerToPanel = { t: 'push-result', id, ok: result.ok, delivered: result.delivered };
    if (result.error !== undefined) reply.error = result.error;
    post(link.port, reply);
  }
}

function isHello(message: unknown, tabId: number): boolean {
  return isRecord(message) && message.t === 'hello' && message.v === CLAUDE_LINK_VERSION && message.tabId === tabId;
}

function post(port: LinkPort, message: WorkerToPanel): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function safeDisconnect(port: LinkPort): void {
  try {
    port.disconnect();
  } catch {
    /* already gone */
  }
}
