// Automatic error-area screenshots (Errors view, settings.captureErrorScreens): when and how to take them without
// getting in the user's way. Pure (no DOM, no chrome.*, injected clock): the panel feeds it what the user does with
// the overlay (src/ui/panel/activity.ts) and runs the capture attempts (src/ui/errors/automation.ts over the
// screenshot engine's captureErrorArea).
//  - The overlay is hidden only when it covers the capture rect (one of the hit regions the panel reports — panel,
//    pill, menus, toasts — intersects it); otherwise the page is captured with the overlay shown: the crop leaves it out.
//  - When it would have to hide, the capture waits while the user works with the overlay: the pointer over it, a key /
//    pointer / wheel event in it within the last INTERACTION_QUIET_MS, an open menu / popover / dialog, a drag or
//    resize, a focused text field. It also waits while the tab is hidden, the overlay is closed or minimized, and
//    while another capture or Find in page uses the page. Retried with backoff (AUTO_SHOT_RETRY_MS); after
//    AUTO_SHOT_BUDGET_MS it gives up ("skipped — busy"; the manual "Capture error area" stays available).
//  - The hidden window is capped (AUTO_SHOT_MAX_HIDDEN_MS, enforced by the engine and by the page side): past it the
//    capture is abandoned, the overlay shown again right away and the attempt reported as failed.
import type { Rect } from '../../lib/screenshot';
import type { HitRect } from '../../shared/panel-protocol';

/** A key / pointer / wheel event in the overlay this recent means the user is working with it. */
export const INTERACTION_QUIET_MS = 2_000;
/** An automatic capture that could not run within this long (from its first attempt) is given up. */
export const AUTO_SHOT_BUDGET_MS = 30_000;
/** Longest time an automatic capture may keep the overlay hidden (from hide to restore). */
export const AUTO_SHOT_MAX_HIDDEN_MS = 2_500;
/** Delays between attempts; the last one repeats. */
export const AUTO_SHOT_RETRY_MS: readonly number[] = [500, 1_000, 2_000, 3_000, 5_000];

/** What the user is doing with the overlay right now (src/ui/panel/activity.ts). */
export interface OverlayActivity {
  /** The hit regions the panel last reported (where the overlay paints): 'all' during a drag / resize, null = none yet. */
  regions: readonly HitRect[] | 'all' | null;
  /** The pointer is over the overlay (panel, pill, a menu, a toast). */
  pointerInside: boolean;
  /** When (same clock as `now`) the last key / pointer / wheel event reached the overlay; -Infinity = never. */
  lastInputAt: number;
  /** A menu, popover or dialog of the overlay is open. */
  popupOpen: boolean;
  /** A drag or resize is in progress (a pointer is captured). */
  gesture: boolean;
  /** A text field of the overlay has the keyboard focus (in the focused overlay frame). */
  typing: boolean;
}

/** Why the user counts as working with the overlay. */
export type BusyReason = 'gesture' | 'popup' | 'typing' | 'pointer' | 'input';
/** Why an automatic capture waits: the user (BusyReason), the tab is hidden, the overlay is closed / minimized, or the page is in use. */
export type WaitReason = BusyReason | 'hidden-tab' | 'closed' | 'session';

/** True when the overlay may paint over `rect`: one of its regions intersects it ('all' and unknown regions do). */
export function overlayCovers(rect: Rect, regions: OverlayActivity['regions']): boolean {
  if (regions === null || regions === 'all') return true;
  for (const r of regions) {
    if (!(r.width > 0) || !(r.height > 0)) continue;
    if (r.left < rect.x + rect.width && rect.x < r.left + r.width && r.top < rect.y + rect.height && rect.y < r.top + r.height) return true;
  }
  return false;
}

/** Why the user counts as busy with the overlay at `now` (null = not busy). */
export function busyReason(a: OverlayActivity, now: number, quietMs = INTERACTION_QUIET_MS): BusyReason | null {
  if (a.gesture || a.regions === 'all') return 'gesture';
  if (a.popupOpen) return 'popup';
  if (a.typing) return 'typing';
  if (a.pointerInside) return 'pointer';
  if (now - a.lastInputAt < quietMs) return 'input';
  return null;
}

export type OverlayDecision = { overlay: 'visible' } | { overlay: 'hide' } | { wait: BusyReason };

/**
 * How an automatic capture of `rect` (viewport CSS px) may run: with the overlay shown when it does not cover the
 * rect; hidden when it does and the user is not busy with it; otherwise it waits.
 */
export function decideOverlay(rect: Rect, a: OverlayActivity, now: number, quietMs = INTERACTION_QUIET_MS): OverlayDecision {
  if (!overlayCovers(rect, a.regions)) return { overlay: 'visible' };
  const busy = busyReason(a, now, quietMs);
  return busy ? { wait: busy } : { overlay: 'hide' };
}

/** Thrown by an attempt that has to wait (the session is ended, nothing was hidden). */
export class AutoShotWait extends Error {
  constructor(readonly reason: WaitReason) {
    super(`Automatic screenshot waits (${reason})`);
    this.name = 'AutoShotWait';
  }
}

/** Delay before attempt `n + 1` after attempt `n` (0-based) had to wait. */
export function retryDelay(n: number, steps: readonly number[] = AUTO_SHOT_RETRY_MS): number {
  if (steps.length === 0) return 1000;
  return steps[Math.min(Math.max(0, Math.floor(n)), steps.length - 1)]!;
}

/** Progress of an automatic capture (shown in the endpoint's Screenshot section). */
export type AutoShotState =
  | { state: 'waiting'; reason: WaitReason }
  | { state: 'capturing' }
  | { state: 'done' }
  | { state: 'skipped'; reason: WaitReason }
  | { state: 'failed'; error: string };

export type AttemptResult = { done: true } | { wait: WaitReason };

export interface AutoShotDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Why no attempt can start right now (no page round trip needed), or null. */
  blocked(): WaitReason | null;
  /** One attempt: done (a screenshot was kept) or wait; throws when the capture failed. */
  attempt(): Promise<AttemptResult>;
  /** Stop silently (a manual capture took over, the setting was turned off, the panel goes away). */
  cancelled(): boolean;
  onState(state: AutoShotState): void;
}

export interface AutoShotTiming {
  budgetMs?: number;
  retryMs?: readonly number[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run an automatic capture: attempt now, wait and retry with backoff while it has to wait, give up when the budget is
 * spent. Resolves with the final state (null when cancelled).
 */
export async function runAutoShot(deps: AutoShotDeps, timing: AutoShotTiming = {}): Promise<AutoShotState | null> {
  const budget = timing.budgetMs ?? AUTO_SHOT_BUDGET_MS;
  const start = deps.now();
  for (let n = 0; ; n++) {
    if (deps.cancelled()) return null;
    let reason = deps.blocked();
    if (!reason) {
      deps.onState({ state: 'capturing' });
      let result: AttemptResult;
      try {
        result = await deps.attempt();
      } catch (err) {
        if (deps.cancelled()) return null;
        const failed: AutoShotState = { state: 'failed', error: errorText(err) };
        deps.onState(failed);
        return failed;
      }
      if ('done' in result) {
        const done: AutoShotState = { state: 'done' };
        deps.onState(done);
        return done;
      }
      reason = result.wait;
      if (deps.cancelled()) return null;
    }
    const elapsed = deps.now() - start;
    if (elapsed >= budget) {
      const skipped: AutoShotState = { state: 'skipped', reason };
      deps.onState(skipped);
      return skipped;
    }
    deps.onState({ state: 'waiting', reason });
    // The last wait ends exactly at the budget: one final attempt there.
    await deps.sleep(Math.min(retryDelay(n, timing.retryMs), budget - elapsed));
  }
}

/** User-facing text of a wait reason. */
export function waitReasonText(reason: WaitReason): string {
  switch (reason) {
    case 'gesture':
      return 'the panel is being moved or resized';
    case 'popup':
      return 'a menu or dialog of kineReqLens is open';
    case 'typing':
      return 'you are typing in kineReqLens';
    case 'pointer':
      return 'the pointer is over kineReqLens';
    case 'input':
      return 'you are using kineReqLens';
    case 'hidden-tab':
      return 'the tab is in the background';
    case 'closed':
      return 'the overlay is closed or minimized';
    case 'session':
      return 'another capture or Find in page is using the page';
  }
}
