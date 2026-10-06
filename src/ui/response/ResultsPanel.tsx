// OWNER: ui-response agent. The "test visualizer": active run's response, run history, compare with original.
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReqlensBridge, RequestEntry, TestRun } from '../../shared/types';
import { formatClock, formatDuration, methodClass, urlParts } from '../../lib/format';
import { Icon } from '../components/Icon';
import { BridgeContext, useElementSize } from '../hooks';
import { entryToResponseDataWith, runToResponseData, statusLabel } from './adapters';
import { Segmented, StatusPill } from './parts';
import { RequestSent, RunNotices } from './RequestSent';
import { ResponseView } from './ResponseView';
import type { ResponseExtraTab } from './ResponseView';
import { chooseCompare, modeLabel, pickActiveRun } from './results-model';
import type { CompareChoice, CompareTarget } from './results-model';

export interface ResultsPanelProps {
  entry: RequestEntry;
  /** Newest first. */
  runs: TestRun[];
  activeRunId: string | null;
  onSelectRun(runId: string): void;
  onCancelRun(runId: string): void;
  onClearRuns(): void;
  /** Re-send the same request as the active run (optional). */
  onResend?(run: TestRun): void;
}

/** Interval of the elapsed-time readout while a run is in flight. */
const ELAPSED_TICK_MS = 100;
/** Below this pane height the run history starts collapsed (the response needs the room). */
const HISTORY_OPEN_MIN_HEIGHT = 420;

/** settings.captureResponseBodies when a bridge is available (never throws). */
function readCaptureSetting(bridge: ReqlensBridge | null): boolean | undefined {
  try {
    return bridge?.getSettings().captureResponseBodies;
  } catch {
    return undefined;
  }
}

/** Milliseconds since `startedAt`, ticking while `running`. */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return Math.max(0, now - startedAt);
}

/**
 * Results of the test runs of one entry (the detail pane's "Test result" tab): the active run's response
 * (Body / Headers / Compare against the original response or the previous run / Request sent), a live
 * elapsed timer + Cancel while it runs, and the run history (newest first). Shows an empty state until the
 * first Send. The captured response itself is the detail pane's "Original response" tab.
 */
export function ResultsPanel({ entry, runs, activeRunId, onSelectRun, onCancelRun, onClearRuns, onResend }: ResultsPanelProps) {
  const bridge = useContext(BridgeContext);
  const captureResponseBodies = readCaptureSetting(bridge);
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('original');
  const rootRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rootRef);
  // null = automatic (open when the pane is tall enough); a click on the History header pins the choice.
  const [historyPref, setHistoryPref] = useState<boolean | null>(null);
  const historyOpen = historyPref ?? (height === 0 || height >= HISTORY_OPEN_MIN_HEIGHT);

  const active = pickActiveRun(runs, activeRunId);
  const activeId = active?.runId ?? null;

  const original = useMemo(() => entryToResponseDataWith(entry, { captureResponseBodies }), [entry, captureResponseBodies]);
  const activeData = useMemo(() => (active ? runToResponseData(active) : null), [active]);
  const compare = useMemo(() => chooseCompare(compareTarget, original, runs, active), [compareTarget, original, runs, active]);
  const extraTabs = useMemo<ResponseExtraTab[]>(
    () => (active ? [{ id: 'request', label: 'Request sent', render: () => <RequestSent run={active} /> }] : []),
    [active],
  );

  return (
    <div
      class="rl-results"
      data-testid="rl-results"
      data-active-run={activeId ?? ''}
      data-run-state={active?.state ?? ''}
      ref={rootRef}
    >
      <div class="rl-results__content">
        {active && activeData ? (
          <ResponseView
            testId="rl-result-view"
            response={activeData}
            compareWith={compare.baseline}
            compareLabel={compare.label}
            selfLabel={`This run (${formatClock(active.startedAt)})`}
            compareToolbar={<CompareSwitch compare={compare} onChange={setCompareTarget} />}
            summaryExtra={<RunControls run={active} onCancel={onCancelRun} onResend={onResend} />}
            notices={<RunNotices run={active} />}
            extraTabs={extraTabs}
            findInPage
          />
        ) : (
          <EmptyResults />
        )}
      </div>
      {runs.length > 0 && (
        <RunHistory
          runs={runs}
          activeRunId={activeId}
          open={historyOpen}
          onToggle={() => setHistoryPref(!historyOpen)}
          onSelect={onSelectRun}
          onClear={onClearRuns}
        />
      )}
    </div>
  );
}

function EmptyResults() {
  return (
    <div class="rl-empty rl-results__empty" data-testid="rl-results-empty">
      <Icon name="send" size={22} class="rl-empty__icon" />
      <div class="rl-results__empty-title">
        Press <strong>Send</strong> (<kbd class="rl-kbd">Ctrl/Cmd+Enter</kbd>) to fire a test request…
      </div>
      <div class="rl-empty__text">
        Its status, timing, headers and body show up here, with a diff against the original response. The captured
        response stays available under Original response.
      </div>
    </div>
  );
}

/** "Compare with: Original | Previous run" switch (options are disabled when that baseline is missing). */
function CompareSwitch({ compare, onChange }: { compare: CompareChoice; onChange(target: CompareTarget): void }) {
  if (!compare.originalAvailable && !compare.previousAvailable) return null;
  return (
    <span class="rl-results__compare-with">
      <span class="rl-muted">Compare with</span>
      <Segmented<CompareTarget>
        label="Compare with"
        value={compare.target ?? 'original'}
        onChange={onChange}
        options={[
          {
            id: 'original',
            label: 'Original',
            disabled: !compare.originalAvailable,
            testId: 'rl-compare-original',
            title: compare.originalAvailable ? 'The captured response of this request' : 'The captured response has no body',
          },
          {
            id: 'previous',
            label: 'Previous run',
            disabled: !compare.previousAvailable,
            testId: 'rl-compare-previous',
            title: compare.previousAvailable ? 'The finished run before this one' : 'No earlier finished run',
          },
        ]}
      />
    </span>
  );
}

interface RunControlsProps {
  run: TestRun;
  onCancel(runId: string): void;
  onResend?(run: TestRun): void;
}

/** Summary-bar extras of the active run: mode, elapsed time + Cancel while running, Resend when done. */
function RunControls({ run, onCancel, onResend }: RunControlsProps) {
  const running = run.state === 'running';
  const elapsed = useElapsed(run.startedAt, running);
  const mode = modeLabel(run.request.mode);
  return (
    <span class="rl-results__controls">
      <span class="rl-pill rl-results__mode" data-testid="rl-result-mode" title={`Sent in ${mode} mode`}>
        {mode}
      </span>
      {running ? (
        <>
          <span class="rl-results__elapsed rl-mono" role="timer" aria-label="Elapsed time">
            {formatDuration(elapsed)}
          </span>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--danger" data-testid="rl-run-cancel" onClick={() => onCancel(run.runId)}>
            <Icon name="stop" size={12} />
            <span>Cancel</span>
          </button>
        </>
      ) : (
        onResend && (
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" title="Send this exact request again" onClick={() => onResend(run)}>
            <Icon name="reload" size={12} />
            <span>Resend</span>
          </button>
        )
      )}
    </span>
  );
}

interface RunHistoryProps {
  runs: TestRun[];
  activeRunId: string | null;
  open: boolean;
  onToggle(): void;
  onSelect(runId: string): void;
  onClear(): void;
}

/** Collapsible list of test runs, newest first. */
function RunHistory({ runs, activeRunId, open, onToggle, onSelect, onClear }: RunHistoryProps) {
  return (
    <section class={`rl-results__history${open ? ' rl-results__history--open' : ''}`} data-testid="rl-run-history" aria-label="Run history">
      <div class="rl-results__history-header">
        <button type="button" class="rl-results__history-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          <Icon name="history" size={12} />
          <span>History</span>
          <span class="rl-results__count">{runs.length}</span>
        </button>
        <span class="rl-spacer" />
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" data-testid="rl-run-clear" title="Clear test runs" onClick={onClear}>
          <Icon name="trash" size={12} />
          <span>Clear</span>
        </button>
      </div>
      {open && (
        <ol class="rl-results__runs rl-scroll">
          {runs.map((run) => (
            <RunItem key={run.runId} run={run} active={run.runId === activeRunId} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RunItem({ run, active, onSelect }: { run: TestRun; active: boolean; onSelect(runId: string): void }) {
  const data = useMemo(() => runToResponseData(run), [run]);
  const { name, host } = urlParts(run.request.url);
  const mode = modeLabel(run.request.mode);
  const byClaude = run.origin === 'claude';
  return (
    <li class="rl-results__run-li">
      <button
        type="button"
        class={`rl-results__run${active ? ' rl-results__run--active' : ''}`}
        data-testid="rl-run-item"
        data-run-id={run.runId}
        data-state={run.state}
        data-origin={byClaude ? 'claude' : 'user'}
        aria-current={active ? 'true' : undefined}
        title={`${run.request.method} ${run.request.url}\n${statusLabel(data)} · ${mode} mode${byClaude ? ' · sent by Claude Code' : ''}`}
        onClick={() => onSelect(run.runId)}
      >
        <span class="rl-results__run-time rl-mono">{formatClock(run.startedAt)}</span>
        <StatusPill resp={data} />
        <span class={`rl-badge rl-badge--${methodClass(run.request.method)} rl-results__run-method`}>{run.request.method}</span>
        <span class="rl-results__run-name rl-truncate">
          {byClaude && (
            <span class="rl-run-origin" data-testid="rl-run-origin-claude" title="Sent by Claude Code">
              Claude
            </span>
          )}
          <span class="rl-mono">{name}</span>
          <span class="rl-faint"> {host}</span>
        </span>
        <span class="rl-results__run-dur rl-mono">{run.state === 'running' ? '…' : formatDuration(data.durationMs)}</span>
        <span class="rl-results__run-mode rl-faint">{mode}</span>
      </button>
    </li>
  );
}
