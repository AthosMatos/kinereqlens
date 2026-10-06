// Small runtime helpers for the service worker: error classification, an abortable mutex, a gate that
// queues work until async startup state is loaded, and a keep-alive for long-running replays.

/** Best-effort human message for anything thrown or rejected. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** chrome.tabs.sendMessage rejected because no content script listens in the target tab/frame. */
export function isNoReceiverError(err: unknown): boolean {
  return /Receiving end does not exist|Could not establish connection|No frame with id|No document with id|frame was removed|message port closed/i.test(
    errorMessage(err),
  );
}

/** Promise that resolves after `ms` (used for short, bounded waits only). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The error a fetch / mutex wait rejects with when `signal` is aborted. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * FIFO mutex whose acquisition can be cancelled with an AbortSignal (a queued replay that the user
 * cancels or that times out leaves the queue without ever holding the lock).
 */
export class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  /** Resolves with a release function (idempotent). Rejects with the signal's reason when aborted while waiting. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.releaser());
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError'));
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** True while someone holds the lock. */
  get isLocked(): boolean {
    return this.locked;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

/**
 * Runs callbacks immediately once `ready` has settled; before that, queues them (bounded) and drains the
 * queue in order. Used so webRequest events that wake the service worker are not lost while tab state is
 * still being read from chrome.storage.session.
 */
export class ReadyGate {
  private queue: Array<() => void> | null = [];

  constructor(
    ready: Promise<unknown>,
    private readonly maxQueued = 10_000,
  ) {
    const drain = (): void => this.drain();
    ready.then(drain, drain);
  }

  get isOpen(): boolean {
    return this.queue === null;
  }

  run(fn: () => void): void {
    if (this.queue === null) {
      safeCall(fn);
      return;
    }
    if (this.queue.length < this.maxQueued) this.queue.push(fn);
  }

  private drain(): void {
    const queued = this.queue ?? [];
    this.queue = null;
    for (const fn of queued) safeCall(fn);
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[kineReqLens]', err);
  }
}

/**
 * Keeps the MV3 service worker alive while long operations (replays) are in flight: Chrome terminates
 * an idle worker after ~30 s even with a pending fetch, but every extension API call resets the idle
 * timer. Reference counted; the interval only runs while at least one holder exists.
 */
export class KeepAlive {
  private holders = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ping: () => void,
    private readonly intervalMs = 20_000,
  ) {}

  /** Returns an idempotent release function. */
  acquire(): () => void {
    this.holders++;
    if (this.timer === null) this.timer = setInterval(() => this.ping(), this.intervalMs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
      if (this.holders <= 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
        this.holders = 0;
      }
    };
  }
}

/** Resolve with `promise`, or reject with `new Error(message)` after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Narrow `unknown` to a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
