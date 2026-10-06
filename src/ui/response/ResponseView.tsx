// OWNER: ui-response agent. Renders one response: summary bar + Body / Headers / (Compare) views.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { ResponseData } from '../../shared/types';
import { formatBytes, formatDuration } from '../../lib/format';
import { Icon } from '../components/Icon';
import { displayStatusText, isOpaque } from './adapters';
import { responseContentType, responseSize } from './body-model';
import { BodyView } from './BodyView';
import { DiffView } from './DiffView';
import { HeadersTable } from './HeadersView';
import { Tabs } from '../components/Tabs';
import type { TabItem } from '../components/Tabs';
import { Notice, StatusPill } from './parts';

/** An additional view appended after Body / Headers / Compare (e.g. the results panel's "Request sent"). */
export interface ResponseExtraTab {
  /** Unique tab id (also its `data-tab`); must not be 'body', 'headers' or 'compare'. */
  id: string;
  label: ComponentChildren;
  badge?: ComponentChildren;
  /** Renders the panel content (inside a scroll container) when the tab is active. */
  render(): ComponentChildren;
}

export interface ResponseViewProps {
  response: ResponseData | null;
  /** When given, a "Compare" tab diffs this response against `compareWith`. */
  compareWith?: ResponseData | null;
  compareLabel?: string;
  /** Shown when response is null. */
  emptyHint?: ComponentChildren;
  /** Extra summary-bar content (e.g. mode badge, Cancel button). */
  summaryExtra?: ComponentChildren;
  testId?: string;
  /** Extra notices rendered under the summary bar (e.g. headers applied via DNR / dropped). */
  notices?: ComponentChildren;
  /** Controls shown in the Compare view header (e.g. a "Compare with" switch). */
  compareToolbar?: ComponentChildren;
  /** Label of this response in the Compare view (default "This response"). */
  selfLabel?: string;
  /** Additional tabs after the built-in ones. */
  extraTabs?: ResponseExtraTab[];
  /** Find in page for the body's JSON tree (docs/ARCHITECTURE.md §13). */
  findInPage?: boolean;
  /** Reveal key of the body's JSON tree (src/ui/find/reveal.ts). */
  revealKey?: string;
}

/** Every tab strip button of the response views carries this test id (+ `data-tab`). */
const TAB_TEST_ID = 'rl-resp-tab';

/** The tab to show: the user's pick while it still exists, else Body. */
function resolveTab(picked: string, canCompare: boolean, extraTabs: ResponseExtraTab[] | undefined): string {
  if (picked === 'body' || picked === 'headers') return picked;
  if (picked === 'compare') return canCompare ? picked : 'body';
  return extraTabs?.some((t) => t.id === picked) ? picked : 'body';
}

/**
 * Response summary (status, timing, size, type, redirect, problems) with Body / Headers (count) /
 * Compare (only with `compareWith`) tabs plus any `extraTabs`.
 */
export function ResponseView({
  response,
  compareWith,
  compareLabel = 'Original response',
  emptyHint,
  summaryExtra,
  testId,
  notices,
  compareToolbar,
  selfLabel = 'This response',
  extraTabs,
  findInPage = false,
  revealKey,
}: ResponseViewProps) {
  const [tab, setTab] = useState('body');

  if (!response) {
    return (
      <div class="rl-resp rl-resp--empty" data-testid={testId}>
        <div class="rl-empty">{emptyHint ?? 'No response yet.'}</div>
      </div>
    );
  }

  const canCompare = !!compareWith;
  const active = resolveTab(tab, canCompare, extraTabs);
  const tabs: TabItem[] = [
    { id: 'body', label: 'Body', testId: TAB_TEST_ID },
    { id: 'headers', label: 'Headers', badge: response.headers.length, testId: TAB_TEST_ID },
  ];
  if (canCompare) tabs.push({ id: 'compare', label: 'Compare', testId: TAB_TEST_ID });
  for (const extra of extraTabs ?? []) tabs.push({ id: extra.id, label: extra.label, badge: extra.badge, testId: TAB_TEST_ID });
  const extraActive = extraTabs?.find((t) => t.id === active);

  return (
    <div class="rl-resp" data-testid={testId} data-state={response.state}>
      <SummaryBar response={response} extra={summaryExtra} />
      <ProblemNotice response={response} />
      <OpaqueNotice response={response} />
      {notices}
      <Tabs tabs={tabs} active={active} onChange={setTab} size="sm" class="rl-resp__tabs" />
      <div class="rl-resp__panel" role="tabpanel" data-tab={active}>
        {active === 'body' && <BodyView response={response} findInPage={findInPage} revealKey={revealKey} />}
        {active === 'headers' && (
          <div class="rl-resp__scroll rl-scroll">
            <HeadersTable
              headers={response.headers}
              emptyText={response.state === 'running' ? 'Waiting for the response…' : 'No response headers.'}
            />
          </div>
        )}
        {active === 'compare' && compareWith && (
          <div class="rl-resp__scroll rl-scroll">
            <DiffView before={compareWith} after={response} beforeLabel={compareLabel} afterLabel={selfLabel} toolbar={compareToolbar} />
          </div>
        )}
        {extraActive && <div class="rl-resp__scroll rl-scroll">{extraActive.render()}</div>}
      </div>
    </div>
  );
}

function OpaqueNotice({ response }: { response: ResponseData }) {
  if (!isOpaque(response)) return null;
  return (
    <Notice tone="info">
      {response.type !== 'opaqueredirect'
        ? 'Opaque response (no-cors) — the browser hides its status, headers and body from the page.'
        : response.status
          ? // Extension mode reads the redirect's status and headers from the network (webRequest).
            'Redirect not followed (redirect: "manual") — status and headers come from the network; the body of an opaque redirect is not readable.'
          : 'Redirect not followed (redirect: "manual") — the browser hides the status, headers and body of an opaque redirect.'}
    </Notice>
  );
}

function SummaryBar({ response, extra }: { response: ResponseData; extra?: ComponentChildren }) {
  const statusText = displayStatusText(response);
  const busy = response.state === 'running' || response.state === 'pending';
  const size = responseSize(response);
  const { mime } = responseContentType(response.headers);
  const redirectedTo = response.redirected && response.url ? response.url : null;
  return (
    <div class="rl-resp__summary">
      <StatusPill resp={response} testId="rl-result-status" title={statusText || undefined} />
      {statusText && <span class="rl-resp__status-text">{statusText}</span>}
      {!busy && (
        <span class="rl-resp__metric" title="Duration">
          <span class="rl-resp__metric-label">Time</span>
          <span data-testid="rl-result-time">{formatDuration(response.durationMs)}</span>
        </span>
      )}
      {!busy && (
        <span class="rl-resp__metric" title="Body size (decoded)">
          <span class="rl-resp__metric-label">Size</span>
          <span data-testid="rl-result-size">{formatBytes(size)}</span>
        </span>
      )}
      {mime && (
        <span class="rl-resp__ctype rl-mono rl-truncate" title={`Content-Type: ${mime}`}>
          {mime}
        </span>
      )}
      {redirectedTo && (
        <span class="rl-resp__redirect" title={`Redirected to ${redirectedTo}`}>
          <Icon name="external" size={12} />
          <span class="rl-resp__redirect-label">Redirected →</span>
          <span class="rl-mono rl-truncate">{redirectedTo}</span>
        </span>
      )}
      <span class="rl-spacer" />
      {extra}
    </div>
  );
}

function ProblemNotice({ response }: { response: ResponseData }) {
  if (response.state === 'aborted') {
    return (
      <Notice tone="warn" icon="stop" testId="rl-result-error" role="status">
        <div class="rl-resp__problem-title">Request cancelled</div>
        {response.error && <div class="rl-resp__problem-detail">{response.error}</div>}
        {response.errorHint && <div class="rl-resp__problem-hint">{response.errorHint}</div>}
      </Notice>
    );
  }
  if (response.state !== 'error' && !response.error) return null;
  return (
    <Notice tone="error" testId="rl-result-error" role="alert">
      <div class="rl-resp__problem-title">{response.error ?? 'Request failed'}</div>
      {response.errorHint && <div class="rl-resp__problem-hint">{response.errorHint}</div>}
    </Notice>
  );
}
