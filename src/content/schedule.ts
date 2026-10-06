/** Timing helpers for the content script: coalesced notifications and debounced actions. */

/** Timer functions (injectable so pure modules stay testable). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Window timers, bound so they can be called detached. */
export function windowTimers(win: Window): Timers {
  return {
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id as number),
  };
}

/** Upper bound between a change and its notification when animation frames are throttled (hidden tab). */
const FRAME_FALLBACK_MS = 50;

/**
 * Store scheduler: runs `flush` on the next animation frame, or after 50 ms when frames do not come
 * (background tabs), whichever is first — at most one notification per frame.
 */
export function frameScheduler(win: Window): (flush: () => void) => void {
  return (flush) => {
    let done = false;
    let frame = 0;
    const run = (): void => {
      if (done) return;
      done = true;
      if (frame) win.cancelAnimationFrame(frame);
      win.clearTimeout(timer);
      flush();
    };
    const timer = win.setTimeout(run, FRAME_FALLBACK_MS);
    try {
      frame = win.requestAnimationFrame(run);
    } catch {
      /* no rendering (e.g. prerender): the timeout covers it */
    }
  };
}

/** Runs `action` once, `delayMs` after the last `schedule()` call (trailing debounce). */
export class Debouncer {
  private timer: unknown = null;

  constructor(
    private readonly timers: Timers,
    private readonly delayMs: number,
    private readonly action: () => void,
  ) {}

  get pending(): boolean {
    return this.timer !== null;
  }

  schedule(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.action();
    }, this.delayMs);
  }

  /** Run a pending action now. */
  flush(): void {
    if (this.timer === null) return;
    this.cancel();
    this.action();
  }

  cancel(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Promise that resolves after `ms` using the given timers. */
export function delay(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}
