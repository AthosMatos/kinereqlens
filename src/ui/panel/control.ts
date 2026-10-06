// Panel side of the Claude Code control plane (src/shared/control-protocol.ts): the worker's `control` queries over the
// panel link (claudeLink.ts answerQuery), executed against the same module stores the overlay's own controls use —
// draft store, shell selection, panel view, list filter, "Remove from list", the WebSocket mirror, the Errors view
// store, the screenshot / Find in page handlers (src/ui/control/shot.ts). The panel may be headless (overlay closed
// or open in the background): nothing here needs it rendered or visible. Answers are raw data; the worker redacts
// and formats them.
import type {
  PanelControlOp,
  PanelDraftResult,
  PanelErrorGroup,
  PanelErrorRun,
  PanelErrorShot,
  PanelErrorsResult,
  PanelRunsResult,
  PanelScreenshotResult,
  PanelStateResult,
  PanelWsConnection,
  PanelWsFrame,
  PanelWsMessagesResult,
} from '../../shared/control-protocol';
import type { ReplayRequest, ReqlensBridge, RequestEntry, TestRun } from '../../shared/types';
import { createDraft } from '../../lib/draft';
import { DraftEditError, applyDraftEdits } from '../../lib/draftEdits';
import { uid } from '../../lib/ids';
import { buildFixPrompt, buildIssue } from '../../lib/errorPrompt';
import type { WsFrame } from '../../lib/ws';
import { base64HeadHex, filterFrames, parseWsFilter, payloadJson, payloadText } from '../../lib/ws-inspector';
import { runFindCommand, runShotCommand } from '../control/shot';
import { blockingErrorsOf, warningsOf } from '../detail/derived';
import {
  buildRequestFor,
  cancelRun,
  clearRuns,
  ensureRecord,
  entriesWithWork,
  flushRawParse,
  getEntryMeta,
  getRecord,
  pruneDrafts,
  rawApplies,
  resolveSendOptions,
  runForClaude,
  selectRun,
  setSendOptions,
  updateDraft,
} from '../detail/draftStore';
import type { SendOptions } from '../detail/draftStore';
import { requestResultsTab } from '../detail/resultsTab';
import { componentBridgeOf, initiatorAnalysisOf } from '../detail/initiatorState';
import { setExportPrefs } from '../export/prefs';
import { analyzeGroup, captureForGroup, contextForGroup, pageHostOf, projectFolderOf, shotBase64 } from '../errors/automation';
import { groupErrors, filterGroups } from '../errors/model';
import type { ErrorGroup } from '../errors/model';
import { requestErrorsAction } from '../errors/requests';
import { autoShotOf, cancelRun as cancelErrorRun, latestAnalysis, onRunDone, runningCount, runsOf, shotsOf, startRun, storedAnalysis } from '../errors/store';
import type { RunRecord } from '../errors/store';
import { searchSources } from '../find/source';
import { getListFilterText, setListFilterText } from '../list/RequestList';
import { getRemovedEntries, removeFromList, restoreToList } from '../list/listState';
import { duplicateEntry } from '../list/rowActions';
import { saveBase64 } from '../screenshot/sendClient';
import { controlHost } from '../screenshot/open';
import { getShellState, requestShellSelection } from '../shellState';
import { isTerminalPaneOpen } from '../terminal/session';
import { wsInspectorOf } from '../ws/store';
import { getPanelView, setPanelView } from '../ws/ViewSwitch';
import { tabLanguageOverride } from '../language/client';
import { clipRunsForLink } from './claudeLink';

/** Payload characters of one WebSocket message in a list (one message in full: FRAME_FULL_CHARS). */
const FRAME_LIST_CHARS = 2000;
const FRAME_FULL_CHARS = 200_000;
const ERROR_LOG_LINES = 12;
/** Newest error-area screenshots returned as images. */
const ERROR_SHOTS_INLINE = 2;
/** How long a command waits for a just-mounted panel's App to register its page connection. */
const HOST_WAIT_MS = 5000;
/** Images returned to Claude stay well inside one answer (≤ 15 M chars) and an MCP image (≤ 5 MB). */
const INLINE_IMAGE_CHARS = 4_000_000;

function entryOf(bridge: ReqlensBridge, entryId: string): RequestEntry {
  const entry = bridge.getEntries().find((e) => e.id === entryId);
  if (!entry) throw new Error(`No request with id "${entryId}" in this tab (ids come from list_requests; the list may have been cleared)`);
  return entry;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------------------------------------ state / drafts

function stateOf(bridge: ReqlensBridge): PanelStateResult {
  let runningRuns = 0;
  const work = entriesWithWork().map((id) => {
    const meta = getEntryMeta(id);
    for (const run of getRecord(id)?.runs ?? []) if (run.state === 'running') runningRuns++;
    return { id, modified: meta.modified, runs: meta.runs };
  });
  return {
    view: getPanelView(),
    selectedId: getShellState().selectedId,
    textFilter: getListFilterText(),
    removedIds: [...getRemovedEntries()].slice(0, 500),
    entryCount: bridge.getEntries().length,
    work,
    runningRuns,
    claudeRuns: runningCount(),
    terminalOpen: isTerminalPaneOpen(),
  };
}

/** The entry's draft, its send options and the request Send would send now. */
function draftResult(bridge: ReqlensBridge, entry: RequestEntry, applied?: string[]): PanelDraftResult {
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) throw new Error(`This request cannot be edited${rec.draftError ? `: ${rec.draftError}` : ''}`);
  const settings = bridge.getSettings();
  const options = resolveSendOptions(rec.options, settings, entry);
  let request: ReplayRequest | null = null;
  let buildError: string | undefined;
  try {
    request = buildRequestFor(rec.draft, entry, options, settings, 'claude-view').request;
  } catch (err) {
    buildError = errorText(err);
  }
  const rawError = rawApplies(rec) && rec.raw.error ? rec.raw.error : undefined;
  const warnings = warningsOf(rec.draft, options.mode).map((w) => w.message);
  if (buildError) warnings.unshift(`The request cannot be built: ${buildError}`);
  const result: PanelDraftResult = {
    entryId: entry.id,
    draft: rec.draft,
    modified: rec.meta.modified,
    options: { mode: options.mode, credentials: options.credentials, credentialsAuto: options.credentialsAuto, redirect: options.redirect, timeoutMs: options.timeoutMs },
    request,
    warnings,
    blocking: blockingErrorsOf(rec.draft, options.mode) + (rawError ? 1 : 0),
  };
  if (rawError) result.rawError = rawError;
  if (applied) result.applied = applied;
  return result;
}

function edit(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'edit' }>): PanelDraftResult {
  const entry = entryOf(bridge, op.entryId);
  flushRawParse(entry.id);
  const rec = ensureRecord(entry);
  if (!rec.draft) throw new Error(`This request cannot be edited${rec.draftError ? `: ${rec.draftError}` : ''}`);
  let outcome: ReturnType<typeof applyDraftEdits>;
  try {
    outcome = applyDraftEdits(rec.draft, op.edit);
  } catch (err) {
    if (err instanceof DraftEditError) throw new Error(`Nothing was changed: ${err.message}`);
    throw err;
  }
  updateDraft(entry.id, () => outcome.draft);
  const applied = [...outcome.applied];
  const options = op.edit.options;
  if (options) {
    const patch: Partial<SendOptions> = {};
    if (options.mode !== undefined) patch.mode = options.mode;
    if (options.credentials !== undefined) patch.credentials = options.credentials === 'auto' ? undefined : options.credentials;
    if (options.redirect !== undefined) patch.redirect = options.redirect;
    if (options.timeoutMs !== undefined) patch.timeoutMs = options.timeoutMs === 'default' ? undefined : options.timeoutMs;
    setSendOptions(entry.id, patch);
    applied.push('send options');
  }
  return draftResult(bridge, entry, applied);
}

function runsResult(entryId: string): PanelRunsResult {
  const rec = getRecord(entryId);
  return { entryId, runs: clipRunsForLink(rec?.runs ?? []), activeRunId: rec?.activeRunId ?? null };
}

/** Resend: a previous run's exact request, else the captured request unchanged; waits for the run. */
async function resend(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'resend' }>): Promise<{ run: TestRun }> {
  const entry = entryOf(bridge, op.entryId);
  const settings = bridge.getSettings();
  let source: ReplayRequest;
  if (op.runId) {
    const run = getRecord(entry.id)?.runs.find((r) => r.runId === op.runId);
    if (!run) throw new Error(`No run "${op.runId}" for this request (see get_request with includeRuns)`);
    source = run.request;
  } else {
    const rec = ensureRecord(entry);
    source = buildRequestFor(createDraft(entry), entry, resolveSendOptions(rec.options, settings, entry), settings, uid('run')).request;
  }
  const run = await runForClaude(bridge, entry, settings, { timeoutMs: op.timeoutMs, adjust: () => source });
  return { run: clipRunsForLink([run])[0]! };
}

// ------------------------------------------------------------------------------------------------ WebSocket

function wsOf(bridge: ReqlensBridge) {
  if (!bridge.ws) throw new Error('WebSocket inspection is not available on this page');
  return wsInspectorOf(bridge.ws);
}

function wsConnections(bridge: ReqlensBridge, wsId?: string): PanelWsConnection[] {
  const inspector = wsOf(bridge);
  const list = inspector.connections().filter((c) => !wsId || c.wsId === wsId);
  if (wsId && !list.length) throw new Error(`No WebSocket connection "${wsId}" (see inspect websocket)`);
  return list
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((c) => {
      const conn: PanelWsConnection = {
        wsId: c.wsId,
        url: c.url,
        frameId: c.frameId,
        state: c.state,
        protocol: c.protocol,
        detected: inspector.protocolOf(c.wsId),
        createdAt: c.createdAt,
        sent: c.sent,
        received: c.received,
        kept: inspector.frames(c.wsId).length,
        heartbeats: inspector.heartbeatCount(c.wsId),
        channels: inspector.channels(c.wsId).map((s) => ({ key: s.key, kind: s.kind, heartbeat: s.heartbeat, sent: s.sent, received: s.received, count: s.count, lastTime: s.lastTime })),
      };
      if (c.closedAt !== undefined) conn.closedAt = c.closedAt;
      if (c.closeCode !== undefined) conn.closeCode = c.closeCode;
      if (c.closeReason) conn.closeReason = c.closeReason;
      return conn;
    });
}

function frameOut(frame: WsFrame, inspector: ReturnType<typeof wsOf>, full: boolean): PanelWsFrame {
  const cls = inspector.info(frame);
  const binary = frame.opcode === 'binary' || frame.text === undefined;
  const max = full ? FRAME_FULL_CHARS : FRAME_LIST_CHARS;
  let text = binary ? (frame.base64 ? base64HeadHex(frame.base64, full ? 256 : 16) : '') : payloadText(frame, cls);
  const textClipped = text.length > max;
  if (textClipped) text = text.slice(0, max);
  const out: PanelWsFrame = {
    id: frame.id,
    dir: frame.dir === 'out' ? 'out' : 'in',
    time: frame.time,
    opcode: frame.opcode,
    size: frame.size,
    truncated: frame.truncated,
    channel: cls.channel,
    heartbeat: cls.heartbeat === true,
    text,
    textClipped,
    binary,
  };
  if (cls.event) out.event = cls.event;
  if (full && !binary && !textClipped) {
    const value = payloadJson(frame, cls);
    if (value !== undefined) out.json = value;
  }
  return out;
}

function wsMessages(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'ws_messages' }>): PanelWsMessagesResult {
  const inspector = wsOf(bridge);
  const connections = inspector.connections();
  const conn = op.wsId ? connections.find((c) => c.wsId === op.wsId) : connections.slice().sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (!conn) throw new Error(op.wsId ? `No WebSocket connection "${op.wsId}" (see inspect websocket)` : 'No WebSocket connection was captured on this page');
  const frames = inspector.frames(conn.wsId);
  if (op.frameId !== undefined) {
    const frame = frames.find((f) => f.id === op.frameId);
    if (!frame) throw new Error(`No message ${op.frameId} in ${conn.wsId} (it may have been dropped: the log keeps the newest messages)`);
    return { wsId: conn.wsId, url: conn.url, total: frames.length, frames: [], more: false, frame: frameOut(frame, inspector, true) };
  }
  const parsed = parseWsFilter(op.filter ?? '');
  const filtered = filterFrames(
    frames,
    (frame) => inspector.info(frame),
    { text: op.filter ?? '', dir: op.direction ?? 'all', heartbeats: op.heartbeats === true, channel: op.channel ?? null },
    parsed,
  );
  const older = op.before !== undefined ? filtered.filter((f) => f.id < op.before!) : filtered;
  const limit = op.limit ?? 50;
  const page = older.slice(Math.max(0, older.length - limit)).reverse();
  const result: PanelWsMessagesResult = {
    wsId: conn.wsId,
    url: conn.url,
    total: filtered.length,
    frames: page.map((f) => frameOut(f, inspector, false)),
    more: older.length > page.length,
  };
  if (parsed.type === 'invalid') result.filterError = parsed.error;
  return result;
}

// ------------------------------------------------------------------------------------------------ errors

function groupOut(group: ErrorGroup): PanelErrorGroup {
  const runs = runsOf(group.key);
  const out: PanelErrorGroup = {
    key: group.key,
    method: group.method,
    endpoint: group.endpoint,
    kind: group.kind,
    kinds: group.kinds,
    count: group.count,
    statuses: group.statuses,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    entryIds: group.entryIds.slice(0, 20),
    shots: shotsOf(group.key).length,
    running: runs.some((r) => r.state === 'running'),
    hasAnalysis: latestAnalysis(group.key) !== null,
  };
  if (group.lastStatus !== undefined) out.lastStatus = group.lastStatus;
  return out;
}

function runOut(run: RunRecord): PanelErrorRun {
  const log = run.log.slice(-ERROR_LOG_LINES).map((line) => (line.type === 'tool' ? `[${line.name}] ${line.summary}` : line.type === 'note' ? `(${line.text})` : line.text.slice(-1500)));
  const out: PanelErrorRun = { id: run.id, kind: run.kind, state: run.state, auto: run.auto, startedAt: run.startedAt, analysis: run.analysis, log };
  if (run.endedAt !== undefined) out.endedAt = run.endedAt;
  if (run.error) out.error = run.error;
  if (run.result?.costUsd !== undefined) out.costUsd = run.result.costUsd;
  if (run.worktree) out.worktree = run.worktree;
  if (run.diff) out.diffStat = run.diff.stat;
  if (run.committed) out.committed = run.committed;
  if (run.prUrl) out.prUrl = run.prUrl;
  if (run.discarded) out.discarded = true;
  return out;
}

function groupsOf(bridge: ReqlensBridge): ErrorGroup[] {
  return groupErrors(bridge.getEntries());
}

function groupFor(bridge: ReqlensBridge, key: string): { group: ErrorGroup; entry: RequestEntry } {
  const group = groupsOf(bridge).find((g) => g.key === key);
  if (!group) throw new Error(`No failing endpoint "${key}" on this page (keys come from inspect errors)`);
  return { group, entry: entryOf(bridge, group.entryIds[0]!) };
}

async function errors(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'errors' }>): Promise<PanelErrorsResult> {
  const settings = bridge.getSettings();
  const all = groupsOf(bridge);
  const host = pageHostOf(bridge, null);
  const result: PanelErrorsResult = {
    groups: filterGroups(all, op.filter ?? 'all').map(groupOut),
    fullMode: settings.errorsFullMode === true,
    folder: projectFolderOf(settings, host),
    host,
  };
  if (!op.key) return result;
  const { group, entry } = groupFor(bridge, op.key);
  const stored = storedAnalysis(group.key);
  const shots: PanelErrorShot[] = [];
  const list = shotsOf(group.key);
  for (let i = 0; i < list.length; i++) {
    const shot = list[i]!;
    const out: PanelErrorShot = { id: shot.id, createdAt: shot.createdAt, auto: shot.auto, width: shot.width, height: shot.height };
    if (shot.component) out.component = shot.component;
    if (op.shots && i < ERROR_SHOTS_INLINE) {
      const data = await shotBase64(shot).catch(() => null);
      if (data && data.length <= INLINE_IMAGE_CHARS) out.data = data;
    }
    shots.push(out);
  }
  const analysis = latestAnalysis(group.key);
  const detail: NonNullable<PanelErrorsResult['detail']> = {
    group: groupOut(group),
    runs: runsOf(group.key).map(runOut),
    analysis,
    shots,
    autoShot: autoShotOf(group.key),
  };
  if (stored) detail.storedAt = stored.at;
  try {
    const ctx = await contextForGroup(group, entry, settings);
    const issue = buildIssue(ctx, analysis);
    detail.issue = { title: issue.title, body: issue.body };
  } catch {
    /* no issue draft */
  }
  result.detail = detail;
  return result;
}

function folderFor(bridge: ReqlensBridge, entry: RequestEntry): string {
  const folder = projectFolderOf(bridge.getSettings(), pageHostOf(bridge, entry));
  if (!folder) throw new Error('No project folder is set for this site. The user chooses it in the Errors view (Claude cannot set it).');
  return folder;
}

function waitForRun(id: string, waitMs: number): Promise<RunRecord | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, waitMs);
    const off = onRunDone((run) => {
      if (run.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(run);
    });
  });
}

async function errorsAnalyze(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'errors_analyze' }>): Promise<{ run: PanelErrorRun | null; started: boolean }> {
  const { group, entry } = groupFor(bridge, op.key);
  const folder = folderFor(bridge, entry);
  if (runsOf(group.key).some((r) => r.state === 'running')) throw new Error('A Claude run is already in progress for this endpoint');
  const started = await analyzeGroup(group, entry, bridge.getSettings(), folder);
  if (!started.ok) throw new Error(started.error);
  const run = runsOf(group.key)[0];
  if (!run) return { run: null, started: true };
  if (op.waitMs > 0) {
    const done = await waitForRun(run.id, op.waitMs);
    return { run: runOut(done ?? run), started: true };
  }
  return { run: runOut(run), started: true };
}

async function errorsFix(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'errors_fix' }>): Promise<{ run: PanelErrorRun | null }> {
  if (bridge.getSettings().errorsFullMode !== true) throw new Error('Fixes need the Errors view full mode (Settings → Claude Code → Errors view → Full mode, which only the user can turn on)');
  const { group, entry } = groupFor(bridge, op.key);
  const folder = folderFor(bridge, entry);
  if (runsOf(group.key).some((r) => r.state === 'running')) throw new Error('A Claude run is already in progress for this endpoint');
  const settings = bridge.getSettings();
  const analysis = latestAnalysis(group.key);
  const ctx = await contextForGroup(group, entry, settings);
  const shot = shotsOf(group.key)[0];
  const image = shot ? await shotBase64(shot).catch(() => null) : null;
  const started = startRun({ key: group.key, kind: 'fix', cwd: folder, prompt: buildFixPrompt(ctx, analysis), slug: analysis?.title || group.template, ...(image ? { image } : {}), wantPr: op.pr });
  if (!started.ok) throw new Error(started.error);
  // "Try fix + PR": the pull request dialog opens in the Errors view once the diff is in (the user confirms it).
  if (op.pr) {
    setPanelView('errors');
    requestErrorsAction({ key: group.key });
  }
  return { run: runOut(started.run) };
}

function errorsDialog(bridge: ReqlensBridge, op: Extract<PanelControlOp, { op: 'errors_dialog' }>): { opened: string } {
  const settings = bridge.getSettings();
  if (settings.errorsFullMode !== true) throw new Error('Issues, commits, pull requests and discards need the Errors view full mode (only the user can turn it on)');
  const { group, entry } = groupFor(bridge, op.key);
  folderFor(bridge, entry);
  if (op.dialog !== 'issue' && !runsOf(group.key).some((r) => r.kind === 'fix' && r.worktree && !r.discarded)) {
    throw new Error('There is no fix worktree for this endpoint — run errors fix first');
  }
  setPanelView('errors');
  requestErrorsAction({ key: group.key, dialog: op.dialog });
  return { opened: op.dialog };
}

// ------------------------------------------------------------------------------------------------ screenshots

/** A panel just mounted for the command registers its page connection when the App's effects run: wait for it. */
async function waitForControlHost(timeoutMs = HOST_WAIT_MS): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!controlHost() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function screenshot(op: Extract<PanelControlOp, { op: 'screenshot' }>): Promise<{ result: PanelScreenshotResult; preview: { data: string; mimeType: string; width: number; height: number } }> {
  await waitForControlHost();
  const shot = await runShotCommand(op.args);
  const { data, ...imageMeta } = shot.image;
  const result: PanelScreenshotResult = { ...shot, image: imageMeta };
  delete (result as { preview?: unknown }).preview;
  if (op.save) {
    if (shot.image.mimeType !== 'image/png') result.saveError = 'only PNG images are saved';
    else {
      const name = `kinereqlens-${Date.now()}.png`;
      const saved = await saveBase64(data, name);
      if (saved.ok) {
        result.path = saved.path;
        result.bytes = saved.bytes;
      } else result.saveError = saved.error;
    }
  }
  return { result, preview: { data: shot.preview.data, mimeType: shot.preview.mimeType, width: shot.preview.width, height: shot.preview.height } };
}

// ------------------------------------------------------------------------------------------------ dispatcher

/** Run one control op (the worker validated its arguments). Rejects with a message for Claude. */
export async function runPanelControl(op: PanelControlOp, bridge: ReqlensBridge | null): Promise<unknown> {
  if (!bridge) throw new Error('This kineReqLens window cannot run commands');
  switch (op.op) {
    case 'state':
      return stateOf(bridge);
    case 'select': {
      if (op.entryId === null) {
        requestShellSelection(null);
        return { selected: null };
      }
      const entry = entryOf(bridge, op.entryId);
      setPanelView('http');
      requestShellSelection(entry.id);
      return { selected: entry.id, method: entry.method, url: entry.url };
    }
    case 'view': {
      setPanelView(op.view);
      const target = op.entryId ?? getShellState().selectedId;
      if (op.entryId) {
        entryOf(bridge, op.entryId);
        requestShellSelection(op.entryId);
      }
      if (op.resultsTab) {
        if (!target) throw new Error('No request is selected: pass requestId to show a results tab');
        requestResultsTab(target, op.resultsTab);
      }
      if (op.exportTab) setExportPrefs({ view: op.exportTab });
      return { view: op.view, selected: target };
    }
    case 'highlight': {
      const entry = entryOf(bridge, op.entryId);
      const analysis = await initiatorAnalysisOf(entry).catch(() => null);
      const names = analysis?.componentNames ?? [];
      if (!names.length) throw new Error('No UI component is known for this request (no call stack, or no component in it)');
      const locate = componentBridgeOf(bridge).locateComponents;
      if (!locate) throw new Error('Component lookup is not available here');
      const found = await locate.call(bridge, { names: [...names], scroll: true, highlight: true });
      return { names, result: found };
    }
    case 'clear':
      bridge.clearEntries();
      pruneDrafts(new Set());
      restoreToList();
      requestShellSelection(null);
      return { cleared: true };
    case 'new': {
      const entry = bridge.addManualEntry(op.init);
      if (op.select) {
        setPanelView('http');
        requestShellSelection(entry.id);
      }
      return { id: entry.id, method: entry.method, url: entry.url };
    }
    case 'duplicate': {
      const entry = entryOf(bridge, op.entryId);
      const id = duplicateEntry(bridge, entry, bridge.getSettings());
      if (!id) throw new Error('The request could not be duplicated (it cannot be built: see edit_request / get_request)');
      if (op.select) {
        setPanelView('http');
        requestShellSelection(id);
      }
      return { id };
    }
    case 'remove':
      for (const id of op.entryIds) entryOf(bridge, id);
      removeFromList(op.entryIds);
      return { removed: op.entryIds.length, total: getRemovedEntries().size };
    case 'restore':
      restoreToList(op.entryIds);
      return { total: getRemovedEntries().size };
    case 'resend':
      return resend(bridge, op);
    case 'cancel': {
      entryOf(bridge, op.entryId);
      const running = (getRecord(op.entryId)?.runs ?? []).filter((r) => r.state === 'running' && (!op.runId || r.runId === op.runId));
      for (const run of running) cancelRun(op.entryId, run.runId);
      return { cancelled: running.map((r) => r.runId) };
    }
    case 'select_run': {
      entryOf(bridge, op.entryId);
      if (!(getRecord(op.entryId)?.runs ?? []).some((r) => r.runId === op.runId)) throw new Error(`No run "${op.runId}" for this request`);
      selectRun(op.entryId, op.runId);
      requestResultsTab(op.entryId, 'test');
      return { selected: op.runId };
    }
    case 'clear_runs':
      entryOf(bridge, op.entryId);
      clearRuns(op.entryId);
      return { cleared: true };
    case 'edit':
      return edit(bridge, op);
    case 'request':
      return draftResult(bridge, entryOf(bridge, op.entryId));
    case 'runs':
      entryOf(bridge, op.entryId);
      return runsResult(op.entryId);
    case 'text_filter':
      setListFilterText(op.text);
      return { text: op.text };
    case 'ws_list':
      return { connections: wsConnections(bridge, op.wsId) };
    case 'ws_messages':
      return wsMessages(bridge, op);
    case 'ws_send': {
      if (!bridge.ws) throw new Error('WebSocket inspection is not available on this page');
      const result = await bridge.ws.send(op.wsId, op.text);
      if (!result.ok) throw new Error(result.error ?? 'The message could not be sent');
      return result;
    }
    case 'ws_clear':
      wsOf(bridge);
      bridge.ws!.clear();
      return { cleared: true };
    case 'errors':
      return errors(bridge, op);
    case 'errors_capture': {
      const { group, entry } = groupFor(bridge, op.key);
      const shot = await captureForGroup(bridge, group.key, entry);
      const data = await shotBase64(shot).catch(() => null);
      return { id: shot.id, width: shot.width, height: shot.height, area: shot.area, component: shot.component ?? null, data: data && data.length <= INLINE_IMAGE_CHARS ? data : null };
    }
    case 'errors_analyze':
      return errorsAnalyze(bridge, op);
    case 'errors_cancel': {
      const running = runsOf(op.key).filter((r) => r.state === 'running');
      for (const run of running) cancelErrorRun(run.id);
      return { cancelled: running.map((r) => r.id) };
    }
    case 'errors_fix':
      return errorsFix(bridge, op);
    case 'errors_dialog':
      return errorsDialog(bridge, op);
    case 'source': {
      const locales = [tabLanguageOverride()?.split(',')[0]?.split(';')[0] ?? '', ...(navigator.languages ?? [])].filter(Boolean).slice(0, 3);
      const found = await searchSources(op.texts, locales.length ? locales : ['en-US'], bridge.getEntries(), bridge.ws ? wsInspectorOf(bridge.ws) : null, { aborted: false });
      return found;
    }
    case 'screenshot':
      return screenshot(op);
    case 'find':
      await waitForControlHost();
      return runFindCommand(op.args);
    default:
      throw new Error('Unknown command');
  }
}
