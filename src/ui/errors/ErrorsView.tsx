// The Errors view (navigation rail item "Errors", docs/ARCHITECTURE.md §12, docs/CLAUDE_INTEGRATION.md "Errors
// view"): failing requests of this page grouped by endpoint (model.ts) with filter chips, the selected endpoint's
// calls, request / response (ResponseView), initiator summary and error-area screenshots, and the Claude actions:
//  - safe mode (default): Analyze with Claude (read-only run of the user's claude in the project folder), Open in
//    terminal (pre-filled, not submitted, fix / issue prompt), Copy issue, Copy image;
//  - full mode (settings.errorsFullMode): Create issue, Try fix (git worktree), Try fix + PR — with confirmation
//    dialogs (dialogs.tsx) showing the exact commands.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReqlensBridge, RequestEntry, Settings, SettingsPatch } from '../../shared/types';
import { withProjectFolder } from '../../shared/errors-settings';
import { ERROR_KIND_LABELS, buildFixPrompt, buildIssue, buildPullRequest, buildTerminalPrompt, outcomeText, stripAnalysisBlock } from '../../lib/errorPrompt';
import type { ErrorAnalysis } from '../../lib/errorPrompt';
import { formatClock, formatDuration, methodClass, statusClass } from '../../lib/format';
import { functionLabel, locationText, vscodeUrl } from '../../lib/initiator';
import type { InitiatorAnalysis } from '../../lib/initiator';
import { Icon } from '../components/Icon';
import { copyText } from '../components/clipboard';
import { toast } from '../components/toast';
import { initiatorAnalysisOf } from '../detail/initiatorState';
import { useBridgeStatus } from '../panel/claudeLink';
import { HeadersTable } from '../response/HeadersView';
import { ResponseView } from '../response/ResponseView';
import { entryToResponseData } from '../response/adapters';
import { ResultView } from '../screenshot/ResultView';
import { analysisText, pageUrlOf, requestSummaryOf } from '../screenshot/sendContext';
import type { ShotSendContext } from '../screenshot/sendModel';
import { useScreenshotStyles } from '../screenshot/styles';
import { FolderPicker } from '../terminal/FolderPicker';
import { setTerminalPaneOpen, terminalStore } from '../terminal/session';
import { terminalUnavailableReason } from '../terminal/texts';
import { analyzeGroup, captureForGroup, contextForGroup, copyShot, pageHostOf, projectFolderOf, shotBase64 } from './automation';
import { waitReasonText } from './autoShot';
import type { AutoShotState } from './autoShot';
import { CommitDialog, DiscardDialog, PublishDialog } from './dialogs';
import { ERROR_FILTERS, KIND_BADGE, filterCounts, filterGroups } from './model';
import type { ErrorFilter, ErrorGroup } from './model';
import {
  autoShotOf,
  cancelRun,
  findErrorShot,
  loadDiff,
  isSeen,
  latestAnalysis,
  loadStoredAnalyses,
  markSeen,
  removeErrorShot,
  runsOf,
  setShotAnnotations,
  shotsOf,
  startRun,
  storedAnalysis,
  updateRun,
  useErrorsStore,
} from './store';
import type { ErrorShot, RunRecord } from './store';
import { onErrorsRequest, peekErrorsRequest, takeErrorsDialog, takeErrorsRequest } from './requests';

export interface ErrorsViewProps {
  bridge: ReqlensBridge;
  entries: readonly RequestEntry[];
  groups: readonly ErrorGroup[];
  settings: Settings;
  onChange(patch: SettingsPatch): void;
  /** The view is shown (marks endpoints as seen). */
  active: boolean;
  /** Select a call in the Requests view. */
  onShowRequest(entryId: string): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasActivation(): boolean {
  try {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
  } catch {
    return true;
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** The path template of a group (without scheme and host). */
function pathOf(group: ErrorGroup): string {
  const at = group.host ? group.template.indexOf(group.host) : -1;
  return at >= 0 ? group.template.slice(at + group.host.length) || '/' : group.template;
}

function kindClass(kind: ErrorGroup['kind']): string {
  return kind === '5xx' ? 'rl-status--5xx' : kind === '4xx' ? 'rl-status--4xx' : 'rl-status--error';
}

// ------------------------------------------------------------------------------------------------ view

export function ErrorsView({ bridge, entries, groups, settings, onChange, active, onShowRequest }: ErrorsViewProps) {
  useErrorsStore();
  const rootRef = useRef<HTMLDivElement>(null);
  useScreenshotStyles(rootRef);
  const [filter, setFilter] = useState<ErrorFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => loadStoredAnalyses(), []);
  // The Claude Code control plane (src/ui/errors/requests.ts): show an endpoint; its Claude section opens a dialog.
  useEffect(() => {
    const apply = () => {
      const request = peekErrorsRequest();
      if (!request) return;
      setFilter('all');
      setSelectedKey(request.key);
      if (!request.dialog) takeErrorsRequest(request.key);
    };
    apply();
    return onErrorsRequest(apply);
  }, []);

  useEffect(() => {
    if (active) markSeen(groups.map((g) => g.key));
  }, [active, groups]);

  const counts = useMemo(() => filterCounts(groups), [groups]);
  const shown = useMemo(() => filterGroups(groups, filter), [groups, filter]);
  const selected = shown.find((g) => g.key === selectedKey) ?? shown[0] ?? null;
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e] as const)), [entries]);
  const host = pageHostOf(bridge, selected ? entryById.get(selected.entryIds[0]!) : null);
  const folder = projectFolderOf(settings, host);

  const chooseFolder = (dir: string): string | null => {
    if (!host) return 'This page has no host name to remember a folder for';
    onChange({ projectFolders: withProjectFolder(settings.projectFolders, host, dir) });
    setPicking(false);
    return null;
  };

  return (
    <div ref={rootRef} class="rl-errors" data-testid="rl-errors-view" data-count={groups.length}>
      <div class="rl-errors__head">
        <div class="rl-errors__title">
          <Icon name="warning" size={14} />
          <span>Errors</span>
          <span class="rl-faint" data-testid="rl-errors-total">
            {groups.length} endpoint{groups.length === 1 ? '' : 's'}
          </span>
        </div>
        <div class="rl-errors__chips" role="group" aria-label="Filter errors" data-testid="rl-errors-filters">
          {ERROR_FILTERS.map((f) => (
            <button
              type="button"
              class={`rl-errors__chip${filter === f.id ? ' rl-errors__chip--on' : ''}`}
              aria-pressed={filter === f.id ? 'true' : 'false'}
              data-testid="rl-errors-filter"
              data-filter={f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span class="rl-errors__chip-count" data-testid="rl-errors-filter-count">
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>
        <span class="rl-spacer" />
        <div class="rl-errors__folder" data-testid="rl-errors-folder" data-folder={folder ?? ''} data-host={host ?? ''}>
          <Icon name="folder" size={12} />
          <span class="rl-faint">Project{host ? ` for ${host}` : ''}:</span>
          <code class="rl-mono rl-truncate" title={folder ?? ''}>
            {folder ?? 'not set'}
          </code>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-folder-change" disabled={!host} onClick={() => setPicking(!picking)}>
            {folder ? 'Change' : 'Choose…'}
          </button>
          {folder ? (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              title="Forget this folder"
              aria-label="Forget the project folder"
              data-testid="rl-errors-folder-clear"
              onClick={() => host && onChange({ projectFolders: withProjectFolder(settings.projectFolders, host, null) })}
            >
              <Icon name="close" size={11} />
            </button>
          ) : null}
        </div>
      </div>
      {picking ? (
        <div class="rl-errors__picker" data-testid="rl-errors-folder-picker">
          <FolderPicker
            recentDirs={settings.claudeRecentDirs}
            failed={null}
            autoFocus
            heading={`Project folder for ${host ?? 'this site'}`}
            actionLabel="Use this folder"
            onStart={chooseFolder}
          />
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost rl-errors__picker-close" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div class="rl-empty rl-errors__empty" data-testid="rl-errors-empty">
          <span class="rl-errors__art" aria-hidden="true">
            <Icon name="check" size={22} />
          </span>
          <div class="rl-empty__title">No failing requests on this page</div>
          <div class="rl-empty__text">
            HTTP 4xx / 5xx responses, network and CORS errors, timeouts and aborted requests show up here, grouped by endpoint.
          </div>
        </div>
      ) : (
        <div class="rl-errors__body">
          <div class="rl-errors__list" role="listbox" aria-label="Failing endpoints" data-testid="rl-errors-list">
            {shown.length === 0 ? <div class="rl-faint rl-errors__none">No endpoint matches this filter.</div> : null}
            {shown.map((g) => (
              <GroupRow key={g.key} group={g} selected={g.key === selected?.key} onSelect={() => setSelectedKey(g.key)} />
            ))}
          </div>
          {selected ? (
            <GroupDetail
              key={selected.key}
              bridge={bridge}
              group={selected}
              entryById={entryById}
              settings={settings}
              folder={folder}
              onChooseFolder={() => setPicking(true)}
              onShowRequest={onShowRequest}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function GroupRow({ group, selected, onSelect }: { group: ErrorGroup; selected: boolean; onSelect(): void }) {
  const isNew = !isSeen(group.key);
  const analyzed = !!latestAnalysis(group.key);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected ? 'true' : 'false'}
      class={`rl-errors__row${selected ? ' rl-errors__row--selected' : ''}`}
      data-testid="rl-errors-group"
      data-key={group.key}
      data-kind={group.kind}
      data-count={group.count}
      data-status={group.lastStatus ?? ''}
      data-new={isNew ? 'true' : 'false'}
      title={group.endpoint}
      onClick={onSelect}
    >
      <span class="rl-errors__row-top">
        <span class={`rl-badge rl-badge--${methodClass(group.method)}`}>{group.method}</span>
        <span class="rl-mono rl-truncate rl-errors__row-name">{pathOf(group)}</span>
        {isNew ? <span class="rl-errors__new" aria-label="new" /> : null}
      </span>
      <span class="rl-errors__row-meta">
        <span class={`rl-status ${kindClass(group.kind)}`}>{group.lastStatus ?? KIND_BADGE[group.kind]}</span>
        {group.lastStatus ? <span class="rl-faint">{KIND_BADGE[group.kind]}</span> : null}
        <span class="rl-errors__row-count" data-testid="rl-errors-group-count">
          ×{group.count}
        </span>
        {analyzed ? (
          <span class="rl-errors__row-analyzed" title="Analyzed by Claude">
            <Icon name="check" size={10} /> analyzed
          </span>
        ) : null}
        <span class="rl-spacer" />
        <span class="rl-faint rl-truncate rl-errors__row-host">{group.host}</span>
        <span class="rl-faint">· {ago(group.lastSeen)}</span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ detail

interface GroupDetailProps {
  bridge: ReqlensBridge;
  group: ErrorGroup;
  entryById: ReadonlyMap<string, RequestEntry>;
  settings: Settings;
  folder: string | null;
  onChooseFolder(): void;
  onShowRequest(entryId: string): void;
}

function GroupDetail({ bridge, group, entryById, settings, folder, onChooseFolder, onShowRequest }: GroupDetailProps) {
  const calls = group.entryIds.map((id) => entryById.get(id)).filter((e): e is RequestEntry => !!e);
  const [callId, setCallId] = useState<string | null>(null);
  const call = calls.find((c) => c.id === callId) ?? calls[0] ?? null;
  const newest = calls[0] ?? null;
  const [initiator, setInitiator] = useState<InitiatorAnalysis | null>(null);
  useEffect(() => {
    let live = true;
    setInitiator(null);
    if (newest) void initiatorAnalysisOf(newest).then((a) => live && setInitiator(a), () => undefined);
    return () => {
      live = false;
    };
  }, [newest?.id]);

  if (!newest || !call) return <div class="rl-errors__detail" />;
  return (
    <div class="rl-errors__detail" data-testid="rl-errors-detail" data-key={group.key}>
      <div class="rl-errors__detail-head">
        <span class={`rl-badge rl-badge--${methodClass(group.method)}`}>{group.method}</span>
        <span class="rl-mono rl-errors__endpoint" title={group.endpoint}>
          {group.template}
        </span>
      </div>
      <div class="rl-errors__facts">
        <span class={`rl-status ${kindClass(group.kind)}`} data-testid="rl-errors-outcome">
          {group.lastStatus ?? KIND_BADGE[group.kind]}
        </span>
        <span>{outcomeText({ kind: group.kind, status: newest.status, statusText: newest.statusText, errorText: newest.error })}</span>
        <span class="rl-faint">·</span>
        <span>{ERROR_KIND_LABELS[group.kind]}</span>
        <span class="rl-faint">·</span>
        <span data-testid="rl-errors-detail-count">
          {group.count} call{group.count === 1 ? '' : 's'}
        </span>
        <span class="rl-faint">
          · first {formatClock(group.firstSeen)} · last {formatClock(group.lastSeen)}
        </span>
      </div>

      <ClaudeSection bridge={bridge} group={group} newest={newest} settings={settings} folder={folder} onChooseFolder={onChooseFolder} />

      <ShotsSection bridge={bridge} group={group} newest={newest} />

      <InitiatorSummary analysis={initiator} entry={newest} settings={settings} />

      <section class="rl-errors__section" data-testid="rl-errors-calls">
        <div class="rl-errors__section-title">Calls</div>
        <div class="rl-errors__calls">
          {calls.slice(0, 50).map((c) => (
            <button
              type="button"
              class={`rl-errors__call${c.id === call.id ? ' rl-errors__call--on' : ''}`}
              data-testid="rl-errors-call"
              data-entry-id={c.id}
              onClick={() => setCallId(c.id)}
            >
              <span class="rl-mono rl-faint">{formatClock(c.startTime)}</span>
              <span class={`rl-status ${statusClass(c.status, c.state)}`}>{c.status ?? c.state}</span>
              <span class="rl-mono rl-truncate rl-errors__call-url" title={c.url}>
                {c.url}
              </span>
              <span class="rl-faint">{c.endTime ? formatDuration(c.endTime - c.startTime) : ''}</span>
            </button>
          ))}
        </div>
        <div class="rl-errors__response" data-testid="rl-errors-response">
          <ResponseView
            response={entryToResponseData(call)}
            testId="rl-errors-response-view"
            summaryExtra={
              <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-show-request" onClick={() => onShowRequest(call.id)}>
                <Icon name="requests" size={11} /> Open in Requests
              </button>
            }
            extraTabs={[{ id: 'request', label: 'Request', render: () => <RequestSummary entry={call} /> }]}
          />
        </div>
      </section>
    </div>
  );
}

function RequestSummary({ entry }: { entry: RequestEntry }) {
  const body = entry.requestBody;
  const text = body?.kind === 'text' ? body.text : body?.kind === 'formFields' ? body.fields.map((f) => `${f.name}=${f.value}`).join('&') : body ? `<${body.kind} body>` : '';
  return (
    <div class="rl-errors__request" data-testid="rl-errors-request">
      <div class="rl-mono rl-errors__request-line">
        {entry.method} {entry.url}
      </div>
      <HeadersTable headers={entry.wire?.requestHeaders ?? entry.requestHeaders} />
      {text ? <pre class="rl-mono rl-errors__pre">{text.slice(0, 20_000)}</pre> : null}
    </div>
  );
}

function InitiatorSummary({ analysis, entry, settings }: { analysis: InitiatorAnalysis | null; entry: RequestEntry; settings: Settings }) {
  const top = analysis && analysis.initiatorIndex >= 0 ? analysis.frames[analysis.initiatorIndex]! : null;
  const link = top?.original ? vscodeUrl(top.original.source, top.original.line, top.original.col, settings.editorRoot) : null;
  return (
    <section class="rl-errors__section" data-testid="rl-errors-initiator" data-component={analysis?.component?.name ?? ''}>
      <div class="rl-errors__section-title">Initiator</div>
      {!entry.initiatorStack ? (
        <div class="rl-faint">No call stack recorded for this request (made before the overlay opened, or not a fetch / XHR).</div>
      ) : !analysis ? (
        <div class="rl-faint">
          <span class="rl-spinner" aria-hidden="true" /> Resolving source maps…
        </div>
      ) : (
        <div class="rl-errors__initiator">
          <div>
            <span class="rl-faint">Component </span>
            <code class="rl-mono" data-testid="rl-errors-initiator-component">
              {analysis.component?.name ?? '—'}
            </code>
            {analysis.component?.hook ? <span class="rl-faint"> via {analysis.component.hook}</span> : null}
          </div>
          {top ? (
            <div>
              <span class="rl-faint">Call site </span>
              <code class="rl-mono" data-testid="rl-errors-initiator-frame">
                {locationText(top)}
              </code>
              <span class="rl-faint"> in {functionLabel(top)}</span>
              {link ? (
                <a class="rl-export-link rl-errors__link" href={link} title="Open in VS Code">
                  <Icon name="external" size={11} /> VS Code
                </a>
              ) : null}
            </div>
          ) : (
            <div class="rl-faint">No app frame in the stack (library / framework code only).</div>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ screenshots

/** "Send to Claude" context of an error screenshot: page, the failing call, the endpoint's latest analysis. */
function errorShotContext(bridge: ReqlensBridge, group: ErrorGroup, newest: RequestEntry): ShotSendContext {
  const settings = bridge.getSettings();
  const ctx: ShotSendContext = { entryId: newest.id, request: requestSummaryOf(newest, settings) };
  const pageUrl = pageUrlOf(bridge, settings);
  if (pageUrl) ctx.pageUrl = pageUrl;
  const analysis = latestAnalysis(group.key);
  if (analysis) ctx.analysis = analysisText(analysis);
  return ctx;
}

/** How the endpoint's automatic screenshot went, when it did not simply succeed. */
function AutoShotNote({ state }: { state: AutoShotState }) {
  if (state.state !== 'waiting' && state.state !== 'skipped' && state.state !== 'failed') return null;
  const reason = state.state === 'failed' ? '' : state.reason;
  let text: string;
  if (state.state === 'waiting') text = `Automatic screenshot waiting: ${waitReasonText(state.reason)}.`;
  else if (state.state === 'skipped') text = `Automatic screenshot skipped — busy (${waitReasonText(state.reason)}). “Capture error area” takes it now.`;
  else text = `Automatic screenshot failed: ${state.error}. “Capture error area” tries again.`;
  return (
    <div
      class={`rl-errors__note rl-errors__auto-shot${state.state === 'failed' ? ' rl-errors__note--error' : ''}`}
      role="status"
      data-testid="rl-errors-auto-shot"
      data-state={state.state}
      data-reason={reason}
    >
      {state.state === 'waiting' ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name={state.state === 'failed' ? 'warning' : 'camera'} size={11} />}
      <span>{text}</span>
    </div>
  );
}

function ShotsSection({ bridge, group, newest }: { bridge: ReqlensBridge; group: ErrorGroup; newest: RequestEntry }) {
  const shots = shotsOf(group.key);
  const auto = autoShotOf(group.key);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const viewing = findErrorShot(open);
  const capture = () => {
    setBusy(true);
    captureForGroup(bridge, group.key, newest).then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false);
        toast(`Could not capture: ${errorText(err)}`, 'error');
      },
    );
  };
  return (
    <section class="rl-errors__section" data-testid="rl-errors-shots" data-count={shots.length}>
      <div class="rl-errors__section-title">
        Screenshot
        <span class="rl-spacer" />
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-capture" disabled={busy} onClick={capture}>
          {busy ? <span class="rl-spinner" aria-hidden="true" /> : <Icon name="camera" size={12} />}
          Capture error area
        </button>
      </div>
      {auto ? <AutoShotNote state={auto} /> : null}
      {shots.length === 0 ? (
        <div class="rl-faint">No screenshot yet. “Capture error area” captures the component that made the request (or the visible page).</div>
      ) : (
        <div class="rl-errors__shots">
          {shots.map((s) => (
            <button
              type="button"
              class="rl-errors__shot"
              data-testid="rl-errors-shot"
              data-area={s.area}
              data-component={s.component ?? ''}
              data-auto={s.auto ? 'true' : 'false'}
              data-width={Math.round(s.width / s.scale)}
              data-height={Math.round(s.height / s.scale)}
              title={`${s.area === 'component' ? `Component ${s.component}` : 'Visible page'} — ${Math.round(s.width / s.scale)} × ${Math.round(s.height / s.scale)} (open, annotate, copy)`}
              onClick={() => setOpen(s.id)}
            >
              {s.thumbUrl ? <img src={s.thumbUrl} alt="" /> : <Icon name="camera" size={16} />}
              <span class="rl-errors__shot-label rl-truncate">{s.area === 'component' ? s.component : 'Page'}</span>
            </button>
          ))}
        </div>
      )}
      {viewing ? (
        <div class="rl-errors__backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div class="rl-errors__dialog rl-errors__dialog--wide" role="dialog" aria-modal="true" aria-label="Screenshot" data-testid="rl-errors-shot-view">
            <div class="rl-errors__dialog-head">
              <span class="rl-errors__dialog-title">{viewing.area === 'component' ? `Component ${viewing.component}` : 'Visible page'}</span>
              <span class="rl-spacer" />
              <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-errors-shot-copy" onClick={() => void copyShot(viewing)}>
                <Icon name="copy" size={11} /> Copy image
              </button>
              <button
                type="button"
                class="rl-btn rl-btn--sm rl-btn--ghost"
                data-testid="rl-errors-shot-remove"
                onClick={() => {
                  removeErrorShot(viewing.id);
                  setOpen(null);
                }}
              >
                <Icon name="trash" size={11} /> Remove
              </button>
              <button type="button" class="rl-icon-btn rl-icon-btn--sm" aria-label="Close" data-testid="rl-errors-shot-close" onClick={() => setOpen(null)}>
                <Icon name="close" size={12} />
              </button>
            </div>
            <div class="rl-errors__shot-stage">
              <ResultView item={viewing} onAnnotations={setShotAnnotations} sendContext={() => errorShotContext(bridge, group, newest)} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ Claude

type DialogState =
  | { kind: 'issue'; title: string; body: string }
  | { kind: 'pr'; run: RunRecord; title: string; body: string; message: string }
  | { kind: 'commit'; run: RunRecord; message: string }
  | { kind: 'discard'; run: RunRecord }
  | null;

interface ClaudeSectionProps {
  bridge: ReqlensBridge;
  group: ErrorGroup;
  newest: RequestEntry;
  settings: Settings;
  folder: string | null;
  onChooseFolder(): void;
}

function ClaudeSection({ group, newest, settings, folder, onChooseFolder }: ClaudeSectionProps) {
  const status = useBridgeStatus();
  const runs = runsOf(group.key);
  const running = runs.find((r) => r.state === 'running');
  const full = settings.errorsFullMode;
  const [dialog, setDialog] = useState<DialogState>(null);
  const reason = !settings.claudeBridge ? 'The Claude Code bridge is off — enable it in Settings → Claude Code' : terminalUnavailableReason(status);
  const analysis: ErrorAnalysis | null = latestAnalysis(group.key);
  const stored = storedAnalysis(group.key);
  const noFolder = !folder;
  const disabled = !!reason || noFolder;
  const shot = shotsOf(group.key)[0] ?? null;

  // "Try fix + PR": once the fix's diff is in, open the pull request dialog (once).
  const pending = runs.find((r) => r.kind === 'fix' && r.wantPr && !r.prOffered && r.diff && r.state === 'done' && !r.discarded);
  useEffect(() => {
    if (!pending || dialog || !folder) return;
    updateRun(pending.id, { prOffered: true });
    void contextForGroup(group, newest, settings).then((ctx) => {
      const pr = buildPullRequest(ctx, pending.analysis ?? analysis, pending.diff?.stat ?? '');
      setDialog({ kind: 'pr', run: pending, title: pr.title, body: pr.body, message: pr.commitMessage });
    });
  }, [pending?.id, pending?.diff, folder]);

  const analyze = () => {
    if (!folder || !hasActivation()) return;
    void analyzeGroup(group, newest, settings, folder).then((r) => {
      if (!r.ok) toast(r.error, 'error');
    });
  };

  const tryFix = (wantPr: boolean) => {
    if (!folder || !hasActivation()) return;
    void (async () => {
      const ctx = await contextForGroup(group, newest, settings);
      const image = shot ? await shotBase64(shot).catch(() => null) : null;
      const started = startRun({ key: group.key, kind: 'fix', cwd: folder, prompt: buildFixPrompt(ctx, analysis), slug: analysis?.title || group.template, ...(image ? { image } : {}), wantPr });
      if (!started.ok) toast(started.error, 'error');
    })();
  };

  const openTerminal = (mode: 'fix' | 'issue') => {
    if (!folder) return;
    if (!hasActivation()) return;
    // Synchronously inside the click (a pty may only be opened from a user gesture): the prompt is filled in later.
    const store = terminalStore();
    let prompt = '';
    const started = store.start(folder, 120, 30, { prefill: ' ' });
    if (!started.ok) {
      toast(started.error, 'error');
      return;
    }
    setTerminalPaneOpen(true);
    const session = started.session;
    void contextForGroup(group, newest, settings).then((ctx) => {
      prompt = buildTerminalPrompt(ctx, analysis, mode);
      // Still waiting for the program to settle: replace the placeholder pre-fill.
      if (session.prefill !== undefined) session.prefill = prompt;
      else store.input(session.key, prompt.replace(/\s*\n\s*/g, ' '));
    });
    toast(mode === 'fix' ? 'Claude opens with the fix prompt typed in — review it and press Enter' : 'Claude opens with the issue prompt typed in — review it and press Enter', 'info');
  };

  const copyIssue = () => {
    void contextForGroup(group, newest, settings).then((ctx) => {
      const issue = buildIssue(ctx, analysis, shot ? { screenshotNote: 'A screenshot of the error area is attached below (paste it from kineReqLens → Copy image).' } : {});
      void copyText(`# ${issue.title}\n\n${issue.body}`, 'Issue copied (markdown)');
    });
  };

  const createIssue = () => {
    void contextForGroup(group, newest, settings).then((ctx) => {
      const issue = buildIssue(ctx, analysis);
      setDialog({ kind: 'issue', title: issue.title, body: issue.body });
    });
  };

  // A dialog the Claude Code control plane asked for (src/ui/errors/requests.ts): it only opens the dialog — the user
  // confirms the commands there, exactly as after a click.
  const live = useRef({ createIssue, analysis, full });
  live.current = { createIssue, analysis, full };
  useEffect(() => {
    const apply = () => {
      const wanted = takeErrorsDialog(group.key);
      if (!wanted || !live.current.full) return;
      if (wanted === 'issue') {
        live.current.createIssue();
        return;
      }
      const run = runsOf(group.key).find((r) => r.kind === 'fix' && r.worktree && !r.discarded);
      if (!run) {
        toast('There is no fix worktree for this endpoint — run Try fix first', 'warn');
        return;
      }
      if (wanted === 'discard') {
        setDialog({ kind: 'discard', run });
        return;
      }
      void contextForGroup(group, newest, settings).then((ctx) => {
        const pr = buildPullRequest(ctx, run.analysis ?? live.current.analysis, run.diff?.stat ?? '');
        setDialog(wanted === 'commit' ? { kind: 'commit', run, message: pr.commitMessage } : { kind: 'pr', run, title: pr.title, body: pr.body, message: pr.commitMessage });
      });
    };
    apply();
    return onErrorsRequest(apply);
  }, [group.key]);

  const btn = (testId: string, label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: () => void, opts: { primary?: boolean; disabled?: boolean; title?: string } = {}): JSX.Element => (
    <button
      type="button"
      class={`rl-btn rl-btn--sm${opts.primary ? ' rl-btn--primary' : ''}`}
      data-testid={testId}
      disabled={opts.disabled}
      title={opts.title}
      onClick={onClick}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );

  return (
    <section class="rl-errors__section rl-errors__claude" data-testid="rl-errors-claude" data-mode={full ? 'full' : 'safe'}>
      <div class="rl-errors__section-title">
        Claude
        <span class={`rl-errors__mode rl-errors__mode--${full ? 'full' : 'safe'}`} data-testid="rl-errors-mode" title={full ? 'Full mode: Claude may edit files in git worktrees; git / gh run after your confirmation' : 'Safe mode: read-only analysis'}>
          {full ? 'Full mode' : 'Safe mode'}
        </span>
      </div>
      {reason ? (
        <div class="rl-errors__note" data-testid="rl-errors-claude-unavailable">
          {reason}
        </div>
      ) : noFolder ? (
        <div class="rl-errors__note" data-testid="rl-errors-no-folder">
          Choose the project folder of this site so Claude can look at the code.
          <button type="button" class="rl-btn rl-btn--sm" onClick={onChooseFolder}>
            <Icon name="folder" size={11} /> Choose folder…
          </button>
        </div>
      ) : null}
      <div class="rl-errors__actions">
        {running && running.kind === 'analyze' ? (
          btn('rl-errors-cancel', 'Cancel analysis', 'stop', () => cancelRun(running.id))
        ) : (
          btn('rl-errors-analyze', analysis ? 'Analyze again' : 'Analyze with Claude', 'search', analyze, {
            primary: true,
            disabled: disabled || !!running,
            title: 'Runs your claude read-only (plan mode, Read / Grep / Glob / LS) in the project folder',
          })
        )}
        {btn('rl-errors-terminal-fix', 'Open in terminal', 'terminal', () => openTerminal('fix'), { disabled, title: 'Opens Claude in the project folder with a fix prompt typed in (not sent)' })}
        {btn('rl-errors-terminal-issue', 'Issue prompt', 'terminal', () => openTerminal('issue'), { disabled, title: 'Opens Claude in the project folder with an issue-writing prompt typed in (not sent)' })}
        {btn('rl-errors-copy-issue', 'Copy issue', 'copy', copyIssue, { title: 'Copies a markdown issue (title + body)' })}
        {full ? (
          <>
            <span class="rl-errors__sep" aria-hidden="true" />
            {btn('rl-errors-create-issue', 'Create issue', 'upload', createIssue, { disabled, title: 'gh issue create in the project folder (after you confirm)' })}
            {btn('rl-errors-try-fix', 'Try fix', 'code', () => tryFix(false), { disabled: disabled || !!running, title: 'Claude fixes it in a new git worktree; you review the diff' })}
            {btn('rl-errors-try-fix-pr', 'Try fix + PR', 'send', () => tryFix(true), { disabled: disabled || !!running, title: 'Fix in a worktree, then commit, push and open a pull request after you confirm' })}
          </>
        ) : null}
      </div>
      {!runs.length && stored ? (
        <div class="rl-faint rl-errors__stored" data-testid="rl-errors-stored">
          Last analysis from {new Date(stored.at).toLocaleString()} (kept for this endpoint)
        </div>
      ) : null}
      {!runs.length && analysis ? <AnalysisCard analysis={analysis} folder={folder} /> : null}
      {runs.map((run, i) => (
        <RunView key={run.id} run={run} folder={folder} collapsed={i > 0} onDialog={setDialog} group={group} newest={newest} settings={settings} />
      ))}
      {dialog && folder ? (
        dialog.kind === 'issue' ? (
          <PublishDialog kind="issue" cwd={folder} title={dialog.title} body={dialog.body} shot={shot} onClose={() => setDialog(null)} onDone={(url) => toast(`Issue created: ${url}`, 'success')} />
        ) : dialog.kind === 'pr' ? (
          <PublishDialog
            kind="pr"
            cwd={folder}
            title={dialog.title}
            body={dialog.body}
            message={dialog.message}
            worktree={dialog.run.worktree!.path}
            branch={dialog.run.worktree!.branch}
            shot={shot}
            onClose={() => setDialog(null)}
            onDone={(url) => updateRun(dialog.run.id, { prUrl: url })}
          />
        ) : dialog.kind === 'commit' ? (
          <CommitDialog
            cwd={folder}
            worktree={dialog.run.worktree!.path}
            message={dialog.message}
            shot={shot}
            onClose={() => setDialog(null)}
            onDone={(sha) => {
              updateRun(dialog.run.id, { committed: sha });
              setDialog(null);
              toast(`Committed ${sha.slice(0, 8)} on ${dialog.run.worktree!.branch}`, 'success');
            }}
          />
        ) : (
          <DiscardDialog
            cwd={folder}
            worktree={dialog.run.worktree!.path}
            branch={dialog.run.worktree!.branch}
            onClose={() => setDialog(null)}
            onDone={() => {
              updateRun(dialog.run.id, { discarded: true });
              setDialog(null);
              toast('Worktree discarded', 'success');
            }}
          />
        )
      ) : null}
    </section>
  );
}

function fileLink(folder: string | null, path: string, line?: number): string | null {
  if (!folder || folder.startsWith('~')) return null;
  const abs = path.startsWith('/') ? path : `${folder.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`;
  return `vscode://file${encodeURI(abs)}${line ? `:${line}` : ''}`;
}

function AnalysisCard({ analysis, folder }: { analysis: ErrorAnalysis; folder: string | null }) {
  return (
    <div class="rl-errors__analysis" data-testid="rl-errors-analysis" data-kind={analysis.kind}>
      <div class="rl-errors__analysis-head">
        <span class="rl-errors__analysis-title" data-testid="rl-errors-analysis-title">
          {analysis.title}
        </span>
        <span class={`rl-errors__where rl-errors__where--${analysis.kind}`}>{analysis.kind}</span>
      </div>
      {analysis.summary ? <p class="rl-errors__p">{analysis.summary}</p> : null}
      {analysis.rootCause ? (
        <div>
          <div class="rl-errors__label">Root cause</div>
          <p class="rl-errors__p" data-testid="rl-errors-analysis-root">
            {analysis.rootCause}
          </p>
        </div>
      ) : null}
      {analysis.files.length ? (
        <div>
          <div class="rl-errors__label">Responsible code</div>
          <ul class="rl-errors__files" data-testid="rl-errors-analysis-files">
            {analysis.files.map((f) => {
              const href = fileLink(folder, f.path, f.line);
              const label = `${f.path}${f.line ? `:${f.line}` : ''}`;
              return (
                <li>
                  {href ? (
                    <a class="rl-mono rl-errors__link" href={href} title="Open in VS Code">
                      {label}
                    </a>
                  ) : (
                    <code class="rl-mono">{label}</code>
                  )}
                  {f.why ? <span class="rl-faint"> — {f.why}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {analysis.fixPlan ? (
        <div>
          <div class="rl-errors__label">Proposed fix</div>
          <p class="rl-errors__p">{analysis.fixPlan}</p>
        </div>
      ) : null}
    </div>
  );
}

interface RunViewProps {
  run: RunRecord;
  folder: string | null;
  collapsed: boolean;
  onDialog(d: DialogState): void;
  group: ErrorGroup;
  newest: RequestEntry;
  settings: Settings;
}

function RunView({ run, folder, collapsed, onDialog, group, newest, settings }: RunViewProps) {
  const label = run.kind === 'fix' ? 'Fix' : run.auto ? 'Automatic analysis' : 'Analysis';
  const cost = run.result?.costUsd;
  const last = run.log[run.log.length - 1];
  const prose = run.log.filter((l) => !(l === last && l.type === 'text' && run.result && stripAnalysisBlock(l.text) === ''));
  const content = (
    <>
      <div class="rl-errors__log" data-testid="rl-errors-run-log">
        {prose.length === 0 && run.state === 'running' ? (
          <div class="rl-faint">
            <span class="rl-spinner" aria-hidden="true" /> Starting Claude…
          </div>
        ) : null}
        {prose.map((l) =>
          l.type === 'text' ? (
            <div class="rl-errors__log-text">{run.result && l === last ? stripAnalysisBlock(l.text) : l.text}</div>
          ) : l.type === 'tool' ? (
            <div class="rl-errors__log-tool" data-testid="rl-errors-run-tool">
              <span class="rl-errors__tool-name">{l.name}</span> <span class="rl-mono rl-faint">{l.summary}</span>
            </div>
          ) : (
            <div class="rl-errors__log-note rl-faint">{l.text}</div>
          ),
        )}
      </div>
      {run.error ? (
        <div class="rl-errors__note rl-errors__note--error" data-testid="rl-errors-run-error">
          {run.error}
        </div>
      ) : null}
      {run.analysis ? <AnalysisCard analysis={run.analysis} folder={folder} /> : null}
      {run.kind === 'fix' && run.worktree ? <FixPanel run={run} folder={folder} onDialog={onDialog} group={group} newest={newest} settings={settings} /> : null}
    </>
  );
  const head = (
    <>
      <span class={`rl-errors__run-state rl-errors__run-state--${run.state}`}>
        {run.state === 'running' ? <span class="rl-spinner" aria-hidden="true" /> : null}
        {label}
      </span>
      <span class="rl-faint">{run.state === 'running' ? 'running' : run.state}</span>
      {run.model ? <span class="rl-faint rl-mono">{run.model}</span> : null}
      <span class="rl-spacer" />
      {cost !== undefined ? (
        <span class="rl-faint" data-testid="rl-errors-run-cost" title="Reported by Claude Code">
          ${cost.toFixed(4)}
        </span>
      ) : null}
      {run.result?.durationMs !== undefined ? <span class="rl-faint">{formatDuration(run.result.durationMs)}</span> : null}
    </>
  );
  if (collapsed) {
    return (
      <details class="rl-errors__run" data-testid="rl-errors-run" data-state={run.state} data-kind={run.kind}>
        <summary class="rl-errors__run-head">{head}</summary>
        {content}
      </details>
    );
  }
  return (
    <div class="rl-errors__run" data-testid="rl-errors-run" data-state={run.state} data-kind={run.kind}>
      <div class="rl-errors__run-head">{head}</div>
      {content}
    </div>
  );
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <pre class="rl-mono rl-errors__diff-pre">
      {diff.split('\n').map((line) => (
        <span class={line.startsWith('+') && !line.startsWith('+++') ? 'rl-errors__add' : line.startsWith('-') && !line.startsWith('---') ? 'rl-errors__del' : line.startsWith('@@') ? 'rl-errors__hunk' : ''}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function FixPanel({ run, folder, onDialog, group, newest, settings }: { run: RunRecord; folder: string | null; onDialog(d: DialogState): void; group: ErrorGroup; newest: RequestEntry; settings: Settings }) {
  const tree = run.worktree!;
  const done = run.state === 'done' || run.state === 'error';
  const refresh = () => loadDiff(run);
  const withPr = async () => {
    const ctx = await contextForGroup(group, newest, settings);
    return buildPullRequest(ctx, run.analysis ?? latestAnalysis(group.key), run.diff?.stat ?? '');
  };
  return (
    <div class="rl-errors__fix" data-testid="rl-errors-fix" data-branch={tree.branch} data-worktree={tree.path} data-discarded={run.discarded ? 'true' : 'false'}>
      <div class="rl-errors__fix-head">
        <Icon name="code" size={12} />
        <code class="rl-mono rl-truncate" title={tree.path}>
          {tree.branch}
        </code>
        <span class="rl-spacer" />
        {run.committed ? <span class="rl-errors__tag" data-testid="rl-errors-committed">committed {run.committed.slice(0, 8)}</span> : null}
        {run.prUrl ? (
          <a class="rl-export-link" href={run.prUrl} target="_blank" rel="noopener noreferrer" data-testid="rl-errors-pr-url">
            Pull request
          </a>
        ) : null}
      </div>
      {run.discarded ? (
        <div class="rl-faint" data-testid="rl-errors-discarded">
          Worktree discarded.
        </div>
      ) : (
        <>
          {run.diffError ? <div class="rl-errors__note rl-errors__note--error">{run.diffError}</div> : null}
          {run.diff ? (
            <div class="rl-errors__diff" data-testid="rl-errors-diff" data-files={run.diff.files.length}>
              <pre class="rl-mono rl-errors__stat" data-testid="rl-errors-diff-stat">
                {run.diff.stat.trim() || 'No changes'}
              </pre>
              {run.diff.files.map((f, i) => (
                <details class="rl-errors__diff-file" data-testid="rl-errors-diff-file" data-path={f.path} open={i === 0}>
                  <summary>
                    <span class="rl-mono">{f.path}</span>
                    <span class="rl-errors__add"> +{f.additions}</span>
                    <span class="rl-errors__del"> −{f.deletions}</span>
                    {f.truncated ? <span class="rl-faint"> (truncated)</span> : null}
                  </summary>
                  <DiffLines diff={f.diff} />
                </details>
              ))}
              {run.diff.truncated ? <div class="rl-faint">The diff is longer than shown — open the worktree to see everything.</div> : null}
            </div>
          ) : done ? (
            <div class="rl-faint">
              <span class="rl-spinner" aria-hidden="true" /> Loading the diff…
            </div>
          ) : null}
          {done ? (
            <div class="rl-errors__actions">
              <a class="rl-btn rl-btn--sm" href={`vscode://file${encodeURI(tree.path)}`} data-testid="rl-errors-vscode" title="Open the worktree in VS Code">
                <Icon name="external" size={12} /> Open worktree in VS Code
              </a>
              <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-errors-diff-refresh" onClick={refresh}>
                <Icon name="reload" size={12} /> Refresh diff
              </button>
              <button
                type="button"
                class="rl-btn rl-btn--sm"
                data-testid="rl-errors-commit"
                disabled={!!run.committed}
                onClick={() => void withPr().then((pr) => onDialog({ kind: 'commit', run, message: pr.commitMessage }))}
              >
                <Icon name="check" size={12} /> Commit…
              </button>
              <button
                type="button"
                class="rl-btn rl-btn--sm"
                data-testid="rl-errors-open-pr"
                disabled={!!run.prUrl}
                onClick={() => void withPr().then((pr) => onDialog({ kind: 'pr', run, title: pr.title, body: pr.body, message: pr.commitMessage }))}
              >
                <Icon name="send" size={12} /> Push + PR…
              </button>
              <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost rl-btn--danger" data-testid="rl-errors-discard" onClick={() => onDialog({ kind: 'discard', run })}>
                <Icon name="trash" size={12} /> Discard…
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
