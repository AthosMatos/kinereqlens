// OWNER: ui-editor agent. Detail pane for the selected entry: editor (left/top) + results (right/bottom).
import { Component, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReqlensBridge, RequestEntry, TestRun, UrlDisplay } from '../../shared/types';
import { formatDuration, methodClass, statusClass } from '../../lib/format';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import { SplitPane } from '../components/SplitPane';
import { Tabs } from '../components/Tabs';
import { ExportPanel } from '../export/ExportPanel';
import { EndpointLabel, monoCharWidth } from '../list/EndpointChips';
import { endpointTemplate, layoutLabel } from '../list/endpointLabel';
import { useExportSettingsBinding } from '../export/hooks';
import { useElementSize, useSettings } from '../hooks';
import { entryToResponseDataWith } from '../response/adapters';
import { ResponseView } from '../response/ResponseView';
import { ResultsPanel } from '../response/ResultsPanel';
import { originalRevealKey } from '../find/reveal';
import { modifiedCountOf, sectionsOf } from './derived';
import {
  cancelRun,
  clearRuns,
  rawApplies,
  resendRun,
  resetDraft,
  revertAll,
  selectRun,
  useEntryRecord,
} from './draftStore';
import { EditorPane } from './Editor';
import { InitiatorPanel } from './InitiatorPanel';
import { onResultsTabRequest, takeRequestedTab } from './resultsTab';
import { errorMessage, memo, safely } from './util';

export interface RequestDetailProps {
  bridge: ReqlensBridge;
  entry: RequestEntry;
  /** Select (and show) another entry, e.g. the copy made by "Duplicate as new request". Must be stable. */
  onSelectEntry?(entryId: string): void;
}

/**
 * Detail width from which editor and results are shown side by side (the default 1200 px floating window at
 * 1440×900 leaves ~813 px next to the 44 px navigation rail and the list).
 */
const SIDE_BY_SIDE_MIN_WIDTH = 800;
/**
 * A short detail pane (bottom dock, small laptop screens) is also split side by side from this width:
 * stacked, two panes of ~250px each leave neither the body editor nor the response readable.
 */
const SHORT_SIDE_BY_SIDE_MIN_WIDTH = 720;
const SHORT_DETAIL_MAX_HEIGHT = 640;
/** Stacked and nothing sent yet: the editor gets most of the height (the results only show a hint). */
const STACKED_EDITOR_SHARE_BEFORE_RUN = 0.72;

/** Editor and results side by side ('row') or stacked ('column') for a detail pane of this size. */
export function detailDirection(width: number, height: number): 'row' | 'column' {
  if (width >= SIDE_BY_SIDE_MIN_WIDTH) return 'row';
  if (width >= SHORT_SIDE_BY_SIDE_MIN_WIDTH && height > 0 && height < SHORT_DETAIL_MAX_HEIGHT) return 'row';
  return 'column';
}
const SPLIT_SAVE_DELAY_MS = 400;
const DEFAULT_SPLIT = 0.55;

/**
 * Detail pane of the selected entry: header (method, URL, captured status, "N modified" + Revert all), then the
 * request editor and the results pane in a SplitPane — side by side from 800px of detail width (720px when the
 * pane is short), stacked below.
 * The split ratio comes from settings.layout.split and is persisted (debounced) when the divider moves.
 */
export function RequestDetail({ bridge, entry, onSelectEntry }: RequestDetailProps) {
  const settings = useSettings();
  const record = useEntryRecord(entry);
  const rootRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(rootRef);
  const direction = detailDirection(width, height);
  const [storedSplit, onSplit] = usePersistedSplit(bridge, settings.layout.split);
  // Every results tab but "Test result" has content before any run, so only that one gives the editor more room.
  const [contentTabShown, setContentTabShown] = useState(true);
  const hintOnly = record.runs.length === 0 && !contentTabShown;
  const split = direction === 'column' && hintOnly ? Math.max(storedSplit, STACKED_EDITOR_SHARE_BEFORE_RUN) : storedSplit;
  // Raw text that does not parse counts as an edit of the body (so "Revert all" can discard it).
  const rawError = rawApplies(record) && record.raw.error !== null;
  const modifiedCount = record.draft ? modifiedCountOf(record.draft) + (rawError && !sectionsOf(record.draft).body ? 1 : 0) : 0;
  const entryId = entry.id;
  const onRevertAll = useCallback(() => revertAll(entryId), [entryId]);
  const latestEntry = useRef(entry);
  latestEntry.current = entry;
  const onDiscard = useCallback(() => resetDraft(latestEntry.current), []);

  return (
    <div class="rl-detail" data-testid="rl-detail" data-entry-id={entry.id} ref={rootRef}>
      <DetailHeader
        entry={entry}
        modifiedCount={modifiedCount}
        onRevertAll={onRevertAll}
        urlDisplay={settings.urlDisplay === 'full' ? 'full' : 'template'}
      />
      <SplitPane
        class="rl-detail__split"
        direction={direction}
        size={split}
        onSizeChange={onSplit}
        minA={direction === 'row' ? 380 : 180}
        minB={direction === 'row' ? 300 : 140}
      >
        <PaneBoundary key={`editor:${entry.id}`} what="editor" onDiscard={onDiscard}>
          {record.draft ? (
            <EditorPane bridge={bridge} entry={entry} record={record} settings={settings} onSelectEntry={onSelectEntry} />
          ) : (
            <DraftError entry={entry} error={record.draftError} />
          )}
        </PaneBoundary>
        <PaneBoundary key={`results:${entry.id}`} what="results view">
          <ResultsArea
            bridge={bridge}
            entry={entry}
            runs={record.runs}
            activeRunId={record.activeRunId}
            onContentTabShown={setContentTabShown}
          />
        </PaneBoundary>
      </SplitPane>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- split

function sanitizeSplit(v: number): number {
  return Number.isFinite(v) && v > 0.05 && v < 0.95 ? v : DEFAULT_SPLIT;
}

/** Split ratio: applied immediately, persisted to settings (debounced, flushed on unmount). */
function usePersistedSplit(bridge: ReqlensBridge, stored: number): [number, (size: number) => void] {
  const [split, setSplit] = useState(() => sanitizeSplit(stored));
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: number } | null>(null);

  useEffect(() => {
    if (!pending.current) setSplit(sanitizeSplit(stored));
  }, [stored]);

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    try {
      bridge.updateSettings({ layout: { split: p.value } }).catch((err: unknown) => {
        console.warn('[reqlens] could not save the split size', err);
      });
    } catch (err) {
      console.warn('[reqlens] could not save the split size', err);
    }
  }, [bridge]);

  const onChange = useCallback(
    (size: number) => {
      const value = sanitizeSplit(size);
      setSplit(value);
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { value, timer: setTimeout(flush, SPLIT_SAVE_DELAY_MS) };
    },
    [flush],
  );

  useEffect(() => flush, [flush]);
  return [split, onChange];
}

// --------------------------------------------------------------------------------------------- header

interface DetailHeaderProps {
  entry: RequestEntry;
  modifiedCount: number;
  onRevertAll(): void;
  urlDisplay: UrlDisplay;
}

/** Room the expand + copy buttons and their gaps take inside the URL cell (px). */
const URL_BUTTONS_PX = 60;

/**
 * The captured URL: its endpoint template with id chips (the real values in their tooltips), elided to the room
 * the header leaves, or the raw URL ("Full path" setting); the full URL in the tooltip and, expanded, below.
 */
function DetailUrl({ entry, urlDisplay, open, onToggle }: { entry: RequestEntry; urlDisplay: UrlDisplay; open: boolean; onToggle(): void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { width } = useElementSize(ref);
  const template = endpointTemplate(entry.url);
  const budget = width > 0 && ref.current ? Math.floor((width - URL_BUTTONS_PX) / monoCharWidth(ref.current)) : 120;
  const layout = useMemo(() => layoutLabel(template, Math.max(12, budget)), [template, budget]);
  return (
    <span ref={ref} class="rl-detail__url-cell rl-mono">
      <span class="rl-detail__url rl-truncate" title={entry.url} data-testid="rl-detail-url" data-display={urlDisplay}>
        {urlDisplay === 'full' ? entry.url : <EndpointLabel template={template} layout={layout} />}
      </span>
      <button
        type="button"
        class="rl-icon-btn rl-icon-btn--sm rl-detail__url-expand"
        title={open ? 'Hide the full URL' : 'Show the full URL'}
        aria-label={open ? 'Hide the full URL' : 'Show the full URL'}
        aria-expanded={open ? 'true' : 'false'}
        data-testid="rl-detail-url-expand"
        onClick={onToggle}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      <button
        type="button"
        class="rl-icon-btn rl-icon-btn--sm"
        title="Copy the captured URL"
        aria-label="Copy captured URL"
        data-testid="rl-detail-copy-url"
        onClick={() => void copyText(entry.url, 'URL copied')}
      >
        <Icon name="copy" size={12} />
      </button>
    </span>
  );
}

/** "Show the full URL" stays on across entries for the page lifetime. */
let fullUrlOpen = false;

const DetailHeader = memo(function DetailHeader({ entry, modifiedCount, onRevertAll, urlDisplay }: DetailHeaderProps) {
  const duration = entry.endTime !== undefined ? entry.endTime - entry.startTime : undefined;
  const [open, setOpenState] = useState(fullUrlOpen);
  const toggle = () => {
    fullUrlOpen = !open;
    setOpenState(!open);
  };
  return (
    <>
    <div class="rl-detail__header">
      <span class={`rl-badge rl-badge--${safely(() => methodClass(entry.method), 'other')}`}>{entry.method}</span>
      <DetailUrl entry={entry} urlDisplay={urlDisplay} open={open} onToggle={toggle} />
      <span class="rl-detail__meta">
        <StatusPill entry={entry} />
        {duration !== undefined && duration >= 0 && (
          <span class="rl-faint" title="Duration of the captured request">
            {safely(() => formatDuration(duration), `${duration} ms`)}
          </span>
        )}
        <span class="rl-pill rl-detail__kind">{entry.kind}</span>
        {entry.fromCache && <span class="rl-pill">cache</span>}
        {entry.restored && (
          <span class="rl-pill" title="Restored from the preserved log of a previous page load">
            restored
          </span>
        )}
      </span>
      {modifiedCount > 0 && (
        <>
          <span class="rl-detail__modified" data-testid="rl-modified-count">
            <span class="rl-modified-dot" />
            {modifiedCount} modified
          </span>
          <button
            type="button"
            class="rl-btn rl-btn--sm"
            data-testid="rl-revert-all"
            title="Discard every edit and restore the captured request"
            onClick={onRevertAll}
          >
            <Icon name="revert" size={12} />
            Revert all
          </button>
        </>
      )}
    </div>
    {open ? (
      <div class="rl-detail__full-url rl-mono" data-testid="rl-detail-full-url">
        {entry.url}
      </div>
    ) : null}
    </>
  );
});

function StatusPill({ entry }: { entry: RequestEntry }) {
  if (entry.kind === 'manual' && entry.status === undefined) {
    return <span class="rl-pill rl-detail__new">New request</span>;
  }
  switch (entry.state) {
    case 'pending':
      return (
        <span class="rl-status rl-status--pending">
          <span class="rl-spinner" aria-hidden="true" />
          Pending
        </span>
      );
    case 'error':
      return (
        <span class="rl-status rl-status--error" title={entry.error}>
          Failed
        </span>
      );
    case 'aborted':
      return <span class="rl-status rl-status--error">Aborted</span>;
    default:
      break;
  }
  if (!entry.status) return <span class="rl-status rl-status--unknown">—</span>;
  const cls = safely(() => statusClass(entry.status, entry.state), 'unknown');
  return (
    <span class={`rl-status rl-status--${cls}`} title={entry.statusText || undefined}>
      {entry.status}
      {entry.statusText ? ` ${entry.statusText}` : ''}
    </span>
  );
}

// --------------------------------------------------------------------------------------------- results

interface ResultsAreaProps {
  bridge: ReqlensBridge;
  entry: RequestEntry;
  runs: TestRun[];
  activeRunId: string | null;
  /** Called with whether a tab with content before any run (all but "Test result") is visible (must be stable). */
  onContentTabShown(shown: boolean): void;
}

type ResultsTab = 'test' | 'original' | 'export' | 'initiator';

function resultsTabOf(id: string): ResultsTab {
  return id === 'original' || id === 'export' || id === 'initiator' ? id : 'test';
}

/**
 * Results pane: "Original response" (the captured response of the entry; always the tab an entry opens on) |
 * "Export" (types and agent prompt, see src/ui/export) | "Initiator" (the call stack and UI component that made the
 * request, InitiatorPanel) | "Test result" (ResultsPanel: the active run, Compare, Request sent, history). Starting
 * or selecting a run brings the Test result tab to the front, except from the Export tab (sending from there refines
 * the generated types in place). The row menu's "Show initiator / component" opens the Initiator tab (resultsTab.ts).
 */
const ResultsArea = memo(function ResultsArea({ bridge, entry, runs, activeRunId, onContentTabShown }: ResultsAreaProps) {
  const settings = useSettings();
  useExportSettingsBinding(bridge);
  const [tab, setTabState] = useState<ResultsTab>(() => takeRequestedTab(entry.id) ?? 'original');
  const setTab = useCallback(
    (next: ResultsTab) => {
      setTabState(next);
      onContentTabShown(next !== 'test');
    },
    [onContentTabShown],
  );
  useEffect(() => {
    onContentTabShown(tab !== 'test');
    // Mount only: the opening tab (Original response, or the one the row menu requested).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const entryId = entry.id;
  useEffect(
    () =>
      onResultsTabRequest(() => {
        const requested = takeRequestedTab(entryId);
        if (requested) setTab(requested);
      }),
    [entryId, setTab],
  );
  const lastActive = useRef(activeRunId);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    if (activeRunId !== lastActive.current) {
      lastActive.current = activeRunId;
      if (activeRunId && tabRef.current !== 'export') setTab('test');
    }
  }, [activeRunId, setTab]);
  const onSelectRun = useCallback((runId: string) => selectRun(entryId, runId), [entryId]);
  const onCancelRun = useCallback((runId: string) => cancelRun(entryId, runId), [entryId]);
  const onClearRuns = useCallback(() => clearRuns(entryId), [entryId]);
  const onResend = useCallback((run: TestRun) => void resendRun(bridge, entryId, run), [bridge, entryId]);
  const original = useMemo(
    () => entryToResponseDataWith(entry, { captureResponseBodies: settings.captureResponseBodies }),
    [entry, settings.captureResponseBodies],
  );
  return (
    <div class="rl-detail__results">
      <Tabs
        size="sm"
        class="rl-detail__results-tabs"
        active={tab}
        onChange={(id) => setTab(resultsTabOf(id))}
        tabs={[
          { id: 'original', label: 'Original response', testId: 'rl-original-tab' },
          { id: 'export', label: 'Export', testId: 'rl-export-tab' },
          { id: 'initiator', label: 'Initiator', testId: 'rl-initiator-tab' },
          { id: 'test', label: 'Test result', badge: runs.length || undefined, testId: 'rl-test-tab' },
        ]}
      />
      <div class="rl-detail__results-body" role="tabpanel">
        {tab === 'export' ? (
          <ExportPanel entry={entry} />
        ) : tab === 'initiator' ? (
          <InitiatorPanel entry={entry} />
        ) : tab === 'test' ? (
          <ResultsPanel
            entry={entry}
            runs={runs}
            activeRunId={activeRunId}
            onSelectRun={onSelectRun}
            onCancelRun={onCancelRun}
            onClearRuns={onClearRuns}
            onResend={onResend}
          />
        ) : (
          <div class="rl-results" data-testid="rl-original-response">
            <div class="rl-results__content">
              <ResponseView testId="rl-original-view" response={original} findInPage revealKey={originalRevealKey(entry.id)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// --------------------------------------------------------------------------------------------- errors

function DraftError({ entry, error }: { entry: RequestEntry; error: string | null }) {
  return (
    <div class="rl-empty rl-ed-crash" role="alert">
      <Icon name="warning" size={20} />
      <div>This request could not be opened for editing.</div>
      {error && <div class="rl-faint rl-mono">{error}</div>}
      <button type="button" class="rl-btn rl-btn--sm" onClick={() => resetDraft(entry)}>
        <Icon name="reload" size={12} />
        Try again
      </button>
    </div>
  );
}

interface PaneBoundaryProps {
  /** What crashed, for the message ("editor", "results"). */
  what: string;
  /** Offered as "Discard edits" when given (editor pane). */
  onDiscard?(): void;
  children: ComponentChildren;
}

/** Keeps a rendering bug in one pane from taking the whole overlay down. */
class PaneBoundary extends Component<PaneBoundaryProps, { error: string | null }> {
  override state = { error: null as string | null };

  static override getDerivedStateFromError(err: unknown): { error: string } {
    return { error: errorMessage(err) };
  }

  override componentDidCatch(err: unknown): void {
    console.error(`[reqlens] the ${this.props.what} crashed`, err);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const { onDiscard } = this.props;
    return (
      <div class="rl-empty rl-ed-crash" role="alert">
        <Icon name="warning" size={20} />
        <div>The {this.props.what} hit an unexpected error.</div>
        <div class="rl-faint rl-mono rl-ed-crash__detail">{this.state.error}</div>
        <div class="rl-row">
          <button type="button" class="rl-btn rl-btn--sm" onClick={() => this.setState({ error: null })}>
            <Icon name="reload" size={12} />
            Try again
          </button>
          {onDiscard && (
            <button
              type="button"
              class="rl-btn rl-btn--sm rl-btn--danger"
              onClick={() => {
                onDiscard();
                this.setState({ error: null });
              }}
            >
              Discard edits
            </button>
          )}
        </div>
      </div>
    );
  }
}
