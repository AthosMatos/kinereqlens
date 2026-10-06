// Errors view state of this panel (module state: survives re-renders and the view being hidden; a page load gives
// a fresh panel, so "per page load" limits are simply per module lifetime):
//  - runs per endpoint (newest first, ≤ MAX_RUNS_PER_KEY) streamed from the worker (run-event / run-done);
//  - the last analysis per endpoint, persisted in chrome.storage.local (ANALYSES_KEY, ≤ MAX_STORED_ANALYSES);
//  - error-area screenshots per endpoint (≤ MAX_SHOTS_PER_KEY, ≤ MAX_SHOTS overall, in memory only), and how the
//    endpoint's automatic capture went when it did not simply succeed (waiting / skipped — busy / failed);
//  - which endpoints the user has seen (the rail's "new" dot) and which were auto-captured / auto-analyzed.
// Talks to the worker through claudeLink's postRun / subscribeRuns.
import { useEffect, useState } from 'preact/hooks';
import { OP_TIMEOUT_MS, newRunId, sanitizeOpResult } from '../../shared/errors-protocol';
import type { GitOp, OpResults, RunEvent, RunKind, WorktreeDiff } from '../../shared/errors-protocol';
import type { ErrorAnalysis } from '../../lib/errorPrompt';
import { parseAnalysis } from '../../lib/errorPrompt';
import type { Annotation } from '../screenshot/annotate';
import type { AutoShotState } from './autoShot';
import type { ErrorAreaCapture } from '../screenshot/engine';
import type { ShotItem } from '../screenshot/store';
import { postRun, subscribeRuns } from '../panel/claudeLink';
import type { RunLinkEvent } from '../panel/claudeLink';

export const ANALYSES_KEY = 'reqlens:error-analyses';
export const MAX_STORED_ANALYSES = 100;
export const MAX_RUNS_PER_KEY = 10;
export const MAX_SHOTS_PER_KEY = 5;
export const MAX_SHOTS = 20;
/** Run log lines kept per run. */
const MAX_LOG = 400;

export type RunState = 'running' | 'done' | 'error' | 'cancelled';

export type LogLine = { type: 'text'; text: string } | { type: 'tool'; name: string; summary: string } | { type: 'note'; text: string };

export interface RunRecord {
  id: string;
  key: string;
  /** Project folder it ran for. */
  cwd: string;
  kind: RunKind;
  auto: boolean;
  startedAt: number;
  endedAt?: number;
  state: RunState;
  model?: string;
  log: LogLine[];
  result?: Extract<RunEvent, { type: 'result' }>;
  analysis: ErrorAnalysis | null;
  error?: string;
  /** Fix runs. */
  worktree?: { path: string; branch: string };
  /** Also open the pull request dialog once the diff is in ("Try fix + PR"). */
  wantPr?: boolean;
  /** The pull request dialog was opened for wantPr. */
  prOffered?: boolean;
  diff?: WorktreeDiff;
  diffError?: string;
  committed?: string;
  discarded?: boolean;
  prUrl?: string;
}

export interface StoredAnalysis {
  analysis: ErrorAnalysis;
  at: number;
  costUsd?: number;
}

export interface ErrorShot extends ShotItem {
  area: ErrorAreaCapture['area'];
  component?: string;
  /** Captured automatically when the error was first seen. */
  auto: boolean;
}

// ------------------------------------------------------------------------------------------------ state

const runs = new Map<string, RunRecord[]>();
const runById = new Map<string, RunRecord>();
const shots = new Map<string, ErrorShot[]>();
let stored: Record<string, StoredAnalysis> = {};
let storedLoaded = false;
const seen = new Set<string>();
const autoCaptured = new Set<string>();
const autoAnalyzed = new Set<string>();
/** Automatic captures that are waiting, were skipped or failed (a finished one is forgotten). */
const autoShots = new Map<string, AutoShotState>();
const listeners = new Set<() => void>();
let revision = 0;
let subscribed = false;

function changed(): void {
  revision++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[kineReqLens] errors store listener failed', err);
    }
  }
}

export function subscribeErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Re-render on every change of the errors store. */
export function useErrorsStore(): number {
  const [rev, setRev] = useState(revision);
  useEffect(() => {
    setRev(revision);
    return subscribeErrors(() => setRev(revision));
  }, []);
  return rev;
}

// ------------------------------------------------------------------------------------------------ seen / auto

export function isSeen(key: string): boolean {
  return seen.has(key);
}

/** The user saw these endpoints (the Errors view is open). */
export function markSeen(keys: readonly string[]): void {
  let any = false;
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      any = true;
    }
  }
  if (any) changed();
}

/** First call per key returns true (one automatic capture / analysis per endpoint per page load). */
export function claimAuto(kind: 'capture' | 'analyze', key: string): boolean {
  const set = kind === 'capture' ? autoCaptured : autoAnalyzed;
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

// ------------------------------------------------------------------------------------------------ analyses

function storage(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

/** Load the persisted analyses (once). */
export function loadStoredAnalyses(): void {
  if (storedLoaded) return;
  storedLoaded = true;
  const area = storage();
  if (!area) return;
  void area.get(ANALYSES_KEY).then(
    (items) => {
      stored = sanitizeStoredAnalyses(items[ANALYSES_KEY]);
      changed();
    },
    () => undefined,
  );
}

/** Persisted analyses from storage: valid entries only, newest MAX_STORED_ANALYSES. */
export function sanitizeStoredAnalyses(value: unknown): Record<string, StoredAnalysis> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const list: Array<[string, StoredAnalysis]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length > 4096 || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    const analysis = r.analysis && typeof r.analysis === 'object' ? parseAnalysis(JSON.stringify(r.analysis)) : null;
    if (!analysis) continue;
    const item: StoredAnalysis = { analysis, at: r.at };
    if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) item.costUsd = r.costUsd;
    list.push([key, item]);
  }
  list.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(list.slice(0, MAX_STORED_ANALYSES));
}

export function storedAnalysis(key: string): StoredAnalysis | null {
  return stored[key] ?? null;
}

function persistAnalysis(key: string, item: StoredAnalysis): void {
  stored = sanitizeStoredAnalyses({ ...stored, [key]: item });
  const area = storage();
  if (!area) return;
  // Merge with what other panels stored meanwhile.
  void area.get(ANALYSES_KEY).then(
    (items) => area.set({ [ANALYSES_KEY]: sanitizeStoredAnalyses({ ...sanitizeStoredAnalyses(items[ANALYSES_KEY]), [key]: item }) }),
    () => undefined,
  );
}

/** The latest analysis of an endpoint: from this page load's runs, else the persisted one. */
export function latestAnalysis(key: string): ErrorAnalysis | null {
  const run = (runs.get(key) ?? []).find((r) => r.analysis);
  return run?.analysis ?? stored[key]?.analysis ?? null;
}

// ------------------------------------------------------------------------------------------------ runs

export function runsOf(key: string): readonly RunRecord[] {
  return runs.get(key) ?? [];
}

export function runningCount(): number {
  let n = 0;
  for (const r of runById.values()) if (r.state === 'running') n++;
  return n;
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeRuns(onRunEvent);
}

function pushLog(run: RunRecord, line: LogLine): void {
  const last = run.log[run.log.length - 1];
  if (line.type === 'text' && last?.type === 'text') last.text += line.text;
  else run.log.push(line);
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
}

export interface StartRunInput {
  key: string;
  kind: RunKind;
  cwd: string;
  prompt: string;
  image?: string;
  slug?: string;
  auto?: boolean;
  wantPr?: boolean;
}

/** Start a run (from a click, or the auto-analyze setting). */
export function startRun(input: StartRunInput): { ok: true; run: RunRecord } | { ok: false; error: string } {
  ensureSubscribed();
  const id = newRunId();
  const message = { t: 'run-start' as const, id, kind: input.kind, cwd: input.cwd, prompt: input.prompt, ...(input.image ? { image: input.image } : {}), ...(input.slug ? { slug: input.slug } : {}), ...(input.auto ? { auto: true } : {}) };
  if (!postRun(message)) return { ok: false, error: 'The Claude Code bridge is not connected — check Settings → Claude Code' };
  const run: RunRecord = { id, key: input.key, cwd: input.cwd, kind: input.kind, auto: input.auto === true, startedAt: Date.now(), state: 'running', log: [], analysis: null };
  if (input.wantPr) run.wantPr = true;
  const list = [run, ...(runs.get(input.key) ?? [])];
  for (const old of list.slice(MAX_RUNS_PER_KEY)) runById.delete(old.id);
  runs.set(input.key, list.slice(0, MAX_RUNS_PER_KEY));
  runById.set(id, run);
  changed();
  return { ok: true, run };
}

export function cancelRun(id: string): void {
  const run = runById.get(id);
  if (!run || run.state !== 'running') return;
  postRun({ t: 'run-cancel', id });
}

/** Update a run (UI-side facts: diff, commit, PR…). */
export function updateRun(id: string, patch: Partial<RunRecord>): void {
  const run = runById.get(id);
  if (!run) return;
  Object.assign(run, patch);
  changed();
}

function onRunEvent(event: RunLinkEvent): void {
  if (event.t === 'link-lost') {
    let any = false;
    for (const run of runById.values()) {
      if (run.state !== 'running') continue;
      run.state = 'error';
      run.error = 'Lost the connection to the kineReqLens service worker';
      run.endedAt = Date.now();
      any = true;
    }
    failOps('Lost the connection to the kineReqLens service worker');
    if (any) changed();
    return;
  }
  if (event.t === 'op-done') {
    settleOp(event);
    return;
  }
  const run = runById.get(event.id);
  if (!run) return;
  if (event.t === 'run-event') {
    const e = event.event;
    switch (e.type) {
      case 'init':
        if (e.model) run.model = e.model;
        break;
      case 'text':
        pushLog(run, { type: 'text', text: e.text });
        break;
      case 'tool':
        pushLog(run, { type: 'tool', name: e.name, summary: e.summary });
        break;
      case 'stderr':
        break;
      case 'worktree':
        run.worktree = { path: e.path, branch: e.branch };
        pushLog(run, { type: 'note', text: `Worktree ${e.path} on ${e.branch}` });
        break;
      case 'result':
        run.result = e;
        run.analysis = parseAnalysis(e.text);
        break;
    }
    changed();
    return;
  }
  // run-done
  run.endedAt = Date.now();
  if (event.cancelled) run.state = 'cancelled';
  else run.state = event.ok ? 'done' : 'error';
  if (event.error) run.error = event.error;
  if (run.analysis && run.kind === 'analyze' && run.state === 'done') {
    const item: StoredAnalysis = { analysis: run.analysis, at: Date.now() };
    if (run.result?.costUsd !== undefined) item.costUsd = run.result.costUsd;
    persistAnalysis(run.key, item);
  }
  changed();
  // A fix leaves a worktree: load its diff (also after a failure, so it can be reviewed or discarded).
  if (run.kind === 'fix' && run.worktree && run.state !== 'cancelled') loadDiff(run);
  for (const fn of [...doneListeners]) fn(run);
}

/** (Re)load the diff of a fix run's worktree. */
export function loadDiff(run: RunRecord): void {
  if (!run.worktree) return;
  runOp({ op: 'worktree-diff', cwd: run.cwd, worktree: run.worktree.path }).then(
    (diff) => updateRun(run.id, { diff, diffError: undefined }),
    (err: unknown) => updateRun(run.id, { diffError: err instanceof Error ? err.message : String(err) }),
  );
}

const doneListeners = new Set<(run: RunRecord) => void>();

/** Called when a run finished (any state). */
export function onRunDone(fn: (run: RunRecord) => void): () => void {
  doneListeners.add(fn);
  return () => {
    doneListeners.delete(fn);
  };
}

// ------------------------------------------------------------------------------------------------ ops

interface PendingOp {
  op: GitOp['op'];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const ops = new Map<string, PendingOp>();

function settleOp(event: Extract<RunLinkEvent, { t: 'op-done' }>): void {
  const pending = ops.get(event.id);
  if (!pending) return;
  ops.delete(event.id);
  clearTimeout(pending.timer);
  if (!event.ok) {
    pending.reject(new Error(event.error));
    return;
  }
  const result = sanitizeOpResult(pending.op, event.result);
  if (result === null) pending.reject(new Error('Unexpected answer from the kineReqLens bridge'));
  else pending.resolve(result);
}

function failOps(error: string): void {
  for (const [id, pending] of ops) {
    clearTimeout(pending.timer);
    pending.reject(new Error(error));
    ops.delete(id);
  }
}

/** Run a full-mode git / gh op on the hub. */
export function runOp<K extends GitOp['op']>(op: Extract<GitOp, { op: K }>): Promise<OpResults[K]> {
  ensureSubscribed();
  const id = newRunId('op');
  return new Promise<OpResults[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ops.delete(id)) reject(new Error('The kineReqLens bridge did not answer in time'));
    }, OP_TIMEOUT_MS + 15_000);
    ops.set(id, { op: op.op, resolve: resolve as (value: unknown) => void, reject, timer });
    if (!postRun({ t: 'op-start', id, op })) {
      ops.delete(id);
      clearTimeout(timer);
      reject(new Error('The Claude Code bridge is not connected — check Settings → Claude Code'));
    }
  });
}

// ------------------------------------------------------------------------------------------------ screenshots

let shotSeq = 0;
let capturing = 0;

/** Error-area captures queued or running. */
export function capturingCount(): number {
  return capturing;
}

export function setCapturing(delta: number): void {
  capturing = Math.max(0, capturing + delta);
  changed();
}

/** Screenshots kept, all endpoints. */
export function shotsTotal(): number {
  let n = 0;
  for (const list of shots.values()) n += list.length;
  return n;
}

export function shotsOf(key: string): readonly ErrorShot[] {
  return shots.get(key) ?? [];
}

function release(shot: ErrorShot): void {
  if (shot.thumbUrl) URL.revokeObjectURL(shot.thumbUrl);
}

/** How the endpoint's automatic capture is going (null: none, or it succeeded). */
export function autoShotOf(key: string): AutoShotState | null {
  return autoShots.get(key) ?? null;
}

/** Record the progress of an endpoint's automatic capture ('done' / null forget it). */
export function setAutoShot(key: string, state: AutoShotState | null): void {
  const current = autoShots.get(key) ?? null;
  if (!state || state.state === 'done') {
    if (!current) return;
    autoShots.delete(key);
  } else {
    if (current && JSON.stringify(current) === JSON.stringify(state)) return;
    autoShots.set(key, state);
  }
  changed();
}

/** Keep a capture for an endpoint (newest first; ≤ MAX_SHOTS_PER_KEY per endpoint, ≤ MAX_SHOTS overall). */
export async function addErrorShot(key: string, capture: ErrorAreaCapture, auto: boolean, thumb: (c: ErrorAreaCapture) => Promise<string | null>): Promise<ErrorShot> {
  const shot: ErrorShot = {
    ...capture,
    id: `errshot-${Date.now().toString(36)}-${++shotSeq}`,
    createdAt: Date.now(),
    thumbUrl: await thumb(capture),
    annotations: [],
    area: capture.area,
    auto,
  };
  if (capture.component) shot.component = capture.component;
  const list = [shot, ...(shots.get(key) ?? [])];
  for (const old of list.slice(MAX_SHOTS_PER_KEY)) release(old);
  shots.set(key, list.slice(0, MAX_SHOTS_PER_KEY));
  // Overall cap: drop the oldest captures of any endpoint.
  const all = [...shots.entries()].flatMap(([k, l]) => l.map((s) => ({ k, s })));
  if (all.length > MAX_SHOTS) {
    all.sort((a, b) => a.s.createdAt - b.s.createdAt);
    for (const { k, s } of all.slice(0, all.length - MAX_SHOTS)) {
      release(s);
      shots.set(k, (shots.get(k) ?? []).filter((x) => x !== s));
    }
  }
  changed();
  return shot;
}

export function setShotAnnotations(id: string, annotations: Annotation[]): void {
  for (const [key, list] of shots) {
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) continue;
    const next = [...list];
    next[i] = { ...list[i]!, annotations };
    shots.set(key, next);
    changed();
    return;
  }
}

export function removeErrorShot(id: string): void {
  for (const [key, list] of shots) {
    const gone = list.find((s) => s.id === id);
    if (!gone) continue;
    release(gone);
    shots.set(key, list.filter((s) => s !== gone));
    changed();
    return;
  }
}

export function findErrorShot(id: string | null): ErrorShot | null {
  if (!id) return null;
  for (const list of shots.values()) {
    const s = list.find((x) => x.id === id);
    if (s) return s;
  }
  return null;
}

/** Tests: forget everything. */
export function resetErrorsStore(): void {
  runs.clear();
  runById.clear();
  for (const list of shots.values()) list.forEach(release);
  shots.clear();
  stored = {};
  storedLoaded = false;
  seen.clear();
  autoCaptured.clear();
  autoAnalyzed.clear();
  autoShots.clear();
  failOps('reset');
  changed();
}
