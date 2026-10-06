// OWNER: ui-response agent. Pure selection logic of the results panel (active run, compare baseline).
import type { HeaderPair, ReplayMode, ResponseData, TestRun } from '../../shared/types';
import { replayModeName } from '../shellMode';
import { formatClock } from '../../lib/format';
import { hasComparableBody, runToResponseData } from './adapters';

export type CompareTarget = 'original' | 'previous';

/** The run to display: the requested one when it exists, else the newest. */
export function pickActiveRun(runs: TestRun[], activeRunId: string | null): TestRun | null {
  if (activeRunId) {
    const match = runs.find((r) => r.runId === activeRunId);
    if (match) return match;
  }
  return runs[0] ?? null;
}

/** The finished run immediately older than `runId` (runs are newest first), or null. */
export function findPreviousRun(runs: TestRun[], runId: string): TestRun | null {
  const idx = runs.findIndex((r) => r.runId === runId);
  if (idx < 0) return null;
  for (let i = idx + 1; i < runs.length; i++) {
    const run = runs[i];
    if (run.state !== 'running' && run.result) return run;
  }
  return null;
}

export interface CompareChoice {
  /** Baseline actually used, or null when nothing can be compared. */
  target: CompareTarget | null;
  baseline: ResponseData | null;
  label: string;
  originalAvailable: boolean;
  previousAvailable: boolean;
  previousRun: TestRun | null;
}

/**
 * Resolve the compare baseline for the active run: the user's preference when available, else the
 * original captured response when it has a body, else the previous run.
 */
export function chooseCompare(
  preferred: CompareTarget,
  original: ResponseData,
  runs: TestRun[],
  active: TestRun | null,
): CompareChoice {
  const previousRun = active ? findPreviousRun(runs, active.runId) : null;
  const originalAvailable = hasComparableBody(original);
  const previousAvailable = previousRun !== null;
  let target: CompareTarget | null = null;
  if (active) {
    if (preferred === 'previous' && previousAvailable) target = 'previous';
    else if (originalAvailable) target = 'original';
    else if (previousAvailable) target = 'previous';
  }
  if (target === 'original') {
    return { target, baseline: original, label: 'Original response', originalAvailable, previousAvailable, previousRun };
  }
  if (target === 'previous' && previousRun) {
    return {
      target,
      baseline: runToResponseData(previousRun),
      label: `Previous run (${formatClock(previousRun.startedAt)})`,
      originalAvailable,
      previousAvailable,
      previousRun,
    };
  }
  return { target: null, baseline: null, label: '', originalAvailable, previousAvailable, previousRun };
}

/** Display name of a replay mode. */
export function modeLabel(mode: ReplayMode): string {
  return replayModeName(mode);
}

/** Case-insensitive membership test for header-name lists such as `droppedHeaders`. */
export function headerNameIn(names: string[] | undefined, header: HeaderPair): boolean {
  if (!names || names.length === 0) return false;
  const lower = header.name.toLowerCase();
  return names.some((n) => n.toLowerCase() === lower);
}
