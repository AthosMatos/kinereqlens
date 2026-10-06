// Answers to the bridge calls Claude Code makes (BridgeCalls, docs/specs/v0.2.md §B.3/§B.4). Data comes from
// the tab's top-frame content script (BRIDGE_LIST / BRIDGE_ENTRY: the captured entries) and from the tab's
// panel link (selection, edited drafts, runs; running send_request). Formatting is pure (./format.ts); types
// and prompts come from the shared export pipeline (src/lib/{endpoint,typegen,agentPrompt}.ts).
import type { LinkEntryData, LinkQuery, LinkQueryResults, LinkState } from '../../shared/claude-link';
import { BRIDGE_SEND_MAX_TIMEOUT_MS } from '../../shared/claude-protocol';
import type { BridgeCalls, BridgeMethod } from '../../shared/claude-protocol';
import type { ControlParams, ControlResult } from '../../shared/control-protocol';
import type { BridgeEntryResponse, BridgeListResponse, BridgeListRow, TabMessage } from '../../shared/messages';
import type { RequestEntry, Settings, TabState, TestRun } from '../../shared/types';
import { buildAgentPrompt } from '../../lib/agentPrompt';
import { buildEndpointSpec, suggestBaseName } from '../../lib/endpoint';
import type { EndpointSpec } from '../../lib/endpoint';
import { generateEndpointTypes } from '../../lib/typegen';
import { isNoReceiverError, isRecord } from '../util';
import type { TabActivity } from './activity';
import { filterRequests, formatContext, requestDetail, runOut, summarize, tabOut } from './format';
import type { FormatContext, TabFacts } from './format';
import { LinkError } from './links';
import { DEFAULT_MAX_BODY_CHARS, ParamError, validateParams } from './validate';
import { overlayVisibleIds } from './control/listView';
import type { PanelFilters } from './control/listView';

/** How long to wait for the content script / panel answering a query. */
export const QUERY_TIMEOUT_MS = 5000;
/** A tab count query (status / list_tabs) must be quick. */
export const COUNT_TIMEOUT_MS = 1500;
/** Extra time a Claude send waits beyond the replay timeout. */
export const SEND_GRACE_MS = 5000;
/** How long a call waits for the panel of a tab whose overlay is open to (re)connect its link. */
export const LINK_WAIT_MS = 3000;
const MAX_TABS = 50;
const SELECTED = 'selected';

export const SEND_DISABLED =
  'Sending requests is disabled. Ask the user to turn on "Allow Claude to send requests" in the kineReqLens overlay (Settings → Claude Code).';
const NO_OPEN_TAB =
  'The kineReqLens overlay is not open in any tab. Ask the user to open it on the page to inspect (toolbar button or Alt+Shift+L).';

/** A call that cannot be answered; the message is shown to Claude. */
export class BridgeError extends Error {}

export interface HandlerDeps {
  settings(): Settings;
  tabs: { get(tabId: number): TabState; isOpen(tabId: number): boolean; isHidden?(tabId: number): boolean; openTabIds(): number[] };
  activity: Pick<TabActivity, 'defaultTab' | 'ordered'>;
  links: {
    has(tabId: number): boolean;
    tabIds(): number[];
    waitFor(tabId: number, timeoutMs: number): Promise<boolean>;
    query<K extends LinkQuery['kind']>(tabId: number, query: Extract<LinkQuery, { kind: K }>, timeoutMs: number): Promise<LinkQueryResults[K]>;
  };
  /** chrome.tabs.sendMessage to the tab's top frame. */
  sendToTop(tabId: number, message: TabMessage): Promise<unknown>;
  /** Title / URL of a tab, or null when it does not exist. */
  tabInfo(tabId: number): Promise<{ title: string; url: string } | null>;
  extensionVersion: string;
  browser: string;
  /** The overlay panel's text filter and removed set (list_requests overlayFilters), when a panel answers. */
  listFilters?(tabId: number): Promise<PanelFilters | null>;
  /**
   * The control plane (./control/plane.ts): the `control` method, the tab Claude was told to use, and an invisible
   * (headless) panel for send_request when the overlay is closed and the user allows control. Absent in old tests.
   */
  control?: {
    run(params: ControlParams): Promise<ControlResult>;
    /** Default tab for calls without tabId (null: fall back to the overlay activity). */
    defaultTab(): Promise<number | null>;
    /** Make sure a panel of `tabId` is connected, mounting one invisibly when the overlay is closed. */
    ensurePanel(tabId: number): Promise<void>;
    /** Count a call as running in `tabId` (a headless panel is not removed meanwhile). Returns the release. */
    hold(tabId: number): () => void;
    /** settings.claudeAllowControl */
    allowed(): boolean;
  };
}

type Handler<M extends BridgeMethod> = (params: BridgeCalls[M]['params']) => Promise<BridgeCalls[M]['result']>;

/** Build the dispatcher: validates params, runs the handler; throws BridgeError / ParamError / LinkError. */
export function createBridgeHandlers(deps: HandlerDeps): <M extends BridgeMethod>(method: M, params: unknown) => Promise<BridgeCalls[M]['result']> {
  const handlers: { [M in BridgeMethod]: Handler<M> } = {
    status: async () => {
      const settings = deps.settings();
      return {
        extensionVersion: deps.extensionVersion,
        browser: deps.browser,
        tabs: await listTabs(deps, redactionOf(settings)),
        allowSend: settings.claudeAllowSend === true,
        shareSecrets: settings.claudeShareSecrets === true,
        allowControl: settings.claudeAllowControl === true,
      };
    },
    listTabs: async () => ({ tabs: await listTabs(deps, redactionOf(deps.settings())) }),
    listRequests: async (params) => {
      const tabId = await resolveTab(deps, params.tabId);
      const [list, panel] = await Promise.all([fetchList(deps, tabId), panelState(deps, tabId)]);
      const settings = deps.settings();
      const ctx = redactionOf(settings);
      let rows = list.rows;
      if (params.overlayFilters) {
        // The overlay's own list: types, rules — and its text filter / removed set when a panel answers.
        const filters = deps.listFilters ? await deps.listFilters(tabId).catch(() => null) : null;
        const visible = overlayVisibleIds(rows, settings, filters);
        rows = rows.filter((row) => visible.has(row.id));
      }
      if (params.errorsOnly) rows = rows.filter((row) => row.state === 'error' || row.state === 'aborted' || (row.status !== undefined && row.status >= 400));
      const summaries = rows.map((row) => summarize(row, panel, ctx));
      return { tabId, ...filterRequests(summaries, params) };
    },
    getRequest: async (params) => {
      const tabId = await resolveTab(deps, params.tabId);
      const { entry, data, panel } = await entryWithPanelData(deps, tabId, params.id);
      const settings = deps.settings();
      return requestDetail(
        {
          entry,
          panel,
          draft: data?.draft ?? null,
          runs: data?.runs ?? [],
          includeRuns: params.includeRuns !== false,
          captureResponseBodies: settings.captureResponseBodies !== false,
        },
        redactionOf(settings),
        params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
      );
    },
    getTypes: async (params) => {
      const settings = deps.settings();
      const spec = await specFor(deps, await resolveTab(deps, params.tabId), params.id, settings);
      const format = params.format ?? settings.exportFormat ?? 'typescript';
      const generated = generateEndpointTypes(spec, {
        format,
        baseName: params.baseName ?? suggestBaseName(spec),
        ...(params.annotate !== undefined ? { annotate: params.annotate } : {}),
      });
      return { format: generated.format, code: generated.code, names: generated.names, notes: dedupe([...generated.notes, ...spec.notes]) };
    },
    getPrompt: async (params) => {
      const settings = deps.settings();
      const spec = await specFor(deps, await resolveTab(deps, params.tabId), params.id, settings);
      const target = params.target ?? settings.promptTarget ?? 'client';
      const types = generateEndpointTypes(spec, { format: 'typescript', baseName: suggestBaseName(spec) });
      const prompt = buildAgentPrompt(spec, {
        target,
        typesTs: types.code,
        typeNames: types.names,
        includeExamples: params.includeExamples !== false,
        typeNotes: types.notes,
      });
      return { prompt, target };
    },
    sendRequest: async (params) => {
      const settings = deps.settings();
      if (settings.claudeAllowSend !== true) throw new BridgeError(SEND_DISABLED);
      const tabId = await resolveTab(deps, params.tabId);
      let release: (() => void) | null = null;
      try {
        if (deps.control?.allowed() && !deps.tabs.isOpen(tabId)) {
          // The user lets Claude control kineReqLens: run it in a panel mounted invisibly (it shows in the history).
          release = deps.control.hold(tabId);
          await deps.control.ensurePanel(tabId);
        } else if (!deps.tabs.isOpen(tabId) || !(await hasPanel(deps, tabId))) {
          throw new BridgeError(
            `The kineReqLens overlay is not open in tab ${tabId}. Sending needs the overlay open there — ask the user to open it (toolbar button or Alt+Shift+L).`,
          );
        }
        const entryId = await resolveEntryId(deps, tabId, params.id);
        const timeoutMs = replayTimeoutOf(settings);
        const query: Extract<LinkQuery, { kind: 'send' }> = { kind: 'send', entryId, timeoutMs };
        if (params.overrides) query.overrides = params.overrides;
        if (params.mode) query.mode = params.mode;
        const answer: unknown = await deps.links.query(tabId, query, timeoutMs + SEND_GRACE_MS);
        const run = isRecord(answer) ? answer.run : undefined;
        if (!isRun(run)) throw new BridgeError('The kineReqLens overlay returned no run');
        return runOut(run, redactionOf(settings), params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS, true);
      } finally {
        release?.();
      }
    },
    control: async (params) => {
      if (!deps.control) throw new BridgeError('This kineReqLens version has no control tools — update the extension');
      return deps.control.run(params);
    },
  };
  return async <M extends BridgeMethod>(method: M, raw: unknown) => {
    // The control plane validates its own (per-tool) arguments.
    const params = method === 'control' ? (raw as BridgeCalls[M]['params']) : validateParams(method, raw);
    return (handlers[method] as Handler<M>)(params);
  };
}

/** Message for Claude of anything a handler threw. */
export function bridgeErrorMessage(err: unknown): string {
  if (err instanceof BridgeError || err instanceof ParamError || err instanceof LinkError) return err.message;
  const message = err instanceof Error ? err.message || err.name : String(err);
  return `kineReqLens failed: ${message}`;
}

export function redactionOf(settings: Settings): FormatContext {
  return formatContext(settings.claudeShareSecrets !== true);
}

export function replayTimeoutOf(settings: Settings): number {
  const t = settings.replayTimeoutMs;
  return Math.min(BRIDGE_SEND_MAX_TIMEOUT_MS, Math.max(1000, typeof t === 'number' && Number.isFinite(t) ? t : 30_000));
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** The tab of a call: `tabId`, else the tab Claude was told to use / the last overlay tab (see the control plane). */
export async function resolveTab(deps: HandlerDeps, tabId: number | undefined): Promise<number> {
  if (tabId !== undefined) return tabId;
  const chosen = deps.control ? await deps.control.defaultTab().catch(() => null) : null;
  if (chosen !== null) return chosen;
  const fallback = deps.activity.defaultTab(deps.tabs.openTabIds());
  if (fallback === null) throw new BridgeError(NO_OPEN_TAB);
  return fallback;
}

async function sendToTop(deps: HandlerDeps, tabId: number, message: TabMessage): Promise<unknown> {
  try {
    return await deps.sendToTop(tabId, message);
  } catch (err) {
    if (isNoReceiverError(err) || /no tab with id/i.test(String((err as Error)?.message ?? err))) {
      throw new BridgeError(`kineReqLens is not running in tab ${tabId} (no such tab, or the page needs a reload). Use list_tabs to see the available tabs.`);
    }
    throw err;
  }
}

function isListResponse(value: unknown): value is BridgeListResponse {
  return isRecord(value) && Array.isArray(value.rows) && typeof value.count === 'number';
}

function isRow(value: unknown): value is BridgeListRow {
  return isRecord(value) && typeof value.id === 'string' && typeof value.url === 'string' && typeof value.method === 'string' && typeof value.startTime === 'number';
}

export async function fetchList(deps: HandlerDeps, tabId: number): Promise<BridgeListResponse> {
  const answer = await withTimeout(sendToTop(deps, tabId, { type: 'BRIDGE_LIST' }), QUERY_TIMEOUT_MS, `Tab ${tabId} did not answer`);
  if (!isListResponse(answer)) throw new BridgeError(`kineReqLens is not running in tab ${tabId} — reload the page, then open the overlay`);
  return { ...answer, rows: answer.rows.filter(isRow) };
}

export async function fetchEntry(deps: HandlerDeps, tabId: number, entryId: string): Promise<RequestEntry> {
  const answer = (await withTimeout(sendToTop(deps, tabId, { type: 'BRIDGE_ENTRY', id: entryId }), QUERY_TIMEOUT_MS, `Tab ${tabId} did not answer`)) as
    | BridgeEntryResponse
    | undefined;
  if (!isRecord(answer)) throw new BridgeError(`kineReqLens is not running in tab ${tabId} — reload the page, then open the overlay`);
  const entry = answer.entry;
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.url !== 'string') {
    throw new BridgeError(`No request with id "${entryId}" in tab ${tabId} (ids come from list_requests; the list may have been cleared)`);
  }
  return entry as RequestEntry;
}

/**
 * A panel of the tab is connected. While the overlay is open there but its link is missing (the worker just
 * restarted, the panel is still loading), wait a moment for it.
 */
export async function hasPanel(deps: HandlerDeps, tabId: number): Promise<boolean> {
  if (deps.links.has(tabId)) return true;
  if (!deps.tabs.isOpen(tabId)) return false;
  return deps.links.waitFor(tabId, LINK_WAIT_MS);
}

/** The panel's state, or null when no panel is connected (or it does not answer). */
export async function panelState(deps: HandlerDeps, tabId: number): Promise<LinkState | null> {
  if (!(await hasPanel(deps, tabId))) return null;
  try {
    const state = await deps.links.query(tabId, { kind: 'state' }, QUERY_TIMEOUT_MS);
    return isLinkState(state) ? state : null;
  } catch {
    return null;
  }
}

function isLinkState(value: unknown): value is LinkState {
  return isRecord(value) && (value.selectedId === null || typeof value.selectedId === 'string') && Array.isArray(value.work);
}

/** Resolve "selected" through the panel's state (fetched when not given). */
export async function resolveEntryId(deps: HandlerDeps, tabId: number, id: string, known?: LinkState | null): Promise<string> {
  if (id !== SELECTED) return id;
  if (!(await hasPanel(deps, tabId))) {
    throw new BridgeError(`"selected" needs the kineReqLens overlay open in tab ${tabId}; pass an id from list_requests instead`);
  }
  const state = known ?? (await panelState(deps, tabId));
  if (!state) throw new BridgeError('The kineReqLens overlay did not answer — try again, or pass an id from list_requests');
  if (!state.selectedId) throw new BridgeError('No request is selected in the kineReqLens overlay — ask the user to select one, or pass an id from list_requests');
  return state.selectedId;
}

async function entryWithPanelData(
  deps: HandlerDeps,
  tabId: number,
  id: string,
): Promise<{ entry: RequestEntry; data: LinkEntryData | null; panel: LinkState | null }> {
  const panel = await panelState(deps, tabId);
  const entryId = await resolveEntryId(deps, tabId, id, panel);
  const [entry, data] = await Promise.all([fetchEntry(deps, tabId, entryId), panelEntry(deps, tabId, entryId)]);
  return { entry, data, panel };
}

async function panelEntry(deps: HandlerDeps, tabId: number, entryId: string): Promise<LinkEntryData | null> {
  if (!(await hasPanel(deps, tabId))) return null;
  try {
    const data = await deps.links.query(tabId, { kind: 'entry', entryId }, QUERY_TIMEOUT_MS);
    if (!isRecord(data) || !Array.isArray(data.runs)) return null;
    return { draft: isRecord(data.draft) ? data.draft : null, runs: data.runs.filter(isRun) };
  } catch {
    return null;
  }
}

export function isRun(value: unknown): value is TestRun {
  return isRecord(value) && typeof value.runId === 'string' && isRecord(value.request) && typeof value.startedAt === 'number';
}

async function specFor(deps: HandlerDeps, tabId: number, id: string, settings: Settings): Promise<EndpointSpec> {
  const { entry, data } = await entryWithPanelData(deps, tabId, id);
  return buildEndpointSpec({ entry, runs: data?.runs ?? [], draft: data?.draft ?? null, redact: settings.claudeShareSecrets !== true });
}

/** Tabs worth reporting: overlay open, panel connected, or recently active with the overlay. */
async function listTabs(deps: HandlerDeps, ctx: FormatContext) {
  const ids = [...new Set([...deps.tabs.openTabIds(), ...deps.links.tabIds(), ...deps.activity.ordered()])].slice(0, MAX_TABS);
  const defaultTab = deps.activity.defaultTab(deps.tabs.openTabIds());
  const facts = await Promise.all(ids.map((tabId) => tabFacts(deps, tabId)));
  return facts.filter((f): f is TabFacts => f !== null).map((f) => tabOut(f, defaultTab, ctx));
}

async function tabFacts(deps: HandlerDeps, tabId: number): Promise<TabFacts | null> {
  const info = await deps.tabInfo(tabId).catch(() => null);
  if (!info) return null;
  const state = deps.tabs.get(tabId);
  let entryCount = 0;
  try {
    const answer = await withTimeout(deps.sendToTop(tabId, { type: 'BRIDGE_LIST', countOnly: true }), COUNT_TIMEOUT_MS, 'timeout');
    if (isListResponse(answer)) entryCount = answer.count;
  } catch {
    /* no content script in that tab (yet) */
  }
  return { tabId, title: info.title, url: info.url, open: state.open, recording: state.recording, entryCount, hidden: deps.tabs.isHidden?.(tabId) === true };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeError(message)), ms);
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
