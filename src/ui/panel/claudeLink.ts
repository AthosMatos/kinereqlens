// Panel side of the Claude Code bridge (docs/specs/v0.2.md §B.4, src/shared/claude-link.ts): a chrome.runtime
// Port from this panel page to the service worker, open while settings.claudeBridge is on. It receives the
// bridge status, answers the worker's queries about drafts / runs / selection, runs Claude-initiated sends
// through the draft store (so they show in the history, marked "Claude"), and carries "Send to Claude Code".
// The exported functions are a contract used by the Export tab and Settings (ui-export agent).
import { useEffect, useState } from 'preact/hooks';
import {
  CLAUDE_LINK_PORT_NAME,
  CLAUDE_LINK_VERSION,
  LINK_ENTRY_BUDGET,
  LINK_RUN_BODY_CAP,
  LINK_RUN_REQUEST_BODY_CAP,
} from '../../shared/claude-link';
import type { LinkEntryData, LinkPtyAttached, LinkQuery, LinkState, PanelToWorker, WorkerToPanel } from '../../shared/claude-link';
import type { BridgeHostState, BridgeStatus, FsFromHost, FsToHost, InboxItem, PtyFromHost, PtyToHost } from '../../shared/claude-protocol';
import { isFsMessageType } from '../../shared/fs';
import { isPtyMessageType } from '../../shared/pty';
import type { OpFromHost, OpToHost, RunFromHost, RunToHost } from '../../shared/errors-protocol';
import { isShotMessageType } from '../../shared/shot-protocol';
import type { ShotFromHost, ShotToHost } from '../../shared/shot-protocol';
import { DEFAULT_SETTINGS, SETTINGS_KEY, mergeSettings } from '../../shared/constants';
import type { ReplayRequest, ReqlensBridge, SerializedBody, Settings, SettingsPatch, TestRun } from '../../shared/types';
import { applyOverrides } from '../../background/claude/overrides';
import { toast } from '../components/toast';
import { blockingErrorsOf } from '../detail/derived';
import { ensureRecord, entriesWithWork, getEntryMeta, getRecord, resolveSendOptions, runForClaude } from '../detail/draftStore';
import { getShellState } from '../shellState';
import type { PanelControlOp } from '../../shared/control-protocol';

const NATIVE_PERMISSION: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] };
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;
const PUSH_TIMEOUT_MS = 15_000;
const HOST_STATES: ReadonlySet<string> = new Set<BridgeHostState>(['off', 'connecting', 'connected', 'not-installed', 'error']);

function ownExtensionId(): string {
  try {
    return chrome.runtime.id ?? '';
  } catch {
    return '';
  }
}

function offStatus(permission: boolean): BridgeStatus {
  return { enabled: false, permission, host: 'off', sessions: [], extensionId: ownExtensionId() };
}

// --------------------------------------------------------------------------------------------- status

let status: BridgeStatus = offStatus(false);
const statusListeners = new Set<(status: BridgeStatus) => void>();

function setStatus(next: BridgeStatus): void {
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const fn of [...statusListeners]) {
    try {
      fn(status);
    } catch (err) {
      console.error('[kineReqLens] bridge status listener failed', err);
    }
  }
}

/** Current bridge status (last pushed by the service worker). */
export function getBridgeStatus(): BridgeStatus {
  return status;
}

export function subscribeBridgeStatus(fn: (status: BridgeStatus) => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

/** Preact hook over getBridgeStatus / subscribeBridgeStatus. */
export function useBridgeStatus(): BridgeStatus {
  const [value, setValue] = useState(status);
  useEffect(() => {
    setValue(status);
    return subscribeBridgeStatus(setValue);
  }, []);
  return value;
}

/** Shape check of a status pushed by the worker. */
export function isBridgeStatus(value: unknown): value is BridgeStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<BridgeStatus>;
  return (
    typeof s.enabled === 'boolean' &&
    typeof s.permission === 'boolean' &&
    typeof s.host === 'string' &&
    HOST_STATES.has(s.host) &&
    Array.isArray(s.sessions) &&
    typeof s.extensionId === 'string'
  );
}

// --------------------------------------------------------------------------------------------- permission

let permission = false;

function refreshPermission(): void {
  try {
    void chrome.permissions.contains(NATIVE_PERMISSION).then(
      (granted) => {
        permission = granted;
        if (!port) setStatus({ ...status, permission: granted });
      },
      () => undefined,
    );
  } catch {
    /* context gone */
  }
}

/**
 * Make sure the `nativeMessaging` permission is granted. static/manifest.json lists it as required, so this resolves
 * true at once; it only prompts in a build that makes it optional. MUST be called synchronously from a user gesture
 * (click handler) in the panel. Resolves true when granted (or already granted).
 */
export function requestBridgePermission(): Promise<boolean> {
  let request: Promise<boolean>;
  try {
    // First thing in the gesture: any await before this call would lose the user activation.
    request = chrome.permissions.request(NATIVE_PERMISSION);
  } catch (err) {
    request = Promise.reject(err);
  }
  return request
    .catch(async () => {
      // A required permission (E2E build) cannot be requested, but is granted.
      try {
        return await chrome.permissions.contains(NATIVE_PERMISSION);
      } catch {
        return false;
      }
    })
    .then((granted) => {
      if (granted) {
        permission = true;
        if (!port) setStatus({ ...status, permission: true });
      }
      return granted;
    });
}

// --------------------------------------------------------------------------------------------- terminal

/** What the embedded terminal (src/ui/terminal/) hears: worker events, or the link itself going away. */
export type PtyLinkEvent = PtyFromHost | LinkPtyAttached | { t: 'link-lost' };

const ptyListeners = new Set<(event: PtyLinkEvent) => void>();

function emitPty(event: PtyLinkEvent): void {
  for (const fn of [...ptyListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[kineReqLens] terminal listener failed', err);
    }
  }
}

/** Follow terminal events of this panel. Returns the unsubscribe function. */
export function subscribePty(fn: (event: PtyLinkEvent) => void): () => void {
  ptyListeners.add(fn);
  return () => {
    ptyListeners.delete(fn);
  };
}

/** Send a terminal control message to the worker. False when the link is down. */
export function postPty(message: PtyToHost): boolean {
  return port ? post(port, message) : false;
}

// --------------------------------------------------------------------------------------------- folders

/** What the terminal's folder browser (src/ui/terminal/fsClient.ts) hears: answers, or the link going away. */
export type FsLinkEvent = FsFromHost | { t: 'link-lost' };

const fsListeners = new Set<(event: FsLinkEvent) => void>();

function emitFs(event: FsLinkEvent): void {
  for (const fn of [...fsListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[kineReqLens] folder browser listener failed', err);
    }
  }
}

/** Follow folder browser answers of this panel. Returns the unsubscribe function. */
export function subscribeFs(fn: (event: FsLinkEvent) => void): () => void {
  fsListeners.add(fn);
  return () => {
    fsListeners.delete(fn);
  };
}

/** Send a folder browser request to the worker. False when the link is down. */
export function postFs(message: FsToHost): boolean {
  return port ? post(port, message) : false;
}

// --------------------------------------------------------------------------------------------- errors view runs

/** What the Errors view (src/ui/errors/runClient.ts) hears: run / op answers, or the link going away. */
export type RunLinkEvent = RunFromHost | OpFromHost | { t: 'link-lost' };

const runListeners = new Set<(event: RunLinkEvent) => void>();

function emitRun(event: RunLinkEvent): void {
  for (const fn of [...runListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[kineReqLens] errors view listener failed', err);
    }
  }
}

/** Follow run / op answers of this panel. Returns the unsubscribe function. */
export function subscribeRuns(fn: (event: RunLinkEvent) => void): () => void {
  runListeners.add(fn);
  return () => {
    runListeners.delete(fn);
  };
}

/** Send a run / op request to the worker. False when the link is down. */
export function postRun(message: RunToHost | OpToHost): boolean {
  return port ? post(port, message) : false;
}

// --------------------------------------------------------------------------------------------- screenshots

/** What "Send to Claude" of the screenshot tool (src/ui/screenshot/sendClient.ts) hears: answers, or the link going away. */
export type ShotLinkEvent = ShotFromHost | { t: 'link-lost' };

const shotListeners = new Set<(event: ShotLinkEvent) => void>();

function emitShot(event: ShotLinkEvent): void {
  for (const fn of [...shotListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[kineReqLens] screenshot listener failed', err);
    }
  }
}

/** Follow screenshot save answers of this panel. Returns the unsubscribe function. */
export function subscribeShotLink(fn: (event: ShotLinkEvent) => void): () => void {
  shotListeners.add(fn);
  return () => {
    shotListeners.delete(fn);
  };
}

/** Send a screenshot chunk to the worker. False when the link is down. */
export function postShot(message: ShotToHost): boolean {
  return port ? post(port, message) : false;
}

// --------------------------------------------------------------------------------------------- link

export interface SendToClaudeResult {
  ok: boolean;
  /** Number of Claude Code sessions the item was delivered to. */
  delivered: number;
  error?: string;
}

let started = false;
let linkTabId = -1;
let linkBridge: ReqlensBridge | null = null;
let wanted = false;
let port: chrome.runtime.Port | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let nextPushId = 1;
const pushes = new Map<number, (result: SendToClaudeResult) => void>();

function post(target: chrome.runtime.Port, message: PanelToWorker): boolean {
  try {
    target.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function failPushes(error: string): void {
  for (const resolve of pushes.values()) resolve({ ok: false, delivered: 0, error });
  pushes.clear();
}

function setWanted(next: boolean): void {
  if (next === wanted) return;
  wanted = next;
  if (next) {
    attempt = 0;
    connect();
    return;
  }
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  const old = port;
  port = null;
  if (old) {
    try {
      old.disconnect();
    } catch {
      /* already gone */
    }
  }
  failPushes('The Claude Code bridge was turned off');
  if (old) {
    emitPty({ t: 'link-lost' });
    emitFs({ t: 'link-lost' });
    emitRun({ t: 'link-lost' });
    emitShot({ t: 'link-lost' });
  }
  setStatus(offStatus(permission));
}

function scheduleRetry(): void {
  if (!wanted || retryTimer !== null) return;
  const wait = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt, 10));
  attempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, wait);
}

function connect(): void {
  if (!wanted || port) return;
  let next: chrome.runtime.Port;
  try {
    next = chrome.runtime.connect({ name: CLAUDE_LINK_PORT_NAME });
  } catch (err) {
    // Extension reloaded/removed: the panel keeps working without the bridge.
    if (!/context invalidated/i.test(String((err as Error)?.message ?? err))) scheduleRetry();
    return;
  }
  port = next;
  next.onMessage.addListener((message: unknown) => {
    if (port === next) onMessage(next, message);
  });
  next.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== next) return;
    port = null;
    failPushes('Lost the connection to the kineReqLens service worker');
    // The worker is gone, and with it the native port: the hub killed every terminal.
    emitPty({ t: 'link-lost' });
    emitFs({ t: 'link-lost' });
    emitRun({ t: 'link-lost' });
    emitShot({ t: 'link-lost' });
    if (!wanted) return;
    // The worker restarted (or is restarting): it pushes a fresh status once the link is back.
    setStatus({ ...status, host: status.enabled && status.permission ? 'connecting' : 'off', sessions: [] });
    scheduleRetry();
  });
  post(next, { t: 'hello', v: CLAUDE_LINK_VERSION, tabId: linkTabId });
}

function onMessage(from: chrome.runtime.Port, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as WorkerToPanel;
  if (isPtyMessageType(message.t)) {
    emitPty(message as PtyFromHost | LinkPtyAttached);
    return;
  }
  if (isFsMessageType(message.t)) {
    emitFs(message as FsFromHost);
    return;
  }
  if (typeof message.t === 'string' && (message.t.startsWith('run-') || message.t.startsWith('op-'))) {
    emitRun(message as RunFromHost | OpFromHost);
    return;
  }
  if (isShotMessageType(message.t)) {
    emitShot(message as ShotFromHost);
    return;
  }
  switch (message.t) {
    case 'status':
      if (!isBridgeStatus(message.status)) return;
      attempt = 0;
      permission = message.status.permission;
      setStatus(message.status);
      return;
    case 'query':
      if (typeof message.id !== 'number' || !message.query || typeof message.query !== 'object') return;
      answerQuery(message.query).then(
        (result) => post(from, { t: 'res', id: message.id, ok: true, result }),
        (err: unknown) => post(from, { t: 'res', id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    case 'push-result': {
      const resolve = pushes.get(message.id);
      if (!resolve) return;
      pushes.delete(message.id);
      const result: SendToClaudeResult = { ok: message.ok === true, delivered: typeof message.delivered === 'number' ? message.delivered : 0 };
      if (typeof message.error === 'string') result.error = message.error;
      resolve(result);
      return;
    }
  }
}

/** Why "Send to Claude Code" cannot work right now (null when it can be tried). */
function unavailableReason(): string | null {
  if (!status.enabled) return 'The Claude Code bridge is off — enable it in Settings → Claude Code';
  if (!status.permission) return 'Allow the native messaging permission in Settings → Claude Code';
  switch (status.host) {
    case 'connected':
      return status.sessions.length > 0 ? null : 'No Claude Code session is connected — start `claude` in your project';
    case 'connecting':
      return 'Still connecting to Claude Code — try again in a moment';
    case 'not-installed':
      return status.error ?? 'The kineReqLens bridge is not installed — see Settings → Claude Code';
    default:
      return status.error ?? 'The Claude Code bridge is not connected';
  }
}

/** Push an item to Claude Code (one session when `sessionId` is set, else every connected session). */
export function sendToClaude(item: Omit<InboxItem, 'id' | 'sentAt' | 'tabId'>): Promise<SendToClaudeResult> {
  const reason = unavailableReason();
  const target = port;
  if (reason || !target) return Promise.resolve({ ok: false, delivered: 0, error: reason ?? 'The Claude Code bridge is not connected' });
  const id = nextPushId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pushes.delete(id)) resolve({ ok: false, delivered: 0, error: 'Claude Code did not answer in time' });
    }, PUSH_TIMEOUT_MS);
    pushes.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    if (!post(target, { t: 'push', id, item })) {
      pushes.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, delivered: 0, error: 'Lost the connection to the kineReqLens service worker' });
    }
  });
}

// --------------------------------------------------------------------------------------------- queries

function linkState(): LinkState {
  return {
    selectedId: getShellState().selectedId,
    work: entriesWithWork().map((id) => {
      const meta = getEntryMeta(id);
      return { id, modified: meta.modified, runs: meta.runs };
    }),
  };
}

function bodyChars(body: SerializedBody | null | undefined): number {
  if (!body) return 0;
  if (body.kind === 'text') return body.text.length;
  if (body.kind === 'base64') return body.base64.length;
  return 0;
}

function clipBody(body: SerializedBody | null, max: number): SerializedBody | null {
  if (!body) return body;
  if (max <= 0 && bodyChars(body) > 0) return { kind: 'unavailable', reason: 'Not handed to Claude (the runs are too large)' };
  if (body.kind === 'text' && body.text.length > max) return { ...body, text: body.text.slice(0, max), truncated: true };
  if (body.kind === 'base64' && body.base64.length > max) return { ...body, base64: body.base64.slice(0, max - (max % 4)), truncated: true };
  return body;
}

function lightRequest(request: ReplayRequest): ReplayRequest {
  const size = request.body.kind === 'text' ? request.body.text.length : request.body.kind === 'base64' ? request.body.base64.length : 0;
  return size > LINK_RUN_REQUEST_BODY_CAP ? { ...request, body: { kind: 'none' } } : request;
}

/** Runs as handed to the worker: request bodies dropped when large, response bodies clipped within a budget. */
export function clipRunsForLink(runs: readonly TestRun[], budget = LINK_ENTRY_BUDGET): TestRun[] {
  let left = budget;
  return runs.map((run) => {
    const request = lightRequest(run.request);
    if (!run.result) return request === run.request ? run : { ...run, request };
    const body = clipBody(run.result.body, Math.min(LINK_RUN_BODY_CAP, left));
    left -= bodyChars(body);
    return { ...run, request, result: { ...run.result, body } };
  });
}

function linkEntry(entryId: string): LinkEntryData {
  const rec = getRecord(entryId);
  return { draft: rec?.meta.modified ? rec.draft : null, runs: clipRunsForLink(rec?.runs ?? []) };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

async function sendForClaude(query: Extract<LinkQuery, { kind: 'send' }>): Promise<{ run: TestRun }> {
  const bridge = linkBridge;
  if (!bridge) throw new Error('This overlay cannot send requests for Claude');
  const entry = bridge.getEntries().find((e) => e.id === query.entryId);
  if (!entry) throw new Error(`No request with id "${query.entryId}" in the overlay (ids come from list_requests)`);
  const settings = bridge.getSettings();
  const rec = ensureRecord(entry);
  if (rec.draft && query.overrides?.body === undefined) {
    const options = query.mode ? { ...rec.options, mode: query.mode } : rec.options;
    const errors = blockingErrorsOf(rec.draft, resolveSendOptions(options, settings, entry).mode);
    if (errors > 0) throw new Error(`The user's edited version of this request has ${errors} error(s) that block sending`);
  }
  let sent: ReplayRequest | null = null;
  const pending = runForClaude(bridge, entry, settings, {
    ...(query.mode ? { mode: query.mode } : {}),
    timeoutMs: query.timeoutMs,
    adjust: (request) => (sent = applyOverrides(request, query.overrides)),
  });
  const request = sent as ReplayRequest | null;
  if (request) toast(`Claude sent ${request.method} ${pathOf(request.url)}`, 'info');
  const run = await pending;
  return { run: clipRunsForLink([run])[0]! };
}

type ControlHandler = (op: PanelControlOp, bridge: ReqlensBridge | null) => Promise<unknown>;
let controlHandler: ControlHandler | null = null;

/** The handler of the worker's control queries (src/ui/panel/control.ts runPanelControl; the overlay panel only). */
export function setControlHandler(handler: ControlHandler | null): void {
  controlHandler = handler;
}

/** Answer one worker query. */
export function answerQuery(query: LinkQuery): Promise<unknown> {
  try {
    switch (query.kind) {
      case 'state':
        return Promise.resolve(linkState());
      case 'entry':
        return Promise.resolve(linkEntry(String(query.entryId)));
      case 'send':
        return sendForClaude(query);
      case 'control':
        // Control-plane ops (src/ui/panel/control.ts, registered by panel/main.tsx).
        if (!controlHandler) return Promise.reject(new Error('This kineReqLens window cannot run commands'));
        return controlHandler(query.op, linkBridge);
      default:
        return Promise.reject(new Error('Unknown query'));
    }
  } catch (err) {
    return Promise.reject(err);
  }
}

// --------------------------------------------------------------------------------------------- start

function settingsFrom(value: unknown): Settings {
  return mergeSettings(DEFAULT_SETTINGS, value && typeof value === 'object' ? (value as SettingsPatch) : null);
}

/** Follow settings.claudeBridge: from the panel's bridge when given, else from chrome.storage.local. */
function watchBridgeSetting(bridge: ReqlensBridge | null, onChange: (enabled: boolean) => void): void {
  if (bridge) {
    onChange(bridge.getSettings().claudeBridge === true);
    bridge.subscribeSettings((settings) => onChange(settings.claudeBridge === true));
    return;
  }
  try {
    void chrome.storage.local.get(SETTINGS_KEY).then(
      (items) => onChange(settingsFrom(items[SETTINGS_KEY]).claudeBridge === true),
      () => undefined,
    );
    chrome.storage.onChanged.addListener((changes, areaName) => {
      const change = areaName === 'local' ? changes[SETTINGS_KEY] : undefined;
      if (change) onChange(settingsFrom(change.newValue).claudeBridge === true);
    });
  } catch {
    /* context gone */
  }
}

/**
 * Start the link (called once from src/ui/panel/main.tsx after the panel is connected to its tab). `bridge`
 * (the panel's RemoteBridge) lets the link run Claude's send_request through the draft store; without it
 * sends are refused.
 */
export function startClaudeLink(tabId: number, bridge?: ReqlensBridge): void {
  if (started) return;
  started = true;
  linkTabId = tabId;
  linkBridge = bridge ?? null;
  status = offStatus(permission);
  refreshPermission();
  try {
    chrome.permissions.onAdded.addListener(refreshPermission);
    chrome.permissions.onRemoved.addListener(refreshPermission);
  } catch {
    /* not available */
  }
  watchBridgeSetting(linkBridge, setWanted);
}
