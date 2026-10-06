// Errors view helpers with side effects (panel): error-area screenshots (src/ui/screenshot/engine.ts
// captureErrorArea over the overlay's RemoteBridge: component lookup + CAPTURE_VISIBLE_TAB), starting analyses, and
// the automation that runs for new failing endpoints (useErrorAutomation, mounted by the App):
//  - auto-capture (settings.captureErrorScreens, default on): once per endpoint per page load, only while the tab is
//    visible and the overlay open, for fresh failures; non-intrusive (src/ui/errors/autoShot.ts): the page is never
//    scrolled, the overlay is hidden only when it covers the area and the user is not working with it, for at most
//    AUTO_SHOT_MAX_HIDDEN_MS; otherwise it waits and retries, and gives up after AUTO_SHOT_BUDGET_MS;
//  - auto-analyze (settings.autoAnalyzeErrors, default off): safe mode only, once per endpoint per page load, ≤ 3 per
//    minute (the worker enforces it too), only with a project folder for the page host.
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { ReqlensBridge, RequestEntry, Settings } from '../../shared/types';
import { RUN_MAX_IMAGE_CHARS } from '../../shared/errors-protocol';
import { projectHostOf } from '../../shared/errors-settings';
import type { ErrorPromptContext } from '../../lib/errorPrompt';
import { buildAnalyzePrompt } from '../../lib/errorPrompt';
import { toast } from '../components/toast';
import { initiatorAnalysisOf } from '../detail/initiatorState';
import { activityNow, overlayActivity } from '../panel/activity';
import { getBridgeStatus } from '../panel/claudeLink';
import { exportAnnotated } from '../screenshot/annotate';
import { captureErrorArea, createShotBackend, isShotBusy, isShotHost, shotSessionActive } from '../screenshot/engine';
import type { ErrorAreaCapture, ShotHost } from '../screenshot/engine';
import { thumbnail } from '../screenshot/store';
import { AUTO_SHOT_MAX_HIDDEN_MS, AutoShotWait, decideOverlay, runAutoShot } from './autoShot';
import type { AttemptResult, AutoShotState, WaitReason } from './autoShot';
import { errorContextOf } from './context';
import type { ErrorGroup } from './model';
import { groupErrors, groupsSignature } from './model';
import { addErrorShot, claimAuto, setAutoShot, setCapturing, shotsOf, startRun } from './store';
import type { ErrorShot } from './store';

/** Failures older than this when first seen are not auto-captured (the page moved on). */
const FRESH_MS = 20_000;
const AUTO_ANALYZE_PER_MINUTE = 3;

/** The project-folder host of the page (falls back to the request's page URL). */
export function pageHostOf(bridge: ReqlensBridge, entry?: RequestEntry | null): string | null {
  let pageUrl = '';
  try {
    pageUrl = bridge.getCaptureInfo().pageUrl;
  } catch {
    pageUrl = '';
  }
  return projectHostOf(pageUrl) ?? (entry ? projectHostOf(entry.pageUrl) ?? projectHostOf(entry.url) : null);
}

/** The project folder mapped to the page host, or null. */
export function projectFolderOf(settings: Pick<Settings, 'projectFolders'>, host: string | null): string | null {
  return host ? (settings.projectFolders[host] ?? null) : null;
}

/** Groups of the entries, recomputed only when the failures change. */
export function useErrorGroups(entries: readonly RequestEntry[]): ErrorGroup[] {
  const cache = useRef<{ signature: string; groups: ErrorGroup[] }>({ signature: '', groups: [] });
  return useMemo(() => {
    const groups = groupErrors(entries);
    const signature = groupsSignature(groups);
    if (signature === cache.current.signature) return cache.current.groups;
    cache.current = { signature, groups };
    return groups;
  }, [entries]);
}

// ------------------------------------------------------------------------------------------------ capture

let captureChain: Promise<unknown> = Promise.resolve();

function pageVisible(): boolean {
  try {
    return document.visibilityState === 'visible';
  } catch {
    return false;
  }
}

/** Run `task` after the captures queued before it (one capture at a time); the rail counts it meanwhile. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  setCapturing(1);
  const next = captureChain.then(task, task);
  captureChain = next.catch(() => undefined);
  void next.then(
    () => setCapturing(-1),
    () => setCapturing(-1),
  );
  return next;
}

/** Component names of the failing call's initiator (the lookup runs in the top frame only). */
async function componentNamesOf(entry: RequestEntry): Promise<string[]> {
  if (entry.frameId !== 0) return [];
  const analysis = await initiatorAnalysisOf(entry).catch(() => null);
  return analysis?.componentNames ?? [];
}

function locatorOf(bridge: ReqlensBridge) {
  const locate = bridge.locateComponents;
  return locate ? (q: Parameters<NonNullable<ReqlensBridge['locateComponents']>>[0]) => locate.call(bridge, q) : null;
}

const thumbOf = (c: ErrorAreaCapture) => thumbnail(c.blob, c.width, c.height);

/** Endpoints whose automatic capture must stop (a manual capture took over). */
const autoCancelled = new Set<string>();

/**
 * "Capture error area": the area of a failing endpoint's component (the newest failing call's initiator, scrolled into
 * view), or the visible page; the overlay is hidden while capturing. Serialized (one capture at a time); a pending
 * automatic capture of the endpoint stops. Rejects when the tab cannot be captured (hidden, not the active tab…).
 */
export function captureForGroup(bridge: ReqlensBridge, key: string, entry: RequestEntry): Promise<ErrorShot> {
  autoCancelled.add(key);
  setAutoShot(key, null);
  return serialized(async () => {
    if (!isShotHost(bridge)) throw new Error('Screenshots need the overlay of a page tab');
    if (!pageVisible()) throw new Error('The tab is hidden — screenshots only run while it is visible');
    const names = await componentNamesOf(entry);
    const capture = await captureErrorArea(createShotBackend(bridge), locatorOf(bridge), names);
    return addErrorShot(key, capture, false, thumbOf);
  });
}

interface AutoContext {
  settings: Settings;
  visible: boolean;
}

/**
 * The automatic capture of a new failing endpoint (src/ui/errors/autoShot.ts): never scrolls the page; the overlay
 * stays shown when it does not cover the area, is hidden only while the user is not working with it and for at most
 * AUTO_SHOT_MAX_HIDDEN_MS; otherwise it waits and retries, and gives up after AUTO_SHOT_BUDGET_MS ("skipped — busy").
 * Progress goes to the store (setAutoShot) for the endpoint's Screenshot section.
 */
async function autoCapture(bridge: ReqlensBridge & ShotHost, key: string, entry: RequestEntry, current: () => AutoContext): Promise<AutoShotState | null> {
  const names = await componentNamesOf(entry);
  const locate = locatorOf(bridge);
  const blocked = (): WaitReason | null => {
    if (!pageVisible()) return 'hidden-tab';
    if (!current().visible) return 'closed';
    if (shotSessionActive()) return 'session';
    return null;
  };
  const attempt = (): Promise<AttemptResult> =>
    serialized(async () => {
      // Things may have changed while earlier captures ran.
      const reason = blocked();
      if (reason) return { wait: reason };
      try {
        const capture = await captureErrorArea(createShotBackend(bridge), locate, names, {
          scroll: false,
          exclusive: true,
          maxHiddenMs: AUTO_SHOT_MAX_HIDDEN_MS,
          overlay: (rect, viewport) => {
            const decision = decideOverlay(rect, overlayActivity(viewport.pointerAt ?? 0), activityNow());
            if ('wait' in decision) throw new AutoShotWait(decision.wait);
            return decision.overlay;
          },
        });
        await addErrorShot(key, capture, true, thumbOf);
        return { done: true };
      } catch (err) {
        if (err instanceof AutoShotWait) return { wait: err.reason };
        if (isShotBusy(err)) return { wait: 'session' };
        throw err;
      }
    });
  const final = await runAutoShot({
    now: activityNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    blocked,
    attempt,
    cancelled: () => autoCancelled.has(key) || !current().settings.captureErrorScreens,
    // 'capturing' keeps what the section shows (no flicker between retries); 'done' clears it.
    onState: (state) => {
      if (state.state !== 'capturing') setAutoShot(key, state);
    },
  });
  // Cancelled (a manual capture took over, the setting was turned off): no "waiting" note stays behind.
  if (final === null) setAutoShot(key, null);
  return final;
}

/** PNG (annotations burnt in) as base64, or null when too large. */
export async function shotBase64(shot: ErrorShot): Promise<string | null> {
  let blob: Blob = shot.blob;
  if (shot.annotations.length) {
    try {
      const bitmap = await createImageBitmap(shot.blob);
      try {
        blob = await exportAnnotated(bitmap, shot.blob, shot.annotations);
      } finally {
        bitmap.close();
      }
    } catch {
      blob = shot.blob;
    }
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(binary);
  return b64.length <= RUN_MAX_IMAGE_CHARS ? b64 : null;
}

/** Copy a screenshot (annotations burnt in) to the clipboard. */
export async function copyShot(shot: ErrorShot): Promise<boolean> {
  try {
    let blob: Blob = shot.blob;
    if (shot.annotations.length) {
      const bitmap = await createImageBitmap(shot.blob);
      try {
        blob = await exportAnnotated(bitmap, shot.blob, shot.annotations);
      } finally {
        bitmap.close();
      }
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied', 'success');
    return true;
  } catch (err) {
    toast(`Could not copy the image: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ runs

/** The prompt context of a group's newest failing call (initiator source-mapped when possible). */
export async function contextForGroup(group: ErrorGroup, entry: RequestEntry, settings: Settings): Promise<ErrorPromptContext> {
  const analysis = await initiatorAnalysisOf(entry).catch(() => null);
  return errorContextOf(group, entry, analysis, settings);
}

/** Start a safe analysis of a group (from a click, or `auto`). */
export async function analyzeGroup(group: ErrorGroup, entry: RequestEntry, settings: Settings, cwd: string, auto = false): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await contextForGroup(group, entry, settings);
  const shot = shotsOf(group.key)[0];
  const image = shot ? await shotBase64(shot).catch(() => null) : null;
  const started = startRun({ key: group.key, kind: 'analyze', cwd, prompt: buildAnalyzePrompt(ctx), ...(image ? { image } : {}), auto });
  return started.ok ? { ok: true } : started;
}

// ------------------------------------------------------------------------------------------------ automation

const autoAnalyzeTimes: number[] = [];

export interface AutomationInput {
  bridge: ReqlensBridge;
  entries: readonly RequestEntry[];
  groups: readonly ErrorGroup[];
  settings: Settings;
  /** The overlay is open (not minimized). */
  visible: boolean;
}

/** Auto-capture / auto-analyze new failing endpoints (see the module comment). */
export function useErrorAutomation({ bridge, entries, groups, settings, visible }: AutomationInput): void {
  const handled = useRef(new Set<string>());
  const live = useRef({ entries, settings, visible });
  live.current = { entries, settings, visible };
  useEffect(() => {
    const fresh: ErrorGroup[] = [];
    for (const group of groups) {
      if (handled.current.has(group.key)) continue;
      handled.current.add(group.key);
      if (Date.now() - group.lastSeen <= FRESH_MS) fresh.push(group);
    }
    if (!fresh.length) return;
    const byId = new Map(live.current.entries.map((e) => [e.id, e] as const));
    for (const group of fresh.reverse()) {
      const entry = byId.get(group.entryIds[0]!);
      if (!entry) continue;
      void automate(bridge, group, entry, () => live.current);
    }
  }, [groups, bridge]);
}

/** The panel loaded at (page loads re-create it). Automatic captures wait until it has been shown for a moment. */
const panelLoadedAt = typeof performance !== 'undefined' ? performance.now() : 0;
const SETTLE_MS = 1500;

/** Resolve once the panel has been up SETTLE_MS and painted a frame (never hide the overlay while it first renders). */
function panelSettled(): Promise<void> {
  const wait = Math.max(0, SETTLE_MS - (performance.now() - panelLoadedAt));
  return new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), wait));
}

async function automate(bridge: ReqlensBridge, group: ErrorGroup, entry: RequestEntry, current: () => AutoContext): Promise<void> {
  await panelSettled();
  const { settings, visible } = current();
  // Aborted requests are mostly navigation / cancellation noise: no automatic screenshot for them.
  if (settings.captureErrorScreens && group.kind !== 'aborted' && visible && pageVisible() && isShotHost(bridge) && claimAuto('capture', group.key)) {
    await autoCapture(bridge, group.key, entry, current).catch(() => undefined);
  }
  const now = current().settings;
  if (!now.autoAnalyzeErrors || !now.claudeBridge) return;
  const cwd = projectFolderOf(now, pageHostOf(bridge, entry));
  const status = getBridgeStatus();
  if (!cwd || status.host !== 'connected') return;
  const t = Date.now();
  while (autoAnalyzeTimes.length && t - autoAnalyzeTimes[0]! > 60_000) autoAnalyzeTimes.shift();
  if (autoAnalyzeTimes.length >= AUTO_ANALYZE_PER_MINUTE) return;
  if (!claimAuto('analyze', group.key)) return;
  autoAnalyzeTimes.push(t);
  const result = await analyzeGroup(group, entry, now, cwd, true);
  if (result.ok) toast(`Analyzing ${group.endpoint} with Claude (automatic — uses tokens)`, 'info');
}
