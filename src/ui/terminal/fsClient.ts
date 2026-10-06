// Panel side of the terminal's folder browser (docs/CLAUDE_INTEGRATION.md "Working directory"): requests
// `fs-list` / `fs-pick` / `fs-projects` over the panel link (src/ui/panel/claudeLink.ts) and resolves them with
// the hub's answer, an `fs-error`, a timeout or the link going away. DOM-free; the projects scan is cached
// for the panel's lifetime (Refresh rescans).
import { FS_LIST_TIMEOUT_MS, FS_PICK_TIMEOUT_MS, FS_PROJECTS_TIMEOUT_MS } from '../../shared/claude-protocol';
import type { FsFromHost, FsProject, FsToHost } from '../../shared/claude-protocol';
import { FS_UNSUPPORTED_ERROR, parseFsFromHost } from '../../shared/fs';
import type { FsLinkEvent } from '../panel/claudeLink';
import { postFs, subscribeFs } from '../panel/claudeLink';

export type FsListing = Omit<Extract<FsFromHost, { t: 'fs-listed' }>, 't' | 'id'>;
export interface FsProjects {
  projects: FsProject[];
  home: string;
  truncated: boolean;
}

/** A failed folder request. `unavailable`: the bridge cannot browse at all (old hub, not connected). */
export class FsRequestError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
  }
}

export const FS_LINK_DOWN_ERROR = 'The Claude Code bridge is not connected — check Settings → Claude Code';
export const FS_CLIENT_TIMEOUT_ERROR = 'The kineReqLens bridge did not answer in time';
/** The worker times out first; the panel only gives up a little later. */
const MARGIN_MS = 5000;

export interface FsClientDeps {
  post(message: FsToHost): boolean;
  subscribe(fn: (event: FsLinkEvent) => void): () => void;
  newId?(): string;
  /** The native chooser may only be opened from a click (default: navigator.userActivation). */
  hasUserActivation?(): boolean;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

interface Waiter {
  expect: FsFromHost['t'];
  resolve(message: FsFromHost): void;
  reject(error: Error): void;
  timer: unknown;
}

function defaultUserActivation(): boolean {
  try {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
  } catch {
    return true;
  }
}

let seq = 0;
function defaultId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `fsq-${++seq}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class FsClient {
  private readonly waiting = new Map<string, Waiter>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private projectsCache: FsProjects | null = null;
  private unsubscribe: (() => void) | null;

  constructor(private readonly deps: FsClientDeps) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.unsubscribe = deps.subscribe((event) => this.onEvent(event));
  }

  /** Last projects scan of this panel (null before the first). */
  get cachedProjects(): FsProjects | null {
    return this.projectsCache;
  }

  /** Sub-directories of `path` (absolute or `~/…`). */
  async list(path: string): Promise<FsListing> {
    const answer = await this.request({ t: 'fs-list', id: '', path }, 'fs-listed', FS_LIST_TIMEOUT_MS);
    if (answer.t !== 'fs-listed') throw new FsRequestError('Unexpected answer');
    const { t: _t, id: _id, ...listing } = answer;
    return listing;
  }

  /** Open the OS-native folder chooser (from a click). Resolves the chosen folder, or null when cancelled. */
  async pick(startPath?: string): Promise<string | null> {
    if (!(this.deps.hasUserActivation ?? defaultUserActivation)()) throw new FsRequestError('Click “Choose folder…” to open the folder chooser');
    const message: FsToHost = startPath ? { t: 'fs-pick', id: '', startPath } : { t: 'fs-pick', id: '' };
    const answer = await this.request(message, 'fs-picked', FS_PICK_TIMEOUT_MS);
    return answer.t === 'fs-picked' ? answer.path : null;
  }

  /** Git projects under the usual folders (cached unless `refresh`). */
  async projects(refresh = false): Promise<FsProjects> {
    if (!refresh && this.projectsCache) return this.projectsCache;
    const message: FsToHost = refresh ? { t: 'fs-projects', id: '', refresh: true } : { t: 'fs-projects', id: '' };
    const answer = await this.request(message, 'fs-projects-listed', FS_PROJECTS_TIMEOUT_MS);
    if (answer.t !== 'fs-projects-listed') throw new FsRequestError('Unexpected answer');
    this.projectsCache = { projects: answer.projects, home: answer.home, truncated: answer.truncated === true };
    return this.projectsCache;
  }

  /** Stop following the link (tests). */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.failAll(new FsRequestError(FS_LINK_DOWN_ERROR, true));
  }

  private request(message: FsToHost, expect: FsFromHost['t'], workerTimeoutMs: number): Promise<FsFromHost> {
    const id = (this.deps.newId ?? defaultId)();
    return new Promise<FsFromHost>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.waiting.get(id) !== waiter) return;
        this.waiting.delete(id);
        reject(new FsRequestError(FS_CLIENT_TIMEOUT_ERROR));
      }, workerTimeoutMs + MARGIN_MS);
      const waiter: Waiter = { expect, resolve, reject, timer };
      this.waiting.set(id, waiter);
      if (!this.deps.post({ ...message, id } as FsToHost)) {
        this.waiting.delete(id);
        this.clearTimer(timer);
        reject(new FsRequestError(FS_LINK_DOWN_ERROR, true));
      }
    });
  }

  private onEvent(event: FsLinkEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.t === 'link-lost') {
      this.failAll(new FsRequestError(FS_LINK_DOWN_ERROR, true));
      return;
    }
    const message = parseFsFromHost(event);
    if (!message) return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    this.clearTimer(waiter.timer);
    if (message.t === 'fs-error') waiter.reject(new FsRequestError(message.error, message.error === FS_UNSUPPORTED_ERROR));
    else if (message.t !== waiter.expect) waiter.reject(new FsRequestError('Unexpected answer from the kineReqLens bridge'));
    else waiter.resolve(message);
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiting.values()) {
      this.clearTimer(waiter.timer);
      waiter.reject(error);
    }
    this.waiting.clear();
  }
}

let client: FsClient | null = null;

/** The panel's folder browser client. */
export function folderClient(): FsClient {
  client ??= new FsClient({ post: postFs, subscribe: subscribeFs });
  return client;
}
