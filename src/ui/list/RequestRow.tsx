// OWNER: ui-shell agent. One row of the request list (and the "previous page" separator row).
import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { formatBytes, formatClock, formatDuration, methodClass, statusClass, urlParts } from '../../lib/format';
import type { RequestEntry, UrlDisplay } from '../../shared/types';
import { Icon } from '../components/Icon';
import { useEntryMeta } from '../detail/draftStore';
import { EndpointLabel } from './EndpointChips';
import { concreteTemplate, endpointTemplate, layoutLabel, templateText } from './endpointLabel';
import type { EndpointGroup } from './endpointLabel';
import { kindLabel } from './filter';
import type { HiddenReason } from './filter';
import { durationMs, groupTooltip, queryPreview, responseSize, rowTooltip, statusCell } from './rowModel';

/** Compact method label for the narrow badge column (full method stays in data-method and the tooltip). */
const METHOD_ABBR: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT' };

export interface RequestRowProps {
  entry: RequestEntry;
  selected: boolean;
  /** DOM id (for aria-activedescendant). */
  domId: string;
  /** 1-based position and total, for assistive tech when the list is virtualized. */
  ordinal: number;
  setSize: number;
  style?: JSX.CSSProperties;
  onPick(id: string, activate: boolean): void;
  /** Set while the (selected) entry is only listed because it is selected: rules or "Remove from list" hide it. */
  hidden?: HiddenReason;
  /** The context menu is open for this row. */
  menuOpen?: boolean;
  /** The row's "⋯" button was clicked (opens / closes the context menu below it). */
  onMenuButton?(id: string, button: HTMLElement): void;
  /** Characters available to the label (name + marks cells); 0 = not measured yet. */
  budget?: number;
  /** Show the host inline (narrow lists; it differs from the row above). */
  showHost?: boolean;
  urlDisplay?: UrlDisplay;
  /** Listed as a call of an expanded group (indented). */
  inGroup?: boolean;
}

/** Label room before the list was measured: generous, the cell truncates the rest. */
const UNMEASURED_BUDGET = 96;

const HIDDEN_NOTE: Record<HiddenReason, string> = {
  rule: 'Hidden by a list rule — shown while selected',
  removed: 'Removed from the list — shown while selected',
};

/** The name cell: endpoint template with chips (default) or the full path + raw query ("Full path" setting). */
function NameLabel(props: { entry: RequestEntry; budget: number; showHost: boolean; urlDisplay: UrlDisplay; concrete: boolean }) {
  const { entry, budget, showHost, urlDisplay } = props;
  // A call under its group shows its concrete ids (the group row shows the kinds).
  const template = props.concrete ? concreteTemplate(endpointTemplate(entry.url)) : endpointTemplate(entry.url);
  const layout = useMemo(() => layoutLabel(template, budget, showHost), [template, budget, showHost]);
  const parts = useMemo(() => (urlDisplay === 'full' ? urlParts(entry.url) : null), [urlDisplay, entry.url]);
  if (parts) {
    return (
      <>
        <span class="rl-req-row__path">{template.http ? parts.path : parts.name || entry.url}</span>
        {parts.query ? <span class="rl-req-row__query">{queryPreview(parts.query, 400)}</span> : null}
        {showHost && parts.host ? <span class="rl-req-row__host-inline">{parts.host}</span> : null}
      </>
    );
  }
  return <EndpointLabel template={template} layout={layout} host={showHost} class="rl-req-row__ep" />;
}

function StatusView({ entry }: { entry: RequestEntry }) {
  const cell = statusCell(entry);
  switch (cell.kind) {
    case 'pending':
      return <span class="rl-spinner" role="img" aria-label="Pending" />;
    case 'error':
      return (
        <span class="rl-status rl-status--error" title={cell.message}>
          <Icon name="warning" size={13} title="Failed" />
        </span>
      );
    case 'aborted':
      return (
        <span class="rl-status rl-status--unknown" title="Canceled">
          <Icon name="close" size={12} title="Canceled" />
        </span>
      );
    case 'code':
      return (
        <span
          class={`rl-status rl-status--${statusClass(cell.status, entry.state)}`}
          title={cell.statusText ? `${cell.status} ${cell.statusText}` : String(cell.status)}
        >
          {cell.status}
        </span>
      );
    default:
      return <span class="rl-status rl-status--unknown">—</span>;
  }
}

/** A request row: method, status, name + query preview, markers, host, type, time, size. */
export function RequestRow(props: RequestRowProps) {
  const { entry, selected, domId, ordinal, setSize, style, onPick, hidden, menuOpen, onMenuButton } = props;
  const meta = useEntryMeta(entry.id);
  const host = endpointTemplate(entry.url).host;
  const ms = durationMs(entry);
  const size = responseSize(entry);
  const method = entry.method || 'GET';
  const runsLabel = `${meta.runs} test run${meta.runs === 1 ? '' : 's'}`;

  const classes = ['rl-req-row'];
  if (selected) classes.push('rl-req-row--selected');
  if (entry.restored) classes.push('rl-req-row--restored');
  if (entry.state === 'error') classes.push('rl-req-row--error');
  if (entry.kind === 'manual') classes.push('rl-req-row--manual');
  if (hidden) classes.push('rl-req-row--hidden');
  if (menuOpen) classes.push('rl-req-row--menu-open');
  if (props.inGroup) classes.push('rl-req-row--call');
  // Marks take room from the label: the edited dot (~2 characters), the runs pill (~4 + digits).
  const marks = (meta.modified ? 2 : 0) + (meta.runs > 0 ? 4 + String(meta.runs).length : 0);
  const budget = Math.max(8, (props.budget || UNMEASURED_BUDGET) - marks - (props.inGroup ? 2 : 0));
  const tooltip = hidden ? `${rowTooltip(entry)}\n${HIDDEN_NOTE[hidden]}` : rowTooltip(entry);

  return (
    <div
      id={domId}
      role="option"
      aria-selected={selected ? 'true' : 'false'}
      aria-posinset={ordinal}
      aria-setsize={setSize}
      class={classes.join(' ')}
      style={style}
      title={tooltip}
      data-testid="rl-request-row"
      data-entry-id={entry.id}
      data-method={method}
      data-kind={entry.kind}
      data-url={entry.url}
      data-template={endpointTemplate(entry.url).key}
      data-group={props.inGroup ? 'call' : undefined}
      data-hidden={hidden}
      onClick={() => onPick(entry.id, true)}
    >
      <span class="rl-req-row__method">
        <span class={`rl-badge rl-badge--${methodClass(method)}`}>{METHOD_ABBR[method] ?? method}</span>
      </span>
      <span class="rl-req-row__status">
        <StatusView entry={entry} />
      </span>
      <span class="rl-req-row__name">
        <NameLabel
          entry={entry}
          budget={budget}
          showHost={props.showHost === true}
          urlDisplay={props.urlDisplay ?? 'template'}
          concrete={props.inGroup === true}
        />
        {entry.restored ? <span class="rl-sr-only"> (previous page)</span> : null}
        {hidden ? <span class="rl-sr-only"> ({HIDDEN_NOTE[hidden]})</span> : null}
      </span>
      <span class="rl-req-row__marks">
        {meta.modified ? <span class="rl-modified-dot" role="img" aria-label="Edited draft" title="Edited draft" /> : null}
        {meta.runs > 0 ? (
          <span class="rl-req-row__runs" title={runsLabel} aria-label={runsLabel}>
            <Icon name="send" size={10} />
            {meta.runs}
          </span>
        ) : null}
      </span>
      <span class="rl-req-row__host">{host}</span>
      <span class="rl-req-row__type">{kindLabel(entry.kind)}</span>
      <span class="rl-req-row__time">{entry.state === 'pending' ? '' : ms === null ? '—' : formatDuration(ms)}</span>
      <span class="rl-req-row__size">{size !== null ? formatBytes(size) : entry.fromCache ? 'cache' : '—'}</span>
      {onMenuButton ? (
        // Mouse affordance only: keyboard users open the same menu with Shift+F10 / the ContextMenu key, and a
        // button inside an option would be flattened by assistive tech anyway.
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm rl-req-row__menu"
          tabIndex={-1}
          aria-hidden="true"
          title="Actions (right-click, Shift+F10)"
          data-testid="rl-row-menu"
          data-open={menuOpen ? 'true' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onMenuButton(entry.id, e.currentTarget);
          }}
        >
          <Icon name="more" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** Separator above the restored entries of a previous page load (preserve log). */
export function PreviousPageSeparator({ pageUrl, style }: { pageUrl: string; style?: JSX.CSSProperties }) {
  const parts = useMemo(() => (pageUrl ? urlParts(pageUrl) : null), [pageUrl]);
  const where = parts ? `${parts.host}${parts.path}` : '';
  return (
    <div class="rl-req-sep" role="presentation" aria-hidden="true" style={style} title={pageUrl || undefined}>
      <Icon name="history" size={12} />
      <span class="rl-req-sep__label">Previous page</span>
      {where ? <span class="rl-req-sep__url">{where}</span> : null}
    </div>
  );
}

export interface GroupRowProps {
  group: EndpointGroup;
  /** Row key (also data-group-key). */
  groupKey: string;
  expanded: boolean;
  selected: boolean;
  domId: string;
  ordinal: number;
  setSize: number;
  style?: JSX.CSSProperties;
  budget?: number;
  showHost?: boolean;
  menuOpen?: boolean;
  onPick(groupKey: string, activate: boolean): void;
  onToggle(groupKey: string): void;
  onMenuButton?(groupKey: string, button: HTMLElement): void;
}

const OUTCOME_LABEL: Record<string, string> = { error: 'failed', aborted: 'canceled', unknown: 'no status' };

/** Last status of a group: the newest call's status, with a dot when the calls ended differently. */
function GroupStatus({ group }: { group: EndpointGroup }) {
  const { stats } = group;
  const mixedTitle = stats.outcomes.map((o) => `${OUTCOME_LABEL[o.outcome] ?? o.outcome} ×${o.count}`).join(' · ');
  return (
    <>
      <StatusView entry={group.newest} />
      {stats.mixed ? (
        <span
          class="rl-req-row__mixed"
          role="img"
          aria-label={`Mixed statuses: ${mixedTitle}`}
          title={`Mixed statuses: ${mixedTitle}`}
          data-testid="rl-group-mixed"
        />
      ) : null}
    </>
  );
}

/** "Group by endpoint" row: chevron, template label, call count, last status, avg duration, newest time. */
export function GroupRow(props: GroupRowProps) {
  const { group, groupKey, expanded, selected, domId, ordinal, setSize, style, onPick, onToggle, onMenuButton, menuOpen } = props;
  const { stats, template } = group;
  const method = group.method;
  const countText = `×${stats.count}`;
  const budget = Math.max(8, (props.budget || UNMEASURED_BUDGET) - 2 - (countText.length + 2));
  const layout = useMemo(() => layoutLabel(template, budget, props.showHost === true), [template, budget, props.showHost]);
  const classes = ['rl-req-row', 'rl-req-row--group'];
  if (selected) classes.push('rl-req-row--selected');
  if (expanded) classes.push('rl-req-row--expanded');
  if (menuOpen) classes.push('rl-req-row--menu-open');
  if (group.newest.state === 'error') classes.push('rl-req-row--error');
  const calls = `${stats.count} call${stats.count === 1 ? '' : 's'}`;
  return (
    <div
      id={domId}
      role="option"
      aria-selected={selected ? 'true' : 'false'}
      aria-posinset={ordinal}
      aria-setsize={setSize}
      class={classes.join(' ')}
      style={style}
      title={groupTooltip(group)}
      data-testid="rl-group-row"
      data-group-key={groupKey}
      data-method={method}
      data-template={template.key}
      data-count={String(stats.count)}
      data-expanded={expanded ? 'true' : 'false'}
      data-mixed={stats.mixed ? 'true' : undefined}
      onClick={() => onPick(groupKey, true)}
      onDblClick={() => onToggle(groupKey)}
    >
      <span class="rl-req-row__method">
        <span class={`rl-badge rl-badge--${methodClass(method)}`}>{METHOD_ABBR[method] ?? method}</span>
      </span>
      <span class="rl-req-row__status">
        <GroupStatus group={group} />
      </span>
      <span class="rl-req-row__name">
        <span
          class="rl-req-row__twisty"
          aria-hidden="true"
          title={expanded ? 'Collapse (←)' : 'Expand (→)'}
          data-testid="rl-group-expand"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(groupKey);
          }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
        <EndpointLabel template={template} layout={layout} host={props.showHost === true} class="rl-req-row__ep" />
        <span class="rl-sr-only">
          {' '}
          ({calls}, {expanded ? 'expanded' : 'collapsed'})
        </span>
      </span>
      <span class="rl-req-row__marks">
        <span class="rl-req-row__count" data-testid="rl-group-count" title={calls}>
          {countText}
        </span>
      </span>
      <span class="rl-req-row__host">{template.host}</span>
      <span class="rl-req-row__type">{kindLabel(group.newest.kind)}</span>
      <span
        class="rl-req-row__time"
        title={`avg ${formatDuration(stats.avgMs)} · last ${formatDuration(stats.lastMs)}${stats.pending ? ` · ${stats.pending} pending` : ''}`}
      >
        {stats.avgMs === null ? (stats.pending ? '' : '—') : formatDuration(stats.avgMs)}
      </span>
      <span class="rl-req-row__size rl-req-row__newest" title={`Newest call at ${formatClock(stats.newestTime)}`}>
        {formatClock(stats.newestTime).slice(0, 8)}
      </span>
      {onMenuButton ? (
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm rl-req-row__menu"
          tabIndex={-1}
          aria-hidden="true"
          title="Actions (right-click, Shift+F10)"
          data-testid="rl-row-menu"
          data-open={menuOpen ? 'true' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onMenuButton(groupKey, e.currentTarget);
          }}
        >
          <Icon name="more" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** Plain text of a group's label (toasts, menus). */
export function groupTitle(group: EndpointGroup): string {
  return `${group.method} ${templateText(group.template)}`;
}
