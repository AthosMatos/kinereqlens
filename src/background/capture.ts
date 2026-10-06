// Visible-tab captures for the screenshot tool (CAPTURE_VISIBLE_TAB, src/shared/screenshot-protocol.ts).
//
// chrome.tabs.captureVisibleTab is limited to MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (2): captures are
// serialized through one queue and start at least CAPTURE_MIN_INTERVAL_MS apart; a quota error is retried
// after a pause. Only the active tab of a window can be captured, so a capture for a background tab fails. A call
// that never answers fails after CAPTURE_CALL_TIMEOUT_MS, so it cannot hold up the captures queued behind it.
import { CAPTURE_MIN_INTERVAL_MS } from '../shared/screenshot-protocol';
import type { CaptureVisibleResponse } from '../shared/screenshot-protocol';
import { errorMessage } from './util';

declare global {
  /** E2E build only: delay (ms) before every captureVisibleTab call (tests/e2e/errors.spec.ts: a slow capture). */
  var __reqlensCaptureDelayMs: number | undefined;
}

export interface CaptureDeps {
  getTab(tabId: number): Promise<{ active: boolean; windowId: number } | null>;
  captureVisibleTab(windowId: number): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Queued captures beyond this are refused (a runaway caller cannot pile up work). */
export const CAPTURE_QUEUE_MAX = 40;
/** A captureVisibleTab call that has not answered after this long fails. */
export const CAPTURE_CALL_TIMEOUT_MS = 15_000;
export const CAPTURE_TIMEOUT_ERROR = 'The browser did not capture the tab in time';
const QUOTA_RETRIES = 3;

function isQuotaError(err: unknown): boolean {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(errorMessage(err));
}

/** Serialized, rate-limited captureVisibleTab. */
export class CaptureQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastStart = -Infinity;

  constructor(
    private readonly deps: CaptureDeps,
    private readonly minIntervalMs = CAPTURE_MIN_INTERVAL_MS,
    private readonly callTimeoutMs = CAPTURE_CALL_TIMEOUT_MS,
  ) {}

  /** Number of captures waiting or running. */
  get pending(): number {
    return this.queued;
  }

  /** Capture the visible area of `tabId` (PNG data URL). */
  capture(tabId: number): Promise<CaptureVisibleResponse> {
    if (this.queued >= CAPTURE_QUEUE_MAX) return Promise.resolve({ ok: false, error: 'Too many screenshots queued — try again in a moment' });
    this.queued++;
    const run = this.tail.then(() => this.run(tabId));
    this.tail = run.catch(() => undefined);
    return run.finally(() => {
      this.queued--;
    });
  }

  /** captureVisibleTab, failing after callTimeoutMs (the late answer is dropped). */
  private call(windowId: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(CAPTURE_TIMEOUT_ERROR)), this.callTimeoutMs);
      this.deps.captureVisibleTab(windowId).then(
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

  private async run(tabId: number): Promise<CaptureVisibleResponse> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastStart + this.minIntervalMs - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      let tab: { active: boolean; windowId: number } | null;
      try {
        tab = await this.deps.getTab(tabId);
      } catch {
        tab = null;
      }
      if (!tab) return { ok: false, error: 'The tab is gone' };
      if (!tab.active) return { ok: false, error: 'Switch to this tab to take a screenshot (only the visible tab can be captured)' };
      this.lastStart = this.deps.now();
      try {
        const dataUrl = await this.call(tab.windowId);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return { ok: false, error: 'The browser returned no image' };
        return { ok: true, dataUrl };
      } catch (err) {
        if (isQuotaError(err) && attempt < QUOTA_RETRIES) {
          await this.deps.sleep(this.minIntervalMs * 2);
          continue;
        }
        return { ok: false, error: errorMessage(err) || 'Capture failed' };
      }
    }
  }
}

/** The worker's queue over the real chrome.tabs API. */
export function createCaptureQueue(): CaptureQueue {
  return new CaptureQueue({
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return typeof tab.windowId === 'number' ? { active: !!tab.active, windowId: tab.windowId } : null;
    },
    captureVisibleTab: async (windowId) => {
      if (__E2E__) {
        const delay = globalThis.__reqlensCaptureDelayMs;
        if (typeof delay === 'number' && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
