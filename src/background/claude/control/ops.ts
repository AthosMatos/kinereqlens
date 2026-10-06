// The control tools' actions (src/shared/control-protocol.ts CONTROL_ACTIONS), one handler each. Worker-side:
// tabs, overlay state, list filters, setups, language, settings, initiator, trace. Everything the panel holds
// (selection, view, drafts, runs, WebSocket messages, the Errors view, screenshots, Find in page) is a panel op
// (src/ui/panel/control.ts) through OpCall.panel. Answers are rendered as markdown (./text.ts), page data redacted
// unless the user shares secrets.
import type {
  ControlResult,
  DraftEditArgs,
  PanelDraftResult,
  PanelErrorRun,
  PanelErrorsResult,
  PanelRunsResult,
  PanelScreenshotResult,
  PanelStateResult,
  PanelView,
  PanelWsConnection,
  PanelWsMessagesResult,
  RuleArgs,
  WsMessagesArgs,
} from '../../../shared/control-protocol';
import { VIEW_NAMES } from '../../../shared/control-protocol';
import type { FindCommandArgs, FindCommandResult, ShotCommandArgs } from '../../../shared/control-shot';
import type { BridgeListRow } from '../../../shared/messages';
import type { DockMode, ListRule, ListTypeId, ManualEntryInit, RequestEntry, Setup, SettingsPatch, TestRun } from '../../../shared/types';
import { LANGUAGE_OPTIONS, languageName, normalizeLanguageValue, siteKeyOf, withSiteLanguage } from '../../../shared/language';
import { normalizeListTypes } from '../../../shared/setups';
import { uid } from '../../../lib/ids';
import { analyzeInitiator } from '../../../lib/initiator';
import { parseStack } from '../../../lib/stack';
import { RESOLVE_MAX_FRAMES } from '../../../shared/initiator-protocol';
import type { ResolvedFrame, ResolveFrameRequest } from '../../../shared/initiator-protocol';
import { dockSizeForSwitch } from '../../../ui/components/panel/geometry';
import { templateKeyOf, templateKeyText } from '../../../ui/list/endpointLabel';
import { addRule, removeRule, ruleDescription, ruleLabel, setRuleEnabled, toggleRule } from '../../../ui/list/rules';
import {
  activeSetup,
  applySetupPatch,
  captureConfig,
  createSetup,
  duplicateSetup,
  exportSetups,
  findByName,
  importSetups,
  importSummary,
  isModified,
  moveSetupToGroup,
  parseSetupsFile,
  removeSetup,
  renameSetup,
  setSetupSites,
  setupSummary,
  updateSetupConfig,
} from '../../../ui/setups/model';
import type { ListConfigState } from '../../../ui/setups/model';
import { bodyOut, redactText, runOut, urlOut } from '../format';
import type { FormatContext } from '../format';
import { BridgeError, fetchEntry, fetchList, redactionOf, replayTimeoutOf, resolveEntryId } from '../handlers';
import { DEFAULT_MAX_BODY_CHARS } from '../validate';
import { overlayVisibleIds } from './listView';
import { OP_TIMEOUT_MS, OpCall, openFailure } from './plane';
import { planSettingsPatch, settingsView } from './settings';
import {
  UNTRUSTED_NOTE,
  code,
  diffText,
  draftText,
  errorsText,
  fence,
  findText,
  formatBytes,
  initiatorText,
  isoTime,
  line,
  runText,
  sentRequestText,
  snippetText,
  table,
  traceText,
  wsConnectionsText,
  wsMessagesText,
} from './text';

type Op = (call: OpCall) => Promise<ControlResult>;

const text = (...lines: Array<string | false | null | undefined>): ControlResult => ({ text: lines.filter((l) => l !== false && l !== null && l !== undefined).join('\n') });

function arg<T>(call: OpCall, name: string): T {
  return call.args[name] as T;
}

const COUNT_TIMEOUT_MS = 1500;
/** A panel op that waits for the page (screenshots scroll and capture at ≤ 2 frames / s). */
const SHOT_TIMEOUT_MS = 120_000;
const FIND_TIMEOUT_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------------------------------------- helpers

/** An entry id of the tab ("selected" resolved through the panel). */
async function entryIdOf(call: OpCall, name = 'requestId'): Promise<string> {
  const tabId = await call.tab();
  const id = arg<string>(call, name);
  if (id !== 'selected') return id;
  // "selected" needs the panel: mount it so the user's selection (or Claude's) is known.
  if (!call.deps.links.has(tabId)) await call.plane.ensurePanel(tabId);
  return resolveEntryId(call.deps.handlers, tabId, id);
}

async function entryOf(call: OpCall, name = 'requestId'): Promise<RequestEntry> {
  const tabId = await call.tab();
  return fetchEntry(call.deps.handlers, tabId, await entryIdOf(call, name));
}

async function countEntries(call: OpCall, tabId: number): Promise<number | null> {
  try {
    const answer = await Promise.race([
      call.deps.sendToTop(tabId, { type: 'BRIDGE_LIST', countOnly: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), COUNT_TIMEOUT_MS)),
    ]);
    return answer && typeof answer === 'object' && typeof (answer as { count?: unknown }).count === 'number' ? (answer as { count: number }).count : null;
  } catch {
    return null;
  }
}

function overlayState(call: OpCall, tabId: number): string {
  const { tabs, links } = call.deps;
  const state = tabs.get(tabId);
  if (state.open) return tabs.isHidden(tabId) ? 'open in the background (hidden)' : 'open';
  if (call.plane.isHeadless(tabId)) return 'closed (headless panel mounted for Claude)';
  return links.has(tabId) ? 'closed (panel loaded)' : 'closed';
}

function settingsPatchFor(call: OpCall, patch: SettingsPatch) {
  return call.deps.updateSettings(patch);
}

/** The page host of the tab (site key), for setups and the site language. */
async function pageHostOf(call: OpCall): Promise<string | null> {
  const tab = await call.deps.browser.getTab(await call.tab());
  return tab ? siteKeyOf(tab.url) : null;
}

async function listConfigState(call: OpCall, withPage: boolean): Promise<ListConfigState> {
  const s = call.deps.settings();
  const state: ListConfigState = {
    listTypes: s.listTypes,
    listRules: s.listRules,
    defaultMode: s.defaultMode,
    activeSetupId: s.activeSetupId,
    siteLanguages: s.siteLanguages,
  };
  if (withPage) state.pageHost = await pageHostOf(call).catch(() => null);
  return state;
}

function rulesTable(rules: readonly ListRule[], ctx: FormatContext): string {
  if (!rules.length) return 'No list rules.';
  return table(
    ['ruleId', 'rule', 'enabled'],
    rules.map((r) => [r.id, r.template ? ruleDescription(r) : r.method ? ruleDescription(r) : `${r.mode === 'hide' ? 'Hide' : 'Show only'} ${urlOut(r.pattern, ctx)}${r.exact ? ' (exact path)' : ' (and below)'}`, r.enabled ? 'on' : 'off']),
    400,
  );
}

function typesText(types: readonly ListTypeId[]): string {
  return types.length ? types.join(', ') : 'all types';
}

function setupLine(setup: Setup, active: string | null): Array<string | number> {
  return [setup.id, setup.name, setup.group || '—', setup.sites.join(', ') || '—', setupSummary(setup), setup.id === active ? 'active' : ''];
}

function findSetup(call: OpCall): Setup {
  const id = arg<string>(call, 'setupId');
  const setups = call.deps.settings().setups;
  const setup = setups.find((s) => s.id === id) ?? setups.find((s) => s.name.toLowerCase() === id.toLowerCase());
  if (!setup) throw new BridgeError(`No setup "${id}" — see inspect setups`);
  return setup;
}

// ------------------------------------------------------------------------------------------- inspect

const inspectTabs: Op = async (call) => {
  const { browser } = call.deps;
  const tabs = await browser.queryTabs();
  const def = await call.plane.resolveTab(undefined).catch(() => null);
  const pinned = await call.plane.defaultTab();
  const ctx = redactionOf(call.settings);
  const windows = new Map<number, string>();
  for (const t of tabs) if (!windows.has(t.windowId)) windows.set(t.windowId, (await browser.getWindow(t.windowId).catch(() => null))?.state ?? '?');
  const rows = await Promise.all(
    tabs.slice(0, 100).map(async (t) => {
      const state = call.deps.tabs.get(t.id);
      const count = state.open || call.deps.links.has(t.id) ? await countEntries(call, t.id) : null;
      return [
        t.id === def ? '*' : '',
        t.id,
        `${t.windowId}${windows.get(t.windowId) === 'minimized' ? ' (minimized)' : ''}`,
        t.active ? 'yes' : '',
        overlayState(call, t.id),
        state.open ? (state.recording ? 'on' : 'paused') : '—',
        count ?? '—',
        line(t.title, 80),
        urlOut(t.url, ctx),
      ];
    }),
  );
  return text(
    `Browser tabs (* = used when tabId is omitted${pinned !== null ? `; Claude was told to use tab ${pinned}` : ''}). Screenshots need the tab active in a window that is not minimized (or activate: true).`,
    '',
    table(['default', 'tabId', 'window', 'active', 'overlay', 'recording', 'requests', 'title', 'url'], rows, 160),
    tabs.length > 100 ? `… ${tabs.length - 100} more tabs not listed.` : '',
  );
};

const inspectOverlay: Op = async (call) => {
  const tabId = await call.tab();
  const s = call.deps.settings();
  const state = call.deps.tabs.get(tabId);
  const ctx = redactionOf(call.settings);
  const panel = await call.panelIfMounted<PanelStateResult>({ op: 'state' }).catch(() => null);
  const active = activeSetup(s.setups, { activeSetupId: s.activeSetupId });
  const lang = call.deps.language ? (await call.deps.language.load().then(() => call.deps.language!.status(tabId)).catch(() => null)) : null;
  const parts = [
    `## Overlay in tab ${tabId}: ${overlayState(call, tabId)}`,
    `Recording ${state.recording ? 'on' : 'paused'}${state.open ? '' : ' (captures only while the overlay is open or open in the background)'} · preserve log ${state.preserveLog ? 'on' : 'off'}`,
    `Layout: dock ${s.layout.dock} · ${s.layout.minimized ? 'minimized' : 'not minimized'} · rail ${s.layout.railExpanded ? 'expanded' : 'icons'} · theme ${s.theme} · opacity ${Math.round(s.opacity * 100)}%`,
  ];
  if (panel) {
    parts.push(
      `View: ${panel.view === 'http' ? 'requests' : panel.view === 'ws' ? 'websocket' : panel.view === 'shot' ? 'screenshot' : 'errors'} · selected request: ${panel.selectedId ? code(panel.selectedId) : 'none'} · text filter: ${panel.textFilter ? code(panel.textFilter) : 'none'} · removed from list: ${panel.removedIds.length} · ${panel.entryCount} request(s) · ${panel.work.length} with edits / runs${panel.runningRuns ? ` · ${panel.runningRuns} run(s) in flight` : ''}${panel.claudeRuns ? ` · ${panel.claudeRuns} Errors view Claude run(s) in progress` : ''} · terminal pane ${panel.terminalOpen ? 'open' : 'hidden'}`,
    );
  } else parts.push('Panel: not loaded (selection, view and the text filter exist once a panel runs: any panel action mounts one invisibly).');
  parts.push(
    `### List filters`,
    `Types: ${typesText(s.listTypes)} · group by endpoint: ${s.listGroup ? 'on' : 'off'} · URL display: ${s.urlDisplay} · setup: ${active ? `${code(active.name)}${isModified(s.setups, await listConfigState(call, true)) ? ' (modified)' : ''}` : 'none'}`,
    rulesTable(s.listRules, ctx),
  );
  if (lang) parts.push(`Language: ${lang.effective ? `${code(lang.effective)} (${lang.scope === 'tab' ? 'this tab' : 'this site'})` : "the browser's own"}`);
  return text(...parts);
};

const inspectSetups: Op = async (call) => {
  const s = call.deps.settings();
  if (arg<boolean>(call, 'export')) {
    const only = arg<string | undefined>(call, 'setupId');
    const list = only ? [findSetup(call)] : s.setups;
    if (!list.length) return text('There are no setups to export.');
    return text(`Setups file (kinereqlens-setups v1, ${list.length} setup${list.length === 1 ? '' : 's'}); import it with setups import {json}:`, fence(exportSetups(list), 'json'));
  }
  if (arg<string | undefined>(call, 'setupId')) {
    const setup = findSetup(call);
    return text(`Setup ${code(setup.name)}${setup.id === s.activeSetupId ? ' (active)' : ''}`, fence(JSON.stringify(setup, null, 2), 'json'));
  }
  if (!s.setups.length) return text('No setups saved. Save the current list configuration with setups save {name}.');
  const state = await listConfigState(call, false);
  return text(
    `${s.setups.length} setup(s)${s.activeSetupId ? ` · active: ${code(s.setups.find((x) => x.id === s.activeSetupId)?.name ?? s.activeSetupId)}${isModified(s.setups, state) ? ' (modified since applied)' : ''}` : ''}`,
    table(['setupId', 'name', 'group', 'sites (auto-apply)', 'summary', ''], s.setups.map((x) => setupLine(x, s.activeSetupId)), 200),
  );
};

const inspectLanguage: Op = async (call) => {
  const tabId = await call.tab();
  const language = call.deps.language;
  if (!language) throw new BridgeError('Site language is not available');
  await language.load();
  const host = await pageHostOf(call);
  const status = language.status(tabId);
  const site = host ? call.deps.settings().siteLanguages[host] : undefined;
  return text(
    `Tab ${tabId} (${host ?? 'no site'}): ${status.effective ? `${code(status.effective)} — ${languageName(status.effective.split(',')[0]!) ?? ''} (${status.scope === 'tab' ? 'this tab' : 'this site'})` : "the browser's own languages"}`,
    `Tab override: ${status.tab ? code(status.tab) : 'none'} · site override${host ? ` for ${host}` : ''}: ${site ? code(site) : 'none'}`,
    `${Object.keys(call.deps.settings().siteLanguages).length} site(s) have a saved language.`,
    `Values are Accept-Language lists, e.g. "pt-BR" or "de-DE, en;q=0.8". Common tags: ${LANGUAGE_OPTIONS.slice(0, 12).map((o) => o.tag).join(', ')}…`,
  );
};

const inspectSettings: Op = async (call) => {
  const rows = settingsView(call.deps.settings());
  return text('Settings ("Claude" = whether Claude may change it with the settings tool):', table(['setting', 'value', 'Claude'], rows.map((r) => [r.key, r.value, r.claude]), 300));
};

const inspectWebsocket: Op = async (call) => {
  const wsId = arg<string | undefined>(call, 'wsId');
  const answer = await call.panel<{ connections: PanelWsConnection[] }>({ op: 'ws_list', ...(wsId ? { wsId } : {}) });
  return text(wsConnectionsText(answer.connections, redactionOf(call.settings)));
};

const inspectWsMessages: Op = async (call) => {
  const args = call.args as WsMessagesArgs;
  const answer = await call.panel<PanelWsMessagesResult>({ op: 'ws_messages', ...args });
  return text(wsMessagesText(answer, redactionOf(call.settings), DEFAULT_MAX_BODY_CHARS));
};

const inspectErrors: Op = async (call) => {
  const key = arg<string | undefined>(call, 'key');
  const filter = arg<'all' | '5xx' | '4xx' | 'network' | undefined>(call, 'filter');
  const shots = arg<boolean | undefined>(call, 'shots') ?? !!key;
  const answer = await call.panel<PanelErrorsResult>({ op: 'errors', ...(filter ? { filter } : {}), ...(key ? { key, shots } : {}) }, 30_000);
  const result: ControlResult = text(errorsText(answer, redactionOf(call.settings)));
  const images = (answer.detail?.shots ?? []).filter((s) => s.data).map((s) => ({ data: s.data!, mimeType: 'image/png' as const, width: s.width, height: s.height }));
  if (images.length) result.images = images;
  return result;
};

async function runsOf(call: OpCall, entryId: string): Promise<PanelRunsResult> {
  return call.panel<PanelRunsResult>({ op: 'runs', entryId });
}

function pickRun(runs: PanelRunsResult, runId: string | undefined): TestRun {
  if (!runs.runs.length) throw new BridgeError('This request has no test runs yet (send it with send_request)');
  const run = runId ? runs.runs.find((r) => r.runId === runId) : (runs.runs.find((r) => r.runId === runs.activeRunId) ?? runs.runs[0]);
  if (!run) throw new BridgeError(`No run "${runId}" for this request (see get_request with includeRuns)`);
  return run;
}

const inspectRun: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const runs = await runsOf(call, entryId);
  const run = pickRun(runs, arg<string | undefined>(call, 'runId'));
  const ctx = redactionOf(call.settings);
  const max = arg<number | undefined>(call, 'maxBodyChars') ?? DEFAULT_MAX_BODY_CHARS;
  const out = runOut(run, ctx, max, true);
  const notes: string[] = [];
  const headerNames = run.request.headers.map((h) => h.name.toLowerCase());
  if (!headerNames.includes('cache-control')) notes.push('The browser adds Cache-Control: no-cache and Pragma: no-cache to test requests (they bypass the HTTP cache).');
  return {
    text: [`Run ${code(run.runId)} of ${code(entryId)} (${runs.runs.length} run(s) kept, newest first: ${runs.runs.map((r) => r.runId).slice(0, 10).join(', ')})`, '', UNTRUSTED_NOTE, '', sentRequestText(run.request, ctx, max), ...notes].join('\n'),
    run: out as ControlResult['run'],
  };
};

const inspectCompare: Op = async (call) => {
  const tabId = await call.tab();
  const entryId = await entryIdOf(call);
  const runs = await runsOf(call, entryId);
  const run = pickRun(runs, arg<string | undefined>(call, 'runId'));
  const against = arg<'original' | 'previous' | undefined>(call, 'against') ?? 'original';
  const ctx = redactionOf(call.settings);
  const max = 2_000_000;
  const bodyOfRun = (r: TestRun) => (r.result ? bodyOut(r.result.body, r.result.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? null, ctx, max) : null);
  const right = bodyOfRun(run);
  let left: ReturnType<typeof bodyOut>;
  let leftLabel: string;
  if (against === 'previous') {
    const index = runs.runs.indexOf(run);
    const previous = runs.runs.slice(index + 1).find((r) => r.result);
    if (!previous) throw new BridgeError('There is no earlier run to compare with (against: "original" compares with the captured response)');
    left = bodyOfRun(previous);
    leftLabel = `run ${previous.runId}`;
  } else {
    const entry = await fetchEntry(call.deps.handlers, tabId, entryId);
    left = bodyOut(entry.responseBody ?? null, entry.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? null, ctx, max);
    leftLabel = 'the captured response';
  }
  const status = (s?: number) => (s === undefined ? '—' : String(s));
  const leftStatus = against === 'previous' ? status(runs.runs.slice(runs.runs.indexOf(run) + 1).find((r) => r.result)?.result?.status) : '';
  const diff = diffText(left?.text ?? '', right?.text ?? '', arg<number | undefined>(call, 'maxLines') ?? 400);
  return text(
    `Compare run ${code(run.runId)} (status ${status(run.result?.status)}) with ${leftLabel}${leftStatus ? ` (status ${leftStatus})` : ''}: +${diff.added} −${diff.removed} line(s)${diff.truncated ? ' (coarse diff: too large for an exact one)' : ''}.`,
    '',
    UNTRUSTED_NOTE,
    '',
    diff.added || diff.removed ? fence(diff.text, 'diff') : 'The bodies are identical.',
    ctx.redacted ? 'Secret values are redacted ("<redacted>").' : '',
  );
};

const inspectSnippet: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const answer = await call.panel<PanelDraftResult>({ op: 'request', entryId });
  if (!answer.request) throw new BridgeError(`The request cannot be built: ${answer.warnings[0] ?? 'see edit_request'}`);
  const kind = arg<'curl' | 'fetch' | undefined>(call, 'format') ?? 'curl';
  const ctx = redactionOf(call.settings);
  const snippet = snippetText(answer.request, kind, ctx);
  return text(
    `${kind === 'curl' ? 'cURL' : 'fetch()'} of ${code(entryId)} as Send would send it now${answer.modified ? ' (with the edits)' : ''}:`,
    '',
    UNTRUSTED_NOTE,
    fence(snippet, kind === 'curl' ? 'sh' : 'js'),
    ctx.redacted ? 'Secret values are redacted ("<redacted>"): the command will not work as is.' : '',
  );
};

const inspectInitiator: Op = async (call) => {
  const tabId = await call.tab();
  const entry = await entryOf(call);
  const stack = typeof entry.initiatorStack === 'string' ? entry.initiatorStack : '';
  if (!stack) return text(initiatorText(null, ''));
  // Source maps are resolved by the worker (the same resolver as the Initiator tab: cookies for the page's origin only).
  const frames = parseStack(stack);
  const requests: ResolveFrameRequest[] = [];
  const index: number[] = [];
  frames.forEach((f, i) => {
    if (requests.length < RESOLVE_MAX_FRAMES && /^https?:\/\//i.test(f.url) && f.line > 0) {
      requests.push({ url: f.url, line: f.line, col: f.col });
      index.push(i);
    }
  });
  const resolved: Array<ResolvedFrame | null> = frames.map(() => null);
  let error: string | undefined;
  if (requests.length && call.deps.sources) {
    try {
      const answer = await call.deps.sources.resolve(requests, entry.pageUrl || entry.frameUrl || '');
      answer.forEach((r, k) => {
        const at = index[k];
        if (at !== undefined) resolved[at] = r;
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const analysis = analyzeInitiator(stack, resolved);
  const ctx = redactionOf(call.settings);
  return text(`Initiator of ${code(entry.id)} ${entry.method} ${urlOut(entry.url, ctx)} (tab ${tabId})`, '', UNTRUSTED_NOTE, '', initiatorText(analysis, call.settings.editorRoot, error, ctx));
};

const inspectSource: Op = async (call) => {
  const value = arg<string>(call, 'text');
  const answer = await call.panel<{ groups: Array<{ kind: 'entry' | 'ws'; entryId?: string; wsId?: string; frameId?: number; time: number; total: number; matches: Array<{ label: string; value: string; how: string }> }>; bodies: number; frames: number; skipped: number }>(
    { op: 'source', texts: [value] },
    30_000,
  );
  const ctx = redactionOf(call.settings);
  if (!answer.groups.length) {
    return text(`No captured response body (${answer.bodies} searched${answer.skipped ? `, ${answer.skipped} too large` : ''}) or WebSocket message (${answer.frames}) contains "${line(value, 200)}" or a formatted form of it.`);
  }
  return text(
    `Where "${line(value, 200)}" comes from — ${answer.groups.length} source(s), best first (${answer.bodies} bodies, ${answer.frames} WebSocket messages searched):`,
    '',
    UNTRUSTED_NOTE,
    '',
    table(
      ['source', 'time', 'matches (path = value · how)'],
      answer.groups.map((g) => [
        g.kind === 'entry' ? `request ${g.entryId}` : `ws ${g.wsId} message ${g.frameId}`,
        isoTime(g.time),
        g.matches.slice(0, 4).map((m) => `${m.label}${m.value ? ` = ${redactText(m.value, ctx)}` : ''} · ${m.how}`).join(' ; ') + (g.total > 4 ? ` (+${g.total - 4})` : ''),
      ]),
      500,
    ),
  );
};

const inspectActivity: Op = async (call) => text('Recent Claude actions (newest first; the user sees them in Settings → Claude Code):', traceText(call.plane.traceItems()));

// ------------------------------------------------------------------------------------------- overlay

const overlayOpen: Op = async (call) => {
  const tabId = await call.tab();
  const hidden = arg<boolean | undefined>(call, 'hidden') === true;
  const opened = await call.deps.controller.open(tabId, { hidden });
  if (!opened.ok) throw new BridgeError(openFailure(tabId, opened.reason));
  if (!hidden) call.plane.onTabOpened(tabId);
  return text(
    hidden
      ? `kineReqLens is open in the background in tab ${tabId}: it captures requests (recording ${opened.state.recording ? 'on' : 'paused'}) without showing the overlay. The toolbar button shows it.`
      : `The kineReqLens overlay is open in tab ${tabId} (recording ${opened.state.recording ? 'on' : 'paused'}).`,
    'Requests the page made before it was opened are not captured: overlay reload_page captures the page load.',
  );
};

const overlayClose: Op = async (call) => {
  const tabId = await call.tab();
  if (!call.deps.tabs.isOpen(tabId)) return text(`The overlay is already closed in tab ${tabId}.`);
  await call.deps.controller.setState(tabId, { open: false });
  return text(`Closed the kineReqLens overlay in tab ${tabId} (capture stopped; the captured requests stay until the page reloads).`);
};

const overlayShow: Op = async (call) => {
  const tabId = await call.tab();
  await call.plane.reveal(tabId);
  return text(`The kineReqLens overlay is shown in tab ${tabId}.`);
};

const overlayHide: Op = async (call) => {
  const tabId = await call.tab();
  if (!call.deps.tabs.isOpen(tabId)) return text(`The overlay is closed in tab ${tabId}; nothing to hide (overlay open {hidden: true} captures in the background).`);
  await call.deps.controller.setState(tabId, { hidden: true });
  return text(`The overlay in tab ${tabId} is hidden; kineReqLens keeps capturing in the background (the toolbar button shows it again).`);
};

const overlayMinimize = (minimized: boolean): Op => async (call) => {
  await settingsPatchFor(call, { layout: { minimized } });
  return text(minimized ? 'The overlay is minimized to its pill (all tabs).' : 'The overlay is restored from its pill (all tabs).');
};

const overlayDock: Op = async (call) => {
  const dock = arg<DockMode>(call, 'dock');
  const s = call.deps.settings();
  const tab = await call.deps.browser.getTab(await call.tab()).catch(() => null);
  const vp = { width: tab?.width || 1440, height: tab?.height || 900 };
  const patch: SettingsPatch = { layout: dock === 'float' ? { dock } : { dock, dockSize: dockSizeForSwitch(dock, s.layout.dockSize, vp) } };
  await settingsPatchFor(call, patch);
  return text(`The overlay is ${dock === 'float' ? 'a floating window' : `docked ${dock}`}.`);
};

const overlayView: Op = async (call) => {
  const view = VIEW_NAMES[arg<string>(call, 'view')] as PanelView;
  const resultsTab = arg<'original' | 'export' | 'initiator' | 'test' | undefined>(call, 'resultsTab');
  const exportTab = arg<'types' | 'prompt' | undefined>(call, 'exportTab');
  const entryId = call.args.requestId !== undefined ? await entryIdOf(call) : undefined;
  const answer = await call.panel<{ view: string; selected: string | null }>({ op: 'view', view, ...(resultsTab ? { resultsTab } : {}), ...(exportTab ? { exportTab } : {}), ...(entryId ? { entryId } : {}) });
  return text(`The overlay shows the ${arg<string>(call, 'view')} view${answer.selected ? ` (request ${code(answer.selected)}${resultsTab ? `, ${resultsTab} tab` : ''})` : ''}.${call.deps.tabs.isOpen(await call.tab()) && !call.deps.tabs.isHidden(await call.tab()) ? '' : ' The overlay is not shown: the user sees it when they open it (overlay show).'}`);
};

const overlaySelect: Op = async (call) => {
  if (call.args.requestId === undefined) {
    await call.panel({ op: 'select', entryId: null });
    return text('No request is selected.');
  }
  const entryId = await entryIdOf(call);
  const answer = await call.panel<{ selected: string; method: string; url: string }>({ op: 'select', entryId });
  return text(`Selected ${code(answer.selected)} ${answer.method} ${urlOut(answer.url, redactionOf(call.settings))} (its editor opens in the Requests view).`);
};

const overlayHighlight: Op = async (call) => {
  const tabId = await call.tab();
  const entryId = await entryIdOf(call);
  await call.plane.ensureVisible(tabId, call.call.activate === true);
  const answer = await call.panel<{ names: string[]; result: { matches: Array<{ name: string; count: number }>; highlighted?: number; error?: string } }>({ op: 'highlight', entryId }, 20_000);
  const found = answer.result.matches.find((m) => m.count > 0);
  if (!found) return text(`None of the components (${answer.names.map((n) => code(n)).join(', ')}) is mounted on the page right now${answer.result.error ? ` (${line(answer.result.error, 200)})` : ''}.`);
  return text(`Highlighted ${found.count} instance(s) of ${code(found.name)} on the page (scrolled into view; the boxes disappear after a few seconds).`);
};

const overlayReload: Op = async (call) => {
  const tabId = await call.tab();
  await call.deps.browser.reload(tabId);
  return text(`Reloaded tab ${tabId}${call.deps.tabs.get(tabId).open && call.deps.tabs.get(tabId).recording ? ': kineReqLens captures the page load' : ''}.`);
};

const overlayUseTab: Op = async (call) => {
  const tabId = await call.tab();
  call.plane.pin(tabId);
  const tab = await call.deps.browser.getTab(tabId);
  return text(`Calls without tabId now use tab ${tabId} (${line(tab?.title ?? '', 80)}).`);
};

const overlayActivate: Op = async (call) => {
  const tabId = await call.tab();
  await call.plane.ensureVisible(tabId, true);
  return text(`Tab ${tabId} is the active tab of its window now.`);
};

// ------------------------------------------------------------------------------------------- requests

const requestsRecord: Op = async (call) => {
  const tabId = await call.tab();
  const on = arg<boolean>(call, 'on');
  const { tabs, controller } = call.deps;
  if (!tabs.isOpen(tabId)) {
    if (!on) return text(`Tab ${tabId} is not recording (the overlay is closed).`);
    const opened = await controller.open(tabId, { hidden: true });
    if (!opened.ok) throw new BridgeError(openFailure(tabId, opened.reason));
    return text(
      `Recording in tab ${tabId}: kineReqLens is open in the background (the overlay stays hidden; the toolbar badge counts the requests).`,
      'Requests the page made before now were not captured: overlay reload_page captures the page load.',
    );
  }
  await controller.setState(tabId, { recording: on });
  return text(`Recording ${on ? 'resumed' : 'paused'} in tab ${tabId}.`);
};

const requestsPreserve: Op = async (call) => {
  const tabId = await call.tab();
  const on = arg<boolean>(call, 'on');
  await call.deps.controller.setState(tabId, { preserveLog: on });
  return text(`Preserve log is ${on ? 'on' : 'off'} in tab ${tabId}${on ? ': captured requests survive navigations and reloads (credentials are not kept)' : ''}.`);
};

const requestsClear: Op = async (call) => {
  await call.panel({ op: 'clear' });
  return text(`Cleared the request list of tab ${await call.tab()} (drafts and runs included).`);
};

const requestsNew: Op = async (call) => {
  const headers = arg<Array<[string, string]> | undefined>(call, 'headers');
  const body = arg<string | undefined>(call, 'body');
  const init: ManualEntryInit = {};
  if (call.args.method) init.method = arg<string>(call, 'method').toUpperCase();
  if (call.args.url) init.url = arg<string>(call, 'url');
  if (headers) init.headers = headers.map(([name, value]) => ({ name, value }));
  if (body !== undefined) {
    init.body = { kind: 'text', text: body, size: new TextEncoder().encode(body).length };
    init.contentType = headers?.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? null;
  }
  const answer = await call.panel<{ id: string; method: string; url: string }>({ op: 'new', init, select: arg<boolean | undefined>(call, 'select') !== false });
  return text(`Created ${code(answer.id)} ${answer.method} ${urlOut(answer.url, redactionOf(call.settings))} (a request of your own: edit it with edit_request, send it with send_request).`);
};

const requestsDuplicate: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const answer = await call.panel<{ id: string }>({ op: 'duplicate', entryId, select: arg<boolean | undefined>(call, 'select') !== false });
  return text(`Duplicated ${code(entryId)} as ${code(answer.id)} (as it would be sent now, edits included).`);
};

const requestsRemove: Op = async (call) => {
  const ids = arg<string[]>(call, 'requestIds');
  const answer = await call.panel<{ removed: number; total: number }>({ op: 'remove', entryIds: ids });
  return text(`Removed ${answer.removed} request(s) from the list (${answer.total} removed in all; requests restore brings them back).`);
};

const requestsRestore: Op = async (call) => {
  const ids = arg<string[] | undefined>(call, 'requestIds');
  const answer = await call.panel<{ total: number }>({ op: 'restore', ...(ids ? { entryIds: ids } : {}) });
  return text(`Restored ${ids ? `${ids.length} request(s)` : 'every removed request'} (${answer.total} still removed).`);
};

const requestsResend: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const runId = arg<string | undefined>(call, 'runId');
  const timeoutMs = replayTimeoutOf(call.settings);
  const answer = await call.panel<{ run: TestRun }>({ op: 'resend', entryId, timeoutMs, ...(runId ? { runId } : {}) }, timeoutMs + 10_000);
  const run = runOut(answer.run, redactionOf(call.settings), arg<number | undefined>(call, 'maxBodyChars') ?? DEFAULT_MAX_BODY_CHARS, true);
  return { text: runId ? `Re-sent run ${code(runId)}'s request:` : 'Re-sent the captured request unchanged:', run: run as ControlResult['run'] };
};

const requestsCancel: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const runId = arg<string | undefined>(call, 'runId');
  const answer = await call.panel<{ cancelled: string[] }>({ op: 'cancel', entryId, ...(runId ? { runId } : {}) });
  return text(answer.cancelled.length ? `Cancelled ${answer.cancelled.map((id) => code(id)).join(', ')}.` : 'No run of this request is in flight.');
};

const requestsSelectRun: Op = async (call) => {
  const entryId = await entryIdOf(call);
  await call.panel({ op: 'select_run', entryId, runId: arg<string>(call, 'runId') });
  return text(`The Test result tab of ${code(entryId)} shows run ${code(arg<string>(call, 'runId'))}.`);
};

const requestsClearRuns: Op = async (call) => {
  const entryId = await entryIdOf(call);
  await call.panel({ op: 'clear_runs', entryId });
  return text(`Cleared the run history of ${code(entryId)} (runs in flight are kept).`);
};

const requestsWsSend: Op = async (call) => {
  const wsId = arg<string>(call, 'wsId');
  await call.panel({ op: 'ws_send', wsId, text: arg<string>(call, 'text') });
  return text(`Sent ${formatBytes(new TextEncoder().encode(arg<string>(call, 'text')).length)} through the page's WebSocket ${code(wsId)} (it shows as a sent message).`);
};

const requestsWsClear: Op = async (call) => {
  await call.panel({ op: 'ws_clear' });
  return text('Cleared the WebSocket messages (and closed connections).');
};

// ------------------------------------------------------------------------------------------- edit_request

const editRequest: Op = async (call) => {
  const entryId = await entryIdOf(call);
  const { requestId: _id, ...edit } = call.args as unknown as DraftEditArgs & { requestId: string };
  const answer = await call.panel<PanelDraftResult>({ op: 'edit', entryId, edit });
  const ctx = redactionOf(call.settings);
  return text(
    `Edited ${code(entryId)}. Send it with send_request {id: "${entryId}"}; revert with edit_request {revert: ["all"]}.`,
    '',
    UNTRUSTED_NOTE,
    '',
    draftText(answer, ctx, DEFAULT_MAX_BODY_CHARS),
  );
};

// ------------------------------------------------------------------------------------------- list_config

async function writeRules(call: OpCall, rules: ListRule[], what: string): Promise<ControlResult> {
  await settingsPatchFor(call, { listRules: rules });
  return text(what, '', await visibleSummary(call), rulesTable(rules, redactionOf(call.settings)));
}

/** "N of M requests shown" in the target tab, when it can tell. */
async function visibleSummary(call: OpCall): Promise<string> {
  try {
    const tabId = await call.tab();
    const list = await fetchList(call.deps.handlers, tabId);
    const panel = await call.panelIfMounted<PanelStateResult>({ op: 'state' }).catch(() => null);
    const visible = overlayVisibleIds(list.rows, call.deps.settings(), panel ? { textFilter: panel.textFilter, removedIds: panel.removedIds } : null);
    return `The list of tab ${tabId} shows ${visible.size} of ${list.rows.length} request(s).`;
  } catch {
    return '';
  }
}

const listTypes: Op = async (call) => {
  const raw = arg<string[]>(call, 'types');
  const types = raw.includes('all') ? [] : normalizeListTypes(raw);
  await settingsPatchFor(call, { listTypes: types });
  return text(`Types filter: ${typesText(types)}.`, await visibleSummary(call));
};

const listAddRule: Op = async (call) => {
  const a = call.args as unknown as RuleArgs;
  const rules = call.deps.settings().listRules;
  let spec: Parameters<typeof addRule>[1];
  if (a.method) spec = { mode: a.mode, pattern: '', exact: true, method: a.method.toUpperCase() };
  else if (a.template || a.requestId) {
    let template = a.template ?? '';
    if (a.requestId) {
      const entry = await entryOf(call);
      template = templateKeyOf(entry.url);
    }
    spec = { mode: a.mode, pattern: '', exact: true, template };
  } else {
    const u = new URL(a.url!);
    spec = { mode: a.mode, pattern: `${u.origin}${u.pathname}`, exact: a.exact === true };
  }
  const done = addRule(rules, spec, { id: uid('r'), now: Date.now() });
  switch (done.outcome) {
    case 'invalid':
      throw new BridgeError(spec.template ? `"${spec.template}" is not an endpoint template (e.g. https://api.example.com/users/{id}); pass requestId to use a request's endpoint` : 'This URL cannot be used for a rule');
    case 'limit':
      throw new BridgeError('There are too many list rules — delete some first (list_config delete_rule / clear_rules)');
    case 'exists':
      return text(`Already active: ${ruleDescription(done.rule!)} (rule ${code(done.rule!.id)}).`);
    default:
      return writeRules(call, done.rules, `${done.outcome === 'enabled' ? 'Re-enabled' : 'Added'} rule ${code(done.rule!.id)}: ${ruleDescription(done.rule!)}${spec.template ? ` (${templateKeyText(spec.template, true)})` : ''}.`);
  }
};

function ruleOf(call: OpCall): ListRule {
  const id = arg<string>(call, 'ruleId');
  const rule = call.deps.settings().listRules.find((r) => r.id === id);
  if (!rule) throw new BridgeError(`No list rule "${id}" — see inspect overlay`);
  return rule;
}

const listToggleRule: Op = async (call) => {
  const rule = ruleOf(call);
  const enabled = arg<boolean | undefined>(call, 'enabled');
  const rules = call.deps.settings().listRules;
  const next = enabled === undefined ? toggleRule(rules, rule.id) : setRuleEnabled(rules, rule.id, enabled);
  return writeRules(call, next, `Rule ${code(rule.id)} (${ruleLabel(rule, 80)}) is ${(next.find((r) => r.id === rule.id)?.enabled ?? false) ? 'on' : 'off'}.`);
};

const listDeleteRule: Op = async (call) => {
  const rule = ruleOf(call);
  return writeRules(call, removeRule(call.deps.settings().listRules, rule.id), `Deleted rule ${code(rule.id)} (${ruleLabel(rule, 80)}).`);
};

const listClearRules: Op = async (call) => {
  const n = call.deps.settings().listRules.length;
  return writeRules(call, [], `Deleted ${n} rule(s).`);
};

const listGroup: Op = async (call) => {
  const on = arg<boolean>(call, 'on');
  await settingsPatchFor(call, { listGroup: on });
  return text(`Group by endpoint is ${on ? 'on' : 'off'}.`);
};

const listUrlDisplay: Op = async (call) => {
  const value = arg<'template' | 'full'>(call, 'value');
  await settingsPatchFor(call, { urlDisplay: value });
  return text(`Request URLs are labelled by their ${value === 'template' ? 'endpoint template' : 'full path'}.`);
};

const listText: Op = async (call) => {
  const value = arg<string>(call, 'text');
  await call.panel({ op: 'text_filter', text: value });
  return text(value ? `The list's text filter is ${code(value)}.` : 'Cleared the list\'s text filter.', await visibleSummary(call));
};

// ------------------------------------------------------------------------------------------- setups

async function writeSetups(call: OpCall, patch: SettingsPatch, what: string): Promise<ControlResult> {
  await settingsPatchFor(call, patch);
  const s = call.deps.settings();
  return text(what, table(['setupId', 'name', 'group', 'sites', 'summary', ''], s.setups.map((x) => setupLine(x, s.activeSetupId)), 200));
}

const setupsSave: Op = async (call) => {
  const s = call.deps.settings();
  const name = arg<string>(call, 'name');
  const group = arg<string | undefined>(call, 'group') ?? '';
  if (findByName(s.setups, name, group)) throw new BridgeError(`A setup named "${name}" already exists${group ? ` in ${group}` : ''} — rename it, or update it (setups update)`);
  const state = await listConfigState(call, true);
  const config = captureConfig(state, { includeMode: arg<boolean | undefined>(call, 'includeMode') === true, includeLanguage: arg<boolean | undefined>(call, 'includeLanguage') ?? true });
  const withConfig = createSetup({ name, group, sites: arg<string[] | undefined>(call, 'sites') ?? [], config }, { id: uid('s'), now: Date.now() });
  if (!withConfig) throw new BridgeError('The setup name is empty');
  return writeSetups(call, { setups: [...s.setups, withConfig], activeSetupId: withConfig.id }, `Saved setup ${code(withConfig.name)} (${withConfig.id}): ${setupSummary(withConfig)}.`);
};

const setupsApply: Op = async (call) => {
  const setup = findSetup(call);
  const state = await listConfigState(call, true);
  const patch = applySetupPatch(setup, { now: Date.now(), newId: () => uid('r'), pageHost: state.pageHost ?? null, ...(state.siteLanguages ? { siteLanguages: state.siteLanguages } : {}) });
  await settingsPatchFor(call, patch);
  return text(`Applied setup ${code(setup.name)}: ${setupSummary(setup)}${patch.siteLanguages ? ' — the site language changed: reload the page to apply it everywhere' : ''}.`, await visibleSummary(call));
};

const setupsUpdate: Op = async (call) => {
  const setup = findSetup(call);
  const s = call.deps.settings();
  const config = captureConfig(await listConfigState(call, true), { includeMode: setup.config.defaultMode !== undefined, includeLanguage: setup.config.language !== undefined });
  return writeSetups(call, { setups: updateSetupConfig(s.setups, setup.id, config, Date.now()), activeSetupId: setup.id }, `Updated setup ${code(setup.name)} with the current list configuration.`);
};

const setupsRename: Op = async (call) => {
  const setup = findSetup(call);
  const s = call.deps.settings();
  return writeSetups(call, { setups: renameSetup(s.setups, setup.id, arg<string>(call, 'name'), Date.now()) }, `Renamed ${code(setup.name)} to ${code(arg<string>(call, 'name'))}.`);
};

const setupsMove: Op = async (call) => {
  const setup = findSetup(call);
  const s = call.deps.settings();
  return writeSetups(call, { setups: moveSetupToGroup(s.setups, setup.id, arg<string>(call, 'group'), Date.now()) }, `Moved ${code(setup.name)} to ${arg<string>(call, 'group') ? code(arg<string>(call, 'group')) : 'no group'}.`);
};

const setupsSites: Op = async (call) => {
  const setup = findSetup(call);
  const s = call.deps.settings();
  const next = setSetupSites(s.setups, setup.id, arg<string[]>(call, 'sites'), Date.now());
  const sites = next.find((x) => x.id === setup.id)?.sites ?? [];
  return writeSetups(call, { setups: next }, `Setup ${code(setup.name)} is applied automatically on: ${sites.length ? sites.join(', ') : 'no site'}.`);
};

const setupsDuplicate: Op = async (call) => {
  const setup = findSetup(call);
  const done = duplicateSetup(call.deps.settings().setups, setup.id, { id: uid('s'), now: Date.now() });
  if (!done.copy) throw new BridgeError('Could not duplicate: too many setups');
  return writeSetups(call, { setups: done.setups }, `Duplicated ${code(setup.name)} as ${code(done.copy.name)} (${done.copy.id}, without its sites).`);
};

const setupsDelete: Op = async (call) => {
  const setup = findSetup(call);
  const s = call.deps.settings();
  const done = removeSetup(s.setups, setup.id);
  return writeSetups(call, { setups: done.setups, ...(s.activeSetupId === setup.id ? { activeSetupId: null } : {}) }, `Deleted setup ${code(setup.name)}.`);
};

const setupsImport: Op = async (call) => {
  const parsed = parseSetupsFile(arg<string>(call, 'json'));
  if (!parsed.ok) throw new BridgeError(parsed.error);
  const s = call.deps.settings();
  const mode = arg<'merge' | 'replace' | undefined>(call, 'mode') ?? 'merge';
  const result = importSetups(s.setups, parsed.setups, mode, { now: Date.now(), newId: () => uid('s') });
  const keepActive = s.activeSetupId !== null && result.setups.some((x) => x.id === s.activeSetupId);
  return writeSetups(call, { setups: result.setups, ...(keepActive ? {} : { activeSetupId: null }) }, `${mode === 'replace' ? 'Replaced setups' : 'Imported setups'}: ${importSummary(result)}${parsed.invalid ? ` · ${parsed.invalid} invalid item(s) skipped` : ''}.`);
};

// ------------------------------------------------------------------------------------------- language

const languageSet: Op = async (call) => {
  const tabId = await call.tab();
  const language = call.deps.language;
  if (!language) throw new BridgeError('Site language is not available');
  const value = normalizeLanguageValue(arg<string>(call, 'value'));
  if (!value) throw new BridgeError(`"${arg<string>(call, 'value')}" is not a valid language list (e.g. "pt-BR" or "de-DE, en;q=0.8")`);
  const scope = arg<'tab' | 'site' | undefined>(call, 'scope') ?? 'tab';
  await language.load();
  if (scope === 'tab') {
    const status = await language.setTab(tabId, value);
    if (status.tab !== value) throw new BridgeError('The language could not be applied');
  } else {
    const host = await pageHostOf(call);
    if (!host) throw new BridgeError('This page has no site (http / https host) to save a language for — use scope "tab"');
    const current = call.deps.settings().siteLanguages;
    const next = withSiteLanguage(current, host, value);
    if (next[host] !== value) throw new BridgeError('Too many sites have a language — reset some first');
    await settingsPatchFor(call, { siteLanguages: next });
    if (language.status(tabId).tab) await language.setTab(tabId, null);
    await language.refresh(tabId);
  }
  const reload = arg<boolean | undefined>(call, 'reload') !== false;
  if (reload) await call.deps.browser.reload(tabId);
  return text(
    `Language ${code(value)} (${languageName(value.split(',')[0]!) ?? value}) applies to ${scope === 'tab' ? `tab ${tabId} until it closes` : `the site ${await pageHostOf(call)}`}: Accept-Language of its requests, navigator.language(s) and Intl defaults.`,
    reload ? 'The page was reloaded so the document request carries it too.' : 'Reload the page (overlay reload_page) to apply it everywhere.',
  );
};

const languageReset: Op = async (call) => {
  const tabId = await call.tab();
  const language = call.deps.language;
  if (!language) throw new BridgeError('Site language is not available');
  await language.load();
  if (language.status(tabId).tab) await language.setTab(tabId, null);
  const host = await pageHostOf(call);
  const current = call.deps.settings().siteLanguages;
  if (host && Object.prototype.hasOwnProperty.call(current, host)) {
    await settingsPatchFor(call, { siteLanguages: withSiteLanguage(current, host, null) });
    await language.refresh(tabId);
  }
  if (arg<boolean | undefined>(call, 'reload') !== false) await call.deps.browser.reload(tabId);
  return text(`Tab ${tabId} uses the browser's own languages again${host ? ` (no override for ${host})` : ''}.`);
};

// ------------------------------------------------------------------------------------------- settings

const settingsSet: Op = async (call) => {
  const values = arg<Record<string, unknown>>(call, 'values');
  const plan = planSettingsPatch(values, call.deps.settings());
  if (!plan.ok) throw new BridgeError(`Nothing was changed:\n${plan.errors.map((e) => `- ${e}`).join('\n')}`);
  const after = await call.deps.updateSettings(plan.patch as SettingsPatch);
  const shown = plan.changed.map((key) => {
    if (key === 'layout (reset)') return `- layout reset: ${JSON.stringify(after.layout)}`;
    const [top, sub] = key.split('.');
    const value = sub ? (after.layout as unknown as Record<string, unknown>)[sub] : (after as unknown as Record<string, unknown>)[top!];
    return `- ${key} = ${JSON.stringify(value)}`;
  });
  return text('Settings changed (values as stored, after validation):', ...shown);
};

// ------------------------------------------------------------------------------------------- errors

const errorsCapture: Op = async (call) => {
  const tabId = await call.tab();
  await call.plane.ensureVisible(tabId, call.call.activate === true);
  const key = arg<string>(call, 'key');
  const shot = await call.panel<{ id: string; width: number; height: number; component: string | null; data: string | null }>({ op: 'errors_capture', key }, CAPTURE_TIMEOUT_MS);
  const result = text(`Captured the error area of ${code(key)} (${shot.width} × ${shot.height} px${shot.component ? `, component ${code(shot.component)}` : ', the visible page: no component found'}); it is kept with the endpoint in the Errors view (${code(shot.id)}).`);
  if (shot.data) result.images = [{ data: shot.data, mimeType: 'image/png', width: shot.width, height: shot.height }];
  return result;
};

const errorsAnalyze: Op = async (call) => {
  const key = arg<string>(call, 'key');
  const waitMs = (arg<number | undefined>(call, 'waitSeconds') ?? 0) * 1000;
  const answer = await call.panel<{ run: PanelErrorRun | null }>({ op: 'errors_analyze', key, waitMs }, waitMs + 30_000);
  const run = answer.run;
  if (run && run.state !== 'running') {
    return text(`The analysis of ${code(key)} finished (${run.state}):`, '', UNTRUSTED_NOTE, '', runText(run, redactionOf(call.settings)));
  }
  return text(
    `Started a read-only Claude analysis of ${code(key)} in the site's project folder (run ${run ? code(run.id) : '?'}; plan mode, Read / Grep / Glob / LS; it uses Claude tokens).`,
    `Read the result with inspect errors {key: ${JSON.stringify(key)}} when it is done${waitMs ? ' (it did not finish within the wait)' : ''}.`,
  );
};

const errorsCancel: Op = async (call) => {
  const answer = await call.panel<{ cancelled: string[] }>({ op: 'errors_cancel', key: arg<string>(call, 'key') });
  return text(answer.cancelled.length ? `Cancelled ${answer.cancelled.map((id) => code(id)).join(', ')}.` : 'No Claude run of this endpoint is in progress.');
};

const errorsFix: Op = async (call) => {
  const tabId = await call.tab();
  const key = arg<string>(call, 'key');
  const pr = arg<boolean | undefined>(call, 'pr') === true;
  const answer = await call.panel<{ run: { id: string } | null }>({ op: 'errors_fix', key, pr }, 30_000);
  if (pr) await call.plane.reveal(tabId);
  return text(
    `Started a fix of ${code(key)} by Claude in a new git worktree (run ${answer.run ? code(answer.run.id) : '?'}; accept-edits mode, never in the user's checkout).`,
    pr
      ? 'When the diff is in, the pull request dialog opens in the overlay (shown now): the user reviews the commands and confirms the commit, push and PR there.'
      : 'Follow it with inspect errors {key}; errors commit / pull_request / discard open the confirmation dialogs for the user.',
  );
};

const errorsDialog =
  (dialog: 'issue' | 'commit' | 'pr' | 'discard'): Op =>
  async (call) => {
    const tabId = await call.tab();
    const key = arg<string>(call, 'key');
    await call.panel({ op: 'errors_dialog', key, dialog });
    await call.plane.reveal(tabId);
    const what = dialog === 'issue' ? 'create the GitHub issue' : dialog === 'commit' ? 'commit the fix' : dialog === 'pr' ? 'push the fix and open the pull request' : 'discard the fix worktree';
    return text(`Opened the dialog to ${what} for ${code(key)} in the kineReqLens overlay (now shown in tab ${tabId}). It shows the exact commands; nothing runs until the user confirms it there.`);
  };

// ------------------------------------------------------------------------------------------- screenshot / find

const screenshotCapture: Op = async (call) => {
  const tabId = await call.tab();
  await call.plane.ensureVisible(tabId, call.call.activate === true);
  const args = { ...call.args } as unknown as ShotCommandArgs;
  if (args.requestId !== undefined) args.requestId = await entryIdOf(call);
  const answer = await call.panel<{ result: PanelScreenshotResult; preview: { data: string; mimeType: string; width: number; height: number } }>({ op: 'screenshot', args, save: true }, SHOT_TIMEOUT_MS);
  if (args.open) await call.plane.reveal(tabId);
  const r = answer.result;
  const ctx = redactionOf(call.settings);
  const parts = [
    `Screenshot of tab ${tabId}: ${Math.round(r.area.width)} × ${Math.round(r.area.height)} CSS px at page ${Math.round(r.area.x)},${Math.round(r.area.y)} (padding ${r.padding} px) → ${r.image.width} × ${r.image.height} px image${answer.preview.width !== r.image.width ? ` (preview below: ${answer.preview.width} × ${answer.preview.height})` : ''}.`,
    r.path ? `Full resolution saved to ${r.path} (${formatBytes(r.bytes)}; kept 24 h; readable with the Read tool).` : `Full resolution not saved${r.saveError ? `: ${line(r.saveError, 200)}` : ''}.`,
  ];
  if (r.element) {
    // The element's selector and text are page data: untrusted, and redacted like find_in_page's matches.
    const elementText = r.element.text ? redactText(r.element.text, ctx) : '';
    parts.push(
      '',
      UNTRUSTED_NOTE,
      `Element: <${r.element.tag}> ${code(r.element.selector.slice(0, 300))}${elementText ? ` "${line(elementText, 160)}"` : ''}${r.matches !== undefined ? ` — match ${(r.matchIndex ?? 0) + 1} of ${r.matches}` : ''}.`,
    );
  }
  if (r.notes?.length) parts.push(...r.notes.map((n) => `Note: ${line(n, 300)}`));
  if (args.open) parts.push('The capture is open in the overlay\'s Screenshot view (now shown): the user can change the padding there.');
  return {
    text: parts.join('\n'),
    images: [{ data: answer.preview.data, mimeType: answer.preview.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png', width: answer.preview.width, height: answer.preview.height }],
  };
};

const findInPage: Op = async (call) => {
  const tabId = await call.tab();
  const args = { ...call.args } as unknown as FindCommandArgs;
  if (args.highlight) await call.plane.ensureVisible(tabId, call.call.activate === true);
  if (args.requestId !== undefined) args.requestId = await entryIdOf(call);
  const answer = await call.panel<FindCommandResult>({ op: 'find', args }, FIND_TIMEOUT_MS);
  return text(findText(answer, redactionOf(call.settings)));
};

// ------------------------------------------------------------------------------------------- table

export const OPS: Record<string, Op> = {
  'inspect.tabs': inspectTabs,
  'inspect.overlay': inspectOverlay,
  'inspect.setups': inspectSetups,
  'inspect.websocket': inspectWebsocket,
  'inspect.ws_messages': inspectWsMessages,
  'inspect.language': inspectLanguage,
  'inspect.settings': inspectSettings,
  'inspect.errors': inspectErrors,
  'inspect.run': inspectRun,
  'inspect.compare': inspectCompare,
  'inspect.snippet': inspectSnippet,
  'inspect.initiator': inspectInitiator,
  'inspect.source': inspectSource,
  'inspect.activity': inspectActivity,
  'overlay.open': overlayOpen,
  'overlay.close': overlayClose,
  'overlay.show': overlayShow,
  'overlay.hide': overlayHide,
  'overlay.minimize': overlayMinimize(true),
  'overlay.restore': overlayMinimize(false),
  'overlay.dock': overlayDock,
  'overlay.view': overlayView,
  'overlay.select': overlaySelect,
  'overlay.highlight': overlayHighlight,
  'overlay.reload_page': overlayReload,
  'overlay.use_tab': overlayUseTab,
  'overlay.activate_tab': overlayActivate,
  'requests.record': requestsRecord,
  'requests.preserve_log': requestsPreserve,
  'requests.clear': requestsClear,
  'requests.new': requestsNew,
  'requests.duplicate': requestsDuplicate,
  'requests.remove': requestsRemove,
  'requests.restore': requestsRestore,
  'requests.resend': requestsResend,
  'requests.cancel': requestsCancel,
  'requests.select_run': requestsSelectRun,
  'requests.clear_runs': requestsClearRuns,
  'requests.ws_send': requestsWsSend,
  'requests.ws_clear': requestsWsClear,
  'edit_request.edit': editRequest,
  'list_config.types': listTypes,
  'list_config.add_rule': listAddRule,
  'list_config.toggle_rule': listToggleRule,
  'list_config.delete_rule': listDeleteRule,
  'list_config.clear_rules': listClearRules,
  'list_config.group': listGroup,
  'list_config.url_display': listUrlDisplay,
  'list_config.text': listText,
  'setups.save': setupsSave,
  'setups.apply': setupsApply,
  'setups.update': setupsUpdate,
  'setups.rename': setupsRename,
  'setups.move': setupsMove,
  'setups.sites': setupsSites,
  'setups.duplicate': setupsDuplicate,
  'setups.delete': setupsDelete,
  'setups.import': setupsImport,
  'language.set': languageSet,
  'language.reset': languageReset,
  'settings.set': settingsSet,
  'errors.capture': errorsCapture,
  'errors.analyze': errorsAnalyze,
  'errors.cancel': errorsCancel,
  'errors.fix': errorsFix,
  'errors.issue': errorsDialog('issue'),
  'errors.commit': errorsDialog('commit'),
  'errors.pull_request': errorsDialog('pr'),
  'errors.discard': errorsDialog('discard'),
  'screenshot.capture': screenshotCapture,
  'find_in_page.find': findInPage,
};

export { OP_TIMEOUT_MS };
export type { BridgeListRow };
