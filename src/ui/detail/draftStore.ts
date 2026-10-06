// OWNER: ui-editor agent. In-memory drafts and test runs per entry (module singleton, lives as long as the page).
// The functions below are a contract also used by the request list (ui-shell agent).
//
// Records are immutable: every change replaces the entry's record object, so hooks detect changes by
// identity. Per-entry listeners fire on every change of that entry; global `subscribeMeta` listeners fire
// only when some entry's EntryMeta actually changed (typing in the editor does not re-render the list).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { MAX_RUNS_PER_ENTRY } from '../../shared/constants';
import type {
  BodyModel,
  Draft,
  DraftSection,
  HeaderPair,
  ReplayMode,
  ReplayRequest,
  ReplayResult,
  ReqlensBridge,
  RequestEntry,
  RunState,
  SerializedBody,
  Settings,
  TestRun,
} from '../../shared/types';
import { rawTextToBody } from '../../lib/body';
import { buildReplayRequest, createDraft, revertDraft, revertSection } from '../../lib/draft';
import { uid } from '../../lib/ids';
import { alignParsedBody } from './align';
import { isModifiedCached } from './derived';
import { errorMessage } from './util';

export interface EntryMeta {
  /** Draft exists and differs from the original. */
  modified: boolean;
  runs: number;
  lastRun?: TestRun;
}

/**
 * Per-draft send options. `mode` / `timeoutMs` left undefined follow the current settings defaults;
 * `credentials` left undefined follows the captured request (see defaultCredentials).
 */
export interface SendOptions {
  mode?: ReplayMode;
  credentials?: ReplayRequest['credentials'];
  redirect: ReplayRequest['redirect'];
  timeoutMs?: number;
}

export interface ResolvedSendOptions {
  mode: ReplayMode;
  credentials: ReplayRequest['credentials'];
  /** `credentials` is the automatic value derived from the captured request (not a user override). */
  credentialsAuto: boolean;
  redirect: ReplayRequest['redirect'];
  timeoutMs: number;
}

export type BodyView = 'fields' | 'raw';

/** Raw-view text that may not (yet) parse into the body model. */
export interface RawEdit {
  text: string;
  /** Parse error (with line:column) — blocks Send while the text is shown. */
  error: string | null;
  /** Body model this text belongs to; once the draft body is replaced by anything else the text is re-derived. */
  body: BodyModel;
  /** A parse is scheduled (large bodies are parsed after a short idle delay). */
  pending: boolean;
}

/** Everything the editor keeps for one entry. Immutable; replaced on every change. */
export interface EntryRecord {
  readonly entryId: string;
  readonly draft: Draft | null;
  /** createDraft failed (draft is null). */
  readonly draftError: string | null;
  readonly options: SendOptions;
  /** Newest first, at most MAX_RUNS_PER_ENTRY. */
  readonly runs: TestRun[];
  readonly activeRunId: string | null;
  readonly bodyView: BodyView;
  readonly raw: RawEdit | null;
  readonly meta: EntryMeta;
}

export type DraftUpdater = (fn: (draft: Draft) => Draft) => void;

export const DEFAULT_SEND_OPTIONS: SendOptions = Object.freeze({ redirect: 'follow' });

const CREDENTIALS_MODES: ReadonlySet<string> = new Set(['include', 'same-origin', 'omit']);

/**
 * Credentials that reproduce the captured request. Page mode: the page's own fetch `credentials` or XHR
 * `withCredentials`, else the fetch/XHR default 'same-origin' for hook captures; beacons, browser-initiated
 * (webRequest) and manual requests send cookies ('include'). Extension mode: 'include' (act as the signed-in
 * user from the service worker) unless the page explicitly used 'omit'.
 */
export function defaultCredentials(
  entry: Pick<RequestEntry, 'source' | 'kind' | 'requestOptions'> | null | undefined,
  mode: ReplayMode,
): ReplayRequest['credentials'] {
  const options = entry?.requestOptions;
  let original: ReplayRequest['credentials'];
  const explicit = options?.credentials;
  if (typeof explicit === 'string' && CREDENTIALS_MODES.has(explicit)) original = explicit as ReplayRequest['credentials'];
  else if (options?.withCredentials === true) original = 'include';
  else if (entry?.source === 'hook' && entry.kind !== 'beacon') original = 'same-origin';
  else original = 'include';
  if (mode === 'extension') return original === 'omit' ? 'omit' : 'include';
  return original;
}

const EMPTY_META: EntryMeta = Object.freeze({ modified: false, runs: 0 });
const NO_RUNS: TestRun[] = [];
/** How long Cancel waits for the bridge to confirm the abort before marking the run aborted itself. */
const CANCEL_GRACE_MS = 1500;
/** Raw text longer than this is parsed after an idle delay instead of on every keystroke. */
const RAW_SYNC_PARSE_MAX = 200_000;
const RAW_PARSE_DELAY_MS = 250;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 10 * 60 * 1000;

// --------------------------------------------------------------------------------------------- state

interface RequestSide {
  method: string;
  url: string;
  contentType: string | null;
  headers: HeaderPair[];
  body: SerializedBody | null;
}

interface InflightRun {
  bridge: ReqlensBridge;
  entryId: string;
  request: ReplayRequest;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

const records = new Map<string, EntryRecord>();
/** Request side of the entry each draft was created from (to follow late-arriving capture data). */
const sources = new Map<string, RequestSide>();
const inflight = new Map<string, InflightRun>();
/** Callers waiting for a run to finish (runForClaude), by run id. */
const runWaiters = new Map<string, (run: TestRun) => void>();
const rawTimers = new Map<string, ReturnType<typeof setTimeout>>();
const entryListeners = new Map<string, Set<() => void>>();
const metaListeners = new Set<() => void>();
/** Listeners for any record change (created, edited, removed): the UI-state handoff. */
const recordListeners = new Set<(entryId: string) => void>();

function emit(entryId: string, metaChanged: boolean): void {
  const set = entryListeners.get(entryId);
  if (set) for (const fn of [...set]) safeCall(fn);
  if (metaChanged) for (const fn of [...metaListeners]) safeCall(fn);
  notifyRecord(entryId);
}

function notifyRecord(entryId: string): void {
  for (const fn of [...recordListeners]) {
    try {
      fn(entryId);
    } catch (err) {
      console.error('[reqlens] record listener failed', err);
    }
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[reqlens] draft store listener failed', err);
  }
}

function computeMeta(prev: EntryMeta, draft: Draft | null, runs: TestRun[]): EntryMeta {
  const modified = draft ? isModifiedCached(draft) : false;
  const lastRun = runs[0];
  if (prev.modified === modified && prev.runs === runs.length && prev.lastRun === lastRun) return prev;
  return lastRun ? { modified, runs: runs.length, lastRun } : { modified, runs: runs.length };
}

/** Replace an existing record with a patched copy and notify. No-op for unknown entries. */
function commit(entryId: string, patch: Partial<Omit<EntryRecord, 'entryId' | 'meta'>>): EntryRecord | null {
  const prev = records.get(entryId);
  if (!prev) return null;
  const merged = { ...prev, ...patch };
  const meta =
    merged.draft !== prev.draft || merged.runs !== prev.runs
      ? computeMeta(prev.meta, merged.draft, merged.runs)
      : prev.meta;
  const next: EntryRecord = { ...merged, meta };
  records.set(entryId, next);
  emit(entryId, next.meta !== prev.meta);
  return next;
}

function tryCreateDraft(entry: RequestEntry): { draft: Draft | null; draftError: string | null } {
  try {
    return { draft: createDraft(entry), draftError: null };
  } catch (err) {
    console.error('[reqlens] createDraft failed', err);
    return { draft: null, draftError: errorMessage(err) };
  }
}

function requestSideOf(entry: RequestEntry): RequestSide {
  return {
    method: entry.method,
    url: entry.url,
    contentType: entry.requestContentType,
    headers: entry.requestHeaders,
    body: entry.requestBody,
  };
}

function sameHeaderList(a: HeaderPair[], b: HeaderPair[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.name !== b[i]!.name || a[i]!.value !== b[i]!.value) return false;
  }
  return true;
}

function sameBody(a: SerializedBody | null, b: SerializedBody | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.text === b.text && a.size === b.size && !!a.truncated === !!b.truncated;
    case 'base64':
      return b.kind === 'base64' && a.base64 === b.base64 && a.size === b.size && !!a.truncated === !!b.truncated;
    case 'unavailable':
      return b.kind === 'unavailable' && a.reason === b.reason;
    case 'formFields':
      return b.kind === 'formFields' && JSON.stringify(a.fields) === JSON.stringify(b.fields);
    case 'formData':
      return b.kind === 'formData' && JSON.stringify(a.entries) === JSON.stringify(b.entries);
  }
}

// webRequest snapshots arrive as fresh objects, so compare by value rather than identity.
function sameRequestSide(a: RequestSide, b: RequestSide): boolean {
  return (
    a.method === b.method &&
    a.url === b.url &&
    a.contentType === b.contentType &&
    sameHeaderList(a.headers, b.headers) &&
    sameBody(a.body, b.body)
  );
}

function newRecord(entry: RequestEntry): EntryRecord {
  const { draft, draftError } = tryCreateDraft(entry);
  return {
    entryId: entry.id,
    draft,
    draftError,
    options: DEFAULT_SEND_OPTIONS,
    runs: NO_RUNS,
    activeRunId: null,
    bodyView: 'fields',
    raw: null,
    meta: EMPTY_META,
  };
}

// --------------------------------------------------------------------------------------------- contract

export function getEntryMeta(entryId: string): EntryMeta {
  return records.get(entryId)?.meta ?? EMPTY_META;
}

/**
 * Subscribe to draft/run changes that affect any entry's EntryMeta (modified flag, run count, last run).
 * Returns unsubscribe.
 */
export function subscribeMeta(fn: () => void): () => void {
  metaListeners.add(fn);
  return () => {
    metaListeners.delete(fn);
  };
}

/** Preact hook: meta for one entry, re-rendering on change. */
export function useEntryMeta(entryId: string): EntryMeta {
  return useEntrySubscription(entryId, () => getEntryMeta(entryId));
}

/** Entries the user holds work for: an edited draft or test runs (never evicted, see the shell). */
export function entriesWithWork(): string[] {
  const ids: string[] = [];
  for (const [id, rec] of records) if (rec.meta.modified || rec.meta.runs > 0) ids.push(id);
  return ids;
}

/** Drop drafts/runs for entries that no longer exist (called by the shell after clear). */
export function pruneDrafts(liveEntryIds: Set<string>): void {
  let changed = false;
  for (const [id, rec] of records) {
    if (liveEntryIds.has(id)) continue;
    for (const run of rec.runs) if (run.state === 'running') abortInflight(run.runId);
    const t = rawTimers.get(id);
    if (t !== undefined) clearTimeout(t);
    rawTimers.delete(id);
    records.delete(id);
    sources.delete(id);
    changed = true;
    emit(id, false);
  }
  if (changed) for (const fn of [...metaListeners]) safeCall(fn);
}

// --------------------------------------------------------------------------------------------- records

/** Current record of an entry, if a draft was ever opened for it. */
export function getRecord(entryId: string): EntryRecord | undefined {
  return records.get(entryId);
}

/**
 * Record for an entry, creating the draft lazily. While the draft is still unmodified it follows
 * late-arriving request data of the entry (e.g. webRequest headers that arrive after selection).
 * Safe to call during render: creation/refresh never changes EntryMeta, so nobody needs notifying.
 */
export function ensureRecord(entry: RequestEntry): EntryRecord {
  let rec = records.get(entry.id);
  const side = requestSideOf(entry);
  if (!rec) {
    rec = newRecord(entry);
    records.set(entry.id, rec);
    sources.set(entry.id, side);
    queueMicrotask(() => notifyRecord(entry.id));
    return rec;
  }
  const prevSide = sources.get(entry.id);
  if (prevSide && !sameRequestSide(prevSide, side)) {
    sources.set(entry.id, side);
    if (!rec.meta.modified && !rec.raw) {
      const { draft, draftError } = tryCreateDraft(entry);
      rec = { ...rec, draft, draftError };
      records.set(entry.id, rec);
    }
  }
  return rec;
}

/** Discard the draft (and raw text) of an entry; it is re-created from the capture on next render. */
export function resetDraft(entry: RequestEntry): void {
  const rec = records.get(entry.id);
  if (!rec) return;
  const { draft, draftError } = tryCreateDraft(entry);
  sources.set(entry.id, requestSideOf(entry));
  commit(entry.id, { draft, draftError, raw: null, bodyView: 'fields' });
}

/** Apply an immutable edit to an entry's draft. Returning the same draft is a no-op. */
export function updateDraft(entryId: string, fn: (draft: Draft) => Draft): void {
  const rec = records.get(entryId);
  if (!rec?.draft) return;
  const next = fn(rec.draft);
  if (next === rec.draft) return;
  commit(entryId, { draft: next });
}

export function revertAll(entryId: string): void {
  const rec = records.get(entryId);
  if (!rec?.draft) return;
  clearRawTimer(entryId);
  commit(entryId, { draft: revertDraft(rec.draft), raw: null });
}

export function revertDraftSection(entryId: string, section: DraftSection): void {
  const rec = records.get(entryId);
  if (!rec?.draft) return;
  if (section === 'body') clearRawTimer(entryId);
  commit(entryId, { draft: revertSection(rec.draft, section), ...(section === 'body' ? { raw: null } : {}) });
}

export function setSendOptions(entryId: string, patch: Partial<SendOptions>): void {
  const rec = records.get(entryId);
  if (!rec) return;
  commit(entryId, { options: { ...rec.options, ...patch } });
}

/**
 * Effective options: per-draft overrides over settings defaults (credentials over the captured request's,
 * see defaultCredentials), timeout clamped to sane bounds.
 */
export function resolveSendOptions(
  options: SendOptions,
  settings: Settings,
  entry?: Pick<RequestEntry, 'source' | 'kind' | 'requestOptions'> | null,
): ResolvedSendOptions {
  const timeout = options.timeoutMs ?? settings.replayTimeoutMs;
  const mode = options.mode ?? settings.defaultMode;
  return {
    mode,
    credentials: options.credentials ?? defaultCredentials(entry, mode),
    credentialsAuto: options.credentials === undefined,
    redirect: options.redirect,
    timeoutMs: Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Number.isFinite(timeout) ? timeout : 30_000)),
  };
}

// --------------------------------------------------------------------------------------------- raw view

function clearRawTimer(entryId: string): void {
  const t = rawTimers.get(entryId);
  if (t !== undefined) clearTimeout(t);
  rawTimers.delete(entryId);
}

/** True when the raw text currently shown belongs to the draft body (so its error/pending state applies). */
export function rawApplies(rec: EntryRecord): rec is EntryRecord & { raw: RawEdit; draft: Draft } {
  return !!rec.raw && !!rec.draft && rec.raw.body === rec.draft.body;
}

export function setBodyView(entryId: string, view: BodyView): void {
  const rec = records.get(entryId);
  if (!rec || rec.bodyView === view) return;
  flushRawParse(entryId);
  commit(entryId, { bodyView: view, raw: null });
}

function parseRaw(entryId: string, text: string): void {
  const rec = records.get(entryId);
  if (!rec?.draft) return;
  const like = rec.draft.body;
  let parsed: { model: BodyModel } | { error: string };
  try {
    parsed = rawTextToBody(text, like);
  } catch (err) {
    parsed = { error: errorMessage(err) };
  }
  if ('model' in parsed) {
    const model = alignParsedBody(parsed.model, rec.draft.original.body, like);
    const draft: Draft = { ...rec.draft, body: model };
    commit(entryId, { draft, raw: { text, error: null, body: model, pending: false } });
  } else {
    commit(entryId, { raw: { text, error: parsed.error, body: like, pending: false } });
  }
}

/** Text typed in the raw body view: re-syncs the body model when it parses, else records the error. */
export function applyRawText(entryId: string, text: string): void {
  const rec = records.get(entryId);
  if (!rec?.draft) return;
  clearRawTimer(entryId);
  if (text.length <= RAW_SYNC_PARSE_MAX) {
    parseRaw(entryId, text);
    return;
  }
  commit(entryId, { raw: { text, error: null, body: rec.draft.body, pending: true } });
  rawTimers.set(
    entryId,
    setTimeout(() => {
      rawTimers.delete(entryId);
      parseRaw(entryId, text);
    }, RAW_PARSE_DELAY_MS),
  );
}

/** Parse a pending raw edit now (before sending / switching views). */
export function flushRawParse(entryId: string): void {
  const rec = records.get(entryId);
  if (!rec || !rawApplies(rec) || !rec.raw.pending) return;
  clearRawTimer(entryId);
  parseRaw(entryId, rec.raw.text);
}

// --------------------------------------------------------------------------------------------- runs

function failureResult(
  runId: string,
  request: ReplayRequest,
  start: number,
  error: string,
  extra?: Partial<ReplayResult>,
): ReplayResult {
  return {
    runId,
    ok: false,
    status: 0,
    statusText: '',
    headers: [],
    body: null,
    url: request.url,
    redirected: false,
    timing: { start, end: Date.now() },
    size: 0,
    error,
    ...extra,
  };
}

function runStateOf(result: ReplayResult): RunState {
  if (result.aborted) return 'aborted';
  return result.ok ? 'done' : 'error';
}

function finishRun(entryId: string, runId: string, result: ReplayResult): void {
  const fl = inflight.get(runId);
  if (fl?.cancelTimer !== undefined) clearTimeout(fl.cancelTimer);
  inflight.delete(runId);
  const rec = records.get(entryId);
  const idx = rec ? rec.runs.findIndex((r) => r.runId === runId) : -1;
  const run = rec && idx >= 0 ? rec.runs[idx] : undefined;
  if (!rec || !run || run.state !== 'running') {
    // The record or run is gone (cleared, pruned beyond MAX_RUNS_PER_ENTRY): still answer a waiting caller.
    if (fl) settleWaiter({ runId, entryId, request: fl.request, startedAt: result.timing.start, state: runStateOf(result), result });
    return;
  }
  const runs = rec.runs.slice();
  const finished: TestRun = { ...run, state: runStateOf(result), result: { ...result, runId } };
  runs[idx] = finished;
  commit(entryId, { runs });
  settleWaiter(finished);
}

function settleWaiter(run: TestRun): void {
  const waiter = runWaiters.get(run.runId);
  if (!waiter) return;
  runWaiters.delete(run.runId);
  waiter(run);
}

function abortInflight(runId: string): void {
  const fl = inflight.get(runId);
  if (!fl) return;
  try {
    fl.bridge.abortReplay(runId);
  } catch (err) {
    console.warn('[reqlens] abortReplay failed', err);
  }
}

function dispatchRun(bridge: ReqlensBridge, entryId: string, request: ReplayRequest, origin?: TestRun['origin']): string | null {
  const rec = records.get(entryId);
  if (!rec) return null;
  const run: TestRun = { runId: request.runId, entryId, request, startedAt: Date.now(), state: 'running' };
  if (origin) run.origin = origin;
  const all = [run, ...rec.runs];
  for (const dropped of all.slice(MAX_RUNS_PER_ENTRY)) if (dropped.state === 'running') abortInflight(dropped.runId);
  inflight.set(run.runId, { bridge, entryId, request });
  commit(entryId, { runs: all.slice(0, MAX_RUNS_PER_ENTRY), activeRunId: run.runId });

  let pending: Promise<ReplayResult>;
  try {
    pending = Promise.resolve(bridge.replay(request));
  } catch (err) {
    pending = Promise.reject(err);
  }
  pending.then(
    (result) =>
      finishRun(
        entryId,
        run.runId,
        result ?? failureResult(run.runId, request, run.startedAt, 'No response from the replay bridge'),
      ),
    (err: unknown) => finishRun(entryId, run.runId, failureResult(run.runId, request, run.startedAt, errorMessage(err))),
  );
  return run.runId;
}

/** Options needed to build a replay request outside of a run (e.g. Copy as cURL). */
export function buildRequestFor(
  draft: Draft,
  entry: RequestEntry,
  options: ResolvedSendOptions,
  settings: Settings,
  runId: string,
): { request: ReplayRequest; warnings: string[] } {
  return buildReplayRequest(draft, {
    runId,
    mode: options.mode,
    frameId: entry.frameId,
    credentials: options.credentials,
    redirect: options.redirect,
    timeoutMs: options.timeoutMs,
    responseBodyCap: settings.replayResponseCap,
  });
}

/**
 * Build the replay request from the entry's current draft and start a test run.
 * Returns the run id, or throws with a readable message when the request could not be built.
 */
export function sendDraft(bridge: ReqlensBridge, entry: RequestEntry, settings: Settings): string | null {
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) return null;
  // Raw text that does not parse leaves the previous body in the model: never send that stale body.
  if (rawApplies(rec) && rec.raw.error) throw new Error(`the raw body does not parse (${rec.raw.error})`);
  const opts = resolveSendOptions(rec.options, settings, entry);
  const { request } = buildRequestFor(rec.draft, entry, opts, settings, uid('run'));
  return dispatchRun(bridge, entry.id, request);
}

/** Re-send exactly the request of a previous run (fresh run id). */
export function resendRun(bridge: ReqlensBridge, entryId: string, run: TestRun): string | null {
  return dispatchRun(bridge, entryId, { ...run.request, runId: uid('run') });
}

/** Options of {@link runForClaude}. */
export interface ClaudeRunOptions {
  /** Replay mode (default: the draft's / settings' mode). */
  mode?: ReplayMode;
  /** Timeout of this run (default: the draft's / settings' timeout). */
  timeoutMs?: number;
  /** Rewrite the request built from the draft (Claude's overrides); run and entry ids are kept. */
  adjust?: (request: ReplayRequest) => ReplayRequest;
}

/**
 * Run a request on behalf of Claude Code (MCP send_request) through the normal run flow: built from the
 * entry's draft like Send (the user's edits included, the draft itself untouched), optionally adjusted,
 * recorded in the entry's history with `origin: 'claude'`. Resolves with the finished run; rejects when the
 * request cannot be built (no draft, raw body that does not parse).
 */
export function runForClaude(bridge: ReqlensBridge, entry: RequestEntry, settings: Settings, opts: ClaudeRunOptions = {}): Promise<TestRun> {
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) return Promise.reject(new Error(rec.draftError ?? 'the request could not be decomposed'));
  if (rawApplies(rec) && rec.raw.error) return Promise.reject(new Error(`the raw body does not parse (${rec.raw.error})`));
  const options: SendOptions = { ...rec.options };
  if (opts.mode) options.mode = opts.mode;
  if (opts.timeoutMs !== undefined) options.timeoutMs = opts.timeoutMs;
  const built = buildRequestFor(rec.draft, entry, resolveSendOptions(options, settings, entry), settings, uid('run')).request;
  const request = opts.adjust ? { ...opts.adjust(built), runId: built.runId, entryId: built.entryId } : built;
  return new Promise<TestRun>((resolve, reject) => {
    runWaiters.set(request.runId, resolve);
    if (dispatchRun(bridge, entry.id, request, 'claude') === null) {
      runWaiters.delete(request.runId);
      reject(new Error('the request could not be started'));
    }
  });
}

/** Cancel a running run (the bridge aborts it; the run is marked aborted if the bridge does not confirm). */
export function cancelRun(entryId: string, runId: string): void {
  const fl = inflight.get(runId);
  if (!fl) return;
  abortInflight(runId);
  if (fl.cancelTimer === undefined) {
    const startedAt = records.get(entryId)?.runs.find((r) => r.runId === runId)?.startedAt ?? Date.now();
    fl.cancelTimer = setTimeout(() => {
      finishRun(entryId, runId, failureResult(runId, fl.request, startedAt, 'Cancelled', { aborted: true }));
    }, CANCEL_GRACE_MS);
  }
}

export function selectRun(entryId: string, runId: string): void {
  const rec = records.get(entryId);
  if (!rec || rec.activeRunId === runId || !rec.runs.some((r) => r.runId === runId)) return;
  commit(entryId, { activeRunId: runId });
}

/** Clear the run history (runs still in flight are kept and finish normally). */
export function clearRuns(entryId: string): void {
  const rec = records.get(entryId);
  if (!rec || rec.runs.length === 0) return;
  const runs = rec.runs.filter((r) => r.state === 'running');
  const activeRunId = runs.some((r) => r.runId === rec.activeRunId) ? rec.activeRunId : (runs[0]?.runId ?? null);
  commit(entryId, { runs: runs.length ? runs : NO_RUNS, activeRunId });
}

// --------------------------------------------------------------------------------------------- handoff

/** JSON-safe copy of a record (runs travel separately), so a reloaded panel can resume (src/ui/panel/uiState.ts). */
export interface SavedRecord {
  entryId: string;
  draft: Draft | null;
  draftError: string | null;
  options: SendOptions;
  activeRunId: string | null;
  bodyView: BodyView;
  raw: { text: string; error: string | null; pending: boolean; applies: boolean } | null;
}

/** Subscribe to every change of any record (entry id). Returns unsubscribe. */
export function subscribeRecords(fn: (entryId: string) => void): () => void {
  recordListeners.add(fn);
  return () => {
    recordListeners.delete(fn);
  };
}

/** The record of an entry as saved state, or null when it holds nothing a fresh draft would not recreate. */
export function exportRecord(entryId: string): SavedRecord | null {
  const rec = records.get(entryId);
  if (!rec) return null;
  const worth =
    rec.meta.modified || rec.runs.length > 0 || rec.raw !== null || rec.bodyView !== 'fields' || rec.options !== DEFAULT_SEND_OPTIONS;
  if (!worth) return null;
  return {
    entryId: rec.entryId,
    draft: rec.draft,
    draftError: rec.draftError,
    options: rec.options,
    activeRunId: rec.activeRunId,
    bodyView: rec.bodyView,
    raw: rec.raw ? { text: rec.raw.text, error: rec.raw.error, pending: rec.raw.pending, applies: rawApplies(rec) } : null,
  };
}

/** The runs of an entry (newest first; identity changes only when they change), or null when it has none. */
export function exportRuns(entryId: string): TestRun[] | null {
  const runs = records.get(entryId)?.runs;
  return runs && runs.length > 0 ? runs : null;
}

const INTERRUPTED = 'Interrupted: the kineReqLens panel was reloaded while this request was running';

/**
 * Restore saved records and their runs (from a previous panel of this page). Runs that were in flight are
 * marked aborted.
 */
export function importRecords(saved: unknown[], savedRuns: Record<string, unknown> = {}): void {
  for (const item of saved) {
    if (!item || typeof item !== 'object') continue;
    const s = item as SavedRecord;
    if (typeof s.entryId !== 'string' || records.has(s.entryId)) continue;
    const stored = savedRuns[s.entryId];
    const runs = (Array.isArray(stored) ? (stored as TestRun[]) : []).map((run): TestRun =>
      run.state === 'running'
        ? {
            ...run,
            state: 'aborted',
            result: failureResult(run.runId, run.request, run.startedAt, INTERRUPTED, { aborted: true }),
          }
        : run,
    );
    const draft = s.draft && typeof s.draft === 'object' ? s.draft : null;
    const raw: RawEdit | null =
      s.raw && draft
        ? { text: s.raw.text, error: s.raw.error, pending: false, body: s.raw.applies ? draft.body : { type: 'none' } }
        : null;
    const rec: EntryRecord = {
      entryId: s.entryId,
      draft,
      draftError: typeof s.draftError === 'string' ? s.draftError : null,
      options: s.options && typeof s.options === 'object' ? s.options : DEFAULT_SEND_OPTIONS,
      runs: runs.length ? runs.slice(0, MAX_RUNS_PER_ENTRY) : NO_RUNS,
      activeRunId: typeof s.activeRunId === 'string' ? s.activeRunId : null,
      bodyView: s.bodyView === 'raw' ? 'raw' : 'fields',
      raw,
      meta: computeMeta(EMPTY_META, draft, runs),
    };
    records.set(s.entryId, rec);
    emit(s.entryId, true);
  }
}

// --------------------------------------------------------------------------------------------- hooks

function subscribeEntry(entryId: string, fn: () => void): () => void {
  let set = entryListeners.get(entryId);
  if (!set) {
    set = new Set();
    entryListeners.set(entryId, set);
  }
  set.add(fn);
  return () => {
    const s = entryListeners.get(entryId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) entryListeners.delete(entryId);
  };
}

/** Re-render when `read()` (an identity-stable store selector for one entry) returns something new. */
function useEntrySubscription<T>(entryId: string, read: () => T): T {
  const value = read();
  const [, setTick] = useState(0);
  const latest = useRef(value);
  latest.current = value;
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    const check = () => {
      if (readRef.current() !== latest.current) setTick((t) => t + 1);
    };
    const off = subscribeEntry(entryId, check);
    check();
    return off;
  }, [entryId]);
  return value;
}

/** Preact hook: the entry's record (draft created lazily), re-rendering on any change to it. */
export function useEntryRecord(entry: RequestEntry): EntryRecord {
  const rec = ensureRecord(entry);
  const id = entry.id;
  return useEntrySubscription(id, () => records.get(id) ?? rec);
}

/** Preact hook: [draft, update]. `update` is stable for the entry and applies edits to the latest draft. */
export function useDraft(entry: RequestEntry): [Draft | null, DraftUpdater] {
  const rec = useEntryRecord(entry);
  const id = entry.id;
  const update = useCallback<DraftUpdater>((fn) => updateDraft(id, fn), [id]);
  return [rec.draft, update];
}
