// OWNER: ui-response agent. Compare view: status/header/timing summary + line diff of two response bodies.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { ResponseData } from '../../shared/types';
import { lineDiff, withContext } from '../../lib/diff';
import type { DiffResult } from '../../lib/diff';
import { formatBytes, formatDuration } from '../../lib/format';
import { Icon } from '../components/Icon';
import { displayStatusText } from './adapters';
import { plural, responseSize } from './body-model';
import { compareHeaders, expandContext, responseCompareText, significantHeaderChanges } from './compare';
import type { CompareText, DiffRow, HeaderChange, HeaderComparison } from './compare';
import { DIFF_PAGE_ROWS, Notice, ShowMore, StatusPill, usePageLimit } from './parts';

export interface DiffViewProps {
  /** Baseline (left side): the original response or a previous run. */
  before: ResponseData;
  /** Current response (right side). */
  after: ResponseData;
  beforeLabel: string;
  afterLabel: string;
  /** Extra controls in the header (e.g. the "Compare with" switch). */
  toolbar?: ComponentChildren;
}

/** Unchanged lines kept around each change when collapsing. */
const CONTEXT_LINES = 3;

/** Diff of `after` against `before`: what changed in status, headers, timing, size and body. */
export function DiffView({ before, after, beforeLabel, afterLabel, toolbar }: DiffViewProps) {
  const waiting = after.state === 'running' || after.state === 'pending';
  return (
    <div class="rl-resp-diff" data-testid="rl-compare">
      <div class="rl-resp-diff__header">
        <span class="rl-resp-diff__sides">
          <span class="rl-resp-diff__side rl-resp-diff__side--before" title={beforeLabel}>
            {beforeLabel}
          </span>
          <span class="rl-faint" aria-hidden="true">
            →
          </span>
          <span class="rl-resp-diff__side rl-resp-diff__side--after" title={afterLabel}>
            {afterLabel}
          </span>
        </span>
        <span class="rl-spacer" />
        {toolbar}
      </div>
      {waiting ? (
        <div class="rl-empty">
          <span class="rl-spinner" aria-hidden="true" />
          <span>Waiting for the response…</span>
        </div>
      ) : (
        <>
          <MetaSummary before={before} after={after} />
          <BodyDiff before={before} after={after} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Status / timing / size / headers summary
// ---------------------------------------------------------------------------------------------

function Change({ same, children }: { same: boolean; children: ComponentChildren }) {
  return (
    <span class={`rl-resp-diff__change${same ? ' rl-resp-diff__change--same' : ''}`}>
      {children}
      {same && <span class="rl-faint"> (same)</span>}
    </span>
  );
}

function MetaSummary({ before, after }: { before: ResponseData; after: ResponseData }) {
  const headers = useMemo(() => compareHeaders(before.headers, after.headers), [before.headers, after.headers]);
  const [open, setOpen] = useState(false);
  const statusSame = before.status === after.status && before.state === after.state;
  const sizeA = responseSize(before);
  const sizeB = responseSize(after);
  const total = headers.added.length + headers.removed.length + headers.changed.length;
  const volatile = total - significantHeaderChanges(headers);
  return (
    <div class="rl-resp-diff__summary">
      <dl class="rl-resp-diff__facts">
        <dt>Status</dt>
        <dd>
          <Change same={statusSame}>
            <StatusPill resp={before} title={displayStatusText(before)} />
            {!statusSame && (
              <>
                <span class="rl-faint"> → </span>
                <StatusPill resp={after} title={displayStatusText(after)} />
              </>
            )}
          </Change>
        </dd>
        <dt>Time</dt>
        <dd>
          {formatDuration(before.durationMs)} <span class="rl-faint">→</span> {formatDuration(after.durationMs)}
        </dd>
        <dt>Size</dt>
        <dd>
          <Change same={sizeA === sizeB}>
            {formatBytes(sizeA)}
            {sizeA !== sizeB && (
              <>
                {' '}
                <span class="rl-faint">→</span> {formatBytes(sizeB)}
              </>
            )}
          </Change>
        </dd>
        <dt>Headers</dt>
        <dd>
          {total === 0 ? (
            <span class="rl-muted">No differences ({plural(headers.same, 'header')})</span>
          ) : (
            <button type="button" class="rl-resp-diff__hdr-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
              {headers.added.length > 0 && <span class="rl-resp-diff__add-count">+{headers.added.length}</span>}
              {headers.removed.length > 0 && <span class="rl-resp-diff__del-count">−{headers.removed.length}</span>}
              {headers.changed.length > 0 && <span class="rl-resp-diff__mod-count">~{headers.changed.length}</span>}
              {volatile > 0 && <span class="rl-faint">({volatile} expected to vary)</span>}
            </button>
          )}
        </dd>
      </dl>
      {open && total > 0 && <HeaderChanges cmp={headers} />}
    </div>
  );
}

function HeaderChanges({ cmp }: { cmp: HeaderComparison }) {
  const rows: Array<{ sign: '+' | '−' | '~'; change: HeaderChange }> = [
    ...cmp.added.map((change) => ({ sign: '+' as const, change })),
    ...cmp.removed.map((change) => ({ sign: '−' as const, change })),
    ...cmp.changed.map((change) => ({ sign: '~' as const, change })),
  ];
  return (
    <table class="rl-table rl-resp-diff__hdr-table">
      <thead>
        <tr>
          <th />
          <th>Header</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ sign, change }) => (
          <tr key={`${sign}${change.name}`} class={change.volatile ? 'rl-resp-diff__hdr--volatile' : undefined}>
            <td class={`rl-resp-diff__sign rl-resp-diff__sign--${sign === '+' ? 'add' : sign === '−' ? 'del' : 'mod'}`}>{sign}</td>
            <td class="rl-mono">{change.name}</td>
            <td class="rl-mono rl-resp-diff__hdr-val">{change.before ?? <span class="rl-faint">—</span>}</td>
            <td class="rl-mono rl-resp-diff__hdr-val">{change.after ?? <span class="rl-faint">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// Body diff
// ---------------------------------------------------------------------------------------------

function sideNote(side: CompareText, label: string): string | null {
  if (side.kind === 'none') return `${label} has no captured body — compared as empty.`;
  return null;
}

function BodyDiff({ before, after }: { before: ResponseData; after: ResponseData }) {
  const left = useMemo(() => responseCompareText(before), [before]);
  const right = useMemo(() => responseCompareText(after), [after]);
  const diff: DiffResult = useMemo(() => lineDiff(left.text, right.text), [left.text, right.text]);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<{ diff: DiffResult; ids: Set<number> }>({ diff, ids: new Set() });
  const expandedIds = expanded.diff === diff ? expanded.ids : null;

  const collapsed = useMemo(() => (showAll ? null : withContext(diff.lines, CONTEXT_LINES)), [diff, showAll]);
  const rows: DiffRow[] = useMemo(
    () => (collapsed ? expandContext(diff.lines, collapsed, expandedIds ?? new Set()) : diff.lines),
    [diff, collapsed, expandedIds],
  );
  const [limit, setLimit] = usePageLimit(diff, DIFF_PAGE_ROWS);

  const identical = diff.added === 0 && diff.removed === 0;
  const bothEmpty = left.kind !== 'binary' && right.kind !== 'binary' && left.text === '' && right.text === '';
  const notes = [sideNote(left, 'The baseline'), sideNote(right, 'This response')].filter((n): n is string => n !== null);

  const expandSkip = (id: number) =>
    setExpanded((prev) => ({ diff, ids: new Set(prev.diff === diff ? prev.ids : []).add(id) }));

  return (
    <div class="rl-resp-diff__body" data-added={diff.added} data-removed={diff.removed} data-identical={identical}>
      <div class="rl-resp-diff__body-header">
        <span class="rl-resp-diff__title">Body</span>
        {!identical && (
          <span class="rl-resp-diff__counts" data-testid="rl-compare-counts">
            <span class="rl-resp-diff__add-count">+{diff.added.toLocaleString('en-US')}</span>
            <span class="rl-resp-diff__del-count">−{diff.removed.toLocaleString('en-US')}</span>
          </span>
        )}
        {(left.kind === 'json' || right.kind === 'json') && <span class="rl-faint">compared as pretty-printed JSON</span>}
        <span class="rl-spacer" />
        {!identical && (
          <button type="button" class="rl-chip" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
            Show unchanged lines
          </button>
        )}
      </div>
      {notes.map((note) => (
        <Notice key={note} tone="info">
          {note}
        </Notice>
      ))}
      {(left.truncated || right.truncated) && (
        <Notice tone="warn">A body was truncated at capture — differences near the end may be artifacts.</Notice>
      )}
      {diff.truncated && <Notice tone="warn">The bodies are too large for a precise line diff — showing a coarse comparison.</Notice>}
      {identical ? (
        <div class="rl-resp-diff__identical" data-testid="rl-compare-identical">
          <Icon name="check" size={14} />
          <span>{bothEmpty ? 'Both bodies are empty.' : 'Bodies are identical.'}</span>
        </div>
      ) : (
        <>
          <div class="rl-resp-diff__lines rl-mono" role="table" aria-label="Body differences">
            {rows.slice(0, limit).map((row, i) =>
              row.op === 'skip' ? (
                <button key={`s${row.id}`} type="button" class="rl-resp-diff__skip" onClick={() => expandSkip(row.id)}>
                  ⋯ {plural(row.count, 'unchanged line')}
                </button>
              ) : (
                <div key={i} class={`rl-resp-diff__line rl-resp-diff__line--${row.op}`} role="row">
                  <span class="rl-resp-diff__num" role="cell">
                    {row.a ?? ''}
                  </span>
                  <span class="rl-resp-diff__num" role="cell">
                    {row.b ?? ''}
                  </span>
                  <span class="rl-resp-diff__mark" role="cell" aria-label={row.op === 'add' ? 'added' : row.op === 'del' ? 'removed' : undefined}>
                    {row.op === 'add' ? '+' : row.op === 'del' ? '−' : ' '}
                  </span>
                  <span class="rl-resp-diff__text" role="cell">
                    {row.text}
                  </span>
                </div>
              ),
            )}
          </div>
          {rows.length > limit && (
            <ShowMore
              status={`Showing ${limit.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} lines`}
              onMore={() => setLimit(limit + DIFF_PAGE_ROWS)}
              onAll={() => setLimit(rows.length)}
            />
          )}
        </>
      )}
    </div>
  );
}
